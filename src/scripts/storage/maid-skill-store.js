import { safeInvoke } from '../utils/tauri.js';
import { listMaidSkills, readMaidSkill } from '../agent/maid-skill-catalog.js';
import { assertMaidSkillStoreSize, maidSkillContentKey, makeMaidSkillId, normalizeMaidSkillDraft, normalizeMaidSkillMetadata, normalizeMaidSkillStoreState, skillClone, skillError } from '../agent/maid-skill-schema.js';

export const MAID_SKILL_STORE_KEY = 'maid_skill_store_v1';
const nativeAvailable = () => Boolean(globalThis.__TAURI_INTERNALS__?.invoke || globalThis.__TAURI__?.core?.invoke || globalThis.__TAURI__?.invoke || globalThis.__TAURI_INVOKE__);
const storageDefault = () => { try { return globalThis.localStorage || null; } catch { return null; } };

export class MaidSkillStore {
  constructor({ storage = storageDefault(), loadKv, saveKv, now = Date.now, createId = makeMaidSkillId } = {}) {
    this.storage = storage;
    this.native = typeof loadKv === 'function' || nativeAvailable();
    this.loadKv = loadKv || (key => safeInvoke('load_kv', { name: key }));
    this.saveKv = saveKv || ((key, data) => safeInvoke('save_kv', { name: key, data }));
    this.now = now; this.createId = createId;
    this.state = null; this.loadError = null; this.listeners = new Set(); this.queue = Promise.resolve();
    this.ready = this.load();
    this.ready.catch(() => {}); // Consumers still receive the rejected readiness promise.
  }

  load() {
    const pending = this.queue.then(async () => {
      try {
        const raw = this.native ? await this.loadKv(MAID_SKILL_STORE_KEY) : JSON.parse(this.storage?.getItem(MAID_SKILL_STORE_KEY) || 'null');
        this.state = normalizeMaidSkillStoreState(raw); this.loadError = null;
        this.notify(); return this.exportState();
      } catch (error) { this.loadError = error; throw error; }
    });
    this.queue = pending.catch(() => {});
    this.ready = pending; pending.catch(() => {});
    return pending;
  }

  assertReady() { if (this.loadError) throw this.loadError; if (!this.state) throw skillError('skill_store_not_ready'); }
  exportState() { this.assertReady(); return skillClone(this.state); }
  list() {
    this.assertReady();
    const custom = [...this.state.skills].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const builtins = listMaidSkills().map(({ id }) => ({ ...readMaidSkill(id), name: id.replace(/[_.]/g, '-'), kind: 'builtin', revision: 1, enabled: true, invocationMode: 'auto', portableMetadata: {}, ...this.state.builtinOverrides[id] }));
    return skillClone([...custom, ...builtins]);
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() { for (const listener of this.listeners) { try { listener(); } catch {} } }

  commit(mutate) {
    const ready = this.ready;
    const task = this.queue.then(async () => {
      await ready; this.assertReady();
      const next = skillClone(this.state), result = mutate(next);
      next.storeRevision += 1; assertMaidSkillStoreSize(next);
      if (this.native) await this.saveKv(MAID_SKILL_STORE_KEY, next);
      else {
        if (!this.storage?.setItem) throw skillError('skill_storage_unavailable');
        this.storage.setItem(MAID_SKILL_STORE_KEY, JSON.stringify(next));
      }
      this.state = next; this.notify(); return skillClone(result);
    });
    this.queue = task.catch(() => {});
    return task;
  }

  put(next, draft, { id, expectedRevision, disableBuiltinId, derivedFrom, source } = {}) {
    const current = id ? next.skills.find(skill => skill.id === id) : null;
    if (id && !current) throw skillError('skill_not_found');
    if (current && current.revision !== expectedRevision) throw skillError('skill_revision_conflict');
    const normalized = normalizeMaidSkillDraft(draft);
    if (listMaidSkills().some(skill => skill.id.replace(/[_.]/g, '-') === normalized.name)) throw skillError('skill_duplicate_name');
    const timestamp = this.now();
    const item = { ...normalized, id: current?.id || this.createId(), kind: 'custom',
      revision: current ? current.revision + Number(maidSkillContentKey(current) !== maidSkillContentKey(normalized)) : 1,
      createdAt: current?.createdAt || timestamp, updatedAt: timestamp,
      derivedFrom: current?.derivedFrom || derivedFrom || null,
      source: normalizeMaidSkillMetadata(current?.source || source || { kind: derivedFrom ? 'builtin-copy' : 'local' }) };
    if (current) next.skills[next.skills.indexOf(current)] = item; else next.skills.push(item);
    if (disableBuiltinId && normalized.enabled) {
      if (!readMaidSkill(disableBuiltinId)) throw skillError('skill_not_found');
      next.builtinOverrides[disableBuiltinId] = { ...(next.builtinOverrides[disableBuiltinId] || {}), enabled: false };
    }
    return item;
  }

  save(draft, options = {}) { return this.commit(next => this.put(next, draft, options)); }
  importEntries(entries = []) {
    if (!Array.isArray(entries) || !entries.length) return Promise.reject(skillError('skill_import_empty'));
    return this.commit(next => entries.map(entry => this.put(next, entry.skill, entry.options)));
  }
  remove(id, { expectedRevision } = {}) {
    return this.commit(next => {
      const skill = next.skills.find(item => item.id === id);
      if (!skill) throw skillError('skill_not_found');
      if (expectedRevision !== undefined && skill.revision !== expectedRevision) throw skillError('skill_revision_conflict');
      next.skills = next.skills.filter(item => item.id !== id); return { id };
    });
  }
  setAvailability(id, patch = {}) {
    return this.commit(next => {
      const item = next.skills.find(skill => skill.id === id);
      if (!item && !readMaidSkill(id)) throw skillError('skill_not_found');
      const target = item || (next.builtinOverrides[id] ||= {});
      if (typeof patch.enabled === 'boolean') target.enabled = patch.enabled;
      if (['auto', 'manual'].includes(patch.invocationMode)) target.invocationMode = patch.invocationMode;
      return { id, enabled: target.enabled !== false, invocationMode: target.invocationMode || 'auto' };
    });
  }
}
