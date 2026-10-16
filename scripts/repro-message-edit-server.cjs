#!/usr/bin/env node
// Execute real bundled timeline functions with the current host contract as a fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const dshHome = process.env.DSH_HOME ?? path.join(process.env.HOME, '.dsh');
const profilePlugin = (name) => path.join(dshHome, 'profiles', process.env.DSH_PROFILE ?? 'web', 'node_modules', name);
const bundle = process.argv.slice(2).find(arg => !arg.startsWith('--')) || path.join(profilePlugin('dsh-message-edit'), 'index.mjs');
const source = fs.readFileSync(bundle, 'utf8');
const expectFailure = process.argv.includes('--expect-failure');
const start = source.indexOf('function flattenLineage(');
const end = source.indexOf('function objectValue(', start);
assert(start >= 0 && end > start, 'real bundled timeline seam must exist');
const closedTurns = events => events;
const editableMessages = turns => turns;
const retryableTurns = turns => turns;
const ownVersionEvent = () => undefined;
const sandbox = { closedTurns, editableMessages, retryableTurns, ownVersionEvent };
vm.runInNewContext(source.slice(start, end) + '\n globalThis.__test = { timeline, versionLog };', sandbox);
const record = (id, parentSession) => ({ header: { id, createdAt: 1, ...(parentSession ? { parentSession, seedLength: 1 } : {}) } });
const root = record('root');
const child = record('child', 'root');
const event = { seq: 1, type: 'user/message', time: 1 };
let readCount = 0;
const ctx = {
  sessions: { get: id => id === 'root' ? { events: [event] } : undefined },
  get: key => { assert.equal(key, 'sessionPersistence'); return { stat: async () => ({ revision: '1' }), open: async () => ({}), list: async () => [] }; },
  sessionQuery: {
    traceSession: async id => id === 'root'
      ? { complete: true, root, target: root, descendants: [{ session: child, descendants: [] }] }
      : { complete: true, root, target: child, descendants: [] },
    readSession: async id => { readCount++; return { session: id, events: [event, { seq: 2, type: 'turn/end', time: 2 }] }; },
  },
};
(async () => {
  if (expectFailure) {
    await assert.rejects(sandbox.__test.timeline(ctx, 'root'), /readFrom is not a function/);
    console.log('BEFORE: current persistence API lacks readFrom; root lineage throws readFrom is not a function');
    // A child trace points at the root; the separate root trace may omit the fresh child.
    ctx.sessionQuery.traceSession = async id => id === 'child' ? { complete: true, root, target: child, ancestors: [root], descendants: [] } : { complete: true, root, target: root, descendants: [] };
    await assert.rejects(sandbox.__test.timeline(ctx, 'child'), /当前版本不在版本树中/);
    console.log('BEFORE: stale root observation excludes current child; throws 当前版本不在版本树中');
  } else {
    const result = await sandbox.__test.timeline(ctx, 'root');
    assert.equal(result.sessionId, 'root');
    assert.equal(result.versions.length, 2);
    assert(readCount >= 1, 'must consume actual query events for child log');
    console.log('AFTER: root lineage uses real sessionQuery events; timeline returns two versions');
    ctx.sessionQuery.traceSession = async id => id === 'child' ? { complete: true, root, target: child, ancestors: [root], descendants: [] } : { complete: true, root, target: root, descendants: [] };
    const partial = await sandbox.__test.timeline(ctx, 'child');
    assert.equal(partial.versions.length, 2);
    assert.equal(partial.versions[1].sessionId, 'child');
    console.log('AFTER: stale root observation retains current child version; timeline returns normally');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
