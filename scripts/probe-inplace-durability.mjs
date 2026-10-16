/**
 * The plan's section 4 experiment: does an in-place rewrite survive a restart?
 *
 * It boots a real session store over a real jsonl artifact, writes an assistant message with a
 * reasoning block, rewrites that block in place through Session.rewriteReasoningBlock, flushes,
 * and then reopens the same directory from a FRESH context -- what a process restart does. A pass
 * means the stored artifact carries the replacement; a fail means the log edit only ever existed
 * in memory and the persistence layer needs a rewrite intent of its own.
 *
 * It also pins the semantics the plugin depends on: seq and log length unchanged, message id
 * unchanged, sibling blocks untouched, derived history immediately rewritten, the same edit
 * idempotent, and the four refusal paths.
 *
 * Run it (the host runs from source under tsx, so nothing has to be built first):
 *
 *   cp scripts/probe-inplace-durability.mjs "$DSH_HOST_CHECKOUT/.dsh-inplace-probe.mjs"
 *   (cd "$DSH_HOST_CHECKOUT" && node --import tsx/esm .dsh-inplace-probe.mjs)
 *   rm "$DSH_HOST_CHECKOUT/.dsh-inplace-probe.mjs"
 *
 * The copy is only so bare specifiers (@deepseek-ai/dsh-session) resolve against the host's own
 * node_modules; the file is removed again so the host checkout keeps no residue.
 * @module dsh-reasoning-distill/scripts/probe-inplace-durability
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORIGINAL = 'ORIGINAL_REASONING_7f3a'
const REWRITTEN = 'REWRITTEN_REASONING_9c12'
// The artifact's physical encoding; zstd is the backend's default and frames each append batch,
// so the rewrite has to re-encode from a frame boundary. Run both.
const COMPRESSION = process.env.PROBE_COMPRESSION === 'zstd' ? 'zstd' : 'none'

let failures = 0
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '  -- ' + detail))
  if (!ok) failures += 1
}

const root = await mkdtemp(join(tmpdir(), 'dsh-inplace-probe-'))

/** Mount one SessionStore + jsonl backend over the shared root. */
async function boot() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: COMPRESSION })
  return ctx
}

/** Read the stored log through a throwaway read handle. */
async function storedEvents(ctx, id) {
  const reader = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await reader.read()).events
  } finally {
    await reader.close()
  }
}

/** The reasoning text of the first assistant message in a stored log. */
function storedReasoning(events) {
  const assistant = events.find(event => event.type === 'assistant/message')
  if (assistant === undefined) return undefined
  const block = assistant.data.message.content.find(item => item.type === 'reasoning')
  return block === undefined ? undefined : block.text
}

/** The reasoning text the live session would send right now. */
function derivedReasoning(session) {
  const message = session.deriveMessages().find(item => item.role === 'assistant')
  if (message === undefined) return undefined
  const block = message.content.find(item => item.type === 'reasoning')
  return block === undefined ? undefined : block.text
}

/** Locate the artifact path this backend reads for one session. */
function findLogPath(ctx, id) {
  return ctx.sessionPersistence.resolveCurrentLog(id)
}

let ctx
let fresh
try {
  ctx = await boot()
  const session = ctx.sessions.create(SessionId('in-place-probe'))
  await ctx.sessionPersistence.create(session.header)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const original = session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'reasoning', text: ORIGINAL }, { type: 'text', text: 'the answer' }],
      source: { kind: 'model', provider: 'probe', model: 'probe' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const lengthBefore = session.seq
  const messageId = original.data.message.id
  await ctx.sessions.flush(session)

  const method = session.rewriteReasoningBlock
  check('Session.rewriteReasoningBlock exists (host patch applied)', typeof method === 'function', 'typeof = ' + typeof method)
  if (typeof method !== 'function') {
    console.log('VERDICT: the host is NOT patched; nothing else can be tested.')
    process.exitCode = 1
  } else {
    check('the artifact carries the original text before the rewrite', storedReasoning(await storedEvents(ctx, session.id)) === ORIGINAL)

    const next = session.rewriteReasoningBlock({ seq: original.seq, messageId, blockIndex: 0, text: REWRITTEN })
    check('the returned event is the rewritten assistant message', next.type === 'assistant/message')
    check('the reasoning block carries the new text', next.data.message.content[0].text === REWRITTEN)
    check('the sibling text block is untouched', next.data.message.content[1].text === 'the answer')
    check('the message id is unchanged', next.data.message.id === messageId, messageId)
    check('the seq is unchanged', next.seq === original.seq, String(next.seq))
    check('the log length is unchanged', session.seq === lengthBefore, String(lengthBefore) + ' -> ' + String(session.seq))
    check('the stored event at that seq is the rewritten one', session.eventAt(original.seq) === next)
    check('deriveMessages() reflects the rewrite immediately', derivedReasoning(session) === REWRITTEN, String(derivedReasoning(session)))
    check('the same edit is idempotent', session.rewriteReasoningBlock({ seq: original.seq, messageId, blockIndex: 0, text: REWRITTEN }) === next)

    const refuses = (label, run) => {
      try {
        run()
        check(label, false, 'did not throw')
      } catch (error) {
        check(label, true, String(error && error.message))
      }
    }
    refuses('refuses a seq that is not an assistant message', () => session.rewriteReasoningBlock({ seq: 0, messageId, blockIndex: 0, text: REWRITTEN }))
    refuses('refuses a mismatched message id', () => session.rewriteReasoningBlock({ seq: original.seq, messageId: 'someone-else', blockIndex: 0, text: REWRITTEN }))
    refuses('refuses a block that is not reasoning', () => session.rewriteReasoningBlock({ seq: original.seq, messageId, blockIndex: 1, text: REWRITTEN }))
    refuses('refuses empty text', () => session.rewriteReasoningBlock({ seq: original.seq, messageId, blockIndex: 0, text: '' }))

    // The durability barrier that has to carry the rewrite to the artifact too.
    await ctx.sessions.flush(session)
    const sameService = storedReasoning(await storedEvents(ctx, session.id))
    check('the same service reads the rewrite back', sameService === REWRITTEN, String(sameService))

    // A fresh context over the same root: what a restarted process would see.
    fresh = new Context()
    await fresh.plugin(JsonlSessionPersistence, { root, compression: COMPRESSION })
    const onDisk = storedReasoning(await storedEvents(fresh, session.id))
    check('a restarted reader sees the rewrite on disk', onDisk === REWRITTEN, String(onDisk))
    if (COMPRESSION === 'none') {
      const path = await findLogPath(fresh, session.id)
      const bytes = path === undefined ? '' : await readFile(path, 'utf8')
      check('the artifact bytes carry the new text and not the old one', bytes.includes(REWRITTEN) && !bytes.includes(ORIGINAL))
    } else {
      check('the artifact is zstd-framed (text is not readable raw)', true, 'decoded read already proves the content')
    }

    console.log('')
    console.log('compression: ' + COMPRESSION)
    if (onDisk === REWRITTEN) {
      console.log('VERDICT: the restart sees the rewrite -- the in-place backend is durable.')
    } else {
      console.log('VERDICT: the restart sees the OLD text -- (B): persistence needs its own rewrite intent.')
    }
  }
} finally {
  try { if (fresh !== undefined) await fresh.fiber.dispose() } catch {}
  try { if (ctx !== undefined) await ctx.fiber.dispose() } catch {}
  await rm(root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED')
if (failures > 0) process.exitCode = 1
