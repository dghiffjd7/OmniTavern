import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createModeSwitchInteractionRuntime } from '../../src/scripts/ui/app-mode-switch-interaction-runtime-utils.js';
import { createMaidVoiceRuntime } from '../../src/scripts/ui/maid-voice-runtime.js';
import { createAppSessionAgentTools } from '../../src/scripts/agent/tools/app-session-tools.js';

const app = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
const extract = (start, end) => {
  const from = app.indexOf(start), to = app.indexOf(end, from);
  assert(from >= 0 && to > from, `app seam: ${start}`);
  return app.slice(from, to);
};
const noop = () => {};

test('Realtime ball keeps the actual app mode-switch action', () => {
  let controls = 0;
  const voice = createMaidVoiceRuntime({ createOrb: () => ({ toggleControls: () => { controls++; return true; } }) });
  const sandbox = {
    createModeSwitchInteractionRuntime, document: {}, modeSwitch: null, modeSwitchBtn: null,
    getViewportSize: () => ({ w: 400, h: 800 }), normalizeModeSwitchPos: noop,
    saveModeSwitchPos: noop, wakeModeSwitch: noop, scheduleModeSwitchSync: noop,
    maidVoiceRuntime: voice, uiMode: 'chat',
    enterRpMode: () => { sandbox.uiMode = 'rp'; }, exitRpMode: () => { sandbox.uiMode = 'chat'; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extract('const modeSwitchInteractionRuntime =', '// 执行流面板：贴球')}globalThis.interaction = modeSwitchInteractionRuntime;`, sandbox);
  sandbox.interaction.handleClick();
  assert.equal(sandbox.uiMode, 'rp', 'voice controls must not consume the switch-to-writing click');
  sandbox.interaction.handleClick();
  assert.equal(sandbox.uiMode, 'chat');
  assert.equal(controls, 0);
});

test('creating/opening a normal room while writing renders it in chat mode', async () => {
  const contacts = new Map(), messages = new Map([['rp:writer', [{ content: 'original writing' }]]]);
  let current = 'rp:writer';
  const frames = [], persistedModes = [];
  const chatStore = {
    getCurrent: () => current, switchSession: id => { current = id; },
    appendMessage: (message, id) => { const list = messages.get(id) || []; list.push(message); messages.set(id, list); },
  };
  const contactsStore = { getContact: id => contacts.get(id), listContacts: () => [...contacts.values()], upsertContact: contact => contacts.set(contact.id, contact) };
  const sandbox = {
    uiMode: 'rp', activePage: 'chat', activePersonaScopeKey: 'writer', chatStore, contactsStore,
    isRpSessionId: id => id.startsWith('rp:'), canEnterPersonaScopedSession: () => ({ allowed: true }),
    beginChatEnterRequest: noop, document: { getElementById: () => null },
    runSessionEnterFlow: async options => { frames.push({ mode: sandbox.uiMode, sessionId: options.sessionId, messages: messages.get(options.sessionId) }); return {}; },
    recordDebugTraceEvent: noop, uiLog: noop, chatGeneratedImagePreview: { revealPendingForSession: noop },
    syncRejectedFormatRepairBanner: noop, syncProtocolRevealButtonState: noop, syncRealtimeCallButtonAvailability: noop,
    maidGuideEmit: noop, window: {}, persistUiMode: () => persistedModes.push(sandbox.uiMode), applyUiModeUI: noop,
    rpToolbar: { style: { display: '' } }, backToListBtn: { style: { display: 'none' } },
    refreshChatAndContacts: noop,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extract('const enterChatRoom = async', 'const exitChatRoom =')}globalThis.enter = enterChatRoom;`, sandbox);
  const tools = createAppSessionAgentTools({ chatStore, contactsStore, enterChatRoom: sandbox.enter });
  const create = tools.find(tool => tool.name === 'session.create');
  await create.execute({ name: 'background-room', open: false });
  assert.equal(sandbox.uiMode, 'rp'); assert.equal(current, 'rp:writer'); assert.equal(frames.length, 0);
  await create.execute({ name: 'new-room', open: true });
  assert.equal(frames.at(-1).messages[0].content, '你创建了聊天室「new-room」');
  assert.equal(frames.at(-1).mode, 'chat', 'new-room history must not appear under the writing UI');
  assert.equal(current, 'new-room');
  assert.deepEqual(messages.get('rp:writer'), [{ content: 'original writing' }]);
  assert.deepEqual(persistedModes, ['chat']);
  assert.equal(sandbox.rpToolbar.style.display, 'none');
  assert.equal(sandbox.backToListBtn.style.display, '');
});
