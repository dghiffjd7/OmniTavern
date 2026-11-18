/**
 * Moments UI (动态) - simplified renderer
 */

import { logger } from '../utils/logger.js';
import { appConfirm } from './app-confirm.js';
import { createMomentsMenuRuntime } from './moments-menu-runtime-utils.js';
import { renderMomentDetailBody } from './moments-detail-runtime-utils.js';
import { renderMomentCardContent } from './moments-card-view-utils.js';
import {
  ensureMomentDetailModalShell,
  openMomentImagePreview,
  showMomentDetailModal,
} from './moments-modal-shell-utils.js';
import {
  activateMomentReplyTarget,
  bindMomentCommentContextMenu,
  focusMomentComposerInput,
} from './moments-comment-interaction-utils.js';
import {
  bindMomentFeedCardInteractions,
  clearMomentReplyTarget,
  createMomentFeedSendHandler,
  toggleMomentCommentsExpanded,
  toggleMomentComposer,
} from './moments-feed-interaction-utils.js';
import {
  applyMomentStoredRegex,
  escapeMomentHtml as esc,
  extractMomentMedia,
  renderMomentTextWithStickers,
  resolveMomentDisplayText,
} from './moments-content-utils.js';
import {
  getMomentAvatarByName,
  resolveMomentAvatar,
  resolveMomentContactAvatar,
} from './moments-avatar-utils.js';
import { buildMomentThreadedComments } from './moments-thread-utils.js';
import {
  bindMentionInputControl,
  buildMentionMembersFromContacts,
} from './mention-input-binding-utils.js';

const getMomentsDocumentRef = () => {
  try {
    if (typeof document !== 'undefined') return document;
  } catch {}
  return {
    body: null,
    documentElement: { clientWidth: 360, clientHeight: 640 },
    addEventListener() {},
    createElement() {
      throw new Error('document is not available');
    },
  };
};

const getMomentsWindowRef = () => {
  try {
    if (typeof window !== 'undefined') return window;
  } catch {}
  return { innerWidth: 360, innerHeight: 640 };
};

export class MomentsPanel {
  constructor({
    momentsStore,
    contactsStore,
    defaultAvatar = '',
    userAvatar = '',
    onUserComment,
    recordLifecycleEvent = null,
  } = {}) {
    this.store = momentsStore;
    this.contactsStore = contactsStore;
    this.defaultAvatar = defaultAvatar;
    this.userAvatar = userAvatar;
    this.onUserComment = typeof onUserComment === 'function' ? onUserComment : null;
    this.recordLifecycleEvent = typeof recordLifecycleEvent === 'function' ? recordLifecycleEvent : null;
    this.listEl = null;
    this.modal = null;
    this.activeMomentId = null;
    this.menuEl = null;
    this.expandedComments = new Set();
    this.openComposer = new Set();
    this.pendingComment = new Set();
    this.replyTargets = new Map(); // momentId -> { id, author, content }
    this.likeBurstTimers = new WeakMap();
    this.commentMenuEl = null;
    this.mentionDropdown = null;
    this.visibleCount = 5;
    this.pageSize = 5;
    this.menuRuntime = createMomentsMenuRuntime({
      documentLike: getMomentsDocumentRef(),
      windowLike: getMomentsWindowRef(),
      appConfirmFn: appConfirm,
    });
  }

  buildThreadedComments(comments = []) {
    return buildMomentThreadedComments(comments);
  }

  mount(listEl) {
    this.listEl = listEl;
    this.visibleCount = 5;
    this.render();
  }

  setUserAvatar(url) {
    this.userAvatar = url;
  }

  resolveContactAvatar(contact, fallbackName = '') {
    return resolveMomentContactAvatar(contact, {
      fallbackName,
      defaultAvatar: this.defaultAvatar,
    });
  }

  getAvatarByName(name) {
    return getMomentAvatarByName(name, {
      contactsStore: this.contactsStore,
      defaultAvatar: this.defaultAvatar,
      userAvatar: this.userAvatar,
      resolveContactAvatar: (contact, options = {}) => resolveMomentContactAvatar(contact, {
        ...options,
        defaultAvatar: this.defaultAvatar,
      }),
    });
  }

