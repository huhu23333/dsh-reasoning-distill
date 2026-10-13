/**
 * Offline smoke-test bundle: bundles `test/smoke.ts` with the two host packages
 * aliased to local stubs, so the engine can run under plain Node without the
 * DSH runtime. Test-only; never shipped.
 * @module dsh-reasoning-distill/tsdown.smoke.config
 */

const ID = 'dsh-reasoning-distill'

/** Absolute stub paths: rolldown's `alias` resolves relative targets ambiguously. */
const here = import.meta.dirname
const stub = (name: string): string => `${here}/test/stubs/${name}`

export default {
  name: `${ID}/smoke`,
  entry: { smoke: 'test/smoke.ts', 'probe-whale': 'test/probe-whale.ts', 'probe-store': 'test/probe-store.ts' },
  outDir: 'test/dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  sourcemap: false,
  alias: {
    '@deepseek-ai/dsh-llm': stub('dsh-llm.ts'),
    '@deepseek-ai/schemastery': stub('schemastery.ts'),
  },
  deps: {
    neverBundle: (specifier) => specifier.startsWith('node:'),
    alwaysBundle: (specifier) => !specifier.startsWith('node:'),
  },
}
