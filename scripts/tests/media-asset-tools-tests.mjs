import assert from 'node:assert/strict';

import {
  AGENT_PERMISSION_DECISIONS,
  createAgentPermissionEvaluator,
} from '../../src/scripts/agent/agent-permissions.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import {
  createMaidMediaAssetTools,
  createPreparedImageCache,
} from '../../src/scripts/agent/tools/media-asset-tools.js';

const getTool = (tools, name) => tools.find(tool => tool.name === name);

const attachment = {
  id: 'img-1',
  kind: 'image',
  url: 'data:image/png;base64,AAAA',
  name: 'portrait.png',
  mime: 'image/png',
  size: 4,
};

{
  // A real 1x1 PNG represents providers returning bytes with automatic size,
  // as the captured BytePlus response did. No preset dimensions are available.
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const args = { prompt: '小雪，头像', subject: '小雪', target: '小雪', purpose: 'avatar',
    appearance: '黑发', outfit: '白色衬衫', style: '动漫', targetAspectRatio: '1:1' };
  const make = result => getTool(createMaidMediaAssetTools({
    generateImageAttachment: async () => result,
  }), 'media.generate_image');
  const automatic = await make({ dataUrl, mime: 'image/png' }).execute(args);
  assert.equal(automatic.ok, true, 'automatic sizing must verify the returned image bytes');
  const mismatch = await make({ dataUrl, width: 2, height: 1,
    generationContext: { width: 2, height: 1 } }).execute({ ...args, targetAspectRatio: '2:1' });
  assert.equal(mismatch.reason, 'visual_aspect_mismatch', 'actual image dimensions override configured or claimed dimensions');
  const unknown = await make({ dataUrl: 'data:image/png;base64,AAAA',
    generationContext: { width: 1024, height: 1024 } }).execute(args);
  assert.equal(unknown.reason, 'visual_dimensions_unverified', 'a preset cannot stand in for output dimensions');
  console.log('ok - generated image dimensions come from output bytes, not the preset');
}

