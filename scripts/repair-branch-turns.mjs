#!/usr/bin/env node
// Close the turn a forked branch left open.
//
// Branches created before the fork-closer fix copy a prefix that ends inside the turn
// being compressed, then open their own turn without closing it. The stored log is then
// rejected on reload ("turn/start does not open the expected turn"), which also makes
// the conversation vanish from the session list.
//
// The repair inserts the closers buildForkSeed would have written (step/end for an open
// step, then turn/end with the forked reason) at the point the branch's own turn opens,
// shifting later sequence numbers and the seq references that follow them. Every
// candidate is re-walked and loaded through the host's own Session constructors before
// it is written, and every file is backed up first. Those constructors are handed a header
// this script *rebuilds* from the fields it knows, so the stored first line never reaches
// them: the line is written back verbatim, and a stray or missing key on it passes the
// constructors while the read path still refuses the whole log over that line alone. The line
// is therefore checked on its own, against the same guard the read path applies to it (see
// `headerLineRefusal`), in both passes below, and a file whose line fails that guard is
// refused and left byte-identical.
//
// The numbers a shift moves are nothing without the references that name them: both passes
// below rewrite seqs, so both move every reference through the host's own event-reference
// remap (`remapReferences`, which also moves the reference fields that remap does not cover)
// and refuse a file whose references cannot be placed rather than writing one the host loads
// with its references pointing at the wrong events.
//
// Usage: node scripts/repair-branch-turns.mjs [--apply] [--root <sessions dir>] [--host <session package>]
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

let host;
try {
  host = await import(pathToFileURL(hostPath).href);
} catch {
  host = undefined;
}

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

/**
 * Move one event's references from source sequence numbers to target ones.
 *
 * The reference fields are the host's business, not this script's: `remapV3References` is
 * the function the host itself calls when it renumbers events, so every field it covers
 * follows the numbers and a reference that names no earlier stored event throws instead of
 * being carried over stale. Two reference fields the remap does not cover are moved here,
 * each guarded by the event type that owns it: a delivery marker's `data.throughSeq` and a
 * developer message's `data.headerSeq`. The second one is enforced by the host's own
 * relationship validation (`developer/message headerSeq must reference an earlier
 * request/header`) even though no remap moves it, so a rewrite that leaves it behind either
 * produces a log the host refuses or -- when the old number lands on another valid
 * `request/header` -- one whose developer message binds to the wrong header.
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
 * The physical first line's own admissibility to the read path.
 *
 * `hostAccepts` below is handed a header this script *rebuilds* from the fields it knows, so the
 * stored line is never judged by the host constructors; the line is written back verbatim, so a
 * stray key on it survives the write and the read path refuses the whole log over that line
 * alone (`isHeaderLine` in session-persistence-jsonl/src/format.ts accepts exactly the required
 * keys plus `cwd`/`parentSession`/`origin`/`agentPreset`). The key set is the same one the
 * sibling `repair-header-fields.mjs` repairs against.
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

/** Where the log first opens a turn while another is already open. */
function brokenAt(events) {
  let openTurn = null;
  let openStep = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type === 'turn/start') {
      if (openTurn !== null) return { index, openTurn, openStep };
      openTurn = event.data.turn;
      openStep = null;
    } else if (event.type === 'turn/end') {
      openTurn = null;
      openStep = null;
    } else if (event.type === 'step/start') openStep = event.data.step;
    else if (event.type === 'step/end') openStep = null;
  }
  return undefined;
}

