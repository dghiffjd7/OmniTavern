import { logger } from '../utils/logger.js';
import { normalizeScopeId } from '../storage/store-scope.js';
import { RpSessionStore } from '../storage/rp-session-store.js';
import { parseCharacterCardFile } from '../utils/character-card.js';
import { avatarDataUrlFromFile, compressImageDataUrl } from '../utils/image.js';
import { safeInvoke } from '../utils/tauri.js';
import { appSettings } from '../storage/app-settings.js';
import { t } from '../i18n/index.js';
import { appChoice, appConfirm } from './app-confirm.js';
import { IMPORT_NAME_CONFLICT_DECISIONS } from './import-name-conflict-utils.js';
import { bindBackdropActivation } from './backdrop-activation-utils.js';
import { createCharacterCardImportService } from '../import/character-card-import-service.js';
import { writeImportedMvuConversion } from '../import/mvu-session-write-utils.js';
import { buildScriptAuthorizationMessage } from './script-authorization-utils.js';
import { getPresetStore } from './preset-store-runtime-utils.js';
import { createRegexStoreRuntimeAdapter } from './regex-store-runtime-utils.js';
import { allowScriptOnce, getScriptRuntime, waitForScriptStoreReady } from './script-runtime-utils.js';
import { hasStoredWorldInfo, waitForWorldStoreReady } from './world-store-runtime-utils.js';
import { emitWorldInfoChanged } from './world-session-runtime-utils.js';

