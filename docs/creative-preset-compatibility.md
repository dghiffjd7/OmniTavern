# 创意写作预设脚本兼容

支持 Kemini Dramatron 的脚本配置面板、主动生成诊断与正文工具传输，以及 Reborn 2.2 使用的 SPreset 工具绑定、消息后处理、输出预处理。实现按通用能力接入，不根据预设名称或动态函数名分支。

## 请求流程

1. APP 按当前写作会话、角色、预设、世界书和历史构建请求；冻结请求的模式、预设及用途。带 SPreset 设置的预设先在 Worker 里执行条目条件，决定本轮哪些条目启用。
2. ScriptRuntime 等当前脚本加载完成，在已有 Worker 内派发提示词／设置就绪事件，执行 SPreset 声明的消息后处理和工具绑定。
3. Worker 的虚拟生成请求经过原脚本安装的 `parent.fetch` 中间件，最后执行 SPreset 最终请求处理。APP 主窗口的 `fetch` 保持原样，真实网络、凭证、取消、供应方用量回调仍由 APP 管理。
4. 带 SPreset 设置的请求，设置档的提示词后处理及供应方兼容整理在脚本处理之后进行（同酒馆：先合并，后台再整理）；预设开了强制提示词后处理时，以预设的模式为准。
5. 供应方返回的文本／工具参数送回该请求的 Worker 流。Kemini 自己解码合成函数参数；SPreset 按配置消费工具参数，并执行 `buffer → output/hold` 处理。
6. 还原后的正文回到原有创意写作流式／存储／正则／表格／变量处理链。原生 reasoning 继续使用 APP 的独立事件，不混入正文。

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
| 脚本按钮／事件 | 提供 `getScriptId`、`getButtonEvent`、`appendInexistentScriptButtons`、`getScriptButtons`、订阅 `stop()`、`eventMakeFirst`，复用现有按钮投影与事件转发。脚本配置里声明的按钮（`button.buttons`，`button.enabled` 为假时不画、`visible: false` 的不画）在脚本载入时绘制，脚本再追加同名按钮不重复。导入时保留声明；早先导入的预设脚本在同步时按 ID 从预设自带的原始脚本补回（只读），导出预设时也写回。角色卡没留原始脚本，早先导入的卡要重新导入才有。 |
| 脚本变量 | 支持 `getVariables({type:'script'})` 与对象形式 `replaceVariables`；按脚本隔离，沿用修改变量权限。修复延迟数据保存读取错误对象导致清空的问题。 |
| `generate` / `stopGenerationById` | 复用 APP 上下文及真实生成服务，仅返回结果，不添加聊天消息；支持按调用脚本和生成 ID 取消，仍受脚本联网／读消息权限约束。 |
| `builtin.copyText` / `reloadAndRenderChatWithoutEvents` | 复用 APP 复制与当前会话刷新能力。 |
| `GENERATION_STARTED` / `GENERATION_AFTER_COMMANDS` | 创意写作发送、重新生成（`swipe`）、续写（`continue`）以及输入框的草稿预览（`dryRun: true`）在组提示词前依次派发，参数 `(type, {}, dryRun)`；等监听处理完（最长 30 秒）再组，脚本此时 `injectPrompts` 的内容赶得上本轮。监听出错只写调试日志，不拦生成。预设面板的场景预览本来就不跑脚本。 |
| `eventMakeLast` | 同 `eventOn`（新监听本来就排在最后），返回可 `stop()` 的订阅。 |
| `getWorldbookNames` / `getGlobalWorldbookNames` | 前者为全部世界书；后者改为 APP 真实的全局世界书（此前误返回全部）。 |
| `createWorldbook` / `createOrReplaceWorldbook` / `importRawWorldbook` | 每次写入都弹窗请用户确认（显示脚本名、世界书名、条数；覆盖现有世界书用危险样式）。条目先由酒馆助手格式转成酒馆原始格式，再走与导入文件相同的转换和同名覆盖检查。`createWorldbook` 遇到同名返回 `false`、不弹窗；`importRawWorldbook` 按去掉 `.json` 的文件名命名。用户拒绝时抛错；同一脚本的同一请求本次运行内不再弹窗，进行中的相同请求共用一个弹窗，多个弹窗依次出现。 |
| `rebindGlobalWorldbooks` | 只追加：名单里新出现的世界书经确认后加入全局；名单里没有的现有全局世界书保持不变（酒馆会解绑，APP 不让脚本改掉用户原有的全局设置）。 |

