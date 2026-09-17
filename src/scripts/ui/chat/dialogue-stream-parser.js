import { getChatTimeMode, initializeProtocolMessageTime } from '../../utils/chat-time-policy.js';

/**
 * Dialogue-mode stream parser (simplified)
 * - Ignores standard <thinking>/<think> blocks outside message payloads
 * - Extracts <content>...</content>, then emits completed chat tags inside
 * - Currently focuses on private chat tags: <X和Y的私聊>...</X和Y的私聊>
 * - Inside private chat tag:
 *   - Preferred: lines starting with "-" (each becomes one assistant bubble)
 *   - Fallback: "speaker--content--HH:MM" per line
 */

import { splitProtocolThinking } from './protocol-thinking-utils.js';
import { parseProtocolChatRows, parseProtocolMomentHeader } from '../../utils/protocol-message-row.js';

const normalizeNewlines = (s) => String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const findFirstTagOpen = (s) => s.indexOf('<');

const hasImplicitContentSignal = (s) => {
    const src = String(s ?? '');
    const lower = src.toLowerCase();
    if (lower.includes('moment_start') || lower.includes('moment_reply_start')) return true;
    // A private chat tag can appear without <content> when models don't follow the wrapper rule.
    // Example: <我和貝法的私聊> ... </我和貝法的私聊>
    if (/<\s*[^/][^>]*的私聊\s*>/i.test(src)) return true;
    if (/<\s*(?:private_chat|group_chat)\s*[:：]/i.test(src)) return true;
    if (/<\s*群聊\s*[:：]/i.test(src)) return true;
    return false;
};

const parseOpenTag = (s, startIdx) => {
    const gt = s.indexOf('>', startIdx + 1);
    if (gt === -1) return null;
    const raw = s.slice(startIdx + 1, gt).trim();
    const isClosing = raw.startsWith('/');
    let core = isClosing ? raw.slice(1).trim() : raw;
    let selfClosing = core.endsWith('/') || raw.endsWith('/'); // <br/> or <tag .../>
    if (core.endsWith('/')) core = core.slice(0, -1).trim();
    // NOTE: Our protocol tag names may contain spaces (e.g. "我和Lara croft的私聊"),
    // so we intentionally do NOT split by whitespace (attributes are not expected in these tags).
    const tagName = core;
    const tagLower = tagName.toLowerCase();
    if (!selfClosing) {
        const voidTags = ['br', 'img', 'hr', 'input', 'meta', 'link'];
        selfClosing = voidTags.some(t => tagLower === t || tagLower.startsWith(`${t} `));
    }
    return { tagName, isClosing, selfClosing, endIdx: gt + 1 };
};

const findMatchingCloseTag = (s, tagName, fromIdx) => {
    const src = String(s ?? '');
    const target = String(tagName ?? '').trim();
    if (!target) return null;
    let idx = Math.max(0, fromIdx | 0);
    while (true) {
        const closeStart = src.indexOf('</', idx);
        if (closeStart === -1) return null;
        const close = parseOpenTag(src, closeStart);
        if (!close) return null; // need more data
        if (close.isClosing && String(close.tagName || '').trim() === target) {
            return { closeIdx: closeStart, afterClose: close.endIdx };
        }
        idx = close.endIdx;
        if (idx >= src.length) return null;
    }
};

const findMiPhoneStart = (s) => {
    const src = String(s ?? '');
    const re = /<\s*MiPhone_start\s*>|MiPhone_start/i;
    const m = re.exec(src);
    if (!m) return null;
    return { index: m.index, length: m[0].length };
};

const findMiPhoneEnd = (s) => {
    const src = String(s ?? '');
    const re = /<\s*MiPhone_end\s*>|MiPhone_end/i;
    const m = re.exec(src);
    if (!m) return null;
    return { index: m.index, length: m[0].length };
};

const parsePrivateChatMessages = innerText => parseProtocolChatRows(innerText, {allowPlain:true});

