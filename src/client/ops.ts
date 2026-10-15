/**
 * Settings write planning, kept free of React so it can be tested directly.
 *
 * Two rules make concurrent editing safe:
 *
 *  1. A save is diffed against the value its draft came from — never against the
 *     latest host value — so a field this user never touched is not written back
 *     from a stale draft.
 *  2. The diff recurses into records and writes **field-level** operations, so a
 *     change here never rewrites a sibling field another client changed inside
 *     the same model or price entry.
 * @module dsh-reasoning-distill/client/ops
 */

import type { ModelPrices, ModelRule } from '../config.ts'
import { FALLBACK_RULE, mergeRule, withKindDefaults, withLimitDefaults, type RuleOverride, type RuleSource } from '../rule.ts'
import { backendById } from '../backends.ts'
import { entryInForceHere, type CompressionEntry, type SessionReport } from '../shared.ts'

/** Sparse per-model rule as stored, matching what the host schema accepts. */
export type StoredRule = RuleOverride

/**
 * Whether a rule decides nothing because all three session kinds are off, in
 * which case the rest of its fields are locked in the panel.
 * @param rule - the rule being edited.
 * @returns true when every kind switch is off.
 */
export function ruleFieldsIdle(rule: StoredRule): boolean {
  return rule.enabled !== true && rule.continuableSubagents !== true && rule.oneShotSubagents !== true
}

/**
 * Whether a subagent kind's depth cap is not editable because that kind is off.
 *
 * Each cap follows its OWN switch, not the rule-wide idle state: a rule with only
 * main conversations enabled still shows both caps locked.
 * @param rule - the rule being edited.
 * @returns true when that kind's switch is off.
 */
export function continuableDepthDisabled(rule: StoredRule): boolean {
  return rule.continuableSubagents !== true
}

/** @see continuableDepthDisabled for the one-shot kind. */
export function oneShotDepthDisabled(rule: StoredRule): boolean {
  return rule.oneShotSubagents !== true
}

/**
 * Normalize one stored settings document for display and editing.
 *
 * Applies the same legacy derivation the engine resolver applies, so the panel
 * shows what will actually run. Without it a stored `{ enabled: false }` renders
 * as the fallback defaults and saving anything writes the derived value back,
 * permanently changing behaviour the user never touched.
 * @param value - the stored document.
 * @param legacyOneShot - the retired global one-shot switch, when still present.
 * @returns a draft whose rule layers match the engine's resolution.
 */
export function normalizeSettings(value: SettingsValue, legacyOneShot?: boolean): SettingsValue {
  // Limits moved from the top level into each rule; a document saved before the
  // move still carries them outside, and the panel must resolve them exactly the
  // way the host does, or it would show (and then persist) the wrong value.
  const legacyLimits = {
    ...typeof value.maxInputChars === 'number' ? { maxInputChars: value.maxInputChars } : {},
    ...typeof value.maxOutputChars === 'number' ? { maxOutputChars: value.maxOutputChars } : {},
  }
  const models: Record<string, StoredRule> = {}
  for (const [id, override] of Object.entries(value.models ?? {})) {
    models[id] = withLimitDefaults(withKindDefaults(override, legacyOneShot), legacyLimits)
  }
  return {
    ...value,
    defaultRule: mergeRule(FALLBACK_RULE, withLimitDefaults(withKindDefaults(value.defaultRule ?? {}, legacyOneShot), legacyLimits), undefined),
    models,
    peakSource: value.peakSource ?? 'builtin',
    rewriteBackend: value.rewriteBackend ?? '',
    branchTimeoutMs: value.branchTimeoutMs ?? 0,
    // On by default: the branch continues the same work, so the conversation it
    // replaced belongs in the archive unless the user says otherwise.
    archiveSuperseded: value.archiveSuperseded ?? true,
    // On by default too: a branch cannot take background work with it.
    skipWhileBusy: value.skipWhileBusy ?? true,
    holidays: [...(value.holidays ?? [])],
    prices: structuredClone(value.prices ?? {}),
    prompt: value.prompt ?? '',
  }
}

/**
 * Whether a poll response arrived too late to be applied.
 *
 * Compared against the last *applied* request, never against the newest issued
 * one: a request slower than the poll interval would otherwise be discarded
 * forever, leaving the panel permanently stale.
 * @param request - the id of the response being considered.
 * @param applied - the id of the newest response already applied.
 * @returns true when this response must be ignored.
 */
export function isStaleResponse(request: number, applied: number): boolean {
  return request <= applied
}

/**
 * Build the request `dsh-message-edit` accepts for editing one message block.
 *
 * That plugin (an optional companion) turns an edit into a NEW session version,
 * leaving the original untouched — which is the only supported way to make a
 * history carry the distilled reasoning. Returns undefined when this rewrite
 * cannot be expressed as a block edit.
 * @param sessionId - the session that owns the rewrite.
 * @param entry - the recorded compression.
 * @param text - replacement text for the reasoning block.
 * @param cascade - what the companion should do with later turns.
 * @returns the JSON body, or undefined when there is nothing to edit.
 */
