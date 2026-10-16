/**
 * Render smoke test for the client components.
 *
 * Every render-time throw here has blanked a whole tab at least twice (a TDZ
 * read of `report`, and an unguarded field on a report from an older host), so
 * the presentation paths are server-rendered and asserted instead of trusted.
 */

import type { ReactElement } from 'react'
import { readFileSync } from 'node:fs'
import { effectHarness } from './effect-harness.ts'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReasoningDistillView, ReportBody, stockOfEntry } from '../src/client/View.tsx'
import { CompressionActivity, freshHandoff, shouldArchiveSuperseded } from '../src/client/ActivityChip.tsx'
import { REWRITE_ROUTE, type SessionReport } from '../src/shared.ts'
import { REWRITE_BACKENDS, backendById, backendInstalled, backendMissingFrom, backendSelectable, backendUnusable, claimRewriteAttempt, hostPatchReady, forcesMasterOff, missingBackendFixup, owedInPlaceEntries, backendOptionsVisible, masterSwitchState, nextBackend, planSave, rememberRewriteOutcome, rewriteRequest, saveOperations, subagentKindControls, type SettingsValue, normalizeSettings, withoutSubagentKinds } from '../src/client/ops.ts'
import { branchBackendBlocksSubagents } from '../src/backends.ts'
import { FALLBACK_RULE } from '../src/client/Settings.tsx'
import { mergeRule, sparseOverride } from '../src/rule.ts'
import { resolveRule } from '../src/config.ts'
import { InstallBackendPanel, jobVerdict, stepMark } from '../src/client/InstallBackend.tsx'
import { INSTALLABLE_BACKENDS, installPromptFor, type InstallJob } from '../src/install-shared.ts'
import { en, zh, type Key } from '../src/client/locales.ts'
import { refreshTranscript } from '../src/client/transcript.ts'
import { httpFailure } from '../src/client/ops.ts'

