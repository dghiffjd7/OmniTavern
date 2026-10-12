import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    bindSettingsTagInput,
    createSessionSettingsChrome,
    createSettingsSubpage,
    isSettingsSnapshotDirty,
    pickActiveSettingsSection,
    readRememberedSettingsSection,
    rememberSettingsSection,
    serializeSettingsSnapshot,
    SESSION_SETTINGS_SECTION_STORAGE_KEY,
    splitSettingsTags,
} from '../../src/scripts/ui/session-settings-chrome-utils.js';

const createClassList = () => {
    const values = new Set();
    return {
        add: (...tokens) => tokens.forEach(token => values.add(token)),
        remove: (...tokens) => tokens.forEach(token => values.delete(token)),
        toggle: (token, force) => {
            const on = force === undefined ? !values.has(token) : Boolean(force);
            if (on) values.add(token);
            else values.delete(token);
            return on;
        },
        contains: token => values.has(token),
    };
};

const createElement = (attrs = {}) => {
    const listeners = {};
    const attributes = { ...attrs };
    return {
        style: {},
        classList: createClassList(),
        hidden: false,
        value: '',
        offsetTop: 0,
        offsetLeft: 0,
        offsetWidth: 100,
        offsetHeight: 40,
        children: [],
        getAttribute: name => (name in attributes ? attributes[name] : null),
        setAttribute: (name, value) => {
            attributes[name] = String(value);
        },
        removeAttribute: (name) => {
            delete attributes[name];
        },
        addEventListener: (type, fn) => {
            (listeners[type] ||= []).push(fn);
        },
        dispatch(type, event = {}) {
            (listeners[type] || []).forEach(fn => fn({ preventDefault() {}, ...event }));
        },
        dispatchEvent(event) {
            this.dispatch(event.type, event);
            return true;
        },
        focus() {},
        appendChild(child) {
            this.children.push(child);
        },
        append(...nodes) {
            this.children.push(...nodes);
        },
        set textContent(value) {
            this.children = [];
            this._text = value;
        },
        get textContent() {
            return this._text || '';
        },
    };
};

const createMemoryStorage = () => {
    const data = new Map();
    return {
        getItem: key => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, String(value)),
        data,
    };
};

{
    const sections = [
        { id: 'basic', top: 0 },
        { id: 'script', top: 300 },
        { id: 'archives', top: 700 },
    ];
    assert.equal(pickActiveSettingsSection({ sections, scrollTop: 0, viewportHeight: 500, scrollHeight: 1400 }), 'basic');
    assert.equal(pickActiveSettingsSection({ sections, scrollTop: 260, viewportHeight: 500, scrollHeight: 1400 }), 'script');
    assert.equal(pickActiveSettingsSection({ sections, scrollTop: 640, viewportHeight: 500, scrollHeight: 1400 }), 'archives');
    // 已滚到底：最后一个分区即使顶部没越过阈值也算当前
    assert.equal(pickActiveSettingsSection({ sections, scrollTop: 520, viewportHeight: 500, scrollHeight: 1020 }), 'archives');
    assert.equal(pickActiveSettingsSection({ sections: [] }), '');
    console.log('ok - scroll spy picks the section whose top has passed the offset, and the last one at the bottom');
}

{
    const baseline = serializeSettingsSnapshot({ name: '甲', labels: ['a'] });
    assert.equal(isSettingsSnapshotDirty(baseline, { name: '甲', labels: ['a'] }), false);
    assert.equal(isSettingsSnapshotDirty(baseline, { name: '乙', labels: ['a'] }), true);
    assert.equal(isSettingsSnapshotDirty(null, { name: '乙' }), false);
    console.log('ok - dirty detection compares against the captured baseline only');
}

{
    const storage = createMemoryStorage();
    assert.equal(readRememberedSettingsSection(storage, 'rp:a'), '');
    rememberSettingsSection(storage, 'rp:a', 'archives');
    rememberSettingsSection(storage, 'contact:b', 'script');
    assert.equal(readRememberedSettingsSection(storage, 'rp:a'), 'archives');
    assert.equal(readRememberedSettingsSection(storage, 'contact:b'), 'script');
    for (let i = 0; i < 80; i += 1) rememberSettingsSection(storage, `s${i}`, 'basic');
    const stored = JSON.parse(storage.data.get(SESSION_SETTINGS_SECTION_STORAGE_KEY));
    assert.equal(Object.keys(stored).length, 60);
    assert.equal(readRememberedSettingsSection(storage, 'rp:a'), '');
    const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    assert.equal(readRememberedSettingsSection(broken, 'rp:a'), '');
    assert.equal(rememberSettingsSection(broken, 'rp:a', 'basic'), false);
    console.log('ok - last section is remembered per session, capped, and survives blocked storage');
}

