import assert from 'node:assert/strict';

import {
  IMPORT_PACKAGE_KINDS,
  decodeImportBase64Text,
  normalizeImportZipEntryName,
  readImportManifestFromEntries,
  isDataBundleDescriptor,
  resolveImportKindFromZipEntries,
} from '../../src/scripts/ui/import-package-kind-utils.js';

const encodeBase64 = value => Buffer.from(String(value), 'utf8').toString('base64');

{
  assert.equal(normalizeImportZipEntryName('manifest.json'), 'manifest.json');
  assert.equal(normalizeImportZipEntryName('nested\\manifest.json'), 'nested/manifest.json');
  assert.equal(normalizeImportZipEntryName('  manifest.json  '), 'manifest.json');
  console.log('ok - normalizeImportZipEntryName trims names and normalizes Windows separators');
}

{
  const text = '{"format":"chatapp.experience-pack.v1","name":"体验包"}';
  assert.equal(decodeImportBase64Text(encodeBase64(text)), text);
  const manifest = readImportManifestFromEntries([
    { name: 'manifest.json', base64: encodeBase64(text) },
  ]);
  assert.deepEqual(manifest, {
    format: 'chatapp.experience-pack.v1',
    name: '体验包',
  });
  console.log('ok - readImportManifestFromEntries reads base64 manifest text');
}

{
  const entries = [
    { name: 'manifest.json', text: '{"format":"chatapp.experience-pack.v1"}' },
  ];
  const result = resolveImportKindFromZipEntries(entries);
  assert.equal(result.kind, IMPORT_PACKAGE_KINDS.EXPERIENCE_PACK);
  assert.equal(result.entries, entries);
  console.log('ok - resolveImportKindFromZipEntries detects experience packs');
}

{
  const entries = [
    { name: 'manifest.json', text: '{"format":"chatapp.custom-bundle.v1"}' },
  ];
  const result = resolveImportKindFromZipEntries(entries);
  assert.equal(result.kind, IMPORT_PACKAGE_KINDS.CUSTOM_BUNDLE);
  assert.equal(result.entries, entries);
  console.log('ok - resolveImportKindFromZipEntries detects custom bundles');
}

{
  // 完整资料包导入会先清空全部资料：只有带 bundle.json（tauri-chat-app-backup-v1）的才算，其余一律「无法识别」
  const backup = { name: 'bundle.json', text: '{"format":"tauri-chat-app-backup-v1","appVersion":"0.7.6"}' };
  assert.equal(resolveImportKindFromZipEntries([backup, { name: 'chat_store_v1.json', text: '{}' }]).kind, IMPORT_PACKAGE_KINDS.BUNDLE);
  assert.equal(resolveImportKindFromZipEntries([{ name: 'nested/manifest.json', text: '{}' }]).kind, IMPORT_PACKAGE_KINDS.UNKNOWN);
  assert.equal(resolveImportKindFromZipEntries([{ name: 'manifest.json', text: '{broken' }]).kind, IMPORT_PACKAGE_KINDS.UNKNOWN);
  assert.equal(resolveImportKindFromZipEntries([{ name: 'manifest.json', text: '{"format":"unknown"}' }]).kind, IMPORT_PACKAGE_KINDS.UNKNOWN);
  assert.equal(resolveImportKindFromZipEntries([{ name: 'bundle.json', text: '{"format":"something-else"}' }]).kind, IMPORT_PACKAGE_KINDS.UNKNOWN);
  assert.equal(resolveImportKindFromZipEntries([{ name: 'photos/a.png', text: '' }]).kind, IMPORT_PACKAGE_KINDS.UNKNOWN, 'an ordinary zip is never treated as a backup');
  assert.equal(resolveImportKindFromZipEntries(null).kind, IMPORT_PACKAGE_KINDS.UNKNOWN);
  assert.equal(isDataBundleDescriptor({ format: 'tauri-chat-app-backup-v1' }), true);
  assert.equal(isDataBundleDescriptor(null), false);
  console.log('ok - only zips identified as backups route to the full-bundle import; others are unknown');
}
