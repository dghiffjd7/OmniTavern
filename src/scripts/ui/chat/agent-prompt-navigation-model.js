import { buildFullPromptDocument } from './prompt-preview-view-utils.js';
import { getRequestPromptFieldIds } from './agent-prompt-fields.js';

// Whitespace between owned fields belongs to the preceding field. Falling
// back to its large parent here makes the editor jump between two hierarchies.
export const chooseAgentPromptScrollAnchor = (rows, line, activeKey = '') => {
  const distance = row => line < row.top ? row.top-line : line > row.bottom ? line-row.bottom : 0;
  const keys=new Set(rows.map(row=>row.key));
  const roots = rows.filter(row => !row.parentKey || !keys.has(row.parentKey));
  const root = roots.reduce((best,row) => !best || distance(row)<distance(best) ? row : best,null);
  if (!root) return null;
  const children=rows.filter(row=>row.parentKey===root.key).sort((a,b)=>a.top-b.top);
  if(!children.length)return root;
  let index=0;
  for(let i=0;i<children.length && children[i].top<=line;i++)index=i;
  const active=children.findIndex(row=>row.key===activeKey);
  // A small dead band avoids toggling adjacent short labels on fractional
  // wheel deltas or font/layout rounding at the viewport guide.
  if(active>=0 && Math.abs(active-index)===1 && Math.abs(line-children[Math.max(active,index)].top)<10)return children[active];
  return children[index];
};

export const agentPromptMessageText = message => {
  const plain = buildFullPromptDocument({ messages: [message] }).plain;
  return plain.slice(plain.indexOf('\n') + 1);
};

// Navigation is a read-only projection. Ranges never grant permission to edit
// request text; writes still go through the editor's explicit field contract.
const uniqueRange = (text, value, from = 0, to = text.length) => {
  if (!value) return null;
  const start = text.indexOf(value, from);
  if (start < from || start + value.length > to) return null;
  const next = text.indexOf(value, start + 1);
  return next >= 0 && next + value.length <= to ? null : { start, end: start + value.length };
};

const memoryFieldOwner = id => {
  if (id.startsWith('memory:guide:') || id.includes(':rule:') || id.includes(':column:')) return 'memory:guide';
  return 'memory:data';
};

