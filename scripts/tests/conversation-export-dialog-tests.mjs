import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CONVERSATION_EXPORT_PREFS_KEY,
  readConversationExportPrefs,
  writeConversationExportPrefs,
} from '../../src/scripts/ui/conversation-export-dialog.js';

{
  const data = new Map();
  const storage = { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
  assert.deepEqual(readConversationExportPrefs(storage), { mode: 'full', format: 'md' }, '默认完整 + Markdown');
  assert.equal(writeConversationExportPrefs(storage, { mode: 'body', format: 'txt' }), true);
  assert.deepEqual(readConversationExportPrefs(storage), { mode: 'body', format: 'txt' });
  data.set(CONVERSATION_EXPORT_PREFS_KEY, '{"mode":"weird","format":"pdf"}');
  assert.deepEqual(readConversationExportPrefs(storage), { mode: 'full', format: 'md' }, '不认识的值退回默认');
  data.set(CONVERSATION_EXPORT_PREFS_KEY, 'not json');
  assert.deepEqual(readConversationExportPrefs(storage), { mode: 'full', format: 'md' });
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readConversationExportPrefs(blocked), { mode: 'full', format: 'md' });
  assert.equal(writeConversationExportPrefs(blocked, { mode: 'body', format: 'txt' }), false);
  console.log('ok - export dialog remembers the last content/format choice and survives bad storage');
}

{
  const css = await readFile(new URL('../../src/assets/css/conversation-transfer-dialog.css', import.meta.url), 'utf8');
  const html = await readFile(new URL('../../src/index.html', import.meta.url), 'utf8');
  const dialog = await readFile(new URL('../../src/scripts/ui/conversation-export-dialog.js', import.meta.url), 'utf8');
  assert.match(html, /href="\.\/assets\/css\/conversation-transfer-dialog\.css"/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, '只用主题变量');
  assert.match(css, /body\[data-reduced-motion='on'\]/);
  assert.match(css, /@keyframes ctd-sheet-out \{\s*to \{/, '底部面板收起从当前位置接着滑');
  assert.match(dialog, /schedule\(close, isReducedMotion\(\) \? 0 : DONE_HOLD_MS\)/, '导出成功后先显示「已导出」再关闭');
  for (const panel of ['contact-settings-panel.js', 'group-chat-panels.js']) {
    const source = await readFile(new URL(`../../src/scripts/ui/${panel}`, import.meta.url), 'utf8');
    assert.match(source, /openExportDialog: options => openConversationExportDialog\(/, `${panel} 改用导出对话框`);
    assert.doesNotMatch(source, /appChoiceFn/);
  }
  console.log('ok - export dialog styles use theme tokens and both settings panels use it');
}
