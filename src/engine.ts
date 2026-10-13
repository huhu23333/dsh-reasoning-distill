/**
 * The distillation engine: watch assistant messages, run a one-shot
 * "compression session" for oversized reasoning, and replay the distilled text
 * on every later request by wrapping the session's derived-history accessor.
 *
 * Why the derived-history seam rather than a durable projection event: a plugin
 * outside the repository cannot append its own session event type (the append
 * API never writes the envelope's `ignorable` marker, and the persistence read
 * path refuses an unknown non-ignorable type). Wrapping `deriveMessages()` moves
 * the model-visible list without touching the log, so the log stays readable by
 * every build and the raw reasoning stays auditable.
 * @module dsh-reasoning-distill/engine
 */

import { BlockAssembler, createAssistantMessage, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: these packages own the `agent/pre-step` and `subagent/descriptor`
// declarations that this plugin's event handlers are typed against.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'

import { backendById, rewriteRequest } from './backends.ts'
import { resolveRule, type Config, type ModelRule } from './config.ts'
import { priceAt } from './peak.ts'
import { DEFAULT_PROMPT } from './prompt.ts'
import type { SessionRecord, SidecarStore, StoredEntry } from './store.ts'
import type { ActiveCompression, BlockingReason, DistillRun } from './shared.ts'

/**
 * One request's view of the surface: which node seqs exist, and where each lands
 * in the derived message list. Captured at the event being accounted, because a
 * later compaction must not retroactively decide what an earlier request saved.
 */
interface Surface {
  nodes: ReadonlySet<number>
  slots: ReadonlyMap<number, number>
}

/** Marker property recording that one session's accessor is already wrapped. */
const WRAPPED = Symbol('reasoning-distill/wrapped')

/** Estimated tokens for one string, matching the harness's chars-per-token estimate. */
function estimateChars(chars: number): number {
  return Math.ceil(chars / 4)
}

/** Reasoning text of one assistant message, or an empty string. */
function reasoningOf(content: readonly ContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return ''
  return content.filter((b): b is Extract<ContentBlock, { type: 'reasoning' }> => b.type === 'reasoning')
    .map(b => b.text)
    .join('\n')
}

/** One queued compression, remembered between the assistant message and its step end. */
interface PendingTarget {
  sessionId: string
  seq: number
  turn: number
  step: number
  messageId: string
  provider: string
  model: string
  content: readonly ContentBlock[]
  rule: ModelRule
  /** Estimated-size source for the live UI. */
  reasoningChars: number
  /** Index of the reasoning block inside the message, for the message-edit bridge. */
  reasoningBlockIndex: number
}

/** Result of one distillation attempt. */
interface DistillOutcome {
  text?: string
  run: DistillRun
  failed: boolean
}

/**
 * Owns every session-scoped effect of this plugin.
 */
export class ReasoningDistillEngine {
  /** Sessions whose events this plugin must never treat as user work. */
  private readonly ownSessions = new Set<string>()
  /** Assistant messages awaiting their step's tool results. */
  private readonly pending = new Map<string, PendingTarget>()
  /** In-flight compressions, awaited at the next step boundary. */
  private readonly inFlight = new Map<string, Promise<void>>()

  /** Details of the compressions in {@link inFlight}, for the live UI. */
  private readonly running = new Map<string, ActiveCompression & { sessionId: string }>()

  /** When a pre-step began waiting on this session's compressions, and why. */
  private readonly blocked = new Map<string, { since: number; reason: BlockingReason }>()

  /** Memoized session kind for children, cleared on disposal. */
  private readonly sessionKind = new Map<string, 'continuable' | 'oneShot'>()
  /**
   * Sessions whose record cannot be read right now. Distillation is skipped for
   * them rather than spending money on a result that could not be stored; every
   * pre-step retries the read, so this clears itself once the record is back.
   */
  private readonly storageBroken = new Set<string>()
  /**
   * The rewrite awaiting a hand-off, per session: the entry whose distilled text
   * some backend should write into the history. The panel picks it up, asks the
   * backend, then stops the original turn through {@link ReasoningDistillEngine.handoff}.
   */
  private readonly pendingBranch = new Map<string, string>()
  /** Sessions whose next derivation is the model request; see the wrapper. */
  private readonly expectRequest = new Set<string>()
  /** Per-compression wait bound: its rule's distillation timeout, 0 = unbounded. */
  private readonly waitBound = new Map<string, number>()
  /** Attempts whose wait bound expired: their adopted result must not land late. */
  private readonly abandoned = new Set<string>()
  /** Timers that would mark an attempt abandoned; cleared once it settles. */
  private readonly abandonTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Audit links known to be non-durable, keyed `sessionId:entryId`. */
  private readonly auditBroken = new Set<string>()
  /** Bumped whenever a session id is attached again; stale work checks it. */
  private readonly generation = new Map<string, number>()
  /** The session object currently attached for an id; late events are ignored. */
  private readonly current = new Map<string, Session>()
  /** Cached derived-index maps keyed by session id. */
  /** Session ids whose accessor this engine already wrapped. */
  private readonly wrapped = new WeakSet<object>()
  /**
   * Entry ids that the most recent `deriveMessages()` actually rewrote, per
   * session, and the raw derive function it started from.
   *
   * This is the single source of truth for "in force": substitution, accounting
   * and the reported stock all read it, so a rewrite that cannot be applied (its
   * message no longer carries reasoning, say) can never be counted as saving.
   */
  private readonly applied = new Map<string, Array<{ afterSeq: number; ids: Map<string, number> }>>()
  private readonly rawDerive = new Map<string, () => Message[]>()

  /**
   * Claims a durable log writer for a freshly created compression session, once
   * a persistence backend is present. @see ReasoningDistillEngine.usePersistence
   */
  private attachWriter: ((session: Session) => Promise<void>) | undefined

  /**
   * Whether this engine still rewrites prompts. Unloading flips it off instead
   * of unwrapping every session, so no session object is retained by a registry
   * (a strong map here would pin every session the plugin ever saw).
   */
  private active = true

  /**
   * @param ctx - host context carrying the session store, LLM seam, and logger.
   * @param config - live plugin configuration.
   * @param store - sidecar store.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly store: SidecarStore,
  ) {}

  /** Attach every observer, hook, and existing-session wrap. */
  start(): void {
    for (const session of this.ctx.sessions.list()) this.attach(session)
    this.ctx.on('session/created', (session: Session) => { this.attach(session) })
    this.ctx.on('session/event', (session: Session, event: { type: string; seq: number; time: number; data: unknown }) => {
      try {
        this.observe(session, event)
      } catch (error: unknown) {
        this.ctx.logger.warn('reasoning-distill: observation failed: %o', error)
      }
    })
    // Await any distillation queued by the previous step before the next request
    // is assembled, so a compression lands before the reasoning would be resent.
    this.ctx.effect(() => () => this.deactivate())
    // A disposed compression session must be forgotten: otherwise the set grows
    // for the process lifetime, and a later user session that happens to reuse
    // the id would be treated as plugin-owned and never observed.
    this.ctx.on('session/disposed', (session: Session) => { this.forgetSession(session) })
    this.ctx.on('agent/pre-step', async (payload, next) => {
      // `attach` preloads the sidecar fire-and-forget, so on a resumed session
      // the first request could otherwise be assembled from raw reasoning while
      // the read is still in flight. Single-flight makes this join that read.
      // The host passes the turn's signal, but its event declaration does not
      // always carry it, so read it defensively rather than trusting the type.
      const signal = (payload as { signal?: AbortSignal }).signal
      // A stalled sidecar read must not outlive a stop either: the host only looks
      // at its signal once this handler returns.
      await this.untilAborted(this.ensureLoaded(payload.agent.session), signal)
      if (signal?.aborted) return next()
      // A stop must end the wait, not queue behind it: the host only looks at its
      // signal once this handler returns.
      if (!await this.settle(payload.agent.session, signal)) return next()
      // A successful compression with a branch backend ends this turn *before* any
      // request goes out: the conversation continues on the branch instead.
      if (!signal?.aborted && await this.handOffToBranch(payload.agent.session, signal)) return { kind: 'reject' }
      // The loop assembles the request right after this returns; arming the
      // session here is what lets the wrapper tell that derivation apart from a
      // viewer's.
      this.expectRequest.add(payload.agent.session.id)
      return next()
    })
  }

  /**
   * Register the durable-writer hook for compression sessions.
   * @param attach - claims a write handle for one freshly created session.
   */
  usePersistence(attach: (session: Session) => Promise<void>): void {
    this.attachWriter = attach
  }

  /**
   * Make sure one session's sidecar is in memory before its request is built.
   * @param session - session entering a pre-step boundary.
   */
  private async ensureLoaded(session: Session): Promise<void> {
    try {
      await this.store.load(session.id)
      this.storageBroken.delete(session.id)
    } catch (error: unknown) {
      // A sidecar that cannot be read disables the feature for this session: it
      // must never stop the conversation itself, and — since the result could
      // not be recorded — it must not spend money on a distillation either.
      // Every pre-step retries the read, so this clears itself once the record
      // is readable again.
      if (!this.storageBroken.has(session.id)) {
        this.ctx.logger.warn('reasoning-distill: leaving %s undistilled while its record is unreadable: %o', session.id, error)
      }
      this.storageBroken.add(session.id)
    }
  }

  /** Stop rewriting prompts, e.g. when this plugin unloads. */
  private deactivate(): void {
    this.active = false
  }

  /**
   * Drop every per-session trace of a session that no longer exists.
   * @param sessionId - disposed session id.
   */
  private forgetSession(session: Session): void {
    // A disposal can arrive late, after the same id was attached again. The event
    // names the object it disposes, so a *different* object sitting on that id is
    // a successor and must not be cleared. An id the engine never attached (our
    // own audit sessions, for instance) is not tracked here and is released
    // normally.
    const attached = this.current.get(session.id)
    if (attached !== undefined && attached !== session) return
    this.current.delete(session.id)
    // Disposal itself invalidates the generation: work already running for this id
    // captured the old number, so its continuations (accounting, compaction,
    // compression, hand-off) all stop writing even if the id is never reused.
    this.generation.set(session.id, (this.generation.get(session.id) ?? 0) + 1)
    this.ownSessions.delete(session.id)
    this.sessionKind.delete(session.id)
    this.releaseSession(session.id)
  }

  /**
   * Drop every per-session trace, keyed by id.
   *
   * Called when the session goes away and when an id is attached again: a later
   * compression of the old generation must not keep a new session's requests
   * waiting (its in-flight entry is matched by id prefix) or write into its
   * record.
   * @param sessionId - session whose per-id state should go.
   */
  private releaseSession(sessionId: string): void {
    const prefix = `${sessionId}:`
    for (const map of [this.pending, this.inFlight, this.running, this.waitBound] as Array<Map<string, unknown>>) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) map.delete(key)
      }
    }
    this.pendingBranch.delete(sessionId)
    this.expectRequest.delete(sessionId)
    this.blocked.delete(sessionId)
    this.applied.delete(sessionId)
    this.rawDerive.delete(sessionId)
    for (const key of [...this.abandoned]) {
      if (key.startsWith(prefix)) this.abandoned.delete(key)
    }
    for (const [key, timer] of [...this.abandonTimers]) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer)
        this.abandonTimers.delete(key)
      }
    }
    for (const key of [...this.auditBroken]) {
      if (key.startsWith(prefix)) this.auditBroken.delete(key)
    }
    this.storageBroken.delete(sessionId)
  }

  /**
   * Which of a model's three switches governs this session.
   *
   * The host marks a subagent child with `origin: 'subagent'` on its header, and
   * its `subagent/descriptor` event records the lifecycle mode — `one-shot` for
   * a terminal delegation, `continuable` for a resumable conversation (a
   * teammate, for instance). Everything else is an ordinary conversation. Each
   * kind has its own switch on the model's rule.
   * @param session - session being considered.
   * @returns the switch that decides this session, or undefined for one that
   *   cannot be classified (it is treated as one-shot).
   */
  private kindOf(session: Session): 'main' | 'continuable' | 'oneShot' {
    const header = session.header as { origin?: string; delegationDepth?: number } | undefined
    // Depth 0 means top level: the host documents it that way and preserves an
    // explicit `delegationDepth: 0` on ordinary sessions, so only a POSITIVE
    // depth marks a child.
    const depth = header?.delegationDepth
    const child = header?.origin === 'subagent' || (typeof depth === 'number' && depth > 0)
    if (!child) return 'main'
    const known = this.sessionKind.get(session.id)
    if (known !== undefined) return known
    // A child without a readable descriptor counts as one-shot: the cheaper
    // mistake is not distilling it.
    let kind: 'continuable' | 'oneShot' = 'oneShot'
    for (const event of session.ownEvents()) {
      if (event.type !== 'subagent/descriptor') continue
      kind = (event.data as { mode?: string } | undefined)?.mode === 'continuable' ? 'continuable' : 'oneShot'
      break
    }
    this.sessionKind.set(session.id, kind)
    return kind
  }

  /**
   * Whether the model's rule enables distillation for this session's kind.
   * @param session - session being considered.
   * @param rule - the rule resolved for the model that answered.
   * @returns true when that kind's switch is on.
   */
  private appliesTo(session: Session, rule: ModelRule): boolean {
    const kind = this.kindOf(session)
    if (kind === 'main') return rule.enabled
    // A delegation deeper than the configured cap is left alone; `0` means the
    // switch applies at any depth.
    const depth = this.subagentDepth(session)
    if (kind === 'continuable') {
      return rule.continuableSubagents && withinDepth(depth, rule.continuableMaxDepth)
    }
    return rule.oneShotSubagents && withinDepth(depth, rule.oneShotMaxDepth)
  }

  /**
   * Delegation depth of one session, 0 for a top-level conversation.
   * @param session - session being considered.
   * @returns the persisted depth, or 0 when the session is top level.
   */
  private subagentDepth(session: Session): number {
    const depth = (session.header as { delegationDepth?: number } | undefined)?.delegationDepth
    return typeof depth === 'number' && depth > 0 ? depth : 0
  }

  /** Wrap one session's derived-history accessor exactly once. */
  private attach(session: Session): void {
    if (this.wrapped.has(session)) return
    this.wrapped.add(session)
    // A session object is attached once, but the *id* can come back (a cleared or
    // re-created conversation). Everything keyed by that id belongs to the
    // previous generation, and a later compression must not write into the new
    // one's record or block its requests.
    this.generation.set(session.id, (this.generation.get(session.id) ?? 0) + 1)
    this.releaseSession(session.id)
    this.current.set(session.id, session)
    const original = session.deriveMessages.bind(session)
    const engine = this
    this.rawDerive.set(session.id, original)
    Object.defineProperty(session, 'deriveMessages', {
      configurable: true,
      writable: true,
      value: function deriveMessagesDistilled(this: Session): Message[] {
        const messages = original()
        // A loaded plugin must not keep rewriting prompts after it is unloaded.
        if (!engine.active) return messages
        const result = engine.applyRewrites(this, messages)
        // Remember exactly what this request carried: accounting settles against
        // it rather than re-deriving an answer from a later surface.
        // Only derivations inside the window the pre-step opened may record what a
        // request carried, so a viewer or another plugin deriving an already
        // in-flight request cannot rewrite its accounting. The marker is *not*
        // consumed: another pre-step hook may derive the same messages for
        // inspection first, and the request's own derivation must still record.
        if (engine.expectRequest.has(this.id)) {
          const nodes = this.surface.nodes
          const history = engine.applied.get(this.id) ?? []
          history.push({
            afterSeq: (nodes[nodes.length - 1] as number | undefined) ?? 0,
            ids: result.applied,
          })
          // Only the recent derivations can still be awaiting a response.
          if (history.length > 16) history.splice(0, history.length - 16)
          engine.applied.set(this.id, history)
        }
        return result.out
      },
    })
    void this.store.load(session.id).catch(() => undefined)
  }

  /**
   * Replace the reasoning of every compressed message in one derived list.
   * @param session - session whose history is being derived.
   * @param messages - the unmodified derived messages.
   * @returns the same array when nothing applies, else a substituted copy.
   */
  /**
   * Whether a recorded rewrite is still the one this replay would use.
   *
   * Substitution is a pure function of the surface, so the same predicate decides
   * whether a rewrite is applied *and* whether it may be credited. That keeps
   * "still in force" and "still earning" from drifting apart: an entry that
   * survives a partial compaction keeps earning, and one whose target is gone
   * stops on both counts.
   * @param session - session being replayed.
   * @param entry - the recorded compression.
   * @param nodes - the surface node seqs, when the caller already has them.
   * @returns true when this entry still replaces a replayed message.
   */
  private survives(session: Session, entry: StoredEntry, surface?: Surface): boolean {
    if (entry.failed === true || entry.skipped === true || entry.distilledText.length === 0) return false
    if (entry.inactive === true) return false
    const nodes = surface?.nodes ?? new Set<number>(session.surface.nodes)
    if (!nodes.has(entry.targetSeq)) return false
    const slots = surface?.slots ?? this.derivedIndex(session)
    if (!slots.has(entry.targetSeq)) return false
    // A projection can keep the seq while replacing the message, and a later step
    // can fold the reasoning block away; either way the rewrite would not apply,
    // so the entry must stop counting as alive.
    const event = session.eventAt(entry.targetSeq as Parameters<Session['eventAt']>[0])
    const message = event === undefined ? null : session.deriveEventMessage(event)
    if (message === null || message.id !== entry.targetMessageId) return false
    if (withDistilledReasoning(message, entry.distilledText) === undefined) return false
    // The reasoning must still be the text this distillation came from: an edit in
    // place (same id, same seq) must not be silently overwritten by stale output.
    if (entry.originalHash !== undefined && hashText(reasoningTextOf(message)) !== entry.originalHash) return false
    return true
  }

  /**
   * The surface as one request saw it: node seqs plus the derived positions.
   * @param session - session to snapshot.
   * @returns both views, computed from the same read of the surface.
   */
  private surfaceOf(session: Session): Surface {
    return { nodes: new Set<number>(session.surface.nodes), slots: this.derivedIndex(session) }
  }

  private applyRewrites(session: Session, messages: Message[]): { out: Message[]; applied: Map<string, number> } {
    const applied = new Map<string, number>()
    const record = this.store.peek(session.id)
    if (record === undefined || record.entries.length === 0) return { out: messages, applied }
    const bySeq = new Map<number, StoredEntry>()
    for (const entry of record.entries) bySeq.set(entry.targetSeq, entry)
    const index = this.derivedIndex(session)
    const surface = this.surfaceOf(session)
    let out: Message[] | undefined
    for (const [seq, entry] of bySeq) {
      // A failed or superseded attempt recorded its spending but substitutes
      // nothing.
      if (!this.survives(session, entry, surface)) continue
      const at = index.get(seq)
      if (at === undefined) continue
      const source = messages[at]
      if (source === undefined || source.role !== 'assistant') continue
      // A projection can replace the content at this seq with a different
      // assistant message; its reasoning is not the reasoning this rewrite
      // distilled, so it must not be injected there.
      if ((source as { id?: string }).id !== entry.targetMessageId) continue
      // The message must still carry reasoning: a projection can rewrite it (or
      // strip the reasoning) at the same seq, and then this rewrite has nothing
      // to replace and must not be recorded as applied.
      // The message actually being replaced decides: an earlier wrapper may have
      // edited the reasoning in its returned list while the durable event stayed
      // the same, and that edit must not be overwritten by stale distillation.
      if (entry.originalHash !== undefined && hashText(reasoningTextOf(source)) !== entry.originalHash) continue
      const replaced = withDistilledReasoning(source, entry.distilledText)
      if (replaced === undefined) continue
      out ??= [...messages]
      out[at] = replaced
      applied.set(entry.id, at)
    }
    return { out: out ?? messages, applied }
  }

  /**
   * What the rewrites in force would remove from one rendered request.
   *
   * Computed from the session's own (unsubstituted) derived history, so it always
   * describes the prompt a request would carry right now, and priced at the
   * current moment rather than at the time each rewrite was first applied.
   * @param sessionId - session to inspect.
   * @returns tokens and money, or undefined when the session is not attached here.
   */
  stock(sessionId: string): { tokens: number; saved: number; ids: string[] } | undefined {
    const raw = this.rawDerive.get(sessionId)
    const session = this.sessionById(sessionId)
    if (raw === undefined || session === undefined) return undefined
    const record = this.store.peek(sessionId)
    if (record === undefined) return undefined
    const { applied } = this.applyRewrites(session, raw())
    const byId = new Map(record.entries.map(entry => [entry.id, entry]))
    const prices = this.config.prices.get() ?? {}
    const now = Date.now()
    let tokens = 0
    let saved = 0
    for (const id of applied.keys()) {
      const entry = byId.get(id)
      if (entry === undefined) continue
      tokens += entry.savedTokensPerRequest
      saved += entry.savedTokensPerRequest * (priceAt(entry.model, prices, now, this.config).bucket.hit / 1_000_000)
    }
    return { tokens, saved, ids: [...applied.keys()] }
  }

  /**
   * Hand a turn over to a branch the moment a compression succeeded.
   *
   * Only a *branch* backend can be driven from here: its endpoint lives on the
   * web server and needs no browser session, so the branch is ready before the
   * pre-step would assemble a request — the original conversation then ends
   * without spending a single call. An in-place backend is applied by the panel
   * instead (its `/api/*` routes require the browser's credentials), and the
   * request it would have sent is already short thanks to the replay rewrite.
   * @param session - session whose pre-step is running.
   * @returns true when the turn should be rejected in favour of the branch.
   */
  private async handOffToBranch(session: Session, signal?: AbortSignal): Promise<boolean> {
    const generation = this.generation.get(session.id) ?? 0
    const entryId = this.pendingBranch.get(session.id)
    if (entryId === undefined) return false
    const backend = backendById(this.config.rewriteBackend.get())
    if (backend === undefined || backend.kind !== 'branch') return false
    const record = this.store.peek(session.id)
    const entry = record?.entries.find(item => item.id === entryId)
    if (entry === undefined || entry.distilledText === '') {
      if ((this.generation.get(session.id) ?? 0) === generation) this.pendingBranch.delete(session.id)
      return false
    }
    const port = (this.ctx as unknown as { webServer?: { port?: number } }).webServer?.port
    if (typeof port !== 'number') {
      // No reachable endpoint: leave the hand-off to the panel rather than
      // wedging the turn.
      this.ctx.logger.debug('reasoning-distill: no web server port; branch hand-off deferred to the panel')
      return false
    }
    const request = rewriteRequest(backend.id, session.id, {
      targetSeq: entry.targetSeq,
      targetMessageId: entry.targetMessageId,
      targetBlockIndex: entry.targetBlockIndex ?? -1,
    }, entry.distilledText)
    if (request === undefined) {
      if ((this.generation.get(session.id) ?? 0) === generation) this.pendingBranch.delete(session.id)
      return false
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
        ...branchSignal(this.config.branchTimeoutMs.get(), signal),
      })
      const payload = await response.json().catch(() => null) as { sessionId?: unknown; error?: unknown } | null
      const created = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!response.ok || created === '') {
        const reason = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`
        await this.recordHandoff(session.id, entryId, { state: 'failed', error: reason, at: Date.now() }, generation)
        if ((this.generation.get(session.id) ?? 0) === generation) this.pendingBranch.delete(session.id)
        this.ctx.logger.warn('reasoning-distill: branch refused for %s (%s); carrying on in place', session.id, reason)
        return false
      }
      const recorded = await this.recordHandoff(session.id, entryId, { state: 'created', branchId: created, at: Date.now() }, generation)
      if ((this.generation.get(session.id) ?? 0) === generation) this.pendingBranch.delete(session.id)
      if (!recorded) {
        // The branch exists, but nothing the panel can see points at it. Ending the
        // turn here would strand the user in a stopped conversation with no route
        // to the branch, so the original continues instead.
        this.ctx.logger.warn('reasoning-distill: branch %s was created but not recorded; continuing in the original', created)
        return false
      }
      this.ctx.logger.info('reasoning-distill: handed %s over to branch %s', session.id, created)
      // Only the generation that asked for this hand-off may have its turn ended:
      // a disposed one is already gone.
      return (this.generation.get(session.id) ?? 0) === generation
    } catch (error: unknown) {
      // A request that failed after it was sent may still have created a branch:
      // the backend's contract has no idempotency key, so the outcome is genuinely
      // unknown and this plugin cannot name the session. Say exactly that instead
      // of implying nothing happened.
      const detail = error instanceof Error ? error.message : String(error)
      const reason = `branch request did not complete (${detail}); a branch may exist that this plugin cannot name`
      await this.recordHandoff(session.id, entryId, { state: 'failed', error: reason, at: Date.now() }, generation)
      if ((this.generation.get(session.id) ?? 0) === generation) this.pendingBranch.delete(session.id)
      this.ctx.logger.warn('reasoning-distill: branch failed for %s (%s); carrying on in place', session.id, reason)
      return false
    }
  }

  /**
   * Mark one entry's audit session as not durably stored.
   *
   * The writer can attach successfully and still fail on flush (the host reports
   * the first durability listener failure), leaving an audit link that dies with
   * the process. The entry must not keep promising a record it does not have.
   * @param sessionId - session that owns the entry.
   * @param entryId - entry whose audit link is broken.
   */
  /**
   * Take the audited-broken marker for a to-be-built entry, consuming it.
   *
   * The marker is one-shot: it exists so an entry is born marked, and the
   * store-level write in {@link markAuditUndurable} covers entries that already
   * exist, so nothing is lost by clearing it here.
   * @param sessionId - session that owns the entry.
   * @param entryId - the id the entry will be recorded under.
   * @returns whether that entry's audit link is known broken.
   */
  private takeAuditBroken(sessionId: string, entryId: string): boolean {
    return this.auditBroken.delete(`${sessionId}:${entryId}`)
  }

  private async markAuditUndurable(sessionId: string, entryId: string, origin?: number): Promise<void> {
    // Remembered as well as written: a flush can reject before the entry is even
    // inserted, and then the entry must be born marked rather than marked later.
    // The generation that started the compression, not the one current when this
    // late failure arrives: a reused id must not mark its successor's entry.
    if (origin !== undefined && (this.generation.get(sessionId) ?? 0) !== origin) return
    const key = `${sessionId}:${entryId}`
    this.auditBroken.add(key)
    if (this.auditBroken.size > 512) this.auditBroken.clear()
    try {
      await this.store.update(sessionId, (record) => {
        if (origin !== undefined && (this.generation.get(sessionId) ?? 0) !== origin) return
        const entry = record.entries.find(item => item.id === entryId)
        if (entry !== undefined) entry.sessionMissing = true
      })
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: could not mark the audit link undurable: %o', error)
    }
  }

  /**
   * Record what a branch hand-off did, on the entry that was handed over.
   *
   * The choice is deliberate: nothing else about the turn changes on failure, so
   * the conversation carries on exactly as if no backend had been selected and
   * the only trace is this durable note in the reasoning-distill page.
   * @param sessionId - session that owns the entry.
   * @param entryId - entry the hand-off concerned.
   * @param outcome - what happened.
   */
  private async recordHandoff(
    sessionId: string,
    entryId: string,
    outcome: { state: 'created' | 'failed'; branchId?: string; error?: string; at: number },
    generation?: number,
  ): Promise<boolean> {
    let written = false
    try {
      await this.store.update(sessionId, (record) => {
        // Checked inside the mutator: the write is queued, so the generation can
        // change between the call and the moment this runs. A skipped or
        // not-found mutation is *not* a recorded hand-off, so the caller must not
        // treat it as one.
        if (generation !== undefined && (this.generation.get(sessionId) ?? 0) !== generation) return
        const entry = record.entries.find(item => item.id === entryId)
        if (entry === undefined) return
        entry.handoff = outcome
        written = true
      })
      return written
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: could not record the hand-off: %o', error)
      return false
    }
  }

  /**
   * Stop a session's running turn, as the user's own stop button does.
   *
   * Called once the distilled text has been written into a new or rewritten
   * history: the original conversation must not keep spending on the long
   * version it just replaced.
   * @param sessionId - session whose turn may end.
   * @param cancel - false to clear the pending hand-off without stopping the turn.
   * @param error - why a panel-driven backend could not apply the rewrite.
   * @returns whether a running agent was found and asked to stop.
   */
  handoff(sessionId: string, cancel = true, error?: string, entryId?: string, generation?: number): boolean {
    // The panel tells us which attempt it is settling: a later compression can
    // install its own pending rewrite while an earlier request is still open, and
    // that successor must not be cleared or blamed for this attempt's failure.
    if (entryId !== undefined && this.pendingBranch.get(sessionId) !== entryId) return false
    if (generation !== undefined && (this.generation.get(sessionId) ?? 0) !== generation) return false
    const pending = this.pendingBranch.get(sessionId)
    this.pendingBranch.delete(sessionId)
    if (error !== undefined && pending !== undefined) {
      void this.recordHandoff(sessionId, pending, { state: 'failed', error, at: Date.now() }, generation)
    }
    // The returned value means "this settle took effect" (the pending rewrite of
    // that entry is gone). Ending a turn is a side effect, not the outcome: an
    // in-place settle never stops the turn yet has still settled successfully.
    // Nothing pending means nothing settled, whatever the caller asked for.
    if (pending === undefined) return false
    if (!cancel) return true
    const agents = (this.ctx as unknown as { agents?: { get(id: string): { cancel(cause: { kind: string }): void } | undefined } }).agents
    // Only a hand-off this plugin is completing may stop a turn: without a pending
    // rewrite of ours there is nothing to hand over, and cancelling would let any
    // same-origin caller end an unrelated session's turn.
    if (!cancel || pending === undefined) return false
    const agent = agents?.get(sessionId)
    if (agent === undefined) return false
    agent.cancel({ kind: 'user' })
    return true
  }

  /** The live session behind an id, when this engine still knows it. */
  private sessionById(sessionId: string): Session | undefined {
    // The service keys sessions by a branded id; the plugin only ever holds the
    // plain string the host gave it.
    return this.ctx.sessions?.get(sessionId as SessionId)
  }

  /**
   * Map surface sequence to index in the derived message list.
   *
   * Rebuilt from scratch on every derivation. A cache here would have to be
   * keyed on something stronger than node count and tail — a one-for-one surface
   * replacement of an interior node keeps both — and getting that wrong applies
   * a rewrite to the wrong message, so the O(nodes) walk is bought back on
   * purpose. It runs once per step over a list the host just rebuilt anyway.
   * @param session - session being derived.
   * @returns sequence-to-index map.
   */
  private derivedIndex(session: Session): Map<number, number> {
    const index = new Map<number, number>()
    let position = -1
    for (const seq of session.surface.nodes) {
      const event = session.eventAt(seq)
      if (event === undefined) continue
      if (session.deriveEventMessage(event) === null) continue
      position += 1
      index.set(seq, position)
    }
    return index
  }

  /**
   * Handle one session event.
   *
   * Staging must be synchronous: a step with no tool call appends `step/end`
   * microseconds after its `assistant/message`, so an awaited store read before
   * staging would let the step boundary pass with nothing queued.
   * @param session - emitting session.
   * @param event - appended event.
   */
  private observe(
    session: Session,
    event: { type: string; seq: number; time: number; data: unknown },
  ): void {
    if (this.ownSessions.has(session.id)) return
    // A disposed session object can still emit queued events; they belong to the
    // previous generation and must not stage work or move state for its successor.
    if (this.current.get(session.id) !== session) return
    // Any event can change the surface (append, prune, projection, message
    // edit), so the position index is only valid until the next event.
    switch (event.type) {
      case 'assistant/message': {
          const model = this.stageTarget(session, event)
        if (model !== '') {
          // Snapshot the surface now, not after the async load inside account(): a
          // compaction in between would otherwise decide what this request saved.
          const surface = this.surfaceOf(session)
          void this.account(session, event.seq, event.time, model, surface).catch((error: unknown) => {
            this.ctx.logger.warn('reasoning-distill: accounting failed: %o', error)
          })
        }
        return
      }
      case 'step/end': {
        const data = event.data as { turn?: number; step?: number }
        const key = this.pendingKey(session.id, data.turn ?? 0, data.step ?? 0)
        // A step boundary closes the arming window: the next one is opened by the
        // pre-step that actually leads to a request.
        this.expectRequest.delete(session.id)
        // Most steps are not candidates (no reasoning, below the threshold, the
        // rule off, no backend). Nothing is launched for them, so no gate may be
        // registered either: a resolved promise left in `inFlight` per ordinary
        // step would accumulate for the life of the process and slow every later
        // pre-step down.
        if (!this.pending.has(key)) {
          this.ctx.logger.debug('reasoning-distill: step end %s had nothing staged', key)
          return
        }
        // The record is read *before* paying, not merely before the next request:
        // a distillation whose result could not be stored must not be bought. The
        // gate is registered as in-flight so a following pre-step still waits for
        // it rather than replaying raw reasoning once.
        const atStep = this.generation.get(session.id) ?? 0
        const gate = this.ensureLoaded(session).then(async () => {
          // The read is asynchronous: the session may have been disposed and the id
          // reused while it was running, in which case this gate belongs to nobody
          // and must neither launch nor touch the successor's state.
          if ((this.generation.get(session.id) ?? 0) !== atStep) return
          if (this.storageBroken.has(session.id)) {
            this.pending.delete(key)
            if (this.inFlight.get(key) === gate) this.inFlight.delete(key)
            return
          }
          this.launch(session, event)
          // Wait for the compression this launched, not merely for the launch:
          // then a pre-step that snapshotted this gate cannot proceed while the
          // rewrite is still being built, whatever the microtask order.
          const started = this.inFlight.get(key)
          if (started !== undefined && started !== gate) await started
        }).catch((error: unknown) => {
          this.ctx.logger.warn('reasoning-distill: step end gate failed: %o', error)
        })
        if ((this.generation.get(session.id) ?? 0) === atStep) this.inFlight.set(key, gate)
        return
      }
      case 'compaction/end':
        void this.onCompaction(session).catch((error: unknown) => {
          this.ctx.logger.warn('reasoning-distill: epoch close failed: %o', error)
        })
        return
      default:
        return
    }
  }

  /**
   * Stage a candidate assistant message for the step boundary, synchronously.
   * @param session - emitting session.
   * @param event - the `assistant/message` event.
   * @returns the producing model id, or an empty string when the route cannot
   *   be priced or the message is not a distillation candidate.
   */
  private stageTarget(session: Session, event: { seq: number; data: unknown }): string {
    const data = event.data as { turn?: number; step?: number; message?: unknown; interrupted?: true }
    const message = data.message as { id?: string; content?: ContentBlock[]; source?: { provider?: string; model?: string } } | undefined
    if (message === undefined || !Array.isArray(message.content)) return ''
    const model = message.source?.model ?? ''
    const provider = message.source?.provider ?? ''
    if (model === '') return ''
    if (!this.config.enabled.get()) return model
    // A distillation is only useful when some companion can write the result into
    // the session's own history. With no backend selected the panel forces the
    // master switch off; this is the belt-and-braces half of the same rule.
    if (this.config.rewriteBackend.get() === '') return model
    // A canceled step is not an answer: the host still appends `step/end` after
    // an abort (agent-loop), so staging here would spend a distillation on
    // partial reasoning and hold the next request until it finished. Accounting
    // still runs, because that response may have replayed earlier rewrites.
    if (data.interrupted === true) {
      this.ctx.logger.debug('reasoning-distill: skipping an interrupted step')
      return model
    }
    const rule = resolveRule(model, this.config)
    if (!this.appliesTo(session, rule)) return model
    const reasoning = reasoningOf(message.content)
    if (reasoning.trim().length === 0) return model
    const tokens = estimateChars(reasoning.length)
    if (tokens < rule.thresholdTokens) return model
    const hasToolCall = message.content.some(block => block.type === 'tool-call')
    if (!hasToolCall && !rule.includeFinalTurns) return model
    const key = this.pendingKey(session.id, data.turn ?? 0, data.step ?? 0)
    this.pending.set(key, {
      sessionId: session.id,
      seq: event.seq,
      reasoningChars: reasoning.length,
      reasoningBlockIndex: reasoningBlockIndexOf(message.content),
      turn: data.turn ?? 0,
      step: data.step ?? 0,
      messageId: message.id ?? '',
      provider,
      model,
      content: message.content,
      rule,
    })
    this.ctx.logger.debug('reasoning-distill: staged %s turn %d step %d (%d est. tokens)',
      model, data.turn ?? 0, data.step ?? 0, tokens)
    return model
  }

  /** Start the distillation staged for one finished step. */
  private launch(session: Session, event: { type: string; data: unknown }): void {
    if (this.current.get(session.id) !== session) return
    const data = event.data as { turn?: number; step?: number }
    const key = this.pendingKey(session.id, data.turn ?? 0, data.step ?? 0)
    const target = this.pending.get(key)
    if (target === undefined) {
      this.ctx.logger.debug('reasoning-distill: step end %s had nothing staged', key)
      return
    }
    this.pending.delete(key)
    this.waitBound.set(key, target.rule.timeoutMs)
    this.running.set(key, {
      sessionId: session.id,
      turn: target.turn,
      step: target.step,
      provider: target.provider,
      model: target.model,
      distiller: `${target.rule.distiller.provider}/${target.rule.distiller.model}`,
      originalTokens: estimateChars(target.reasoningChars),
      startedAt: Date.now(),
    })
    const promise = this.compress(session, target).catch((error: unknown) => {
      this.ctx.logger.warn('reasoning-distill: compression failed: %o', error)
    })
    const generation = this.generation.get(session.id) ?? 0
    // The wait bound also covers our own storage work: once it expires the attempt
    // is abandoned, so a stalled audit writer or file write cannot make its result
    // land after the next request has already gone out with the raw reasoning.
    const existingTimer = this.abandonTimers.get(key)
    if (existingTimer !== undefined) clearTimeout(existingTimer)
    if (target.rule.timeoutMs > 0) {
      const timer = setTimeout(() => { this.abandoned.add(key) }, target.rule.timeoutMs + 30_000)
      timer.unref?.()
      this.abandonTimers.set(key, timer)
    }
    const record = this.running.get(key)
    this.inFlight.set(key, promise)
    void promise.finally(() => {
      // Only retire what this launch installed: a replacement session (a new
      // generation) can have started its own work under the same turn/step key.
      if (this.generation.get(session.id) !== generation) return
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key)
      if (this.running.get(key) === record) this.running.delete(key)
      if (this.waitBound.get(key) !== undefined) this.waitBound.delete(key)
      this.abandoned.delete(key)
      const timer = this.abandonTimers.get(key)
      if (timer !== undefined) {
        clearTimeout(timer)
        this.abandonTimers.delete(key)
      }
    })
  }

  /**
   * Await the compressions queued for one step, bounded so a slow distiller
   * cannot stall the next request past its useful window.
   * @param sessionId - session entering a pre-step boundary.
   */
  private async settle(session: Session, signal?: AbortSignal): Promise<boolean> {
    const sessionId = session.id
    const mine = [...this.inFlight.entries()].filter(([key]) => key.startsWith(`${sessionId}:`))
    if (mine.length === 0) return true
    // Each compression is already bounded by its own rule's timeout, so waiting
    // for the promise to settle is the whole guarantee: the next request is
    // built only after the rewrite is in place, or after that compression gave up.
    // The wait is published so the UI can say why a step has not been sent.
    this.blocked.set(sessionId, { since: Date.now(), reason: blockingReason(session) })
    try {
      // Waiting is the contract: the next request is assembled only once the
      // rewrite is in place. A compression whose rule sets a timeout is already
      // aborted by its own provider call, so the wait is bounded just past that
      // as a backstop for adapters that ignore abort. `timeoutMs: 0` means no
      // limit, and then this genuinely waits until the compression ends.
      const waits = Promise.allSettled(mine.map(([, promise]) => promise))
      const bounds = mine.map(([key]) => this.waitBound.get(key) ?? 0)
      if (bounds.includes(0)) {
        // No configured limit: wait until the compression ends, but never past a
        // user's own stop, which arrives as this signal.
        await this.untilAborted(waits, signal)
      } else {
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<void>(resolve => {
          deadlineTimer = setTimeout(resolve, Math.max(...bounds) + 30_000)
          deadlineTimer.unref?.()
        })
        try {
          await this.untilAborted(Promise.race([waits, deadline]), signal)
        } finally {
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
        }
      }
      return signal === undefined || !signal.aborted
    } finally {
      this.blocked.delete(sessionId)
    }
  }

  /**
   * Await pending work unless the caller's signal aborts first.
   *
   * The host checks its signal only after the `agent/pre-step` waterfall returns,
   * so a plugin that waits here without watching it would make Stop hang for as
   * long as the wait lasts — unbounded with `timeoutMs: 0`.
   * @param work - the wait to observe.
   * @param signal - the turn's abort signal, when the host supplied one.
   */
  private async untilAborted(work: Promise<unknown>, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) {
      await work
      return
    }
    if (signal.aborted) return
    await new Promise<void>(resolve => {
      const done = (): void => {
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
      void work.then(done, done)
    })
  }

  /**
   * Live compression state for one session, for the report route.
   * @param sessionId - session being reported.
   * @returns running compressions and whether a step is currently blocked.
   */
  snapshot(sessionId: string): { active: ActiveCompression[]; blockingSince: number | null; blockingReason: BlockingReason | null; pendingBranch: string | null; generation: number } {
    const active: ActiveCompression[] = []
    for (const entry of this.running.values()) {
      if (entry.sessionId !== sessionId) continue
      const { sessionId: _sessionId, ...rest } = entry
      active.push(rest)
    }
    const blocked = this.blocked.get(sessionId)
    return {
      active,
      blockingSince: blocked?.since ?? null,
      blockingReason: blocked?.reason ?? null,
      pendingBranch: this.pendingBranch.get(sessionId) ?? null,
      generation: this.generation.get(sessionId) ?? 0,
    }
  }

  /** Pending-map key for one step. */
  private pendingKey(sessionId: string, turn: number, step: number): string {
    return `${sessionId}:${turn}:${step}`
  }

  /**
   * Accumulate the per-request saving produced by earlier compressions.
   * @param sessionId - session that answered a request.
   * @param seq - the answering assistant message sequence.
   * @param time - its append time.
   * @param model - the route that answered.
   */
  private async account(session: Session, seq: number, time: number, model: string, surface: Surface): Promise<void> {
    const sessionId = session.id
    // Accounting continues asynchronously: the session can be disposed and its id
    // reused while the record loads, and this continuation must not then write
    // into the replacement's record or advance its bookkeeping.
    const generation = this.generation.get(sessionId) ?? 0
    const stale = (): boolean => (this.generation.get(sessionId) ?? 0) !== generation
    const record = await this.store.load(sessionId)
    if (stale()) return
    if (record.entries.length === 0) return
    // A replayed or restored assistant event must not be counted twice.
    if (seq <= record.countedThroughSeq) return
    const { bucket } = priceAt(model, this.config.prices.get(), time, this.config)
    const hit = bucket.hit / 1_000_000
    // The first replay carries the rewrite as brand-new input, so its tokens come
    // out of the miss bucket; every later request has that tail cached already.
    const miss = bucket.miss / 1_000_000
    // A substitution is a pure function of the record and the surface, so an
    // entry saved money in this request exactly when its target is still on the
    // surface ahead of this response. Deriving the answer here instead of
    // reading a mutable "last derivation" snapshot keeps the attribution tied to
    // the request being answered rather than to whatever derived history last.
    // Widened to plain numbers: the surface stores branded SessionSeqs while the
    // record stores the same values unbranded.
    // Select first, mutate only inside the store's callback: the store snapshots
    // the record before running it, so a failed write rolls the increments back
    // instead of leaving savings that were never persisted.
    // Survivability, not a global epoch: a compaction that leaves the target in
    // place keeps the rewrite in force, so it must keep being credited.
    // Credit exactly what the answered request carried: the applied map is
    // recorded by the same call that built its prompt, so a rewrite the request
    // did not actually use — because its message no longer carries reasoning,
    // say — is never paid for.
    // Credit exactly what the answered request carried: the applied map is
    // recorded by the same call that built its prompt. Without one (no request
    // was derived here yet, e.g. right after a reload) fall back to the surface
    // view, which is the weaker but still bounded answer.
    // Bind the credit to the request that carried these rewrites: pick the newest
    // derivation that happened at or before this response's seq.
    // The answered request's own record: the newest one taken before this response.
    // It is not filtered against the current node set, because a projection that
    // lands while the response is in flight must not retroactively revoke a saving
    // the request really carried (acceptance D-1(4)).
    const history = this.applied.get(sessionId) ?? []
    const carried = history.filter(at => at.afterSeq <= seq).pop()?.ids
    // A record that exists but describes another surface (the history moved after
    // the request) may not credit anything: the request demonstrably predates that
    // move, so this answer is not evidence that the rewrite shipped. Only a
    // session with no recorded request at all falls back to the surface itself.
    const counting = record.entries.filter(entry =>
      (carried === undefined ? (history.length === 0 ? this.survives(session, entry, surface) : false) : carried.has(entry.id))
      && entry.targetSeq < seq
      && entry.appliedAt <= time
      && entry.savedTokensPerRequest > 0)
    if (counting.length === 0) return
    const counted = new Set(counting.map(entry => entry.id))
    await this.store.update(sessionId, (current) => {
      if (stale()) return
      for (const entry of current.entries) {
        if (!counted.has(entry.id)) continue
        // The first replay carries the rewrite as brand-new input, and so does the
        // first replay after a compaction changed the prefix: both come out of the
        // miss bucket. Every other request has that tail cached already.
        const first = entry.liveRequests === 0 || entry.repriceMiss === true
        entry.liveSaved += entry.savedTokensPerRequest * (first ? miss : hit)
        entry.liveRequests += 1
        if (entry.repriceMiss === true) delete entry.repriceMiss
      }
      current.countedThroughSeq = seq
    })
  }

  /** Close the live epoch when the host compacted the history. */
  private async onCompaction(session: Session): Promise<void> {
    const sessionId = session.id
    const generation = this.generation.get(sessionId) ?? 0
    const stale = (): boolean => (this.generation.get(sessionId) ?? 0) !== generation
    await this.store.load(sessionId)
    if (stale()) return
    // As with accounting, every mutation happens inside the store's callback so
    // the pre-write snapshot covers it and a failed write cannot leave an epoch
    // that was never persisted.
    await this.store.update(sessionId, (current) => {
      if (stale()) return
      current.epoch += 1
      // Only entries whose target did not survive this compaction lose their
      // live savings. A failed compaction replaces nothing, and a partial one
      // may well leave the rewritten node in place — freezing those would keep
      // substituting a rewrite while refusing to count what it saves.
      const surface = this.surfaceOf(session)
      for (const entry of current.entries) {
        if (entry.inactive === true) continue
        if (this.survives(session, entry, surface)) {
          // The rewrite survives, but the prefix before it changed, so the next
          // request pays for that region again.
          entry.repriceMiss = true
          continue
        }
        entry.frozenSaved += entry.liveSaved
        entry.liveSaved = 0
        // `liveRequests` is deliberately kept: it is the per-request count that
        // turns a per-request reduction into the lifetime token total, which must
        // survive the rewrite it came from.
        entry.inactive = true
      }
    })
  }

  /**
   * Run one distillation: open the compression session, ask the distiller,
   * truncate for replay, and persist the decision.
   * @param session - session whose reasoning is rewritten.
   * @param target - the staged assistant message.
   */
  private async compress(session: Session, target: PendingTarget): Promise<void> {
    // Work started for a previous generation of this session id must not write
    // into the current one's record or hand its rewrite to the panel.
    const generation = this.generation.get(session.id) ?? 0
    const stale = (): boolean => (this.generation.get(session.id) ?? 0) !== generation
    const reasoning = reasoningOf(target.content)
    // Captured before any replacement: a later in-place edit must retire this entry.
    const originalHash = hashText(reasoning)
    const attemptKey = this.pendingKey(session.id, target.turn, target.step)
    const abandonedNow = (): boolean => this.abandoned.has(attemptKey)
    const maxInput = target.rule.maxInputChars
    // The reasoning is the *subject* of the rewrite, not context: silently sending
    // only its prefix would let the distiller drop decisions it never saw while
    // the entry still reports a saving measured on the full text. A step too large
    // to hand over whole is left alone instead.
    if (maxInput > 0 && reasoning.length > maxInput) {
      this.ctx.logger.info(
        'reasoning-distill: leaving %s undistilled (reasoning %d chars exceeds the %d-char input limit)',
        target.model, reasoning.length, maxInput,
      )
      return
    }
    const input = reasoning
    const userText = this.buildRequestText(session, target, input)
    const prompt = this.config.prompt.get() || DEFAULT_PROMPT
    const startedAt = Date.now()
    const opened = await this.createCompressionSession(session, prompt, userText)
    // The three shapes an attempt can be recorded in; the audit-link marker needs
    // the same ids, and it can arrive before the entry exists.
    const failedId = `${target.seq}-${startedAt}-failed`
    const skippedId = `${target.seq}-${startedAt}-skipped`
    const adoptedId = `${target.seq}-${startedAt}`
    const sessionId = opened.id
    if (!opened.ok) {
      this.ctx.logger.warn(
        'reasoning-distill: compressing without an auditable session for %s (create=%s)',
        target.model, sessionId === '' ? 'failed' : 'partial',
      )
    }
    const outcome = await this.runDistiller(target, prompt, userText, startedAt)
    // Every path records which compression session this attempt opened.
    outcome.run.sessionId = sessionId
    if (outcome.failed || outcome.text === undefined) {
      // Timeout or empty answer: give up on this compression outright. The
      // reasoning stays raw and nothing is substituted, so the session keeps
      // working; the failed compression session stays for inspection, and the
      // attempt is still recorded so its spending is not invisible.
      this.failCompressionSession(sessionId, outcome.run.error ?? 'distiller returned no text', session.id, failedId, generation)
      this.ctx.logger.warn(
        'reasoning-distill: gave up on %s after %dms: %s',
        target.model, outcome.run.durationMs, outcome.run.error ?? 'empty answer',
      )
      if (stale()) return
      await this.store.update(session.id, (record) => {
      if (stale()) return
      record.entries = record.entries.filter(item => item.targetSeq !== target.seq || (item.failed !== true && item.skipped !== true))
        record.entries.push({
          id: failedId,
          targetSeq: target.seq,
          targetMessageId: target.messageId,
          targetBlockIndex: target.reasoningBlockIndex,
          turn: target.turn,
          step: target.step,
          provider: target.provider,
          model: target.model,
          originalChars: reasoning.length,
          originalTokens: estimateChars(reasoning.length),
          distilledText: '',
          distilledChars: 0,
          distilledTokens: 0,
          savedTokensPerRequest: 0,
          distill: outcome.run,
          cacheBreakTokens: 0,
          cacheBreakCost: 0,
          epoch: this.store.peek(session.id)?.epoch ?? 0,
          appliedAt: Date.now(),
          liveSaved: 0,
          liveRequests: 0,
          frozenSaved: 0,
          originalHash,
          failed: true,
          ...sessionId === '' || !opened.durable || this.takeAuditBroken(session.id, failedId) ? { sessionMissing: true as const } : {},
        })
      })
      return
    }
    const ceiling = target.rule.maxOutputChars
    const distilled = ceiling > 0 && outcome.text.length > ceiling ? outcome.text.slice(0, ceiling) : outcome.text
    const originalTokens = estimateChars(reasoning.length)
    const distilledTokens = estimateChars(distilled.length)
    const saved = originalTokens - distilledTokens
    if (saved < target.rule.minSavedTokens) {
      this.ctx.logger.info(
        'reasoning-distill: skipped rewrite for %s (saved %d < %d tokens)',
        target.model, saved, target.rule.minSavedTokens,
      )
      // Settle the audit session under the id this attempt will actually be
      // recorded as: a late failure must mark that entry, not the adopted one.
      this.finishCompressionSession(sessionId, distilled, outcome.run.provider, outcome.run.model, session.id, skippedId, generation)
      // The distiller was paid for, so the attempt is recorded even though the
      // rewrite was not adopted: otherwise the report understates the spend and
      // hides the audit session entirely.
      if (stale()) return
      await this.store.update(session.id, (record) => {
      if (stale()) return
      record.entries = record.entries.filter(item => item.targetSeq !== target.seq || (item.failed !== true && item.skipped !== true))
        record.entries.push({
          id: skippedId,
          targetSeq: target.seq,
          targetMessageId: target.messageId,
          targetBlockIndex: target.reasoningBlockIndex,
          turn: target.turn,
          step: target.step,
          provider: target.provider,
          model: target.model,
          originalChars: reasoning.length,
          originalTokens,
          distilledText: '',
          distilledChars: distilled.length,
          distilledTokens,
          savedTokensPerRequest: 0,
          distill: outcome.run,
          cacheBreakTokens: 0,
          cacheBreakCost: 0,
          epoch: this.store.peek(session.id)?.epoch ?? 0,
          appliedAt: Date.now(),
          liveSaved: 0,
          liveRequests: 0,
          frozenSaved: 0,
          originalHash,
          skipped: true,
          ...sessionId === '' || !opened.durable || this.takeAuditBroken(session.id, skippedId) ? { sessionMissing: true as const } : {},
        })
      })
      return
    }
    this.finishCompressionSession(sessionId, distilled, outcome.run.provider, outcome.run.model, session.id, adoptedId, generation)
    // A substitution moves everything from the rewritten message to the end of
    // the next request out of the cache-hit prefix and into miss pricing.
    const { bucket: prices } = priceAt(target.model, this.config.prices.get(), startedAt, this.config)
    // No cache break is charged. The rewrite always lands before the message is
    // ever replayed (`settle` awaits it at the next `agent/pre-step`), so the
    // rewritten message and everything after it are *new* input on that request:
    // they would be billed as a miss with or without this plugin. The prefix
    // before the rewrite is identical either way and stays a hit. What changes is
    // only how many tokens sit in the new tail — which is why the first counted
    // request is priced at the miss rate in `account()`.
    // (A rewrite that landed *after* a replay would invalidate a warm prefix; that
    // is unreachable while the pre-step await holds, and restoring this model
    // would require attributing the suffix again.)
    const cacheBreakTokens = 0
    const cacheBreakCost = 0
    const entry: StoredEntry = {
      id: adoptedId,
      targetSeq: target.seq,
      targetMessageId: target.messageId,
      targetBlockIndex: target.reasoningBlockIndex,
      turn: target.turn,
      step: target.step,
      provider: target.provider,
      model: target.model,
      originalChars: reasoning.length,
      originalTokens,
      distilledText: distilled,
      distilledChars: distilled.length,
      distilledTokens,
      savedTokensPerRequest: saved,
      distill: outcome.run,
      cacheBreakTokens,
      cacheBreakCost,
      epoch: (this.store.peek(session.id)?.epoch ?? 0),
      appliedAt: Date.now(),
      liveSaved: 0,
      liveRequests: 0,
      frozenSaved: 0,
      originalHash,
      ...sessionId === '' || !opened.durable || this.takeAuditBroken(session.id, adoptedId) ? { sessionMissing: true as const } : {},
    }
    if (abandonedNow()) {
      // The wait bound expired while this attempt was still finishing. It must not
      // adopt its rewrite, but the spend is real: record it as an abandoned attempt
      // so the report shows why nothing was substituted.
      await this.store.update(session.id, (record) => {
        if ((this.generation.get(session.id) ?? 0) !== generation) return
        record.entries = record.entries.filter(item => item.targetSeq !== entry.targetSeq || (item.failed !== true && item.skipped !== true))
        // Same id as the adopted entry would have had: the audit settlement and
        // its auditBroken marker both refer to that id, so a late flush failure
        // must still find this row and mark it.
        record.entries.push({ ...entry, failed: true, distill: { ...entry.distill, error: 'abandoned before the wait bound expired' } })
      })
      return
    }
    await this.store.update(session.id, (record) => {
      if (stale()) return
      record.entries = record.entries.filter(item => item.targetSeq !== entry.targetSeq)
      record.entries.push(entry)
    })
    // The rewrite is now durable and worth writing into the history itself: the
    // panel asks the selected backend to do that, then stops this turn.
    if (!stale() && !abandonedNow() && this.config.enabled.get() && this.config.rewriteBackend.get() !== '') {
      this.pendingBranch.set(session.id, entry.id)
    }
    this.ctx.logger.info(
      'reasoning-distill: %s %s reasoning %d -> %d tokens, saved %.1f 元 per later request',
      target.provider, target.model, originalTokens, distilledTokens,
      (saved * prices.hit) / 1_000_000,
    )
  }

  /** Build the user message handed to the distiller. */
  private buildRequestText(session: Session, target: PendingTarget, reasoning: string): string {
    const parts = ['## Original reasoning', reasoning]
    // Everything the step produced after the reasoning is context, not content to
    // rewrite: without it the distiller cannot tell what the reasoning was
    // answering, and it would drop decisions that only make sense next to the
    // text or the calls they led to.
    const visible = target.content.filter((block): block is { type: 'text'; text: string } => block.type === 'text' && block.text.trim() !== '')
    if (visible.length > 0) {
      parts.push('## Assistant text from this step (context only, never copy)')
      for (const block of visible) parts.push(block.text)
    }
    // The step's tool calls always travel: they are what the reasoning decided,
    // and the distiller needs them to keep the decisions that led somewhere.
    const calls = target.content.filter(block => block.type === 'tool-call')
    if (calls.length > 0) {
      parts.push('## Tool calls from this step (context only, never copy)')
      for (const call of calls) {
        parts.push(`- ${call.name}(${call.arguments})`)
      }
      if (target.rule.includeToolResults) {
        const results = collectToolResults(session, target.turn, target.step)
        if (results.length > 0) {
          // Tool results can be far larger than the reasoning they justify; bound
          // this block on its own so one huge output cannot dominate the input.
          const cap = target.rule.maxInputChars
          parts.push('## Tool results (context only, never copy)')
          // Each result is its own context block, so the limit applies to each of
          // them rather than to their concatenation.
          parts.push(results.map(result => cap > 0 && result.length > cap ? result.slice(0, cap) : result).join('\n\n'))
        }
      }
    }
    return parts.join('\n\n')
  }

  /** Ask the configured distiller for the rewritten reasoning. */
  private async runDistiller(
    target: PendingTarget,
    prompt: string,
    userText: string,
    startedAt: number,
  ): Promise<DistillOutcome> {
    const route = target.rule.distiller
    const run: DistillRun = {
      sessionId: '',
      provider: route.provider,
      model: route.model,
      effort: route.effort,
      requestText: userText,
      responseText: '',
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      cost: 0,
      period: priceAt(route.model, this.config.prices.get(), startedAt, this.config).period,
      durationMs: 0,
    }
    let reported = false
    let receivedChars = 0
    try {
      const assembler = new BlockAssembler()
      const timeout = target.rule.timeoutMs
      const signal = timeout > 0 ? AbortSignal.timeout(timeout) : undefined
      const stream = this.ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.effort as never,
        maxTokens: 32768,
        system: prompt,
        messages: [createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } })],
        signal,
      })
      let sawFinish = false
      let timedOut = false
      const collect = (async (): Promise<void> => {
        for await (const chunk of stream) {
          // Count as it arrives: a stream that throws part-way still generated
          // this much output, and the estimate must reflect the spend.
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') receivedChars += chunk.text.length
          if (chunk.type === 'finish') sawFinish = true
          assembler.push(chunk)
        }
      })()
      if (target.rule.timeoutMs > 0) {
        // An adapter that ignores its abort signal would otherwise keep this
        // attempt alive past its own timeout and let a stale result land after the
        // next request has already been sent. The deadline therefore ends the
        // attempt here, and whatever the abandoned stream does later is ignored.
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<void>(resolve => {
          timer = setTimeout(() => { timedOut = true; resolve() }, target.rule.timeoutMs)
          timer.unref?.()
        })
        await Promise.race([collect, deadline])
        if (timer !== undefined) clearTimeout(timer)
        if (timedOut) {
          // Bounded drain: a cooperative adapter hands over the usage it already
          // produced (the attempt was paid for and must be reported), while the
          // text is discarded below. The abandoned stream can no longer affect
          // anything after this point.
          await Promise.race([
            collect.catch(() => undefined),
            new Promise<void>(resolve => { const timer = setTimeout(resolve, 250); timer.unref?.() }),
          ])
          run.error = `timed out after ${target.rule.timeoutMs}ms`
        }
      } else {
        await collect
      }

      // An interrupted or truncated stream can still carry text, but that text is
      // not a distillation and must never be substituted into the history:
      // `aborted`/`error` were cut off by failure, `max-tokens` was cut off mid
      // answer. Unknown kinds keep working, as the finish union is extensible.
      const finish = assembler.finish.kind
      // A stream that ended without a finish event leaves the assembler at its
      // default kind, which says nothing about success: partial text must not be
      // substituted for a real distillation.
      // A timed-out attempt is never usable, whatever the adapter eventually sent.
      const usable = !timedOut && sawFinish && finish !== 'aborted' && finish !== 'error' && finish !== 'max-tokens'
      let blocks: ContentBlock[] = []
      try { blocks = assembler.blocks() } catch { blocks = [] }
      const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('').trim()
      run.responseText = usable ? text : ''
      // A timeout set earlier in this attempt is the real reason; the assembler's
      // default finish kind must not relabel it as a plain stream end.
      const failureReason = run.error
      const usage: TokenUsage | undefined = assembler.usage
      if (usage !== undefined) {
        run.inputTokens = usage.inputTokens
        run.cacheReadTokens = usage.cacheReadTokens ?? 0
        run.cacheWriteTokens = usage.cacheWriteTokens ?? 0
        run.outputTokens = usage.outputTokens
        reported = true
      }
      if (!usable) run.error = `distiller stream ended as ${finish}`
      if (failureReason !== undefined) run.error = failureReason
    } catch (error: unknown) {
      run.error = error instanceof Error ? error.message : String(error)
    }
    if (!reported) {
      // An interrupted or failed call reports no usage, but it did send a prompt
      // and usually generated something. Estimate so the spending is visible
      // instead of silently reading as zero.
      run.inputTokens = Math.ceil((prompt.length + userText.length) / 4)
      run.outputTokens = Math.ceil(receivedChars / 4)
      run.estimated = true
    }
    const prices = priceAt(route.model, this.config.prices.get(), startedAt, this.config).bucket
    run.cost = (
      // `inputTokens` counts uncached input only; cache writes are billed like
      // uncached input here, which matches DeepSeek and stays conservative for
      // adapters that charge a premium for them.
      (run.inputTokens + run.cacheWriteTokens) * prices.miss
      + run.cacheReadTokens * prices.hit
      + run.outputTokens * prices.out
    ) / 1_000_000
    run.durationMs = Date.now() - startedAt
    if (run.error !== undefined || run.responseText.length === 0) return { run, failed: true }
    return { text: run.responseText, run, failed: false }
  }

  /** Open the visible one-shot session that holds the compression conversation. */
  private async createCompressionSession(
    parent: Session,
    prompt: string,
    userText: string,
  ): Promise<{ id: string; ok: boolean; durable: boolean }> {
    let id = ''
    let durable = false
    try {
      const created = this.ctx.sessions.create(undefined, {
        meta: {
          parentSession: parent.id as SessionId,
          createdAt: Date.now(),
          ...parent.header.cwd === undefined ? {} : { cwd: parent.header.cwd },
        },
      })
      // Record the id before any append: if an append throws, the session still
      // exists and the entry must be able to name and open it.
      id = created.id
      this.ownSessions.add(id)
      // Claim the durable log writer BEFORE the first append: the backend routes
      // a published session's events to its writer by id, so events appended
      // earlier would never reach disk.
      // A session whose durable writer did not attach is not an audit log: its
      // events live only in memory and vanish on restart, so the entry must say
      // so (`sessionMissing`) instead of promising a readable record. The
      // compression itself still proceeds — the full text always lives on the
      // entry, which is the real record.
      if (this.attachWriter !== undefined) {
        try {
          await this.attachWriter(created)
          durable = true
        } catch (error: unknown) {
          this.ctx.logger.warn('reasoning-distill: audit session %s stays in-memory only: %o', id, error)
          durable = false
        }
      } else {
        durable = false
      }
      created.append('turn/start', { turn: 1 })
      created.append('step/start', { turn: 1, step: 1 })
      created.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `${prompt}\n\n---\n\n${userText}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      return { id, ok: true, durable }
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: could not open a compression session: %o', error)
      return { id, ok: false, durable: false }
    }
  }

  /**
   * Close a compression session that produced nothing usable, marking the turn
   * failed so the record says why instead of showing a placeholder answer.
   * @param sessionId - compression session, or an empty string when none opened.
   * @param reason - operator-facing failure text.
   */
  private failCompressionSession(sessionId: string, reason: string, ownerId: string, entryId: string, origin: number): void {
    if (sessionId === '') return
    const session = this.ctx.sessions.get(sessionId as SessionId)
    if (session === undefined) return
    try {
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { message: reason, code: 'REASONING_DISTILL_FAILED' } },
      })
      void this.ctx.sessions.flush(session).catch((error: unknown) => {
        this.ctx.logger.warn('reasoning-distill: failed-compression session %s did not persist: %o', session.id, error)
        void this.markAuditUndurable(ownerId, entryId, origin)
      })
    } catch (error: unknown) {
      // The append itself can fail (a writer that rejects mid-stream): the audit
      // link is then no more durable than a failed flush, so say so too.
      this.ctx.logger.warn('reasoning-distill: could not settle a failed compression session: %o', error)
      void this.markAuditUndurable(ownerId, entryId, origin)
    }
  }

  /** Close the compression session with the distiller's answer. */
  private finishCompressionSession(sessionId: string, text: string, provider: string, model: string, ownerId: string, entryId: string, origin: number): void {
    if (sessionId === '') return
    const session = this.ctx.sessions.get(sessionId as SessionId)
    if (session === undefined) return
    try {
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text }],
          source: { provider, model },
        }),
        stream: [],
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      void this.ctx.sessions.flush(session).catch((error: unknown) => {
        this.ctx.logger.warn('reasoning-distill: audit session %s did not persist: %o', session.id, error)
        void this.markAuditUndurable(ownerId, entryId, origin)
      })
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: could not settle a compression session: %o', error)
      void this.markAuditUndurable(ownerId, entryId, origin)
    }
  }
}

