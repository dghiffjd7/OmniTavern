export const ALLOWED_PERMISSIONS = new Set([
  'chat.read',
  'chat.write',
  'worldbook.read',
  'worldbook.write',
  'storage',
  'network',
  'prompt.modify',
  'ui.inject',
  'variables.read',
  'variables.write',
  // 用户工具（自定义工具、动作与手势）：写输入框或直接发送、用当前聊天的模型调用一次
  'input.write',
  'model.call',
]);

export const POWER_REQUIRED_PERMISSIONS = new Set([
  'worldbook.write',
  'network',
  'prompt.modify',
]);

export const RISKY_PERMISSIONS = new Map([
  ['chat.write', '修改聊天内容'],
  ['worldbook.write', '写入世界书'],
  ['variables.write', '修改变量'],
  ['prompt.modify', '修改提示词'],
  ['ui.inject', '注入 UI'],
  ['network', '网络访问'],
  ['input.write', '写入输入框或直接发送'],
  ['model.call', '调用模型（会产生费用）'],
]);

export const RISKY_PERMISSION_SET = new Set(RISKY_PERMISSIONS.keys());

export const isAllowedPermission = (perm) => ALLOWED_PERMISSIONS.has(perm);
export const isPowerRequired = (perm) => POWER_REQUIRED_PERMISSIONS.has(perm);
export const isRiskyPermission = (perm) => RISKY_PERMISSIONS.has(perm);
export const getRiskyDescription = (perm) => RISKY_PERMISSIONS.get(perm) || perm;
