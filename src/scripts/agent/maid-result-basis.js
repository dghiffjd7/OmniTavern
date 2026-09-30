const text = (value, max = 160) => String(value ?? '').trim().slice(0, max);
const list = value => Array.isArray(value) ? value : [];
const timestamp = value => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 8.64e15 ? Number(value) : 0;
const MAX_TOOLS = 16;
const MAX_SOURCES = 8;
const MAX_ARTIFACTS = 8;
const STATUSES = new Set(['queued', 'running', 'waiting_permission', 'succeeded', 'failed', 'cancelled', 'skipped']);
const SOURCE_KINDS = new Set(['fetched', 'read_document', 'search_result', 'unknown']);

const normalizeSources = values => {
  const sources = [], seen = new Set();
  for (const item of values) {
    if (!item || item.ok === false || item.targetRelevant === false) continue;
    const raw = String(item.url || '').trim();
    if (!raw || raw.length > 2048) continue;
    let url;
    try { url = new URL(raw); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
    seen.add(url.href);
    sources.push({ title: text(item.title, 160) || url.hostname, url: url.href,
      kind: SOURCE_KINDS.has(item.kind) ? item.kind : 'unknown' });
    if (sources.length >= MAX_SOURCES) break;
  }
  return sources;
};

// Store only references and the bounded design observed in successful image
// results. These references do not guarantee the runtime attachment still exists.
const normalizeArtifacts = values => {
  const artifacts = [], seen = new Set();
  for (const item of list(values)) {
    const attachmentId = text(item?.attachmentId);
    if (!attachmentId || /[\s<>]|^(?:data:|https?:)/i.test(attachmentId) || seen.has(attachmentId)) continue;
    seen.add(attachmentId);
    const artifact = { attachmentId };
    for (const key of ['subject', 'target', 'purpose', 'targetAspectRatio']) {
      const value = text(item[key], key === 'target' ? 240 : 160);
      if (value) artifact[key] = value;
    }
    for (const key of ['appearance', 'outfit', 'style']) {
      const value = text(item[key], 320);
      if (value) artifact[key] = value;
    }
    const aliases = list(item.subjectAliases).map(value => text(value, 80)).filter(Boolean).slice(0, 4);
    if (aliases.length) artifact.subjectAliases = aliases;
    for (const key of ['actualWidth', 'actualHeight']) {
      const value = Math.floor(Number(item[key]));
      if (value > 0 && value <= 65536) artifact[key] = value;
    }
    artifacts.push(artifact);
    if (artifacts.length >= MAX_ARTIFACTS) break;
  }
  return artifacts;
};

const normalizeTool = raw => {
  const tool = raw && typeof raw === 'object' ? raw : {};
  return {
    name: text(tool.name || tool.toolName || tool.input?.toolName),
    status: STATUSES.has(tool.status) ? tool.status : 'unknown',
    stepId: text(tool.stepId || tool.id),
    startedAt: timestamp(tool.startedAt),
    finishedAt: timestamp(tool.finishedAt),
  };
};

// A bounded data contract shared by task updates, persisted turns and rendering.
// It describes recorded work, not the correctness or freshness of an answer.
export const normalizeMaidResultBasis = raw => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const tools = list(raw.tools).map(normalizeTool).filter(tool => tool.name).slice(0, MAX_TOOLS);
  const toolCount = Math.max(tools.length, Math.min(10000, Math.floor(Number(raw.toolCount) || 0)));
  const succeededToolCount = Math.min(toolCount, Math.max(
    tools.filter(tool => tool.status === 'succeeded').length,
    Math.min(10000, Math.floor(Number(raw.succeededToolCount) || 0)),
  ));
  const artifacts = normalizeArtifacts(raw.artifacts);
  return {
    kind: succeededToolCount ? 'tool_execution'
      : raw.kind === 'explanation' && !toolCount ? 'explanation' : 'unverified',
    responseType: text(raw.responseType, 80),
    source: text(raw.source),
    recordedAt: timestamp(raw.recordedAt),
    runId: text(raw.runId),
    toolCount,
    succeededToolCount,
    tools,
    sources: normalizeSources(list(raw.sources)),
    ...(artifacts.length ? { artifacts } : {}),
  };
};

const stepOutput = step => {
  const output = step?.output;
  return output?.toolName && output?.result && typeof output.result === 'object' ? output.result : output || {};
};

