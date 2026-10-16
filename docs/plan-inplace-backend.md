# 计划：内置的「原位改写历史」后端（补丁 + 插件接线）

> 这份文件是**执行清单**，写给下一个接手的人（或下一轮的自己）。读完它应当能不问任何人就直接把活干完。
> 状态时间点：宿主**未打补丁**；插件 `lib/` 已与 `src` 对齐；`src/inplace.ts`（投影方案）已删除。

---

## 0. 目标与验收标准（用户原话拆解）

1. 实现一个**完全在原位修改历史**的后端，**内置在本插件里**（不是伴随插件）。
2. 通过**修改 dsh 本体（打补丁）**的方式提供它所需的接口。
3. 插件**检测** dsh 本体是否已打上该补丁；**检测到补丁且功能正常**时才允许选择这个内置后端。
4. 这个后端的**快速安装 = 打这个补丁**（不是 `pnpm dsh plugin add` 别的插件）。
5. 要求这个补丁**在插件移除后不影响正常使用**。
6. （本轮追加，用户已确认选 **B**）补丁提供的是**直接修改历史记录内容**的接口，**不是**"追加事件 + 投影"。

**"原位"的含义**：同一个会话、同一条消息、同一个 `seq`，把日志里那条 assistant 消息的 reasoning 文本就地换掉；不分叉会话、不产生新会话、不 reject 当前回合、不需要归档源会话。

---

## 1. 已定稿的接口（方案 B）

宿主 `Session` 上新增（校验全部在宿主，插件不可能改坏别的记录）：

```ts
Session.rewriteReasoningBlock(request: {
  seq: SessionSeq
  messageId: string
  blockIndex: number
  text: string
}): SessionEvent<'assistant/message'>
```

语义与不变量：

- 目标必须是 `assistant/message`，且其 `data.message.id === messageId`（防止 seq 被复用后错改别的消息）；
- `content[blockIndex]` 必须真是 `reasoning` 块；
- `text` 非空；**文本相同则幂等**返回原事件（不产生任何变动）；
- 只替换该块的文本，**消息 id、其它块、`seq`、日志长度、request header、attempt、血缘**一律不变；
- 落地后立刻可见：`eventsSnapshot` 清空 + surface 折叠重建 + 派生消息缓存失效；
- 不改 `requestHeader()` / `requestContext()` 两个 fold（它们只折 `request/header`、`request/context`，与 assistant 消息无关）。

---

## 2. 为什么必须打补丁（不要重走死路）

### 2.1 公开 surface 契约无法替换 assistant 节点

- `SurfaceOp` 的 `{ op: 'replace', startSeq, endSeq }` 要求"替换节点必须通过 `sourceEventSeqs` 引用**每一个**被遮蔽节点"（`packages/core/session/src/surface.ts` 的 `assertSourceEventReferences`）。
- 而 `assistant/message` **禁止**携带 `sourceEventSeqs`（`assertSourceEventReferences` 首行即抛：*"assistant/message embeds its source stream and cannot carry sourceEventSeqs"*；类型上 `SurfaceIntent` 对 assistant 是 `sourceEventSeqs?: never`）。
- ⇒ 任何仓库外的生产者都**无法合法地**把一个 assistant 节点换成改写版。compaction 之所以能改历史，是因为它用 `user/message` checkpoint 替换**一段**。

### 2.2 方案"声明类型 + 消息投影（已废弃，勿重走）"

宿主确实有一条受支持的轨：`SessionMessageProjection`（`surface.ts:35`，"Pure interpretation of one plugin-owned event that changes existing message content"）。但 `planSurfaceEvent`（`surface.ts:510-543`）的判定顺序是：

1. 该类型已注册投影 → 投影生效；
2. `MESSAGE_PROJECTION_EVENT_TYPES.has(type)` 但**没有**定义 → **抛错**："requires a message projection; load its owning plugin or supply its projection definition"；
3. 否则当普通事件忽略（`surfaceOp === undefined → return`）。

把我们的类型用 `@messageProjection` 声明进宿主词表后，**插件被移除**时定义随插件消失、类型却仍"已声明" ⇒ 宿主对含这些事件的会话**拒绝继续派生**，直接违反验收标准 5。此外 live 会话用的是**注册表**（`SessionStore.projections`，由插件 `registerMessageProjection` 填充），目录列表只服务 restore/detached 读取路径。

