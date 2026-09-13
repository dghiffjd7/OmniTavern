import { t } from '../i18n/index.js';

const e = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const labels = { running: '处理中', ready: '修改建议待查看', reviewing: '正在查看', applied: '已应用', ignored: '已收起', expired: '已过期', cancelled: '已取消', failed: '失败', unchanged: '无需修改', succeeded: '已完成', skipped: '未执行', waiting_permission: '等待确认' };
const statuses = { running: '进行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', waiting_permission: '等待确认', skipped: '已跳过' };
const installStyle = doc => {
  if (doc.getElementById('agent-run-cards-style')) return;
  const style = doc.createElement('style'); style.id = 'agent-run-cards-style';
  style.textContent = `
  .agent-config-editor .ac-run-stack{display:grid;gap:10px}.agent-config-editor .ac-run-card{border:1px solid var(--app-border-default);border-radius:16px;background:var(--app-surface-card);overflow:hidden;padding:12px;min-width:0;animation:ac-run-arrive .18s cubic-bezier(.22,1,.36,1) both}.agent-config-editor .ac-run-head{display:flex;gap:8px;align-items:center;min-height:24px}.agent-config-editor .ac-run-dot{width:7px;height:7px;border-radius:50%;background:var(--app-text-muted,#888);flex-shrink:0}.agent-config-editor .ac-run-card[data-status=running] .ac-run-dot{background:var(--app-accent-primary)}.agent-config-editor .ac-run-card[data-status=ready] .ac-run-dot,.agent-config-editor .ac-run-card[data-status=applied] .ac-run-dot,.agent-config-editor .ac-run-card[data-status=succeeded] .ac-run-dot{background:var(--app-success-text,#228669)}.agent-config-editor .ac-run-card[data-status=failed] .ac-run-dot{background:var(--app-danger-text,#c45666)}.agent-config-editor .ac-run-head strong{font-size:12px;font-weight:600}.agent-config-editor .ac-run-head time{font-size:10px;color:var(--app-text-secondary);margin-left:auto;font-variant-numeric:tabular-nums}.agent-config-editor .ac-run-message{font-size:12px;margin-top:8px;line-height:1.65;color:var(--app-text-secondary);overflow-wrap:anywhere}.agent-config-editor .ac-run-card>.ac-actions:not(:empty){margin-top:10px}
  .agent-config-editor .ac-run-card details{padding-top:0;margin-top:8px}.agent-config-editor .ac-run-card summary{font-size:12px;font-weight:500;display:flex;align-items:center;gap:8px;margin-bottom:0}.agent-config-editor .ac-run-card summary::before{content:'›';font-size:17px;color:var(--app-text-secondary);transition:transform .16s;display:inline-block}.agent-config-editor .ac-run-card details[open]>summary::before{transform:rotate(90deg)}.agent-config-editor .ac-run-card details[data-ac-expanding=false]>summary::before{transform:rotate(0deg)}.agent-config-editor .ac-run-card summary::-webkit-details-marker{display:none}.agent-config-editor .ac-run-card summary>small{margin-left:auto;color:var(--app-text-secondary);font-size:10px}
  .agent-config-editor .ac-run-timeline{display:grid;gap:8px;margin:0 0 0 3px;padding:0 0 0 14px;border-left:1px solid var(--app-border-default)}.agent-config-editor .ac-run-step{position:relative;border:1px solid var(--app-border-default)!important;border-radius:12px;padding:0 10px!important;margin:0!important;min-width:0;background:var(--app-surface-subtle)}.agent-config-editor .ac-run-step::before{content:'';position:absolute;left:-19px;top:19px;width:7px;height:7px;background:var(--app-surface-card);border:1px solid var(--app-border-default);border-radius:50%}.agent-config-editor .ac-run-step[data-status=succeeded]::before{background:var(--app-success-text,#228669);border-color:transparent}.agent-config-editor .ac-run-step[data-status=running]::before{background:var(--app-accent-primary);border-color:transparent}.agent-config-editor .ac-run-step[data-status=failed]::before{background:var(--app-danger-text,#c45666);border-color:transparent}.agent-config-editor .ac-run-step summary>span{overflow-wrap:anywhere;min-width:0;flex:1}.agent-config-editor .ac-run-step summary>small{white-space:nowrap}.agent-config-editor .ac-run-detail{padding-bottom:10px;display:grid;gap:6px}.agent-config-editor .ac-run-detail:empty{display:none}.agent-config-editor .ac-run-detail>span{font-size:10px;color:var(--app-text-secondary)}.agent-config-editor .ac-run-detail pre,.agent-config-editor .ac-run-note{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:10px;border-radius:9px;background:var(--app-surface-card);font:12px/1.75 var(--app-font-family,inherit);max-height:220px;overflow:auto;overscroll-behavior:contain}.agent-config-editor .ac-run-note{margin-top:8px;background:var(--app-surface-subtle);max-height:260px}.agent-config-editor .ac-run-reasoning .ac-run-detail pre{background:var(--app-surface-subtle);color:var(--app-text-secondary)}.agent-config-editor .ac-run-limits{font-size:10px;color:var(--app-text-secondary);margin-top:8px}
  @keyframes ac-run-arrive{from{opacity:.3;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
  @media(prefers-reduced-motion:reduce){.agent-config-editor .ac-run-card{animation:none!important}.agent-config-editor .ac-run-card summary::before{transition:none!important}}
  body[data-reduced-motion=on] .agent-config-editor .ac-run-card{animation:none!important}body[data-reduced-motion=on] .agent-config-editor .ac-run-card summary::before{transition:none!important}
  `; doc.head.append(style);
};

