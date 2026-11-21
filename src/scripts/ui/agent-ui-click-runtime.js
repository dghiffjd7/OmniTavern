import {
  buildElementUiSummary,
  isReadableElementVisible,
  readElementSemanticKey,
} from './agent-ui-inspect-utils.js';

const normalizeText = value => String(value || '').replace(/\s+/g, ' ').trim();

const readNodeLabel = node => normalizeText(
  node?.innerText || node?.textContent || node?.getAttribute?.('aria-label') || '',
).slice(0, 60);

const normalizePanelId = value => String(value || '').trim().toLowerCase().replace(/_/g, '-');

const isElementHitTarget = (documentRef, node) => {
  if (!node || typeof documentRef?.elementFromPoint !== 'function') return false;
  const rect = node.getBoundingClientRect?.();
  if (!rect) return false;
  const rawLeft = Number(rect.left);
  const rawTop = Number(rect.top);
  const rawRight = Number(rect.right);
  const rawBottom = Number(rect.bottom);
  if (![rawLeft, rawTop, rawRight, rawBottom].every(Number.isFinite)) return false;

  const viewportWidth = Number(documentRef?.defaultView?.innerWidth || documentRef?.documentElement?.clientWidth || 0);
  const viewportHeight = Number(documentRef?.defaultView?.innerHeight || documentRef?.documentElement?.clientHeight || 0);
  const left = Math.max(0, rawLeft);
  const top = Math.max(0, rawTop);
  const right = viewportWidth > 0 ? Math.min(viewportWidth, rawRight) : rawRight;
  const bottom = viewportHeight > 0 ? Math.min(viewportHeight, rawBottom) : rawBottom;
  if (right <= left || bottom <= top) return false;

  const width = right - left;
  const height = bottom - top;
  const points = [
    [left + width / 2, top + height / 2],
    [left + width * 0.2, top + height * 0.2],
    [left + width * 0.8, top + height * 0.2],
    [left + width * 0.2, top + height * 0.8],
    [left + width * 0.8, top + height * 0.8],
  ];
  return points.some(([x, y]) => {
    const hit = documentRef.elementFromPoint(x, y);
    return hit === node || Boolean(hit && node.contains?.(hit));
  });
};

const isAppConfirmationInteraction = (event) => {
  const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
  const nodes = path.length ? path : [event?.target];
  return nodes.some(node => Boolean(
    node &&
    typeof node.closest === 'function' &&
    // 运行卡内的确认（.mrc-approval：输入胶囊、执行流、语音托盘）与弹窗一样是这次工具调用自己的确认
    node.closest('.app-confirm-overlay, .app-confirm-modal, .mrc-approval')
  ));
};

