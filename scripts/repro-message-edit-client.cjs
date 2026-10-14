#!/usr/bin/env node
// Exercise the real installed/archived client bundle through its loader and both slot injections.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const bundle = process.argv[2] || path.join(process.env.HOME, '.dsh/profiles/web/node_modules/dsh-message-edit/client.js');
const expectFailure = process.argv.includes('--expect-failure');
const source = fs.readFileSync(bundle, 'utf8');
const anchor = '\t\tfunction lineageRevision(snapshot, sessionId) {';
assert.equal(source.split(anchor).length, 2, 'expected controller revision seam');
let plugin;
const stores = [];
const sandbox = {
  window: { __ModuleLoader__: { load: ({ id, factory }) => {
    assert.equal(id, 'dsh-message-edit');
    plugin = factory((name) => {
      if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: (initial) => {
        const store = { snapshot: initial, getSnapshot() { return this.snapshot; }, subscribe() { return () => {}; }, update(fn) { fn(this.snapshot); } };
        stores.push(store);
        return store;
      } };
      if (name === 'react') return { useEffect: () => {}, useMemo: fn => fn(), useState: value => [value, () => {}] };
      if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: Symbol.for('react.fragment') };
      throw Error(`unexpected import ${name}`);
    });
  } } },
  setTimeout, clearTimeout, AbortController, fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: 'offline fixture' }) }),
};
// Only expose the bundle's private revision function for a precise fallback assertion.
vm.runInNewContext(source.replace(anchor, '\t\tglobalThis.__revisionUnderTest = conversationRevision;\n' + anchor), sandbox, { filename: bundle });
const slots = [];
const snapshot = { openState: 'open', removed: false, hasMore: false }; // Current SessionSnapshot: no turnEnds.
const sourceStore = { getSnapshot: () => snapshot, subscribe: () => () => {} };
let eventRevision = 0;
let eventListener;
const eventSource = { getSnapshot: () => ({ revision: eventRevision }), subscribe: fn => { eventListener = fn; return () => { eventListener = undefined; }; } };
const ctx = {
  get: key => { assert.equal(key, 'sessions'); return ctx.sessions; },
  sessions: { list: { getSnapshot: () => ({ byId: { s1: {} } }), subscribe: () => () => {} }, binding: () => ({ session: sourceStore, eventSource }) },
  effect: fn => fn(), on: () => {}, slots: { register: (declaration) => slots.push(declaration) },
};
plugin.apply(ctx);
assert.equal(slots.length, 2);
if (expectFailure) {
  for (const slot of slots) assert.throws(() => slot.inject('s1'), { name: 'TypeError', message: /reading 'entries'/ });
  console.log('BEFORE: both slot injections throw TypeError: Cannot read properties of undefined (reading entries)');
} else {
  for (const slot of slots) assert.doesNotThrow(() => slot.inject('s1'));
  assert.equal(sandbox.__revisionUnderTest(snapshot), 'open|false|false|');
  assert.equal(sandbox.__revisionUnderTest({ ...snapshot, turnEnds: { broken: true } }), 'open|false|false|');
  assert.equal(sandbox.__revisionUnderTest({ ...snapshot, turnEnds: new Map([[2, 9]]) }), 'open|false|false|2:9');
  assert.equal(sandbox.__revisionUnderTest(snapshot, eventSource), 'open|false|false|0');
  eventRevision = 1;
  assert.equal(sandbox.__revisionUnderTest(snapshot, eventSource), 'open|false|false|1');
  assert.doesNotThrow(() => eventListener(), 'event changes must notify controller');
  assert.equal(stores.length, 1, 'both slots share the same controller');
  console.log('AFTER: both slot injections succeed; stable fallback open|false|false|, event revision 0→1 observed');
}
