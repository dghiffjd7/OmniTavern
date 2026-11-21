import { t } from '../i18n/index.js';
import { estimatePromptMessagesTokens } from '../memory/memory-injection-audit-utils.js';
import { fingerprintCompatGapValue } from '../storage/compat-gap-report-store.js';
import { mergeScriptPresetSettings } from './tavern-connection-settings.js';

// 酒馆后端接口模拟（主程式这头）：脚本在酒馆里直接 fetch('/api/...')，Worker 把这类请求经 RPC 交到这里，
// 这里回 { status, body }，Worker 再包成酒馆同形状的 Response。回应形状对照酒馆公开源码 src/endpoints/。
// 只读接口在这里；脚本单独调用生成接口交 generate（tavern-api-generate.js）；
// 写入接口（worldinfo/edit、presets/save）走脚本现有的写入路径，每次请用户确认。

const MESSAGES = Object.freeze({
  secrets: 'APP 不把 API Key 交给脚本：Key 只保存在 APP 的 API 设置里。脚本要调用模型时，请改用酒馆助手的 generate／generateRaw，由 APP 用当前会话的连线发出。',
  networkDenied: '脚本没有「访问网络」权限，所以读不到模型清单：请在「通用设置 → 角色卡脚本 → 脚本选项」打开「允许脚本访问网络」后重试。',
  readMessagesDenied: '脚本没有「读取聊天记录」权限：请在「通用设置 → 角色卡脚本 → 脚本选项」打开「允许脚本读取聊天记录」后重试。',
  statusFailed: '读不到当前会话连线的模型清单：请到 APP 的 API 设置确认这条连线能正常连接。',
  missingWorldName: '请求缺少世界书名称（name），APP 没有处理。',
  missingTokenBody: '请求缺少要计算的消息，APP 没有处理。',
  // 写入接口：酒馆出错时回状态码＋纯文字，这里照同样的形状
  worldEditMissingName: '请求缺少世界书名称（name），APP 没有写入。',
  worldEditInvalid: '请求里的 data 需要是带 entries 的世界书文件（entries 以 uid 为键），APP 没有写入。',
  worldEditDenied: '用户拒绝了这次写入，世界书「{name}」保持原样。',
  worldEditFailed: '写入世界书「{name}」时出错：{reason}',
  presetApiUnsupported: 'APP 目前通过 /api/presets/save 只能保存对话预设（apiId: openai），{apiId} 类预设还没有对应的功能，依赖它的脚本功能暂时无法使用。这次调用已记进调试面板的兼容缺口。',
  presetPermissionDenied: '脚本没有「修改变量」权限，所以保存不了预设：请在「通用设置 → 角色卡脚本 → 脚本选项」打开「允许脚本修改变量」后重试。',
  presetMissing: '请求缺少 apiId、预设名称（name）或预设内容（preset），APP 没有保存。',
  presetNotFound: 'APP 里没有名为「{name}」的对话预设。脚本可以保存 APP 里已有的对话预设；要新增预设，请先在 APP 的预设面板导入或新建同名预设。',
  presetDuplicate: 'APP 里有多个名为「{name}」的对话预设，请先在预设面板把名称改成不同的，再让脚本保存。',
  presetDenied: '用户拒绝了这次保存，对话预设「{name}」保持原样。',
  presetFailed: '保存对话预设「{name}」时出错：{reason}',
});
const unsupportedMessage = path => `APP 目前只提供部分酒馆接口，${path} 还没有对应的功能，依赖它的脚本功能暂时无法使用。这次调用已记进调试面板的兼容缺口。`;
const format = (template, params = {}) => template.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(params, key) ? String(params[key]) : match));

const ok = body => ({ status: 200, body });
const fail = (status, message) => ({ status, body: { error: { message } } });
// 酒馆写入接口出错时回纯文字（Worker 把字符串包成 text/plain）
const failText = (status, message) => ({ status, body: String(message) });
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clonePlain = (value) => {
  if (value == null) return value;
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
};

