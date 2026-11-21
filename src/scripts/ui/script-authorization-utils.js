import { buildTavernFeatureImportLine } from '../import/tavern-feature-report.js';

export const buildScriptPermissionLines = (settings = {}) => [
  `读取聊天记录：${settings.scriptAllowReadMessages !== false ? '允许' : '禁用'}`,
  `修改变量：${settings.scriptAllowModifyVariables !== false ? '允许' : '禁用'}`,
  `访问网络：${settings.scriptAllowNetwork === true ? '允许' : '禁用'}`,
];

export const buildScriptAuthorizationMessage = ({
  leadText = '检测到脚本。',
  settings = {},
  compatibility = null,
  // 导入兼容报告（script-store 导入结果的 tavernFeatures）；没有用到酒馆功能时不加这行
  tavernFeatures = null,
} = {}) => {
  const blockedCount = Math.max(0, Number(compatibility?.blockedCount) || 0);
  const hasCompatibilitySummary = compatibility && typeof compatibility === 'object' && blockedCount > 0;
  const runnableCount = hasCompatibilitySummary
    ? Math.max(0, Number(compatibility?.runnableCount) || 0)
    : null;
  const lines = [leadText];
  if (hasCompatibilitySummary) {
    lines.push(`兼容性预检：${runnableCount} 条可运行；${blockedCount} 条需要作为 SillyTavern 外部扩展安装，已保留但不会启用。`);
  }
  const tavernLine = buildTavernFeatureImportLine(tavernFeatures);
  if (tavernLine) lines.push(tavernLine);
  if (!hasCompatibilitySummary || runnableCount > 0) {
    lines.push(`${hasCompatibilitySummary ? '可运行脚本' : '脚本'}可能需要权限：\n- ${buildScriptPermissionLines(settings).join('\n- ')}`);
  }
  return lines.join('\n');
};
