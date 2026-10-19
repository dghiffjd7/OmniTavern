// Agent 卡片／房子表单里的「提示词 | 套用预设」（设计页 https://claude.ai/artifact/GuwKVZkqYHALvJMe2KsUkL）。
// 只渲染与绑定界面；预设列表、分类、预览与试运行由 services 注入（app.js 装配）。
// 选择记在带 hidden 属性的文本框里（模式、预设 id），radio 只负责显示：编辑区草稿按 value/defaultValue 判断未保存，
// radio 的 value 不变、type=hidden 的 input 改 value 会连 defaultValue 一起改，都判断不了。
import { resolveContactGroupColor } from '../storage/contact-group-color-utils.js';
import { t } from '../i18n/index.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const FILL_LABELS = {
  charDescription: '角色描述',
  charPersonality: '性格',
  scenario: '场景',
  personaDescription: '用户设定',
};
const EMPTY_LABELS = { worldInfoBefore: '世界书', worldInfoAfter: '世界书', dialogueExamples: '对话示例' };

// 各 Agent 的说明文字：聊天记录位置放什么、程序要读的格式、输出上限、附注。
export const AGENT_PRESET_KIND_COPY = Object.freeze({
  summary_compaction: {
    data: '已有大总结 + 待合并的摘要',
    format: '结果要写在 <summary>…</summary> 里，请确认预设有这个要求；可以先试运行看看',
    limit: '输出上限 {value} · 固定',
    note: '动态的大总结仍用「提示词」里的文字。切回「提示词」时，原来的文字还在。',
  },
  custom_house: {
    data: '最近对话（按「上下文」设定）、本轮输入；排在正文之后时再加正文和前面房子的产物',
    format: '',
    limit: '输出上限 · 按「最大输出 token」',
    note: '套用预设时不发送「系统提示词」。预设条目里也能用 {{user_input}} · {{body}} · {{house:id}}。',
  },
  // 第二阶段：直接发请求的 Agent。补丁类的返回格式带当次版本标记，由程序附加（info）；简单格式由预设写（warn）。
  text_edit: {
    data: '参考上下文与要修改的正文',
    format: '修改建议的返回格式（含当次版本标记）由程序附在最后，预设不用写',
    formatTone: 'info',
    limit: '输出上限 {value} · 按 Agent 设置',
    note: '思考模式仍按 Agent 自己的设置。切回「提示词」时，原来的任务要求和区块还在。',
  },
  agent_note: {
    data: '参考资料与要处理的内容',
    format: '',
    limit: '输出上限 {value} · 按 Agent 设置',
    note: '思考模式仍按 Agent 自己的设置。切回「提示词」时，原来的任务要求和区块还在。',
  },
  input_suggestion: {
    data: '参考上下文与光标前后的文字',
    format: '',
    limit: '输出上限 {value} · 按 Agent 设置',
    note: '续写会直接插到光标处，预设要让模型只回续写的文字。思考模式仍按 Agent 自己的设置。',
  },
  input_rewrite: {
    data: '参考上下文与草稿',
    format: '修改建议的返回格式（含当次版本标记）由程序附在最后，预设不用写',
    formatTone: 'info',
    limit: '输出上限 {value} · 按 Agent 设置',
    note: '思考模式仍按 Agent 自己的设置。切回「提示词」时，原来的任务要求和区块还在。',
  },
  input_note: {
    data: '参考上下文与草稿',
    format: '',
    limit: '输出上限 {value} · 按 Agent 设置',
    note: '思考模式仍按 Agent 自己的设置。切回「提示词」时，原来的任务要求和区块还在。',
  },
  format_repair: {
    data: '原文、格式规则、解析结果与参考上下文',
    format: '补丁协议与场景规则（含当次版本标记）由程序附在最后，预设不用写',
    formatTone: 'info',
    limit: '输出上限 {value} · 按 Agent 设置',
    note: '「格式要求」仍会发送。思考模式仍按 Agent 自己的设置。',
  },
  image_prompt_house: {
    data: '本轮输入与正文',
    format: '结果要写在 {open}…{close} 里（不需要配图时写 none），请确认预设有这个要求',
    formatParams: { open: '<image_prompt>', close: '</image_prompt>' },
    limit: '输出上限 {value} · 固定',
    note: '套用预设时不用 Agent Center 图片提示卡里的规则；图片提示融合在正文里时不受影响。',
  },
  variable_ai_evaluate: {
    data: '最近 6 条对话',
    format: '结果要只是一个数字（按「应用方式」是增量或新值），请确认预设有这个要求',
    limit: '输出上限 {value} · 固定',
    note: '只要一个数字，所以不思考，预设里的推理设置不生效。切回「提示词」时，原来的评估提示词还在。',
  },
  archive_naming: {
    data: '对话摘录',
    format: '结果要是 JSON {"title":"名称"}，请确认预设有这个要求',
    limit: '输出上限 {value} · 按 Agent 设置',
    note: '切回「提示词」时，原来的补充要求还在。',
  },
});

