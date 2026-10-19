import assert from 'node:assert/strict';

import {
  buildAgentCenterProfileView,
  createAgentCenterSettingsStore,
  getAgentCenterGlobalSemanticPromptLibrary,
  lazyMigratePresetProfileToAgentCenterSettings,
  mergeImportedAgentCenterSettings,
  pickAgentCenterProfilesForPresets,
  migratePresetStateToAgentCenterSettings,
  removeAgentCenterGlobalSemanticPromptBlock,
  reorderAgentCenterGlobalSemanticPromptBlocks,
  readAgentCenterSettingsRecency,
  resolveAgentOpenAIPreset,
  resolveAgentSyspromptPreset,
  setAgentCardEnabled,
  setAgentPromptConfig,
  setMemoryAgentSettings,
  upsertAgentCenterGlobalSemanticPromptBlock,
} from '../../src/scripts/storage/agent-center-settings-store.js';
import {
  getLocalizedPromptText,
  setPromptLocale,
} from '../../src/scripts/i18n/prompt-locale.js';

globalThis.localStorage ||= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
const { getCanonicalBuiltinPromptDefaults } = await import('../../src/scripts/storage/preset-store.js');

{
  let mutation = upsertAgentCenterGlobalSemanticPromptBlock({}, {
    id: 'global-a',
    name: 'A',
    enabled: true,
    content: 'semantic A',
    scope: 'chat',
    anchor: 'semantic_header',
  }, { now: () => 100 });
  mutation = upsertAgentCenterGlobalSemanticPromptBlock(mutation.settings, {
    id: 'global-b',
    name: 'B',
    enabled: true,
    content: 'semantic B',
    scope: 'maid',
    anchor: 'before_history',
  }, { now: () => 200 });
  assert.deepEqual(
    getAgentCenterGlobalSemanticPromptLibrary(mutation.settings).blocks.map(block => block.id),
    ['global-a', 'global-b'],
  );
  const reordered = reorderAgentCenterGlobalSemanticPromptBlocks(
    mutation.settings,
    ['global-b', 'global-a'],
  );
  assert.deepEqual(reordered.library.blocks.map(block => block.id), ['global-b', 'global-a']);
  const removed = removeAgentCenterGlobalSemanticPromptBlock(reordered.settings, 'global-a');
  assert.deepEqual(removed.library.blocks.map(block => block.id), ['global-b']);
  console.log('ok - agent center global semantic prompt library stays independent and ordered');
}

{
  const migrated = migratePresetStateToAgentCenterSettings({}, {
    presets: {
      sysprompt: {
        alpha: {
          name: 'Alpha',
          auto_image_prompt_enabled: true,
          auto_image_prompt_rules: 'image rules alpha',
          auto_image_prompt_position: 4,
          auto_image_prompt_depth: 0,
          auto_image_prompt_role: 0,
          summary_enabled: false,
          summary_position: 1,
          summary_rules: 'summary alpha',
        },
        beta: {
          name: 'Beta',
          auto_image_prompt_enabled: false,
          auto_image_prompt_rules: 'image rules beta',
        },
      },
      openai: {
        gen: {
          name: 'Gen',
          memory_data_position: 'history_depth',
          memory_data_depth: 3,
          memory_guide_position: 'before_latest_user',
          memory_guide_depth: 1,
        },
      },
    },
  }, { now: () => 1000 });

  assert.equal(migrated.migrations.presetPromptV1.completed, true);
  assert.equal(migrated.profiles['sysprompt:alpha'].agents.image_director.prompts['auto-image-prompt'].rules, 'image rules alpha');
  assert.equal(migrated.profiles['sysprompt:beta'].agents.image_director.prompts['auto-image-prompt'].enabled, false);
  assert.equal(migrated.profiles['openai:gen'].agents.memory_table_agent.settings.dataPosition, 'history_depth');
  assert.equal(migrated.profiles['openai:gen'].agents.memory_table_agent.settings.dataDepth, 3);
  console.log('ok - agent center settings migrates all sysprompt/openai preset fields');
}

