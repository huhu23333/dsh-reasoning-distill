#!/usr/bin/env python3
"""Repair published dsh-message-edit client and server API drift.

createSnapshotStore belongs to the platform's dsh-client-store seed module.
The current SessionSnapshot lacks turnEnds: this belongs to the legacy chat
projection, not SessionFace.getSnapshot(). The SessionBinding.eventSource
publishes a monotonic event-window revision; subscribe to it instead and
fall back to safe lifecycle fields when the binding has no event source.

Usage:  python3 scripts/patch-message-edit.py [plugin directory or bundle path]
Default: patch both client.js and index.mjs in installed candidate packages.
Re-run after every reinstall/upgrade of the plugin (installs overwrite it).
"""
from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

DRIFTED = 'require("@deepseek-ai/dsh-client-runtime/client")'
FIXED = 'require("@deepseek-ai/dsh-client-store")'
OLD_ACTION_MATCH = '''\t\t\t\t\tconst actionRows = Array.from(document.querySelectorAll("[class*=\\"actions\\"]"));'''
NEW_ACTION_MATCH = '''\t\t\t\t\tconst actionRows = Array.from(document.querySelectorAll("[data-chat-flow-kind] [data-clock]"));'''
OLD_EVENT_MATCH = '''\t\t\t\t\t\tconst text = (row.parentElement?.parentElement?.textContent ?? "").trim();
\t\t\t\t\t\tif (text.length === 0) continue;
\t\t\t\t\t\tconst eventSeq = [...new Set(messages.filter((message) => message.text.length > 0 && text.includes(message.text.slice(0, 24))).map((message) => message.eventSeq))].find((candidate) => !claimedEvents.has(candidate));'''
NEW_EVENT_MATCH = '''\t\t\t\t\t\tconst seat = row.closest("[data-chat-flow-kind][data-chat-turn]");
\t\t\t\t\t\tconst seatTurn = Number(seat?.getAttribute("data-chat-turn"));
\t\t\t\t\t\tif (!seat || !Number.isInteger(seatTurn)) continue;
\t\t\t\t\t\tconst kind = seat.getAttribute("data-chat-flow-kind");
\t\t\t\t\t\tconst candidates = [...new Set(messages.filter((message) => message.turn === seatTurn && (kind === "user" || kind === "steering" ? message.kind === "user" : message.kind !== "user")).map((message) => message.eventSeq))].filter((candidate) => !claimedEvents.has(candidate));
\t\t\t\t\t\t// A turn-local unique event is safe without comparing translated/Markdown DOM text.
\t\t\t\t\t\tconst eventSeq = candidates.length === 1 ? candidates[0] : void 0;'''
ACTION_REPLACEMENTS = ((OLD_ACTION_MATCH, NEW_ACTION_MATCH), (OLD_EVENT_MATCH, NEW_EVENT_MATCH))
OLD_TIMELINE_FUNCTION = '''async function timeline(ctx, sessionId) {
\tconst targetTrace = await ctx.sessionQuery.traceSession(sessionId);'''
NEW_TIMELINE_FUNCTION = '''function boundedInteger(name, fallback, maximum) {
\tconst parsed = Number.parseInt(process.env[name] ?? "", 10);
\treturn Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}
// Hard ceilings are deliberately small: this route shares the host process heap.
// The window is a suffix of the live log: wide enough to contain whole closed
// turns (a 1 MB window starved a 2.5 MB session down to its open turn alone),
// yet small enough that one request never materializes a huge projection.
const TIMELINE_EVENT_LIMIT = boundedInteger("DSH_MESSAGE_EDIT_EVENT_LIMIT", 2e3, 4e3);
const TIMELINE_INPUT_BYTE_LIMIT = boundedInteger("DSH_MESSAGE_EDIT_INPUT_BYTE_LIMIT", 4 * 1024 * 1024, 8 * 1024 * 1024);
const TIMELINE_MESSAGE_LIMIT = boundedInteger("DSH_MESSAGE_EDIT_MESSAGE_LIMIT", 200, 500);
const TIMELINE_JSON_LIMIT = boundedInteger("DSH_MESSAGE_EDIT_JSON_LIMIT", 128 * 1024, 512 * 1024);
const TIMELINE_CACHE_LIMIT = boundedInteger("DSH_MESSAGE_EDIT_CACHE_LIMIT", 16, 64);
const timelineCache = /* @__PURE__ */ new Map();
class TimelineTooLargeError extends Error {}
function timelineRevision(events) {
\treturn `${String(events.length)}:${String(events.at(-1)?.seq ?? 0)}`;
}
// Conservative, early-exit byte accounting; unlike JSON.stringify it never creates
// a second giant string merely to decide that an event is too large.
function bytesWithin(value, limit) {
\tlet bytes = 0;
\tconst stack = [value];
\tconst seen = /* @__PURE__ */ new Set();
\twhile (stack.length > 0 && bytes <= limit) {
\t\tconst item = stack.pop();
\t\tif (typeof item === "string") bytes += Buffer.byteLength(item, "utf8") + 2;
\t\telse if (typeof item === "number" || typeof item === "boolean" || item === null || item === void 0) bytes += 16;
\t\telse if (typeof item === "object") {
\t\t\tif (seen.has(item)) continue;
\t\t\tseen.add(item);
\t\t\tconst entries = Array.isArray(item) ? item.map((entry, index) => [String(index), entry]) : Object.entries(item);
\t\t\tbytes += 2 + entries.length;
\t\t\tfor (const [key, entry] of entries) {
\t\t\t\tbytes += Buffer.byteLength(key, "utf8") + 3;
\t\t\t\tstack.push(entry);
\t\t\t}
\t\t} else bytes += 16;
\t}
\treturn bytes;
}
/** Whole closed turns counted back from the log end, oldest first.
* A raw event suffix can end inside the open turn and fold to nothing at all;
* the editable projection only ever consumes complete turn brackets. */
function recentEventWindow(events) {
\tconst turns = [];
\tlet current;
\tfor (const event of events) {
\t\tif (event.type === "turn/start") {
\t\t\tcurrent = [event];
\t\t\tcontinue;
\t\t}
\t\tif (current === void 0) continue;
\t\tcurrent.push(event);
\t\tif (event.type === "turn/end") {
\t\t\tturns.push(current);
\t\t\tcurrent = void 0;
\t\t}
\t}
\tconst picked = [];
\tlet bytes = 0;
\tfor (let index = turns.length - 1; index >= 0; index -= 1) {
\t\tconst turn = turns[index];
\t\tif (picked.reduce((total, entry) => total + entry.length, 0) + turn.length > TIMELINE_EVENT_LIMIT) break;
\t\tconst remaining = TIMELINE_INPUT_BYTE_LIMIT - bytes;
\t\tconst turnBytes = bytesWithin(turn, remaining);
\t\tif (turnBytes > remaining) break;
\t\tbytes += turnBytes;
\t\tpicked.unshift(turn);
\t}
\treturn picked.flat();
}
function boundedMessages(turns) {
\tconst candidates = editableMessages(turns);
\tconst result = [];
\tlet bytes = 0;
\tfor (let index = candidates.length - 1; index >= 0 && result.length < TIMELINE_MESSAGE_LIMIT; index -= 1) {
\t\tconst remaining = TIMELINE_JSON_LIMIT - bytes;
\t\tconst itemBytes = bytesWithin(candidates[index], remaining);
\t\tif (itemBytes > remaining) continue;
\t\tbytes += itemBytes;
\t\tresult.push(candidates[index]);
\t}
\tresult.reverse();
\treturn result;
}
function boundedRetryableTurns(turns) {
\treturn retryableTurns(turns).slice(-TIMELINE_MESSAGE_LIMIT).map((item) => ({ ...item, preview: item.preview.slice(0, 512) }));
}
/** Final byte bound: trim the oldest entries until the real JSON fits, so a
* large turn degrades to fewer editable messages instead of an error page. */
function boundedTimeline(value) {
\tconst messages = [...value.messages];
\tconst retryableTurns = [...value.retryableTurns];
\tfor (;;) {
\t\tconst candidate = { ...value, messages, retryableTurns };
\t\tif (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= TIMELINE_JSON_LIMIT) return candidate;
\t\tif (messages.length > 0) messages.splice(0, Math.max(1, Math.ceil(messages.length / 4)));
\t\telse if (retryableTurns.length > 0) retryableTurns.splice(0, Math.max(1, Math.ceil(retryableTurns.length / 4)));
\t\telse throw new TimelineTooLargeError(`message-edit 响应超过 ${String(TIMELINE_JSON_LIMIT)} 字节硬上限。`);
\t}
}
function cacheTimeline(sessionId, revision, value) {
\tif (timelineCache.has(sessionId)) timelineCache.delete(sessionId);
\ttimelineCache.set(sessionId, { revision, value });
\twhile (timelineCache.size > TIMELINE_CACHE_LIMIT) timelineCache.delete(timelineCache.keys().next().value);
}
// The host Session no longer exposes its raw `.events`; read a bounded tail
// through the supported synchronous snapshot API (older hosts: `.events`).
function liveTail(live) {
\tif (typeof live.snapshotEvents === "function") {
\t\tconst end = Number(live.seq ?? 0);
\t\treturn live.snapshotEvents(Math.max(0, end - TIMELINE_EVENT_LIMIT), end);
\t}
\treturn live.events ?? [];
}
/** Full event log of a live Session, across host API generations. */
function sessionLog(session) {
\treturn typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : session?.events ?? [];
}

/** One version's own effect event. Only a loaded session can be read in O(1);
* a persisted branch holds a full copy of its parent's log, which this route must
* never load merely to label a row. */
function loadedVersionEvent(ctx, record) {
\tconst live = ctx.sessions.get(record.header.id);
\tif (live === void 0 || typeof live.snapshotEvents !== "function") return void 0;
\tconst inherited = Number(live.inheritedEventCount ?? 0);
\tif (!Number.isSafeInteger(inherited) || inherited <= 0) return void 0;
\tconst event = live.snapshotEvents(inherited, inherited + 1)[0];
\treturn event?.type === "message-edit/version" && event.data?.effect !== void 0 ? event : void 0;
}
/** Depth-first lineage from header records only: parentSessionId is the structural
* inverse link every version child is created with. */
function flattenLineage(root, descendants) {
\tconst result = [{ record: root, depth: 0 }];
\tconst visit = (nodes, depth) => {
\t\tconst ordered = [...(nodes ?? [])].sort((left, right) => (left.session?.header?.createdAt ?? 0) - (right.session?.header?.createdAt ?? 0) || String(left.session?.header?.id ?? "").localeCompare(String(right.session?.header?.id ?? "")));
\t\tfor (const node of ordered) {
\t\t\tif (node?.session?.header?.id === void 0) continue;
\t\t\tresult.push({ record: node.session, depth });
\t\t\tvisit(node.descendants, depth + 1);
\t\t}
\t};
\tvisit(descendants, 1);
\treturn result;
}
/** Bounded family projection: two header-only traces plus at most one O(1) event
* read per loaded member; an absent trace falls back to a single version. */
async function lineageVersions(ctx, sessionId) {
\ttry {
\t\tconst target = await ctx.sessionQuery.traceSession(sessionId);
\t\tif (target?.target?.header?.id === void 0) return void 0;
\t\tconst rootId = target.complete === true ? target.root?.header?.id : target.ancestors?.at?.(-1)?.header?.id ?? sessionId;
\t\tconst tree = rootId !== void 0 && rootId !== sessionId ? await ctx.sessionQuery.traceSession(rootId) : target;
\t\tconst lineage = flattenLineage(tree?.target ?? target.target, tree?.descendants ?? []);
\t\tconst onPath = new Set([sessionId]);
\t\tfor (const ancestor of target.ancestors ?? []) if (ancestor?.header?.id !== void 0) onPath.add(ancestor.header.id);
\t\tconst versions = lineage.map(({ record, depth }) => {
\t\t\tconst id = record.header.id;
\t\t\tconst event = loadedVersionEvent(ctx, record);
\t\t\tconst effect = event?.data?.effect;
\t\t\treturn {
\t\t\t\tsessionId: id,
\t\t\t\t...record.header.parentSession === void 0 ? {} : { parentSessionId: record.header.parentSession },
\t\t\t\t...effect?.id === void 0 ? {} : { effectId: effect.id },
\t\t\t\t...event?.data?.inverse?.sessionId === void 0 ? {} : { inverseSessionId: event.data.inverse.sessionId },
\t\t\t\tcreatedAt: event?.time ?? record.header.createdAt ?? 0,
\t\t\t\tdepth,
\t\t\t\tcurrent: id === sessionId,
\t\t\t\tonCurrentEffectPath: onPath.has(id),
\t\t\t\t...effect?.operation === void 0 ? {} : { operation: effect.operation },
\t\t\t\t...effect?.cascade === void 0 ? {} : { cascade: effect.cascade },
\t\t\t\t...effect?.targetTurn === void 0 ? {} : { targetTurn: effect.targetTurn },
\t\t\t\t...effect?.blockKind === void 0 ? {} : { blockKind: effect.blockKind },
\t\t\t\t...effect?.before === void 0 ? {} : { before: effect.before },
\t\t\t\t...effect?.after === void 0 ? {} : { after: effect.after }
\t\t\t};
\t\t});
\t\tconst byId = new Map(versions.map((version) => [version.sessionId, version]));
\t\tconst undoStack = [];
\t\tlet cursor = byId.get(sessionId)?.inverseSessionId ?? byId.get(sessionId)?.parentSessionId;
\t\twhile (cursor !== void 0 && byId.has(cursor) && !undoStack.includes(cursor)) {
\t\t\tundoStack.push(cursor);
\t\t\tcursor = byId.get(cursor)?.inverseSessionId ?? byId.get(cursor)?.parentSessionId;
\t\t}
\t\tconst redoSessionIds = versions.filter((version) => version.sessionId !== sessionId && version.parentSessionId === sessionId).map((version) => version.sessionId);
\t\treturn { versions, undoStack, redoSessionIds };
\t} catch {
\t\treturn void 0;
\t}
}
async function timeline(ctx, sessionId) {
\tconst live = ctx.sessions.get(sessionId);
\tif (live === void 0) return {
\t\tsessionId,
\t\tmessages: [],
\t\tretryableTurns: [],
\t\tversions: [],
\t\tundoStack: [],
\t\tredoSessionIds: [],
\t\tnotice: "为保护宿主内存，message-edit 仅处理当前已加载会话；请先打开会话后重试。"
\t};
\tconst events = liveTail(live);
\t// The family signature joins the cache key: a new branch changes the version
\t// tree without changing this session's own log.
\tconst family = await lineageVersions(ctx, sessionId);
\tconst familyRevision = family === void 0 ? "single" : family.versions.map((version) => `${version.sessionId}:${String(version.createdAt)}`).join(",");
\tconst revision = `${timelineRevision(events)}|${familyRevision}`;
\tconst cached = timelineCache.get(sessionId);
\tif (cached?.revision === revision) return cached.value;
\tconst turns = closedTurns(recentEventWindow(events));
\tconst value = boundedTimeline({
\t\tsessionId,
\t\tmessages: boundedMessages(turns),
\t\tretryableTurns: boundedRetryableTurns(turns),
\t\tversions: family?.versions ?? [{ sessionId, createdAt: live.header?.createdAt ?? 0, depth: 0, current: true, onCurrentEffectPath: true }],
\t\tundoStack: family?.undoStack ?? [],
\t\tredoSessionIds: family?.redoSessionIds ?? []
\t});
\tcacheTimeline(sessionId, revision, value);
\treturn value;
}'''
SERVER_BOUNDS = ()