export const buildAgentPromptNavigation = (request, fields = [], prefix = 'request') => {
  const sourceKey = key => prefix==='request'?key:`${prefix}:${key}`;
  const messages = (request?.messages || []).map((message, index) => ({
    key: `${prefix}:${index}`, text: agentPromptMessageText(message), message, section: request.sections?.[index], roots: [], fields: [],
  }));
  const targets = new Map(), contexts = [];
  const addTarget = (message, key, range, label, extra = {}) => {
    const target = { key, messageKey: message.key, ...range, label, ...extra };
    if (!targets.has(key)) targets.set(key, target);
    return target;
  };
  const claimSource = (key, label, content, fieldIds = []) => {
    // A repeated literal (e.g. a quoted prompt in chat history) is ambiguous.
    // Do not jump to the first occurrence or make it writable.
    if (!content) return;
    const matches = messages.flatMap(message => {
      const first=message.text.indexOf(content);
      if(first>=0 && message.text.indexOf(content,first+1)>=0)return [{ambiguous:true}];
      const range = uniqueRange(message.text, content);
      return range ? [{ message, range }] : [];
    });
    if (matches.length !== 1 || matches[0].ambiguous) return;
    const { message, range } = matches[0];
    if (message.roots.some(root => range.start < root.end && range.end > root.start)) return;
    message.roots.push(addTarget(message, key, range, label, { fieldIds, ...(key.startsWith('field:')?{fieldId:key.slice(6)}:{}) }));
  };
  const memory = request?.agentPromptContext?.memory;
  if (memory) {
    claimSource(sourceKey('memory:data'), '当前表格内容', memory.dataPromptText);
    claimSource(sourceKey('memory:guide'), '组装后的写表指导', memory.guidePromptText);
  }
  for (const source of request?.agentPromptContext?.sources || []) {
    claimSource(sourceKey(`field:${source.fieldId}`), source.label || fields.find(field => field.id === source.fieldId)?.label || '提示词', source.content, [source.fieldId]);
  }
  for (const message of messages) {
    const ids = getRequestPromptFieldIds(message.section, fields);
    if (!message.roots.length) message.roots.push(addTarget(message, message.key, { start: 0, end: message.text.length },
      message.section?.source || `${message.message.role || 'message'} · ${messages.indexOf(message) + 1}`, { fieldIds: ids }));
    else {
      const roots = message.roots.sort((a,b) => a.start - b.start), gaps = [];
      let cursor = 0;
      for (const root of roots) {
        if (message.text.slice(cursor, root.start).trim()) gaps.push(addTarget(message, `${message.key}:${cursor}`, { start:cursor, end:root.start }, message.section?.source || `${message.message.role} · ${messages.indexOf(message) + 1}`));
        cursor = root.end;
      }
      if (message.text.slice(cursor).trim()) gaps.push(addTarget(message, `${message.key}:${cursor}`, {start:cursor,end:message.text.length}, message.section?.source || `${message.message.role} · ${messages.indexOf(message) + 1}`));
      message.roots.push(...gaps); message.roots.sort((a,b) => a.start - b.start);
    }
    for (const root of message.roots) contexts.push({key:root.key, label:root.label, content:message.text.slice(root.start,root.end)});
  }
  for (const field of fields) {
    const key = sourceKey(`field:${field.id}`);
    if (targets.has(key)) {targets.get(key).fieldId=field.id;continue;}
    let owner = field.id.startsWith('memory:') ? targets.get(sourceKey(memoryFieldOwner(field.id))) : null;
    if (!owner && field.id.startsWith('memory:table:')) owner = targets.get(sourceKey('memory:guide'));
    if (!owner) {
      const candidates=[...targets.values()].filter(target=>target.fieldIds?.includes(field.id));
      owner=candidates.find(target=>{
        const message=messages.find(item=>item.key===target.messageKey);
        return message.section?.editField===field.id;
      }) || candidates[0];
    }
    if (!owner) continue;
    const message = messages.find(item => item.key === owner.messageKey);
    const value = String(field.value || '').trim();
    // Exact literal inside the known source. Macro/template expansion remains a
    // block-level navigation link, never a replacement of rendered values.
    const range = uniqueRange(message.text, value, owner.start, owner.end);
    if (range && !message.fields.some(target => range.start < target.end && range.end > target.start)) {
      const target = addTarget(message,key,range,field.label,{fieldId:field.id,parentKey:owner.key,exact:true});
      message.fields.push(target);
    } else if (!field.id.startsWith('memory:guide:') || /\{[^{}]+\}/.test(value)) {
      targets.set(key,{...owner,key,label:field.label,fieldId:field.id,anchorKey:owner.key,exact:false});
    }
  }
  const stages = (request?.stages || []).map((stage,index) => buildAgentPromptNavigation({...stage,stages:[]},fields,`${prefix}:stage:${index}`));
  return {messages,targets,contexts,stages};
};

export const renderAgentPromptAnchors = (message, escapeHtml, renderTarget = null) => {
  const wrap = (target, content, leaf = true) => {
    const edit = leaf && renderTarget?.(target,message.text.slice(target.start,target.end));
    return `<span data-prompt-key="${escapeHtml(target.key)}"${target.fieldId ? ` data-prompt-field="${escapeHtml(target.fieldId)}"` : ''}${edit ? ` aria-label="${escapeHtml(target.label)}"` : ''}${edit?.attributes || ''}>${edit?.html ?? content}</span>`;
  };
  let html = '', cursor = 0;
  for (const root of message.roots) {
    html += escapeHtml(message.text.slice(cursor,root.start));
    let body = '', offset = root.start;
    for (const field of message.fields.filter(field => field.start >= root.start && field.end <= root.end).sort((a,b) => a.start-b.start)) {
      body += escapeHtml(message.text.slice(offset,field.start)) + wrap(field,escapeHtml(message.text.slice(field.start,field.end)));
      offset = field.end;
    }
    body += escapeHtml(message.text.slice(offset,root.end));
    html += wrap(root,body,!message.fields.some(field=>field.start>=root.start && field.end<=root.end)); cursor = root.end;
  }
  return html + escapeHtml(message.text.slice(cursor));
};
