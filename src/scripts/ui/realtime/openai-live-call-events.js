import { t } from '../../i18n/index.js';
import { OpenAiLiveTranscript } from './openai-live-transcript.js';
import { accumulateRealtimeUsage, createRealtimeUsageTotals } from './realtime-usage-utils.js';

// Own Live-specific transcript revisions and usage. No synthetic response.done
// events: a visual transcript group must never trigger a complete text turn.
export const createOpenAiLiveCallEvents = ({ target, settings, commitTranscript, isTargetCurrent, onCaption, onUsage, onError, onWarning,
  onStarted, onActivity, onEnded, enqueue, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) => {
  const transcript = new OpenAiLiveTranscript();
  const completedResponses = new Set();
  let timer = null, sessionId = '', finalUsage = false, ended = false;
  let usageTotals = createRealtimeUsageTotals();
  const reportUsage = event => { usageTotals = accumulateRealtimeUsage(usageTotals, event); onUsage?.(event); };
  const saveFinalUsage = () => { const last = transcript.groups[transcript.groups.length - 1]; if (last) last.revision++; };
  const flush = async () => {
    if (timer !== null) clearTimeoutFn(timer); timer = null;
    for (const group of transcript.groups) {
      if (group.detached || group.savedRevision === group.revision || !isTargetCurrent(target)) continue;
      const revision = group.revision, text = group.text;
      const result = await commitTranscript?.({ target, group: { ...group, fragments: [...group.fragments] }, meta: {
        generationChannel: 'openai_live', realtimeProvider: 'openai', realtimeContextMode: 'full_duplex',
        realtimeModel: settings.realtimeModel, realtimeBackendModel: settings.liveBackendModel,
        realtimeVoice: settings.voice, realtimeSessionId: sessionId,
        realtimeLiveUsage: { ...usageTotals.live, backendRequests: usageTotals.responseCount,
          backendInputTokens: usageTotals.response.inputTokens, backendOutputTokens: usageTotals.response.outputTokens },
      } });
      if (!result) throw new Error(t('语音字幕保存失败'));
      if (result.ignored) group.detached = true;
      else { group.messageId = result.messageId; group.savedText = text; group.savedRevision = revision; }
    }
  };
  const scheduleFlush = () => {
    if (timer !== null || ended) return;
    timer = setTimeoutFn(() => {
      timer = null;
      void enqueue(async () => {
        try { await flush(); }
        catch (error) { onError?.(error); onEnded?.('persistence_failed'); }
      });
    }, 750);
  };
  const handle = event => {
    const type = event.type;
    if (type === 'session.started') {
      sessionId = String(event.session?.id || ''); onStarted?.(sessionId);
      reportUsage({ type: 'live_session', usage: { seconds: null }, finalized: false });
    } else if (type === 'session.input_transcript.delta' || type === 'session.output_transcript.delta') {
      try {
        if (transcript.append(event)) { onActivity?.(); onCaption?.({ captions: transcript.captions() }); scheduleFlush(); }
      } catch (error) { onError?.(error); onEnded?.('transcript_limit'); }
    } else if (type === 'session.usage.updated' || type === 'session.closed') {
      finalUsage ||= type === 'session.closed';
      reportUsage({ type: 'live_session', usage: event.usage, finalized: finalUsage });
      if (type === 'session.closed') {
        ended = true; saveFinalUsage();
        if (event.reason === 'content') onWarning?.(t('服务商已结束本次语音通话'));
        onEnded?.(event.reason || 'remote_hangup');
      }
    } else if (type === 'response.event') {
      const nested = event.event;
      if (['response.completed', 'response.failed', 'response.incomplete'].includes(nested?.type)) {
        const response = nested.response || {}, id = response.id;
        if (id && !completedResponses.has(id)) {
          completedResponses.add(id);
          if (response.usage) { reportUsage({ type: 'response', responseId: id, usage: response.usage }); if (finalUsage) saveFinalUsage(); }
          if (response.status === 'failed' || nested.type === 'response.failed') onError?.(new Error(String(response.error?.message || t('GPT-Live 推理请求失败'))));
        }
      } else if (nested?.type === 'error') onError?.(new Error(String(nested.message || nested.error?.message || t('GPT-Live 推理请求失败'))));
    } else if (type === 'live.finalization.incomplete' && !finalUsage) {
      saveFinalUsage();
      onWarning?.(t('连接已释放，服务端最终通话用量尚未确认'));
    } else if (type === 'error') {
      onError?.(new Error(String(event.error?.message || t('GPT-Live 服务发生错误'))));
    }
  };
  return { handle, flush, getGroups: () => transcript.groups, dispose: () => { ended = true; if (timer !== null) clearTimeoutFn(timer); timer = null; } };
};
