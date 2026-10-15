# dsh-reasoning-distill

把过长的模型思维链蒸馏成它的有效内核，并让**之后的每一次请求**都只回传蒸馏版——代价是被改写的那一步**首次回放按缓存未命中计费**，换取此后每一轮都更短的上下文。

- **设置页**（Settings → 推理蒸馏）：总开关、默认规则（未单独配置的模型走这里）、逐模型规则、价格表、蒸馏提示词（可改、可恢复默认）。
- **会话页**（对话 / 轨迹 / **推理蒸馏** / 上下文 / 画廊）：成功/尝试次数、每次的压缩原文与压缩结果、压缩会话内容与开销，以及金额核算。口径：
  - **成功 / 尝试**：尝试 = 记过的条目数（含蒸馏失败、节省不足未采用）；成功 = 真正采用了改写的条目。
  - **蒸馏开销**：每次蒸馏**实际花掉**的钱（失败、超时、未采用也计，因为钱真花了）。
  - **当前单次请求减量**（存量）：**这一次请求**因为仍然生效的改写而少带的估算 token，以及按命中价估算的金额。每成功采用一条改写加一次它的单次减量；被整段压缩淘汰的条目相应减掉，全部淘汰则归零。它是"只加一次"的存量，**不随请求次数增长**。
  - **历史累计节省**（流量）：每发生一次确实带着这些改写发出的请求，就按**那一次请求实际适用的价格**结算一笔，累加进总账，**永不重置**——即使改写后来失效、或上下文被压缩，过去已贡献的历史都保留。
  - **净收益** = 历史累计节省 − 蒸馏开销。
  - **不显示"缓存失效增量"**：本插件只压缩**刚结束那一步**的新消息，**从不追溯改写已经发过**的内容——不存在"原来 a+b+c 已缓存、改成 a+b′+c 导致 b′+c 变未命中"的情形。但**这不等于断裂恒为零**：有三条回退路径会让已经发出去的蒸馏版与后续请求不一致（首次重放发原文、之后才发蒸馏版，或反之），那几条路径下被缓存的前缀确实会失效——见下文「关于"缓存断裂"这一项」。

---

## 它做什么

1. 监听每一步的 assistant 消息。当某条 reasoning 的**估算 token 数**超过该模型配置的阈值时，把这一步标记为待压缩；`step/end`（此时工具结果已经落盘）后立刻发起一次蒸馏。
2. 蒸馏是**一次独立的 LLM 调用**，同时写入一个**一次性压缩会话**（真实 DSH 会话，模型无法主动访问，你可以在会话页里点开查看）。
3. 蒸馏结果作为该条 assistant 消息的 reasoning **替换版**，从下一次请求开始生效；原始 reasoning 永远保留在会话日志里。
4. 每一步结束时结算：这次替换让**之后每一次请求**少掉的输入 token，按当时的缓存命中价累加。

## 为什么用"派生历史"这条缝，而不是投影事件

仓库外的插件**无法**写自己的会话事件类型：`Session.append` 永远不写事件信封里的 `ignorable` 标记，而持久化读路径会拒绝一个未知且不可忽略的事件类型。所以本插件：

- **不写入会话日志**（日志保持可被任何 build 读取、原始 reasoning 可审计）；
- **包装两个访问器**：`Session.deriveMessages()`（请求构建与不变量比对都用它）**以及** `Session.deriveEventMessage()`——后者是宿主的 compaction（`compaction-basic` / `tool-result-pruner` / `image-offload`）逐节点重建"要压缩的对话"时走的那条缝。两个访问器由**同一套判据**回答，所以「请求带什么」与「压缩读什么」逐字节相同（见「压缩与派生的关系」）；
- 自己的持久状态放在 `$DSH_HOME/reasoning-distill/<会话 id 净化>-<原始 id 的 sha256 前 16 位>.json` 的 sidecar 里（净化不是单射，`team/a` 与 `team?a` 都塌成 `team_a`，摘要后缀保证两者不撞同一个文件）。

> 这条缝的代价：只有**发给模型的请求**和**宿主的压缩输入**变了；GUI 转录、轨迹页与上下文页仍显示原始思维链（`surface.ts` 规定人类转录只读 durable 原文）。这是有意的——审计与展示走日志，省钱走派生历史。

## 压缩与派生的关系（两个访问器、三种情形）

宿主的 token 计量与压缩走**不同**的读缝，这件事决定了本插件能保证什么：

| 读缝 | 谁在用 | 本插件能否影响 |
|---|---|---|
| `Session.deriveEventMessage(event)`（**方法**，带投影表） | compaction 的输入、`deriveMessages()` 内部、tool-result-pruner、image-offload | ✅ **已包装**（与 `deriveMessages` 同一套判据） |
| 自由函数 `deriveEventMessage(event)`（`token-meter/src/surface-fold.ts`、`surface-projection.ts`） | **token 计量**：压缩阈值、保留预算、"摘要必须更小"的判据 | ❌ 碰不到（插件的边界） |

因此：

- **压缩的输入**：与路由请求逐字节一致（同一判据 ⇒ 同样的文本、同样的 replay 载荷）。历史里已被 splice 接管的块，其事件仍带着**原文的 replay 载荷**（`message-edit` 只改 `content[i].text`），两条访问器都会把它洗成裸 `{type:'reasoning'}`，而 durable 日志一个字都不动。
- **"该不该压缩"的估价**：按**日志**算。已成功交接的块，日志里就是蒸馏文本 ⇒ 估价正确；只有包裹生效（交接失败/跳过）或交接前的窗口里，日志还是原文 ⇒ 压力被**高估**（保守：不会漏压，但可能过早压一次）。
- **摘要承接的是蒸馏后的内容**：`compaction-basic` 的 `buildSummarizationInput` 逐个事件调的是 **session 方法**（`region.ts:552,557`，已被包装），所以 summarizer 读到的就是上表的派生文本 ⇒ 生成的摘要也按蒸馏后的内容写。这是**改进**（压缩输入与请求内容一致），但它有一个**不可逆**的后果：摘要不是临时视图，它以 `compaction/summary` 与 checkpoint 的 `user/message` **追加进会话日志**（`region.ts:491,506`）⇒ 那段历史此后永久带着按蒸馏内容写成的摘要。本插件之后被卸载（`deactivate()` 把 `active` 置 false，`src/engine.ts:479-481`）或原块经交接离开本会话，都不会把它改回去——卸载只是**停止继续改写提示词**，没有任何"把已经汇总进去的蒸馏文本还原成原文"的机制。
- **三种情形**（`rewriteKind`）：① 该会话仍承载这条改写 ⇒ 替换并**计费**；② 日志里已经是这条蒸馏文本（更早的分支 splice 进来的）⇒ 只**洗 replay 载荷**，不计费（那份节省属于接管的那个分支）；③ 都不是（失败、已交接给分支、或用户改过原文）⇒ **把日志自己的消息放回派生的那一格**，这样"某个派生在交接之前缓存过的替换"不会活过交接。

## 计费口径

每个模型有**两栏价格**，单位**元 / 百万 token**，每栏三个数：缓存命中、缓存未命中、输出。

**出厂状态**：内置的 DeepSeek 模型（`deepseek-flash`、`deepseek-v4-pro`）**默认就是启用的**，两栏价按官方价目预填好、分栏开关也是开的（谷时=峰时的一半）。**其余模型默认不启用**——没有价格条目就按 0 计，它们在会话页的节省会显示为 0，需要用「+ 添加模型价格」显式加入并填价。

**第一栏就是常规价**：`peakPricing` 关闭时（默认）只用第一栏，第二栏被禁用且不参与任何计算。打开峰谷计价后，第一栏=峰时价、第二栏=谷时价（未填则默认取峰时价的一半），按下面的时段规则自动切换。峰谷时段见上文。

**关于"缓存断裂"这一项**：压缩在 `step/end` 触发，而 `agent/pre-step` 会等它落地，所以被改写的那条消息**在下一次请求里本来就是全新输入**——有没有本插件都按未命中计费；改写点**之前**的前缀两次完全相同、始终命中。因此本插件不追溯改写已发内容，也**不再按旧模型收取"断裂"费用**（曾经的模型既漏算了后续段，又虚构了这项惩罚）：代码里的 `cacheBreakTokens`/`cacheBreakCost` 字段因此恒为 0。但**不能据此断言断裂恒为零**——有三条回退路径会让已经发出去的字节变化：① **提交窗口竞态**（有限 `timeoutMs` 的等待上限恰好落在账本落盘窗口内时，本次按旧账本派生＝发原文，落盘完成后才发蒸馏版）；② **sidecar 读失败/超时**（`peek` 读不到 ⇒ 发原文，文件恢复可读后改发蒸馏版，每次 pre-step 都重试读取）；③ **卸载/停用**（宿主的增量派生缓存里可能短期仍是蒸馏版，缓存重建后才回退原文）。这三条目前都不额外计价。真正变化的是**第一次重放按未命中价计、之后按命中价计**，这一条已体现在记账里。

