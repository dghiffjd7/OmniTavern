import assert from 'node:assert/strict';
import { applyMemoryPromptFields, buildMemoryPromptEditorFields, mergeMemoryPromptDraft } from '../../src/scripts/memory/memory-prompt-editor.js';
import { buildMemoryEditGuide } from '../../src/scripts/memory/memory-edit-guide.js';
import { formatMemoryPromptText } from '../../src/scripts/memory/memory-prompt-locale.js';
import { buildMemoryTablePlan } from '../../src/scripts/memory/memory-prompt-utils.js';
import { applyAgentPreviewPresetDraft, applyAgentPreviewMemorySettings } from '../../src/scripts/agent/agent-prompt-preview-draft.js';
import { getRequestPromptFieldIds } from '../../src/scripts/ui/chat/agent-prompt-fields.js';
import { createAgentCenterPromptPreview } from '../../src/scripts/ui/agent-center-prompt-preview.js';
import { buildAgentSidecarPromptPreview } from '../../src/scripts/ui/chat/agent-sidecar-prompt-preview.js';
import { buildMemoryUpdateRequest } from '../../src/scripts/ui/chat/memory-update-runtime-utils.js';
import { createMomentCommentLifecycleRuntime } from '../../src/scripts/ui/chat/moments-runtime-utils.js';

const tables = [{id:'rp_outline',name:'总体大纲',scope:'contact',usage:'rp',columns:[{id:'section',name:'分节'},{id:'outline',name:'大纲'}],sourceData:{updateNode:'更新既有分节。'}}];
const record = {id:'test',schema:{tables},injection:{template:'{{tableData}}',wrapper:'<memories>{{tableData}}</memories>',extra:'preserved'}};
const rows = [{id:'row-1',table_id:'rp_outline',row_data:{section:'plot',outline:'男主与姐姐长期生活在这里。'},sort_order:1}];
const snapshot = structuredClone({record,rows});
const plan = present => buildMemoryTablePlan({rows,tableById:new Map(present.map(table => [table.id,table])),tableOrder:['rp_outline'],autoExtract:true,maxRows:10,tokenBudgetData:5000});
const baseline = plan(tables);
assert.deepEqual(plan(applyMemoryPromptFields(tables)),baseline,'no override must leave the existing prompt, rows and indices unchanged');
const guide = present => buildMemoryEditGuide({tableOrder:['rp_outline'],tableById:new Map(present.map(table => [table.id,table]))});
assert.equal(guide(applyMemoryPromptFields(tables)),guide(tables));
const fields = buildMemoryPromptEditorFields(record);
assert(fields.some(field => field.id === 'outline:plot'));
assert(!fields.some(field => field.value.includes('男主与姐姐')),'table values never enter the editable field contract');
const draft = mergeMemoryPromptDraft(record,{promptFields:{'outline:plot':'故事主线','table:rp_outline:name':'故事大纲','table:rp_outline:rule:updateNode':'只更新有变化的分节。','guide:output_instruction':'使用规定的 JSON 写表。','row-1':'tampered','table:rp_outline:id':'wrong'}});
const presented = applyMemoryPromptFields(tables,draft.injection.promptFields);
const editedPlan = plan(presented);
assert(editedPlan.tableData.includes('故事大纲') && editedPlan.tableData.includes('故事主线'));
assert(editedPlan.tableData.includes(rows[0].row_data.outline));
assert.deepEqual(editedPlan.rowIndexMap,baseline.rowIndexMap);
assert.equal(presented[0].id,'rp_outline');
assert.equal(draft.injection.extra,'preserved');
assert(!Object.hasOwn(draft.injection.promptFields,'row-1'));
assert(buildMemoryEditGuide({tableOrder:['rp_outline'],tableById:new Map(presented.map(table => [table.id,table])),promptFields:draft.injection.promptFields}).includes('使用规定的 JSON 写表。'));
assert.deepEqual({record,rows},snapshot);
assert(!mergeMemoryPromptDraft(draft,{promptFields:{'outline:plot':'主线进展'}}).injection.promptFields['outline:plot']);
const dynamicDraft = mergeMemoryPromptDraft(record,{promptFields:{'guide:summary_required':'请新增{table}。'}});
assert.equal(formatMemoryPromptText('memory.edit.summary_required','',{table:'当前摘要'},dynamicDraft.injection.promptFields),'请新增当前摘要。');
assert(fields.some(field => field.id === 'guide:summary_mode'));
console.log('PASS memory presentation edits preserve table values, identifiers, defaults and unknown injection settings');