{
  const cache = createPreparedImageCache({ createId: () => 'prepared-1' });
  const tools = createMaidMediaAssetTools({
    preparedImageCache: cache,
    prepareImage: async ({ dataUrl, purpose }) => ({
      dataUrl: `${dataUrl}-${purpose}`,
      width: purpose === 'avatar' ? 256 : 1200,
      height: purpose === 'avatar' ? 256 : 800,
      mime: purpose === 'avatar' ? 'image/webp' : 'image/jpeg',
      bytes: 1234,
      transformed: true,
    }),
  });
  const result = await getTool(tools, 'media.prepare_image').execute(
    { purpose: 'avatar', attachmentId: 'img-1' },
    { maidAttachments: [attachment] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.image.preparedImageId, 'prepared-1');
  assert.equal(result.image.width, 256);
  assert.equal(cache.get('prepared-1').dataUrl, 'data:image/png;base64,AAAA-avatar');
  console.log('ok - media asset tool prepares maid image attachments into cache');
}

{
  const personas = new Map([
    ['p1', { id: 'p1', name: '角色A', avatar: '' }],
  ]);
  const cache = createPreparedImageCache({ createId: () => 'prepared-avatar' });
  const tools = createMaidMediaAssetTools({
    preparedImageCache: cache,
    personaStore: {
      getAll: () => Array.from(personas.values()),
      get: id => personas.get(id) || null,
      getActive: () => personas.get('p1'),
      update: async (id, patch) => {
        const next = { ...personas.get(id), ...patch };
        personas.set(id, next);
        return next;
      },
    },
    prepareImage: async ({ purpose }) => ({
      dataUrl: `data:image/webp;base64,${purpose}`,
      width: 256,
      height: 256,
      mime: 'image/webp',
      bytes: 100,
      transformed: true,
    }),
  });
  const result = await getTool(tools, 'persona.set_avatar').execute(
    { target: '角色A' },
    { maidAttachments: [attachment] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.target.id, 'p1');
  assert.equal(personas.get('p1').avatar, 'data:image/webp;base64,avatar');
  console.log('ok - media asset tool sets character card avatar from uploaded image');
}

{
  const personas = new Map([
    ['p1', { id: 'p1', name: '角色A', avatar: 'old-avatar' }],
  ]);
  let prepared = 0;
  let confirmed = 0;
  const tools = createMaidMediaAssetTools({
    personaStore: {
      getAll: () => Array.from(personas.values()),
      get: id => personas.get(id) || null,
      getActive: () => personas.get('p1'),
      update: async (id, patch) => {
        const next = { ...personas.get(id), ...patch };
        personas.set(id, next);
        return next;
      },
    },
    confirmDestructiveWrite: async () => {
      confirmed += 1;
      return false;
    },
    prepareImage: async () => {
      prepared += 1;
      return {
        dataUrl: 'new-avatar',
        width: 256,
        height: 256,
        mime: 'image/webp',
        bytes: 100,
        transformed: true,
      };
    },
  });
  const result = await getTool(tools, 'persona.set_avatar').execute(
    { target: '角色A' },
    { maidAttachments: [attachment] },
  );
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'destructive_write_cancelled');
  assert.equal(confirmed, 1);
  assert.equal(prepared, 0);
  assert.equal(personas.get('p1').avatar, 'old-avatar');
  console.log('ok - media asset tool requires confirmation before replacing character avatar');
}

{
  const personas = new Map([
    ['p1', { id: 'p1', name: '角色A', avatar: 'old-avatar' }],
  ]);
  let prepared = 0;
  let confirmations = 0;
  const tools = createMaidMediaAssetTools({
    personaStore: {
      getAll: () => Array.from(personas.values()),
      get: id => personas.get(id) || null,
      getActive: () => personas.get('p1'),
      update: async (id, patch) => {
        const next = { ...personas.get(id), ...patch };
        personas.set(id, next);
        return next;
      },
    },
    confirmDestructiveWrite: async () => {
      throw new Error('tool-local confirmation should not run after registry safety skip');
    },
    prepareImage: async () => {
      prepared += 1;
      return {
        dataUrl: 'new-avatar',
        width: 256,
        height: 256,
        mime: 'image/webp',
        bytes: 100,
        transformed: true,
      };
    },
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn: () => {} },
  });
  registry.registerMany(tools);
  const result = await registry.executeTool('persona.set_avatar', { target: '角色A' }, {
    maidAttachments: [attachment],
    requestToolConfirmation: request => {
      confirmations += 1;
      assert.equal(request.kind, 'persona.avatar.replace');
      return false;
    },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.result.skipped, true);
  assert.equal(result.result.reason, 'destructive_write_cancelled');
  assert.equal(confirmations, 1);
  assert.equal(prepared, 0);
  assert.equal(personas.get('p1').avatar, 'old-avatar');
  console.log('ok - media asset tool uses registry safety skip before replacing character avatar');
}

{
  const contacts = new Map([
    ['room-1', { id: 'room-1', name: '聊天室A', avatar: '' }],
  ]);
  const settings = new Map([
    ['room-1', { bubbleColor: '#fff' }],
  ]);
  const savedPayloads = [];
  const applied = [];
  const refreshed = [];
  const tools = createMaidMediaAssetTools({
    contactsStore: {
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
    },
    chatStore: {
      getSessionSettings: id => settings.get(id) || {},
      setSessionSettings: (id, next) => settings.set(id, next),
    },
    getCurrentSessionId: () => 'room-1',
    saveWallpaper: async payload => {
      savedPayloads.push(payload);
      return { path: `wallpapers/${payload.sessionId}/wallpaper.jpg`, bytes: 1000 };
    },
    applyChatSettings: async (id, next) => applied.push([id, next]),
    refreshChatAndContacts: async meta => refreshed.push(meta),
    prepareImage: async () => ({
      dataUrl: 'data:image/jpeg;base64,WALLPAPER',
      width: 1600,
      height: 900,
      mime: 'image/jpeg',
      bytes: 900,
      transformed: true,
    }),
    now: () => 1000,
  });
  const result = await getTool(tools, 'session.set_wallpaper').execute(
    { target: '聊天室A', opacity: 0.8 },
    { maidAttachments: [attachment] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.persisted, true);
  assert.equal(settings.get('room-1').wallpaper.path, 'wallpapers/room-1/wallpaper.jpg');
  assert.equal(settings.get('room-1').wallpaper.opacity, 0.8);
  assert.equal(savedPayloads[0].sessionId, 'room-1');
  assert.equal(applied[0][0], 'room-1');
  assert.equal(refreshed[0].reason, 'maid_session_wallpaper');
  console.log('ok - media asset tool sets chat wallpaper and refreshes session state');
}

{
  const contacts = new Map([
    ['room-1', { id: 'room-1', name: '聊天室A', avatar: '' }],
  ]);
  const settings = new Map([
    ['room-1', { wallpaper: { path: 'wallpapers/room-1/old.jpg' } }],
  ]);
  let saved = 0;
  let prepared = 0;
  let confirmed = 0;
  const tools = createMaidMediaAssetTools({
    contactsStore: {
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
    },
    chatStore: {
      getSessionSettings: id => settings.get(id) || {},
      setSessionSettings: (id, next) => settings.set(id, next),
    },
    getCurrentSessionId: () => 'room-1',
    confirmDestructiveWrite: async () => {
      confirmed += 1;
      return false;
    },
    saveWallpaper: async () => {
      saved += 1;
      return { path: 'wallpapers/room-1/new.jpg' };
    },
    prepareImage: async () => {
      prepared += 1;
      return {
        dataUrl: 'data:image/jpeg;base64,WALLPAPER',
        width: 1600,
        height: 900,
        mime: 'image/jpeg',
        bytes: 900,
        transformed: true,
      };
    },
  });
  const result = await getTool(tools, 'session.set_wallpaper').execute(
    { target: '聊天室A' },
    { maidAttachments: [attachment] },
  );
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'destructive_write_cancelled');
  assert.equal(confirmed, 1);
  assert.equal(prepared, 0);
  assert.equal(saved, 0);
  assert.equal(settings.get('room-1').wallpaper.path, 'wallpapers/room-1/old.jpg');
  console.log('ok - media asset tool requires confirmation before replacing chat wallpaper');
}

{
  const { createMaidMediaAssetTools } = await import('../../src/scripts/agent/tools/media-asset-tools.js');
  const tools = createMaidMediaAssetTools({
    fetchRemoteImage: async (url) => {
      assert.equal(url, 'https://img.example.com/tifa.jpg');
      return { dataUrl: 'data:image/jpeg;base64,QUJD', mime: 'image/jpeg', bytes: 3 };
    },
    prepareImage: async ({ dataUrl }) => ({ dataUrl, mime: 'image/webp', bytes: 3, width: 64, height: 64 }),
    now: () => 42,
  });
  const fetchTool = tools.find(t => t.name === 'media.fetch_image');
  const fetched = await fetchTool.execute({ url: 'https://img.example.com/tifa.jpg' });
  assert.equal(fetched.ok, true);
  assert.match(fetched.attachmentId, /^fetched-42-1$/);

  // 下载图可被 prepare 工具经 attachmentId 取用（无本次输入附件）。
  const prepared = await tools.find(t => t.name === 'media.prepare_image')
    .execute({ attachmentId: fetched.attachmentId, purpose: 'avatar' }, { maidAttachments: [] });
  assert.equal(prepared.ok, true);
  console.log('ok - media.fetch_image 下载入池且 prepare 可经 attachmentId 取用');
}

{
  const { createMaidMediaAssetTools } = await import('../../src/scripts/agent/tools/media-asset-tools.js');
  const tools = createMaidMediaAssetTools({
    fetchRemoteImage: async () => ({ dataUrl: 'data:text/html;base64,QUJD', mime: 'text/html', bytes: 3 }),
  });
  const fetchTool = tools.find(t => t.name === 'media.fetch_image');
  const notImage = await fetchTool.execute({ url: 'https://example.com/page' });
  assert.equal(notImage.ok, false);
  assert.equal(notImage.reason, 'not_an_image');

  const badUrl = await fetchTool.execute({ url: 'file:///etc/passwd' });
  assert.equal(badUrl.ok, false);
  assert.equal(badUrl.reason, 'invalid_image_url');

  const bare = createMaidMediaAssetTools({});
  const unavailable = await bare.find(t => t.name === 'media.fetch_image').execute({ url: 'https://x.com/a.jpg' });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, 'image_fetch_unavailable');
  console.log('ok - media.fetch_image 拦截非图片/非法协议/无通道');
}

