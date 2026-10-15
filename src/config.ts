/**
 * Plugin configuration: the Settings page schema plus the runtime resolver that
 * folds built-in defaults, the global default rule, and one model's own rule.
 * @module dsh-reasoning-distill/config
 */

import type { Volatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'

import { legacyOneShotSwitch, mergeRule, withKindDefaults, type RuleOverride, type RuleSource } from './rule.ts'

/** One API price bucket, in currency units per million tokens. */
export interface PriceBucket {
  /** Input billed against a cache hit. */
  hit: number
  /** Input billed without a cache hit. */
  miss: number
  /** Model output (reasoning tokens are output tokens). */
  out: number
}

/** One model's price entry: two columns plus whether the second is used at all. */
export interface ModelPrices {
  /** The price actually used when peak pricing is off. */
  peak: PriceBucket
  /** Second column; only consulted when {@link ModelPrices.peakPricing} is set. */
  off: PriceBucket
  /** Whether this model's cost is attributed across the two columns. Pricing, not model behaviour. */
  peakPricing?: boolean
}

/** The model route one distillation request runs on. */
export interface DistillRoute {
  provider: string
  model: string
  /** Adapter-owned reasoning effort; `off` disables thinking for the distiller. */
  effort: string
}

/** Per-model (or default) trigger and distiller policy. */
export interface ModelRule {
  /** Whether this model's reasoning is distilled in ordinary conversation. */
  enabled: boolean
  /**
   * Whether it is also distilled inside a resumable subagent child (a teammate,
   * for instance). Those keep replaying their own reasoning, so they earn their
   * keep like a conversation does.
   */
  continuableSubagents: boolean
  /**
   * Deepest delegation for {@link ModelRule.continuableSubagents}: a child nested
   * deeper than this is left alone. `0` means no limit.
   */
  continuableMaxDepth: number
  /**
   * Whether it is distilled inside a terminal one-shot subagent run. Off by
   * default: the delegation is short and never resumed, so its final answer pays
   * for a distillation nothing replays.
   */
  oneShotSubagents: boolean
  /**
   * Deepest delegation for {@link ModelRule.oneShotSubagents}: a child nested
   * deeper than this is left alone. `0` means no limit.
   */
  oneShotMaxDepth: number
  /** Trigger above this many estimated reasoning tokens. */
  thresholdTokens: number
  /** Replace only when the distilled text saves at least this many estimated tokens. */
  minSavedTokens: number
  /**
   * Append the step's tool results after its tool calls. The calls themselves
   * are always sent; only the results are optional.
   */
  includeToolResults: boolean
  /** Distill the reasoning of steps that requested no tool call (final answers). */
  includeFinalTurns: boolean
  /** Longest single context block (a tool result, say) handed to the distiller; 0 = no bound. */
  maxInputChars: number
  /** Longest distillation result accepted; 0 = no bound. */
  maxOutputChars: number
  distiller: DistillRoute
  /**
   * One value for both sides of the wait: the distillation must finish within
   * this, and the step waits exactly that long. Hitting it abandons this
   * compression — the reasoning stays untouched and no rewrite is recorded.
   * `0` means no timeout, so the step waits until the distiller answers.
   */
  timeoutMs: number
}

export type { RuleOverride, RuleSource } from './rule.ts'
export type ModelRuleOverride = RuleOverride

/** Persisted plugin configuration. */
export interface Config {
  /** Master switch. */
  enabled: Volatile<boolean>
  /** Rule applied to every model without its own entry. Sparse: unset fields use the built-in default. */
  defaultRule: Volatile<ModelRuleOverride>
  /** Per-model overrides keyed by model id. */
  models: Volatile<Record<string, ModelRuleOverride>>
  /** Where the peak windows come from: `builtin` or `whale`. */
  peakSource: Volatile<string>
  /** Statutory holidays that bill as off-peak all day, as `YYYY-MM-DD` in Beijing time. */
  holidays: Volatile<string[]>
  /** Per-model prices keyed by model id; missing entries fall back to built-ins. */
  prices: Volatile<Record<string, Partial<ModelPrices>>>
  /**
   * Which installed companion applies a rewrite to the session's own history.
   * Empty means none: nothing can carry the distilled text into the transcript,
   * so compression is refused and the master switch is forced off in the panel.
   */
  rewriteBackend: Volatile<string>
  /**
   * How long the host waits for a branch-type backend before giving up and
   * carrying on in the original conversation. `0` waits forever.
   */
  branchTimeoutMs: Volatile<number>
  /**
   * Whether a branch also archives the conversation it replaced. On by default: the
   * branch continues the same work, so the superseded conversation is hidden from the
   * list as soon as the branch is on screen — and stays recoverable from the archive.
   */
  archiveSuperseded: Volatile<boolean>
  /**
   * Whether a conversation that still has background work of its own is left alone.
   *
   * A background job or a subagent run belongs to the conversation that started it, so a
   * branch created mid-work would have to leave that work behind. On (the default), such a
   * conversation is treated as if the reasoning were under the threshold: nothing is
   * distilled and no branch is created. Off, compression runs and the replaced
   * conversation waits to be archived until that work ends.
   */
  skipWhileBusy: Volatile<boolean>
  /** Distillation instruction; empty selects the built-in prompt. */
  prompt: Volatile<string>
  /**
   * Ceiling, in characters, for each part of the distillation input: the
   * reasoning itself, and the tool-call/results block appended after it.
   */
  maxInputChars: Volatile<number>
  /** Ceiling for the distilled text, in characters; `0` disables the ceiling. */
  maxOutputChars: Volatile<number>
}

const DistillRouteSchema = z.object({
  provider: z.string(),
  model: z.string(),
  effort: z.string(),
})

const ModelRuleFields = {
  enabled: z.boolean(),
  continuableSubagents: z.boolean(),
  continuableMaxDepth: z.number(),
  oneShotSubagents: z.boolean(),
  oneShotMaxDepth: z.number(),
  thresholdTokens: z.number(),
  minSavedTokens: z.number(),
  includeToolResults: z.boolean(),
  includeFinalTurns: z.boolean(),
  timeoutMs: z.number(),
  maxInputChars: z.number(),
  maxOutputChars: z.number(),
  distiller: DistillRouteSchema,
}

/**
 * Sparse by construction: a Settings write may set one field of one model, and
 * a partial override must keep inheriting the rest from the default rule rather
 * than freezing today's values into the stored document.
 */
const PriceBucketSchema = z.object({
  hit: z.number(),
  miss: z.number(),
  out: z.number(),
})

/** Built-in rule used when neither the default rule nor an override sets a field. */
export const DEFAULT_RULE: ModelRule = {
  enabled: true,
  continuableSubagents: true,
  continuableMaxDepth: 0,
  oneShotSubagents: false,
  oneShotMaxDepth: 0,
  thresholdTokens: 4000,
  minSavedTokens: 600,
  includeToolResults: true,
  includeFinalTurns: true,
  timeoutMs: 0,
  maxInputChars: 0,
  maxOutputChars: 0,
  distiller: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' },
}

/**
 * 2026 statutory holidays (Beijing dates) that bill as off-peak all day, shipped
 * as the default holiday table and kept in step with the published arrangement.
 */
export const BUILTIN_HOLIDAYS: readonly string[] = [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]

/** Peak prices in 元 per million tokens, from the published DeepSeek price table. */
const BUILTIN_PEAK: Record<string, PriceBucket> = {
  'deepseek-flash': { hit: 0.04, miss: 2, out: 8 },
  'deepseek-v4-pro': { hit: 0.3, miss: 9, out: 27 },
}

/**
 * Factory-default price entries: the built-in DeepSeek routes ship enabled with
 * both columns, so their published peak/off-peak pricing applies out of the box.
 * Every other model starts with no entry at all — no prices and no split — until
 * one is added.
 */
export const DEFAULT_PRICE_ENTRIES: Record<string, ModelPrices> = Object.fromEntries(
  Object.entries(BUILTIN_PEAK).map(([model, peak]) => [model, { peak, off: half(peak), peakPricing: true }]),
)

/** Off-peak is exactly half the peak price in the published table. */
function half(bucket: PriceBucket): PriceBucket {
  return { hit: bucket.hit / 2, miss: bucket.miss / 2, out: bucket.out / 2 }
}

/**
 * Whether distillation is on for a fresh install.
 *
 * Off: the plugin ships inert, so an installation never starts paying for
 * distillations (or branching sessions) before its user asks for it.
 */
export const DEFAULT_ENABLED = false

/** The exported schema; the `id` of this plugin's Loader row is its namespace. */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_ENABLED).volatile(),
  defaultRule: z.object(ModelRuleFields).default(DEFAULT_RULE).volatile(),
  models: z.dict(z.object(ModelRuleFields)).default({}).volatile(),
  peakSource: z.string().default('builtin').volatile(),
  holidays: z.array(z.string()).default([...BUILTIN_HOLIDAYS]).volatile(),
  prices: z.dict(z.object({
    peak: PriceBucketSchema,
    off: PriceBucketSchema,
    peakPricing: z.boolean(),
  })).default(DEFAULT_PRICE_ENTRIES).volatile(),
  rewriteBackend: z.string().default('').volatile(),
  branchTimeoutMs: z.number().default(0).volatile(),
  archiveSuperseded: z.boolean().default(true).volatile(),
  skipWhileBusy: z.boolean().default(true).volatile(),
  prompt: z.string().default('').volatile(),
  // Legacy top-level limit: a document narrowed before limits moved into each rule
  // still resolves through it, and its default is the same "no ceiling" the rule uses.
  maxInputChars: z.number().default(0).volatile(),
  maxOutputChars: z.number().default(0).volatile(),
})

