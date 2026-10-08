// 女仆附件导入完成后，在结果里提供「打开」按钮：按导入成功的步骤打开对应的世界书、角色卡、预设、正则或脚本面板。
import { t } from '../i18n/index.js';

const trim = value => String(value ?? '').trim();
const MAX_ACTIONS = 3;

export const buildMaidImportOpenActions = (steps = [], openers = {}) => {
  const actions = [];
  const seen = new Set();
  const add = (key, label, open) => {
    if (seen.has(key) || typeof open !== 'function' || actions.length >= MAX_ACTIONS) return;
    seen.add(key);
    actions.push({ label, onClick: open });
  };
  (Array.isArray(steps) ? steps : []).forEach((step) => {
    if (trim(step?.toolName) !== 'attachment.import' || trim(step?.status) !== 'succeeded') return;
    const output = step.output || {};
    if (output.ok !== true && output.partial !== true) return;
    if (output.format === 'character_card' && trim(output.roleCardId)) {
      add(`card:${output.roleCardId}`, t('打开角色卡「{name}」', { name: trim(output.roleCardName) }), openers.roleCard && (() => openers.roleCard(output.roleCardId)));
    } else if (output.format === 'worldbook' && trim(output.worldbookId)) {
      add(`world:${output.worldbookId}`, t('打开世界书「{name}」', { name: trim(output.worldbookId) }), openers.worldbook && (() => openers.worldbook(output.worldbookId)));
    } else if (output.format === 'preset') {
      add('preset', t('打开预设'), openers.preset && (() => openers.preset(output.presetId)));
    } else if (output.format === 'regex') {
      add('regex', t('打开正则'), openers.regex && (() => openers.regex()));
    } else if (output.format === 'script') {
      add('script', t('打开脚本'), openers.script && (() => openers.script()));
    }
  });
  return actions;
};