{
    assert.deepEqual(splitSettingsTags('重制版, SG线，  ,新\n旧'), ['重制版', 'SG线', '新', '旧']);
    const hidden = createElement();
    hidden.value = '重制版, SG线';
    const entry = createElement();
    const chips = createElement();
    const documentRef = { createElement: () => createElement() };
    const tagInput = bindSettingsTagInput({ hiddenInput: hidden, entryInput: entry, chipsEl: chips, documentRef, max: 3 });
    tagInput.render();
    assert.equal(chips.children.length, 2);
    entry.value = '新标签';
    entry.dispatch('keydown', { key: 'Enter' });
    assert.equal(hidden.value, '重制版, SG线, 新标签');
    assert.equal(entry.value, '');
    entry.value = '超出上限';
    tagInput.commitPending();
    assert.equal(hidden.value, '重制版, SG线, 新标签');
    entry.dispatch('keydown', { key: 'Backspace' });
    assert.equal(hidden.value, '重制版, SG线');
    entry.value = '输入法中';
    entry.dispatch('keydown', { key: 'Enter', isComposing: true });
    assert.equal(hidden.value, '重制版, SG线');
    console.log('ok - tag chips add on Enter, respect the cap, remove on Backspace and ignore IME composition');
}

{
    const overlay = createElement();
    const panel = createElement();
    const scroll = createElement();
    const nav = createElement();
    const dirtyEl = createElement();
    const sectionBasic = createElement({ 'data-settings-section': 'basic' });
    const sectionTable = createElement({ 'data-settings-section': 'memory-table' });
    sectionTable.style.display = 'none';
    const navBasic = createElement({ 'data-section-target': 'basic' });
    const navTable = createElement({ 'data-section-target': 'memory-table' });
    scroll.querySelectorAll = () => [sectionBasic, sectionTable];
    nav.querySelectorAll = () => [navBasic, navTable];
    nav.querySelector = () => null;
    let state = { name: '甲' };
    let confirmCalls = 0;
    let confirmAnswer = false;
    let saves = 0;
    const frames = [];
    const chrome = createSessionSettingsChrome({
        overlayEl: overlay,
        panelEl: panel,
        scrollEl: scroll,
        navEl: nav,
        dirtyEl,
        getSessionId: () => 'rp:test',
        readSnapshot: () => ({ ...state }),
        confirmDiscard: async () => {
            confirmCalls += 1;
            return confirmAnswer;
        },
        onSave: () => {
            saves += 1;
        },
        isReducedMotion: () => true,
        storage: createMemoryStorage(),
        requestFrame: fn => frames.push(fn),
    });

    chrome.show();
    frames.splice(0).forEach(fn => fn());
    assert.equal(panel.style.display, 'flex');
    assert.equal(navTable.hidden, true, 'nav hides entries whose section is hidden');
    assert.equal(navBasic.classList.contains('is-active'), true);
    assert.equal(chrome.isDirty(), false);

    state = { name: '乙' };
    panel.dispatch('input');
    assert.equal(chrome.isDirty(), true);
    assert.equal(dirtyEl.classList.contains('is-visible'), true);

    panel.dispatch('keydown', { key: 's', ctrlKey: true });
    assert.equal(saves, 1);

    let escStopped = false;
    panel.dispatch('keydown', { key: 'Escape', stopPropagation: () => { escStopped = true; } });
    await Promise.resolve();
    assert.equal(escStopped, true, 'Esc must not bubble to the discard prompt that opens synchronously on document');
    assert.equal(confirmCalls, 1, 'Esc on a dirty panel asks before discarding');
    assert.equal(panel.style.display, 'flex');

    assert.equal(await chrome.requestClose(), false);
    assert.equal(confirmCalls, 2);
    assert.equal(panel.style.display, 'flex', 'cancelling the discard prompt keeps the panel open');

    confirmAnswer = true;
    assert.equal(await chrome.requestClose(), true);
    assert.equal(panel.style.display, 'none');
    assert.equal(dirtyEl.classList.contains('is-visible'), false);

    chrome.show();
    assert.equal(await chrome.requestClose(), true);
    assert.equal(confirmCalls, 3, 'a clean panel closes without asking');
    assert.equal(await chrome.requestClose(), true, 'closing an already closed panel is a no-op success');
    console.log('ok - settings chrome tracks unsaved edits, asks before discarding, and saves on Ctrl+S');
}

