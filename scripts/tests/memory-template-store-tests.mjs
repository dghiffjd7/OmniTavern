import assert from 'node:assert/strict';

const previousLocalStorage = globalThis.localStorage;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { MemoryTemplateStore } = await import('../../src/scripts/storage/memory-template-store.js');

const clone = value => JSON.parse(JSON.stringify(value));
const previousInvoke = globalThis.__TAURI_INVOKE__;
const databases = new Map();
const calls = [];
let failNextSave = false;

globalThis.__TAURI_INVOKE__ = async (command, { scopeId, input, query = {}, id } = {}) => {
  calls.push({ command, scopeId, id: input?.id || id });
  if (!databases.has(scopeId)) databases.set(scopeId, new Map());
  const records = databases.get(scopeId);
  if (command === 'init_database') return;
  if (command === 'get_templates') {
    return clone([...records.values()].filter(record => !query.id || record.id === query.id));
  }
  if (command === 'save_template') {
    if (failNextSave) {
      failNextSave = false;
      throw new Error('fixture save failed');
    }
    records.set(input.id, clone(input));
    return clone(input);
  }
  if (command === 'delete_template') {
    records.delete(id);
    return;
  }
  throw new Error(`Unexpected command: ${command}`);
};

const definition = id => ({
  meta: { id, name: `Template ${id}`, version: '1.0', author: 'Fixture' },
  tables: [{
    id: 'notes', name: 'Notes', scope: 'contact',
    columns: [{ id: 'text', name: 'Text', type: 'multiline' }],
  }],
  injection: { position: 'before_latest_user', maxRows: 12 },
});

const withinDeadline = async (operation, label) => {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: write queue did not finish`)), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const cases = [
  ['import, switch default, and queued deletion finish in order', async () => {
    const store = new MemoryTemplateStore({ scopeId: 'switch-fixture' });
    await store.saveTemplateDefinition(definition('builtin'), { isDefault: true, isBuiltin: true });
    await store.saveTemplateDefinition(definition('imported'));
    await store.saveTemplateDefinition(definition('discard'));
    const start = calls.length;

    const switched = store.setDefaultTemplate('imported');
    const deleted = store.deleteTemplate('discard');
    const [result] = await withinDeadline(Promise.all([switched, deleted]), 'switch then delete');
    assert.equal(result, true);
    const records = await store.getTemplates();
    assert.deepEqual(records.filter(record => record.is_default).map(record => record.id), ['imported']);
    assert.equal(records.some(record => record.id === 'discard'), false);
    assert.equal(records.find(record => record.id === 'builtin').is_builtin, true);
    assert.deepEqual(store.toTemplateDefinition(records.find(record => record.id === 'imported')), {
      ...definition('imported'),
      meta: { ...definition('imported').meta, tags: [] },
    });
    assert.deepEqual(calls.slice(start).filter(call => call.command !== 'get_templates').map(call => call.command), [
      'save_template', 'save_template', 'save_template', 'delete_template',
    ]);
    assert.equal(store.getDebugInfo().writePending, 0);
    assert.equal(store.getDebugInfo().queueResetCount, 0);
  }],
  ['injection edits persist and allow subsequent switch and delete', async () => {
    const store = new MemoryTemplateStore({ scopeId: 'injection-fixture' });
    await store.saveTemplateDefinition(definition('first'), { isDefault: true });
    await store.saveTemplateDefinition(definition('second'));
    const injection = { position: 'after_system', maxRows: 6, customPrompt: 'Fixture prompt' };

    const updated = store.updateTemplateInjection('second', injection);
    const switched = store.setDefaultTemplate('second');
    const deleted = store.deleteTemplate('first');
    await withinDeadline(Promise.all([updated, switched, deleted]), 'edit then switch and delete');

    const records = await store.getTemplates();
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'second');
    assert.equal(records[0].is_default, true);
    assert.deepEqual(records[0].injection, injection);
    assert.deepEqual(records[0].schema.tables, definition('second').tables);
    assert.equal(store.getDebugInfo().writePending, 0);
    assert.equal(store.getDebugInfo().queueResetCount, 0);
  }],
  ['failed nested save rejects and later writes still finish', async () => {
    const store = new MemoryTemplateStore({ scopeId: 'failure-fixture' });
    await store.saveTemplateDefinition(definition('first'), { isDefault: true });
    await store.saveTemplateDefinition(definition('second'));
    failNextSave = true;
    await assert.rejects(
      withinDeadline(store.updateTemplateInjection('second', { maxRows: 3 }), 'failed injection save'),
      /fixture save failed/,
    );
    await withinDeadline(store.deleteTemplate('second'), 'delete after failure');
    assert.deepEqual((await store.getTemplates()).map(record => record.id), ['first']);
    assert.equal(store.getDebugInfo().writePending, 0);
  }],
];

try {
  for (const [name, run] of cases) {
    failNextSave = false;
    try {
      await run();
      console.log(`ok - ${name}`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`not ok - ${name}\n${error.stack}`);
    }
  }
} finally {
  if (previousInvoke === undefined) delete globalThis.__TAURI_INVOKE__;
  else globalThis.__TAURI_INVOKE__ = previousInvoke;
  if (previousLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousLocalStorage;
}
