import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import {
  readZipManifestFromBlob,
  readZipRootJsonFromBlob,
  uploadBlobForImport,
} from '../../src/scripts/ui/large-import-file-utils.js';

// 最小的 zip 写入器：stored / deflate 两种压缩，可选写成 ZIP64 结尾（条目数、目录位置填 0xFFFF…）
const buildZip = (files, { zip64 = false } = {}) => {
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
  const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; };
  const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
  for (const { name, data, deflate = false } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const body = deflate ? deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0),
      u32(body.length), u32(raw.length), u16(nameBytes.length), u16(0), nameBytes,
    ]);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0),
      u32(body.length), u32(raw.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), nameBytes,
    ]));
    chunks.push(local, body);
    offset += local.length + body.length;
  }
  const cd = Buffer.concat(central);
  const cdOffset = offset;
  const tail = [];
  if (zip64) {
    const zip64EocdOffset = cdOffset + cd.length;
    tail.push(Buffer.concat([
      u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0),
      u64(files.length), u64(files.length), u64(cd.length), u64(cdOffset),
    ]));
    tail.push(Buffer.concat([u32(0x07064b50), u32(0), u64(zip64EocdOffset), u32(1)]));
    tail.push(Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(0xffff), u16(0xffff), u32(0xffffffff), u32(0xffffffff), u16(0),
    ]));
  } else {
    tail.push(Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(cdOffset), u16(0),
    ]));
  }
  return new Blob([...chunks, cd, ...tail]);
};

const manifest = format => JSON.stringify({ format, name: '测试包' });

{
  // 只读 zip 末尾的目录就找到 manifest.json：压缩或不压缩、ZIP64 都能读
  const custom = await readZipManifestFromBlob(buildZip([
    { name: 'assets/a.png', data: Buffer.alloc(1000, 7) },
    { name: 'manifest.json', data: manifest('chatapp.custom-bundle.v1'), deflate: true },
  ]));
  assert.deepEqual(custom, { ok: true, manifest: { format: 'chatapp.custom-bundle.v1', name: '测试包' } });
  const stored = await readZipManifestFromBlob(buildZip([{ name: 'manifest.json', data: manifest('chatapp.experience-pack.v1') }]));
  assert.equal(stored.manifest.format, 'chatapp.experience-pack.v1');
  const zip64 = await readZipManifestFromBlob(buildZip([
    { name: 'chat_store_v1.json', data: '{}' },
    { name: 'manifest.json', data: manifest('chatapp.custom-bundle.v1'), deflate: true },
  ], { zip64: true }));
  assert.equal(zip64.manifest.format, 'chatapp.custom-bundle.v1');
  console.log('ok - the manifest is read from the zip directory at the end of the file');
}

{
  // 完整资料包没有 manifest.json：读成功、manifest 为空；放在子目录里的不算；不是 zip 就读不出
  const bundle = await readZipManifestFromBlob(buildZip([
    { name: 'bundle.json', data: '{}' },
    { name: 'sub/manifest.json', data: manifest('chatapp.custom-bundle.v1') },
  ]));
  assert.deepEqual(bundle, { ok: true, manifest: null });
  // 识别完整资料包用根目录的 bundle.json（只读目录与这一项，不读整份大文件）
  const backup = await readZipRootJsonFromBlob(buildZip([
    { name: 'chat_store_v1.json', data: '{}' },
    { name: 'bundle.json', data: JSON.stringify({ format: 'tauri-chat-app-backup-v1' }), deflate: true },
  ]), 'bundle.json');
  assert.deepEqual(backup, { ok: true, json: { format: 'tauri-chat-app-backup-v1' } });
  assert.deepEqual(await readZipRootJsonFromBlob(buildZip([{ name: 'a.txt', data: 'x' }]), 'bundle.json'), { ok: true, json: null });
  const notZip = await readZipManifestFromBlob(new Blob(['这不是 zip 文件'.repeat(10)]));
  assert.equal(notZip.ok, false);
  const brokenManifest = await readZipManifestFromBlob(buildZip([{ name: 'manifest.json', data: '{not json' }]));
  assert.deepEqual(brokenManifest, { ok: true, manifest: null });
  console.log('ok - full bundles without a manifest and non-zip files are told apart');
}

{
  // 130MB 的资料包：旧做法会把整个文件转成数组（超过上限就报 Invalid array length），现在只读结尾和 manifest
  const big = buildZip([
    { name: 'attachments/big.bin', data: Buffer.alloc(130 * 1024 * 1024, 1) },
    { name: 'chat_store_v1.json', data: '{}' },
  ]);
  const started = Date.now();
  assert.deepEqual(await readZipManifestFromBlob(big), { ok: true, manifest: null });
  assert.ok(Date.now() - started < 2000);
  console.log('ok - a 130MB bundle is identified without loading the whole file');
}

{
  // 分块上传：begin 拿到路径，按块追加 base64，最后核对大小；出错时丢掉临时文件
  const calls = [];
  const written = [];
  const invoke = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'import_upload_begin') return '/cache/import-upload/upload-1.zip';
    if (cmd === 'import_upload_append') {
      written.push(...Buffer.from(args.data, 'base64'));
      return written.length;
    }
    return null;
  };
  const source = Buffer.from(Array.from({ length: 10 }, (_, k) => k));
  const progress = [];
  const path = await uploadBlobForImport(new Blob([source]), { invoke, chunkSize: 4, onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(path, '/cache/import-upload/upload-1.zip');
  assert.deepEqual(written, [...source]);
  assert.deepEqual(calls, ['import_upload_begin', 'import_upload_append', 'import_upload_append', 'import_upload_append']);
  assert.deepEqual(progress, [[4, 10], [8, 10], [10, 10]]);

  const failing = [];
  const brokenInvoke = async (cmd) => {
    failing.push(cmd);
    if (cmd === 'import_upload_begin') return '/cache/import-upload/upload-2.zip';
    if (cmd === 'import_upload_append') return 3;
    return null;
  };
  await assert.rejects(uploadBlobForImport(new Blob([source]), { invoke: brokenInvoke, chunkSize: 4 }), /大小不一致/);
  assert.equal(failing[failing.length - 1], 'import_upload_discard');
  console.log('ok - large files are uploaded in base64 chunks and checked for size');
}
