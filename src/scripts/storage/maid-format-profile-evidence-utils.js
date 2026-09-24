export const MAID_FORMAT_PROFILE_SCHEMA_VERSION = 2;
export const MAID_FORMAT_PROFILE_EXTRACTOR_VERSION = 'guardian-format-evidence-v1';

const AI_OUTPUT_PLACEMENT = 2;
const MAX_REGEX_PATTERN_LENGTH = 1200;
const MAX_REGEX_REPLACEMENT_LENGTH = 1600;
const MAX_EVIDENCE = 12;

const trim = value => String(value ?? '').trim();
const asArray = value => (Array.isArray(value) ? value : []);

const stableSerialize = (value, stack = new Set()) => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value !== 'object') return JSON.stringify(String(value));
  if (stack.has(value)) return '"[Circular]"';
  stack.add(value);
  const serialized = Array.isArray(value)
    ? `[${value.map(item => stableSerialize(item, stack)).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key], stack)}`).join(',')}}`;
  stack.delete(value);
  return serialized;
};

export const fingerprintMaidFormatProfileSource = (value) => {
  const text = stableSerialize(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + ((second << 6) >>> 0) + (second >>> 2);
  }
  return `mfp:${text.length}:${first >>> 0}:${second >>> 0}`;
};

const normalizePlacement = (rule = {}) => {
  if (Array.isArray(rule?.placement)) {
    return rule.placement.map(Number).filter(Number.isFinite);
  }
  if (rule?.source && typeof rule.source === 'object') {
    return rule.source.ai_output === true ? [AI_OUTPUT_PLACEMENT] : [];
  }
  return String(rule?.when || '').trim().toLowerCase() === 'output'
    ? [AI_OUTPUT_PLACEMENT]
    : [];
};

const readRegexPattern = (rule = {}) => trim(
  rule?.findRegex ?? rule?.find_regex ?? rule?.pattern,
);

const readRegexReplacement = (rule = {}) => String(
  rule?.replaceString ?? rule?.replace_string ?? rule?.replacement ?? '',
);

const stripRegexLiteralWrapper = (value = '') => {
  const raw = trim(value);
  if (!raw.startsWith('/')) return raw;
  for (let index = raw.length - 1; index > 0; index -= 1) {
    if (raw[index] !== '/') continue;
    let escaped = false;
    for (let cursor = index - 1; cursor >= 0 && raw[cursor] === '\\'; cursor -= 1) {
      escaped = !escaped;
    }
    if (escaped) continue;
    const flags = raw.slice(index + 1);
    if (/^[dgimsuvy]*$/i.test(flags)) return raw.slice(1, index);
    break;
  }
  return raw;
};

const isOnlyCaptureReplacement = (value = '') => {
  const stripped = String(value || '')
    .replace(/\$(?:\d+|&|`|'|<[^>]+>)/g, '')
    .trim();
  return !stripped;
};

