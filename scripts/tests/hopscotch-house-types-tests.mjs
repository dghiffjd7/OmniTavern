import assert from 'node:assert/strict';
import { editHopscotchBoard } from '../../src/scripts/ui/chat/hopscotch-board-editor-utils.js';
import { buildDefaultHopscotchBoard } from '../../src/scripts/ui/chat/hopscotch-board-utils.js';
import { listHopscotchHouseChoices, checkHopscotchHouseEnable, buildRecapAgentConfig, resolveHopscotchHouseType, isHopscotchHouseDraft } from '../../src/scripts/ui/chat/hopscotch-house-types.js';
import { resolveHopscotchActivation } from '../../src/scripts/ui/chat/hopscotch-activation-utils.js';
import { renderHopscotchCourt } from '../../src/scripts/ui/chat/hopscotch-court-view.js';
import { resolveAgentToolStage } from '../../src/scripts/agent/agent-tool-stage.js';
import { normalizeAgentConfiguration } from '../../src/scripts/storage/agent-config-store.js';
import { createHopscotchTurnRuntime } from '../../src/scripts/ui/chat/hopscotch-turn-runtime.js';
import { createAgentConfigStore } from '../../src/scripts/storage/agent-config-store.js';
import { RECAP_AGENT_ID } from '../../src/scripts/agent/recap-agent.js';

const houses = board => board.rows.flatMap(row => row.houses);
const addDraft = (board, rowIndex, newRow = true) => {
  const result = editHopscotchBoard(board, { type: 'add', kind: 'custom_prompt', house: { enabled: false }, rowIndex, newRow });
  assert.equal(result.ok, true, result.reason);
  const before = new Set(houses(board).map(house => house.id));
  return { board: result.board, id: houses(result.board).find(house => !before.has(house.id)).id };
};
const keys = choices => choices.map(choice => choice.key);

{
  const base = buildDefaultHopscotchBoard({});
  const after = addDraft(base, 1);
  const draft = houses(after.board).find(house => house.id === after.id);
  assert.equal(draft.enabled, false, '「+」放下的房子默认停用，不影响流程');
  assert.equal(isHopscotchHouseDraft(draft), true);
  const choices = listHopscotchHouseChoices(after.board, after.id);
  assert.deepEqual(choices.filter(choice => choice.group === 'type').map(choice => [choice.type, choice.size, choice.current]),
    [['custom', 'big', true], ['rewrite', 'big', false], ['manual', 'small', false]], '正文之后三种类型都可选，手动是小房子');
  const templates = keys(choices.filter(choice => choice.group === 'template'));
  for (const key of ['builtin:memory_table', 'builtin:image_prompt', 'builtin:variable', 'builtin:variable_rules:after', 'builtin:format_review', 'template:recap']) assert.ok(templates.includes(key), key);
  assert.ok(!templates.includes('builtin:variable_rules:before'), '发送前变量规则不能放在正文之后');
  assert.ok(!templates.includes('builtin:image_generation'), '没有图片提示时不提供图片生成');
  assert.ok(!templates.includes('builtin:summary_compaction') && !templates.includes('builtin:body'), '正文与摘要压缩不作为模板');
  assert.equal(choices.find(choice => choice.key === 'template:recap').size, 'small', '前情提要是小房子模板');

  const before = addDraft(base, 0);
  const preBody = listHopscotchHouseChoices(before.board, before.id);
  assert.deepEqual(keys(preBody.filter(choice => choice.group === 'type')), ['type:custom'], '正文之前只能放自定义提示词');
  assert.deepEqual(keys(preBody.filter(choice => choice.group === 'template')), ['builtin:variable_rules:before']);
  console.log('ok - a draft house offers only the types and templates valid at its position');
}

