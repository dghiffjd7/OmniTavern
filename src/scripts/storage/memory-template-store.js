import { safeInvoke } from '../utils/tauri.js';
import { logger } from '../utils/logger.js';
import { DEFAULT_MEMORY_TEMPLATE } from '../memory/default-template.js';
import {
  canonicalizeOfficialMemoryTemplateRecord,
  localizeOfficialMemoryTemplateRecord,
} from '../memory/memory-template-locale.js';

const initDatabase = async (scopeId = '') => {
  try {
    await safeInvoke('init_database', { scopeId });
    return true;
  } catch (err) {
    logger.debug('memory template db init skipped (tauri not ready?)', err);
    return false;
  }
};

const buildTemplateInput = (template, { isDefault = false, isBuiltin = false } = {}) => {
  const meta = template?.meta || {};
  const schema = {
    meta: {
      id: meta.id,
      name: meta.name,
      version: meta.version,
      author: meta.author,
      description: meta.description,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
    },
    tables: Array.isArray(template?.tables) ? template.tables : [],
  };
  return {
    id: String(meta.id || ''),
    name: String(meta.name || ''),
    author: meta.author ? String(meta.author) : null,
    version: meta.version ? String(meta.version) : null,
    description: meta.description ? String(meta.description) : null,
    schema,
    injection: template?.injection || null,
    is_default: Boolean(isDefault),
    is_builtin: Boolean(isBuiltin),
  };
};

const buildTemplateInputFromRecord = (record, overrides = {}) => {
  const schema = record?.schema && typeof record.schema === 'object' ? record.schema : {};
  return {
    id: String(record?.id || ''),
    name: String(record?.name || ''),
    author: record?.author ? String(record.author) : null,
    version: record?.version ? String(record.version) : null,
    description: record?.description ? String(record.description) : null,
    schema,
    injection: record?.injection ?? null,
    is_default: Object.prototype.hasOwnProperty.call(overrides, 'isDefault')
      ? Boolean(overrides.isDefault)
      : Boolean(record?.is_default),
    is_builtin: Object.prototype.hasOwnProperty.call(overrides, 'isBuiltin')
      ? Boolean(overrides.isBuiltin)
      : Boolean(record?.is_builtin),
  };
};

const buildTemplateDefinitionFromRecord = (record) => {
  const schema = record?.schema && typeof record.schema === 'object' ? record.schema : {};
  return {
    ...schema,
    injection: record?.injection ?? null,
  };
};

const parseVersionParts = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return [];
  return raw.split('.').map(part => {
    const num = Number.parseInt(part, 10);
    return Number.isFinite(num) ? num : 0;
  });
};

const isNewerVersion = (next, current) => {
  const a = parseVersionParts(next);
  const b = parseVersionParts(current);
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
};

export class MemoryTemplateStore {
  constructor({ scopeId = '' } = {}) {
    this.scopeId = String(scopeId || '').trim();
    this.ready = null;
    this.readyOk = null;
    this.lastError = null;
    this.writePending = 0;
    this.lastCommand = null;
    this.lastCommandAt = null;
    this.lastCommandDoneAt = null;
    this.lastCommandError = null;
    this.queueResetAt = null;
    this.queueResetReason = null;
    this.queueResetCount = 0;
    this.initReady(this.scopeId);
    this.writeChain = Promise.resolve();
  }

  initReady(scopeId) {
    this.readyOk = null;
    this.ready = initDatabase(scopeId).then(ok => {
      this.readyOk = ok;
      return ok;
    });
    return this.ready;
  }

  async ensureReady() {
    await this.ready;
  }

  async setScope(scopeId = '') {
    const next = String(scopeId || '').trim();
    if (next === this.scopeId) return this.ready;
    this.scopeId = next;
    this.lastError = null;
    this.initReady(this.scopeId);
    this.writeChain = Promise.resolve();
    return this.ready;
  }

  queueWrite(task) {
    this.resetWriteChainIfStuck();
    const run = this.writeChain.then(async () => {
      this.writePending += 1;
      try {
        return await task();
      } finally {
        this.writePending = Math.max(0, this.writePending - 1);
      }
    });
    this.writeChain = run.catch(() => {});
    return run;
  }

  resetWriteChainIfStuck({ timeoutMs = 5000 } = {}) {
    if (!this.lastCommandAt || this.lastCommandDoneAt) return false;
    const now = Date.now();
    const age = now - this.lastCommandAt;
    if (age < timeoutMs) return false;
    this.lastCommandDoneAt = now;
    this.lastCommandError = `timeout after ${age}ms`;
    this.lastError = new Error(this.lastCommandError);
    this.writeChain = Promise.resolve();
    this.writePending = 0;
    this.queueResetAt = now;
    this.queueResetReason = this.lastCommandError;
    this.queueResetCount += 1;
    return true;
  }

  async invokeCommand(cmd, args) {
    this.lastCommand = cmd;
    this.lastCommandAt = Date.now();
    this.lastCommandDoneAt = null;
    this.lastCommandError = null;
    try {
      const result = await safeInvoke(cmd, args);
      this.lastCommandDoneAt = Date.now();
      return result;
    } catch (err) {
      this.lastCommandDoneAt = Date.now();
      this.lastCommandError = err ? String(err?.message || err) : 'unknown error';
      this.lastError = err;
      throw err;
    }
  }

  async saveTemplate(input) {
    return this.queueWrite(() => this.saveTemplateRaw(input));
  }

