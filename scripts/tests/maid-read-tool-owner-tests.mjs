import assert from 'node:assert/strict';
import {listAppFeatures} from '../../src/scripts/agent/app-feature-catalog.js';
import {resolveCandidateCapabilitySelection} from '../../src/scripts/agent/maid-capability-routing.js';
import {normalizeMaidModelPlan,normalizeMaidModelReActDecision} from '../../src/scripts/agent/maid-model-planner.js';

const features=listAppFeatures();
// The two real DeepSeek plans selected an offered read tool with a different
// feature ID. Multiple workflows list that same tool as a prerequisite.
for(const featureId of ['contact_profile.read','worldbook.read']){
 const raw={ok:true,featureId,toolName:'app.read_resource',args:{resource:'persona',name:'林念初',include:['description']}};
 for(const candidateMode of [false,true]){
  const result=normalizeMaidModelPlan(raw,{features,candidateMode});
  assert.equal(result.ok,true,`${featureId}/${candidateMode}: ${result.reason}`);
  assert.equal(result.featureId,'app.resource.read');
  assert.equal(result.toolName,raw.toolName);
  assert.deepEqual(result.args,raw.args);
  assert.equal(result.capabilityCorrection.rule,'explicit_read_tool_owner');
 }
 assert.equal(normalizeMaidModelReActDecision({...raw,action:'tool'}).featureId,'app.resource.read');
}
const candidates=features.filter(f=>['contact_profile.read','persona.create','persona.switch'].includes(f.id));
assert.equal(resolveCandidateCapabilitySelection({featureId:'contact_profile.read',toolName:'app.read_resource',features:candidates}).ok,false,
 'A missing canonical read feature must not escape the candidate snapshot');
const ambiguous=[
 {id:'read.one',tools:['shared.read'],directAction:'shared.read',riskLevel:'low',writes:false},
 {id:'read.two',tools:['shared.read'],directAction:'shared.read',riskLevel:'low',writes:false},
 {id:'read.other',tools:['other.read'],riskLevel:'low',writes:false},
];
assert.equal(resolveCandidateCapabilitySelection({featureId:'read.other',toolName:'shared.read',features:ambiguous}).ok,false);
assert.equal(normalizeMaidModelPlan({ok:true,featureId:'app.resource.read',toolName:'media.fetch_image'}).ok,false);
// completion-memory-dialogue/N07-deepseek: session.compare is also a low-risk
// owner of session.list. That workflow must not make the canonical list owner
// ambiguous when repairing an actually offered prerequisite read.
const captured = {ok:true,action:'tool',toolName:'session.list',args:{limit:100,includeGroups:true},featureId:'group.members.update',title:'查找群聊与联系人'};
for(const candidateMode of [false,true]){
 const result=normalizeMaidModelPlan(captured,{features,candidateMode});
 assert.equal(result.ok,true,`N07 captured read failed: ${result.reason}`);
 assert.equal(result.featureId,'session.list');
 assert.deepEqual(result.args,captured.args);
}
assert.equal(normalizeMaidModelReActDecision(captured).featureId,'session.list');
const help = {ok:true,featureId:'group.members.update',toolName:'app.read_feature_doc',args:{featureId:'group.members.update'}};
for(const candidateMode of [false,true]){
 const result=normalizeMaidModelPlan(help,{features,candidateMode});
 assert.equal(result.ok,true,`generic public documentation read: ${result.reason}`);
 assert.equal(result.featureId,'app.capabilities.search');
 assert.deepEqual(result.args,help.args);
}
assert.equal(normalizeMaidModelPlan(help,{features:features.filter(f=>f.id==='group.members.update'),findFeature:()=>null,candidateMode:true}).ok,false);
console.log('Read owner regression passed: JSON plan/ReAct, candidate scope, ambiguity, and disallowed tools.');
