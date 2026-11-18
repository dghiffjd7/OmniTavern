// 女仆历史按轮管理（ROADMAP 29-③，参考 Noa docs/history-management-2026-10-16.md）：
// 任何一轮都能「不给女仆看／给女仆看」；最近一轮（文字、还没整理进记忆）可以删除或重新回答，都要点第二次才执行，
// 第一次点时列出这一轮改过什么——删除与重新回答不撤销已经做过的事。女仆正在回复时不能删除或重新回答。
// 历史面板与输入条的「前几轮」共用这一份规则。
import { t } from '../i18n/index.js';
import { listAppFeatures } from '../agent/app-feature-catalog.js';
import { isCatalogWriteTool } from '../agent/maid-result-cards.js';

const trim = value => String(value ?? '').trim();
const hasAttachments = context => Object.entries(context || {})
  .some(([key, value]) => /attachment|taskinputs/i.test(key) && Array.isArray(value) && value.length > 0);

/** 这一轮成功执行过的写入（工具说明的标题），用来在删除／重新回答前提醒不会撤销。 */
export const describeMaidRoundWrites = (turns = [], features = listAppFeatures()) => {
  const titles = [];
  (Array.isArray(turns) ? turns : []).forEach((turn) => {
    (turn?.resultBasis?.tools || []).forEach((tool) => {
      if (trim(tool?.status) !== 'succeeded' || !isCatalogWriteTool(features, trim(tool?.name))) return;
      const feature = features.find(item => item?.writes === true && (item.tools || []).includes(trim(tool.name)));
      const title = trim(feature?.title, trim(tool.name));
      if (!titles.includes(title)) titles.push(title);
    });
  });
  return titles;
};

/**
 * store：MaidConversationStore；isBusy()：女仆正在回复；regenerate(input)：用同样的话再问一次（调用方负责提交）。
 * actionsFor(entry) → [{ id, label, confirmLabel?, warning?, disabled?, title? }]；run(entry, id) 执行并返回是否改动了历史。
 */
export const createMaidHistoryRoundActions = ({ store, isBusy = () => false, regenerate = null } = {}) => {
  const latestTurnId = () => trim(store?.getLatestTurn?.()?.id);
  const isLatestTextRound = entry => entry?.kind === 'turn' && entry.turns?.length === 1
    && trim(entry.turns[0].id) === latestTurnId() && entry.turns[0].compacted !== true
    && entry.turns[0].responseType !== 'realtime' && !trim(entry.turns[0].context?.voiceCallId);
  const actionsFor = (entry) => {
    if (!entry || !Array.isArray(entry.turns) || !entry.turns.length || typeof store?.setTurnsHidden !== 'function') return [];
    const hidden = entry.turns.every(turn => turn?.hiddenFromMaid === true);
    const actions = [{ id: hidden ? 'unhide' : 'hide', label: hidden ? t('给女仆看') : t('不给女仆看') }];
    if (!isLatestTextRound(entry)) return actions;
    const busy = isBusy() === true;
    const writes = describeMaidRoundWrites(entry.turns);
    const warning = writes.length ? t('这一轮改过：{list}。删除或重新回答不会撤销这些改动。', { list: writes.join('、') }) : '';
    const turn = entry.turns[0];
    if (typeof regenerate === 'function' && trim(turn.input) && !hasAttachments(turn.context)) {
      actions.push({ id: 'regenerate', label: t('重新回答'), confirmLabel: t('再点一次重新回答'), warning, disabled: busy, title: busy ? t('女仆正在回复，稍后再操作') : '' });
    }
    actions.push({ id: 'delete', label: t('删除这一轮'), confirmLabel: t('再点一次删除'), warning, disabled: busy, title: busy ? t('女仆正在回复，稍后再操作') : '', danger: true });
    return actions;
  };
  const run = async (entry, id) => {
    const ids = (entry?.turns || []).map(turn => trim(turn?.id)).filter(Boolean);
    if (!ids.length) return false;
    if (id === 'hide' || id === 'unhide') return (await store.setTurnsHidden(ids, id === 'hide')) > 0;
    if (!['delete', 'regenerate'].includes(id) || isBusy() === true || !isLatestTextRound(entry)) return false;
    const removed = await store.deleteLatestTurn(ids[0]);
    if (!removed) return false;
    if (id === 'regenerate') await regenerate?.(trim(removed.input));
    return true;
  };
  return { actionsFor, run };
};
