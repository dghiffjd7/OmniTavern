import assert from 'node:assert/strict';

import { createMaidCommandInputRuntime } from '../../src/scripts/ui/maid-command-input-runtime-utils.js';
import { createMaidVoiceTaskRuntime } from '../../src/scripts/ui/maid-voice-task-runtime.js';

const createClassList = () => {
  const set = new Set();
  return {
    add: (...tokens) => tokens.forEach(token => set.add(token)),
    remove: (...tokens) => tokens.forEach(token => set.delete(token)),
    contains: token => set.has(token),
    toggle: (token, force) => {
      if (force === true) set.add(token);
      else if (force === false) set.delete(token);
      else if (set.has(token)) set.delete(token);
      else set.add(token);
    },
  };
};

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.classList = createClassList();
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.value = '';
    this.disabled = false;
    this.textContent = '';
    this._innerHTML = '';
    this.focused = false;
    this.scrollHeight = 32;
    this.rect = { left: 100, top: 200, width: 26, height: 26 };
  }

  set innerHTML(value) {
    this._innerHTML = String(value || '');
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(item => item !== this);
    this.parentNode = null;
  }

  contains(target) {
    let node = target;
    while (node) {
      if (node === this) return true;
      node = node.parentNode || null;
    }
    return false;
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatchEvent(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler(event);
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  focus() {
    this.focused = true;
  }

  getBoundingClientRect() {
    return { ...this.rect };
  }
}

class FakeDocument {
  constructor() {
    this.head = new FakeElement('head');
    this.body = new FakeElement('body');
    this.byId = new Map();
    this.listeners = new Map();
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  getElementById(id) {
    return this.byId.get(id) || null;
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter(item => item !== handler));
  }

  dispatchEvent(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler(event);
    }
  }
}

{
  const runtime = createMaidCommandInputRuntime({
    documentRef: new FakeDocument(),
    getViewportSize: () => ({ w: 360, h: 640 }),
    onSubmit: async () => ({ ok: true }),
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
  });
  runtime.open({ autoFocus: false });
  runtime.getElements().inputEl.value = '这是还没发送的女仆指令';
  runtime.close();
  runtime.open({ autoFocus: false });
  assert.equal(
    runtime.getElements().inputEl.value,
    '这是还没发送的女仆指令',
    '普通收起后重新打开不应覆盖未发送草稿',
  );
  runtime.open({ initialText: '显式覆盖', autoFocus: false });
  assert.equal(runtime.getElements().inputEl.value, '显式覆盖');
  console.log('ok - maid command input preserves an unsent draft across collapse and reopen');
}

