import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const releaseScript = await readFile(new URL('../release.ps1', import.meta.url), 'utf8');
const scripts = packageJson.scripts || {};

const splitScriptSteps = script =>
  String(script || '')
    .split('&&')
    .map(step => step.trim())
    .filter(Boolean);

{
  assert.equal(typeof scripts.dev, 'string');
  assert.equal(typeof scripts.build, 'string');
  assert.equal(typeof scripts['check:fast'], 'string');
  assert.equal(typeof scripts['test:rust:zip'], 'string');
  assert.equal(scripts.dev.includes('tauri dev'), true);
  assert.equal(scripts.build.includes('tauri build'), true);
  assert.equal(scripts['check:fast'].includes('cargo check --manifest-path src-tauri/Cargo.toml'), true);
  assert.equal(scripts['test:rust:zip'], 'cargo test --manifest-path src-tauri/Cargo.toml zip -- --nocapture');
  console.log('ok - release gate scripts preserve dev build and cargo check entry points');
}

{
  assert.match(releaseScript, /\[switch\]\$SkipPreflight/);
  const preflightIndex = releaseScript.indexOf('npm run test:all');
  const rustZipIndex = releaseScript.indexOf('npm run test:rust:zip');
  const buildIndex = releaseScript.indexOf('npm run android:build');
  const releaseIndex = releaseScript.indexOf('gh release');
  assert.ok(preflightIndex >= 0, 'release.ps1 should run npm run test:all by default');
  assert.ok(rustZipIndex > preflightIndex, 'rust zip contract should run after test:all');
  assert.ok(buildIndex > rustZipIndex, 'release preflight should run before android build');
  assert.ok(releaseIndex > buildIndex, 'android build should run before gh release');
  console.log('ok - release.ps1 runs test:all and rust zip preflight before android build and gh release');
}

{
  const steps = splitScriptSteps(scripts['test:all']);
  assert.deepEqual(steps, [
    'npm run test:brand',
    'npm run test:i18n',
    'npm run test:maid-onboarding',
    'npm run test:agent',
    'npm run test:contact-profile',
    'npm run test:maid-memory',
    'npm run test:role-worldbook',
    'npm run test:web-search',
    'npm run test:chat',
    'npm run test:memory',
    'npm run test:variables',
    'npm run test:cancel',
    'npm run test:moments',
    'npm run test:sessions',
    'npm run test:integration',
    'npm run test:transfer',
    'npm run test:migration',
    'npm run test:release',
    'npm run test:theme',
    'npm run test:maid-extensions',
  ]);
  console.log('ok - test:all keeps brand i18n maid-onboarding agent contact-profile maid-memory role-worldbook web-search chat memory variables cancel moments sessions integration transfer migration release and theme gates');
}

{
  const integrationSteps = splitScriptSteps(scripts['test:integration']);
  assert.deepEqual(integrationSteps, [
    'node scripts/tests/lifecycle-trace-integration.mjs',
    'node scripts/tests/plugin-hook-lifecycle-integration.mjs',
    'node scripts/tests/session-enter-lifecycle-integration.mjs',
    'node scripts/tests/send-cancel-regenerate-integration.mjs',
    'node scripts/tests/memory-lifecycle-integration.mjs',
    'node scripts/tests/settings-lifecycle-integration.mjs',
    'node scripts/tests/moments-lifecycle-integration.mjs',
  ]);
  console.log('ok - test:integration preserves the seven high-risk lifecycle regression scripts');
}

{
  const chatUiSteps = splitScriptSteps(scripts['test:chat-ui']);
  assert.equal(chatUiSteps.includes('node scripts/tests/app-bridge-contract-tests.mjs'), true);
  assert.equal(chatUiSteps.includes('node scripts/tests/app-bridge-inventory-tests.mjs'), true);
  const contractIndex = chatUiSteps.indexOf('node scripts/tests/app-bridge-contract-tests.mjs');
  const inventoryIndex = chatUiSteps.indexOf('node scripts/tests/app-bridge-inventory-tests.mjs');
  assert.ok(inventoryIndex > contractIndex, 'bridge inventory should run after bridge contract tests');
  console.log('ok - chat-ui gate keeps bridge contract and inventory audits together');
}

{
  const agentSteps = splitScriptSteps(scripts['test:agent']);
  assert.equal(agentSteps.includes('node scripts/tests/maid-source-grounding-tests.mjs'), true);
  assert.equal(agentSteps.includes('node scripts/tests/maid-visual-spec-tests.mjs'), true);

  const variableSteps = splitScriptSteps(scripts['test:variables']);
  assert.equal(variableSteps.includes('node scripts/tests/world-session-visibility-utils-tests.mjs'), true);
  console.log('ok - source grounding visual continuity and RP world visibility tests stay wired into release gates');
}

