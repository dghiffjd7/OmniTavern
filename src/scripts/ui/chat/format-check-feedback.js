import { t } from '../../i18n/index.js';

/* 格式检查的结果反馈：检查中的消息内提示、每次都给出的结论文案，以及跳过原因的可读说明。
   消息内提示复用 Agent 消息部件（与格式修复候选同一个 id），模型给出修复候选时由候选部件直接替换。 */

export const FORMAT_CHECK_STATUS_PRESENTATION = 'format_check_status';
const FORMAT_CHECK_SOURCE = 'chat-format-guardian';

const trim = value => String(value ?? '').trim();

// 执行器与目标解析返回的原因码 → 用户看得懂的说明（未知原因原样透出，它们本身已是中文）
const skipReasonText = code => ({
  format_guide_missing: t('创意写作需要先在格式修复 Agent 里填写格式说明，才能检查格式。'),
  model_unavailable: t('格式修复 Agent 没有可用模型，请先在 Agent Center 配置。'),
  message_missing: t('这条回复已不存在，无法检查格式。'),
  no_source: t('这条回复没有可检查的原始内容。'),
  target_unavailable: t('这条回复没有可检查的完整原始内容。'),
  target_changed: t('回复在检查期间已变化，本次结果已丢弃。'),
  not_latest_turn: t('只能检查最新一轮已完成的 AI 回复。'),
  source_truncated: t('最新一轮原始回复已截断，无法安全检查格式。'),
  source_unavailable: t('无法取得这轮完整 AI 原始回复。'),
  turn_metadata_unavailable: t('这条回复缺少完整轮次来源，无法安全检查格式。'),
  review_failed: t('格式检查未完成，请稍后重试。'),
  user_cancelled: t('格式检查已取消。'),
})[code];

export const describeFormatCheckReason = (reason = '') => {
  const code = trim(reason);
  if (!code) return t('格式检查未完成，请稍后重试。');
  return skipReasonText(code) || t(code);
};

// 模型复查结论：no_change / candidate / 其他（失败、无法修复等由原有部件与提示处理）
export const summarizeFormatCheckResult = (result = null) => {
  const review = result?.modelReview && typeof result.modelReview === 'object' ? result.modelReview : null;
  const reviewStatus = trim(review?.status);
  const reason = trim(review?.repairSummary || review?.summary || review?.reason);
  if (reviewStatus === 'no_change' || (!review && trim(result?.status) === 'ready')) return { outcome: 'no_change', reason };
  if (review?.canRepair === true || trim(result?.status) === 'needs_review') return { outcome: 'candidate', reason };
  return { outcome: 'other', reason };
};

/* 消息内的格式检查状态部件。
   state: 'checking'（手动检查进行中）| 'no_change'（手动检查结论）| 'checked'（自动检查通过，只留淡标记） */
export const buildFormatCheckStatusPart = ({ messageId = '', sessionId = '', state = 'checking', reason = '', now = Date.now } = {}) => {
  const mid = trim(messageId);
  if (!mid) return null;
  const at = Number(now()) || 0;
  const titles = {
    checking: t('正在检查格式…'),
    no_change: t('已检查：未发现需要修复的格式问题'),
    checked: t('已检查格式'),
  };
  return {
    id: `chat-format-guardian:${mid}`,
    type: 'agent_status',
    source: FORMAT_CHECK_SOURCE,
    kind: 'chat_format.validate',
    status: state === 'checking' ? 'running' : 'succeeded',
    title: titles[state] || titles.checking,
    summary: trim(reason),
    createdAt: at,
    updatedAt: at,
    metadata: {
      presentation: FORMAT_CHECK_STATUS_PRESENTATION,
      state,
      sessionId: trim(sessionId),
      sourceMessageId: mid,
      // 手动检查认为无需修改时，给用户一个“仍然让 AI 重写”的出口（走原有的重试生成）
      decisionActions: state === 'no_change'
        ? [{ id: 'swipe_retry', label: t('仍然让 AI 重写'), enabled: true }]
        : [],
    },
  };
};

export const isFormatCheckStatusPart = part => part?.metadata?.presentation === FORMAT_CHECK_STATUS_PRESENTATION;

// 用状态部件替换消息上同 id 的格式检查部件；part 为 null 时移除
export const withFormatCheckStatusPart = (message = {}, part = null, messageId = '') => {
  const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
  const id = part?.id || `chat-format-guardian:${trim(messageId || message?.id)}`;
  const parts = (Array.isArray(meta.agentMessageParts) ? meta.agentMessageParts : []).filter(item => item?.id !== id);
  return { ...message, meta: { ...meta, agentMessageParts: part ? [...parts, part] : parts } };
};
