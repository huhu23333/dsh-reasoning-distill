#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const bundle = process.argv[2] ?? path.join(os.homedir(), '.dsh/profiles/web/node_modules/dsh-message-edit/index.mjs');
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
  const messages = Array.from({ length: 500 }, (_, index) => ({
    key: `${index}:0`, turn: index, eventSeq: index, blockIndex: 0,
    kind: 'user', text: 'x'.repeat(2048), time: index,
  }));
  const value = {
    sessionId: 's1', messages, retryableTurns: [], versions: [],
    undoStack: [], redoSessionIds: [],
  };
  assert.throws(() => boundedTimeline(value), /硬上限/, 'oversized final JSON must be rejected');

  const live = await timeline({ sessions: new Map([['live', { events: messages.slice(-2), header: { createdAt: 1 } }]]) }, 'live');
  assert.equal(live.sessionId, 'live');
  assert.equal(live.messages.length, 2);
  assert.equal(live.versions.length, 1);

  const unloaded = await timeline({ sessions: new Map() }, 'unloaded');
  assert.equal(unloaded.sessionId, 'unloaded');
  for (const field of ['messages', 'retryableTurns', 'versions', 'undoStack', 'redoSessionIds']) {
    assert.deepEqual(unloaded[field], [], `${field} must be an empty array`);
  }
  assert.match(unloaded.notice, /保护宿主内存.*当前已加载会话/);
  console.log('SERVER: loaded and unloaded timelines are complete, bounded payloads; unloaded includes notice');
} finally {
  delete globalThis.__messageEditServer;
  fs.rmSync(temporary, { force: true });
}