let failures = 0
const log: string[] = []
function check(label: string, ok: boolean, detail?: string): void {
  log.push(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ' :: ' + detail}`)
  if (!ok) failures += 1
}

/**
 * Render one element, turning a throw into a marker the assertions can catch:
 * a render-time throw is the exact failure mode this file exists for.
 * @param element - element to render.
 * @returns markup, or a marker naming the error.
 */
/** Every markup produced here, so the last check can prove none of them threw. */
const rendered: string[] = []

function tryRender(element: ReactElement): string {
  let markup: string
  try {
    markup = renderToStaticMarkup(element)
  } catch (error: unknown) {
    markup = `__THREW__ ${error instanceof Error ? error.message : String(error)}`
  }
  rendered.push(markup)
  return markup
}

/** Identity translator: assertions look for locale keys, not prose. */
const t = (key: string): string => key
const noop = (): void => undefined

/** A complete modern report. */
function modernReport(): SessionReport {
  return {
    sessionId: 'session-1',
    triggers: 3,
    succeeded: 2,
    distillCost: 0.001,
    cacheBreakCost: 0.002,
    savedLive: 0.003,
    savedTotal: 0.004,
    stockTokens: 1259,
    stockSaved: 0.0005,
    lifetimeTokens: 3777,
    net: 0.001,
    entries: [
      {
        id: '12-1000',
        appliedAt: 1000,
        turn: 1,
        step: 1,
        targetSeq: 12,
        targetMessageId: 'm-12',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        originalChars: 22036,
        originalTokens: 5509,
        distilledChars: 17000,
        distilledTokens: 4250,
        savedTokensPerRequest: 1259,
        active: true,
        liveSaved: 0.001,
        liveRequests: 3,
        frozenSaved: 0,
        cacheBreakCost: 0.002,
        cacheBreakTokens: 4300,
        distill: {
          sessionId: 'session-compress-1',
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          effort: 'off',
          requestText: '## Original reasoning',
          responseText: 'distilled',
          inputTokens: 100,
          cacheReadTokens: 0,
          outputTokens: 20,
          cost: 0.001,
          period: 'peak',
          durationMs: 1200,
        },
      },
    ],
    active: [{
      turn: 2, step: 1, provider: 'deepseek-official', model: 'deepseek-flash',
      distiller: 'deepseek-official/deepseek-flash', originalTokens: 900, startedAt: 5000,
    }],
    blockingSince: 6000,
    blockingReason: 'tool',
    config: { enabled: true, defaultThresholdTokens: 4000, defaultDistiller: 'a/b', archiveSuperseded: true, peak: { enabled: false, source: 'builtin', label: 'builtin', detail: 'd' } },
  }
}

console.log('render: modern report with live and blocking state')
const modern = tryRender(<ReportBody report={modernReport()} loading={false} error={undefined} now={9000} onRefresh={noop} openSession={noop} t={t} />)
check('summary renders the money figures', modern.includes('view.distillCost') && modern.includes('view.net'))
check('the in-progress section shows the running compression', modern.includes('view.active') && modern.includes('deepseek-official/deepseek-flash'))
check('the blocking banner names the reason', modern.includes('activity.blocked') && modern.includes('activity.reason.tool'))
check('elapsed seconds are computed, not NaN', modern.includes('3s') && !modern.includes('NaN'))
check('the compression session id is shown so it can be opened', modern.includes('session-compress-1'))
check('a non-failed entry does not claim to be abandoned', !modern.includes('view.abandoned'))
// A compression handed off to a branch is in force in that branch; the conversation
// that keeps its pre-compression reasoning earns no success and carries no stock.
const handedOffEntry = {
  ...modernReport().entries[0]!,
  handoff: { state: 'created' as const, branchId: 'branch-9', at: 30 },
}
check('a compression moved to a branch carries no stock in the conversation it left',
  stockOfEntry(handedOffEntry, 'session-1') === 0)
check('and it still carries its stock in the branch it moved to',
  stockOfEntry(handedOffEntry, 'branch-9') > 0)
const movedMarkup = tryRender(<ReportBody report={{ ...modernReport(), entries: [handedOffEntry] }} loading={false} error={undefined} now={9000} onRefresh={noop} openSession={noop} t={t} />)
check('the panel reports the rewrite as moved, not as adopted here',
  movedMarkup.includes('view.branchedAway') && movedMarkup.includes('view.branchedAwayNote'))
// The reworked figures: success is shown apart from attempts, the per-request
// figure is a stock, and the retired cache-break card is gone.
check('success and attempts are shown apart',
  modern.includes('view.succeeded') && modern.includes('view.attempts'))
check('the per-request figure is the stock', modern.includes('view.stock') && modern.includes('view.stockNote'))
check('the lifetime figure says it is a lifetime', modern.includes('view.lifetime'))
check('the cache-break card is gone',
  !modern.includes('view.cacheBreakCost') && !modern.includes('view.cacheBreakNote'))

const positiveLedger = tryRender(<ReportBody report={{ ...modernReport(), entries: [{ ...modernReport().entries[0]!, distill: { ...modernReport().entries[0]!.distill, cost: 0.079344 }, cacheBreakCost: 0, liveSaved: 0.054102 }] }} loading={false} error={undefined} now={9000} onRefresh={noop} openSession={noop} t={t} />)
const negativeLedger = tryRender(<ReportBody report={{ ...modernReport(), entries: [{ ...modernReport().entries[0]!, distill: { ...modernReport().entries[0]!.distill, cost: 0.001 }, cacheBreakCost: 0, liveSaved: 0.054102 }] }} loading={false} error={undefined} now={9000} onRefresh={noop} openSession={noop} t={t} />)
const stylesheet = readFileSync('src/client/View.module.css', 'utf8')
const ledgerClass = (html: string): string => html.match(/<span class="([^"]+)"[^>]*>\+¥[\d.]+ − ¥[\d.]+ = [^<]+<\/span>/)?.[1]?.split(' ').at(-1) ?? ''
check('positive ledger net is red and negative ledger net is green',
  positiveLedger.includes('+¥0.079344 − ¥0.054102 = +¥0.025242')
  && /\.negative\{color:#b23636\}/.test(stylesheet)
  && /\.positive\{color:#15816d\}/.test(stylesheet)
  && ledgerClass(positiveLedger).endsWith('_negative') && ledgerClass(negativeLedger).endsWith('_positive')
  && !/\.entry>summary>\.metric:last-child\{[^}]*color:#15816d/.test(stylesheet))

const estimatedUsage = tryRender(<ReportBody report={{ ...modernReport(), entries: [{ ...modernReport().entries[0]!, distill: { ...modernReport().entries[0]!.distill, inputTokens: 7, cacheReadTokens: 2, outputTokens: 13, estimated: true } }] }} loading={false} error={undefined} now={9000} onRefresh={noop} openSession={noop} t={t} />)
check('provider usage is shown verbatim and fallback token figures identify estimates',
  modern.includes('100 / 0 / 20 token') && !modern.includes('100 / 0 / 20 token (view.estimated)')
  && estimatedUsage.includes('7 / 2 / 13 token (view.estimated)')
  && modern.includes('22,036 view.chars / 5,509 view.tokens') && modern.includes('5,509 view.tokens (view.estimated)'))

console.log('client: the branch request contract is the host rewriteRequest')
// The bridge the client half of the rewrite used to build (`messageEditRequest`
// with `action:'edit'` + `cascade:'truncate'`) contradicted what the host sends
// (`rewriteRequest`: `action:'splice'`, no cascade — `edit` rebuilds the turn
// from its start and drops tool calls and later steps). It had no production
// caller, so it was deleted rather than kept as a second, divergent copy of the
// contract; the request the host actually posts is pinned by the smoke test's
// scenario 37 (`action === 'splice'`). The shared builder answers for both
// halves here:
const bridge = rewriteRequest('message-edit', 'session-1', { targetSeq: 12, targetBlockIndex: 1 }, 'short reasoning')
check('the request matches the companion contract',
  bridge?.body['action'] === 'splice' && bridge.body['sessionId'] === 'session-1' && bridge.body['eventSeq'] === 12
  && bridge.body['blockIndex'] === 1 && bridge.body['text'] === 'short reasoning'
  && bridge.body['cascade'] === undefined,
  JSON.stringify(bridge))
check('an unknown block index cannot be bridged',
  rewriteRequest('message-edit', 's', { targetSeq: 1, targetBlockIndex: -1 }, 'x') === undefined)
check('empty text cannot be bridged', rewriteRequest('message-edit', 's', { targetSeq: 1, targetBlockIndex: 0 }, '') === undefined)
check('a session without an id cannot be bridged', rewriteRequest('message-edit', '', { targetSeq: 1, targetBlockIndex: 0 }, 'x') === undefined)

console.log('client: the rewrite backend registry drives the panel')
check('two backends are offered: the verified companion, and the built-in in-place one',
  REWRITE_BACKENDS.length === 2
  && backendById('message-edit')?.kind === 'branch' && backendById('message-edit')?.hostPatch === undefined
  && backendById('in-place')?.kind === 'in-place' && backendById('in-place')?.hostPatch === true
  && backendById('placeholder') === undefined)
// Detection must not confuse a backend's own 404 ("no such session") with a
// missing route: the former answers with its JSON envelope.
// Measured on a live host: a route that does not exist is answered by the web server —
// 405 with an empty body for some paths, the shell's own 401 for an absent /api/* one — so
// the probe compares the backend's answer against a sibling path that cannot exist.
const absentShell = { status: 405, contentType: null, body: '' }
const absentApi = { status: 401, contentType: 'text/plain', body: 'unauthorized' }

// An in-place backend writes back from the browser (its route needs the user credentials)
// and the host keeps one pending marker per session, so the driver works from the ledger and
// claims each attempt before sending it. The in-place slot is a placeholder today, which is
// exactly the case the driver has to survive: owed by kind, and undrivable by request.
const reportInPlace = {
  sessionId: 'session-seat-1',
  config: { rewriteBackend: 'in-place' },
  entries: [
    { id: 'owed-1', targetSeq: 20, turn: 1, step: 1, appliedAt: 1, distilledText: 'Distilled', savedTokensPerRequest: 10, liveRequests: 0, liveSaved: 0, frozenSaved: 0, sessionLive: true, originalChars: 9, distilledChars: 1, originalTokens: 9, distilledTokens: 1, cacheBreakTokens: 0, cacheBreakCost: 0, targetBlockIndex: 0, active: true, provider: 'p', model: 'm', distill: {},  },
    { id: 'done-1', targetSeq: 20, turn: 1, step: 1, appliedAt: 1, distilledText: 'Distilled', savedTokensPerRequest: 10, liveRequests: 0, liveSaved: 0, frozenSaved: 0, sessionLive: true, originalChars: 9, distilledChars: 1, originalTokens: 9, distilledTokens: 1, cacheBreakTokens: 0, cacheBreakCost: 0, targetBlockIndex: 0, active: true, provider: 'p', model: 'm', distill: {}, handoff: { state: 'skipped', at: 1 } },
    { id: 'failed-1', targetSeq: 20, turn: 1, step: 1, appliedAt: 1, distilledText: 'Distilled', savedTokensPerRequest: 10, liveRequests: 0, liveSaved: 0, frozenSaved: 0, sessionLive: true, originalChars: 9, distilledChars: 1, originalTokens: 9, distilledTokens: 1, cacheBreakTokens: 0, cacheBreakCost: 0, targetBlockIndex: 0, active: true, provider: 'p', model: 'm', distill: {}, failed: true },
  ],
} as unknown as SessionReport
check('a rewrite with no hand-off note is still owed by an in-place backend',
  owedInPlaceEntries(reportInPlace).map(item => item.id).join(',') === 'owed-1',
  JSON.stringify(owedInPlaceEntries(reportInPlace).map(item => item.id)))
check('a branch backend leaves its write-back to the host',
  owedInPlaceEntries({ ...reportInPlace, config: { rewriteBackend: 'message-edit' } } as never).length === 0)
const claimStore = (() => {
  const map = new Map<string, string>()
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) } }
})()
check('the first driver claims an in-place attempt', claimRewriteAttempt(claimStore, 'session-x:entry-1', 1_000) === true)
check('a second driver leaves a fresh claim alone', claimRewriteAttempt(claimStore, 'session-x:entry-1', 1_100) === false)
check('a stale claim is retaken rather than stranding the rewrite',
  claimRewriteAttempt(claimStore, 'session-x:entry-1', 61_001) === true)
rememberRewriteOutcome(claimStore, 'session-x:entry-1')
check('a recorded outcome is never re-sent', claimRewriteAttempt(claimStore, 'session-x:entry-1', 200_000) === false)
check("the shell's own answer for a missing route means the backend is not installed",
  !backendInstalled(absentShell, absentShell) && !backendInstalled(absentApi, absentApi))
check('a backend that answers differently — even with its own refusal — is installed',
  backendInstalled({ status: 404, contentType: 'application/json; charset=utf-8', body: '{"error":"no such session"}' }, absentShell)
  && backendInstalled({ status: 400, contentType: 'text/plain', body: 'bad body' }, absentShell)
  && backendInstalled({ status: 200, contentType: 'application/json', body: '{"sessionId":"branch"}' }, absentShell))
check('an identical answer is still absence, whatever the status', !backendInstalled(absentShell, absentShell)
  && !backendInstalled({ status: 405, contentType: null, body: ' ' }, absentShell))
check('an empty or unknown id resolves to no backend',
  backendById('') === undefined && backendById('nope') === undefined)
// The host cannot probe these routes (in-place ones need the browser's credentials), so the
// startup check reads the profile's active plugin list instead. Only a list that was read *and*
// lacks the plugin may close the switch down; every weaker answer leaves the user's setting alone.
const active = ['dsh-base', 'dsh-message-edit']
check('a companion backend names its plugin; the built-in one names none but still has a route',
  REWRITE_BACKENDS.filter(backend => backend.hostPatch !== true).every(backend => (backend.plugin ?? '') !== '')
  && REWRITE_BACKENDS.filter(backend => backend.hostPatch === true).every(backend =>
    backend.plugin === undefined && backend.probe?.path === REWRITE_ROUTE))
// A host-patch backend is drivable only on a patched host, and the answer has to come from the
// host itself: true opens it, false closes it, and 'not asked yet' leaves it alone.
check('the built-in backend needs the host patch, and only a real answer closes it',
  !backendUnusable('in-place', active, true) && backendUnusable('in-place', active, false)
  && !backendUnusable('in-place', active) && !backendUnusable('in-place', undefined, true))
check('and the profile list does not decide the built-in backend either way',
  backendUnusable('in-place', ['nothing-at-all'], true) === false
  && backendUnusable('in-place', undefined, false) === true)
check('a companion backend ignores the host-patch verdict',
  !backendUnusable('message-edit', active, true) && backendUnusable('message-edit', ['dsh-base'], true))
// The probe verdict: answering proves the plugin is loaded, the body proves the host can rewrite.
const patchOk = { status: 200, contentType: 'application/json', body: '{"patched":true,"functional":true}' }
const patchBroken = { status: 200, contentType: 'application/json', body: '{"patched":true,"functional":false}' }
const patchAbsent = { status: 200, contentType: 'application/json', body: '{"patched":false,"functional":false}' }
check('the built-in backend is selectable only when the verdict says patched and working',
  backendSelectable(backendById('in-place')!, patchOk, absentShell)
  && !backendSelectable(backendById('in-place')!, patchBroken, absentShell)
  && !backendSelectable(backendById('in-place')!, patchAbsent, absentShell)
  // The shell's own answer is still absence, whatever it carries.
  && !backendSelectable(backendById('in-place')!, patchOk, patchOk))
check('a companion backend is selectable on its own answer alone',
  backendSelectable(backendById('message-edit')!, { status: 404, contentType: 'application/json', body: '{"error":"no such session"}' }, absentShell)
  && !backendSelectable(backendById('message-edit')!, absentShell, absentShell))
check('a probe body that is not a verdict is not a patched host',
  !hostPatchReady('') && !hostPatchReady('not json') && !hostPatchReady('{"patched":true}')
  && !hostPatchReady('{"functional":true}') && !hostPatchReady('{"patched":"yes","functional":true}')
  && hostPatchReady('{"patched":true,"functional":true}'))
check('a plugin the active list does not carry is reported missing',
  backendMissingFrom('dsh-message-edit', ['dsh-base']) && backendMissingFrom('dsh-message-edit', []))
check('a plugin the active list carries is found, by name or by repository spec',
  !backendMissingFrom('dsh-message-edit', active)
  && !backendMissingFrom('dsh-other-backend', ['github:someone/dsh-other-backend']))
check('a list that could not be read closes nothing', !backendMissingFrom('dsh-message-edit', undefined))
check('the placeholder has no plugin name, so nothing host-side is ever closed down for it',
  backendMissingFrom(backendById('placeholder')?.plugin, active) === false)
check('no plugin name — no backend, or one this host does not know — closes nothing',
  !backendMissingFrom('', active) && !backendMissingFrom(undefined, active))
// What the host acts on is the selection, not just the plugin: an id this build does not have
// (`msg-edit` is the removed backend the live profile still stores) and the placeholder are both
// unusable, and the placeholder's row is disabled, so the host is the only one that can drop it.
// No readable profile ⇒ nothing is written, whatever the id is.
check('a selection this build cannot drive is unusable',
  backendUnusable('msg-edit', active) && backendUnusable('placeholder', active)
  && backendUnusable('message-edit', ['dsh-base']))
check('and a selection this build can drive is left alone',
  !backendUnusable('message-edit', active) && !backendUnusable('', active)
  && !backendUnusable('msg-edit', undefined))
// Clearing the selection is part of the same fix: the stored name outlives the plugin, and leaving
// it would keep every later process promising a hand-off that cannot happen.
check('a missing backend clears the selection, and takes the switch off with it when it was on',
  JSON.stringify(missingBackendFixup('message-edit', true)) === '{"enabled":false,"rewriteBackend":""}')
check('and clears only the selection when the switch was already off',
  JSON.stringify(missingBackendFixup('message-edit', false)) === '{"rewriteBackend":""}')
check('an already-empty selection has nothing to write',
  missingBackendFixup('', true) === undefined && missingBackendFixup('', false) === undefined)
// Master switch: locked off with no backend, the user's choice otherwise.
check('no backend locks the master switch off', masterSwitchState('', true).locked && masterSwitchState('', true).checked === false)
check('a selected backend unlocks it and keeps the user value',
  !masterSwitchState('message-edit', true).locked && masterSwitchState('message-edit', true).checked === true)
check('and an uninstalled/unknown id does not unlock it', masterSwitchState('nope', true).locked)
// Removing the plugin leaves the selection in storage, so what the *probe* saw has to decide.
check('a selected backend the probe reports missing locks the switch off',
  masterSwitchState('message-edit', true, false).locked && masterSwitchState('message-edit', true, false).checked === false)
check('an answered probe for an installed backend keeps the switch openable',
  !masterSwitchState('message-edit', true, true).locked && masterSwitchState('message-edit', true, true).checked === true)
check('a probe that has not answered yet locks nothing', !masterSwitchState('message-edit', true).locked)
// A locked switch shows off, so the stored value has to follow it into storage.
check('a stored on switch is written back off when its backend is missing',
  forcesMasterOff('message-edit', true, false) && forcesMasterOff('', true) && forcesMasterOff('nope', true))
check('and a usable backend leaves the stored value alone',
  !forcesMasterOff('message-edit', true, true) && !forcesMasterOff('message-edit', false, false))
// Requests: only the branch backend has one. The in-place slot has no implementation, so it must
// ask for nothing at all rather than send a request nobody answers.
const target = { targetSeq: 12, targetMessageId: 'm-12', targetBlockIndex: 2 }
const branchCall = rewriteRequest('message-edit', 'session-1', target, 'short')
check('the branch backend is asked to splice the reasoning block',
  // The branch must stay the whole conversation: `splice` keeps tool calls and the
  // later steps, while `edit` rebuilds the turn from its start.
  branchCall?.path === '/message-edit' && branchCall.body['eventSeq'] === 12 && branchCall.body['blockIndex'] === 2
  && branchCall.body['text'] === 'short' && branchCall.body['action'] === 'splice',
  JSON.stringify(branchCall))
check('a missing block index cannot be sent to the branch backend',
  rewriteRequest('message-edit', 'session-1', { ...target, targetBlockIndex: -1 }, 'short') === undefined)
const inPlaceCall = rewriteRequest('in-place', 'session-1', target, 'short')
check('the built-in in-place backend is asked over this plugin\'s own route',
  inPlaceCall?.path === REWRITE_ROUTE && inPlaceCall.body['sessionId'] === 'session-1'
  && inPlaceCall.body['eventSeq'] === 12 && inPlaceCall.body['blockIndex'] === 2
  && inPlaceCall.body['text'] === 'short', JSON.stringify(inPlaceCall))
// The message id is deliberately absent: the route takes it from the sidecar record, so a caller
// that guessed a seq cannot aim the rewrite at a message the ledger never named.
check('the in-place request never carries a message id of the caller\'s choosing',
  inPlaceCall !== undefined && !Object.hasOwn(inPlaceCall.body, 'messageId'))
check('a request the in-place backend cannot honour is not sent',
  rewriteRequest('in-place', 'session-1', { ...target, targetBlockIndex: -1 }, 'short') === undefined
  && rewriteRequest('in-place', '', target, 'short') === undefined
  && rewriteRequest('in-place', 'session-1', target, '') === undefined)
check('no backend means no request at all', rewriteRequest('', 'session-1', target, 'short') === undefined)
check('empty text is never sent', rewriteRequest('message-edit', 'session-1', target, '') === undefined)

console.log('client: activating the chosen backend again clears it')
check('clicking another backend switches to it', nextBackend('message-edit', 'in-place') === 'in-place')
check('clicking a backend when none is chosen selects it', nextBackend('', 'message-edit') === 'message-edit')
// A radio input cannot fire change once checked, which is exactly why the panel
// must model deselection itself.
check('clicking the chosen backend clears the choice', nextBackend('message-edit', 'message-edit') === '')
console.log('render: a report from an older host (version skew)')
const legacy = modernReport()
// Fields added by later host versions are absent, as they would be mid-upgrade.
delete (legacy as { active?: unknown }).active
delete (legacy as { blockingSince?: unknown }).blockingSince
delete (legacy as { blockingReason?: unknown }).blockingReason
for (const entry of legacy.entries) delete (entry as { failed?: unknown }).failed
const skew = tryRender(<ReportBody report={legacy} loading={false} error={undefined} now={9000} onRefresh={noop} openSession={noop} t={t} />)
check('no in-progress section without the field', !skew.includes('view.activeHint'))

console.log('render: abandoned attempt and empty session')
const abandoned = modernReport()
abandoned.entries[0]!.failed = true
abandoned.entries[0]!.distilledTokens = 0
abandoned.entries[0]!.savedTokensPerRequest = 0
abandoned.entries[0]!.distill.cost = 0.02
abandoned.active = []
abandoned.blockingSince = null
abandoned.blockingReason = null
const failed = tryRender(<ReportBody report={abandoned} loading={false} error={undefined} now={9000} onRefresh={noop} openSession={noop} t={t} />)
check('an abandoned attempt is labelled and still shows its cost', failed.includes('view.abandoned') && failed.includes('0.020000'))
const missing = modernReport()
missing.entries[0]!.sessionMissing = true
missing.entries[0]!.distill.sessionId = ''
const noSession = tryRender(<ReportBody report={missing} loading={false} error={undefined} now={9000} onRefresh={noop} openSession={noop} t={t} />)
check('and clearing it locks the master switch again', masterSwitchState(nextBackend('message-edit', 'message-edit'), true).locked)

check('a report missing the new fields still renders', skew.includes('view.entries'))
check('a missing audit session says so instead of looking broken', noSession.includes('view.sessionMissing') && !noSession.includes('view.noSession'))
const empty = tryRender(<ReportBody report={{ ...modernReport(), entries: [], active: [], blockingSince: null, blockingReason: null }} loading={false} error={undefined} now={9000} onRefresh={noop} openSession={noop} t={t} />)
check('an empty session renders the empty state', empty.includes('view.empty'))
check('loading and error states render', tryRender(<ReportBody report={undefined} loading error={undefined} now={0} onRefresh={noop} openSession={noop} t={t} />).includes('view.loading'))
check('the error state renders', tryRender(<ReportBody report={undefined} loading={false} error="boom" now={0} onRefresh={noop} openSession={noop} t={t} />).includes('boom'))

console.log('render: the polling shell itself')
// The shell is where a TDZ read of `report` blanked the tab: it must render.
check('the session view shell renders', renderToStaticMarkup(
  <ReasoningDistillView sessionId="session-1" openSession={noop} t={t} />,
).includes('view.title'))

console.log('client: settings writes only touch what this user edited')
/** Minimal settings document for the write planner. */
function settings(overrides: Partial<SettingsValue> = {}): SettingsValue {
  return {
    enabled: true,
    defaultRule: {
      enabled: true, continuableSubagents: true, continuableMaxDepth: 0,
      oneShotSubagents: false, oneShotMaxDepth: 0,
      thresholdTokens: 4000, minSavedTokens: 600,
      includeToolResults: true, includeFinalTurns: true, timeoutMs: 60000,
      distiller: { provider: 'p', model: 'm', effort: 'off' },
    },
    models: {},
    peakSource: 'builtin',
    holidays: [],
    prices: {},
    archiveSuperseded: true,
    prompt: '',
    maxInputChars: 120000,
    maxOutputChars: 0,
    ...overrides,
  }
}
const untouched = settings()
check('an unchanged draft writes nothing', saveOperations(untouched, settings()).length === 0)
const edited = settings({ defaultRule: { ...settings().defaultRule, oneShotSubagents: true } })
check('a field this user edited is written',
  saveOperations(untouched, edited).some(op => op.path[0] === 'defaultRule' && op.op === 'set'))
check('and nothing else is dragged along', saveOperations(untouched, edited).length === 1)
check('the archive switch is written when this user flips it',
  saveOperations(settings(), settings({ archiveSuperseded: false })).some(op => op.path[0] === 'archiveSuperseded' && op.op === 'set'))
check('an unset archive switch defaults to on', normalizeSettings({} as never).archiveSuperseded === true)

console.log('client: the panel resolves the retired top-level limits exactly as the engine does')
// `normalizeSettings` feeds both the display fold (`ruleOf` in `Settings.tsx`) and
// the save diff, so the draft must carry the same three layers the engine folds in
// `resolveRule`: the retired top-level limits as the LOWEST layer, then the default
// rule, then one model's own entry. Injecting that retired value into every model
// layer instead made the panel show — and, on the next edit, persist — a ceiling
// the runtime never applies.
const engineRule = (doc: SettingsValue, model: string) => resolveRule(model, {
  defaultRule: { get: () => doc.defaultRule },
  models: { get: () => doc.models },
  ...(doc.maxInputChars === undefined ? {} : { maxInputChars: { get: () => doc.maxInputChars } }),
  ...(doc.maxOutputChars === undefined ? {} : { maxOutputChars: { get: () => doc.maxOutputChars } }),
})
/** The exact expression `ruleOf` renders with (`Settings.tsx`). */
const panelRule = (doc: SettingsValue, model: string) => {
  const draft = normalizeSettings(doc)
  return mergeRule(FALLBACK_RULE, draft.defaultRule, draft.models[model])
}
const limitsAgree = (doc: SettingsValue, model: string): boolean => {
  const engine = engineRule(doc, model)
  const panel = panelRule(doc, model)
  return engine.maxInputChars === panel.maxInputChars && engine.maxOutputChars === panel.maxOutputChars
}
// No rule layer states a ceiling, so the retired top-level ones are all there is.
const legacyCeilings = settings({ maxOutputChars: 1500, models: { 'deepseek-flash': { thresholdTokens: 9000 } } })
const legacyPanel = panelRule(legacyCeilings, 'deepseek-flash')
check('with no ceiling in any rule layer both sides keep the retired top-level one',
  legacyPanel.maxInputChars === 120000 && legacyPanel.maxOutputChars === 1500
  && limitsAgree(legacyCeilings, 'deepseek-flash'))
// The regression: the default rule states a ceiling and the model entry exists but
// states none. That model must inherit the default rule's ceiling, not the retired
// top-level value sitting below it.
const statedDefault = settings({
  maxOutputChars: 120000,
  defaultRule: { ...settings().defaultRule, maxInputChars: 1000, maxOutputChars: 2000 },
  models: { 'deepseek-flash': { thresholdTokens: 9000 } },
})
const statedPanel = panelRule(statedDefault, 'deepseek-flash')
check('a model that states no ceiling shows the default rule, not the retired top-level value',
  statedPanel.maxInputChars === 1000 && statedPanel.maxOutputChars === 2000
  && limitsAgree(statedDefault, 'deepseek-flash'))
// A ceiling stated on the model itself still wins over both lower layers.
const modelStated = settings({
  maxOutputChars: 120000,
  defaultRule: { ...settings().defaultRule, maxInputChars: 1000, maxOutputChars: 2000 },
  models: { 'deepseek-flash': { maxInputChars: 500, maxOutputChars: 700 } },
})
const modelPanel = panelRule(modelStated, 'deepseek-flash')
check('a model that states its own ceiling keeps it on both sides',
  modelPanel.maxInputChars === 500 && modelPanel.maxOutputChars === 700
  && limitsAgree(modelStated, 'deepseek-flash'))
// The invariant on its own, over the whole input space of the layering rule: each
// of the three layers either states a ceiling, states zero, or says nothing.
/**
 * One document with a chosen ceiling per layer, both limit fields set alike so a
 * single document exercises both.
 * @param legacy - the retired top-level value.
 * @param byDefault - what the default rule states, when it states anything.
 * @param byModel - what the model entry states, when it states anything.
 * @returns the settings document.
 */
const limitDocument = (legacy: number, byDefault: number | undefined, byModel: number | undefined): SettingsValue => settings({
  maxInputChars: legacy,
  maxOutputChars: legacy,
  defaultRule: {
    ...settings().defaultRule,
    ...(byDefault === undefined ? {} : { maxInputChars: byDefault, maxOutputChars: byDefault }),
  },
  models: {
    'deepseek-flash': byModel === undefined
      ? { thresholdTokens: 9000 }
      : { maxInputChars: byModel, maxOutputChars: byModel },
  },
})
const ceilingDocuments: SettingsValue[] = [legacyCeilings, statedDefault, modelStated, settings(),
  ...[120000, 0].flatMap(legacy =>
    [undefined, 0, 1000].flatMap(byDefault =>
      [undefined, 0, 500].map(byModel => limitDocument(legacy, byDefault, byModel))))]
check('the panel and the engine agree on the ceilings of every document and model',
  ceilingDocuments.every(doc => ['deepseek-flash', 'another-model'].every(model => limitsAgree(doc, model))))
// The other half of the same defect: the display fold is also what the save diff
// treats as inherited, so a retired ceiling must not become an explicit model entry
// just because the user edited an unrelated field.
const inheritedForModel = mergeRule(FALLBACK_RULE, normalizeSettings(statedDefault).defaultRule, undefined)
const afterUnrelatedEdit = sparseOverride(inheritedForModel, { ...statedPanel, thresholdTokens: 1234 })
check('editing another field of a model entry does not freeze the retired ceiling into it',
  afterUnrelatedEdit.thresholdTokens === 1234
  && afterUnrelatedEdit.maxInputChars === undefined && afterUnrelatedEdit.maxOutputChars === undefined)

console.log('client: a branch backend pins both subagent switches off')
// The one question the engine's gate and this panel both ask, so a profile the panel never
// touched and the panel itself cannot disagree about whether a subagent kind is allowed.
check('the branch backend is the one that cannot serve a subagent session',
  branchBackendBlocksSubagents('message-edit')
  && !branchBackendBlocksSubagents('')
  && !branchBackendBlocksSubagents('placeholder')
  && !branchBackendBlocksSubagents('nope'))
const subagentsOn = settings({
  defaultRule: { ...settings().defaultRule, continuableSubagents: true, oneShotSubagents: true },
  models: { 'deepseek-flash': { enabled: true, continuableSubagents: true } },
})
const pinned = withoutSubagentKinds(subagentsOn)
check('pinning states both kinds off in the default rule and in every model entry',
  pinned.defaultRule.continuableSubagents === false && pinned.defaultRule.oneShotSubagents === false
  && pinned.models['deepseek-flash']!.continuableSubagents === false
  && pinned.models['deepseek-flash']!.oneShotSubagents === false)
check('and it leaves every other field of those layers as stored',
  pinned.defaultRule.thresholdTokens === subagentsOn.defaultRule.thresholdTokens
  && pinned.defaultRule.enabled === true
  && pinned.models['deepseek-flash']!.enabled === true)
check('what the engine resolves from the pinned document is the same answer, for either model',
  ['deepseek-flash', 'another-model'].every(model =>
    engineRule(pinned, model).continuableSubagents === false
    && engineRule(pinned, model).oneShotSubagents === false))
check('an already-pinned document is returned as the same object, so the effect cannot loop',
  withoutSubagentKinds(pinned) === pinned)
check('and a document that needs pinning is a new one',
  pinned !== subagentsOn)

// Both rows the panel draws — the default rule and each model's own entry — go through
// `subagentKindControls`, so a model row cannot be treated differently from the default one.
const modelRow = mergeRule(FALLBACK_RULE, subagentsOn.defaultRule, { continuableSubagents: true, oneShotSubagents: true })
check('unlocked, each row mirrors its own rule and only a missing kind locks its cap',
  (() => {
    const on = subagentKindControls({ continuableSubagents: true, oneShotSubagents: false }, 'continuable', false)
    const off = subagentKindControls({ continuableSubagents: true, oneShotSubagents: false }, 'oneShot', false)
    const absent = subagentKindControls({}, 'continuable', false)
    return on.checked && !on.disabled && !on.depthDisabled
      && !off.checked && !off.disabled && off.depthDisabled
      && !absent.checked && !absent.disabled && absent.depthDisabled
  })())
const lockedDefault = subagentKindControls(subagentsOn.defaultRule, 'continuable', true)
const lockedModel = subagentKindControls(modelRow, 'continuable', true)
const lockedModelShot = subagentKindControls(modelRow, 'oneShot', true)
check('locked, a model row reads exactly like the default row, whatever its own layer says',
  JSON.stringify(lockedModel) === JSON.stringify(lockedDefault)
  && lockedDefault.checked === false && lockedDefault.disabled && lockedDefault.depthDisabled
  && lockedModelShot.checked === false && lockedModelShot.disabled && lockedModelShot.depthDisabled)
check('and the switch cannot be flipped by the row itself: only the backend unlocks it',
  subagentKindControls(modelRow, 'continuable', false).checked === true
  && subagentKindControls(modelRow, 'continuable', false).disabled === false)

// The regression: another client flipped compressSubagents to true while this
// panel sat with an untouched draft derived from the older value. The save must
// ignore the latest value entirely, or it silently reverts them.
const hostMovedOn = settings({ defaultRule: { ...settings().defaultRule, oneShotSubagents: true } })
check('a stale draft never writes back a field another client changed',
  planSave(untouched, hostMovedOn, untouched).length === 0)
check('while a real edit in the same save still goes through',
  planSave(untouched, hostMovedOn, edited).some(op => op.path[0] === 'defaultRule'))
check('with no recorded origin the latest value is the only option',
  planSave(null, hostMovedOn, untouched).some(op => op.path[0] === 'defaultRule'))
const withModel = settings({ models: { 'deepseek-flash': { thresholdTokens: 9000 } } })
check('a removed model entry is unset',
  saveOperations(withModel, settings()).some(op => op.op === 'unset' && op.path[0] === 'models' && op.path[1] === 'deepseek-flash'))
// A brand-new entry has nothing to preserve, so it is written whole.
check('a model entry that did not exist is written whole',
  saveOperations(settings(), withModel).some(op => op.path.join('.') === 'models.deepseek-flash'),
  JSON.stringify(saveOperations(settings(), withModel)))
// The concurrency case, faithfully: A's draft came from a threshold of 4000,
// B moved the host to 5000, and A only edited the switch.
const originA = settings({ models: { m: { thresholdTokens: 4000 } } })
const draftA = settings({ models: { m: { thresholdTokens: 4000, oneShotSubagents: true } } })
const hostAfterB = settings({ models: { m: { thresholdTokens: 5000 } } })
const aOps = planSave(originA, hostAfterB, draftA)
check('an edit writes only its own field inside a model entry',
  aOps.length === 1 && aOps[0]!.path.join('.') === 'models.m.oneShotSubagents', JSON.stringify(aOps))
check('so a sibling field another client changed survives',
  !aOps.some(op => op.path.join('.') === 'models.m.thresholdTokens'))
// And this is exactly why the baseline must be the draft's origin: diffing
// against the latest value would emit B's field with A's stale number.
check('diffing against the latest value would have reverted it',
  saveOperations(hostAfterB, draftA).some(op => op.path.join('.') === 'models.m.thresholdTokens'))
check('a removed price entry is unset',
  saveOperations(settings({ prices: { 'deepseek-flash': { peak: { hit: 1, miss: 2, out: 3 } } } }), settings())
    .some(op => op.op === 'unset' && op.path.join('.') === 'prices.deepseek-flash'))
const priceBefore = settings({ prices: { p: { peak: { hit: 1, miss: 2, out: 3 }, peakPricing: false } } })
const priceAfter = settings({ prices: { p: { peak: { hit: 9, miss: 2, out: 3 }, peakPricing: false } } })
check('a price edit writes the leaf field, not the entry',
  saveOperations(priceBefore, priceAfter).length === 1
  && saveOperations(priceBefore, priceAfter)[0]!.path.join('.') === 'prices.p.peak.hit',
  JSON.stringify(saveOperations(priceBefore, priceAfter)))
const ruleBefore = settings()
const ruleAfter = settings({ defaultRule: { ...settings().defaultRule, thresholdTokens: 1234 } })
check('a default-rule edit writes one field',
  saveOperations(ruleBefore, ruleAfter).length === 1
  && saveOperations(ruleBefore, ruleAfter)[0]!.path.join('.') === 'defaultRule.thresholdTokens')

console.log('render: header action and composer activity chip')
check('the activity chip is silent while idle',
  tryRender(<CompressionActivity sessionId="session-1" openSession={noop} archiveSession={noop} onActiveChange={noop} t={t} />) === '')

// The composer seat — not the report panel — follows a hand-off, so its decision
// has to be exact: follow only a branch that landed after this view opened, and
// follow the newest one when out-of-order reports arrive.
const handoffReport = (...handoffs: { state: 'created' | 'failed' | 'skipped'; branchId?: string; at: number }[]): SessionReport =>
  ({ entries: handoffs.map(handoff => ({ handoff })), config: { archiveSuperseded: true } } as unknown as SessionReport)
check('a hand-off created after this session opened is followed',
  freshHandoff(handoffReport({ state: 'created', branchId: 'branch-1', at: 20 }), 'session-1', { sessionId: 'session-1', at: 10 })?.branchId === 'branch-1')
check('a hand-off that predates the current view is history, not a redirect',
  freshHandoff(handoffReport({ state: 'created', branchId: 'branch-1', at: 5 }), 'session-1', { sessionId: 'session-1', at: 10 }) === undefined)
check('the newest hand-off wins when reports arrive out of order',
  freshHandoff(handoffReport(
    { state: 'created', branchId: 'older', at: 15 },
    { state: 'created', branchId: 'newer', at: 30 },
  ), 'session-1', { sessionId: 'session-1', at: 10 })?.branchId === 'newer')
check('a seat showing another session follows nothing',
  freshHandoff(handoffReport({ state: 'created', branchId: 'branch-1', at: 20 }), 'session-2', { sessionId: 'session-1', at: 10 }) === undefined)
check('a failed hand-off is never followed',
  freshHandoff(handoffReport({ state: 'failed', at: 20 }), 'session-1', { sessionId: 'session-1', at: 10 }) === undefined)
// The archive switch is plugin configuration, default on; the seat reads it from the
// report it already polls, so the value in force when the branch appears decides.
check('a followed branch archives the conversation it replaced by default',
  shouldArchiveSuperseded(handoffReport({ state: 'created', branchId: 'branch-1', at: 20 })))
check('and leaves it in the list when the switch is off',
  !shouldArchiveSuperseded({
    ...handoffReport({ state: 'created', branchId: 'branch-1', at: 20 }),
    config: { archiveSuperseded: false },
  } as unknown as SessionReport))
check('a report that could not be read never archives anything', !shouldArchiveSuperseded(null))
check('the backend-specific options belong to a branch backend only',
  backendOptionsVisible('message-edit') && !backendOptionsVisible('placeholder') && !backendOptionsVisible(''))

console.log('render: quick-install page')
// The page is a view onto a host-side install: closing it must render nothing at all,
// and reopening reads the job back from the route.
check('the quick-install page is absent while it is closed',
  tryRender(<InstallBackendPanel open={false} onClose={noop} t={t} />) === '')
const installPage = tryRender(<InstallBackendPanel open onClose={noop} t={t} />)
check('it lists the installable backends and their install note',
  installPage.includes('message-edit') && installPage.includes('install.note.message-edit')
  // The built-in in-place backend is installable too, and the page has to offer it: its install
  // is the host patch, which is a route, not a package.
  // Both ids are listed; the note shown belongs to the selected one, so the notes are checked
  // against the locale tables instead (a missing key would render as a raw key string).
  && installPage.includes('in-place') && !installPage.includes('placeholder'))
check('every installable backend has an install note in both languages',
  INSTALLABLE_BACKENDS.every(backend => {
    const key = `install.note.${backend.id}` as Key
    return typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''
  }))
check('it states the trade-off of both install routes',
  installPage.includes('install.mode.script.pros') && installPage.includes('install.mode.script.cons')
  && installPage.includes('install.mode.agent.pros') && installPage.includes('install.mode.agent.cons'))
check('the scripted route offers start and cancel, and claims no progress yet',
  installPage.includes('install.start') && installPage.includes('install.cancel')
  && installPage.includes('install.stepBackend') && !installPage.includes('install.result.running'))
// The agent section itself only renders once that mode is picked, which SSR cannot do;
// its wording lives in the locale table and is covered by the mode cards above.
const jobFixture: InstallJob = {
  backendId: 'message-edit',
  phase: 'running',
  steps: [{ id: 'resolve', state: 'done' }, { id: 'install', state: 'running' }],
  log: [],
  startedAt: 1,
}
check('every step state and verdict has its own words',
  stepMark('done', t).includes('install.stepDone') && stepMark('running', t).includes('install.stepRunning')
  && stepMark('pending', t).includes('install.stepPending') && stepMark('failed', t).includes('install.stepFailed')
  && jobVerdict(jobFixture, t).includes('install.result.running')
  && jobVerdict({ ...jobFixture, phase: 'cancelled' }, t).includes('install.result.cancelled')
  && jobVerdict({ ...jobFixture, phase: 'failed', error: 'boom' }, t).includes('boom'))
// The prompt has to send the agent to the real instructions and to the one verified backend.
const verifiedPrompt = installPromptFor('message-edit', '/repo')
check('the agent prompt names the backend and points at the real instructions',
  verifiedPrompt.includes('message-edit') && verifiedPrompt.includes('/repo/README.md') && verifiedPrompt.includes('/repo'))
check('and it promises nothing beyond the verified procedure',
  verifiedPrompt.includes('唯一验证过') && !verifiedPrompt.includes('不要伪造成功'))
// The built-in backend's prompt is the layout-agnostic half of its install: the agent runs the
// script, and the script locates the checkout. A machine-specific directory here would be wrong on
// every other machine, so the prompt is pinned against one.
const inPlacePrompt = installPromptFor('in-place', '/repo')
check('the built-in backend prompt names the patch script, both routes, and discovery',
  inPlacePrompt.includes('/repo/scripts/dsh-inplace-patch.mjs') && inPlacePrompt.includes('--locate')
  && inPlacePrompt.includes('--apply') && inPlacePrompt.includes('--check') && inPlacePrompt.includes('--checkout')
  && inPlacePrompt.includes('$DSH_HOST_CHECKOUT') && inPlacePrompt.includes('$DSH_CHECKOUT'))
check('and it hardcodes no machine-specific directory',
  !inPlacePrompt.includes('/home/') && !inPlacePrompt.includes('~/') && !inPlacePrompt.includes('otherProject')
  && !inPlacePrompt.includes('$HOME'))
check('and it sends the agent to the real instructions and warns off hand-editing',
  inPlacePrompt.includes('/repo/README.md') && inPlacePrompt.includes('--revert') && inPlacePrompt.includes('不要手工编辑'))
// The rebuild is the one thing that makes a landed rewrite visible without a reload, and it has
// to be a no-op — never a thrown render or a failed write-back — on a shell that cannot do it.
let rebuildCalls = 0
check('a session that can rebuild its window is asked to, once per call',
  refreshTranscript({ resync: () => { rebuildCalls += 1 } }) && rebuildCalls === 1)
check('a session without the rebuild entry point is left alone',
  refreshTranscript({}) === false && refreshTranscript(undefined) === false && rebuildCalls === 1)
check('a rebuild that throws cannot fail the write-back that already landed',
  refreshTranscript({ resync: () => { throw new Error('no window') } }) === false && rebuildCalls === 1)
// A bare status hides which lookup failed; the routes all answer JSON, so the reason is readable.
const statedFailure = await httpFailure({ status: 404, json: async () => ({ error: 'unknown session' }) } as unknown as Response)
const silentFailure = await httpFailure({ status: 500, json: async () => { throw new Error('not json') } } as unknown as Response)
const emptyFailure = await httpFailure({ status: 502, json: async () => ({}) } as unknown as Response)
check('a failed response keeps the server\u2019s own reason',
  statedFailure === 'unknown session（HTTP 404）' && silentFailure === 'HTTP 500' && emptyFailure === 'HTTP 502',
  JSON.stringify({ statedFailure, silentFailure, emptyFailure }))
check('no render path threw', !rendered.some(markup => markup.includes('__THREW__')))

// Effect-only regressions: the SSR checks above do not run the view's effects.
const globals = globalThis as typeof globalThis & { window: Window; document: Document }
const priorWindow = globals.window
const priorDocument = globals.document
const priorFetch = globals.fetch
const storageData = new Map<string, string>()
const storage = { getItem: (key: string) => storageData.get(key) ?? null, setItem: (key: string, value: string) => { storageData.set(key, value) } }
globals.window = { sessionStorage: storage, addEventListener: noop, removeEventListener: noop } as unknown as Window
globals.document = { addEventListener: noop, removeEventListener: noop } as unknown as Document
try {
  const branchReport = modernReport()
  branchReport.entries = [
    { ...branchReport.entries[0]!, id: 'earlier-entry', handoff: { state: 'created', branchId: 'newer-branch', at: 130 } },
    { ...branchReport.entries[0]!, id: 'later-entry', handoff: { state: 'created', branchId: 'older-branch', at: 120 } },
  ]
  branchReport.pendingBranch = null
  const opened: string[] = []
  const clock = Date.now
  Date.now = () => 100
  globals.fetch = async () => ({ ok: true, json: async () => branchReport }) as Response
  const branch = effectHarness(() => ReasoningDistillView({ sessionId: 'session-1', openSession: id => { opened.push(id) }, t } as never))
  try {
    await branch.tick()
    await branch.tick()
    await branch.tick()
    check('auto-open chooses greatest handoff.at regardless of entry order and never redirects twice',
      opened.length === 1 && opened[0] === 'newer-branch')
  } finally { branch.stop(); Date.now = clock }

  // The in-place backend is real now, so this drives its whole browser half: the panel posts the
  // rewrite to this plugin's own route, accepts the success envelope, and settles the hand-off with
  // the host. The remount must not post it a second time — the recorded outcome is what stops it.
  const pending = modernReport()
  pending.config.rewriteBackend = 'in-place'
  pending.entries[0]!.id = 'in-place-1'
  pending.entries[0]!.targetMessageId = 'm-12'
  pending.entries[0]!.distilledText = 'capped'
  pending.pendingBranch = 'in-place-1'
  const backendPosts: string[] = []
  let settles = 0
  globals.fetch = async (input: RequestInfo | URL) => {
    if (String(input).includes('/report')) return { ok: true, json: async () => pending } as Response
    if (String(input).includes('/handoff')) { settles++; return { ok: true, json: async () => ({ ok: true, recorded: true }) } as Response }
    backendPosts.push(String(input))
    return { ok: true, json: async () => ({ ok: true, eventSeq: 2 }) } as Response
  }
  // The rewrite changed a record at its own seq, so the open view still holds the superseded
  // reasoning: the driver has to ask the shell to rebuild the window, exactly once per landed
  // rewrite and never for a request that was refused.
  const refreshed: string[] = []
  const mount = (): ReturnType<typeof effectHarness> => effectHarness(() => ReasoningDistillView({
    sessionId: 'session-1', openSession: noop, refreshTranscript: (id: string) => { refreshed.push(id) }, t,
  } as never))
  const inPlace = mount()
  try {
    for (let tick = 0; tick < 6; tick++) await inPlace.tick()
    await inPlace.remount()
    for (let tick = 0; tick < 4; tick++) await inPlace.tick()
    // The remount settles again on purpose (the host is asked to record it once more), but the
    // rewrite itself must never be posted twice: a second in-place rewrite is not a no-op.
    check('the built-in in-place backend is driven from the browser: posted once to our own route, then settled',
      backendPosts.length === 1 && backendPosts[0]!.endsWith(REWRITE_ROUTE) && settles >= 1,
      JSON.stringify({ backendPosts, settles, storage: [...storageData] }))
    check('and the open transcript is rebuilt for the session the record changed in',
      refreshed.length === 1 && refreshed[0] === 'session-1', JSON.stringify(refreshed))
    // The same driver must stay silent for a selection nothing answers for: this is the stale-id
    // case (a backend another build had), which the host clears and the panel must not chase.
    pending.config.rewriteBackend = 'placeholder'
    pending.pendingBranch = 'in-place-1'
    storageData.clear()
    backendPosts.length = 0
    settles = 0
    const unknown = mount()
    try {
      for (let tick = 0; tick < 4; tick++) await unknown.tick()
      check('a selection nothing answers for posts nothing, settles nothing and claims nothing',
        backendPosts.length === 0 && settles === 0 && !storageData.has('reasoning-distill:handoff:session-1:in-place-1')
        // Nothing was written, so nothing may claim the transcript is stale.
        && refreshed.length === 1,
        JSON.stringify({ backendPosts, settles, refreshed, storage: [...storageData] }))
    } finally { unknown.stop() }
  } finally { inPlace.stop() }
  // A failure marker is not a child-exit notification. The panel must keep Stop enabled.
  globals.fetch = async () => ({ ok: true, json: async () => ({
    job: { ...jobFixture, phase: 'failed', error: 'verify failed' },
    backends: [{ id: 'message-edit' }], steps: [], repo: '/repo',
  }) }) as Response
  let installMarkup = ''
  const installer = effectHarness(() => {
    installMarkup = renderToStaticMarkup(InstallBackendPanel({ open: true, onClose: noop, t }))
  })
  try {
    await installer.tick()
    check('a failed live installer disables Start and still enables Cancel',
      /<button[^>]*disabled=""[^>]*>install.start<\/button>/.test(installMarkup)
      && /<button(?![^>]*disabled)[^>]*>install.cancel<\/button>/.test(installMarkup))
  } finally { installer.stop() }
} finally {
  globals.fetch = priorFetch
  globals.window = priorWindow
  globals.document = priorDocument
}

console.log(`\n${failures === 0 ? 'ALL RENDER CHECKS PASSED' : `${failures} RENDER CHECK(S) FAILED`}`)
console.log(log.join('\n'))
process.exitCode = failures === 0 ? 0 : 1
