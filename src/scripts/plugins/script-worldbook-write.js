import { convertSTWorld } from '../storage/worldinfo.js';
import { buildWorldbookImportPlan } from '../ui/worldbook-import-conflict-utils.js';

// 酒馆助手（TavernHelper）世界书接口：createWorldbook / createOrReplaceWorldbook / importRawWorldbook / rebindGlobalWorldbooks。
// 每次写入都要用户确认；条目先转成酒馆原始格式，再走与导入文件相同的 convertSTWorld 与同名覆盖检查。

const POSITIONS = Object.freeze({
  before_character_definition: 0,
  after_character_definition: 1,
  before_author_note: 2,
  after_author_note: 3,
  at_depth: 4,
  before_example_messages: 5,
  after_example_messages: 6,
});
const ROLES = Object.freeze({ system: 0, user: 1, assistant: 2 });
const LOGIC = Object.freeze({ and_any: 0, not_all: 1, not_any: 2, and_all: 3 });

const toKeyList = keys => (Array.isArray(keys) ? keys : [])
  .map(key => (key instanceof RegExp ? String(key) : String(key ?? '').trim()))
  .filter(Boolean);
const finiteOr = (value, fallback) => (value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback);
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isHelperEntry = entry => isPlainObject(entry.strategy) || isPlainObject(entry.position)
  || (entry.name !== undefined && entry.comment === undefined);

export const toTavernWorldEntry = (entry = {}, index = 0) => {
  if (!isPlainObject(entry) || !isHelperEntry(entry)) return entry;
  const {
    uid, name, enabled, strategy = {}, position = {}, content, probability, recursion = {}, effect = {}, extra, ...rest
  } = entry;
  const secondary = isPlainObject(strategy.keys_secondary) ? strategy.keys_secondary : {};
  const type = strategy.type || 'selective';
  const scanDepth = strategy.scan_depth;
  return {
    ...rest,
    uid: Number.isInteger(uid) ? uid : index,
    comment: String(name ?? ''),
    content: String(content ?? ''),
    disable: enabled === false,
    constant: type === 'constant',
    vectorized: type === 'vectorized',
    selective: true,
    key: toKeyList(strategy.keys),
    keysecondary: toKeyList(secondary.keys),
    selectiveLogic: LOGIC[secondary.logic] ?? 0,
    scanDepth: scanDepth === 'same_as_global' || scanDepth == null ? null : finiteOr(scanDepth, null),
    position: POSITIONS[position?.type] ?? 0,
    role: ROLES[position?.role] ?? 0,
    depth: finiteOr(position?.depth, 4),
    order: finiteOr(position?.order, 100),
    probability: finiteOr(probability, 100),
    useProbability: true,
    excludeRecursion: recursion?.prevent_incoming === true,
    preventRecursion: recursion?.prevent_outgoing === true,
    delayUntilRecursion: finiteOr(recursion?.delay_until, 0),
    sticky: finiteOr(effect?.sticky, null),
    cooldown: finiteOr(effect?.cooldown, null),
    delay: finiteOr(effect?.delay, null),
    ...(isPlainObject(extra) ? { extra } : {}),
  };
};

const buildIncomingWorld = ({ mode, worldName, entries, content }) => {
  if (mode === 'import') {
    let json;
    try {
      json = JSON.parse(String(content ?? ''));
    } catch {
      throw new Error('世界书内容不是有效的 JSON');
    }
    return convertSTWorld(json, worldName);
  }
  if (!Array.isArray(entries)) throw new Error('世界书条目必须是数组');
  return convertSTWorld({ entries: entries.map(toTavernWorldEntry) }, worldName);
};

export const createScriptWorldbookWriter = ({ bridge, confirm }) => {
  const denied = new Set();
  const pending = new Map();
  let confirmQueue = Promise.resolve();

  const listing = () => ({
    names: (bridge.worldStore?.list?.() || []).map(String),
    globalNames: bridge.getGlobalWorldIds?.() || [],
  });
  // 拒绝过的同一请求本次运行内不再弹窗（脚本常会定时重试）；同时只开一个确认框
  const ask = (key, options) => {
    if (denied.has(key)) return Promise.resolve(false);
    const answer = confirmQueue.then(() => confirm({ confirmText: '允许', cancelText: '拒绝', ...options }));
    confirmQueue = answer.catch(() => false);
    return answer.then((ok) => {
      if (ok !== true) denied.add(key);
      return ok === true;
    });
  };
  const once = (key, task) => {
    if (pending.has(key)) return pending.get(key);
    const run = task().finally(() => pending.delete(key));
    pending.set(key, run);
    return run;
  };

  const write = ({ mode, name, entries, content, scriptId = '', scriptName = '' } = {}) => {
    if (!['create', 'replace', 'import'].includes(mode)) throw new Error(`不支持的世界书写入方式：${mode}`);
    const rawName = String(name || '').trim();
    // importRawWorldbook 传的是文件名，酒馆按去掉 .json 的部分命名
    const worldName = mode === 'import' ? rawName.replace(/\.json$/i, '') : rawName;
    if (!worldName) throw new Error('世界书名称不能为空');
    const script = String(scriptName || scriptId || '脚本');
    const key = [scriptId, mode, worldName].join('\u0000');
    return once(key, async () => {
      const snapshot = await bridge.getWorldInfoSnapshot(worldName);
      if (mode === 'create' && snapshot?.exists) return { created: false, ...listing() };
      const world = buildIncomingWorld({ mode, worldName, entries, content });
      const count = world.entries.length;
      const existing = Array.isArray(snapshot?.data?.entries) ? snapshot.data.entries.length : 0;
      const ok = await ask(key, snapshot?.exists
        ? {
            title: '脚本要覆盖世界书',
            message: `「${script}」要用 ${count} 条内容完整替换世界书「${worldName}」（现有 ${existing} 条），替换后无法撤销。`,
            danger: true,
          }
        : {
            title: '脚本要新建世界书',
            message: `「${script}」要新建世界书「${worldName}」，共 ${count} 条。`,
          });
      if (!ok) throw new Error('用户拒绝了脚本写入世界书');
      const plan = buildWorldbookImportPlan({ worldId: worldName, incomingWorld: world, snapshot });
      await bridge.saveWorldInfo(plan.targetId, plan.incomingWorld, plan.saveOptions);
      return { created: !snapshot?.exists, ...listing() };
    });
  };

  // 酒馆的 rebindGlobalWorldbooks 会整体替换全局名单；APP 只追加，不让脚本解绑用户原有的全局世界书
  const bindGlobal = async ({ names = [], scriptId = '', scriptName = '' } = {}) => {
    const current = bridge.getGlobalWorldIds();
    const additions = Array.from(new Set((Array.isArray(names) ? names : []).map(item => String(item || '').trim())))
      .filter(item => item && !current.includes(item));
    if (!additions.length) return listing();
    const known = new Set(listing().names);
    const missing = additions.filter(item => !known.has(item));
    if (missing.length) throw new Error(`世界书不存在：${missing.join('、')}`);
    const key = [scriptId, 'global', ...additions].join('\u0000');
    return once(key, async () => {
      const ok = await ask(key, {
        title: '脚本要设为全局世界书',
        message: `「${String(scriptName || scriptId || '脚本')}」要把世界书「${additions.join('、')}」设为全局，所有会话都会用到它。`,
      });
      if (!ok) throw new Error('用户拒绝了脚本修改全局世界书');
      bridge.setGlobalWorldIds([...bridge.getGlobalWorldIds(), ...additions]);
      return listing();
    });
  };

  return { write, bindGlobal, listing };
};
