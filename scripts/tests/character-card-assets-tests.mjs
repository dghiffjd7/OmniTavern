import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

const { planCardAssetImport, resolveCardAssetImages, resolveCardAssetSource } = await import('../../src/scripts/utils/character-card-assets.js');
const { extractPngEmbeddedAssets, loadCharacterCardAssets } = await import('../../src/scripts/utils/character-card.js');
const { createCharacterCardAssetWriter } = await import('../../src/scripts/ui/character-card-asset-writer.js');

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
const b64 = bytes => Buffer.from(bytes).toString('base64');

// 分类：表情／背景导入，第一张背景以外跳过；远程资源不下载；JSON 卡里的包内资源不存在
{
  assert.deepEqual(resolveCardAssetSource('embeded://assets/a.png', 'charx'), { source: 'package', path: 'assets/a.png' });
  assert.deepEqual(resolveCardAssetSource('embedded://a.png', 'json'), { source: 'missing_package', path: 'a.png' });
  assert.deepEqual(resolveCardAssetSource('__asset:3', 'png'), { source: 'png_chunk', path: '3' });
  assert.equal(resolveCardAssetSource('https://x/y.png').source, 'remote');
  const card = { assets: [
    { type: 'icon', uri: 'ccdefault:', name: 'main' },
    { type: 'emotion', uri: 'embeded://assets/joy.png', name: 'joy', ext: 'png' },
    { type: 'expression', uri: 'embeded://assets/sad.webp', name: 'sad' },
    { type: 'background', uri: 'embeded://assets/bg1.jpg', name: 'bg1' },
    { type: 'background', uri: 'embeded://assets/bg2.jpg', name: 'bg2' },
    { type: 'emotion', uri: 'https://example.com/angry.png', name: 'angry' },
    { type: 'emotion', uri: 'embeded://assets/readme.txt', name: 'txt' },
    { type: 'sound', uri: 'embeded://assets/bgm.mp3', name: 'bgm' },
  ] };
  const planned = planCardAssetImport(card, { container: 'charx' });
  assert.deepEqual(planned.sprites.map(item => item.name), ['joy', 'sad']);
  assert.deepEqual(planned.backgrounds.map(item => item.name), ['bg1']);
  assert.deepEqual(planned.skipped.map(item => [item.name, item.reason]), [
    ['bg2', 'extra_background'], ['angry', 'remote_not_downloaded'], ['txt', 'not_an_image'], ['bgm', 'unsupported_asset_type'],
  ]);
  const resolved = resolveCardAssetImages(planned, new Map([['assets/joy.png', 'data:image/png;base64,AA'], ['assets/bg1.jpg', 'data:image/jpeg;base64,BB']]));
  assert.deepEqual(resolved.sprites.map(item => item.name), ['joy']);
  assert.deepEqual(resolved.skipped.at(-1), { type: 'expression', name: 'sad', reason: 'missing_asset' });
  console.log('ok - CCv3 assets are classified into expressions, one background and honest skips');
}

// PNG 内嵌资源块：chara-ext-asset_:<key>，按文件头识别图片类型；.charx 资源走原生读取
{
  const chunk = (keyword, text) => {
    const body = new TextEncoder().encode(`${keyword}\0${text}`);
    const out = new Uint8Array(12 + body.length);
    new DataView(out.buffer).setUint32(0, body.length);
    out.set(new TextEncoder().encode('tEXt'), 4);
    out.set(body, 8);
    return out;
  };
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('chara-ext-asset_:0', b64(PNG_BYTES)), chunk('chara-ext-asset_1', 'not base64 !!'), chunk('chara-ext-asset_:9', b64([1, 2]))];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  parts.forEach((part) => { png.set(part, offset); offset += part.length; });
  const found = extractPngEmbeddedAssets(png.buffer, [{ path: '0', ext: '' }, { path: '1', ext: 'png' }]);
  assert.deepEqual([...found.keys()], ['0']);
  assert.match(found.get('0'), /^data:image\/png;base64,/);

  const card = { format: 'ccv3', assets: [{ type: 'emotion', uri: 'embeded://assets/joy.png', name: 'joy' }, { type: 'background', uri: 'data:image/png;base64,QQ==', name: 'bg' }] };
  const assets = await loadCharacterCardAssets(card, {
    container: 'charx', charxBytes: new Uint8Array([9]),
    invoke: async (command, args) => {
      assert.deepEqual([command, args.assetPaths], ['read_charx', ['assets/joy.png']], 'only package assets are requested from the native side');
      return { cardText: '{}', entries: [], assets: [{ path: 'assets/joy.png', mime: 'image/png', base64: b64(PNG_BYTES) }] };
    },
  });
  assert.deepEqual([assets.sprites.length, assets.backgrounds[0].dataUrl], [1, 'data:image/png;base64,QQ==']);
  console.log('ok - PNG asset chunks and .charx assets are read with type sniffing and limits');
}

// 写入器：表情包绑定到角色创意写作会话；背景写入会话设置；撤销时删贴图包、文件并恢复原设置
{
  const packs = [];
  const files = [];
  const settings = { 'rp:p1': { foo: 1 } };
  const writer = createCharacterCardAssetWriter({
    stickerPackStore: { upsertPack: pack => packs.push(pack), removePack: id => packs.splice(packs.findIndex(p => p.id === id), 1) },
    saveStickerAsset: async (dataUrl, name) => (name === 'nofile' ? '' : `/stickers/${name}.png`),
    deleteStickerAsset: async path => files.push(['delete_sticker', path]),
    chatStore: { getSessionSettings: sid => settings[sid] || null, setSessionSettings: (sid, value) => { settings[sid] = value; } },
    saveWallpaper: async args => ({ path: `/wallpapers/${args.sessionId}/${args.fileName}.png` }),
    deleteWallpaper: async args => files.push(['delete_wallpaper', args.path]),
    getRpSessionId: id => `rp:${id}`,
    createId: prefix => `${prefix}-x`,
    now: () => 42,
  });
  const pack = await writer.createExpressionPack({ personaId: 'p1', displayName: '船长', images: [{ name: 'joy', dataUrl: 'data:image/png;base64,AA' }, { name: 'nofile', dataUrl: 'data:image/png;base64,BB' }] });
  assert.deepEqual([packs[0].name, packs[0].boundSessions, packs[0].stickers.map(s => [s.keyword, s.path, s.dataUrl])], ['船长·表情', ['rp:p1'], [['joy', '/stickers/joy.png', ''], ['nofile', '', 'data:image/png;base64,BB']]]);
  const bg = await writer.setRoleBackground({ personaId: 'p1', image: { name: 'room', dataUrl: 'data:image/png;base64,CC' } });
  assert.deepEqual([settings['rp:p1'].foo, settings['rp:p1'].wallpaper.path, settings['rp:p1'].wallpaper.updatedAt], [1, '/wallpapers/rp:p1/room.png', 42]);
  await writer.restoreRoleBackground(bg);
  await writer.removeExpressionPack(pack);
  assert.deepEqual([settings['rp:p1'], packs.length], [{ foo: 1 }, 0]);
  assert.deepEqual(files, [['delete_wallpaper', '/wallpapers/rp:p1/room.png'], ['delete_sticker', '/stickers/joy.png']]);
  assert.equal(await writer.saveOriginalCharx('p1', new Uint8Array(1)), false, 'without a native saver nothing is stored');
  console.log('ok - card asset writer creates and undoes the expression pack and session background');
}
