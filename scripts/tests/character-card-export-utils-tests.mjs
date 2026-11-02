import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildTavernV2CharacterCard,
  embedTavernV2CharacterCardInPng,
  sanitizeCharacterCardExportName,
} from '../../src/scripts/utils/character-card-export.js';
import { extractCharacterCardJsonFromPng } from '../../src/scripts/utils/character-card.js';
import { CharacterCardExporter } from '../../src/scripts/ui/character-card-exporter.js';

const ONE_PIXEL_PNG = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9RYVFHYAAAAASUVORK5CYII=',
  'base64',
));

{
  const raw = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Alice',
      description: 'Original description',
      personality: 'Calm',
      scenario: 'A port',
      first_mes: 'Hello',
      mes_example: '<START>',
      creator_notes: 'Keep this',
      system_prompt: 'Stay in character',
      post_history_instructions: '',
      alternate_greetings: ['Welcome back'],
      tags: ['test'],
      creator: 'Author',
      character_version: '1.2',
      character_book: { extensions: {}, entries: [{ keys: ['port'], content: 'Lore', extensions: {}, enabled: true, insertion_order: 10 }] },
      extensions: { regex_scripts: [{ id: 'rx-1' }], unknown_extension: { keep: true } },
    },
    foreign_root_field: { keep: true },
  };
  const exported = buildTavernV2CharacterCard({
    persona: { name: 'Alice 1.1', description: 'Edited in OmniTavern' },
    rawCard: raw,
  });
  assert.equal(exported.spec, 'chara_card_v2');
  assert.equal(exported.spec_version, '2.0');
  assert.equal(exported.data.name, 'Alice 1.1');
  assert.equal(exported.data.description, 'Edited in OmniTavern');
  assert.equal(exported.data.personality, 'Calm');
  assert.deepEqual(exported.data.character_book, raw.data.character_book);
  assert.deepEqual(exported.data.extensions.unknown_extension, { keep: true });
  assert.deepEqual(exported.foreign_root_field, { keep: true });
  assert.equal(raw.data.name, 'Alice', 'export must not mutate the retained source card');
  console.log('ok - V2 export preserves source fields and applies editable persona fields');
}

{
  const exported = buildTavernV2CharacterCard({
    persona: { name: 'Legacy', description: '' },
    rawCard: {
      name: 'Old name',
      description: 'V1 description',
      first_mes: 'Hi',
      extensions: { custom: 7 },
    },
  });
  assert.equal(exported.spec, 'chara_card_v2');
  assert.equal(exported.data.name, 'Legacy');
  assert.equal(exported.data.description, 'V1 description');
  assert.equal(exported.data.first_mes, 'Hi');
  assert.deepEqual(exported.data.extensions, { custom: 7 });
  assert.deepEqual(exported.data.alternate_greetings, []);
  assert.deepEqual(exported.data.tags, []);
  console.log('ok - V1 and locally created cards export as complete V2 JSON');
}

{
  const card = buildTavernV2CharacterCard({
    persona: { name: 'PNG Card', description: 'Round trip' },
  });
  const first = embedTavernV2CharacterCardInPng(ONE_PIXEL_PNG, card);
  const second = embedTavernV2CharacterCardInPng(first, { ...card, data: { ...card.data, name: 'Updated PNG Card' } });
  const parsed = extractCharacterCardJsonFromPng(second.buffer);
  assert.equal(parsed.spec, 'chara_card_v2');
  assert.equal(parsed.data.name, 'Updated PNG Card');
  assert.equal(second.keywordCount, 1, 'rewriting must leave one authoritative chara chunk');
  assert.equal(second.removedCharacterChunkCount, 1);
  console.log('ok - PNG writer embeds one replaceable SillyTavern chara chunk');
}

{
  assert.equal(sanitizeCharacterCardExportName(' Alice/测试:*? ', 'character'), 'Alice_测试');
  assert.throws(
    () => embedTavernV2CharacterCardInPng(new Uint8Array([1, 2, 3]), {}),
    /PNG/,
  );
  console.log('ok - export filename and invalid image input are guarded');
}

{
  const exporter = new CharacterCardExporter({
    appBridge: {
      loadPersonaCard: async () => ({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: { name: 'Sidecar', description: 'Complete source', extensions: {} },
      }),
    },
  });
  const card = await exporter.buildCard({
    id: 'persona-sidecar',
    name: 'Sidecar updated',
    source: { originalCardStored: true },
  });
  assert.equal(card.data.name, 'Sidecar updated');
  assert.equal(card.data.description, 'Complete source');

  const missingExporter = new CharacterCardExporter({
    appBridge: { loadPersonaCard: async () => null },
  });
  await assert.rejects(
    () => missingExporter.buildCard({ id: 'missing', name: 'Missing', source: { originalCardStored: true } }),
    /不完整文件/,
  );
  console.log('ok - retained sidecar is loaded and read failures never export a partial card');
}

