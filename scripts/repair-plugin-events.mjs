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
// them, including the reference fields that remap does not cover; a reference that cannot be
// placed refuses the file rather than being left stale. When that remap is unavailable the
// log is reported and left untouched.
//
// Nothing is written until the host's own readers accept the result: the candidate is
// re-walked through `Session.fromRestore`/`create` and through the released-v4
// `restoreReleasedV4Artifact`/`assertReleasedV4Relationships` pair before it is encoded, the
// same way the sibling repair scripts do it. A candidate either reader refuses -- or that
// cannot be checked because a reader is not importable here -- is reported and left
// byte-identical, because a log whose numbers or references are wrong is exactly what this
// script must not report as repaired.
//
// Both readers are handed a header the script rebuilds from the fields it knows, so the
// *physical* first line never reaches them: a stray key there would pass the gate above and
// this script would report a log the read path still refuses over its first line alone. The
// line is impossible for this script to certify that way, so it is checked against the same
// guard the read path applies to it (see `headerLineRefusal`), and a log whose line fails
// that guard is refused here and left byte-identical: run `repair-header-fields.mjs` for it
// first, then this one.
//
// Usage: node scripts/repair-plugin-events.mjs [--apply] [--root <sessions dir>] [--host <session package>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { checkoutFromArgv, dshHome } from './lib/dsh-paths.mjs';

const apply = process.argv.includes('--apply');
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
};
const root = argOf('--root', path.join(dshHome(), 'sessions'));
const checkout = checkoutFromArgv(process.argv).root;
const hostPath = argOf('--host', path.join(checkout, 'packages', 'core', 'session', 'lib', 'index.js'));

let session;
try {
  session = await import(pathToFileURL(hostPath).href);
} catch {
  console.error('host session package not found; pass --host');
  process.exit(2);
}
const known = session.KNOWN_SESSION_EVENT_TYPES;

// The host's released-v4 validator, imported from the same package the event-reference remap
// comes from. `Session.fromRestore`/`create` re-walk the stored events the way a reload does;
// this pair adds the relationship validation (a developer message's `headerSeq`, a
// replacement range, a delivery `throughSeq`) that the numbering alone cannot express. A host
// that cannot supply it (a published install without the format package) refuses the write
// below rather than certifying a log it cannot read.
let format;
try {
  format = await import('@deepseek-ai/dsh-session-format-v3-to-v4');
} catch {
  format = undefined;
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
 * file instead of being carried over stale. Two reference fields it does not cover are moved
 * here, each guarded by the event type that owns it: a delivery marker's `data.throughSeq`
 * and a developer message's `data.headerSeq`. The second one is enforced by the host's own
 * relationship validation (`developer/message headerSeq must reference an earlier
 * request/header`) even though no remap moves it, so a rewrite that leaves it behind either
 * produces a log the host refuses or -- when the old number lands on another valid
 * `request/header` -- one whose developer message binds to the wrong header.
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
    const move = value => reference(value, event.seq);
    let out = remapV3References(event, index, mapping);
    out = remapUncoveredReference(event, out, 'throughSeq', 'session-log-deepseek/delivery-accepted', move);
    out = remapUncoveredReference(event, out, 'headerSeq', 'developer/message', move);
    return out;
  });
}

/**
 * Move one reference field the host's remap does not cover, for the event type that owns it.
 *
 * The field is moved only while the host left it alone, so a host remap that later covers it
 * is followed rather than moved twice. A field on any other event type refuses the file
 * instead of being carried over untouched.
 * @param source - the stored event before the remap.
 * @param out - the event the host remap returned.
 * @param field - the uncovered reference field (`throughSeq`, `headerSeq`).
 * @param owner - the one event type that carries that field.
 * @param reference - moves one source reference to its target, refusing an unplaceable one.
 * @returns `out` with the field remapped, or `out` unchanged when nothing has to move.
 */
function remapUncoveredReference(source, out, field, owner, reference) {
  const data = out.data;
  if (data === null || typeof data !== 'object' || data[field] === undefined) return out;
  if (out.type !== owner) throw new Error(`unknown ${field} on ${String(out.type)}`);
  if (data[field] !== source.data?.[field]) return out;
  return { ...out, data: { ...data, [field]: reference(data[field]) } };
}

/**
 * The physical first line's own admissibility to the read path.
 *
 * The readers in {@link refusal} are handed a header rebuilt from the fields this script knows,
 * so the stored line is never judged by them; it is written back verbatim, so a stray key on it
 * survives the write and the read path refuses the whole log over that line alone
 * (`isHeaderLine` in session-persistence-jsonl/src/format.ts accepts exactly the required keys
 * plus `cwd`/`parentSession`/`origin`/`agentPreset`). The key set is the same one the sibling
 * `repair-header-fields.mjs` repairs against.
 * @param wire - the stored `session` record, exactly as it will be written back.
 * @returns `undefined` when the line is one the read path accepts, else why the write is refused.
 */
import { headerLineRefusal } from './repair-header-gate.mjs';

/**
 * The host's own verdict on the log a write would store.
 *
 * Both host-owned readers run on the candidate, the same ones the sibling repair scripts use:
 * `Session.fromRestore`/`create` re-walk every stored event the way a reload does, and the
 * released-v4 `restoreReleasedV4Artifact`/`assertReleasedV4Relationships` pair add the
 * relationship validation (a developer message's `headerSeq`, a replacement range, a delivery
 * `throughSeq`) that the numbering alone cannot express. The stored first line is judged first,
 * by {@link headerLineRefusal}, because neither reader ever sees it and it reaches the file
 * unchanged. A validator that is not importable here certifies nothing, and a candidate either
 * reader -- or that line -- refuses is exactly the log this script must not report as repaired;
 * all of them refuse the write.
 * @param wire - the stored `session` record.
 * @param events - the candidate events, dense and carrying their `ignorable` flags.
 * @returns `undefined` when both host readers accept, else why the write is refused.
 */
function refusal(wire, events) {
  const line = headerLineRefusal(wire);
  if (line !== undefined) return line;
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
  // The encode above proves the bytes round-trip; this is the host's own verdict on what they
  // say. A refusal here is the whole point: the numbers and their references have to name the
  // same events the host will read back, not merely be dense and flagged.
  const verdict = refusal(raw, check);
  if (verdict !== undefined) { console.log(`  ${verdict}`); continue; }
  const backup = `${file}.bak-ignorable-${new Date().toISOString().replace(/[:.]/g, '')}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, encoded);
  repaired += 1;
  console.log(`  backed up: ${backup}`);
}
console.log(`${apply ? 'REPAIRED' : 'CANDIDATES'} ${apply ? repaired : candidates}`);
