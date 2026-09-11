import assert from 'node:assert/strict';

// app-settings 是模块单例（内部 memorySettings 状态），用子场景顺序测试。
const storageMap = new Map();
globalThis.localStorage = {
  getItem: key => (storageMap.has(key) ? storageMap.get(key) : null),
  setItem: (key, value) => {
    if (globalThis.__quotaFull) throw new Error('quota exceeded');
    storageMap.set(key, String(value));
  },
  removeItem: key => storageMap.delete(key),
};

const { appSettings } = await import('../../src/scripts/storage/app-settings.js');

{
  // 配额满 + kv 通道：更新仍持久化到 kv，hydrate 恢复。
  globalThis.__quotaFull = true;
  const kvMap = new Map();
  await appSettings.hydrate({
    loadKv: async key => kvMap.get(key) || null,
    saveKv: async (key, data) => { kvMap.set(key, data); },
  });
  appSettings.update({ toastEnabled: false });
  await new Promise(r => setTimeout(r, 0));
  const kvSaved = kvMap.get('app_settings_v1');
  assert.equal(kvSaved?.toastEnabled, false, '配额满时设置应写入 kv');
  assert.ok(Number(kvSaved?.__updatedAt) > 0, 'kv 数据应带时间戳');
  assert.equal(appSettings.get().toastEnabled, false, '会话内内存态为准');
  assert.equal(Object.prototype.hasOwnProperty.call(appSettings.get(), '__updatedAt'), false, '对外不暴露时间戳');
  console.log('ok - 配额满时设置经 kv 持久化且会话内一致');
}

{
  // hydrate 裁决：kv 较新时以 kv 为准。
  const kvMap = new Map([
    ['app_settings_v1', { toastEnabled: true, typingDotsEnabled: false, __updatedAt: 9999 }],
  ]);
  storageMap.set('app_settings_v1', JSON.stringify({ toastEnabled: false, __updatedAt: 1000 }));
  await appSettings.hydrate({
    loadKv: async key => kvMap.get(key) || null,
    saveKv: async () => {},
  });
  assert.equal(appSettings.get().toastEnabled, true, 'kv 较新应胜出');
  assert.equal(appSettings.get().typingDotsEnabled, false);
  console.log('ok - hydrate 按 __updatedAt 裁决 kv 与 localStorage');
}

{
  // localStorage 较新时以 localStorage 为准（如 kv 是旧备份）。
  const kvMap = new Map([
    ['app_settings_v1', { toastEnabled: true, __updatedAt: 500 }],
  ]);
  storageMap.set('app_settings_v1', JSON.stringify({ toastEnabled: false, __updatedAt: 8888 }));
  await appSettings.hydrate({
    loadKv: async key => kvMap.get(key) || null,
    saveKv: async () => {},
  });
  assert.equal(appSettings.get().toastEnabled, false, 'localStorage 较新应胜出');
  console.log('ok - localStorage 较新时不被旧 kv 覆盖');
}

{
  assert.equal(appSettings.get().traditionalModelOutputProtocolEnabled, false, '结构化通道应为产品默认');
  assert.equal(appSettings.get().presetScopeMigrationNoticeShown, false, '尚未提示预设迁移');
  appSettings.update({ traditionalModelOutputProtocolEnabled: true });
  assert.equal(appSettings.get().traditionalModelOutputProtocolEnabled, true, '兼容模式应可持久启用');
  appSettings.update({ presetScopeMigrationNoticeShown: true });
  assert.equal(appSettings.get().presetScopeMigrationNoticeShown, true, '预设迁移提示状态应持久化');
  appSettings.update({ traditionalModelOutputProtocolEnabled: false });
  assert.equal(appSettings.get().traditionalModelOutputProtocolEnabled, false, '兼容模式应可关闭');
  console.log('ok - 通用传统输出兼容模式默认关闭且可持久切换');
}

{
  const kvMap = new Map();
  await appSettings.hydrate({
    loadKv: async key => kvMap.get(key) || null,
    saveKv: async (key, data) => { kvMap.set(key, data); },
  });
  appSettings.update({
    realtimeVoiceSettings: {
      ...appSettings.get().realtimeVoiceSettings,
      transcriptionLanguage: 'zh,en',
      replyLanguage: ' 台湾普通话 ',
    },
  });
  assert.equal(
    appSettings.get().realtimeVoiceSettings.transcriptionLanguage,
    'zh,en',
    'Realtime 输入语言应独立规范化并保存',
  );
  assert.equal(appSettings.get().realtimeVoiceSettings.replyLanguage, '台湾普通话');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(kvMap.get('app_settings_v1')?.realtimeVoiceSettings?.transcriptionLanguage, 'zh,en');
  assert.equal(kvMap.get('app_settings_v1')?.realtimeVoiceSettings?.replyLanguage, ' 台湾普通话 ');
  const reloadedModule = await import('../../src/scripts/storage/app-settings.js?realtime-language-reload=1');
  await reloadedModule.appSettings.hydrate({
    loadKv: async key => kvMap.get(key) || null,
    saveKv: async () => {},
  });
  assert.equal(reloadedModule.appSettings.get().realtimeVoiceSettings.transcriptionLanguage, 'zh,en');
  assert.equal(reloadedModule.appSettings.get().realtimeVoiceSettings.replyLanguage, '台湾普通话');
  console.log('ok - Realtime 输入语言独立保存在 app settings 并可从 KV 恢复');
}

{
  globalThis.__quotaFull = false;
  const kvMap = new Map();
  await appSettings.hydrate({
    loadKv: async key => kvMap.get(key) || null,
    saveKv: async (key, data) => { kvMap.set(key, data); },
  });
  appSettings.update({ chatStructuredThinkingPreference: 'stable_format' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(kvMap.get('app_settings_v1')?.chatStructuredThinkingPreference, 'stable_format');

  const reloadedModule = await import('../../src/scripts/storage/app-settings.js?thinking-preference-reload=1');
  await reloadedModule.appSettings.hydrate({
    loadKv: async key => kvMap.get(key) || null,
    saveKv: async () => {},
  });
  assert.equal(reloadedModule.appSettings.get().chatStructuredThinkingPreference, 'stable_format');
  appSettings.update({ chatStructuredThinkingPreference: 'preserve' });
  console.log('ok - structured thinking preference survives KV persistence and module reload');
}

console.log('app-settings-kv-tests passed');
