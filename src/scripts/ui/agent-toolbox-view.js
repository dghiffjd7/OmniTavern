import { t } from '../i18n/index.js';
import { agentIconMarkup, getAgentIconName } from '../agent/agent-icons.js';

export const toolboxEscape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
export const toolboxButton = (key, label, { icon, primary = false, disabled = false } = {}) => `<button type="button" data-key="${toolboxEscape(key)}"${disabled ? ' disabled' : ''} class="${primary ? 'at-primary' : ''}"${icon ? ` aria-label="${toolboxEscape(t(label))}" title="${toolboxEscape(t(label))}"` : ''}>${icon ? agentIconMarkup(icon) : toolboxEscape(t(label))}</button>`;
export const toolboxNamedIcon = config => `<span class="at-named-icon" aria-hidden="true">${agentIconMarkup(getAgentIconName(config))}</span>`;

export const toolboxManagementMarkup = ({ items, catalog, ordering, shortcut, recording, shortcutError, expanded }) => {
  const e = toolboxEscape, button = toolboxButton, visibleIds = items.map(config => config.id);
  const hidden = catalog.filter(config => !visibleIds.includes(config.id));
  const row = (config, visible) => {
    const visibilityLabel = t(visible ? '从快捷栏隐藏' : '显示在快捷栏');
    return `<div class="at-management-row">
      <button type="button" class="at-config" data-key="config:${e(config.id)}" aria-label="${e(t('配置'))} · ${e(config.title)}">
        ${toolboxNamedIcon(config)}<span class="at-name"><span data-i18n-skip>${e(config.title)}</span>${config.enabled ? '' : `<small>${e(t('已关闭'))}</small>`}</span><span class="at-config-arrow">${agentIconMarkup('forward')}</span>
      </button>
      ${ordering && visible ? `<div class="at-order">${button(`up:${config.id}`, '上移', { icon: 'up', disabled: visibleIds[0] === config.id })}${button(`down:${config.id}`, '下移', { icon: 'down', disabled: visibleIds.at(-1) === config.id })}</div>`
        : `<button type="button" class="at-visibility" data-key="visible:${e(config.id)}" aria-pressed="${visible}" aria-label="${e(visibilityLabel)} · ${e(config.title)}" title="${e(visibilityLabel)}">${agentIconMarkup(visible ? 'visible' : 'hidden')}</button>`}
    </div>`;
  };
  return `<div class="at-card-head"><div class="at-card-heading"><strong>${e(t('快捷栏'))}</strong></div><button type="button" class="at-sort" data-key="sort" aria-pressed="${ordering}"${items.length < 2 && !ordering ? ' hidden' : ''}>${e(t(ordering ? '完成' : '排序'))}</button></div>
    <div class="at-management-list">${items.map(config => row(config, true)).join('') || `<p class="at-status at-empty">${e(t('还没有快捷工具'))}</p>`}</div>
    ${hidden.length ? `<details class="at-hidden-tools"${expanded ? ' open' : ''}${ordering ? ' hidden' : ''}><summary><span class="at-disclosure-icon">${agentIconMarkup('forward')}</span>${e(t('未显示'))}<span class="at-count">${hidden.length}</span></summary><div class="at-management-list">${hidden.map(config => row(config, false)).join('')}</div></details>` : ''}
    <div class="at-management-tools"${ordering ? ' hidden' : ''}>
      <button type="button" data-key="center" class="at-settings-link" aria-label="${e(t('打开 Agent Center'))}">${agentIconMarkup('toolbox')}<span>Agent Center</span><span class="at-config-arrow">${agentIconMarkup('forward')}</span></button>
      <div class="at-shortcut-row">${agentIconMarkup('keyboard')}<span>${e(t('打开工具箱'))}</span><button type="button" data-key="shortcut" class="at-shortcut-key" aria-label="${e(t(recording ? '请按组合键' : '设置工具箱快捷键'))}" aria-pressed="${recording}">${recording ? e(t('请按组合键')) : shortcut ? `<kbd data-i18n-skip>${e(shortcut.label)}</kbd>` : e(t('未设置'))}</button>${shortcut || recording ? button(recording ? 'cancel-shortcut' : 'clear-shortcut', recording ? '取消' : '清除快捷键', { icon: 'close' }) : ''}</div>
      ${recording ? `<p class="at-shortcut-hint" role="status">${e(t(shortcutError || '例如 Ctrl + Alt + J；Esc 取消。'))}</p>` : ''}
    </div>`;
};

