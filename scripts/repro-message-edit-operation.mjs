#!/usr/bin/env node
// End-to-end acceptance for the branch-mutation POST route (the backend the
// reasoning-distill compression hand-off calls to create a branch session).
//
// Loads the real installed index.mjs, registers its real HTTP handler, and drives
// a real POST over a real persisted session log. Only the host wiring is stubbed,
// with the deployed Session surface (seq + snapshotEvents, no raw .events).
//
// Usage: node scripts/repro-message-edit-operation.mjs [bundle] <session.v4.jsonl.zstd>
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
  console.error('usage: node scripts/repro-message-edit-operation.mjs [bundle] <session.v4.jsonl.zstd>');
  process.exit(2);
}

const records = execFileSync('zstd', ['-d', '-c', log], { maxBuffer: 1024 * 1024 * 1024 })
  .toString('utf8').trim().split('\n').map(line => JSON.parse(line));
const header = records[0];
const events = records.slice(1);
assert.equal(header.type, 'session', 'the first record must be the session header');

const session = {
  id: header.id,
  header: { createdAt: header.createdAt, cwd: header.cwd },
  seq: events.length,
  snapshotEvents: (from = 0, to = events.length) => events.slice(from, to),
};
const agent = {
  session,
  options: { provider: 'stub-provider', model: 'stub-model' },
  followup: () => {},
  runMaintenance: async operation => operation(agent),
};

const plugin = await import(`${pathToFileURL(bundle).href}?t=${Date.now()}`);
let handler;
const ctx = {
  effect: register => register(),
  webServer: { register: contribution => { handler = contribution.handler; } },
  sessions: { get: () => undefined, flush: async () => true },
  sessionQuery: {
    traceSession: async () => { throw new Error('the operation route must not trace the session'); },
    readSession: async () => { throw new Error('the operation route must use the live agent'); },
  },
  agents: {
    get: id => (id === header.id ? agent : undefined),
    create: async () => ({ agent: { followup: () => {} }, dispose: async () => {} }),
  },
  workspaceRegistry: { list: () => [] },
  get: () => undefined,
};
plugin.apply(ctx);
assert.equal(typeof handler, 'function', 'apply() must register the HTTP route');

const server = http.createServer((request, response) => handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${String(server.address().port)}`;

// First closed turn with a real user message: the target for retry/edit.
const closedTurn = (() => {
  let current;
  for (const event of events) {
    if (event.type === 'turn/start') current = { turn: event.data.turn, user: undefined };
    else if (current !== undefined && event.type === 'user/message' && current.user === undefined && event.data?.source?.kind === 'user') current.user = event;
    else if (current !== undefined && event.type === 'turn/end' && event.data.turn === current.turn) return current;
  }
  return undefined;
})();
assert(closedTurn?.user !== undefined, 'the fixture log must contain a closed turn with a user message');

async function operate(label, operation) {
  const started = process.hrtime.bigint();
  const response = await fetch(`${origin}/message-edit`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(operation),
  });
  const text = await response.text();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const body = JSON.parse(text);
  assert.equal(response.status, 200, `${label} must succeed, got ${String(response.status)}: ${text}`);
  assert.match(body.sessionId, /^session-/);
  assert(body.queuedTurns >= 1, `${label} must queue at least one turn`);
  console.log(
    `OPERATION ok   ${label} status=${String(response.status)} time=${ms.toFixed(1)}ms branch=${body.sessionId} queuedTurns=${String(body.queuedTurns)}`,
  );
}

try {
  await operate('reroll', { action: 'reroll', sessionId: header.id });
  await operate('retry ', { action: 'retry', sessionId: header.id, turn: closedTurn.turn, cascade: 'truncate' });
  await operate('edit  ', {
    action: 'edit', sessionId: header.id, eventSeq: closedTurn.user.seq, blockIndex: 0,
    text: 'edited by the offline acceptance harness', cascade: 'truncate',
  });
  console.log('OPERATION ACCEPTANCE PASSED (offline, real handler + real log)');
} finally {
  server.close();
}
