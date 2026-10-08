import assert from 'node:assert/strict';
import test from 'node:test';
import {createMaidAssistantAgent} from '../../src/scripts/agent/maid-assistant-agent.js';
import {findMaidImageTargetMismatch} from '../../src/scripts/agent/maid-image-target-evidence.js';

const actualId='interrupted_fixture_1790753913562_F06_contact_akai';
const inventedId='interrupted_fixture_1790753913562_F06_contact_kai';
const generate = target => ({ok:true,action:'tool',featureId:'media.generate_image',toolName:'media.generate_image',
  args:{subject:'阿凯',subjectAliases:['Kai'],target,purpose:'avatar',prompt:'Kai, silver hair',
    appearance:'silver hair',outfit:'dark coat',style:'anime',targetAspectRatio:'1:1'}});
const read = {ok:true,action:'tool',featureId:'session.list',toolName:'session.list',args:{}};

test('a miscopied target from the native J01 trace is rejected before generation and can be corrected from real evidence',async()=>{
  const calls=[];let phase=0;
  const agent=createMaidAssistantAgent({logger:{warn(){},debug(){}},planner:async()=>read,
    reactPlanner:async(_input,context)=>{
      phase+=1;
      if(phase===1)return generate(inventedId);
      if(phase===2){
        const failure=context.maidReactSteps.at(-1);
        assert.equal(failure.output.reason,'image_target_not_observed');
        assert.deepEqual(failure.output.observedTargets,[{id:actualId,name:'阿凯',kind:'contact'}]);
        assert.equal(failure.output.localToolExecutionSkipped,true);
        return generate(actualId);
      }
      return {ok:true,action:'final',message:'Image generated.'};
    },toolRegistry:{executeTool:async(name,args)=>{
      calls.push({name,args});
      return {toolName:name,status:'succeeded',result:name==='session.list'
        ?{contacts:[{id:actualId,name:'阿凯'}]}
        :{ok:true,attachmentId:'actual-image'}};
    }}});
  const result=await agent.runPrompt('给阿凯生成头像');
  assert.deepEqual(calls.filter(c=>c.name==='media.generate_image').map(c=>c.args.target),[actualId],
    'the invalid ID must never reach the paid generation tool');
  assert.equal(result.ok,true);
});

test('preview labels without a matching observed subject and explicitly named targets remain valid',async()=>{
  for(const target of ['阿凯',actualId,'unbound-preview']){
    const calls=[];let phase=0;
    const request=generate(target);
    if(target==='unbound-preview')request.args.subject='Unrelated original character';
    const agent=createMaidAssistantAgent({logger:{warn(){},debug(){}},planner:async()=>read,
      reactPlanner:async()=>phase++===0?request:{ok:true,action:'final',message:'Preview generated.'},
      toolRegistry:{executeTool:async(name,args)=>{calls.push(name);return {toolName:name,status:'succeeded',result:name==='session.list'
        ?{contacts:[{id:actualId,name:'阿凯'}]}:{ok:true,attachmentId:'preview'}};}}});
    const result=await agent.runPrompt('生成一张头像预览');
    assert.equal(result.ok,true);
    assert.equal(calls.filter(n=>n==='media.generate_image').length,1,target);
  }
});

test('identity evidence excludes failed reads and nested descriptions, and does not guess between namesakes',()=>{
  const rows=[{id:actualId,name:'阿凯'},{id:'other-akai',name:'阿凯'}];
  const step={toolName:'app.read_resource',status:'succeeded',output:{ok:true,resource:'persona',items:rows}};
  const mismatch=findMaidImageTargetMismatch({plan:generate(inventedId),steps:[step]});
  assert.deepEqual(mismatch.observedTargets,rows.map(row=>({...row,kind:'persona'})));
  assert.equal(findMaidImageTargetMismatch({plan:generate(inventedId),steps:[{...step,status:'failed'}]}),null);
  assert.equal(findMaidImageTargetMismatch({plan:generate(inventedId),steps:[{...step,output:{...step.output,ok:false}}]}),null);
  assert.equal(findMaidImageTargetMismatch({plan:generate(inventedId),steps:[{...step,output:{...step.output,items:[],description:rows}}]}),null);
  assert.equal(findMaidImageTargetMismatch({plan:{...generate(inventedId),args:{...generate(inventedId).args,purpose:'wallpaper'}},steps:[step]}),null,
    'wallpaper subjects can differ from the room receiving them');
});
