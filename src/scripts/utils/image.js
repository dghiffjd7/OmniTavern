/**
 * Image helpers
 * - Compress avatar images to avoid localStorage quota errors
 * - Preserve GIF (keep animation)
 */

const readFileAsDataUrl = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('read file failed'));
        reader.readAsDataURL(file);
    });
};

const loadImage = (dataUrl) => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('load image failed'));
        img.src = dataUrl;
    });
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const canvasToDataUrl = (canvas, { mime, quality, preserveAlpha = false }) => {
    try {
        const out = canvas.toDataURL(mime, quality);
        if (typeof out === 'string' && out.startsWith('data:')) return out;
    } catch {}
    try {
        const out = canvas.toDataURL(preserveAlpha ? 'image/png' : 'image/jpeg', quality);
        if (typeof out === 'string' && out.startsWith('data:')) return out;
    } catch {}
    try {
        const out = canvas.toDataURL();
        if (typeof out === 'string' && out.startsWith('data:')) return out;
    } catch {}
    return '';
};

export const isGifFile = (file) => {
    const type = String(file?.type || '').toLowerCase();
    if (type === 'image/gif') return true;
    const name = String(file?.name || '').toLowerCase();
    return name.endsWith('.gif');
};

export const isReactionImageBytes = header => {
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => header[i] === v);
    const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
    const webp = String.fromCharCode(...header.slice(0, 4)) === 'RIFF' && String.fromCharCode(...header.slice(8, 12)) === 'WEBP';
    return png || jpeg || webp;
};

// 从文件头读出宽高（PNG IHDR / WebP VP8 VP8L VP8X / JPEG SOF），读不出时返回 null
export const readImageHeaderDimensions = bytes => {
    const b = bytes;
    const u16be = i => (b[i] << 8) | b[i + 1];
    const u32be = i => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    if (b.length >= 24 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) return { width: u32be(16), height: u32be(20) };
    if (b.length >= 30 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') {
        const chunk = String.fromCharCode(...b.slice(12, 16));
        if (chunk === 'VP8 ') return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
        if (chunk === 'VP8L') return { width: 1 + (b[21] | ((b[22] & 0x3f) << 8)), height: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) };
        if (chunk === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
        return null;
    }
    if (b[0] === 255 && b[1] === 216) {
        for (let i = 2; i + 9 < b.length;) {
            if (b[i] !== 255) { i += 1; continue; }
            const marker = b[i + 1];
            if (marker === 216 || (marker >= 208 && marker <= 215) || marker === 1 || marker === 255) { i += marker === 255 ? 1 : 2; continue; }
            const length = u16be(i + 2);
            if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) return { width: u16be(i + 7), height: u16be(i + 5) };
            i += 2 + length;
        }
    }
    return null;
};

// APNG 在 IDAT 之前有 acTL 块；动图 WebP 在 VP8X 标志位里带 animation 位
export const isAnimatedImageBytes = bytes => {
    const b = bytes;
    if (b.length >= 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) {
        for (let i = 8; i + 8 <= b.length;) {
            const length = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
            const type = String.fromCharCode(...b.slice(i + 4, i + 8));
            if (type === 'acTL') return true;
            if (type === 'IDAT' || type === 'IEND') return false;
            i += 12 + length;
        }
        return false;
    }
    return b.length >= 21 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 16)) === 'WEBPVP8X' && (b[20] & 0x02) !== 0;
};

// 反应只显示到 96px：像素上限压低到 1600 万，且在解码前按文件头检查，避免一张压得很小但尺寸极大的图把内存小的设备撑爆
export const REACTION_SOURCE_MAX_PIXELS = 16_777_216;

