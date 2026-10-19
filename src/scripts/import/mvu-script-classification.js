import { hasZodSchema } from './mvu-schema-parser.js';

// 网址可能带版本或分支：MagVarUpdate@beta/…、MagVarUpdate@1.2.3/…
const MVU_RUNTIME_BOOTSTRAP_RE = /(?:^|\/)MagVarUpdate(?:@[\w.-]+)?\/(?:artifact\/)?bundle(?:\.min)?\.js(?=[?#'"\s);]|$)/i;
const TAVERN_HELPER_LOADER_RE = /\bimport\s+(?:\(\s*)?['"][^'"]*\/(?:酒馆助手|tavern[_-]?helper)\//i;
const TAVERN_BEHAVIOR_RE = /\b(?:eventOn|eventOnButton|replaceScriptButtons|getTavernRegexes|updateTavernRegexes|getLastMessageId|setChatMessages)\s*\(/;

const getScriptContent = (script) => String(script?.content || '');

export const classifyMvuSchemaOnlyScript = (script = {}) => {
  const content = getScriptContent(script);
  if (hasZodSchema(content)) {
    return { schemaOnly: true, reason: 'mvu_schema' };
  }
  if (MVU_RUNTIME_BOOTSTRAP_RE.test(content)) {
    return { schemaOnly: true, reason: 'mvu_runtime' };
  }
  return { schemaOnly: false, reason: '' };
};

export const markMvuSchemaOnlyScripts = (list = []) => (Array.isArray(list) ? list : []).map((item) => {
  if (!item || typeof item !== 'object') return item;
  if (item.type === 'folder' && Array.isArray(item.scripts)) {
    return { ...item, scripts: markMvuSchemaOnlyScripts(item.scripts) };
  }
  if (item.schemaOnly === true) {
    return {
      ...item,
      schemaOnly: true,
      schemaOnlyReason: String(item.schemaOnlyReason || 'source'),
    };
  }
  const classification = classifyMvuSchemaOnlyScript(item);
  if (!classification.schemaOnly) return item;
  return {
    ...item,
    schemaOnly: true,
    schemaOnlyReason: classification.reason,
  };
});

export const shouldRestoreLegacyExecutableScript = (script = {}) => {
  if (!script || typeof script !== 'object') return false;
  if (script.schemaOnly !== true || String(script.source || '') !== 'card') return false;
  if (String(script.schemaOnlyReason || '').trim()) return false;
  if (classifyMvuSchemaOnlyScript(script).schemaOnly) return false;
  const content = getScriptContent(script);
  return TAVERN_BEHAVIOR_RE.test(content) || TAVERN_HELPER_LOADER_RE.test(content);
};
