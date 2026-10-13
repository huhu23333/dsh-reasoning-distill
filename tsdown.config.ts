/**
 * Out-of-tree client bundle for this plugin.
 *
 * The monorepo's own `clientBundle()` preset cannot build a package outside
 * `packages/* / *` (it locates the manifest by globbing the repository), so this
 * config restates the two contracts that actually matter:
 *
 *  1. the `window.__ModuleLoader__.load({ id, factory })` closure handoff, with
 *     externals resolved through the injected `require` (the loader module table);
 *  2. the lightningcss pass that turns `x.module.css` into a hashed class map plus
 *     a tagged `<style>` injection that runs inside the factory closure.
 *
 * Everything else — host-half emit, dependency rules — follows the shipped preset.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'

/** Plugin id, stamped into the module-loader handoff and the injected style tags. */
const ID = 'dsh-reasoning-distill'

/**
 * Host module-table rows this bundle may import: the browser platform seed
 * (`PLATFORM_MODULES` in packages/client/web/src/platform.ts). The vendored
 * renderer needs `react`, `react-dom` (portal) and the primitives kit — all seed
 * rows — so this plugin requests no extra module-table entries.
 */
const PLATFORM_MODULE = /^(?:react|react\/jsx-runtime|react-dom|react-dom\/client|@deepseek-ai\/cordis|@deepseek-ai\/dsh-client-store|@deepseek-ai\/dsh-client-ui-slots|@deepseek-ai\/dsh-client-ui-primitives|@deepseek-ai\/dsh-client-ui-dockkit)$/

/** Virtual-id wrapper keeping module CSS clear of tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0rd-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/**
 * Emit one plugin-owned style injector plus the CSS Modules class map.
 * @param fileId - physical stylesheet path.
 * @param css - compiled stylesheet text.
 * @param classMap - local name to hashed class name.
 * @returns the generated module source.
 */
function styleInjectionModule(fileId, css, classMap) {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${ID}/${basename(fileId)}`)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/** Compile `*.module.css` through lightningcss, mirroring the shipped preset. */
function cssModules() {
  return {
    name: 'rd-css-modules',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css')) return null
      const absolute = importer === undefined ? source : resolve(dirname(importer), source)
      return CSS_VIRTUAL_PREFIX + absolute + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // The virtual id otherwise hides the physical sheet from the watch graph.
      this.addWatchFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: await readFile(fileId),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = {}
      for (const [local, exported] of Object.entries(cssExports ?? {})) {
        classMap[local] = exported.name
      }
      return styleInjectionModule(fileId, code.toString(), classMap)
    },
  }
}

/** Node half: the empty apply that puts this plugin in the host Loader. */
const hostHalf = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

/** Browser half: the closure-factory artifact the Web client's loader executes. */
const clientHalf = {
  name: `${ID}/client`,
  entry: { index: 'src/client/index.ts' },
  outDir: 'lib/client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: (specifier) => PLATFORM_MODULE.test(specifier),
    // A require() the loader table cannot answer is a guaranteed runtime throw,
    // so anything outside the seed inlines.
    alwaysBundle: (specifier) => !PLATFORM_MODULE.test(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  plugins: [cssModules()],
  outputOptions: {
    entryFileNames: 'index.js',
    banner: (chunk) => `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [hostHalf, clientHalf]
