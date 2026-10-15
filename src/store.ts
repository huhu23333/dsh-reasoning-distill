/**
 * Durable sidecar storage.
 *
 * A plugin outside the repository cannot append its own session event type:
 * `Session.append` never writes the envelope's `ignorable` marker, and the
 * persistence read path refuses an unknown event that lacks it. This plugin
 * therefore keeps its durable state beside the session log instead of inside
 * it, and changes only what the model is shown (through the derived-history
 * seam), leaving the session log itself untouched and always readable.
 * @module dsh-reasoning-distill/store
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { DistillRun } from './shared.ts'

/** One applied reasoning replacement plus its accumulated accounting. */
export interface StoredEntry {
  id: string
  /** Surface sequence of the rewritten assistant message. */
  targetSeq: number
  targetMessageId: string
  /** Index of the reasoning block inside the target message; -1 when unknown. */
  targetBlockIndex?: number
  turn: number
  step: number
  /** Route that produced the original reasoning. */
  provider: string
  model: string
  originalChars: number
  originalTokens: number
  distilledText: string
  distilledChars: number
  distilledTokens: number
  /** Estimated tokens removed from every later request in the same epoch. */
  savedTokensPerRequest: number
  distill: DistillRun
  /** Pinned at 0: see the same fields on the report type in `shared.ts`. */
  cacheBreakTokens: number
  cacheBreakCost: number
  /** Epoch index at application time; a compaction starts a new epoch. */
  epoch: number
  appliedAt: number
  /** Savings accumulated in the live epoch. */
  liveSaved: number
  /** Requests counted in the live epoch. */
  liveRequests: number
  /** Savings frozen when a compaction ended its epoch. */
  frozenSaved: number
  /** The attempt failed; nothing was substituted and nothing can be saved. */
  failed?: true
  /**
   * The rewrite was produced but not adopted, because it saved less than
   * `minSavedTokens`. Its spending is real and is reported like a failure's, the
   * substitution simply never happened.
   */
  skipped?: true
  /**
   * Cheap digest of the reasoning this rewrite was distilled from. A message
   * edited in place under the same id must stop receiving this distillation.
   */
  originalHash?: string
  /**
   * What happened when this rewrite was handed to a branch backend. Absent means
   * no backend was selected when it was recorded.
   */
  handoff?: { state: 'created' | 'failed' | 'skipped'; branchId?: string; error?: string; at: number }
  /** A compaction removed this entry's target; its live savings are frozen. */
  inactive?: true
  /**
   * A compaction changed the prefix before this entry's target, so the request
   * that follows re-sends that region uncached: the saved tokens are worth the
   * miss price once more.
   */
  repriceMiss?: true
  /** No auditable compression session could be opened; the rewrite still shipped. */
  sessionMissing?: true
}

/** Durable per-session record. */
export interface SessionRecord {
  version: 1
  sessionId: string
  /** Current epoch index; incremented by each observed compaction. */
  epoch: number
  /** Last assistant/message sequence already counted into savings. */
  countedThroughSeq: number
  entries: StoredEntry[]
}

