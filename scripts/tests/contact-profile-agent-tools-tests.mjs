import assert from 'node:assert/strict';

import { createContactProfileAgentTools } from '../../src/scripts/agent/tools/contact-profile-tools.js';
import { createAgentToolRegistry, validateAgentToolArguments } from '../../src/scripts/agent/agent-tool-registry.js';

{
  const savedProfiles = new Map([
    ['alice', {
      contactId: 'alice',
      displayName: 'Alice',
      trigger_keywords: ['tea'],
    }],
  ]);
  const tools = createContactProfileAgentTools({
    contactProfileStore: {
      getProfile: contactId => savedProfiles.get(contactId) || null,
      listProfiles: () => Array.from(savedProfiles.values()),
      upsertProfile: (profile) => {
        const saved = {
          ...profile,
          contactId: profile.contactId || profile.id,
        };
        savedProfiles.set(saved.contactId, saved);
        return saved;
      },
    },
  });
  assert.deepEqual(tools.map(tool => tool.name), [
    'contact_profile.read',
    'contact_profile.get',
    'contact_profile.list',
    'contact_profile.upsert',
  ]);

  const read = await tools[0].execute({ contactId: 'alice' });
  assert.equal(read.found, true);
  assert.equal(read.profile.displayName, 'Alice');
  assert.equal(tools[0].capabilities.modelContext, 'none');

  const got = await tools[1].execute({ contactId: 'alice' });
  assert.equal(got.found, true);
  assert.equal(got.profile.displayName, 'Alice');
  assert.equal(tools[1].capabilities.modelContext, 'allowlist');

  const listed = await tools[2].execute({ limit: 1 });
  assert.equal(listed.count, 1);
  assert.equal(listed.profiles.length, 1);

  const upserted = await tools[3].execute({
    profile: {
      contactId: 'bob',
      displayName: 'Bob',
      trigger_keywords: ['exam'],
    },
  });
  assert.equal(upserted.saved, true);
  assert.equal(upserted.contactId, 'bob');
  assert.equal(savedProfiles.get('bob').displayName, 'Bob');
  console.log('ok - contact profile agent tools read get list and upsert store profiles');
}

{
  const [readTool] = createContactProfileAgentTools();
  await assert.rejects(
    () => readTool.execute({ contactId: 'missing' }),
    /contact profile store not available/,
  );
  console.log('ok - contact profile agent tools require a store dependency');
}

{
  let revision = 1;
  let profile = {
    contactId: 'alice',
    displayName: 'Base Alice',
  };
  const store = {
    scopeId: 'scope-a',
    getProfileSnapshot: contactId => ({
      contactId,
      scopeId: 'scope-a',
      scopeToken: 0,
      exists: Boolean(profile),
      revision,
      profile: profile ? { ...profile } : null,
    }),
    upsertProfileIfUnchanged: (nextProfile, expected = {}) => {
      if (expected.revision !== revision) {
        return {
          ok: false,
          saved: false,
          conflict: true,
          reason: 'profile_changed_during_operation',
        };
      }
      revision += 1;
      profile = { ...nextProfile };
      return { ok: true, saved: true, profile: { ...profile } };
    },
    upsertProfile: (nextProfile) => {
      revision += 1;
      profile = { ...nextProfile };
      return { ...profile };
    },
  };
  const upsertTool = createContactProfileAgentTools({ contactProfileStore: store })
    .find(tool => tool.name === 'contact_profile.upsert');
  const args = {
    profile: {
      contactId: 'alice',
      displayName: 'Maid Alice',
    },
  };

  const preflight = await upsertTool.safety.preflight(args);
  assert.equal(preflight.requiresConfirmation, true);
  store.upsertProfile({ contactId: 'alice', displayName: 'User Alice' });
  const result = await upsertTool.execute(args);

  assert.equal(result.saved, false);
  assert.equal(result.conflict, true);
  assert.equal(result.reason, 'profile_changed_during_operation');
  assert.equal(profile.displayName, 'User Alice');
  console.log('ok - contact profile upsert confirmation snapshot rejects a later user edit');
}

{
  const localState = new Map();
  globalThis.localStorage = {
    getItem: key => localState.get(String(key)) ?? null,
    setItem: (key, value) => localState.set(String(key), String(value)),
    removeItem: key => localState.delete(String(key)),
  };
  globalThis.__TAURI_INVOKE__ = async command => (command === 'load_kv' ? null : true);
  const { ContactProfileStore } = await import('../../src/scripts/storage/contact-profile-store.js');
  const store = new ContactProfileStore({ scopeId: 'b01-profile-schema' });
  await store.ready;
  const tools = createContactProfileAgentTools({ contactProfileStore: store });
  const write = tools.find(tool => tool.name === 'contact_profile.upsert');
  const registry = createAgentToolRegistry({
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { warn() {} },
  });
  registry.registerMany(tools);
  const args = {
    profile: {
      contactId: 'session-created-chinatsu',
      displayName: '千夏',
      stable_traits: ['18岁', '图书管理员', '性格安静', '喜欢推理小说'].map(label => ({ label, sourceRefs: ['user_request'] })),
      sourceRefs: ['user_request'],
    },
  };
  assert.equal(validateAgentToolArguments(args, write.schema).ok, true);
  assert.equal(validateAgentToolArguments({ profile: { displayName: '千夏' } }, write.schema).ok, false);
  assert.equal(validateAgentToolArguments({ profile: { contactId: args.profile.contactId, age: 18 } }, write.schema).ok, false);

  const denied = await registry.executeTool(write.name, args, {
    requestToolConfirmation: async () => ({ decision: 'deny' }),
  });
  assert.equal(denied.result.saved, false);
  assert.equal(store.getProfile(args.profile.contactId), null);

  const approvals = [];
  const saved = await registry.executeTool(write.name, args, {
    requestToolConfirmation: async request => {
      approvals.push(request);
      return { decision: 'allow' };
    },
  });
  assert.equal(saved.result.saved, true);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].kind, 'contact_profile.upsert');
  assert.equal(approvals[0].argsPreview.contactId, args.profile.contactId);
  const read = await registry.executeTool('contact_profile.read', { contactId: args.profile.contactId });
  assert.equal(read.result.profile.scopeId, 'b01-profile-schema');
  assert.deepEqual(read.result.profile.stable_traits.map(item => item.label), ['18岁', '图书管理员', '性格安静', '喜欢推理小说']);
  assert.equal(validateAgentToolArguments({ profile: read.result.profile }, write.schema).ok, true);
  await store.whenPersisted();
  console.log('ok - complete contact traits survive the real store schema and writes still require target confirmation');
}
