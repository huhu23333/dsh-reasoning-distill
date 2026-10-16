#!/usr/bin/env node
/**
 * The DSH host patch that makes an in-place reasoning rewrite possible.
 *
 * The plugin's in-place backend needs one thing the public surface contract cannot express:
 * replacing an earlier assistant message's block *inside the existing log entry*, keeping its
 * seq, its message id and the log length. This script owns the exact source edits that add it,
 * so the install step is reproducible and the removal step is byte-exact.
 *
 * Usage:
 *   node scripts/dsh-inplace-patch.mjs --check
 *   node scripts/dsh-inplace-patch.mjs --apply [--build]
 *   node scripts/dsh-inplace-patch.mjs --revert [--build]
 *
 * Options:
 *   --checkout <dir>  host checkout; when omitted it is DISCOVERED, never assumed
 *   --locate          print the discovered checkout and exit (0 found, 1 not found)
 *   --build           type-check/emit the patched packages; usable alone or with --apply/--revert
 *   --force           patch even when the target files have uncommitted changes
 *
 * Checkout discovery deliberately assumes nothing about where anyone installed DSH. In order:
 * --checkout, then $DSH_HOST_CHECKOUT, then $DSH_CHECKOUT, then the closest ancestor of the
 * working directory that looks like a DSH source checkout (it has packages/core/session/src/
 * surface.ts), then the same walk from the directory the host's own @deepseek-ai/dsh-session
 * resolves to. Nothing found is reported with everything that was tried.
 *
 * Every edit is a literal (before, after) pair. An edit counts as applied when the file carries
 * its 'after' text; it is missing when it carries the 'before' text; anything else is an anchor
 * that no longer matches, and the whole patch refuses rather than writing a partial edit.
 * @module dsh-reasoning-distill/scripts/dsh-inplace-patch
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The one place that knows how to find a DSH checkout on whatever machine this runs on.
import { locateCheckout } from './lib/dsh-paths.mjs'

/** Join lines into one literal block (a trailing empty line keeps the newline). */
const nl = (...lines) => lines.join('\n')

/**
 * The patched packages' tsconfig projects, in dependency order.
 *
 * None of these packages declares a build script of its own: the repository compiles its lib/
 * artifacts from one aggregate project. These project references are the narrowest thing that
 * type-checks and emits exactly the patched sources, and a checkout that runs from source — the
 * normal development path, node --import tsx/esm apps/cli/src/bin.ts — needs nothing else.
 */
const BUILD_PROJECTS = [
  'packages/core/session',
  'packages/session/session-persistence',
  'packages/session/session-persistence-jsonl',
]

/** First line of `append`'s doc comment; the inserted members go immediately before it. */
const APPEND_DOC_ANCHOR = [
  '  /**',
  '   * Append one typed event to the log and synchronously notify observers via',
  '',
].join('\n')