const preset = {dialogue_rules:'saved dialogue',group_rules:'foreign'};
const meta = {previewOnly:true,agentPromptDraft:{agentId:'dialogue_agent',prompts:{dialogue:{rules:'draft',presetId:'p1'},group:{rules:'wrong'}}}};
assert.deepEqual(applyAgentPreviewPresetDraft(preset,{meta},'p1'),{dialogue_rules:'draft',group_rules:'foreign'});
assert.equal(applyAgentPreviewPresetDraft(preset,{meta:{...meta,previewOnly:false}}),preset);
assert.equal(preset.dialogue_rules,'saved dialogue');
assert.throws(() => applyAgentPreviewPresetDraft(preset,{meta},'other'),/预设/);
const context = {meta:{previewOnly:true,agentPromptDraft:{agentId:'memory_table_agent',memorySettings:{dataPosition:'before_system',guideDepth:3}}}};
const effective = applyAgentPreviewMemorySettings(context);
assert.equal(effective.meta.memoryInjectPosition,'before_system');
assert.equal(effective.meta.memoryGuideDepth,3);
assert.equal(context.meta.memoryInjectPosition,undefined);
const inherited = applyAgentPreviewMemorySettings({meta:{previewOnly:true,memoryInjectPosition:'before_system',memoryInjectDepth:9,
  agentPromptDraft:{agentId:'memory_table_agent',memorySettings:{dataPosition:'',dataDepth:7}}}}, {memoryInjectPosition:'after_system',memoryInjectDepth:2});
assert.equal(inherited.meta.memoryInjectPosition,'after_system');assert.equal(inherited.meta.memoryInjectDepth,2);
assert.deepEqual(getRequestPromptFieldIds({content:'same',editFields:['row-1','prompt']},[{id:'prompt',value:'same'}]),['prompt']);
assert.deepEqual(getRequestPromptFieldIds({content:'same'},[{id:'prompt',value:'same'}]),[]);
console.log('PASS preview drafts are request-local and ownership comes from explicit fields, never matching text');

let current = {key:'room:1',sessionId:'room:1',uiMode:'chat'}, sceneCalls = 0, momentCalls = 0;
const routePreview = createAgentCenterPromptPreview({getContext:() => current,resolveRoute:() => ({requestKind:'body'}),buildScene:async options => {sceneCalls++;assert.equal(options.includeHistory,true);return {messages:[{role:'system',content:options.agentPromptDraft.agentId}]};},buildMoment:async () => {momentCalls++;return {messages:[]};}});
for (const id of ['lineage_agent','execution_lane_agent','write_preview']) assert.equal((await routePreview({agentId:id})).messages.length,0);
assert.equal(sceneCalls,0);
await routePreview({agentId:'group_agent'});assert.equal(sceneCalls,1);
await routePreview({agentId:'moment_agent',draft:{task:'moment-comment'}});assert.equal(momentCalls,1);
current = {key:'empty',sessionId:'',uiMode:'chat'};
await routePreview({agentId:'memory_table_agent'});assert.equal(sceneCalls,1);
console.log('PASS catalogue routes preserve current context and local cards never fall back to ordinary chat');

let release;
current = {key:'room:1',sessionId:'room:1',uiMode:'chat'};
const pendingRoute = createAgentCenterPromptPreview({getContext:() => current,resolveRoute:() => ({requestKind:'body'}),buildScene:() => new Promise(resolve => { release = resolve; })});
const pending = pendingRoute({agentId:'dialogue_agent'});
current = {key:'room:2',sessionId:'room:2',uiMode:'chat'};
release({messages:[{role:'system',content:'stale'}]});
await assert.rejects(pending,/会话已变化/);

let modelCalls = 0;
const memoryPlan = {promptText:'指导\n真实表格值',dataPromptText:'真实表格值',guidePromptText:'指导'};
const memoryPreview = await buildAgentSidecarPromptPreview({input:'unused',context:{session:{id:'room:1'},meta:{previewOnly:true,agentPromptDraft:{requestKind:'memory_update',promptFields:{'guide:output_instruction':'draft'}}}},
  bridge:{buildMemoryPromptPlan:async ctx => {assert.equal(ctx.meta.memoryAutoExtract,true);assert.deepEqual(ctx.history,[]);return memoryPlan;},generate:() => {modelCalls++;}},
  getMemoryHistory:() => '当前聊天记录',getMemoryConfig:async () => ({model:'test'})});
assert.deepEqual(memoryPreview.messages,buildMemoryUpdateRequest({promptText:memoryPlan.promptText,historyText:'当前聊天记录'}).messages);
assert.equal(modelCalls,0);
assert.equal(memoryPreview.agentPromptContext.memory,memoryPlan);
console.log('PASS independent memory preview reuses the production task messages without calling the main model');

const effects = [];
const runtime = createMomentCommentLifecycleRuntime({getIsConfigured:() => false,isOnline:() => false,
  getMoment:() => ({id:'m1',author:'Alice',content:'已有动态',originSessionId:'room:1',comments:[]}),
  getActiveUserProfile:() => ({name:'User'}),getActiveUserName:() => 'User',
  contactsStore:{listContacts:() => [{id:'room:1',name:'Alice'}]},
  bumpMomentEngagement:() => effects.push('engagement'),recordLifecycleEvent:() => effects.push('trace'),
  generate:() => effects.push('request'),showMissingConfig:() => effects.push('dialog'),saveRawReply:() => effects.push('save'),
});
const momentPreview = await runtime('m1','已有评论',{previewOnly:true,agentPromptDraft:{agentId:'moment_agent'}});
assert.equal(momentPreview.ok,true);
assert.equal(momentPreview.context.meta.previewOnly,true);
assert.equal(momentPreview.input,'已有评论');
assert.equal(momentPreview.context.task.type,'moment_comment');
assert.deepEqual(effects,[]);
console.log('PASS moment preview builds the real task context without engagement, traces, dialogs or generation');
