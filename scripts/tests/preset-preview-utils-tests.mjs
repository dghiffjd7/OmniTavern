import assert from 'node:assert/strict';

import {
  applyPresetBlockHunk,
  buildPresetPreviewBlockMap,
  createLatestPreviewBuildQueue,
  isSamePresetData,
  presetBlockContentChanged,
} from '../../src/scripts/ui/preset-preview-utils.js';

{
  const content = '  repeated block\n';
  const text = `${content}separator\n${content}`;
  const map = buildPresetPreviewBlockMap({
    messageTexts: [text],
    blocks: [
      { id: 'first', content },
      { id: 'second', content },
    ],
  });

  assert.equal(map.size, 2, '相同正文的两个区块都应映射');
  assert.equal(map.get('first').start, 0);
  assert.equal(map.get('second').start, content.length + 'separator\n'.length);
  assert.equal(map.get('first').len, content.length, '映射范围必须包含边界空白');
  assert.equal(text.slice(map.get('first').start, map.get('first').start + map.get('first').len), content);
  console.log('ok - 重复正文与边界空白映射完整');
}

{
  assert.equal(presetBlockContentChanged('a\r\nb', 'a\nb'), false, '仅换行格式不同不应显示空 diff');
  assert.equal(presetBlockContentChanged('a\nb', 'a\nB'), true);
  console.log('ok - 区块正文比较统一 CRLF/LF');
}

{
  const base = 'one\ntwo\nthree\nfour';
  const draft = 'ONE\ntwo\nthree\nFOUR';
  assert.equal(applyPresetBlockHunk(base, draft, 0, 'accept'), 'ONE\ntwo\nthree\nfour');
  assert.equal(applyPresetBlockHunk(base, draft, 0, 'reject'), 'one\ntwo\nthree\nFOUR');
  console.log('ok - hunk 接受与回滚只影响目标变更');
}

{
  let resolveFirst;
  const calls = [];
  const committed = [];
  const queue = createLatestPreviewBuildQueue({
    build: async ({ marker }) => {
      calls.push(marker);
      if (marker === 'old') await new Promise(resolve => { resolveFirst = resolve; });
      return { marker };
    },
    onResult: result => committed.push(result.marker),
  });

  const running = queue.request({ marker: 'old' });
  await Promise.resolve();
  queue.request({ marker: 'new' });
  resolveFirst();
  await running;

  assert.deepEqual(calls, ['old', 'new'], '进行中的构建结束后应补跑最新请求');
  assert.deepEqual(committed, ['new'], '过期构建不得覆盖最新预览');
  console.log('ok - 预览异步重建保持 latest-wins');
}

{
  const calls = [];
  let queue;
  queue = createLatestPreviewBuildQueue({
    build: async ({ marker }) => {
      calls.push(marker);
      return { marker };
    },
    onResult: result => {
      if (result.marker === 'first') {
        queueMicrotask(() => queue.request({ marker: 'late' }));
      }
    },
  });

  await queue.request({ marker: 'first' });
  assert.deepEqual(calls, ['first', 'late'], '完成回调微任务排入的请求也必须在同一轮 drain 中执行');
  console.log('ok - 预览队列不会遗留完成窗口中的微任务请求');
}

{
  const calls = [];
  let queue;
  queue = createLatestPreviewBuildQueue({
    build: async ({ marker }) => {
      calls.push(marker);
      return { marker };
    },
    onResult: result => {
      if (result.marker === 'first') {
        queueMicrotask(() => queueMicrotask(() => queue.request({ marker: 'nested-late' })));
      }
    },
  });

  await queue.request({ marker: 'first' });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['first', 'nested-late'], '任意微任务深度的尾端请求都必须触发新一轮 drain');
  console.log('ok - 预览队列完成窗口具备最终重启保障');
}

{
  // 分片落盘后区块顺序条目的键按字母排序（enabled 在前），表单收集为 identifier 在前：
  // 放弃修改后重绘再收集，不应被当成未保存更改
  const saved = { name: 'Izumi', prompt_order: [{ character_id: 100001, order: [{ enabled: false, identifier: 'a' }, { enabled: true, identifier: 'b' }] }] };
  const collected = { prompt_order: [{ order: [{ identifier: 'a', enabled: false }, { identifier: 'b', enabled: true }], character_id: 100001 }], name: 'Izumi' };
  assert.equal(isSamePresetData(collected, saved), true, '键顺序不同不算修改');
  const toggled = { ...collected, prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: true }] }] };
  assert.equal(isSamePresetData(toggled, saved), false, '开关变化仍算修改');
  const reordered = { ...collected, prompt_order: [{ character_id: 100001, order: [{ identifier: 'b', enabled: true }, { identifier: 'a', enabled: false }] }] };
  assert.equal(isSamePresetData(reordered, saved), false, '区块顺序变化仍算修改');
  assert.equal(isSamePresetData({ a: 1, b: undefined }, { a: 1 }), true, 'undefined 字段与缺省一致（与 JSON 落盘一致）');
  console.log('ok - 预设草稿比对忽略键顺序、保留数组顺序');
}
