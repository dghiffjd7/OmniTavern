import { mapPromptSelection, readPromptTextIndex, promptSelectionOffsets, promptSelectionRanges } from './agent-prompt-selection-model.js';

const HIGHLIGHT='agent-prompt-linked-selection';

// Mirror ranges without moving the browser selection or focusing the other
// pane. DOM indexes are lazy, request-local and invalidated only on edits/render.
export const mountAgentPromptSelection = ({workspace,editor,output,sourceArea,getSourceId,getState,onReveal}) => {
  const doc=workspace.ownerDocument,win=doc.defaultView,registry=win.CSS?.highlights;
  let fields=new Map(),areas=new Map(),targets=new Map(),right=new Map(),byField=new Map(),contexts=new Map();
  let cache=new WeakMap(),frame=0,disposed=false,composing=false,hint=null,highlight=null,reveal=false;
  const overlays=new Map();
  const indexFor=(node,mode='draft')=>{
    let modes=cache.get(node);if(!modes){modes=new Map();cache.set(node,modes);}
    if(!modes.has(mode))modes.set(mode,readPromptTextIndex(node,mode));
    return modes.get(mode);
  };
  const position=(area,view)=>{
    if(!area.isConnected || !area.clientWidth)return;
    const css=win.getComputedStyle(area);
    for(const prop of ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','textAlign','tabSize','wordBreak','overflowWrap'])view.text.style[prop]=css[prop];
    view.layer.style.left=`${area.clientLeft}px`;view.layer.style.top=`${area.clientTop}px`;
    view.layer.style.width=`${area.clientWidth}px`;view.layer.style.height=`${area.clientHeight}px`;
    view.text.style.width=`${area.clientWidth}px`;
    view.text.style.transform=`translate(${-area.scrollLeft}px,${-area.scrollTop}px)`;
  };
  const resize=typeof win.ResizeObserver==='function'?new win.ResizeObserver(entries=>{for(const {target} of entries){const view=overlays.get(target);if(view)position(target,view);}}):null;
  const overlayFor=area=>{
    if(!area.isConnected || area.closest('[inert]') || !area.clientWidth)return null;
    const surface=area.closest('.prompt-diff-surface');if(!surface)return null;
    let view=overlays.get(area);
    if(!view){
      const layer=doc.createElement('span');layer.className='prompt-selection-layer';layer.setAttribute('aria-hidden','true');
      const text=doc.createElement('span');text.className='prompt-selection-mirror';layer.append(text);surface.append(layer);
      view={layer,text,value:null};overlays.set(area,view);resize?.observe(area);position(area,view);
    }
    if(view.value!==area.value){view.value=area.value;view.text.textContent=area.value;cache.delete(view.text);}
    return view;
  };
  const clear=()=>{
    if(registry?.get(HIGHLIGHT)===highlight)registry.delete(HIGHLIGHT);
    highlight=null;
    for(const [area,view] of overlays){resize?.unobserve(area);view.layer.remove();}
    overlays.clear();
  };
  const elementOf=node=>node?.nodeType===1?node:node?.parentElement;
  const readSource=()=>{
    const active=doc.activeElement;
    if(active?.tagName==='TEXTAREA' && workspace.contains(active) && (hint===active || !hint)){
      const id=active===sourceArea?getSourceId():areas.get(active);
      if(id && active.selectionEnd>active.selectionStart)return {fieldId:id,key:`field:${id}`,node:active,text:active.value,start:active.selectionStart,end:active.selectionEnd,mode:'draft'};
    }
    const selection=doc.getSelection();
    if(!selection || selection.isCollapsed || !selection.rangeCount)return null;
    const range=selection.getRangeAt(0),common=elementOf(range.commonAncestorContainer);
    if(!common || !workspace.contains(common))return null;
    const review=common.closest('[data-prompt-review-field]');
    const anchor=common.closest('[data-prompt-key]');
    const context=common.closest('[data-prompt-context-key]');
    const node=review || anchor || context?.querySelector('pre');
    if(!node || !node.contains(range.startContainer) || !node.contains(range.endContainer))return null;
    const old=elementOf(range.startContainer)?.closest('.prompt-diff-del');
    const mode=old?.contains(range.endContainer)?'base':'draft';
    const index=indexFor(node,mode),offsets=promptSelectionOffsets(index,range);
    if(!offsets)return null;
    const key=anchor?.dataset.promptKey || context?.dataset.promptContextKey;
    const fieldId=review?.dataset.promptReviewField || anchor?.dataset.promptField || targets.get(key)?.fieldId;
    return {...offsets,node,mode,key:key || `field:${fieldId}`,fieldId,text:index.text};
  };
  const paint=()=>{
    frame=0;
    const shouldReveal=reveal;reveal=false;
    if(disposed || composing || getState()==='closed' || !registry || !win.Highlight){clear();return;}
    const source=readSource();if(!source){clear();return;}
    const candidates=new Set(),usedAreas=new Set(),ranges=[],matches=[];
    const add=node=>{if(node && node!==source.node && node.isConnected)candidates.add(node);};
    add(contexts.get(source.key));add(right.get(source.key));
    if(source.fieldId){
      const area=fields.get(source.fieldId)?.element;
      add(area);add(area?.closest('.prompt-diff-editor')?.querySelector('[data-prompt-review-field]'));
      if(source.fieldId===getSourceId()){
        add(sourceArea);add(sourceArea.closest('.prompt-diff-editor')?.querySelector('[data-prompt-review-field]'));
      }
      for(const node of byField.get(source.fieldId) || [])add(node);
      add(contexts.get(`field:${source.fieldId}`));
    }
    for(const node of candidates){
      if(node.tagName==='TEXTAREA'){
        if(source.mode==='base')continue;
        const mapped=mapPromptSelection(source.text,node.value,source.start,source.end);
        if(!mapped)continue;
        const view=overlayFor(node);if(!view)continue;
        usedAreas.add(node);const linked=promptSelectionRanges(indexFor(view.text),mapped.start,mapped.end,doc);ranges.push(...linked);
        matches.push({node,ranges:linked,position:()=>position(node,view)});
      } else {
        const index=indexFor(node,source.mode),mapped=mapPromptSelection(source.text,index.text,source.start,source.end);
        if(mapped){const linked=promptSelectionRanges(index,mapped.start,mapped.end,doc);ranges.push(...linked);matches.push({node,ranges:linked});}
      }
    }
    for(const [area,view] of overlays)if(!usedAreas.has(area)){resize?.unobserve(area);view.layer.remove();overlays.delete(area);}
    if(ranges.length){highlight=new win.Highlight(...ranges);registry.set(HIGHLIGHT,highlight);}
    else if(registry.get(HIGHLIGHT)===highlight){registry.delete(HIGHLIGHT);highlight=null;}
    if(shouldReveal && ranges.length)onReveal?.(source,matches);
  };
  const schedule=()=>{if(!frame && !disposed)frame=win.requestAnimationFrame(paint);};
  const onIntent=event=>{hint=event.target.tagName==='TEXTAREA'?event.target:null;schedule();};
  const onInput=()=>{cache=new WeakMap();schedule();};
  const onSelectionEnd=()=>{reveal=true;schedule();};
  const onScroll=event=>{
    const view=overlays.get(event.target);
    if(view)view.text.style.transform=`translate(${-event.target.scrollLeft}px,${-event.target.scrollTop}px)`;
  };
  const onStart=()=>{composing=true;clear();};
  const onEnd=()=>{composing=false;onInput();};
  doc.addEventListener('selectionchange',schedule);
  for(const name of ['pointerdown','keydown','focusin'])workspace.addEventListener(name,onIntent,true);
  workspace.addEventListener('select',schedule);
  for(const name of ['pointerup','keyup'])workspace.addEventListener(name,onSelectionEnd);
  workspace.addEventListener('input',onInput);workspace.addEventListener('scroll',onScroll,{capture:true,passive:true});
  workspace.addEventListener('compositionstart',onStart);workspace.addEventListener('compositionend',onEnd);
  return {
    update(model,currentFields){
      fields=new Map(currentFields.map(field=>[field.id,field]));areas=new Map(currentFields.map(field=>[field.element,field.id]));
      targets=new Map([...(model?.targets || []),...(model?.stages || []).flatMap(stage=>[...stage.targets])]);
      right=new Map();byField=new Map();contexts=new Map();cache=new WeakMap();
      output.querySelectorAll('[data-prompt-key]').forEach(node=>{right.set(node.dataset.promptKey,node);const id=node.dataset.promptField;if(id){if(!byField.has(id))byField.set(id,[]);byField.get(id).push(node);}});
      editor.querySelectorAll('[data-prompt-context-key]').forEach(node=>contexts.set(node.dataset.promptContextKey,node.querySelector('pre')));
      schedule();
    },
    refresh:onInput,
    clear,
    dispose(){disposed=true;if(frame)win.cancelAnimationFrame(frame);clear();resize?.disconnect();
      doc.removeEventListener('selectionchange',schedule);
      for(const name of ['pointerdown','keydown','focusin'])workspace.removeEventListener(name,onIntent,true);
      workspace.removeEventListener('select',schedule);
      for(const name of ['pointerup','keyup'])workspace.removeEventListener(name,onSelectionEnd);
      workspace.removeEventListener('input',onInput);workspace.removeEventListener('scroll',onScroll,true);
      workspace.removeEventListener('compositionstart',onStart);workspace.removeEventListener('compositionend',onEnd);
    },
  };
};
