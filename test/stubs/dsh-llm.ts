/**
 * Offline test stub for `@deepseek-ai/dsh-llm`.
 *
 * The smoke test bundles `src/engine.ts` with this file aliased in, so the host
 * half can be exercised without the DSH runtime. This stub is test-only: it is
 * never installed into `node_modules` (a stub there would shadow the real
 * package for the live plugin).
 * @module dsh-reasoning-distill/test/stubs/dsh-llm
 */

let counter = 0

/** Mint a message id the way the real factory does. */
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}

/** Construct a user message value. */
export function createUserMessage(input: { content: unknown[]; source: { kind: string } }): unknown {
  return { id: nextId('user'), role: 'user', content: input.content, source: input.source }
}

/** Construct an assistant message value. */
export function createAssistantMessage(input: { content: unknown[]; source: Record<string, unknown> }): unknown {
  return { id: nextId('assistant'), role: 'assistant', content: input.content, source: { kind: 'model', ...input.source } }
}

/** Minimal stream assembler: text deltas plus a terminal finish. */
export class BlockAssembler {
  private readonly texts: string[] = []
  /** Usage reported by the terminal chunk. */
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | undefined
  /** Finish reason reported by the terminal chunk. */
  finish: { kind: string } = { kind: 'stop' }

  /** Feed one stream chunk. */
  push(chunk: { type: string; text?: string; usage?: unknown; reason?: { kind: string } }): void {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') this.texts.push(chunk.text)
    if (chunk.type === 'usage' && chunk.usage !== undefined) {
      this.usage = chunk.usage as BlockAssembler['usage']
    }
    if (chunk.type === 'finish' && chunk.reason !== undefined) this.finish = chunk.reason
  }

  /** Assembled blocks. */
  blocks(): { type: string; text?: string }[] {
    return this.texts.length === 0 ? [] : [{ type: 'text', text: this.texts.join('') }]
  }
}

/**
 * Mirror `freezeMessage`: a detached immutable snapshot that preserves identity.
 * @param message - complete message.
 * @returns a frozen clone.
 */
export function freezeMessage<T>(message: T): T {
  return Object.freeze(structuredClone(message)) as T
}
