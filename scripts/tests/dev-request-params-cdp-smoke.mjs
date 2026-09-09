// Windows WebView smoke: isolated in-memory configuration and intercepted fixture requests.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';
const interactionOnly = process.argv.includes('--interaction-only');
const page = await findAppPageTarget(), pending = new Map();
const initialViewport = await evaluateInApp('({width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio})');
let client, sequence = 0, touching = false;
await new Promise((resolve, reject) => {
  client = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const message = JSON.parse(raw), item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
  } });
});
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); client.send(JSON.stringify({id, method, params})); });
const ev = source => evaluateInApp(`(async () => { const f = window.__requestParamsSmoke; ${source} })()`);
const pause = (ms = 180) => new Promise(resolve => setTimeout(resolve, ms));
const screenshot = async name => { if (!process.env.REQUEST_PARAMS_SCREENSHOT_DIR) return; const {data} = await command('Page.captureScreenshot', {format:'png'}); writeFileSync(`${process.env.REQUEST_PARAMS_SCREENSHOT_DIR}/request-params-${name}.png`, Buffer.from(data,'base64')); };
const key = async (name, code, modifiers = 0) => { await command('Input.dispatchKeyEvent', { type:'keyDown', key:name, code, modifiers }); await command('Input.dispatchKeyEvent', { type:'keyUp', key:name, code, modifiers }); };
const tap = async selector => {
  const point = await ev(`const el = f.q(${JSON.stringify(selector)}); f.check(el, 'missing touch target'); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};`);
  touching = true; await command('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{...point,id:1}] });
  await command('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] }); touching = false; await pause();
};
try {
  await command('Emulation.setDeviceMetricsOverride', { width:1200,height:900,deviceScaleFactor:1,mobile:false });
  await evaluateInApp(`(async () => {
    const { ConfigPanel } = await import('/scripts/ui/config-panel.js');
    const { PresetPanel } = await import('/scripts/ui/preset-panel.js');
    const { CustomProvider } = await import('/scripts/api/providers/custom.js');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const oldPanel = document.getElementById('config-panel'), oldOverlay = document.getElementById('config-overlay');
    check(!oldPanel || getComputedStyle(oldPanel).display === 'none', 'API panel contains a user draft');
    if(oldPanel) oldPanel.id='config-panel-smoke-original'; if(oldOverlay) oldOverlay.id='config-overlay-smoke-original';
    const runtime = { id:'request-params-fixture',name:'Request parameters',provider:'custom',apiFormat:'responses',baseUrl:'https://request-params-ui.example/v1',apiKey:'fixture-key',model:'gpt-5',stream:true,connectionMode:'direct',forwardProviderAuth:true,
      customRequestParams:[{name:'vendor.fast',type:'boolean',value:false,enabled:true},{name:'reasoning.effort',type:'string',value:'low',enabled:true},{name:'seed',type:'number',value:0,enabled:false}],excludedGenerationParams:['temperature'] };
    const clone = value => JSON.parse(JSON.stringify(value));
    const manager = {ensureStores:async()=>{},load:async()=>clone(runtime),get:()=>clone(runtime),getDefault:()=>({...runtime,customRequestParams:[],excludedGenerationParams:[]}),getProfiles:()=>[clone(runtime)],getActiveProfile:()=>clone(runtime),getActiveProfileId:()=>runtime.id,listKeys:()=>[],validate:()=>{},save:async data=>{const key=runtime.apiKey;Object.assign(runtime,clone(data));runtime.apiKey=data.apiKey||key;}};
    const panel = new ConfigPanel({ chatConfigManager:manager,imageConfigManager:manager,voiceSharedConfigManager:manager,voiceTtsConfigManager:manager,voiceSttConfigManager:manager,webSearchCredentialManager:manager });
    const oldPreset=document.getElementById('preset-panel'),oldPresetOverlay=document.getElementById('preset-overlay');
    check(!oldPreset||getComputedStyle(oldPreset).display==='none','Preset panel contains a user draft');
    if(oldPreset)oldPreset.id='preset-panel-smoke-original';if(oldPresetOverlay)oldPresetOverlay.id='preset-overlay-smoke-original';
    const preset=new PresetPanel();preset.setRuntimeContext({configPanel:panel});
    panel.onOpenPresetParams=options=>preset.show(options);
    panel.refreshMaidSearchInputs=async()=>{}; panel.updateFcCompatibilitySummary=()=>{};
    const originalRequest = CustomProvider.prototype.request;
    let draftEvents=0, requests=[];panel.emitDraftChange=()=>draftEvents++;
    CustomProvider.prototype.request = async function(req) {
      if(new URL(req.url).hostname!=='request-params-ui.example') return originalRequest.call(this,req);
      requests.push({url:req.url,method:req.method,body:JSON.parse(req.body)});
      return {ok:true,status:200,body:JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}]})};
    };
    window.__requestParamsSmoke = {panel,preset,manager,runtime,clone,check,oldPanel,oldOverlay,oldPreset,oldPresetOverlay,originalRequest,CustomProvider,requests,previousFocus:document.activeElement,get draftEvents(){return draftEvents},q:selector=>panel.requestParamsDialog?.element.querySelector(selector)};
    await panel.show();panel.openGenerationParamFilterDialog();
    check(panel.getFormData().customRequestParams.length===3,'profile rules missing');
    check(!panel.requestParamsDialog.element.querySelector('[data-rp-common]')?.textContent.includes('temperature'),'preset parameter in extra suggestions');
    const managed=panel.requestParamsDialog.element.querySelector('[data-rp-row="1"]');
    check(managed.textContent.includes('由预设管理')&&managed.querySelector('[data-rp-field="enabled"]').disabled,'legacy ownership missing');
  })()`);
  await pause(350);
  let desktop = null;
  if (!interactionOnly) {
  await screenshot('desktop');
  desktop = await ev(`const dialog=f.q('.api-param-filter-dialog'),body=f.q('.api-param-filter-body');const r=dialog.getBoundingClientRect(); f.check(r.top>=0&&r.bottom<=innerHeight,'desktop dialog clipped');f.check(body.scrollWidth<=body.clientWidth+1,'desktop overflow');return {width:r.width,scroll:body.scrollHeight>body.clientHeight};`);
  await key('ArrowRight','ArrowRight');
  assert.equal(await ev(`return f.q('[data-rp-tab="exclude"]').getAttribute('aria-selected');`), 'true');
  await key('ArrowLeft','ArrowLeft');
  await ev(`f.q('[data-rp-field="enabled"]').click(); f.q('[data-rp-action="cancel"]').click();f.check(f.panel.customRequestParams[0].enabled,'cancel modified parent'); f.panel.openGenerationParamFilterDialog();`);
  const editing = await ev(`
    const q=f.q; q('[data-rp-action="json"]').click();
    const editor=q('[data-rp-role="json"]');f.check(!JSON.parse(editor.value).seed,'disabled value leaked into JSON');
    editor.value='{';editor.dispatchEvent(new Event('input',{bubbles:true}));q('[data-rp-action="json"]').click();
    f.check(!q('[data-rp-role="json-editor"]').hidden,'invalid JSON was discarded');f.check(q('[data-rp-role="error"]').textContent,'invalid JSON lacks error');
    editor.value=JSON.stringify({reasoning:{effort:'low'},vendor:{fast:false,weights:[0,1],note:'<b>literal</b>',none:null}});editor.dispatchEvent(new Event('input',{bubbles:true}));q('[data-rp-action="json"]').click();
    f.check(q('[data-rp-role="rows"]').textContent.includes('null'),'null row missing');
    f.check(!q('[data-rp-role="rows"] b'),'input interpreted as HTML');
    q('[data-rp-tab="exclude"]').click(); const input=q('[data-rp-role="exclude-input"]');input.value='vendor.weights';q('[data-rp-action="exclude-add"]').click();
    q('[data-rp-tab="custom"]').click();
    q('[data-rp-role="preview"]').open=true;
    return true;`);
  assert.equal(editing,true); await pause(350);
  await ev(`const body=JSON.parse(f.q('[data-rp-role="preview-json"]').textContent);f.check(body.vendor.fast===false&&body.vendor.none===null,'preview lost typed values');f.check(!('weights' in body.vendor),'nested exclusion missing');f.check(f.q('[data-rp-role="report"]').textContent.includes('已排除'),'report missing'); f.q('[data-rp-action="apply"]').click();f.check(!f.panel.requestParamsDialog,'apply did not close');f.check(f.draftEvents===1,'apply emitted more than once');await f.manager.save(f.panel.getFormData());f.panel.populateForm(await f.manager.load());await f.panel.onTest();f.check(f.requests.length===1,'unexpected fixture request count'); const sent=f.requests[0].body;f.check(sent.vendor.fast===false&&!('weights' in sent.vendor),'test button lost profile parameters');f.check(sent.max_output_tokens===128,'test button lost output cap');f.panel.openGenerationParamFilterDialog();`);
  }
  await ev(`
    f.q('[data-rp-tab="exclude"]').click();const input=f.q('[data-rp-role="exclude-input"]');input.value='top_p';f.q('[data-rp-action="exclude-add"]').click();f.q('[data-rp-tab="custom"]').click();
    f.q('[data-rp-action="json"]').click();f.jsonDraft=f.q('[data-rp-role="json"]').value;f.parentDraft=JSON.stringify(f.panel.getFormData());
    f.check(f.q('[data-rp-role="json-ownership"]').textContent.includes('由预设管理'),'JSON ownership missing');
    f.q('[data-rp-role="json-ownership"] [data-rp-action="preset"]').click();`);
  await pause(400);
  await ev(`f.check(f.preset.currentSectionId==='openai'&&f.preset.element.style.display==='flex','did not navigate to generation params');
    f.check(f.q('.api-param-filter-dialog').getClientRects().length===0,'request dialog still covers preset');
    f.check(f.preset.element.querySelector('[data-param-field="temperature"]')?.textContent==='当前 API 已排除','temperature badge missing');
    f.check(f.preset.element.querySelector('[data-param-field="top_p"]'),'unsaved exclusion badge missing');
    f.preset.hide();`);
  await pause();
  await ev(`f.check(!f.q('[data-rp-role="json-editor"]').hidden&&f.q('[data-rp-role="json"]').value===f.jsonDraft,'navigation lost JSON draft');
    f.check(JSON.stringify(f.panel.getFormData())===f.parentDraft,'navigation applied modal draft');
    f.check(f.panel.element.style.visibility!=='hidden'&&!f.panel.requestParamsDialog.element.classList.contains('is-suspended'),'navigation did not restore API');
    f.q('[data-rp-action="json"]').click();`);
  await ev(`f.q('#api-request-params-title .has-help').focus();`);
  await key('Tab','Tab',8);
  assert.equal(await ev(`return document.activeElement.dataset.rpAction;`),'apply','focus trap failed');
  await key('Escape','Escape');
  assert.equal(await ev(`return !f.panel.requestParamsDialog && f.panel.isOpen();`),true,'Escape closed parent');
  await ev(`f.panel.openGenerationParamFilterDialog();`);
  for(const width of [390,320]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height:780,deviceScaleFactor:1,mobile:true});
    await command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    await ev(`f.q('.api-param-filter-body').scrollTop=0;`); await pause();
    await ev(`const dialog=f.q('.api-param-filter-dialog'),body=f.q('.api-param-filter-body');const r=dialog.getBoundingClientRect(),footer=f.q('.api-param-filter-footer').getBoundingClientRect(); f.check(r.left>=0&&r.right<=innerWidth+1,'mobile dialog overflow');f.check(r.top>=0&&footer.bottom<=innerHeight,'mobile footer clipped');f.check(body.scrollWidth<=body.clientWidth+1,'mobile body overflow');const first=f.q('[data-rp-row]'),n=first.querySelector('.api-request-param-name').getBoundingClientRect(),v=first.querySelector('.api-request-param-value').getBoundingClientRect();f.check(v.top>=n.bottom,'mobile value is not below name');f.check(f.q('[data-rp-field="enabled"]').getBoundingClientRect().height>=44,'toggle hit target too small');`);
    await screenshot('mobile-'+width);
    const before=await ev(`return f.q('[data-rp-field="enabled"]:not(:disabled)').checked;`);
    await tap('[data-rp-field="enabled"]:not(:disabled)');assert.equal(await ev(`return f.q('[data-rp-field="enabled"]:not(:disabled)').checked;`),!before);
    await tap('[data-rp-field="enabled"]:not(:disabled)');
    await tap('[data-rp-tab="exclude"]');assert.equal(await ev(`return !f.q('#request-params-exclude').hidden;`),true);
    await screenshot('exclude-'+width);
    await tap('[data-rp-tab="custom"]');
  }
  await tap('#api-request-params-title .has-help');
  assert.equal(await ev(`return [...document.querySelectorAll('.app-help-tip[aria-hidden="false"]')].some(el=>el.textContent.includes('排除规则最后执行'));`),true,'mobile help missing');
  await screenshot('mobile-help');
  console.log(JSON.stringify({passed:true,desktop,viewports:[1200,390,320],typedValues:true,jsonValidation:true,cancel:true,apply:true,keyboard:true,trustedTouch:true,help:true,phase:interactionOnly?'remaining interactions':'full',fixtureRequests:await ev('return f.requests.length;'),modelRequests:0}));
} finally {
  if(touching) await command('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  await ev(`if(f){f.CustomProvider.prototype.request=f.originalRequest;f.preset.hide();f.preset.element?.remove();f.preset.overlayElement?.remove();f.panel.hide();f.panel.closeCustomSelectMenu();f.panel.element?.remove();f.panel.overlayElement?.remove();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));if(f.oldPanel)f.oldPanel.id='config-panel';if(f.oldOverlay)f.oldOverlay.id='config-overlay';if(f.oldPreset)f.oldPreset.id='preset-panel';if(f.oldPresetOverlay)f.oldPresetOverlay.id='preset-overlay';f.previousFocus?.focus?.({preventScroll:true});delete window.__requestParamsSmoke;}`);
  await command('Emulation.setTouchEmulationEnabled',{enabled:false});
  await command('Emulation.setDeviceMetricsOverride',{...initialViewport,mobile:false});
  await command('Emulation.clearDeviceMetricsOverride');client.close();
}
process.exit(0);