export function messageEditRequest(
  sessionId: string,
  entry: { targetSeq: number; targetBlockIndex: number },
  text: string,
  cascade: 'truncate' | 'preserve' = 'truncate',
): Record<string, unknown> | undefined {
  if (sessionId === '' || entry.targetBlockIndex < 0 || text === '') return undefined
  return { action: 'edit', sessionId, eventSeq: entry.targetSeq, blockIndex: entry.targetBlockIndex, text, cascade }
}

export {
  REWRITE_BACKENDS, backendById, backendInstalled, backendOptionsVisible, masterSwitchState, nextBackend, rewriteRequest,
} from '../backends.ts'
export type { ProbeAnswer, RewriteBackend } from '../backends.ts'

/** Get this tab's storage without letting a blocked property getter crash the panel. */
export function availableSessionStorage(source: Pick<Window, 'sessionStorage'> = window): Storage | undefined {
  try {
    return source.sessionStorage
  } catch {
    return undefined
  }
}

/** Read the result of a backend request made by this tab before its next settle. */
export function pendingRewriteOutcome(storage: Pick<Storage, 'getItem'> | undefined, key: string): { error?: string; claimed?: number } | undefined {
  try {
    const saved = storage?.getItem(`reasoning-distill:handoff:${key}`)
    if (saved == null) return undefined
    const value: unknown = JSON.parse(saved)
    if (value === null || typeof value !== 'object') return undefined
    const record = value as { error?: unknown; claimed?: unknown }
    if (record.claimed !== undefined) {
      return typeof record.claimed === 'number' && Number.isFinite(record.claimed) ? { claimed: record.claimed } : undefined
    }
    const error = record.error
    if (error !== null && typeof error !== 'string') return undefined
    return error === null ? {} : { error }
  } catch {
    return undefined
  }
}

/** Take an attempt without recording how it ended. */
function rememberClaim(storage: Pick<Storage, 'setItem'> | undefined, key: string, now: number): void {
  try {
    storage?.setItem(`reasoning-distill:handoff:${key}`, JSON.stringify({ claimed: now }))
  } catch {
    // Storage can be blocked; the in-memory guard still keeps this mount to one attempt.
  }
}

/** How long one tab's claim suppresses another tab's request for the same rewrite. */
const CLAIM_TTL_MS = 60_000

/**
 * Claim the right to POST one in-place rewrite.
 *
 * Two drivers can be mounted at once — the report panel and the composer seat — and the
 * request must not be sent twice. The first caller to write a fresh claim wins; a claim
 * older than {@link CLAIM_TTL_MS} is ignored so a driver that died before recording its
 * outcome cannot strand the entry. A recorded outcome (success or refusal) always wins over
 * a later claim.
 * @param storage - per-tab storage; without it every caller wins and the in-memory guard decides.
 * @param key - session id and entry id.
 * @param now - clock, for the staleness test.
 * @returns whether this caller owns the attempt.
 */
export function claimRewriteAttempt(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, key: string, now: number): boolean {
  const saved = pendingRewriteOutcome(storage, key)
  if (saved === undefined) {
    rememberClaim(storage, key, now)
    return true
  }
  if (saved.claimed === undefined) return false
  if (now - saved.claimed < CLAIM_TTL_MS) return false
  rememberClaim(storage, key, now)
  return true
}

/**
 * The rewrites an in-place backend still has to be asked to write.
 *
 * The host cannot make this request itself — an in-place backend's route sits behind the
 * browser's credentials — and it keeps only one pending marker per session, so a driver has
 * to work from the ledger instead: every rewrite that is in force here, was not refused, and
 * carries no hand-off note is still owed. Written and unwritten entries look the same in the
 * ledger, which is why the caller claims each attempt in browser storage before sending it.
 * @param report - the session's report, when one has arrived.
 * @returns the entries whose rewrite still has to be written back.
 */
export function owedInPlaceEntries(report: SessionReport | null | undefined): CompressionEntry[] {
  if (report == null) return []
  if (backendById(report.config.rewriteBackend)?.kind !== 'in-place') return []
  return report.entries.filter(entry =>
    entry.failed !== true
    && entry.skipped !== true
    && entry.handoff === undefined
    && entryInForceHere(entry, report.sessionId))
}

/** Remember a terminal backend outcome before asking the host to settle it. */
export function rememberRewriteOutcome(storage: Pick<Storage, 'setItem'> | undefined, key: string, error?: string): void {
  try {
    storage?.setItem(`reasoning-distill:handoff:${key}`, JSON.stringify({ error: error ?? null }))
  } catch {
    // Storage can be blocked; the in-memory marker still guards this mount.
  }
}

/** Only a failed settle or a settled attempt with an unwritten note is retried. */
export function shouldRetrySettle(verdict: 'settled' | 'refused' | 'failed', recorded: boolean): boolean {
  return verdict === 'failed' || (verdict === 'settled' && !recorded)
}

