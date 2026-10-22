# Changelog

本插件的版本变更记录。

## 0.1.16

- 仅版本号重发：0.1.14 与 0.1.15 在 npm 侧被 staged-publishing 的注册表 bug 卡住（`npm publish` 返回成功但版本未上线，`npm stage list` 也没有记录可 approve/reject；见 npm/cli#9889）。改用 npm 12 的发布路径重试；代码与 0.1.14 相同。

## 0.1.15

- 仅版本号重发：0.1.14 被同一 npm staged-publishing bug 卡住；按 npm/cli#9889 的通用做法 bump patch 后重新发布。代码与 0.1.14 相同。

## 0.1.14

### 报告页：压缩阶段与手动取消
- 运行中的压缩现在带 stage / stageStartedAt：preparing → distilling → recording → writing-back。「思考压缩」页面显示当前阶段与该阶段已持续的时间。
- 新增 POST /api/reasoning-distill/cancel：在改写被采用前可取消一次压缩。取消会中止蒸馏请求、丢弃结果，并让等待中的 pre-step 立即继续；已采用的压缩拒绝取消（按钮在“写回/交接”阶段不再显示）。
- 取消后的失败记录标注 cancelled by user；被取消的 attempt 不会再触发 hand-off。

### 配置：删除 skipWhileBusy
- 删除 `skipWhileBusy` 配置项：它原本没有设置页入口，用户无法关闭，实际只对分支后端有语义。
- “有后台工作就跳过压缩”现在**只对分支型后端（message-edit）生效**；`derive` / `in-place` 不再检查宿主 job 列表，后台任务运行期间照常压缩。
- 设置文档/客户端归一化、面板保存字段、README 配置表和本地化原因同步移除该项；旧配置里残留的 `skipWhileBusy` 会被忽略。

### 修复：副本与分支源会话不再误发原文
- Fork/复制会话继承账本：会话 header 为 seeded、带 parentSession 且不是 subagent 子会话时，插件在首次 pre-step 前把父会话 sidecar 中位于 inheritedEventCount 前缀内的 entry 复制到新会话（保留目标 seq/message id，必要时把分支 hand-off 的目的地重指到副本）。这样 derive 模式的 Fork/分支副本不会因为没有自己的 sidecar 而重放原文。
- 分支 hand-off 不再把改写从源会话移走：entryInForceHere 只排除 failed/skipped。即使 archiveSuperseded 关闭、归档失败或客户端没跟上分支，原会话继续使用时仍重放同一份压缩版，不会退回原文；报告/UI 同步把这类 entry 计为已采用。

## 0.1.13