{
  const panelSource = await readFile(new URL('../../src/scripts/ui/persona-panel.js', import.meta.url), 'utf8');
  assert.match(panelSource, /导出角色卡/);
  assert.match(panelSource, /PNG 角色卡/);
  assert.match(panelSource, /JSON 角色卡/);
  assert.match(panelSource, /exportPersonaCard/);
  console.log('ok - character-card-only UI exposes PNG and JSON export choices');
}

console.log('character-card-export-utils-tests passed');

// CCv3 导出：PNG 同时写 chara 与 ccv3（同一快照），读取优先 ccv3；.charx／PNG 的资源清单
{
  const { buildCharacterCardV3 } = await import('../../src/scripts/utils/character-card-export.js');
  const { extractCharacterCardFromPng } = await import('../../src/scripts/utils/character-card.js');
  const { buildExportCardAssets } = await import('../../src/scripts/ui/character-card-exporter.js');
  const { buildTavernV2CharacterCard, embedTavernV2CharacterCardInPng } = await import('../../src/scripts/utils/character-card-export.js');
  const v2 = buildTavernV2CharacterCard({ persona: { name: '船长' }, rawCard: { spec: 'chara_card_v3', data: { name: '旧名', first_mes: 'hi', nickname: '小船', assets: [{ type: 'icon', uri: 'embeded://assets/icon/old.png', name: 'main' }, { type: 'emotion', uri: 'embeded://assets/joy.png', name: 'joy' }, { type: 'background', uri: 'https://x/bg.png', name: 'bg' }] } } });
  assert.equal(v2.spec, 'chara_card_v2');
  const v3 = buildCharacterCardV3(v2);
  assert.deepEqual([v3.spec, v3.spec_version, v3.data.name, v3.data.nickname, v3.data.group_only_greetings], ['chara_card_v3', '3.0', '船长', '小船', []]);
  assert.equal(v2.spec, 'chara_card_v2', 'the V2 snapshot is not mutated');

  const pngAssets = buildExportCardAssets(v2.data.assets);
  assert.deepEqual(pngAssets.assets.map(asset => asset.uri), ['ccdefault:', 'https://x/bg.png'], 'a PNG cannot carry package assets');
  const charxNoSource = buildExportCardAssets(v2.data.assets, { container: 'charx' });
  assert.deepEqual(charxNoSource.assets.map(asset => asset.uri), ['embeded://assets/icon/images/main.png', 'https://x/bg.png']);
  const charxWithSource = buildExportCardAssets(v2.data.assets, { container: 'charx', hasSourcePackage: true });
  assert.deepEqual(charxWithSource.assets.map(asset => asset.uri), ['embeded://assets/icon/images/main.png', 'embeded://assets/joy.png', 'https://x/bg.png']);
  assert.deepEqual(charxWithSource.oldIconPaths, ['assets/icon/old.png']);

  const png = embedTavernV2CharacterCardInPng(ONE_PIXEL_PNG, v2, { v3Card: buildCharacterCardV3(v2, { assets: pngAssets.assets }) });
  assert.equal(png.keywordCount, 2);
  const read = extractCharacterCardFromPng(png.buffer);
  assert.deepEqual([read.keyword, read.keywords, read.json.spec, read.json.data.name], ['ccv3', ['ccv3', 'chara'], 'chara_card_v3', '船长']);
  const rewritten = embedTavernV2CharacterCardInPng(png.bytes, v2, { v3Card: buildCharacterCardV3(v2) });
  assert.equal(rewritten.removedCharacterChunkCount, 2, 'old chara and ccv3 chunks are replaced together');
  console.log('ok - PNG export writes matching chara and ccv3 chunks and .charx keeps only satisfiable assets');
}

