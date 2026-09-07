// 跳房子板（Hopscotch Board）纯契约：规范化、校验、默认板推导、编译为泳道任务。
// 见 Unfinished_Plans/创意写作Agent跳房子编排计划.md §3–§5。本模块无 DOM、无存储、无运行时副作用。

import { t, translateUiText } from '../../i18n/index.js';

export const HOPSCOTCH_BOARD_VERSION = 2;

export const HOPSCOTCH_HOUSE_KINDS = Object.freeze({
  body: 'body',
  memoryTable: 'memory_table',
  summaryCompaction: 'summary_compaction',
  formatReview: 'format_review',
  imageGeneration: 'image_generation',
  imagePrompt: 'image_prompt',
  variable: 'variable',
  variableRules: 'variable_rules',
  customPrompt: 'custom_prompt',
});

export const HOPSCOTCH_FUSED_KINDS = Object.freeze(['memory_table', 'image_prompt', 'variable']);

// position：anchor = 正文；post = 只能在正文之后的行；any = 正文前后皆可（含与正文同行）
export const HOPSCOTCH_HOUSE_CATALOG = Object.freeze([
  { kind: 'body', label: '正文生成', icon: 'bolt', position: 'anchor', unique: true },
  { kind: 'memory_table', label: '记忆表格', icon: 'table', position: 'post', unique: true, fusable: true },
  { kind: 'image_prompt', label: '图片提示', icon: 'image', position: 'post', unique: true, fusable: true },
  { kind: 'variable', label: '变量更新', icon: 'sliders', position: 'post', unique: true, fusable: true },
  { kind: 'variable_rules', label: '变量规则', icon: 'sliders', position: 'phase', unique: false },
  { kind: 'summary_compaction', label: '摘要压缩', icon: 'compress', position: 'post', unique: true },
  { kind: 'format_review', label: '格式复核', icon: 'check', position: 'post', unique: true },
  { kind: 'image_generation', label: '图片生成', icon: 'image', position: 'post', unique: true },
  { kind: 'custom_prompt', label: '自定义提示词', icon: 'spark', position: 'any', unique: false },
]);

export const HOPSCOTCH_LIMITS = Object.freeze({
  maxRows: 6,
  maxHousesPerRow: 4,
  maxCustomHouses: 8,
  minConcurrency: 1,
  maxConcurrency: 4,
});

export const HOPSCOTCH_DEFAULT_POLICY = Object.freeze({
  rowConcurrencyMax: 3,
  onHouseFailure: 'continue',
  houseTimeoutMs: 240000,
});

export const HOPSCOTCH_CUSTOM_HOUSE_DEFAULTS = Object.freeze({
  prompt: '',
  systemPrompt: '',
  modelMode: 'follow_current',
  modelProfileId: '',
  modelOverride: '',
  includeContext: 'recent',
  recentMessageCount: 8,
  contextTokenBudget: 2000,
  output: Object.freeze({ mode: 'context', injectIntoBody: false }),
  maxTokens: 512,
  timeoutMs: 60000,
});

const KIND_SET = new Set(HOPSCOTCH_HOUSE_CATALOG.map(item => item.kind));
const FUSED_SET = new Set(HOPSCOTCH_FUSED_KINDS);
const CATALOG_BY_KIND = new Map(HOPSCOTCH_HOUSE_CATALOG.map(item => [item.kind, item]));

const trim = value => String(value ?? '').trim();
const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const toInt = (value, fallback) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
};
const clampInt = (value, fallback, min, max) => Math.max(min, Math.min(max, toInt(value, fallback)));
const uniqueStrings = list => Array.from(new Set((Array.isArray(list) ? list : []).map(trim).filter(Boolean)));

