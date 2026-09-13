import { t } from '../i18n/index.js';
import { allowsAgentInvocation, isInputAgent } from '../agent/agent-invocation.js';
import { createMessageClipboardUiRuntime } from './chat/message-clipboard-ui-utils.js';

const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="3"/><path d="M8 7V4h8v3M3 12h18M10 12v3h4v-3"/></svg>';
const labels = { running:'处理中', ready:'待查看', reviewing:'正在查看', applied:'已应用', ignored:'已收起', failed:'失败', expired:'已过期', cancelled:'已取消', unchanged:'无需修改', succeeded:'已完成', skipped:'未执行' };
const isNote = job => job?.outputMode === 'note' || job?.kind === 'note';
const eligibleReply = m => m?.role === 'assistant' && (!m.type || m.type === 'text') && !m.pending && !m.error && !['pending','sending'].includes(m.status) && !m.meta?.generatedMedia;
const sameContext = (a, b) => ['sessionId','scopeId','place','archiveId'].every(k => String(a?.[k] || '') === String(b?.[k] || ''));

export const createAgentToolbox = ({ input, actions, getContext, getMessages, getInputSnapshot, openAgent, openCenter,
  openFormatResult = openCenter, triggerContainer, anchorEl, beforeOpen = () => {}, documentRef = document, storage = globalThis.localStorage } = {}) => {
  const doc = documentRef, win = doc.defaultView, bindings = [];
  const clipboard = createMessageClipboardUiRuntime({ documentLike: doc, navigatorLike: win.navigator, execCopyCommand: command => doc.execCommand(command) });
  let prefs = { pinned: [], order: [], shortcut: null };
  try { const raw = JSON.parse(storage?.getItem('agent_toolbox_ui_v1') || '{}'); prefs = { ...prefs, ...raw, pinned: Array.isArray(raw.pinned) ? raw.pinned : [], order: Array.isArray(raw.order) ? raw.order : [] }; } catch {}
  const savePrefs = () => { try { storage?.setItem('agent_toolbox_ui_v1', JSON.stringify(prefs)); } catch {} };
  const style = doc.createElement('style'); style.textContent = `
  .agent-toolbox-trigger{position:relative;color:var(--app-text-secondary);flex-shrink:0}
  .agent-toolbox-trigger:hover,.agent-toolbox-trigger[aria-expanded=true]{background:var(--app-accent-soft);color:var(--app-accent-primary)}
  body[data-theme-mode='dark'] .agent-toolbox-trigger::before{display:none!important}
  .agent-toolbox-trigger svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.agent-toolbox-trigger small{position:absolute;top:-5px;right:-5px;min-width:15px;padding:0 3px;line-height:15px;border-radius:9px;background:var(--app-accent-primary);color:var(--app-text-on-accent,#fff);font-size:10px}
  .agent-toolbox-anchor{position:relative}.agent-toolbox-ready-dot{position:absolute;top:2px;right:2px;width:6px;height:6px;border-radius:50%;background:var(--app-accent-primary);box-shadow:0 0 0 2px var(--app-surface-card)}.agent-toolbox-ready-dot[hidden]{display:none!important}
  .agent-toolbox-panel{position:fixed;z-index:22500;box-sizing:border-box;width:340px;padding:10px;border:1px solid var(--app-border-default);border-radius:17px;background:var(--app-surface-card);color:var(--app-text-primary);box-shadow:var(--app-shadow-lg,0 14px 40px #0003);font:13px/1.55 var(--app-font-family,inherit);overflow:auto;overscroll-behavior:contain}
  .agent-toolbox-panel[hidden],.agent-toolbox-trigger[hidden]{display:none!important}.agent-toolbox-panel *{box-sizing:border-box}.agent-toolbox-panel button{font:inherit;color:inherit;background:transparent;border:0;border-radius:9px;cursor:pointer;min-height:44px}.agent-toolbox-panel button:hover{background:var(--app-surface-hover)}.agent-toolbox-panel button:disabled{opacity:.42;cursor:default}
  .agent-toolbox-panel :is(button,input,select):focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:1px}.agent-toolbox-top{display:flex;align-items:center;gap:4px;padding-bottom:8px;border-bottom:1px solid var(--app-border-subtle)}.agent-toolbox-top select{flex:1;min-width:0;border:0;border-radius:9px;background:var(--app-surface-subtle);color:inherit;min-height:42px;padding:0 8px;font:inherit}.agent-toolbox-top button{min-width:34px;font-size:18px}
  .agent-toolbox-search{width:100%;border:1px solid var(--app-border-default);border-radius:9px;padding:9px 11px;margin:8px 0;background:var(--app-surface-subtle);color:inherit;font:inherit;min-height:40px}.agent-toolbox-items{max-height:260px;overflow:auto;overscroll-behavior:contain}.agent-toolbox-item{display:flex;align-items:center;gap:2px;border-radius:11px}.agent-toolbox-item>button:first-child{flex:1;min-width:0;text-align:left;display:flex;align-items:center;gap:8px;padding:9px}.agent-toolbox-item .agent-tool-name{overflow-wrap:anywhere;flex:1}.agent-toolbox-item small{color:var(--app-text-secondary);font-size:10px;white-space:nowrap}.agent-toolbox-pin{flex:none;width:34px;font-size:16px;color:var(--app-text-muted)!important}.agent-toolbox-pin[aria-pressed=true]{color:var(--app-accent-primary)!important}
  .agent-toolbox-result{margin-top:7px;border-top:1px solid var(--app-border-subtle);padding:10px 4px 3px}.agent-toolbox-result pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;max-height:180px;overflow:auto;margin:8px 0}.agent-toolbox-result strong{font-size:12px;font-weight:600}.agent-toolbox-result-actions{display:flex;gap:6px;flex-wrap:wrap}.agent-toolbox-result-actions button{padding:5px 10px;background:var(--app-surface-subtle)}.agent-toolbox-status{color:var(--app-text-secondary);font-size:12px;overflow-wrap:anywhere}.agent-toolbox-settings{border-top:1px solid var(--app-border-subtle);padding:8px 4px 0;margin-top:7px;font-size:12px;color:var(--app-text-secondary)}.agent-toolbox-settings summary{cursor:pointer;min-height:32px;padding-top:5px}.agent-toolbox-order{display:flex;align-items:center;gap:4px}.agent-toolbox-order span{flex:1;min-width:0;overflow-wrap:anywhere}.agent-toolbox-order button{width:32px}.agent-toolbox-empty{padding:13px 7px}.agent-toolbox-shortcut{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
  @media(max-width:600px){.agent-toolbox-panel{border-radius:16px}.agent-toolbox-items{max-height:210px}.agent-toolbox-result pre{max-height:140px}}
  `; doc.head.append(style);
  const trigger = doc.createElement('button'); trigger.type = 'button'; trigger.className = 'chat-action-btn agent-toolbox-trigger';
  trigger.setAttribute('aria-label', t('Agent 工具箱')); trigger.title = t('Agent 工具箱'); trigger.setAttribute('aria-expanded', 'false'); trigger.innerHTML = icon + '<small hidden></small>';
  const row = input.closest('.chat-input-row');
  (triggerContainer || row?.querySelector('.chat-action-inline'))?.append(trigger);
  const entryAnchor = anchorEl || row?.querySelector('.voice-btn') || input;
  const anchorBadge = doc.createElement('span'); anchorBadge.className = 'agent-toolbox-ready-dot'; anchorBadge.hidden = true; anchorBadge.setAttribute('aria-hidden','true');
  if(entryAnchor !== input){entryAnchor.classList.add('agent-toolbox-anchor');entryAnchor.append(anchorBadge);}
  const panel = doc.createElement('div'); panel.className = 'agent-toolbox-panel'; panel.hidden = true; panel.setAttribute('role','dialog'); panel.setAttribute('aria-label',t('Agent 工具箱')); doc.body.append(panel);
  let context = null, target = null, anchor = null, selectedId = '', selectedRunId = '', status = '', resultNotice = '', query = '', recording = false;
  let renderFrame;
  const formatJobs = new Map();
  const allConfigs = () => actions.listAgentConfigurations({ context: getContext() }).map(r => r.config);
  const configs = () => allConfigs().filter(c => allowsAgentInvocation(c,'manual'));
  const sorted = () => configs().sort((a,b) => Number(Boolean(targetAvailable(b)))-Number(Boolean(targetAvailable(a))) || Number(prefs.pinned.includes(b.id))-Number(prefs.pinned.includes(a.id))
    || (prefs.order.includes(a.id)?prefs.order.indexOf(a.id):999)-(prefs.order.includes(b.id)?prefs.order.indexOf(b.id):999));
  const currentReplies = () => (getMessages(getContext().sessionId) || []).filter(eligibleReply).slice(-20).reverse();
  const runs = () => [...actions.listInputAgentRuns(), ...actions.listTextEditRuns(), ...formatJobs.values()].filter(j => sameContext(j.context,getContext()));
  const runFor = config => runs().filter(j => j.agentId===config.id && (isInputAgent(config) ? j.revision===target?.inputTarget?.revision && j.start===target.inputTarget.start && j.end===target.inputTarget.end : j.messageId===target?.messageId)).at(-1);
  const targetAvailable = config => isInputAgent(config) ? target?.kind==='input' && target.inputTarget?.text.trim()
    : target?.kind==='reply' && currentReplies().some(m => m.id===target.messageId) && (config.kind!=='format_review' || currentReplies()[0]?.id===target.messageId);
  const targetHint = config => t(isInputAgent(config) ? '请先在输入框填写内容' : config.kind==='format_review' && target?.kind==='reply' ? '选择最新一轮已完成的回复' : '选择一条回复');
  const close = () => {panel.hidden=true;trigger.setAttribute('aria-expanded','false');recording=false;};
  const place = () => {
    if(panel.hidden)return;
    const vv=win.visualViewport, left=vv?.offsetLeft||0,top=vv?.offsetTop||0,width=vv?.width||win.innerWidth,height=vv?.height||win.innerHeight;
    panel.style.width=`${Math.min(340,width-20)}px`;panel.style.maxHeight=`${Math.max(120,height-24)}px`;
    const r=anchor && Number.isFinite(anchor.x)?{left:anchor.x,top:anchor.y,bottom:anchor.y}:entryAnchor.getBoundingClientRect();
    const box=panel.getBoundingClientRect();panel.style.left=`${Math.max(left+10,Math.min(left+width-box.width-10,r.left))}px`;
    panel.style.top=`${Math.max(top+10,Math.min(top+height-box.height-10,r.top-box.height-8>=top+10?r.top-box.height-8:r.bottom+8))}px`;
  };
  const render = () => {
    const ready=runs().filter(j=>j.status==='ready').length, badge=trigger.querySelector('small');badge.hidden=!ready;badge.textContent=String(ready);
    trigger.hidden=!['chat','writing'].includes(getContext().place)||!getContext().sessionId;
    anchorBadge.hidden=!ready||trigger.hidden;anchorBadge.title=ready?`${t('Agent 工具箱')} · ${t('待查看')} ${ready}`:'';
    trigger.setAttribute('aria-label',ready?`${t('Agent 工具箱')} · ${t('待查看')} ${ready}`:t('Agent 工具箱'));
    if(panel.hidden)return;
    if(!sameContext(context,getContext())){close();return;}
    const focus=doc.activeElement, focusKey=panel.contains(focus)?focus.dataset.key:'', caret=focus?.selectionStart;
    const items=sorted(), visible=items.filter(c=>c.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    const replyOptions=currentReplies();
    const optionValue=target?.kind==='reply'?target.messageId:'input';
    const selected=allConfigs().find(c=>c.id===selectedId && c.enabled), job=selected && (runs().find(j=>j.id===selectedRunId && j.agentId===selected.id) || runFor(selected));
    const candidates=target?.kind==='input' ? runs().filter(j=>j.id.startsWith('input-run-') && j.revision===target.inputTarget?.revision && ['running','ready'].includes(j.status) && !items.some(c=>c.id===j.agentId) && allConfigs().some(c=>c.id===j.agentId && c.enabled)) : [];
    const replyCandidates=runs().filter(j=>j.outputMode==='note' && ['running','ready'].includes(j.status) && !items.some(c=>c.id===j.agentId) && allConfigs().some(c=>c.id===j.agentId && c.enabled)).slice(-6).reverse();
    const text=job?.text||job?.message||status;
    panel.innerHTML=`<div class="agent-toolbox-top"><select data-key="target" aria-label="${e(t('处理对象'))}"><option value="input" ${optionValue==='input'?'selected':''}>${e(target?.inputTarget?.end>target?.inputTarget?.start?t('已选草稿文字'):t('当前草稿'))}</option>${replyOptions.map((m,i)=>`<option value="${e(m.id)}" ${optionValue===m.id?'selected':''}>${e(t(i===0?'最近回复':'历史回复'))} · ${e(String(m.content||'').replace(/<[^>]*>/g,'').slice(0,24))}</option>`).join('')}</select><button data-key="refresh" title="${e(t('更新处理对象'))}" aria-label="${e(t('更新处理对象'))}">↻</button><button data-key="close" aria-label="${e(t('关闭'))}">×</button></div>
      ${items.length>6?`<input class="agent-toolbox-search" data-key="search" placeholder="${e(t('搜索 Agent'))}" value="${e(query)}" aria-label="${e(t('搜索 Agent'))}">`:''}
      <div class="agent-toolbox-items">${visible.map(c=>{const j=runFor(c),available=targetAvailable(c);return `<div class="agent-toolbox-item"><button data-key="run:${e(c.id)}" ${available?'':'disabled'} title="${e(available?c.title:targetHint(c))}"><span class="agent-tool-name">${e(c.title)}</span><small>${e(t(j?labels[j.status]||'待查看':isInputAgent(c)?'草稿':'回复'))}</small></button>${!available?`<button class="has-help" data-help-mode="tap" data-help="${e(targetHint(c))}" aria-label="${e(targetHint(c))}">?</button>`:''}<button class="agent-toolbox-pin" data-key="pin:${e(c.id)}" aria-pressed="${prefs.pinned.includes(c.id)}" aria-label="${e(t('置顶'))}">${prefs.pinned.includes(c.id)?'★':'☆'}</button></div>`}).join('')||`<div class="agent-toolbox-empty">${items.length?e(t('没有匹配的工具')):`<button data-key="manage">${e(t('添加手动工具'))}</button>`}</div>`}</div>
      ${candidates.length?`<div class="agent-toolbox-status">${e(t('输入任务'))}</div><div class="agent-toolbox-items">${candidates.map(j=>`<div class="agent-toolbox-item"><button data-key="result:${e(j.agentId)}"><span class="agent-tool-name">${e(j.title)}</span><small>${e(t(labels[j.status]))}</small></button></div>`).join('')}</div>`:''}
      ${replyCandidates.length?`<div class="agent-toolbox-status">${e(t('回复任务'))}</div><div class="agent-toolbox-items">${replyCandidates.map(j=>`<div class="agent-toolbox-item"><button data-key="result-run:${e(j.id)}"><span class="agent-tool-name">${e(j.title)}</span><small>${e(t(labels[j.status]))}</small></button></div>`).join('')}</div>`:''}
      ${selectedId||status?`<div class="agent-toolbox-result"><strong>${e(selected?.title||'')}</strong><div class="agent-toolbox-status" role="status">${e(resultNotice||t(job?isNote(job)&&job.status==='ready'?'资料与建议':labels[job.status]||'':status))}</div>${text&&text!==status?`<pre data-i18n-skip="true" tabindex="0">${e(text)}</pre>`:''}<div class="agent-toolbox-result-actions">${job?.status==='running'?`<button data-key="cancel:${e(job.id)}">${e(t('取消'))}</button>`:''}${job?.status==='ready'?isNote(job)?`<button data-key="copy:${e(job.id)}">${e(t('复制结果'))}</button><button data-key="ignore:${e(job.id)}">${e(t('收起结果'))}</button>`:isInputAgent(selected)?`<button data-key="apply:${e(job.id)}">${e(t(job.kind==='rewrite'?'查看修改':'采纳'))}</button><button data-key="ignore:${e(job.id)}">${e(t('收起结果'))}</button>`:`<button data-key="review:${e(job.id)}">${e(t('查看修改'))}</button>`:''}${job?.trace?.steps?.length?`<button data-key="process:${e(job.id)}">${e(t('执行过程'))}</button>`:''}${selected?`<button data-key="config:${e(selected.id)}">${e(t('配置'))}</button>`:''}${selected?.kind==='format_review'&&job?.status==='succeeded'?`<button data-key="format-result">${e(t('查看结果'))}</button>`:''}</div></div>`:''}
      <details class="agent-toolbox-settings"><summary>${e(t('工具设置'))}</summary><div class="agent-toolbox-shortcut"><button data-key="shortcut">${e(recording?t('按下快捷键'):prefs.shortcut?.label||t('设置快捷键'))}</button>${prefs.shortcut?`<button data-key="clear-shortcut">${e(t('清除'))}</button>`:''}<button data-key="manage">${e(t('管理工具'))}</button></div>${items.map(c=>`<div class="agent-toolbox-order"><span>${e(c.title)}</span><button data-key="up:${e(c.id)}" aria-label="${e(t('上移'))}">↑</button><button data-key="down:${e(c.id)}" aria-label="${e(t('下移'))}">↓</button></div>`).join('')}</details>`;
    if(focusKey){const next=[...panel.querySelectorAll('[data-key]')].find(n=>n.dataset.key===focusKey);next?.focus({preventScroll:true});if(next?.setSelectionRange&&Number.isFinite(caret))next.setSelectionRange(caret,caret);}
    place();
  };
  const refresh=()=>{win.cancelAnimationFrame(renderFrame);renderFrame=win.requestAnimationFrame(render);};
  const open = (options = {}) => {
    context={...getContext()};anchor=options.anchor||null;
    target=options.messageId?{kind:'reply',messageId:options.messageId,selectedText:options.selectedText||''}:{kind:'input',inputTarget:getInputSnapshot()};
    beforeOpen();
    selectedId='';selectedRunId='';status='';resultNotice='';query='';panel.hidden=false;trigger.setAttribute('aria-expanded','true');render();
    if(options.keyboard)panel.querySelector('[data-key="search"], [data-key="target"]')?.focus();
  };
  const invoke = async id => {
    const config=configs().find(c=>c.id===id);
    if(!config||!sameContext(context,getContext())||!targetAvailable(config)){status=t('当前工具或处理对象已变化');render();return;}
    selectedId=id;selectedRunId='';resultNotice='';
    const prior=runFor(config);if(prior&&['running','ready','reviewing'].includes(prior.status)){render();return;}
    const frozen={...context}, savedTarget={...target};
    status=t('处理中');render();
    try {
      let result;
      if(isInputAgent(config))result=await actions.runConfiguredInputAgent({id,context:frozen,inputTarget:savedTarget.inputTarget});
      else if(config.kind==='text_edit')result=await actions.runTextEditAgent({id,context:frozen,messageId:savedTarget.messageId,selectedText:savedTarget.selectedText});
      else {
        const controller=new AbortController(), key=`tool-format:${Date.now()}`;
        const job={id:key,agentId:id,title:config.title,context:frozen,messageId:savedTarget.messageId,status:'running',controller};formatJobs.set(key,job);for(const [k,j] of formatJobs){if(formatJobs.size<=20)break;if(j.status!=='running')formatJobs.delete(k);}refresh();
        try { result=await actions.runConfiguredFormatReview({id,context:frozen,messageId:savedTarget.messageId,signal:controller.signal});job.status=controller.signal.aborted?'cancelled':result.status;job.message=result.reason||''; } catch(error) { job.status='failed';job.message=String(error.message||error);throw error; }
      }
      if(sameContext(frozen,getContext())){status=result?.reason?t(result.reason):t(result?.status==='succeeded'?'已完成':'处理中');render();}
    }catch(error){if(sameContext(frozen,getContext())){status=String(error.message||error);render();}}
  };
  const listen=(el,type,fn,opts)=>{el?.addEventListener(type,fn,opts);bindings.push(()=>el?.removeEventListener(type,fn,opts));};
  listen(trigger,'click',event=>{event.preventDefault();event.stopPropagation();if(panel.hidden)open({keyboard:event.detail===0});else close();});
  listen(doc,'pointerdown',event=>{if(!panel.contains(event.target)&&!trigger.contains(event.target))close();});
  listen(panel,'input',event=>{if(event.target.dataset.key==='search'){query=event.target.value;render();}});
  listen(panel,'change',event=>{if(event.target.dataset.key==='target'){target=event.target.value==='input'?{kind:'input',inputTarget:getInputSnapshot()}:{kind:'reply',messageId:event.target.value};selectedId='';selectedRunId='';resultNotice='';status='';render();}});
  listen(panel,'click',async event=>{
    const key=event.target.closest('[data-key]')?.dataset.key;if(!key)return;
    try {
      if(key==='close')close();
      else if(key==='refresh'){if(target.kind==='input')target.inputTarget=getInputSnapshot();status='';render();}
      else if(key==='manage'){close();openCenter();}
      else if(key==='shortcut'){recording=true;event.target.textContent=t('按下快捷键');}
      else if(key==='clear-shortcut'){prefs.shortcut=null;savePrefs();render();}
      else if(key==='format-result'){close();openFormatResult(target.messageId);}
      else if(key.startsWith('result:')){selectedId=key.slice(7);selectedRunId='';resultNotice='';render();}
      else if(key.startsWith('result-run:')){const job=runs().find(j=>j.id===key.slice(11));if(job){selectedId=job.agentId;selectedRunId=job.id;target={kind:'reply',messageId:job.messageId};resultNotice='';render();}}
      else if(key.startsWith('run:'))await invoke(key.slice(4));
      else if(key.startsWith('config:')){const id=key.slice(7);close();openAgent(id,{messageId:target?.messageId});}
      else if(key.startsWith('pin:')){const id=key.slice(4);prefs.pinned=prefs.pinned.includes(id)?prefs.pinned.filter(x=>x!==id):[...prefs.pinned,id];savePrefs();render();}
      else if(key.startsWith('up:')||key.startsWith('down:')){const id=key.slice(key.indexOf(':')+1),ids=sorted().map(c=>c.id),i=ids.indexOf(id),j=i+(key.startsWith('up:')?-1:1);if(j>=0&&j<ids.length){[ids[i],ids[j]]=[ids[j],ids[i]];prefs.order=ids;savePrefs();render();panel.querySelector('details').open=true;place();}}
      else if(key.startsWith('cancel:')){const id=key.slice(7);if(id.startsWith('input-run:')||id.startsWith('input-run-'))actions.cancelInputAgentRun(id);else if(formatJobs.has(id)){formatJobs.get(id).controller.abort();formatJobs.get(id).status='cancelled';}else actions.cancelTextEditRun(id);render();}
      else if(key.startsWith('apply:')){close();await actions.applyInputAgentRun(key.slice(6));refresh();}
      else if(key.startsWith('ignore:')){const id=key.slice(7),job=runs().find(j=>j.id===id);if(job?.outputMode)actions.ignoreTextEditRun(id);else actions.ignoreInputAgentRun(id);selectedId='';selectedRunId='';resultNotice='';status='';refresh();}
      else if(key.startsWith('copy:')){const job=runs().find(j=>j.id===key.slice(5)),frozen={...context};if(job?.text&&isNote(job)){const copied=await clipboard.copyToClipboard(job.text);if(sameContext(frozen,getContext())){resultNotice=t(copied?'已复制':'复制失败');render();}}}
      else if(key.startsWith('process:')){const job=runs().find(j=>j.id===key.slice(8));if(job){close();openAgent(job.agentId,{messageId:job.messageId,context:job.context});}}
      else if(key.startsWith('review:')){const job=runs().find(j=>j.id===key.slice(7));if(isNote(job)){selectedId=job.agentId;selectedRunId=job.id;render();}else{close();await actions.openTextEditRun(key.slice(7));}}
    }catch(error){status=String(error.message||error);render();}
  });
  let pointer={x:0,y:0};listen(doc,'pointermove',event=>{pointer={x:event.clientX,y:event.clientY};},{passive:true});
  listen(doc,'keydown',event=>{
    if(event.isComposing||event.keyCode===229)return;
    if(event.key==='Escape'&&!panel.hidden){event.preventDefault();close();entryAnchor.focus({preventScroll:true});return;}
    if(recording){if(!event.ctrlKey&&!event.altKey&&!event.metaKey)return;if(['Control','Alt','Meta','Shift'].includes(event.key))return;event.preventDefault();event.stopPropagation();prefs.shortcut={code:event.code,ctrl:event.ctrlKey,alt:event.altKey,meta:event.metaKey,shift:event.shiftKey,label:[event.ctrlKey?'Ctrl':'',event.altKey?'Alt':'',event.metaKey?'Meta':'',event.shiftKey?'Shift':'',event.key.toUpperCase()].filter(Boolean).join(' + ')};savePrefs();recording=false;render();return;}
    const s=prefs.shortcut;if(s&&event.code===s.code&&event.ctrlKey===s.ctrl&&event.altKey===s.alt&&event.metaKey===s.meta&&event.shiftKey===s.shift&&!trigger.hidden){event.preventDefault();open({keyboard:true,anchor:pointer});}
  },true);
  listen(win,'resize',place);listen(win.visualViewport,'resize',place);listen(win.visualViewport,'scroll',place);listen(panel,'toggle',place,true);
  for(const event of ['agent-input-changed','agent-text-edit-changed','agent-feature-settings-changed','session-changed'])listen(win,event,()=>{
    for(const j of formatJobs.values())if(j.status==='running'&&(!sameContext(j.context,getContext())||!allConfigs().some(c=>c.id===j.agentId && c.enabled))){j.controller.abort();j.status='cancelled';}
    while(formatJobs.size>20){const old=[...formatJobs.values()].find(j=>j.status!=='running');if(!old)break;formatJobs.delete(old.id);}refresh();
  });
  const observer=new win.MutationObserver(()=>{close();refresh();});observer.observe(doc.body,{attributes:true,attributeFilter:['data-ui-mode']});
  render();
  return {open,close,refresh,trigger,panel,listRuns:runs,dispose:()=>{close();win.cancelAnimationFrame(renderFrame);bindings.forEach(fn=>fn());observer.disconnect();for(const j of formatJobs.values())j.controller.abort();trigger.remove();anchorBadge.remove();entryAnchor.classList.remove('agent-toolbox-anchor');panel.remove();style.remove();}};
};
