import { deriveMemoryStorageMode } from '../memory-storage-mode-utils.js';

// 只解析当前作用域的设置；创意写作的格式要求由当前会话提供。
export const resolveHopscotchBoardSettings = ({
  settings = {}, place = 'writing', replyCheck = {}, autoImageEnabled = false, variablesEnabled = false, variableActivity = null,
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
      independentModel: settings.memoryUpdateApiMode === 'profile',
      placeEnabled,
    },
    replyCheck: { ...replyCheck, enabled: replyCheck.enabled === true },
    autoImage: { enabled: scope === 'writing' && autoImageEnabled === true },
    variables: { enabled: variableActivity ? variableActivity.enabled : variablesEnabled === true, ...(variableActivity ? { activity: variableActivity } : {}) },
  };
};
