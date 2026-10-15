#!/usr/bin/env bash
# Programmatic install for one assistant-rewrite backend, driven by the plugin's
# quick-install page. Speaks the runner's line protocol on stdout:
#   ##STEP <id>   ##DONE <id>   ##FAIL <id> <message>
# Everything else is ordinary output and shows up in the page's log view.
#
# Only message-edit has a verified procedure (README: "安装与修补 message-edit 后端的完整流程");
# the other backends have none, and this script says so instead of guessing.
set -uo pipefail

backend="${1:-}"
step() { printf '##STEP %s\n' "$1"; }
finish() { printf '##DONE %s\n' "$1"; }
fail() { printf '##FAIL %s %s\n' "$1" "${2:-失败}"; exit 1; }

if [ "$backend" != "message-edit" ]; then
  fail resolve "没有 $backend 的程序化安装（该后端在本仓库从未验证，请改用 agent 模式）"
fi

step resolve
: "${DSH_HOME:=$HOME/.dsh}"
profile="${DSH_PROFILE:-web}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tgz="$root/vendor/dsh-message-edit-0.2.3-patched4.tgz"
checkout="${DSH_CHECKOUT:-$(pwd)}"
[ -f "$tgz" ] || fail resolve "找不到打好补丁的包：$tgz"
[ -f "$checkout/package.json" ] || fail resolve "工作目录不像 DSH checkout：$checkout（可用 DSH_CHECKOUT 指定）"
printf 'checkout=%s\nprofile=%s\nhome=%s\n' "$checkout" "$profile" "$DSH_HOME"
finish resolve

step install
if ! ( cd "$checkout" && pnpm dsh plugin --profile "$profile" add "$tgz" ); then
  fail install "官方 CLI 安装失败（见上面的输出）"
fi
finish install

step patch
# Point the patcher at the profile this script just installed into: its own discovery
# would otherwise look in the default home, which need not be the one in play here.
if ! DSH_PLUGIN_ROOTS="$DSH_HOME/profiles/$profile" python3 "$root/scripts/patch-message-edit.py"; then
  fail patch "补丁脚本失败（见上面的输出）"
fi
finish patch

step verify
module="$DSH_HOME/profiles/$profile/node_modules/dsh-message-edit"
[ -d "$module" ] || fail verify "安装目录不存在：$module"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
tar -xzf "$tgz" -C "$tmp" || fail verify "vendor 包无法解压"
cmp -s "$tmp/package/index.mjs" "$module/index.mjs" || fail verify "index.mjs 与 vendor 不一致"
cmp -s "$tmp/package/client.js" "$module/client.js" || fail verify "client.js 与 vendor 不一致"
printf '安装件与 vendor 逐字节一致\n'
finish verify

printf '完成：重启 dsh web 后生效（客户端半边硬刷新即可）。\n'
