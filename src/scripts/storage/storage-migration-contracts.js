import { makeScopedKey, normalizeScopeId } from './store-scope.js';

const freezeContract = contract => Object.freeze({
  legacyReadKeys: [],
  writeTargets: [],
  importExportSurfaces: [],
  tests: [],
  ...contract,
});

export const STORAGE_MIGRATION_CONTRACTS = Object.freeze([
  freezeContract({
    id: 'contacts',
    owner: 'ContactsStore',
    currentKey: 'contacts_store_v1',
    scopeStrategy: 'scoped-with-legacy-migration',
    legacyMigrationKey: 'contacts_store_v1__scoped_migrated',
    legacyReadKeys: ['contacts_store_v1'],
    writeTargets: ['contacts_store_v1__<scope>'],
    payloadVersion: 1,
    risk: 'high',
    importExportSurfaces: ['custom-bundle', 'persona-reset', 'character-card'],
    tests: ['settings-lifecycle-integration', 'transfer-package-contract-tests'],
  }),
  freezeContract({
    id: 'groups',
    owner: 'GroupStore',
    currentKey: 'contact_groups_v1',
    scopeStrategy: 'scoped-with-legacy-migration',
    legacyMigrationKey: 'contact_groups_v1__scoped_migrated',
    legacyReadKeys: ['contact_groups_v1'],
    writeTargets: ['contact_groups_v1__<scope>'],
    payloadVersion: 1,
    risk: 'high',
    importExportSurfaces: ['custom-bundle', 'persona-reset'],
    tests: ['settings-lifecycle-integration'],
  }),
  freezeContract({
    id: 'moments',
    owner: 'MomentsStore',
    currentKey: 'moments_store_v1',
    scopeStrategy: 'scoped-with-legacy-migration',
    legacyMigrationKey: 'moments_store_v1__scoped_migrated',
    legacyReadKeys: ['moments_store_v1'],
    writeTargets: ['moments_store_v1__<scope>'],
    payloadVersion: 1,
    risk: 'high',
    importExportSurfaces: ['custom-bundle', 'moments-panel'],
    tests: ['moments-lifecycle-integration', 'transfer-package-contract-tests'],
  }),
  freezeContract({
    id: 'moment-summaries',
    owner: 'MomentSummaryStore',
    currentKey: 'moment_summary_store_v1',
    scopeStrategy: 'scoped-with-legacy-migration',
    legacyMigrationKey: 'moment_summary_store_v1__scoped_migrated',
    legacyReadKeys: ['moment_summary_store_v1'],
    writeTargets: ['moment_summary_store_v1__<scope>'],
    payloadVersion: 1,
    risk: 'high',
    importExportSurfaces: ['custom-bundle', 'moments-summary'],
    tests: ['moments-lifecycle-integration'],
  }),
  freezeContract({
    id: 'world-session-map',
    owner: 'AppBridge',
    currentKey: 'world_session_map_v1',
    scopeStrategy: 'scoped',
    legacyReadKeys: ['world_session_map_v1'],
    writeTargets: ['world_session_map_v1__<scope>'],
    payloadVersion: 1,
    risk: 'high',
    importExportSurfaces: ['custom-bundle', 'world-panel'],
    tests: ['transfer-package-contract-tests'],
  }),
  freezeContract({
    id: 'world-global-id',
    owner: 'AppBridge',
    currentKey: 'global_world_ids_shared_v1',
    scopeStrategy: 'shared-with-scoped-legacy-read',
    legacyReadKeys: ['global_world_id_shared_v1', 'global_world_id_v1__<scope>'],
    writeTargets: ['global_world_ids_shared_v1', 'global_world_id_shared_v1'],
    payloadVersion: 2,
    risk: 'high',
    importExportSurfaces: ['custom-bundle', 'world-panel'],
    tests: ['transfer-package-contract-tests'],
  }),
  freezeContract({
    id: 'world-global-settings',
    owner: 'AppBridge',
    currentKey: 'world_global_settings_shared_v1',
    scopeStrategy: 'shared-with-scoped-legacy-read',
    legacyReadKeys: ['world_global_settings_v1__<scope>'],
    writeTargets: ['world_global_settings_shared_v1'],
    payloadVersion: 1,
    risk: 'high',
    importExportSurfaces: ['custom-bundle', 'world-panel'],
    tests: ['transfer-package-contract-tests'],
  }),
  freezeContract({
    id: 'turn-checkpoints',
    owner: 'TurnCheckpointStore',
    currentKey: 'turn_checkpoint_v1',
    scopeStrategy: 'session-and-scope-keyed',
    writeTargets: ['turn_checkpoint_v1__<session>__<scope>'],
    payloadVersion: 1,
    risk: 'high',
    importExportSurfaces: ['new-chat-archive', 'swipe-memory-state'],
    tests: ['turn-checkpoint-store-tests', 'turn-checkpoint-storage-tier-tests'],
  }),
  freezeContract({
    id: 'memory-snapshots',
    owner: 'MemorySnapshotStore',
    currentKey: 'memory_snapshot_payload_v1',
    scopeStrategy: 'ref-and-payload',
    writeTargets: ['memory_snapshot_refs_v1__<scope>', 'memory_snapshot_payload_v1__<scope>'],
    payloadVersion: 1,
    risk: 'high',
    importExportSurfaces: ['turn-checkpoint', 'memory-rollback'],
    tests: ['turn-checkpoint-store-tests', 'memory-snapshot-storage-tier-tests', 'memory-lifecycle-integration'],
  }),
  freezeContract({
    id: 'regex',
    owner: 'RegexStore',
    currentKey: 'regex_store_v1',
    scopeStrategy: 'shared',
    writeTargets: ['regex_store_v1'],
    payloadVersion: 1,
    risk: 'medium',
    importExportSurfaces: ['character-card', 'experience-pack', 'custom-bundle'],
    tests: ['regex-transfer-tests', 'transfer-package-contract-tests'],
  }),
  freezeContract({
    id: 'prompt-presets',
    owner: 'PresetStore',
    currentKey: 'prompt_preset_store_v2_index',
    scopeStrategy: 'shared-index-and-items-with-legacy-read',
    legacyReadKeys: ['prompt_preset_store_v1'],
    writeTargets: ['prompt_preset_store_v2_index', 'prompt_preset_store_v2_item_<type>_<hash>_<id>'],
    payloadVersion: 2,
    risk: 'medium',
    importExportSurfaces: ['experience-pack', 'custom-bundle'],
    tests: ['kv-too-large-guard-tests', 'transfer-package-contract-tests'],
  }),
  freezeContract({
    id: 'scripts',
    owner: 'ScriptStore',
    currentKey: 'script_store_v2_index',
    scopeStrategy: 'shared-index-and-items-with-legacy-read',
    legacyReadKeys: ['script_store_v1'],
    writeTargets: ['script_store_v2_index', 'script_store_v2_item_<scope>_<hash>_<id>'],
    payloadVersion: 2,
    risk: 'medium',
    importExportSurfaces: ['character-card', 'preset-file'],
    tests: ['script-store-shard-tests', 'script-store-scope-tests'],
  }),
  freezeContract({
    id: 'plugins',
    owner: 'PluginStore',
    currentKey: 'plugin_store_v1',
    scopeStrategy: 'shared-registry-plus-storage',
    writeTargets: ['plugin_store_v1', 'plugin_storage_v1'],
    payloadVersion: 1,
    risk: 'medium',
    importExportSurfaces: ['plugin-panel'],
    tests: ['plugin-store-contract-future'],
  }),
]);

