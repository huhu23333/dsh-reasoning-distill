/**
 * The assistants that can write a distilled rewrite back into a session's own
 * history, and the requests that ask them to.
 *
 * Shared by the host and the panel on purpose: the host decides *when* a rewrite
 * should be applied, the panel decides *where the user ends up*, and both must
 * agree on which backend is selected and what its contract is.
 * @module dsh-reasoning-distill/backends
 */

import { REWRITE_ROUTE } from './shared.ts'

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
  /**
   * Endpoint probed for availability.
   *
   * Absent when nothing can answer: a placeholder reserves the slot for a backend this plugin
   * cannot drive yet, so it has no route to ask about and is never offered as a choice.
   */
  probe?: { method: 'POST'; path: string; body: Record<string, unknown> }
  /** Where the rewrite lands. */
  kind: 'branch' | 'in-place' | 'derive'
  /**
   * Whether this entry only reserves the slot for a backend that is not implemented yet.
   *
   * Such a slot keeps the chooser honest about what is planned and gives a future backend one
   * obvious place to be declared, but it can never be selected: nothing answers for it.
   */
  placeholder?: true
  /**
   * Whether this plugin serves the backend itself, behind a patch to the host.
   *
   * A companion backend proves itself by answering on its own route, and the host can tell from
   * the profile's active plugin list whether that route still exists. This one has no companion
   * package to look for: its route is this plugin's own, so the only thing that decides whether it
   * can be driven is whether the host carries the patch — a question about the host, not the
   * profile. Both halves ask the patch's own self-check rather than guessing from a route.
   */
  hostPatch?: true
  /**
   * Package that owns this backend's route, when a plugin does.
   *
   * The panel proves a backend is installed by probing it, but the host cannot: an in-place
   * backend answers behind `/api/*`, where the shell demands the browser's own credentials. The
   * profile's active plugin list is the host-side signal instead, so a backend names the package
   * whose presence in that list means its route exists. A route the host itself serves would
   * leave this unset, and then nothing host-side is ever closed down on its account.
   */
  plugin?: string
}

/** Backends this plugin knows how to drive, in panel order. */
export const REWRITE_BACKENDS: readonly RewriteBackend[] = [
  {
    // No write at all: the engine's derived-message wrapper is the only writer, so every request
    // sees the distilled reasoning while the session log keeps the original. Nothing is written,
    // no companion is needed, and no host patch is involved, so there is no route to probe and no
    // hand-off to settle. It is the only mode that also works on a packaged host whose source
    // cannot be patched, which is why it is listed first.
    id: 'derive',
    kind: 'derive',
  },
  {
    // The built-in in-place backend: this plugin's own host half does the rewriting, and the host
    // patch is what makes that possible. There is no companion package to name, and the probe is
    // this plugin's own route, so the answer is the patch self-check rather than a third party.
    id: 'in-place',
    kind: 'in-place',
    hostPatch: true,
    probe: { method: 'POST', path: REWRITE_ROUTE, body: { probe: true } },
  },
  {
    // Experimental branch backend: every compression forks a conversation, which narrows the
    // usable scenarios (no subagent hand-off, a branch per compression). Kept last on purpose.
    id: 'message-edit',
    kind: 'branch',
    plugin: 'dsh-message-edit',
    probe: { method: 'POST', path: '/message-edit', body: { action: 'edit', sessionId: '', eventSeq: 0, blockIndex: 0, text: 'probe' } },
  },
]

/**
 * Whether one active plugin entry carries this package.
 *
 * An entry is normally the dependency key, which is the package name; an install from a repository
 * puts the `owner/repo` spec there instead, so a declared package name also matches an entry's
 * trailing path segment. Wildcarding in this direction can only keep a switch open that a probe
 * would close anyway, never close one on a name this list happens to spell differently.
 * @param entry - one active plugin entry.
 * @param plugin - declared package name.
 * @returns whether the entry names that package.
 */
function namesPlugin(entry: string, plugin: string): boolean {
  return entry === plugin || entry.endsWith(`/${plugin}`)
}

/**
 * Whether the selected backend's plugin is absent from the active plugin list.
 *
 * A backend's route exists only while its plugin is loaded, and the host cannot probe for it (see
 * {@link RewriteBackend.plugin}). The profile's active plugin list is the signal the host owns, and
 * the plugin manager updates it when a backend is installed or removed. Absence of evidence is not
 * evidence of absence: a backend without a plugin name, and an unread list, both answer false, so a
 * healthy profile is never closed down on a guess.
 * @param plugin - the backend's package name.
 * @param activePlugins - the profile's active plugin entries; undefined when it could not be read.
 * @returns true only when the list was read and carries no entry for the package.
 */
