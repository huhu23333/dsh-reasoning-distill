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
  const header = {
    version: 4,
    id: wire.id,
    createdAt: wire.createdAt,
    // The wire header carries isSeeded itself; seedLength is the inherited count, present
    // only once the fork cut is persisted.
    isSeeded: wire.isSeeded === true,
    delegationDepth: wire.delegationDepth ?? 0,
    ...wire.cwd === undefined ? {} : { cwd: wire.cwd },
    ...wire.parentSession === undefined ? {} : { parentSession: wire.parentSession },
    ...wire.origin === undefined ? {} : { origin: wire.origin },
    ...wire.agentPreset === undefined ? {} : { agentPreset: wire.agentPreset },
  };
  const artifact = { header, events, inheritedEventCount: wire.seedLength ?? 0 };
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
