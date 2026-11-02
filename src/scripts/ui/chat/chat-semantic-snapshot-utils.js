export const CHAT_SEMANTIC_SNAPSHOT_VERSION = 'chat.semantic.v1';

const trim = value => String(value ?? '').trim();

const cloneJson = (value, fallback) => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
};

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const fingerprint = (value) => {
  const canonical = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `chat-semantic-v1:${(hash >>> 0).toString(16).padStart(8, '0')}:${canonical.length}`;
};

const normalizeLayers = (layers = []) => {
  const ids = new Set();
  const normalized = [];
  for (const [index, entry] of (Array.isArray(layers) ? layers : []).entries()) {
    const id = trim(entry?.id) || `legacy_layer_${index}`;
    const content = trim(entry?.content);
    const marker = trim(entry?.marker);
    if (!content || ids.has(id)) continue;
    ids.add(id);
    normalized.push({
      id,
      content,
      matchContent: marker || content,
      marker,
      required: entry?.required !== false,
    });
  }
  return normalized;
};

const countExact = (source, target) => {
  if (!source || !target) return 0;
  return String(source).split(target).length - 1;
};

const cleanSemanticText = value => String(value ?? '')
  .replace(/(?:\r?\n[ \t]*){3,}/g, '\n\n')
  .trim();

export const resolvePhoneFormatTransportLayers = (transportPlan = {}) => {
  const explicit = (Array.isArray(transportPlan?.phoneFormatPromptLayers)
    ? transportPlan.phoneFormatPromptLayers
    : []).map((entry, index) => ({
      id: trim(entry?.id) || `phone_format_${index + 1}`,
      content: trim(entry?.content),
    })).filter(entry => entry.id && entry.content);
  if (explicit.length) return explicit;
  const content = trim(transportPlan?.phoneFormatPromptContent);
  return content ? [{ id: 'phone_format', content }] : [];
};

const buildSnapshotMessages = (legacyMessages, layers) => {
  const sourceMessages = cloneJson(Array.isArray(legacyMessages) ? legacyMessages : [], []);
  const layerMatches = Object.fromEntries(layers.map(layer => [layer.id, 0]));
  sourceMessages.forEach((message) => {
    if (typeof message?.content !== 'string') return;
    layers.forEach((layer) => {
      layerMatches[layer.id] += countExact(message.content, layer.matchContent);
    });
  });
  const mismatched = layers.some(layer => (
    layer.required ? layerMatches[layer.id] !== 1 : layerMatches[layer.id] > 1
  ));
  if (mismatched) {
    return {
      ok: false,
      reason: 'legacy_transport_layer_mismatch',
      diagnostics: { layerMatches },
    };
  }

  const semanticMessages = [];
  const messageSkeleton = [];
  const messageAnchors = [];
  let anchorOrder = 0;

  for (const [messageIndex, message] of sourceMessages.entries()) {
    if (!message || typeof message !== 'object' || typeof message.content !== 'string') {
      const cloned = cloneJson(message, message);
      messageSkeleton.push({ kind: 'passthrough', message: cloned });
      semanticMessages.push(cloned);
      continue;
    }

    const occurrences = [];
    layers.forEach((layer) => {
      let from = 0;
      while (from <= message.content.length) {
        const start = message.content.indexOf(layer.matchContent, from);
        if (start < 0) break;
        occurrences.push({
          id: layer.id,
          content: layer.content,
          start,
          end: start + layer.matchContent.length,
        });
        from = start + layer.matchContent.length;
      }
    });
    occurrences.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
    if (occurrences.some((entry, index) => index > 0 && entry.start < occurrences[index - 1].end)) {
      return {
        ok: false,
        reason: 'legacy_transport_layer_overlap',
        diagnostics: { layerMatches },
      };
    }

    if (!occurrences.length) {
      const cloned = cloneJson(message, {});
      messageSkeleton.push({ kind: 'passthrough', message: cloned });
      // 语义视图统一清洗：与 segmented 分支同一口径，保证层位置变化（含 merge 后处理
      // 把锚点并入邻居的情形）不改变 FC/JSON 最终 payload 的字节内容
      const semanticContent = cleanSemanticText(message.content);
      if (semanticContent) semanticMessages.push({ ...cloned, content: semanticContent });
      continue;
    }

    const { content: _content, ...messageBase } = message;
    const segments = [];
    let cursor = 0;
    occurrences.forEach((occurrence) => {
      if (occurrence.start > cursor) {
        segments.push({ type: 'text', value: message.content.slice(cursor, occurrence.start) });
      }
      const segmentIndex = segments.length;
      segments.push({ type: 'legacy_layer', id: occurrence.id, value: occurrence.content });
      messageAnchors.push({
        id: occurrence.id,
        name: `legacy:${occurrence.id}`,
        messageIndex,
        segmentIndex,
        semanticInsertionIndex: semanticMessages.length,
        role: trim(message.role).toLowerCase() || 'system',
        insertionDepth: Number.isFinite(Number(message.depth)) ? Number(message.depth) : 0,
        order: anchorOrder,
      });
      anchorOrder += 1;
      cursor = occurrence.end;
    });
    if (cursor < message.content.length) {
      segments.push({ type: 'text', value: message.content.slice(cursor) });
    }
    messageSkeleton.push({ kind: 'segmented', messageBase, segments });
    const semanticContent = cleanSemanticText(
      segments.filter(segment => segment.type === 'text').map(segment => segment.value).join(''),
    );
    if (semanticContent) semanticMessages.push({ ...messageBase, content: semanticContent });
  }

  return {
    ok: true,
    semanticMessages,
    messageSkeleton,
    messageAnchors,
    diagnostics: { layerMatches },
  };
};