{
  let settings = migratePresetStateToAgentCenterSettings({}, {
    presets: {
      sysprompt: {
        alpha: {
          name: 'Alpha',
          auto_image_prompt_enabled: true,
          auto_image_prompt_rules: 'old image rules',
          auto_image_prompt_position: 4,
          auto_image_prompt_depth: 0,
          auto_image_prompt_role: 0,
        },
      },
      openai: {},
    },
  }, { now: () => 1000 });
  settings = setAgentPromptConfig(settings, {
    profileType: 'sysprompt',
    presetId: 'alpha',
    agentId: 'image_director',
    promptId: 'auto-image-prompt',
    config: {
      enabled: true,
      rules: 'new image rules',
      position: 5,
      depth: 2,
      role: 1,
    },
  }, { now: () => 2000 });
  const resolved = resolveAgentSyspromptPreset(settings, {
    presetId: 'alpha',
    preset: {
      auto_image_prompt_enabled: true,
      auto_image_prompt_rules: 'old image rules',
      auto_image_prompt_position: 4,
      auto_image_prompt_depth: 0,
      auto_image_prompt_role: 0,
    },
  });
  assert.equal(resolved.auto_image_prompt_rules, 'new image rules');
  assert.equal(resolved.auto_image_prompt_position, 5);
  assert.equal(resolved.auto_image_prompt_depth, 2);
  assert.equal(resolved.auto_image_prompt_role, 1);

  const disabled = resolveAgentSyspromptPreset(
    setAgentCardEnabled(settings, 'image_director', false, { now: () => 3000 }),
    {
      presetId: 'alpha',
      preset: {
        auto_image_prompt_enabled: true,
        auto_image_prompt_rules: 'old image rules',
      },
    },
  );
  assert.equal(disabled.auto_image_prompt_enabled, false);
  assert.equal(disabled.auto_image_prompt_rules, 'new image rules');
  console.log('ok - agent center sysprompt resolver prefers new store and respects card disable');
}

{
  const officialPromptDefaults = getCanonicalBuiltinPromptDefaults();
  let settings = migratePresetStateToAgentCenterSettings({}, {
    presets: {
      sysprompt: {
        official: {
          name: 'Official',
          dialogue_enabled: true,
          dialogue_rules: officialPromptDefaults.dialogue_rules,
        },
      },
      openai: {},
    },
  }, { now: () => 1000, officialPromptDefaults });

  setPromptLocale('en');
  const localizedPreset = {
    name: 'Official',
    dialogue_enabled: true,
    dialogue_rules: getLocalizedPromptText('dialogue_rules', officialPromptDefaults.dialogue_rules),
  };
  const resolved = resolveAgentSyspromptPreset(settings, {
    presetId: 'official',
    preset: localizedPreset,
    officialPromptDefaults,
  });
  assert.match(resolved.dialogue_rules, /Roleplay Core/);
  assert.doesNotMatch(resolved.dialogue_rules, /角色扮演核心/);

  const profileView = buildAgentCenterProfileView(settings, {
    syspromptResolved: { presetId: 'official', preset: localizedPreset },
    officialPromptDefaults,
  });
  assert.match(
    profileView.sysprompt.profile.agents.dialogue_agent.prompts.dialogue.rules,
    /Roleplay Core/,
  );

  settings = setAgentPromptConfig(settings, {
    profileType: 'sysprompt',
    presetId: 'official',
    preset: localizedPreset,
    agentId: 'dialogue_agent',
    promptId: 'dialogue',
    config: { rules: localizedPreset.dialogue_rules },
  }, { now: () => 2000, officialPromptDefaults });
  assert.equal(
    settings.profiles['sysprompt:official'].agents.dialogue_agent.prompts.dialogue.rules,
    officialPromptDefaults.dialogue_rules,
    '保存未修改的英文官方提示词时应还原规范默认值',
  );

  settings = setAgentPromptConfig(settings, {
    profileType: 'sysprompt',
    presetId: 'official',
    preset: localizedPreset,
    agentId: 'dialogue_agent',
    promptId: 'dialogue',
    config: { rules: `${localizedPreset.dialogue_rules}\nCustom addition` },
  }, { now: () => 3000, officialPromptDefaults });
  assert.match(
    settings.profiles['sysprompt:official'].agents.dialogue_agent.prompts.dialogue.rules,
    /Custom addition$/,
    '用户编辑后的提示词不得被规范化覆盖',
  );
  setPromptLocale('zh-CN');
  console.log('ok - agent center localizes official prompt copies without changing custom edits');
}

{
  let settings = migratePresetStateToAgentCenterSettings({}, {
    presets: {
      sysprompt: {
        alpha: {
          name: 'Alpha',
          summary_enabled: false,
          summary_position: 1,
          summary_rules: 'keep summary rules',
        },
      },
      openai: {},
    },
  }, { now: () => 1000 });
  settings = setAgentPromptConfig(settings, {
    profileType: 'sysprompt',
    presetId: 'alpha',
    agentId: 'summary_agent',
    promptId: 'summary',
    config: {
      position: 2,
    },
  }, { now: () => 2000 });
  const resolved = resolveAgentSyspromptPreset(settings, {
    presetId: 'alpha',
    preset: {
      summary_enabled: true,
      summary_position: 1,
      summary_rules: 'old fallback',
    },
  });
  assert.equal(resolved.summary_enabled, false);
  assert.equal(resolved.summary_rules, 'keep summary rules');
  assert.equal(resolved.summary_position, 2);
  console.log('ok - agent center prompt config patch preserves existing custom fields');
}