### 计费改为跨轮次（基于实测）
- 实验确认：**DSH 的请求一般情况下始终携带 tools，而带 tools 时之前轮次的思考内容会随之后的每一次请求重新发送，模型也能看到**（实验、复现脚本与 DSH 抓包验证见 [deepseek-reasoning-experiment](https://github.com/huhu23333/deepseek-reasoning-experiment)）。README 与代码里“只有当前轮才重放”“DeepSeek 多轮不参考历史 reasoning”的旧描述已删除/改写。
- `account()` 不再以“最新用户消息”为计费边界：所有仍生效（目标未被宿主 compaction 淘汰）的改写，在其后的每一次已应答请求上都会计入节省；跨轮次的重放同样计入。
- `stock()` 与报告 fallback 的“当前单次请求减量”改为统计**全部跨轮仍在生效**的改写，用户发新消息不再归零；历史累计节省的统计范围同步扩大。
- 移除引擎中仅供轮次计费使用的 `lastUserSeq` 状态，以及报告/路由里的透传字段。
- README 的适用场景与报告数字说明、sidecar/report 类型注释、`docs/review-2026-10-16-unfixed.md` 的对应条目同步更新；smoke 的 scenario 20 改为验证跨轮次继续计费。
- 已写入的 sidecar 无需迁移：下一次请求开始，旧改写会在后续轮次继续累计节省（历史数字不会追溯重算）。

## 0.1.12

本版集中修复 0.1.11 复核中确认的问题。既有问题清单见 `docs/review-2026-10-16-unfixed.md`（已按本版更新）。

### 主开关语义（明确）
- 明确并文档化：**总开关只控制是否发起新的蒸馏；已经生效的压缩版继续替换**。要恢复原文需停用/卸载插件或删除 sidecar 记录（in-place 需回退宿主补丁）。README 与设置页说明同步。

### 修复
- **derive 后端可用性（P1）**：无探测路由的后端不再被 `backendReachable` 判成"未安装"，否则选中 derive 会锁死总开关、0.1.11 的主推后端实际无法启用。
- **默认规则开关串扰**：保存"对主对话启用"时会同时写明两个子代理开关，避免关→开之后静默开始压缩可续接子代理。
- **价格默认表**：内置 DeepSeek 两栏价改为逐字段回退；稀疏保存（只写改动字段）后再也不会丢掉谷时计价或产生 `undefined` 价格；设置页也会把内置条目物化显示，内置条目不可删除。
- **whale 峰谷**：明确两个来源**二选一**——选中 whale 时时段与节假日都来自 widget（不叠加用户列表），选中内置时只用用户维护的节假日表；任一常量解析失败回退内置规则；只读取当前 profile 的 widget，并在文件变化后失效缓存。
- **失败 compaction**：带 `error` 的 `compaction/end` 不再关闭 epoch、不再把存活改写按未命中重新计价（此前会高估节省）。
- **数值配置**：`null`/负数/越界值在解析层归一化（阈值、最低节省、超时、百分比、长度上限、开关），设置页输入框也会按 min/max 钳制。
- **maxInputChars 语义**：只限制上下文块（工具调用参数、该步可见文本、工具结果），不再因为推理过长而静默放弃蒸馏；所有上下文块都会受该上限约束。
- **in-place 写回**：
  - flush 失败不再标记"已写入"/不再返回成功；
  - 欠账写回前比对 `originalHash`，目标被用户改过就退休该改写而不是覆盖；
  - 路由不再信任调用方传入的文本，只用 sidecar 里的 `distilledText`；
  - 面板 settle 成功时返回 `ok:true`（in-place）；停止卸载途中不再继续写回。
- **欠账/账本**：`stock` 的 per-entry id 与 token 合计使用同一套轮次过滤；`owedInPlaceEntries` 排除已被 compaction 淘汰的条目；`stock` 先查引擎注册表（子代理会话）。
- **旧 Session 对象的请求**：委托会话在 turn 边界被 dispose/re-enter 时，旧对象上排队的那次请求不再退回原文——同一会话（id + header.createdAt）的替代对象仍按账本替换；旧对象的 pre-step 会先预载 sidecar（2s 上限），跨会话复用 id 仍保持原文的保守行为。
- **审计会话**：创建后立即从引擎的 per-session 记账里摘除，长跑宿主不再每压缩一次就泄漏一份会话对象/记录。
- **空 sidecar 缓存**：陌生 id 的空白记录不再进内存缓存（`/report` 不能再无界增长内存）。
- **未信任数据边界**：蒸馏输入边界加入随机 nonce，工具输出无法伪造闭合边界与"最终提醒"。
- **快速安装**：使用宿主当前 profile 注入 `DSH_PROFILE`/`DSH_PROFILE_DIR`；取消会杀进程组并 5s SIGKILL 升级；未知 step id 的日志也受 400 行上限；状态不再把已完成的安装改写成取消。
- **安装脚本**：统一 `DSH_HOST_CHECKOUT > DSH_CHECKOUT` 优先级与 `--checkout` 空值校验；message-edit 安装先校验 vendor sha256（新增 `vendor/*.sha256`）；`install.sh` 读取 `DSH_PROFILE`、优先使用自带 dsh CLI；打包版提示改推 `derive`。
- **Python 补丁**：splice 时同步清掉被替换块的重放签名；保留文件权限；不再累积 `.orig-*` 备份。
- **scan-session-logs**：使用宿主自己的已知事件集（不再把插件事件加入白名单）、同时扫描未压缩日志、发现无效日志时以非零退出。
- **probe**：zstd 检查改为真实 magic 校验，不再恒真。
- **安装页**：in-place 置顶并作为默认项；步骤标签本地化且与实际动作一致；不再把未知 backend id 当作 message-edit；安装提示词改为走验证过的脚本流程并引用正确 README 标题。
- **其他 UI/报告**：探测失败的 backend 不再显示为"未安装"并允许清除选择（可重试探测）；报告详情支持 `detail:false`（composer 轮询不再拉全文）；compression-session 存活性查询加 30s 缓存；目录读取失败会在设置页提示；冲突提示文案改为如实描述；`maxOutputChars` 截断不再劈开代理对；`legacyOneShotSwitch` 兼容普通布尔值。
- **测试**：新增/更新 derive 可达性、默认规则开关、价格稀疏回退、whale 用户节假日、失败 compaction、欠账 active 过滤、in-place canonical text 等回归用例。

### 仍不在本版修复范围（见问题清单）
- 跨进程共享 `DSH_HOME` 的串行化（C5）、token-meter 绕过包装（C6）、缓存断裂字段恒 0 的计价口径（N6）、in-place 旧签名配新文本（N8，需改宿主补丁并重新打补丁）、未信任/多用户路由边界（B10/N3/N5 的属主部分）。
