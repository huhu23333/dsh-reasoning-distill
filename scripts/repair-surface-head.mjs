#!/usr/bin/env node
// Give a branch log the protected surface head it lost.
//
// A branch cut from inside turn 1 inherits the config prefix but not the source's
// system/message, so its surface opens with a user message and the system/message the
// harness appends later is rejected ("system/message requires a protected first surface
// head", relationships.ts). A system/message must also sit inside an open turn AND step,
// so when the conversation opens with the plugin's manual layout -- user/message before
// step/start -- the step/start is rotated up to the turn and the system message is copied
// in behind it.
//
// Every candidate is validated with the host's own released-v4 validator before it is
// written, and every file is backed up first.
//
// Usage: node scripts/repair-surface-head.mjs [--apply] [--root <sessions dir>] [--checkout <dsh checkout>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const apply = process.argv.includes('--apply');
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
};
const root = argOf('--root', path.join(os.homedir(), '.dsh', 'sessions'));
const checkout = argOf('--checkout', path.join(os.homedir(), 'otherProject', 'deepseek-harness'));

const session = await import(pathToFileURL(path.join(checkout, 'packages/core/session/lib/index.js')).href);
const format = await import(pathToFileURL(path.join(checkout, 'packages/session/session-format-v3-to-v4/lib/index.js')).href);
const known = new Set([...session.KNOWN_SESSION_EVENT_TYPES, 'message-edit/version']);

function findLogs(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findLogs(full));
    else if (entry.name === 'session.v4.jsonl.zstd') found.push(full);
  }
  return found;
}

function artifactOf(wire, events) {
  return {
    header: {
      version: 4,
      id: wire.id,
      createdAt: wire.createdAt,
      isSeeded: wire.isSeeded === true,
      delegationDepth: wire.delegationDepth ?? 0,
      ...wire.cwd === undefined ? {} : { cwd: wire.cwd },
      ...wire.parentSession === undefined ? {} : { parentSession: wire.parentSession },
      ...wire.origin === undefined ? {} : { origin: wire.origin },
      ...wire.agentPreset === undefined ? {} : { agentPreset: wire.agentPreset },
    },
    events,
    inheritedEventCount: wire.seedLength ?? 0,
  };
}

function rejection(wire, events) {
  try {
    const artifact = artifactOf(wire, events);
    format.restoreReleasedV4Artifact(artifact, known);
    format.assertReleasedV4Relationships(artifact, known);
    return undefined;
  } catch (error) {
    return String(error.message);
  }
}

/** Rewrite this log's own seq references through an old -> new map. */
function remapReferences(events, mapping) {
  const move = value => mapping.get(value) ?? value;
  return events.map(event => {
    const data = event.data === undefined ? undefined : { ...event.data };
    if (Array.isArray(data?.messageSeqs)) data.messageSeqs = data.messageSeqs.map(move);
    if (typeof data?.throughSeq === 'number') data.throughSeq = move(data.throughSeq);
    return {
      ...event,
      ...(data === undefined ? {} : { data }),
      ...Array.isArray(event.sourceEventSeqs) ? { sourceEventSeqs: event.sourceEventSeqs.map(move) } : {},
    };
  });
}

/** Rotate the opening step/start above the first user message and copy the head in. */
function rotateHead(wire, events) {
  const firstSurface = events.find(event => event.surfaceOp !== undefined);
  const head = events.find(event => event.type === 'system/message');
  if (firstSurface?.type !== 'user/message' || head === undefined) return undefined;
  const turnStart = events.filter(event => event.type === 'turn/start').find(event => event.seq < firstSurface.seq);
  const stepStart = events.find(event => event.type === 'step/start' && event.seq > firstSurface.seq && event.seq - firstSurface.seq <= 2);
  if (turnStart === undefined || stepStart === undefined || stepStart.data.turn !== turnStart.data.turn) return undefined;
  // A surface message must name the turn and step that are open where it lands; the copy
  // inherits the rotated step/start's coordinates, not its original event's.
  const inserted = {
    ...head,
    time: stepStart.time,
    surfaceOp: 'append',
    data: { ...head.data, turn: stepStart.data.turn, step: stepStart.data.step },
  };
  const rebuilt = [];
  const mapping = new Map();
  for (const event of events) {
    if (event.seq === firstSurface.seq) {
      // turn/start, step/start, system head, then the user message
      rebuilt.push({ ...stepStart, seq: rebuilt.length });
      mapping.set(stepStart.seq, rebuilt.length - 1);
      rebuilt.push({ ...inserted, seq: rebuilt.length });
      rebuilt.push({ ...event, seq: rebuilt.length });
      mapping.set(event.seq, rebuilt.length - 1);
      continue;
    }
    if (event.seq === stepStart.seq) {
      // The original step/start has been rotated up; its slot closes the gap.
      continue;
    }
    rebuilt.push({ ...event, seq: rebuilt.length });
    mapping.set(event.seq, rebuilt.length - 1);
  }
  return remapReferences(rebuilt, mapping);
}

/** Fallback: insert the head straight in, when the surrounding step allows it. */
function insertHead(events) {
  const firstSurface = events.find(event => event.surfaceOp !== undefined);
  const head = events.find(event => event.type === 'system/message');
  if (firstSurface === undefined || head === undefined) return undefined;
  const at = firstSurface.seq;
  const patched = events.map(event => event.seq >= at ? { ...event, seq: event.seq + 1 } : event);
  patched.splice(at, 0, { ...head, seq: at, time: firstSurface.time ?? head.time, surfaceOp: 'append' });
  return patched;
}

let candidates = 0;
let repaired = 0;
for (const file of findLogs(root)) {
  let records;
  try {
    records = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 512 * 1024 * 1024 })
      .toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  } catch {
    continue;
  }
  const wire = records[0];
  const events = records.slice(1);
  if (wire?.type !== 'session') continue;
  const firstSurface = events.find(event => event.surfaceOp !== undefined);
  if (firstSurface === undefined || firstSurface.type === 'system/message') continue;
  const reason = rejection(wire, events);
  if (reason === undefined) continue;
  candidates += 1;
  for (const [strategy, patched] of [['rotate', rotateHead(wire, events)], ['insert', insertHead(events)]]) {
    if (patched === undefined) continue;
    const verdict = rejection(wire, patched);
    console.log(`${apply ? 'REPAIR' : 'WOULD REPAIR'} ${wire.id} reject=${reason} strategy=${strategy} -> ${verdict ?? 'the host validator accepts it'}`);
    if (!apply || verdict !== undefined) continue;
    const encoded = zlib.zstdCompressSync(Buffer.from([wire, ...patched].map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8'));
    const backup = `${file}.bak-surfacehead-${new Date().toISOString().replace(/[:.]/g, '')}`;
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, encoded);
    repaired += 1;
    console.log(`  backed up: ${backup}`);
    break;
  }
}
console.log(`${apply ? 'REPAIRED' : 'CANDIDATES'} ${apply ? repaired : candidates}`);