{
    const contactSource = await readFile(new URL('../../src/scripts/ui/contact-settings-panel.js', import.meta.url), 'utf8');
    const groupSource = await readFile(new URL('../../src/scripts/ui/group-chat-panels.js', import.meta.url), 'utf8');
    const html = await readFile(new URL('../../src/index.html', import.meta.url), 'utf8');
    const css = await readFile(new URL('../../src/assets/css/settings-panel-redesign.css', import.meta.url), 'utf8');
    const themeCss = await readFile(new URL('../../src/assets/css/theme.css', import.meta.url), 'utf8');
    const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');

    const checkNavMatchesSections = (source, label) => {
        const navBlock = source.match(/buildSessionSettingsNavHtml\(\[([\s\S]*?)\]\)/);
        assert.ok(navBlock, `${label}: missing nav`);
        const navIds = Array.from(navBlock[1].matchAll(/id: '([^']+)'/g), match => match[1]);
        const sectionIds = Array.from(source.matchAll(/data-settings-section="([^"]+)"/g), match => match[1]);
        assert.deepEqual(navIds, sectionIds, `${label}: nav order must follow the section order`);
    };
    checkNavMatchesSections(contactSource, 'contact');
    checkNavMatchesSections(groupSource, 'group');

    // 既有 runtime 依赖的 id 都还在
    [
        'contact-settings-title', 'contact-settings-sub', 'contact-settings-close', 'contact-settings-save', 'contact-settings-cancel',
        'contact-avatar-btn', 'contact-avatar-preview', 'contact-avatar-clear', 'contact-name-input', 'contact-labels-input',
        'contact-voice-section', 'contact-voice-select', 'contact-template-enabled', 'contact-script-enabled',
        'contact-open-regex', 'contact-open-vars-panel', 'contact-reset-vars', 'contact-memory-features-section',
        'contact-rp-bridge-section', 'contact-memory-share-section', 'contact-memory-share-manage', 'contact-memory-share-summary',
        'contact-new-chat', 'contact-export-experience-pack', 'contact-archives-manage', 'contact-archives-list',
        'contact-summary-section', 'contact-summaries-list', 'contact-summaries-batchbar', 'contact-compacted-summary',
        'contact-memory-table-section', 'contact-memory-table-content', 'contact-profile-manage',
    ].forEach(id => assert.match(contactSource, new RegExp(`id="${id}"`), `contact markup lost #${id}`));
    [
        'group-settings-title', 'group-settings-sub', 'group-settings-close', 'group-settings-save', 'group-settings-cancel',
        'group-settings-avatar-btn', 'group-settings-avatar-preview', 'group-settings-name', 'group-settings-add', 'group-settings-members',
        'group-memory-features-section', 'group-memory-share-section', 'group-memory-share-manage', 'group-memory-share-summary',
        'group-new-chat', 'group-archives-manage', 'group-archives-list', 'group-summary-section', 'group-summaries-list',
        'group-compacted-summary', 'group-memory-table-section', 'group-memory-table-content',
    ].forEach(id => assert.match(groupSource, new RegExp(`id="${id}"`), `group markup lost #${id}`));

    assert.match(html, /href="\.\/assets\/css\/settings-panel-redesign\.css"/);
    ['--app-ease-out', '--app-ease-in', '--app-dur-quick', '--app-dur-base', '--app-dur-page']
        .forEach(token => assert.match(themeCss, new RegExp(`${token}:`), `missing motion token ${token}`));
    assert.match(css, /body\[data-reduced-motion='on'\]/);
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'settings redesign css must only use theme tokens');
    assert.match(appSource, /\(\) => void contactSettingsPanel\.requestClose\(\)/);
    assert.match(appSource, /\(\) => void groupSettingsPanel\.requestClose\(\)/);
    console.log('ok - both settings panels share the redesigned shell, keep runtime ids, and route back through the discard prompt');
}

