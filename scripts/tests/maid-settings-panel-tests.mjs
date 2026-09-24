import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createMaidSettingsPanel } from '../../src/scripts/ui/maid-settings-panel.js';

const maidSettingsSource = fs.readFileSync(
  new URL('../../src/scripts/ui/maid-settings-panel.js', import.meta.url),
  'utf8',
);

{
  assert.match(maidSettingsSource, /\.maid-settings-panel\s*\{[\s\S]*?width:\s*min\(920px,\s*94vw\)[\s\S]*?border-radius:\s*28px/);
  assert.match(maidSettingsSource, /\.maid-settings-tabs\s*\{[\s\S]*?grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(maidSettingsSource, /\.maid-settings-overlay\s*\{[\s\S]*?backdrop-filter:\s*blur\(7px\)/);
  assert.match(maidSettingsSource, /\.maid-settings-overlay\.is-open\s+\.maid-settings-panel\s*\{/);
  assert.match(maidSettingsSource, /body\[data-reduced-motion=['"]on['"]\]\s+\.maid-settings-overlay/);
  assert.match(maidSettingsSource, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.maid-settings-panel\s*\{[\s\S]*?border-radius:\s*0/);
  assert.match(
    maidSettingsSource,
    /\.maid-memory-card\s*\{[^}]*?flex:\s*0\s+0\s+auto\s*;/,
    'semantic-memory cards must keep their natural height inside the scrolling flex list',
  );
  assert.match(maidSettingsSource, /maid-settings-header-copy/);
  assert.match(maidSettingsSource, /ARIA Assistant/);
  assert.match(maidSettingsSource, /maid-settings-section-caption/);
  assert.match(maidSettingsSource, /maid-settings-empty-state/);
  assert.match(maidSettingsSource, /maid-settings-task-completion/);
  assert.match(maidSettingsSource, /maid-settings-task-item\.is-entering/);
  assert.match(maidSettingsSource, /taskListHasEntered/);
  assert.match(maidSettingsSource, /data-api-nav="memory"/);
  assert.match(maidSettingsSource, /data-memory-extraction-mode/);
  assert.match(maidSettingsSource, /data-memory-extraction-profile/);
  assert.match(maidSettingsSource, /data-memory-extraction-fallback/);
  assert.match(maidSettingsSource, /跟随女仆主模型/);
  assert.match(maidSettingsSource, /linear-gradient\([^;]*var\(--app-accent-primary/);
  assert.match(maidSettingsSource, /rgba\(var\(--app-task-rgb/);
  assert.doesNotMatch(maidSettingsSource, /background:\s*rgba\(139,\s*92,\s*246/);
  assert.doesNotMatch(maidSettingsSource, /animation[^;]*infinite/);
  console.log('ok - maid settings redesign keeps reference proportions, onboarding visuals, responsive motion, and semantic structure');
}

const createClassList = () => {
  const set = new Set();
  return {
    add: (...tokens) => tokens.forEach(token => set.add(token)),
    remove: (...tokens) => tokens.forEach(token => set.delete(token)),
    contains: token => set.has(token),
    toggle: (token, force) => {
      if (force === true) set.add(token);
      else if (force === false) set.delete(token);
      else if (set.has(token)) set.delete(token);
      else set.add(token);
    },
  };
};

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.classList = createClassList();
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.value = '';
    this.textContent = '';
    this.type = '';
    this.readOnly = false;
    this.spellcheck = true;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...items) {
    items.forEach(item => this.appendChild(item));
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatchEvent(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler(event);
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  scrollIntoView(options) {
    this.scrollIntoViewOptions = options;
  }
}

class FakeDocument {
  constructor() {
    this.head = new FakeElement('head');
    this.body = new FakeElement('body');
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  getElementById() {
    return null;
  }
}

const findByText = (root, text) => {
  if (!root) return null;
  if (root.textContent === text) return root;
  for (const child of root.children || []) {
    const found = findByText(child, text);
    if (found) return found;
  }
  return null;
};

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

{
  const documentRef = new FakeDocument();
  const panel = createMaidSettingsPanel({
    documentRef,
    settingsStore: { getMaidPrompt: () => '' },
  });
  panel.show({ tab: 'prompt' });
  const lastResponseTab = panel.getElements().promptTabButtons.get('lastResponse');
  lastResponseTab.dispatchEvent('click', {});
  assert.deepEqual(lastResponseTab.scrollIntoViewOptions, { block: 'nearest', inline: 'nearest' });
  console.log('ok - long English maid prompt tabs scroll the active tab fully into view');
}

{
  const documentRef = new FakeDocument();
  const apiCalls = [];
  const copied = [];
  const deletedSemanticMemories = [];
  const semanticMemoryStatusChanges = [];
  const semanticMemories = [
    {
      id: 'memory-pref-background',
      kind: 'preference',
      key: 'presentation.default',
      content: '普通操作默认后台执行；明确要求查看时才打开主要结果。',
      confidence: 'explicit',
      status: 'active',
      tags: ['呈现', '女仆'],
      sourceTurnIds: ['turn-source-a', 'turn-source-b'],
      updatedAt: 1700000002000,
    },
  ];
  const store = {
    maidPrompt: '旧提示词',
    lastAppContext: '检索：已执行\n命中：打开世界书',
    lastPrompt: 'system:\n本次提示词',
    lastResponse: '完整回复',
    getMaidPrompt() {
      return this.maidPrompt;
    },
    async setMaidPrompt(value) {
      this.maidPrompt = value;
      return value;
    },
    getLastRequestPrompt() {
      return this.lastPrompt;
    },
    getLastAppContext() {
      return this.lastAppContext;
    },
    getLastFullResponse() {
      return this.lastResponse;
    },
  };
  const panel = createMaidSettingsPanel({
    documentRef,
    settingsStore: store,
    getAppKnowledgeText: () => '打开世界书 (worldbook.open)\n工具：app.open_panel',
    getHistoryContextText: () => '- 用户: 创建角色卡 A\n  结果: 已完成',
    getMemoryTableText: () => '| 1 | 摘要 |\n| 内容 | 用户创建了角色卡 A。 |',
    semanticMemoryStore: {
      listMemories: () => semanticMemories.filter(memory => !deletedSemanticMemories.includes(memory.id)),
      setMemoryStatus: async (id, status) => {
        const memory = semanticMemories.find(item => item.id === id);
        if (!memory) return null;
        memory.status = status;
        semanticMemoryStatusChanges.push([id, status]);
        return memory;
      },
      deleteMemory: async (id) => {
        deletedSemanticMemories.push(id);
        return true;
      },
    },
    confirmDeleteSemanticMemory: async () => true,
    onOpenApiConfig: payload => apiCalls.push(payload),
    copyText: async text => copied.push(text),
    logger: { warn() {}, debug() {} },
  });

  assert.equal(panel.show({ tab: 'prompt' }), true);
  const elements = panel.getElements();
  assert.equal(elements.tabButtons.has('lastResponse'), false);
  assert.equal(elements.tabButtons.get('prompt').classList.contains('is-active'), true);
  assert.equal(elements.promptTabButtons.get('persona').classList.contains('is-active'), true);
  assert.equal(elements.promptTabButtons.has('historyContext'), true);
  assert.equal(elements.promptTabButtons.has('semanticMemory'), true);
  assert.equal(elements.promptTabButtons.has('memoryTable'), true);
  assert.equal(elements.promptTabButtons.has('lastResponse'), true);
  assert.equal(elements.promptTextarea.value, '旧提示词');
  assert.equal(elements.promptTextarea.dataset.viewportKeyboardDiagnostic, 'maid-persona-prompt');
  assert.equal(elements.promptCountEl.textContent, '4 字');
  assert.equal(elements.overlay.attributes['aria-hidden'], 'false');
  assert.equal(elements.panel.attributes.role, 'dialog');
  elements.promptTextarea.value = '新提示词';
  elements.promptTextarea.dispatchEvent('input', {});
  assert.equal(elements.promptCountEl.textContent, '4 字');
  findByText(elements.sections.get('prompt'), '保存').dispatchEvent('click', {});
  await flushMicrotasks();
  assert.equal(store.maidPrompt, '新提示词');
  assert.equal(elements.statusEl.textContent, '提示词已保存');

  panel.switchTab('appKnowledge');
  assert.equal(elements.tabButtons.get('prompt').classList.contains('is-active'), true);
  assert.equal(elements.promptTabButtons.get('appKnowledge').classList.contains('is-active'), true);
  assert.equal(elements.promptPanes.get('appKnowledge').classList.contains('is-active'), true);
  assert.match(elements.appKnowledgeTextarea.value, /worldbook\.open/);
  assert.match(elements.lastAppContextTextarea.value, /检索：已执行/);

  panel.switchTab('historyContext');
  assert.equal(elements.promptTabButtons.get('historyContext').classList.contains('is-active'), true);
  assert.equal(elements.historyContextTextarea.value, '- 用户: 创建角色卡 A\n  结果: 已完成');
  findByText(elements.promptPanes.get('historyContext'), '复制').dispatchEvent('click', {});
  await flushMicrotasks();
  assert.deepEqual(copied, ['- 用户: 创建角色卡 A\n  结果: 已完成']);

  panel.switchTab('semanticMemory');
  assert.equal(elements.promptTabButtons.get('semanticMemory').classList.contains('is-active'), true);
  assert.ok(findByText(elements.semanticMemoryListEl, '普通操作默认后台执行；明确要求查看时才打开主要结果。'));
  assert.ok(findByText(elements.semanticMemoryListEl, 'presentation.default'));
  assert.ok(findByText(elements.semanticMemoryListEl, 'turn-source-a'));
  findByText(elements.semanticMemoryListEl, '归档').dispatchEvent('click', {});
  await flushMicrotasks();
  assert.deepEqual(semanticMemoryStatusChanges, [['memory-pref-background', 'archived']]);
  assert.ok(findByText(elements.semanticMemoryListEl, '已归档'));
  assert.ok(findByText(elements.semanticMemoryListEl, '恢复'));
  findByText(elements.semanticMemoryListEl, '恢复').dispatchEvent('click', {});
  await flushMicrotasks();
  assert.deepEqual(semanticMemoryStatusChanges, [
    ['memory-pref-background', 'archived'],
    ['memory-pref-background', 'active'],
  ]);
  assert.ok(findByText(elements.semanticMemoryListEl, '生效中'));
  findByText(elements.semanticMemoryListEl, '永久删除').dispatchEvent('click', {});
  await flushMicrotasks();
  assert.deepEqual(deletedSemanticMemories, ['memory-pref-background']);
  assert.ok(findByText(elements.semanticMemoryListEl, '还没有长期记忆。'));

  panel.switchTab('memoryTable');
  assert.equal(elements.promptTabButtons.get('memoryTable').classList.contains('is-active'), true);
  assert.match(elements.memoryTableTextarea.value, /用户创建了角色卡 A/);
  findByText(elements.promptPanes.get('memoryTable'), '复制').dispatchEvent('click', {});
  await flushMicrotasks();
  assert.deepEqual(copied, [
    '- 用户: 创建角色卡 A\n  结果: 已完成',
    '| 1 | 摘要 |\n| 内容 | 用户创建了角色卡 A。 |',
  ]);

  panel.switchTab('lastPrompt');
  assert.equal(elements.lastPromptTextarea.value, 'system:\n本次提示词');
  findByText(elements.promptPanes.get('lastPrompt'), '复制').dispatchEvent('click', {});
  await flushMicrotasks();
  assert.deepEqual(copied, [
    '- 用户: 创建角色卡 A\n  结果: 已完成',
    '| 1 | 摘要 |\n| 内容 | 用户创建了角色卡 A。 |',
    'system:\n本次提示词',
  ]);

  panel.switchTab('lastResponse');
  assert.equal(elements.tabButtons.get('prompt').classList.contains('is-active'), true);
  assert.equal(elements.promptTabButtons.get('lastResponse').classList.contains('is-active'), true);
  assert.equal(elements.promptPanes.get('lastResponse').classList.contains('is-active'), true);
  assert.equal(elements.lastResponseTextarea.value, '完整回复');
  findByText(elements.promptPanes.get('lastResponse'), '复制').dispatchEvent('click', {});
  await flushMicrotasks();
  assert.deepEqual(copied, [
    '- 用户: 创建角色卡 A\n  结果: 已完成',
    '| 1 | 摘要 |\n| 内容 | 用户创建了角色卡 A。 |',
    'system:\n本次提示词',
    '完整回复',
  ]);

  panel.switchTab('api');
  // API 分页已改二级导航（2026-07-08）：「管理连线配置」链接位于主配置二级页内，
  // FakeDocument 不支持 innerHTML 渲染，onOpenApiConfig 回调路径由真机动线测试覆盖。
  console.log('ok - maid settings panel saves prompt and exposes debug tabs');
}

{
  const documentRef = new FakeDocument();
  const runs = [
    {
      id: 'run-1',
      status: 'succeeded',
      summary: '已打开世界书。',
      updatedAt: 1700000000000,
      metadata: { goal: '打开世界书', stepCount: 1 },
    },
    {
      id: 'run-2',
      status: 'failed',
      summary: '已达到本轮执行预算。',
      updatedAt: 1700000001000,
      metadata: { goal: '整理世界书', stepCount: 6, maidStatus: 'interrupted', continuable: true },
    },
  ];
  let rules = [
    {
      key: 'worldbook.delete_entries|worldbook.delete|write',
      toolName: 'worldbook.delete_entries',
      title: '删除世界书条目',
      operationType: 'write',
      riskLevel: 'high',
      updatedAt: 1700000000000,
    },
  ];
  const revoked = [];
  const panel = createMaidSettingsPanel({
    documentRef,
    settingsStore: { getMaidPrompt: () => '' },
    listRuns: () => runs.map(run => ({ ...run, metadata: { ...run.metadata } })),
    allowRulesStore: {
      list: () => rules.map(rule => ({ ...rule })),
      revoke: (key) => {
        revoked.push(key);
        const before = rules.length;
        rules = rules.filter(rule => rule.key !== key);
        return rules.length !== before;
      },
    },
    logger: { warn() {} },
  });
  panel.show({ tab: 'activity' });
  const elements = panel.getElements();
  assert.equal(elements.tabButtons.get('activity').classList.contains('is-active'), true);
  assert.equal(elements.tabButtons.get('activity').attributes['aria-selected'], 'true');
  assert.equal(elements.runCountEl.textContent, '2');
  assert.equal(elements.runListEl.children.length, 2);
  assert.ok(findByText(elements.runListEl, '打开世界书'), '活动列表应显示 run 目标');
  assert.ok(findByText(elements.runListEl, '成功'), '成功 run 应有状态标签');
  assert.ok(findByText(elements.runListEl, '中断'), '中断 run 应显示中断状态');
  assert.ok(findByText(elements.runListEl, '已达到本轮执行预算。'), '中断 run 应显示摘要');
  assert.ok(findByText(elements.runListEl, '6 步'), '中断 run 应显示步数');
  assert.ok(findByText(elements.runListEl, '可继续'), '中断 run 应显示可继续标记');
  assert.ok(findByText(elements.runListEl, new Date(1700000001000).toLocaleString()), '中断 run 应显示更新时间');

  panel.switchTab('safety');
  assert.equal(elements.tabButtons.get('safety').classList.contains('is-active'), true);
  assert.ok(findByText(elements.ruleListEl, '删除世界书条目'), '权限列表应显示规则标题');
  const revokeBtn = findByText(elements.ruleListEl, '撤销');
  assert.ok(revokeBtn, '规则应有撤销按钮');
  revokeBtn.dispatchEvent('click', {});
  assert.deepEqual(revoked, ['worldbook.delete_entries|worldbook.delete|write']);
  assert.ok(findByText(elements.ruleListEl, '没有已保存的“始终允许”规则。危险操作每次都会重新确认。'), '撤销后应显示空状态');
  console.log('ok - maid settings panel shows recent runs and revocable allow rules');
}

{
  const documentRef = new FakeDocument();
  const resumed = [];
  const panel = createMaidSettingsPanel({
    documentRef,
    settingsStore: { getMaidPrompt: () => '' },
    listRuns: () => [
      {
        id: 'run-cont',
        status: 'failed',
        summary: '已达到本轮执行预算。',
        updatedAt: 1700000002000,
        metadata: { goal: '整理世界书', continuable: true, continueHint: '继续整理' },
      },
      {
        id: 'run-done',
        status: 'succeeded',
        summary: '已完成。',
        updatedAt: 1700000003000,
        metadata: { goal: '打开世界书' },
      },
    ],
    onResumeRun: run => resumed.push(run.id),
    logger: { warn() {} },
  });
  panel.show({ tab: 'activity' });
  const elements = panel.getElements();
  const resumeBtn = findByText(elements.runListEl, '继续');
  assert.ok(resumeBtn, '可继续 run 应有继续按钮');
  const buttons = [];
  const collect = (root) => {
    if (root.textContent === '继续') buttons.push(root);
    (root.children || []).forEach(collect);
  };
  collect(elements.runListEl);
  assert.equal(buttons.length, 1, '不可继续的 run 不应有继续按钮');
  resumeBtn.dispatchEvent('click', {});
  assert.deepEqual(resumed, ['run-cont']);
  assert.equal(panel.isOpen(), false, '点击继续后面板应关闭');
  console.log('ok - maid settings panel resumes continuable runs');
}

{
  const documentRef = new FakeDocument();
  const completed = new Set();
  const started = [];
  const panel = createMaidSettingsPanel({
    documentRef,
    settingsStore: { getMaidPrompt: () => '' },
    guideStore: {
      isTaskDone: taskId => completed.has(taskId),
      listTasks: () => Array.from(completed).map(taskId => ({ taskId })),
    },
    onStartOnboardingFlow: flowId => started.push(flowId),
    logger: { warn() {} },
  });

  panel.show({ tab: 'tasks' });
  const elements = panel.getElements();
  assert.equal(elements.tabButtons.get('tasks').classList.contains('is-active'), true);
  assert.equal(elements.taskListEl.children.length, 4);
  assert.equal(elements.taskProgressEl.textContent, '0/4');
  assert.equal(elements.taskCompletionEl.attributes['aria-hidden'], 'true');
  assert.ok(findByText(elements.taskListEl, '先接 API'), 'first-chat should be locked before setup-api');

  const firstStart = findByText(elements.taskListEl, '开始');
  firstStart.dispatchEvent('click', {});
  assert.deepEqual(started, ['setup-api']);

  completed.add('task-setup-api');
  panel.refresh();
  assert.equal(elements.taskProgressEl.textContent, '1/4');
  assert.ok(findByText(elements.taskListEl, '成就·初次接线'));
  assert.ok(findByText(elements.taskListEl, '先接 API'), 'completed history must not unlock chat after credentials are removed');

  ['task-add-friend', 'task-first-chat', 'task-meet-maid'].forEach(taskId => completed.add(taskId));
  panel.refresh();
  assert.equal(elements.taskProgressEl.textContent, '4/4');
  assert.equal(elements.taskCompletionEl.attributes['aria-hidden'], 'false');

  const configuredPanel = createMaidSettingsPanel({
    documentRef: new FakeDocument(),
    settingsStore: { getMaidPrompt: () => '' },
    guideStore: { isTaskDone: () => false },
    isApiConfigured: () => true,
    logger: { warn() {} },
  });
  configuredPanel.show({ tab: 'tasks' });
  assert.equal(findByText(configuredPanel.getElements().taskListEl, '先接 API'), null);
  console.log('ok - maid settings task tab renders progress, dependency locks, and flow actions');
}

{
  const themeManagerSource = fs.readFileSync(
    new URL('../../src/scripts/ui/theme-manager.js', import.meta.url),
    'utf8',
  );
  const referencedRgbTokens = [...new Set(
    [...maidSettingsSource.matchAll(/var\((--app-[a-z-]+-rgb)[,)]/g)].map(match => match[1]),
  )];
  assert.ok(referencedRgbTokens.includes('--app-task-rgb'), 'task_state 色条应引用 --app-task-rgb');
  for (const token of referencedRgbTokens) {
    assert.ok(
      themeManagerSource.includes(`setCssVar('${token}'`),
      `${token} 在面板 CSS 中被引用，但 theme-manager 未定义（会永远落在 fallback 上）`,
    );
  }
  console.log('ok - maid settings rgb tokens are all defined by theme-manager');
}

{
  // 主配置页提供「单次任务步数上限」输入并接到 settingsStore（源码契约）
  const { readFileSync } = await import('node:fs');
  const panelSource = readFileSync(new URL('../../src/scripts/ui/maid-settings-panel.js', import.meta.url), 'utf8');
  assert.match(panelSource, /data-main-max-steps/);
  assert.match(panelSource, /单次任务步数上限/);
  assert.match(panelSource, /normalizeMaidReactStepLimit\(maxStepsInput\.value\)/);
  assert.match(panelSource, /settingsStore\?\.setMaxReactSteps\?\.\(normalized\)/);
  // 两个女仆任务入口：app.js 内的直接调用，以及 0.7.3 拆出的指令/语音提交运行时
  const stepLimitRead = /maxReactSteps: (?:opts\.maxReactSteps \|\| )?maidSettingsStore\.getMaxReactSteps\?\.\(\)/g;
  const entrySources = ['../../src/scripts/ui/app.js', '../../src/scripts/ui/maid-command-submit-runtime.js']
    .map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
  entrySources.forEach((source, index) => {
    assert.equal(
      (source.match(stepLimitRead) || []).length,
      1,
      `女仆任务入口 ${index + 1} 必须按次读取用户设置的步数上限`,
    );
  });
  console.log('ok - maid settings panel exposes the react step limit and both entries consume it');
}

{
  // 记忆管理：长期记忆可编辑；清空长期记忆 / 清除历史 / 清除归档都先弹确认，取消时不动数据
  const documentRef = new FakeDocument();
  const memories = [{ id: 'm1', kind: 'preference', key: 'presentation.default', content: '旧内容', confidence: 'inferred', status: 'active', tags: [] }];
  const calls = [];
  const confirms = [];
  let confirmAnswer = false;
  const panel = createMaidSettingsPanel({
    documentRef,
    settingsStore: { getMaidPrompt: () => '' },
    semanticMemoryStore: {
      listMemories: () => memories.slice(),
      updateMemoryContent: async (id, content) => { calls.push(['edit', id, content]); memories[0].content = content; return memories[0]; },
      clearMemories: async () => { calls.push(['clearSemantic']); const count = memories.length; memories.length = 0; return count; },
      deleteMemory: async () => true,
      setMemoryStatus: async () => null,
    },
    clearHistoryContext: async () => { calls.push(['clearHistory']); return { turns: 3 }; },
    clearMemoryTable: async () => { calls.push(['clearTable']); return 1; },
    confirmMemoryAction: async (payload) => { confirms.push(payload.title); return confirmAnswer; },
    logger: { warn() {}, debug() {} },
  });
  panel.show({ tab: 'prompt' });
  const elements = panel.getElements();
  panel.switchTab('semanticMemory');
  findByText(elements.semanticMemoryListEl, '编辑').dispatchEvent('click', {});
  const findEditor = (root) => {
    if (root?.classList?.contains?.('maid-memory-edit-input')) return root;
    for (const child of root?.children || []) { const found = findEditor(child); if (found) return found; }
    return null;
  };
  const editor = findEditor(elements.semanticMemoryListEl);
  assert.equal(editor.value, '旧内容');
  assert.equal(findByText(elements.semanticMemoryListEl, '永久删除'), null, 'no delete while editing');
  editor.value = '   ';
  findByText(elements.semanticMemoryListEl, '保存').dispatchEvent('click', {});
  await flushMicrotasks();
  assert.equal(calls.length, 0, 'empty content is not saved');
  editor.value = '新内容';
  findByText(elements.semanticMemoryListEl, '保存').dispatchEvent('click', {});
  await flushMicrotasks();
  assert.deepEqual(calls, [['edit', 'm1', '新内容']]);
  assert.ok(findByText(elements.semanticMemoryListEl, '新内容'));
  assert.equal(elements.statusEl.textContent, '长期记忆已更新');

  const clearAll = findByText(elements.promptPanes.get('semanticMemory'), '清空全部');
  clearAll.dispatchEvent('click', {});
  await flushMicrotasks();
  assert.deepEqual(confirms, ['清空长期记忆']);
  assert.equal(calls.length, 1, 'declined confirmation clears nothing');
  confirmAnswer = true;
  clearAll.dispatchEvent('click', {});
  await flushMicrotasks();
  assert.deepEqual(calls.at(-1), ['clearSemantic']);
  assert.ok(findByText(elements.semanticMemoryListEl, '还没有长期记忆。'));

  findByText(elements.promptPanes.get('historyContext'), '清除历史').dispatchEvent('click', {});
  await flushMicrotasks();
  findByText(elements.promptPanes.get('memoryTable'), '清除归档').dispatchEvent('click', {});
  await flushMicrotasks();
  assert.deepEqual(calls.slice(-2), [['clearHistory'], ['clearTable']]);
  assert.deepEqual(confirms.slice(-2), ['清除女仆历史上下文', '清除轮次归档']);
  assert.equal(elements.statusEl.textContent, '轮次归档已清除');
  console.log('ok - maid memory can be edited and cleared from settings, always behind a confirmation');
}
