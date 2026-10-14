#!/usr/bin/env node
// Close the turn a forked branch left open.
//
// Branches created before the fork-closer fix copy a prefix that ends inside the turn
// being compressed, then open their own turn without closing it. The stored log is then
// rejected on reload ("turn/start does not open the expected turn"), which also makes
// the conversation vanish from the session list.
//
// The repair inserts the closers buildForkSeed would have written (step/end for an open
// step, then turn/end with the forked reason) at the point the branch's own turn opens,
// shifting later sequence numbers and the seq references that follow them. Every
// candidate is re-walked and loaded through the host's own Session constructors before
// it is written, and every file is backed up first.
//
// Usage: node scripts/repair-branch-turns.mjs [--apply] [--root <sessions dir>] [--host <session package>]
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
const hostPath = argOf('--host', path.join(os.homedir(), 'otherProject', 'deepseek-harness', 'packages', 'core', 'session', 'lib', 'index.js'));

let host;
try {
  host = await import(pathToFileURL(hostPath).href);
} catch {
  host = undefined;
}

/** Where the log first opens a turn while another is already open. */
function brokenAt(events) {
  let openTurn = null;
  let openStep = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type === 'turn/start') {
      if (openTurn !== null) return { index, openTurn, openStep };
      openTurn = event.data.turn;
      openStep = null;
    } else if (event.type === 'turn/end') {
      openTurn = null;
      openStep = null;
    } else if (event.type === 'step/start') openStep = event.data.step;
    else if (event.type === 'step/end') openStep = null;
  }
  return undefined;
}

function hostAccepts(raw, events) {
  if (host === undefined) return 'structural only';
  const header = {
    version: host.SESSION_FORMAT_VERSION,
    id: host.SessionId(raw.id),
    createdAt: raw.createdAt,
    isSeeded: false,
    ...(raw.parentSession === undefined ? {} : { parentSession: host.SessionId(raw.parentSession) }),
    ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
  };
  try {
    host.Session.fromRestore(host.SessionId(raw.id), events, header, host.SessionLogOffset(0), 'detached');
    host.Session.create(host.SessionId(raw.id), events, header, host.SessionLogOffset(0));
  } catch (error) {
    return `REJECTED ${String(error.message)}`;
  }
  return 'both host paths accept it';
}

function findLogs(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findLogs(full));
    else if (entry.name === 'session.v4.jsonl.zstd') found.push(full);
  }
  return found;
}

let candidates = 0;
let repaired = 0;
for (const file of findLogs(root)) {
  let records;
  try {
    records = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  } catch {
    continue;
  }
  const raw = records[0];
  const events = records.slice(1);
  const broken = brokenAt(events);
  if (raw?.type !== 'session' || broken === undefined) continue;
  candidates += 1;
  const closers = [];
  const time = events[broken.index - 1]?.time ?? raw.createdAt;
  let seq = broken.index;
  if (broken.openStep !== null) closers.push({ type: 'step/end', seq: seq++, time, data: { turn: broken.openTurn, step: broken.openStep } });
  closers.push({ type: 'turn/end', seq: seq++, time, data: { turn: broken.openTurn, reason: { kind: 'forked' } } });
  const shift = closers.length;
  const shifted = [
    ...events.slice(0, broken.index),
    ...closers,
    ...events.slice(broken.index).map(event => ({
      ...event,
      seq: event.seq + shift,
      ...(event.data?.throughSeq !== undefined && event.data.throughSeq >= broken.index ? { data: { ...event.data, throughSeq: event.data.throughSeq + shift } } : {}),
    })),
  ];
  const verdict = hostAccepts(raw, shifted);
  console.log(`${apply ? 'REPAIR' : 'WOULD REPAIR'} ${raw.id} at=${String(broken.index)} closers=${String(shift)} -> ${verdict}`);
  if (!apply || verdict.startsWith('REJECTED') || brokenAt(shifted) !== undefined) continue;
  const encoded = zlib.zstdCompressSync(Buffer.from([raw, ...shifted].map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8'));
  const backup = `${file}.bak-turns-${new Date().toISOString().replace(/[:.]/g, '')}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, encoded);
  repaired += 1;
  console.log(`  backed up: ${backup}`);
}
/**
 * Pass two: a log whose sequence numbers drifted (the host kept appending to a file a
 * repair had already rewritten) is renumbered to the index order it must equal, with
 * every seq reference remapped through the same table.
 */
let gapCandidates = 0;
let gapRepaired = 0;
for (const file of findLogs(root)) {
  let records;
  try {
    records = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  } catch {
    continue;
  }
  const raw = records[0];
  const events = records.slice(1);
  if (raw?.type !== 'session' || events.every((event, index) => event.seq === index)) continue;
  gapCandidates += 1;
  const remap = new Map(events.map((event, index) => [event.seq, index]));
  const fixed = events.map((event, index) => ({
    ...event,
    seq: index,
    ...(event.data?.throughSeq !== undefined && remap.has(event.data.throughSeq)
      ? { data: { ...event.data, throughSeq: remap.get(event.data.throughSeq) } }
      : {}),
    ...(Array.isArray(event.sourceEventSeqs)
      ? { sourceEventSeqs: event.sourceEventSeqs.map(seq => remap.get(seq) ?? seq) }
      : {}),
  }));
  const verdict = hostAccepts(raw, fixed);
  console.log(`${apply ? 'RENUMBER' : 'WOULD RENUMBER'} ${raw.id} events=${String(events.length)} -> ${verdict}`);
  if (!apply || verdict.startsWith('REJECTED') || fixed.some((event, index) => event.seq !== index)) continue;
  const encoded = zlib.zstdCompressSync(Buffer.from([raw, ...fixed].map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8'));
  const backup = `${file}.bak-gaps-${new Date().toISOString().replace(/[:.]/g, '')}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, encoded);
  gapRepaired += 1;
  console.log(`  backed up: ${backup}`);
}
console.log(`${apply ? 'RENUMBERED' : 'GAP CANDIDATES'} ${apply ? gapRepaired : gapCandidates}`);

console.log(`${apply ? 'REPAIRED' : 'CANDIDATES'} ${apply ? repaired : candidates}`);
