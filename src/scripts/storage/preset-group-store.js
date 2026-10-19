// 预设分类（像联系人分组）：只是本机整理，不写进预设文件，导出给别人的预设不带分类。
// 目前给 openai 类型（自定义提示词预设）用；一个预设只属于一个分类，没分的算「未分类」。
// kv 为主通道 + localStorage 镜像（同跳房子板存储）；预设删除后留下的 id 由 prune 清掉，选单只显示还在的预设。

import { normalizeContactGroupColor } from './contact-group-color-utils.js';

export const PRESET_GROUP_STORE_KEY = 'preset_groups_v1';
export const PRESET_GROUP_NAME_MAX = 24;
const STORE_VERSION = 1;

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const clone = value => JSON.parse(JSON.stringify(value));
const cleanName = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, PRESET_GROUP_NAME_MAX);
const cleanId = value => String(value ?? '').trim();

export const normalizePresetGroupState = (raw = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const ids = new Set();
  const names = new Set();
  const claimed = new Set();
  const groups = [];
  for (const item of Array.isArray(src.groups) ? src.groups : []) {
    if (!isPlainObject(item)) continue;
    const id = cleanId(item.id);
    const name = cleanName(item.name);
    if (!id || !name || ids.has(id) || names.has(name)) continue;
    ids.add(id);
    names.add(name);
    const presetIds = [];
    for (const presetId of Array.isArray(item.presetIds) ? item.presetIds : []) {
      const pid = cleanId(presetId);
      if (!pid || claimed.has(pid)) continue;
      claimed.add(pid);
      presetIds.push(pid);
    }
    groups.push({ id, name, color: normalizeContactGroupColor(item.color), presetIds });
  }
  return { version: STORE_VERSION, updatedAt: Number(src.updatedAt || 0) || 0, groups };
};

