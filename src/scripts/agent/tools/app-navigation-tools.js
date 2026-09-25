import {
  buildAppFeatureDoc,
  searchAppFeatures,
} from '../app-feature-catalog.js';
import { readMaidSkill } from '../maid-skill-catalog.js';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

export const APP_NAVIGATION_PANEL_IDS = Object.freeze([
  'agent-center',
  'config',
  'session',
  'session-config',
  'group-create',
  'worldbook',
  'memory',
  'variables',
  'regex',
  'preset',
  'extensions',
  'settings',
]);

const normalizePanelId = (panel = '') => {
  const text = trim(panel).toLowerCase().replace(/_/g, '-');
  if (text === 'agent' || text === 'agentcenter' || text === 'agent-center') return 'agent-center';
  if (text === 'api' || text === 'model' || text === 'models' || text === 'config') return 'config';
  if (text === 'sessionconfig' || text === 'chat-config' || text === 'session-config') return 'session-config';
  if (text === 'group' || text === 'create-group' || text === 'new-group' || text === 'group-create') return 'group-create';
  if (text === 'world' || text === 'world-info' || text === 'worldbook') return 'worldbook';
  if (text === 'memory-template' || text === 'memory-center' || text === 'memory') return 'memory';
  if (text === 'variable' || text === 'variables') return 'variables';
  if (text === 'regex' || text === 'postprocess') return 'regex';
  if (text === 'friend' || text === 'contacts' || text === 'session') return 'session';
  if (text === 'preset' || text === 'prompt') return 'preset';
  if (text === 'extension' || text === 'extensions' || text === 'plugin') return 'extensions';
  if (text === 'settings' || text === 'general-settings') return 'settings';
  return text;
};

const invokePanelAction = async (actions = {}, panel = '', args = {}) => {
  const id = normalizePanelId(panel);
  const fn = actions[id];
  if (typeof fn !== 'function') {
    return {
      ok: false,
      opened: false,
      panel: id,
      reason: `unsupported panel: ${id || '-'}`,
    };
  }
  const result = await fn(isPlainObject(args) ? args : {});
  return {
    ok: result?.ok === false ? false : true,
    opened: result?.opened === false ? false : true,
    panel: id,
    result: clone(result),
  };
};

const createVisiblePanelInspectTool = ({
  name = 'app.ui.inspect',
  title = 'Inspect visible APP UI',
  description = 'Read a structured summary of currently visible APP panels and active UI.',
  getVisiblePanelSummary = null,
} = {}) => ({
  name,
  title,
  description,
  source: 'maid-app-navigation',
  permissions: [],
  riskLevel: 'low',
  capabilities: {
    read: true,
    write: false,
    network: false,
    cost: 'none',
    undo: 'none',
    modelContext: 'allowlist',
    confirmation: 'allow_once',
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      panel: { type: 'string', maxLength: 80 },
      maxTextLength: { type: 'integer', minimum: 120, maximum: 6000 },
    },
  },
  execute: async (args = {}) => {
    if (typeof getVisiblePanelSummary !== 'function') {
      return { ok: false, reason: 'visible_panel_summary_unavailable' };
    }
    const summary = await getVisiblePanelSummary(args);
    return isPlainObject(summary) ? clone(summary) : { ok: true, summary };
  },
  summarizeResult: result => result?.ok === false
    ? `visible panel summary failed: ${trim(result?.reason, 'unavailable')}`
    : `visible panel summary panels=${Number(result?.panels?.length || 0)}`,
});

const UI_CLICK_DANGER_PATTERN = /删除|覆盖|清空|移除|解绑|重置|清除|发送|撤销|注销|卸载/;

