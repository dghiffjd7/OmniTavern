// Windows dev WebView：只使用隔离配置；融合格复用目录卡片，正文侧栏只组装请求。
import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

const result = await evaluateInApp(`(async () => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 60));
  for (let i=0;i<100&&!window.appBridge?.debugUiRegistry?.stores?.hopscotchBoardPanel;i++) await tick();
  const registry = window.appBridge.debugUiRegistry;
  check(registry.panels.agentCenterPanel.hide() !== false, '真实 AC 有未保存草稿');
  const {AgentCenterPanel} = await import('/scripts/ui/agent-center-panel.js');
  const {createHopscotchBoardPanel} = await import('/scripts/ui/chat/hopscotch-board-panel.js');
  const {createHopscotchBoardStore} = await import('/scripts/storage/hopscotch-board-store.js');
  const {createHopscotchTurnRuntime,createHopscotchExecutors} = await import('/scripts/ui/chat/hopscotch-turn-runtime.js');
  const local = new Map();
  const store = createHopscotchBoardStore({storage:{getItem:k=>local.get(k),setItem:(k,v)=>local.set(k,v)}});
  await store.setGlobalBoard({rows:[{houses:[{id:'body',kind:'body',fused:['memory_table','image_prompt','variable']}]}]});
  let prompt={enabled:true,rules:'saved image rules'}, board, writes=0, requests=0, builds=0, allowDiscard=false, releaseFirst;
  const runtime=createHopscotchTurnRuntime({boardStore:store,getSettings:()=>({creativeHopscotchEnabled:true}),createExecutors:info=>createHopscotchExecutors({...info,custom:{backgroundChat:async()=>{requests++;return 'unexpected';}}})});
  const actions={
    getMemoryAgentPromptConfig:()=>({templateId:'t1',template:'{{tableData}}',wrapper:'<memory>{{tableData}}</memory>',position:'before_latest_user'}),
    getAgentCenterProfileView:()=>({sysprompt:{presetId:'p1',profile:{agents:{image_director:{prompts:{'auto-image-prompt':prompt}}}}},openai:{presetId:'o1',profile:{agents:{memory_table_agent:{settings:{}}}}}}),
    setAgentPromptConfig:payload=>{check(payload.agentId==='image_director','wrong save target');writes++;prompt=payload.config;return true;},
  };
  const ac=new AgentCenterPanel({getActions:()=>actions,getHopscotchPanel:()=>board,confirm:async()=>allowDiscard});
  board=createHopscotchBoardPanel({embedded:true,boardStore:store,runtime,getSessionId:()=> 'rp:fused-smoke',confirm:async()=>allowDiscard,
    mountAgentCard:(host,options)=>ac.mountHopscotchAgentCard(host,options),
    buildPromptPreview:async context=>{check(context.sessionId==='rp:fused-smoke'&&context.place==='writing','lost preview scope');builds++;if(builds===1)return new Promise(resolve=>{releaseFirst=resolve;});return {model:'local-fixture',messages:[{role:'system',content:'current prompt'},{role:'user',content:'draft input'}]};},
  });
  try {
    ac.show();await ac.refresh();const root=ac.contentElement.querySelector('.hop-embedded');
    const click=(selector,host=root)=>{const n=host.querySelector(selector);check(n,'missing '+selector);n.click();};
    const detail=()=>document.querySelector('.hop-house-detail[open]');
    const flip=()=>click('.agent-center-floating-face:not([inert]) [data-agent-float-flip]',detail());
    const close=()=>click('.agent-center-floating-face:not([inert]) [data-agent-float-close]',detail());
    const title=()=>detail()?.querySelector('.agent-center-floating-card').getAttribute('aria-label');
    for(const [part,id] of [['memory_table','memory_table_agent'],['image_prompt','image_director'],['variable','']]){
      click('[data-hop-part="'+part+'"]');
      check(id ? title()===ac.getAgentCardById(id).title : title() !== ac.getAgentCardById('write_preview').title && detail().querySelector('.hop-variable-info'), 'fused card uses its actual function: '+part);
      check(!detail().querySelector('.agent-center-floating-card').classList.contains('is-flipped'),'same front entry as catalog');
      flip();
      if(part==='memory_table'){
        let input=detail().querySelector('[data-memory-prompt-template]');check(input,'original memory editor missing');input.value='memory draft';input.focus();await ac.refresh();
        input=detail().querySelector('[data-memory-prompt-template]');check(input.value==='memory draft'&&document.activeElement===input,'refresh lost memory draft/focus');
        close();await tick();check(detail(),'dirty draft silently discarded');allowDiscard=true;close();await tick();allowDiscard=false;
      }else if(part==='image_prompt'){
        const input=detail().querySelector('[data-agent-prompt-rules]');check(input.value==='saved image rules','wrong image editor');input.value='image draft';
        click('[data-agent-prompt-save]',detail());await tick();check(prompt.rules==='image draft','save lost original image target');close();await tick();
      }else{
        check(!detail().querySelector('[data-agent-feature-id="write_preview"]') && detail().querySelector('[data-action="variable-preview-tools"]'),'variable activity must be separate from preview tool settings');close();await tick();
      }
    }
    click('[data-hop-part="body"]');flip();
    click('[data-request-action="open"]',detail());check(builds===1,'opening did not build request');
    check(board.closeTopLayer()&&detail(),'back should first close preview');
    releaseFirst({messages:[{role:'system',content:'stale result'}]});await tick();
    check(!detail().querySelector('.hop-request-scroll').textContent.includes('stale result'),'closed preview accepted stale result');
    click('[data-request-action="open"]',detail());await tick();
    check(detail().querySelector('.hop-request-scroll').textContent.includes('draft input'),'body request missing input');
    await ac.refresh();check(builds===2&&detail().querySelector('.hop-request-scroll').textContent.includes('current prompt'),'refresh lost preview snapshot or rebuilt unnecessarily');
    board.closeTopLayer();check(detail(),'back closed whole card');
    click('[data-hop-fused-open="variable"]',detail());check(detail().querySelector('.hop-variable-info'),'body shortcut does not reach the role variable card');close();await tick();
    const turn=runtime.prepareTurn({sessionId:'rp:fused-smoke',rpUiMode:true});await turn.waitForBodyStart();turn.resolveBody({status:'succeeded',messageId:'test'});await turn.turnPromise;
    click('[data-hop-part="memory_table"]');flip();check(detail().querySelector('[data-memory-prompt-template]').matches(':disabled'),'run snapshot edits shared settings');close();await tick();
    check(root.querySelectorAll('[data-hop-house="body"]').length===1,'fusion duplicated execution tasks');
    return {canonicalCards:3,draftsPreserved:true,previewBuilds:builds,staleResultIgnored:true,previewBack:true,readOnly:true,writes,requests};
  }finally{runtime.clearScope();ac.destroy();board.dispose();registry.panels.agentCenterPanel.show();}
})()`);
assert.equal(result.canonicalCards,3);assert.equal(result.requests,0);assert.equal(result.writes,1);
console.log('ok - canonical fused cards, preserved drafts, scoped preview lifecycle and read-only results',result);
