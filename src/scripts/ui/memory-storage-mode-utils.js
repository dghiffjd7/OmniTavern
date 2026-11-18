const normalizeStoredMode = (value = '') => {
  const mode = String(value || 'table').trim().toLowerCase();
  return mode === 'table' ? 'table' : 'summary';
};

const normalizeUiMode = (value = '') => {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'off') return 'off';
  if (mode === 'summary') return 'summary';
  return 'table';
};

const createDetailEvent = (type, detail) => {
  if (typeof globalThis.CustomEvent === 'function') {
    return new globalThis.CustomEvent(type, { detail });
  }
  return { type, detail };
};

export const deriveMemoryStorageMode = (settings = {}) => {
  if (settings?.memoryEnabled === false) return 'off';
  return normalizeStoredMode(settings?.memoryStorageMode);
};

// 写表方式（同回复 / 独立请求）按场景各存一份：写作单独一份，聊天与动态共用原来的键。
// 设定页与跳房子板读写同一份值，板不再自己保存记忆形态。
export const getMemoryAutoExtractModeKey = (place = 'chat') => (
  String(place || '').trim().toLowerCase() === 'writing' ? 'memoryAutoExtractModeWriting' : 'memoryAutoExtractMode'
);

const normalizeAutoExtractMode = value => (String(value || '').trim().toLowerCase() === 'separate' ? 'separate' : 'inline');

export const resolveMemoryAutoExtractMode = (settings = {}, place = 'chat') => {
  const key = getMemoryAutoExtractModeKey(place);
  const value = settings?.[key] ?? settings?.memoryAutoExtractMode;
  return normalizeAutoExtractMode(value);
};

export const applyMemoryStorageMode = ({
  mode = 'table',
  appSettings = null,
  dispatchEvent = null,
} = {}) => {
  if (!appSettings || typeof appSettings.update !== 'function') return null;
  const nextMode = normalizeUiMode(mode);
  const current = typeof appSettings.get === 'function' ? appSettings.get() : {};
  const patch = nextMode === 'off'
    ? { memoryEnabled: false }
    : { memoryEnabled: true, memoryStorageMode: nextMode };
  const updated = appSettings.update(patch) || { ...(current || {}), ...patch };
  const storedMode = normalizeStoredMode(updated?.memoryStorageMode ?? current?.memoryStorageMode);
  if (typeof dispatchEvent === 'function') {
    dispatchEvent(createDetailEvent('memory-storage-mode-changed', { mode: nextMode }));
    dispatchEvent(createDetailEvent('app-settings-changed', {
      key: 'memoryEnabled',
      value: nextMode !== 'off',
    }));
    dispatchEvent(createDetailEvent('app-settings-changed', {
      key: 'memoryStorageMode',
      value: storedMode,
    }));
  }
  return nextMode;
};
