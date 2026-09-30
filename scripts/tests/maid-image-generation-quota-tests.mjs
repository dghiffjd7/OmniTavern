import assert from 'node:assert/strict';
import { createMaidAssistantAgent, classifyMaidOperationIntent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
const args = (prompt, target = 'Lilith', purpose = 'avatar') => ({prompt, target, purpose, subject: target,
  appearance:'pink hair',outfit:'black dress',style:'anime',targetAspectRatio:'1:1'});
const plan = input => ({ok:true,action:'tool',featureId:'media.generate_image',toolName:'media.generate_image',args:input});
async function run(input, requests) {
  const calls=[];let index=0;
  const agent=createMaidAssistantAgent({logger:{warn(){},debug(){}},
    planner:async()=>plan(requests[index++]),
    reactPlanner:async()=>index<requests.length?plan(requests[index++]):{ok:true,action:'final',message:'Generated preview is available.'},
    toolRegistry:{executeTool:async(name,parameters)=>{
      calls.push(parameters);return {toolName:name,status:'succeeded',result:{ok:true,attachmentId:`generated-${calls.length}`}};
    }},
  });
  return {result:await agent.runPrompt(input),calls};
}
const corrected=await run('太成熟了，要萌一点的',[args('cute'),args('super cute'),args('even cuter')]);
assert.equal(corrected.calls.length,1,'Successful preview already consumes the authorized image quota before an avatar write');
const reused=corrected.result.steps.find(step=>step.output?.localToolExecutionSkipped);
assert.equal(reused.output.attachmentId,'generated-1');
assert.equal(reused.output.alreadyApplied,false,'Generation is not proof of avatar application');
assert(corrected.result.steps.filter(s=>s.output?.localToolExecutionSkipped).every(s=>s.output.generatedVariantCount===1),'Repeated skipped calls must not increase the count of actual generated variants');
const two=await run('给 Lilith 生成两张头像预览',[args('first'),args('second'),args('unrequested third')]);
assert.equal(two.calls.length,2,'An explicitly requested second preview remains allowed');
const targets=await run('为两人各生成头像',[args('first','Lilith'),args('second','Xiaoxue')]);
assert.equal(targets.calls.length,2,'Independent targets have independent quotas');
console.log('ok - successful previews consume their target quota without claiming application or blocking requested variants');

for(const input of ['昨天那个弄好了吗','刚才的头像做好了没','上次的任务完成了吗','Is the earlier task done yet?'])
  assert.equal(classifyMaidOperationIntent(input).mode,'read_only',input);
for(const input of ['请生成头像，弄好后设置','帮我生成头像，做好了吗再告诉我','头像做好了，再生成壁纸'])
  assert.equal(classifyMaidOperationIntent(input).mode,'write_allowed',input);
console.log('ok - task status questions are read-only; explicit generation commands retain their authorization');
let billedCalls=0;
const registry=createAgentToolRegistry({permissionEvaluator:{evaluateTool:()=>({decision:'allow',checks:[]})},logger:{warn(){}}});
registry.register({name:'media.generate_image',capabilities:{read:false,write:true},riskLevel:'medium',
  execute:async()=>{billedCalls++;return {ok:true,attachmentId:'must-not-be-generated'};}});
const statusAgent=createMaidAssistantAgent({toolRegistry:registry,planner:async()=>plan(args('unrequested continuation')),logger:{warn(){},debug(){}}});
const statusResult=await statusAgent.runPrompt('昨天那个弄好了吗');
assert.equal(billedCalls,0);
assert.equal(statusResult.steps[0].failureCode,'write_intent_required');
console.log('ok - production registry rejects billed image generation selected during a status question');