{
  const documentRef = new FakeDocument();
  const modeSwitchEl = new FakeElement('div');
  const timeouts = [];
  const submissions = [];
  const statusSnapshots = [];
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    modeSwitchEl,
    getViewportSize: () => ({ w: 360, h: 640 }),
    onSubmit: async (text, controls) => {
      submissions.push(text);
      controls.setStatus('模型生成的执行前回应', 'thinking'); // 执行中的女仆叙述 → 折叠进思路
      controls.setStatus('我已经取得结果，正在整理给你。', 'progress'); // 写死过程提示 → live 行
      statusSnapshots.push({
        live: runtime.getLiveStatus()?.message || '',
        messages: runtime.getResultMessages().map(item => item.message),
      });
      return { ok: true, message: `done ${text}` };
    },
    setTimeoutFn: (fn) => {
      timeouts.push(fn);
      return timeouts.length;
    },
    clearTimeoutFn: () => {},
  });

  assert.equal(runtime.open(), true);
  const { rootEl, inputEl } = runtime.getElements();
  assert.match(documentRef.head.children[0].textContent, /\.maid-command-input:focus-within/);
  assert.doesNotMatch(documentRef.head.children[0].textContent, /\.maid-command-input-field:focus-visible/);
  assert.match(
    documentRef.head.children[0].textContent,
    /\.maid-command-input\.is-open\.is-submitting \.maid-command-input-field\s*\{\s*opacity:\s*0\.72;/,
    'submitting dim stays scoped to the open bar and only the field, so result cards stay opaque',
  );
  assert.doesNotMatch(
    documentRef.head.children[0].textContent,
    /\.maid-command-input\.is-open\.is-submitting\s*\{\s*opacity/,
    'the whole bar (and its result cards) must not turn translucent while submitting',
  );
  assert.equal(rootEl.classList.contains('is-open'), true);
  assert.equal(inputEl.tagName, 'TEXTAREA');
  assert.equal(rootEl.dataset.bubbleSide, 'bottom');
  assert.equal(modeSwitchEl.classList.contains('is-maid-input-open'), true);
  assert.match(runtime.getElements().settingsBtn.innerHTML, /svg/);
  assert.match(runtime.getElements().submitBtn.innerHTML, /svg/);
  timeouts.shift()?.();
  assert.equal(inputEl.focused, true);
  assert.equal(inputEl.style.height, '32px');

  inputEl.scrollHeight = 120;
  inputEl.dispatchEvent('input');
  assert.equal(inputEl.style.height, '76px');
  assert.equal(inputEl.style.overflowY, 'auto');
  assert.equal(rootEl.classList.contains('is-multiline'), true);

  inputEl.scrollHeight = 32;
  inputEl.dispatchEvent('input');
  assert.equal(inputEl.style.height, '32px');
  assert.equal(inputEl.style.overflowY, 'hidden');

  inputEl.value = '打开世界书';
  const result = await runtime.submit();
  assert.equal(result.ok, true);
  assert.deepEqual(submissions, ['打开世界书']);
  // 写死过程提示（progress）在 live 单行原位替换；执行中的叙述不占气泡
  assert.deepEqual(statusSnapshots, [{ live: '我已经取得结果，正在整理给你。', messages: [] }]);
  const finalItems = runtime.getResultMessages();
  assert.deepEqual(finalItems.map(item => item.kind || item.tone), ['thought', 'success'], '没有 run 时叙述收成一行折叠的思路，汇报单独显示');
  assert.deepEqual(finalItems[0].lines, ['模型生成的执行前回应']);
  assert.equal(finalItems[0].open, false);
  assert.equal(finalItems[1].message, 'done 打开世界书');
  assert.equal(runtime.getLiveStatus(), null, '提交结束 live 行退场');
  assert.equal(runtime.getElements().resultEl.children.length, 2);
  assert.equal(runtime.getElements().resultEl.dataset.tone, 'success');
  assert.equal(rootEl.classList.contains('has-result'), true);
  assert.equal(rootEl.classList.contains('is-open'), true);
  assert.equal(modeSwitchEl.classList.contains('is-maid-input-open'), true);
  console.log('ok - maid command input opens submits and keeps reply bubble visible');
}

{
  const documentRef = new FakeDocument();
  let actionRuns = 0;
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    getViewportSize: () => ({ w: 360, h: 640 }),
    onSubmit: async () => ({
      ok: true,
      message: '主人还没给我接上大脑呢～',
      actions: [{ label: '带我配置 API', onClick: () => { actionRuns += 1; } }],
    }),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  runtime.open();
  const { inputEl, settingsBtn } = runtime.getElements();
  assert.equal(inputEl.dataset.maidGuideTarget, 'maid-command-input');
  assert.equal(settingsBtn.dataset.maidGuideTarget, 'maid-command-settings');
  inputEl.value = '你好';
  await runtime.submit();
  const bubble = runtime.getElements().resultEl.children[0];
  const actionRow = bubble.children.find(child => child.className === 'mci-result-actions');
  assert.ok(actionRow, 'local reply should render action chips');
  assert.equal(actionRow.children[0].textContent, '带我配置 API');
  actionRow.children[0].dispatchEvent('click', { preventDefault() {}, stopPropagation() {} });
  assert.equal(actionRuns, 1);
  console.log('ok - maid command input renders actionable local reply chips');
}

{
  const documentRef = new FakeDocument();
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    getViewportSize: () => ({ w: 360, h: 640 }),
    onSubmit: async () => ({
      ok: true,
      message: '**加粗**与`代码`\n第二行 <img src=x onerror=alert(1)>',
    }),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  runtime.open();
  runtime.getElements().inputEl.value = '测试 Markdown';
  await runtime.submit();
  const reportBubble = runtime.getElements().resultEl.children[0];
  assert.ok(reportBubble.className.includes('is-report'), '最终回复是带标识的汇报气泡');
  assert.equal(reportBubble.children[0].className, 'mci-report-head');
  const message = reportBubble.children.find(child => child.className === 'mci-result-message');
  assert.match(message.innerHTML, /<strong>加粗<\/strong>/);
  assert.match(message.innerHTML, /<code>代码<\/code>/);
  assert.match(message.innerHTML, /<br>/);
  assert.match(message.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(message.innerHTML, /<img\b/);
  console.log('ok - maid command input safely renders basic Markdown and real newlines');
}

{
  const documentRef = new FakeDocument();
  const modeSwitchEl = new FakeElement('div');
  const outsideEl = new FakeElement('main');
  documentRef.body.appendChild(outsideEl);
  let finishSubmit = null;
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    modeSwitchEl,
    getViewportSize: () => ({ w: 360, h: 640 }),
    onSubmit: async (text, controls) => {
      controls.setStatus('步骤 1：读取资料', 'progress');
      await new Promise(resolve => {
        finishSubmit = resolve;
      });
      controls.setStatus('步骤 2：整理结果', 'progress');
      return { ok: true, message: `完成 ${text}` };
    },
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });

  assert.equal(runtime.open(), true);
  const { rootEl, inputEl } = runtime.getElements();
  inputEl.value = '检查世界书';
  const pending = runtime.submit();
  assert.equal(runtime.isSubmitting(), true);
  // 过程叙述在 live 单行内原位替换，不进消息列表
  assert.deepEqual(runtime.getResultMessages(), []);
  assert.equal(runtime.getLiveStatus()?.message, '步骤 1：读取资料');

  documentRef.dispatchEvent('pointerdown', { target: outsideEl });
  assert.equal(rootEl.classList.contains('is-open'), false);
  assert.equal(modeSwitchEl.classList.contains('is-maid-input-open'), false);

  assert.equal(runtime.open(), true);
  assert.equal(rootEl.classList.contains('is-open'), true);
  assert.equal(runtime.getLiveStatus()?.message, '步骤 1：读取资料', '重开后 live 行仍在');

  finishSubmit();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(runtime.isSubmitting(), false);
  assert.deepEqual(runtime.getResultMessages().map(item => item.message), [
    '完成 检查世界书',
  ]);
  assert.equal(runtime.getLiveStatus(), null, '提交结束 live 行退场');
  assert.equal(runtime.getElements().resultEl.children.length, 1);
  console.log('ok - maid command input keeps live progress line across close/reopen');
}

