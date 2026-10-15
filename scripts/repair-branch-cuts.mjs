#!/usr/bin/env node
// Relabel copied delivery markers that name another Session.
//
// A branch log is a copy of its source, so it carries the source's
// session-log-deepseek/delivery-accepted markers. The v4 relationship check rejects a marker
// that names another Session unless it sits inside the inherited prefix, and an old branch
// (created before the fork marker existed) has no inherited cut at all: its header says
// isSeeded false and the cut is 0. Relabelling those markers to the branch's own id makes the
// log readable without inventing header fields -- session-persistence-jsonl/src/format.ts
// allows no inherited-cut field and recovers the cut from the last tagged session/end-seed
// event, so a header field here would itself invalidate the first line.
//
// Every candidate is validated with the host's own Session constructors before it is written,
// and every file is backed up first. Those constructors are handed a header this script
// *rebuilds* from the fields it knows, so the stored first line never reaches them: it is
// written back verbatim, and a stray or missing key on it would pass the gate above while the
// read path still refuses the whole log over that line alone. The line is therefore checked on
// its own, against the same guard the read path applies to it (see `headerLineRefusal`), and a
// log whose line fails that guard is refused here and left byte-identical.
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
const checkout = argOf('--checkout', path.join(os.homedir(), 'otherProject', 'deepseek-harness'));

// The authoritative gate: the same released-v4 validation the persistence read path runs.
const format = await import(pathToFileURL(path.join(checkout, 'packages/session/session-format-v3-to-v4/lib/index.js')).href);

let host;
try {
  host = await import(pathToFileURL(hostPath).href);
} catch {
  host = undefined;
  console.error('note: host Session package not found; structural verification only');
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
 * The physical first line's own admissibility to the read path.
 *
 * Both gates below (`formatRejects`, `hostAccepts`) hand the host a header this script
 * *rebuilds* from the fields it knows, so the stored line is never judged by a reader; it is
 * written back verbatim, so a stray key on it survives the write and the read path refuses the
 * whole log over that line alone (`isHeaderLine` in session-persistence-jsonl/src/format.ts
 * accepts exactly the required keys plus `cwd`/`parentSession`/`origin`/`agentPreset`). The key
 * set is the same one the sibling `repair-header-fields.mjs` repairs against.
 * @param wire - the stored `session` record, exactly as it will be written back.
 * @returns `undefined` when the line is one the read path accepts, else why the write is refused.
 */
function headerLineRefusal(wire) {
  const required = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'];
  const allowed = new Set([...required, 'cwd', 'parentSession', 'origin', 'agentPreset']);
  const stray = Object.keys(wire).filter(key => !allowed.has(key));
  if (stray.length > 0) {
    return `SKIP writing: the physical header line carries ${stray.join(',')} the read path refuses; run repair-header-fields.mjs first`;
  }
  const missing = required.filter(key => !(key in wire));
  if (missing.length > 0) return `SKIP writing: the physical header line lacks ${missing.join(',')}`;
  return undefined;
}

/** The reason the host's released-v4 validation refuses this log, or undefined. */
function formatRejects(raw, events) {
  const artifact = {
    header: {
      version: 4,
      id: raw.id,
      createdAt: raw.createdAt,
      isSeeded: raw.isSeeded === true,
      delegationDepth: raw.delegationDepth ?? 0,
      ...raw.cwd === undefined ? {} : { cwd: raw.cwd },
      ...raw.parentSession === undefined ? {} : { parentSession: raw.parentSession },
      ...raw.origin === undefined ? {} : { origin: raw.origin },
      ...raw.agentPreset === undefined ? {} : { agentPreset: raw.agentPreset },
    },
    events,
    inheritedEventCount: events.filter(event => event.type === 'session/end-seed' && event.data?.inherited === true).at(-1)?.seq ?? 0,
  };
  try {
    format.restoreReleasedV4Artifact(artifact, new Set([...(host?.KNOWN_SESSION_EVENT_TYPES ?? []), 'message-edit/version']));
    format.assertReleasedV4Relationships(artifact, new Set([...(host?.KNOWN_SESSION_EVENT_TYPES ?? []), 'message-edit/version']));
    return undefined;
  } catch (error) {
    return String(error.message);
  }
}

/** Load the candidate through both host paths, exactly as the host would. */
function hostAccepts(raw, events) {
  // The stored first line is written back verbatim and neither host path below ever sees it, so
  // its own admissibility is the one thing this gate cannot learn from the host; `repair-branch-cuts`
  // must not report a log the read path still refuses over that line.
  const line = headerLineRefusal(raw);
  if (line !== undefined) return { ok: false, detail: line };
  if (host === undefined) return { ok: true, detail: 'structural only' };
  const header = {
    version: host.SESSION_FORMAT_VERSION,
    id: host.SessionId(raw.id),
    createdAt: raw.createdAt,
    isSeeded: raw.isSeeded === true,
    ...(raw.parentSession === undefined ? {} : { parentSession: host.SessionId(raw.parentSession) }),
    ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
  };
  const id = host.SessionId(raw.id);
  const offset = host.SessionLogOffset(0);
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
    records = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 512 * 1024 * 1024 })
      .toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  } catch {
    continue;
  }
  const raw = records[0];
  if (raw?.type !== 'session') continue;
  const events = records.slice(1);
  const foreign = events.filter(event => event.type === 'session-log-deepseek/delivery-accepted'
    && typeof event.data?.sessionId === 'string' && event.data.sessionId !== raw.id);
  if (foreign.length === 0) continue;
  // Only a log the host actually refuses is a candidate: a foreign marker inside the
  // inherited prefix (cut = the last tagged session/end-seed event) is legitimate.
  if (formatRejects(raw, events) === undefined) continue;
  candidates += 1;
  const foreignSet = new Set(foreign);
  const rewritten = events.map(event => foreignSet.has(event)
    ? { ...event, data: { ...event.data, sessionId: raw.id } }
    : event);
  const verdict = hostAccepts(raw, rewritten);
  console.log(`${apply ? 'REPAIR' : 'WOULD REPAIR'} ${raw.id} relabelledMarkers=${String(foreign.length)} -> ${verdict.detail}`);
  if (!apply || !verdict.ok) continue;
  const encoded = zlib.zstdCompressSync(Buffer.from([raw, ...rewritten].map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8'));
  const backup = `${file}.bak-branchcuts-${new Date().toISOString().replace(/[:.]/g, '')}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, encoded);
  repaired += 1;
}
console.log(`${apply ? 'REPAIRED' : 'CANDIDATES'} ${apply ? repaired : candidates}`);
