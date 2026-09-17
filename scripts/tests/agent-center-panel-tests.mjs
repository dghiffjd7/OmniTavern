import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  AgentCenterPanel,
  formatAgentCenterExportText,
} from '../../src/scripts/ui/agent-center-panel.js';

const agentCenterPanelSource = await readFile(
  new URL('../../src/scripts/ui/agent-center-panel.js', import.meta.url),
  'utf8',
);

{
  const panel = new AgentCenterPanel();
  panel.ensureDom = () => {
    panel.overlayElement = { style: {} };
  };
  panel.refresh = () => {};
  panel.activeTab = 'activity';
  panel.show();
  assert.equal(panel.activeTab, 'activity');
  panel.show({ tab: 'activity', activityStatus: 'failure' });
  assert.equal(panel.activeTab, 'activity');
  assert.equal(panel.activityStatus, 'failure');
  panel.show({ tab: 'agents', agentId: 'reply_check', configure: true, aboveGuide: true });
  assert.equal(panel.activeTab, 'agents');
  assert.equal(panel.floatingAgentId, 'reply_check');
  assert.equal(panel.floatingAgentFlipped, true);
  console.log('ok - agent center panel restores the last tab unless a tab is explicit');
}

{
  const panel = new AgentCenterPanel();
  let refreshCalls = 0;
  panel.refresh = () => {
    refreshCalls += 1;
  };
  panel.overlayElement = { style: { display: 'none' } };
  panel.handleAgentFeatureSettingsChanged();
  panel.overlayElement.style.display = 'flex';
  panel.agentFeatureMutationDepth = 1;
  panel.handleAgentFeatureSettingsChanged({ detail: { id: 'reply_check' } });
  assert.equal(refreshCalls, 0, 'a feature event emitted by the panel mutation must be coalesced with its explicit refresh');
  panel.agentFeatureMutationDepth = 0;
  panel.handleAgentFeatureSettingsChanged();
  assert.equal(refreshCalls, 1);
  assert.match(agentCenterPanelSource, /addEventListener\?\.\('agent-feature-settings-changed', this\.boundAgentFeatureSettingsChanged\)/);
  assert.match(agentCenterPanelSource, /removeEventListener\?\.\('agent-feature-settings-changed', this\.boundAgentFeatureSettingsChanged\)/);
  console.log('ok - visible Agent Center refreshes for feature store broadcasts and owns its listener lifecycle');
}

{
  // feature 变更失败分支必须走 refresh（重取 view）而非用旧 view 直接 render：
  // 抑制窗口内被吞掉的外部事件靠这次 refresh 收敛，否则面板停留在陈旧状态
  assert.match(agentCenterPanelSource, /不能切换 Agent'\);[\s\S]{0,220}?await this\.refresh\(\);/);
  assert.match(agentCenterPanelSource, /不能更新 Agent 模型';[\s\S]{0,160}?await this\.refresh\(\);/);
  assert.match(agentCenterPanelSource, /不能更新 Agent 触发方式';[\s\S]{0,120}?await this\.refresh\(\);/);
  console.log('ok - agent feature mutation failure paths re-collect the view via refresh');
}

{
  const panel = new AgentCenterPanel();
  const pendingViews = [];
  let renderCalls = 0;
  panel.ensureDom = () => {};
  panel.collectView = () => new Promise(resolve => pendingViews.push(resolve));
  panel.render = () => { renderCalls += 1; };

  const first = panel.refresh();
  const second = panel.refresh();
  assert.equal(first, second, 'overlapping refresh requests should share one in-flight task');
  assert.equal(pendingViews.length, 1);
  pendingViews[0]({ version: 'stale', tabs: [] });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(pendingViews.length, 2, 'one trailing collection should absorb changes received in flight');
  assert.equal(renderCalls, 0, 'stale collection must not render before the trailing refresh');
  pendingViews[1]({ version: 'latest', tabs: [] });
  await first;
  assert.equal(panel.view.version, 'latest');
  assert.equal(renderCalls, 1);
  console.log('ok - agent center coalesces refreshes and only renders the latest collected view');
}

{
  const panel = new AgentCenterPanel();
  panel.cardEntryAnimationUntil = Number.POSITIVE_INFINITY;
  const first = panel.renderCardList([{ id: 'a', title: 'A' }]);
  const second = panel.renderCardList([{ id: 'a', title: 'A' }]);
  assert.match(first, /agent-center-agent-list is-entering/);
  assert.doesNotMatch(second, /agent-center-agent-list is-entering/);
  console.log('ok - agent center card entry animation is not replayed by an early refresh');
}

{
  const panel = new AgentCenterPanel({
    getActions: () => ({
      listProviderToolPendingPermissions: () => [
        { id: 'pending-1', status: 'pending', toolName: 'contact_profile.list', createdAt: 2 },
      ],
      listContactProfilePendingUpdates: () => [
        { id: 'profile-pending-1', status: 'pending', contactId: 'chat:bob', createdAt: 3, profile: { contactId: 'chat:bob', displayName: 'Bob' } },
      ],
      listAgentRunView: () => ({
        meta: { total: 1, active: 1, failures: 0 },
        filters: { limit: 50 },
        runs: [{ id: 'run-1', kind: 'memory_update', title: 'Memory update', status: 'running' }],
      }),
      listAgentTools: () => [
        { name: 'contact_profile.list', title: 'Contact list', riskLevel: 'low', permissions: ['storage'] },
      ],
      getAgentFeatureSettings: () => ({
        features: {
          reply_check: { enabled: true },
        },
      }),
      listAgentPermissionRules: () => [{ toolName: 'contact_profile.list' }],
      getProviderToolSessionGate: () => ({ enabled: false, allowedTools: ['contact_profile.list'] }),
      getProviderToolExperimentStatus: () => ({ enabled: false, allowedTools: ['contact_profile.list'] }),
      getProviderContinuationCommitPolicy: () => ({ defaultStrategy: 'preview_only', strategies: ['preview_only', 'append_to_previous_bubble'] }),
      listAgentModelProfiles: () => [
        { id: 'profile-a', name: '轻量检查', provider: 'openrouter', model: 'model-a' },
      ],
    }),
  });
  const view = await panel.collectView();
  assert.equal(view.meta.pending, 2);
  assert.equal(view.meta.activeRuns, 1);
  assert.equal(view.meta.enabledAgents, 4);
  assert.equal(view.meta.promptModules, 3);
  assert.equal(view.meta.diagnosticViews, 2);
  assert.equal(view.meta.tools, 1);
  assert.equal(view.meta.resources, 6);
  assert.equal(view.pending[0].kind, 'contact_profile_update');
  assert.equal(view.agents.find(agent => agent.id === 'reply_check').enabled, true);
  assert.equal(view.agents.find(agent => agent.id === 'image_director').title, '生图 Agent');
  assert.equal(view.agents.find(agent => agent.id === 'summary_agent'), undefined);
  assert.equal(view.agents.find(agent => agent.id === 'memory_manager'), undefined);
  assert.equal(view.agents.find(agent => agent.id === 'phone_format_agent'), undefined);
  assert.equal(view.promptModules.find(agent => agent.id === 'phone_format_agent').title, '手机格式');
  assert.equal(view.diagnosticViews.find(agent => agent.id === 'lineage_agent').title, '血缘图');
  assert.equal(view.agentModelProfiles[0].label, '轻量检查 · openrouter / model-a');
  assert.equal(view.safety.permissionRules.length, 1);
  console.log('ok - agent center panel collects existing agent debug registry actions into a user view');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    agents: [
      {
        id: 'reply_check',
        title: '检查回复格式',
        summary: 'AI 回复后检查私聊、群聊、动态等格式问题，结果显示在消息旁。',
        detail: ['检查私聊、群聊、动态等输出格式。'],
        enabled: false,
        implemented: true,
        supportsModel: true,
        supportsTriggerMode: true,
        modelMode: 'profile',
        modelProfileId: 'profile-a',
        modelLabel: '轻量检查 · openrouter / model-a',
        triggerLabel: '自动触发',
      },
      {
        id: 'text_completion',
        title: '文本补全',
        summary: '为输入和选中文本提供写作补全建议。',
        enabled: false,
        implemented: false,
        supportsModel: true,
        modelLabel: '不调用模型',
      },
    ],
    agentModelProfiles: [
      { id: 'profile-a', label: '轻量检查 · openrouter / model-a' },
    ],
  };
  const html = panel.renderAgents();
  assert.match(html, /检查回复格式/);
  assert.match(html, /AI 回复后检查私聊、群聊、动态等格式问题/);
  assert.match(html, /data-agent-card-open="reply_check"/);
  assert.match(html, /data-agent-feature-action="enable"/);
  assert.match(html, /data-agent-feature-id="reply_check"/);
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="false"/);
  assert.equal((html.match(/role="switch"/g) || []).length, 1);
  assert.doesNotMatch(html, /data-agent-feature-id="text_completion"/);
  assert.doesNotMatch(html, /data-agent-feature-action="disable"/);
  assert.doesNotMatch(html, /data-agent-card-action="disable"/);
  assert.doesNotMatch(html, /data-agent-feature-detail/);
  assert.doesNotMatch(html, /data-agent-feature-model-select="reply_check"/);
  assert.doesNotMatch(html, /data-agent-feature-model-button="reply_check"/);
  assert.doesNotMatch(html, /data-agent-feature-model-manage="reply_check"/);
  assert.doesNotMatch(html, /data-agent-feature-model="reply_check"/);
  assert.doesNotMatch(html, /value="profile:profile-a" selected/);
  assert.doesNotMatch(html, /data-agent-feature-trigger="reply_check"/);
  assert.match(html, /文本补全/);
  assert.match(html, /规划中/);
  panel.openFloatingAgentCard('reply_check');
  panel.floatingAgentFlipped = true;
  const floatingHtml = panel.renderFloatingAgentCard();
  assert.match(floatingHtml, /agent-center-floating-card/);
  assert.match(floatingHtml, /data-agent-feature-model-select="reply_check"/);
  assert.match(floatingHtml, /data-agent-feature-action="enable"/);
  assert.match(floatingHtml, /data-agent-feature-id="reply_check"/);
  assert.match(floatingHtml, /data-agent-feature-trigger="reply_check"/);
  assert.match(floatingHtml, /data-agent-prompt-preview="reply_check"/);
  assert.match(floatingHtml, /data-reply-check-preview-target/);
  assert.match(floatingHtml, /生图标签/);
  assert.match(floatingHtml, /展开请求预览/);
  assert.match(floatingHtml, /提示词区块/);
  assert.match(floatingHtml, /检查提示词/);
  assert.match(floatingHtml, /固定检查指令/);
  assert.match(floatingHtml, /自动触发/);
  assert.match(floatingHtml, /value="profile:profile-a" selected/);
  assert.match(floatingHtml, /agent-center-model-override-label">模型覆盖/);
  assert.match(floatingHtml, /agent-center-agent-badge"><svg/, 'configurable agent uses the shared toolbox icon');
  assert.match(agentCenterPanelSource, /grid-template-columns: 104px minmax\(0, 1fr\)/);
  console.log('ok - agent center panel renders available agent feature cards');
}

{
  const panel = new AgentCenterPanel();
  let renderCalls = 0;
  const classes = new Set(['agent-center-floating-card']);
  const card = {
    classList: {
      toggle: (name, force) => {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
  };
  panel.floatingAgentId = 'reply_check';
  panel.contentElement = {
    querySelector: selector => (selector === '.agent-center-floating-card' ? card : null),
  };
  panel.render = () => {
    renderCalls += 1;
  };
  panel.toggleFloatingAgentCard();
  assert.equal(panel.floatingAgentFlipped, true);
  assert.equal(classes.has('is-flipped'), true);
  assert.equal(renderCalls, 0);
  panel.toggleFloatingAgentCard();
  assert.equal(panel.floatingAgentFlipped, false);
  assert.equal(classes.has('is-flipped'), false);
  assert.equal(renderCalls, 0);
  console.log('ok - floating agent card flips by toggling the existing card class');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    agents: [{
      id: 'reply_check',
      title: '检查回复格式',
      summary: '检查格式问题。',
      enabled: true,
      implemented: true,
    }],
  };
  panel.contentElement = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  panel.openFloatingAgentCard('reply_check');
  assert.match(panel.contentElement.innerHTML, /agent-center-floating-card is-entering/);
  assert.equal(panel.floatingAgentEntryPending, false);
  panel.render();
  assert.doesNotMatch(panel.contentElement.innerHTML, /agent-center-floating-card is-entering/);
  assert.match(
    agentCenterPanelSource,
    /\.agent-center-floating-card\.is-entering\s*\{[^}]*animation:\s*agent-center-floating-in/s,
    '浮层入场动画只应在首次打开时启用',
  );
  const floatingCardBaseRule = agentCenterPanelSource.match(/\.agent-center-floating-card\s*\{[^}]*\}/s)?.[0] || '';
  assert.doesNotMatch(floatingCardBaseRule, /animation:/);
  assert.doesNotMatch(agentCenterPanelSource, /agent-center-floating-refresh|is-refreshing/);
  console.log('ok - floating agent refresh does not replay the entry animation');
}

{
  assert.match(
    agentCenterPanelSource,
    /\.agent-center-setting-row\.is-model\s*>\s*:not\(\.agent-center-setting-label\)\s*\{[^}]*grid-column:\s*2;/s,
    '模型配置的第二行及菜单应与第一组选单共用完整内容列',
  );
  assert.match(
    agentCenterPanelSource,
    /@media\s*\(max-width:\s*680px\)[\s\S]*?\.agent-center-setting-row\s*>\s*\.agent-center-card-action\s*\{[^}]*width:\s*100%;/s,
    '手机版整行按钮规则不应吞到模型输入内部的下拉箭头',
  );
  console.log('ok - floating agent model sub-controls stay in the full-width settings column');
}

{
  const panel = new AgentCenterPanel();
  const html = panel.renderAgentEnabledSetting({
    id: 'reply_check',
    title: '检查回复格式',
    enabled: true,
    implemented: true,
    category: 'core',
  });
  assert.match(html, /agent-center-setting-row is-status/);
  assert.match(
    agentCenterPanelSource,
    /\.agent-center-setting-row\.is-status\s*\{[^}]*grid-template-columns:\s*minmax\(72px, max-content\) minmax\(88px, 1fr\) auto;/s,
  );
  assert.match(
    agentCenterPanelSource,
    /@media\s*\(max-width:\s*680px\)[\s\S]*?\.agent-center-setting-row\.is-status\s*\{[^}]*grid-template-columns:\s*minmax\(56px, max-content\) minmax\(72px, 1fr\) auto;/s,
  );
  assert.match(
    agentCenterPanelSource,
    /\.agent-center-setting-row\.is-status\s+\.agent-center-switch\s*\{[^}]*height:\s*22px;[^}]*min-height:\s*22px;[^}]*padding-block:\s*0;/s,
    '详情页状态行应收紧开关命中盒，不能让 40px 卡面快捷开关撑破 34px 网格行',
  );
  console.log('ok - agent status row preserves separate columns without vertical overflow');
}

{
  assert.match(
    agentCenterPanelSource,
    /\.agent-center-panel\s*\{[^}]*width:\s*clamp\(700px,\s*72vw,\s*1180px\);[^}]*border-radius:\s*24px;/s,
    '桌面 Agent Center 各分页应共用全局提示词页所需的工作窗宽度与圆角',
  );
  assert.doesNotMatch(
    agentCenterPanelSource,
    /\.agent-center-panel\.is-global-prompts\s*\{[^}]*width:/s,
    '切换全局提示词分页不应再改变 Agent Center 外框宽度',
  );
  assert.match(
    agentCenterPanelSource,
    /\.agent-center-agent-list\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[^}]*gap:\s*16px;/s,
    'Agent 卡片网格应保留参考稿的双列留白',
  );
  assert.match(
    agentCenterPanelSource,
    /\.agent-center-agent-list\.is-entering\s+\.agent-center-agent-card\s*\{[^}]*animation:[^;}]*agent-center-card-in[^;}]*backwards;/s,
    '卡片入场动画应只由一次性 entering 状态触发，并使用 backwards 避免持有合成层',
  );
  assert.doesNotMatch(
    agentCenterPanelSource,
    /\.agent-center-floating-inner\s*\{[^}]*rotateY/s,
    '详情与配置切换不应继续使用整卡 3D 翻牌',
  );
  assert.match(
    agentCenterPanelSource,
    /\.agent-center-floating-face-back\s*\{[^}]*opacity:\s*0;[^}]*translateX\(44px\)/s,
    '配置页应从参考稿的右侧 44px 淡入',
  );
  assert.match(
    agentCenterPanelSource,
    /\.agent-center-floating-card\.is-flipped\s+\.agent-center-floating-face-front\s*\{[^}]*opacity:\s*0;[^}]*translateX\(-44px\)/s,
    '详情页切出时应向左淡出',
  );
  assert.match(
    agentCenterPanelSource,
    /\.agent-center-icon-button\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;[^}]*border-radius:\s*999px;/s,
    '卡片右上角切换图标应呈现为参考稿的圆形按钮',
  );
  assert.match(
    agentCenterPanelSource,
    /body\[data-reduced-motion='on'\][\s\S]*\.agent-center-floating-face/s,
    'App 内减速开关应覆盖 Agent Center 的新动画',
  );
  assert.match(
    agentCenterPanelSource,
    /\.agent-center-switch\s*\{[^}]*min-width:\s*44px;[^}]*height:\s*40px;/s,
    '卡面快捷开关的触屏命中区域不应小于 40px',
  );
  assert.match(
    agentCenterPanelSource,
    /AGENT_CARD_INTERACTIVE_SELECTOR[^;]*\[role="switch"\]/,
    '整卡点击应显式豁免卡面快捷开关',
  );
  assert.match(
    agentCenterPanelSource,
    /card\.addEventListener\('keydown',[\s\S]*?if \(event\.target !== card\) return;/,
    '快捷开关的 Enter/Space 不应冒泡触发整卡详情',
  );
  assert.doesNotMatch(
    agentCenterPanelSource,
    /animation:[^;\n]*infinite/,
    'Agent Center 不应迁入持续占用合成器的无限动画',
  );
  assert.match(agentCenterPanelSource, /aria-label="切换到配置"/);
  assert.match(agentCenterPanelSource, /aria-label="切换到详情"/);
  assert.doesNotMatch(
    agentCenterPanelSource,
    /data-action="refresh"/,
    '主窗口头部不应保留无明确反馈的刷新转圈按钮',
  );
  assert.match(agentCenterPanelSource, /data-action="export"/);
  assert.match(agentCenterPanelSource, /data-action="close"/);
  assert.match(agentCenterPanelSource, /data-action="maximize"/);
  assert.match(agentCenterPanelSource, /aria-label="放大 Agent Center"/);
  assert.match(agentCenterPanelSource, /data-agent-float-flip/);
  console.log('ok - agent center redesign keeps the reference layout and performant pane motion contract');
}

