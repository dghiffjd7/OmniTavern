import assert from 'node:assert/strict';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

class MemoryLocalStorageMock {
  constructor() {
    this.map = new Map();
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(String(key), String(value));
  }

  removeItem(key) {
    this.map.delete(String(key));
  }
}

const withSessionPanelWindow = async (fn) => {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const originalSetTimeout = globalThis.setTimeout;
  if (previousLocalStorage === undefined) {
    globalThis.localStorage = new MemoryLocalStorageMock();
  }
  globalThis.setTimeout = () => 0;
  globalThis.window = {
    appBridge: {
      presets: {
        listSummaries: () => [],
      },
      config: {
        getProfiles: () => [],
        getProfileById: () => null,
      },
    },
  };

  try {
    const { SessionConfigPanel } = await import('../../src/scripts/ui/session-config-panel.js');
    globalThis.setTimeout = originalSetTimeout;
    await fn(SessionConfigPanel);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
    if (previousLocalStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = previousLocalStorage;
    }
  }
};

test('SessionConfigPanel getSessionEntries classifies chat, group, and rp sessions', async () => {
  await withSessionPanelWindow(async (SessionConfigPanel) => {
    const panel = new SessionConfigPanel();
    panel.setRuntimeContext({
      chatStore: {
        listSessions: () => ['alice', 'team-room', 'rp:hero'],
      },
      contactsStore: {
        getContact: (sessionId) => {
          if (sessionId === 'alice') return { name: 'Alice' };
          if (sessionId === 'team-room') return { name: '项目群', isGroup: true };
          return null;
        },
      },
      personaStore: {
        get: (personaId) => (personaId === 'hero' ? { name: '勇者' } : null),
      },
    });

    assert.deepEqual(panel.getSessionEntries(), [
      { id: 'alice', name: 'Alice', meta: '聊天室', group: 'chat' },
      { id: 'team-room', name: '项目群', meta: '群聊', group: 'chat' },
      { id: 'rp:hero', name: '勇者', meta: '创意写作', group: 'rp' },
    ]);
  });
});

test('SessionConfigPanel getSessionEntries falls back to raw ids when contact or persona is missing', async () => {
  await withSessionPanelWindow(async (SessionConfigPanel) => {
    const panel = new SessionConfigPanel();
    panel.setRuntimeContext({
      chatStore: {
        listSessions: () => ['unknown-chat', 'rp:missing'],
      },
      contactsStore: {
        getContact: () => null,
      },
      personaStore: {
        get: () => null,
      },
    });

    assert.deepEqual(panel.getSessionEntries(), [
      { id: 'unknown-chat', name: 'unknown-chat', meta: '聊天室', group: 'chat' },
      { id: 'rp:missing', name: 'missing', meta: '创意写作', group: 'rp' },
    ]);
  });
});

test('SessionConfigPanel only lists presets eligible for the selected mode', async () => {
  await withSessionPanelWindow(async (SessionConfigPanel) => {
    const panel = new SessionConfigPanel({
      store: {
        listSummaries: () => [
          { id: 'creative', name: '创意专用', app_scope: 'creative' },
          { id: 'chat', name: '聊天专用', app_scope: 'chat' },
          { id: 'all', name: '全部', app_scope: 'all' },
        ],
      },
    });

    assert.deepEqual(panel.getPresetList('chat'), [
      { value: 'chat', label: '聊天专用' },
      { value: 'all', label: '全部' },
    ]);
    assert.deepEqual(panel.getPresetList('rp'), [
      { value: 'creative', label: '创意专用' },
      { value: 'all', label: '全部' },
    ]);
  });
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${t.name}`);
    console.error(err);
  }
}

if (failed > 0) {
  process.exit(1);
}
