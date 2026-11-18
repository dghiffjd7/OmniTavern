// 小管家在 APP 里的两段流程：消息翻译、贴图起名。只管流程（取输入、分批、执行任务、写回、还原），
// 读写消息与贴图包、执行任务、提示都由 app.js 注入；这里不碰 DOM。
import { t } from '../../i18n/index.js';
import { agentToolContextKey } from '../../agent/agent-tool-targets.js';
import { listReadyStewardCustomTasks, resolveStewardTranslationLanguage } from '../../agent/steward-tasks.js';
import { buildCustomTaskPayload, buildTranslationPayload, parseStewardText } from '../../agent/steward-text-tasks.js';
import {
  STICKER_KEYWORD_BATCH_SIZE,
  buildStickerKeywordPayload,
  dedupeStickerKeywords,
  parseStickerKeywords,
  selectStickersForKeywords,
} from '../../agent/steward-sticker-tasks.js';
import { createMessageStewardNote, createMessageTranslation } from './message-translation-ui-utils.js';

/**
 * 消息翻译。message 可以是存储里的原消息：按当前显示的分支（resolveShown）取原文与指纹，译文才与气泡对得上。
 * 成功时写回并返回 true；没文字、没开、失败时提示原因并返回 false。
 */
export const createStewardMessageTranslation = ({
  runTask,
  getContext = () => ({}),
  getLocale = () => '',
  readTaskSettings = () => ({}),
  resolveShown = message => message,
  extractText = message => String(message?.content || ''),
  messageExists = () => true,
  writeTranslation = () => false,
  notify = () => {},
  warn = () => {},
} = {}) => async (message, sessionId) => {
  const shown = resolveShown(message) || message;
  const text = String(extractText(shown) || '').trim();
  if (!text) {
    warn(t('这条消息没有可翻译的文字'));
    return false;
  }
  const context = getContext();
  const language = resolveStewardTranslationLanguage(readTaskSettings(context)?.targetLanguage, getLocale());
  notify(t('小管家正在翻译…'));
  let outcome;
  try {
    outcome = await runTask({
      taskId: 'translate_message', context, targetKey: `${sessionId}:${shown.id}`,
      payload: buildTranslationPayload({ text, language }), parse: parseStewardText,
      targetCurrent: () => messageExists(shown.id, sessionId),
    });
  } catch (error) {
    warn(t(error?.message || '翻译失败'));
    return false;
  }
  if (outcome?.status !== 'succeeded') {
    warn(t(outcome?.reason || '翻译失败'));
    return false;
  }
  return writeTranslation(shown.id, sessionId, createMessageTranslation({ message: shown, text: outcome.result, language }));
};

/** 改贴图关键词：只改仍是 expected 值的贴图（期间被手动改过的保留）；返回新包与真正改动的贴图 id。 */
export const applyStickerKeywordUpdates = (pack = {}, updates = new Map(), expected = new Map()) => {
  const changed = [];
  const stickers = (Array.isArray(pack?.stickers) ? pack.stickers : []).map((sticker) => {
    if (!updates.has(sticker?.id) || String(sticker?.keyword || '') !== String(expected.get(sticker.id) ?? '')) return sticker;
    changed.push(sticker.id);
    return { ...sticker, keyword: updates.get(sticker.id) };
  });
  return { pack: { ...pack, stickers }, changed };
};

/**
 * 贴图起名：默认只补没有关键词的贴图（all 时整包重起；stickerIds 限定刚加的那几张）。按批看图（loadImage 失败的跳过），
 * 关键词与其他贴图重复时加序号；写入后 showUndo 提供一键还原（只还原仍是这次写的值的贴图）。返回写了几张。
 */
