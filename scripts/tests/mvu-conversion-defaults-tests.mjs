import assert from 'node:assert/strict';

import { MVUConverter } from '../../src/scripts/import/mvu-converter.js';
import { parseMvuScript } from '../../src/scripts/import/mvu-schema-parser.js';

const assertSchemaDefaultsMatchVariables = (result, label) => {
  const entries = Object.entries(result.variables || {});
  assert.ok(entries.length > 0, `${label} should produce variables`);
  entries.forEach(([key, value]) => {
    const schema = result.schemas?.[key];
    assert.ok(schema, `${label} should produce schema for ${key}`);
    assert.notEqual(schema.default, undefined, `${label} should define schema.default for ${key}`);
    assert.deepEqual(schema.default, value, `${label} should keep default aligned for ${key}`);
  });
};

{
  const parsed = parseMvuScript(`
    export const Schema = z.object({
      stat_data: z.object({
        health: z.number(),
        affinity: z.number().min(0).max(100),
        alive: z.boolean(),
        title: z.string(),
        nickname: z.string().optional(),
        mood: z.enum(['平静', '紧张']),
        weather: z.enum(['晴', '雨']),
        tags: z.array(z.string()),
        inventory: z.array(z.string()),
        flags: z.record(z.string(), z.boolean()),
        counters: z.record(z.string(), z.number()),
        chapter: z.number().default(3),
        note: z.string().default('开场'),
      }),
    });
  `);

  assert.equal(parsed.error, null);
  assert.equal(Object.keys(parsed.variables).length, 13);
  assertSchemaDefaultsMatchVariables(parsed, 'zod conversion');
  assert.equal(parsed.schemas.chapter.default, 3);
  assert.equal(parsed.schemas.note.default, '开场');
  console.log('ok - zod conversion backfills schema defaults from typed fallback variables');
}

{
  const statData = {
    health: 84,
    affinity: 12,
    alive: false,
    title: '剑修',
    nickname: '',
    mood: '平静',
    weather: '雨',
    tags: ['主角'],
    inventory: [],
    flags: {},
    counters: { victories: 2 },
    chapter: 3,
    note: null,
  };
  const converted = MVUConverter.convert({
    data: {
      extensions: {
        mvu: { stat_data: statData },
      },
    },
  });

  assert.equal(Object.keys(converted.variables).length, 13);
  assertSchemaDefaultsMatchVariables(converted, 'stat_data conversion');
  assert.equal(converted.schemas.alive.default, false);
  assert.equal(converted.schemas.nickname.default, '');
  assert.equal(converted.schemas.note.default, null);
  console.log('ok - stat_data conversion preserves every source value as schema default');
}

{
  // 回调里写了 const/let 时不能被截断（之前遇到第一个「const 」就停下，结构变成语法错误）
  const parsed = parseMvuScript(`
    export const Schema = z.object({
      世界: z.object({ 年份: z.string().prefault('2024') }).prefault({}),
      分基地: z.record(z.string().describe('基地名'), z.object({ 住户: z.array(z.string()).prefault([]) }).prefault({})).prefault({}),
      房间: z.object({ 类型: z.string().prefault('卧室') }).prefault({}).refine(room => {
        const occupants = String(room.类型).split('、');
        return occupants.length > 0;
      }),
    }).superRefine((data, ctx) => {
      // 注释里有括号 ( 也不影响
      const names = new Set(Object.keys(data.分基地 || {}));
      let total = names.size + ')'.length;
    });
    $(() => { registerMvuSchema(Schema); });
  `);
  assert.equal(parsed.error, null);
  assert.equal(parsed.variables['世界.年份'], '2024');
  assert.equal(parsed.variables['房间.类型'], '卧室');
  console.log('ok - mvu schema with const inside refine/superRefine callbacks is not truncated');
}

{
  // 结构引用了脚本顶层定义的辅助函数，以及 z.preprocess、.catch
  const parsed = parseMvuScript(`
    const str = (d) => z.string().prefault(d);
    const boolPreprocess = (defaultVal = false) => z.preprocess(
      v => 'string' == typeof v ? '是' === v : v,
      z.boolean()
    ).prefault(defaultVal);
    function clampNum(def, min, max) {
      return z.coerce.number().prefault(def).transform(v => _.clamp(v, min, max));
    }
    export const Schema = z.object({
      世界: z.object({
        年历: str('阿拉德历990年'),
        下雨: boolPreprocess(true),
        体力: clampNum(50, 0, 100),
        金币: z.number().catch(5),
        暗号: z.string().regex(/^\\(.+$/).prefault('(甲'),
      }).prefault({}),
    }).transform(data => { const x = 1; return data; });
    registerMvuSchema(Schema);
  `);
  assert.equal(parsed.error, null);
  assert.equal(parsed.variables['世界.年历'], '阿拉德历990年');
  assert.equal(parsed.variables['世界.下雨'], true);
  assert.equal(parsed.variables['世界.体力'], 50);
  assert.equal(parsed.variables['世界.金币'], 5);
  assert.equal(parsed.variables['世界.暗号'], '(甲');
  console.log('ok - mvu schema resolves top-level helpers, z.preprocess and .catch');
}

{
  // 含副作用的辅助函数不带进解析（宁可解析失败，也不在导入时执行）
  let fetched = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { fetched += 1; return Promise.resolve(); };
  try {
    const parsed = parseMvuScript(`
      const remote = (() => { fetch('https://example.invalid/x'); return z.string(); })();
      export const Schema = z.object({ 名字: remote.prefault('甲') });
      registerMvuSchema(Schema);
    `);
    assert.notEqual(parsed.error, null);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('ok - mvu schema helpers with side effects are not executed');
}

{
  // 结构定义时就会调用的常用 lodash 函数
  const parsed = parseMvuScript(`
    const stats = _.mapValues({ 力量: 10, 敏捷: 8 }, v => z.coerce.number().prefault(v));
    export const Schema = z.object({
      属性: z.object(stats).prefault({}),
      标签: z.array(z.string()).prefault(_.uniq(['甲', '甲', '乙'])),
      装备: z.object(_.pick({ 武器: z.string().prefault('剑'), 盾: z.string() }, ['武器'])).prefault({}),
      背包: z.object(_.omit({ 药: z.number().prefault(3), 毒: z.number() }, '毒')).prefault({}),
      杂项: z.object(_.pickBy({ 甲: z.string().prefault('a'), 乙: null }, Boolean)).prefault({}),
    }).transform(data => ({ ...data, 标签: _.uniq(data.标签) }));
    registerMvuSchema(Schema);
  `);
  assert.equal(parsed.error, null);
  assert.equal(parsed.variables['属性.力量'], 10);
  assert.equal(parsed.variables['属性.敏捷'], 8);
  assert.deepEqual(parsed.variables['标签'], ['甲', '乙']);
  assert.equal(parsed.variables['装备.武器'], '剑');
  assert.equal(parsed.variables['装备.盾'], undefined);
  assert.equal(parsed.variables['背包.药'], 3);
  assert.equal(parsed.variables['背包.毒'], undefined);
  assert.equal(parsed.variables['杂项.甲'], 'a');
  console.log('ok - mvu schema supports common lodash helpers used at definition time');
}
