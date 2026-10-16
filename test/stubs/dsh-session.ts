/**
 * Minimal stand-in for the host session package, for the offline smoke bundle.
 *
 * The engine reaches the host through its context (this suite hands it a fake sessions service),
 * with one exception: the host-patch self-check needs the session class itself. A real host that
 * carries the patch is what that check exists to recognize, and this bundle has no host — so the
 * stub is honest about the only thing it can be: a host WITHOUT the patch. Tests that need the
 * patched shape hand the engine their own session object instead of going through detection.
 * @module dsh-reasoning-distill/test/stubs/dsh-session
 */

/** Branded-id constructors are identity functions at runtime. */
export const SessionId = (value: string): string => value
/** Sequence brands are identity functions at runtime too. */
export const SessionSeq = (value: number): number => value
/** Log-offset brand, identity at runtime. */
export const SessionLogOffset = (value: number): number => value

/** The unpatched session class: it cannot be constructed here, and the check reads that as absent. */
export const Session = {
  create: (): never => { throw new Error('dsh-session stub: no session class offline') },
}
