#!/usr/bin/env node
// Repair branches whose stored log predates the fork marker.
//
// Such a session has no `seedLength` in its header, so a reload derives no inherited
// prefix; a copied session-log-deepseek/delivery-accepted marker (it names the source
// session) then fails the v4 relationship check and the conversation cannot load.
//
// The inherited prefix of a message-edit branch ends exactly where its own version
// record was appended, so the last message-edit/version seq is the cut.
//
// Usage: node scripts/repair-branch-cuts.mjs [--apply] [--root <sessions dir>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const apply = process.argv.includes('--apply');
const rootIndex = process.argv.indexOf('--root');
const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : path.join(os.homedir(), '.dsh', 'sessions');

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
  const header = records[0];
  if (header?.type !== 'session' || header.seedLength !== undefined) continue;
  const events = records.slice(1);
  const foreign = events.filter(event => event.type === 'session-log-deepseek/delivery-accepted'
    && typeof event.data?.sessionId === 'string' && event.data.sessionId !== header.id);
  if (foreign.length === 0) continue;
  candidates += 1;
  const versions = events.filter(event => event.type === 'message-edit/version');
  const cut = versions.at(-1)?.seq;
  if (cut === undefined || cut <= 0) {
    console.log('NEEDS REVIEW (no version record)', header.id, file);
    continue;
  }
  const stillOutside = foreign.filter(event => event.seq >= cut);
  console.log(`${apply ? 'REPAIR' : 'WOULD REPAIR'} ${header.id} cut=${String(cut)} markers=${String(foreign.length)} outside-cut=${String(stillOutside.length)}`);
  if (!apply || stillOutside.length > 0) continue;
  const patched = [{ ...header, seedLength: cut }, ...events];
  const encoded = zlib.zstdCompressSync(Buffer.from(patched.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8'));
  // Verify the round trip before touching the original.
  const check = JSON.parse(zlib.zstdDecompressSync(encoded).toString('utf8').split('\n')[0]);
  if (check.seedLength !== cut) { console.log('ABORT (round trip mismatch)', header.id); continue; }
  const backup = `${file}.bak-repair-${new Date().toISOString().replace(/[:.]/g, '')}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, encoded);
  repaired += 1;
  console.log(`  backed up: ${backup}`);
}
console.log(`${apply ? 'REPAIRED' : 'CANDIDATES'} ${apply ? repaired : candidates}`);
