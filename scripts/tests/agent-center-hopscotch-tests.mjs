import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AgentCenterPanel } from '../../src/scripts/ui/agent-center-panel.js';

let permitClose = true;
let discardClose;
let closed = 0;
const board = {
  requestClose: continuation => { discardClose = continuation; return permitClose; },
  close: () => { closed++; },
};
const panel = new AgentCenterPanel({ getHopscotchPanel: () => board });
panel.ensureDom = () => { panel.overlayElement ||= { style: { display: 'none' } }; };
panel.refresh = () => {};
panel.render = () => {};
panel.activeTab = 'activity';
panel.show();
assert.equal(panel.activeTab, 'agents', '普通 AC 入口始终回到跳房子首页');
panel.show({ tab: 'activity', activityStatus: 'failure' });
assert.equal(panel.activeTab, 'activity', '活动深链不被首页劫持');
panel.show({ tab: 'agents', agentId: 'reply_check', configure: true });
assert.equal(panel.floatingAgentId, 'reply_check');
assert.equal(panel.floatingAgentFlipped, true);
assert.match(panel.renderAgents(), /data-agent-hopscotch-host/);
assert.match(panel.renderAgents(), /data-agent-library/);
assert.doesNotMatch(panel.renderAgents(), /<details[^>]*\bopen\b/);
panel.closeTopLayer();
assert.equal(panel.floatingAgentId, '', '返回先关闭浮卡，不关闭 AC');
assert.equal(panel.isVisible(), true);
permitClose = false;
panel.hide();
assert.equal(panel.isVisible(), true, '未保存草稿阻止直接关闭');
assert.equal(closed, 0);
discardClose();
assert.equal(panel.isVisible(), false);
assert.equal(closed, 1);
panel.show();
permitClose = true;
panel.closeTopLayer();
assert.equal(panel.isVisible(), false);
console.log('ok - AC board homepage, explicit deep links, card-first back and dirty draft close guard');

const css = await readFile(new URL('../../src/assets/css/hopscotch-board.css', import.meta.url), 'utf8');
for (const [, rule] of css.matchAll(/\.hop-gap\s*\{([^}]+)\}/g)) {
  assert.doesNotMatch(rule, /translateX/, '行间加号不能带水平偏移');
}
assert.match(css, /button:where\(:not\(\.hop-cell\):not\(\.hop-plus\):not\(\.world-app-select-btn\)\)/, '通用按钮样式不覆盖房子、加号和 APP 下拉组件');
assert.match(css, /body\[data-reduced-motion='on'\][\s\S]*?transition: none/);
assert.match(css, /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)/, '仅支持悬停的精确指针设备默认隐藏加号');
assert.match(css, /\.hop-plus:hover,\s*\.hop-plus:focus-visible\s*\{\s*opacity:\s*1/, '悬停和键盘聚焦都能显示加号');
assert.match(css, /@media\s*\(any-pointer:\s*coarse\)/, '混合触摸设备仍保留可发现的新增入口');
assert.match(css, /\.hop-court\s*\{[^}]*flex-direction:\s*column;/, '起点在上，执行顺序从上往下');
assert.doesNotMatch(css, /flex-direction:\s*column-reverse/);
assert.doesNotMatch(css, /hop-mode-switch/, '编辑 / 本轮分段控件已由自动运行态 + 图标切换取代');
assert.match(css, /\.hop-court::before \{[^}]*left: 50%/, '中轴线表达先后顺序');
assert.match(css, /\.hop-stone \{/, '石子标记当前执行行');
assert.match(css, /\.hop-cell-status, \.hop-sr \{[^}]*clip-path/, '格内状态文字仅供辅助技术');
assert.match(css, /\.hop-board-footer \.hop-primary\s*\{[^}]*width: 100%;[^}]*min-height: 44px/, '手机主操作独占整行，保留触摸高度');
assert.match(css, /\.hop-icon-only \.hop-button-label\s*\{[^}]*clip-path:/, '图标按钮保留辅助技术可读标签');
const boardPanel = await readFile(new URL('../../src/scripts/ui/chat/hopscotch-board-panel.js', import.meta.url), 'utf8');
assert.doesNotMatch(boardPanel, /class="hop-mode-switch"/);
assert.match(boardPanel, /class="hop-menu hop-secondary-actions" role="menu" hidden/, '次要操作收进溢出菜单');
assert.match(boardPanel, /iconBtn\('run-mode', t\('上一轮'\)/, '回看上一轮为图标按钮');
assert.match(boardPanel, /iconBtn\('library', t\('全部 Agent'\)\)/, '目录入口在标题栏');
assert.match(boardPanel, /createCustomSelectWrapper/, '编排下拉复用 APP 组件，不另造选单');
assert.doesNotMatch(css, /radial-gradient/, '房子改为平面粉笔线，不再使用色光渐变');
assert.match(css, /\.hop-court \.hop-fusion-part:not\(\[data-hop-part='body'\]\) \.hop-title \{[^}]*font-size: 13px/, '融合项次级于正文');
assert.match(boardPanel, /iconBtn\('help', t\('说明'\)\)/);
assert.match(boardPanel, /class="hop-icon-only" title="\$\{e\(label\)\}" aria-label="\$\{e\(label\)\}"/, '图标按钮统一带 title 与 aria-label');
console.log('ok - theme-aware grouped toolbar, accessible icon buttons and full-width mobile save');
const app = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../../src/index.html', import.meta.url), 'utf8');
assert.doesNotMatch(index, /id="hopscotch-board-trigger"/, '不保留平行的独立编排入口');
assert.match(app, /getHopscotchPanel: \(\) => hopscotchBoardPanel/);
assert.match(app, /embedded: true/);
assert.match(app, /getPlace: \(\) => uiMode === 'rp' \? 'writing' : 'chat'/);
assert.match(app, /if \(sessionId !== chatStore.getCurrent\?\.\(\)\) return false/, '变量入口不能把旧卡片操作施加到已切换的新会话');
assert.match(app, /closeRelatedLayer: \(\) => variablePanel.hasVisibleLayer\(\) && variablePanel.closeTopLayer\(\)/, '仅可见变量子层优先返回，不干扰隐藏面板');
console.log('ok - AC owns the board entry and inter-row add buttons stay centered');
