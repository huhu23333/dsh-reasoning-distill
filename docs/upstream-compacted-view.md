# 上游需求：让"压缩后的内容"在原生页面可见（或允许插件提供持久化投影）

## 背景

`dsh-reasoning-distill` 插件把过长的助手推理蒸馏成短文本，并在**重放的模型请求**里替换原文（包装 `Session.deriveMessages()`，日志零改动）。
用户可见的三个原生页面（对话 / 轨迹 / 上下文）**仍显示原始推理**；宿主的压缩计量也按**原文**计算。我们希望用户能选择"看压缩后的版本"。

## 已核实的现状（行号基于本仓库当前版本）

1. **助手消息无法参与位置替换**：`packages/core/session/src/surface.ts:329-365`（替换必须引用全部被遮蔽节点；`assistant/message` 携带 `sourceEventSeqs` 直接抛错），类型层约束见 `packages/core/session/src/types.ts:470-478`。
2. **人类转录刻意只读追加来源事件**：`packages/core/session/src/surface.ts:78-85`；原生 chat `packages/client/ui-chat/src/client/conversation-nodes/assistant.ts:190-205,292-300`；轨迹 `packages/client/ui-trajectory/src/client/trajectory-assistant-definition.ts:254-269`。
3. **计量器读取逐事件原始文本**：`packages/llm/token-meter/src/surface-fold.ts:17,111` 使用自由函数 `deriveEventMessage(event)`（无投影表），因此阈值与压缩输入按原文。
4. **投影机制存在但对外部插件不可持久化**：`packages/core/session/src/index.ts:931-945` 可注册 `SessionMessageProjection`；但离线/浏览器/查询读取器只使用**构建期目录**（`packages/session/session-format-catalog/src/message-projections.ts:1-7` 仅含 `imageOffloadProjection`），未知必需事件在格式恢复时被拒（`packages/session/session-format-v3-to-v4/src/validation.ts:52-65`），标 `ignorable` 则语义错误。

## 请求（任一即可满足需求）

- **A. UI 层开关**：在对话 / 轨迹 / 上下文页提供"显示压缩后内容"的切换，数据来自当前请求派生（`Session.deriveMessages()` 已是模型所见），并标明这是**模型视图**而非 durable 历史。
- **B. 允许插件持久化投影**：让插件声明的投影事件类型/解释器进入持久化目录（或在恢复时按已安装插件解析），使投影结果在重启与离线读取中可用；同时保持"转录显示原文、模型视图显示投影"的既有区分。

## 我们暂不采用的做法（附理由）

- **改写 JSONL / 直接改日志**：没有受支持的语义重写 API（`packages/session/session-persistence-jsonl/src/storage.ts:38-60` 只有追加与断尾截断；`packages/core/session/src/index.ts:682-716` 明确日志是 durable 真源）。
- **用非助手角色替换助手节点**（如 `user/message` 装蒸馏文本）：运行时允许但角色错误，会污染模型对"自己的思考"的认知。
- **外部插件运行时注册投影**：会带来"重启后会话可能无法加载"的风险（见现状第 4 条）。
