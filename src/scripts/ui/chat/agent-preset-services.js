// Agent「套用预设」与预设分类的界面服务：列预设、描述预设、打开选单（含移到分类／管理分类）、按 Agent 种类分派预览与试运行。
// app.js 只负责装配：传入预设存储、分类存储，并为各 Agent 注册 preview / trial 处理器。
import { describeTaskPreset } from './agent-task-preset.js';
import { openPresetPicker } from '../preset-picker.js';
import { openPresetGroupManager, openPresetMoveDialog } from '../preset-group-dialog.js';

const byName = (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id));

export const createAgentPresetServices = ({ presetStore = null, groupStore = null, onGroupsChanged = () => {}, askMaidToGroup = null } = {}) => {
  const handlers = new Map();

  // 与预设面板下拉同序（按名称）；只要 id 与名称，不复制预设正文。
  const listPresets = () => (presetStore?.listSummaries?.('openai') || [])
    .map(item => ({ id: item.id, name: String(item.name || item.id) }))
    .sort(byName);

  const describePreset = (presetId) => {
    const id = String(presetId || '').trim();
    const preset = id ? presetStore?.getPreset?.('openai', id) : null;
    if (!preset) return { ok: false, id };
    const group = groupStore?.getGroupOfPreset?.(id) || null;
    return {
      ok: true,
      id,
      name: String(preset.name || id),
      groupName: group?.name || '',
      groupColor: group?.color || '',
      describe: describeTaskPreset(preset),
    };
  };

  const groupsChanged = (extra) => {
    try { onGroupsChanged(); } catch {}
    try { extra?.(); } catch {}
  };

  // presets 可传入调用方筛过的列表（如会话配置只列适用的预设）；leadingOptions 为置顶的非预设选项
  const openPicker = ({ anchorEl, currentId = '', onSelect = () => {}, onGroupsChanged: onLocalChange = null, presets: only = null, leadingOptions = [] } = {}) => {
    const all = listPresets();
    const allowed = Array.isArray(only) ? new Set(only.map(item => String(item?.id ?? item?.value ?? ''))) : null;
    const presets = allowed ? all.filter(item => allowed.has(item.id)) : all;
    // 顺手清掉已删除预设留在分类里的 id；不等它，选单只显示还在的预设。
    void groupStore?.prune?.(all.map(item => item.id));
    return openPresetPicker({
      anchorEl,
      presets,
      groups: groupStore?.getGroups?.() || [],
      currentId,
      onSelect,
      leadingOptions,
      onMove: groupStore ? (presetId) => openPresetMoveDialog({
        store: groupStore,
        presetId,
        presetName: presets.find(item => item.id === presetId)?.name || presetId,
        onChanged: () => groupsChanged(onLocalChange),
      }) : null,
      onManage: groupStore ? () => openPresetGroupManager({
        store: groupStore,
        getPresets: listPresets,
        onChanged: () => groupsChanged(onLocalChange),
        onAskMaid: askMaidToGroup,
      }) : null,
    });
  };

  // 预设面板「分类」按钮：直接把当前预设移到某个分类。
  const openMoveDialog = ({ presetId = '', onChanged = null } = {}) => {
    if (!groupStore || !presetId) return null;
    return openPresetMoveDialog({
      store: groupStore,
      presetId,
      presetName: listPresets().find(item => item.id === presetId)?.name || presetId,
      onChanged: () => groupsChanged(onChanged),
    });
  };

  const registerHandler = (kind, handler) => { handlers.set(String(kind), handler || {}); };
  const dispatch = async (method, { kind = '', ...rest } = {}) => {
    const handler = handlers.get(String(kind))?.[method];
    if (typeof handler !== 'function') return { ok: false, message: '这个 Agent 还不能预览或试运行' };
    return handler(rest);
  };

  return {
    listPresets,
    describePreset,
    openPicker,
    openMoveDialog,
    registerHandler,
    preview: options => dispatch('preview', options),
    trial: options => dispatch('trial', options),
  };
};
