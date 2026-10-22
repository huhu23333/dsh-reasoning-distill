/**
 * Reasoning Distill, node half.
 *
 * Distills oversized reasoning into its useful core and replays the distilled
 * text on every later request, paying one cache-prefix break for a permanently
 * smaller history. The Settings page and the conversation report tab ship in
 * the browser half (`exports["./client"]`).
 * @module dsh-reasoning-distill
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: these packages declare the `settings` and `sessionPersistence`
// services this plugin consumes.
import type {} from '@deepseek-ai/dsh-session-persistence'

import { Config, resolveRule } from './config.ts'
import type { Config as PluginConfig } from './config.ts'
import { ReasoningDistillEngine } from './engine.ts'
import { InstallRunner, installerScript, scriptedSpawner } from './install.ts'
import { configureWhaleProfile } from './peak.ts'
import { registerRoutes } from './route.ts'
import { SETTINGS_NS } from './shared.ts'
import { SidecarStore } from './store.ts'

export { Config } from './config.ts'
export type { Config as ReasoningDistillConfig } from './config.ts'

/** Stable Cordis plugin name. */
export const name = 'reasoning-distill'

/** Services required before the engine can observe sessions. */
export const inject = ['sessions', 'llm', 'sessionPersistence']

/**
 * The plugin entries the profile has active, or undefined when they cannot be read.
 *
 * Installing or removing a companion backend rewrites the profile manifest, and only its bundle
 * list says whether that plugin is *loaded*: a package left in `dependencies` after being disabled
 * is installed but serves no route.
 *
 * The launcher's own profile context is the only source consulted. `DSH_PROFILE` is exported into
 * shell tools and not into this process, so an environment lookup would read whatever profile the
 * surrounding shell happened to name rather than the one being served — and this check only ever
 * closes a switch the user set. Everything unreadable — no profile, no manifest, no bundle list —
 * is reported as unknown rather than as absent.
 * @param ctx - host context.
 * @returns the active plugin entries, or undefined.
 */
async function activePlugins(ctx: Context): Promise<readonly string[] | undefined> {
  const profile = (ctx as unknown as { get(key: string): unknown }).get('profileContext') as { dir?: unknown } | undefined
  if (typeof profile?.dir !== 'string' || profile.dir === '') return undefined
  try {
    const { readFile } = await import('node:fs/promises')
    const manifest: unknown = JSON.parse(await readFile(`${profile.dir}/package.json`, 'utf8'))
    const bundles = (manifest as { dsh?: { profile?: { bundles?: unknown } } })?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return undefined
    return bundles.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    return undefined
  }
}

/**
 * Plugin body.
 * @param ctx - host context.
 * @param config - validated {@link PluginConfig}.
 */
export function apply(ctx: Context, config: PluginConfig): void {
  // Static injection orders startup; this guard also gives direct callers an
  // actionable error instead of starting without the store the report reads.
  if (ctx.get('sessionPersistence') === undefined) throw new Error('reasoning-distill requires the sessionPersistence service; install and enable a session-persistence backend before loading this plugin')
  const store = new SidecarStore()
  // The host owns archiving, so a hand-off hides the conversation it replaced whether or
  // not a panel happens to be looking at it. Resolved lazily: a host without the
  // workspace registry still gets every other feature.
  const archive = async (sessionId: string): Promise<void> => {
    const registry = (ctx as unknown as { get(key: string): unknown }).get('workspaceRegistry') as
      { archiveSession(id: unknown, options?: { stopActivity?: boolean }): Promise<void> } | undefined
    if (registry === undefined) throw new Error('the workspace registry is unavailable')
    await registry.archiveSession(sessionId)
  }
  const engine = new ReasoningDistillEngine(ctx, config, store, archive, () => activePlugins(ctx))
  engine.start()
  // The running profile is a host fact the child installer and the whale lookup
  // both need. DSH_PROFILE is exported into shell tools, not into this process,
  // so reading it from the environment would target the wrong profile.
  const profile = (ctx as unknown as { get(key: string): unknown }).get('profileContext') as
    { name?: unknown; dir?: unknown; cwd?: unknown; patchPath?: unknown } | undefined
  const profileName = typeof profile?.name === 'string' && profile.name !== '' ? profile.name : undefined
  const profileDir = typeof profile?.dir === 'string' && profile.dir !== '' ? profile.dir : undefined
  configureWhaleProfile(profileDir)
  const installEnv: NodeJS.ProcessEnv = { ...process.env }
  if (profileName !== undefined) installEnv['DSH_PROFILE'] = profileName
  if (profileDir !== undefined) {
    installEnv['DSH_PROFILE_DIR'] = profileDir
    installEnv['DSH_PLUGIN_ROOTS'] ??= `${profileDir}/node_modules`
  }
  // One installer at a time, in this process: the quick-install page can be closed and
  // reopened without losing progress, and cancellation is a kill.
  const runner = new InstallRunner(scriptedSpawner(installerScript(), {
    cwd: typeof profile?.cwd === 'string' && profile.cwd !== '' ? profile.cwd : process.cwd(),
    env: installEnv,
  }))
  registerRoutes(ctx, config, store, engine, runner)
  ctx.effect(() => () => { runner.cancel() })
  // This plugin ships its own Settings page, so the generic schema form is off.
  // The settings service is part of the host shell and ships no standalone types
  // in this checkout, so the dependency and the shape it exposes are stated here.
  const injectSettings = (ctx as unknown as {
    inject(deps: string[], callback: (child: Context) => void): unknown
  }).inject.bind(ctx)
  injectSettings(['settings'], (child) => {
    // `effect` requires a disposable, so the unavailable host type is stated as
    // the shape it actually returns.
    const settings = (child as unknown as {
      settings: {
        configure(options: { auto: boolean }, fiber: unknown): () => void
        update?(ns: string, patch: object): Promise<void>
      }
    }).settings
    child.effect(() => settings.configure({ auto: false }, ctx.fiber), 'reasoning-distill: settings page')
    // The host half owns the document the panel edits, so a backend that is gone is cleared the
    // same way the panel clears it. A host without `update` keeps the report-only path.
    const update = settings.update
    if (update !== undefined) {
      engine.useSettingsWriter(async fixup => { await update.call(settings, SETTINGS_NS, fixup) })
    }
  })
  ctx.logger.info('reasoning-distill: watching reasoning over %d estimated tokens', resolveRule('', config).thresholdTokens)
}