export const normalizeCustomHouseConfig = (config = {}) => {
  const src = isPlainObject(config) ? config : {};
  const d = HOPSCOTCH_CUSTOM_HOUSE_DEFAULTS;
  const modelMode = trim(src.modelMode) === 'profile' ? 'profile' : 'follow_current';
  const includeContextRaw = trim(src.includeContext);
  const includeContext = includeContextRaw === 'none' || includeContextRaw === 'full' ? includeContextRaw : 'recent';
  const outputSrc = isPlainObject(src.output) ? src.output : {};
  const outputMode = trim(outputSrc.mode) === 'note' ? 'note' : 'context';
  return {
    prompt: String(src.prompt ?? d.prompt),
    systemPrompt: String(src.systemPrompt ?? d.systemPrompt),
    modelMode,
    modelProfileId: modelMode === 'profile' ? trim(src.modelProfileId) : '',
    modelOverride: modelMode === 'profile' ? trim(src.modelOverride) : '',
    includeContext,
    recentMessageCount: clampInt(src.recentMessageCount, d.recentMessageCount, 1, 50),
    contextTokenBudget: clampInt(src.contextTokenBudget, d.contextTokenBudget, 100, 32000),
    output: {
      mode: outputMode,
      injectIntoBody: outputMode === 'context' && outputSrc.injectIntoBody === true,
    },
    maxTokens: clampInt(src.maxTokens, d.maxTokens, 16, 8192),
    timeoutMs: clampInt(src.timeoutMs, d.timeoutMs, 1000, 600000),
  };
};

const normalizeHouse = (house = {}, rowIndex = 0, houseIndex = 0, allocateMemberId = value => value) => {
  const src = isPlainObject(house) ? house : {};
  const kind = trim(src.kind);
  const id = trim(src.id) || (kind === 'body' ? 'body' : `h_${rowIndex + 1}_${houseIndex + 1}`);
  const out = {
    id,
    kind,
    label: trim(src.label) || CATALOG_BY_KIND.get(kind)?.label || kind || t('未知房子'),
    enabled: src.enabled !== false,
  };
  if (kind === 'body') {
    out.fused = uniqueStrings(src.fused);
    out.fusedEnabled = Object.fromEntries(out.fused.map(kind => [kind, (src.fusedEnabled?.[kind] ?? src.fusedMembers?.[kind]?.enabled) !== false]));
    out.fusedMembers = Object.fromEntries(out.fused.map(memberKind => [memberKind, normalizeHouse({
      ...src.fusedMembers?.[memberKind], id: src.fusedMembers?.[memberKind]?.id || allocateMemberId(`${id}__${memberKind}`),
      kind: memberKind, enabled: out.fusedEnabled[memberKind],
    }, rowIndex, houseIndex)]));
  }
  if (kind === 'custom_prompt') out.config = normalizeCustomHouseConfig(src.config);
  if (FUSED_SET.has(kind)) out.config = {
    modelMode: src.config?.modelMode === 'profile' ? 'profile' : 'follow_current',
    modelProfileId: src.config?.modelMode === 'profile' ? trim(src.config.modelProfileId) : '',
    modelOverride: trim(src.config?.modelOverride),
  };
  if (kind === 'variable_rules') out.config = { phase: src.config?.phase === 'before' ? 'before' : 'after' };
  return out;
};

