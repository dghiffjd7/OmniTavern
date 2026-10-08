import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const {
  IMPORT_NAME_CONFLICT_DECISIONS,
  findRegexSetNameConflict,
  findPersonaNameConflict,
} = await import('../../src/scripts/ui/import-name-conflict-utils.js');

{
  assert.deepEqual(IMPORT_NAME_CONFLICT_DECISIONS, {
    cancel: 'cancel',
    keepBoth: 'keep_both',
    overwrite: 'overwrite',
  });
  console.log('ok - import name conflict decisions are a frozen tri-state');
}

{
  const sets = [
    { id: 'a', name: '战斗正则', bind: { type: 'world' } },
    { id: 'b', name: '战斗正则', bind: { type: 'preset' } },
    { id: 'c', name: '  旁白清理  ', bind: { type: 'world' } },
  ];
  assert.equal(findRegexSetNameConflict(sets, { name: '战斗正则', bindType: 'world' })?.id, 'a');
  assert.equal(findRegexSetNameConflict(sets, { name: '战斗正则', bindType: 'preset' })?.id, 'b');
  assert.equal(findRegexSetNameConflict(sets, { name: '旁白清理', bindType: 'world' })?.id, 'c');
  assert.equal(findRegexSetNameConflict(sets, { name: '旁白清理', bindType: 'preset' }), null);
  assert.equal(findRegexSetNameConflict(sets, { name: '不存在', bindType: 'world' }), null);
  assert.equal(findRegexSetNameConflict(sets, { name: '   ', bindType: 'world' }), null);
  assert.equal(findRegexSetNameConflict(null, { name: '战斗正则', bindType: 'world' }), null);
  console.log('ok - regex set conflicts match by trimmed name within the same bind type');
}

{
  const personas = [
    { id: 'p1', name: '艾拉' },
    { id: 'p2', name: '  小满 ' },
  ];
  assert.equal(findPersonaNameConflict(personas, '艾拉')?.id, 'p1');
  assert.equal(findPersonaNameConflict(personas, '小满')?.id, 'p2');
  assert.equal(findPersonaNameConflict(personas, '不存在'), null);
  assert.equal(findPersonaNameConflict(personas, ''), null);
  assert.equal(findPersonaNameConflict(undefined, '艾拉'), null);
  console.log('ok - persona conflicts match by trimmed name and tolerate missing lists');
}

{
  const panelSource = await readFile(new URL('../../src/scripts/ui/regex-panel.js', import.meta.url), 'utf8');
  const handlerStart = panelSource.indexOf("top.querySelector('#re-scoped-import').onclick");
  const handlerEnd = panelSource.indexOf("top.querySelector('#re-scoped-batch').onclick", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'regex scoped import handler must exist');
  const handlerBody = panelSource.slice(handlerStart, handlerEnd);
  const conflictIndex = handlerBody.indexOf('findRegexSetNameConflict');
  const choiceIndex = handlerBody.indexOf('await appChoice');
  const upsertIndex = handlerBody.indexOf('upsertLocalSet');
  assert.ok(conflictIndex >= 0, 'regex import must detect same-name sets before writing');
  assert.ok(choiceIndex > conflictIndex, 'same-name choice must follow conflict detection');
  assert.ok(upsertIndex > choiceIndex, 'regex set must not be written before the collision choice');
  assert.match(handlerBody, /defaultActionId:\s*IMPORT_NAME_CONFLICT_DECISIONS\.cancel/);
  assert.match(handlerBody, /IMPORT_NAME_CONFLICT_DECISIONS\.overwrite/);
  assert.match(handlerBody, /IMPORT_NAME_CONFLICT_DECISIONS\.keepBoth/);
  assert.match(handlerBody, /overwriteId\s*\?\s*\{\s*id:\s*overwriteId\s*\}/);
  console.log('ok - regex panel import requires an explicit choice and keeps skip as the safe default');
}

{
  // 同名检查在导入服务的只读计划里完成；角色卡只在提交时创建。手动导入先询问同名再提交，默认取消。
  const serviceSource = await readFile(new URL('../../src/scripts/import/character-card-import-service.js', import.meta.url), 'utf8');
  const planBody = serviceSource.slice(serviceSource.indexOf('const plan = async'), serviceSource.indexOf('const rollback = async'));
  assert.ok(planBody.length > 0, 'the card import service must expose a read-only plan');
  assert.match(planBody, /await personaStore\.ready/);
  assert.match(planBody, /nameConflict:\s*Boolean\(findPersonaNameConflict\(/, 'card import must detect same-name personas');
  assert.doesNotMatch(planBody, /personaStore\.create/, 'planning must not create a persona');

  const importerSource = await readFile(new URL('../../src/scripts/ui/character-card-importer.js', import.meta.url), 'utf8');
  const importStart = importerSource.indexOf('async importCard(');
  assert.ok(importStart >= 0, 'importCard must exist');
  const importBody = importerSource.slice(importStart);
  const conflictIndex = importBody.indexOf('planned.nameConflict');
  const commitIndex = importBody.indexOf('this.service.commit');
  assert.ok(conflictIndex >= 0, 'card import must ask about same-name personas');
  assert.ok(commitIndex > conflictIndex, 'persona must not be created before the same-name choice');
  assert.match(importBody, /defaultActionId:\s*IMPORT_NAME_CONFLICT_DECISIONS\.cancel/);
  assert.match(importBody, /decision\s*!==\s*IMPORT_NAME_CONFLICT_DECISIONS\.keepBoth\)\s*return false/);
  assert.doesNotMatch(importBody.slice(0, importBody.indexOf('promptImportOptions')), /personaStore\.create|service\.commit/);
  console.log('ok - card import asks before creating a duplicate persona and cancels by default');
}
