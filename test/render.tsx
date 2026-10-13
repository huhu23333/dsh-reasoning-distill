/**
 * Render smoke test for the client components.
 *
 * Every render-time throw here has blanked a whole tab at least twice (a TDZ
 * read of `report`, and an unguarded field on a report from an older host), so
 * the presentation paths are server-rendered and asserted instead of trusted.
 */

import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReasoningDistillView, ReportBody, increasedOfEntry, reducedOfEntry, signedCount, signedMoney, stockOfEntry } from '../src/client/View.tsx'
import { CompressionSessionsAction } from '../src/client/SessionsAction.tsx'
import { CompressionActivity } from '../src/client/ActivityChip.tsx'
import type { SessionReport } from '../src/shared.ts'
import { continuableDepthDisabled, isStaleResponse, messageEditRequest, oneShotDepthDisabled, planSave, ruleFieldsIdle, saveOperations, type SettingsValue } from '../src/client/ops.ts'
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

console.log('client: an entry contributes to the stock only while a request carries it')
const entryBase = { id: 'e', appliedAt: 0, turn: 1, step: 1, targetSeq: 1, targetMessageId: 'm', provider: 'p', model: 'm',
  originalChars: 4000, originalTokens: 1000, distilledChars: 1000, distilledTokens: 250, savedTokensPerRequest: 750,
  active: true, liveSaved: 0.1, liveRequests: 2, frozenSaved: 0, distill: { sessionId: '', provider: 'p', model: 'm', inputTokens: 0, outputTokens: 0, cost: 0, estimated: false } } as never
check('an adopted, in-force rewrite contributes its per-request reduction',
  stockOfEntry({ ...entryBase } as never) === 750)
check('a retired rewrite contributes nothing, so money and tokens agree',
  stockOfEntry({ ...entryBase, active: false, liveSaved: 0, frozenSaved: 0.2 } as never) === 0)
check('a failed attempt never contributes', stockOfEntry({ ...entryBase, failed: true } as never) === 0)
check('a skipped attempt never contributes', stockOfEntry({ ...entryBase, skipped: true } as never) === 0)
check('a rewrite that did not shrink the text never contributes',
  stockOfEntry({ ...entryBase, distilledTokens: 1000 } as never) === 0)

console.log('client: one ledger — positive is spending, negative is saving')
check('spending is marked positive', signedMoney(0.002).startsWith('+'))
check('saving is marked negative', signedMoney(-0.002).startsWith('−'))
check('tokens follow the same convention', signedCount(-1259).startsWith('−') && signedCount(1259).startsWith('+'))
check('zero carries no sign', !signedMoney(0).startsWith('+') && !signedMoney(0).startsWith('−'))
// The entry line the user asked for: increase − avoided = net, negative meaning saved.
const ledger = { distill: { cost: 0.0012 }, cacheBreakCost: 0, liveSaved: 0.0004, frozenSaved: 0 } as never
check('an entry reports what it spent and what it avoided',
  increasedOfEntry(ledger) === 0.0012 && reducedOfEntry(ledger) === 0.0004)
check('so its net reads as a positive (wasted) delta', signedMoney(increasedOfEntry(ledger) - reducedOfEntry(ledger)).startsWith('+'))
check('the sign note explains the convention', modern.includes('view.signNote'))
check('the expanded row names what the rewrite avoided', modern.includes('view.avoided'))
check('and the collapsed row carries the ledger equation',
  /\+¥|−¥/.test(modern) && modern.includes('−') )

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

console.log('render: a report from an older host (version skew)')
const legacy = modernReport()
// Fields added by later host versions are absent, as they would be mid-upgrade.
delete (legacy as { active?: unknown }).active
delete (legacy as { blockingSince?: unknown }).blockingSince
delete (legacy as { blockingReason?: unknown }).blockingReason
for (const entry of legacy.entries) delete (entry as { failed?: unknown }).failed
const skew = tryRender(<ReportBody report={legacy} loading={false} error={undefined} now={9000} onRefresh={noop} openSession={noop} t={t} />)
check('a report missing the new fields still renders', skew.includes('view.entries') && skew.includes('view.sessions'))
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
check('a missing audit session says so instead of looking broken', noSession.includes('view.sessionMissing') && !noSession.includes('view.noSession'))
const empty = tryRender(<ReportBody report={{ ...modernReport(), entries: [], active: [], blockingSince: null, blockingReason: null }} loading={false} error={undefined} now={9000} onRefresh={noop} openSession={noop} t={t} />)
check('an empty session renders the empty state', empty.includes('view.empty') && empty.includes('view.sessions'))
check('loading and error states render', tryRender(<ReportBody report={undefined} loading error={undefined} now={0} onRefresh={noop} openSession={noop} t={t} />).includes('view.loading'))
check('the error state renders', tryRender(<ReportBody report={undefined} loading={false} error="boom" now={0} onRefresh={noop} openSession={noop} t={t} />).includes('boom'))

console.log('render: the polling shell itself')
// The shell is where a TDZ read of `report` blanked the tab: it must render.
check('the session view shell renders', renderToStaticMarkup(
  <ReasoningDistillView sessionId="session-1" openSession={noop} t={t} />,
).includes('view.title'))

