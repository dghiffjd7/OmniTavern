import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createCustomReactionAssets, customReactionAssets, customReactionImportWarning } from '../../src/scripts/ui/chat/custom-reaction-assets.js';
import { normalizeReactionEntries, toggleReactionActor } from '../../src/scripts/ui/chat/message-interaction-utils.js';
import { stickerPackStore } from '../../src/scripts/storage/sticker-pack-store.js';
import * as experienceUtils from '../../src/scripts/ui/experience-pack-import-utils.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=';
const memoryStore = () => {
  const packs = new Map();
  return { getReactionPacks: () => [...packs.values()].filter(p => p.kind === 'reaction'), getPack: id => packs.get(id),
    upsertPack: pack => packs.set(pack.id, pack), updatePack: (id, patch) => packs.set(id, { ...packs.get(id), ...patch }), removePack: id => packs.delete(id) };
};
const create = store => createCustomReactionAssets({ store, saveImage: async dataUrl => ({ dataUrl, path: '' }) });

test('a custom reaction survives storage, export and conflicting pack IDs with one asset and a complete message reference', async () => {
  const sourceStore = memoryStore(), assets = create(sourceStore);
  const item = await assets.addDataUrl(png, '小猫');
  assert.equal((await assets.addDataUrl(png, '同一张图')).emoji, item.emoji);
  assert.equal(assets.list().length, 1);
  const reactions = toggleReactionActor([], item.emoji, '__self__', { name: item.name });
  assert.equal(normalizeReactionEntries(JSON.parse(JSON.stringify(reactions)))[0].emoji, item.emoji);
  assert.equal(reactions[0].name, '小猫');
  const exported = new Map();
  const bundle = assets.collect([{ meta: { reactions } }, { meta: { reactions } }], { addSource: (path, data) => { exported.set(path, data); return path; } });
  assert.equal(bundle.length, 1);
  assert.equal(assets.collect([{ content: '未使用反应' }], { addSource() { throw Error('unrelated image exported'); } }).length, 0);
  const targetStore = memoryStore();
  targetStore.upsertPack({ id: `reaction-${item.id}`, kind: 'sticker', name: '原来的贴纸' });
  const imported = create(targetStore);
  assert.deepEqual(await imported.import(bundle, path => exported.get(path)), { failed: [] });
  assert.equal(imported.find(item.emoji).name, '小猫');
  assert.equal(targetStore.getPack(`reaction-${item.id}`).name, '原来的贴纸');
  assert.equal(create(targetStore).find(item.emoji).dataUrl, png);
  await imported.remove(item.emoji);
  assert.equal(imported.find(item.emoji), null);
  assert.equal(normalizeReactionEntries(reactions)[0].name, '小猫', 'removing a resource retains its message fallback');
  assert.deepEqual(toggleReactionActor(reactions, item.emoji), []);
});

test('reaction packs are excluded from stickers and model keywords; import validates asset identity', async () => {
  stickerPackStore.update(() => ({ packs: [] }));
  const assets = create(stickerPackStore), item = await assets.addDataUrl(png, '反应');
  assert.equal(stickerPackStore.getPacks().length, 0);
  assert.equal(stickerPackStore.getStickerState().packs.length, 0, 'ordinary sticker UI and media catalog exclude reactions');
  assert.equal(stickerPackStore.getStickerState(stickerPackStore.getState()).packs.length, 0, 'state returned by mutations is filtered too');
  assert.equal(stickerPackStore.getReactionPacks().length, 1);
  assert.deepEqual(stickerPackStore.getEnabledCustomKeywords(), []);
  const other = create(memoryStore());
  assert.equal((await other.import([{ id: '0'.repeat(64), name: '错误引用', assetFile: 'a' }], () => png)).failed.length, 1);
  assert.equal(other.list().length, 0);
  await assert.rejects(other.addDataUrl('data:image/png;base64,PHN2Zz48L3N2Zz4=', '伪装 SVG'));
  assert.equal(normalizeReactionEntries([{ emoji: 'custom:bad', actors: ['__self__'] }]).length, 0);
  assert.equal(item.emoji.length, 71);
  stickerPackStore.update(() => ({ packs: [] }));
});

