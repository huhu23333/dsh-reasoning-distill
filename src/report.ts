/**
 * Report assembly for the conversation tab.
 * @module dsh-reasoning-distill/report
 */

import { backendById } from './backends.ts'
import { BUILTIN_HOLIDAYS, BUILTIN_PRICES, resolveRule, type Config } from './config.ts'
import { priceAt, resolvePeakSource, whaleStatus } from './peak.ts'
import { DEFAULT_PRICE_ENTRIES, peakEnabled } from './prices.ts'
import type { SessionRecord } from './store.ts'
import type { ActiveCompression, BlockingReason, CatalogModel, CatalogReport, CompressionEntry, PeakInfo, SessionReport } from './shared.ts'
import { entryInForceHere } from './shared.ts'
import { DEFAULT_PROMPT } from './prompt.ts'

/**
 * Describe the peak attribution actually in force.
 * @param config - live plugin configuration.
 * @returns whether it applies, which source, and why.
 */
function peakInfo(config: Config): PeakInfo {
  const source = resolvePeakSource(config)
  const entries = config.prices.get() ?? {}
  // Count the split each model actually gets: an unstated flag inherits the
  // shipped answer, so a sparse stored entry must not read as "off".
  const models = new Set([...Object.keys(DEFAULT_PRICE_ENTRIES), ...Object.keys(entries)])
  const modelsEnabled = [...models].filter(model => peakEnabled(entries, model)).length
  return { source: source.id, label: source.label, detail: source.detail, modelsEnabled }
}

/**
 * Project one durable record into the wire report.
 * @param sessionId - session being reported.
 * @param record - its durable sidecar record.
 * @param config - live plugin configuration, for header facts.
 * @returns the report the conversation tab renders.
 */
export function buildReport(
  sessionId: string,
  record: SessionRecord,
  config: Config,
  live: {
    active: ActiveCompression[]
    blockingSince: number | null
    blockingReason: BlockingReason | null
    /** Tells whether a compression session is live or remains in persistent storage. */
    isLive?: (sessionId: string) => boolean
    /**
     * The stock as the engine computed it from the prompt a request would carry
     * right now, priced at this moment. Authoritative when present: only the
     * engine can know whether a rewrite still replaces anything after a message
     * projection changed its target.
     */
    stock?: { tokens: number; saved: number; ids: string[] }
    /**
     * Why this session's last observed step did not become a distillation, from the engine.
     * Absent for a caller that passes no engine snapshot.
     */
    lastDecision?: { at: number; turn: number; step: number; reason: string } | null
    /** Clock used to price the fallback stock; defaults to now. */
    now?: number
    /** Session generation the panel must quote when settling a hand-off. */
    generation?: number
    /** Entry awaiting a backend hand-off, when one is owed. */
    pendingBranch?: string | null
    /** When true (default) include the full distillation request/response text. */
    detail?: boolean
  } = { active: [], blockingSince: null, blockingReason: null },
): SessionReport {
  const entries: CompressionEntry[] = record.entries
    .slice()
    .sort((a, b) => a.appliedAt - b.appliedAt)
    .map(entry => ({
      id: entry.id,
      distilledText: entry.distilledText,
      ...entry.failed === true ? { failed: true as const } : {},
      ...entry.skipped === true ? { skipped: true as const } : {},
      ...entry.sessionMissing === true ? { sessionMissing: true as const } : {},
      sessionLive: entry.distill.sessionId === ''
        ? false
        : (live.isLive?.(entry.distill.sessionId) ?? true),
      appliedAt: entry.appliedAt,
      turn: entry.turn,
      step: entry.step,
      targetSeq: entry.targetSeq,
      targetMessageId: entry.targetMessageId,
      targetBlockIndex: entry.targetBlockIndex ?? -1,
      ...entry.handoff === undefined ? {} : { handoff: entry.handoff },
      ...entry.inPlaceApplied === undefined ? {} : { inPlaceApplied: entry.inPlaceApplied },
      provider: entry.provider,
      model: entry.model,
      originalChars: entry.originalChars,
      originalTokens: entry.originalTokens,
      distilledChars: entry.distilledChars,
      distilledTokens: entry.distilledTokens,
      savedTokensPerRequest: entry.savedTokensPerRequest,
      // The poller only needs the economics while it is driving a write-back;
      // the full prompt/response is shown by the report view when requested.
      distill: live.detail === false
        ? { ...entry.distill, requestText: '', responseText: '' }
        : entry.distill,
      cacheBreakTokens: entry.cacheBreakTokens,
      cacheBreakCost: entry.cacheBreakCost,
      liveSaved: entry.liveSaved,
      frozenSaved: entry.frozenSaved,
      liveRequests: entry.liveRequests,
      active: entry.inactive !== true,
    }))

  let distillCost = 0
  let cacheBreakCost = 0
  let savedLive = 0
  let savedTotal = 0
  let stockTokens = 0
  let stockSaved = 0
  let lifetimeTokens = 0
  let succeeded = 0
  const prices = config.prices.get() ?? {}
  // The stock is a *current* figure, so its money uses the current period's rate:
  // a rewrite applied during peak is worth the off-peak rate once the report is
  // viewed off-peak.
  const pricedAt = live.now ?? Date.now()
  for (const entry of entries) {
    distillCost += entry.distill.cost
    cacheBreakCost += entry.cacheBreakCost
    if (entry.active) savedLive += entry.liveSaved
    savedTotal += entry.liveSaved + entry.frozenSaved
    // Lifetime tokens survive a frozen epoch: the request count is kept when the
    // live money is frozen, so a retired rewrite still reports what it saved.
    // The count covers every credited request, in any round: DSH requests normally
    // carry tools, so the whole history — reasoning included — is resent and a
    // rewrite saves on every later request until compaction removes its target.
    lifetimeTokens += entry.savedTokensPerRequest * entry.liveRequests
    // A branch hand-off copies the rewrite; it stays in force here too, because this
    // conversation can remain usable (archive off/failed) and must not replay the
    // original reasoning merely because a copy exists. Both copies report their own
    // requests.
    const adopted = entryInForceHere(entry, sessionId)
    if (adopted) succeeded += 1
    // The stock counts every rewrite the next request would carry, from any round
    // (DSH requests normally carry tools, which resends the whole history), priced
    // at the hit rate of the model that would send them: those tokens sit in a
    // stable prefix, so the money is an estimate and is labelled as one.
    if (entry.active && adopted && entry.distilledTokens < entry.originalTokens) {
      stockTokens += entry.savedTokensPerRequest
      stockSaved += entry.savedTokensPerRequest * (priceAt(entry.model, prices, pricedAt, config).bucket.hit / 1_000_000)
    }
  }
  // The engine's view wins when it has one: it alone knows whether each rewrite
  // still replaces reasoning in the message a request would send.
  if (live.stock !== undefined) {
    stockTokens = live.stock.tokens
    stockSaved = live.stock.saved
  }

  const defaultRule = resolveRule('', config)
  return {
    sessionId,
    distillCost,
    cacheBreakCost,
    savedLive,
    savedTotal,
    stockTokens,
    stockSaved,
    ...(live.stock === undefined ? {} : { stockIds: live.stock.ids }),
    lifetimeTokens,
    succeeded,
    net: savedTotal - distillCost - cacheBreakCost,
    triggers: entries.length,
    epoch: record.epoch,
    entries,
    config: {
      // The master switch only means something with a backend to apply the result,
      // which is the same rule the engine and the settings panel enforce.
      // The same readiness rule the settings page and the engine use: an unknown
      // backend id means the feature is not actually on.
      enabled: config.enabled.get() && backendById(config.rewriteBackend.get()) !== undefined,
      rewriteBackend: config.rewriteBackend.get(),
      archiveSuperseded: config.archiveSuperseded.get(),
      defaultThresholdTokens: defaultRule.thresholdTokens,
      defaultDistiller: `${defaultRule.distiller.provider}/${defaultRule.distiller.model}`,
      peak: peakInfo(config),
    },
    pendingBranch: live.pendingBranch ?? null,
    generation: live.generation ?? 0,
    lastDecision: live.lastDecision ?? null,
    active: live.active,
    blockingSince: live.blockingSince,
    blockingReason: live.blockingReason,
  }
}