{
    // 手机二级页：内容搬进子页、返回时放回原位置；返回／Esc 先退二级页
    const makeNode = () => ({ parentNode: null, nextSibling: null });
    const makeParent = () => {
        const children = [];
        const sync = () => children.forEach((child, i) => { child.parentNode = parent; child.nextSibling = children[i + 1] || null; });
        const parent = {
            children,
            appendChild(node) { node.parentNode?.children && node.parentNode.remove(node); children.push(node); sync(); },
            insertBefore(node, ref) { node.parentNode?.children && node.parentNode.remove(node); const i = ref ? children.indexOf(ref) : -1; if (i < 0) children.push(node); else children.splice(i, 0, node); sync(); },
            remove(node) { const i = children.indexOf(node); if (i >= 0) children.splice(i, 1); node.parentNode = null; node.nextSibling = null; sync(); },
        };
        return parent;
    };
    const card = makeParent();
    const before = makeNode();
    const content = makeNode();
    const after = makeNode();
    card.appendChild(before); card.appendChild(content); card.appendChild(after);
    const body = makeParent();
    body.scrollTop = 40;
    const title = { textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
    const back = createElement();
    const subpageEl = {
        hidden: true,
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        querySelector: sel => ({ '.ssp-subpage-title': title, '.ssp-subpage-body': body, '.ssp-subpage-back': back })[sel] || null,
    };
    const panelEl = createElement();
    const timers = [];
    const subpage = createSettingsSubpage({
        panelEl, subpageEl,
        requestFrame: fn => fn(),
        schedule: fn => { timers.push(fn); return timers.length; },
        cancelSchedule: () => {},
    });
    assert.equal(subpage.open({ title: '记忆表格', help: '说明', contentEl: content }), true);
    assert.equal(content.parentNode, body);
    assert.equal(body.scrollTop, 0);
    assert.equal(subpageEl.hidden, false);
    assert.equal(panelEl.classList.contains('has-subpage'), true);
    assert.equal(title.textContent, '记忆表格');
    assert.equal(title.attrs['data-help'], '说明');
    assert.equal(subpage.hasContent(), true);

    back.dispatch('click');
    assert.equal(panelEl.classList.contains('has-subpage'), false, '返回钮先触发推出动画');
    assert.equal(content.parentNode, body, '动画结束前内容仍在子页');
    timers.shift()();
    assert.equal(content.parentNode, card, '动画结束后放回原卡片');
    assert.equal(card.children.indexOf(content), 1, '放回原来的位置');
    assert.equal(subpageEl.hidden, true);

    subpage.open({ title: 'x', contentEl: content });
    subpage.close({ immediate: true });
    assert.equal(content.parentNode, card);
    assert.equal(subpage.close(), false, '已关闭时再关闭是空操作');
    console.log('ok - settings subpage moves content in and restores it to the original spot');
}

{
    const overlay = createElement();
    const panel = createElement();
    const scroll = createElement();
    const nav = createElement();
    scroll.querySelectorAll = () => [];
    nav.querySelectorAll = () => [];
    nav.querySelector = () => null;
    const body = { scrollTop: 0, appendChild(node) { node.parentNode = this; } };
    const subpageEl = { hidden: true, setAttribute() {}, querySelector: sel => ({ '.ssp-subpage-body': body })[sel] || null };
    const content = { parentNode: { insertBefore(node) { node.parentNode = this; } }, nextSibling: null };
    const home = content.parentNode;
    const chrome = createSessionSettingsChrome({
        overlayEl: overlay, panelEl: panel, scrollEl: scroll, navEl: nav, subpageEl,
        readSnapshot: () => ({}), isReducedMotion: () => true, storage: createMemoryStorage(), requestFrame: fn => fn(),
    });
    chrome.show();
    chrome.openSubpage({ title: '记忆表格', contentEl: content });
    assert.equal(chrome.isSubpageOpen(), true);
    assert.equal(await chrome.requestClose(), false, '二级页开着时返回只退回设置页');
    assert.equal(panel.style.display, 'flex');
    assert.equal(content.parentNode, home);
    chrome.openSubpage({ title: '记忆表格', contentEl: content });
    panel.dispatch('keydown', { key: 'Escape', stopPropagation() {} });
    await Promise.resolve();
    assert.equal(panel.style.display, 'flex');
    assert.equal(chrome.isSubpageOpen(), false, 'Esc 也先退二级页');
    chrome.openSubpage({ title: '记忆表格', contentEl: content });
    chrome.hide();
    assert.equal(content.parentNode, home, '关闭设置时内容放回原处');
    console.log('ok - back and Esc leave the subpage before closing settings');
}
