# 未修复清单（四方审查 + 26 轮修复之后）

配套文件：`docs/review-2026-10-15.md`（完整发现台账 + 26 轮修复记录 + 状态表 §5）。
审阅基线 `47f7523`；本清单对应的 HEAD 是写这份文件时的 `dev` 分支（见 §5 的提交链）。

**一句话**：剩下的都是**需要人（或上游仓库）拍板的产品取舍**，不是"还没轮到"的活儿——每一轮修复者（flash 23 轮 → pro → sol → astra）都独立复核过它们，结论一致：没有"方向唯一 + 行为可证不变"的做法。

---

## 1. C2【P1】sidecar 读不到时的 fail-open（发原文）

- **现状**：`src/engine.ts` 的 `ensureLoaded` 读失败只置 `storageBroken` 并阻止**发起新压缩**；而替换判据读 `store.peek`（`src/engine.ts:802-805` 一带），peek 空 ⇒ 该请求按**原文**出站；每次 pre-step 重试读，文件恢复可读后又变蒸馏版 ⇒ 一次「蒸馏 → 原文 → 蒸馏」的已发前缀变化。
- **为什么没修**：这是**有意的 fail-open**——坏 sidecar 绝不能卡住对话。修它必须在「不卡对话」与「不改已发前缀」之间选一个优先级。
- **两个高档位的推荐**：**维持 fail-open + 每次重试**（pro、sol 一致）。翻转路径已如实写进 `README.md:57` 的 ①。
- **若要改**（三条候选，都要先定语义）：
  1. 会话级**粘性** `storageBroken`：不再逐 pre-step 重试 ⇒ 消除翻转，但坏文件修好后本会话也不恢复；
  2. 保持 fail-open，但把「本次按原文出站」记进账目/报告 ⇒ 语义诚实，前缀仍会变；
  3. 只在「该会话此前已发过蒸馏版」时改为 fail-closed ⇒ 折中，但要把「已发过什么」持久化。

## 2. C4【P1】分支日志的 replay 元数据（要动"已验证产物"）

- **现状**：`message-edit` 的 splice 只改 `content[i].text`、**保留**原文的 `source.replayState`（`scripts/patch-message-edit.py` 的 `splicedAssistantEvent`），因此分支日志里"文本=蒸馏版、replay 载荷=原文"的配对只有**运行中的本插件账本**会清洗；而账本继承 `carryLedgerToBranch` 是 best-effort（吞错后交接照常继续）⇒ 账本丢失/复制失败/插件停用后，旧签名会被继续序列化发送（服务端是否拒绝**未验证**）。
- **为什么没修**：唯一治本修法是改 companion 的 splice（丢弃被替换块的 replay 载荷），但这会改动**已登记 sha256 的已验证产物**：`vendor/dsh-message-edit-0.2.3-patched4.tgz`（哈希登记在 `README.md:389-391`，且 `package.json.files` 已包含它）⇒ 必须重打包（patched5）、重新验证、重登记哈希，并处理已装 profile 里的旧件。
- **两个高档位的推荐**：pro、sol 都推荐**改 companion + 重建并重新登记 tarball**；这属发布流程决策，故留白。
- **替代方案（次优）**：`carryLedgerToBranch` 失败时**不再交接**（记 `failed`）——把静默腐坏换成显式失败，但改变"原回合照常继续"的既有行为。

## 3. C5【P2】共享同一 `DSH_HOME` 的多实例无跨进程串行化

- **现状**：`SidecarStore` 的写队列与缓存都是**进程内**状态（`src/store.ts`），`update` 以本进程视图整文件重写（原子 rename、无进程间锁）⇒ 两个宿主进程共享同一 `$DSH_HOME` 时"最后写者覆盖"，被覆盖的条目会消失（其效果等同于 C2 的翻转）。
- **为什么没修**：跨进程串行化要引入锁协议（O_EXCL 咨询锁 + 陈旧锁回收）或单写者约束，两者都会引入新的失败模式（陈旧锁、持有者崩溃），而收益只覆盖一个**未被支持**的使用形态。
- **两个高档位的推荐**：**文档化为"单写者/单宿主进程"前提**（pro 明确推荐、sol 同意）。这是一行 README 就能落地的方向，但"支持多宿主"本身是产品决策，故未擅自写进文档。

