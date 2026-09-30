import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAppResourceReader } from '../../src/scripts/agent/app-resource-reader.js';
import { createAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';
import { createAppSessionAgentTools } from '../../src/scripts/agent/tools/app-session-tools.js';
import { classifyMaidOperationIntent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { buildMaidSessionDeletionNotice } from '../../src/scripts/agent/maid-session-deletion-notice.js';

const input = '把重复的阿岚删掉只留一个';
const contextFor = (text = input) => ({
  roleCardId: 'card-current', submissionId: 'submission-current',
  operationIntentPolicy: classifyMaidOperationIntent(text),
});
const decision = { ok:true, action:'final', message:'两位联系人资料不同，建议保留第一位，确认后再删除。', source:'maid_provider_fc' };
const fixture = async () => {
  const contacts = [
    { id:'contact-a', name:'阿岚', description:'爱读书的学姐', isGroup:false },
    { id:'contact-b', name:'阿岚(导入)', description:'喜欢旅行的同学', isGroup:false },
  ];
  const contactsStore = { listContacts:() => contacts, getContact:id => contacts.find(contact => contact.id === id) };
  const chatStore = { listSessions:() => contacts.map(contact => contact.id), getCurrent:() => '',
    getSessionSettings:() => ({}), getMessages:id => id === 'contact-a' ? [{id:'message-a',content:'已保存'}] : [] };
  const registry = createAgentToolRegistry();
  registry.registerMany(createAppNavigationAgentTools({ readResource:createAppResourceReader({contactsStore,chatStore}) }));
  registry.registerMany(createAppSessionAgentTools({ contactsStore,chatStore }));
  const steps = [];
  for(const [toolName,args,featureId] of [
    ['session.list', {}, 'session.compare'],
    ['app.read_resource', {resource:'session',sessionId:'contact-a',include:['description']}, 'app.resource.read'],
    ['app.read_resource', {resource:'session',id:'contact-b',include:['description']}, 'app.resource.read'],
  ]) {
    const result = await registry.executeTool(toolName,args);
    assert.equal(result.status,'succeeded');
    steps.push({toolName,args,featureId,status:result.status,output:result.result});
  }
  return {steps,contacts};
};

test('actual registered reads produce an APP deletion notice without rewriting the model or choosing targets', async () => {
  const {steps,contacts} = await fixture();
  const before = structuredClone({steps,contacts,decision});
  const notice = buildMaidSessionDeletionNotice({input,context:contextFor(),steps,decision});
  assert.ok(notice, 'the APP must supply the missing deterministic risk notice');
  assert.equal(notice.kind,'session_deletion_risk');
  assert.equal(notice.source,'app');
  assert.deepEqual(notice.observedCandidateIds,['contact-a','contact-b']);
  assert.equal(notice.requestRoleCardId,'card-current');
  assert.equal(notice.requestRunId,'submission-current');
  assert.match(notice.message,/聊天记录/);
  assert.match(notice.message,/内部归档/);
  assert.match(notice.message,/APP.*确认/);
  assert.match(notice.message,/批准/);
  for(const key of ['pendingAction','pendingWorkflow','targets','deleteIds','args','toolName']) assert.equal(Object.hasOwn(notice,key),false,key);
  assert.deepEqual({steps,contacts,decision},before);
});

test('no notice for ordinary chat, read-only comparison, negative requests or cancellation', async () => {
  const {steps} = await fixture();
  for(const text of ['陪我聊聊阿岚', '比较两位联系人的资料，只看不删', '不要删除联系人', '我不想把联系人删了', '取消', '把重复联系人删掉，算了', "Don't delete contacts"]){
    assert.equal(buildMaidSessionDeletionNotice({input:text,context:contextFor(text),steps,decision}),null,text);
  }
  assert.equal(buildMaidSessionDeletionNotice({input,context:{...contextFor(),signal:{aborted:true}},steps,decision}),null);
  assert.equal(buildMaidSessionDeletionNotice({input,context:contextFor(),steps,decision:{...decision,status:'cancelled'}}),null);
  assert.equal(buildMaidSessionDeletionNotice({input,context:contextFor(),steps,decision:{...decision,ok:false,reason:'permission_denied'}}),null);
});

test('request identity is required and explicit foreign scope, run or continuation evidence is rejected', async () => {
  const {steps} = await fixture();
  for(const context of [{...contextFor(),roleCardId:''},{...contextFor(),submissionId:''},{...contextFor(),runContinuation:{successfulSteps:steps}}]){
    assert.equal(buildMaidSessionDeletionNotice({input,context,steps,decision}),null);
  }
  for(const changed of [
    {...steps[1],context:{roleCardId:'card-other'}},
    {...steps[1],metadata:{submissionId:'submission-other'}},
    {...steps[1],output:{...steps[1].output,scopeId:'card-other'}},
  ]) assert.equal(buildMaidSessionDeletionNotice({input,context:contextFor(),steps:[steps[0],changed,steps[2]],decision}),null);
});

test('only successful current comparison reads establish observed IDs, never plans, names or failed results', async () => {
  const {steps} = await fixture();
  for(const changed of [
    [],
    [steps[0]],
    steps.map(step=>({...step,featureId:step.featureId==='session.compare'?'session.list':step.featureId})),
    [steps[0],{...steps[1],status:'failed'},steps[2]],
    [steps[0],{...steps[1],output:{ok:false,resource:'session',sessions:steps[1].output.sessions}},steps[2]],
    [steps[0],{...steps[1],output:{...steps[1].output,sessions:[{name:'凭空候选'}]}},steps[2]],
    [...steps,{toolName:'session.delete_many',status:'succeeded',args:{sessions:['contact-b']},output:{ok:true}}],
    [...steps,{toolName:'contact_profile.upsert',status:'succeeded',output:{ok:true}}],
  ]) assert.equal(buildMaidSessionDeletionNotice({input,context:contextFor(),steps:changed,decision}),null);
});

test('the reminder does not inspect natural-language model answers and repeated readbacks do not duplicate observed IDs', async () => {
  const {steps} = await fixture();
  const complete = {...decision,message:'删除会丢失聊天记录，请先批准。'};
  const first = buildMaidSessionDeletionNotice({input,context:contextFor(),steps,decision});
  const second = buildMaidSessionDeletionNotice({input,context:contextFor(),steps:[...steps,steps[1]],decision:complete});
  assert.ok(first);
  assert.deepEqual(second,first,'the fixed APP reminder does not guess whether arbitrary model prose is complete');
});