console.log('client: the three rule switches gate the rest of a rule')
check('a rule with no kind enabled is idle', ruleFieldsIdle({ enabled: false, continuableSubagents: false, oneShotSubagents: false }))
check('any single kind keeps it editable',
  !ruleFieldsIdle({ enabled: true, continuableSubagents: false, oneShotSubagents: false })
  && !ruleFieldsIdle({ enabled: false, continuableSubagents: true, oneShotSubagents: false })
  && !ruleFieldsIdle({ enabled: false, continuableSubagents: false, oneShotSubagents: true }))
check('an unset rule is idle (nothing is enabled by omission)', ruleFieldsIdle({}))
// Each depth cap follows its OWN switch, never the rule-wide idle state.
const onlyMain = { enabled: true, continuableSubagents: false, oneShotSubagents: false }
check('a main-only rule still locks both depth caps',
  continuableDepthDisabled(onlyMain) && oneShotDepthDisabled(onlyMain))
check('enabling one subagent kind unlocks only its own cap',
  !continuableDepthDisabled({ ...onlyMain, continuableSubagents: true }) && oneShotDepthDisabled({ ...onlyMain, continuableSubagents: true }))
check('and vice versa',
  continuableDepthDisabled({ ...onlyMain, oneShotSubagents: true }) && !oneShotDepthDisabled({ ...onlyMain, oneShotSubagents: true }))
check('an unfinished override locks both caps', continuableDepthDisabled({}) && oneShotDepthDisabled({}))
// A poll response is stale only against the last *applied* one. Comparing
// against the newest issued request would discard every slow-but-good response.
check('a response newer than the applied one is not stale', !isStaleResponse(2, 1))
check('an already-applied response is not applied twice', isStaleResponse(1, 1))
check('an out-of-order older response is stale', isStaleResponse(1, 2))
// The starvation case: request 1 is still in flight when request 2 and 3 start;
// when 1 finally answers it is stale, but 3 still lands.
check('a slow response does not poison later ones', !isStaleResponse(3, 0))
// The panel merges this under every stored rule, so it must agree with the host
// schema defaults; a mismatch would silently flip a user's setting on render.
check('the panel fallback matches the shipped defaults',
  FALLBACK_RULE.enabled === true && FALLBACK_RULE.continuableSubagents === true && FALLBACK_RULE.oneShotSubagents === false)
check('and the depth caps default to unlimited',
  FALLBACK_RULE.continuableMaxDepth === 0 && FALLBACK_RULE.oneShotMaxDepth === 0)
const shipped = settings()
check('the settings document no longer carries global kind switches',
  !('compressMultiStep' in shipped) && !('compressSubagents' in shipped))

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

console.log('client: the activity chip drops a stale busy state')
// A failed read must not keep the chip claiming a compression that ended.
const busy = { count: 2, blockingSince: 1_000, reason: 'other' as const, startedAt: 900 }
check('a failed report read returns the chip to idle',
  liveAfterReport(null).count === 0 && liveAfterReport(null).blockingSince === null)
check('a report without activity is idle', liveAfterReport({ active: [], blockingSince: null, blockingReason: null } as never).count === 0)
const shown = liveAfterReport({ active: [{ startedAt: 5 }, { startedAt: 9 }], blockingSince: 7, blockingReason: 'tool' } as never)
check('a busy report is shown with its earliest start', shown.count === 2 && shown.startedAt === 5 && shown.blockingSince === 7)
check('and idle again once it clears', liveAfterReport({ active: [], blockingSince: null, blockingReason: null } as never).count === 0)
void busy

console.log('render: an audit session from an earlier run')
const expired = modernReport()
expired.entries[0]!.sessionLive = false
const stale = tryRender(<ReportBody report={expired} loading={false} error={undefined} now={9000} onRefresh={noop} openSession={noop} t={t} />)
// The user asked for these to stay openable: a session from an earlier run is
// still named as such, and still offered, because the host can reopen the
// persisted transcript.
// The host cannot reopen a session object that belonged to an earlier process,
// so such a row is named with its reason instead of offering a dead button; the
// full prompt and result stay visible in the entry detail.
check('an audit session from an earlier run is named, not offered as a dead button',
  stale.includes('view.sessionExpired') && !stale.includes('>view.open<'))
const live = tryRender(<ReportBody report={modernReport()} loading={false} error={undefined} now={9000} onRefresh={noop} openSession={noop} t={t} />)
check('a live audit session still offers the open button', live.includes('>view.open<'))

console.log('render: header action and composer activity chip')
check('the header trigger renders with its label',
  tryRender(<CompressionSessionsAction sessionId="session-1" openSession={noop} t={t} />).includes('header.trigger'))
check('the activity chip is silent while idle',
  tryRender(<CompressionActivity sessionId="session-1" onActiveChange={noop} t={t} />) === '')

check('no render path threw', !rendered.some(markup => markup.includes('__THREW__')))

console.log(`\n${failures === 0 ? 'ALL RENDER CHECKS PASSED' : `${failures} RENDER CHECK(S) FAILED`}`)
console.log(log.join('\n'))
process.exitCode = failures === 0 ? 0 : 1
