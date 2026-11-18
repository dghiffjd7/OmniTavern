<div align="center">

# OmniTavern

**A local-first AI roleplay chat app for desktop and mobile**

Private chats · Group chats · Creative writing · Image generation · All data stays on your device

[![Release](https://img.shields.io/github/v/release/dghiffjd7/OmniTavern?label=Latest)](https://github.com/dghiffjd7/OmniTavern/releases/latest)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Android-blue)](https://github.com/dghiffjd7/OmniTavern/releases/latest)
[![License](https://img.shields.io/badge/License-AGPL--3.0-green)](LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/illusion7)

[简体中文](README.md) | **English** | [繁體中文](README.zh-TW.md)

## ⬇️ Download

### [**Get it from the Releases page**](https://github.com/dghiffjd7/OmniTavern/releases/latest)

Want a look first? [Overview and 80-second video](https://dghiffjd7.github.io/OmniTavern/)

| Platform | Installer |
| --- | --- |
| Windows | `OmniTavern_x.x.x_x64-setup.exe` |
| Android | `OmniTavern_x.x.x.apk` |

<!-- TODO: hero screenshot (desktop dual-pane chat, English UI)
![OmniTavern desktop](docs/images/hero-en.png)
-->

</div>

---

## What is OmniTavern

OmniTavern is a local-first AI roleplay chat app inspired by SillyTavern. Chat one-on-one with AI characters, put several characters in a group chat, switch to a dedicated creative-writing mode for long-form RP, or scroll a social feed where your characters post and comment.

- **Native on both platforms**: built on Tauri v2 — real installers for Windows and Android, not a web wrapper
- **Fully local data**: chats, character cards, lorebooks and memories live only on your device; nothing passes through a third-party server
- **Bring your own API**: plug in your own model API key — all major providers plus any OpenAI-compatible endpoint
- **SillyTavern-friendly**: import SillyTavern character cards (PNG / JSON), presets and regex scripts

## Highlights

### Chat & group chat

Streaming output, message regeneration with swipes, reply quoting, emoji reactions, cross-session search, @mentions, image messages and automatic image generation. Every AI reply is validated before it is committed — malformed replies can be inspected, auto-repaired by AI or regenerated. Dual-pane layout on desktop; replies reveal message-by-message with a skip button.

<!-- TODO: group chat screenshot
![Group chat](docs/images/group-chat-en.png)
-->

### Creative writing

A dedicated long-form RP / fiction mode with its own prompts and parameters, separate from chat. Archive and reset the story at any point and switch back whenever you like, with inline image generation and asset reuse.

<!-- TODO: creative writing screenshot
![Creative writing](docs/images/creative-writing-en.png)
-->

### Maid assistant

An in-app AI agent you drive with natural language: create contacts, group chats and lorebooks, set up a full room from an imported character card in one step, batch-organize, generate avatars and wallpapers. Every write action asks for your confirmation; she has long-term memory and resumes interrupted tasks.

<!-- TODO: maid assistant screenshot
![Maid assistant](docs/images/maid-en.png)
-->

### Lorebooks & memory

Lorebook entries activate on keywords; the condition editor has a node-graph mode for visually wiring up trigger logic. Memory tables are filled in automatically by the AI as you chat (relationships, key events), and memory can be shared between chat, the social feed and creative writing.

<!-- TODO: lorebook editor screenshot
![Lorebook condition editor](docs/images/worldbook-en.png)
-->

### Moments (social feed)

Characters post moments and comment on each other; you can react and reply, and a moment can spill over into related private or group chats. Supports image attachments, feed-side image generation and its own memory table.

<!-- TODO: moments screenshot
![Moments](docs/images/moments-en.png)
-->

### Image generation & stickers

Generate images in chat, creative writing and the feed, with NovelAI and other providers, parameter overrides and retry. Generate sticker packs with automatic background removal and slicing, managed per chat room.

## What's new in 0.7.10

- **Housekeeper**: a small model handles chores — translating messages, turning image descriptions into English tags, naming stickers, summarizing saves — and you can add your own tasks
- **Maid**: maps and weather, interactive choice and plan cards, per-round history management, feed posts with images
- **Image generation**: live preview while generating, reference images pinned to a chat
- **Context lineage graph**: more sources with key items highlighted; jump to settings, export, and trace paths

Full notes: [0.7.10 release](https://github.com/dghiffjd7/OmniTavern/releases/tag/v0.7.10) (in Chinese).

## Supported AI providers

| Type | Providers |
| --- | --- |
| Chat models | Google Gemini, OpenAI, Anthropic (Claude), DeepSeek, OpenRouter, Kimi (Moonshot), Zhipu GLM, Ollama (local), and any OpenAI-compatible endpoint |
| Image generation | NovelAI, OpenAI, Google (Gemini / Imagen, Vertex AI), Stability AI, Together AI, WaveSpeed, Pollinations, AUTOMATIC1111, ComfyUI, any OpenAI-compatible endpoint, plus chat models with image output |

Each chat room can use its own API and model.

## Quick start

1. Install and open OmniTavern, then tap ⚙ in the top-right corner to open Settings
2. In **API settings**, enter your API key, refresh the model list, pick a model and save
3. Two ways to play:
   - **Chat mode**: tap `+` on the main screen to add a friend (pick from the built-in character library or create your own) and start chatting
   - **Creative writing / RP**: import a SillyTavern character card (PNG / JSON) — its lorebook and greetings come along automatically

## Data & privacy

Everything (chats, characters, lorebooks, memories, images) is stored only on your device. API requests go straight from the app to the provider you configured — there is no middleman server. Back up all your data to a single file and restore it on a new device in one step; exports automatically exclude sensitive data such as API keys.

## Support the project

OmniTavern is maintained by a solo developer. If you enjoy it, consider buying me a coffee:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/illusion7)

## License

[AGPL-3.0](LICENSE)
