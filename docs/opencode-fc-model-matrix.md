# OpenCode FC 模型矩阵工具

该工具用于开发期批量认证 OpenCode Go 的 Chat Completions 模型。它不会在普通用户发送消息时探测，也不会把同一服务商或相似模型名自动视为兼容。

## 分层门槛

每个精确模型最多使用 35 次模型请求：

| 阶段 | 新增请求 | 累计请求 | 结果 |
|---|---:|---:|---|
| `transport` | 2 | 2 | 流式具名工具 + 非流式 `required` |
| `surface6` | 6 | 8 | 私聊、群聊、动态各 2 次严格题意验证 |
| `release30` | 24 | 32 | 三个 surface 累计各 10 次、合计 30 次 |
| `release` | 3 | 35 | 原生取消/fallback 边界 + 临时真实会话与清理；真实会话为失败后的单次文本 fallback 预留 1 次 |

任一步失败只停止该模型，其他模型可继续。只有完整 `release` 通过才在报告中生成可审核的 bundled 候选记录；工具不会直接修改生产能力目录。

## 安全默认值

- 不带 `--execute` 时只读取 `/models`，模型推理次数为 0。
- 付费执行必须同时提供明确的 `--models` 或 `--all`、正整数 `--max-paid-calls` 和 `--report`。
- 调用预算在每个阶段开始前按最坏情况预留，绝不越过当次命令的硬上限。
- 报告会在每个付费阶段开始前和完成后原子保存。中断中的步骤标为未决，默认不会自动重放；只有显式 `--retry-uncertain` 才会重试。
- 已失败步骤默认不会重试；`--retry-failed` 是显式操作，旧尝试及调用数仍保留在报告中。
- 目录指纹变化时拒绝沿用旧 checkpoint，避免把不同目录快照的证据拼在一起。
- 报告只保存模型 ID、校验结果、错误码、时延和 usage，不保存 API key、模型正文或工具参数。

## 使用方式

必须先以 Windows PowerShell 启动带 CDP 端口的 dev APP。以下命令均在 `D:\my\phone\tauri-chat-app` 执行。

只规划 DS V4 Flash/Pro，不产生推理费用：

```powershell
node scripts/dev/run-opencode-fc-matrix.mjs --models deepseek-v4-flash,deepseek-v4-pro --through release
```

推荐按阶段执行，并复用同一个报告文件：

```powershell
node scripts/dev/run-opencode-fc-matrix.mjs --execute --models deepseek-v4-flash,deepseek-v4-pro --through transport --max-paid-calls 4 --report scripts/dev/tmp/opencode-fc-matrix-state.json

node scripts/dev/run-opencode-fc-matrix.mjs --execute --models deepseek-v4-flash,deepseek-v4-pro --through surface6 --max-paid-calls 12 --report scripts/dev/tmp/opencode-fc-matrix-state.json

node scripts/dev/run-opencode-fc-matrix.mjs --execute --models deepseek-v4-flash,deepseek-v4-pro --through release30 --max-paid-calls 48 --report scripts/dev/tmp/opencode-fc-matrix-state.json

node scripts/dev/run-opencode-fc-matrix.mjs --execute --models deepseek-v4-flash,deepseek-v4-pro --through release --max-paid-calls 6 --report scripts/dev/tmp/opencode-fc-matrix-state.json
```

如果前一阶段有模型失败，后续命令会跳过它，因此真实请求数通常低于上限。恢复失败或未决步骤必须分别显式增加 `--retry-failed` 或 `--retry-uncertain`。

`scripts/dev/tmp/` 是保留在仓库中的空输出目录，生成的报告与截图由 Git 忽略。完成批次后可将报告归档到仓库之外；续跑原批次时，应将 `--report` 指向原有检查点文件。

## 当前目录与验收状态（2026-08-15）

- OpenCode Go 目录：26 个模型。
- 已接入 Chat Completions adapter：16 个。
- 已发布：`glm-5`、`glm-5.2`、`glm-5.3`、`mimo-v2.5-pro`。
- 本轮 14 个未发布候选已全部完成分层测试，实际使用 148 次请求；只有 `glm-5` 与 `mimo-v2.5-pro` 完整通过并加入 bundled revision 3。
- 其余 12 个 Chat Completions 模型保留在目录中但继续 fail-closed；重新跑完整矩阵的理论上限为 420 次请求。
- `deepseek-v4-flash` 与 `deepseek-v4-pro` 均精确存在，但 OpenCode Chat Completions transport 探针返回 HTTP 400，没有放行；这不影响 DeepSeek 官方 Responses 渠道。
- GPT/Grok、MiniMax、Qwen 等当前目录项不属于现有 Chat Completions adapter，矩阵会明确拒绝；必须先实现各自的 Responses/Messages adapter，不能误用当前工具链。
