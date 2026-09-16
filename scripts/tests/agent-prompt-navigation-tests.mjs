import assert from 'node:assert/strict';
import { buildAgentPromptNavigation, renderAgentPromptAnchors } from '../../src/scripts/ui/chat/agent-prompt-navigation-model.js';
import { recordAgentPreviewPromptSource } from '../../src/scripts/agent/agent-prompt-preview-draft.js';

const fields=[
  {id:'memory:guide:output_instruction',label:'写表要求',value:'按当前规则更新表格'},
  {id:'memory:guide:summary_mode',label:'仅摘要模式',value:'仅更新摘要'},
  {id:'memory:template',label:'内容模板',value:'{{tableData}}'},
];
const data='<memories>\n【总体大纲｜rp_outline】\n- [0] 主线进展：已有的表格值\n</memories>';
const guide='<memory_edit_rules>\n按当前规则更新表格\n</memory_edit_rules>';
const request={messages:[{role:'system',content:'预设与角色卡'},{role:'user',content:`${guide}\n\n${data}\n\n用户输入`}],agentPromptContext:{memory:{dataPromptText:data,guidePromptText:guide}}};
const before=structuredClone(request), nav=buildAgentPromptNavigation(request,fields);
assert.equal(nav.targets.get('memory:guide').start,0);
assert.equal(nav.targets.get('memory:data').start,guide.length+2);
assert.equal(nav.targets.get('field:memory:guide:output_instruction').messageKey,'request:1');
assert.equal(nav.targets.get('field:memory:template').anchorKey,'memory:data');
assert(!nav.targets.has('field:memory:guide:summary_mode'),'inactive update modes must not claim a different instruction');
assert.equal(nav.contexts.find(item=>item.key==='memory:data').content,data);
assert.equal(nav.contexts.find(item=>item.key==='memory:guide').content,guide);
const html=renderAgentPromptAnchors(nav.messages[1],value=>value);
assert.equal(html.replace(/<\/?span\b[^>]*>/g,''),request.messages[1].content,'navigation must preserve every character and read-only value');
assert.deepEqual(request,before);

for(const messages of [[{role:'user',content:`${data}\n${data}`}],[{role:'user',content:`${data}\n${data}`},{role:'user',content:data}]]) {
  const ambiguous=buildAgentPromptNavigation({...request,messages},fields);
  assert(!ambiguous.targets.has('memory:data'),'duplicated content must not jump to a quotation');
}
const format=buildAgentPromptNavigation({messages:[{role:'system',content:'固定检查协议'},{role:'system',content:'自定义任务要求'}],sections:[{editFields:['prompt']},{editField:'prompt'}]},[{id:'prompt',value:'自定义任务要求'}]);
assert.equal(format.targets.get('field:prompt').messageKey,'request:1','prefer explicit own task over the fixed protocol');
const stages=buildAgentPromptNavigation({messages:[{role:'system',content:'任务'}],sections:[{editField:'prompt'}],stages:[{messages:[{role:'system',content:'任务'}],sections:[{editField:'prompt'}]}]},[{id:'prompt',value:'任务'}]);
assert(stages.targets.has('field:prompt'));
assert(stages.stages[0].targets.has('request:stage:0:field:prompt'),'later requests need distinct anchor identities');

const context={meta:{previewOnly:true,agentPromptDraft:{agentId:'dialogue_agent'},agentPromptSources:[]}};
recordAgentPreviewPromptSource(context,'dialogue','已展开宏的指导');
recordAgentPreviewPromptSource(context,'group','另一个 Agent');
recordAgentPreviewPromptSource(context,'dialogue','重复');
assert.deepEqual(context.meta.agentPromptSources,[{fieldId:'agent:dialogue',content:'已展开宏的指导'}]);
const actual={meta:{...context.meta,previewOnly:false,agentPromptSources:[]}};
recordAgentPreviewPromptSource(actual,'dialogue','实际请求');
assert.deepEqual(actual.meta.agentPromptSources,[]);
const expanded=buildAgentPromptNavigation({messages:[{role:'user',content:'前言\n已展开宏的指导\n后文'}],agentPromptContext:{sources:context.meta.agentPromptSources}},[{id:'agent:dialogue',value:'{{char}} 的指导'}]);
assert.equal(expanded.targets.get('field:agent:dialogue').start,3);
console.log('PASS merged request anchors, exact fields, read-only values, absent modes, duplicate rejection, stage identities and preview-only rendered sources');