{
  const classes = new Set();
  const buttonClasses = new Set();
  const attrs = new Map();
  const button = {
    classList: {
      toggle(name, on) {
        if (on) buttonClasses.add(name);
        else buttonClasses.delete(name);
      },
    },
    setAttribute(name, value) { attrs.set(name, value); },
    title: '',
  };
  const panel = new AgentCenterPanel();
  panel.overlayElement = {
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
    querySelector(selector) {
      return selector === '[data-action="maximize"]' ? button : null;
    },
  };
  panel.setMaximized(true, { persist: false });
  assert.equal(classes.has('is-maximized'), true);
  assert.equal(buttonClasses.has('is-on'), true);
  assert.equal(attrs.get('aria-pressed'), 'true');
  assert.equal(attrs.get('aria-label'), '还原 Agent Center');
  assert.equal(button.title, '还原面板');
  panel.toggleMaximized({ persist: false });
  assert.equal(classes.has('is-maximized'), false);
  assert.equal(attrs.get('aria-pressed'), 'false');
  console.log('ok - agent center desktop maximize control toggles a reversible full-screen state');
}

{
  let opened = 0;
  const panel = new AgentCenterPanel({ getActions:() => ({ showPromptPreview:() => { throw new Error('legacy modal must not open'); } }) });
  panel.floatingPromptPreview = { open:() => { opened++; } };
  await panel.handleAgentPromptPreview('group_agent');
  assert.equal(opened,1);
  console.log('ok - agent prompt preview opens the local workspace without leaving the card');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    promptModules: [{
      id: 'phone_format_agent',
      title: '手机格式',
      summary: '管理手机聊天、动态和结尾格式提示词。',
      detail: ['承接原 preset 中的手机格式提示词。'],
      enabled: true,
      implemented: true,
      category: 'prompt_module',
      promptRefs: [
        { id: 'phone-format-chat', label: 'QQ聊天格式', profileType: 'sysprompt', agentId: 'phone_format_agent' },
      ],
    }],
    agentProfileView: {
      sysprompt: {
        presetId: 'sysp',
        profile: {
          agents: {
            phone_format_agent: {
              prompts: {
                'phone-format-chat': { enabled: true, rules: 'format rules' },
              },
            },
          },
        },
      },
    },
  };
  const html = panel.renderPromptModules();
  assert.match(html, /手机格式/);
  assert.doesNotMatch(html, /QQ聊天格式/);
  assert.doesNotMatch(html, /format rules/);
  panel.openFloatingAgentCard('phone_format_agent');
  const floatingHtml = panel.renderFloatingAgentCard();
  assert.match(floatingHtml, /agent-center-floating-card/);
  assert.match(floatingHtml, /提示词\/协议/);
  assert.match(floatingHtml, /QQ聊天格式/);
  assert.match(floatingHtml, /format rules/);
  assert.match(floatingHtml, /data-agent-float-flip/);
  assert.doesNotMatch(html, /模型：不直接调用模型/);
  console.log('ok - agent center panel renders prompt modules outside Agent cards');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    diagnosticViews: [{
      id: 'execution_lane_agent',
      title: '执行泳道',
      summary: '把创作过程按输入、模型、记忆和生图等泳道展示。',
      detail: ['将运行过程投影为泳道视图。'],
      enabled: true,
      implemented: true,
      category: 'diagnostic',
    }],
  };
  const html = panel.renderDiagnostics();
  assert.match(html, /执行泳道/);
  assert.match(html, /诊断视图/);
  assert.doesNotMatch(html, /data-agent-card-action="disable"/);
  assert.match(html, /data-agent-card-open="execution_lane_agent"/);
  console.log('ok - agent center panel renders diagnostic views without Agent toggle');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    agents: [{
      id: 'image_director',
      title: '生图 Agent',
      summary: '根据对话自动整理生图标签和图片提示词。',
      detail: ['负责判断当前回复是否需要图片表达。'],
      enabled: true,
      implemented: true,
      toggleKind: 'agent_card',
      accent: 'image',
      promptRefs: [
        { id: 'auto-image-prompt', label: '自动标签生图提示词', profileType: 'sysprompt', agentId: 'image_director' },
      ],
      settingRefs: ['自动标签策略'],
      resourceRefs: ['image_templates'],
    }],
    resources: [{ id: 'image_templates', title: '生图模板' }],
    agentProfileView: {
      sysprompt: {
        presetId: 'sysp-a',
        profile: {
          agents: {
            image_director: {
              prompts: {
                'auto-image-prompt': {
                  enabled: true,
                  rules: 'image prompt rules',
                  position: 4,
                  depth: 0,
                  role: 0,
                },
              },
            },
          },
        },
      },
    },
  };
  const html = panel.renderAgents();
  assert.match(html, /生图 Agent/);
  assert.match(html, /data-agent-card-action="disable"/);
  assert.match(html, /data-agent-card-id="image_director"/);
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="true"/);
  assert.doesNotMatch(html, /data-agent-feature-detail/);
  assert.doesNotMatch(html, /data-agent-prompt-save="auto-image-prompt"/);
  panel.openFloatingAgentCard('image_director');
  panel.floatingAgentFlipped = true;
  const floatingHtml = panel.renderFloatingAgentCard();
  assert.match(floatingHtml, /data-agent-prompt-save="auto-image-prompt"/);
  assert.match(floatingHtml, /image prompt rules/);
  assert.match(floatingHtml, /data-agent-resource-open="image_templates"/);
  console.log('ok - agent center panel renders catalog cards with editable prompt refs');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    agents: [{
      id: 'memory_table_agent',
      title: '记忆表格 Agent',
      summary: '管理记忆表格注入、更新和写入预览。',
      detail: ['控制记忆表格数据和 guide 在请求中的位置。'],
      enabled: true,
      implemented: true,
      category: 'memory',
      accent: 'memory',
      resourceRefs: ['memory_center'],
    }],
    resources: [{ id: 'memory_center', title: '记忆' }],
    memoryAgentPromptConfig: {
      templateId: 'default-v1',
      templateName: '通用记忆模板',
      template: '记忆内容：{{tableData}}',
      wrapper: '<memories>\n{{tableData}}\n</memories>',
      position: 'history_depth',
    },
    agentProfileView: {
      openai: {
        presetId: 'openai-a',
        profile: {
          agents: {
            memory_table_agent: {
              settings: {
                dataPosition: 'before_latest_user',
                dataDepth: 2,
                guidePosition: 'after_latest_user',
                guideDepth: 1,
              },
            },
          },
        },
      },
    },
  };
  const html = panel.renderAgents();
  assert.match(html, /data-memory-mode-badge="table"/);
  assert.match(html, /记忆：表格/);
  assert.doesNotMatch(html, /data-agent-card-id="memory_table_agent"/);
  assert.doesNotMatch(html, /data-agent-feature-id="memory_table_agent"/);
  panel.openFloatingAgentCard('memory_table_agent');
  panel.floatingAgentFlipped = true;
  const floatingHtml = panel.renderFloatingAgentCard();
  assert.match(floatingHtml, /记忆提示词与注入/);
  assert.match(floatingHtml, /记忆数据提示词位置/);
  assert.match(floatingHtml, /写表指导提示词位置/);
  assert.match(floatingHtml, /表格内容模板/);
  assert.match(floatingHtml, /记忆内容：{{tableData}}/);
  assert.match(floatingHtml, /&lt;memories&gt;/);
  assert.match(floatingHtml, /data-memory-prompt-position/);
  assert.match(floatingHtml, /value="history_depth" selected/);
  assert.match(floatingHtml, /data-memory-storage-mode="off"/);
  assert.match(floatingHtml, /data-memory-storage-mode="summary"/);
  assert.match(floatingHtml, /data-memory-storage-mode="table"/);
  assert.match(floatingHtml, /记忆存储模式/);
  assert.match(floatingHtml, /data-agent-resource-open="memory_center"/);
  console.log('ok - memory table agent back renders editable prompt template settings');
}

