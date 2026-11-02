// 提示词管家卡片（Agent Center「提示词」页最上方）：按「检查」跑只读规则检查，结果附「去处理」。
// Agent Center 只负责放进页面与在渲染后绑定；状态与文字都在这里。
import { t } from '../i18n/index.js';

const STYLE_ID = 'prompt-steward-style';
const STYLE = `
.ps-card { display: grid; gap: 10px; }
.ps-head { display: flex; align-items: center; gap: 10px; }
.ps-head > div { flex: 1; min-width: 0; }
.ps-findings { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.ps-finding { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 12px; background: var(--app-surface-subtle, #f8fafc); }
.ps-finding-text { flex: 1; min-width: 0; margin: 0; font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
.ps-finding.is-warning .ps-finding-text::before { content: '!'; display: inline-flex; width: 16px; height: 16px; margin-right: 6px; align-items: center; justify-content: center; border-radius: 50%; background: var(--app-warning-text, #b45309); color: var(--app-text-on-accent, #fff); font-size: 11px; font-weight: 800; vertical-align: 1px; }
`;

const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const trim = value => String(value ?? '').trim();

const SKIP_REASONS = {
  block_budget_exceeded: '这一块太长',
  scope_budget_exceeded: '启用的全局提示词总量超过上限',
  custom_chat_preset_anchor_skipped: '这个会话用的是自定义预设，这个位置不会加入',
};

export const describePromptFinding = (finding = {}) => {
  const p = finding.params || {};
  switch (finding.type) {
    case 'edited_default': return { text: t('「{title}」改过内置默认（预设「{preset}」）', { title: t(p.title), preset: p.presetName || t('当前预设') }), action: t('打开') };
    case 'duplicate_prompts': return {
      text: p.otherIsBuiltin
        ? t('全局提示词「{name}」与内置的「{other}」内容相同，会重复发送', { name: p.name, other: t(p.other) })
        : t('全局提示词「{name}」与「{other}」内容相同，会重复发送', { name: p.name, other: p.other }),
      action: t('全局提示词'),
    };
    case 'global_skipped': return { text: t('全局提示词「{name}」不会加入这个会话：{reason}', { name: p.name, reason: SKIP_REASONS[p.reason] ? t(SKIP_REASONS[p.reason]) : (p.message || p.reason) }), action: t('全局提示词') };
    case 'missing_variable': return {
      text: p.global
        ? t('「{sources}」读取全局变量「{name}」，但目前没有这个变量', { sources: (p.sources || []).map(name => t(name)).join('、'), name: p.name })
        : t('「{sources}」读取变量「{name}」，但这个会话目前没有这个变量', { sources: (p.sources || []).map(name => t(name)).join('、'), name: p.name }),
      action: t('变量'),
    };
    default: return { text: trim(finding.type), action: '' };
  }
};

const formatCheckedAt = (at) => {
  const time = Number(at);
  return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
};

/**
 * runAudit({ sessionId }) → { report, checkedAt }；openTarget(target) 打开对应位置；onChange() 让 Agent Center 重画。
 */
export const createPromptStewardController = ({
  documentRef = globalThis.document,
  runAudit = null,
  openTarget = null,
  onChange = () => {},
  getSessionId = () => '',
} = {}) => {
  let running = false, result = null, error = '';

  const ensureStyle = () => {
    if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
    const style = documentRef.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    documentRef.head.appendChild(style);
  };

  const renderHtml = () => {
    ensureStyle();
    const findings = result?.report?.findings || [];
    let status = t('只读检查当前会话会用到的提示词：改过的内置默认、重复内容、读取不到的变量、不会加入的全局提示词；不会修改提示词。');
    if (running) status = t('正在检查…');
    else if (error) status = t('检查失败：{message}', { message: error });
    else if (result) status = findings.length
      ? t('{time} 检查 · {count} 项', { time: formatCheckedAt(result.checkedAt), count: findings.length })
      : t('{time} 检查 · 没有发现问题', { time: formatCheckedAt(result.checkedAt) });
    const list = !running && findings.length ? `<ul class="ps-findings">${findings.map((finding, index) => {
      const described = describePromptFinding(finding);
      return `<li class="ps-finding${finding.severity === 'warning' ? ' is-warning' : ''}">`
        + `<p class="ps-finding-text" data-i18n-skip>${escapeHtml(described.text)}</p>`
        + (described.action && finding.target ? `<button type="button" class="agent-center-card-action" data-prompt-audit-target="${index}" data-i18n-skip>${escapeHtml(described.action)}</button>` : '')
        + '</li>';
    }).join('')}</ul>` : '';
    return `<article class="agent-center-card ps-card" data-prompt-steward>`
      + '<div class="ps-head"><div>'
      + `<div class="agent-center-card-title">${escapeHtml(t('提示词管家'))}</div>`
      + `<div class="agent-center-card-sub" data-i18n-skip>${escapeHtml(status)}</div>`
      + '</div>'
      + `<button type="button" class="agent-center-card-action is-primary" data-prompt-audit-run${running || typeof runAudit !== 'function' ? ' disabled' : ''}>${escapeHtml(t('检查'))}</button>`
      + `</div>${list}</article>`;
  };

  const run = async () => {
    if (running || typeof runAudit !== 'function') return;
    running = true; error = '';
    onChange();
    try {
      result = await runAudit({ sessionId: trim(getSessionId()) });
    } catch (err) {
      error = String(err?.message || err);
    } finally {
      running = false;
      onChange();
    }
  };

  const bind = (root) => {
    root?.querySelector?.('[data-prompt-audit-run]')?.addEventListener('click', () => void run());
    root?.querySelectorAll?.('[data-prompt-audit-target]')?.forEach((button) => {
      button.addEventListener('click', () => {
        const finding = result?.report?.findings?.[Number(button.dataset.promptAuditTarget)];
        if (finding?.target) void Promise.resolve(openTarget?.(finding.target));
      });
    });
  };

  return { renderHtml, bind, run, getResult: () => result };
};
