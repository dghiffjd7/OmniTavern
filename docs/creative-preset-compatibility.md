# 创意写作预设脚本兼容

支持 Kemini Dramatron 的脚本配置面板、主动生成诊断与正文工具传输，以及 Reborn 2.2 使用的 SPreset 工具绑定、消息后处理、输出预处理。实现按通用能力接入，不根据预设名称或动态函数名分支。

## 请求流程

1. APP 按当前写作会话、角色、预设、世界书和历史构建请求；冻结请求的模式、预设及用途。
2. ScriptRuntime 等当前脚本加载完成，在已有 Worker 内派发提示词／设置就绪事件，执行 SPreset 声明的消息后处理和工具绑定。
3. Worker 的虚拟生成请求经过原脚本安装的 `parent.fetch` 中间件。APP 主窗口的 `fetch` 保持原样，真实网络、凭证、取消、供应方用量回调仍由 APP 管理。
4. 供应方返回的文本／工具参数送回该请求的 Worker 流。Kemini 自己解码合成函数参数；SPreset 按配置消费工具参数，并执行 `buffer → output/hold` 处理。
5. 还原后的正文回到原有创意写作流式／存储／正则／表格／变量处理链。原生 reasoning 继续使用 APP 的独立事件，不混入正文。

仅 `uiMode=rp` 的普通回复与脚本 `generate` 请求可进入此链。聊天模式、女仆及其他任务请求不进入该传输。脚本与预设既有启用／授权设置继续生效；SPreset 的可执行配置也要求有已授权的预设脚本。虚拟请求不额外联网，任意脚本网络访问仍受原权限限制。

OpenAI Chat Completions／Responses、Anthropic 的工具参数统一映射到兼容响应；Gemini 保留原始 candidates，支持两份样本需要的 JSON 和字符串 `partialArgs`。不自动执行预设返回的任意函数。无法还原的工具调用、格式错误和处理器超时会明确失败。

## 设置与脚本接口

| 接口 | APP 行为 |
| --- | --- |
| `getPreset('in_use')` | 同步读取当前生效的提示词、开关、生成参数和绑定正则；按 `prompt_order` 排序，提供 `id`、`enabled`、`prompts_unused`。 |
| `getPreset(当前预设名称或 ID)` | 读取该预设的已保存版本。同步读取其他预设暂不支持，明确报错。 |
| `getPresetNames` / `getLoadedPresetName` | 返回预设名称列表／本会话实际使用的预设名。重名的命名写入拒绝执行，可使用 ID。 |
| `updatePresetWith('in_use', updater)` | 仅修改当前会话工作副本和局部正则开关，不写预设文件、导出数据或其他会话。离开会话、切换预设、重启 APP 后丢弃；正式编辑保存该预设时以保存版本为准。 |
| `updatePresetWith(名称或 ID, updater)` | 经原有 PresetStore 正式保存，同时同步绑定正则的开关。使用三方合并保留其他字段的并发修改，同字段冲突会报错。 |
| 脚本按钮／事件 | 提供 `getScriptId`、`getButtonEvent`、`appendInexistentScriptButtons`、订阅 `stop()`、`eventMakeFirst`，复用现有按钮投影与事件转发。 |
| 脚本变量 | 支持 `getVariables({type:'script'})` 与对象形式 `replaceVariables`；按脚本隔离，沿用修改变量权限。修复延迟数据保存读取错误对象导致清空的问题。 |
| `generate` / `stopGenerationById` | 复用 APP 上下文及真实生成服务，仅返回结果，不添加聊天消息；支持按调用脚本和生成 ID 取消，仍受脚本联网／读消息权限约束。 |
| `builtin.copyText` / `reloadAndRenderChatWithoutEvents` | 复用 APP 复制与当前会话刷新能力。 |

因此 Kemini 的“关闭自动保存”会只修改当前工作副本；开启自动保存时，原脚本随后调用命名写入才会持久化。脚本面板保持作者的原始内容，新增 SVG 节点兼容；普通变量／提示词快照更新不会再销毁面板和订阅。

Worker 面板投影按虚拟节点 ID 更新已有 DOM，文本输入不重建编辑框；textarea 的实时值通过标签内容传递。未确认的最新输入和中文输入法组合状态会保留，异步计数／按钮更新不会覆盖它们。真实 WebView 专项：`node scripts/tests/dev-script-ui-editing-cdp-smoke.mjs`。

## 兼容边界

- Reborn 样本关闭了 ChatSquash 合并，但开启消息后处理；已核对上游 SPreset 源码，该后处理应独立运行。完整 ChatSquash 合并尚未实现，开启时会明确提示。远程 SPreset 管理界面、酒馆后端和完整宿主 DOM 未移植。
- `generate` 支持文本输入、历史数量、流式、生成 ID、部分上下文覆盖；`custom_api` 目前支持 OpenAI 兼容接口。图片、酒馆特有的全部 overrides 语义及精确 tokenizer 不在本次范围，不能把诊断当成与酒馆 Continue 完全等价。
- 提示词／设置就绪事件与现有接收事件可用。完整酒馆生成起止生命周期未模拟，Kemini 的被动“没有收到消息”推断器不启用；主动诊断及 APP 错误信息可用。
- 虚拟响应提供正文流，未复刻酒馆后端的所有 HTTP 状态／错误响应细节；原脚本基于真实酒馆 HTTP 响应做的被动错误归类不保证一致。实际供应方错误仍经 APP 生成接口返回。
- 本次没有用真实收费模型验证渠道能否减少截断。函数参数通道能否持续流式、能输出多少内容，仍取决于模型和接口。

## 验证

Windows PowerShell：`npm run test:creative-preset`。另外检查了预设作用域、正则运行时、取消、创意流式、现有 FC 传输与供应方工具参数适配测试。

当前 Windows dev 的原始 Kemini 脚本已验证面板显示、真实按钮切换后重载保持、临时提示词／正则不落盘、命名写回及复原、OpenAI 流式／非流式与 Gemini `partialArgs` 正文还原。Reborn 的真实 SPreset 配置已验证消息后处理、工具注入及 Unicode 输出。完整诊断生成链通过本机 HTTP 模拟供应方验证用量、正文与零聊天写入，临时测试绑定／设置在结束后恢复。

## Reborn 正文段落兼容修复（2026-09-22）

在原数据 dev 的 Reborn 历史候选回复中确认：原文与显示正则处理后的正文都有空行，但思维折叠的 HTML replacement 结束围栏直接接上模型的 `<game>` 标签，形成 ` ```<game>`。严格行尾围栏解析漏掉此边界，直到后面的行动卡片才闭合；正文被并入前一个 HTML 沙盒，浏览器合并了正文空白。

`splitFencedCodeBlocks` 现在仅对无语言或 HTML 围栏、且前方已是完整 HTML 文档的情况恢复这种粘连边界。使用已有文档扫描器排除 script / style / comment 内的伪闭合标签；不按预设名称或 `<game>` 专门分支，普通代码及未闭合文档保持原解析规则。修复在显示层生效，历史回复重新显示即可恢复，无需改动预设、重写聊天或重新生成。

最小回归先复现失败，修复后 `rich-text-renderer-fragment-tests.mjs` 全部通过；原历史显示副本和原文重新套用正则都恢复了正文独立段落，前后 HTML 卡片分开。`dev-rich-joined-fence-cdp-smoke.mjs` 用中性内容在 Windows WebView 验证 1100 / 390px 的三段正文、文本选择、摘要展开及两个独立卡片位置；测试不执行用户预设脚本或写入聊天。