const copyOf = kind => AGENT_PRESET_KIND_COPY[kind] || AGENT_PRESET_KIND_COPY.summary_compaction;

const unique = list => [...new Set(list)];
let radioGroupSeq = 0;

export const renderAgentPresetInfo = ({ kind = '', view = null, limitValue = '' } = {}) => {
  const copy = copyOf(kind);
  if (!view?.ok) return '';
  const d = view.describe || {};
  const filled = unique((d.filled || []).map(key => t(FILL_LABELS[key] || key)));
  const empty = unique((d.leftEmpty || []).map(key => t(EMPTY_LABELS[key] || key)));
  const lines = [
    `<div class="agent-preset-info-main">${escapeHtml(d.enabledEntries ? t('将使用 {count} 个已启用条目', { count: d.enabledEntries }) : t('这个预设没有启用的条目'))}</div>`,
    `<div>${escapeHtml(d.hasHistorySlot
      ? t('「聊天记录」位置放入：{value}', { value: t(copy.data) })
      : t('预设没有「聊天记录」位置，{value}放在最后', { value: t(copy.data) }))}</div>`,
  ];
  if (filled.length || empty.length) {
    const parts = [];
    if (filled.length) parts.push(t('{fields}按当前会话填入', { fields: filled.join('、') }));
    if (empty.length) parts.push(t('{fields}留空', { fields: empty.join('、') }));
    lines.push(`<div>${escapeHtml(parts.join('；'))}</div>`);
  }
  if (copy.format) {
    lines.push(`<div class="${copy.formatTone === 'info' ? 'agent-preset-info-fixed' : 'agent-preset-info-warn'}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg><span>${escapeHtml(t(copy.format, copy.formatParams || {}))}</span></div>`);
  }
  return `<div class="agent-preset-info">${lines.join('')}</div>
    <div class="agent-preset-chips">
      <span class="is-accent">${escapeHtml(t('温度、Top P 等 · 跟预设'))}</span>
      <span>${escapeHtml(t(copy.limit, { value: limitValue }))}</span>
      <span>${escapeHtml(t('模型 · 不变'))}</span>
    </div>
    <p class="agent-preset-note">${escapeHtml(t(copy.note))}</p>`;
};

const renderPickerLabel = (view, presetId) => {
  if (!presetId) return `<span class="agent-preset-picker-name is-placeholder">${escapeHtml(t('选择预设…'))}</span>`;
  const group = view?.groupName
    ? `<span class="agent-preset-picker-group"><span style="background:${resolveContactGroupColor(view.groupColor).value}" aria-hidden="true"></span><span data-i18n-skip="true">${escapeHtml(view.groupName)}</span></span>`
    : '';
  return `<span class="agent-preset-picker-name" data-i18n-skip="true">${escapeHtml(view?.name || presetId)}</span>${group}`;
};

