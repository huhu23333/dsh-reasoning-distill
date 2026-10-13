/**
 * Offline host-half smoke test.
 *
 * Bundled with the `@deepseek-ai/*` stubs aliased in, then run under Node. It
 * drives the engine through a fake session store and asserts the four things
 * that are hard to eyeball: the trigger, the substitution seen by
 * `deriveMessages()`, the per-request saving accounting, and the compaction
 * epoch reset.
 * @module dsh-reasoning-distill/test/smoke
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'rd-smoke-'))
process.env['DSH_HOME'] = home

const { ReasoningDistillEngine } = await import('../src/engine.ts')
const { SidecarStore, dshHome, legacySidecarPath, sidecarPath } = await import('../src/store.ts')
const { buildReport } = await import('../src/report.ts')

/** Minimal in-memory session. */
class FakeSession {
  readonly log: Array<{ type: string; seq: number; time: number; data: unknown; surfaceOp?: unknown }> = []
  readonly nodes: number[] = []
  constructor(
    readonly id: string,
    readonly header: { cwd?: string; origin?: 'subagent'; delegationDepth?: number } = { cwd: '/tmp' },
  ) {}

  get seq(): number { return this.log.length }
  get surface(): { nodes: number[] } { return { nodes: this.nodes } }

  append(type: string, data: unknown, intent?: { surfaceOp?: unknown }): { seq: number } {
    const seq = this.log.length
    const event = { type, seq, time: Date.now(), data, ...(intent ?? {}) }
    this.log.push(event)
    if (['system/message', 'user/message', 'assistant/message', 'tool/result'].includes(type)) this.nodes.push(seq)
    return { seq }
  }

  eventAt(seq: number): unknown { return this.log[seq] }

  deriveEventMessage(event: { type: string; data: unknown }): unknown {
    const data = event.data as Record<string, unknown>
    switch (event.type) {
      case 'assistant/message': return data['message']
      case 'tool/result': return data['message']
      case 'user/message': return data
      case 'system/message': return data['message']
      default: return null
    }
  }

  deriveMessages(): unknown[] {
    const out: unknown[] = []
    for (const seq of this.nodes) {
      const event = this.eventAt(seq)
      if (event === undefined) continue
      const message = this.deriveEventMessage(event as { type: string; data: unknown })
      if (message !== null) out.push(message)
    }
    return out
  }

  ownEvents(): unknown[] { return this.log }
}

const created: FakeSession[] = []
const handlers = new Map<string, Function[]>()
const info: string[] = []

const sessions = new Map<string, FakeSession>()
/** Effect bodies registered by engines, so unloading can be exercised. */
const effects: Array<() => unknown> = []
const main = new FakeSession('session-main')
sessions.set(main.id, main)