/** The members inserted into the Session class: the sink, its installer, and the rewrite. */
const SESSION_MEMBERS = [
  '  /**',
  '   * Sink for records replaced in place, installed by the owner of the stored artifact.',
  '   *',
  '   * An append-only feed cannot describe a replacement, so the persistence layer is handed a',
  '   * callback instead of an event. Absent for a detached session, which has no artifact to keep',
  '   * in step, which is why the seam is optional.',
  '   */',
  '  private rewriteSink: ((event: SessionEvent) => void) | undefined',
  '',
  '  /**',
  '   * Install (or clear) the durable sink for in-place record replacements.',
  '   * @param sink - called with each replaced event, or undefined to detach.',
  '   * @returns a disposer that clears the sink only while it is still the installed one.',
  '   */',
  '  setRewriteSink(sink: ((event: SessionEvent) => void) | undefined): () => void {',
  '    this.rewriteSink = sink',
  '    return () => {',
  '      if (this.rewriteSink === sink) this.rewriteSink = undefined',
  '    }',
  '  }',
  '',
  '  /**',
  "   * Replace one reasoning block of an earlier assistant message in place.",
  '   *',
  "   * The log keeps its length and the message keeps its identity: only the block's text",
  '   * changes, so derived history, the transcript and every later request see the replacement',
  "   * while tool calls, request headers, attempts and the session's lineage stay exactly as they",
  '   * were. The surface is refolded and the derived-message cache invalidated, so the change is',
  '   * visible immediately and the same edit is idempotent.',
  '   * @param request - target seq, the message id it must still carry, the block index, new text.',
  '   * @returns the replaced event, or the current one when the text already matches.',
  '   * @throws when the seq holds no assistant message, the id differs, the block is not',
  '   *   reasoning, or the text is empty.',
  '   */',
  '  rewriteReasoningBlock(request: {',
  '    seq: SessionSeq',
  '    messageId: string',
  '    blockIndex: number',
  '    text: string',
  "  }): SessionEvent<'assistant/message'> {",
  '    const current = this.log[request.seq]',
  '    if (current === undefined) {',
  '      throw new Error(`rewriteReasoningBlock: seq ${request.seq} is not in the log`)',
  '    }',
  "    if (current.type !== 'assistant/message') {",
  '      throw new Error(`rewriteReasoningBlock: seq ${request.seq} is a ${current.type}, not an assistant message`)',
  '    }',
  '    const message = current.data.message',
  '    if (message.id !== request.messageId) {',
  '      throw new Error(`rewriteReasoningBlock: seq ${request.seq} carries message ${message.id}, not ${request.messageId}`)',
  '    }',
  '    const block = message.content[request.blockIndex]',
  "    if (block?.type !== 'reasoning') {",
  '      throw new Error(`rewriteReasoningBlock: block ${request.blockIndex} of ${message.id} is not a reasoning block`)',
  '    }',
  "    if (request.text === '') throw new Error('rewriteReasoningBlock: text must be a non-empty string')",
  '    if (request.text === block.text) return current',
  '    const content = message.content.map((item, index) =>',
  "      index === request.blockIndex ? { type: 'reasoning' as const, text: request.text } : item)",
  '    const data = snapshotJsonValue({ ...current.data, message: { ...message, content } })',
  "    const next = deepFreeze({ ...current, data }) as SessionEvent<'assistant/message'>",
  '    validateSessionEventData(next, `rewritten assistant/message at seq ${next.seq}`)',
  '    this.log[request.seq] = next as SessionEvent',
  '    this.eventsSnapshot = undefined',
  '    this.surfaceManager.reset()',
  '    this.rewriteSink?.(next)',
  '    return next',
  '  }',
  '',
  '',
].join('\n')

/** Options the handle's in-place rewrite accepts. */
const PERSISTENCE_REWRITE_OPTIONS = [
  '/** Options for {@link SessionHandle.rewrite}. */',
  'export interface SessionHandleRewriteOptions {',
  '  /** Optional cancellation observed before the write starts. */',
  '  readonly signal?: AbortSignal',
  '}',
  '',
].join('\n')

/** The rewrite member added to the SessionHandle seam. */
const PERSISTENCE_REWRITE_MEMBER = [
  '  /**',
  '   * Replace stored records in place, at their own seqs.',
  '   *',
  '   * `append` only ever extends the end of the log, so it cannot express a rewrite: the',
  '   * length and every later seq stay exactly as they were. A backend that can update its',
  '   * artifact implements this; one that cannot leaves it undefined, and then an in-place log',
  '   * edit stays live-only instead of diverging silently from storage.',
  '   * @param events - the replacement records, each carrying the seq it replaces.',
  '   * @param options - optional cancellation observed before the write starts.',
  '   */',
  '  rewrite?(events: readonly SessionEvent[], options?: SessionHandleRewriteOptions): Promise<void>',
  '',
].join('\n')

