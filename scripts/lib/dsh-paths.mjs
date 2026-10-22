/**
 * Where DSH is on THIS machine.
 *
 * One place answers the two questions every script in this repository asks: where the DSH home is
 * (and therefore where a profile and its installed plugins live), and where the DSH SOURCE checkout
 * is. Neither has a machine-specific default. The home follows the host's own DSH_HOME convention,
 * the profile follows DSH_PROFILE, and the checkout is DISCOVERED by structure: an explicit
 * --checkout, then the two environment variables this repository already uses, then the closest
 * checkout ancestor of the working directory, then the same walk from the directory the host's own
 * session package resolves to. A script that finds nothing reports every candidate it tried instead
 * of guessing — patching or reading the wrong tree is the one mistake these scripts must not make
 * quietly.
 * @module dsh-reasoning-distill/scripts/lib/dsh-paths
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** A file every DSH source checkout has; a checkout is recognized by structure, not by path. */
export const CHECKOUT_MARKER = 'packages/core/session/src/surface.ts'

/**
 * The DSH home, following the host's own convention.
 * @param env - environment to read; defaults to this process's.
 * @returns the home directory holding profiles and sessions.
 */
export function dshHome(env = process.env) {
  return env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * The profile name, following the host's own convention.
 * @param env - environment to read; defaults to this process's.
 * @returns the profile name.
 */
export function dshProfile(env = process.env) {
  return env.DSH_PROFILE ?? 'web'
}

/**
 * One plugin as the profile installs it (or links it).
 * @param plugin - package name inside the profile's node_modules.
 * @param env - environment to read; defaults to this process's.
 * @returns the absolute path the profile resolves that package from.
 */
export function profilePluginDir(plugin, env = process.env) {
  return join(dshHome(env), 'profiles', dshProfile(env), 'node_modules', plugin)
}

/** Whether one directory is a DSH source checkout these scripts can read. */
export function isCheckout(dir) {
  return existsSync(join(dir, CHECKOUT_MARKER))
}

/**
 * Whether one directory is a PACKAGED DSH install rather than a source checkout.
 *
 * Desktop and other bundled builds materialize a dependency closure (node_modules) with no source
 * tree, usually somewhere read-only. The in-place backend patches host source, so such an install
 * can never carry it; recognizing the shape lets a script say that instead of printing a candidate
 * list that reads like a wrong-directory problem.
 * @param dir - candidate directory.
 * @returns whether it looks like a packaged install.
 */
export function isPackagedHarness(dir) {
  return existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh')) && !isCheckout(dir)
}

/**
 * A sentence naming the first packaged install among the candidates, when there is one.
 *
 * The in-place backend needs a writable DSH source tree; no `--checkout` can turn a bundled build
 * into one. Saying so turns "no checkout found" from a path problem into the real answer.
 * @param candidates - directories that were tried, in order.
 * @returns the note line (no trailing newline), or the empty string.
 */
export function packagedInstallNote(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && isPackagedHarness(candidate)) {
      return 'note: ' + candidate + ' is a packaged DSH install (node_modules only, no source tree);'
        + ' the in-place backend needs a writable source checkout and cannot be installed there — use the no-write (derive) backend instead'
    }
  }
  return ''
}

/** Walk from a starting directory towards the filesystem root, returning the first checkout. */
export function walkUp(start) {
  let dir = resolve(start)
  for (;;) {
    if (isCheckout(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * The directory the host's own session package resolves to, when it resolves at all.
 * @param cwd - directory to resolve from.
 * @returns the package directory, or undefined when it does not resolve there.
 */
function resolvedSessionDir(cwd) {
  try {
    const require = createRequire(join(cwd, 'package.json'))
    return dirname(require.resolve('@deepseek-ai/dsh-session/package.json'))
  } catch {
    return undefined
  }
}

/**
 * Locate the DSH source checkout to read or patch.
 *
 * Every candidate is walked up to its first checkout ancestor, so a checkout root and any directory
 * inside one resolve to the same tree.
 * @param options - explicit path, working directory and environment.
 * @returns the checkout root and where it came from, or the candidates that were tried.
 */
export function locateCheckout({ explicit, cwd = process.cwd(), env = process.env } = {}) {
  const candidates = []
  if (explicit !== undefined) candidates.push(['--checkout', explicit])
  if (env.DSH_HOST_CHECKOUT) candidates.push(['$DSH_HOST_CHECKOUT', env.DSH_HOST_CHECKOUT])
  if (env.DSH_CHECKOUT) candidates.push(['$DSH_CHECKOUT', env.DSH_CHECKOUT])
  candidates.push(['the working directory', cwd])
  const fromPackage = resolvedSessionDir(cwd)
  if (fromPackage !== undefined) candidates.push(['@deepseek-ai/dsh-session', fromPackage])
  const tried = candidates.map(([source, candidate]) => source + ' = ' + candidate)
  for (const [source, candidate] of candidates) {
    const root = walkUp(candidate)
    if (root !== undefined) return { root, source, tried }
  }
  return { root: undefined, source: undefined, tried }
}

/**
 * Locate the checkout, or fail saying exactly what was tried.
 * @param options - see {@link locateCheckout}.
 * @returns the located checkout.
 * @throws when no checkout can be found.
 */
export function requireCheckout(options = {}) {
  const located = locateCheckout(options)
  if (located.root !== undefined) return located
  const env = options.env ?? process.env
  const note = packagedInstallNote([options.explicit, env.DSH_HOST_CHECKOUT, env.DSH_CHECKOUT, options.cwd ?? process.cwd()])
  throw new Error('no DSH source checkout found; pass --checkout <dir>'
    + (note === '' ? '' : '\n  ' + note)
    + ' (tried:\n  ' + located.tried.join('\n  ') + ')')
}

/**
 * The value of one CLI flag.
 * @param argv - argument vector.
 * @param flag - flag name, e.g. \`--checkout\`.
 * @returns the value, or undefined when the flag is absent or carries none.
 */
export function argOf(argv, flag) {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : undefined
}

/**
 * The checkout named by \`--checkout\`, or the discovered one.
 * @param argv - argument vector.
 * @param env - environment to read.
 * @returns the located checkout.
 * @throws when no checkout can be found.
 */
export function checkoutFromArgv(argv, env = process.env) {
  const explicit = argOf(argv, '--checkout')
  if (argv.includes('--checkout') && (explicit === undefined || explicit.trim() === '')) {
    throw new Error('--checkout requires a directory path')
  }
  return requireCheckout({ explicit, env })
}