## 4. C6【P2】token-meter 走自由函数（**上游**）

- **现状**：宿主 token-meter 用**模块级自由函数** `deriveEventMessage`（宿主 `packages/llm/token-meter/src/surface-fold.ts`、`surface-projection.ts`），绕开本插件在实例属性上的包装 ⇒ 对"只剩包裹生效"的改写，宿主对上下文的估价按**原文**算（偏高）。方向保守：不会漏压，但可能**多触发一次压缩**（多一次前缀重建）。
- **为什么没修**：缝在宿主侧；插件侧唯一杠杆是替换 `ctx.tokenMeter` 服务（侵入式、且有重复计价风险）。
- **推荐**：上游让 token-meter 走 session 方法，或暴露 `ctx.tokenMeter` 注入点。

## 5. B10 的余下两个子项【P1】路由信任边界

- **现状**：
  1. `POST /api/reasoning-distill/report` 只校验会话存在（`src/route.ts:74-90`）就回传**完整思考原文与工具输出**；
  2. `POST /api/reasoning-distill/install` 同源即可在**宿主进程**里 `spawn` 安装脚本并继承 `process.env`（`src/route.ts:103-134`、`src/install.ts`）。
- **已修的子项**：`/handoff` 现在必须**命名 entryId**才授权结算（`2cd6415`）。
- **为什么没修**：第 10 轮已实证 `/api/*` 先过宿主的 `connection.admit`（Host/Origin 栅栏 + 浏览器凭据），过闸的请求**代表操作员**；插件层拿不到"哪个会话在问"的身份，无法做更细的属主校验。
- **两个高档位的推荐**：**维持"可信操作员"边界**；若要多用户隔离，应由宿主引入 capability（上游）。可选加固：`/install` 的 GET 签发一次性 start token 防盲发 POST。

## 6. O1【P1】dsh-ops 的 FastCtx 私有作业与自动交接（**跨仓**）

- **现状**：dsh-ops 的 FastCtx 后台作业记在它自己的、**按 Session 对象**的 `ownedJobs` 里（`dsh-ops/lib/tools.js:693-717`），**不登记**宿主 jobs 表；而本插件的 `busyWithWork` 只查宿主 jobs（`src/engine.ts:919-935`，已按 `owner === sessionId` 过滤）⇒ 这类作业存活时仍会自动交接，新分叉会话**拿不到它们的 output/kill 控制权**。
- **对照**：PTC 的 `ops_batch` 路径相反（它登记 `owner=session.id`，能被看到并跳过）。
- **为什么没修**：本仓无解——要么 dsh-ops 把作业登记进宿主 jobs（跨仓），要么宿主提供作业可见性/交接抑制接口，要么本插件去读 dsh-ops 私有账目（强耦合）。
- **推荐**：**作业运行期间避免自动交接**（或上游暴露抑制接口）。在修复前，实用约束是：有 FastCtx 作业时先收集/结束它，别依赖 `skipWhileBusy`。
- **已修的另一半**：本条只管"后台作业"；**子代理**那一半已在 `e55d857` 被构造性关闭——选中分支后端（`message-edit`）时，两条子代理开关被强制关闭并置灰，宿主首次 pre-step 自检把同一事实写回设置，引擎的触发门也直接拒绝子代理会话（手改配置同样无效）。

---

## 7. 不在"未修"里的东西（便于对照）