{
  let settings = lazyMigratePresetProfileToAgentCenterSettings({}, {
    profileType: 'openai',
    presetId: 'gen',
    preset: {
      memory_data_position: 'before_latest_user',
      memory_data_depth: 0,
      memory_guide_position: '',
      memory_guide_depth: 0,
    },
  });
  settings = setMemoryAgentSettings(settings, {
    presetId: 'gen',
    preset: {},
    config: {
      dataPosition: 'history_depth',
      dataDepth: 4,
      guidePosition: 'after_latest_user',
      guideDepth: 2,
    },
  });
  const resolved = resolveAgentOpenAIPreset(settings, {
    presetId: 'gen',
    preset: {
      memory_data_position: 'before_latest_user',
      memory_data_depth: 0,
      memory_guide_position: '',
      memory_guide_depth: 0,
    },
  });
  assert.equal(resolved.memory_data_position, 'history_depth');
  assert.equal(resolved.memory_data_depth, 4);
  assert.equal(resolved.memory_guide_position, 'after_latest_user');
  assert.equal(resolved.memory_guide_depth, 2);
  console.log('ok - agent center openai resolver applies memory table settings');
}

{
  const imported = migratePresetStateToAgentCenterSettings({}, {
    presets: {
      sysprompt: {
        oldSysp: {
          name: 'Imported Sysprompt',
          summary_rules: 'imported summary',
        },
      },
      openai: {},
    },
  });
  const merged = mergeImportedAgentCenterSettings({}, imported, {
    presetIdMap: { sysprompt: 'newSysp' },
    now: () => 4000,
  });
  assert.equal(merged.profiles['sysprompt:newSysp'].presetId, 'newSysp');
  assert.equal(merged.profiles['sysprompt:newSysp'].agents.summary_agent.prompts.summary.rules, 'imported summary');
  assert.equal(merged.profiles['sysprompt:oldSysp'], undefined);
  console.log('ok - imported agent center settings remap profile ids');
}

{
  // 体验包带来的只是这个聊天室预设的提示词档：按原预设 ID 对应到新预设；其他预设的档、对方的卡片开关、全局提示词库与迁移记录都不导入
  const local = {
    cards: { image_director: { enabled: false } },
    global: { semanticPromptLibrary: { version: 1, blocks: [{ id: 'mine', name: '我的块', text: '保留', enabled: true }] } },
    migrations: { presetPromptV1: 111 },
  };
  const imported = {
    cards: { image_director: { enabled: true } },
    global: { semanticPromptLibrary: { version: 1, blocks: [] } },
    migrations: { presetPromptV1: 999, somethingElse: 1 },
    profiles: {
      'sysprompt:roomSysp': { profileType: 'sysprompt', presetId: 'roomSysp', agents: { summary_agent: { prompts: { summary: { rules: 'room summary' } } } } },
      'sysprompt:otherSysp': { profileType: 'sysprompt', presetId: 'otherSysp', agents: { summary_agent: { prompts: { summary: { rules: 'other summary' } } } } },
    },
  };
  const merged = mergeImportedAgentCenterSettings(local, imported, {
    presetIdMap: { sysprompt: 'newSysp' },
    sourcePresetIds: { sysprompt: 'roomSysp' },
    now: () => 5000,
  });
  assert.equal(merged.profiles['sysprompt:newSysp'].agents.summary_agent.prompts.summary.rules, 'room summary');
  assert.equal(merged.profiles['sysprompt:otherSysp'].agents.summary_agent.prompts.summary.rules, 'other summary', 'other profiles keep their own preset id instead of collapsing onto the room preset');
  assert.equal(merged.cards.image_director.enabled, false, 'the importer keeps its own card switches');
  assert.deepEqual(merged.global.semanticPromptLibrary.blocks.map(block => block.id), ['mine'], 'the importer keeps its own global prompt library');
  assert.equal(merged.migrations.presetPromptV1, 111);
  assert.equal(merged.migrations.somethingElse, undefined);
  assert.equal(merged.migrations.importedAgentCenterSettingsAt, 5000);

  const ambiguous = mergeImportedAgentCenterSettings({}, imported, { presetIdMap: { sysprompt: 'newSysp' }, now: () => 5000 });
  assert.equal(ambiguous.profiles['sysprompt:newSysp'], undefined, 'an old pack with several profiles of one type is not guessed onto the new preset');
  assert.equal(ambiguous.profiles['sysprompt:roomSysp'].agents.summary_agent.prompts.summary.rules, 'room summary');
  console.log('ok - imported agent center settings map the room preset profile by id and keep local switches and library');
}

