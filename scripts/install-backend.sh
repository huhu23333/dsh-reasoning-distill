#!/usr/bin/env bash
# Programmatic install for one assistant-rewrite backend, driven by the plugin's
# quick-install page. Speaks the runner's line protocol on stdout:
#   ##STEP <id>   ##DONE <id>   ##FAIL <id> <message>
# Everything else is ordinary output and shows up in the page's log view.
#
# Two backends have a procedure here:
#   message-edit  a companion package installed through the official CLI and then patched
#                 (README: "安装与修补 message-edit 后端的完整流程")
#   in-place      this plugin's own backend; its entire prerequisite is a patch to the host,
#                 so the quick install IS the patch (scripts/dsh-inplace-patch.mjs)
# Anything else has no procedure, and this script says so instead of guessing.
set -uo pipefail

backend="${1:-}"
step() { printf '##STEP %s\n' "$1"; }
finish() { printf '##DONE %s\n' "$1"; }
fail() { printf '##FAIL %s %s\n' "$1" "${2:-失败}"; exit 1; }

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$backend" = "in-place" ]; then
  step resolve
  patch="$root/scripts/dsh-inplace-patch.mjs"
  [ -f "$patch" ] || fail resolve "补丁脚本不存在：$patch"
  # The checkout is DISCOVERED, never assumed: DSH on this machine is not in anyone else's home.
  # An explicit DSH_CHECKOUT / DSH_HOST_CHECKOUT wins; otherwise the patch script walks up from
  # this process's working directory and from the host's own resolved session package, and says
  # everything it tried when it finds nothing.
  checkoutArgs=()
  if [ -n "${DSH_CHECKOUT:-}" ]; then
    checkoutArgs=(--checkout "$DSH_CHECKOUT")
  elif [ -n "${DSH_HOST_CHECKOUT:-}" ]; then
    checkoutArgs=(--checkout "$DSH_HOST_CHECKOUT")
  fi
  located=""
  if ! located="$(node "$patch" --locate ${checkoutArgs[@]+"${checkoutArgs[@]}"} 2>&1)"; then
    # A packaged install (dsh-desktop and similar) is a read-only dependency closure with no
    # source tree: no --checkout can turn it into one, so name that instead of a path list.
    for cand in "${DSH_HOST_CHECKOUT:-}" "${DSH_CHECKOUT:-}" "$PWD"; do
      [ -n "$cand" ] || continue
      if [ -f "$cand/package.json" ] && [ -d "$cand/node_modules/@deepseek-ai/dsh" ] && [ ! -f "$cand/packages/core/session/src/surface.ts" ]; then
        fail resolve "这是打包版 DSH（$cand：只有 node_modules、没有源码，且通常只读）。in-place 后端需要可写的 DSH 源码树，无法在这种安装里使用；请改用 message-edit 后端"
      fi
    done
    fail resolve "定位 DSH checkout 失败（可用 DSH_CHECKOUT 指定 DSH 源码目录）：$located"
  fi
  printf 'checkout=%s\npatch=%s\n' "$located" "$patch"
  finish resolve

  step install
  # This backend ships inside this plugin. Its prerequisite is a host patch, not a package, so the
  # step is reported done with that reason instead of being silently skipped by the page.
  printf '内置后端：无需安装伴随包，安装就是给宿主打补丁\n'
  finish install

  step patch
  if ! node "$patch" --apply ${checkoutArgs[@]+"${checkoutArgs[@]}"}; then
    fail patch "补丁脚本失败（见上面的输出）"
  fi
  # The build only refreshes lib/ artifacts and type-checks the patched packages. A checkout that
  # runs dsh straight from src works without it, so a build failure is reported, not fatal.
  if ! node "$patch" --build ${checkoutArgs[@]+"${checkoutArgs[@]}"}; then
    printf '警告：tsc -b 未通过（补丁已经应用，宿主源码已是补丁版）。从 src 运行的宿主不受影响；从 lib/ 运行的宿主需要先修好构建再重启。\n'
  fi
  finish patch

  step verify
  if ! node "$patch" --check ${checkoutArgs[@]+"${checkoutArgs[@]}"} | grep -q '^PATCHED$'; then
    fail verify "补丁校验未通过（--check 没有输出 PATCHED）"
  fi
  printf '补丁脚本报告 PATCHED\n'
  finish verify

  where=""
  [ "${#checkoutArgs[@]}" -gt 0 ] && where=" ${checkoutArgs[*]}"
  printf '完成：重启 dsh web 后生效。回退：node %s --revert --build%s\n' "$patch" "$where"
  exit 0
fi

if [ "$backend" != "message-edit" ]; then
  fail resolve "没有 $backend 的程序化安装（该后端在本仓库从未验证，请改用 agent 模式）"
fi

step resolve
: "${DSH_HOME:=$HOME/.dsh}"
profile="${DSH_PROFILE:-web}"
tgz="$root/vendor/dsh-message-edit-0.2.3-patched4.tgz"
checkout="${DSH_CHECKOUT:-$(pwd)}"
[ -f "$tgz" ] || fail resolve "找不到打好补丁的包：$tgz"
[ -f "$checkout/package.json" ] || fail resolve "工作目录不像 DSH checkout：$checkout（可用 DSH_CHECKOUT 指定）"
printf 'checkout=%s\nprofile=%s\nhome=%s\n' "$checkout" "$profile" "$DSH_HOME"
finish resolve

step install
# Prefer the installation's own CLI entry when it ships one. A packaged install
# (dsh-desktop and similar) is READ-ONLY: `pnpm dsh` first runs pnpm's dependency-status check
# inside that directory and dies with EACCES before the CLI ever runs. Invoking bin.js directly
# skips the pnpm script-runner and lets the CLI drive pnpm in the writable profile directory.
cli=""
for cand in \
  "${DSH_CHECKOUT:+$DSH_CHECKOUT/node_modules/@deepseek-ai/dsh/lib/bin.js}" \
  "${DSH_HOST_CHECKOUT:+$DSH_HOST_CHECKOUT/node_modules/@deepseek-ai/dsh/lib/bin.js}" \
  "$PWD/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  "$checkout/node_modules/@deepseek-ai/dsh/lib/bin.js"; do
  [ -n "$cand" ] || continue
  if [ -f "$cand" ]; then cli="$cand"; break; fi
done
installed=0
if [ -n "$cli" ]; then
  printf 'dsh CLI：%s\n' "$cli"
  ( cd "${DSH_HOME:-$HOME}" && node "$cli" plugin --profile "$profile" add "$tgz" ) || installed=1
else
  printf '未找到打包的 dsh CLI；回退到 pnpm dsh（源码 checkout）\n'
  ( cd "$checkout" && pnpm dsh plugin --profile "$profile" add "$tgz" ) || installed=1
fi
[ "$installed" = 0 ] || fail install "官方 CLI 安装失败（见上面的输出）"
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