export const createPresetGroupStore = ({
  storage = globalThis?.localStorage || null,
  loadKv = null,
  saveKv = null,
  key = PRESET_GROUP_STORE_KEY,
  now = Date.now,
  createId = () => `pg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  onChange = null,
  logger = console,
} = {}) => {
  let state = null;

  const load = () => {
    if (state) return state;
    let raw = null;
    try {
      const text = storage?.getItem?.(key);
      raw = text ? JSON.parse(text) : null;
    } catch {}
    state = normalizePresetGroupState(raw || {});
    return state;
  };

  // kv 读取异常不等于没有数据，不据此回写空状态。
  const hydrate = async () => {
    load();
    if (typeof loadKv !== 'function') return state;
    try {
      const kvRaw = await loadKv(key);
      if (isPlainObject(kvRaw) && !kvRaw._tooLarge) {
        const kvState = normalizePresetGroupState(kvRaw);
        if (kvState.updatedAt >= state.updatedAt) state = kvState;
      }
    } catch (err) {
      logger?.debug?.('preset group kv hydrate skipped', err);
    }
    return state;
  };

  const save = async (next) => {
    const payload = { ...normalizePresetGroupState(next), updatedAt: Number(now()) || Date.now() };
    if (typeof saveKv === 'function') {
      try {
        await saveKv(key, clone(payload));
      } catch (err) {
        logger?.warn?.('preset group kv save failed', err);
        return { ok: false, reason: 'save_failed' };
      }
    }
    try { storage?.setItem?.(key, JSON.stringify(payload)); } catch {}
    state = payload;
    try { onChange?.(); } catch {}
    return { ok: true };
  };

  const getGroups = () => clone(load().groups);
  const getGroupOfPreset = (presetId) => {
    const pid = cleanId(presetId);
    const group = load().groups.find(item => item.presetIds.includes(pid));
    return group ? clone(group) : null;
  };
  const nameTaken = (name, exceptId = '') => load().groups.some(item => item.name === name && item.id !== exceptId);
  const updateGroup = async (groupId, patch) => {
    const id = cleanId(groupId);
    if (!load().groups.some(item => item.id === id)) return { ok: false, reason: 'group_missing' };
    return save({ ...state, groups: state.groups.map(item => (item.id === id ? { ...item, ...patch } : item)) });
  };

  const createGroup = async (name, color = '') => {
    const finalName = cleanName(name);
    if (!finalName) return { ok: false, reason: 'empty_name' };
    if (nameTaken(finalName)) return { ok: false, reason: 'duplicate_name' };
    const group = { id: cleanId(createId()), name: finalName, color: normalizeContactGroupColor(color), presetIds: [] };
    const result = await save({ ...state, groups: [...state.groups, group] });
    return result.ok ? { ok: true, group: clone(group) } : result;
  };

  const renameGroup = async (groupId, name) => {
    const finalName = cleanName(name);
    if (!finalName) return { ok: false, reason: 'empty_name' };
    if (nameTaken(finalName, cleanId(groupId))) return { ok: false, reason: 'duplicate_name' };
    return updateGroup(groupId, { name: finalName });
  };

  const setGroupColor = (groupId, color) => updateGroup(groupId, { color: normalizeContactGroupColor(color) });

  // 删除分类不删预设：里面的预设回到「未分类」。
  const deleteGroup = async (groupId) => {
    const id = cleanId(groupId);
    if (!load().groups.some(item => item.id === id)) return { ok: false, reason: 'group_missing' };
    return save({ ...state, groups: state.groups.filter(item => item.id !== id) });
  };

  // groupId 为空 = 移到「未分类」。
  const movePreset = async (presetId, groupId = '') => {
    const pid = cleanId(presetId);
    const target = cleanId(groupId);
    if (!pid) return { ok: false, reason: 'preset_missing' };
    if (target && !load().groups.some(item => item.id === target)) return { ok: false, reason: 'group_missing' };
    const groups = load().groups.map(item => {
      const presetIds = item.presetIds.filter(id => id !== pid);
      return { ...item, presetIds: item.id === target ? [...presetIds, pid] : presetIds };
    });
    return save({ ...state, groups });
  };

  const prune = async (existingIds = []) => {
    const alive = new Set((Array.isArray(existingIds) ? existingIds : []).map(cleanId));
    let changed = false;
    const groups = load().groups.map(item => {
      const presetIds = item.presetIds.filter(id => alive.has(id));
      if (presetIds.length !== item.presetIds.length) changed = true;
      return { ...item, presetIds };
    });
    if (!changed) return { ok: true, changed: false };
    const result = await save({ ...state, groups });
    return { ...result, changed: result.ok };
  };

  return {
    ready: hydrate(),
    hydrate,
    getGroups,
    getGroupOfPreset,
    createGroup,
    renameGroup,
    setGroupColor,
    deleteGroup,
    movePreset,
    prune,
  };
};

// 选单分段：分类按存储顺序，「未分类」放最后；分类内的预设沿用传入的预设顺序。
// 有搜索词时只留有命中的分段并全部展开；否则按 expanded 记录展开，没记录时只展开当前预设所在的分段。
export const buildPresetPickerSections = ({
  presets = [],
  groups = [],
  currentId = '',
  query = '',
  expanded = {},
  uncategorizedLabel = '',
} = {}) => {
  const q = String(query || '').trim().toLowerCase();
  const list = (Array.isArray(presets) ? presets : [])
    .filter(item => item && cleanId(item.id))
    .map(item => ({ id: cleanId(item.id), name: String(item.name || item.id) }));
  const groupList = Array.isArray(groups) ? groups : [];
  const owner = new Map();
  groupList.forEach(group => (group.presetIds || []).forEach(pid => { if (!owner.has(pid)) owner.set(pid, group.id); }));
  const current = cleanId(currentId);
  const toSection = (id, name, color, members) => {
    const items = members
      .filter(item => !q || item.name.toLowerCase().includes(q))
      .map(item => ({ ...item, selected: item.id === current }));
    const hasCurrent = members.some(item => item.id === current);
    const remembered = Object.prototype.hasOwnProperty.call(expanded || {}, id) ? Boolean(expanded[id]) : null;
    return {
      id, name, color, items, count: members.length,
      expanded: q ? true : (remembered ?? (hasCurrent || !groupList.length)),
    };
  };
  const sections = groupList.map(group => toSection(
    group.id, group.name, group.color, list.filter(item => owner.get(item.id) === group.id),
  ));
  const loose = list.filter(item => !owner.has(item.id));
  if (loose.length || !groupList.length) sections.push(toSection('', uncategorizedLabel, '', loose));
  return q ? sections.filter(section => section.items.length) : sections;
};
