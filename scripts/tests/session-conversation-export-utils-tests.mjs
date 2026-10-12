import assert from 'node:assert/strict';

import {
  loadConversationExportMessages,
  runSessionConversationExportFlow,
} from '../../src/scripts/ui/session-conversation-export-utils.js';

{
  const calls = [];
  const messages = await loadConversationExportMessages({
    sessionId: 's1',
    current: true,
    chatStore: {
      getCurrentArchiveId: () => 'a-current',
      exportThreadMessages: async (sid, aid) => {
        calls.push(['export', sid, aid]);
        return [];
      },
      getMessages: () => [{ id: 'visible', role: 'user', content: 'fallback' }],
      prefetchRawOriginalsForMessages: async list => calls.push(['prefetch', list.length]),
    },
  });
  assert.deepEqual(calls, [['export', 's1', 'a-current'], ['prefetch', 1]]);
  assert.equal(messages[0].content, 'fallback');
  console.log('ok - loadConversationExportMessages falls back to visible current messages');
}

{
  const calls = [];
  const ok = await runSessionConversationExportFlow({
    sessionId: 'rp:s1',
    archive: { id: 'a1', name: '旧档' },
    chatStore: {
      exportThreadMessages: async (sid, aid) => {
        calls.push(['export', sid, aid]);
        return [{ role: 'assistant', content: '正文', rawOriginal: '完整' }];
      },
      prefetchRawOriginalsForMessages: async list => calls.push(['prefetch', list.length]),
    },
    openExportDialog: async ({ subtitle, buildFilename, onExport }) => {
      calls.push(['dialog', subtitle, buildFilename('full', 'txt')]);
      // 先取消一次保存位置，留在对话框；再换选项导出成功
      const first = await onExport({ mode: 'full', format: 'txt' });
      calls.push(['first', first]);
      return { exported: await onExport({ mode: 'full', format: 'txt' }) };
    },
    exportTextFile: (() => {
      let attempt = 0;
      return async ({ text, filename, format, onSuccess }) => {
        attempt += 1;
        calls.push(['file', format, filename, /完整/.test(text), text.split('\n')[0]]);
        if (attempt === 1) return false;
        onSuccess?.('done');
        return true;
      };
    })(),
    now: () => new Date('2026-06-13T01:02:03'),
    toastSuccess: text => calls.push(['success', text]),
  });
  assert.equal(ok, true);
  assert.deepEqual(calls[0], ['export', 'rp:s1', 'a1'], '先载入消息，才能在对话框显示条数');
  assert.deepEqual(calls[1], ['prefetch', 1]);
  assert.deepEqual(calls[2], ['dialog', '旧档 · 1 条', '旧档-full-20260613010203.txt']);
  assert.equal(calls[3][0], 'file');
  assert.equal(calls[3][1], 'txt');
  assert.equal(calls[3][3], true);
  assert.equal(calls[3][4], '【OmniTavern 导出 v1 · 创意写作 · 完整】', '创意写作会话写入 rp 标记');
  assert.deepEqual(calls[4], ['first', false]);
  assert.deepEqual(calls.at(-1), ['success', 'done']);
  console.log('ok - runSessionConversationExportFlow loads messages, shows the dialog and exports with markers');
}

{
  let dialogOpened = false;
  const warnings = [];
  const ok = await runSessionConversationExportFlow({
    sessionId: 'contact:1',
    current: true,
    chatStore: { exportThreadMessages: async () => [], getMessages: () => [] },
    openExportDialog: async () => { dialogOpened = true; return { exported: true }; },
    toastWarning: text => warnings.push(text),
  });
  assert.equal(ok, false);
  assert.equal(dialogOpened, false, '没有消息时不打开对话框');
  assert.deepEqual(warnings, ['没有可导出的聊天记录']);
  console.log('ok - runSessionConversationExportFlow warns instead of opening the dialog for an empty thread');
}