/** Collect this step's tool results as plain text. */
/**
 * Work out what a compression wait is holding up: the step after a tool call, a
 * fresh user message, or anything else.
 * @param session - session entering its pre-step boundary.
 * @returns the blocking reason the UI names.
 */
function blockingReason(session: Session): BlockingReason {
  try {
    let last: { type: string; data: unknown } | undefined
    for (const event of session.ownEvents()) last = event as { type: string; data: unknown }
    if (last === undefined) return 'other'
    // A fresh user message is waiting; that is a new turn held by the compression.
    if (last.type === 'user/message') return 'user'
    // Otherwise the step that just ended is the one being held. If it ran tools,
    // its results are what the next request is waiting to carry forward.
    if (last.type !== 'step/end') return 'other'
    const ended = last.data as { turn?: number; step?: number }
    for (const event of session.ownEvents()) {
      if (event.type !== 'tool/result') continue
      const data = event.data as { turn?: number; step?: number }
      if (data.turn === ended.turn && data.step === ended.step) return 'tool'
    }
    return 'other'
  } catch {
    return 'other'
  }
}

/**
 * Whether a child at this depth is inside a switch's reach (`0` = no limit).
 * @param depth - the child's delegation depth, 0 for a top-level session.
 * @param maxDepth - the configured cap.
 * @returns true when distillation may apply.
 */
