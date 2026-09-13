// Run in the Windows development WebView. Every message/configuration/model is
// isolated in memory; this test never sends a request or writes user app data.
import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

async function smoke() {
  for (let attempt = 0; attempt < 200 && (!window.__chatappBootDiag?.runtimeReady || document.getElementById('app-splash')); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (document.getElementById('app-splash')) throw Error('App is still starting');
  const check = (condition, label) => { if (!condition) throw Error(label); };
  const { extractRenderedAgentBodyText, createRenderedAgentTargetResolver } = await import('/scripts/ui/chat/agent-rendered-body.js');
  const { spliceAgentTextTarget } = await import('/scripts/agent/agent-text-target.js');
  const { createAgentConfigStore } = await import('/scripts/storage/agent-config-store.js');
  const { createAgentConfigurationService } = await import('/scripts/agent/agent-configuration-service.js');
  const { createTextEditRuntime } = await import('/scripts/agent/text-edit-runtime.js');
  const context = { place: 'writing', scopeId: 'rendered-agent-smoke', sessionId: 'rp:rendered-agent-smoke', archiveId: 'isolated' };
  const boundaries = { prefix: '[PRIVATE_START]', suffix: '[PRIVATE_END]' };
  const head = '<think>Hidden thought: Rain &amp; wind.</think>\r\n'
    + '[PRIVATE_START]Rain & wind. Private planning.[PRIVATE_END]\r\n';
  const body = '<content><p>Rain &amp; wind.</p><p>She closed the door.</p></content>';
  const tail = '<tableEdit>updateRow(0,0,{"1":"Rain & wind."})</tableEdit>'
    + '<details><summary>摘要</summary>Hidden summary: She closed the door.</details>'
    + '<summary>Another hidden summary.</summary><table><tr><td>Hidden table cell.</td></tr></table>';
  const original = head + body + tail;
  // This stands in for the current card's display regex, retaining only a
  // harmless visual shell around the exact original natural-language nodes.
  const displayRegex = value => value.replace('<content>', '<span class="display-regex-shell">').replace('</content>', '</span>');
  const expected = 'Rain & wind.\nShe closed the door.';
  const extracted = extractRenderedAgentBodyText(displayRegex(original), { boundaries });
  check(extracted.ok && extracted.text === expected, 'display-regex extraction removes thoughts, configured reasoning boundaries, memory table and summaries');
  const entity = extractRenderedAgentBodyText('<content><p>She smiled &#x1f642; &lt;3 &amp; waved.</p></content>');
  check(entity.ok && entity.text === 'She smiled 🙂 <3 & waved.', 'inert HTML extraction decodes entities');
  const staticCardSource = '<div class="story-card"><p>A static card.</p><p>Second paragraph.</p></div>';
  const staticCard = extractRenderedAgentBodyText(staticCardSource);
  check(staticCard.ok && staticCard.text === 'A static card.\nSecond paragraph.', 'a static div card is accepted without executing it');
  const staticFenceSource = '```html\n<div class="story-card"><p>A fenced static card.</p></div>\n```';
  const staticFence = extractRenderedAgentBodyText(staticFenceSource);
  check(staticFence.ok && staticFence.text === 'A fenced static card.', 'static HTML code cards use inert extraction');
  const excludedOnly = extractRenderedAgentBodyText('<analysis>Hidden.</analysis><details>Hidden.</details><tableEdit>hidden()</tableEdit>');
  check(!excludedOnly.ok, 'no visible body never falls back to hidden raw');
  const interactive = extractRenderedAgentBodyText('```html\n<html><body><script>throw Error("must not execute")</script><p>Dynamic.</p></body></html>\n```');
  check(!interactive.ok, 'interactive HTML requires an explicit original range');
  const dynamicFragment = extractRenderedAgentBodyText('<div><script>document.querySelector("p").textContent = "Changed by a script.";</script><p>Text before the script.</p></div>');
  check(!dynamicFragment.ok, 'original script-driven fragment is rejected before script removal can disguise it as a static card');
  const stylesheetHidden = extractRenderedAgentBodyText('<style>.hidden-thought{display:none}</style><div><p class="hidden-thought">Private thought.</p><p>Body.</p></div>');
  check(!stylesheetHidden.ok && stylesheetHidden.message.includes('样式'), 'CSS-hidden text never reaches a model through an inert projection');
  const hiddenStyles = extractRenderedAgentBodyText('<content><p>Visible.</p><p hidden>Hidden attribute.</p><p style="display:none">Hidden style.</p></content>');
  check(hiddenStyles.ok && hiddenStyles.text === 'Visible.', 'hidden static elements are excluded');

  const resolveTarget = createRenderedAgentTargetResolver({
    getDisplaySource: message => displayRegex(message.rawOriginal),
    getReasoningBoundaries: () => boundaries,
  });
  const initialTarget = await resolveTarget(original, { mode: 'rendered' }, { message: { rawOriginal: original }, context });
  check(initialTarget.ok && initialTarget.text === expected, 'display body uniquely maps to source despite identical hidden strings');
  const cardTarget = await resolveTarget(staticCardSource, { mode: 'rendered' }, { message: { rawOriginal: staticCardSource }, context });
  check(cardTarget.ok && spliceAgentTextTarget(cardTarget, 'A revised card.\nSecond paragraph.') === staticCardSource.replace('A static card.', 'A revised card.'), 'static card edit preserves div and paragraph structure');
  const nbspSource = '<content><p>Tom&nbsp;&amp;&nbsp;Sue.</p></content>';
  const nbspTarget = await resolveTarget(nbspSource, { mode: 'rendered' }, { message: { rawOriginal: nbspSource }, context });
  check(nbspTarget.ok && nbspTarget.text === 'Tom\u00a0&\u00a0Sue.', 'nonbreaking spaces keep reversible HTML-entity offsets');
  check(spliceAgentTextTarget(nbspTarget, 'Tom and Sue.') === '<content><p>Tom and Sue.</p></content>', 'nonbreaking entity text maps back into its original paragraph');
  const entityTarget = await resolveTarget('<content><p>She smiled &#x1f642; &lt;3 &amp; waved.</p></content>', { mode: 'rendered' },
    { message: { rawOriginal: '<content><p>She smiled &#x1f642; &lt;3 &amp; waved.</p></content>' }, context });
  check(entityTarget.ok && spliceAgentTextTarget(entityTarget, 'She smiled & said <hello>.') === '<content><p>She smiled &amp; said &lt;hello&gt;.</p></content>', 'entity target writes escaped replacement into the original HTML shell');
  const inlineSource = '<content><p>She <b>smiled</b>.</p></content>';
  const inline = await resolveTarget(inlineSource, { mode: 'rendered' }, { message: { rawOriginal: inlineSource }, context });
  check(!inline.ok, 'a display line across inline text nodes does not guess a raw replacement');
  const fallback = await resolveTarget(original, { mode: 'tags', start: '<content>', end: '</content>' }, { message: { rawOriginal: original }, context });
  check(fallback.ok && fallback.text === '<p>Rain &amp; wind.</p><p>She closed the door.</p>', 'advanced raw tag selection remains available');

  const memory = new Map(), storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
  const store = createAgentConfigStore({ storage });
  let message = { id: 'reply-isolated', role: 'assistant', type: 'text', rawOriginal: original, content: displayRegex(original), meta: { activeSwipe: 0 } };
  let calls = 0, commits = 0, reviews = 0, confirm = false, sentTarget = '', capturedMode = '';
  const candidate = 'Rain tapped the window.\nShe closed the door.';
  const runtime = createTextEditRuntime({
    getContext: () => context, getMessage: id => id === message.id ? message : null,
    getMessages: () => [message], getRaw: async current => current.rawOriginal,
    getConfig: id => store.read(id, context).config, getBodyRule: () => null, resolveTarget,
    captureModel: async config => { capturedMode = config.modelMode; return { model: 'isolated-vertex-gemini', mock: true }; },
    request: async request => {
      calls++; sentTarget = JSON.parse(request.messages.at(-1).content).target;
      check(sentTarget === expected, 'actual model request is precisely the preview body');
      check(!sentTarget.includes('Hidden') && !sentTarget.includes('Private') && !sentTarget.includes('updateRow'), 'model receives no hidden content');
      return JSON.stringify({ protocolVersion: 'format_patch.v1', baseRevision: request.baseRevision, status: 'patch',
        repairSummary: 'Use a concrete action.', linePatches: [{ startLine: 1, endLine: 1,
          originalLines: ['Rain & wind.'], replacementLines: ['Rain tapped the window.'] }] });
    },
    review: async options => {
      reviews++;
      check(options.originalText === expected, 'review shows display body only');
      check(options.validateCandidate({ candidateText: candidate }).canApply, 'review validates projection before confirming');
      return { confirmed: confirm, changed: true, candidateText: candidate };
    },
    commit: async ({ text, sourceSnapshot, canCommit }) => {
      check(confirm && canCommit() && message.rawOriginal === sourceSnapshot, 'commit requires confirmation and a fresh raw snapshot');
      commits++; message = { ...message, rawOriginal: text, content: displayRegex(text) }; return true;
    },
  });
  const actions = createAgentConfigurationService({ store, runtime, resolveTarget, getContext: () => context,
    getMessages: () => [message], getRaw: async current => current.rawOriginal,
    getProfiles: () => [], getCurrentModelLabel: () => 'Vertex · Gemini (isolated)' });
  try {
    const created = await actions.createTextEditAgent({ context });
    check(created.ok, 'new custom agent is created in isolated store');
    const id = created.id;
    let record = actions.getAgentConfiguration({ id, context });
    check(record.config.target.mode === 'rendered' && record.config.modelMode === 'follow_current', 'new agent defaults to visible body and current model');
    check(record.config.invocationMode === 'auto', 'new agent defaults to automatic execution');
    const saved = await actions.saveAgentConfiguration({ ...record, context, config: { ...record.config, enabled: true,
      prompt: 'Make wording natural. Preserve the original facts and paragraph structure.' } });
    check(saved.ok, 'rendered-body agent enables without custom tags or regex');
    const targetPreview = await actions.getAgentTargetPreview({ id, context });
    const requestPreview = await actions.buildAgentConfigurationPreview({ id, context });
    check(targetPreview.target.ok && targetPreview.target.text === expected, 'target preview shows exact display text');
    check(JSON.parse(requestPreview.messages.at(-1).content).target === expected && calls === 0, 'request preview is identical and makes no model call');
    const manual = await actions.runTextEditAgent({ id, context });
    check(manual.status === 'skipped' && calls === 0, 'auto-only agent does not become a manual toolbox tool');
    const tested = await actions.testTextEditAgent({ id, context });
    check(tested.status === 'succeeded' && calls === 1 && capturedMode === 'follow_current', 'auto-only agent can run one explicit configuration trial');
    check(store.read(id, context).config.invocationMode === 'auto', 'trial preserves invocation mode');
    check(runtime.list().at(-1).invocation === 'test' && runtime.list().at(-1).status === 'ready', 'trial queues a reviewable candidate');
    check(commits === 0 && message.rawOriginal === original, 'receiving model output does not alter the message');
    const runId = tested.artifact.runId;
    check(await runtime.open(runId) === false && commits === 0 && message.rawOriginal === original, 'canceling review preserves original');
    confirm = true;
    check(await runtime.open(runId) === true && commits === 1 && reviews === 2, 'explicitly confirmed candidate writes once');
    check(message.rawOriginal === head + body.replace('Rain &amp; wind.', 'Rain tapped the window.') + tail, 'confirmed edit changes only its original natural-language span');
    check(message.rawOriginal.startsWith(head) && message.rawOriginal.endsWith(tail), 'hidden raw blocks and boundaries remain byte-for-byte unchanged');
    record = actions.getAgentConfiguration({ id, context });
    const disabled = await actions.saveAgentConfiguration({ ...record, context, config: { ...record.config, enabled: false } });
    check(disabled.ok, 'master switch can disable the configured agent');
    const rejected = await actions.testTextEditAgent({ id, context });
    check(rejected.status === 'skipped' && calls === 1, 'master disabled rejects trials before model invocation');
    return { extraction: true, staticCards: true, nonbreakingSpaces: true, hiddenExclusions: true, configuredReasoning: true, entities: true, exactPreviewRequest: true,
      autoOnlyTrial: true, masterSwitch: true, confirmationRequired: true, rawPreserved: true, modelCalls: calls, commits };
  } finally { runtime.dispose(); }
}

const result = await evaluateInApp(`(${smoke.toString()})()`, { timeoutMs: 30000 });
assert.equal(result.rawPreserved, true);
assert.equal(result.modelCalls, 1);
assert.equal(result.commits, 1);
console.log('agent rendered body CDP smoke passed', result);
