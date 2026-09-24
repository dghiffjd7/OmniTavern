# 女仆 / 实时语音补修复核与遗留问题评估

审查时间：2026-09-24 14:40 CST。功能修复时间：2026-09-24 15:15 CST；启动回归修复：15:33 CST。

最新实施：2026-09-24 17:10 CST。已按用户授权在现有 dev 用当前语音执行模型实测，并收敛抢先判断自然语言的规则；没有继续按句式增加补丁。16:41 的离线证据不能推断真实模型高错误率；其中确认词变体和建房否定/条件输入已改为交给现有模型。卡内确认的多任务定位问题未在本轮当前 Live 配置下实测，仍保留为有条件的离线发现，不宣称已解决。此前七项及 14:40 的 S1–S4 / F1–F3 是历史定位。用户允许建房“好 / 可以”的约定继续保留。

范围：工作区 `PROGRESS.md` 14:28 的三项补修及用户列出的七个遗留问题。固定基线为 `d2d42715a55768c9b10e4b1cb9e7cff14dab10fd`；功能仍在未提交工作区内，以进度记录限定本轮范围。旧十项问题及其修复记录见 [上一轮报告](maid-realtime-review-2026-09-24.md)。14:40 审查时未修改产品代码，15:15 已完成用户授权的修复。

## 17:10 当前配置实测与收敛实施

**环境与范围**：Windows PowerShell + 原 1430 dev WebView。读取到实时档 `gpt-live-1` / 后台 `gpt-5.6-luna`，执行选项为“语音执行”；普通女仆绑定 `vertexai / gemini-3.8-flash`。通过生产 `createVoiceAwareMaidRuntimeResolver` 选择语音档的真实 `gpt-5.6-luna` 客户端、现有女仆人格/全局提示、生产 planner 和 bounded 候选函数调用，没有替换模型、开关或凭证。

使用内存待确认清单及对应历史，从转写后的入口实测；模型确实调用当前服务。决策在业务工具执行前截停，清单不落盘。未进行麦克风输入、GPT-Live 音频传输/转写/播报、真实删除或建房，因此这是执行侧实测，不是完整实时通话验收。

| 输入 | 修改前的程序路径 | 当前模型的真实函数调用结果 |
| --- | --- | --- |
| 允许一次，但第二个别删 | 规则直接整单取消，planner 没有机会理解 | 改前模型单独预览选择能力检索，参数明确“保留第二个，只删除审查临时甲”；改后真实待确认入口先选择 `regex.list` 读取集合，没有直接删除 |
| 我没有确认 | 建房规则判 confirm，进入原清单 apply | 改前返回 clarify；改后返回 final，明确尚未确认、不创建 |
| 确认，跳过第二个 | 建房规则判 confirm，进入原清单 apply | 改前/改后均选择 `session.create`，`names=[甲, 丙]`、`open=false` |
| 好 | 低风险建房快捷确认 | 模型预览也选择甲、乙、丙全部三项；产品继续保留原快捷确认 |

这些样本未显示出需要新增语义词表的模型错误。删除样本仅验证到首次只读工具选择，不能据此宣称最终删除集合已经通过端到端执行验收；没有统计总体错误率。

**实施**：

- `maid-pending-action.js` 移除条件拆句规则及取消关键词的任意位置匹配，保留完整短口令匹配；其余完整原话由现有 planner 理解。
- `maid-imported-card-workflow.js` 移除宽泛确认搜索及条件/否定词黑名单，拒绝快捷口令完整匹配；“确认，按这个清单帮我建好房间”等自然表达也交给模型，不再由关键词决定整单 apply。
- 保留导入建房“好 / 可以”、删除预览/确认与目标快照；没有新增模型判别步骤、修改提示、重写任务路由或改动 `app.js`。

**证据及验证**：

