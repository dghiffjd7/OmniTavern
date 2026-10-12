import assert from 'node:assert/strict';

import { renderSessionArchivesSection } from '../../src/scripts/ui/session-archive-view-utils.js';

const createContainer = () => ({
  innerHTML: '',
  children: [],
  appendChild(child) {
    this.children.push(child);
    return child;
  },
});

const createFakeDocument = () => ({
  createElement(tagName) {
    return {
      tagName,
      children: [],
      style: {},
      attributes: {},
      textContent: '',
      value: '',
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      focus() {
        this.focused = true;
      },
    };
  },
});

{
  const container = createContainer();
  const empty = { kind: 'empty' };
  const ok = renderSessionArchivesSection({
    container,
    sessionId: 's1',
    chatStore: {
      state: { sessions: {} },
      getArchives() {
        return [];
      },
    },
    createEmptyState: () => empty,
  });
  assert.equal(ok, true);
  assert.deepEqual(container.children, [empty]);
  console.log('ok - renderSessionArchivesSection renders empty archive state when session has no archives');
}

{
  const container = createContainer();
  const rows = [];
  renderSessionArchivesSection({
    container,
    sessionId: 's1',
    chatStore: {
      state: { sessions: { s1: { currentArchiveId: 'a2' } } },
      getArchives() {
        return [
          { id: 'a1', name: '旧档', timestamp: 1700000000000, messageCount: 3 },
          { id: 'a2', name: '当前档', timestamp: 1700001000000, messageCount: 5 },
        ];
      },
    },
    createArchiveRow: (payload) => {
      rows.push(payload);
      return { row: { payload } };
    },
  });
  assert.equal(container.children.length, 2);
  assert.equal(rows[0].archiveName, '旧档');
  assert.equal(rows[0].isCurrent, false);
  assert.equal(rows[1].isCurrent, true);
  assert.equal(String(rows[0].dateText).length > 0, true);
  assert.equal(rows[0].messageCount, 3);
  console.log('ok - renderSessionArchivesSection maps archive metadata into shared row builders');
}

{
  const container = createContainer();
  let loaded = 0;
  let hidden = 0;
  let deleted = 0;
  let renamed = 0;
  let confirmed = 0;
  const confirmPayloads = [];
  let switchPayload = null;
  let deletePayload = null;
  let renamePayload = null;
  const rowDefs = [];
  renderSessionArchivesSection({
    container,
    sessionId: 's1',
    isGroup: true,
    chatStore: {
      state: { sessions: { s1: { currentArchiveId: '' } } },
      getArchives() {
        return [{ id: 'a1', name: '旧档', timestamp: 1700000000000, messageCount: 3 }];
      },
    },
    appConfirmFn: async (payload) => {
      confirmed += 1;
      confirmPayloads.push(payload);
      return true;
    },
    runArchiveSwitchFlow: async (payload) => {
      switchPayload = payload;
    },
    runArchiveDeleteFlow: async (payload) => {
      deletePayload = payload;
    },
    promptArchiveRenameName: () => '新档',
    renameArchive: async (archiveId, name, sessionId) => {
      renamePayload = { archiveId, name, sessionId };
      return true;
    },
    onArchiveLoaded: () => {
      loaded += 1;
    },
    onHide: () => {
      hidden += 1;
    },
    onArchiveDeleted: () => {
      deleted += 1;
    },
    onArchiveRenamed: () => {
      renamed += 1;
    },
    createArchiveRow: (payload) => {
      rowDefs.push(payload);
      return { row: { payload } };
    },
  });
  await rowDefs[0].onSelect();
  await rowDefs[0].onRename({ stopPropagation() {}, preventDefault() {} });
  await rowDefs[0].onDelete({ stopPropagation() {} });
  assert.equal(confirmed, 2);
  assert.match(confirmPayloads[0].message, /正文会随存档切换/);
  assert.match(confirmPayloads[0].message, /记忆表与变量（如启用记忆表）也会一起切换/);
  assert.equal(loaded, 1);
  assert.equal(hidden, 1);
  assert.equal(renamed, 1);
  assert.equal(switchPayload?.isGroup, true);
  assert.equal(switchPayload?.sessionId, 's1');
  assert.equal(switchPayload?.archive?.id, 'a1');
  assert.deepEqual(renamePayload, { archiveId: 'a1', name: '新档', sessionId: 's1' });
  assert.equal(deletePayload?.archiveId, 'a1');
  assert.equal(typeof deletePayload?.renderArchives, 'function');
  deletePayload.renderArchives();
  assert.equal(deleted, 1);
  console.log('ok - renderSessionArchivesSection wires archive load and delete flows through shared runtime');
}

{
  const documentRef = createFakeDocument();
  const container = createContainer();
  container.ownerDocument = documentRef;
  let searchQuery = 'beta';
  const rows = [];
  renderSessionArchivesSection({
    container,
    sessionId: 's1',
    archiveSearchQuery: searchQuery,
    onArchiveSearchQueryChange: (query) => {
      searchQuery = query;
    },
    chatStore: {
      state: { sessions: { s1: { currentArchiveId: '' } } },
      getArchives() {
        return [
          { id: 'a-alpha', name: 'Alpha Archive', timestamp: 1700000000000, messageCount: 3 },
          { id: 'a-beta', name: 'Beta Archive', timestamp: 1700001000000, messageCount: 5 },
        ];
      },
    },
    createArchiveRow: (payload) => {
      const row = documentRef.createElement('div');
      rows.push({ payload, row });
      return { row };
    },
  });

  const toolbar = container.children[0];
  const input = toolbar.children[0];
  const count = toolbar.children[1];
  assert.equal(count.textContent, '1 / 2');
  assert.equal(rows[0].row.style.display, 'none');
  assert.equal(rows[1].row.style.display, '');

  input.value = 'alpha';
  input.oninput();
  assert.equal(searchQuery, 'alpha');
  assert.equal(count.textContent, '1 / 2');
  assert.equal(rows[0].row.style.display, '');
  assert.equal(rows[1].row.style.display, 'none');
  console.log('ok - renderSessionArchivesSection filters archives by search query');
}

{
  const container = createContainer();
  const rows = [];
  let exportedCurrent = 0;
  renderSessionArchivesSection({
    container,
    sessionId: 's1',
    includeCurrentThread: true,
    onExportCurrent: async () => {
      exportedCurrent += 1;
    },
    chatStore: {
      state: { sessions: { s1: { currentArchiveId: '' } } },
      getMessages() {
        return [{ id: 'm1' }, { id: 'm2' }];
      },
      getArchives() {
        return [];
      },
    },
    createArchiveRow: (payload) => {
      rows.push(payload);
      return { row: { payload } };
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].archiveName, '当前聊天');
  assert.equal(rows[0].messageCount, 2);
  assert.equal(rows[0].canRename, false);
  assert.equal(rows[0].canDelete, false);
  await rows[0].onExport({ stopPropagation() {}, preventDefault() {} });
  assert.equal(exportedCurrent, 1);
  console.log('ok - renderSessionArchivesSection can render export-only current chat row without archives');
}