{
  const base = buildDefaultHopscotchBoard({});
  const { board, id } = addDraft(base, 1);
  const memory = editHopscotchBoard(board, { type: 'retype', id, kind: 'memory_table', house: {} });
  assert.equal(memory.ok, true, memory.reason);
  const retyped = houses(memory.board).find(house => house.id === id);
  assert.deepEqual([retyped.kind, retyped.enabled, memory.board.rows.findIndex(row => row.houses.includes(retyped))], ['memory_table', false, 1], '原位换类型，仍是草稿');
  const second = addDraft(memory.board, 2);
  assert.ok(!keys(listHopscotchHouseChoices(second.board, second.id)).includes('builtin:memory_table'), '内建房子保持唯一，已在流程中的不再作为模板出现');
  const enabled = editHopscotchBoard(memory.board, { type: 'toggle', id, enabled: true });
  assert.equal(editHopscotchBoard(enabled.board, { type: 'retype', id, kind: 'custom_prompt', house: {} }).ok, false, '已启用的房子不能换类型');
  assert.equal(editHopscotchBoard(base, { type: 'retype', id: 'body', kind: 'custom_prompt', house: {} }).ok, false, '正文不能换类型');
  assert.deepEqual(listHopscotchHouseChoices(enabled.board, id), [], '已启用的房子没有类型托盘');
  console.log('ok - retype keeps id, row and disabled state; built-ins stay unique');
}

{
  const base = buildDefaultHopscotchBoard({});
  const { board, id } = addDraft(base, 1);
  const manual = { id: 'text-edit:notes', title: '笔记', invocationMode: 'manual', enabled: false };
  const auto = { id: 'text-edit:polish', title: '润色', invocationMode: 'auto', enabled: true };
  const linked = editHopscotchBoard(board, { type: 'retype', id, kind: 'text_edit', house: { label: manual.title, config: { agentId: manual.id } } }).board;
  const house = houses(linked).find(item => item.id === id);
  assert.equal(resolveHopscotchHouseType(house, [manual, auto]), 'manual');
  const choices = listHopscotchHouseChoices(linked, id, { textAgents: [manual, auto] });
  assert.equal(choices.find(choice => choice.type === 'manual').current, true);
  assert.deepEqual(choices.filter(choice => choice.group === 'agent').map(choice => [choice.agentId, choice.size]), [['text-edit:polish', 'big']], '已放入流程的 Agent 不重复出现');
  const full = Array.from({ length: 8 }, (_, index) => ({ id: `text-edit:${index}`, title: `A${index}`, invocationMode: 'manual' }));
  const capped = listHopscotchHouseChoices(board, id, { textAgents: full });
  assert.ok(!capped.some(choice => ['type:rewrite', 'type:manual', 'template:recap'].includes(choice.key)), '已有 8 个回复 Agent 时不再新建');
  assert.equal(capped.filter(choice => choice.group === 'agent').length, 8, '仍可放入已有 Agent');
  assert.ok(!listHopscotchHouseChoices(board, id, { canCreateAgent: false }).some(choice => choice.key === 'type:manual'), '无法新建 Agent 时不提供需要新建的类型');
  console.log('ok - text agent types follow the linked agent; existing agents can be placed; agent limit respected');
}

{
  const base = buildDefaultHopscotchBoard({});
  const { board, id } = addDraft(base, 1);
  assert.deepEqual(checkHopscotchHouseEnable(board, id), { ok: false, field: 'prompt', message: '请先填写提示词' }, '空提示词指向提示词字段');
  const filled = editHopscotchBoard(board, { type: 'update', id, patch: { config: { prompt: '整理线索' } } }).board;
  assert.equal(checkHopscotchHouseEnable(filled, id).ok, true);
  const agent = { id: 'text-edit:a', title: 'A', enabled: false, invocationMode: 'manual' };
  const linked = editHopscotchBoard(board, { type: 'retype', id, kind: 'text_edit', house: { config: { agentId: agent.id } } }).board;
  assert.deepEqual(checkHopscotchHouseEnable(linked, id, { textAgents: [agent] }), { ok: true, enableAgentId: agent.id }, '未启用的 Agent 交给配置服务开启并说明缺什么');
  assert.equal(checkHopscotchHouseEnable(linked, id, { textAgents: [] }).ok, false, 'Agent 已不存在时提示重新选择');
  const ready = { ...agent, enabled: true, modelMode: 'follow_current' };
  assert.equal(checkHopscotchHouseEnable(linked, id, { textAgents: [ready], resolveActivation: next => resolveHopscotchActivation(next, { textAgents: [{ ...ready, triggerMode: 'manual' }] }) }).ok, true, '仅手动不算问题');
  const memory = editHopscotchBoard(board, { type: 'retype', id, kind: 'memory_table', house: {} }).board;
  assert.deepEqual(checkHopscotchHouseEnable(memory, id, { resolveActivation: next => resolveHopscotchActivation(next, { memory: { storageMode: 'summary' } }) }),
    { ok: false, message: '摘要模式：摘要随正文一起生成，不更新记忆表格' }, '内建房子说明不能运作的原因');
  assert.deepEqual(checkHopscotchHouseEnable(memory, id, { resolveActivation: next => resolveHopscotchActivation(next, { memory: { storageMode: 'off' } }) }),
    { ok: false, message: '记忆表格功能已关闭' }, '记忆关闭时仍说明功能已关闭');
  console.log('ok - enabling checks the house can run and names what is missing');
}