{
  const contacts = new Map([
    ['room-generated', { id: 'room-generated', name: '生图壁纸房', avatar: '' }],
  ]);
  const settings = new Map();
  const generatedCalls = [];
  const tools = createMaidMediaAssetTools({
    contactsStore: {
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
    },
    chatStore: {
      getSessionSettings: id => settings.get(id) || {},
      setSessionSettings: (id, next) => settings.set(id, next),
    },
    getCurrentSessionId: () => 'room-generated',
    getImageGenerationContext: async () => ({
      provider: 'novelai',
      model: 'nai-diffusion-4-full',
      promptDialect: 'nai_tags',
      promptLanguage: 'en',
      width: 1344,
      height: 768,
    }),
    generateImageAttachment: async payload => {
      generatedCalls.push(payload);
      return {
        dataUrl: 'data:image/png;base64,R0VORVJBVEVE',
        mime: 'image/png',
        bytes: 9,
        width: 1344,
        height: 768,
        name: 'generated-wallpaper.png',
        generationContext: {
          profileId: 'image-profile-1',
          profileName: 'NAI 动漫',
          provider: 'novelai',
          model: 'nai-diffusion-4-full',
          presetId: 'wide',
          presetName: '横向壁纸',
          promptDialect: 'nai_tags',
          promptLanguage: 'en',
          width: 1344,
          height: 768,
          negativePromptSupported: true,
          apiKey: 'must-not-leak',
        },
      };
    },
    prepareImage: async ({ dataUrl }) => ({
      dataUrl,
      width: 1280,
      height: 720,
      mime: 'image/jpeg',
      bytes: 1200,
      transformed: true,
    }),
    now: () => 88,
  });

  const generated = await getTool(tools, 'media.generate_image').execute({
    prompt: 'moonlit_forest, night, anime_background',
    negativePrompt: 'text, watermark',
    subject: '月光森林',
    subjectAliases: ['moonlit_forest'],
    target: '生图壁纸房',
    purpose: 'wallpaper',
    appearance: 'moonlit forest, deep blue night',
    outfit: 'not_applicable',
    style: 'anime background, detailed',
    targetAspectRatio: '16:9',
  }, {
    runId: 'maid-run-1',
    maidVisualSpecLedger: { version: 'maid-visual-spec-v1', specs: {} },
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.attachmentId, 'generated-88-1');
  assert.match(generatedCalls[0].prompt, /moonlit_forest/);
  assert.match(generatedCalls[0].prompt, /anime background/);
  assert.equal(generatedCalls[0].negativePrompt, 'text, watermark');
  assert.equal(generated.generationContext.provider, 'novelai');
  assert.equal(generated.generationContext.promptDialect, 'nai_tags');
  assert.equal(generated.generationContext.width, 1344);
  assert.equal(generated.visualSpec.target, '生图壁纸房');
  assert.equal(generated.visualSpec.purpose, 'wallpaper');
  assert.equal('apiKey' in generated.generationContext, false);

  const wallpaper = await getTool(tools, 'session.set_wallpaper').execute({
    target: '生图壁纸房',
    attachmentId: generated.attachmentId,
  });
  assert.equal(wallpaper.ok, true);
  assert.equal(settings.get('room-generated').wallpaper.url, 'data:image/png;base64,R0VORVJBVEVE');
  console.log('ok - maid can generate an image attachment and set it as a chat wallpaper');
}

{
  const generatedCalls = [];
  const sharedContext = {
    maidVisualSpecLedger: { version: 'maid-visual-spec-v1', specs: {} },
  };
  const tools = createMaidMediaAssetTools({
    getImageGenerationContext: async () => ({
      provider: 'novelai',
      promptDialect: 'nai_tags',
      width: 1024,
      height: 1024,
    }),
    generateImageAttachment: async payload => {
      generatedCalls.push(payload);
      return {
        dataUrl: 'data:image/png;base64,AAAA',
        mime: 'image/png',
        bytes: 4,
        width: 1024,
        height: 1024,
        generationContext: {
          provider: 'novelai',
          promptDialect: 'nai_tags',
          width: 1024,
          height: 1024,
        },
      };
    },
    now: () => 99,
  });
  const args = {
    prompt: 'yukinoshita_yukino, long black hair, school uniform, anime style',
    subject: '雪之下雪乃',
    subjectAliases: ['yukinoshita_yukino'],
    target: '雪之下雪乃',
    purpose: 'avatar',
    appearance: 'long black hair, blue eyes',
    outfit: 'sobu high school uniform',
    style: 'anime style, clean lineart',
    targetAspectRatio: '1:1',
  };
  const first = await getTool(tools, 'media.generate_image').execute(args, sharedContext);
  assert.equal(first.ok, true);
  const conflict = await getTool(tools, 'media.generate_image').execute({
    ...args,
    style: 'photorealistic',
  }, sharedContext);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, 'visual_spec_conflict');
  assert.equal(generatedCalls.length, 1, '冲突规格必须在付费生图前拦截');

  const wrongAspect = await getTool(tools, 'media.generate_image').execute({
    ...args,
    subject: '由比滨结衣',
    subjectAliases: ['yuigahama_yui'],
    prompt: 'yuigahama_yui, anime style',
    target: '由比滨结衣',
    targetAspectRatio: '16:9',
  }, sharedContext);
  assert.equal(wrongAspect.ok, false);
  assert.equal(wrongAspect.reason, 'visual_aspect_mismatch');
  assert.equal(generatedCalls.length, 1, '宽高比不符必须在付费生图前拦截');
  console.log('ok - media generation enforces frozen design and aspect before paid calls');
}

