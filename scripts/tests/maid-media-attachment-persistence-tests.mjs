import assert from 'node:assert/strict';
import { createMaidMediaAssetTools } from '../../src/scripts/agent/tools/media-asset-tools.js';
import { createMaidMediaAttachmentPersistence } from '../../src/scripts/ui/maid-media-attachment-persistence.js';
import { AgentRunStore } from '../../src/scripts/storage/agent-run-store.js';
import { createAgentTaskRuntime } from '../../src/scripts/agent/agent-task-runtime.js';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { buildMaidRunContinuationSnapshot } from '../../src/scripts/agent/maid-run-continuation.js';

const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const runtime = createAgentTaskRuntime({ store: new AgentRunStore({ storage: null }) });
const context = { roleCardId: 'test-card', uiMode: 'chat' };
context.runId = runtime.startRun({ kind: 'maid_assistant', metadata: { maidTaskScope: context } }).id;
let reads = 0, available = true, generations = 0;
const persistence = createMaidMediaAttachmentPersistence({ listRuns: () => runtime.listRuns(), logger: {},
  getReferenceStore: () => ({ load: async refs => { reads++; assert.equal(refs[0].path, 'saved-image.png'); if (!available) throw Error('removed'); return [{ dataUrl }]; } }),
});
const makeTools = () => createMaidMediaAssetTools({ attachmentPersistence: persistence,
  generateImageAttachment: async () => { generations++; return { dataUrl, mime: 'image/png', storedImage: { path: 'saved-image.png', sessionId: 'test-session' } }; },
  prepareImage: async ({ dataUrl }) => ({ dataUrl, width: 1, height: 1, mime: 'image/png', bytes: 70 }),
});
const tool = (tools, name) => tools.find(t => t.name === name);
const tools = makeTools();
const args = { prompt: '小雪头像', subject: '小雪', target: '小雪', purpose: 'avatar', appearance: '黑发', outfit: '白衬衫', style: '动漫', targetAspectRatio: '1:1' };
const generated = await tool(tools, 'media.generate_image').execute(args, context);
assert.equal(generated.ok, true);
assert.ok(generated.attachmentReference?.reference?.path, 'actual successful generation must preserve a durable attachment reference');
const step = runtime.startStep(context.runId, { input: { toolName: 'media.generate_image', args } });
runtime.finishStep(context.runId, step.id, { status: 'succeeded', output: { result: generated } });
const prepareArgs = { attachmentId: generated.attachmentId, purpose: 'avatar' };
// Recreate the tool closure: neither fetchedImages nor preparedImageCache survives a restart.
const restarted = makeTools(), restored = await tool(restarted, 'media.prepare_image').execute(prepareArgs, context);
assert.equal(restored.ok, true);
assert.equal(generations, 1);
assert.equal(reads, 1);
const foreign = { ...context, roleCardId: 'other-card' };
assert.equal((await tool(tools, 'media.prepare_image').execute(prepareArgs, foreign)).reason, 'image_attachment_missing');
assert.equal((await tool(restarted, 'media.prepare_image').execute({ preparedImageId: restored.image.preparedImageId }, foreign)).reason, 'image_attachment_missing');
assert.equal(reads, 1, 'foreign cards cannot read even a known attachment ID');
available = false;
assert.equal((await tool(makeTools(), 'media.prepare_image').execute(prepareArgs, context)).reason, 'image_attachment_missing');
console.log('ok - generated image resumes after restart, remains card scoped, and missing files are not treated as usable');

let observed;
const agent = createMaidAssistantAgent({ logger: {},
  planner: async () => ({ ok: true, toolName: 'media.generate_image', featureId: 'media.generate_image', args }),
  toolRegistry: { executeTool: async () => ({ toolName: 'media.generate_image', status: 'succeeded', result: generated }) },
  reactPlanner: async (_input, context) => { observed = context; return { ok: true, action: 'final', message: '图片已生成' }; },
});
const reply = await agent.runPrompt('给小雪生成一张头像预览', { roleCardId: context.roleCardId, uiMode: 'chat' });
assert.ok(observed.maidReactSteps[0].output.attachmentId, JSON.stringify(observed.maidReactSteps));
assert.equal(observed.maidReactSteps[0].output.attachmentReference, undefined);
assert.equal(observed.lastOutput.attachmentReference, undefined);
assert.ok(reply.steps[0].output.attachmentReference, 'raw receipts keep the reference for local restore');
const snapshot = buildMaidRunContinuationSnapshot({ run: runtime.getRun(context.runId), result: { continuable: true } });
assert.ok(!JSON.stringify(snapshot).includes('saved-image.png'), 'continuation prompts do not disclose native file paths');
console.log('ok - local attachment references persist without entering model observations or continuation prompts');
