/**
 * Rebuilding an open conversation after an in-place rewrite.
 *
 * The shell's transcript is assembled from a follow stream that carries one snapshot plus the
 * events appended after it. An in-place rewrite appends nothing: the same seq keeps the same record
 * with different text. An already-open view therefore keeps rendering the superseded reasoning until
 * something reads that session again — a page reload does, which is exactly the gap this closes.
 *
 * The client Session that owns that window can rebuild it from the host on demand, and it is the
 * very object the conversation renders from, so asking it to rebuild updates the transcript in
 * place. The rebuild entry point is not part of the session face this plugin compiles against, so it
 * is feature-detected: a shell that does not expose one keeps today's behaviour — the rewritten text
 * appears on the next read — and nothing else changes.
 * @module dsh-reasoning-distill/client/transcript
 */

/** The one client-Session operation this module uses. */
export interface RefreshableSession {
  /** Rebuild an already-open history window from the host. */
  resync?: () => unknown
}

/**
 * Ask one client Session to rebuild its open window.
 *
 * Never throws. A view that cannot be refreshed is a cosmetic loss, not a failed rewrite: by the
 * time the caller gets here the history is already written, and the next read shows it.
 * @param session - the session a conversation renders from, when it could be reached.
 * @returns whether a rebuild was asked for.
 */
export function refreshTranscript(session: RefreshableSession | undefined): boolean {
  if (typeof session?.resync !== 'function') return false
  try {
    void session.resync()
    return true
  } catch {
    return false
  }
}