{
  const settings = {
    cards: { image_director: { enabled: true } },
    global: { semanticPromptLibrary: { version: 1, blocks: [{ id: 'g', name: 'g', text: 'g', enabled: true }] } },
    profiles: {
      'sysprompt:room': { profileType: 'sysprompt', presetId: 'room', agents: {} },
      'sysprompt:other': { profileType: 'sysprompt', presetId: 'other', agents: {} },
      'openai:roomOai': { profileType: 'openai', presetId: 'roomOai', agents: {} },
    },
  };
  const picked = pickAgentCenterProfilesForPresets(settings, { sysprompt: 'room', openai: 'roomOai' });
  assert.deepEqual(Object.keys(picked.profiles).sort(), ['openai:roomOai', 'sysprompt:room']);
  assert.equal(picked.cards, undefined);
  assert.equal(picked.global, undefined);
  console.log('ok - experience packs export only the room preset profiles');
}

/* 注入整合语义澄清（2026-07-16）：chip 只管预览展示；此前 presetInjectDefaultOffV1
   压掉的私聊/群聊/生图启用位一次性回滚（动态发布 v1 前默认即关闭，不回滚） */
{
  // 带 v1 标记 + 被压掉的启用位 → 回滚恢复 true，动态发布保持 false
  const v1State = migratePresetStateToAgentCenterSettings({
    migrations: { presetPromptV1: { completed: true, migratedAt: 1 }, presetInjectDefaultOffV1: { completed: true, migratedAt: 1 } },
    profiles: {
      'sysprompt:alpha': {
        profileType: 'sysprompt',
        presetId: 'alpha',
        agents: {
          dialogue_agent: { prompts: { dialogue: { enabled: false, rules: 'dialogue rules' } } },
          group_agent: { prompts: { group: { enabled: false, rules: 'group rules' } } },
          moment_agent: { prompts: { moment: { enabled: false, rules: 'moment rules' } } },
          image_director: { prompts: { 'auto-image-prompt': { enabled: false, rules: 'image rules' } } },
        },
      },
    },
  }, { presets: { sysprompt: {}, openai: {} } }, { now: () => 2000 });
  assert.equal(v1State.migrations.presetInjectDefaultOffV1Rollback.completed, true);
  const agents = v1State.profiles['sysprompt:alpha'].agents;
  assert.equal(agents.dialogue_agent.prompts.dialogue.enabled, true);
  assert.equal(agents.group_agent.prompts.group.enabled, true);
  assert.equal(agents.image_director.prompts['auto-image-prompt'].enabled, true);
  assert.equal(agents.moment_agent.prompts.moment.enabled, false, '动态发布不回滚');
  assert.equal(agents.dialogue_agent.prompts.dialogue.rules, 'dialogue rules', '只动启用位不动规则');

  // 回滚只跑一次：之后用户手动停用不得再被翻回
  const disabled = setAgentPromptConfig(v1State, {
    profileType: 'sysprompt',
    presetId: 'alpha',
    agentId: 'dialogue_agent',
    promptId: 'dialogue',
    config: { enabled: false },
  }, { now: () => 3000 });
  const reMigrated = migratePresetStateToAgentCenterSettings(disabled, { presets: { sysprompt: {}, openai: {} } }, { now: () => 4000 });
  assert.equal(reMigrated.profiles['sysprompt:alpha'].agents.dialogue_agent.prompts.dialogue.enabled, false);
  console.log('ok - 注入项启用位一次性回滚（尊重后续手动停用）');
}

{
  // 无 v1 标记（新用户）→ 不产生回滚动作也不误改；种子默认全部 true
  const fresh = migratePresetStateToAgentCenterSettings({}, {
    presets: { sysprompt: { alpha: { name: 'Alpha' } }, openai: {} },
  }, { now: () => 1000 });
  assert.equal(fresh.migrations.presetInjectDefaultOffV1Rollback, undefined, 'v1 未发生则无需回滚标记');
  const seeded = lazyMigratePresetProfileToAgentCenterSettings({}, {
    profileType: 'sysprompt',
    presetId: 'fresh',
    preset: { name: 'Fresh' },
    now: () => 1000,
  });
  const agents = seeded.profiles['sysprompt:fresh'].agents;
  assert.equal(agents.dialogue_agent.prompts.dialogue.enabled, true);
  assert.equal(agents.group_agent.prompts.group.enabled, true);
  assert.equal(agents.image_director.prompts['auto-image-prompt'].enabled, true);
  console.log('ok - 新用户无回滚动作、种子默认启用');
}