function hostAccepts(raw, events) {
  if (host === undefined) return 'structural only';
  const header = {
    version: host.SESSION_FORMAT_VERSION,
    id: host.SessionId(raw.id),
    createdAt: raw.createdAt,
    isSeeded: false,
    ...(raw.parentSession === undefined ? {} : { parentSession: host.SessionId(raw.parentSession) }),
    ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
  };
  try {
    host.Session.fromRestore(host.SessionId(raw.id), events, header, host.SessionLogOffset(0), 'detached');
    host.Session.create(host.SessionId(raw.id), events, header, host.SessionLogOffset(0));
  } catch (error) {
    return `REJECTED ${String(error.message)}`;
  }
  return 'both host paths accept it';
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
    records = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  } catch {
    continue;
  }
  const raw = records[0];
  const events = records.slice(1);
  const broken = brokenAt(events);
  if (raw?.type !== 'session' || broken === undefined) continue;
  candidates += 1;
  const closers = [];
  const time = events[broken.index - 1]?.time ?? raw.createdAt;
  let seq = broken.index;
  if (broken.openStep !== null) closers.push({ type: 'step/end', seq: seq++, time, data: { turn: broken.openTurn, step: broken.openStep } });
  closers.push({ type: 'turn/end', seq: seq++, time, data: { turn: broken.openTurn, reason: { kind: 'forked' } } });
  const shift = closers.length;
  console.log(`${apply ? 'REPAIR' : 'WOULD REPAIR'} ${raw.id} at=${String(broken.index)} closers=${String(shift)}`);
  if (!apply) continue;
  // The stored first line goes back verbatim and `hostAccepts` below never sees it, so a line
  // the read path refuses has to refuse the write here.
  const line = headerLineRefusal(raw);
  if (line !== undefined) {
    console.log(`  ${line}`);
    continue;
  }
  // The closers take position broken.index, so that event and every later one moves forward
  // by `shift`; the seqs other events refer to move with them, or the file the host loads
  // would point at the wrong events. Both prerequisites are refusals, never a partial repair:
  // without the host's reference remap nothing can move the references at all, and a sequence
  // that does not run strictly forwards has no single old -> new table to move them through.
  const forwards = events.every((event, index) => index === 0 || event.seq > events[index - 1].seq);
  if (remapV3References === undefined || !forwards) {
    console.log(remapV3References === undefined
      ? '  SKIP repairing: the host event-reference remap is not importable here'
      : '  SKIP repairing: the stored sequence is not strictly increasing');
    continue;
  }
  const boundary = events[broken.index].seq;
  const shiftMapping = [];
  for (const event of events) shiftMapping[event.seq] = event.seq < boundary ? event.seq : event.seq + shift;
  let shifted;
  try {
    shifted = [
      ...events.slice(0, broken.index),
      ...closers,
      ...events.slice(broken.index).map(event => remapReferences(event, event.seq + shift, shiftMapping)),
    ];
  } catch (error) {
    console.log(`  SKIP repairing: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const verdict = hostAccepts(raw, shifted);
  console.log(`  ${verdict}`);
  if (verdict.startsWith('REJECTED') || brokenAt(shifted) !== undefined) continue;
  const encoded = zlib.zstdCompressSync(Buffer.from([raw, ...shifted].map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8'));
  const backup = `${file}.bak-turns-${new Date().toISOString().replace(/[:.]/g, '')}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, encoded);
  repaired += 1;
  console.log(`  backed up: ${backup}`);
}
/**
 * Pass two: a log whose sequence numbers drifted (the host kept appending to a file a
 * repair had already rewritten) is renumbered to the index order it must equal, with
 * every seq reference remapped through the same table.
 */
let gapCandidates = 0;
let gapRepaired = 0;
for (const file of findLogs(root)) {
  let records;
  try {
    records = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  } catch {
    continue;
  }
  const raw = records[0];
  const events = records.slice(1);
  if (raw?.type !== 'session' || events.every((event, index) => event.seq === index)) continue;
  gapCandidates += 1;
  console.log(`${apply ? 'RENUMBER' : 'WOULD RENUMBER'} ${raw.id} events=${String(events.length)}`);
  if (!apply) continue;
  // Same blind spot in this pass: the renumbering moves the events, never the stored first line.
  const line = headerLineRefusal(raw);
  if (line !== undefined) {
    console.log(`  ${line}`);
    continue;
  }
  // Renumbering rewrites numbers other events refer to, so the references have to move with
  // them. Both prerequisites are refusals, never a partial repair: a stored sequence that
  // does not run strictly forwards has no single old->new table, and without the host's
  // reference remap nothing can move the references at all.
  const forwards = events.every((event, index) => index === 0 || event.seq > events[index - 1].seq);
  if (remapV3References === undefined || !forwards) {
    console.log(remapV3References === undefined
      ? '  SKIP renumbering: the host event-reference remap is not importable here'
      : '  SKIP renumbering: the stored sequence is not strictly increasing');
    continue;
  }
  const mapping = [];
  events.forEach((event, index) => { mapping[event.seq] = index; });
  let fixed;
  try {
    fixed = events.map((event, index) => remapReferences(event, index, mapping));
  } catch (error) {
    console.log(`  SKIP renumbering: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const verdict = hostAccepts(raw, fixed);
  console.log(`  ${verdict}`);
  if (verdict.startsWith('REJECTED') || fixed.some((event, index) => event.seq !== index)) continue;
  const encoded = zlib.zstdCompressSync(Buffer.from([raw, ...fixed].map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8'));
  const backup = `${file}.bak-gaps-${new Date().toISOString().replace(/[:.]/g, '')}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, encoded);
  gapRepaired += 1;
  console.log(`  backed up: ${backup}`);
}
console.log(`${apply ? 'RENUMBERED' : 'GAP CANDIDATES'} ${apply ? gapRepaired : gapCandidates}`);

console.log(`${apply ? 'REPAIRED' : 'CANDIDATES'} ${apply ? repaired : candidates}`);