  getAvatarForMoment(m) {
    return resolveMomentAvatar(m, {
      contactsStore: this.contactsStore,
      defaultAvatar: this.defaultAvatar,
      userAvatar: this.userAvatar,
      resolveContactAvatar: (contact, options = {}) => resolveMomentContactAvatar(contact, {
        ...options,
        defaultAvatar: this.defaultAvatar,
      }),
      getAvatarByName: (name) => getMomentAvatarByName(name, {
        contactsStore: this.contactsStore,
        defaultAvatar: this.defaultAvatar,
        userAvatar: this.userAvatar,
        resolveContactAvatar: (contact, options = {}) => resolveMomentContactAvatar(contact, {
          ...options,
          defaultAvatar: this.defaultAvatar,
        }),
      }),
    });
  }

  getMentionMembers() {
    return buildMentionMembersFromContacts({
      contactsStore: this.contactsStore,
      resolveAvatar: contact => this.resolveContactAvatar(contact, contact?.name || contact?.id || ''),
    });
  }

  bindMentionInput(inputEl, anchorEl = null) {
    return bindMentionInputControl({
      inputEl,
      anchorEl,
      documentLike: document,
      windowLike: window,
      getMembers: () => this.getMentionMembers(),
      getDropdown: () => this.mentionDropdown,
      setDropdown: dropdown => {
        this.mentionDropdown = dropdown;
      },
    });
  }

  ensureMenu() {
    this.menuEl = this.menuRuntime.ensureMomentMenu({
      existingMenu: this.menuEl,
      onDeleteMoment: async (momentId) => {
        const removed = this.store?.remove?.(momentId);
        if (!removed) window.toastr?.warning('删除失败：未找到该动态');
        else window.toastr?.success('已删除动态');
        this.render({ preserveScroll: true });
      },
    });
  }

  hideMenu() {
    this.menuRuntime.hideMomentMenu(this.menuEl);
  }

  showMenu(anchorEl, momentId) {
    this.ensureMenu();
    this.menuRuntime.showMomentMenu({
      menuEl: this.menuEl,
      anchorEl,
      momentId,
    });
  }

  likeMoment({ momentId, buttonEl = null } = {}) {
    const id = String(momentId || '').trim();
    if (!id) return false;
    const current = this.store?.get?.(id);
    if (!current) return false;
    const saved = typeof this.store?.likeMoment === 'function'
      ? this.store.likeMoment(id)
      : this.store?.upsert?.({
        id,
        likes: current.userLiked
          ? Math.max(0, (Number(current.likes || 0) || 0) - 1)
          : (Number(current.likes || 0) || 0) + 1,
        userLiked: !current.userLiked,
      });
    if (!saved) return false;
    const likes = Math.max(0, Number(saved.likes || 0) || 0);
    const liked = Boolean(saved.userLiked);
    if (buttonEl) {
      const previousBurst = this.likeBurstTimers.get(buttonEl);
      if (previousBurst && previousBurst.timer !== null && typeof clearTimeout === 'function') {
        clearTimeout(previousBurst.timer);
      }
      buttonEl.classList?.toggle?.('is-liked', liked);
      buttonEl.classList?.remove?.('is-burst');
      const playBurst = () => buttonEl.classList?.add?.('is-burst');
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(playBurst);
      else playBurst();
      buttonEl.dataset.likeDelta = liked ? '+1' : '-1';
      buttonEl.setAttribute?.('aria-pressed', liked ? 'true' : 'false');
      buttonEl.setAttribute?.('aria-label', `${liked ? '已点赞' : '点赞'}，当前 ${likes} 人已赞`);
      buttonEl.setAttribute?.('title', liked ? '已点赞' : '点赞');
      const countEl = buttonEl.querySelector?.('.moment-like-count');
      if (countEl) countEl.textContent = String(likes);
      const burst = { timer: null };
      this.likeBurstTimers.set(buttonEl, burst);
      burst.timer = setTimeout(() => {
        if (this.likeBurstTimers.get(buttonEl) !== burst) return;
        buttonEl.classList?.remove?.('is-burst');
        this.likeBurstTimers.delete(buttonEl);
      }, 560);
    }
    return true;
  }

  ensureCommentMenu() {
    this.commentMenuEl = this.menuRuntime.ensureCommentMenu({
      existingMenu: this.commentMenuEl,
      onDeleteComment: async (momentId, commentId) => {
        const removed = this.store?.removeComment?.(momentId, commentId);
        if (!removed) window.toastr?.warning?.('删除失败：未找到该评论');
        else window.toastr?.success?.('已删除评论');
        this.render({ preserveScroll: true });
      },
    });
  }

  hideCommentMenu() {
    this.menuRuntime.hideCommentMenu(this.commentMenuEl);
  }

