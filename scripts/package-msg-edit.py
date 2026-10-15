#!/usr/bin/env python3
"""Repack the upstream dsh-msg-edit checkout into an installable, peer-relaxed tarball.

Upstream (github.com/moton16/dsh-msg-edit, MIT) ships a prebuilt lib/ but declares
peerDependencies against DSH ^0.1.0-rc.6 while this host runs 0.2.1-alpha.1, so `dsh plugin add`
refuses it and demands an explicit, per-profile risk exemption. This package keeps the npm name
(the plugin's own cordis rows refer to it by name), relaxes only those peer ranges, and refuses
to build from anything but the vendored revision.

Usage: python3 scripts/package-msg-edit.py
"""
import hashlib
import re
import io
import json
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
UPSTREAM = ROOT / 'vendor/dsh-msg-edit-0.1.0-upstream.tar.gz'
TARGET = ROOT / 'vendor/dsh-msg-edit-0.1.0-patched7.tgz'

# The host's replace-op validator (packages/core/session/src/surface.ts) accepts exactly
# { op: 'replace', startSeq, endSeq } and rejects anything else with "invalid replace
# surfaceOp" -- which is what every save answered. Upstream writes the previous revision's key
# names (start/end), so the append threw and nothing was ever recorded. Both of its replace
# sites (rewrite-message and regenerate) are rewritten.
REPLACE_OP = re.compile(r"surfaceOp: \{ op: 'replace', start: ([^,]+), end: ([^}]+) \}")

# Its editor panel is rendered inside the assistant-actions slot -- a narrow flex row -- and its
# CSS gives that panel no positioning at all, so the host's layout clips it: half a box, the
# Save/Cancel buttons out of reach, no way to close it. Turning the panel into a floating overlay
# fixes the clipping and puts it above the conversation (code blocks included) in one rule.
EDITOR_CSS_FROM = '.msg-edit-editor{display:flex;flex-direction:column;gap:6px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,#333);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#1e1e1e);min-width:280px}'
EDITOR_CSS_TO = '.msg-edit-editor{position:fixed;right:16px;bottom:96px;z-index:4000;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#333);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#1e1e1e);min-width:320px;width:min(620px,86vw);max-height:64vh;overflow:auto;box-shadow:0 10px 28px rgba(0,0,0,.38)}'

# Every one of its host handlers reads the session's event log as `session.events`, a property the
# 0.2.x Session no longer has: reading it threw a TypeError, which is why all four endpoints
# answered 500 and every save failed. The replacement is a method call -- snapshotEvents() --
# returning the same frozen, in-order event list (ownEvents() would drop a forked session's
# inherited prefix, which these handlers need). Both are deprecated in this host, which is the
# price of porting a plugin written against the previous API.
EVENTS_FROM = 'session.events'
EVENTS_TO = 'session.snapshotEvents()'

# Upstream's client renders four icons from @deepseek-ai/dsh-client-ui-primitives under the
# old names: this host exports ...OutlineRegular, not ...Outline16. An undefined component is
# React error #130, which crashes the whole assistant-actions slot, so the buttons never
# appeared even though the bundle loaded and registered. The pencil has no replacement in this
# version, so it becomes the wrap-lines glyph: purely cosmetic, and it keeps the slot alive.
ICON_RENAMES = {
    'IconCheckOutline16': 'IconCheckOutlineRegular',
    'IconCloseOutline16': 'IconCloseOutlineRegular',
    'IconRefreshOutline16': 'IconRefreshOutlineRegular',
    'IconEditOutline16': 'IconWrapLinesOutlineRegular',
}

# Upstream's client bundle registers itself under a local placeholder id. The client module
# table pairs a bundle with the profile row by *name*, so with that id the row can never
# activate: the shell reports "loaded without registering" and the plugin fails to load.
CLIENT_ID_FROM = 'id: "@local/dsh-client-ui-msg-edit"'
CLIENT_ID_TO = 'id: "@moton16/dsh-msg-edit"'

# Upstream requires an `agents` service that this host no longer provides, and a Cordis
# `inject` entry that cannot be satisfied keeps the whole entry from activating -- which is
# why the plugin registered no routes at all and its panel never appeared. Its only use of that
# service is `agentsSvc.get(sessionId)`, in resolveSession(); everything else it needs comes
# from `sessions`. So the inject list drops it and a shim answers for it: an agent-shaped object
# over the live session, whose steering methods are the ones this host no longer has.
INJECT_FROM = "export const inject = ['sessions', 'agents', 'webServer']"
INJECT_TO = "export const inject = ['sessions', 'webServer']"
AGENTS_FROM = "  const agentsSvc = ctx.get('agents')\n  const webServer = ctx.get('webServer')"
AGENTS_TO = """  const webServer = ctx.get('webServer')
  // This host has no `agents` service; answer for it with the live session so the resolver
  // still works. Steering (cancel/followup) is not available here and is a documented no-op.
  const agentsSvc = ctx.get('agents') ?? {
    get: (id) => {
      const session = sessionsSvc.get(id)
      if (session === undefined) return undefined
      return { session, status: 'idle', cancel() {}, followup() {}, whenIdle: async () => {} }
    },
  }"""

