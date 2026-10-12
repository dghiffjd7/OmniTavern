import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.window = {
  appBridge: null,
  addEventListener: () => {},
  dispatchEvent: () => {},
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
};

const { PresetPanel } = await import('../../src/scripts/ui/preset-panel.js');

const makePanel = () => {
  const panel = Object.create(PresetPanel.prototype);
  panel.drafts = new Map();
  panel.openaiBlockDrafts = new Map();
  panel.openaiBlockBase = new Map();
  panel.openaiDeletedBlockIds = new Set();
  panel.store = {
    ready: Promise.resolve(),
    getActiveId: type => (type === 'openai' ? 'preset-a' : ''),
    getActive: () => ({ name: 'saved', prompts: [] }),
  };
  return panel;
};

{
  const panel = makePanel();
  const savedSettings = [];
  const savedPrompts = [];
  panel.currentInjectEditor = 'memory_data';
  panel.getInjectOpenAIResolved = () => ({ presetId: 'preset-a', preset: {}, openp: {} });
  panel.getInjectActions = () => ({
    getAgentCenterSettings: () => ({
      profiles: {
        'openai:preset-a': {
          agents: {
            memory_table_agent: {
              settings: {
                dataPosition: 'history_before+system_end',
                dataDepth: 2,
                guidePosition: 'system_end',
                guideDepth: 1,
              },
            },
          },
        },
      },
    }),
    getMemoryAgentPromptConfig: () => ({
      templateId: 'memory-template-a',
      templateName: 'A',
      template: '{{tableData}}',
      wrapper: '<memory>{{tableData}}</memory>',
      position: 'before_chat+history_after',
    }),
    setMemoryAgentSettings: async payload => savedSettings.push(payload),
    setMemoryAgentPromptConfig: async payload => savedPrompts.push(payload),
  });
  const host = { isConnected: true, appendChild: () => {} };
  let save = null;
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({}) };
  try {
    panel.renderMemoryInjectEditor(host, 'memory_data', {
      // 仿真 select：现值在选项表内时取现值，否则空值（与真实 DOM 行为一致）
      mkSelect: (options, value) => ({
        value: options.some(option => String(option.value) === String(value)) ? String(value) : '',
      }),
      mkNumber: value => ({ value: String(value) }),
      mkRow: () => ({}),
      registerSave: onSave => {
        save = onSave;
      },
      note: () => ({ remove: () => {} }),
      mkLabel: () => ({}),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(typeof save, 'function', '异步模板编辑区应完成装配');
    await save();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  assert.equal(savedSettings[0].config.dataPosition, 'history_before+system_end',
    '数据位置不在选项表内时保存必须沿用原值');
  assert.equal(savedPrompts[0].config.position, 'before_chat+history_after',
    '模板位置不在选项表内时保存必须沿用原值');
  console.log('ok - 记忆编辑器保存保留非标准组合位置');
}

{
  const panel = makePanel();
  let saved = null;
  let save = null;
  panel.getInjectOpenAIResolved = () => ({ presetId: 'preset-a', preset: {}, openp: {} });
  panel.getInjectActions = () => ({
    getAgentCenterSettings: () => ({
      profiles: {
        'openai:preset-a': {
          agents: { memory_table_agent: { settings: { guidePosition: 'system_end' } } },
        },
      },
    }),
    setMemoryAgentSettings: async payload => { saved = payload; },
  });
  panel.renderMemoryInjectEditor({ appendChild: () => {} }, 'memory_guide', {
    mkSelect: () => ({ value: '' }),
    mkNumber: value => ({ value: String(value) }),
    mkRow: () => ({}),
    registerSave: onSave => {
      save = onSave;
    },
    note: () => ({}),
    mkLabel: () => ({}),
  });
  await save();
  assert.equal(saved.config.guidePosition, '', '已枚举位置仍应允许用户明确改为“跟随通用设置”');
  console.log('ok - 记忆编辑器保留显式跟随通用设置选项');
}

{
  // legacy 组合 token 现值 + 用户主动改回「跟随通用设置」：注入保值选项后空值恒为主动选择
  const panel = makePanel();
  let saved = null;
  let save = null;
  let posSel = null;
  let selectOptions = null;
  panel.getInjectOpenAIResolved = () => ({ presetId: 'preset-a', preset: {}, openp: {} });
  panel.getInjectActions = () => ({
    getAgentCenterSettings: () => ({
      profiles: {
        'openai:preset-a': {
          agents: { memory_table_agent: { settings: { guidePosition: 'history_before+system_end' } } },
        },
      },
    }),
    setMemoryAgentSettings: async payload => { saved = payload; },
  });
  panel.renderMemoryInjectEditor({ appendChild: () => {} }, 'memory_guide', {
    mkSelect: (options, value) => {
      selectOptions = options;
      posSel = {
        value: options.some(option => String(option.value) === String(value)) ? String(value) : '',
      };
      return posSel;
    },
    mkNumber: value => ({ value: String(value) }),
    mkRow: () => ({}),
    registerSave: onSave => {
      save = onSave;
    },
    note: () => ({}),
    mkLabel: () => ({}),
  });
  assert.equal(posSel.value, 'history_before+system_end', 'legacy 现值应经注入选项直接选中');
  assert.equal(
    selectOptions.some(option => option.value === 'history_before+system_end'),
    true,
    'legacy 现值应作为保值选项出现在下拉中',
  );
  posSel.value = '';
  await save();
  assert.equal(saved.config.guidePosition, '', 'legacy 现值下用户仍可主动改为“跟随通用设置”');
  console.log('ok - 记忆编辑器 legacy 位置可显式改回跟随通用设置');
}

{
  const panel = makePanel();
  panel.openaiBlockBase.set('block', {
    identifier: 'block', name: 'Block', role: 'system', system_prompt: true, content: 'a\r\nb',
  });
  panel.openaiBlockDrafts.set('block', {
    name: 'Block', role: 'system', system_prompt: true, content: 'a\nb',
  });
  assert.equal(panel.isBlockDraftModified('block'), false, '换行格式不应制造空白 diff');
  panel.openaiBlockDrafts.get('block').name = 'Renamed';
  assert.equal(panel.isBlockDraftModified('block'), true, '元数据修改仍需计为未保存');
  assert.equal(panel.isBlockDraftContentModified('block'), false, '元数据修改不应进入正文 diff 分支');
  console.log('ok - 区块元数据与正文 diff 判定分离');
}

{
  const panel = makePanel();
  panel.openaiBlockBase.set('block', {
    identifier: 'block', name: 'Block', role: 'system', system_prompt: true, content: 'saved',
  });
  panel.openaiBlockDrafts.set('block', {
    name: 'Block', role: 'system', system_prompt: true, content: 'draft',
  });
  panel.drafts.set('openai:preset-a', { name: 'saved', prompts: [] });
  assert.equal(panel.countUnsavedChanges(), 1, '同一份区块草稿不得被 Map 与分区快照重复计数');
  console.log('ok - 未保存计数不重复');
}

{
  const panel = makePanel();
  panel.openaiBlockDrafts.set('block', { content: 'draft' });
  panel.openaiDeletedBlockIds.add('deleted');
  panel.openaiBlockDraftsScope = 'openai:preset-a';
  panel.drafts.set('openai:preset-a', { name: 'draft' });
  panel.drafts.set('sysprompt:sys-a', { name: 'keep' });
  panel.discardOpenAIDrafts({ presetId: 'preset-a' });
  assert.equal(panel.drafts.has('openai:preset-a'), false);
  assert.equal(panel.drafts.has('sysprompt:sys-a'), true, '切换生成参数预设不应丢弃其它分类草稿');
  assert.equal(panel.openaiBlockDrafts.size, 0);
  assert.equal(panel.openaiDeletedBlockIds.size, 0);
  console.log('ok - 确认丢弃只清理目标生成参数草稿');
}

{
  const panel = makePanel();
  const statuses = [];
  panel.store.upsert = async () => { throw new Error('write failed'); };
  panel.showStatus = (message, kind) => statuses.push([message, kind]);
  const originalConsoleLog = console.log;
  console.log = () => {};
  let saved = false;
  try {
    saved = await panel.applyBlockContentToStore('block', 'next');
  } finally {
    console.log = originalConsoleLog;
  }
  assert.equal(saved, false);
  assert.deepEqual(statuses, [['write failed', 'error']], '写入失败不得再显示成功状态');

  panel.openaiBlockDrafts.set('block', { content: 'next' });
  panel.applyBlockHunk = () => 'next';
  panel.applyBlockContentToStore = async () => false;
  await panel.acceptBlockHunk('block', 0);
  assert.deepEqual(statuses, [['write failed', 'error']], 'hunk 写入失败不得追加成功提示');
  console.log('ok - hunk 保存失败只报告错误');
}

{
  const panel = makePanel();
  const statuses = [];
  let refreshCount = 0;
  let previewCount = 0;
  panel.runtimeContext = { promptInject: null };
  panel.getInjectSyspromptResolved = () => ({
    presetId: 'sys-a',
    preset: {},
    sysp: { dialogue_enabled: false },
  });
  panel.getInjectSettingsState = () => ({});
  panel.getInjectActions = () => ({
    getAgentCenterSettings: () => ({}),
    setAgentPromptConfig: async () => { throw new Error('write failed'); },
  });
  panel.showStatus = (message, kind) => statuses.push([message, kind]);
  panel.refreshInjectUi = () => { refreshCount += 1; };
  panel.invalidateOrRebuildPreview = () => { previewCount += 1; };

  await panel.showInjectFeatureDialog('dialogue', async () => true);

  assert.deepEqual(statuses, [['注入开关写入失败', 'error']],
    '注入开关写入失败时不得再追加“已启用”成功提示');
  assert.equal(refreshCount, 1, '失败后仍应刷新警示角标');
  assert.equal(previewCount, 1, '失败后仍应重建或失效预览');
  console.log('ok - 注入启用失败只报告错误并保留警示态');
}

{
  const clone = value => JSON.parse(JSON.stringify(value));
  let active = {
    name: 'Preset A',
    temperature: 1,
    prompts: [{
      identifier: 'block', name: 'Block', role: 'system', system_prompt: true, content: 'saved',
    }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'block', enabled: true }] }],
  };
  const writes = [];
  const card = {
    dataset: { identifier: 'block' },
    querySelector: selector => (selector === '.block-enabled' ? { checked: true } : null),
  };
  const panel = makePanel();
  panel.element = { querySelectorAll: () => [] };
  panel.currentSectionId = 'custom';
  panel.detailEditorEl = {
    children: [{}],
    querySelectorAll: selector => (selector === '.openai-block' ? [card] : []),
    querySelector: () => null,
  };
  panel.drafts.set('openai:preset-a', {
    ...clone(active),
    temperature: 0.5,
    prompts: [{ ...clone(active.prompts[0]), content: 'older-snapshot' }],
  });
  panel.openaiBlockDrafts.set('block', {
    name: 'Block', role: 'system', system_prompt: true, content: 'accepted-now',
  });
  panel.openaiBlockBase.set('block', clone(active.prompts[0]));
  panel.store = {
    ready: Promise.resolve(),
    getActiveId: type => (type === 'openai' ? 'preset-a' : ''),
    getActive: () => active,
    upsert: async (_type, { data }) => {
      active = clone(data);
      writes.push(active.prompts[0].content);
    },
    upsertMany: async items => {
      for (const item of items) {
        active = clone(item.data);
        writes.push(active.prompts[0].content);
      }
    },
  };
  panel.getBlockCards = () => [];
  panel.updateUnsavedIndicator = () => {};
  panel.renderAllSections = () => {};
  panel.showStatus = () => {};

  await panel.acceptBlockDraft('block');
  assert.equal(active.prompts[0].content, 'accepted-now');
  assert.equal(
    panel.drafts.get('openai:preset-a').prompts[0].content,
    'accepted-now',
    '立即接受区块后必须同步仍待保存的完整快照',
  );
  await panel.onSave();
  assert.equal(active.prompts[0].content, 'accepted-now', '整体保存不得用旧快照覆盖已接受内容');
  assert.deepEqual(writes, ['accepted-now', 'accepted-now']);
  console.log('ok - 区块接受结果不会被旧分区快照覆盖');
}

