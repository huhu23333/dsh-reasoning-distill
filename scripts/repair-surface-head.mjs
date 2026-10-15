#!/usr/bin/env node
// Give a branch log the protected surface head it lost.
//
// A branch cut from inside turn 1 inherits the config prefix but not the source's
// system/message, so its surface opens with a user message and the system/message the
// harness appends later is rejected ("system/message requires a protected first surface
// head", relationships.ts). A system/message must also sit inside an open turn AND step,
// so when the conversation opens with the plugin's manual layout -- user/message before
// step/start -- the step/start is rotated up to the turn and the system message is copied
// in behind it.
//
// The numbers a rotation or an insertion moves are nothing without the references that
// name them: both strategies below rewrite seqs, so both move every reference through the
// host's own event-reference remap (`remapV3References`, plus the reference fields that remap
// does not cover) and refuse a file whose references cannot be placed rather than writing one
// the host loads with its references pointing at the wrong events.
//
// Every candidate is validated with the host's own released-v4 validator before it is
// written, and every file is backed up first. That validator is handed a header this script
// *rebuilds* from the fields it knows, so the stored first line never reaches it: the line is
// written back verbatim, and a stray or missing key on it passes the validator while the read
// path still refuses the whole log over that line alone. The line is therefore checked on its
// own, against the same guard the read path applies to it (see `headerLineRefusal`), and a file
// whose line fails that guard is refused here and left byte-identical.
//
// Usage: node scripts/repair-surface-head.mjs [--apply] [--root <sessions dir>] [--checkout <dsh checkout>]
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
const checkout = argOf('--checkout', path.join(os.homedir(), 'otherProject', 'deepseek-harness'));

const session = await import(pathToFileURL(path.join(checkout, 'packages/core/session/lib/index.js')).href);
const format = await import(pathToFileURL(path.join(checkout, 'packages/session/session-format-v3-to-v4/lib/index.js')).href);
const known = new Set([...session.KNOWN_SESSION_EVENT_TYPES, 'message-edit/version']);

// The host's own event-reference remap, imported from its sources because the built package
// does not re-export it. It is what makes rewriting a seq safe: it moves `surfaceOp`'s
// `startSeq`/`endSeq`, `sourceEventSeqs`, a compaction's `shadowedRange`/`shadowedSeqs`, a
// title's `messageSeqs`, `command/done`'s `sourceEventSeq` and `image/offload`'s targets
// with the numbers, and it refuses a reference that does not name an earlier event. A host
// that cannot be imported (a published install without sources, or a Node without type
// stripping) leaves this undefined; a file whose numbers move is then reported instead of
// rewritten, because rewriting the numbers without the remap is exactly what leaves a
// loadable log whose references point at the wrong events.
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

function artifactOf(wire, events) {
  return {
    header: {
      version: 4,
      id: wire.id,
      createdAt: wire.createdAt,
      isSeeded: wire.isSeeded === true,
      delegationDepth: wire.delegationDepth ?? 0,
      ...wire.cwd === undefined ? {} : { cwd: wire.cwd },
      ...wire.parentSession === undefined ? {} : { parentSession: wire.parentSession },
      ...wire.origin === undefined ? {} : { origin: wire.origin },
      ...wire.agentPreset === undefined ? {} : { agentPreset: wire.agentPreset },
    },
    events,
    // The current format keeps the inherited cut on the last tagged session/end-seed event;
    // the physical header has no such field (a stray one makes the first line invalid).
    inheritedEventCount: events.filter(event => event.type === 'session/end-seed' && event.data?.inherited === true).at(-1)?.seq ?? 0,
  };
}

/**
 * The physical first line's own admissibility to the read path.
 *
 * The validator in {@link rejection} is handed a header this script *rebuilds* from the fields
 * it knows, so the stored line is never judged by it; the line is written back verbatim, so a
 * stray key on it survives the write and the read path refuses the whole log over that line
 * alone (`isHeaderLine` in session-persistence-jsonl/src/format.ts accepts exactly the required
 * keys plus `cwd`/`parentSession`/`origin`/`agentPreset`). The key set is the same one the
 * sibling `repair-header-fields.mjs` repairs against.
 * @param wire - the stored `session` record, exactly as it will be written back.
 * @returns `undefined` when the line is one the read path accepts, else why the write is refused.
 */
