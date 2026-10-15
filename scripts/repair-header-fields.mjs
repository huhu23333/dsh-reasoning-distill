#!/usr/bin/env node
// Strip fields the current physical header line does not allow.
//
// session-persistence-jsonl/src/format.ts accepts only type/version/id/createdAt/isSeeded/
// delegationDepth/cwd/parentSession/origin/agentPreset, and the inherited cut is NOT a
// header field -- it lives on the last tagged session/end-seed event. A stray field makes
// the guard reject the first line, so the whole log becomes unreadable. An earlier repair
// in this repository added seedLength; this removes it (and any other stray field).
//
// The header keys are the script's own business; whether the *host* can read the result is
// not. So nothing is written until the host's own readers accept the candidate: it is
// re-walked through `Session.fromRestore`/`create` and through the released-v4
// `restoreReleasedV4Artifact`/`assertReleasedV4Relationships` pair -- the same pair
// `scan-session-logs.mjs` runs to report which stored logs the read path will refuse. A
// candidate either reader refuses -- or that cannot be checked because a reader is not
// importable here -- is reported and left byte-identical, because a log the host still
// refuses is exactly what this script must not report as repaired.
//
// One exception, on request: a log that carries BOTH a stray header field and an
// event-level defect is a deadlock. The event repair scripts refuse a first line the read
// path refuses, and this script's whole-log self-check refuses the event-level defect, so
// no script order could repair it. `--line-only` breaks the deadlock by writing the
// stripped first line WITHOUT the whole-log verdict: the result is not claimed to be a
// repaired log -- the event repair script must run next, and it writes only after its own
// whole-log self-check passes. The default (without the flag) keeps the self-check
// semantics unchanged.
//
// Usage: node scripts/repair-header-fields.mjs [--apply] [--line-only] [--root <sessions dir>] [--host <session package>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const apply = process.argv.includes('--apply');
const lineOnly = process.argv.includes('--line-only');
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
};
const root = argOf('--root', path.join(os.homedir(), '.dsh', 'sessions'));
const hostPath = argOf('--host', path.join(os.homedir(), 'otherProject', 'deepseek-harness', 'packages', 'core', 'session', 'lib', 'index.js'));

// The host that is going to read the repaired log. `Session.fromRestore`/`create` re-walk the
// stored events the way a reload does; without the package there is no proof to write against.
let session;
try {
  session = await import(pathToFileURL(hostPath).href);
} catch {
  console.error('host session package not found; pass --host');
  process.exit(2);
}

// The host's released-v4 validator, which adds the relationship validation (a developer
// message's `headerSeq`, a replacement range, a delivery `throughSeq`) that replaying the
// events alone cannot express. A host that cannot supply it (a published install without the
// format package) refuses the write below rather than certifying a log it cannot read.
let format;
try {
  format = await import('@deepseek-ai/dsh-session-format-v3-to-v4');
} catch {
  format = undefined;
}

// The event types the persistence read path knows. `scan-session-logs.mjs` reproduces that
// path and adds the message-edit plugin's own type to the host's list, because a log carrying
// it loads fine; a check stricter than the reader would refuse a repair the host would accept.
const known = new Set([...session.KNOWN_SESSION_EVENT_TYPES, 'message-edit/version']);

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

/**
 * The host's own verdict on the log a write would store.
 *
 * The stripped header only fixes one way a log can be unreadable; a dangling reference, a
 * message outside its turn or an unknown event type leaves it refused with or without it.
 * Both host readers run on the candidate, and a validator that is not importable here
 * certifies nothing: each of those is a refusal, never a "repaired".
 * @param wire - the candidate `session` record, after the stray fields were stripped.
 * @param events - the candidate events.
 * @returns `undefined` when both host readers accept, else why the write is refused.
 */
function refusal(wire, events) {
  if (format === undefined) return 'SKIP writing: the host released-v4 validator is not importable here';
  const artifact = {
    header: {
      version: 4,
      id: wire.id,
      createdAt: wire.createdAt,
      isSeeded: wire.isSeeded === true,
      delegationDepth: wire.delegationDepth ?? 0,
      ...(wire.cwd === undefined ? {} : { cwd: wire.cwd }),
      ...(wire.parentSession === undefined ? {} : { parentSession: wire.parentSession }),
      ...(wire.origin === undefined ? {} : { origin: wire.origin }),
      ...(wire.agentPreset === undefined ? {} : { agentPreset: wire.agentPreset }),
    },
    events,
    // The current format keeps the inherited cut on the last tagged session/end-seed event;
    // the physical header has no such field (a stray one makes the first line invalid).
    inheritedEventCount: events.filter(event => event.type === 'session/end-seed' && event.data?.inherited === true).at(-1)?.seq ?? 0,
  };
  try {
    format.restoreReleasedV4Artifact(artifact, known);
    format.assertReleasedV4Relationships(artifact, known);
  } catch (error) {
    return `SKIP writing: the host released-v4 validator rejects it: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (typeof session.Session?.fromRestore !== 'function' || typeof session.Session?.create !== 'function') {
    return 'SKIP writing: the host Session constructors are not available here';
  }
  const header = {
    version: session.SESSION_FORMAT_VERSION,
    id: session.SessionId(wire.id),
    createdAt: wire.createdAt,
    isSeeded: wire.isSeeded === true,
    ...(wire.cwd === undefined ? {} : { cwd: wire.cwd }),
    ...(wire.parentSession === undefined ? {} : { parentSession: session.SessionId(wire.parentSession) }),
  };
  try {
    session.Session.fromRestore(session.SessionId(wire.id), events, header, session.SessionLogOffset(0), 'detached');
    session.Session.create(session.SessionId(wire.id), events, header, session.SessionLogOffset(0));
  } catch (error) {
    return `SKIP writing: the host Session constructors reject it: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
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
  const candidate = zlib.zstdDecompressSync(encoded).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  const check = candidate[0];
  if (Object.keys(check).some(key => !allowed.has(key)) || required.some(key => !(key in check))) {
    console.log('  ABORT (verification failed)');
    continue;
  }
  // The encode above proves the bytes round-trip and the keys are clean; this is the host's
  // own verdict on what they say. A refusal here is the whole point: the log has to be one
  // the host reads, not merely one whose first line this script likes. `--line-only` skips
  // this verdict on request: the stripped line is written so the event repair script can
  // run its own whole-log self-check afterwards, and nothing here claims the log is fixed.
  const verdict = lineOnly ? undefined : refusal(check, candidate.slice(1));
  if (verdict !== undefined) {
    console.log(`  ${verdict}`);
    continue;
  }
  const backup = `${file}.bak-headerfields-${new Date().toISOString().replace(/[:.]/g, '')}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, encoded);
  repaired += 1;
  if (lineOnly) console.log('  LINE-ONLY: wrote the stripped first line without a whole-log verdict; run the event repair script next (it writes only after its own self-check passes)');
}
console.log(`${apply ? 'REPAIRED' : 'CANDIDATES'} ${apply ? repaired : candidates}`);
