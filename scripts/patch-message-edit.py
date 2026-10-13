#!/usr/bin/env python3
"""Fix dsh-message-edit's drifted client import so DSH can boot with it installed.

The published plugin requires `@deepseek-ai/dsh-client-runtime/client` for
`createSnapshotStore`. That specifier only exists in DSH's **test-support**
build, so at runtime the platform module table cannot resolve it and the whole
web boot fails with "import failed: client-modules: require(...) missed the
module table".

`createSnapshotStore` is re-exported from `@deepseek-ai/dsh-client-store`
(`packages/client/store/src/index.ts:103`), which is a real platform seed module.
Rewriting the specifier is therefore a semantic no-op.

Usage:  python3 scripts/patch-message-edit.py [client.js path]
Default path: ~/.dsh/profiles/web/node_modules/dsh-message-edit/client.js
Re-run after every reinstall/upgrade of the plugin (installs overwrite it).
"""
from __future__ import annotations

import pathlib
import sys

DRIFTED = 'require("@deepseek-ai/dsh-client-runtime/client")'
FIXED = 'require("@deepseek-ai/dsh-client-store")'
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
        codes = [patch(path) for path in present]
        return max(codes)
    return patch(pathlib.Path(sys.argv[1]).expanduser())


def patch(target: pathlib.Path) -> int:
    if not target.is_file():
        print(f"not found: {target}")
        print("install the plugin first: dsh plugin --profile web add dsh-message-edit")
        return 1
    source = target.read_text(encoding="utf8")
    if FIXED in source:
        print(f"already patched: {target}")
        return 0
    if DRIFTED not in source:
        print(f"nothing to patch (unexpected bundle): {target}")
        return 1
    target.write_text(source.replace(DRIFTED, FIXED, 1), encoding="utf8")
    print(f"patched: {target}")
    print('next: restart `dsh web` (the boot failure should be gone)')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
