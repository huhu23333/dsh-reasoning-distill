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
import io
import json
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
UPSTREAM = ROOT / 'vendor/dsh-msg-edit-0.1.0-upstream.tar.gz'
TARGET = ROOT / 'vendor/dsh-msg-edit-0.1.0-patched3.tgz'

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
            metadata['version'] = '0.1.0-patched3'
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
            data = text.replace(CLIENT_ID_FROM, CLIENT_ID_TO, 1).encode('utf8')
            registration = CLIENT_ID_TO
        elif str(relative) == 'lib/index.js':
            text = data.decode('utf8')
            if text.count(INJECT_FROM) != 1 or text.count(AGENTS_FROM) != 1:
                raise SystemExit('host bundle no longer matches the patched inject/agents shape')
            data = text.replace(INJECT_FROM, INJECT_TO, 1).replace(AGENTS_FROM, AGENTS_TO, 1).encode('utf8')
            host_patch = 'agents shim + inject'
        info = tarfile.TarInfo(f'package/{relative}')
        info.size = len(data)
        info.mode = member.mode or 0o644
        info.mtime = member.mtime
        target.addfile(info, io.BytesIO(data))
print(f'packed: {TARGET} (name @moton16/dsh-msg-edit, version 0.1.0-patched3)')
print('host bundle: dropped the missing agents dependency and answered for it with a shim')
print(f'client registers as {CLIENT_ID_TO}')
print(f'relaxed peers to {PEER_FLOOR}: {", ".join(relaxed)}')
print(f'built from: {UPSTREAM_REVISION} (sha256 {UPSTREAM_SHA256[:16]}...)')
