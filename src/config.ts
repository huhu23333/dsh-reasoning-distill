/**
 * Plugin configuration: the Settings page schema plus the runtime resolver that
 * folds built-in defaults, the global default rule, and one model's own rule.
 * @module dsh-reasoning-distill/config
 */

import type { Volatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'

import { DEFAULT_PRICE_ENTRIES, type ModelPrices } from './prices.ts'
import { legacyOneShotSwitch, mergeRule, withKindDefaults, type RuleOverride, type RuleSource } from './rule.ts'

export type { ModelPrices, PriceBucket } from './prices.ts'
export { BUILTIN_PEAK, BUILTIN_PRICES, DEFAULT_PRICE_ENTRIES, peakEnabled, resolvePrices } from './prices.ts'

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
  /**
   * Whether the context-occupancy cap applies. On by default: a rewrite that only
   * survives a few turns before the host's own compaction folds the conversation
   * away is a net loss, so a step is also skipped once the conversation is this full.
   */
  contextCap: boolean
  /**
   * Highest context occupancy, as a percentage of the routed model's context
   * window, at which a compression may still trigger. Occupancy is the host token
   * meter's measurement — the same one its compaction trigger reads — so a
   * compaction lowers it immediately. Only consulted while {@link contextCap} is on.
   */
  maxContextPercent: number
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
  contextCap: z.boolean(),
  maxContextPercent: z.number(),
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
  continuableSubagents: false,
  continuableMaxDepth: 0,
  oneShotSubagents: false,
  oneShotMaxDepth: 0,
  thresholdTokens: 4000,
  contextCap: true,
  maxContextPercent: 60,
  minSavedTokens: 600,
  includeToolResults: false,
  includeFinalTurns: false,
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
  // Sparse default: an absent layer must resolve as "nothing stated", not as a
  // full DEFAULT_RULE snapshot. The snapshot would sit ABOVE the retired
  // top-level limits and shadow them, and it would also freeze today's defaults
  // into every later resolution.
  defaultRule: z.object(ModelRuleFields).default({}).volatile(),
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
  prompt: z.string().default('').volatile(),
  // Legacy top-level limit: a document narrowed before limits moved into each rule
  // still resolves through it, and its default is the same "no ceiling" the rule uses.
  maxInputChars: z.number().default(0).volatile(),
  maxOutputChars: z.number().default(0).volatile(),
})

/**
 * Fold the built-in default, the global default rule, and one model's override
 * into an effective rule.
 * @param model - model id the reasoning came from.
 * @param config - live plugin configuration.
 * @returns the effective rule.
 */
export { withKindDefaults } from './rule.ts'

/**
 * Clamp one resolved rule's loose numbers.
 *
 * The settings schema is deliberately permissive (`z.number()` only), so a
 * hand-edited or older document can carry `null`, negative or out-of-range
 * values. Those are not "large" or "small" settings — they invert decisions
 * (`saved < null` is `saved < 0`, a 0% occupancy cap refuses everything), so
 * the resolver normalizes them to the shipped defaults / documented bounds.
 * @param rule - merged rule.
 * @returns the rule with finite, in-range numbers and boolean switches.
 */
export function sanitizeRule(rule: ModelRule): ModelRule {
  const finite = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const clamp = (value: unknown, fallback: number, min: number, max = Number.POSITIVE_INFINITY): number =>
    Math.min(max, Math.max(min, finite(value, fallback)))
  const flag = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback
  const sanitized: ModelRule = {
    ...rule,
    enabled: flag(rule.enabled, DEFAULT_RULE.enabled),
    continuableSubagents: flag(rule.continuableSubagents, DEFAULT_RULE.continuableSubagents),
    oneShotSubagents: flag(rule.oneShotSubagents, DEFAULT_RULE.oneShotSubagents),
    contextCap: flag(rule.contextCap, DEFAULT_RULE.contextCap),
    includeToolResults: flag(rule.includeToolResults, DEFAULT_RULE.includeToolResults),
    includeFinalTurns: flag(rule.includeFinalTurns, DEFAULT_RULE.includeFinalTurns),
    continuableMaxDepth: clamp(rule.continuableMaxDepth, DEFAULT_RULE.continuableMaxDepth, 0),
    oneShotMaxDepth: clamp(rule.oneShotMaxDepth, DEFAULT_RULE.oneShotMaxDepth, 0),
    thresholdTokens: clamp(rule.thresholdTokens, DEFAULT_RULE.thresholdTokens, 0),
    minSavedTokens: clamp(rule.minSavedTokens, DEFAULT_RULE.minSavedTokens, 0),
    timeoutMs: clamp(rule.timeoutMs, DEFAULT_RULE.timeoutMs, 0),
    maxInputChars: clamp(rule.maxInputChars, DEFAULT_RULE.maxInputChars, 0),
    maxOutputChars: clamp(rule.maxOutputChars, DEFAULT_RULE.maxOutputChars, 0),
    maxContextPercent: clamp(rule.maxContextPercent, DEFAULT_RULE.maxContextPercent, 1, 100),
    distiller: {
      provider: typeof rule.distiller?.provider === 'string' ? rule.distiller.provider : DEFAULT_RULE.distiller.provider,
      model: typeof rule.distiller?.model === 'string' ? rule.distiller.model : DEFAULT_RULE.distiller.model,
      effort: typeof rule.distiller?.effort === 'string' ? rule.distiller.effort : DEFAULT_RULE.distiller.effort,
    },
  }
  return sanitized
}

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
  return sanitizeRule(mergeRule(
    { ...DEFAULT_RULE, ...limits },
    withKindDefaults(config.defaultRule.get() ?? {}, legacy),
    withKindDefaults(config.models.get()?.[model] ?? {}, legacy),
  ))
}
