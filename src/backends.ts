/**
 * The assistants that can write a distilled rewrite back into a session's own
 * history, and the requests that ask them to.
 *
 * Shared by the host and the panel on purpose: the host decides *when* a rewrite
 * should be applied, the panel decides *where the user ends up*, and both must
 * agree on which backend is selected and what its contract is.
 * @module dsh-reasoning-distill/backends
 */

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
    if (entry.targetBlockIndex < 0) return undefined
    // A compression branch must be *this* conversation with one block rewritten:
    // `edit` rebuilds the turn from its start, dropping tool calls and every later
    // step, while `splice` copies the whole history and replaces the block in place.
    return {
      path: '/message-edit',
      body: { action: 'splice', sessionId, eventSeq: entry.targetSeq, blockIndex: entry.targetBlockIndex, text },
    }
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
