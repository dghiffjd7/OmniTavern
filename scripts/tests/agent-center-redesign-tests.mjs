import assert from 'node:assert/strict';

import { AgentCenterPanel } from '../../src/scripts/ui/agent-center-panel.js';
import { renderHopscotchCourt } from '../../src/scripts/ui/chat/hopscotch-court-view.js';

{
  // 手动 Agent 挂在正文旁（卫星），事件触发的 Agent 排在终点线之外（随时待命）
  const board = { rows: [{ id: 'r1', houses: [{ id: 'body', kind: 'body', label: '正文生成', fused: [] }] }, { id: 'r2', houses: [{ id: 'fmt', kind: 'format_review', label: '格式复核' }] }] };
  const html = renderHopscotchCourt(board, {
    satellites: [{ id: 'reply_scoring', title: '正文评分', enabled: false, trigger: '手动' }],
    standby: [{ id: 'archive_naming', title: '小管家', enabled: true, trigger: '保存存档时' }, { id: 'moment_agent', title: '动态 Agent', enabled: false, trigger: '发布或评论动态时' }],
  });
  const bodyRow = html.slice(html.indexOf('data-hop-row="0"'), html.indexOf('data-hop-row="1"'));
  assert.match(bodyRow, /class="hop-satellites"[\s\S]*data-hop-standby="reply_scoring"/, '卫星在正文所在行');
  assert.match(bodyRow, /hop-satellite is-off/, '关闭状态可见');
  const court = html.indexOf('</div></div>');
  const standby = html.indexOf('class="hop-standby"');
  assert.ok(standby > court, '待命区在板面（缩放区）之外');
  assert.match(html, /data-hop-standby="archive_naming"[\s\S]*保存存档时[\s\S]*已开启/);
  assert.match(html, /data-hop-standby="moment_agent"[\s\S]*发布或评论动态时[\s\S]*已关闭/);
  assert.doesNotMatch(renderHopscotchCourt(board), /hop-standby|hop-satellites/, '没有这类 Agent 时不渲染空区块');
  console.log('ok - hopscotch satellites and standby row');
}

const makePanel = cards => {
  const panel = new AgentCenterPanel({ getHopscotchPanel: () => ({ getConfigScope: () => 'local' }), resolveSessionLabel: sid => (sid === 'rp:1' ? '薪炎' : sid) });
  panel.view = { agentCards: cards, tabs: [], meta: {} };
  panel.render = () => {};
  panel.getActions = () => ({});
  return panel;
};

{
  // 卡片打开即设置面；诊断视图从正面开始
  const panel = makePanel([
    { id: 'archive_naming', title: '小管家', implemented: true, enabled: false, category: 'assistant', summary: '保存新存档时命名', detail: ['手动名称不会被覆盖。'] },
    { id: 'lineage_agent', title: '血缘图', implemented: true, cardGroup: 'diagnostic', category: 'diagnostic' },
  ]);
  panel.openFloatingAgentCard('archive_naming');
  assert.equal(panel.floatingAgentFlipped, true);
  panel.openFloatingAgentCard('lineage_agent');
  assert.equal(panel.floatingAgentFlipped, false);
  panel.openFloatingAgentCard('archive_naming', { face: 'details' });
  assert.equal(panel.floatingAgentFlipped, false);
  const back = panel.renderFloatingAgentBack(panel.getAgentCardById('archive_naming'), { configuration: '' });
  assert.match(back, /agent-center-float-about[\s\S]*<details class="agent-center-float-about-detail"><summary>说明<\/summary><p>手动名称不会被覆盖。<\/p>/, '说明收在设置面顶部');
  assert.match(back, /已关闭/);
  console.log('ok - floating cards open on settings with the description folded in');
}

{
  // 记忆 / 变量房子里的“修改前先预览”与原功能是同一开关
  const panel = makePanel([
    { id: 'memory_table_agent', title: '记忆表格 Agent', implemented: true, enabled: true, category: 'memory' },
    { id: 'write_preview', title: '预览记忆和变量变更', implemented: true, enabled: false, summary: 'AI 请求修改记忆、变量或世界书时，先显示可撤销预览。' },
  ]);
  const host = { isConnected: true, innerHTML: '', ownerDocument: { activeElement: null }, querySelector: () => null, querySelectorAll: () => [] };
  panel.bindAgentCardEvents = () => {};
  panel.mountCatalogPromptWorkspace = () => null;
  panel.renderAgentConfiguration = () => '<div data-config></div>';
  panel.mountHopscotchAgentCard(host, { agentId: 'memory_table_agent', configure: true, featureSwitches: ['write_preview'] });
  assert.match(host.innerHTML, /修改前先预览[\s\S]*data-agent-feature-action="enable" data-agent-feature-id="write_preview"/);
  assert.match(host.innerHTML, /data-help="AI 请求修改记忆、变量或世界书时，先显示可撤销预览。"/);
  console.log('ok - write preview switch merged into memory and variable houses');
}

{
  // 活动：按天分组、显示会话名；标题栏只留三项与工具开关
  const panel = makePanel([]);
  const now = Date.now();
  panel.view = { tabs: [], meta: { pending: 0, activeRuns: 1, failedRuns: 2, sessionGateEnabled: false }, activity: { meta: {}, runs: [
    { id: 'a', title: '任务一', kind: 'maid_assistant', status: 'succeeded', sessionId: 'rp:1', updatedAt: now },
    { id: 'b', title: '任务二', kind: 'maid_assistant', status: 'failed', sessionId: 'room', updatedAt: now - 86400000, errorMessage: 'boom' },
  ] } };
  const html = panel.renderActivity();
  assert.match(html, /agent-center-activity-day">今天[\s\S]*任务一[\s\S]*agent-center-activity-day">昨天[\s\S]*任务二/);
  assert.match(html, /女仆任务 · 薪炎 · /, '会话显示名称');
  assert.match(html, /错误：<span data-i18n-skip>boom<\/span>/, '错误直接可见');
  const meta = { innerHTML: '', querySelectorAll: () => [] };
  panel.metaElement = meta;
  panel.renderMeta();
  assert.match(meta.innerHTML, /is-active has-value[^>]*>运行中<b>1<\/b>/);
  assert.match(meta.innerHTML, /is-danger has-value[^>]*data-meta-status="failure">失败<b>2<\/b>/);
  assert.match(meta.innerHTML, /data-meta-tab="safety"[\s\S]*Agent 工具<b>未开启<\/b>/);
  assert.doesNotMatch(meta.innerHTML, /工具 86|资源 6/, '数量不再重复出现在标题栏');
  console.log('ok - activity timeline and focused header badges');
}

{
  // 资源按用途分组，整卡可点
  const panel = makePanel([]);
  panel.view = { resources: [
    { id: 'memory_center', group: '记忆', title: '记忆', summary: '表格、模板、导入导出。' },
    { id: 'image_templates', group: '生图', title: '生图模板', summary: '模型、默认参数、自动标签。' },
  ] };
  const html = panel.renderResources();
  assert.match(html, /记忆与资料<\/div>[\s\S]*data-resource-open="memory_center"[\s\S]*生成与规则<\/div>[\s\S]*data-resource-open="image_templates"/);
  assert.match(html, /<button type="button" class="agent-center-resource-main" data-resource-open="memory_center">/);
  console.log('ok - resources grouped into memory/data and generation/rules');
}
