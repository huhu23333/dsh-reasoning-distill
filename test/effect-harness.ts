import React from 'react'

/** Run just the view's top-level hooks; no DOM, timer, or React renderer. */
export function effectHarness(render: () => unknown): { tick: () => Promise<void>; remount: () => Promise<void>; stop: () => void } {
  const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } } }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const original = internals.ReactCurrentDispatcher.current
  let cells: unknown[] = []
  let cursor = 0
  let dirty = true
  let effects: Array<{ slot: number; fn: () => void | (() => void); deps: unknown[] }> = []
  let cleanups = new Map<number, () => void>()
  const dispatcher = {
    useState(initial: unknown) {
      const slot = cursor++
      if (!(slot in cells)) cells[slot] = initial
      return [cells[slot], (next: unknown) => {
        cells[slot] = typeof next === 'function' ? (next as (old: unknown) => unknown)(cells[slot]) : next
        dirty = true
      }]
    },
    useRef(initial: unknown) {
      const slot = cursor++
      if (!(slot in cells)) cells[slot] = { current: initial }
      return cells[slot]
    },
    useCallback(fn: unknown) { cursor++; return fn },
    useEffect(fn: () => void | (() => void), deps: unknown[]) { effects.push({ slot: cursor++, fn, deps }) },
  }
  async function tick(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      if (dirty) {
        dirty = false
        cursor = 0
        effects = []
        internals.ReactCurrentDispatcher.current = dispatcher
        try { render() } finally { internals.ReactCurrentDispatcher.current = original }
        for (const { slot, fn, deps } of effects) {
          const previous = cells[slot] as unknown[] | undefined
          if (previous && deps?.every((value, index) => Object.is(value, previous[index]))) continue
          cleanups.get(slot)?.()
          const cleanup = fn()
          if (cleanup) cleanups.set(slot, cleanup)
          cells[slot] = deps
        }
      }
      await Promise.resolve()
      await Promise.resolve()
    }
  }
  return {
    tick,
    remount: async () => { for (const cleanup of cleanups.values()) cleanup(); cleanups.clear(); cells = []; dirty = true; await tick() },
    stop: () => { for (const cleanup of cleanups.values()) cleanup(); internals.ReactCurrentDispatcher.current = original },
  }
}
