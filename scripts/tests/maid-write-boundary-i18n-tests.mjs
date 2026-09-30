import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { initializeI18n } from '../../src/scripts/i18n/index.js';
import { createWorldbookWriteBoundary } from '../../src/scripts/agent/tools/worldbook-write-boundary.js';
import { createAppContentAgentTools } from '../../src/scripts/agent/tools/app-content-tools.js';

const current = { id: 'alice', name: 'Alice', source: { worldbookId: 'Current lorebook' } };
const other = { id: 'beatrice', name: 'Beatrice', source: { worldbookId: 'Other lorebook' } };
const boundary = createWorldbookWriteBoundary({
  getCurrentPersona: () => current, listPersonas: () => [current, other],
  readSnapshot: async () => ({ exists: true, revision: 1, generation: 1 }),
  getGlobalIds: () => ['Other lorebook'], getSessionMap: () => ({ 'other-room': ['Other lorebook'] }),
  getCurrentSessionId: () => 'current-room',
  resolveTargets: { 'worldbook.create': async () => [{ worldbookId: 'Other lorebook' }] },
});
const tool = boundary.wrap({ name: 'worldbook.create', title: 'Append entries', execute: () => assert.fail('unapproved writes must not execute') });
for (const locale of ['en', 'zh-TW']) {
  await initializeI18n({ preference: locale, documentLike: null,
    fetchFn: async url => ({ ok: true, json: async () => JSON.parse(await fs.readFile(url, 'utf8')) }),
  });
  const request = await tool.safety.preflight({});
  const deleteTool = createAppContentAgentTools({
    listWorlds: async () => ['Original', ...Array.from({ length: 6 }, (_, index) => `Original (${index + 2})`)],
    getWorldInfo: async name => ({ name, entries: [] }),
    getWorldInfoSnapshot: async () => ({ exists: true, revision: 1, generation: 1 }),
  }).find(item => item.name === 'worldbook.delete_many');
  const deleteRequest = await deleteTool.safety.preflight({ worldbooks: ['Original'] });
  assert.equal(deleteRequest.details.keptSimilarWorldbooks.count, 6);
  assert.equal(deleteRequest.details.keptSimilarWorldbooks.items.length, 5);
  const rejected = await tool.execute({});
  assert.equal(request.allowAlways, false);
  assert.equal(rejected.reason, 'worldbook_target_confirmation_required');
  assert.match(request.message, /Alice.*Other lorebook.*Beatrice/);
  if (locale === 'en') {
    assert.equal(request.title, 'Confirm Lorebook Write Target');
    assert.equal(request.confirmText, 'Allow Once');
    assert.equal(request.cancelText, 'Cancel');
    assert.match(request.message, /shared globally.*references from other chats: 1/);
    assert.doesNotMatch(`${request.title}${request.message}${rejected.message}`, /\p{Script=Han}/u);
    assert.match(deleteRequest.message, /6 unselected lorebooks.*They will be kept/s);
    assert.doesNotMatch(deleteRequest.message, /\p{Script=Han}/u);
  } else {
    assert.equal(request.title, '確認世界書寫入目標');
    assert.match(request.message, /當前角色卡.*綁定角色卡/);
    assert.match(rejected.message, /其他角色卡或共享範圍/);
    assert.match(deleteRequest.message, /未選中的近似名世界書.*將保留/s);
  }
}
await initializeI18n({ preference: 'zh-CN', documentLike: null });
console.log('ok - worldbook target confirmations and denials use English and Traditional Chinese catalogs');