{
  const documentRef = new FakeDocument();
  const submitted = [];
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    getViewportSize: () => ({ w: 360, h: 640 }),
    onAttachFiles: async files => files.map((file, index) => ({
      id: `img-${index}`,
      kind: 'image',
      url: `data:image/png;base64,${index}`,
      name: file.name,
      mime: file.type,
      size: file.size,
    })),
    onSubmit: async (text, controls) => {
      submitted.push({ text, attachments: controls.attachments });
      return { ok: true, message: '看到了。' };
    },
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });

  assert.equal(runtime.open(), true);
  await runtime.addFiles([{ name: 'screen.png', type: 'image/png', size: 12 }], { source: 'test' });
  const { rootEl, attachmentsEl, inputEl } = runtime.getElements();
  assert.equal(runtime.getAttachments().length, 1);
  assert.equal(rootEl.classList.contains('has-attachments'), true);
  assert.equal(attachmentsEl.children.length, 1);
  inputEl.value = '';
  const result = await runtime.submit();
  assert.equal(result.ok, true);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].text, '请看这张图片。');
  assert.equal(submitted[0].attachments.length, 1);
  assert.equal(runtime.getAttachments().length, 0);
  assert.equal(rootEl.classList.contains('has-attachments'), false);
  console.log('ok - maid command input attaches images and submits them with fallback text');
}

{
  const documentRef = new FakeDocument();
  const started = [];
  const finishers = [];
  let settingsCalls = 0;
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    getViewportSize: () => ({ w: 360, h: 640 }),
    onSubmit: (text) => {
      started.push(text);
      return new Promise(resolve => finishers.push(resolve));
    },
    onSettings: () => {
      settingsCalls += 1;
    },
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });

  runtime.open();
  const { inputEl, attachBtn, settingsBtn, submitBtn } = runtime.getElements();
  inputEl.value = '第一项';
  const first = runtime.submit();
  assert.equal(runtime.isSubmitting(), true);
  assert.equal(inputEl.disabled, false, '运行中输入框保持可编辑');
  assert.equal(attachBtn.disabled, false, '运行中仍可添加附件');
  assert.equal(settingsBtn.disabled, false, '运行中仍可打开女仆设置');
  assert.equal(submitBtn.disabled, false, '运行中发送按钮用于加入串行队列');
  settingsBtn.dispatchEvent('click', { preventDefault() {}, stopPropagation() {} });
  assert.equal(settingsCalls, 1);

  inputEl.value = '第二项';
  const second = runtime.submit();
  inputEl.value = '第三项';
  const third = runtime.submit();
  assert.deepEqual(started, ['第一项'], '后续发送在当前任务结束前不得并行执行');
  assert.deepEqual(runtime.getQueue().map(item => item.text), ['第二项', '第三项']);

  const secondId = runtime.getQueue()[0].id;
  assert.equal(runtime.cancelQueued(secondId), true);
  assert.deepEqual(runtime.getQueue().map(item => item.text), ['第三项']);
  const cancelled = await second;
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.reason, 'queued_submission_cancelled');

  finishers.shift()({ ok: true, message: '第一项完成' });
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.deepEqual(started, ['第一项', '第三项'], '首项完成后自动串行执行下一项');
  assert.equal(runtime.cancelQueued(runtime.getActiveSubmission()?.id), false, '正在执行的任务不属于待执行队列');
  finishers.shift()({ ok: true, message: '第三项完成' });
  const thirdResult = await third;
  assert.equal(thirdResult.ok, true);
  assert.equal(runtime.isSubmitting(), false);
  assert.deepEqual(runtime.getQueue(), []);
  console.log('ok - maid command input stays interactive and serializes/cancels queued submissions');
}