- 修改前先运行真实 Agent 路由回归：期望 planner 收到“允许一次，但第二个别删”，实际 `[]`，测试失败。修改后原文完整进入 planner，且建房否定/条件没有提前进入 apply。
- Windows PowerShell 下 `maid-pending-action-tests.mjs`、`maid-realtime-task-tests.mjs`、`maid-assistant-agent-tests.mjs` 三组通过；没有重复全量测试。
- 改后在 dev 用真实模型复核删除条件、建房否定、建房跳过条件三个场景：`routePass=true`，`unexpectedApplyReads=[]`，`effectiveMode=provider_fc`，生成的工具参数均通过实际 schema 校验。脱敏结果见 `scripts/dev/tmp/maid-semantic-live-results-20260924.json`。
- 共 16 次模型规划调用。前 9 次预览因候选快照/模式尚未对齐走文本回退，仅作诊断，不计入最终函数调用路径结论；最终有效路径为改前 4 次和改后 3 次。临时探针保留在 `scripts/dev/tmp/`；临时 WebView 对象已移除，凭证没有写入报告或探针。
- 收尾读取 dev：`runtimeReady=true`、`errors=[]`。没有更换开发进程或数据档。

## 16:51 语义判断与执行约束的边界评估

结论：部分修复已过度承担自然语言理解，继续扩充确认、否定、条件词的正则不是合适方向。需要保留代码层的执行约束，但把原话的含义、条件和操作方案交给现有模型。

依据与上一轮结论的限制：