{
  let modelPayload = null;
  const panel = new AgentCenterPanel({
    getActions: () => ({
      setAgentFeatureModel: payload => {
        modelPayload = payload;
        return { ok: true };
      },
    }),
  });
  panel.view = {
    agents: [{
      id: 'reply_check',
      title: '检查回复格式',
      enabled: true,
      implemented: true,
      supportsModel: true,
      modelMode: 'none',
    }],
  };
  panel.refresh = async () => {};
  await panel.handleAgentFeatureModelSelect('reply_check', 'profile:profile-a');
  assert.deepEqual(modelPayload, {
    id: 'reply_check',
    modelMode: 'profile',
    modelProfileId: 'profile-a',
    modelOverride: '',
  });
  console.log('ok - agent center agent model selector updates feature model');
}

{
  let triggerPayload = null;
  let triggerChoice = null;
  const panel = new AgentCenterPanel({
    choice: async (options) => {
      triggerChoice = options;
      return 'manual';
    },
    getActions: () => ({
      setAgentFeatureTriggerMode: payload => {
        triggerPayload = payload;
        return { ok: true };
      },
    }),
  });
  panel.view = {
    agents: [{
      id: 'reply_check',
      title: '检查回复格式',
      enabled: true,
      implemented: true,
      supportsTriggerMode: true,
      triggerMode: 'auto',
    }],
  };
  panel.refresh = async () => {};
  await panel.handleAgentFeatureTriggerMode('reply_check');
  assert.deepEqual(triggerChoice.actions.map(action => action.id), ['auto', 'manual']);
  assert.deepEqual(triggerPayload, {
    id: 'reply_check',
    triggerMode: 'manual',
  });
  console.log('ok - agent center agent trigger selector updates feature trigger mode');
}

{
  let updatePayload = null;
  let guideChoice = null;
  let openedConfig = null;
  let confirmCalls = 0;
  const panel = new AgentCenterPanel({
    confirm: async () => {
      confirmCalls += 1;
      return true;
    },
    choice: async (options) => {
      guideChoice = options;
      return 'manage_api';
    },
    openConfig: (options = {}) => {
      openedConfig = options;
    },
    getActions: () => ({
      setAgentFeatureEnabled: payload => {
        updatePayload = payload;
        return { ok: true };
      },
    }),
  });
  panel.view = {
    agents: [{
      id: 'reply_check',
      title: '检查回复格式',
      summary: 'AI 回复后检查格式问题。',
      enabled: false,
      implemented: true,
      supportsModel: true,
      modelMode: 'none',
    }],
  };
  panel.refresh = async () => {};
  await panel.handleAgentFeatureToggle('enable', 'reply_check');
  assert.deepEqual(updatePayload, {
    id: 'reply_check',
    enabled: true,
    reason: 'agent center feature toggle',
  });
  assert.equal(confirmCalls, 0);
  assert.equal(guideChoice.title, '配置检查模型');
  assert.deepEqual(guideChoice.actions.map(action => action.id), ['select_model', 'manage_api', 'keep_local']);
  assert.equal(openedConfig.tab, 'chat');
  console.log('ok - agent center prompts model configuration when enabling reply check with no model');
}

{
  let refreshCalls = 0;
  let panel = null;
  panel = new AgentCenterPanel({
    getActions: () => ({
      setAgentFeatureEnabled: () => {
        panel.handleAgentFeatureSettingsChanged({ detail: { id: 'reply_check' } });
        return { ok: true };
      },
    }),
  });
  panel.overlayElement = { style: { display: 'flex' } };
  panel.view = {
    agents: [{
      id: 'reply_check',
      title: '检查回复格式',
      enabled: false,
      implemented: true,
      supportsModel: false,
      modelMode: 'follow_current',
    }],
  };
  panel.refresh = async () => { refreshCalls += 1; };
  await panel.handleAgentFeatureToggle('enable', 'reply_check');
  assert.equal(refreshCalls, 1, 'self broadcast and handler tail should result in one refresh');
  console.log('ok - agent feature auto-save suppresses its own broadcast refresh');
}

{
  let clicked = 0;
  let focused = 0;
  let rendered = 0;
  const modelButton = {
    dataset: { agentFeatureModelButton: 'reply_check' },
    disabled: false,
    focus() { focused += 1; },
    click() { clicked += 1; },
  };
  const panel = new AgentCenterPanel({
    choice: async () => 'select_model',
    getActions: () => ({
      setAgentFeatureEnabled: () => ({ ok: true }),
    }),
  });
  panel.view = {
    agents: [{
      id: 'reply_check',
      title: '检查回复格式',
      enabled: false,
      implemented: true,
      supportsModel: true,
      modelMode: 'none',
    }],
  };
  panel.contentElement = {
    querySelector: () => null,
    querySelectorAll(selector) {
      if (
        selector === '[data-agent-feature-model-button]'
        && panel.floatingAgentId === 'reply_check'
        && panel.floatingAgentFlipped === true
      ) return [modelButton];
      return [];
    },
  };
  panel.render = () => { rendered += 1; };
  panel.refresh = async () => {};

  await panel.handleAgentFeatureToggle('enable', 'reply_check');
  assert.equal(panel.floatingAgentId, 'reply_check');
  assert.equal(panel.floatingAgentFlipped, true);
  assert.equal(rendered, 1);
  assert.equal(focused, 1);
  assert.equal(clicked, 1);
  console.log('ok - selecting a model after enabling reply check opens its configuration face before activating the picker');
}