/** The rewriteBatch declaration added to the provider-local storage seam. */
const HANDLE_REWRITE_BATCH_DECL = [
  '  /**',
  "   * Durably replace stored records in place, keeping the log's length and every seq.",
  '   *',
  '   * A jsonl artifact is a header line plus either plain lines or one Zstandard frame per',
  '   * append batch, so a record inside a frame cannot be edited without re-encoding from that',
  '   * frame boundary; the whole artifact is re-encoded and published atomically instead. The',
  '   * handle serializes this behind every pending append, so this read observes a stable file.',
  '   */',
  '  rewriteBatch(',
  '    header: SessionHeader,',
  '    events: readonly SessionEvent[],',
  '    inheritedEventCount: SessionLogOffset,',
  '  ): Promise<void>',
  '',
].join('\n')

/** The sink installer and durable rewrite added to the jsonl handle. */
const HANDLE_REWRITE_MEMBERS = [
  "  /** Sessions already wired to this handle's durable rewrite sink. */",
  '  private readonly watched = new WeakSet<Session>()',
  '',
  '  /**',
  "   * Install this handle's durable rewrite sink on one live session, once.",
  '   *',
  '   * Persistence owns the artifact and the session owns the log, so the only route a',
  '   * replacement can take into storage is a callback the owner hands the session. Wiring',
  '   * happens on the session first routed event: by then the write handle exists, and a',
  '   * rewrite can only ever target an event that has already been logged.',
  '   * @param session - the live session to keep in step.',
  '   * @param reportFailure - observes a rewrite that could not be stored.',
  '   */',
  '  watchRewrites(session: Session, reportFailure: (error: unknown) => void): void {',
  '    if (this.watched.has(session)) return',
  '    this.watched.add(session)',
  '    session.setRewriteSink(event => {',
  '      this.rewrite([event]).catch(reportFailure)',
  '    })',
  '  }',
  '',
  '  /**',
  '   * Durably replace records the live log already carries; see the seam contract.',
  '   * @param events - the replacement records, each carrying the seq it replaces.',
  '   * @param options - optional cancellation observed before the write starts.',
  '   */',
  '  async rewrite(events: readonly SessionEvent[], options?: SessionHandleRewriteOptions): Promise<void> {',
  "    this.assertOpen('rewrite')",
  '    if (events.length === 0) return',
  '    // Pending appends land first: the artifact is read back to replace a record in it, and a',
  '    // batch still in the routed buffer would be written after the replacement, restoring the',
  '    // old text.',
  '    await this.drainLive()',
  "    return this.run('rewrite', async () => {",
  '      options?.signal?.throwIfAborted()',
  '      await this.storage.rewriteBatch(this.header, events, this.state.inheritedEventCount)',
  '      // A write-open prefix is a snapshot of the artifact from before this replacement;',
  '      // dropping it makes later reads re-scan the file instead of serving the old record.',
  '      this.state.primed = undefined',
  '    })',
  '  }',
  '',
].join('\n')

/** The tracker live-routing hook, before and after the rewrite sink is installed. */
const TRACKER_INSTALL_BEFORE = [
  "    ctx.on('session/event', (session: Session, event) => {",
  '      this.writers.get(session.id)?.enqueueLive(event, (error) => {',
  '        ctx.logger.warn(`session-persistence: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`)',
  '      })',
  '    })',
  '',
].join('\n')
const TRACKER_INSTALL_AFTER = [
  "    ctx.on('session/event', (session: Session, event) => {",
  '      const writer = this.writers.get(session.id)',
  '      if (writer === undefined || writer === null) return',
  '      // The write handle exists before the session publishes its first event, which is the',
  '      // earliest point at which an in-place rewrite could be kept in step with the artifact.',
  '      writer.watchRewrites(session, (error) => {',
  '        ctx.logger.warn(`session-persistence: in-place rewrite for session "${session.id}" failed (artifact left unchanged): ${String(error)}`)',
  '      })',
  '      writer.enqueueLive(event, (error) => {',
  '        ctx.logger.warn(`session-persistence: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`)',
  '      })',
  '    })',
  '',
].join('\n')

