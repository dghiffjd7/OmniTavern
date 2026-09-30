import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotateMaidResearchResult } from '../../src/scripts/agent/maid-source-grounding.js';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createWebSearchAgentTools } from '../../src/scripts/agent/tools/web-search-tools.js';

// Reduced shape from the real run: successful search entries and readable pages,
// but explicit target checks found no relevant source. No captured page bodies.
const unrelated = {
  ok: true,
  results: [{ title: 'Welcome to Steam', url: 'https://example.test/store', snippet: 'Game platform home page' }],
  documents: [
    { ok: true, title: 'Sign In', url: 'https://example.test/login', text: 'Sign in to the game platform' },
    { ok: false, title: 'Store home', url: 'https://example.test/store', text: '', reason: 'HTTP 403' },
  ],
};
const targets = ['It Takes Two', 'Overcooked! 2 and Unrailed!', 'Overcooked! 2'];
const research = createWebSearchAgentTools({ httpRequest: () => { throw new Error('Network is prohibited in this test'); } })
  .find(tool => tool.name === 'web.research');
const checkedResult = index => annotateMaidResearchResult(unrelated, { target: targets[index % targets.length] });

test('zero relevant sources are explicit while request and page outcomes remain intact', () => {
  const result = checkedResult(0);
  assert.equal(result.targetCheck.checked, true);
  assert.equal(result.targetCheck.relevantSourceCount, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(result.documents.map(document => document.ok), [true, false]);
  assert.equal(result.evidenceStatus, 'no_relevant_sources');
  assert.match(research.summarizeResult(result), /no.*relevant.*evidence/i);
});

const matchingResult = () => annotateMaidResearchResult({
  ok: true,
  results: [{ title: 'Overcooked! 2', url: 'https://example.test/game', snippet: 'Local co-op game information' }],
}, { target: 'Overcooked! 2' });

test('matching targets and unchecked broad searches are not labelled as zero evidence', () => {
  const matching = matchingResult();
  assert.equal(matching.targetCheck.relevantSourceCount, 1);
  assert.equal(matching.evidenceStatus, 'target_matched');
  const unchecked = annotateMaidResearchResult(checkedResult(0), {});
  assert.equal(unchecked.targetCheck.checked, false);
  assert.equal(unchecked.evidenceStatus, 'target_not_checked', 'Rechecking without a target must clear a previous zero-evidence verdict');
});

const runResearchSequence = async ({ reset = null, mixedTools = false, differentTargets = false } = {}) => {
  const calls = [];
  const plan = index => ({ ok: true, action: 'tool', featureId: 'web.search',
    toolName: (index === 2 && reset === 'unchecked_search') || (mixedTools && index % 2 === 0) ? 'web.search' : 'web.research',
    args: { query: `Game price query ${index + 1}`,
      ...(index === 2 && reset === 'unchecked_search' ? {} : { target: differentTargets ? targets[index % targets.length] : targets[0] }) }, title: 'Research current game prices' });
  const agent = createMaidAssistantAgent({
    planner: async () => plan(0),
    reactPlanner: async () => (reset || differentTargets) && calls.length === 5
      ? { ok: true, action: 'final', message: 'The requested prices remain unverified.' }
      : plan(calls.length),
    maxReactSteps: 48,
    toolRegistry: { executeTool: async (toolName, args) => {
      const index = calls.length;
      calls.push({ toolName, args });
      const result = index === 2 && reset === 'unchecked_search' ? unrelated
        : index === 2 && reset === 'matching_research' ? matchingResult() : checkedResult(differentTargets ? index : 0);
      return { toolName, status: 'succeeded', result, summary: research.summarizeResult(result) };
    } },
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('Find current prices for two PC games, preserving the local co-op constraint.');
  return { result, calls };
};

test('three consecutive checked observations without relevant sources stop as incomplete', async () => {
  const { result, calls } = await runResearchSequence();
  assert.equal(result.reason, 'search_no_relevant_evidence');
  assert.equal(result.ok, false, 'Unverified requested facts cannot be reported as business success');
  assert.equal(result.status, 'interrupted');
  assert.equal(result.partial, true);
  assert.equal(result.continuable, false, 'Do not offer a blind retry of the same search');
  assert.equal(calls.length, 3);
  assert.ok(String(result.message || '').trim());
  assert.equal(result.steps.every(step => step.status === 'succeeded'), true, 'Keep transport success separate from evidence sufficiency');
});

test('switching search and research does not reset three explicit no-evidence results', async () => {
  const {result,calls}=await runResearchSequence({mixedTools:true});
  assert.equal(result.reason,'search_no_relevant_evidence');
  assert.equal(calls.length,3);
});

for (const reset of ['unchecked_search', 'matching_research']) {
  test(`${reset} breaks the sequence of explicit zero-evidence observations`, async () => {
    const { result, calls } = await runResearchSequence({ reset });
    assert.equal(calls.length, 5);
    assert.equal(result.ok, true);
    assert.notEqual(result.reason, 'search_no_relevant_evidence');
  });
}

test('different named targets do not share the repeated no-evidence counter', async () => {
  const {result,calls}=await runResearchSequence({mixedTools:true,differentTargets:true});
  assert.equal(calls.length,5);
  assert.notEqual(result.reason,'search_no_relevant_evidence');
});

test('an unsupported current price can be corrected by reading its source without replaying the search', async () => {
  let decisions=0;
  const calls=[];
  const agent=createMaidAssistantAgent({
    planner:async()=>({ok:true,toolName:'web.search',featureId:'web.search',args:{query:'two local PC games prices'}}),
    reactPlanner:async()=>{
      decisions+=1;
      return decisions===1 ? {ok:true,action:'final',message:'游戏当前22元。'}
        : decisions===2 ? {ok:true,action:'tool',toolName:'web.fetch_url',featureId:'web.search',args:{url:'https://example.test/game'}}
        : {ok:true,action:'final',message:'实际商店页显示 NT$ 438，来源 https://example.test/game。'};
    },
    toolRegistry:{executeTool:async(toolName)=>{
      calls.push(toolName);
      return {toolName,status:'succeeded',result:toolName==='web.search' ? unrelated
        : {ok:true,url:'https://example.test/game',text:'Buy game NT$ 438 Add to Cart'},summary:'result'};
    }},
    logger:{warn(){}},
  });
  const result=await agent.runPrompt('查两款同机双人游戏的当前价格');
  assert.equal(result.ok,true);
  assert.equal(decisions,3);
  assert.deepEqual(calls,['web.search','web.fetch_url']);
  assert.match(result.message,/NT\$ 438/);
  assert.doesNotMatch(result.message,/22元/);
});

const runAmountAdvisory = async ({ input = '查询游戏当前价格', onDecision = null, context = {} } = {}) => {
  const calls = [];
  const decisions = [];
  const originalFinal = { ok: true, action: 'final', message: '游戏当前22元。' };
  const agent = createMaidAssistantAgent({
    planner: async () => ({ ok: true, toolName: 'web.search', featureId: 'web.search', args: { query: 'game price' } }),
    reactPlanner: async (_input, decisionContext) => {
      decisions.push({ feedback: decisionContext.maidWebEvidenceFeedback, intent: decisionContext.operationIntentPolicy.mode });
      return onDecision ? onDecision(decisions.length, decisionContext, originalFinal) : { ...originalFinal };
    },
    toolRegistry: { executeTool: async (toolName, args) => {
      calls.push(toolName);
      const result = toolName === 'web.search' ? unrelated
        : toolName === 'web.fetch_url' ? { ok: true, url: args.url, text: 'NT$ 438' }
        : { ok: true, activePage: 'chat', sessionId: 'A', resource: args.resource, items: [] };
      return { toolName, status: 'succeeded', result, summary: 'result' };
    } },
    logger: { warn() {} },
  });
  return { result: await agent.runPrompt(input, context), calls, decisions, originalFinal };
};

test('advisory cannot run before pending APP state verification', async () => {
  const { result, calls, decisions } = await runAmountAdvisory({ input: '先查询游戏当前价格，最后读取APP状态。' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['web.search', 'app.get_current_state']);
  assert.equal(decisions.filter(item => item.feedback).length, 0, 'the pending APP step must run before any optional price correction');
});

test('advisory skips explicit write intent even before any APP write has run', async () => {
  const { decisions } = await runAmountAdvisory({ input: '查询游戏当前价格，并把结果写入备忘录。' });
  assert.equal(decisions[0].intent, 'write_allowed');
  assert.equal(decisions.length, 1);
  assert.equal(decisions.filter(item => item.feedback).length, 0);
});

test('advisory does not add calls to a mixed web and APP read sequence', async () => {
  const { result, calls, decisions } = await runAmountAdvisory({
    onDecision: (count, _context, original) => count === 1
      ? { ok: true, action: 'tool', toolName: 'app.read_resource', featureId: 'app.resource.read', args: { resource: 'variables' } }
      : { ...original },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['web.search', 'app.read_resource']);
  assert.equal(decisions.length, 2);
  assert.equal(decisions.filter(item => item.feedback).length, 0);
});

test('advisory makes at most one correction and does not fail an uncovered later final answer', async () => {
  const { result, calls, decisions } = await runAmountAdvisory({
    onDecision: (count, _context, original) => count === 2
      ? { ok: true, action: 'tool', toolName: 'web.fetch_url', featureId: 'web.search', args: { url: 'https://example.test/game' } }
      : { ...original },
  });
  assert.equal(result.ok, true);
  assert.equal(result.message, '游戏当前22元。');
  assert.deepEqual(calls, ['web.search', 'web.fetch_url']);
  assert.equal(decisions.length, 3);
  assert.equal(decisions.filter(item => item.feedback).length, 1);
});

for (const failure of ['rejected', 'network', 'timeout']) {
  test(`advisory ${failure} preserves the original final with an explicit unchecked-amount notice`, async () => {
    const { result, calls, decisions, originalFinal } = await runAmountAdvisory({
      onDecision: (count, _context, original) => {
        if (count === 1) return { ...original };
        if (failure === 'rejected') return { ok: false, reason: 'maid_react_unavailable', message: 'Model unavailable' };
        throw new Error(failure === 'timeout' ? 'maid_react_evidence_correction_timeout' : 'Connection reset');
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.message, `以下金额未能完成额外核对：22元。\n${originalFinal.message}`);
    assert.equal(result.finalDecision.message, result.message);
    assert.equal(decisions.length, 2);
    assert.deepEqual(calls, ['web.search']);
  });
}

test('advisory cancellation stops instead of publishing the original final', async () => {
  const controller = new AbortController();
  const { result, calls, decisions } = await runAmountAdvisory({
    context: { signal: controller.signal },
    onDecision: (count, _context, original) => {
      if (count === 2) controller.abort();
      return { ...original };
    },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'user_aborted');
  assert.doesNotMatch(result.message, /游戏当前22元/);
  assert.equal(decisions.length, 2);
  assert.deepEqual(calls, ['web.search']);
});
