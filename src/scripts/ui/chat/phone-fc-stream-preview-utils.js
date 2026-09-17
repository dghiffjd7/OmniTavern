const PRIVATE_MODE = 'private';
const BATCH_MODE = 'batch';

const trim = value => String(value ?? '').trim();

const normalizeMode = value => (
  trim(value).toLowerCase() === BATCH_MODE ? BATCH_MODE : PRIVATE_MODE
);

const normalizeLimit = (value, fallback = 12000) => {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
};

const isIndex = value => Number.isInteger(value) && value >= 0;

const matchesPrivateContentPath = path => (
  path.length === 3
  && path[0] === 'messages'
  && isIndex(path[1])
  && path[2] === 'content'
);

const matchesBatchContentPath = (path) => {
  if (path[0] !== 'items' || path[1] !== 0) return false;
  if (
    path.length === 5
    && ['messages', 'comments', 'posts'].includes(path[2])
    && isIndex(path[3])
    && path[4] === 'content'
  ) {
    return true;
  }
  return path.length === 7
    && path[2] === 'posts'
    && isIndex(path[3])
    && path[4] === 'comments'
    && isIndex(path[5])
    && path[6] === 'content';
};

const isVisibleContentPath = (mode, path) => (
  mode === BATCH_MODE ? matchesBatchContentPath(path) : matchesPrivateContentPath(path)
);

const decodeEscape = value => ({
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}[value] ?? value);

const sanitizeVisibleCharacter = (value) => {
  if (value === '\n' || value === '\t') return value;
  const code = String(value || '').charCodeAt(0);
  return Number.isFinite(code) && code >= 0x20 && code !== 0x7f ? value : '';
};

