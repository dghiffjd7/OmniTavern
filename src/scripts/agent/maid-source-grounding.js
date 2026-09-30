const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const clone = value => {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

const list = value => (
  Array.isArray(value) ? value : [value]
).map(item => trim(item)).filter(Boolean);

const unique = value => Array.from(new Set(list(value)));

const normalizeMatchText = value => trim(value)
  .toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}_]+/gu, '');

const sourceOutput = step => {
  const output = step?.output;
  if (output?.result && typeof output.result === 'object') return output.result;
  return output && typeof output === 'object' ? output : {};
};

const sourceLayerOf = entry => trim(entry?.sourceLayer || entry?.provenance?.layer).toLocaleLowerCase();
const sourceRefsOf = entry => unique(entry?.sourceRefs || entry?.provenance?.refs);
const entryLabel = (entry, index) => trim(
  entry?.entryTitle || entry?.title || entry?.comment || entry?.name || entry?.id,
  `entry-${index + 1}`,
);

export const MAID_SOURCE_LAYERS = Object.freeze([
  'canon',
  'user_original',
  'creative_extension',
]);

export const resolveMaidSourceGroundingPolicy = (input = '') => {
  const text = trim(input);
  const strictNoInvent = /(?:不要|不可|不能|别|禁止).{0,8}(?:硬编|编造|杜撰|瞎编|捏造|脑补)|(?:不硬编|不编造|不杜撰|不瞎编|不捏造)|没有.{0,12}(?:可靠)?来源.{0,12}(?:不要|不能).{0,8}(?:写成|当成).{0,8}(?:原作|正典|事实)|只(?:写|使用|采用).{0,12}(?:可靠|可核对|有来源).{0,8}(?:资料|事实)/iu.test(text);
  const allowCreativeExtension = /(?:允许|可以|可).{0,10}(?:创作扩写|创意扩写|合理扩写|合理补充|原创补充)|(?:创作扩写|创意扩写|合理扩写|合理补充).{0,10}(?:允许|可以)/iu.test(text);
  const requiresLayering = strictNoInvent ||
    /(?:原作|正典|canon|官方设定|用户(?:指定)?原创|原创设定|创作扩写|世界观|世界书|角色卡)/iu.test(text);
  return {
    strictNoInvent,
    allowCreativeExtension,
    requiresLayering,
  };
};

const matchTargetTerms = (value, terms = []) => {
  const haystack = normalizeMatchText(value);
  if (!haystack) return [];
  return unique(terms).filter(term => {
    const normalized = normalizeMatchText(term);
    return normalized.length >= 2 && haystack.includes(normalized);
  });
};