### 2.3 方案"追加可忽略事件 + 运行时投影（已废弃，用户明确否决）"

曾实现的替代形状：补丁只让插件能追加 `ignorable: true` 的事件，定义由插件运行时注册。技术上可行且对验收标准 5 友好，但**用户明确要求"直接改历史内容，而不是再追加事件"**，故放弃。

历史提交（供追溯，**不要**据此恢复代码）：`c32c608`（投影定义落地）、`6716241`（删除该定义）。相关宿主验证记录：目录式补丁曾 apply→check(PATCHED)→revert→check 走通，宿主 `verify-persistence-catalog` / `verify-session-format-catalog` 均报 "are up to date"，随后全部回退。

---

## 3. 补丁：5 个精确编辑

文件仅两个：`packages/core/session/src/surface.ts`、`packages/core/session/src/index.ts`。锚点原文与行号均已在**真实宿主**上核对（宿主的 `git status` 对这两个文件是干净的，动它们不会碰到用户在建的 `agent-team` / `tool-workflow` 改动）。

### 3.1 `surface.ts`

**编辑 1** — 锚点：

```
  /** Shared transition state; replacement history is not retained. */
  private _state = createFoldState()
```

其后插入：

```ts
  /** Advanced by {@link reset} so a discarded fold never reuses an earlier generation. */
  private _generationBase = 0
```

**编辑 2** — 锚点（构造函数结尾）：

```
    this._lastProcessedSeq = baseSeq === 0 ? -1 : SessionSeq(baseSeq - 1)
  }
```

其后插入（与构造函数完全一致的初始 `_lastProcessedSeq` 表达式，注意 `baseSeq === 0` 的特例）：

```ts
  /**
   * Discard the folded surface and reprocess the log from its first event.
   *
   * Needed after an in-place log edit: the fold is incremental, so a rewritten event at an
   * earlier seq would never be read again. The generation counters advance across a reset, so a
   * cache keyed on them (derived messages) cannot mistake the refolded surface for the one it was
   * built from.
   */
  reset(): void {
    this._generationBase += this._state.contentGeneration + this._state.replaceGeneration + 1
    this._state = createFoldState()
    this._lastProcessedSeq = this.baseSeq === 0 ? -1 : SessionSeq(this.baseSeq - 1)
  }
```

**编辑 3 / 4** — 两个 generation getter 的返回行：

```
    return this._state.replaceGeneration      →  return this._generationBase + this._state.replaceGeneration
    return this._state.contentGeneration      →  return this._generationBase + this._state.contentGeneration
```

> 为什么必须累加：`Session.deriveMessages()` 用 `generation !== this.derivedGeneration` 判定缓存失效（`index.ts` 的 `derived` / `derivedNodes` / `derivedGeneration`，约 830-870 行）。若 reset 后 `contentGeneration` 回到 0，而会话此前恰好也是 0（例如没有任何替换/投影的普通会话），缓存**不会**失效 ⇒ 用户会看到旧历史。累加基准值从根上避免这一点，同时让 `derivedNodes = 0`，节点被重新派生。

### 3.2 `index.ts`

**编辑 5** — 锚点（`append` 的签名首行，唯一）：

```
  append<T extends SessionEventType>(
```

在其**前**插入完整方法（`this.log[seq]` 直接索引即可：`eventAt(seq)` 的实现就是 `return this.log[seq]`，绝对 seq 无偏移换算）：

