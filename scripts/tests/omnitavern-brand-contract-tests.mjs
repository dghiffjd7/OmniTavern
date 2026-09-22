import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = relativePath => readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');

const [
  packageJsonText,
  packageLockText,
  tauriConfigText,
  tauriDevConfigText,
  cargoToml,
  cargoLock,
  rustMain,
  androidGradle,
  androidStrings,
  androidMain,
  indexHtml,
  readme,
  docsIndex,
  openRouter,
  webSearchTools,
  generalSettingsPanel,
  commandsRs,
  characterTransfer,
  experienceTransfer,
  customBundleExporter,
  iframeHost,
  bridgeSource,
] = await Promise.all([
  read('package.json'),
  read('package-lock.json'),
  read('src-tauri/tauri.conf.json'),
  read('src-tauri/tauri.conf.dev.json'),
  read('src-tauri/Cargo.toml'),
  read('src-tauri/Cargo.lock'),
  read('src-tauri/src/main.rs'),
  read('src-tauri/gen/android/app/build.gradle.kts'),
  read('src-tauri/gen/android/app/src/main/res/values/strings.xml'),
  read('src-tauri/gen/android/app/src/main/java/com/chatapp/dev/MainActivity.kt'),
  read('src/index.html'),
  read('README.md'),
  read('docs/index.html'),
  read('src/scripts/api/providers/openrouter.js'),
  read('src/scripts/agent/tools/web-search-tools.js'),
  read('src/scripts/ui/general-settings-panel.js'),
  read('src-tauri/src/commands.rs'),
  read('src/scripts/ui/character-card-transfer.js'),
  read('src/scripts/ui/experience-pack-transfer.js'),
  read('src/scripts/ui/custom-bundle-exporter.js'),
  read('src/iframe-host.js'),
  read('src/scripts/ui/bridge.js'),
]);

const packageJson = JSON.parse(packageJsonText);
const packageLock = JSON.parse(packageLockText);
const tauriConfig = JSON.parse(tauriConfigText);
const tauriDevConfig = JSON.parse(tauriDevConfigText);

{
  assert.equal(packageJson.name, 'omnitavern');
  assert.equal(packageJson.version, '0.7.3-diagnose-1');
  assert.equal(packageLock.name, 'omnitavern');
  assert.equal(packageLock.version, '0.7.3-diagnose-1');
  assert.equal(packageLock.packages?.['']?.name, 'omnitavern');
  assert.equal(packageLock.packages?.['']?.version, '0.7.3-diagnose-1');
  assert.equal(tauriConfig.productName, 'OmniTavern');
  assert.equal(tauriConfig.version, '0.7.3-diagnose-1');
  assert.equal(tauriConfig.bundle?.android?.versionCode, 7011);
  assert.equal(tauriConfig.app?.windows?.[0]?.title, 'OmniTavern');
  assert.match(cargoToml, /^name = "omnitavern"$/m);
  assert.match(cargoToml, /^version = "0\.7\.3-diagnose-1"$/m);
  assert.match(cargoToml, /^name = "omnitavern_lib"$/m);
  assert.match(rustMain, /omnitavern_lib::run\(\)/);
  assert.match(cargoLock, /name = "omnitavern"\s+version = "0\.7\.3-diagnose-1"/);
  console.log('ok - OmniTavern product package crate binary and release version stay synchronized');
}

{
  assert.equal(tauriConfig.identifier, 'com.chatapp.dev');
  assert.equal(tauriDevConfig.identifier, 'com.chatapp.dev.debug');
  assert.match(androidGradle, /namespace = "com\.chatapp\.dev"/);
  assert.match(androidGradle, /applicationId = "com\.chatapp\.dev"/);
  assert.match(androidGradle, /applicationIdSuffix = "\.debug"/);
  assert.match(androidMain, /^package com\.chatapp\.dev$/m);
  assert.match(commandsRs, /"format": "tauri-chat-app-backup-v1"/);
  assert.match(commandsRs, /omnitavern_backup_\{ts\}\.zip/);
  assert.match(generalSettingsPanel, /omnitavern_backup_\$\{ts\}\.zip/);
  assert.match(characterTransfer, /format: 'chatapp\.card\.v1'/);
  assert.match(experienceTransfer, /const EXPERIENCE_PACK_FORMAT = 'chatapp\.experience-pack\.v1'/);
  assert.match(customBundleExporter, /const CUSTOM_BUNDLE_FORMAT = 'chatapp\.custom-bundle\.v1'/);
  assert.match(iframeHost, /window\.ChatAppRichCompat/);
  assert.match(iframeHost, /__CHATAPP_registerRuntimeBlobMeta/);
  assert.match(iframeHost, /data-chatapp-layout-ignore/);
  assert.match(iframeHost, /chatapp:iframe-ready/);
  assert.match(bridgeSource, /Symbol\.for\('tauri-chat-app\.worldinfo-revision'\)/);
  console.log('ok - legacy chatapp identity storage export and script contracts remain unchanged');
}

{
  assert.match(androidStrings, /<string name="app_name">OmniTavern<\/string>/);
  assert.match(androidStrings, /<string name="main_activity_title">OmniTavern<\/string>/);
  assert.match(androidGradle, /resValue\("string", "app_name", "OmniTavern Dev"\)/);
  assert.match(androidGradle, /resValue\("string", "main_activity_title", "OmniTavern Dev"\)/);
  assert.match(indexHtml, /<title>OmniTavern<\/title>/);
  assert.match(indexHtml, /<strong>OmniTavern · Aria<\/strong>/);
  assert.match(readme, /^# OmniTavern$/m);
  assert.match(docsIndex, /<title>OmniTavern 下载<\/title>/);
  assert.match(docsIndex, /<h1>OmniTavern<\/h1>/);
  assert.match(openRouter, /const DEFAULT_APP_TITLE = 'OmniTavern'/);
  assert.doesNotMatch(openRouter, /https:\/\/tauri-chat-app\.local/);
  assert.match(webSearchTools, /OmniTavern-Maid-Assistant\/0\.7\.3-diagnose-1/);
  console.log('ok - desktop Android docs provider attribution and visible shell use OmniTavern');
}