export const normalizeHopscotchBoard = (board = {}) => {
  const src = isPlainObject(board) ? board : {};
  const policySrc = isPlainObject(src.policy) ? src.policy : {};
  const claimedIds = new Set((Array.isArray(src.rows) ? src.rows : []).flatMap((row, ri) => (Array.isArray(row?.houses) ? row.houses : []).flatMap((house, hi) => [trim(house?.id) || (house?.kind === 'body' ? 'body' : `h_${ri + 1}_${hi + 1}`), ...Object.values(house?.fusedMembers || {}).map(member => trim(member?.id))])));
  const allocateMemberId = base => { let id = base, suffix = 1; while (claimedIds.has(id)) id = `${base}_${suffix++}`; claimedIds.add(id); return id; };
  const rows = (Array.isArray(src.rows) ? src.rows : [])
    .map((row, rowIndex) => {
      const rowSrc = isPlainObject(row) ? row : {};
      return {
        id: trim(rowSrc.id) || `r${rowIndex + 1}`,
        houses: (Array.isArray(rowSrc.houses) ? rowSrc.houses : [])
          .map((house, houseIndex) => normalizeHouse(house, rowIndex, houseIndex, allocateMemberId)),
      };
    })
    // 编辑器的空落点不算执行行（§5.3）
    .filter(row => row.houses.length > 0);
  return {
    version: Number(src.version) === 1 ? HOPSCOTCH_BOARD_VERSION : toInt(src.version, HOPSCOTCH_BOARD_VERSION),
    id: trim(src.id) || 'board_default',
    name: trim(src.name) || '默认',
    source: trim(src.source) === 'user' ? 'user' : 'builtin-default',
    updatedAt: Math.max(0, toInt(src.updatedAt, 0)),
    rows,
    policy: {
      rowConcurrencyMax: toInt(policySrc.rowConcurrencyMax, HOPSCOTCH_DEFAULT_POLICY.rowConcurrencyMax),
      onHouseFailure: trim(policySrc.onHouseFailure) === 'stop_following_rows' ? 'stop_following_rows' : 'continue',
      houseTimeoutMs: toInt(policySrc.houseTimeoutMs, HOPSCOTCH_DEFAULT_POLICY.houseTimeoutMs),
      ...(policySrc.tableSummaryMaintenance === true ? { tableSummaryMaintenance: true } : {}),
      ...(Array.isArray(policySrc.variableRuleExclusions) && policySrc.variableRuleExclusions.length ? { variableRuleExclusions: uniqueStrings(policySrc.variableRuleExclusions).filter(phase => phase === 'before' || phase === 'after') } : {}),
    },
  };
};

const HOUSE_REF_RE = /\{\{\s*house:([A-Za-z0-9_\-]+)\s*\}\}/g;
const BODY_REF_RE = /\{\{\s*body\s*\}\}/;

export const extractHouseReferences = (text = '') => {
  const out = [];
  const source = String(text ?? '');
  let match;
  HOUSE_REF_RE.lastIndex = 0;
  while ((match = HOUSE_REF_RE.exec(source))) out.push(match[1]);
  return out;
};

export const findBodyRowIndex = (board = {}) => {
  const rows = Array.isArray(board?.rows) ? board.rows : [];
  return rows.findIndex(row => (row?.houses || []).some(house => house?.kind === 'body'));
};

// 原生模型规则是真实的独立请求。旧板的变量开关承接到对应触发阶段，读取时仅作投影。
export const projectHopscotchVariableRules = (input, activity) => {
  const board = normalizeHopscotchBoard(input);
  const houses = board.rows.flatMap(row => row.houses), body = houses.find(h => h.kind === 'body');
  if (!body || !activity?.rulePhases?.length) return board;
  const variable = houses.find(h => h.kind === 'variable');
  if (!body.fused.includes('variable') && !variable && !houses.some(h => h.kind === 'variable_rules')) return board;
  const enabled = variable ? variable.enabled : body.fusedEnabled.variable !== false;
  for (const phase of activity.rulePhases) {
    if (board.policy.variableRuleExclusions?.includes(phase)) continue;
    if (houses.some(h => h.kind === 'variable_rules' && h.config.phase === phase)) continue;
    const bodyIndex = findBodyRowIndex(board);
    const variableIndex = board.rows.findIndex(row => row.houses.includes(variable));
    const index = phase === 'before' ? bodyIndex : Math.max(bodyIndex, variableIndex) + 1;
    const base = `${body.id}__rules_${phase}`;
    let id = base, suffix = 1;
    while (houses.some(h => h.id === id) || board.rows.some(row => row.id === `r_${id}`)) id = `${base}_${suffix++}`;
    board.rows.splice(index, 0, { id: `r_${id}`, houses: [{ id, kind: 'variable_rules', enabled, config: { phase } }] });
  }
  // 保留兼容变量格，切到有内联协议的角色时可恢复；原生规则的请求由独立房子承担。
  return normalizeHopscotchBoard(board);
};

