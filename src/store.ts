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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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
   * What happened when this rewrite was handed to a branch backend. Absent means
   * no backend was selected when it was recorded.
   */
  handoff?: { state: 'created' | 'failed'; branchId?: string; error?: string; at: number }
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
   * Mutate and persist one session's record behind its own write queue.
   * @param sessionId - owning session id.
   * @param mutate - synchronous mutation of the cached record.
   */
  update(sessionId: string, mutate: (record: SessionRecord) => void): Promise<void> {
    const run = async (): Promise<void> => {
      const record = await this.load(sessionId)
      // Snapshot first: a failed write must not leave the cache ahead of what is
      // actually on disk, or a later unrelated update would persist it.
      const before = structuredClone(record)
      mutate(record)
      try {
        const dir = rootDir()
        // Private by construction: these files hold original reasoning, distiller
        // prompts/responses and tool output, so neither the directory nor the
        // record may be readable by other users on the host.
        await mkdir(dir, { recursive: true, mode: 0o700 })
        const target = fileFor(sessionId)
        // Unique per write: two stores (a reload, a second instance in tests) can
        // otherwise pick the same name in the same millisecond and one rename then
        // loses its source file.
        const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
        await writeFile(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
        await rename(tmp, target)
      } catch (error: unknown) {
        Object.assign(record, before)
        throw error
      }
    }
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const next = previous.then(run, run)
    this.queues.set(sessionId, next.catch(() => undefined))
    return next
  }

  /** Drop one session's cached record, e.g. after an explicit reset. */
  forget(sessionId: string): void {
    this.cache.delete(sessionId)
  }
}
