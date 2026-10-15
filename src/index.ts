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
import { registerRoutes } from './route.ts'
import { SidecarStore } from './store.ts'

export { Config } from './config.ts'
export type { Config as ReasoningDistillConfig } from './config.ts'

/** Stable Cordis plugin name. */
export const name = 'reasoning-distill'

/** Services required before the engine can observe sessions. */
export const inject = ['sessions', 'llm', 'sessionPersistence']

/**
 * Plugin body.
 * @param ctx - host context.
 * @param config - validated {@link PluginConfig}.
 */
export function apply(ctx: Context, config: PluginConfig): void {
  // Static injection orders startup; this guard also gives direct callers an
  // actionable error instead of silently leaving new audit sessions in RAM.
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('reasoning-distill requires the sessionPersistence service; install and enable a session-persistence backend before loading this plugin')
  const store = new SidecarStore()
  const engine = new ReasoningDistillEngine(ctx, config, store)
  engine.start()
  // One installer at a time, in this process: the quick-install page can be closed and
  // reopened without losing progress, and cancellation is a kill.
  const runner = new InstallRunner(scriptedSpawner(installerScript()))
  registerRoutes(ctx, config, store, engine, runner)
  ctx.effect(() => () => { runner.cancel() })
  // The handle owns this session's writer until disposal; registering this
  // callback synchronously prevents the first compression racing the writer.
  const handles: Array<{ close?: () => Promise<void> }> = []
  ctx.effect(() => async () => { for (const handle of handles.splice(0)) await handle.close?.() })
  engine.usePersistence(async (session) => {
    handles.push(await persistence.create(session.header))
  })
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
      settings: { configure(options: { auto: boolean }, fiber: unknown): () => void }
    }).settings
    child.effect(() => settings.configure({ auto: false }, ctx.fiber), 'reasoning-distill: settings page')
  })
  ctx.logger.info('reasoning-distill: watching reasoning over %d estimated tokens', resolveRule('', config).thresholdTokens)
}
