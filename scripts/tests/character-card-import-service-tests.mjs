import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

const { createCharacterCardImportService } = await import('../../src/scripts/import/character-card-import-service.js');
const { normalizeCharacterCard } = await import('../../src/scripts/utils/character-card.js');

const card = normalizeCharacterCard({
  spec: 'chara_card_v2',
  data: {
    name: '星港船长', description: '船长', first_mes: '你好', alternate_greetings: ['再见'],
    system_prompt: '保持角色', character_book: { entries: [{ keys: ['港'], content: '星港' }] },
    extensions: { regex_scripts: [{ scriptName: 'r', findRegex: '/a/', replaceString: 'b' }], tavern_helper: { scripts: [{ type: 'script', name: 's', content: '1' }] } },
  },
});

const setup = ({ failAt = '', existing = [{ id: 'p-old', name: '原卡' }] } = {}) => {
  const log = [];
  const personas = existing.map(item => ({ ...item, source: {} }));
  let active = 'p-old';
  const fail = step => { if (failAt === step) throw new Error(`${step} down`); };
  const service = createCharacterCardImportService({
    personaStore: {
      getAll: () => personas,
      getActive: () => personas.find(item => item.id === active) || null,
      create: async (data) => { const persona = { id: `p-${personas.length + 1}`, ...data }; personas.push(persona); log.push(['create', persona.id]); return persona; },
      update: async (id, patch) => { fail('bind'); Object.assign(personas.find(item => item.id === id), patch); log.push(['update', id]); },
    },
    activatePersona: async (id) => { active = id; log.push(['activate', id]); },
    savePersonaCard: async () => true,
    writeGreetings: async (id, greetings) => { fail('greetings'); log.push(['greetings', id, greetings.length]); },
    worldExists: () => false,
    saveWorldInfo: async (id) => { fail('worldbook'); log.push(['world', id]); return { ok: true }; },
    deleteWorld: async id => log.push(['delete_world', id]),
    writeMvu: async () => true,
    upsertSystemPreset: async () => { fail('system_prompt'); log.push(['preset']); return 'preset-1'; },
    removeSystemPreset: async id => log.push(['delete_preset', id]),
    upsertRegexSet: async (set) => { fail('regex'); log.push(['regex', set.bind?.worldId || '']); return 'set-1'; },
    removeRegexSet: async id => log.push(['delete_regex', id]),
    importScripts: async (args) => { fail('scripts'); log.push(['scripts', args.scope, args.scopeId]); return { count: 1, ids: ['s1'], compatibility: { runnableCount: 1 } }; },
    removeScripts: async id => log.push(['delete_scripts', id]),
    deletePersona: async (id) => { const index = personas.findIndex(item => item.id === id); personas.splice(index, 1); log.push(['delete_persona', id]); },
  });
  return { service, log, personas, getActive: () => active };
};

{
  const { service, log, personas, getActive } = setup();
  const plan = await service.plan({ card, fileName: 'card.json' });
  assert.deepEqual(plan.counts, { greetings: 2, worldEntries: 2, regexRules: 1, scripts: 1, mvuVariables: 0, expressions: 0, backgrounds: 0 });
  assert.deepEqual([plan.displayName, plan.nameConflict, plan.hasSystemPrompt], ['星港船长', false, true]);
  assert.equal(log.length, 0, 'planning never writes');

  const result = await service.commit(plan);
  assert.equal(result.ok, true);
  assert.deepEqual([result.activated, getActive()], [false, 'p-old'], 'the current card stays active unless asked');
  assert.deepEqual(log.map(item => item[0]), ['create', 'greetings', 'world', 'preset', 'regex', 'scripts', 'update']);
  assert.deepEqual(log.find(item => item[0] === 'greetings'), ['greetings', 'p-2', 2], 'greetings go to the new card, not the active one');
  assert.deepEqual(log.find(item => item[0] === 'regex'), ['regex', '星港船长'], 'card regex binds to the card worldbook');
  assert.deepEqual(log.find(item => item[0] === 'scripts'), ['scripts', 'character', 'p-2']);
  const created = personas.find(item => item.id === 'p-2');
  assert.deepEqual([created.source.worldbookId, created.source.systemPresetId, created.source.regexSetId], ['星港船长', 'preset-1', 'set-1']);
  console.log('ok - card import service plans read-only and imports everything into the new card without switching');
}

{
  const { service, log, getActive } = setup();
  const plan = await service.plan({ card });
  const result = await service.commit(plan, { include: { worldbook: false, scripts: false, regex: false }, activate: true });
  assert.deepEqual([result.ok, result.activated, getActive(), result.worldbookId, result.regexSetId], [true, true, 'p-2', '', '']);
  assert.deepEqual(log.map(item => item[0]), ['create', 'activate', 'greetings', 'preset', 'update'], 'switching happens before greetings, like the manual import');
  console.log('ok - card import service honours exclusions and switches before writing greetings when asked');
}

