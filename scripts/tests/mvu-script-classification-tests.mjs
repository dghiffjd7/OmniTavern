import assert from 'node:assert/strict';

import {
  classifyMvuSchemaOnlyScript,
  markMvuSchemaOnlyScripts,
  shouldRestoreLegacyExecutableScript,
} from '../../src/scripts/import/mvu-script-classification.js';

const zodScript = {
  name: '变量结构设计',
  content: 'export const Schema = z.object({ score: z.number() }); registerMvuSchema(Schema);',
};
const runtimeBootstrap = {
  name: 'MVU Zod 脚本',
  content: "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js'",
};
const eventScript = {
  name: '地图标记',
  content: "eventOn(tavern_events.GENERATION_ENDED, () => setChatMessages([]));",
};
const helperLoader = {
  name: '自动开启角色卡局部正则',
  content: "import 'https://fastly.jsdelivr.net/gh/example/resource/dist/酒馆助手/自动开启/index.js'",
};

assert.deepEqual(classifyMvuSchemaOnlyScript(zodScript), {
  schemaOnly: true,
  reason: 'mvu_schema',
});
assert.deepEqual(classifyMvuSchemaOnlyScript(runtimeBootstrap), {
  schemaOnly: true,
  reason: 'mvu_runtime',
});
// 网址带版本或分支（@beta、@1.2.3）的 MVU 本体也要认出来，不然会被当成普通脚本再跑一份
for (const ref of ['@beta', '@1.2.3', '@main']) {
  assert.deepEqual(classifyMvuSchemaOnlyScript({
    name: 'var_update',
    content: `import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate${ref}/artifact/bundle.js'`,
  }), { schemaOnly: true, reason: 'mvu_runtime' });
}
assert.equal(classifyMvuSchemaOnlyScript({ content: "import 'https://cdn.example/gh/x/MagVarUpdateX/artifact/bundle.js'" }).schemaOnly, false);
assert.equal(classifyMvuSchemaOnlyScript(eventScript).schemaOnly, false);
assert.equal(classifyMvuSchemaOnlyScript(helperLoader).schemaOnly, false);

const marked = markMvuSchemaOnlyScripts([zodScript, runtimeBootstrap, eventScript, helperLoader]);
assert.deepEqual(marked.map((script) => script.schemaOnly === true), [true, true, false, false]);
assert.deepEqual(marked.map((script) => script.schemaOnlyReason || ''), ['mvu_schema', 'mvu_runtime', '', '']);

assert.equal(shouldRestoreLegacyExecutableScript({
  ...eventScript,
  source: 'card',
  schemaOnly: true,
}), true);
assert.equal(shouldRestoreLegacyExecutableScript({
  ...helperLoader,
  source: 'card',
  schemaOnly: true,
}), true);
assert.equal(shouldRestoreLegacyExecutableScript({
  ...zodScript,
  source: 'card',
  schemaOnly: true,
}), false);
assert.equal(shouldRestoreLegacyExecutableScript({
  ...runtimeBootstrap,
  source: 'card',
  schemaOnly: true,
}), false);
assert.equal(shouldRestoreLegacyExecutableScript({
  ...eventScript,
  source: 'card',
  schemaOnly: true,
  schemaOnlyReason: 'source',
}), false);
assert.equal(shouldRestoreLegacyExecutableScript({
  ...eventScript,
  source: 'user',
  schemaOnly: true,
}), false);

console.log('mvu script classification tests: ok');
