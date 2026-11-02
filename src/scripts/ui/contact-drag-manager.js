/**
 * Contact drag manager - handles drag and drop for contact grouping
 * - 支持联系人在分组间拖拽
 * - 支持拖拽到未分组区域
 */

import { logger } from '../utils/logger.js';
import { createDragGhost } from './drag-ghost-utils.js';

export class ContactDragManager {
    constructor({ groupStore, onDrop } = {}) {
        this.groupStore = groupStore;
        this.onDrop = typeof onDrop === 'function' ? onDrop : null;

        this.draggedElement = null;
        this.draggedContactId = null;
        this.draggedFromGroupId = null;
        this.usePointerDrag = !ContactDragManager.isTouchDevice();
        this.pointerId = null;
        this.pointerStart = null;
        this.pointerTarget = null;
        this.pointerDragging = false;
        this.pointerOverZone = null;
        this.suppressClick = false;
        this.initialized = false;
        this.activeDropZone = null;
        this.expandTimer = null;
        this.expandTargetId = null;

        this.boundDragStart = this.handleDragStart.bind(this);
        this.boundDragOver = this.handleDragOver.bind(this);
        this.boundDrop = this.handleDrop.bind(this);
        this.boundDragEnd = this.handleDragEnd.bind(this);
        this.boundPointerDown = this.handlePointerDown.bind(this);
        this.boundPointerMove = this.handlePointerMove.bind(this);
        this.boundPointerUp = this.handlePointerUp.bind(this);
        this.boundPointerCancel = this.handlePointerCancel.bind(this);
        this.boundClickCapture = this.handleClickCapture.bind(this);
    }

    static isTouchDevice() {
        try {
            return Boolean(('ontouchstart' in window) || (navigator?.maxTouchPoints > 0));
        } catch {
            return false;
        }
    }

    /**
     * 初始化拖拽功能
     */
    init() {
        if (this.initialized) return;

        document.addEventListener('dragstart', this.boundDragStart);
        document.addEventListener('dragover', this.boundDragOver);
        document.addEventListener('drop', this.boundDrop);
        document.addEventListener('dragend', this.boundDragEnd);
        if (this.usePointerDrag) {
            document.addEventListener('pointerdown', this.boundPointerDown, { passive: true });
            document.addEventListener('pointermove', this.boundPointerMove, { passive: false });
            document.addEventListener('pointerup', this.boundPointerUp);
            document.addEventListener('pointercancel', this.boundPointerCancel);
            document.addEventListener('click', this.boundClickCapture, true);
        }

        this.initialized = true;
        logger.debug('ContactDragManager 已初始化');
    }

    /**
     * 销毁拖拽功能
     */
    destroy() {
        if (!this.initialized) return;

        document.removeEventListener('dragstart', this.boundDragStart);
        document.removeEventListener('dragover', this.boundDragOver);
        document.removeEventListener('drop', this.boundDrop);
        document.removeEventListener('dragend', this.boundDragEnd);
        if (this.usePointerDrag) {
            document.removeEventListener('pointerdown', this.boundPointerDown);
            document.removeEventListener('pointermove', this.boundPointerMove);
            document.removeEventListener('pointerup', this.boundPointerUp);
            document.removeEventListener('pointercancel', this.boundPointerCancel);
            document.removeEventListener('click', this.boundClickCapture, true);
        }

        this.initialized = false;
        logger.debug('ContactDragManager 已销毁');
    }

    beginDrag(contact) {
        if (!contact) return false;
        const contactId = contact.getAttribute('data-contact-id');
        if (!contactId) return false;
        this.draggedElement = contact;
        this.draggedContactId = contactId;

        const groupElement = contact.closest('.contact-group-container');
        if (groupElement) {
            this.draggedFromGroupId = groupElement.getAttribute('data-group-id');
        } else {
            this.draggedFromGroupId = null;
        }

        contact.classList.add('dragging');
        this.setActiveDropZone(null);
        return true;
    }

    endDrag() {
        if (this.pointerGhost) {
            if (this.lastDropMoved) {
                // 放置成功：原地淡出（原卡位置即将由重渲染更新，飞回原位是错误暗示）
                this.pointerGhost.fadeOut();
            } else {
                // 取消/无效放置：飞回来源位置，暗示"没有发生移动"
                this.pointerGhost.settle(this.draggedElement?.getBoundingClientRect?.() || null);
            }
            this.pointerGhost = null;
        }
        this.lastDropMoved = false;
        if (this.draggedElement) {
            this.draggedElement.classList.remove('dragging');
        }
        this.clearDropZoneHighlights();
        this.setActiveDropZone(null);
        this.clearExpandTimer();
        this.draggedElement = null;
        this.draggedContactId = null;
        this.draggedFromGroupId = null;
    }

