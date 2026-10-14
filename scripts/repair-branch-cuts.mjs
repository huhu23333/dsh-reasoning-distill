#!/usr/bin/env node
// Repair session logs whose inherited cut was never persisted.
//
// A branch created before the fork-marker fix stores no `seedLength`, so a reload
// derives no inherited prefix; a copied session-log-deepseek/delivery-accepted marker
// (it names the source session) then fails the v4 relationship check, and a snapshot
// load additionally requires a session/end-seed marker at the cut index.
//
// The host's own convention (buildForkSeed) is that the inherited cut *is* the seq of
// its `session/end-seed { inherited: true }` marker, so the last such marker gives the
// length to persist. Every candidate is validated with the host's own Session
// constructors before anything is written.
//
// Usage: node scripts/repair-branch-cuts.mjs [--apply] [--root <sessions dir>] [--host <session package>]
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
  console.error('note: host Session package not found; structural verification only');
}

function decode(file) {
  return execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8');
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

/** Load the candidate through both host paths, exactly as the host would. */
function hostAccepts(raw, events, cut, seeded = true) {
  if (host === undefined) return { ok: true, detail: 'structural only' };
  const header = {
    version: host.SESSION_FORMAT_VERSION,
    id: host.SessionId(raw.id),
    createdAt: raw.createdAt,
    isSeeded: seeded,
    ...(raw.parentSession === undefined ? {} : { parentSession: host.SessionId(raw.parentSession) }),
    ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
  };
  const id = host.SessionId(raw.id);
  const offset = host.SessionLogOffset(cut);
  try {
    host.Session.fromRestore(id, events, header, offset, 'detached');
  } catch (error) {
    return { ok: false, detail: `restore: ${String(error.message)}` };
  }
  try {
    host.Session.create(id, events, header, offset);
  } catch (error) {
    return { ok: false, detail: `snapshot: ${String(error.message)}` };
  }
  return { ok: true, detail: 'both host paths accept it' };
}

let candidates = 0;
let repaired = 0;
for (const file of findLogs(root)) {
  let records;
  try {
    records = decode(file).trim().split('\n').map(line => JSON.parse(line));
  } catch (error) {
    console.log('SKIP (undecodable)', file, String(error).slice(0, 80));
    continue;
  }
  const raw = records[0];
  if (raw?.type !== 'session' || raw.seedLength !== undefined) continue;
  const events = records.slice(1);
  const foreign = events.filter(event => event.type === 'session-log-deepseek/delivery-accepted'
    && typeof event.data?.sessionId === 'string' && event.data.sessionId !== raw.id);
  const markers = events.filter(event => event.type === 'session/end-seed' && event.data?.inherited === true);
  // A seeded header that never persisted its cut is equally unreadable ("seeded header
  // disagrees with its last inherited end-seed marker"), with or without copied markers.
  const seededWithoutCut = raw.isSeeded === true && markers.length > 0;
  if (foreign.length === 0 && !seededWithoutCut) continue;
  candidates += 1;
  const cut = markers.at(-1)?.seq;
  const cutUsable = cut !== undefined && cut > 0 && !foreign.some(marker => marker.seq >= cut);
  let patched;
  let detail;
  if (cutUsable) {
    // Strategy A: the host marked an inherited cut; record it as the prefix length.
    const header = { ...raw, seedLength: cut };
    detail = `cut=${String(cut)} ${hostAccepts(header, events, cut).detail}`;
    patched = [header, ...events];
  } else {
    // Strategy B: the log is a plain copy with no inherited cut, so its delivery
    // markers must name this session. Rewriting them keeps the header unseeded, and
    // both host paths then accept the log unchanged otherwise.
    const foreignSet = new Set(foreign);
    const rewritten = events.map(event => foreignSet.has(event)
      ? { ...event, data: { ...event.data, sessionId: raw.id } }
      : event);
    detail = `relabelledMarkers=${String(foreign.length)} ${hostAccepts(raw, rewritten, 0, false).detail}`;
    patched = [raw, ...rewritten];
  }
  const encoded = zlib.zstdCompressSync(Buffer.from(patched.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8'));
  const check = JSON.parse(zlib.zstdDecompressSync(encoded).toString('utf8').split('\n')[0]);
  const accepted = detail.includes('accept it') || detail.includes('structural only');
  console.log(`${apply ? 'REPAIR' : 'WOULD REPAIR'} ${raw.id} ${detail}`);
  if (!apply || !accepted || check.type !== 'session') continue;
  const backup = `${file}.bak-repair-${new Date().toISOString().replace(/[:.]/g, '')}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, encoded);
  repaired += 1;
  console.log(`  backed up: ${backup}`);
}
console.log(`${apply ? 'REPAIRED' : 'CANDIDATES'} ${apply ? repaired : candidates}`);