- **已修**：§5 表里状态为「已修」的全部条目，覆盖四方审查的原始发现（B1-B9、B16-B17、C7、O2/O3 等）**以及修复过程中新发现的 20 余条**（B11-B42 里的绝大多数）。几类值得一提：
  - **P0**：C1 提交窗口竞态（pro 落地候选②，sol 修正其两个真缺陷，现为"私有暂存 + 单一同步 rename/cache"）；
  - **数据安全**：`repair-*.mjs` 五个脚本此前会写出"宿主读取路径仍拒绝"的日志（B12/B19/B23/B25/B29/B31/B32/B34/B35），现已全部改为"要么按宿主权威重映射、要么拒绝写入"，并共用 `scripts/repair-header-gate.mjs`；
  - **资源与生命周期**：审计会话 writer 回收（B9）、sidecar 缓存/队列回收 + 驱逐不被排队写撤销（B27/B36）、id 复用时的状态残留（B26/B40）、安装器按作业取消（B28/B41）；
  - **功能/口径**：旧顶层限制值覆盖显式规则（B5/B16）、面板与运行时层序对齐、卸载语义定案为文档化（C3）、客户端与宿主相反的请求契约（B13）。
- **不成立**：B15（"账目用错模型价格"）经 Lead 复核判为误报。
- **其余**：`docs/review-2026-10-15.md` 的 §6 有 26 轮的逐轮记录（模型档位、处理条目、实证要点、存档提交）。

## 8. 怎么复核这份清单

```bash
cd dsh-reasoning-distill
git log --oneline 47f7523..HEAD     # 阶梯的全部改动
npm run check                       # typecheck + smoke(190) + render(108)
grep -n '| 未修 |' docs/review-2026-10-15.md   # 本清单的机器可读来源
grep -n '^## ' docs/review-2026-10-15-unfixed.md
```

每条未修项的完整证据（含 `文件:行`、探针/复现方式、候选方案的取舍）都在 `docs/review-2026-10-15.md` §5 的对应行里。

---

## 9. 2026-10-16 四方独立复核新增项（flash / v4-pro / gpt-6-sol / gpt-6-astra）

四个模型用**完全相同的提示词**、**无任何前置信息**、各自独立复核本插件；下面按「交叉确认程度」排列。标注「Lead 已核对代码」的条目由 Lead 逐行读过实现，其余为复核者的代码级推证。

### 9.1 这次复核新增的**真缺陷**

**N1【P1】写回成功与否被谎报（交叉确认 3 人：sol / astra / flash，Lead 已核对代码）**
- 现状：`applyInPlace` 捕获 `sessions.flush` 失败后**只打日志**，仍然写 `inPlaceApplied` 并返回 `{ok:true}`（`src/engine.ts:1588-1603`）——与它上方「这个屏障让路由能如实回答已写入」的注释相反。
- 叠加：宿主补丁的 rewrite sink 是**发射后不管**（`session.setRewriteSink(event => { this.rewrite([event]).catch(reportFailure) })`，`scripts/dsh-inplace-patch.mjs:197-202`），所以 `flush()` 未必等到这次改写落盘。
- 后果：会话内文本变了、存储里可能没变（重启后回退），而账本已标「已写入」，欠账重试条件随之消失。
- 建议：`flush` 失败即返回失败、不写标记（或写 `failed` 注记）；补丁侧让 sink 的写 promise 可被等待。

**N2【P1】欠账写回绕过 `originalHash` 守卫（astra 首报，Lead 已核对代码）**
- 现状：请求期替换有守卫——原文哈希与记录不符就拒绝（`src/engine.ts:992-1000`）；但**欠账路径**只按 seq/messageId 选条目并直接写 `entry.distilledText`（`settleOwedInPlace` `src/engine.ts:626-651`、`settleInPlaceEntry` `src/engine.ts:571-591`），宿主侧也只校验 seq / message id / 块类型（宿主 `packages/core/session/src/index.ts:721-740`）。
- 触发：写回曾失败或被延后，期间用户把**同一条消息**就地改过 → 下一次 pre-step 用旧摘要覆盖新内容。
- 建议：欠账写回前把该消息当前 reasoning 与 `entry.originalHash` 比对，不符就标 `failed` 而不是覆盖。

