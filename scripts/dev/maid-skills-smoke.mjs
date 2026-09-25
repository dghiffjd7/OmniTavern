// Windows dev WebView2 (CDP 9222); uses temporary skills in the existing data store.
// --with-ai adds one harmless text task using the configured maid model.
import { writeFile } from 'node:fs/promises';
import { createWsClient, findAppPageTarget } from './cdp-client.mjs';

const target = await findAppPageTarget();
let client, seq = 0; const pending = new Map(), errors = [];
await new Promise((resolve, reject) => {
  client = createWsClient(target.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const message = JSON.parse(raw);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.text);
    const item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
  } });
});
const call = (method, params = {}, timeout = 30000) => new Promise((resolve, reject) => {
  const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
  pending.set(id, { resolve, reject, timer }); client.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression, timeout) => {
  const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result?.value;
};
try {
  await call('Runtime.enable');
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evaluate('Boolean(window.appBridge?.debugUiRegistry?.stores?.maidSkillRuntime)')) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const result = await evaluate(String.raw`(async () => {
    const r = window.appBridge.debugUiRegistry, store = r.stores.maidSkillStore, runtime = r.stores.maidSkillRuntime;
    const { t } = await import('/scripts/i18n/index.js');
    const transfer = await import('/scripts/ui/maid-skill-transfer.js');
    const assert = (ok, name) => { if (!ok) throw new Error(name); };
    const wait = async predicate => { for (let i = 0; i < 120; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('UI wait timed out'); };
    await store.ready;
    const prefix = 'Skill-smoke-' + crypto.randomUUID().slice(0,8);
    window.__maidSkillSmoke = { prefix, ids: [], selected: runtime.getSelected(), assert, wait, store, runtime, r, t };
    r.actions.openMaidSkills();
    const panel = document.querySelector('#maid-settings-section-skills');
    const click = text => { const node = [...panel.querySelectorAll('button')].find(item => item.textContent === t(text)); assert(node, 'button: ' + text); node.click(); };
    const field = (label, value) => {
      const wrap = [...panel.querySelectorAll('label')].find(item => item.firstElementChild?.textContent === t(label));
      const node = wrap?.querySelector('input,textarea'); assert(node, 'field: ' + label); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true }));
    };
    click('新建技能');
    field('标题', prefix); field('适用说明', '仅用于本次技能功能验收。');
    field('流程正文（Markdown）', '用户要求验证本技能时，只回答：技能验收完成。不要调用其他工具。\n\n<img src="https://invalid.example/x" onerror="window.__skillXss=true">');
    click('预览'); assert(!panel.querySelector('.maid-skill-preview img'), 'unsafe preview image');
    click('继续编辑'); click('保存');
    await wait(() => store.list().some(item => item.title === prefix));
    const saved = store.list().find(item => item.title === prefix); window.__maidSkillSmoke.ids.push(saved.id); window.__maidSkillSmoke.saved = saved;
    await store.load(); assert(store.list().some(item => item.id === saved.id), 'native persistence reload');
    const file = transfer.exportMaidSkillMarkdown(saved); assert(transfer.parseMaidSkillText(file.text, { fileName: file.fileName })[0].skill.content === saved.content, 'Markdown roundtrip');
    const baseline = JSON.stringify(store.exportState());
    const importFile = () => {
      click('导入'); const input = panel.querySelector('input[type=file]'), data = new DataTransfer();
      data.items.add(new File(['---\nname: '+prefix.toLowerCase()+'-import\ndescription: Import smoke only\n---\nRead the user request.'], 'SKILL.md', { type: 'text/markdown' }));
      input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    importFile(); await wait(() => panel.textContent.includes(t('确认导入')));
    assert(JSON.stringify(store.exportState()) === baseline, 'preview wrote storage');
    click('返回'); await wait(() => document.querySelector('.app-confirm-overlay')?.style.display === 'block');
    const discard = [...document.querySelectorAll('.app-confirm-modal button')].find(item => item.textContent === t('放弃')); assert(discard, 'discard action'); discard.click();
    await wait(() => panel.textContent.includes(t('新建技能')));
    assert(JSON.stringify(store.exportState()) === baseline, 'cancel wrote storage');
    importFile(); await wait(() => panel.textContent.includes(t('确认导入'))); click('确认导入');
    await wait(() => store.list().filter(item => item.kind === 'custom').length === JSON.parse(baseline).skills.length + 1);
    const imported = store.list().find(item => item.name === prefix.toLowerCase()+'-import'); window.__maidSkillSmoke.ids.push(imported.id);
    const title = [...panel.querySelectorAll('.maid-skill-title')].find(item => item.textContent === prefix); title.click(); click('保存并用于下一次请求');
    await wait(() => runtime.getSelected().includes(saved.id));
    assert(document.querySelector('.maid-skill-chips')?.textContent.includes(prefix), 'selected chip missing');
    document.querySelector('.maid-command-input-skills').click(); await wait(() => document.querySelector('dialog[open]'));
    const dialog = document.querySelector('dialog[open]'); assert(dialog.getAttribute('aria-label'), 'unnamed dialog'); dialog.close();
    return { create: true, nativeReload: true, safePreview: true, markdownRoundtrip: true, importCancel: true, importCommit: true, selectWithoutSending: true };
  })()`);
  console.log(JSON.stringify(result));
  await evaluate('window.__maidSkillSmoke.r.actions.openMaidSkills()');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await new Promise(resolve => setTimeout(resolve, 300));
  const narrow = await evaluate(`(() => {
    const panel = document.querySelector('.maid-settings-panel'), section = document.querySelector('#maid-settings-section-skills');
    return { viewport: innerWidth, panelWidth: Math.round(panel.getBoundingClientRect().width), contentWidth: section.scrollWidth, availableWidth: section.clientWidth, overflow: section.scrollWidth > section.clientWidth + 1 };
  })()`);
  if (narrow.overflow) throw new Error('Narrow skills panel overflows: ' + JSON.stringify(narrow));
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL('./tmp/maid-skills-narrow.png', import.meta.url), Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({ narrow }));
  await call('Emulation.clearDeviceMetricsOverride');
  if (process.argv.includes('--with-ai')) {
    const ai = await evaluate(`(async () => {
      const { r, runtime, store, saved, assert, wait } = window.__maidSkillSmoke;
      const completion = r.stores.maidCommandInputRuntime.submitTask('请验证所选技能，只做文字回复。');
      await wait(() => runtime.getSelected().length === 0);
      await store.save({ ...saved, content: '新版本：回答新版本已启用。' }, { id: saved.id, expectedRevision: saved.revision });
      const result = await completion;
      const exchange = r.stores.maidSettingsStore.getLastExchange();
      const request = typeof exchange.requestPrompt === 'string' ? exchange.requestPrompt : JSON.stringify(exchange.requestPrompt);
      assert(request.includes('技能验收完成'), 'old body absent from actual request');
      assert(!request.includes('新版本已启用'), 'mid-task edit leaked into request');
      assert(result.ok !== false, 'model task failed: ' + (result.message || result.reason));
      const run = r.stores.agentTaskRuntime.listRuns({ kind: 'maid_assistant', limit: 10 }).find(item => item.metadata?.maidSkills?.loaded?.some(doc => doc.id === saved.id));
      assert(run?.metadata?.maidSkills?.loaded[0]?.skill?.content === saved.content, 'loaded revision missing from run');
      return { ok: result.ok, response: result.message, originalRevisionInRequest: true, taskSnapshot: true, loadedRevision: run.metadata.maidSkills.loaded[0].revision };
    })()`, 180000);
    console.log(JSON.stringify({ ai }));
  }
  console.log(JSON.stringify({ runtimeExceptions: errors }));
  if (errors.length) throw new Error('Dev raised runtime exceptions');
} finally {
  try { await call('Emulation.clearDeviceMetricsOverride'); } catch {}
  try {
    console.log(JSON.stringify({ cleanup: await evaluate(`(async () => {
      const state = window.__maidSkillSmoke; if (!state) return false;
      for (const id of state.ids) { const current = state.store.list().find(item => item.id === id); if (current) await state.store.remove(id, { expectedRevision: current.revision }); }
      state.runtime.setSelected(state.selected);
      document.querySelectorAll('.maid-skill-dialog').forEach(dialog => dialog.close());
      if (document.querySelector('.app-confirm-overlay')?.style.display === 'block') document.querySelector('.app-confirm-modal .app-confirm-ok')?.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      document.querySelector('.maid-settings-close')?.click();
      delete window.__maidSkillSmoke; return true;
    })()`) }));
  } finally { client.close(); }
}