export const createAppNavigationAgentTools = ({
  actions = {},
  getCurrentState = () => ({}),
  getVisiblePanelSummary = null,
  describeUiElement = null,
  beginUiElementConfirmation = null,
  clickUiElement = null,
  readResource = null,
  listRecentErrors = null,
} = {}) => [
  {
    name: 'app.read_recent_errors',
    title: 'Read recent errors',
    description: 'Read recent maid run failures and tool errors so the assistant can explain what went wrong.',
    source: 'maid-app-navigation',
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: true,
      write: false,
      network: false,
      cost: 'none',
      undo: 'none',
      modelContext: 'allowlist',
      confirmation: 'allow_once',
    },
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    execute: async (args = {}) => {
      if (typeof listRecentErrors !== 'function') {
        return { ok: false, reason: 'recent_errors_unavailable' };
      }
      const errors = (await listRecentErrors({ limit: Number(args.limit) || 10 })) || [];
      return {
        ok: true,
        count: errors.length,
        errors: clone(errors),
      };
    },
    summarizeResult: result => (result?.ok === false
      ? 'recent errors unavailable'
      : `found ${Number(result?.count || 0)} recent error(s)`),
  },
  {
    name: 'app.search_feature',
    title: 'Search APP features',
    description: 'Search the APP feature catalog by user wording.',
    source: 'maid-app-navigation',
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: true,
      write: false,
      network: false,
      cost: 'none',
      undo: 'none',
      modelContext: 'allowlist',
      confirmation: 'allow_once',
    },
    schema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 160 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    execute: async (args = {}) => ({
      query: trim(args.query),
      features: searchAppFeatures(args.query, { limit: args.limit }),
    }),
    summarizeResult: result => `found ${Number(result?.features?.length || 0)} feature(s)`,
  },
  {
    name: 'app.read_feature_doc',
    title: 'Read APP feature doc',
    description: 'Read a concise feature document from the APP feature catalog.',
    source: 'maid-app-navigation',
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: true,
      write: false,
      network: false,
      cost: 'none',
      undo: 'none',
      modelContext: 'allowlist',
      confirmation: 'allow_once',
    },
    schema: {
      type: 'object',
      required: ['featureId'],
      additionalProperties: false,
      properties: {
        featureId: { type: 'string', minLength: 1, maxLength: 80 },
      },
    },
    execute: async (args = {}) => {
      const feature = buildAppFeatureDoc(args.featureId);
      if (!feature) return { ok: false, featureId: trim(args.featureId), reason: 'feature_not_found' };
      return { ok: true, feature };
    },
    summarizeResult: result => result?.ok === false ? 'feature doc not found' : `feature doc: ${trim(result?.feature?.id)}`,
  },
  {
    name: 'app.read_skill',
    title: 'Read maid workflow',
    description: 'Read a workflow from the maid skill index. This does not execute actions or grant permissions.',
    source: 'maid-app-navigation',
    permissions: [],
    riskLevel: 'low',
    capabilities: { read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'allowlist', confirmation: 'allow_once' },
    schema: {
      type: 'object', required: ['skillId'], additionalProperties: false,
      properties: { skillId: { type: 'string', minLength: 1, maxLength: 80 } },
    },
    execute: async (args = {}) => {
      const skill = readMaidSkill(args.skillId);
      return skill ? { ok: true, skill } : { ok: false, reason: 'skill_not_found' };
    },
    summarizeResult: result => result?.ok ? `workflow: ${result.skill.title}` : 'workflow not found',
  },
  {
    name: 'app.open_panel',
    title: 'Open APP panel',
    description: 'Open a safe APP panel such as config, Agent Center, worldbook, memory, variables, or regex.',
    source: 'maid-app-navigation',
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: false,
      write: false,
      network: false,
      cost: 'none',
      undo: 'none',
      modelContext: 'none',
      confirmation: 'allow_once',
    },
    schema: {
      type: 'object',
      required: ['panel'],
      additionalProperties: false,
      properties: {
        panel: { type: 'string', minLength: 1, maxLength: 60 },
        tab: { type: 'string', maxLength: 40 },
        sessionId: { type: 'string', maxLength: 160 },
        focus: { type: 'string', maxLength: 80 },
      },
    },
    execute: async (args = {}) => invokePanelAction(actions, args.panel, args),
    summarizeResult: result => result?.opened ? `opened ${trim(result.panel, 'panel')}` : `open panel failed: ${trim(result?.reason, 'unsupported panel')}`,
  },
  createVisiblePanelInspectTool({ getVisiblePanelSummary }),
  {
    name: 'ui.click_element',
    title: 'Click UI element',
    description: 'Click a visible UI element by ref (from app.ui.inspect) or unique label. Returns the updated UI summary after the click. Dangerous buttons (delete/replace/send etc.) require user confirmation.',
    source: 'maid-app-navigation',
    permissions: [],
    riskLevel: 'medium',
    capabilities: {
      read: true,
      write: true,
      network: false,
      cost: 'none',
      undo: 'manual',
      modelContext: 'allowlist',
      confirmation: 'allow_once',
    },
    metadata: {
      // 普通标签页/折叠项点击属于只读导航；危险按钮仍由下方动态检查拦截。
      allowInReadOnlyIntent: true,
    },
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ref: { type: 'string', maxLength: 120 },
        label: { type: 'string', maxLength: 80 },
        panel: { type: 'string', maxLength: 80 },
      },
    },
    execute: async (args = {}, context = {}) => {
      if (typeof clickUiElement !== 'function') {
        return { ok: false, reason: 'ui_click_unavailable' };
      }
      const targetRef = trim(args.ref);
      let targetText = trim(args.label);
      let targetPanel = trim(args.panel);
      if (targetRef) {
        if (typeof describeUiElement !== 'function') {
          return { ok: false, reason: 'ui_describe_unavailable' };
        }
        const described = await describeUiElement({ ref: targetRef });
        if (described?.ok === false) return described;
        targetText = trim(described?.label);
        targetPanel = trim(described?.panel) || targetPanel;
        if (!targetText) {
          return { ok: false, reason: 'element_label_unavailable', message: '无法核验目标元素的真实文案。' };
        }
      }
      if (!targetText) targetText = targetRef;
      // 危险按钮（删除/覆盖/发送等）必须经用户确认；只读导航类放行
      if (UI_CLICK_DANGER_PATTERN.test(targetText)) {
        if (context?.operationIntentPolicy?.mode === 'read_only') {
          return {
            ok: false,
            clicked: false,
            reason: 'agent_tool_write_intent_required',
            message: '用户本轮只要求查询或查看，不能点击可能写入、发送或删除数据的按钮。',
          };
        }
        const confirm = context?.requestToolConfirmation;
        let allowed = false;
        const endConfirmation = typeof beginUiElementConfirmation === 'function'
          ? beginUiElementConfirmation({ ref: targetRef, label: targetText, panel: targetPanel })
          : null;
        if (typeof confirm === 'function') {
          try {
            const decision = await confirm({
              toolName: 'ui.click_element',
              kind: 'ui.click_danger',
              operationType: 'write',
              riskLevel: 'medium',
              danger: true,
              title: '确认界面操作',
              message: `女仆想点击「${targetText}」——这可能执行删除/覆盖/发送类操作。`,
              confirmText: '允许点击',
              cancelText: '取消',
            });
            allowed = decision === true || ['allow', 'allow_once', 'allow_always'].includes(String(decision?.decision || ''));
          } catch {
            allowed = false;
          } finally {
            if (typeof endConfirmation === 'function') endConfirmation();
          }
        } else if (typeof endConfirmation === 'function') {
          endConfirmation();
        }
        if (!allowed) {
          return { ok: false, reason: 'user_declined', cancelled: true, message: `用户未允许点击「${targetText}」。` };
        }
      }
      return clickUiElement({ ref: targetRef, label: targetText, panel: targetPanel });
    },
    summarizeResult: result => (result?.ok === false
      ? `ui click failed: ${trim(result?.reason, 'unknown')}`
      : `clicked ${trim(result?.clicked, 'element')}; panels now: ${(result?.after?.panels || []).map(p => p.id).join(',') || 'unchanged'}`),
  },
  createVisiblePanelInspectTool({
    name: 'app.read_visible_panel_summary',
    title: 'Read visible APP panel summary',
    description: 'Legacy alias for app.ui.inspect. Read a structured summary of currently visible APP panels and active UI.',
    getVisiblePanelSummary,
  }),
  {
    name: 'app.read_resource',
    title: 'Read APP resource',
    description: 'Read structured APP resources such as chat messages, worldbook settings, regex, memory, variables, presets, config, sessions, personas, or users. Persona/user lists are compact by default; request profile fields through include only when needed. Persona associations expose only saved binding references. Session include:["members","worldbooks"] returns compact group-member IDs plus inherited role-world and direct-binding evidence.',
    source: 'maid-app-navigation',
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: true,
      write: false,
      network: false,
      cost: 'none',
      undo: 'none',
      modelContext: 'allowlist',
      confirmation: 'allow_once',
    },
    schema: {
      type: 'object',
      required: ['resource'],
      additionalProperties: false,
      properties: {
        resource: { type: 'string', minLength: 1, maxLength: 80 },
        id: { type: 'string', maxLength: 200 },
        name: { type: 'string', maxLength: 200 },
        worldbookId: { type: 'string', maxLength: 200 },
        entryId: { type: 'string', maxLength: 200 },
        entryTitle: { type: 'string', maxLength: 200 },
        sessionId: { type: 'string', maxLength: 200 },
        sessionName: { type: 'string', maxLength: 200 },
        target: { type: 'string', maxLength: 200 },
        chatName: { type: 'string', maxLength: 200 },
        scope: { type: 'string', maxLength: 80 },
        includeContent: { type: 'boolean' },
        include: {
          type: 'array',
          description: 'Optional fields to expand. For persona/user use associations, description, avatar, or details. For session use members and/or worldbooks. For regex use rules only when the user explicitly asks to debug raw regex bodies; format inference must use formatEvidence instead.',
          items: { type: 'string', maxLength: 80 },
          maxItems: 30,
        },
        query: { type: 'string', maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        maxEntries: { type: 'integer', minimum: 1, maximum: 200 },
        maxTextLength: { type: 'integer', minimum: 120, maximum: 12000 },
        maxContentLength: { type: 'integer', minimum: 120, maximum: 12000 },
      },
    },
    execute: async (args = {}) => {
      if (typeof readResource !== 'function') {
        return { ok: false, reason: 'resource_reader_unavailable', resource: trim(args.resource) };
      }
      const result = await readResource(args);
      return isPlainObject(result) ? clone(result) : { ok: true, resource: trim(args.resource), result };
    },
    summarizeResult: result => result?.ok === false
      ? `read resource failed: ${trim(result?.resource, '-')} ${trim(result?.reason, 'unknown')}`
      : `read resource ${trim(result?.resource, '-')}`,
  },
  {
    name: 'app.get_current_state',
    title: 'Get APP state',
    description: 'Read a concise snapshot of current APP state for assistant grounding.',
    source: 'maid-app-navigation',
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: true,
      write: false,
      network: false,
      cost: 'none',
      undo: 'none',
      modelContext: 'allowlist',
      confirmation: 'allow_once',
    },
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    execute: async () => {
      const state = await getCurrentState?.();
      return isPlainObject(state) ? clone(state) : {};
    },
    summarizeResult: result => `state page=${trim(result?.activePage || result?.page, '-')} session=${trim(result?.sessionId, '-')}`,
  },
];

export const registerAppNavigationAgentTools = (registry, deps = {}) => {
  const tools = createAppNavigationAgentTools(deps);
  if (!registry || typeof registry.registerMany !== 'function') return tools;
  registry.registerMany(tools);
  return tools;
};
