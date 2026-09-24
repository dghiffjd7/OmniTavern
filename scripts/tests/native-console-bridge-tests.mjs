import assert from 'node:assert/strict';

// dev 控制台桥接：先判断再序列化；超过上限不再序列化；warn/error 照旧转发
const invoked = [];
globalThis.window = { location: { protocol: 'http:', hostname: '127.0.0.1', port: '1430' }, addEventListener() {} };
globalThis.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => { invoked.push({ cmd, args }); return null; } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
['log', 'info', 'warn', 'error'].forEach((level) => { console[level] = () => {}; });
let stringified = 0;
const heavy = { toJSON() { stringified += 1; return { big: 'x'.repeat(10) }; } };
try {
  await import('../../src/scripts/utils/native-console-bridge.js');
  await new Promise(resolve => setTimeout(resolve, 0));
  const before = invoked.length;
  console.log('普通日志', heavy);
  assert.equal(stringified, 0, '不需要转发的 log 不序列化对象参数');
  console.info('读取失败', heavy);
  assert.equal(stringified, 1, '确定转发时才序列化');
  console.warn('warn', heavy);
  assert.equal(stringified, 2, 'warn 照旧转发并带上对象内容');
  await new Promise(resolve => setTimeout(resolve, 0));
  const mirrored = invoked.slice(before).filter(item => item.cmd === 'log_js');
  assert.deepEqual(mirrored.map(item => item.args.level), ['info', 'warn'], '只转发含错误字样的 info 与 warn');
  assert.match(mirrored[0].args.message, /读取失败 \{"big"/, '转发的内容仍包含对象参数');
} finally {
  Object.assign(console, originalConsole);
}
console.log('ok - native console bridge only stringifies logs it will mirror');