{
  const clone = value => JSON.parse(JSON.stringify(value));
  const baseText = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj';
  const draftText = 'a\nB\nc\nd\ne\nf\ng\nh\nI\nj';
  let active = {
    name: 'Preset A',
    prompts: [{
      identifier: 'block', name: 'Block', role: 'system', system_prompt: true, content: baseText,
    }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'block', enabled: true }] }],
  };
  const statuses = [];
  const panel = makePanel();
  panel.openaiBlockDrafts.set('block', {
    name: 'Block', role: 'system', system_prompt: true, content: draftText,
  });
  panel.openaiBlockBase.set('block', clone(active.prompts[0]));
  panel.store = {
    ready: Promise.resolve(),
    getActiveId: type => (type === 'openai' ? 'preset-a' : ''),
    getActive: () => active,
    upsert: async (_type, { data }) => {
      active = clone(data);
      await new Promise(resolve => setTimeout(resolve, 30));
    },
  };
  panel.updateUnsavedIndicator = () => {};
  panel.showStatus = (message, kind) => statuses.push([message, kind]);

  const first = panel.acceptBlockHunk('block', 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  const secondAccepted = await panel.acceptBlockHunk('block', 1);
  await first;

  assert.equal(secondAccepted, false, '持久化期间的旧 hunk 点击必须明确拒绝，不能排队后覆盖新基线');
  assert.equal(active.prompts[0].content, 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj', '第一处已接受修改不得丢失');
  assert.equal(panel.isBlockDraftModified('block'), true, '未处理的第二处修改必须继续保留为草稿');
  assert.ok(statuses.some(([message]) => /正在保存/.test(message)), '被拒绝的快速点击应给出明确状态提示');
  console.log('ok - 快速连续接受不会发生旧基线覆盖');
}

{
  const panel = makePanel();
  const trackedDisabled = {
    disabled: true,
    dataset: { ppMutationWasDisabled: '1' },
  };
  const newlyRenderedDisabled = {
    disabled: true,
    dataset: {},
  };
  panel.element = {
    querySelectorAll: () => [trackedDisabled, newlyRenderedDisabled],
  };
  panel._presetMutationBusy = true;

  panel.setPresetMutationBusy(false);

  assert.equal(trackedDisabled.disabled, true, '解锁应恢复进入队列前已禁用的控件');
  assert.equal(newlyRenderedDisabled.disabled, true, '解锁不得误启用队列期间新渲染且本就禁用的控件');
  console.log('ok - 预设写入解锁保留新旧控件的原始禁用状态');
}

{
  // 推理格式分页的保存只写推理格式草稿，自定义提示词等其他分类的草稿留到底部保存。
  const panel = makePanel();
  const upserted = [];
  panel.store.upsertMany = async items => upserted.push(...items);
  panel.captureCurrentDetailDraft = () => {};
  panel.renderAllSections = () => {};
  panel.updateUnsavedIndicator = () => {};
  panel.showStatus = () => {};
  panel.drafts.set('reasoning:DeepSeek', { name: 'DeepSeek', prefix: '<thinking>' });
  panel.drafts.set('reasoning:Mine', { name: '', prefix: '<t>' });
  panel.drafts.set('openai:preset-a', { name: 'saved', prompts: [{ id: 'x' }] });

  assert.equal(await panel.saveStoreTypeDrafts('reasoning'), true);
  assert.deepEqual(upserted.map(item => `${item.storeType}:${item.presetId}`), ['reasoning:DeepSeek', 'reasoning:Mine']);
  assert.equal(upserted[1].name, 'Mine', '无名草稿用预设 id 作名称');
  assert.deepEqual([...panel.drafts.keys()], ['openai:preset-a'], '其他分类草稿必须保留');
  console.log('ok - 推理格式单独保存不碰其他分类草稿');
}

// 只模拟编辑器所需的 DOM；选择、草稿收集、保存均调用真实 PresetPanel 方法。
const makeReasoningFixture = ({ rpBinding = '' } = {}) => {
  class Element {
    children = [];
    fields = new Map();
    dataset = {};
    value = '';
    set innerHTML(value) {
      this.children = [];
      this.fields.clear();
      for (const match of value.matchAll(/<(?:select|button|input)\b([^>]*)>/g)) {
        const id = match[1].match(/\bid="([^"]+)"/)?.[1];
        const action = match[1].match(/\bdata-reasoning-action="([^"]+)"/)?.[1];
        if (id) this.fields.set(`#${id}`, new Element());
        if (action) this.fields.set(`[data-reasoning-action="${action}"]`, new Element());
        if (/\bdata-app-scope\b/.test(match[1])) this.fields.set('[data-app-scope]', new Element());
      }
    }
    appendChild(child) { this.children.push(child); return child; }
    querySelector(selector) {
      return this.fields.get(selector) || this.children.map(child => child.querySelector(selector)).find(Boolean) || null;
    }
    querySelectorAll() { return []; }
    addEventListener() {}
    dispatchEvent() {}
  }
  globalThis.document = { createElement: () => new Element() };
  const presets = new Map(['a', 'b'].map(id => [id, {
    name: id, prefix: `<${id}>`, suffix: `</${id}>`, separator: '\n', app_scope: 'both',
  }]));
  let activeId = 'a';
  const bindings = { rp: rpBinding, chat: '' };
  const panel = makePanel();
  panel.currentSectionId = 'reasoning';
  panel.element = new Element();
  panel.store = {
    ready: Promise.resolve(),
    list: () => [...presets].map(([id, value]) => ({ id, ...value })),
    getActiveId: () => activeId,
    getActive: () => ({ ...presets.get(activeId) }),
    getPreset: (_type, id) => ({ id, ...presets.get(id) }),
    getModeBindingId: (_type, mode) => bindings[mode],
    getSelectionState: () => ({ builtinActive: { reasoning: 'a' } }),
    loadBundledDefaults: async () => ({ reasoning: { a: { prefix: '<default-a>' }, b: { prefix: '<default-b>' } } }),
    setActive: async (_type, id) => { activeId = id; },
    setModeBinding: async (_type, mode, id) => { bindings[mode] = id; },
    clearModeBinding: async (_type, mode) => { bindings[mode] = ''; },
    upsert: async (_type, { id = 'new', data, name }) => { presets.set(id, { ...data, name }); return id; },
    upsertMany: async items => items.forEach(({ presetId, data }) => presets.set(presetId, { ...data })),
  };
  panel.renderReasoningEditor = preset => {
    const editor = new Element();
    for (const key of ['prefix', 'suffix', 'separator']) {
      const field = new Element();
      field.value = preset[key] || '';
      editor.fields.set(`#reasoning-${key}`, field);
    }
    return editor;
  };
  panel.renderAllSections = () => {
    panel.detailEditorEl = new Element();
    panel.renderSectionEditor(panel.getSectionById('reasoning'), panel.detailEditorEl);
  };
  panel.updateUnsavedIndicator = () => {};
  panel.showStatus = () => {};
  panel.renderAllSections();
  return { panel, presets, bindings, field: selector => panel.detailEditorEl.querySelector(selector) };
};

