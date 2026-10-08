import assert from 'node:assert/strict';
import test from 'node:test';
import {createAgentToolRegistry} from '../../src/scripts/agent/agent-tool-registry.js';
import {listAppFeatures} from '../../src/scripts/agent/app-feature-catalog.js';
import {createMaidCapabilityRoutingRuntime} from '../../src/scripts/agent/maid-capability-routing.js';

const setup = () => {
  const features = listAppFeatures();
  const registry = createAgentToolRegistry({permissionEvaluator:{evaluateTool:()=>({decision:'allow'})}});
  for (const name of new Set(features.flatMap(f=>f.tools))) registry.register({name,
    schema:{type:'object',properties:{}},riskLevel:'low',execute:async()=>({ok:true})});
  const runtime = createMaidCapabilityRoutingRuntime({toolRegistry:registry,features,storage:null});
  runtime.setConfig({mode:'bounded'});
  return runtime;
};
const input = '给所有没头像的人都生一个';
const hasGeneration = snapshot => snapshot.candidateFeatures.some(f=>f.tools.includes('media.generate_image'));

test('colloquial image generation is discoverable without an earlier assistant reply', () => {
  const runtime=setup(),request=runtime.beginRequest({input});
  const snapshot=runtime.prepareDecision({requestId:request.id,input,context:{uiMode:'rp',activePage:'contacts'}});
  assert.equal(snapshot.useCandidates,true);
  assert.ok(hasGeneration(snapshot));
  const cancelled=runtime.prepareDecision({input:'不要给没头像的人生一个，只查看名单'});
  assert.ok(!cancelled.candidateRefs.some(r=>r.id==='media.generate_image'&&r.reasonCodes.includes('semantic_concept')));
});

test('successful resource content and static help do not replace the requested generation tools', () => {
  // Reduced from the native F06 trace: all targets were found, but the resource
  // reader's generic worldbook help and one contact's weather hobby displaced
  // the image tool from the very next provider request.
  const runtime=setup(),request=runtime.beginRequest({input}),steps=[];
  const context={uiMode:'rp',activePage:'contacts',maidConversationContext:{historyText:
    '用户: 给所有没头像的人都生一个\n结果: 目前没有头像的联系人只有社团简介，是否按日常形象生成动漫头像并设置？'}};
  let snapshot=runtime.prepareDecision({requestId:request.id,input,context,steps});
  assert.ok(hasGeneration(snapshot));
  for (const step of [
    {toolName:'session.list',featureId:'session.list',args:{includeGroups:false,hasAvatar:false},status:'succeeded',
      summary:'listed 2 session(s)',output:{contacts:[{id:'weather-member',name:'时雨'},{id:'music-member',name:'南星'}]}},
    {toolName:'app.read_resource',featureId:'session.compare',args:{resource:'session',include:['description']},status:'succeeded',
      summary:'read session resources',output:{ok:true,resource:'session',count:2,
        contentHint:'会话默认仅返回摘要；精确群成员用 include:["members"]，角色卡继承世界书与 session 直接绑定证据用 include:["worldbooks"]。',
        sessions:[{id:'weather-member',name:'时雨',description:'气象社成员，记录每日天气'},
          {id:'music-member',name:'南星',description:'音乐社成员，正在学习吉他'}]}},
  ]) {
    runtime.observeDecision(snapshot,{ok:true,toolName:step.toolName,featureId:step.featureId,args:step.args});
    steps.push(step);
    snapshot=runtime.prepareDecision({requestId:request.id,input,context,steps,phase:'react'});
  }
  assert.ok(hasGeneration(snapshot),'the next real FC request must still offer image generation');
  assert.ok(!snapshot.candidateRefs.some(r=>r.id==='worldbook.bind_persona'&&r.reasonCodes.includes('observation')),
    'reader help about another domain is not a request to bind worldbooks');
  assert.ok(snapshot.candidateFeatures.length<=8,'keep the existing bounded candidate count');
});
