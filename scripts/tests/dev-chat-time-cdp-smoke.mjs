// Windows dev smoke: real settings control and bridge prompt construction.
// No model request or chat write; restore the original setting in finally.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';

const target = await findAppPageTarget();
let socket, sequence = 0;
const pending = new Map();
await new Promise((resolve, reject) => {
  socket = createWsClient(target.webSocketDebuggerUrl, {
    onOpen: resolve, onError: reject,
    onMessage: raw => {
      const message = JSON.parse(raw), task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id);
      clearTimeout(task.timer);
      if (message.error) task.reject(new Error(message.error.message));
      else task.resolve(message.result);
    },
  });
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => reject(new Error(method)), 20_000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let original;
try {
  if (!process.argv.includes('--no-reload')) {
    await command('Page.reload', { ignoreCache: true });
    await pause(2500);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await evaluateInApp('Boolean(window.appBridge?.debugUiRegistry?.panels?.generalSettingsPanel)')) break;
    await pause(1000);
  }
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  const control = await evaluateInApp(`(async () => {
    const { appSettings } = await import('/scripts/storage/app-settings.js');
    const original = appSettings.get().chatAiTimeEnabled;
    window.appBridge.getScriptRuntime()?.uiShadow?.querySelector('.kmc-header button')?.click();
    const panel = window.appBridge.debugUiRegistry.panels.generalSettingsPanel;
    panel.show();
    const toggle = document.querySelector('#general-chat-ai-time');
    toggle.scrollIntoView({ block: 'center' });
    return { original, checked: toggle.checked, exists: !!toggle };
  })()`);
  original = control.original;
  assert.equal(control.exists, true);
  assert.equal(control.checked, original);
  await pause(350);
  for (const enabled of [true, false]) {
    await evaluateInApp(`document.querySelector('#general-chat-ai-time').scrollIntoView({block:'center',behavior:'instant'})`);
    await pause(400);
    const coords = await evaluateInApp(`(() => {
      const toggle = document.querySelector('#general-chat-ai-time');
      const control = toggle.closest('label').querySelector('.general-settings-switch');
      const rect = control.getBoundingClientRect();
      return { checked: toggle.checked, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    if (coords.checked !== enabled) {
      await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coords.x, y: coords.y });
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', buttons: 1, clickCount: 1 });
      await pause(100);
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', buttons: 0, clickCount: 1 });
    }
    await pause(150);
    const result = await evaluateInApp(`(async () => {
      const { appSettings } = await import('/scripts/storage/app-settings.js');
      const { getBuiltinPhoneFormatPromptSeed } = await import('/scripts/storage/builtin-worldbooks.js');
      const panel = window.appBridge.debugUiRegistry.panels.generalSettingsPanel;
      const enabled = appSettings.get().chatAiTimeEnabled;
      const samples = [];
      for (const autoImagePromptEnabled of [false, true]) {
        for (const momentMediaMode of ['placeholder', 'image_prompt', 'ai']) {
          const entries = window.appBridge.buildPhoneFormatPromptEntries(getBuiltinPhoneFormatPromptSeed(), { autoImagePromptEnabled, momentMediaMode });
          const chat = entries.find(item => item.id === '手机-格式2-QQ聊天').content;
          const moment = entries.find(item => item.id === '手机-格式3-QQ空间').content;
          samples.push({ autoImagePromptEnabled, momentMediaMode, chat, moment });
        }
      }
      const custom = '用户自定义：作者--文本--HH:mm';
      const customPrompt = window.appBridge.buildPhoneFormatPromptEntries({ phone_format_chat_rules: custom })
        .find(item => item.id === '手机-格式2-QQ聊天').content;
      const decision = '自定义条件--12:34';
      const decisionPrompt = window.appBridge.buildPhoneFormatPromptEntries(getBuiltinPhoneFormatPromptSeed(), { momentCreateRules: decision })
        .find(item => item.id === '手机-格式3-QQ空间').content;
      panel.hide(); panel.show();
      return { enabled, checkedAfterReopen: document.querySelector('#general-chat-ai-time').checked,
        stored: JSON.parse(localStorage.getItem('app_settings_v1')).chatAiTimeEnabled,
        samples, customPreserved: customPrompt.startsWith(custom), decisionPreserved: decisionPrompt.includes(decision) };
    })()`);
    assert.equal(result.enabled, enabled);
    assert.equal(result.stored, enabled);
    assert.equal(result.checkedAfterReopen, enabled);
    assert.equal(result.customPreserved, true);
    assert.equal(result.decisionPreserved, true);
    for (const sample of result.samples) {
      if (enabled) {
        assert.match(sample.chat, /发言人--内容--HH:mm/);
        assert.match(sample.moment, /发言人--发言内容--HH:mm--已浏览人数--已点赞人数/);
      } else {
        assert.doesNotMatch(sample.chat, /--(?:HH:mm|\d{1,2}:\d{2})/i);
        assert.doesNotMatch(sample.moment, /--(?:HH:mm|\d{1,2}:\d{2}|发言时间)/i);
      }
      assert.equal(sample.chat.includes('需要图片时：使用 <image_prompt>'), sample.autoImagePromptEnabled);
      if (sample.autoImagePromptEnabled && sample.momentMediaMode === 'image_prompt') assert.match(sample.moment, /动态如果有配图,使用<image_prompt>标签格式/);
    }
    console.log('ok - native toggle ' + enabled + ', persisted state, actual bridge prompts, media variants and custom text');
  }
  await evaluateInApp(`document.querySelector('#general-chat-ai-time').scrollIntoView({block:'center',behavior:'instant'})`);
  await pause(200);
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync('scripts/dev/tmp/chat-time-settings.png', Buffer.from(screenshot.data, 'base64'));
} finally {
  if (typeof original === 'boolean') {
    await evaluateInApp(`(async () => {
      const { appSettings } = await import('/scripts/storage/app-settings.js');
      if (appSettings.get().chatAiTimeEnabled !== ${original}) {
        const toggle = document.querySelector('#general-chat-ai-time');
        toggle.checked = ${original};
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
      }
      window.appBridge.debugUiRegistry.panels.generalSettingsPanel.hide();
    })()`);
  }
  await command('Emulation.setFocusEmulationEnabled', { enabled: false });
  socket.close();
}
