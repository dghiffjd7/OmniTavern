import { t, translateUiText } from '../../i18n/index.js';
import { getAgentInvocationMode } from '../agent-invocation.js';
import { RECAP_AGENT_ID } from '../recap-agent.js';
import {
  HOPSCOTCH_HOUSE_CATALOG,
  HOPSCOTCH_LIMITS,
  normalizeHopscotchBoard,
  resolveHopscotchBoardMemoryMode,
  validateHopscotchBoard,
} from '../../ui/chat/hopscotch-board-utils.js';
import { findManualHopscotchDependencies, hopscotchInactiveLabel } from '../../ui/chat/hopscotch-activation-utils.js';
import { confirmRequest, resolveNamedTarget } from './preset-regex-script-tools.js';

/* 女仆查看与调整流程板（跳房子）：同一行的房子并行，行与行依序执行。
   读取与回复后实际执行用同一个 resolveBoard；调整只在创意写作（聊天的流程由设定推导、面板也不能存），
   保存照面板：存进当前角色卡或所有角色卡、开启跳房子编排、按板上记忆的形态同步写表方式。
   做法同其他写入工具：冻结目标 → 一次结构化确认 → 执行前复验 → 读回核对。 */

const trim = value => String(value ?? '').trim();
const clone = value => JSON.parse(JSON.stringify(value));
const layoutOf = board => JSON.stringify({ rows: board?.rows || [], policy: board?.policy || {} });
const TARGET_BY_SCOPE = Object.freeze({ card: 'persona', all_cards: 'global' });
const ADDABLE_KINDS = Object.freeze(['memory_table', 'image_prompt', 'variable', 'variable_rules', 'summary_compaction', 'format_review', 'image_generation']);
const CATALOG = new Map(HOPSCOTCH_HOUSE_CATALOG.map(item => [item.kind, item]));

const scopeLabel = scope => (scope === 'all_cards' ? t('所有角色卡的创意写作') : t('当前角色卡的创意写作'));
const sourceLabel = (source, scope) => ({
  persona: t('当前角色卡自己的编排'),
  global: scope === 'all_cards' ? t('所有角色卡共用的编排') : t('跟随所有角色卡的编排'),
  session: t('本会话的编排'),
  derived: t('跟随现有设置自动排出'),
})[source] || source;
const houseLabel = house => translateUiText(trim(house?.label) || CATALOG.get(house?.kind)?.label || house?.kind || '');
const isAllowed = (context = {}) => context?.toolSafety?.decision === 'allow' && context?.toolSafety?.request?.kind === 'flow.update';

const describeBoard = board => (board?.rows || []).map((row, index) => t('第 {row} 行：{houses}', {
  row: index + 1,
  houses: row.houses.map(house => `${houseLabel(house)}${house.enabled === false ? t('（关）') : ''}`).join('、'),
}));