// result.steps are completed Agent observations; traceView is the projection of
// the run belonging to this submission. A plan or a run ID alone proves nothing.
export const buildMaidResultBasis = (result = {}, { traceView = null, recordedAt = Date.now() } = {}) => {
  const previous = normalizeMaidResultBasis(result?.resultBasis);
  const traceSteps = list(traceView?.steps);
  const resultSteps = list(result?.steps);
  const useResultSteps = resultSteps.length > 0;
  // A delayed UI trace may still contain a running step after completion was
  // recorded. Fill its timing without discarding the completed observations.
  const retainPrevious = !useResultSteps && previous?.toolCount > 0 && previous.toolCount >= traceSteps.length;
  const steps = useResultSteps ? resultSteps : retainPrevious ? previous.tools : traceSteps;
  const usedTraceIndexes = new Set();
  const tools = [], sources = [], artifacts = [], appliedTargets = new Map();
  for (const [stepIndex, step] of steps.entries()) {
    const output = stepOutput(step);
    if (output.localToolExecutionSkipped === true || step?.status === 'skipped') continue;
    const tool = normalizeTool(step);
    if (!tool.name) continue;
    // A failed validation/permission step can exist before a tool executes.
    // Keep it inspectable, but never turn it into evidence of successful use.
    if (output.ok === false && tool.status === 'succeeded') tool.status = 'failed';
    if (useResultSteps || retainPrevious) {
      const traceIndex = traceSteps.findIndex((candidate, index) => (
        !usedTraceIndexes.has(index) && text(candidate?.toolName || candidate?.input?.toolName) === tool.name
      ));
      if (traceIndex !== -1) {
        usedTraceIndexes.add(traceIndex);
        const timing = normalizeTool(traceSteps[traceIndex]);
        tool.stepId ||= timing.stepId;
        tool.startedAt ||= timing.startedAt;
        tool.finishedAt ||= timing.finishedAt;
        if (retainPrevious && ['queued', 'running', 'waiting_permission'].includes(tool.status)) tool.status = timing.status;
      }
    }
    tools.push(tool);
    if (tool.status === 'succeeded') {
      if (tool.name === 'media.generate_image' && output.ok === true) {
        artifacts.push({ ...output.visualSpec, attachmentId: output.attachmentId });
      }
      if (['contact.set_avatar', 'persona.set_avatar', 'user.set_avatar', 'session.set_wallpaper'].includes(tool.name)
        && output.ok === true && output.image?.attachmentId) {
        const target = text(output.target?.id || output.sessionId, 240);
        if (target) appliedTargets.set(output.image.attachmentId, target);
      }
      const addSource = (item, kind, priority) => {
        if (!item || typeof item !== 'object') return;
        sources.push({ title: item.title, url: item.url, ok: item.ok, targetRelevant: item.targetRelevant, kind, priority, stepIndex });
      };
      // These are access/search records, not inferred citations from the reply.
      // Only this tool's contract establishes that its top-level URL was fetched.
      if (tool.name === 'web.fetch_url' && output.ok === true) addSource(output, 'fetched', 0);
      for (const document of list(output.documents)) {
        if (document?.ok === true) addSource(document, 'read_document', 1);
      }
      for (const source of [...list(output.sources), ...list(output.results)]) {
        addSource(source, 'search_result', source?.targetRelevant === true ? 2 : 3);
      }
    }
  }
  // Apply the shared cap after ranking and URL deduplication so early search
  // candidates cannot displace pages that were actually read later in this run.
  sources.sort((a, b) => a.priority - b.priority || b.stepIndex - a.stepIndex);
  const hasRecordedSteps = useResultSteps || retainPrevious || traceSteps.length > 0;
  const retainedTools = hasRecordedSteps ? tools : previous?.tools || [];
  const toolCount = retainPrevious ? previous.toolCount : hasRecordedSteps ? tools.length : previous?.toolCount || 0;
  const succeededToolCount = Math.max(retainPrevious ? previous.succeededToolCount : 0,
    hasRecordedSteps ? tools.filter(tool => tool.status === 'succeeded').length : previous?.succeededToolCount || 0);
  const responseType = text(result?.responseType || previous?.responseType, 80);
  return normalizeMaidResultBasis({
    kind: succeededToolCount ? 'tool_execution' : responseType === 'chat' && !toolCount ? 'explanation' : 'unverified',
    responseType,
    source: result?.source || previous?.source,
    recordedAt,
    runId: traceView?.runId || result?.runId || previous?.runId,
    toolCount,
    succeededToolCount,
    tools: retainedTools,
    sources: useResultSteps ? sources : [...sources, ...list(previous?.sources)],
    artifacts: (useResultSteps ? artifacts : [...artifacts, ...list(previous?.artifacts)])
      .map(artifact => ({ ...artifact, target: appliedTargets.get(artifact.attachmentId) || artifact.target })),
  });
};