**分支交接后的统计归属（重要）**：压缩成功后若交接成了新分支，这次改写**只在新分支里生效**——

- **新分支**：面板记为**成功**，并计入它的存量与流量（分支继承分叉那一刻的台账，所以能看到「触发它的那次压缩」）；
- **原会话**：模型可见历史仍是**压缩前原文**，所以该条目在它那里显示为**「已转分支（本会话未生效）」**，**不计成功、不计存量/节省**，只计这次尝试与蒸馏开销。
- **连续分支**：新分支继承的是**带压缩后历史**的副本，所以"某次压缩把会话交接到它"这件事在新分支里依然算**本会话生效**——引擎在拷贝台账时会把这类条目的交接目标改指到新分支，面板不会把仍然生效的压缩误标成「已转分支」（历史数据用 `scripts/repair-branch-ledgers.mjs` 修正）。

因此同一条压缩在两个面板里会以不同状态出现：成功属于真正带着压缩内容往下走的那个会话。

会话页给出的五项：

| 指标 | 含义 |
|---|---|
| `distillCost` | 所有压缩尝试的开销（用压缩调用返回的 usage × 蒸馏模型价格），**包括超时/被放弃的那些** |
| `cacheBreakCost` | **恒为 0**，见下 |
| `savedLive` | **当前生效期**的累计节省；检测到 `compaction/end`（上下文满触发的自动前文压缩）后**重新开始计算** |
| `savedTotal` | **历史累计**节省，**永不重置**（跨压缩事件累加） |
| `net` | `savedTotal − distillCost − cacheBreakCost` |

### 两个容易混淆的配置项

- **`thresholdTokens`（触发阈值）**：单步 reasoning 的**估算长度**超过它就发起蒸馏。估算口径是 `字符数 / 4`，与会话统计里的"tokens（估算）"一致。
- **`minSavedTokens`（最低节省）**：蒸馏**已经跑完**之后的第二道闸门——如果 `原 reasoning 估算 token − 蒸馏结果估算 token < 这个值`，就判定这次压缩不划算，**不替换**，原始 reasoning 保持原样（压缩会话仍会留下供你查看）。它防的是"蒸馏出来跟原文差不多长"这种白花钱的情况；阈值决定"要不要试"，它决定"试完值不值得用"。
- **`includeToolResults`（附带工具调用结果）**：**这一步的工具调用恒定附带**——只要该步有工具调用，输入里就会有 `## Tool calls from this step`（名称 + 原始参数），因为那正是这段推理"决定了什么"的落点，蒸馏器必须看到它才能保住真正走向了某处的决策。这个开关**只负责是否再附上调用结果**（`## Tool results`）：打开时蒸馏器可以**用结果来判真伪**——被工具输出推翻的猜测放心删掉、被结果证实的结论才保留；关掉时它只能凭 reasoning 自己判断，容易留下已经被结果否掉的推理方向。代价是输入变长（工具结果往往比思考本身还大，比如一次大文件读取），所以结果块会单独按 `maxInputChars` 截断。没有工具调用的那一轮（最终回答）没有调用也没有结果，此选项自然无效果。
- **超时/被放弃的压缩也计入开销**：一次被中断的调用同样花了钱，所以它会被记成一条 `failed` 条目——**计入 `distillCost`，节省为 0，且不做任何替换**（原始 reasoning 原样保留）。被中断的调用通常拿不到 provider 的 usage，这时按"已发送的提示词 + 已收到的输出"**估算**成本并在界面标注「估算」；真实账单可能略有偏差（服务端可能在你断开前又多生成了一点）。
- **`timeoutMs`（逐模型，设置页里的"超时"）**：只有这一个值，它同时管住两头——
  - **上界**：蒸馏必须在这个时间内完成，到点就 abort 并**放弃这一次压缩**——原始 reasoning 保持不动、不做任何替换；这次尝试仍会作为一条 `failed` 记录留在报告里（计入开销、节省为 0），压缩会话本身也保留，`turn/end` 标为 error 供你排查。另外，只有**干净收尾（finish = stop）**的返回才会被当成蒸馏结果；被中断的半截输出绝不会被替换进历史。
  - **等待**：下一步会等到它出结果或超时为止，也就是"压缩完才进行下一步"，不会出现"替换晚到一跳"的中间态。
  - `0` = 不设超时：没有上界，因此下一步会一直等到蒸馏器给出结果。

每次替换的"每步省多少" = `(原 reasoning 估算 token − 蒸馏后估算 token) × 该模型当时的缓存命中价`。

## 蒸馏提示词

默认提示词要求：保留仍然正确且承重的部分（事实、常量、路径、约束、真正执行的计划与选择理由）；删除口头禅与重复、死路探索、被后续推翻或自我否定的推理；修正过的路径只保留修正后的结论与支撑证据；**不得**添加原文没有的事实、工具输出或计划，不做自己的分析、不回答用户；保持原语言与标识符原样；只输出重写后的思考正文。

在设置页可编辑；把输入框清空即恢复内置默认（界面会提示"空 = 使用内置提示词"）。

## 配置字段

设置页写入的 namespace 是 Loader 行的 id `reasoning-distill`（见 `cordis.patch.yml`），落盘在 profile patch 的 `config:` 块。

**逐模型规则与价格都按需添加**，不枚举整个模型目录：未列出的模型一律走"默认规则"（价格走内置价目）。点「+ 添加模型」/「+ 添加模型价格」展开一个可搜索的候选列表（按服务商/模型名过滤），选中即加入；每个已加入条目都有自己的「移除」。设置页的长度只取决于你真正配置了几个模型，与 provider 目录大小无关；已配置但目录里已不存在的模型仍会列出，便于修改或移除。

```yaml
- id: reasoning-distill
  name: dsh-reasoning-distill
  config:
    enabled: false                  # 总开关，默认关：打开后才会有任何蒸馏调用
    defaultRule:
      enabled: true                # 对【主对话】启用（三种会话各有独立开关，见下文）
      thresholdTokens: 4000        # 超过这个估算 token 数才压缩
      minSavedTokens: 600          # 蒸馏后至少省这么多才值得替换
      includeToolResults: true     # 是否在工具调用之外再附上其结果（调用恒定附带）
      includeFinalTurns: true      # 最终回答那一轮也压缩
      timeoutMs: 0                 # 该模型单次蒸馏的超时；0 = 不设置超时（默认不设）
      continuableSubagents: true   # 对【可续接子代理】（如队友）启用
      continuableMaxDepth: 0       # 可续接子代理的最大生效深度（0 = 不限制）
      oneShotSubagents: false      # 对【一次性子代理】启用
      oneShotMaxDepth: 0           # 一次性子代理的最大生效深度（0 = 不限制）
      distiller: { provider: deepseek-official, model: deepseek-flash, effort: off }
    models: {}                     # 逐模型覆盖，字段同上
    peakSource: builtin            # builtin | whale
    holidays: ['2026-01-01', ...]  # 全天谷价的法定节假日（北京时间日期）
    prices: {}                     # 逐模型价格条目：peak/off 两栏 + peakPricing 是否分栏
    prompt: ''                     # 空 = 内置提示词
    maxInputChars: 0               # 背景块（工具结果）长度上限；0 = 不截断（默认不截断）
    maxOutputChars: 0              # 0 = 不限制蒸馏结果长度
    rewriteBackend: message-edit    # 助手消息改写后端；空 = 未选（见「助手消息改写后端」）
    branchTimeoutMs: 0              # 分支型后端专用：宿主等待建分支的时限，0 = 永不超时
    archiveSuperseded: true         # 分支型后端专用：建分支后自动归档被它替换的原会话（默认开启）
```

后三项是**后端相关配置**：设置页只在选中了**分支型后端**（当前即 `message-edit`）时才展开「分支后端专用选项」这一块，把这两个开关显示出来；未选后端或选了就地型后端时，它们不显示、也不参与保存。

**是否压缩由该模型的三条开关决定**（默认规则给未单独配置的模型，逐模型条目覆盖它）：`enabled` 管主对话，`continuableSubagents` / `oneShotSubagents` 分别管子代理，两条子代理开关各自还带一个最大生效深度——详见下一节。故意不再提供"思考加密"开关：插件只在拿到**非空 reasoning 明文**时才会触发，模型不返回明文就自动跳过。

## 压缩哪些会话（逐模型三条开关）

**每一种模型都有三条独立开关**，和 `enabled` 同级，都在该模型的规则里；规则里其余字段（阈值、最低节省、超时、蒸馏路由、是否带工具结果/最终轮）在该模型三条全关时**变灰锁定**——因为此时它们不可能生效。

