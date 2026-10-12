// 会话设置面板（私聊 / 创意写作 / 群聊共用）的外框行为：
// 分区目录 + 滚动定位、未保存检测、关闭确认、Esc / Ctrl+S、按会话记住上次分区、开合动画。
// 面板自己的字段与业务逻辑留在各面板内，这里只管「外框」。
import { createGroupPanelMotionRuntime } from './group-panel-motion-runtime-utils.js';
import { t } from '../i18n/index.js';

export const SESSION_SETTINGS_SECTION_STORAGE_KEY = 'chatapp_session_settings_section_v1';
const MAX_REMEMBERED_SECTIONS = 60;
const NAV_CLICK_SCROLL_LOCK_MS = 800;

const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

export const SESSION_SETTINGS_ICONS = {
    profile: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>'),
    members: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1.2-3.4 3.6-5 6.5-5s5.3 1.6 6.5 5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 15c1.6.7 2.6 2.3 3 5"/>'),
    script: svg('<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>'),
    memory: svg('<path d="M12 3a7 7 0 0 0-4 12.7V19h8v-3.3A7 7 0 0 0 12 3Z"/><path d="M9 22h6"/>'),
    archive: svg('<path d="M4 5h16v4H4zM5 9v10h14V9M10 13h4"/>'),
    summary: svg('<path d="M5 4h14v16H5z"/><path d="M8.5 9h7M8.5 13h7M8.5 17h4"/>'),
    table: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>'),
    close: svg('<path d="m6 6 12 12M18 6 6 18"/>'),
    back: svg('<path d="m15 5-7 7 7 7"/>'),
    edit: svg('<path d="M4 20h4L19 9l-4-4L4 16v4z"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
};

export const SETTINGS_DISCARD_CONFIRM = Object.freeze({
    title: '放弃更改？',
    message: '有未保存的更改，关闭后这些更改会丢失。',
    confirmText: '放弃更改',
    cancelText: '继续编辑',
    danger: true,
});

export const isSettingsReducedMotion = () =>
    globalThis.document?.body?.dataset?.reducedMotion === 'on'
    || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

export const escapeSettingsHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// 电脑上是右上角的 ×，手机整页时换成左上角的返回箭头（CSS 切换）。
export const buildSessionSettingsCloseInnerHtml = () =>
    `<span class="ssp-close-x">${SESSION_SETTINGS_ICONS.close}</span><span class="ssp-close-back">${SESSION_SETTINGS_ICONS.back}</span>`;

export const buildSessionSettingsNavHtml = (sections = []) => sections
    .map(({ id, label, icon }) => `
        <button type="button" class="ssp-nav-item ssp-ctl" data-section-target="${escapeSettingsHtml(id)}">
            ${SESSION_SETTINGS_ICONS[icon] || ''}<span>${escapeSettingsHtml(label)}</span>
        </button>`)
    .join('');

// 依当前滚动位置挑出「正在看」的分区：顶部越过 offset 的最后一个；已滚到底则取最后一个。
export const pickActiveSettingsSection = ({
    sections = [],
    scrollTop = 0,
    viewportHeight = 0,
    scrollHeight = 0,
    offset = 72,
} = {}) => {
    const list = (Array.isArray(sections) ? sections : [])
        .filter(item => item && item.id && Number.isFinite(Number(item.top)));
    if (!list.length) return '';
    if (scrollHeight > 0 && viewportHeight > 0 && scrollTop > 0 && scrollTop + viewportHeight >= scrollHeight - 4) {
        return list[list.length - 1].id;
    }
    let active = list[0].id;
    for (const item of list) {
        if (Number(item.top) - scrollTop <= offset) active = item.id;
        else break;
    }
    return active;
};

export const serializeSettingsSnapshot = snapshot => JSON.stringify(snapshot ?? null);

export const isSettingsSnapshotDirty = (baseline, snapshot) =>
    typeof baseline === 'string' && serializeSettingsSnapshot(snapshot) !== baseline;

const readSectionMap = (storage) => {
    try {
        const parsed = JSON.parse(storage?.getItem?.(SESSION_SETTINGS_SECTION_STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
};

export const readRememberedSettingsSection = (storage, sessionId = '') => {
    const sid = String(sessionId || '').trim();
    if (!sid) return '';
    const value = readSectionMap(storage)[sid];
    return typeof value === 'string' ? value : '';
};

export const rememberSettingsSection = (storage, sessionId = '', sectionId = '') => {
    const sid = String(sessionId || '').trim();
    const section = String(sectionId || '').trim();
    if (!sid || !section || !storage) return false;
    try {
        const map = readSectionMap(storage);
        if (map[sid] === section) return true;
        delete map[sid];
        map[sid] = section;
        const keys = Object.keys(map);
        keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_SECTIONS)).forEach(key => delete map[key]);
        storage.setItem(SESSION_SETTINGS_SECTION_STORAGE_KEY, JSON.stringify(map));
        return true;
    } catch {
        return false;
    }
};

export const splitSettingsTags = (value = '') => String(value || '')
    .split(/[,，\n\r]/)
    .map(item => item.trim())
    .filter(Boolean);

// 标签输入：真正提交的值仍在 hiddenInput（逗号分隔），这里只负责小胶囊的显示与增删。
export const bindSettingsTagInput = ({
    hiddenInput = null,
    entryInput = null,
    chipsEl = null,
    max = 8,
    documentRef = globalThis.document,
} = {}) => {
    const read = () => splitSettingsTags(hiddenInput?.value);
    const write = (tags) => {
        if (!hiddenInput) return;
        hiddenInput.value = tags.join(', ');
        hiddenInput.dispatchEvent?.(new Event('input', { bubbles: true }));
    };
    const render = () => {
        if (!chipsEl || !documentRef) return;
        chipsEl.textContent = '';
        read().forEach((tag, index) => {
            const chip = documentRef.createElement('span');
            chip.className = 'ssp-tag';
            chip.setAttribute('data-i18n-skip', '');
            const text = documentRef.createElement('span');
            text.textContent = tag;
            const remove = documentRef.createElement('button');
            remove.type = 'button';
            remove.className = 'ssp-tag-remove ssp-ctl';
            remove.setAttribute('aria-label', t('移除标签 {tag}', { tag }));
            remove.textContent = '×';
            remove.addEventListener('click', () => {
                const next = read();
                next.splice(index, 1);
                write(next);
                render();
                entryInput?.focus?.();
            });
            chip.append(text, remove);
            chipsEl.appendChild(chip);
        });
    };
    const commitPending = () => {
        const pending = splitSettingsTags(entryInput?.value);
        if (!pending.length) {
            if (entryInput) entryInput.value = '';
            return false;
        }
        const next = read();
        pending.forEach((tag) => {
            if (!next.includes(tag) && next.length < max) next.push(tag);
        });
        if (entryInput) entryInput.value = '';
        write(next);
        render();
        return true;
    };
    entryInput?.addEventListener?.('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
            event.preventDefault();
            commitPending();
            return;
        }
        if (event.key === 'Backspace' && !entryInput.value) {
            const next = read();
            if (!next.length) return;
            next.pop();
            write(next);
            render();
        }
    });
    entryInput?.addEventListener?.('input', () => {
        if (/[,，]/.test(entryInput.value)) commitPending();
    });
    entryInput?.addEventListener?.('blur', () => commitPending());
    return { render, commitPending };
};

