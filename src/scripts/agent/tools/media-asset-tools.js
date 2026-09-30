import { normalizeMaidImageAttachments } from '../maid-attachment-parts.js';
import { normalizeMaidImageGenerationContext } from '../maid-image-generation-context.js';
import { readImageHeaderDimensions } from '../../utils/image.js';
import {
  buildMaidVisualSpecPrompt,
  createMaidVisualSpecLedger,
  freezeMaidVisualSpec,
  validateMaidVisualAspect,
  validateMaidVisualAttachmentTarget,
} from '../maid-visual-spec.js';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const readGeneratedImageDimensions = (dataUrl = '') => {
  const match = String(dataUrl).match(/^data:image\/[^;,]+;base64,(.+)$/s);
  if (!match) return null;
  try {
    const binary = atob(match[1]);
    return readImageHeaderDimensions(Uint8Array.from(binary, character => character.charCodeAt(0)));
  } catch {
    return null;
  }
};

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

const normalizeMediaAssetRevisionValue = (value) => {
  if (Array.isArray(value)) return value.map(normalizeMediaAssetRevisionValue);
  if (!isPlainObject(value)) return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = normalizeMediaAssetRevisionValue(value[key]);
    return result;
  }, {});
};

const fingerprintMediaAssetValue = (value) => {
  let input = '';
  try {
    input = typeof value === 'string'
      ? `s:${value}`
      : JSON.stringify(normalizeMediaAssetRevisionValue(value));
  } catch {
    input = String(value ?? '');
  }
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second ^= code + ((second << 6) >>> 0) + (second >>> 2);
  }
  return `${input.length}:${first >>> 0}:${second >>> 0}`;
};

export const createMediaAssetFieldRevision = value => `asset:${fingerprintMediaAssetValue(value)}`;

const getStoreScopeId = store => trim(store?.scopeId);

const getTargetGenerationToken = (target) => {
  if (!target || typeof target !== 'object') return '';
  for (const key of ['created', 'createdAt', 'addedAt']) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) continue;
    const value = target[key];
    if (value === null || value === undefined || value === '') continue;
    return `${key}:${String(value)}`;
  }
  return '';
};

const createAvatarWriteSnapshot = ({ target = null, store = null } = {}) => ({
  targetId: trim(target?.id),
  scopeId: getStoreScopeId(store),
  generation: getTargetGenerationToken(target),
  avatarRevision: createMediaAssetFieldRevision(trim(target?.avatar)),
});

const validateAvatarWriteSnapshot = ({ snapshot = null, store = null } = {}) => {
  const targetId = trim(snapshot?.targetId);
  if (!targetId) return { ok: false, reason: 'target_not_found', target: null };
  if (getStoreScopeId(store) !== trim(snapshot?.scopeId)) {
    return { ok: false, reason: 'target_scope_changed', target: null };
  }
  const target = getStoreItem(store, targetId);
  if (!target) return { ok: false, reason: 'target_not_found', target: null };
  const generation = trim(snapshot?.generation);
  if (generation && getTargetGenerationToken(target) !== generation) {
    return { ok: false, reason: 'target_recreated_during_operation', target };
  }
  if (createMediaAssetFieldRevision(trim(target.avatar)) !== snapshot?.avatarRevision) {
    return { ok: false, reason: 'avatar_changed_during_operation', target };
  }
  return { ok: true, reason: '', target };
};

const buildAvatarWriteConflict = ({ validation, kind, target, stage = 'prepare' } = {}) => ({
  ok: false,
  reason: validation?.reason || 'avatar_changed_during_operation',
  message: stage === 'confirm'
    ? '确认期间目标头像或身份已变化，请重新执行头像设置。'
    : '图片准备期间目标头像或身份已变化，未覆盖用户的新内容。',
  kind,
  target: summarizeProfile(validation?.target || target),
});

const getWallpaperRevisionValue = settings => ({
  wallpaper: isPlainObject(settings?.wallpaper) ? settings.wallpaper : null,
  chatBg: settings?.chatBg ?? null,
});

const createWallpaperWriteSnapshot = ({ target = null, chatStore = null, contactsStore = null } = {}) => {
  const sessionId = trim(target?.id);
  const contact = getStoreItem(contactsStore, sessionId);
  const currentSettings = chatStore?.getSessionSettings?.(sessionId);
  const settings = isPlainObject(currentSettings) ? currentSettings : {};
  const canCheckSession = typeof chatStore?.hasSession === 'function';
  return {
    sessionId,
    chatScopeId: getStoreScopeId(chatStore),
    contactsScopeId: getStoreScopeId(contactsStore),
    contactExpected: Boolean(contact),
    contactGeneration: getTargetGenerationToken(contact),
    sessionExpected: canCheckSession ? chatStore.hasSession(sessionId) === true : null,
    wallpaperRevision: createMediaAssetFieldRevision(getWallpaperRevisionValue(settings)),
    hasExistingWallpaper: Boolean(settings?.wallpaper?.path || settings?.wallpaper?.url || settings?.chatBg),
    previousPath: trim(settings?.wallpaper?.path),
  };
};