export const createStewardStickerNaming = ({
  runTask,
  getContext = () => ({}),
  getLocale = () => '',
  getPack = () => null,
  savePack = () => {},
  listOtherKeywords = () => [],
  loadImage = async () => '',
  checkModel = null,
  notify = () => {},
  warn = () => {},
  showUndo = () => {},
} = {}) => async (packId, { all = false, stickerIds = null } = {}) => {
  const pack = getPack(packId);
  if (!pack) return 0;
  const targets = selectStickersForKeywords(pack, { all })
    .filter(sticker => !Array.isArray(stickerIds) || stickerIds.includes(sticker.id));
  if (!targets.length) return 0;
  const context = getContext();
  const language = resolveStewardTranslationLanguage('', getLocale());
  const targetIds = new Set(targets.map(sticker => sticker.id));
  const previous = new Map();
  const written = new Map();
  let failure = '';
  notify(t('小管家正在给 {count} 张贴图起名…', { count: targets.length }));
  for (let start = 0; start < targets.length; start += STICKER_KEYWORD_BATCH_SIZE) {
    const batch = [];
    for (const sticker of targets.slice(start, start + STICKER_KEYWORD_BATCH_SIZE)) {
      const url = await loadImage(sticker);
      if (url) batch.push({ sticker, url });
    }
    if (!batch.length) continue;
    const taken = () => [...listOtherKeywords(targetIds), ...written.values()];
    let outcome;
    try {
      outcome = await runTask({
        taskId: 'sticker_keywords', context, targetKey: `sticker:${packId}:${start}`, checkModel,
        payload: buildStickerKeywordPayload({ images: batch.map(item => ({ url: item.url })), language, avoid: taken() }),
        parse: raw => parseStickerKeywords(raw, batch.length),
        targetCurrent: () => Boolean(getPack(packId)),
      });
    } catch (error) {
      failure = error?.message || '起名失败';
      break;
    }
    if (outcome?.status !== 'succeeded') {
      failure = outcome?.reason || '起名失败';
      break;
    }
    const keywords = dedupeStickerKeywords(outcome.result, taken());
    const updates = new Map(batch.map((item, index) => [item.sticker.id, keywords[index]]));
    const expected = new Map(batch.map(item => [item.sticker.id, String(item.sticker.keyword || '')]));
    const latest = getPack(packId);
    if (!latest) break;
    const applied = applyStickerKeywordUpdates(latest, updates, expected);
    if (applied.changed.length) savePack(packId, applied.pack);
    applied.changed.forEach((id) => {
      previous.set(id, expected.get(id));
      written.set(id, updates.get(id));
    });
  }
  if (written.size) {
    showUndo({
      message: t('小管家已给 {count} 张贴图起名', { count: written.size }),
      actionLabel: t('还原'),
      onAction: () => {
        const latest = getPack(packId);
        if (!latest) return;
        const restored = applyStickerKeywordUpdates(latest, previous, written);
        if (restored.changed.length) savePack(packId, restored.pack);
      },
    });
  }
  if (failure) warn(t(failure));
  return written.size;
};

export const STEWARD_TOOL_PREFIX = 'steward:';
export const STEWARD_TOOLBOX_TRANSLATE_ID = 'steward:translate';
const CUSTOM_TOOL_PREFIX = 'steward:custom:';
const succeeded = () => ({ status: 'succeeded' });
const unavailable = (message = '') => ({ status: 'unavailable', ...(message ? { message } : {}) });

export const isStewardToolId = id => String(id || '').startsWith(STEWARD_TOOL_PREFIX);
export const stewardCustomToolId = taskId => `${CUSTOM_TOOL_PREFIX}${taskId}`;

/**
 * 小管家在 Agent 工具箱（与「做成工具」）里的入口：「翻译」与各个自定义任务，一点就执行。
 * 翻译：有选中文字就只译选中的并弹窗显示，否则译整条消息（写在气泡下方）。
 * 自定义任务：按任务设定取输入（选中文字／整条消息／最近几条／输入框），结果弹窗显示、写在气泡下方或填入输入框。
 * run 返回 { status, message }，由调用方统一提示（翻译整条时原因已由翻译流程提示过，不再带 message）。
 * listToolActions：现有自定义工具用的动作 { source, id }；已做成工具的任务不在列表重复出现（run 仍可执行）。
 */