{
  const documentRef = new FakeDocument();
  const cancelPrompts = [];
  let activeSignal = null;
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    getViewportSize: () => ({ w: 360, h: 640 }),
    onSubmit: async (text, controls) => {
      activeSignal = controls.signal;
      return new Promise((resolve) => {
        controls.signal.addEventListener('abort', () => resolve({
          ok: false,
          status: 'cancelled',
          cancelled: true,
          reason: 'user_aborted',
          message: `已停止 ${text}`,
        }), { once: true });
      });
    },
    onCancelActive: async payload => {
      cancelPrompts.push(payload);
      return 'all_stop';
    },
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });

  runtime.open();
  const { inputEl, submitBtn } = runtime.getElements();
  inputEl.value = '执行中任务';
  const active = runtime.submit();
  assert.equal(activeSignal?.aborted, false);
  assert.equal(submitBtn.attributes['aria-label'], '停止女仆任务');
  assert.match(submitBtn.innerHTML, /rect/);

  inputEl.value = '排队任务';
  const queued = runtime.submit();
  assert.equal(runtime.getQueue().length, 1, 'Enter/submit API 在执行中仍应加入队列');
  assert.equal(await runtime.cancelActive(), true);
  assert.equal(activeSignal.aborted, true);
  assert.equal(cancelPrompts[0].queuedCount, 1);
  assert.deepEqual(runtime.getQueue(), []);
  assert.equal((await queued).reason, 'queued_submission_cancelled');
  assert.equal((await active).status, 'cancelled');
  assert.equal(runtime.isSubmitting(), false);
  assert.equal(submitBtn.attributes['aria-label'], '发送给女仆');
  console.log('ok - maid stop button aborts the active run and cancels queued work after confirmation');
}

{
  // 确认框打开期间首项可能自然完成；「全部停止」仍应中断已被提升为 active 的原排队项。
  const documentRef = new FakeDocument();
  let resolveFirst = null;
  let resolveConfirmation = null;
  const started = [];
  const signals = new Map();
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    getViewportSize: () => ({ w: 360, h: 640 }),
    onSubmit: async (text, controls) => {
      started.push(text);
      signals.set(text, controls.signal);
      if (text === '第一项') {
        return new Promise(resolve => { resolveFirst = resolve; });
      }
      return new Promise((resolve) => {
        controls.signal.addEventListener('abort', () => resolve({
          ok: false,
          status: 'cancelled',
          cancelled: true,
          reason: 'user_aborted',
          message: `已停止 ${text}`,
        }), { once: true });
      });
    },
    onCancelActive: async () => new Promise(resolve => { resolveConfirmation = resolve; }),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });

  runtime.open();
  const { inputEl } = runtime.getElements();
  inputEl.value = '第一项';
  const first = runtime.submit();
  inputEl.value = '第二项';
  const second = runtime.submit();
  const cancelling = runtime.cancelActive();

  resolveFirst({ ok: true, message: '第一项自然完成' });
  assert.equal((await first).ok, true);
  await Promise.resolve();
  assert.deepEqual(started, ['第一项', '第二项']);
  assert.equal(signals.get('第二项')?.aborted, false);

  resolveConfirmation('all_stop');
  assert.equal(await cancelling, true);
  assert.equal(signals.get('第二项')?.aborted, true);
  assert.equal((await second).status, 'cancelled');
  assert.equal(runtime.isSubmitting(), false);
  console.log('ok - all-stop confirmation still cancels a queued task promoted while the dialog was open');
}

{
  const documentRef = new FakeDocument();
  const modeSwitchEl = new FakeElement('div');
  const outsideEl = new FakeElement('main');
  documentRef.body.appendChild(outsideEl);
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    modeSwitchEl,
    getViewportSize: () => ({ w: 360, h: 640 }),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });

  assert.equal(runtime.open(), true);
  const { rootEl, inputEl } = runtime.getElements();
  documentRef.dispatchEvent('pointerdown', { target: inputEl });
  assert.equal(rootEl.classList.contains('is-open'), true);
  assert.equal(modeSwitchEl.classList.contains('is-maid-input-open'), true);

  documentRef.dispatchEvent('pointerdown', { target: modeSwitchEl });
  assert.equal(rootEl.classList.contains('is-open'), true);

  const confirmBtn = new FakeElement('button');
  const confirmModal = new FakeElement('div');
  confirmModal.classList.add('app-confirm-modal');
  confirmModal.appendChild(confirmBtn);
  documentRef.dispatchEvent('pointerdown', {
    target: confirmBtn,
    composedPath: () => [confirmBtn, confirmModal, documentRef.body],
  });
  assert.equal(rootEl.classList.contains('is-open'), true);
  assert.equal(modeSwitchEl.classList.contains('is-maid-input-open'), true);

  const guideCard = new FakeElement('section');
  const guideRoot = new FakeElement('div');
  guideRoot.classList.add('maid-spotlight-root');
  guideRoot.appendChild(guideCard);
  documentRef.dispatchEvent('pointerdown', {
    target: guideCard,
    composedPath: () => [guideCard, guideRoot, documentRef.body],
  });
  assert.equal(rootEl.classList.contains('is-open'), true, 'spotlight controls must not close the guided command input');

  documentRef.dispatchEvent('pointerdown', { target: outsideEl });
  assert.equal(rootEl.classList.contains('is-open'), false);
  assert.equal(modeSwitchEl.classList.contains('is-maid-input-open'), false);
  assert.equal(documentRef.listeners.get('pointerdown')?.length || 0, 0);
  console.log('ok - maid command input closes on outside pointer');
}