/**
 * Resolve the price table for one model.
 * @param model - model id.
 * @param configured - user overrides keyed by model id.
 * @returns both columns, zero-filled when nothing is known.
 */
export function resolvePrices(
  model: string,
  configured: Record<string, Partial<ModelPrices>> | undefined,
): ModelPrices {
  const user = configured?.[model]
  const base = BUILTIN_PEAK[model]
  const zero: PriceBucket = { hit: 0, miss: 0, out: 0 }
  const peak: PriceBucket = {
    ...(base ?? zero),
    ...(user?.peak ?? {}),
  }
  const off: PriceBucket = {
    ...(user?.off ?? half(peak)),
  }
  return { peak, off }
}

/** Built-in peak prices, exposed to the Settings page. */
export const BUILTIN_PRICES = BUILTIN_PEAK

/**
 * Fold the built-in default, the global default rule, and one model's override
 * into an effective rule.
 * @param model - model id the reasoning came from.
 * @param config - live plugin configuration.
 * @returns the effective rule.
 */
export { withKindDefaults } from './rule.ts'

export function resolveRule(model: string, config: RuleSource): ModelRule {
  const legacy = legacyOneShotSwitch(config)
  const limits = {
    ...config.maxInputChars?.get() === undefined ? {} : { maxInputChars: config.maxInputChars.get() as number },
    ...config.maxOutputChars?.get() === undefined ? {} : { maxOutputChars: config.maxOutputChars.get() as number },
  }
  // The retired top-level limits are the LOWEST layer, below the built-in rule:
  // the stored layers above are sparse, so injecting the legacy value into them
  // would let it — including the schema's own `0` default — shadow a ceiling the
  // user set in the default rule or on one model. Sitting underneath, it still
  // applies whenever no stored layer states a ceiling, which is what a document
  // saved before the move relies on.
  return mergeRule(
    { ...DEFAULT_RULE, ...limits },
    withKindDefaults(config.defaultRule.get() ?? {}, legacy),
    withKindDefaults(config.models.get()?.[model] ?? {}, legacy),
  )
}