{
  const personas = new Map([
    ['p1', { id: 'p1', name: '角色A', avatar: 'old-a', created: 1 }],
    ['p2', { id: 'p2', name: '角色B', avatar: 'old-b', created: 2 }],
  ]);
  let activeId = 'p1';
  const tools = createMaidMediaAssetTools({
    personaStore: {
      getAll: () => Array.from(personas.values()),
      get: id => personas.get(id) || null,
      getActive: () => personas.get(activeId),
      update: async (id, patch) => {
        const next = { ...personas.get(id), ...patch };
        personas.set(id, next);
        return next;
      },
    },
    prepareImage: async () => ({
      dataUrl: 'maid-avatar',
      width: 256,
      height: 256,
      mime: 'image/webp',
      bytes: 100,
    }),
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn() {} },
  });
  registry.registerMany(tools);
  const output = await registry.executeTool('persona.set_avatar', {}, {
    maidAttachments: [attachment],
    requestToolConfirmation: () => {
      activeId = 'p2';
      return true;
    },
  });
  assert.equal(output.result.ok, true);
  assert.equal(personas.get('p1').avatar, 'maid-avatar', '确认时固定的角色必须保持为写入目标');
  assert.equal(personas.get('p2').avatar, 'old-b', '切换后的当前角色不得被误写');
  console.log('ok - avatar confirmation pins the original active target');
}

