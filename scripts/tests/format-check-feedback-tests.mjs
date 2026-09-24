import assert from 'node:assert/strict';

import {
  buildFormatCheckStatusPart,
  describeFormatCheckReason,
  isFormatCheckStatusPart,
  summarizeFormatCheckResult,
  withFormatCheckStatusPart,
} from '../../src/scripts/ui/chat/format-check-feedback.js';
import { buildAgentMessageSidecarElement } from '../../src/scripts/ui/chat/agent-message-sidecar-ui-utils.js';

const createFakeDocument = () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || '').toUpperCase();
      this.className = '';
      this.textContent = '';
      this.children = [];
      this.dataset = {};
      this.style = { cssText: '' };
      this.listeners = {};
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    }

    click() {
      (this.listeners.click || []).forEach(handler => handler({ currentTarget: this }));
    }
  }
  return { createElement: tagName => new FakeElement(tagName) };
};
const collect = (node, predicate, out = []) => {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  (node.children || []).forEach(child => collect(child, predicate, out));
  return out;
};
const textOf = node => collect(node, () => true).map(item => item.textContent).filter(Boolean).join('|');

// 跳过原因：原因码换成可读说明，已是中文的原因原样透出
{
  assert.match(describeFormatCheckReason('format_guide_missing'), /格式说明/);
  assert.match(describeFormatCheckReason('model_unavailable'), /没有可用模型/);
  assert.equal(describeFormatCheckReason('此 Agent 尚未允许当前调用方式'), '此 Agent 尚未允许当前调用方式');
  assert.match(describeFormatCheckReason(''), /未完成/);
  console.log('ok - skip reasons are readable');
}

// 结论：无需修改 / 有候选 / 其他
{
  assert.deepEqual(summarizeFormatCheckResult({ status: 'ready', modelReview: { status: 'no_change', repairSummary: '结尾已包含 <status> 块' } }),
    { outcome: 'no_change', reason: '结尾已包含 <status> 块' });
  assert.equal(summarizeFormatCheckResult({ status: 'needs_review', modelReview: { status: 'patch', canRepair: true } }).outcome, 'candidate');
  assert.equal(summarizeFormatCheckResult({ status: 'invalid_output', modelReview: { status: 'invalid_output' } }).outcome, 'other');
  assert.equal(summarizeFormatCheckResult(null).outcome, 'other');
  console.log('ok - review results map to a conclusion');
}

// 状态部件：与格式修复候选同一 id，替换而不是叠加
{
  const checking = buildFormatCheckStatusPart({ messageId: 'm1', sessionId: 's1', state: 'checking', now: () => 5 });
  assert.equal(checking.id, 'chat-format-guardian:m1');
  assert.equal(checking.status, 'running');
  assert.equal(checking.title, '正在检查格式…');
  assert.equal(isFormatCheckStatusPart(checking), true);
  assert.equal(buildFormatCheckStatusPart({ messageId: '' }), null);
  const noChange = buildFormatCheckStatusPart({ messageId: 'm1', state: 'no_change', reason: '格式完整' });
  assert.deepEqual(noChange.metadata.decisionActions.map(action => action.id), ['swipe_retry'], 'no-change offers the rewrite exit');
  assert.deepEqual(buildFormatCheckStatusPart({ messageId: 'm1', state: 'checked' }).metadata.decisionActions, []);

  const message = { id: 'm1', meta: { agentMessageParts: [{ id: 'other' }, { id: 'chat-format-guardian:m1', title: 'old' }] } };
  const replaced = withFormatCheckStatusPart(message, noChange);
  assert.deepEqual(replaced.meta.agentMessageParts.map(part => part.id), ['other', 'chat-format-guardian:m1']);
  assert.equal(replaced.meta.agentMessageParts[1].title, noChange.title);
  assert.equal(message.meta.agentMessageParts.length, 2, 'input message is not mutated');
  assert.deepEqual(withFormatCheckStatusPart(message, null).meta.agentMessageParts.map(part => part.id), ['other']);
  console.log('ok - status parts replace the format part of the same message');
}

// 渲染：状态提示是一行简洁说明，不出现调试面板；按钮走原有的格式修复动作
{
  const documentLike = createFakeDocument();
  const actions = [];
  const message = { id: 'm1', meta: { agentMessageParts: [buildFormatCheckStatusPart({ messageId: 'm1', state: 'no_change', reason: '结尾已包含状态块' })] } };
  const el = buildAgentMessageSidecarElement({ documentLike, message, onChatFormatGuardianAction: request => actions.push(request.action) });
  assert.equal(el.className, 'chat-format-check-status');
  assert.equal(el.dataset.state, 'no_change');
  assert.match(textOf(el), /已检查：未发现需要修复的格式问题/);
  assert.match(textOf(el), /结尾已包含状态块/);
  assert.doesNotMatch(textOf(el), /metadata|kind:|Agent/);
  collect(el, node => node.dataset?.chatFormatGuardianAction === 'swipe_retry')[0].click();
  assert.deepEqual(actions, ['swipe_retry']);

  const quiet = buildAgentMessageSidecarElement({ documentLike, message: { id: 'm2', meta: { agentMessageParts: [buildFormatCheckStatusPart({ messageId: 'm2', state: 'checked', reason: '格式完整' })] } } });
  assert.equal(quiet.dataset.state, 'checked');
  assert.equal(quiet.title, '格式完整', 'the faint mark keeps the reason as a tooltip');
  assert.doesNotMatch(textOf(quiet), /格式完整/);

  const mixed = buildAgentMessageSidecarElement({ documentLike, message: { id: 'm3', meta: { agentMessageParts: [
    { id: 'provider:1', type: 'agent_status', status: 'succeeded', title: 'Tool' },
    buildFormatCheckStatusPart({ messageId: 'm3', state: 'checking' }),
  ] } } });
  assert.equal(mixed.className, 'chat-agent-sidecar');
  assert.equal(mixed.children.at(-1).className, 'chat-format-check-status', 'status line follows the other agent parts');
  console.log('ok - status parts render as a compact line');
}

console.log('format check feedback tests passed');