const isGroupChatTag = (tagName) => {
    const tn = String(tagName || '').trim();
    return /^(?:群聊|group_chat)\s*[:：]/i.test(tn);
};

const extractGroupNameFromTag = (tagName) => {
    const tn = String(tagName || '').trim();
    const m = tn.match(/^(?:群聊|group_chat)\s*[:：]\s*(.+)\s*$/i);
    return m ? String(m[1] || '').trim() : '';
};

const parseGroupChatBlock = (innerText) => {
    const src = String(innerText ?? '');
    const getBlock = (tag) => {
        const re = new RegExp(`<\\s*${tag}\\s*>[\\s\\S]*?<\\s*/\\s*${tag}\\s*>`, 'i');
        const m = src.match(re);
        if (!m) return '';
        const open = new RegExp(`<\\s*${tag}\\s*>`, 'i');
        const close = new RegExp(`<\\s*/\\s*${tag}\\s*>`, 'i');
        return String(m[0] || '').replace(open, '').replace(close, '').trim();
    };

    const membersRaw = getBlock('成员');
    const members = membersRaw
        ? membersRaw.split(/[,，]/).map(s => String(s || '').trim()).filter(Boolean)
        : [];

    const chatRaw = getBlock('聊天内容') || src;
    const messages = parseProtocolChatRows(normalizeNewlines(chatRaw).replace(/^\s*系统消息[:：]\s*(.+)$/gm, '系统消息--$1'));

    return { members, messages };
};

const extractOtherNameFromPrivateChatTag = (tagName, userName) => {
    // tagName examples:
    // - "我和室友的私聊"
    // - "{{user}}和{{char}}的私聊" (after macros applied)
    const tn = String(tagName || '').trim();
    const english = tn.match(/^private_chat\s*[:：]\s*(.+)\s*$/i);
    if (english) {
        const names = String(english[1] || '')
            .split(/[|,，]/)
            .map(name => name.trim())
            .filter(Boolean);
        const normalizedUser = String(userName || '').trim().toLowerCase();
        return names.find(name => name.toLowerCase() !== normalizedUser) || names[names.length - 1] || null;
    }
    const suffix = '的私聊';
    if (!tn.endsWith(suffix)) return null;
    const core = tn.slice(0, -suffix.length);
    const prefix = `${String(userName || '').trim()}和`;
    if (prefix && core.startsWith(prefix)) {
        return core.slice(prefix.length).trim() || null;
    }
    // If userName not present, try split by "和"
    const parts = core.split('和').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) return parts[parts.length - 1] || null;
    return null;
};

const parseMomentBlock = (innerText) => {
    const text = normalizeNewlines(innerText);
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const moments = [];
    let current = null;
    const looksLikeTime = (val) => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(String(val || '').trim());
    const parseCommentParts = (parts) => {
        const author = parts[0] || '';
        const rest = parts.slice(1);
        let replyTo = '';
        let replyToAuthor = '';
        let time = '';
        const contentParts = [];
        for (const seg of rest) {
            const s = String(seg || '').trim();
            if (!s) continue;
            const m1 = s.match(/^reply_to::\s*(.+)\s*$/i);
            if (m1) {
                replyTo = String(m1[1] || '').trim();
                continue;
            }
            const m2 = s.match(/^reply_to_author::\s*(.+)\s*$/i);
            if (m2) {
                replyToAuthor = String(m2[1] || '').trim();
                continue;
            }
            if (!time && looksLikeTime(s)) {
                time = s;
                continue;
            }
            contentParts.push(seg);
        }
        return { author, content: contentParts.join('--').trim(), replyTo, replyToAuthor, time };
    };

    const commit = () => {
        if (!current) return;
        // Default counts
        current.views = Number.isFinite(Number(current.views)) ? Number(current.views) : 0;
        current.likes = Number.isFinite(Number(current.likes)) ? Number(current.likes) : 0;
        current.timestamp = Date.now();
        current.signature = `${current.author || ''}\u0000${current.content || ''}\u0000${current.time || ''}`;
        if (!Array.isArray(current.comments)) current.comments = [];
        moments.push(current);
        current = null;
    };

    for (const line of lines) {
        const parts = line.split('--').map(p => p.trim());
        const header = parseProtocolMomentHeader(line);
        if (header) {
            // New moment header
            commit();
            current = header;
            continue;
        }
        if (parts.length >= 2 && current) {
            const comment = parseCommentParts(parts);
            if (comment.content) current.comments.push(comment);
            continue;
        }
    }
    commit();
    return moments;
};

