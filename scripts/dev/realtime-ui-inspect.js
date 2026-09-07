(async () => {
  document.querySelector('[data-action="config"]')?.click();
  await new Promise(resolve => setTimeout(resolve, 300));
  const voice = document.querySelector('[data-config-tab="voice"]') || document.querySelector('[data-tab="voice"]');
  if (voice) voice.click();
  await new Promise(resolve => setTimeout(resolve, 500));
  document.querySelector('[data-voice-config-view="realtime"]')?.click();
  await new Promise(resolve => setTimeout(resolve, 500));
  return { title: document.title, realtimeVisible: !!document.querySelector('#config-voice-realtime-card')?.getClientRects().length,
    profileSelector: !!document.querySelector('#rt-profile'), fields: [...document.querySelectorAll('#config-voice-realtime-card input, #config-voice-realtime-card select')].map(el => ({ id: el.id, visible: !!el.getClientRects().length })) };
})()
