// Shared document contract. Skill text is data; normalization never executes it.
export const MAID_SKILL_LIMITS = Object.freeze({ count: 100, title: 80, description: 1024, content: 16000, features: 12, bytes: 2 * 1024 * 1024, fileBytes: 128 * 1024, directory: 6000, context: 24000, selected: 3 });
export const skillClone = value => JSON.parse(JSON.stringify(value));
export const skillObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export const skillLength = value => Array.from(String(value ?? '')).length;
export const skillBytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
export const skillError = (code, details = {}) => Object.assign(new Error(code), { code, details });
export const makeMaidSkillId = () => `custom:${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
export const makeMaidSkillName = () => `skill-${Math.random().toString(36).slice(2, 10)}`;

export const normalizeMaidSkillMetadata = (value = {}) => {
  if (!skillObject(value)) throw skillError('skill_invalid_metadata');
  const visit = (item, depth = 0) => {
    if (depth > 10) throw skillError('skill_invalid_metadata');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (!skillObject(item)) throw skillError('skill_invalid_metadata');
    const result = {};
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw skillError('skill_invalid_metadata');
      result[key] = visit(child, depth + 1);
    }
    return result;
  };
  const result = visit(value);
  if (skillBytes(result) > 32768) throw skillError('skill_invalid_metadata');
  return result;
};

export const normalizeMaidSkillDraft = (value = {}) => {
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const description = typeof value.description === 'string' ? value.description.trim() : '';
  const content = typeof value.content === 'string' ? value.content : '';
  for (const [key, text] of Object.entries({ title, description, content })) {
    if (!text.trim() || skillLength(text) > MAID_SKILL_LIMITS[key]) throw skillError(`skill_invalid_${key}`);
  }
  if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw skillError('skill_invalid_name');
  if (value.featureIds !== undefined && !Array.isArray(value.featureIds)) throw skillError('skill_invalid_features');
  const featureIds = [...new Set((value.featureIds || []).map(id => String(id).trim()).filter(Boolean))];
  if (featureIds.length > MAID_SKILL_LIMITS.features || featureIds.some(id => id.length > 80)) throw skillError('skill_invalid_features');
  return { title, name, description, content, featureIds, enabled: value.enabled !== false, invocationMode: value.invocationMode === 'manual' ? 'manual' : 'auto', portableMetadata: normalizeMaidSkillMetadata(value.portableMetadata || {}) };
};

export const maidSkillContentKey = skill => JSON.stringify({
  title: skill.title, name: skill.name, description: skill.description, content: skill.content,
  featureIds: [...(skill.featureIds || [])].sort(), portableMetadata: skill.portableMetadata || {},
});

export const assertMaidSkillStoreSize = state => {
  if (state.skills.length > MAID_SKILL_LIMITS.count) throw skillError('skill_count_limit');
  if (skillBytes(state) > MAID_SKILL_LIMITS.bytes) throw skillError('skill_storage_limit');
  const ids = new Set(), names = new Set();
  for (const skill of state.skills) {
    if (ids.has(skill.id)) throw skillError('skill_duplicate_id');
    if (names.has(skill.name)) throw skillError('skill_duplicate_name');
    ids.add(skill.id); names.add(skill.name);
  }
};

// 单条记录损坏（手改数据、旧版本、导入工具写坏）只隔离这一条：原样保留、存盘时写回，
// 不让整个技能库和所有女仆任务一起失败；由设置面板提示并让用户决定是否删除。
export const normalizeMaidSkillStoreState = value => {
  if (value == null || (skillObject(value) && !Object.keys(value).length)) return { schemaVersion: 1, storeRevision: 0, skills: [], builtinOverrides: {}, quarantined: [] };
  if (!skillObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.skills) || !skillObject(value.builtinOverrides)) throw skillError('skill_store_invalid');
  const skills = [], quarantined = [], ids = new Set(), names = new Set();
  for (const item of value.skills) {
    try {
      if (!skillObject(item) || !/^custom:[a-zA-Z0-9-]{1,73}$/.test(item.id || '') || !Number.isSafeInteger(item.revision) || item.revision < 1) throw skillError('skill_store_invalid');
      const skill = { ...normalizeMaidSkillDraft(item), id: item.id, kind: 'custom', revision: item.revision,
        createdAt: Number(item.createdAt) || 0, updatedAt: Number(item.updatedAt) || 0,
        derivedFrom: skillObject(item.derivedFrom) ? normalizeMaidSkillMetadata(item.derivedFrom) : typeof item.derivedFrom === 'string' ? item.derivedFrom.slice(0, 80) : null,
        source: normalizeMaidSkillMetadata(item.source || { kind: 'local' }) };
      if (ids.has(skill.id)) throw skillError('skill_duplicate_id');
      if (names.has(skill.name)) throw skillError('skill_duplicate_name');
      ids.add(skill.id); names.add(skill.name); skills.push(skill);
    } catch (error) {
      quarantined.push({ raw: skillClone(item), reason: String(error?.code || 'skill_store_invalid') });
    }
  }
  const builtinOverrides = {};
  for (const [id, override] of Object.entries(value.builtinOverrides)) {
    if (!/^[a-z0-9_.-]{1,80}$/.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id) || !skillObject(override)) continue;
    builtinOverrides[id] = { enabled: override.enabled !== false, invocationMode: override.invocationMode === 'manual' ? 'manual' : 'auto' };
  }
  if (!Number.isSafeInteger(value.storeRevision) || value.storeRevision < 0) throw skillError('skill_store_invalid');
  return { schemaVersion: 1, storeRevision: value.storeRevision, skills, builtinOverrides, quarantined };
};

// 存盘格式：隔离的记录原样放回 skills，下次载入仍会被隔离，不会因为保存其他技能而丢失
export const toPersistedMaidSkillStoreState = state => ({
  schemaVersion: 1, storeRevision: state.storeRevision, builtinOverrides: state.builtinOverrides,
  skills: [...state.skills, ...(state.quarantined || []).map(item => item.raw)],
});