export const createStewardToolbox = ({
  runTask,
  getContext = () => ({}),
  getLocale = () => '',
  readConfig = () => ({}),
  isTaskReady = () => false,
  getSessionId = () => '',
  getMessages = () => [],
  findMessage = () => null,
  findLastReply = () => null,
  resolveShown = message => message,
  extractText = message => String(message?.content || ''),
  speakerOf = message => (message?.role === 'user' ? 'user' : 'assistant'),
  getInputText = () => '',
  translateMessage = async () => false,
  writeNote = () => false,
  writeInput = () => {},
  showResult = () => {},
  notify = () => {},
  listToolActions = () => [],
} = {}) => {
  const list = () => {
    const context = getContext();
    const wrapped = new Set(listToolActions().map(action => `${action?.source}:${action?.id}`));
    const items = [];
    if (isTaskReady('translate_message', context) && !wrapped.has('builtin:text.translate')) {
      items.push({ id: STEWARD_TOOLBOX_TRANSLATE_ID, name: t('翻译'), icon: 'translate' });
    }
    listReadyStewardCustomTasks(readConfig(context))
      .filter(task => !wrapped.has(`steward:${task.id}`))
      .forEach(task => items.push({ id: stewardCustomToolId(task.id), name: task.name, icon: 'steward' }));
    return items;
  };
  const targetMessage = (messageId, sessionId) => {
    const found = (messageId ? findMessage(messageId, sessionId) : null) || findLastReply(sessionId);
    return found ? resolveShown(found) || found : null;
  };
  const recentText = (sessionId, count) => getMessages(sessionId)
    .filter(message => ['user', 'assistant'].includes(message?.role))
    .slice(-count)
    .map(message => `${speakerOf(message)}: ${extractText(resolveShown(message) || message)}`)
    .join('\n');
  const execute = async (payload, context, targetKey, targetCurrent = () => true) => {
    try {
      return await runTask({ taskId: payload.taskId, context, targetKey, targetCurrent, payload: payload.request, parse: parseStewardText });
    } catch (error) {
      return { status: 'failed', reason: error?.message || '处理失败' };
    }
  };
  const run = async (id, { messageId = '', selection = '' } = {}) => {
    const sessionId = getSessionId();
    if (!sessionId) return unavailable('请先进入聊天');
    const context = getContext();
    const selected = String(selection || '').trim();
    if (id === STEWARD_TOOLBOX_TRANSLATE_ID) {
      if (!isTaskReady('translate_message', context)) return unavailable('请先在 Agent Center 开启小管家与这个任务');
      if (!selected) {
        const message = targetMessage(messageId, sessionId);
        if (!message) return unavailable('没有可翻译的消息');
        return (await translateMessage(message, sessionId)) ? succeeded() : unavailable();
      }
      const language = resolveStewardTranslationLanguage(readConfig(context)?.tasks?.translate_message?.targetLanguage, getLocale());
      notify(t('小管家正在翻译…'));
      const outcome = await execute({ taskId: 'translate_message', request: buildTranslationPayload({ text: selected, language }) }, context, `${sessionId}:selection`);
      if (outcome?.status !== 'succeeded') return { status: 'failed', message: outcome?.reason || '翻译失败' };
      showResult({ title: `${t('翻译')} · ${language.label}`, text: outcome.result });
      return succeeded();
    }
    if (!String(id).startsWith(CUSTOM_TOOL_PREFIX)) return unavailable('没有这个任务');
    const task = listReadyStewardCustomTasks(readConfig(context)).find(item => item.id === id.slice(CUSTOM_TOOL_PREFIX.length));
    if (!task) return unavailable('这个自定义任务没有开启，或已经删除');
    const contextKey = agentToolContextKey(context);
    const inputSnapshot = getInputText();
    // 输入框属于当前会话/存档；等待模型时用户可以继续编辑，旧结果不能覆盖新草稿。
    const targetCurrent = () => task.output !== 'input' || (getSessionId() === sessionId
      && agentToolContextKey(getContext()) === contextKey && getInputText() === inputSnapshot);
    const message = targetMessage(messageId, sessionId);
    const text = task.input === 'input' ? inputSnapshot
      : task.input === 'recent' ? recentText(sessionId, task.recentCount)
        : task.input === 'selection' ? (selected || (message ? extractText(message) : ''))
          : (message ? extractText(message) : '');
    if (!String(text || '').trim()) return unavailable(task.input === 'input' ? '输入框是空的' : '没有可处理的文字');
    if (task.output === 'bubble' && !message) return unavailable('没有可以写附注的消息');
    notify(t('小管家正在处理「{name}」…', { name: task.name }));
    const outcome = await execute({ taskId: 'custom_tasks', request: buildCustomTaskPayload({ prompt: task.prompt, text }) }, context, `${sessionId}:custom:${task.id}`, targetCurrent);
    if (!targetCurrent()) return { status: 'cancelled', message: '目标或配置已变化，任务已停止' };
    if (outcome?.status !== 'succeeded') return { status: 'failed', message: outcome?.reason || '处理失败' };
    if (task.output === 'input') {
      writeInput(outcome.result, { mode: task.input === 'input' ? 'replace' : 'insert' });
    } else if (task.output === 'bubble') {
      writeNote(message.id, sessionId, createMessageStewardNote({ message, title: task.name, text: outcome.result }));
    } else {
      showResult({ title: task.name, text: outcome.result });
    }
    return succeeded();
  };
  return { list, run };
};
