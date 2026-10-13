# 调研：把历史 reasoning 蒸馏后原地替换并回传

> 只调研，未实现。web 内容为外部不可信数据，仅作资料引用。
> 说明：本环境 `github.com` / `raw.githubusercontent.com` 直连常失败，部分证据来自搜索引擎返回的 README/源码片段与镜像站，已逐条标注。

## ① 一句话结论

**没有找到直接实现**——没有任何现成插件同时具备「reasoning 超阈值 → 调用更便宜模型蒸馏 → 把蒸馏版**替换**进历史 → 在后续所有请求中回传」这四件事。
最接近的是 **headroom（`headroom-ai`）**：它确实把历史 reasoning 压缩后**替换并回传**，但用的是自家非 LLM 的 Kompress 分词压缩器，且默认关闭；DSH 生态里 `dsh-context-surgery` 能**手动**编辑思考链并让下一轮请求读到改后版本（机制完全一致，只是触发是人工而非自动蒸馏）。

## ② 候选清单

| 名称 | 类型/渠道 | 它到底做什么 | 与本想法的重合度与关键差异 | 安装/链接 | 证据来源 |
| --- | --- | --- | --- | --- | --- |
| **headroom**（`headroom-ai`） | 第三方代理/库，非 DSH | `transforms/thinking_compactor.py`：把旧轮次的 extended-thinking 块换成压缩文本并**替换 `body["messages"]`**（PRE_SEND 钩子），后续请求读到压缩版。OpenAI 路径改写 Kimi `reasoning_content`、GLM/DeepSeek `<think>` 内文 | **重合 3/4**：有「替换并回传」+ 有阈值门（`min_words=40`、"没变小就跳过"）+ 有 `keep_last_turns`（默认 1）保护活跃推理。**差异**：蒸馏器是自家 ModernBERT「Kompress」分词压缩器，**从不调用更便宜的模型**；`HEADROOM_THINKING_COMPACT` 默认关；Anthropic 侧反而加**字节级锁**（`body_forwarding.py`：任一 thinking 块被改动就整包回退原字节） | PyPI `headroom-ai`（0.40.0）；npm `headroom-ai`（仅 TS SDK）。⚠️ PyPI 裸名 `headroom` 是**另一个项目** | [thinking_compactor.py](https://gitcode.com/GitHub_Trending/head/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/thinking_compactor.py) · [commit efb78f9](https://github.com/headroomlabs-ai/headroom/commit/efb78f96ba5cac239558afe3d28a9204b7f5e3e0) · [commit 17522fb（记录真实 Anthropic 400）](https://github.com/headroomlabs-ai/headroom/commit/17522fb0a1013c012e8123b1e713dbb2f3e770d9) · [PR #866（DeepSeek reasoning_content）](https://github.com/headroomlabs-ai/headroom/pull/866) · [PyPI](https://pypi.org/project/headroom-ai/) |
| **dsh-context-surgery** | DSH 插件（社区） | 「强制改写 DSH 会话的**模型可见历史**（surface 替换）」。`/context think <seq> <文本>` 与 `context_edit{part:"thinking"}` **只改 reasoning 块**（留空=删除），保留正文与工具调用；改完**下一轮请求即读到改后历史**，GUI 重新折叠；日志 append-only，原文可还原 | **机制重合 100%，触发不同**：它已证明在 DSH 里「替换 thinking 并回传」可行且不改日志。**差异**：纯手动/工具调用，无长度阈值、无自动蒸馏、不调用更便宜的模型 | npm `@wasd258/dsh-context-surgery`；vendor 源码 `/context` + `context_*` 工具 + 回环 HTTP API。GitHub 根目录无 `dsh.bundle`，需按 README 手工挂载 | [中文 README 全文](https://deepseekplugin.org/en/plugins/wasd258-jpg-dsh-context-surgery) · [socket.dev](https://socket.dev/npm/package/@wasd258/dsh-context-surgery) · [dsh-xray 说明](https://unstone.github.io/dsh-xray/) |
| **dsh-chat-thinking-editor** | DSH 插件（npm，★8，近 30 天 1061 下载） | 每条已完成助手消息加铅笔按钮，**正文与思考链分开编辑**；改动以 **surface replacement** 形式保存，之后整个对话只认改后版本 | 与上条同类（手动编辑思考链→回传）。**差异**：无阈值、无蒸馏、无自动触发；动机是"改掉模型不配合的回答"而非省 token | `dsh plugin --profile web add dsh-chat-thinking-editor` | [awesome-dsh-plugin 卡片](https://awesome-dsh-plugin.com/zh/p/yumiao-dev/dsh-chat-thinking-editor/) · [GitHub](https://github.com/yumiao-dev/dsh-chat-thinking-editor) |
| **DSH 原生 compaction**（`packages/compaction/*`） | DSH 内置 | 四层缩减：spill → model-free prune → summarize（一次模型调用）→ 溢出恢复。**全部**通过 `surfaceOp:{op:'replace'}` 落地，摘要**替换**头部区间并在后续请求生效。摘要调用**重放原对话前缀**（system+tools+被遮蔽消息逐字节相同）以复用热缓存 | **重合 2/4**：有「另一次（可以是更便宜的）模型调用」+「替换历史并回传」。**关键差异**：官方写明**只把 `returns 文本` 放进检查点，reasoning 与 tool-call 一律丢弃**（理由是泄露私有推理 / 造成孤儿工具调用）——即**丢弃 reasoning，不是蒸馏 reasoning** | DSH 内置，无需安装 | [第 10 章 上下文压缩](https://dragonchencl.github.io/dsh-notes/chapters/ch10/) · [第 5 章 surface 投影](https://dragonchencl.github.io/dsh-notes/chapters/ch05/) |
| **dsh-cache-safe-tool-result**（对照基线） | DSH 插件（GitHub） | 保持**工具结果**的缓存前缀安全：结果在**首次进入会话表面之前**截断，并且**永不重写已经由某次 provider 请求投递过的工具结果** | **正交**：它处理的词汇是 tool result，不是 reasoning；它的核心不变量（"已投递过的历史不得重写"）正是本想法**故意要违反**的那一条。它证明了 DSH 生态把"改写已投递历史"视为需要显式越权的事 | `github:DoctorxPriestess/dsh-cache-safe-tool-result`。⚠️ 在 dsh.so / dsh.works / 岚叔目录 / npm 多次检索均**未命中**，只有 GitHub 本身；无第三方验证等级数据 | [GitHub](https://github.com/DoctorxPriestess/dsh-cache-safe-tool-result) · [插件页](https://ai-develop.top/plugins/9267) |
| **dsh-stepwise-distill** | DSH 插件（社区，★1，C3） | 把**工具结果**原地重写成"模型实际保留的事实"，长会话不再每轮重发噪声。逐 step 一次额外全上下文请求（`stepSummary` 开时）；每请求约 770 字符契约开销 | **最接近的"蒸馏+原地替换+回传"同类**，但**对象是工具结果不是 reasoning**。可直接借用它的触发与成本模型 | `github:yunxiyang/dsh-stepwise-distill`。dsh-xray 评级 C3：`runtime_patch`、`install_script`(postinstall)、`prompt_surface` | [GitHub](https://github.com/yunxiyang/dsh-stepwise-distill) · [dsh-xray 能力卡](https://unstone.github.io/dsh-xray/p/yunxiyang__dsh-stepwise-distill.html) |
| **dsh-compressor** | DSH 插件（npm 0.1.0） | 「**Headroom 的精简移植**」：压缩工具输出，最多减 20% 上下文，声称不影响模型上下文缓存与 agent 性能 | 与 headroom 同源但**只压工具输出**，不碰 reasoning | `dsh plugin --profile <p> add dsh-compressor` | dsh 插件目录检索结果（dsh.works + radar，实测过）；因 raw.githubusercontent 失败未能读取其 README |
| **billion-context-pi / billion-context-dsh** | Pi 扩展 / DSH 移植（★141） | 模型驱动的主动上下文剪枝（ACP）：压缩轮次、`compress`/`decompress`/`search_context` 工具 | **接近但相反**：它处理"**超长 reasoning 的删除**"——`dropCompressReasoning` 会删掉已闭合 compress 轮的 reasoning；**在严格回传的思考型上游（DeepSeek 思考模式 + tools）上自动禁用**，否则触发 400。是"丢弃"不是"蒸馏" | npm `billion-context-pi` / `billion-context-dsh` | [CHANGELOG 片段](https://github.com/ranxianglei/billion-context-pi/blob/master/CHANGELOG.md) · [PR #339](https://github.com/ranxianglei/billion-context-pi/pull/339) · [commit 9f6bd35](https://github.com/ranxianglei/billion-context-pi/commit/9f6bd35eeb9149d3692474ba5a9e2f2aca16da9d) · [billion-context-dsh](https://github.com/tyan66666/billion-context-dsh) |
| **agent-context-editor** | 跨宿主插件（DSH + Pi，★62） | 手动排除/编辑上下文；**AI 把选中上下文凝练成可编辑、可回滚的摘要**；Reasoning 与 Answer 独立管理 | **半重合**：有"AI 凝练并替换"，但作用于**被选中的普通上下文**。README 明确「**Reasoning … 不能被编辑**」；无阈值自动触发 | `dsh plugin --profile <p> add ./context-editor-deepseek-harness-0.4.10.tgz` | [DSH Plugin Store 页](https://www.dshplugin.store/plugin/jermaine123123/agent-context-editor) |
| **iii993/dsh-manual-context** | DSH 插件 | 手动上下文注入 + 对话历史/思维链编辑器 | 同类手动编辑器；无自动蒸馏 | `github:iii993/dsh-manual-context` | 插件目录检索 + [GitHub](https://github.com/iii993/dsh-manual-context) |
| **Anthropic preserved thinking / context editing / compaction** | 平台机制 | ①thinking 块带**签名**，绑定 conversation prefix；前缀任一字节变化 → 默认 **400**，`drop_block` 则丢弃该块及其后所有块；②server-side context editing **按规则清除旧 thinking 块**（不生成摘要）；③压缩块之前的 thinking 不随之保留 | **不是本想法**：官方只提供**丢弃**或**保留原样**，不提供"替换成蒸馏版" | 平台内置 | [Bedrock preserved thinking 全文](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-thinking-block-binding.html) · [compaction + preserved thinking](https://platform.claude.com/docs/en/build-with-claude/compaction-thinking-blocks) · [400 排查实践](https://claudelab.net/en/articles/api-sdk/claude-api-preserved-thinking-append-only-history-audit) · [Anthropic 反蒸馏公告](https://support.claude.com/en/articles/16761192-preserved-thinking-changing-how-the-messages-api-handles-thinking-blocks-to-protect-against-distillation) |
| **DeepSeek thinking mode 约定** | 平台机制 | 带 `tools` 的请求：**所有历史轮次的 `reasoning_content` 必须完整回传**，否则 **400**；不带 tools 时会被忽略、不进上下文 | **是本想法的硬约束来源**：替换版仍是"回传"，但官方措辞是 "must be **fully** passed back"，未承诺接受改写后的文本 | 平台内置 | [DeepSeek Thinking Mode 文档](https://api-docs.deepseek.com/guides/thinking_mode/) |

## ③ 最接近的替代品排序与理由

1. **headroom（`headroom-ai`）** —— 唯一真正落地了"压缩历史 reasoning → 替换进 messages → 后续请求生效"的产品级实现，且已带阈值门、缓存稳定性设计与 `keep_last_turns` 保护。要在它的思路上前进，只需把 Kompress 换成一次廉价模型调用即可。它同时给出了**反面证据**：Anthropic 路径必须退回字节级锁，说明该路线上限受 provider 约束。
2. **dsh-context-surgery** —— 机制上**已经完成 100% 的"原地替换 thinking 并回传"**（走官方 surface replacement，与 compaction 同一道缝），只差"自动 + 用便宜模型蒸馏"这层策略。想在 DSH 里做本想法，这是最该先读的实现，也是现成可手动验证的方案。
3. **DSH 原生 compaction + `dsh-stepwise-distill`** —— 提供了本想法最缺的**触发与成本骨架**：阈值/压力触发、额外一次模型调用、摘要必须比原文更小才接受、重放前缀以复用热缓存。`dsh-stepwise-distill` 则证明 DSH 生态里"用额外一次请求把历史改写成模型真正保留的事实"这条路是有人走通的（只是对象是工具结果）。
4. **dsh-chat-thinking-editor / dsh-manual-context / agent-context-editor** —— 手动版同类，可作为最小可用验证工具，但不是自动化方案。

## ④ 明确"没有找到"的方向（避免误以为已穷尽）

- **没有任何插件的蒸馏器是一次"更便宜模型调用"**：headroom 用自家非 LLM 的 Kompress；`dsh-stepwise-distill` 与原生 compaction 虽用 LLM，但对象是工具结果/整段历史。**"用便宜模型只提取 reasoning 的有效部分"这一具体形态，未找到任何实现。**
- **没有任何实现的触发条件是"单条 reasoning 长度超阈值"**：现存触发是"上下文压力阈值/溢出"（DSH compaction）、"词数 ≥40"（headroom，且仅作为压缩门）、"模型主动决定"（billion-context-dsh）、或纯人工。按 reasoning 长度单独触发，未找到。
- **DSH 插件生态内没有 reasoning 蒸馏插件**：多轮目录检索（`reasoning/thinking 思维链 蒸馏/压缩/裁剪`、`thinking block 思考 裁剪`、`context 上下文 token saver`、`prompt cache 前缀 稳定 reasoning 回放` 等约 8 组中英混合查询）只命中：manual thinking editor 类、display 层 thinking 摘要/翻译类（`dsh-thinking-summary`、`dsh-cot-en2cn`，均**不改**发送给 API 的历史）、reasoning-effort 档位类、loop 检测类（`dsh-reasoning-loop-guard`）。**未命中任何"自动蒸馏 reasoning 并回传"的插件。**
- **`dsh-cache-safe-tool-result` 未获得第三方验证数据**：在 dsh.so / dsh.works / 岚叔目录 / npm / GitHub topic 中均未检索到，因此**无法给出 install-ready spec、验证等级与安全标记**，只能给出 `github:DoctorxPriestess/dsh-cache-safe-tool-result` 形式与其 README 自述。此项为本次调研的证据缺口。
- **未能读取 `dsh-compressor` 与 `headroom` 的部分一手源文件**：`raw.githubusercontent.com` 与 `github.com` 直连失败，headroom 的 `thinking_compactor.py` 经 gitcode 镜像与 commit patch 交叉核对，`dsh-compressor` 仅取得目录描述。若需精确到行号，建议在可直连 GitHub 的环境复核。
- **未检索的门**：`cc-thinkfix`、`claude-code-deepseek-thinking-proxy`、`deepseek-bridge`、`new-api` PR #7153、`DeepSeek-Reasonix` PR #6217、`openclaw` PR #90163 只在检索摘要中出现，均为"修复 reasoning 缺失/签名失效导致的 400"一类**保真回传**工作，方向上与本想法（改写回传）相反；未逐个读取全文确认。

## ⑤ 一个必须记下的可行性硬约束

本想法的"替换版回传"在两个主流 provider 上会撞墙，这不是工程问题而是协议问题：

- **Anthropic**：thinking 块带签名且绑定 conversation prefix。**签名被改动过的块必定 400**（与 `block_binding` 取值无关）；把内容改掉等于放弃签名，该块会被判为不可解密而拒绝。`drop_block` 只能**丢弃**，不能**替换**。因此"蒸馏后回传"在 Anthropic 上等价于"丢弃该块"——那就不再有"把有效部分喂回去"的收益。参见 [Bedrock 文档](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-thinking-block-binding.html)。
- **DeepSeek（带 tools）**：文档要求 `reasoning_content` **完整**回传，否则 400。理论上它没有签名校验、是自由文本，改写**可能**被接受，但官方措辞未承诺，且 `billion-context-pi` 正是因为这类严格上游才把 reasoning 删除功能**自动禁用**。参见 [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) 与 [CHANGELOG](https://github.com/ranxianglei/billion-context-pi/blob/master/CHANGELOG.md)。

附带成本问题：任何对历史 reasoning 的改写都会**改动 prompt cache 前缀**，从改动点起后续缓存全部作废（Anthropic 亦明示"让 thinking 失效的编辑同时重启缓存"）。所以只有"节省的 reasoning token ≫ 缓存重建成本"时才有净收益，而缓存重建成本随会话长度增长——这正是 headroom 选择 `keep_last_turns=1` 且默认关闭的原因。

## ⑥ Lead 复核更正（读一手源码后）

**更正 ②/③ 中的 `dsh-context-surgery`：它不是可用先例。它"改 assistant 思考链"的路径在当前 DSH 上必然抛错。**

一手证据（下载 npm 包 `@wasd258/dsh-context-surgery@0.1.2` 解包读源码）：

- `lib/index.js:137-142` `buildReplacementFrom()`：原文是 assistant 时返回 `{ type: "assistant/message", ... }`；
- `lib/index.js:205-209` `editNode()`：以 `surfaceOp: { op: "replace", start: seq, end: seq }` + `sourceEventSeqs: [seq]` 调 `session.append`。

而宿主对 `assistant/message` 携带 `sourceEventSeqs` 是**硬拒**：

- `packages/core/session/src/surface.ts:335-336` 抛 `assistant/message embeds its source stream and cannot carry sourceEventSeqs`；
- 同文件 `:361-364` 又要求 replace 的 `sourceEventSeqs` 必须覆盖每个被遮蔽节点（空数组同样被拒）；
- 两条互锁，没有空子；`packages/core/session/tests/surface.spec.ts:141` 有断言该拒绝的测试。

该禁令由 commit `f99b06eaed`（2026-09-01，"session format v2：嵌入 assistant 流"）引入。**`dsh-chat-thinking-editor` 的 `src/index.ts` 踩的是完全相同的坑**（同样是 `assistant/message` + `sourceEventSeqs`）。两者都面向 pre-v2 的 0.1.x 编写，目录里也都只标"已收录"而无"Run tested / 已验证"。

因此第 ③ 节排序应改为：这两个插件只能作为**未验证的历史参考**（证明"当年有这条缝"）。当前 DSH 上可用的接缝只有两条——插件自有 message projection（`sessions.registerMessageProjection`，先例 `dsh-compaction-image-offload`），或包装 `Session.deriveMessages()`（`dsh-stepwise-distill` 走通的那条）。注意它们的 user-message 分支不受此限：两个插件的"改用户消息"功能仍可用，只有"改 assistant 思考链"失效。

**`dsh-cache-safe-tool-result` 的目录缺席已解释**：仓库确实存在（已读其 README 一手内容），只是未进入任何被检索目录；不影响它作为"正交基线"的引用价值。
