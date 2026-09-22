# 实时通话自定义服务商

更新日期：2026-09-22。状态：已实现 OpenAI Realtime 正式协议的原生 WebSocket 接入，已通过本地协议与 Windows dev 验证，尚未实测第三方云端通话。

实时语音设置档的“服务商”列表新增 **自定义**。填写渠道的实时地址、API Key、模型和声音 ID 后保存，可供聊天室、创意写作及女仆使用。渠道必须实现 OpenAI Realtime 正式协议；只有文本 OpenAI 兼容接口的渠道无法因此获得实时音频能力。

## 接入边界

- `custom` 为独立服务商；原七类服务商、官方 OpenAI WebRTC / GPT-Live 保留原连接方式。
- `custom-realtime-config.js` 校验协议、地址及鉴权；设置档保存端点、模型、声音、转写设置和绑定，敏感请求头与 API Key 一起进入既有密钥环，不写入设置档元数据。
- `custom-realtime-protocol.js` 适配正式协议的嵌套音频会话配置、24 kHz PCM、会话确认、输入转写、工具结果及打断截断。只在 `session.updated` 后确认初始化成功；打断按实际播放长度截断，不把排队音频计入已听内容。
- 复用原生连接和 PCM 录放。`realtime_transport.rs` 构造自定义 WebSocket 请求，保持主窗口归属、连接／报文上限、超时、中止及资源释放机制。
- 按每轮转写刷新上下文；女仆的工具请求仍进入原任务队列，接受回执和任务完成结果分别回传，挂断不取消已接受的任务。

## 配置与检查

新建实时语音设置档后选择“自定义”，表单沿用现有布局：

| 字段 | 行为 |
| --- | --- |
| 设置档名称 | 用户给渠道命名 |
| 兼容协议 | OpenAI Realtime (WebSocket)，正式协议 |
| 服务地址 | HTTPS 自动转 WSS；根地址补 `/v1/realtime`，以 `/v1` 结尾则补 `/realtime`，其他完整路径保留；保留查询参数，以模型输入框统一设置 `model`；显示最终连接地址 |
| API Key | 使用独立凭据保存，避免沿用另一渠道的密钥 |
| 模型 / 声音 ID | 支持手填且保留大小写；本期模型列表使用内建候选并提示手填，不请求官方模型目录；声音候选以渠道实际支持为准 |
| 高级设置 | Bearer、自定义鉴权请求头或无 API Key；附加请求头 JSON；必填渠道支持的输入转写模型 |
| 检查连接 | 创建空白会话，等待服务器确认配置，明确标示实际音频和女仆任务尚未验证 |
| 检查任务调用 | 强制调用无副作用的探测函数，校验随机参数，再回传随机回执并确认模型读到结果；不调用应用工具 |

连接检查不申请麦克风、不携带聊天或角色内容，可取消，结束后释放连接；检查与通话互斥。界面注明服务商可能计费，只有实际通话才检验收音、播放及渠道的实际工具表现。附加请求头留空保留已保存值，填写 `{}` 清除。

## 限制与验证

远端地址要求 WSS，本机 localhost / 回环地址可用 WS。URL 不允许用户名、密码或 fragment，请求头不能覆盖 WebSocket 连接保留字段，不关闭证书校验，也不向官方地址自动回退。

本期不提供自定义 WebRTC、GPT-Live、旧版 Realtime beta、Gemini Live、Qwen、Step、xAI、豆包或 Nova 的协议选择；这些需要按真实渠道再适配，不能靠改 URL 通配。自定义渠道需要支持输入转写，否则每轮上下文和回复触发无法成立。

- `npm run test:custom-realtime`：地址／鉴权、设置档恢复与绑定、会话／音频事件、播放截断、连接与工具双向探测、中止、女仆任务结果和互斥。
- 已有多服务商、语音设置、模型／声音选择、通话运行时和女仆任务影响范围专项通过；Rust `realtime_transport::tests` 9 项通过。
- `scripts/tests/dev-custom-realtime-cdp-smoke.mjs`：Windows 原数据 dev 的实际表单连接本机 WebSocket 模拟服务，两项检查经真实 Rust 传输验证，确认路径／模型及鉴权，并核验 1100 / 390px 布局。设置档与密钥使用内存替身，不写用户配置。
- 未调用真实云端模型、未启用麦克风；真实渠道的权限、模型能力及音频效果待实际通话验证。

## 官方协议依据

- [OpenAI Realtime 入门](https://developers.openai.com/api/docs/guides/realtime)：实时会话通过 WebRTC 或 WebSocket 运行，处理音频轮次、工具和打断。文本兼容性不足以证明实时兼容，这是基于其独立协议要求的判断。
- [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)：会话配置、音频收发、转写、VAD、函数调用和结果回传均有特定事件流程。
- [OpenAI 语音连接](https://developers.openai.com/api/docs/guides/voice-webrtc)：WebRTC 涉及 SDP 建连及媒体轨道；仅转发普通 HTTP 文本请求的渠道不满足这套要求。

本地协议检查不代表已对任何第三方服务商完成兼容认证。
