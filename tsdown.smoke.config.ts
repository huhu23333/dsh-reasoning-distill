/**
 * Offline smoke-test bundle: bundles `test/smoke.ts` with the host packages it
 * touches aliased to local stubs, so the engine can run under plain Node without the
 * DSH runtime. Test-only; never shipped.
 * @module dsh-reasoning-distill/tsdown.smoke.config
 */

const ID = 'dsh-reasoning-distill'

/** Absolute stub paths: rolldown's `alias` resolves relative targets ambiguously. */
const here = import.meta.dirname
const stub = (name: string): string => `${here}/test/stubs/${name}`

export default {
  name: `${ID}/smoke`,
  entry: { smoke: 'test/smoke.ts' },
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
    // The session package is aliased too: the host-patch self-check imports the class at runtime,
    // and without a stub the bundle would pull the real host build (and its cordis graph) in.
    '@deepseek-ai/dsh-session': stub('dsh-session.ts'),
    '@deepseek-ai/schemastery': stub('schemastery.ts'),
  },
  deps: {
    neverBundle: (specifier) => specifier.startsWith('node:'),
    alwaysBundle: (specifier) => !specifier.startsWith('node:'),
  },
}
