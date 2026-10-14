#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const bundle = process.argv[2] ?? path.join(os.homedir(), '.dsh/profiles/web/node_modules/dsh-message-edit/index.mjs');
const source = fs.readFileSync(bundle, 'utf8');
const anchor = 'function boundedTimeline(value) {';
assert.equal(source.split(anchor).length, 2, 'expected bounded timeline seam');
const exposed = `${source}\nglobalThis.__boundedTimeline = boundedTimeline;\n`;
const temporary = path.join(os.tmpdir(), `message-edit-server-${process.pid}.mjs`);
fs.writeFileSync(temporary, exposed);
try {
  await import(`${pathToFileURL(temporary).href}?t=${Date.now()}`);
  const messages = Array.from({ length: 500 }, (_, index) => ({
    key: `${index}:0`, turn: index, eventSeq: index, blockIndex: 0,
    kind: 'user', text: 'x'.repeat(2048), time: index,
  }));
  const value = {
    sessionId: 's1', messages, retryableTurns: [], versions: [],
    undoStack: [], redoSessionIds: [],
  };
  const bounded = globalThis.__boundedTimeline(value);
  const bytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8');
  assert.ok(bounded.messages.length <= 200, 'message count must be bounded');
  assert.ok(bytes <= 128 * 1024, 'serialized response must be bounded');
  assert.equal(bounded.messages.at(-1).eventSeq, 499, 'newest editable message must survive');
  console.log(`SERVER: ${messages.length} messages -> ${bounded.messages.length}, ${bytes} bytes (<= 131072)`);
} finally {
  delete globalThis.__boundedTimeline;
  fs.rmSync(temporary, { force: true });
}
