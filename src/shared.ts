/**
 * Wire types shared by the host half and the browser half. This module must stay
 * import-free so the client bundle can include it without pulling host code.
 * @module dsh-reasoning-distill/shared
 */

/** Truthful provenance of one distillation run. */
export interface DistillRun {
  /** One-shot session that holds the compression conversation. */
  sessionId: string
  provider: string
  model: string
  effort: string
  /** Exact user message handed to the distiller. */
  requestText: string
  /** Raw distiller reply, before truncation for replay. */
  responseText: string
  inputTokens: number
  cacheReadTokens: number
  /** Input billed as a cache write; disjoint from `inputTokens`. */
  cacheWriteTokens: number
  outputTokens: number
  /** 元 actually paid for this run. */
  cost: number
  /** True when the cost was reconstructed because the provider reported no usage. */
  estimated?: true
  period: 'peak' | 'off'
  durationMs: number
  /** Set when the run failed; the reasoning was left untouched. */
  error?: string
}

/** One reasoning replacement and its measured economics. */
export interface CompressionEntry {
  /** Stable identity of this replacement, unique within the session. */
  id: string
  /**
   * The attempt produced nothing usable (timeout, abort, empty answer). Its
   * spending is still reported, but it substituted nothing.
   */
  failed?: true
  /** The rewrite was produced but not adopted because it saved too little. */
  skipped?: true
  /** No auditable compression session could be opened; the rewrite still shipped. */
  sessionMissing?: true
  /** Whether the linked compression session is live or still loadable from storage. */
  sessionLive?: boolean
  appliedAt: number
  turn: number
  step: number
  /** Surface sequence of the rewritten assistant message. */
  targetSeq: number
  targetMessageId: string
  /** Branch hand-off outcome for this rewrite, when one was attempted. */
  handoff?: { state: 'created' | 'failed' | 'skipped'; branchId?: string; error?: string; at: number }
  /**
   * When the engine itself wrote this rewrite into the history.
   *
   * Absent for a rewrite the panel applied and for one still owed. The engine settles what a
   * delegated conversation owes as soon as it is live again, because the panel's request can arrive
   * between two of its turns, when no session exists to write into.
   */
  inPlaceApplied?: number
  /**
   * The text the engine stored and replays: the answer capped at
   * `maxOutputChars`. Backends must be given this one, not the raw answer.
   */
  distilledText: string
  /** Index of the reasoning block the rewrite replaces; -1 when unknown. */
  targetBlockIndex: number
  /** Model whose reasoning was rewritten. */
  provider: string
  model: string
  originalChars: number
  originalTokens: number
  distilledChars: number
  distilledTokens: number
  /** Estimated tokens removed from each request that replays it, in any round. */
  savedTokensPerRequest: number
  distill: DistillRun
  /**
   * Tokens that fell out of the cache-hit prefix at the substitution point.
   *
   * Pinned at 0 by design: the rewrite always lands before the message is ever
   * replayed (the pre-step await), so the rewritten message and everything after
   * it are new input on the next request either way — with or without this
   * plugin they are billed as a miss. The two fields stay in the persisted
   * record and the report wire format for compatibility with older sidecars and
   * panels; removing them is a schema change, not a cleanup (README, the
   * "缓存断裂" note).
   */
  cacheBreakTokens: number
  /** Extra 元 that miss pricing added on the substitution request. */
  cacheBreakCost: number
  /** Savings accumulated in the live epoch, up to the latest observed request. */
  liveSaved: number
  /** Savings frozen when a compaction ended an epoch. Never resets. */
  frozenSaved: number
  /** Answered requests credited in the live epoch, across every round. */
  liveRequests: number
  /** Still contributing to the live epoch. */
  active: boolean
}

/** The part of a recorded compression that decides where its rewrite lives. */
export interface CompressionPlacement {
  failed?: true
  skipped?: true
  handoff?: { state: 'created' | 'failed' | 'skipped'; branchId?: string; error?: string; at: number }
}