/** The whole-artifact rewrite published by the jsonl service. */
const JSONL_REWRITE_BATCH = [
  '  /**',
  "   * Durably replace stored records in place, keeping the log's length and every seq.",
  '   *',
  '   * A jsonl artifact is a header line plus either plain lines or one Zstandard frame per',
  '   * append batch, so a record inside a frame cannot be edited without re-encoding from that',
  '   * frame boundary; the whole artifact is re-encoded and published atomically instead. The',
  '   * handle serializes this behind every pending append, so this read observes a stable file.',
  "   * @param header - the session's stored header.",
  '   * @param events - the replacement records, each carrying the seq it replaces.',
  '   * @param inheritedEventCount - exact fork-inherited prefix length written into the header line.',
  '   */',
  '  async rewriteBatch(',
  '    header: SessionHeader,',
  '    events: readonly SessionEvent[],',
  '    inheritedEventCount: SessionLogOffsetType,',
  '  ): Promise<void> {',
  '    this.coldLogMemo.delete(header.id)',
  '    await this.ensureRootEncoding()',
  '    const path = logPath(this.root, header.cwd, header.id, this.compression)',
  '    const stored = await this.readStoredLog(path, header.id)',
  '    const replacements = new Map(events.map(event => [event.seq, event]))',
  '    for (const seq of replacements.keys()) {',
  '      if (!stored.events.some(event => event.seq === seq)) {',
  '        throw new Error(`cannot rewrite "${header.id}": the stored log has no record at seq ${seq}`)',
  '      }',
  '    }',
  '    const content = await this.encodeMaterialization(',
  '      header,',
  '      inheritedEventCount,',
  '      stored.events.map(event => replacements.get(event.seq) ?? event),',
  '    )',
  '    const tmp = await this.writeSyncedTempFile(path, content)',
  '    try {',
  "      // rename() atomically supersedes the current generation; unlike materialize's link(),",
  '      // the artifact is expected to exist and is intentionally replaced.',
  '      await rename(tmp, path)',
  '    } catch (error) {',
  '      await rm(tmp, { force: true })',
  '      throw error',
  '    }',
  '    this.coldLogMemo.delete(header.id)',
  "    if (process.platform !== 'win32') await this.syncDirPosix(dirname(path))",
  '  }',
  '',
].join('\n')
/**
 * Every edit the patch applies, in file order.
 *
 * `before` and `after` are literal and must occur exactly once in the file's unpatched/patched
 * state; the same pair drives --apply and --revert, so a revert cannot drift from an apply.
 */
