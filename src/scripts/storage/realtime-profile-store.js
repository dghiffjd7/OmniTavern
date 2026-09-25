import { realtimeTargetBindingKey } from '../ui/realtime/realtime-settings-target.js';
import { safeInvoke } from '../utils/tauri.js';
import { isOpenAiLive } from '../ui/realtime/openai-live-config.js';
import { normalizeRealtimeVadSettings } from '../ui/realtime/realtime-voice-config-utils.js';
import { makeRealtimeProfile, getRealtimeProvider, validateRealtimeProfile, validateRealtimeCredentials, usesGeminiServiceAccount, parseRealtimeServiceAccount } from '../ui/realtime/realtime-provider-catalog.js';

export const REALTIME_PROFILE_STORE_KEY = 'realtime_profiles_v1';
const copy = value => JSON.parse(JSON.stringify(value));
const text = value => String(value || '').trim();
const cleanProfile = input => {
  if (!getRealtimeProvider(input?.provider)) return null;
  const base = makeRealtimeProfile(input.provider);
  const result = Object.fromEntries(Object.keys(base).map(key => [key, input[key] ?? base[key]]));
  for (const key of ['id', 'name', 'model', 'voice', 'region', 'workspaceId', 'credentialId']) result[key] = text(result[key]);
  for (const key of ['replyLanguage', 'transcriptionLanguage']) result[key] = text(result[key]).replace(/\s+/g, ' ').slice(0, 80);
  if (result.provider === 'step_realtime' && !result.region) result.region = 'cn';
  if (result.provider === 'openai') for (const key of ['openaiBackend', 'liveBackendModel']) result[key] = text(result[key]);
  if (result.provider === 'custom') for (const key of ['customProtocol', 'endpoint', 'authMode', 'authHeader', 'transcriptionModel']) result[key] = text(result[key]);
  if (result.provider === 'custom') result.vad = normalizeRealtimeVadSettings({ ...result.vad, mode: 'server_vad' });
  if (result.provider === 'gemini_live') for (const key of ['geminiBackend', 'vertexaiAuthMode', 'vertexaiProjectId']) result[key] = text(result[key]);
  result.idleTimeoutMinutes = Math.min(30, Math.max(1, Number(result.idleTimeoutMinutes) || 10));
  result.voiceKind = input.voiceKind === 'custom' ? 'custom' : 'system';
  result.customVoices = (Array.isArray(input.customVoices) ? input.customVoices : []).slice(0, 200).map(voice => ({
    voiceId: text(voice.voiceId), label: text(voice.label) || text(voice.voiceId), targetModel: text(voice.targetModel),
    region: text(voice.region) || (result.provider === 'step_realtime' ? 'cn' : ''), workspaceId: text(voice.workspaceId), credentialId: text(voice.credentialId),
    status: ['ready', 'training', 'failed'].includes(voice.status) ? voice.status : 'training',
  })).filter(voice => voice.voiceId);
  return result;
};
const normalize = value => ({ version: 1, bindings: Object.fromEntries(Object.entries(value?.bindings && typeof value.bindings === 'object' ? value.bindings : {}).filter(([key, binding]) => key.length < 1024 && binding?.profileId && binding?.voice).map(([key, binding]) => [key, { profileId: text(binding.profileId), voice: text(binding.voice), voiceKind: binding.voiceKind === 'custom' ? 'custom' : 'system' }])), activeProfileId: text(value?.activeProfileId), profiles: (Array.isArray(value?.profiles) ? value.profiles : []).map(cleanProfile).filter(Boolean) });
export class RealtimeProfileStore {
  constructor({ storage = globalThis.localStorage, keyring = null, invoke = safeInvoke } = {}) {
    this.storage = storage; this.keyring = keyring; this.invoke = invoke; this.state = normalize({}); this.pending = Promise.resolve();
    try { this.state = normalize(JSON.parse(storage?.getItem(REALTIME_PROFILE_STORE_KEY) || '{}')); } catch {}
    this.ready = this.hydrate();
  }
  async hydrate() {
    try { const value = await this.invoke('load_kv', { name: REALTIME_PROFILE_STORE_KEY }); if (value?.version === 1) this.state = normalize(value); } catch {}
    return this.list();
  }
  list() { return copy(this.state.profiles); }
  get(id) { return this.list().find(profile => profile.id === id) || null; }
  get activeId() { return this.state.activeProfileId; }
  transact(operation) {
    const task = this.pending.then(async () => { await this.ready; return operation(); });
    this.pending = task.catch(() => {}); return task;
  }
  async persist(next) {
    const normalized = normalize(next);
    await this.invoke('save_kv', { name: REALTIME_PROFILE_STORE_KEY, data: normalized });
    this.state = normalized;
    try { this.storage?.setItem(REALTIME_PROFILE_STORE_KEY, JSON.stringify(normalized)); } catch {}
  }
  async getKeyring() {
    if (!this.keyring) { const { ConfigManager } = await import('./config.js'); this.keyring = new ConfigManager({ scope: 'voice_realtime', credentialsOnly: true }); }
    return this.keyring;
  }
  async credentials(profile) {
    if (!profile?.credentialId) return {};
    return JSON.parse(await (await this.getKeyring()).decryptKey(profile.id, profile.credentialId) || '{}');
  }
  save(input, credentials = null, { activate = true } = {}) {
    return this.transact(async () => {
      const profile = cleanProfile({ ...input, id: input.id || `rt_${globalThis.crypto.randomUUID()}` });
      if (!profile) throw new Error('未知实时语音服务商');
      const previous = this.get(profile.id);
      if (previous && previous.provider !== profile.provider) throw new Error('更换服务商请新建设置档');
      // Re-entering the same key does not invalidate voices; changing account does.
      const oldCredentials = await this.credentials(previous);
      const effectiveCredentials = validateRealtimeCredentials(profile.provider, credentials || oldCredentials, profile);
      if (usesGeminiServiceAccount(profile) && !profile.vertexaiProjectId) profile.vertexaiProjectId = text(parseRealtimeServiceAccount(effectiveCredentials.vertexaiServiceAccount).project_id);
      const changed = !previous?.credentialId || (credentials && JSON.stringify(credentials) !== JSON.stringify(oldCredentials));
      let newCredentialId = '';
      try {
        if (changed) { newCredentialId = await (await this.getKeyring()).addKey(profile.id, JSON.stringify(effectiveCredentials), 'Realtime credentials'); profile.credentialId = newCredentialId; }
        else profile.credentialId = previous?.credentialId || profile.credentialId;
        validateRealtimeProfile(profile);
        if (!profile.credentialId) throw new Error('请先填写服务商凭证');
        const profiles = this.list().filter(item => item.id !== profile.id); profiles.push(profile);
        await this.persist({ ...this.state, profiles, activeProfileId: activate ? profile.id : this.activeId });
      } catch (error) {
        if (newCredentialId) await (await this.getKeyring()).removeKey(profile.id, newCredentialId).catch(() => {});
        throw error;
      }
      if (changed && previous?.credentialId) await (await this.getKeyring()).removeKey(profile.id, previous.credentialId).catch(() => {});
      return this.get(profile.id);
    });
  }
  duplicate(id) { return this.transact(async () => {
    const source = this.get(id); if (!source) throw new Error('设置档已不存在');
    const credentials = await this.credentials(source);
    const profile = { ...source, id: `rt_${globalThis.crypto.randomUUID()}`, name: `${source.name} (2)` };
    profile.credentialId = await (await this.getKeyring()).addKey(profile.id, JSON.stringify(credentials), 'Realtime credentials');
    profile.customVoices = profile.customVoices.map(voice => ({ ...voice, credentialId: voice.credentialId === source.credentialId ? profile.credentialId : voice.credentialId }));
    try { validateRealtimeProfile(profile); await this.persist({ ...this.state, profiles: [...this.list(), profile] }); }
    catch (error) { await (await this.getKeyring()).removeKey(profile.id, profile.credentialId).catch(() => {}); throw error; }
    return this.get(profile.id);
  }); }
  activate(id = '') { return this.transact(async () => { if (id && !this.get(id)) throw new Error('设置档已不存在'); await this.persist({ ...this.state, activeProfileId: id }); }); }
  remove(id) { return this.transact(async () => {
    const profile = this.get(id); if (!profile) return;
    await this.persist({ ...this.state, profiles: this.list().filter(item => item.id !== id), activeProfileId: this.activeId === id ? '' : this.activeId });
    if (profile.credentialId) await (await this.getKeyring()).removeKey(id, profile.credentialId).catch(() => {});
  }); }
  getBinding(target) { return copy(this.state.bindings[realtimeTargetBindingKey(target)] || null); }
  bindTarget(target, profileId = '') { return this.transact(async () => {
    const key = realtimeTargetBindingKey(target); if (!key) throw new Error('请先打开一个角色会话');
    const bindings = { ...this.state.bindings };
    if (profileId) {
      const profile = this.get(profileId); if (!profile) throw new Error('设置档已不存在');
      validateRealtimeProfile(profile);
      bindings[key] = { profileId, voice: profile.voice, voiceKind: profile.voiceKind };
    } else delete bindings[key];
    await this.persist({ ...this.state, bindings });
  }); }
  async resolveBinding(target) {
    await this.ready; const binding = this.getBinding(target); if (!binding) return null;
    const profile = this.get(binding.profileId); if (!profile) throw new Error('角色绑定的实时语音设置档已不存在，请重新绑定');
    return this.resolveProfile({ ...profile, voice: binding.voice, voiceKind: binding.voiceKind });
  }
  async resolveProfile(profile) {
    validateRealtimeProfile(profile);
    const credentials = validateRealtimeCredentials(profile.provider, await this.credentials(profile), profile);
    return { ok: true, settings: { ...profile, realtimeModel: profile.model, transcriptionModel: isOpenAiLive(profile) ? '' : profile.provider === 'custom' ? profile.transcriptionModel : 'gpt-4o-mini-transcribe', contextMode: isOpenAiLive(profile) ? 'full_duplex' : ['openai', 'custom'].includes(profile.provider) ? 'per_turn' : 'session_snapshot' },
      config: { ...profile, credentials, apiKey: credentials.apiKey || '', baseUrl: profile.provider === 'openai' ? 'https://api.openai.com/v1' : '' } };
  }
  async resolve() {
    await this.ready;
    if (!this.activeId) return null; // Legacy OpenAI is left intact until a new profile is explicitly selected.
    const profile = this.get(this.activeId);
    if (!profile) throw new Error('实时语音设置档已不存在');
    return this.resolveProfile(profile);
  }
}
let singleton;
export const getRealtimeProfileStore = () => singleton ||= new RealtimeProfileStore();
