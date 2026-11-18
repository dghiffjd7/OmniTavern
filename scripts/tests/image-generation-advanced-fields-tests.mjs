import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { resolveAdvancedControlKind, normalizeAdvancedNumber, renderImageGenerationAdvancedFields } = await import('../../src/scripts/ui/image-generation-advanced-fields.js');
const { resolveImageGenerationParamSchema } = await import('../../src/scripts/ui/image-generation-params-utils.js');
const { IMAGE_PROMPT_TEXT_KEYS } = await import('../../src/scripts/ui/image-prompt/image-prompt-utils.js');
// 对话框的高级参数不含提示词类字段（照 chat-image-prompt-modal 的过滤）
const dialogFields = schema => schema.fields.filter(field => !IMAGE_PROMPT_TEXT_KEYS.includes(field.key));

// 最小的假 DOM：只做渲染器用到的部分
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.classList = {
      add: (...tokens) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...tokens])].join(' '); },
      remove: (...tokens) => { this.className = this.className.split(' ').filter(token => token && !tokens.includes(token)).join(' '); },
      toggle: (token, force) => { const on = force ?? !this.classList.contains(token); if (on) this.classList.add(token); else this.classList.remove(token); return on; },
      contains: token => this.className.split(' ').includes(token),
    };
  }
  set innerHTML(_value) { this.children = []; }
  appendChild(child) { this.children.push(child); return child; }
  append(...items) { items.forEach(item => this.appendChild(item)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  dispatchEvent(event) { (this.listeners.get(event.type) || []).forEach(handler => handler(event)); return true; }
  click() { this.dispatchEvent({ type: 'click' }); }
  all() { return this.children.flatMap(child => [child, ...child.all()]); }
  querySelectorAll(selector) {
    if (selector.startsWith('.')) return this.all().filter(node => node.classList.contains(selector.slice(1)));
    const option = selector.match(/^option\[value="(.+)"\]$/);
    if (option) return this.all().filter(node => node.tagName === 'OPTION' && node.value === option[1]);
    return [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const doc = { createElement: tag => new FakeElement(tag) };
const rowOf = (container, key) => container.all().find(node => node.dataset.paramRow === key);
const inputOf = (container, key) => container.all().find(node => node.dataset.paramKey === key);

{
  // 控件类型：选项少且短 → 分段；0～1 小数 → 滑杆；张数 → −／＋；其余照旧
  assert.equal(resolveAdvancedControlKind({ type: 'select', options: [{ label: '自动' }, { label: '低' }, { label: '中' }, { label: '高' }] }), 'segmented');
  assert.equal(resolveAdvancedControlKind({ type: 'select', options: [1, 2, 3, 4, 5].map(n => ({ label: `x${n}` })) }), 'select', 'more than four options stay a dropdown');
  assert.equal(resolveAdvancedControlKind({ type: 'select', options: [{ label: 'k_euler_ancestral' }, { label: 'ddim' }] }), 'select', 'long labels stay a dropdown');
  assert.equal(resolveAdvancedControlKind({ type: 'number', integer: false, min: 0, max: 1 }), 'slider');
  assert.equal(resolveAdvancedControlKind({ type: 'number', integer: false, min: 0, max: 30 }), 'number');
  assert.equal(resolveAdvancedControlKind({ type: 'number', key: 'n', min: 1, max: 10 }), 'stepper');
  assert.equal(resolveAdvancedControlKind({ type: 'image-size' }), 'size');
  // 小数字段保留小数（原本一律取整，NAI 的 Guidance Rescale 会被截成 0）
  assert.equal(normalizeAdvancedNumber({ integer: false, min: 0, max: 1 }, '0.35'), 0.35);
  assert.equal(normalizeAdvancedNumber({ min: 1, max: 10 }, '3.7'), 3);
  assert.equal(normalizeAdvancedNumber({ min: 1, max: 10 }, '99'), 10);
  assert.equal(normalizeAdvancedNumber({ defaultValue: 5 }, ''), 5);
  console.log('ok - advanced fields pick controls by field shape and keep decimals');
}

{
  // gpt-image：分组；分段按钮改值出现覆盖标记，「恢复」还原；PNG 时隐藏压缩质量；透明背景时 JPEG 不能选
  const schema = resolveImageGenerationParamSchema({ provider: 'openai', model: 'gpt-image-2' });
  const container = new FakeElement('div');
  let changes = 0;
  const base = { quality: 'high', output_format: 'png', background: 'auto' };
  const ui = renderImageGenerationAdvancedFields({ documentRef: doc, container, fields: dialogFields(schema).filter(field => field.type !== 'image-size'), values: { ...base }, base, onChange: () => { changes += 1; ui?.refresh(); } });
  assert.deepEqual(container.children.map(section => section.children[0].textContent), ['画面', '输出']);
  assert.equal(rowOf(container, 'output_compression').hidden, true, 'compression is hidden for PNG');

  const qualityRow = rowOf(container, 'quality');
  const low = qualityRow.querySelectorAll('.igp-segment').find(button => button.dataset.value === 'low');
  low.click();
  assert.equal(inputOf(container, 'quality').value, 'low');
  assert.ok(qualityRow.classList.contains('is-overridden'));
  assert.equal(low.getAttribute('aria-checked'), 'true');
  qualityRow.querySelector('.igp-adv-reset').click();
  assert.equal(inputOf(container, 'quality').value, 'high');
  assert.equal(qualityRow.classList.contains('is-overridden'), false);

  const formatRow = rowOf(container, 'output_format');
  formatRow.querySelectorAll('.igp-segment').find(button => button.dataset.value === 'jpeg').click();
  assert.equal(rowOf(container, 'output_compression').hidden, false, 'compression shows for JPEG');
  rowOf(container, 'background').querySelectorAll('.igp-segment').find(button => button.dataset.value === 'transparent').click();
  assert.equal(inputOf(container, 'output_format').value, 'png', 'transparent backgrounds switch JPEG to PNG');
  assert.equal(formatRow.querySelectorAll('.igp-segment').find(button => button.dataset.value === 'jpeg').disabled, true);
  assert.ok(changes >= 4);

  // 张数 −／＋：夹在范围内
  const n = inputOf(container, 'n');
  const [minus, , plus] = rowOf(container, 'n').querySelector('.igp-stepper').children;
  minus.click();
  assert.equal(n.value, '1', 'cannot go below the minimum');
  plus.click();
  assert.equal(n.value, '2');
  console.log('ok - advanced fields group, mark overrides, reset and keep output options consistent');
}

{
  // NAI：0～1 的小数用滑杆，显示的值不截断；精准参考自成一组
  const schema = resolveImageGenerationParamSchema({ provider: 'novelai', model: 'nai-diffusion-4-5-full' });
  const container = new FakeElement('div');
  renderImageGenerationAdvancedFields({ documentRef: doc, container, fields: dialogFields(schema), values: { cfgRescale: 0.35 }, base: {} });
  assert.deepEqual(container.children.map(section => section.children[0].textContent), ['画面', '生成', '精准参考']);
  const slider = inputOf(container, 'cfgRescale');
  assert.deepEqual([slider.type, slider.value, rowOf(container, 'cfgRescale').querySelector('.igp-slider-value').textContent], ['range', '0.35', '0.35']);
  console.log('ok - NovelAI decimals use sliders and precise reference has its own group');
}

console.log('image-generation-advanced-fields-tests passed');
