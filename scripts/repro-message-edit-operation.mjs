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

// `tailDrop` hides the final turn/end so the route sees a turn still in progress,
// exactly the situation a compression hand-off runs in.
let tailDrop = 0;
const session = {
  id: header.id,
  header: { createdAt: header.createdAt, cwd: header.cwd },
  get seq() { return events.length - tailDrop; },
  snapshotEvents: (from = 0, to = events.length - tailDrop) => events.slice(from, to),
};
const followups = [];
let maintenanceCalls = 0;
const agent = {
  session,
  options: { provider: 'stub-provider', model: 'stub-model' },
  followup: message => { followups.push(message); },
  maintenanceCalls: () => maintenanceCalls,
  runMaintenance: async operation => { maintenanceCalls += 1; return operation(agent); },
};

// The host validates a branch seed with the real Session constructor; use it so a
// seed the host would reject cannot pass this harness.
const checkout = process.env.DSH_CHECKOUT ?? '/home/huhu233/otherProject/deepseek-harness';
let SessionApi;
try {
  SessionApi = await import(pathToFileURL(path.join(checkout, 'packages/core/session/lib/index.js')).href);
} catch {
  SessionApi = undefined;
  console.error('note: host Session package not found; seed validation is skipped');
}

const archived = [];
let lastSeed;
let lastMeta;
let lastChildId;
let lastInherited;

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
    create: async options => {
      lastSeed = options.seed;
      lastMeta = options.meta;
      lastChildId = options.sessionId;
      lastInherited = Number(options.inheritedEventCount ?? 0);
      if (SessionApi !== undefined) {
        // Same header the persistence writer keys off: without isSeeded the stored
        // log records no fork cut and a reload rejects the copied markers.
        SessionApi.Session.create(
          SessionApi.SessionId(options.sessionId),
          options.seed,
          {
            version: SessionApi.SESSION_FORMAT_VERSION,
            id: SessionApi.SessionId(options.sessionId),
            createdAt: Date.now(),
            isSeeded: options.meta?.isSeeded === true,
            ...(options.meta?.parentSession === undefined ? {} : { parentSession: SessionApi.SessionId(options.meta.parentSession) }),
          },
          SessionApi.SessionLogOffset(lastInherited),
        );
      }
      return { agent: { followup: message => { followups.push(message); } }, dispose: async () => {} };
    },
  },
  workspaceRegistry: {
    list: () => [],
    archiveSession: async id => {
      archived.push(id);
    },
  },
  get: () => undefined,
};
plugin.apply(ctx);
assert.equal(typeof handler, 'function', 'apply() must register the HTTP route');

