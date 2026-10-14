#!/usr/bin/env node
// Run the host's own released-v4 format validation over every stored Session log.
//
// The persistence read path maps a wire header to an artifact and then calls
// restoreReleasedV4Artifact + assertReleasedV4Relationships. Reproducing that here
// reports exactly which stored logs the host will refuse, and why -- before a restart.
//
// Usage: node scripts/scan-session-logs.mjs [--root <sessions dir>] [--all]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
};
const root = argOf('--root', path.join(os.homedir(), '.dsh', 'sessions'));
const checkout = argOf('--checkout', path.join(os.homedir(), 'otherProject', 'deepseek-harness'));

const session = await import(pathToFileURL(path.join(checkout, 'packages/core/session/lib/index.js')).href);
const format = await import(pathToFileURL(path.join(checkout, 'packages/session/session-format-v3-to-v4/lib/index.js')).href);
const known = new Set([...session.KNOWN_SESSION_EVENT_TYPES, "message-edit/version"]);

function findLogs(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findLogs(full));
    else if (entry.name === 'session.v4.jsonl.zstd') found.push(full);
  }
  return found;
}

let ok = 0;
const failures = new Map();
for (const file of findLogs(root)) {
  let records;
  try {
    records = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 512 * 1024 * 1024 })
      .toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  } catch (error) {
    failures.set(String(error).slice(0, 60), [...(failures.get(String(error).slice(0, 60)) ?? []), path.basename(path.dirname(file))]);
    continue;
  }
  const wire = records[0];
  const events = records.slice(1);
  // The physical first line allows only these keys (session-persistence-jsonl/src/format.ts):
  // the inherited cut is NOT a header field, it lives on the last tagged session/end-seed
  // event. A stray field makes the line fail its guard and the log unreadable.
  const allowedHeaderKeys = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth', 'cwd', 'parentSession', 'origin', 'agentPreset'];
  const strayKeys = Object.keys(wire).filter(key => !allowedHeaderKeys.includes(key));
  if (strayKeys.length > 0 || ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'].some(key => !(key in wire))) {
    const reason = strayKeys.length > 0
      ? `header line has unexpected field ${strayKeys.join(',')}`
      : 'header line lacks a required field';
    failures.set(reason, [...(failures.get(reason) ?? []), path.basename(path.dirname(file))]);
    continue;
  }
  const lastInherited = events.filter(event => event.type === 'session/end-seed' && event.data?.inherited === true).at(-1)?.seq ?? 0;
  const header = {
    version: 4,
    id: wire.id,
    createdAt: wire.createdAt,
    isSeeded: wire.isSeeded === true,
    delegationDepth: wire.delegationDepth ?? 0,
    ...wire.cwd === undefined ? {} : { cwd: wire.cwd },
    ...wire.parentSession === undefined ? {} : { parentSession: wire.parentSession },
    ...wire.origin === undefined ? {} : { origin: wire.origin },
    ...wire.agentPreset === undefined ? {} : { agentPreset: wire.agentPreset },
  };
  const artifact = { header, events, inheritedEventCount: lastInherited };
  try {
    format.restoreReleasedV4Artifact(artifact, known);
    format.assertReleasedV4Relationships(artifact, known);
    ok += 1;
  } catch (error) {
    const reason = String(error.message);
    failures.set(reason, [...(failures.get(reason) ?? []), path.basename(path.dirname(file))]);
  }
}

console.log(`VALID ${String(ok)}`);
for (const [reason, ids] of failures) console.log(`INVALID x${String(ids.length)}: ${reason}\n  ${ids.slice(0, 12).join(' ')}\n  ...`);
