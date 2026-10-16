/**
 * Host-side definition for this plugin's in-place reasoning rewrite.
 *
 * Installed into a DSH checkout by `scripts/dsh-inplace-patch.mjs`. It is deliberately
 * dependency-free apart from type imports so the patch can drop it into the host's
 * session-format catalog package without touching that package's build graph.
 *
 * Why the host is involved at all: a rewrite that changes an *existing* assistant message in
 * place cannot be expressed with the public surface contract. `assistant/message` may not carry
 * `sourceEventSeqs` (it embeds its provider stream), while a positional replacement must cite
 * every shadowed node — so no out-of-tree producer can legally replace an assistant node, and
 * `validateStoredEvents` refuses a log whose event type the build does not know unless the record
 * is marked `ignorable`. The supported seam for "a plugin changes existing message content" is a
 * message projection: declare the event with `@messageProjection`, interpret it purely, and the
 * host applies it on live creation, restore and fork.
 *
 * Safety without this plugin: the definition only interprets events the plugin wrote. Nothing
 * else in the host calls it, and an unpatched host treats those events as unknown — they load
 * because the plugin marks them `ignorable`, and are then ignored, so a conversation simply shows
 * its original reasoning.
 * @module dsh-reasoning-distill/host-patch/reasoning-distill-rewrite
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface'

/** One durable in-place rewrite of an existing assistant message's reasoning block. */
export interface ReasoningDistillRewriteTarget {
  /** Current message-producing event holding the reasoning block. */
  seq: SessionSeq
  /** Identity the target message must still carry, so a reused seq is never rewritten. */
  messageId: string
  /** Index of the reasoning block inside that message's content. */
  blockIndex: number
  /** Text the block is replaced with. */
  text: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Permanently replace one reasoning block of an earlier assistant message in place, without
     * forking the conversation or leaving the message's identity. The target must be a current
     * surface node whose event is an assistant message with that id and a reasoning block at that
     * index; every later model request sees the replacement, while the durable transcript keeps
     * the original block.
     * @messageProjection
     */
    'reasoning-distill/rewrite': ReasoningDistillRewriteTarget
  }
}

/** Whether a durable value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a durable value is a non-negative safe integer sequence number. */
function isSeq(value: unknown): value is SessionSeq {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/**
 * Interpret one rewrite event against the history before it.
 *
 * The decision is validated in full before any message is returned: a target that is not a
 * current node, names another message, or has no reasoning block at that index refuses the whole
 * event rather than applying half of it. The returned messages are immutable copies that keep
 * their identity, and a second rewrite of the same message composes onto the first because the
 * projection reads the already-projected message from its context.
 */
export const reasoningDistillRewriteProjection: SessionMessageProjection<'reasoning-distill/rewrite'> = {
  type: 'reasoning-distill/rewrite',
  project(event, context) {
    const data: unknown = event.data
    if (!isRecord(data)) throw new Error('reasoning-distill/rewrite: data must be an object')
    // Exactly these four: a typo in a field name must refuse the event rather than silently
    // rewrite nothing (the same strictness the first-party image projection applies).
    if (Object.keys(data).length !== 4) {
      throw new Error('reasoning-distill/rewrite: data must contain exactly seq, messageId, blockIndex and text')
    }
    const target = data as { seq?: unknown; messageId?: unknown; blockIndex?: unknown; text?: unknown }
    if (!isSeq(target.seq)) throw new Error('reasoning-distill/rewrite: seq must be a sequence number')
    if (typeof target.messageId !== 'string' || target.messageId === '') {
      throw new Error('reasoning-distill/rewrite: messageId must be a non-empty string')
    }
    if (!isSeq(target.blockIndex)) throw new Error('reasoning-distill/rewrite: blockIndex must be a non-negative integer')
    if (typeof target.text !== 'string' || target.text === '') {
      throw new Error('reasoning-distill/rewrite: text must be a non-empty string')
    }
    const seq = target.seq
    if (!context.nodes.includes(seq)) {
      throw new Error(`reasoning-distill/rewrite: target seq ${seq} is not a current surface node`)
    }
    const source = context.events[seq - context.baseSeq]
    if (source?.type !== 'assistant/message') {
      throw new Error(`reasoning-distill/rewrite: target seq ${seq} is not an assistant message`)
    }
    // Prefer the already-projected message so repeated rewrites compose; fall back to the log.
    const current: Message | undefined = context.messages.get(seq) ?? source.data.message
    if (current.id !== target.messageId) {
      throw new Error(`reasoning-distill/rewrite: target seq ${seq} carries message "${current.id}", not "${target.messageId}"`)
    }
    const blockIndex = target.blockIndex
    const block = current.content[blockIndex]
    if (block?.type !== 'reasoning') {
      throw new Error(`reasoning-distill/rewrite: block ${blockIndex} of message "${current.id}" is not a reasoning block`)
    }
    if (block.text === target.text) return new Map()
    const content = current.content.map((item, index) =>
      index === blockIndex ? { type: 'reasoning' as const, text: target.text as string } : item)
    return new Map([[seq, { ...current, content }]])
  },
}