const isSectionShown = el => Boolean(el) && el.hidden !== true && el.style?.display !== 'none';

export const SESSION_SETTINGS_MOBILE_QUERY = '(max-width: 640px)';

// 手机二级页：把某块内容（如记忆表格）暂时搬进整页子页面，返回时放回原处。
// 推入／退出的动画由 CSS（.ssp-panel.has-subpage）负责；这里只管 DOM 搬移与时序。
export const createSettingsSubpage = ({
    panelEl = null,
    subpageEl = null,
    isReducedMotion = () => false,
    requestFrame = callback => globalThis.requestAnimationFrame?.(callback),
    schedule = (callback, delay) => globalThis.setTimeout?.(callback, delay),
    cancelSchedule = timer => globalThis.clearTimeout?.(timer),
    duration = 280,
} = {}) => {
    const titleEl = subpageEl?.querySelector?.('.ssp-subpage-title') || null;
    const bodyEl = subpageEl?.querySelector?.('.ssp-subpage-body') || null;
    let current = null; // { contentEl, parent, next }
    let timer = null;

    const restore = () => {
        if (!current) return;
        const { contentEl, parent, next } = current;
        if (parent) parent.insertBefore(contentEl, next && next.parentNode === parent ? next : null);
        current = null;
    };
    const finishClose = () => {
        if (timer !== null) cancelSchedule(timer);
        timer = null;
        restore();
        if (subpageEl) subpageEl.hidden = true;
    };

    const open = ({ title = '', help = '', contentEl = null } = {}) => {
        if (!subpageEl || !bodyEl || !contentEl) return false;
        if (timer !== null) finishClose();
        if (current && current.contentEl !== contentEl) restore();
        if (!current) {
            current = { contentEl, parent: contentEl.parentNode, next: contentEl.nextSibling };
            bodyEl.appendChild(contentEl);
        }
        if (titleEl) {
            titleEl.textContent = title;
            if (help) titleEl.setAttribute('data-help', help);
            else titleEl.removeAttribute('data-help');
        }
        bodyEl.scrollTop = 0;
        subpageEl.hidden = false;
        subpageEl.setAttribute('aria-hidden', 'false');
        // 先显示在右侧，下一帧再推入，过渡才会发生。
        requestFrame(() => panelEl?.classList?.add('has-subpage'));
        try {
            subpageEl.querySelector('.ssp-subpage-back')?.focus?.({ preventScroll: true });
        } catch {}
        return true;
    };

    const close = ({ immediate = false } = {}) => {
        if (!current && subpageEl?.hidden !== false) return false;
        panelEl?.classList?.remove('has-subpage');
        subpageEl?.setAttribute?.('aria-hidden', 'true');
        if (immediate || isReducedMotion()) {
            finishClose();
            return true;
        }
        if (timer !== null) cancelSchedule(timer);
        timer = schedule(finishClose, duration);
        return true;
    };

    subpageEl?.querySelector?.('.ssp-subpage-back')?.addEventListener?.('click', () => close());

    return {
        open,
        close,
        isOpen: () => Boolean(current) && subpageEl?.hidden === false && panelEl?.classList?.contains?.('has-subpage') !== false,
        hasContent: () => Boolean(current),
    };
};

