import { splitDanglingBlockTail } from '../../utils/dangling-block-utils.js';
import { parseTableEditActions } from '../../memory/memory-edit-parser.js';

export const FORMAT_FUNCTION_BLOCK_KINDS = Object.freeze({
  imagePrompt: 'image_prompt',
  updateVariable: 'update_variable',
  tableEdit: 'table_edit',
});

const FUNCTION_TAG_RE = /<\s*(\/?)\s*(image_prompt|tableEdit|update(?:variable)?|variableupdate)\b[^>]*>/gi;

const normalizeTagKind = value => {
  const tag = String(value ?? '').trim().toLowerCase();
  if (tag === 'image_prompt') return FORMAT_FUNCTION_BLOCK_KINDS.imagePrompt;
  if (tag === 'tableedit') return FORMAT_FUNCTION_BLOCK_KINDS.tableEdit;
  if (['update', 'updatevariable', 'variableupdate'].includes(tag)) {
    return FORMAT_FUNCTION_BLOCK_KINDS.updateVariable;
  }
  return '';
};

const cloneTagScanner = () => new RegExp(FUNCTION_TAG_RE.source, FUNCTION_TAG_RE.flags);

const findNextTag = (source, from) => {
  const scanner = cloneTagScanner();
  scanner.lastIndex = Math.max(0, from);
  const match = scanner.exec(source);
  if (!match) return null;
  return {
    match,
    start: match.index,
    end: match.index + match[0].length,
    closing: Boolean(match[1]),
    tagName: String(match[2] || ''),
    kind: normalizeTagKind(match[2]),
  };
};

const findCloseForOpen = (source, open) => {
  let cursor = open.end;
  while (cursor < source.length) {
    const next = findNextTag(source, cursor);
    if (!next) return null;
    if (!next.closing) return null;
    if (
      next.kind === open.kind &&
      (
        open.kind !== FORMAT_FUNCTION_BLOCK_KINDS.updateVariable ||
        next.tagName.toLowerCase() === open.tagName.toLowerCase()
      )
    ) {
      return next;
    }
    cursor = next.end;
  }
  return null;
};

const resolveDanglingPayload = (source, open) => {
  const tail = source.slice(open.end);
  if (open.kind === FORMAT_FUNCTION_BLOCK_KINDS.imagePrompt) {
    const nextTag = findNextTag(source, open.end);
    return nextTag ? source.slice(open.end, nextTag.start) : tail;
  }
  const { block } = splitDanglingBlockTail(tail);
  return block || '';
};

export const extractFormatFunctionBlocks = (text = '') => {
  const source = String(text ?? '');
  const blocks = [];
  const ordinals = new Map();
  let cursor = 0;
  while (cursor < source.length) {
    const open = findNextTag(source, cursor);
    if (!open) break;
    cursor = open.end;
    if (open.closing || !open.kind) continue;
    const close = findCloseForOpen(source, open);
    const payload = close
      ? source.slice(open.end, close.start)
      : resolveDanglingPayload(source, open);
    const end = close ? close.end : open.end + payload.length;
    const ordinal = (ordinals.get(open.kind) || 0) + 1;
    ordinals.set(open.kind, ordinal);
    blocks.push({
      kind: open.kind,
      ordinal,
      identity: `${open.kind}:${ordinal}`,
      valid: Boolean(close),
      start: open.start,
      end,
      openTag: open.match[0],
      closeTag: close?.match?.[0] || '',
      payload,
      raw: source.slice(open.start, end),
    });
    cursor = Math.max(cursor, end);
  }
  return blocks;
};

const groupBlocksByIdentity = blocks => new Map(
  blocks.map(block => [block.identity, block]),
);

const isPayloadAlreadyPresent = (source, payload) => {
  const value = String(payload ?? '');
  return Boolean(value) && String(source ?? '').includes(value);
};