export function backendMissingFrom(plugin: string | undefined, activePlugins: readonly string[] | undefined): boolean {
  if (plugin === undefined || plugin === '') return false
  if (activePlugins === undefined) return false
  return !activePlugins.some(entry => namesPlugin(entry, plugin))
}

/**
 * Whether the stored selection is one this host cannot drive.
 *
 * Ways to be stuck, and all of them are stale state the plugin itself would never write: the id
 * belongs to another build (a backend since removed, or one this version does not have), the id is
 * a placeholder (nothing answers for it, and its row is disabled, so the panel cannot clear it
 * either — the host is the only one that can), the backend needs the host patch and this host
 * demonstrably lacks it, or the id names a plugin the profile no longer loads. Everything weaker
 * answers false: no evidence about this host means no write.
 * @param backend - the stored backend id.
 * @param activePlugins - the profile's active plugin entries; undefined when it could not be read.
 * @param hostPatch - the patch self-check's verdict for a host-patch backend; false only when the
 *   host was actually asked and answered that the patch is absent.
 * @returns whether the selection has to be cleared.
 */
export function backendUnusable(
  backend: string,
  activePlugins: readonly string[] | undefined,
  hostPatch?: boolean,
): boolean {
  if (backend === '') return false
  const known = backendById(backend)
  // A backend this plugin serves itself turns on the host patch, not on the profile: only a host
  // that was actually asked and answered "no patch" closes the selection. `undefined` is the
  // startup state where no session has been seen yet, and it must not clear a working setup.
  if (known?.hostPatch === true) return hostPatch === false
  if (activePlugins === undefined) return false
  if (known === undefined || known.placeholder === true) return true
  return backendMissingFrom(known.plugin, activePlugins)
}

/** Stored settings a backend that is gone invalidates, ready to be written as one patch. */
export interface BackendFixup {
  /**
   * Master switch. Present only when it was still on: it needs a backend to hand a rewrite over,
   * so it is as invalid as the selection itself.
   */
  enabled?: false
  /**
   * The selection goes away. It names a plugin that is no longer installed, and leaving it stored
   * would keep the panel and every later process promising a hand-off that cannot happen.
   */
  rewriteBackend?: ''
  /**
   * Rule layers whose subagent switches a branch backend pins off, present only for the layers
   * that do not already pin both kinds off.
   */
  defaultRule?: { continuableSubagents: false; oneShotSubagents: false }
  models?: Record<string, { continuableSubagents: false; oneShotSubagents: false }>
}

/**
 * What to write when the selected backend's plugin is gone.
 *
 * The selection is the thing to clear, and the switch follows it only when it is still on: a
 * profile whose switch is already off has nothing to change beyond the stale name, and one whose
 * selection is already empty has nothing to change at all.
 * @param backend - the stored backend id.
 * @param enabled - the stored master switch.
 * @returns the patch to write, or undefined when no stale selection is stored.
 */
export function missingBackendFixup(backend: string, enabled: boolean): BackendFixup | undefined {
  if (backend === '') return undefined
  return enabled ? { enabled: false, rewriteBackend: '' } : { rewriteBackend: '' }
}

/** What one probe request saw; two of these are compared, so it is only the shape. */
export interface ProbeAnswer {
  status: number
  contentType: string | null
  /** Body text; these probes answer with a few words at most. */
  body: string
}

/**
 * Whether a probe response proves the backend is installed.
 *
 * A missing route is answered by the web server, not by the backend — and measured against
 * a live host, its two shapes are `404` for some paths and an empty-bodied `405` for
 * others, while an absent `/api/*` route is stopped earlier by the shell's own
 * `401 unauthorized`. Status codes alone therefore prove nothing, and so does JSON alone:
 * the caller probes a sibling path that cannot exist and treats an identical answer as
 * "not installed", whatever that answer happens to be. Anything different means the
 * backend itself replied — including its own refusals (unknown session, bad body).
 * @param answer - the backend path's answer.
 * @param baseline - an impossible sibling path's answer.
 * @returns true when the backend answered as itself.
 */
export function backendInstalled(answer: ProbeAnswer, baseline: ProbeAnswer): boolean {
  return answer.status !== baseline.status
    || (answer.contentType ?? '') !== (baseline.contentType ?? '')
    || answer.body.trim() !== baseline.body.trim()
}

/**
 * Whether a host-patch backend's probe body reports a patched, working host.
 *
 * The route belongs to this plugin, so its answering at all only proves the plugin is loaded. The
 * body is the self-check's verdict, and both halves have to hold: a host that exposes the entry
 * point but cannot rewrite with it is exactly the broken state the user must not select.
 * @param body - the probe response body.
 * @returns whether the patch is present and functional.
 */