const validateWallpaperWriteSnapshot = ({ snapshot = null, chatStore = null, contactsStore = null } = {}) => {
  const sessionId = trim(snapshot?.sessionId);
  if (!sessionId) return { ok: false, reason: 'session_not_found', settings: null, target: null };
  if (
    getStoreScopeId(chatStore) !== trim(snapshot?.chatScopeId) ||
    getStoreScopeId(contactsStore) !== trim(snapshot?.contactsScopeId)
  ) {
    return { ok: false, reason: 'target_scope_changed', settings: null, target: null };
  }
  const contact = getStoreItem(contactsStore, sessionId);
  if (snapshot?.contactExpected === true && !contact) {
    return { ok: false, reason: 'session_not_found', settings: null, target: null };
  }
  const contactGeneration = trim(snapshot?.contactGeneration);
  if (contactGeneration && getTargetGenerationToken(contact) !== contactGeneration) {
    return { ok: false, reason: 'target_recreated_during_operation', settings: null, target: contact };
  }
  if (
    snapshot?.sessionExpected === true &&
    typeof chatStore?.hasSession === 'function' &&
    chatStore.hasSession(sessionId) !== true
  ) {
    return { ok: false, reason: 'session_not_found', settings: null, target: contact };
  }
  const currentSettings = chatStore?.getSessionSettings?.(sessionId);
  const settings = isPlainObject(currentSettings) ? currentSettings : {};
  if (createMediaAssetFieldRevision(getWallpaperRevisionValue(settings)) !== snapshot?.wallpaperRevision) {
    return { ok: false, reason: 'wallpaper_changed_during_operation', settings, target: contact };
  }
  return { ok: true, reason: '', settings, target: contact };
};

const buildWallpaperWriteConflict = ({ validation, target, sessionId, stage = 'prepare' } = {}) => ({
  ok: false,
  reason: validation?.reason || 'wallpaper_changed_during_operation',
  message: stage === 'confirm'
    ? '确认期间目标聊天室或壁纸已变化，请重新执行壁纸设置。'
    : '图片准备期间目标聊天室或壁纸已变化，未覆盖用户的新内容。',
  sessionId,
  sessionName: trim(target?.name || sessionId),
});

const normalizeKey = value => trim(value).toLowerCase().replace(/\s+/g, '');

const listStoreItems = store => (
  typeof store?.getAll === 'function'
    ? store.getAll()
    : (typeof store?.listContacts === 'function' ? store.listContacts() : [])
).filter(Boolean);

const getStoreItem = (store, id = '') => {
  const target = trim(id);
  if (!target) return null;
  if (typeof store?.get === 'function') return store.get(target) || null;
  if (typeof store?.getContact === 'function') return store.getContact(target) || null;
  return null;
};

const getActiveStoreItem = store => {
  try {
    return typeof store?.getActive === 'function' ? store.getActive() : null;
  } catch {
    return null;
  }
};

const findStoreItem = (store, query = '') => {
  const raw = trim(query);
  if (!raw) return null;
  const direct = getStoreItem(store, raw);
  if (direct) return direct;
  const key = normalizeKey(raw);
  return listStoreItems(store).find(item => (
    trim(item?.id) === raw ||
    trim(item?.name) === raw ||
    normalizeKey(item?.id) === key ||
    normalizeKey(item?.name) === key
  )) || null;
};

const summarizeProfile = profile => ({
  id: trim(profile?.id),
  name: trim(profile?.name || profile?.id),
  avatarBytes: trim(profile?.avatar).length,
});

const inferDataUrlMime = (dataUrl = '', fallback = 'image/jpeg') => {
  const match = trim(dataUrl).match(/^data:([^;,]+)[;,]/i);
  return trim(match?.[1], fallback);
};

const estimateDataUrlBytes = (dataUrl = '') => {
  const raw = trim(dataUrl);
  const comma = raw.indexOf(',');
  const payload = comma >= 0 ? raw.slice(comma + 1) : raw;
  return Math.ceil((payload.length * 3) / 4);
};

const defaultPrepareImage = async ({ dataUrl = '', purpose = 'image' } = {}) => ({
  dataUrl: trim(dataUrl),
  width: 0,
  height: 0,
  mime: inferDataUrlMime(dataUrl, purpose === 'avatar' ? 'image/webp' : 'image/jpeg'),
  bytes: estimateDataUrlBytes(dataUrl),
  transformed: false,
});