{
  let refreshed = 0;
  const panel = new AgentCenterPanel();
  panel.activeTab = 'agents';
  panel.overlayElement = { style: { display: 'flex' } };
  panel.refresh = async () => {
    refreshed += 1;
  };
  await panel.handleConfigProfileChanged({ detail: { tab: 'chat' } });
  assert.equal(refreshed, 1);
  await panel.handleConfigProfileChanged({ detail: { tab: 'image' } });
  assert.equal(refreshed, 1);
  panel.overlayElement.style.display = 'none';
  await panel.handleConfigProfileChanged({ detail: { tab: 'chat' } });
  assert.equal(refreshed, 1);
  console.log('ok - agent center refreshes model profiles when visible chat API config changes');
}

{
  let updatePayload = null;
  let gatePayload = null;
  let confirmOptions = null;
  const panel = new AgentCenterPanel({
    confirm: async (options) => {
      confirmOptions = options;
      return true;
    },
    getActions: () => ({
      setAgentFeatureEnabled: payload => {
        updatePayload = payload;
        return { ok: true };
      },
      setProviderToolSessionGate: payload => {
        gatePayload = payload;
        return { ok: true };
      },
    }),
  });
  panel.view = {
    agents: [{
      id: 'write_preview',
      title: '预览记忆和变量变更',
      summary: 'AI 请求修改记忆、变量或世界书时，先显示可撤销预览。',
      enabled: false,
      implemented: true,
    }],
    safety: {
      sessionGate: {
        enabled: false,
        allowedTools: ['contact_profile.list'],
      },
    },
  };
  panel.refresh = async () => {};
  await panel.handleAgentFeatureToggle('enable', 'write_preview');
  assert.deepEqual(updatePayload, {
    id: 'write_preview',
    enabled: true,
    reason: 'agent center feature toggle',
  });
  assert.match(confirmOptions.message, /当前会话/);
  assert.equal(confirmOptions.confirmText, '开启');
  assert.equal(gatePayload, null);
  assert.doesNotMatch(agentCenterPanelSource, /setWritePreviewModelContextEnabled/);
  console.log('ok - agent center delegates write preview gate side effects to the registry action layer');
}

{
  let resolveToggle = null;
  const notices = [];
  const attributes = new Map([['aria-checked', 'false']]);
  const button = {
    dataset: {
      agentCardAction: 'enable',
      agentCardId: 'image_director',
    },
    classList: { toggle() {} },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
  const panel = new AgentCenterPanel({
    notifyError: message => notices.push(message),
    getActions: () => ({
      setAgentCardEnabled: () => new Promise(resolve => {
        resolveToggle = resolve;
      }),
    }),
  });
  panel.view = {
    agents: [{
      id: 'image_director',
      title: '生图 Agent',
      enabled: false,
      implemented: true,
    }],
  };
  panel.render = () => {};
  panel.refresh = async () => {};
  const pending = panel.handleAgentCardToggle('enable', 'image_director', button);
  assert.equal(attributes.get('aria-checked'), 'true');
  assert.equal(button.dataset.agentCardAction, 'disable');
  resolveToggle({ ok: false, reason: 'save_failed' });
  await pending;
  assert.equal(attributes.get('aria-checked'), 'false');
  assert.equal(button.dataset.agentCardAction, 'enable');
  assert.match(notices[0], /切换失败/);
  console.log('ok - agent card quick toggle updates immediately and rolls back on failure');
}

{
  const panel = new AgentCenterPanel();
  panel.view = { pending: [] };
  const html = panel.renderPending();
  assert.match(html, /没有待确认请求/);
  assert.match(html, /AI 请求工具、画像保存或变更提交前/);
  console.log('ok - agent center pending empty state explains when requests appear');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    pending: [
      {
        kind: 'contact_profile_update',
        id: 'profile-pending-1',
        status: 'pending',
        toolName: '联系人画像更新',
        sessionId: 'chat:bob',
        source: 'contact-profiler-agent',
        contactId: 'chat:bob',
        riskLevel: 'medium',
        permissions: ['storage:write'],
        profileSummary: 'Bob · 特征 1',
      },
    ],
  };
  const html = panel.renderPending();
  assert.match(html, /保存画像/);
  assert.match(html, /data-profile-action="approve"/);
  assert.match(html, /忽略只清除本次候选/);
  console.log('ok - agent center panel renders contact profile pending update actions');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    pending: [
      {
        kind: 'tool_permission',
        id: 'provider-pending-1',
        status: 'pending',
        toolName: 'contact_profile.list',
        sessionId: 'chat:bob',
        source: 'provider-tool-permission',
        riskLevel: 'low',
        permissions: ['storage'],
        resumeStatus: 'idle',
        continuationStatus: 'idle',
      },
    ],
  };
  const html = panel.renderPending();
  assert.match(html, /执行一次/);
  assert.match(html, /data-provider-permission-action="allow_once"/);
  assert.match(html, /data-provider-permission-action="deny"/);
  assert.match(html, /data-provider-permission-action="remember_allow"/);
  assert.match(html, /不会重放聊天、不会自动继续生成、不会直接写聊天正文/);
  console.log('ok - agent center panel renders provider tool pending permission actions');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    pending: [
      {
        kind: 'tool_permission',
        id: 'worldbook-preview-pending-1',
        status: 'allowed',
        toolName: 'worldbook.preview_actions',
        sessionId: 'contact:firen',
        source: 'provider-tool-permission',
        riskLevel: 'low',
        permissions: ['worldbook.read'],
        resumeStatus: 'succeeded',
        continuationStatus: 'idle',
        writePreview: {
          kind: '世界书写入预览',
          targetLabel: '世界书',
          target: 'world:firen',
          requestSummary: '1 action',
          previewReady: true,
          resultSummary: '变更 1 · 跳过 0 · updated 1',
          rollbackReady: true,
          entries: ['update · e1 · 字段：content'],
          entryOverflow: 0,
        },
      },
    ],
  };
  const html = panel.renderPending();
  assert.match(html, /写入预览：世界书写入预览/);
  assert.match(html, /世界书：world:firen/);
  assert.match(html, /预览结果：变更 1 · 跳过 0 · updated 1/);
  assert.match(html, /撤销记录：已准备好/);
  assert.match(html, /不会写入记忆、变量、世界书或聊天正文/);
  assert.doesNotMatch(html, /提交候选/);
  assert.doesNotMatch(html, /提交变更/);
  console.log('ok - agent center panel renders write preview tool diffs before commit action is ready');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    pending: [
      {
        kind: 'tool_permission',
        id: 'chat-emit-pending-1',
        status: 'pending',
        toolName: 'chat.emit_private',
        sessionId: 'contact:firen',
        source: 'provider-tool-permission',
        riskLevel: 'low',
        permissions: ['chat:emit_candidate'],
        resumeStatus: 'idle',
        continuationStatus: 'idle',
        chatEmitPreview: {
          kind: '私聊候选',
          target: '菲伦',
          speaker: '菲伦',
          time: '22:12',
          contentPreview: '今晚别一个人走。',
        },
        chatEmitCommitPreview: {
          effect: '新增 1 条私聊消息到「菲伦」',
          undoSummary: '提交后撤销应删除该新增私聊消息或回滚提交快照',
        },
      },
    ],
  };
  const html = panel.renderPending();
  assert.match(html, /候选预览：私聊候选/);
  assert.match(html, /目标：菲伦/);
  assert.match(html, /说话人：菲伦/);
  assert.match(html, /今晚别一个人走。/);
  assert.match(html, /后续提交预览：新增 1 条私聊消息到「菲伦」/);
  assert.match(html, /撤销边界：提交后撤销应删除该新增私聊消息或回滚提交快照/);
  assert.match(html, /不会直接写聊天正文/);
  assert.doesNotMatch(html, /提交候选/);
  console.log('ok - agent center panel renders chat emit pending previews before approval');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    pending: [
      {
        kind: 'tool_permission',
        id: 'chat-emit-pending-2',
        status: 'allowed',
        toolName: 'chat.emit_private',
        sessionId: 'contact:firen',
        source: 'provider-tool-permission',
        riskLevel: 'low',
        permissions: ['chat:emit_candidate'],
        resumeStatus: 'succeeded',
        continuationStatus: 'ready',
        chatEmitPreview: {
          kind: '私聊候选',
          target: '菲伦',
          speaker: '菲伦',
          contentPreview: '今晚别一个人走。',
        },
        chatEmitCommitPreview: {
          effect: '新增 1 条私聊消息到「菲伦」',
          undoSummary: '提交后撤销应删除该新增私聊消息或回滚提交快照',
        },
        chatEmitCommit: {
          status: 'idle',
          undoStatus: 'idle',
          canCommit: true,
          canUndo: false,
        },
      },
    ],
  };
  const html = panel.renderPending();
  assert.match(html, /data-chat-emit-commit-action="commit"/);
  assert.match(html, /data-chat-emit-commit-action="reject"/);
  assert.match(html, /执行/);
  assert.match(html, /打回/);
  assert.doesNotMatch(html, /data-chat-emit-commit-action="undo"/);
  console.log('ok - agent center panel renders explicit chat emit commit action after tool resume');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    pending: [
      {
        kind: 'tool_permission',
        id: 'chat-emit-pending-3',
        status: 'allowed',
        toolName: 'chat.emit_private',
        sessionId: 'contact:firen',
        source: 'provider-tool-permission',
        riskLevel: 'low',
        permissions: ['chat:emit_candidate'],
        resumeStatus: 'succeeded',
        continuationStatus: 'ready',
        chatEmitPreview: {
          kind: '私聊候选',
          target: '菲伦',
          speaker: '菲伦',
          contentPreview: '今晚别一个人走。',
        },
        chatEmitCommitPreview: {
          effect: '新增 1 条私聊消息到「菲伦」',
          undoSummary: '提交后撤销应删除该新增私聊消息或回滚提交快照',
        },
        chatEmitCommit: {
          status: 'committed',
          undoStatus: 'idle',
          canCommit: false,
          canUndo: true,
          resultSummary: '消息 1',
          message: '已提交 1 条消息。',
        },
      },
    ],
  };
  const html = panel.renderPending();
  assert.match(html, /提交：已提交/);
  assert.match(html, /提交结果：消息 1/);
  assert.match(html, /提交说明：已提交 1 条消息。/);
  assert.match(html, /data-chat-emit-commit-action="undo"/);
  assert.match(html, /撤销提交/);
  console.log('ok - agent center panel renders explicit chat emit undo action after commit');
}

