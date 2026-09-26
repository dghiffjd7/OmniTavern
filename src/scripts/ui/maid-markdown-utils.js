const INLINE_MARKDOWN_RE = /(`[^`]+`|\[[^\]]+\]\(([^)]+)\)|\*\*[\s\S]+?\*\*|__[\s\S]+?__|~~[\s\S]+?~~|\*[^*\n]+\*|_[^_\n]+_)/g;

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const sanitizeUrl = value => {
  const url = String(value || '').trim();
  return /^(https?:|mailto:|tel:)/i.test(url) ? url : '';
};

const renderInlineMarkdown = (text) => {
  const source = String(text ?? '');
  if (!source) return '';
  const matcher = new RegExp(INLINE_MARKDOWN_RE.source, 'g');
  let output = '';
  let lastIndex = 0;
  let match = null;
  while ((match = matcher.exec(source))) {
    if (match.index > lastIndex) output += escapeHtml(source.slice(lastIndex, match.index));
    const token = String(match[0] || '');
    if (token.startsWith('`') && token.endsWith('`')) {
      output += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    } else if (token.startsWith('[') && token.includes('](') && token.endsWith(')')) {
      const link = token.match(/^\[([\s\S]+)\]\(([^)]+)\)$/);
      const href = sanitizeUrl(link?.[2]);
      const label = renderInlineMarkdown(link?.[1] || '');
      output += href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label;
    } else if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      output += `<strong>${renderInlineMarkdown(token.slice(2, -2))}</strong>`;
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      output += `<s>${renderInlineMarkdown(token.slice(2, -2))}</s>`;
    } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
      output += `<em>${renderInlineMarkdown(token.slice(1, -1))}</em>`;
    } else {
      output += escapeHtml(token);
    }
    lastIndex = matcher.lastIndex;
  }
  if (lastIndex < source.length) output += escapeHtml(source.slice(lastIndex));
  return output;
};

// Nested quotes recurse once per level; deeper markers are shown as plain text so authored
// or imported skills cannot overflow the stack.
const MAX_QUOTE_DEPTH = 8;

export const renderMaidMarkdownHtml = (text, depth = 0) => {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  const isBlank = line => !String(line || '').trim();
  const isHeading = line => /^\s{0,3}#{1,6}\s+\S/.test(line);
  const isQuote = line => /^\s*>+\s*/.test(line);
  const isUnordered = line => /^\s*[-*+]\s+\S/.test(line);
  const isOrdered = line => /^\s*\d+\.\s+\S/.test(line);
  const isDivider = line => /^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line);
  const renderLines = parts => parts.map(renderInlineMarkdown).join('<br>');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) {
      index += 1;
      continue;
    }
    if (isDivider(line)) {
      output.push('<hr>');
      index += 1;
      continue;
    }
    if (isHeading(line)) {
      const heading = line.match(/^\s{0,3}(#{1,6})\s+([\s\S]+)$/);
      const level = Math.max(1, Math.min(6, String(heading?.[1] || '').length || 1));
      output.push(`<h${level}>${renderInlineMarkdown(heading?.[2] || '')}</h${level}>`);
      index += 1;
      continue;
    }
    if (isQuote(line)) {
      const quoteLines = [];
      while (index < lines.length && (isQuote(lines[index]) || isBlank(lines[index]))) {
        quoteLines.push(isBlank(lines[index]) ? '' : lines[index].replace(/^\s*>+\s?/, ''));
        index += 1;
      }
      const inner = depth + 1 >= MAX_QUOTE_DEPTH ? quoteLines.map(item => item.replace(/^(?:\s*>)+\s?/, '')) : quoteLines;
      output.push(`<blockquote>${renderMaidMarkdownHtml(inner.join('\n'), depth + 1)}</blockquote>`);
      continue;
    }
    if (isUnordered(line) || isOrdered(line)) {
      const ordered = isOrdered(line);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (index < lines.length) {
        const item = ordered
          ? lines[index].match(/^\s*\d+\.\s+([\s\S]+)$/)
          : lines[index].match(/^\s*[-*+]\s+([\s\S]+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      output.push(`<${tag}>${items.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const paragraph = [];
    while (
      index < lines.length &&
      !isBlank(lines[index]) &&
      !isDivider(lines[index]) &&
      !isHeading(lines[index]) &&
      !isQuote(lines[index]) &&
      !isUnordered(lines[index]) &&
      !isOrdered(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length) output.push(`<p>${renderLines(paragraph)}</p>`);
  }
  return output.join('');
};