{
  const personas = new Map([
    ['p1', { id: 'p1', name: '角色A', avatar: 'old-avatar', created: 1 }],
  ]);
  const tools = createMaidMediaAssetTools({
    personaStore: {
      getAll: () => Array.from(personas.values()),
      get: id => personas.get(id) || null,
      getActive: () => personas.get('p1'),
      update: async (id, patch) => {
        const next = { ...personas.get(id), ...patch };
        personas.set(id, next);
        return next;
      },
    },
    confirmDestructiveWrite: async () => true,
    prepareImage: async () => {
      personas.set('p1', { ...personas.get('p1'), avatar: 'user-avatar' });
      return {
        dataUrl: 'maid-avatar',
        width: 256,
        height: 256,
        mime: 'image/webp',
        bytes: 100,
      };
    },
  });
  const result = await getTool(tools, 'persona.set_avatar').execute(
    { target: '角色A' },
    { maidAttachments: [attachment] },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'avatar_changed_during_operation');
  assert.equal(personas.get('p1').avatar, 'user-avatar');
  console.log('ok - avatar writeback rejects a user replacement during image preparation');
}

{
  const contacts = new Map([
    ['room-1', {
      id: 'room-1',
      name: '聊天室A',
      avatar: 'old-avatar',
      description: '旧简介',
      labels: ['旧标签'],
      addedAt: 1,
    }],
  ]);
  const contactsStore = {
    scopeId: 'persona-a',
    listContacts: () => Array.from(contacts.values()),
    getContact: id => contacts.get(id) || null,
    upsertContact: patch => contacts.set(patch.id, { ...contacts.get(patch.id), ...patch }),
  };
  const tools = createMaidMediaAssetTools({
    contactsStore,
    getCurrentSessionId: () => 'room-1',
    confirmDestructiveWrite: async () => true,
    prepareImage: async () => {
      contacts.set('room-1', {
        ...contacts.get('room-1'),
        description: '用户新简介',
        labels: ['用户新标签'],
      });
      return {
        dataUrl: 'maid-avatar',
        width: 256,
        height: 256,
        mime: 'image/webp',
        bytes: 100,
      };
    },
  });
  const result = await getTool(tools, 'contact.set_avatar').execute(
    { target: '聊天室A' },
    { maidAttachments: [attachment] },
  );
  assert.equal(result.ok, true);
  assert.equal(contacts.get('room-1').avatar, 'maid-avatar');
  assert.equal(contacts.get('room-1').description, '用户新简介');
  assert.deepEqual(contacts.get('room-1').labels, ['用户新标签']);
  console.log('ok - contact avatar patch preserves non-overlapping user profile edits');
}

