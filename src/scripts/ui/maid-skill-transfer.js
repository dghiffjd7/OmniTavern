import { parseDocument, stringify, visit, isAlias } from '../../vendor/skills/yaml.js';
import { MAID_SKILL_LIMITS, maidSkillContentKey, makeMaidSkillName, normalizeMaidSkillDraft, normalizeMaidSkillMetadata, skillBytes, skillClone, skillError, skillObject } from '../agent/maid-skill-schema.js';

export const MAID_SKILL_PACKAGE_FORMAT = 'omnitavern-maid-skills';
const coreKeys = new Set(['name', 'description', 'metadata', 'license', 'compatibility']);
const controlKeys = new Set(['allowed-tools', 'context', 'agent', 'hooks', 'user-invocable', 'disable-model-invocation', 'model', 'argument-hint', 'arguments', 'paths']);
const filenameOnly = name => String(name || 'SKILL.md').split(/[\\/]/).at(-1).slice(0, 160);
const portable = skill => ({ ...normalizeMaidSkillDraft(skill), enabled: undefined });
const contentKey = skill => `${maidSkillContentKey({ ...skill, name: '' })}|${skill.invocationMode || 'auto'}`;

const deduplicatePreview = entries => {
  const seen = new Map();
  for (const entry of entries) {
    if (entry.error || !entry.skill) continue;
    try {
      const key = contentKey(normalizeMaidSkillDraft(entry.skill));
      if (seen.has(key)) {
        entry.action = 'skip'; entry.selected = false;
        entry.duplicateId ||= seen.get(key);
      } else seen.set(key, entry.duplicateId || `preview:${entry.key}`);
    } catch { /* Incomplete drafts remain editable in the preview. */ }
  }
  return entries;
};

const parseHeader = source => {
  const doc = parseDocument(source, { version: '1.2', schema: 'core', uniqueKeys: true, stringKeys: true, customTags: [], prettyErrors: false, logLevel: 'silent' });
  if (doc.errors.length || doc.warnings.length) throw skillError('skill_yaml_invalid');
  visit(doc, (_key, node, path) => {
    if (path.length > 10 || isAlias(node)) throw skillError('skill_yaml_invalid');
    if (node?.tag && !/^tag:yaml\.org,2002:(?:str|map|seq|bool|null|int|float)$/.test(node.tag)) throw skillError('skill_yaml_invalid');
  });
  const result = doc.toJS({ maxAliasCount: 0 });
  if (!skillObject(result)) throw skillError('skill_yaml_invalid');
  return normalizeMaidSkillMetadata(result);
};

const uniqueName = (name, existing, used = new Set()) => {
  const base = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name || '') && name.length <= 64 ? name : makeMaidSkillName();
  const occupied = new Set([...existing.map(skill => skill.name), ...used]);
  let result = base, suffix = 2;
  while (occupied.has(result)) {
    const tail = `-${suffix++}`;
    result = `${base.slice(0, 64 - tail.length).replace(/-+$/, '')}${tail}`;
  }
  return result;
};

