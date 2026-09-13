import { t } from '../../i18n/index.js';

// Live emits timestamped fragments, not turns. Grouping is only for display;
// retain exact deltas and their arrival order so late/overlapping speech survives.
export class OpenAiLiveTranscript {
  constructor({ gapMs = 2000, maxFragments = 20000, makeId = () => globalThis.crypto.randomUUID() } = {}) {
    this.gapMs = gapMs; this.maxFragments = maxFragments; this.makeId = makeId;
    this.groups = []; this.seen = new Set(); this.count = 0; this.characters = 0;
  }
  append(event) {
    const role = event.type === 'session.input_transcript.delta' ? 'user'
      : event.type === 'session.output_transcript.delta' ? 'assistant' : '';
    if (!role || typeof event.delta !== 'string' || !event.delta) return null;
    const eventId = String(event.event_id || '');
    if (eventId && this.seen.has(eventId)) return null;
    if (this.count >= this.maxFragments || this.characters + event.delta.length > 300000) {
      const error = new Error(t('实时语音字幕达到本次通话的保存上限，请重新拨号')); error.code = 'live_transcript_limit'; throw error;
    }
    const start = Number.isFinite(event.start_ms) ? event.start_ms : null;
    const end = Number.isFinite(event.end_ms) ? event.end_ms : start;
    const candidates = this.groups.filter(group => group.role === role);
    const distance = group => start === null || group.endMs === null ? Infinity : Math.max(0, start - group.endMs, group.startMs - (end ?? start));
    let group = candidates.filter(group => distance(group) <= this.gapMs).sort((a, b) => distance(a) - distance(b))[0];
    if (start === null) group = candidates[candidates.length - 1];
    if (!group || group.text.length > 6000) {
      group = { id: this.makeId(), role, text: '', startMs: start, endMs: end, fragments: [], revision: 0, savedRevision: 0, messageId: '', savedText: '', detached: false };
      this.groups.push(group);
    }
    if (eventId) this.seen.add(eventId);
    this.count++; this.characters += event.delta.length;
    group.text += event.delta;
    group.fragments.push({ eventId, delta: event.delta, startMs: start, endMs: end });
    if (start !== null) group.startMs = group.startMs === null ? start : Math.min(group.startMs, start);
    if (end !== null) group.endMs = group.endMs === null ? end : Math.max(group.endMs, end);
    group.revision++;
    return group;
  }
  captions() {
    return ['user', 'assistant'].map(role => this.groups.filter(group => group.role === role)
      .sort((a, b) => (b.endMs ?? 0) - (a.endMs ?? 0))[0]).filter(Boolean)
      .map(({ id, role, text }) => ({ id, role, text }));
  }
}

// Complete persistence boundary, shared by all Live transcript revisions. It
// intentionally bypasses turn-completion scripts, agents, regex and table edits.
export const createLiveTranscriptCommitter = ({ isTargetCurrent, findMessage, appendMessage, updateMessage, onAdded, onUpdated, getUser = () => ({}), formatTime = () => '' } = {}) => (
  ({ target, group, meta = {} } = {}) => {
    if (!isTargetCurrent(target) || group.detached) return { ignored: true };
    const old = group.messageId ? findMessage(group.messageId, target.sessionId) : null;
    if (group.messageId && (!old || old.meta?.realtimeTranscriptGroupId !== group.id
      || old.meta?.realtimeSessionId !== meta.realtimeSessionId || old.role !== group.role
      || old.content !== group.savedText)) return { ignored: true };
    const user = getUser() || {};
    const message = {
      ...(old || {}), role: group.role, type: 'text', content: group.text, raw: group.text, rawOriginal: group.text,
      name: old?.name || (group.role === 'user' ? user.name || '我' : target.name),
      avatar: old?.avatar || (group.role === 'user' ? user.avatar || '' : target.avatar),
      time: old?.time || formatTime(),
      meta: { ...old?.meta, ...meta, renderRich: false, realtimeTranscriptGroupId: group.id,
        realtimeTranscriptStartMs: group.startMs, realtimeTranscriptEndMs: group.endMs,
        realtimeTranscriptFragments: group.fragments.map(fragment => ({ ...fragment })), transcriptApproximate: true },
    };
    const saved = old ? updateMessage(old.id, message, target.sessionId) : appendMessage(message, target.sessionId);
    if (!saved?.id) throw new Error(t('语音字幕保存失败'));
    if (old) onUpdated?.(saved, target); else onAdded?.(saved, target);
    return { messageId: saved.id };
  }
);
