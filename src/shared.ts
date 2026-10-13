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
  /**
   * Whether the linked compression session still exists in this process. Audit
   * sessions are created outside the agent lifecycle, which is what attaches a
   * session-log writer, so they are deliberately in-memory: after a restart the
   * id no longer resolves, although the transcript below stays durable here.
   */
  sessionLive?: boolean
  appliedAt: number
  turn: number
  step: number
  /** Surface sequence of the rewritten assistant message. */
  targetSeq: number
  targetMessageId: string
  /** Branch hand-off outcome for this rewrite, when one was attempted. */
  handoff?: { state: 'created' | 'failed'; branchId?: string; error?: string; at: number }
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
  /** Estimated tokens removed from every later request in this epoch. */
  savedTokensPerRequest: number
  distill: DistillRun
  /** Tokens that fell out of the cache-hit prefix at the substitution point. */
  cacheBreakTokens: number
  /** Extra 元 that miss pricing added on the substitution request. */
  cacheBreakCost: number
  /** Savings accumulated in the live epoch, up to the latest observed request. */
  liveSaved: number
  /** Savings frozen when a compaction ended an epoch. Never resets. */
  frozenSaved: number
  /** Answered requests counted in the live epoch. */
  liveRequests: number
  /** Still contributing to the live epoch. */
  active: boolean
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
  /** Lifetime savings, including every frozen epoch. Never resets. */
  savedTotal: number
  /**
   * Tokens the next request would carry less than it would without the rewrites
   * that are in force right now. A stock, not a running total: it grows once per
   * adopted rewrite and shrinks as compaction removes their targets.
   */
  stockTokens: number
  /** {@link SessionReport.stockTokens} priced at the hit rate, an estimate. */
  stockSaved: number
  /** Tokens every answered request saved in total, frozen rewards included. */
  lifetimeTokens: number
  /** Attempts that produced an adopted rewrite (excludes failed and skipped). */
  succeeded: number
  /**
   * Entry ids a request would carry right now, when the engine could compute it.
   * Authoritative for the per-entry stock; absent means offline.
   */
  stockIds?: string[]
  /**
   * Entry id whose distilled text still has to be written into the history by a
   * backend, or null. The panel applies it and then calls the hand-off route.
   */
  pendingBranch?: string | null
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
    /** Whether the second price column is in use, and which source decides it. */
    peak: PeakInfo
  }
}

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

/** Route paths owned by this plugin. */
export const REPORT_ROUTE = '/api/reasoning-distill/report'
/** Same-origin route that stops a session's turn once a rewrite has landed. */
export const HANDOFF_ROUTE = '/api/reasoning-distill/handoff'
export const CATALOG_ROUTE = '/api/reasoning-distill/catalog'
