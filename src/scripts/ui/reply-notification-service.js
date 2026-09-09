import { safeInvoke } from '../utils/tauri.js';
import { createTauriPluginChannel } from './app-native-back-button-utils.js';

const normalize = value => ({
  supported: value?.supported === true,
  enabled: value?.enabled === true,
});

// Device preferences live in LocalAppData, independently of portable app settings.
export const createReplyNotificationService = ({ invoke = safeInvoke, makeChannel = createTauriPluginChannel } = {}) => {
  let state = normalize(null), loading = null, writes = Promise.resolve(), navigation = Promise.resolve();
  let onOpen = null, watching = null;
  const subscribers = new Set();
  const publish = () => { for (const listener of subscribers) listener({ ...state }); };
  const load = () => loading ||= invoke('reply_notification_settings').then(value => {
    state = normalize(value); publish(); return { ...state };
  }).catch(() => { loading = null; return { ...state }; });
  const configure = patch => {
    const pending = writes.catch(() => {}).then(async () => {
      await load();
      if (!state.supported) throw new Error('Reply notifications unavailable');
      const next = normalize({ ...state, ...patch });
      await invoke('reply_notification_configure', { preferences: { enabled: next.enabled } });
      state = next; publish(); return { ...state };
    });
    writes = pending;
    return pending;
  };
  const takeActivation = () => {
    navigation = navigation.catch(() => {}).then(async () => {
      const route = await invoke('reply_notification_take_activation');
      if (route && onOpen) await onOpen(route);
    });
    return navigation;
  };
  return {
    load, configure,
    get: () => ({ ...state }),
    subscribe: fn => { subscribers.add(fn); fn({ ...state }); return () => subscribers.delete(fn); },
    async complete(payload) {
      await load();
      await writes.catch(() => {});
      if (!state.supported || !state.enabled) return 'disabled';
      return invoke('reply_notification_complete', payload);
    },
    async start({ open, onError = () => {} } = {}) {
      onOpen = open;
      if (!(await load()).supported) return;
      if (!watching) {
        const channel = makeChannel({ callback: () => { takeActivation().catch(onError); } });
        if (!channel) return;
        watching = invoke('reply_notification_watch', { channel }).catch(error => { watching = null; throw error; });
      }
      await watching;
      await takeActivation();
    },
  };
};

export const replyNotificationService = createReplyNotificationService();

export const bindReplyNotificationSettings = ({ root, service = replyNotificationService, onError = () => {}, updateRows = () => {} } = {}) => {
  const section = root.querySelector('[data-reply-notification-settings]');
  const enabled = root.querySelector('#general-reply-notification-enabled');
  let busy = false;
  const render = state => {
    section.hidden = !state.supported;
    enabled.checked = state.enabled;
    enabled.disabled = busy;
    updateRows();
  };
  const change = async patch => {
    busy = true; render(service.get());
    try { await service.configure(patch); }
    catch (error) { onError(error); }
    finally { busy = false; render(service.get()); }
  };
  const onEnabled = () => change({ enabled: enabled.checked });
  enabled.addEventListener('change', onEnabled);
  const unsubscribe = service.subscribe(render);
  service.load();
  return () => { unsubscribe(); enabled.removeEventListener('change', onEnabled); };
};