const CLEANUP_NAME_RE = /(?:cleanup|clean\s*up|strip|remove|hide|display|style|render|beautif|markdown|清理|清除|删除|移除|隐藏|显示|样式|美化|渲染)/iu;
const DANGEROUS_CONTENT_RE = /(?:<\s*script\b|javascript\s*:|on[a-z]+\s*=|@import\b|expression\s*\()/iu;
const STYLE_REPLACEMENT_RE = /(?:<\/?[a-z][^>]*>|\bclass\s*=|\bstyle\s*=|(?:^|[;{])\s*(?:display|color|background|font|position)\s*:)/iu;
const NEGATIVE_MATCH_RE = /\(\?(?:!|<!)/u;
const EXCLUDED_TAGS = new Set([
  'analysis',
  'body',
  'head',
  'html',
  'reasoning',
  'script',
  'style',
  'think',
  'thinking',
]);

const extractAnchoredPairedTagMarkers = (pattern = '') => {
  const source = stripRegexLiteralWrapper(pattern).trim();
  if (!source.startsWith('^') || !source.endsWith('$')) return [];
  const literalish = source.replace(/\\([<>/])/g, '$1');
  const openingTags = Array.from(literalish.matchAll(/<([A-Za-z][A-Za-z0-9_.:-]{0,39})(?:\\s[^<>]{0,120})?>/g))
    .map(match => String(match[1] || '').toLowerCase())
    .filter(Boolean);
  const closingTags = new Set(
    Array.from(literalish.matchAll(/<\/([A-Za-z][A-Za-z0-9_.:-]{0,39})>/g))
      .map(match => String(match[1] || '').toLowerCase())
      .filter(Boolean),
  );
  return Array.from(new Set(openingTags))
    .filter(tag => closingTags.has(tag) && !EXCLUDED_TAGS.has(tag))
    .slice(0, 4)
    .map(tag => `<${tag}>...</${tag}>`);
};

const rejectRegexRule = (rule = {}) => {
  if (rule?.disabled === true || rule?.enabled === false) return 'disabled';
  if (!normalizePlacement(rule).includes(AI_OUTPUT_PLACEMENT)) return 'not_ai_output';
  if (rule?.markdownOnly === true || rule?.markdown_only === true) return 'display_only';
  if (rule?.promptOnly === true || rule?.prompt_only === true) return 'prompt_only';
  const pattern = readRegexPattern(rule);
  const replacement = readRegexReplacement(rule);
  if (!pattern) return 'empty_pattern';
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH || replacement.length > MAX_REGEX_REPLACEMENT_LENGTH) return 'too_long';
  if (NEGATIVE_MATCH_RE.test(pattern)) return 'negative_match';
  if (DANGEROUS_CONTENT_RE.test(pattern) || DANGEROUS_CONTENT_RE.test(replacement)) return 'dangerous_content';
  if (CLEANUP_NAME_RE.test(trim(rule?.scriptName || rule?.script_name || rule?.name))) return 'cleanup_or_display_name';
  if (!trim(replacement) || isOnlyCaptureReplacement(replacement)) return 'cleanup_replacement';
  if (STYLE_REPLACEMENT_RE.test(replacement)) return 'style_replacement';
  return '';
};

export const extractSafeRegexFormatEvidence = (rules = []) => {
  const evidence = [];
  const rejected = [];
  asArray(rules).forEach((rule, index) => {
    const ruleId = trim(rule?.id) || `regex-${index + 1}`;
    const ruleName = trim(rule?.scriptName || rule?.script_name || rule?.name) || ruleId;
    const rejectedReason = rejectRegexRule(rule);
    if (rejectedReason) {
      rejected.push({ ruleId, ruleName: ruleName.slice(0, 120), reason: rejectedReason });
      return;
    }
    const markers = extractAnchoredPairedTagMarkers(readRegexPattern(rule));
    if (!markers.length) {
      rejected.push({ ruleId, ruleName: ruleName.slice(0, 120), reason: 'no_high_confidence_structure' });
      return;
    }
    evidence.push({
      id: `regex:${ruleId}`,
      sourceType: 'regex',
      ruleId: ruleId.slice(0, 120),
      ruleName: ruleName.slice(0, 120),
      kind: 'anchored_paired_tag_block',
      markers,
      confidence: 'high',
    });
  });
  return {
    evidence: evidence.slice(0, MAX_EVIDENCE),
    rejected: rejected.slice(0, 80),
    acceptedCount: Math.min(evidence.length, MAX_EVIDENCE),
    rejectedCount: rejected.length,
  };
};

const normalizeDeclaredSources = value => asArray(value)
  .map(item => ({
    type: trim(item?.type).toLowerCase().slice(0, 40),
    ref: trim(item?.ref).slice(0, 160),
  }))
  .filter(item => item.type || item.ref)
  .sort((left, right) => `${left.type}:${left.ref}`.localeCompare(`${right.type}:${right.ref}`));

const normalizePresetSources = value => asArray(value)
  .map(item => ({
    type: trim(item?.type).toLowerCase().slice(0, 40),
    id: trim(item?.id).slice(0, 160),
    source: trim(item?.source).slice(0, 40),
    revision: Number(item?.revision || item?.updatedAt || 0) || 0,
    contentFingerprint: trim(item?.contentFingerprint)
      || fingerprintMaidFormatProfileSource(item?.value ?? item?.preset ?? item?.content ?? null),
  }))
  .filter(item => item.type || item.id)
  .sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));

const normalizeWorldSources = value => asArray(value)
  .map(item => ({
    id: trim(item?.id || item?.name).slice(0, 160),
    revision: Number(item?.revision || item?.updatedAt || item?.updated_at || 0) || 0,
    entriesCount: Number.isFinite(Number(item?.entriesCount)) ? Math.max(0, Math.trunc(Number(item.entriesCount))) : null,
    refs: asArray(item?.refs).map(trim).filter(Boolean).sort().slice(0, 80),
  }))
  .filter(item => item.id)
  .sort((left, right) => left.id.localeCompare(right.id));

const normalizeIdentitySource = value => ({
  id: trim(value?.id).slice(0, 160),
  revision: Number(value?.revision || value?.updatedAt || value?.updated || 0) || 0,
  contentFingerprint: fingerprintMaidFormatProfileSource(value?.value ?? value?.content ?? null),
});

const normalizeRegexRulesForFingerprint = value => asArray(value).map(rule => ({
  id: trim(rule?.id).slice(0, 120),
  name: trim(rule?.scriptName || rule?.script_name || rule?.name).slice(0, 160),
  find: readRegexPattern(rule),
  replace: readRegexReplacement(rule),
  placement: normalizePlacement(rule).sort((a, b) => a - b),
  disabled: rule?.disabled === true || rule?.enabled === false,
  markdownOnly: rule?.markdownOnly === true || rule?.markdown_only === true,
  promptOnly: rule?.promptOnly === true || rule?.prompt_only === true,
  runOnEdit: rule?.runOnEdit === true || rule?.run_on_edit === true,
}));

export const buildMaidFormatProfileSourceState = ({
  declaredSources = [],
  presets = [],
  regexRules = [],
  worldbooks = [],
  persona = null,
  character = null,
} = {}) => {
  const regexEvidence = extractSafeRegexFormatEvidence(regexRules);
  const sourceRevisions = {
    declaredSources: normalizeDeclaredSources(declaredSources),
    presets: normalizePresetSources(presets),
    regexFingerprint: fingerprintMaidFormatProfileSource(normalizeRegexRulesForFingerprint(regexRules)),
    worldbooks: normalizeWorldSources(worldbooks),
    persona: normalizeIdentitySource(persona),
    character: normalizeIdentitySource(character),
  };
  return {
    schemaVersion: MAID_FORMAT_PROFILE_SCHEMA_VERSION,
    extractorVersion: MAID_FORMAT_PROFILE_EXTRACTOR_VERSION,
    fingerprint: fingerprintMaidFormatProfileSource({
      schemaVersion: MAID_FORMAT_PROFILE_SCHEMA_VERSION,
      extractorVersion: MAID_FORMAT_PROFILE_EXTRACTOR_VERSION,
      sourceRevisions,
    }),
    sourceRevisions,
    evidence: regexEvidence.evidence,
    regexEvidence,
  };
};
