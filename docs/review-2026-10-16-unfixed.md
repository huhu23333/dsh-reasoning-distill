# 已知问题清单（0.1.12 复核）

> **2026-10-22 后续更新**：实验确认 DSH 的请求一般情况下始终携带 tools，而带 tools 时之前轮次的 reasoning 会随每次请求重新发送并被模型看到（实验与抓包验证见 [deepseek-reasoning-experiment](https://github.com/huhu23333/deepseek-reasoning-experiment)）。因此本清单中“只在产出压缩的那一轮计费 / per-entry stock 与合计同轮次过滤”的描述（见 §2）已被 0.1.13 的**跨轮次计费**取代：所有仍生效（目标未被 compaction 淘汰）的改写会在其后的每一次已应答请求上计入节省。本清单其余内容仍按当时版本记录。
>
> 本清单按 **2026-10-22 的 0.1.12 修复** 更新：§1 是**仍未修复**的项（每条给出原因与需要谁拍板），§2 是本版已修复项（便于对照，不再逐条复述细节），§3 是复核方法与局限。

**产品决定（已定案）**：总开关只控制**是否发起新的蒸馏**；已经生效的压缩版继续替换/重放。若要恢复原文，需停用/卸载插件或删除 sidecar 记录；in-place 已写进日志的改写需回退宿主补丁并从日志恢复。README 与设置页已按此语义更新。

---

## 1. 仍未修复

### 1.1 【P1】in-place 的持久化屏障仍可能"flush 成功但改写尚未落盘"
- 现状：插件在 `rewriteReasoningBlock` 后等待一个宏任务再 `sessions.flush`（`src/engine.ts` `settleInPlaceEntry`/`applyInPlace`），flush 失败已不再标记已写入；但宿主补丁的 rewrite sink 仍是发射后不管（`scripts/dsh-inplace-patch.mjs` 中 `session.setRewriteSink(event => { this.rewrite([event]).catch(reportFailure) })`），补丁侧没有可供 await 的 promise，flush 不保证包含这次改写。
- 为什么没修：治本要让 sink 返回可等待的 promise，并把 handle 的 flush 串到它后面；这会改动已登记锚点的宿主补丁，需要重新验证所有覆盖版本并重新打补丁。当前已消除"谎报成功"的一半（flush 失败会返回失败/不标记），但进程崩溃场景仍可能丢一次已标记的写回。
- 建议：补丁侧引入 `pendingRewrite` 并在 handle.flush 前 await；或宿主暴露 rewrite 的 durability barrier。

### 1.2 【P2】in-place 留下"旧签名 + 新文本"
- 宿主补丁的 `rewriteReasoningBlock` 仍只重建 `message.content`、保留 `message.source.replayState`；DeepSeek 序列化器把当前文本与 replay 里的签名配对。插件运行时会洗掉派生消息上的 payload，但停用/卸载/未装插件的重启后就没人洗。
- 为什么没修：把清理写进补丁会改变已插入成员的内容，已打过旧补丁的宿主会被判成"未打补丁"，再 apply 会重复插入方法。需要一次带迁移的补丁版本（legacy 形态识别 + 升级路径），并在所有覆盖版本上重验。
- 建议：下一个补丁版本增加 replay scrub 并配迁移。

### 1.3 【P2】跨进程共享同一 `DSH_HOME` 无跨进程串行化（C5）
- `SidecarStore` 的写队列/缓存是进程内状态，`update` 整文件原子 rename、无进程间锁；两个宿主进程共享 home 时"最后写者覆盖"。
- 现状：按"单写者"使用前提工作；未引入锁协议（陈旧锁/持有者崩溃是新的失败模式）。
- 建议：要么文档化单写者约束，要么上游提供单会话写所有权。

### 1.4 【P2】token-meter 走模块级自由函数（C6，上游）
- 宿主 token-meter 的 `deriveEventMessage` 绕过插件包装，上下文占用按原文估价（偏高，保守）。`contextCap` 可能略早触发，不会漏压。
- 建议：上游让 token-meter 走 session 方法或暴露注入点。

### 1.5 【P2】`cacheBreakTokens`/`cacheBreakCost` 恒为 0（N6）
- 正常路径下改写发生在首次重放之前，0 如实；但 sidecar 读失败后恢复、写回失败轮询补写、停用后宿主缓存仍持压缩版这几条回退路径会让后缀重新按未命中计费，报告会高估净收益。
- 现状：字段保留为 0（兼容旧 sidecar 与面板），README 明示该口径。实现"后缀归属计价"需要重建计费模型，未做。

### 1.6 【P2】路由信任边界（B10/N3/N5 的属主部分）
- `/api/*` 只依赖宿主 connection 的凭据栅栏（操作员即授权）；`/report` 对知道 session id 的调用方返回完整思考原文/工具输出，`/install` 会在宿主进程 spawn 安装脚本。
- 本版已做的加固：`/rewrite` 不再接受调用方文本（只用 sidecar 的 distilledText）；`/report` 支持轻量模式；陌生 id 的空白记录不再缓存。属主/多用户隔离需要宿主提供"请求来自哪个会话"的 capability（上游）。

### 1.7 【P2】蒸馏输入总长度仍无上限（N4 的剩余部分）
- 本版已让 `maxInputChars` 作用于每个上下文块（参数/可见文本/工具结果），默认 0 时仍会把整段上下文发给蒸馏 provider；没有"整次输入总量"上限。
- 建议：增加按 token/字符的 total cap，或文档明示默认会把工具输出发给蒸馏服务商。

### 1.8 【P3】审计会话在宿主 SessionStore 中仍保留到进程结束
- 本版已把审计会话从插件自身的 per-session 记账里摘除（不再随压缩次数泄漏插件侧状态），但宿主 store 仍持有它们（用于"运行期间可点开"）。长跑且压缩次数极多时占用内存。
- 为什么没修：宿主没有公开的 dispose 入口，直接 detach 会让报告里的"打开会话"立刻失效；是否限制保留数量属产品取舍。

### 1.9 【P3】其它已知但本版未处理的细节
- 短哈希 `hashText`（DJB2 变体）不是抗碰撞摘要；用于"用户改过就不覆盖"的守卫，实际利用价值低但非密码学保证。
- 设置页保存冲突后不会自动重读基线（只保留草稿），提示文案已改为如实描述。
- `checkBackend` 会在后端选择变化时复查，但宿主补丁状态仍按进程缓存（打补丁必须重启，符合预期）。
- 已安装的旧 message-edit 补丁需要重跑一次 `patch-message-edit.py` 才能获得"清 replay 签名"的修复（安装脚本会自动重跑）。
- 打包版快速安装若定位不到 DSH checkout，仍需用户设置 `DSH_HOST_CHECKOUT`（属真实环境限制，非脚本可猜）。

---

## 2. 0.1.12 已修复（摘要）

- derive 后端不再被误判为不可用（P1，设置页可正常启用）。
- 默认规则 enabled 开关不再静默打开子代理压缩。
- 内置价格逐字段回退 + 设置页物化，稀疏保存不再丢谷时价/不产生 undefined。
- 峰谷来源严格二选一：whale 模式用自己的时段+节假日，用户节假日列表只属于内置来源（选中 whale 时编辑框隐藏）；解析失败回退内置、只读当前 profile、文件变化后失效缓存。
- 失败 compaction 不再关闭 epoch / 重定价存活改写。
- 数值配置 null/负数/越界归一化；面板输入钳制。
- `maxInputChars` 只限制上下文块且覆盖所有块；不再因推理长而静默跳过。
- in-place：flush 失败不谎报；欠账写回校验 originalHash；路由不再信任调用方文本；in-place settle 返回 ok:true；卸载途中停止写回。
- 欠账/账本：per-entry stock 与合计同轮次过滤（**已被 0.1.13 的跨轮次计费取代**）；欠账排除已淘汰条目；子代理会话 stock 走引擎注册表。
- 旧 Session 对象（委托 turn 边界）不再退回原文：同一会话的替代对象继续按账本替换，旧对象 pre-step 预载 sidecar；跨会话复用 id 仍保持原文。
- 审计会话从插件记账中摘除；陌生 id 空白记录不缓存。
- 蒸馏输入的不可信边界加随机 nonce。
- 快速安装：注入当前 profile、杀进程组（含 SIGKILL 兜底）、日志上限、已完成状态不被改成取消。
- 安装脚本：checkout 优先级统一、`--checkout` 空值拒绝、vendor sha256 校验、`install.sh` 读 DSH_PROFILE/优先自带 CLI、打包版提示改推 derive。
- Python 补丁：splice 清 replay 签名、保留权限、不累积备份。
- scan-session-logs：使用宿主已知事件集、扫未压缩日志、失败非零退出；probe 的 zstd 断言改为真实 magic 校验。
- 安装页：in-place 置顶、步骤标签本地化、未知 backend 不再按 message-edit 处理、提示词走脚本流程并引用正确标题。
- 报告/UI：探测失败区分未知与缺失并可重试；`detail:false` 轻量轮询；compression 会话存活性缓存；目录失败提示；冲突文案；截断不劈代理对；legacy oneShot 开关兼容普通布尔值。
- 测试：新增上述行为的回归用例（smoke + render）。

---

## 3. 复核方法与局限

```bash
cd dsh-reasoning-distill
npm run check                 # typecheck + smoke + render
node scripts/dsh-inplace-patch.mjs --check --checkout <DSH 源码目录>
```

- 本清单基于 2026-10-22 的只读复核 + 修复后回归；当时宿主 checkout 为 0.2.1-alpha.1，补丁 `--check` 为 PATCHED。
- 2026-10-24 宿主更新到 `0.2.1-rc.3`，在其上实际使用 in-place 后端完成改写（补丁 `--check` 为 PATCHED）；README 的支持范围已扩到 rc.3。
- 未做真实 provider 的缓存/计费实验；N6 的结论来自宿主上报与代码可达性。
- 0.2.1-alpha.3+ 的补丁变体未在本机实际执行（本地 tag 只到 alpha.1），相关锚点仅按脚本变体逻辑审阅。
- 未验证 DeepSeek 对"旧签名+新文本"的服务端行为（1.2）。

---

## 4. 0.1.14 之后：设计取舍与暂不处理项（问题汇总）

### 4.1 设计如此，不再修改

1. **分支后端（message-edit）+ `includeFinalTurns` 时，收尾答案轮的压缩不会 hand-off。**
   收尾步骤之后没有下一次 pre-step，`pendingBranch` 会留下；下一次用户消息的 pre-step 才触发陈旧 hand-off，结束/转移那一轮。这是“hand-off 必须在 pre-step 发生”的直接结果；该选项与实验后端组合时应视为不推荐用法。

2. **压缩完成后用户手动停止本轮，会留下同类 pending hand-off。**
   与 1 同源：压缩在轮次结束后完成，没有 pre-step 来消费 `pendingBranch`。

3. **Fork/分支副本继承父 ledger 时，报告会带上父会话的历史蒸馏成本与节省。**
   这是修复 #11（副本退回原文）所必需的：模型侧需要父 entry 才能重放压缩版；代价是父子两个会话的报告会出现同一笔历史数字。按会话分别统计的语义下接受此取舍。

### 4.2 已知边界，几乎不会触发，暂不处理

4. **取消只覆盖“采用前”。**
   进入 `writing-back` 后没有取消按钮（服务端 409）；若 flush/in-place 写回卡住，只能等或停止整个回合。压缩尚未 launch（例如卡在 sidecar 读取/pre-step 前的排队）时也没有 active 行可取消。

5. **分支创建本身卡住时没有取消入口。**
   压缩结束后，message-edit 的建分支请求发生在 pre-step；此时报告已没有 active 压缩，只有阻塞横幅，`branchTimeoutMs = 0` 时只能等 adapter/宿主超时。

6. **Fork 发生在压缩 in-flight 时，子会话只继承 fork 当时已写入父 sidecar 的 entry。**
   父会话之后才 adopt 的那一条不会自动补进已存在的副本。

### 4.3 配置变更：删除 `skipWhileBusy`

- 该配置从未有设置页入口，实际只对分支后端有语义；0.1.14 已删除。
- “有后台工作就跳过压缩”现在**只对 message-edit（分支后端）生效**；`derive` / `in-place` 不再读取 job 列表，后台任务运行期间照常压缩。旧文档中残留的 `skipWhileBusy` 配置会被忽略。
