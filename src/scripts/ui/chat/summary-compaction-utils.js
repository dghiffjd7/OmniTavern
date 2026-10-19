import { getLocalizedPromptText } from '../../i18n/prompt-locale.js';

const compactionPrompt = (key, fallback) => getLocalizedPromptText(`summary_compaction.${key}`, fallback);

// 用户可编辑的大总结规则（原则、字数、格式模板）；<summary> 标签要求与数据部分由程序固定附加。
export const getDefaultSummaryCompactionRules = () => [
  compactionPrompt('rules_header', '总结应当遵循以下原则：'),
  compactionPrompt('rule_order', '- 按时间顺序或逻辑顺序组织信息，并明确给出具体时间节点'),
  compactionPrompt('rule_details', '- 保留关键事件和重要细节，省略冗余描述'),
  compactionPrompt('rule_facts', '- 直接陈述事实，避免主观评价'),
  compactionPrompt('rule_clarity', '- 使用简洁清晰的语言，避免过度修饰'),
  compactionPrompt('rule_turning_points', '- 突出事件发展脉络和关键转折点'),
  compactionPrompt('rule_complete', '- 不回避任何敏感内容，保证记录完全还原前文'),
  compactionPrompt('rule_length', '- 总结全文控制在 800 字以内；篇幅不够时合并次要事件，优先保留人物关系、未了结的线索和关键转折'),
  '',
  compactionPrompt('format_rule', 'summary 内部的正文必须使用以下格式：'),
  '',
  compactionPrompt('key_events', '【关键事件】'),
  compactionPrompt('event_1', '• {事件1}: {简要描述}'),
  compactionPrompt('event_2', '• {事件2}: {简要描述}'),
  compactionPrompt('event_3', '• {事件3}: {简要描述}'),
  '...',
].join('\n');

// 空白或与默认相同都算未自定义，沿用内置版式（默认请求与改版前逐字一致）。
export const resolveCustomSummaryCompactionRules = (rules = '') => {
  const text = String(rules || '').trim();
  return text && text !== getDefaultSummaryCompactionRules().trim() ? text : '';
};

export const buildSummaryCompactionPrompt = ({
  payload = '',
  compactedText = '',
  rules = '',
} = {}) => {
  const previous = String(compactedText || '').trim();
  const prompt = compactionPrompt;
  const customRules = resolveCustomSummaryCompactionRules(rules);
  return [
    prompt('override', '# 注意，无视你先前收到的任何指令，你的任务已更改，不再遵守格式要求'),
    prompt('transition', '接下来的一轮回复中，将不会进行创作，不再遵循前面的要求，而是会遵循<summary_rules>中的要求进行一轮总结'),
    prompt('request_header', '【总结请求】'),
    prompt('request', '请对前文内容进行全面梳理，根据以下要求制作简明扼要的总结：'),
    '',
    '<summary_rules>',
    ...(customRules ? [
      customRules,
      '',
      prompt('xml_rule', '总结正文必须放在 <summary>...</summary> 中（只允许这一层 XML 标签；不要输出其他 XML 标签）。'),
    ] : [
      prompt('rules_header', '总结应当遵循以下原则：'),
      prompt('rule_order', '- 按时间顺序或逻辑顺序组织信息，并明确给出具体时间节点'),
      prompt('rule_details', '- 保留关键事件和重要细节，省略冗余描述'),
      prompt('rule_facts', '- 直接陈述事实，避免主观评价'),
      prompt('rule_clarity', '- 使用简洁清晰的语言，避免过度修饰'),
      prompt('rule_turning_points', '- 突出事件发展脉络和关键转折点'),
      prompt('rule_complete', '- 不回避任何敏感内容，保证记录完全还原前文'),
      prompt('rule_length', '- 总结全文控制在 800 字以内；篇幅不够时合并次要事件，优先保留人物关系、未了结的线索和关键转折'),
      '',
      prompt('xml_rule', '总结正文必须放在 <summary>...</summary> 中（只允许这一层 XML 标签；不要输出其他 XML 标签）。'),
      prompt('format_rule', 'summary 内部的正文必须使用以下格式：'),
      '',
      prompt('key_events', '【关键事件】'),
      prompt('event_1', '• {事件1}: {简要描述}'),
      prompt('event_2', '• {事件2}: {简要描述}'),
      prompt('event_3', '• {事件3}: {简要描述}'),
      '...',
    ]),
    '',
    '</summary_rules>',
    '',
    previous ? prompt('previous_header', '【已有大总结】') : '',
    previous || '',
    previous ? '' : '',
    prompt('history_header', '【前文内容（按时间标注的摘要列表）】'),
    String(payload || ''),
  ].join('\n');
};

