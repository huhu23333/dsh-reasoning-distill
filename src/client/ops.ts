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
import { FALLBACK_RULE, mergeRule, withKindDefaults, type RuleOverride, type RuleSource } from '../rule.ts'

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
  const models: Record<string, StoredRule> = {}
  for (const [id, override] of Object.entries(value.models ?? {})) {
    models[id] = withKindDefaults(override, legacyOneShot)
  }
  return {
    ...value,
    defaultRule: mergeRule(FALLBACK_RULE, withKindDefaults(value.defaultRule ?? {}, legacyOneShot), undefined),
    models,
    peakSource: value.peakSource ?? 'builtin',
    rewriteBackend: value.rewriteBackend ?? '',
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

/**
 * One companion that can write a distilled rewrite into the session's history.
 *
 * Backends differ in *how* they do it — a branch session, or an in-place rewrite
 * of the model-visible surface — so the panel lets the user pick, and the apply
 * action follows the pick.
 */
export interface RewriteBackend {
  /** Stored id; empty string is the "none selected" state. */
  id: string
  /** Endpoint probed for availability. */
  probe: { method: 'POST'; path: string; body: Record<string, unknown> }
  /** Where the rewrite lands. */
  kind: 'branch' | 'in-place'
}

/** Backends this plugin knows how to drive, in panel order. */
export const REWRITE_BACKENDS: readonly RewriteBackend[] = [
  {
    id: 'message-edit',
    kind: 'branch',
    probe: { method: 'POST', path: '/message-edit', body: { action: 'edit', sessionId: '', eventSeq: 0, blockIndex: 0, text: 'probe' } },
  },
  {
    id: 'msg-edit',
    kind: 'in-place',
    probe: { method: 'POST', path: '/api/msg-edit/get-message', body: { sessionId: '', messageId: '' } },
  },
  {
    id: 'context-shaping',
    kind: 'in-place',
    probe: { method: 'POST', path: '/api/dsh-context-shaping/edit', body: { sessionId: '', messageId: '', part: 'thinking' } },
  },
]

/**
 * Whether a probe response proves the backend is installed.
 *
 * A missing route is answered by the web server itself, while an installed
 * backend answers even its own refusals (unknown session, bad body) with the
 * JSON envelope of its API. `404` alone therefore cannot decide: the backends
 * use it for "no such session" too.
 * @param status - probe status code.
 * @param contentType - probe content type, when the response carried one.
 * @returns true when the backend answered as an API.
 */
export function backendInstalled(status: number, contentType: string | null): boolean {
  if (status !== 404) return true
  return (contentType ?? '').toLowerCase().includes('application/json')
}

/**
 * The selection after one row is activated.
 *
 * A radio input cannot express this: once checked it stops firing change events,
 * so the row could never be cleared again. Activation is therefore modelled here
 * — clicking the current choice clears it, clicking another switches to it.
 * @param current - the stored backend id.
 * @param clicked - the row that was activated.
 * @returns the next stored id, possibly empty.
 */
export function nextBackend(current: string, clicked: string): string {
  return current === clicked ? '' : clicked
}

/** The backend with this id, or undefined for an unknown or empty id. */
export function backendById(id: string): RewriteBackend | undefined {
  return REWRITE_BACKENDS.find(item => item.id === id)
}

/**
 * Whether the master switch may be on: it needs a backend to apply the result.
 * @param backend - the stored backend id.
 * @param enabled - the stored master switch.
 * @returns the switch the panel should show and save.
 */
export function masterSwitchState(backend: string, enabled: boolean): { checked: boolean; locked: boolean } {
  const locked = backendById(backend) === undefined
  return { checked: locked ? false : enabled, locked }
}

/**
 * Build the request that asks the selected backend to write `text` into the
 * history, replacing the reasoning of the recorded target.
 * @param backendId - stored backend id.
 * @param sessionId - session that owns the rewrite.
 * @param entry - the recorded compression (seq, message id and block index).
 * @param text - the distilled reasoning.
 * @returns the path and JSON body, or undefined when this backend cannot apply it.
 */
export function rewriteRequest(
  backendId: string,
  sessionId: string,
  entry: { targetSeq: number; targetMessageId: string; targetBlockIndex: number },
  text: string,
): { path: string; body: Record<string, unknown> } | undefined {
  if (sessionId === '' || text === '') return undefined
  const backend = backendById(backendId)
  if (backend === undefined) return undefined
  if (backend.id === 'message-edit') {
    const body = messageEditRequest(sessionId, entry, text)
    return body === undefined ? undefined : { path: '/message-edit', body }
  }
  if (entry.targetMessageId === '') return undefined
  if (backend.id === 'context-shaping') {
    // Edits only the reasoning part of that exact assistant message, in place.
    return {
      path: '/api/dsh-context-shaping/edit',
      body: { sessionId, messageId: entry.targetMessageId, part: 'thinking', role: 'assistant', text },
    }
  }
  return { path: '/api/msg-edit/rewrite-message', body: { sessionId, messageId: entry.targetMessageId, reasoning: text } }
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
  prompt: string
  maxInputChars: number
  maxOutputChars: number
}

/** One config mutation accepted by the settings form controller. */
export type Operation = { op: 'set'; path: (string | number)[]; value: unknown }
  | { op: 'unset'; path: (string | number)[] }

/** Scalar fields the panel writes as a whole. */
const SCALAR_FIELDS = [
  'enabled', 'defaultRule', 'prompt', 'peakSource', 'holidays', 'rewriteBackend',
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