{
  let confirmOptions = null;
  let resolverOptions = null;
  let refreshed = false;
  const panel = new AgentCenterPanel({
    confirm: async options => {
      confirmOptions = options;
      return true;
    },
    getActions: () => ({
      resolveProviderToolPendingPermission: options => {
        resolverOptions = options;
        return { pending: { status: 'allowed' }, resume: { status: 'succeeded' } };
      },
    }),
  });
  panel.view = {
    pending: [
      {
        kind: 'tool_permission',
        id: 'provider-pending-1',
        status: 'pending',
        toolName: 'contact_profile.list',
      },
    ],
  };
  panel.refresh = async () => {
    refreshed = true;
  };
  await panel.handleProviderPermissionAction('allow_once', 'provider-pending-1');
  assert.equal(confirmOptions.confirmText, '执行一次');
  assert.equal(resolverOptions.id, 'provider-pending-1');
  assert.equal(resolverOptions.action, 'allow_once');
  assert.equal(resolverOptions.reason, 'agent center pending action');
  assert.equal(refreshed, true);
  console.log('ok - agent center provider permission action resolves through debug registry contract');
}

{
  let confirmOptions = null;
  let resolverOptions = null;
  const panel = new AgentCenterPanel({
    confirm: async options => {
      confirmOptions = options;
      return true;
    },
    getActions: () => ({
      resolveProviderToolPendingPermission: options => {
        resolverOptions = options;
        return { pending: { status: 'allowed' }, resume: { status: 'succeeded' } };
      },
    }),
  });
  panel.view = {
    pending: [
      {
        kind: 'tool_permission',
        id: 'memory-preview-pending-1',
        status: 'pending',
        toolName: 'memory.preview_actions',
        writePreview: {
          kind: '记忆表写入预览',
          targetLabel: '会话',
          target: 'chat:firen',
          requestSummary: '2 actions',
        },
      },
    ],
  };
  panel.refresh = async () => {};
  await panel.handleProviderPermissionAction('allow_once', 'memory-preview-pending-1');
  assert.match(confirmOptions.message, /变更预览/);
  assert.match(confirmOptions.message, /不会写入记忆、变量、世界书或聊天正文/);
  assert.equal(resolverOptions.id, 'memory-preview-pending-1');
  assert.equal(resolverOptions.action, 'allow_once');
  console.log('ok - agent center provider permission action describes write preview safety');
}

{
  let confirmOptions = null;
  let actionOptions = null;
  let refreshed = false;
  const panel = new AgentCenterPanel({
    confirm: async options => {
      confirmOptions = options;
      return true;
    },
    getActions: () => ({
      commitChatEmitPendingPermission: options => {
        actionOptions = options;
        return { ok: true, status: 'committed' };
      },
    }),
  });
  panel.view = {
    pending: [
      {
        kind: 'tool_permission',
        id: 'chat-emit-pending-2',
        toolName: 'chat.emit_private',
      },
    ],
  };
  panel.refresh = async () => {
    refreshed = true;
  };
  await panel.handleChatEmitCommitAction('commit', 'chat-emit-pending-2');
  assert.equal(confirmOptions.confirmText, '执行');
  assert.equal(actionOptions.id, 'chat-emit-pending-2');
  assert.equal(actionOptions.confirmed, true);
  assert.equal(refreshed, true);
  console.log('ok - agent center chat emit commit action requires confirmation and calls debug registry');
}

{
  let confirmOptions = null;
  let actionOptions = null;
  let refreshed = false;
  const panel = new AgentCenterPanel({
    confirm: async options => {
      confirmOptions = options;
      return true;
    },
    getActions: () => ({
      rejectChatEmitPendingCommit: options => {
        actionOptions = options;
        return { ok: true, status: 'skipped' };
      },
    }),
  });
  panel.view = {
    pending: [
      {
        kind: 'tool_permission',
        id: 'chat-emit-pending-reject',
        toolName: 'chat.emit_private',
      },
    ],
  };
  panel.refresh = async () => {
    refreshed = true;
  };
  await panel.handleChatEmitCommitAction('reject', 'chat-emit-pending-reject');
  assert.equal(confirmOptions.confirmText, '打回');
  assert.match(confirmOptions.message, /不会写入聊天或动态/);
  assert.equal(actionOptions.id, 'chat-emit-pending-reject');
  assert.equal(actionOptions.confirmed, true);
  assert.equal(refreshed, true);
  console.log('ok - agent center chat emit reject action marks candidates as handled');
}

{
  const panel = new AgentCenterPanel({
    confirm: async () => true,
    getActions: () => ({
      commitChatEmitPendingPermission: () => ({
        ok: false,
        status: 'blocked',
        reason: 'target_session_not_found',
        message: '找不到候选目标会话，请检查目标名称或 ID 后重试。',
      }),
    }),
  });
  panel.view = {
    pending: [
      {
        kind: 'tool_permission',
        id: 'chat-emit-pending-blocked',
        toolName: 'chat.emit_private',
      },
    ],
  };
  panel.refresh = async () => {};
  await panel.handleChatEmitCommitAction('commit', 'chat-emit-pending-blocked');
  assert.equal(panel.lastError, '找不到候选目标会话，请检查目标名称或 ID 后重试。');
  console.log('ok - agent center chat emit commit action surfaces readable failure messages');
}

{
  let confirmOptions = null;
  let actionOptions = null;
  let refreshed = false;
  const panel = new AgentCenterPanel({
    confirm: async options => {
      confirmOptions = options;
      return true;
    },
    getActions: () => ({
      commitAgentWritePreviewPendingPermission: options => {
        actionOptions = options;
        return { ok: true, status: 'committed' };
      },
    }),
  });
  panel.view = {
    pending: [
      {
        kind: 'tool_permission',
        id: 'variable-preview-pending-1',
        toolName: 'variable.preview_commands',
      },
    ],
  };
  panel.refresh = async () => {
    refreshed = true;
  };
  await panel.handleWritePreviewCommitAction('commit', 'variable-preview-pending-1');
  assert.equal(confirmOptions.confirmText, '执行');
  assert.match(confirmOptions.message, /会写入记忆、变量或世界书/);
  assert.equal(actionOptions.id, 'variable-preview-pending-1');
  assert.equal(actionOptions.confirmed, true);
  assert.equal(refreshed, true);
  console.log('ok - agent center write preview commit action requires confirmation and calls debug registry');
}

{
  let confirmOptions = null;
  let actionOptions = null;
  let refreshed = false;
  const panel = new AgentCenterPanel({
    confirm: async options => {
      confirmOptions = options;
      return true;
    },
    getActions: () => ({
      rejectAgentWritePreviewPendingCommit: options => {
        actionOptions = options;
        return { ok: true, status: 'skipped' };
      },
    }),
  });
  panel.view = {
    pending: [
      {
        kind: 'tool_permission',
        id: 'variable-preview-pending-reject',
        toolName: 'variable.preview_commands',
      },
    ],
  };
  panel.refresh = async () => {
    refreshed = true;
  };
  await panel.handleWritePreviewCommitAction('reject', 'variable-preview-pending-reject');
  assert.equal(confirmOptions.confirmText, '打回');
  assert.match(confirmOptions.message, /不会写入记忆、变量或世界书/);
  assert.equal(actionOptions.id, 'variable-preview-pending-reject');
  assert.equal(actionOptions.confirmed, true);
  assert.equal(refreshed, true);
  console.log('ok - agent center write preview reject action marks candidates as handled');
}

{
  const panel = new AgentCenterPanel({
    confirm: async () => true,
    getActions: () => ({
      commitAgentWritePreviewPendingPermission: () => ({
        ok: false,
        status: 'blocked',
        reason: 'preview_result_missing',
        message: '找不到已生成的变更预览，请先允许一次执行预览。',
      }),
    }),
  });
  panel.view = {
    pending: [
      {
        kind: 'tool_permission',
        id: 'variable-preview-pending-blocked',
        toolName: 'variable.preview_commands',
      },
    ],
  };
  panel.refresh = async () => {};
  await panel.handleWritePreviewCommitAction('commit', 'variable-preview-pending-blocked');
  assert.equal(panel.lastError, '找不到已生成的变更预览，请先允许一次执行预览。');
  console.log('ok - agent center write preview commit action surfaces readable failure messages');
}

{
  let listOptions = null;
  const panel = new AgentCenterPanel({
    getFailureSeenAt: () => 900,
    getActions: () => ({
      listAgentRunView: options => {
        listOptions = options;
        return {
          meta: { total: 2, active: 0, failures: 1 },
          filters: options,
          runs: [{ id: 'run-failed', kind: 'image_generation', status: 'failed', errorMessage: 'provider unavailable' }],
        };
      },
    }),
  });
  panel.activityStatus = 'failure';
  const view = await panel.collectView();
  assert.equal(listOptions.status, 'failure');
  assert.equal(listOptions.failureSeenAt, 900);
  assert.equal(view.activity.runs[0].id, 'run-failed');
  console.log('ok - agent center panel requests filtered failed activity when opened from failure chip');
}

{
  let marked = null;
  const panel = new AgentCenterPanel({
    markFailureSeen: options => {
      marked = options;
    },
    getActions: () => ({
      listAgentRunView: () => ({
        meta: {
          total: 1,
          active: 0,
          failures: 1,
          unreadFailures: 1,
          newestFailureAt: 2000,
        },
        filters: { status: 'failure' },
        runs: [{ id: 'run-failed', kind: 'image_generation', status: 'failed', updatedAt: 2000 }],
      }),
    }),
  });
  panel.ensureDom = () => {};
  panel.render = () => {};
  panel.activeTab = 'activity';
  panel.activityStatus = 'failure';
  await panel.refresh();
  assert.equal(marked.surface, '');
  assert.equal(marked.at >= 2000, true);
  assert.equal(panel.view.meta.unreadFailedRuns, 0);
  console.log('ok - agent center panel marks failures as read after opening failure activity');
}

{
  let listOptions = null;
  const panel = new AgentCenterPanel({
    getActions: () => ({
      listAgentRunView: options => {
        listOptions = options;
        return {
          meta: { total: 3, active: 1, failures: 1, scoped: 1, scopedActive: 1, scopedFailures: 0 },
          filters: options,
          runs: [{ id: 'run-moment', kind: 'moment_summary', status: 'running', surface: 'moments' }],
        };
      },
    }),
  });
  panel.surface = 'moments';
  const view = await panel.collectView();
  assert.equal(listOptions.surface, 'moments');
  assert.equal(view.meta.activeRuns, 1);
  assert.equal(view.meta.failedRuns, 0);
  assert.equal(view.activity.runs[0].surface, 'moments');
  console.log('ok - agent center panel can collect surface scoped activity');
}