{
  const documentRef = new FakeDocument();
  const settingsCalls = [];
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    getViewportSize: () => ({ w: 360, h: 640 }),
    onSettings: payload => settingsCalls.push(payload),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });

  assert.equal(runtime.open(), true);
  const { settingsBtn } = runtime.getElements();
  settingsBtn.dispatchEvent('click', {
    preventDefault() {},
    stopPropagation() {},
  });
  assert.equal(settingsCalls.length, 1);
  assert.equal(settingsCalls[0].source, 'command_input');
  console.log('ok - maid command input settings button forwards callback');
}

{
  const documentRef = new FakeDocument();
  let scheduled = 0;
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    modeSwitchEl: new FakeElement('div'),
    getViewportSize: () => ({ w: 360, h: 640 }),
    setTimeoutFn: () => { scheduled += 1; return scheduled; },
    clearTimeoutFn: () => {},
  });
  runtime.open({ autoFocus: false });
  assert.equal(scheduled, 0);
  assert.equal(runtime.getElements().inputEl.focused, false);
  console.log('ok - first-run command welcome can open without forcing the mobile keyboard');
}

{
  // 指令条盖住悬浮球：非交互区按下 → 转发球拖拽；交互控件不转发
  const documentRef = new FakeDocument();
  const modeSwitchEl = new FakeElement('div');
  const dragCalls = [];
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    modeSwitchEl,
    getViewportSize: () => ({ w: 360, h: 640 }),
    onSubmit: async () => ({ ok: true }),
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    getBallDragRuntime: () => ({
      startDrag: (event, options) => {
        dragCalls.push({ event, options });
        return true;
      },
    }),
  });
  assert.equal(runtime.open(), true);
  const { rootEl } = runtime.getElements();
  assert.equal(
    rootEl.children.some(child => child.className === 'maid-command-input-drag'),
    true,
    '指令条带常驻拖柄（touch-action:none 保移动端可拖）',
  );
  rootEl.dispatchEvent('pointerdown', { target: { closest: () => null } });
  assert.equal(dragCalls.length, 1, '非交互区按下转发球拖拽');
  assert.equal(dragCalls[0].options.suppressLongPress, true, '转发拖拽抑制长按');
  assert.equal(dragCalls[0].options.suppressClick, true, '转发区静止单击不得误触模式切换');
  rootEl.dispatchEvent('pointerdown', {
    target: { closest: selector => (String(selector).includes('textarea') ? {} : null) },
  });
  assert.equal(dragCalls.length, 1, '可用交互控件按下不转发拖拽');
  rootEl.dispatchEvent('pointerdown', {
    target: { closest: selector => (String(selector).includes('maid-onboarding-welcome') ? {} : null) },
  });
  assert.equal(dragCalls.length, 1, '新手任务卡滚动或点击不得转发成悬浮球拖拽');
  console.log('ok - maid command input 非交互区拖拽转发与控件豁免');
}