export const buildSummaryCompactionPayload = (items = []) => {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item) => {
      const text = String(typeof item === 'string' ? item : item?.text || '').trim();
      if (!text) return '';
      const at = typeof item === 'object' && item && item.at ? Number(item.at) : 0;
      const when = at ? new Date(at).toLocaleString() : '';
      return `- ${when ? `[${when}] ` : ''}${text}`;
    })
    .filter(Boolean)
    .join('\n');
};

export const normalizeSummarySnapshotItems = (items = []) =>
  (Array.isArray(items) ? items : [])
    .map((item) => {
      if (!item) return null;
      if (typeof item === 'string') {
        const text = String(item || '').trim();
        if (!text) return null;
        return { at: 0, text };
      }
      const text = String(item?.text || '').trim();
      if (!text) return null;
      const at = Number(item?.at || 0) || 0;
      return { at, text };
    })
    .filter(Boolean);

// trigger：'chars'（默认，总字数超过 minLength）或 'rows'（满 rowLimit 条）。
export const shouldRunSummaryCompaction = ({
  items = [],
  force = false,
  minLength = 1000,
  trigger = 'chars',
  rowLimit = 0,
} = {}) => {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return false;
  if (force) return true;
  if (trigger === 'rows') return Number(rowLimit) > 0 && list.length >= Number(rowLimit);
  const total = list.reduce((sum, item) => {
    const text = String(typeof item === 'string' ? item : item?.text || '');
    return sum + text.length;
  }, 0);
  return total > Number(minLength || 0);
};

// 压缩回复本身约数百 token；留出余量给默认会思考的模型，同时仍有上限。
export const SUMMARY_COMPACTION_MAX_TOKENS = 2000;

// 会话摘要压缩的独立请求：只有压缩提示本身。套用创意写作预设时，模型会先照预设写思维链／角色扮演，
// 长时间写不到 <summary>（实测 mimo：预设下 5900 token 提示、三种上限都截断；独立请求 9 秒完成）。
export const buildStandaloneSummaryCompactionMessages = prompt => [{ role: 'user', content: String(prompt || '') }];

// 套用预设时放进预设「聊天记录」位置的数据：已有大总结 + 按时间标注的待合并摘要。
// 不加程序的任务说明与 <summary> 要求——由预设自己写（计划书第 6 节）。
export const buildSummaryCompactionPresetData = ({ items = [], compactedText = '' } = {}) => {
  const payload = buildSummaryCompactionPayload(items);
  if (!payload.trim()) return [];
  const previous = String(compactedText || '').trim();
  const parts = [
    ...(previous ? [`${compactionPrompt('previous_header', '【已有大总结】')}\n${previous}`] : []),
    `${compactionPrompt('history_header', '【前文内容（按时间标注的摘要列表）】')}\n${payload}`,
  ];
  return [{ role: 'user', content: parts.join('\n\n') }];
};

export const requestSummaryCompactionRaw = async ({
  items = [],
  compactedText = '',
  context = null,
  buildMessages = null,
  backgroundChat = null,
  options = null,
  rules = '',
  // 已解析的「套用预设」（agent-task-preset.js 的 resolve 结果）；有它就不用大总结规则与内置包装。
  taskPreset = null,
} = {}) => {
  if (taskPreset?.ok && typeof backgroundChat === 'function') {
    const data = buildSummaryCompactionPresetData({ items, compactedText });
    if (!data.length) return '';
    const rendered = taskPreset.render(data);
    if (!rendered?.ok) return '';
    // 温度等采样参数跟预设（presetId 交给 backgroundChat 解析）；输出上限仍按压缩固定。
    const { temperature: _temperature, presetContext = {}, ...rest } = options || {};
    const result = await backgroundChat(rendered.messages, {
      presetContext: { ...presetContext, presetId: taskPreset.id },
      ...rest,
      maxTokens: SUMMARY_COMPACTION_MAX_TOKENS,
      max_tokens: SUMMARY_COMPACTION_MAX_TOKENS,
    });
    return String(result || '').trim();
  }
  if (typeof buildMessages !== 'function' || typeof backgroundChat !== 'function') return '';
  const payload = buildSummaryCompactionPayload(items);
  if (!payload.trim()) return '';
  const prompt = buildSummaryCompactionPrompt({ payload, compactedText, rules });
  const built = buildMessages(prompt, context);
  // 预设生成参数里的 max_tokens 会盖过驼峰 maxTokens（OpenAI 类参数整理以 max_tokens 优先），
  // 两种写法都给，压缩上限才真正生效；否则会沿用正文的大上限，推理模型可长时间无输出。
  const result = await backgroundChat(built, {
    temperature: 0.2,
    ...(options || {}),
    maxTokens: SUMMARY_COMPACTION_MAX_TOKENS,
    max_tokens: SUMMARY_COMPACTION_MAX_TOKENS,
  });
  return String(result || '').trim();
};

