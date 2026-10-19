import {
  decodeZipEntryBase64Text,
  findZipEntryByName,
  normalizeZipEntryName,
  readZipEntryJson,
} from './zip-entry-utils.js';

export const IMPORT_PACKAGE_KINDS = Object.freeze({
  BUNDLE: 'bundle',
  EXPERIENCE_PACK: 'experience-pack',
  CUSTOM_BUNDLE: 'custom-bundle',
  UNKNOWN: 'unknown',
});

// 完整资料包（备份）根目录的 bundle.json 标记；导入会先清空全部资料，只认带这个标记的
export const DATA_BUNDLE_FORMAT = 'tauri-chat-app-backup-v1';
export const isDataBundleDescriptor = descriptor => String(descriptor?.format || '').trim() === DATA_BUNDLE_FORMAT;

export const IMPORT_PACKAGE_FORMATS = Object.freeze({
  EXPERIENCE_PACK: 'chatapp.experience-pack.v1',
  CUSTOM_BUNDLE: 'chatapp.custom-bundle.v1',
});

export const normalizeImportZipEntryName = (name = '') =>
  normalizeZipEntryName(name, { trim: true });

export const decodeImportBase64Text = decodeZipEntryBase64Text;

export const readImportManifestFromEntries = (
  entries = [],
  {
    decodeBase64Text = decodeImportBase64Text,
  } = {},
) => {
  const list = Array.isArray(entries) ? entries : [];
  const manifestEntry = findZipEntryByName(list, 'manifest.json', { trimNames: true });
  if (!manifestEntry) return null;
  try {
    return readZipEntryJson(manifestEntry, {
      fallback: null,
      decodeBase64Text,
    });
  } catch {
    return null;
  }
};

export const resolveImportKindFromZipEntries = (
  entries = [],
  options = {},
) => {
  const manifest = readImportManifestFromEntries(entries, options);
  const format = String(manifest?.format || '').trim();
  if (format === IMPORT_PACKAGE_FORMATS.EXPERIENCE_PACK) {
    return { kind: IMPORT_PACKAGE_KINDS.EXPERIENCE_PACK, entries };
  }
  if (format === IMPORT_PACKAGE_FORMATS.CUSTOM_BUNDLE) {
    return { kind: IMPORT_PACKAGE_KINDS.CUSTOM_BUNDLE, entries };
  }
  const list = Array.isArray(entries) ? entries : [];
  const descriptorEntry = findZipEntryByName(list, 'bundle.json', { trimNames: true });
  let descriptor = null;
  try {
    descriptor = descriptorEntry ? readZipEntryJson(descriptorEntry, { fallback: null, decodeBase64Text: options.decodeBase64Text || decodeImportBase64Text }) : null;
  } catch {}
  // 不认识的 zip 不能落到「完整资料包」：那条路会先清空全部资料
  return { kind: isDataBundleDescriptor(descriptor) ? IMPORT_PACKAGE_KINDS.BUNDLE : IMPORT_PACKAGE_KINDS.UNKNOWN, entries };
};