const server = http.createServer((request, response) => handler(request, response));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${String(server.address().port)}`;

// First closed turn with a real user message and an editable assistant block.
const closedTurn = (() => {
  let current;
  for (const event of events) {
    if (event.type === 'turn/start') current = { turn: event.data.turn, user: undefined, assistants: [] };
    else if (current === undefined) continue;
    else if (event.type === 'user/message' && current.user === undefined && event.data?.source?.kind === 'user') current.user = event;
    else if (event.type === 'assistant/message' && event.data?.turn === current.turn) current.assistants.push(event);
    else if (event.type === 'turn/end' && event.data.turn === current.turn) return current;
  }
  return undefined;
})();
assert(closedTurn?.user !== undefined, 'the fixture log must contain a closed turn with a user message');
const assistantTarget = (() => {
  for (const event of closedTurn.assistants) {
    const content = event.data?.message?.content ?? [];
    // The reasoning-distill hand-off rewrites a reasoning block; prefer it.
    const index = content.findIndex(block => block.type === 'reasoning');
    const target = index >= 0 ? index : content.findIndex(block => block.type === 'text');
    if (target >= 0) return { seq: event.seq, blockIndex: target };
  }
  return undefined;
})();
assert(assistantTarget !== undefined, 'the fixture log must contain an editable assistant block');

async function operate(label, operation, expectedQueuedTurns = 1) {
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
  assert.equal(body.queuedTurns, expectedQueuedTurns, `${label} must queue the expected turns`);
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
  // An assistant-message edit rebuilds the turn from a synthesized manual turn, so
  // nothing is queued; the host seed validator still has to accept that turn.
  await operate('edit-a', {
    action: 'edit', sessionId: header.id, eventSeq: assistantTarget.seq, blockIndex: assistantTarget.blockIndex,
    text: 'edited assistant block by the offline acceptance harness', cascade: 'truncate',
  }, 0);
  // A splice branch is the whole conversation with one block rewritten: the tool
  // calls and later steps must survive, and the version record rides along.
  const originalContent = events[assistantTarget.seq].data.message.content;
  // The compression hand-off runs inside a live turn, so the route must never take
  // the source agent's maintenance phase (that would demand true idle).
  assert.equal(agent.maintenanceCalls(), 0, 'the route must not require the source agent to be idle');
  followups.length = 0;
  await operate('splice ', {
    action: 'splice', sessionId: header.id, eventSeq: assistantTarget.seq,
    blockIndex: assistantTarget.blockIndex, text: 'spliced reasoning text',
  }, 1);
  assert(lastSeed !== undefined, 'the splice must hand a seed to the host');
  assert(lastSeed.length >= events.length, 'the branch seed must carry the whole conversation');
  const spliced = lastSeed[assistantTarget.seq];
  assert.equal(spliced.data.message.content[assistantTarget.blockIndex].text, 'spliced reasoning text');
  assert.deepEqual(
    spliced.data.message.content.map(block => block.type),
    originalContent.map(block => block.type),
    'every content block must survive the splice',
  );
  assert(originalContent.some(block => block.type === 'tool-call') && spliced.data.message.content.some(block => block.type === 'tool-call'),
    'tool calls must survive the splice');
  assert.deepEqual(spliced.surfaceOp, events[assistantTarget.seq].surfaceOp, 'the event envelope must survive');
  assert.equal(lastSeed[events.length].type, 'session/end-seed', 'the inherited cut must be marked at the boundary');
  assert.equal(lastSeed[events.length].data.inherited, true, 'the cut marker must be the inherited one');
  const versionIndex = lastSeed.findLastIndex(candidate => candidate.type === 'message-edit/version');
  assert(versionIndex > events.length, 'the version record must follow the copied log and its cut marker');
  // An open copied tail must be closed before the branch's own turn can open; the host's
  // buildForkSeed does the same with a forked turn/end.
  const copiedTail = lastSeed.slice(events.length + 1, versionIndex);
  const openTurnInCopy = events.reduce((state, event) => event.type === 'turn/start' ? event.data.turn : event.type === 'turn/end' ? null : state, null);
  if (openTurnInCopy !== null) {
    assert(copiedTail.some(candidate => candidate.type === 'turn/end' && candidate.data.reason?.kind === 'forked'),
      'an open copied turn must be closed with a forked turn/end');
  }
  // The persistence contract refuses a log containing a type the harness does not know
  // unless the envelope marks it ignorable, and that refusal drops the session from the
  // session list. Every plugin-owned event must carry the flag.
  for (const event of lastSeed.filter(candidate => candidate.type.startsWith('message-edit/'))) {
    assert.equal(event.ignorable, true, `${event.type} at ${String(event.seq)} must be ignorable`);
  }
  // The host rejects a reloaded log whose delivery marker names another session
  // unless the marker sits inside the recorded inherited prefix. Reproduce that rule:
  // the branch must be created with the fork marker and a cut past every copied marker.
  assert.equal(lastMeta?.isSeeded, true, 'the branch must carry the fork marker');
  assert.equal(lastInherited, events.length, 'the recorded cut must cover the whole copied log');
  const copiedMarkers = lastSeed.filter(event => event.type === 'session-log-deepseek/delivery-accepted'
    && event.data?.sessionId !== undefined && event.data.sessionId !== lastChildId);
  assert(copiedMarkers.length > 0, 'the fixture log must carry a copied delivery marker');
  for (const marker of copiedMarkers) {
    assert(marker.seq < lastInherited, 'a copied delivery marker must stay inside the inherited prefix');
  }
  console.log(`OPERATION ok   reload    copiedMarkers=${String(copiedMarkers.length)} cut=${String(lastInherited)} (host reload rule satisfied)`);
  // The branch continues the interrupted turn from an empty user input: the LLM
  // layer drops empty user content, so the model resumes from the copied history
  // instead of replaying the request.
  assert.equal(followups.length, 1, 'the branch must be driven to continue the turn');
  assert.equal(followups[0].role, 'user');
  assert.deepEqual(followups[0].content, [], 'the continuation input must carry no content');
  console.log(`OPERATION ok   splice   seedEvents=${String(lastSeed.length)} blocks=${spliced.data.message.content.map(block => block.type).join('+')}`);

  // Hiding the replaced conversation belongs to the client UI step (it must follow
  // the visible-conversation switch); the route must not archive anything itself.
  assert.equal(archived.length, 0, 'the mutation route must not archive the source');
  console.log('OPERATION ok   archive  the route leaves archiving to the client UI step');
  // A hand-off lands mid-turn: the copied prefix ends inside an open turn, and the
  // seed must close it exactly as buildForkSeed does -- otherwise the branch's own
  // turn opens while that one is still open and the stored log is rejected on reload.
  const lastTurnEnd = events.map((event, index) => event.type === 'turn/end' ? index : -1).filter(index => index >= 0).pop();
  assert(lastTurnEnd !== undefined, 'the fixture log must contain a closed turn');
  tailDrop = events.length - lastTurnEnd;
  followups.length = 0;
  await operate('splice-open', { action: 'splice', sessionId: header.id, eventSeq: assistantTarget.seq, blockIndex: assistantTarget.blockIndex, text: 'open-tail splice' }, 1);
  assert(lastSeed.some(event => event.type === 'turn/end' && event.data?.reason?.kind === 'forked'),
    'a copied open turn must be closed with the forked cause');
  let open = false;
  for (const event of lastSeed) {
    if (event.type === 'turn/start') {
      assert(!open, 'no turn may start while another is still open in the seed');
      open = true;
    } else if (event.type === 'turn/end') open = false;
  }
  console.log('OPERATION ok   open-tail  the copied open turn is closed before the branch continues');

  console.log('OPERATION ACCEPTANCE PASSED (offline, real handler + real log)');
} finally {
  server.close();
}
