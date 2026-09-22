import { ImagePromptEditor } from './image-prompt/image-prompt-editor.js';
import { IMAGE_PROMPT_TEXT_KEYS } from './image-prompt/image-prompt-utils.js';
import { resolveImageGenerationParamSchema, getImageGenerationSizeError, syncImageGenerationOutputControls } from './image-generation-params-utils.js';
import { createImageGenerationSizeControl, validateImageGenerationSizeControls } from './image-generation-size-control.js';
import { resolveImageReferenceCapability } from './media-generation-service.js';
import { bindBackdropActivation } from './backdrop-activation-utils.js';

export const createChatImagePromptModal = ({
  imagePromptRuntime,
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
      let resolveOpen = null;
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
      const normalizeParamFieldValue = (field, value) => {
        if (field?.type === 'number') {
          const raw = Math.trunc(Number(value));
          if (!Number.isFinite(raw)) return Number(field?.defaultValue || 0);
          const min = Number.isFinite(Number(field?.min)) ? Number(field.min) : Number.MIN_SAFE_INTEGER;
          const max = Number.isFinite(Number(field?.max)) ? Number(field.max) : Number.MAX_SAFE_INTEGER;
          return Math.min(max, Math.max(min, raw));
        }
        return String(value ?? field?.defaultValue ?? '');
      };
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
      const updateAdvancedButton = () => {
        if (!advancedBtn) return;
        const count = countGenerationParamOverrides();
        advancedBtn.textContent = count ? `高级参数（${count}）` : '高级参数';
        advancedBtn.classList.toggle('has-overrides', count > 0);
      };
      const updateAdvancedSummary = () => {
        const modelLabel = [generationParamConfig?.provider, generationParamConfig?.model].filter(Boolean).join(' / ') || '未选择图片模型';
        if (advancedSummaryEl) {
          const count = countGenerationParamOverrides();
          advancedSummaryEl.textContent = `${generationParamSchema?.title || '图片生成参数'} · ${modelLabel}${count ? ` · 本次覆盖 ${count} 项` : ''}`;
        }
      };
      const applyGenerationParamContext = (context = {}) => {
        generationParamConfig = context?.config && typeof context.config === 'object' ? context.config : {};
        generationParamSchema = context?.schema || resolveImageGenerationParamSchema(generationParamConfig);
        generationParamBase = context?.baseParams && typeof context.baseParams === 'object' ? context.baseParams : {};
        generationParamOverrides = normalizeParamOverrides(generationParamOverrides, generationParamSchema);
        promptEditor?.setConfig(generationParamConfig, { ...generationParamBase, ...generationParamOverrides });
        updateAdvancedButton();
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
      };
      const renderAdvancedFields = () => {
        if (!advancedFieldsEl) return;
        updateAdvancedSummary();
        advancedFieldsEl.innerHTML = '';
        (generationParamSchema?.fields || []).forEach(field => {
          if (isNegativePromptField(field)) return;
          const label = document.createElement('label');
          label.className = 'chat-image-gen-param-row';
          const title = document.createElement('div');
          title.className = 'chat-image-gen-param-label';
          title.textContent = field.label || field.key;
          label.appendChild(title);
          if (field.type === 'image-size') {
            title.classList.add('has-help'); title.dataset.help = field.help; title.dataset.helpMode = 'tap';
            label.appendChild(createImageGenerationSizeControl({ field, value: getParamFieldValue(field, { ...generationParamBase, ...generationParamOverrides }), controlClass: 'chat-image-gen-param-field', onChange: syncAdvancedOverridesFromFields }));
            advancedFieldsEl.appendChild(label);
            return;
          }
          let control = null;
          if (field.type === 'select') {
            control = document.createElement('select');
            (field.options || []).forEach(opt => {
              const option = document.createElement('option');
              option.value = String(opt.value ?? '');
              option.textContent = String(opt.label || opt.value || '');
              control.appendChild(option);
            });
          } else {
            control = document.createElement('input');
            control.type = field.type === 'number' ? 'number' : 'text';
            if (field.type === 'number') {
              if (field.min != null) control.min = String(field.min);
              if (field.max != null) control.max = String(field.max);
              if (field.step != null) control.step = String(field.step);
            }
          }
          control.className = 'chat-image-gen-param-field';
          control.dataset.paramKey = field.key;
          control.value = String(getParamFieldValue(field, { ...generationParamBase, ...generationParamOverrides }));
          control.addEventListener('input', syncAdvancedOverridesFromFields);
          control.addEventListener('change', syncAdvancedOverridesFromFields);
          label.appendChild(control);
          if (field.help) {
            title.classList.add('has-help'); title.dataset.help = field.help; title.dataset.helpMode = 'tap';
          }
          advancedFieldsEl.appendChild(label);
        });
        syncImageGenerationOutputControls(advancedFieldsEl);
      };
      const openAdvancedPage = () => {
        renderAdvancedFields();
        if (bodyEl) bodyEl.hidden = true;
        if (footerEl) footerEl.hidden = true;
        if (advancedPage) advancedPage.hidden = false;
      };
      const closeAdvancedPage = () => {
        if (advancedPage) advancedPage.hidden = true;
        if (bodyEl) bodyEl.hidden = false;
        if (footerEl) footerEl.hidden = false;
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
      const renderReferences = () => {
        const max = Math.max(0, Math.trunc(Number(referenceCapability?.max || 0)));
        const supported = Boolean(referenceCapability?.supported && max > 0);
        if (refAddBtn) {
          refAddBtn.disabled = !supported || referenceImages.length >= max;
          refAddBtn.textContent = supported ? `添加参考图 ${referenceImages.length}/${max}` : '不支持参考图';
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
          refListEl.appendChild(wrap);
        });
      };
      const handleAddReferences = async () => {
        const max = Math.max(0, Math.trunc(Number(referenceCapability?.max || 0)));
        if (!referenceCapability?.supported || max <= 0) {
          statusEl.textContent = referenceCapability?.reason || '当前图片模型不支持参考图';
          return;
        }
        const remaining = max - referenceImages.length;
        if (remaining <= 0) {
          statusEl.textContent = `参考图最多 ${max} 张`;
          return;
        }
        const files = await pickFilesFromInput(getReferencePicker());
        if (!files.length) return;
        const refs = await readImageGenerationReferenceFiles(files, remaining);
        referenceImages = normalizeImageGenerationReferenceItems([...referenceImages, ...refs], referenceCapability);
        statusEl.textContent = files.length > remaining ? `已按当前模型限制保留前 ${max} 张参考图` : '';
        renderReferences();
      };
      const refreshReferenceCapability = async (event = null) => {
        if (event?.detail?.tab && event.detail.tab !== 'image') return;
        if (!overlay.classList.contains('is-active')) return;
        if (typeof referenceCapabilityLoader !== 'function') return;
        const version = openVersion;
        const nextCapability = await referenceCapabilityLoader();
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
      refListEl?.addEventListener('click', (event) => {
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
          renderReferences();
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
