import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../../src/assets/css/qq-legacy.css', import.meta.url), 'utf8');
const creativeCss = fs.readFileSync(new URL('../../src/assets/css/creative-writing-redesign.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../../src/index.html', import.meta.url), 'utf8');
const agentChipSource = fs.readFileSync(new URL('../../src/scripts/ui/agent-center-status-chip.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
const chatCss = fs.readFileSync(new URL('../../src/assets/css/chat.css', import.meta.url), 'utf8');
const chatUiSource = fs.readFileSync(new URL('../../src/scripts/ui/chat/chat-ui.js', import.meta.url), 'utf8');

assert.match(css, /\.QQ_chat_charmsg\.has-rp-message-chrome\s*>\s*\.QQ_chat_head\s*\{[^}]*32px[^}]*margin-top:\s*4px/s);
assert.match(css, /\.rp-message-header\s*\{[^}]*display:\s*flex/s);
assert.match(css, /\.QQ_chat_charmsg\.has-rp-message-chrome\s+\.QQ_chat_msgdiv\s*\{[^}]*4px 20px 20px 20px/s);
assert.match(css, /\.rp-message-actions\s*\{[^}]*opacity:\s*0/s);
assert.match(css, /\.rp-message-actions\.is-user\s*\{[^}]*width:\s*auto/s);
assert.match(css, /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)[\s\S]*\.has-rp-message-actions:hover\s+\.rp-message-actions[\s\S]*opacity:\s*1/);
assert.match(css, /\.has-rp-message-actions\.is-rp-actions-visible\s+\.rp-message-actions\s*\{[^}]*opacity:\s*1/s);
assert.match(css, /\.chat-reasoning-actions\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/s);
assert.match(css, /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)[\s\S]*\.chat-reasoning:hover\s+\.chat-reasoning-actions[\s\S]*opacity:\s*1/s);
assert.match(css, /@media\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)[\s\S]*\.chat-reasoning-actions[\s\S]*opacity:\s*1/s);
assert.match(creativeCss, /body:not\(\[data-theme-mode='dark'\]\)\[data-ui-mode='rp'\][\s\S]*\.QQ_chat_charmsg\.has-rp-message-chrome[\s\S]*background:\s*var\(--app-surface-card\)/s);
assert.doesNotMatch(creativeCss, /body\[data-theme-mode='dark'\]\[data-ui-mode='rp'\][\s\S]*\.QQ_chat_charmsg\.has-rp-message-chrome[\s\S]*background:/s);
assert.match(creativeCss, /body\[data-ui-mode='rp'\]\s+#chat-room\s+\.chat-back-btn\s*\{[^}]*display:\s*none/s);
assert.match(html, /class="chat-room-topbar"[\s\S]*id="rp-reading-settings-btn"[\s\S]*id="chat-menu-btn"/s);
assert.doesNotMatch(html, /class="chat-room-topbar"[\s\S]{0,1200}id="realtime-call-button"/s);
assert.match(html, /class="chat-input-wrap"[\s\S]*id="composer-input"[\s\S]*id="realtime-call-button"[\s\S]*id="voice-input-button"/s);
// 打字时通话按钮收起：CSS 契约 + chat-ui 状态同步（input 监听与程序化写入两条路径）
assert.match(chatCss, /\.chat-input-row\.composer-has-text \.chat-realtime-call-btn\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/s);
assert.match(chatCss, /body:not\(\[data-ui-mode='rp'\]\) \.chat-input-row\.composer-has-text \.chat-input\s*\{[^}]*padding-right:\s*74px/s);
assert.match(chatCss, /body\[data-ui-mode='rp'\] \.chat-input-row\.composer-has-text \.chat-input\s*\{[^}]*padding-right:\s*40px/s);
assert.match(chatUiSource, /classList\?\.toggle\?\.\('composer-has-text'/);
assert.match(chatUiSource, /addEventListener\?\.\('input', this\.syncComposerTextState\)/);
assert.match(chatUiSource, /setInputText\(val\)\s*\{[^}]*this\.syncComposerTextState\(\)/s);
assert.match(creativeCss, /\.rp-reading-size-options::before\s*\{[^}]*transition:\s*transform/s);
assert.doesNotMatch(html, /data-action="reading-settings"/);
assert.match(html, /data-rp-reading-size="compact"[\s\S]*data-rp-reading-size="standard"[\s\S]*data-rp-reading-size="relaxed"/);
assert.match(html, /data-rp-narrative-font="serif"[\s\S]*data-rp-narrative-font="sans"/);
assert.match(creativeCss, /data-rp-reading-size='compact'[\s\S]*font-size:\s*calc\(13\.5px\s*\*\s*var\(--app-font-scale,\s*1\)\)/s);
assert.match(creativeCss, /data-rp-narrative-font='serif'[\s\S]*font-family:\s*'Noto Serif SC'/s);
assert.match(creativeCss, /data-ui-mode='chat'[\s\S]*\.rp-reading-settings-btn[\s\S]*display:\s*inline-flex/s);
assert.match(creativeCss, /data-ui-mode='chat'\]\[data-rp-reading-size='standard'\][\s\S]*font-size:\s*calc\(14\.5px\s*\*\s*var\(--app-font-scale,\s*1\)\)/s);
assert.match(creativeCss, /data-ui-mode='chat'\]\[data-rp-narrative-font='serif'\][\s\S]*font-family:\s*'Noto Serif SC'/s);
assert.match(creativeCss, /body:not\(\[data-theme-mode='dark'\]\)\[data-ui-mode='chat'\][\s\S]*\.QQ_chat_charmsg[\s\S]*background:\s*var\(--app-surface-card\)/s);
assert.match(
  agentChipSource,
  /\.chat-room-topbar\s+\.agent-status-chip-mark\s*\{[^}]*border-radius:\s*50%[^}]*background:\s*linear-gradient\(145deg,\s*#ffffff\b[^;]*#b8c0ca\b/s,
  'topbar Agent Center keeps its round silver-coin mark',
);
assert.match(
  creativeCss,
  /body\[data-ui-mode='chat'\]:not\(\[data-chat-display='document'\]\)\s+\.QQ_chat_charmsg\s+\.QQ_chat_msgdiv\s*\{[^}]*border-radius:\s*4px 22px 22px 22px\s*!important/s,
);
assert.match(
  creativeCss,
  /body\[data-ui-mode='chat'\]:not\(\[data-chat-display='document'\]\)\s+\.QQ_chat_mymsg\s+\.QQ_chat_msgdiv\s*\{[^}]*border-radius:\s*22px 4px 22px 22px\s*!important/s,
);
assert.match(
  creativeCss,
  /body\[data-ui-mode='chat'\]\s+\.QQ_chat_charmsg\.has-rp-message-actions\s+\.chat-time-row\.is-assistant\s*>\s*\.rp-message-actions\s*\{[^}]*margin-left:\s*0/s,
);
assert.match(
  creativeCss,
  /body\[data-ui-mode='chat'\]\s+\.QQ_chat_charmsg\.has-rp-message-actions\s+\.chat-message-footer\.is-assistant\s*>\s*\.chat-time-row\.is-assistant\s*>\s*\.QQ_chat_time\s*\{[^}]*justify-self:\s*end/s,
);
assert.match(
  creativeCss,
  /body:is\(\[data-ui-mode='chat'\],\s*\[data-ui-mode='rp'\]\)\s+\.QQ_chat_mymsg\.has-rp-message-actions\s+\.chat-time-row\s*>\s*\.rp-message-actions\.is-user\s*\{[^}]*margin-right:\s*0/s,
);
assert.match(
  creativeCss,
  /body\[data-ui-mode='chat'\]\s+\.QQ_chat_charmsg\.has-rp-message-actions\s+\.chat-time-row\.is-assistant,\s*body:is\(\[data-ui-mode='chat'\],\s*\[data-ui-mode='rp'\]\)\s+\.QQ_chat_mymsg\.has-rp-message-actions\s+\.chat-time-row\s*\{[^}]*width:\s*max-content[^}]*display:\s*grid/s,
);
assert.match(
  creativeCss,
  /body:is\(\[data-ui-mode='chat'\],\s*\[data-ui-mode='rp'\]\)\s+\.has-rp-message-actions\s+\.chat-time-row\s+\.rp-message-actions\s*\{[^}]*grid-area:\s*1\s*\/\s*1[^}]*padding:\s*0[^}]*border:\s*0[^}]*background:\s*transparent[^}]*box-shadow:\s*none/s,
);
assert.match(
  creativeCss,
  /body:is\(\[data-ui-mode='chat'\],\s*\[data-ui-mode='rp'\]\)\s+\.has-rp-message-actions\s+\.chat-time-row\s*>\s*:is\(\.QQ_chat_time,\s*\.chat-delivery-status\)\s*\{[^}]*pointer-events:\s*none/s,
);
// metadata/操作条基础样式必须锁定在带操作条的消息内：无操作条的时间行不能被清 margin 或改 hit-test
assert.doesNotMatch(
  creativeCss,
  /\[data-ui-mode='rp'\]\)\s+\.chat-time-row/,
);
assert.match(
  creativeCss,
  /body:is\(\[data-ui-mode='chat'\],\s*\[data-ui-mode='rp'\]\)\s+\.has-rp-message-actions\.is-rp-actions-visible\s+\.chat-time-row\s*>\s*:is\(\.QQ_chat_time,\s*\.chat-delivery-status\)\s*\{[^}]*opacity:\s*0/s,
);
assert.match(
  creativeCss,
  /body:is\(\[data-ui-mode='chat'\],\s*\[data-ui-mode='rp'\]\)\s+\.has-rp-message-actions\.is-rp-actions-visible\s+\.chat-time-row\s+\.rp-message-actions\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/s,
);
assert.match(
  creativeCss,
  /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)[\s\S]*body:is\(\[data-ui-mode='chat'\],\s*\[data-ui-mode='rp'\]\)[\s\S]*\.chat-time-row\s*>\s*:is\(\.QQ_chat_time,\s*\.chat-delivery-status\)[\s\S]*opacity:\s*0/s,
);
assert.match(
  creativeCss,
  /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*body:is\(\[data-ui-mode='chat'\],\s*\[data-ui-mode='rp'\]\)\s+\.has-rp-message-actions\s+\.chat-time-row\s+\.rp-message-actions[\s\S]*transition:\s*none\s*!important/s,
);
assert.match(
  creativeCss,
  /body\[data-reduced-motion='on'\]:is\(\[data-ui-mode='chat'\],\s*\[data-ui-mode='rp'\]\)[\s\S]*\.has-rp-message-actions\s+\.chat-time-row\s+\.rp-message-actions[\s\S]*transition:\s*none\s*!important/s,
);
assert.match(html, /id="rp-greeting-trigger"[\s\S]*class="rp-greeting-seal"[\s\S]*id="rp-greeting-count"[\s\S]*class="rp-greeting-trigger-arrow"[\s\S]*<svg/s);
assert.match(html, /id="rp-greeting-sheet-count"[\s\S]*扉页 · 每一篇开场白，都是一种故事的开端[\s\S]*id="rp-greeting-sheet-close"/s);
assert.match(creativeCss, /\.rp-greeting-sheet\.is-opening\s*\{[^}]*animation:\s*rp-greeting-sheet-in/s);
assert.match(creativeCss, /\.rp-greeting-sheet-item\.active::before\s*\{[^}]*background:\s*#c2482f/s);
assert.match(creativeCss, /\.is-rp-greeting-message\s+\.QQ_chat_msgdiv\s*\{[^}]*border-radius:\s*26px\s*!important/s);
assert.match(creativeCss, /\.rp-greeting-editor-overlay:not\(\.is-closing\)\s+\.rp-greeting-editor\s*\{[^}]*animation:\s*rp-greeting-editor-in/s);
assert.match(
  creativeCss,
  /\.rp-greeting-editor-field\s+\.rp-greeting-editor-content\s*\{[^}]*height:\s*230px[^}]*overflow-y:\s*auto[^}]*white-space:\s*pre-wrap/s,
);
assert.match(
  creativeCss,
  /\.rp-greeting-editor-content\.is-empty::before\s*\{[^}]*content:\s*attr\(data-placeholder\)/s,
);
assert.match(creativeCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.rp-greeting-sheet\.is-opening[\s\S]*animation:\s*none\s*!important/s);
assert.match(creativeCss, /body\[data-reduced-motion='on'\][\s\S]*\.rp-greeting-sheet\.is-opening[\s\S]*animation:\s*none\s*!important/s);
assert.match(
  creativeCss,
  /@media\s*\(max-width:\s*600px\)[\s\S]*body\[data-ui-mode='rp'\]\s+\.QQ_chat_charmsg\.has-rp-message-chrome\s*\{[^}]*width:\s*calc\(100%\s*-\s*16px\)/s,
);
assert.match(
  creativeCss,
  /@media\s*\(max-width:\s*600px\)[\s\S]*body\[data-ui-mode='rp'\]\s+\.QQ_chat_charmsg\.is-rp-greeting-message\s*\{[^}]*width:\s*100%/s,
);
assert.doesNotMatch(
  creativeCss,
  /@media\s*\(max-width:\s*600px\)[\s\S]*body\[data-ui-mode='rp'\]\s+\.QQ_chat_charmsg\.is-rp-greeting-message\s*\{[^}]*width:\s*calc\(100%\s*-\s*20px\)/s,
);
assert.match(
  creativeCss,
  /@media\s*\(max-width:\s*600px\)[\s\S]*\.QQ_chat_charmsg\.has-rp-message-chrome\s+\.chat-message-stack\s*\{[^}]*display:\s*contents\s*!important/s,
);
assert.match(
  creativeCss,
  /@media\s*\(max-width:\s*600px\)[\s\S]*\.QQ_chat_charmsg\.has-rp-message-chrome\s+\.chat-bubble-stack\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*width:\s*100%/s,
);
assert.match(appSource, /class="rp-greeting-editor-macros"[\s\S]*data-rp-greeting-macro="\{\{user\}\}"[\s\S]*data-rp-greeting-macro="\{\{char\}\}"[\s\S]*data-rp-greeting-macro="\{\{time\}\}"/s);
assert.match(appSource, /overlay\.classList\.add\('is-closing'\)[\s\S]*prefers-reduced-motion:\s*reduce/s);
assert.match(appSource, /className = 'rp-greeting-sheet-item-index'[\s\S]*className = 'rp-greeting-sheet-item-preview'[\s\S]*className = 'rp-greeting-sheet-item-radio'/s);
assert.match(appSource, /addEventListener\('pointercancel'[\s\S]*finishRpGreetingSheetDrag\(event,\s*\{\s*cancelled:\s*true\s*\}\)/s);
assert.match(creativeCss, /\.rp-greeting-sheet-handle\s*\{[^}]*touch-action:\s*none/s);

console.log('ok - shared chat chrome and opening-page redesign retain mirrored bubbles, SVG controls and reduced-motion fallbacks');
