import assert from 'node:assert/strict';

import { createSessionArchiveSectionRuntime } from '../../src/scripts/ui/session-archive-section-runtime-utils.js';

{
  let capturedOptions = null;
  const runtime = createSessionArchiveSectionRuntime({
    getContainer: () => ({ id: 'archives' }),
    getSessionId: () => 'contact:1',
    getChatStore: () => ({ id: 'store' }),
    isGroup: false,
    getMemoryStorageMode: () => 'summary',
    buildMemoryTableSnapshot: async () => ({ rows: [] }),
    captureArchivePointer: () => ({ pointer: true }),
    loadArchivedMessages: () => [],
    getLastArchiveTransition: () => ({ type: 'recent' }),
    persistArchivePointer: () => {},
    applyMemoryTableSnapshot: () => {},
    restoreArchivePointerForLoadedThread: () => {},
    logger: { warn() {} },
    appConfirmFn: () => true,
    runArchiveSwitchFlow: () => {},
    runArchiveDeleteFlow: () => {},
    deleteArchiveTurnCheckpointState: () => {},
    deleteArchive: () => {},
    renameArchive: () => true,
    promptArchiveRenameName: () => 'renamed',
    onArchiveLoaded: () => {},
    onArchiveDeleted: () => {},
    onArchiveRenamed: () => {},
    onHide: () => {},
    createEmptyState: () => ({ kind: 'empty' }),
    createArchiveRow: () => ({ kind: 'row' }),
    sourcePrefix: 'contact',
    restoreWarnMessage: 'restore warn',
    deleteWarnMessage: 'delete warn',
    deps: {
      renderSessionArchivesSection: (options) => {
        capturedOptions = options;
        return { kind: 'archives', options };
      },
    },
  });

  const rendered = runtime.renderArchives();
  assert.equal(rendered.kind, 'archives');
  assert.equal(capturedOptions.container.id, 'archives');
  assert.equal(capturedOptions.sessionId, 'contact:1');
  assert.equal(capturedOptions.chatStore.id, 'store');
  assert.equal(capturedOptions.isGroup, false);
  assert.equal(capturedOptions.sourcePrefix, 'contact');
  assert.equal(capturedOptions.restoreWarnMessage, 'restore warn');
  assert.equal(capturedOptions.deleteWarnMessage, 'delete warn');
  assert.equal(typeof capturedOptions.renameArchive, 'function');
  assert.equal(typeof capturedOptions.promptArchiveRenameName, 'function');
  assert.equal(typeof capturedOptions.onArchiveRenamed, 'function');
  assert.equal(capturedOptions.archiveSearchQuery, '');
  capturedOptions.onArchiveSearchQueryChange('needle');
  runtime.renderArchives();
  assert.equal(capturedOptions.archiveSearchQuery, 'needle');
  console.log('ok - createSessionArchiveSectionRuntime forwards archive section dependencies for contacts');
}

{
  let capturedOptions = null;
  const runtime = createSessionArchiveSectionRuntime({
    getContainer: () => ({ id: 'group-archives' }),
    getSessionId: () => 'group:1',
    getChatStore: () => ({ id: 'group-store' }),
    isGroup: true,
    sourcePrefix: 'group',
    deps: {
      renderSessionArchivesSection: (options) => {
        capturedOptions = options;
        return options;
      },
    },
  });

  runtime.renderArchives();
  assert.equal(capturedOptions.container.id, 'group-archives');
  assert.equal(capturedOptions.sessionId, 'group:1');
  assert.equal(capturedOptions.chatStore.id, 'group-store');
  assert.equal(capturedOptions.isGroup, true);
  assert.equal(capturedOptions.sourcePrefix, 'group');
  console.log('ok - createSessionArchiveSectionRuntime forwards archive section dependencies for groups');
}

{
  const loads = [];
  const onArchiveLoaded = () => {};
  const runtime = createSessionArchiveSectionRuntime({
    getSessionId: () => 'rp:card',
    getChatStore: () => ({ getArchives: () => [{ id: 'a1', name: '导入：雨夜' }] }),
    sourcePrefix: 'contact',
    onArchiveLoaded,
    deps: { loadSessionArchive: async options => loads.push(options) },
  });
  assert.equal(await runtime.loadArchive('a1'), true);
  assert.equal(loads.length, 1, '「立即加载」直接走存档加载流程，不再确认');
  assert.equal(loads[0].sessionId, 'rp:card');
  assert.equal(loads[0].archive.id, 'a1');
  assert.equal(loads[0].onArchiveLoaded, onArchiveLoaded);
  assert.equal(await runtime.loadArchive('missing'), false, '找不到存档时不加载');
  assert.equal(loads.length, 1);
  console.log('ok - createSessionArchiveSectionRuntime loads a given archive directly');
}
