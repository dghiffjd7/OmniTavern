# 2026-09-23 性能优化及同批变更审查

审查时间：2026-09-23 21:17 CST（UTC+8）。

范围：`d2d42715a55768c9b10e4b1cb9e7cff14dab10fd`（2026-09-22 23:45）至当前工作区，包含未跟踪的新模块。比较命令为 `git -c core.autocrlf=false diff d2d4271 -- <paths>`；本轮没有新增提交。性能行为要求取自工作区根目录 `PROGRESS.md` 当日记录，规范取自根目录 `AGENTS.md`。

审查结论：确认 1 处性能相关回归，以及同批新功能的 3 处问题。审查阶段未修改产品实现或用户数据。

## 2026-09-23 22:11 CST — 字形边界补齐

22:05 复查发现的三个显示边界已一起修复：ASCII 字母/数字会吸收自身的组合符；表情统一吸收组合符，覆盖 VS15 和 VS16；英文词在键帽数字前停止，将完整键帽交给表情分支。

沿用现有正则分词和大文本降级逻辑，不改变原文的 Unicode 序列。新增用例覆盖分解重音、词尾重音、两种变体符互换、英文/数字前缀相邻键帽，以及不带 VS16 的键帽。修复前用例按预期失败，修复后 `word-diff-utils-tests.mjs`、`code-viewer-ui-utils-tests.mjs`、`text-diff-view-utils-tests.mjs` 三组通过。

现有 Windows dev 中，使用未挂载的 DOM 核对三个原始复现场景的合并、旧文、新文视图，共 9 项通过；原文和新文均可原样还原。未修改用户数据。

## 2026-09-23 22:05 CST — 22:00 小修复查

本次只复查 21:43 修复完成后、22:00 进度条目对应的增量：女仆目标账本、字词差异和两份专项测试。没有新增 git 提交，以前一轮代码和进度记录辨认变化，没有重新审查全部未提交功能。

**功能轴：1 项修复未完整，未确认其他新增回归。**

- 位置：`src/scripts/utils/word-diff-utils.js:10`、`:12`。
- ASCII 分支 `[A-Za-z0-9_]+` 没有连同后面的组合符一起匹配，也会先吞掉紧邻英文的键帽数字；表情分支只包含 VS16，遗漏 VS15。
- 单次离线探针复现：`e\u0301 → e\u0300` 只高亮附加重音，`❤\uFE0E → ❤` 只高亮不可见的变体符删除，`step1️⃣ → step2️⃣` 将键帽组合符留在差异标签之外。
- 这属于 22:00 声明的“完整字形”要求尚未覆盖完整，并非相对 21:43 新引入；影响差异显示，不会改写原始正文。现有 `é → è` 测试使用预组合字符，无法覆盖分解形式。

女仆的资源分类与真实 `app.read_resource` 返回值规范化、步骤输出解包契约一致；删除去重、重复计数和最终结果的资源隔离未发现新的高置信问题。深层子树与节点总数上限的区别处理已核对。

**规范轴：0 项明确违规。**

本轮在 Windows PowerShell 各运行一次 `maid-run-target-ledger-tests.mjs` 和 `word-diff-utils-tests.mjs`，均通过；未重复运行全量测试。只做审查和记录，未修改产品实现或用户数据，以上字形边界仍待修复。

## 2026-09-23 21:43 CST — 修复完成

用户确认后已修复以下 4 项，原审查内容和定位保留在后文（行号为修复前位置）。