// 房子的主产物可已交付，内部维护仍在运行或失败；仅用于呈现，不改写交付终态。
export const getHopscotchHouseDisplayStatus = (state = {}) => {
  if (state.status !== 'succeeded') return state.status;
  if (state.childResults?.some(child => child.status === 'running')) return 'running';
  if (state.childResults?.some(child => child.status === 'failed')) return 'partial';
  if (state.childResults?.some(child => child.status === 'cancelled')) return 'cancelled';
  return state.status;
};

// 返回 { ok, errors:[{ code, houseId?, rowId?, field?, message }] }；不抛异常，不静默修正。
export const validateHopscotchBoard = (input = {}) => {
  const board = normalizeHopscotchBoard(input);
  const errors = [];
  const push = (code, message, extra = {}) => errors.push({ code, message, ...extra });

  if (board.version !== HOPSCOTCH_BOARD_VERSION) {
    push('unsupported_version', t('不支持的板版本 {value}', { value: board.version }), { field: 'version' });
  }
  if (!board.rows.length) push('empty_board', t('板至少需要一行'));
  if (board.rows.filter(row => row.houses.some(h => h.kind !== 'variable_rules')).length > HOPSCOTCH_LIMITS.maxRows || board.rows.length > HOPSCOTCH_LIMITS.maxRows + 2) {
    push('too_many_rows', t('行数超过上限 {value}', { value: HOPSCOTCH_LIMITS.maxRows }), { field: 'rows' });
  }
  if (board.policy.rowConcurrencyMax < HOPSCOTCH_LIMITS.minConcurrency || board.policy.rowConcurrencyMax > HOPSCOTCH_LIMITS.maxConcurrency) {
    push('invalid_concurrency', t('并发数须为 {value}–{value2} 的整数', { value: HOPSCOTCH_LIMITS.minConcurrency, value2: HOPSCOTCH_LIMITS.maxConcurrency }), { field: 'policy.rowConcurrencyMax' });
  }
  if (board.policy.houseTimeoutMs <= 0) push('invalid_timeout', t('房子超时须为正数'), { field: 'policy.houseTimeoutMs' });

  const seenIds = new Set();
  const seenRowIds = new Set();
  const kindCount = new Map();
  const houseRow = new Map(); // houseId -> rowIndex
  const houseById = new Map();
  let bodyHouse = null;
  let bodyRowIndex = -1;
  let customCount = 0;

  board.rows.forEach((row, rowIndex) => {
    if (seenRowIds.has(row.id)) push('duplicate_row_id', t('行 ID 重复：{value}', { value: row.id }), { rowId: row.id });
    seenRowIds.add(row.id);
    if (row.houses.length > HOPSCOTCH_LIMITS.maxHousesPerRow) {
      push('too_many_houses', t('第 {value} 行房子数超过上限 {value2}', { value: rowIndex + 1, value2: HOPSCOTCH_LIMITS.maxHousesPerRow }), { rowId: row.id });
    }
    row.houses.forEach((house) => {
      if (seenIds.has(house.id)) push('duplicate_house_id', t('房子 ID 重复：{value}', { value: house.id }), { houseId: house.id });
      seenIds.add(house.id);
      houseRow.set(house.id, rowIndex);
      houseById.set(house.id, house);
      if (!KIND_SET.has(house.kind)) {
        push('unknown_house_kind', t('未知房子类型：{value}', { value: house.kind || '(空)' }), { houseId: house.id, field: 'kind' });
        return;
      }
      kindCount.set(house.kind, (kindCount.get(house.kind) || 0) + 1);
      if (house.kind === 'body') {
        if (!house.enabled) push('body_required', t('正文生成需保持启用'), { houseId: house.id, field: 'enabled' });
        if (bodyHouse) push('multiple_body', t('正文房子只能有一个'), { houseId: house.id });
        bodyHouse = house;
        bodyRowIndex = rowIndex;
        for (const member of Object.values(house.fusedMembers || {})) {
          if (seenIds.has(member.id)) push('duplicate_house_id', t('房子 ID 重复：{value}', { value: member.id }), { houseId: member.id });
          seenIds.add(member.id);
        }
      }
      if (house.kind === 'custom_prompt') customCount += 1;
    });
  });

  if (!bodyHouse) push('missing_body', t('板必须包含一个正文房子'));
  if (customCount > HOPSCOTCH_LIMITS.maxCustomHouses) {
    push('too_many_custom', t('自定义房子超过上限 {value}', { value: HOPSCOTCH_LIMITS.maxCustomHouses }));
  }
  HOPSCOTCH_HOUSE_CATALOG.forEach((item) => {
    if (item.unique && (kindCount.get(item.kind) || 0) > 1) {
      push('duplicate_builtin', t('内建房子「{value}」每板最多一个', { value: translateUiText(item.label) }), { field: item.kind });
    }
  });

  if (bodyHouse) {
    // 融合白名单与互斥
    bodyHouse.fused.forEach((fused) => {
      if (!FUSED_SET.has(fused)) push('invalid_fused', t('正文不能融合「{value}」', { value: fused }), { houseId: bodyHouse.id, field: 'fused' });
    });
    for (const kind of HOPSCOTCH_FUSED_KINDS) if (bodyHouse.fused.includes(kind) && (kindCount.get(kind) || 0) > 0) {
      push(kind === 'memory_table' ? 'memory_fused_and_standalone' : 'fused_and_standalone', t('「{value}」已在正文融合组中', { value: CATALOG_BY_KIND.get(kind)?.label || kind }), { field: kind });
    }
    // 位置约束
    let memoryRow = -1;
    let compactionRow = -1;
    let imageRow = -1;
    board.rows.forEach((row, rowIndex) => {
      row.houses.forEach((house) => {
        if (house.kind === 'body') return;
        if (house.kind === 'variable_rules' && house.config.phase === 'before') {
          if (rowIndex >= bodyRowIndex) push('rules_before_body', t('发送前变量规则须位于正文之前'), { houseId: house.id });
        } else if (house.kind !== 'custom_prompt' && house.kind !== 'body') {
          if (rowIndex <= bodyRowIndex) {
            push('builtin_before_body', t('「{value}」必须位于正文之后的行', { value: translateUiText(house.label) }), { houseId: house.id, rowId: row.id });
          }
        }
        if (house.kind === 'memory_table') memoryRow = rowIndex;
        if (house.kind === 'summary_compaction') compactionRow = rowIndex;
        if (house.kind === 'image_generation') imageRow = rowIndex;
      });
    });
    if (memoryRow >= 0 && compactionRow >= 0 && compactionRow <= memoryRow) {
      push('compaction_not_after_memory', t('摘要压缩必须位于独立记忆表格之后的行'), { field: 'summary_compaction' });
    }
    const promptRow = board.rows.findIndex(row => row.houses.some(h => h.kind === 'image_prompt'));
    if (imageRow >= 0 && !bodyHouse.fused.includes('image_prompt') && promptRow < 0) {
      push('image_without_prompt', t('图片生成需要位于前方的图片提示'), { field: 'image_generation' });
    }
    if (imageRow >= 0 && promptRow >= imageRow) push('image_prompt_not_earlier', t('图片提示须位于图片生成之前'), { field: 'image_generation' });
    for (const phase of ['before', 'after']) {
      if (board.rows.flatMap(row => row.houses).filter(h => h.kind === 'variable_rules' && h.config.phase === phase).length > 1) push('duplicate_variable_phase', t('同阶段的变量规则只需一个房子'), { field: 'variable_rules' });
    }
    const variableRow = board.rows.findIndex(row => row.houses.some(h => h.kind === 'variable'));
    const rulesRow = board.rows.findIndex(row => row.houses.some(h => h.kind === 'variable_rules' && h.config.phase === 'after'));
    if (variableRow >= 0 && rulesRow >= 0 && variableRow >= rulesRow) push('variable_write_order', t('变量规则须位于变量更新之后'), { field: 'variable_rules' });
    // 正文之外不能有 fused（normalize 已剥离，但原始输入若带 fused 需报错）
    const rawRows = Array.isArray(input?.rows) ? input.rows : [];
    rawRows.forEach((row) => {
      (row?.houses || []).forEach((house) => {
        if (house && house.kind !== 'body' && Array.isArray(house.fused) && house.fused.length) {
          push('fused_outside_body', t('只有正文可以带 fused：{value}', { value: trim(house.id) || house.kind }), { houseId: trim(house.id) });
        }
      });
    });
  }

  // 自定义房子引用与注入约束
  board.rows.forEach((row, rowIndex) => {
    row.houses.forEach((house) => {
      if (house.kind !== 'custom_prompt') return;
      const cfg = house.config;
      const texts = [['prompt', cfg.prompt], ['systemPrompt', cfg.systemPrompt]];
      texts.forEach(([field, text]) => {
        if (BODY_REF_RE.test(text) && (bodyRowIndex < 0 || rowIndex <= bodyRowIndex)) {
          push('body_ref_before_body', t('「{value}」的 {value2} 引用了 {value3}，但它不在正文之后的行', { value: translateUiText(house.label), value2: field, value3: '{{body}}' }), { houseId: house.id, field });
        }
        extractHouseReferences(text).forEach((refId) => {
          const target = houseById.get(refId);
          if (!target) {
            push('unknown_house_ref', t('「{value}」引用了不存在的房子 {value2}', { value: translateUiText(house.label), value2: refId }), { houseId: house.id, field });
            return;
          }
          const targetRow = houseRow.get(refId);
          if (targetRow >= rowIndex) {
            push('house_ref_not_earlier', t('「{value}」只能引用更早行的房子（{value2}）', { value: translateUiText(house.label), value2: refId }), { houseId: house.id, field });
          }
          if (target.kind !== 'custom_prompt' || target.config?.output?.mode !== 'context') {
            push('house_ref_not_context', t('被引用的房子 {value} 不是 context 产物', { value: refId }), { houseId: house.id, field });
          }
        });
      });
      if (cfg.output.injectIntoBody && bodyRowIndex >= 0 && rowIndex >= bodyRowIndex) {
        push('inject_not_pre_body', t('「{value}」开启了注入正文，但它不在正文之前的行', { value: translateUiText(house.label) }), { houseId: house.id, field: 'output.injectIntoBody' });
      }
      if (cfg.modelMode === 'profile' && !cfg.modelProfileId) {
        push('missing_model_profile', t('「{value}」选择了指定模型档但未填写', { value: translateUiText(house.label) }), { houseId: house.id, field: 'modelProfileId' });
      }
    });
  });

  return { ok: errors.length === 0, errors, board };
};

