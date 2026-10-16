/**
 * Detection of the host patch that makes an in-place rewrite possible.
 *
 * The built-in in-place backend is the one backend this plugin serves itself, and it can only work
 * on a host that carries our patch. The patch adds one method to Session, so "installed" is a
 * runtime question with two halves: the method existing at all, and the method really rewriting one
 * reasoning block in place. Both are answered here, on a detached throwaway session that is never
 * published, so the check touches neither storage nor any conversation.
 *
 * The patched entry point is declared structurally, never imported from the host's types: the
 * patch is optional, and a plugin that only compiled against a patched host could not be installed
 * anywhere else.
 * @module dsh-reasoning-distill/host-patch
 */

import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'

import type { HostPatchStatus } from './shared.ts'

/**
 * The host entry point this plugin drives, as the patch defines it.
 *
 * Declared here rather than imported: the type has to be usable on a host where the patch is
 * absent, which is exactly the host that has no declaration for it.
 */
export type RewriteEntryPoint = (request: {
  seq: SessionSeq
  messageId: string
  blockIndex: number
  text: string
}) => SessionEvent<'assistant/message'>

/**
 * The host entry point on one session, when this host carries the patch.
 *
 * BOUND to the session it came from. Callers hold the extracted function and call it on its own,
 * and the patched method reads `this.log`, `this.surfaceManager` and `this.rewriteSink`: an
 * unbound extraction would throw a TypeError at exactly the moment the rewrite has to land.
 * @param session - the session to read the entry point from.
 * @returns the bound entry point, or undefined when this host carries no patch.
 */
export function rewriteEntryPoint(session: unknown): RewriteEntryPoint | undefined {
  const candidate = (session as { rewriteReasoningBlock?: unknown } | null | undefined)?.rewriteReasoningBlock
  return typeof candidate === 'function' ? (candidate as RewriteEntryPoint).bind(session) : undefined
}

/** One line naming why a self-check step failed. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The reasoning text the self-check starts from. */
const PROBE_TEXT = 'reasoning-distill: host patch self-check'
/** The text the self-check rewrites that block to, proving the rewrite really changes content. */
const REWRITTEN_TEXT = 'reasoning-distill: host patch self-check (rewritten)'

/** The reasoning text of one assistant event, or undefined when it carries no reasoning block. */
function reasoningOf(event: SessionEvent | undefined): string | undefined {
  if (event === undefined || event.type !== 'assistant/message') return undefined
  const block = event.data.message.content.find(item => item.type === 'reasoning')
  return block === undefined ? undefined : block.text
}

/**
 * Run the host-patch self-check.
 *
 * It is a real rewrite of a real assistant message, on a detached session that is never published,
 * so nothing durable and no conversation is touched. The block is first rewritten to the text it
 * already carries — which the host must treat as a no-op returning the same frozen event — then to
 * a different text, which must change what the derived history carries, then back again. A host
 * without the patch fails at the first lookup; one whose patch is present but broken fails one of
 * the three steps.
 * @returns whether the entry point exists, and whether it really performs the rewrite.
 */
export function detectHostPatch(): HostPatchStatus {
  let probe: Session
  try {
    probe = Session.create(SessionId('reasoning-distill-host-check'))
  } catch (error) {
    return { patched: false, functional: false, detail: reason(error) }
  }
  const rewrite = rewriteEntryPoint(probe)
  if (rewrite === undefined) {
    return { patched: false, functional: false, detail: 'the host exposes no rewriteReasoningBlock entry point' }
  }
  try {
    probe.append('turn/start', { turn: 1 })
    probe.append('step/start', { turn: 1, step: 1 })
    const event = probe.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'reasoning', text: PROBE_TEXT }],
        source: { provider: 'reasoning-distill', model: 'host-check' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    probe.append('step/end', { turn: 1, step: 1 })
    probe.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const target = { seq: event.seq, messageId: event.data.message.id, blockIndex: 0 }
    // Idempotence: the text already matches, so the host must hand back the very event it holds.
    if (rewrite({ ...target, text: PROBE_TEXT }) !== event) {
      return { patched: true, functional: false, detail: 'a rewrite to the text already carried did not return the same event' }
    }
    const changed = rewrite({ ...target, text: REWRITTEN_TEXT })
    if (reasoningOf(changed) !== REWRITTEN_TEXT || reasoningOf(probe.eventAt(event.seq)) !== REWRITTEN_TEXT) {
      return { patched: true, functional: false, detail: 'the rewrite did not land in the log at its own seq' }
    }
    const visible = probe.deriveMessages().some(message =>
      message.role === 'assistant' && message.content.some(block => block.type === 'reasoning' && block.text === REWRITTEN_TEXT))
    if (!visible) return { patched: true, functional: false, detail: 'deriveMessages() did not reflect the rewrite' }
    const restored = rewrite({ ...target, text: PROBE_TEXT })
    if (reasoningOf(restored) !== PROBE_TEXT || reasoningOf(probe.eventAt(event.seq)) !== PROBE_TEXT) {
      return { patched: true, functional: false, detail: 'restoring the original text failed' }
    }
    return { patched: true, functional: true }
  } catch (error) {
    return { patched: true, functional: false, detail: reason(error) }
  }
}
