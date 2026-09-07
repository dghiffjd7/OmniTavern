import { t, translateUiText } from '../../i18n/index.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const tr = value => escape(translateUiText(value));
const helpTitle = (label, messages = []) => `<span${messages.length ? ` class="has-help" data-help="${messages.map(tr).join('&#10;')}" data-help-mode="tap"` : ''}>${tr(label)}</span>`;
const icon = paths => `<svg class="api-config-svg" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const waveform = icon('<path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4"/>');
const chevron = icon('<path d="m8 10 4 4 4-4"/>');
const upload = icon('<path d="M12 16V4m-4 4 4-4 4 4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>');
const remove = icon('<path d="m6 6 12 12M6 18 18 6"/>');
const input = (id, label, value = '', extra = '', messages = []) => `<label class="api-config-realtime-field">${helpTitle(label, messages)}<input id="${id}" type="text" value="${escape(value)}" autocomplete="off" ${extra}></label>`;
const status = id => `<small id="${id}" class="api-config-realtime-status rt-enrollment-status" role="status" aria-live="polite"></small>`;

export const realtimeEnrollmentFields = (profile, preset) => {
  if (!preset.clone) return '';
  const canCreate = preset.clone !== 'import', slot = preset.clone === 'slot';
  const importFields = `${!slot ? input('rt-voice-id', '已有 Voice ID') : ''}<div class="rt-enrollment-action-row"><button type="button" id="rt-register" class="api-config-button">${tr('登记已有声音')}</button></div>${status('rt-register-status')}`;
  return `<details class="api-config-realtime-enrollment rt-enrollment">
    <summary class="rt-enrollment-heading"><span class="rt-enrollment-emblem">${waveform}</span><strong>${tr('自定义声音与声音克隆')}</strong><span class="rt-enrollment-count">${profile.customVoices.length}</span><span class="rt-enrollment-chevron">${chevron}</span></summary>
    <div class="rt-enrollment-body">
      <div class="api-config-realtime-grid ${slot ? '' : 'rt-enrollment-name'}">${input('rt-voice-label', '声音名称（可选）')}${slot ? input('rt-voice-id', '豆包音色槽位', '', 'placeholder="S_…"', ['豆包需要已购买的 S_ 音色槽位；使用 ICL 2.0 训练供实时通话使用。']) : ''}</div>
      ${canCreate ? `<section class="rt-clone-card">
        <div class="rt-enrollment-section-heading"><h4>${helpTitle('创建新声音', ['点击创建会把参考音频提交给当前服务商，并可能产生服务费用。'])}</h4></div>
        ${preset.clone === 'url' ? `<div class="api-config-realtime-grid">${input('rt-clone-url', '参考音频 HTTPS URL', '', 'inputmode="url"', ['Qwen 克隆仅支持北京区域；声音只能用于创建时指定的目标模型。'])}${input('rt-clone-prefix', '声音前缀', 'myvoice')}</div>` : `
          <div class="api-config-realtime-field">
          <span id="rt-clone-file-hint" class="has-help" data-help="${[profile.provider === 'step_realtime' ? 'Step 建议使用 5–10 秒清晰人声，支持 WAV / MP3。' : '支持 WAV / MP3 参考音频。', '单个文件，最大 10 MB', '桌面支持拖入音档。'].map(tr).join('&#10;')}" data-help-mode="tap">${tr('参考音频')}</span>
          <div id="rt-clone-upload" class="rt-audio-upload">
            <input id="rt-clone-file" class="rt-audio-native-input" type="file" accept=".wav,.mp3,audio/wav,audio/mpeg" hidden tabindex="-1" aria-label="${tr('参考音频')}">
            <button type="button" id="rt-clone-choose" class="rt-audio-choose" aria-describedby="rt-clone-file-hint"><span class="rt-upload-icon">${upload}</span><strong id="rt-clone-choose-label">${tr('选择音档')}</strong></button>
            <div id="rt-clone-selected" class="rt-audio-selected" hidden><div class="rt-audio-file-row"><span class="rt-audio-file-icon">${waveform}</span><div class="rt-audio-file-copy"><strong id="rt-clone-file-name"></strong><small id="rt-clone-file-meta"></small></div><button type="button" id="rt-clone-file-remove" class="api-config-icon-action" aria-label="${tr('移除音频')}" title="${tr('移除音频')}">${remove}</button></div><audio id="rt-clone-preview" controls preload="metadata" aria-label="${tr('参考音频试听')}"></audio></div>
          </div>
          </div>
          ${status('rt-file-status')}
          <label class="api-config-realtime-field rt-enrollment-transcript">${helpTitle('参考音频文字（可选）', ['填写音频中说出的内容'])}<textarea id="rt-clone-text" rows="2" autocomplete="off"></textarea></label>`}
        <div class="rt-enrollment-action-row"><button type="button" id="rt-clone" class="api-config-button is-primary">${tr('创建克隆声音')}</button></div>
        ${status('rt-clone-status')}
      </section>` : ''}
      ${canCreate ? `<details class="rt-enrollment-import"><summary><span>${tr('登记已有声音')}</span>${chevron}</summary><div class="rt-enrollment-import-body">${importFields}</div></details>` : `<section class="rt-clone-card">${importFields}</section>`}
      <section class="rt-registered-voices"><div class="rt-enrollment-section-heading"><h4>${tr('已登记声音')}</h4><span class="rt-enrollment-count">${profile.customVoices.length}</span></div>
      ${profile.customVoices.length ? `<ul>${profile.customVoices.map(voice => `<li class="rt-registered-voice"><div class="rt-registered-voice-copy"><strong>${escape(voice.label)}</strong><code>${escape(voice.voiceId)}</code></div><span class="rt-voice-state" data-state="${escape(voice.status)}">${tr(voice.status === 'ready' ? '就绪' : voice.status === 'training' ? '训练中' : '失败')}</span><div class="rt-registered-voice-actions">${profile.provider === 'doubao_realtime' ? `<button type="button" class="api-config-icon-action" data-voice-refresh="${escape(voice.voiceId)}" title="${tr('刷新状态')}" aria-label="${tr('刷新状态')}">${icon('<path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 17.9 17"/>')}</button>` : ''}<button type="button" class="api-config-icon-action is-danger" data-voice-remove="${escape(voice.voiceId)}" title="${tr('移除登记')}" aria-label="${tr('移除登记')}">${icon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/>')}</button></div></li>`).join('')}</ul>` : `<div class="rt-enrollment-empty">${waveform}<span>${tr('还没有自定义声音')}</span></div>`}</section>
    </div>
  </details>`;
};

export const validateRealtimeReferenceFiles = files => {
  if (files.length !== 1) throw new Error(t('每次克隆仅支持 1 个音档，请逐个添加；当前音档已保留'));
  const file = files[0];
  if (!/\.(wav|mp3)$/i.test(file.name || '')) throw new Error(t('请选择 WAV 或 MP3 音频'));
  if (!(file.size > 0 && file.size <= 10 * 1024 * 1024)) throw new Error(t('请选择 10 MB 以内的参考音频'));
  return file;
};
const fileSize = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// The local reference file belongs to a profile draft, never to persisted settings.
export class RealtimeEnrollmentView {
  constructor({ isBusy = () => false, urlApi = globalThis.URL } = {}) { this.isBusy = isBusy; this.urlApi = urlApi; this.file = null; this.fields = {}; this.context = ''; }
  attach(root, profile) {
    this.detach(); this.root = root;
    const context = JSON.stringify(profile && [profile.id, profile.provider, profile.region, profile.workspaceId, profile.credentialId]);
    if (context !== this.context) { this.file = null; this.fields = {}; this.context = context; }
    for (const [id, value] of Object.entries(this.fields)) { const input = root.querySelector(`#${id}`); if (input) input.value = value; }
    this.zone = root.querySelector('#rt-clone-upload'); if (!this.zone) return;
    this.input = root.querySelector('#rt-clone-file'); this.audio = root.querySelector('#rt-clone-preview');
    this.listeners = new AbortController(); const options = { signal: this.listeners.signal };
    this.input.addEventListener('input', () => { if (this.input.files.length) this.select([...this.input.files]); }, options);
    root.querySelector('#rt-clone-choose').addEventListener('click', () => { if (!this.isBusy()) this.input.click(); }, options);
    root.querySelector('#rt-clone-file-remove').addEventListener('click', () => { if (!this.isBusy()) { this.file = null; this.input.value = ''; this.showFile(); this.feedback(''); } }, options);
    for (const type of ['dragenter', 'dragover']) this.zone.addEventListener(type, event => {
      if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = this.isBusy() ? 'none' : 'copy';
      this.zone.classList.toggle('is-dragover', !this.isBusy());
    }, options);
    this.zone.addEventListener('dragleave', event => { if (!this.zone.contains(event.relatedTarget)) this.zone.classList.remove('is-dragover'); }, options);
    this.zone.addEventListener('drop', event => {
      if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
      event.preventDefault(); event.stopPropagation(); this.zone.classList.remove('is-dragover');
      if (!this.isBusy()) this.select([...event.dataTransfer.files]);
    }, options);
    this.audio.addEventListener('loadedmetadata', () => this.updateMeta(), options);
    this.showFile();
  }
  feedback(message) {
    const node = this.root?.querySelector('#rt-file-status'); if (!node) return;
    node.textContent = message; node.dataset.type = message ? 'error' : '';
    if (message) node.scrollIntoView({ block: 'nearest' });
  }
  select(files) {
    if (this.isBusy()) return;
    try { this.file = validateRealtimeReferenceFiles(files); this.feedback(''); this.showFile(); }
    catch (error) { this.syncInput(); this.feedback(error.message); }
  }
  syncInput() {
    this.input.value = '';
    if (this.file && typeof DataTransfer !== 'undefined') { const transfer = new DataTransfer(); transfer.items.add(this.file); this.input.files = transfer.files; }
  }
  showFile() {
    this.releasePreview(); this.syncInput();
    this.root.querySelector('#rt-clone-selected').hidden = !this.file;
    this.root.querySelector('#rt-clone-choose-label').textContent = translateUiText(this.file ? '更换音档' : '选择音档');
    this.zone.classList.toggle('has-file', !!this.file);
    if (!this.file) return;
    this.root.querySelector('#rt-clone-file-name').textContent = this.file.name;
    this.objectUrl = this.urlApi.createObjectURL(this.file); this.audio.src = this.objectUrl; this.updateMeta();
  }
  updateMeta() {
    if (!this.file) return;
    const seconds = this.audio.duration;
    const duration = Number.isFinite(seconds) && seconds > 0 ? ` · ${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '';
    this.root.querySelector('#rt-clone-file-meta').textContent = `${this.file.name.split('.').pop().toUpperCase()} · ${fileSize(this.file.size)}${duration}`;
  }
  pause() { this.audio?.pause(); }
  releasePreview() {
    this.pause(); if (this.audio?.hasAttribute('src')) { this.audio.removeAttribute('src'); this.audio.load(); }
    if (this.objectUrl) this.urlApi.revokeObjectURL(this.objectUrl); this.objectUrl = '';
  }
  detach() {
    for (const id of ['rt-voice-label', 'rt-voice-id', 'rt-clone-url', 'rt-clone-prefix', 'rt-clone-text']) { const input = this.root?.querySelector(`#${id}`); if (input) this.fields[id] = input.value; }
    this.listeners?.abort(); this.releasePreview(); this.root = null; this.zone = null; this.input = null; this.audio = null;
  }
}