// APNG 角色卡：acTL／fcTL／fdAT 动画块与 chara／ccv3／资源块共存时照常读取，导出时动画块原样保留
{
  const { deflateSync } = await import('node:zlib');
  const { extractCharacterCardFromPng, extractPngEmbeddedAssets } = await import('../../src/scripts/utils/character-card.js');
  globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };
  const { inspectAttachmentFile } = await import('../../src/scripts/import/attachment-file-inspector.js');
  const CRC_TABLE = Array.from({ length: 256 }, (_v, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const u32 = value => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  const chunk = (type, data = []) => {
    const body = Uint8Array.from([...Buffer.from(type, 'latin1'), ...data]);
    return Uint8Array.from([...u32(data.length), ...body, ...u32(crc32(body))]);
  };
  const text = (keyword, value) => chunk('tEXt', [...Buffer.from(`${keyword}\0`, 'latin1'), ...Buffer.from(value, 'latin1')]);
  const b64 = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  const fcTL = seq => chunk('fcTL', [...u32(seq), ...u32(1), ...u32(1), ...u32(0), ...u32(0), 0, 1, 0, 10, 0, 0]);
  const frame = rgba => [...deflateSync(Buffer.from([0, ...rgba]))];
  const apng = (textChunks = [], { textFirst = false } = {}) => {
    const animation = [
      chunk('acTL', [...u32(2), ...u32(0)]),
      fcTL(0),
      chunk('IDAT', frame([255, 0, 0, 255])),
      fcTL(1),
      chunk('fdAT', [...u32(2), ...frame([0, 0, 255, 255])]),
    ];
    const parts = [
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', [...u32(1), ...u32(1), 8, 6, 0, 0, 0]),
      ...(textFirst ? [...textChunks, ...animation] : [...animation, ...textChunks]),
      chunk('IEND'),
    ];
    return Uint8Array.from(parts.flatMap(part => [...part]));
  };
  const rawChunks = (bytes) => {
    const out = [];
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = Buffer.from(bytes.subarray(offset, offset + 4)).readUInt32BE(0);
      out.push({ type: Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString('latin1'), raw: Buffer.from(bytes.subarray(offset, offset + 12 + length)) });
      offset += 12 + length;
    }
    return out;
  };
  const types = bytes => rawChunks(bytes).map(item => item.type);
  const animationChunks = bytes => rawChunks(bytes).filter(item => ['acTL', 'fcTL', 'IDAT', 'fdAT'].includes(item.type)).map(item => item.raw.toString('hex'));
  const toBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const iconApng = apng();
  const v2 = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '旧副本', first_mes: 'hi' } };
  const v3 = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '动图船长', first_mes: 'hi', assets: [{ type: 'emotion', uri: 'embeded://0', name: 'joy', ext: 'apng' }] } };
  const card = apng([text('chara', b64(v2)), text('ccv3', b64(v3)), text('chara-ext-asset_:0', Buffer.from(iconApng).toString('base64'))]);

  for (const bytes of [card, apng([text('chara', b64(v2)), text('ccv3', b64(v3))], { textFirst: true })]) {
    const read = extractCharacterCardFromPng(toBuffer(bytes));
    assert.deepEqual([read.keyword, read.keywords, read.json.data.name], ['ccv3', ['ccv3', 'chara'], '动图船长']);
  }
  const v3Only = extractCharacterCardFromPng(toBuffer(apng([text('ccv3', b64(v3))])));
  assert.deepEqual([v3Only.keyword, v3Only.keywords, v3Only.json.spec], ['ccv3', ['ccv3'], 'chara_card_v3']);

  const inspected = inspectAttachmentFile({ name: '动图船长.png', mime: 'image/png', bytes: card });
  assert.deepEqual([inspected.format, inspected.details.pngKeyword, inspected.title], ['character_card', 'ccv3', '动图船长']);
  assert.equal(inspectAttachmentFile({ name: 'plain.png', mime: 'image/png', bytes: iconApng }).format, 'image', 'an APNG without card text is just an image');

  const assets = extractPngEmbeddedAssets(toBuffer(card), [{ path: '0', ext: 'apng' }]);
  assert.equal(assets.get('0'), `data:image/png;base64,${Buffer.from(iconApng).toString('base64')}`, 'APNG asset bytes come back unchanged');

  const exported = embedTavernV2CharacterCardInPng(card, v2, { v3Card: v3 });
  assert.equal(exported.removedCharacterChunkCount, 2, 'old chara and ccv3 chunks are replaced');
  assert.deepEqual(types(exported.bytes), ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'tEXt', 'tEXt', 'tEXt', 'IEND']);
  assert.deepEqual(animationChunks(exported.bytes), animationChunks(card), 'animation chunks keep their bytes and order');
  const reread = extractCharacterCardFromPng(exported.buffer);
  assert.deepEqual([reread.keyword, reread.json.data.name], ['ccv3', '动图船长']);
  assert.equal(extractPngEmbeddedAssets(exported.buffer, [{ path: '0', ext: 'apng' }]).size, 1, 'the asset chunk survives export');
  console.log('ok - APNG cards: animation chunks coexist with chara/ccv3/asset text and survive export');
}
