# Realtime 多服务商与自定义声音

实现日期：2026-09-06，更新：2026-09-09。代码与 Windows 离线验证已完成；Gemini 已验证真实音频收发，Step 国际入口已验证鉴权与模型刷新（当时账户余额为零，通话返回 402）。其余真实云端通话、付费复刻及 Android 真机验收尚未完成。

## 悬浮通话药丸

拨号后先打开居中的通话窗，显示头像、实时声纹、字幕与通话控制。点击右上角最小化或拖动头像区域即可收起；拖到顶部吸附成短药丸，拖到左右边缘吸附成较大的头像球。点击悬浮控件或原拨号按钮，重新展开通话窗。

- 展开时居中，收起恢复上次吸附边与高度。悬浮时聊天区域可继续操作；展开时点击背景收起，结束按钮负责挂断。支持鼠标、触屏、安全区、窗口缩放与手机键盘可视区域变化；取消拖动恢复原形态和位置。
- 键盘 Enter / 空格展开，Esc 收起；Alt + 左右方向键吸附到两侧，上下键调整高度，Alt + Home 回到顶部。展开时焦点限制在通话窗内，最小化和结束恢复可用焦点。字幕和角色名保留原文。
- 声纹与头像光晕由麦克风和实际播放音频驱动，各自服从静音状态。`realtime-audio-meter.js` 每 40 ms 采样，只保留当前音量和九段频谱；独立回调传递到 UI，音频样本和高频事件均不写入日志/聊天。分析分支经过零增益输出，保持 WebView2 音频时钟运行并避免重复播放；音频采样不可用时通话继续运行。减少动态效果设置使用静态显示。
- 静音、连接提醒有紧凑标记；AI 语音说明放入标题帮助，用量折叠查看。结束、自动结束及页面退出会释放浮层、观察器、监听和采样定时器；OpenAI 的独立分析上下文也会关闭。原有切会话和进入后台的终止规则保留，悬浮范围是应用窗口。

界面、位置、音量采样分别由 `realtime-call-panel.js`、`realtime-call-floating-position.js`、`realtime-audio-meter.js` 承接，应用运行时连接回调。2026-09-09 Windows 定向检查覆盖配置/旧设置 KV 恢复、通话运行时、两类客户端、装配、浮层和采样释放；开发 WebView 分段验证真实 Web Audio 合成信号、鼠标/触屏拖动、顶部/侧边切换、键盘、字幕安全、390/320px、短横屏和深浅色。截图位于忽略目录 `scripts/dev/tmp/realtime-pill/` 和 `scripts/dev/tmp/realtime-call-v2/`。本次真实模型请求及用户设置写入为零；Android 真机和云端语音听感仍待验证。

## 通话语言

实时设置档及旧 OpenAI 配置的“回复语言”使用可输入选单：点击输入框右侧箭头，选择常用语言或“自动（跟随对话）”；也可直接填写语言/口音。沿用 App 选单样式，支持鼠标、手机点按与滚动，键盘方向键选择、Enter 确认、Esc 收起。打开或取消选单保留自填内容，选择自动则清空语言偏好。保存后下次通话生效，复制设置档保留偏好，角色绑定沿用对应设置档的语言。

