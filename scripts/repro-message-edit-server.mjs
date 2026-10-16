#!/usr/bin/env node
// Drive the real bounded server projection from the installed bundle.
//
// Covers the host-shape regressions this route has hit:
//  - the live Session exposes `seq` + `snapshotEvents()`, not a raw `.events` array;
//  - the editable window must be whole closed turns, bounded by event count and bytes,
//    and the final payload must degrade by trimming instead of answering an error.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { profilePluginDir } from './lib/dsh-paths.mjs';

const bundle = process.argv[2] ?? path.join(profilePluginDir('dsh-message-edit'), 'index.mjs');
const source = fs.readFileSync(bundle, 'utf8');
const start = source.indexOf('function boundedInteger(name, fallback, maximum) {');
const end = source.indexOf('function objectValue(value) {', start);
assert(start >= 0 && end > start, 'expected bounded timeline seam');
const fixture = `
const closedTurns = events => events;
const editableMessages = turns => turns;
const retryableTurns = turns => turns.map((_, turn) => ({ turn, preview: "fixture" }));
${source.slice(start, end)}
globalThis.__messageEditServer = { boundedTimeline, timeline };
`;
const temporary = path.join(os.tmpdir(), `message-edit-server-${process.pid}.mjs`);
fs.writeFileSync(temporary, fixture);

try {
  await import(`${pathToFileURL(temporary).href}?t=${Date.now()}`);
  const { boundedTimeline, timeline } = globalThis.__messageEditServer;

  // 1. The final byte ceiling trims the oldest messages instead of throwing.
  const oversized = {
    sessionId: 's1',
    messages: Array.from({ length: 500 }, (_, index) => ({
      key: `${index}:0`, turn: index, eventSeq: index, blockIndex: 0,
      kind: 'user', text: 'x'.repeat(2048), time: index,
    })),
    retryableTurns: [], versions: [], undoStack: [], redoSessionIds: [],
  };
  const trimmed = boundedTimeline(oversized);
  assert(Buffer.byteLength(JSON.stringify(trimmed), 'utf8') <= 128 * 1024, 'the payload must respect the byte ceiling');
  assert(trimmed.messages.length > 0 && trimmed.messages.length < 500, 'oversized payloads must degrade by trimming, not error');
  assert.deepEqual(trimmed.versions, [], 'trimming must not drop non-message fields');

  // 2. Modern live Session: three closed turns plus an open tail.
  const turnEvents = (turn, startSeq) => [
    { type: 'turn/start', seq: startSeq, time: startSeq, data: { turn } },
    { type: 'user/message', seq: startSeq + 1, time: startSeq + 1, data: { content: [{ type: 'text', text: `u${turn}` }], source: { kind: 'user' }, role: 'user', id: `u${turn}` } },
    { type: 'turn/end', seq: startSeq + 2, time: startSeq + 2, data: { turn } },
  ];
  const log = [
    ...turnEvents(1, 0), ...turnEvents(2, 3), ...turnEvents(3, 6),
    { type: 'turn/start', seq: 9, time: 9, data: { turn: 4 } },
    { type: 'user/message', seq: 10, time: 10, data: { content: [{ type: 'text', text: 'open' }], source: { kind: 'user' }, role: 'user', id: 'u4' } },
  ];
  const reads = [];
  const modern = {
    header: { createdAt: 1 },
    seq: log.length,
    snapshotEvents: (from = 0, to = log.length) => { reads.push(to - from); return log.slice(from, to); },
  };
  const live = await timeline({ sessions: new Map([['live', modern]]) }, 'live');
  assert.equal(live.sessionId, 'live');
  assert.equal(live.versions.length, 1);
  for (const field of ['messages', 'retryableTurns', 'undoStack', 'redoSessionIds']) {
    assert(Array.isArray(live[field]), `${field} must be an array`);
  }
  const seen = live.messages.map(message => message.seq);
  assert(seen.includes(6), 'closed turns must reach the projection');
  assert(!seen.includes(9) && !seen.includes(10), 'the open tail must stay out of the editable window');
  assert.deepEqual(reads, [log.length], 'the live read must be a bounded snapshot range');

  // 3. A legacy `.events`-only host shape keeps working.
  const legacy = await timeline({
    sessions: new Map([['legacy', { events: turnEvents(1, 0), header: { createdAt: 1 } }]]),
  }, 'legacy');
  assert.equal(legacy.sessionId, 'legacy');
  assert(legacy.messages.length > 0, 'a legacy .events session must still project');

  // 4. The event ceiling bounds the read on a huge log.
  const boundedReads = [];
  const huge = {
    header: { createdAt: 1 },
    seq: 50000,
    snapshotEvents: (from, to) => { boundedReads.push(to - from); return []; },
  };
  await timeline({ sessions: new Map([['huge', huge]]) }, 'huge');
  assert.deepEqual(boundedReads, [2000], 'the live read must be bounded by DSH_MESSAGE_EDIT_EVENT_LIMIT');

  // 5. An unloaded session answers with a complete, empty payload plus a notice.
  const unloaded = await timeline({ sessions: new Map() }, 'unloaded');
  assert.equal(unloaded.sessionId, 'unloaded');
  for (const field of ['messages', 'retryableTurns', 'versions', 'undoStack', 'redoSessionIds']) {
    assert.deepEqual(unloaded[field], [], `${field} must be an empty array`);
  }
  assert.match(unloaded.notice, /保护宿主内存.*当前已加载会话/);
  console.log('SERVER: bounded whole-turn window, live/legacy host shapes, graceful byte trimming, empty unloaded payload');
} finally {
  delete globalThis.__messageEditServer;
  fs.rmSync(temporary, { force: true });
}
