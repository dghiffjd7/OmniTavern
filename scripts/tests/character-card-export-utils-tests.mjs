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
