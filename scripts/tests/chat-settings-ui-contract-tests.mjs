import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../../src/index.html', import.meta.url), 'utf8');
const legacyCss = await readFile(new URL('../../src/assets/css/qq-legacy.css', import.meta.url), 'utf8');
const mainCss = await readFile(new URL('../../src/assets/css/main.css', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
const contactSettingsSource = await readFile(
  new URL('../../src/scripts/ui/contact-settings-panel.js', import.meta.url),
  'utf8',
);

const getCssBlock = (source, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'));
  assert.ok(match, `missing css block for ${selector}`);
  return match[1];
};

const getZIndex = (block, label) => {
  const match = block.match(/z-index:\s*(\d+)/);
  assert.ok(match, `missing z-index for ${label}`);
  return Number(match[1]);
};

{
  const overlayZ = getZIndex(getCssBlock(legacyCss, '.popup-overlay'), 'chat settings overlay');
  const popupZ = getZIndex(getCssBlock(legacyCss, '.chat-setting-popup'), 'chat settings popup');
  assert.match(mainCss, /\.topbar\s*\{[^}]*z-index:\s*12000;/s);
  assert.equal(overlayZ, 20000);
  assert.equal(popupZ, 20010);
  assert.ok(popupZ > overlayZ && overlayZ > 12000);
  console.log('ok - chat settings overlay and popup stay above the sticky chat topbar');
}

{
  assert.match(html, /<img\s+id="wallpaper-preview-image"[^>]*\sdraggable="false"[^>]*>/);
  assert.match(getCssBlock(legacyCss, '.wallpaper-preview'), /touch-action:\s*none;/);
  assert.match(
    appSource,
    /wallpaperPreview\?\.addEventListener\('pointercancel',\s*handleWallpaperDragEnd\);/,
  );
  console.log('ok - wallpaper preview keeps pointer drag ownership through mouse and touch cancellation');
}

{
  const runtimeStart = contactSettingsSource.indexOf('ensureNewChatRuntime()');
  const runtimeEnd = contactSettingsSource.indexOf('buildMemoryTableSnapshot:', runtimeStart);
  assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart, 'missing contact new-chat runtime');
  const runtimeSource = contactSettingsSource.slice(runtimeStart, runtimeEnd);
  assert.match(contactSettingsSource, /import\s*\{\s*appConfirm,\s*appPromptText\s*\}/);
  assert.match(runtimeSource, /promptForArchiveName:\s*\(\)\s*=>\s*appPromptText\(\{/);
  assert.match(runtimeSource, /title:\s*'为当前聊天存档'/);
  assert.match(runtimeSource, /message:\s*'留空会自动命名；取消则不会开启新聊天。'/);
  assert.doesNotMatch(runtimeSource, /\bprompt\s*\(/);
  console.log('ok - contact new-chat archive naming uses the app prompt instead of a native device prompt');
}

{
  const packOverlayZ = getZIndex(getCssBlock(legacyCss, '.sticker-pack-overlay'), 'sticker pack overlay');
  const bindOverlayZ = getZIndex(getCssBlock(legacyCss, '.sticker-bind-overlay'), 'sticker bind overlay');
  const chatTopbarMatch = mainCss.match(/\.topbar\s*\{[^}]*z-index:\s*(\d+);/s);
  assert.ok(chatTopbarMatch, 'missing chat topbar z-index');
  const chatTopbarZ = Number(chatTopbarMatch[1]);
  const bottomNavMatch = mainCss.match(/\.bottom-nav\s*\{[^}]*z-index:\s*(\d+);/s);
  assert.ok(bottomNavMatch, 'missing desktop navigation z-index');
  const bottomNavZ = Number(bottomNavMatch[1]);
  const customSelectZ = getZIndex(getCssBlock(mainCss, '.world-app-select-menu'), 'custom select menu');
  assert.ok(packOverlayZ > chatTopbarZ);
  assert.ok(packOverlayZ > bottomNavZ);
  assert.ok(bindOverlayZ > packOverlayZ);
  assert.ok(customSelectZ > bindOverlayZ);
  console.log('ok - sticker pack management shades the full desktop chat shell and preserves nested controls');
}
