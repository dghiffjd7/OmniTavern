// PDF 文字提取（女仆通用文件处理第二期）。pdf.js 按 WebView 版本切换：
// Chrome 125 以上（桌面 WebView2、多数手机）用 6.x，更老的 WebView 用 3.11（src/vendor/pdf，见 scripts/build-pdf-deps.mjs）。
// 只抽文字层，不渲染；isEvalSupported 关闭，堵住 3.11 的字体代码执行漏洞（CVE-2024-4367），6.x 也照样关。

const VENDOR_URL = new URL('../../vendor/pdf/', import.meta.url);
export const PDF_MODERN_MIN_CHROME = 125;

// 非浏览器环境（Node 测试）：6.x 要 Node 22.13 以上，更老的 Node 用 3.11 的 CommonJS 版
const nodeSupportsV6 = (version = '') => {
  const [major, minor] = String(version).split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
};

export const pickPdfjsVersion = ({
  userAgent = globalThis.navigator?.userAgent || '',
  hasDocument = typeof document !== 'undefined',
  nodeVersion = globalThis.process?.versions?.node || '',
} = {}) => {
  if (!hasDocument) return nodeSupportsV6(nodeVersion) ? 'v6' : 'v3';
  const match = /Chrome\/(\d+)/.exec(userAgent);
  return match && Number(match[1]) >= PDF_MODERN_MIN_CHROME ? 'v6' : 'v3';
};

const loadV6 = async () => {
  const lib = await import(new URL('v6/pdf.min.mjs', VENDOR_URL).href);
  lib.GlobalWorkerOptions.workerSrc = new URL('v6/pdf.worker.min.mjs', VENDOR_URL).href;
  return lib;
};

// 3.11 只有 UMD 版：用普通 script 载入，它会写到 globalThis.pdfjsLib。
// 6.x 也会占用这个全局名：取到 3.x 的对象后把全局恢复原样，两版互不干扰。
const isV3 = lib => typeof lib?.getDocument === 'function' && String(lib.version || '').startsWith('3.');
const loadV3 = () => new Promise((resolve, reject) => {
  const ready = (lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL('v3/pdf.worker.min.js', VENDOR_URL).href;
    resolve(lib);
  };
  if (isV3(globalThis.pdfjsLib)) {
    ready(globalThis.pdfjsLib);
    return;
  }
  const previous = globalThis.pdfjsLib;
  const script = document.createElement('script');
  script.src = new URL('v3/pdf.min.js', VENDOR_URL).href;
  script.onload = () => {
    const lib = globalThis.pdfjsLib;
    if (previous === undefined) delete globalThis.pdfjsLib;
    else globalThis.pdfjsLib = previous;
    if (!isV3(lib)) {
      reject(new Error('pdf.js 3.11 载入失败'));
      return;
    }
    ready(lib);
  };
  script.onerror = () => reject(new Error('pdf.js 3.11 载入失败'));
  document.head.append(script);
});

// Node 里的 3.11：UMD 文件 require 后同样挂在 globalThis.pdfjsLib（同上取用后恢复）。
// 它在 Node 里找不到 worker 的载入方式，会退回浏览器的载入法；先 require worker，让它用全局的 pdfjsWorker。
const loadNodeV3 = async () => {
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const require = createRequire(import.meta.url);
  require(fileURLToPath(new URL('v3/pdf.worker.min.js', VENDOR_URL)));
  const previous = globalThis.pdfjsLib;
  const exported = require(fileURLToPath(new URL('v3/pdf.min.js', VENDOR_URL)));
  const lib = isV3(exported) ? exported : globalThis.pdfjsLib;
  if (previous === undefined) delete globalThis.pdfjsLib;
  else globalThis.pdfjsLib = previous;
  if (!isV3(lib)) throw new Error('pdf.js 3.11 载入失败');
  lib.GlobalWorkerOptions.workerSrc = fileURLToPath(new URL('v3/pdf.worker.min.js', VENDOR_URL));
  return lib;
};

const loaders = new Map();
const loadPdfjs = (version) => {
  if (!loaders.has(version)) {
    const load = version === 'v6' ? loadV6 : (typeof document === 'undefined' ? loadNodeV3 : loadV3);
    loaders.set(version, load().catch((error) => {
      loaders.delete(version);
      throw error;
    }));
  }
  return loaders.get(version);
};

const PAGE_MARK_RE = /^\[第 \d+ 页\]\n/;

/**
 * 输入：PDF 字节。每页前加「[第 N 页]」，让按行读取与检索能对回页码。
 * 返回 { ok, text, pages, readPages, truncated, noTextLayer, version } 或 { ok: false, reason, message }。
 */
export const extractPdfText = async (bytes, { maxPages = 500, maxChars = 2_000_000, version = pickPdfjsVersion() } = {}) => {
  const lib = await loadPdfjs(version);
  // getDocument 会把数据转交给 worker（原缓冲区被拿走），所以传副本
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: new URL('cmaps/', VENDOR_URL).href,
    cMapPacked: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy?.();
    if (error?.name === 'PasswordException') return { ok: false, reason: 'pdf_encrypted', message: 'PDF 有密码，无法读取' };
    return { ok: false, reason: 'pdf_unreadable', message: String(error?.message || 'PDF 无法解析') };
  }
  const blocks = [];
  let chars = 0;
  let readPages = 0;
  try {
    for (let n = 1; n <= Math.min(doc.numPages, maxPages) && chars < maxChars; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        if (typeof item.str === 'string') pageText += item.str;
        if (item.hasEOL) pageText += '\n';
      }
      page.cleanup?.();
      const block = `[第 ${n} 页]\n${pageText.trim()}`;
      blocks.push(block);
      chars += block.length + 2;
      readPages = n;
    }
  } finally {
    await task.destroy?.();
  }
  return {
    ok: true,
    text: blocks.join('\n\n').slice(0, maxChars),
    pages: doc.numPages,
    readPages,
    truncated: readPages < doc.numPages || chars > maxChars,
    noTextLayer: !blocks.some(block => block.replace(PAGE_MARK_RE, '').trim()),
    version,
  };
};
