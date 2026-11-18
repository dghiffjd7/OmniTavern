import assert from 'node:assert/strict';

// media-assets.js 载入时会读 localStorage
const memory = new Map();
globalThis.localStorage ??= { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key) };
const { initializeI18n } = await import('../../src/scripts/i18n/index.js');
const { parseSpecialMessage } = await import('../../src/scripts/ui/chat/message-parser.js');

{
  // 只有文字描述的图片／语音：中文显示「图片：…」「语音：…」，与原来一致
  assert.deepEqual(parseSpecialMessage('[img-一只猫]'), { type: 'meta', content: '图片：一只猫' });
  assert.deepEqual(parseSpecialMessage('[yy-晚安]'), { type: 'meta', content: '语音：晚安' });
  console.log('ok - text-only image and voice tokens keep the Chinese labels');
}

{
  try {
    await initializeI18n({ preference: 'en', documentLike: null, fetchFn: async () => ({ ok: true, json: async () => ({ 图片: 'Image', 语音: 'Voice' }) }) });
    assert.deepEqual(parseSpecialMessage('[img-latte art of a sleeping cat]'), { type: 'meta', content: 'Image: latte art of a sleeping cat' });
    assert.deepEqual(parseSpecialMessage('[yy-good night]'), { type: 'meta', content: 'Voice: good night' });
  } finally {
    await initializeI18n({ preference: 'zh-CN', documentLike: null });
  }
  console.log('ok - text-only image and voice labels follow the UI language');
}