export const createAgentUiClickRuntime = ({
  documentRef = globalThis?.document,
  getPanels = () => [],
  getState = () => ({}),
  buildElementSummary = buildElementUiSummary,
  isElementVisible = isReadableElementVisible,
  settleMs = 350,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) => {
  const refs = new Map();
  let inspectRevision = 0;
  let userInteractionRevision = 0;
  let confirmationDepth = 0;

  const markUserInteraction = (event) => {
    // 危险 UI 点击会在 inspect 与执行之间等待 appChoice；确认框内的选择是该
    // 工具调用本身的一部分，不能误判为用户改动了底层目标。只有工具显式持有
    // confirmation scope 时豁免；其他弹窗与确认框外操作仍照常令目标失效。
    if (confirmationDepth > 0 && isAppConfirmationInteraction(event)) return userInteractionRevision;
    userInteractionRevision += 1;
    return userInteractionRevision;
  };
  const beginConfirmation = () => {
    confirmationDepth += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      confirmationDepth = Math.max(0, confirmationDepth - 1);
    };
  };
  const interactionEvents = ['pointerdown', 'keydown', 'input'];
  interactionEvents.forEach(type => documentRef?.addEventListener?.(type, markUserInteraction, true));

  const buildVisiblePanelSummary = ({ panel = '', maxTextLength = 1800 } = {}) => {
    inspectRevision += 1;
    const revision = inspectRevision;
    refs.clear();
    const wanted = normalizePanelId(panel);
    const panelCandidates = getPanels?.();
    const panels = (Array.isArray(panelCandidates) ? panelCandidates : [])
      .filter(item => {
        const id = normalizePanelId(item?.id);
        return !wanted || id === wanted || item?.aliases?.some?.(alias => normalizePanelId(alias) === wanted);
      })
      .filter(item => isElementVisible(item?.element))
      .map((item) => {
        const panelId = normalizePanelId(item.id);
        const panelElement = item.element;
        const summary = buildElementSummary(panelElement, {
          maxTextLength,
          refPrefix: `${panelId}:r${revision}:`,
          collectRef: (ref, node) => refs.set(ref, {
            ref,
            node,
            panelElement,
            panelId,
            label: readNodeLabel(node),
            semanticKey: readElementSemanticKey(node),
            inspectRevision: revision,
            userInteractionRevision,
          }),
        });
        return {
          id: panelId,
          title: String(item.title || item.id || '').trim(),
          text: summary.text,
          buttons: summary.buttons,
          fields: summary.fields,
        };
      })
      .filter(item => item.text || item.buttons.length || item.fields.length);
    return {
      ok: true,
      ...(getState?.() || {}),
      inspectRevision: revision,
      panels,
    };
  };

  const describeElement = ({ ref = '' } = {}) => {
    const wantedRef = String(ref || '').trim();
    const record = wantedRef ? refs.get(wantedRef) : null;
    if (!record || record.inspectRevision !== inspectRevision) {
      return {
        ok: false,
        reason: 'ref_not_found',
        message: '元素引用已失效，请先重新 app.ui.inspect 获取最新 ref。',
      };
    }
    return {
      ok: true,
      ref: wantedRef,
      label: record.label,
      ...(record.semanticKey ? { semanticKey: record.semanticKey } : {}),
      panel: record.panelId,
      inspectRevision: record.inspectRevision,
    };
  };

  const clickElement = async ({ ref = '', label = '', panel = '' } = {}) => {
    let record = null;
    let matchedLabel = '';
    const wantedRef = String(ref || '').trim();
    if (wantedRef) {
      record = refs.get(wantedRef) || null;
      if (!record) {
        return {
          ok: false,
          reason: 'ref_not_found',
          message: '元素引用已失效，请先重新 app.ui.inspect 获取最新 ref。',
        };
      }
    } else {
      const wantedLabel = String(label || '').trim();
      if (!wantedLabel) return { ok: false, reason: 'missing_target', message: '需要 ref 或 label。' };
      const summary = buildVisiblePanelSummary({ panel });
      const matches = [];
      summary.panels.forEach((item) => {
        item.buttons.forEach((button) => {
          if (button.label === wantedLabel || button.label.includes(wantedLabel)) {
            matches.push({ ...button, panelId: item.id });
          }
        });
      });
      if (!matches.length) {
        return { ok: false, reason: 'label_not_found', message: `当前可见界面没有「${wantedLabel}」按钮。` };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          reason: 'ambiguous_label',
          message: `「${wantedLabel}」匹配到 ${matches.length} 个按钮，请改用 ref 指定。`,
          candidates: matches.map(item => ({ ref: item.ref, label: item.label, panel: item.panelId })),
        };
      }
      record = refs.get(matches[0].ref) || null;
      matchedLabel = matches[0].label;
      if (!record) return { ok: false, reason: 'ref_not_found', message: '元素引用已失效。' };
    }

    if (record.inspectRevision !== inspectRevision) {
      return { ok: false, reason: 'ref_not_found', message: '元素引用已被较新的 inspect 取代。' };
    }
    if (record.userInteractionRevision !== userInteractionRevision) {
      return {
        ok: false,
        reason: 'user_interaction_since_inspect',
        message: '用户在 inspect 后操作了界面，本次自动点击已暂停；请重新 inspect。',
      };
    }
    const node = record.node;
    if (!documentRef?.documentElement?.contains?.(node)) {
      return { ok: false, reason: 'element_detached', message: '目标元素已不在界面上，请重新 inspect。' };
    }
    if (record.panelElement?.contains && !record.panelElement.contains(node)) {
      return { ok: false, reason: 'element_replaced', message: '目标元素已被界面更新替换，请重新 inspect。' };
    }
    if (!isElementVisible(node)) {
      return { ok: false, reason: 'element_not_visible', message: '目标元素已不可见，请重新 inspect。' };
    }
    if (readNodeLabel(node) !== record.label) {
      return {
        ok: false,
        reason: 'element_changed_since_inspect',
        message: '目标按钮在 inspect 后发生变化，本次自动点击已取消。',
      };
    }
    if (node.disabled === true) {
      return { ok: false, reason: 'element_disabled', message: '目标按钮当前不可用（disabled）。' };
    }
    if (!isElementHitTarget(documentRef, node)) {
      return { ok: false, reason: 'element_occluded', message: '目标按钮被其他界面遮挡，请关闭遮挡层后重新 inspect。' };
    }
    const clickedLabel = matchedLabel || record.label;
    try {
      node.click();
    } catch (error) {
      return { ok: false, reason: 'click_failed', message: error?.message || '点击执行失败。' };
    }
    await wait(Math.max(0, Number(settleMs) || 0));
    return {
      ok: true,
      clicked: clickedLabel,
      after: buildVisiblePanelSummary({}),
    };
  };

  const dispose = () => {
    interactionEvents.forEach(type => documentRef?.removeEventListener?.(type, markUserInteraction, true));
    refs.clear();
    confirmationDepth = 0;
  };

  return {
    beginConfirmation,
    buildVisiblePanelSummary,
    clickElement,
    describeElement,
    dispose,
    markUserInteraction,
    getState: () => ({ inspectRevision, userInteractionRevision, confirmationDepth, refCount: refs.size }),
  };
};
