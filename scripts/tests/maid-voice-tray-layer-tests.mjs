import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => readFile(path.join(root, file), 'utf8');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const zIndexOf = (source, selector) => Number(source.match(new RegExp(`${escape(selector)}\\s*\\{[^}]*?z-index:\\s*(\\d+)`))?.[1]);

// 通话托盘要盖住执行流（创意写作执行进度「图片生成 5/5」曾压在托盘第一张卡上），但仍在女仆输入条下面
const tray = zIndexOf(await read('src/scripts/ui/maid-voice-orb-ui.js'), '.maid-voice-orb-ui');
const flow = zIndexOf(await read('src/scripts/ui/chat/execution-flow-runtime-utils.js'), '.exec-flow-root');
const input = zIndexOf(await read('src/scripts/ui/maid-command-input-runtime-utils.js'), '.maid-command-input');
assert.ok([tray, flow, input].every(Number.isFinite), 'all three layers declare a z-index');
assert.ok(flow < tray, `the call tray (${tray}) sits above the execution flow (${flow})`);
assert.ok(tray < input, `the maid input bar (${input}) stays above the call tray (${tray})`);

console.log('ok - the call tray sits above the execution flow and below the maid input bar');