export const createChatSemanticSnapshot = ({
  requestId = '',
  turnId = '',
  sessionId = '',
  surface = '',
  responseTarget = '',
  legacyMessages = [],
  legacyLayers = [],
  providerFcTransportMessage = '',
  target = {},
  capabilities = {},
  budget = {},
  revisions = {},
} = {}) => {
  const layers = normalizeLayers(legacyLayers);
  const built = buildSnapshotMessages(legacyMessages, layers);
  if (!built.ok) return built;

  const snapshotPayload = {
    version: CHAT_SEMANTIC_SNAPSHOT_VERSION,
    identity: {
      requestId: trim(requestId),
      turnId: trim(turnId),
      sessionId: trim(sessionId),
      surface: trim(surface),
      responseTarget: trim(responseTarget),
    },
    semanticMessages: built.semanticMessages,
    messageSkeleton: built.messageSkeleton,
    messageAnchors: built.messageAnchors,
    providerFcAnchor: {
      name: 'provider_fc:before_latest_user',
      position: 'before_latest_user',
      insertionDepth: 0,
    },
    providerFcTransportMessage: trim(providerFcTransportMessage),
    target: cloneJson(target, {}),
    capabilities: cloneJson(capabilities, {}),
    budget: cloneJson(budget, {}),
    revisions: cloneJson(revisions, {}),
  };
  const snapshot = {
    ...snapshotPayload,
    fingerprint: fingerprint(snapshotPayload),
  };
  deepFreeze(snapshot);
  return {
    ok: true,
    reason: '',
    snapshot,
    diagnostics: built.diagnostics,
  };
};

const isSnapshot = snapshot => (
  snapshot?.version === CHAT_SEMANTIC_SNAPSHOT_VERSION
  && Array.isArray(snapshot?.semanticMessages)
  && Array.isArray(snapshot?.messageSkeleton)
  && Boolean(trim(snapshot?.fingerprint))
);

export const assembleProviderFcRequest = (snapshot) => {
  if (!isSnapshot(snapshot)) {
    return { ok: false, reason: 'semantic_snapshot_invalid', messages: [], snapshotFingerprint: '' };
  }
  const instruction = trim(snapshot.providerFcTransportMessage);
  if (!instruction) {
    return {
      ok: false,
      reason: 'provider_fc_instruction_unavailable',
      messages: [],
      snapshotFingerprint: snapshot.fingerprint,
    };
  }
  const messages = cloneJson(snapshot.semanticMessages, []);
  let insertIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (trim(messages[index]?.role).toLowerCase() === 'user') {
      insertIndex = index;
      break;
    }
  }
  messages.splice(insertIndex, 0, { role: 'system', content: instruction });
  return {
    ok: true,
    reason: '',
    messages,
    snapshotFingerprint: snapshot.fingerprint,
    diagnostics: {
      anchor: snapshot.providerFcAnchor.name,
      insertionIndex: insertIndex,
    },
  };
};

export const assembleLegacyTextRequest = (snapshot) => {
  if (!isSnapshot(snapshot)) {
    return { ok: false, reason: 'semantic_snapshot_invalid', messages: [], snapshotFingerprint: '' };
  }
  const messages = snapshot.messageSkeleton.map((entry) => {
    if (entry?.kind === 'passthrough') return cloneJson(entry.message, entry.message);
    const content = (Array.isArray(entry?.segments) ? entry.segments : [])
      .map(segment => String(segment?.value ?? ''))
      .join('');
    return { ...cloneJson(entry?.messageBase, {}), content };
  });
  return {
    ok: true,
    reason: '',
    messages,
    snapshotFingerprint: snapshot.fingerprint,
    diagnostics: {
      anchors: cloneJson(snapshot.messageAnchors, []),
      budgetRecomputed: false,
    },
  };
};

export const restoreDeferredLegacyTextMessages = ({
  messages = [],
  deferredLegacyLayers = [],
} = {}) => {
  const layers = (Array.isArray(deferredLegacyLayers) ? deferredLegacyLayers : [])
    .map((entry, index) => ({
      id: trim(entry?.id) || `deferred_layer_${index}`,
      content: String(entry?.content ?? ''),
      marker: trim(entry?.marker),
    }))
    .filter(entry => entry.content && entry.marker);
  const restored = cloneJson(Array.isArray(messages) ? messages : [], []);
  const replacements = Object.fromEntries(layers.map(layer => [layer.id, 0]));
  const restoreText = (text) => {
    let next = text;
    layers.forEach((layer) => {
      const count = countExact(next, layer.marker);
      replacements[layer.id] += count;
      if (count) next = next.split(layer.marker).join(layer.content);
    });
    return next;
  };
  restored.forEach((message) => {
    if (typeof message?.content === 'string') {
      message.content = restoreText(message.content);
      return;
    }
    // 带图片的用户消息是「文字 + 图片」数组；并进来的格式层标记在其中的 text 段里
    if (!Array.isArray(message?.content)) return;
    message.content.forEach((part) => {
      if (part?.type === 'text' && typeof part.text === 'string') part.text = restoreText(part.text);
    });
  });
  if (layers.some(layer => replacements[layer.id] !== 1)) {
    return {
      ok: false,
      reason: 'deferred_transport_anchor_mismatch',
      messages: [],
      replacements,
    };
  }
  return {
    ok: true,
    reason: '',
    messages: restored,
    replacements,
  };
};