// Only five recent runs and bounded provider traces. Long details are mounted on expansion.
export const createAgentRunCards = ({ host, button, onStatus = () => {}, state = null }) => {
  const doc = host.ownerDocument; installStyle(doc); host.classList.add('ac-run-stack');
  let jobs = [], input = false, alive = true;
  const cards = new Map(), openKeys = new Set(state?.open || []);
  const remember = () => {
    host.querySelectorAll('[data-ac-run-detail]').forEach(detail => {
      const key = detail.dataset.acRunDetail; detail.open ? openKeys.add(key) : openKeys.delete(key);
    });
  };
  const body = (step, reasoning = '') => {
    if (reasoning) return `<pre data-i18n-skip="true" tabindex="0">${e(reasoning.slice(0, 16000))}</pre>`;
    const parts = [['输入', step.input], ['结果', step.output], ['', step.detail]].filter(([, value]) => value !== undefined && value !== null && value !== '');
    return parts.map(([title, value]) => `${title ? `<span>${e(t(title))}</span>` : ''}<pre data-i18n-skip="true" tabindex="0">${e((typeof value === 'string' ? value : JSON.stringify(value, null, 2)).slice(0, 6000))}</pre>`).join('');
  };
  const trace = job => {
    const data = job.trace || {}, steps = (data.steps || []).slice(0, 32), key = `${job.id}:trace`, expanded = openKeys.has(key);
    if (!steps.length && !data.reasoning) return '';
    const calls = steps.filter(step => step.kind === 'tool').length;
    return `<details data-ac-run-detail="${e(key)}" ${expanded ? 'open' : ''}><summary>${e(t('执行过程'))}<small>${e(calls ? t('{steps} 步 · {tools} 次工具', { steps: steps.length, tools: calls }) : t('{count} 步', { count: steps.length }))}</small></summary><div data-ac-run-trace-body>${expanded ? traceBody(job) : ''}</div></details>`;
  };
  const traceBody = job => {
    const data = job.trace || {}, steps = (data.steps || []).slice(0, 32), reasoningKey = `${job.id}:reasoning`;
    return `<div class="ac-run-timeline">${steps.map((step, index) => {
      const key = `${job.id}:step:${step.id || index}`, expanded = openKeys.has(key);
      const duration = Number.isFinite(step.durationMs) ? `${(step.durationMs / 1000).toFixed(1)}s` : '';
      return `<details class="ac-run-step" data-status="${e(step.status)}" data-ac-step-index="${index}" data-ac-run-detail="${e(key)}" ${expanded ? 'open' : ''}><summary><span>${e(t(step.label || (step.kind === 'tool' ? '调用工具' : '模型处理')))}</span><small>${e([t(statuses[step.status] || step.status || ''), duration].filter(Boolean).join(' · '))}</small></summary><div class="ac-run-detail">${expanded ? body(step) : ''}</div></details>`;
    }).join('')}</div>${data.reasoning ? `<details class="ac-run-reasoning" data-ac-run-detail="${e(reasoningKey)}" ${openKeys.has(reasoningKey) ? 'open' : ''}><summary><span class="has-help" tabindex="0" data-help-mode="tap" data-help="${e(t('显示模型返回的思考内容或思考摘要。'))}">${e(t('模型思考'))}</span></summary><div class="ac-run-detail">${openKeys.has(reasoningKey) ? body({}, data.reasoning) : ''}</div></details>` : ''}${data.truncated ? `<div class="ac-run-limits">${e(t('较长的执行详情已截取'))}</div>` : ''}`;
  };
  const update = (nextJobs, { isInput = false } = {}) => {
    if (!alive) return; remember(); jobs = nextJobs.slice(0, 5); input = isInput;
    const ids = new Set(jobs.map(job => job.id));
    for (const [id, entry] of cards) if (!ids.has(id)) { entry.node.remove(); cards.delete(id); }
    for (const [index, job] of jobs.entries()) {
      const signature = JSON.stringify(job); let entry = cards.get(job.id);
      if (!entry) { const node = doc.createElement('article'); node.className = 'ac-run-card'; node.dataset.acRunId = job.id; entry = { node, signature: '' }; cards.set(job.id, entry); }
      if (entry.signature !== signature) {
        entry.signature = signature; const card = entry.node;
        const focused = card.contains(doc.activeElement) ? doc.activeElement : null;
        const focusAction = focused?.dataset.ac, focusDetail = focused?.tagName === 'SUMMARY' ? focused.parentElement.dataset.acRunDetail : '';
        const scrolls = [...card.querySelectorAll('[data-ac-run-detail]')].map(detail => ({ key: detail.dataset.acRunDetail, positions: [...detail.querySelectorAll('pre')].map(pre => pre.scrollTop) }));
        const note = input ? job.kind === 'note' : job.outputMode === 'note';
        const label = job.status === 'ready' && note ? '资料与建议' : labels[job.status] || job.status;
        const date = job.createdAt ? new Date(job.createdAt) : null;
        const time = date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        card.dataset.status = job.status;
        card.innerHTML = `<header class="ac-run-head"><span class="ac-run-dot" aria-hidden="true"></span><strong>${e(t(label))}</strong>${time ? `<time>${e(time)}</time>` : ''}</header>${job.message ? `<div class="ac-run-message">${e(t(job.message))}</div>` : ''}${job.text && (input || note) ? `<pre class="ac-run-note" data-i18n-skip="true" tabindex="0">${e(job.text)}</pre>` : ''}${trace(job)}<div class="ac-actions">${job.status === 'ready' ? (note ? `<button type="button" class="agent-center-card-action" data-ac-copy-note="${e(job.id)}">${e(t('复制结果'))}</button>` + button(`${input ? 'input-ignore' : 'ignore'}:${job.id}`, '收起结果') : input ? button(`input-apply:${job.id}`, job.kind === 'rewrite' ? '查看修改' : '采纳') + button(`input-ignore:${job.id}`, '收起结果') : button(`review:${job.id}`, '查看修改') + button(`ignore:${job.id}`, '忽略')) : job.status === 'running' ? button(`${input ? 'input-cancel' : 'cancel'}:${job.id}`, '取消') : ''}</div>`;
        for (const detail of card.querySelectorAll('[data-ac-run-detail]')) {
          const prior = scrolls.find(item => item.key === detail.dataset.acRunDetail);
          detail.querySelectorAll('pre').forEach((pre, index) => { if (prior) pre.scrollTop = prior.positions[index] || 0; });
          if (focusDetail === detail.dataset.acRunDetail) detail.querySelector('summary')?.focus({ preventScroll: true });
        }
        if (focusAction) [...card.querySelectorAll('[data-ac]')].find(button => button.dataset.ac === focusAction)?.focus({ preventScroll: true });
      }
      if (host.children[index] !== entry.node) host.insertBefore(entry.node, host.children[index] || null);
    }
  };
  const toggle = event => {
    const detail = event.target, key = detail.dataset.acRunDetail; if (!key) return;
    detail.open ? openKeys.add(key) : openKeys.delete(key);
    if (!detail.open) return;
    const card = detail.closest('[data-ac-run-id]'), job = jobs.find(item => item.id === card?.dataset.acRunId); if (!job) return;
    if (key === `${job.id}:trace`) detail.querySelector('[data-ac-run-trace-body]').innerHTML = traceBody(job);
    else if (key === `${job.id}:reasoning`) detail.querySelector('.ac-run-detail').innerHTML = body({}, job.trace?.reasoning);
    else if (detail.hasAttribute('data-ac-step-index')) detail.querySelector('.ac-run-detail').innerHTML = body(job.trace?.steps[Number(detail.dataset.acStepIndex)] || {});
  };
  const copy = async event => {
    const id = event.target.closest('[data-ac-copy-note]')?.dataset.acCopyNote; if (!id) return;
    const text = jobs.find(job => job.id === id)?.text; if (!text) return;
    try {
      if (doc.defaultView.navigator.clipboard?.writeText) await doc.defaultView.navigator.clipboard.writeText(text);
      else { const area = doc.createElement('textarea'); area.value = text; area.style.cssText = 'position:fixed;left:-9999px'; doc.body.append(area); area.select(); const ok = doc.execCommand('copy'); area.remove(); if (!ok) throw Error('复制失败'); }
      if (alive) onStatus(t('已复制'));
    } catch { if (alive) onStatus(t('复制失败')); }
  };
  host.addEventListener('toggle', toggle, true); host.addEventListener('click', copy);
  return { update, snapshot: () => { remember(); return { open: [...openKeys] }; }, dispose: () => { alive = false; host.removeEventListener('toggle', toggle, true); host.removeEventListener('click', copy); cards.clear(); } };
};
