import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 记忆时间线要读「当前存档」的完整消息：不传存档 id 时读到的是默认线程，
// 在已切到存档的会话里会是空的或别的存档，退回只用已加载的消息，长存档的轮次因此偏小。
const read = path => readFileSync(new URL(`../../src/scripts/${path}`, import.meta.url), 'utf8');

{
  const app = read('ui/app.js');
  assert.doesNotMatch(app, /exportThreadMessages\(sid\)/);
  const timeline = app.slice(app.indexOf('const loadMemoryTimelineMessagesForSession'), app.indexOf('const countMemoryTimelineTurns'));
  assert.match(timeline, /exportThreadMessages\(sid, chatStore\.getCurrentArchiveId\?\.\(sid\)\)/);
  console.log('ok - memory timeline reads the current archive thread');
}

{
  const editor = read('ui/memory-table-editor.js');
  assert.match(editor, /exportThreadMessages\(sessionId, this\.chatStore\.getCurrentArchiveId\?\.\(sessionId\)\)/);
  console.log('ok - memory table timeline repair reads the current archive thread');
}
