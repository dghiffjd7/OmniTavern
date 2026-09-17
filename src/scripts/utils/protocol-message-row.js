import { normalizeChatProtocolTime } from './chat-time-policy.js';

const timeTail=/--\s*(\d{1,2}[:：]\d{2}(?:[:：]\d{2})?)\s*$/;

export const parseProtocolChatRow = line => {
  const raw=String(line ?? '').trim(),separator=raw.indexOf('--');
  if(separator<1)return null;
  const speaker=raw.slice(0,separator).trim();
  let content=raw.slice(separator+2).trim(),time='';
  const tail=content.match(timeTail);
  if(tail){time=normalizeChatProtocolTime(tail[1]);content=content.slice(0,tail.index).trim();}
  return speaker && content?{speaker,content,time}:null;
};

export const parseProtocolChatRows = (text, {allowPlain=false} = {}) => {
  // Keep <br> inside a bubble. Only the legacy time terminator immediately
  // followed by another speaker row can make <br> a message separator.
  const raw=String(text ?? '').replace(/\r\n?/g,'\n')
    .replace(/(--\s*\d{1,2}[:：]\d{2})\s*(?:<br\s*\/?>|&lt;br\s*\/?&gt;)\s*(?=[^<>\n]+?--)/gi,'$1\n');
  const messages=[];
  for(const line of raw.split('\n').map(row=>row.trim()).filter(Boolean)){
    const bullet=allowPlain && /^[-•*]\s+/.test(line);
    const row=bullet?{speaker:'',content:line.replace(/^[-•*]\s+/,''),time:''}:parseProtocolChatRow(line);
    const item=row || (allowPlain?{speaker:'',content:line,time:''}:null);
    if(item?.content)messages.push({...item,content:item.content.replace(/(?:<br\s*\/?>|&lt;br\s*\/?&gt;)/gi,'\n')});
  }
  return messages;
};

export const parseProtocolMomentHeader = line => {
  const parts=String(line ?? '').split('--').map(part=>part.trim());
  if(parts.length<4 || !/^-?\d+(?:\.\d+)?$/.test(parts.at(-1)) || !/^-?\d+(?:\.\d+)?$/.test(parts.at(-2)))return null;
  const likes=Number(parts.pop()),views=Number(parts.pop()),author=parts.shift();
  let time='';
  if(parts.length>1 && /^\d{1,2}[:：]\d{2}(?:[:：]\d{2})?$/.test(parts.at(-1)))time=normalizeChatProtocolTime(parts.pop());
  const content=parts.join('--').trim();
  return author && content?{author,content,time,views,likes,comments:[]}:null;
};
