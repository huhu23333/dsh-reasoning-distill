/**
 * Rule merging, shared by the host resolver and the Settings page.
 *
 * The panel must show exactly what the engine will apply, so both sides fold the
 * same three layers in the same order through this one implementation. Writing a
 * per-model rule the other way round — snapshotting the inherited values — is
 * what let a displayed `enabled: false` disagree with a runtime `true`.
 * @module dsh-reasoning-distill/rule
 */

import type { DistillRoute, ModelRule } from './config.ts'

/** The slice of configuration that rule resolution reads. */
export interface RuleSource {
  defaultRule: { get(): RuleOverride | undefined }
  models: { get(): Record<string, RuleOverride> | undefined }
  /** Retired top-level limits; present only in documents saved before the move. */
  maxInputChars?: { get(): number | undefined }
  maxOutputChars?: { get(): number | undefined }
}

/** Sparse stored form of a {@link ModelRule}: unset fields keep inheriting. */
export type RuleOverride = Partial<Omit<ModelRule, 'distiller'>> & { distiller?: Partial<DistillRoute> }

/**
 * Fold a fallback rule, a base override, and one model's override.
 * @param fallback - the shipped rule, used for fields no layer sets.
 * @param base - the default rule.
 * @param override - one model's sparse override.
 * @returns the effective rule.
 */
export function mergeRule(
  fallback: ModelRule,
  base: RuleOverride | undefined,
  override: RuleOverride | undefined,
): ModelRule {
  return {
    ...fallback,
    ...base,
    ...override,
    distiller: {
      ...fallback.distiller,
      ...(base?.distiller ?? {}),
      ...(override?.distiller ?? {}),
    },
  }
}

/** Both subagent switches, stated off: how one rule layer pins a kind a backend cannot serve. */
export interface SubagentKindsOff {
  continuableSubagents: false
  oneShotSubagents: false
}

/**
 * The two subagent switches, off.
 *
 * Stating them is what pins them: a layer that leaves a kind switch out keeps inheriting it —
 * from the built-in rule, where `continuableSubagents` is on, or from its own `enabled` through
 * {@link withKindDefaults} — so an absent field cannot take a kind out of play.
 */
export const SUBAGENT_KINDS_OFF: SubagentKindsOff = {
  continuableSubagents: false,
  oneShotSubagents: false,
}

/**
 * One stored layer with both subagent switches stated off.
 *
 * Generic in the layer's own type so a fully resolved rule stays assignable to itself: the panel
 * edits resolved rules and sparse overrides with the same call.
 * @param rule - the layer being pinned.
 * @returns a copy that pins both kinds and changes nothing else.
 */
export function withSubagentKindsOff<T extends RuleOverride>(rule: T): T & SubagentKindsOff {
  return { ...rule, ...SUBAGENT_KINDS_OFF }
}

/** What to write to take both subagent switches out of a backend's way. */
export interface SubagentKindsOffPatch {
  defaultRule: SubagentKindsOff
  models?: Record<string, SubagentKindsOff>
}

/**
 * The rule-layer patch that pins both subagent switches off wherever they could be on.
 *
 * `settings.update` merges plain objects recursively, so each layer here states only the two
 * switches and leaves every other stored field alone. The default layer is always stated, because
 * the built-in rule has the continuable kind on and an absent field would inherit it; a model
 * layer is stated whenever it does not already pin both off, because a layer whose own `enabled`
 * is true and which states neither kind switch would otherwise still derive the continuable kind
 * on and shadow the default layer's answer.
 * @param defaultRule - the stored default layer.
 * @param models - the stored per-model layers.
 * @returns the patch to write, or undefined when every layer already pins both off.
 */
export function subagentKindsOffPatch(
  defaultRule: RuleOverride | undefined,
  models: Record<string, RuleOverride> | undefined,
): SubagentKindsOffPatch | undefined {
  const pinned = (rule: RuleOverride | undefined): boolean =>
    rule !== undefined && rule.continuableSubagents === false && rule.oneShotSubagents === false
  const entries = Object.entries(models ?? {}).filter(([, rule]) => !pinned(rule))
  if (pinned(defaultRule) && entries.length === 0) return undefined
  return {
    defaultRule: { ...SUBAGENT_KINDS_OFF },
    ...entries.length === 0 ? {} : {
      models: Object.fromEntries(entries.map(([id]) => [id, { ...SUBAGENT_KINDS_OFF }])),
    },
  }
}

