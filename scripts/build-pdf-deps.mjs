// 女仆读 PDF 用的 pdf.js：按 WebView 版本切换，两套都放进 src/vendor/pdf/。
// v6（6.4.299 legacy build）给 Chrome 125 以上；v3（3.11.174 legacy build）给更老的 WebView；中文需要的字符映射表两边共用。
// 只抽文字，不带渲染用的字体与 wasm。
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/vendor/pdf');
const v6 = path.join(root, 'node_modules/pdfjs-dist');
const v3 = path.join(root, 'node_modules/pdfjs-dist-v3');

rmSync(out, { recursive: true, force: true });
for (const dir of ['v6', 'v3', 'cmaps']) mkdirSync(path.join(out, dir), { recursive: true });
copyFileSync(path.join(v6, 'legacy/build/pdf.min.mjs'), path.join(out, 'v6/pdf.min.mjs'));
copyFileSync(path.join(v6, 'legacy/build/pdf.worker.min.mjs'), path.join(out, 'v6/pdf.worker.min.mjs'));
copyFileSync(path.join(v3, 'legacy/build/pdf.min.js'), path.join(out, 'v3/pdf.min.js'));
copyFileSync(path.join(v3, 'legacy/build/pdf.worker.min.js'), path.join(out, 'v3/pdf.worker.min.js'));
let cmapBytes = 0;
for (const name of readdirSync(path.join(v6, 'cmaps'))) {
  if (!name.endsWith('.bcmap')) continue;
  copyFileSync(path.join(v6, 'cmaps', name), path.join(out, 'cmaps', name));
  cmapBytes += readFileSync(path.join(out, 'cmaps', name)).byteLength;
}
const version = dir => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
writeFileSync(path.join(out, 'THIRD_PARTY_LICENSES.txt'),
  `pdfjs-dist ${version(v6)} (v6/, cmaps/) and pdfjs-dist ${version(v3)} (v3/)\n\n${readFileSync(path.join(v6, 'LICENSE'), 'utf8')}`);
const size = file => readFileSync(path.join(out, file)).byteLength;
const total = ['v6/pdf.min.mjs', 'v6/pdf.worker.min.mjs', 'v3/pdf.min.js', 'v3/pdf.worker.min.js'].reduce((sum, file) => sum + size(file), 0) + cmapBytes;
console.log(`pdf.js vendor: ${(total / 1024 / 1024).toFixed(2)} MB (cmaps ${(cmapBytes / 1024 / 1024).toFixed(2)} MB)`);
