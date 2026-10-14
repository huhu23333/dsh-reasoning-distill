#!/usr/bin/env node
// Offline end-to-end acceptance for the timeline route.
//
// Loads the real installed index.mjs, registers its real HTTP handler, and drives
// a real request through it against a real persisted session log. Only the host
// wiring is stubbed, with exactly the deployed Session surface (seq + snapshotEvents)
// from @deepseek-ai/dsh-session 0.2.1-alpha.1.
//
// Usage: node scripts/repro-message-edit-route.mjs [bundle] <session.v4.jsonl.zstd>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const bundle = process.argv[2] ?? path.join(os.homedir(), '.dsh/profiles/web/node_modules/dsh-message-edit/index.mjs');
const log = process.argv[3] ?? process.env.DSH_SESSION_LOG;
if (log === undefined || log === '') {
  console.error('usage: node scripts/repro-message-edit-route.mjs [bundle] <session.v4.jsonl.zstd>');
  process.exit(2);
}

const records = execFileSync('zstd', ['-d', '-c', log], { maxBuffer: 1024 * 1024 * 1024 })
  .toString('utf8').trim().split('\n').map(line => JSON.parse(line));
const header = records[0];
const events = records.slice(1);
assert.equal(header.type, 'session', 'the first record must be the session header');
events.forEach((event, index) => assert.equal(event.seq, index, 'seq must equal the log offset'));

const live = {
  header: { createdAt: header.createdAt },
  seq: events.length,
  snapshotEvents: (from = 0, to = events.length) => events.slice(from, to),
};

const plugin = await import(`${pathToFileURL(bundle).href}?t=${Date.now()}`);
let handler;
const ctx = {
  effect: register => register(),
  webServer: { register: contribution => { handler = contribution.handler; } },
  sessions: { get: id => (id === header.id ? live : undefined) },
  sessionQuery: { traceSession: async () => { throw new Error('the bounded route must not trace the session'); } },
};
plugin.apply(ctx);
assert.equal(typeof handler, 'function', 'apply() must register the HTTP route');

const server = http.createServer((request, response) => handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${String(server.address().port)}`;

async function request(sessionId) {
  const started = process.hrtime.bigint();
  const response = await fetch(`${origin}/message-edit?sessionId=${encodeURIComponent(sessionId)}`);
  const text = await response.text();
  return {
    status: response.status,
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    bytes: Buffer.byteLength(text, 'utf8'),
    body: JSON.parse(text),
  };
}

try {
  const loaded = await request(header.id);
  assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
  assert.equal(loaded.body.error, undefined, 'a loaded session must not answer an error');
  for (const field of ['messages', 'retryableTurns', 'versions', 'undoStack', 'redoSessionIds']) {
    assert(Array.isArray(loaded.body[field]), `${field} must be an array`);
  }
  assert(loaded.body.messages.length > 0, 'a session with closed turns must expose editable messages');
  assert(loaded.bytes <= 128 * 1024, `the payload must respect the byte ceiling, got ${String(loaded.bytes)}`);
  console.log(
    `ROUTE ok   loaded   status=${String(loaded.status)} time=${loaded.ms.toFixed(1)}ms bytes=${String(loaded.bytes)} ` +
    `messages=${String(loaded.body.messages.length)} retryableTurns=${String(loaded.body.retryableTurns.length)} versions=${String(loaded.body.versions.length)}`,
  );

  const unloaded = await request('session-does-not-exist');
  assert.equal(unloaded.status, 200, JSON.stringify(unloaded.body));
  for (const field of ['messages', 'retryableTurns', 'versions', 'undoStack', 'redoSessionIds']) {
    assert.deepEqual(unloaded.body[field], [], `${field} must be empty for an unloaded session`);
  }
  assert.match(unloaded.body.notice, /当前已加载会话/);
  console.log(
    `ROUTE ok   unloaded status=${String(unloaded.status)} time=${unloaded.ms.toFixed(1)}ms bytes=${String(unloaded.bytes)} notice="${String(unloaded.body.notice)}"`,
  );
  console.log('ROUTE ACCEPTANCE PASSED (offline, real handler + real log)');
} finally {
  server.close();
}