// One skeleton for the lifetime of the toolbox. The controller mounts a task
// only on navigation; progress does not replace focused controls or selectors.
export const createAgentToolboxView = (doc, triggerContainer, entryAnchor) => {
  const style = doc.createElement('style');
  style.textContent = `
    .agent-toolbox-trigger{position:relative;color:var(--app-text-secondary);flex-shrink:0}
    .agent-toolbox-trigger:hover,.agent-toolbox-trigger[aria-expanded=true]{background:var(--app-accent-soft);color:var(--app-accent-primary)}
    body[data-theme-mode=dark] .agent-toolbox-trigger::before{display:none!important}
    .agent-toolbox-trigger svg{width:var(--chat-action-icon-size,18px);height:var(--chat-action-icon-size,18px)}.agent-toolbox-trigger small{position:absolute;top:-5px;right:-5px;min-width:15px;padding:0 3px;line-height:15px;border-radius:9px;background:var(--app-accent-primary);color:var(--app-text-on-accent,#fff);font-size:10px;font-variant-numeric:tabular-nums}
    .agent-toolbox-anchor{position:relative}.agent-toolbox-ready-dot{position:absolute;top:2px;right:2px;width:6px;height:6px;border-radius:50%;background:var(--app-accent-primary);box-shadow:0 0 0 2px var(--app-surface-card)}
    .agent-toolbox-panel{position:fixed;z-index:22500;display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:0 env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);max-width:calc(100vw - 24px);color:var(--app-text-primary);font-family:inherit;line-height:1.6;box-sizing:border-box}
    .agent-toolbox-panel [hidden],.agent-toolbox-panel[hidden],.agent-toolbox-trigger[hidden],.agent-toolbox-ready-dot[hidden]{display:none!important}
    .agent-toolbox-panel *{box-sizing:border-box}.agent-toolbox-panel button{font:inherit;color:inherit;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:44px;min-width:44px;padding:8px 12px;background:transparent;border:0;border-radius:12px;cursor:pointer;flex-shrink:0}
    .agent-toolbox-panel button:hover{background:var(--app-surface-hover)}.agent-toolbox-panel button:disabled{opacity:.45;cursor:default}
    .agent-toolbox-panel :is(button,select,summary):focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:2px}
    .at-card,.at-legend,.at-notice{border:1px solid var(--app-border-default);background:var(--app-surface-card);box-shadow:var(--app-shadow-md);border-radius:18px}
    .at-shelf{display:flex;gap:0;align-items:center;max-width:100%}.at-icons{display:flex;gap:0}.at-icons:empty{display:none}
    /* Match the composer's visible buttons while keeping a 44px hit area. */
    .at-shelf button{width:44px;height:44px;padding:0;position:relative;isolation:isolate;border:0;border-radius:var(--chat-action-radius,10px);background:transparent;box-shadow:none}
    .at-shelf button::before{content:'';position:absolute;inset:0;margin:auto;z-index:-1;box-sizing:border-box;width:var(--chat-action-size,32px);height:var(--chat-action-size,32px);border:1px solid var(--app-border-default);border-radius:inherit;background:var(--app-surface-card);box-shadow:var(--app-shadow-sm);pointer-events:none}
    .at-shelf button>svg{width:var(--chat-action-icon-size,18px);height:var(--chat-action-icon-size,18px)}.at-shelf button:hover{background:transparent}.at-shelf button:hover::before{background:var(--app-surface-hover)}
    .at-shelf button[aria-pressed=true],.at-shelf button[aria-expanded=true]{color:var(--app-accent-primary)}.at-shelf button[aria-pressed=true]::before,.at-shelf button[aria-expanded=true]::before{background:var(--app-accent-soft);border-color:var(--app-accent-primary)}
    .agent-toolbox-panel .at-shelf button:focus-visible{outline:none}.at-shelf button:focus-visible::before{outline:2px solid var(--app-accent-primary);outline-offset:2px}
    .at-tool[data-enabled=false]>svg{opacity:.48}.at-tool-state{position:absolute;right:5px;bottom:5px;min-width:11px;height:11px;padding:0 2px;line-height:11px;border-radius:8px;background:var(--app-surface-card);color:var(--app-text-secondary);font-size:9px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
    .at-tool[data-status=ready] .at-tool-state{background:var(--app-accent-primary);color:var(--app-text-on-accent,#fff)}
    .at-card{width:100%;min-height:0;overflow:auto;overscroll-behavior:contain;padding:8px 16px 16px}.at-card-head{display:flex;align-items:center;gap:6px;margin:0 -6px 8px}.at-card-heading{display:flex;gap:9px;align-items:center;min-width:0;flex:1}.at-card-heading strong{font-size:14px;font-weight:600;overflow-wrap:anywhere;text-wrap:balance}.at-named-icon{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--app-accent-primary)}
    .at-card-head>.at-card-heading{padding-left:6px}.at-card-head button{padding:10px;color:var(--app-text-secondary)}.at-scope{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--app-text-secondary);margin:0 0 8px}.at-scope strong{color:var(--app-text-primary);font-weight:500}.at-scope .at-count{margin-left:auto;white-space:nowrap}.at-scope button{padding:10px;margin-right:-8px}.at-scope button svg{width:17px;height:17px}
    .at-target{padding:12px;border-radius:14px;background:var(--app-surface-subtle)}.at-target select{font:inherit;color:var(--app-text-primary);background:var(--app-surface-card);width:100%;min-height:44px;padding:8px 10px;border:1px solid var(--app-border-default);border-radius:10px}
    .at-target-summary,.at-result pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:150px;overflow:auto;font:inherit;margin:8px 0 0}.at-target-summary{font-size:12px;color:var(--app-text-secondary)}.at-target details summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--app-text-secondary);font-size:12px}.at-target details summary::before{content:'›';margin-right:7px}.at-target details[open] summary::before{transform:rotate(90deg)}
    .at-target-actions,.at-run-actions,.at-result-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px}.at-target-actions:empty{display:none}.at-target-actions button{padding:6px 9px;font-size:12px;background:var(--app-surface-card);border:1px solid var(--app-border-subtle)}.at-run-actions{justify-content:flex-end;margin-top:12px}.at-run-actions .at-primary{background:var(--app-accent-primary);color:var(--app-text-on-accent,#fff);padding-inline:20px}.at-run-actions .at-primary:hover{opacity:.9}
    .at-status{font-size:12px;color:var(--app-text-secondary);overflow-wrap:anywhere;text-wrap:pretty}.at-status:empty{display:none}.at-result{border-top:1px solid var(--app-border-subtle);padding-top:10px;margin-top:12px}.at-result-actions button{background:var(--app-surface-subtle);font-size:12px}.at-result pre{max-height:210px}
    .at-card-head .at-sort{font-size:12px;padding-inline:12px}.at-card-head .at-sort[aria-pressed=true]{color:var(--app-accent-primary);background:var(--app-accent-soft)}
    .at-repair-profiles{display:grid;gap:6px}.at-repair-profile{display:flex;align-items:center;gap:6px;padding:3px;background:var(--app-surface-subtle);border:1px solid var(--app-border-subtle);border-radius:var(--app-radius-md)}.at-repair-profile>button:first-child{flex:1;min-width:0;justify-content:space-between;text-align:left}.at-repair-profile>button:first-child>span:first-child{overflow-wrap:anywhere}.at-repair-profile>button:last-child{color:var(--app-text-muted);padding:10px}.at-repair-profile svg{width:18px;height:18px}
    .at-card[data-mode=manage] .at-card-head{position:sticky;top:-8px;z-index:1;background:var(--app-surface-card)}
    .at-management-list{display:grid;gap:4px}.at-management-row{display:flex;align-items:center;gap:6px;min-width:0}
    .at-management-row>.at-config{justify-content:flex-start;flex:1;min-width:0;padding:8px 4px;gap:10px}.at-management-row .at-named-icon{width:32px;height:32px;border-radius:10px;background:var(--app-surface-subtle)}
    .at-management-row .at-name{min-width:0;flex:1;text-align:left;line-height:1.5}.at-name>span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.at-name small{display:block;color:var(--app-text-secondary);font-size:11px;margin-top:2px}
    .at-config-arrow{display:inline-flex;flex-shrink:0;color:var(--app-text-secondary);opacity:.65}.at-config-arrow svg{width:14px;height:14px}
    .at-management-row .at-visibility{padding:10px;width:44px;color:var(--app-text-secondary)}.at-management-row .at-visibility[aria-pressed=true]{color:var(--app-accent-primary)}
    .at-order{display:flex;gap:2px}.at-order button{padding:10px}.at-order button:disabled{opacity:.25}.at-order button svg{width:18px;height:18px}
    .at-hidden-tools{margin-top:10px}.at-hidden-tools>summary{display:flex;align-items:center;gap:7px;min-height:44px;cursor:pointer;font-size:12px;color:var(--app-text-secondary);list-style:none;border-radius:10px}.at-hidden-tools>summary::-webkit-details-marker{display:none}.at-disclosure-icon{display:inline-flex}.at-disclosure-icon svg{width:14px;height:14px}.at-hidden-tools[open] .at-disclosure-icon{transform:rotate(90deg)}.at-hidden-tools .at-count{margin-left:auto;font-variant-numeric:tabular-nums;padding-right:14px}.at-hidden-tools .at-named-icon{color:var(--app-text-secondary)}
    .at-management-tools{display:grid;gap:4px;margin-top:12px;padding-top:10px;border-top:1px solid var(--app-border-subtle)}.at-management-tools .at-settings-link{justify-content:flex-start;text-align:left;gap:12px;padding:8px 4px;width:100%}.at-settings-link>svg,.at-shortcut-row>svg{width:18px;height:18px;flex-shrink:0;color:var(--app-text-secondary)}.at-settings-link .at-config-arrow{margin-left:auto;padding-right:10px}
    .at-shortcut-row{display:flex;align-items:center;gap:12px;min-width:0;padding-left:4px}.at-shortcut-row>span{font-size:12px;color:var(--app-text-secondary);white-space:nowrap}.at-shortcut-row .at-shortcut-key{margin-left:auto;min-width:0;flex-shrink:1;font-size:12px;color:var(--app-text-secondary);overflow-wrap:anywhere}.at-shortcut-key kbd{font:inherit;font-variant-numeric:tabular-nums}.at-shortcut-key[aria-pressed=true]{background:var(--app-accent-soft);color:var(--app-accent-primary)}.at-shortcut-row>button:last-child:not(.at-shortcut-key){padding:10px;margin-left:-8px;color:var(--app-text-secondary)}.at-shortcut-row>button:last-child svg{width:16px;height:16px}
    .at-shortcut-hint{margin:0 4px;min-height:3.2em;font-size:12px;color:var(--app-text-secondary);overflow-wrap:anywhere;text-wrap:pretty}
    .at-empty{margin:8px 4px}.at-overflow{display:grid;gap:4px}.at-overflow>button{justify-content:flex-start;text-align:left}.at-overflow>button small{margin-left:auto;color:var(--app-text-secondary)}
    .at-legend,.at-notice{max-width:100%;width:100%;padding:10px 12px;font-size:12px;color:var(--app-text-secondary)}.at-legend p{margin:0;text-wrap:pretty}.at-legend-list{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:7px}.at-legend-list span{display:inline-flex;gap:6px;align-items:center}.at-legend-list svg{width:16px;height:16px}.at-legend button{float:right;padding:0;min-width:44px;margin:-6px -6px 0 0}.at-notice{display:flex;align-items:center;gap:8px}.at-notice span{flex:1}.at-notice button{padding:0 8px}
    .at-inbox>button{background:var(--app-surface-card);box-shadow:var(--app-shadow-sm);border:1px solid var(--app-border-default);font-size:12px;color:var(--app-text-secondary)}.at-target-excerpt{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;font-size:12px;line-height:1.7}.at-result-entry{min-width:0;flex:1}.at-result-entry span{display:block}
    .at-tooltip{position:absolute;bottom:calc(100% + 8px);left:0;width:max-content;max-width:min(320px,calc(100vw - 32px));padding:5px 9px;border:1px solid var(--app-border-default);border-radius:8px;background:var(--app-surface-card);box-shadow:var(--app-shadow-sm);white-space:normal;overflow-wrap:anywhere;text-align:left;font-size:12px;pointer-events:none;opacity:0;visibility:hidden;color:var(--app-text-primary)}
    @media(hover:hover){.at-tool:hover .at-tooltip{opacity:1;visibility:visible}}.at-tool:focus-visible .at-tooltip{opacity:1;visibility:visible}
    @media(hover:hover){.at-shelf:has(.at-tool:hover) .at-tool:not(:hover) .at-tooltip{opacity:0;visibility:hidden}}
    .agent-toolbox-panel.is-entering{animation:at-appear 150ms ease-out}.at-tool[data-status=running] .at-tool-state{animation:at-pulse 1.1s ease-in-out infinite}
    @keyframes at-appear{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}@keyframes at-pulse{50%{opacity:.45}}
    .agent-toolbox-panel[hidden] *{animation:none!important}
    @media(max-width:600px){.at-card{padding:6px 12px 12px}.at-card[data-mode=manage] .at-card-head{top:-6px}.at-target-summary{max-height:120px}.at-shortcut-row{gap:8px}}
    @media(prefers-reduced-motion:reduce){.agent-toolbox-panel,.agent-toolbox-panel *{animation:none!important}}
    body[data-reduced-motion=on] .agent-toolbox-panel,body[data-reduced-motion=on] .agent-toolbox-panel *{animation:none!important}
  `;
  doc.head.append(style);
  const trigger = doc.createElement('button'); trigger.type = 'button'; trigger.className = 'chat-action-btn agent-toolbox-trigger';
  trigger.title = t('Agent 工具箱'); trigger.setAttribute('aria-label', trigger.title); trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = agentIconMarkup('toolbox') + '<small hidden></small>'; triggerContainer?.append(trigger);
  const badge = doc.createElement('span'); badge.className = 'agent-toolbox-ready-dot'; badge.hidden = true; badge.setAttribute('aria-hidden', 'true');
  entryAnchor.classList.add('agent-toolbox-anchor'); if (entryAnchor.tagName !== 'TEXTAREA') entryAnchor.append(badge);
  const panel = doc.createElement('div'); panel.className = 'agent-toolbox-panel'; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', t('Agent 工具箱'));
  panel.innerHTML = `<section class="at-card" hidden></section><div class="at-legend" hidden></div><div class="at-notice" role="status" hidden></div><div class="at-inbox" hidden>${toolboxButton('runs', '任务与结果')}</div><div class="at-shelf" role="toolbar" aria-label="${toolboxEscape(t('Agent 快捷栏'))}"><div class="at-icons"></div>${toolboxButton('more', '更多工具', { icon: 'more' })}${toolboxButton('manage', '管理快捷栏', { icon: 'settings' })}</div>`;
  panel.querySelector('[data-key=manage]').classList.add('at-settings'); doc.body.append(panel);
  const positionTooltip = anchor => {
    const tip = anchor?.querySelector('.at-tooltip'); if (!tip || panel.hidden) return;
    const win = doc.defaultView, vv = win.visualViewport, bounds = panel.getBoundingClientRect();
    const viewportLeft = vv?.offsetLeft || 0, viewportTop = vv?.offsetTop || 0;
    const viewportRight = viewportLeft + (vv?.width || win.innerWidth), viewportBottom = viewportTop + (vv?.height || win.innerHeight);
    const leftEdge = Math.max(bounds.left + 4, viewportLeft + 8), rightEdge = Math.min(bounds.right - 4, viewportRight - 8);
    tip.style.maxWidth = `${Math.min(320, Math.max(0, rightEdge - leftEdge))}px`;
    const a = anchor.getBoundingClientRect(), size = tip.getBoundingClientRect();
    const left = Math.max(leftEdge, Math.min(a.left + a.width / 2 - size.width / 2, rightEdge - size.width));
    const above = a.top - size.height - 8;
    const top = above >= viewportTop + 8 ? above : Math.max(viewportTop + 8, Math.min(a.bottom + 8, viewportBottom - size.height - 8));
    tip.style.left = `${left - a.left}px`; tip.style.top = `${top - a.top}px`; tip.style.bottom = 'auto';
  };
  const onTooltipPointer = event => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    const anchor = event.target.closest?.('.at-tool');
    if (anchor && !anchor.contains(event.relatedTarget)) positionTooltip(anchor);
  };
  const onTooltipFocus = event => positionTooltip(event.target.closest?.('.at-tool'));
  panel.addEventListener('pointerover', onTooltipPointer); panel.addEventListener('focusin', onTooltipFocus);
  return { trigger, badge, panel, card: panel.querySelector('.at-card'), icons: panel.querySelector('.at-icons'),
    shelf: panel.querySelector('.at-shelf'), legend: panel.querySelector('.at-legend'), notice: panel.querySelector('.at-notice'), inbox: panel.querySelector('.at-inbox'),
    positionTooltips() { panel.querySelectorAll('.at-tool:is(:hover,:focus-visible)').forEach(positionTooltip); },
    dispose() { panel.removeEventListener('pointerover', onTooltipPointer); panel.removeEventListener('focusin', onTooltipFocus); trigger.remove(); badge.remove(); entryAnchor.classList.remove('agent-toolbox-anchor'); panel.remove(); style.remove(); } };
};