### 9.2 信任边界与资源

**N3【P2】`/rewrite` 接受调用方任意文本（sol / flash，Lead 已核对代码）**
- 现状：路由把请求体里的 `text` 原样写进日志（`src/route.ts`、`src/engine.ts:1578-1584`），**不校验**它等于账本记录的 `distilledText`。任何同源调用方（例如另一个已安装插件的客户端代码）可把任意文本写进某会话的思考块 ⇒ 对之后所有请求构成持久化提示注入。可利用性取决于宿主 `/api/*` 的凭据栅栏（未核实）。
- 建议：路由只收 `{sessionId, eventSeq, blockIndex}`，文本由宿主从账本取；或至少要求与账本一致。

**N4【P2】判据器输入无总量上限（sol / flash）**
- 现状：`maxInputChars` 默认 0（`src/config.ts:179-194`），即便设了也只是**逐条**截断工具结果，Join 时没有总量上限（`src/engine.ts:2533-2554`）。一步里几十个大文件/命令输出会被整段发给判据器模型（默认 deepseek-official）⇒ 费用与超时不可控，且这些内容扩散到另一个 provider。
- 建议：给判据器输入加**总量上限**，并在文档里明示「工具输出会发给判据器」。

**N5【P2】报告路由无属主校验 + 空记录被缓存（flash / pro；后半由 `f38613e` 引入）**
- 现状：`POST /report` 对任何非空 id 都 `store.load`（`src/route.ts:84-104`），而 `load` 会把空白记录**缓存**在内存里且永不驱逐（`src/store.ts:189-195`）⇒ 用不同 id 反复 POST 可让内存无界增长；同一入口也会把该会话**完整思考原文与工具输出**回给知道 id 的调用方（既有 B10 已记，此处补「现在陌生 id 也会走到 load」）。
- 建议：不缓存陌生 id 的空白记录（或给该缓存设上限）；要恢复属主语义需宿主提供「请求来自哪个会话」。

### 9.3 缓存口径（四人一致的部分）

**N6【P2】`cacheBreakTokens` / `cacheBreakCost` 恒 0 覆盖不了回退路径（四人；pro 认为正常路径下如实）**
- 现状：两个字段在所有写入点被钉成字面量 0（`src/engine.ts:2353-2354, 2403-2404, 2431-2432`），并被折进 `net`（`src/report.ts:151`）。
- 正常路径：改写发生在该块**首次作为输入被重放之前**（`settle()` 在 pre-step 等它落地），所以「这一块本来就是未命中」成立——**pro 用 809 对真实请求日志交叉验证**（93.7% 的 `cacheRead(next) ≈ input + cacheRead(prev)`）后认为 0 如实。
- 例外（会让**改写点之后的整段后缀**重新按未命中计费）：① sidecar 读失败后恢复（C2）；② 步末写回失败、留给面板/轮询补写；③ 卸载/停用后宿主派生缓存仍持蒸馏版。此时报告**高估净收益**；且 `account()` 只对该条目「首次被计数的请求」收未命中价（`src/engine.ts:2213-2216`），若破坏前缀的请求发生在计数之后，它反而按命中价结账。
- 建议：至少在报告里把这三条例外语义化（「可能未计入的前缀失效」），或恢复后缀归属计价。

**N7【P3】一条不可能失败的自测（flash / sol）**：`test/smoke.ts:1086-1087` 先断言 `cacheBreakTokens === 0` 再断言 `< 1000`，在恒 0 实现下是空断言。

### 9.4 元数据与生命周期

