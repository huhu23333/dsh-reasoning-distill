#!/usr/bin/env node
// P0 root cause and regression guard for the Timeline's
// "Cannot read properties of undefined (reading 'length')" body.
//
// BEFORE: the lineage projection added by an earlier compatibility patch ended with
//   lineage.push({ record: targetTrace.target, depth: targetTrace.ancestors.length })
// On this host ctx.sessionQuery.traceSession() can report complete: true without an
// `ancestors` array, so that read threw a raw TypeError. The route answered 409 with
// the V8 text and the Timeline rendered the error body verbatim.
//
// AFTER: the bounded projection never calls the trace API at all, so the same host
// shape answers with a complete payload (loaded session) or an empty one (unloaded).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const P0_MESSAGE = "Cannot read properties of undefined (reading 'length')";
const pluginDir = process.argv[2] ?? path.join(os.homedir(), '.dsh/profiles/web/node_modules/dsh-message-edit');
const installed = path.join(pluginDir, 'index.mjs');
const legacyStart = 'function flattenLineage(root, descendants) {';
const boundedStart = 'function boundedInteger(name, fallback, maximum) {';
const seamEnd = 'function objectValue(value) {';
// The projection region references these turn helpers, which live outside the seam.
const stubs = [
  'const closedTurns = events => events;',
  'const editableMessages = turns => turns;',
  "const retryableTurns = turns => turns.map((_, turn) => ({ turn, preview: 'fixture' }));",
  'const ownVersionEvent = () => undefined;',
].join('\n');

async function loadTimeline(bundle, start, label) {
  const source = fs.readFileSync(bundle, 'utf8');
  const from = source.indexOf(start);
  const to = source.indexOf(seamEnd, from);
  assert(from >= 0 && to > from, `expected the ${label} projection seam in ${bundle}`);
  const fixture = `${stubs}\n${source.slice(from, to)}\nglobalThis.__projectionUnderTest = { timeline };\n`;
  const temporary = path.join(os.tmpdir(), `message-edit-p0-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(temporary, fixture);
  try {
    await import(`${pathToFileURL(temporary).href}?t=${Date.now()}-${label}`);
    return globalThis.__projectionUnderTest.timeline;
  } finally {
    delete globalThis.__projectionUnderTest;
    fs.rmSync(temporary, { force: true });
  }
}

/** A trace that reports completeness but carries no `ancestors` array. */
const driftedTrace = id => ({
  complete: true,
  root: { header: { id: 'root' } },
  target: { header: { id } },
  descendants: [],
});
const driftedQuery = {
  traceSession: async id => driftedTrace(id === 'branch' ? 'branch' : 'root'),
};

const legacy = fs.existsSync(pluginDir)
  ? fs.readdirSync(pluginDir)
    .filter(name => /^index\.mjs\.orig-/.test(name))
    .map(name => path.join(pluginDir, name))
    .filter(file => fs.readFileSync(file, 'utf8').indexOf('targetTrace.ancestors.length') >= 0)
    .sort()
    .at(-1)
  : undefined;

if (legacy === undefined) {
  console.log('BEFORE: skipped (no archived pre-bounded bundle carries the lineage seam)');
} else {
  const legacyTimeline = await loadTimeline(legacy, legacyStart, 'lineage');
  await assert.rejects(
    () => legacyTimeline({ sessions: new Map(), sessionQuery: driftedQuery }, 'branch'),
    error => error instanceof TypeError && error.message === P0_MESSAGE,
    'the lineage projection must throw the historical P0 message on a drifted trace',
  );
  console.log(`BEFORE: lineage projection throws "${P0_MESSAGE}" (rendered verbatim by the Timeline error state)`);
}

const boundedTimeline = await loadTimeline(installed, boundedStart, 'bounded');
const mustNotTrace = {
  traceSession: async () => { throw new Error('the bounded projection must not call traceSession'); },
};
// Exactly the modern host surface: no raw `.events`, only seq + snapshotEvents.
const live = { seq: 0, header: { createdAt: 1 }, snapshotEvents: () => [] };
const loaded = await boundedTimeline({ sessions: new Map([['live', live]]), sessionQuery: mustNotTrace }, 'live');
assert.equal(loaded.sessionId, 'live');
assert.equal(loaded.versions.length, 1);
for (const field of ['messages', 'retryableTurns', 'undoStack', 'redoSessionIds']) {
  assert.deepEqual(loaded[field], [], `${field} must be present on a loaded session`);
}
const unloaded = await boundedTimeline({ sessions: new Map(), sessionQuery: mustNotTrace }, 'unloaded');
assert.equal(unloaded.sessionId, 'unloaded');
for (const field of ['messages', 'retryableTurns', 'versions', 'undoStack', 'redoSessionIds']) {
  assert.deepEqual(unloaded[field], [], `${field} must be an empty array when unloaded`);
}
assert.match(unloaded.notice, /当前已加载会话/);
console.log('AFTER: bounded projection answers both host shapes with complete payloads and degrades without a lineage trace');
