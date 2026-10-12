import { loadSessionArchive, renderSessionArchivesSection } from './session-archive-view-utils.js';

export const createSessionArchiveSectionRuntime = ({
    getContainer = () => null,
    getSessionId = () => '',
    getChatStore = () => null,
    isGroup = false,
    getMemoryStorageMode = () => 'off',
    buildMemoryTableSnapshot = null,
    captureArchivePointer = null,
    loadArchivedMessages = null,
    getLastArchiveTransition = null,
    persistArchivePointer = null,
    applyMemoryTableSnapshot = null,
    restoreArchivePointerForLoadedThread = null,
    logger = null,
    appConfirmFn = null,
    runArchiveSwitchFlow = null,
    runArchiveDeleteFlow = null,
    deleteArchiveTurnCheckpointState = null,
    deleteArchive = null,
    renameArchive = null,
    promptArchiveRenameName = null,
    includeCurrentThread = false,
    onExportCurrent = null,
    onExportArchive = null,
    onArchiveLoaded = null,
    onArchiveDeleted = null,
    onArchiveRenamed = null,
    onHide = null,
    createEmptyState = null,
    createArchiveRow = null,
    sourcePrefix = 'contact',
    restoreWarnMessage = 'restore checkpoint memory after archive load failed',
    deleteWarnMessage = 'delete archive turn checkpoint state failed',
    deps = {},
} = {}) => {
    const runtimeDeps = {
        renderSessionArchivesSection,
        loadSessionArchive,
        ...deps,
    };
    let archiveSearchQuery = '';

    return {
        renderArchives() {
            const sessionId = getSessionId();
            return runtimeDeps.renderSessionArchivesSection({
                container: getContainer(),
                sessionId,
                chatStore: getChatStore(),
                isGroup,
                getMemoryStorageMode,
                buildMemoryTableSnapshot,
                captureArchivePointer,
                loadArchivedMessages,
                getLastArchiveTransition,
                persistArchivePointer,
                applyMemoryTableSnapshot,
                restoreArchivePointerForLoadedThread,
                logger,
                appConfirmFn,
                runArchiveSwitchFlow,
                runArchiveDeleteFlow,
                deleteArchiveTurnCheckpointState,
                deleteArchive,
                renameArchive,
                promptArchiveRenameName,
                includeCurrentThread,
                onExportCurrent,
                onExportArchive,
                onArchiveLoaded,
                onArchiveDeleted,
                onArchiveRenamed,
                onHide,
                createEmptyState,
                createArchiveRow,
                archiveSearchQuery,
                onArchiveSearchQueryChange: (query = '') => {
                    archiveSearchQuery = String(query || '');
                },
                sourcePrefix,
                restoreWarnMessage,
                deleteWarnMessage,
            });
        },
        // 直接加载指定存档（导入后的「立即加载」），不再弹确认。
        async loadArchive(archiveId = '') {
            const sessionId = getSessionId();
            const id = String(archiveId || '').trim();
            const archive = (getChatStore()?.getArchives?.(sessionId) || []).find(item => item?.id === id);
            if (!sessionId || !archive) return false;
            await runtimeDeps.loadSessionArchive({
                sessionId,
                isGroup,
                archive,
                getMemoryStorageMode,
                buildMemoryTableSnapshot,
                captureArchivePointer,
                loadArchivedMessages,
                getLastArchiveTransition,
                persistArchivePointer,
                applyMemoryTableSnapshot,
                restoreArchivePointerForLoadedThread,
                logger,
                runArchiveSwitchFlow,
                onArchiveLoaded,
                onHide,
                sourcePrefix,
                restoreWarnMessage,
            });
            return true;
        },
    };
};
