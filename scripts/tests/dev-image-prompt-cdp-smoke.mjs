// Windows WebView smoke: isolated per-image drafts, no cloud calls or user writes.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';
const page = await findAppPageTarget(); let socket, sequence = 0; const pending = new Map();
await new Promise((resolve, reject) => { socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => { const m = JSON.parse(raw), waiter = pending.get(m.id); if (!waiter) return; pending.delete(m.id); m.error ? waiter.reject(new Error(m.error.message)) : waiter.resolve(m.result); } }); });
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const ev = code => evaluateInApp(`(async () => { const f = window.__imagePromptSmoke; ${code} })()`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms || 160));
const point = selector => ev(`const el=f.host.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('missing target'); el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};`);
const click = async selector => { const p = await point(selector); await pause(); await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p }); await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p }); await pause(); };
const shot = async name => { const result = await command('Page.captureScreenshot', { format: 'png' }); writeFileSync(`scripts/dev/tmp/image-prompt/${name}.png`, Buffer.from(result.data, 'base64')); };
mkdirSync('scripts/dev/tmp/image-prompt', { recursive: true });
try {
  await command('Emulation.setDeviceMetricsOverride', {width:1180,height:860,deviceScaleFactor:1,mobile:false});
  await evaluateInApp(`(async()=>{
    const {ImagePromptEditor}=await import('/scripts/ui/image-prompt/image-prompt-editor.js');
    const {createImagePromptRuntime}=await import('/scripts/ui/image-prompt/image-prompt-runtime.js');
    const {createChatImagePromptModal}=await import('/scripts/ui/chat-image-prompt-modal.js');
    const {createDefaultImageGenerationPreset,resolveImageGenerationParamSchema,getParamsForImageConfig}=await import('/scripts/ui/image-generation-params-utils.js');
    const {themeManager}=await import('/scripts/ui/theme-manager.js');
    const {themeStore}=await import('/scripts/storage/theme-store.js');
    const host=document.createElement('div');host.className='chat-image-gen-overlay is-active';host.style.zIndex='30000';
    host.innerHTML='<div class="chat-image-gen-modal has-prompt-editor"><header class="chat-image-gen-header"><div class="chat-image-gen-title">生成图片</div></header><div class="chat-image-gen-body"></div></div>';document.body.append(host);
    const f={host,focus:document.activeElement,config:{provider:'novelai',model:'nai-diffusion-4-5-full'},createChatImagePromptModal,resolveImageGenerationParamSchema,getParamsForImageConfig,themeManager,themeStore,theme:themeManager.resolveCurrentTheme()};
    f.preset=createDefaultImageGenerationPreset();f.paramsStore={ready:Promise.resolve(),list:()=>[f.preset],getActive:()=>f.preset};
    f.runtime=createImagePromptRuntime({paramsStore:f.paramsStore});
    f.editor=new ImagePromptEditor({container:host.querySelector('.chat-image-gen-body'),document:{},config:f.config});
    window.__imagePromptSmoke=f;
  })()`);
  assert.equal(await ev(`return f.host.querySelectorAll('.ip-toolbar,.ip-preset-select,.ip-name-form,.ip-import,[data-action="save-as"],[data-action="export"],[data-action="import"]').length;`),0);
  assert.equal(await ev(`return f.host.querySelectorAll('.ip-block-icon').length;`),0);
  assert.equal(await ev(`return f.host.querySelectorAll('.ip-prompt').length;`),2);
  assert.equal(await ev(`return f.host.querySelectorAll('.ip-group,.ip-toggle,.ip-fixed-text,[data-action="add-style"],[data-action="add-negative"]').length;`),0);
  assert.equal(await ev(`return f.host.querySelectorAll('[data-action="add-character"]').length;`),1);
  await click('[data-text-role="positive-main"]');
  await command('Input.insertText',{text:'午后花园，两位旅人在花架下交谈，柔和的自然光。'});
  const focusStyle=await ev(`const el=f.host.querySelector('[data-text-role="positive-main"]');return {outline:getComputedStyle(el).outlineStyle,shadow:getComputedStyle(el).boxShadow,blockShadow:getComputedStyle(el.closest('.ip-prompt-surface')).boxShadow};`);
  assert.equal(focusStyle.outline,'none');assert.equal(focusStyle.shadow,'none');assert.notEqual(focusStyle.blockShadow,'none');
  await shot('simple-prompt-desktop');
  await ev(`f.preset.paramsByProvider.novelai.promptPrefix='watercolor';f.preset.paramsByProvider.novelai.promptSuffix='soft light';f.preset.paramsByProvider.novelai.negativePrompt='blurry';f.editor.setDocument(await f.runtime.getDraft({prompt:'午后花园，两位旅人在花架下交谈，柔和的自然光。',config:f.config}));`);
  assert.equal(await ev(`return f.host.querySelectorAll('.ip-fixed-text').length;`),3);
  assert.equal(await ev(`return getComputedStyle(f.host.querySelector('[data-text-role="positive-main"]').parentElement).borderTopStyle;`),'dashed');
  await click('[data-text-role="positive-prefix"]');await ev(`document.activeElement.select();`);await command('Input.insertText',{text:'ink drawing'});
  await click('[data-text-role="negative-main"]');await command('Input.insertText',{text:'watermark'});
  assert.equal(await ev(`return f.editor.compile().negativePrompt;`),'blurry, watermark');
  assert.match(await ev(`return f.editor.compile().prompt;`),/^ink drawing, /);
  assert.equal(await ev(`return f.preset.paramsByProvider.novelai.promptPrefix;`),'watercolor');
  await ev(`f.editor.blocksEl.scrollTop=0;`);await shot('fixed-prompt-desktop');
  await click('[data-action="add-character"]');await command('Input.insertText',{text:'girl, silver hair, white coat'});
  await click('[data-action="add-character"]');await command('Input.insertText',{text:'girl, black hair, blue coat'});
  assert.equal(await ev(`return f.host.querySelector('.ip-character-count').textContent;`),'2 / 6');
  await ev(`const select=f.host.querySelector('[data-role="position-mode"]');select.value='custom';select.dispatchEvent(new Event('change',{bubbles:true}));f.host.querySelector('.ip-character-extra').open=true;`);await pause();
  await click('.ip-character .ip-position-grid button[data-x="0.1"][data-y="0.3"]');
  assert.deepEqual(await ev(`return f.editor.compile().characters[0].center;`),{x:0.1,y:0.3});
  await ev(`f.editor.document.blocks.find(b=>b.kind==='character').negative='blue eyes';f.snapshot=f.editor.getDocument();f.editor.setConfig({provider:'openai',model:'gpt-image-2.5-sunburst'});`);
  assert.equal(await ev(`return f.editor.compile().negativePrompt;`),'');
  assert.equal(await ev(`return f.editor.getDocument().blocks.find(b=>b.kind==='character').negative;`),'blue eyes');
  await ev(`f.editor.setConfig(f.config);f.editor.blocksEl.scrollTop=0;`);
  await click('.ip-pull-open');assert.equal(await ev(`return f.editor.previewState;`),'split');
  assert.match(await ev(`return f.editor.previewEl.textContent;`),/silver hair/);await shot('fixed-prompt-preview');
  await click('.ip-pull-expand');assert.equal(await ev(`return f.editor.previewState;`),'full');
  await click('.ip-pull-back');await click('.ip-pull-back');
  console.log('passed: two fixed text areas, editable separated defaults, per-run ownership, native positions and preview');

  for(const width of [390,320]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height:860,deviceScaleFactor:1,mobile:true});await pause();
    await ev(`f.editor.blocksEl.querySelectorAll('.ip-block').forEach(el=>el.open=false);f.editor.blocksEl.scrollTop=0;`);await pause();
    assert.equal(await ev(`const el=f.host.querySelector('.chat-image-gen-modal');return el.scrollWidth<=el.clientWidth+1;`),true);
    if(width===390){
      await command('Emulation.setTouchEmulationEnabled',{enabled:true});
      await ev(`f.before=f.editor.getDocument().blocks.filter(b=>b.kind==='character').map(b=>b.id);`);
      const from=await point('.ip-character .ip-drag');
      const to=await ev(`const r=f.host.querySelectorAll('.ip-character')[1].getBoundingClientRect();return {x:r.right-50,y:r.bottom-3};`);
      await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...from,id:1}]});await pause(320);
      assert.equal(await ev(`return Boolean(f.editor.pointer?.active);`),true);
      await command('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...to,id:1}]});
      await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause();
      assert.equal(await ev(`return f.editor.getDocument().blocks.filter(b=>b.kind==='character')[1].id===f.before[0];`),true);
      const p=await point('.ip-pull-open');await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:2}]});await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause();
      assert.equal(await ev(`return f.editor.previewState;`),'full');
      await command('Emulation.setTouchEmulationEnabled',{enabled:false});await ev(`f.editor.setPreview('close');`);
    } else {await ev(`f.themeManager.applyThemePreset({preset:f.themeStore.getTheme('classic-dark')});`);await pause(350);}
    await ev(`f.editor.blocksEl.scrollTop=0;`);await shot(`fixed-prompt-mobile-${width}`);
  }
  console.log('passed: 390/320px layout, right-side touch reorder, touch preview and dark theme');

  await command('Emulation.clearDeviceMetricsOverride');
  await ev(`f.themeManager.applyThemePreset(f.theme);f.host.hidden=true;
    f.factory=f.createChatImagePromptModal({imagePromptRuntime:f.runtime,pickFilesFromInput:async()=>[],getReferencePicker:()=>null,readImageGenerationReferenceFiles:async()=>[],normalizeImageGenerationReferenceItems:items=>items||[]});
    f.modal=f.factory();f.context={config:f.config,schema:f.resolveImageGenerationParamSchema(f.config),baseParams:f.getParamsForImageConfig(f.preset,f.config)};
    f.modal.open({initialPrompt:'ignored',generationParamContext:f.context,generationParamOverrides:{imagePromptDocument:f.snapshot}}).then(value=>{f.result=value;});
    f.runOverlay=[...document.querySelectorAll('#chat-image-gen-overlay')].at(-1);
  `);await pause(400);
  assert.equal(await ev(`return f.runOverlay.querySelector('.chat-image-gen-submit').disabled;`),false);
  assert.equal(await ev(`return f.runOverlay.querySelectorAll('.ip-toolbar').length;`),0);
  await ev(`f.runOverlay.querySelector('.chat-image-gen-submit').click();`);await pause();
  assert.deepEqual(await ev(`return f.result.generationParamOverrides.imagePromptDocument;`),await ev(`return f.snapshot;`));
  await ev(`f.modal.open({initialPrompt:'新的画面',generationParamContext:f.context}).then(value=>{f.nextResult=value;});`);await pause(250);
  assert.equal(await ev(`return f.runOverlay.querySelectorAll('.ip-character').length;`),0);
  assert.equal(await ev(`return f.runOverlay.querySelector('[data-text-role="positive-main"]').value;`),'新的画面');
  assert.equal(await ev(`return f.runOverlay.querySelector('[data-text-role="positive-prefix"]').value;`),'watercolor');
  await ev(`f.modal.destroy();`);assert.equal(await ev(`return f.nextResult;`),null);
  console.log('passed: image snapshot restores exactly, next generation starts separately, no preset persistence');
  await ev(`f.host.hidden=false;const {ImageGenerationParamsPanel}=await import('/scripts/ui/image-generation-params-panel.js');
    f.paramStore={...f.paramsStore,upsert:async value=>{f.savedParams=value;f.preset=value;}};
    f.paramsPanel=new ImageGenerationParamsPanel({store:f.paramStore,getImageConfig:async()=>f.config});
    await f.paramsPanel.showEmbedded({container:f.host.querySelector('.chat-image-gen-body')});
  `);
  assert.equal(await ev(`return f.host.querySelectorAll('[data-param-key="promptPrefix"],[data-param-key="promptSuffix"],[data-param-key="negativePrompt"]').length;`),3);
  assert.equal(await ev(`return f.host.querySelector('[data-param-key="promptPrefix"]').closest('label').querySelector('.has-help')!==null;`),true);
  await ev(`f.host.querySelector('[data-param-key="promptPrefix"]').value='charcoal';f.host.querySelector('[data-param-key="negativePrompt"]').value='';await f.paramsPanel.saveCurrent();`);
  assert.equal(await ev(`return f.savedParams.paramsByProvider.novelai.promptPrefix;`),'charcoal');
  assert.equal(await ev(`return f.savedParams.paramsByProvider.novelai.negativePrompt||'';`),'');
  console.log('passed: fixed prompt parameter fields, title help, saving and clearing through an isolated store');
} finally {
  await ev(`if(f){f.themeManager.applyThemePreset(f.theme);f.editor.destroy();f.host.remove();f.modal?.destroy();f.focus?.focus?.();delete window.__imagePromptSmoke;}`);
  await command('Emulation.setTouchEmulationEnabled',{enabled:false});await command('Emulation.clearDeviceMetricsOverride');socket.close();
}