export const createPhoneFcArgumentsPreviewDecoder = ({
  mode = PRIVATE_MODE,
  maxChars = 12000,
} = {}) => {
  const previewMode = normalizeMode(mode);
  const limit = normalizeLimit(maxChars);
  const stack = [];
  const fields = [];
  let rootState = 'value';
  let activeString = null;
  let activePrimitive = false;
  let invalid = false;
  let visibleChars = 0;
  let truncated = false;
  let lastReportedText = '';

  const currentValuePath = () => {
    if (!stack.length) return rootState === 'value' ? [] : null;
    const parent = stack[stack.length - 1];
    if (parent.type === 'object' && parent.state === 'value' && parent.key !== null) {
      return [...parent.path, parent.key];
    }
    if (parent.type === 'array' && parent.state === 'valueOrEnd') {
      return [...parent.path, parent.index];
    }
    return null;
  };

  const finishValue = () => {
    if (!stack.length) {
      rootState = 'done';
      return;
    }
    const parent = stack[stack.length - 1];
    if (parent.type === 'object' && parent.state === 'value') {
      parent.state = 'commaOrEnd';
      parent.key = null;
      return;
    }
    if (parent.type === 'array' && parent.state === 'valueOrEnd') {
      parent.state = 'commaOrEnd';
      parent.index += 1;
      return;
    }
    invalid = true;
  };

  const appendVisible = (fieldIndex, value) => {
    const safe = sanitizeVisibleCharacter(value);
    if (!safe || fieldIndex < 0) return;
    if (visibleChars >= limit) {
      truncated = true;
      return;
    }
    fields[fieldIndex] += safe;
    visibleChars += safe.length;
  };

  const finishString = () => {
    const current = activeString;
    activeString = null;
    if (!current) return;
    if (current.role === 'key') {
      const parent = stack[stack.length - 1];
      if (!parent || parent.type !== 'object' || parent.state !== 'keyOrEnd') {
        invalid = true;
        return;
      }
      parent.key = current.buffer;
      parent.state = 'colon';
      return;
    }
    finishValue();
  };

  const beginString = () => {
    const parent = stack[stack.length - 1];
    if (parent?.type === 'object' && parent.state === 'keyOrEnd') {
      activeString = {
        role: 'key',
        buffer: '',
        escape: false,
        unicode: '',
        fieldIndex: -1,
      };
      return;
    }
    const path = currentValuePath();
    if (!path) {
      invalid = true;
      return;
    }
    const visible = isVisibleContentPath(previewMode, path);
    const fieldIndex = visible ? fields.push('') - 1 : -1;
    activeString = {
      role: 'value',
      buffer: '',
      escape: false,
      unicode: '',
      fieldIndex,
    };
  };

  const pushStringCharacter = (char) => {
    const current = activeString;
    if (!current) return;
    if (current.unicode) {
      if (!/[0-9a-f]/iu.test(char)) {
        invalid = true;
        return;
      }
      current.unicode += char;
      if (current.unicode.length === 5) {
        const decoded = String.fromCharCode(Number.parseInt(current.unicode.slice(1), 16));
        current.unicode = '';
        if (current.role === 'key') current.buffer += decoded;
        else appendVisible(current.fieldIndex, decoded);
      }
      return;
    }
    if (current.escape) {
      current.escape = false;
      if (char === 'u') {
        current.unicode = 'u';
        return;
      }
      const decoded = decodeEscape(char);
      if (current.role === 'key') current.buffer += decoded;
      else appendVisible(current.fieldIndex, decoded);
      return;
    }
    if (char === '\\') {
      current.escape = true;
      return;
    }
    if (char === '"') {
      finishString();
      return;
    }
    if (current.role === 'key') current.buffer += char;
    else appendVisible(current.fieldIndex, char);
  };

  const beginContainer = (type) => {
    const path = currentValuePath();
    if (!path) {
      invalid = true;
      return;
    }
    stack.push(type === 'object'
      ? { type, path, state: 'keyOrEnd', key: null }
      : { type, path, state: 'valueOrEnd', index: 0 });
  };

  const closeContainer = (type) => {
    const current = stack[stack.length - 1];
    const canClose = current?.type === type && (
      current.state === 'commaOrEnd'
      || (type === 'object' && current.state === 'keyOrEnd')
      || (type === 'array' && current.state === 'valueOrEnd')
    );
    if (!canClose) {
      invalid = true;
      return;
    }
    stack.pop();
    finishValue();
  };

  const getText = () => {
    const text = fields.filter(value => value.length > 0).join('\n\n');
    return truncated ? `${text}…` : text;
  };

  const snapshot = () => {
    const text = getText();
    const changed = text !== lastReportedText;
    lastReportedText = text;
    return {
      changed,
      text,
      fieldCount: fields.filter(value => value.length > 0).length,
      truncated,
      invalid,
    };
  };

  return {
    push(fragment = '') {
      const source = String(fragment ?? '');
      let index = 0;
      while (index < source.length && !invalid) {
        const char = source[index];
        if (activeString) {
          pushStringCharacter(char);
          index += 1;
          continue;
        }
        if (activePrimitive) {
          if (/[,}\]\s]/u.test(char)) {
            activePrimitive = false;
            finishValue();
            continue;
          }
          index += 1;
          continue;
        }
        if (/\s/u.test(char)) {
          index += 1;
          continue;
        }
        const current = stack[stack.length - 1];
        if (char === '"') {
          beginString();
          index += 1;
          continue;
        }
        if (char === '{') {
          beginContainer('object');
          index += 1;
          continue;
        }
        if (char === '[') {
          beginContainer('array');
          index += 1;
          continue;
        }
        if (char === '}') {
          closeContainer('object');
          index += 1;
          continue;
        }
        if (char === ']') {
          closeContainer('array');
          index += 1;
          continue;
        }
        if (char === ':') {
          if (!current || current.type !== 'object' || current.state !== 'colon') invalid = true;
          else current.state = 'value';
          index += 1;
          continue;
        }
        if (char === ',') {
          if (!current || current.state !== 'commaOrEnd') invalid = true;
          else if (current.type === 'object') current.state = 'keyOrEnd';
          else current.state = 'valueOrEnd';
          index += 1;
          continue;
        }
        if (/[-0-9tfn]/u.test(char) && currentValuePath()) {
          activePrimitive = true;
          index += 1;
          continue;
        }
        invalid = true;
      }
      return snapshot();
    },
    getSnapshot: snapshot,
  };
};

const callKey = (delta = {}) => {
  const id = trim(delta?.toolCallId || delta?.id);
  if (id) return `id:${id}`;
  const index = Number(delta?.index);
  return Number.isFinite(index) && index >= 0 ? `index:${Math.trunc(index)}` : '';
};