// A source URL (including a title that falls back to that URL) identifies where
// a page lives. Its domain/path does not establish which subject it discusses.
const sourceMatchText = value => trim(value).replace(/https?:\/\/[^\s<>"']+/giu, '');

export const annotateMaidSearchResult = (result = {}, args = {}) => {
  const target = trim(args?.target);
  const targetAliases = unique(args?.targetAliases);
  const targetTerms = unique([target, ...targetAliases]);
  const checked = targetTerms.length > 0;
  const results = (Array.isArray(result?.results) ? result.results : []).map(item => clone(item));
  const documents = (Array.isArray(result?.documents) ? result.documents : []).map(item => clone(item));
  const searchableByUrl = new Map();
  [...results, ...documents].forEach(item => {
    const url = trim(item?.url);
    if (!url) return;
    const previous = searchableByUrl.get(url) || '';
    searchableByUrl.set(url, [
      previous,
      sourceMatchText(item?.title),
      sourceMatchText(item?.snippet || item?.description),
      sourceMatchText(item?.text),
    ].filter(Boolean).join('\n'));
  });
  const annotate = item => {
    const next = clone(item) || {};
    const searchable = [
      sourceMatchText(next.title),
      sourceMatchText(next.snippet || next.description),
      sourceMatchText(next.text),
      searchableByUrl.get(trim(next.url)) || '',
    ].filter(Boolean).join('\n');
    const matchedTargetTerms = checked ? matchTargetTerms(searchable, targetTerms) : [];
    return {
      ...next,
      targetRelevant: checked ? matchedTargetTerms.length > 0 : null,
      matchedTargetTerms,
    };
  };
  const annotatedResults = results.map(annotate);
  const annotatedDocuments = documents.map(annotate);
  const sourceInput = Array.isArray(result?.sources)
    ? result.sources
    : results.map(item => ({
        title: trim(item?.title || item?.url),
        url: trim(item?.url),
        source: trim(item?.source),
      }));
  const sources = sourceInput.map(annotate);
  const relevantSourceCount = sources.filter(source => source.targetRelevant === true).length;
  return {
    ...clone(result),
    results: annotatedResults,
    documents: annotatedDocuments,
    sources,
    // Request success and readable pages do not establish evidence for the target.
    evidenceStatus: checked ? (relevantSourceCount > 0 ? 'target_matched' : 'no_relevant_sources') : 'target_not_checked',
    // Name matching is a relevance hint, not verification of prices, dates or claims.
    factVerification: 'not_performed',
    targetCheck: {
      checked,
      method: 'normalized_name_match',
      target,
      targetAliases,
      relevantSourceCount,
      unrelatedSourceCount: sources.filter(source => source.targetRelevant === false).length,
    },
  };
};

// Existing callers and saved research flows share the same annotation contract.
export const annotateMaidResearchResult = annotateMaidSearchResult;

export const buildMaidSourceGroundingContext = ({
  input = '',
  steps = [],
} = {}) => {
  const policy = resolveMaidSourceGroundingPolicy(input);
  const sourceMap = new Map();
  let targetCheckPerformed = false;
  (Array.isArray(steps) ? steps : []).forEach(step => {
    if (step?.status !== 'succeeded' || !['web.research', 'web.search', 'web.fetch_url'].includes(trim(step?.toolName))) return;
    const output = sourceOutput(step);
    if (output?.targetCheck?.checked === true) targetCheckPerformed = true;
    const candidates = [
      ...(Array.isArray(output?.sources) ? output.sources : []),
      ...(Array.isArray(output?.documents) ? output.documents : []),
    ];
    candidates.forEach(item => {
      const url = trim(item?.url);
      if (!url) return;
      const target = trim(output?.targetCheck?.target || step?.args?.target || item?.target);
      const targetAliases = unique(output?.targetCheck?.targetAliases || step?.args?.targetAliases || item?.targetAliases);
      // One page can be relevant to A and unrelated to B. Keep that distinction
      // even when both searches refer to the exact same source URL.
      const scope = target
        ? ['target', normalizeMatchText(target)]
        : ['aliases', ...unique(targetAliases.map(normalizeMatchText)).sort()];
      const key = JSON.stringify([url, scope]);
      const existing = sourceMap.get(key);
      const next = {
        url,
        title: trim(item?.title || existing?.title || url),
        query: trim(output?.query || step?.args?.query),
        target,
        targetAliases,
        targetRelevant: item?.targetRelevant === true
          ? true
          : (existing?.targetRelevant === true ? true : (item?.targetRelevant === false ? false : null)),
        matchedTargetTerms: unique([
          ...(existing?.matchedTargetTerms || []),
          ...list(item?.matchedTargetTerms),
        ]),
      };
      sourceMap.set(key, next);
    });
  });
  const sources = Array.from(sourceMap.values()).slice(0, 24);
  return {
    policy,
    targetCheckPerformed,
    sources,
    allowedCanonRefs: unique(sources
      .filter(source => source.targetRelevant === true)
      .map(source => source.url)),
  };
};

export const validateMaidWorldbookSourcePlan = ({
  toolName = '',
  args = {},
  grounding = null,
} = {}) => {
  if (!['worldbook.create', 'worldbook.update_entries', 'worldbook.generate_entries'].includes(trim(toolName))) {
    return { ok: true };
  }
  const state = grounding && typeof grounding === 'object'
    ? grounding
    : buildMaidSourceGroundingContext();
  const policy = state?.policy || resolveMaidSourceGroundingPolicy('');
  const entries = trim(toolName) === 'worldbook.update_entries'
    ? (Array.isArray(args?.updates) ? args.updates : [])
    : (Array.isArray(args?.entries) ? args.entries : []);
  const allowedCanonRefs = new Set(unique(state?.allowedCanonRefs));
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const sourceLayer = sourceLayerOf(entry);
    const sourceRefs = sourceRefsOf(entry);
    const label = entryLabel(entry, index);
    if (!sourceLayer) {
      if (policy.strictNoInvent) {
        return {
          ok: false,
          reason: 'source_layer_required',
          message: `条目「${label}」缺少 sourceLayer；严格“不编造”任务必须标记 canon、user_original 或 creative_extension。`,
          entryIndex: index,
          entryLabel: label,
        };
      }
      continue;
    }
    if (!MAID_SOURCE_LAYERS.includes(sourceLayer)) {
      return {
        ok: false,
        reason: 'invalid_source_layer',
        message: `条目「${label}」的 sourceLayer 无效。`,
        entryIndex: index,
        entryLabel: label,
        sourceLayer,
      };
    }
    if (sourceLayer === 'canon') {
      if (!state?.targetCheckPerformed || !allowedCanonRefs.size) {
        return {
          ok: false,
          reason: 'canon_target_check_required',
          message: `条目「${label}」标为 canon，但尚无通过目标作品校对的来源；请先用 web.research 传 target/targetAliases。`,
          entryIndex: index,
          entryLabel: label,
        };
      }
      if (!sourceRefs.some(reference => allowedCanonRefs.has(reference))) {
        return {
          ok: false,
          reason: 'canon_source_not_verified',
          message: `条目「${label}」的 sourceRefs 没有引用已通过目标作品校对的来源 URL。`,
          entryIndex: index,
          entryLabel: label,
          allowedCanonRefs: Array.from(allowedCanonRefs).slice(0, 12),
        };
      }
    }
    if (sourceLayer === 'creative_extension' && policy.strictNoInvent && !policy.allowCreativeExtension) {
      return {
        ok: false,
        reason: 'creative_extension_not_allowed',
        message: `用户要求“不编造”，且没有授权创意扩写；条目「${label}」不能写入。`,
        entryIndex: index,
        entryLabel: label,
      };
    }
  }
  return { ok: true };
};

export const buildMaidSourceGroundingPromptBlock = ({
  input = '',
  steps = [],
} = {}) => {
  const state = buildMaidSourceGroundingContext({ input, steps });
  if (!state.policy.requiresLayering && !state.sources.length) return '';
  const sourceLines = state.sources.slice(0, 8).map((source, index) => [
    `${index + 1}. ${source.targetRelevant === true ? 'relevant' : (source.targetRelevant === false ? 'unrelated' : 'unchecked')}`,
    `target=${source.target || source.targetAliases.join(' / ') || '(unspecified)'}`,
    source.title,
    source.url,
  ].filter(Boolean).join(' | '));
  return [
    `<maid_source_grounding mode="${state.policy.strictNoInvent ? 'strict_no_invent' : 'layered'}">`,
    '世界书事实层：sourceLayer 只能是 canon、user_original、creative_extension。',
    'canon 必须在 sourceRefs[] 写入下方 relevant 来源的完整 URL；user_original 表示用户明确给出的原创设定，可用 sourceRefs:["user_request"]；creative_extension 必须与 canon 分开。',
    '检索具名作品时，web.research 必须传 target，必要时传 targetAliases；unrelated/unchecked 来源不能支持 canon。',
    state.policy.strictNoInvent
      ? `严格模式：缺少 sourceLayer 的条目禁止写入；创意扩写${state.policy.allowCreativeExtension ? '已获用户允许但必须显式标层' : '未获允许，不得写入'}。`
      : '普通模式：建议所有作品设定条目显式标层；一旦标为 canon 仍必须有已校对来源。',
    sourceLines.length ? `已校对来源：\n${sourceLines.join('\n')}` : '已校对来源：（无；写 canon 前先 research）',
    '</maid_source_grounding>',
  ].join('\n');
};
