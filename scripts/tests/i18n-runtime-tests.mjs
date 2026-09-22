import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  buildCatalogKey,
  mapSystemLocale,
  normalizeLocalePreference,
  resolveLocale,
  translateFromCatalog,
} from '../../src/scripts/i18n/locale-utils.js';
import {
  formatDateTime,
  formatNumber,
  getI18nState,
  initializeI18n,
  localizeDomSubtree,
  t,
  translateUiText,
} from '../../src/scripts/i18n/index.js';

assert.equal(normalizeLocalePreference('ZH_tw'), 'zh-TW');
assert.equal(normalizeLocalePreference('unsupported'), 'system');
assert.equal(mapSystemLocale('zh-Hans-SG'), 'zh-CN');
assert.equal(mapSystemLocale('zh-Hant-HK'), 'zh-TW');
assert.equal(mapSystemLocale('en-US'), 'en');
assert.equal(mapSystemLocale('ja-JP'), 'en');
assert.equal(resolveLocale({ preference: 'system', systemLocale: 'zh-TW' }), 'zh-TW');
assert.equal(resolveLocale({ preference: 'en', systemLocale: 'zh-CN' }), 'en');
assert.equal(buildCatalogKey('删除', 'button'), '删除\u0004button');

const catalog = {
  '保存': 'Save',
  '删除\u0004button': 'Remove',
  '已导入 {count} 条记录': { one: 'Imported {count} record', other: 'Imported {count} records' },
  '作用域：{scope}': 'Scope: {scope}',
  '当前会话「{sessionId}」的角色/附加世界书': 'Character/additional lorebooks for current session “{sessionId}”',
  '展开{name}': 'Expand {name}',
  '展开查看更多评论 ({count}条)': 'Show more comments ({count})',
  '语义消息 ~{count} tok': 'Semantic Messages ~{count} tok',
  '{count} 路输入': '{count} inputs',
  '当前值：{value}': 'Current value: {value}',
  '左侧：{status}': 'Left: {status}',
  '右侧：{status}': 'Right: {status}',
  '已连接': 'Connected',
  '类型：{value}': 'Type: {value}',
  '数字': 'Number',
  '变量 {name}': 'Variable {name}',
  '当前没有匹配输入，因此按“有内容即参与”处理': 'No matching input is currently available, so this participates whenever it has content',
};
assert.equal(translateFromCatalog({ source: '保存', catalog, locale: 'en' }), 'Save');
assert.equal(translateFromCatalog({ source: '删除', context: 'button', catalog, locale: 'en' }), 'Remove');
assert.equal(translateFromCatalog({
  source: '已导入 {count} 条记录',
  params: { count: 1 },
  catalog,
  locale: 'en',
}), 'Imported 1 record');
assert.equal(translateFromCatalog({
  source: '已导入 {count} 条记录',
  params: { count: 2 },
  catalog,
  locale: 'en',
}), 'Imported 2 records');
assert.equal(translateFromCatalog({ source: '缺失', catalog, locale: 'en' }), '缺失');

await initializeI18n({
  preference: 'en',
  systemLocale: 'zh-CN',
  documentLike: null,
  fetchFn: async () => ({ ok: true, json: async () => catalog }),
});
assert.equal(getI18nState().locale, 'en');
assert.equal(t('保存'), 'Save');
assert.equal(translateUiText('  保存\n'), '  Save\n');
assert.equal(translateUiText('已导入 3 条记录'), 'Imported 3 records');
assert.equal(
  translateUiText('展开查看更多评论 (3条)'),
  'Show more comments (3)',
  'more-specific templates must win over generic prefix templates',
);
assert.equal(translateUiText('语义消息 ~7,531 tok'), 'Semantic Messages ~7,531 tok');
assert.equal(translateUiText('2 路输入'), '2 inputs');
assert.equal(translateUiText('当前值：10'), 'Current value: 10');
assert.equal(translateUiText('左侧：已连接'), 'Left: Connected');
assert.equal(translateUiText('右侧：已连接'), 'Right: Connected');
assert.equal(translateUiText('类型：数字'), 'Type: Number');
assert.equal(translateUiText('变量 audit.hp'), 'Variable audit.hp');
assert.equal(
  translateUiText('当前没有匹配输入，因此按“有内容即参与”处理'),
  'No matching input is currently available, so this participates whenever it has content',
);
assert.equal(
  translateUiText('作用域：当前会话「default」的角色/附加世界书'),
  'Scope: Character/additional lorebooks for current session “default”',
);
assert.equal(formatNumber(1234.5, { minimumFractionDigits: 1 }), '1,234.5');
assert.equal(
  formatDateTime(new Date('2026-08-31T00:00:00Z'), { timeZone: 'UTC', year: 'numeric' }),
  '2026',
);