| 规则字段 | 默认 | 管哪种会话 |
|---|---|---|
| `enabled` | **开** | **主对话**：普通会话 |
| `continuableSubagents` | **开** | **可续接子代理**：会持续重发思考的会话（队友就是这一类） |
| `oneShotSubagents` | **关** | **一次性子代理**：终端型委派，跑完即返回、之后不再续接 |
| `continuableMaxDepth` / `oneShotMaxDepth` | **0（不限制）** | 各自子代理模式的**最大生效深度**：超过该深度的子孙代理不再压缩；两条上限互不干扰；主对话不受影响。界面上**每个深度输入只跟随自己那个开关**——对应模式没启用就置灰，不等"三档全关" |

判定依据全部来自宿主，不猜：

| 信号 | 来源 | 用途 |
|---|---|---|
| `header.origin === 'subagent'` / `header.delegationDepth > 0` | `core/session/src/types.ts:117,123` | 是否子代理子会话（深度**必须为正**：宿主保留显式的 `0`，且其文档定义 `0` 为顶层；`delegationDepth` 会持久化，所以重启后续接仍认得出） |
| `subagent/descriptor` 的 `mode: 'one-shot' \| 'continuable'` | 子代理描述符（建立方在子会话首个回合写入） | 终端型一次性 vs 可续接会话 |

- 读不到描述符的子会话按**一次性**处理（更便宜的错法是别去压它）。
- 会话种类按会话**记忆一次**（描述符写完不再变），会话销毁时一并清掉。
- 三条开关**互相独立**：只开 `oneShotSubagents` 不会影响主对话；关掉 `enabled` 也不会静默关掉可续接子代理。

**界面与运行时不会各说各话**：规则的合并（内置默认 → 默认规则 → 该模型覆盖）由 `src/rule.ts` 的同一个 `mergeRule` 承担，宿主 `resolveRule` 与设置页显示共用它；逐模型写入用 `sparseOverride` 只落**真正被改过的字段**，未改的继续跟随默认规则（不会把当天的继承值冻进配置）。三条全关时该规则其余项变灰，因为此时它们不可能生效。

**记账与"是否生效"使用同一个判据**：一条改写此刻是否会被重放（目标仍在 surface 上）决定它是否计费。因此**失败的压缩**（宿主照发带 `error` 的 `compaction/end`）与**只压掉较早区间**的成功压缩都不会再冻结仍在生效的节省；只有目标真被移除的条目才结转 `frozenSaved` 并标记失效。

**压缩会重新按未命中计价**：压缩改变了目标之前的前缀，所以紧随其后的那次请求要重新发送那一区域——该请求的节省按**未命中**价计，之后恢复命中价。否则刚压缩完的那次请求会被低估。

**记账用的是"请求发出时"的上下文视图**：一条请求的节省金额在**事件发生的时刻**判定（当时的目标是否仍在 surface 上），而不是在异步读取记录之后现算——否则期间发生的压缩会把这次请求本已省下的钱算掉。

**损坏的旧命名记录按"不可读"处理**（失败关闭）：旧的文件名不单射，无法自证归属，所以宁可让该会话暂停压缩、也**绝不**写入新文件去遮蔽它可能仍可恢复的历史；文件移除或修复后自动恢复。能自证属于**别的**会话的旧记录仍按"无关"忽略。

**读不到记录就不花钱**：会话记录不可读（损坏/无权限）时，插件在**发起付费蒸馏之前**先尝试读取；读不到就跳过该步，不再出现"花了钱、没有结果、也没有持久记录"。每个 pre-step 都会重试，记录恢复后自动继续压缩。

**慢响应不会被永久丢弃**：面板与指示器按"已应用的最新响应"判断新旧，而不是"最新发出的请求"——否则一次比轮询间隔更慢的响应会让状态永久停在旧值。

**旧配置会被精确迁移**：三开关出现之前的配置只有 `enabled`，而那时的 `enabled` 同时管主对话与可续接子代理（一次性子代理由已删除的全局开关管）。插件在解析时会为**缺少新字段的层**按当时语义补齐：`continuableSubagents ← enabled`、`oneShotSubagents ← 旧的全局开关 ?? false`。保存一次设置后字段被显式写入，推导即停止——所以升级不会静默改变你的付费行为。

> 这是**会话种类**的门槛；模型门槛（哪些模型参与）仍由同一套规则决定——规则本身就是逐模型的，所以两者合在一起就是"每个模型的每种会话各自决定"。

## 谷峰计价（**在模型价格条目里**，逐模型）

峰谷是**计价设置，不是模型行为**，所以开关位于「模型价格」里每个模型自己的条目中（`prices[<modelId>].peakPricing`），不在规则里。

- 关闭（默认）→ 该模型**只用第一栏价格**，第二栏在界面上**立即置灰**且完全不参与计算。
- 打开 → 两栏都可用，按下面的时段在它们之间切换；切换开关时界面即时反馈，不需要保存。

"时段怎么算"是**全局**的，与"哪个模型用不用它"分开配置，所以在价格区顶部可折叠的一栏里。

内置规则与官方价目一致：**北京时间 9:00–12:00、14:00–18:00 为峰时**，其余（夜间、周末、法定节假日）全天谷价（价格为峰时的一半）。节假日表来自 `holidays` 配置，出厂内置 2026 全年安排，可在设置页编辑或一键恢复。

`peakSource: whale` 时改为读取 **dsh-whale-widget** 的时段与节假日常量（它是 DSH 里现有的余额挂件，自己实现了同一套峰谷规则）。实现方式与限制：

- 检测方式：在 `$DSH_HOME/profiles/*/node_modules/dsh-whale-widget/lib/index.js` 中按固定形状解析 `PEAK_HOURS` 与 `HOLIDAY_VALLEY`；解析成功即使用其结果（当前实测：2 个时段 + 33 个节假日）。
- **这不是官方接口**：该插件只导出插件对象、不注册 Cordis 服务，数据仅通过需要浏览器鉴权的 `/dsh-whale/balance.json` 下发（宿主端请求会 401），因此只能这样取。任何一步解析失败都会**自动回退到内置规则**，设置页会明确显示当前实际生效的是哪一个来源。

## 触发与落地时机

三个环节是分开的，不要混为一谈：

| 环节 | 时机 |
|---|---|
| **入队** | `assistant/message` 落盘时**同步**判定阈值并登记（不发起调用） |
| **开始蒸馏** | `step/end` 时立即发起。`step/end` 在**工具执行完之后**才落盘，所以有工具调用的那一步＝工具结果一落盘就开始（蒸馏要拿结果）；没有工具调用的那一步＝回答完立刻开始 |
| **落地生效** | 下一次请求构建**之前**：`agent/pre-step` 里等待未完成的蒸馏——成功则替换就位，撞上 `timeoutMs` 则放弃这次压缩（`timeoutMs` 是逐模型的唯一超时值，`0` = 不设超时） |

所以它既不是"等下一次 API 发送前才开始"，也不是"完全异步、什么时候好什么时候算"——**step 边界立刻开始，下一次请求构建前一定会出结果**（成功则替换就位，超时则这次放弃）。

**被取消的那一步不压缩**：用户中止生成时，宿主仍会写 `assistant/message`（带 `interrupted: true`，只含部分内容）并照旧写 `step/end`。此时不发起蒸馏——否则等于为一次被取消的回答花钱，还会把紧接着的下一跳请求按 `timeoutMs` 最长挡住。下一步正常完成时照常压缩。会话页的"思考压缩"选项卡每 4 秒静默刷新一次，并在窗口重新获得焦点时刷新，所以压缩一完成就能看到，不必再发一条消息。

### 正在进行的压缩与"为什么这步还没发出去"

- **输入框工具栏的活动指示**（`conversation.input.activity` 这个空着的单人座，就在发送按钮旁）：压缩进行中显示「正在压缩思考 · Ns」；如果某一步真的被它卡住，显示「等待压缩完成 · Ns」并写明卡住的是什么——**上一步的工具结果在等它** / **你刚发送的内容在等它** / **下一步请求在等它**。每 2 秒读一次状态、进行中每秒走一次计时。
- **「思考压缩」选项卡**顶部多出「正在进行」区：列出尚未结束的压缩（turn/step、产生 reasoning 的模型、估算 token 数、蒸馏路由、已进行了多久），被卡住时另有一条高亮横幅写明阻塞原因与已等待时长。
- 会话头部「压缩会话」入口里也能看到当前进行中的条目。

> 关于"像 reasoning / tool call 那样内联显示"：那需要在会话流里追加一条**展示用事件**，但仓库外插件只能追加已知事件类型（未知类型会被 `validateStoredEvents` 拒绝），而现有类型里没有"纯展示通知"这一种，所以做不到真正的内联块。因此指示放在 DSH 本来用于表达"当前在做什么"的位置（输入框活动座 + 插件自己的面板），不会污染会话流、也不会被发给模型。

压缩会话同时出现在两个地方：会话头部的**「压缩会话」入口**（与内置的子智能体列表并列的独立入口，点开是本会话所有压缩会话的清单，可逐个打开或复制 id），以及「思考压缩」选项卡里的清单。