const parseMomentReplyBlock = (innerText) => {
    const text = normalizeNewlines(innerText);
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let momentId = '';
    const comments = [];
    for (const line of lines) {
        const m = line.match(/^moment_id::\s*(.+)\s*$/i);
        if (m) {
            momentId = String(m[1] || '').trim();
            continue;
        }
        const parts = line.split('--').map(p => p.trim());
        if (parts.length >= 2) {
            const author = parts[0] || '';
            const rest = parts.slice(1);
            let replyTo = '';
            let replyToAuthor = '';
            const contentParts = [];
            for (const seg of rest) {
                const s = String(seg || '').trim();
                const m1 = s.match(/^reply_to::\s*(.+)\s*$/i);
                if (m1) {
                    replyTo = String(m1[1] || '').trim();
                    continue;
                }
                const m2 = s.match(/^reply_to_author::\s*(.+)\s*$/i);
                if (m2) {
                    replyToAuthor = String(m2[1] || '').trim();
                    continue;
                }
                contentParts.push(seg);
            }
            comments.push({
                author,
                content: contentParts.join('--') || '',
                replyTo,
                replyToAuthor,
            });
        }
    }
    return { momentId, comments };
};

const findNextToken = (s) => {
    const src = String(s ?? '');
    const lower = src.toLowerCase();
    const idxTag = src.indexOf('<');
    const idxMoment = lower.indexOf('moment_start');
    const idxReply = lower.indexOf('moment_reply_start');
    const candidates = [
        { kind: 'tag', idx: idxTag },
        { kind: 'moment', idx: idxMoment },
        { kind: 'moment_reply', idx: idxReply },
    ].filter(x => x.idx !== -1);
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.idx - b.idx);
    return candidates[0];
};

export class DialogueStreamParser {
    constructor({ userName = '我', resolveLooseGroupTag, resolveLoosePrivateTag, timeMode = getChatTimeMode(), sourceId = '' } = {}) {
        this.userName = userName;
        this.timeMode = timeMode;
        this.sourceId = sourceId || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
        this.momentOrdinal = 0;
        this.preBuffer = '';
        this.inContent = false;
        this.contentBuffer = '';
        this.ended = false;
        this.contentWrapper = '';
        this.wrapperEventCount = 0;
        this.resolveLooseGroupTag = typeof resolveLooseGroupTag === 'function' ? resolveLooseGroupTag : null;
        this.resolveLoosePrivateTag = typeof resolveLoosePrivateTag === 'function' ? resolveLoosePrivateTag : null;
    }