{
  // 旧版导出可能只有 default-off v1 标记、没有本机已经执行过的 rollback 标记。
  // 导入不得把这段历史迁移重新放大到本机全部 profile。
  const current = {
    migrations: {
      presetPromptV1: { completed: true, migratedAt: 10 },
    },
    profiles: {
      'sysprompt:local': {
        profileType: 'sysprompt',
        presetId: 'local',
        agents: {
          dialogue_agent: { prompts: { dialogue: { enabled: false, rules: '本机手动停用' } } },
        },
      },
    },
  };
  const imported = {
    migrations: {
      presetPromptV1: { completed: true, migratedAt: 1 },
      presetInjectDefaultOffV1: { completed: true, migratedAt: 1 },
    },
    profiles: {
      'sysprompt:legacy': {
        profileType: 'sysprompt',
        presetId: 'legacy',
        agents: {
          group_agent: { prompts: { group: { enabled: false, rules: '旧版导出状态' } } },
        },
      },
    },
  };
  const merged = mergeImportedAgentCenterSettings(current, imported, { now: () => 5000 });
  assert.equal(
    merged.migrations.presetInjectDefaultOffV1Rollback?.completed,
    true,
    '导入旧版 default-off 标记时应同时写入 rollback 屏障',
  );
  const migrated = migratePresetStateToAgentCenterSettings(
    merged,
    { presets: { sysprompt: {}, openai: {} } },
    { now: () => 6000 },
  );
  assert.equal(
    migrated.profiles['sysprompt:local'].agents.dialogue_agent.prompts.dialogue.enabled,
    false,
    '导入后不得把本机手动停用翻回启用',
  );
  assert.equal(
    migrated.profiles['sysprompt:legacy'].agents.group_agent.prompts.group.enabled,
    false,
    '导入内容本身也应按导出值保留',
  );
  console.log('ok - 旧版设置导入不会放大 default-off 回滚迁移');
}

{
  // hydrate 新者优先：KV 盘态比本地旧（上次退出 KV 写失败）时不得回滚较新的本地保存
  const newerLocal = setAgentPromptConfig({}, {
    profileType: 'sysprompt',
    presetId: 'p1',
    agentId: 'dialogue_agent',
    promptId: 'dialogue',
    config: { depth: 7 },
    preset: { dialogue_enabled: true, dialogue_depth: 1 },
  }, { now: () => 2_000 });
  const olderDisk = setAgentPromptConfig({}, {
    profileType: 'sysprompt',
    presetId: 'p1',
    agentId: 'dialogue_agent',
    promptId: 'dialogue',
    config: { depth: 1 },
    preset: { dialogue_enabled: true, dialogue_depth: 1 },
  }, { now: () => 1_000 });
  assert.ok(readAgentCenterSettingsRecency(newerLocal) > readAgentCenterSettingsRecency(olderDisk));

  const makeStorage = (initial = null) => {
    const backing = new Map();
    if (initial) backing.set('agent_center_settings_v1', JSON.stringify(initial));
    return {
      getItem: key => (backing.has(key) ? backing.get(key) : null),
      setItem: (key, value) => backing.set(key, String(value)),
      removeItem: key => backing.delete(key),
      backing,
    };
  };

  const readDepth = settings => (
    settings?.profiles?.['sysprompt:p1']?.agents?.dialogue_agent?.prompts?.dialogue?.depth ?? null
  );

  const staleKvStore = createAgentCenterSettingsStore({
    storage: makeStorage(newerLocal),
    loadKv: async () => JSON.parse(JSON.stringify(olderDisk)),
    saveKv: async () => true,
  });
  const hydratedStale = await staleKvStore.hydrate();
  assert.equal(readDepth(hydratedStale), 7, '旧盘态不得覆盖较新的本地保存');

  const freshKvStore = createAgentCenterSettingsStore({
    storage: makeStorage(olderDisk),
    loadKv: async () => JSON.parse(JSON.stringify(newerLocal)),
    saveKv: async () => true,
  });
  const hydratedFresh = await freshKvStore.hydrate();
  assert.equal(readDepth(hydratedFresh), 7, '较新的盘态照常采用');
  console.log('ok - hydrate keeps the newer of local vs KV agent-center settings');
}
