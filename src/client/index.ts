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
    }),
  }, CompressionActivity))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'reasoning-distill', order: 30,
    locale: NS, label: () => t('view.tab'),
    inject: () => ({ openSession: (id: string) => ctx.uiWorkspace.openSession(id as SessionTarget) }),
  }, ReasoningDistillView))
}
