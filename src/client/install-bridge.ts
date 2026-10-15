/**
 * The little seam between the Settings panel and the shell's navigation.
 *
 * The panel is a Settings slot component and receives only its slot props, so the two
 * capabilities the agent route needs — listing Workspaces and starting a new Session
 * with a seeded draft — are published here by the client entry. Tests configure the
 * same seam, which is why the panel never reaches for a Context itself.
 * @module dsh-reasoning-distill/client/install-bridge
 */

/** One Workspace the user can send the agent into. */
export interface InstallWorkspace {
  id: string
  label: string
}

/** What the panel needs from the shell. */
export interface InstallBridge {
  /**
   * Open a new Session in one Workspace with `prompt` seeded into its composer.
   *
   * The user still decides whether to send: this only fills the box.
   * @param workspaceId - Workspace to start the Session in.
   * @param prompt - text to seed the composer with.
   */
  startSession(workspaceId: string, prompt: string): void
  /** Workspaces currently known, in shell order. */
  workspaces(): readonly InstallWorkspace[]
}

let bridge: InstallBridge | undefined

/**
 * Publish (or clear) the shell capabilities.
 * @param next - the bridge, or undefined while the plugin is not applied.
 */
export function configureInstallBridge(next: InstallBridge | undefined): void {
  bridge = next
}

/** The published bridge, when the shell provides one. */
export function currentInstallBridge(): InstallBridge | undefined {
  return bridge
}
