import { t, translateUiText } from '../../i18n/index.js';
import { getRealtimeVoiceOptions, realtimeVoiceMatches } from './realtime-voice-catalog.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const tr = value => escape(translateUiText(value));
export const realtimeVoiceGender = gender => ({ male: '男声', female: '女声', neutral: '中性声音' })[gender] || '性别未标注';
export const filterRealtimeVoices = (voices, query, translate = translateUiText) => {
  const words = String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return voices.filter(voice => {
    const fields = [voice.id, voice.label, voice.gender, realtimeVoiceGender(voice.gender), voice.description, voice.language];
    const text = [...fields, ...fields.map(value => translate(value || ''))].join(' ').toLocaleLowerCase();
    return words.every(word => ['male', 'female', 'neutral'].includes(word) ? voice.gender === word : text.includes(word));
  });
};
export const realtimeVoicePickerFields = profile => `<div class="api-config-realtime-field is-wide rt-voice-picker" id="rt-voice-picker">
  <div class="rt-voice-heading"><label for="rt-voice-search">${tr('声音')}</label><small id="rt-voice-count" role="status"></small>${profile.provider === 'xai_voice' && profile.voiceKind !== 'custom' ? `<button type="button" id="rt-refresh-voices" class="api-config-refresh-action">${tr('刷新列表')}</button>` : ''}</div>
  <input id="rt-voice-search" type="search" autocomplete="off" placeholder="${tr('搜索名称、特点或语言')}" aria-controls="rt-voice-options">
  <div id="rt-voice-options" class="api-config-model-options rt-voice-options" role="group" aria-label="${tr('可选音色')}"></div>
  <div id="rt-voice-detail" class="rt-voice-detail" aria-live="polite"></div>
  <label class="rt-voice-id-label" for="rt-voice">${tr('声音 ID（可手动填写）')}</label><input id="rt-voice" type="text" autocomplete="off" value="${escape(profile.voice)}" aria-describedby="rt-voice-detail">
</div>`;

// Searching never edits the selected voice. Click/Enter select; hover/focus only preview.
export class RealtimeVoicePicker {
  constructor({ root, profile }) {
    this.root = root; this.profile = profile; this.voices = getRealtimeVoiceOptions(profile);
    this.events = new AbortController(); const options = { signal: this.events.signal };
    this.search = root.querySelector('#rt-voice-search'); this.input = root.querySelector('#rt-voice');
    this.list = root.querySelector('#rt-voice-options'); this.detail = root.querySelector('#rt-voice-detail');
    this.search.addEventListener('input', () => { this.hideTooltip(); this.renderList(); }, options);
    this.input.addEventListener('input', () => { this.profile.voice = this.input.value; this.updateSelection(); }, options);
    this.input.addEventListener('change', () => { this.profile.voice = this.input.value.trim(); this.input.value = this.profile.voice; this.updateSelection(); }, options);
    this.list.addEventListener('click', event => {
      const button = event.target.closest('[data-rt-voice]'); if (!button || button.disabled) return;
      this.input.value = button.dataset.rtVoice;
      this.input.dispatchEvent(new Event('input', { bubbles: true })); this.input.dispatchEvent(new Event('change', { bubbles: true }));
      this.hideTooltip();
    }, options);
    this.list.addEventListener('pointerover', event => {
      if (event.pointerType !== 'mouse') return;
      const button = event.target.closest('[data-rt-voice]'); if (button) this.showTooltip(button);
    }, options);
    this.list.addEventListener('pointerout', event => {
      if (!event.relatedTarget?.closest?.('[data-rt-voice]')) this.hideTooltip();
    }, options);
    this.list.addEventListener('focusin', event => { const button = event.target.closest('[data-rt-voice]'); if (button?.matches(':focus-visible')) this.showTooltip(button); }, options);
    this.list.addEventListener('focusout', () => this.hideTooltip(), options);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') this.hideTooltip(); }, options);
    document.addEventListener('scroll', () => this.hideTooltip(), { ...options, capture: true });
    window.addEventListener('resize', () => this.hideTooltip(), options);
    this.renderList();
  }
  setVoices(voices) { this.voices = getRealtimeVoiceOptions(this.profile, voices); this.hideTooltip(); this.renderList(); }
  renderList() {
    const matches = filterRealtimeVoices(this.voices, this.search.value);
    this.list.innerHTML = matches.map(voice => `<button type="button" class="api-config-model-chip rt-voice-option" data-rt-voice="${escape(voice.id)}" aria-pressed="false">
      <strong>${tr(voice.label)}</strong><small>${[voice.gender && translateUiText(realtimeVoiceGender(voice.gender)), translateUiText(voice.description || voice.language || '官方音色')].filter(Boolean).map(escape).join(' · ')}</small>
    </button>`).join('') || `<p class="rt-voice-empty">${tr(this.voices.length ? '没有匹配的音色' : '请先登记声音')}</p>`;
    this.root.querySelector('#rt-voice-count').textContent = t('{count} / {total} 个音色', { count: matches.length, total: this.voices.length });
    this.updateSelection();
  }
  description(voice) {
    return `<strong>${tr(voice.label)}</strong><span>${tr(realtimeVoiceGender(voice.gender))}${voice.language ? ` · ${tr(voice.language)}` : ''}</span>
      ${voice.description ? `<p>${tr(voice.description)}</p>` : `<p>${tr('官方暂未提供音色特点')}</p>`}<code>${escape(voice.id)}</code>`;
  }
  updateSelection() {
    const id = this.input.value;
    for (const button of this.list.querySelectorAll('[data-rt-voice]')) {
      const selected = realtimeVoiceMatches(this.profile, button.dataset.rtVoice, id);
      button.classList.toggle('is-selected', selected); button.setAttribute('aria-pressed', String(selected));
    }
    const voice = this.voices.find(voice => realtimeVoiceMatches(this.profile, voice.id, id));
    this.detail.innerHTML = voice ? this.description({ ...voice, id }) : `<span>${tr(id ? '此 ID 未列入当前候选，请确认模型支持' : '请选择声音或填写 Voice ID')}</span>`;
  }
  showTooltip(button) {
    if (button.disabled || this.tooltipButton === button) return;
    const voice = this.voices.find(voice => voice.id === button.dataset.rtVoice); if (!voice) return;
    this.hideTooltip();
    this.tooltipButton = button; this.tooltip = document.createElement('div');
    this.tooltip.className = 'rt-voice-tooltip'; this.tooltip.id = 'rt-voice-tooltip'; this.tooltip.setAttribute('role', 'tooltip');
    this.tooltip.innerHTML = this.description(voice); document.body.append(this.tooltip); button.setAttribute('aria-describedby', this.tooltip.id);
    const rect = button.getBoundingClientRect(), tip = this.tooltip.getBoundingClientRect();
    this.tooltip.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - tip.width - 12))}px`;
    this.tooltip.style.top = `${Math.max(12, rect.bottom + tip.height + 12 < innerHeight ? rect.bottom + 8 : rect.top - tip.height - 8)}px`;
  }
  hideTooltip() { this.tooltip?.remove(); this.tooltipButton?.removeAttribute('aria-describedby'); this.tooltip = null; this.tooltipButton = null; }
  destroy() { this.hideTooltip(); this.events.abort(); }
}