/**
 * Enumerate every selectable model route for the Settings page.
 * @param providers - provider ids in registration order.
 * @param modelsFor - resolves one provider's models.
 * @param infoFor - resolves one model's reasoning metadata.
 * @returns catalog rows plus the built-in prompt and prices.
 */
export async function buildCatalog(
  providers: readonly string[],
  modelsFor: (provider: string) => Promise<readonly { id: string; name?: string; contextWindow?: number }[]>,
  infoFor: (provider: string, model: string) => Promise<{ reasoningEfforts: string[]; defaultEffort?: string }>,
): Promise<CatalogReport> {
  const models: CatalogModel[] = []
  const failures: { provider: string; error: string }[] = []
  for (const provider of providers) {
    let listed: readonly { id: string; name?: string; contextWindow?: number }[]
    try {
      listed = await modelsFor(provider)
    } catch (reason: unknown) {
      failures.push({ provider, error: reason instanceof Error ? reason.message : String(reason) })
      continue
    }
    for (const model of listed) {
      let reasoningEfforts: string[] = []
      let defaultEffort: string | undefined
      try {
        const info = await infoFor(provider, model.id)
        reasoningEfforts = info.reasoningEfforts
        defaultEffort = info.defaultEffort
      } catch {
        reasoningEfforts = []
      }
      models.push({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        reasoningEfforts,
        ...defaultEffort === undefined ? {} : { defaultEffort },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      })
    }
  }
  const whale = whaleStatus()
  return {
    models,
    ...failures.length === 0 ? {} : { failures },
    defaultPrompt: DEFAULT_PROMPT,
    builtinPrices: { ...BUILTIN_PRICES },
    peak: {
      builtinHolidays: [...BUILTIN_HOLIDAYS],
      whaleDetected: whale.detected,
      whaleDetail: whale.detail,
      whaleHolidays: whale.holidays,
    },
  }
}