{
  const recap = normalizeAgentConfiguration(buildRecapAgentConfig(), 'text-edit:recap');
  assert.deepEqual([recap.kind, recap.title, recap.invocationMode, recap.outputMode, recap.target.mode, recap.context.history.enabled, recap.context.history.unit, recap.context.history.count, recap.enabled],
    ['text_edit', '前情提要', 'manual', 'note', 'rendered', true, 'turns', 20, false], '前情提要：手动、只读附注、参考最近 20 轮');
  assert.ok(recap.prompt.includes('前情提要'));
  console.log('ok - recap template is a manual read-only note agent');
}

{
  const board = { rows: [
    { id: 'r0', houses: [{ id: 'body', kind: 'body', fused: [] }] },
    { id: 'r1', houses: [{ id: 'mem', kind: 'memory_table' }] },
    { id: 'r2', houses: [{ id: 'h-recap', kind: 'text_edit', config: { agentId: 'text-edit:recap' } }, { id: 'fmt', kind: 'format_review' }] },
  ] };
  assert.deepEqual(resolveAgentToolStage({ agentId: 'text-edit:free', board, generating: true, hasReply: false }), { placed: false, ready: true, reason: '' }, '随时待命的 Agent 不受限制');
  assert.equal(resolveAgentToolStage({ agentId: 'text-edit:recap', board, hasReply: false }).reason, 'no_reply');
  assert.equal(resolveAgentToolStage({ agentId: 'text-edit:recap', board, generating: true }).reason, 'generating');
  assert.equal(resolveAgentToolStage({ agentId: 'text-edit:recap', board, states: { body: 'succeeded', mem: 'running' } }).reason, 'stage_pending', '前面的阶段未结束时不出现');
  assert.equal(resolveAgentToolStage({ agentId: 'text-edit:recap', board, states: { body: 'succeeded', mem: 'failed' } }).ready, true, '前面阶段失败也算走过');
  assert.equal(resolveAgentToolStage({ agentId: 'reply_check', board, states: { body: 'succeeded', mem: 'skipped' } }).ready, true, '格式复核房子对应格式修复工具');
  assert.equal(resolveAgentToolStage({ agentId: 'text-edit:recap', board }).ready, true);
  console.log('ok - toolbox shows flow agents only after the reply passes their stage');
}

