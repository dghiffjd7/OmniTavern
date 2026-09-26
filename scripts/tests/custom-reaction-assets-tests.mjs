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
  assert.deepEqual(await imported.import(bundle, path => exported.get(path)), { failed: [], added: [item.emoji] });
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

test('re-adding an image whose file went missing restores the file instead of returning the dead record', async () => {
  const store = memoryStore();
  let saved = 0, fileOk = true;
  const assets = createCustomReactionAssets({ store, checkImage: async () => fileOk,
    saveImage: async () => ({ dataUrl: '', path: `C:/attachments/sticker_pack_assets/r-${++saved}.png` }) });
  const first = await assets.addDataUrl(png, '小猫');
  assert.equal(first.path, 'C:/attachments/sticker_pack_assets/r-1.png');
  assert.equal((await assets.addDataUrl(png, '小猫')).path, first.path, 'an intact file is reused');
  fileOk = false;
  const repaired = await assets.addDataUrl(png, '小猫');
  assert.equal(repaired.emoji, first.emoji, 'message references stay valid');
  assert.equal(repaired.path, 'C:/attachments/sticker_pack_assets/r-2.png');
  assert.equal(assets.list().length, 1);
});

test('removing a reaction announces the change so quick bars can drop it', async () => {
  const store = memoryStore(), assets = create(store);
  const item = await assets.addDataUrl(png, '小猫');
  const events = [], target = new EventTarget();
  globalThis.dispatchEvent = event => target.dispatchEvent(event);
  target.addEventListener('custom-reactions-changed', event => events.push(event.detail));
  try { await assets.remove(item.emoji); } finally { delete globalThis.dispatchEvent; }
  assert.deepEqual(events, [{ removed: item.emoji }]);
});

test('image dimensions are read from the file header before decoding', async () => {
  const { readImageHeaderDimensions, REACTION_SOURCE_MAX_PIXELS } = await import('../../src/scripts/utils/image.js');
  const bytes = Uint8Array.from(atob(png.split(',')[1]), char => char.charCodeAt(0));
  assert.deepEqual(readImageHeaderDimensions(bytes), { width: 1, height: 1 });
  const huge = bytes.slice(); huge.set([0, 0, 0x27, 0x10, 0, 0, 0x27, 0x10], 16);
  const dims = readImageHeaderDimensions(huge);
  assert.equal(dims.width * dims.height > REACTION_SOURCE_MAX_PIXELS, true, 'a 10000×10000 PNG is rejected before decoding');
  const jpeg = new Uint8Array([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 11, 8, 0, 120, 0, 200, 1, 1, 17, 0]);
  assert.deepEqual(readImageHeaderDimensions(jpeg), { width: 200, height: 120 });
});

test('imported assets must be static images within 96px; the upload keeps the batch going', async () => {
  const { isAnimatedImageBytes } = await import('../../src/scripts/utils/image.js');
  const bytes = Uint8Array.from(atob(png.split(',')[1]), char => char.charCodeAt(0));
  const toUrl = array => `data:image/png;base64,${btoa(String.fromCharCode(...array))}`;
  const big = bytes.slice(); big.set([0, 0, 0, 200, 0, 0, 0, 200], 16);
  // An APNG carries an acTL chunk before IDAT.
  const actl = new Uint8Array([0, 0, 0, 8, ...'acTL'.split('').map(c => c.charCodeAt(0)), 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
  const animated = new Uint8Array([...bytes.slice(0, 33), ...actl, ...bytes.slice(33)]);
  assert.equal(isAnimatedImageBytes(animated), true);
  assert.equal(isAnimatedImageBytes(bytes), false);
  const webpAnim = new Uint8Array(30); webpAnim.set([...'RIFF'].map(c => c.charCodeAt(0)), 0); webpAnim.set([...'WEBPVP8X'].map(c => c.charCodeAt(0)), 8); webpAnim[20] = 0x02;
  assert.equal(isAnimatedImageBytes(webpAnim), true);
  const assets = create(memoryStore());
  const result = await assets.import([{ id: 'a'.repeat(64), assetFile: 'big' }, { id: 'b'.repeat(64), assetFile: 'anim' }], ref => toUrl(ref === 'big' ? big : animated));
  assert.equal(result.failed.length, 2);
  assert.equal(result.failed.every(row => row.message === '反应素材需为 96px 以内的静态图片'), true);
  assert.equal(assets.list().length, 0);
});

test('a failed restore rolls back only the reactions this import added; file delete failures do not surface', async () => {
  const store = memoryStore(), removed = [];
  const assets = createCustomReactionAssets({ store, saveImage: async () => ({ path: 'p.png' }), removeImage: async path => { removed.push(path); throw new Error('invalid attachment path'); } });
  const kept = await assets.addDataUrl(png, '原有');
  const result = await assets.import([{ id: kept.id, name: '原有', assetFile: 'x' }], () => png);
  assert.deepEqual(result.added, [], 'an existing reaction is not counted as added');
  await assets.rollbackImport(result);
  assert(assets.find(kept.emoji));
  await assets.remove(kept.emoji);
  assert.equal(assets.find(kept.emoji), null, 'the record is removed even when the file delete fails');
  assert.deepEqual(removed, ['p.png']);
  const fresh = createCustomReactionAssets({ store: memoryStore(), saveImage: async dataUrl => ({ dataUrl, path: '' }) });
  const added = await fresh.import([{ id: kept.id, name: '新', assetFile: 'x' }], () => png);
  assert.deepEqual(added.added, [kept.emoji]);
  await fresh.rollbackImport(added);
  assert.equal(fresh.list().length, 0);
});

test('a custom bundle whose conversation fails to restore does not keep its new reactions', async () => {
  stickerPackStore.update(() => ({ packs: [] }));
  const item = await customReactionAssets.addDataUrl(png, '回滚');
  await customReactionAssets.remove(item.emoji);
  const notes = [];
  const restoreBundle = importerMethod('custom-bundle-exporter.js', 'restoreCustomBundleRoomConversation', { getPerfNow: Date.now, roundDuration: value => value,
    logger: { warn() {} }, getCustomBundleRoomRestoreFailureLogMessage: () => '', buildCustomBundleRoomRestoreFailureNote: () => 'restore failed' });
  await restoreBundle.call({ getEntryDataUrl: () => png, restoreConversationToStore: async () => { throw new Error('broken chat'); } },
    { packageData: {}, runtime: { chatStore: {} }, sessionId: 'room', diagnosticsNotes: notes, roomPackage: { chatCurrent: [{}], roomConfig: { reactions: [{ id: item.id, name: item.name, assetFile: 'r.png' }] } } });
  assert.deepEqual(notes, ['restore failed']);
  assert.equal(customReactionAssets.find(item.emoji), null);
  stickerPackStore.update(() => ({ packs: [] }));
});
