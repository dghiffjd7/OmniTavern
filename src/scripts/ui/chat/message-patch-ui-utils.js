import { buildAgentMessageSidecarSignature } from './agent-message-sidecar-ui-utils.js';
import { buildMessageSourcesSignature } from './message-sources-ui-utils.js';
import { buildMessageTranslationSignature } from './message-translation-ui-utils.js';

export const createMessagePatchUiRuntime = ({
  normalizeReplyTarget,
  normalizeReactionEntries,
  resolveActiveSwipeMessage,
  applyCreativeBubbleState,
  resolveRpAssistantName = null,
} = {}) => ({
  getMessageRenderSignature(message) {
    const msg = resolveActiveSwipeMessage?.(message && typeof message === 'object' ? message : {}) || {};
    const meta = msg.meta && typeof msg.meta === 'object' ? msg.meta : {};
    const rawSource =
      typeof msg.rawSource === 'string'
        ? msg.rawSource
        : (typeof msg.raw_source === 'string' ? msg.raw_source : '');
    const swipes = Array.isArray(meta.swipes) ? meta.swipes : null;
    return JSON.stringify({
      role: String(msg.role || ''),
      type: String(msg.type || 'text'),
      content: typeof msg.content === 'string' ? msg.content : '',
      raw: typeof msg.raw === 'string' ? msg.raw : '',
      rawSource,
      activeSwipe: swipes ? Math.min(Math.max(0, Math.trunc(Number(meta.activeSwipe)) || 0), swipes.length - 1) : 0,
      swipeCount: swipes ? swipes.length : 0,
      renderRich: meta.renderRich === true,
      isGreeting: meta.isGreeting === true,
      showName: meta.showName === true,
      reasoning: typeof meta.reasoning === 'string' ? meta.reasoning : '',
      reasoningDisplay: typeof meta.reasoningDisplay === 'string' ? meta.reasoningDisplay : '',
      reasoningLabel: typeof meta.reasoningLabel === 'string' ? meta.reasoningLabel : '',
      reasoningSource: typeof meta.reasoningSource === 'string' ? meta.reasoningSource : '',
      reasoningHidden: meta.reasoningHidden === true,
      summary: typeof meta.summary === 'string' ? meta.summary : '',
      sources: buildMessageSourcesSignature(msg),
      translation: buildMessageTranslationSignature(msg),
      agentMessageParts: buildAgentMessageSidecarSignature(msg),
      replyTo: normalizeReplyTarget?.(meta.replyTo) ?? null,
      reactions: normalizeReactionEntries?.(meta.reactions) ?? [],
      name: typeof msg.name === 'string' ? msg.name : '',
      badge: typeof msg.badge === 'string' ? msg.badge : '',
    });
  },
  patchMessageChrome(existing, next) {
    if (!existing || !next) return;
    existing.__chatappMessage = next;
    existing.dataset.msgId = String(next.id || '');
    existing.dataset.role = String(next.role || '');
    if (Number.isFinite(Number(next?.timestamp)) && Number(next.timestamp) > 0) {
      existing.dataset.timestamp = String(Number(next.timestamp));
    } else {
      delete existing.dataset.timestamp;
    }
    if (next.status === 'pending' || next.status === 'sending') {
      existing.classList.add('message-pending');
      existing.dataset.status = String(next.status || '');
    } else {
      existing.classList.remove('message-pending');
      delete existing.dataset.status;
      if (next.role === 'user') {
        const statusEl = existing.querySelector('.chat-delivery-status');
        if (statusEl && !statusEl.textContent && existing.dataset.trackDelivery) {
          statusEl.textContent = '✔ 已送出';
        }
      }
    }
    applyCreativeBubbleState?.(existing, next);

    const avatarImg = existing.querySelector('img.QQ_chat_head');
    if (avatarImg && typeof next.avatar === 'string' && next.avatar.trim()) {
      avatarImg.src = next.avatar;
    }

    const nameEl = existing.querySelector('.QQ_chat_name');
    if (nameEl && typeof next.name === 'string') {
      nameEl.textContent = existing.classList?.contains?.('has-rp-message-chrome')
        ? (resolveRpAssistantName?.(next) || next.name)
        : next.name;
    }

    const timeEls = existing.querySelectorAll('.QQ_chat_time');
    const timeEl = timeEls.length ? timeEls[timeEls.length - 1] : null;
    if (timeEl) {
      timeEl.textContent = next.time || '';
    }
  },
  tryPatchMessageElement(existing, next) {
    if (!existing || !next) return false;
    const prev = existing.__chatappMessage && typeof existing.__chatappMessage === 'object'
      ? existing.__chatappMessage
      : null;
    if (!prev) return false;
    if (String(prev.role || '') !== String(next.role || '')) return false;
    if (String(prev.type || 'text') !== String(next.type || 'text')) return false;
    if (this.getMessageRenderSignature(prev) !== this.getMessageRenderSignature(next)) return false;
    this.patchMessageChrome(existing, next);
    return true;
  },
});