{
  // 手动房子画成胶囊，挂在它前面最近一个有大房子的行旁；只剩手动房子的行不单独画出，也不占编号
  const board = buildDefaultHopscotchBoard({ memory: { storageMode: 'table', autoExtract: true, autoExtractMode: 'separate' } });
  const manual = { id: 'text-edit:m', title: '手动', enabled: true, invocationMode: 'manual', triggerMode: 'manual', modelMode: 'follow_current' };
  const auto = { id: 'text-edit:a', title: '润色', enabled: true, invocationMode: 'auto', modelMode: 'follow_current' };
  let next = editHopscotchBoard(board, { type: 'add', kind: 'text_edit', house: { config: { agentId: manual.id } }, rowIndex: 1, newRow: true }).board;
  next = editHopscotchBoard(next, { type: 'add', kind: 'text_edit', house: { config: { agentId: auto.id } }, rowIndex: 3, newRow: false }).board;
  const draft = addDraft(next, 3);
  const pillId = houses(next).find(h => h.config?.agentId === manual.id).id;
  const activation = resolveHopscotchActivation(draft.board, { textAgents: [manual, auto] });
  const html = renderHopscotchCourt(draft.board, { editable: true, activation, typeTray: { houseId: draft.id, choices: listHopscotchHouseChoices(draft.board, draft.id, { textAgents: [manual, auto] }) } });
  const bodyRow = html.slice(html.indexOf('data-hop-row="0"'), html.indexOf('data-hop-row="2"'));
  assert.match(bodyRow, new RegExp(`class="hop-satellites"><button type="button" class="hop-satellite"[^>]*data-hop-house="${pillId}"`), '手动房子挂在正文行旁');
  assert.doesNotMatch(html, /data-hop-row="1"/, '只剩手动房子的行不单独画出');
  assert.doesNotMatch(html, new RegExp(`class="hop-cell[^"]*"[^>]*data-hop-house="${pillId}"`), '胶囊不画成房子格');
  assert.equal((html.match(/data-hop-type-trigger/g) || []).length, 1, '只有草稿房子有切换类型的角标');
  assert.ok(html.indexOf('class="hop-type-tray"') > html.indexOf(`data-hop-house="${draft.id}"`), '托盘在草稿房子所在行的下方');
  assert.match(html, /hop-type-chip is-small" data-hop-retype="type:manual"/);
  assert.doesNotMatch(renderHopscotchCourt(draft.board, { activation }), /data-hop-type-trigger|hop-type-tray/, '运行与只读视图没有类型切换');
  const off = renderHopscotchCourt(next, { activation: resolveHopscotchActivation(next, { textAgents: [{ ...manual, enabled: false }, auto] }) });
  assert.match(off, /class="hop-satellite is-off"/, '未启用的手动房子是灰的胶囊');
  console.log('ok - manual houses render as pills beside the row they follow');
}

{
  const agents = [{ id: 'text-edit:auto', title: '自动', invocationMode: 'auto', enabled: true }, { id: 'text-edit:manual', title: '手动', invocationMode: 'manual', enabled: true }];
  const runtime = createHopscotchTurnRuntime({ boardStore: {}, getTextAgents: () => agents });
  const rows = runtime.resolveBoard('chat-1', { place: 'chat' }).board.rows.map(row => row.houses.map(house => house.config?.agentId || house.kind));
  assert.deepEqual(rows, [['body'], ['text-edit:manual'], ['text-edit:auto']], '推导流程：仅手动的 Agent 紧接正文（挂在正文旁），自动的排在最后');
  // 用户板上没有默认的前情提要时补挂在正文旁；删掉（不在 Agent 列表中）后不再补
  const userBoard = { version: 2, source: 'user', rows: [{ id: 'r_body', houses: [{ id: 'body', kind: 'body', fused: [] }] }, { id: 'r2', houses: [{ id: 'mem', kind: 'memory_table' }] }] };
  const store = { resolveEffectiveBoard: () => ({ board: structuredClone(userBoard), source: 'persona' }) };
  const withRecap = createHopscotchTurnRuntime({ boardStore: store, getTextAgents: () => [{ id: RECAP_AGENT_ID, title: '前情提要', invocationMode: 'manual' }] });
  assert.deepEqual(withRecap.resolveBoard('rp:x').board.rows.map(row => row.houses.map(house => house.config?.agentId || house.kind)), [['body'], [RECAP_AGENT_ID], ['memory_table']]);
  const without = createHopscotchTurnRuntime({ boardStore: store, getTextAgents: () => [] });
  assert.equal(without.resolveBoard('rp:x').board.rows.length, 2);
  console.log('ok - derived boards hang manual agents beside the body; the default recap is added to user boards until deleted');
}

{
  // 默认的前情提要：每个作用域都有、默认停用；删除后不再出现
  const configs = createAgentConfigStore({ storage: null, saveKv: async () => true });
  const context = { place: 'writing', sessionId: 'rp:p1', scopeId: '' };
  const recap = configs.list(context).find(item => item.id === RECAP_AGENT_ID)?.config;
  assert.deepEqual([recap?.kind, recap?.enabled, recap?.invocationMode, recap?.outputMode, recap?.title], ['text_edit', false, 'manual', 'note', '前情提要']);
  assert.equal(configs.list({ place: 'chat', sessionId: 'room', scopeId: 's' }).some(item => item.id === RECAP_AGENT_ID), true, '聊天也有');
  assert.equal((await configs.remove({ id: RECAP_AGENT_ID, context, scope: 'local' })).ok, true);
  assert.equal(configs.list(context).some(item => item.id === RECAP_AGENT_ID), false, '删除后不再出现');
  assert.equal(configs.list({ ...context, sessionId: 'rp:p2' }).some(item => item.id === RECAP_AGENT_ID), true, '只删除当前角色卡的');
  const board = { rows: [{ id: 'r0', houses: [{ id: 'body', kind: 'body', fused: [] }] }, { id: 'r1', houses: [{ id: 'recap', kind: 'text_edit', enabled: false, config: { agentId: RECAP_AGENT_ID } }] }] };
  assert.equal(isHopscotchHouseDraft(board.rows[1].houses[0]), false, '默认的前情提要不换类型');
  console.log('ok - the default recap exists per scope, starts disabled and stays deleted once removed');
}

{
  // 草稿里切换类型新建的 Agent：保存时只留放进板里的；放弃时删除没改过、没启用的；名单存在本机，重载后补清理
  const { createHopscotchDraftAgents } = await import('../../src/scripts/ui/chat/hopscotch-draft-agents.js');
  const memory = new Map();
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  let agents = [{ id: 'a', title: '正文润色', enabled: false, prompt: 'x', updatedAt: 1 }, { id: 'b', title: '前情提要', enabled: false, prompt: 'y', updatedAt: 1 },
    { id: 'c', title: '改过', enabled: false, prompt: 'z', updatedAt: 1 }, { id: 'd', title: '启用', enabled: false, prompt: 'w', updatedAt: 1 }];
  const removed = [];
  const make = () => createHopscotchDraftAgents({ storage, listAgents: () => agents, removeAgent: async id => { removed.push(id); agents = agents.filter(item => item.id !== id); return { ok: true }; } });
  const tracker = make();
  for (const id of ['a', 'b', 'c', 'd']) tracker.track(id, { context: 'writing|rp:1', target: 'persona', scope: 'local' });
  agents = agents.map(item => item.id === 'a' ? { ...item, invocationMode: 'manual', updatedAt: 9 } : item);
  tracker.restamp('a');
  agents = agents.map(item => item.id === 'c' ? { ...item, prompt: '用户改过' } : item.id === 'd' ? { ...item, enabled: true } : item);
  assert.deepEqual([...tracker.pending('writing|rp:1')], ['a', 'b', 'c', 'd']);
  assert.deepEqual(await tracker.settle('chat|other'), [], '只处理当前会话');
  assert.deepEqual(await tracker.settle('writing|rp:1', new Set(['b'])), ['a'], '保存进板的保留，改过或启用的保留，其余删除');
  assert.deepEqual(removed, ['a']);
  assert.equal(tracker.pending('writing|rp:1').size, 0, '草稿结束后不再追踪');
  agents.push({ id: 'e', title: '遗留', enabled: false, prompt: 'v', updatedAt: 1 });
  make().track('e', { context: 'writing|rp:2', target: 'persona', scope: 'local' });
  assert.deepEqual(await make().settle('writing|rp:2'), ['e'], '页面重载后，下次打开同一会话时补做清理');
  console.log('ok - agents created while switching draft types are removed when the draft ends unused');
}

{
  // 自定义房子：默认最大输出 8192、输入预算 10000；旧版默认值迁移为新默认，用户改过的值保留
  const { normalizeCustomHouseConfig } = await import('../../src/scripts/ui/chat/hopscotch-board-utils.js');
  assert.deepEqual([normalizeCustomHouseConfig({}).maxTokens, normalizeCustomHouseConfig({}).contextTokenBudget], [8192, 10000]);
  assert.deepEqual([normalizeCustomHouseConfig({ maxTokens: 512, contextTokenBudget: 2000 }).maxTokens, normalizeCustomHouseConfig({ maxTokens: 512, contextTokenBudget: 2000 }).contextTokenBudget], [8192, 10000]);
  assert.deepEqual([normalizeCustomHouseConfig({ maxTokens: 1500, contextTokenBudget: 4000 }).maxTokens, normalizeCustomHouseConfig({ maxTokens: 1500, contextTokenBudget: 4000 }).contextTokenBudget], [1500, 4000]);
  assert.equal('timeoutMs' in normalizeCustomHouseConfig({ timeoutMs: 60000 }), false, '自定义房子不再有单独的超时');
  console.log('ok - custom house output and input budgets default to 8192 / 10000');
}
