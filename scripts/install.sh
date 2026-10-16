#!/usr/bin/env bash
# Build this plugin and install it into a DSH profile as a live `link:` dependency.
#
# Why a link plus a shim: the profile resolves plugin packages from its own
# node_modules, but Node resolves a symlinked package by its REAL path — so a
# linked plugin cannot see the profile's shared `@deepseek-ai/*` packages unless
# its own node_modules carries a pointer to them. The shim below adds exactly
# that pointer, which keeps `link:` working and lets a client rebuild hot-swap
# through client-hmr without reinstalling anything.
set -euo pipefail

# WARNING: npm install (any dependency change) prunes the extraneous
# `node_modules/@deepseek-ai` symlink this script creates. Re-run this script
# after every npm install, or the plugin cannot resolve the host runtime.

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
SHARED="$DSH_HOME/profiles/node_modules/@deepseek-ai"

if [ ! -d "$SHARED" ]; then
  echo "install: shared runtime packages not found at $SHARED" >&2
  echo "install: start DSH once so it materialises the profile, then retry." >&2
  exit 1
fi

echo "install: building $PLUGIN_DIR"
(cd "$PLUGIN_DIR" && npm run build)

echo "install: linking shared runtime packages into the plugin"
mkdir -p "$PLUGIN_DIR/node_modules"
rm -rf "$PLUGIN_DIR/node_modules/@deepseek-ai"
ln -s "$SHARED" "$PLUGIN_DIR/node_modules/@deepseek-ai"

echo "install: adding the plugin to profile '$PROFILE'"
# `dsh plugin` forwards its arguments to pnpm inside the profile directory and
# reconciles newly installed bundles into dsh.profile.bundles.
# The DSH source checkout is FOUND, never assumed: an explicit DSH_CHECKOUT wins, otherwise the
# plugin's shared resolver walks up from this process's cwd and from the host's session package.
CHECKOUT="${DSH_CHECKOUT:-${DSH_HOST_CHECKOUT:-$(node "$PLUGIN_DIR/scripts/dsh-inplace-patch.mjs" --locate)}}"
(cd "$CHECKOUT" && pnpm dsh plugin --profile "$PROFILE" add "$PLUGIN_DIR")

echo
echo "install: done. Restart 'dsh web' once so the Loader rescans the profile"
echo "install: (bundle metadata is cached until restart). After that, host edits"
echo "install: need a restart and client edits hot-swap on \`npm run build\`."