{
  const attrs = new Map([['title', '保存']]);
  const root = {
    nodeType: 1,
    closest: () => null,
    hasAttribute: name => attrs.has(name),
    getAttribute: name => attrs.get(name),
    setAttribute: (name, value) => attrs.set(name, value),
  };
  const textNode = {
    nodeType: 3,
    nodeValue: '保存',
    parentElement: { closest: () => null },
  };
  const documentLike = {
    createTreeWalker: () => {
      const nodes = [textNode];
      let index = 0;
      return { nextNode: () => nodes[index++] || null };
    },
  };
  localizeDomSubtree(root, { documentLike });
  assert.equal(attrs.get('title'), 'Save');
  assert.equal(textNode.nodeValue, 'Save');
  textNode.nodeValue = '保存';
  textNode.parentElement.closest = () => ({ id: 'chat-scroll' });
  localizeDomSubtree(textNode, { documentLike });
  assert.equal(textNode.nodeValue, '保存', '消息与用户内容区域不能被目录后处理改写');
  textNode.nodeValue = '保存';
  textNode.parentElement.closest = selector => selector.includes('.QQ_chat_msgdiv') ? ({ className: 'QQ_chat_msgdiv' }) : null;
  localizeDomSubtree(textNode, { documentLike });
  assert.equal(textNode.nodeValue, '保存', '普通聊天气泡正文不能被界面目录误翻译');
}

{
  const attrs = new Map([['placeholder', '保存']]);
  const textarea = {
    nodeType: 1,
    closest: selector => selector.split(',').includes('textarea') ? textarea : null,
    hasAttribute: name => attrs.has(name),
    getAttribute: name => attrs.get(name),
    setAttribute: (name, value) => attrs.set(name, value),
  };
  const contentNode = {
    nodeType: 3,
    nodeValue: '保存',
    parentElement: textarea,
  };
  const documentLike = {
    createTreeWalker: () => {
      const nodes = [contentNode];
      let index = 0;
      return { nextNode: () => nodes[index++] || null };
    },
  };
  localizeDomSubtree(textarea, { documentLike });
  assert.equal(attrs.get('placeholder'), 'Save', 'textarea UI attributes should be localized');
  assert.equal(contentNode.nodeValue, '保存', 'textarea content must remain user data');
}

const generatedEnglishCatalog = JSON.parse(await fs.readFile('src/scripts/i18n/locales/en.json', 'utf8'));
await initializeI18n({
  preference: 'en',
  systemLocale: 'zh-CN',
  documentLike: null,
  fetchFn: async () => ({ ok: true, json: async () => generatedEnglishCatalog }),
});
assert.equal(translateUiText('已加载 3 个可用上游'), 'Loaded 3 available providers');
assert.equal(translateUiText('导出完成：12 条'), 'Export complete: 12 records');
assert.equal(translateUiText('字段7'), 'Field 7');
assert.equal(translateUiText('当前用户：Alice'), 'Current user: Alice');
assert.equal(
  translateUiText('当前模型的联网请求已安全跳过：Tool calling is unavailable'),
  'Web search was safely skipped for the current model: Tool calling is unavailable',
);
assert.equal(
  translateUiText('当前图片模型最多支持 3 张参考图'),
  'The current image model supports up to 3 reference images',
);
assert.equal(translateUiText('图片请求失败（HTTP 400）'), 'Image request failed (HTTP 400)');
assert.equal(translateUiText('预设请求失败：HTTP 502'), 'Preset request failed: HTTP 502');
assert.equal(
  translateUiText('预设消息后处理必须是函数'),
  'Preset message postprocessor must be a function',
);
assert.equal(
  translateUiText('请求参数：temperature · 参数路径重复或与上级、下级字段冲突：temperature'),
  'Request parameters: temperature · Duplicate parameter path or conflict with a parent or child field: temperature',
);
assert.equal(
  translateUiText('应用后将处理 3 处表格指令'),
  'Applying the changes will process 3 table commands',
);
assert.equal(translateUiText('Thought for 1 秒'), 'Thought for 1 second');
assert.equal(translateUiText('Thought for 9 秒'), 'Thought for 9 seconds');
assert.equal(translateUiText('[图片已过期]'), '[Image expired]');
assert.equal(translateUiText('以下为未读讯息'), 'Unread messages below');
assert.equal(translateUiText('对方'), 'Chat Partner');
assert.equal(translateUiText('👍 1个反应'), '👍 · 1 reaction');
assert.equal(translateUiText('👍 2个反应'), '👍 · 2 reactions');
assert.equal(translateUiText('使用👍回应'), 'React with 👍');
assert.equal(
  translateUiText('用「Calm」朗读本条（仅本次）'),
  'Read this message with “Calm” (this time only)',
);
assert.equal(
  translateUiText('确定保存联系人「Alice」的画像候选吗？ 保存后会影响后续动态弱触发、提示词上下文和 Agent 画像读取。'),
  'Save the profile candidate for contact “Alice”? It will affect future weak Moment triggers, prompt context, and Agent profile reads.',
);

const originalConsoleError = console.error;
console.error = () => {};
try {
  await initializeI18n({
    preference: 'zh-TW',
    systemLocale: 'zh-TW',
    documentLike: null,
    fetchFn: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
} finally {
  console.error = originalConsoleError;
}
assert.equal(getI18nState().requestedLocale, 'zh-TW');
assert.equal(getI18nState().locale, 'zh-CN');
assert.match(getI18nState().loadError, /catalog load failed/);

console.log('i18n-runtime-tests passed');