/** Harness home, matching the credentials and session layout. */
export function dshHome(): string {
  return process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

/** Root directory holding this plugin's sidecars. */
function rootDir(): string {
  return join(dshHome(), 'reasoning-distill')
}

/**
 * Sidecar path for one session id.
 *
 * Sanitizing alone is not injective — `team/a` and `team?a` both collapse to
 * `team_a` — which would let one session read, overwrite and report another
 * session's private reasoning. The digest of the raw id keeps names distinct.
 * @param sessionId - owning session id.
 * @returns the sidecar path for it.
 */
export function sidecarPath(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
  return join(rootDir(), `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}-${digest}.json`)
}

/** Internal alias for {@link sidecarPath}. */
const fileFor = sidecarPath

/** Internal alias for {@link legacySidecarPath}. */
const fileForLegacy = legacySidecarPath

/**
 * Pre-digest sidecar path. Read-only: used only to adopt a record whose own
 * `sessionId` proves it belongs to the caller.
 * @param sessionId - owning session id.
 * @returns the old-style path for it.
 */
export function legacySidecarPath(sessionId: string): string {
  return join(rootDir(), `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
}

/** Empty record for a session that has no sidecar yet. */
export function emptyRecord(sessionId: string): SessionRecord {
  return { version: 1, sessionId, epoch: 0, countedThroughSeq: -1, entries: [] }
}

/**
 * In-memory view of the sidecar directory.
 *
 * Writes are atomic (write-then-rename) and serialized per session so a burst
 * of accounting updates cannot interleave into a torn file.
 */
export class SidecarStore {
  private readonly cache = new Map<string, SessionRecord>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, Promise<SessionRecord>>()
  /**
   * The write epoch of every session with a queued or running write.
   *
   * `forget` marks the live epoch evicted, so a write that was already queued when the
   * session was dropped cannot publish its record back: dropping the cache entry alone
   * would be undone by that write's own `cache.set` when it finishes, leaving the
   * record — original reasoning text plus the distiller's request and response — in
   * memory for the life of the process. `forget` detaches the evicted epoch from this map,
   * so the next write for the same id starts a fresh one — the same session id can be
   * attached again and must not be permanently barred from publishing.
   */
  private readonly epochs = new Map<string, { evicted: boolean }>()

  /**
   * Read one session's record.
   *
   * A missing file is a legitimately empty record. Anything else — an I/O error
   * or an unparsable sidecar — is **raised instead of cached**: caching an empty
   * record there would let the next `update` overwrite real, recoverable history
   * with nothing.
   * @param sessionId - owning session id.
   * @returns the cached record.
   */
  async load(sessionId: string): Promise<SessionRecord> {
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) return cached
    // Single-flight: a preload racing the first update must not install an older
    // snapshot over the record that update already mutated.
    const inFlight = this.pending.get(sessionId)
    if (inFlight !== undefined) return inFlight
    const reading = (async (): Promise<SessionRecord> => {
      /** A blank record is the answer when nothing on disk belongs to this id. */
      const blank = (): SessionRecord => {
        const fresh = emptyRecord(sessionId)
        this.cache.set(sessionId, fresh)
        return fresh
      }
      let raw: string
      let legacy = false
      try {
        raw = await readFile(fileFor(sessionId), 'utf8')
      } catch (error: unknown) {
        if ((error as { code?: string }).code !== 'ENOENT') {
          throw new Error(`reasoning-distill: cannot read the sidecar for ${sessionId}: ${String(error)}`)
        }
        // The digest-bearing name is new; a record written before it may exist
        // under the old name. That name is NOT injective (`team/a` and `team?a`
        // both collapse to `team_a`), so a legacy file is only adopted when the
        // record inside it proves it belongs to this id.
        legacy = true
        try {
          raw = await readFile(fileForLegacy(sessionId), 'utf8')
        } catch (legacyError: unknown) {
          // Only a genuinely absent legacy file means "nothing to migrate". A
          // transient permission or I/O failure must NOT be cached as an empty
          // record: the next write would create a digest-path sidecar that
          // shadows the real one forever.
          if ((legacyError as { code?: string }).code === 'ENOENT') return blank()
          throw new Error(`reasoning-distill: cannot read the legacy sidecar for ${sessionId}: ${String(legacyError)}`)
        }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error: unknown) {
        // A malformed *legacy* file cannot prove ownership (its name is not
        // injective), so treating it as blank would let a later write shadow
        // history that may well be this session's and is often recoverable.
        // Fail closed instead: the engine then pauses this session and writes
        // nothing. A well-formed legacy file owned by another session is still
        // ignored below, which is a *proven* foreign owner rather than an
        // unknown one.
        throw new Error(`reasoning-distill: the ${legacy ? 'legacy ' : ''}sidecar for ${sessionId} is not valid JSON and was left untouched: ${String(error)}`)
      }
      const record = parsed as SessionRecord
      if (record.version !== 1 || !Array.isArray(record.entries)) {
        // Same reasoning as the parse failure above: an unknown shape cannot
        // prove ownership, so it is unreadable rather than absent.
        throw new Error(`reasoning-distill: the ${legacy ? 'legacy ' : ''}sidecar for ${sessionId} has an unknown shape and was left untouched`)
      }
      // The id inside the file is the authority, so a name collision — present
      // or future — can never hand one session another session's reasoning.
      if (record.sessionId !== sessionId) {
        if (legacy) return blank()
        throw new Error(`reasoning-distill: the sidecar at ${fileFor(sessionId)} belongs to another session and was left untouched`)
      }
      this.cache.set(sessionId, record)
      return record
    })()
    this.pending.set(sessionId, reading)
    try {
      return await reading
    } finally {
      this.pending.delete(sessionId)
    }
  }

  /** Cached record without touching the filesystem. */
  peek(sessionId: string): SessionRecord | undefined {
    return this.cache.get(sessionId)
  }

  /**
   * Persist one record to its session's sidecar, atomically.
   *
   * Private by construction: these files hold original reasoning, distiller
   * prompts/responses and tool output, so neither the directory nor the record
   * may be readable by other users on the host. Extracted from `update` so the
   * commit sits in one place — and so a test double can widen the window between
   * the mutation and the publication (the C1 race lives exactly there).
   * @param target - the session's sidecar path.
   * @param record - the record to persist.
   */
  protected async commitToDisk(target: string, record: SessionRecord): Promise<void> {
    const dir = rootDir()
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // `mkdir` does not tighten a directory that already exists, and this one
    // names sessions by id: an installation that created it 0755 would expose
    // the file names to other local users even though each file is 0600.
    const info = await stat(dir).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) {
      throw new Error(`reasoning-distill: ${dir} is not a directory`)
    }
    await chmod(dir, 0o700).catch(() => undefined)
    const tightened = await stat(dir).catch(() => undefined)
    if (tightened === undefined || (tightened.mode & 0o077) !== 0) {
      throw new Error(`reasoning-distill: ${dir} is not private (mode ${(tightened?.mode ?? 0).toString(8)}); refusing to store reasoning in it`)
    }
    // Unique per write: two stores (a reload, a second instance in tests) can
    // otherwise pick the same name in the same millisecond and one rename then
    // loses its source file.
    const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, target)
  }

  /**
   * Mutate and persist one session's record behind its own write queue.
   *
   * The rename is the commit point. `finalize` runs synchronously right after
   * it and before the record becomes visible: the deadline a caller is racing
   * (or the generation of a session it acted for) can expire during the I/O
   * between the mutation and the rename, and by then the decision is already
   * committed to disk. `finalize` is that caller's last chance to substitute a
   * different record — typically the same content with the entry rolled back —
   * before any request can derive from the committed one. Returning the
   * replacement publishes it first and then makes the disk agree, so no read
   * ever sees the entry in between.
   * @param sessionId - owning session id.
   * @param mutate - synchronous mutation of a private record copy.
   * @param finalize - optional post-rename, pre-publication verification. It
   *   receives the committed record and the pre-mutation snapshot, and returns
   *   `undefined` to publish the record as committed, or a replacement record
   *   to publish (and persist) instead.
   */
  update(sessionId: string, mutate: (record: SessionRecord) => void, finalize?: (record: SessionRecord, before: SessionRecord) => SessionRecord | undefined): Promise<void> {
    // The epoch this write belongs to, captured before it queues: `forget` may evict it
    // while the write waits, and a write queued for a session that is gone must not leave
    // its record behind (see `forget`).
    const epoch = this.epochOf(sessionId)
    const run = async (): Promise<void> => {
      try {
        // Each queued write starts from the last committed version. Mutators cannot
        // expose their candidate through load/peek before the rename succeeds.
        const record = structuredClone(await this.load(sessionId))
        const before = structuredClone(record)
        mutate(record)
        const target = fileFor(sessionId)
        await this.commitToDisk(target, record)
        // The rename has landed. Between it and this check there is no await, so a
        // deadline can only fall on one side of the decision: it was already known
        // when `finalize` ran, or it fires after the record is published — either
        // way the request the deadline released and the ledger agree.
        let published = record
        if (finalize !== undefined) {
          let decided: SessionRecord | undefined
          try {
            decided = finalize(record, before)
          } catch {
            // A verification that cannot run must not let the committed candidate
            // become visible: roll back to the snapshot taken before the mutation.
            decided = before
          }
          if (decided !== undefined) {
            published = decided
            // Publish the rolled-back shape first: a request that arrives while the
            // disk is being brought in line must not derive from the entry that was
            // just revoked. The snapshot is the committed pre-mutation state, so
            // nothing the caller has not seen can be lost by this second write.
            this.cache.set(sessionId, published)
            await this.commitToDisk(target, published)
          }
        }
        this.cache.set(sessionId, published)
      } finally {
        // Publishing above can resurrect a record `forget` already dropped -- and `load`
        // repopulated the cache mid-write for the same reason. Evicting the epoch is what
        // makes the disposal stick, on both exits. The committed file is not touched: the
        // next `load` reads it back rather than handing around a copy of a session that is
        // gone.
        if (epoch.evicted) this.cache.delete(sessionId)
      }
    }
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const next = previous.then(run, run)
    const tracked = next.catch(() => undefined)
    this.queues.set(sessionId, tracked)
    // A queue entry is only needed while a write is in flight or waiting behind one:
    // left in place it would pin one promise per session for the life of the process,
    // so the write that ends up last removes its own entry. Another update that
    // arrives first replaces it in the map and owns the removal instead.
    void tracked.then(() => {
      if (this.queues.get(sessionId) !== tracked) return
      this.queues.delete(sessionId)
      // The last write that captured this epoch has finished, so nothing is left for a
      // later `forget` to evict and the next write starts a fresh epoch.
      if (this.epochs.get(sessionId) === epoch) this.epochs.delete(sessionId)
    })
    return next
  }

  /**
   * The write epoch a new write for one session belongs to.
   * @param sessionId - owning session id.
   * @returns the session's live epoch, created when it has none.
   */
  private epochOf(sessionId: string): { evicted: boolean } {
    const existing = this.epochs.get(sessionId)
    if (existing !== undefined) return existing
    const fresh = { evicted: false }
    this.epochs.set(sessionId, fresh)
    return fresh
  }

  /**
   * Drop one session's cached record, e.g. when the session is gone or its id is
   * attached again.
   *
   * The record carries the original reasoning text and the distiller's request and
   * response, so a long-lived host that never dropped it would keep every conversation
   * it has ever seen in memory. A read already in flight publishes its snapshot when it
   * resolves, so that outcome is dropped too; a write already queued behind the queue is
   * evicted the same way (its epoch is marked, so its own `cache.set` is undone when it
   * ends). The next `load` then reads the file again rather than handing back the record
   * of a session that is gone.
   * @param sessionId - owning session id.
   */
  forget(sessionId: string): void {
    // Evict the live epoch *before* dropping the cache entry: a write that was already
    // queued, or one that is running right now, publishes its candidate with `cache.set`
    // when it ends and would put the record back exactly as it was. Detaching the epoch
    // from the map is what keeps that eviction from poisoning a later write for the same
    // id -- the same session id can be attached again, and that write starts a fresh epoch.
    const epoch = this.epochs.get(sessionId)
    if (epoch !== undefined) {
      epoch.evicted = true
      this.epochs.delete(sessionId)
    }
    this.cache.delete(sessionId)
    const inFlight = this.pending.get(sessionId)
    if (inFlight !== undefined) {
      void inFlight.then(() => { this.cache.delete(sessionId) }, () => undefined)
    }
  }
}
