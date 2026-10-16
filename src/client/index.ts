import type { Context } from '@deepseek-ai/cordis'
import type { SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { SETTINGS_NS } from '../shared.ts'
import { ReasoningDistillSettings } from './Settings.tsx'
import { CompressionActivity } from './ActivityChip.tsx'
import { ReasoningDistillView } from './View.tsx'
import { configureInstallBridge } from './install-bridge.ts'
import { refreshTranscript, type RefreshableSession } from './transcript.ts'
import { en, NS, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    reasoningDistill: keyof typeof zh
  }
}

export const inject = ['slots', 'locale', 'configForms', 'uiWorkspace']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  // The Settings panel is a slot component and cannot reach the shell itself, so the
  // two capabilities its quick-install page needs are published here. The bridge is
  // cleared again on disposal, so the panel never promises what it cannot do.
  configureInstallBridge({
    startSession: (workspaceId, prompt) => {
      ctx.uiWorkspace.startSession(workspaceId as Parameters<typeof ctx.uiWorkspace.startSession>[0], { prompt })
    },
    workspaces: () => {
      // The Workspace controller is a client service without published types here, so
      // the shape read from it is stated explicitly and mapped defensively: the page
      // only needs an id and something readable.
      const service = (ctx as unknown as { get(key: string): unknown }).get('workspaces') as
        { list?: { getSnapshot(): { items?: readonly Record<string, unknown>[] } } } | undefined
      const items = service?.list?.getSnapshot().items ?? []
      return items.map((item, index) => ({
        id: typeof item['workspaceId'] === 'string' ? item['workspaceId'] : String(item['id'] ?? index),
        label: typeof item['title'] === 'string' && item['title'] !== ''
          ? item['title']
          : String(item['path'] ?? item['workspaceId'] ?? `workspace ${String(index + 1)}`),
      }))
    },
  })
  ctx.effect(() => () => { configureInstallBridge(undefined) })
  const t = ctx.locale.bind(NS)
  // The host's client-side form type is not resolvable here, so the shape this
  // panel consumes is stated explicitly. The namespace is the same one the host
  // writes through, so both halves edit one document.
  const form = ctx.configForms.get(SETTINGS_NS) as {
    getSnapshot(): unknown
    subscribe(listener: () => void): () => void
    mutate(ops: never, revision?: number): unknown
  }
  // `useSyncExternalStore` takes `subscribe` and `getSnapshot` as bare
  // references, and the controller's methods are prototype methods that read
  // `this`. Unbound, React calls them with an undefined receiver, which throws
  // during render and leaves the settings section blank.
  const formFace = {
    getSnapshot: () => form.getSnapshot(),
    subscribe: (listener: () => void) => form.subscribe(listener),
    mutate: (ops: never, revision?: number) => form.mutate(ops, revision),
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'reasoning-distill', order: 40,
    label: () => t('settings.nav'), locale: NS,
    inject: () => ({ form: formFace }),
  }, ReasoningDistillSettings))
  // The composer seat already exists and is the one place a user looks when the
  // conversation seems stuck, so the wait names itself there.
  /**
   * Ask the shell to rebuild one conversation's history window.
   *
   * An in-place rewrite keeps every seq and appends nothing, so an already-open view keeps
   * rendering the superseded reasoning until something reads the session again. The client Session
   * that owns that window can rebuild it from the host, and it is the very object the conversation
   * renders from: borrowing it through the published `sessions.retain` reference and asking it to
   * rebuild updates the transcript in place. The reference is released immediately — the open view
   * holds its own, so this one exists only for the call.
   *
   * The rebuild entry point is feature-detected (see `refreshTranscript`), and the client service
   * shape is stated here because this plugin has no published types for it. A shell that offers
   * neither keeps today's behaviour: the rewritten text appears on the next read.
   * @param sessionId - conversation whose window may be stale.
   */
  const rebuildTranscript = (sessionId: string): void => {
    const sessions = (ctx as unknown as { get(key: string): unknown }).get('sessions') as {
      retain?(target: string, options: { source: string }): {
        binding?: { session?: unknown }
        release?(): void
      } | undefined
    } | undefined
    let reference: { binding?: { session?: unknown }; release?(): void } | undefined
    try {
      reference = sessions?.retain?.(sessionId, { source: 'reasoning-distill' })
    } catch {
      // An id the client cannot resolve is not an error worth surfacing: nothing was written
      // wrongly, the view simply keeps what it had until the next read.
      return
    }
    if (reference === undefined) return
    try {
      refreshTranscript(reference.binding?.session as RefreshableSession | undefined)
    } finally {
      reference.release?.()
    }
  }
  ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
    name: 'conversation.input.activity', id: 'reasoning-distill', order: 30,
    locale: NS,
    // This seat is mounted whenever a conversation is open, so it is the follower
    // that can switch conversations after a hand-off the engine made at idle; the
    // report panel is only mounted while the user looks at it.
    inject: (sessionId) => ({
      sessionId,
      openSession: (id: string) => ctx.uiWorkspace.openSession(id as SessionTarget),
      archiveSession: (id: string) => {
        void ctx.uiWorkspace.archiveSession(id as Parameters<typeof ctx.uiWorkspace.archiveSession>[0])
      },
      refreshTranscript: rebuildTranscript,
    }),
  }, CompressionActivity))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'reasoning-distill', order: 30,
    locale: NS, label: () => t('view.tab'),
    inject: () => ({
      openSession: (id: string) => ctx.uiWorkspace.openSession(id as SessionTarget),
      refreshTranscript: rebuildTranscript,
    }),
  }, ReasoningDistillView))
}