export const createSessionSettingsChrome = ({
    overlayEl = null,
    panelEl = null,
    scrollEl = null,
    navEl = null,
    dirtyEl = null,
    subpageEl = null,
    getSessionId = () => '',
    readSnapshot = () => null,
    confirmDiscard = async () => true,
    onSave = () => {},
    // 确认关闭后的收尾（面板通常还要顺手关掉自己的子弹窗）；缺省只关外框。
    onCloseConfirmed = null,
    isReducedMotion = () => false,
    storage = (() => {
        try {
            return globalThis.localStorage || null;
        } catch {
            return null;
        }
    })(),
    requestFrame = callback => globalThis.requestAnimationFrame?.(callback),
    now = () => Date.now(),
} = {}) => {
    const motion = createGroupPanelMotionRuntime({
        overlayEl,
        panelEl,
        closeDuration: 200,
        isReducedMotion,
    });
    const indicator = navEl?.querySelector?.('.ssp-nav-indicator') || null;
    const subpage = subpageEl ? createSettingsSubpage({ panelEl, subpageEl, isReducedMotion, requestFrame }) : null;
    // 从手机宽度切回电脑宽度时，二级页的内容放回原卡片。
    const mobileQuery = subpage ? globalThis.matchMedia?.(SESSION_SETTINGS_MOBILE_QUERY) || null : null;
    mobileQuery?.addEventListener?.('change', (event) => {
        if (!event.matches) subpage.close({ immediate: true });
    });
    let baseline = null;
    let dirty = false;
    let activeId = '';
    let scrollLockUntil = 0;
    let spyQueued = false;
    let closing = false;

    const navItems = () => Array.from(navEl?.querySelectorAll?.('[data-section-target]') || []);
    const sectionEls = () => Array.from(scrollEl?.querySelectorAll?.('[data-settings-section]') || []);
    const findSection = id => sectionEls().find(el => el.getAttribute('data-settings-section') === id) || null;
    const visibleSections = () => sectionEls().filter(isSectionShown);

    const moveIndicator = (item, { instant = false } = {}) => {
        if (!indicator) return;
        if (!item || !isSectionShown(item)) {
            indicator.style.opacity = '0';
            return;
        }
        if (instant) indicator.classList.add('is-instant');
        indicator.style.width = `${item.offsetWidth}px`;
        indicator.style.height = `${item.offsetHeight}px`;
        indicator.style.transform = `translate(${item.offsetLeft}px, ${item.offsetTop}px)`;
        indicator.style.opacity = '1';
        if (instant) requestFrame(() => indicator.classList.remove('is-instant'));
    };

    const revealNavItem = (item, { instant = false } = {}) => {
        if (!navEl || !item || navEl.scrollWidth <= navEl.clientWidth + 1) return;
        const left = item.offsetLeft - (navEl.clientWidth - item.offsetWidth) / 2;
        const behavior = instant || isReducedMotion() ? 'auto' : 'smooth';
        if (typeof navEl.scrollTo === 'function') navEl.scrollTo({ left: Math.max(0, left), behavior });
        else navEl.scrollLeft = Math.max(0, left);
    };

    const setActive = (id, { instant = false, remember = true } = {}) => {
        if (!id) return;
        const changed = id !== activeId;
        activeId = id;
        let activeItem = null;
        navItems().forEach((item) => {
            const on = item.getAttribute('data-section-target') === id;
            item.classList.toggle('is-active', on);
            if (on) {
                item.setAttribute('aria-current', 'true');
                activeItem = item;
            } else {
                item.removeAttribute('aria-current');
            }
        });
        moveIndicator(activeItem, { instant });
        if (changed || instant) revealNavItem(activeItem, { instant });
        if (remember && changed) rememberSettingsSection(storage, getSessionId(), id);
    };

    const scrollToSection = (id, { smooth = true } = {}) => {
        const section = findSection(id);
        if (!section || !scrollEl) return false;
        const top = Math.max(0, section.offsetTop - 16);
        const behavior = smooth && !isReducedMotion() ? 'smooth' : 'auto';
        if (typeof scrollEl.scrollTo === 'function') scrollEl.scrollTo({ top, behavior });
        else scrollEl.scrollTop = top;
        return true;
    };

    const runScrollSpy = () => {
        spyQueued = false;
        if (!scrollEl || now() < scrollLockUntil) return;
        const id = pickActiveSettingsSection({
            sections: visibleSections().map(el => ({ id: el.getAttribute('data-settings-section'), top: el.offsetTop })),
            scrollTop: scrollEl.scrollTop,
            viewportHeight: scrollEl.clientHeight,
            scrollHeight: scrollEl.scrollHeight,
            offset: Math.min(120, Math.max(48, scrollEl.clientHeight * 0.25)),
        });
        if (id && id !== activeId) setActive(id);
    };

    // 分区显隐（记忆模式、私聊/创意写作差异）变化后同步目录。
    const syncSections = () => {
        navItems().forEach((item) => {
            item.hidden = !isSectionShown(findSection(item.getAttribute('data-section-target')));
        });
        const current = findSection(activeId);
        if (activeId && !isSectionShown(current)) {
            const first = visibleSections()[0];
            if (first) setActive(first.getAttribute('data-settings-section'), { instant: true, remember: false });
        } else if (activeId) {
            moveIndicator(navItems().find(item => item.getAttribute('data-section-target') === activeId), { instant: true });
        }
    };

    const updateDirtyUi = () => {
        dirtyEl?.classList?.toggle?.('is-visible', dirty);
        panelEl?.classList?.toggle?.('is-dirty', dirty);
    };

    const refreshDirty = () => {
        dirty = isSettingsSnapshotDirty(baseline, readSnapshot());
        updateDirtyUi();
        return dirty;
    };

    const captureBaseline = () => {
        baseline = serializeSettingsSnapshot(readSnapshot());
        dirty = false;
        updateDirtyUi();
    };

    const hide = ({ immediate = false } = {}) => {
        subpage?.close({ immediate: true });
        baseline = null;
        dirty = false;
        updateDirtyUi();
        return motion.hide({ immediate });
    };

    // 用户主动关闭（关闭钮、取消、遮罩、Esc、返回键）：有未保存的更改先确认。已关闭视为成功。
    const requestClose = async () => {
        if (!motion.isVisible()) return true;
        // 二级页开着时，返回／Esc 先回到设置页，不关闭整个面板。
        if (subpage?.hasContent()) {
            subpage.close();
            return false;
        }
        if (closing) return false;
        if (refreshDirty()) {
            closing = true;
            let ok = false;
            try {
                ok = await confirmDiscard();
            } finally {
                closing = false;
            }
            if (!ok) return false;
        }
        if (typeof onCloseConfirmed === 'function') onCloseConfirmed();
        else hide();
        return true;
    };

    const show = () => {
        motion.show();
        captureBaseline();
        syncSections();
        const remembered = readRememberedSettingsSection(storage, getSessionId());
        const first = visibleSections()[0]?.getAttribute('data-settings-section') || '';
        const target = remembered && isSectionShown(findSection(remembered)) ? remembered : first;
        if (scrollEl) scrollEl.scrollTop = 0;
        activeId = '';
        // 等 display 生效、布局完成后再定位，指示块与滚动位置才量得准。
        requestFrame(() => {
            if (target && target !== first) {
                scrollToSection(target, { smooth: false });
                scrollLockUntil = now() + 120;
            }
            setActive(target, { instant: true, remember: false });
        });
        try {
            panelEl?.focus?.({ preventScroll: true });
        } catch {}
    };

    // 转屏、拖窄窗口会让目录在横排／竖排间切换，指示块要按新尺寸重新贴合当前项。
    if (navEl && typeof globalThis.ResizeObserver === 'function') {
        new globalThis.ResizeObserver(() => {
            if (!activeId || !motion.isVisible()) return;
            const item = navItems().find(el => el.getAttribute('data-section-target') === activeId);
            moveIndicator(item, { instant: true });
            revealNavItem(item, { instant: true });
        }).observe(navEl);
    }

    navEl?.addEventListener?.('click', (event) => {
        const item = event.target?.closest?.('[data-section-target]');
        if (!item) return;
        const id = item.getAttribute('data-section-target');
        scrollLockUntil = now() + NAV_CLICK_SCROLL_LOCK_MS;
        setActive(id);
        scrollToSection(id);
    });

    scrollEl?.addEventListener?.('scroll', () => {
        if (spyQueued) return;
        spyQueued = true;
        requestFrame(runScrollSpy);
    }, { passive: true });
    ['wheel', 'touchstart'].forEach((type) => {
        scrollEl?.addEventListener?.(type, () => {
            scrollLockUntil = 0;
        }, { passive: true });
    });

    const onFieldEdited = () => {
        if (baseline !== null) refreshDirty();
    };
    panelEl?.addEventListener?.('input', onFieldEdited);
    panelEl?.addEventListener?.('change', onFieldEdited);

    // 子弹窗（存档管理、记忆共享等）叠在上面时，键盘焦点可能还停在面板里的按钮上；
    // 这时 Esc / Ctrl+S 不该越过上层弹窗作用到设置面板。
    const isTopmostLayer = () => {
        const rect = panelEl?.getBoundingClientRect?.();
        const doc = panelEl?.ownerDocument;
        if (!rect || typeof doc?.elementFromPoint !== 'function') return true;
        const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return !hit || panelEl.contains(hit);
    };

    panelEl?.addEventListener?.('keydown', (event) => {
        if (event.defaultPrevented || !motion.isVisible() || !isTopmostLayer()) return;
        if (event.key === 'Escape') {
            // 必须拦住冒泡：确认弹窗会同步在 document 上挂 Esc 监听，
            // 同一个 Esc 冒泡上去会把刚弹出的「放弃更改？」立刻当成取消关掉。
            event.preventDefault();
            event.stopPropagation?.();
            void requestClose();
            return;
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key || '').toLowerCase() === 's') {
            event.preventDefault();
            onSave();
        }
    });

    return {
        show,
        hide,
        requestClose,
        isVisible: () => motion.isVisible(),
        isDirty: () => dirty,
        refreshDirty,
        captureBaseline,
        syncSections,
        scrollToSection,
        getActiveSection: () => activeId,
        openSubpage: options => subpage?.open(options) || false,
        closeSubpage: options => subpage?.close(options) || false,
        isSubpageOpen: () => Boolean(subpage?.hasContent()),
    };
};