{
  const panel = new AgentCenterPanel();
  panel.activityStatus = 'failure';
  panel.view = {
    activity: {
      meta: { total: 2, active: 0, failures: 1, statusCounts: { succeeded: 1, failed: 1 } },
      runs: [
        {
          id: 'run-failed',
          kind: 'image_generation',
          title: 'Image generation',
          status: 'failed',
          summary: 'generation failed',
          errorMessage: 'provider unavailable',
          lastStep: { type: 'image.generate', status: 'failed', errorMessage: 'provider unavailable' },
        },
      ],
    },
  };
  const html = panel.renderActivity();
  assert.match(html, /data-activity-status="failure"/);
  assert.match(html, /is-danger/);
  assert.match(html, /查看后会从顶部提醒移除，不会删除活动记录/);
  assert.match(html, /data-failure-read-action="mark"/);
  assert.match(html, /错误：<span data-i18n-skip>provider unavailable<\/span>/);
  assert.match(html, /agent-center-card is-failure/);
  console.log('ok - agent center panel renders failed activity filter and error detail');
}

{
  let marked = null;
  const panel = new AgentCenterPanel({
    markFailureSeen: options => {
      marked = options;
    },
  });
  panel.surface = 'moments';
  panel.view = {
    meta: { unreadFailedRuns: 1, newestFailureAt: 5000 },
    activity: {
      meta: { unreadFailures: 1, scopedUnreadFailures: 1, scopedNewestFailureAt: 5000 },
      runs: [],
    },
  };
  panel.render = () => {};
  panel.handleFailureReadAction();
  assert.equal(marked.surface, 'moments');
  assert.equal(marked.at >= 5000, true);
  assert.equal(panel.view.meta.unreadFailedRuns, 0);
  assert.equal(panel.view.activity.meta.unreadFailures, 0);
  assert.equal(panel.view.activity.meta.scopedUnreadFailures, 0);
  console.log('ok - agent center failure read action removes failures from top reminder without deleting activity');
}

{
  let actionPayload = null;
  let confirmOptions = null;
  let refreshed = false;
  const panel = new AgentCenterPanel({
    confirm: async options => {
      confirmOptions = options;
      return true;
    },
    getActions: () => ({
      resolveAgentRunReview: payload => {
        actionPayload = payload;
        return { ok: true, status: 'cancelled' };
      },
    }),
  });
  panel.view = {
    activity: {
      runs: [{
        id: 'run-format-review',
        kind: 'chat_format_guardian',
        title: '聊天格式待确认',
        status: 'waiting_permission',
      }],
    },
  };
  panel.refresh = async () => {
    refreshed = true;
  };
  await panel.handleAgentRunReviewAction('reject', 'run-format-review');
  assert.equal(confirmOptions.confirmText, '打回');
  assert.equal(actionPayload.runId, 'run-format-review');
  assert.equal(actionPayload.decision, 'reject');
  assert.equal(refreshed, true);
  console.log('ok - agent center activity can reject waiting agent runs');
}

{
  let applyPayload = null;
  let refreshed = false;
  let successMessage = '';
  const panel = new AgentCenterPanel({
    getActions: () => ({
      applyAgentFormatRepairRun: payload => {
        applyPayload = payload;
        return { ok: true, applied: true };
      },
    }),
    notifySuccess: message => {
      successMessage = message;
    },
  });
  panel.refresh = async () => {
    refreshed = true;
  };
  await panel.handleAgentRunReviewAction('apply', 'run-rejected-format');
  assert.deepEqual(applyPayload, { runId: 'run-rejected-format' });
  assert.equal(successMessage, '格式修复已应用');
  assert.equal(refreshed, true);
  console.log('ok - agent center can apply an in-memory rejected-reply format candidate');
}

{
  const panel = new AgentCenterPanel();
  panel.activeTab = 'activity';
  panel.view = {
    activity: {
      meta: { total: 1, active: 1, failures: 0, statusCounts: { waiting_permission: 1 } },
      runs: [
        {
          id: 'run-format',
          kind: 'chat_format_guardian',
          title: '聊天格式待确认',
          status: 'waiting_permission',
          summary: '1 event draft · 0 errors · 1 warning',
          review: {
            sourceTextKind: 'rawOriginal',
            hasRawOriginal: true,
            eventCount: 1,
            errors: [],
            warnings: ['time is missing'],
            repairCandidate: {
              available: true,
              title: '补齐时间',
              summary: '补齐 1 条缺失时间',
            },
            autoRepair: {
              autoApplyRepair: true,
              attempted: true,
              didAnything: false,
              reason: 'no_events',
              eventCount: 0,
            },
            modelReviewDetail: {
              status: 'needs_repair',
              canRepair: true,
              repairSummary: '补齐结束标签。',
              rawPreview: '{"status":"needs_repair"...',
              rawText: '{"status":"needs_repair","correctedText":"完整模型返回"}',
              correctedText: 'MiPhone_start\nmsg_start\n<{{user}}和好友乙的私聊>\n</{{user}}和好友乙的私聊>',
              linePatches: [{
                startLine: 3,
                endLine: 3,
                reason: '补闭合标签',
                originalLines: ['<{{user}}和好友乙的私聊>'],
                replacementLines: ['<{{user}}和好友乙的私聊>', '</{{user}}和好友乙的私聊>'],
              }],
            },
            actionLabels: ['应用修复', '重试生成', '查看原文'],
          },
        },
      ],
    },
  };
  const html = panel.renderActivity();
  assert.match(html, /data-activity-status="waiting_permission"/);
  assert.match(html, /格式检查：发现 1 条提醒/);
  assert.match(html, /检查原始回复/);
  assert.match(html, /提醒：time is missing/);
  assert.match(html, /修复候选：补齐时间/);
  assert.match(html, /自动应用：自动应用开启 · 已尝试 · 未写入聊天 · no_events/);
  assert.match(html, /可在消息旁处理：应用修复、重试生成、查看原文/);
  assert.match(html, /模型修复返回/);
  assert.match(html, /修复后文本/);
  assert.match(html, /模型原始返回预览/);
  assert.match(html, /点击查看完整/);
  assert.match(html, /完整模型返回/);
  assert.match(html, /补闭合标签/);
  assert.doesNotMatch(html, /replacementText/);
  assert.match(html, /data-agent-run-review-action="reject"/);
  assert.match(html, /打回/);
  console.log('ok - agent center panel renders chat format review details without write actions');
}

{
  const panel = new AgentCenterPanel({
    getActions: () => ({
      hasAgentFormatRepairCandidate: ({ runId }) => runId === 'run-rejected-format',
    }),
  });
  panel.activeTab = 'activity';
  panel.view = {
    activity: {
      meta: { total: 1, active: 1, failures: 0, statusCounts: { waiting_permission: 1 } },
      runs: [{
        id: 'run-rejected-format',
        kind: 'chat_format_guardian',
        title: '聊天格式待确认',
        status: 'waiting_permission',
        review: {
          protocolParseFailure: true,
          modelReviewDetail: { canRepair: true },
        },
      }],
    },
  };
  const html = panel.renderActivity();
  assert.match(html, /data-agent-run-review-action="apply"/);
  assert.match(html, />应用修复<\/button>/);
  assert.match(html, /data-agent-run-review-action="reject"/);
  console.log('ok - agent center exposes apply only for rejected-reply format candidates');
}

{
  const panel = new AgentCenterPanel({
    getActions: () => ({
      hasAgentFormatRepairCandidate: () => false,
    }),
  });
  panel.activeTab = 'activity';
  panel.view = {
    activity: {
      meta: { total: 1, active: 1, failures: 0, statusCounts: { waiting_permission: 1 } },
      runs: [{
        id: 'run-restarted-format',
        kind: 'chat_format_guardian',
        title: '重启后的格式候选',
        status: 'waiting_permission',
        review: {
          protocolParseFailure: true,
          modelReviewDetail: { canRepair: true },
        },
      }],
    },
  };
  const html = panel.renderActivity();
  assert.doesNotMatch(html, /data-agent-run-review-action="apply"/);
  assert.match(html, /data-agent-run-review-action="reject"/);
  console.log('ok - agent center hides stale format apply after its volatile candidate is gone');
}

{
  const panel = new AgentCenterPanel();
  panel.activeTab = 'activity';
  panel.view = {
    activity: {
      meta: { total: 1, active: 1, failures: 0, statusCounts: { waiting_permission: 1 } },
      runs: [
        {
          id: 'run-body',
          kind: 'chat_body_quality_guardian',
          title: '正文可优化',
          status: 'waiting_permission',
          summary: '1 body quality issue(s)',
          review: {
            type: 'body_quality',
            sourceTextKind: 'rawOriginal',
            hasRawOriginal: true,
            issueCount: 1,
            issues: [{
              title: '连续重复句段',
              summary: '发现 1 行连续重复正文。',
              risk: 'low',
            }],
            patchCandidate: {
              available: true,
              title: '清理重复正文',
              summary: '移除 1 行连续重复',
              risk: 'low',
            },
            actionLabels: ['查看原文', 'Agent Center'],
          },
        },
      ],
    },
  };
  const html = panel.renderActivity();
  assert.match(html, /正文检查：发现 1 个问题/);
  assert.match(html, /检查原始回复/);
  assert.match(html, /问题：连续重复句段/);
  assert.match(html, /优化候选：清理重复正文/);
  assert.match(html, /可在消息旁处理：查看原文、Agent Center/);
  assert.doesNotMatch(html, /replacementText/);
  console.log('ok - agent center panel renders chat body quality review details without write actions');
}

