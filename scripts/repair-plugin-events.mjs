#!/usr/bin/env node
// Mark plugin-owned events ignorable in stored logs, and renumber a drifted sequence.
//
// The persistence storage contract refuses to interpret a log that contains an event
// type the harness does not know unless the envelope carries `ignorable: true`
// (session-persistence/src/storage-contract.ts). A message-edit/version record written
// without it makes the whole session refuse to load, which also drops it from the
// session list. That flag changes neither a sequence number nor a payload.
//
// A log whose seqs no longer equal their positions is renumbered through the host's own
// event-reference remap (`renumber` below), so the numbers other events refer to move with
// them; a reference that cannot be placed refuses the file rather than being left stale.
// When that remap is unavailable the log is reported and left untouched.
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

// The host's own event-reference remap, imported from its sources because the built
// package does not re-export it. It is what makes renumbering a drifted log safe: it
// moves `surfaceOp`'s `startSeq`/`endSeq`, `sourceEventSeqs`, a compaction's
// `shadowedRange`/`shadowedSeqs`, a title's `messageSeqs`, `command/done`'s
// `sourceEventSeq` and `image/offload`'s targets with the numbers, and it refuses a
// reference that does not name an earlier event. A host that cannot be imported (a
// published install without sources, or a Node without type stripping) leaves this
// undefined; a drifted log is then reported instead of renumbered, because renumbering
// without the remap is exactly what this script must not do.
let remapV3References;
try {
  ({ remapV3References } = await import('@deepseek-ai/dsh-session-format-v3-to-v4/src/references.ts'));
} catch {
  remapV3References = undefined;
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

/**
 * Renumber one log's events to their positions, moving every reference with them.
 *
 * The reference fields are the host's business, not this script's: `remapV3References` is
 * the function the host itself calls when it renumbers events, so every field it covers
 * follows the numbers and a reference that names no earlier stored event refuses the whole
 * file instead of being carried over stale. That remap does not cover a delivery marker's
 * `data.throughSeq`, which is remapped here; an unexpected `throughSeq` elsewhere also
 * refuses rather than passing through untouched.
 * @param events - stored events in file order, with strictly increasing, distinct seqs.
 * @returns the events with their positions as seqs and every reference remapped.
 */
function renumber(events) {
  const mapping = [];
  events.forEach((event, index) => { mapping[event.seq] = index; });
  const reference = (value, owner) => {
    const target = typeof value === 'number' ? mapping[value] : undefined;
    if (target === undefined || value >= owner) throw new Error(`reference ${String(value)} does not name an earlier stored event`);
    return target;
  };
  return events.map((event, index) => {
    let out = remapV3References(event, index, mapping);
    const data = out.data;
    if (data !== null && typeof data === 'object' && data.throughSeq !== undefined) {
      if (out.type !== 'session-log-deepseek/delivery-accepted') throw new Error(`unknown throughSeq on ${String(out.type)}`);
      out = { ...out, data: { ...data, throughSeq: reference(data.throughSeq, event.seq) } };
    }
    return out;
  });
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
  // Renumbering it to the position rewrites numbers other events refer to, so the
  // references have to move with it; `renumber` does that and refuses a reference it
  // cannot place.
  const drifted = events.filter((event, index) => event.seq !== index).length;
  if (blind.length === 0 && drifted === 0) continue;
  candidates += 1;
  const types = [...new Set(blind.map(event => event.type))].join(',');
  console.log(`${apply ? 'REPAIR' : 'WOULD REPAIR'} ${raw.id} blindEvents=${String(blind.length)} types=${types} driftedSeqs=${String(drifted)}`);
  if (!apply) continue;
  // Both prerequisites are refusals, never a partial repair: the stored sequence has to
  // run strictly forwards, and the host's reference remap has to be available here.
  const forwards = events.every((event, index) => index === 0 || event.seq > events[index - 1].seq);
  if (drifted > 0 && (remapV3References === undefined || !forwards)) {
    console.log(remapV3References === undefined
      ? '  SKIP renumbering: the host event-reference remap is not importable here'
      : '  SKIP renumbering: the stored sequence is not strictly increasing');
    continue;
  }
  let renumbered;
  try {
    renumbered = drifted === 0 ? events : renumber(events);
  } catch (error) {
    console.log(`  SKIP renumbering: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const patched = [raw, ...renumbered.map(event => ({
    ...event,
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