  async saveTemplateRaw(input) {
    await this.ensureReady();
    const canonicalInput = canonicalizeOfficialMemoryTemplateRecord(input);
    return this.invokeCommand('save_template', { scopeId: this.scopeId, input: canonicalInput });
  }

  async saveTemplateDefinition(template, { isDefault = false, isBuiltin = false } = {}) {
    return this.queueWrite(() => this.saveTemplateDefinitionRaw(template, { isDefault, isBuiltin }));
  }

  async saveTemplateDefinitionRaw(template, { isDefault = false, isBuiltin = false } = {}) {
    await this.ensureReady();
    const input = buildTemplateInput(template, { isDefault, isBuiltin });
    if (!input.id || !input.name) throw new Error('template id or name missing');
    return this.saveTemplateRaw(input);
  }

  async getTemplates(query = {}) {
    await this.ensureReady();
    const records = await this.invokeCommand('get_templates', { scopeId: this.scopeId, query });
    return Array.isArray(records)
      ? records.map(record => localizeOfficialMemoryTemplateRecord(record))
      : records;
  }

  async getTemplateById(id) {
    const list = await this.getTemplates({ id });
    return Array.isArray(list) && list.length ? list[0] : null;
  }

  async updateTemplateInjection(id, injection = {}) {
    return this.queueWrite(async () => {
      await this.ensureReady();
      const record = await this.getTemplateById(id);
      if (!record) throw new Error('template not found');
      const input = buildTemplateInputFromRecord(record, { isDefault: record?.is_default, isBuiltin: record?.is_builtin });
      input.injection = injection || null;
      // Already inside queueWrite; re-queueing would wait on this same task.
      return this.saveTemplateRaw(input);
    });
  }

  async deleteTemplate(id) {
    return this.queueWrite(async () => {
      await this.ensureReady();
      return this.invokeCommand('delete_template', { scopeId: this.scopeId, id });
    });
  }

  toTemplateDefinition(record) {
    return buildTemplateDefinitionFromRecord(record);
  }

  async setDefaultTemplate(id) {
    return this.queueWrite(async () => {
      await this.ensureReady();
      const list = await this.getTemplates({});
      if (!Array.isArray(list) || !list.length) return false;
      for (const record of list) {
        const isDefault = String(record?.id || '') === String(id || '');
        const input = buildTemplateInputFromRecord(record, { isDefault });
        if (!input.id || !input.name) continue;
        await this.saveTemplateRaw(input);
      }
      return true;
    });
  }

  async ensureDefaultTemplate(template = DEFAULT_MEMORY_TEMPLATE) {
    return this.queueWrite(async () => {
      const templateId = String(template?.meta?.id || '').trim();
      if (!templateId) return false;
      try {
        const existing = await this.getTemplateById(templateId);
        if (existing) {
          const meta = template?.meta || {};
          const existingMeta = existing?.schema && typeof existing.schema === 'object' ? existing.schema.meta || {} : {};
          const existingName = String(existing?.name || existingMeta?.name || '').trim();
          const existingAuthor = String(existing?.author || existingMeta?.author || '').trim();
          const templateName = String(meta?.name || '').trim();
          const templateAuthor = String(meta?.author || '').trim();
          const nameMatches = !existingName || !templateName || existingName === templateName;
          const authorMatches = !existingAuthor || existingAuthor === templateAuthor;
          const existingVersion = String(existing?.version || existingMeta?.version || '').trim();
          const templateVersion = String(meta?.version || '').trim();
          const versionUpgrade = templateVersion && (!existingVersion || isNewerVersion(templateVersion, existingVersion));
          const shouldOverwrite = Boolean(existing.is_builtin) || (nameMatches && authorMatches && versionUpgrade);
          if (shouldOverwrite) {
            await this.saveTemplateDefinitionRaw(template, { isDefault: existing.is_default, isBuiltin: true });
            return true;
          }
          return false;
        }
        await this.saveTemplateDefinitionRaw(template, { isDefault: true, isBuiltin: true });
        return true;
      } catch (err) {
        this.lastError = err;
        logger.warn('ensure default template failed', err);
        return false;
      }
    });
  }

  async forceDefaultTemplate(template = DEFAULT_MEMORY_TEMPLATE) {
    return this.queueWrite(async () => {
      const templateId = String(template?.meta?.id || '').trim();
      if (!templateId) return false;
      try {
        await this.saveTemplateDefinitionRaw(template, { isDefault: true, isBuiltin: true });
        return true;
      } catch (err) {
        this.lastError = err;
        logger.warn('force default template failed', err);
        return false;
      }
    });
  }

  getDebugInfo() {
    const meta = DEFAULT_MEMORY_TEMPLATE?.meta || {};
    const now = Date.now();
    const lastCommandAgeMs = this.lastCommandAt ? Math.max(0, now - this.lastCommandAt) : null;
    const lastCommandPending = Boolean(this.lastCommandAt && !this.lastCommandDoneAt);
    return {
      scopeId: this.scopeId,
      readyOk: this.readyOk,
      lastError: this.lastError ? String(this.lastError?.message || this.lastError) : null,
      writePending: this.writePending,
      lastCommand: this.lastCommand,
      lastCommandAgeMs,
      lastCommandPending,
      lastCommandError: this.lastCommandError,
      queueResetAt: this.queueResetAt,
      queueResetReason: this.queueResetReason,
      queueResetCount: this.queueResetCount,
      defaultTemplateId: meta.id || null,
      defaultTemplateName: meta.name || null,
      defaultTemplateVersion: meta.version || null,
      defaultTemplateAuthor: meta.author || null,
    };
  }

}
