import { buildRichTextRenderPlan } from './rich-text-renderer.js';
import { detectRichCodeBlockRoute, RICH_RENDER_LEVELS } from './rich-render-routing.js';
import { resolveAgentTextTargetAsync } from '../../agent/agent-text-target.js';
import { resolveRenderedAgentTarget, collectRenderedAgentExcludedRanges } from '../../agent/agent-rendered-target.js';

const failure = message => ({ ok: false, mode: 'rendered', reason: 'rendered_target_unavailable', message });
const boundaryRanges = (source, boundaries) => {
  const { prefix, suffix } = boundaries || {};
  if (!prefix || !suffix) return [];
  const ranges = []; let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(prefix, cursor); if (start < 0) break;
    const closing = source.indexOf(suffix, start + prefix.length);
    const end = closing < 0 ? source.length : closing + suffix.length;
    ranges.push({ start, end }); cursor = end;
  }
  return ranges;
};
const omitRanges = (source, ranges) => {
  let end = 0, result = '';
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (range.end <= end) continue;
    result += source.slice(end, Math.max(end, range.start));
    result += '\n'; end = Math.max(end, range.end);
  }
  return result + source.slice(end);
};
const blockTags = new Set(['P','DIV','SECTION','ARTICLE','MAIN','HEADER','FOOTER','BLOCKQUOTE','LI','UL','OL','H1','H2','H3','H4','H5','H6','CONTENT','STORY','NARRATIVE']);

// Read the same display-regex source used by the chat renderer, in an inert template.
// No iframe, scripts, images, metadata widgets or regex-generated UI execute here.
export const extractRenderedAgentBodyText = (displaySource, { documentRef = document, boundaries } = {}) => {
  const source = String(displaySource || '');
  // An inert fragment cannot reproduce stylesheet visibility/cascade. Refuse
  // uncertain projections instead of sending text hidden by the card's CSS.
  const styles = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi)].map(match => match[1]).join('\n');
  if (/display\s*:\s*none|visibility\s*:\s*(hidden|collapse)|content-visibility\s*:\s*hidden|opacity\s*:\s*0(?:[;\s}]|$)|@import/i.test(styles) || /<link\b[^>]*\brel\s*=\s*["']?stylesheet\b/i.test(source)) return failure('正文包含通过样式隐藏的内容，请使用指定标签或选取原文');
  // Classify before removing script/style payloads, so cleanup cannot turn an
  // interactive document into a misleading static snapshot.
  if (buildRichTextRenderPlan(source).parts.some(part => part.type === 'code' && /^(html|htm)$/i.test(String(part.lang)) && detectRichCodeBlockRoute(part).level === RICH_RENDER_LEVELS.SANDBOX)) return failure('交互页面请使用指定标签或选取原文，定位要优化的正文');
  const excluded = collectRenderedAgentExcludedRanges(source, boundaryRanges(source, boundaries));
  const cleaned = omitRanges(source, excluded);
  const plan = buildRichTextRenderPlan(cleaned), texts = [];
  for (const part of plan.parts) {
    if (part.type === 'code') {
      if (!/^(html|htm)$/i.test(String(part.lang))) continue;
      // Static cards use the same inert HTML extraction; interactive documents need an explicit source range.
      if (detectRichCodeBlockRoute(part).level === RICH_RENDER_LEVELS.SANDBOX) return failure('交互页面请使用指定标签或选取原文，定位要优化的正文');
    }
    const chunk = String(part.type === 'code' ? part.code || '' : part.text || '').replace(/__CHATAPP_STATUS__/g, '').replace(/\[\[image:[\s\S]*?\]\]/gi, '').replace(/\[img-[^\]\n]+\]/gi, '');
    if (!/<\/?[a-zA-Z][^>]*>/.test(chunk)) { texts.push(chunk); continue; }
    const template = documentRef.createElement('template'); template.innerHTML = chunk;
    template.content.querySelectorAll('script,style,template,iframe,object,embed,img,picture,svg,canvas,video,audio,button,input,select,textarea,form,nav,table,details,summary,[hidden],[aria-hidden="true"],.message-toolbar,.status-card,.variable-status-card,.memory-table').forEach(node => node.remove());
    template.content.querySelectorAll('[style]').forEach(node => {
      if (node.style.display === 'none' || ['hidden', 'collapse'].includes(node.style.visibility) || node.style.contentVisibility === 'hidden' || (node.style.opacity && Number(node.style.opacity) === 0)) node.remove();
    });
    let text = '';
    const visit = node => {
      if (node.nodeType === 3) { text += node.nodeValue; return; }
      if (node.nodeName === 'BR') { text += '\n'; return; }
      const block = blockTags.has(node.nodeName);
      if (block && text && !text.endsWith('\n')) text += '\n';
      for (const child of node.childNodes) visit(child);
      if (block && text && !text.endsWith('\n')) text += '\n';
    };
    visit(template.content); texts.push(text);
  }
  const text = texts.join('\n').replace(/\r\n?/g, '\n').replace(/[\t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text ? { ok: true, text } : failure('当前回复没有可提取的显示正文，请选择另一条回复或指定范围');
};

export const createRenderedAgentTargetResolver = ({ getDisplaySource, getReasoningBoundaries = () => ({}), documentRef = document } = {}) =>
  async (source, rule, options = {}) => {
    if (rule?.mode !== 'rendered' || options.selection) return resolveAgentTextTargetAsync(source, rule, options);
    const boundaries = getReasoningBoundaries(options.context);
    const display = await getDisplaySource(options.message, options.context);
    if (typeof display !== 'string') return failure('当前回复尚未完成显示，请稍后重试');
    const rendered = extractRenderedAgentBodyText(display, { documentRef, boundaries });
    if (!rendered.ok) return rendered;
    if (options.readOnly) return { ok: true, mode: 'rendered', text: rendered.text, source: String(source) };
    return resolveRenderedAgentTarget(source, rendered.text, { excludedRanges: boundaryRanges(String(source), boundaries) });
  };