```ts
  /**
   * Replace one reasoning block of an earlier assistant message in place.
   *
   * The log keeps its length and the message keeps its identity: only the block's text changes, so
   * derived history, the transcript and every later request see the replacement while tool calls,
   * request headers, attempts and the session's lineage stay exactly as they were. The surface is
   * refolded and the derived-message cache invalidated, so the change is visible immediately and
   * the same edit is idempotent.
   * @param request - target seq, the message id it must still carry, the block index and new text.
   * @returns the replaced event, or the current one when the text already matches.
   * @throws when the seq holds no assistant message, the id differs, the block is not reasoning,
   *   or the text is empty.
   */
  rewriteReasoningBlock(request: {
    seq: SessionSeq
    messageId: string
    blockIndex: number
    text: string
  }): SessionEvent<'assistant/message'> {
    const current = this.log[request.seq]
    if (current === undefined) throw new Error(`rewriteReasoningBlock: seq ${request.seq} is not in the log`)
    if (current.type !== 'assistant/message') {
      throw new Error(`rewriteReasoningBlock: seq ${request.seq} is a ${current.type}, not an assistant message`)
    }
    const message = current.data.message
    if (message.id !== request.messageId) {
      throw new Error(`rewriteReasoningBlock: seq ${request.seq} carries message "${message.id}", not "${request.messageId}"`)
    }
    const block = message.content[request.blockIndex]
    if (block?.type !== 'reasoning') {
      throw new Error(`rewriteReasoningBlock: block ${request.blockIndex} of "${message.id}" is not a reasoning block`)
    }
    if (request.text === '') throw new Error('rewriteReasoningBlock: text must be a non-empty string')
    if (request.text === block.text) return current
    const content = message.content.map((item, index) =>
      index === request.blockIndex ? { type: 'reasoning' as const, text: request.text } : item)
    const data = snapshotJsonValue({ ...current.data, message: { ...message, content } })
    const next = deepFreeze({ ...current, data }) as SessionEvent<'assistant/message'>
    validateSessionEventData(next, `rewritten assistant/message at seq ${next.seq}`)
    this.log[request.seq] = next as SessionEvent
    this.eventsSnapshot = undefined
    this.surfaceManager.reset()
    return next
  }
```

依赖（该文件里都已 import，无需新增）：`snapshotJsonValue`、`deepFreeze`、`validateSessionEventData`。

### 3.3 补丁脚本

`dsh-reasoning-distill/scripts/dsh-inplace-patch.mjs`，接口 `--check / --apply / --revert`：

- `--checkout <dir>`（默认 `$DSH_HOST_CHECKOUT` 或 `~/otherProject/deepseek-harness`）；
- `--check`：逐条报告 5 个编辑 present/absent/anchor missing；未打全则 `NOT PATCHED` 且 exit 1；
- **脏文件守卫**：`git status --porcelain -- <file>` 非空即拒绝（`--force` 可越过）——保护宿主的在建工作；
- 锚点找不到就整体拒绝，**不做部分写入**；写入失败回滚；
- `--revert`：按同一组 (before, after) 反向替换，回到逐字节相同；
- `--apply --build`：顺带 `pnpm --filter @deepseek-ai/dsh-session run build`。

> ⚠️ 上一轮该文件的落盘被 FS 的过期观测拦下（同一路径刚被删除），所以**磁盘上目前没有这个脚本**。第一个动作就是把它按本节与 §3.1/3.2 的编辑表写出来，先跑 `--check`（应报 NOT PATCHED），再 `--apply`。

---

## 4. 唯一未决问题：落盘（必须先做实验再决定动多少代码）

事实：

- 存储是**整体物化**式的：`packages/session/session-persistence-jsonl` 里 `handle.writeFile(content)`；另有 `truncateTornTail` / `repair` 的"截断并重写"路径可用作参考。
- `SessionPersistence` 是抽象服务，公开面为 `create/open/flush/stat/list`（`packages/session/session-persistence/src/index.ts:135-178`），写所有权在 `SessionHandle` 上；文档措辞是"each handle's **routed live events** drain durably and its session materializes"。
- `Session` 的日志是**同一个数组按引用**交出去的（`index.ts:554` `new SurfaceManager(this.log, ...)`），`eventAt` 即 `this.log[seq]`。

两种可能，代价差很多：

- **(甲) 句柄直接引用 `Session.log` 这个数组** ⇒ 就地替换 `this.log[seq]` 后，下一次 flush 物化的就是改过的内容 ⇒ **落盘免费**，补丁就是 §3 那 5 个编辑，到此为止。
- **(乙) 句柄自己存了一份事件副本** ⇒ 必须在持久化层加一条"重写某条记录"的意图（涉及 `session-persistence` 抽象 + `session-persistence-jsonl` 实现，可能还有 `session-log-deepseek` 的 wire 编码），补丁变重。