回复语言通过通话指令引导，覆盖原生会话初始化、续接和 OpenAI 每轮上下文刷新；实际支持范围与发音效果取决于模型和音色。Gemini 原生音频自动识别语言，官方建议用系统指令约束回复语言，未发送其不支持的 `languageCode`。[Gemini 说明](https://ai.google.dev/gemini-api/docs/live-api/capabilities)、[OpenAI 语言与口音指令](https://developers.openai.com/api/docs/guides/realtime-models-prompting#control-language-and-accent-separately)。

OpenAI 设置档另有独立的“输入识别语言”，传给输入转写模型；其余现有接入继续由服务商自动识别。Nova 的默认候选仅列部分支持语言，模型限制继续见模型标题帮助。说明采用标题悬停/手机点按帮助。

## 使用入口

**API 设置 → 语音模型 → 实时通话 → 新建设置档**。

支持命名、复制、删除多个设置档，点击“保存并使用”才切换全局配置。服务商、凭证、模型、区域与声音在下次拨号时固定，通话中编辑设置不会改变正在运行的连接。

原 OpenAI 配置保留为“沿用原 OpenAI 配置”，继续使用旧设置档的 Key 引用、模型、输入转写语言、回复语言、VAD 和截断设置；没有自动复制旧 Key 或清除旧设置。

| 服务商 | 内建模型 | 凭证/声音 |
| --- | --- | --- |
| OpenAI | gpt-realtime-2.1 | API Key；也可继续使用旧引用式配置 |
| Gemini Live | AI Studio：gemini-3.1-flash-live-preview、gemini-2.5-flash-native-audio-preview-12-2025；Vertex：gemini-live-2.5-flash-native-audio | 同一服务商内选择 Gemini API / Vertex AI；保留 Kore 等声音 ID 的大小写 |
| 豆包 Realtime | O2.0=1.2.1.1、SC2.0=2.2.0.0 | App ID + Access Token；系统声或 S_ 克隆声 |
| Qwen Audio Realtime | qwen-audio-3.0-realtime-plus / flash | API Key、区域、可选 Workspace ID；系统声或与目标模型绑定的克隆声 |
| StepAudio Realtime | stepaudio-2.5-realtime | 中国大陆 / 国际版站点、对应 API Key；系统声或自定义 Voice ID |
| xAI Grok Voice | grok-voice-think-fast-2.0 | API Key；系统声或已创建的自定义 Voice ID |
| Nova 2 Sonic | amazon.nova-2-sonic-v1:0 | AWS Access Key ID、Secret Access Key、可选 Session Token、区域 |

这些是内建默认值，不代表已联网确认当前账号具有权限。模型字段支持手动输入；Nova 校验 Sonic 模型 ID 格式，豆包校验四段版本号，并按 SC2 系列检查声音与请求参数。

## 模型填写与刷新

与文本模型配置一致：新建设置档默认填入模型名称，点击“刷新列表”显示可选模型；点击候选即可填写，也可以直接手动输入。刷新使用当前表单中的凭证、接入方式、区域与 Workspace，无需先保存；不会覆盖当前模型或自动保存凭证。

- OpenAI、Gemini AI Studio / Vertex 完整模式、Qwen Audio、StepAudio、xAI、Nova 支持在线查询并筛选对应实时通话模型。Gemini / Vertex / Qwen 处理分页；Nova 使用区域 Bedrock `ListFoundationModels` 和 AWS SigV4。
- 豆包和 Vertex Express 当前没有接入适用的在线目录查询，点击刷新会明确提示并显示内建候选，仍可手填。
- 失败、空目录或取消保留原模型和已加载候选；更换凭证、区域或接入方式会清除旧候选。列表不会写入持久化存储，关闭设置页会取消请求。
- 手填的新模型和版本会传给服务商；声音兼容检查仍生效。Qwen 克隆声音继续绑定创建时的目标模型；豆包 `2.*` 使用 SC2 的角色字段与声音系列。目录列出模型不等于真实通话已经验证。

Nova 模型查询所需 AWS 签名使用 `@smithy/signature-v4` / `@aws-crypto/sha256-js`，通过 `npm run build:realtime-deps` 生成约 20 KB 的本地 ESM 到 `src/vendor/realtime/`，安装包无需从 CDN 加载。依赖许可证随文件附带；`npm run build` 的 prebuild 会重新生成。目录接口依据：[百炼 Models](https://help.aliyun.com/zh/model-studio/list-models)、[Step Models](https://platform.stepfun.com/docs/zh/api-reference/models/list)、[xAI Models](https://docs.x.ai/developers/rest-api-reference/inference/models)、[Bedrock ListFoundationModels](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html)。

## Gemini Live 的 AI Studio / Vertex AI 选择

服务商保持 **Gemini Live**，新增“Gemini Live 接入方式”：

- **Gemini API (AI Studio)**：填写 AI Studio API Key；旧 Gemini Live 设置默认保留此方式。
- **Vertex AI → 完整模式（Service Account）**：粘贴 Google Cloud Service Account JSON，选择区域（默认 `us-central1`）。Project ID 留空时从 JSON 识别，也可以指定已授予此服务账号访问权限的项目。使用项目额度；需启用 Vertex AI 并授予对应模型调用权限。
- **Vertex AI → Express 模式（API Key）**：填写 Vertex 专用 Express API Key，无需项目或区域；实际模型权限以账号为准。

切换平台会更新模型候选和默认模型。Vertex Live 的模型名称、区域列表与 AI Studio 或文本 Vertex 配置不同，不直接沿用文本默认的 `global`。当前内建 Vertex 模型为 `gemini-live-2.5-flash-native-audio`；系统声音和角色绑定保持同一套入口。

Gemini API 与 Vertex 共用完整 30 个官方 Live 音色，默认仍为 `Kore`，保留 Voice ID 大小写及已保存的声音选择。来源：[Vertex Live 音色列表](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/configure-language-voice#voices_supported)、[Gemini Live 音色说明](https://ai.google.dev/gemini-api/docs/live-api/capabilities#change-voice-and-language)。

## StepAudio 的中国大陆 / 国际版选择

服务商保持 **StepAudio Realtime**，在“Step 接入站点”选择 **中国大陆（stepfun.com）**或**国际版（stepfun.ai）**。按 Key 注册站点选择，账号与 Key 不互通；不是按电脑所在地自动切换。模型刷新、实时 WebSocket、文件上传及声音克隆统一使用所选站点，Key 只在 Bearer 请求头传递。

国际版使用 `https://api.stepfun.ai/v1/models`、`wss://api.stepfun.ai/v1/realtime`、`https://api.stepfun.ai/v1/files` 和 `https://api.stepfun.ai/v1/audio/voices`。中国大陆对应 `.com`。旧 Step 配置及旧克隆记录的空区域按中国大陆兼容；国际站点在内部区域字段保存为 `global`，不表示通用云区域。

切换站点清除旧模型候选并更新声音列表。已知不兼容的系统声替换为新站点的默认音色；共同支持的系统声、手填未知 ID、自定义 Voice ID 保留。克隆记录保留原账号和站点，跨站点调用会明确拒绝；角色旧绑定引用不兼容的系统声时要求重新选择并检查绑定，不会默默改成其他音色。

2026-09-07 实测：同一国际 Key 请求 `.com/v1/models` 返回 401，请求 `.ai/v1/models` 返回 200，筛选出 `stepaudio-2.5-realtime`。原生国际通话握手返回 402，账户接口确认 `prepaid`、`balance: 0`。模型可查询不代表账号已有通话余额；界面区分 Step 的站点/Key 401 与余额不足 402。

依据：[官方两站点说明](https://github.com/stepfun-ai/Step-Realtime-CLI/blob/main/README_CN.md)、[国际版模型目录](https://platform.stepfun.ai/docs/en/api-reference/models/list)、[国际版 Realtime 与七个音色](https://platform.stepfun.ai/docs/en/api-reference/realtime/chat)、[国际版声音克隆](https://platform.stepfun.ai/docs/en/api-reference/audio/create-voice)、[官方错误码](https://platform.stepfun.ai/docs/en/api-reference/error-codes)。

## 音色浏览与目录核对（2026-09-07）

音色选择采用与模型候选一致的可点击卡片列表，提供独立搜索框；按名称、ID、性别、特点或语言过滤，不会把搜索词写成选中的声音。卡片显示简短信息；桌面悬停/键盘聚焦显示详情浮层，手机点选后在列表下方显示相同详情。声音 ID 可手填，保存后下次通话生效。未知或手填 ID 保留并明确提示不在当前候选中；自定义声音仍走现有登记与模型/账号兼容检查。

| 服务商 / 模型 | 当前内建数量 | 核对与补齐 |
| --- | ---: | --- |
| OpenAI Realtime | 10 | 与官方列表一致；Marin / Cedar 标为官方推荐。官方未提供的性别/特点不猜测 |
| Gemini Live / Vertex | 30 | 补充中文特点；性别依据 Google 官方 Gemini 同名音色表 |
| 豆包 O2.0 | 7 | 四个中文声音，以及 Tim / Dacey / Stokie 三个美式英语声音；O1 保留四个中文 |
| 豆包 SC2.0 | 21 | 补齐 `saturn_` 角色音色，与 O 系列区分 |
| Qwen Audio Realtime | 5 | 官方实时列表就是五个；没有加入 Qwen TTS 的其他音色 |
| StepAudio 2.5 Realtime 中国大陆 | 34 | 根据国内 Realtime 参数文档直接链接的官方音色表补齐；旧 `step-audio-2` / `step-audio-2-mini` 分别显示四个 / 两个 |
| StepAudio 2.5 Realtime 国际版 | 7 | 按国际版 Realtime 明确允许的七个 ID 显示，默认 `soft-spoken-gentleman`；不包含国内默认 `qingchunshaonv` |
| xAI Grok Voice | 28 | 依据最新 Voice Overview；可用 API Key 在线刷新官方音色目录 |
| Nova 2 Sonic | 16 | 补齐法/意/德/西/葡语和印度声音；Kiara / Arjun 的两种语言共用 ID，不重复计数 |

- xAI 刷新使用官方 `GET /v1/tts/voices`，此接口明确说明返回 ID 也适用于 Realtime。刷新使用当前设置档凭证，失败保留列表及选择，切换凭证清除查询结果，关闭面板取消原生请求。旧内建 `Ara` 等大写值可匹配新小写目录；不改写已保存值，不对克隆 ID 做大小写归一化。
- 其余服务商当前使用已核对的内建目录。Step 的 `system_voices` 查询接口目前仅声明支持 `step-tts-2`，因此没有把它当作实时音色在线查询。实时音色支持范围以具体模型和账号实际响应为准。
- Gemini 特点来自 Live 文档；性别来自 [Google Gemini-TTS 官方同名声音表](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts#voice_options)，Live 官方说明支持这些 TTS 声音。Qwen 的四个具名音色特征来自同名 [Qwen-Audio-TTS 声音表](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list)，实时支持名单单独按 [Realtime 文档](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides)限定；`longanqian` 未找到官方性别描述，保留未标注。豆包角色中文名按官方 Voice ID 作可读展示。
- 其他核对来源：[OpenAI Realtime 声音](https://developers.openai.com/api/docs/guides/realtime-conversations#voice-options)、[豆包实时文档](https://www.volcengine.com/docs/6561/1594356)、[Step Realtime 参数](https://platform.stepfun.com/docs/zh/api-reference/realtime/chat)、[Step 官方音色表](https://platform.stepfun.com/docs/zh/guide/tts)、[Step 音色详情接口](https://platform.stepfun.com/docs/zh/api-reference/audio/system-voices)、[xAI Voice Overview](https://docs.x.ai/developers/model-capabilities/audio/voice#voices)、[xAI 查询接口](https://docs.x.ai/developers/rest-api-reference/inference/voice)、[Nova 2 音色与语言](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-language-support.html)。

配置方式沿用文本 Vertex 的术语，但实时凭证仍独立保存，不自动读取文本设置档。AI Studio Key、Express Key、Service Account 分字段写入同一加密凭证 bundle，切换模式时分别校验。已保存 JSON 不回显；未保存草稿在切换鉴权模式时保留。完整模式复用文本 Vertex 的 OAuth 签名与 token 缓存，续接时检查 token 有效期；挂断可取消鉴权。原生 WebSocket 只接收临时 Bearer token 或当前模式的 API Key，不接收 Service Account 私钥。

完整模式连接区域 `aiplatform.googleapis.com` 主机；Express 连接全局主机，使用 `x-goog-api-key` 请求头。Vertex 使用 `google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`，完整模式 setup 使用项目/区域模型资源路径，Express 使用 publisher 模型路径。依据 [Vertex Live 会话说明](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api/start-manage-session)、[Express 说明](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview)及 [Google 官方 SDK](https://github.com/googleapis/python-genai/blob/main/google/genai/live.py)实现。

## 自定义声音与角色绑定

先保存设置档，再展开“自定义声音与声音克隆”。可以登记已有 Voice ID，或者创建声音：

克隆区域沿用 App 纸张卡片、主题色按钮与 SVG 图标：创建新声音为主操作，已有 Voice ID 登记折叠显示，已登记声音以名称、ID、状态与操作列表展示。手机采用单列与整行按钮。

语音配置延续聊天/图片 API 的按需说明方式：模型、凭证、参考音频要求、克隆费用等移入对应标题的 `data-help`，标题带淡虚线下划；桌面悬停查看，手机点一下打开，再点标题或空白处关闭。标题点按阻止关联输入框/按钮的默认动作，避免打开说明时弹出键盘。清理重复的分页、保存生效说明及“不会……”式文案；上传进度、失败原因、已选音档与声音状态保持直接可见。

Step / 豆包的参考音频支持点击选择，桌面也可直接拖入 WAV / MP3；每个文件限制 10 MB。选中后显示文件名、格式、大小与可读取的时长，并提供本地试听、更换和移除。拖入多个文件、空文件、格式或大小不符会显示错误，保留原来的选择；创建期间禁用替换。只有点击创建才提交给服务商。音档、声音名称和参考文字在同一设置档重新渲染时保留；更换设置档、站点等所属环境会清空。音档不写入设置存储，关闭面板停止试听并释放预览 URL。

当前每次克隆接受 **一个参考音档**，可分别创建并登记多个声音，不做多音档合并或批量提交。[Step 官方创建接口](https://platform.stepfun.ai/docs/en/api-reference/audio/create-voice)接受单个 `file_id`；[Qwen-Audio 复刻接口](https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api)接受单个 `url`。Qwen 保留 HTTPS URL 输入方式。

Windows 主窗口设置 `dragDropEnabled: false`，让 HTML 文件拖放进入页面上传区；这是 [Tauri 对 Windows HTML5 拖放的要求](https://v2.tauri.app/reference/config/#dragdropenabled)。沿用现有页面拖放事件处理，没有新增原生文件读取权限或修改 `app.js`。

账号、模型和站点保存后，可以先切到“自定义声音”再创建第一个声音，不必先保存尚不存在的 Voice ID。其他配置或凭证仍有修改时，按钮附近会提示先保存。创建成功会登记返回的 Voice ID；若当前自定义声音尚未选择，会在草稿中选中新声音，点击“保存并使用”才应用到通话。

创建按钮显示忙碌状态；Step 分别显示上传参考音频和创建克隆两个阶段。进度、成功 Voice ID、服务商 HTTP 错误及具体原因显示在按钮下方，并滚动到可见位置；错误以红色显示，失败保留已选文件。云端成功但本机登记失败时保留 Voice ID，提示登记已有声音，避免再次提交克隆。展开状态在登记完成后保留；这些反馈已用模拟云端响应在 Windows dev App 的桌面与手机尺寸验证。

- **Qwen**：提供公开可访问的 HTTPS 音频 URL 和声音前缀；使用 Qwen-Audio 的 `voice-enrollment/create_voice`。仅北京区域；创建时的 `target_model` 必须和实时模型完全一致。
- **Step**：上传 WAV/MP3，先取得 `purpose=storage` 的 file_id，再使用 `stepaudio-2.5-tts` 创建 Voice ID。建议 5–10 秒清晰人声；上传和克隆统一走当前所选站点，克隆 ID 绑定该站点和账号。
- **豆包**：填写已购买的 S_ 槽位，上传参考音频，以 ICL 2.0 / model_type=4 训练。创建后保存“训练中”登记，通过“刷新状态”确认就绪。切换 SC2.0 时系统声切换为 saturn_ 系列。
- **xAI**：登记在控制台或其他已授权流程创建的 Voice ID；没有加入受企业权限限制的创建 API。

每条声音登记保存凭证引用、区域、工作空间和目标模型。更换账号后不会盲用旧声音；删除登记只移除本机引用，不删除云端资源。声音 ID 不做小写转换。

打开角色会话时，设置页提供“为当前角色使用此声音”和“跟随全局实时配置”。绑定以 scope + UI 模式 + session ID 隔离，保存具体设置档与声音；不覆盖普通 TTS 的角色声音绑定。绑定失效会报错，要求重新绑定。

“试用当前通话配置”会发起当前角色的真实实时通话，用于确认实际音色和对话表现，按服务商规则计费。它不把实时专用克隆声转交给普通 TTS 接口。未保存或未应用的草稿不能直接用于试用。

## 会话、音频与持久化

- OpenAI 保留 WebRTC，以及“输入转写 → 保存用户消息 → 更新本轮角色上下文 → response.create”的既有顺序。
- 新六家通过各自协议启动自然自动应答；开始通话时加载角色上下文，转写完成后不会额外发送一次 response.create。
- Qwen/Step/xAI 的 JSON 事件、Gemini Live 消息、豆包二进制帧、Nova event stream 分别映射为通话 runtime 事件。
- PCM 采集使用 AudioWorklet 和跨帧连续重采样。Gemini/豆包/Qwen/Nova 输入 16 kHz，Step/xAI 输入 24 kHz，输出默认 24 kHz PCM16。静音仍维持静音帧以让服务端 VAD 正常结束输入。
- 原生发送/接收和本地播放队列有界。挂断释放音轨、播放源、IPC Channel 和原生任务；主窗口重新拨号会清理该窗口遗留的原生连接。
- 收到模型完成事件后，仍等待本地播放队列结束才确认回复终态；这期间打断会清空声音队列，并将转写标为可能不完整。模型完成后也能立即停止残余播放。
- Step 的迟到输入转写会先保存，再保存对应回复。事件按捕获的通话代次隔离，关闭后迟发帧不会写入新会话。自动应答模式若消息保存失败，会结束通话并丢弃未保存回复，避免形成孤立历史。
- Nova 仅保留 FINAL 转写，忽略 SPECULATIVE 计划文本；usage 的累计值取差、增量直接累计。约 7 分钟安排续接，使用本次通话已完成的最近历史创建新流。Gemini 使用服务商恢复句柄，不重复注入同一段历史。

设置档及声音/角色引用存于 `realtime_profiles_v1` KV；凭证 bundle 使用现有 `ConfigManager` 的 `voice_realtime` keyring。它沿用应用现有加密机制，不是操作系统凭证保险库。旧 `voice_registry_v1` 保持原 TTS 语义，实时声音保存在实时设置档内。

## 代码位置

- `src/scripts/storage/realtime-profile-store.js`：设置档、凭证引用、声音登记、角色绑定。
- `src/scripts/ui/realtime/realtime-settings-panel.js`：设置与克隆管理 UI。
- `src/scripts/ui/realtime/realtime-enrollment-view.js`：克隆卡片、参考文件选择/拖放/试听、表单草稿与预览资源生命周期。
- `realtime-voice-catalog.js` / `realtime-voice-picker.js` / `realtime-voice-discovery.js`：按模型区分的音色资料、搜索卡片与桌面/触摸详情、xAI 在线音色查询。
- `realtime-provider-catalog.js` / `realtime-voice-enrollment.js`：候选能力、兼容性、复刻请求。
- `realtime-model-discovery.js`：模型目录、分页、实时能力筛选、当前凭证鉴权及取消；`scripts/build-realtime-model-deps.mjs` 构建本地 AWS 签名模块。
- `native-realtime-session-client.js`：IPC、音频、生命周期、续接与本地播放终态。
- `realtime-{json,gemini,doubao,nova}-protocol.js`：独立协议适配器。
- `realtime-pcm-{codec,audio}.js` / `realtime-microphone-worklet.js`：重采样、采集、播放。
- `src-tauri/src/realtime_transport.rs`：限定官方地址的 WebSocket 和 AWS SDK 双向流；凭证不进入发给前端的事件。

Nova 依赖 AWS Rust SDK；当前构建声明 Rust 1.91，并固定 `aws-sdk-bedrockruntime=1.108.0`。Rustls 显式选择 crypto provider，避免 AWS SDK 与 WebSocket 依赖组合导致默认 TLS backend 不明确。

本轮没有修改 `app.js`；通过已有 call-app-runtime 的依赖装配层接入服务商和角色绑定。

## 验证记录

### 声音克隆卡片与拖拽上传（2026-09-07）

- Windows PowerShell 启动可调试开发 App；`realtime-enrollment-feedback-tests.mjs` 四组及 Step 五组专项通过，配置样式契约通过，三语目录 7623 条检查通过。
- `dev-realtime-enrollment-upload-cdp-smoke.mjs` 在实际 WebView 内以内存设置验证键盘打开文件选择器、通过 CDP 投递真实临时 WAV 文件的受信任拖放、拖入高亮、可播放的一秒预览、多个文件拒绝且保留原文件、声音选项重绘保留名称/文字/音档、忙碌禁止替换、站点切换清空以及移除/关闭释放预览 URL。没有调用云端克隆或写入真实设置。
- 1100px / 390px 检查上传区和容器无横向溢出；`dev-realtime-enrollment-feedback-cdp-smoke.mjs` 同时确认创建进度与失败原因仍在可见位置。标题说明增补检查桌面悬停、手机点按开关/外点关闭，以及标题点按保留音档且阻止关联模型输入框激活；`help-tooltip-tests.mjs`、`voice-config-tests.mjs` 和配置样式专项通过，三语目录现 7617 条。截图 `realtime-checks/realtime-clone-{upload,help,feedback}-*.png` 已查看；这不替代 Android 真机或付费克隆结果验收。

### 2026-09-06 已连接但没有回应：Windows 默认输入设备

- 当前 Windows 默认输入为 `CABLE Output (VB-Audio Virtual Cable)`，内建 Microphone Array 为默认通信设备。实时采集未指定 deviceId，因而选择前者。实际 AudioWorklet 采集对照：虚拟设备 149 帧全部为零；内建麦克风 146 帧中 78 帧非零，两者权限和音轨状态均正常。
- 用 [Google 官方 Live API 示例中的公开语音](https://ai.google.dev/gemini-api/docs/live-api/capabilities#automatic-vad)验证当前 Gemini 设置及 Native 协议，正常得到输入转写、18 个回复音频块及完整响应终态。仅使用公开样本、没有录制或上传私人麦克风内容，没有写入角色历史；此结果不代替用户物理麦克风的说话验收。
- 处理方法：Windows「设置 → 系统 → 声音 → 输入」选 Microphone Array 作为默认输入，结束旧通话后重新拨号；仅设为默认通信设备不能改变当前代码的默认输入选择。[Microsoft 麦克风设置与测试说明](https://support.microsoft.com/en-us/windows/hardware/drivers/how-to-set-up-and-test-microphones-in-windows)。本轮不修改业务代码或系统默认设备。

### 2026-09-06 Gemini 连接等待修复

- 实际通话按钮读取的配置为 `gemini_live` / `gemini-3.1-flash-live-preview`，未被角色绑定或旧 OpenAI 配置覆盖。旧通话面板的连接提示和音频发送说明仍写死 OpenAI，现由本次通话状态携带实际 provider 并显示对应服务商。
- 真实诊断确认：麦克风/音频初始化成功，Gemini 在约 1.8 秒返回二进制 WebSocket 帧，其中 JSON 为 `setupComplete`；原适配器收到 `Uint8Array` 后未解码，忽略成功消息，最终在 30 秒触发初始化超时。Gemini 协议层现按 UTF-8 解码二进制 JSON，同时保留文本 JSON 路径，并明确拒绝无效格式；豆包的二进制协议保持不变。[Google 官方 SDK 对 Blob / ArrayBuffer 的同类处理](https://github.com/googleapis/js-genai/blob/main/src/live.ts)也明确先解码再解析 JSON。
- 新增 Native 客户端回归在修复前复现失败，修复后 Developer / Vertex × 文本 / 二进制四种组合通过，并验证中文及 emoji 转写、无效 UTF-8/JSON 拒绝。Windows `test:voice-config` 全部通过，多服务商专项现 16 组；多语言目录 7596 条，检查及 source scan 无新增遗漏。
- 使用用户当前保存的 Gemini 模型/音色通过实际通话按钮复核，约 2.1 秒进入“正在听”，连接提示正确显示 Gemini Live；诊断阻止麦克风帧上传并立即结束，仅验收真实鉴权/握手和连接状态，未验收听感或长通话。`dev-realtime-call-panel-cdp-smoke.mjs` 验证七家状态与音频发送说明，1100px 中文/390px 英文无溢出，截图 `realtime-checks/realtime-call-provider-*.png`。

### 此前与通用验证

均在 Windows PowerShell 执行：

- `npm run test:voice-config`：通过，包括旧 OpenAI、配置、转写落库、生命周期，以及新增 15 组多服务商和 5 组 Gemini Vertex 专项用例。Vertex 专项覆盖模式迁移/凭证隔离、资源路径/区域、续接 token、OAuth 期间取消，以及用临时测试 RSA 密钥验证共享 OAuth 的 JWT 签名。
- Vertex 增补时 `npm run test:i18n` 通过；本次模型刷新增补后 extract / generate / check / source 与 content scan 通过，目录各 7412 条，无新增漏译。
- `config-panel-style-contract`、`config-panel-save-callback`、`config-panel-model-ranking`：通过。
- `cargo test --lib`：31 项通过，包括新增 TLS、鉴权地址、原生取消释放测试，以及既有 OpenAI broker 测试。
- Vertex 增补后 `cargo test --lib realtime_transport::tests`：5 项通过，包括新增 Gemini 三种接入路径的主机与鉴权隔离；文本 `vertexai-provider-tests`、`vertexai-config-tests` 回归通过。
- 开发 App 的 `realtime-offline-smoke.js`：使用合成音频，不请求用户麦克风，验证真实 AudioWorklet、PCM 帧、静音、播放清空、音轨释放与内存设置档/声音登记。另以拒绝未知服务商的请求确认运行中 App 已载入原生命令；所有云端请求均为零。
- `dev-realtime-settings-cdp-smoke.mjs`：七家服务商及 Vertex 两种鉴权表单；1100 px 中文、390 px 英文均无表单横向溢出。截图在工作区 `realtime-checks/`。
- `realtime-vertex-offline-smoke.js`：开发 App 中以内存 store 验证 JSON 草稿、保存后不回显、项目识别、模式凭证校验；用无效鉴权模式确认运行中的原生程序已载入 Vertex 分支，未发起云端请求。
- 模型刷新增补：Windows `test:voice-config` 含 6 组 `realtime-model-discovery-tests` 通过，配置样式专项及 Rust transport 5 项通过；`realtime-model-picker-smoke.js` 在实际开发 App 中验证默认值、刷新/选择/手填、失败保留、取消、账号隔离和浏览器 AWS 签名，设置写入和外部请求均为 0。CDP 同时检查刷新后的候选列表在 1100 px / 390 px 下无溢出。

- 音色浏览增补：Windows `test:voice-config` 全部通过，新增 5 组音色目录/搜索/手填与克隆 ID/xAI 查询与取消专项；配置样式专项及 i18n extract/generate/check/source/content scan 通过，目录各 7592 条、无新增漏译。
- `dev-realtime-voice-picker-cdp-smoke.mjs`：在实际开发 App 的内存设置面板中验证搜索不修改选择、保存/手填保持、模型音色边界、xAI 刷新/失败保留/凭证隔离/取消，以及远程标签转义；使用真实 CDP 鼠标、Enter 和触摸事件检查桌面悬停及手机点选详情。1100 px 中文、390 px 简繁中文、320 px 英文均无横向溢出，触摸卡片高度至少 44 px；截图保存在 `realtime-checks/realtime-voice-picker-*.png`。云端请求和真实设置写入均为 0，未逐个音色进行云端试听；窄屏触摸检查不代替 Android 真机验收。

仍需进一步验证：其他模型/账号的鉴权与权限、语音质量/延迟、三家付费复刻结果、豆包 O2.0/SC2.0 的实际人设表现、Nova 长通话续接与凭证过期。Android 仍需独立构建和真机测试，尤其扬声器回声、蓝牙、前后台和网络切换。离线测试通过不能视为这些云端/真机验收已完成。

## 官方参考

- [Gemini Live](https://ai.google.dev/api/live)
- [豆包端到端实时语音](https://www.volcengine.com/docs/6561/1594356)、[声音复刻](https://www.volcengine.com/docs/6561/1305191)
- [Qwen Audio Realtime](https://help.aliyun.com/zh/model-studio/fun-audiochat-client-events)、[声音复刻](https://help.aliyun.com/zh/model-studio/voice-cloning-user-guide)
- [Step Realtime](https://platform.stepfun.com/docs/zh/api-reference/realtime/chat)、[官方采样率示例](https://github.com/stepfun-ai/Step-Realtime-Console/blob/main/src/routes/%2Bpage.svelte)、[复刻接口](https://platform.stepfun.com/docs/zh/api-reference/audio/create-voice)
- [xAI 实时语音](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech)
- [Nova 输入事件](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-input-events.html)、[输出事件](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-output-events.html)
