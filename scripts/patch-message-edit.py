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

import pathlib
import sys
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
SERVER_REPLACEMENTS = (
    ('if (persistence !== void 0) return (await persistence.inspect(sessionId)).events;',
     'if (typeof persistence?.inspect === "function") return (await persistence.inspect(sessionId)).events;'),
    ('if (persistence !== void 0) return (await persistence.readFrom(record.header.id, inherited)).events;',
     '// sessionPersistence no longer exposes readFrom; sessionQuery reads the full actual log.\n\treturn (await ctx.sessionQuery.readSession(record.header.id)).events.slice(inherited);'),
    ('const lineage = flattenLineage(rootTrace.target, rootTrace.descendants);',
     'const lineage = flattenLineage(rootTrace.target, rootTrace.descendants);\n\t// A concurrently created branch may be absent from the separate root observation.\n\tif (!lineage.some(({ record }) => record.header.id === sessionId)) lineage.push({ record: targetTrace.target, depth: targetTrace.ancestors.length });'),
)
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
    replacements = SERVER_REPLACEMENTS if target.name == 'index.mjs' else ((DRIFTED, FIXED), (OLD_REVISION, NEW_REVISION), (OLD_BINDING, NEW_BINDING)) + ACTION_REPLACEMENTS
    for before, after in replacements:
        if source.count(after) == 1:
            continue
        if source.count(before) != 1 or source.count(after) != 0:
            print(f"nothing to patch (unexpected bundle structure): {target}")
            return 1
    patched = source
    for before, after in replacements:
        if patched.count(after) == 0:
            patched = patched.replace(before, after, 1)
    if patched == source:
        print(f"already patched: {target}")
        return 0
    backup = target.with_name(target.name + '.orig-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.write_bytes(target.read_bytes())
    target.write_text(patched, encoding="utf8")
    print(f"backup: {backup}")
    print(f"patched: {target}")
    print('next: refresh the existing dsh web page (restart dsh web if bundles are cached)')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