    push(chunk) {
        if (this.ended) return [];
        const events = [];
        const text = String(chunk ?? '');
        if (!text) return events;

        if (!this.inContent) {
            this.preBuffer += text;
            const { text: visible, pendingThinking } = splitProtocolThinking(this.preBuffer, this);
            // Detect <content ...> opening
            const m = visible.match(/<content\b[^>]*>/i);
            if (m) {
                const start = visible.toLowerCase().indexOf(m[0].toLowerCase());
                const after = start + m[0].length;
                this.inContent = true;
                this.contentWrapper = 'content';
                this.contentBuffer += visible.slice(after) + pendingThinking;
                this.preBuffer = '';
            } else {
                const miStart = findMiPhoneStart(visible);
                if (miStart) {
                    const after = miStart.index + miStart.length;
                    this.inContent = true;
                    this.contentWrapper = 'miphone';
                    this.contentBuffer += visible.slice(after) + pendingThinking;
                    this.preBuffer = '';
                } else if (hasImplicitContentSignal(visible)) {
                    // Fallback: some models may omit <content> wrapper but still output tags we can parse.
                    this.inContent = true;
                    this.contentWrapper = 'implicit';
                    this.contentBuffer += visible + pendingThinking;
                    this.preBuffer = '';
                } else {
                    this.preBuffer = visible + pendingThinking;
                    // keep bounded to avoid memory growth before content
                    // An unfinished thinking opener must survive until its close.
                    if (!pendingThinking && this.preBuffer.length > 80_000) this.preBuffer = this.preBuffer.slice(-40_000);
                    return events;
                }
            }
        } else {
            this.contentBuffer += text;
        }

        const filtered = splitProtocolThinking(this.contentBuffer, {
            allowOrphanClose: false,
            resolveLooseGroupTag: this.resolveLooseGroupTag,
            resolveLoosePrivateTag: this.resolveLoosePrivateTag,
        });
        this.contentBuffer = filtered.text;

        // If content ended, only parse within it
        let endIdx = -1;
        let afterEndIdx = -1;
        if (this.contentWrapper === 'content') {
            endIdx = this.contentBuffer.toLowerCase().indexOf('</content>');
            if (endIdx !== -1) afterEndIdx = endIdx + '</content>'.length;
        } else if (this.contentWrapper === 'miphone') {
            const miEnd = findMiPhoneEnd(this.contentBuffer);
            if (miEnd) {
                endIdx = miEnd.index;
                afterEndIdx = miEnd.index + miEnd.length;
            }
        }
        let scanText = this.contentBuffer;
        if (endIdx !== -1) {
            scanText = this.contentBuffer.slice(0, endIdx);
        }

        // Parse completed tags in scanText
        let work = scanText;
        let advanced = true;
        while (advanced) {
            advanced = false;
            const next = findNextToken(work);
            if (!next) break;

            if (next.kind === 'moment') {
                const startIdx = next.idx;
                const endMark = 'moment_end';
                const endAt = work.toLowerCase().indexOf(endMark, startIdx);
                if (endAt === -1) break; // wait for more data
                const inner = work.slice(startIdx + 'moment_start'.length, endAt);
                const after = endAt + endMark.length;
                const moments = parseMomentBlock(inner).map(moment => {
                    const sourceKey = `protocol:${this.sourceId}:moment:${this.momentOrdinal++}`;
                    return { ...moment, signature: sourceKey, protocolTimeMode: this.timeMode,
                        comments: moment.comments.map((comment, index) => ({ ...comment, id: `${sourceKey}:comment:${index}` })) };
                });
                if (moments.length) events.push({ type: 'moments', moments });
                work = work.slice(after);
                advanced = true;
                continue;
            }

            if (next.kind === 'moment_reply') {
                const startIdx = next.idx;
                const endMark = 'moment_reply_end';
                const endAt = work.toLowerCase().indexOf(endMark, startIdx);
                if (endAt === -1) break; // wait for more data
                const inner = work.slice(startIdx + 'moment_reply_start'.length, endAt);
                const after = endAt + endMark.length;
                const { momentId, comments } = parseMomentReplyBlock(inner);
                // moment_id is optional (some tasks already know the target momentId in context).
                if (comments.length) events.push({ type: 'moment_reply', momentId, comments: comments.map(comment => initializeProtocolMessageTime(comment, { timeMode: this.timeMode, modelTime: comment.time })) });
                work = work.slice(after);
                advanced = true;
                continue;
            }

            const lt = next.idx;
            const open = parseOpenTag(work, lt);
            if (!open) break; // need more data
            const { tagName, isClosing, endIdx } = open;
            if (isClosing) {
                // Drop stray closing tags
                work = work.slice(endIdx);
                advanced = true;
                continue;
            }
            if (open.selfClosing) {
                // Consume self-closing tags (e.g. <br/>) without affecting parsing
                work = work.slice(endIdx);
                advanced = true;
                continue;
            }

            // Only care about completed tags with a matching close
            const close = findMatchingCloseTag(work, tagName, endIdx);
            if (!close) break; // wait for more data
            const closeIdx = close.closeIdx;

            const inner = work.slice(endIdx, closeIdx);
            const afterClose = close.afterClose;

            if (tagName.endsWith('的私聊') || /^private_chat\s*[:：]/i.test(tagName)) {
                const otherName = extractOtherNameFromPrivateChatTag(tagName, this.userName);
                const msgs = parsePrivateChatMessages(inner);
                if (msgs.length) {
                    events.push({ type: 'private_chat', tagName, otherName, messages: msgs });
                }
                work = work.slice(afterClose);
                advanced = true;
                continue;
            }

            if (isGroupChatTag(tagName)) {
                const groupName = extractGroupNameFromTag(tagName);
                const { members, messages } = parseGroupChatBlock(inner);
                if (groupName && messages.length) {
                    events.push({ type: 'group_chat', tagName, groupName, members, messages });
                }
                work = work.slice(afterClose);
                advanced = true;
                continue;
            }

            // Fallback: treat bare group/contact tags as group/private when matching existing names.
            // Only applied when standard tag parsing did not match.
            const fallbackGroupName = this.resolveLooseGroupTag ? this.resolveLooseGroupTag(tagName) : '';
            const fallbackPrivateName = this.resolveLoosePrivateTag ? this.resolveLoosePrivateTag(tagName) : '';
            if (fallbackGroupName || fallbackPrivateName) {
                const hasGroupMarkers = /<\s*聊天内容\s*>/i.test(inner) || /<\s*成员\s*>/i.test(inner);
                const preferGroup = Boolean(fallbackGroupName) && (hasGroupMarkers || !fallbackPrivateName);
                if (preferGroup) {
                    const { members, messages } = parseGroupChatBlock(inner);
                    if (messages.length) {
                        events.push({
                            type: 'group_chat',
                            tagName,
                            groupName: fallbackGroupName,
                            members,
                            messages,
                        });
                        work = work.slice(afterClose);
                        advanced = true;
                        continue;
                    }
                }
                if (fallbackPrivateName) {
                    const msgs = parsePrivateChatMessages(inner);
                    if (msgs.length) {
                        events.push({ type: 'private_chat', tagName, otherName: fallbackPrivateName, messages: msgs });
                        work = work.slice(afterClose);
                        advanced = true;
                        continue;
                    }
                }
            }

            // Ignore other tags but consume them when closed (e.g. <action>...</action>)
            work = work.slice(afterClose);
            advanced = true;
        }

        // Commit remaining unconsumed content
        // Count across pushes: a closing chunk may contain no new event even
        // though this shell already emitted messages in an earlier chunk.
        this.wrapperEventCount += events.length;
        if (endIdx !== -1) {
            const tail = (afterEndIdx >= 0 ? this.contentBuffer.slice(afterEndIdx) : '') + filtered.pendingThinking;
            if (this.contentWrapper === 'content' || this.wrapperEventCount === 0) {
                this.inContent = false;
                this.contentWrapper = '';
                this.wrapperEventCount = 0;
                this.contentBuffer = '';
                if (String(tail || '').trim()) {
                    events.push(...this.push(tail));
                }
            } else {
                this.ended = true;
                this.contentBuffer = '';
            }
        } else {
            // keep leftover for future chunks
            this.contentBuffer = work + filtered.pendingThinking;
            if (!filtered.pendingThinking && this.contentBuffer.length > 160_000) this.contentBuffer = this.contentBuffer.slice(-80_000);
        }

        return events;
    }

    flush() {
        // Only emit when tags are fully closed; flush does nothing additional now.
        return [];
    }
}
