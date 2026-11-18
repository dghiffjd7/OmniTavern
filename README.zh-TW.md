<div align="center">

# OmniTavern

**跑在手機和電腦上的本地 AI 角色扮演聊天應用**

私聊 · 群聊 · 創意寫作 · 圖片生成 · 所有資料只存在你自己的裝置上

[![Release](https://img.shields.io/github/v/release/dghiffjd7/OmniTavern?label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC)](https://github.com/dghiffjd7/OmniTavern/releases/latest)
[![Platform](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%7C%20Android-blue)](https://github.com/dghiffjd7/OmniTavern/releases/latest)
[![License](https://img.shields.io/badge/License-AGPL--3.0-green)](LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-%E6%94%AF%E6%8C%81%E9%96%8B%E7%99%BC-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/illusion7)

[简体中文](README.md) | [English](README.en.md) | **繁體中文**

## ⬇️ 下載

### [**點此前往下載頁（Releases）**](https://github.com/dghiffjd7/OmniTavern/releases/latest)

想先看看？[介紹頁與 80 秒宣傳片](https://dghiffjd7.github.io/OmniTavern/)

| 平台 | 安裝檔 |
| --- | --- |
| Windows | `OmniTavern_x.x.x_x64-setup.exe` |
| Android | `OmniTavern_x.x.x.apk` |

<!-- TODO: 主介面截圖（桌面雙欄聊天介面，繁中 UI）
![OmniTavern 桌面主介面](docs/images/hero-zh-TW.png)
-->

</div>

---

## OmniTavern 是什麼

OmniTavern 是一個本地優先的 AI 角色扮演聊天應用，靈感來自 SillyTavern。你可以和 AI 角色一對一聊天、開群組讓多個角色同場對話、進入創意寫作模式寫長篇 RP，也可以像滑動態牆一樣看角色發的動態。

- **雙平台原生**：基於 Tauri v2，Windows 桌面與 Android 手機都是原生安裝檔，不是網頁套殼
- **資料完全本地**：聊天紀錄、角色卡、世界書、記憶全部存在你自己的裝置上，不經過任何第三方伺服器
- **自帶 API**：填入你自己的模型 API Key 即可使用，支援主流服務商和任意 OpenAI 相容端點
- **相容酒館生態**：可匯入 SillyTavern 格式角色卡（PNG / JSON）、預設與正則腳本

## 亮點功能

### 聊天與群聊

串流輸出、訊息重新生成與左右翻頁（swipe）、回覆引用、emoji 反應、跨會話搜尋、@ 提及、圖片訊息與自動生圖。AI 回覆整輪驗收後才寫入，格式不合規可查看原文、AI 一鍵修復或重新生成。桌面版雙欄佈局，回覆按打字節奏逐條揭示、可一鍵跳過。

<!-- TODO: 群聊截圖
![群聊](docs/images/group-chat-zh-TW.png)
-->

### 創意寫作

獨立的長文本 RP / 小說模式，與聊天模式分開設定提示詞和參數；支援存檔並重置劇情、隨時切回，搭配自動生圖和插圖素材重複使用。

<!-- TODO: 創意寫作截圖
![創意寫作](docs/images/creative-writing-zh-TW.png)
-->

### 女僕助手

App 內建的 AI 代理：用自然語言讓她替你建聯絡人 / 群聊 / 世界書、匯入角色卡一鍵建房、批次整理、生圖設頭像與桌布。所有寫入操作都需要你確認，帶長期記憶，任務中斷可跨輪續作。

<!-- TODO: 女僕助手截圖
![女僕助手](docs/images/maid-zh-TW.png)
-->

### 世界書與記憶

世界書條目按關鍵字自動觸發，條件編輯器支援節點連線模式，可視化組合觸發條件；記憶表格由 AI 在聊天中自動填寫角色關係與重要事件，聊天 / 動態 / 創意寫作之間可設定記憶共享。

<!-- TODO: 世界書條件編輯器截圖
![世界書條件編輯器](docs/images/worldbook-zh-TW.png)
-->

### 動態（朋友圈）

角色會發動態、互相留言，你可以按讚回覆，動態還能聯動相關私聊 / 群聊；支援圖片附件、動態生圖與獨立的動態記憶。

<!-- TODO: 動態截圖
![動態](docs/images/moments-zh-TW.png)
-->

### 圖片生成與貼圖

聊天、創意寫作、動態全場景生圖，支援 NovelAI 等圖片服務、參數覆寫與失敗重試；可生成表情包並自動去背、切割成貼圖，按聊天室綁定管理。

## 0.7.10 更新亮點

- **小管家**：用小模型處理翻譯、生圖標籤、貼圖起名、存檔概述等雜務，也可以自建任務
- **女僕**：地圖與天氣、互動式的選項與計畫卡、歷史按輪管理、發帶圖的動態
- **生圖**：即時預覽、固定在聊天上的參考圖
- **上下文血緣圖**：來源補齊並標出重點，可跳到設定、匯出與診斷路徑

完整內容見 [0.7.10 更新內容](https://github.com/dghiffjd7/OmniTavern/releases/tag/v0.7.10)。

## 支援的 AI 服務

| 類型 | 服務商 |
| --- | --- |
| 對話模型 | Google Gemini、OpenAI、Anthropic (Claude)、DeepSeek、OpenRouter、Kimi (Moonshot)、智譜 GLM、Ollama（本地）以及任意 OpenAI 相容端點 |
| 圖片生成 | NovelAI、OpenAI、Google（Gemini／Imagen、Vertex AI）、Stability AI、Together AI、WaveSpeed、Pollinations、AUTOMATIC1111、ComfyUI、任意 OpenAI 相容端點，以及支援圖片輸出的對話模型 |

每個聊天室可以單獨指定使用哪個 API 和模型。

## 快速上手

1. 安裝並開啟 OmniTavern，點右上角 ⚙ 進入設定
2. 在 **API 設定** 填入你的 API Key，重新整理列表選擇模型並儲存
3. 兩種玩法入口：
   - **聊天模式**：主畫面點右上角 `+` 加好友（從內建角色庫選或自己建立），開聊
   - **創意寫作 / RP**：匯入 SillyTavern 角色卡（PNG / JSON），世界書與開場白自動匯入，直接開始

## 資料與隱私

所有資料（聊天、角色、世界書、記憶、圖片）僅保存在本地裝置。API 請求由應用直接發往你設定的模型服務商，沒有中間伺服器。支援一鍵打包匯出全部資料、換裝置一鍵匯入還原；匯出包自動排除 API Key 等敏感資訊。

## 支持開發

OmniTavern 由個人開發者維護。如果它對你有幫助，歡迎請我喝杯咖啡：

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/illusion7)

## 授權條款

[AGPL-3.0](LICENSE)