{
  const { service, log, personas, getActive } = setup({ failAt: 'regex' });
  const plan = await service.plan({ card });
  const result = await service.commit(plan, { activate: true });
  assert.deepEqual([result.ok, result.reason, result.step, result.rolledBack], [false, 'character_card_import_failed', 'regex', true]);
  assert.deepEqual(log.slice(-4).map(item => item[0]), ['delete_preset', 'delete_world', 'activate', 'delete_persona']);
  assert.deepEqual([getActive(), personas.map(item => item.id)], ['p-old', ['p-old']], 'the previous card is restored and the new card removed');
  assert.ok(!log.some(item => item[0] === 'delete_regex' || item[0] === 'delete_scripts'), 'only resources created in this run are undone');

  const late = setup({ failAt: 'bind' });
  const lateResult = await late.service.commit(await late.service.plan({ card }));
  assert.equal(lateResult.step, 'bind');
  assert.deepEqual(late.log.slice(-5).map(item => item[0]), ['delete_scripts', 'delete_regex', 'delete_preset', 'delete_world', 'delete_persona']);
  assert.ok(!late.log.some(item => item[0] === 'activate'), 'nothing to restore when the import did not switch');
  console.log('ok - a failed card import rolls back everything it created and restores the active card');
}

{
  const { service } = setup({ existing: [{ id: 'p-old', name: '星港船长' }] });
  assert.equal((await service.plan({ card })).nameConflict, true);
}

{
  const { service, personas } = setup();
  const v3 = normalizeCharacterCard({ spec: 'chara_card_v3', data: { name: 'V3', first_mes: 'hi', nickname: '小三', group_only_greetings: ['a', 'b'], assets: [{ type: 'icon', uri: 'ccdefault:' }, { type: 'background', uri: 'embeded://bg.png' }] } });
  const plan = await service.plan({ card: v3 });
  assert.deepEqual([plan.v3.nickname, plan.v3.groupOnlyGreetings, plan.v3.droppedAssets], ['小三', 2, 1]);
  assert.equal(plan.counts.greetings, 1, 'group-only greetings are not mixed into ordinary greetings');
  const result = await service.commit(plan, { include: { worldbook: false } });
  const created = personas.find(item => item.id === result.personaId);
  assert.deepEqual([created.source.cardSpec, created.source.nickname, created.source.format], ['ccv3', '小三', 'ccv3']);
  assert.equal((await service.plan({ card })).v3, null);
  console.log('ok - CCv3 cards keep their nickname and report the parts that are not imported');
}

// CCv3 资源：表情 → 贴图包、第一张背景 → 会话背景、原始 .charx 另存；背景失败时连同表情包一起回滚
{
  const run = async ({ failBackground = false, include = {} } = {}) => {
    const log = [];
    const base = setup();
    const service = createCharacterCardImportService({
      ...Object.fromEntries(Object.entries({}).map(x => x)),
      personaStore: { getAll: () => [], getActive: () => null, create: async data => ({ id: 'p-new', ...data }), update: async () => log.push(['update']) },
      activatePersona: async () => {}, savePersonaCard: async () => true, writeGreetings: async () => {},
      worldExists: () => false, saveWorldInfo: async () => ({ ok: true }), deleteWorld: async id => log.push(['delete_world', id]),
      writeMvu: async () => true, upsertSystemPreset: async () => '', removeSystemPreset: async () => {},
      upsertRegexSet: async () => '', removeRegexSet: async () => {}, importScripts: async () => null, removeScripts: async () => {},
      deletePersona: async id => log.push(['delete_persona', id]),
      createExpressionPack: async ({ personaId, displayName, images }) => { log.push(['pack', personaId, displayName, images.length]); return { packId: 'pack-1', paths: ['a.png'], count: images.length }; },
      removeExpressionPack: async created => log.push(['remove_pack', created.packId]),
      setRoleBackground: async ({ personaId, image }) => { if (failBackground) throw new Error('wallpaper down'); log.push(['background', personaId, image.name]); return { sessionId: `rp:${personaId}`, path: 'bg.png', previous: null }; },
      restoreRoleBackground: async created => log.push(['restore_background', created.sessionId]),
      saveOriginalCharx: async (id, bytes) => { log.push(['charx', id, bytes.length]); return true; },
    });
    void base;
    const v3card = normalizeCharacterCard({ spec: 'chara_card_v3', data: { name: '资源卡', first_mes: 'hi' } });
    const assets = { sprites: [{ name: 'joy', dataUrl: 'data:image/png;base64,AA' }, { name: 'sad', dataUrl: 'data:image/png;base64,BB' }], backgrounds: [{ name: 'room', dataUrl: 'data:image/png;base64,CC' }], skipped: [{ type: 'sound', name: 'bgm', reason: 'unsupported_asset_type' }] };
    const plan = await service.plan({ card: v3card, assets, charxBytes: new Uint8Array([1, 2, 3]) });
    return { log, plan, result: await service.commit(plan, { include }) };
  };
  const ok = await run();
  assert.deepEqual([ok.plan.counts.expressions, ok.plan.counts.backgrounds, ok.plan.v3.droppedAssets], [2, 1, 1]);
  assert.deepEqual(ok.log.filter(item => item[0] !== 'update'), [['pack', 'p-new', '资源卡', 2], ['background', 'p-new', 'room'], ['charx', 'p-new', 3]]);
  assert.deepEqual([ok.result.expressionCount, ok.result.backgroundSet, ok.result.originalCharxStored], [2, true, true]);
  const excluded = await run({ include: { expressions: false, background: false } });
  assert.deepEqual(excluded.log.map(item => item[0]), ['charx', 'update']);
  const failed = await run({ failBackground: true });
  assert.deepEqual([failed.result.ok, failed.result.step], [false, 'background']);
  assert.deepEqual(failed.log.slice(-3), [['remove_pack', 'pack-1'], ['delete_world', '资源卡'], ['delete_persona', 'p-new']], 'the expression pack is removed with the rest of the import');
  console.log('ok - CCv3 assets import as an expression pack and session background, and roll back together');
}