// 预设里可能带着连线资料（酒馆预设会存反代地址与密码）：Key、连线地址、代理一律不回给脚本
const SECRET_SETTING_KEY_RE = /(?:^|_)(?:api_?key|secret|password|proxy)(?:_|$)|(?:^|_)(?:key|token)$/i;
const ADDRESS_SETTING_KEY_RE = /(?:^|_)(?:url|endpoint|headers?|server|account_id|project_id|region)$/i;
const isTavernConnectionSecretKey = key => SECRET_SETTING_KEY_RE.test(key) || ADDRESS_SETTING_KEY_RE.test(key);
export const stripTavernConnectionSecrets = (settings = {}) => Object.fromEntries(
  Object.entries(isPlainObject(settings) ? settings : {})
    .filter(([key]) => !isTavernConnectionSecretKey(key)),
);

// 脚本经 /api/presets/save 写回预设：与脚本存预设设置同一套按键合并规则，另外把交给脚本前滤掉的
// Key、连线地址、代理类字段一律保留预设原值（脚本拿到的是滤过的预设，整份写回时这些字段是空的）
export const mergeTavernPresetSave = (current, incoming) => mergeScriptPresetSettings(current, incoming, {
  keepKey: isTavernConnectionSecretKey,
});

// 酒馆 /api/tokenizers/openai/count 的默认算法：每条消息 +3、整体 +3；正文用 APP 的本地估算
export const estimateTavernTokenCount = (messages = []) => {
  const list = Array.isArray(messages) ? messages : [];
  return estimatePromptMessagesTokens(list) + list.length * 3 + 3;
};

// APP 世界书顶层自己的栏位（保存时间、引用别的世界书），酒馆格式里没有
const APP_WORLD_FIELDS = Object.freeze(['createdAt', 'updatedAt', 'created_at', 'updated_at', 'refs', 'localEntries']);
// APP 在条目上加的别名：与对应的酒馆栏位相同时去掉，写回时导入转换会照原栏位补上
const APP_ENTRY_ALIASES = Object.freeze([['title', 'comment'], ['triggers', 'key'], ['secondary', 'keysecondary'], ['priority', 'order']]);
const toTavernWorldEntry = (entry, uid) => {
  const output = { ...clonePlain(entry), uid };
  APP_ENTRY_ALIASES.forEach(([alias, field]) => {
    if (Object.hasOwn(output, alias) && JSON.stringify(output[alias]) === JSON.stringify(output[field])) delete output[alias];
  });
  // 编号与 uid 相同时也是导入转换补的
  if (output.id === String(uid)) delete output.id;
  return output;
};

// 酒馆世界书文件：entries 是以 uid 为键的物件；没有有效 uid 的条目补上最小的空号；去掉 APP 自己的栏位
export const toTavernWorldFile = (world = {}) => {
  const { entries, ...source } = isPlainObject(world) ? world : {};
  const rest = Object.fromEntries(Object.entries(source).filter(([key]) => !APP_WORLD_FIELDS.includes(key)));
  const list = (Array.isArray(entries) ? entries : Object.values(isPlainObject(entries) ? entries : {}))
    .filter(isPlainObject);
  const used = new Set();
  const uids = list.map((entry) => {
    const uid = Number.isInteger(entry.uid) && entry.uid >= 0 && !used.has(entry.uid) ? entry.uid : null;
    if (uid !== null) used.add(uid);
    return uid;
  });
  let next = 0;
  const output = {};
  list.forEach((entry, index) => {
    let uid = uids[index];
    if (uid === null) {
      while (used.has(next)) next += 1;
      uid = next;
      used.add(uid);
    }
    output[uid] = toTavernWorldEntry(entry, uid);
  });
  return { ...clonePlain(rest), entries: output };
};