export const createPreparedImageCache = ({
  maxEntries = 32,
  createId = () => `prepared_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
} = {}) => {
  const entries = new Map();
  const max = Math.max(4, Math.min(128, Math.trunc(Number(maxEntries || 0)) || 32));
  const set = (image = {}) => {
    const id = trim(image.preparedImageId) || createId();
    entries.set(id, {
      ...clone(image),
      preparedImageId: id,
      createdAt: Date.now(),
    });
    while (entries.size > max) {
      const first = entries.keys().next().value;
      entries.delete(first);
    }
    return entries.get(id);
  };
  return {
    set,
    get: id => entries.get(trim(id)) || null,
    clear: () => entries.clear(),
    size: () => entries.size,
  };
};

const publicImageMeta = image => ({
  preparedImageId: trim(image?.preparedImageId),
  attachmentId: trim(image?.attachmentId),
  purpose: trim(image?.purpose),
  name: trim(image?.name),
  mime: trim(image?.mime),
  width: Number(image?.width || 0) || 0,
  height: Number(image?.height || 0) || 0,
  bytes: Number(image?.bytes || 0) || 0,
  transformed: image?.transformed === true,
  ...(image?.visualSpec ? {
    visualSpec: {
      id: trim(image.visualSpec.id),
      subject: trim(image.visualSpec.subject),
      target: trim(image.visualSpec.target),
      purpose: trim(image.visualSpec.purpose),
      targetAspectRatio: trim(image.visualSpec.targetAspectRatio),
      actualWidth: Number(image.visualSpec.actualWidth || 0) || 0,
      actualHeight: Number(image.visualSpec.actualHeight || 0) || 0,
    },
  } : {}),
});

// 附件解析顺序：本次女仆输入附件 -> 工具在当前运行期取得的图片池。
const resolveAttachment = (context = {}, args = {}, fetchedImages = []) => {
  const images = normalizeMaidImageAttachments(context?.maidAttachments);
  const fetched = Array.isArray(fetchedImages) ? fetchedImages : [];
  const requested = trim(args.attachmentId || args.imageId || args.sourceImageId);
  if (!requested) {
    if (images.length) return images[0];
    return fetched.length ? fetched[fetched.length - 1] : null;
  }
  const key = normalizeKey(requested);
  const fromInput = images.find(item => (
    normalizeKey(item.id) === key ||
    normalizeKey(item.name) === key ||
    String(images.indexOf(item) + 1) === requested
  ));
  if (fromInput) return fromInput;
  return fetched.find(item => normalizeKey(item.id) === key || normalizeKey(item.name) === key) || null;
};

const normalizePurpose = (value = '', fallback = 'image') => {
  const raw = trim(value, fallback).toLowerCase();
  if (raw === 'role_avatar' || raw === 'persona_avatar' || raw === 'contact_avatar' || raw === 'user_avatar') return 'avatar';
  if (raw === 'background' || raw === 'chat_wallpaper') return 'wallpaper';
  if (raw === 'avatar' || raw === 'wallpaper' || raw === 'image') return raw;
  return fallback;
};

const buildPrepareOptions = (purpose = 'image', args = {}) => {
  const usage = normalizePurpose(purpose, 'image');
  const avatar = usage === 'avatar';
  const wallpaper = usage === 'wallpaper';
  return {
    purpose: usage,
    fit: trim(args.fit, avatar ? 'cover' : 'contain'),
    maxDim: Math.max(32, Math.min(4096, Math.trunc(Number(args.maxDim || 0)) || (avatar ? 256 : wallpaper ? 2048 : 1280))),
    quality: Math.max(0.35, Math.min(0.95, Number(args.quality || 0) || (avatar ? 0.84 : 0.86))),
    maxBytes: Math.max(32_000, Math.min(4_000_000, Math.trunc(Number(args.maxBytes || 0)) || (avatar ? 180_000 : 1_400_000))),
    mime: trim(args.mime, avatar ? 'image/webp' : 'image/jpeg'),
  };
};

export const createMaidMediaAssetTools = ({
  personaStore = null,
  userStore = null,
  contactsStore = null,
  chatStore = null,
  prepareImage = defaultPrepareImage,
  saveWallpaper = null,
  deleteWallpaper = null,
  applyChatSettings = null,
  refreshChatAndContacts = null,
  getCurrentSessionId = () => '',
  confirmDestructiveWrite = null,
  fetchRemoteImage = null,
  generateImageAttachment = null,
  getImageGenerationContext = null,
  now = Date.now,
  preparedImageCache = createPreparedImageCache(),
} = {}) => {
  // 工具运行期图片池：联网下载与生图写入，头像/壁纸工具经 attachmentId 取用。
  const fetchedImages = [];
  const FETCHED_IMAGE_LIMIT = 6;
  const personaAvatarPreflightSnapshots = new WeakMap();
  const userAvatarPreflightSnapshots = new WeakMap();
  const contactAvatarPreflightSnapshots = new WeakMap();
  const wallpaperPreflightSnapshots = new WeakMap();
  const prepareAndCacheImage = async ({
    args = {},
    context = {},
    purpose = 'image',
    target = null,
  } = {}) => {
    const cached = preparedImageCache.get(args.preparedImageId);
    if (cached) return cached;
    const attachment = resolveAttachment(context, args, fetchedImages);
    if (!attachment?.url) {
      return {
        ok: false,
        reason: 'image_attachment_missing',
        message: '没有找到本次请求中的图片附件。',
      };
    }
    const visualValidation = validateMaidVisualAttachmentTarget({
      attachment,
      purpose: normalizePurpose(purpose || args.purpose, 'image'),
      target,
    });
    if (!visualValidation.ok) return visualValidation;
    const options = buildPrepareOptions(purpose || args.purpose, args);
    const prepared = await prepareImage({
      dataUrl: attachment.url,
      attachment,
      args,
      ...options,
    });
    const dataUrl = trim(prepared?.dataUrl);
    if (!dataUrl) {
      return {
        ok: false,
        reason: 'image_prepare_failed',
        message: '图片处理失败。',
      };
    }
    return preparedImageCache.set({
      ...options,
      ...clone(prepared),
      dataUrl,
      purpose: options.purpose,
      attachmentId: trim(attachment.id),
      name: trim(args.fileName || attachment.name, `${options.purpose}.jpg`),
      mime: trim(prepared?.mime, options.mime),
      bytes: Number(prepared?.bytes || 0) || estimateDataUrlBytes(dataUrl),
      width: Number(prepared?.width || 0) || 0,
      height: Number(prepared?.height || 0) || 0,
      ...(attachment?.visualSpec ? { visualSpec: clone(attachment.visualSpec) } : {}),
    });
  };

  const resolvePersonaTarget = (args = {}) => {
    const target = trim(args.target || args.personaId || args.id || args.name);
    return target ? findStoreItem(personaStore, target) : getActiveStoreItem(personaStore);
  };

  const resolveUserTarget = (args = {}) => {
    const target = trim(args.target || args.userId || args.id || args.name);
    return target ? findStoreItem(userStore, target) : getActiveStoreItem(userStore);
  };

  const resolveContactTarget = (args = {}) => {
    const explicit = trim(args.target || args.contactId || args.sessionId || args.sessionName || args.chatName || args.name);
    const fallback = trim(getCurrentSessionId?.());
    return explicit ? findStoreItem(contactsStore, explicit) : findStoreItem(contactsStore, fallback);
  };

  const resolveSessionTarget = (args = {}) => {
    const explicit = trim(args.target || args.sessionId || args.sessionName || args.chatName || args.contactId || args.name);
    const fallback = trim(getCurrentSessionId?.());
    const contact = explicit ? findStoreItem(contactsStore, explicit) : findStoreItem(contactsStore, fallback);
    return contact || (explicit ? { id: explicit, name: explicit } : (fallback ? { id: fallback, name: fallback } : null));
  };

  const hasAllowedToolSafety = (context = {}, kind = '') => (
    context?.toolSafety?.decision === 'allow' &&
    (!kind || context?.toolSafety?.request?.kind === kind)
  );

  const buildAvatarSafetyPreflight = ({
    kind = 'profile',
    store = null,
    resolveTarget = null,
    snapshots = null,
    title = '覆盖头像',
  } = {}) => async (args = {}) => {
    const target = resolveTarget?.(args);
    const snapshot = createAvatarWriteSnapshot({ target, store });
    if (args && typeof args === 'object') snapshots?.set?.(args, snapshot);
    if (!target?.id || !trim(target.avatar)) {
      return { destructive: false, operationType: 'set_avatar' };
    }
    return {
      destructive: true,
      kind: `${kind}.avatar.replace`,
      operationType: 'replace_existing',
      title,
      message: `「${trim(target.name || target.id)}」已有头像。这个动作会替换现有头像。`,
      confirmText: '覆盖',
      cancelText: '取消',
      danger: true,
      details: {
        targetId: trim(target.id),
        targetScopeId: snapshot.scopeId,
      },
      onDeny: {
        action: 'skip',
        reason: 'destructive_write_cancelled',
      },
    };
  };

  const makeAvatarSetter = ({
    kind = 'persona',
    store = null,
    resolveTarget = null,
    update = null,
    snapshots = null,
    targetLabel = kind,
    afterUpdate = null,
    updateAvailable = null,
    updateUnavailableReason = `${kind}_update_unavailable`,
    updateUnavailableMessage = '头像写入能力不可用。',
  } = {}) => async (args = {}, context = {}) => {
    const preflightSnapshot = args && typeof args === 'object' ? snapshots?.get?.(args) : null;
    const initiallyResolved = preflightSnapshot?.targetId
      ? getStoreItem(store, preflightSnapshot.targetId)
      : resolveTarget?.(args);
    const snapshot = preflightSnapshot || createAvatarWriteSnapshot({ target: initiallyResolved, store });
    let validation = validateAvatarWriteSnapshot({ snapshot, store });
    const target = validation.target || initiallyResolved;
    if (!target?.id) {
      return { ok: false, reason: `${kind}_not_found`, message: `没有找到要设置头像的${targetLabel}。` };
    }
    if (!validation.ok) {
      return buildAvatarWriteConflict({ validation, kind, target, stage: 'confirm' });
    }
    if (typeof update !== 'function' || updateAvailable?.() === false) {
      return { ok: false, reason: updateUnavailableReason, message: updateUnavailableMessage };
    }
    if (trim(target.avatar) && !hasAllowedToolSafety(context, `${kind}.avatar.replace`)) {
      const confirmed = typeof confirmDestructiveWrite === 'function'
        ? await confirmDestructiveWrite({
          kind: `${kind}.avatar.replace`,
          title: '覆盖头像',
          message: `「${trim(target.name || target.id)}」已有头像。这个动作会替换现有头像。`,
          confirmText: '覆盖',
          cancelText: '取消',
          danger: true,
          targetId: trim(target.id),
        })
        : false;
      if (confirmed !== true) {
        return {
          ok: false,
          skipped: true,
          reason: 'destructive_write_cancelled',
          kind,
          target: summarizeProfile(target),
        };
      }
    }
    validation = validateAvatarWriteSnapshot({ snapshot, store });
    if (!validation.ok) {
      return buildAvatarWriteConflict({ validation, kind, target, stage: 'confirm' });
    }
    const image = await prepareAndCacheImage({ args, context, purpose: 'avatar', target });
    if (image?.ok === false) return image;
    validation = validateAvatarWriteSnapshot({ snapshot, store });
    if (!validation.ok) {
      return buildAvatarWriteConflict({ validation, kind, target });
    }
    const updated = await update(validation.target, image.dataUrl);
    if (!updated) {
      return { ok: false, reason: `${kind}_update_failed`, target: summarizeProfile(target) };
    }
    await afterUpdate?.(updated || validation.target);
    return {
      ok: true,
      kind,
      target: summarizeProfile(updated || target),
      image: publicImageMeta(image),
    };
  };

  const setStoreAvatar = async (store, target, avatar) => {
    if (!target?.id || typeof store?.update !== 'function') return null;
    return store.update(target.id, { avatar });
  };

  return [
    {
      name: 'media.generate_image',
      title: 'Generate image as attachment',
      description: 'Generate an image with the active image model and place it in the maid attachment pool; then pass the returned attachmentId to an avatar or wallpaper tool.',
      source: 'maid-media-assets',
      permissions: [],
      riskLevel: 'medium',
      capabilities: {
        read: false,
        write: true,
        network: true,
        cost: 'variable',
        undo: 'delete_asset',
        modelContext: 'allowlist',
        confirmation: 'allow_once',
      },
      timeoutMs: 180000,
      outputLimit: 800,
      schema: {
        type: 'object',
        required: [
          'prompt',
          'subject',
          'target',
          'purpose',
          'appearance',
          'outfit',
          'style',
          'targetAspectRatio',
        ],
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', minLength: 1, maxLength: 4000 },
          negativePrompt: { type: 'string', maxLength: 2000 },
          subject: { type: 'string', minLength: 1, maxLength: 240 },
          subjectAliases: {
            type: 'array',
            maxItems: 12,
            items: { type: 'string', minLength: 1, maxLength: 240 },
          },
          target: { type: 'string', minLength: 1, maxLength: 240 },
          purpose: { type: 'string', enum: ['avatar', 'wallpaper'] },
          appearance: { type: 'string', minLength: 1, maxLength: 1000 },
          outfit: { type: 'string', minLength: 1, maxLength: 1000 },
          style: { type: 'string', minLength: 1, maxLength: 1000 },
          targetAspectRatio: { type: 'string', minLength: 3, maxLength: 40 },
        },
      },
      execute: async (args = {}, context = {}) => {
        if (typeof generateImageAttachment !== 'function') {
          return { ok: false, reason: 'image_generation_unavailable', message: '当前没有可用的图片生成配置。' };
        }
        const prompt = trim(args.prompt);
        if (!prompt) {
          return { ok: false, reason: 'missing_prompt', message: '图片提示词不能为空。' };
        }
        const ledger = context?.maidVisualSpecLedger && typeof context.maidVisualSpecLedger === 'object'
          ? context.maidVisualSpecLedger
          : createMaidVisualSpecLedger();
        const frozen = freezeMaidVisualSpec({ ledger, args });
        if (!frozen.ok) return frozen;
        let currentGenerationContext = null;
        if (typeof getImageGenerationContext === 'function') {
          try {
            currentGenerationContext = normalizeMaidImageGenerationContext(await getImageGenerationContext());
          } catch {}
        }
        if (currentGenerationContext?.width && currentGenerationContext?.height) {
          const preflightAspect = validateMaidVisualAspect({
            targetAspectRatio: frozen.spec.targetAspectRatio,
            width: currentGenerationContext.width,
            height: currentGenerationContext.height,
          });
          if (!preflightAspect.ok) {
            return {
              ...preflightAspect,
              stage: 'preflight',
              visualSpec: frozen.spec,
              message: `${preflightAspect.message || '当前生图比例与目标不符'} 请先切换合适的图片尺寸/预设后再生成。`,
            };
          }
        }
        const effectivePrompt = buildMaidVisualSpecPrompt({
          prompt,
          spec: frozen.spec,
          promptDialect: currentGenerationContext?.promptDialect,
        });
        let generated = null;
        try {
          generated = await generateImageAttachment({
            prompt: effectivePrompt,
            negativePrompt: trim(args.negativePrompt),
            sessionId: trim(getCurrentSessionId?.()),
            context,
          });
        } catch (error) {
          return {
            ok: false,
            reason: 'image_generation_failed',
            message: error?.message || '图片生成失败。',
          };
        }
        const dataUrl = trim(generated?.dataUrl);
        const mime = trim(generated?.mime, inferDataUrlMime(dataUrl)).toLowerCase();
        const bytes = Number(generated?.bytes || 0) || estimateDataUrlBytes(dataUrl);
        if (!dataUrl.startsWith('data:image/') || !mime.startsWith('image/')) {
          return { ok: false, reason: 'image_generation_invalid', message: '图片模型没有返回可用图片。' };
        }
        if (bytes > 6_000_000) {
          return { ok: false, reason: 'image_too_large', message: '生成图片超过 6MB 限制。' };
        }
        const generationContext = normalizeMaidImageGenerationContext(
          generated?.generationContext || currentGenerationContext,
        );
        // The preset describes a request, not the returned image. Automatic
        // sizes have no preset dimensions; providers can also return a different
        // aspect. Prefer bytes, then explicit output metadata from the adapter.
        const dimensions = readGeneratedImageDimensions(dataUrl);
        const actualWidth = Number(dimensions?.width || generated?.width || 0) || 0;
        const actualHeight = Number(dimensions?.height || generated?.height || 0) || 0;
        const aspectValidation = validateMaidVisualAspect({
          targetAspectRatio: frozen.spec.targetAspectRatio,
          width: actualWidth,
          height: actualHeight,
        });
        if (!aspectValidation.ok) {
          return {
            ...aspectValidation,
            stage: 'generated',
            visualSpec: frozen.spec,
            message: `${aspectValidation.message || '生成结果无法验证目标比例'} 图片未加入可写回附件池。`,
          };
        }
        const id = `generated-${Number(typeof now === 'function' ? now() : Date.now()) || Date.now()}-${fetchedImages.length + 1}`;
        const visualSpec = {
          ...clone(frozen.spec),
          actualWidth,
          actualHeight,
          actualAspectRatio: aspectValidation.actualAspectRatio,
          subjectVerification: 'prompt_contract',
        };
        const attachment = {
          id,
          name: trim(generated?.name, `${id}.${mime.split('/')[1] || 'png'}`),
          url: dataUrl,
          mime,
          bytes,
          source: 'generated',
          visualSpec,
        };
        fetchedImages.push(attachment);
        while (fetchedImages.length > FETCHED_IMAGE_LIMIT) fetchedImages.shift();
        return {
          ok: true,
          attachmentId: id,
          name: attachment.name,
          mime,
          bytes,
          ...(generationContext ? { generationContext } : {}),
          visualSpec,
          verification: {
            subject: 'prompt_contract',
            purpose: true,
            aspectRatio: true,
          },
          message: `图片已生成为附件 ${id}，可继续用于头像或壁纸设置。`,
        };
      },
      summarizeResult: result => (result?.ok === false
        ? `image generation failed: ${trim(result?.reason, 'unknown')}`
        : `image generated as ${trim(result?.attachmentId)} (${Number(result?.bytes || 0)} bytes)`),
    },
    {
      name: 'media.fetch_image',
      title: 'Fetch web image as attachment',
      description: 'Download an HTTP(S) image (e.g. from web.search_images results) into the maid attachment pool; then use the returned attachmentId with avatar/wallpaper tools.',
      source: 'maid-media-assets',
      permissions: [],
      riskLevel: 'low',
      capabilities: {
        read: true,
        write: false,
        network: true,
        cost: 'variable',
        undo: 'none',
        modelContext: 'allowlist',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        required: ['url'],
        additionalProperties: false,
        properties: {
          url: { type: 'string', minLength: 8, maxLength: 2048 },
          fileName: { type: 'string', maxLength: 120 },
        },
      },
      execute: async (args = {}) => {
        if (typeof fetchRemoteImage !== 'function') {
          return { ok: false, reason: 'image_fetch_unavailable', message: '当前环境不支持联网下载图片。' };
        }
        const url = trim(args.url);
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, reason: 'invalid_image_url', message: '只支持 http(s) 图片地址。' };
        }
        let fetched = null;
        try {
          fetched = await fetchRemoteImage(url);
        } catch (error) {
          return { ok: false, reason: 'image_fetch_failed', message: error?.message || '图片下载失败。', url };
        }
        const dataUrl = trim(fetched?.dataUrl);
        const mime = trim(fetched?.mime).toLowerCase();
        const bytes = Number(fetched?.bytes || 0) || 0;
        if (!dataUrl || !mime.startsWith('image/')) {
          return { ok: false, reason: 'not_an_image', message: `目标不是图片（content-type: ${mime || '未知'}）。`, url };
        }
        if (bytes > 6_000_000) {
          return { ok: false, reason: 'image_too_large', message: '图片超过 6MB 限制，请换一张。', url };
        }
        const id = `fetched-${Number(typeof now === 'function' ? now() : Date.now()) || Date.now()}-${fetchedImages.length + 1}`;
        const attachment = {
          id,
          name: trim(args.fileName, `${id}.${mime.split('/')[1] || 'jpg'}`),
          url: dataUrl,
          mime,
          bytes,
          sourceUrl: url,
        };
        fetchedImages.push(attachment);
        while (fetchedImages.length > FETCHED_IMAGE_LIMIT) fetchedImages.shift();
        return {
          ok: true,
          attachmentId: id,
          name: attachment.name,
          mime,
          bytes,
          sourceUrl: url,
          message: `图片已下载为附件 ${id}，可用于头像/壁纸设置。`,
        };
      },
      summarizeResult: result => (result?.ok === false
        ? `image fetch failed: ${trim(result?.reason, 'unknown')}`
        : `image fetched as ${trim(result?.attachmentId)} (${Number(result?.bytes || 0)} bytes)`),
    },
    {
      name: 'media.prepare_image',
      title: 'Prepare uploaded image',
      description: 'Prepare the current maid image attachment for avatar or wallpaper usage. Use attachmentId when multiple images are attached.',
      source: 'maid-media-assets',
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
          attachmentId: { type: 'string', maxLength: 160 },
          imageId: { type: 'string', maxLength: 160 },
          purpose: { type: 'string', maxLength: 40 },
          fit: { type: 'string', maxLength: 40 },
          maxDim: { type: 'integer', minimum: 32, maximum: 4096 },
          quality: { type: 'number', minimum: 0.35, maximum: 0.95 },
          maxBytes: { type: 'integer', minimum: 32000, maximum: 4000000 },
          mime: { type: 'string', maxLength: 80 },
          fileName: { type: 'string', maxLength: 180 },
        },
      },
      execute: async (args = {}, context = {}) => {
        const image = await prepareAndCacheImage({
          args,
          context,
          purpose: normalizePurpose(args.purpose, 'image'),
        });
        if (image?.ok === false) return image;
        return {
          ok: true,
          image: publicImageMeta(image),
        };
      },
      summarizeResult: result => result?.ok === false
        ? `image prepare failed: ${trim(result?.reason, 'failed')}`
        : `prepared image ${trim(result?.image?.preparedImageId, '-')}`,
    },
    {
      name: 'persona.set_avatar',
      title: 'Set character card avatar',
      description: 'Set an uploaded image as a character card/persona avatar. Defaults to the active character card if target is omitted.',
      source: 'maid-media-assets',
      permissions: [],
      riskLevel: 'medium',
      capabilities: {
        read: true,
        write: true,
        network: false,
        cost: 'none',
        undo: 'manual_restore_avatar',
        modelContext: 'allowlist',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', maxLength: 160 },
          personaId: { type: 'string', maxLength: 160 },
          id: { type: 'string', maxLength: 160 },
          name: { type: 'string', maxLength: 160 },
          attachmentId: { type: 'string', maxLength: 160 },
          preparedImageId: { type: 'string', maxLength: 160 },
        },
      },
      safety: {
        operationType: 'set_avatar',
        destructive: 'conditional',
        preflight: buildAvatarSafetyPreflight({
          kind: 'persona',
          store: personaStore,
          resolveTarget: resolvePersonaTarget,
          snapshots: personaAvatarPreflightSnapshots,
          title: '覆盖头像',
        }),
      },
      execute: makeAvatarSetter({
        kind: 'persona',
        store: personaStore,
        resolveTarget: resolvePersonaTarget,
        update: (target, avatar) => setStoreAvatar(personaStore, target, avatar),
        snapshots: personaAvatarPreflightSnapshots,
        targetLabel: '角色',
      }),
      summarizeResult: result => result?.ok
        ? `set character avatar ${trim(result?.target?.name, result?.target?.id || '-')}`
        : `set character avatar failed: ${trim(result?.reason, 'failed')}`,
    },
    {
      name: 'user.set_avatar',
      title: 'Set user avatar',
      description: 'Set an uploaded image as a user profile avatar. Defaults to the active user if target is omitted.',
      source: 'maid-media-assets',
      permissions: [],
      riskLevel: 'medium',
      capabilities: {
        read: true,
        write: true,
        network: false,
        cost: 'none',
        undo: 'manual_restore_avatar',
        modelContext: 'allowlist',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', maxLength: 160 },
          userId: { type: 'string', maxLength: 160 },
          id: { type: 'string', maxLength: 160 },
          name: { type: 'string', maxLength: 160 },
          attachmentId: { type: 'string', maxLength: 160 },
          preparedImageId: { type: 'string', maxLength: 160 },
        },
      },
      safety: {
        operationType: 'set_avatar',
        destructive: 'conditional',
        preflight: buildAvatarSafetyPreflight({
          kind: 'user',
          store: userStore,
          resolveTarget: resolveUserTarget,
          snapshots: userAvatarPreflightSnapshots,
          title: '覆盖头像',
        }),
      },
      execute: makeAvatarSetter({
        kind: 'user',
        store: userStore,
        resolveTarget: resolveUserTarget,
        update: (target, avatar) => setStoreAvatar(userStore, target, avatar),
        snapshots: userAvatarPreflightSnapshots,
        targetLabel: '用户',
      }),
      summarizeResult: result => result?.ok
        ? `set user avatar ${trim(result?.target?.name, result?.target?.id || '-')}`
        : `set user avatar failed: ${trim(result?.reason, 'failed')}`,
    },
    {
      name: 'contact.set_avatar',
      title: 'Set contact avatar',
      description: 'Set an uploaded image as a chat contact/session avatar. Defaults to the current session contact if target is omitted.',
      source: 'maid-media-assets',
      permissions: [],
      riskLevel: 'medium',
      capabilities: {
        read: true,
        write: true,
        network: false,
        cost: 'none',
        undo: 'manual_restore_avatar',
        modelContext: 'allowlist',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', maxLength: 160 },
          contactId: { type: 'string', maxLength: 160 },
          sessionId: { type: 'string', maxLength: 160 },
          sessionName: { type: 'string', maxLength: 160 },
          chatName: { type: 'string', maxLength: 160 },
          name: { type: 'string', maxLength: 160 },
          attachmentId: { type: 'string', maxLength: 160 },
          preparedImageId: { type: 'string', maxLength: 160 },
        },
      },
      safety: {
        operationType: 'set_avatar',
        destructive: 'conditional',
        preflight: buildAvatarSafetyPreflight({
          kind: 'contact',
          store: contactsStore,
          resolveTarget: resolveContactTarget,
          snapshots: contactAvatarPreflightSnapshots,
          title: '覆盖联系人头像',
        }),
      },
      execute: makeAvatarSetter({
        kind: 'contact',
        store: contactsStore,
        resolveTarget: resolveContactTarget,
        snapshots: contactAvatarPreflightSnapshots,
        targetLabel: '联系人或聊天室',
        updateAvailable: () => typeof contactsStore?.upsertContact === 'function',
        updateUnavailableReason: 'contacts_store_unavailable',
        updateUnavailableMessage: '联系人写入能力不可用。',
        update: async (target, avatar) => {
          contactsStore.upsertContact({ id: target.id, avatar });
          return findStoreItem(contactsStore, target.id) || { ...target, avatar };
        },
        afterUpdate: target => refreshChatAndContacts?.({
          reason: 'maid_contact_avatar',
          sessionId: target.id,
        }),
      }),
      summarizeResult: result => result?.ok
        ? `set contact avatar ${trim(result?.target?.name, result?.target?.id || '-')}`
        : `set contact avatar failed: ${trim(result?.reason, 'failed')}`,
    },
    {
      name: 'session.set_wallpaper',
      title: 'Set chat wallpaper',
      description: 'Set an uploaded image as a chat session wallpaper. Defaults to the current session if target is omitted.',
      source: 'maid-media-assets',
      permissions: [],
      riskLevel: 'medium',
      capabilities: {
        read: true,
        write: true,
        network: false,
        cost: 'none',
        undo: 'manual_restore_wallpaper',
        modelContext: 'allowlist',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', maxLength: 160 },
          sessionId: { type: 'string', maxLength: 160 },
          sessionName: { type: 'string', maxLength: 160 },
          chatName: { type: 'string', maxLength: 160 },
          contactId: { type: 'string', maxLength: 160 },
          name: { type: 'string', maxLength: 160 },
          attachmentId: { type: 'string', maxLength: 160 },
          preparedImageId: { type: 'string', maxLength: 160 },
          opacity: { type: 'number', minimum: 0.1, maximum: 1 },
          fit: { type: 'string', maxLength: 40 },
        },
      },
      safety: {
        operationType: 'set_wallpaper',
        destructive: 'conditional',
        preflight: async (args = {}) => {
          const target = resolveSessionTarget(args);
          const sessionId = trim(target?.id);
          const snapshot = createWallpaperWriteSnapshot({ target, chatStore, contactsStore });
          if (args && typeof args === 'object') wallpaperPreflightSnapshots.set(args, snapshot);
          if (!sessionId || !snapshot.hasExistingWallpaper) {
            return { destructive: false, operationType: 'set_wallpaper' };
          }
          return {
            destructive: true,
            kind: 'session.wallpaper.replace',
            operationType: 'replace_existing',
            title: '覆盖聊天室壁纸',
            message: `聊天室「${trim(target.name || sessionId)}」已有壁纸。这个动作会替换现有壁纸。`,
            confirmText: '覆盖',
            cancelText: '取消',
            danger: true,
            details: {
              sessionId,
              targetScopeId: snapshot.chatScopeId,
            },
            onDeny: {
              action: 'skip',
              reason: 'destructive_write_cancelled',
            },
          };
        },
      },
      execute: async (args = {}, context = {}) => {
        const preflightSnapshot = args && typeof args === 'object'
          ? wallpaperPreflightSnapshots.get(args)
          : null;
        const initiallyResolved = preflightSnapshot?.sessionId
          ? (findStoreItem(contactsStore, preflightSnapshot.sessionId) || {
              id: preflightSnapshot.sessionId,
              name: preflightSnapshot.sessionId,
            })
          : resolveSessionTarget(args);
        const snapshot = preflightSnapshot || createWallpaperWriteSnapshot({
          target: initiallyResolved,
          chatStore,
          contactsStore,
        });
        let validation = validateWallpaperWriteSnapshot({ snapshot, chatStore, contactsStore });
        const target = validation.target || initiallyResolved;
        const sessionId = trim(target?.id);
        if (!sessionId) {
          return { ok: false, reason: 'session_not_found', message: '没有找到要设置壁纸的聊天室。' };
        }
        if (!validation.ok) {
          return buildWallpaperWriteConflict({ validation, target, sessionId, stage: 'confirm' });
        }
        if (!chatStore || typeof chatStore.setSessionSettings !== 'function') {
          return { ok: false, reason: 'chat_settings_unavailable', message: '聊天室设置写入能力不可用。' };
        }
        const existing = validation.settings || {};
        if ((existing?.wallpaper?.path || existing?.wallpaper?.url || existing?.chatBg) && !hasAllowedToolSafety(context, 'session.wallpaper.replace')) {
          const confirmed = typeof confirmDestructiveWrite === 'function'
            ? await confirmDestructiveWrite({
              kind: 'session.wallpaper.replace',
              title: '覆盖聊天室壁纸',
              message: `聊天室「${trim(target.name || sessionId)}」已有壁纸。这个动作会替换现有壁纸。`,
              confirmText: '覆盖',
              cancelText: '取消',
              danger: true,
              sessionId,
            })
            : false;
          if (confirmed !== true) {
            return {
              ok: false,
              skipped: true,
              reason: 'destructive_write_cancelled',
              sessionId,
              sessionName: trim(target?.name || sessionId),
            };
          }
        }
        validation = validateWallpaperWriteSnapshot({ snapshot, chatStore, contactsStore });
        if (!validation.ok) {
          return buildWallpaperWriteConflict({ validation, target, sessionId, stage: 'confirm' });
        }
        const image = await prepareAndCacheImage({ args, context, purpose: 'wallpaper', target });
        if (image?.ok === false) return image;
        validation = validateWallpaperWriteSnapshot({ snapshot, chatStore, contactsStore });
        if (!validation.ok) {
          return buildWallpaperWriteConflict({ validation, target, sessionId });
        }
        let saved = null;
        if (typeof saveWallpaper === 'function') {
          try {
            saved = await saveWallpaper({
              sessionId,
              dataUrl: image.dataUrl,
              fileName: image.name || 'wallpaper',
              mimeType: image.mime,
              previousPath: '',
            });
          } catch {}
        }
        validation = validateWallpaperWriteSnapshot({ snapshot, chatStore, contactsStore });
        if (!validation.ok) {
          const orphanPath = trim(saved?.path);
          if (orphanPath && typeof deleteWallpaper === 'function') {
            try { await deleteWallpaper({ sessionId, path: orphanPath }); } catch {}
          }
          return {
            ok: false,
            reason: validation.reason,
            message: '壁纸保存期间用户已更换目标壁纸，女仆结果未写回。',
            sessionId,
            sessionName: trim(target?.name || sessionId),
          };
        }
        const opacity = Math.max(0.1, Math.min(1, Number(args.opacity || 1) || 1));
        const wallpaper = saved?.path
          ? {
              path: trim(saved.path),
              name: image.name || 'wallpaper',
              zoom: 1,
              rotate: 0,
              offsetX: 0,
              offsetY: 0,
              width: image.width,
              height: image.height,
              opacity,
              updatedAt: Number(now?.() || Date.now()) || Date.now(),
              source: 'maid',
            }
          : {
              url: image.dataUrl,
              name: image.name || 'wallpaper',
              zoom: 1,
              rotate: 0,
              offsetX: 0,
              offsetY: 0,
              width: image.width,
              height: image.height,
              opacity,
              updatedAt: Number(now?.() || Date.now()) || Date.now(),
              transient: true,
              source: 'maid',
            };
        const nextSettings = {
          ...(validation.settings || {}),
          wallpaper,
        };
        delete nextSettings.chatBg;
        chatStore.setSessionSettings(sessionId, nextSettings);
        await applyChatSettings?.(sessionId, nextSettings);
        const previousPath = trim(snapshot.previousPath);
        if (
          previousPath &&
          previousPath !== trim(wallpaper.path) &&
          typeof deleteWallpaper === 'function'
        ) {
          try { await deleteWallpaper({ sessionId, path: previousPath }); } catch {}
        }
        await refreshChatAndContacts?.({ reason: 'maid_session_wallpaper', sessionId });
        return {
          ok: true,
          sessionId,
          sessionName: trim(target?.name || sessionId),
          persisted: Boolean(saved?.path),
          wallpaper: {
            path: trim(wallpaper.path),
            transient: wallpaper.transient === true,
            width: wallpaper.width,
            height: wallpaper.height,
            opacity: wallpaper.opacity,
          },
          image: publicImageMeta(image),
        };
      },
      summarizeResult: result => result?.ok
        ? `set wallpaper ${trim(result?.sessionName || result?.sessionId, '-')}`
        : `set wallpaper failed: ${trim(result?.reason, 'failed')}`,
    },
  ];
};

export const registerMaidMediaAssetTools = (registry, deps = {}) => {
  const tools = createMaidMediaAssetTools(deps);
  if (!registry || typeof registry.registerMany !== 'function') return tools;
  registry.registerMany(tools);
  return tools;
};