// mode/presetId 为已保存的设置；view = services.describePreset(presetId)。选了预设但已被删除时显示「提示词」并提示。
// showActions=false：所在编辑器已有自己的预览与试运行（如 Agent 配置编辑器），不再重复放按钮。
export const renderAgentPresetSourceControl = ({ scope = '', kind = '', mode = 'prompt', presetId = '', view = null, limitValue = '', showActions = true } = {}) => {
  const id = String(presetId || '').trim();
  const missing = mode === 'preset' && id && !view?.ok;
  const effectiveMode = mode === 'preset' && !missing ? 'preset' : 'prompt';
  // 同一卡片可能同时出现在主面板与浮卡：radio 组名带序号，互不干扰。
  const name = `agent-preset-source-${scope}-${++radioGroupSeq}`;
  const radio = (value, label) => `<label class="agent-preset-seg-option">
      <input type="radio" name="${escapeHtml(name)}" value="${value}" data-agent-preset-mode ${effectiveMode === value ? 'checked' : ''}>
      <span>${escapeHtml(t(label))}</span>
    </label>`;
  return `<div class="agent-preset-source" data-agent-preset-source="${escapeHtml(scope)}" data-agent-preset-kind="${escapeHtml(kind)}" data-agent-preset-limit="${escapeHtml(limitValue)}">
    <div class="agent-preset-seg" role="radiogroup" aria-label="${escapeHtml(t('提示词来源'))}">${radio('prompt', '提示词')}${radio('preset', '套用预设')}</div>
    <input type="text" hidden data-agent-preset-mode-value value="${effectiveMode}" aria-hidden="true" tabindex="-1">
    <input type="text" hidden data-agent-preset-id value="${escapeHtml(missing ? '' : id)}" aria-hidden="true" tabindex="-1">
    ${missing ? `<div class="agent-preset-missing" role="status">${escapeHtml(t('所选预设已被删除，现在用「提示词」。'))}</div>` : ''}
    <div class="agent-preset-body" data-agent-preset-body ${effectiveMode === 'preset' ? '' : 'hidden'}>
      <span class="agent-preset-label">${escapeHtml(t('预设'))}</span>
      <button type="button" class="agent-preset-picker" data-agent-preset-pick aria-haspopup="dialog" aria-expanded="false">
        <span class="agent-preset-picker-label" data-agent-preset-picker-label>${renderPickerLabel(view, missing ? '' : id)}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>
      </button>
      <div data-agent-preset-info>${missing || !id ? `<p class="agent-preset-note">${escapeHtml(t('还没选预设。选好前仍用「提示词」里的文字。'))}</p>` : renderAgentPresetInfo({ kind, view, limitValue })}</div>
      ${showActions ? `<div class="agent-preset-actions">
        <button type="button" class="agent-center-card-action" data-agent-preset-preview>${escapeHtml(t('预览请求'))}</button>
        <button type="button" class="agent-center-card-action" data-agent-preset-trial>${escapeHtml(t('试运行'))}</button>
      </div>` : ''}
      <div class="agent-preset-result" data-agent-preset-result aria-live="polite"></div>
    </div>
  </div>`;
};

export const readAgentPresetSource = (control) => ({
  mode: (control?.querySelector('[data-agent-preset-mode-value]')?.value
    ?? control?.querySelector('[data-agent-preset-mode]:checked')?.value) === 'preset' ? 'preset' : 'prompt',
  presetId: String(control?.querySelector('[data-agent-preset-id]')?.value || '').trim(),
});

const truncate = (value, max) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const renderPreview = (result) => {
  if (!result?.ok) return `<p class="agent-preset-error">${escapeHtml(t(result?.message || '无法预览'))}</p>`;
  const rows = (result.messages || []).map(message => `<div class="agent-preset-preview-row">
      <span class="agent-preset-role is-${escapeHtml(message.role)}">${escapeHtml(message.role)}</span>
      <span data-i18n-skip="true">${escapeHtml(truncate(message.content, 90))}</span>
    </div>`).join('');
  return `<div class="agent-preset-preview"><div class="agent-preset-result-title">${escapeHtml(t('实际发送（不请求模型）· {count} 条消息', { count: (result.messages || []).length }))}</div>${rows}</div>`;
};

const renderTrial = (result) => {
  const meta = Number.isFinite(result?.latencyMs) ? `<span class="agent-preset-result-meta">${escapeHtml(t('{value} 秒', { value: (result.latencyMs / 1000).toFixed(1) }))}</span>` : '';
  const text = String(result?.text || '');
  const body = text ? `<div class="agent-preset-result-text" data-i18n-skip="true">${escapeHtml(text.length > 1600 ? `${text.slice(0, 1600)}…` : text)}</div>` : '';
  const status = result?.ok
    ? `<div class="agent-preset-result-status is-ok">${escapeHtml(t(result.message || '完成'))}</div>`
    : `<div class="agent-preset-result-status is-fail">${escapeHtml(t(result?.message || '试运行失败'))}</div>`;
  return `<div class="agent-preset-trial"><div class="agent-preset-result-head"><span class="agent-preset-result-title">${escapeHtml(t('试运行结果'))}</span><span class="agent-preset-result-tag">${escapeHtml(t('未保存'))}</span>${meta}</div>${body}${status}</div>`;
};