const promptImportOptions = ({ displayName, fileName, worldCount, greetingCount, regexCount, scriptCount, allowSystemPrompt } = {}) =>
  new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 22050;
      background: rgba(0,0,0,0.38); display: flex; align-items: center; justify-content: center;
      padding: 16px;
    `;
    const panel = document.createElement('div');
    panel.style.cssText = `
      width: min(92vw, 420px); background: var(--app-surface-card); border-radius: 14px; overflow: hidden;
      box-shadow: 0 12px 40px rgba(0,0,0,0.2); display:flex; flex-direction:column;
    `;
    const titleText = displayName ? `导入角色卡：${displayName}` : '导入角色卡';
    const fileText = fileName ? `文件：${fileName}` : '';
    panel.innerHTML = `
      <div style="padding:14px 16px; border-bottom:1px solid var(--app-border-default); background:var(--app-surface-subtle);">
        <div data-cc-import-title style="font-weight:800; font-size:15px;"></div>
        <div data-cc-import-file style="margin-top:4px; font-size:12px; color:var(--app-text-muted);"></div>
      </div>
      <div style="padding:14px 16px; display:flex; flex-direction:column; gap:10px; font-size:13px;">
        <div style="font-weight:700; color:var(--app-text-primary);">导入选项</div>
        <label style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" id="cc-opt-world" ${worldCount ? 'checked' : ''} ${worldCount ? '' : 'disabled'}>
          <span>导入世界书（${worldCount} 条）</span>
        </label>
        <label style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" id="cc-opt-greeting" ${greetingCount ? 'checked' : ''} ${greetingCount ? '' : 'disabled'}>
          <span>导入开场白（${greetingCount} 条）</span>
        </label>
        <label style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" id="cc-opt-system" ${allowSystemPrompt ? '' : 'disabled'}>
          <span>导入系统提示词为预设${allowSystemPrompt ? '' : '（无）'}</span>
        </label>
        <label style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" id="cc-opt-regex" ${regexCount ? 'checked' : ''} ${regexCount ? '' : 'disabled'}>
          <span>导入正则脚本（${regexCount} 条）</span>
        </label>
        <label style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" id="cc-opt-script" ${scriptCount ? '' : 'disabled'}>
          <span>导入脚本（${scriptCount} 条）</span>
        </label>
      </div>
      <div style="display:flex; gap:8px; justify-content:flex-end; padding:12px 16px; border-top:1px solid var(--app-border-default); background:var(--app-surface-card);">
        <button id="cc-opt-cancel" style="border:1px solid var(--app-border-default); background:var(--app-surface-card); border-radius:10px; padding:8px 12px;">取消</button>
        <button id="cc-opt-confirm" style="border:none; background:var(--app-text-primary); color:var(--app-text-inverse); border-radius:10px; padding:8px 14px;">导入</button>
      </div>
    `;
    // 卡片元数据与文件名是外部文本，不能进入 HTML 模板。
    panel.querySelector('[data-cc-import-title]').textContent = titleText;
    const fileEl = panel.querySelector('[data-cc-import-file]');
    fileEl.textContent = fileText;
    fileEl.hidden = !fileText;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      unbindBackdropActivation();
      overlay.remove();
      resolve(result);
    };
    const unbindBackdropActivation = bindBackdropActivation(overlay, {
      onActivate: () => cleanup(null),
    });
    const worldEl = panel.querySelector('#cc-opt-world');
    const greetEl = panel.querySelector('#cc-opt-greeting');
    const sysEl = panel.querySelector('#cc-opt-system');
    const regexEl = panel.querySelector('#cc-opt-regex');
    const scriptEl = panel.querySelector('#cc-opt-script');
    panel.querySelector('#cc-opt-cancel')?.addEventListener('click', () => cleanup(null));
    panel.querySelector('#cc-opt-confirm')?.addEventListener('click', () => {
      cleanup({
        importWorld: Boolean(worldEl?.checked),
        importGreetings: Boolean(greetEl?.checked),
        importSystemPrompt: Boolean(sysEl?.checked),
        importRegex: Boolean(regexEl?.checked),
        importScripts: Boolean(scriptEl?.checked),
      });
    });
  });

export class CharacterCardImporter {
  constructor({
    personaStore,
    appBridge,
    presetStore = null,
    rpSessionStore,
    onPersonaChanged,
    onGreetingsImported,
    getPersonaScopeKey = null,
    deletePersona = null,
    chatStore = null,
    assetWriter = null,
  } = {}) {
    this.personaStore = personaStore || null;
    this.appBridge = appBridge || window.appBridge;
    this.presetStore = presetStore || getPresetStore(this.appBridge);
    this.regexStore = createRegexStoreRuntimeAdapter(this.appBridge);
    this.rpSessionStore = rpSessionStore || null;
    this.chatStore = chatStore || null;
    this.onPersonaChanged = onPersonaChanged;
    this.onGreetingsImported = onGreetingsImported;
    this.getPersonaScopeKey = typeof getPersonaScopeKey === 'function' ? getPersonaScopeKey : (id => normalizeScopeId(id));
    this.deletePersona = typeof deletePersona === 'function' ? deletePersona : null;
    this.service = createCharacterCardImportService({
      personaStore: this.personaStore,
      activatePersona: async (id) => {
        await this.personaStore.setActive(id);
        await Promise.resolve(this.onPersonaChanged?.());
      },
      savePersonaCard: async (id, rawCard) => {
        if (this.appBridge?.savePersonaCard) return Boolean((await this.appBridge.savePersonaCard(id, rawCard))?.path);
        await safeInvoke('save_persona_card', { id, data: rawCard });
        return true;
      },
      writeGreetings: (id, greetings, options) => this.writeGreetingsForPersona(id, greetings, options),
      waitForWorldReady: () => waitForWorldStoreReady(this.appBridge),
      worldExists: id => hasStoredWorldInfo(this.appBridge, id),
      saveWorldInfo: (id, payload) => this.appBridge?.saveWorldInfo?.(id, payload),
      deleteWorld: async (id) => {
        const result = await this.appBridge?.deleteWorldInfo?.(id);
        if (result?.ok === false) throw new Error('worldbook_delete_refused');
      },
      writeMvu: (id, conversion) => {
        if (!this.chatStore) return false;
        writeImportedMvuConversion({ chatStore: this.chatStore, sessionId: `rp:${id}`, conversion });
        return true;
      },
      upsertSystemPreset: async (payload) => {
        if (this.presetStore?.ready) await this.presetStore.ready;
        return this.presetStore?.upsert ? this.presetStore.upsert('sysprompt', payload) : '';
      },
      removeSystemPreset: id => this.presetStore?.remove?.('sysprompt', id),
      upsertRegexSet: async (set) => {
        if (this.regexStore?.ready) await this.regexStore.ready;
        return this.regexStore?.upsertLocalSet ? this.regexStore.upsertLocalSet(set) : '';
      },
      removeRegexSet: id => this.regexStore?.removeLocalSet?.(id),
      importScripts: async args => (await waitForScriptStoreReady(this.appBridge))?.importTavernHelperScripts?.(args),
      removeScripts: async (id) => {
        const scriptStore = await waitForScriptStoreReady(this.appBridge);
        if (typeof scriptStore?.removeScope === 'function') await scriptStore.removeScope('character', id);
        else await scriptStore?.setScripts?.('character', id, []);
      },
      deletePersona: async (id) => {
        if (this.deletePersona) return this.deletePersona(id);
        return this.personaStore?.delete?.(id);
      },
      onWorldInfoChanged: worldId => emitWorldInfoChanged(this.appBridge, { roleWorldChanged: Boolean(worldId) }),
      // CCv3 资源：表情贴图包、会话背景、原始 .charx（未注入写入器时跳过）
      ...(assetWriter ? {
        createExpressionPack: args => assetWriter.createExpressionPack(args),
        removeExpressionPack: created => assetWriter.removeExpressionPack(created),
        setRoleBackground: args => assetWriter.setRoleBackground(args),
        restoreRoleBackground: created => assetWriter.restoreRoleBackground(created),
        saveOriginalCharx: (id, bytes) => assetWriter.saveOriginalCharx(id, bytes),
      } : {}),
    });
  }

  // 开场白存在角色卡自己的创意写作会话作用域：当前卡（或作用域与当前相同）写入当前存储；
  // 未切换到的新卡写入它自己的作用域，不碰正在使用的卡
  async writeGreetingsForPersona(personaId, greetings, options = {}) {
    const scopeId = normalizeScopeId(this.getPersonaScopeKey(personaId));
    const isActive = String(this.personaStore?.getActive?.()?.id || '') === String(personaId || '');
    if (this.rpSessionStore && (isActive || normalizeScopeId(this.rpSessionStore.scopeId) === scopeId)) {
      await this.rpSessionStore.ready;
      this.rpSessionStore.setGreetings(greetings, options);
      return;
    }
    const store = new RpSessionStore({ scopeId });
    await store.ready;
    store.setGreetings(greetings, options);
    await store.whenPersisted();
  }

  async importFromUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) throw new Error('链接为空');
    let response;
    try {
      response = await fetch(raw, { credentials: 'omit' });
    } catch (err) {
      throw new Error('链接加载失败');
    }
    if (!response?.ok) {
      throw new Error(`链接加载失败（${response?.status || 'unknown'}）`);
    }
    const blob = await response.blob();
    const mime = String(blob?.type || '').toLowerCase();
    let fileName = '';
    try {
      const parsed = new URL(raw);
      const base = parsed.pathname.split('/').pop() || '';
      fileName = base;
    } catch {}
    if (!fileName) {
      if (mime.includes('json')) fileName = 'card.json';
      else if (mime.includes('png')) fileName = 'card.png';
      else fileName = 'card';
    }
    if (!/\.[a-z0-9]+$/i.test(fileName)) {
      if (mime.includes('json')) fileName += '.json';
      else if (mime.includes('png')) fileName += '.png';
    }
    const file = new File([blob], fileName, { type: blob?.type || 'application/octet-stream' });
    return this.importFromFile(file);
  }

  async readCardFile(file) {
    const parsed = await parseCharacterCardFile(file);
    const fileName = String(file?.name || '').trim();
    let avatarDataUrl = parsed.avatarDataUrl || '';
    if (file && avatarDataUrl) {
      try {
        // .charx 的头像来自包内 icon 资源（data URL），同样压到头像尺寸
        avatarDataUrl = /\.charx$/i.test(fileName)
          ? await compressImageDataUrl(avatarDataUrl, { maxDim: 256, quality: 0.84, maxBytes: 420_000, mime: 'image/webp' })
          : await avatarDataUrlFromFile(file, { maxDim: 256, quality: 0.84, maxBytes: 420_000 });
      } catch {}
    }
    return { card: parsed.card, raw: parsed.raw, fileName, avatarDataUrl, assets: parsed.assets || null, charxBytes: parsed.charxBytes || null };
  }

  async importFromFile(file) {
    const { card, ...rest } = await this.readCardFile(file);
    return this.importCard(card, rest);
  }

  // 女仆导入：只解析并生成计划（不弹窗、不写入），提交由 service.commit 完成
  async planFromFile(file) {
    const parsed = await this.readCardFile(file);
    if (!this.personaStore) throw new Error('PersonaStore 未就绪');
    return this.service.plan(parsed);
  }

  async importCard(card, { avatarDataUrl = '', raw = null, fileName = '', assets = null, charxBytes = null } = {}) {
    if (!card) throw new Error('角色卡解析失败');
    if (!this.personaStore) throw new Error('PersonaStore 未就绪');
    const planned = await this.service.plan({ card, raw, fileName, avatarDataUrl, assets, charxBytes });
    const { displayName } = planned;
    if (planned.nameConflict) {
      const decision = await appChoice({
        title: '同名角色已存在',
        message: `已有角色「${displayName}」。继续导入会新建一个同名角色（现有角色及其会话保持不变，不会被覆盖）。`,
        actions: [
          { id: IMPORT_NAME_CONFLICT_DECISIONS.cancel, label: '取消导入', primary: true },
          { id: IMPORT_NAME_CONFLICT_DECISIONS.keepBoth, label: '仍然新建' },
        ],
        defaultActionId: IMPORT_NAME_CONFLICT_DECISIONS.cancel,
      });
      if (decision !== IMPORT_NAME_CONFLICT_DECISIONS.keepBoth) return false;
    }
    // CCv3：有暂不支持的内容时先说明并确认，取消则不写入任何数据
    const dropped = planned.v3 ? [
      planned.v3.groupOnlyGreetings ? t('群聊专用开场白 {count} 个', { count: planned.v3.groupOnlyGreetings }) : '',
      planned.v3.droppedAssets ? t('其他资源 {count} 个（远程、音频等）', { count: planned.v3.droppedAssets }) : '',
    ].filter(Boolean) : [];
    const extras = [
      planned.counts.expressions ? t('表情 {count} 张（作为该角色的表情贴图包）', { count: planned.counts.expressions }) : '',
      planned.counts.backgrounds ? t('背景 1 张（设为该角色创意写作的聊天背景）') : '',
    ].filter(Boolean);
    if (dropped.length || extras.length) {
      const proceed = await appConfirm({
        title: '检测到 CCv3 角色卡',
        message: [
          extras.length ? t('除角色资料、开场白、世界书等公共内容外，还会导入：{items}。', { items: extras.join(t('、')) }) : '',
          dropped.length ? t('以下内容暂不导入：{items}。', { items: dropped.join(t('、')) }) : '',
          t('原始卡片数据会完整保存。是否继续？'),
        ].filter(Boolean).join('\n'),
        confirmText: '继续导入',
        cancelText: '取消',
      });
      if (!proceed) return false;
    }
    const options = await promptImportOptions({
      displayName,
      fileName,
      worldCount: planned.counts.worldEntries,
      greetingCount: planned.counts.greetings,
      regexCount: planned.counts.regexRules,
      scriptCount: planned.counts.scripts,
      allowSystemPrompt: planned.hasSystemPrompt,
    });
    if (!options) return false;

    // 尝试多种方式提取 MVU 变量定义：TavernHelper Zod Schema 提供精确类型；角色卡 stat_data 补充真实初值与缺失变量
    let convertMvu = false;
    const mvuVariableCount = planned.counts.mvuVariables;
    if (mvuVariableCount > 0) {
      const sourceText = planned.mvu.source === 'zod_script' ? '（来自脚本 Schema）' : '（来自角色卡数据）';
      const choice = await appChoice({
        title: '检测到 MVU 变量卡',
        message: `发现 ${mvuVariableCount} 个变量${sourceText}。\n是否转换为原生变量系统并写入创意写作会话？`,
        actions: [
          { id: 'convert', label: '转换', primary: true },
          { id: 'skip', label: '跳过' },
        ],
        defaultActionId: 'convert',
      });
      convertMvu = choice === 'convert';
    }

    const result = await this.service.commit(planned, {
      include: {
        worldbook: options.importWorld,
        greetings: options.importGreetings,
        regex: options.importRegex,
        scripts: options.importScripts,
        system_prompt: options.importSystemPrompt,
        mvu: convertMvu,
      },
      activate: true,
    });
    if (!result.ok) {
      window.toastr?.error?.(`角色卡导入失败，已撤销本次导入：${result.errorMessage || result.step}`);
      return false;
    }
    if (result.mvuConverted) window.toastr?.success?.('MVU 变量已转换到创意写作会话');
    if (result.systemPresetId) window.toastr?.success?.('系统提示词已导入为预设');
    if (result.regexSetId) window.toastr?.success?.('正则脚本已导入');
    if (result.scripts?.count) await this.handleImportedScripts(result.personaId, result.scripts);

    try {
      const scopeId = normalizeScopeId(this.appBridge?.scopeId || '');
      logger.info(`[character-card] imported persona=${result.personaId} scope=${scopeId} world=${result.worldbookId || 'none'}`);
    } catch {}

    if (result.greetingCount > 0) {
      try {
        await Promise.resolve(this.onGreetingsImported?.({
          personaId: result.personaId,
          greetingCount: result.greetingCount,
        }));
      } catch (err) {
        logger.warn('refresh imported rp greetings failed', err);
      }
    }

    window.toastr?.success?.('角色卡导入完成（已切换角色卡）');
    return true;
  }

  // 手动导入：卡内脚本导入后询问授权（允许并启用／仅本次／拒绝）
  async handleImportedScripts(personaId, result) {
    try {
      const scriptStore = await waitForScriptStoreReady(this.appBridge);
      const persona = { id: personaId };
      if (result?.count) {
        const settings = appSettings.get();
        const ids = Array.isArray(result.ids) ? result.ids : [];
        const runnableIds = Array.isArray(result.runnableIds) ? result.runnableIds : ids;
        const compatibility = result.compatibility && typeof result.compatibility === 'object'
          ? result.compatibility
          : null;
        const authorizationMessage = buildScriptAuthorizationMessage({
          leadText: `检测到 ${result.count} 条脚本。`,
          settings,
          compatibility,
        });
        if (runnableIds.length) {
          const choice = await appChoice({
            title: '脚本授权',
            message: authorizationMessage,
            actions: [
              { id: 'allow', label: '允许并启用', primary: true },
              { id: 'once', label: '仅本次允许' },
              { id: 'deny', label: '拒绝', variant: 'danger' },
            ],
            defaultActionId: 'allow',
          });
          if (choice === 'allow') {
            if (settings.scriptEnabled !== true) appSettings.update({ scriptEnabled: true });
            await Promise.all(runnableIds.map((id) => scriptStore.toggleScript('character', persona.id, id, true)));
          } else if (choice === 'once') {
            const sid = this.chatStore?.getCurrent?.() || '';
            const scriptRuntime = getScriptRuntime(this.appBridge);
            if (sid && scriptRuntime?.allowOnce) {
              allowScriptOnce(this.appBridge, sid, runnableIds);
            } else {
              window.toastr?.info?.('当前未打开会话，脚本已导入但未启用');
            }
          }
        } else {
          await appChoice({
            title: '脚本兼容性提示',
            message: authorizationMessage,
            actions: [{ id: 'ok', label: '知道了', primary: true }],
            defaultActionId: 'ok',
          });
        }
        const blockedCount = Math.max(0, Number(compatibility?.blockedCount) || 0);
        if (blockedCount > 0) {
          window.toastr?.warning?.(`脚本已导入；${blockedCount} 条外部扩展加载器已保持禁用`);
        } else {
          window.toastr?.success?.('脚本已导入');
        }
      }
    } catch (err) {
      logger.warn('import tavern helper scripts failed', err);
    }
  }
}
