#!/usr/bin/env node
// Re-point inherited hand-offs in stored ledgers.
//
// A branch inherits its source's ledger, and a rewrite that was handed off to that source
// is in force in the copy as well: the copy carries the rewritten history. Ledgers written
// before the engine re-pointed the destination therefore name an ancestor, so the panel
// reads those entries as applied elsewhere — reporting a compression whose effect is plainly
// still in the history as "moved to a branch (not applied here)".
//
// Only a destination that is an ancestor of the owning session is rewritten; a hand-off to
// a sibling branch really did move the rewrite away and is left alone.
//
// Usage: node scripts/repair-branch-ledgers.mjs [--apply] [--home <DSH_HOME>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkoutFromArgv, dshHome } from './lib/dsh-paths.mjs';

const apply = process.argv.includes('--apply');
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
};
const home = argOf('--home', dshHome());
const ledgerDir = path.join(home, 'reasoning-distill');
const sessionsRoot = path.join(home, 'sessions');

/** The stored log header's parentSession for one session id, when the log is there. */
function parentOf(id) {
  for (const project of fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot) : []) {
    const file = path.join(sessionsRoot, project, id, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    try {
      const head = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 8 * 1024 * 1024 }).toString('utf8').split('\n')[0];
      return JSON.parse(head).parentSession;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Every ancestor of one session id, following parentSession with a cycle guard. */
function ancestorsOf(id) {
  const chain = new Set();
  let current = parentOf(id);
  let guard = 0;
  while (typeof current === 'string' && current !== '' && guard < 64 && !chain.has(current)) {
    chain.add(current);
    current = parentOf(current);
    guard += 1;
  }
  return chain;
}

let scanned = 0;
let affected = 0;
let repaired = 0;
for (const name of fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir) : []) {
  if (!name.endsWith('.json')) continue;
  const file = path.join(ledgerDir, name);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.log('SKIP (unreadable)', name);
    continue;
  }
  scanned += 1;
  const id = record.sessionId;
  if (typeof id !== 'string' || !Array.isArray(record.entries)) continue;
  const chain = ancestorsOf(id);
  const stale = record.entries.filter(entry => entry?.handoff?.state === 'created'
    && typeof entry.handoff.branchId === 'string' && entry.handoff.branchId !== id && chain.has(entry.handoff.branchId));
  if (stale.length === 0) continue;
  affected += 1;
  const points = [...new Set(stale.map(entry => entry.handoff.branchId))];
  console.log(`${apply ? 'REPAIR' : 'WOULD REPAIR'} ${id} entries=${String(record.entries.length)} re-pointed=${String(stale.length)} from=${points.map(value => value.slice(-8)).join(',')}`);
  if (!apply) continue;
  for (const entry of stale) entry.handoff = { ...entry.handoff, branchId: id };
  const backup = `${file}.bak-ledger-${new Date().toISOString().replace(/[:.]/g, '')}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  // Read the result back: the rewrite is only trusted when the stored file proves it.
  const check = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stillStale = (check.entries ?? []).some(entry => entry?.handoff?.state === 'created'
    && typeof entry.handoff.branchId === 'string' && entry.handoff.branchId !== id && chain.has(entry.handoff.branchId));
  if (stillStale) {
    console.log('  ABORT (verification failed)');
    continue;
  }
  repaired += 1;
  console.log(`  backed up: ${backup}`);
}
console.log(`${apply ? 'SCANNED' : 'SCANNED'} ${String(scanned)}  ${apply ? 'REPAIRED' : 'AFFECTED'} ${String(apply ? repaired : affected)}`);