因此 Kemini 的“关闭自动保存”会只修改当前工作副本；开启自动保存时，原脚本随后调用命名写入才会持久化。脚本面板保持作者的原始内容，新增 SVG 节点兼容；普通变量／提示词快照更新不会再销毁面板和订阅。

Worker 面板投影按虚拟节点 ID 更新已有 DOM，文本输入不重建编辑框；textarea 的实时值通过标签内容传递。未确认的最新输入和中文输入法组合状态会保留，异步计数／按钮更新不会覆盖它们。真实 WebView 专项：`node scripts/tests/dev-script-ui-editing-cdp-smoke.mjs`。

## 兼容边界

- Reborn 样本关闭了 ChatSquash 合并，但开启消息后处理；已核对上游 SPreset 源码，该后处理应独立运行（收到消息数组）。
- ChatSquash 合并（2026-10-26，「小猫之神·喵赛亚」样本）：对照上游行为独立实现，未复制上游代码（上游无授权声明）。支持条件标签、各角色前后缀（含宏）、同角色换行接上、分隔符让该条单独成条、带图片或额外字段的消息原样保留、合并角色（含 `follow`）、system 当 user、停止字符；开合并时后处理收到合并后的整段文字，须返回文字。「仅合并聊天记录」「解析 clewd 标记」「重新拆分提示词」依赖酒馆内部结构，尚未支持，开启时明确报错。远程 SPreset 管理界面、酒馆后端和完整宿主 DOM 未移植。
- 最终请求处理与强制提示词后处理（2026-10-26，同一样本的 Vertex 用法）：最终请求处理在所有预设脚本之后、发出前执行，拿到 `request`、`provider`、`model`、`source`、`stream`、`preview`；须返回请求对象或原地修改后不返回，不能改 `stream` 和 `chat_completion_source`，出错时中止发送并报「SPreset 最终请求处理失败」。强制提示词后处理的 `''` 即不处理；APP 的后处理不区分 `*_tools` 变体，按同名模式处理。样本靠这两项把合并后的整段剧情放进 `context` 工具说明，最终只发 system + user，因此 Vertex 不会遇到「不支持以模型回合结尾」；样本的「user尾」条目由条目条件按模型名自动开关（见下条）；它没开时，样本自己的脚本会报「预期消息为三条」（酒馆中同样如此）。
- 条目条件（2026-10-26）：条目开了 `spreset_condition_enabled` 时，每次生成、组提示词之前在 Worker 里执行它的条件脚本，拿到 `model`、`provider`、`source`（酒馆来源名，如 `vertexai`、`makersuite`、`claude`）、`type`、`entry`、`chat`（按读消息权限，酒馆格式）；结果只决定这一轮是否启用，同时用于组提示词和工具绑定，不写回预设。返回非布尔值或报错时，该条目本轮不启用并提示「条目“…”条件执行失败，本次不启用」。预设脚本已授权、带 SPreset 设置的创意写作请求才执行。APP 的发送链不区分重新生成／继续等，`type` 目前一律为 `normal`。在酒馆里隐藏条目（`spreset_hidden`）只是界面差别，APP 仍显示这些条目。
- 主提示词在预设里关闭时，挂在它前后的对话指南、世界书桶仍放在它原本的位置，不再补到全部提示词之后（否则会排在预设的结尾提示词后面）。酒馆此时会丢弃这类内容，APP 选择保留。
- 生成前事件与世界书写入（2026-10-27，「剑仙187」样本）：该预设的创作指令全部由脚本运行时生成——脚本内嵌 810 条的「剑仙133_统一世界书」，用写入接口装好并设为全局，每次生成前按控制台的流派／文风从中编译约 2.8 万字，注入聊天深度 0。样本把 `dryRun` 当作静默请求跳过注入（酒馆同样如此），所以请求预览看不到它的注入，真实发送才有。确认框开着时若脚本重新加载（如 APP 启动时先后两次载入），旧实例的后续步骤会作废，样本要等下次载入或自己的「恢复」才继续设为全局。脚本声明的「剑仙187」按钮现已绘制；控制台（大型 jQuery 界面）在补齐下面的 Worker 页面兼容后可以打开、切换流派、关闭，「写入输入框」会把本轮输入包写进 APP 输入框。
- Worker 页面兼容（2026-10-27，为「剑仙187」控制台补齐，按通用能力实现）：
  - `$`：按集合工作（`find`／`closest`／`parent`／`children` 作用于全部元素并去重；`$(选择器, 上下文)`；`append`／`prepend` 接受 jQuery 对象）；新增 `first`／`last`／`eq(负数)`／`filter`／`is`／`add`／`map`／`toArray`／`hasClass`／`toggleClass(名, 状态)`／`after`／`before`／`insertBefore`／`insertAfter`／`appendTo`／`prependTo`／`replaceWith`／`detach`／`clone`／`toggle`／`stop`，`attr` 支持对象和 `null`；静态 `$.trim`／`$.each`／`$.extend`（含深合并）。
  - 事件按 jQuery 规则：命名空间（`click.ns`，可只按命名空间 `off('.ns')`）、委托（`on(类型, 选择器, fn)`，`this` 是匹配的子元素，`delegateTarget` 是绑定元素）、`one`、`trigger(类型, 参数)`、`click(fn)`／`click()` 等快捷方法；同一元素先跑委托再跑直接绑定，返回 `false` 等于阻止默认并停止冒泡（委托处理器停止后，该元素的直接绑定也不再执行）。
  - `MutationObserver` 由空壳改为真实报告子节点增删（`childList`，支持 `subtree`，微任务里批量回调；属性和文本变化不报告）；脚本重载时清空旧观察者。`ResizeObserver`／`IntersectionObserver` 仍是空壳。
  - 元素的 `ownerDocument` 默认为当前虚拟文档（解析出来、尚未挂上的子元素也有）。
  - 新增隐藏的 `#send_textarea`（不投影到界面）：平时跟随 APP 草稿；脚本写入时同步到当前会话的 APP 输入框（`ui.setInputText`）；生成前两个事件期间装着本轮发出的文字（重新生成／续写为空），正式发送后清空、预览不清，与酒馆的时机一致。