/**
 * Reduce a resolved rule to the fields that differ from what it would inherit.
 *
 * Keeping the stored override sparse is what preserves the documented contract:
 * a field the user never touched keeps following the default rule instead of
 * being frozen at today's value.
 * @param inherited - the rule this model would resolve to without its override.
 * @param next - the rule the panel now shows.
 * @returns only the differing fields.
 */
export function sparseOverride(inherited: ModelRule, next: ModelRule): RuleOverride {
  const override: RuleOverride = {}
  for (const key of Object.keys(inherited) as (keyof ModelRule)[]) {
    if (key === 'distiller') continue
    if (JSON.stringify(inherited[key]) === JSON.stringify(next[key])) continue
    // The keys are homogeneous value fields; the cast only carries that fact.
    ;(override as Record<string, unknown>)[key] = next[key]
  }
  const distiller: Partial<DistillRoute> = {}
  for (const key of Object.keys(inherited.distiller) as (keyof DistillRoute)[]) {
    if (inherited.distiller[key] === next.distiller[key]) continue
    ;(distiller as Record<string, unknown>)[key] = next.distiller[key]
  }
  if (Object.keys(distiller).length > 0) override.distiller = distiller
  // A stored layer that states `enabled` but neither kind switch is ambiguous:
  // it is exactly the shape an old document has, so the resolver would derive
  // the switches from `enabled` instead of letting them inherit. Writing them
  // explicitly keeps every layer this panel saves unambiguous.
  if (Object.keys(override).length > 0
    && Object.hasOwn(override, 'enabled')
    && !Object.hasOwn(override, 'continuableSubagents')
    && !Object.hasOwn(override, 'oneShotSubagents')) {
    override.continuableSubagents = next.continuableSubagents
    override.oneShotSubagents = next.oneShotSubagents
  }
  return override
}

/**
 * The client-side fallback rule. It must equal the host's `DEFAULT_RULE`; the two
 * are pinned against each other by tests, because a panel that renders different
 * defaults than the engine applies is how a setting silently flips.
 */
export const FALLBACK_RULE: ModelRule = {
  enabled: true, continuableSubagents: true, continuableMaxDepth: 0,
  oneShotSubagents: false, oneShotMaxDepth: 0,
  thresholdTokens: 4000, contextCap: true, maxContextPercent: 60, minSavedTokens: 600,
  includeToolResults: true, includeFinalTurns: true, timeoutMs: 0,
  maxInputChars: 0, maxOutputChars: 0,
  distiller: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' },
}

/**
 * Fill the per-kind switches of one stored rule that predates them.
 *
 * Before the three switches existed a rule's `enabled` was the master switch for
 * main conversations *and* resumable children, while a global flag covered
 * one-shot children. A stored rule that never mentions the new fields must keep
 * behaving exactly that way, otherwise an existing config silently starts paying
 * for sessions it had excluded. Once the panel saves the fields they are present
 * and this derivation stops applying.
 *
 * Shared with the Settings page on purpose: if the panel rendered the fallback
 * defaults instead, saving any unrelated field would write the derived value back
 * and permanently lose the stored intent.
 * @param rule - one stored rule layer.
 * @param legacyOneShot - the retired global one-shot switch, when the document still carries it.
 * @returns the layer with the per-kind switches resolved.
 */
export function withKindDefaults(
  rule: RuleOverride,
  legacyOneShot: boolean | undefined,
): RuleOverride {
  const resolved: RuleOverride = { ...rule }
  // A layer that states either kind switch belongs to the new shape: it is used
  // verbatim and the switch it leaves out keeps inheriting. Deriving here would
  // pin that switch and silently disable an inherited kind.
  if (Object.hasOwn(rule, 'continuableSubagents') || Object.hasOwn(rule, 'oneShotSubagents')) return resolved
  // Only a layer that actually states `enabled` has an opinion to derive from.
  // Deriving in a layer that says nothing would inject a value that then shadows
  // the layer below it.
  if (!Object.hasOwn(rule, 'enabled')) return resolved
  if (!Object.hasOwn(rule, 'continuableSubagents')) {
    resolved.continuableSubagents = rule.enabled ?? FALLBACK_RULE.continuableSubagents
  }
  if (!Object.hasOwn(rule, 'oneShotSubagents')) {
    resolved.oneShotSubagents = legacyOneShot ?? FALLBACK_RULE.oneShotSubagents
  }
  return resolved
}

/** The retired global one-shot switch, if a document still carries it. */
export function legacyOneShotSwitch(holder: unknown): boolean | undefined {
  const legacy = (holder as { compressSubagents?: { get(): unknown } } | undefined)?.compressSubagents?.get()
  return typeof legacy === 'boolean' ? legacy : undefined
}