- 消息深度：ChatStore 为原地角色/ID 修改提供结构版本，显示缓存据此失效；正文流式更新不增加版本，常规缓存命中不扫描整段历史。未提供版本的可变数据源核对 ID、计数角色与顺序快照。`app.js` 仅增加已有解析器的一项依赖注入，未另建包装模块。
- 女仆任务结果：先按顺序归纳各写入目标的当前已验证状态，再判断是否可豁免末步重复失败。另一个失败目标、或中间已改变过的目标状态，都不能被历史成功掩盖。
- 删除幂等：区分精确 ID 与名称；名称须在同类资源输出中唯一对应被删除 ID。重名、同名对象重新创建、别名扫描不完整时交回工具正常解析；正常的 ID/名称重复删除仍可复用结果。
- 字词差异：按 Unicode 码点分词，避免 UTF-16 代理对被拆到不同 HTML 节点。

回归用例已加入原有的 `message-display-depth-utils-tests.mjs`、`maid-run-target-ledger-tests.mjs`、`word-diff-utils-tests.mjs`。修复前用例按预期失败；修复后通过，包括实际 ChatStore 更新路径和实际女仆 agent 入口（模拟工具、无真实模型调用）。

受影响范围验证通过：上述 3 组测试，以及 `maid-assistant-agent-tests.mjs`、`feedback-073-app-tests.mjs`、`chat-store-format-repair-envelope-tests.mjs`、`code-viewer-ui-utils-tests.mjs`、`text-diff-view-utils-tests.mjs`，共 8 组；`app.js` 语法检查通过。

现有 Windows dev 的 WebView2 中，用临时消息和未挂载的 DOM 验证了角色改变后的深度，以及表情/扩展汉字的合并、旧文、新文差异渲染；全部通过。运行中的应用已加载新的结构版本 API。未修改用户数据、调用真实模型 API 或运行全量测试。

## Spec — 功能一致性

### 1. [P2] 消息角色变化后，显示深度缓存仍使用旧索引

- 位置：`src/scripts/ui/chat/message-display-depth-utils.js:44`。
- 性能相关：是。
- 要求：`PROGRESS.md` 17:22 条目要求按整个会话计算正则显示深度，只计入 user / assistant 消息。
- 根因：缓存只检查消息数组引用、长度与末条 ID。脚本 `setChatMessages` 可修改角色（`src/scripts/plugins/script-runtime.js:7117`），而 `ChatStore.updateMessage` 原地替换数组元素（`src/scripts/storage/chat-store.js:2875`），不会改变上述缓存条件。
- 复现：先解析 `[assistant older, user last]`，得到 `[1, 0]`；保持 ID 和条数不变，将 last 改成 system，再解析同一会话，得到 `[1, undefined]`，正确结果应为 `[0, undefined]`。单次离线 probe 已复现。
- 影响：后续重绘仍会把实际最新的对话消息视为旧消息，`maxDepth=0` 等显示正则可能漏用或错用，直到缓存重建。
- 修复方向：使计数相关的角色变化或消息顺序变化也能使缓存失效，保留分批加载时按整个会话计算的行为。

### 2. [P2] 女仆重复执行已成功操作，会掩盖另一个未完成目标

- 位置：`src/scripts/agent/maid-run-target-ledger.js:231`；整体任务结果使用点为 `src/scripts/agent/maid-assistant-agent.js:4908`。
- 性能相关：否，属于同批“按目标判定”功能。
- 要求：`PROGRESS.md` 20:34 条目要求按目标最终状态判断，只豁免已完成目标的多余重复。
- 根因：`redundant_repeat` 分支只要找到末步操作曾成功，就立即将整个任务判为成功，没有核对其他失败目标。
- 复现：要求停用 A 和 B；A 成功、B 失败、再次停用 A 失败，然后模型结束。通过实际 `createMaidAssistantAgent.runPrompt`、模拟规划器和工具执行器的一次离线集成 probe，结果为 `ok: true`、`status: succeeded`、`outcomeReason: redundant_repeat`，B 从未成功。
- 影响：任务卡和活动记录会显示成功，实际仍有用户要求未完成。基线代码在这条失败末步路径上会保留失败状态。
- 修复方向：豁免重复失败后仍检查其余写入目标，不能直接提升整个任务结果。

### 3. [P2] 删除账本按名称复用，会跳过另一个同名对象