**判定实验（唯一能证明"完全在原位修改历史"成立的证据，必须先做）**：

1. 打补丁并构建 `@deepseek-ai/dsh-session`（若要覆盖到真实运行路径，还应构建持久化相关包）；
2. 用宿主 API 建一个临时会话（或复用测试装置的 detached/live 会话），写入一条带 reasoning 块的 `assistant/message`；
3. 调 `session.rewriteReasoningBlock({...})`；
4. `await ctx.sessions.flush()`（或句柄 flush）；
5. **从磁盘重新读回**该会话，断言读回的是**改写后**的文本；
6. 同时断言：`deriveMessages()` 立刻反映改写、`seq` 与日志长度不变、`message.id` 不变、文本相同再调一次是幂等、以及四种拒绝路径（非 assistant / id 不符 / 非 reasoning 块 / 空文本）。
7. 结论落到 (甲) 或 (乙)，再决定 §4 的工作量。

---

## 5. 插件侧接线清单（补丁与实验之后）

1. **后端登记**（`src/backends.ts`）：把 `placeholder` 换成真后端
   ```ts
   { id: 'in-place', kind: 'in-place', hostPatch: true,
     probe: { method: 'POST', path: REWRITE_ROUTE, body: { probe: true } } }
   ```
   并给 `RewriteBackend` 加 `hostPatch?: true` 标记（"由本插件自己服务、前置条件是宿主补丁"）。
   注意：`src/client/ops.ts` 与 locales 里有针对 `placeholder` 的文案/可见性逻辑，渲染套件也钉着占位槽形状，**三处要一起改**。
2. **前置条件判定**（`backendUnusable(backend, activePlugins, hostPatch?)`）：`hostPatch` 后端在 `hostPatch !== true` 时不可用；`checkBackend` 里走既有的"清选择 + 关总开关"fixup 路径。
3. **检测 + 功能自检**（宿主半）：
   - 静态：`typeof session.rewriteReasoningBlock === 'function'`（拿一个已附加的会话即可；引擎第一次 attach 时缓存结论）；
   - 功能：按 §4 实验里 6 的**只读子集**做一次真实自检（幂等调用不改变任何东西，或用一个临时/审计会话）；
   - 两者都过才允许选择；面板侧通过**我们自己的**路由拿这个结论。
4. **应用路径**：`rewriteRequest('in-place', sessionId, entry, text)` → `{ path: REWRITE_ROUTE, body: { sessionId, eventSeq, blockIndex, text } }`；`src/shared.ts` 加 `REWRITE_ROUTE = '/api/reasoning-distill/rewrite'`。
5. **路由**（`src/route.ts`）：`POST /api/reasoning-distill/rewrite` 执行 `engine.applyInPlace(...)`（校验会话身份/代数 → `session.rewriteReasoningBlock` → 返回新 seq），`GET` 返回 `{ patched, functional }` 供面板探测。沿用既有连接的同源/凭据门（`connection.admit`）。
6. **引擎**：`applyInPlace` 除调用宿主接口外，还要在**应用时**再确认补丁存在（否则会写出宿主不认识的东西）；失败要把它标成不可用并清掉选择。
7. **快速安装 = 打补丁**：`scripts/install-backend.sh` 按后端 id 分流（`in-place` → `node scripts/dsh-inplace-patch.mjs --apply --build`）；`src/install.ts` 的 `installPromptFor`、`src/client/ops.ts` 的 `INSTALLABLE_BACKENDS` 同步。
8. **文档**：README 的后端表 / 支持状态 / "本仓库没有可用的原位后端（`placeholder` 只是槽位）"这类句子必须改；`docs/acceptance.md` 的开关表与后端段落同步；这本仓的 `docs/review-2026-10-15*.md` 不必动（那是审查台账）。
9. **测试**：render 纯判定（登记表形状、`backendUnusable` 的 hostPatch 分支、`rewriteRequest` 的 in-place 形状、补丁探测三态）；smoke 用假会话跑 `applyInPlace` 的成功与拒绝路径。遵守仓库铁律：**生产代码里不许有只服务测试的分支**；每个行为变化要有先失败的测试或变异证据。
10. **构建**：插件 `npm run build`；宿主 `node scripts/dsh-inplace-patch.mjs --apply --build`；然后重启 `dsh web` 才生效（运行中的宿主读 `lib/`，补丁改的是 `src/`）。

