import assert from 'node:assert/strict';

import {
  annotateMaidResearchResult,
  buildMaidSourceGroundingContext,
  buildMaidSourceGroundingPromptBlock,
  resolveMaidSourceGroundingPolicy,
  validateMaidWorldbookSourcePlan,
} from '../../src/scripts/agent/maid-source-grounding.js';

{
  const url = 'https://example.com/shared-work-page';
  const page = { ok: true, results: [{ title: '作品 Alpha', url, snippet: '作品 Alpha 的角色设定。' }] };
  const steps = ['作品 Alpha', '作品 Beta'].map(target => ({
    toolName: 'web.research', status: 'succeeded', args: { target },
    output: annotateMaidResearchResult(page, { target }),
  }));
  const context = buildMaidSourceGroundingContext({ steps });
  assert.equal(context.sources.find(source => source.target === '作品 Beta')?.targetRelevant, false,
    'An earlier match for Alpha must not be relabelled as a match for Beta at the same URL');
  assert.equal(context.sources.find(source => source.target === '作品 Alpha')?.targetRelevant, true);
  assert.deepEqual(context.sources.find(source => source.target === '作品 Beta').matchedTargetTerms, []);
  assert.deepEqual(context.allowedCanonRefs, [url], 'Keep the source available for its genuinely matched work');
  assert.equal(validateMaidWorldbookSourcePlan({
    toolName: 'worldbook.create', grounding: context,
    args: { entries: [{ title: 'Alpha character', content: 'Source-backed content.', sourceLayer: 'canon', sourceRefs: [url] }] },
  }).ok, true);
  const prompt = buildMaidSourceGroundingPromptBlock({ steps });
  assert.match(prompt, /relevant \| target=作品 Alpha/);
  assert.match(prompt, /unrelated \| target=作品 Beta/);
  console.log('ok - the same source keeps independent target verdicts and normal canon references');
}

{
  const url = 'https://example.com/aliases';
  const page = { ok: true, results: [{ title: '作品 Alpha', url, snippet: '作品 Alpha 的资料。' }] };
  const steps = [['作品 Alpha'], ['作品 Beta']].map(targetAliases => ({
    toolName: 'web.search', status: 'succeeded', args: { targetAliases },
    output: annotateMaidResearchResult(page, { targetAliases }),
  }));
  const context = buildMaidSourceGroundingContext({ steps });
  assert.equal(context.sources.length, 2, 'Alias-only checks must not share an empty target scope');
  assert.equal(context.sources.find(source => source.targetAliases.includes('作品 Beta')).targetRelevant, false);
  assert.equal(context.sources.find(source => source.targetAliases.includes('作品 Alpha')).targetRelevant, true);
  const unchecked = buildMaidSourceGroundingContext({ steps: [...steps, {
    toolName: 'web.search', status: 'succeeded', args: {}, output: annotateMaidResearchResult(page),
  }] });
  assert.equal(unchecked.sources.find(source => !source.target && !source.targetAliases.length).targetRelevant, null);
  console.log('ok - alias-only and unchecked searches preserve separate source scopes');
}

{
  const strict = resolveMaidSourceGroundingPolicy('请按《我的青春恋爱物语果然有问题》原作建立世界书，不要硬编；可以把我的领养设定作为原创补充。');
  assert.equal(strict.strictNoInvent, true);
  assert.equal(strict.allowCreativeExtension, true);
  assert.equal(strict.requiresLayering, true);

  const normal = resolveMaidSourceGroundingPolicy('帮我建一本测试世界书');
  assert.equal(normal.strictNoInvent, false);
  console.log('ok - source grounding policy distinguishes strict canon and allowed creative expansion');
}

