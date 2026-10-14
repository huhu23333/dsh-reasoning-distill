#!/usr/bin/env node
// Exercise the real installed/archived client bundle through its loader and both slot injections.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const bundle = process.argv.slice(2).find(arg => !arg.startsWith('--')) || path.join(process.env.HOME, '.dsh/profiles/web/node_modules/dsh-message-edit/client.js');
const expectFailure = process.argv.includes('--expect-failure');
const deadlineRed = process.argv.includes('--deadline-red');
const source = fs.readFileSync(bundle, 'utf8');
const anchor = '\t\tfunction lineageRevision(snapshot, sessionId) {';
assert.equal(source.split(anchor).length, 2, 'expected controller revision seam');
let plugin;
const stores = [];
let fetchResponse = async () => ({ ok: false, status: 503, json: async () => ({ error: 'offline fixture' }) });
const sandbox = {
  __MESSAGE_EDIT_DEADLINE_MS: 40,
  window: { __ModuleLoader__: { load: ({ id, factory }) => {
    assert.equal(id, 'dsh-message-edit');
    plugin = factory((name) => {
      if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: (initial) => {
        const listeners = new Set();
        const store = { snapshot: initial, getSnapshot() { return this.snapshot; }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, update(fn) { fn(this.snapshot); for (const listener of listeners) listener(); } };
        stores.push(store);
        return store;
      } };
      if (name === 'react') return { useEffect: () => {}, useMemo: fn => fn(), useState: value => [value, () => {}] };
      if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: Symbol.for('react.fragment') };
      throw Error(`unexpected import ${name}`);
    });
  } } },
  setTimeout, clearTimeout, AbortController, fetch: (...args) => fetchResponse(...args),
};
// Only expose the bundle's private revision function for a precise fallback assertion.
vm.runInNewContext(source.replace(anchor, '\t\tglobalThis.__revisionUnderTest = conversationRevision;\n' + anchor), sandbox, { filename: bundle });
const slots = [];
const snapshot = { openState: 'open', removed: false, hasMore: false }; // Current SessionSnapshot: no turnEnds.
const sourceStore = { getSnapshot: () => snapshot, subscribe: () => () => {} };
let eventRevision = 0;
let eventListener;
const eventSource = { getSnapshot: () => ({ revision: eventRevision }), subscribe: fn => { eventListener = fn; return () => { eventListener = undefined; }; } };
let listSnapshot = { byId: { s1: {} } };
let listListener;
const opened = [];
const archived = [];
const ctx = {
  get: key => {
    if (key === 'sessions') return ctx.sessions;
    if (key === 'uiWorkspace') return ctx.uiWorkspace;
    throw new Error(`unexpected service ${key}`);
  },
  // The catalog layer has no open(); selection belongs to uiWorkspace. Leaving
  // sessions.open out proves the bundle no longer depends on it.
  sessions: { list: { getSnapshot: () => listSnapshot, subscribe: fn => { listListener = fn; return () => { listListener = undefined; }; } }, binding: () => ({ session: sourceStore, eventSource }) },
  uiWorkspace: { openSession: id => opened.push(id), archiveSession: async id => { archived.push(id); } },
  effect: fn => fn(), on: () => {}, slots: { register: (declaration) => slots.push(declaration) },
};
plugin.apply(ctx);
assert.equal(slots.length, 2);
if (expectFailure) {
  for (const slot of slots) assert.throws(() => slot.inject('s1'), { name: 'TypeError', message: /reading 'entries'/ });
  console.log('BEFORE: both slot injections throw TypeError: Cannot read properties of undefined (reading entries)');
} else {
  for (const slot of slots) assert.doesNotThrow(() => slot.inject('s1'));
  const face = slots[0].inject('s1');
  assert.equal(sandbox.__revisionUnderTest(snapshot), 'open|false|false|');
  assert.equal(sandbox.__revisionUnderTest({ ...snapshot, turnEnds: { broken: true } }), 'open|false|false|');
  assert.equal(sandbox.__revisionUnderTest({ ...snapshot, turnEnds: new Map([[2, 9]]) }), 'open|false|false|2:9');
  assert.equal(sandbox.__revisionUnderTest(snapshot, eventSource), 'open|false|false|0');
  eventRevision = 1;
  assert.equal(sandbox.__revisionUnderTest(snapshot, eventSource), 'open|false|false|1');
  assert.doesNotThrow(() => eventListener(), 'event changes must notify controller');
  assert.equal(stores.length, 1, 'both slots share the same controller');
  console.log('AFTER: both slot injections succeed; stable fallback open|false|false|, event revision 0→1 observed');
  const settled = (promise, ms = 180) => Promise.race([promise.then(() => true, () => true), delay(ms).then(() => false)]);
  const never = () => new Promise(() => {});
  const readyFixture = {
    sessionId: 's1', messages: [{ key: '1:0', eventSeq: 1, blockIndex: 0, turn: 1, kind: 'user', text: 'hello', time: 1 }],
    retryableTurns: [], versions: [], undoStack: [], redoSessionIds: [],
  };
  (async () => {
    face.acquire();
    const waitForResult = () => new Promise(resolve => {
      let sawLoading = face.hooks.messageEdit.getSnapshot().status === 'loading';
      const unsubscribe = face.hooks.messageEdit.subscribe(() => {
        const status = face.hooks.messageEdit.getSnapshot().status;
        if (status === 'loading') sawLoading = true;
        if (sawLoading && status !== 'loading') { unsubscribe(); resolve(); }
      });
    });
    fetchResponse = never;
    const fetchResult = waitForResult();
    face.load();
    assert.equal(face.hooks.messageEdit.getSnapshot().status, 'loading');
    const fetchSettled = await settled(fetchResult);
    assert.equal(fetchSettled, !(expectFailure || deadlineRed), 'GET fetch must leave loading on deadline');
    if (expectFailure || deadlineRed) console.log('BEFORE: a never-settling fetch strands the timeline in loading');
    else {
      assert.equal(face.hooks.messageEdit.getSnapshot().status, 'error');
      await delay(50);
      fetchResponse = async () => ({ ok: true, json: never });
      const bodyResult = waitForResult();
      face.load();
      assert.equal(await settled(bodyResult), true, 'a stalled response body must leave loading on deadline');
      assert.equal(face.hooks.messageEdit.getSnapshot().status, 'error');
      await delay(50);
      fetchResponse = async () => ({ ok: true, json: async () => readyFixture });
      const readyResult = new Promise(resolve => {
        const unsubscribe = face.hooks.messageEdit.subscribe(() => {
          if (face.hooks.messageEdit.getSnapshot().status === 'ready') { unsubscribe(); resolve(); }
        });
      });
      face.load();
      assert.equal(await settled(readyResult), true);
      assert.equal(face.hooks.messageEdit.getSnapshot().status, 'ready');
      assert.equal(face.hooks.messageEdit.getSnapshot().timeline.messages.length, 1);
      console.log('AFTER: fetch and JSON deadlines expose retry; a valid timeline reaches ready with a message');
      await delay(50);
      // The historical P0 body: a raw server TypeError surfaced through the error JSON.
      // It must land in the readable error state and never reach the renderer as a crash.
      fetchResponse = async () => ({ ok: false, status: 409, json: async () => ({ error: "Cannot read properties of undefined (reading 'length')" }) });
      const serverError = waitForResult();
      face.load();
      assert.equal(await settled(serverError), true, 'a server error body must settle');
      assert.equal(face.hooks.messageEdit.getSnapshot().status, 'error');
      assert.equal(face.hooks.messageEdit.getSnapshot().error, "Cannot read properties of undefined (reading 'length')");
      await delay(50);
      // A structurally incomplete success body is reported, not thrown at the renderer.
      fetchResponse = async () => ({ ok: true, json: async () => ({ sessionId: 's1', messages: [] }) });
      const incomplete = waitForResult();
      face.load();
      assert.equal(await settled(incomplete), true, 'an incomplete body must settle');
      assert.equal(face.hooks.messageEdit.getSnapshot().status, 'error');
      assert.match(face.hooks.messageEdit.getSnapshot().error, /不是数组/);
      await delay(50);
      // The unloaded-session guard answers with a complete empty timeline plus a notice.
      fetchResponse = async () => ({ ok: true, json: async () => ({ sessionId: 's1', messages: [], retryableTurns: [], versions: [], undoStack: [], redoSessionIds: [], notice: '仅处理当前已加载会话' }) });
      const noticed = waitForResult();
      face.load();
      assert.equal(await settled(noticed), true, 'a noticed empty timeline must settle');
      assert.equal(face.hooks.messageEdit.getSnapshot().status, 'ready');
      assert.equal(face.hooks.messageEdit.getSnapshot().timeline.notice, '仅处理当前已加载会话');
      console.log('AFTER: error bodies and incomplete payloads reach the error state; the empty-timeline notice survives decoding');
      await delay(50);
    }
    const navigation = face.openVersion('new-session');
    assert.equal(await settled(navigation), !(expectFailure || deadlineRed), 'session-list navigation must have a deadline');
    if (expectFailure || deadlineRed) console.log('BEFORE: unpublished session-list row leaves navigation pending');
    else {
      assert.equal(opened.length, 0, 'expired navigation must not open an absent session');
      listSnapshot = { byId: { s1: {}, 'new-session': {} } };
      const published = face.openVersion('new-session');
      await published;
      assert.deepEqual(opened, ['new-session']);
      console.log('AFTER: absent navigation finishes; published session opens');
      // An edit creates a branch: it becomes the visible conversation and the one
      // it replaced is archived (hidden), both through uiWorkspace.
      fetchResponse = async () => ({ ok: true, json: async () => ({ sessionId: 'branch-1', queuedTurns: 1 }) });
      listSnapshot = { byId: { s1: {}, 'new-session': {}, 'branch-1': {} } };
      const applied = await face.edit(
        { key: '1:0', turn: 1, eventSeq: 1, blockIndex: 0, kind: 'user', text: 'hello', time: 1 },
        'edited text',
        'truncate',
      );
      assert.equal(applied, true, 'the edit must report success');
      await delay(30);
      assert.deepEqual(opened, ['new-session', 'branch-1'], 'the branch must become the visible conversation');
      assert.deepEqual(archived, [], 'archiving is switched off: the source stays listed');
      console.log('AFTER: an edit switches to the branch and leaves the replaced conversation listed');
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