# Provenance of the vendored checkout: GitHub archive of branch main, verified once and
# pinned here so a silently replaced archive fails the build instead of shipping.
UPSTREAM_SHA256 = '4104320e04057361e5da0794c16e44308852f98fc7363cf666a84969e8cd2815'
UPSTREAM_REVISION = 'b2af7c9c2b62a2713de2499f9869a79054e6771d'
PEER_FLOOR = '>=0.1.0-rc.6'

digest = hashlib.sha256(UPSTREAM.read_bytes()).hexdigest()
if digest != UPSTREAM_SHA256:
    raise SystemExit(f'vendored archive changed: {digest} != {UPSTREAM_SHA256}')

relaxed: list[str] = []
with tarfile.open(UPSTREAM) as source, tarfile.open(TARGET, 'w:gz', format=tarfile.PAX_FORMAT) as target:
    for member in source:
        if member.isdir():
            continue
        parts = pathlib.PurePosixPath(member.name).parts
        relative = pathlib.PurePosixPath(*parts[1:]) if len(parts) > 1 else pathlib.PurePosixPath(parts[0])
        data = source.extractfile(member).read()
        if str(relative) == 'package.json':
            metadata = json.loads(data)
            if metadata['name'] != '@moton16/dsh-msg-edit':
                raise SystemExit(f"unexpected package name: {metadata['name']}")
            metadata['version'] = '0.1.0-patched7'
            peers = metadata.get('peerDependencies', {})
            for key in list(peers):
                peers[key] = PEER_FLOOR
                relaxed.append(key)
            metadata['peerDependencies'] = peers
            data = (json.dumps(metadata, ensure_ascii=False, indent=2) + '\n').encode('utf8')
        elif str(relative) == 'lib/client.js':
            text = data.decode('utf8')
            if text.count(CLIENT_ID_FROM) != 1:
                raise SystemExit('client bundle no longer registers the placeholder id exactly once')
            text = text.replace(CLIENT_ID_FROM, CLIENT_ID_TO, 1)
            for old, new in ICON_RENAMES.items():
                if old not in text:
                    raise SystemExit(f'client bundle no longer uses {old}')
                text = text.replace(old, new)
            if EDITOR_CSS_FROM not in text:
                raise SystemExit('client bundle no longer carries the editor panel rule')
            text = text.replace(EDITOR_CSS_FROM, EDITOR_CSS_TO, 1)
            data = text.encode('utf8')
            registration = CLIENT_ID_TO + ' + ' + str(len(ICON_RENAMES)) + ' icon names'
        elif str(relative) == 'lib/index.js':
            text = data.decode('utf8')
            if text.count(INJECT_FROM) != 1 or text.count(AGENTS_FROM) != 1:
                raise SystemExit('host bundle no longer matches the patched inject/agents shape')
            if EVENTS_FROM not in text:
                raise SystemExit('host bundle no longer reads session.events')
            text = text.replace(EVENTS_FROM, EVENTS_TO)
            text, replaced_ops = REPLACE_OP.subn(r"surfaceOp: { op: 'replace', startSeq: \1, endSeq: \2 }", text)
            if replaced_ops < 1 or "op: 'replace', start:" in text:
                raise SystemExit('host bundle replace ops no longer match the expected shape')
            data = text.replace(INJECT_FROM, INJECT_TO, 1).replace(AGENTS_FROM, AGENTS_TO, 1).encode('utf8')
            host_patch = 'agents shim + inject + event reads'
        info = tarfile.TarInfo(f'package/{relative}')
        info.size = len(data)
        info.mode = member.mode or 0o644
        info.mtime = member.mtime
        target.addfile(info, io.BytesIO(data))
print(f'packed: {TARGET} (name @moton16/dsh-msg-edit, version 0.1.0-patched7)')
print('replace ops: start/end -> startSeq/endSeq (the only shape the host validator accepts)')
print('editor panel: floating overlay (position:fixed, z-index:4000, 64vh scroll)')
print('host: session.events -> session.snapshotEvents()')
print('client icons: ' + ', '.join(f'{old}->{new}' for old, new in ICON_RENAMES.items()))
print('host bundle: dropped the missing agents dependency and answered for it with a shim')
print(f'client registers as {CLIENT_ID_TO}')
print(f'relaxed peers to {PEER_FLOOR}: {", ".join(relaxed)}')
print(f'built from: {UPSTREAM_REVISION} (sha256 {UPSTREAM_SHA256[:16]}...)')
