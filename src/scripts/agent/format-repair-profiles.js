import { normalizeAgentReferenceConfig } from './agent-reference-context.js';

const clone = value => JSON.parse(JSON.stringify(value));
const text = value => String(value ?? '').trim();
export const createFormatRepairProfileId = () => `repair-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
export const formatRepairProfileConfig = (value = {}) => ({
  modelMode: ['none', 'profile', 'follow_current'].includes(value.modelMode) ? value.modelMode : 'none',
  modelProfileId: text(value.modelProfileId), modelOverride: text(value.modelOverride),
  prompt: String(value.prompt ?? ''), formatGuide: String(value.formatGuide ?? ''),
  taskPromptMode: value.taskPromptMode === 'replace' ? 'replace' : 'append',
  blocks: (Array.isArray(value.blocks) ? value.blocks : []).slice(0, 12).map((block, index) => ({
    id: text(block.id) || `block-${index}`, name: text(block.name), text: String(block.text ?? ''),
    role: block.role === 'user' ? 'user' : 'system', enabled: block.enabled !== false,
  })),
  context: normalizeAgentReferenceConfig(value.context),
  maxTokens: Math.max(16, Math.min(16000, Math.trunc(Number(value.maxTokens)) || 6000)),
  repairCheckType: value.repairCheckType === 'tableEdit' ? 'tableEdit' : 'custom',
});

// Old configurations are projected without writing on read. Explicit saving is
// the migration point; the previous fields remain the automatic profile view.
export const normalizeFormatRepairProfiles = (library, fallback = {}) => {
  if (!library || !Array.isArray(library.items)) return { version: 1, automaticId: 'default', items: [
    { id: 'default', name: '默认方案', config: formatRepairProfileConfig(fallback), updatedAt: Number(fallback.updatedAt) || 0 },
  ], deletedIds: [] };
  const seen = new Set();
  const items = library.items.filter(item => {
    const id = text(item?.id); if (!id || seen.has(id) || id.length > 100) return false; seen.add(id); return true;
  }).map(item => ({ id: text(item.id), name: text(item.name).slice(0, 80) || '未命名方案',
    config: formatRepairProfileConfig(item.config), updatedAt: Number(item.updatedAt) || 0 }));
  return { version: 1, automaticId: library.automaticId == null ? null : text(library.automaticId), items,
    deletedIds: [...new Set((Array.isArray(library.deletedIds) ? library.deletedIds : []).map(text).filter(Boolean))],
    ...(library.partial === true ? { partial: true } : {}) };
};
export const mergeFormatRepairProfiles = (shared, local) => {
  if (!local?.partial) return clone(local || shared);
  const hidden = new Set(local.deletedIds), items = shared.items.filter(item => !hidden.has(item.id)).map(clone);
  for (const item of local.items) {
    const index = items.findIndex(row => row.id === item.id);
    if (index >= 0) items[index] = clone(item); else items.push(clone(item));
  }
  return { version: 1, items, deletedIds: [], automaticId: local.automaticId ?? shared.automaticId };
};
export const diffFormatRepairProfiles = (library, shared) => ({
  version: 1, partial: true,
  automaticId: library.automaticId === shared.automaticId ? null : library.automaticId,
  items: library.items.filter(item => {
    const inherited = shared.items.find(row => row.id === item.id);
    return !inherited || item.name !== inherited.name || JSON.stringify(item.config) !== JSON.stringify(inherited.config);
  }).map(clone),
  deletedIds: shared.items.filter(item => !library.items.some(row => row.id === item.id)).map(item => item.id),
});
export const resolveFormatRepairProfile = (config, profileId) => {
  if (!config || config.id !== 'reply_check') return config;
  const library = normalizeFormatRepairProfiles(config.repairProfiles, config);
  const id = profileId === undefined ? library.automaticId : profileId;
  const profile = library.items.find(item => item.id === id);
  return { ...config, ...(profile ? clone(profile.config) : { modelMode: 'none', modelProfileId: '', formatGuide: '' }),
    repairProfiles: library, repairProfileId: profile?.id || '', repairProfileName: profile?.name || '' };
};
export const saveFormatRepairProfileDraft = (config, { id, name, now = Date.now() } = {}) => {
  const library = normalizeFormatRepairProfiles(config.repairProfiles, config);
  const item = { id, name: text(name).slice(0, 80), config: formatRepairProfileConfig(config), updatedAt: now };
  const index = library.items.findIndex(profile => profile.id === id);
  if (index < 0) library.items.push(item); else library.items[index] = item;
  library.deletedIds = library.deletedIds.filter(value => value !== id);
  return resolveFormatRepairProfile({ ...config, repairProfiles: library });
};
export const formatRepairProfileTooLong = config => [config, ...(config.repairProfiles?.items || []).map(item => item.config)]
  .some(item => String(item.prompt || '').length > 16000 || String(item.formatGuide || '').length > 6000
    || item.blocks?.some(block => String(block.text || '').length > 16000));

export const createFormatRepairProfileDraft = (config, template = 'blank') => {
  const data = formatRepairProfileConfig(config);
  data.prompt = ''; data.formatGuide = ''; data.blocks = []; data.taskPromptMode = 'replace'; data.repairCheckType = 'custom';
  let name = '';
  if (template === 'tableEdit') {
    name = '表格指令'; data.repairCheckType = 'tableEdit';
    data.prompt = '检查所选回复中的 tableEdit，仅修复标签、指令语法与必要结构。保留原有表格内容，不改写正文。';
    data.formatGuide = 'tableEdit 标签应正确配对。insertRow、updateRow、deleteRow 的括号、参数与 JSON 结构必须完整；保留原有表格、行列和字段含义。';
  } else if (template === 'structure') {
    name = '回复结构'; data.prompt = '检查所选原文的标签配对与段落结构，修复格式错误，保留全部原有事实与内容。';
    data.formatGuide = '保留原有标签体系，修复可确定的拼写、闭合与嵌套错误，不补写故事内容。';
  }
  return { ...config, ...data, repairProfileId: createFormatRepairProfileId(), repairProfileName: name };
};