def patch_server_timeline(source: str) -> str:
    """Replace the complete projection region, including earlier patched variants."""
    if source.count(NEW_TIMELINE_FUNCTION) == 1:
        return source
    end_marker = 'function objectValue(value) {'
    if source.count(end_marker) != 1:
        raise ValueError('unexpected server timeline end marker')
    candidates = [
        source.find('function flattenLineage(root, descendants) {'),
        source.find('async function timeline(ctx, sessionId) {'),
        source.find('const TIMELINE_MESSAGE_LIMIT = 200;'),
        source.find('function boundedInteger(name, fallback, maximum) {'),
    ]
    starts = [candidate for candidate in candidates if candidate >= 0]
    if not starts:
        raise ValueError('unexpected server timeline start marker')
    start = min(starts)
    end = source.index(end_marker)
    if start >= end:
        raise ValueError('invalid server timeline region')
    return source[:start] + NEW_TIMELINE_FUNCTION + '\n' + source[end:]
MANUAL_TURN_FUNCTION = '''function appendManualTurn(events, manual) {
\tconst { turn, user, assistant } = manual;
\tappendLogSeedEvent(events, "turn/start", { turn });
\tappendSurfaceSeedEvent(events, "user/message", user, { surfaceOp: "append" });
\tappendLogSeedEvent(events, "step/start", {
\t\tturn,
\t\tstep: 1
\t});
\t// The host validates restored assistant settlement fields without replaying the
\t// embedded stream: a synthesized message carries turn/step and an empty stream,
\t// and never sourceEventSeqs (an embedded stream already carries its sources).
\tappendSurfaceSeedEvent(events, "assistant/message", {
\t\tturn,
\t\tstep: 1,
\t\tmessage: assistant,
\t\tstream: []
\t}, {
\t\tsurfaceOp: "append"
\t});
\tappendLogSeedEvent(events, "step/end", {
\t\tturn,
\t\tstep: 1
\t});
\tappendLogSeedEvent(events, "turn/end", {
\t\tturn,
\t\treason: { kind: "completed" }
\t});
}'''


