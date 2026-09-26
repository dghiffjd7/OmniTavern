import assert from 'node:assert/strict';

import { renderMaidMarkdownHtml } from '../../src/scripts/ui/maid-markdown-utils.js';

{
  const html = renderMaidMarkdownHtml('<script>alert(1)</script> 与 <img src=x onerror=alert(1)>');
  assert.equal(html.includes('<script'), false, 'script 标签必须被转义');
  assert.equal(html.includes('<img'), false, 'img 标签必须被转义');
  assert.ok(html.includes('&lt;script&gt;'), '转义后的实体应保留原文可读');
  console.log('ok - maid markdown escapes raw HTML in model output');
}

{
  const html = renderMaidMarkdownHtml('[点我](javascript:alert(1)) 和 [官网](https://example.com)');
  assert.equal(html.includes('javascript:'), false, 'javascript: 链接必须被拒绝');
  assert.ok(html.includes('href="https://example.com"'), 'https 链接应保留');
  assert.ok(html.includes('rel="noopener noreferrer"'), '外链必须带 noopener');
  console.log('ok - maid markdown sanitizes link protocols');
}

{
  const html = renderMaidMarkdownHtml('[label](https://e.com/?a="><script>alert(1)</script>)');
  assert.equal(html.includes('<script'), false, 'href 属性内注入必须被转义');
  console.log('ok - maid markdown escapes attribute injection inside href');
}

{
  const html = renderMaidMarkdownHtml('**加粗 `code` 与 *斜体*** 以及 ~~删除~~');
  assert.ok(html.includes('<strong>'), '加粗应渲染');
  assert.ok(html.includes('<code>code</code>'), '行内代码应渲染');
  assert.ok(html.includes('<s>删除</s>'), '删除线应渲染');
  console.log('ok - maid markdown renders nested inline tokens');
}

{
  const html = renderMaidMarkdownHtml([
    '# 标题',
    '',
    '- 项目一',
    '- 项目二',
    '',
    '1. 第一',
    '2. 第二',
    '',
    '> 引用行',
    '',
    '---',
    '普通段落',
  ].join('\n'));
  assert.ok(html.includes('<h1>标题</h1>'));
  assert.ok(html.includes('<ul><li>项目一</li><li>项目二</li></ul>'));
  assert.ok(html.includes('<ol><li>第一</li><li>第二</li></ol>'));
  assert.ok(html.includes('<blockquote>'));
  assert.ok(html.includes('<hr>'));
  assert.ok(html.includes('<p>普通段落</p>'));
  console.log('ok - maid markdown renders block structures');
}

{
  const html = renderMaidMarkdownHtml('`<b>not bold</b>` 里的 HTML 不得生效');
  assert.equal(html.includes('<b>'), false, '行内代码中的 HTML 必须转义');
  assert.ok(html.includes('&lt;b&gt;'), '代码内容按字面显示');
  console.log('ok - maid markdown escapes HTML inside inline code');
}

{
  const deep = `${'**'.repeat(200)}core${'**'.repeat(200)}`;
  const html = renderMaidMarkdownHtml(deep);
  assert.equal(typeof html, 'string', '深度嵌套不得抛栈溢出');
  assert.ok(html.includes('core'));
  const plain = renderMaidMarkdownHtml('没有任何格式的普通句子。');
  assert.equal(plain, '<p>没有任何格式的普通句子。</p>', '纯文本只包一层段落');
  console.log('ok - maid markdown survives pathological nesting and passes plain text through');
}

{
  // A 16000-character skill body of "> > > …" used to recurse once per level and overflow the stack.
  const html = renderMaidMarkdownHtml(`${'> '.repeat(8000)}最深处`);
  assert.equal((html.match(/<blockquote>/g) || []).length, 8, '引用最多嵌套 8 层');
  assert.ok(html.includes('最深处'));
  assert.ok(renderMaidMarkdownHtml('> 一层\n> > 两层').includes('<blockquote><p>一层</p><blockquote><p>两层</p></blockquote></blockquote>'));
  console.log('ok - maid markdown caps blockquote depth');
}
