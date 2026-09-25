// One command submission, shared by the input bar and the continuous voice task queue.
import { t } from '../i18n/index.js';
export const createMaidCommandSubmit = ({
  getVoiceRuntime, getOnboardingRuntime, matchMaidIntent, hasConfiguredMaidProfile, resolveMaidRuntimeConfig,
  logger, checkMaidVisionInput, maidSettingsStore, buildAppFeatureSearchContextText, getAppContext,
  maidAssistantAgent, resolveSelectionRegion, requestMaidToolConfirmation, recordMaidTurnFromResult, toast,
} = {}) => {
  return async (text, controls = {}) => {
      await getVoiceRuntime()?.cancelInput();
      if (controls.source !== 'maid_realtime') await getVoiceRuntime()?.endCall();
      const intent = controls.context?.maidSkillContext?.loaded?.some(item => item.source === 'user') ? null : matchMaidIntent(text);
      if (intent) {
        if (intent.kind === 'skip') getOnboardingRuntime()?.skip?.();
        let flowId = String(intent.flowId || '').trim();
        if (flowId === 'first-chat' && !hasConfiguredMaidProfile()) flowId = 'setup-api';
        if (flowId) getOnboardingRuntime()?.startFlow?.(flowId);
        return {
          ok: true,
          responseType: 'local',
          message: flowId === 'setup-api' && intent.flowId === 'first-chat'
            ? '主人还没给我接上大脑呢～先把 API 接好，我就陪你完成第一次对话。'
            : intent.reply,
          actions: (Array.isArray(intent.chips) ? intent.chips : []).map(chip => ({
            label: chip.label,
            onClick: () => getOnboardingRuntime()?.startFlow?.(chip.flowId),
          })),
        };
      }
      const maidTurnContext = { ...getAppContext?.(), ...controls.context, submissionId: controls.submissionId, source: controls.source, voiceCallId: controls.voiceCallId, voiceRequestId: controls.voiceRequestId };
      let runtimeConfig = null;
      try {
        runtimeConfig = await resolveMaidRuntimeConfig(maidTurnContext);
      } catch (error) {
        logger.debug('maid runtime config unavailable for command input', error);
      }
      if (!runtimeConfig?.configured) {
        return {
          ok: true,
          responseType: 'local',
          message: '主人还没给我接上大脑呢～要我带你把 API 配好吗？',
          actions: [{
            label: '带我配置 API',
            onClick: () => getOnboardingRuntime()?.startFlow?.('setup-api'),
          }],
        };
      }
      const attachments = Array.isArray(controls?.attachments) ? controls.attachments : [];
      const visionCheck = await checkMaidVisionInput(attachments, maidTurnContext, runtimeConfig);
      if (!visionCheck.ok) {
        return {
          ok: false,
          status: 'failed',
          reason: visionCheck.capability?.status || 'maid_vision_not_supported',
          message: visionCheck.message,
        };
      }
      maidSettingsStore.setLastExchange({
        requestPrompt: '本次请求尚未发送模型提示词。',
        appContext: buildAppFeatureSearchContextText(text, { limit: 5 }),
        fullResponse: '',
        source: 'pending',
      });
      const result = await maidAssistantAgent.runPrompt(text, {
        ...maidTurnContext,
        maidAttachments: attachments,
        signal: controls?.signal || null,
        maxReactSteps: maidSettingsStore.getMaxReactSteps?.(),
        resolveMaidSelectionRegion: regionId => resolveSelectionRegion(regionId, maidTurnContext),
        requestToolConfirmation: requestMaidToolConfirmation,
        onStatus: (status = {}) => {
          const message = String(status?.message || '').trim();
          if (!message) return;
          controls?.setStatus?.(message, status?.tone || 'thinking');
        },
      });
      await recordMaidTurnFromResult({
        input: controls.source === 'maid_realtime' ? '' : text,
        result,
        context: controls.source === 'maid_realtime' ? { ...maidTurnContext, voiceRequestText: text } : maidTurnContext,
      });
      const latestExchange = maidSettingsStore.getLastExchange?.() || {};
      if (!String(latestExchange.requestPrompt || '').trim() || latestExchange.source === 'pending') {
        maidSettingsStore.setLastExchange({
          requestPrompt: '本次请求未成功调用模型提示词；未执行本地直连工具。',
          appContext: buildAppFeatureSearchContextText(text, { limit: 5 }),
          fullResponse: result?.message || result?.reason || '',
          source: 'no_model_result',
        });
      }
      if (controls.source === 'maid_realtime') return result;
      if (result?.ok === false && result?.status !== 'cancelled') {
        toast?.warning?.(result.message || result.reason || '女仆暂时无法执行这个请求');
      } else if (
        result?.message &&
        result?.responseType !== 'chat' &&
        !['awaiting_confirmation', 'cancelled'].includes(String(result?.status || '').trim())
      ) {
        // 完整回复已在女仆气泡中展示；通知只提示任务结束，不重复全文
        toast?.success?.(t('女仆已完成任务 ✓'));
      }
      return result;
  };
};