{
  const contacts = new Map([
    ['room-a', { id: 'room-a', name: '聊天室A', avatar: '', addedAt: 1 }],
    ['room-b', { id: 'room-b', name: '聊天室B', avatar: '', addedAt: 2 }],
  ]);
  const settings = new Map([
    ['room-a', { wallpaper: { path: 'wallpapers/room-a/old.jpg', updatedAt: 1 } }],
    ['room-b', { wallpaper: { path: 'wallpapers/room-b/old.jpg', updatedAt: 1 } }],
  ]);
  let currentSessionId = 'room-a';
  const tools = createMaidMediaAssetTools({
    contactsStore: {
      scopeId: 'persona-a',
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
    },
    chatStore: {
      scopeId: 'persona-a',
      getSessionSettings: id => settings.get(id) || {},
      setSessionSettings: (id, next) => settings.set(id, next),
    },
    getCurrentSessionId: () => currentSessionId,
    prepareImage: async () => ({
      dataUrl: 'maid-wallpaper',
      width: 1600,
      height: 900,
      mime: 'image/jpeg',
      bytes: 100,
    }),
    saveWallpaper: async ({ sessionId }) => ({ path: `wallpapers/${sessionId}/maid.jpg` }),
    deleteWallpaper: async () => true,
  });
  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({
      defaultDecision: AGENT_PERMISSION_DECISIONS.allow,
    }),
    logger: { warn() {} },
  });
  registry.registerMany(tools);
  const output = await registry.executeTool('session.set_wallpaper', {}, {
    maidAttachments: [attachment],
    requestToolConfirmation: () => {
      currentSessionId = 'room-b';
      return true;
    },
  });
  assert.equal(output.result.ok, true);
  assert.equal(settings.get('room-a').wallpaper.path, 'wallpapers/room-a/maid.jpg');
  assert.equal(settings.get('room-b').wallpaper.path, 'wallpapers/room-b/old.jpg');
  console.log('ok - wallpaper confirmation pins the original current session');
}