**N8【P2】就地改写留下「旧签名配新文本」（astra / pro，Lead 已核对代码）**
- 现状：补丁只重建 `message.content[i]`，保留 `message.source`（含 `source.replayState`，宿主 `packages/core/session/src/index.ts:738-740`）；DeepSeek 序列化器把**当前文本**与 replay 里的**签名**配对发送（`packages/llm/llm-deepseek/src/serialize.ts:26-33`）。插件运行时会把派生消息的载荷洗掉，但**卸载/停用、或未装插件的重启**之后就没人洗 ⇒ 新文本 + 旧签名。
- 影响：取决于 provider 是否强校验签名（未实证）；轻则 replay 降级，重则被拒。这是 C4（分支路径同型问题）在 `in-place` 上的对应项。

**N9【P3】记账 map 只增不减（flash / pro，Lead 已核对代码）**：`conversationOf`、`disposedAt`、`lastDecision`、`generation` 在 dispose 时都不清理（`src/engine.ts:124-148`、`releaseSession` / `forgetSession`），长跑宿主里按「见过的每个会话 id」无界增长。

**N10【P3】in-place 的 `handoff` 永远回 `ok:false`（flash，Lead 已核对代码）**：in-place 成功时不再设 `pendingBranch`（`src/engine.ts:2499-2503`），而 `handoff` 在无 pending 时取 `ok = (error !== undefined)` ⇒ 成功的写回也被面板当成「被拒绝的结算」。

**N11【P3】常驻芯片的失败没有进账本（flash）**：`ActivityChip.tsx:172-177` 只在 sessionStorage 记失败，不调 `settleHandoff(..., error)`（对比 `View.tsx:346-355`），与 `docs/acceptance.md` 的「失败会记录在条目上」不符。

### 9.5 与 dsh-ops 的兼容性

- **既有 O1 复核成立**（四人一致，Lead 已核对两侧代码）：FastCtx 后台作业按 **Session 对象**记账（`dsh-ops/lib/tools.js:693-719`），不进宿主 jobs 表 ⇒ `busyWithWork`（`src/engine.ts:1176-1189`）看不到它，选 `message-edit` 时可能在作业运行中交接/归档，分支丢掉 `job_output` / `job_kill` 的控制权。`in-place` 保持会话身份，不踩这个坑。
- **新增（sol / pro / flash）**：dsh-ops 的 PTC `ops_batch` 反而登记了宿主 job（`dsh-ops/lib/ptc/index.js:117-141`）⇒ 这类批处理会让 `skipWhileBusy` 暂停压缩（短命，基本无害）。
- **新增（flash / sol）**：dsh-ops 动态增删工具（`dsh-ops/lib/index.js:74-102`）会让宿主补 `request/header` 变化（`core/agent-loop` `agent.ts:626-648`）⇒ **独立于本插件**造成前缀未命中；这不是本插件缺陷，但排查「缓存为什么掉了」时必须先排除它。
- **静态结论（pro / flash / astra）**：无共享服务、无 `/api` 路由冲突、settings 命名空间分别是 `reasoning-distill` 与 `dsh-ops*`、客户端 slot 不冲突、dsh-ops 只打 bundle 补丁不改宿主源码 ⇒ 与 `dsh-inplace-patch.mjs` 不冲突。**未验证**：两者同时写同一个 profile patch 是否可能丢行。

### 9.6 复核自身的方法与局限

- 四人**都没能**做真实 provider 的缓存/计费实验：缓存结论来自宿主上报的 `cacheReadTokens` / `inputTokens`（flash 额外统计了 809 对真实请求）与代码可达性，不是 provider 文档或实测。
- 未验证：这台机器上 `/api/*` 的凭据强度（决定 N3 / N5 的实际可利用性）；DeepSeek 对「旧签名配新文本」的处理（决定 N8）；FastCtx 是否是唯一的私有作业来源；C5（跨进程）真实并发下的表现。
- 明确**撤回**的候选：多 reasoning 块消息的破坏（被 `stageTarget` 的 `reasoningBlocks !== 1` 守卫挡住，有测试）；「后续请求变热就会失效」的过度概括（其余三人纠正为「需上述例外路径」）。