{
  // 执行流并入白色结果流：一次任务一张运行卡，叙述折叠进卡内思路，汇报单独显示，未打开时不消费
  const documentRef = new FakeDocument();
  const modeSwitchEl = new FakeElement('div');
  const openStates = [];
  let releaseSubmit = null;
  const snapshots = [];
  const view = (steps, terminal = false, status = 'running') => ({
    runId: 'run_1',
    title: '整理房间',
    status,
    terminal,
    startedAt: 1000,
    finishedAt: terminal ? 4000 : 0,
    steps,
  });
  const step = (id, seq, status) => ({ id, seq, title: `步骤${seq}`, toolName: `tool.${id}`, status, error: '' });
  let runtime;
  runtime = createMaidCommandInputRuntime({
    documentRef,
    modeSwitchEl,
    getViewportSize: () => ({ w: 360, h: 640 }),
    onSubmit: async (_text, controls) => {
      controls.setStatus('我先看看有哪些会话～', 'thinking');
      runtime.applyTraceView(view([step('a', 1, 'running')]));
      controls.setStatus('我已经取得结果，正在整理给你。', 'progress');
      const card = runtime.getElements().resultEl.children[0].children[0];
      const [rowsEl, , liveEl, thoughtEl] = card.children[1].children;
      snapshots.push({
        kinds: runtime.getResultMessages().map(item => item.kind || item.tone),
        live: liveEl.hidden ? '' : liveEl.innerHTML,
        thought: thoughtEl.innerHTML,
        rows: rowsEl.children.map(li => li.dataset.status),
        liveRowOutside: runtime.getElements().resultEl.children.some(node => node.dataset?.mciLive),
      });
      await new Promise(resolve => { releaseSubmit = resolve; });
      runtime.applyTraceView(view([step('a', 1, 'succeeded')], true, 'succeeded'));
      return { ok: true, message: '搞定了' };
    },
    onOpenStateChange: state => openStates.push({ ...state }),
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
  });

  assert.equal(runtime.applyTraceView(view([])), false, '指令条未打开 → 不消费（面板兜底）');
  assert.equal(runtime.open(), true);
  assert.equal(openStates.length, 1, '打开后应通知执行流重新仲裁');
  assert.equal(openStates[0].rootEl, runtime.getElements().rootEl, '打开通知应携带指令条锚点');
  runtime.getElements().inputEl.value = '整理房间';
  const pending = runtime.submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(snapshots[0].kinds, ['run'], '执行中只有一张运行卡，叙述不占气泡');
  assert.match(snapshots[0].thought, /思路 · 1/, '先到的叙述在 run 出现后并入卡内思路');
  assert.match(snapshots[0].live, /我已经取得结果，正在整理给你。/, '过程提示进卡内进行中行');
  assert.equal(snapshots[0].liveRowOutside, false, '有运行卡时不再另起 live 行');
  assert.deepEqual(snapshots[0].rows, ['running']);
  assert.equal(runtime.hasRunCard('run_1'), true, '卡内确认可承载');
  releaseSubmit();
  await pending;
  const items = runtime.getResultMessages();
  assert.deepEqual(items.map(item => item.kind || item.tone), ['run', 'success'], '汇报气泡在运行卡之后单独显示');
  assert.equal(items[1].message, '搞定了');
  assert.equal(runtime.getLiveStatus(), null, 'run 终态 live 行退场');
  const cardEl = runtime.getElements().resultEl.children[0].children[0];
  assert.equal(cardEl.dataset.state, 'done');
  assert.doesNotMatch(cardEl.children[0].innerHTML + cardEl.children[1].children[0].innerHTML, /搞定了/, '卡片不重复汇报正文');
  runtime.close();
  assert.equal(openStates.at(-1).open, false, '关闭后应通知执行流立即接管');
  assert.equal(runtime.applyTraceView(view([])), false, '指令条曾打开但已关闭 → 不再消费后台 run');
  assert.equal(runtime.hasRunCard('run_1'), false);
  console.log('ok - maid command input hosts one run card with folded thoughts and a separate report');
}

{
  // 运行卡按行 id 原位更新：同一 run 不新增外壳，已存在的行节点身份不变，新行才进场
  const documentRef = new FakeDocument();
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    modeSwitchEl: new FakeElement('div'),
    getViewportSize: () => ({ w: 360, h: 640 }),
    onSubmit: async () => ({ ok: true }),
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
  });
  runtime.open();
  const mkStep = (id, seq, status) => ({ id, seq, title: `步骤${seq}`, toolName: '', status, error: '' });
  const mkView = steps => ({ runId: 'run_s', title: '任务', status: 'running', terminal: false, startedAt: 1, steps });
  runtime.applyTraceView(mkView([mkStep('a', 1, 'running'), mkStep('b', 2, 'queued')]));
  const { resultEl } = runtime.getElements();
  assert.equal(resultEl.children.length, 1, '一次任务只有一个外壳');
  const wrapper = resultEl.children[0];
  const rowsEl = wrapper.children[0].children[1].children[0];
  assert.deepEqual(rowsEl.children.map(li => li.dataset.status), ['running', 'queued']);
  assert.ok(rowsEl.children.every(li => li.classList.contains('is-entering')), '首批行走进场');
  const rowA = rowsEl.children[0];
  runtime.applyTraceView(mkView([mkStep('a', 1, 'succeeded'), mkStep('b', 2, 'running')]));
  assert.equal(resultEl.children[0], wrapper, '外壳原位补丁');
  assert.equal(rowsEl.children[0], rowA, '既有行节点身份不变');
  assert.deepEqual(rowsEl.children.map(li => li.dataset.status), ['done', 'running']);
  assert.match(rowsEl.children[1].innerHTML, /mrc-row-icon/, '状态用图标表达');
  console.log('ok - maid command input patches run card rows in place');
}