- [realtime-maid-tools.js:24](../src/scripts/ui/realtime/realtime-maid-tools.js#L24) 已要求模型将附带条件的回答作为 revise，并保留完整原话。16:41 的两个语音探针却人为传入带条件的 confirm，证明了这条兜底路径的错误，未验证真实模型在正常提示和上下文下会多频繁地产生这种调用。不能由此推断需要继续增加语义兜底。
- [maid-imported-card-workflow.js:114](../src/scripts/agent/maid-imported-card-workflow.js#L114) 在 Agent 调用 planner 前判断建房确认。这项错误是代码抢先解释了用户输入，不是模型理解失败；应减少此类抢先裁决，而非逐句增加黑名单。
- 任务定位属于独立的运行时契约：模型可以指定任务，代码负责核对该任务及待确认记录的关系；缺少明确目标时不应默默操作另一任务。上一轮错位路径的触发率未知，处理方向应是清晰的目标绑定，不是再加自然语言匹配。

建议分工：

- 模型结合完整原话、对话及待确认清单，决定确认、取消、修订、追问或新任务，并输出目标任务及完整条件。优先利用已有模型与结构化工具，不默认再增设一轮专门的确认分类模型。
- 代码维护任务/通话归属、目标快照、有效期、已消费状态、重复请求、中止和现有权限门禁；这些确定性约束无需等待模型错误率升高才维护。危险删除保留明确预览及确认机制，语义理解不再依赖持续扩张的句式词表。
- 后续语义优化以真实交互证据为依据：区分转写错误、上下文不足、模型选错 action/任务和运行时执行错位；针对实际重复出现的问题调整提示或工具契约，不以正则反例数量衡量交互可靠性。

本轮仅评估和修正文档。未修改产品代码、未运行新测试或真实模型；也未建议整体回退已验证的初始化、子代理配置、计量、目标锁定与取消修复。

## 16:41 再次复核

本轮固定基线仍为 `d2d42715a55768c9b10e4b1cb9e7cff14dab10fd`，没有新增提交；结合 `PROGRESS.md` 15:58 / 16:20 记录限定未提交工作区范围。使用 `git diff d2d4271 -- <相关路径>` 阅读改动，并直接读取新增未跟踪模块。仅审查，未修改产品代码。

### Standards：规范与调用链

未发现独立的 AGENTS 硬性违规。已确认 workflow 待确认任务定位修复生效；`withoutPendingAuthorization` 在修订和引用旧任务的新请求中移除了续接标记。仍有两项调用链遗漏：

1. **P2：正常许可变体仍会误取消整份清单。** [maid-pending-action.js:113](../src/scripts/agent/maid-pending-action.js#L113) 的条件前缀只识别裸“允许”等词，遗漏已支持的“允许一次 / 允许执行”。“允许一次，但第二个别删”落到第 122 行的取消兜底，整份预览被关闭，条件没有送往规划器。离线真实 workflow 复现：仅一次原始提交、没有修订提交，两个内存项目均保留，APP 确认次数为 0。建议条件判断覆盖现有合法确认词变体；这是误取消，未复现误删除。
2. **P2：卡内等待确认时，条件修订仍可能找错任务。** [maid-voice-task-runtime.js:121](../src/scripts/ui/maid-voice-task-runtime.js#L121) 只找 workflow 的 `awaiting_confirmation`，APP 卡内确认时任务仍为 `running`。A 等待确认、B 随后排队时，未指定 `task_id` 的条件 confirm 在第 127 行回退到最后一个任务 B。使用真实确认 runtime 的离线复现得到“打开设置\n\n用户修正：允许，但保留第二个”，被取消的是 B，A 的 APP 确认仍在。建议通过当前实际卡内确认定位任务，不只看 workflow 完成状态。明确的无条件允许仍能经 `confirmApproval` 找到卡内确认，不属于本问题。

### Spec：子代理与首次聊天实现

该审查分支没有发现确定缺口：

- 子代理确认从 Agent / registry context、子代理运行时、app 回调至确认 runtime，完整传递 signal 与 runId；取消能关闭确认，确认返回后的取消检查有效。
- 无可用主模型时显示“不执行”，拒绝返回取消结果；子档配置被删除且无主模型时返回对应提示，有主模型时保留回退；显式独立子档不变。
- 首次聊天通过闭包在调用时读取后赋值的 `hasConfiguredMaidProfile`，不再捕获初始假值函数。
- 配置读取后的取消信号继续传到真实 provider，请求入口处理已中止信号，取消后也不会转主模型。因此没有将“模拟 client 方法被调用”误报成真实请求已发送。

### 主审补充：建房确认

**P2：否定及附加条件仍会被当作整单同意。** [maid-imported-card-workflow.js:119](../src/scripts/agent/maid-imported-card-workflow.js#L119) 的否定规则不覆盖“没有确认”，第 123–124 行仍用任意位置的确认词匹配和有限条件词黑名单兜底。“我没有确认”“确认，跳过第二个”均返回 confirm。

实际 `createMaidAssistantAgent.runPrompt` 的离线复现中，两个输入均跳过 planner，直接进入原建房清单 apply 的角色卡复验。探针仅注册内存 `app.read_resource`，在首次复验返回缺失目标并停止于 `frozen_persona_scope_changed`；没有注册写工具，因此证据是错误进入执行链，不是绕过所有后续门禁。建议允许明确的短同意词和整句确认表达，其余带否定或额外指令的答复保留完整输入交给规划，避免继续扩展有限黑名单。“好 / 可以”作为低风险建房确认继续保留。

### 本轮验证与限制

- Windows PowerShell 下 `scripts/dev/tmp/review-maid-confirmation-1620.mjs` 与 `scripts/dev/tmp/review-maid-imported-conditions-20260924.mjs` 各运行一次，分别复现前两项和建房项；不重复进度中已通过的全量或专项套件。
- 读取现有 `http://127.0.0.1:1430` dev：`runtimeReady=true`、`bootErrors=[]`、无 Vite/致命错误层；未另开 dev，也未重载或新建数据档。
- 没有调用真实模型、修改用户数据或重新进行真实语音通话；服务商对原话的转写和 action 选择仍属于实际通话验收范围。

两条审查线计数：Standards 调用链 2 项 P2（无硬性规范违规）；Spec 子代理 / 首次聊天分支 0 项；主审建房确认补充 1 项 P2。

## 15:15 修复记录

1. **条件确认**：先核对原始转写与工具参数，带条件的 confirm 改为修订，停止旧操作、作废旧清单，携带原目标与完整条件重新规划。实际卡内确认通过中止信号拒绝，不会先批准再修订。模型将原话简化成“允许”也不能丢掉转写里的条件。
2. **跨来源确认**：普通文本裸确认排除语音清单；显式选定 submission 可以续接旧任务，带 callId 时仍必须匹配原通话。沿用冻结的房间与目标。
3. **重复确认**：同一清单记录续接任务，重复允许返回已有任务的状态与结果，完成后也不会再提交一轮失效确认；仍引用原任务 ID 时自动找到续接任务。
4. **思考兼容**：Anthropic 工具计划结合模型能力和实际 thinking 参数判断。没有思考能力的模型保持函数调用；真正手动思考的兼容限制继续生效。
5. **重试计量**：每次主档重试与备用调用各自记录 token、模型、耗时和调用次数；一次请求内累计 usage 回调只取最终快照，避免重复累加。回归中 3 × 110 + 220 正确记录为 550。
6. **子代理执行档**：完整抽出 `ui/maid-sub-agent-runtime.js`，先做依赖注入的等价迁移，再调整默认/失败回退到带任务 context 的实际执行档。独立子档继续使用自己的绑定，女仆主档未配置也不会提前拦截；未配置主档的运行时仍提供子代理目录。首次说明补充独立子档使用独立账号。
7. **当前角色卡**：省略 target 时优先读取交办房间的角色卡锁定；显式 target 仍优先。锁定目标已删除时停止，不误改全局卡。

**按用户要求保留**：导入建房的“好 / 可以”仍可确认，协议说明和运行时均保留这一例外；删除清单与权限卡维持明确授权要求。

**修复验证**：Windows PowerShell 下 10 组影响范围专项通过：maid-realtime-task、maid-pending-action、profile-update-tool、maid-model-planner、maid-provider-fc-planner-integration、maid-provider-fc-planner-utils、maid-sub-agent、maid-runtime-config、maid-assistant-agent、voice-task-model。补充原任务 ID 续接及导入清单修订取消边界后，仅重跑对应两组。新增用例使用真实确认 runtime、删除工具及内存数据；没有调用真实模型或修改用户数据。

i18n 目录生成、目录检查、源码与内容扫描通过；`app.js` 和新模块语法、相关 diff 空白检查通过。15:15 的 dev 烟测仅确认页面 complete 和 appBridge，缺少 runtimeReady 检查且致命层选择器不正确，因此当时启动正常的判断有误。真实通话仍需用户后续实测。

## 15:33 启动回归修复

用户报告 `Cannot access 'agentRegistry' before initialization` 后，在现有 dev 读到同一启动错误与 runtimeReady=false。子代理抽取将原本在任务执行时读取的 registry / 确认函数改成构建模块时读取，二者 `const` 尚未初始化；这属于本次拆分引入的回归。

修复将 registry 注入收窄为 `listEnabledAgents` 回调，确认函数也通过回调转发，恢复执行时读取。新增专项执行 `app.js` 的真实装配块并模拟相同的晚初始化依赖，修复前复现同一 ReferenceError，修复后通过，原有委派/拒绝/回退测试也通过。

Windows PowerShell 下通过 CDP 强制刷新现有 1430 dev，确认新一轮启动 4461ms 到达 done，runtimeReady=true，聊天 UI 可用，errors=[]，无 Vite/致命错误层。本轮只跑相关专项及必要语法/diff 检查，没有重复全量或调用真实 API。

## 最新三项补修

- **长答复：通过。** `maid-model-planner.js:1102/1140` 的文本 JSON 与纯文本最终答复均使用共同的 6000 字符上限；专项验证末条内容保留。
- **待确认清单归属：语音方向与指定任务过滤通过。** 删除和导入角色卡建房均调用 `isPendingRunInContext`，其他通话或不同 submission 的清单不会被该次语音确认消费。但没有 `voiceCallId` 的普通文本仍可匹配语音清单，见 S2。
- **含糊确认词：删除清单路径通过。** 语音“好 / 可以 / ok”等保留原待确认清单并要求明确答复；随后“允许”仍指向原清单。导入角色卡建房还未采用相同规则，见 R1。
- **i18n 内容扫描：通过。** 新增回复登记后，扫描结果为 0 new。

## Standards：规范与调用链

未发现独立的 AGENTS 硬性违规；本轮没有修改 `app.js`，不需要为了审查额外拆分。调用链确认以下四项行为缺口。

### S1 · 用户第 1 项 · 附带条件被当作完整授权：优先修

位置：[maid-voice-task-runtime.js:94](../src/scripts/ui/maid-voice-task-runtime.js#L94)、[同文件:100](../src/scripts/ui/maid-voice-task-runtime.js#L100)。

触发条件是语音服务商结构化调用 `maid_task(action=confirm)`，同时 request 带“允许，但保留第二个”。已有卡内确认会先执行 `confirmApproval(scope)`，尚未检查原话；若是待确认清单续接，则整句被规范化为“确认”。两条路径都会丢失条件。

真实确认 runtime 的内存复现能直接得到 allow；清单续接使用真实删除工具仍会经过一次 APP 确认，拒绝时零删除。不能泛称所有语音都会自动删除：GPT-Live 本地整句解析对该句返回 execute，不直接走上述 confirm 分支。

建议在任何授权发生前验证完整答复；带保留、排除等条件的答复应保留原话并修订清单，再重新确认，不能靠模型的 action 标签抹掉条件。

### S2 · 用户第 2 项 · 普通文本可确认旧语音清单：建议默认隔离

位置：[maid-pending-action.js:65](../src/scripts/agent/maid-pending-action.js#L65)。

`isPendingRunInContext` 只在输入 context 有 `voiceCallId` 时过滤。挂断后普通文本“确认”可消费仍在有效期内的旧语音清单，真实删除工具仍保留 APP 确认。通话进行中从输入框打字会带本通话 ID，不属于这个缺口。

建议裸“确认”只匹配当前交互来源；用户明确选定旧任务时允许跨模式续接。这样保留合法续接能力，同时避免把一句无指向的确认应用到旧通话。

### S3 · 用户第 3 项 · 快速重复确认的结果播报误导：同批顺手修

位置：[maid-voice-task-runtime.js:97](../src/scripts/ui/maid-voice-task-runtime.js#L97)。

首个确认续接任务尚未完成时，原任务仍标记 awaiting_confirmation，第二次“允许”会再次入队。内存复现实际仅执行一次删除、一次 APP 确认；第二个任务随后返回 cancelled / pending_action_unavailable，并播报“这份待确认清单已结束或过期，没有执行删除”，容易覆盖前一次成功的含义。

建议原任务记录正在续接的任务 ID；重复确认复用该任务的进行中/最终结果，不再提交第二个确认。属于状态与反馈问题，未复现重复删除。

### S4 · 用户第 7 项 · “当前角色卡”取错目标：优先修

位置：[profile-update-tool.js:42](../src/scripts/agent/tools/profile-update-tool.js#L42)。

省略 target 时，persona 始终调用全局 `getActive()`，没有按交办房间解析锁定卡。内存预览返回 global，房间实际锁定的是 locked；由此生成的后续确认与写入目标都可能错误。

建议显式 target 优先，其次按冻结的 `context.sessionId` 解析房间有效角色卡，再进入现有确认和执行前复验。不要仅换成执行时的当前房间。

## Spec：需求实现

### F1 · 用户第 4 项 · 不支持思考的模型无必要退出函数调用：低优先级，可同批修

位置：[maid-provider-fc-planner.js:411](../src/scripts/agent/maid-provider-fc-planner.js#L411)、[provider-fc-transport.js:1052](../src/scripts/agent/provider-fc-transport.js#L1052)。

用户选择“开启思考”被直接传作 thinkingEnabled，即使本地模型能力判定不支持、实际生成参数为 `{}`，仍触发 Anthropic 手动思考与强制工具调用的兼容拦截。

离线例子：`claude-3-5-haiku-20241022` 在本地 capability.supported=false，开关两态的 reasoningOptions 均为空；off 时工具计划可用，on 时返回 anthropic_manual_thinking_forced_tool_unsupported。任务可回退文本 JSON，但丢失原本可用的函数调用路径。

建议依据实际生成的 thinking 参数及能力判断兼容性，保留真正手动思考时的限制。

### F2 · 用户第 5 项 · 重试用量少计：建议修

位置：[maid-model-planner.js:147](../src/scripts/agent/maid-model-planner.js#L147)、[同文件:163](../src/scripts/agent/maid-model-planner.js#L163)、[同文件:192](../src/scripts/agent/maid-model-planner.js#L192)。

重试和转备用档时清空 capturedUsage，最后仅上报最终尝试的用量。触发条件是空正文等失败响应已经返回 provider usage；没有 usage 的纯网络失败不属于这里可证明的漏计。

离线复现：主档三次各 110 token、备用成功 220，本应记录 550，实际只记录 220；modelCallCount=4 正确。建议每次尝试保留最终 usage 并按实际模型分别计量；如果回调为累计值，应覆盖该尝试的快照，避免把同一请求的流式累计回调重复相加。

### F3 · 用户第 6 项 · 子代理门禁/回退仍依赖女仆主档：修接线，保留独立绑定

位置：[app.js:3602](../src/scripts/ui/app.js#L3602)、[同文件:3642](../src/scripts/ui/app.js#L3642)、[同文件:3706](../src/scripts/ui/app.js#L3706)。

并非所有子代理都使用女仆主档：显式子代理有独立 modelProfileId，沿用它是原设计。问题在于 generateWithSubAgent 在解析子档之前先要求女仆主档存在，默认执行、拒绝委派和委派失败回退也都使用这份主档。

离线复现：语音执行配置有效，明确指定已配置子档，但女仆主档未绑定，仍返回 maid_api_not_configured，读取子代理注册表次数为 0。

建议默认/回退使用带任务 context 的实际执行档；保留显式子档绑定，主档未绑定时也应能取得子档目录。首次语音说明中的“费用计入语音账号”应注明显式子代理独立配置的例外。

## 主审补充

### R1 · 导入角色卡建房仍把语音“好”当确认：用户确认保留

位置：[maid-imported-card-workflow.js:113](../src/scripts/agent/maid-imported-card-workflow.js#L113)、[maid-assistant-agent.js:4147](../src/scripts/agent/maid-assistant-agent.js#L4147)。

建房流程继续使用自己的 classifier，没有 voice 参数，仍将“好 / 可以”等判为 confirm。它在通用删除清单的 ambiguous 分支之前执行，所以上述最新修复仅覆盖删除。

只读内存探针在同一通话的有效建房清单后提交“好”：普通 planner 未调用，直接进入建房 apply 的角色卡复验；探针在第一次读取故意返回目标缺失，因而停止于 frozen_persona_scope_changed，没有注册或运行任何写工具。这个证据确认的是错误进入确认执行链，不代表绕过所有后续写入门禁。

审查时建议统一，但用户随后明确允许此类低风险操作宽松确认。本轮保留“好 / 可以”，仅对附带条件的结构化确认进入修订流程。

## 验证范围

Windows PowerShell 下仅运行一次以下检查，均通过：

- `node scripts/tests/maid-pending-action-tests.mjs`
- `node scripts/tests/maid-model-planner-tests.mjs`
- `node scripts/i18n/scan-hardcoded.mjs --scope=content`

另运行三份范围明确的内存探针各一次：

- `scripts/dev/tmp/review-maid-controls-20260924.mjs`：附带条件、跨来源确认、重复确认、锁定角色卡。
- `scripts/dev/tmp/spec-maid-open-issues-20260924.mjs`：实际思考参数、逐次 usage、子代理门禁。
- `scripts/dev/tmp/review-maid-imported-confirmation-20260924.mjs`：建房含糊确认进入执行复验。

未重复全量测试；未调用真实模型、未修改用户数据。真实语音转写及服务商对 action 的选择尚需后续通话验收。
