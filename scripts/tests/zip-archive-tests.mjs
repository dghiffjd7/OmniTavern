import assert from 'node:assert/strict';

import {
  buildZip,
  findZipEntry,
  listZipEntries,
  normalizeZipEntryPath,
  readZipEntry,
  ZipArchiveError,
} from '../../src/scripts/utils/zip-archive.js';

const text = value => new TextEncoder().encode(value);
const decode = bytes => new TextDecoder().decode(bytes);
const rejectsWith = async (promise, code) => {
  await assert.rejects(promise, error => error instanceof ZipArchiveError && error.code === code);
};
// 把条目名（等长）换成指定字节；可清掉 UTF-8 标志位，用来构造 GBK 文件名、越界路径等真实世界的压缩包
const patchEntry = (zip, from, toBytes, { clearUtf8 = false, setEncrypted = false, size = null } = {}) => {
  const out = zip.slice();
  const dv = new DataView(out.buffer);
  const needle = text(from);
  for (let at = 0; at + 4 <= out.length; at += 1) {
    const sig = dv.getUint32(at, true);
    if (sig !== 0x04034b50 && sig !== 0x02014b50) continue;
    const central = sig === 0x02014b50;
    const nameAt = at + (central ? 46 : 30);
    const nameLength = dv.getUint16(at + (central ? 28 : 26), true);
    if (nameLength !== needle.length || needle.some((byte, i) => out[nameAt + i] !== byte)) continue;
    out.set(toBytes, nameAt);
    const flagsAt = at + (central ? 8 : 6);
    let flags = dv.getUint16(flagsAt, true);
    if (clearUtf8) flags &= ~0x800;
    if (setEncrypted) flags |= 0x1;
    dv.setUint16(flagsAt, flags, true);
    if (size !== null) dv.setUint32(at + (central ? 24 : 22), size, true);
  }
  return out;
};

{
  const zip = await buildZip([
    { path: '资料/说明.md', bytes: text('# 标题\n正文') },
    { path: 'data/空.txt', bytes: new Uint8Array(0) },
    { path: 'bin/random.bin', bytes: Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 251) },
  ]);
  const listing = listZipEntries(zip);
  assert.deepEqual(listing.entries.map(entry => [entry.path, entry.encoding, entry.unsafe]), [
    ['资料/说明.md', 'utf-8', false],
    ['data/空.txt', 'utf-8', false],
    ['bin/random.bin', 'utf-8', false],
  ]);
  assert.equal(listing.fileCount, 3);
  assert.equal(decode(await readZipEntry(zip, findZipEntry(listing, '资料\\说明.md'))), '# 标题\n正文');
  assert.equal((await readZipEntry(zip, listing.entries[1])).byteLength, 0);
  assert.deepEqual(Array.from(await readZipEntry(zip, listing.entries[2])).slice(0, 4), [0, 37, 74, 111]);
  assert.equal(findZipEntry(listing, '资料/说明.MD').path, '资料/说明.md', 'lookups ignore case');
  console.log('ok - zip archive round-trips UTF-8 names, empty and binary entries');
}

{
  // Windows 中文压缩包：没有 UTF-8 标志，文件名是 GBK（「测试.txt」）
  const zip = await buildZip([{ path: 'abcd.txt', bytes: text('内容') }]);
  const gbk = patchEntry(zip, 'abcd.txt', Uint8Array.from([0xb2, 0xe2, 0xca, 0xd4, 0x2e, 0x74, 0x78, 0x74]), { clearUtf8: true });
  const entry = listZipEntries(gbk).entries[0];
  assert.deepEqual([entry.path, entry.encoding], ['测试.txt', 'gb18030']);
  assert.equal(decode(await readZipEntry(gbk, entry)), '内容');
  console.log('ok - zip archive decodes GBK file names from Windows archives');
}

{
  // 不安全路径只列出不读取；加密条目识别；伪造大小的压缩炸弹边解边停
  const zip = await buildZip([
    { path: 'xx/evil.txt', bytes: text('x') },
    { path: 'secret.txt', bytes: text('s') },
    { path: 'bomb.bin', bytes: new Uint8Array(3 * 1024 * 1024) },
  ]);
  let patched = patchEntry(zip, 'xx/evil.txt', text('../evil.txt'));
  patched = patchEntry(patched, 'secret.txt', text('secret.txt'), { setEncrypted: true });
  patched = patchEntry(patched, 'bomb.bin', text('bomb.bin'), { size: 100 });
  const listing = listZipEntries(patched);
  const [evil, secret, bomb] = listing.entries;
  assert.deepEqual([evil.path, evil.unsafe], ['../evil.txt', true], 'an unsafe path is shown as-is so the user sees why it was skipped');
  await rejectsWith(readZipEntry(patched, evil), 'unsafe_path');
  assert.equal(secret.encrypted, true);
  await rejectsWith(readZipEntry(patched, secret), 'encrypted');
  await rejectsWith(readZipEntry(patched, bomb, { maxBytes: 1024 * 1024 }), 'entry_too_large');
  await rejectsWith(readZipEntry(zip, listZipEntries(zip).entries[2], { maxBytes: 1024 }), 'entry_too_large');
  console.log('ok - zip archive refuses unsafe paths, encrypted entries and oversized output');
}

{
  assert.deepEqual(normalizeZipEntryPath('./a//b\\c.txt'), { path: 'a/b/c.txt', unsafe: false });
  assert.equal(normalizeZipEntryPath('C:/windows/x').unsafe, true);
  assert.equal(normalizeZipEntryPath('/etc/passwd').unsafe, true);
  assert.throws(() => listZipEntries(text('not a zip at all')), error => error.code === 'not_a_zip');
  const many = await buildZip(Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.txt`, bytes: text('x') })));
  assert.throws(() => listZipEntries(many, { maxEntries: 5 }), error => error.code === 'too_many_entries');
  await assert.rejects(buildZip([{ path: '../x.txt', bytes: text('x') }]), error => error.code === 'unsafe_path');
  console.log('ok - zip archive normalizes paths and enforces entry limits');
}