// 反过来：酒馆世界书文件的 entries（以 uid 为键）转成 APP 的条目数组，按 uid 由小到大；
// 条目里没有有效 uid 时用它的键。entries 已是数组时照原样（只留物件）
export const fromTavernWorldEntries = (entries) => {
  if (Array.isArray(entries)) return entries.filter(isPlainObject).map(clonePlain);
  return Object.entries(isPlainObject(entries) ? entries : {})
    .filter(([, entry]) => isPlainObject(entry))
    .map(([key, entry]) => {
      const uid = Number(key);
      return Number.isInteger(entry.uid) || !Number.isInteger(uid) || uid < 0
        ? clonePlain(entry)
        : { ...clonePlain(entry), uid };
    });
};

// 存预设确认窗：哪个脚本、哪个预设、改了哪些设定（提示词条目另算条数）
const PRESET_DIALOG_FIELD_LIMIT = 8;
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const countPromptChanges = (before, after) => {
  const index = list => new Map((Array.isArray(list) ? list : []).filter(isPlainObject)
    .map((prompt, position) => [String(prompt.identifier ?? `#${position}`), JSON.stringify(prompt)]));
  const previous = index(before);
  const next = index(after);
  let count = 0;
  next.forEach((value, id) => { if (previous.get(id) !== value) count += 1; });
  previous.forEach((value, id) => { if (!next.has(id)) count += 1; });
  return count;
};
export const describeTavernPresetSave = (current = {}, incoming = {}) => {
  const merged = mergeTavernPresetSave(current, incoming);
  const changed = Object.keys(merged).filter(key => !sameJson(current?.[key], merged[key]));
  // 脚本想改、但由 APP 管理而保留原值的字段（Key、连线地址、代理、模型来源、名称等）
  const kept = Object.keys(isPlainObject(incoming) ? incoming : {})
    .filter(key => !sameJson(incoming[key], merged[key]) && !sameJson(incoming[key], current?.[key]));
  return {
    changed,
    kept,
    promptChanges: changed.includes('prompts') ? countPromptChanges(current?.prompts, merged.prompts) : 0,
  };
};
export const buildPresetSaveDialog = ({ scriptName = '', presetName = '', changed = [], kept = [], promptChanges = 0 } = {}) => {
  const fields = changed.slice(0, PRESET_DIALOG_FIELD_LIMIT)
    .map(key => (key === 'prompts' ? t('{field}（{count} 条提示词）', { field: key, count: promptChanges }) : key));
  return {
    title: t('脚本要修改对话预设'),
    message: [
      t('「{script}」要保存对话预设「{preset}」，改动 {count} 项设定：{fields}。', {
        script: scriptName || t('未知脚本'),
        preset: presetName,
        count: changed.length,
        fields: fields.join('、') + (changed.length > fields.length ? '、…' : ''),
      }),
      ...(kept.length ? [t('请求里另有 {count} 项设定保留 APP 现有的值：Key、连线地址、代理、模型来源与预设名称由 APP 管理。', { count: kept.length })] : []),
      t('保存后，用这个预设的对话都会套用新设定，无法撤销。'),
    ].join('\n\n'),
    danger: true,
  };
};

const messageText = (value) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(part => (typeof part === 'string' ? part : part?.type === 'text' ? String(part.text || '') : '')).join('');
  }
  return value == null ? '' : String(value);
};
const toIsoDate = (timestamp) => {
  const value = Number(timestamp);
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : '';
};

// 酒馆聊天文件（JSONL）的一行消息
export const toTavernChatLine = (message = {}, { userName = '', characterName = '' } = {}) => {
  const role = String(message?.role || '').trim().toLowerCase();
  return {
    name: String(message?.name || (role === 'user' ? userName : characterName) || ''),
    is_user: role === 'user',
    is_system: role === 'system',
    send_date: toIsoDate(message?.timestamp),
    mes: messageText(message?.rawSource ?? message?.raw ?? message?.message ?? message?.mes ?? message?.content),
    extra: {},
  };
};