export const buildSummaryCompactionContext = ({
  activeUser = null,
  sessionId = '',
  characterName = 'assistant',
  isGroup = false,
  groupMembers = [],
  groupMemberNames = [],
} = {}) => {
  const user = activeUser && typeof activeUser === 'object' ? activeUser : {};
  const members = Array.isArray(groupMembers) ? groupMembers : [];
  const memberNames = Array.isArray(groupMemberNames) ? groupMemberNames : [];
  return {
    user: {
      name: String(user?.name || '').trim() || getLocalizedPromptText('summary_compaction.default_user', '我'),
      persona: String(user?.description || ''),
      personaPosition: user?.position,
      personaDepth: user?.depth,
      personaRole: user?.role,
    },
    character: { name: String(characterName || '').trim() || 'assistant' },
    session: { id: String(sessionId || '').trim(), isGroup: Boolean(isGroup) },
    group: isGroup
      ? {
          id: String(sessionId || '').trim(),
          name: String(characterName || '').trim() || String(sessionId || '').trim(),
          members,
          memberNames,
        }
      : null,
    history: [],
    task: { type: 'summary_compaction' },
    meta: {
      disableChatGuide: true,
      disableScenarioHint: true,
      disableSummary: true,
      disableMomentSummary: true,
      overrideLastUserMessage: getLocalizedPromptText('summary_compaction.start', '开始总结，勿输出聊天格式'),
      skipInputRegex: true,
    },
  };
};

export const extractSummaryTagText = (input) => {
  const source = String(input || '');
  const re = /<summary>([\s\S]*?)<\/summary>/gi;
  let match;
  let last = null;
  while ((match = re.exec(source))) {
    last = match[1];
  }
  return String(last || '').trim();
};

export const isValidCompactedSummaryText = (text) => {
  const input = String(text || '');
  const hasHeader = /(?:【\s*关键事件\s*】|\[\s*Key Events\s*\])/i.test(input);
  const hasBullet = /^[ \t]*[•\-]\s*\S+/m.test(input);
  return hasHeader && hasBullet;
};

// 自定义大总结规则可以改标题、列表或段落：只要求 <summary> 里有足够的正文；默认规则仍按内置版式严格校验。
export const SUMMARY_COMPACTION_MIN_CUSTOM_LENGTH = 20;

export const parseSummaryCompactionResult = (input, { strictFormat = true } = {}) => {
  const raw = String(input || '').trim();
  if (!raw) return { raw: '', text: '', valid: false };
  const text = extractSummaryTagText(raw);
  const valid = Boolean(text) && (strictFormat
    ? isValidCompactedSummaryText(text)
    : text.replace(/\s+/g, '').length >= SUMMARY_COMPACTION_MIN_CUSTOM_LENGTH);
  return { raw, text, valid };
};

// 「套用预设」试运行的结果说明：预设自己定格式，所以用宽松校验（有 <summary> 且正文够长）。
export const describeSummaryCompactionTrial = (raw = '') => {
  const source = String(raw || '').trim();
  if (!source) return { ok: false, text: '', message: '模型返回为空' };
  const { text, valid } = parseSummaryCompactionResult(source, { strictFormat: false });
  if (valid) return { ok: true, text, message: '读到 <summary>，可以合并' };
  if (text) return { ok: false, text, message: '读到的 <summary> 内容太短，真的压缩时会算失败' };
  return {
    ok: false,
    text: source,
    message: '没读到 <summary>：这个预设可能是写正文用的。真的压缩时遇到这种情况会算失败，旧摘要保持不变。',
  };
};