{
  let opened = null;
  const panel = new AgentCenterPanel({
    openResourceTarget: async (target, resource) => {
      opened = { target, resource };
      return true;
    },
  });
  let hidden = false;
  panel.hide = () => {
    hidden = true;
  };
  panel.render = () => {};
  panel.view = {
    resources: [
      {
        id: 'memory_center',
        group: '记忆',
        title: '记忆',
        summary: '表格、模板、导入导出。',
        status: '就绪',
        target: { panel: 'memoryTemplatePanel', focus: 'overview' },
        actionLabel: '打开',
      },
    ],
  };
  const html = panel.renderResources();
  assert.match(html, /记忆/);
  assert.match(html, /表格、模板、导入导出/);
  assert.doesNotMatch(html, /提示词/);
  assert.doesNotMatch(html, /data-resource-prompt-id="dialogue"/);
  assert.match(html, /data-resource-open="memory_center"/);
  assert.doesNotMatch(html, /统一资源入口/);
  assert.doesNotMatch(html, /Prompt Library/);
  assert.doesNotMatch(html, /主界面：presetPanel/);
  assert.doesNotMatch(html, /二级详情/);
  await panel.handleResourceOpen('memory_center');
  assert.equal(opened.target.panel, 'memoryTemplatePanel');
  assert.equal(opened.target.focus, 'overview');
  assert.equal(opened.resource.id, 'memory_center');
  assert.equal(hidden, false);
  console.log('ok - agent center resources render clean entries without legacy prompt card');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    tools: [
      {
        name: 'contact_profile.get',
        title: 'Get contact profile',
        source: 'contact-profile-store',
        description: 'Get one profile',
        riskLevel: 'low',
        permissions: ['storage'],
        executionMode: 'sequential',
        capabilities: {
          read: true,
          write: false,
          network: false,
          cost: 'none',
          undo: 'none',
          modelContext: 'allowlist',
          confirmation: 'allow_once',
        },
      },
    ],
  };
  const html = panel.renderTools();
  assert.match(html, /读取联系人画像/);
  assert.match(html, /可读取/);
  assert.match(html, /只读/);
  assert.match(html, /本地执行/);
  assert.match(html, /AI 可请求/);
  console.log('ok - agent center panel renders tool capability chips');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    safety: {
      sessionGate: {
        enabled: false,
        allowedTools: ['contact_profile.list'],
        networkAllowed: false,
        realRunnerAllowed: false,
        writesChat: false,
        writePreviewTools: {
          enabled: false,
          activeTools: [],
          availableTools: ['memory.preview_actions', 'variable.preview_commands', 'worldbook.preview_actions'],
        },
      },
      providerTools: { enabled: false, allowedTools: ['contact_profile.list'] },
      permissionRules: [],
      continuationCommitPolicy: { defaultStrategy: 'preview_only' },
    },
  };
  const html = panel.renderSafety();
  assert.match(html, /开启当前会话 Agent 工具/);
  assert.match(html, /data-session-gate-action="enable"/);
  assert.match(html, /不会自动继续生成/);
  assert.match(html, /不会自动写聊天/);
  assert.match(html, /读取联系人列表/);
  assert.match(html, /记忆\/变量\/世界书预览/);
  assert.match(html, /data-write-preview-model-context-action="enable"/);
  assert.match(html, /继续生成后的处理方式/);
  assert.match(html, /data-continuation-policy-strategy="append_to_previous_bubble"/);
  console.log('ok - agent center safety renders session gate controls and execution boundaries');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    safety: {
      sessionGate: {
        enabled: true,
        allowedTools: ['contact_profile.list', 'memory.preview_actions', 'variable.preview_commands', 'worldbook.preview_actions'],
        networkAllowed: false,
        realRunnerAllowed: false,
        writesChat: false,
        writePreviewTools: {
          enabled: true,
          activeTools: ['memory.preview_actions', 'variable.preview_commands', 'worldbook.preview_actions'],
          availableTools: ['memory.preview_actions', 'variable.preview_commands', 'worldbook.preview_actions'],
        },
      },
      providerTools: { enabled: false, allowedTools: ['contact_profile.list'] },
      permissionRules: [],
      continuationCommitPolicy: { defaultStrategy: 'append_to_previous_bubble' },
    },
  };
  const html = panel.renderSafety();
  assert.match(html, /关闭当前会话 Agent 工具/);
  assert.match(html, /data-session-gate-action="disable"/);
  assert.match(html, /AI 可以请求已允许的工具/);
  assert.match(html, /data-write-preview-model-context-action="disable"/);
  assert.match(html, /记忆变更预览/);
  assert.match(html, /接到上一气泡/);
  console.log('ok - agent center safety renders the enabled session gate state');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    safety: {
      sessionGate: {
        enabled: false,
        allowedTools: [],
        networkAllowed: false,
        realRunnerAllowed: false,
        writesChat: false,
        writePreviewTools: { enabled: false, activeTools: [], availableTools: [] },
      },
      providerTools: { enabled: false, allowedTools: [] },
      permissionRules: [],
      permissionRuleSummary: {
        total: 2,
        decisionCounts: { allow: 1, deny: 1, ask: 0 },
        conflictCount: 1,
        orderText: '全局 > 角色卡 > 当前会话 > Agent > 插件 > 默认',
        tieBreakText: '同层先看优先级，仍相同则以后添加的规则生效。',
        visibleRules: [
          {
            id: 'rule-1',
            layerLabel: '当前会话',
            decision: 'allow',
            decisionLabel: '允许',
            toolName: 'contact_profile.list',
            permission: 'storage',
            source: 'provider-tool-permission',
            sessionId: 'chat:a',
          },
        ],
        overflow: 1,
      },
      continuationCommitPolicy: { defaultStrategy: 'preview_only' },
    },
  };
  const html = panel.renderSafety();
  assert.match(html, /已记住的允许规则/);
  assert.match(html, /优先顺序：全局 &gt; 角色卡 &gt; 当前会话 &gt; Agent &gt; 插件 &gt; 默认/);
  assert.match(html, /同层先看优先级/);
  assert.match(html, /检测到 1 组同范围不同决定/);
  assert.match(html, /读取联系人列表/);
  assert.match(html, /允许 1/);
  assert.match(html, /拒绝 1/);
  assert.match(html, /还有 1 条未显示/);
  console.log('ok - agent center safety explains remembered permission precedence');
}

{
  const text = formatAgentCenterExportText({
    meta: { pending: 1, activeRuns: 0, unreadFailedRuns: 1, tools: 1, resources: 1, agents: 1, enabledAgents: 1, promptModules: 1, enabledPromptModules: 1, diagnosticViews: 1 },
    pending: [{
      toolName: 'contact_profile.list',
      status: 'pending',
      sessionId: 'chat:a',
      resumeStatus: 'idle',
    }],
    activity: {
      runs: [{
        title: '正文检查',
        kind: 'chat_body_quality_guardian',
        status: 'failed',
        sessionId: 'chat:a',
        summary: '发现问题',
      }],
    },
    agents: [{
      id: 'reply_check',
      title: '检查回复格式',
      enabled: true,
      implemented: true,
      modelLabel: '不调用模型',
    }],
    promptModules: [{
      id: 'phone_format_agent',
      title: '手机格式',
      enabled: true,
      promptRefs: [{ id: 'phone-format-chat' }],
      summary: '管理手机聊天、动态和结尾格式提示词。',
    }],
    diagnosticViews: [{
      id: 'execution_lane_agent',
      title: '执行泳道',
      implemented: true,
      summary: '把创作过程按输入、模型、记忆和生图等泳道展示。',
    }],
    resources: [{
      id: 'memory_center',
      title: '记忆',
      group: '记忆',
      status: '就绪',
      summary: '表格、模板、导入导出。',
    }],
    safety: {
      sessionGate: {
        enabled: true,
        networkAllowed: false,
        realRunnerAllowed: false,
        allowedTools: ['contact_profile.list'],
      },
      permissionRuleSummary: {
        total: 2,
        conflictCount: 1,
        orderText: '全局 > 角色卡 > 当前会话 > Agent > 插件 > 默认',
      },
    },
  });
  assert.match(text, /Agent Center 导出/);
  assert.match(text, /待确认 1/);
  assert.match(text, /读取联系人列表 · 待确认 · 范围：chat:a/);
  assert.match(text, /正文检查 · 失败 · 范围：chat:a · 发现问题/);
  assert.match(text, /检查回复格式 · 已开启 · 可使用 · 模型：不调用模型/);
  assert.match(text, /手机格式 · 已开启 · 提示词 1 · 管理手机聊天、动态和结尾格式提示词。/);
  assert.match(text, /执行泳道 · 可使用 · 把创作过程按输入、模型、记忆和生图等泳道展示。/);
  assert.match(text, /记忆 · 分组：记忆 · 状态：就绪 · 表格、模板、导入导出。/);
  assert.doesNotMatch(text, /提示词 · 分组：Agent/);
  assert.match(text, /工具白名单：读取联系人列表/);
  assert.match(text, /规则冲突：1 组/);
  assert.doesNotMatch(text, /rawOriginal|replacementText|runnerFacade/);
  console.log('ok - agent center export text stays user-facing and lightweight');
}

{
  const calls = [];
  const panel = new AgentCenterPanel({
    exportTextFile: async (text, filename, successLabel) => {
      calls.push({ text, filename, successLabel });
      return true;
    },
  });
  panel.view = {
    meta: { pending: 0, activeRuns: 0, unreadFailedRuns: 0, tools: 0, resources: 0 },
    pending: [],
    activity: { runs: [] },
    resources: [],
    safety: { sessionGate: { enabled: false, allowedTools: [] }, permissionRuleSummary: { total: 0 } },
  };
  const ok = await panel.handleExport();
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].filename, /^agent-center-\d{8}-\d{6}\.txt$/);
  assert.equal(calls[0].successLabel, 'Agent Center 已导出');
  assert.match(calls[0].text, /Agent Center 导出/);
  console.log('ok - agent center export action delegates lightweight text export');
}

{
  let saved = null;
  let refreshed = false;
  let confirmOptions = null;
  const panel = new AgentCenterPanel({
    confirm: async options => {
      confirmOptions = options;
      return true;
    },
    getActions: () => ({
      setProviderToolSessionGate: options => {
        saved = options;
        return options;
      },
    }),
  });
  panel.view = {
    safety: {
      sessionGate: {
        enabled: true,
        allowedTools: ['contact_profile.list'],
        networkAllowed: false,
        realRunnerAllowed: false,
        writesChat: false,
      },
    },
  };
  panel.refresh = async () => {
    refreshed = true;
  };
  await panel.handleWritePreviewModelContextAction('enable');
  assert.equal(confirmOptions.confirmText, '加入预览工具');
  assert.equal(saved.enabled, true);
  assert.equal(saved.networkAllowed, false);
  assert.equal(saved.realRunnerAllowed, false);
  assert.deepEqual(saved.allowedTools, [
    'contact_profile.list',
    'memory.preview_actions',
    'variable.preview_commands',
    'worldbook.preview_actions',
  ]);
  assert.equal(refreshed, true);
  console.log('ok - agent center safety toggles write preview model-context tools');
}

{
  let saved = null;
  let refreshed = false;
  const panel = new AgentCenterPanel({
    getActions: () => ({
      setProviderContinuationCommitPolicy: options => {
        saved = options;
        return { defaultStrategy: options.defaultStrategy };
      },
    }),
  });
  panel.refresh = async () => {
    refreshed = true;
  };
  await panel.handleContinuationPolicyAction('append_to_previous_bubble');
  assert.equal(saved.defaultStrategy, 'append_to_previous_bubble');
  assert.equal(refreshed, true);
  console.log('ok - agent center safety updates provider continuation default strategy');
}