const EDITS = [
  {
    id: 'surface-generation-base',
    file: 'packages/core/session/src/surface.ts',
    before: nl(
      '  /** Shared transition state; replacement history is not retained. */',
      '  private _state = createFoldState()',
      '',
    ),
    after: nl(
      '  /** Shared transition state; replacement history is not retained. */',
      '  private _state = createFoldState()',
      '  /** Advanced by {@link reset} so a discarded fold never reuses an earlier generation. */',
      '  private _generationBase = 0',
      '',
    ),
  },
  {
    id: 'surface-reset',
    file: 'packages/core/session/src/surface.ts',
    before: nl(
      '    this._lastProcessedSeq = baseSeq === 0 ? -1 : SessionSeq(baseSeq - 1)',
      '  }',
      '',
    ),
    after: nl(
      '    this._lastProcessedSeq = baseSeq === 0 ? -1 : SessionSeq(baseSeq - 1)',
      '  }',
      '',
      '  /**',
      '   * Discard the folded surface and reprocess the log from its first event.',
      '   *',
      '   * Needed after an in-place log edit: the fold is incremental, so a rewritten event at',
      '   * an earlier seq would never be read again. The generation counters advance across a',
      '   * reset, so a cache keyed on them (derived messages) cannot mistake the refolded surface',
      '   * for the one it was built from.',
      '   */',
      '  reset(): void {',
      '    // Fold whatever the log still owes first: the generation a reset advances past has to',
      '    // be the generation observers actually saw, or a pending delta could let the new',
      '    // value go backwards and a cache keyed on it match again.',
      '    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()',
      '    this._generationBase += this._state.contentGeneration + this._state.replaceGeneration + 1',
      '    this._state = createFoldState()',
      '    this._lastProcessedSeq = this.baseSeq === 0 ? -1 : SessionSeq(this.baseSeq - 1)',
      '  }',
      '',
    ),
  },
  {
    id: 'surface-replace-generation',
    file: 'packages/core/session/src/surface.ts',
    before: nl('    return this._state.replaceGeneration', ''),
    after: nl('    return this._generationBase + this._state.replaceGeneration', ''),
  },
  {
    id: 'surface-content-generation',
    file: 'packages/core/session/src/surface.ts',
    before: nl('    return this._state.contentGeneration', ''),
    after: nl('    return this._generationBase + this._state.contentGeneration', ''),
  },
  {
    id: 'session-in-place-members',
    file: 'packages/core/session/src/index.ts',
    before: APPEND_DOC_ANCHOR,
    after: SESSION_MEMBERS + APPEND_DOC_ANCHOR,
  },
  {
    id: 'persistence-rewrite-options',
    file: 'packages/session/session-persistence/src/handle.ts',
    before: nl(
      '/** Options for {@link SessionHandle.append}. */',
      'export interface SessionHandleAppendOptions {',
      '  /** Optional cancellation observed before the write starts. */',
      '  readonly signal?: AbortSignal',
      '}',
      '',
    ),
    after: nl(
      '/** Options for {@link SessionHandle.append}. */',
      'export interface SessionHandleAppendOptions {',
      '  /** Optional cancellation observed before the write starts. */',
      '  readonly signal?: AbortSignal',
      '}',
      '',
    ) + PERSISTENCE_REWRITE_OPTIONS,
  },
  {
    id: 'persistence-export-rewrite-options',
    file: 'packages/session/session-persistence/src/index.ts',
    before: nl('  SessionHandleReadResult,', "} from './handle.ts'", ''),
    after: nl('  SessionHandleReadResult,', '  SessionHandleRewriteOptions,', "} from './handle.ts'", ''),
  },
  {
    id: 'persistence-rewrite-member',
    file: 'packages/session/session-persistence/src/handle.ts',
    before: nl('  /**', '   * The durability barrier — the one operation that promises storage: on', ''),
    after: PERSISTENCE_REWRITE_MEMBER + nl('  /**', '   * The durability barrier — the one operation that promises storage: on', ''),
  },
  {
    id: 'handle-rewrite-batch-decl',
    file: 'packages/session/session-persistence-jsonl/src/storage.ts',
    before: nl(
      '  /** Materialize the header-only artifact for an explicitly flushed empty session. */',
      '  persistHeader(header: SessionHeader, inheritedEventCount: SessionLogOffset): Promise<void>',
      '',
    ),
    after: nl(
      '  /** Materialize the header-only artifact for an explicitly flushed empty session. */',
      '  persistHeader(header: SessionHeader, inheritedEventCount: SessionLogOffset): Promise<void>',
      '',
    ) + HANDLE_REWRITE_BATCH_DECL,
  },
  {
    id: 'tracker-rewrite-sink',
    file: 'packages/session/session-persistence-jsonl/src/storage.ts',
    before: TRACKER_INSTALL_BEFORE,
    after: TRACKER_INSTALL_AFTER,
  },
  {
    id: 'session-handle-rewrite',
    file: 'packages/session/session-persistence-jsonl/src/storage.ts',
    before: nl(
      '  /**',
      '   * Hold the cross-process write lock before this session\'s first durable',
      '',
    ),
    after: HANDLE_REWRITE_MEMBERS + nl(
      '  /**',
      '   * Hold the cross-process write lock before this session\'s first durable',
      '',
    ),
  },
  {
    id: 'storage-import-rewrite-options',
    file: 'packages/session/session-persistence-jsonl/src/storage.ts',
    before: nl('  SessionHandleReadResult,', "} from '@deepseek-ai/dsh-session-persistence'", ''),
    after: nl('  SessionHandleReadResult,', '  SessionHandleRewriteOptions,', "} from '@deepseek-ai/dsh-session-persistence'", ''),
  },
  {
    id: 'jsonl-import-rename',
    file: 'packages/session/session-persistence-jsonl/src/index.ts',
    before: nl("import { open, mkdir, readdir, realpath, link, rm, stat, truncate } from 'node:fs/promises'", ''),
    after: nl("import { open, mkdir, readdir, realpath, link, rm, stat, truncate, rename } from 'node:fs/promises'", ''),
  },
  {
    id: 'jsonl-rewrite-batch',
    file: 'packages/session/session-persistence-jsonl/src/index.ts',
    before: nl(
      '  /**',
      '   * Truncate a torn physical tail durably before this session\'s first new append.',
      '   * @param header - the session\'s stored header.',
      '   * @param truncateTo - the byte offset the artifact is truncated to.',
      '   */',
      '  async truncateTornTail(header: SessionHeader, truncateTo: number): Promise<void> {',
      '',
    ),
    after: JSONL_REWRITE_BATCH + nl(
      '  /**',
      '   * Truncate a torn physical tail durably before this session\'s first new append.',
      '   * @param header - the session\'s stored header.',
      '   * @param truncateTo - the byte offset the artifact is truncated to.',
      '   */',
      '  async truncateTornTail(header: SessionHeader, truncateTo: number): Promise<void> {',
      '',
    ),
  },
]