export function hostPatchReady(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed === null || typeof parsed !== 'object') return false
    const verdict = parsed as { patched?: unknown; functional?: unknown }
    return verdict.patched === true && verdict.functional === true
  } catch {
    return false
  }
}

/**
 * Whether a probe of this backend proves it can be selected.
 *
 * A companion backend proves itself by answering as itself (see {@link backendInstalled}); a
 * host-patch backend answers through this plugin's own route, so answering only proves the plugin
 * is loaded and the body has to carry the patch verdict on top.
 * @param backend - registry entry being probed.
 * @param answer - the backend path's answer.
 * @param baseline - an impossible sibling path's answer.
 * @returns whether the panel may offer this backend.
 */
export function backendSelectable(backend: RewriteBackend, answer: ProbeAnswer, baseline: ProbeAnswer): boolean {
  if (!backendInstalled(answer, baseline)) return false
  return backend.hostPatch === true ? hostPatchReady(answer.body) : true
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
 * Whether the backend-specific options block belongs on screen.
 *
 * Only a branch backend leaves a superseded conversation behind, and only a branch
 * backend makes the host wait on it: those options are shown with the selected
 * backend and disappear with it.
 * @param id - stored backend id.
 * @returns whether the block is shown.
 */
export function backendOptionsVisible(id: string): boolean {
  return backendById(id)?.kind === 'branch'
}

/**
 * Whether the master switch may be on: it needs a backend that can apply the result.
 *
 * A backend that is unavailable is as unusable as an unknown id: its plugin was uninstalled but
 * the stored selection still names it, and leaving the switch openable would promise a hand-off
 * that cannot happen. The caller passes what its probe saw; an unanswered probe (undefined) must
 * NOT lock anything, or the first render of a healthy profile would grey the switch out.
 * @param backend - the stored backend id.
 * @param enabled - the stored master switch.
 * @param installed - whether the selected backend answered its probe; undefined while unknown.
 * @returns the switch the panel should show and save.
 */
export function masterSwitchState(
  backend: string,
  enabled: boolean,
  installed?: boolean,
): { checked: boolean; locked: boolean } {
  const locked = backendById(backend) === undefined || installed === false
  return { checked: locked ? false : enabled, locked }
}

/**
 * Whether a selected backend rules out distilling a subagent session at all.
 *
 * A branch backend hands a rewrite over by forking the conversation, and the host writes a
 * delegation's parent relation when the child agent is created: a fork cannot adopt it, so a
 * hand-off that fired inside a subagent would end that child's turn without an answer while the
 * work continued in a session nobody awaits. A backend of that kind therefore pins both subagent
 * switches off — the engine refuses those kinds outright and the panel writes them off — and both
 * ask this one question so they cannot disagree.
 * @param backendId - the stored selection.
 * @returns true when this backend cannot serve a subagent session.
 */
export function branchBackendBlocksSubagents(backendId: string): boolean {
  return backendById(backendId)?.kind === 'branch'
}

/**
 * Build the request that asks the selected backend to write `text` into the
 * history, replacing the reasoning of the recorded target.
 * @param backendId - stored backend id.
 * @param sessionId - session that owns the rewrite.
 * @param entry - the recorded compression (surface seq and the reasoning block's index).
 * @param text - the distilled reasoning.
 * @returns the path and JSON body, or undefined when this backend cannot apply it.
 */
export function rewriteRequest(
  backendId: string,
  sessionId: string,
  entry: { targetSeq: number; targetBlockIndex: number },
  text: string,
): { path: string; body: Record<string, unknown> } | undefined {
  if (sessionId === '' || text === '') return undefined
  const backend = backendById(backendId)
  if (backend === undefined || backend.placeholder === true) return undefined
  if (backend.hostPatch === true) {
    if (entry.targetBlockIndex < 0) return undefined
    // Our own route: it looks the recorded message id up host-side, so the panel cannot aim the
    // rewrite at a message the ledger never named.
    return {
      path: REWRITE_ROUTE,
      body: { sessionId, eventSeq: entry.targetSeq, blockIndex: entry.targetBlockIndex, text },
    }
  }
  if (backend.kind === 'derive') {
    // The derived-message wrapper already applies the rewrite on every request; asking a backend
    // for a write here would be the one thing this mode exists to avoid.
    return undefined
  }
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
  // A backend this plugin can name but cannot yet drive: send nothing rather than guess at a
  // request. Implementing it means adding its own branch above.
  return undefined
}
