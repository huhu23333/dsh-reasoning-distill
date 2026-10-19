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
import type { Session, SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: these packages own the `agent/pre-step` and `subagent/descriptor`
// declarations that this plugin's event handlers are typed against.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'

import { backendById, backendUnusable, branchBackendBlocksSubagents, missingBackendFixup, rewriteRequest, type BackendFixup } from './backends.ts'
import { detectHostPatch, rewriteEntryPoint } from './host-patch.ts'
import { resolveRule, type Config, type ModelRule } from './config.ts'
import { subagentKindsOffPatch } from './rule.ts'
import { priceAt } from './peak.ts'
import { DEFAULT_PROMPT, encloseDistillationData, looksLikeFinalReply } from './prompt.ts'
import type { SessionRecord, SidecarStore, StoredEntry } from './store.ts'
import type { ActiveCompression, BlockingReason, DistillRun, HostPatchStatus } from './shared.ts'
import { entryInForceHere, exceedsContextCap } from './shared.ts'

/**
 * One request's view of the surface: which node seqs exist, and where each lands
 * in the derived message list. Captured at the event being accounted, because a
 * later compaction must not retroactively decide what an earlier request saved.
 */
interface Surface {
  nodes: ReadonlySet<number>
  slots: ReadonlyMap<number, number>
}

/** Optional host services must not trigger Cordis's uninjected-property guard. */
function optionalService<T>(ctx: Context, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

/** User-supplied ratios: 0.6 tokens per CJK code point, 0.3 otherwise. */
export function estimateTextTokens(text: string): number {
  let units = 0
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    units += (cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7af)
      || (cp >= 0x20000 && cp <= 0x2fa1f) ? 2 : 1
  }
  return Math.round(units * 0.3)
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
  /** Estimated token count of the staged reasoning. */
  reasoningTokens: number
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
   * Why one session's last observed step did not become a distillation.
   *
   * Staging declines for reasons that are otherwise invisible from outside: a rule that is off for
   * this session's kind, a threshold the reasoning did not reach, an interrupted step, or a session
   * this plugin never attached. The report carries the last one, so "it never triggers" is
   * answerable without reading a terminal.
   */
  private readonly lastDecision = new Map<string, { at: number; turn: number; step: number; reason: string }>()

  /**
   * Conversation identity last seen for one id: its session id plus the header's creation stamp.
   *
   * A delegated (subagent) conversation is disposed and entered again as its turns run, so the host
   * hands this plugin a new Session object for the *same* conversation repeatedly. The generation
   * exists so one conversation's work cannot land in a different one that reused the id, so it has to
   * follow the conversation rather than the object: an object swap that keeps this identity is the
   * same conversation and must not invalidate work already running for it.
   */
  private readonly conversationOf = new Map<string, string>()

  /** Generation an id held when its conversation was disposed, so a re-entry can restore it. */
  private readonly disposedAt = new Map<string, { identity: string; generation: number }>()
  /**
   * Sessions whose record cannot be read right now. Distillation is skipped for
   * them rather than spending money on a result that could not be stored; every
   * pre-step retries the read, so this clears itself once the record is back.
   */
  private readonly storageBroken = new Set<string>()
  /**
   * The rewrite awaiting a hand-off, per session: the entry whose distilled text
   * some backend should write into the history. The panel picks it up, asks the
   * backend after the original turn reaches idle; it never rejects that turn.
   */
  private readonly pendingBranch = new Map<string, string>()
  /** Conversations a hand-off replaced that the host would not archive yet. */
  private readonly pendingArchive = new Set<string>()
  /** An existing turn finishing before its one idle-phase branch attempt. */
  private readonly deferredBranch = new Set<string>()
  /** One derivation per agent/request boundary may own request accounting. */
  private readonly expectRequest = new Set<string>()
  /** Deadline belongs to the current pending read, not the session's lifetime. */
  private readonly loadStarted = new Map<string, { at: number; work: Promise<void> }>()
  /** Per-compression wait bound: its rule's distillation timeout, 0 = unbounded. */
  private readonly waitBound = new Map<string, { timeoutMs: number; launchedAt: number }>()
  /** Entries already charged the miss price, keyed `sessionId:entryId`. */
  private readonly missCharged = new Set<string>()
  /** Attempts whose wait bound expired: their adopted result must not land late. */
  private readonly abandoned = new Set<string>()
  /** Timers that would mark an attempt abandoned; cleared once it settles. */
  private readonly abandonTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * Branch hand-off outcomes that could not be written, keyed `sessionId:entryId`.
   *
   * Only the *note* is retried: re-posting the backend request would create a
   * second branch, so the pending marker is not kept for this.
   */
  private readonly owedHandoffNotes = new Map<string, { entryId: string; outcome: { state: 'created' | 'failed' | 'skipped'; branchId?: string; error?: string; at: number }; order: number }>()
  /** Invocation order of hand-off attempts (owed notes are memory-only). */
  private readonly handoffOrder = new Map<string, number>()
  /** Latest successfully committed attempt per entry in this process. */
  private readonly committedHandoffOrder = new Map<string, number>()
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
   * The unwrapped per-event derivation, per attached session object.
   *
   * `deriveMessages()` is built on `deriveEventMessage()`, and compaction reads the per-event
   * accessor directly, so both seams have to answer with the same content. The raw function is
   * kept here rather than on the session because this plugin's own checks — which entries are in
   * force, what a compaction would summarize — must read the log's message, never the message
   * this plugin produced from it.
   */
  private readonly rawDeriveEventMessage = new WeakMap<object, (event: SessionEvent) => Message | null>()

  /**
   * Whether this engine still rewrites prompts. Unloading flips it off instead
   * of unwrapping every session, so no session object is retained by a registry
   * (a strong map here would pin every session the plugin ever saw).
   */
  private active = true

  /**
   * Whether the stored backend has been checked against the profile's plugin list yet.
   *
   * The check is about the selection, not about any one turn, so it belongs to the first pre-step
   * of the process and to no other — a later turn must not pay for it again.
   */
  private backendChecked = false

  /** This host's in-place patch verdict, computed at most once per process. */
  private hostPatch: HostPatchStatus | undefined

  /**
   * Commits {@link BackendFixup} to the settings document. Absent when the host has no settings
   * service, and then a missing backend can only be reported, never acted on.
   */
  private writeFixup: ((fixup: BackendFixup) => Promise<void>) | undefined

  /**
   * @param ctx - host context carrying the session store, LLM seam, and logger.
   * @param config - live plugin configuration.
   * @param store - sidecar store.
   */
  /**
   * @param ctx - host context.
   * @param config - live plugin configuration.
   * @param store - sidecar store.
   * @param archive - archive one session on the host, when the host offers it. Injected so
   *   tests never touch a workspace registry.
   * @param activePlugins - the profile's active plugin entries, or undefined when they cannot be
   *   read. Read once, at the first pre-step, to recognize a backend whose plugin is gone.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly store: SidecarStore,
    private readonly archive: ((sessionId: string) => Promise<void>) | undefined = undefined,
    private readonly activePlugins: (() => Promise<readonly string[] | undefined>) | undefined = undefined,
  ) {}

  /** Attach every observer, hook, and existing-session wrap. */
  start(): void {
    for (const session of this.ctx.sessions.list()) this.attach(session)
    this.ctx.on('session/created', (session: Session) => {
      try { this.attach(session) } catch (error: unknown) {
        this.ctx.logger.warn('reasoning-distill: session attachment failed: %o', error)
      }
    })
    this.ctx.on('session/event', (session: Session, event: { type: string; seq: number; time: number; data: unknown }) => {
      try {
        this.observe(session, event)
      } catch (error: unknown) {
        this.ctx.logger.warn('reasoning-distill: observation failed: %o', error)
      }
      // A conversation whose running work refused the archive is retried here: its work
      // settling is exactly the moment the host will accept the archive.
      if (this.current.get(session.id) === session && this.pendingArchive.has(session.id)) void this.archiveSuperseded(session.id)
    })
    // Await any distillation queued by the previous step before the next request
    // is assembled, so a compression lands before the reasoning would be resent.
    this.ctx.effect(() => () => this.deactivate())
    // A disposed compression session must be forgotten: otherwise the set grows
    // for the process lifetime, and a later user session that happens to reuse
    // the id would be treated as plugin-owned and never observed.
    this.ctx.on('session/disposed', (session: Session) => {
      try { this.forgetSession(session) } catch (error: unknown) {
        this.ctx.logger.warn('reasoning-distill: session disposal failed: %o', error)
      }
    })
    this.ctx.on('agent/pre-step', async (payload, next) => {
      try {
        // Started here — it acts on the first pre-step of the process, whatever this turn decides —
        // because the stored selection can name a backend whose plugin this process never loaded.
        const backendCheck = this.checkBackendOnce()
        const continueOriginal = await (async (): Promise<boolean> => {
          // `attach` preloads the sidecar fire-and-forget, so on a resumed session
          // the first request could otherwise be assembled from raw reasoning while
          // the read is still in flight. Single-flight makes this join that read.
          // The host passes the turn's signal, but its event declaration does not
          // always carry it, so read it defensively rather than trusting the type.
          const session = payload.agent.session
          // A queued pre-step from a session object that a successor has replaced must
          // not act for the new one. Only a *different* known object counts: an id the
          // engine never attached (resumed before this plugin loaded) is left alone.
          if (this.replaced(session)) return true
          // Attach a session this plugin has not seen yet, after the replacement check so an
          // obsolete pre-step can never overwrite a successor. A delegated (subagent) session can
          // reach this hook without its creation ever being delivered here, and this registry is
          // what makes the engine the authority on it: staging, the derived-message wrapper and the
          // report route's lookup all key off it.
          if (this.sessionFor(session.id) !== session) this.attach(session)
          const signal = (payload as { signal?: AbortSignal }).signal
          // A stalled sidecar read must not outlive a stop either: the host only looks
          // at its signal once this handler returns.
          let load = this.loadStarted.get(session.id)
          if (load === undefined) {
            const work = this.ensureLoaded(session)
            load = { at: Date.now(), work }
            this.loadStarted.set(session.id, load)
            const currentLoad = load
            void work.then(() => {
              if (this.loadStarted.get(session.id) === currentLoad) this.loadStarted.delete(session.id)
            })
          }
          const backstop = this.ruleBackstopMs()
          const loaded = await this.waitUntil(load.work, signal,
            backstop > 0 ? load.at + backstop : undefined)
          if (!loaded) {
            if (signal?.aborted || this.replaced(session)) return true
            // A stalled step/end gate must not launch after the raw request escapes.
            for (const key of this.inFlight.keys()) {
              if (key.startsWith(`${session.id}:`)) this.abandoned.add(key)
            }
            return true
          }
          // The read is awaited: the id can be replaced underneath it, and then this
          // obsolete pre-step must not settle, hand off or arm anything.
          if (signal?.aborted || this.replaced(session)) return true
          // The backend check is joined here, so the decision this turn is about to make reads
          // the switch it may have closed. It waits behind the synchronous prologue above, which
          // an overlapping pre-step has to be able to join before this call yields.
          await backendCheck
          // A stop must end the wait, not queue behind it: the host only looks at its
          // signal once this handler returns.
          void this.flushOwedNotes(session, signal)
          if (!await this.settle(session, signal)) return true
          // The wait is even longer than the read: check again before acting for it.
          if (this.replaced(session)) return true
          // The compression is settled: hand this turn over *now*. The branch backend
          // reads the source log without taking its maintenance phase, so the branch
          // exists within this pre-step; the original turn is then rejected and the
          // remaining steps run in the branch with the compressed context.
          if (!signal?.aborted) {
            const handedOver = await this.handOffToBranch(session, signal)
            if (handedOver) return false
            // Nothing armed, or the backend refused: the original carries on. A
            // compression that lands after this turn's last pre-step still gets its
            // hand-off from the deferred idle path when a later step arrives.
            if (this.pendingBranch.has(session.id) && typeof payload.agent.whenIdle === 'function') {
              this.scheduleBranchAtIdle(payload.agent, session)
            }
          }
          return true
        })()
        if (!continueOriginal) return { kind: 'reject' }
      } catch (error: unknown) {
        this.ctx.logger.warn('reasoning-distill: pre-step failed; continuing original turn: %o', error)
      }
      return next()
    })
    this.ctx.on('agent/request', async (payload, next) => {
      const session = payload.agent.session
      const proposed = await next()
      if (this.active && !this.replaced(session)) this.expectRequest.add(session.id)
      return proposed
    })
  }

  /**
   * Register the write that clears a backend the profile no longer carries.
   *
   * The host reads its configuration through volatile references, which have no public setter, so
   * these settings are cleared the way the panel clears them: through the settings service, one
   * write that updates the running reference and the stored document together.
   * @param write - commits a {@link BackendFixup}.
   */
  useSettingsWriter(write: (fixup: BackendFixup) => Promise<void>): void {
    this.writeFixup = write
  }

  /**
   * Whether this host carries the in-place patch, checked once per process.
   *
   * The answer is a real self-check (see {@link detectHostPatch}), not a version comparison: the
   * patch is optional, so the only truthful question is whether the entry point exists and works.
   * Memoized because the route answers it on every panel probe and the startup check asks it too.
   * @returns the patch verdict.
   */
  hostPatchStatus(): HostPatchStatus {
    this.hostPatch ??= detectHostPatch()
    return this.hostPatch
  }

  /**
   * One session this engine observed, by id.
   *
   * The plugin's own registry, not the session store: a delegated (subagent) session lives in its
   * agent's scope, so `ctx.sessions.get(id)` at this plugin's root cannot resolve it, while the
   * engine attached it the moment the host created it — which is also what proves this plugin may
   * answer for it at all. Returns undefined for an id this engine never saw.
   * @param sessionId - session to resolve.
   * @returns the attached session, when there is one.
   */
  sessionFor(sessionId: string): Session | undefined {
    return this.current.get(sessionId)
  }

  /**
   * How many sessions this engine has attached; for diagnostics only.
   * @returns the size of the attachment registry.
   */
  sessionCount(): number {
    return this.current.size
  }

  /**
   * Clear a selected backend this host can no longer drive, the moment that becomes known.
   *
   * Same outcome as the startup check (see {@link checkBackend}), reached from the apply path when
   * the patch turns out to be gone: a stored selection that cannot hand a rewrite over must not
   * outlive what made it valid, and the master switch that needs it goes with it.
   */
  private async clearUnusableBackend(reason: string): Promise<void> {
    const backend = this.config.rewriteBackend.get() ?? ''
    if (backend === '') return
    if (this.writeFixup === undefined) {
      this.ctx.logger.warn('reasoning-distill: %s, and the host exposes no settings service to clear %s', reason, backend)
      return
    }
    try {
      const fixup = missingBackendFixup(backend, this.config.enabled.get() === true)
      if (fixup === undefined) return
      await this.writeFixup(fixup)
      this.ctx.logger.warn('reasoning-distill: %s; cleared the rewrite backend selection', reason)
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: %s; clearing the selection failed: %o', reason, error)
    }
  }

  /**
   * Run the backend check once per process, at the first pre-step.
   *
   * Nothing else in this plugin may fail because of it: the check reports, and a host that cannot
   * answer for its profile is not a reason to break the turn that happened to be first.
   */
  private async checkBackendOnce(): Promise<void> {
    if (this.backendChecked) return
    this.backendChecked = true
    try {
      await this.checkBackend()
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: backend check failed: %o', error)
    }
  }

  /**
   * Clear the stored backend once this host can no longer drive it.
   *
   * The backends answer on routes the host cannot reach — an in-place backend's route sits behind
   * `/api/*`, where the shell demands the browser's own credentials — so the host recognizes a
   * backend it cannot use from the profile's active plugin list and from its own registry instead.
   * A stored selection it cannot drive cannot hand a rewrite over, and it outlives whatever made
   * it valid, so the selection itself is cleared along with the master switch that needs it; this
   * is the same outcome the panel reaches with its probe.
   */
  private async checkBackend(): Promise<void> {
    const backend = this.config.rewriteBackend.get() ?? ''
    const active = this.activePlugins === undefined ? undefined : await this.activePlugins()
    // The patch self-check answers for the backends this plugin serves itself; a companion
    // backend is judged by the profile's plugin list, exactly as before.
    const patch = this.hostPatchStatus()
    const hostPatch = patch.patched && patch.functional
    let fixup: BackendFixup | undefined
    if (backendUnusable(backend, active, hostPatch)) {
      const plugin = backendById(backend)?.plugin
      if (backendById(backend)?.hostPatch === true) {
        this.ctx.logger.warn('reasoning-distill: rewrite backend %s needs the host patch (patched=%s functional=%s%s); clearing the selection', backend, patch.patched, patch.functional, patch.detail === undefined ? '' : ', ' + patch.detail)
      } else if (plugin === undefined) {
        this.ctx.logger.warn('reasoning-distill: rewrite backend %s is not one this build can drive; clearing the selection', backend)
      } else {
        this.ctx.logger.warn('reasoning-distill: rewrite backend %s needs plugin %s, which the profile no longer lists; clearing the selection', backend, plugin)
      }
      fixup = missingBackendFixup(backend, this.config.enabled.get() === true)
    } else if (branchBackendBlocksSubagents(backend)) {
      // The switches cannot stay on under this backend: a hand-off inside a subagent ends that
      // child's turn without an answer. The panel pins them off while it is selected, and a
      // profile edited outside the panel — or one saved before this rule existed — still has to
      // be brought in line, at the same first-pre-step check that clears an unusable selection.
      fixup = subagentKindsOffPatch(this.config.defaultRule.get(), this.config.models.get())
      if (fixup !== undefined) {
        this.ctx.logger.warn('reasoning-distill: rewrite backend %s forks the conversation, which a delegation cannot follow; turning the subagent switches off', backend)
      }
    }
    if (fixup === undefined) return
    if (this.writeFixup === undefined) {
      this.ctx.logger.warn('reasoning-distill: the rewrite backend settings could not be cleared: the host exposes no settings service')
      return
    }
    try {
      await this.writeFixup(fixup)
      this.ctx.logger.info(fixup.rewriteBackend === ''
        ? fixup.enabled === undefined
          ? 'reasoning-distill: cleared the rewrite backend selection; the master switch was already off'
          : 'reasoning-distill: cleared the rewrite backend selection and turned the master switch off'
        : 'reasoning-distill: turned the subagent switches off for a backend that cannot carry a delegation')
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: the rewrite backend settings could not be cleared: %o', error)
    }
  }

/**
   * Write one adopted rewrite into the conversation's history, now.
   *
   * The step that ends a turn is the one whose rewrite used to wait for a next pre-step, and a
   * delegated conversation is disposed as soon as that turn ends -- so that rewrite had no writer
   * at all until the conversation ran again, and the last reasoning before a reply stayed raw. A
   * live session is written through the host entry point; a conversation that is no longer live is
   * written through its *stored* artifact. Either way the entry is marked, so the same in-place
   * rewrite is never written twice.
   * @param session - session the rewrite belongs to.
   * @param entry - the entry, already durable in the record.
   * @param generation - generation the compression started under.
   * @returns whether the history now carries the distilled text.
   */
  private async settleInPlaceEntry(session: Session, entry: StoredEntry): Promise<boolean> {
    if (entry.targetMessageId === '') return false
    const request = {
      seq: entry.targetSeq as SessionSeq,
      messageId: entry.targetMessageId,
      blockIndex: entry.targetBlockIndex ?? 0,
      text: entry.distilledText,
    }
    // The object in the registry, not the one this compression captured: a delegated conversation is
    // entered again between its turns, and the current object owns the log the request will replay.
    const live = this.sessionFor(session.id)
    if (live !== undefined) {
      try {
        const rewrite = rewriteEntryPoint(live)
        if (rewrite !== undefined) {
          rewrite(request)
          await this.ctx.sessions.flush(live)
          await this.markInPlaceApplied(session.id, entry.id)
          return true
        }
      } catch (error: unknown) {
        this.ctx.logger.debug('reasoning-distill: in-place write for %s on its live session failed: %o', session.id, error)
      }
    }
    // Deliberately live-only. Persistence can open a stored session for writing, but that takes
    // write ownership behind the session store's back: the host's own handle keeps its revision and
    // its cross-process lock, and an artifact rewritten underneath it is exactly how a live
    // conversation gets torn down -- a delegated session whose agent then vanishes from the roster
    // the main agent addresses it by. An owed rewrite of a conversation that is not live waits for
    // the pre-step that makes it live again (`settleOwedInPlace`), which is safe and already works.
    return false
  }

  /** Mark one entry as written into the history by this engine, clearing a stale failure note. */
  private async markInPlaceApplied(sessionId: string, entryId: string): Promise<void> {
    const at = Date.now()
    await this.store.update(sessionId, current => {
      for (const item of current.entries) {
        if (item.id !== entryId) continue
        item.inPlaceApplied = at
        if (item.handoff?.state === 'failed') delete item.handoff
      }
    })
  }
  /**
   * Write back the distilled text of every rewrite this conversation still owes.
   *
   * The panel drives the write-back for a live conversation, but a *delegated* conversation is
   * disposed between its turns: the report shows an owed entry, the panel posts, and by then there
   * is no live session to write into -- "unknown session", which is terminal for an in-place
   * rewrite (it is not idempotent), so the original reasoning stayed in the history for good. The
   * engine holds both the text and the record, so it settles what is owed the moment the
   * conversation is live again, before the request that would replay the raw reasoning.
   * @param session - session that is live right now.
   */
  private async settleOwedInPlace(session: Session): Promise<void> {
    if (backendById(this.config.rewriteBackend.get() ?? '')?.kind !== 'in-place') return
    const rewrite = rewriteEntryPoint(session)
    if (rewrite === undefined) return
    const record = this.store.peek(session.id)
    if (record === undefined) return
    const owed = record.entries.filter(entry =>
      entry.failed !== true
      && entry.skipped !== true
      && entry.inPlaceApplied === undefined
      // A failed hand-off note is *not* terminal for an in-place rewrite. Its usual cause is the
      // panel posting between two of a delegated conversation's turns, when there was no session to
      // write into -- the step that ends a turn is always owed at the moment the turn ends, so those
      // were exactly the rewrites that never landed. The engine is the writer of record here.
      && (entry.handoff === undefined || entry.handoff.state === 'failed'))
    if (owed.length === 0) return
    const seqs = new Set<number>(session.ownEvents().map(event => event.seq as number))
    let wrote = 0
    for (const entry of owed) {
      if (entry.targetMessageId === '' || !seqs.has(entry.targetSeq)) continue
      const generation = this.generation.get(session.id) ?? 0
      if (await this.settleInPlaceEntry(session, entry)) wrote += 1
    }
    if (wrote === 0) return
    this.ctx.logger.info('reasoning-distill: wrote back %d owed in-place rewrite(s) for %s', wrote, session.id)
  }
  /**
   * Make sure one session's sidecar is in memory before its request is built.
   */
  private async ensureLoaded(session: Session): Promise<void> {
    // The read is awaited, so its outcome belongs to the generation that asked for
    // it: a stale result must neither mark a successor's storage broken nor clear
    // a real failure and let it spend money on an unreadable record.
    const generation = this.generation.get(session.id) ?? 0
    const stale = (): boolean => this.replaced(session) || (this.generation.get(session.id) ?? 0) !== generation
    try {
      await this.store.load(session.id)
      if (stale()) return
      this.storageBroken.delete(session.id)
      // A conversation that is live again settles what it still owes, before the request that would
      // otherwise replay the raw reasoning.
      await this.settleOwedInPlace(session)
      if (stale()) return
    } catch (error: unknown) {
      // A sidecar that cannot be read disables the feature for this session: it
      // must never stop the conversation itself, and — since the result could
      // not be recorded — it must not spend money on a distillation either.
      // Every pre-step retries the read, so this clears itself once the record
      // is readable again.
      if (stale()) return
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
    // Disposal invalidates the generation: work already running for this id captured the old number,
    // so its continuations (accounting, compaction, compression, hand-off) stop writing. A delegated
    // conversation is disposed and entered again every turn, though, and killing its work at each
    // turn boundary is exactly what made a subagent compress only its first step. So the bump is
    // *deferred*: the identity is remembered here and a re-entry of the same conversation restores
    // the number, while a different conversation reusing the id still bumps because its identity
    // does not match.
    const identity = conversationIdentity(session)
    if (identity === undefined) {
      // Nothing to recognize a re-entry by (an older header): keep the conservative rule.
      this.generation.set(session.id, (this.generation.get(session.id) ?? 0) + 1)
    } else {
      this.disposedAt.set(session.id, { identity, generation: this.generation.get(session.id) ?? 0 })
    }
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
   * record. The sidecar store's in-memory copy of the record goes with it.
   * @param sessionId - session whose per-id state should go.
   */
  private releaseSession(sessionId: string): void {
    const prefix = `${sessionId}:`
    for (const map of [this.pending, this.inFlight, this.running, this.waitBound] as Array<Map<string, unknown>>) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) map.delete(key)
      }
    }
    // Hand-off bookkeeping is keyed `sessionId:entryId` too. Dropping it here is what
    // stops a disposed session's unwritten note from being retried forever, and keeps
    // the note plus its ordering counters from outliving the session.
    for (const map of [
      this.owedHandoffNotes, this.handoffOrder, this.committedHandoffOrder,
    ] as Array<Map<string, unknown>>) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) map.delete(key)
      }
    }
    this.pendingBranch.delete(sessionId)
    // These two are keyed by the id alone, so a successor that reuses the id must not
    // inherit them: the archive retry (`observe` retries it on every event) would
    // otherwise archive the brand-new conversation on its very first event, and the
    // stale idle guard would swallow its one branch-at-idle attempt for good.
    this.pendingArchive.delete(sessionId)
    this.deferredBranch.delete(sessionId)
    this.expectRequest.delete(sessionId)
    this.loadStarted.delete(sessionId)
    this.blocked.delete(sessionId)
    this.applied.delete(sessionId)
    this.rawDerive.delete(sessionId)
    for (const key of [...this.missCharged]) {
      if (key.startsWith(prefix)) this.missCharged.delete(key)
    }
    for (const key of [...this.abandoned]) {
      if (key.startsWith(prefix)) this.abandoned.delete(key)
    }
    for (const [key, timer] of [...this.abandonTimers]) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer)
        this.abandonTimers.delete(key)
      }
    }
    this.storageBroken.delete(sessionId)
    // The record itself is the worst of it: it holds the original reasoning text and
    // the distiller's request and response. Dropping the store's copy here is what keeps
    // a long-lived host from pinning every conversation it has ever seen — text included
    // — for the life of the process. A later `load` reads the file again, so nothing on
    // disk changes.
    this.store.forget(sessionId)
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
    // A branch backend forks the conversation, and the host writes a delegation's parent relation
    // when the child agent is created, so the fork cannot adopt it: a hand-off inside a subagent
    // would end that child's turn without an answer. No stored switch may enable those kinds while
    // such a backend is selected — the panel pins them off and the startup check writes that down,
    // and this refuses them outright so a hand-edited profile cannot break a delegation either.
    if (branchBackendBlocksSubagents(this.config.rewriteBackend.get() ?? '')) return false
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
  /**
   * Whether a session object has been superseded by another object on its id.
   *
   * Ids the engine never attached (a session resumed before this plugin loaded)
   * are not replacements and must keep working.
   * @param session - the object an event or hook is acting for.
   * @returns true when a different object now owns that id.
   */
  private replaced(session: Session): boolean {
    const attached = this.current.get(session.id)
    return attached !== undefined && attached !== session
  }

  private attach(session: Session): void {
    if (this.wrapped.has(session)) return
    this.wrapped.add(session)
    // A session object is attached once, but the *id* can come back: either the same conversation
    // entered again (a delegated turn does exactly that) or a cleared/re-created conversation that
    // reuses the id. Everything keyed by that id belongs to the previous *conversation*, and a later
    // compression must not write into a different one's record or block its requests -- so the
    // generation follows the conversation, not the object.
    const identity = conversationIdentity(session)
    const returned = identity === undefined ? undefined : this.disposedAt.get(session.id)
    const same = identity !== undefined
      && (this.conversationOf.get(session.id) === identity || returned?.identity === identity)
    if (same) {
      // Entered again: restore the generation the conversation had before its disposal, so work
      // already running for it stays valid, and keep the id's state instead of releasing it.
      if (returned?.identity === identity) this.generation.set(session.id, returned.generation)
    } else {
      this.generation.set(session.id, (this.generation.get(session.id) ?? 0) + 1)
      this.releaseSession(session.id)
    }
    this.disposedAt.delete(session.id)
    if (identity !== undefined) this.conversationOf.set(session.id, identity)
    this.current.set(session.id, session)
    const original = session.deriveMessages.bind(session)
    const engine = this
    this.rawDerive.set(session.id, original)
    // The per-event accessor is the *other* half of the same seam: a compaction summarizes the
    // conversation by deriving one event at a time (`deriveEventMessage`), not by asking for the
    // message list, so a rewrite only the list accessor knew about used to be summarized from the
    // raw reasoning — with the original reasoning's replay payload attached. Answering both
    // accessors from one rule is what keeps "what the request carries" and "what a compaction
    // reads" the same bytes.
    const rawMessage = session.deriveEventMessage.bind(session)
    this.rawDeriveEventMessage.set(session, rawMessage)
    Object.defineProperty(session, 'deriveEventMessage', {
      configurable: true,
      writable: true,
      value: function deriveEventMessageDistilled(this: Session, event: SessionEvent): Message | null {
        const message = rawMessage(event)
        if (message === null || !engine.active || engine.replaced(this)) return message
        return engine.rewriteDerivedMessage(this, event, message) ?? message
      },
    })
    Object.defineProperty(session, 'deriveMessages', {
      configurable: true,
      writable: true,
      value: function deriveMessagesDistilled(this: Session): Message[] {
        const messages = original()
        // A loaded plugin must not keep rewriting prompts after it is unloaded, and
        // a session object a successor has replaced must not be rewritten at all:
        // its stale turn would otherwise receive another generation's rewrite.
        if (!engine.active || engine.replaced(this)) return messages
        const result = engine.applyRewrites(this, messages)
        // Remember exactly what this request carried: accounting settles against
        // it rather than re-deriving an answer from a later surface.
        // Only the first derivation after the agent/request waterfall completes
        // owns this request's accounting. A later viewer cannot overwrite it;
        // an interposed derivation before buildRequest remains indistinguishable
        // without a host freeze callback.
        // The object must still be the one attached for that id: a replaced session
        // keeps its wrapper, and its stale surface must not be recorded as the
        // successor's request.
        if (engine.expectRequest.has(this.id) && !engine.replaced(this)) {
          // agent/request has completed; consume its one boundary derivation so a
          // later viewer cannot replace the frozen request's accounting record.
          // An intervening plugin deriving before buildRequest remains indistinguishable.
          engine.expectRequest.delete(this.id)
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
   * Whether a recorded rewrite is still the one this replay would use.
   *
   * Substitution is a pure function of the surface, so the same predicate decides
   * whether a rewrite is applied *and* whether it may be credited. That keeps
   * "still in force" and "still earning" from drifting apart: an entry that
   * survives a partial compaction keeps earning, and one whose target is gone
   * stops on both counts.
   * @param session - session being replayed.
   * @param entry - the recorded compression.
   * @param surface - the surface snapshot, when the caller already has one.
   * @returns true when this entry still replaces a replayed message.
   */
  private survives(session: Session, entry: StoredEntry, surface?: Surface): boolean {
    const event = session.eventAt(entry.targetSeq as Parameters<Session['eventAt']>[0])
    const message = event === undefined ? null : this.rawMessageOf(session, event)
    return this.survivesMessage(session, entry, message, surface)
  }

  /**
   * {@link survives} against a message the caller already derived.
   *
   * Both accessors judge an entry from the *log's* message, never from one this plugin rewrote:
   * a spliced branch holds the distilled text in its log, and the rewrite is in force there with
   * nothing left to replace.
   * @param session - session being replayed.
   * @param entry - the recorded compression.
   * @param message - the log's own message for this entry's target, or null when it derives none.
   * @param surface - the surface snapshot, when the caller already has one.
   * @returns true when this entry still replaces a replayed message.
   */
  private survivesMessage(session: Session, entry: StoredEntry, message: Message | null, surface?: Surface): boolean {
    // A rewrite handed off to a branch belongs to that branch: replaying this
    // conversation must show its own, pre-compression reasoning.
    if (!entryInForceHere(entry, String(session.id)) || entry.distilledText.length === 0) return false
    if (entry.inactive === true) return false
    const nodes = surface?.nodes ?? new Set<number>(session.surface.nodes)
    if (!nodes.has(entry.targetSeq)) return false
    const slots = surface?.slots ?? this.derivedIndex(session)
    if (!slots.has(entry.targetSeq)) return false
    // A projection can keep the seq while replacing the message, and a later step
    // can fold the reasoning block away; either way the rewrite would not apply,
    // so the entry must stop counting as alive.
    if (message === null || message.id !== entry.targetMessageId) return false
    if (withDistilledReasoning(message, entry.distilledText) === undefined) return false
    // The reasoning must still be the text this distillation came from: an edit in
    // place (same id, same seq) must not be silently overwritten by stale output.
    // The distilled text itself also qualifies: a branch inherits a log whose block was
    // already spliced to it, so the rewrite is in force there with nothing left to
    // replace — and it is the text the request carries.
    const currentReasoning = reasoningTextOf(message)
    if (entry.originalHash !== undefined
      && hashText(currentReasoning) !== entry.originalHash
      && currentReasoning !== entry.distilledText) return false
    return true
  }

  /**
   * What one entry does to one model-visible message, decided once for both accessors.
   *
   * `replace` is the rewrite this conversation carries and may be credited for; `scrub` is a
   * rewrite whose text the log already holds because an earlier branch spliced it in — the text
   * is already right, only the replay payload still describes the reasoning it replaced, and
   * nothing may be credited (that branch earned it); undefined leaves the message alone.
   * @param session - session whose surface is being read.
   * @param entry - the recorded compression to judge.
   * @param message - the log's own message for this entry's target.
   * @param surface - the surface snapshot, when the caller already has one.
   * @returns the decision, or undefined when this entry does not touch the message.
   */
  private rewriteKind(session: Session, entry: StoredEntry, message: Message, surface?: Surface): 'replace' | 'scrub' | undefined {
    if (this.survivesMessage(session, entry, message, surface)) return 'replace'
    if (entry.distilledText.length === 0 || message.role !== 'assistant') return undefined
    // The same identity rule `survivesMessage` applies: a projection can put a different message
    // at this seq, and its text merely happening to match is not this rewrite's business.
    if ((message as { id?: string }).id !== entry.targetMessageId) return undefined
    return reasoningTextOf(message) === entry.distilledText ? 'scrub' : undefined
  }

  /**
   * One event's message, rewritten when an entry covers it.
   *
   * This is the per-event half of the seam: `deriveMessages()` derives each node through this
   * accessor, and so does a compaction, so anything it should carry has to be decided here too.
   * @param session - session whose surface is being derived.
   * @param event - the event being derived.
   * @param message - its unmodified derived message.
   * @returns the rewritten message, or undefined when this event carries no rewrite.
   */
  private rewriteDerivedMessage(session: Session, event: SessionEvent, message: Message): Message | undefined {
    if (event.type !== 'assistant/message' || message.role !== 'assistant') return undefined
    const entry = this.entryForSeq(session, Number(event.seq))
    if (entry === undefined) return undefined
    if (this.rewriteKind(session, entry, message) === undefined) return undefined
    return withDistilledReasoning(message, entry.distilledText)
  }

  /**
   * The record's entry for one surface seq, the last one written winning.
   *
   * {@link applyRewrites} resolves entries the same way, so a seq carrying both a failed attempt
   * and the adopted rewrite is judged identically on both accessors.
   * @param session - session owning the record.
   * @param seq - surface sequence to look up.
   * @returns the entry, or undefined when no recorded rewrite targets it.
   */
  private entryForSeq(session: Session, seq: number): StoredEntry | undefined {
    const record = this.store.peek(session.id)
    if (record === undefined) return undefined
    let found: StoredEntry | undefined
    for (const entry of record.entries) if (entry.targetSeq === seq) found = entry
    return found
  }

  /** One event's message as the log derives it, never as this plugin rewrote it. */
  private rawMessageOf(session: Session, event: SessionEvent): Message | null {
    const raw = this.rawDeriveEventMessage.get(session)
    return raw === undefined ? session.deriveEventMessage(event) : raw(event)
  }

  /**
   * The surface as one request saw it: node seqs plus the derived positions.
   * @param session - session to snapshot.
   * @returns both views, computed from the same read of the surface.
   */
  private surfaceOf(session: Session): Surface {
    return { nodes: new Set<number>(session.surface.nodes), slots: this.derivedIndex(session) }
  }

  /**
   * Replace the reasoning of every compressed message in one derived list.
   *
   * The list is rewritten into a pure function of the log plus the ledger: every recorded entry
   * either applies its rewrite, only has its stale replay payload scrubbed, or has the log's own
   * message restored over a substitution a previous derivation cached.
   * @param session - session whose history is being derived.
   * @param messages - the derived messages, as the host produced them.
   * @returns the same array when nothing applies, else a rewritten copy.
   */
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
      const at = index.get(seq)
      if (at === undefined) continue
      const derived = messages[at]
      if (derived === undefined || derived.role !== 'assistant') continue
      // A projection can replace the content at this seq with a different
      // assistant message; its reasoning is not the reasoning this rewrite
      // distilled, so it must not be injected there.
      if ((derived as { id?: string }).id !== entry.targetMessageId) continue
      // The log's own message decides, never the one a previous derivation already rewrote:
      // the host caches derived messages per node, so a substitution made while an entry was
      // in force here would otherwise outlive the hand-off that moved it to its branch.
      const event = session.eventAt(seq as Parameters<Session['eventAt']>[0])
      const raw = event === undefined ? null : this.rawMessageOf(session, event)
      if (raw === null) continue
      const kind = this.rewriteKind(session, entry, raw, surface)
      if (kind === undefined) {
        // This conversation carries no rewrite here — a failed attempt, one a hand-off moved to
        // its branch, or a target the user has since edited. A derivation that ran while it was
        // still in force may have substituted this message, so the log's own text is restored.
        // Compared by text, not by object: projections may hand back a fresh message each read.
        if (reasoningTextOf(derived) === entry.distilledText) {
          out ??= [...messages]
          out[at] = raw
        }
        continue
      }
      const replaced = withDistilledReasoning(raw, entry.distilledText)
      if (replaced === undefined) continue
      out ??= [...messages]
      out[at] = replaced
      // Only a rewrite this conversation actually carries earns anything; scrubbing a spliced
      // log's replay payload writes nothing back and credits nothing.
      if (kind === 'replace') applied.set(entry.id, at)
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
   * Whether this conversation still has background work of its own.
   *
   * The host's job registry owns every background task — bash jobs and subagent runs
   * alike, keyed by their owning session — so one lookup answers both. Its `list` also
   * returns unowned jobs, which belong to nobody: the host's own activity predicate drops
   * them for the same question, and they stay reachable from any caller, so a branch would
   * not leave them behind. Counting them would pause every conversation while unrelated
   * work runs. A host without that service is never busy, and a read that fails must not
   * stop compression.
   * @param session - conversation being considered.
   * @returns whether work is running under it.
   */
  private busyWithWork(session: Session): boolean {
    // A branch backend applies a rewrite by forking the conversation, and the fork cannot take the
    // background work the conversation it replaces started with it. The option is therefore not
    // offered while one is selected, and the engine honours it as always on: a profile edited
    // outside the panel cannot leave such a branch mid-work either.
    if (!branchBackendBlocksSubagents(this.config.rewriteBackend.get() ?? '') && !this.config.skipWhileBusy.get()) return false
    const jobs = (this.ctx as unknown as { get(key: string): unknown }).get('jobs') as
      { list?(caller?: unknown): readonly { status?: string; owner?: string }[] } | undefined
    if (jobs?.list === undefined) return false
    const sessionId = String(session.id)
    try {
      return jobs.list(sessionId).some(job =>
        job.owner === sessionId && (job.status === 'running' || job.status === 'stopping'))
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: could not read the job list for %s: %o', session.id, error)
      return false
    }
  }

  /**
   * Why the staged step must not be distilled because the conversation is already
   * too full, or undefined when it may proceed.
   *
   * Occupancy is the host token meter's own measurement over the routed model's
   * declared context window — the same numbers its compaction trigger reads — so
   * the cap cannot drift from what the host considers full, and a compaction
   * lowers the percentage immediately. A host without the meter, without a
   * declared window, or with an unreadable route cannot answer; an unanswerable
   * cap never blocks a compression, because guessing is worse than the feature
   * being inert.
   * @param session - conversation the reasoning came from.
   * @param target - the staged step about to be distilled.
   * @returns the report reason code, or undefined when compression may run.
   */
  private async contextCapRefusal(session: Session, target: PendingTarget): Promise<string | undefined> {
    if (!target.rule.contextCap) return undefined
    const meter = optionalService<{ measure(session: Session): { totalTokens: number } }>(this.ctx, 'tokenMeter')
    if (meter === undefined) return undefined
    let contextWindow: number | undefined
    try {
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model)
      contextWindow = info.context?.contextWindow
    } catch (error: unknown) {
      this.ctx.logger.debug('reasoning-distill: no context capacity for %s/%s: %o', target.provider, target.model, error)
      return undefined
    }
    if (contextWindow === undefined || contextWindow <= 0) return undefined
    let totalTokens: number
    try {
      totalTokens = meter.measure(session).totalTokens
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: could not measure context pressure for %s: %o', session.id, error)
      return undefined
    }
    return exceedsContextCap(totalTokens, contextWindow, target.rule.maxContextPercent) ? 'context-cap' : undefined
  }

  /**
   * The backend's source-agent maintenance requires true idle. A pre-step always
   * runs inside a turn, so rejecting it before the POST would strand its claimed
   * input; instead complete that turn and create the branch at the first idle
   * boundary. This is a host lifecycle boundary, not an intermittent HTTP error.
   */
  private scheduleBranchAtIdle(agent: { whenIdle(): Promise<void>; status?: string }, session: Session): void {
    if (typeof agent.whenIdle !== 'function') return
    const entryId = this.pendingBranch.get(session.id)
    if (entryId === undefined || this.deferredBranch.has(session.id)) return
    if (backendById(this.config.rewriteBackend.get())?.kind !== 'branch') return
    this.deferredBranch.add(session.id)
    const generation = this.generation.get(session.id) ?? 0
    const begun = Date.now()
    const timeout = this.config.branchTimeoutMs.get()
    void (async () => {
      try {
        // whenIdle follows a newly claimed driver too. Never POST while the
        // source is active or once the hand-off deadline has passed.
        let idle = false
        if (timeout > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            idle = await Promise.race([
              agent.whenIdle().then(() => true),
              new Promise<false>(resolve => {
                timer = setTimeout(() => resolve(false), timeout)
                timer.unref?.()
              }),
            ])
          } finally { if (timer !== undefined) clearTimeout(timer) }
        } else { await agent.whenIdle(); idle = true }
        if (!this.active || this.replaced(session) || (this.generation.get(session.id) ?? 0) !== generation
          || this.pendingBranch.get(session.id) !== entryId) return
        if (!idle || (agent.status !== undefined && agent.status !== 'idle') || (timeout > 0 && Date.now() - begun >= timeout)) {
          await this.recordHandoffOrOwe(session.id, entryId, {
            state: 'skipped', error: 'branch hand-off skipped after the idle wait deadline', at: Date.now(),
          }, generation)
          this.pendingBranch.delete(session.id)
          return
        }
        // idle→maintenance Stop is a host no-op; the backend itself acquires
        // runMaintenance and checks its abort signal once it owns the phase.
        // A second maintenance claim here would make the backend reject.
        await this.handOffToBranch(session)
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error)
        await this.recordHandoffOrOwe(session.id, entryId, {
          state: 'failed', error: `idle branch operation failed (${detail}); no retry`, at: Date.now(),
        }, generation)
        if ((this.generation.get(session.id) ?? 0) === generation) this.pendingBranch.delete(session.id)
        this.ctx.logger.warn('reasoning-distill: deferred branch failed for %s: %o', session.id, error)
      } finally {
        if ((this.generation.get(session.id) ?? 0) === generation) this.deferredBranch.delete(session.id)
      }
    })()
  }

  /**
   * Copy one session's ledger onto a branch cut from it.
   *
   * The branch continues the same conversation (the splice keeps every sequence
   * number), so the same entries describe it. Best effort: a panel that cannot report
   * the hand-off must never fail the hand-off itself.
   * @param sourceId - session the branch was cut from.
   * @param branchId - branch session that was just created.
   */
  private async carryLedgerToBranch(sourceId: string, branchId: string): Promise<void> {
    try {
      const source = await this.store.load(sourceId)
      if (source.entries.length === 0) return
      await this.store.update(branchId, (record) => {
        record.epoch = source.epoch
        record.countedThroughSeq = source.countedThroughSeq
        record.entries = source.entries.map(entry => ({
          ...entry,
          // A rewrite handed off to *this* source is in force in the copy too: the copy
          // inherits the rewritten history. Re-point its destination, or the copy reads
          // it as applied elsewhere and stops substituting it — which is what happens on
          // every hand-off after the first.
          ...entry.handoff?.state === 'created' && entry.handoff.branchId === sourceId
            ? { handoff: { ...entry.handoff, branchId } }
            : {},
        }))
      })
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: branch %s could not inherit the ledger: %o', branchId, error)
    }
  }

  /**
   * Archive the conversation a successful hand-off replaced.
   *
   * Best effort by design: a host without a workspace registry, or one that refuses while
   * the conversation still has running work (its own fence), must never fail the hand-off.
   * A refusal is remembered so the archive is retried when that work settles — the
   * conversation stays listed meanwhile rather than being hidden with work still running.
   * @param sessionId - the replaced conversation.
   */
  private async archiveSuperseded(sessionId: string): Promise<void> {
    const archive = this.archive
    if (archive === undefined) return
    if (!this.config.archiveSuperseded.get()) {
      this.pendingArchive.delete(sessionId)
      return
    }
    const generation = this.generation.get(sessionId) ?? 0
    try {
      await archive(sessionId)
      if ((this.generation.get(sessionId) ?? 0) === generation) this.pendingArchive.delete(sessionId)
    } catch (error: unknown) {
      if (!this.active || (this.generation.get(sessionId) ?? 0) !== generation) return
      this.pendingArchive.add(sessionId)
      this.ctx.logger.warn(
        'reasoning-distill: %s is not archived yet (%s); it stays listed until its work ends',
        sessionId, error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** POST one branch operation at idle; never retry ambiguous non-idempotent requests. */
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
    const port = optionalService<{ port?: number }>(this.ctx, 'webServer')?.port
    if (typeof port !== 'number') {
      // The panel can drive an in-place backend itself, but a *branch* backend must
      // be driven from here: the panel's in-place path would create a branch and
      // then lose its id without ever switching to it. Record the failure instead
      // and carry on in the original conversation.
      this.ctx.logger.warn('reasoning-distill: no reachable web server port; cannot create a branch for %s', session.id)
      await this.untilSettled(this.recordHandoffOrOwe(session.id, entryId, {
        state: 'failed',
        error: 'the host has no reachable web server port, so no branch could be created',
        at: Date.now(),
      }, generation), signal)
      if ((this.generation.get(session.id) ?? 0) === generation) this.pendingBranch.delete(session.id)
      return false
    }
    const request = rewriteRequest(backend.id, session.id, {
      targetSeq: entry.targetSeq,
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
        await this.untilSettled(this.recordHandoffOrOwe(session.id, entryId, { state: 'failed', error: reason, at: Date.now() }, generation), signal)
        if ((this.generation.get(session.id) ?? 0) === generation) this.pendingBranch.delete(session.id)
        this.ctx.logger.warn('reasoning-distill: branch refused for %s (%s); carrying on in place', session.id, reason)
        return false
      }
      const recorded = await this.untilSettled(this.recordHandoffOrOwe(session.id, entryId, { state: 'created', branchId: created, at: Date.now() }, generation), signal)
      if ((this.generation.get(session.id) ?? 0) === generation) this.pendingBranch.delete(session.id)
      if (!recorded) {
        // The branch exists, but nothing the panel can see points at it. Ending the
        // turn here would strand the user in a stopped conversation with no route
        // to the branch, so the original continues instead.
        this.ctx.logger.warn('reasoning-distill: branch %s was created but not recorded; continuing in the original', created)
        return false
      }
      this.ctx.logger.info('reasoning-distill: handed %s over to branch %s', session.id, created)
      // The branch is this conversation with the rewrite in force, so it inherits the
      // ledger: without it the branch's panel reports nothing and loses the accounting
      // for the compression that created it.
      await this.carryLedgerToBranch(session.id, created)
      // Hiding the replaced conversation is the host's job, not a panel's: it must happen
      // even when nobody is looking at this conversation.
      await this.archiveSuperseded(session.id)
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
      await this.untilSettled(this.recordHandoffOrOwe(session.id, entryId, { state: 'failed', error: reason, at: Date.now() }, generation), signal)
      if ((this.generation.get(session.id) ?? 0) === generation) this.pendingBranch.delete(session.id)
      this.ctx.logger.warn('reasoning-distill: branch failed for %s (%s); carrying on in place', session.id, reason)
      return false
    }
  }

  /** Remember a hand-off note that could not be written, so the next pre-step retries it. */
  private oweNote(sessionId: string, entryId: string, outcome: { state: 'created' | 'failed' | 'skipped'; branchId?: string; error?: string; at: number }, order: number): void {
    const key = `${sessionId}:${entryId}`
    const existing = this.owedHandoffNotes.get(key)
    if (existing !== undefined && existing.order >= order) return
    this.owedHandoffNotes.set(key, { entryId, outcome, order })
    this.ctx.logger.warn('reasoning-distill: hand-off note for %s could not be written yet; it will be retried', entryId)
  }

  /** Assign each attempt its order before its asynchronous store write starts. */
  private nextHandoffOrder(sessionId: string, entryId: string): number {
    const key = `${sessionId}:${entryId}`
    const order = (this.handoffOrder.get(key) ?? 0) + 1
    this.handoffOrder.set(key, order)
    return order
  }

  /** Observe the write after a canceled wait, so a late failure remains retryable. */
  private async recordHandoffOrOwe(
    sessionId: string,
    entryId: string,
    outcome: { state: 'created' | 'failed' | 'skipped'; branchId?: string; error?: string; at: number },
    generation: number,
  ): Promise<boolean> {
    const order = this.nextHandoffOrder(sessionId, entryId)
    const recorded = await this.recordHandoff(sessionId, entryId, outcome, generation, undefined, order)
    if (!recorded && (this.generation.get(sessionId) ?? 0) === generation) this.oweNote(sessionId, entryId, outcome, order)
    return recorded
  }

  /** Retry every hand-off note still owed for a session (never the backend request). */
  private async flushOwedNotes(session: Session, signal?: AbortSignal): Promise<void> {
    const prefix = `${session.id}:`
    for (const [key, note] of [...this.owedHandoffNotes]) {
      if (!key.startsWith(prefix)) continue
      // A replay of an earlier invocation is not a new hand-off; it cannot
      // supersede a newer outcome that already committed while it was owed.
      if ((this.committedHandoffOrder.get(key) ?? 0) > note.order) {
        if (this.owedHandoffNotes.get(key) === note) this.owedHandoffNotes.delete(key)
        continue
      }
      const written = await this.untilSettled(
        this.recordHandoff(session.id, note.entryId, note.outcome, undefined, note.order),
        signal,
      )
      if (written === true && this.owedHandoffNotes.get(key) === note) this.owedHandoffNotes.delete(key)
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
    outcome: { state: 'created' | 'failed' | 'skipped'; branchId?: string; error?: string; at: number },
    generation?: number,
    replayOrder?: number,
    attemptOrder?: number,
  ): Promise<boolean> {
    const key = `${sessionId}:${entryId}`
    const order = replayOrder ?? attemptOrder ?? this.nextHandoffOrder(sessionId, entryId)
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
        // Replays keep the original invocation order. A newer committed
        // outcome wins even when an older owed replay reaches the queue later.
        if (replayOrder !== undefined && (this.committedHandoffOrder.get(key) ?? 0) > replayOrder) {
          written = true
          return
        }
        // store.update serializes by enqueue order: a later queued valid outcome
        // replaces the earlier one. `at` is for display only, not ordering; the
        // system clock can move backwards between real hand-off attempts.
        entry.handoff = outcome
        written = true
      })
      if (written && (this.committedHandoffOrder.get(key) ?? 0) < order) this.committedHandoffOrder.set(key, order)
      return written
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: could not record the hand-off: %o', error)
      return false
    }
  }

  /**
   * Apply one in-place rewrite to a live session, for this plugin's own rewrite route.
   *
   * The panel asks for this the way it asks any in-place backend: a POST carrying the session, the
   * target event and block, and the text. Unlike a companion backend, this one is ours, so the
   * message identity is taken from the sidecar record rather than from the request — a caller that
   * guessed a seq could otherwise aim the rewrite at a message the ledger never named — and the
   * patch is re-confirmed here, because a selection can outlive a reverted host.
   * @param request - session id, target event seq and block index, and the distilled text.
   * @returns the new text's seq, or why the rewrite was refused.
   */
  async applyInPlace(request: {
    sessionId: string
    eventSeq: number
    blockIndex: number
    text: string
  }): Promise<{ ok: true; seq: number } | { ok: false; error: string }> {
    const { sessionId, eventSeq, blockIndex, text } = request
    if (sessionId === '' || text === '') return { ok: false, error: 'sessionId and text are required' }
    if (!Number.isSafeInteger(eventSeq) || eventSeq < 0 || !Number.isSafeInteger(blockIndex) || blockIndex < 0) {
      return { ok: false, error: 'eventSeq and blockIndex must be non-negative integers' }
    }
    // The engine's registry first: a delegated session is not in the root store this context can
    // reach, and the registry holds exactly the objects this plugin attached.
    const session = this.sessionFor(sessionId) ?? this.ctx.sessions.get(sessionId as SessionId)
    if (session === undefined) return { ok: false, error: 'unknown session' }
    const rewrite = rewriteEntryPoint(session)
    if (rewrite === undefined) {
      await this.clearUnusableBackend('the host patch is not applied on this host')
      return { ok: false, error: 'the host patch is not applied on this host' }
    }
    // Load the record when the cache does not hold it: a delegated conversation is disposed and
    // entered again between its turns, its cached record goes with the disposal, and refusing a
    // recorded rewrite because this process happened not to have the file loaded yet left the
    // reasoning unrewritten while the panel had already given up on it.
    const record = this.store.peek(sessionId) ?? await this.store.load(sessionId)
    const entry = record.entries.find(item => item.targetSeq === eventSeq && item.targetBlockIndex === blockIndex)
    if (entry === undefined) return { ok: false, error: 'no recorded rewrite for that event and block' }
    if (entry.targetMessageId === '') return { ok: false, error: 'the recorded rewrite carries no message id' }
    try {
      rewrite({
        seq: eventSeq as SessionSeq,
        messageId: entry.targetMessageId,
        blockIndex,
        text,
      })
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    // The rewritten record reaches storage through the session's own sink; this barrier is what
    // lets the route answer "written" truthfully instead of promising a write that is still queued.
    try {
      await this.ctx.sessions.flush(session)
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: in-place rewrite for %s could not be flushed: %o', sessionId, error)
    }
    // Record the write host-side too: the panel remembers its own attempt, but another view, a
    // reload or a later pre-step must not repeat an in-place rewrite that already landed.
    const at = Date.now()
    await this.store.update(sessionId, current => {
      for (const item of current.entries) {
        if (item.targetSeq === eventSeq && (item.targetBlockIndex ?? 0) === blockIndex) item.inPlaceApplied = at
      }
    })
    return { ok: true, seq: eventSeq }
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
  async handoff(sessionId: string, cancel = true, error?: string, entryId?: string, generation?: number): Promise<{ ok: boolean; recorded: boolean }> {
    if (generation !== undefined && (this.generation.get(sessionId) ?? 0) !== generation) return { ok: false, recorded: false }
    // The panel tells us which attempt it is settling: a later compression can
    // install its own pending rewrite while an earlier request is still open, and
    // that successor must not be cleared or blamed. Not ours means we neither
    // clear it nor cancel a turn — but a *record-only* retry for our own entry is
    // still honoured, or a note that failed to be written once could never be
    // written at all.
    const pending = this.pendingBranch.get(sessionId)
    // Naming the attempt is what authorises a settle. An unnamed caller cannot be
    // settling *ours*, and treating it as ours is how a caller that guessed the
    // session id could clear a hand-off this plugin still owes and stop the turn
    // with it. With nothing pending there is nothing to clear or stop, which is
    // why that call stays the no-op it always was.
    const mine = entryId === undefined ? pending === undefined : pending === entryId
    if (!mine) {
      if (error === undefined || entryId === undefined) return { ok: false, recorded: false }
      const outcome = { state: 'failed' as const, error, at: Date.now() }
      const order = this.nextHandoffOrder(sessionId, entryId)
      const retried = await this.recordHandoff(sessionId, entryId, outcome, generation, undefined, order)
      if (!retried && (generation === undefined || (this.generation.get(sessionId) ?? 0) === generation)) {
        this.oweNote(sessionId, entryId, outcome, order)
      }
      return { ok: false, recorded: retried }
    }
    this.pendingBranch.delete(sessionId)
    // The failure note is part of the contract, not a nicety: say whether it landed
    // so the panel can ask again for the record (never for the backend request). A
    // record-only retry passes just the entry id, and is answered the same way.
    let recorded = true
    const target = pending ?? entryId
    if (error !== undefined && target !== undefined) {
      const outcome = { state: 'failed' as const, error, at: Date.now() }
      const order = this.nextHandoffOrder(sessionId, target)
      recorded = await this.recordHandoff(sessionId, target, outcome, generation, undefined, order)
      // The panel's own retry dies with its tab: keep the note host-side too, so
      // closing the panel cannot make a failed backend operation invisible.
      if (!recorded) this.oweNote(sessionId, target, outcome, order)
    }
    // `ok` means "this settle took effect": with nothing pending there was nothing
    // of ours to settle. Ending a turn is a side effect, not the outcome — an
    // in-place settle never stops the turn yet has still settled successfully.
    if (pending === undefined) return { ok: error !== undefined, recorded }
    if (!cancel) return { ok: true, recorded }
    // Only a hand-off this plugin is completing may stop a turn: cancelling would
    // otherwise let any same-origin caller end an unrelated session's turn.
    const agents = optionalService<{ get(id: string): { cancel(cause: { kind: string }): void } | undefined }>(this.ctx, 'agents')
    if (agents === undefined) {
      this.ctx.logger.warn('reasoning-distill: could not stop the turn for %s: agents service is unavailable', sessionId)
    } else {
      agents.get(sessionId)?.cancel({ kind: 'user' })
    }
    return { ok: true, recorded }
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
      if (this.rawMessageOf(session, event) === null) continue
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
    if (this.current.get(session.id) !== session) {
      // A step for a session this plugin never attached is exactly the "nothing ever triggers"
      // case; record it instead of returning in silence.
      if (event.type === 'assistant/message') this.noteDecision(session.id, event, 'session-not-attached')
      return
    }
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
          // Staging already recorded why *this* step was left alone, and that reason is the useful
          // one; "nothing staged" is only the summary for a step staging never saw.
          const why = this.lastDecision.get(session.id)
          if (why?.turn !== (data.turn ?? 0) || why?.step !== (data.step ?? 0)) {
            this.noteDecision(session.id, event, 'not-staged')
          }
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
          if (this.abandoned.has(key) || this.storageBroken.has(session.id)) {
            this.pending.delete(key)
            if (this.inFlight.get(key) === gate) this.inFlight.delete(key)
            this.noteDecision(session.id, event, 'abandoned-or-record-unreadable')
            return
          }
          // Occupancy is checked on the live measurement, before anything is paid:
          // once the conversation is close to the host's own compaction there is
          // too little runway left for a rewrite to earn back its distillation.
          const staged = this.pending.get(key)
          const cap = staged === undefined ? undefined : await this.contextCapRefusal(session, staged)
          if (cap !== undefined) {
            this.pending.delete(key)
            if (this.inFlight.get(key) === gate) this.inFlight.delete(key)
            this.ctx.logger.info(
              'reasoning-distill: %s keeps its reasoning: context occupancy is above %d%%',
              session.id, staged?.rule.maxContextPercent ?? 0,
            )
            this.noteDecision(session.id, event, cap)
            return
          }
          // A conversation whose own background work is still running is left alone when
          // the configuration asks for it: a branch created now would have to leave that
          // work behind, so this is treated as if the reasoning were under the threshold.
          if (this.busyWithWork(session)) {
            this.pending.delete(key)
            if (this.inFlight.get(key) === gate) this.inFlight.delete(key)
            this.ctx.logger.info('reasoning-distill: %s keeps its reasoning: background work is running', session.id)
            this.noteDecision(session.id, event, 'background-work-running')
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

  /** Record why one step did not become a distillation, for the report. */
  private noteDecision(sessionId: string, event: { data: unknown }, reason: string): void {
    const data = event.data as { turn?: number; step?: number } | undefined
    this.lastDecision.set(sessionId, { at: Date.now(), turn: data?.turn ?? 0, step: data?.step ?? 0, reason })
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
    const decline = (reason: string, model = ''): string => {
      this.noteDecision(session.id, event, reason)
      return model
    }
    const message = data.message as { id?: string; content?: ContentBlock[]; source?: { provider?: string; model?: string } } | undefined
    if (message === undefined || !Array.isArray(message.content)) return decline('message-unreadable')
    const model = message.source?.model ?? ''
    const provider = message.source?.provider ?? ''
    if (model === '') return decline('model-unknown')
    if (!this.config.enabled.get()) return decline('master-switch-off', model)
    // A distillation is only useful when some companion can write the result into
    // the session's own history. With no backend selected the panel forces the
    // master switch off; this is the belt-and-braces half of the same rule.
    // The same rule the settings page enforces: an unknown backend id (its plugin
    // was removed or renamed, or the config was edited by hand) must not enable
    // spending or substitution, because the result could never be written into the
    // history.
    if (backendById(this.config.rewriteBackend.get()) === undefined) return decline('no-backend', model)
    // A canceled step is not an answer: the host still appends `step/end` after
    // an abort (agent-loop), so staging here would spend a distillation on
    // partial reasoning and hold the next request until it finished. Accounting
    // still runs, because that response may have replayed earlier rewrites.
    if (data.interrupted === true) {
      this.ctx.logger.debug('reasoning-distill: skipping an interrupted step')
      return decline('interrupted', model)
    }
    const rule = resolveRule(model, this.config)
    if (!this.appliesTo(session, rule)) return decline(`rule-off-${this.kindOf(session)}`, model)
    const reasoning = reasoningOf(message.content)
    if (reasoning.trim().length === 0) return decline('no-reasoning', model)
    const tokens = estimateTextTokens(reasoning)
    if (tokens < rule.thresholdTokens) return decline('below-threshold', model)
    const hasToolCall = message.content.some(block => block.type === 'tool-call')
    if (!hasToolCall && !rule.includeFinalTurns) return decline('final-turn-excluded', model)
    // The replay folds every reasoning block of a message into one, while a branch
    // backend replaces a single block: compressing a multi-block message would
    // leave its other originals in the branch and leak uncompressed reasoning.
    const reasoningBlocks = (message.content ?? []).filter(block => block.type === 'reasoning').length
    if (reasoningBlocks !== 1) {
      this.ctx.logger.debug('reasoning-distill: leaving a %d-block reasoning message uncompressed', reasoningBlocks)
      return decline('multi-block-reasoning', model)
    }
    const key = this.pendingKey(session.id, data.turn ?? 0, data.step ?? 0)
    this.pending.set(key, {
      sessionId: session.id,
      seq: event.seq,
      reasoningTokens: tokens,
      reasoningBlockIndex: reasoningBlockIndexOf(message.content),
      turn: data.turn ?? 0,
      step: data.step ?? 0,
      messageId: message.id ?? '',
      provider,
      model,
      content: message.content,
      rule,
    })
    // Staged: the launch records what happens next, so a stale decline cannot be mistaken for
    // this step's outcome.
    this.lastDecision.delete(session.id)
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
    this.waitBound.set(key, { timeoutMs: target.rule.timeoutMs, launchedAt: Date.now() })
    this.running.set(key, {
      sessionId: session.id,
      turn: target.turn,
      step: target.step,
      provider: target.provider,
      model: target.model,
      distiller: `${target.rule.distiller.provider}/${target.rule.distiller.model}`,
      originalTokens: target.reasoningTokens,
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
      const timer = setTimeout(() => { this.abandoned.add(key) }, target.rule.timeoutMs)
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
    const startedAt = Date.now()
    const generation = this.generation.get(sessionId) ?? 0
    const current = (): boolean => this.active && (this.generation.get(sessionId) ?? 0) === generation
    const indicator = { since: startedAt, reason: blockingReason(session) }
    this.blocked.set(sessionId, indicator)
    try {
      // Waiting is the contract: the next request is assembled only once the
      // rewrite is in place. A compression whose rule sets a timeout is already
      // aborted by its own provider call, so the wait is bounded by exactly that
      // value as a backstop for adapters that ignore abort. `timeoutMs: 0` means
      // no limit, and then this genuinely waits until the compression ends.
      // Each compression is waited for up to *its own* bound, measured from when it
      // was launched: one unlimited attempt must not remove the bound of a bounded
      // one, and repeated pre-steps must not each restart the clock.
      // A gate snapshotted before its `launch` ran has no recorded bound of its own;
      // the configured limits still bound the wait (only an explicit 0 stays
      // unlimited), so a stalled launch cannot pin the pre-step forever.
      const backstop = this.ruleBackstopMs()
      const waits = mine.map(async ([key, promise]) => {
        const recorded = this.waitBound.get(key)
        const bound = recorded ?? (backstop > 0 ? { timeoutMs: backstop, launchedAt: this.loadStarted.get(sessionId)?.at ?? startedAt } : undefined)
        if (bound === undefined || bound.timeoutMs === 0) {
          await promise
          return
        }
        const remaining = bound.timeoutMs - (Date.now() - bound.launchedAt)
        if (remaining <= 0) {
          // Stop waiting *and* refuse a later adoption: otherwise a finally-launched
          // attempt could reset its own clock and land after the raw request.
          if (current()) this.abandoned.add(key)
          void promise.catch(() => undefined)
          return
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<void>(resolve => {
          timer = setTimeout(resolve, remaining)
          timer.unref?.()
        })
        let timedOut = false
        const winner = Promise.race([
          promise.then(() => 'done' as const),
          deadline.then(() => { timedOut = true; return 'deadline' as const }),
        ])
        try {
          await winner
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
        if (current() && (timedOut || Date.now() >= bound.launchedAt + bound.timeoutMs)) this.abandoned.add(key)
      })
      await this.untilAborted(Promise.all(waits), signal)
      if (signal?.aborted && current()) {
        for (const [key] of mine) this.abandoned.add(key)
      }
      return current() && (signal === undefined || !signal.aborted)
    } finally {
      // Only clear the indicator this wait published: a successor generation may
      // already have published its own.
      if (this.blocked.get(sessionId) === indicator) this.blocked.delete(sessionId)
    }
  }

  /**
   * Await one promise unless the signal aborts first, then leave it running.
   *
   * Used for hand-off bookkeeping: a stop must return the pre-step immediately,
   * but the write itself may still complete in the background.
   * @param work - the promise to observe.
   * @param signal - the turn's abort signal, when the host supplied one.
   * @returns the value, or undefined when the wait was abandoned.
   */
  private ruleBackstopMs(): number {
    const models = Object.keys(this.config.models.get() ?? {})
    const limits = ['', ...models].map(model => resolveRule(model, this.config).timeoutMs)
    // Any effective rule asking for no limit keeps that meaning; otherwise the
    // largest inherited limit bounds even a gate that has not launched.
    if (limits.some(value => value === 0)) return 0
    return Math.max(...limits)
  }

  private async untilSettled<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
    if (signal === undefined) return work
    if (signal.aborted) {
      void work.catch(() => undefined)
      return undefined
    }
    return new Promise<T | undefined>(resolve => {
      const done = (): void => {
        signal.removeEventListener('abort', done)
        resolve(undefined)
        void work.catch(() => undefined)
      }
      signal.addEventListener('abort', done, { once: true })
      void work.then(
        value => { signal.removeEventListener('abort', done); resolve(value) },
        () => { signal.removeEventListener('abort', done); resolve(undefined) },
      )
    })
  }

  /** Await a sidecar read only until its first pre-step deadline or host stop. */
  private async waitUntil(work: Promise<unknown>, signal?: AbortSignal, deadline?: number): Promise<boolean> {
    if (signal?.aborted || (deadline !== undefined && Date.now() >= deadline)) {
      void work.catch(() => undefined)
      return false
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = deadline === undefined ? new Promise<false>(() => undefined) : new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()))
      timer.unref?.()
    })
    let removeAbort: (() => void) | undefined
    const stop = signal === undefined ? new Promise<false>(() => undefined) : new Promise<false>(resolve => {
      const abort = (): void => { signal.removeEventListener('abort', abort); resolve(false) }
      removeAbort = (): void => signal.removeEventListener('abort', abort)
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const completed = await Promise.race([work.then(() => true), expiry, stop])
      return completed && !signal?.aborted && (deadline === undefined || Date.now() < deadline)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      removeAbort?.()
      void work.catch(() => undefined)
    }
  }

  /** Observe a pending compression until completion or host stop. */
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
  snapshot(sessionId: string): {
    active: ActiveCompression[]
    blockingSince: number | null
    blockingReason: BlockingReason | null
    pendingBranch: string | null
    generation: number
    /** Why this session's last observed step did not become a distillation; null once one did. */
    lastDecision: { at: number; turn: number; step: number; reason: string } | null
  } {
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
      lastDecision: this.lastDecision.get(sessionId) ?? null,
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
    // Remembered only after the write succeeded: the record is rolled back when the
    // sidecar rejects the update, and so must this marker, or the entry whose first
    // replay never persisted would be charged the hit price on the next answer.
    const newlyMissPriced: string[] = []
    await this.store.update(sessionId, (current) => {
      if (stale()) return
      for (const entry of current.entries) {
        if (!counted.has(entry.id)) continue
        // The first replay carries the rewrite as brand-new input, and so does the
        // first replay after a compaction changed the prefix: both come out of the
        // miss bucket. Every other request has that tail cached already. A request
        // that carried the rewrite but was aborted *without* an answer also warmed
        // that cache, so the miss price may only be charged once per entry until a
        // compaction makes the prefix new again.
        const missKey = `${sessionId}:${entry.id}`
        const first = entry.liveRequests === 0 && !this.missCharged.has(missKey)
        const missPriced = entry.repriceMiss === true || first
        if (first) newlyMissPriced.push(missKey)
        entry.liveSaved += entry.savedTokensPerRequest * (missPriced ? miss : hit)
        entry.liveRequests += 1
        if (entry.repriceMiss === true) delete entry.repriceMiss
      }
      current.countedThroughSeq = seq
    })
    for (const key of newlyMissPriced) this.missCharged.add(key)
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
    const abandonedNow = (): boolean => {
      const bound = this.waitBound.get(attemptKey)
      return this.abandoned.has(attemptKey)
        || (bound !== undefined && bound.timeoutMs > 0 && Date.now() >= bound.launchedAt + bound.timeoutMs)
    }
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
    // The attempt opening the session is also the last chance to notice an
    // expired wait bound: the request has already gone out with raw reasoning, so
    // paying for a distillation now would buy nothing.
    if (abandonedNow()) {
      this.ctx.logger.warn('reasoning-distill: not starting a distillation for %s: the wait bound already expired', target.model)
      return
    }
    // The three shapes an attempt can be recorded in; the entry ids share the
    // attempt's identity so a late failure can find the row it belongs to.
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
      this.failCompressionSession(sessionId, outcome.run.error ?? 'distiller returned no text')
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
          originalTokens: estimateTextTokens(reasoning),
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
          ...sessionId === '' ? { sessionMissing: true as const } : {},
        })
      })
      return
    }
    const ceiling = target.rule.maxOutputChars
    const distilled = ceiling > 0 && outcome.text.length > ceiling ? outcome.text.slice(0, ceiling) : outcome.text
    const originalTokens = estimateTextTokens(reasoning)
    const distilledTokens = estimateTextTokens(distilled)
    const saved = originalTokens - distilledTokens
    if (saved < target.rule.minSavedTokens) {
      this.ctx.logger.info(
        'reasoning-distill: skipped rewrite for %s (saved %d < %d tokens)',
        target.model, saved, target.rule.minSavedTokens,
      )
      // Settle the audit session before recording the attempt, so the row can be
      // linked the moment it exists.
      this.finishCompressionSession(sessionId, distilled, outcome.run.provider, outcome.run.model)
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
          ...sessionId === '' ? { sessionMissing: true as const } : {},
        })
      })
      return
    }
    this.finishCompressionSession(sessionId, distilled, outcome.run.provider, outcome.run.model)
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
      ...sessionId === '' ? { sessionMissing: true as const } : {},
    }
    // One mutation decides the outcome *at the moment it runs*: the write can sit
    // behind other work for that session, and by the time it executes the wait
    // bound may already have expired. Deciding before queueing would let an
    // abandoned attempt adopt its rewrite after the next request had gone out.
    let adopted = false
    await this.store.update(session.id, (record) => {
      if ((this.generation.get(session.id) ?? 0) !== generation) return
      if (abandonedNow()) {
        // The wait bound expired while this attempt was still finishing. It must
        // not adopt its rewrite, but the spend is real: record it as an abandoned
        // attempt (same id as the adopted entry, so a late audit settle still
        // finds this row) and say why.
        record.entries = record.entries.filter(item => item.targetSeq !== entry.targetSeq || (item.failed !== true && item.skipped !== true))
        record.entries.push({ ...entry, failed: true, distill: { ...entry.distill, error: 'abandoned before the wait bound expired' } })
        return
      }
      record.entries = record.entries.filter(item => item.targetSeq !== entry.targetSeq)
      record.entries.push(entry)
      adopted = true
    }, (_candidate, before) => {
      // The candidate is staged but not yet committed or visible. The wait bound
      // (or a superseding session) can change during staging; the pre-step may
      // have released a raw request. Select the failed entry before any rename,
      // so a replacement write failure cannot strand an adopted entry on disk.
      if ((this.generation.get(session.id) ?? 0) !== generation) return before
      if (adopted && abandonedNow()) {
        const rolled = structuredClone(before)
        rolled.entries = rolled.entries.filter(item => item.targetSeq !== entry.targetSeq || (item.failed !== true && item.skipped !== true))
        rolled.entries.push({ ...entry, failed: true, distill: { ...entry.distill, error: 'abandoned while the commit was in flight' } })
        adopted = false
        return rolled
      }
      return undefined
    })
    // The rewrite is now durable and worth writing into the history itself: the
    // panel asks the selected backend to do that, then stops this turn.
    // Follow the decision the mutation actually made: the wait bound can expire
    // while the queued write is in flight, and re-checking it here would adopt the
    // rewrite yet refuse to hand it over.
    if (adopted && !stale() && this.config.enabled.get() && backendById(this.config.rewriteBackend.get()) !== undefined) {
      if (backendById(this.config.rewriteBackend.get())?.kind === 'in-place') {
        // Write it at *this* step boundary rather than at the next pre-step. The step that ends a
        // turn has no next pre-step, and a delegated conversation is disposed as soon as its turn
        // ends, so the last reasoning before a reply had no writer until the conversation ran again.
        if (await this.settleInPlaceEntry(session, entry)) this.pendingBranch.delete(session.id)
      } else if (abandonedNow()) {
        // The committed entry remains visible and any real savings remain payable;
        // only the branch hand-off is skipped after the original turn was released.
        const reason = 'branch hand-off skipped after the wait deadline'
        const outcome = { state: 'skipped' as const, error: reason, at: Date.now() }
        const order = this.nextHandoffOrder(session.id, entry.id)
        const noted = await this.recordHandoff(session.id, entry.id, outcome, generation, undefined, order)
        if (!noted && !stale()) this.oweNote(session.id, entry.id, outcome, order)
      } else this.pendingBranch.set(session.id, entry.id)
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
    return encloseDistillationData(parts.join('\n\n'))
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
    let receivedText = ''
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
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') receivedText += chunk.text
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
      run.inputTokens = estimateTextTokens(prompt + userText)
      run.outputTokens = estimateTextTokens(receivedText)
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
    if (looksLikeFinalReply(run.responseText)) {
      run.error = 'distiller produced a user-facing reply instead of private reasoning'
      return { run, failed: true }
    }
    return { text: run.responseText, run, failed: false }
  }

  /**
   * Open the visible one-shot session that holds the compression conversation.
   *
   * The session is MEMORY-ONLY on purpose: it is an inspection window for the
   * distillation that just ran, not a conversation the user keeps. It is never
   * attached to a persistence writer, so it leaves no artifact behind: it stays
   * openable from the report until this process ends, and a restart expires it —
   * exactly what the report says when it stops offering the link.
   */
  private async createCompressionSession(
    parent: Session,
    prompt: string,
    userText: string,
  ): Promise<{ id: string; ok: boolean }> {
    let id = ''
    try {
      // No parentSession: this is a sidecar conversation, not a fork of the source.
      // Claiming the source as parent put it into the session lineage, where the
      // message-edit Timeline then listed it as a branch version of the conversation.
      const created = this.ctx.sessions.create(undefined, {
        meta: {
          createdAt: Date.now(),
          ...parent.header.cwd === undefined ? {} : { cwd: parent.header.cwd },
        },
      })
      // Record the id before any append: if an append throws, the session still
      // exists and the entry must be able to name and open it.
      id = created.id
      this.ownSessions.add(id)
      created.append('turn/start', { turn: 1 })
      created.append('step/start', { turn: 1, step: 1 })
      created.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `${prompt}\n\n---\n\n${userText}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      return { id, ok: true }
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: could not open a compression session: %o', error)
      return { id, ok: false }
    }
  }

  /**
   * Close a compression session that produced nothing usable, marking the turn
   * failed so the record says why instead of showing a placeholder answer.
   * @param sessionId - compression session, or an empty string when none opened.
   * @param reason - operator-facing failure text.
   */
  private failCompressionSession(sessionId: string, reason: string): void {
    if (sessionId === '') return
    const session = this.ctx.sessions.get(sessionId as SessionId)
    if (session === undefined) return
    try {
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { message: reason, code: 'REASONING_DISTILL_FAILED' } },
      })
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: could not settle a failed compression session: %o', error)
    }
  }

  /** Close the compression session with the distiller's answer. */
  private finishCompressionSession(sessionId: string, text: string, provider: string, model: string): void {
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
    } catch (error: unknown) {
      this.ctx.logger.warn('reasoning-distill: could not settle a compression session: %o', error)
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

/**
 * Identity of the *conversation* a session object belongs to, or undefined when it cannot be told.
 *
 * The session id alone is not enough: an id can be reused by a cleared or re-created conversation.
 * The creation stamp the host writes on the header is what separates the two, so a header without one
 * (older logs, a test double) deliberately yields undefined and keeps the conservative behaviour.
 * @param session - session object to identify.
 * @returns `id#createdAt`, or undefined when the header carries no creation stamp.
 */
function conversationIdentity(session: { id: string; header: unknown }): string | undefined {
  const createdAt = (session.header as { createdAt?: unknown } | undefined)?.createdAt
  if (typeof createdAt !== 'number') return undefined
  return `${session.id}#${createdAt}`
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
