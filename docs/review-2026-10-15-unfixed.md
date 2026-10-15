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
