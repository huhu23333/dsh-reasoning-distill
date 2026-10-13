import type { Context } from '@deepseek-ai/cordis'
import type { SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { ReasoningDistillSettings } from './Settings.tsx'
import { CompressionActivity } from './ActivityChip.tsx'
import { ReasoningDistillView } from './View.tsx'
import { en, NS, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    reasoningDistill: keyof typeof zh
  }
}

export const inject = ['slots', 'locale', 'configForms', 'uiWorkspace']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const t = ctx.locale.bind(NS)
  // The host's client-side form type is not resolvable here, so the shape this
  // panel consumes is stated explicitly.
  const form = ctx.configForms.get('reasoning-distill') as {
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
  // Free single seat beside the submit button: the one place a user already
  // looks when a request seems stuck, so the wait can name itself there.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'reasoning-distill', order: 30,
    locale: NS, label: () => t('view.tab'),
    inject: () => ({ openSession: (id: string) => ctx.uiWorkspace.openSession(id as SessionTarget) }),
  }, ReasoningDistillView))
}