export const createFlowBoardAgentTools = ({
  getRuntime, getBoardStore, getContext, listTextAgents,
  isHopscotchEnabled = () => true, enableHopscotch = () => {}, setMemoryAutoExtractMode = null, onSaved = () => {},
} = {}) => {
  const snapshots = new WeakMap();
  const currentContext = () => {
    const context = getContext?.() || {};
    return { place: context.place === 'writing' ? 'writing' : 'chat', sessionId: trim(context.sessionId) };
  };
  const runtimeOrNull = () => {
    try { return getRuntime?.() || null; } catch { return null; }
  };
  const resolveFor = (runtime, context, scope) => {
    const target = TARGET_BY_SCOPE[scope] || 'persona';
    if (context.place === 'chat') return runtime.resolveBoard(context.sessionId, { place: 'chat' });
    return runtime.resolveBoard(target === 'global' ? '' : context.sessionId, { place: 'writing', scope: target, contextSessionId: context.sessionId });
  };
  const activationFor = (runtime, context, scope, board) => runtime.resolveActivation?.(board, context.sessionId, {
    place: context.place, scope: scope === 'all_cards' ? 'global' : 'effective',
  }) || { houses: {}, fused: {} };
  const textAgentsFor = (context, scope) => (listTextAgents?.(scope === 'all_cards' ? 'global' : 'effective', context) || [])
    .filter(config => config?.kind === 'text_edit');

  const summarizeHouse = (house, activation, agents) => {
    const state = activation.houses?.[house.id] || {};
    const out = { id: house.id, kind: house.kind, label: houseLabel(house), enabled: house.enabled !== false, active: state.enabled !== false };
    if (state.enabled === false && state.reason && state.reason !== 'disabled') out.inactiveReason = hopscotchInactiveLabel(state.reason);
    if (house.kind === 'text_edit') {
      const agent = agents.find(config => config.id === house.config?.agentId);
      Object.assign(out, { agentId: house.config?.agentId, agentEnabled: agent?.enabled === true, invocation: agent ? getAgentInvocationMode(agent) : '' });
      if (!agent) out.inactiveReason = t('找不到这个 Agent');
    }
    if (house.kind === 'variable_rules') out.phase = house.config?.phase;
    if (house.kind === 'body') {
      out.fused = (house.fused || []).map(kind => {
        const member = activation.fused?.[kind] || {};
        return {
          id: house.fusedMembers?.[kind]?.id, kind, label: translateUiText(CATALOG.get(kind)?.label || kind),
          enabled: house.fusedEnabled?.[kind] !== false, active: member.enabled !== false,
          ...(member.enabled === false && member.reason && member.reason !== 'disabled' ? { inactiveReason: hopscotchInactiveLabel(member.reason) } : {}),
        };
      });
    }
    return out;
  };
  const summarizeBoard = (board, activation, agents) => (board?.rows || []).map((row, index) => ({
    row: index + 1, houses: row.houses.map(house => summarizeHouse(house, activation, agents)),
  }));

  // ── flow.read ──
  const readFlow = async (args = {}) => {
    const runtime = runtimeOrNull();
    if (!runtime?.resolveBoard) return { ok: false, reason: 'flow_board_unavailable' };
    const context = currentContext();
    if (!context.sessionId) return { ok: false, reason: 'no_current_session' };
    const scope = args.scope === 'all_cards' ? 'all_cards' : 'card';
    const resolved = resolveFor(runtime, context, scope);
    const agents = textAgentsFor(context, scope);
    const activation = activationFor(runtime, context, scope, resolved.board);
    const placed = new Set((resolved.board?.rows || []).flatMap(row => row.houses).map(house => house.config?.agentId).filter(Boolean));
    const base = {
      ok: true, place: context.place,
      rows: summarizeBoard(resolved.board, activation, agents),
      notOnBoard: agents.filter(config => !placed.has(config.id)).map(config => ({
        id: config.id, title: config.title, enabled: config.enabled === true, invocation: getAgentInvocationMode(config),
      })),
    };
    if (context.place === 'chat') {
      return { ...base, editable: false, source: sourceLabel(resolved.source, scope), note: t('聊天的流程跟着设定自动排出：回复 Agent 设成自动、开启后就会排进去，这里不能手动调整。') };
    }
    return {
      ...base, editable: true, scope, scopeLabel: scopeLabel(scope),
      source: sourceLabel(resolved.source, scope), custom: resolved.source !== 'derived',
      hopscotchEnabled: isHopscotchEnabled() === true,
      addableKinds: ADDABLE_KINDS.map(kind => ({ kind, label: translateUiText(CATALOG.get(kind).label), ...(kind === 'variable_rules' ? { phase: ['before', 'after'] } : {}) })),
      limits: { housesPerRow: HOPSCOTCH_LIMITS.maxHousesPerRow, customHouses: HOPSCOTCH_LIMITS.maxCustomHouses },
    };
  };

  // ── flow.update ──
  const findHouse = (board, query) => {
    const text = trim(query);
    const entries = [];
    board.rows.forEach((row, rowIndex) => row.houses.forEach((house, index) => {
      entries.push({ id: house.id, name: houseLabel(house), house, rowIndex, index });
      if (house.kind === 'body') {
        Object.entries(house.fusedMembers || {}).forEach(([kind, member]) => entries.push({
          id: member.id, name: translateUiText(CATALOG.get(kind)?.label || kind), house: member, rowIndex, fusedKind: kind, body: house,
        }));
      }
    }));
    const byAgent = entries.filter(entry => entry.house.kind === 'text_edit' && trim(entry.house.config?.agentId) === text);
    if (byAgent.length === 1) return { item: byAgent[0] };
    return resolveNamedTarget(entries, text);
  };
  const uniqueHouseId = (board, base) => {
    const used = new Set(board.rows.flatMap(row => row.houses.flatMap(house => [house.id, ...Object.values(house.fusedMembers || {}).map(member => member.id)])));
    let id = trim(base).replace(/[^A-Za-z0-9_-]/g, '-') || 'house';
    for (let suffix = 2; used.has(id); suffix += 1) id = `${trim(base).replace(/[^A-Za-z0-9_-]/g, '-')}_${suffix}`;
    return id;
  };
  // row 从 1 起算，指操作当下的板；newRow 在该位置插入新的一行，否则放进那一行。都没给就放在最后的新一行
  const insertHouse = (board, house, { row, newRow } = {}) => {
    const rowCount = board.rows.length;
    if (row === undefined) { board.rows.push({ id: uniqueRowId(board), houses: [house] }); return ''; }
    const at = Math.trunc(Number(row)) - 1;
    if (newRow) {
      if (at < 0 || at > rowCount) return 'row_out_of_range';
      board.rows.splice(at, 0, { id: uniqueRowId(board), houses: [house] });
      return '';
    }
    if (at < 0 || at >= rowCount) return 'row_out_of_range';
    if (board.rows[at].houses.length >= HOPSCOTCH_LIMITS.maxHousesPerRow) return 'row_full';
    board.rows[at].houses.push(house);
    return '';
  };
  const uniqueRowId = board => {
    const used = new Set(board.rows.map(row => row.id));
    let index = board.rows.length + 1;
    while (used.has(`r_${index}`)) index += 1;
    return `r_${index}`;
  };
  const rowText = (row, newRow) => (row === undefined ? t('最后新的一行') : newRow ? t('第 {row} 行（新的一行）', { row }) : t('第 {row} 行', { row }));

  const applyOperation = (board, op, agents) => {
    if (op.op === 'add') {
      if (Boolean(trim(op.agent)) === Boolean(trim(op.kind))) return { error: 'agent_or_kind_required' };
      let house;
      if (trim(op.agent)) {
        const found = resolveNamedTarget(agents, op.agent, { nameOf: config => config.title });
        if (found.error) return { error: `agent_${found.error}`, ...(found.candidates ? { candidates: found.candidates } : {}) };
        if (board.rows.some(row => row.houses.some(item => item.config?.agentId === found.item.id))) return { error: 'already_on_board' };
        house = { id: uniqueHouseId(board, found.item.id.replace(':', '-')), kind: 'text_edit', label: found.item.title, enabled: true, config: { agentId: found.item.id } };
        const warning = found.item.enabled !== true ? t('这个 Agent 目前关着，放上板也不会执行')
          : getAgentInvocationMode(found.item) === 'manual' ? t('这个 Agent 只能手动调用，放上板也不会自动执行') : '';
        const failed = insertHouse(board, house, op);
        if (failed) return { error: failed };
        return { label: found.item.title, meta: t('加入：{house} → {where}', { house: found.item.title, where: rowText(op.row, op.newRow) }), warning };
      }
      if (!ADDABLE_KINDS.includes(op.kind)) return { error: 'kind_not_addable' };
      if (op.kind === 'variable_rules' && !['before', 'after'].includes(op.phase)) return { error: 'phase_required' };
      house = { id: uniqueHouseId(board, op.kind === 'variable_rules' ? `rules_${op.phase}` : op.kind), kind: op.kind, enabled: true,
        ...(op.kind === 'variable_rules' ? { config: { phase: op.phase } } : {}) };
      const failed = insertHouse(board, house, op);
      if (failed) return { error: failed };
      const label = translateUiText(CATALOG.get(op.kind).label);
      return { label, meta: t('加入：{house} → {where}', { house: label, where: rowText(op.row, op.newRow) }) };
    }
    const found = findHouse(board, op.house);
    if (found.error) return { error: found.error, ...(found.candidates ? { candidates: found.candidates } : {}) };
    const entry = found.item;
    const label = entry.name;
    if (op.op === 'toggle') {
      if (entry.house.kind === 'body') return { error: 'body_always_on' };
      const before = entry.fusedKind ? entry.body.fusedEnabled?.[entry.fusedKind] !== false : entry.house.enabled !== false;
      if (before === op.enabled) return { error: 'no_change', label };
      if (entry.fusedKind) {
        entry.body.fusedEnabled = { ...entry.body.fusedEnabled, [entry.fusedKind]: op.enabled };
        entry.body.fusedMembers[entry.fusedKind] = { ...entry.house, enabled: op.enabled };
      } else entry.house.enabled = op.enabled;
      const on = value => (value ? t('开启') : t('关闭'));
      return { label, meta: t('开关：{house} {before} ⇒ {after}', { house: label, before: on(before), after: on(op.enabled) }) };
    }
    if (entry.fusedKind) return { error: 'fused_member_fixed', label };
    if (entry.house.kind === 'body') return { error: 'body_fixed', label };
    // 前情提要只要 Agent 还在就会自动挂回正文旁，移除不会生效：改用开关或关掉 Agent
    if (op.op === 'remove' && entry.house.config?.agentId === RECAP_AGENT_ID) return { error: 'recap_reattached', label };
    const row = board.rows[entry.rowIndex];
    row.houses.splice(row.houses.indexOf(entry.house), 1);
    if (op.op === 'remove') {
      board.rows = board.rows.filter(item => item.houses.length);
      return { label, meta: t('移除：{house}（第 {row} 行）', { house: label, row: entry.rowIndex + 1 }) };
    }
    // move：原来的行先留着（可能变空），插入后再清掉空行，行号才和操作前一致
    const failed = insertHouse(board, entry.house, op);
    if (failed) return { error: failed, label };
    board.rows = board.rows.filter(item => item.houses.length);
    return { label, meta: t('移动：{house} 第 {from} 行 → {where}', { house: label, from: entry.rowIndex + 1, where: rowText(op.row, op.newRow) }) };
  };

  const captureUpdate = async (args = {}) => {
    const runtime = runtimeOrNull();
    const store = getBoardStore?.();
    if (!runtime?.resolveBoard || !store) return { error: { ok: false, reason: 'flow_board_unavailable' } };
    const context = currentContext();
    if (!context.sessionId) return { error: { ok: false, reason: 'no_current_session' } };
    if (context.place !== 'writing') {
      return { error: { ok: false, reason: 'chat_flow_follows_settings', message: t('聊天的流程跟着设定自动排出：回复 Agent 设成自动、开启后就会排进去，这里不能手动调整。') } };
    }
    const scope = args.scope === 'all_cards' ? 'all_cards' : 'card';
    const target = TARGET_BY_SCOPE[scope];
    const resolved = resolveFor(runtime, context, scope);
    const ownSource = target === 'global' ? 'global' : 'persona';
    const base = { context, scope, target, source: resolved.source, beforeLayout: layoutOf(resolved.board) };
    const operations = Array.isArray(args.operations) ? args.operations : [];
    if (args.reset === true) {
      if (operations.length) return { error: { ok: false, reason: 'reset_with_operations' } };
      if (resolved.source !== ownSource) return { ...base, reset: true, noChange: true, changes: [] };
      return { ...base, reset: true, changes: [{ label: scopeLabel(scope), meta: scope === 'card' ? t('改回跟随所有角色卡的编排') : t('改回跟随现有设置自动排出') }] };
    }
    if (!operations.length) return { error: { ok: false, reason: 'operations_required' } };
    const agents = textAgentsFor(context, scope);
    const draft = clone(normalizeHopscotchBoard(resolved.board || {}));
    const changes = [];
    const errors = [];
    const warnings = [];
    operations.forEach((op, index) => {
      const result = applyOperation(draft, op || {}, agents);
      if (result.error) errors.push({ index, op: op?.op, label: result.label || trim(op?.house || op?.agent || op?.kind), reason: result.error, ...(result.candidates ? { candidates: result.candidates } : {}) });
      else {
        changes.push({ label: result.label, meta: result.meta });
        if (result.warning) warnings.push({ label: result.label, message: result.warning });
      }
    });
    if (errors.length) return { ...base, errors, changes };
    const validation = validateHopscotchBoard(draft);
    if (!validation.ok) return { ...base, errors: validation.errors.map(item => ({ reason: item.code, message: item.message })), changes };
    const board = validation.board;
    const manual = findManualHopscotchDependencies(board, activationFor(runtime, context, scope, board));
    if (manual.length) return { ...base, errors: [{ reason: 'manual_dependency', message: t('自动流程引用了仅手动的 Agent，请为上游开启自动调用或移除引用') }], changes };
    if (layoutOf(board) === base.beforeLayout && resolved.source === ownSource) return { ...base, noChange: true, changes: [] };
    return { ...base, board, changes, warnings, after: describeBoard(board), enableNeeded: isHopscotchEnabled() !== true };
  };

  const flowUpdateTool = {
    name: 'flow.update',
    title: 'Adjust the flow board',
    description: 'Adjust the creative-writing flow board (跳房子): houses in one row run in parallel, rows run in order after the reply is generated. operations run in order on the board as it stands after the previous one (flow.read shows it): add {agent: reply Agent id or title} puts a reply Agent such as 正文润色 on the board so it runs after replies, or add {kind} a built-in house (variable_rules needs phase before/after); remove / move / toggle take house = id or label from flow.read. row is 1-based; newRow:true inserts a new row at that position, otherwise the house joins that row (max 4 per row); without row it goes to a new last row. Built-in houses other than variable_rules before must come after the reply row. reset:true clears the custom board so the card follows all cards (scope card) or the settings (scope all_cards). scope card (default) = the current card, all_cards = shared by all cards. Saving also turns on the flow board. Chat flows follow settings and cannot be edited here.',
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_edit', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['card', 'all_cards'] },
        reset: { type: 'boolean' },
        operations: {
          type: 'array', maxItems: 12,
          items: {
            type: 'object', additionalProperties: false, required: ['op'],
            properties: {
              op: { type: 'string', enum: ['add', 'remove', 'move', 'toggle'] },
              agent: { type: 'string', maxLength: 120 },
              kind: { type: 'string', enum: ADDABLE_KINDS },
              phase: { type: 'string', enum: ['before', 'after'] },
              house: { type: 'string', maxLength: 120 },
              row: { type: 'integer', minimum: 1, maximum: 40 },
              newRow: { type: 'boolean' },
              enabled: { type: 'boolean' },
            },
          },
        },
      },
    },
    safety: {
      operationType: 'write_flow_board', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await captureUpdate(args, context);
        snapshots.set(args, snap);
        if (snap.error || snap.errors?.length || snap.noChange) return { destructive: false };
        return confirmRequest({
          kind: 'flow.update', operationType: 'write_flow_board', danger: Boolean(snap.reset),
          title: t('调整流程板'),
          message: [
            t('将修改{scope}的流程板（{count} 项）。', { scope: scopeLabel(snap.scope), count: snap.changes.length }),
            ...(snap.enableNeeded ? [t('保存后会开启跳房子编排。')] : []),
            ...(snap.warnings || []).map(item => `「${item.label}」${item.message}。`),
          ].join(''),
          confirmText: t('保存'),
          items: [
            ...snap.changes.map((change, index) => ({ id: `flow_${index}`, label: change.label, status: 'planned', meta: change.meta })),
            ...(snap.after ? [{ id: 'flow_after', label: t('调整后'), status: 'planned', meta: snap.after.join('；') }] : []),
          ],
          denyReason: 'flow_update_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureUpdate(args, context);
      if (snap.error) return snap.error;
      const head = { scope: snap.scope, scopeLabel: scopeLabel(snap.scope) };
      if (snap.errors?.length) return { ok: false, reason: 'invalid_request', ...head, errors: snap.errors, changes: snap.changes };
      if (snap.noChange) return { ok: true, skipped: true, reason: 'no_change', ...head };
      if (!isAllowed(context)) return { ok: false, reason: 'confirmation_required' };
      if (context.signal?.aborted) return { ok: false, cancelled: true, status: 'cancelled', reason: 'user_aborted', ...head };
      const now = currentContext();
      if (now.sessionId !== snap.context.sessionId || now.place !== snap.context.place) return { ok: false, reason: 'context_changed_during_confirmation', ...head };
      const runtime = runtimeOrNull();
      const store = getBoardStore?.();
      const current = resolveFor(runtime, snap.context, snap.scope);
      if (current.source !== snap.source || layoutOf(current.board) !== snap.beforeLayout) return { ok: false, reason: 'target_changed_during_confirmation', ...head };
      const board = snap.reset ? null : snap.board;
      const saved = snap.target === 'global'
        ? await store.setGlobalBoard(board)
        : await store.setPersonaBoard(board, { sessionId: snap.context.sessionId });
      if (!saved?.ok) return { ok: false, reason: saved?.reason || 'save_failed', ...(saved?.errors ? { errors: saved.errors } : {}), ...head };
      if (!snap.reset) {
        if (isHopscotchEnabled() !== true) enableHopscotch(true);
        const memoryMode = resolveHopscotchBoardMemoryMode(snap.board);
        if (memoryMode) setMemoryAutoExtractMode?.(memoryMode);
      }
      try { onSaved(); } catch {}
      // 读回存下的板核对（resolveBoard 会补挂前情提要、投射变量规则，不能拿来比）
      const stored = snap.target === 'global' ? store.getGlobalBoard?.() : store.getPersonaBoard?.(snap.context.sessionId);
      const ok = snap.reset ? !stored : Boolean(stored) && layoutOf(normalizeHopscotchBoard(stored)) === layoutOf(snap.board);
      if (!ok) return { ok: false, reason: 'verification_failed', ...head };
      const after = resolveFor(runtime, snap.context, snap.scope);
      const agents = textAgentsFor(snap.context, snap.scope);
      const activation = activationFor(runtime, snap.context, snap.scope, after.board);
      const rows = summarizeBoard(after.board, activation, agents);
      const inactive = rows.flatMap(row => row.houses).filter(house => house.enabled && house.active === false)
        .map(house => ({ label: house.label, reason: house.inactiveReason || t('已停用') }));
      return {
        ok: true, ...head, source: sourceLabel(after.source, snap.scope), changes: snap.changes, rows,
        ...(inactive.length ? { inactive } : {}),
        ...(snap.warnings?.length ? { warnings: snap.warnings } : {}),
      };
    },
    summarizeResult: result => (result?.ok
      ? (result.skipped ? 'flow board unchanged' : `flow board updated; ${Number(result.changes?.length || 0)} change(s)`)
      : `flow board update failed: ${trim(result?.reason)}`),
  };

  return [
    {
      name: 'flow.read',
      title: 'Read the flow board',
      description: 'Read the flow board (跳房子) that runs after each reply in the current creative-writing card or chat: rows of houses (same row runs in parallel, rows in order), each with on/off, whether it actually runs and why not, reply Agents on the board, reply Agents not on the board (notOnBoard), and where the board comes from (the card, all cards, or derived from settings). In creative writing with a custom board only the reply Agents on the board run after replies. scope card (default) or all_cards.',
      source: 'maid-app-content', permissions: [], riskLevel: 'low',
      capabilities: { read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'allow_once' },
      schema: { type: 'object', additionalProperties: false, properties: { scope: { type: 'string', enum: ['card', 'all_cards'] } } },
      execute: readFlow,
      summarizeResult: result => (result?.ok ? `read flow board; ${Number(result.rows?.length || 0)} row(s)` : `flow read failed: ${trim(result?.reason)}`),
    },
    flowUpdateTool,
  ];
};

export const registerFlowBoardAgentTools = (registry, deps = {}) => registry.registerMany(createFlowBoardAgentTools(deps));