## 外部审查与修复（GPT-6 Sol，只读审查）

一次外部只读审查提出 12 条指认，逐条核对后**大部分成立**，成立项均已修并加回归测试（唯一例外见下表 `deriveMessages` 包装那一行，实际**尚未修**）：

| 指认 | 核对结论 | 修复 |
|---|---|---|
| 侧车读取/解析失败被当成空记录缓存 → 下次 `update` 覆盖真实数据 | **成立（最严重）** | `load()` 只在 ENOENT 时视为空；I/O 与解析错误**抛出且不缓存**，写操作因此失败，磁盘文件保持原样 |
| 并发首次 `load` 不合并 → 旧快照覆盖已变更的记录 | 成立 | 单飞（in-flight promise）合并同一会话的并发读 |
| 改写只替换第一个 reasoning 块，却按全部块计节省 | 成立 | 一条消息里所有 reasoning 块折叠为一次改写，replay 数组同步对齐 |
| 只删 `signature`，pi-ai 的 `thinkingSignature` 等仍会重放 | 成立 | 被改写的 reasoning 块一律以**无载荷**的 `{type:'reasoning'}` 重放（覆盖 `signature`/`thinkingSignature`/`thoughtSignature`/`redacted` 各家命名） |
| 每次派生都生成新消息 id | 成立 | 改用 `freezeMessage` 克隆，**保留持久消息身份** |
| 跨 compaction 的压缩会被记成新 epoch → 目标已被压掉却仍累计虚假节省 | 成立 | 记账改为**只统计本次请求真正替换过的条目**（`substitute()` 发布 applied 集合），未上车的条目永不记节省 |
| 蒸馏成本漏计 `cacheWriteTokens` | 成立 | 按未命中价计入（DeepSeek 即按普通输入计，Anthropic 系偏高时保守），界面一并展示 |
| 流在抛出前已产出文本，成本按 0 输出估算 | 成立 | 边收边计字符数，异常路径按已收输出估算 |
| 派生位置索引只按 `length+tail` 缓存，可能失效 | 成立（其建议的 `surface.contentGeneration` 在本 build **不存在**） | 改为**每个会话事件都失效**索引缓存，不依赖不存在的 API |
| 压缩会话创建失败仍持久化，条目可能指向不存在的会话 / 留下孤儿会话 | 成立 | 先记 id 再 append（append 失败也保留可用 id）；确实拿不到会话时条目标注 `sessionMissing`，界面显示"未能创建审计会话（替换仍已生效）"，不再像 bug |
| `deriveMessages` 包装没有撤销器，卸载后仍改写 | **部分成立**：`ctx.effect` 确实注册了撤销器（`src/engine.ts:255`），但它只把 `active` 置 false（`src/engine.ts:450-453`），**不还原**被替换的 `deriveMessages`/`deriveEventMessage`（`Object.defineProperty` 只做一次，`src/engine.ts:614,623`）；且宿主的增量派生缓存只在 `contentGeneration` 变化时重建（`packages/core/session/src/index.ts:856-870`），可能短期继续用蒸馏版 | **未修**（审查台账 C3，需先定方案：真还原 + 失效宿主缓存，还是文档化）。原先这里写的"卸载时恢复原方法（e2e 验证过）"**不实**：撤销路径没有任何测试执行过——`test/smoke.ts:145` 只把 effect 体收进数组，`:99` 声明的 `effects` 从未被调用 |
| 渲染期安全（A）、安全/隐私（F） | **未发现问题** | 渲染路径另有 16 项 SSR 测试兜底；无密钥落盘、无推理内容进日志 |

### 第二轮（对已修版本的复查）

复查读的是修好后的文件，因此部分早期指认已失效。逐条核对结果：

| 指认 | 核对结论 | 处理 |
|---|---|---|
| `applied` 快照在"请求构建"与"响应到达"之间可能被别的派生覆盖 → 节省错记 | **成立** | 取消可变快照：记账改为**从 surface 确定性判定**（目标是否仍在 surface 上 + epoch + seq 顺序 + 时间），与"最后一次派生"彻底解耦 |
| `countedThroughSeq` 只写不读 → 重放同一响应会重复计费 | **成立** | 记账前先比对，已计过的高水位直接跳过 |
| 写入失败前 `mutate` 已改内存且不回滚 → 内存领先于磁盘 | **成立** | `update()` 先快照，写入失败时回滚内存状态 |
| 会话 id 清洗后可能同名（`team/a` 与 `team?a` 同文件）→ 串读对方私有推理 | **成立（隐私相关）** | 文件名追加原始 id 的 sha256 前 16 位；旧命名只读兜底，下次写入自动迁移 |
| 报告接口接受任意非空 id → 猜 id 即可读到别会话的推理原文 | **成立** | 只回答 `sessions.get(id)` 已知的会话：未知 id 返回 404，实测 已知 200 / 未知 404 / 空 400 / 坏 body 400 |
| `ownSessions` 在压缩会话被销毁后不清除 → 进程期内存增长；且 id 被复用时会被永久当作"插件自有"而**跳过观察**（功能缺陷，不只是内存） | **成立** | 监听宿主的 `session/disposed`，清掉该会话的全部痕迹（`ownSessions` / 索引缓存 / 阻塞标记 / 待处理目标）；并加测试证明"复用同一 id 的会话会被重新观察" |
| 索引缓存漏 `surface.contentGeneration`，内联替换（node 数与 tail 不变）会让改写落到错误消息 | **成立**（其建议的 API 该 build 没有） | **直接删掉位置缓存**，每次派生现算（O(nodes)，每步一次，与宿主本就要重建的代价同量级）。加测试模拟"内部节点一对一替换、不发事件"，并**反证**：把 length+tail 缓存放回去，该测试立刻失败 |
| 压缩会话经 `SessionStore.create()` 创建，不在 agent 生命周期内 → **从不落盘**，重启后 sidecar 链接到不存在的会话 | **成立（宿主文档确证）** | **改为正规接入公开的 `ctx.sessionPersistence`**：在独立注入作用域里注册写句柄（后端按会话 id 路由事件，所以**必须在首次 append 之前**登记），并加测试锁住"create → claim-writer → append"的顺序；无该后端的 profile 自动降级为仅内存，压缩与替换完全不受影响。另保留 `sessionLive` 标注作为兜底：万一写句柄拿不到，界面仍会如实说明 |
| 会话创建彻底失败时仍持久化条目（`sessionMissing`） | **设计选择，非缺陷** | 见下 |

> 关于最后一条：审查认为"条目必须指向一个真实存在的会话"。我保留现行为，因为它把**替换本身**（产品价值）和**审计会话**（可观测性）分开：创建审计会话失败时，改写仍然生效，条目如实标注"未能创建审计会话（替换仍已生效）"，并在界面显示该文案。替代方案（拿不到审计会话就不压缩）会让一次完全有效的压缩因为纯审计原因被丢弃——如果你更希望那种更严格的语义，改一行即可。

### 第三轮（新开关专项 + 续查）

本轮为"压缩哪些会话"的两个开关做专项复查，随后续查全树。**全部 7 条指认均成立并已修**：

| 指认 | 修复 |
|---|---|
| 深度 0 被当成子代理（宿主保留显式 `delegationDepth: 0`，其文档定义为顶层）→ 主会话被默认关掉 | 只认**正数**深度（`engine.ts`）；3 条断言锁住，反证过（放回旧写法即失败） |
| 迁移用的旧文件名不唯一（`team/a` 与 `team?a` 同名）→ 可能读到别人的记录并迁移过来 | 旧命名路径只在**记录自身的 `sessionId` 匹配**时才被采用，不匹配则忽略；摘要路径不匹配则**拒绝写入**（保护文件） |
| 记账/compaction 先改缓存再 `update` → 写失败时回滚盖不住这些改动 | 变更全部移进 `store.update` 的回调（快照在它们之前）；新增测试造真实写失败，断言"未持久化的节省不会留在内存" |
| `attach` 的 sidecar 预读是 fire-and-forget → 恢复会话后的**第一个请求可能用原始 reasoning** | `agent/pre-step` 里先 `ensureLoaded`（借单飞合并同一次读取），读失败只记日志不阻断对话；测试用 40ms 慢盘锁住 |
| `cacheBreakTokens` 只算被改写的那条消息，漏掉"同样失去缓存前缀"的后续段（如 100k token 的工具结果）| 增加 `suffixChars`：把改写点之后、surface 上会被重放的消息一并计入，并按 `(miss−hit)` 计费（一次性的前缀重建）；测试断言 0.0196 元量级而非旧模型的 0.00002 |
| `SessionsAction` 的报告请求无序列保护 → 切会话时慢响应会**串到另一个会话** | 加请求序号 + 会话变更即失效（与 View 一致） |
| 报告页把"历史累计移除"标成"每次请求"（compaction 淘汰的条目也被算进去）| 拆成两数：`每次请求` 只统计仍生效（同 epoch）的条目；历史累计单独标注 |
| `minSavedTokens` 跳过时**不写任何条目** → 已付的蒸馏钱在报告里完全消失（触发数、开销、审计会话链接都没了）| 跳过也落一条 `skipped` 条目（记录开销与审计会话、`savedTokensPerRequest` 为 0、不替换），界面显示"未采用"并说明原因；测试断言报告既不隐藏触发也不隐藏开销 |
| 旧 sidecar 的读取把**非 ENOENT**（权限/IO）也当"无文件"→ 缓存空记录，之后写出空的摘要文件**永久遮蔽**真实数据 | 只有 ENOENT 才算"无旧文件"；其它错误抛出、不缓存。测试用"把旧路径变成目录"造 EISDIR，并**反证**（放回旧写法即失败） |
| 设置页 draft 只在首次填充 → 另一个客户端改过的字段会被**陈旧 draft 静默回写** | 抽出纯函数 `ops.ts`（`planSave`/`saveOperations`）：只在未编辑时跟随最新值；保存**只写「draft 与其来源值」的差**，绝不按最新值回写。7 条纯函数断言覆盖，含"最新值被刻意忽略"这条 |

