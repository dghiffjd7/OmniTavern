// 与本机 SillyTavern 互测 CCv3（只读调用 ST 的解析／写入／校验函数，不启动服务、不写 ST 目录）。
// 用法：node scripts/dev/st-ccv3-interop-check.mjs <SillyTavern 根目录> [我们导出的 .charx 文件]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

const [stRoot, charxFile] = process.argv.slice(2);
if (!stRoot) {
  console.error('usage: node scripts/dev/st-ccv3-interop-check.mjs <SillyTavern root> [ours.charx]');
  process.exit(2);
}
const stImport = rel => import(pathToFileURL(path.join(stRoot, rel)).href);
const { read: stRead, write: stWrite } = await stImport('src/character-card-parser.js');
const { TavernCardValidator } = await stImport('src/validator/TavernCardValidator.js');

const { buildTavernV2CharacterCard, buildCharacterCardV3, embedTavernV2CharacterCardInPng } = await import('../../src/scripts/utils/character-card-export.js');
const { extractCharacterCardFromPng, normalizeCharacterCard } = await import('../../src/scripts/utils/character-card.js');

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const results = [];

// 1. 我们导出的 PNG → ST 读取：ST 优先 ccv3，校验为 V3；chara 副本为 V2
{
  const v2 = buildTavernV2CharacterCard({ persona: { name: '互导测试' }, rawCard: { spec: 'chara_card_v3', data: { name: '互导测试', first_mes: '你好', nickname: '互' } } });
  const png = embedTavernV2CharacterCardInPng(new Uint8Array(ONE_PIXEL_PNG), v2, { v3Card: buildCharacterCardV3(v2) });
  const stJson = JSON.parse(stRead(Buffer.from(png.bytes)));
  assert.equal(stJson.spec, 'chara_card_v3');
  assert.equal(stJson.data.name, '互导测试');
  assert.equal(stJson.data.nickname, '互');
  // validate() 先试 V1（我们保留了 V1 镜像字段，会先命中 1），这里直接调各版本的校验
  assert.equal(new TavernCardValidator(stJson).validateV3(), true, `ST validates our ccv3 chunk as V3`);
  const v2Validator = new TavernCardValidator(v2);
  assert.equal(v2Validator.validateV2(), true, `ST validates our chara chunk as V2: ${v2Validator.lastValidationError}`);
  results.push('ours PNG → ST read: ccv3 preferred, V3/V2 both valid');
}

// 2. ST 写出的 PNG → 我们读取：同样优先 ccv3
{
  const stCard = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'ST 写出', description: '', personality: '', scenario: '', first_mes: 'hi', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } };
  const written = stWrite(ONE_PIXEL_PNG, JSON.stringify(stCard));
  const bytes = new Uint8Array(written);
  const found = extractCharacterCardFromPng(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(found.keyword, 'ccv3');
  assert.deepEqual(found.keywords, ['ccv3', 'chara']);
  const card = normalizeCharacterCard(found.json);
  assert.deepEqual([card.format, card.name, card.first_mes], ['ccv3', 'ST 写出', 'hi']);
  results.push('ST write PNG → ours: ccv3 preferred, fields intact');
}

// 3. 我们导出的 .charx → ST CharXParser：card.json、头像与资源清单
if (charxFile) {
  const { CharXParser } = await stImport('src/charx.js');
  const parsed = await new CharXParser(readFileSync(charxFile)).parse();
  assert.equal(parsed.card.spec, 'chara_card_v3');
  assert.equal(parsed.card.data.name, '互导测试');
  assert.ok(Buffer.isBuffer(parsed.avatar) && parsed.avatar.length > 0, 'ST finds our embedded main icon');
  assert.equal(new TavernCardValidator(parsed.card).validateV3(), true);
  results.push(`ours .charx → ST CharXParser: V3 card, avatar ${parsed.avatar.length} bytes, auxiliary assets ${parsed.auxiliaryAssets.length}`);
}

results.forEach(line => console.log(`ok - ${line}`));