{
  const panel = new AgentCenterPanel({
    getActions: () => ({
      listAgentRunView: () => {
        throw new Error('run view unavailable');
      },
    }),
  });
  const view = await panel.collectView();
  assert.equal(view.activity.runs.length, 0);
  assert.equal(panel.lastError, 'run view unavailable');
  console.log('ok - agent center panel degrades to empty view when optional actions fail');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    globalPromptLibrary: {
      schemaVersion: 1,
      budgetVersion: 1,
      blocks: [{
        id: 'global-a',
        name: '人物一致性',
        enabled: true,
        content: 'Keep {{char}} consistent.',
        scope: 'chat',
        anchor: 'semantic_header',
      }],
    },
  };
  const html = panel.renderGlobalPromptLibrary();
  assert.match(html, /全局语义提示词库/);
  assert.match(html, /人物一致性/);
  assert.match(html, /语义层头部/);
  assert.match(html, /单块上限 2,000 tok/);
  assert.match(html, /示例私聊 FC/);
  assert.match(html, />导入</);
  assert.match(html, />导出</);
  assert.doesNotMatch(html, /导入 JSON|导出 JSON/);
  assert.match(html, /class="agent-center-global-workspace" data-global-prompt-preview-state="closed"/);
  assert.match(html, /data-global-prompt-preview-open/);
  assert.match(html, /class="agent-center-global-preview-pane"/);
  assert.match(html, /data-global-prompt-preview-expand/);
  assert.match(html, /data-global-prompt-preview-collapse/);
  assert.match(html, /data-global-prompt-preview-return/);
  assert.match(html, /draggable="true"/);
  assert.match(html, /data-global-prompt-open="global-a"/);
  assert.doesNotMatch(html, /data-global-prompt-field="content"/);
  assert.match(html, /class="agent-center-global-toggle is-enabled"/);
  assert.match(html, />已启用</);
  console.log('ok - global prompt root renders lightweight blocks that navigate to a secondary editor');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    globalPromptLibrary: {
      schemaVersion: 1,
      budgetVersion: 1,
      blocks: [{
        id: 'global-a',
        name: '人物一致性',
        enabled: true,
        content: 'line one\nline two',
        scope: 'chat',
        anchor: 'semantic_header',
      }],
    },
  };
  panel.renderGlobalPromptLibrary();
  panel.render = () => {};
  panel.openGlobalPromptBlockEditor('global-a');
  assert.equal(panel.globalPromptPage, 'block');
  assert.equal(panel.globalPromptEditingId, 'global-a');
  const html = panel.renderGlobalPromptLibrary();
  assert.match(html, /data-global-prompt-back/);
  assert.match(html, /data-global-prompt-editor-content/);
  assert.match(html, /line one\nline two/);
  assert.match(html, /data-global-prompt-accept-draft/);
  assert.match(html, /data-global-prompt-reject-draft/);
  assert.doesNotMatch(html, /data-global-prompt-open="global-a"/);
  console.log('ok - global prompt block opens a preset-style secondary editor with draft actions');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    globalPromptLibrary: {
      schemaVersion: 1,
      budgetVersion: 1,
      blocks: [{
        id: 'global-a',
        name: '人物一致性',
        enabled: true,
        content: 'alpha\nbeta\ngamma',
        scope: 'chat',
        anchor: 'semantic_header',
      }],
    },
  };
  panel.renderGlobalPromptLibrary();
  panel.render = () => {};
  panel.openGlobalPromptBlockEditor('global-a');
  panel.updateGlobalPromptDraft('global-a', { content: 'alpha\nBETA\ngamma' });
  panel.globalPromptPreview = {
    ok: true,
    route: 'provider_fc',
    audit: { injected: [], skipped: [], usedTokens: 0 },
  };
  const html = panel.renderGlobalPromptPreview();
  assert.match(html, /agent-center-global-diff-del/);
  assert.match(html, /agent-center-global-diff-ins/);
  assert.match(html, /data-global-prompt-accept-hunk="0"/);
  assert.match(html, /data-global-prompt-reject-hunk="0"/);
  panel.rejectGlobalPromptHunk('global-a', 0);
  assert.equal(panel.globalPromptDrafts.get('global-a').content, 'alpha\nbeta\ngamma');
  console.log('ok - global prompt preview renders and rejects preset-compatible line hunks');
}

{
  const writes = [];
  const panel = new AgentCenterPanel({
    getActions: () => ({
      upsertGlobalSemanticPromptBlock: ({ block }) => {
        writes.push(block);
        return {
          ok: true,
          block: { ...block, updatedAt: 2 },
          library: { blocks: [{ ...block, updatedAt: 2 }] },
        };
      },
    }),
  });
  panel.view = {
    globalPromptLibrary: {
      blocks: [{
        id: 'global-a', name: 'A', enabled: true, scope: 'chat', anchor: 'semantic_header', content: 'a\nb\nc',
      }],
    },
  };
  panel.renderGlobalPromptLibrary();
  panel.render = () => {};
  panel.refresh = async () => true;
  panel.openGlobalPromptBlockEditor('global-a');
  panel.updateGlobalPromptDraft('global-a', { content: 'a\nB\nc' });
  const accepted = await panel.acceptGlobalPromptHunk('global-a', 0);
  assert.equal(accepted, true);
  assert.equal(writes[0].content, 'a\nB\nc');
  assert.equal(panel.globalPromptBases.get('global-a').content, 'a\nB\nc');
  console.log('ok - accepting a global prompt hunk persists only the accepted content baseline');
}

{
  let textareaValue = 'left';
  const textarea = {
    get value() { return textareaValue; },
    set value(value) { textareaValue = value; },
  };
  const panel = new AgentCenterPanel();
  panel.globalPromptBases.set('global-a', {
    id: 'global-a', name: 'A', enabled: true, scope: 'chat', anchor: 'semantic_header', content: 'left',
  });
  panel.globalPromptDrafts.set('global-a', {
    id: 'global-a', name: 'A', enabled: true, scope: 'chat', anchor: 'semantic_header', content: 'left',
  });
  panel.contentElement = {
    querySelector: selector => selector === '[data-global-prompt-editor-content]' ? textarea : null,
  };
  panel.handleGlobalPromptPreviewEdited({
    textContent: 'edited on preview',
    getAttribute: name => name === 'data-global-prompt-preview-editor' ? 'global-a' : '',
  });
  assert.equal(panel.globalPromptDrafts.get('global-a').content, 'edited on preview');
  assert.equal(textarea.value, 'edited on preview');
  console.log('ok - editing the global preview writes through to the left-side draft editor');
}

{
  const textarea = {
    scrollTop: 400,
    scrollHeight: 1000,
    clientHeight: 200,
  };
  const preview = {
    scrollTop: 0,
    scrollHeight: 600,
    clientHeight: 100,
  };
  const panel = new AgentCenterPanel();
  panel.globalPromptPage = 'block';
  panel.globalPromptPreviewState = 'split';
  panel.contentElement = {
    querySelector(selector) {
      if (selector === '[data-global-prompt-editor-content]') return textarea;
      if (selector === '[data-global-prompt-preview-body]') return preview;
      return null;
    },
  };
  assert.equal(panel.syncGlobalPromptPreviewToEditorScroll(textarea), true);
  assert.equal(preview.scrollTop, 250);
  panel.globalPromptScrollSource = '';
  preview.scrollTop = 125;
  assert.equal(panel.syncGlobalPromptEditorToPreviewScroll(preview), true);
  assert.equal(textarea.scrollTop, 200);
  clearTimeout(panel.globalPromptScrollReleaseTimer);
  console.log('ok - global prompt editor and preview synchronize scroll progress in both directions');
}

{
  let created = null;
  const panel = new AgentCenterPanel({
    promptText: async () => '跨会话约束',
    getActions: () => ({
      upsertGlobalSemanticPromptBlock: ({ block }) => {
        created = { ...block, id: 'global-new' };
        return { ok: true, block: created, library: { blocks: [created] } };
      },
    }),
  });
  panel.refresh = async () => true;
  panel.render = () => {};
  await panel.handleGlobalPromptAdd();
  assert.equal(created.name, '跨会话约束');
  assert.equal(created.enabled, false);
  assert.equal(panel.globalPromptPage, 'block');
  assert.equal(panel.globalPromptEditingId, 'global-new');
  console.log('ok - adding a global prompt asks for a name and opens its secondary editor');
}

{
  const panel = new AgentCenterPanel();
  panel.view = {
    globalPromptLibrary: {
      schemaVersion: 1,
      budgetVersion: 1,
      blocks: [{
        id: 'global-draft',
        name: '草稿内容',
        enabled: false,
        content: 'draft',
        scope: 'chat',
        anchor: 'semantic_header',
      }],
    },
  };
  panel.globalPromptPreviewContext = 'private_fc';
  panel.globalPromptPreview = {
    ok: true,
    route: 'provider_fc',
    audit: { injected: [], skipped: [], usedTokens: 0 },
  };
  const editorHtml = panel.renderGlobalPromptLibrary();
  assert.match(editorHtml, />启用此提示词</);
  const html = panel.renderGlobalPromptPreview();
  assert.match(html, /没有可注入的全局提示词/);
  assert.match(html, /1 个聊天模式草稿尚未启用/);
  assert.match(html, /勾选「启用此提示词」/);
  console.log('ok - empty global prompt preview explains matching disabled drafts');
}

{
  const panel = new AgentCenterPanel();
  let renders = 0;
  panel.render = () => { renders += 1; };
  panel.globalPromptPreview = { ok: true, audit: { injected: [] } };
  panel.isGlobalPromptPreviewPhoneLayout = () => false;
  panel.openGlobalPromptPreview();
  assert.equal(panel.globalPromptPreviewState, 'split');
  panel.setGlobalPromptPreviewState('full');
  assert.equal(panel.globalPromptPreviewState, 'full');
  panel.returnFromGlobalPromptPreview();
  assert.equal(panel.globalPromptPreviewState, 'split');
  panel.closeGlobalPromptPreview();
  assert.equal(panel.globalPromptPreviewState, 'closed');

  panel.isGlobalPromptPreviewPhoneLayout = () => true;
  panel.openGlobalPromptPreview();
  assert.equal(panel.globalPromptPreviewState, 'full');
  panel.returnFromGlobalPromptPreview();
  assert.equal(panel.globalPromptPreviewState, 'closed');
  assert.equal(renders, 6);
  console.log('ok - global prompt preview mirrors preset split/full behavior across desktop and phone layouts');
}

{
  const calls = [];
  const panel = new AgentCenterPanel({
    getActions: () => ({
      upsertGlobalSemanticPromptBlock: (options) => {
        calls.push(options);
        return {
          ok: true,
          forcedDisabled: true,
          validation: { message: '检测到回复格式指令；请放入会话预设' },
        };
      },
    }),
  });
  panel.refresh = async () => true;
  const fields = {
    name: { value: '格式草稿' },
    enabled: { checked: true },
    scope: { value: 'chat' },
    anchor: { value: 'semantic_header' },
    content: { value: 'MiPhone_start' },
  };
  const card = {
    dataset: { globalPromptCard: 'draft-a' },
    querySelector: selector => fields[selector.match(/"([^"]+)"/)?.[1]] || null,
  };
  await panel.handleGlobalPromptSave(card);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].block.enabled, true);
  assert.equal(calls[0].block.content, 'MiPhone_start');
  console.log('ok - agent center keeps guarded output contracts as disabled drafts through the action layer');
}