const isStructureOnlyPayloadMatch = (before, after) => {
  if (!before || !after) return false;
  if (before.payload === after.payload) return true;
  if (before.valid || !after.valid) return false;
  const suffix = after.payload.slice(before.payload.length);
  return after.payload.startsWith(before.payload) && /^(?:\r\n|\r|\n)$/.test(suffix);
};

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
// The table parser can already have accepted part of a malformed block. Only
// newly readable operations may execute; existing operations stay in order.
export const diffRepairedTableActions = (before, after) => {
  const previous = parseTableEditActions(before), next = parseTableEditActions(after);
  let cursor = 0; const added = [];
  for (const action of next) {
    if (cursor < previous.length && canonical(action) === canonical(previous[cursor])) {
      if (added.length) return { ok: false, added: [], previous, next };
      cursor++;
    }
    else added.push(action);
  }
  return { ok: cursor === previous.length && next.length > 0, added, previous, next };
};

export const validateFormatRepairFunctionPayloads = ({
  originalText = '',
  candidateText = '',
  allowedTableRanges = [],
} = {}) => {
  const beforeBlocks = extractFormatFunctionBlocks(originalText);
  const afterBlocks = extractFormatFunctionBlocks(candidateText);
  const beforeByIdentity = groupBlocksByIdentity(beforeBlocks);
  const afterByIdentity = groupBlocksByIdentity(afterBlocks);
  const identities = new Set([...beforeByIdentity.keys(), ...afterByIdentity.keys()]);
  const violations = [];

  identities.forEach((identity) => {
    const before = beforeByIdentity.get(identity) || null;
    const after = afterByIdentity.get(identity) || null;
    if (before && !after) {
      if (before.valid) {
        violations.push({
          code: 'function_block_deleted',
          identity,
          kind: before.kind,
          message: `格式修复不得删除已存在的 ${before.kind} 功能块`,
        });
      }
      return;
    }
    if (!before && after) {
      if (!isPayloadAlreadyPresent(originalText, after.payload)) {
        violations.push({
          code: 'function_payload_added',
          identity,
          kind: after.kind,
          message: `格式修复不得新增 ${after.kind} 功能载荷`,
        });
      }
      return;
    }
    const selectedTable = before?.kind === FORMAT_FUNCTION_BLOCK_KINDS.tableEdit && after?.kind === before.kind
      && allowedTableRanges.some(range => Number.isInteger(range.start) && Number.isInteger(range.end)
        && before.start >= range.start && before.end <= range.end);
    if (selectedTable && before.payload !== after.payload && !diffRepairedTableActions(before.payload, after.payload).ok) {
      violations.push({ code: 'table_operations_changed', identity, kind: after.kind,
        message: '修改改变了已能解析的表格指令，或仍没有有效指令；请重新检查格式' });
    }
    if (before && after && !isStructureOnlyPayloadMatch(before, after) && !selectedTable) {
      violations.push({
        code: 'function_payload_modified',
        identity,
        kind: after.kind,
        message: `格式修复不得修改 ${after.kind} 功能载荷`,
      });
    }
  });

  return {
    ok: violations.length === 0,
    beforeBlocks,
    afterBlocks,
    violations,
  };
};

