import {
  buildMaidFormatProfileSourceState,
  fingerprintMaidFormatProfileSource,
} from '../../storage/maid-format-profile-evidence-utils.js';

const PRESET_TYPES = Object.freeze(['sysprompt', 'context', 'instruct', 'openai', 'reasoning']);

const trim = value => String(value ?? '').trim();

// 预设内容指纹缓存：键为预设存储里的原对象，store.revision 变化即失效。
// 大预设（MB 级）每次整份序列化+哈希约 10–30ms，一次发送会解析几十次画像来源。
// sysprompt 会按界面语言本地化（语言切换不改 revision），不走缓存。
const presetFingerprintCache = new WeakMap();
const readCachedPresetFingerprint = (preset, revision) => {
  const hit = presetFingerprintCache.get(preset);
  if (hit && hit.revision === revision) return hit.fingerprint;
  const fingerprint = fingerprintMaidFormatProfileSource(preset);
  presetFingerprintCache.set(preset, { revision, fingerprint });
  return fingerprint;
};
const asArray = value => (Array.isArray(value) ? value : []);

const normalizeDeclaredSources = sources => asArray(sources)
  .map(item => ({ type: trim(item?.type).toLowerCase(), ref: trim(item?.ref) }))
  .filter(item => item.type || item.ref);

const compactPersonaValue = value => ({
  name: trim(value?.name),
  description: trim(value?.description),
  position: Number(value?.position || 0) || 0,
  depth: Number(value?.depth || 0) || 0,
  role: Number(value?.role || 0) || 0,
  source: value?.source && typeof value.source === 'object' ? value.source : trim(value?.source),
});

const compactCharacterValue = (contact, getContact) => ({
  name: trim(contact?.name),
  description: trim(contact?.description),
  source: contact?.source && typeof contact.source === 'object' ? contact.source : trim(contact?.source),
  members: asArray(contact?.members).map((memberId) => {
    const id = trim(memberId);
    const member = id && typeof getContact === 'function' ? getContact(id) : null;
    return { id, revision: Number(member?.updatedAt || 0) || 0 };
  }),
});

export const createMaidFormatProfileSourceStateResolver = ({
  presetStore = null,
  regexStore = null,
  personaStore = null,
  contactsStore = null,
  getUiMode = null,
  getRegexContext = null,
  getResolvedWorldState = null,
  getWorldInfoMetadata = null,
} = {}) => ({ sessionId = '', sources = [] } = {}) => {
  const sid = trim(sessionId);
  const uiMode = trim(typeof getUiMode === 'function' ? getUiMode(sid) : '') || 'chat';
  const context = { sessionId: sid, uiMode };
  const declaredSources = normalizeDeclaredSources(sources);
  const declaredPresetRefs = new Set(
    declaredSources.filter(item => item.type === 'preset').map(item => item.ref).filter(Boolean),
  );
  const presets = [];
  const presetKeys = new Set();
  const addPreset = (type, id, preset, source = '', contentFingerprint = '') => {
    const presetId = trim(id);
    if (!presetId || !preset || typeof preset !== 'object') return;
    const key = `${type}:${presetId}`;
    if (presetKeys.has(key)) return;
    presetKeys.add(key);
    presets.push({
      type,
      id: presetId,
      source,
      revision: Number(preset?.updatedAt || 0) || 0,
      value: preset,
      ...(contentFingerprint ? { contentFingerprint } : {}),
    });
  };
  PRESET_TYPES.forEach((type) => {
    if (presetStore?.getEnabled?.(type) === false) return;
    const canPeek = type !== 'sysprompt' && typeof presetStore?.peekResolvedActive === 'function';
    const resolved = (canPeek
      ? presetStore.peekResolvedActive(type, context)
      : presetStore?.getResolvedActive?.(type, context)) || {};
    const fingerprint = canPeek && resolved?.preset && typeof resolved.preset === 'object'
      ? readCachedPresetFingerprint(resolved.preset, resolved.revision)
      : '';
    addPreset(type, resolved?.presetId, resolved?.preset, resolved?.source, fingerprint);
    if (!declaredPresetRefs.size || typeof presetStore?.list !== 'function') return;
    asArray(presetStore.list(type)).forEach((preset) => {
      const id = trim(preset?.id);
      const name = trim(preset?.name);
      if (declaredPresetRefs.has(id) || declaredPresetRefs.has(name)) {
        addPreset(type, id, preset, 'declared');
      }
    });
  });

  const regexContext = typeof getRegexContext === 'function'
    ? (getRegexContext({ sessionId: sid, uiMode }) || context)
    : context;
  const regexRules = asArray(regexStore?.computeActiveRules?.(regexContext));

  const contact = contactsStore?.getContact?.(sid) || null;
  const isGroupChat = Boolean(contact?.isGroup) || sid.startsWith('group:');
  const worldState = typeof getResolvedWorldState === 'function'
    ? (getResolvedWorldState(sid, {
      uiMode,
      isGroupChat,
      groupMemberIds: asArray(contact?.members),
    }) || {})
    : {};
  const worldIds = new Set(asArray(worldState?.worldIds).map(trim).filter(Boolean));
  declaredSources
    .filter(item => item.type === 'worldbook' || item.type === 'world')
    .forEach(item => { if (item.ref) worldIds.add(item.ref); });
  const worldbooks = Array.from(worldIds).map((id) => {
    const metadata = typeof getWorldInfoMetadata === 'function' ? getWorldInfoMetadata(id) : null;
    return { id, ...(metadata && typeof metadata === 'object' ? metadata : {}) };
  });

  const activePersona = personaStore?.getActive?.() || null;
  return buildMaidFormatProfileSourceState({
    declaredSources,
    presets,
    regexRules,
    worldbooks,
    persona: activePersona ? {
      id: trim(activePersona.id),
      revision: Number(activePersona.updated || activePersona.updatedAt || 0) || 0,
      value: compactPersonaValue(activePersona),
    } : null,
    character: contact ? {
      id: trim(contact.id || sid),
      revision: Number(contact.updatedAt || 0) || 0,
      value: compactCharacterValue(contact, id => contactsStore?.getContact?.(id)),
    } : { id: sid, revision: 0, value: null },
  });
};