/**
 * Whether a recorded compression has a rewrite this conversation can replay.
 *
 * A branch hand-off copies the rewrite into the new branch, but it must not take it
 * out of the source conversation: the source can stay usable when the archive step is
 * disabled or fails, and it may be reopened from the archive. Replaying the same
 * compressed text in both copies is consistent (the target message is still the same
 * event at the same seq), and the alternative — keeping the source raw simply because
 * a copy exists elsewhere — would send the original reasoning again. Failed or skipped
 * attempts never substituted anything anywhere.
 * @param entry - one recorded compression.
 * @param _sessionId - the conversation the question is asked for; kept for callers so
 *   a future placement rule can look at it, but no placement currently excludes a copy.
 * @returns whether this conversation carries the rewrite.
 */
export function entryInForceHere(entry: CompressionPlacement, _sessionId: string): boolean {
  return entry.failed !== true && entry.skipped !== true
}

/**
 * Whether an otherwise eligible compression must wait because the conversation is
 * already too full.
 *
 * Occupancy uses the host's own numbers: `totalTokens` is what its token meter
 * measures for this session — the same measurement its compaction trigger reads —
 * and `contextWindow` is the routed model's combined capacity. A compaction
 * therefore lowers the percentage immediately, which is what makes the cap track
 * the window a rewrite would actually get.
 * @param totalTokens - measured request-and-response pressure.
 * @param contextWindow - routed model's combined context capacity.
 * @param maxPercent - highest occupancy, in percent, at which a compression may run.
 * @returns true only when occupancy is strictly above the cap.
 */
export function exceedsContextCap(totalTokens: number, contextWindow: number, maxPercent: number): boolean {
  if (!Number.isFinite(totalTokens) || !Number.isFinite(contextWindow) || !Number.isFinite(maxPercent)) return false
  if (contextWindow <= 0) return false
  return (totalTokens / contextWindow) * 100 > maxPercent
}

/** Aggregate report for one session. */
export interface SessionReport {
  sessionId: string
  /** Total distill spending. */
  distillCost: number
  /** Total extra spending caused by cache breaks. */
  cacheBreakCost: number
  /** Savings accumulated in the live epoch. Resets at each compaction. */
  savedLive: number
  /**
   * Lifetime savings, including every frozen epoch. Never resets.
   *
   * Every answered request that replayed a rewrite is credited, whichever round
   * it belongs to: DSH requests normally carry tools, so the whole history —
   * reasoning included — is resent and a rewrite keeps saving until compaction
   * removes its target.
   */
  savedTotal: number
  /**
   * Tokens the next request would carry less than it would without the rewrites
   * that are in force right now, from any round. A stock, not a running total: it
   * grows once per adopted rewrite and shrinks as compaction removes their
   * targets.
   */
  stockTokens: number
  /** {@link SessionReport.stockTokens} priced at the hit rate, an estimate. */
  stockSaved: number
  /** Tokens every credited request saved in total, frozen rewards included. */
  lifetimeTokens: number
  /** Attempts that produced an adopted rewrite (excludes failed and skipped). */
  succeeded: number
  /**
   * Entry ids a request would carry right now, when the engine could compute it.
   * Authoritative for the per-entry stock; absent means offline.
   */
  stockIds?: string[]
  /**
   * Why this session's last observed step did not become a distillation, or null once one did.
   *
   * The reason is a short code (`below-threshold`, `rule-off-continuable`, `session-not-attached`,…)
   * because the engine cannot translate; the panel renders the ones it knows and falls back to the
   * code, and anyone reading the route sees exactly what the engine decided.
   */
  lastDecision?: { at: number; turn: number; step: number; reason: string } | null
  /**
   * Entry id whose distilled text still has to be written into the history by a
   * backend, or null. The panel applies it and then calls the hand-off route.
   */
  pendingBranch?: string | null
  /** Session generation, quoted back when settling a hand-off. */
  generation?: number
  /** savedTotal − distillCost − cacheBreakCost. */
  net: number
  triggers: number
  /** Number of compactions observed; each one starts a new epoch. */
  epoch: number
  entries: CompressionEntry[]
  /** Compressions still running when this snapshot was taken. */
  active: ActiveCompression[]
  /**
   * When the current step started waiting for a compression, epoch
   * milliseconds, or null when nothing is blocked. This is why a request that
   * would otherwise be in flight may not have been sent yet.
   */
  blockingSince: number | null
  /** What the wait is holding up, so the UI can name it. */
  blockingReason: BlockingReason | null
  /** Live configuration snapshot for the report header. */
  config: {
    enabled: boolean
    defaultThresholdTokens: number
    defaultDistiller: string
    /** Selected assistant-rewrite backend id; empty when none is chosen. */
    rewriteBackend: string
    /**
     * Whether following a branch also archives the conversation it replaced. The
     * client reads it from here: this seat already polls the report, and the value has
     * to be current when the branch appears.
     */
    archiveSuperseded: boolean
    /** Whether the second price column is in use, and which source decides it. */
    peak: PeakInfo
  }
}