/**
 * The abort signal for a branch hand-off.
 *
 * A configured `0` means the wait is unbounded: no signal is passed, so the
 * request runs until the backend answers.
 * @param timeoutMs - configured timeout in milliseconds.
 * @returns fetch options carrying a signal, or nothing when unbounded.
 */
function branchSignal(timeoutMs: number, turn?: AbortSignal): { signal?: AbortSignal } {
  if (turn === undefined) return timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}
  return timeoutMs > 0
    ? { signal: AbortSignal.any([turn, AbortSignal.timeout(timeoutMs)]) }
    : { signal: turn }
}

/** Index of the message's reasoning block, or -1 when it carries none. */
function reasoningBlockIndexOf(content: readonly ContentBlock[] | undefined): number {
  if (content === undefined) return -1
  return content.findIndex(block => block.type === 'reasoning' && typeof (block as { text?: string }).text === 'string')
}

function withinDepth(depth: number, maxDepth: number): boolean {
  if (!(maxDepth > 0)) return true
  // An unidentified child still counts as a direct one rather than depth 0, so
  // a cap of 1 never silently disables every child.
  return (depth > 0 ? depth : 1) <= maxDepth
}

function collectToolResults(session: Session, turn: number, step: number): string[] {
  const out: string[] = []
  for (const event of session.ownEvents()) {
    if (event.type !== 'tool/result') continue
    const data = event.data as unknown as { turn?: number; step?: number; message?: { content?: readonly ContentBlock[] } }
    if (data.turn !== turn || data.step !== step) continue
    const text = (data.message?.content ?? [])
      .map(block => (block.type === 'text' ? block.text : JSON.stringify(block)))
      .join('\n')
    if (text.trim().length > 0) out.push(text)
  }
  return out
}

