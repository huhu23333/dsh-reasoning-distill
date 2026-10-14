#!/usr/bin/env node
// Strip fields the current physical header line does not allow.
//
// session-persistence-jsonl/src/format.ts accepts only type/version/id/createdAt/isSeeded/
// delegationDepth/cwd/parentSession/origin/agentPreset, and the inherited cut is NOT a
// header field -- it lives on the last tagged session/end-seed event. A stray field makes
// the guard reject the first line, so the whole log becomes unreadable. An earlier repair
// in this repository added seedLength; this removes it (and any other stray field).
//
// Usage: node scripts/repair-header-fields.mjs [--apply] [--root <sessions dir>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const apply = process.argv.includes('--apply');
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
};
const root = argOf('--root', path.join(os.homedir(), '.dsh', 'sessions'));
const required = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'];
const allowed = new Set([...required, 'cwd', 'parentSession', 'origin', 'agentPreset']);

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
  const wire = records[0];
  if (wire?.type !== 'session') continue;
  const stray = Object.keys(wire).filter(key => !allowed.has(key));
  if (stray.length === 0) continue;
  candidates += 1;
  const header = Object.fromEntries(Object.entries(wire).filter(([key]) => allowed.has(key)));
  const missing = required.filter(key => !(key in header));
  console.log(`${apply ? 'STRIP' : 'WOULD STRIP'} ${wire.id} fields=${stray.join(',')} missing=${missing.join(',') || 'none'}`);
  if (!apply || missing.length > 0) continue;
  const encoded = zlib.zstdCompressSync(Buffer.from([header, ...records.slice(1)].map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8'));
  const check = JSON.parse(zlib.zstdDecompressSync(encoded).toString('utf8').split('\n')[0]);
  if (Object.keys(check).some(key => !allowed.has(key)) || required.some(key => !(key in check))) {
    console.log('  ABORT (verification failed)');
    continue;
  }
  const backup = `${file}.bak-headerfields-${new Date().toISOString().replace(/[:.]/g, '')}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, encoded);
  repaired += 1;
}
console.log(`${apply ? 'REPAIRED' : 'CANDIDATES'} ${apply ? repaired : candidates}`);
