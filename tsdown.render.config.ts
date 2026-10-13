/**
 * Test-only build: server-renders the client components with react-dom/server.
 *
 * A render-time throw blanks the whole tab, and that has silently happened twice
 * in this plugin, so the render paths are exercised instead of only type-checked.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'

const ID = 'dsh-reasoning-distill'
const CSS_VIRTUAL_PREFIX = '\0rd-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Same stylesheet handling as the shipped client build, minus the DOM injector. */
function cssModules() {
  return {
    name: 'rd-css-modules-render',
    resolveId(source: string, importer?: string) {
      if (!source.endsWith('.module.css')) return null
      const absolute = importer === undefined ? source : resolve(dirname(importer), source)
      return CSS_VIRTUAL_PREFIX + absolute + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const { exports: cssExports } = transform({
        filename: fileId,
        code: await readFile(fileId),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exported] of Object.entries(cssExports ?? {})) classMap[local] = exported.name
      return `export default ${JSON.stringify(classMap)};`
    },
  }
}

export default {
  name: `${ID}/render-test`,
  entry: { render: 'test/render.tsx' },
  outDir: 'test/dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  alias: {
    '@deepseek-ai/dsh-client-ui-primitives': resolve('test/stubs/ui-primitives.tsx'),
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [cssModules()],
}