/** Every host file the patch owns. */
const FILES = [...new Set(EDITS.map(edit => edit.file))]

/** Parse argv into the mode and options. */
function parseArgs(argv) {
  const mode = argv.find(arg => ['--check', '--apply', '--revert', '--locate'].includes(arg))
    // `--build` alone is its own mode: the quick-install script applies first and then builds,
    // so a build failure can be reported without pretending the patch itself failed.
    ?? (argv.includes('--build') ? '--build' : undefined)
  const at = argv.indexOf('--checkout')
  return {
    mode,
    build: argv.includes('--build'),
    force: argv.includes('--force'),
    locate: mode === '--locate',
    checkout: at >= 0 ? argv[at + 1] : undefined,
  }
}



/** Read one target file, or fail with the path that was looked for. */
function readTarget(root, file) {
  const path = join(root, file)
  if (!existsSync(path)) throw new Error('target file not found: ' + path)
  return readFileSync(path, 'utf8')
}

/** Count non-overlapping occurrences of a literal. */
function count(haystack, needle) {
  return haystack.split(needle).length - 1
}

/** Classify one edit against one file. */
function classify(text, edit) {
  const after = count(text, edit.after)
  const before = count(text, edit.before)
  if (after === 1 && before <= 1) return 'applied'
  if (after === 0 && before === 1) return 'absent'
  return after === 0 && before === 0 ? 'anchor-missing' : 'ambiguous'
}

/**
 * Refuse to touch a target file that carries changes this patch did not write.
 *
 * A file this patch has already edited is expected to be dirty, so dirt alone cannot be the test:
 * what must not be overwritten is someone else's work in a file where this patch's own edits are
 * not all in place. An incremental --apply over an already-patched checkout therefore still works,
 * while a file edited by hand inside an anchor still refuses.
 * @param root - host checkout.
 * @param states - the classified edit table.
 * @param force - skip the check entirely.
 */
function assertClean(root, states, force) {
  if (force) return
  let status
  try {
    status = execFileSync('git', ['status', '--porcelain', '--', ...FILES], { cwd: root, encoding: 'utf8' })
  } catch (error) {
    throw new Error('cannot read git status in ' + root + ': ' + (error instanceof Error ? error.message : String(error)))
  }
  const foreign = status.split('\n')
    .map(line => line.slice(3).trim())
    .filter(file => file !== '')
    .filter(file => !states.filter(state => state.file === file).every(state => state.state === 'applied'))
  if (foreign.length > 0) {
    throw new Error('refusing to patch: these files have changes this patch did not write:\n  '
      + foreign.join('\n  ') + '\n(commit or stash them, or pass --force)')
  }
}

