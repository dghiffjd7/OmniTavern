// AC 格式修复「辅助填写」运行时：读当前会话生效的预设、世界书、角色卡与正则收集格式来源，
// 用户确认后才按 Agent 自己的连线配置请求整理（见 agent/format-guide-assist.js）。

import {
  buildFormatGuideAssistMessages,
  collectFormatGuideSources,
  parseFormatGuideAssistResult,
} from '../../agent/format-guide-assist.js';

const trim = value => String(value ?? '').trim();
const asArray = value => (Array.isArray(value) ? value : []);

const readReplyText = (response) => {
  if (typeof response === 'string') return response;
  return String(response?.content ?? response?.text ?? response?.message?.content ?? response?.choices?.[0]?.message?.content ?? '');
};

export const createFormatGuideAssistRuntime = ({
  presetStore = null,
  regexStore = null,
  contactsStore = null,
  getUiMode = () => 'chat',
  getRegexContext = null,
  getResolvedWorldState = null,
  getWorldInfo = async () => null,
  getCharacter = () => null,
  createModelRequest = null,
  getLocale = () => 'zh-CN',
} = {}) => {
  const collectSources = async ({ sessionId = '' } = {}) => {
    const sid = trim(sessionId);
    const uiMode = trim(getUiMode(sid)) || 'chat';
    const context = { sessionId: sid, uiMode };
    const resolved = presetStore?.getResolvedActive?.('openai', context) || {};
    const presets = resolved.preset ? [{ name: trim(resolved.preset.name) || trim(resolved.presetId), preset: resolved.preset }] : [];
    const regexContext = (typeof getRegexContext === 'function' && getRegexContext({ sessionId: sid, uiMode })) || context;
    const regexRules = asArray(regexStore?.computeActiveRules?.(regexContext));
    const contact = contactsStore?.getContact?.(sid) || null;
    const worldState = (typeof getResolvedWorldState === 'function' && getResolvedWorldState(sid, {
      uiMode,
      isGroupChat: Boolean(contact?.isGroup) || sid.startsWith('group:'),
      groupMemberIds: asArray(contact?.members),
    })) || {};
    const worlds = [];
    for (const id of new Set(asArray(worldState.worldIds).map(trim).filter(Boolean))) {
      const world = await getWorldInfo(id);
      if (world) worlds.push({ name: trim(world.name) || id, world });
    }
    return collectFormatGuideSources({ presets, worlds, character: getCharacter(sid), regexRules });
  };

  // mode: 'sources' 用当前配置；'example' 用一段正常回复。config 是编辑器里当前的 Agent 配置（含未保存的连线选择）。
  const draft = async ({ sessionId = '', mode = 'sources', config = null, example = '', note = '', signal } = {}) => {
    if (!config || config.modelMode === 'none') throw new Error('请先选择连线配置');
    const collected = mode === 'example' ? null : await collectSources({ sessionId });
    if (mode === 'example' ? !trim(example) : !collected.items.length) {
      throw new Error(mode === 'example' ? '请先贴上一段正常回复' : '没有找到与格式有关的内容');
    }
    const messages = buildFormatGuideAssistMessages({
      mode,
      sources: collected?.items || [],
      example,
      note,
      locale: getLocale(),
    });
    const request = createModelRequest(config, trim(sessionId));
    const response = await request.chat(messages, { temperature: 0.2, ...(signal ? { signal } : {}) });
    const sourceIds = mode === 'example' ? ['example'] : collected.items.map(item => item.id);
    return {
      mode,
      draft: parseFormatGuideAssistResult(readReplyText(response), { sourceIds }),
      sources: collected?.items || [],
      fingerprint: collected?.fingerprint || '',
    };
  };

  return { collectSources, draft };
};