// Exercise the actual importer methods without mounting the application's unrelated services.
const importerMethod = (file, name, context = {}) => {
  const source = readFileSync(new URL(`../../src/scripts/ui/${file}`, import.meta.url), 'utf8');
  const start = source.search(new RegExp(`  (?:async )?${name}\\(`));
  assert(start >= 0);
  const end = /\r?\n  }\r?\n/.exec(source.slice(start));
  const method = source.slice(start, start + end.index + end[0].length);
  return runInNewContext(`({${method}}).${name}`, { ensureArray: value => Array.isArray(value) ? value : [],
    stickerPackStore, customReactionAssets, customReactionImportWarning, ...context });
};

test('package preview cancellation is read-only; confirmed chat imports restore images and reserve all pack IDs', async () => {
  stickerPackStore.update(() => ({ packs: [] }));
  const item = await customReactionAssets.addDataUrl(png, '回归图片');
  const packId = `reaction-${item.id}`;
  for (const file of ['experience-pack-transfer.js', 'custom-bundle-exporter.js']) {
    assert.notEqual(importerMethod(file, 'getUniqueStickerPackId')(packId), packId, 'normal sticker imports must reserve reaction pack IDs');
  }
  await customReactionAssets.remove(item.emoji);
  const records = [{ id: item.id, name: item.name, assetFile: 'reaction.png' }];
  const buttons = [];
  let previewImports = 0;
  const dialog = importerMethod('experience-pack-transfer.js', 'showImportDialog', {
    customReactionAssets: { import: async () => { previewImports++; return { failed: [] }; } },
    createOverlay: () => ({ body: { querySelector: () => null }, footer: { append: (...items) => buttons.push(...items) }, close() {} }),
    escapeHtml: value => value, buildDialogButtonStyle: () => '',
    document: { createElement: () => ({ style: {}, addEventListener(type, handler) { this[type] = handler; } }) },
  });
  const pending = dialog({ reactionAssets: records });
  assert.equal(previewImports, 0);
  buttons[0].click(); assert.equal(await pending, null);
  assert.equal(customReactionAssets.list().length, 0);

  const session = {}, messages = [{ id: 'm', meta: { reactions: toggleReactionActor([], item.emoji, '__self__', { name: item.name }) } }];
  const warnings = [];
  const restore = importerMethod('experience-pack-transfer.js', 'restoreChatHistory', { ...experienceUtils, window: { toastr: { warning: text => warnings.push(text) } } });
  assert.equal(await restore.call({ chatStore: { _ensureSession: () => session, _persist() {} }, getEntryDataUrl: () => png }, 'room', { chatSession: {}, chatCurrent: messages, reactionAssets: records }), true);
  assert.equal(customReactionAssets.find(item.emoji).name, item.name);
  assert.equal(session.messages[0].meta.reactions[0].emoji, item.emoji);
  await customReactionAssets.remove(item.emoji);
  const restoreBundle = importerMethod('custom-bundle-exporter.js', 'restoreCustomBundleRoomConversation', { getPerfNow: Date.now, roundDuration: value => value });
  let restored = false;
  await restoreBundle.call({ getEntryDataUrl: () => png, restoreConversationToStore: async () => {
    assert(customReactionAssets.find(item.emoji)); restored = true;
  } }, { packageData: {}, runtime: { chatStore: {} }, sessionId: 'room', roomPackage: { chatCurrent: messages, roomConfig: { reactions: records } } });
  assert.equal(restored, true);
  assert.equal(warnings.length, 0);
  stickerPackStore.update(() => ({ packs: [] }));
});

test('removing a saved reaction releases its file before a later upload can reuse its identity', async () => {
  const removed = [], store = memoryStore();
  const assets = createCustomReactionAssets({ store, saveImage: async () => ({ path: 'owned-reaction.webp' }), removeImage: async path => removed.push(path) });
  const item = await assets.addDataUrl(png, '图片');
  const removal = assets.remove(item.emoji);
  const replacement = assets.addDataUrl(png, '重新添加');
  await removal; await replacement;
  assert.deepEqual(removed, ['owned-reaction.webp']);
  assert.equal(assets.find(item.emoji).name, '重新添加');
});