/**
 * Whether a backend's response means the rewrite was written.
 *
 * Success bodies differ per backend (`context-shaping` answers a bare result,
 * `msg-edit` answers its own envelope), so an absent `ok` means success while an
 * explicit `false` is a refusal — and a non-2xx always is.
 * @param ok - whether the HTTP status was in the 2xx range.
 * @param payload - the parsed body, when it parsed.
 * @returns whether the hand-off completed, and why not when it did not.
 */
export function rewriteApplyOutcome(ok: boolean, payload: unknown): { done: boolean; error?: string } {
  if (!ok) {
    const stated = (payload as { error?: unknown } | null)?.error
    return { done: false, error: typeof stated === 'string' && stated !== '' ? stated : 'HTTP request failed' }
  }
  const body = payload as { ok?: unknown; error?: unknown } | null
  if (body?.ok === false) {
    return { done: false, error: typeof body.error === 'string' && body.error !== '' ? body.error : 'backend refused (ok: false)' }
  }
  return { done: true }
}

/** The settings document the panel edits. */
export type SettingsValue = {
  enabled: boolean
  defaultRule: ModelRule
  models: Record<string, StoredRule>
  peakSource: string
  holidays: string[]
  prices: Record<string, Partial<ModelPrices>>
  rewriteBackend: string
  branchTimeoutMs: number
  /** Whether following a branch also archives the conversation it replaced. */
  archiveSuperseded: boolean
  /** Whether a conversation with running background work is left uncompressed. */
  skipWhileBusy: boolean
  prompt: string
  /** @deprecated Retired top-level limit; only a document saved before the move has it. */
  maxInputChars?: number
  /** @deprecated Retired top-level limit; only a document saved before the move has it. */
  maxOutputChars?: number
}

/** One config mutation accepted by the settings form controller. */
export type Operation = { op: 'set'; path: (string | number)[]; value: unknown }
  | { op: 'unset'; path: (string | number)[] }

/** Scalar fields the panel writes as a whole. */
const SCALAR_FIELDS = [
  'enabled', 'defaultRule', 'prompt', 'peakSource', 'holidays', 'rewriteBackend', 'branchTimeoutMs', 'archiveSuperseded', 'skipWhileBusy',
] as const satisfies readonly (keyof SettingsValue)[]

/** Fields keyed by model id, diffed per entry and per field. */
const DICT_FIELDS = ['models', 'prices'] as const satisfies readonly (keyof SettingsValue)[]

/**
 * Plan one save.
 *
 * `latest` is accepted but deliberately **not** diffed against: it is only the
 * fallback when this panel has no recorded origin yet. Diffing against it is the
 * stale-draft bug — an untouched field that another client changed would be
 * written back with the stale value.
 * @param origin - the host value this draft was derived from, if known.
 * @param latest - the host value right now, used only when `origin` is unknown.
 * @param draft - what the panel currently shows.
 * @returns the operations to apply.
 */
export function planSave(
  origin: SettingsValue | null,
  latest: SettingsValue,
  draft: SettingsValue,
): Operation[] {
  return saveOperations(origin ?? latest, draft)
}

/**
 * Plan the writes that turn `baseline` into `draft`.
 *
 * Only differences the user introduced count, at field granularity.
 * @param baseline - the value the draft was derived from (or the latest value).
 * @param draft - what the panel currently shows.
 * @returns the operations to apply, in field order.
 */
export function saveOperations(baseline: SettingsValue, draft: SettingsValue): Operation[] {
  const ops: Operation[] = []
  for (const field of SCALAR_FIELDS) pushDiff(ops, [field], baseline[field], draft[field])
  for (const field of DICT_FIELDS) {
    const before = (baseline[field] ?? {}) as Record<string, unknown>
    const after = (draft[field] ?? {}) as Record<string, unknown>
    for (const [id, value] of Object.entries(after)) {
      if (!Object.hasOwn(before, id)) {
        // A brand-new entry is written whole; there is nothing to preserve.
        ops.push({ op: 'set', path: [field, id], value })
        continue
      }
      pushDiff(ops, [field, id], before[id], value)
    }
    for (const id of Object.keys(before)) {
      if (!Object.hasOwn(after, id)) ops.push({ op: 'unset', path: [field, id] })
    }
  }
  return ops
}

/**
 * Push the writes that turn one value into another at one path.
 *
 * Plain objects are compared key by key and written field by field, so a change
 * this user made never rewrites a sibling field another client changed in the
 * meantime. Arrays and scalars are written whole.
 * @param ops - accumulator.
 * @param path - path of the value being compared.
 * @param before - the value this draft came from.
 * @param after - the value now shown.
 */
function pushDiff(ops: Operation[], path: (string | number)[], before: unknown, after: unknown): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!Object.hasOwn(after, key)) {
        if (Object.hasOwn(before, key)) ops.push({ op: 'unset', path: [...path, key] })
        continue
      }
      if (!Object.hasOwn(before, key)) {
        ops.push({ op: 'set', path: [...path, key], value: after[key] })
        continue
      }
      pushDiff(ops, [...path, key], before[key], after[key])
    }
    return
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return
  if (after === undefined) {
    ops.push({ op: 'unset', path })
    return
  }
  ops.push({ op: 'set', path, value: after })
}

/** Whether a value is a plain record (not an array, not null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
