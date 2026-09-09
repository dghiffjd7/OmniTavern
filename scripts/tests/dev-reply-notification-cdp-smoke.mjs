// Windows-only: isolated settings UI + native notifications. No model calls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';

const styleOnly = process.argv.includes('--style-only');
const activationOnly = process.argv.includes('--activation-only');
const policiesOnly = process.argv.includes('--policies-only');
const uiOnly = process.argv.includes('--ui-only') || styleOnly, nativeOnly = process.argv.includes('--native-only') || activationOnly || policiesOnly;
const output = process.env.REPLY_SCREENSHOT_DIR;
if (output) mkdirSync(output, { recursive: true });
const ev = source => evaluateInApp(`(async () => { const f=window.__replyNotificationFixture; ${source} })()`);
const waitFor = async (source, timeout = 8000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await ev(source)) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Timed out: ${source}`);
};
const ps = script => execFileSync('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop'; ${script}`], { encoding: 'utf8', timeout: 20000 }).trim();
const windowApi = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ReplyWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(IntPtr cls,string title);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool yes);
  public static bool Focus(IntPtr h) {
    uint self=GetCurrentThreadId(),other=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero);
    bool attached=self!=other && AttachThreadInput(self,other,true);
    try {return SetForegroundWindow(h);} finally {if(attached) AttachThreadInput(self,other,false);}
  }
}'; $replyProcess=Get-Process omnitavern | Select-Object -First 1; $replyWindow=[ReplyWindow]::FindWindow([IntPtr]::Zero,'OmniTavern');
if (!$replyWindow -or $replyWindow -eq [IntPtr]::Zero) {throw 'No OmniTavern window'}; `;
const setWindow = mode => ps(windowApi + (mode === 'minimized'
  ? '[void][ReplyWindow]::ShowWindowAsync($replyWindow,6)'
  : mode === 'foreground'
    ? '[void][ReplyWindow]::ShowWindowAsync($replyWindow,9); $replyShell=New-Object -ComObject WScript.Shell; [void]$replyShell.AppActivate($replyProcess.Id); [void][ReplyWindow]::Focus($replyWindow); if ([ReplyWindow]::GetForegroundWindow() -ne $replyWindow) {throw "Development window is not foreground"}'
    : '[void][ReplyWindow]::ShowWindowAsync($replyWindow,4); $replyOther=Get-Process | Where-Object {$_.MainWindowHandle -ne [IntPtr]::Zero -and $_.ProcessName -notin @("omnitavern","powershell","conhost") -and ![ReplyWindow]::IsIconic($_.MainWindowHandle)} | Select-Object -First 1; if (!$replyOther) {throw "Open another desktop app to check background notification timing"}; $replyShell=New-Object -ComObject WScript.Shell; [void]$replyShell.AppActivate($replyOther.Id); [void][ReplyWindow]::Focus($replyOther.MainWindowHandle); if ([ReplyWindow]::GetForegroundWindow() -eq $replyWindow) {throw "Development window is still foreground"}'));
const page = await findAppPageTarget(), calls = new Map(); let socket, seq = 0;
await new Promise((resolve, reject) => {
  socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
    const message = JSON.parse(raw), call = calls.get(message.id); if (!call) return;
    calls.delete(message.id); message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result);
  } });
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; calls.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const screenshot = async name => {
  if (!output) return;
  await new Promise(resolve => setTimeout(resolve, 350));
  const { data } = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${output}/${name}.png`, Buffer.from(data, 'base64'));
};
let prepared = false;
try {
  await waitFor(`return !!window.appBridge?.debugUiRegistry?.actions?.handleAndroidBack;`, 20000);
  await ev(`
    const { replyNotificationService:service, createReplyNotificationService } = await import('/scripts/ui/reply-notification-service.js');
    const { safeInvoke:invoke } = await import('/scripts/utils/tauri.js');
    const registry=window.appBridge.debugUiRegistry;
    const panel=registry.panels.generalSettingsPanel;
    const original=await service.load();
    if(!original.supported)throw new Error('Windows notification backend unavailable');
    window.__replyNotificationFixture={service,invoke,panel,original,opened:[],createReplyNotificationService,
      panelVisible:panel.element?.style.display,focus:document.activeElement};
    return true;
  `); prepared = true;
  if (styleOnly) {
    await ev(`await f.service.configure({enabled:false});f.panel.show();document.querySelector('[data-reply-notification-settings]').scrollIntoView({block:'center'});document.querySelector('#general-reply-notification-enabled').click();`);
    await waitFor(`const input=document.querySelector('#general-reply-notification-enabled'),label=input.closest('label');return input.checked&&!input.disabled&&label.classList.contains('is-on')&&!label.classList.contains('is-disabled');`);
    await screenshot('reply-notification-on');
    await ev(`document.querySelector('#general-reply-notification-enabled').click();`);
    await waitFor(`const input=document.querySelector('#general-reply-notification-enabled'),label=input.closest('label');return !input.checked&&!input.disabled&&label.classList.contains('is-off')&&!label.classList.contains('is-disabled');`);
    await screenshot('reply-notification-off');
    console.log('PASS notification setting styles track the saved checkbox state');
  }
  if (!nativeOnly && !styleOnly) {
    await ev(`await f.service.configure({enabled:false});f.panel.show();
      f.panel.element.querySelector('[data-reply-notification-settings]').scrollIntoView({block:'center'});`);
    const hidden = await ev(`return { checked:document.querySelector('#general-reply-notification-enabled').checked,
      timing:!!document.querySelector('#general-reply-notification-timing,[data-reply-notification-options]'),
      testButton:[...f.panel.element.querySelectorAll('button')].some(el=>/测试通知|Test notification/.test(el.textContent)) };`);
    assert.deepEqual(hidden, { checked: false, timing: false, testButton: false });
    await screenshot('reply-notification-off');
    await ev(`document.querySelector('#general-reply-notification-enabled').click();`);
    await waitFor(`return f.service.get().enabled && !document.querySelector('#general-reply-notification-enabled').disabled;`);
    assert.equal(await ev(`return !!document.querySelector('#general-reply-notification-timing,[data-reply-notification-options]');`), false);
    await screenshot('reply-notification-on');
    await ev(`document.querySelector('#general-reply-notification-enabled').focus();`);
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await waitFor(`return !f.service.get().enabled&&!document.querySelector('#general-reply-notification-enabled').disabled;`);
    const layout = await ev(`const section=document.querySelector('[data-reply-notification-settings]'), input=document.querySelector('#general-reply-notification-enabled'), label=input.closest('label'), title=label.querySelector('[data-help]');
      return {fits:section.scrollWidth<=section.clientWidth,hasHelp:!!title?.dataset.help,expanded:input.getAttribute('aria-expanded'),controls:input.getAttribute('aria-controls'),offStyle:label.classList.contains('is-off')};`);
    assert.deepEqual(layout, { fits: true, hasHelp: true, expanded: null, controls: null, offStyle: true });
    console.log('PASS settings: one switch, mouse and keyboard, help, layout; no timing selector or test button');
  }
  if (!uiOnly) {
    await ev(`f.listener=f.createReplyNotificationService();await f.listener.start({open:route=>f.opened.push(route)});
      f.notify=async tag=>{try{return await f.invoke('reply_notification_complete',{runId:'notification-fixture:'+Date.now()+':'+tag,route:{personaId:'fixture',scopeId:'fixture',sessionId:'notification-fixture',archiveId:'',messageId:tag,swipeIndex:0},body:'Notification check: '+tag});}catch(error){throw new Error('Native '+tag+': '+String(error?.message||error));}};
      await f.service.configure({enabled:true});`);
    if (!activationOnly) {
      setWindow('foreground');
      await new Promise(r => setTimeout(r, 300));
      assert.equal(await ev(`return await f.notify('foreground');`), 'foreground');
      console.log('PASS native foreground policy');
    }
    if (!policiesOnly) {
      setWindow('minimized');
      await new Promise(r => setTimeout(r, 250));
      assert.equal(await ev(`return await f.notify('minimized');`), 'sent');
      const info = JSON.parse(ps(`$replyPath=Join-Path $env:LOCALAPPDATA 'com.chatapp.dev/reply-notifications-dev.json'; $replyData=Get-Content $replyPath -Raw | ConvertFrom-Json; $route=$replyData.routes | Where-Object {$_.route.sessionId -eq 'notification-fixture'} | Select-Object -Last 1; @{token=$route.token;messageId=$route.route.messageId} | ConvertTo-Json -Compress`));
      assert.match(info.token, /^[a-f0-9]{32}$/);
      const count = Number(ps(`[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]::History.GetHistory('com.chatapp.dev.notifications.dev').Count`));
      assert.ok(count > 0, 'The native notification should be present in Windows notification history');
      // Invoke the exact registered protocol handler used by a notification click.
      ps(`Start-Process 'omnitavern-reply-dev://open/${info.token}'`);
      await waitFor(`return f.opened.length===1;`);
      assert.equal(await ev(`return f.opened[0].messageId;`), 'minimized');
      assert.equal(ps(windowApi + '[ReplyWindow]::IsIconic($replyWindow)'), 'False');
      console.log('PASS native minimized toast, Windows history, protocol activation and window restore');
    }
    // The old minimized-only preference must no longer restrict notifications.
    await ev(`await f.invoke('reply_notification_configure',{preferences:{enabled:true,timing:'minimized'}});`);
    assert.deepEqual(await ev(`return await f.invoke('reply_notification_settings');`), { supported: true, enabled: true });
    setWindow('background');
    assert.equal(await ev(`return await f.notify('background-with-legacy-timing');`), 'sent');
    if (policiesOnly) {
      setWindow('minimized');
      await new Promise(r => setTimeout(r, 250));
      assert.equal(await ev(`return await f.notify('minimized');`), 'sent');
    }
    await ev(`await f.service.configure({enabled:false});`);
    setWindow('minimized');
    assert.equal(await ev(`return await f.notify('disabled');`), 'disabled');
    console.log('PASS native unified background/minimized and disabled policies, including legacy preferences');
  }
} finally {
  if (prepared) {
    await ev(`await f.service.configure(f.original);f.panel.hide();f.focus?.focus?.({preventScroll:true});delete window.__replyNotificationFixture;`);
    if (!uiOnly) {
      ps(`[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]::History.RemoveGroup('reply-complete','com.chatapp.dev.notifications.dev')`);
      try { setWindow('foreground'); }
      finally {
        // Replace the temporary native channel with the normal app listener.
        await command('Page.reload', { ignoreCache: true });
      }
    }
  }
  socket.close();
}
console.log('No model requests; notification preferences restored.');
process.exit(0);