{
  const contacts = new Map([
    ['room-1', { id: 'room-1', name: '聊天室A', avatar: '', addedAt: 1 }],
  ]);
  const settings = new Map([
    ['room-1', {
      bubbleColor: '#111111',
      wallpaper: { path: 'wallpapers/room-1/old.jpg', updatedAt: 1 },
    }],
  ]);
  const deletedPaths = [];
  const tools = createMaidMediaAssetTools({
    contactsStore: {
      scopeId: 'persona-a',
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
    },
    chatStore: {
      scopeId: 'persona-a',
      getSessionSettings: id => settings.get(id) || {},
      setSessionSettings: (id, next) => settings.set(id, next),
    },
    getCurrentSessionId: () => 'room-1',
    confirmDestructiveWrite: async () => true,
    prepareImage: async () => {
      settings.set('room-1', { ...settings.get('room-1'), bubbleColor: '#abcdef' });
      return {
        dataUrl: 'maid-wallpaper',
        width: 1600,
        height: 900,
        mime: 'image/jpeg',
        bytes: 100,
      };
    },
    saveWallpaper: async () => ({ path: 'wallpapers/room-1/maid.jpg' }),
    deleteWallpaper: async ({ path }) => deletedPaths.push(path),
  });
  const result = await getTool(tools, 'session.set_wallpaper').execute(
    { target: '聊天室A' },
    { maidAttachments: [attachment] },
  );
  assert.equal(result.ok, true);
  assert.equal(settings.get('room-1').bubbleColor, '#abcdef');
  assert.equal(settings.get('room-1').wallpaper.path, 'wallpapers/room-1/maid.jpg');
  assert.deepEqual(deletedPaths, ['wallpapers/room-1/old.jpg']);
  console.log('ok - wallpaper patch preserves non-overlapping settings and retires the old file after commit');
}