- 位置：`src/scripts/agent/maid-run-target-ledger.js:58`；拦截工具调用的位置为 `src/scripts/agent/maid-assistant-agent.js:4398`。
- 性能相关：否，属于同批删除幂等功能。
- 要求：`PROGRESS.md` 20:34 条目要求同名多 ID 不合并，只跳过本轮确已删除的目标。
- 根因：删除账本直接将结果中的名称与 ID 都记为“已删除”，按名称查账时不检查当前对象身份，也不使用另一个别名表中“同名多 ID 不映射”的保护。
- 复现：两个规则集 ID 为 set-a、set-b，名称均为“同名”。按 ID 删除 set-a 成功，再列出仍存在的 set-b，随后按名称删除“同名”。单次离线 probe 确认 `findAlreadyDeletedTargets` 将该请求全部认作已删除，`remaining` 为空。接入点因此跳过真实工具调用。正常工具此时会按唯一名称解析到 set-b。
- 影响：set-b 留在存储中，女仆却返回“已删除，无需重复”。删除后重新创建同名对象也会受到同一账本逻辑影响。
- 修复方向：以实际目标身份和作用域判断幂等，名称别名必须考虑重名与对象重建。

### 4. [P3] 逐词差异拆开代理对，表情与部分生僻字显示损坏

- 位置：`src/scripts/utils/word-diff-utils.js:8`。
- 性能相关：否，属于同批逐词差异功能。
- 要求：`PROGRESS.md` 20:34 条目要求逐词/逐字标出改动；展示应保持原字符完整。
- 根因：分词正则只有 `g` 标志，非 BMP 字符被拆成 UTF-16 两个码元。比较共享高位代理的两个表情时，高位被当作未修改文本，低位分别放进 `<del>` / `<ins>`。
- 复现：`renderWordDiffHtml(diffWords('表情😀', '表情😁'))` 产生跨 HTML 标签的断裂代理对；单次离线 probe 中 `html.isWellFormed()` 为 false。
- 影响：格式修复、文本润色、预设等差异视图可能显示替代字符；原始正文并未因此被改写。
- 修复方向：至少按 Unicode 码点分词，避免代理对跨越差异标记。

## Standards — 工程规范

本次未发现高置信的规范硬违规或值得单独报告的判断性代码异味。已核对进房刷新抑制与历史恢复、合并重渲染的会话/版本保护、状态胶囊生命周期、贴纸观察器清理、主题样式切换，以及 Rust 日志截断和 dev 配置。

## 验证与边界

Windows PowerShell 下运行以下专项测试，各一次，均通过：

- `node scripts/tests/app-session-refresh-runtime-utils-tests.mjs`
- `node scripts/tests/theme-dark-rule-pruner-tests.mjs`
- `node scripts/tests/agent-center-status-chip-tests.mjs`
- `node scripts/tests/native-console-bridge-tests.mjs`

上述 4 个问题均有最小离线复现；女仆错误成功判定额外经过实际 agent 入口。后三项复现集中于被忽略的临时脚本 `scripts/dev/tmp/review-root-regressions.mjs`，仅使用模拟数据，该脚本按预期返回失败以证明当前回归。

通过现有 dev 的只读 CDP 检查，确认浅色模式三组 CSS 副本正确启用，保留规则与原表逐条一致。没有切换用户主题、启动额外 dev、调用真实模型 API 或修改应用存储。

预设分片并发读取、只读引用与副本边界、指纹缓存、正则筛选后复制、模板防重复写入、记忆快照更新通知、iframe 尺寸观察器等已进行代码路径核对，未发现可证明的其他回归。未重复运行全量测试，也未进行 Rust 全量构建或所有页面的完整交互回归，因此不能据此保证所有场景均无问题。

规范轴发现 0 项；功能轴发现 4 项，最高为 P2，其中 1 项直接涉及性能优化。