{
  // 手机布局：宽度 ≤760 且主要触控时改为底部抽屉；执行中预览、结束升半屏、展开详情全屏、用户拖动为准
  const documentRef = new FakeDocument();
  const viewportListeners = new Map();
  const windowLike = {
    innerHeight: 800,
    visualViewport: {
      height: 500,
      offsetTop: 0,
      addEventListener: (type, handler) => viewportListeners.set(type, handler),
    },
  };
  let release = null;
  let runtime;
  runtime = createMaidCommandInputRuntime({
    documentRef,
    modeSwitchEl: new FakeElement('div'),
    getViewportSize: () => ({ w: 390, h: 800 }),
    matchMediaFn: query => ({ matches: query.includes('pointer: coarse') }),
    windowLike,
    onSubmit: async () => {
      runtime.applyTraceView({ runId: 'run_m', title: '任务', status: 'running', terminal: false, startedAt: 1, steps: [{ id: 'x', title: '读取', status: 'running' }] });
      await new Promise(resolve => { release = resolve; });
      runtime.applyTraceView({ runId: 'run_m', title: '任务', status: 'succeeded', terminal: true, startedAt: 1, finishedAt: 2, steps: [{ id: 'x', title: '读取', status: 'succeeded' }] });
      return { ok: true, message: '好了' };
    },
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
  });
  runtime.open({ autoFocus: false });
  const { rootEl } = runtime.getElements();
  assert.equal(rootEl.dataset.layout, 'sheet');
  assert.equal(rootEl.dataset.bubbleSide, undefined, '抽屉不再贴球翻转');
  assert.equal(rootEl.style.left, '', '抽屉由样式贴底，不写贴球坐标');
  assert.ok(viewportListeners.has('resize'), '监听软键盘');
  runtime.getElements().inputEl.value = '做点事';
  const pending = runtime.submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.getLayout().snap, 'peek', '执行中默认预览档');
  const handle = runtime.getElements().resultEl.children[0];
  assert.equal(handle.className, 'mci-sheet-handle', '抽屉把手在最上方');
  const card = runtime.getElements().resultEl.children[1].children[0];
  assert.ok(card.classList.contains('is-touch'), '手机上放大点击区');
  handle.dispatchEvent('click', { preventDefault() {} });
  assert.equal(runtime.getLayout().snap, 'half', '点把手切换档位');
  release();
  await pending;
  assert.equal(runtime.getLayout().snap, 'half', '用户选过的档位保留');
  runtime.getElements().inputEl.value = '再做一件';
  release = null;
  const second = runtime.submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.getLayout().snap, 'peek', '新任务重新按状态决定档位');
  release();
  await second;
  assert.equal(runtime.getLayout().snap, 'half', '结束后升到半屏看汇报');
  console.log('ok - maid command input uses a bottom sheet on touch phones');
}

{
  // runId 归属：执行流面板传入的 runId 与当前指令任务不符时不误停，且给出可见提示
  const documentRef = new FakeDocument();
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    getViewportSize: () => ({ w: 360, h: 640 }),
    onSubmit: async (_text, controls) => new Promise((resolve) => {
      controls.signal.addEventListener('abort', () => resolve({
        ok: false,
        status: 'cancelled',
        cancelled: true,
        reason: 'user_aborted',
        message: '已停止',
      }), { once: true });
    }),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  runtime.open();
  const { inputEl } = runtime.getElements();
  inputEl.value = '当前任务';
  const active = runtime.submit();
  runtime.applyTraceView({ runId: 'run-current', status: 'running', terminal: false, steps: [] });
  assert.equal(await runtime.cancelActive({ runId: 'run-other' }), false, '非当前 run 不得误停当前任务');
  assert.equal(runtime.isSubmitting(), true);
  assert.equal(await runtime.cancelActive({ runId: 'run-current' }), true, '匹配的 runId 正常停止');
  assert.equal((await active).status, 'cancelled');
  // 空闲时带 runId 的停止请求同样不抛错且返回 false
  assert.equal(await runtime.cancelActive({ runId: 'run-current' }), false);
  console.log('ok - execution-flow stop only cancels the submission that owns the projected run');
}

