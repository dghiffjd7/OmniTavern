import { getRealtimeSettingsTarget, startRealtimeSettingsCall } from './realtime-settings-target.js';
import { getRealtimeProfileStore } from '../../storage/realtime-profile-store.js';
import { REALTIME_PROVIDERS, makeRealtimeProfile, isDoubaoSc2, GEMINI_VERTEX_MODELS, GEMINI_VERTEX_REGIONS, isGeminiVertex, usesGeminiServiceAccount } from './realtime-provider-catalog.js';
import { RealtimeVoiceEnrollment } from './realtime-voice-enrollment.js';
import { RealtimeEnrollmentView, realtimeEnrollmentFields } from './realtime-enrollment-view.js';
import { RealtimeModelDiscovery, realtimeModelSource } from './realtime-model-discovery.js';
import { getRealtimeSystemVoices } from './realtime-voice-catalog.js';
import { RealtimeVoicePicker, realtimeVoicePickerFields } from './realtime-voice-picker.js';
import { RealtimeVoiceDiscovery } from './realtime-voice-discovery.js';
import { rankModelCandidates } from '../../utils/model-candidates.js';
import { appConfirm } from '../app-confirm.js';
import { t, translateUiText } from '../../i18n/index.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const tr = value => escape(translateUiText(value));
const helpTitle = (label, messages = []) => `<span${messages.length ? ` class="has-help" data-help="${messages.map(tr).join('&#10;')}" data-help-mode="tap"` : ''}>${tr(label)}</span>`;
const option = (id, label = id) => `<option value="${escape(id)}">${escape(label)}</option>`;
const button = (id, label) => `<button type="button" id="${id}" class="api-config-text-action">${tr(label)}</button>`;
export class RealtimeSettingsPanel {
  constructor({ card, store = getRealtimeProfileStore(), enrollment = new RealtimeVoiceEnrollment(), modelDiscovery = new RealtimeModelDiscovery(), voiceDiscovery = new RealtimeVoiceDiscovery() }) {
    this.card = card; this.store = store; this.enrollment = enrollment; this.draft = null; this.dirty = false; this.busy = false; this.secretDraft = {};
    this.modelDiscovery = modelDiscovery; this.modelOptions = []; this.modelSource = '';
    this.voiceDiscovery = voiceDiscovery;
    this.enrollmentView = new RealtimeEnrollmentView({ isBusy: () => this.busy });
    this.root = document.createElement('div'); this.root.className = 'api-config-realtime-profiles';
    card.querySelector('.api-config-realtime-heading').after(this.root);
    this.legacyElements = [...card.children].filter(element => element !== this.root && !element.classList.contains('api-config-realtime-heading'));
    this.ready = this.init();
  }
  async init() { await this.store.ready; this.selectedId = this.store.activeId; this.draft = this.store.get(this.selectedId); this.render(); }
  status(message, error = false) {
    const node = this.root.querySelector(`#${this.feedbackId || 'rt-status'}`);
    if (!node) return;
    node.textContent = translateUiText(message); node.dataset.type = error ? 'error' : '';
    if (this.feedbackId && this.feedbackId !== 'rt-status') {
      const details = node.closest('details'); if (details) details.open = true;
      node.scrollIntoView({ block: 'nearest' });
    }
  }
  async run(action, cancelMessage = '操作已取消；已提交的云端训练可通过 Voice ID 查询', { feedbackId = 'rt-status', busyButtonId = '', busyLabel = '' } = {}) {
    if (this.busy) return; this.busy = true; this.controller = new AbortController();
    this.feedbackId = feedbackId;
    const busyButton = this.root.querySelector(`#${busyButtonId || 'rt-unused'}`), originalLabel = busyButton?.textContent;
    if (busyButton && busyLabel) busyButton.textContent = translateUiText(busyLabel);
    this.root.querySelectorAll('button, input, select, textarea').forEach(node => { node.disabled = true; });
    try { await action(this.controller.signal); }
    catch (error) { this.status(error.name === 'AbortError' ? cancelMessage : error.message, true); }
    finally {
      if (busyButton?.isConnected) busyButton.textContent = originalLabel;
      this.busy = false; this.controller = null; this.feedbackId = '';
      this.root.querySelectorAll('button, input, select, textarea').forEach(node => { node.disabled = false; }); if (this.draft?.id) this.root.querySelector('#rt-provider').disabled = true;
    }
  }
  refresh() {
    if (this.busy) return;
    this.capture();
    if (!this.dirty && this.draft?.id) this.draft = this.store.get(this.draft.id);
    this.render();
  }
  hide() { this.controller?.abort(); this.voicePicker?.hideTooltip(); this.enrollmentView.detach(); this.capture(); }
  capture() {
    if (!this.draft) return;
    this.root.querySelectorAll('[data-secret]').forEach(node => { this.secretDraft[node.dataset.secret] = node.value; });
    for (const [field, id] of Object.entries({ name: 'rt-name', model: 'rt-model', region: 'rt-region', workspaceId: 'rt-workspace', idleTimeoutMinutes: 'rt-idle', voiceKind: 'rt-voice-kind', voice: 'rt-voice', geminiBackend: 'rt-gemini-backend', vertexaiAuthMode: 'rt-vertex-auth-mode', vertexaiProjectId: 'rt-vertex-project' })) {
      const element = this.root.querySelector(`#${id}`); if (element) this.draft[field] = element.value;
    }
  }
  async leaveDraft() { this.capture(); return !this.dirty || await appConfirm({ title: '未保存的实时语音设置', message: '切换设置档会放弃未保存的修改。', confirmText: '放弃修改', cancelText: '继续编辑' }); }
  render() {
    const enrollmentOpen = this.root.querySelector('.api-config-realtime-enrollment')?.open;
    this.enrollmentView.detach();
    this.voicePicker?.destroy();
    const profile = this.draft, preset = profile && REALTIME_PROVIDERS[profile.provider];
    if (!profile || this.modelSource !== realtimeModelSource(profile)) { this.modelOptions = []; this.modelSource = ''; }
    this.legacyElements.forEach(element => { element.hidden = Boolean(profile); });
    this.root.innerHTML = `<div class="api-config-realtime-grid">
      <label class="api-config-realtime-field is-wide">${helpTitle('实时语音设置档', ['保存多份实时语音配置；保存并使用后应用于下次通话。'])}<select id="rt-profile">${option('', translateUiText('沿用原 OpenAI 配置'))}${this.store.list().map(item => option(item.id, `${item.name} · ${REALTIME_PROVIDERS[item.provider].label}${item.id === this.store.activeId ? ' ✓' : ''}`)).join('')}${profile && !profile.id ? option('__new', translateUiText('新设置档（未保存）')) : ''}</select></label>
      <div class="api-config-realtime-actions">${button('rt-new', '新建设置档')}${profile?.id ? button('rt-copy', '复制设置档') + button('rt-delete', '删除设置档') : ''}${!profile ? button('rt-use-legacy', '使用原 OpenAI 配置') : ''}</div>
    </div>${profile ? this.fields(profile, preset) : ''}
    ${this.targetFields()}
    <small id="rt-status" class="api-config-realtime-status" role="status" aria-live="polite"></small>`;
    const enrollment = this.root.querySelector('.api-config-realtime-enrollment'); if (enrollment && enrollmentOpen) enrollment.open = true;
    this.enrollmentView.attach(this.root, profile);
    const select = this.root.querySelector('#rt-profile'); select.value = profile && !profile.id ? '__new' : this.selectedId || '';
    select.onchange = async () => {
      const id = select.value; if (id === '__new') return;
      if (!await this.leaveDraft()) { select.value = profile && !profile.id ? '__new' : this.selectedId || ''; return; }
      this.secretDraft = {}; this.selectedId = id; this.draft = this.store.get(id); this.dirty = false; this.render();
    };
    this.root.querySelector('#rt-new').onclick = async () => { if (await this.leaveDraft()) { this.secretDraft = {}; this.selectedId = ''; this.draft = makeRealtimeProfile(); this.dirty = false; this.render(); } };
    this.root.querySelector('#rt-use-legacy')?.addEventListener('click', () => this.run(async () => { await this.store.activate(''); this.status('已切换到原 OpenAI 配置'); }));
    this.root.querySelector('#rt-copy')?.addEventListener('click', () => this.run(async () => {
      if (!await this.leaveDraft()) return;
      this.draft = await this.store.duplicate(profile.id); this.selectedId = this.draft.id; this.secretDraft = {}; this.dirty = false; this.render();
    }));
    this.root.querySelector('#rt-delete')?.addEventListener('click', () => this.run(async () => {
      if (!await appConfirm({ title: '删除实时语音设置档', message: '删除本机设置档及其凭证、声音登记；云端声音仍保留。', confirmText: '删除', cancelText: '取消' })) return;
      await this.store.remove(profile.id); this.selectedId = this.store.activeId; this.draft = this.store.get(this.selectedId); this.dirty = false; this.render();
    }));
    this.root.querySelector('#rt-unbind')?.addEventListener('click', () => this.run(async () => {
      await this.store.bindTarget(getRealtimeSettingsTarget()); this.render(); this.status('当前角色已改为跟随全局实时配置');
    }));
    this.root.querySelector('#rt-bind')?.addEventListener('click', () => this.run(async () => {
      this.requireSaved(); await this.store.bindTarget(getRealtimeSettingsTarget(), this.draft.id); this.render(); this.status('已为当前角色绑定实时声音');
    }));
    this.root.querySelector('#rt-try-call')?.addEventListener('click', () => {
      if (this.dirty || (this.draft && !this.draft.id)) { this.status('请先保存设置，再开始试用通话', true); return; }
      const binding = this.store.getBinding(getRealtimeSettingsTarget());
      if (this.draft && (this.draft.id !== (binding?.profileId || this.store.activeId) || (binding && binding.voice !== this.draft.voice))) { this.status('请先保存并使用，或为当前角色绑定此声音', true); return; }
      this.card.closest('#config-panel')?.querySelector('#config-close')?.click(); void startRealtimeSettingsCall();
    });
    if (!profile) return;
    const set = (id, value) => { const el = this.root.querySelector(`#${id}`); if (el) el.value = String(value ?? ''); };
    set('rt-provider', profile.provider); set('rt-region', profile.region); set('rt-voice-kind', profile.voiceKind); set('rt-voice', profile.voice);
    set('rt-gemini-backend', profile.geminiBackend); set('rt-vertex-auth-mode', profile.vertexaiAuthMode);
    this.root.querySelector('#rt-provider').disabled = Boolean(profile.id);
    this.root.querySelector('#rt-provider').onchange = event => { this.secretDraft = {}; this.draft = makeRealtimeProfile(event.target.value); this.dirty = true; this.render(); };
    this.root.querySelector('#rt-gemini-backend')?.addEventListener('change', () => {
      this.capture(); this.draft.model = isGeminiVertex(this.draft) ? GEMINI_VERTEX_MODELS[0] : preset.models[0];
      if (isGeminiVertex(this.draft) && !GEMINI_VERTEX_REGIONS.includes(this.draft.region)) this.draft.region = GEMINI_VERTEX_REGIONS[0];
      this.dirty = true; this.render();
    });
    this.root.querySelector('#rt-vertex-auth-mode')?.addEventListener('change', () => { this.capture(); this.dirty = true; this.render(); });
    this.root.querySelector('#rt-voice-kind').onchange = () => {
      this.capture(); this.draft.voice = this.draft.voiceKind === 'custom' ? this.draft.customVoices.find(item => item.status === 'ready')?.voiceId || '' : getRealtimeSystemVoices(this.draft)[0]?.id || ''; this.dirty = true; this.render();
    };
    const refreshVoiceChoices = () => {
      const previousVoices = getRealtimeSystemVoices(this.draft);
      this.capture();
      const nextVoices = getRealtimeSystemVoices(this.draft);
      if (profile.voiceKind === 'system' && previousVoices.some(voice => voice.id === profile.voice) && !nextVoices.some(voice => voice.id === profile.voice)) {
        this.draft.voice = nextVoices[0]?.id || '';
      }
      this.dirty = true; this.render();
    };
    this.root.querySelector('#rt-model').addEventListener('change', refreshVoiceChoices);
    if (profile.provider === 'step_realtime') this.root.querySelector('#rt-region').addEventListener('change', refreshVoiceChoices);
    this.root.querySelector('#rt-model').addEventListener('input', () => this.renderModelOptions());
    this.root.querySelector('#rt-refresh-models').onclick = () => this.run(async signal => {
      this.capture();
      const profile = structuredClone(this.draft), source = realtimeModelSource(profile);
      const refreshButton = this.root.querySelector('#rt-refresh-models'); refreshButton.textContent = translateUiText('刷新中...');
      this.status('正在获取模型列表...');
      try {
        const credentials = await this.readCredentials() || await this.store.credentials(this.store.get(profile.id));
        const result = await this.modelDiscovery.list(profile, credentials, { signal });
        if (signal.aborted || !this.draft || realtimeModelSource(this.draft) !== source) return;
        this.modelOptions = [...new Set(result.models)]; this.modelSource = source; this.renderModelOptions();
        this.status(result.remote ? t('成功获取 {count} 个可用模型', { count: this.modelOptions.length }) : result.message);
      } finally { refreshButton.textContent = translateUiText('刷新列表'); }
    }, '操作已取消');
    this.voicePicker = new RealtimeVoicePicker({ root: this.root.querySelector('#rt-voice-picker'), profile: this.draft });
    this.root.querySelector('#rt-refresh-voices')?.addEventListener('click', () => this.run(async signal => {
      this.capture(); const profile = structuredClone(this.draft), source = realtimeModelSource(profile);
      const credentials = await this.readCredentials() || await this.store.credentials(this.store.get(profile.id));
      this.status('正在获取音色列表...');
      const voices = await this.voiceDiscovery.list(profile, credentials, { signal });
      if (signal.aborted || source !== realtimeModelSource(this.draft)) return;
      this.voicePicker.setVoices(voices); this.status(t('已获取 {count} 个音色', { count: voices.length }));
    }, '操作已取消'));
    this.root.querySelector('#rt-save').onclick = () => this.run(async () => {
      this.capture(); const credentials = await this.readCredentials();
      this.draft = await this.store.save(this.draft, credentials); this.secretDraft = {}; this.selectedId = this.draft.id; this.dirty = false; this.render(); this.status(this.store.getBinding(getRealtimeSettingsTarget()) ? '已保存全局配置；当前角色的专属声音绑定仍生效' : '已保存并设为当前实时语音配置；下次通话生效');
    });
    this.root.querySelector('#rt-register')?.addEventListener('click', () => this.run(async () => {
      this.requireSaved({ allowVoiceDraft: true });
      const voiceId = this.root.querySelector('#rt-voice-id').value.trim(), label = this.root.querySelector('#rt-voice-label').value.trim();
      if (!voiceId) throw new Error('请填写 Voice ID');
      await this.registerVoice({ voiceId, label, status: 'ready' }); this.status('声音已登记，可在自定义声音中选择');
    }, undefined, { feedbackId: 'rt-register-status' }));
    this.root.querySelector('#rt-clone')?.addEventListener('click', () => this.run(async signal => {
      const saved = this.requireSaved({ allowVoiceDraft: true });
      this.enrollmentView.pause();
      const options = { voiceId: this.root.querySelector('#rt-voice-id')?.value.trim(), label: this.root.querySelector('#rt-voice-label')?.value.trim(), url: this.root.querySelector('#rt-clone-url')?.value.trim(), prefix: this.root.querySelector('#rt-clone-prefix')?.value.trim(), file: this.enrollmentView.file, text: this.root.querySelector('#rt-clone-text')?.value.trim() };
      this.status('正在提交声音克隆，请稍候…');
      const result = await this.enrollment.create(saved, await this.store.credentials(saved), { ...options, onProgress: phase => this.status(phase === 'uploading' ? '正在上传参考音频…' : '正在创建克隆声音…') }, signal);
      try { await this.registerVoice({ ...result, label: options.label }); }
      catch (error) { throw new Error(t('云端已创建声音 {voiceId}，但本机登记失败：{message}。请登记此 Voice ID，无需重新克隆。', { voiceId: result.voiceId, message: error.message })); }
      this.status(result.status === 'training' ? '已提交训练，请刷新声音状态' : t(this.dirty ? '声音克隆完成：{voiceId}。点击“保存并使用”后生效。' : '声音克隆完成：{voiceId}。可在自定义声音中选择。', { voiceId: result.voiceId }));
    }, undefined, { feedbackId: 'rt-clone-status', busyButtonId: 'rt-clone', busyLabel: '创建中…' }));
    this.root.querySelectorAll('[data-voice-refresh]').forEach(node => { node.onclick = () => this.run(async signal => {
      this.requireSaved(); const voiceId = node.dataset.voiceRefresh;
      const result = await this.enrollment.status(profile, await this.store.credentials(profile), voiceId, signal);
      await this.registerVoice({ ...profile.customVoices.find(item => item.voiceId === voiceId), ...result }); this.status(result.status === 'ready' ? '声音已就绪' : result.status === 'failed' ? '声音训练失败，请更换参考音频后重试' : '声音仍在训练中');
    }); });
    this.root.querySelectorAll('[data-voice-remove]').forEach(node => { node.onclick = () => this.run(async () => {
      this.requireSaved(); this.draft.customVoices = profile.customVoices.filter(item => item.voiceId !== node.dataset.voiceRemove);
      if (this.draft.voice === node.dataset.voiceRemove) { this.draft.voiceKind = 'system'; this.draft.voice = getRealtimeSystemVoices(this.draft)[0]?.id || ''; }
      this.draft = await this.store.save(this.draft, null, { activate: false }); this.render();
    }); });
    this.root.querySelectorAll('input, select, textarea').forEach(node => { if (!node.id.startsWith('rt-clone') && !['rt-profile', 'rt-voice-id', 'rt-voice-label', 'rt-voice-search'].includes(node.id)) node.addEventListener('input', () => { this.dirty = true; }); });
    this.root.querySelectorAll('[data-secret], #rt-region, #rt-workspace, #rt-vertex-project').forEach(node => node.addEventListener('input', () => {
      this.modelOptions = []; this.modelSource = ''; this.renderModelOptions();
      this.voicePicker.setVoices(null);
    }));
    this.renderModelOptions();
  }
  renderModelOptions() {
    const container = this.root.querySelector('#rt-model-options'), input = this.root.querySelector('#rt-model');
    if (!container || !input) return;
    container.replaceChildren(); container.style.display = this.modelOptions.length ? 'flex' : 'none';
    for (const id of rankModelCandidates(this.modelOptions, input.value.trim())) {
      const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'api-config-model-chip'; chip.textContent = id;
      chip.classList.toggle('is-selected', input.value.trim() === id); chip.ariaPressed = String(input.value.trim() === id);
      chip.classList.toggle('is-match', Boolean(input.value.trim() && id.toLowerCase().includes(input.value.trim().toLowerCase())));
      chip.onclick = () => { input.value = id; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); };
      container.append(chip);
    }
  }
  targetFields() {
    const target = getRealtimeSettingsTarget(); if (!target?.supported) return '';
    const binding = this.store.getBinding(target), profile = binding && this.store.get(binding.profileId);
    return `<div class="api-config-realtime-target"><strong>${tr('当前角色的实时声音')} · ${escape(target.name || target.sessionId)}</strong>
      <p>${binding ? `${escape(profile?.name || translateUiText('设置档已不存在'))} · ${escape(binding.voice)}` : tr('跟随全局实时配置')}</p>
      <div class="api-config-realtime-actions">${this.draft?.id ? button('rt-bind', '为当前角色使用此声音') : ''}${binding ? button('rt-unbind', '跟随全局实时配置') : ''}${button('rt-try-call', '试用当前通话配置')}</div></div>`;
  }
  fields(profile, preset) {
    const input = (id, label, value = '', type = 'text', extra = '', messages = []) => `<label class="api-config-realtime-field">${helpTitle(label, messages)}<input id="${id}" type="${type}" value="${escape(value)}" autocomplete="off" ${extra}></label>`;
    const vertex = isGeminiVertex(profile), serviceAccount = usesGeminiServiceAccount(profile);
    const regions = serviceAccount ? GEMINI_VERTEX_REGIONS : preset.regions;
    const secrets = vertex ? (serviceAccount ? [] : [['vertexaiApiKey', 'Vertex AI Express API Key']]) : profile.provider === 'nova_sonic' ? [['accessKeyId', 'AWS Access Key ID'], ['secretAccessKey', 'AWS Secret Access Key'], ['sessionToken', 'AWS Session Token（可选）']]
      : [...(profile.provider === 'doubao_realtime' ? [['appId', '豆包 App ID']] : []), ['apiKey', profile.provider === 'doubao_realtime' ? 'Access Token' : 'API Key']];
    return `<div class="api-config-realtime-grid">
      ${input('rt-name', '设置档名称', profile.name)}
      <label class="api-config-realtime-field">${helpTitle('服务商', [profile.provider === 'openai' ? '每轮语音转写后更新角色上下文；转写模型独立计费。' : '通话开始时加载角色上下文；通话中修改角色设定，下次通话生效。'])}<select id="rt-provider">${Object.entries(REALTIME_PROVIDERS).map(([id, item]) => option(id, item.label)).join('')}</select></label>
      ${profile.provider === 'gemini_live' ? `<label class="api-config-realtime-field"><span>${tr('Gemini Live 接入方式')}</span><select id="rt-gemini-backend">${option('developer', 'Gemini API (AI Studio)')}${option('vertex', 'Vertex AI')}</select></label>` : ''}
      ${vertex ? `<label class="api-config-realtime-field">${helpTitle('连接模式', [serviceAccount ? 'Vertex Live 使用项目额度和所选区域。' : 'Express 使用 Vertex AI 专用 API Key；模型访问权限取决于账号。'])}<select id="rt-vertex-auth-mode">${option('service_account', translateUiText('完整模式（Service Account）'))}${option('express', translateUiText('Express 模式（API Key）'))}</select></label>` : ''}
      <div class="api-config-realtime-field is-wide">
        <label class="api-config-field-label" for="rt-model">${helpTitle('Realtime 模型', ['要使用的模型 ID（可输入或从列表选择）', ...(profile.provider === 'nova_sonic' ? ['Nova 2 Sonic 的支持语言暂不包含中文；长通话会自动续接。'] : [])])}<button type="button" id="rt-refresh-models" class="api-config-refresh-action">${tr('刷新列表')}</button></label>
        <div class="api-config-model-picker"><input id="rt-model" type="text" value="${escape(profile.model)}" autocomplete="off"><div id="rt-model-options" class="api-config-model-options" aria-label="${tr('可用 Realtime 模型列表')}" style="display:none;"></div></div>
      </div>
      ${regions ? `<label class="api-config-realtime-field"><span>${tr(preset.regionLabel || '区域')}</span><select id="rt-region">${regions.map(region => option(region, translateUiText(preset.regionLabels?.[region] || region))).join('')}</select></label>` : ''}
      ${serviceAccount ? `${input('rt-vertex-project', 'Project ID', profile.vertexaiProjectId, 'text', '', ['留空时从 Service Account JSON 识别 Project ID。'])}<label class="api-config-realtime-field is-wide">${helpTitle('Service Account JSON', ['粘贴从 Google Cloud 下载的 Service Account JSON；Project ID 会自动识别。凭证保存在本机加密 Keyring。'])}<textarea id="rt-secret-vertexaiServiceAccount" data-secret="vertexaiServiceAccount" autocomplete="off" spellcheck="false" rows="4" placeholder="${tr(profile.credentialId ? '已保存；留空保持原值' : '尚未填写')}">${escape(this.secretDraft.vertexaiServiceAccount || '')}</textarea></label>` : ''}
      ${profile.provider === 'qwen_audio_realtime' ? input('rt-workspace', 'Workspace ID（可选）', profile.workspaceId) : ''}
      ${secrets.map(([key, label]) => input(`rt-secret-${key}`, label, this.secretDraft[key] || '', 'password', `data-secret="${key}" placeholder="${tr(profile.credentialId ? '已保存；留空保持原值' : '尚未填写')}"`)).join('')}
      <label class="api-config-realtime-field">${helpTitle('声音类型', profile.provider === 'doubao_realtime' ? ['SC2.0 使用 saturn_ 系统声音或 S_ 克隆声音；预设角色音色可能影响角色表现。'] : [])}<select id="rt-voice-kind">${option('system', translateUiText('系统声音'))}${preset.clone ? option('custom', translateUiText('自定义声音')) : ''}</select></label>
      ${input('rt-idle', '静音挂断（分钟）', profile.idleTimeoutMinutes, 'number', 'min="1" max="30"')}
      ${realtimeVoicePickerFields(profile)}
    </div>
    <div class="api-config-realtime-actions">${button('rt-save', '保存并使用')}</div>
    ${realtimeEnrollmentFields(profile, preset)}`;
  }
  async readCredentials() {
    const updates = {};
    this.root.querySelectorAll('[data-secret]').forEach(node => { if (node.value.trim()) updates[node.dataset.secret] = node.value.trim(); });
    if (!Object.keys(updates).length) return null;
    return { ...await this.store.credentials(this.draft.id ? this.store.get(this.draft.id) : null), ...updates };
  }
  requireSaved({ allowVoiceDraft = false } = {}) {
    this.capture();
    const saved = this.draft?.id && this.store.get(this.draft.id);
    // Choosing an as-yet unregistered voice must not prevent creating that voice.
    // Every other field and any entered credential still require an explicit save.
    const onlyVoiceChanged = allowVoiceDraft && saved && !Object.values(this.secretDraft).some(value => String(value).trim()) && Object.keys(saved).every(key =>
      ['voice', 'voiceKind'].includes(key) || (key === 'idleTimeoutMinutes' ? Number(this.draft[key]) === Number(saved[key]) : JSON.stringify(this.draft[key]) === JSON.stringify(saved[key])));
    if (!saved || (this.dirty && !onlyVoiceChanged)) throw new Error('请先保存当前设置档，再管理声音');
    return saved;
  }
  async registerVoice(voice) {
    const current = this.store.get(this.draft.id);
    const choice = { voice: this.draft.voice, voiceKind: this.draft.voiceKind };
    const record = { ...voice, label: voice.label || voice.voiceId, targetModel: current.model, region: current.region, workspaceId: current.workspaceId, credentialId: current.credentialId };
    current.customVoices = [...current.customVoices.filter(item => item.voiceId !== record.voiceId), record];
    const saved = await this.store.save(current, null, { activate: false });
    if (choice.voiceKind === 'custom' && !choice.voice && voice.status === 'ready') choice.voice = voice.voiceId;
    this.draft = { ...saved, ...choice }; this.dirty = saved.voice !== choice.voice || saved.voiceKind !== choice.voiceKind; this.render();
  }
}