    dropOnZone(dropZone) {
        if (!dropZone || !this.draggedContactId) return false;
        const targetGroupId = dropZone.getAttribute('data-group-id');
        if (targetGroupId === this.draggedFromGroupId) {
            logger.debug('拖拽到同一分组，取消操作');
            return true;
        }

        logger.info(`拖拽联系人: ${this.draggedContactId}, 从 ${this.draggedFromGroupId || '未分组'} 到 ${targetGroupId || '未分组'}`);

        try {
            this.groupStore?.moveContact?.(this.draggedContactId, targetGroupId);
            this.lastDropMoved = true;
            if (this.onDrop) {
                this.onDrop({
                    contactId: this.draggedContactId,
                    fromGroupId: this.draggedFromGroupId,
                    toGroupId: targetGroupId,
                });
            }
            window.toastr?.success?.('已移动联系人');
        } catch (err) {
            logger.error('移动联系人失败', err);
            window.toastr?.error?.('移动联系人失败');
        }
        return true;
    }

    /**
     * 开始拖拽
     */
    handleDragStart(event) {
        if (this.usePointerDrag) return;
        // 拖动选中的文字时 target 是文字节点（没有 closest），不是拖联系人
        const contact = event.target?.closest?.('.contact-item');
        if (!contact) return;

        if (!this.beginDrag(contact)) return;
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', this.draggedContactId || '');
        }

