/* 女仆工具确认：原 app.js 的 requestMaidToolConfirmation 整块迁入，并新增卡内确认。
   - 能在运行卡里显示时（输入胶囊、执行流面板或语音托盘正在展示该 run），确认块直接出现在卡内；
   - 否则沿用原 appChoice 弹窗；卡内确认期间若所有承载面都关闭，自动改用弹窗，避免任务无人确认而挂起；
   - 语音只能给出“允许一次”，“始终允许”只在按钮上提供。 */

import { t } from '../i18n/index.js';
import { normalizeAppConfirmItems } from './app-confirm.js';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

export const MAID_CONFIRMATION_ACTIONS = Object.freeze(['deny', 'allow_once', 'allow_always']);

// 按工具声明的 operationType 分两档：删除 / 归档 / 覆盖为高风险，其余写入为需要确认；另给一个动作短标签
const DANGER_OPERATION_PATTERN = /^(delete|archive|replace)/;
const OPERATION_ACTION_LABELS = [
  [/^delete/, () => t('删除')],
  [/^archive/, () => t('归档')],
  [/^replace/, () => t('覆盖')],
  [/^create/, () => t('新建')],
  [/^(enable|disable|toggle)/, () => t('开关')],
  [/^switch/, () => t('切换')],
];

export const resolveMaidConfirmationTone = (request = {}) => {
  const operation = trim(request?.operationType).toLowerCase();
  const matched = OPERATION_ACTION_LABELS.find(([pattern]) => pattern.test(operation));
  return {
    tone: DANGER_OPERATION_PATTERN.test(operation) ? 'danger' : 'caution',
    actionLabel: matched ? matched[1]() : t('修改'),
  };
};

const describeRequest = (request = {}) => {
  // 只读意图升级确认：不吃 allow-always 捷径、也不提供「始终允许」——
  // 这是对单次意图误差的放行，不该沉淀成永久规则。
  const escalated = request?.escalation === 'read_only_write';
  const alwaysConfirm = request?.allowAlways === false;
  return {
    escalated,
    alwaysConfirm,
    allowAlways: !escalated && !alwaysConfirm,
    danger: request?.danger !== false,
    title: String(request?.title || '确认危险操作'),
    message: String(request?.message || '这个动作可能会覆盖、删除或替换已有内容。'),
    items: request?.details?.items,
    cancelLabel: String(request?.cancelText || '取消'),
    confirmLabel: alwaysConfirm ? String(request?.confirmText || '确认执行') : '允许一次',
    ...resolveMaidConfirmationTone(request),
  };
};

export const createMaidToolConfirmationRuntime = ({
  allowStore = null,
  choose = null,
  canShowInline = () => false,
  onChange = () => {},
  makeId = () => `maid_confirm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
} = {}) => {
  const entries = new Map();

  const notify = () => { try { onChange(); } catch {} };

  const toDecision = (action, request) => {
    if (action === 'allow_always' && describeRequest(request).allowAlways) {
      const rule = allowStore?.allowAlways?.(request);
      return { decision: 'allow', remembered: true, rule };
    }
    if (action === 'allow_once' || action === 'allow_always') return { decision: 'allow' };
    return { decision: 'deny' };
  };

  const openModal = (request, { signal = null } = {}) => {
    const info = describeRequest(request);
    return Promise.resolve(choose?.({
      title: info.title,
      message: info.message,
      items: info.items,
      defaultActionId: 'allow_once',
      danger: info.tone === 'danger',
      tone: info.tone,
      badge: info.actionLabel,
      signal,
      actions: [
        ...(info.allowAlways ? [{ id: 'allow_always', label: '始终允许', variant: 'link' }] : []),
        { id: 'deny', label: info.cancelLabel, variant: 'ghost' },
        { id: 'allow_once', label: info.confirmLabel, primary: true },
      ],
    }));
  };

  const settle = (entry, action) => {
    if (!entry || entry.settled) return false;
    entry.settled = true;
    entries.delete(entry.id);
    entry.cleanup?.();
    entry.modalController?.abort?.();
    entry.resolve(toDecision(MAID_CONFIRMATION_ACTIONS.includes(action) ? action : 'deny', entry.request));
    notify();
    return true;
  };

  const moveToModal = (entry) => {
    if (!entry || entry.settled || entry.mode === 'modal') return;
    entry.mode = 'modal';
    entry.modalController = typeof AbortController === 'function' ? new AbortController() : null;
    notify();
    void openModal(entry.request, { signal: entry.modalController?.signal || null })
      .then(action => settle(entry, action))
      .catch(() => settle(entry, 'deny'));
  };

  const request = async (rawRequest, { signal = null, runId = '' } = {}) => {
    const info = describeRequest(rawRequest);
    if (info.allowAlways && allowStore?.isAllowed?.(rawRequest)) {
      return { decision: 'allow', remembered: true };
    }
    if (signal?.aborted) return { decision: 'deny' };
    const targetRunId = trim(runId);
    if (!targetRunId || canShowInline(targetRunId) !== true) {
      return toDecision(await openModal(rawRequest, { signal }), rawRequest);
    }
    return new Promise((resolve) => {
      const entry = {
        id: makeId(),
        runId: targetRunId,
        request: rawRequest,
        mode: 'inline',
        settled: false,
        resolve,
        cleanup: null,
        modalController: null,
      };
      if (signal?.addEventListener) {
        const onAbort = () => settle(entry, 'deny');
        signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener?.('abort', onAbort);
      }
      entries.set(entry.id, entry);
      notify();
    });
  };

  const publicEntry = entry => {
    const info = describeRequest(entry.request);
    return {
      id: entry.id,
      runId: entry.runId,
      title: info.title,
      message: info.message,
      items: normalizeAppConfirmItems(info.items),
      danger: info.danger,
      allowAlways: info.allowAlways,
      confirmLabel: info.confirmLabel,
      cancelLabel: info.cancelLabel,
      tone: info.tone,
      actionLabel: info.actionLabel,
    };
  };

  const getInline = (runId = '') => {
    const target = trim(runId);
    for (const entry of entries.values()) {
      if (entry.mode === 'inline' && (!target || entry.runId === target)) return publicEntry(entry);
    }
    return null;
  };

  return {
    request,
    getInline,
    hasInline: runId => Boolean(getInline(runId)),
    resolve: (id, action) => settle(entries.get(trim(id)), action),
    // 语音确认只允许一次；只作用于指定 run 集合（当前通话接下的任务）里正在卡内等待的确认
    confirmByVoice: (runIds = []) => {
      const allowed = new Set((Array.isArray(runIds) ? runIds : [runIds]).map(item => trim(item)).filter(Boolean));
      for (const entry of entries.values()) {
        if (entry.mode === 'inline' && allowed.has(entry.runId)) return settle(entry, 'allow_once');
      }
      return false;
    },
    // 承载面变化后调用：不再有任何可见位置显示的卡内确认改用弹窗
    ensureVisible: () => {
      for (const entry of [...entries.values()]) {
        if (entry.mode === 'inline' && canShowInline(entry.runId) !== true) moveToModal(entry);
      }
    },
    getPendingCount: () => entries.size,
  };
};
