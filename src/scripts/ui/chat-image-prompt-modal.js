import { ImagePromptEditor } from './image-prompt/image-prompt-editor.js';
import { IMAGE_PROMPT_TEXT_KEYS } from './image-prompt/image-prompt-utils.js';
import { resolveImageGenerationParamSchema, getImageGenerationSizeError, syncImageGenerationOutputControls } from './image-generation-params-utils.js';
import { validateImageGenerationSizeControls } from './image-generation-size-control.js';
import { resolveImageReferenceCapability } from './media-generation-service.js';
import { bindBackdropActivation } from './backdrop-activation-utils.js';
import { normalizeAdvancedNumber, renderImageGenerationAdvancedFields } from './image-generation-advanced-fields.js';

// 图钉（固定到本聊天）
const PIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/></g></svg>';

export const createChatImagePromptModal = ({
  imagePromptRuntime,
  getImageTagConverter = () => null,
  pickFilesFromInput, getReferencePicker, readImageGenerationReferenceFiles, normalizeImageGenerationReferenceItems,
}) => {
    let modal = null;
    return () => {
      if (modal) return modal;
      const overlay = document.createElement('div');
      overlay.id = 'chat-image-gen-overlay';
      overlay.className = 'chat-image-gen-overlay';
      overlay.innerHTML = `
        <div class="chat-image-gen-modal has-prompt-editor" role="dialog" aria-modal="true" aria-labelledby="chat-image-gen-title">
          <div class="chat-image-gen-header">
            <div>
              <div id="chat-image-gen-title" class="chat-image-gen-title">生成图片</div>
              <div class="chat-image-gen-subtitle">使用当前图片模型生成并写入这个聊天室</div>
            </div>
            <button type="button" class="chat-image-gen-close" aria-label="关闭">×</button>
          </div>
          <div class="chat-image-gen-body">
            <div class="chat-image-prompt-editor"></div>
            <div class="chat-image-gen-pins" hidden>
              <div class="chat-image-gen-pins-head">
                <span class="chat-image-gen-pins-title">本聊天参考图</span>
                <label class="chat-image-gen-pins-use"><input type="checkbox" class="chat-image-gen-pins-toggle" checked><span>本次使用</span></label>
              </div>
              <div class="chat-image-gen-pins-list" aria-live="polite"></div>
              <div class="chat-image-gen-pins-hint"></div>
            </div>
            <div class="chat-image-gen-ref">
              <div class="chat-image-gen-ref-head">
                <button type="button" class="chat-image-gen-ref-add">添加参考图</button>
                <span class="chat-image-gen-ref-hint"></span>
              </div>
              <div class="chat-image-gen-ref-list" aria-live="polite"></div>
            </div>
            <div class="chat-image-gen-impact"></div>
            <div class="chat-image-gen-status"></div>
          </div>
          <div class="chat-image-gen-advanced" hidden>
            <div class="chat-image-gen-advanced-head">
              <button type="button" class="chat-image-gen-advanced-back">返回</button>
              <div>
                <div class="chat-image-gen-advanced-title has-help" data-help="仅用于本次生成" data-help-mode="tap">高级参数</div>
                </div>
            </div>
            <div class="chat-image-gen-advanced-summary"></div>
            <div class="chat-image-gen-advanced-fields"></div>
            <div class="chat-image-gen-advanced-actions">
              <button type="button" class="chat-image-gen-param-reset">清除本次覆盖</button>
              <button type="button" class="chat-image-gen-param-done">返回生成</button>
            </div>
          </div>
          <div class="chat-image-gen-footer">
            <button type="button" class="chat-image-gen-cancel">取消</button>
            <button type="button" class="chat-image-gen-advanced-open">高级参数</button>
            <button type="button" class="chat-image-gen-secondary" style="display:none;">插图素材</button>
            <button type="button" class="chat-image-gen-submit">生成图片</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const bodyEl = overlay.querySelector('.chat-image-gen-body');
      const footerEl = overlay.querySelector('.chat-image-gen-footer');
      const impactEl = overlay.querySelector('.chat-image-gen-impact');
      const statusEl = overlay.querySelector('.chat-image-gen-status');
      const closeBtn = overlay.querySelector('.chat-image-gen-close');
      const cancelBtn = overlay.querySelector('.chat-image-gen-cancel');
      const advancedBtn = overlay.querySelector('.chat-image-gen-advanced-open');
      const advancedPage = overlay.querySelector('.chat-image-gen-advanced');
      const advancedBackBtn = overlay.querySelector('.chat-image-gen-advanced-back');
      const advancedDoneBtn = overlay.querySelector('.chat-image-gen-param-done');
      const advancedResetBtn = overlay.querySelector('.chat-image-gen-param-reset');
      const advancedSummaryEl = overlay.querySelector('.chat-image-gen-advanced-summary');
      const advancedFieldsEl = overlay.querySelector('.chat-image-gen-advanced-fields');
      const secondaryBtn = overlay.querySelector('.chat-image-gen-secondary');
      const submitBtn = overlay.querySelector('.chat-image-gen-submit');
      const refAddBtn = overlay.querySelector('.chat-image-gen-ref-add');
      const refHintEl = overlay.querySelector('.chat-image-gen-ref-hint');
      const refListEl = overlay.querySelector('.chat-image-gen-ref-list');
      const pinsEl = overlay.querySelector('.chat-image-gen-pins');
      const pinsListEl = overlay.querySelector('.chat-image-gen-pins-list');
      const pinsHintEl = overlay.querySelector('.chat-image-gen-pins-hint');
      const pinsToggleEl = overlay.querySelector('.chat-image-gen-pins-toggle');
      let resolveOpen = null;
      // 本聊天参考图（固定在聊天上，这个聊天的生图都带上）：{ key, dataUrl, name }；pinHandlers 为 null 时不提供固定
      let pinnedReferences = [];
      let usePinnedReferences = true;
      let pinHandlers = null;
      let promptEditor = null;
      let openVersion = 0;
      let previousFocus = null;
      let secondaryHandler = null;
      let referenceImages = [];
      let referenceCapability = resolveImageReferenceCapability({});
      let referenceCapabilityLoader = null;
      let generationParamConfig = {};
      let generationParamSchema = resolveImageGenerationParamSchema({});
      let generationParamBase = {};
      let generationParamOverrides = {};
      let generationParamContextLoader = null;
      const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
      const isNegativePromptField = (field = {}) => IMAGE_PROMPT_TEXT_KEYS.includes(field?.key);
      // 数字照字段规则：整数字段取整，小数字段（例如 NAI 的 Guidance Rescale）保留小数
      const normalizeParamFieldValue = (field, value) => (field?.type === 'number'
        ? normalizeAdvancedNumber(field, value)
        : String(value ?? field?.defaultValue ?? ''));
      const getParamFieldValue = (field, params = {}) => normalizeParamFieldValue(
        field,
        hasOwn(params, field?.key) ? params[field.key] : field?.defaultValue,
      );
      const normalizeParamOverrides = (overrides = {}, schema = generationParamSchema) => {
        const next = {};
        if (!overrides || typeof overrides !== 'object') return next;
        (schema?.fields || []).forEach(field => {
          if (!field?.key || !hasOwn(overrides, field.key)) return;
          next[field.key] = normalizeParamFieldValue(field, overrides[field.key]);
        });
        return next;
      };
      const countGenerationParamOverrides = () => Object.keys(generationParamOverrides || {}).length;
      const syncReferenceCapability = () => {
        if (generationParamConfig?.provider) {
          referenceCapability = resolveImageReferenceCapability(generationParamConfig, { ...generationParamBase, ...generationParamOverrides });
        }
        renderReferences();
      };
      const updateAdvancedButton = () => {
        if (!advancedBtn) return;
        const count = countGenerationParamOverrides();
        advancedBtn.textContent = count ? `高级参数（${count}）` : '高级参数';
        advancedBtn.classList.toggle('has-overrides', count > 0);
      };
      const updateAdvancedSummary = () => {
        const modelLabel = [generationParamConfig?.provider, generationParamConfig?.model].filter(Boolean).join(' / ') || '未选择图片模型';
        if (!advancedSummaryEl) return;
        const count = countGenerationParamOverrides();
        advancedSummaryEl.innerHTML = '';
        const copy = document.createElement('div');
        copy.className = 'igp-adv-summary-copy';
        const title = document.createElement('strong');
        title.textContent = generationParamSchema?.title || '图片生成参数';
        const model = document.createElement('span');
        model.textContent = modelLabel;
        model.dataset.i18nSkip = '';
        copy.append(title, model);
        const pill = document.createElement('span');
        pill.className = `igp-adv-summary-pill${count ? ' is-active' : ''}`;
        pill.textContent = count ? `本次覆盖 ${count} 项` : '沿用参数预设';
        advancedSummaryEl.append(copy, pill);
      };
      const applyGenerationParamContext = (context = {}) => {
        generationParamConfig = context?.config && typeof context.config === 'object' ? context.config : {};
        generationParamSchema = context?.schema || resolveImageGenerationParamSchema(generationParamConfig);
        generationParamBase = context?.baseParams && typeof context.baseParams === 'object' ? context.baseParams : {};
        generationParamOverrides = normalizeParamOverrides(generationParamOverrides, generationParamSchema);
        promptEditor?.setConfig(generationParamConfig, { ...generationParamBase, ...generationParamOverrides });
        updateAdvancedButton();
        syncReferenceCapability();
      };
      const syncAdvancedOverridesFromFields = () => {
        if (!advancedFieldsEl) return;
        syncImageGenerationOutputControls(advancedFieldsEl);
        const next = {};
        (generationParamSchema?.fields || []).forEach(field => {
          if (isNegativePromptField(field)) return;
          const el = advancedFieldsEl.querySelector(`[data-param-key="${field.key}"]`);
          if (!el) return;
          const currentValue = normalizeParamFieldValue(field, el.value);
          const baseValue = getParamFieldValue(field, generationParamBase);
          if (String(currentValue) !== String(baseValue)) next[field.key] = currentValue;
        });
        generationParamOverrides = next;
        updateAdvancedButton();
        updateAdvancedSummary();
        promptEditor?.setConfig(generationParamConfig, { ...generationParamBase, ...generationParamOverrides });
        syncReferenceCapability();
      };
      let advancedUi = null;
      const renderAdvancedFields = () => {
        if (!advancedFieldsEl) return;
        updateAdvancedSummary();
        // 分组卡片＋按字段类型挑控件（image-generation-advanced-fields.js）；覆盖过的项目可单项恢复
        advancedUi = renderImageGenerationAdvancedFields({
          documentRef: document,
          container: advancedFieldsEl,
          fields: (generationParamSchema?.fields || []).filter(field => !isNegativePromptField(field)),
          values: { ...generationParamBase, ...generationParamOverrides },
          base: generationParamBase,
          onChange: () => {
            advancedUi?.refresh();
            syncAdvancedOverridesFromFields();
          },
        });
        syncImageGenerationOutputControls(advancedFieldsEl);
      };
      const modalEl = overlay.querySelector('.chat-image-gen-modal');
      const openAdvancedPage = () => {
        renderAdvancedFields();
        // 固定成生成页的高度，切换时对话框不跳动；参数多时在页内捲动
        const height = modalEl?.offsetHeight || 0;
        if (modalEl && height) {
          modalEl.style.height = `${height}px`;
          modalEl.classList.add('is-advanced');
        }
        if (bodyEl) bodyEl.hidden = true;
        if (footerEl) footerEl.hidden = true;
        if (advancedPage) advancedPage.hidden = false;
      };
      const closeAdvancedPage = () => {
        if (advancedPage) advancedPage.hidden = true;
        if (bodyEl) bodyEl.hidden = false;
        if (footerEl) footerEl.hidden = false;
        if (modalEl) {
          modalEl.style.height = '';
          modalEl.classList.remove('is-advanced');
        }
      };
      const refreshGenerationParamContext = async (event = null) => {
        if (event?.detail?.tab && event.detail.tab !== 'image') return;
        if (!overlay.classList.contains('is-active')) return;
        if (typeof generationParamContextLoader !== 'function') return;
        const version = openVersion;
        const nextContext = await generationParamContextLoader();
        if (version !== openVersion || !overlay.classList.contains('is-active')) return;
        applyGenerationParamContext(nextContext);
        if (advancedPage && !advancedPage.hidden) renderAdvancedFields();
      };
      const countUsedReferences = () => referenceImages.length + (usePinnedReferences ? pinnedReferences.length : 0);
      const renderPins = (max, supported) => {
        if (!pinsEl) return;
        pinsEl.hidden = !pinHandlers || !pinnedReferences.length;
        if (pinsEl.hidden) return;
        pinsEl.classList.toggle('is-off', !usePinnedReferences);
        if (pinsToggleEl) pinsToggleEl.checked = usePinnedReferences;
        pinsListEl.innerHTML = '';
        pinnedReferences.forEach((item) => {
          const wrap = document.createElement('div');
          wrap.className = 'chat-image-gen-ref-item is-pinned';
          const img = document.createElement('img');
          img.src = item.dataUrl;
          img.alt = item.name || '参考图';
          const unpin = document.createElement('button');
          unpin.type = 'button';
          unpin.className = 'chat-image-gen-ref-remove chat-image-gen-pin-remove';
          unpin.textContent = '×';
          unpin.title = '取消固定';
          unpin.setAttribute('aria-label', '取消固定');
          unpin.dataset.key = item.key;
          wrap.appendChild(img);
          wrap.appendChild(unpin);
          pinsListEl.appendChild(wrap);
        });
        if (pinsHintEl) {
          // 不支持时写具体原因（例如 NAI 要先打开「精准参考」），原因文字都已登记翻译
          pinsHintEl.textContent = !supported
            ? String(referenceCapability?.reason || '当前模型不支持参考图，这次不会带上')
            : (usePinnedReferences && countUsedReferences() > max
              ? `当前模型最多 ${max} 张，只会带上前 ${max} 张（本聊天参考图优先）`
              : '这个聊天之后的生图（含自动配图）都会带上');
        }
      };
      const renderReferences = () => {
        const max = Math.max(0, Math.trunc(Number(referenceCapability?.max || 0)));
        const supported = Boolean(referenceCapability?.supported && max > 0);
        renderPins(max, supported);
        const used = countUsedReferences();
        if (refAddBtn) {
          refAddBtn.disabled = !supported || used >= max;
          refAddBtn.textContent = supported ? `添加参考图 ${used}/${max}` : '不支持参考图';
          refAddBtn.title = supported ? `当前模型最多 ${max} 张，可用于角色、构图或风格参考` : String(referenceCapability?.reason || '当前图片模型不支持参考图');
        }
        if (refHintEl) {
          refHintEl.textContent = supported
            ? `当前模型最多 ${max} 张，可用于角色、构图或风格参考`
            : String(referenceCapability?.reason || '当前图片模型不支持参考图');
        }
        if (!refListEl) return;
        refListEl.innerHTML = '';
        referenceImages.forEach((item, idx) => {
          const wrap = document.createElement('div');
          wrap.className = 'chat-image-gen-ref-item';
          const img = document.createElement('img');
          img.src = item.dataUrl;
          img.alt = item.name || '参考图';
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'chat-image-gen-ref-remove';
          remove.textContent = '×';
          remove.dataset.index = String(idx);
          wrap.appendChild(img);
          wrap.appendChild(remove);
          // 固定到本聊天：这个聊天之后的生图都带上
          if (pinHandlers) {
            const pin = document.createElement('button');
            pin.type = 'button';
            pin.className = 'chat-image-gen-ref-pin';
            pin.innerHTML = PIN_ICON;
            pin.title = '固定到本聊天：之后的生图（含自动配图）都带上';
            pin.setAttribute('aria-label', '固定到本聊天');
            pin.dataset.index = String(idx);
            wrap.appendChild(pin);
          }
          refListEl.appendChild(wrap);
        });
      };
      const pinReference = async (idx) => {
        const item = referenceImages[idx];
        if (!item || !pinHandlers) return;
        const result = await pinHandlers.pin(item).catch(error => ({ ok: false, reason: error?.message }));
        if (!result?.ok) {
          statusEl.textContent = result?.reason === 'limit' ? '本聊天参考图已满，先取消固定一张' : '固定失败，请再试一次';
          return;
        }
        referenceImages.splice(referenceImages.indexOf(item), 1);
        const key = String(result.item.key || result.item.path || '');
        if (!pinnedReferences.some(pinned => pinned.key === key)) {
          pinnedReferences = [...pinnedReferences, { key, dataUrl: item.dataUrl, name: item.name || '' }];
        }
        usePinnedReferences = true;
        statusEl.textContent = '已固定到本聊天';
        renderReferences();
      };
      const unpinReference = async (key) => {
        if (!pinHandlers) return;
        const ok = await Promise.resolve(pinHandlers.unpin(key)).catch(() => false);
        if (!ok) { statusEl.textContent = '取消固定失败，请再试一次'; return; }
        pinnedReferences = pinnedReferences.filter(item => item.key !== key);
        statusEl.textContent = '';
        renderReferences();
      };
      const handleAddReferences = async () => {
        const max = Math.max(0, Math.trunc(Number(referenceCapability?.max || 0)));
        if (!referenceCapability?.supported || max <= 0) {
          statusEl.textContent = referenceCapability?.reason || '当前图片模型不支持参考图';
          return;
        }
        const remaining = max - countUsedReferences();
        if (remaining <= 0) {
          statusEl.textContent = `参考图最多 ${max} 张`;
          return;
        }
        const files = await pickFilesFromInput(getReferencePicker());
        if (!files.length) return;
        const refs = await readImageGenerationReferenceFiles(files, remaining);
        referenceImages = normalizeImageGenerationReferenceItems([...referenceImages, ...refs], { ...referenceCapability, max: referenceImages.length + remaining });
        statusEl.textContent = files.length > remaining ? `已按当前模型限制保留前 ${max} 张参考图` : '';
        renderReferences();
      };
      const refreshReferenceCapability = async (event = null) => {
        if (event?.detail?.tab && event.detail.tab !== 'image') return;
        if (!overlay.classList.contains('is-active')) return;
        if (typeof referenceCapabilityLoader !== 'function') return;
        const version = openVersion;
        const nextCapability = await referenceCapabilityLoader(generationParamOverrides);
        if (version !== openVersion || !overlay.classList.contains('is-active')) return;
        referenceCapability = nextCapability || resolveImageReferenceCapability({});
        renderReferences();
      };
      const close = (value = null) => {
        ++openVersion;
        promptEditor?.destroy(); promptEditor = null;
        overlay.classList.remove('is-active');
        closeAdvancedPage();
        statusEl.textContent = '';
        const resolve = resolveOpen;
        resolveOpen = null;
          referenceImages = [];
          pinnedReferences = [];
          usePinnedReferences = true;
          pinHandlers = null;
          generationParamOverrides = {};
          generationParamContextLoader = null;
          updateAdvancedButton();
        renderReferences();
        previousFocus?.focus?.();
        if (typeof resolve === 'function') resolve(value);
      };
      const submit = () => {
        if (referenceImages.length && (!referenceCapability?.supported || referenceImages.length > Number(referenceCapability.max || 0))) {
          statusEl.textContent = !referenceCapability?.supported
            ? '当前模型不支持这些参考图，请切换模型或移除参考图后再生成'
            : `参考图最多 ${referenceCapability.max} 张，请移除多余的参考图后再生成`;
          return;
        }
        if (generationParamSchema.fields.some(field => field.type === 'image-size' && getImageGenerationSizeError(getParamFieldValue(field, { ...generationParamBase, ...generationParamOverrides })))) {
          openAdvancedPage(); validateImageGenerationSizeControls(advancedFieldsEl); return;
        }
        if (!promptEditor || submitBtn.disabled) return;
        const compiled = promptEditor.compile();
        if (compiled.errors.length) { statusEl.textContent = compiled.errors[0]; promptEditor.setPreview('open'); return; }
        const promptDocument = promptEditor.getDocument();
        const value = compiled.prompt || compiled.characters.map(c => c.prompt).join(', ');
        close({
          prompt: value,
          referenceImages: referenceImages.map(item => ({ ...item })),
          usePinnedReferences: Boolean(usePinnedReferences && pinnedReferences.length),
          negativePrompt: compiled.negativePrompt,
          generationParamOverrides: { ...generationParamOverrides, imagePromptDocument: promptDocument },
        });
      };
      closeBtn?.addEventListener('click', () => close(null));
      cancelBtn?.addEventListener('click', () => close(null));
      advancedBtn?.addEventListener('click', () => openAdvancedPage());
      advancedBackBtn?.addEventListener('click', () => closeAdvancedPage());
      advancedDoneBtn?.addEventListener('click', () => closeAdvancedPage());
      advancedResetBtn?.addEventListener('click', () => {
        generationParamOverrides = {};
        renderAdvancedFields();
        updateAdvancedButton();
        syncReferenceCapability();
      });
      secondaryBtn?.addEventListener('click', () => {
        const handler = secondaryHandler;
        close(null);
        if (typeof handler === 'function') handler();
      });
      submitBtn?.addEventListener('click', submit);
      const unbindBackdrop = bindBackdropActivation(overlay, {
        documentLike: document,
        onActivate: () => close(null),
      });
      refAddBtn?.addEventListener('click', () => handleAddReferences());
      pinsListEl?.addEventListener('click', (event) => {
        const btn = event?.target?.closest ? event.target.closest('button.chat-image-gen-pin-remove') : null;
        if (btn) void unpinReference(String(btn.dataset.key || ''));
      });
      pinsToggleEl?.addEventListener('change', () => {
        usePinnedReferences = Boolean(pinsToggleEl.checked);
        statusEl.textContent = '';
        renderReferences();
      });
      refListEl?.addEventListener('click', (event) => {
        const pinBtn = event?.target?.closest ? event.target.closest('button.chat-image-gen-ref-pin') : null;
        if (pinBtn) {
          const idx = Number(pinBtn.dataset.index);
          if (Number.isFinite(idx)) void pinReference(idx);
          return;
        }
        const btn = event?.target?.closest ? event.target.closest('button.chat-image-gen-ref-remove') : null;
        if (!btn) return;
        const idx = Number(btn.dataset.index);
        if (!Number.isFinite(idx)) return;
        referenceImages.splice(idx, 1);
        statusEl.textContent = '';
        renderReferences();
      });
      overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(null); return; }
        if (event.key === 'Tab') {
          const controls = [...overlay.querySelectorAll('button,input,textarea,select,summary')].filter(el => !el.disabled && el.getClientRects().length);
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      });
      window.addEventListener('config-draft-changed', refreshReferenceCapability);
      window.addEventListener('config-profile-changed', refreshReferenceCapability);
      window.addEventListener('config-draft-changed', refreshGenerationParamContext);
      window.addEventListener('config-profile-changed', refreshGenerationParamContext);
      modal = {
        destroy: () => {
          close(null); unbindBackdrop();
          window.removeEventListener('config-draft-changed', refreshReferenceCapability);
          window.removeEventListener('config-profile-changed', refreshReferenceCapability);
          window.removeEventListener('config-draft-changed', refreshGenerationParamContext);
          window.removeEventListener('config-profile-changed', refreshGenerationParamContext);
          overlay.remove(); modal = null;
        },
        open: ({
          initialPrompt = '',
          initialNegativePrompt = '',
          title = '生成图片',
          subtitle = '使用当前图片模型生成并写入这个聊天室',
          impactText = '',
          submitText = '生成图片',
          secondaryText = '',
          onSecondary = null,
          referenceCapability: nextReferenceCapability = resolveImageReferenceCapability({}),
          referenceImages: initialReferenceImages = [],
          // 本聊天参考图：{ items: [{ key, dataUrl, name }], pin(item) → { ok, item }, unpin(key) → boolean }；不提供则不显示
          pinnedReferences: initialPinnedReferences = null,
          loadReferenceCapability = null,
          generationParamContext = {},
          generationParamOverrides: initialGenerationParamOverrides = {},
          loadGenerationParamContext = null,
        } = {}) => new Promise(resolve => {
          if (resolveOpen) close(null);
          const version = ++openVersion;
          previousFocus = document.activeElement;
          resolveOpen = resolve;
          secondaryHandler = typeof onSecondary === 'function' ? onSecondary : null;
          referenceCapabilityLoader = typeof loadReferenceCapability === 'function' ? loadReferenceCapability : null;
          generationParamContextLoader = typeof loadGenerationParamContext === 'function' ? loadGenerationParamContext : null;
          generationParamOverrides = initialGenerationParamOverrides && typeof initialGenerationParamOverrides === 'object'
            ? { ...initialGenerationParamOverrides }
            : {};
          applyGenerationParamContext(generationParamContext || {});
          referenceCapability = nextReferenceCapability || resolveImageReferenceCapability({});
          referenceImages = normalizeImageGenerationReferenceItems(initialReferenceImages, { supported: true, max: initialReferenceImages.length });
          pinHandlers = initialPinnedReferences && typeof initialPinnedReferences.pin === 'function' && typeof initialPinnedReferences.unpin === 'function'
            ? { pin: initialPinnedReferences.pin, unpin: initialPinnedReferences.unpin }
            : null;
          pinnedReferences = pinHandlers ? (initialPinnedReferences.items || []).filter(item => item?.key && item?.dataUrl).map(item => ({ ...item })) : [];
          usePinnedReferences = true;
          const titleEl = overlay.querySelector('.chat-image-gen-title');
          const subtitleEl = overlay.querySelector('.chat-image-gen-subtitle');
          if (titleEl) titleEl.textContent = title;
          if (subtitleEl) subtitleEl.textContent = subtitle;
          if (impactEl) {
            impactEl.textContent = String(impactText || '').trim();
            impactEl.hidden = !impactEl.textContent;
          }
          if (submitBtn) submitBtn.textContent = submitText;
          if (secondaryBtn) {
            secondaryBtn.textContent = secondaryText || '';
            secondaryBtn.style.display = secondaryText && secondaryHandler ? '' : 'none';
          }
          statusEl.textContent = '';
          closeAdvancedPage();
          syncReferenceCapability();
          updateAdvancedButton();
          overlay.classList.add('is-active');
          submitBtn.disabled = true;
          statusEl.textContent = '正在载入提示词…';
          void imagePromptRuntime.getDraft({
            prompt: initialPrompt, config: generationParamConfig,
            options: initialGenerationParamOverrides,
            ...(initialNegativePrompt ? { negativePrompt: initialNegativePrompt } : {}),
          }).then(async draft => {
            if (version !== openVersion) return;
            promptEditor = new ImagePromptEditor({ container: overlay.querySelector('.chat-image-prompt-editor'), document: draft,
              config: generationParamConfig, options: { ...generationParamBase, ...generationParamOverrides },
              getTagConverter: getImageTagConverter,
            });
            await promptEditor.ready;
            if (version !== openVersion) return;
            submitBtn.disabled = false; statusEl.textContent = ''; promptEditor.focusBlock('scene');
          }).catch(error => { if (version === openVersion) statusEl.textContent = error.message; });
        }),
      };
	      return modal;
	    };
	  };