// 逐个控件绑定（每个只绑一次）；提示词区（data-agent-preset-prompt-part）与标签（data-agent-preset-tag）
// 在控件所在的 data-agent-preset-area 里找。getContext(control) 给出试运行／预览需要的上下文（如房子当前的草稿配置）。
export const bindAgentPresetSourceControls = (root, { services = null, getContext = () => ({}) } = {}) => {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll('[data-agent-preset-source]').forEach((control) => {
    if (control.dataset.agentPresetBound === 'true') return;
    control.dataset.agentPresetBound = 'true';
    const area = control.closest('[data-agent-preset-area]') || control.parentElement || control;
    let running = null;

    const sync = () => {
      const { mode, presetId } = readAgentPresetSource(control);
      const isPreset = mode === 'preset';
      const body = control.querySelector('[data-agent-preset-body]');
      if (body) body.hidden = !isPreset;
      // 选好预设才真的不用提示词；没选时提示词区仍显示，与运行时退回提示词一致。
      area.querySelectorAll('[data-agent-preset-prompt-part]').forEach(part => { part.hidden = isPreset && Boolean(presetId); });
      const view = isPreset && presetId ? services?.describePreset?.(presetId) : null;
      area.querySelectorAll('[data-agent-preset-tag]').forEach(tag => {
        tag.textContent = view?.ok ? t('预设 · {name}', { name: view.name }) : t('提示词');
      });
    };

    const setPreset = (presetId) => {
      const field = control.querySelector('[data-agent-preset-id]');
      if (!field) return;
      field.value = presetId;
      const view = services?.describePreset?.(presetId) || null;
      control.querySelector('[data-agent-preset-picker-label]').innerHTML = renderPickerLabel(view, presetId);
      control.querySelector('[data-agent-preset-info]').innerHTML = renderAgentPresetInfo({
        kind: control.dataset.agentPresetKind, view, limitValue: control.dataset.agentPresetLimit,
      });
      control.querySelector('[data-agent-preset-result]').innerHTML = '';
      control.querySelector('.agent-preset-missing')?.remove();
      sync();
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const modeField = control.querySelector('[data-agent-preset-mode-value]');
    // 草稿恢复可能先改了文本框：radio 跟着文本框走。
    control.querySelectorAll('[data-agent-preset-mode]').forEach(radio => { radio.checked = radio.value === (modeField?.value || 'prompt'); });
    control.addEventListener('change', (event) => {
      const radio = event.target.closest('[data-agent-preset-mode]');
      if (!radio) return;
      if (modeField) {
        modeField.value = radio.value;
        modeField.dispatchEvent(new Event('input', { bubbles: true }));
      }
      sync();
    });

    control.addEventListener('click', async (event) => {
      if (!services) return;
      const result = control.querySelector('[data-agent-preset-result]');
      const pick = event.target.closest('[data-agent-preset-pick]');
      if (pick) {
        services.openPicker?.({
          anchorEl: pick,
          currentId: readAgentPresetSource(control).presetId,
          onSelect: presetId => setPreset(presetId),
          onGroupsChanged: () => {
            const current = readAgentPresetSource(control).presetId;
            if (current) control.querySelector('[data-agent-preset-picker-label]').innerHTML = renderPickerLabel(services.describePreset?.(current), current);
          },
        });
        return;
      }
      const { presetId } = readAgentPresetSource(control);
      const kind = control.dataset.agentPresetKind;
      if (event.target.closest('[data-agent-preset-preview]')) {
        if (!presetId) { result.innerHTML = renderPreview({ ok: false, message: '请先选择预设' }); return; }
        result.innerHTML = `<p class="agent-preset-note">${escapeHtml(t('正在组装…'))}</p>`;
        let preview = null;
        try {
          preview = await services.preview?.({ kind, presetId, context: getContext(control) });
        } catch (error) {
          preview = { ok: false, message: String(error?.message || error || '无法预览') };
        }
        result.innerHTML = renderPreview(preview);
        return;
      }
      if (event.target.closest('[data-agent-preset-stop]')) {
        running?.abort();
        return;
      }
      if (event.target.closest('[data-agent-preset-trial]')) {
        if (!presetId) { result.innerHTML = renderTrial({ ok: false, message: '请先选择预设' }); return; }
        running?.abort();
        const controller = new AbortController();
        running = controller;
        result.innerHTML = `<div class="agent-preset-running"><span>${escapeHtml(t('试运行中…只看结果，不保存'))}</span><button type="button" class="agent-center-card-action" data-agent-preset-stop>${escapeHtml(t('停止'))}</button></div>`;
        let outcome = null;
        try {
          outcome = await services.trial?.({ kind, presetId, context: getContext(control), signal: controller.signal });
        } catch (error) {
          outcome = { ok: false, message: String(error?.message || error || '试运行失败') };
        }
        if (running !== controller) return;
        running = null;
        result.innerHTML = renderTrial(controller.signal.aborted ? { ok: false, message: '已停止' } : outcome);
      }
    });

    sync();
  });
};
