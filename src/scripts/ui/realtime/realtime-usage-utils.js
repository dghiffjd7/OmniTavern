import { t } from '../../i18n/index.js';

const emptyResponseUsage = () => ({
  totalTokens: null,
  inputTokens: null,
  outputTokens: null,
  inputTextTokens: null,
  inputAudioTokens: null,
  outputTextTokens: null,
  outputAudioTokens: null,
});

const emptyTranscriptionUsage = () => ({
  totalTokens: null,
  inputTokens: null,
  outputTokens: null,
  inputTextTokens: null,
  inputAudioTokens: null,
});

export const createRealtimeUsageTotals = () => ({
  responseCount: 0,
  transcriptionCount: 0,
  response: emptyResponseUsage(),
  transcription: emptyTranscriptionUsage(),
});

const toTokenCount = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
};

const addTokenCount = (current, value) => {
  const count = toTokenCount(value);
  if (count === null) return current ?? null;
  return (current ?? 0) + count;
};

const tokenDetails = (usage, direction) => {
  const singular = usage?.[`${direction}_token_details`];
  if (singular && typeof singular === 'object') return singular;
  const plural = usage?.[`${direction}_tokens_details`];
  return plural && typeof plural === 'object' ? plural : {};
};

const accumulateBucket = (bucket, usage, { includeOutputDetails = false } = {}) => {
  const inputDetails = tokenDetails(usage, 'input');
  const outputDetails = tokenDetails(usage, 'output');
  return {
    ...bucket,
    totalTokens: addTokenCount(bucket.totalTokens, usage?.total_tokens),
    inputTokens: addTokenCount(bucket.inputTokens, usage?.input_tokens),
    outputTokens: addTokenCount(bucket.outputTokens, usage?.output_tokens),
    inputTextTokens: addTokenCount(bucket.inputTextTokens, inputDetails.text_tokens),
    inputAudioTokens: addTokenCount(bucket.inputAudioTokens, inputDetails.audio_tokens),
    ...(includeOutputDetails ? {
      outputTextTokens: addTokenCount(bucket.outputTextTokens, outputDetails.text_tokens),
      outputAudioTokens: addTokenCount(bucket.outputAudioTokens, outputDetails.audio_tokens),
    } : {}),
  };
};

export const accumulateRealtimeUsage = (current, { type = '', usage = null, finalized = false } = {}) => {
  const totals = current && typeof current === 'object' ? current : createRealtimeUsageTotals();
  if (type === 'live_session') {
    const seconds = toTokenCount(usage?.seconds);
    return { ...totals, live: { seconds: seconds === null ? totals.live?.seconds ?? null : Math.max(totals.live?.seconds || 0, seconds), finalized: finalized || totals.live?.finalized === true } };
  }
  if (type === 'response') {
    return {
      ...totals,
      responseCount: Number(totals.responseCount || 0) + 1,
      response: accumulateBucket(totals.response || emptyResponseUsage(), usage, {
        includeOutputDetails: true,
      }),
    };
  }
  if (type === 'transcription') {
    return {
      ...totals,
      transcriptionCount: Number(totals.transcriptionCount || 0) + 1,
      transcription: accumulateBucket(totals.transcription || emptyTranscriptionUsage(), usage),
    };
  }
  return totals;
};

const formatTokenCount = value => (
  toTokenCount(value) === null ? '未提供' : toTokenCount(value).toLocaleString('zh-CN')
);

export const formatRealtimeUsageText = (value = {}) => {
  const response = value.response || emptyResponseUsage();
  if (value.live) return [
    t('Live 语音时长：{seconds} 秒 · {status}', { seconds: value.live.seconds ?? t('未提供'), status: value.live.finalized ? t('已确认') : t('等待最终确认') }),
    t('推理请求 {count} 次｜输入 {input} · 输出 {output} token', { count: value.responseCount || 0, input: formatTokenCount(response.inputTokens), output: formatTokenCount(response.outputTokens) }),
  ].join('\n');
  const transcription = value.transcription || emptyTranscriptionUsage();
  return [
    `语音回应 ${Number(value.responseCount || 0)} 次｜输入：文字 ${formatTokenCount(response.inputTextTokens)} · 音频 ${formatTokenCount(response.inputAudioTokens)} · 合计 ${formatTokenCount(response.inputTokens)}｜输出：文字 ${formatTokenCount(response.outputTextTokens)} · 音频 ${formatTokenCount(response.outputAudioTokens)} · 合计 ${formatTokenCount(response.outputTokens)}`,
    `输入转写 ${Number(value.transcriptionCount || 0)} 次｜输入 ${formatTokenCount(transcription.inputTokens)} · 输出 ${formatTokenCount(transcription.outputTokens)} · 总计 ${formatTokenCount(transcription.totalTokens)}`,
  ].join('\n');
};