const fakeLlm = {
  calls: 0,
  stream(options: { messages: unknown[] }): AsyncIterable<unknown> {
    this.calls += 1
    const text = 'Distilled: ask for Paris weather and call the tool.'
    const chunks = [
      { type: 'text-delta', index: 0, text },
      { type: 'usage', usage: { inputTokens: 900, outputTokens: 20, cacheReadTokens: 0 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    void options
    return (async function* gen() { for (const chunk of chunks) yield chunk })()
  },
}

const ctx = {
  logger: {
    info: (message: string, ...args: unknown[]) => { console.log(`    [info] ${message} ${args.join(' ')}`); info.push(`${message}`) },
    warn: (message: string, ...args: unknown[]) => { console.log(`    [warn] ${message} ${args.map(a => a instanceof Error ? a.stack : String(a)).join(' ')}`); info.push(`WARN ${message}`) },
    debug: (message: string, ...args: unknown[]) => { if (process.env['RD_DEBUG']) console.log(`    [debug] ${message} ${args.join(' ')}`) },
  },
  sessions: {
    list: () => [...sessions.values()],
    get: (id: string) => sessions.get(id),
    flush: async () => true,
    create: () => {
      const session = new FakeSession(`session-compress-${created.length + 1}`)
      created.push(session)
      sessions.set(session.id, session)
      return session
    },
  },
  llm: fakeLlm,
  on: (name: string, fn: Function) => {
    const list = handlers.get(name) ?? []
    list.push(fn)
    handlers.set(name, list)
    return () => undefined
  },
  inject: () => undefined,
  effect: (body: () => unknown) => { effects.push(body) },
  fiber: {},
}

/** Fire one observed event into every registered listener. */
async function fire(name: string, ...args: unknown[]): Promise<void> {
  for (const fn of handlers.get(name) ?? []) await fn(...args)
}

/**
 * Wait for a fire-and-forget observer chain to land. Compaction handling applies
 * its epoch change inside the store's write queue, and the queue touches real
 * I/O, so a single macrotask is not a guarantee.
 * @param predicate - resolves true once the effect is visible.
 */
async function settleFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Live configuration shim mirroring the real Volatile readers. */
function makeConfig(overrides: Record<string, unknown> = {}): never {
  return {
    enabled: { get: () => true },
    defaultRule: { get: () => ({
      enabled: true,
      thresholdTokens: 200,
      minSavedTokens: 5,
      includeToolResults: true,
      includeFinalTurns: true,
      timeoutMs: 5000,
      peakPricing: false,
      distiller: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' },
    }) },
    models: { get: () => ({}) },
    prices: { get: () => ({}) },
    peakSource: { get: () => 'builtin' },
    // A selected backend is required for compression; scenarios override it to
    // exercise the no-backend refusal (scenario 36).
    rewriteBackend: { get: () => 'message-edit' },
    holidays: { get: () => [] },
    prompt: { get: () => '' },
    maxInputChars: { get: () => 100000 },
    maxOutputChars: { get: () => 0 },
    ...overrides,
  } as never
}

let failures = 0
/** Assert one condition. */
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label} ${detail}`)
  }
}

const config = makeConfig()
const store = new SidecarStore()
const engine = new ReasoningDistillEngine(ctx as never, config as never, store)
engine.start()

// --- fixture: system + user + a fat reasoning assistant message with a tool call
main.append('system/message', { turn: 1, step: 1, message: { id: 'sys-1', role: 'system', content: [{ type: 'text', text: 'system' }], source: { kind: 'system-prompt' } } })
main.append('user/message', { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'weather in Paris?' }], source: { kind: 'user' } })
const longReasoning = 'hmm, let me think. '.repeat(120)
const assistantSeq = main.append('assistant/message', {
  turn: 1,
  step: 1,
  message: {
    id: 'a-1',
    role: 'assistant',
    content: [
      { type: 'reasoning', text: longReasoning },
      { type: 'tool-call', id: 'c-1', name: 'get_weather', arguments: '{"city":"Paris"}' },
    ],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  stream: [],
}).seq
main.append('tool/result', {
  turn: 1, step: 1,
  message: { id: 't-1', role: 'tool', toolCallId: 'c-1', content: [{ type: 'text', text: 'Sunny 22C' }], source: { kind: 'tool' } },
}, { surfaceOp: 'append' })
main.append('step/end', { turn: 1, step: 1 })

console.log('scenario 1: trigger + substitution')
await fire('session/event', main, main.eventAt(assistantSeq))
await fire('session/event', main, main.eventAt(main.log.length - 1))
await fire('agent/pre-step', { agent: { session: main } }, async () => undefined)

const record = await store.load(main.id)
check('one compression applied', record.entries.length === 1, JSON.stringify(record.entries.length))
check('distiller called once', fakeLlm.calls === 1, String(fakeLlm.calls))
check('a compression session was opened', created.length === 1, String(created.length))
const derived = main.deriveMessages() as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
const assistant = derived.find(message => message.role === 'assistant')
const reasoning = assistant?.content.find(block => block.type === 'reasoning')
check('derived reasoning is the distilled text', reasoning?.text === 'Distilled: ask for Paris weather and call the tool.', String(reasoning?.text))
check('tool-call block survives', assistant?.content.some(block => block.type === 'tool-call') === true)
check('original log untouched', (main.log[assistantSeq]!.data as { message: { content: Array<{ text?: string }> } }).message.content[0]!.text === longReasoning)
const sidecar = JSON.parse(readFileSync(sidecarPath('session-main'), 'utf8'))
check('sidecar persisted', Array.isArray(sidecar.entries) && sidecar.entries.length === 1)

console.log('scenario 2: per-request saving accounting')
const saved = record.entries[0]!.savedTokensPerRequest
main.append('assistant/message', {
  turn: 1, step: 2,
  message: { id: 'a-2', role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
})
await fire('session/event', main, main.eventAt(main.log.length - 1))
let after = await store.load(main.id)
const expected = saved * 0.00000004 * 2 // 2 later requests? one answered request so far
check('live saving accumulated', after.entries[0]!.liveSaved > 0, String(after.entries[0]!.liveSaved))
check('requests counted', after.entries[0]!.liveRequests === 1, String(after.entries[0]!.liveRequests))
void expected

console.log('scenario 3: a compaction only freezes the rewrites it actually removed')
const live3 = after.entries[0]!.liveSaved
const total3 = live3 + after.entries[0]!.frozenSaved
// A compaction that leaves the target on the surface — a failed one, or a
// partial one that only compressed an older range — must not stop the savings:
// the rewrite is still replayed, so it must still be credited.
main.append('compaction/end', { compactionId: 'c-1', turn: 1 })
await fire('session/event', main, main.eventAt(main.log.length - 1))
await settleFor(async () => (await store.load(main.id)).epoch === 1)
after = await store.load(main.id)
check('a surviving rewrite keeps its live savings', after.entries[0]!.liveSaved === live3, `${after.entries[0]!.liveSaved} vs ${live3}`)
check('and stays active in the report', buildReport(main.id, after, config as never).entries[0]!.active === true)
check('it is not marked inactive', after.entries[0]!.inactive !== true)
// Now the compaction really removes the rewritten node.
const target3 = after.entries[0]!.targetSeq
main.nodes.splice(0, main.nodes.length, ...main.nodes.filter(seq => seq !== target3))
main.append('compaction/end', { compactionId: 'c-2', turn: 1 })
await fire('session/event', main, main.eventAt(main.log.length - 1))
await settleFor(async () => (await store.load(main.id)).epoch === 2)
after = await store.load(main.id)
check('a removed rewrite is frozen', after.entries[0]!.liveSaved === 0 && after.entries[0]!.frozenSaved === total3, `${after.entries[0]!.frozenSaved} vs ${total3}`)
check('and marked inactive', after.entries[0]!.inactive === true)
check('the report shows it inactive', buildReport(main.id, after, config as never).entries[0]!.active === false)

console.log('scenario 4: report totals')
const report = buildReport(main.id, after, config as never)
const expectedNet = report.savedTotal - report.distillCost - report.cacheBreakCost
check('net is derived', Math.abs(report.net - expectedNet) < 1e-12, String(report.net))
check('distill cost is priced', report.distillCost > 0, String(report.distillCost))
check('cache break is priced', report.cacheBreakCost >= 0, String(report.cacheBreakCost))
check('savedTotal survives the epoch reset', report.savedTotal > 0, String(report.savedTotal))
check('savedLive is zero in an archived epoch', report.savedLive === 0, String(report.savedLive))

console.log('scenario 5: peak attribution')
const { periodFor } = await import('../src/peak.ts')
const peakCfg = makeConfig()
const wed10 = Date.UTC(2026, 9, 14, 2)   // Wednesday 10:00 Beijing
const wed02 = Date.UTC(2026, 9, 14, 18)  // Thursday 02:00 Beijing
const sat10 = Date.UTC(2026, 9, 17, 2)   // Saturday 10:00 Beijing
check('peak pricing off always uses the first column', periodFor(wed02, false, peakCfg as never) === 'peak' && periodFor(sat10, false, peakCfg as never) === 'peak')
check('weekday 10:00 Beijing is peak', periodFor(wed10, true, peakCfg as never) === 'peak')
check('weekday 02:00 Beijing is off-peak', periodFor(wed02, true, peakCfg as never) === 'off')
check('weekend is off-peak', periodFor(sat10, true, peakCfg as never) === 'off')

const { priceAt } = await import('../src/peak.ts')
const oneColumn = { 'deepseek-flash': { peak: { hit: 1, miss: 2, out: 3 } } }
const twoColumns = { 'deepseek-flash': { peak: { hit: 1, miss: 2, out: 3 }, off: { hit: 0.5, miss: 1, out: 1.5 }, peakPricing: true } }
const weekendOne = priceAt('deepseek-flash', oneColumn as never, sat10, peakCfg as never)
const weekendTwo = priceAt('deepseek-flash', twoColumns as never, sat10, peakCfg as never)
check('price entry without the flag stays on column 1', weekendOne.period === 'peak' && weekendOne.bucket.hit === 1)
check('price entry with the flag splits on a weekend', weekendTwo.period === 'off')
check('the split bills the second column', weekendTwo.bucket.hit === 0.5)

console.log('scenario 6: tool calls always travel, results only on request')
// Drop the earlier engine's listeners so only the new one observes this session.
handlers.clear()
const ruleRef = {
  enabled: true, thresholdTokens: 200, minSavedTokens: 5,
  includeToolResults: true, includeFinalTurns: true, timeoutMs: 5000,
  distiller: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' },
}
const cfgTools = makeConfig({ defaultRule: { get: () => ruleRef } })
const store6 = new SidecarStore()
const engine6 = new ReasoningDistillEngine(ctx as never, cfgTools as never, store6)
engine6.start()
const s6 = new FakeSession('session-tools')
sessions.set(s6.id, s6)
await fire('session/created', s6)
const fatReasoning = 'hmm, let me think. '.repeat(120)

/** Run one step of the fake tool loop and settle its compression. */
async function runStep(turn: number): Promise<void> {
  s6.append('user/message', { id: `u-${turn}`, role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
  const seq = s6.append('assistant/message', {
    turn, step: 1,
    message: {
      id: `a-${turn}`, role: 'assistant',
      content: [
        { type: 'reasoning', text: fatReasoning },
        { type: 'tool-call', id: `c-${turn}`, name: 'read', arguments: '{"path":"/tmp/x"}' },
        { type: 'text', text: 'VISIBLE_REPLY_MARKER' },
      ],
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
    },
    stream: [],
  }).seq
  s6.append('tool/result', {
    turn, step: 1,
    message: { id: `t-${turn}`, role: 'tool', toolCallId: `c-${turn}`, content: [{ type: 'text', text: 'TOOL_OUTPUT_MARKER' }], source: { kind: 'tool' } },
  }, { surfaceOp: 'append' })
  s6.append('step/end', { turn, step: 1 })
  await fire('session/event', s6, s6.eventAt(seq))
  await fire('session/event', s6, s6.eventAt(s6.log.length - 1))
  await fire('agent/pre-step', { agent: { session: s6 } }, async () => undefined)
}

await runStep(1)
ruleRef.includeToolResults = false
await runStep(2)
const rec6 = await store6.load(s6.id)
const withResults = rec6.entries[0]!.distill.requestText
const withoutResults = rec6.entries[1]!.distill.requestText
check('two compressions recorded', rec6.entries.length === 2, String(rec6.entries.length))
check('tool calls always attached', withResults.includes('## Tool calls from this step') && withoutResults.includes('## Tool calls from this step'))
check('results attached when the switch is on', withResults.includes('## Tool results') && withResults.includes('TOOL_OUTPUT_MARKER'))
// The step's own visible text travels too, and every non-rewritten section says
// out loud that it is context the distiller must not copy.
check('the step\'s visible text is supplied as context',
  withResults.includes('## Assistant text from this step') && withResults.includes('VISIBLE_REPLY_MARKER'),
  withResults.slice(0, 400))
check('and that section is marked context-only', withResults.includes('(context only, never copy)'))
check('results are marked context-only too', withResults.includes('## Tool results (context only, never copy)'))
check('results omitted when the switch is off', !withoutResults.includes('## Tool results') && !withoutResults.includes('TOOL_OUTPUT_MARKER'))

console.log('scenario 7: a timeout abandons that compression')
handlers.clear()
const slowLlm = {
  stream(options: { signal?: AbortSignal } = {}) {
    const chunks = [
      { type: 'text-delta', index: 0, text: 'Distilled late.' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    return (async function* gen() {
      await new Promise(resolve => setTimeout(resolve, 400))
      // A real adapter aborts its HTTP request; the harness then sees a terminal
      // aborted finish instead of content.
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted' } }
        return
      }
      for (const chunk of chunks) yield chunk
    })()
  },
}
const rule7 = {
  enabled: true, thresholdTokens: 200, minSavedTokens: 5,
  includeToolResults: true, includeFinalTurns: true, timeoutMs: 200,
  distiller: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' },
}
const cfg7 = makeConfig({ defaultRule: { get: () => rule7 } })
const store7 = new SidecarStore()
const engine7 = new ReasoningDistillEngine({ ...ctx, llm: slowLlm } as never, cfg7 as never, store7)
engine7.start()
const s7 = new FakeSession('session-timeout')
sessions.set(s7.id, s7)
await fire('session/created', s7)
s7.append('user/message', { id: 'u7', role: 'user', content: [{ type: 'text', text: 'answer directly' }], source: { kind: 'user' } })
const seq7 = s7.append('assistant/message', {
  turn: 1, step: 1,
  message: {
    id: 'a7', role: 'assistant',
    content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'done' }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  stream: [],
}).seq
s7.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s7, s7.eventAt(seq7))
await fire('session/event', s7, s7.eventAt(s7.log.length - 1))
const startedAt = Date.now()
await fire('agent/pre-step', { agent: { session: s7 } }, async () => undefined)
const elapsed = Date.now() - startedAt
check('the step waits for the outcome, then proceeds', elapsed >= 150 && elapsed < 1500, `${elapsed}ms`)
const rec7 = await store7.load(s7.id)
check('the abandoned attempt is still recorded', rec7.entries.length === 1 && rec7.entries[0]!.failed === true, JSON.stringify(rec7.entries.map(e => e.failed)))
check('it spends but saves nothing', rec7.entries[0]!.distill.cost > 0 && rec7.entries[0]!.savedTokensPerRequest === 0,
  `${rec7.entries[0]!.distill.cost} / ${rec7.entries[0]!.savedTokensPerRequest}`)
check('the unreported usage is flagged as estimated', rec7.entries[0]!.distill.estimated === true)
const lateAssistant = s7.deriveMessages().find(message => (message as { role: string }).role === 'assistant') as { content: Array<{ type: string; text?: string }> }
check('the reasoning stays untouched', lateAssistant.content.some(block => block.type === 'reasoning' && block.text === fatReasoning))
const report7 = buildReport(s7.id, rec7, cfg7 as never)
check('the report counts that spending', report7.distillCost > 0 && report7.savedTotal === 0, `${report7.distillCost} / ${report7.savedTotal}`)
const failedSession = created.find(session => session.id === 'session-compress-1')
check('the failed compression session is closed, not left hanging', failedSession !== undefined && failedSession.log.some(event => event.type === 'turn/end'))

console.log('scenario 8: live state while a compression holds a step')
handlers.clear()
let release: (() => void) | undefined
const gatedLlm = {
  stream() {
    return (async function* gen() {
      await new Promise<void>(resolve => { release = resolve })
      yield { type: 'text-delta', index: 0, text: 'Late answer.' }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
const cfg8 = makeConfig()
const store8 = new SidecarStore()
const engine8 = new ReasoningDistillEngine({ ...ctx, llm: gatedLlm } as never, cfg8 as never, store8)
engine8.start()
const s8 = new FakeSession('session-live')
sessions.set(s8.id, s8)
await fire('session/created', s8)
s8.append('user/message', { id: 'u8', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq8 = s8.append('assistant/message', {
  turn: 1, step: 1,
  message: {
    id: 'a8', role: 'assistant',
    content: [
      { type: 'reasoning', text: fatReasoning },
      { type: 'tool-call', id: 'c8', name: 'read', arguments: '{"path":"/tmp/y"}' },
    ],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  stream: [],
}).seq
s8.append('tool/result', {
  turn: 1, step: 1,
  message: { id: 't8', role: 'tool', toolCallId: 'c8', content: [{ type: 'text', text: 'OUT' }], source: { kind: 'tool' } },
}, { surfaceOp: 'append' })
s8.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s8, s8.eventAt(seq8))
await fire('session/event', s8, s8.eventAt(s8.log.length - 1))
// The launch is gated on one record read, so it appears a microtask later.
await settleFor(async () => engine8.snapshot(s8.id).active.length === 1)
const idle = engine8.snapshot(s8.id)
check('a running compression is visible', idle.active.length === 1 && idle.active[0]!.turn === 1 && idle.active[0]!.step === 1, JSON.stringify(idle.active))
check('nothing is reported as blocked yet', idle.blockingSince === null)

const held = fire('agent/pre-step', { agent: { session: s8 } }, async () => undefined)
await new Promise(resolve => setTimeout(resolve, 30))
const blocked = engine8.snapshot(s8.id)
check('the held step reports when and why it is waiting', blocked.blockingSince !== null && blocked.blockingReason === 'tool', `${blocked.blockingSince} / ${blocked.blockingReason}`)
release?.()
await held
const settled = engine8.snapshot(s8.id)
check('the wait clears once the compression lands', settled.active.length === 0 && settled.blockingSince === null)
const rec8 = await store8.load(s8.id)
check('and the rewrite is in place for the next request', rec8.entries.length === 1 && rec8.entries[0]!.failed !== true)
const assistant8 = s8.deriveMessages().find(message => (message as { role: string }).role === 'assistant') as { content: Array<{ type: string; text?: string }> }
check('the derived history carries the distilled text', assistant8.content.some(block => block.type === 'reasoning' && block.text === 'Late answer.'))
check('the entry records which compression session to open',
  typeof rec8.entries[0]!.distill.sessionId === 'string' && rec8.entries[0]!.distill.sessionId !== '',
  JSON.stringify(rec8.entries[0]!.distill.sessionId))
check('that session actually exists so the UI can open it',
  created.some(session => session.id === rec8.entries[0]!.distill.sessionId))

console.log('scenario 9: a truncated distillation is never substituted')
handlers.clear()
const truncatedLlm = {
  stream() {
    return (async function* gen() {
      yield { type: 'text-delta', index: 0, text: 'Half a rewrite, then the cap hits' }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 9, cacheReadTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })()
  },
}
const cfg9 = makeConfig()
const store9 = new SidecarStore()
const engine9 = new ReasoningDistillEngine({ ...ctx, llm: truncatedLlm } as never, cfg9 as never, store9)
engine9.start()
const s9 = new FakeSession('session-truncated')
sessions.set(s9.id, s9)
await fire('session/created', s9)
s9.append('user/message', { id: 'u9', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq9 = s9.append('assistant/message', {
  turn: 1, step: 1,
  message: {
    id: 'a9', role: 'assistant',
    content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'VISIBLE_REPLY_MARKER' }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  stream: [],
}).seq
s9.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s9, s9.eventAt(seq9))
await fire('session/event', s9, s9.eventAt(s9.log.length - 1))
await fire('agent/pre-step', { agent: { session: s9 } }, async () => undefined)
const rec9 = await store9.load(s9.id)
check('a max-tokens rewrite is recorded as abandoned', rec9.entries.length === 1 && rec9.entries[0]!.failed === true)
check('and its reported usage is still billed, not estimated', rec9.entries[0]!.distill.estimated !== true && rec9.entries[0]!.distill.cost > 0)
const assistant9 = s9.deriveMessages().find(message => (message as { role: string }).role === 'assistant') as { content: Array<{ type: string; text?: string }> }
check('the truncated text never reaches the history', assistant9.content.some(block => block.type === 'reasoning' && block.text === fatReasoning))
check('the compression session is still linked', rec9.entries[0]!.distill.sessionId !== '')

console.log('scenario 10: review findings')
handlers.clear()
const replayFixture = {
  kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash',
  replayState: {
    response: { id: 'r-1', model: 'deepseek-flash' },
    blocks: [
      { type: 'reasoning', thinkingSignature: 'SIG-A' },
      { type: 'reasoning', signature: 'SIG-B' },
      { type: 'text', textSignature: 'TEXT-SIG' },
    ],
  },
}
const cfg10 = makeConfig({ defaultRule: { get: () => ({
  enabled: true, thresholdTokens: 200, minSavedTokens: 5,
  includeToolResults: true, includeFinalTurns: true, timeoutMs: 5000,
  distiller: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' },
}) } })
const store10 = new SidecarStore()
const engine10 = new ReasoningDistillEngine(ctx as never, cfg10 as never, store10)
engine10.start()
const s10 = new FakeSession('session-review')
sessions.set(s10.id, s10)
await fire('session/created', s10)
s10.append('user/message', { id: 'u10', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq10 = s10.append('assistant/message', {
  turn: 1, step: 1,
  message: {
    id: 'durable-assistant-id', role: 'assistant',
    content: [
      { type: 'reasoning', text: fatReasoning },
      { type: 'reasoning', text: fatReasoning },
      { type: 'text', text: 'done' },
    ],
    source: replayFixture,
  },
  stream: [],
}).seq
s10.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s10, s10.eventAt(seq10))
await fire('session/event', s10, s10.eventAt(s10.log.length - 1))
await fire('agent/pre-step', { agent: { session: s10 } }, async () => undefined)
const derived10 = s10.deriveMessages().find(message => (message as { id?: string }).id === 'durable-assistant-id') as {
  id: string
  content: Array<{ type: string; text?: string }>
  source: { replayState?: { blocks?: Array<Record<string, unknown>> } }
}
check('every reasoning block is folded into one rewrite', derived10.content.filter(block => block.type === 'reasoning').length === 1)
check('the durable message identity survives derivation', derived10.id === 'durable-assistant-id')
const replay10 = derived10.source.replayState?.blocks ?? []
check('replay stays aligned with the new content', replay10.length === derived10.content.length, `${replay10.length} vs ${derived10.content.length}`)
check('no signature survives next to rewritten text',
  !JSON.stringify(replay10).includes('SIG-A') && !JSON.stringify(replay10).includes('SIG-B') && !JSON.stringify(replay10).includes('thinkingSignature'))
check('untouched text keeps its own replay payload', JSON.stringify(replay10).includes('TEXT-SIG'))

console.log('scenario 10b: savings are credited only for substitutions that shipped')
const before10b = (await store10.load(s10.id)).entries[0]!
const targetSeq10 = before10b.targetSeq
// Simulate a compaction that shadows the compressed message.
s10.nodes.splice(0, s10.nodes.length, ...s10.nodes.filter(seq => seq !== targetSeq10))
s10.deriveMessages()
const probeSeq = s10.append('assistant/message', {
  turn: 2, step: 1,
  message: { id: 'a10b', role: 'assistant', content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
await fire('session/event', s10, s10.eventAt(probeSeq))
const after10b = (await store10.load(s10.id)).entries.find(entry => entry.id === before10b.id)!
check('a target that is no longer in the surface earns nothing', after10b.liveSaved === 0 && after10b.liveRequests === 0,
  `${after10b.liveSaved} / ${after10b.liveRequests}`)

console.log('scenario 10c: cache-write tokens are billed')
handlers.clear()
const writeLlm = {
  stream() {
    return (async function* gen() {
      yield { type: 'text-delta', index: 0, text: 'Rewritten.' }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 50 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
const store10c = new SidecarStore()
const engine10c = new ReasoningDistillEngine({ ...ctx, llm: writeLlm } as never, cfg10 as never, store10c)
engine10c.start()
const s10c = new FakeSession('session-cachewrite')
sessions.set(s10c.id, s10c)
await fire('session/created', s10c)
s10c.append('user/message', { id: 'u10c', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq10c = s10c.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a10c', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
s10c.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s10c, s10c.eventAt(seq10c))
await fire('session/event', s10c, s10c.eventAt(s10c.log.length - 1))
await fire('agent/pre-step', { agent: { session: s10c } }, async () => undefined)
const run10c = (await store10c.load(s10c.id)).entries[0]!.distill
check('cache-write tokens are recorded', run10c.cacheWriteTokens === 50, String(run10c.cacheWriteTokens))
check('and billed at the miss price', Math.abs(run10c.cost - ((100 + 50) * 2 + 10 * 8) / 1_000_000) < 1e-12, String(run10c.cost))

console.log('scenario 10d: a stream that throws keeps its partial output')
handlers.clear()
const throwingLlm = {
  stream() {
    return (async function* gen() {
      yield { type: 'text-delta', index: 0, text: 'Forty characters of a rewrite that never finishes!!' }
      throw new Error('transport reset')
    })()
  },
}
const store10d = new SidecarStore()
const engine10d = new ReasoningDistillEngine({ ...ctx, llm: throwingLlm } as never, cfg10 as never, store10d)
engine10d.start()
const s10d = new FakeSession('session-throwing')
sessions.set(s10d.id, s10d)
await fire('session/created', s10d)
s10d.append('user/message', { id: 'u10d', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq10d = s10d.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a10d', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
s10d.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s10d, s10d.eventAt(seq10d))
await fire('session/event', s10d, s10d.eventAt(s10d.log.length - 1))
await fire('agent/pre-step', { agent: { session: s10d } }, async () => undefined)
const run10d = (await store10d.load(s10d.id)).entries[0]!.distill
check('partial output is counted, not zeroed', run10d.outputTokens > 0, String(run10d.outputTokens))
check('and the cost is marked as estimated', run10d.estimated === true)

console.log('scenario 10e: losing the audit session does not lose the compression')
handlers.clear()
const brokenCtx = { ...ctx, sessions: { ...ctx.sessions, create: () => { throw new Error('session store unavailable') } } }
const store10e = new SidecarStore()
const engine10e = new ReasoningDistillEngine(brokenCtx as never, cfg10 as never, store10e)
engine10e.start()
const s10e = new FakeSession('session-nosession')
sessions.set(s10e.id, s10e)
await fire('session/created', s10e)
s10e.append('user/message', { id: 'u10e', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq10e = s10e.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a10e', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
s10e.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s10e, s10e.eventAt(seq10e))
await fire('session/event', s10e, s10e.eventAt(s10e.log.length - 1))
await fire('agent/pre-step', { agent: { session: s10e } }, async () => undefined)
const entry10e = (await store10e.load(s10e.id)).entries[0]!
const derived10e = s10e.deriveMessages().find(message => (message as { id?: string }).id === 'a10e') as { content: Array<{ type: string; text?: string }> }
check('the rewrite still replaces the reasoning',
  derived10e.content.some(block => block.type === 'reasoning' && block.text === 'Distilled: ask for Paris weather and call the tool.'))
check('and the entry says its audit session is missing', entry10e.sessionMissing === true && entry10e.distill.sessionId === '')
check('it is not reported as failed', entry10e.failed !== true)

console.log('scenario 10f: an unreadable sidecar is never overwritten')
const store10f = new SidecarStore()
await store10f.update('session-integrity', record => { record.entries.push({ ...(record.entries[0] ?? {} as never) }) })
const integrityPath = sidecarPath('session-integrity')
const good = readFileSync(integrityPath, 'utf8')
writeFileSync(integrityPath, '{ this is not json')
store10f.forget('session-integrity')
let rejected = false
await store10f.update('session-integrity', record => { record.entries = [] }).catch(() => { rejected = true })
check('a corrupt sidecar makes the write fail instead of overwriting', rejected)
check('and the file on disk is left exactly as it was', readFileSync(integrityPath, 'utf8') === '{ this is not json')
writeFileSync(integrityPath, good)

console.log('scenario 11: unloading the plugin restores deriveMessages')
handlers.clear()
const store11 = new SidecarStore()
const engine11 = new ReasoningDistillEngine(ctx as never, cfg10 as never, store11)
engine11.start()
const s11 = new FakeSession('session-unload')
sessions.set(s11.id, s11)
await fire('session/created', s11)
s11.append('user/message', { id: 'u11', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq11 = s11.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a11', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
s11.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s11, s11.eventAt(seq11))
await fire('session/event', s11, s11.eventAt(s11.log.length - 1))
await fire('agent/pre-step', { agent: { session: s11 } }, async () => undefined)
const rewritten = (s11.deriveMessages().find(message => (message as { id?: string }).id === 'a11') as { content: Array<{ type: string; text?: string }> })
check('the loaded plugin rewrites derived history', rewritten.content.some(block => block.type === 'reasoning' && block.text !== fatReasoning))
const unload = effects.at(-1)?.() as (() => void) | undefined
unload?.()
const restored = (s11.deriveMessages().find(message => (message as { id?: string }).id === 'a11') as { content: Array<{ type: string; text?: string }> })
check('unloading restores the original reasoning', restored.content.some(block => block.type === 'reasoning' && block.text === fatReasoning))

console.log('scenario 12: colliding ids, replayed events, failed writes')
// Two ids that sanitize to the same stem must not share a sidecar.
const store12 = new SidecarStore()
await store12.update('team/a', record => { record.entries.push({ id: 'entry-A' } as never) })
await store12.update('team?a', record => { record.entries.push({ id: 'entry-B' } as never) })
const sharedA = await store12.load('team/a')
const sharedB = await store12.load('team?a')
check('sanitized ids get distinct files', sidecarPath('team/a') !== sidecarPath('team?a'))
check('and neither session sees the other\'s record',
  sharedA.entries.length === 1 && sharedB.entries.length === 1 && sharedA.entries[0]!.id === 'entry-A' && sharedB.entries[0]!.id === 'entry-B')

// Re-observing an already-counted response must not bill the saving twice.
const replayTarget = after.entries[0]!
const beforeReplay = replayTarget.liveRequests
await fire('session/event', main, main.eventAt(assistantSeq))
const afterReplay = (await store.load(main.id)).entries[0]!
check('a replayed response is not counted twice', afterReplay.liveRequests === beforeReplay, `${beforeReplay} -> ${afterReplay.liveRequests}`)

// A write that fails must not leave the cache ahead of the disk.
const rollbackHome = mkdtempSync(join(tmpdir(), 'rd-rollback-'))
const previousHome = process.env['DSH_HOME']
process.env['DSH_HOME'] = rollbackHome
const store12b = new SidecarStore()
await store12b.update('session-rollback', record => { record.entries.push({ id: 'durable' } as never) })
rmSync(join(rollbackHome, 'reasoning-distill'), { recursive: true, force: true })
writeFileSync(join(rollbackHome, 'reasoning-distill'), 'not a directory')
let writeFailed = false
await store12b.update('session-rollback', record => { record.entries.push({ id: 'ghost' } as never) }).catch(() => { writeFailed = true })
const cached12b = store12b.peek('session-rollback')
check('a failed write is rolled back in memory',
  writeFailed && cached12b !== undefined && cached12b.entries.length === 1 && cached12b.entries[0]!.id === 'durable')
if (previousHome === undefined) delete process.env['DSH_HOME']
else process.env['DSH_HOME'] = previousHome

console.log('scenario 13: a disposed compression session is forgotten')
handlers.clear()
const store13 = new SidecarStore()
const engine13 = new ReasoningDistillEngine(ctx as never, cfg10 as never, store13)
engine13.start()
const s13 = new FakeSession('session-owner')
sessions.set(s13.id, s13)
await fire('session/created', s13)
s13.append('user/message', { id: 'u13', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq13 = s13.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a13', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
s13.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s13, s13.eventAt(seq13))
await fire('session/event', s13, s13.eventAt(s13.log.length - 1))
await fire('agent/pre-step', { agent: { session: s13 } }, async () => undefined)
const opened13 = (await store13.load(s13.id)).entries[0]!.distill.sessionId
check('the compression opened a session', opened13 !== '')

// The host disposes it, then an unrelated user session reuses that exact id.
await fire('session/disposed', created.find(session => session.id === opened13) ?? new FakeSession(opened13))
const reuse = new FakeSession(opened13)
sessions.set(reuse.id, reuse)
await fire('session/created', reuse)
reuse.append('user/message', { id: 'u13b', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq13b = reuse.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a13b', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
reuse.append('step/end', { turn: 1, step: 1 })
await fire('session/event', reuse, reuse.eventAt(seq13b))
await fire('session/event', reuse, reuse.eventAt(reuse.log.length - 1))
await fire('agent/pre-step', { agent: { session: reuse } }, async () => undefined)
check('a session reusing that id is observed again',
  (await store13.load(reuse.id)).entries.length === 1, String((await store13.load(reuse.id)).entries.length))

console.log('scenario 14: an interior surface replacement keeps the rewrite in place')
handlers.clear()
const store14 = new SidecarStore()
const engine14 = new ReasoningDistillEngine(ctx as never, cfg10 as never, store14)
engine14.start()
const s14 = new FakeSession('session-shift')
sessions.set(s14.id, s14)
await fire('session/created', s14)
s14.append('user/message', { id: 'u14', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
// An interior node that currently derives to no message at all. It is appended
// without firing, so nothing stages against it.
const interiorSeq = s14.append('assistant/message', { turn: 0, step: 0, message: null, stream: [] }).seq
const targetSeq14 = s14.append('assistant/message', {
  turn: 1, step: 1,
  message: {
    id: 'a14', role: 'assistant',
    content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'target' }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  stream: [],
}).seq
s14.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s14, s14.eventAt(targetSeq14))
await fire('session/event', s14, s14.eventAt(s14.log.length - 1))
await fire('agent/pre-step', { agent: { session: s14 } }, async () => undefined)
check('the target was compressed', (await store14.load(s14.id)).entries.length === 1)
// Derive once BEFORE the replacement, which is what makes any position cache
// stale: without this the test cannot reach the defect it exists for.
const first14 = s14.deriveMessages() as Array<{ id?: string }>
check('the first derivation already substitutes', first14.some(message => message.id === 'a14'))

// One-for-one interior replacement: same node count, same tail, no event fired —
// exactly what a length+tail cache key cannot see.
const interior = s14.log[interiorSeq]!
;(interior.data as { message: unknown }).message = {
  id: 'interior-message', role: 'assistant',
  content: [{ type: 'reasoning', text: 'INTERIOR ORIGINAL' }, { type: 'text', text: 'interior' }],
  source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
}
const derived14 = s14.deriveMessages() as Array<{ id?: string; content: Array<{ type: string; text?: string }> }>
const target14 = derived14.find(message => message.id === 'a14')!
const interior14 = derived14.find(message => message.id === 'interior-message')!
check('the rewrite still lands on the compressed message',
  target14.content.some(block => block.type === 'reasoning' && block.text !== fatReasoning))
check('and never drifts onto the replaced interior message',
  interior14.content.some(block => block.type === 'reasoning' && block.text === 'INTERIOR ORIGINAL'))

console.log('scenario 15: the audit session claims its writer before any append')
handlers.clear()
const order: string[] = []
const store15 = new SidecarStore()
const engine15 = new ReasoningDistillEngine(ctx as never, cfg10 as never, store15)
// The fake store records the append order; the hook records when it is claimed.
const typedCtx = ctx as unknown as { sessions: { create: (...args: unknown[]) => { id: string; append: (type: string) => void } } }
const originalCreate = typedCtx.sessions.create
typedCtx.sessions.create = (...args: unknown[]) => {
  const session = originalCreate(...args)
  order.push('create')
  const append = session.append.bind(session)
  session.append = (type: string) => { if (order.length < 6) order.push(`append:${type}`); append(type) }
  return session
}
engine15.usePersistence(async () => { order.push('claim-writer') })
engine15.start()
const s15 = new FakeSession('session-durable')
sessions.set(s15.id, s15)
await fire('session/created', s15)
s15.append('user/message', { id: 'u15', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq15 = s15.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a15', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
s15.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s15, s15.eventAt(seq15))
await fire('session/event', s15, s15.eventAt(s15.log.length - 1))
await fire('agent/pre-step', { agent: { session: s15 } }, async () => undefined)
typedCtx.sessions.create = originalCreate
check('the writer is claimed between create and the first append',
  order[0] === 'create' && order[1] === 'claim-writer', order.slice(0, 4).join(' -> '))
check('and the audit session still gets its seed events',
  order.some(entry => entry === 'append:turn/start'))
check('the compression still landed', (await store15.load(s15.id)).entries.length === 1)

// A failing writer hook must not lose the compression.
handlers.clear()
const store15b = new SidecarStore()
const engine15b = new ReasoningDistillEngine(ctx as never, cfg10 as never, store15b)
engine15b.usePersistence(async () => { throw new Error('no persistence backend') })
engine15b.start()
const s15b = new FakeSession('session-nowriter')
sessions.set(s15b.id, s15b)
await fire('session/created', s15b)
s15b.append('user/message', { id: 'u15b', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq15b = s15b.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a15b', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
s15b.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s15b, s15b.eventAt(seq15b))
await fire('session/event', s15b, s15b.eventAt(s15b.log.length - 1))
await fire('agent/pre-step', { agent: { session: s15b } }, async () => undefined)
const entry15b = (await store15b.load(s15b.id)).entries[0]!
check('a writer that cannot be claimed leaves the audit session in memory only',
  entry15b !== undefined && entry15b.sessionMissing !== true && entry15b.distill.sessionId !== '')
check('and the rewrite still ships',
  s15b.deriveMessages().some(message => JSON.stringify((message as { content?: unknown }).content ?? '').includes('Distilled: ask for Paris weather')))

console.log('scenario 16: three per-model, per-kind switches')
handlers.clear()

/** Rule overrides for one model, with the shipped defaults as the base. */
function kindRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true, continuableSubagents: true, oneShotSubagents: false,
    thresholdTokens: 200, minSavedTokens: 5,
    includeToolResults: true, includeFinalTurns: true, timeoutMs: 5000,
    distiller: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' },
    ...overrides,
  }
}

/** Run one single-shot step through a fresh engine and report what landed. */
async function runKind(
  id: string,
  header: { cwd?: string; origin?: 'subagent'; delegationDepth?: number },
  ruleOverrides: Record<string, unknown>,
  descriptor?: 'one-shot' | 'continuable',
): Promise<number> {
  // One engine per case, observing alone: production has a single plugin
  // instance, and two stores writing one sidecar would race on the rename.
  handlers.clear()
  const store = new SidecarStore()
  const engine = new ReasoningDistillEngine(
    ctx as never,
    makeConfig({ defaultRule: { get: () => kindRule(ruleOverrides) } }) as never,
    store,
  )
  engine.start()
  const session = new FakeSession(id, header)
  sessions.set(session.id, session)
  await fire('session/created', session)
  if (descriptor !== undefined) {
    session.append('subagent/descriptor', { version: 3, mode: descriptor, provider: 'in-process' })
  }
  session.append('user/message', { id: `u-${id}`, role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
  const seq = session.append('assistant/message', {
    turn: 1, step: 1,
    message: {
      id: `a-${id}`, role: 'assistant',
      content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'done' }],
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
    },
    stream: [],
  }).seq
  session.append('step/end', { turn: 1, step: 1 })
  await fire('session/event', session, session.eventAt(seq))
  await fire('session/event', session, session.eventAt(session.log.length - 1))
  await fire('agent/pre-step', { agent: { session } }, async () => undefined)
  return (await store.load(session.id)).entries.length
}

const plain = { cwd: '/tmp' }
const child = { cwd: '/tmp', origin: 'subagent' as const, delegationDepth: 1 }
// Shipped defaults: main on, continuable on, one-shot off.
check('a main conversation is distilled by default', (await runKind('k-main', plain, {})) === 1)
check('a continuable child is distilled by default (a teammate keeps replaying)', (await runKind('k-cont', child, {}, 'continuable')) === 1)
check('a one-shot child is left alone by default', (await runKind('k-oneshot', child, {}, 'one-shot')) === 0)
// Each switch acts alone.
check('the one-shot switch turns only one-shot children on',
  (await runKind('k-oneshot-on', child, { oneShotSubagents: true }, 'one-shot')) === 1)
check('it does not affect main conversations',
  (await runKind('k-oneshot-on-main', plain, { oneShotSubagents: true, enabled: false })) === 0)
check('turning main off leaves continuable children alone',
  (await runKind('k-main-off-cont', child, { enabled: false }, 'continuable')) === 1)
check('turning main off silences main conversations',
  (await runKind('k-main-off', plain, { enabled: false })) === 0)
check('turning the continuable switch off silences only those',
  (await runKind('k-cont-off', child, { continuableSubagents: false }, 'continuable')) === 0)
check('while main conversations still run',
  (await runKind('k-cont-off-main', plain, { continuableSubagents: false })) === 1)
check('all three off silences everything',
  (await runKind('k-none-main', plain, { enabled: false, continuableSubagents: false, oneShotSubagents: false })) === 0
  && (await runKind('k-none-cont', child, { enabled: false, continuableSubagents: false, oneShotSubagents: false }, 'continuable')) === 0
  && (await runKind('k-none-shot', child, { enabled: false, continuableSubagents: false, oneShotSubagents: true }, 'one-shot')) === 1)
// Depth 0 is top level, so it follows the main switch.
check('a top-level session carrying an explicit depth 0 is still a conversation',
  (await runKind('k-depth0', { cwd: '/tmp', delegationDepth: 0 }, {})) === 1)
check('a child without a readable descriptor is treated as one-shot',
  (await runKind('k-nodesc', child, {})) === 0)
check('and the one-shot switch covers it',
  (await runKind('k-nodesc-on', child, { oneShotSubagents: true })) === 1)

// Depth caps: each subagent kind carries its own maximum effective depth.
const depth = (value: number) => ({ cwd: '/tmp', origin: 'subagent' as const, delegationDepth: value })
check('a direct continuable child is inside a cap of 1',
  (await runKind('kd-cont1', depth(1), { continuableMaxDepth: 1 }, 'continuable')) === 1)
check('a grandchild continuable child is beyond a cap of 1',
  (await runKind('kd-cont2', depth(2), { continuableMaxDepth: 1 }, 'continuable')) === 0)
check('and inside a cap of 2',
  (await runKind('kd-cont2b', depth(2), { continuableMaxDepth: 2 }, 'continuable')) === 1)
check('a cap of 0 means no limit',
  (await runKind('kd-cont5', depth(5), { continuableMaxDepth: 0 }, 'continuable')) === 1)
check('the one-shot kind has its own cap',
  (await runKind('kd-shot1', depth(1), { oneShotSubagents: true, oneShotMaxDepth: 1 }, 'one-shot')) === 1)
check('which stops deeper delegations',
  (await runKind('kd-shot3', depth(3), { oneShotSubagents: true, oneShotMaxDepth: 1 }, 'one-shot')) === 0)
check('the two caps do not interfere',
  (await runKind('kd-mixed', depth(3), { continuableSubagents: false, oneShotSubagents: true, continuableMaxDepth: 9, oneShotMaxDepth: 1 }, 'one-shot')) === 0)
check('depth caps never touch main conversations',
  (await runKind('kd-main', plain, { continuableMaxDepth: 1, oneShotMaxDepth: 1 })) === 1)
// A child the host marked as one but never gave a depth counts as a direct one.
check('a deeper-cap does not silently disable an unlabelled child',
  (await runKind('kd-nodepth', { cwd: '/tmp', origin: 'subagent' }, { oneShotSubagents: true, oneShotMaxDepth: 1 }, 'one-shot')) === 1)

console.log('scenario 17: a legacy sidecar is adopted only by its own session')
const store17 = new SidecarStore()
mkdirSync(join(dshHome(), 'reasoning-distill'), { recursive: true })
// Fresh ids: scenario 12 already owns digest-path files for `team/a`/`team?a`,
// and this scenario must reach the legacy fallback.
const legacyPath = legacySidecarPath('coll/a')
check('the two ids really do share the legacy name', legacyPath === legacySidecarPath('coll?a'), legacyPath)
writeFileSync(legacyPath, JSON.stringify({
  version: 1, sessionId: 'coll/a', epoch: 0, countedThroughSeq: -1,
  entries: [{ id: 'foreign-entry' }],
}))
// 'team?a' collides on the legacy name but must never read that record.
const collided = await store17.load('coll?a')
check('a colliding legacy record is not adopted', collided.sessionId === 'coll?a' && collided.entries.length === 0,
  `${collided.sessionId} / ${collided.entries.length}`)
// Its own write must not migrate or overwrite the foreign file.
await store17.update('coll?a', record => { record.entries.push({ id: 'mine' } as never) })
check('the foreign legacy file is left untouched',
  JSON.parse(readFileSync(legacyPath, 'utf8')).entries[0].id === 'foreign-entry')
check('and the writer stored its own record elsewhere',
  (await store17.load('coll?a')).entries[0]!.id === 'mine' && sidecarPath('coll?a') !== legacyPath)
// The real owner still migrates its own legacy record.
const owner = await store17.load('coll/a')
check('the owner adopts it and the next write migrates it',
  owner.entries.length === 1 && owner.entries[0]!.id === 'foreign-entry')
// A legacy file that is temporarily unreadable must fail the read, not be
// cached as empty — otherwise the next write shadows it with a blank sidecar.
const legacyBlocked = 'coll/blocked'
const blockedPath = legacySidecarPath(legacyBlocked)
mkdirSync(blockedPath, { recursive: true })
let blockedThrew = false
await store17.load(legacyBlocked).catch(() => { blockedThrew = true })
check('an unreadable legacy sidecar is not mistaken for an absent one', blockedThrew)
check('and nothing was cached for it', store17.peek(legacyBlocked) === undefined)
rmSync(blockedPath, { recursive: true, force: true })
writeFileSync(blockedPath, JSON.stringify({
  version: 1, sessionId: legacyBlocked, epoch: 0, countedThroughSeq: -1, entries: [{ id: 'recovered' }],
}))
const recovered = await store17.load(legacyBlocked)
check('once readable again the legacy record is migrated normally',
  recovered.entries.length === 1 && recovered.entries[0]!.id === 'recovered')

// A digest-path file naming another session is refused rather than overwritten.
const store17b = new SidecarStore()
await store17b.update('session-other', record => { record.entries.push({ id: 'other' } as never) })
writeFileSync(sidecarPath('session-victim'), JSON.stringify({
  version: 1, sessionId: 'session-other', epoch: 0, countedThroughSeq: -1, entries: [{ id: 'other' }],
}))
let refused = false
await store17b.update('session-victim', record => { record.entries.push({ id: 'wrong' } as never) }).catch(() => { refused = true })
check('a sidecar naming another session is refused',
  refused && JSON.parse(readFileSync(sidecarPath('session-victim'), 'utf8')).sessionId === 'session-other')

console.log('scenario 18: a failed write leaves no unpersisted savings behind')
handlers.clear()
const acctHome = mkdtempSync(join(tmpdir(), 'rd-acct-'))
const acctPrior = process.env['DSH_HOME']
process.env['DSH_HOME'] = acctHome
const store18 = new SidecarStore()
const engine18 = new ReasoningDistillEngine(ctx as never, cfg10 as never, store18)
engine18.start()
const s18 = new FakeSession('session-acct')
sessions.set(s18.id, s18)
await fire('session/created', s18)
s18.append('user/message', { id: 'u18', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const a18 = s18.append('assistant/message', {
  turn: 1, step: 1,
  message: {
    id: 'a18', role: 'assistant',
    content: [{ type: 'reasoning', text: fatReasoning }, { type: 'tool-call', id: 'c18', name: 'read', arguments: '{"path":"/tmp/z"}' }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  stream: [],
}).seq
s18.append('tool/result', {
  turn: 1, step: 1,
  message: { id: 't18', role: 'tool', toolCallId: 'c18', content: [{ type: 'text', text: 'OUT' }], source: { kind: 'tool' } },
}, { surfaceOp: 'append' })
s18.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s18, s18.eventAt(a18))
await fire('session/event', s18, s18.eventAt(s18.log.length - 1))
await fire('agent/pre-step', { agent: { session: s18 } }, async () => undefined)
check('the substitution is recorded', (await store18.load(s18.id)).entries.length === 1)

// Break the storage so the next accounting write fails.
rmSync(join(acctHome, 'reasoning-distill'), { recursive: true, force: true })
writeFileSync(join(acctHome, 'reasoning-distill'), 'not a directory')
const next18 = s18.append('assistant/message', {
  turn: 2, step: 1,
  message: {
    id: 'a18b', role: 'assistant',
    content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'ok' }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  stream: [],
}).seq
await fire('session/event', s18, s18.eventAt(next18))
// The rejected write is only observable once the queue has run and rolled back.
for (let attempt = 0; attempt < 200; attempt++) {
  const probe = store18.peek(s18.id)
  if (probe === undefined || probe.entries[0]!.liveRequests > 0) break
  await new Promise(resolve => setTimeout(resolve, 5))
}
const ghost = store18.peek(s18.id)!
check('a saving that could not be persisted is not kept in memory',
  ghost.entries[0]!.liveSaved === 0 && ghost.entries[0]!.liveRequests === 0,
  `${ghost.entries[0]!.liveSaved} / ${ghost.entries[0]!.liveRequests}`)
if (acctPrior === undefined) delete process.env['DSH_HOME']
else process.env['DSH_HOME'] = acctPrior

console.log('scenario 19: a resumed session is never served raw reasoning')
handlers.clear()
const slowHome = mkdtempSync(join(tmpdir(), 'rd-slow-'))
const slowPrior = process.env['DSH_HOME']
process.env['DSH_HOME'] = slowHome
const store19 = new SidecarStore()
await store19.update('session-slow', record => {
  record.entries.push({
    id: 'entry-19', targetSeq: 1, targetMessageId: 'a19', turn: 1, step: 1,
    provider: 'deepseek-official', model: 'deepseek-flash',
    originalChars: 8, originalTokens: 2, distilledText: 'SHORT', distilledChars: 5, distilledTokens: 2,
    savedTokensPerRequest: 400, distill: { sessionId: '', provider: 'p', model: 'm', effort: 'off', requestText: '', responseText: '', inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, cost: 0, period: 'peak', durationMs: 1 },
    cacheBreakTokens: 0, cacheBreakCost: 0, epoch: 0, appliedAt: 0, liveSaved: 0, liveRequests: 0, frozenSaved: 0,
  } as never)
})
store19.forget('session-slow')
const realLoad19 = store19.load.bind(store19)
store19.load = async (sessionId: string) => {
  // A slow disk: the preload cannot finish before the first pre-step.
  await new Promise(resolve => setTimeout(resolve, 40))
  return realLoad19(sessionId)
}
const engine19 = new ReasoningDistillEngine(ctx as never, cfg10 as never, store19)
engine19.start()
const s19 = new FakeSession('session-slow')
sessions.set(s19.id, s19)
s19.append('user/message', { id: 'u19', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
s19.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a19', role: 'assistant', content: [{ type: 'reasoning', text: 'ORIGINAL' }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
})
await fire('session/created', s19)
await fire('agent/pre-step', { agent: { session: s19 } }, async () => undefined)
const resumed19 = s19.deriveMessages().find(message => (message as { id?: string }).id === 'a19') as { content: Array<{ type: string; text?: string }> }
check('the first request after a resume already carries the rewrite',
  resumed19.content.some(block => block.type === 'reasoning' && block.text === 'SHORT'),
  JSON.stringify(resumed19.content[0]))
if (slowPrior === undefined) delete process.env['DSH_HOME']
else process.env['DSH_HOME'] = slowPrior

console.log('scenario 20: the first replay is priced at the miss rate, later ones at hit')
handlers.clear()
const store20 = new SidecarStore()
const engine20 = new ReasoningDistillEngine(ctx as never, cfg10 as never, store20)
engine20.start()
const s20 = new FakeSession('session-suffix')
sessions.set(s20.id, s20)
await fire('session/created', s20)
s20.append('user/message', { id: 'u20', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq20 = s20.append('assistant/message', {
  turn: 1, step: 1,
  message: {
    id: 'a20', role: 'assistant',
    content: [{ type: 'reasoning', text: fatReasoning }, { type: 'tool-call', id: 'c20', name: 'read', arguments: '{"path":"/tmp/big"}' }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  stream: [],
}).seq
const huge = 'x'.repeat(40_000)
s20.append('tool/result', {
  turn: 1, step: 1,
  message: { id: 't20', role: 'tool', toolCallId: 'c20', content: [{ type: 'text', text: huge }], source: { kind: 'tool' } },
}, { surfaceOp: 'append' })
s20.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s20, s20.eventAt(seq20))
await fire('session/event', s20, s20.eventAt(s20.log.length - 1))
await fire('agent/pre-step', { agent: { session: s20 } }, async () => undefined)
const entry20 = (await store20.load(s20.id)).entries[0]!
// The rewrite lands before the message is ever replayed, so nothing warm is
// invalidated and no cache-break penalty is real.
check('no fictitious cache break is charged', entry20.cacheBreakTokens === 0 && entry20.cacheBreakCost === 0)
check('and the suffix never entered the break', entry20.cacheBreakTokens < 1000, String(entry20.cacheBreakTokens))

// First counted request: the rewrite is brand-new input, priced at miss.
const saving20 = entry20.savedTokensPerRequest
const firstReplay = s20.append('assistant/message', {
  turn: 2, step: 1,
  message: {
    id: 'a20b', role: 'assistant',
    content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'ok' }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  stream: [],
}).seq
await fire('session/event', s20, s20.eventAt(firstReplay))
await settleFor(async () => (await store20.load(s20.id)).entries[0]!.liveRequests === 1)
const afterFirst = (await store20.load(s20.id)).entries[0]!
check('the first replay credits the saving at the miss rate',
  Math.abs(afterFirst.liveSaved - (saving20 * 2) / 1_000_000) < 1e-12,
  `${afterFirst.liveSaved} vs ${(saving20 * 2) / 1_000_000}`)
// Second counted request: that tail is cached by now, so hit pricing applies.
const secondReplay = s20.append('assistant/message', {
  turn: 2, step: 2,
  message: {
    id: 'a20c', role: 'assistant',
    content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'ok' }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  stream: [],
}).seq
await fire('session/event', s20, s20.eventAt(secondReplay))
await settleFor(async () => (await store20.load(s20.id)).entries[0]!.liveRequests === 2)
const afterSecond = (await store20.load(s20.id)).entries[0]!
check('the second replay credits the saving at the hit rate',
  Math.abs(afterSecond.liveSaved - ((saving20 * 2) + (saving20 * 0.04)) / 1_000_000) < 1e-12,
  `${afterSecond.liveSaved}`)

const createdBefore21 = created.length
console.log('scenario 21: a canceled step is not distilled')
handlers.clear()
const store21 = new SidecarStore()
const engine21 = new ReasoningDistillEngine(ctx as never, cfg10 as never, store21)
engine21.start()
const s21 = new FakeSession('session-interrupted')
sessions.set(s21.id, s21)
await fire('session/created', s21)
s21.append('user/message', { id: 'u21', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const canceledSeq = s21.append('assistant/message', {
  turn: 1, step: 1,
  message: {
    id: 'a21', role: 'assistant',
    content: [{ type: 'reasoning', text: fatReasoning }, { type: 'tool-call', id: 'c21', name: 'read', arguments: '{"path":"/tmp/q"}' }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  interrupted: true,
  stream: [],
}).seq
s21.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s21, s21.eventAt(canceledSeq))
await fire('session/event', s21, s21.eventAt(s21.log.length - 1))
await fire('agent/pre-step', { agent: { session: s21 } }, async () => undefined)
check('a canceled step buys no distillation',
  (await store21.load(s21.id)).entries.length === 0)
check('and no audit session was opened for it', created.length === createdBefore21, String(created.length - createdBefore21))

// The very next, completed step must still be distilled.
const doneSeq = s21.append('assistant/message', {
  turn: 2, step: 1,
  message: {
    id: 'a21b', role: 'assistant',
    content: [{ type: 'reasoning', text: fatReasoning }, { type: 'tool-call', id: 'c21b', name: 'read', arguments: '{"path":"/tmp/q2"}' }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  stream: [],
}).seq
s21.append('step/end', { turn: 2, step: 1 })
await fire('session/event', s21, s21.eventAt(doneSeq))
await fire('session/event', s21, s21.eventAt(s21.log.length - 1))
await fire('agent/pre-step', { agent: { session: s21 } }, async () => undefined)
check('the next completed step is distilled as usual',
  (await store21.load(s21.id)).entries.length === 1)

console.log('scenario 22: a rewrite that was not worth adopting is still accounted')
handlers.clear()
const store22 = new SidecarStore()
// A distiller that returns a summary just short of the savings threshold.
const nearLlm = {
  stream() {
    return (async function* gen() {
      yield { type: 'text-delta', index: 0, text: 'y'.repeat(1880) }
      yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
const cfg22 = makeConfig({ defaultRule: { get: () => ({
  enabled: true, thresholdTokens: 200, minSavedTokens: 600,
  includeToolResults: true, includeFinalTurns: true, timeoutMs: 5000,
  distiller: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' },
}) } })
const engine22 = new ReasoningDistillEngine({ ...ctx, llm: nearLlm } as never, cfg22 as never, store22)
engine22.start()
const s22 = new FakeSession('session-skipped')
sessions.set(s22.id, s22)
await fire('session/created', s22)
s22.append('user/message', { id: 'u22', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq22 = s22.append('assistant/message', {
  turn: 1, step: 1,
  message: {
    id: 'a22', role: 'assistant',
    content: [{ type: 'reasoning', text: fatReasoning }, { type: 'tool-call', id: 'c22', name: 'read', arguments: '{"path":"/tmp/s"}' }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  stream: [],
}).seq
s22.append('tool/result', {
  turn: 1, step: 1,
  message: { id: 't22', role: 'tool', toolCallId: 'c22', content: [{ type: 'text', text: 'OUT' }], source: { kind: 'tool' } },
}, { surfaceOp: 'append' })
s22.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s22, s22.eventAt(seq22))
await fire('session/event', s22, s22.eventAt(s22.log.length - 1))
await fire('agent/pre-step', { agent: { session: s22 } }, async () => undefined)
const rec22 = await store22.load(s22.id)
const skipped22 = rec22.entries[0]!
check('the paid attempt is recorded even though it was not adopted',
  rec22.entries.length === 1 && skipped22.skipped === true, String(rec22.entries.length))
check('it substitutes nothing', skipped22.distilledText === '' && skipped22.savedTokensPerRequest === 0)
check('but its spending is visible', skipped22.distill.cost > 0)
const report22 = buildReport(s22.id, rec22, cfg22 as never)
check('so the report neither hides the trigger nor the cost',
  report22.triggers === 1 && report22.distillCost > 0, `${report22.triggers} / ${report22.distillCost}`)
const derived22 = s22.deriveMessages().find(message => (message as { id?: string }).id === 'a22') as { content: Array<{ type: string; text?: string }> }
check('and the original reasoning is untouched',
  derived22.content.some(block => block.type === 'reasoning' && block.text === fatReasoning))
check('the audit session is still linked', skipped22.distill.sessionId !== '')

console.log('scenario 23: shipped rule defaults')
const { DEFAULT_RULE } = await import('../src/config.ts')
check('main conversations are on by default', DEFAULT_RULE.enabled === true)
check('continuable subagents are on by default', DEFAULT_RULE.continuableSubagents === true)
check('one-shot subagents are off by default', DEFAULT_RULE.oneShotSubagents === false)

console.log('scenario 24: one merge, shared by the engine and the settings panel')
const { mergeRule, sparseOverride } = await import('../src/rule.ts')
const { DEFAULT_RULE: BASE } = await import('../src/config.ts')
const { resolveRule } = await import('../src/config.ts')
const merged = mergeRule(BASE, { thresholdTokens: 111 }, { oneShotMaxDepth: 3 })
check('the fallback fills what no layer sets', merged.minSavedTokens === BASE.minSavedTokens && merged.enabled === BASE.enabled)
check('the base layer applies', merged.thresholdTokens === 111)
check('the model layer wins', merged.oneShotMaxDepth === 3)
check('nested distiller fields merge independently',
  mergeRule(BASE, { distiller: { model: 'a' } }, { distiller: { effort: 'high' } }).distiller.model === 'a'
  && mergeRule(BASE, { distiller: { model: 'a' } }, { distiller: { effort: 'high' } }).distiller.effort === 'high')
const { withKindDefaults } = await import('../src/config.ts')
check('the engine resolver is this merge over the migrated layers',
  JSON.stringify(resolveRule('m', { defaultRule: { get: () => ({ thresholdTokens: 7 }) }, models: { get: () => ({ m: { enabled: false } }) } } as never))
  === JSON.stringify(mergeRule(BASE, withKindDefaults({ thresholdTokens: 7 }, undefined), withKindDefaults({ enabled: false }, undefined))))
// Sparse writes: only what the user changed is stored.
const inherited = mergeRule(BASE, { thresholdTokens: 222 }, undefined)
const touched = sparseOverride(inherited, { ...inherited, oneShotSubagents: true })
check('an edit stores only the edited field', JSON.stringify(touched) === JSON.stringify({ oneShotSubagents: true }), JSON.stringify(touched))
check('an unchanged rule stores nothing', JSON.stringify(sparseOverride(inherited, inherited)) === '{}')
const nested = sparseOverride(inherited, { ...inherited, distiller: { ...inherited.distiller, effort: 'high' } })
check('a nested edit stores only the nested field', JSON.stringify(nested) === JSON.stringify({ distiller: { effort: 'high' } }), JSON.stringify(nested))
check('and reverting a field drops it again',
  JSON.stringify(sparseOverride(inherited, { ...inherited, thresholdTokens: 999, enabled: inherited.enabled })) === JSON.stringify({ thresholdTokens: 999 }))

console.log('scenario 25: a config saved before the kind switches keeps its behaviour')
const { resolveRule: resolve25 } = await import('../src/config.ts')
/** A Volatile-shaped config shim for the resolver. */
const shim25 = (defaultRule: unknown, models: Record<string, unknown>, legacy?: boolean): never => ({
  defaultRule: { get: () => defaultRule },
  models: { get: () => models },
  ...(legacy === undefined ? {} : { compressSubagents: { get: () => legacy } }),
}) as never
// Old semantics: the rule's `enabled` was the master switch for main conversations
// AND resumable children; a global flag covered one-shot children.
const oldOff = resolve25('m', shim25({ enabled: false }, {}))
check('a rule saved as off keeps every kind off',
  oldOff.enabled === false && oldOff.continuableSubagents === false && oldOff.oneShotSubagents === false,
  JSON.stringify({ e: oldOff.enabled, c: oldOff.continuableSubagents, o: oldOff.oneShotSubagents }))
const oldOn = resolve25('deepseek-flash', shim25({ enabled: false }, { 'deepseek-flash': { enabled: true, timeoutMs: 0 } }))
check('a model saved as on keeps main and continuable on, one-shot off',
  oldOn.enabled === true && oldOn.continuableSubagents === true && oldOn.oneShotSubagents === false)
check('the retired global one-shot switch is still honoured',
  resolve25('m', shim25({ enabled: true }, {}, true)).oneShotSubagents === true)
// Once the panel has saved the fields they are used verbatim.
const saved25 = resolve25('m', shim25({ enabled: false, continuableSubagents: true, oneShotSubagents: true }, {}))
check('a saved rule is never re-derived',
  saved25.enabled === false && saved25.continuableSubagents === true && saved25.oneShotSubagents === true)
check('an explicit off in a new document stays off',
  resolve25('m', shim25({ enabled: true, continuableSubagents: false }, {})).continuableSubagents === false)

console.log('scenario 26: the panel shows exactly what the engine resolves')
const { normalizeSettings, planSave: plan26 } = await import('../src/client/ops.ts')
const { resolveRule: resolve26 } = await import('../src/config.ts')
/** A stored document that predates the three kind switches. */
const legacyDoc = {
  enabled: true,
  defaultRule: { enabled: false, thresholdTokens: 4000, minSavedTokens: 600, includeToolResults: true, includeFinalTurns: true, timeoutMs: 60000, distiller: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' } },
  models: { 'deepseek-flash': { enabled: true, thresholdTokens: 4000, minSavedTokens: 600, includeToolResults: true, includeFinalTurns: true, timeoutMs: 0, distiller: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' } } },
  peakSource: 'builtin', holidays: [], prices: {}, prompt: '', maxInputChars: 120000, maxOutputChars: 0,
} as never
const normalized26 = normalizeSettings(legacyDoc as never) as never as { defaultRule: Record<string, unknown>, models: Record<string, Record<string, unknown>> }
const engineDefault = resolve26('', shim25(legacyDoc['defaultRule'], legacyDoc['models']))
const engineModel = resolve26('deepseek-flash', shim25(legacyDoc['defaultRule'], legacyDoc['models']))
check('the panel derives the same main kind as the engine', normalized26.defaultRule['enabled'] === engineDefault.enabled)
check('the panel derives the same resumable kind as the engine',
  normalized26.defaultRule['continuableSubagents'] === engineDefault.continuableSubagents
  && normalized26.defaultRule['continuableSubagents'] === false,
  String(normalized26.defaultRule['continuableSubagents']))
check('and for a model override',
  normalized26.models['deepseek-flash']!['continuableSubagents'] === engineModel.continuableSubagents
  && normalized26.models['deepseek-flash']!['oneShotSubagents'] === engineModel.oneShotSubagents)
// The regression: saving an unrelated field must not write derived values back.
const before26 = normalizeSettings(legacyDoc as never) as never as Parameters<typeof plan26>[0]
const after26 = { ...before26, prompt: 'edited' } as never as Parameters<typeof plan26>[1]
const ops26 = plan26(before26, before26, after26)
check('an unrelated edit writes only that field',
  ops26.length === 1 && ops26[0]!.path.join('.') === 'prompt', JSON.stringify(ops26))
check('and it never writes the derived kind switches',
  !ops26.some(op => op.path.join('.').includes('continuableSubagents') || op.path.join('.').includes('oneShotSubagents')))
const flipped = { ...before26, defaultRule: { ...before26.defaultRule, continuableSubagents: true } } as never as Parameters<typeof plan26>[1]
const flipOps = plan26(before26, before26, flipped)
check('flipping the switch explicitly does write it',
  flipOps.length === 1 && flipOps[0]!.path.join('.') === 'defaultRule.continuableSubagents', JSON.stringify(flipOps))

console.log('scenario 27: an unreadable record never buys a distillation')
handlers.clear()
const store27 = new SidecarStore()
/** Its own stub: a shared counter would see other scenarios' in-flight calls. */
const llm27 = { calls: 0, stream(options: { messages: unknown[] }): AsyncIterable<unknown> {
  this.calls += 1
  void options
  const chunks = [
    { type: 'text-delta', index: 0, text: 'Distilled: ask for Paris weather and call the tool.' },
    { type: 'usage', usage: { inputTokens: 900, outputTokens: 20, cacheReadTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return (async function* gen() { for (const chunk of chunks) yield chunk })()
} }
const engine27 = new ReasoningDistillEngine({ ...ctx, llm: llm27 } as never, cfg10 as never, store27)
engine27.start()
const s27 = new FakeSession('session-unreadable')
sessions.set(s27.id, s27)
// The record is already corrupt when the session appears: a read failure that is
// not the ENOENT meaning "no record yet", so no result could be stored for it.
// (Written before the preload, which caches whatever the first read finds.)
const path27 = sidecarPath(s27.id)
mkdirSync(dirname(path27), { recursive: true })
writeFileSync(path27, '{ this is not json')
await fire('session/created', s27)
const calls27 = llm27.calls
s27.append('user/message', { id: 'u27', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq27 = s27.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a27', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
s27.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s27, s27.eventAt(seq27))
await fire('session/event', s27, s27.eventAt(s27.log.length - 1))
await settleFor(async () => info.some(line => line.includes('leaving %s undistilled')))
check('no paid distillation is bought while the record is unreadable', llm27.calls === calls27, `${llm27.calls} vs ${calls27}`)
check('and nothing is left running for it', engine27.snapshot(s27.id).active.length === 0)
// Heal the record; the next eligible step distills again.
rmSync(path27, { force: true })
s27.append('assistant/message', {
  turn: 2, step: 1,
  message: { id: 'a27b', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
})
s27.append('step/end', { turn: 2, step: 1 })
await fire('session/event', s27, s27.eventAt(s27.log.length - 2))
await fire('session/event', s27, s27.eventAt(s27.log.length - 1))
await settleFor(async () => llm27.calls > calls27)
check('recovery works once the record is readable again', llm27.calls > calls27, `${llm27.calls} vs ${calls27}`)
check('and the recovered compression is persisted', (await store27.load(s27.id)).entries.length === 1)
handlers.clear()

console.log('scenario 28: a rule layer that states a kind switch is used verbatim')
const { withKindDefaults: kinds28, sparseOverride: sparse28 } = await import('../src/rule.ts')
const { FALLBACK_RULE: fallback28 } = await import('../src/rule.ts')
const { mergeRule: merge28 } = await import('../src/rule.ts')
// The reported defect: a new-shape sparse layer must not have the other switch
// injected from `enabled`.
const shaped28 = kinds28({ enabled: false, continuableSubagents: false }, undefined)
check('a new-shape layer does not get the missing switch injected',
  !Object.hasOwn(shaped28, 'oneShotSubagents'), JSON.stringify(shaped28))
const legacy28 = kinds28({ enabled: false }, undefined)
check('an old-shape layer still derives both switches',
  legacy28.continuableSubagents === false && legacy28.oneShotSubagents === false, JSON.stringify(legacy28))
// End to end: an inherited kind survives that override.
const inherited28 = resolve25('m', shim25({ oneShotSubagents: true }, { m: { enabled: false, continuableSubagents: false } }))
check('a sparse override no longer disables an inherited kind',
  inherited28.oneShotSubagents === true, String(inherited28.oneShotSubagents))
// And the panel cannot store such an ambiguous layer in the first place.
const base28 = merge28(fallback28, { enabled: true }, undefined)
const stored28 = sparse28(base28, { ...base28, enabled: false })
check('a saved layer that changes enabled states both kind switches',
  Object.hasOwn(stored28, 'continuableSubagents') && Object.hasOwn(stored28, 'oneShotSubagents'), JSON.stringify(stored28))

console.log('scenario 29: a pre-step that joins the launch gate waits for the compression')
handlers.clear()
const store29 = new SidecarStore()
/** Slow on purpose: the compression stays in flight across the pre-step. */
const llm29 = { calls: 0, stream(options: { messages: unknown[] }): AsyncIterable<unknown> {
  this.calls += 1
  void options
  return (async function* gen() {
    yield { type: 'text-delta', index: 0, text: 'Distilled: ask for Paris weather and call the tool.' }
    await new Promise(resolve => setTimeout(resolve, 60))
    yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 20, cacheReadTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
} }
const engine29 = new ReasoningDistillEngine({ ...ctx, llm: llm29 } as never, cfg10 as never, store29)
engine29.start()
const s29 = new FakeSession('session-gate-order')
sessions.set(s29.id, s29)
await fire('session/created', s29)
// Warm the record so the gate's read resolves from cache on the next microtask.
await fire('agent/pre-step', { agent: { session: s29 } }, async () => undefined)
s29.append('user/message', { id: 'u29', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq29 = s29.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a29', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
s29.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s29, s29.eventAt(seq29))
// The gate is registered by step/end; this pre-step runs immediately after it.
await fire('session/event', s29, s29.eventAt(s29.log.length - 1))
const gateStart29 = Date.now()
await fire('agent/pre-step', { agent: { session: s29 } }, async () => undefined)
const gateWaited29 = Date.now() - gateStart29
// The distiller takes ~60ms, so returning early would prove the pre-step did not
// wait for it — without this the check below could pass just because it finished
// fast.
check('the pre-step actually waited for the compression', gateWaited29 >= 40, `${gateWaited29}ms`)
const settled29 = await store29.load(s29.id)
check('the next request is only sent once the compression it started has finished',
  settled29.entries.length === 1, `entries=${settled29.entries.length} calls=${llm29.calls}`)
check('and it is the compression that was started, not a second one', llm29.calls === 1, String(llm29.calls))

console.log('scenario 30: a malformed legacy record is unreadable, never blank')
const store30 = new SidecarStore()
const legacy30 = legacySidecarPath('recov/a')
mkdirSync(dirname(legacy30), { recursive: true })
writeFileSync(legacy30, '{ truncated json')
let threw30 = false
await store30.load('recov/a').catch(() => { threw30 = true })
check('a malformed legacy record is reported as unreadable', threw30)
check('and the file is left exactly as it was', readFileSync(legacy30, 'utf8') === '{ truncated json')
store30.forget('recov/a')
writeFileSync(legacy30, JSON.stringify({ version: 9, entries: [] }))
let threw30b = false
await store30.load('recov/a').catch(() => { threw30b = true })
check('a legacy record with an unknown shape is unreadable too', threw30b)
// A well-formed record that proves another owner is a *known* foreign file, so it
// is still ignored rather than treated as unreadable.
store30.forget('recov/a')
writeFileSync(legacy30, JSON.stringify({ version: 1, sessionId: 'someone-else', epoch: 0, entries: [], countedThroughSeq: 0 }))
const foreign30 = await store30.load('recov/a')
check('a proven foreign legacy owner is ignored, not fatal', foreign30.entries.length === 0)
// Removing the broken file restores the session.
store30.forget('recov/a')
rmSync(legacy30, { force: true })
const healed30 = await store30.load('recov/a')
check('removing the broken file restores the session', healed30.entries.length === 0)

console.log('scenario 31: a request is credited against the surface it was sent with')
handlers.clear()
/** Holds the accounting read open so the surface can change underneath it. */
class GatedStore extends SidecarStore {
  gate: Promise<void> | undefined
  override async load(sessionId: string): Promise<Awaited<ReturnType<SidecarStore['load']>>> {
    const held = this.gate
    if (held !== undefined) await held
    return await super.load(sessionId)
  }
}
const store31 = new GatedStore()
const engine31 = new ReasoningDistillEngine({ ...ctx, llm: fakeLlm } as never, cfg10 as never, store31)
engine31.start()
const s31 = new FakeSession('session-surface-time')
sessions.set(s31.id, s31)
await fire('session/created', s31)
s31.append('user/message', { id: 'u31', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq31 = s31.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a31', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
s31.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s31, s31.eventAt(seq31))
await fire('session/event', s31, s31.eventAt(s31.log.length - 1))
await fire('agent/pre-step', { agent: { session: s31 } }, async () => undefined)
const first31 = await store31.load(s31.id)
check('a compression to account for exists', first31.entries.length === 1)
// The following request is answered while its accounting read is held open.
let release31: () => void = () => undefined
store31.gate = new Promise<void>(resolve => { release31 = resolve })
const seq31b = s31.append('assistant/message', {
  turn: 2, step: 1,
  message: { id: 'a31b', role: 'assistant', content: [{ type: 'reasoning', text: 'short reasoning' }, { type: 'text', text: 'done' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
await fire('session/event', s31, s31.eventAt(seq31b))
// The prefix is compacted away before that held accounting can resume.
const target31 = first31.entries[0]!.targetSeq
s31.nodes.splice(0, s31.nodes.length, ...s31.nodes.filter(seq => seq !== target31))
s31.append('compaction/end', { compactionId: 'c-31', turn: 2 })
await fire('session/event', s31, s31.eventAt(s31.log.length - 1))
release31()
store31.gate = undefined
await settleFor(async () => {
  const record = await store31.load(s31.id)
  return record.entries[0]!.liveRequests > 0 || record.entries[0]!.frozenSaved > 0
})
const after31 = await store31.load(s31.id)
// The compaction that followed froze the credit, which zeroes the live counters —
// so the total is the evidence that the request was accounted at all.
check('the answered request is credited against the surface it was sent with',
  after31.entries[0]!.liveSaved + after31.entries[0]!.frozenSaved > 0,
  JSON.stringify({ requests: after31.entries[0]!.liveRequests, live: after31.entries[0]!.liveSaved, frozen: after31.entries[0]!.frozenSaved }))

console.log('scenario 32: a compaction reprices the surviving rewrite for one request')
handlers.clear()
const store32 = new SidecarStore()
const engine32 = new ReasoningDistillEngine({ ...ctx, llm: fakeLlm } as never, cfg10 as never, store32)
engine32.start()
const s32 = new FakeSession('session-reprice')
sessions.set(s32.id, s32)
await fire('session/created', s32)
s32.append('user/message', { id: 'u32', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq32 = s32.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a32', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
s32.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s32, s32.eventAt(seq32))
await fire('session/event', s32, s32.eventAt(s32.log.length - 1))
await fire('agent/pre-step', { agent: { session: s32 } }, async () => undefined)
const saved32 = (await store32.load(s32.id)).entries[0]!.liveSaved
check('nothing is credited before a later request', saved32 === 0, String(saved32))
/** Answer one more request and report how much new money it credited. */
const credit32 = async (turn: number): Promise<number> => {
  const before = (await store32.load(s32.id)).entries[0]!.liveSaved
  s32.append('assistant/message', {
    turn, step: 1,
    message: { id: `a32-${turn}`, role: 'assistant', content: [{ type: 'reasoning', text: 'short' }, { type: 'text', text: 'done' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
    stream: [],
  })
  await fire('session/event', s32, s32.eventAt(s32.log.length - 1))
  await settleFor(async () => (await store32.load(s32.id)).entries[0]!.liveSaved > before)
  return (await store32.load(s32.id)).entries[0]!.liveSaved - before
}
const first32 = await credit32(2)
const second32 = await credit32(3)
check('the first replay is priced as a miss', first32 > second32, `${first32} vs ${second32}`)
check('and the next one as a hit', second32 > 0 && first32 > 0)
// The prefix changes; the target survives, so the rewrite stays in force.
s32.append('compaction/end', { compactionId: 'c-32', turn: 3 })
await fire('session/event', s32, s32.eventAt(s32.log.length - 1))
await settleFor(async () => (await store32.load(s32.id)).epoch === 1)
const third32 = await credit32(4)
check('the request after a compaction is priced as a miss again',
  Math.abs(third32 - first32) < 1e-12 && third32 > second32, `${third32} vs ${first32} / ${second32}`)

console.log('scenario 33: the stock shrinks with compaction, the lifetime never does')
const { buildReport: build33 } = await import('../src/report.ts')
const { priceAt: price33 } = await import('../src/peak.ts')
const cfg33 = makeConfig() as never as Parameters<typeof build33>[2]
const when33 = Date.UTC(2026, 9, 14, 2)
/** One adopted rewrite: 1000 original tokens distilled to 250, i.e. 750 saved per request. */
const entry33 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'e33', sessionId: 's33', appliedAt: when33, turn: 1, step: 1,
  provider: 'deepseek-official', model: 'deepseek-flash',
  targetSeq: 10, targetMessageId: 'm33',
  originalChars: 4000, originalTokens: 1000, distilledChars: 1000, distilledTokens: 250,
  savedTokensPerRequest: 750, liveSaved: 0, frozenSaved: 0, liveRequests: 0,
  distilledText: 'distilled',
  distill: { sessionId: '', provider: 'deepseek-official', model: 'deepseek-flash', inputTokens: 10, outputTokens: 5, cost: 0.001, estimated: false },
  cacheBreakTokens: 0, cacheBreakCost: 0,
  ...over,
})
const record33 = (entries: Array<Record<string, unknown>>): never => ({ version: 1, sessionId: 's33', epoch: 0, entries, countedThroughSeq: 0 }) as never
const hit33 = price33('deepseek-flash', cfg33.prices.get() ?? {}, when33, cfg33).bucket.hit / 1_000_000
const miss33 = price33('deepseek-flash', cfg33.prices.get() ?? {}, when33, cfg33).bucket.miss / 1_000_000

const live33 = { active: [], blockingSince: null, blockingReason: null, now: when33 } as never
const fresh33 = build33('s33', record33([entry33()]), cfg33, live33)
check('a fresh rewrite makes the stock its per-request reduction',
  fresh33.stockTokens === 750, String(fresh33.stockTokens))
check('and the money is the hit-rate estimate, not the miss rate',
  Math.abs(fresh33.stockSaved - 750 * hit33) < 1e-12 && hit33 < miss33,
  `${fresh33.stockSaved} vs hit ${750 * hit33} / miss ${750 * miss33}`)
check('nothing is lifetime-saved before a request is answered',
  fresh33.lifetimeTokens === 0, String(fresh33.lifetimeTokens))
check('success and attempts are counted apart', fresh33.succeeded === 1 && fresh33.triggers === 1)

// Three answered requests: the lifetime grows, the stock does not.
const used33 = build33('s33', record33([entry33({ liveRequests: 3, liveSaved: 3 * 750 * hit33 })]), cfg33, live33)
check('the profile accumulates one settlement per answered request',
  used33.lifetimeTokens === 2250, String(used33.lifetimeTokens))
check('while the stock stays what one request would carry',
  used33.stockTokens === 750, String(used33.stockTokens))

// Compaction retires the rewrite: the stock empties, the lifetime keeps its past.
const retired33 = build33('s33', record33([entry33({ liveRequests: 3, liveSaved: 0, frozenSaved: 3 * 750 * hit33, inactive: true })]), cfg33, live33)
check('a retired rewrite drops out of the stock',
  retired33.stockTokens === 0 && retired33.stockSaved === 0, `${retired33.stockTokens}/${retired33.stockSaved}`)
check('but its lifetime saving is never cleared',
  retired33.lifetimeTokens === 2250, String(retired33.lifetimeTokens))

// Failed and skipped attempts are attempts, not successes, and contribute nothing.
const mixed33 = build33('s33', record33([
  entry33(),
  entry33({ id: 'e33f', failed: true, distilledText: '' }),
  entry33({ id: 'e33s', skipped: true, distilledText: '' }),
]), cfg33, live33)
check('failed and skipped attempts never count as success',
  mixed33.succeeded === 1 && mixed33.triggers === 3, `${mixed33.succeeded}/${mixed33.triggers}`)
check('and they add nothing to the stock',
  mixed33.stockTokens === 750, String(mixed33.stockTokens))

console.log('scenario 34: the stock is priced at the current period, not when the rewrite happened')
const peak34 = Date.UTC(2026, 9, 14, 2)    // Wednesday 10:00 Beijing: peak
const off34 = Date.UTC(2026, 9, 14, 16)    // Thursday 00:00 Beijing: off-peak
const cfg34 = makeConfig({
  prices: { get: () => ({ 'deepseek-flash': { peak: { hit: 1, miss: 10, out: 10 }, off: { hit: 0.1, miss: 1, out: 1 }, peakPricing: true } }) },
  peakSource: { get: () => 'builtin' },
}) as never as Parameters<typeof build33>[2]
const entry34 = entry33({ appliedAt: peak34, id: 'e34' })
const peakView34 = build33('s34', record33([entry34]), cfg34, { active: [], blockingSince: null, blockingReason: null, now: peak34 } as never)
const offView34 = build33('s34', record33([entry34]), cfg34, { active: [], blockingSince: null, blockingReason: null, now: off34 } as never)
check('viewed during peak, the stock uses the peak hit rate',
  Math.abs(peakView34.stockSaved - 750 * 1e-6) < 1e-12, String(peakView34.stockSaved))
check('viewed off-peak, the same rewrite is worth the off-peak rate',
  Math.abs(offView34.stockSaved - 750 * 0.1e-6) < 1e-12, String(offView34.stockSaved))
check('and the tokens do not move with the clock',
  peakView34.stockTokens === 750 && offView34.stockTokens === 750)

console.log('scenario 35: a projection that strips the reasoning stops both the rewrite and its credit')
handlers.clear()
const store35 = new SidecarStore()
const engine35 = new ReasoningDistillEngine({ ...ctx, llm: fakeLlm } as never, cfg10 as never, store35)
engine35.start()
const s35 = new FakeSession('session-projected')
sessions.set(s35.id, s35)
await fire('session/created', s35)
s35.append('user/message', { id: 'u35', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq35 = s35.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a35', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
s35.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s35, s35.eventAt(seq35))
await fire('session/event', s35, s35.eventAt(s35.log.length - 1))
await fire('agent/pre-step', { agent: { session: s35 } }, async () => undefined)
const entry35 = (await store35.load(s35.id)).entries[0]!
check('the rewrite is in force before the projection',
  engine35.stock(s35.id)?.tokens === entry35.savedTokensPerRequest, JSON.stringify(engine35.stock(s35.id)))
// A message projection replaces the same surface node with a text-only message.
const projected35 = s35.eventAt(seq35) as { data: { message: { content: unknown[] } } }
projected35.data.message.content = [{ type: 'text', text: 'projected rewrite' }]
check('re-deriving replaces nothing once the reasoning is gone',
  !s35.deriveMessages().some(message => JSON.stringify(message).includes('Distilled: ask for Paris')))
check('so the engine reports no stock for it', (engine35.stock(s35.id)?.tokens ?? 0) === 0, JSON.stringify(engine35.stock(s35.id)))
// The next answered request must not be credited either.
s35.append('assistant/message', {
  turn: 2, step: 1,
  message: { id: 'a35b', role: 'assistant', content: [{ type: 'reasoning', text: 'short' }, { type: 'text', text: 'done' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
})
await fire('session/event', s35, s35.eventAt(s35.log.length - 1))
await settleFor(async () => (await store35.load(s35.id)).countedThroughSeq > 0)
const after35 = await store35.load(s35.id)
check('and no token savings are credited for a rewrite that was not applied',
  after35.entries[0]!.liveSaved + after35.entries[0]!.frozenSaved === 0,
  JSON.stringify({ live: after35.entries[0]!.liveSaved, frozen: after35.entries[0]!.frozenSaved }))

console.log('scenario 36: with no rewrite backend selected, nothing is distilled')
handlers.clear()
const store36 = new SidecarStore()
const llm36 = { calls: 0, stream(): AsyncIterable<unknown> {
  this.calls += 1
  return (async function* gen() { yield { type: 'text-delta', index: 0, text: 'x' }; yield { type: 'finish', reason: { kind: 'stop' } } })()
} }
const cfg36 = makeConfig({ rewriteBackend: { get: () => '' } })
const engine36 = new ReasoningDistillEngine({ ...ctx, llm: llm36 } as never, cfg36 as never, store36)
engine36.start()
const s36 = new FakeSession('session-no-backend')
sessions.set(s36.id, s36)
await fire('session/created', s36)
s36.append('user/message', { id: 'u36', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
const seq36 = s36.append('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'a36', role: 'assistant', content: [{ type: 'reasoning', text: fatReasoning }, { type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  stream: [],
}).seq
s36.append('step/end', { turn: 1, step: 1 })
await fire('session/event', s36, s36.eventAt(seq36))
await fire('session/event', s36, s36.eventAt(s36.log.length - 1))
await fire('agent/pre-step', { agent: { session: s36 } }, async () => undefined)
check('no backend means no paid distiller call', llm36.calls === 0, String(llm36.calls))
check('no rewrite is recorded either', (await store36.load(s36.id)).entries.length === 0)
check('and the reasoning is replayed untouched',
  s36.deriveMessages().some(message => JSON.stringify(message).includes('hmm, let me think.')))

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
if (info.length > 0) console.log(`\nlogs:\n${info.slice(0, 6).map(line => `  ${line}`).join('\n')}`)
process.exitCode = failures === 0 ? 0 : 1
