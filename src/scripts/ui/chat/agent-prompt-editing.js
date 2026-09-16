import { t } from '../../i18n/index.js';
import { writeAgentPromptField } from './agent-prompt-fields.js';
import { createAgentPromptDiffCache, applyAgentPromptDiffHunk, renderAgentPromptDiff, isAgentPromptInlineEditable } from './agent-prompt-diff.js';

// A workspace owns one diff cache and one delegated editing lifecycle. Neither
// typing nor review actions replace a textarea or an active contenteditable.
export const mountAgentPromptEditing = ({ workspace, editor, output, sourceArea, getFields, getSourceId, saveField, onChange, onRender, onStatus }) => {
  const doc = workspace.ownerDocument, win = doc.defaultView;
  const cache = createAgentPromptDiffCache(), mirrors = new Map(), scrolled = new Set();
  let fields = [], busy = false, composing = false, disposed = false, frame = 0, timer = 0, pointerDown = false, pendingBlur = null;
  const find = id => fields.find(field => field.id === id);
  const plain = node => String(node.innerText ?? node.textContent ?? '').replace(/\r\n?/g,'\n');
  const positionMirror = (area, view) => {
    if (!view.diff?.changed || !area.isConnected || !area.clientWidth) return;
    const css = win.getComputedStyle(area);
    for (const prop of ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','textAlign','tabSize','wordBreak','overflowWrap']) view.mirror.style[prop] = css[prop];
    view.layer.style.left = `${area.clientLeft}px`; view.layer.style.top = `${area.clientTop}px`;
    view.layer.style.width = `${area.clientWidth}px`; view.layer.style.height = `${area.clientHeight}px`;
    view.mirror.style.width = `${area.clientWidth}px`;
    view.mirror.style.transform = `translate(${-area.scrollLeft}px,${-area.scrollTop}px)`;
  };
  const resize = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(entries => {
    for (const entry of entries) { const view=mirrors.get(entry.target); if(view) positionMirror(entry.target,view); }
  }) : null;
  const attach = area => {
    if (mirrors.has(area)) return mirrors.get(area);
    const wrap = doc.createElement('span'); wrap.className='prompt-diff-editor';
    const surface = doc.createElement('span'); surface.className='prompt-diff-surface';
    const layer = doc.createElement('span'); layer.className='prompt-diff-layer'; layer.setAttribute('aria-hidden','true');
    const mirror = doc.createElement('span'); mirror.className='prompt-diff-mirror'; layer.append(mirror);
    const review = doc.createElement('span'); review.className='prompt-diff-review'; review.hidden=true; review.dataset.i18nSkip='true';
    const feedback = doc.createElement('span'); feedback.className='prompt-diff-feedback'; feedback.setAttribute('role','status');
    area.before(wrap); wrap.append(surface,review,feedback); surface.append(area,layer);
    const view={wrap,layer,mirror,review,feedback,diff:null,html:''}; mirrors.set(area,view);
    return view;
  };
  const updateArea = (area, field) => {
    const view=attach(area), diff=field && cache.get(field);
    if (view.diff === diff && view.busy===busy) return;
    if(view.fieldId!==field?.id || view.diff?.draft!==diff?.draft)view.feedback.textContent='';
    view.fieldId=field?.id;
    view.review.dataset.promptReviewField=field?.id || '';
    view.diff=diff; view.busy=busy;
    const changed=Boolean(diff?.changed);
    view.wrap.classList.toggle('is-modified',changed); view.review.hidden=!changed;
    if (!changed) {view.mirror.innerHTML='';view.review.innerHTML='';view.html='';resize?.unobserve(area);return;}
    // Transparent glyphs reproduce textarea wrapping; green lines and zero
    // height red deletion marks do not alter the textarea's line/caret layout.
    view.mirror.innerHTML=diff.rows.map(row=>row.type==='del' ? '<span class="prompt-diff-delete-mark"></span>'
      : `<span class="prompt-diff-line${row.type==='add'?' is-added':''}"></span>`).join('');
    let index=0;
    for (const row of diff.rows) {const line=view.mirror.children[index++];if(row.type!=='del')line.textContent=row.text || '\u200b';}
    const html=renderAgentPromptDiff(diff,field.id,{busy,canSave:typeof saveField==='function'});
    if(html!==view.html){view.review.innerHTML=html;view.html=html;}
    view.review.setAttribute('aria-label',`${field.label} · ${t('未保存的修改')}`);
    resize?.observe(area);positionMirror(area,view);
  };
  const sync = () => {
    if(disposed || composing)return;
    fields=getFields(); cache.prune(new Set(fields.map(field=>field.id)));
    for(const [area,view] of mirrors) if(!area.isConnected) {resize?.unobserve(area);view.wrap.remove();mirrors.delete(area);}
    for(const field of fields) updateArea(field.element,field);
    updateArea(sourceArea,find(getSourceId()));
  };
  const schedule = () => {clearTimeout(timer);timer=win.setTimeout(sync,140);};
  const renderTarget = (target,text) => {
    const field=find(target.fieldId);
    if(!isAgentPromptInlineEditable(target,text,field))return null;
    const diff=cache.get(field);
    return { attributes:` class="prompt-inline${diff.changed?' is-modified':''}" data-prompt-inline tabindex="0" role="textbox" aria-multiline="true" spellcheck="false"${diff.changed?'':' contenteditable="plaintext-only"'}`,
      html:renderAgentPromptDiff(diff,field.id,{busy,canSave:typeof saveField==='function'}) };
  };
  const focusField = id => {
    const field=find(id);
    if(workspace.dataset.preview==='full')sourceArea.focus({preventScroll:true});
    else field?.element.focus({preventScroll:true});
  };
  const status = (id,message) => {
    onStatus(message);
    const field=find(id);
    for(const area of [field?.element,getSourceId()===id?sourceArea:null]) {
      const view=mirrors.get(area);if(view)view.feedback.textContent=message;
    }
  };
  const onClick = async event => {
    const control=event.target.closest('[data-prompt-diff-action]');
    if(control && workspace.contains(control)) {
      event.preventDefault();event.stopPropagation();
      if(busy || composing)return;
      if(workspace.dataset.promptMutation==='true'){onStatus(t('正在保存上一处修改，请稍候'));return;}
      fields=getFields();
      const field=find(control.dataset.promptDiffField);
      if(!field)return;
      const diff=cache.get(field);
      // Stale hunk indices must never act on a newer draft.
      if(diff.version!==Number(control.dataset.promptDiffVersion)){sync();onRender();return;}
      const mode=control.dataset.promptDiffAction;
      const value=applyAgentPromptDiffHunk(diff,Number(control.dataset.promptDiffHunk),mode);
      if(value===null)return;
      if(mode==='reject') {
        writeAgentPromptField(fields,field.id,value);sync();onChange();onRender();focusField(field.id);return;
      }
      if(typeof saveField!=='function')return;
      busy=true;workspace.dataset.promptMutation='true';
      const saveButtons=[...editor.querySelectorAll('[data-ac="save"],[data-agent-prompt-save],[data-memory-agent-save]')].map(button=>[button,button.disabled]);
      saveButtons.forEach(([button])=>{button.disabled=true;});
      sync();status(field.id,t('正在保存…'));
      try {
        const result=await saveField({field,value,baseValue:diff.base});
        if(disposed)return;
        if(!result?.ok)throw new Error(result?.message || '这处修改保存失败');
        if(field.element.isConnected)field.element.defaultValue=result.value ?? value;
        status(field.id,t('已接受该处修改并保存'));
      } catch(error) {if(!disposed)status(field.id,t(error.message || '这处修改保存失败'));}
      finally {
        busy=false;delete workspace.dataset.promptMutation;saveButtons.forEach(([button,disabled])=>{if(button.isConnected)button.disabled=disabled;});
        if(!disposed){sync();onRender();focusField(field.id);}
      }
      return;
    }
    const inline=event.target.closest('[data-prompt-inline]');
    if(!inline || !output.contains(inline) || inline.isContentEditable)return;
    const chosen=doc.getSelection();
    if(chosen && !chosen.isCollapsed && chosen.rangeCount && chosen.getRangeAt(0).intersectsNode(inline))return;
    fields=getFields(); const field=find(inline.dataset.promptField);
    if(!field)return;
    inline.textContent=field.value;
    inline.setAttribute('contenteditable','plaintext-only');inline.classList.add('is-editing');
    inline.focus({preventScroll:true});
    const selection=doc.getSelection(),range=doc.createRange();range.selectNodeContents(inline);range.collapse(false);selection.removeAllRanges();selection.addRange(range);
  };
  const onInlineInput = event => {
    const inline=event.target.closest('[data-prompt-inline]');
    if(!inline || composing)return;
    writeAgentPromptField(getFields(),inline.dataset.promptField,plain(inline));
    schedule();
  };
  const onBlur = event => {
    if(!event.target.matches('[data-prompt-inline]'))return;
    const field=getFields().find(item=>item.id===event.target.dataset.promptField);
    if(!event.target.classList.contains('is-editing') && !field?.element?.closest('.prompt-diff-editor')?.classList.contains('is-modified'))return;
    pendingBlur=event.target;
    win.setTimeout(flushBlur,0);
  };
  const flushBlur = () => {
    if(disposed || pointerDown || !pendingBlur || !doc.getSelection()?.isCollapsed)return;
    const target=pendingBlur;pendingBlur=null;sync();onRender(target);
  };
  const onPointerDown = () => {pointerDown=true;};
  const onPointerUp = () => {pointerDown=false;win.setTimeout(flushBlur,0);};
  const onKey = event => {
    if(event.target.matches('[data-prompt-inline]:not([contenteditable])') && ['Enter',' '].includes(event.key)) {event.preventDefault();event.target.click();}
  };
  const onScroll = event => {
    const view=mirrors.get(event.target);if(!view?.diff?.changed)return;
    scrolled.add(event.target);if(frame)return;
    frame=win.requestAnimationFrame(()=>{frame=0;if(!disposed)for(const area of scrolled){const item=mirrors.get(area);if(item)positionMirror(area,item);}scrolled.clear();});
  };
  const onStart = () => {composing=true;clearTimeout(timer);};
  const onEnd = event => {composing=false;onInlineInput(event);schedule();};
  const onBaseline = () => {sync();onRender();};
  workspace.addEventListener('click',onClick);
  workspace.addEventListener('pointerdown',onPointerDown,true);doc.addEventListener('pointerup',onPointerUp,true);doc.addEventListener('pointercancel',onPointerUp,true);doc.addEventListener('selectionchange',flushBlur);
  workspace.addEventListener('compositionstart',onStart);workspace.addEventListener('compositionend',onEnd);
  workspace.addEventListener('scroll',onScroll,{capture:true,passive:true});
  output.addEventListener('input',onInlineInput);output.addEventListener('focusout',onBlur);output.addEventListener('keydown',onKey);
  editor.addEventListener('agent-prompt-baseline-changed',onBaseline);
  return {sync,schedule,renderTarget,isEditing:node=>{
    if(node.contains(doc.activeElement) && doc.activeElement.matches('[data-prompt-inline][contenteditable]'))return true;
    const selection=doc.getSelection();
    return selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(node);
  },
    dispose(){disposed=true;clearTimeout(timer);if(frame)win.cancelAnimationFrame(frame);resize?.disconnect();
      workspace.removeEventListener('click',onClick);workspace.removeEventListener('compositionstart',onStart);workspace.removeEventListener('compositionend',onEnd);
      workspace.removeEventListener('pointerdown',onPointerDown,true);doc.removeEventListener('pointerup',onPointerUp,true);doc.removeEventListener('pointercancel',onPointerUp,true);doc.removeEventListener('selectionchange',flushBlur);
      workspace.removeEventListener('scroll',onScroll,true);output.removeEventListener('input',onInlineInput);output.removeEventListener('focusout',onBlur);output.removeEventListener('keydown',onKey);editor.removeEventListener('agent-prompt-baseline-changed',onBaseline);
      for(const [area,view] of mirrors)if(view.wrap.isConnected){view.wrap.before(area);view.wrap.remove();}mirrors.clear();
    },
  };
};