export const reactionDataUrlFromFile = async file => {
    if (!file || file.size > 8 * 1024 * 1024) throw new Error('请选择不超过 8MB 的 PNG、WebP 或 JPEG 图片');
    const header = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
    if (!isReactionImageBytes(header)) throw new Error('自定义反应支持静态 PNG、WebP 或 JPEG 图片');
    const declared = readImageHeaderDimensions(header);
    if (declared && (!declared.width || !declared.height || declared.width * declared.height > REACTION_SOURCE_MAX_PIXELS)) throw new Error('图片尺寸过大，请选择较小的图片');
    const img = await loadImage(await readFileAsDataUrl(file));
    const width = img.naturalWidth, height = img.naturalHeight;
    if (!width || !height || width * height > REACTION_SOURCE_MAX_PIXELS) throw new Error('图片尺寸过大，请选择较小的图片');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('图片处理不可用');
    const scale = Math.min(96 / width, 96 / height);
    ctx.drawImage(img, (96 - width * scale) / 2, (96 - height * scale) / 2, width * scale, height * scale);
    const fits = result => /^data:image\/(webp|png);base64,/.test(result) && atob(result.split(',')[1]).length <= 30 * 1024;
    for (const quality of [.86, .7, .5, .3]) {
        const result = canvasToDataUrl(canvas, { mime: 'image/webp', quality, preserveAlpha: true });
        if (fits(result)) return result;
        // 没有 WebP 编码器时 toDataURL 退回 PNG 且忽略质量，重复尝试结果都一样
        if (result.startsWith('data:image/png')) break;
    }
    // PNG 只能靠缩小画布来减小体积；透明留白保持居中
    for (const size of [80, 64, 48]) {
        const small = document.createElement('canvas');
        small.width = small.height = size;
        const smallCtx = small.getContext('2d', { alpha: true });
        if (!smallCtx) break;
        smallCtx.drawImage(canvas, 0, 0, size, size);
        const result = canvasToDataUrl(small, { mime: 'image/png', preserveAlpha: true });
        if (fits(result)) return result;
    }
    throw new Error('图片压缩后仍超过 30KB，请选择较简单的图片');
};

/**
 * Convert an image File into a compressed dataURL (avatars).
 * - GIF is preserved (no canvas conversion), to keep animation.
 */
export const avatarDataUrlFromFile = async (file, opts = {}) => {
    const maxDim = Number.isFinite(opts.maxDim) ? opts.maxDim : 256;
    const quality = Number.isFinite(opts.quality) ? opts.quality : 0.84;
    const targetMime = String(opts.mime || 'image/webp');
    const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : 400_000; // ~400KB

    if (!file) return '';
    if (isGifFile(file)) {
        // Keep GIF animation (can be large; persistence should rely on save_kv)
        return await readFileAsDataUrl(file);
    }

    const original = await readFileAsDataUrl(file);
    const img = await loadImage(original);

    const w0 = img.naturalWidth || img.width || 1;
    const h0 = img.naturalHeight || img.height || 1;
    const scale = Math.min(1, maxDim / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return original;
    ctx.drawImage(img, 0, 0, w, h);

    // Try a few passes to keep size under maxBytes
    let q = quality;
    let out = canvasToDataUrl(canvas, { mime: targetMime, quality: q }) || original;
    for (let i = 0; i < 4; i++) {
        const approxBytes = Math.ceil((out.length * 3) / 4); // base64 rough
        if (approxBytes <= maxBytes) break;
        q = clamp(q - 0.12, 0.45, 0.92);
        out = canvasToDataUrl(canvas, { mime: targetMime, quality: q }) || out;
    }

    return out || original;
};

/**
 * Compress a data URL image for chat attachments.
 * - Keeps GIF animation (no canvas conversion).
 */
export const compressImageDataUrl = async (dataUrl, opts = {}) => {
    const raw = String(dataUrl || '').trim();
    if (!raw.startsWith('data:image/')) return raw;
    if (raw.startsWith('data:image/gif')) return raw;

    const maxDim = Number.isFinite(opts.maxDim) ? opts.maxDim : 1280;
    const quality = Number.isFinite(opts.quality) ? opts.quality : 0.82;
    const targetMime = String(opts.mime || 'image/jpeg');
    const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : 1_200_000;

    const img = await loadImage(raw);
    const w0 = img.naturalWidth || img.width || 1;
    const h0 = img.naturalHeight || img.height || 1;
    const scale = Math.min(1, maxDim / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return raw;
    ctx.drawImage(img, 0, 0, w, h);

    let q = quality;
    let out = canvasToDataUrl(canvas, { mime: targetMime, quality: q }) || raw;
    for (let i = 0; i < 5; i++) {
        const approxBytes = Math.ceil((out.length * 3) / 4);
        if (approxBytes <= maxBytes) break;
        q = clamp(q - 0.12, 0.4, 0.92);
        out = canvasToDataUrl(canvas, { mime: targetMime, quality: q }) || out;
    }

    return out || raw;
};
