// Recovery reads the public capability catalog only. It neither resolves private
// records nor grants a write target, tool permission or confirmation.
const trim = value => String(value ?? '').trim();
const noLookup = /(?:不要|别|不得|禁止|不用|无需|不需要|不必|不想)(?:(?![，,。；;！？!?\n]).){0,12}(?:查|检索|查询|搜索|读取|核对|工具)|\b(?:do not|don't|never|no need to|without)\s+(?:\w+\s+){0,3}(?:look\s*up|search|read|check|query|tools?)\b/iu;
const cancellation = /取消|停止|算了|先保留|不删了|不删除|不(?:合并|并回)|(?:不想|不打算|没让你|不要|别|不用|不必|不需要)(?:(?![，,。；;！？!?\n]).){0,24}(?:删|建|创建|修改|换|弄|加|拉|合并|并回|merge)|\b(?:cancel|stop|never mind)\b|\b(?:do not|don't|never|no need to)\s+(?:\w+\s+){0,3}merge\b/iu;
const discussion = /是什么|什么意思|为什么|如何|怎么|解释|讨论|讲讲|假如|假设|如果|要是|\b(?:what is|why|how (?:to|do|does)|explain|discuss|suppose|imagine)\b/iu;
const appResource = /APP|应用|世界书|角色卡|联系人|好友|聊天室|会话|群聊|群(?=$|[，,。；;！？!?\n])|建(?:一)?个?群|拉(?:一)?个?群|预设|正则|脚本|壁纸|头像|档案|\b(?:app|worldbook|persona|contact|chat|session|group|preset|regex|wallpaper|avatar)\b/iu;
const command = /(?:^|[，,。；;！？!?\n])\s*(?:请|麻烦|帮[我他她]们?|替我|给我|把|将|我要|我想|需要)?\s*(?:创建|新建|建(?:一)?个?|拉(?:一)?个?|弄|新增|添加|修改|更新|换|替换|删除|删掉|删了|清空|打开|切换|绑定|查看|查询|读取|列出|设置)|(?:把|将)[^，,。；;！？!?\n]{1,60}(?:删了|删掉|删除|移除|拉进|加入|移入|添加到|换成|改成)|\b(?:please\s+)?(?:create|add|update|delete|remove|open|switch|bind|list|read|set)\b/iu;
const namedRemoval = /(?:把|将)[^，,。；;！？!?\n]{1,60}(?:删了|删掉|删除|移除)|\b(?:delete|remove)\s+["'「“]/iu;
// A complaint can put the media object before its imperative. Require a new
// replacement (换一个/换成…) so a description of an earlier change stays chat.
const mediaReplacement = /(?:壁纸|头像|wallpaper|avatar)[^，,。；;！？!?\n]{0,24}(?:换(?:一)?(?:个|张)|换成|改成)/iu;

// A copy name alone does not identify an APP operation or a private target.
// Only an explicit merge command qualifies, and its recovery queries the public
// operation help across domains rather than inferring what that copy belongs to.
const hasMergeCommand = (text = '') => text.split(/[，,。；;！？!?\n]/u).some(part => {
  const clause = trim(part).replace(/^(?:(?:请|麻烦|帮我|替我|给我)\s*)+/u, '');
  const chinese = /^(?:(?:把|将).{1,60}(?:合并|并回)|(?:合并|并回).{1,60})/u.test(clause)
    && /世界书|副本/u.test(clause);
  const english = /^(?:(?:please|can you|could you|would you)\s+)?merge\s+.{1,100}/iu.test(clause)
    && /\b(?:worldbooks?|cop(?:y|ies))\b/iu.test(clause);
  return chinese || english;
});

export const shouldRecoverMaidAppDiscovery = ({ input = '', decision = {}, context = {} } = {}) => {
  const text = trim(input).normalize('NFKC');
  if (!text || context.signal?.aborted || context.maidDiscoveryRecovery || context.runContinuation
    || context.operationIntentPolicy?.mode === 'no_tool'
    || (Array.isArray(context.maidReactSteps) && context.maidReactSteps.length)) return false;
  if (noLookup.test(text) || cancellation.test(text) || discussion.test(text)) return false;
  if (/permission|denied|forbidden|cancel|aborted|not_configured|权限|拒绝/iu.test(trim(decision.reason))) return false;
  const earlyStop = decision.ok === false && ['unsupported_intent', 'no_tool'].includes(trim(decision.reason))
    || decision.ok === true && decision.action === 'final'
      && ['clarify', 'unsupported', 'no_tool'].includes(trim(decision.providerFcControl));
  if (!earlyStop) return false;
  return hasMergeCommand(text) || mediaReplacement.test(text)
    || command.test(text) && (appResource.test(text) || namedRemoval.test(text));
};

const discoveryQuery = (input = '') => {
  const text = trim(input);
  // Capability terms identify the operation, never a guessed resource type or
  // target. A name-only deletion must discover all registered deletion domains.
  if (hasMergeCommand(text)) return '合并';
  if (namedRemoval.test(text) || /删除|删掉|删了|\b(?:delete|remove)\b/iu.test(text)) return '删除';
  if (/(?:拉进|加入|添加到|移入)[^，,。；;！？!?\n]{0,60}群/iu.test(text)) return '修改群成员';
  if (/(?:创建|新建|建|拉|弄)(?:一)?个?[^，,。；;！？!?\n]{0,20}群(?=$|[聊，,。；;！？!?\n])|\bcreate\s+(?:a\s+)?group\b/iu.test(text)) return '创建群聊';
  const media = [];
  if (/头像|\bavatar\b/iu.test(text)) media.push('设置联系人头像', '设置角色卡头像');
  if (/壁纸|\bwallpaper\b/iu.test(text)) media.push('设置聊天室壁纸');
  if (media.length) return media.join(' ');
  return text.slice(0, 160);
};

export const createMaidAppDiscoveryPlan = ({ input = '', decision = {}, title = '' } = {}) => ({
  ok: true,
  action: 'tool',
  featureId: 'app.capabilities.search',
  toolName: 'app.search_feature',
  args: { query: discoveryQuery(input), limit: 8 },
  title,
  source: 'maid_discovery_recovery',
  metadata: {
    discoveryRecovery: {
      kind: 'public_capability_catalog',
      trigger: trim(decision.providerFcControl || decision.reason),
      initialDecisionSource: trim(decision.source),
      maxRecoveries: 1,
    },
  },
});

export const MAID_APP_DISCOVERY_RULE = 'For an explicit APP operation, a vague resource name or member reference is not evidence that tools or records are unavailable. Before declaring unsupported or asking the user to find an APP record, use the relevant read-only capability help and, when authorized, a necessary scoped lookup. Do not read private data for ordinary chat or general knowledge, or when the user forbids lookup. A catalog search is not a record lookup or proof of absence. If the allowed observations still cannot identify the target, ask one clear question; do not guess a write target or repeat discovery indefinitely.';

export const MAID_APP_DISCOVERY_RECOVERY_FEEDBACK = 'The APP performed one bounded public capability lookup after the initial unverified stop. This was APP recovery, not a model-selected action. Use its observed results and available read-only tools to decide what is actually supported; if the target remains ambiguous, clarify. No lookup result grants write permission or authorizes a target. Do not claim to have searched private records unless a record-reading tool actually ran.';
