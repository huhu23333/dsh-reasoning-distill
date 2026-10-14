#!/usr/bin/env python3
"""Rebuild vendor's patched package deterministically from patched1 + client/server patches.

Usage: python3 scripts/package-message-edit.py
The npm package identity stays dsh-message-edit (never rename the bundle id).
"""
import io
import json
import pathlib
import tarfile

from importlib.machinery import SourceFileLoader

ROOT = pathlib.Path(__file__).resolve().parent.parent
patch = SourceFileLoader('message_edit_patch', str(ROOT / 'scripts/patch-message-edit.py')).load_module()
source = ROOT / 'vendor/dsh-message-edit-0.2.3-patched1.tgz'
target = ROOT / 'vendor/dsh-message-edit-0.2.3-patched2.tgz'
with tarfile.open(source, 'r:gz') as original, tarfile.open(target, 'w:gz', format=tarfile.PAX_FORMAT) as output:
    for member in original:
        if not member.isfile():
            output.addfile(member)
            continue
        data = original.extractfile(member).read()
        if member.name == 'package/client.js':
            text = data.decode('utf8')
            for before, after in ((patch.DRIFTED, patch.FIXED), (patch.OLD_REVISION, patch.NEW_REVISION), (patch.OLD_BINDING, patch.NEW_BINDING)) + patch.ACTION_REPLACEMENTS:
                if text.count(after) == 1:
                    continue
                if text.count(before) != 1:
                    raise ValueError('unexpected client bundle shape')
                text = text.replace(before, after, 1)
            data = text.encode('utf8')
        elif member.name == 'package/index.mjs':
            text = data.decode('utf8')
            for before, after in patch.SERVER_REPLACEMENTS:
                if text.count(after) == 1:
                    continue
                if text.count(before) != 1:
                    raise ValueError('unexpected server bundle shape')
                text = text.replace(before, after, 1)
            data = text.encode('utf8')
        elif member.name == 'package/package.json':
            metadata = json.loads(data)
            assert metadata['name'] == 'dsh-message-edit' and metadata['version'] == '0.2.3-patched1'
            metadata['version'] = '0.2.3-patched2'
            data = (json.dumps(metadata, ensure_ascii=False, indent=2) + '\n').encode('utf8')
        member.size = len(data)
        output.addfile(member, io.BytesIO(data))
print(f'packed: {target} (name: dsh-message-edit)')
