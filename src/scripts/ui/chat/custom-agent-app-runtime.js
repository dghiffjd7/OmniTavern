import { createCustomAgentRequestRuntime } from '../../agent/custom-agent-request-runtime.js';
import { agentRequestTimeoutMs } from '../../agent/agent-generation-settings.js';
import { PROVIDER_TOOL_PERMISSION_ACTIONS, applyProviderToolPermissionAction, buildProviderToolPermissionPromptMessage } from '../../agent/provider-tool-permission-actions.js';

// Bind model snapshots and existing APP permissions to the bounded tool runtime.
// Permission decisions belong to the captured conversation, including after a dialog.
export const createCustomAgentAppRuntime = ({ createClient, getProfileConfig, resolveCurrentModel,
  getContext, registry, permissionEvaluator, choosePermission } = {}) => {
  const captureModel = async (config, context) => {
    if (config.modelMode === 'none') throw new Error('请先选择模型');
    const model = config.modelMode === 'profile' ? await getProfileConfig(config.modelProfileId) : await resolveCurrentModel(context);
    if (!model) throw new Error('指定的模型配置不存在');
    return { ...model, ...(config.modelOverride ? { model: config.modelOverride } : {}), timeout: agentRequestTimeoutMs(config, 120000) };
  };
  const active = context => ['sessionId', 'scopeId', 'archiveId', 'place'].every(key =>
    String(getContext()?.[key] || '') === String(context?.[key] || ''));
  const check = context => {
    if (context.signal?.aborted || context.isCurrent?.() === false || !active(context))
      throw Object.assign(new Error('当前会话已变化，请重新运行'), { name: 'AbortError' });
  };
  const runtime = createCustomAgentRequestRuntime({ createClient, listTools: () => registry.listTools(),
    readNetworkAllowed: ({ model }) => model.webSearchEnabled === true,
    executeTool: async (name, args, context) => {
      check(context);
      const explicit = permissionEvaluator.evaluate({ ...context, toolName: name, permission: '*' });
      if (explicit.matchedRules?.length && explicit.decision === 'deny') throw new Error('此工具已被权限设置停用');
      return registry.executeTool(name, args, { ...context,
        requestPermission: async request => {
          check(context); context.onToolConfirmationPending?.(request);
          try {
            const action = await choosePermission({ signal: context.signal, title: 'Agent 工具权限', message: buildProviderToolPermissionPromptMessage(request),
              defaultActionId: PROVIDER_TOOL_PERMISSION_ACTIONS.deny,
              actions: [
                { id: PROVIDER_TOOL_PERMISSION_ACTIONS.allowOnce, label: '执行一次', primary: true },
                { id: PROVIDER_TOOL_PERMISSION_ACTIONS.rememberAllow, label: '记住执行' },
                { id: PROVIDER_TOOL_PERMISSION_ACTIONS.deny, label: '打回', variant: 'danger' },
              ],
            });
            check(context);
            return applyProviderToolPermissionAction(action, request, { permissionEvaluator, sessionId: context.sessionId, layer: 'session' });
          } finally { context.onToolConfirmationResolved?.(request); }
        },
      });
    },
  });
  return { captureModel,
    preview: async ({ request, config, context }) => {
      if (!active(context)) throw new Error('当前会话已变化，请重新运行');
      if (config.modelMode === 'none') return { ...request, previewNote:'尚未选择模型，以下展示提示词组装。' };
      const model = await captureModel(config, context);
      const result = await runtime.preview({ request, config, context, model });
      if (!active(context)) throw new Error('当前会话已变化，请重新运行');
      return result;
    },
    listAvailableTools: async ({ config, context }) => {
      const model = await captureModel(config, context);
      return (await runtime.listAvailableTools({ model, context })).map(tool => ({ ...tool, label: tool.title, category: tool.group }));
    },
    request: (request, model, signal, context, execution = {}) => runtime.request({ request, model, signal,
      context: { ...context, isCurrent: () => execution.canContinue?.() !== false && active(context) },
      config: execution.config, canContinue: execution.canContinue, onTrace: execution.onTrace }),
  };
};
