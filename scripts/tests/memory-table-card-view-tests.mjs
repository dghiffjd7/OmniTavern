import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { bindSheetDragToDismiss } from '../../src/scripts/ui/bottom-sheet-drag-utils.js';
import {
  buildMemoryRowCardModel,
  MEMORY_TABLE_CARD_QUERY,
  resolveActiveMemoryTableId,
} from '../../src/scripts/ui/memory-table-card-view.js';

{
  const views = [
    { id: 'name', label: '姓名', kind: 'text', value: '蓉恩', tags: [] },
    { id: 'identity', label: '身份', kind: 'long', value: '一年级新生', tags: [] },
    { id: 'note', label: '备注', kind: 'text', value: '', tags: [] },
    { id: 'keywords', label: '关键词', kind: 'tag', value: '阿兰,测试', tags: ['阿兰', '测试'] },
  ];
  const model = buildMemoryRowCardModel({ id: 'r1', is_active: false, is_pinned: true, priority: 2 }, views);
  assert.equal(model.title, '蓉恩', '第一栏作卡片标题');
  assert.deepEqual(model.fields.map(field => field.id), ['identity', 'keywords'], '标题栏与空栏位不重复列出');
  assert.deepEqual(model.fields[1].tags, ['阿兰', '测试']);
  assert.equal(model.inactive, true);
  assert.equal(model.pinned, true);
  assert.equal(model.priority, 2);
  assert.equal(buildMemoryRowCardModel({ id: 'r2', is_active: true }, [{ id: 'a', value: '' }, { id: 'b', value: 'x' }]).title, '—');
  assert.equal(buildMemoryRowCardModel({ id: 'r3' }, []).fields.length, 0);
  console.log('ok - memory row cards use the first column as title and list only filled fields');
}

{
  const tables = [{ id: 'profile' }, { id: 'people' }, { id: 'summary' }];
  const counts = { profile: 0, people: 3, summary: 7 };
  const count = table => counts[table.id];
  assert.equal(resolveActiveMemoryTableId(tables, 'summary', count), 'summary', '沿用上次选择');
  assert.equal(resolveActiveMemoryTableId(tables, '', count), 'people', '没有选择时打开第一张有内容的表');
  assert.equal(resolveActiveMemoryTableId(tables, 'gone', count), 'people');
  assert.equal(resolveActiveMemoryTableId(tables, '', () => 0), 'profile', '全空时退回第一张');
  assert.equal(resolveActiveMemoryTableId([], '', count), '');
  console.log('ok - card view opens the remembered table or the first table with rows');
}

const createTarget = () => {
  const listeners = {};
  return {
    listeners,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter(item => item !== fn); },
    dispatch(type, event) { (listeners[type] || []).slice().forEach(fn => fn(event)); },
  };
};

{
  const documentRef = createTarget();
  const handle = { ...createTarget(), ownerDocument: documentRef };
  const classes = new Set();
  const panel = {
    style: { transform: '' },
    classList: { add: c => classes.add(c), remove: c => classes.delete(c) },
    getBoundingClientRect: () => ({ height: 500 }),
  };
  let clock = 0;
  let dismissed = 0;
  let enabled = true;
  bindSheetDragToDismiss({ handleEl: handle, panelEl: panel, isEnabled: () => enabled, onDismiss: () => { dismissed += 1; }, now: () => clock });

  // 拖过 30% 高度：关闭，并保留位移让收起动画从手指放开处接着滑
  handle.dispatch('pointerdown', { clientY: 100, button: 0 });
  assert.ok(classes.has('is-dragging'));
  clock = 400;
  documentRef.dispatch('pointermove', { clientY: 280 });
  assert.equal(panel.style.transform, 'translate3d(0, 180px, 0)');
  documentRef.dispatch('pointerup', {});
  assert.equal(dismissed, 1);
  assert.equal(panel.style.transform, 'translate3d(0, 180px, 0)');
  assert.ok(!classes.has('is-dragging'));

  // 小幅慢拖：弹回，不关闭
  panel.style.transform = '';
  handle.dispatch('pointerdown', { clientY: 100, button: 0 });
  clock = 1400;
  documentRef.dispatch('pointermove', { clientY: 140 });
  documentRef.dispatch('pointerup', {});
  assert.equal(dismissed, 1);
  assert.equal(panel.style.transform, '');

  // 快速下滑：距离不到 30% 也关闭
  handle.dispatch('pointerdown', { clientY: 100, button: 0 });
  clock = 1450;
  documentRef.dispatch('pointermove', { clientY: 160 });
  documentRef.dispatch('pointerup', {});
  assert.equal(dismissed, 2);

  // 往上拖不会出现负位移；电脑宽度（未启用）完全不响应
  panel.style.transform = '';
  handle.dispatch('pointerdown', { clientY: 300, button: 0 });
  documentRef.dispatch('pointermove', { clientY: 100 });
  assert.equal(panel.style.transform, 'translate3d(0, 0px, 0)');
  documentRef.dispatch('pointerup', {});
  enabled = false;
  panel.style.transform = '';
  handle.dispatch('pointerdown', { clientY: 100, button: 0 });
  documentRef.dispatch('pointermove', { clientY: 400 });
  documentRef.dispatch('pointerup', {});
  assert.equal(panel.style.transform, '');
  assert.equal(dismissed, 2);
  console.log('ok - bottom sheet drag dismisses past 30% or on a fast flick and springs back otherwise');
}

{
  const editor = await readFile(new URL('../../src/scripts/ui/memory-table-editor.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../../src/assets/css/memory-table-redesign.css', import.meta.url), 'utf8');
  assert.equal(MEMORY_TABLE_CARD_QUERY, '(max-width: 640px)');
  assert.match(editor, /if \(cardLayout\) \{\s*this\.listWrap\.appendChild\(this\.renderCardLayout\(tables, ctx/);
  assert.match(editor, /data-role="delete" class="memory-editor-button is-danger" hidden/);
  assert.match(editor, /this\.cardQuery\?\.removeEventListener\?\.\('change', this\.onLayoutChange\)/);
  assert.match(css, /@keyframes memory-sheet-out \{\s*to \{/, '收起关键帧不能有起点，才会从拖动位置接着滑');
  assert.match(css, /\.memory-editor-panel\.is-dragging \{\s*animation: none;\s*transition: none;/);
  assert.doesNotMatch(css.slice(css.indexOf('手机版卡片视图')), /#[0-9a-fA-F]{3,8}\b/, '卡片视图只用主题变量');
  console.log('ok - editor switches to the card layout on phones and keeps the sheet motion contract');
}
