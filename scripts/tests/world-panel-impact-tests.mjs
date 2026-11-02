import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const previousLocalStorage = globalThis.localStorage;
const previousDocument = globalThis.document;

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
  clear() {},
};
globalThis.document = {
  body: { dataset: { themeMode: 'dark' } },
};

try {
  const {
    buildWorldbookImpactText,
    collectWorldbookRegexSignaturesForWorld,
    formatWorldScopeLabel,
    getWorldbookRegexRuleSignature,
  } = await import('../../src/scripts/ui/world-panel.js');

  {
    assert.equal(
      formatWorldScopeLabel({ scope: 'session', sessionId: 'chat:alice' }),
      '当前会话「chat:alice」用到的全局/角色/附加世界书',
    );
    assert.equal(
      formatWorldScopeLabel({ scope: 'session', sessionId: 'chat:alice', targetType: 'session_extra' }),
      '当前会话「chat:alice」的附加世界书',
    );
    assert.equal(
      formatWorldScopeLabel({ scope: 'session', sessionId: 'rp:persona-a', targetType: 'session_extra' }),
      '创意写作会话「rp:persona-a」的专属世界书',
    );
    assert.equal(
      formatWorldScopeLabel({ scope: 'session', sessionId: 'chat:alice', targetType: 'role' }),
      '角色绑定（当前会话「chat:alice」）',
    );
    assert.equal(
      formatWorldScopeLabel({ scope: 'global', sessionId: 'chat:alice' }),
      '全局世界书（所有会话共享）',
    );
    console.log('ok - world impact scope labels separate global role and session targets');
  }

  {
    const text = buildWorldbookImpactText({
      scope: 'session',
      sessionId: 'chat:alice',
      targetType: 'session_extra',
      action: 'bind',
    });
    assert.match(text, /影响范围：当前会话「chat:alice」的附加世界书/);
    assert.match(text, /立即保存/);
    assert.match(text, /后续消息的世界书检索与提示词注入/);
    assert.match(text, /不会改写已有聊天记录/);
    console.log('ok - world bind impact describes immediate save and prompt effects');
  }

  {
    const text = buildWorldbookImpactText({
      scope: 'global',
      action: 'delete',
    });
    assert.match(text, /全局世界书/);
    assert.match(text, /从世界书库移除/);
    assert.match(text, /绑定可能失效/);
    assert.match(text, /建议先导出备份/);
    console.log('ok - world delete impact warns about bindings and backups');
  }

  {
    const text = buildWorldbookImpactText({
      scope: 'session',
      sessionId: 'chat:alice',
      action: 'regex_import',
    });
    assert.match(text, /创建或更新正则集合/);
    assert.match(text, /绑定到该世界书/);
    assert.match(text, /取消只保留世界书/);
    console.log('ok - world regex import impact describes optional regex side effects');
  }

  {
    const sharedRule = { findRegex: '/shared/g', replaceString: 'x', placement: [1, 2] };
    const targetRule = { findRegex: '/target/g', replaceString: 'y', placement: [2] };
    const signatures = collectWorldbookRegexSignaturesForWorld([
      { bind: { type: 'world', worldId: 'other-world' }, rules: [sharedRule] },
      { bind: { type: 'world', worldId: 'target-world' }, rules: [targetRule] },
      { bind: { type: 'preset', presetId: 'preset-a' }, rules: [sharedRule] },
    ], 'target-world');
    assert.equal(signatures.has(getWorldbookRegexRuleSignature(targetRule)), true);
    assert.equal(signatures.has(getWorldbookRegexRuleSignature(sharedRule)), false);
    console.log('ok - world regex import dedupe only considers rules already bound to the target world');
  }

  {
    const source = await readFile(new URL('../../src/scripts/ui/world-panel.js', import.meta.url), 'utf8');
    assert.match(source, /const normalizedGlobalIds = getGlobalWorldIds\(window\.appBridge\)/);
    assert.match(source, /for \(const worldId of normalizedGlobalIds\)/);
    assert.match(source, /setGlobalWorldIds\(Array\.from\(next\)\)/);
    assert.match(source, /Array\.from\(new Set\(\[\.\.\.current, name\]\)\)/);
    const confirmDeleteStart = source.indexOf('const confirmDeleteWorld = async');
    const confirmDeleteEnd = source.indexOf('const buildWorldCard = async', confirmDeleteStart);
    const confirmDeleteBody = source.slice(confirmDeleteStart, confirmDeleteEnd);
    assert.doesNotMatch(confirmDeleteBody, /getWorldInfoSnapshot/);
    assert.match(confirmDeleteBody, /expectedExists: true/);
    console.log('ok - global worldbook panel binds toggles and new books through the multi-select contract');
  }
} finally {
  if (previousLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousLocalStorage;
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}
