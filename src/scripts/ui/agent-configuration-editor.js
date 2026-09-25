import { t } from '../i18n/index.js';
import { createUtilityAgentEditor } from './utility-agent-editor.js';
import { appConfirm, appChoice } from './app-confirm.js';
import { createFormatRepairProfileDraft, createFormatRepairProfileId } from '../agent/format-repair-profiles.js';
import { mountAgentRequestPreview } from './chat/agent-request-preview.js';
import { createCustomSelectWrapper, bindCustomSelectButton, refreshCustomSelectButton, openCustomSelectMenu, closeCustomSelectMenu } from './custom-select.js';
import { rankModelCandidates } from '../utils/model-candidates.js';
import { mapAgentRawSelection } from '../agent/agent-text-target.js';
import { allowsAgentInvocation, getAgentInvocationMode, isInputAgent } from '../agent/agent-invocation.js';
import { createAgentReferenceEditor, createAgentToolCapabilitiesEditor } from './agent-reference-editor.js';
import { createAgentRunCards } from './agent-run-cards.js';
import { createAgentGenerationEditor } from './agent-generation-editor.js';
import { bindAgentEditorMotion } from './agent-editor-motion.js';
import { getBuiltinAgentTask, resolveBuiltinAgentTask } from '../agent/agent-builtin-defaults.js';
import { getAgentPromptFields } from './chat/agent-prompt-fields.js';
import { readConfiguredPromptField, patchConfiguredPromptField } from './agent-prompt-field-save.js';
import { normalizePresetBlockText } from './preset-preview-utils.js';
import { AGENT_ICONS, agentIconMarkup, getAgentIconName } from '../agent/agent-icons.js';

