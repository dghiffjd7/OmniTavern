import { buildConfigurableInputMessages } from '../../agent/agent-request-builder.js';
import { allowsAgentInvocation } from '../../agent/agent-invocation.js';
import { agentRequestTimeoutMs, buildAgentGenerationOptions } from '../../agent/agent-generation-settings.js';

// 输入阶段的短句续写：独立模型、可取消请求；不进入发送链或 Agent 运行记录。
export const buildInputSuggestionMessages = buildConfigurableInputMessages;

export const normalizeInputSuggestion = (value, before = '') => {
  let text = String(value ?? '').replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').replace(/^```[^\n]*\n([\s\S]*?)\n```\s*$/, '$1').trimEnd();
  if (before && text.startsWith(before)) text = text.slice(before.length);
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 400);
};

// 按可见字符选择，避免把 emoji、组合音标或代理对截成半个字符。
export const splitInputSuggestionCharacters = (value, Segmenter = globalThis.Intl?.Segmenter) => {
  const text = String(value ?? '');
  if (typeof Segmenter === 'function') {
    return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), item => item.segment);
  }
  // 较旧 WebView 的回退：保留常见组合标记、肤色、旗帜和 ZWJ emoji。
  const characters = [];
  let regionalCount = 0, joined = false;
  for (const character of text) {
    const code = character.codePointAt(0);
    const regional = code >= 0x1f1e6 && code <= 0x1f1ff;
    const extension = /[\p{Mark}\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}]/u.test(character);
    const last = characters.length - 1;
    if (last >= 0 && (extension || joined || code === 0x200d || (regional && regionalCount % 2 === 1)
      || (character === '\n' && characters[last] === '\r'))) characters[last] += character;
    else characters.push(character);
    joined = code === 0x200d;
    regionalCount = regional ? regionalCount + 1 : 0;
  }
  return characters;
};

export const createInputSuggestionRequest = ({ getProfileConfig, createClient, resolveReference } = {}) => async (snapshot, signal) => {
  const { settings } = snapshot;
  if (settings?.modelMode !== 'profile' || !settings.modelProfileId) return '';
  const config = await getProfileConfig(settings.modelProfileId);
  if (signal?.aborted || !config) return '';
  const referenceContext = typeof resolveReference === 'function'
    ? await resolveReference(snapshot, signal) : snapshot.referenceContext;
  if (signal?.aborted) return '';
  const agentConfig = { ...settings, id: 'text_completion' };
  const modelConfig = { ...config, ...(settings.modelOverride ? { model: settings.modelOverride } : {}), timeout: agentRequestTimeoutMs(agentConfig) };
  const client = createClient(modelConfig);
  const params = buildAgentGenerationOptions({ maxTokens: settings.maxTokens || 96, temperature: 0.3 }, modelConfig, agentConfig);
  return client.chat(buildInputSuggestionMessages({ ...snapshot, referenceContext }), { signal, requestContext: snapshot.requestContext,
    ...params, tools: [], toolChoice: 'none',
    requestParamConstraints: { maxOutputTokens: params.maxTokens, tools: 'none' } });
};

export const createInputSuggestionRuntime = ({
  getSnapshot, request, onSuggestion = () => {}, onStatus = () => {},
  delayMs = 500, maxPerMinute = 12, timeoutMs = 12000, requestBudget = null,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) => {
  let timer = null, controller = null, epoch = 0, disposed = false;
  let failures = 0, contextKey = '', accepted = null;
  let recent = [];
  const key = snapshot => JSON.stringify([snapshot?.contextKey, snapshot?.before, snapshot?.after, snapshot?.settings]);
  const valid = snapshot => snapshot?.active === true && allowsAgentInvocation({ ...snapshot.settings, id: 'text_completion' })
    && snapshot.settings.modelMode === 'profile' && Boolean(snapshot.settings.modelProfileId)
    && String(snapshot.before || '').trim().length >= 2;
  const cancel = () => {
    epoch++;
    if (timer !== null) clearTimer(timer);
    timer = null;
    controller?.abort(); controller = null;
    accepted = null;
    onSuggestion('');
  };
  const peek = () => {
    const snapshot = getSnapshot();
    return valid(snapshot) && accepted?.key === key(snapshot) ? accepted.text : '';
  };
  const schedule = () => {
    cancel();
    if (disposed) return;
    const snapshot = getSnapshot();
    if (snapshot?.contextKey !== contextKey) { contextKey = snapshot?.contextKey; failures = 0; recent = []; }
    if (!valid(snapshot) || failures >= 3) return;
    recent = recent.filter(at => now() - at < 60000);
    if (recent.length >= maxPerMinute) return;
    const stamp = epoch, snapshotKey = key(snapshot);
    timer = setTimer(async () => {
      timer = null;
      if (disposed || epoch !== stamp || key(getSnapshot()) !== snapshotKey || !valid(getSnapshot())) return;
      if (requestBudget && !requestBudget.take(snapshot.contextKey)) return;
      const activeController = new AbortController();
      controller = activeController;
      recent.push(now());
      const timeout = setTimer(() => activeController.abort(), agentRequestTimeoutMs(snapshot.settings, timeoutMs));
      try {
        onStatus('requesting');
        const result = await request(snapshot, activeController.signal);
        if (disposed || activeController.signal.aborted || epoch !== stamp || key(getSnapshot()) !== snapshotKey || !valid(getSnapshot())) return;
        failures = 0;
        const text = normalizeInputSuggestion(result, snapshot.before);
        accepted = text ? { text, key: snapshotKey } : null;
        onSuggestion(text);
        onStatus(text ? 'ready' : 'idle');
      } catch (error) {
        if (epoch !== stamp || disposed) return;
        failures++;
        onStatus(failures >= 3 ? 'paused' : 'failed');
      } finally {
        clearTimer(timeout);
        if (controller === activeController) controller = null;
      }
    }, delayMs);
  };
  return {
    schedule, cancel, peek,
    reset: () => { failures = 0; cancel(); },
    take: () => {
      const text = peek();
      cancel();
      return text;
    },
    commit: (count, insert) => {
      const snapshot = getSnapshot();
      const suggestion = peek();
      if (!suggestion) { cancel(); return false; }
      const characters = splitInputSuggestionCharacters(suggestion);
      const end = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : characters.length;
      const text = characters.slice(0, end).join('');
      if (!text) return false;
      const remainder = characters.slice(end).join('');
      cancel();
      const stamp = epoch;
      insert(text);
      // 写入经过原有 input/草稿监听；仅实际前后文仍吻合时续用剩余建议。
      const next = getSnapshot();
      if (!disposed && stamp === epoch && valid(next) && remainder
        && key(next) === key({ ...snapshot, before: snapshot.before + text })) {
        accepted = { text: remainder, key: key(next) };
        onSuggestion(remainder);
      }
      return true;
    },
    dispose: () => { disposed = true; cancel(); },
  };
};
