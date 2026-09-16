// One frame per user interaction; no polling, prompt building, or text scanning
// in scroll handlers. Only the rendered anchor index is consulted here.
import { chooseAgentPromptScrollAnchor } from './agent-prompt-navigation-model.js';

export const mountAgentPromptNavigation = ({ editor, scroll, output, getState, onActive, revealContext, isSourceEditing = () => false, initialActive = null } = {}) => {
  const doc = editor.ownerDocument, win = doc.defaultView;
  let model = null, fields = [], left = new Map(), right = new Map(), roots = [];
  let active = initialActive, pendingOpen = false, frame = 0, settleFrame = 0, job = null, disposed = false;
  let composing = false, guard = new WeakMap(), highlighted = [];
  let markedKey = '', markedTarget = null, markedReason = '';
  let driver = '', dragging = false;
  const footer=editor.querySelector('.agent-memory-save,.ac-footer');
  const readingViewport = container => {
    const rect=container.getBoundingClientRect();
    if(container!==editor || !footer?.isConnected)return rect;
    const top=footer.getBoundingClientRect().top;
    return {top:rect.top,bottom:top>rect.top?Math.min(top,rect.bottom):rect.bottom};
  };
  const visible = element => {
    if(!element?.isConnected || !element.getClientRects().length)return false;
    for(let parent=element.parentElement;parent;parent=parent.parentElement) {
      if(parent.tagName==='DETAILS' && !parent.open && !parent.querySelector('summary')?.contains(element))return false;
    }
    return true;
  };
  const rectVisible = (element, container) => {
    if (!visible(element)) return false;
    const rect = element.getBoundingClientRect(), viewport = readingViewport(container);
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  };
  const lookup = key => model?.targets.get(key) || model?.stages.flatMap(stage => [...stage.targets.values()]).find(target => target.key === key);
  const rightElement = key => right.get(lookup(key)?.anchorKey || key);
  const leftElement = key => {
    const element=left.get(key), closed=element?.closest('details:not([open])');
    return closed && element.tagName!=='DETAILS' ? closed.querySelector('summary') : element;
  };
  const guardedScroll = (element, top) => {
    const dest = Math.max(0,Math.min(top,element.scrollHeight-element.clientHeight));
    if (Math.abs(element.scrollTop-dest) < 1) return;
    element.scrollTop = dest;
    guard.set(element,element.scrollTop);
  };
  const isEcho = element => {
    if (!guard.has(element)) return false;
    const expected = guard.get(element); guard.delete(element);
    return Math.abs(element.scrollTop-expected) < 2;
  };
  const expandParents = (element, boundary) => {
    for (let parent = element?.parentElement; parent && parent !== boundary; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS' && !parent.open) parent.open = true;
    }
  };
  const align = (element, container, ratio = 0, textOffset = null, {force=false,expand=true} = {}) => {
    if (!element) return;
    if(expand)expandParents(element,container);
    const bounds = element.getBoundingClientRect(), viewport = readingViewport(container);
    let top = bounds.top + Math.max(0,Math.min(1,ratio))*bounds.height;
    if (textOffset !== null) {
      const walker = doc.createTreeWalker(element,4);
      let node, offset = textOffset;
      while ((node=walker.nextNode())) {
        if (offset > node.length) { offset-=node.length; continue; }
        const range = doc.createRange(); range.setStart(node,offset); range.collapse(true);
        const rect = range.getBoundingClientRect();
        if (rect.height) top = rect.top;
        break;
      }
    }
    if(force)guardedScroll(container,container.scrollTop+top-viewport.top-container.clientHeight*.28);
    else {
      // Reveal only when leaving a comfortable reading band; never recenter
      // the following pane on every wheel tick or caret movement.
      const padding=Math.min(48,container.clientHeight*.12);
      const bottom=textOffset===null && ratio===0 ? Math.min(bounds.bottom,top+container.clientHeight-padding*2) : top+24;
      if(top<viewport.top+padding)guardedScroll(container,container.scrollTop+top-viewport.top-padding);
      else if(bottom>viewport.bottom-padding)guardedScroll(container,container.scrollTop+bottom-viewport.bottom+padding);
    }
  };
  const mark = (key,reason='focus') => {
    const next=[leftElement(key),rightElement(key)].filter(Boolean), target=lookup(key);
    if(markedKey===key && markedTarget===target && (reason==='scroll' || markedReason===reason) && highlighted.length===next.length && next.every((node,index)=>node===highlighted[index]))return;
    markedKey=key;markedTarget=target;markedReason=reason;
    for (const element of highlighted) element.removeAttribute('data-preview-active');
    highlighted = next;
    for (const element of highlighted) element.setAttribute('data-preview-active','true');
    onActive?.(key,lookup(key),{reason});
  };
  const select = (key, { side = 'left', ratio = 0, offset = null, element = null, alignOther = true, reason = 'focus' } = {}) => {
    if (!key) return;
    active = { key,side,ratio,offset,reason };
    driver=side;
    if (getState() === 'closed') return;
    mark(key,reason);
    if (!alignOther) {
      if(frame)win.cancelAnimationFrame(frame);frame=0;job=null;
      guard.set(editor,editor.scrollTop);guard.set(scroll,scroll.scrollTop);
      return;
    }
    if (composing) return;
    const passive=reason==='scroll',force=reason==='open' || reason==='locate';
    if (side === 'left') {
      const target = rightElement(key);
      if (!target) return;
      const field = fields.find(item => `field:${item.id}` === key);
      const exact = offset !== null && field && target.textContent === (field.element?.value ?? field.value);
      align(target,scroll,ratio,exact ? offset : null,{force});
      // content-visibility can settle message heights after the first frame.
      // One bounded correction keeps deep links accurate without measuring all
      // off-screen messages or running a continuous animation loop.
      if(settleFrame)win.cancelAnimationFrame(settleFrame);
      if(force)settleFrame=win.requestAnimationFrame(()=>{
        settleFrame=0;
        if(!disposed && getState()!=='closed' && driver==='left' && active?.key===key && active.side==='left')align(target,scroll,ratio,exact?offset:null,{force:true});
      });
    } else if (getState() === 'split') {
      let target = passive ? leftElement(key) : left.get(key);
      if (!target) return;
      if(target.tagName==='DETAILS') {
        if(!passive && !target.open)target.open=true;
        if(target.open){revealContext?.(target);target=target.querySelector('pre') || target;}
        else target=target.querySelector('summary') || target;
      }
      align(target,editor,0,null,{force,expand:!passive});
      if (/^(PRE|TEXTAREA)$/.test(target.tagName) && target.scrollHeight>target.clientHeight+2) guardedScroll(target,ratio*(target.scrollHeight-target.clientHeight));
    }
  };
  const closestLeft = node => {
    const field = fields.find(item => item.element === node || item.element.contains(node));
    if (field) return {key:`field:${field.id}`,element:field.element};
    const context = node.closest?.('[data-prompt-context-key]');
    if (context) return {key:context.dataset.promptContextKey,element:context.querySelector('pre') || context.querySelector('summary')};
    const block = node.closest?.('.agent-memory-prompt-block,[data-agent-prompt-editor],.ac-task,.ac-block');
    const children = fields.filter(item => block?.contains(item.element));
    const found = children.find(item => lookup(`field:${item.id}`)) || children[0];
    if (found) return {key:`field:${found.id}`,element:found.element};
    return null;
  };
  const atViewport = (entries, container) => {
    const viewport = container.getBoundingClientRect(), line = viewport.top+container.clientHeight*.28;
    const messageRects=new Map();
    let selected = null, distance = Infinity;
    const rows=[];
    for (const [key,element] of entries) {
      if(container===scroll) {
        const article=element.closest('.hop-request-message');
        if(article) {
          if(!messageRects.has(article))messageRects.set(article,article.getBoundingClientRect());
          const rect=messageRects.get(article);
          if(rect.bottom<=viewport.top || rect.top>=viewport.bottom)continue;
        }
      }
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      if(container===scroll){rows.push({key,element,top:rect.top,bottom:rect.bottom,parentKey:lookup(key)?.parentKey});continue;}
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      const gap = line < rect.top ? rect.top-line : line > rect.bottom ? line-rect.bottom : 0;
      if (gap <= distance) { selected={key,element,ratio:Math.max(0,Math.min(1,(line-rect.top)/Math.max(1,rect.height)))}; distance=gap; }
    }
    if(container===scroll){const hit=chooseAgentPromptScrollAnchor(rows,line,active?.key);return hit?{...hit,ratio:Math.max(0,Math.min(1,(line-hit.top)/Math.max(1,hit.bottom-hit.top)))}:null;}
    return selected;
  };
  const readLeft = node => {
    const hit = closestLeft(node);
    if (!hit) return null;
    const value = String(hit.element?.value || '');
    return {...hit,offset:typeof hit.element?.selectionStart==='number'?hit.element.selectionStart:null,
      ratio:value.length ? (hit.element.selectionStart || 0)/value.length : 0};
  };
  const schedule = callback => {
    job=callback;
    if (frame || disposed) return;
    frame=win.requestAnimationFrame(() => { frame=0;const next=job;job=null;if(!disposed) next?.(); });
  };
  const onLeftFocus = event => {
    if (composing || !editor.contains(event.target)) return;
    const hit=readLeft(event.target);
    if (hit) {
      if(frame)win.cancelAnimationFrame(frame);frame=0;job=null;
      // A queued scroll from focusing/revealing this field must not supersede
      // the explicit focus with a neighbouring field at the viewport guide.
      guard.set(editor,editor.scrollTop);
      select(hit.key,{...hit,side:'left',alignOther:getState()!=='closed'});
    }
  };
  const onLeftScroll = event => {
    if (getState()==='closed' || composing || isEcho(event.target) || driver==='right' || dragging) return;
    schedule(() => {
      if (getState()==='closed') return;
      if (event.target===editor) {
        const hit=atViewport(left,editor); if(hit) select(hit.key,{...hit,side:'left',reason:'scroll'});
      } else {
        const hit=closestLeft(event.target);
        if(hit) select(hit.key,{side:'left',reason:'scroll',ratio:event.target.scrollTop/Math.max(1,event.target.scrollHeight-event.target.clientHeight)});
      }
    });
  };
  const onRightScroll = event => {
    if (event.target!==scroll || getState()==='closed' || composing || isEcho(scroll) || isSourceEditing() || driver==='left' || dragging) return;
    if(settleFrame)win.cancelAnimationFrame(settleFrame);settleFrame=0;
    schedule(() => {
      const hit=atViewport(roots,scroll); if(!hit) return;
      // Preserve the user's exact field when it links to an expanded template.
      const key=active && rightElement(active.key)===hit.element ? active.key : hit.key;
      select(key,{...hit,side:'right',reason:'scroll'});
    });
  };
  const onRightClick = event => {
    if(event.target.closest?.('[data-prompt-diff-action]'))return;
    const anchor=event.target.closest?.('[data-prompt-key]');
    if (!anchor || !output.contains(anchor)) return;
    const rect=anchor.getBoundingClientRect();
    select(anchor.dataset.promptKey,{side:'right',reason:'click',element:anchor,ratio:Math.max(0,Math.min(1,(event.clientY-rect.top)/Math.max(1,rect.height)))});
  };
  const onIntent = event => {
    driver=editor.contains(event.target)?'left':'right';
    if(settleFrame)win.cancelAnimationFrame(settleFrame);settleFrame=0;
    if(frame)win.cancelAnimationFrame(frame);frame=0;job=null;
    if(event.type==='pointerdown' && event.button===0 && event.target.closest?.('textarea,pre,[data-prompt-inline]'))dragging=true;
  };
  const onPointerEnd = () => {dragging=false;};
  const revealSelection = (source,candidates) => {
    if(getState()==='closed' || composing)return;
    const fromLeft=editor.contains(source.node),container=fromLeft?scroll:editor;
    if(!fromLeft && getState()!=='split')return;
    const viewport=readingViewport(container);
    const matches=candidates.filter(item=>container.contains(item.node) && item.ranges.length);
    // Prefer the live textarea to its duplicate diff review; when a field is
    // used in several request stages, reveal the nearest occurrence.
    const rank=item=>{
      const rect=item.node.getBoundingClientRect();
      return (item.node.matches('[data-prompt-review-field]') && source.mode!=='base'?1e6:0)
        + Math.max(viewport.top-rect.bottom,rect.top-viewport.bottom,0);
    };
    matches.sort((a,b)=>rank(a)-rank(b));
    const hit=matches[0];if(!hit)return;
    driver=fromLeft?'left':'right';
    expandParents(hit.node,container);
    const first=hit.ranges[0];
    const revealIn=box=>{
      const rect=first.getClientRects()[0];if(!rect?.height)return;
      const bounds=readingViewport(box),padding=Math.min(20,box.clientHeight*.1);
      if(rect.top<bounds.top+padding)guardedScroll(box,box.scrollTop+rect.top-bounds.top-padding);
      else if(rect.bottom>bounds.bottom-padding)guardedScroll(box,box.scrollTop+rect.bottom-bounds.bottom+padding);
    };
    if(hit.node.matches('textarea,pre,[data-prompt-review-field]') && hit.node.scrollHeight>hit.node.clientHeight+2)revealIn(hit.node);
    // Textarea mirrors track their own scroll with a transform. Account for
    // the new scroll position before measuring the outer pane.
    hit.position?.();
    revealIn(container);
  };
  const onCompositionStart = () => { composing=true; };
  const onCompositionEnd = event => { composing=false;onLeftFocus(event); };
  for (const name of ['focusin','click','keyup']) editor.addEventListener(name,onLeftFocus);
  editor.addEventListener('scroll',onLeftScroll,{capture:true,passive:true});
  editor.addEventListener('compositionstart',onCompositionStart);editor.addEventListener('compositionend',onCompositionEnd);
  scroll.addEventListener('scroll',onRightScroll,{passive:true});output.addEventListener('click',onRightClick);
  for(const pane of [editor,scroll])for(const name of ['wheel','pointerdown','touchstart','keydown'])pane.addEventListener(name,onIntent,{capture:true,passive:true});
  doc.addEventListener('pointerup',onPointerEnd,true);doc.addEventListener('pointercancel',onPointerEnd,true);
  const update = (nextModel,nextFields) => {
    model=nextModel;fields=nextFields;left=new Map();right=new Map();roots=[];
    editor.querySelectorAll('[data-prompt-context-key]').forEach(node => left.set(node.dataset.promptContextKey,node));
    for (const field of fields) left.set(`field:${field.id}`,field.element);
    for(const stage of model.stages)for(const target of stage.targets.values()) {
      const field=fields.find(item=>item.id===target.fieldId);if(field)left.set(target.key,field.element);
    }
    output.querySelectorAll('[data-prompt-key]').forEach(node => { right.set(node.dataset.promptKey,node);roots.push([node.dataset.promptKey,node]); });
    if (getState()==='closed') return;
    if (pendingOpen && model.messages.length) {
      pendingOpen=false;
      if (!active?.key) {
        const field=fields.find(item=>lookup(`field:${item.id}`)) || fields[0];
        active={key:model.targets.has('memory:data')?'memory:data':field?`field:${field.id}`:model.contexts[0]?.key,side:'left',ratio:0};
      }
      schedule(()=>{
        const selected=leftElement(active?.key);
        // Splitting the pane changes wrapping above the selected field. Keep
        // the originating block visible too, without expanding folded groups.
        if(getState()==='split' && selected && !rectVisible(selected,editor))align(selected,editor);
        select(active?.key,{...active,side:'left',reason:'open'});
      });
    } else if (active) {
      mark(active.key,active.reason);
      // Rebuilt prompt lengths can change. Keep the current linked block in
      // place, but never scroll a user away while editing the right-hand draft.
      if (!scroll.contains(doc.activeElement) && active.reason!=='scroll') schedule(()=>select(active.key,{...active,reason:'refresh'}));
    }
  };
  return {
    update,select,revealSelection,
    captureOpen: (currentFields=fields) => {
      fields=currentFields;
      for(const [key] of left)if(key.startsWith('field:'))left.delete(key);
      for(const field of fields)left.set(`field:${field.id}`,field.element);
      const focused=editor.contains(doc.activeElement)?readLeft(doc.activeElement):null;
      const last=active?.side==='left'?leftElement(active.key):null;
      const hit=focused || (last && rectVisible(last,editor)?active:atViewport(left,editor));
      active=hit?{key:hit.key,ratio:hit.ratio || 0,offset:hit.offset ?? null,side:'left'}:null;pendingOpen=true;
    },
    opened: () => { if(model) update(model,fields); },
    closed: () => { pendingOpen=false;driver='';dragging=false; if(frame) win.cancelAnimationFrame(frame);if(settleFrame)win.cancelAnimationFrame(settleFrame);frame=0;settleFrame=0;job=null;guard=new WeakMap(); },
    getActive: () => active,
    dispose: () => {
      disposed=true;if(frame)win.cancelAnimationFrame(frame);if(settleFrame)win.cancelAnimationFrame(settleFrame);
      for(const name of ['focusin','click','keyup'])editor.removeEventListener(name,onLeftFocus);
      editor.removeEventListener('scroll',onLeftScroll,true);editor.removeEventListener('compositionstart',onCompositionStart);editor.removeEventListener('compositionend',onCompositionEnd);
      scroll.removeEventListener('scroll',onRightScroll);output.removeEventListener('click',onRightClick);
      for(const pane of [editor,scroll])for(const name of ['wheel','pointerdown','touchstart','keydown'])pane.removeEventListener(name,onIntent,true);
      doc.removeEventListener('pointerup',onPointerEnd,true);doc.removeEventListener('pointercancel',onPointerEnd,true);
    },
  };
};
