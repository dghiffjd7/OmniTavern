# 女仆与实时语音女仆审查

时间：2026-09-24 13:44 CST。

修复状态：2026-09-24 14:10 CST，以下 10 项均已修复，见文末修复记录。正文保留修复前的定位与复现证据。

范围：以工作区根 `PROGRESS.md` 的 2026-09-24 00:59、10:14、11:12、12:04、12:17 五轮记录为需求依据，核对当前工作区实现。HEAD 为 `d2d42715a55768c9b10e4b1cb9e7cff14dab10fd`；这些实现尚未形成新提交，因此按进度记录限定范围，没有重新审查上一轮已经处理的全部性能改动。

修复前的审查结论：发现 10 项实现缺口；其中删除预览的目标漂移为 P1，其余为 P2。审查轮只做复现，未修改产品代码。以下保留两条独立审查线的结果，并单列主审的补充发现。

## Standards：规范与调用链

没有发现独立的 AGENTS 硬性违规或需要立即处理的代码坏味道。`app.js` 本轮主要承担装配与回调接线，不建议为此次审查额外拆分。调用链核对发现以下 4 项功能问题。

### S1 · P2 · 语音执行仍被女仆主配置门禁拦截

位置：[app.js:24356](../src/scripts/ui/app.js#L24356)、[maid-command-submit-runtime.js:31](../src/scripts/ui/maid-command-submit-runtime.js#L31)。

选择“语音模型直接执行”，并且已配置 GPT-Live / OpenAI 语音模型、未绑定女仆主档时，任务应该使用语音执行档。但提交器仍调用基础 `resolveMaidRuntimeConfig()`，没有使用带 `voiceCallId` 的 resolver；它会提前返回“带我配置 API”，根本进不到后面的语音模型解析。离线复现：语音 resolver 的 `configured=true`，实际 `agentCalls=0`。

修复应让提交前的配置检查与实际执行共用同一份带任务上下文的模型解析；附图能力检查也有相同的基础 resolver 接线，需要一并保持一致。

### S2 · P2 · 语音取消不能作废删除预览

位置：[maid-voice-task-runtime.js:4](../src/scripts/ui/maid-voice-task-runtime.js#L4)、[maid-voice-task-runtime.js:67](../src/scripts/ui/maid-voice-task-runtime.js#L67)。

`awaiting_confirmation` 被当作终态，因此删除预览结束后，说“取消任务”会被取消入口过滤掉，返回 `cancelled:0`；对应 run 的 `pendingWorkflow` 仍保留。随后再说“确认后执行”，旧清单仍会进入执行链，与“明确取消即作废”的要求不符。

离线探针用真实语音 runtime、任务 runtime 和女仆 agent 复现。真实删除工具仍保留 APP 确认，此处不是绕过权限自动删除。应让语音取消显式关闭属于该任务的待确认流程。

### S3 · P2 · 语音“允许”反而作废预览

位置：[maid-voice-task-runtime.js:85](../src/scripts/ui/maid-voice-task-runtime.js#L85)、[maid-pending-action.js:72](../src/scripts/agent/maid-pending-action.js#L72)。

语音控制能识别“允许／允許／allow”为确认，但删除预览不属于正在等待的卡内 approval，于是入口将原话交回女仆。pending reply 分类器不识别这些确认词，将它们视作其他请求，令清单变为 `superseded`。已离线复现没有进入执行。

应统一语音控制和待确认工作流的确认语义，同时继续约束到对应任务与通话。

### S4 · P2 · 清除历史后仍可能写回旧历史提取的记忆

位置：[maid-conversation-store.js:1882](../src/scripts/storage/maid-conversation-store.js#L1882)、[maid-conversation-store.js:1823](../src/scripts/storage/maid-conversation-store.js#L1823)、[maid-conversation-store.js:1964](../src/scripts/storage/maid-conversation-store.js#L1964)。

`stillQueued` 只在进入异步 upsert 前检查。若写操作已经排进 semantic store 的串行队列，`clearHistory()` 清掉批次后，该写操作仍能执行。真实 store 的离线复现中，延迟前一笔保存，等待提取写入入队后清历史；释放队列后，历史和批次均为 0，旧历史产生的长期记忆却重新出现。

这不涉及已经保存的长期记忆是否应随历史删除，而是“进行中的提取结果不再写回”没有完全实现。失效检查需要覆盖实际写入时刻。

## Spec：需求实现

### F1 · P2 · 长答复上限只改了校验，实际仍截为 1200 字符

位置：[maid-provider-fc-planner.js:346](../src/scripts/agent/maid-provider-fc-planner.js#L346)、[maid-model-planner.js:1293](../src/scripts/agent/maid-model-planner.js#L1293)。

11:12 记录要求将函数调用最终答复放宽到 6000。schema 已放宽，但标准化及最终 decision 各有一次 `truncate(..., 1200)`。因此长清单不会再报原来的校验错误，却会无声丢失后半段。

离线复现：1661 字符答复校验成功，输出只剩 1203 字符（含省略标记），末条 `FINAL_ENTRY` 丢失。应统一校验与传递上限。

### F2 · P2 · 空字符串响应不会触发同档重试或备用档

位置：[maid-model-planner.js:153](../src/scripts/agent/maid-model-planner.js#L153)。

11:12 记录包含“空响应先同档重试 2 次”。当前实现只处理 `chat()` 抛错，而 OpenAI / Custom 的非流式路径可以正常返回空字符串；它随后直接变成 `invalid_model_plan`，不进入重试或备用档。

离线复现：主档首次返回空字符串、第二次可成功，并且备用档可用；实际 `primaryCalls=1`、`fallbackCalls=0`。应在纯文本调用的重试边界识别空结果；不能把正常的函数调用无正文混为此类错误。

### F3 · P2 · 开启思考绕过 Anthropic 函数调用兼容检查

位置：[maid-provider-fc-planner.js:447](../src/scripts/agent/maid-provider-fc-planner.js#L447)、[provider-fc-transport.js:1049](../src/scripts/agent/provider-fc-transport.js#L1049)。

使用 `claude-sonnet-4-5` 等手动思考模型、女仆设为“开启思考”、FC 使用默认设置时，工具计划先按未开启思考构建；随后才追加 `thinking.type=enabled`，保留了强制的 `tool_choice:any`，绕过计划构建时的兼容检查。这违背“函数调用兼容规则优先”。

[Anthropic 官方文档](https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-with-tool-use)明确手动思考不支持强制 `any` / 指定工具的组合，会报错；此结论不泛指 adaptive thinking。已核对从参数组装到 provider payload 的完整链路，未调用真实 API。应在构建工具计划之前带入实际思考模式，让同一处完成兼容校验。

## 主审补充：待确认目标与资料修改

### R1 · P1 · 删除预览没有冻结实际解析出的目标

位置：[maid-pending-action.js:30](../src/scripts/agent/maid-pending-action.js#L30)、[preset-regex-script-tools.js:837](../src/scripts/agent/tools/preset-regex-script-tools.js#L837)。

pendingWorkflow 保存的是原始 `args.targets`，预览输出里的已解析 ID 被丢弃；确认时重新按名称查找。如果预览后手动将原项目改名，再创建同名项目，确认将指向从未预览过的新项目。APP 确认仍出现，但同名标签无法体现这次目标替换。

已用真实 registry、agent、pendingWorkflow 和正则删除工具复现：预览 `set-original`，确认实际删除 `set-replacement`，原项目保留。应冻结预览中确实可执行的目标 ID 及其作用域，确认时复验，避免重新解析名称。

### R2 · P2 · 语音任务修改了切换后的聊天室

位置：[profile-update-tool.js:37](../src/scripts/agent/tools/profile-update-tool.js#L37)、[maid-assistant-agent.js:2930](../src/scripts/agent/maid-assistant-agent.js#L2930)。

在 A 房间交办“把当前聊天室改名”，任务执行前切到 B：新工具省略 target 时只读 `chatStore.getCurrent()`，不读取冻结的任务上下文；schema 又没有 `sessionId`，所以 agent 对语音任务的通用目标注入也不会生效。

完整离线调用的上下文为 `voiceCallId=voice-1, sessionId=chat-a`，实际确认目标和修改结果均为 `chat-b`。应在解析缺省目标时使用交办时捕获的上下文，再进入确认和执行。

### R3 · P2 · 确认等待期间产生的重名仍会被写入

位置：[profile-update-tool.js:75](../src/scripts/agent/tools/profile-update-tool.js#L75)、[profile-update-tool.js:196](../src/scripts/agent/tools/profile-update-tool.js#L196)。

重名校验只在 preflight 做一次；用户确认后只检查目标自身的名称和简介有没有变化，没有复验其他资料是否占用了新名称。若等待确认期间另一个同类项目取得该名称，执行仍返回成功，留下两个同名项目，与“同类重名不写入”的要求不符。底层 PersonaStore / ContactsStore 也没有替它拒绝重名。

离线复现：A 申请改为 `NewName`，确认等待期间 B 改为 `NewName`，随后允许 A；最终 A、B 都是 `NewName`。应将重名检查延伸到执行前。

## 验证记录

Windows PowerShell 下只执行以下 4 组既有专项，各一次，全部通过：

- `node scripts/tests/maid-pending-action-tests.mjs`
- `node scripts/tests/profile-update-tool-tests.mjs`
- `node scripts/tests/maid-voice-tests.mjs`
- `node scripts/tests/maid-conversation-store-tests.mjs`

另外使用 3 份最小离线探针，均不调用真实模型、不操作用户数据：

- `scripts/dev/tmp/maid-review-root-20260924.mjs`：R1–R3。将预期行为写成断言，当前版本三项均失败并打印实际结果；退出码 1 表示成功复现缺口。
- `scripts/dev/tmp/review-voice-memory-20260924.mjs`：S1–S4，断言实际异常结果，执行通过。
- `scripts/dev/tmp/spec-maid-review-20260924.mjs`：F1、F2；首次通过 stdin 运行后保存，没有重复执行。F3 使用代码链与官方契约验证。

没有重复全量测试，没有打开新的 dev 进程或作真实通话测试。既有专项通过只能说明已有覆盖未回归，不能覆盖上述新边界。

计数：Standards 无硬性规范违规，附带 4 项调用链问题；Spec 3 项需求缺口；主审补充 3 项目标定位与复验问题。

## 修复记录 · 2026-09-24 14:10 CST

用户授权后完成全部 10 项修复：

| 问题 | 修复后的行为 |
| --- | --- |
| S1 | 提交前按带 `voiceCallId` 的任务上下文解析实际执行模型；附图门禁复用同一配置，选区截图门禁也传递该上下文。未绑定女仆主档时可使用已配置的语音执行档。 |
| S2 | 语音取消直接关闭所属通话和 submission 的 pendingWorkflow；队列已释放的删除预览也可以取消，后续确认不能恢复。 |
| S3 | 明确的语音 confirm 动作规范化后续接原任务，保留其房间与任务 ID；“允许一次”等说法和无额外文本的结构化 confirm 均可处理，其他通话不能确认旧清单。 |
| S4 | 写入有效性检查进入 semantic store 的串行写队列内部；清除历史会同时阻止尚未写入的结构化记忆和模型提取记忆。已保存的长期记忆保留。 |
| F1 | schema、tool call 标准化与最终 decision 共用 6000 字符上限，长清单完整传递。 |
| F2 | 纯文本调用的空白结果视为临时请求失败，先同档重试 2 次，再使用备用档；正常函数调用的无正文结果不受影响。 |
| F3 | 实际思考参数在工具计划校验前传入。Anthropic 手动思考直接转兼容文本规划，不先发出冲突请求；兼容的 adaptive 思考仍可使用 FC，DeepSeek 等传输规则仍优先。 |
| R1 | 预览快照升级到 v2，只保存确实计划执行的 ID 与容器/作用域；确认不再按名称回退，也不会纳入预览时不存在的项目。不同作用域复用同一 ID 的项目分别处理。旧版缺少快照的待删清单要求重新预览。 |
| R2 | `profile.update` 的省略目标优先采用任务捕获的 sessionId；显式目标仍优先，原房间不存在时不回退到当前房间。 |
| R3 | 用户确认后、实际修改前再次检查同类名称冲突，覆盖用户、角色卡和聊天室三类资料。 |

`app.js` 仅调整现有模块的依赖接线和上下文传递；已评估机会型拆分，本次没有适合额外抽出的完整逻辑块。

验证：Windows PowerShell 下以下 14 组相关专项全部通过，没有重复运行全量测试。仅在代码或测试初始化修正后重跑受影响的组：

- `maid-pending-action-tests.mjs`、`profile-update-tool-tests.mjs`、`preset-regex-script-tools-tests.mjs`
- `maid-realtime-task-tests.mjs`、`maid-voice-tests.mjs`、`voice-task-model-tests.mjs`、`maid-command-input-runtime-utils-tests.mjs`
- `maid-conversation-store-tests.mjs`、`maid-semantic-memory-store-tests.mjs`
- `maid-model-planner-tests.mjs`、`maid-provider-fc-planner-utils-tests.mjs`、`maid-provider-fc-planner-integration-tests.mjs`
- `maid-assistant-agent-tests.mjs`、`app-ui-capture-tools-tests.mjs`

回归用例已覆盖上述根因，以及同名替换、旧 ID 恰好成为其他项目名称、跨房间/通话、跨作用域重复 ID、等待确认期间重名、已排队提取写入、长答复二次截断与 manual/adaptive 思考分流。

语音整合测试的既有 fixture 补上“已选择执行方式”状态，避免在无 DOM 的 Node 测试中打开首次选择弹窗。`node --check src/scripts/ui/app.js` 与相关 diff 空白检查通过。通过 CDP 检查现有 `http://127.0.0.1:1430` dev：OmniTavern 页面加载完成、appBridge 存在、无 Vite 错误层；没有启动另一份 dev，没有调用真实模型或修改用户资料。

验证范围为离线回归和 dev 基础页面烟测，真实服务商通话尚未实测。审查阶段 `scripts/dev/tmp` 下的探针保留作历史复现，当前行为以正式专项测试为准。