def patch_manual_turn(source: str) -> str:
    """Normalize the synthesized manual turn to the host's seed validator shape."""
    marker = 'function appendManualTurn(events, manual) {'
    start = source.find(marker)
    if start < 0:
        raise ValueError('unexpected manual-turn marker')
    end = source.index('\n}', start) + 2
    return source[:start] + MANUAL_TURN_FUNCTION + source[end:]


SERVER_REPLACEMENTS = (
    ('if (persistence !== void 0) return (await persistence.inspect(sessionId)).events;',
     'if (typeof persistence?.inspect === "function") return (await persistence.inspect(sessionId)).events;'),
    ('if (persistence !== void 0) return (await persistence.readFrom(record.header.id, inherited)).events;',
     '// sessionPersistence no longer exposes readFrom; sessionQuery reads the full actual log.\n\treturn (await ctx.sessionQuery.readSession(record.header.id)).events.slice(inherited);'),
    ('const lineage = flattenLineage(rootTrace.target, rootTrace.descendants);',
     'const lineage = flattenLineage(rootTrace.target, rootTrace.descendants);\n\t// A concurrently created branch may be absent from the separate root observation.\n\tif (!lineage.some(({ record }) => record.header.id === sessionId)) lineage.push({ record: targetTrace.target, depth: targetTrace.ancestors.length });'),
    # An earlier revision archived the superseded source inside the route; the
    # client owns that step now (it must follow the UI switch), so undo it here.
    ('''\t\t\tinverses.length = 0;
\t\t\t// The branch supersedes its source: keep the original reachable through the
\t\t\t// Timeline's version list instead of the conversation list.
\t\t\tawait archiveSupersededSource(ctx, sourceId);
\t\t\treturn {''',
     '''\t\t\tinverses.length = 0;
\t\t\treturn {'''),
    # A faithful compression branch: copy the whole conversation and replace one
    # assistant block in place. Unlike \`edit\`, tool-call blocks and every later
    # step survive, and the copied session/title events name the branch.
    ('''\t\t\t\ttext: record["text"],
\t\t\t\tcascade: cascadeOf(record["cascade"])
\t\t\t};
\t\tcase "reroll": return {''',
     '''\t\t\t\ttext: record["text"],
\t\t\t\tcascade: cascadeOf(record["cascade"])
\t\t\t};
\t\tcase "splice":
\t\t\tif (typeof record["text"] !== "string") throw new TypeError("text 必须是字符串。");
\t\t\treturn {
\t\t\t\taction: "splice",
\t\t\t\tsessionId,
\t\t\t\teventSeq: integerOf(record["eventSeq"], "eventSeq"),
\t\t\t\tblockIndex: integerOf(record["blockIndex"], "blockIndex"),
\t\t\t\ttext: record["text"]
\t\t\t};
\t\tcase "reroll": return {'''),
    ('\t\tdefault: throw new TypeError("action 必须是 edit、reroll 或 retry。");',
     '\t\tdefault: throw new TypeError("action 必须是 edit、splice、reroll 或 retry。");'),
    ('''\tswitch (operation.action) {
\t\tcase "edit": return editPlan(operation, turns);''',
     '''\tswitch (operation.action) {
\t\tcase "edit": return editPlan(operation, turns);
\t\tcase "splice": return splicePlan(operation, events);'''),
    # The splice needs its planner and its in-place event rewriter, and versionSeed
    # has to apply the rewrite to the copied log before the version record is added.
    ('function agentOptions(events, fallback) {',
     '''/** Rewrite one assistant block in place: the branch is a copy of the whole
* conversation with that single block's text replaced. */
function splicePlan(operation, events) {
\tconst target = events[operation.eventSeq];
\tif (target === void 0 || target.type !== "assistant/message") throw new Error("splice 目标必须是助手消息事件。");
\tconst before = target.data.message.content[operation.blockIndex];
\tif (!isTextualBlock(before)) throw new Error("所选助手消息块不是文本或思考。");
\treturn {
\t\tboundary: events.length - 1,
\t\tversion: pairVersionEffect(operation.sessionId, {
\t\t\toperation: "edit",
\t\t\tcascade: "preserve",
\t\t\ttargetTurn: target.data.turn,
\t\t\ttargetEventSeq: target.seq,
\t\t\ttargetBlockIndex: operation.blockIndex,
\t\t\tblockKind: before.type === "reasoning" ? "assistant.reasoning" : "assistant.response",
\t\t\tbefore: before.text,
\t\t\tafter: operation.text
\t\t}),
\t\tsplice: {
\t\t\tseq: operation.eventSeq,
\t\t\tblockIndex: operation.blockIndex,
\t\t\ttext: operation.text
\t\t},
\t\tqueuedUsers: []
\t};
}
/** Copy one assistant message event with a single content block's text replaced.
* Tool-call blocks and the event envelope survive; the embedded provider stream no
* longer describes the edited content, so it is dropped. */
function splicedAssistantEvent(event, blockIndex, text) {
\tconst data = structuredClone(event.data);
\tdata.message.content[blockIndex] = {
\t\t...data.message.content[blockIndex],
\t\ttext
\t};
\tdata.stream = [];
\treturn {
\t\t...event,
\t\tdata
\t};
}
function agentOptions(events, fallback) {'''),
    ('''\tconst events = inheritedSeed(source, plan.boundary);
\tconst inheritedLength = events.length;
\tappendLogSeedEvent(events, "message-edit/version", plan.version);''',
     '''\tconst events = inheritedSeed(source, plan.boundary);
\tconst inheritedLength = events.length;
\tif (plan.splice !== void 0) events[plan.splice.seq] = splicedAssistantEvent(events[plan.splice.seq], plan.splice.blockIndex, plan.splice.text);
\tappendLogSeedEvent(events, "message-edit/version", plan.version);'''),
    # The branch-mutation route reads the same live Session log. It must not read
    # the removed `.events` array either, or every branch creation answers
    # 400 "events is not iterable" and the compression hand-off falls back in place.
    ('const events = source.session.events;',
     'const events = sessionLog(source.session);'),
    ('''function inheritedSeed(source, boundary) {
\tif (boundary === -1) return [];
\tconst boundaryEvent = source.events[boundary];
\tif (boundary < 0 || boundaryEvent === void 0 || boundaryEvent.seq !== boundary) throw new Error("分支边界不是连续会话事件。");
\treturn source.events.slice(0, boundary + 1);
}''',
     '''function inheritedSeed(source, boundary) {
\tif (boundary === -1) return [];
\tconst events = sessionLog(source);
\tconst boundaryEvent = events[boundary];
\tif (boundary < 0 || boundaryEvent === void 0 || boundaryEvent.seq !== boundary) throw new Error("分支边界不是连续会话事件。");
\treturn events.slice(0, boundary + 1);
}'''),
    ('''function sessionPreset(session) {
\tfor (let index = session.events.length - 1; index >= 0; index -= 1) {
\t\tconst event = session.events[index];''',
     '''function sessionPreset(session) {
\tconst events = sessionLog(session);
\tfor (let index = events.length - 1; index >= 0; index -= 1) {
\t\tconst event = events[index];'''),
)
OLD_RESPONSE_VALUE = '''\t\tasync function responseValue(response) {
\t\t\tconst value = await response.json();
\t\t\tif (response.ok) return value;
\t\t\tconst error = objectValue(value, "错误响应")["error"];
\t\t\tthrow new Error(typeof error === "string" ? error : `请求失败：HTTP ${String(response.status)}`);
\t\t}'''
NEW_RESPONSE_VALUE = '''\t\tconst MESSAGE_EDIT_DEADLINE_MS = globalThis.__MESSAGE_EDIT_DEADLINE_MS ?? 5e3;
\t\tasync function responseValue(response) {
\t\t\tconst value = await response.json();
\t\t\tif (response.ok) return value;
\t\t\tconst error = objectValue(value, "错误响应")["error"];
\t\t\tthrow new Error(typeof error === "string" ? error : `请求失败：HTTP ${String(response.status)}`);
\t\t}
\t\tasync function withDeadline(operation, abort, label) {
\t\t\tlet timer;
\t\t\ttry {
\t\t\t\treturn await Promise.race([operation(), new Promise((_, reject) => {
\t\t\t\t\ttimer = setTimeout(() => {
\t\t\t\t\t\treject(new Error(`${label}超时，请重新载入。`));
\t\t\t\t\t}, MESSAGE_EDIT_DEADLINE_MS);
\t\t\t\t})]);
\t\t\t} finally {
\t\t\t\tclearTimeout(timer);
\t\t\t}
\t\t}'''
OLD_LOAD = '''\t\t\t\t\tconst timeline = decodeTimeline(await responseValue(await fetch(`${MESSAGE_EDIT_PATH}?sessionId=${encodeURIComponent(this.sessionId)}`, {
\t\t\t\t\t\tmethod: "GET",
\t\t\t\t\t\theaders: { accept: "application/json" },
\t\t\t\t\t\tcache: "no-store",
\t\t\t\t\t\tsignal: abort.signal
\t\t\t\t\t})));'''
NEW_LOAD = '''\t\t\t\t\tconst timeline = decodeTimeline(await withDeadline(async () => responseValue(await fetch(`${MESSAGE_EDIT_PATH}?sessionId=${encodeURIComponent(this.sessionId)}`, {
\t\t\t\t\t\tmethod: "GET",
\t\t\t\t\t\theaders: { accept: "application/json" },
\t\t\t\t\t\tcache: "no-store",
\t\t\t\t\t\tsignal: abort.signal
\t\t\t\t\t})), abort, "载入消息时间线"));'''
OLD_NAVIGATION = '''\t\t\t\t\tlet settled = false;
\t\t\t\t\tlet dispose = () => {};
\t\t\t\t\tconst finish = (open) => {
\t\t\t\t\t\tif (settled) return;
\t\t\t\t\t\tsettled = true;
\t\t\t\t\t\tdispose();'''
NEW_NAVIGATION = '''\t\t\t\t\tlet settled = false;
\t\t\t\t\tlet dispose = () => {};
\t\t\t\t\tlet timer;
\t\t\t\t\tconst finish = (open) => {
\t\t\t\t\t\tif (settled) return;
\t\t\t\t\t\tsettled = true;
\t\t\t\t\t\tclearTimeout(timer);
\t\t\t\t\t\tdispose();'''
OLD_NAVIGATION_SUBSCRIBE = '''\t\t\t\t\tthis.navigationWaits.add(cancel);
\t\t\t\t\tdispose = this.sessions.list.subscribe(() => {'''
NEW_NAVIGATION_SUBSCRIBE = '''\t\t\t\t\tthis.navigationWaits.add(cancel);
\t\t\t\t\ttimer = setTimeout(cancel, MESSAGE_EDIT_DEADLINE_MS);
\t\t\t\t\tdispose = this.sessions.list.subscribe(() => {'''
CLIENT_BOUNDS = ((OLD_RESPONSE_VALUE, NEW_RESPONSE_VALUE), (OLD_LOAD, NEW_LOAD), (OLD_NAVIGATION, NEW_NAVIGATION), (OLD_NAVIGATION_SUBSCRIBE, NEW_NAVIGATION_SUBSCRIBE))
# The bounded server answers an unloaded session with a complete, empty timeline
# plus a human notice. Surface it instead of rendering the generic empty state.
OLD_NOTICE_DECODE = '''\t\t\t\tundoStack: stringArray(data["undoStack"], "Timeline undoStack"),
\t\t\t\tredoSessionIds: stringArray(data["redoSessionIds"], "Timeline redoSessionIds")
\t\t\t};'''
NEW_NOTICE_DECODE = '''\t\t\t\tundoStack: stringArray(data["undoStack"], "Timeline undoStack"),
\t\t\t\tredoSessionIds: stringArray(data["redoSessionIds"], "Timeline redoSessionIds"),
\t\t\t\t...((typeof data["notice"] === "string" && data["notice"].length > 0) ? { notice: data["notice"] } : {})
\t\t\t};'''
OLD_NOTICE_RENDER = '''\t\t\t\t\tstate.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
\t\t\t\t\t\tclassName: MessageEditTimelineView_module_css_default["error"],
\t\t\t\t\t\tchildren: state.error
\t\t\t\t\t}),
\t\t\t\t\tstate.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {'''
NEW_NOTICE_RENDER = '''\t\t\t\t\tstate.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
\t\t\t\t\t\tclassName: MessageEditTimelineView_module_css_default["error"],
\t\t\t\t\t\tchildren: state.error
\t\t\t\t\t}),
\t\t\t\t\ttimeline.notice === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
\t\t\t\t\t\tclassName: MessageEditTimelineView_module_css_default["notice"],
\t\t\t\t\t\tchildren: timeline.notice
\t\t\t\t\t}),
\t\t\t\t\tstate.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {'''
CLIENT_NOTICE = ((OLD_NOTICE_DECODE, NEW_NOTICE_DECODE), (OLD_NOTICE_RENDER, NEW_NOTICE_RENDER))
# The visible conversation is a UI-layer selection: ISessions owns the catalog, not
# the selection. Replace the stale sessions.open call with uiWorkspace.openSession,
# and let a created branch hide the conversation it replaced once it is on screen.
OLD_OPEN_LISTED = '''\t\t\t\tif (this.sessions.list.getSnapshot().byId[sessionId] !== void 0) {
\t\t\t\t\tthis.sessions.open(sessionId);
\t\t\t\t\treturn Promise.resolve();
\t\t\t\t}'''
NEW_OPEN_LISTED = '''\t\t\t\tif (this.sessions.list.getSnapshot().byId[sessionId] !== void 0) {
\t\t\t\t\tthis.openConversation(sessionId);
\t\t\t\t\treturn Promise.resolve(true);
\t\t\t\t}'''
OLD_OPEN_FINISH = '''\t\t\t\t\t\tif (open) this.sessions.open(sessionId);
\t\t\t\t\t\tresolve();'''
NEW_OPEN_FINISH = '''\t\t\t\t\t\tif (open) this.openConversation(sessionId);
\t\t\t\t\t\tresolve(open);'''
OLD_NAV_COMMENT = '''\t\t\t/** Session-list publication is the reactive dependency for navigation. */'''
NEW_NAV_COMMENT = '''\t\t\t/** Select one conversation through the UI navigation service. */
\t\t\topenConversation(sessionId) {
\t\t\t\tconst ui = this.ctx.get("uiWorkspace");
\t\t\t\tif (ui !== void 0 && typeof ui.openSession === "function") ui.openSession(sessionId);
\t\t\t}
\t\t\t/** Hide the conversation a branch replaced, once the branch is on screen.
\t\t\t* Best effort: an active source refuses and stays exactly as it was. */
\t\t\tasync archiveSuperseded(sourceSessionId, branchSessionId) {
\t\t\t\tif (sourceSessionId === branchSessionId) return;
\t\t\t\tconst ui = this.ctx.get("uiWorkspace");
\t\t\t\tif (ui === void 0 || typeof ui.archiveSession !== "function") return;
\t\t\t\ttry {
\t\t\t\t\tawait ui.archiveSession(sourceSessionId);
\t\t\t\t} catch {
\t\t\t\t\t// An active source refuses; nothing was written.
\t\t\t\t}
\t\t\t}
\t\t\t/** Session-list publication is the reactive dependency for navigation. */'''
OLD_MUTATE_OPEN = '''\t\t\t\t\tawait this.openWhenListed(result.sessionId);
\t\t\t\t\treturn true;'''
NEW_MUTATE_OPEN = '''\t\t\t\t\t// A branch replaces its source. Whether the source also leaves the conversation
\t\t\t\t\t// list is a product choice: archiveSuperseded is false for now, so it stays.
\t\t\t\t\tconst archiveSuperseded = false;
\t\t\t\t\tif (await this.openWhenListed(result.sessionId) && archiveSuperseded) await this.archiveSuperseded(this.sessionId, result.sessionId);
\t\t\t\t\treturn true;'''
CLIENT_HANDOFF = ((OLD_OPEN_LISTED, NEW_OPEN_LISTED), (OLD_OPEN_FINISH, NEW_OPEN_FINISH), (OLD_NAV_COMMENT, NEW_NAV_COMMENT), (OLD_MUTATE_OPEN, NEW_MUTATE_OPEN))
OLD_REVISION = '''\t\tfunction conversationRevision(snapshot) {
\t\t\tconst turnEnds = [...snapshot.turnEnds.entries()].map(([turn, seq]) => `${String(turn)}:${String(seq)}`).join(",");
\t\t\treturn [
\t\t\t\tsnapshot.openState,
\t\t\t\tsnapshot.removed,
\t\t\t\tsnapshot.hasMore,
\t\t\t\tturnEnds
\t\t\t].join("|");
\t\t}'''
NEW_REVISION = '''\t\tfunction conversationRevision(snapshot, eventSource) {
\t\t\t// SessionSnapshot no longer owns turnEnds. The binding's event window
\t\t\t// publishes a monotonic revision on every content change.
\t\t\tconst eventRevision = eventSource?.getSnapshot?.()?.revision;
\t\t\tconst turnEnds = snapshot?.turnEnds;
\t\t\tconst legacyTurns = Object.prototype.toString.call(turnEnds) === "[object Map]" ? [...turnEnds.entries()].map(([turn, seq]) => `${String(turn)}:${String(seq)}`).join(",") : "";
\t\t\treturn [
\t\t\t\tsnapshot?.openState ?? "",
\t\t\t\tsnapshot?.removed ?? "",
\t\t\t\tsnapshot?.hasMore ?? "",
\t\t\t\tNumber.isFinite(eventRevision) ? eventRevision : legacyTurns
\t\t\t].join("|");
\t\t}'''
OLD_BINDING = '''\t\t\t\tthis.sessionSource = source;
\t\t\t\tthis.sessionRevision = source === void 0 ? void 0 : conversationRevision(source.getSnapshot());
\t\t\t\tthis.sessionSourceDispose = source?.subscribe(() => {
\t\t\t\t\tif (this.sessionSource !== source) return;
\t\t\t\t\tconst revision = conversationRevision(source.getSnapshot());
\t\t\t\t\tif (revision === this.sessionRevision) return;
\t\t\t\t\tthis.sessionRevision = revision;
\t\t\t\t\tthis.invalidate();
\t\t\t\t});'''
NEW_BINDING = '''\t\t\t\tthis.sessionSource = source;
\t\t\t\tconst eventSource = this.sessions.binding(this.sessionId)?.eventSource;
\t\t\t\tthis.sessionRevision = source === void 0 ? void 0 : conversationRevision(source.getSnapshot(), eventSource);
\t\t\t\tconst changed = () => {
\t\t\t\t\tif (this.sessionSource !== source) return;
\t\t\t\t\tconst revision = conversationRevision(source.getSnapshot(), eventSource);
\t\t\t\t\tif (revision === this.sessionRevision) return;
\t\t\t\t\tthis.sessionRevision = revision;
\t\t\t\t\tthis.invalidate();
\t\t\t\t};
\t\t\t\tconst disposeSession = source?.subscribe(changed);
\t\t\t\tconst disposeEvents = eventSource?.subscribe?.(changed);
\t\t\t\tthis.sessionSourceDispose = () => { disposeSession?.(); disposeEvents?.(); };'''
#: Every known package that ships the same drifted client import.
CANDIDATES = (
    "dsh-message-edit",
    "@yunyv/dsh-message-edit",
)