## 验证状态

> **只验证过一种组合**：当前宿主版本 + 当前版本的 `message-edit` 后端（`vendor/dsh-message-edit-0.2.3-patched4.tgz`，即 `v1.0.0` 产物）。
> 后端单选里还有一个 `placeholder` **占位条目**：它没有任何实现（没有路由、没有插件名、不发请求），只是占住 in-place 那个槽位，行内显示「占位（尚未实现，不可选）」并恒不可选 —— 见「助手消息改写后端」→「后端支持状态」。

已做：
- **客户端测试** 55 项（渲染 48 + 设置写入规划 7）（`npm run test:render`）：用 `react-dom/server` 真渲染三个客户端组件，覆盖现代报告、**旧宿主报告（版本错配）**、失败条目、空会话、加载/错误态。这条是补出来的——"渲染期抛错 → 整页空白"已经发生过两次（一次是配置表单绑定丢了 `this`，一次是我在 `report` 声明之前引用它，TDZ 抛错），所以现在渲染路径有测试兜着；我还临时把那个 TDZ 放回去验证过：测试确实会崩。
- 宿主端**离线冒烟测试** 184 项全通过、**`npm run typecheck` 0 错误**（阈值触发、蒸馏调用、压缩会话、`deriveMessages()` 返回蒸馏版而日志保持原文、工具调用块不被破坏、逐步记账、compaction 纪元重置后总量不丢、报表合计、峰谷归属四条、工具调用恒定附带、超时放弃并计费、工具调用恒定附带、失败写入回滚、旧文件名同址隔离、恢复会话首轮即带改写、首轮按未命中价计节省）。
- **whale 联动实测**：用真实 `$DSH_HOME` 跑通检测与解析（2 个时段 + 33 个节假日），两个来源在样例时刻上结论一致。
- 用**真实运行时包**在 profile 里加载 `lib/index.js`：导出 `{Config, apply, inject, name}`，`Config({})` 解析出正确默认值，`apply()` 正常执行。
- 客户端产物契约：`window.__ModuleLoader__.load({id:"dsh-reasoning-distill"})` 握手、`exports.apply/inject`、`require` 仅 `react` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`，`node --check` 通过。

未做：
- **没有在真实浏览器里点过界面**（需要重启 `dsh web`，而重启会中断发起这次工作的会话）。设置页保存、会话页渲染、压缩会话的"打开"按钮都只做了静态与接口层核对，未做交互验证。
- `npm run typecheck` 在本插件目录下不可用：DSH 的 peer 类型没有随包发布，宿主与客户端文件都会报 module-not-found。因此客户端是**未经类型检查**交付的。

## 安装

```bash
bash scripts/install.sh web
npm test          # 宿主冒烟 184 项 + 客户端 55 项
```

脚本做三件事：构建 → 给插件自己的 `node_modules/@deepseek-ai` 建一个指向 profile 共享运行时包的软链 → 用官方 CLI 把它作为 `link:` 依赖装进 profile 并登记进 `dsh.profile.bundles`。

**注意**：在插件目录里跑任何 `npm install`（包括装 devDependency）都会让 npm **剪掉**这个手工软链——它会把这个"多余"的链接当垃圾清理，然后插件在加载时解析不到宿主运行时。**改完依赖后请重跑一次 `scripts/install.sh`**（或手动重建该软链）。

**为什么需要那个软链**：Node 对软链包按 **realpath** 解析，而 `link:` 安装的实现在你的工作目录里，那里找不到 profile 的 `@deepseek-ai/dsh-llm`；实测直接 `link:` 安装会以 `ERR_MODULE_NOT_FOUND` 崩在插件加载阶段。补上这个软链后，`link:` 安装既能正确解析，又保留"改代码即刻生效"的开发体验。

**首次装完必须重启一次 `dsh web`**（包元数据在重启前不会重扫）。之后：

| 改动 | 生效方式 |
|---|---|
| 客户端代码（`src/client/**`） | `npm run build`，client-hmr 约 0.5s 内换包，**不用重启、不用刷新** |
| 宿主代码（`src/*.ts`） | `npm run build` + 重启 `dsh web` |

开发：

```bash
npm run build        # 宿主半 + 客户端半
npm test             # 宿主冒烟 + 客户端测试（打桩/SSR，无需真实运行时）
npm run typecheck    # 宿主半的真实 tsc（0 错误）；typecheck:all 会连客户端一起查
```

`npm run typecheck` **两侧都查**（`typecheck:host` + `typecheck:client`，各 0 错误）。客户端半此前没有检查，代价是真实发生过的三类运行时错误（未声明的 `useRef`、两个缺失导入、可空索引）都能通过构建与 SSR 测试溜出去；现在客户端半也有完整 tsc 覆盖——`slots` 服务的 Context 增强在本 checkout 不可解析，用 `types/cordis-augment.d.ts` 以**模块增强**方式补上（必须是模块，否则会覆盖真实 `Context` 并让 `effect` 等成员消失）。宿主半的类型检查**确实抓过真问题**——三次"文本锚点替换静默失效"（`continuableMaxDepth` 接口成员、`attachWriter` 字段、`sessionMissing` 字段都曾漏声明，JS 照常运行、只有 tsc 会发现）。

冒烟测试覆盖四件事：阈值触发与蒸馏调用、`deriveMessages()` 里确实看到蒸馏版而日志仍是原文、工具调用块不被破坏、逐步节省记账与 compaction 纪元重置。`test/stubs/` 只用于这次离线构建，**不会**进入 `node_modules`——放在那里的桩会遮蔽运行时真正的 `@deepseek-ai/dsh-llm`。

### 前置插件的启动问题与补丁（重要）

`dsh-message-edit@0.2.3` 的客户端产物 require 了 **`@deepseek-ai/dsh-client-runtime/client`**，而该说明符只存在于 DSH 的**测试支撑构建**里，运行时模块表解析不到 → **整个 web 启动失败**：

```
dsh-message-edit: import failed: client-modules: require("@deepseek-ai/dsh-client-runtime/client")
missed the module table — not a platform seed word, not a materialized module, and no
registered package factory (a build-time externals drift …)
```

它要的 `createSnapshotStore` 其实由**平台种子模块** `@deepseek-ai/dsh-client-store` 再导出（`packages/client/store/src/index.ts:103`），所以只是**引错了模块名**，改一行即可（语义完全等价）：

```diff
-require("@deepseek-ai/dsh-client-runtime/client")
+require("@deepseek-ai/dsh-client-store")
```

同族衍生包 **`@yunyv/dsh-message-edit`（0.2.8）** 有**同样**的漂移导入、**同样**的端点 `/message-edit` 与 **同样**支持 `assistant.reasoning`——我们的桥接对两者都适用。补丁脚本已能**自动发现并修补**这两个包（无需参数）：

```bash
python3 scripts/patch-message-edit.py           # 自动修补已安装的 dsh-message-edit / @yunyv/dsh-message-edit
DSH_PLUGIN_ROOTS=/some/profile python3 scripts/patch-message-edit.py   # 指定其他 profile
python3 scripts/patch-message-edit.py <client.js 路径>                  # 指定单个文件
```

**安装方式（任选其一）**：

1. **用打好补丁的包**：`vendor/dsh-message-edit-0.2.3-patched4.tgz`（**保持包名 `dsh-message-edit`**，只把版本标为 `0.2.3-patched4`）：
   ```bash
   cd /home/huhu233/otherProject/deepseek-harness
   pnpm dsh plugin --profile web add /home/huhu233/otherProject/dsh-local-items/dsh-reasoning-distill/vendor/dsh-message-edit-0.2.3-patched4.tgz
   ```

   ⚠️ 要装 **patched4**：`patched1`~`patched3` 只含客户端补丁，**不含任何会话格式修复**，用它建出来的分支会在重启后加载失败（详见「后端支持状态」与「安装与修补 `message-edit` 后端的完整流程」）。

   ⚠️ **不要给这个包改名**：它的客户端 bundle 里写死了 `id: "dsh-message-edit"`，一旦把 npm 包名改成别的（例如 `dsh-message-edit-patched`），DSH 就无法把 bundle 与插件行配对，**客户端半边（Timeline 标签页等）不会激活**——这正是"装了却看不到 Timeline"的原因。
2. **装原版再打补丁**：`dsh plugin --profile web add dsh-message-edit`，
   然后 `python3 scripts/patch-message-edit.py`（默认路径 `~/.dsh/profiles/web/node_modules/dsh-message-edit/client.js`，幂等，可重复运行）。

之后重启 `dsh web`。**注意**：重装/升级该插件会覆盖补丁，需要重跑脚本（或改用它上游修复后的版本——上游只需把那一行 require 换成 `@deepseek-ai/dsh-client-store`）。

## 自动交接：成功即转分支，失败留原处（无手动按钮）

时序（由宿主在 `agent/pre-step` 内完成，**客户端轮询不参与关键路径**）：

1. **压缩期间原分支被卡住**：`agent/pre-step` 先 `await ensureLoaded()`、再 `await settle()`，等这次蒸馏彻底结束才组装请求（有测试断言"pre-step 确实等了 ≥40ms"，并用把蒸馏器改快的方式反向验证过它不是空测）。
2. **压缩成功**（且选了 `message-edit` 这类**分支型**后端）→ 宿主在**发出任何请求之前**调用后端建好分支 → **`{kind:'reject'}` 终止本回合** → 面板看到报告里的 `branch` 后**自动打开新分支**。原会话**一次 API 都不会发出** ✓。
3. **压缩失败**（或后端拒绝/超时，例如"无法从会话历史解析模型路由"、含工具调用被拒等）→ **不终止**，回合照常在原会话继续；失败原因在推理蒸馏页显示（`branchError`），不会静默重试。
4. **建分支后自动归档原会话**（配置项 `archiveSuperseded`，**默认开启**）：面板打开新分支后，把被它替换掉的原会话**收进归档**——归档里的会话仍可找回。关掉这个开关就只切分支、原会话留在列表里。
5. **就地型后端**：它们的 `/api/*` 路由需要浏览器凭据，宿主够不到 → 由**面板/常驻芯片**在线应用（清标记但不中止你的回合：`handoff {cancel:false}`）。它要发的那次请求本来就已被重放替换变短，所以不存在"用长上下文多花一次"的问题。**当前这个槽位只有占位条目**（见下），它发不出任何请求，所以驱动会在认领之前就跳过它：既不 POST、也不清标记。机制本身完整保留在代码里，接上真有路由的后端即恢复。

**实现要点**：宿主侧建分支走 `http://127.0.0.1:<webServer.port>/message-edit`（该端点无需浏览器凭据）；`agent/pre-step` 返回 `PreStepDecision = {kind:'reject'}` 即可在请求组装前结束回合（这与宿主的 `archived-session-gate` 用的是同一个缝）。

**失败与超时的语义**（设置项「分支超时（毫秒）」，**0 = 永不超时**，仅分支型后端启用）：

- 建分支**不成功**（后端拒绝、报错、超时）→ **压根不建分支、当作无事发生**：回合照常继续，行为与"没选后端"完全一致 ✓；
- 唯一的痕迹是**记录在那一条压缩条目上**（推理蒸馏页可见）：失败显示原因 + 已按原会话继续，成功显示分支 id（面板据此自动打开新分支）；
- 超时值就是宿主等待后端的时限；设为 0 时宿主会一直等（后端最终返回就成交，否则会一直卡住——请自行权衡）。

## 助手消息改写后端（设置里单选；不选则总开关锁定）

本插件**不自己改写助手消息**，而是**完全调用前置插件**。设置页新增「助手消息改写后端（单选）」：

| 后端 id | 前置插件 | 调用 | 语义 |
|---|---|---|---|
| `message-edit` | `dsh-message-edit` 或 `@yunyv/dsh-message-edit` | `POST /message-edit` `{action:'edit', sessionId, eventSeq, blockIndex, text, cascade:'truncate'}` | **另开分支会话**（新增版本，原会话不动） |
| `placeholder` | —（无） | —（不发任何请求） | **无实际内容**：只占住 in-place 那个槽位；没有探针、没有插件名，因此恒显示「占位（尚未实现，不可选）」且不可选 |

### 后端支持状态（先读这一段）

**本仓库只验证过一种组合**：**当前宿主版本** + **当前版本的 `dsh-message-edit` 后端**（即 `vendor/dsh-message-edit-0.2.3-patched4.tgz`，或原版包经 `scripts/patch-message-edit.py` 修补后的安装件）。参考产物为 `v1.0.0`：

| 产物 | sha256 |
|---|---|
| `vendor/dsh-message-edit-0.2.3-patched4.tgz` | `f17cfc9bc654b7ca12663528c568c41022b6dce86db313548d31570051db7b5d` |
| profile 里的 `index.mjs` | `c3f19d1e417fab28087a7e6cc12ed7bbc9c3427fa3d998e7e19ad03369fca2ef` |
| profile 里的 `client.js` | `11cca125ecc372106a0d2d9e13fe75c9e5bb7d5d7c1e5f72e03dcc747d43f1b8` |

| 后端 id | 前置插件 | 验证状态 |
|---|---|---|
| `message-edit` | `dsh-message-edit` / `@yunyv/dsh-message-edit` | ✅ **唯一验证过的后端**：建分支、压缩自动交接、重启后仍能加载、跨回合交接不丢用户消息，全都只在它上面真实跑过 |
| `placeholder` | —（无） | ⬜ **无实现**：占位条目，不接受选择、不参与任何交接 |

> **`msg-edit`（`@moton16/dsh-msg-edit`）与 `context-shaping`（`zeranhub/dsh-context-shaping`）已在本版本中删除**：两者都是从未安装、从未修补、从未探测过的 in-place 后端，契约全属假定。它们的注册表条目、请求映射、安装条目、文案、打包脚本（`scripts/package-msg-edit.py`）与 vendor 产物一起移除了；in-place **机制**（前端写回驱动、认领标记、`handoff {cancel:false}`、`rewriteApplyOutcome`）整体保留，由 `placeholder` 占住槽位，将来接真后端时只需实现这一条。

**⚠️ message-edit 的已知残缺（选它之前先读）**：它是「**不想给 DSH 打补丁时**的残缺方案」。宿主目前**没有**把运行中的工作交给另一个会话的 API，所以：

- **不支持子代理、团队成员、后台任务**：分支是源会话的副本，而子代理/后台作业在宿主里**绑定创建它的那个会话**（作业的 owner 是活的 Agent，只有它自己的会话能看见；子代理的父关系由 provider 创建时写死，**只有祖先能 interrupt、只有相邻 Agent 能 sendMessage**）→ 分支**既不能接管、也不能指挥或停止它们**。已经在跑的话，默认靠 `skipWhileBusy` 让这种会话**不触发压缩**来回避；真要迁移必须等宿主加 API（例如 `subagents.reparent` / `jobs.reassign`）。
- 因此它只适合「单会话、不开子代理、不开后台任务」的场景。原位编辑型后端才能避开这个限制，但本仓库没有可用的那种后端（`placeholder` 只是槽位）。
- 另：即使插件被停用，宿主对不存在的路由回的是 **405 空体**（`/api/*` 则是平台自己的 **401 unauthorized**）而不是 404，所以可用性判定必须**跟一个不可能存在的同级路径对比**（`backendInstalled` 已按实测改成这样）——这正是此前「停用了却还能选」的原因。

因此：**请只选 `message-edit`**。`placeholder` 永远不可选；想接入别的后端，需要先做完整的接口核对与补丁适配，那属于尚未开始的工作。

### 启动时的后端自检（宿主侧，每个进程一次）

面板的探针需要浏览器凭据才能问到 `/api/*`（宿主自己去问只会拿到平台自己的 401），所以**每次 dsh 启动后第一次走到请求前检查（`agent/pre-step`）时**，宿主自己做一次**只看插件清单**的自检——**与本次是否触发压缩、阈值多少都无关**：

- **信号**：profile 的**已启用插件清单** `dsh.profile.bundles`（`<profile>/package.json`，由启动器提供的 `profileContext.dir` 定位；插件管理器 add / remove / 停用会同步改它）。**只看 `bundles`，不看 `dependencies`**：写在后者里的包可能只是**装了但没启用**，它不提供任何路由。
- **什么时候算「存的那个后端用不了」**（`backendUnusable`，三选一）：① 那个 id **本版本不认识**（被删掉的后端、或别的版本写的值）；② 那个 id 是**占位条目**——它没有任何实现，而且它的行是禁用的，面板自己也清不掉它，只有宿主能清；③ 它登记了插件名，而清单**读到了却没有它**。
- **此时做什么**：打一条 warn，并**写一次设置**（走设置服务 `settings.update('reasoning-distill', …)`，与面板保存同一条路径，落盘进 profile patch）：**清空选定后端**（`rewriteBackend: ''`），并在总开关仍为开时**同时把它关掉**（`enabled: false`）。总开关本来就是关的，就只清空那个过期名字。选中的名字比它依赖的东西活得久，留着会让面板和之后每个进程继续承诺一次交不出去的写回。
- **读不到清单**（拿不到 `profileContext`）→ **什么都不改**：对这个宿主没有任何证据，就不写用户的设置。
- 因此「**装着但已停用**」的后端在这里等同于**用不了**（它本来就没有路由）；面板的探针与它结论一致，两边都会把总开关锁成关，宿主的这次写入则把选中的名字也一起清掉。

### 安装与修补 `message-edit` 后端的完整流程（唯一验证过的路径）

以 `web` profile 为例，`$DSH_HOME` 默认 `~/.dsh`。

**0. 确认目标路径**

```bash
cd /home/huhu233/otherProject/dsh-local-items/dsh-reasoning-distill
ls "$DSH_HOME/profiles/web/node_modules/dsh-message-edit" 2>/dev/null || echo "尚未安装"
```

**1. 安装前置插件**（二选一）

- **方式 A（推荐，直接用已打好补丁的包）**：

  ```bash
  cd /home/huhu233/otherProject/deepseek-harness
  pnpm dsh plugin --profile web add \
    /home/huhu233/otherProject/dsh-local-items/dsh-reasoning-distill/vendor/dsh-message-edit-0.2.3-patched4.tgz
  ```

- **方式 B（装原版再打补丁）**：

  ```bash
  cd /home/huhu233/otherProject/deepseek-harness
  pnpm dsh plugin --profile web add dsh-message-edit     # 或 @yunyv/dsh-message-edit
  ```

> `vendor/` 里的 `patched1`/`patched2`/`patched3` 是**历史产物，已被 `patched4` 取代**：`patched1` 只修了客户端 require 漂移，**不含任何会话格式修复**，用它建出来的分支会在重启后加载失败。要装就装 `patched4`。
>
> ⚠️ **不要给这个包改名**：它的客户端 bundle 里写死了 `id: "dsh-message-edit"`；改成别的 npm 包名后 DSH 无法把 bundle 与插件行配对，**客户端半边（Timeline 页签等）不会激活**。

**2. 打补丁**（方式 B 必做；方式 A 已含，但重跑无副作用）

```bash
cd /home/huhu233/otherProject/dsh-local-items/dsh-reasoning-distill
python3 scripts/patch-message-edit.py            # 自动发现已安装的 dsh-message-edit / @yunyv/dsh-message-edit
```

脚本是**幂等**的：写前先 `node --check`，失败就**不落盘**；改动前留 `*.orig-<时间戳>` 备份；已在补丁态会打印 `already patched`。可用参数：

```bash
DSH_PLUGIN_ROOTS=/some/other/profile python3 scripts/patch-message-edit.py   # 指定别的 profile
python3 scripts/patch-message-edit.py <client.js 或 index.mjs 路径>          # 只处理一个文件
```

它改的东西（客户端 + 服务端两半）：

1. 客户端 require 漂移：`@deepseek-ai/dsh-client-runtime/client` → `@deepseek-ai/dsh-client-store`（否则整个 `dsh web` 启动失败）；
2. 子会话记录继承前缀：`meta.isSeeded: true` + `inheritedEventCount`，并在 seed 的切点插 `session/end-seed {inherited:true}`；
3. 拷贝过来的**未结束回合先收尾**（`openTurnClosers(..., "forked")`），否则分支自己的回合打不开；
4. 插件自有事件补 `ignorable: true`（否则持久化契约拒绝整份日志，会话从列表消失）；
5. 分支保留源的 **protected surface head**（否则后续 `system/message` 非法）；
6. 延迟交接把**触发它的用户消息**带进分支（否则那句话丢失）；
7. Timeline 不把 `origin: "subagent"` 的子代理会话列为版本；审计会话不进会话 lineage。

**3. 校验安装结果**

```bash
cd /home/huhu233/otherProject/dsh-local-items/dsh-reasoning-distill
python3 scripts/patch-message-edit.py            # 期望：already patched ×2
tmp=$(mktemp -d) && tar -xzf vendor/dsh-message-edit-0.2.3-patched4.tgz -C "$tmp" \
  && cmp "$tmp/package/index.mjs" "$DSH_HOME/profiles/web/node_modules/dsh-message-edit/index.mjs" \
  && cmp "$tmp/package/client.js" "$DSH_HOME/profiles/web/node_modules/dsh-message-edit/client.js" \
  && echo "安装件与 vendor 逐字节相同 ✓"; rm -rf "$tmp"
node scripts/scan-session-logs.mjs               # 期望：VALID 全部、INVALID 0
```

**4. 重启 `dsh web`**

服务端模块（`index.mjs`）**只在宿主启动时加载**：补丁后必须重启才生效（客户端半边硬刷新即可，但重启最保险）。

**5. 在设置里启用**

设置 → 推理蒸馏 →「助手消息改写后端」选 `message-edit`（不选后端时「启用思考压缩」会保持关闭并锁定，这是有意的闸门）→ 再打开总开关。

选中分支型后端后，下方会多出**「分支后端专用选项」**（标题里带后端 id）：

- **建分支后自动归档原会话**（`archiveSuperseded`，默认开）：新分支显示出来后把被替换的原会话收进归档，仍可在归档里找回；
- **分支超时（毫秒）**（`branchTimeoutMs`）：宿主等待分支型后端建好分支的时限，0 = 永不超时；
- **有后台工作/子代理时不压缩**（`skipWhileBusy`，默认开）：该会话还有运行中的后台任务或子代理时（宿主的作业注册表同时管两者），**当作没触发思考压缩**——不蒸馏、不建分支；关掉则照常压缩，被替换的原会话等那份工作结束再归档。

**6. 重装/升级前置插件后必须重跑第 2 步**

`dsh plugin add` 会覆盖安装件，补丁随之丢失；重跑 `patch-message-edit.py` 即可（幂等）。

### 快速安装后端（设置页按钮，免手敲命令）

设置 → 推理蒸馏 →「助手消息改写后端」旁边有 **「快速安装后端」** 按钮，点开是一个独立页面：

1. **选择后端**：列出**可安装**的后端——当前只有 `message-edit`（本仓库唯一验证过的）。`placeholder` 是占位条目，不在可安装列表里，走这个路由会被直接拒绝。
2. **选择方式**（页面同时给出两者优劣）：
   - **用脚本安装（推荐）**：跑本仓库的 `scripts/install-backend.sh <后端>`，步骤是「定位 checkout/profile → 官方 CLI 装入 profile → 打补丁 → 校验安装件与 vendor 逐字节一致」。页面显示**逐步进度 + 安装输出**，随时可**取消**；**安装跑在宿主进程里，关掉页面（甚至刷新）也不会中断，回来继续看到同一份进度与结果**。前提：本机有 `pnpm` 与 `python3`。
   - **让 agent 安装**：选一个**工作区**，确认后跳到该工作区的**新会话**，安装提示词已经**填进输入框**（发不发由你决定）。agent 会读 README 自己排查，但结果不保证、会真实消耗额度并改动文件。
3. 两种方式都**不替你重启** `dsh web`：页面与报告会告诉你何时需要重启。

脚本的失败语义：任一步失败即以 `##FAIL` 结束并保留输出；进度只有成功/失败/已取消三种终态，不会假装成功。

**原位后端的写回由谁发起**：in-place 后端的路由在 `/api/*` 后面，需要**浏览器凭据**，宿主自己够不到，所以写回只能由**前端**发起。此前它只在「推理蒸馏」标签页里做（打开该标签才挂载 ✗），而宿主的「待应用」标记**每个会话只留最新一个** ✗ —— 于是连续压缩时除最后一条外都不会被写回，对话页就一直显示原文。现在改为：**常驻座位**（输入框上方的芯片）每次拿到报告就**逐条判断**，凡是「在生效、没被拒、没有交接记录」的条目就发写回并结算；两个驱动之间用**浏览器存储里的认领标记**（60 秒过期）避免重复发送。因此**不需要打开报告标签**。这段驱动当前没有可驱动的后端（`placeholder` 发不出请求），接上真 in-place 后端即恢复。

**探测规则**：插件页挂载时对每个**有探针**的后端发一次探针请求；**`404` 且响应不是 JSON** 才算"未安装"——因为已安装的后端连自己的错误（会话不存在、请求体不合法）也是用它自己的 JSON 信封回答 `404`，单看状态码会误判成没装。`placeholder` 没有探针，所以既不发请求也永远不可选。

**已知不能接入的**：`yumiao-dev/dsh-chat-thinking-editor` 只通过浏览器的 `assistantEdit/replace` **Remote**（RPC 通道）暴露能力，没有 HTTP 面，我们的客户端无法直接调用 → 记入不支持。

规则（与面板实现一致）：

- **只列出已安装的后端**：插件页挂载时各探测一次端点的探针请求，`404` 视为未安装 → 该行置灰、不可选；`placeholder` 没有探针，所以恒不可选。
- **单选且可取消**：点选中的那一行即取消选择；换选另一个会自动取消原来的。
- **默认为"不选"**（配置里为空串）。
- **未选后端 ⇒ 「启用思考压缩」自动关闭并锁定**（面板显示为关闭且不可点；引擎侧同样拒绝发起蒸馏——这是两道一致的闸门）。选择后端后总开关解锁，是否打开由你决定。
- 条目本身没有"应用/创建分支"按钮：交接由宿主或常驻驱动自动完成，页面只显示结果（分支 id、失败原因、"已按原会话继续"）。
- ⚠️ **升级提示**：该配置项默认为空，所以**升级后需要先在设置里选一个后端**，否则思考压缩会保持关闭（这正是上面的规则所要求的）。

## 可选前置：`dsh-message-edit`（"以蒸馏版开分支"）

> 它是**唯一验证过的后端**；安装、修补、启用与自检的完整流程见「助手消息改写后端」→「安装与修补 `message-edit` 后端的完整流程」。

插件页每条记录的展开区有一个 **「以蒸馏版开分支」** 按钮。它**不自己实现分支**，而是调用同源端点：

```
POST /message-edit
{ "action": "edit", "sessionId": "<会话>", "eventSeq": <该条 targetSeq>,
  "blockIndex": <reasoning 块下标>, "text": "<蒸馏文本>", "cascade": "truncate" }
→ 200 { "sessionId": "<新分支会话 id>", ... }
```

该端点由 **`dsh-message-edit`**（`Moeblack/dsh-message-edit`，npm 包 `dsh-message-edit`）提供；它的语义是"**不改写历史事件、从目标回合之前创建一个新会话版本**"，因此：

- 新分支的**对话/轨迹/上下文页**以及**宿主的压缩计量**看到的都是**压缩后**的历史 ✓（这正是"就地改日志"做不到的事）；
- **原会话分毫不动**，随时可切回；创建成功后插件会用 `openSession` 直接打开新分支。

**降级行为**：未安装该前置时端点返回 404，插件会显示"需要安装 dsh-message-edit 才能创建分支"，其余功能不受影响；`blockIndex < 0`（找不到 reasoning 块）、蒸馏文本为空、或该条已不在当前上下文中时，按钮显示为不可用而不是失败。

## 设计边界：为什么原生页面显示原文（已核实，勿重复踩）

**结论**：对话 / 轨迹 / 上下文页显示的是**原始推理**；只有**发给模型的请求**使用蒸馏后的文本。这是宿主的设计，不是本插件的能力缺口。

证据（宿主源码，已逐条核对）：

1. **位置替换对助手消息被运行时禁止**：`packages/core/session/src/surface.ts:329-365` 要求替换必须逐一引用被遮蔽节点，同时又规定 `assistant/message` **一旦携带 `sourceEventSeqs` 就抛错**；类型层同样（`core/session/src/types.ts:470-478` 里该字段为 `never`）。因此插件无法遮蔽已有助手节点。
2. **人类转录只读"追加来源"的原始事件**：`surface.ts:78-85` 明说替换副本 **model-only**、转录必须读 durable 原文；原生 chat 直接取 `event.data.message.content`（`client/ui-chat/.../conversation-nodes/assistant.ts:190-205,292-300`），轨迹同理（`ui-trajectory/.../trajectory-assistant-definition.ts:254-269`），上下文页渲染的是 durable 节点内容。
3. **压缩计量读逐事件原始文本**：`llm/token-meter/src/surface-fold.ts:17,111` 用的是**自由函数** `deriveEventMessage(event)`（不传投影表），所以**阈值、保留预算、"摘要必须更小"的判据**都按原文计算——本插件省下的 token **不会**降低压缩压力。**但压缩的输入已经被接上了**：`compaction-basic` 的 `buildSummarizationInput` 走的是 **session 方法**（`region.ts:552,557`），本插件包装了它，所以 summarizer 读到的是蒸馏文本（含洗过的 replay 载荷）——两个口径目前只在这条边界上不一致，且方向是"保守"（估价偏高）。

**为什么不用 `registerMessageProjection`**（它确实存在：`core/session/src/index.ts:931-945`，可让模型可见面在原位置换成插件文本）：

- 自定义投影事件必须声明 `@messageProjection`，而离线/浏览器/查询读取器只用**构建期目录**（`session-format-catalog/src/message-projections.ts:1-7` 目前只有 `imageOffloadProjection`）；
- 未知的**必需**事件会在格式恢复时被**拒绝**（`session-format-v3-to-v4/src/validation.ts:52-65`）；把它标成 `ignorable` 又属语义错误（读者会跳过并重建出**不同的**模型历史）。结果就是：外部插件用投影会导致**重启后会话可能加载失败**——比"日志零足迹 + 包装派生"更糟；
- 且无论投影与否，**原生页面都不会显示投影文本**（见第 2 点）。

**想要"所见即短"只有两条路**：① 用分支功能创建**真实的短历史**会话；② 让宿主在 UI 层提供"显示压缩后内容"的开关（上游需求，见 `docs/upstream-compacted-view.md`）。

## 已知限制

- **时序**：蒸馏必须在下一步请求之前完成。`timeoutMs`（逐模型，默认 60s）到点即 **abort 并放弃这一次压缩**——原始 reasoning 保持原样，该次尝试记为 `failed`（计入开销、节省为 0），压缩会话保留供排查。`0` = 不设超时。
- **替换永不进入会话日志**，所以对话转录与模型实际看到的思维链会不一致；这是设计取舍（也是唯一能在不破坏事件校验的前提下生效的接缝）。
- `savedLive` 是**估算**：token 数用 `字符数 / 4`（与会话统计同口径），第一次重放按未命中价、之后按命中价计；`cacheBreakCost` 恒为 0（见上文"缓存断裂"那一节）。不对账真实账单。provider 未回报 usage 的中断调用按"已发送提示词 + 已收到输出"估算并标注「估算」。
- **压缩会话的持久化取决于 profile 是否装了持久化后端**。宿主明确说明：在 agent 生命周期之外发布的会话不持久化任何东西（`core/session/src/index.ts:911-916`）。本插件通过公开服务 `ctx.sessionPersistence` 为该会话登记写句柄（在首次 append 之前，因为后端按会话 id 路由事件），因此**装有 JSONL 后端的 profile 里压缩会话会真正落盘、重启后仍可打开**；没有该后端时自动降级为仅内存，界面把失效会话标成「会话已随上次运行结束」并撤掉打开按钮。无论哪种情况，**完整审计内容都持久在 sidecar 里**（提示词原文、蒸馏结果原文、usage、开销），会话页直接展示。
- **模型目录没有"思考是否加密"的元数据**，因此不做声明式开关：插件只在拿到**非空 reasoning 明文**时才触发，模型不返回明文就自动跳过。
- 会话页的汇总数字来自 sidecar 的增量记账：插件在某个会话上第一次加载之前的旧历史不会被补算。
- sidecar 读不出来（损坏/权限）时，插件**拒绝改写该会话**（宁可功能停摆也不覆盖文件），会话页显示错误而不是空面板；修好文件后自动恢复。
- **同一会话里工具集合 / 系统提示的变化本身就会造成前缀未命中，不能归因于本插件**：宿主在每次请求前比对请求头，变化时追加 `request/header`（`reason: 'change'`；工具增删还会补一条 `developer/message`，见 `core/agent-loop/src/agent.ts:626-647`）⇒ 发给模型的 system prompt / 工具表随之改变，已发送前缀自然不再逐字节相同。这是宿主处理工具变化的**正常行为**（例如装上/卸下 `dsh-ops` 改变了可见工具集）；即使完全不装本插件，同样的变化也会造成同样的未命中。
- **与 `dsh-ops` 共存的技术前提**：本插件声明兼容 `dshReleases: 0.2.1-alpha.1`、Node `>=20`（`package.json` 的 `dsh.compatibility` / `engines`）；`dsh-ops` 声明 Node `^22.19 || >=24`（`dsh-ops/package.json` 的 `engines`，它没有声明 `dshReleases`）。两者同装时门槛取**较高**者：Node 必须满足 `^22.19 || >=24`——只满足本插件的 `>=20` 不足以保证共存；DSH 版本也要落在两者共同可用的范围内。
