import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  MICROPHONE_PERMISSION_HINT_KEY,
  createMicrophonePermissionRecovery,
  microphonePermissionRecovery,
} from '../../src/scripts/ui/microphone-permission-recovery.js';
import { OpenAiRealtimeSessionClient } from '../../src/scripts/ui/realtime/openai-realtime-session-client.js';

const createStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
};

const permissionDenied = () => {
  const error = new Error('Permission denied');
  error.name = 'NotAllowedError';
  return error;
};

{
  const storage = createStorage();
  let mediaCalls = 0;
  let choiceCalls = 0;
  const invoked = [];
  const expectedStream = { id: 'microphone-stream' };
  const recovery = createMicrophonePermissionRecovery({
    storage,
    origin: 'http://tauri.localhost',
    choice: async () => {
      choiceCalls += 1;
      return 'retry';
    },
    invoke: async (command, args) => {
      invoked.push({ command, args });
      return { action: 'retry', platform: 'windows' };
    },
  });
  const mediaDevices = {
    getUserMedia: async () => {
      mediaCalls += 1;
      if (mediaCalls === 1) throw permissionDenied();
      return expectedStream;
    },
  };

  await assert.rejects(
    () => recovery.acquire({ mediaDevices, constraints: { audio: true } }),
    error => error?.code === 'microphone_permission_denied' && /再次点击语音/.test(error.message),
  );
  assert.equal(choiceCalls, 0, 'the first denial must not immediately pressure the user with another dialog');
  assert.equal(storage.getItem(MICROPHONE_PERMISSION_HINT_KEY), '1');

  const stream = await recovery.acquire({ mediaDevices, constraints: { audio: true } });
  assert.equal(stream, expectedStream);
  assert.equal(choiceCalls, 1);
  assert.equal(invoked[0].command, 'prepare_microphone_permission_retry');
  assert.equal(invoked[0].args.origin, 'http://tauri.localhost');
  assert.equal(storage.getItem(MICROPHONE_PERMISSION_HINT_KEY), null);
  console.log('ok - a first denial is remembered and the next user click can reset then request again');
}

{
  const storage = createStorage({ [MICROPHONE_PERMISSION_HINT_KEY]: '1' });
  const choices = ['retry', 'settings'];
  const invoked = [];
  let mediaCalls = 0;
  const recovery = createMicrophonePermissionRecovery({
    storage,
    choice: async () => choices.shift(),
    invoke: async (command) => {
      invoked.push(command);
      if (command === 'prepare_microphone_permission_retry') return { action: 'settings_required', platform: 'android' };
      return { opened: true };
    },
  });

  await assert.rejects(
    () => recovery.acquire({
      mediaDevices: { getUserMedia: async () => { mediaCalls += 1; } },
      constraints: { audio: true },
    }),
    error => error?.name === 'AbortError' && error?.cancelled === true,
  );
  assert.equal(mediaCalls, 0, 'a permanently denied permission must not loop getUserMedia');
  assert.deepEqual(invoked, [
    'prepare_microphone_permission_retry',
    'open_microphone_permission_settings',
  ]);
  assert.equal(storage.getItem(MICROPHONE_PERMISSION_HINT_KEY), '1');
  console.log('ok - a permanent denial leads to settings without another ineffective media request');
}

{
  const storage = createStorage({ [MICROPHONE_PERMISSION_HINT_KEY]: '1' });
  let mediaCalls = 0;
  const recovery = createMicrophonePermissionRecovery({
    storage,
    choice: async () => 'retry',
    invoke: async () => { throw new Error('native microphone bridge failed'); },
  });
  await assert.rejects(
    () => recovery.acquire({
      mediaDevices: { getUserMedia: async () => { mediaCalls += 1; return {}; } },
      constraints: { audio: true },
    }),
    /native microphone bridge failed/,
  );
  assert.equal(mediaCalls, 0, 'a packaged-app bridge failure must not silently repeat a denied media request');
  console.log('ok - unexpected native bridge failures stay visible instead of looping getUserMedia');
}

{
  const voiceSource = await readFile(new URL('../../src/scripts/ui/chat/voice-interaction-runtime.js', import.meta.url), 'utf8');
  const recoverySource = await readFile(new URL('../../src/scripts/ui/microphone-permission-recovery.js', import.meta.url), 'utf8');
  const rustSource = await readFile(new URL('../../src-tauri/src/microphone_permission.rs', import.meta.url), 'utf8');
  const kotlinSource = await readFile(new URL('../../src-tauri/gen/android/app/src/main/java/com/chatapp/dev/MicrophonePermissionPlugin.kt', import.meta.url), 'utf8');
  const libSource = await readFile(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(voiceSource, /microphoneAccess\.acquire/);
  assert.equal(
    new OpenAiRealtimeSessionClient().microphoneAccess,
    microphonePermissionRecovery,
    'Realtime must default to the shared microphone permission recovery service',
  );
  assert.match(recoverySource, /prepare_microphone_permission_retry/);
  assert.doesNotMatch(recoverySource, /plugin:microphone-permission\|prepare_retry/);
  assert.match(rustSource, /SetPermissionState/);
  assert.match(rustSource, /COREWEBVIEW2_PERMISSION_STATE_DEFAULT/);
  assert.match(kotlinSource, /Manifest\.permission\.RECORD_AUDIO/);
  assert.match(kotlinSource, /ACTION_APPLICATION_DETAILS_SETTINGS/);
  assert.match(libSource, /microphone_permission::init/);
  assert.match(libSource, /microphone_permission::prepare_microphone_permission_retry/);
  console.log('ok - ordinary voice, Realtime, Windows, and Android share one permission recovery contract');
}

console.log('microphone-permission-recovery-tests passed');