{
  const chatGenerationSteps = splitScriptSteps(scripts['test:chat-generation']);
  assert.equal(chatGenerationSteps.includes('node scripts/tests/lifecycle-trace-utils-tests.mjs'), true);
  assert.equal(chatGenerationSteps.includes('node scripts/tests/send-flow-utils-tests.mjs'), true);
  assert.equal(chatGenerationSteps.includes('node scripts/tests/generation-state-utils-tests.mjs'), true);
  assert.equal(chatGenerationSteps.includes('node scripts/tests/continuation-message-utils-tests.mjs'), true);
  assert.equal(chatGenerationSteps.includes('node scripts/tests/plugin-message-bridge-utils-tests.mjs'), true);

  const chatMemorySteps = splitScriptSteps(scripts['test:chat-memory']);
  assert.equal(chatMemorySteps.includes('node scripts/tests/memory-update-runtime-tests.mjs'), true);
  assert.equal(chatMemorySteps.includes('node scripts/tests/memory-table-action-utils-tests.mjs'), true);

  const chatMomentsSteps = splitScriptSteps(scripts['test:chat-moments']);
  assert.equal(chatMomentsSteps.includes('node scripts/tests/moments-runtime-utils-tests.mjs'), true);

  const sessionEnterSteps = splitScriptSteps(scripts['test:session-enter']);
  assert.equal(sessionEnterSteps.includes('node scripts/tests/session-enter-runtime-tests.mjs'), true);

  console.log('ok - Phase C lifecycle domain gates keep unit coverage wired');
}

{
  const transferSteps = splitScriptSteps(scripts['test:transfer']);
  assert.deepEqual(transferSteps, [
    'node scripts/tests/regex-transfer-tests.mjs',
    'node scripts/tests/mobile-export-download-contract-tests.mjs',
    'node scripts/tests/zip-entry-utils-tests.mjs',
    'node scripts/tests/import-package-kind-utils-tests.mjs',
    'node scripts/tests/transfer-worldbook-utils-tests.mjs',
    'node scripts/tests/worldbook-import-conflict-utils-tests.mjs',
    'node scripts/tests/import-name-conflict-utils-tests.mjs',
    'node scripts/tests/experience-pack-export-utils-tests.mjs',
    'node scripts/tests/experience-pack-import-utils-tests.mjs',
    'node scripts/tests/preset-import-dedupe-utils-tests.mjs',
    'node scripts/tests/custom-bundle-worldbook-utils-tests.mjs',
    'node scripts/tests/custom-bundle-manifest-utils-tests.mjs',
    'node scripts/tests/custom-bundle-room-entry-utils-tests.mjs',
    'node scripts/tests/custom-bundle-conversation-utils-tests.mjs',
    'node scripts/tests/custom-bundle-import-room-utils-tests.mjs',
    'node scripts/tests/custom-bundle-import-preview-utils-tests.mjs',
    'node scripts/tests/custom-bundle-import-diagnostics-utils-tests.mjs',
    'node scripts/tests/custom-bundle-rp-greeting-utils-tests.mjs',
    'node scripts/tests/transfer-package-contract-tests.mjs',
    'node scripts/tests/tauri-invoke-timeout-tests.mjs',
  ]);
  assert.deepEqual(splitScriptSteps(scripts['test:migration']), [
    'node scripts/tests/app-settings-kv-tests.mjs',
    'node scripts/tests/storage-migration-contracts-tests.mjs',
    'node scripts/tests/vertexai-config-tests.mjs',
    'node scripts/tests/chat-store-large-field-tests.mjs',
    'node scripts/tests/chat-store-format-repair-envelope-tests.mjs',
    'node scripts/tests/chat-store-scope-guard-tests.mjs',
    'node scripts/tests/chat-store-thread-reset-window-tests.mjs',
    'node scripts/tests/kv-too-large-guard-tests.mjs',
    'node scripts/tests/preset-store-shard-load-tests.mjs',
    'node scripts/tests/worldinfo-store-read-safety-tests.mjs',
    'node scripts/tests/legacy-state-tie-utils-tests.mjs',
    'node scripts/tests/rp-session-store-storage-tier-tests.mjs',
  ]);
  console.log('ok - transfer and migration release gates preserve package and storage contract tests');
}
