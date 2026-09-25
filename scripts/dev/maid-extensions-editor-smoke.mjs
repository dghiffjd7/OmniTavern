import { evaluateInApp } from './cdp-client.mjs';

// Run against the Windows dev WebView (port 9222). Uses memory-only editor actions;
// the only real tool call reads a builtin skill and does not call a model.
const smoke = async () => {
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const { createUtilityAgentEditor } = await import('/scripts/ui/utility-agent-editor.js');
  const { captureAgentEditorDrafts } = await import('/scripts/ui/agent-editor-draft-utils.js');
  const actual = window.appBridge.debugUiRegistry.actions.getAgentConfiguration({ id: 'reply_scoring' });
  let record = structuredClone({ ...actual, profiles: [], config: { ...actual.config, enabled: false, modelProfileId: '' } }), finishSave;
  const actions = {
    getAgentConfiguration: () => structuredClone(record),
    listAgentModelProfiles: async () => [{ id: 'fixture', name: 'Fixture', model: 'fixture' }],
    listUtilityAgentRuns: () => [],
    saveAgentConfiguration: options => {
      const submitted = structuredClone(options.config);
      return new Promise(resolve => { finishSave = () => { record.config = submitted; resolve({ ok: true }); }; });
    },
  };
  const host = document.createElement('div');
  const editor = createUtilityAgentEditor({ actions, id: 'reply_scoring', context: actual.context });
  host.append(editor.node);
  const setPrompt = text => {
    const field = editor.node.querySelector('[name=prompt]'); field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  try {
    await Promise.resolve();
    assert(editor.node.querySelector('[name=profile]').options.length === 2, 'Async profile snapshot missing');
    setPrompt('Submitted draft');
    assert(captureAgentEditorDrafts(host).editors.length === 1, 'Draft sentinel is not detected');
    editor.node.querySelector('[name=sample]').value = 'Text to score';
    editor.node.querySelector('[data-action=save]').click(); setPrompt('Edited while saving'); finishSave();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(record.config.prompt === 'Submitted draft', 'Save did not preserve submitted snapshot');
    assert(editor.node.querySelector('[name=prompt]').value === 'Edited while saving' && editor.hasDraft(), 'Newer draft was lost');
    assert(editor.node.querySelector('[name=sample]').value === 'Text to score', 'Sample was lost');
  } finally { editor.dispose(); host.remove(); }
  const registry = window.appBridge.debugUiRegistry.stores.agentToolRegistry;
  const result = await registry.executeTool('app.read_skill', { skillId: 'avatar.create_and_set' }, { sessionId: actual.context.sessionId, scopeId: actual.context.scopeId });
  assert(result.status === 'succeeded' && result.result?.skill?.id === 'avatar.create_and_set', 'Builtin skill tool failed');
  return { asyncModelOptions: true, draftDetection: true, concurrentEditPreserved: true, samplePreserved: true, skillRead: true };
};

console.log(JSON.stringify(await evaluateInApp(`(${smoke.toString()})()`), null, 2));
