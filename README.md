<div align="center">

# OmniTavern

**跑在手机和电脑上的本地 AI 角色扮演聊天应用**

私聊 · 群聊 · 创意写作 · 图片生成 · 所有数据只存在你自己的设备上

[![Release](https://img.shields.io/github/v/release/dghiffjd7/OmniTavern?label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC)](https://github.com/dghiffjd7/OmniTavern/releases/latest)
[![Platform](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%7C%20Android-blue)](https://github.com/dghiffjd7/OmniTavern/releases/latest)
[![License](https://img.shields.io/badge/License-AGPL--3.0-green)](LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-%E6%94%AF%E6%8C%81%E5%BC%80%E5%8F%91-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/illusion7)

**简体中文** | [English](README.en.md) | [繁體中文](README.zh-TW.md)

## ⬇️ 下载

### [**点此前往下载页（Releases）**](https://github.com/dghiffjd7/OmniTavern/releases/latest)

| 平台 | 安装包 |
| --- | --- |
| Windows | `OmniTavern_x.x.x_x64-setup.exe` |
| Android | `OmniTavern_x.x.x.apk` |

<!-- TODO: 主界面截图（桌面双栏聊天界面，简中 UI）
![OmniTavern 桌面主界面](docs/images/hero-zh-CN.png)
-->

</div>

---

## OmniTavern 是什么

OmniTavern 是一个本地优先的 AI 角色扮演聊天应用，灵感来自 SillyTavern。你可以和 AI 角色一对一聊天、拉群让多个角色同场对话、进入创意写作模式写长篇 RP，也可以像刷朋友圈一样看角色发的动态。

- **双端原生**：基于 Tauri v2，Windows 桌面与 Android 手机都是原生安装包，不是网页套壳
- **数据完全本地**：聊天记录、角色卡、世界书、记忆全部存在你自己的设备上，不经过任何第三方服务器
- **自带 API**：填入你自己的模型 API Key 即可使用，支持主流服务商和任意 OpenAI 兼容端点
- **兼容酒馆生态**：可导入 SillyTavern 格式角色卡（PNG / JSON）、预设与正则脚本

## 亮点功能

### 聊天与群聊

流式输出、消息重生成与左右翻页（swipe）、回复引用、emoji 反应、跨会话搜索、@ 提及、图片消息与自动生图。AI 回复整轮验收后才落库，格式不合规可查看原文、AI 一键修复或重新生成。桌面版双栏布局，回复按打字节奏逐条揭示、可一键跳过。

<!-- TODO: 群聊截图
![群聊](docs/images/group-chat-zh-CN.png)
-->

### 创意写作

独立的长文本 RP / 小说模式，与聊天模式分开配置提示词和参数；支持存档并重置剧情、随时切回，配合自动生图和插图素材复用。

<!-- TODO: 创意写作截图
![创意写作](docs/images/creative-writing-zh-CN.png)
-->

### 女仆助手

App 内置的 AI 代理：用自然语言让她替你建联系人 / 群聊 / 世界书、导入角色卡一键建房、批量整理、生图设头像壁纸。所有写操作都需要你确认，带长期记忆，任务中断可跨轮续作。

<!-- TODO: 女仆助手截图
![女仆助手](docs/images/maid-zh-CN.png)
-->

### 世界书与记忆

世界书条目按关键词自动激活，条件编辑器支持节点连线模式，可视化组合触发条件；记忆表格由 AI 在聊天中自动填写角色关系与重要事件，聊天 / 动态 / 创意写作之间可配置记忆共享。

<!-- TODO: 世界书条件编辑器截图
![世界书条件编辑器](docs/images/worldbook-zh-CN.png)
-->

### 动态（朋友圈）

角色会发动态、互相评论，你可以点赞回复，动态还能联动相关私聊 / 群聊；支持图片附件、动态生图与独立的动态记忆。

<!-- TODO: 动态截图
![动态](docs/images/moments-zh-CN.png)
-->

### 图片生成与贴图

聊天、创意写作、动态全场景生图，支持 NovelAI 等图片服务、参数覆盖与失败重试；可生成表情包并自动去背景、切割成贴图，按聊天室绑定管理。

## 0.7.8 更新亮点

0.7.7 的修复更新：修复部分已知内容。

完整内容见 [0.7.8 更新内容](https://github.com/dghiffjd7/OmniTavern/releases/tag/v0.7.8)。

## 支持的 AI 服务

| 类型 | 服务商 |
| --- | --- |
| 对话模型 | Google Gemini、OpenAI、Anthropic (Claude)、DeepSeek、OpenRouter、Kimi (Moonshot)、智谱 GLM、Ollama（本地）以及任意 OpenAI 兼容端点 |
| 图片生成 | NovelAI 及支持图片输出的对话模型 |

每个聊天室可以单独指定使用哪个 API 和模型。

## 快速上手

1. 安装并打开 OmniTavern，点右上角 ⚙ 进入设置
2. 在 **API 设定** 填入你的 API Key，刷新列表选择模型并保存
3. 两种玩法入口：
   - **聊天模式**：主界面点右上角 `+` 添加好友（从内置角色库选或自己创建），开聊
   - **创意写作 / RP**：导入 SillyTavern 角色卡（PNG / JSON），世界书与开场白自动导入，直接开始

## 数据与隐私

所有数据（聊天、角色、世界书、记忆、图片）仅保存在本地设备。API 请求由应用直接发往你配置的模型服务商，没有中间服务器。支持一键打包导出全部资料、换设备一键导入恢复；导出包自动排除 API Key 等敏感信息。

## 支持开发

OmniTavern 由个人开发者维护。如果它对你有帮助，欢迎请我喝杯咖啡：

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/illusion7)

## 许可证

[AGPL-3.0](LICENSE)