---

## 6. 验收清单（做完逐条打勾）

- [ ] 宿主补丁 `--check` = PATCHED，`--revert` 后目标文件与 HEAD 逐字节相同；
- [ ] 宿主自身的类型检查/构建通过（`pnpm --filter @deepseek-ai/dsh-session run build`）；
- [ ] §4 的"改 → flush → 从磁盘读回"实验证明改动**扛过重启**；
- [ ] 插件闸门全绿：`npm run check`（当前基线：smoke 198 / render 117 / typecheck 0，接线后会增长）；
- [ ] 未打补丁时：面板**不能**选择 `in-place`，且给出可执行的修复指引（一键打补丁）；
- [ ] 打上补丁后：面板可选，应用一条改写后 `deriveMessages()` 与磁盘日志都反映改写，`seq`/`id` 不变；
- [ ] 移除插件（或插件加载失败）后，宿主行为与未装插件时一致；补丁本身不改变任何既有路径的行为；
- [ ] README/acceptance 与实现一致（含"原始思考不再留在日志里，审计依赖插件 sidecar 的 `distill.requestText`"这一语义变化）。

---

## 7. 相关事实速查（省掉重新侦察）

| 事实 | 位置 / 证据 |
|---|---|
| 日志按绝对 seq 直接索引 | `index.ts` 的 `eventAt(seq) { return this.log[seq] }`；`private log: SessionEvent[] = []`（索引赋值合法） |
| 日志数组按引用交给折叠 | `index.ts:554` `new SurfaceManager(this.log, SessionLogOffset(0), projections)` |
| 事件被深冻结 | `append` 内 `deepFreeze({...})`；`snapshotJsonValue` 做 JSON 快照 |
| 快照缓存要清 | `private eventsSnapshot`；`snapshotEvents` 里 `eventsSnapshot ??= Object.freeze([...this.log])` |
| 派生缓存判定 | `derived` / `derivedNodes` / `derivedGeneration`，比较 `surface.contentGeneration` |
| 折叠是增量的 | `surface.ts`：`_state`、`_lastProcessedSeq`、`_processDelta()` |
| 两个与本次无关的 fold | `headerFold(Seq)` / `contextFold(Seq)`：只折 `request/header`、`request/context` |
| assistant 不能带 `sourceEventSeqs` | `surface.ts` `assertSourceEventReferences` 首行抛错；`SurfaceIntent` 类型为 `never` |
| 未知事件类型的读规则 | `validateStoredEvents`：未知且非 `ignorable: true` 直接拒绝加载日志 |
| `append` 无 `ignorable` 入口 | `append` 的信封只含 `type/seq/time/data` + surface 元数据 |
| 宿主用构建产物运行 | `packages/*/*/lib/index.js` 存在；`src` 改了必须重新构建 |
| 宿主工作区有用户在建设动 | `packages/experimental/agent-team/*`、`packages/workflow/tool-workflow/*` 等。补丁脚本有脏文件守卫，勿用 `--force` |
| 遗留可清理 | 宿主 `packages/core/session/src/index.ts.bak-msg-edit`、`surface.ts.bak-msg-edit`（未跟踪，与当前文件逐字节相同，是更早一次尝试的残留）；profile 里 `rewriteBackend: 'msg-edit'` 是旧 id |

---

## 8. 一次性做完时的建议顺序

1. 写回补丁脚本 → `--check`（应 NOT PATCHED）→ `--apply`；
2. `pnpm --filter @deepseek-ai/dsh-session run build`；
3. 做 §4 实验，定论 (甲)/(乙)；
4. 若 (乙)：按结论补持久化层，回到 1 重跑；
5. 插件接线 §5.1–5.7；
6. 测试 §5.9 + 文档 §5.8；
7. 插件 `npm run build` + 宿主 `--apply --build` + 重启 `dsh web`；
8. 逐条过 §6，然后向用户汇报（含语义变化与回退方法：`--revert` + 重新构建）。
