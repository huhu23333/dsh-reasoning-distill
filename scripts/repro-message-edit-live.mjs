#!/usr/bin/env node
// Run the patched server projection over a real persisted session log.
//
// The route's only real-world dependency is the live Session shape: the host
// exposes `seq` and `snapshotEvents()`, not the raw `.events` array. This drives
// the actual projection helpers from the installed bundle against a real log and
// asserts the bounded, complete payload the HTTP route depends on.
//
// Usage: node scripts/repro-message-edit-live.mjs [bundle] <session.v4.jsonl.zstd>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { profilePluginDir } from './lib/dsh-paths.mjs';

const bundle = process.argv[2] ?? path.join(profilePluginDir('dsh-message-edit'), 'index.mjs');
const log = process.argv[3] ?? process.env.DSH_SESSION_LOG;
if (log === undefined || log === '') {
  console.error('usage: node scripts/repro-message-edit-live.mjs [bundle] <session.v4.jsonl.zstd>');
  process.exit(2);
}

const decompressed = execFileSync('zstd', ['-d', '-c', log], { maxBuffer: 1024 * 1024 * 1024 }).toString('utf8');
const records = decompressed.trim().split('\n').map(line => JSON.parse(line));
const header = records[0];
const events = records.slice(1);
assert.equal(header.type, 'session', 'the first record must be the session header');
events.forEach((event, index) => assert.equal(event.seq, index, 'seq must equal the log offset'));

const source = fs.readFileSync(bundle, 'utf8');
const helperStart = source.indexOf('function isTextualBlock(block) {');
const helperEnd = source.indexOf('function downstreamUsers(turns, start) {');
const boundedStart = source.indexOf('function boundedInteger(name, fallback, maximum) {');
const boundedEnd = source.indexOf('function objectValue(value) {');
assert(helperStart >= 0 && helperEnd > helperStart, 'expected the turn projection helpers');
assert(boundedStart >= 0 && boundedEnd > boundedStart, 'expected the bounded projection');

const fixture = `${source.slice(helperStart, helperEnd)}\n${source.slice(boundedStart, boundedEnd)}\nglobalThis.__liveProjection = { timeline, recentEventWindow, closedTurns, editableMessages };\n`;
const temporary = path.join(os.tmpdir(), `message-edit-live-${process.pid}.mjs`);
fs.writeFileSync(temporary, fixture);
let value;
let window;
let windowRange;
try {
  await import(`${pathToFileURL(temporary).href}?t=${Date.now()}`);
  const { timeline, recentEventWindow, closedTurns, editableMessages } = globalThis.__liveProjection;
  const live = {
    header: { createdAt: header.createdAt },
    seq: events.length,
    // Exactly the modern host surface: a bounded range read, never a raw array.
    snapshotEvents: (from = 0, to = events.length) => {
      window = to - from;
      return events.slice(from, to);
    },
  };
  value = await timeline({ sessions: new Map([[header.id, live]]) }, header.id);
  const recent = recentEventWindow(events);
  windowRange = `tailWindow=${String(recent.length)} seq ${String(recent[0]?.seq)}..${String(recent.at(-1)?.seq)} closedTurns=${String(closedTurns(recent).length)} editableBeforeBounds=${String(editableMessages(closedTurns(recent)).length)}`;
} finally {
  delete globalThis.__liveProjection;
  fs.rmSync(temporary, { force: true });
}

assert.equal(value.sessionId, header.id);
for (const field of ['messages', 'retryableTurns', 'versions', 'undoStack', 'redoSessionIds']) {
  assert(Array.isArray(value[field]), `${field} must be an array`);
}
assert(value.messages.length <= 200, `messages must respect the message ceiling, got ${value.messages.length}`);
assert(window !== undefined && window <= 4000, `the live read must be bounded, got ${String(window)} events`);
const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
assert(bytes <= 128 * 1024, `the payload must respect the byte ceiling, got ${bytes}`);
console.log(
  `LIVE: ${path.basename(path.dirname(log))} logEvents=${String(events.length)} logBytes=${String(Buffer.byteLength(decompressed, 'utf8'))} window=${String(window)} ` +
  `messages=${String(value.messages.length)} retryableTurns=${String(value.retryableTurns.length)} versions=${String(value.versions.length)} bytes=${String(bytes)}`,
);
console.log(`LIVE: ${String(windowRange)}`);