// 从已按聊天/写作作用域解析的设置推导板；聊天板只作现有流程的设置投影。
export const buildDefaultHopscotchBoard = (resolved = {}) => {
  const src = isPlainObject(resolved) ? resolved : {};
  const memory = isPlainObject(src.memory) ? src.memory : {};
  const replyCheck = isPlainObject(src.replyCheck) ? src.replyCheck : {};
  const autoImage = isPlainObject(src.autoImage) ? src.autoImage : {};
  const variables = isPlainObject(src.variables) ? src.variables : {};

  const storageMode = trim(memory.storageMode) || 'off';
  const tableAutoExtract = storageMode === 'table' && memory.autoExtract === true && memory.placeEnabled !== false && memory.writingEnabled !== false;
  const extractMode = trim(memory.autoExtractMode) === 'separate' ? 'separate' : 'inline';
  // 表格的内部摘要维护不是第二种记忆模式，不在默认板重复展开成摘要房。
  const compactionEnabled = storageMode === 'summary';
  const reviewEnabled = src.place === 'chat' && replyCheck.enabled === true
    && (trim(replyCheck.triggerMode) || 'auto') === 'auto'
    && (trim(replyCheck.modelMode) || 'none') !== 'none';
  const imageEnabled = autoImage.enabled === true;
  const variablesEnabled = variables.enabled === true;

  const fused = [];
  if (tableAutoExtract && extractMode === 'inline') fused.push('memory_table');
  if (imageEnabled) fused.push('image_prompt');
  // 变量格固定保留，实际可用性由当前角色/会话能力投影；空角色也能看见停用原因。
  if (variablesEnabled || src.variables?.activity) fused.push('variable');

  const rows = [{ id: 'r_body', houses: [{ id: 'body', kind: 'body', fused }] }];
  const post = [];
  if (imageEnabled) post.push({ id: 'image', kind: 'image_generation' });
  if (tableAutoExtract && extractMode === 'separate') post.push({ id: 'memory', kind: 'memory_table' });
  if (reviewEnabled) post.push({ id: 'review', kind: 'format_review' });
  if (post.length) rows.push({ id: 'r_post', houses: post });
  if (compactionEnabled) {
    if (!post.length) rows.push({ id: 'r_compact', houses: [{ id: 'compaction', kind: 'summary_compaction' }] });
    else rows[rows.length - 1].houses.push({ id: 'compaction', kind: 'summary_compaction' });
  }

  return projectHopscotchVariableRules({
    version: HOPSCOTCH_BOARD_VERSION,
    id: 'board_builtin_default',
    name: '默认',
    source: 'builtin-default',
    rows,
    policy: { ...HOPSCOTCH_DEFAULT_POLICY, ...(tableAutoExtract ? { tableSummaryMaintenance: true } : {}) },
  }, variables.activity);
};