{
  const contacts = new Map([
    ['room-1', { id: 'room-1', name: '聊天室A', avatar: '', addedAt: 1 }],
  ]);
  const userWallpaper = { path: 'wallpapers/room-1/user.jpg', updatedAt: 2 };
  const settings = new Map([
    ['room-1', { wallpaper: { path: 'wallpapers/room-1/old.jpg', updatedAt: 1 } }],
  ]);
  const cleaned = [];
  const tools = createMaidMediaAssetTools({
    contactsStore: {
      scopeId: 'persona-a',
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
    },
    chatStore: {
      scopeId: 'persona-a',
      getSessionSettings: id => settings.get(id) || {},
      setSessionSettings: (id, next) => settings.set(id, next),
    },
    getCurrentSessionId: () => 'room-1',
    confirmDestructiveWrite: async () => true,
    prepareImage: async () => ({
      dataUrl: 'maid-wallpaper',
      width: 1600,
      height: 900,
      mime: 'image/jpeg',
      bytes: 100,
    }),
    saveWallpaper: async () => {
      settings.set('room-1', { ...settings.get('room-1'), wallpaper: userWallpaper });
      return { path: 'wallpapers/room-1/maid.jpg' };
    },
    deleteWallpaper: async ({ path }) => cleaned.push(path),
  });
  const result = await getTool(tools, 'session.set_wallpaper').execute(
    { target: '聊天室A' },
    { maidAttachments: [attachment] },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wallpaper_changed_during_operation');
  assert.equal(settings.get('room-1').wallpaper, userWallpaper);
  assert.deepEqual(cleaned, ['wallpapers/room-1/maid.jpg'], '冲突后只清理女仆刚保存的孤儿文件');
  console.log('ok - wallpaper writeback rejects a user replacement during native save');
}

{
  const contacts = new Map([
    ['room-1', { id: 'room-1', name: '聊天室A', avatar: '', addedAt: 1 }],
  ]);
  const chatStore = {
    scopeId: 'persona-a',
    getSessionSettings: () => ({}),
    setSessionSettings: () => { throw new Error('scope drift must block before write'); },
  };
  let saved = 0;
  const tools = createMaidMediaAssetTools({
    contactsStore: {
      scopeId: 'persona-a',
      listContacts: () => Array.from(contacts.values()),
      getContact: id => contacts.get(id) || null,
    },
    chatStore,
    getCurrentSessionId: () => 'room-1',
    prepareImage: async () => {
      chatStore.scopeId = 'persona-b';
      return {
        dataUrl: 'maid-wallpaper',
        width: 1600,
        height: 900,
        mime: 'image/jpeg',
        bytes: 100,
      };
    },
    saveWallpaper: async () => {
      saved += 1;
      return { path: 'wallpapers/room-1/maid.jpg' };
    },
  });
  const result = await getTool(tools, 'session.set_wallpaper').execute(
    { target: '聊天室A' },
    { maidAttachments: [attachment] },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'target_scope_changed');
  assert.equal(saved, 0);
  console.log('ok - wallpaper writeback rejects a persona scope switch before persistence');
}

{
  const personas = new Map([
    ['p1', { id: 'p1', name: '角色A', avatar: 'same-avatar', created: 1 }],
  ]);
  const tools = createMaidMediaAssetTools({
    personaStore: {
      getAll: () => Array.from(personas.values()),
      get: id => personas.get(id) || null,
      getActive: () => personas.get('p1'),
      update: async (id, patch) => {
        const next = { ...personas.get(id), ...patch };
        personas.set(id, next);
        return next;
      },
    },
    confirmDestructiveWrite: async () => true,
    prepareImage: async () => {
      personas.set('p1', { id: 'p1', name: '重建角色', avatar: 'same-avatar', created: 2 });
      return {
        dataUrl: 'maid-avatar',
        width: 256,
        height: 256,
        mime: 'image/webp',
        bytes: 100,
      };
    },
  });
  const result = await getTool(tools, 'persona.set_avatar').execute(
    { target: '角色A' },
    { maidAttachments: [attachment] },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'target_recreated_during_operation');
  assert.equal(personas.get('p1').avatar, 'same-avatar');
  console.log('ok - avatar writeback rejects delete-and-recreate ABA even when the field value matches');
}

{
  const users = new Map([
    ['u1', { id: 'u1', name: '用户A', avatar: '', created: 1 }],
  ]);
  const tools = createMaidMediaAssetTools({
    userStore: {
      getAll: () => Array.from(users.values()),
      get: id => users.get(id) || null,
      getActive: () => users.get('u1'),
      update: async (id, patch) => {
        const next = { ...users.get(id), ...patch };
        users.set(id, next);
        return next;
      },
    },
    prepareImage: async () => ({
      dataUrl: 'maid-user-avatar',
      width: 256,
      height: 256,
      mime: 'image/webp',
      bytes: 100,
    }),
  });
  const result = await getTool(tools, 'user.set_avatar').execute(
    { target: '用户A' },
    { maidAttachments: [attachment] },
  );
  assert.equal(result.ok, true);
  assert.equal(users.get('u1').avatar, 'maid-user-avatar');
  console.log('ok - shared guarded avatar setter is wired for user profiles');
}