        logger.debug(`开始拖拽联系人: ${this.draggedContactId}, 来自分组: ${this.draggedFromGroupId || '未分组'}`);
    }

    /**
     * 拖拽悬停处理
     */
    handleDragOver(event) {
        const dropZone = this.resolveDropZoneFromTarget(event.target);
        this.updateDropZoneHover(dropZone);
        if (!dropZone) return;

        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }

    /**
     * 放置处理
     */
    async handleDrop(event) {
        event.preventDefault();
        event.stopPropagation();

        const dropZone = this.resolveDropZoneFromTarget(event.target);
        this.dropOnZone(dropZone);
    }

    /**
     * 拖拽结束处理
     */
    handleDragEnd(event) {
        this.endDrag();

        logger.debug('拖拽结束');
    }

    /**
     * 清除所有放置区的高亮
     */
    clearDropZoneHighlights() {
        document.querySelectorAll('.drop-zone.drag-over').forEach(zone => {
            zone.classList.remove('drag-over');
        });
    }

    updateDropZoneHover(dropZone) {
        if (this.pointerOverZone !== dropZone) {
            this.clearDropZoneHighlights();
        }
        this.pointerOverZone = dropZone || null;
        this.setActiveDropZone(dropZone);
        if (this.pointerOverZone) {
            this.pointerOverZone.classList.add('drag-over');
            this.scheduleExpandForZone(this.pointerOverZone);
        } else {
            this.clearExpandTimer();
        }
    }

    handlePointerDown(event) {
        if (!this.usePointerDrag || event.button !== 0 || event.pointerType === 'touch') return;
        const contact = event.target.closest('.contact-item');
        if (!contact) return;
        this.pointerStart = { x: event.clientX, y: event.clientY };
        this.pointerId = event.pointerId;
        this.pointerTarget = contact;
        this.pointerDragging = false;
        this.pointerOverZone = null;
        try { contact.setPointerCapture?.(event.pointerId); } catch {}
    }

    handlePointerMove(event) {
        if (!this.pointerTarget || event.pointerId !== this.pointerId || event.pointerType === 'touch') return;
        if (!this.pointerStart) return;
        const dx = event.clientX - this.pointerStart.x;
        const dy = event.clientY - this.pointerStart.y;
        const dist = Math.hypot(dx, dy);
        if (!this.pointerDragging && dist < 6) return;
        if (!this.pointerDragging) {
            const started = this.beginDrag(this.pointerTarget);
            if (!started) {
                this.resetPointerState();
                return;
            }
            this.pointerDragging = true;
            // 悬浮幽灵：克隆联系人卡跟随指针（抬升动画），原卡变淡作为来源占位
            this.pointerGhost = createDragGhost(this.pointerTarget, event);
        }
        event.preventDefault();
        this.pointerGhost?.move(event);
        const target = document.elementFromPoint(event.clientX, event.clientY);
        const dropZone = this.resolveDropZoneFromTarget(target);
        this.updateDropZoneHover(dropZone);
    }

    handlePointerUp(event) {
        if (event.pointerId !== this.pointerId) return;
        if (this.pointerDragging) {
            const target = document.elementFromPoint(event.clientX, event.clientY);
            const dropZone = this.pointerOverZone || this.resolveDropZoneFromTarget(target);
            this.dropOnZone(dropZone);
            this.suppressClick = true;
        }
        try { this.pointerTarget?.releasePointerCapture?.(event.pointerId); } catch {}
        this.endDrag();
        this.resetPointerState();
    }

    handlePointerCancel(event) {
        if (event.pointerId !== this.pointerId) return;
        try { this.pointerTarget?.releasePointerCapture?.(event.pointerId); } catch {}
        this.endDrag();
        this.resetPointerState();
    }

    handleClickCapture(event) {
        if (!this.suppressClick) return;
        if (event.target?.closest?.('.contact-item')) {
            event.preventDefault();
            event.stopPropagation();
        }
        this.suppressClick = false;
    }

    resetPointerState() {
        this.pointerId = null;
        this.pointerStart = null;
        this.pointerTarget = null;
        this.pointerDragging = false;
        this.pointerOverZone = null;
    }

    setActiveDropZone(dropZone) {
        if (this.activeDropZone === dropZone) return;
        if (this.activeDropZone) this.activeDropZone.classList.remove('active');
        this.activeDropZone = dropZone || null;
        if (this.activeDropZone) this.activeDropZone.classList.add('active');
    }

    resolveDropZoneFromTarget(target) {
        if (!target || !target.closest) return null;
        const directZone = target.closest('.drop-zone');
        if (directZone) return directZone;
        const groupContainer = target.closest('.contact-group-container');
        if (groupContainer) return this.getDirectDropZone(groupContainer);
        const ungrouped = target.closest('.contact-ungrouped-section');
        if (ungrouped) return this.getDirectDropZone(ungrouped);
        return null;
    }

    getDirectDropZone(container) {
        if (!container) return null;
        const scoped = container.querySelector(':scope > .drop-zone');
        if (scoped) return scoped;
        const children = Array.from(container.children || []);
        return children.find(child => child?.classList?.contains('drop-zone')) || null;
    }

    scheduleExpandForZone(dropZone) {
        const groupId = dropZone?.getAttribute?.('data-group-id') || '';
        if (!groupId || groupId === 'ungrouped') return;
        if (this.expandTargetId === groupId) return;
        this.clearExpandTimer();
        this.expandTargetId = groupId;
        this.expandTimer = setTimeout(() => {
            this.ensureGroupExpanded(groupId);
        }, 260);
    }

    clearExpandTimer() {
        if (this.expandTimer) clearTimeout(this.expandTimer);
        this.expandTimer = null;
        this.expandTargetId = null;
    }

    ensureGroupExpanded(groupId) {
        if (!groupId) return;
        const group = this.groupStore?.getGroup?.(groupId);
        if (!group || !group.collapsed) return;
        try {
            this.groupStore?.updateGroup?.(groupId, { collapsed: false });
        } catch {}
        const groupEl = document.querySelector(`.contact-group-container[data-group-id="${groupId}"]`);
        if (!groupEl) return;
        const toggle = groupEl.querySelector('.group-toggle');
        const content = groupEl.querySelector('.contact-group-content');
        toggle?.classList.remove('collapsed');
        content?.classList.remove('collapsed');
        content?.classList.add('expanded');
    }

    /**
     * 为联系人元素启用拖拽
     */
    enableDragForContact(contactElement) {
        if (!contactElement) return;
        contactElement.draggable = !this.usePointerDrag;
        contactElement.classList.add('contact-item');
    }

    /**
     * 批量为联系人元素启用拖拽
     */
    enableDragForContacts(selector = '.contact-item') {
        const contacts = document.querySelectorAll(selector);
        contacts.forEach(contact => {
            this.enableDragForContact(contact);
        });
        logger.debug(`为 ${contacts.length} 个联系人启用拖拽`);
    }
}