// 编译为泳道投影（lanes/tasks）。胶水 input/context 保留为细条；房子 task.id = house.id；
// timeBucket/phaseIndex = 2 + rowIndex；dependsOn 指向上一行全部房子（首行指向 context）。
export const compileBoardToLaneTasks = (input = {}) => {
  const board = normalizeHopscotchBoard(input);
  const lanes = [
    { id: 'request', label: '请求', shortLabel: '请求', icon: 'spark', glue: true },
    { id: 'context', label: '上下文', shortLabel: '上下文', icon: 'book', glue: true },
  ];
  const tasks = [
    { id: 'input', laneId: 'request', label: '请求入列', brief: '整理输入、附件与续写目标', timeBucket: 0, phaseIndex: 0, dependsOn: [], glue: true },
    { id: 'context', laneId: 'context', label: '上下文组装', brief: '收集聊天、世界书、记忆和变量', timeBucket: 1, phaseIndex: 1, dependsOn: ['input'], glue: true },
  ];
  let previousRowIds = ['context'];
  board.rows.forEach((row, rowIndex) => {
    const bucket = 2 + rowIndex;
    const currentIds = [];
    row.houses.forEach((house) => {
      const meta = CATALOG_BY_KIND.get(house.kind) || {};
      lanes.push({ id: house.id, label: house.label, shortLabel: house.label.slice(0, 4), icon: meta.icon || 'spark' });
      tasks.push({
        id: house.id,
        laneId: house.id,
        label: house.label,
        brief: meta.label ? `${meta.label}` : house.kind,
        timeBucket: bucket,
        phaseIndex: bucket,
        dependsOn: previousRowIds.slice(),
        detail: {
          kind: house.kind,
          rowId: row.id,
          rowIndex,
          ...(house.kind === 'body' ? { fused: house.fused.slice() } : {}),
        },
      });
      currentIds.push(house.id);
    });
    previousRowIds = currentIds;
  });
  return { lanes, tasks };
};