- `generate` 支持文本输入、历史数量、流式、生成 ID、部分上下文覆盖；`custom_api` 目前支持 OpenAI 兼容接口。图片、酒馆特有的全部 overrides 语义及精确 tokenizer 不在本次范围，不能把诊断当成与酒馆 Continue 完全等价。
- 提示词／设置就绪事件、生成前两个事件与现有接收事件可用。完整酒馆生成起止生命周期未模拟，Kemini 的被动“没有收到消息”推断器不启用；主动诊断及 APP 错误信息可用。
- 虚拟响应提供正文流，未复刻酒馆后端的所有 HTTP 状态／错误响应细节；原脚本基于真实酒馆 HTTP 响应做的被动错误归类不保证一致。实际供应方错误仍经 APP 生成接口返回。
- 本次没有用真实收费模型验证渠道能否减少截断。函数参数通道能否持续流式、能输出多少内容，仍取决于模型和接口。

## 验证

Windows PowerShell：`npm run test:creative-preset`。另外检查了预设作用域、正则运行时、取消、创意流式、现有 FC 传输与供应方工具参数适配测试。

当前 Windows dev 的原始 Kemini 脚本已验证面板显示、真实按钮切换后重载保持、临时提示词／正则不落盘、命名写回及复原、OpenAI 流式／非流式与 Gemini `partialArgs` 正文还原。Reborn 的真实 SPreset 配置已验证消息后处理、工具注入及 Unicode 输出。完整诊断生成链通过本机 HTTP 模拟供应方验证用量、正文与零聊天写入，临时测试绑定／设置在结束后恢复。

## Reborn 正文段落兼容修复（2026-09-22）

在原数据 dev 的 Reborn 历史候选回复中确认：原文与显示正则处理后的正文都有空行，但思维折叠的 HTML replacement 结束围栏直接接上模型的 `<game>` 标签，形成 ` ```<game>`。严格行尾围栏解析漏掉此边界，直到后面的行动卡片才闭合；正文被并入前一个 HTML 沙盒，浏览器合并了正文空白。

`splitFencedCodeBlocks` 现在仅对无语言或 HTML 围栏、且前方已是完整 HTML 文档的情况恢复这种粘连边界。使用已有文档扫描器排除 script / style / comment 内的伪闭合标签；不按预设名称或 `<game>` 专门分支，普通代码及未闭合文档保持原解析规则。修复在显示层生效，历史回复重新显示即可恢复，无需改动预设、重写聊天或重新生成。

最小回归先复现失败，修复后 `rich-text-renderer-fragment-tests.mjs` 全部通过；原历史显示副本和原文重新套用正则都恢复了正文独立段落，前后 HTML 卡片分开。`dev-rich-joined-fence-cdp-smoke.mjs` 用中性内容在 Windows WebView 验证 1100 / 390px 的三段正文、文本选择、摘要展开及两个独立卡片位置；测试不执行用户预设脚本或写入聊天。