// 兼容缺口记录：同一脚本（同一版本）打到同一个接口只记一条，次数累计
export const buildTavernApiGapReport = ({ path = '', scriptId = '', scriptName = '', revision = '' } = {}) => {
  const id = String(scriptId || '').trim();
  return {
    scopeFingerprint: fingerprintCompatGapValue(`script:${id || 'unknown'}`),
    revisionFingerprint: String(revision || '').trim() || 'unknown-revision',
    api: String(path || ''),
    status: 'confirmed',
    phase: 'tavern_api',
    errorCategory: 'unsupported_endpoint',
    scriptName: String(scriptName || '').trim() || id,
  };
};

const normalizePath = value => String(value || '').trim().slice(0, 200).replace(/\/+$/, '');
// settings/get 一并回传脚本最近经 presets/save 存过的预设（按名称），存完读回验证时找得到
const RECENT_PRESET_SAVE_LIMIT = 5;

export const createTavernApiRouter = ({
  listModels,
  listWorldbooks,
  readWorldbook,
  getChat,
  getPresetSettings,
  // 脚本单独调用 /api/backends/chat-completions/generate：(request, access) => { status, body } 或 { status, stream: true }
  generate = null,
  // 脚本整本写世界书（与酒馆助手 createOrReplaceWorldbook 同一条路，内含确认）：
  // ({ name, entries, scriptId, scriptName }) => { denied: boolean, savedEntries }，其他失败抛错
  writeWorldbook = null,
  // 脚本写入的原始世界书文件与顶层 extensions（script-world-file-store 的 createScriptWorldFiles）
  worldFiles = { extensionsFor: async () => ({}), fileFor: async () => null, remember: async () => ({}) },
  // 按名称找对话预设：(name) => { id, name, preset } | { duplicate: true } | null
  findPreset = () => null,
  // 写入对话预设（按键合并到当时的预设）：({ id, settings, sessionId }) => void
  savePreset = null,
  // 脚本写入确认（与写世界书同一个队列）：(key, dialogOptions) => boolean
  confirmWrite = null,
  recordGap = () => {},
  countTokens = estimateTavernTokenCount,
} = {}) => {
  const recentPresetSaves = [];
  const rememberPresetSave = (name) => {
    const index = recentPresetSaves.indexOf(name);
    if (index >= 0) recentPresetSaves.splice(index, 1);
    recentPresetSaves.push(name);
    if (recentPresetSaves.length > RECENT_PRESET_SAVE_LIMIT) recentPresetSaves.shift();
  };
  const routes = {
    // 酒馆照连线的 /models 原样回传（OpenAI 格式）；失败时回 200 { error: true, data: { data: [] } }
    '/api/backends/chat-completions/status': async ({ access }) => {
      if (access.allowNetwork !== true) return fail(403, MESSAGES.networkDenied);
      try {
        const models = await listModels({ sessionId: access.sessionId });
        const ids = Array.from(new Set((Array.isArray(models) ? models : [])
          .map(model => String((isPlainObject(model) ? model.id : model) ?? '').trim())
          .filter(Boolean)));
        return ok({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) });
      } catch {
        return ok({ error: true, message: MESSAGES.statusFailed, data: { data: [] } });
      }
    },
    '/api/tokenizers/openai/count': async ({ body }) => {
      if (body == null) return fail(400, MESSAGES.missingTokenBody);
      return ok({ token_count: countTokens(Array.isArray(body) ? body : [body]) });
    },
    // 酒馆回每个世界书文件的 { file_id, name, extensions }；APP 的世界书以名称为键。
    // extensions 是脚本经 worldinfo/edit 写入时存下的文件顶层 extensions，没有的回空物件
    '/api/worldinfo/list': async () => {
      const names = Array.from(new Set((await listWorldbooks() || []).map(name => String(name || '').trim()).filter(Boolean)));
      const extensions = await worldFiles.extensionsFor(names);
      return ok(names.sort((a, b) => a.localeCompare(b)).map(name => ({
        file_id: name, name, extensions: isPlainObject(extensions[name]) ? extensions[name] : {},
      })));
    },
    // 找不到时酒馆回 200 { entries: {} }。脚本写入之后 APP 没改过这本书时原样回脚本写的文件，
    // 否则回转换后的酒馆格式，带上存下的 extensions
    '/api/worldinfo/get': async ({ body }) => {
      const name = String(isPlainObject(body) ? body.name ?? '' : '').trim();
      if (!name) return fail(400, MESSAGES.missingWorldName);
      const world = await readWorldbook(name);
      if (!isPlainObject(world)) return ok({ entries: {} });
      const file = await worldFiles.fileFor(name, world);
      if (isPlainObject(file)) return ok(file);
      const extensions = (await worldFiles.extensionsFor([name]))[name];
      return ok({ ...toTavernWorldFile(world), extensions: isPlainObject(extensions) ? extensions : {} });
    },
    // 酒馆回聊天文件的每一行：第一行是带 chat_metadata 的表头，之后是消息。只回当前会话；
    // 指名别的聊天文件时照酒馆「找不到文件」回空数组
    '/api/chats/get': async ({ body, access, request }) => {
      if (access.allowReadMessages !== true) return fail(403, MESSAGES.readMessagesDenied);
      const fileName = isPlainObject(body) ? body.file_name : undefined;
      if (fileName != null && String(fileName) !== access.sessionId) return ok([]);
      const chat = await getChat({ sessionId: access.sessionId }) || {};
      const messages = Array.isArray(chat.messages) ? chat.messages : [];
      const names = { userName: String(chat.userName || ''), characterName: String(chat.characterName || '') };
      return ok([
        {
          user_name: names.userName,
          character_name: names.characterName,
          create_date: toIsoDate(messages[0]?.timestamp),
          chat_metadata: isPlainObject(request.chatMetadata) ? clonePlain(request.chatMetadata) : {},
        },
        ...messages.map(message => toTavernChatLine(message, names)),
      ]);
    },
    // 只回脚本实际读到的栏位：settings 里的 oai_settings（当前使用中的设定），以及按名称查预设用的
    // openai_setting_names／openai_settings。酒馆会回全部预设，APP 只回当前预设（全部预设合计可达数十 MB），
    // 再加上脚本最近经 presets/save 存过的预设
    '/api/settings/get': async ({ access }) => {
      const preset = await getPresetSettings({ sessionId: access.sessionId }) || {};
      const name = String(preset.name || '').trim();
      const saved = name && isPlainObject(preset.saved) ? preset.saved : null;
      const names = saved ? [name] : [];
      const presets = saved ? [JSON.stringify(stripTavernConnectionSecrets(saved))] : [];
      for (const savedName of recentPresetSaves) {
        if (names.includes(savedName)) continue;
        const found = await findPreset(savedName);
        if (!isPlainObject(found?.preset)) continue;
        names.push(savedName);
        presets.push(JSON.stringify(stripTavernConnectionSecrets(found.preset)));
      }
      return ok({
        settings: JSON.stringify({ oai_settings: stripTavernConnectionSecrets(preset.inUse) }),
        openai_setting_names: names,
        openai_settings: presets,
      });
    },
  };
  if (typeof generate === 'function') {
    routes['/api/backends/chat-completions/generate'] = ({ request, access }) => generate(request, access);
  }
  // 酒馆按名称整本写入（没有就新建），成功回 { ok: true }。APP 走脚本整本写世界书的同一条路：
  // 条目转回 APP 格式后同样请用户确认（覆盖时危险样式）、拒绝过的同一请求不再弹窗。
  // 写入后记下脚本交来的原始文件与顶层 extensions，读回时用
  if (typeof writeWorldbook === 'function') {
    routes['/api/worldinfo/edit'] = async ({ body, request }) => {
      const name = String(isPlainObject(body) ? body.name ?? '' : '').trim();
      if (!name) return failText(400, MESSAGES.worldEditMissingName);
      const data = isPlainObject(body) ? body.data : null;
      if (!isPlainObject(data) || !(isPlainObject(data.entries) || Array.isArray(data.entries))) {
        return failText(400, MESSAGES.worldEditInvalid);
      }
      try {
        const result = await writeWorldbook({
          name,
          entries: fromTavernWorldEntries(data.entries),
          scriptId: String(request.scriptId || ''),
          scriptName: String(request.scriptName || ''),
        });
        if (result?.denied) return failText(403, format(MESSAGES.worldEditDenied, { name }));
        await worldFiles.remember({ name, file: data, savedEntries: result?.savedEntries });
      } catch (error) {
        return failText(500, format(MESSAGES.worldEditFailed, { name, reason: String(error?.message || error) }));
      }
      return ok({ ok: true });
    };
  }
  // 酒馆按 apiId 存到对应的预设文件夹，成功回 { name }。APP 只接对话预设（openai），按名称找已有的预设，
  // 每次请用户确认，按键合并写入；与脚本存预设设置一样要「修改变量」权限
  if (typeof savePreset === 'function' && typeof confirmWrite === 'function') {
    routes['/api/presets/save'] = async ({ body, request, access }) => {
      const scriptId = String(request.scriptId || '');
      const scriptName = String(request.scriptName || '');
      const apiId = String(isPlainObject(body) ? body.apiId ?? '' : '').trim();
      if (!apiId) return failText(400, MESSAGES.presetMissing);
      if (apiId !== 'openai') {
        // 缺口按预设类别分开记：/api/presets/save/<apiId>（缺口记录只收路径字元）
        const kind = apiId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
        recordGap({ path: `/api/presets/save/${kind}`, scriptId, scriptName });
        return fail(501, format(MESSAGES.presetApiUnsupported, { apiId }));
      }
      if (access.allowModifyVariables !== true) return failText(403, MESSAGES.presetPermissionDenied);
      const name = String(body.name ?? '').trim();
      if (!name || !isPlainObject(body.preset)) return failText(400, MESSAGES.presetMissing);
      const target = await findPreset(name);
      if (target?.duplicate) return failText(409, format(MESSAGES.presetDuplicate, { name }));
      if (!isPlainObject(target?.preset)) return failText(404, format(MESSAGES.presetNotFound, { name }));
      const presetName = String(target.name || name);
      const summary = describeTavernPresetSave(target.preset, body.preset);
      if (summary.changed.length) {
        const allowed = await confirmWrite(['preset', scriptId, target.id].join('\u0000'), buildPresetSaveDialog({
          scriptName: scriptName || scriptId, presetName, ...summary,
        }));
        if (allowed !== true) return failText(403, format(MESSAGES.presetDenied, { name: presetName }));
        try {
          await savePreset({ id: target.id, settings: body.preset, sessionId: access.sessionId });
        } catch (error) {
          return failText(500, format(MESSAGES.presetFailed, { name: presetName, reason: String(error?.message || error) }));
        }
      }
      rememberPresetSave(presetName);
      return ok({ name: presetName });
    };
  }

  const handle = async (request = {}, {
    allowNetwork = false, allowReadMessages = false, allowModifyVariables = false, sessionId = '',
  } = {}) => {
    const path = normalizePath(request?.path);
    const access = { allowNetwork, allowReadMessages, allowModifyVariables, sessionId: String(sessionId || '') };
    if (path === '/api/secrets' || path.startsWith('/api/secrets/')) return fail(403, MESSAGES.secrets);
    const route = Object.hasOwn(routes, path) ? routes[path] : null;
    if (route) return route({ body: request?.body ?? null, access, request: request || {} });
    recordGap({ path, scriptId: String(request?.scriptId || ''), scriptName: String(request?.scriptName || '') });
    return fail(501, unsupportedMessage(path));
  };

  return { handle };
};