/** The phase one running compression is currently in. */
export type CompressionStage = 'preparing' | 'distilling' | 'recording' | 'writing-back'

/** One compression that is running right now. */
export interface ActiveCompression {
  turn: number
  step: number
  /** Model whose reasoning is being distilled. */
  provider: string
  model: string
  /** Route running the distillation. */
  distiller: string
  /** Estimated size of the reasoning being compressed. */
  originalTokens: number
  /** When the distillation started, epoch milliseconds. */
  startedAt: number
  /** Current phase, so the report can say where a slow compression is stuck. */
  stage: CompressionStage
  /** When the current phase started, epoch milliseconds. */
  stageStartedAt: number
}

/** What a compression wait is holding up. */
export type BlockingReason = 'tool' | 'user' | 'other'

/** Which peak-window rules priced this session. */
export interface PeakInfo {
  /** Source id in force: `builtin` or `whale`. */
  source: string
  /** Human-readable source label. */
  label: string
  /** Detail line, including why a fallback happened. */
  detail: string
  /** How many model price entries opt into the two-column split. */
  modelsEnabled: number
}

/** One selectable model route, for the Settings page. */
export interface CatalogModel {
  provider: string
  id: string
  name: string
  reasoningEfforts: string[]
  defaultEffort?: string
  contextWindow?: number
}

/** Everything the Settings page needs to render. */
export interface CatalogReport {
  models: CatalogModel[]
  /** Providers whose model list could not be read, with the reason. */
  failures?: { provider: string; error: string }[]
  /** Built-in prompt, offered as the reset target. */
  defaultPrompt: string
  /** Built-in peak prices, 元 per million tokens, keyed by model id. */
  builtinPrices: Record<string, { hit: number; miss: number; out: number }>
  /** Peak-window material for the pricing section. */
  peak: {
    /** Shipped holiday table, offered as the reset target. */
    builtinHolidays: string[]
    /** Whether `dsh-whale-widget` was found and parsed. */
    whaleDetected: boolean
    /** Bundle path read when it was, otherwise empty. */
    whaleDetail: string
    /** Number of holidays recovered from the widget. */
    whaleHolidays: number
  }
}

/**
 * Name of this plugin's own settings document.
 *
 * The profile entry id, the settings namespace and the key the panel looks its form up by are the
 * same string, and both halves have to spell it the same way: the host closes its own master switch
 * through it, the panel edits the same document through it.
 */
export const SETTINGS_NS = 'reasoning-distill'

/** Route paths owned by this plugin. */
export const REPORT_ROUTE = '/api/reasoning-distill/report'
/** Same-origin route that stops a session's turn once a rewrite has landed. */
export const HANDOFF_ROUTE = '/api/reasoning-distill/handoff'
export const CATALOG_ROUTE = '/api/reasoning-distill/catalog'
export const INSTALL_ROUTE = '/api/reasoning-distill/install'
/**
 * Same-origin route that performs one in-place reasoning rewrite and reports the host patch.
 *
 * This plugin serves it itself: the built-in in-place backend has no companion package, so the
 * route that writes the rewrite and the route that says whether the host can write it at all are
 * the same one. `GET` answers the patch verdict, `POST` applies a rewrite (or answers the same
 * verdict when the body is the chooser's probe).
 */
export const REWRITE_ROUTE = '/api/reasoning-distill/rewrite'
/** Same-origin route that cancels one running compression before it is adopted. */
export const CANCEL_ROUTE = '/api/reasoning-distill/cancel'

/** What the host patch self-check found, as both halves of this plugin report it. */
export interface HostPatchStatus {
  /** The host exposes the in-place rewrite entry point at all. */
  patched: boolean
  /** The entry point really rewrites one reasoning block in place, idempotently. */
  functional: boolean
  /**
   * Why the self-check failed, when it did. Absent for a host whose patch works; a host that has
   * the entry point but cannot use it says so instead of leaving the panel with a bare "not
   * functional".
   */
  detail?: string
}