export const createPhoneFcToolPreviewCollector = ({
  mode = PRIVATE_MODE,
  toolName = '',
  maxChars = 12000,
  now = Date.now,
} = {}) => {
  const expectedToolName = trim(toolName);
  const decoder = createPhoneFcArgumentsPreviewDecoder({ mode, maxChars });
  const startedAt = Number(now?.() || Date.now()) || Date.now();
  let selectedId = '';
  let selectedIndex = -1;
  let selected = false;
  let argumentChars = 0;
  let updateCount = 0;
  let firstArgumentsAt = 0;
  let firstPreviewAt = 0;
  let lastState = {
    changed: false,
    text: '',
    fieldCount: 0,
    truncated: false,
    invalid: false,
  };

  const select = (delta) => {
    if (selected || trim(delta?.toolName) !== expectedToolName) return selected;
    selectedId = trim(delta?.toolCallId || delta?.id);
    const numericIndex = Number(delta?.index);
    selectedIndex = Number.isFinite(numericIndex) ? Math.trunc(numericIndex) : -1;
    selected = Boolean(selectedId || selectedIndex >= 0 || expectedToolName);
    return selected;
  };

  const matches = (delta) => {
    if (!selected && !select(delta)) return false;
    const deltaToolName = trim(delta?.toolName);
    if (deltaToolName && deltaToolName !== expectedToolName) return false;
    const id = trim(delta?.toolCallId || delta?.id);
    const numericIndex = Number(delta?.index);
    const index = Number.isFinite(numericIndex) ? Math.trunc(numericIndex) : -1;
    if (selectedId && id) return selectedId === id;
    if (selectedIndex >= 0 && index >= 0) return selectedIndex === index;
    return Boolean(selectedId ? !id : selectedIndex < 0);
  };

  return {
    pushDeltas(deltas = []) {
      let changed = false;
      let firstArgumentsObserved = false;
      let argumentsObserved = false;
      for (const delta of (Array.isArray(deltas) ? deltas : [])) {
        if (!matches(delta)) continue;
        let fragment = String(delta?.argumentsDelta ?? '');
        if (!fragment && argumentChars === 0 && delta?.argumentsText) {
          fragment = String(delta.argumentsText);
        }
        if (!fragment) continue;
        argumentsObserved = true;
        if (!firstArgumentsAt) {
          firstArgumentsAt = Number(now?.() || Date.now()) || Date.now();
          firstArgumentsObserved = true;
        }
        argumentChars += fragment.length;
        const state = decoder.push(fragment);
        lastState = state;
        if (!state.changed) continue;
        changed = true;
        updateCount += 1;
        if (!firstPreviewAt && state.text) {
          firstPreviewAt = Number(now?.() || Date.now()) || Date.now();
        }
      }
      return { ...lastState, changed, argumentsObserved, firstArgumentsObserved, firstArgumentsAt };
    },
    getDiagnostics() {
      return {
        streamPreviewUsed: selected,
        previewUpdateCount: updateCount,
        previewChars: String(lastState.text || '').replace(/…$/u, '').length,
        previewFieldCount: Number(lastState.fieldCount || 0),
        previewTruncated: lastState.truncated === true,
        firstPreviewLatencyMs: firstPreviewAt ? Math.max(0, firstPreviewAt - startedAt) : 0,
      };
    },
    getSnapshot: () => ({ ...lastState }),
    getSelectedCallKey: () => selected ? (selectedId ? `id:${selectedId}` : callKey({ index: selectedIndex })) : '',
  };
};

export const createPhoneFcProviderStreamRuntime = ({
  enabled = false,
  client = null,
  mode = PRIVATE_MODE,
  toolName = '',
  onPreview = null,
  onFirstArgumentsDelta = null,
  onArgumentsDelta = null,
  maxChars = 12000,
  now = Date.now,
} = {}) => {
  const streaming = enabled === true
    && typeof onPreview === 'function'
    && typeof client?.streamChat === 'function';
  const collector = createPhoneFcToolPreviewCollector({ mode, toolName, maxChars, now });
  let firstArgumentsReported = false;

  const emit = (event) => {
    if (!streaming) return;
    try { onPreview(event); } catch {}
  };

  return {
    enabled: streaming,
    pushDeltas(deltas = []) {
      if (!streaming) return collector.getSnapshot();
      const state = collector.pushDeltas(deltas);
      if (state.argumentsObserved) {
        try { onArgumentsDelta?.({ at: Number(now?.() || Date.now()) || Date.now(), toolName: trim(toolName) }); } catch {}
      }
      if (state.firstArgumentsObserved && !firstArgumentsReported) {
        firstArgumentsReported = true;
        try {
          onFirstArgumentsDelta?.({
            at: state.firstArgumentsAt,
            toolName: trim(toolName),
          });
        } catch {}
      }
      if (state.changed && state.text) {
        emit({
          phase: 'update',
          text: state.text,
          fieldCount: state.fieldCount,
          truncated: state.truncated === true,
        });
      }
      return state;
    },
    async request(messages, options) {
      if (!streaming) return client.chat(messages, options);
      let responseText = '';
      for await (const chunk of client.streamChat(messages, options)) {
        if (typeof chunk === 'string') responseText += chunk;
      }
      return responseText;
    },
    dispose(outcome = 'aborted', reason = '') {
      if (!streaming) return;
      emit({
        phase: 'dispose',
        outcome: trim(outcome) || 'aborted',
        reason: trim(reason),
      });
    },
    getDiagnostics() {
      return {
        ...collector.getDiagnostics(),
        streamPreviewUsed: streaming,
      };
    },
  };
};