/**
 * Clone one assistant message with its reasoning replaced by the distilled text.
 *
 * Every reasoning block in the message is folded into a single rewrite, because
 * the distillation input and the saved-token count both cover all of them. The
 * replay metadata is rebuilt to match the new block positions, and each written
 * reasoning block is replayed with no payload at all: a signature describes the
 * exact text it was issued for, every adapter names that field differently
 * (`signature`, `thinkingSignature`, `thoughtSignature`, `redacted`), and a
 * signature replayed next to different text is worse than none.
 * @param message - original assistant message.
 * @param text - distilled reasoning.
 * @returns the substituted message, or undefined when it has no reasoning.
 */
/**
 * Text of the reasoning blocks a message carries, in order.
 * @param message - derived message.
 * @returns the joined reasoning text.
 */
function reasoningTextOf(message: Message): string {
  return message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('\n')
}

/**
 * Cheap stable digest of reasoning text, used to retire a rewrite whose source
 * changed under it.
 * @param text - the reasoning text.
 * @returns a short hex digest.
 */
function hashText(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) | 0
  return `${hash >>> 0}:${text.length}`
}

function withDistilledReasoning(message: Message, text: string): Message | undefined {
  if (message.role !== 'assistant') return undefined
  const replay = replayBlocksOf(message.source)
  const content: ContentBlock[] = []
  const keptReplay: unknown[] = []
  const written: number[] = []
  let replaced = false
  for (const [index, block] of message.content.entries()) {
    if (block.type !== 'reasoning') {
      content.push(block)
      keptReplay.push(replay === undefined ? undefined : replay[index])
      continue
    }
    if (replaced) continue
    replaced = true
    written.push(content.length)
    content.push({ type: 'reasoning', text })
    keptReplay.push(replay === undefined ? undefined : replay[index])
  }
  if (!replaced) return undefined
  const source = message.source as { provider: string; model: string; replayState?: unknown }
  const next = {
    ...message,
    content,
    source: {
      ...message.source,
      provider: source.provider,
      model: source.model,
      ...replay === undefined ? {} : { replayState: scrubbedReplay(source.replayState, keptReplay, written) },
    },
  }
  // freezemessage keeps the durable message's identity, so derived history does
  // not mint a new id every time it is derived.
  return freezeMessage(next as unknown as Message) as Message
}

/**
 * Read the replay block list out of one message source.
 * @param source - assistant message source.
 * @returns the blocks, or undefined when the source carries no envelope.
 */
function replayBlocksOf(source: unknown): unknown[] | undefined {
  const envelope = (source as { replayState?: unknown }).replayState
  if (envelope === null || typeof envelope !== 'object') return undefined
  const blocks = (envelope as { blocks?: unknown }).blocks
  return Array.isArray(blocks) ? blocks : undefined
}

/**
 * Rebuild replay metadata so rewritten reasoning blocks keep their positions but
 * lose every payload that described the original text.
 * @param replayState - original adapter replay state.
 * @param kept - replay entries aligned with the new content list.
 * @param written - positions in that list holding a rewrite.
 * @returns the replacement replay state.
 */
function scrubbedReplay(replayState: unknown, kept: readonly unknown[], written: readonly number[]): unknown {
  const envelope = replayState as Record<string, unknown>
  const blocks = kept.map((value, index) => written.includes(index) ? { type: 'reasoning' } : value)
  return { ...envelope, blocks }
}

/** Re-exported for the report module. */
export type { SessionRecord }
