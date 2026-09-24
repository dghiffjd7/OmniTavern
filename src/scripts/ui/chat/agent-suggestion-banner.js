import { t } from '../../i18n/index.js';

// 自动运行的回复 Agent（如“正文润色”）产出修改建议后，在输入框上方用与格式修复相同的横幅提示；
// 只展示当前会话里最新一条待查看的自动结果。手动运行的结果留在工具箱里，不重复提示。
// 当前会话由进房/退房流程通过 sync(sessionId) 告知，与格式修复横幅同步切换。

const ICON = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"></path><path d="m13.5 6.5 4 4"></path><path d="M19.5 15.5v3m-1.5-1.5h3"></path></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg>';

// 从任务列表中选出应展示的一条：当前会话、自动触发、状态为待查看；按创建时间取最新
export const pickAgentSuggestion = (jobs = [], { sessionId = '', dismissed = new Set() } = {}) => {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  const pending = (Array.isArray(jobs) ? jobs : [])
    .filter(job => job?.sessionId === sid && job.invocation === 'auto' && job.status === 'ready' && !dismissed.has(job.id))
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  if (!pending.length) return null;
  return { job: pending[pending.length - 1], others: pending.length - 1 };
};

export const describeAgentSuggestion = ({ job, others = 0 } = {}) => {
  const note = job?.outputMode === 'note';
  const count = Number(job?.changeCount) || 0;
  const summary = String(job?.message || '').trim();
  const fallback = note
    ? t('自动运行完成，结果待查看。')
    : (count ? t('{count} 处修改建议，可逐处审阅后应用。', { count }) : t('修改建议已就绪，可审阅后应用。'));
  const more = others > 0 ? t('另有 {count} 条建议待查看', { count: others }) : '';
  return {
    title: String(job?.title || '').trim() || t('Agent 建议'),
    chip: note ? t('Agent 结果') : t('修改建议'),
    text: [summary || fallback, more].filter(Boolean).join(' · '),
    primary: note ? t('查看结果') : t('查看修改'),
    secondary: note ? t('知道了') : t('忽略'),
  };
};

export const createAgentSuggestionBanner = ({
  container = null,
  before = null,
  runtime = null,
  openRun = null,
  documentRef = document,
} = {}) => {
  if (!container || !runtime) return { sync: () => false, render: () => false, dispose: () => {} };
  const win = documentRef.defaultView;
  const dismissed = new Set();
  let current = null;
  let activeSessionId = '';

  const root = documentRef.createElement('aside');
  root.className = 'format-repair-banner agent-suggestion-banner';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.hidden = true;
  root.innerHTML = `
    <div class="format-repair-banner-mark" aria-hidden="true">${ICON}</div>
    <div class="format-repair-banner-copy">
      <div class="format-repair-banner-head"><strong data-agent-suggestion-title></strong><em class="format-repair-banner-chip" data-agent-suggestion-chip></em></div>
      <span data-agent-suggestion-text></span>
    </div>
    <div class="format-repair-banner-actions">
      <button type="button" data-agent-suggestion-action="dismiss-job"></button>
      <button type="button" data-agent-suggestion-action="open"></button>
      <button type="button" class="format-repair-banner-dismiss" data-agent-suggestion-action="close" aria-label="${t('关闭提示')}" title="${t('关闭')}">${CLOSE_ICON}</button>
    </div>`;
  container.insertBefore(root, before && before.parentNode === container ? before : null);
  const titleEl = root.querySelector('[data-agent-suggestion-title]');
  const chipEl = root.querySelector('[data-agent-suggestion-chip]');
  const textEl = root.querySelector('[data-agent-suggestion-text]');
  const openButton = root.querySelector('[data-agent-suggestion-action="open"]');
  const secondaryButton = root.querySelector('[data-agent-suggestion-action="dismiss-job"]');

  const render = () => {
    const picked = pickAgentSuggestion(runtime.list(), { sessionId: activeSessionId, dismissed });
    current = picked?.job || null;
    root.hidden = !current;
    if (!current) return false;
    const view = describeAgentSuggestion(picked);
    root.dataset.agentId = current.agentId || '';
    titleEl.textContent = view.title;
    chipEl.textContent = view.chip;
    textEl.textContent = view.text;
    textEl.title = view.text;
    openButton.textContent = view.primary;
    secondaryButton.textContent = view.secondary;
    return true;
  };

  const onClick = (event) => {
    const action = event.target?.closest?.('[data-agent-suggestion-action]')?.dataset?.agentSuggestionAction;
    const job = current;
    if (!action || !job) return;
    event.preventDefault();
    if (action === 'open') {
      if (job.outputMode === 'note') {
        dismissed.add(job.id);
        openRun?.(job.agentId, job.id);
        render();
      } else {
        void runtime.open(job.id);
      }
      return;
    }
    // 忽略修改建议会作废该候选；笔记类结果只是不再提示，工具箱里仍可查看
    if (action === 'dismiss-job' && job.outputMode !== 'note') runtime.ignore(job.id);
    dismissed.add(job.id);
    render();
  };

  root.addEventListener('click', onClick);
  win.addEventListener('agent-text-edit-changed', render);

  return {
    root,
    render,
    sync: (sessionId = '') => { activeSessionId = String(sessionId || '').trim(); return render(); },
    dispose: () => {
      root.removeEventListener('click', onClick);
      win.removeEventListener('agent-text-edit-changed', render);
      root.remove();
    },
  };
};
