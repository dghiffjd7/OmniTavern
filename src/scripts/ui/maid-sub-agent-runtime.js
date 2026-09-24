import { MAID_SUB_AGENT_SKILLS } from '../storage/maid-settings-store.js';

// Owns model delegation, its confirmation and fallback; app.js only supplies dependencies.
export const createMaidSubAgentRuntime = ({
  resolveMaidRuntimeConfig, listEnabledAgents, chatConfigManager, createClient,
  requestMaidToolConfirmation, buildAdHocWebSearchRuntime, logger = console,
} = {}) => {
  const subAgentSkillLabel = (skills = []) => skills
    .map(id => MAID_SUB_AGENT_SKILLS.find(item => item.id === id)?.label || id)
    .join('、');
  // sub-agent 委派执行体：解析 sub 档 -> 委派确认（允许一次/始终允许）-> 单轮生成 -> 失败回退主模型
  const generateWithSubAgent = async ({
    subAgentId = '',
    prompt = '',
    purposeLabel = '生成内容',
    webSearch = false,
    sessionId = '',
    context = {},
  } = {}) => {
    const runtime = await resolveMaidRuntimeConfig({ ...context, sessionId: context.sessionId || sessionId });
    // Phase B：委派也从统一 Agent Registry 取（capabilityTags=skills，modelProfileRef=modelProfileId）。
    const subAgents = listEnabledAgents().map(cap => ({
      id: cap.id,
      name: cap.name,
      skills: cap.capabilityTags,
      modelProfileId: cap.modelProfileRef,
      modelOverride: cap.modelOverride,
    }));
    let sub = subAgentId ? subAgents.find(item => item.id === subAgentId) : null;
    if (!sub && !subAgentId && subAgents.length === 1) sub = subAgents[0];
    let client = runtime?.configured ? runtime.client : null;
    let clientConfig = runtime?.config || {};
    let delegated = false;
    let modelUsed = String(runtime?.config?.model || '');
    let subAgentName = '';
    // 没有可用的任务执行模型时，拒绝委派就是不执行，不能再提供“用主模型”
    const hasMainModel = Boolean(runtime?.configured && runtime.client);
    let subProfileMissing = false;
    if (sub) {
      const confirm = context?.requestToolConfirmation || requestMaidToolConfirmation;
      let allowed = true;
      try {
        // 与其他工具确认一致：带上 run 与取消信号，才能显示在任务卡片里，并在任务取消时收起
        const decision = await confirm({
          toolName: 'sub_agent.delegate',
          kind: 'sub_agent.delegate',
          operationType: 'model',
          riskLevel: 'low',
          danger: false,
          title: '使用 Sub-agent 模型',
          message: `女仆想使用「${sub.name}${sub.skills?.length ? `（${subAgentSkillLabel(sub.skills)}）` : ''}」执行：${purposeLabel}`,
          confirmText: '允许',
          cancelText: hasMainModel ? '用主模型' : '不执行',
        }, { signal: context?.signal, runId: context?.runId });
        allowed = decision === true || ['allow', 'allow_once', 'allow_always'].includes(String(decision?.decision || ''));
      } catch {
        allowed = false;
      }
      if (context?.signal?.aborted) {
        return { ok: false, reason: 'user_aborted', message: '任务已取消，未生成内容。' };
      }
      if (!allowed && !hasMainModel) {
        return { ok: false, reason: 'sub_agent_declined', message: '已取消，未生成内容。' };
      }
      if (allowed) {
        subProfileMissing = true;
        try {
          const cfg = await chatConfigManager.getRuntimeConfigByProfileId(sub.modelProfileId);
          if (cfg) {
            subProfileMissing = false;
            const effective = {
              ...(sub.modelOverride ? { ...cfg, model: sub.modelOverride } : cfg),
              timeout: Math.min(Number(cfg.timeout) > 0 ? Number(cfg.timeout) : 240000, 240000),
            };
            client = createClient(effective);
            clientConfig = effective;
            delegated = true;
            modelUsed = String(effective.model || '');
            subAgentName = sub.name;
          }
        } catch (err) {
          logger.warn('resolve sub-agent config failed, using main model', err);
        }
      }
    }
    if (!client) {
      return subProfileMissing
        ? { ok: false, reason: 'sub_agent_profile_missing', message: `Sub-agent「${sub?.name || ''}」绑定的连线配置已不存在。` }
        : { ok: false, reason: 'maid_api_not_configured', message: '女仆 API 未配置。' };
    }
    const runChat = async (targetClient, targetConfig) => {
      let sources = [];
      const generation = buildAdHocWebSearchRuntime({
        client: targetClient,
        config: targetConfig,
        enabled: webSearch === true,
        sessionId: String(sessionId || `maid-generation:${purposeLabel}`).slice(0, 240),
        requestOptions: {
          temperature: 0.7,
          maxTokens: 2400,
          max_tokens: 2400,
          ...(context?.signal ? { signal: context.signal } : {}),
        },
        onStatus: status => {
          const message = String(status?.message || '').trim();
          if (message) context?.onStatus?.({ message, tone: status?.state === 'unavailable' ? 'warning' : 'thinking' });
        },
        onSources: nextSources => {
          sources = Array.isArray(nextSources) ? nextSources.slice() : [];
        },
      });
      const text = String(await generation.client.chat(
        [{ role: 'user', content: prompt }],
        generation.requestOptions,
      ) || '').trim();
      return {
        text,
        sources,
        webSearchUsed: generation.plan?.enabled === true,
        webSearchReason: String(generation.plan?.diagnostics?.reason || ''),
      };
    };
    try {
      const generated = await runChat(client, clientConfig);
      if (!generated.text) throw new Error('empty response');
      return {
        ok: true,
        ...generated,
        delegated,
        modelUsed,
        subAgentName,
        ...(subAgents.length ? {} : { hint: 'no_sub_agent_configured', hintMessage: '提示：可在女仆设置的 API 分页配置 sub-agent 模型，这类生成任务可交给便宜模型执行。' }),
      };
    } catch (error) {
      if (delegated && runtime?.configured && runtime.client && !context?.signal?.aborted) {
        // sub 档失败回退主模型一次
        try {
          const generated = await runChat(runtime.client, runtime.config || {});
          if (!generated.text) throw new Error('empty response');
          return {
            ok: true,
            ...generated,
            delegated: false,
            fallbackUsed: true,
            modelUsed: String(runtime.config?.model || ''),
            subAgentName: '',
          };
        } catch (err2) {
          return { ok: false, reason: 'generation_failed', message: err2?.message || '生成失败（含主模型回退）。' };
        }
      }
      return { ok: false, reason: 'generation_failed', message: error?.message || '生成失败。' };
    }
  };
  return generateWithSubAgent;
};