import { headerLineRefusal } from './repair-header-gate.mjs';

function rejection(wire, events) {
  try {
    const artifact = artifactOf(wire, events);
    format.restoreReleasedV4Artifact(artifact, known);
    format.assertReleasedV4Relationships(artifact, known);
    return undefined;
  } catch (error) {
    return String(error.message);
  }
}

/**
 * Move one event's references from source sequence numbers to target ones.
 *
 * The reference fields are the host's business, not this script's: `remapV3References` is
 * the function the host itself calls when it renumbers events, so every field it covers
 * follows the numbers and a reference that names no earlier stored event throws instead of
 * being carried over stale. Two reference fields it does not cover are moved here, each
 * guarded by the event type that owns it: a delivery marker's `data.throughSeq` and a
 * developer message's `data.headerSeq`. The second one is enforced by the host's own
 * relationship validation (`developer/message headerSeq must reference an earlier
 * request/header`) even though no remap moves it, so a rewrite that leaves it behind either
 * produces a log the host refuses or -- when the old number lands on another valid
 * `request/header` -- one whose developer message binds to the wrong header. An unplaceable
 * reference refuses the file rather than being left pointing at whatever now sits at the old
 * number.
 * @param event - stored event whose source seq is the key of `mapping`.
 * @param target - the seq the event takes in the rewritten log.
 * @param mapping - target seq of every source seq present in the log.
 * @returns the event at `target` with every reference remapped.
 */
