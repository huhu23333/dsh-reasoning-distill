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
import { ReasoningDistillView, ReportBody, increasedOfEntry, reducedOfEntry, signedCount, signedMoney, stockOfEntry } from '../src/client/View.tsx'
import { CompressionActivity } from '../src/client/ActivityChip.tsx'
import type { SessionReport } from '../src/shared.ts'
import { apply as applyClientPlugin } from '../src/client/index.ts'
import { REWRITE_BACKENDS, backendById, backendInstalled, continuableDepthDisabled, isStaleResponse, masterSwitchState, messageEditRequest, nextBackend, oneShotDepthDisabled, planSave, pendingRewriteOutcome, availableSessionStorage, rememberRewriteOutcome, rewriteApplyOutcome, rewriteRequest, ruleFieldsIdle, shouldRetrySettle, saveOperations, type SettingsValue, normalizeSettings } from '../src/client/ops.ts'
import { FALLBACK_RULE } from '../src/client/Settings.tsx'
import { liveAfterReport } from '../src/client/ActivityChip.tsx'

let failures = 0
const log: string[] = []
function check(label: string, ok: boolean): void {
  log.push(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
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
    config: { enabled: true, defaultThresholdTokens: 4000, defaultDistiller: 'a/b', peak: { enabled: false, source: 'builtin', label: 'builtin', detail: 'd' } },
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

console.log('client: the branch bridge speaks dsh-message-edit\'s contract')
const bridge = messageEditRequest('session-1', { targetSeq: 12, targetBlockIndex: 1 }, 'short reasoning')
check('the request matches the companion contract',
  bridge?.['action'] === 'edit' && bridge['sessionId'] === 'session-1' && bridge['eventSeq'] === 12
  && bridge['blockIndex'] === 1 && bridge['text'] === 'short reasoning' && bridge['cascade'] === 'truncate',
  JSON.stringify(bridge))
check('a preserve cascade can be requested',
  messageEditRequest('s', { targetSeq: 1, targetBlockIndex: 0 }, 'x', 'preserve')?.['cascade'] === 'preserve')
check('an unknown block index cannot be bridged',
  messageEditRequest('s', { targetSeq: 1, targetBlockIndex: -1 }, 'x') === undefined)
check('empty text cannot be bridged', messageEditRequest('s', { targetSeq: 1, targetBlockIndex: 0 }, '') === undefined)
check('a session without an id cannot be bridged', messageEditRequest('', { targetSeq: 1, targetBlockIndex: 0 }, 'x') === undefined)

console.log('client: the rewrite backend registry drives the panel')
check('three backends are offered: one branching, two in place',
  REWRITE_BACKENDS.length === 3
  && backendById('message-edit')?.kind === 'branch'
  && backendById('msg-edit')?.kind === 'in-place'
  && backendById('context-shaping')?.kind === 'in-place')
// Detection must not confuse a backend's own 404 ("no such session") with a
// missing route: the former answers with its JSON envelope.
check('a JSON 404 still proves the backend is installed', backendInstalled(404, 'application/json; charset=utf-8'))
check('a plain 404 means the route is absent', !backendInstalled(404, 'text/html'))
check('and a 404 without a content type is absent too', !backendInstalled(404, null))
check('any non-404 answer proves it is installed', backendInstalled(400, null) && backendInstalled(409, 'text/plain'))
check('an empty or unknown id resolves to no backend',
  backendById('') === undefined && backendById('nope') === undefined)
// Master switch: locked off with no backend, the user's choice otherwise.
check('no backend locks the master switch off', masterSwitchState('', true).locked && masterSwitchState('', true).checked === false)
check('a selected backend unlocks it and keeps the user value',
  !masterSwitchState('message-edit', true).locked && masterSwitchState('message-edit', true).checked === true)
check('and an uninstalled/unknown id does not unlock it', masterSwitchState('nope', true).locked)
// Requests: branch backend needs seq + block index, in-place backend needs the message id.
const target = { targetSeq: 12, targetMessageId: 'm-12', targetBlockIndex: 2 }
const branchCall = rewriteRequest('message-edit', 'session-1', target, 'short')
check('the branch backend is asked to edit the reasoning block',
  branchCall?.path === '/message-edit' && branchCall.body['eventSeq'] === 12 && branchCall.body['blockIndex'] === 2
  && branchCall.body['text'] === 'short' && branchCall.body['action'] === 'edit',
  JSON.stringify(branchCall))
const inPlaceCall = rewriteRequest('msg-edit', 'session-1', target, 'short')
check('the in-place backend is asked to rewrite the message reasoning',
  inPlaceCall?.path === '/api/msg-edit/rewrite-message' && inPlaceCall.body['messageId'] === 'm-12'
  && inPlaceCall.body['reasoning'] === 'short' && inPlaceCall.body['sessionId'] === 'session-1',
  JSON.stringify(inPlaceCall))
check('a missing block index cannot be sent to the branch backend',
  rewriteRequest('message-edit', 'session-1', { ...target, targetBlockIndex: -1 }, 'short') === undefined)
check('a missing message id cannot be sent to the in-place backend',
  rewriteRequest('msg-edit', 'session-1', { ...target, targetMessageId: '' }, 'short') === undefined)
const shapingCall = rewriteRequest('context-shaping', 'session-1', target, 'short')
check('the thinking-editing backend is asked for the reasoning part only',
  shapingCall?.path === '/api/dsh-context-shaping/edit' && shapingCall.body['part'] === 'thinking'
  && shapingCall.body['role'] === 'assistant' && shapingCall.body['messageId'] === 'm-12'
  && shapingCall.body['text'] === 'short',
  JSON.stringify(shapingCall))
check('no backend means no request at all', rewriteRequest('', 'session-1', target, 'short') === undefined)
check('empty text is never sent', rewriteRequest('msg-edit', 'session-1', target, '') === undefined)

console.log('client: activating the chosen backend again clears it')
check('clicking another backend switches to it', nextBackend('message-edit', 'msg-edit') === 'msg-edit')
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
  tryRender(<CompressionActivity sessionId="session-1" onActiveChange={noop} t={t} />) === '')

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

  const pending = modernReport()
  pending.config.rewriteBackend = 'msg-edit'
  pending.entries[0]!.id = 'in-place-1'
  pending.entries[0]!.targetMessageId = 'm-12'
  pending.entries[0]!.distilledText = 'capped'
  pending.pendingBranch = 'in-place-1'
  let backendPosts = 0
  let settles = 0
  globals.fetch = async (input: RequestInfo | URL) => {
    if (String(input).includes('/report')) return { ok: true, json: async () => pending } as Response
    if (String(input).includes('/handoff')) { settles++; return { ok: true, json: async () => ({ ok: true, recorded: false }) } as Response }
    backendPosts++
    return { ok: true, json: async () => ({ ok: true }) } as Response
  }
  const mount = (): ReturnType<typeof effectHarness> => effectHarness(() => ReasoningDistillView({ sessionId: 'session-1', openSession: noop, t } as never))
  const inPlace = mount()
  try {
    await inPlace.tick()
    await inPlace.tick()
    const beforeRemount = { backendPosts, settles }
    await inPlace.remount()
    await inPlace.tick()
    check('successful in-place POST survives remount: only failed handoff settlement retries',
      beforeRemount.backendPosts === 1 && beforeRemount.settles >= 1
      && backendPosts === 1 && settles > beforeRemount.settles && storageData.has('reasoning-distill:handoff:session-1:in-place-1'),
      JSON.stringify({ backendPosts, settles, storage: [...storageData] }))
  } finally { inPlace.stop() }
} finally {
  globals.fetch = priorFetch
  globals.window = priorWindow
  globals.document = priorDocument
}

console.log(`\n${failures === 0 ? 'ALL RENDER CHECKS PASSED' : `${failures} RENDER CHECK(S) FAILED`}`)
console.log(log.join('\n'))
process.exitCode = failures === 0 ? 0 : 1
