/**
 * Host↔browser transport: two exact Fetch routes on the shared `/api` channel.
 * @module dsh-reasoning-distill/route
 */

import type { Context } from '@deepseek-ai/cordis'

import type { Config } from './config.ts'
import { buildCatalog, buildReport } from './report.ts'
import type { ActiveCompression, BlockingReason } from './shared.ts'
import type { SidecarStore } from './store.ts'
import { CATALOG_ROUTE, HANDOFF_ROUTE, REPORT_ROUTE } from './shared.ts'

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
      branch: { sessionId: string; entryId: string } | null
      branchError: string | null
    }
    stock(sessionId: string): { tokens: number; saved: number; ids: string[] } | undefined
    handoff(sessionId: string, cancel?: boolean): boolean
  },
): void {
  ctx.inject(['connection', 'sessions', 'llm'], (child) => {
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
          return json(buildReport(sessionId, record, config, {
            ...engine.snapshot(sessionId),
            // The engine alone can say which rewrites still replace reasoning in
            // the prompt a request would carry now.
            stock: engine.stock(sessionId),
            isLive: (id: string) => sessions?.get(id) !== undefined,
          }))
        } catch (error: unknown) {
          // A sidecar that cannot be read is reported, never overwritten: the
          // panel says so instead of appearing empty.
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'reasoning-distill: report route')

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
          const body = await request.json() as { sessionId?: unknown; cancel?: unknown }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          if (sessionId === '') return json({ error: 'sessionId is required' }, 400)
          // In-place backends rewrite the history the turn keeps using, so their
          // hand-off clears the pending flag without stopping the conversation.
          return json({ ok: engine.handoff(sessionId, body.cancel !== false) })
        } catch (error: unknown) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'reasoning-distill: handoff route')
  })
}
