import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region ../../deepseek-harness/vendor/cosmokit/lib/types/misc.d.ts
/** String/symbol keyed dictionary type. */
type Dict<T = any, K extends string | symbol = string> = { [key in K]: T; };
//#endregion
//#region ../../deepseek-harness/vendor/cosmokit/lib/types/volatile.d.ts
/** Shared config references used by schema validators and plugin runtimes. */
/** Recursively readonly data returned by a volatile config reference. */
type VolatileSnapshot<T> = T extends object ? { readonly [K in keyof T]: VolatileSnapshot<T[K]>; } : T;
/** A stable reference; keep the reference, or capture its value for one operation only. */
interface Volatile<T> {
  /** @returns the current immutable snapshot, including undefined for an absent value. */
  get(): VolatileSnapshot<T>;
}
//#endregion
//#region src/rule.d.ts
/** Sparse stored form of a {@link ModelRule}: unset fields keep inheriting. */
type RuleOverride = Partial<Omit<ModelRule, 'distiller'>> & {
  distiller?: Partial<DistillRoute>;
};
//#endregion
//#region src/config.d.ts
/** One API price bucket, in currency units per million tokens. */
interface PriceBucket {
  /** Input billed against a cache hit. */
  hit: number;
  /** Input billed without a cache hit. */
  miss: number;
  /** Model output (reasoning tokens are output tokens). */
  out: number;
}
/** One model's price entry: two columns plus whether the second is used at all. */
interface ModelPrices {
  /** The price actually used when peak pricing is off. */
  peak: PriceBucket;
  /** Second column; only consulted when {@link ModelPrices.peakPricing} is set. */
  off: PriceBucket;
  /** Whether this model's cost is attributed across the two columns. Pricing, not model behaviour. */
  peakPricing?: boolean;
}
/** The model route one distillation request runs on. */
interface DistillRoute {
  provider: string;
  model: string;
  /** Adapter-owned reasoning effort; `off` disables thinking for the distiller. */
  effort: string;
}
/** Per-model (or default) trigger and distiller policy. */
interface ModelRule {
  /** Whether this model's reasoning is distilled in ordinary conversation. */
  enabled: boolean;
  /**
   * Whether it is also distilled inside a resumable subagent child (a teammate,
   * for instance). Those keep replaying their own reasoning, so they earn their
   * keep like a conversation does.
   */
  continuableSubagents: boolean;
  /**
   * Deepest delegation for {@link ModelRule.continuableSubagents}: a child nested
   * deeper than this is left alone. `0` means no limit.
   */
  continuableMaxDepth: number;
  /**
   * Whether it is distilled inside a terminal one-shot subagent run. Off by
   * default: the delegation is short and never resumed, so its final answer pays
   * for a distillation nothing replays.
   */
  oneShotSubagents: boolean;
  /**
   * Deepest delegation for {@link ModelRule.oneShotSubagents}: a child nested
   * deeper than this is left alone. `0` means no limit.
   */
  oneShotMaxDepth: number;
  /** Trigger above this many estimated reasoning tokens. */
  thresholdTokens: number;
  /** Replace only when the distilled text saves at least this many estimated tokens. */
  minSavedTokens: number;
  /**
   * Append the step's tool results after its tool calls. The calls themselves
   * are always sent; only the results are optional.
   */
  includeToolResults: boolean;
  /** Distill the reasoning of steps that requested no tool call (final answers). */
  includeFinalTurns: boolean;
  /** Longest single context block (a tool result, say) handed to the distiller; 0 = no bound. */
  maxInputChars: number;
  /** Longest distillation result accepted; 0 = no bound. */
  maxOutputChars: number;
  distiller: DistillRoute;
  /**
   * One value for both sides of the wait: the distillation must finish within
   * this, and the step waits exactly that long. Hitting it abandons this
   * compression — the reasoning stays untouched and no rewrite is recorded.
   * `0` means no timeout, so the step waits until the distiller answers.
   */
  timeoutMs: number;
}
type ModelRuleOverride = RuleOverride;
/** Persisted plugin configuration. */
interface Config {
  /** Master switch. */
  enabled: Volatile<boolean>;
  /** Rule applied to every model without its own entry. Sparse: unset fields use the built-in default. */
  defaultRule: Volatile<ModelRuleOverride>;
  /** Per-model overrides keyed by model id. */
  models: Volatile<Record<string, ModelRuleOverride>>;
  /** Where the peak windows come from: `builtin` or `whale`. */
  peakSource: Volatile<string>;
  /** Statutory holidays that bill as off-peak all day, as `YYYY-MM-DD` in Beijing time. */
  holidays: Volatile<string[]>;
  /** Per-model prices keyed by model id; missing entries fall back to built-ins. */
  prices: Volatile<Record<string, Partial<ModelPrices>>>;
  /**
   * Which installed companion applies a rewrite to the session's own history.
   * Empty means none: nothing can carry the distilled text into the transcript,
   * so compression is refused and the master switch is forced off in the panel.
   */
  rewriteBackend: Volatile<string>;
  /**
   * How long the host waits for a branch-type backend before giving up and
   * carrying on in the original conversation. `0` waits forever.
   */
  branchTimeoutMs: Volatile<number>;
  /** Distillation instruction; empty selects the built-in prompt. */
  prompt: Volatile<string>;
  /**
   * Ceiling, in characters, for each part of the distillation input: the
   * reasoning itself, and the tool-call/results block appended after it.
   */
  maxInputChars: Volatile<number>;
  /** Ceiling for the distilled text, in characters; `0` disables the ceiling. */
  maxOutputChars: Volatile<number>;
}
/** The exported schema; the `id` of this plugin's Loader row is its namespace. */
declare const Config: z<Schemastery.ObjectS<NoInfer<{
  enabled: z<boolean, boolean, "volatile-defined">;
  defaultRule: z<NoInfer<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "plain">;
    continuableSubagents: z<boolean, boolean, "plain">;
    continuableMaxDepth: z<number, number, "plain">;
    oneShotSubagents: z<boolean, boolean, "plain">;
    oneShotMaxDepth: z<number, number, "plain">;
    thresholdTokens: z<number, number, "plain">;
    minSavedTokens: z<number, number, "plain">;
    includeToolResults: z<boolean, boolean, "plain">;
    includeFinalTurns: z<boolean, boolean, "plain">;
    timeoutMs: z<number, number, "plain">;
    maxInputChars: z<number, number, "plain">;
    maxOutputChars: z<number, number, "plain">;
    distiller: z<Schemastery.ObjectS<NoInfer<{
      provider: z<string, string, "plain">;
      model: z<string, string, "plain">;
      effort: z<string, string, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
      provider: z<string, string, "plain">;
      model: z<string, string, "plain">;
      effort: z<string, string, "plain">;
    }>>, "plain">;
  }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "plain">;
    continuableSubagents: z<boolean, boolean, "plain">;
    continuableMaxDepth: z<number, number, "plain">;
    oneShotSubagents: z<boolean, boolean, "plain">;
    oneShotMaxDepth: z<number, number, "plain">;
    thresholdTokens: z<number, number, "plain">;
    minSavedTokens: z<number, number, "plain">;
    includeToolResults: z<boolean, boolean, "plain">;
    includeFinalTurns: z<boolean, boolean, "plain">;
    timeoutMs: z<number, number, "plain">;
    maxInputChars: z<number, number, "plain">;
    maxOutputChars: z<number, number, "plain">;
    distiller: z<Schemastery.ObjectS<NoInfer<{
      provider: z<string, string, "plain">;
      model: z<string, string, "plain">;
      effort: z<string, string, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
      provider: z<string, string, "plain">;
      model: z<string, string, "plain">;
      effort: z<string, string, "plain">;
    }>>, "plain">;
  }>>>, "volatile-defined">;
  models: z<NoInfer<Dict<{
    enabled?: boolean | null | undefined;
    continuableSubagents?: boolean | null | undefined;
    continuableMaxDepth?: number | null | undefined;
    oneShotSubagents?: boolean | null | undefined;
    oneShotMaxDepth?: number | null | undefined;
    thresholdTokens?: number | null | undefined;
    minSavedTokens?: number | null | undefined;
    includeToolResults?: boolean | null | undefined;
    includeFinalTurns?: boolean | null | undefined;
    timeoutMs?: number | null | undefined;
    maxInputChars?: number | null | undefined;
    maxOutputChars?: number | null | undefined;
    distiller?: ({
      provider?: string | null | undefined;
      model?: string | null | undefined;
      effort?: string | null | undefined;
    } & Dict) | null | undefined;
  } & Dict, string>>, NoInfer<Dict<Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "plain">;
    continuableSubagents: z<boolean, boolean, "plain">;
    continuableMaxDepth: z<number, number, "plain">;
    oneShotSubagents: z<boolean, boolean, "plain">;
    oneShotMaxDepth: z<number, number, "plain">;
    thresholdTokens: z<number, number, "plain">;
    minSavedTokens: z<number, number, "plain">;
    includeToolResults: z<boolean, boolean, "plain">;
    includeFinalTurns: z<boolean, boolean, "plain">;
    timeoutMs: z<number, number, "plain">;
    maxInputChars: z<number, number, "plain">;
    maxOutputChars: z<number, number, "plain">;
    distiller: z<Schemastery.ObjectS<NoInfer<{
      provider: z<string, string, "plain">;
      model: z<string, string, "plain">;
      effort: z<string, string, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
      provider: z<string, string, "plain">;
      model: z<string, string, "plain">;
      effort: z<string, string, "plain">;
    }>>, "plain">;
  }>>, string>>, "volatile-defined">;
  peakSource: z<string, string, "volatile-defined">;
  holidays: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
  prices: z<NoInfer<Dict<{
    peak?: ({
      hit?: number | null | undefined;
      miss?: number | null | undefined;
      out?: number | null | undefined;
    } & Dict) | null | undefined;
    off?: ({
      hit?: number | null | undefined;
      miss?: number | null | undefined;
      out?: number | null | undefined;
    } & Dict) | null | undefined;
    peakPricing?: boolean | null | undefined;
  } & Dict, string>>, NoInfer<Dict<Schemastery.ObjectT<NoInfer<{
    peak: z<Schemastery.ObjectS<NoInfer<{
      hit: z<number, number, "plain">;
      miss: z<number, number, "plain">;
      out: z<number, number, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
      hit: z<number, number, "plain">;
      miss: z<number, number, "plain">;
      out: z<number, number, "plain">;
    }>>, "plain">;
    off: z<Schemastery.ObjectS<NoInfer<{
      hit: z<number, number, "plain">;
      miss: z<number, number, "plain">;
      out: z<number, number, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
      hit: z<number, number, "plain">;
      miss: z<number, number, "plain">;
      out: z<number, number, "plain">;
    }>>, "plain">;
    peakPricing: z<boolean, boolean, "plain">;
  }>>, string>>, "volatile-defined">;
  rewriteBackend: z<string, string, "volatile-defined">;
  branchTimeoutMs: z<number, number, "volatile-defined">;
  prompt: z<string, string, "volatile-defined">;
  maxInputChars: z<number, number, "volatile-defined">;
  maxOutputChars: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  enabled: z<boolean, boolean, "volatile-defined">;
  defaultRule: z<NoInfer<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "plain">;
    continuableSubagents: z<boolean, boolean, "plain">;
    continuableMaxDepth: z<number, number, "plain">;
    oneShotSubagents: z<boolean, boolean, "plain">;
    oneShotMaxDepth: z<number, number, "plain">;
    thresholdTokens: z<number, number, "plain">;
    minSavedTokens: z<number, number, "plain">;
    includeToolResults: z<boolean, boolean, "plain">;
    includeFinalTurns: z<boolean, boolean, "plain">;
    timeoutMs: z<number, number, "plain">;
    maxInputChars: z<number, number, "plain">;
    maxOutputChars: z<number, number, "plain">;
    distiller: z<Schemastery.ObjectS<NoInfer<{
      provider: z<string, string, "plain">;
      model: z<string, string, "plain">;
      effort: z<string, string, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
      provider: z<string, string, "plain">;
      model: z<string, string, "plain">;
      effort: z<string, string, "plain">;
    }>>, "plain">;
  }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "plain">;
    continuableSubagents: z<boolean, boolean, "plain">;
    continuableMaxDepth: z<number, number, "plain">;
    oneShotSubagents: z<boolean, boolean, "plain">;
    oneShotMaxDepth: z<number, number, "plain">;
    thresholdTokens: z<number, number, "plain">;
    minSavedTokens: z<number, number, "plain">;
    includeToolResults: z<boolean, boolean, "plain">;
    includeFinalTurns: z<boolean, boolean, "plain">;
    timeoutMs: z<number, number, "plain">;
    maxInputChars: z<number, number, "plain">;
    maxOutputChars: z<number, number, "plain">;
    distiller: z<Schemastery.ObjectS<NoInfer<{
      provider: z<string, string, "plain">;
      model: z<string, string, "plain">;
      effort: z<string, string, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
      provider: z<string, string, "plain">;
      model: z<string, string, "plain">;
      effort: z<string, string, "plain">;
    }>>, "plain">;
  }>>>, "volatile-defined">;
  models: z<NoInfer<Dict<{
    enabled?: boolean | null | undefined;
    continuableSubagents?: boolean | null | undefined;
    continuableMaxDepth?: number | null | undefined;
    oneShotSubagents?: boolean | null | undefined;
    oneShotMaxDepth?: number | null | undefined;
    thresholdTokens?: number | null | undefined;
    minSavedTokens?: number | null | undefined;
    includeToolResults?: boolean | null | undefined;
    includeFinalTurns?: boolean | null | undefined;
    timeoutMs?: number | null | undefined;
    maxInputChars?: number | null | undefined;
    maxOutputChars?: number | null | undefined;
    distiller?: ({
      provider?: string | null | undefined;
      model?: string | null | undefined;
      effort?: string | null | undefined;
    } & Dict) | null | undefined;
  } & Dict, string>>, NoInfer<Dict<Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "plain">;
    continuableSubagents: z<boolean, boolean, "plain">;
    continuableMaxDepth: z<number, number, "plain">;
    oneShotSubagents: z<boolean, boolean, "plain">;
    oneShotMaxDepth: z<number, number, "plain">;
    thresholdTokens: z<number, number, "plain">;
    minSavedTokens: z<number, number, "plain">;
    includeToolResults: z<boolean, boolean, "plain">;
    includeFinalTurns: z<boolean, boolean, "plain">;
    timeoutMs: z<number, number, "plain">;
    maxInputChars: z<number, number, "plain">;
    maxOutputChars: z<number, number, "plain">;
    distiller: z<Schemastery.ObjectS<NoInfer<{
      provider: z<string, string, "plain">;
      model: z<string, string, "plain">;
      effort: z<string, string, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
      provider: z<string, string, "plain">;
      model: z<string, string, "plain">;
      effort: z<string, string, "plain">;
    }>>, "plain">;
  }>>, string>>, "volatile-defined">;
  peakSource: z<string, string, "volatile-defined">;
  holidays: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
  prices: z<NoInfer<Dict<{
    peak?: ({
      hit?: number | null | undefined;
      miss?: number | null | undefined;
      out?: number | null | undefined;
    } & Dict) | null | undefined;
    off?: ({
      hit?: number | null | undefined;
      miss?: number | null | undefined;
      out?: number | null | undefined;
    } & Dict) | null | undefined;
    peakPricing?: boolean | null | undefined;
  } & Dict, string>>, NoInfer<Dict<Schemastery.ObjectT<NoInfer<{
    peak: z<Schemastery.ObjectS<NoInfer<{
      hit: z<number, number, "plain">;
      miss: z<number, number, "plain">;
      out: z<number, number, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
      hit: z<number, number, "plain">;
      miss: z<number, number, "plain">;
      out: z<number, number, "plain">;
    }>>, "plain">;
    off: z<Schemastery.ObjectS<NoInfer<{
      hit: z<number, number, "plain">;
      miss: z<number, number, "plain">;
      out: z<number, number, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
      hit: z<number, number, "plain">;
      miss: z<number, number, "plain">;
      out: z<number, number, "plain">;
    }>>, "plain">;
    peakPricing: z<boolean, boolean, "plain">;
  }>>, string>>, "volatile-defined">;
  rewriteBackend: z<string, string, "volatile-defined">;
  branchTimeoutMs: z<number, number, "volatile-defined">;
  prompt: z<string, string, "volatile-defined">;
  maxInputChars: z<number, number, "volatile-defined">;
  maxOutputChars: z<number, number, "volatile-defined">;
}>>, "plain">;
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "reasoning-distill";
/** Services required before the engine can observe sessions. */
declare const inject: string[];
/**
 * Plugin body.
 * @param ctx - host context.
 * @param config - validated {@link PluginConfig}.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, type Config as ReasoningDistillConfig, apply, inject, name };