function remapReferences(event, target, mapping) {
  if (remapV3References === undefined) throw new Error('the host event-reference remap is not importable here');
  const reference = value => {
    const at = typeof value === 'number' ? mapping[value] : undefined;
    if (at === undefined || value >= event.seq) throw new Error(`reference ${String(value)} does not name an earlier stored event`);
    return at;
  };
  let out = remapV3References(event, target, mapping);
  out = remapUncoveredReference(event, out, 'throughSeq', 'session-log-deepseek/delivery-accepted', reference);
  out = remapUncoveredReference(event, out, 'headerSeq', 'developer/message', reference);
  return out;
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
 * Place a copied event at its target coordinate, moving the references it carried.
 *
 * The copy is a copy, not the head itself, so its references have to follow the events
 * around it even when it lands exactly where the event it was copied from sat.
 * `remapV3References` reads an unchanged seq as "this event did not move" and hands the
 * event back untouched; passing the source coordinate one higher is the same validity bound
 * it always had (every reference it carried names a strictly earlier source event) and
 * makes the remap run.
 * @param source - the stored event the copy was taken from.
 * @param target - the seq the copy takes in the rewritten log.
 * @param mapping - target seq of every source seq present in the log.
 * @returns the copy at `target` with the references it carried remapped.
 */
function remapCopy(source, target, mapping) {
  return remapReferences(target === source.seq ? { ...source, seq: source.seq + 1 } : source, target, mapping);
}

/** Rotate the opening step/start above the first user message and copy the head in. */
function rotateHead(wire, events) {
  const firstSurface = events.find(event => event.surfaceOp !== undefined);
  const head = events.find(event => event.type === 'system/message');
  if (firstSurface?.type !== 'user/message' || head === undefined) return undefined;
  const turnStart = events.filter(event => event.type === 'turn/start').find(event => event.seq < firstSurface.seq);
  const stepStart = events.find(event => event.type === 'step/start' && event.seq > firstSurface.seq && event.seq - firstSurface.seq <= 2);
  if (turnStart === undefined || stepStart === undefined || stepStart.data.turn !== turnStart.data.turn) return undefined;
  // A surface message must name the turn and step that are open where it lands; the copy
  // inherits the rotated step/start's coordinates, not its original event's.
  const inserted = {
    ...head,
    time: stepStart.time,
    surfaceOp: 'append',
    data: { ...head.data, turn: stepStart.data.turn, step: stepStart.data.step },
  };
  // The rebuilt order is the map: every event's source seq names the seq it takes, so the
  // references that name those source seqs move with them instead of being left behind.
  const rebuilt = [];
  const mapping = [];
  for (const event of events) {
    if (event.seq === firstSurface.seq) {
      // turn/start, step/start, system head, then the user message
      rebuilt.push({ event: stepStart, target: rebuilt.length, copy: false });
      mapping[stepStart.seq] = rebuilt.length - 1;
      rebuilt.push({ event: inserted, target: rebuilt.length, copy: true });
      rebuilt.push({ event, target: rebuilt.length, copy: false });
      mapping[event.seq] = rebuilt.length - 1;
      continue;
    }
    if (event.seq === stepStart.seq) {
      // The original step/start has been rotated up; its slot closes the gap.
      continue;
    }
    rebuilt.push({ event, target: rebuilt.length, copy: false });
    mapping[event.seq] = rebuilt.length - 1;
  }
  return rebuilt.map(({ event, target, copy }) => copy
    ? remapCopy(event, target, mapping)
    : remapReferences(event, target, mapping));
}

/** Fallback: insert the head straight in, when the surrounding step allows it. */
function insertHead(events) {
  const firstSurface = events.find(event => event.surfaceOp !== undefined);
  const head = events.find(event => event.type === 'system/message');
  if (firstSurface === undefined || head === undefined) return undefined;
  const at = firstSurface.seq;
  const inserted = { ...head, time: firstSurface.time ?? head.time, surfaceOp: 'append' };
  const rebuilt = [];
  const mapping = [];
  for (const event of events) {
    if (event.seq === at) rebuilt.push({ event: inserted, target: rebuilt.length, copy: true });
    rebuilt.push({ event, target: rebuilt.length, copy: false });
    mapping[event.seq] = rebuilt.length - 1;
  }
  return rebuilt.map(({ event, target, copy }) => copy
    ? remapCopy(event, target, mapping)
    : remapReferences(event, target, mapping));
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
  const events = records.slice(1);
  if (wire?.type !== 'session') continue;
  const firstSurface = events.find(event => event.surfaceOp !== undefined);
  if (firstSurface === undefined || firstSurface.type === 'system/message') continue;
  const reason = rejection(wire, events);
  if (reason === undefined) continue;
  candidates += 1;
  // Both strategies below rewrite seqs, so both have to move the references that name them.
  // Two prerequisites are refusals, never a partial repair: a stored sequence that does not
  // run strictly forwards has no single old -> new table to move them through, and without
  // the host's reference remap nothing can move them at all.
  const forwards = events.every((event, index) => index === 0 || event.seq > events[index - 1].seq);
  if (remapV3References === undefined || !forwards) {
    console.log(`${apply ? 'REPAIR' : 'WOULD REPAIR'} ${wire.id} reject=${reason} -> ${remapV3References === undefined ? 'the host event-reference remap is not importable here' : 'the stored sequence is not strictly increasing'}`);
    console.log(remapV3References === undefined
      ? '  SKIP repairing: the host event-reference remap is not importable here'
      : '  SKIP repairing: the stored sequence is not strictly increasing');
    continue;
  }
  for (const [strategy, build] of [['rotate', () => rotateHead(wire, events)], ['insert', () => insertHead(events)]]) {
    let patched;
    try {
      patched = build();
    } catch (error) {
      // A reference that cannot be placed refuses the file: the numbers would move while the
      // things that name them stayed behind.
      console.log(`  SKIP repairing: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    if (patched === undefined) continue;
    const verdict = rejection(wire, patched);
    // The stored first line is written back verbatim and the validator above never sees it, so a
    // line the read path refuses has to block the write on its own.
    const blocker = verdict ?? headerLineRefusal(wire);
    console.log(`${apply ? 'REPAIR' : 'WOULD REPAIR'} ${wire.id} reject=${reason} strategy=${strategy} -> ${blocker ?? 'the host validator accepts it'}`);
    if (!apply || blocker !== undefined) continue;
    const encoded = zlib.zstdCompressSync(Buffer.from([wire, ...patched].map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8'));
    const backup = `${file}.bak-surfacehead-${new Date().toISOString().replace(/[:.]/g, '')}`;
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, encoded);
    repaired += 1;
    console.log(`  backed up: ${backup}`);
    break;
  }
}
console.log(`${apply ? 'REPAIRED' : 'CANDIDATES'} ${apply ? repaired : candidates}`);
