import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';
const page=await findAppPageTarget(), pending=new Map();let client,id=0;
const viewport=await evaluateInApp('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})');
await new Promise((resolve,reject)=>{client=createWsClient(page.webSocketDebuggerUrl,{onOpen:resolve,onError:reject,onMessage:raw=>{const message=JSON.parse(raw),item=pending.get(message.id);if(item){pending.delete(message.id);message.error?item.reject(new Error(JSON.stringify(message.error))):item.resolve(message.result);}}});});
const command=(method,params={})=>new Promise((resolve,reject)=>{const seq=++id;pending.set(seq,{resolve,reject});client.send(JSON.stringify({id:seq,method,params}));});
try {
  await evaluateInApp(`(async()=>{const {openRequestParamsPanel}=await import('/scripts/ui/request-params-panel.js');window.__requestParamsLayout=openRequestParamsPanel({config:{provider:'custom',apiFormat:'responses',customRequestParams:[{name:'reasoning.effort',type:'string',value:'low',enabled:true},{name:'vendor.enabled',type:'boolean',value:false,enabled:true}],excludedGenerationParams:[]}});})()`);
  for(const width of [390,320]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height:780,deviceScaleFactor:1,mobile:true});
    await new Promise(resolve=>setTimeout(resolve,200));
    const metrics=await evaluateInApp(`(()=>{const root=window.__requestParamsLayout.element;const name=root.querySelector('[data-rp-field="name"]');const type=root.querySelector('.api-request-param-type'),value=root.querySelector('.api-request-param-value');const body=root.querySelector('.api-param-filter-body'),footer=root.querySelector('.api-param-filter-footer');const r=name.getBoundingClientRect(),t=type.getBoundingClientRect(),v=value.getBoundingClientRect();return {nameWidth:r.width,valueBelow:v.top>=r.bottom,typeBeside:Math.abs(t.top-v.top)<1,nameFits:name.scrollWidth<=name.clientWidth+1,overflow:body.scrollWidth>body.clientWidth+1,footerVisible:footer.getBoundingClientRect().bottom<=innerHeight};})()`);
    assert.equal(metrics.valueBelow,true);assert.equal(metrics.typeBeside,true);assert.equal(metrics.nameFits,true,'parameter name still clipped');assert.equal(metrics.overflow,false);assert.equal(metrics.footerVisible,true);
    if(process.env.REQUEST_PARAMS_SCREENSHOT_DIR){const {data}=await command('Page.captureScreenshot',{format:'png'});writeFileSync(`${process.env.REQUEST_PARAMS_SCREENSHOT_DIR}/request-params-name-${width}.png`,Buffer.from(data,'base64'));}
    console.log(JSON.stringify({width,...metrics}));
  }
} finally {
  await evaluateInApp('(()=>{window.__requestParamsLayout?.close(); delete window.__requestParamsLayout;})()');
  await command('Emulation.setDeviceMetricsOverride',{...viewport,mobile:false});await command('Emulation.clearDeviceMetricsOverride');client.close();
}
process.exit(0);
