import { HANDOFF_ROUTE, type SessionReport } from '../shared.ts'

/**
 * Record how a hand-off attempt ended.
 *
 * Shared by the report panel and the composer seat: whichever one applies an in-place
 * rewrite must clear the host's pending marker, and both have to agree on the wire contract.
 * `cancel: false` is what makes an in-place settle keep the turn going.
 * @param current - the report the entry belongs to.
 * @param entryId - the entry whose attempt is being settled.
 * @param error - refusal text to remember, when the attempt failed.
 * @returns the verdict, and whether the host recorded a note.
 */
export async function settleHandoff(
  current: SessionReport,
  entryId: string,
  error?: string,
): Promise<{ verdict: 'settled' | 'refused' | 'failed'; recorded: boolean }> {
  try {
    const response = await fetch(HANDOFF_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: current.sessionId,
        cancel: false,
        entryId,
        generation: current.generation,
        ...error === undefined ? {} : { error },
      }),
    })
    if (!response.ok) return { verdict: 'failed', recorded: true }
    const payload = await response.json().catch(() => null) as { ok?: unknown; recorded?: unknown } | null
    return { verdict: payload?.ok === false ? 'refused' : 'settled', recorded: payload?.recorded !== false }
  } catch {
    return { verdict: 'failed', recorded: true }
  }
}