const makeEntry = (raw, fileName, index, existing, featureIds) => {
  const skill = {
    title: typeof raw.title === 'string' ? raw.title : '', name: typeof raw.name === 'string' ? raw.name : makeMaidSkillName(),
    description: typeof raw.description === 'string' ? raw.description : '', content: typeof raw.content === 'string' ? raw.content : '',
    featureIds: Array.isArray(raw.featureIds) ? [...raw.featureIds] : [], enabled: true,
    invocationMode: raw.invocationMode === 'manual' ? 'manual' : 'auto', portableMetadata: normalizeMaidSkillMetadata(raw.portableMetadata || {}),
  };
  const issues = [], fm = skill.portableMetadata.frontmatter || {};
  const ignored = Object.keys(fm).filter(key => !coreKeys.has(key) && key !== 'disable-model-invocation');
  if (ignored.length) issues.push({ code: 'skill_import_ignored_fields', fields: ignored, requiresTextOnly: ignored.some(key => controlKeys.has(key)) });
  if (fm['disable-model-invocation'] !== undefined && ![true, false].includes(fm['disable-model-invocation'])) issues.push({ code: 'skill_import_ignored_fields', fields: ['disable-model-invocation'], requiresTextOnly: true });
  if (/!`[^`]*`/.test(skill.content)) issues.push({ code: 'skill_import_commands_unsupported', requiresTextOnly: true });
  if (/\]\((?!https?:|mailto:|tel:|#)[^)]*\)/i.test(skill.content) || /\b(?:scripts|references|assets)\//.test(skill.content)) issues.push({ code: 'skill_import_missing_resources', requiresTextOnly: false });
  if (featureIds) {
    const unknown = skill.featureIds.filter(id => !featureIds.includes(id));
    if (unknown.length) issues.push({ code: 'skill_import_unknown_features', fields: unknown, requiresTextOnly: false });
  }
  let duplicate = null;
  try {
    const normalized = normalizeMaidSkillDraft(skill);
    duplicate = existing.find(item => item.kind !== 'builtin' && contentKey(item) === contentKey(normalized));
  } catch { /* Missing editable fields are completed in the preview. */ }
  const sameTitle = existing.some(item => item.title === skill.title);
  return { key: `${fileName}:${index}`, fileName, skill, issues, error: '', sameTitle,
    action: duplicate ? 'skip' : 'new', selected: !duplicate, duplicateId: duplicate?.id || '', targetId: '', expectedRevision: null, textOnlyAccepted: false };
};

export const parseMaidSkillText = (text, { fileName = 'SKILL.md', existing = [], featureIds = null } = {}) => {
  const name = filenameOnly(fileName), source = String(text).replace(/^\uFEFF/, '');
  if (skillBytes(source) > MAID_SKILL_LIMITS.bytes) throw skillError('skill_import_size_limit');
  if (/\.json$/i.test(name)) {
    let bundle;
    try { bundle = JSON.parse(source); } catch { throw skillError('skill_import_invalid_package'); }
    if (bundle?.format !== MAID_SKILL_PACKAGE_FORMAT || bundle.version !== 1 || !Array.isArray(bundle.skills) || bundle.skills.length > MAID_SKILL_LIMITS.count) throw skillError('skill_import_invalid_package');
    return deduplicatePreview(bundle.skills.map((raw, index) => {
      try {
        if (!skillObject(raw)) throw skillError('skill_import_invalid_package');
        return makeEntry(raw, name, index, existing, featureIds);
      } catch (error) { return { key: `${name}:${index}`, fileName: name, error: error.code || 'skill_import_invalid_package', selected: false, skill: null, issues: [] }; }
    }));
  }
  if (!/\.md$/i.test(name)) throw skillError('skill_import_type_unsupported');
  if (skillBytes(source) > MAID_SKILL_LIMITS.fileBytes) throw skillError('skill_import_size_limit');
  let header = {}, content = source;
  if (/^---\r?\n/.test(source)) {
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)([\s\S]*)$/);
    if (!match) throw skillError('skill_yaml_invalid');
    header = parseHeader(match[1]); content = match[2];
  }
  if (header.metadata !== undefined && !skillObject(header.metadata)) throw skillError('skill_invalid_metadata');
  const metadata = header.metadata || {};
  let references = [];
  if (metadata['omnitavern-feature-ids'] !== undefined) {
    try { references = JSON.parse(metadata['omnitavern-feature-ids']); } catch { throw skillError('skill_invalid_features'); }
    if (!Array.isArray(references)) throw skillError('skill_invalid_features');
  }
  const raw = {
    title: metadata['omnitavern-title'] || header.name || name.replace(/\.md$/i, ''),
    name: header.name || makeMaidSkillName(), description: header.description || '', content,
    featureIds: references,
    invocationMode: header['disable-model-invocation'] === true || metadata['omnitavern-invocation-mode'] === 'manual' ? 'manual' : 'auto',
    portableMetadata: { frontmatter: header },
  };
  // Known editable values are canonical fields, not stale duplicates in metadata.
  for (const key of ['name', 'description']) delete raw.portableMetadata.frontmatter[key];
  if (raw.portableMetadata.frontmatter.metadata) {
    for (const key of ['omnitavern-title', 'omnitavern-feature-ids', 'omnitavern-invocation-mode']) delete raw.portableMetadata.frontmatter.metadata[key];
    if (!Object.keys(raw.portableMetadata.frontmatter.metadata).length) delete raw.portableMetadata.frontmatter.metadata;
  }
  if (!Object.keys(raw.portableMetadata.frontmatter).length) raw.portableMetadata = {};
  return [makeEntry(raw, name, 0, existing, featureIds)];
};

export const readMaidSkillImportFiles = async (files, options = {}) => {
  const list = Array.from(files || []);
  if (!list.length || list.length > 20 || list.reduce((sum, file) => sum + Number(file.size || 0), 0) > MAID_SKILL_LIMITS.bytes) throw skillError('skill_import_size_limit');
  const entries = []; let bytes = 0;
  for (let index = 0; index < list.length; index++) {
    const file = list[index], fileName = filenameOnly(file.name);
    try {
      const buffer = await file.arrayBuffer(); bytes += buffer.byteLength;
      if (bytes > MAID_SKILL_LIMITS.bytes) throw skillError('skill_import_size_limit');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw skillError('skill_import_encoding'); }
      entries.push(...parseMaidSkillText(text, { ...options, fileName }).map(entry => ({ ...entry, key: `${index}:${entry.key}` })));
    } catch (error) { entries.push({ key: `${index}:error`, fileName, error: error.code || 'skill_import_read_failed', selected: false, skill: null, issues: [] }); }
  }
  return deduplicatePreview(entries);
};

export const commitMaidSkillImport = async (store, entries, { enabled = true } = {}) => {
  await store.ready;
  const existing = store.list(), usedNames = new Set();
  const selected = entries.filter(entry => entry.selected && entry.action !== 'skip');
  if (!selected.length) throw skillError('skill_import_empty');
  const targets = new Set();
  const writes = selected.map(entry => {
    if (entry.error || !entry.skill) throw skillError(entry.error || 'skill_import_invalid_package');
    if (entry.issues.some(issue => issue.requiresTextOnly) && !entry.textOnlyAccepted) throw skillError('skill_import_review_required');
    const skill = skillClone(entry.skill), options = { source: { kind: 'import', fileName: entry.fileName } };
    skill.enabled = Boolean(enabled);
    if (entry.action === 'replace') {
      const target = existing.find(item => item.id === entry.targetId && item.kind !== 'builtin');
      if (!target || targets.has(target.id)) throw skillError('skill_import_target_invalid');
      targets.add(target.id); options.id = target.id; options.expectedRevision = entry.expectedRevision;
      skill.name = target.name;
    } else {
      skill.name = uniqueName(skill.name, existing, usedNames);
      usedNames.add(skill.name);
    }
    return { skill: normalizeMaidSkillDraft(skill), options };
  });
  return store.importEntries(writes);
};

export const exportMaidSkillMarkdown = skill => {
  const value = portable(skill);
  const header = skillClone(value.portableMetadata.frontmatter || {});
  header.name = value.name; header.description = value.description;
  header.metadata = { ...(skillObject(header.metadata) ? header.metadata : {}), 'omnitavern-title': value.title, 'omnitavern-invocation-mode': value.invocationMode, 'omnitavern-feature-ids': JSON.stringify(value.featureIds) };
  if (header['disable-model-invocation'] !== undefined) header['disable-model-invocation'] = value.invocationMode === 'manual';
  return { fileName: `${value.name}.md`, mime: 'text/markdown;charset=utf-8', text: `---\n${stringify(header, { lineWidth: 0 })}---\n${value.content}` };
};

export const exportMaidSkillPackage = skills => {
  if (skills.length > MAID_SKILL_LIMITS.count) throw skillError('skill_count_limit');
  const text = JSON.stringify({ format: MAID_SKILL_PACKAGE_FORMAT, version: 1, skills: skills.map(portable) });
  if (skillBytes(text) > MAID_SKILL_LIMITS.bytes) throw skillError('skill_import_size_limit');
  return { fileName: 'maid-skills.omni-skills.json', mime: 'application/json;charset=utf-8', text };
};