{
  const result = annotateMaidResearchResult({
    ok: true,
    query: '春物 平塚静',
    results: [
      { title: '《我的青春恋爱物语果然有问题》角色资料', url: 'https://example.com/oregairu', snippet: '平塚静是总武高教师。' },
      { title: '青春校园作品推荐', url: 'https://example.com/unrelated', snippet: '另一部作品。' },
    ],
    sources: [
      { title: '《我的青春恋爱物语果然有问题》角色资料', url: 'https://example.com/oregairu' },
      { title: '青春校园作品推荐', url: 'https://example.com/unrelated' },
    ],
    documents: [
      { ok: true, title: '角色资料', url: 'https://example.com/oregairu', text: 'やはり俺の青春ラブコメはまちがっている。平塚静。' },
      { ok: true, title: '其他作品', url: 'https://example.com/unrelated', text: '完全不相关的作品。' },
    ],
  }, {
    target: '我的青春恋爱物语果然有问题',
    targetAliases: ['やはり俺の青春ラブコメはまちがっている', '春物'],
  });
  assert.equal(result.targetCheck.checked, true);
  assert.equal(result.targetCheck.relevantSourceCount, 1);
  assert.equal(result.sources[0].targetRelevant, true);
  assert.equal(result.sources[1].targetRelevant, false);
  assert.equal(result.documents[0].targetRelevant, true);
  console.log('ok - research target check separates relevant work sources from lookalike results');
}

{
  const input = '按原作资料建立世界书，不要编造；我的领养背景属于用户原创，不允许额外扩写。';
  const context = buildMaidSourceGroundingContext({
    input,
    steps: [{
      toolName: 'web.research',
      status: 'succeeded',
      args: { target: '目标作品' },
      output: {
        ok: true,
        query: '目标作品 人物',
        targetCheck: { checked: true },
        sources: [
          { title: '目标作品资料', url: 'https://example.com/canon', targetRelevant: true },
          { title: '其他作品', url: 'https://example.com/other', targetRelevant: false },
        ],
      },
    }],
  });
  assert.deepEqual(context.allowedCanonRefs, ['https://example.com/canon']);

  const noLayer = validateMaidWorldbookSourcePlan({
    toolName: 'worldbook.create',
    args: { entries: [{ title: '人物', content: '内容' }] },
    grounding: context,
  });
  assert.equal(noLayer.ok, false);
  assert.equal(noLayer.reason, 'source_layer_required');

  const badCanon = validateMaidWorldbookSourcePlan({
    toolName: 'worldbook.create',
    args: {
      entries: [{
        title: '人物',
        content: '内容',
        sourceLayer: 'canon',
        sourceRefs: ['https://example.com/other'],
      }],
    },
    grounding: context,
  });
  assert.equal(badCanon.ok, false);
  assert.equal(badCanon.reason, 'canon_source_not_verified');

  const goodCanon = validateMaidWorldbookSourcePlan({
    toolName: 'worldbook.create',
    args: {
      entries: [{
        title: '人物',
        content: '内容',
        sourceLayer: 'canon',
        sourceRefs: ['https://example.com/canon'],
      }],
    },
    grounding: context,
  });
  assert.equal(goodCanon.ok, true);

  const userOriginal = validateMaidWorldbookSourcePlan({
    toolName: 'worldbook.create',
    args: {
      entries: [{
        title: '领养背景',
        content: '用户指定内容',
        sourceLayer: 'user_original',
        sourceRefs: ['user_request'],
      }],
    },
    grounding: context,
  });
  assert.equal(userOriginal.ok, true);

  const invented = validateMaidWorldbookSourcePlan({
    toolName: 'worldbook.create',
    args: {
      entries: [{
        title: '额外剧情',
        content: '模型新增内容',
        sourceLayer: 'creative_extension',
      }],
    },
    grounding: context,
  });
  assert.equal(invented.ok, false);
  assert.equal(invented.reason, 'creative_extension_not_allowed');

  const prompt = buildMaidSourceGroundingPromptBlock({ input, steps: [{
    toolName: 'web.research',
    status: 'succeeded',
    output: context.sources.length ? {
      sources: context.sources,
      targetCheck: { checked: true },
    } : {},
  }] });
  assert.match(prompt, /canon/);
  assert.match(prompt, /user_original/);
  assert.match(prompt, /creative_extension/);
  console.log('ok - strict worldbook grounding accepts only verified canon or explicit user-original layers');
}

console.log('maid-source-grounding-tests passed');