export const listStorageMigrationContracts = ({
  risk = '',
  scopeStrategy = '',
} = {}) => {
  const riskFilter = String(risk || '').trim();
  const scopeFilter = String(scopeStrategy || '').trim();
  return STORAGE_MIGRATION_CONTRACTS.filter((contract) => {
    if (riskFilter && contract.risk !== riskFilter) return false;
    if (scopeFilter && contract.scopeStrategy !== scopeFilter) return false;
    return true;
  });
};

export const findStorageMigrationContract = (id) => {
  const key = String(id || '').trim();
  return STORAGE_MIGRATION_CONTRACTS.find(contract => contract.id === key) || null;
};

export const buildStorageMigrationChecklist = ({
  scopeId = 'default',
  contracts = STORAGE_MIGRATION_CONTRACTS,
} = {}) => {
  const scope = normalizeScopeId(scopeId) || 'default';
  return (Array.isArray(contracts) ? contracts : []).map((contract) => ({
    id: contract.id,
    owner: contract.owner,
    currentKey: contract.currentKey,
    scopeStrategy: contract.scopeStrategy,
    scopedKeyExample: makeScopedKey(contract.currentKey, scope),
    legacyReadKeys: [...(contract.legacyReadKeys || [])],
    legacyMigrationKey: contract.legacyMigrationKey || '',
    writeTargets: [...(contract.writeTargets || [])],
    payloadVersion: contract.payloadVersion,
    risk: contract.risk,
    importExportSurfaces: [...(contract.importExportSurfaces || [])],
    tests: [...(contract.tests || [])],
  }));
};
