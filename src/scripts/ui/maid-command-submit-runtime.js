// One command submission, shared by the input bar and the continuous voice task queue.
import { t } from '../i18n/index.js';
import { captureMaidTextApprovalScope, sameMaidTextApprovalScope } from './maid-text-approval-reply.js';
import { collectMaidResultCardsFromResult } from '../agent/maid-result-cards.js';
export const isPreApprovedByPlan = (approvedPlan, request = {}) => {
  const tools = Array.isArray(approvedPlan?.tools) ? approvedPlan.tools : [];
  const toolName = String(request?.toolName || '').trim();
  if (!toolName || !tools.includes(toolName) || request?.escalation) return false;
  const operation = `${request?.operationType || ''} ${request?.kind || ''}`.toLowerCase();
  return !/delete|remove|destroy/.test(operation);
};

export const createMaidCommandSubmit = ({
  getVoiceRuntime, getOnboardingRuntime, resolveMaidRuntimeConfig,
  logger, checkMaidVisionInput, maidSettingsStore, buildAppFeatureSearchContextText, getAppContext,
  maidAssistantAgent, resolveSelectionRegion, requestMaidToolConfirmation, recordMaidTurnFromResult, toast,
  markFileAttachmentsSubmitted = null, listRecentFileAttachments = null, buildResultActions = null,
} = {}) => {
  return async (text, controls = {}) => {
      await getVoiceRuntime()?.cancelInput();
      if (controls.source !== 'maid_realtime') await getVoiceRuntime()?.endCall();
      const appContext = getAppContext?.() || {};
      const maidTurnContext = { ...appContext, ...controls.context,
        roleCardId: appContext.roleCardId, agentId: appContext.agentId,
        submissionId: controls.submissionId, source: controls.source, voiceCallId: controls.voiceCallId, voiceRequestId: controls.voiceRequestId };
      const revisionScope = controls.maidTextApprovalRevision?.scope;
      const rejectChangedRevision = () => revisionScope && !sameMaidTextApprovalScope(revisionScope, getAppContext?.());
      const changedRevision = () => ({ ok: false, status: 'cancelled', reason: 'approval_revision_scope_changed',
        message: t('页面或角色卡已变化，未提交修改后的任务。请在目标页面重新说明。') });
      if (rejectChangedRevision()) return changedRevision();
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
      let attachments = Array.isArray(controls?.attachments) ? controls.attachments : [];
      const visionCheck = await checkMaidVisionInput(attachments, maidTurnContext, runtimeConfig);
      // 角色卡 PNG 的数据由本地解析，不依赖看图：模型不支持图片时只去掉画面，保留卡摘要
      const imageAttachments = attachments.filter(item => item?.kind === 'image');
      if (!visionCheck.ok && imageAttachments.length && imageAttachments.every(item => item.file?.format === 'character_card')) {
        attachments = attachments.map(item => (item?.kind === 'image' ? { ...item, kind: 'file', url: '', llmUrl: '' } : item));
      } else if (!visionCheck.ok) {
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
      if (rejectChangedRevision()) return changedRevision();
      const approvalScope = captureMaidTextApprovalScope(maidTurnContext);
      // 文件附件按本次发送时的会话／角色卡解释「当前」；之前上传未导入的文件供追问后继续使用
      markFileAttachmentsSubmitted?.(attachments.filter(item => item?.file), maidTurnContext);
      const maidRecentFileAttachments = listRecentFileAttachments?.({ excludeIds: attachments.map(item => item?.id).filter(Boolean) }) || [];
      const result = await maidAssistantAgent.runPrompt(text, {
        ...maidTurnContext,
        maidAttachments: attachments,
        maidRecentFileAttachments,
        signal: controls?.signal || null,
        maxReactSteps: maidSettingsStore.getMaxReactSteps?.(),
        resolveMaidSelectionRegion: regionId => resolveSelectionRegion(regionId, maidTurnContext),
        // 计划卡上点「开始做」（ROADMAP 29-⑨）：计划里写明的写入工具本轮不再逐个确认；
        // 删除、只读请求里的写入升级确认等仍照常弹（只免普通写入的确认）
        requestToolConfirmation: (request, options = {}) => (isPreApprovedByPlan(controls?.approvedPlan, request)
          ? Promise.resolve('allow')
          : requestMaidToolConfirmation(request, {
            ...options, submissionId: controls.submissionId, ...approvalScope,
          })),
        onStatus: (status = {}) => {
          const message = String(status?.message || '').trim();
          if (!message) return;
          controls?.setStatus?.(message, status?.tone || 'thinking');
        },
      });
      await recordMaidTurnFromResult({
        // The input runtime already recorded a revision verbatim when it
        // withdrew the old approval. The stitched planner goal is audit data.
        input: controls.source === 'maid_realtime' || controls.maidTextApprovalRevision ? '' : text,
        result,
        context: controls.source === 'maid_realtime' ? { ...maidTurnContext, voiceRequestText: text }
          : controls.maidTextApprovalRevision
            ? { ...maidTurnContext, textApprovalRevision: { ...controls.maidTextApprovalRevision, replanningInput: text } }
            : maidTurnContext,
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
      // 结果卡片：成功步骤的工具返回，加上收尾反问附的选项卡；文字回复区与语音托盘都从这里读
      const cards = collectMaidResultCardsFromResult(result);
      if (cards.length && result && typeof result === 'object') result.cards = cards;
      if (controls.source === 'maid_realtime') return result;
      // 导入附件后提供「打开」按钮（按成功的导入步骤生成）
      const importActions = buildResultActions?.(result) || [];
      if (importActions.length && result && typeof result === 'object') {
        result.actions = [...(Array.isArray(result.actions) ? result.actions : []), ...importActions];
      }
      if (result?.ok === false && result?.status !== 'cancelled') {
        toast?.warning?.(result.message || result.reason || '女仆暂时无法执行这个请求');
      } else if (
        result?.message &&
        result?.responseType !== 'chat' &&
        !['awaiting_confirmation', 'cancelled'].includes(String(result?.status || '').trim()) &&
        // 停下来问你（选项卡）或交出计划等你点「开始做」：还没做完，不提示完成
        !['clarify', 'plan'].includes(String(result?.finalDecision?.providerFcControl || ''))
      ) {
        // 完整回复已在女仆气泡中展示；通知只提示任务结束，不重复全文
        toast?.success?.(t('女仆已完成任务 ✓'));
      }
      return result;
  };
};
