#!/usr/bin/env node
// Mark plugin-owned events ignorable in stored logs.
//
// The persistence storage contract refuses to interpret a log that contains an event
// type the harness does not know unless the envelope carries `ignorable: true`
// (session-persistence/src/storage-contract.ts). A message-edit/version record written
// without it makes the whole session refuse to load, which also drops it from the
// session list. Adding the flag changes neither a sequence number nor a payload.
//
// Usage: node scripts/repair-plugin-events.mjs [--apply] [--root <sessions dir>] [--host <session package>]
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

let known;
try {
  const host = await import(pathToFileURL(hostPath).href);
  known = host.KNOWN_SESSION_EVENT_TYPES;
} catch {
  console.error('host session package not found; pass --host');
  process.exit(2);
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
    records = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 512 * 1024 * 1024 })
      .toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  } catch {
    continue;
  }
  const raw = records[0];
  if (raw?.type !== 'session') continue;
  const events = records.slice(1);
  const blind = events.filter(event => !known.has(event.type) && event.ignorable !== true);
  // A log written while it was still live can carry a tail whose seqs drifted out of
  // step with its positions (the host appended with its own numbering meanwhile).
  // Every reference field points backwards, so renumbering to the position is safe.
  const drifted = events.filter((event, index) => event.seq !== index).length;
  if (blind.length === 0 && drifted === 0) continue;
  candidates += 1;
  const types = [...new Set(blind.map(event => event.type))].join(',');
  console.log(`${apply ? 'REPAIR' : 'WOULD REPAIR'} ${raw.id} blindEvents=${String(blind.length)} types=${types} driftedSeqs=${String(drifted)}`);
  if (!apply) continue;
  const patched = [raw, ...events.map((event, index) => ({
    ...event,
    ...event.seq === index ? {} : { seq: index },
    ...(!known.has(event.type) && event.ignorable !== true) ? { ignorable: true } : {},
  }))];
  const encoded = zlib.zstdCompressSync(Buffer.from(patched.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8'));
  const check = zlib.zstdDecompressSync(encoded).toString('utf8').trim().split('\n').map(line => JSON.parse(line)).slice(1);
  const balanced = check.every((event, index) => event.seq === index) && check.every(event => known.has(event.type) || event.ignorable === true);
  if (!balanced) { console.log('  ABORT (verification failed)'); continue; }
  const backup = `${file}.bak-ignorable-${new Date().toISOString().replace(/[:.]/g, '')}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, encoded);
  repaired += 1;
  console.log(`  backed up: ${backup}`);
}
console.log(`${apply ? 'REPAIRED' : 'CANDIDATES'} ${apply ? repaired : candidates}`);
