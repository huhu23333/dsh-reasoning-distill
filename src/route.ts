/**
 * Host↔browser transport: two exact Fetch routes on the shared `/api` channel.
 * @module dsh-reasoning-distill/route
 */

import type { Context } from '@deepseek-ai/cordis'

import type { Config } from './config.ts'
import { buildCatalog, buildReport } from './report.ts'
import type { ActiveCompression, BlockingReason } from './shared.ts'
import type { SidecarStore } from './store.ts'
import { CATALOG_ROUTE, HANDOFF_ROUTE, INSTALL_ROUTE, REPORT_ROUTE } from './shared.ts'
import { INSTALLABLE_BACKENDS, INSTALL_STEPS, installableBackend } from './install-shared.ts'
import { pluginRoot, type InstallRunner } from './install.ts'

/** Minimal shape of the Connection fetch registry this plugin consumes. */
interface FetchRouteRegistrar {
  register(route: {
    path: string
    methods: readonly ('GET' | 'HEAD' | 'POST')[]
    requestBody: 'buffered' | 'streaming'
    fetch: (request: Request) => Promise<Response>
  }): () => Promise<void>
}

/** One JSON reply for a route handler. */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * Register this plugin's Fetch routes.
 * @param ctx - host context.
 * @param config - live plugin configuration.
 * @param store - sidecar store.
 */
export function registerRoutes(
  ctx: Context,
  config: Config,
  store: SidecarStore,
  engine: {
    snapshot(sessionId: string): {
      active: ActiveCompression[]
      blockingSince: number | null
      blockingReason: BlockingReason | null
      pendingBranch: string | null
      generation: number
    }
    stock(sessionId: string): { tokens: number; saved: number; ids: string[] } | undefined
    handoff(sessionId: string, cancel?: boolean, error?: string, entryId?: string, generation?: number): Promise<{ ok: boolean; recorded: boolean }>
  },
  runner: InstallRunner,
): void {
  ctx.inject(['connection', 'sessions', 'llm', 'sessionPersistence'], (child) => {
    const connection = child.get('connection') as { fetch?: FetchRouteRegistrar } | undefined
    const register = connection?.fetch?.register?.bind(connection.fetch)
    if (register === undefined) {
      ctx.logger.warn('reasoning-distill: connection.fetch is unavailable; the report tab will stay empty')
      return
    }
    child.effect(() => register({
      path: REPORT_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        let sessionId = ''
        try {
          const body = await request.json() as { sessionId?: unknown }
          if (typeof body.sessionId === 'string') sessionId = body.sessionId
        } catch {
          return json({ error: 'invalid body' }, 400)
        }
        if (sessionId === '') return json({ error: 'sessionId is required' }, 400)
        // The panel only ever asks about its own session; refusing unknown ids
        // keeps this route from serving another session's private reasoning to a
        // caller that guesses or enumerates ids.
        const sessions = child.get('sessions') as { get(id: string): unknown } | undefined
        if (sessions?.get(sessionId) === undefined) return json({ error: 'unknown session' }, 404)
        try {
          const record = await store.load(sessionId)
          const persistence = child.get('sessionPersistence') as { stat(id: string): Promise<unknown> }
          const linked = [...new Set(record.entries.map(entry => entry.distill.sessionId).filter(Boolean))]
          const availability = new Map(await Promise.all(linked.map(async id =>
            [id, sessions?.get(id) !== undefined || await persistence.stat(id) !== undefined] as const)))
          return json(buildReport(sessionId, record, config, {
            ...engine.snapshot(sessionId),
            // The engine alone can say which rewrites still replace reasoning in
            // the prompt a request would carry now.
            stock: engine.stock(sessionId),
            isLive: (id: string) => availability.get(id) === true,
          }))
        } catch (error: unknown) {
          // A sidecar that cannot be read is reported, never overwritten: the
          // panel says so instead of appearing empty.
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'reasoning-distill: report route')

    child.effect(() => register({
      path: INSTALL_ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        try {
          // GET is what a panel opening (or reopening) asks for: the job lives in the
          // host process, so closing the page never lost it.
          if (request.method === 'GET') {
            return json({
              job: runner.status() ?? null,
              backends: INSTALLABLE_BACKENDS,
              steps: INSTALL_STEPS,
              repo: pluginRoot(),
            })
          }
          const body = await request.json() as { action?: unknown; backendId?: unknown }
          if (body.action === 'cancel') return json({ cancelled: runner.cancel(), job: runner.status() ?? null })
          if (body.action !== 'start') return json({ error: 'action must be start or cancel' }, 400)
          const backendId = typeof body.backendId === 'string' ? body.backendId : ''
          const entry = installableBackend(backendId)
          // The route only refuses, so one backend cannot be "guessed at" by a stray request;
          // the in-place placeholder is not installable and lands here like any unknown id.
          if (entry === undefined) return json({ error: `unknown backend: ${backendId}` }, 400)
          const started = runner.start(backendId)
          if (!started.ok) return json({ error: started.error }, 409)
          return json({ job: started.job })
        } catch (error: unknown) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'reasoning-distill: install route')

    child.effect(() => register({
      path: CATALOG_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      // Exact Fetch routes have no dispatcher-level try/catch upstream, so a
      // rejection here would escape into the HTTP layer; every route answers.
      fetch: async (): Promise<Response> => {
       try {
        const llm = child.get('llm') as {
          listProviders(): readonly { id: string }[]
          listModels(provider: string): Promise<readonly { id: string; name?: string; contextWindow?: number }[]>
          resolveModelInfo(provider: string, model: string): Promise<{ reasoning?: { efforts: readonly { id: string }[]; defaultEffort?: string } }>
        }
        const providers = llm.listProviders().map(provider => provider.id)
        const catalog = await buildCatalog(
          providers,
          provider => llm.listModels(provider),
          async (provider, model) => {
            const info = await llm.resolveModelInfo(provider, model)
            return {
              reasoningEfforts: (info.reasoning?.efforts ?? []).map(effort => effort.id),
              ...info.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort },
            }
          },
        )
        return json(catalog)
       } catch (error: unknown) {
         return json({ error: error instanceof Error ? error.message : String(error) }, 500)
       }
      },
    }), 'reasoning-distill: catalog route')
    child.effect(() => register({
      path: HANDOFF_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      // The panel has written the distilled text into the history (a branch, or
      // the surface itself); the original turn is stopped here, host-side, the
      // same way the user's own stop button stops it.
      fetch: async (request: Request): Promise<Response> => {
        try {
          const body = await request.json() as { sessionId?: unknown; cancel?: unknown; error?: unknown; entryId?: unknown; generation?: unknown }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          if (sessionId === '') return json({ error: 'sessionId is required' }, 400)
          // In-place backends rewrite the history the turn keeps using, so their
          // hand-off clears the pending flag without stopping the conversation.
          const failure = typeof body.error === 'string' && body.error !== '' ? body.error : undefined
          const entryId = typeof body.entryId === 'string' && body.entryId !== '' ? body.entryId : undefined
          const generation = typeof body.generation === 'number' ? body.generation : undefined
          const settled = await engine.handoff(sessionId, body.cancel !== false, failure, entryId, generation)
          return json(settled)
        } catch (error: unknown) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'reasoning-distill: handoff route')
  })
}