const e = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const clone = value => JSON.parse(JSON.stringify(value));
const icon = name => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${({ copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>', remove: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>', up: '<path d="m6 14 6-6 6 6"/>', down: '<path d="m6 10 6 6 6-6"/>' })[name]}</svg>`;

const installStyle = doc => {
  if (doc.getElementById('agent-configuration-style')) return;
  const style = doc.createElement('style'); style.id = 'agent-configuration-style';
  style.textContent = `
  .agent-config-editor {display:grid;gap:18px;padding:4px 0 0;min-width:0}
  .agent-config-editor .ac-repair-library{display:grid;gap:12px;padding:14px;border:1px solid var(--app-border-default);border-radius:16px;background:var(--app-surface-subtle)}.agent-config-editor .ac-repair-library .ac-row{align-items:end}.agent-config-editor .ac-repair-library .ac-row>label{flex:1}.agent-config-editor .ac-repair-actions{display:flex;gap:8px;flex-wrap:wrap}.agent-config-editor .ac-repair-actions button{min-height:44px}.agent-config-editor .ac-repair-name[aria-invalid=true]{border-color:var(--app-danger-text,var(--danger-color))}
  .agent-config-editor label,.agent-config-editor .ac-field {display:grid;gap:8px;min-width:0}
  .agent-config-editor input:not([type=checkbox]),.agent-config-editor textarea,.agent-config-editor select{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--border-color,rgba(128,128,128,.22));border-radius:12px;padding:10px 12px;background:var(--input-bg,rgba(128,128,128,.06));color:inherit;font:inherit;outline:none}
  .agent-config-editor textarea{resize:vertical;min-height:100px;line-height:1.7}
  .agent-config-editor :is(input,textarea,select):focus-visible{border-color:var(--accent-color,#888bb4);box-shadow:0 0 0 3px rgba(128,128,155,.1)}
  .agent-config-editor .ac-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.agent-config-editor .ac-row>*{flex:1;min-width:0}.agent-config-editor .ac-row>button{flex:0 0 auto}
  .agent-config-editor .ac-switch{display:flex;align-items:center;justify-content:space-between;gap:12px}.agent-config-editor .ac-switch input{accent-color:var(--accent-color,#878ba4);width:18px;height:18px}
  .agent-config-editor .ac-switch>button{min-height:44px;height:44px}
  .agent-config-editor .ac-identity{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:end}.agent-config-editor .ac-identity .ac-switch{align-self:end;height:44px;gap:8px}
  .agent-config-editor .ac-icons{display:flex;gap:6px;flex-wrap:wrap}.agent-config-editor .ac-icons button{width:44px;height:44px;border:1px solid var(--app-border-default);border-radius:12px;background:var(--app-surface-subtle);color:var(--app-text-secondary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}.agent-config-editor .ac-icons button[aria-pressed=true]{color:var(--app-accent-primary);background:var(--app-accent-soft);border-color:var(--app-accent-primary)}.agent-config-editor .ac-icons button:focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:2px}
  .agent-config-editor .ac-task{display:grid;gap:10px}.agent-config-editor .ac-task textarea{min-height:176px;line-height:1.85;padding:14px 16px;border-color:var(--app-border-default);background:var(--app-surface-subtle);border-radius:16px;transition:border-color .15s,box-shadow .15s}.agent-config-editor .ac-task textarea:focus-visible{border-color:var(--app-accent-primary);box-shadow:0 2px 0 0 color-mix(in srgb,var(--app-accent-primary) 20%,transparent)}
  .agent-config-editor .ac-task-meta{display:flex;gap:12px;align-items:center;justify-content:space-between}.agent-config-editor .ac-task-count{font-size:11px;font-weight:400;color:var(--app-text-secondary);font-variant-numeric:tabular-nums}
  .agent-config-editor .ac-task-tools{display:flex;gap:8px;align-items:center;flex-shrink:0}.agent-config-editor .ac-task-origin{font-size:11px;font-weight:400;color:var(--app-text-secondary)}.agent-config-editor .ac-task-tools .agent-center-icon-button{width:44px;height:44px}.agent-config-editor .ac-task-tools button:disabled{opacity:.35;cursor:default}
  .agent-config-editor .ac-builtin-inputs{display:grid;gap:10px}.agent-config-editor .ac-builtin-chips{display:flex;gap:6px;flex-wrap:wrap}.agent-config-editor .ac-builtin-chip{padding:6px 9px;border:1px solid var(--app-border-default);border-radius:9px;background:var(--app-surface-subtle);font-size:12px;line-height:1.5}.agent-config-editor .ac-builtin-chip.has-help:focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:2px}.agent-config-editor .ac-builtin-chip small{font-size:11px;color:var(--app-text-secondary);margin-left:6px}
  .agent-config-editor .ac-builtin-settings{display:grid;gap:14px}.agent-config-editor .ac-readonly-value{padding:10px 0;font-size:13px;color:var(--app-text-secondary);overflow-wrap:anywhere}
  .agent-config-editor [data-agent-effort][hidden],.agent-config-editor [data-agent-budget-hint][hidden]{display:none}
  .agent-config-editor .ac-modes{display:grid;grid-template-columns:1fr 1fr 1.3fr;gap:3px;padding:4px;border:1px solid var(--app-border-default);border-radius:13px;background:var(--app-surface-subtle)}
  .agent-config-editor .ac-modes label{position:relative;display:flex;align-items:center;justify-content:center;min-height:44px;padding:0 5px;border:1px solid transparent;border-radius:9px;font-size:12px;cursor:pointer;white-space:nowrap;transition:background .16s,border-color .16s,color .16s,box-shadow .16s}
  .agent-config-editor .ac-modes input{position:absolute;opacity:0;width:1px;height:1px;padding:0}
  .agent-config-editor .ac-modes label:has(input:checked){background:var(--app-surface-card);border-color:var(--app-border-default);color:var(--app-accent-primary);font-weight:650;box-shadow:0 1px 4px #0000000a}
  .agent-config-editor .ac-modes label:has(input:focus-visible){outline:2px solid var(--app-accent-primary);outline-offset:2px}
  .agent-config-editor .ac-trigger{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px;font-size:12px;color:var(--app-text-secondary)}
  .agent-config-editor .ac-field-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}.agent-config-editor .ac-field-boundary{font-size:10px;font-weight:400;color:var(--app-text-secondary);padding:3px 7px;border-radius:7px;background:var(--app-surface-subtle)}
  .agent-config-editor .ac-label{font-size:13px;font-weight:600}.agent-config-editor .ac-source{font-size:12px;opacity:.65}.agent-config-editor details{border-top:1px solid var(--border-color,rgba(128,128,128,.2));padding-top:8px}.agent-config-editor summary{box-sizing:border-box;cursor:pointer;font-size:13px;font-weight:600;min-height:44px;padding:13px 0;line-height:18px;list-style-position:inside}.agent-config-editor details[open]>summary{margin-bottom:8px}.agent-config-editor summary:focus-visible{outline:2px solid var(--app-accent-primary);outline-offset:3px;border-radius:6px}
  .agent-config-editor .ac-target-preview{border:1px solid var(--app-border-default);border-radius:13px;padding:0 12px;background:var(--app-surface-subtle)}.agent-config-editor .ac-target-preview[open]{padding-bottom:12px}.agent-config-editor .ac-target-meta{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:8px}.agent-config-editor .ac-target-meta .ac-actions{justify-content:flex-end}.agent-config-editor .ac-target-empty{padding:12px 0;font-size:12px;color:var(--app-text-secondary)}
  .agent-config-editor .ac-block{display:grid;gap:8px;padding:12px;border-radius:14px;background:rgba(128,128,128,.055);margin:10px 0}.agent-config-editor .ac-block-heading{display:grid;grid-template-columns:minmax(0,1fr) 44px;gap:8px;align-items:center}.agent-config-editor .ac-block-enabled{display:flex;align-items:center;justify-content:center;min-height:44px;cursor:pointer}.agent-config-editor .ac-block-enabled input{width:18px;height:18px;accent-color:var(--app-accent-primary)}.agent-config-editor .ac-block-actions{display:flex;justify-content:flex-end;gap:4px}
  .agent-config-editor .ac-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.agent-config-editor .ac-target-source{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;border-radius:12px;background:rgba(128,128,128,.05);padding:12px;font-size:12px;line-height:1.7}.agent-config-editor mark{background:rgba(118,172,145,.24);color:inherit;border-radius:3px}
  .agent-config-editor .ac-error{font-size:12px;color:var(--danger-color,#ce5965)}.agent-config-editor .ac-run{border-left:2px solid rgba(128,128,128,.3);padding:9px 12px;font-size:12px;margin:8px 0}.agent-config-editor .ac-status{min-height:1em;font-size:12px}.agent-config-editor .ac-raw-select{font-family:monospace;min-height:180px}
  .agent-config-editor .ac-actions button,.agent-config-editor .agent-center-icon-button{min-height:44px}.agent-config-editor .agent-center-icon-button{min-width:44px}.agent-config-editor .ac-footer{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 0 8px;border-top:1px solid var(--app-border-default);background:var(--app-surface-card)}.agent-config-editor .ac-footer .ac-status{flex:1;min-width:80px;color:var(--app-text-secondary)}.agent-config-editor .ac-footer .ac-actions{margin-left:auto;flex-shrink:0}.agent-config-editor .ac-quick-result{display:contents}.agent-config-editor .ac-footer [data-ac=save]{border-color:var(--app-accent-primary);background:var(--app-accent-primary);color:var(--app-text-on-accent,#fff)}.agent-config-editor .ac-footer button:disabled{opacity:.55;cursor:wait}.agent-config-editor .ac-more .ac-actions{display:grid;grid-template-columns:1fr;justify-items:start}.agent-config-editor .ac-more [data-ac=delete]{color:var(--danger-color,#ce5965)}
  .agent-config-editor .ac-model-row{display:flex;gap:8px;align-items:center;min-width:0}.agent-config-editor .ac-model-row input{flex:1;min-width:0}.agent-config-editor [data-ac-model-status]{color:var(--app-text-secondary);font-size:12px}.agent-config-editor [data-ac-model-status]:empty{display:none}
  @media(max-width:600px){.agent-config-editor{gap:16px}.agent-config-editor .ac-identity{gap:10px}.agent-config-editor .ac-task textarea{min-height:160px}.agent-config-editor .ac-target-source{max-height:240px}.agent-config-editor .ac-footer{padding-bottom:max(8px,env(safe-area-inset-bottom))}.agent-config-editor .ac-footer .ac-status:empty{display:none}.agent-config-editor .ac-footer .ac-actions{flex:1}.agent-config-editor .ac-footer .ac-actions button{flex:1}}
  @media(prefers-reduced-motion:reduce){.agent-config-editor .ac-modes label,.agent-config-editor .ac-task textarea{transition:none!important}}
  body[data-reduced-motion=on] .agent-config-editor :is(.ac-modes label,.ac-task textarea){transition:none!important}
  `; doc.head.append(style);
};

// Own the draft DOM so periodic AC refreshes never erase unsaved prompt blocks.
export const createAgentConfigurationEditor = ({ actions, id, scope = 'local', context, messageId = '', repairProfileId = '', newRepairProfile = false, targetSnapshot = null, documentRef = document, onDeleted = () => {} }) => {
  const doc = documentRef; installStyle(doc);
  if (['archive_naming', 'reply_scoring'].includes(id)) return createUtilityAgentEditor({ actions, id, scope, context, documentRef: doc });
  const node = doc.createElement('div'); node.className = 'agent-config-editor'; node.dataset.agentCommonEditor = id;
  let saved = actions.getAgentConfiguration({ id, scope, context, ...(repairProfileId ? { repairProfileId } : {}) }), config = clone(saved.config), bodyRule = clone(saved.bodyRule);
  repairProfileId = config.repairProfileId || '';
  context = saved.context; scope = saved.scope;
  let initial = '', preview = null, targetView = null, busy = false, alive = true, status = '', sourceRequest = 0, modelRequest = 0, selection = null, skipTargetToggle = false;
  let referenceEditor = null, toolsEditor = null, runCards = null, motion = null, generationEditor = null, modelInfo = {};
  const stamp = () => JSON.stringify([config, bodyRule]);
  initial = stamp();
  if (id === 'reply_check' && (newRepairProfile || !repairProfileId)) {
    config = createFormatRepairProfileDraft(config); repairProfileId = config.repairProfileId;
  }
  const hasDraft = () => stamp() !== initial;
  const builtin = id === 'text_completion' || id === 'reply_check';
  const taskValue = () => builtin ? resolveBuiltinAgentTask(config, id) : config.prompt;
  const defaultTask = () => getBuiltinAgentTask(id);
  const usesDefaultTask = () => builtin && taskValue().trim() === defaultTask().trim();
  const runLabel = () => !isInputAgent(config) && id !== 'reply_check' ? (hasDraft() ? '保存并试运行' : '试运行') : (hasDraft() ? '保存并运行' : '运行一次');
  const options = () => ({ id, scope, context, ...(messageId ? { messageId } : {}), ...(id === 'reply_check' ? { repairProfileId, targetSnapshot } : {}), config: clone(config), bodyRule: clone(bodyRule), revision: saved.revision, bodyRevision: saved.bodyRevision });
  const matchesRequest = request => JSON.stringify([context, scope, config, bodyRule]) === JSON.stringify([request.context, request.scope, request.config, request.bodyRule]);
  const button = (action, label, attrs = '') => `<button type="button" class="agent-center-card-action" data-ac="${action}" ${attrs}>${e(t(label))}</button>`;
  const label = (title, help = '') => `<span class="ac-label${help ? ' has-help' : ''}"${help ? ` data-help-mode="tap" data-help="${e(t(help, { tag: '<tableEdit>' }))}" tabindex="0"` : ''}>${e(t(title))}</span>`;
  const select = (name, title, choices, value, help = '', boundary = '') => `<label>${boundary ? `<span class="ac-field-heading">${label(title, help)}<span class="ac-field-boundary">${e(t(boundary))}</span></span>` : label(title, help)}<select name="${name}">${choices.map(([v, l]) => `<option value="${e(v)}" ${v === value ? 'selected' : ''}>${e(t(l))}</option>`).join('')}</select></label>`;
  const text = (name, title, value, help = '', textarea = false) => `<label>${label(title, help)}${textarea ? `<textarea name="${name}" rows="4">${e(value)}</textarea>` : `<input name="${name}" value="${e(value)}">`}</label>`;
  const builtinInputs = () => {
    if (!builtin) return '';
    const items = id === 'text_completion' ? [
      ['光标前文本', '2400', '取光标前最近的文字，帮助衔接当前输入。'],
      ['光标后文本', '600', '取光标后的文字，帮助续写与后文衔接。'],
    ] : [
      ['待检查的原文', '', '使用本次选择的原文，并附行号定位格式修改。'],
      ['当前格式规则', '', '按当前场景和已启用功能加入格式范例，并加入下方填写的格式要求。'],
      ['本地解析结果', '', '附上解析结果、会话信息与回复版本，供模型检查并定位修改。'],
    ];
    return `<div class="ac-builtin-inputs">${label('自动包含', '执行时按当前输入或待处理回复自动组装，完整内容可从侧边预览展开查看。')}<div class="ac-builtin-chips">${items.map(([title, count, help]) => `<span class="ac-builtin-chip has-help" tabindex="0" data-help-mode="tap" data-help="${e(t(help))}" data-ac-builtin-input>${e(t(title))}${count ? `<small>${e(t('最多 {count} 字符', { count }))}</small>` : ''}</span>`).join('')}</div></div>`;
  };
  const builtinSettings = () => `<details data-ac-section="builtin-settings"><summary>${e(t('运行设置'))} <span class="ac-source" data-ac-token-summary>${e(config.maxTokens)} Tokens</span></summary><div class="ac-builtin-settings"><div data-ac-generation-editor></div>${builtin ? `<div class="ac-field">${label('返回格式', id === 'text_completion' ? '模型返回可插入光标处的续写文字，侧边预览展示实际任务与返回规则。' : '模型返回最小行补丁，APP 校验原文和版本后展示修改建议。侧边预览展示完整协议。')}<span class="ac-readonly-value">${e(t(id === 'text_completion' ? '续写文本' : '格式修改建议'))}</span></div>` : ''}</div></details>`;
  const selectedModelInfo = () => config.modelMode === 'profile'
    ? { ...saved.profiles.find(p => p.id === config.modelProfileId), ...(config.modelOverride ? { model: config.modelOverride } : {}) }
    : config.modelMode === 'follow_current' ? modelInfo : {};
  const refreshCurrentModel = async () => {
    if (config.modelMode === 'none') return;
    const key = () => JSON.stringify([context, scope, config.modelMode, config.modelProfileId, config.modelOverride]);
    const version = ++modelRequest, currentKey = key();
    const info = await actions.getAgentModelInfo?.(options());
    if (!alive || version !== modelRequest || currentKey !== key()) return;
    if (info) { modelInfo = info; generationEditor?.updateModel(info); }
    if (config.modelMode !== 'follow_current') return;
    const modelName = info?.model ?? await actions.getAgentCurrentModelLabel?.(options());
    if (!alive || version !== modelRequest || currentKey !== key() || typeof modelName !== 'string') return;
    saved.currentModelLabel = modelName;
    const field = node.querySelector('[name="model"]'), option = field?.querySelector('[value="follow_current"]');
    if (option) option.textContent = modelName ? `${t('跟随当前模型')} · ${modelName}` : t('跟随当前模型');
    if (field) refreshCustomSelectButton(field.parentElement.querySelector('button'), field, t('请选择'));
  };
  const targetFields = () => {
    const rule = config.target.mode === 'body' ? bodyRule : config.target;
    const prefix = config.target.mode === 'body' ? 'body' : 'target';
    return `${config.target.mode === 'body' ? select('body.mode', '正文识别', [['tags', '起止标签'], ['regex', '正则捕获组'], ['full', '完整回复']], rule.mode, '正文规则按当前配置范围共享，其他使用“正文”的修改 Agent 同样生效。') : ''}
      ${rule.mode === 'tags' ? `<div class="ac-row">${text(`${prefix}.start`, '开始标签', rule.start)}${text(`${prefix}.end`, '结束标签', rule.end)}</div>` : ''}
      ${rule.mode === 'regex' ? `${text(`${prefix}.pattern`, '正则表达式', rule.pattern, '捕获组需唯一匹配。使用精确边界；匹配缺失或歧义时停止本次处理。')}<div class="ac-row">${text(`${prefix}.group`, '捕获组', rule.group || 1)}${text(`${prefix}.flags`, '标志', rule.flags || '')}</div>` : ''}`;
  };
  const render = () => {
    const assembledContext = node.querySelector('[data-agent-assembled-context]');
    modelRequest++;
    closeCustomSelectMenu();
    skipTargetToggle = false;
    if (hasDraft() && !busy) status = t('尚未保存');
    const opened = [...node.querySelectorAll('details[open]')].map(el => el.dataset.acSection);
    const referenceState = referenceEditor?.snapshot(), toolState = toolsEditor?.snapshot(), runState = runCards?.snapshot();
    referenceEditor?.dispose(); toolsEditor?.dispose(); runCards?.dispose(); generationEditor?.dispose();
    const input = isInputAgent(config), builtinInput = id === 'text_completion', format = id === 'reply_check';
    const localLabel = context.place === 'writing' ? '当前角色卡' : '当前聊天';
    const globalLabel = context.place === 'writing' ? '所有角色卡' : '聊天全局设置';
    const model = config.modelMode === 'profile' ? config.modelProfileId : config.modelMode;
    const currentModel = saved.currentModelLabel ? `${t('跟随当前模型')} · ${saved.currentModelLabel}` : t('跟随当前模型');
    const enableSwitch = `<div class="ac-switch">${label('启用', '暂停或启用此 Agent，保留调用方式与配置。')}<button type="button" class="agent-center-switch${config.enabled ? ' is-on' : ''}" data-ac="toggle-enabled" role="switch" aria-label="${e(t('启用'))}" aria-checked="${config.enabled}"><span class="agent-center-switch-track"><span class="agent-center-switch-thumb"></span></span></button></div>`;
    const repairItems = config.repairProfiles?.items || [];
    const repairLibrary = format ? `<section class="ac-repair-library"><div class="ac-row">${select('repairProfilePicker', '修复方案', [...repairItems.map(item => [item.id, item.name]), ...(!repairItems.some(item => item.id === repairProfileId) ? [[repairProfileId, '新方案']] : [])], repairProfileId)}${button('repair-new', '新建')}</div>${text('repairProfileName', '方案名称', config.repairProfileName || '')}<div class="ac-repair-actions">${button('repair-copy', '另存为')}${repairItems.some(item => item.id === repairProfileId) ? button('repair-delete', '删除方案') : ''}${scope !== 'global' && saved.repairProfileSources?.[repairProfileId] === 'local' && saved.repairGlobalProfileIds?.includes(repairProfileId) ? button('repair-restore', '恢复全局方案') : ''}</div>${config.repairCheckType === 'tableEdit' ? `<span class="ac-source">${e(t('检查所选回复中的 tableEdit，其他内容保持不变。'))}</span>` : ''}</section>` : '';
    node.innerHTML = `<div>${select('scope', '配置范围', [['local', localLabel], ['global', globalLabel]], scope)}<span class="ac-source">${e(t(saved.inherited ? (saved.source === 'legacy' ? '继承旧版设置' : '跟随全局配置') : scope === 'global' ? globalLabel : '当前范围的独立配置'))}</span></div>${repairLibrary}
      ${!builtinInput && !format ? `<div class="ac-identity">${text('title', '名称', config.title)}${enableSwitch}</div>` : enableSwitch}
      ${!builtin ? `<div class="ac-field">${label('快捷图标', '用于 Agent Center 与聊天工具箱。')}<div class="ac-icons" role="group" aria-label="${e(t('快捷图标'))}">${Object.entries(AGENT_ICONS).map(([name, data]) => `<button type="button" data-ac="icon:${name}" aria-label="${e(t(data.label))}" title="${e(t(data.label))}" aria-pressed="${getAgentIconName(config) === name}">${agentIconMarkup(name)}</button>`).join('')}</div></div>` : ''}
      <div class="ac-task"><div class="ac-task-meta">${label('任务要求', builtin ? '这里显示实际使用的任务提示词，可直接修改；恢复默认后再保存即可使用内建任务。' : input ? '描述需要完成的输入辅助任务，以及语气、长度和保留的内容。' : config.outputMode === 'note' ? '描述希望检查、查找或分析的内容，以及结果的呈现方式。' : '描述要改进的内容与保留的事实。模型只提交修改建议。')}<div class="ac-task-tools">${builtin ? `<span class="ac-task-origin" data-ac-task-origin>${e(t(usesDefaultTask() ? '内建默认' : '已自定义'))}</span><button type="button" class="agent-center-icon-button" data-ac="task-default" aria-label="${e(t('恢复默认任务'))}" title="${e(t('恢复默认任务'))}" ${usesDefaultTask() ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/></svg></button>` : `<span class="ac-task-count" data-ac-prompt-count aria-hidden="true">${e(t('{count} 字', { count: Array.from(config.prompt).length }))}</span>`}</div></div><textarea name="prompt" aria-label="${e(t('任务要求'))}" rows="7" data-i18n-skip="true" placeholder="${e(t(input ? '希望这个 Agent 如何帮助你输入？' : format ? '希望如何检查和修复回复格式？' : '希望这个 Agent 怎样处理正文？'))}">${e(taskValue())}</textarea></div>
      ${format ? text('formatGuide', '格式要求', config.formatGuide, '写明必要的标签、字段和结构，例如 {tag} 的使用格式。创意写作启用前需填写。', true) : ''}
      ${builtinInputs()}
      ${input && !builtinInput ? select('inputOutput', '结果形式', [['suggestion','续写建议'],['rewrite','修改草稿'],['note','资料与建议']], config.inputOutput, '续写插入光标处；修改通过差异预览确认；资料与建议在工具箱查看。') : ''}
      ${!input && !format ? select('outputMode', '结果形式', [['edit','修改正文'],['note','资料与建议']], config.outputMode || 'edit', '修改正文通过差异预览确认；资料与建议独立显示，适合点评、检查与查找资料。') : ''}
      ${!input && !format ? `<div class="ac-field">${select('target.mode', '处理内容', [['rendered', '显示的正文'], ['body', '按正文规则'], ['full', '完整回复'], ['tags', '指定部分 · 标签'], ['regex', '指定部分 · 正则']], config.target.mode, '显示的正文提取消息中可阅读的叙事文字，排除思考过程、记忆表格与摘要；展开查看本次实际处理内容。', messageId ? '指定回复' : '最新回复')}${targetFields()}<details class="ac-target-preview" data-ac-section="target"><summary>${e(t(config.target.mode === 'rendered' ? '查看本次正文' : '查看匹配内容'))}</summary><div class="ac-target-meta"><span class="ac-source" data-ac-target-count></span><div class="ac-actions">${button('target-preview', '刷新')}${button('raw-selection', '选取原文')}</div></div><div data-ac-target></div></details></div>` : ''}
      <div class="ac-field">${select('model', '连线配置', [['none', '请选择配置'], ...(!input ? [['follow_current', currentModel]] : []), ...saved.profiles.map(p => [p.id, p.name])], model, input ? '' : '跟随当前模型使用这次聊天选择的连接与模型，也可为此 Agent 单独指定。')}${config.modelMode === 'profile' ? `<label>${label('模型名称', '留空使用所选 API 配置中的模型，可填写同一连接下的其他模型名称。')}<span class="ac-model-row"><input name="modelOverride" data-i18n-skip="true" value="${e(config.modelOverride || saved.profiles.find(p => p.id === config.modelProfileId)?.model || '')}" autocomplete="off"><button type="button" class="agent-center-icon-button" data-ac="pick-model" aria-label="${e(t('选择模型'))}" title="${e(t('选择模型'))}" aria-haspopup="true" aria-expanded="false">${icon('down')}</button></span><small data-ac-model-status role="status"></small></label>` : ''}</div>
      ${builtinSettings()}
      <div class="ac-field">${label('调用方式', '自动按设定时机执行；手动从工具箱调用。')}<div class="ac-modes" role="radiogroup" aria-label="${e(t('调用方式'))}">${[['auto','自动'],['manual','手动'],['both','自动＋手动']].map(([value,title]) => `<label><input type="radio" name="invocationMode" value="${value}" ${getAgentInvocationMode(config) === value ? 'checked' : ''}>${e(t(title))}</label>`).join('')}</div>${getAgentInvocationMode(config) !== 'manual' ? `<div class="ac-trigger">${label('自动时机', input ? '输入停顿后处理当前草稿；继续输入时更新任务。' : '按照回复流程的编排顺序，处理已完成的回复。')}<span>${e(t(input ? '输入停顿' : '回复完成后'))}</span></div>` : ''}</div>
      ${format && getAgentInvocationMode(config) !== 'manual' ? select('repairAutomatic', '自动执行方案', [['', '暂停自动执行'], ...repairItems.filter(item => item.config.repairCheckType !== 'tableEdit').map(item => [item.id, item.name])], config.repairProfiles.automaticId || '', '自动检查使用这里绑定的回复格式方案；表格指令方案从工具箱选取后执行。') : ''}
      <div data-ac-reference-editor></div>
      ${!builtinInput && !format ? '<div data-ac-tool-editor></div>' : ''}
      <details data-ac-section="blocks"><summary>${e(t('自定义提示词区块'))}${config.blocks.length ? ` <span class="ac-source">${config.blocks.length}</span>` : ''}</summary>${config.blocks.map((b, i) => `<div class="ac-block"><div class="ac-block-heading"><input name="blocks.${i}.name" aria-label="${e(t('区块名称'))}" value="${e(b.name)}"><label class="ac-block-enabled" title="${e(t('启用'))}"><input name="blocks.${i}.enabled" type="checkbox" aria-label="${e(t('启用'))}" ${b.enabled ? 'checked' : ''}></label></div>${select(`blocks.${i}.role`, '角色', [['system', 'System'], ['user', 'User']], b.role)}<textarea name="blocks.${i}.text" aria-label="${e(t('区块内容'))}">${e(b.text)}</textarea><div class="ac-block-actions">${['up', 'down', 'copy', 'remove'].map(action => `<button class="agent-center-icon-button" type="button" data-ac="block-${action}" data-index="${i}" title="${e(t(({up:'上移',down:'下移',copy:'复制',remove:'移除'})[action]))}" aria-label="${e(t(({up:'上移',down:'下移',copy:'复制',remove:'移除'})[action]))}">${icon(action)}</button>`).join('')}</div></div>`).join('')}${button('block-add', '添加区块')}</details>
      <details class="ac-more" data-ac-section="more"><summary>${e(t('更多操作'))}</summary><div class="ac-actions">${scope === 'local' ? button('reset', '跟随全局配置') : button('reset', '恢复默认')}${button('copy', '复制到另一模式')}${!builtinInput && !format ? button('delete', '删除 Agent') : ''}</div></details>
      <div data-ac-runs></div><div class="ac-footer"><div class="ac-status" role="status">${e(status)}</div><div class="ac-actions"><span class="ac-quick-result" data-ac-quick-result></span>${(!input && !format ? config.enabled : allowsAgentInvocation(config, 'manual')) ? button('run', runLabel()) : ''}${button('save', '保存')}</div></div>`;
    if (assembledContext) node.querySelector('.ac-footer').before(assembledContext);
    // Draft sentinel integrates with AC's existing close/discard guard.
    const marker = doc.createElement('input'); marker.type = 'hidden'; marker.name = 'agent-config-draft'; marker.defaultValue = initial; marker.value = stamp(); node.append(marker);
    node.querySelectorAll('select').forEach(el => {
      const wrap = createCustomSelectWrapper(el); el.replaceWith(wrap); el.hidden = true; wrap.prepend(el);
      const control = wrap.querySelector('button');
      bindCustomSelectButton({ buttonEl: control, selectEl: el, fallback: t('请选择') });
      // Keep the app's select presentation, with native-style keyboard changes.
      control.addEventListener('keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? el.options.length - 1 : Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + (event.key === 'ArrowDown' ? 1 : -1)));
        if (next !== el.selectedIndex) { el.selectedIndex = next; el.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })); }
      });
    });
    node.querySelectorAll('details').forEach(el => { el.open = opened.includes(el.dataset.acSection); });
    generationEditor = createAgentGenerationEditor({ host: node.querySelector('[data-ac-generation-editor]'), getConfig: () => config,
      model: selectedModelInfo(), onChange: patch => { Object.assign(config, patch); updateMarker(); } });
    referenceEditor = createAgentReferenceEditor({ host: node.querySelector('[data-ac-reference-editor]'), value: config.context, builtinId: id, actions, getOptions: options, state: referenceState, onStatus: setStatus,
      onChange: value => { config.context = value; updateMarker(); } });
    const toolHost = node.querySelector('[data-ac-tool-editor]');
    toolsEditor = toolHost ? createAgentToolCapabilitiesEditor({ host: toolHost, value: config.tools, actions, getOptions: options, state: toolState, onStatus: setStatus,
      onChange: value => { config.tools = value; updateMarker(); } }) : null;
    runCards = createAgentRunCards({ host: node.querySelector('[data-ac-runs]'), button, onStatus: setStatus, state: runState });
    renderRuns();
    void refreshCurrentModel().catch(() => {});
    preview?.invalidate();
  };
  const setStatus = message => { status = message; const el = node.querySelector('.ac-status'); if (el) el.textContent = message; };
  const focusField = name => { const field = node.querySelector(`[name="${name}"]`); (field?.tagName === 'SELECT' ? field.parentElement.querySelector('button') : field)?.focus({ preventScroll: true }); };
  const updateMarker = () => {
    const marker = node.querySelector('[name="agent-config-draft"]'); if (marker) { marker.defaultValue = initial; marker.value = stamp(); }
    const count = node.querySelector('[data-ac-prompt-count]'); if (count) count.textContent = t('{count} 字', { count: Array.from(config.prompt).length });
    const origin = node.querySelector('[data-ac-task-origin]'); if (origin) origin.textContent = t(usesDefaultTask() ? '内建默认' : '已自定义');
    const resetTask = node.querySelector('[data-ac="task-default"]'); if (resetTask) resetTask.disabled = usesDefaultTask() && node.querySelector('[name="prompt"]').value.trim() === defaultTask().trim();
    const tokens = node.querySelector('[data-ac-token-summary]'); if (tokens) tokens.textContent = `${config.maxTokens} Tokens`;
    const run = node.querySelector('[data-ac="run"]'); if (run) run.textContent = t(runLabel());
    if (hasDraft() && !busy) setStatus(t('尚未保存'));
    node.dispatchEvent(new doc.defaultView.Event('agent-prompt-draft-changed', { bubbles: true }));
  };
  const renderRuns = () => {
    const host = node.querySelector('[data-ac-runs]'); if (!host) return;
    const input = isInputAgent(config);
    const jobs = input ? actions.listInputAgentRuns?.() || [] : id === 'reply_check' ? actions.listFormatRepairRuns?.() || [] : actions.listTextEditRuns();
    const relevant = jobs.filter(j => j.agentId === id && (j.sessionId || j.context.sessionId) === context.sessionId && j.context.scopeId === context.scopeId).slice(-5).reverse();
    runCards?.update(relevant, { isInput: input });
    const quick = node.querySelector('[data-ac-quick-result]'), latest = relevant.find(j => j.status === 'running' || j.status === 'ready');
    if (quick) quick.innerHTML = latest?.status === 'running' ? button(`${input ? 'input-cancel' : 'cancel'}:${latest.id}`, '取消') : latest?.status === 'ready' && (input ? latest.kind !== 'note' : latest.outputMode !== 'note') ? button(`${input ? 'input-apply' : 'review'}:${latest.id}`, input && latest.kind === 'suggestion' ? '采纳' : '查看修改') : '';
    setBusy(busy);
  };
  const reload = () => {
    saved = actions.getAgentConfiguration({ id, scope, context, ...(repairProfileId ? { repairProfileId } : {}) });
    config = saved.config ? clone(saved.config) : { ...config, enabled: false };
    if (id === 'reply_check' && !config.repairProfileId) config = createFormatRepairProfileDraft(config);
    repairProfileId = config.repairProfileId || ''; bodyRule = clone(saved.bodyRule); initial = stamp(); selection = null; render();
  };
  const showTarget = async () => {
    const version = ++sourceRequest, request = options();
    const pendingHost = node.querySelector('[data-ac-target]'); if (pendingHost) { pendingHost.setAttribute('aria-busy', 'true'); pendingHost.innerHTML = `<div class="ac-target-empty">${e(t('正在提取正文…'))}</div>`; }
    let result;
    try { result = await actions.getAgentTargetPreview(request); }
    catch (error) {
      if (alive && version === sourceRequest && matchesRequest(request)) {
        pendingHost?.removeAttribute('aria-busy');
        if (pendingHost) pendingHost.innerHTML = `<p class="ac-error" role="status">${e(t(error.message || '操作失败'))}</p>`;
      }
      return;
    }
    if (!alive || version !== sourceRequest || !matchesRequest(request)) return;
    targetView = result; const host = node.querySelector('[data-ac-target]'); if (!host) return;
    host.removeAttribute('aria-busy');
    const target = result.target, rendered = target.mode === 'rendered' || config.target.mode === 'rendered';
    const count = node.querySelector('[data-ac-target-count]'); if (count) count.textContent = target.ok ? t('{count} 字', { count: Array.from(target.text).length }) : '';
    host.innerHTML = `${target.ok ? `<div class="ac-target-source" tabindex="0" data-i18n-skip="true">${rendered ? e(target.text) : `<mark>${e(target.text)}</mark>`}</div>` : `<p class="ac-error" role="status">${e(t(target.message))}</p>`}
      ${!rendered && result.suggestions?.length ? `<div class="ac-actions">${result.suggestions.map((s, index) => button(`suggest:${index}`, s.label, `title="${e(t(s.source))}"`)).join('')}</div>` : ''}`;
  };
  const setBusy = value => { busy = value; node.querySelectorAll('.ac-footer button').forEach(control => { control.disabled = value && !/^(input-cancel|cancel):/.test(control.dataset.ac); }); };
  const save = async () => {
    if (id === 'reply_check' && !config.repairProfileName?.trim()) { setStatus(t('请填写方案名称')); focusField('repairProfileName'); return false; }
    if (busy) return false; setBusy(true); setStatus(t('正在保存…'));
    try {
      const request = options(), draftAtSave = stamp();
      if (JSON.stringify(bodyRule) === JSON.stringify(saved.bodyRule)) { delete request.bodyRule; delete request.bodyRevision; }
      if (isInputAgent(config) && config.enabled) request.config.inputConsent = true;
      const result = await actions.saveAgentConfiguration(request);
      if (!alive) return false;
      if (!result.ok) { setStatus(t(result.message || ({config_changed:'配置已变化，请重新打开', save_failed:'保存失败', prompt_too_long:'提示词过长', context_changed:'当前角色已变化，请重新打开'})[result.reason] || '保存失败')); return false; }
      if (stamp() !== draftAtSave) {
        saved = actions.getAgentConfiguration({ id, scope, context, repairProfileId });
        initial = JSON.stringify([saved.config, saved.bodyRule]);
        updateMarker(); setStatus(t('尚未保存'));
        return false;
      }
      status = t('已保存'); reload(); return true;
    } finally { setBusy(false); }
  };
  const savePromptField = async ({field,value,baseValue}) => {
    if(busy || !alive)return {ok:false,message:t('正在保存上一处修改，请稍候')};
    if(id==='reply_check' && !saved.config.repairProfiles.items.some(item=>item.id===repairProfileId)) return {ok:false,message:t('请先保存新方案，再单独应用提示词修改')};
    if(normalizePresetBlockText(readConfiguredPromptField(saved.config,field.id,config))!==baseValue)return {ok:false,message:t('配置已变化，请重新打开')};
    setBusy(true);
    try {
      const accepted=patchConfiguredPromptField(saved.config,config,field.id,value);
      const request={id,scope,context,revision:saved.revision,config:accepted,...(id==='reply_check'?{repairProfileId}: {})};
      if (id==='reply_check') request.config.repairProfileName = config.repairProfileName;
      const result=await actions.saveAgentConfiguration(request);
      if(!result.ok)return {...result,message:result.message || t('配置已变化，请重新打开')};
      if(alive && scope===request.scope && JSON.stringify(context)===JSON.stringify(request.context)) {
        saved=actions.getAgentConfiguration({id,scope,context,repairProfileId});
        initial=JSON.stringify([saved.config,saved.bodyRule]);
        updateMarker();
        setStatus(t(hasDraft()?'尚未保存':'已保存'));
      }
      return {ok:true,value};
    } finally {if(alive)setBusy(false);}
  };
  node.addEventListener('toggle', event => {
    if (!event.target.matches?.('[data-ac-section="target"]') || !event.target.open) return;
    if (skipTargetToggle) { skipTargetToggle = false; return; }
    void showTarget().catch(error => { if (alive) setStatus(t(error.message || '操作失败')); });
  }, true);
  node.addEventListener('input', event => {
    const field = event.target, name = field.name;
    if (!name || ['scope','model','invocationMode','inputOutput','outputMode','agent-config-draft','raw-selection','repairProfilePicker','repairAutomatic'].includes(name)) return;
    const parts = name.split('.'); let obj = parts[0] === 'body' ? bodyRule : config;
    if (parts[0] === 'body') parts.shift();
    while (parts.length > 1) obj = obj[parts.shift()];
    const key = parts[0]; obj[key] = field.type === 'checkbox' ? field.checked : ['count','maxChars','group','maxTokens'].includes(key) ? Number(field.value) : field.value;
    if (name === 'prompt' && builtin) config.taskPromptMode = 'replace';
    if (name === 'modelOverride') generationEditor?.updateModel(selectedModelInfo());
    selection = null; updateMarker();
  });
  node.addEventListener('change', async event => {
    const field = event.target;
    if (field.name === 'repairProfilePicker') {
      const next = field.value; field.value = repairProfileId;
      if (!await leaveRepairDraft()) { focusField('repairProfilePicker'); return; }
      repairProfileId = next; status = ''; reload(); focusField('repairProfilePicker');
    } else if (field.name === 'repairAutomatic') {
      config.repairProfiles.automaticId = field.value; updateMarker();
    } else if (field.name === 'scope') {
      if (hasDraft() && !await appConfirm({ title: t('未保存的修改'), message: t('切换配置范围将丢弃当前草稿。'), confirmText: t('切换') })) { field.value = scope; render(); focusField('scope'); return; }
      scope = field.value; repairProfileId = ''; reload(); focusField('scope');
    } else if (field.name === 'model') {
      config.modelMode = ['none', 'follow_current'].includes(field.value) ? field.value : 'profile';
      config.modelProfileId = config.modelMode === 'profile' ? field.value : ''; config.modelOverride = ''; modelInfo = {}; render(); focusField('model');
    } else if (['target.mode','body.mode','context.mode'].includes(field.name)) {
      const [part, key] = field.name.split('.'); (part === 'body' ? bodyRule : config[part])[key] = field.value; selection = null; render(); focusField(field.name);
    } else if (field.name?.startsWith('blocks.') && field.name.endsWith('.role')) { config.blocks[Number(field.name.split('.')[1])].role = field.value; updateMarker(); }
    else if (field.name === 'invocationMode') { config.invocationMode = field.value; config.triggerMode = field.value === 'manual' ? 'manual' : 'auto'; render(); const next = node.querySelector(`input[name="invocationMode"][value="${field.value}"]`); next?.focus({preventScroll:true}); motion?.pulse(next?.closest('label')); }
    else if (field.name === 'inputOutput') { config.inputOutput = field.value; updateMarker(); }
    else if (field.name === 'outputMode') { config.outputMode = field.value; render(); focusField('outputMode'); motion?.pulse(node.querySelector('[name="outputMode"]')?.closest('label')); }
  });
  const leaveRepairDraft = async () => {
    if (!hasDraft()) return true;
    const decision = await appChoice({ title: t('修改尚未保存'), message: t('可以保存后继续，或放弃本次编辑。'),
      actions: [{ id: 'cancel', label: t('继续编辑') }, { id: 'discard', label: t('放弃修改') }, { id: 'save', label: t('保存并继续'), primary: true }] });
    return decision === 'discard' || decision === 'save' && await save();
  };
  node.addEventListener('click', async event => {
    const control = event.target.closest('[data-ac]'); if (!control) return;
    const action = control.dataset.ac;
    if (busy && !/^(input-cancel|cancel|input-ignore|ignore):/.test(action)) return;
    try {
      if (action === 'pick-model') {
        if (control.getAttribute('aria-expanded') === 'true') { modelRequest++; closeCustomSelectMenu(); control.setAttribute('aria-expanded', 'false'); control.removeAttribute('aria-busy'); node.querySelector('[data-ac-model-status]').textContent = ''; return; }
        const version = ++modelRequest, profileId = config.modelProfileId;
        const field = node.querySelector('[name="modelOverride"]'), message = node.querySelector('[data-ac-model-status]');
        control.setAttribute('aria-expanded', 'true'); control.setAttribute('aria-busy', 'true');
        message.textContent = t('加载模型列表…');
        let models;
        try { models = await actions.listProfileModels?.(profileId) || []; }
        catch { models = []; }
        if (!alive || version !== modelRequest || profileId !== config.modelProfileId || !control.isConnected) return;
        control.removeAttribute('aria-busy');
        message.textContent = models.length ? '' : t('该渠道未返回模型列表，可手动输入');
        if (!models.length) { control.setAttribute('aria-expanded', 'false'); return; }
        let menu;
        const navigate = event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCustomSelectMenu(); control.focus({ preventScroll: true }); return; }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const items = [...menu.querySelectorAll('button')], index = items.indexOf(doc.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
          items[next]?.focus();
        };
        menu = openCustomSelectMenu({ anchorEl: control.closest('.ac-model-row'), currentValue: field.value,
          options: rankModelCandidates(models, field.value).map(value => ({ value, label: value })),
          onSelect: value => { field.value = value; field.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true })); field.focus({ preventScroll: true }); },
          onClose: () => { menu?.removeEventListener('keydown', navigate); control.setAttribute('aria-expanded', 'false'); },
        });
        menu?.addEventListener('keydown', navigate);
        menu?.querySelector('.is-selected, button')?.focus({ preventScroll: true });
      }
      else if (action === 'save') await save();
      else if (action === 'repair-new') {
        if (!await leaveRepairDraft()) return;
        const template = await appChoice({ title: t('新建修复方案'), actions: [{ id: 'blank', label: t('空白方案') }, { id: 'tableEdit', label: t('表格指令') }, { id: 'structure', label: t('回复结构') }] });
        if (!template || !alive) return;
        config = createFormatRepairProfileDraft(saved.config, template); repairProfileId = config.repairProfileId; render(); focusField('repairProfileName');
      } else if (action === 'repair-copy') {
        config = { ...config, repairProfileId: createFormatRepairProfileId(), repairProfileName: `${config.repairProfileName || t('方案')} ${t('副本')}` };
        repairProfileId = config.repairProfileId; render(); focusField('repairProfileName');
      } else if (action === 'repair-delete' || action === 'repair-restore') {
        const restore = action === 'repair-restore';
        if (!await appConfirm({ title: t(restore ? '恢复全局方案' : '删除方案'), message: t(restore ? '恢复此方案的全局配置，其他方案保持不变。' : '删除后，绑定此方案的自动执行将暂停。已有结果仍可查看。'), confirmText: t(restore ? '恢复' : '删除'), danger: !restore })) return;
        const result = await actions.changeFormatRepairProfile({ ...options(), action: restore ? 'restore' : 'delete' });
        if (result.ok) { if (!restore) repairProfileId = ''; reload(); } else setStatus(t(result.message || '配置已变化，请重新打开'));
      }
      else if (action.startsWith('icon:')) { config.icon = action.slice(5); node.querySelectorAll('.ac-icons button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.ac === action))); updateMarker(); }
      else if (action === 'task-default' && builtin) { config.prompt = ''; config.taskPromptMode = 'append'; status = hasDraft() ? t('尚未保存') : ''; render(); focusField('prompt'); }
      else if (action === 'toggle-enabled') { config.enabled = !config.enabled; render(); node.querySelector('[data-ac="toggle-enabled"]')?.focus({preventScroll:true}); }
      else if (action === 'target-preview') { selection = null; const details = node.querySelector('[data-ac-section="target"]'); if (details.open) await showTarget(); else details.open = true; }
      else if (action.startsWith('suggest:')) { const rule = targetView?.suggestions[Number(action.split(':')[1])]?.rule; if (rule) { if (config.target.mode === 'body') bodyRule = { ...bodyRule, ...rule }; else config.target = { ...config.target, ...rule }; render(); await showTarget(); } }
      else if (action === 'raw-selection') {
        const version = ++sourceRequest, request = options();
        const result = await actions.getAgentTargetPreview(request);
        if (!alive || version !== sourceRequest || !matchesRequest(request)) return;
        targetView = result;
        const details = node.querySelector('[data-ac-section="target"]'); if (!details.open) { skipTargetToggle = true; details.open = true; }
        const host = node.querySelector('[data-ac-target]');
        const count = node.querySelector('[data-ac-target-count]'); if (count) count.textContent = '';
        host.innerHTML = `<label>${label('本次选取', '在原文中选中文字后点击“使用选取”；该选择仅用于本次手动运行。')}<textarea name="raw-selection" class="ac-raw-select" readonly>${e(result.raw)}</textarea></label>${button('use-selection', '使用选取')}`;
        host.querySelector('textarea').value = result.raw;
        host.querySelector('textarea').focus({ preventScroll: true });
      } else if (action === 'use-selection') {
        const area = node.querySelector('[name="raw-selection"]');
        selection = mapAgentRawSelection(targetView.raw, area.selectionStart, area.selectionEnd);
        setStatus(selection.text ? t('已选取 {count} 字符', { count: selection.text.length }) : t('请先选中文字'));
        if (selection.text) {
          const host = node.querySelector('[data-ac-target]');
          const count = node.querySelector('[data-ac-target-count]'); if (count) count.textContent = t('已选取 {count} 字符', { count: selection.text.length });
          host.innerHTML = `<div class="ac-target-source" data-i18n-skip="true">${e(selection.text)}</div><div class="ac-actions">${button('clear-selection', '取消选取')}</div>`;
        }
      } else if (action === 'clear-selection') {
        selection = null; setStatus(''); await showTarget();
      } else if (action === 'block-add' && config.blocks.length < 12) { config.blocks.push({ id: `block-${Date.now()}`, name: '', text: '', enabled: true, role: 'system' }); render(); }
      else if (action.startsWith('block-')) {
        const i = Number(control.dataset.index), block = config.blocks[i]; if (!block) return;
        if (action === 'block-remove') { if (block.text && !await appConfirm({ title: t('移除区块'), message: t('确认移除这个提示词区块？'), danger: true })) return; config.blocks.splice(i, 1); }
        if (action === 'block-copy' && config.blocks.length < 12) config.blocks.splice(i + 1, 0, { ...block, id: `block-${Date.now()}` });
        const next = action === 'block-up' ? i - 1 : action === 'block-down' ? i + 1 : -1;
        if (next >= 0 && next < config.blocks.length) [config.blocks[i], config.blocks[next]] = [config.blocks[next], config.blocks[i]];
        render();
      } else if (action === 'reset') {
        if (!await appConfirm({ title: t('恢复配置'), message: t('移除当前范围的独立配置，恢复继承。'), confirmText: t('恢复') })) return;
        const result = await actions.resetAgentConfiguration(options()); if (result.ok) reload(); else setStatus(t(result.message || '保存失败'));
      } else if (action === 'delete') {
        if (!await appConfirm({ title: t('删除 Agent'), message: t('当前范围内引用此 Agent 的房子将显示为停用。'), danger: true })) return;
        const result = await actions.removeAgentConfiguration(options()); if (result.ok) { initial = stamp(); onDeleted(); } else setStatus(t('保存失败'));
      } else if (action === 'copy') {
        const targetContext = { ...context, place: context.place === 'writing' ? 'chat' : 'writing', sessionId: '' };
        if (!await appConfirm({ title: t('复制配置'), message: t(targetContext.place === 'writing' ? '复制到所有角色卡的配置，初始设为停用。' : '复制到聊天全局设置，初始设为停用。'), confirmText: t('复制') })) return;
        const result = await actions.copyAgentConfiguration({ ...options(), targetContext, targetScope: 'global' }); setStatus(t(result.ok ? '已复制' : '复制失败'));
      } else if (action === 'run') {
        const selected = selection, mid = targetView?.messageId;
        if (hasDraft() && !await save()) return;
        setBusy(true); setStatus(t('处理中'));
        try {
          if (id === 'reply_check' && targetSnapshot) {
            const selection = targetSnapshot.formatSelection;
            const refreshed = await actions.prepareAgentToolTarget({ ...options(), messageId: targetSnapshot.messageId,
              rawRange: selection?.fragment ? { start: selection.start, end: selection.end } : null,
              rawSource: targetSnapshot.formatTarget?.sourceText });
            if (!refreshed.ok) { setStatus(t(refreshed.message || '请重新选择回复')); return; }
            targetSnapshot = refreshed.snapshot;
          }
          const result = await (isInputAgent(config) ? actions.runConfiguredInputAgent(options()) : id === 'reply_check' ? actions.runConfiguredFormatReview(options()) : actions.testTextEditAgent({ ...options(), ...(selected?.text ? { selection: selected, messageId: mid } : {}) }));
          if (!alive) return;
          setStatus(t(result.status === 'succeeded' ? '处理完成' : result.reason || '处理失败')); renderRuns();
        } finally { setBusy(false); }
      } else if (action.startsWith('input-apply:')) await actions.applyInputAgentRun(action.slice(12));
      else if (action.startsWith('input-ignore:')) actions.ignoreInputAgentRun(action.slice(13));
      else if (action.startsWith('input-cancel:')) actions.cancelInputAgentRun(action.slice(13));
      else if (action.startsWith('review:')) await (id === 'reply_check' ? actions.openFormatRepairRun : actions.openTextEditRun)(action.slice(7));
      else if (action.startsWith('ignore:')) (id === 'reply_check' ? actions.ignoreFormatRepairRun : actions.ignoreTextEditRun)(action.slice(7));
      else if (action.startsWith('cancel:')) (id === 'reply_check' ? actions.cancelFormatRepairRun : actions.cancelTextEditRun)(action.slice(7));
    } catch (error) { setStatus(t(error.message || '操作失败')); }
  });
  doc.defaultView.addEventListener('agent-text-edit-changed', renderRuns);
  doc.defaultView.addEventListener('agent-input-changed', renderRuns);
  doc.defaultView.addEventListener('agent-format-repair-changed', renderRuns);
  render();
  motion = bindAgentEditorMotion(node);
  return { node, hasDraft,
    attach: host => {
      const previewState = preview?.snapshot(); preview?.dispose(); host.replaceWith(node);
      preview = mountAgentRequestPreview({ host: node.closest('.agent-center-floating-layer'), buildRequest: () => actions.buildAgentConfigurationPreview({ ...options(), ...(selection ? { selection, messageId: targetView?.messageId } : {}) }), savedState: previewState,
        getFields:root=>getAgentPromptFields(root).map(field=>({...field,baseValue:readConfiguredPromptField(saved.config,field.id,config)})),saveField:savePromptField });
    },
    closePreview: () => preview?.close() || false,
    dispose: () => { alive = false; sourceRequest++; modelRequest++; closeCustomSelectMenu(); preview?.dispose(); referenceEditor?.dispose(); toolsEditor?.dispose(); runCards?.dispose(); generationEditor?.dispose(); motion?.dispose(); doc.defaultView.removeEventListener('agent-text-edit-changed', renderRuns); doc.defaultView.removeEventListener('agent-input-changed', renderRuns); doc.defaultView.removeEventListener('agent-format-repair-changed', renderRuns); node.remove(); },
  };
};