{
  const started = [], documentRef = new FakeDocument(); let voiceTasks;
  const runtime = createMaidCommandInputRuntime({ documentRef, getViewportSize: () => ({ w: 360, h: 640 }),
    getVoiceState: () => ({ available: true, call: 'listening' }),
    onVoiceTextSubmit: (text, attachments) => voiceTasks.request({ target: { maidCallId: 'voice' }, args: { request: text }, attachments, preserveDraft: false, showInput: true }),
    onAttachFiles: async files => files.map(file => ({ id: file.name, kind: 'image', url: 'data:image/png;base64,AA==', name: file.name })),
    onSubmit: (text, controls) => new Promise(resolve => { started.push({ text, controls, resolve }); controls.signal.addEventListener('abort', () => resolve({ cancelled: true })); }),
    setTimeoutFn: () => 0, clearTimeoutFn() {},
  });
  voiceTasks = createMaidVoiceTaskRuntime({ getCommandRuntime: () => runtime });
  runtime.open({ autoFocus: false }); runtime.getElements().inputEl.value = '保留草稿';
  await runtime.addFiles([{ name: 'ref.png', type: 'image/png', size: 12 }]); runtime.setStatus('旧结果', 'success');
  runtime.collapse(); assert.equal(runtime.isOpen(), false); assert.equal(runtime.getAttachments().length, 1);
  runtime.open({ autoFocus: false }); assert.equal(runtime.getElements().inputEl.value, '保留草稿'); assert.equal(runtime.getResultMessages().at(-1).message, '旧结果');
  documentRef.dispatchEvent('pointerdown', { target: new FakeElement() }); assert.equal(runtime.getAttachments().length, 1, 'voice outside-close preserves attachments');
  const first = await voiceTasks.request({ target: { maidCallId: 'voice' }, args: { request: '第一项' }, requestId: 'one' });
  assert.equal(runtime.isOpen(), false); assert.equal(runtime.getElements().inputEl.value, '保留草稿');
  const second = await voiceTasks.request({ target: { maidCallId: 'voice' }, args: { request: '第二项' }, requestId: 'two' });
  assert.equal(started.length, 1); assert.equal(runtime.getQueue()[0].id, second.task_id);
  await voiceTasks.cancel(first.task_id); await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 2, 'stop-current leaves the next queued task intact'); assert.equal(started[1].controls.source, 'maid_realtime');
  started[1].resolve({ ok: true, message: '完成第二项' }); await new Promise(resolve => setImmediate(resolve));
  runtime.open({ autoFocus: false }); const typed = await runtime.submit(); assert(typed.accepted);
  assert.equal(started[2].text, '保留草稿'); assert.equal(started[2].controls.attachments.length, 1); assert.equal(runtime.getAttachments().length, 0);
  started[2].resolve({ ok: true }); await new Promise(resolve => setImmediate(resolve));
  console.log('ok - continuous voice preserves drafts, uses the real queue and stops only the selected task');
}

{
  // 图片、技能、圈选收进“＋”：点开/选中即收起/Esc 收起；有附图或圈选时“＋”带状态点；附图卡点击放大
  const documentRef = new FakeDocument();
  const previews = [];
  let mountedMenu = null;
  const runtime = createMaidCommandInputRuntime({
    documentRef,
    getViewportSize: () => ({ w: 360, h: 640 }),
    onAttachFiles: async files => files.map((file, index) => ({ id: `img-${index}`, kind: 'image', url: `data:image/png;base64,${index}`, name: file.name })),
    onPreviewImage: url => previews.push(url),
    mountSkills: (root, menu, { onChange }) => { mountedMenu = menu; mountedMenu.onChange = onChange; },
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  runtime.open({ autoFocus: false });
  const { rootEl, moreBtn, menuEl, attachBtn, selectionBtn, attachmentsEl, settingsBtn, submitBtn } = runtime.getElements();
  assert.equal(mountedMenu, menuEl, '技能入口挂进“＋”菜单');
  assert.deepEqual(rootEl.children.filter(node => node.tagName === 'BUTTON'), [moreBtn, settingsBtn, submitBtn], '输入条常驻按钮只有＋、设置、语音/发送');
  assert.equal(attachBtn.parentNode, menuEl);
  assert.equal(selectionBtn.parentNode, menuEl);
  const click = () => ({ preventDefault() {}, stopPropagation() {} });
  moreBtn.dispatchEvent('click', click());
  assert.equal(menuEl.classList.contains('is-open'), true);
  assert.equal(moreBtn.attributes['aria-expanded'], 'true');
  menuEl.dispatchEvent('click', { target: { closest: () => attachBtn } });
  assert.equal(menuEl.classList.contains('is-open'), false, '选中一项后收起');
  moreBtn.dispatchEvent('click', click());
  rootEl.dispatchEvent('keydown', { key: 'Escape', ...click() });
  assert.equal(menuEl.classList.contains('is-open'), false, 'Esc 收起菜单');
  assert.equal(moreBtn.classList.contains('has-state'), false);
  runtime.setSelectionState({ active: false, count: 2 });
  assert.equal(moreBtn.classList.contains('has-state'), true, '有圈选内容时显示状态点');
  runtime.setSelectionState({ active: false, count: 0 });
  await runtime.addFiles([{ name: 'a.png', type: 'image/png', size: 1 }]);
  assert.equal(moreBtn.classList.contains('has-state'), true, '有附图时显示状态点');
  const card = attachmentsEl.children[0];
  const preview = card.children.find(node => node.className === 'maid-command-input-attachment-preview');
  attachmentsEl.dispatchEvent('click', { target: { closest: selector => (selector.includes('preview') ? preview : null) }, preventDefault() {} });
  assert.deepEqual(previews, ['data:image/png;base64,0'], '点击附图卡放大查看');
  moreBtn.dispatchEvent('click', click());
  runtime.close();
  assert.equal(menuEl.classList.contains('is-open'), false, '关闭输入条时一并收起菜单');
  console.log('ok - maid command input folds image/skills/selection into the plus menu');
}
