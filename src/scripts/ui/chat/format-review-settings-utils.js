import { t } from '../../i18n/index.js';

const trim = value => String(value ?? '').trim();

// 功能开关与本会话可用性分开；手动检查仍可使用 manual 模式。
export const resolveFormatReviewAvailability = (settings = {}, { place = 'chat', hasFormatGuide = false } = {}) => {
  let reason = '';
  if (settings.enabled !== true) reason = 'disabled';
  else if (place === 'writing' && !hasFormatGuide) reason = 'format_guide_missing';
  else if ((settings.triggerMode || 'auto') === 'manual') reason = 'manual_only';
  else if (!settings.modelMode || settings.modelMode === 'none' || (settings.modelMode === 'profile' && !trim(settings.modelProfileId))) reason = 'model_unavailable';
  return { enabled: !reason, reason };
};

// 显式编辑沿用既有会话格式档。身份随表单冻结，切角色/会话后旧表单不能写入。
export const createFormatGuideSettingsRuntime = ({
  getSessionId, getScopeId, getPlace, getProfile, getStore, notifyChanged = () => {},
} = {}) => {
  const context = () => ({ sessionId: trim(getSessionId()), scopeId: trim(getScopeId()), place: getPlace() });
  const read = () => {
    const current = context();
    const profile = current.place === 'writing' && current.sessionId ? getProfile(current.sessionId) : null;
    return {
      ...current,
      guide: String(profile?.guide || ''),
      usable: Boolean(trim(profile?.guide)) && profile?.usable !== false,
      stale: profile?.stale === true,
      revision: Number(profile?.updatedAt || 0),
    };
  };
  const save = (options = {}) => {
    const current = read();
    if (current.place !== 'writing' || !current.sessionId || options.sessionId !== current.sessionId || options.scopeId !== current.scopeId) {
      return { ok: false, message: t('会话已切换，请重新打开格式要求') };
    }
    if (Number(options.revision || 0) !== current.revision) return { ok: false, message: t('格式要求已更新，请重新打开后编辑') };
    const guide = trim(options.guide);
    if (guide.length > 6000) return { ok: false, message: t('格式要求最多 6000 字') };
    const store = getStore();
    if (!store) return { ok: false, message: t('格式要求暂时无法保存') };
    const saved = guide
      ? store.set(current.sessionId, { guide, manualOverride: true, confidence: 'high', sources: [{ type: 'user', ref: 'agent_center' }] })
      : (!current.guide || store.remove(current.sessionId));
    if (!saved) return { ok: false, message: t('格式要求保存失败，请重试') };
    notifyChanged(current.sessionId);
    return { ok: true, ...read() };
  };
  return { read, save };
};
