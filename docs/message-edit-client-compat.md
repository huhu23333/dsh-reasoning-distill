# dsh-message-edit 客户端兼容补丁

## 根因

安装版 `client.js:120-128` 的 `conversationRevision` 对 `snapshot.turnEnds.entries()` 做无条件读取。`client.js:247-250,269-277` 的 `snapshot` 实际来自 `sessions.binding(id)?.session.getSnapshot()`；对应安装版 source map 的 `controller.ts:179,314,339`。现行宿主 `SessionSnapshot`（`packages/api/session-controller/src/client/contract/snapshot.ts:69-91`）没有 `turnEnds`；这个字段仅存在于 ui-chat `LegacyConversationSlice`。因此 `undefined.entries` 在新 controller 初始化时同步抛出；两个插槽共用 controller，均无法渲染。已确认插件 bundle 加载成功，所以这不是启用或网络问题。

## 补丁

`scripts/patch-message-edit.py` 保留旧有模块 specifier 修复，新增结构断言与两处外科替换：

1. `conversationRevision` 安全读取可选的 Map；缺失/异形时不抛错。优先使用宿主真正提供的 `SessionBinding.eventSource.getSnapshot().revision`（`service.ts:98-104`、`events.ts:79-114`），它对事件窗口每次变更递增。
2. `bindSessionSource` 在 Session 订阅之外订阅 `eventSource`，并在释放时共同取消；这样事件内容变化会触发已有 `invalidate()` 节流刷新。若没有 eventSource，退回稳定生命周期字段与有效旧版 Map 摘要，保持插槽可渲染；此漂移回退不保证捕获纯内容变更。

安装版修改前自动备份为 `client.js.orig-<UTC 时间戳>`，二次执行幂等；未知 bundle 形状拒绝修改。

## 证明

在仓库根目录运行：

```sh
node scripts/repro-message-edit-client.cjs ~/.dsh/profiles/web/node_modules/dsh-message-edit/client.js.orig-20261014T085916Z --expect-failure
node scripts/repro-message-edit-client.cjs ~/.dsh/profiles/web/node_modules/dsh-message-edit/client.js
```

输出摘要：`BEFORE: both slot injections throw TypeError: Cannot read properties of undefined (reading entries)`；`AFTER: both slot injections succeed; stable fallback open|false|false|, event revision 0→1 observed`。桩加载完整 bundle，断言同一 controller 被两插槽复用、可选 Map 与宿主事件 revision 的行为。

## 可重复性

重装之后推荐安装已修复归档：

```sh
dsh plugin --profile web add ./vendor/dsh-message-edit-0.2.3-patched2.tgz
```

也可对任何兼容的已安装旧包重新应用：`python3 scripts/patch-message-edit.py`。重新打包：`python3 scripts/package-message-edit.py`（从原始 patched1 归档生成 patched2）；归档内包名仍为 `dsh-message-edit`，匹配 bundle id。之后刷新已有 DSH Web 页面；若 bundle 缓存仍旧，重新启动原 `dsh web` 服务再刷新。归档的 source map 仍指向上游原始源码，调试补丁位置请参见此文档及实际 `client.js`。

## Timeline 有界等待与服务端上限

现行安装件的 Timeline GET 原先把 `fetch()` 和 `response.json()` 直接串在 `status = "loading"` 后，没有 deadline；`openWhenListed()` 也只有列表订阅，没有 deadline。任一 promise 不 settle 时，Timeline 永久显示“正在载入”，而 Header 在 `status !== "ready"` 时向行内编辑器传空 messages，所以编辑按钮同源消失。

patched3 为 GET（包含正文读取）和版本导航各加 5 秒 deadline。GET 超时进入现有 error 状态并显示“重新载入”，不向插槽抛错；导航超时只结束等待，不打开不存在的 session。服务端返回最近 200 条可编辑消息，并继续裁剪到 JSON 不超过 128 KiB；超限只保留最新消息。按 live log 的事件长度/末 seq 与 lineage header 指纹缓存投影，避免真信号未变化时重复读取全部日志。

重复证明：

```sh
node scripts/repro-message-edit-client.cjs ~/.dsh/profiles/web/node_modules/dsh-message-edit/client.js.orig-20261014T130501Z --deadline-red
node scripts/repro-message-edit-client.cjs ~/.dsh/profiles/web/node_modules/dsh-message-edit/client.js
node scripts/repro-message-edit-server.mjs ~/.dsh/profiles/web/node_modules/dsh-message-edit/index.mjs
```

重生成归档使用 `python3 scripts/package-message-edit.py`，产物为 `vendor/dsh-message-edit-0.2.3-patched3.tgz`，包内名称仍是 `dsh-message-edit`。

## 残余

存在 eventSource 的现行 Session binding：Timeline/编辑按钮不再因初始化崩溃，且事件变更继续触发刷新。缺失 eventSource 的旧宿主虽可渲染，纯内容变化无法由静态回退推导，可能要手动重开以刷新。服务端模块在进程启动时加载；安装件已更新，但遵守本任务“不重启宿主”的边界，当前已运行进程要到下次正常启动后才加载 patched3 服务端缓存与上限。
