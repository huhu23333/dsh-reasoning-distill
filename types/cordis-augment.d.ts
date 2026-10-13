/**
 * Adds the one client service this plugin consumes whose declaration does not
 * resolve in an isolated checkout: the slot registry ships its Context
 * augmentation in a client-only entry that this package's exports map does not
 * expose here.
 *
 * This file must stay a *module* (it imports and re-exports nothing at runtime)
 * so the declaration merges with the real `@deepseek-ai/cordis` Context.
 * Declaring it in a script file would replace that interface outright and
 * silently hide members such as `effect`.
 * @module dsh-reasoning-distill/types/cordis-augment
 */

export {}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Slot registry service; the components themselves are host-owned. */
    readonly slots: {
      inject(name: string, body: () => unknown): unknown
      /**
       * Register a slot. `Props` is inferred from the component, so `inject` is
       * checked against what that component declares it receives.
       */
      register<Props>(definition: {
        name?: string
        id?: string
        order?: number
        locale?: string
        label?: () => string
        inject?: (target: string) => Props
      }, component: unknown): unknown
    }
  }
}
