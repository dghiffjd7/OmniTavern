import { NativeRealtimeSessionClient } from './native-realtime-session-client.js';
import { validateRealtimeProfile, validateRealtimeCredentials } from './realtime-provider-catalog.js';
import { buildOpenAiRealtimeSessionConfig } from './realtime-voice-config-utils.js';
import { t } from '../../i18n/index.js';

// A blank, short-lived session: no microphone, saved conversation, or app tools.
export const checkCustomRealtime = async (profile, credentials, { signal, checkTools = false, createClient = options => new NativeRealtimeSessionClient(options), timeoutMs = 15000 } = {}) => {
  validateRealtimeProfile(profile); validateRealtimeCredentials('custom', credentials, profile);
  let waiter = null;
  const abortError = () => new DOMException('Cancelled', 'AbortError');
  const client = createClient({
    createAudio: () => ({ open: async () => {}, close: async () => {}, clear: () => {}, play: () => {} }),
    onEvent: event => {
      if (event.type === 'error') waiter?.reject(new Error(event.error?.message || t('实时服务返回错误')));
      if (event.type === 'response.done') waiter?.resolve(event.response);
    },
    onConnectionState: state => { if (state === 'failed') waiter?.reject(new Error(t('实时语音连接已关闭'))); },
  });
  const abort = () => { waiter?.reject(abortError()); void client.close(); };
  const response = async options => {
    if (signal?.aborted) throw abortError();
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        timer = setTimeout(() => reject(new Error(t('任务调用检查超时，尚未确认此渠道支持女仆任务'))), timeoutMs);
        client.sendEvent({ type: 'response.create', response: { output_modalities: ['text'], ...options } });
      });
    } finally { clearTimeout(timer); waiter = null; }
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw abortError();
    const token = globalThis.crypto.randomUUID();
    const sessionConfig = buildOpenAiRealtimeSessionConfig({ ...profile, realtimeModel: profile.model, instructions: 'This is a connection compatibility check.' });
    if (checkTools) sessionConfig.tools = [{ type: 'function', name: 'realtime_compatibility_probe', description: 'A harmless compatibility check, with no application side effects.',
      parameters: { type: 'object', properties: { token: { type: 'string', enum: [token] } }, required: ['token'], additionalProperties: false } }];
    await client.connect({ config: { ...profile, credentials }, sessionConfig, signal });
    if (signal?.aborted) throw abortError();
    if (!checkTools) return { connected: true, tools: 'unverified', audio: 'unverified' };
    const first = await response({ tool_choice: { type: 'function', name: 'realtime_compatibility_probe' }, instructions: `Call realtime_compatibility_probe with token ${token}.` });
    const call = first?.status === 'completed' && first.output?.find(item => item.type === 'function_call' && item.name === 'realtime_compatibility_probe' && item.call_id);
    let args;
    try { args = JSON.parse(call?.arguments || 'null'); } catch {}
    if (args?.token !== token) throw new Error(t('渠道未返回有效工具调用，尚未确认支持女仆任务'));
    const receipt = globalThis.crypto.randomUUID();
    client.sendToolResults([{ call: { id: call.call_id }, result: { receipt } }]);
    const second = await response({ tool_choice: 'none', instructions: 'Reply with only the receipt value from the tool result.' });
    const text = (second?.output || []).flatMap(item => item.content || []).map(part => part.text || '').join('');
    if (second?.status !== 'completed' || !text.includes(receipt)) throw new Error(t('工具结果回传未通过，尚未确认支持女仆任务'));
    return { connected: true, tools: 'verified', audio: 'unverified' };
  } finally { signal?.removeEventListener('abort', abort); await client.close(); }
};
