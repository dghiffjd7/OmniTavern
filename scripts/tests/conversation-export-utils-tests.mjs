import assert from 'node:assert/strict';

import {
  buildConversationExportFilename,
  exportConversationTextFile,
  formatConversationExport,
  getConversationMessageText,
  getConversationReasoningText,
  resolveConversationExportMessage,
} from '../../src/scripts/ui/chat/conversation-export-utils.js';

{
  const message = {
    role: 'assistant',
    content: 'display text',
    rawOriginal: '<think>raw thought</think>\nraw body',
    meta: { reasoningDisplay: 'visible thought' },
  };
  assert.equal(getConversationMessageText(message, { mode: 'body' }), 'display text');
  assert.equal(getConversationMessageText(message, { mode: 'full' }), '<think>raw thought</think>\nraw body');
  assert.equal(getConversationReasoningText(message), 'visible thought');
  console.log('ok - conversation export picks display body and full raw assistant text');
}

{
  const message = {
    role: 'assistant',
    content: 'first',
    rawOriginal: 'first raw original',
    meta: {
      reasoningDisplay: 'first reasoning',
      activeSwipe: 1,
      swipes: [
        { content: 'first', raw: 'first raw', reasoningDisplay: 'first branch reasoning' },
        { content: 'second', raw: 'second raw' },
      ],
    },
  };
  const resolved = resolveConversationExportMessage(message);
  assert.equal(resolved.content, 'second');
  assert.equal(resolved.raw, 'second raw');
  assert.equal(resolved.rawOriginal, undefined);
  assert.equal(getConversationReasoningText(resolved), '');
  console.log('ok - conversation export does not leak first swipe reasoning into later swipes');
}

{
  const text = formatConversationExport({
    title: '测试聊天',
    sourceLabel: '当前聊天',
    mode: 'full',
    format: 'md',
    exportedAt: new Date('2026-06-13T12:00:00Z'),
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '显示', rawOriginal: '原文', meta: { reasoningDisplay: '推理' } },
    ],
  });
  assert.match(text, /^<!-- omnitavern-export v1 mode=chat content=full count=2 -->\n# 测试聊天/);
  assert.match(text, /导出模式：完整/);
  assert.match(text, /\*\*请求推理\*\*/);
  assert.match(text, /原文/);
  console.log('ok - formatConversationExport builds readable markdown with reasoning section');
}

{
  // 导出标记 v1：md 用不可见注释标出文件头、每条消息与思考段；名字含特殊字符时编码
  const messages = [
    { role: 'user', name: '阿兰 · A', content: '## 3. 这不是标题', timestamp: 1791400000000 },
    { role: 'assistant', name: '苏晓彤', content: '显示', rawOriginal: '原文', meta: { reasoningDisplay: '想一想' }, timestamp: 1791400060000 },
  ];
  const md = formatConversationExport({ messages, title: 'T', mode: 'full', format: 'md', sessionMode: 'rp', exportedAt: new Date(0) });
  assert.match(md, /^<!-- omnitavern-export v1 mode=rp content=full count=2 -->/);
  assert.match(md, /<!-- omnitavern-message index=1 role=user name=%E9%98%BF%E5%85%B0%20%C2%B7%20A ts=1791400000000 -->\n## 1\. /);
  assert.match(md, /<!-- omnitavern-message index=2 role=assistant name=%E8%8B%8F%E6%99%93%E5%BD%A4 ts=1791400060000 -->/);
  assert.match(md, /<!-- omnitavern-reasoning -->\n\*\*请求推理\*\*\n\n想一想\n<!-- \/omnitavern-reasoning -->\n\n原文/);
  const body = formatConversationExport({ messages, title: 'T', mode: 'body', format: 'md', sessionMode: 'chat', exportedAt: new Date(0) });
  assert.match(body, /^<!-- omnitavern-export v1 mode=chat content=body count=2 -->/);
  assert.doesNotMatch(body, /omnitavern-reasoning/);

  const txt = formatConversationExport({ messages, title: 'T', mode: 'full', format: 'txt', sessionMode: 'rp', exportedAt: new Date(0) });
  const lines = txt.split('\n');
  assert.equal(lines[0], '【OmniTavern 导出 v1 · 创意写作 · 完整】');
  assert.ok(lines.some(line => /^\[1\] 阿兰 · A（我） · /.test(line)));
  assert.ok(lines.some(line => /^\[2\] 苏晓彤（AI） · /.test(line)));
  assert.match(txt, /【请求推理】\n想一想\n\n【正文】\n原文/);
  const txtBody = formatConversationExport({ messages, title: 'T', mode: 'body', format: 'txt', sessionMode: 'chat', exportedAt: new Date(0) });
  assert.equal(txtBody.split('\n')[0], '【OmniTavern 导出 v1 · 聊天 · 正文】');
  assert.doesNotMatch(txtBody, /【正文】/);
  console.log('ok - exports carry v1 import markers for messages, roles and reasoning');
}

{
  const filename = buildConversationExportFilename({
    title: '角色/聊天室:*?',
    mode: 'body',
    format: 'txt',
    now: new Date('2026-06-13T01:02:03'),
  });
  assert.match(filename, /^角色_聊天室_-body-\d{14}\.txt$/);
  console.log('ok - buildConversationExportFilename sanitizes names and appends format extension');
}

{
  const calls = [];
  const body = {
    children: [],
    appendChild(node) {
      this.children.push(node);
      return node;
    },
  };
  const link = {
    style: {},
    click() {
      calls.push(['click', this.download]);
    },
    remove() {
      calls.push(['remove']);
    },
  };
  const saved = await exportConversationTextFile({
    text: 'hello',
    filename: 'chat.md',
    format: 'md',
    globalRef: {},
    documentRef: {
      body,
      createElement: () => link,
    },
    BlobRef: class BlobMock {
      constructor(parts, options) {
        calls.push(['blob', parts, options]);
      }
    },
    URLRef: {
      createObjectURL: () => 'blob://1',
      revokeObjectURL: url => calls.push(['revoke', url]),
    },
    onSuccess: text => calls.push(['success', text]),
  });
  assert.equal(saved, true);
  assert.deepEqual(calls[0], ['blob', ['hello'], { type: 'text/markdown;charset=utf-8' }]);
  assert.deepEqual(calls[1], ['click', 'chat.md']);
  assert.equal(calls.at(-1)[0], 'success');
  console.log('ok - exportConversationTextFile downloads markdown in browser mode');
}
