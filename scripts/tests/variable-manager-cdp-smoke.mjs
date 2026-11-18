import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createWsClient,
  findAppPageTarget,
} from '../dev/cdp-client.mjs';

const shouldCaptureScreenshots = process.argv.includes('--screenshots');

const page = await findAppPageTarget();
if (!page?.webSocketDebuggerUrl) {
  throw new Error('OmniTavern CDP target not found; start npm run dev with WebView2 remote debugging first');
}

const pending = new Map();
let commandId = 0;

let resolveOpen;
let rejectOpen;
const opened = new Promise((resolvePromise, rejectPromise) => {
  resolveOpen = resolvePromise;
  rejectOpen = rejectPromise;
});

const socket = createWsClient(page.webSocketDebuggerUrl, {
  onOpen: () => resolveOpen(),
  onError: (error) => {
    rejectOpen(error);
    pending.forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    });
    pending.clear();
  },
  onMessage: (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw || '{}'));
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result || {});
  },
});

const command = async (method, params = {}, timeoutMs = 20000) => {
  await opened;
  const id = ++commandId;
  return new Promise((resolveCommand, rejectCommand) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCommand(new Error(`CDP ${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
};

const evaluate = async (expression) => {
  const response = await command('Runtime.evaluate', {
    expression: `(async () => (${expression}))()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result?.value ?? null;
};

const waitForFrames = () => new Promise(resolveWait => setTimeout(resolveWait, 120));

const setupExpression = String.raw`(async () => {
  const panel = window.appBridge?.debugUiRegistry?.panels?.variablePanel;
  if (!panel) throw new Error('variable panel unavailable');
  const [{ themeManager }, { themeStore }] = await Promise.all([
    import('./scripts/ui/theme-manager.js'),
    import('./scripts/storage/theme-store.js'),
  ]);
  panel.hide?.();
  const methodNames = [
    'resolveScope', 'isGlobalScope', 'listVars', 'getVars', 'listSchemas', 'getSchemas',
    'getSchema', 'setVar', 'deleteVar', 'clearVars', 'setSchema', 'deleteSchema',
    'clearSchemas', 'listRules', 'getRules', 'setRules', 'getInitialValue'
  ];
  const originals = {};
  methodNames.forEach(name => {
    originals[name] = {
      own: Object.prototype.hasOwnProperty.call(panel, name),
      descriptor: Object.getOwnPropertyDescriptor(panel, name),
    };
  });
  const vars = {
    'player.hp': 42,
    'player.name': '云岚',
    mood: '熟悉',
    alive: false,
    note: '',
  };
  for (let index = 0; index < 210; index += 1) {
    vars['status.metric.' + String(index).padStart(3, '0')] = index;
  }
  const schemas = {
    'player.hp': {
      id: 'player.hp',
      name: 'player.hp',
      type: 'number',
      default: 10,
      range: { min: 0, max: 100 },
      ui: { display: 'progress', color: '#7c3aed', format: '{value}/100', label: '生命' },
    },
    'player.name': {
      id: 'player.name',
      name: 'player.name',
      type: 'string',
      default: '云岚',
      ui: { display: 'card', color: '#2563eb', label: '姓名' },
    },
    mood: {
      id: 'mood',
      name: 'mood',
      type: 'enum',
      default: '陌生',
      options: ['陌生', '熟悉', '朋友'],
      ui: { display: 'badge', color: '#059669', label: '关系' },
    },
    alive: {
      id: 'alive',
      name: 'alive',
      type: 'boolean',
      default: true,
      ui: { display: 'card', color: '#ca8a04', label: '存活' },
    },
    note: {
      id: 'note',
      name: 'note',
      type: 'string',
      default: '初见',
      ui: { display: 'card', color: '#64748b', label: '备注' },
    },
  };
  Object.keys(vars).forEach(key => {
    if (schemas[key]) return;
    schemas[key] = {
      id: key,
      name: key,
      type: 'number',
      default: vars[key],
      range: { min: 0, max: 209 },
      ui: { display: 'hidden', color: '#7c3aed' },
    };
  });
  const initial = {
    'player.hp': 10,
    'player.name': '云岚',
    mood: '陌生',
    alive: true,
    note: '初见',
  };
  let rules = [
    {
      id: 'probe-every',
      name: '每轮增加生命',
      enabled: true,
      priority: 1,
      trigger: { type: 'every_turn' },
      action: { type: 'increment', target: 'player.hp', value: 1 },
    },
    {
      id: 'probe-condition',
      name: '低生命提醒',
      enabled: false,
      priority: 2,
      trigger: { type: 'condition', expr: 'player.hp < 20' },
      action: { type: 'notify', message: '生命偏低', style: 'warning' },
    },
    {
      id: 'probe-manual',
      name: '手动恢复',
      enabled: true,
      priority: 3,
      trigger: { type: 'manual' },
      action: { type: 'set_value', target: 'player.hp', value: 100 },
    },
  ];
  const state = { vars, schemas, initial, get rules() { return rules; }, set rules(value) { rules = value; } };
  panel.resolveScope = () => ({ sid: '__codex_variable_probe__', scope: 'session' });
  panel.isGlobalScope = () => false;
  panel.listVars = () => ({ ...vars });
  panel.getVars = () => ({ sid: '__codex_variable_probe__', scope: 'session', vars: { ...vars } });
  panel.listSchemas = () => ({ ...schemas });
  panel.getSchemas = () => ({ sid: '__codex_variable_probe__', scope: 'session', schemas: { ...schemas } });
  panel.getSchema = key => schemas[key] || null;
  panel.setVar = (key, value) => { vars[key] = value; return true; };
  panel.deleteVar = key => { delete vars[key]; return true; };
  panel.clearVars = () => { Object.keys(vars).forEach(key => delete vars[key]); return true; };
  panel.setSchema = (key, schema) => { schemas[key] = schema; return true; };
  panel.deleteSchema = key => { delete schemas[key]; return true; };
  panel.clearSchemas = () => { Object.keys(schemas).forEach(key => delete schemas[key]); return true; };
  panel.listRules = () => rules.map(rule => structuredClone(rule));
  panel.getRules = () => ({
    sid: '__codex_variable_probe__',
    scope: 'session',
    rules: rules.map(rule => structuredClone(rule)),
  });
  panel.setRules = value => { rules = value.map(rule => structuredClone(rule)); return true; };
  panel.getInitialValue = key => initial[key];

  const errors = [];
  const errorHandler = event => errors.push(String(event.error?.stack || event.message || event.reason || 'window error'));
  const rejectionHandler = event => errors.push(String(event.reason?.stack || event.reason || 'unhandled rejection'));
  window.addEventListener('error', errorHandler);
  window.addEventListener('unhandledrejection', rejectionHandler);
  const originalTheme = document.body.dataset.themeMode;
  const originalReducedMotion = document.body.dataset.reducedMotion;

  window.__variableManagerCdpProbe = {
    panel,
    state,
    errors,
    originalTheme,
    originalReducedMotion,
    themeManager,
    themes: {
      light: themeStore.getTheme('classic-light'),
      dark: themeStore.getTheme('classic-dark'),
    },
    async cleanup() {
      panel.hide?.();
      panel.schemaEditor?.hide?.();
      panel.closeMoreMenu?.();
      methodNames.forEach(name => {
        const saved = originals[name];
        if (saved.own) Object.defineProperty(panel, name, saved.descriptor);
        else delete panel[name];
      });
      window.removeEventListener('error', errorHandler);
      window.removeEventListener('unhandledrejection', rejectionHandler);
      themeManager.applyCurrentTheme();
      delete window.__variableManagerCdpProbe;
      return true;
    },
  };
  panel.show();
  return true;
})()`;

const inspectDesktopExpression = String.raw`(() => {
  const probe = window.__variableManagerCdpProbe;
  const panel = probe.panel;
  const shell = panel.panel;
  const rail = shell.querySelector('.variable-manager-rail');
  const tabs = shell.querySelector('.variable-manager-mobile-tabs');
  return {
    viewport: { width: innerWidth, height: innerHeight },
    page: panel.page,
    totalRows: panel.currentRows.length,
    renderedRows: shell.querySelectorAll('.variable-row').length,
    loadMoreVisible: !shell.querySelector('#var-load-more').hidden,
    railDisplay: getComputedStyle(rail).display,
    mobileTabsDisplay: getComputedStyle(tabs).display,
    summaryCards: shell.querySelectorAll('.var-summary-card,.var-summary-badge').length,
    shell: shell.getBoundingClientRect().toJSON(),
  };
})()`;

// 加载更多 → 出现收起 → 收起回第一批并回到列表顶端
const pagingExpression = String.raw`(async () => {
  const shell = window.__variableManagerCdpProbe.panel.panel;
  const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
  const rows = () => shell.querySelectorAll('.variable-row').length;
  const visible = selector => !shell.querySelector(selector).hidden;
  const scroll = shell.querySelector('#var-list-scroll');
  const before = { rows: rows(), less: visible('#var-load-less') };
  shell.querySelector('#var-load-more').click();
  await frame();
  const expanded = { rows: rows(), more: visible('#var-load-more'), less: visible('#var-load-less') };
  scroll.scrollTop = 600;
  shell.querySelector('#var-load-less').click();
  await frame();
  await frame();
  const folded = { rows: rows(), more: visible('#var-load-more'), less: visible('#var-load-less'), scrollTop: scroll.scrollTop };
  return { before, expanded, folded };
})()`;

const exerciseExpression = String.raw`(async () => {
  const probe = window.__variableManagerCdpProbe;
  const panel = probe.panel;
  const shell = panel.panel;

  panel.setViewMode('tree');
  const treeGroups = shell.querySelectorAll('.variable-tree-group.is-root').length;
  panel.setViewMode('list');

  panel.promptSchema('player.hp');
  const inspector = panel.schemaEditor.panel;
  const numberInput = inspector.querySelector('.variable-number-input');
  numberInput.value = '64';
  numberInput.dispatchEvent(new Event('input', { bubbles: true }));
  const immediateValue = probe.state.vars['player.hp'];
  const beforeDraftSave = probe.state.schemas['player.hp'].ui.display;
  inspector.querySelector('[data-display="ring"]').click();
  const stillBeforeSave = probe.state.schemas['player.hp'].ui.display;
  inspector.querySelector('[data-action="save"]').click();
  const afterDraftSave = probe.state.schemas['player.hp'].ui.display;

  await new Promise(resolve => setTimeout(resolve, 380));
  panel.promptSchema('player.hp');
  await new Promise(resolve => requestAnimationFrame(() => resolve()));
  panel.schemaEditor.restoreInitial();
  const restoredInitial = probe.state.vars['player.hp'];
  panel.hideSchemaModal();
  await new Promise(resolve => setTimeout(resolve, 380));

  panel.switchPage('templates');
  const templateCards = shell.querySelectorAll('.variable-template-card').length;
  const templateChips = shell.querySelectorAll('.variable-template-chip').length;

  panel.switchPage('rules');
  const ruleCards = shell.querySelectorAll('.variable-rule-card').length;
  shell.querySelector('.variable-rule-toggle')?.click();
  const toggledRule = probe.state.rules[0].enabled;

  panel.switchPage('variables');
  panel.deleteKey('alive');
  const deleted = !Object.prototype.hasOwnProperty.call(probe.state.vars, 'alive');
  const grave = panel.graveyard[panel.graveyard.length - 1];
  panel.undoGraveyard(grave.id);
  const undone = Object.prototype.hasOwnProperty.call(probe.state.vars, 'alive');

  const slash = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
  document.dispatchEvent(slash);
  const slashFocusedSearch = document.activeElement === shell.querySelector('#var-search');

  document.body.dataset.reducedMotion = 'on';
  panel.promptSchema('player.hp');
  panel.hideSchemaModal();
  const reducedMotionClosedImmediately = panel.schemaEditor.overlay.style.display === 'none';
  delete document.body.dataset.reducedMotion;

  panel.promptSchema('player.hp');
  panel.hideSchemaModal();
  await new Promise(resolve => requestAnimationFrame(() => resolve()));
  await new Promise(resolve => setTimeout(resolve, 380));
  const rapidInspectorStayedClosed = (
    panel.schemaEditor.overlay.style.display === 'none'
    && !panel.schemaEditor.overlay.classList.contains('is-open')
  );

  return {
    treeGroups,
    immediateValue,
    beforeDraftSave,
    stillBeforeSave,
    afterDraftSave,
    restoredInitial,
    templateCards,
    templateChips,
    ruleCards,
    toggledRule,
    deleted,
    undone,
    slashFocusedSearch,
    reducedMotionClosedImmediately,
    rapidInspectorStayedClosed,
    errors: probe.errors.slice(),
  };
})()`;

const setSceneExpression = ({
  theme,
  pageName,
  inspector = false,
  tree = false,
}) => `(async () => {
  const probe = window.__variableManagerCdpProbe;
  const panel = probe.panel;
  window.toastr?.clear?.();
  document.querySelectorAll('#toast-container > div').forEach(element => element.remove());
  probe.themeManager.applyThemePreset({ preset: probe.themes[${JSON.stringify(theme)}] });
  delete document.body.dataset.reducedMotion;
  panel.switchPage(${JSON.stringify(pageName)}, { force: true });
  if (${JSON.stringify(tree)}) panel.setViewMode('tree');
  else panel.setViewMode('list');
  if (${JSON.stringify(inspector)}) {
    panel.promptSchema('player.hp');
    await new Promise(resolve => setTimeout(resolve, 380));
  } else {
    panel.hideSchemaModal();
    await new Promise(resolve => setTimeout(resolve, 380));
  }
  return {
    width: innerWidth,
    height: innerHeight,
    theme: document.body.dataset.themeMode,
    page: panel.page,
    rail: getComputedStyle(panel.panel.querySelector('.variable-manager-rail')).display,
    tabs: getComputedStyle(panel.panel.querySelector('.variable-manager-mobile-tabs')).display,
    inspectorVisible: panel.schemaEditor.isVisible(),
    inspectorWidth: panel.schemaEditor.panel?.getBoundingClientRect?.().width || 0,
    inspectorTransform: panel.schemaEditor.panel ? getComputedStyle(panel.schemaEditor.panel).transform : '',
    surface: getComputedStyle(panel.panel).backgroundColor,
  };
})()`;

const captureScene = async (name) => {
  const response = await command('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const path = resolve(`scripts/dev/tmp/${name}.png`);
  await writeFile(path, Buffer.from(response.data || '', 'base64'));
  return path;
};

const report = {
  desktop: null,
  exercise: null,
  scenes: [],
  screenshots: [],
};

// 长时间 HMR 后的陈旧页面会让面板状态假失败：先整页 reload，等 appBridge 就绪再测。
const reloadAndWaitForApp = async ({ timeoutMs = 30000 } = {}) => {
  await command('Page.reload', { ignoreCache: false });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await waitForFrames();
    try {
      const ready = await evaluate(
        'Boolean(window.appBridge?.debugUiRegistry?.panels?.variablePanel)',
      );
      if (ready === true) return;
    } catch {}
  }
  throw new Error('app did not become ready after reload');
};

try {
  await command('Page.bringToFront');
  await reloadAndWaitForApp();
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(setupExpression);
  await waitForFrames();
  report.desktop = await evaluate(inspectDesktopExpression);
  assert.equal(report.desktop.totalRows, 215);
  assert.equal(report.desktop.renderedRows, 80);
  assert.equal(report.desktop.loadMoreVisible, true);
  assert.equal(report.desktop.railDisplay, 'flex');
  assert.equal(report.desktop.mobileTabsDisplay, 'none');

  report.paging = await evaluate(pagingExpression);
  assert.deepEqual(report.paging.before, { rows: 80, less: false });
  assert.deepEqual(report.paging.expanded, { rows: 160, more: true, less: true });
  assert.deepEqual(report.paging.folded, { rows: 80, more: true, less: false, scrollTop: 0 });

  report.exercise = await evaluate(exerciseExpression);
  assert.ok(report.exercise.treeGroups >= 2);
  assert.equal(report.exercise.immediateValue, 64);
  assert.equal(report.exercise.beforeDraftSave, 'progress');
  assert.equal(report.exercise.stillBeforeSave, 'progress');
  assert.equal(report.exercise.afterDraftSave, 'ring');
  assert.equal(report.exercise.restoredInitial, 10);
  assert.ok(report.exercise.templateCards >= 4);
  assert.ok(report.exercise.templateChips >= 6);
  assert.equal(report.exercise.ruleCards, 3);
  assert.equal(report.exercise.toggledRule, false);
  assert.equal(report.exercise.deleted, true);
  assert.equal(report.exercise.undone, true);
  assert.equal(report.exercise.slashFocusedSearch, true);
  assert.equal(report.exercise.reducedMotionClosedImmediately, true);
  assert.equal(report.exercise.rapidInspectorStayedClosed, true);
  assert.deepEqual(report.exercise.errors, []);

  report.scenes.push(await evaluate(setSceneExpression({
    theme: 'light',
    pageName: 'variables',
    inspector: true,
  })));
  await waitForFrames();
  if (shouldCaptureScreenshots) {
    report.screenshots.push(await captureScene('variable-manager-desktop-light'));
  }

  report.scenes.push(await evaluate(setSceneExpression({
    theme: 'dark',
    pageName: 'rules',
  })));
  await waitForFrames();
  if (shouldCaptureScreenshots) {
    report.screenshots.push(await captureScene('variable-manager-desktop-dark'));
  }

  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844,
  });
  report.scenes.push(await evaluate(setSceneExpression({
    theme: 'light',
    pageName: 'variables',
    tree: true,
  })));
  await waitForFrames();
  if (shouldCaptureScreenshots) {
    report.screenshots.push(await captureScene('variable-manager-mobile-light'));
  }

  report.scenes.push(await evaluate(setSceneExpression({
    theme: 'dark',
    pageName: 'variables',
    inspector: true,
  })));
  await waitForFrames();
  if (shouldCaptureScreenshots) {
    report.screenshots.push(await captureScene('variable-manager-mobile-dark'));
  }

  assert.equal(report.scenes[0].rail, 'flex');
  assert.equal(report.scenes[2].rail, 'none');
  assert.equal(report.scenes[2].tabs, 'grid');
  assert.equal(report.scenes[3].inspectorVisible, true);
  assert.ok(report.scenes[3].inspectorWidth <= 390);
  assert.deepEqual(await evaluate('window.__variableManagerCdpProbe.errors.slice()'), []);
} finally {
  try {
    await evaluate('window.__variableManagerCdpProbe?.cleanup?.() ?? true');
  } catch {}
  try {
    await command('Emulation.clearDeviceMetricsOverride');
  } catch {}
  socket.close();
}

console.log(JSON.stringify(report, null, 2));