/** Classify every edit against the current files without writing anything. */
function inspect(root) {
  return EDITS.map(edit => ({ ...edit, state: classify(readTarget(root, edit.file), edit) }))
}

/** Apply or revert the edit table, returning the per-edit verdicts. */
function run(root, mode) {
  const states = inspect(root)
  if (mode === '--check') return states
  const broken = states.filter(edit => edit.state === 'anchor-missing' || edit.state === 'ambiguous')
  if (broken.length > 0) {
    throw new Error('refusing to write: ' + broken.length + ' edit(s) do not match this checkout:\n'
      + broken.map(edit => '  - ' + edit.id + ' (' + edit.file + '): ' + edit.state).join('\n'))
  }
  const wanted = mode === '--apply' ? 'absent' : 'applied'
  const todo = states.filter(edit => edit.state === wanted)
  if (todo.length === 0) return states
  const originals = new Map(FILES.map(file => [file, readTarget(root, file)]))
  try {
    for (const file of FILES) {
      let text = originals.get(file)
      for (const edit of todo.filter(item => item.file === file)) {
        const from = mode === '--apply' ? edit.before : edit.after
        const to = mode === '--apply' ? edit.after : edit.before
        const next = text.replace(from, () => to)
        if (next === text) throw new Error(edit.id + ': replacement found no anchor')
        text = next
      }
      writeFileSync(join(root, file), text)
    }
  } catch (error) {
    for (const [file, text] of originals) writeFileSync(join(root, file), text)
    throw error
  }
  return states
}

/** Type-check and emit the patched packages' projects. */
function build(root) {
  for (const project of BUILD_PROJECTS) {
    console.log('building ' + project + '...')
    execFileSync('pnpm', ['exec', 'tsc', '-b', project], { cwd: root, stdio: 'inherit' })
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const located = locateCheckout({ explicit: options.checkout })
  if (options.mode === '--locate') {
    if (located.root === undefined) {
      console.error('dsh-inplace-patch: no DSH source checkout found; pass --checkout <dir>')
      for (const line of located.tried) console.error('  tried ' + line)
      process.exit(1)
    }
    console.log(located.root)
    return
  }
  if (options.mode === undefined) {
    console.error('usage: dsh-inplace-patch.mjs --check|--apply|--revert|--locate|--build [--build] [--force] [--checkout <dir>]')
    process.exit(2)
  }
  if (located.root === undefined) {
    console.error('dsh-inplace-patch: no DSH source checkout found; pass --checkout <dir>')
    for (const line of located.tried) console.error('  tried ' + line)
    process.exit(1)
  }
  const root = located.root
  // The source is reported even when it was obvious: patching the wrong tree is the one mistake
  // this script must never make quietly.
  console.log('dsh-inplace-patch: ' + options.mode + ' in ' + root + ' (via ' + located.source + ')')
  if (options.mode === '--build') {
    build(root)
    console.log('BUILT')
    return
  }
  // Only an apply is protected from the user's in-flight work: a revert is *supposed* to run
  // against the applied state, and its literal anchors already refuse anything that is not ours.
  if (options.mode === '--apply') assertClean(root, inspect(root), options.force)
  const states = run(root, options.mode)
  for (const edit of states) console.log('  ' + edit.state.padEnd(14) + edit.id + '  (' + edit.file + ')')
  if (options.mode === '--check') {
    const broken = states.filter(edit => edit.state === 'anchor-missing' || edit.state === 'ambiguous')
    if (broken.length > 0) {
      console.error('ANCHOR MISMATCH: this checkout is neither patched nor patchable')
      process.exit(1)
    }
    if (states.some(edit => edit.state !== 'applied')) {
      console.error('NOT PATCHED')
      process.exit(1)
    }
    console.log('PATCHED')
    return
  }
  console.log(options.mode === '--apply' ? 'PATCHED' : 'REVERTED')
  if (options.build) build(root)
}

try {
  main()
} catch (error) {
  console.error('dsh-inplace-patch: ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