{
  const previousDocument = globalThis.document;
  const previousPrompt = globalThis.prompt;
  try {
    const { panel, presets, field } = makeReasoningFixture();
    field('#reasoning-prefix').value = '<unsaved>';
    field('#reasoning-chat-select').value = 'b';
    await field('#reasoning-chat-select').onchange();
    assert.equal(field('#reasoning-prefix').value, '<unsaved>', '切换聊天绑定必须保留当前编辑');
    assert.equal(panel.drafts.get('reasoning:a')?.prefix, '<unsaved>');
    assert.equal(presets.get('a').prefix, '<a>', '切换使用位置不应自动保存正文草稿');
    console.log('ok - 切换聊天推理格式保留未保存草稿');

    const bound = makeReasoningFixture({ rpBinding: 'b' });
    assert.equal(bound.field('#reasoning-creative-select').value, 'b');
    assert.equal(bound.field('#reasoning-prefix').value, '<b>', '编辑器必须显示选择器中的模式绑定方案');
    bound.field('#reasoning-prefix').value = '<edited-b>';
    await bound.panel.saveStoreTypeDrafts('reasoning');
    assert.equal(bound.presets.get('b').prefix, '<edited-b>');
    assert.equal(bound.presets.get('a').prefix, '<a>', '保存不得写到另一份全局预设');
    await bound.field('[data-reasoning-action="reset"]').onclick();
    assert.equal(bound.field('#reasoning-prefix').value, '<default-b>', '恢复默认也必须针对显示的方案');
    globalThis.prompt = () => 'renamed-b';
    await bound.panel.onRenameForStoreType('reasoning');
    assert.equal(bound.presets.get('b').name, 'renamed-b');
    assert.equal(bound.presets.get('a').name, 'a');
    console.log('ok - 推理格式显示、保存、恢复默认和重命名使用同一方案');

    globalThis.prompt = () => 'new-reasoning';
    await bound.panel.onNewForStoreType('reasoning');
    assert.equal(bound.bindings.rp, 'new', '已有写作绑定时新建方案也应切换到新方案');
    assert.equal(bound.field('#reasoning-creative-select').value, 'new');
    assert.equal(bound.panel.store.getActiveId('reasoning'), 'new');
    assert.equal(bound.field('#reasoning-prefix').value, '<default-b>');
    console.log('ok - 新建推理格式保持写作选择与编辑目标一致');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousPrompt === undefined) delete globalThis.prompt;
    else globalThis.prompt = previousPrompt;
  }
}
