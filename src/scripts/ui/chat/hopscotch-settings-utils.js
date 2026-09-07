import { deriveMemoryStorageMode } from '../memory-storage-mode-utils.js';

// 只解析当前作用域的设置，不保存配置或将聊天功能扩展到创意写作。
export const resolveHopscotchBoardSettings = ({
  settings = {}, place = 'writing', replyCheck = {}, autoImageEnabled = false, variablesEnabled = false,
} = {}) => {
  const scope = place === 'chat' ? 'chat' : 'writing';
  const placeEnabled = scope === 'writing'
    ? settings.memoryTableEnabledWriting !== false
    : settings.memoryTableEnabledChat !== false;
  const storageMode = deriveMemoryStorageMode(settings);
  return {
    place: scope,
    memory: {
      storageMode: storageMode === 'table' && !placeEnabled ? 'off' : storageMode,
      autoExtract: settings.memoryAutoExtract === true,
      autoExtractMode: settings.memoryAutoExtractMode,
      placeEnabled,
    },
    replyCheck: { ...replyCheck, enabled: scope === 'chat' && replyCheck.enabled === true },
    autoImage: { enabled: scope === 'writing' && autoImageEnabled === true },
    variables: { enabled: variablesEnabled === true },
  };
};