export const buildFormatFunctionSideEffectPlan = ({
  originalText = '',
  candidateText = '',
} = {}) => {
  const beforeBlocks = extractFormatFunctionBlocks(originalText);
  const afterBlocks = extractFormatFunctionBlocks(candidateText);
  const beforeByIdentity = groupBlocksByIdentity(beforeBlocks);
  const afterByIdentity = groupBlocksByIdentity(afterBlocks);
  const identities = new Set([...beforeByIdentity.keys(), ...afterByIdentity.keys()]);
  const entries = [];

  identities.forEach((identity) => {
    const before = beforeByIdentity.get(identity) || null;
    const after = afterByIdentity.get(identity) || null;
    let action = 'skip';
    let reason = 'not_executable';
    let executionText;
    const changedTable = before && after?.valid && before.kind === FORMAT_FUNCTION_BLOCK_KINDS.tableEdit
      && !isStructureOnlyPayloadMatch(before, after);
    const tableDelta = changedTable ? diffRepairedTableActions(before.payload, after.payload) : null;
    if (before && after && before.raw === after.raw) {
      action = 'reuse';
      reason = 'unchanged';
    } else if (before && after && isStructureOnlyPayloadMatch(before, after) && before.valid && after.valid) {
      action = 'reuse';
      reason = 'structure_only_change';
    } else if (tableDelta?.ok && !tableDelta.added.length) {
      action = 'reuse';
      reason = 'same_table_operations';
    } else if (tableDelta?.ok) {
      action = 'execute'; reason = 'newly_readable_table_operations';
      executionText = `<tableEdit>\n${JSON.stringify(tableDelta.added)}\n</tableEdit>`;
    } else if (after?.valid) {
      action = 'execute';
      reason = before?.valid ? 'changed_valid_block' : 'newly_valid_block';
    } else if (before && !after) {
      reason = 'removed_without_rollback';
    }
    entries.push({
      identity,
      kind: after?.kind || before?.kind || '',
      action,
      reason,
      before,
      after,
      ...(executionText !== undefined ? { executionText } : {}),
    });
  });

  const executeEntries = entries.filter(entry => entry.action === 'execute');
  return {
    beforeBlocks,
    afterBlocks,
    entries,
    executeEntries,
    executeKinds: Array.from(new Set(executeEntries.map(entry => entry.kind))),
    reuseEntries: entries.filter(entry => entry.action === 'reuse'),
  };
};

export const buildFormatFunctionExecutionText = (plan = null, kind = '') => (
  (Array.isArray(plan?.executeEntries) ? plan.executeEntries : [])
    .filter(entry => !kind || entry.kind === kind)
    .map(entry => String(entry?.executionText ?? entry?.after?.raw ?? ''))
    .filter(Boolean)
    .join('\n\n')
);

export const replaceReusedFormatFunctionBlocks = (
  candidateText = '',
  plan = null,
  kind = '',
  resolveReplacement = () => '',
) => {
  let output = String(candidateText ?? '');
  const entries = (Array.isArray(plan?.reuseEntries) ? plan.reuseEntries : [])
    .filter(entry => !kind || entry.kind === kind)
    .filter(entry => entry?.after && Number.isInteger(entry.after.start) && Number.isInteger(entry.after.end))
    .sort((left, right) => right.after.start - left.after.start);
  entries.forEach((entry) => {
    const replacement = String(resolveReplacement(entry) ?? '');
    output = `${output.slice(0, entry.after.start)}${replacement}${output.slice(entry.after.end)}`;
  });
  return output;
};

export const fingerprintFormatFunctionPayload = (value = '') => {
  const source = String(value ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}:${source.length}`;
};

export const buildFormatFunctionExecutionLedger = ({
  plan = null,
  turnId = '',
  messageId = '',
  resultByIdentity = {},
  at = Date.now(),
} = {}) => (
  (Array.isArray(plan?.entries) ? plan.entries : []).map((entry) => {
    const result = resultByIdentity?.[entry.identity] || {};
    const block = entry.after || entry.before || {};
    const defaultStatus = entry.action === 'reuse'
      ? 'reused'
      : (entry.action === 'execute' ? 'pending' : 'skipped');
    return {
      messageId: String(messageId || '').trim(),
      turnId: String(turnId || '').trim(),
      blockKind: String(entry.kind || '').trim(),
      blockIdentity: String(entry.identity || '').trim(),
      payloadFingerprint: fingerprintFormatFunctionPayload(block.payload),
      executionStatus: String(result.status || defaultStatus).trim() || defaultStatus,
      effectResultRef: String(result.effectResultRef || '').trim(),
      at: Number(result.at || at) || Date.now(),
    };
  })
);
