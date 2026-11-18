/**
 * Parse assistant messages with special tokens into structured message types.
 * Supported tokens (single-line, trimmed):
 * - [img-URL or desc]          -> image
 * - [yy-voice text]            -> audio placeholder (shows text, expects URL if provided)
 * - [music-title$artist]       -> music card
 * - [zz-amount]                -> transfer card
 * - [bqb-sticker name]         -> sticker badge
 * - inline <img src="...">     -> image
 * - raw URL ending with audio suffix (.mp3/.wav/.ogg/.m4a) -> audio
 *
 * Fallback: plain text.
 */

import { resolveMediaAsset, isLikelyUrl } from '../../utils/media-assets.js';
import { localeColon, t } from '../../i18n/index.js';

const TOKEN_PATTERN = /^\[(img-error|img|yy|music|zz|bqb)-([\s\S]+)\]$/i;
const FENCED_CODE_PATTERN = /^```[\s\S]*```$/;
const HTML_DOC_HINT_PATTERN = /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i;

const attachAssetMeta = (resolved) => {
    const item = resolved?.item;
    if (!item || typeof item !== 'object') return undefined;
    return {
        assetId: item.id || '',
        assetKind: item.kind || '',
        assetLabel: item.label || '',
    };
};

export function parseSpecialMessage(raw = '') {
    const text = (raw || '').trim();
    // Do not interpret fenced code / HTML documents as media.
    // These should stay as text so rich renderer can handle them.
    if (FENCED_CODE_PATTERN.test(text) || HTML_DOC_HINT_PATTERN.test(text)) {
        return { type: 'text', content: raw };
    }
    // If HTML-like img tag exists, treat as image content
    if (/<img\s+[^>]*src=/.test(text)) {
        const src = (text.match(/src=["']([^"']+)["']/) || [])[1];
        if (src) {
            const resolved = resolveMediaAsset('image', src);
            if (resolved?.url) return { type: 'image', content: resolved.url, meta: attachAssetMeta(resolved) };
            return { type: 'image', content: src };
        }
    }
    // Detect raw audio URL
    if (/https?:\/\/\S+\.(mp3|wav|ogg|m4a)/i.test(text)) {
        const matchAudio = text.match(/https?:\/\/\S+/i);
        if (matchAudio) {
            const resolved = resolveMediaAsset('audio', matchAudio[0]);
            return {
                type: 'audio',
                content: resolved?.url || matchAudio[0],
                meta: attachAssetMeta(resolved),
            };
        }
    }
    // If text looks like pure URL ending with common image/video
    if (/https?:\/\/\S+\.(png|jpe?g|webp|gif|mp4)/i.test(text)) {
        const matchUrl = text.match(/https?:\/\/\S+/i);
        if (matchUrl) {
            const resolved = resolveMediaAsset('image', matchUrl[0]);
            return {
                type: 'image',
                content: resolved?.url || matchUrl[0],
                meta: attachAssetMeta(resolved),
            };
        }
    }
    const match = text.match(TOKEN_PATTERN);
    if (!match) {
        return { type: 'text', content: raw };
    }

    const type = match[1].toLowerCase();
    const payload = match[2].trim();

    switch (type) {
        case 'img-error':
            return { type: 'text', content: raw };
        case 'img': {
            const resolved = resolveMediaAsset('image', payload);
            if (resolved?.url) {
                return { type: 'image', content: resolved.url, meta: attachAssetMeta(resolved) };
            }
            // If payload looks like a URL, treat as image URL; otherwise show text.
            const isUrl = isLikelyUrl(payload) || payload.startsWith('./') || payload.startsWith('/assets');
            if (isUrl) {
                return { type: 'image', content: payload };
            }
            return { type: 'meta', content: `${t('图片')}${localeColon()}${payload}` };
        }
        case 'yy': {
            const resolved = resolveMediaAsset('audio', payload);
            if (resolved?.url) {
                return { type: 'audio', content: resolved.url, meta: attachAssetMeta(resolved) };
            }
            // Placeholder: audio URL if present, otherwise show text.
            const isUrl = isLikelyUrl(payload) || payload.endsWith('.mp3') || payload.endsWith('.wav');
            if (isUrl) {
                return { type: 'audio', content: payload };
            }
            return { type: 'meta', content: `${t('语音')}${localeColon()}${payload}` };
        }
        case 'music': {
            const [title = payload, artist = ''] = payload.split('$');
            return { type: 'music', content: title.trim(), meta: { artist: artist.trim() } };
        }
        case 'zz': {
            return { type: 'transfer', content: payload };
        }
        case 'bqb': {
            const resolved = resolveMediaAsset('sticker', payload) || resolveMediaAsset('image', payload);
            if (resolved?.url) {
                return { type: 'sticker', content: resolved.url, meta: attachAssetMeta(resolved) };
            }
            return { type: 'sticker', content: payload };
        }
        default:
            return { type: 'text', content: raw };
    }
}