def installed_candidates() -> list[pathlib.Path]:
    """Client bundles of every known package, installed or not."""
    import os
    roots = [pathlib.Path.home() / ".dsh/profiles/web/node_modules"]
    roots.extend(pathlib.Path(p) / "node_modules" for p in os.environ.get("DSH_PLUGIN_ROOTS", "").split(":") if p)
    return [root / name / "client.js" for root in roots for name in CANDIDATES]


def main() -> int:
    if len(sys.argv) == 1:
        present = [p for p in installed_candidates() if p.is_file()]
        if not present:
            print("none of the known packages are installed; looked for:")
            for candidate in installed_candidates():
                print(f"  {candidate}")
            print("install one first: dsh plugin --profile web add dsh-message-edit")
            return 1
        codes = [patch(path) for path in present for path in (path, path.with_name('index.mjs'))]
        return max(codes)
    path = pathlib.Path(sys.argv[1]).expanduser()
    if path.is_dir():
        return max(patch(path / name) for name in ('client.js', 'index.mjs'))
    return patch(path)


def patch(target: pathlib.Path) -> int:
    if not target.is_file():
        print(f"not found: {target}")
        print("install the plugin first: dsh plugin --profile web add dsh-message-edit")
        return 1
    source = target.read_text(encoding="utf8")
    replacements = SERVER_REPLACEMENTS if target.name == 'index.mjs' else ((DRIFTED, FIXED), (OLD_REVISION, NEW_REVISION), (OLD_BINDING, NEW_BINDING)) + ACTION_REPLACEMENTS + CLIENT_BOUNDS + CLIENT_NOTICE + CLIENT_HANDOFF
    for before, after in replacements:
        before_count = source.count(before)
        after_count = source.count(after)
        if after_count == 1:
            continue
        # The bounded server projection intentionally removes old lineage helpers;
        # their historical compatibility replacements are then no longer present.
        if target.name == 'index.mjs' and before_count == 0 and after_count == 0:
            continue
        if before_count != 1 or after_count != 0:
            print(f"nothing to patch (unexpected bundle structure): {target}")
            return 1
    patched = source
    for before, after in replacements:
        if patched.count(after) == 0:
            patched = patched.replace(before, after, 1)
    if target.name == 'index.mjs':
        try:
            patched = patch_server_timeline(patched)
            patched = patch_manual_turn(patched)
        except ValueError as error:
            print(f"nothing to patch ({error}): {target}")
            return 1
    if patched == source:
        print(f"already patched: {target}")
        return 0
    # Never expose a half-written or syntactically invalid installed bundle.
    temporary: pathlib.Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='w', encoding='utf8', dir=target.parent,
            prefix=f'.{target.stem}.tmp-', suffix=target.suffix, delete=False,
        ) as candidate:
            candidate.write(patched)
            candidate.flush()
            os.fsync(candidate.fileno())
            temporary = pathlib.Path(candidate.name)
        check = subprocess.run(
            ['node', '--check', str(temporary)], capture_output=True, text=True,
        )
        if check.returncode != 0:
            print(f"nothing written (node --check failed): {target}")
            print(check.stderr.rstrip())
            return 1
        backup = target.with_name(target.name + '.orig-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        backup.write_bytes(target.read_bytes())
        os.replace(temporary, target)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    print(f"backup: {backup}")
    print(f"checked then patched: {target}")
    print('next: refresh the existing dsh web page (restart dsh web if bundles are cached)')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
