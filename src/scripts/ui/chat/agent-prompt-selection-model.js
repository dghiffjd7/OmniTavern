export const promptLineOffsets = text => {
  const offsets=[0];
  for(let i=0;i<text.length;i++)if(text[i]==='\n')offsets.push(i+1);
  return offsets;
};

// Only two representations of the same known source may share a selection.
// Assemblers sometimes trim source padding; expanded macros are not guessed.
export const mapPromptSelection = (source,target,start,end) => {
  if(start>=end)return null;
  if(source===target)return {start,end};
  if(!source.trim() || source.trim()!==target.trim())return null;
  const from=source.length-source.trimStart().length,to=target.length-target.trimStart().length;
  const a=Math.max(from,start),b=Math.min(source.trimEnd().length,end);
  return a<b ? {start:a-from+to,end:b-from+to} : null;
};

// A diff carries explicit line offsets. Deleted lines and action glyphs must
// not shift the live request's coordinates or enter a mirrored selection.
export const readPromptTextIndex = (root,mode='draft') => {
  const segments=[];let cursor=0;
  const add=(node,start=cursor,length=node.data.length)=>{if(length>0)segments.push({node,start,end:start+length});};
  const visit=node=>{
    if(node.nodeType===3){add(node);cursor+=node.data.length;return;}
    if(node.nodeType!==1)return;
    if(node.classList.contains('prompt-diff-actions'))return;
    const length=node.getAttribute(`data-prompt-${mode}-length`);
    if(length!==null){
      const origin=cursor;
      for(const line of node.querySelectorAll(`[data-prompt-${mode}-start]`)){
        let at=origin+Number(line.getAttribute(`data-prompt-${mode}-start`));
        const end=origin+Number(line.getAttribute(`data-prompt-${mode}-end`));
        const walker=root.ownerDocument.createTreeWalker(line,4);let text;
        while((text=walker.nextNode()) && at<end){const size=Math.min(text.data.length,end-at);add(text,at,size);at+=size;}
      }
      cursor+=Number(length);return;
    }
    for(const child of node.childNodes)visit(child);
  };
  visit(root);
  let text='',end=0;
  for(const part of segments){text+='\n'.repeat(Math.max(0,part.start-end))+part.node.data.slice(0,part.end-part.start);end=part.end;}
  text+='\n'.repeat(Math.max(0,cursor-end));
  return {text,segments};
};

export const promptSelectionOffsets = (index,range) => {
  let start=null,end=null;
  for(const part of index.segments){
    if(!range.intersectsNode(part.node))continue;
    const a=range.startContainer===part.node?Math.min(part.end-part.start,range.startOffset):0;
    const b=range.endContainer===part.node?Math.min(part.end-part.start,range.endOffset):part.end-part.start;
    if(a>=b)continue;
    start=start===null?part.start+a:Math.min(start,part.start+a);end=part.start+b;
  }
  return start!==null && end>start?{start,end}:null;
};

export const promptSelectionRanges = (index,start,end,doc) => {
  const ranges=[];
  for(const part of index.segments){
    const a=Math.max(start,part.start),b=Math.min(end,part.end);
    if(a>=b)continue;
    const range=doc.createRange();range.setStart(part.node,a-part.start);range.setEnd(part.node,b-part.start);ranges.push(range);
  }
  return ranges;
};