  showCommentMenu({ x, y }, momentId, commentId) {
    this.ensureCommentMenu();
    this.menuRuntime.showCommentMenu({
      menuEl: this.commentMenuEl,
      point: { x, y },
      momentId,
      commentId,
    });
  }

  render({ preserveScroll = false } = {}) {
    if (!this.listEl) return;
    const moments = this.store?.list?.() || [];
    const prevScroll = preserveScroll ? this.listEl.scrollTop || 0 : 0;
    const visibleN = Math.max(this.pageSize, Number(this.visibleCount) || this.pageSize);
    this.listEl.innerHTML = '';
    if (!moments.length) {
      const empty = document.createElement('div');
      empty.className = 'moments-empty-state';
      empty.textContent = '（暂无动态）';
      this.listEl.appendChild(empty);
      this.visibleCount = this.pageSize;
      return;
    }
    moments.slice(0, visibleN).forEach(m => {
      const card = document.createElement('div');
      card.className = 'moment-card';
      card.dataset.momentId = m.id;
      const avatar = this.getAvatarForMoment(m);
      // Backfill originSessionId for older data (helps avatar fallback to current chat persona)
      try {
        const hasOrigin = String(m?.originSessionId || '').trim().length > 0;
        if (!hasOrigin && String(m?.authorId || '').trim()) {
          this.store?.upsert?.({ id: m.id, originSessionId: String(m.authorId).trim() });
          m.originSessionId = String(m.authorId).trim();
        }
      } catch {}
      // Backfill snapshot avatar so legacy moments keep correct avatar even if names change later
      try {
        const hasSnap = String(m?.authorAvatar || '').trim().length > 0;
        if (!hasSnap && avatar && avatar !== this.defaultAvatar) {
          this.store?.upsert?.({
            id: m.id,
            authorAvatar: avatar,
            authorId: m.authorId || '',
            author: m.author || '',
            originSessionId: m.originSessionId || '',
          });
        }
      } catch {}
      const comments = Array.isArray(m.comments) ? m.comments : [];
      const VISIBLE_COMMENTS = 3;
      const expanded = this.expandedComments.has(m.id);
      const showComposer = this.openComposer.has(m.id);
      const replyTarget = this.replyTargets.get(m.id) || null;
      const hiddenCount = comments.length > VISIBLE_COMMENTS ? comments.length - VISIBLE_COMMENTS : 0;
      const visibleComments = expanded ? comments : hiddenCount > 0 ? comments.slice(-VISIBLE_COMMENTS) : comments;
      const pending = this.pendingComment.has(m.id);
      renderMomentCardContent({
        cardEl: card,
        moment: m,
        avatar,
        userAvatar: this.userAvatar || this.defaultAvatar,
        expanded,
        showComposer,
        replyTarget,
        pending,
        visibleComments,
        collapsedCommentLimit: VISIBLE_COMMENTS,
        documentLike: document,
        buildThreadedComments: (items) => this.buildThreadedComments(items),
        escapeHtml: esc,
        renderMomentTextWithStickers,
        resolveMomentDisplayText,
        extractMomentMedia,
        onOpenImage: (url) => this.openImagePreview?.(url),
      });
      bindMomentFeedCardInteractions({
        cardEl: card,
        moment: m,
        pending,
        showMenu: (anchorEl, momentId) => this.showMenu(anchorEl, momentId),
        bindCommentContextMenu: ({ commentEl, momentId, commentId }) => bindMomentCommentContextMenu({
          commentEl,
          momentId,
          commentId,
          showCommentMenu: (...args) => this.showCommentMenu(...args),
        }),
        activateReplyTarget: ({ momentId, commentId, comments }) => activateMomentReplyTarget({
          momentId,
          commentId,
          comments,
          replyTargets: this.replyTargets,
          openComposer: this.openComposer,
          render: (options) => this.render(options),
          focusComposerInput: (nextMomentId) => focusMomentComposerInput({
            listEl: this.listEl,
            momentId: nextMomentId,
          }),
        }),
        likeMoment: (payload) => this.likeMoment(payload),
        toggleComposer: (momentId) => toggleMomentComposer({
          momentId,
          openComposer: this.openComposer,
          replyTargets: this.replyTargets,
          render: (options) => this.render(options),
          focusComposerInput: (nextMomentId) => focusMomentComposerInput({
            listEl: this.listEl,
            momentId: nextMomentId,
          }),
        }),
        toggleExpanded: (momentId, action) => toggleMomentCommentsExpanded({
          momentId,
          action,
          expandedComments: this.expandedComments,
          render: (options) => this.render(options),
        }),
        clearReplyTarget: (momentId) => clearMomentReplyTarget({
          momentId,
          replyTargets: this.replyTargets,
          render: (options) => this.render(options),
          focusComposerInput: (nextMomentId) => focusMomentComposerInput({
            listEl: this.listEl,
            momentId: nextMomentId,
          }),
        }),
        bindMentionInput: (inputEl, anchorEl) => this.bindMentionInput(inputEl, anchorEl),
        createSendHandler: ({ moment, inputEl, pending }) => createMomentFeedSendHandler({
          moment,
          inputEl,
          pending,
          replyTargets: this.replyTargets,
          openComposer: this.openComposer,
          pendingComment: this.pendingComment,
          store: this.store,
          applyMomentStoredRegex,
          render: (options) => this.render(options),
          onUserComment: this.onUserComment,
          loggerWarn: (...args) => logger.warn(...args),
          recordLifecycleEvent: this.recordLifecycleEvent,
        }),
      });

      this.listEl.appendChild(card);
    });

    // 展开更多一次多一页；展开过就能收起回第一页
    const canMore = moments.length > visibleN;
    const canLess = Math.min(visibleN, moments.length) > this.pageSize;
    if (canMore || canLess) {
      const row = document.createElement('div');
      row.className = 'moment-load-row';
      const button = (className, onClick) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = className;
        el.addEventListener('click', onClick);
        return row.appendChild(el);
      };
      if (canMore) {
        button('moment-load-more', () => {
          this.visibleCount = Math.min(moments.length, visibleN + this.pageSize);
          this.render({ preserveScroll: true });
        }).textContent = '展开更多';
      }
      if (canLess) {
        button('moment-load-more moment-load-less', () => {
          this.visibleCount = this.pageSize;
          this.render({ preserveScroll: true });
        }).textContent = '收起';
      }
      this.listEl.appendChild(row);
    }
    if (!canMore) this.visibleCount = Math.min(visibleN, moments.length);
    if (preserveScroll) this.listEl.scrollTop = prevScroll;
  }

  ensureModal() {
    this.modal = ensureMomentDetailModalShell({
      existingModal: this.modal,
      documentLike: document,
      onSendComment: () => this.addLocalComment(),
    });
    this.bindMentionInput(this.modal?.querySelector('#moment-comment-input'));
  }

  openDetail(momentId) {
    this.ensureModal();
    this.activeMomentId = momentId;
    const m = this.store?.get?.(momentId);
    if (!m) return;
    const meta = this.modal.querySelector('#moment-detail-meta');
    if (meta) meta.textContent = `id: ${m.id}`;
    const body = this.modal.querySelector('#moment-detail-body');
    if (body) {
      const avatar = this.getAvatarForMoment(m);
      renderMomentDetailBody({
        bodyEl: body,
        moment: m,
        avatar,
        documentLike: document,
        escapeHtml: esc,
        renderMomentTextWithStickers,
        resolveMomentDisplayText,
        extractMomentMedia,
        onOpenImage: (url) => this.openImagePreview(url),
        bindCommentContextMenu: ({ commentEl, momentId, commentId }) => bindMomentCommentContextMenu({
          commentEl,
          momentId,
          commentId,
          showCommentMenu: (...args) => this.showCommentMenu(...args),
        }),
        activateReplyTarget: ({ momentId, commentId, comments }) => activateMomentReplyTarget({
          momentId,
          commentId,
          comments,
          replyTargets: this.replyTargets,
          openComposer: this.openComposer,
          render: (options) => this.render(options),
          focusComposerInput: (nextMomentId) => focusMomentComposerInput({
            listEl: this.listEl,
            momentId: nextMomentId,
          }),
        }),
      });
    }
    showMomentDetailModal(this.modal);
  }

  openImagePreview(url) {
    return openMomentImagePreview({
      documentLike: document,
      url,
    });
  }

  addLocalComment() {
    try {
      const id = this.activeMomentId;
      if (!id) return;
      const input = this.modal?.querySelector('#moment-comment-input');
      const text = String(input?.value || '').trim();
      if (!text) return;
      this.store.addComments(id, [{
        author: '我',
        // moments-regex rollback marker:
        // content: text,
        content: applyMomentStoredRegex(text, { regexMode: 'input' }),
        regexMode: 'input',
      }]);
      if (input) input.value = '';
      this.openDetail(id);
      this.render();
    } catch (err) {
      logger.error('addLocalComment failed', err);
    }
  }
}
