/**
 * Runtime diagnostics panel for user-facing support exports.
 */

import { appSettings } from '../storage/app-settings.js';
import { getCompatGapReportStore } from '../storage/compat-gap-report-store.js';
import { createDebugPanelDom } from './debug-panel-dom-utils.js';
import {
    buildCustomBundleDiagnosticsMeta,
    buildDebugTextFilename,
    collectErrorLogs,
    formatCustomBundleDiagnostics,
    formatErrorLogs,
} from './debug-panel-utils.js';
import {
    bindDebugViewerRefs,
    createDebugViewerModal,
    setDebugViewerVisibility,
    showDebugViewer,
} from './debug-panel-viewer-utils.js';
import { refreshAgentMessagePartsView } from './agent-message-parts-view.js';
import { refreshProviderRealRunnerDebugView } from './provider-real-runner-debug-view.js';
import { refreshProviderToolSafetyPreflightView } from './provider-tool-safety-preflight-view.js';
import { exportDebugTextFile } from './debug-panel-export-utils.js';
import {
    appendDebugLog,
    getVisibleDebugLogs,
    renderDebugLogHtml,
} from './debug-panel-log-utils.js';
import {
    applyDebugPanelEnabledState,
    createDebugLogListener,
    hideDebugPanel,
    runDebugPanelStartupAutoShow,
    showDebugPanel,
    toggleDebugPanelVisibility,
} from './debug-panel-state-utils.js';
import {
    copyVisibleDebugLogsFlow,
    copyDebugTextFlow,
    createDebugViewerTextBindings,
    createDetachedTextareaCopyFallback,
    createSelectedTextareaCopyFallback,
    exportDebugTextFlow,
    handleAgentRunDiagnosticsLoadError,
    handleAndroidBackDiagnosticsLoadError,
    handleBridgeContractDiagnosticsLoadError,
    handleCustomBundleDiagnosticsLoadError,
    handleDebugTraceTimelineLoadError,
    handleStorageMigrationDiagnosticsLoadError,
    handleViewportKeyboardDiagnosticsLoadError,
    refreshAgentRunDiagnosticsView,
    refreshAndroidBackDiagnosticsView,
    refreshBridgeContractDiagnosticsView,
    refreshCustomBundleDiagnosticsView,
    refreshDebugTraceTimelineView,
    refreshErrorLogView,
    refreshStorageMigrationDiagnosticsView,
    refreshViewportKeyboardDiagnosticsView,
} from './debug-panel-runtime-utils.js';

export class DebugPanel {
    constructor() {
        this.panel = null;
        this.logContainer = null;
        this.controls = null;
        this.logs = [];
        this.maxLogs = 30;
        this.isVisible = false;
        this.autoHideTimer = null;
        this.toggleBtn = null;
        this.enabled = false;
        this.seenMessages = new Set();
        this.customBundleInspectBtn = null;
        this.storageMigrationInspectBtn = null;
        this.bridgeContractInspectBtn = null;
        this.viewportKeyboardInspectBtn = null;
        this.androidBackInspectBtn = null;
        this.traceTimelineInspectBtn = null;
        this.agentRunsInspectBtn = null;
        this.errorLogBtn = null;
        this.filterInput = null;
        this.filterClearBtn = null;
        this.copyLogBtn = null;
        this.filterText = '';
        this.customBundleOverlay = null;
        this.customBundlePanel = null;
        this.customBundleMeta = null;
        this.customBundleText = null;
        this.customBundleRefresh = null;
        this.customBundleExport = null;
        this.storageMigrationOverlay = null;
        this.storageMigrationPanel = null;
        this.storageMigrationMeta = null;
        this.storageMigrationText = null;
        this.storageMigrationRefresh = null;
        this.storageMigrationExport = null;
        this.bridgeContractOverlay = null;
        this.bridgeContractPanel = null;
        this.bridgeContractMeta = null;
        this.bridgeContractText = null;
        this.bridgeContractRefresh = null;
        this.bridgeContractExport = null;
        this.viewportKeyboardOverlay = null;
        this.viewportKeyboardPanel = null;
        this.viewportKeyboardMeta = null;
        this.viewportKeyboardText = null;
        this.viewportKeyboardRefresh = null;
        this.viewportKeyboardExport = null;
        this.viewportKeyboardCopy = null;
        this.androidBackOverlay = null;
        this.androidBackPanel = null;
        this.androidBackMeta = null;
        this.androidBackText = null;
        this.androidBackRefresh = null;
        this.androidBackExport = null;
        this.androidBackCopy = null;
        this.traceTimelineOverlay = null;
        this.traceTimelinePanel = null;
        this.traceTimelineMeta = null;
        this.traceTimelineText = null;
        this.traceTimelineRefresh = null;
        this.traceTimelineExport = null;
        this.agentRunsOverlay = null;
        this.agentRunsPanel = null;
        this.agentRunsMeta = null;
        this.agentRunsText = null;
        this.agentRunsSafetyPreflightState = null;
        this.agentRunsRealRunnerState = null;
        this.agentRunsParts = null;
        this.agentRunsRefresh = null;
        this.agentRunsExport = null;
        this.errorLogOverlay = null;
        this.errorLogPanel = null;
        this.errorLogMeta = null;
        this.errorLogText = null;
        this.errorLogRefresh = null;
        this.errorLogExport = null;
        this.compatGapReportStore = getCompatGapReportStore();
        this.debugLogListener = null;
    }

    init() {
        if (this.panel) return;

        const dom = createDebugPanelDom({
            documentRef: document,
            onShowCustomBundle: () => this.showCustomBundleInspector(),
            onShowStorageMigration: () => this.showStorageMigrationInspector(),
            onShowBridgeContracts: () => this.showBridgeContractInspector(),
            onShowViewportKeyboard: () => this.showViewportKeyboardInspector(),
            onShowAndroidBack: () => this.showAndroidBackInspector(),
            onShowTraceTimeline: () => this.showTraceTimelineInspector(),
            onShowAgentRuns: () => this.showAgentRunsInspector(),
            onShowErrorLogs: () => this.showErrorLogs(),
            onClearLogs: ({ filterInput }) => {
                this.clear();
                if (filterInput) filterInput.value = '';
                this.filterText = '';
                this.render();
            },
            onCopyLogs: () => this.copyVisibleLogs(),
            onFilterChange: (value) => {
                this.filterText = value;
                this.render();
            },
            onClearFilter: ({ filterInput }) => {
                this.filterText = '';
                if (filterInput) {
                    filterInput.value = '';
                    filterInput.focus?.();
                }
                this.render();
            },
            onToggle: () => this.toggle(),
        });
        this.panel = dom.panel;
        this.controls = dom.controls;
        this.customBundleInspectBtn = dom.customBundleInspectBtn;
        this.storageMigrationInspectBtn = dom.storageMigrationInspectBtn;
        this.bridgeContractInspectBtn = dom.bridgeContractInspectBtn;
        this.viewportKeyboardInspectBtn = dom.viewportKeyboardInspectBtn;
        this.androidBackInspectBtn = dom.androidBackInspectBtn;
        this.traceTimelineInspectBtn = dom.traceTimelineInspectBtn;
        this.agentRunsInspectBtn = dom.agentRunsInspectBtn;
        this.errorLogBtn = dom.errorLogBtn;
        this.copyLogBtn = dom.copyLogBtn;
        this.filterInput = dom.filterInput;
        this.filterClearBtn = dom.filterClearBtn;
        this.logContainer = dom.logContainer;
        this.toggleBtn = dom.toggleBtn;

        const settings = appSettings.get();
        this.setEnabled(Boolean(settings.showDebugToggle));
        this.debugLogListener = createDebugLogListener({
            log: (message, type) => this.log(message, type),
        });
        window.addEventListener('app-debug-log', this.debugLogListener);

        // APP启动时自动显示5秒，让用户看到加载日志（仅在启用时）
        this.log('=== APP 启动，调试面板已激活 ===', 'info');
        this.autoHideTimer = runDebugPanelStartupAutoShow({
            enabled: this.enabled,
            show: () => this.show(),
            hide: () => this.hide(),
            getLogCount: () => this.logs.length,
        });
    }

    show() {
        const result = showDebugPanel({
            panel: this.panel,
            scrollToBottom: () => this.scrollToBottom(),
            autoHideTimer: this.autoHideTimer,
        });
        this.isVisible = result.isVisible;
        this.autoHideTimer = result.autoHideTimer;
    }

    hide() {
        const result = hideDebugPanel({
            panel: this.panel,
        });
        this.isVisible = result.isVisible;
    }

    setEnabled(enabled) {
        const result = applyDebugPanelEnabledState({
            enabled,
            toggleBtn: this.toggleBtn,
            onDisable: () => this.hide(),
            autoHideTimer: this.autoHideTimer,
        });
        this.enabled = result.enabled;
        this.autoHideTimer = result.autoHideTimer;
    }

    toggle() {
        if (!this.panel) return;
        toggleDebugPanelVisibility({
            isVisible: this.isVisible,
            onShow: () => this.show(),
            onHide: () => this.hide(),
        });
    }

    getVisibleLogs() {
        return getVisibleDebugLogs({
            logs: this.logs,
            filterText: this.filterText,
        });
    }

    log(message, type = 'info') {
        const { appended } = appendDebugLog({
            logs: this.logs,
            seenMessages: this.seenMessages,
            message,
            type,
            maxLogs: this.maxLogs,
        });
        if (!appended) return;
        // 日志常在别的界面渲染途中写入（如流式重建创意写作气泡时）：同步刷新会读取面板高度、强制排版，
        // 把聊天列表的滚动位置截到只塞回一半的内容上。改为下一帧合并刷新。
        this.scheduleRender();
    }

    scheduleRender() {
        if (this.renderScheduled) return;
        this.renderScheduled = true;
        const run = () => {
            this.renderScheduled = false;
            this.render();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else setTimeout(run, 0);
    }

    render() {
        if (!this.logContainer) return;

        const list = this.getVisibleLogs();
        this.logContainer.innerHTML = renderDebugLogHtml(list);

        this.scrollToBottom();
    }

    scrollToBottom() {
        if (this.logContainer) {
            this.logContainer.scrollTop = this.logContainer.scrollHeight;
        }
    }

    clear() {
        this.logs = [];
        this.seenMessages.clear();
        void this.compatGapReportStore.clear();
        if (this.logContainer) {
            this.logContainer.innerHTML = '';
        }
    }

    async copyVisibleLogs() {
        const list = this.getVisibleLogs();
        await copyVisibleDebugLogsFlow({
            logs: list,
            writeText: async (text) => navigator.clipboard.writeText(text),
            fallbackCopy: createDetachedTextareaCopyFallback({
                documentRef: document,
                execCommand: (command) => document.execCommand?.(command),
            }),
            onWarning: () => window.toastr?.warning?.('暂无日志可复制'),
            onSuccess: (message) => window.toastr?.success?.(message),
            onError: () => window.toastr?.error?.('复制失败'),
        });
    }

    ensureCustomBundleInspector() {
        if (this.customBundleOverlay) return;
        const viewer = createDebugViewerModal({
            overlayId: 'debug-custom-bundle-overlay',
            panelId: 'debug-custom-bundle-panel',
            title: '资料包导入诊断',
            onClose: () => this.hideCustomBundleInspector(),
            onRefresh: () => this.refreshCustomBundleInspector(),
            onExport: () => this.exportCustomBundleDiagnostics(),
        });
        bindDebugViewerRefs({
            target: this,
            prefix: 'customBundle',
            viewer,
        });
    }

    hideCustomBundleInspector() {
        setDebugViewerVisibility({ overlay: this.customBundleOverlay, visible: false });
    }

    async exportCustomBundleDiagnostics() {
        await exportDebugTextFlow({
            text: String(this.customBundleText?.value || ''),
            filenamePrefix: 'custom-bundle-import',
            successLabel: '资料包诊断已导出',
            emptyMessage: '暂无资料包导入诊断可导出',
            exportFailureToast: '资料包诊断导出失败',
            exportFailurePrefix: '资料包诊断导出失败: ',
            buildFilename: buildDebugTextFilename,
            exportTextFile: (text, filename, successLabel) => exportDebugTextFile({
                text,
                filename,
                successLabel,
                onSuccess: (message) => window.toastr?.success?.(message),
            }),
            onWarning: (message) => window.toastr?.warning?.(message),
            onLogWarn: (message) => this.log(message, 'warn'),
            onError: (message) => window.toastr?.error?.(message),
        });
    }

    async refreshCustomBundleInspector() {
        const viewer = createDebugViewerTextBindings({
            metaEl: this.customBundleMeta,
            textEl: this.customBundleText,
        });
        if (!this.customBundleOverlay || !viewer.hasViewer()) return;
        try {
            const registry = window.appBridge?.debugUiRegistry;
            const snapshot = registry?.stores?.customBundleDiagnostics || null;
            refreshCustomBundleDiagnosticsView({
                snapshot,
                setMeta: viewer.setMeta,
                setText: viewer.setText,
            });
        } catch (err) {
            handleCustomBundleDiagnosticsLoadError({
                error: err,
                setMeta: viewer.setMeta,
                setText: viewer.setText,
                logWarn: (message) => this.log(message, 'warn'),
            });
        }
    }

    async showCustomBundleInspector() {
        this.ensureCustomBundleInspector();
        await showDebugViewer({
            overlay: this.customBundleOverlay,
            onShow: () => this.refreshCustomBundleInspector(),
        });
    }

    ensureStorageMigrationInspector() {
        if (this.storageMigrationOverlay) return;
        const viewer = createDebugViewerModal({
            overlayId: 'debug-storage-migration-overlay',
            panelId: 'debug-storage-migration-panel',
            title: '存储迁移检查表',
            onClose: () => this.hideStorageMigrationInspector(),
            onRefresh: () => this.refreshStorageMigrationInspector(),
            onExport: () => this.exportStorageMigrationDiagnostics(),
        });
        bindDebugViewerRefs({
            target: this,
            prefix: 'storageMigration',
            viewer,
        });
    }

    hideStorageMigrationInspector() {
        setDebugViewerVisibility({ overlay: this.storageMigrationOverlay, visible: false });
    }

    async exportStorageMigrationDiagnostics() {
        await exportDebugTextFlow({
            text: String(this.storageMigrationText?.value || ''),
            filenamePrefix: 'storage-migration-checklist',
            successLabel: '迁移检查表已导出',
            emptyMessage: '暂无存储迁移检查表可导出',
            exportFailureToast: '迁移检查表导出失败',
            exportFailurePrefix: '迁移检查表导出失败: ',
            buildFilename: buildDebugTextFilename,
            exportTextFile: (text, filename, successLabel) => exportDebugTextFile({
                text,
                filename,
                successLabel,
                onSuccess: (message) => window.toastr?.success?.(message),
            }),
            onWarning: (message) => window.toastr?.warning?.(message),
            onLogWarn: (message) => this.log(message, 'warn'),
            onError: (message) => window.toastr?.error?.(message),
        });
    }

    async refreshStorageMigrationInspector() {
        const viewer = createDebugViewerTextBindings({
            metaEl: this.storageMigrationMeta,
            textEl: this.storageMigrationText,
        });
        if (!this.storageMigrationOverlay || !viewer.hasViewer()) return;
        try {
            refreshStorageMigrationDiagnosticsView({
                setMeta: viewer.setMeta,
                setText: viewer.setText,
            });
        } catch (err) {
            handleStorageMigrationDiagnosticsLoadError({
                error: err,
                setMeta: viewer.setMeta,
                setText: viewer.setText,
                logWarn: (message) => this.log(message, 'warn'),
            });
        }
    }

    async showStorageMigrationInspector() {
        this.ensureStorageMigrationInspector();
        await showDebugViewer({
            overlay: this.storageMigrationOverlay,
            onShow: () => this.refreshStorageMigrationInspector(),
        });
    }

    ensureBridgeContractInspector() {
        if (this.bridgeContractOverlay) return;
        const viewer = createDebugViewerModal({
            overlayId: 'debug-bridge-contract-overlay',
            panelId: 'debug-bridge-contract-panel',
            title: 'Bridge Contract 诊断',
            onClose: () => this.hideBridgeContractInspector(),
            onRefresh: () => this.refreshBridgeContractInspector(),
            onExport: () => this.exportBridgeContractDiagnostics(),
        });
        bindDebugViewerRefs({
            target: this,
            prefix: 'bridgeContract',
            viewer,
        });
    }

    hideBridgeContractInspector() {
        setDebugViewerVisibility({ overlay: this.bridgeContractOverlay, visible: false });
    }

    async exportBridgeContractDiagnostics() {
        await exportDebugTextFlow({
            text: String(this.bridgeContractText?.value || ''),
            filenamePrefix: 'bridge-contract-registry',
            successLabel: 'Bridge contract 诊断已导出',
            emptyMessage: '暂无 Bridge contract 诊断可导出',
            exportFailureToast: 'Bridge contract 诊断导出失败',
            exportFailurePrefix: 'Bridge contract 诊断导出失败: ',
            buildFilename: buildDebugTextFilename,
            exportTextFile: (text, filename, successLabel) => exportDebugTextFile({
                text,
                filename,
                successLabel,
                onSuccess: (message) => window.toastr?.success?.(message),
            }),
            onWarning: (message) => window.toastr?.warning?.(message),
            onLogWarn: (message) => this.log(message, 'warn'),
            onError: (message) => window.toastr?.error?.(message),
        });
    }

    async refreshBridgeContractInspector() {
        const viewer = createDebugViewerTextBindings({
            metaEl: this.bridgeContractMeta,
            textEl: this.bridgeContractText,
        });
        if (!this.bridgeContractOverlay || !viewer.hasViewer()) return;
        try {
            refreshBridgeContractDiagnosticsView({
                registry: window.appBridge?.bridgeContractRegistry || null,
                setMeta: viewer.setMeta,
                setText: viewer.setText,
            });
        } catch (err) {
            handleBridgeContractDiagnosticsLoadError({
                error: err,
                setMeta: viewer.setMeta,
                setText: viewer.setText,
                logWarn: (message) => this.log(message, 'warn'),
            });
        }
    }

    async showBridgeContractInspector() {
        this.ensureBridgeContractInspector();
        await showDebugViewer({
            overlay: this.bridgeContractOverlay,
            onShow: () => this.refreshBridgeContractInspector(),
        });
    }

    ensureViewportKeyboardInspector() {
        if (this.viewportKeyboardOverlay) return;
        const viewer = createDebugViewerModal({
            overlayId: 'debug-viewport-keyboard-overlay',
            panelId: 'debug-viewport-keyboard-panel',
            title: '键盘/视口诊断',
            includeCopyButton: true,
            onClose: () => this.hideViewportKeyboardInspector(),
            onRefresh: () => this.refreshViewportKeyboardInspector(),
            onExport: () => this.exportViewportKeyboardDiagnostics(),
            onCopy: async () => {
                const viewer = createDebugViewerTextBindings({
                    textEl: this.viewportKeyboardText,
                });
                await copyDebugTextFlow({
                    text: viewer.getText(),
                    writeText: async (text) => navigator.clipboard.writeText(text),
                    fallbackCopy: createSelectedTextareaCopyFallback({
                        textEl: this.viewportKeyboardText,
                        execCommand: (command) => document.execCommand?.(command),
                    }),
                    onWarning: (message) => window.toastr?.warning?.(message),
                    onSuccess: (message) => window.toastr?.success?.(message),
                    onError: (message) => window.toastr?.error?.(message),
                    emptyMessage: '暂无键盘/视口诊断可复制',
                });
            },
        });
        bindDebugViewerRefs({
            target: this,
            prefix: 'viewportKeyboard',
            viewer,
        });
    }

    hideViewportKeyboardInspector() {
        setDebugViewerVisibility({ overlay: this.viewportKeyboardOverlay, visible: false });
    }

    async exportViewportKeyboardDiagnostics() {
        await exportDebugTextFlow({
            text: String(this.viewportKeyboardText?.value || ''),
            filenamePrefix: 'viewport-keyboard',
            successLabel: '键盘/视口诊断已导出',
            emptyMessage: '暂无键盘/视口诊断可导出',
            exportFailureToast: '键盘/视口诊断导出失败',
            exportFailurePrefix: '键盘/视口诊断导出失败: ',
            buildFilename: buildDebugTextFilename,
            exportTextFile: (text, filename, successLabel) => exportDebugTextFile({
                text,
                filename,
                successLabel,
                onSuccess: (message) => window.toastr?.success?.(message),
            }),
            onWarning: (message) => window.toastr?.warning?.(message),
            onLogWarn: (message) => this.log(message, 'warn'),
            onError: (message) => window.toastr?.error?.(message),
        });
    }

    async refreshViewportKeyboardInspector() {
        const viewer = createDebugViewerTextBindings({
            metaEl: this.viewportKeyboardMeta,
            textEl: this.viewportKeyboardText,
        });
        if (!this.viewportKeyboardOverlay || !viewer.hasViewer()) return;
        try {
            const actions = window.appBridge?.debugUiRegistry?.actions || {};
            if (typeof actions.refreshViewportKeyboardRuntime === 'function') {
                actions.refreshViewportKeyboardRuntime();
            }
            const snapshot = typeof actions.getViewportDebugInfo === 'function'
                ? actions.getViewportDebugInfo()
                : window.__chatappViewportDebugInfo?.();
            refreshViewportKeyboardDiagnosticsView({
                snapshot,
                setMeta: viewer.setMeta,
                setText: viewer.setText,
            });
        } catch (err) {
            handleViewportKeyboardDiagnosticsLoadError({
                error: err,
                setMeta: viewer.setMeta,
                setText: viewer.setText,
                logWarn: (message) => this.log(message, 'warn'),
            });
        }
    }

    async showViewportKeyboardInspector() {
        this.ensureViewportKeyboardInspector();
        await showDebugViewer({
            overlay: this.viewportKeyboardOverlay,
            onShow: () => this.refreshViewportKeyboardInspector(),
        });
    }

    ensureAndroidBackInspector() {
        if (this.androidBackOverlay) return;
        const viewer = createDebugViewerModal({
            overlayId: 'debug-android-back-overlay',
            panelId: 'debug-android-back-panel',
            title: '安卓返回诊断',
            includeCopyButton: true,
            onClose: () => this.hideAndroidBackInspector(),
            onRefresh: () => this.refreshAndroidBackInspector(),
            onExport: () => this.exportAndroidBackDiagnostics(),
            onCopy: async () => {
                const viewer = createDebugViewerTextBindings({
                    textEl: this.androidBackText,
                });
                await copyDebugTextFlow({
                    text: viewer.getText(),
                    writeText: async (text) => navigator.clipboard.writeText(text),
                    fallbackCopy: createSelectedTextareaCopyFallback({
                        textEl: this.androidBackText,
                        execCommand: (command) => document.execCommand?.(command),
                    }),
                    onWarning: (message) => window.toastr?.warning?.(message),
                    onSuccess: (message) => window.toastr?.success?.(message),
                    onError: (message) => window.toastr?.error?.(message),
                    emptyMessage: '暂无安卓返回诊断可复制',
                });
            },
        });
        bindDebugViewerRefs({
            target: this,
            prefix: 'androidBack',
            viewer,
        });
    }

    hideAndroidBackInspector() {
        setDebugViewerVisibility({ overlay: this.androidBackOverlay, visible: false });
    }

    async exportAndroidBackDiagnostics() {
        await exportDebugTextFlow({
            text: String(this.androidBackText?.value || ''),
            filenamePrefix: 'android-back',
            successLabel: '安卓返回诊断已导出',
            emptyMessage: '暂无安卓返回诊断可导出',
            exportFailureToast: '安卓返回诊断导出失败',
            exportFailurePrefix: '安卓返回诊断导出失败: ',
            buildFilename: buildDebugTextFilename,
            exportTextFile: (text, filename, successLabel) => exportDebugTextFile({
                text,
                filename,
                successLabel,
                onSuccess: (message) => window.toastr?.success?.(message),
            }),
            onWarning: (message) => window.toastr?.warning?.(message),
            onLogWarn: (message) => this.log(message, 'warn'),
            onError: (message) => window.toastr?.error?.(message),
        });
    }

    async refreshAndroidBackInspector() {
        const viewer = createDebugViewerTextBindings({
            metaEl: this.androidBackMeta,
            textEl: this.androidBackText,
        });
        if (!this.androidBackOverlay || !viewer.hasViewer()) return;
        try {
            const actions = window.appBridge?.debugUiRegistry?.actions || {};
            const snapshot = typeof actions.getAndroidBackDiagnostics === 'function'
                ? actions.getAndroidBackDiagnostics()
                : window.__chatappBackNavigationDiagnostics?.();
            refreshAndroidBackDiagnosticsView({
                snapshot,
                setMeta: viewer.setMeta,
                setText: viewer.setText,
            });
        } catch (err) {
            handleAndroidBackDiagnosticsLoadError({
                error: err,
                setMeta: viewer.setMeta,
                setText: viewer.setText,
                logWarn: (message) => this.log(message, 'warn'),
            });
        }
    }

    async showAndroidBackInspector() {
        this.ensureAndroidBackInspector();
        await showDebugViewer({
            overlay: this.androidBackOverlay,
            onShow: () => this.refreshAndroidBackInspector(),
        });
    }

    ensureTraceTimelineInspector() {
        if (this.traceTimelineOverlay) return;
        const viewer = createDebugViewerModal({
            overlayId: 'debug-trace-timeline-overlay',
            panelId: 'debug-trace-timeline-panel',
            title: '事件时间线',
            onClose: () => this.hideTraceTimelineInspector(),
            onRefresh: () => this.refreshTraceTimelineInspector(),
            onExport: () => this.exportTraceTimelineDiagnostics(),
        });
        bindDebugViewerRefs({
            target: this,
            prefix: 'traceTimeline',
            viewer,
        });
    }

    hideTraceTimelineInspector() {
        setDebugViewerVisibility({ overlay: this.traceTimelineOverlay, visible: false });
    }

    async exportTraceTimelineDiagnostics() {
        await exportDebugTextFlow({
            text: String(this.traceTimelineText?.value || ''),
            filenamePrefix: 'debug-trace-timeline',
            successLabel: '事件时间线已导出',
            emptyMessage: '暂无事件时间线可导出',
            exportFailureToast: '事件时间线导出失败',
            exportFailurePrefix: '事件时间线导出失败: ',
            buildFilename: buildDebugTextFilename,
            exportTextFile: (text, filename, successLabel) => exportDebugTextFile({
                text,
                filename,
                successLabel,
                onSuccess: (message) => window.toastr?.success?.(message),
            }),
            onWarning: (message) => window.toastr?.warning?.(message),
            onLogWarn: (message) => this.log(message, 'warn'),
            onError: (message) => window.toastr?.error?.(message),
        });
    }

    async refreshTraceTimelineInspector() {
        const viewer = createDebugViewerTextBindings({
            metaEl: this.traceTimelineMeta,
            textEl: this.traceTimelineText,
        });
        if (!this.traceTimelineOverlay || !viewer.hasViewer()) return;
        try {
            refreshDebugTraceTimelineView({
                timeline: window.appBridge?.debugUiRegistry?.stores?.traceTimeline || null,
                setMeta: viewer.setMeta,
                setText: viewer.setText,
            });
        } catch (err) {
            handleDebugTraceTimelineLoadError({
                error: err,
                setMeta: viewer.setMeta,
                setText: viewer.setText,
                logWarn: (message) => this.log(message, 'warn'),
            });
        }
    }

    async showTraceTimelineInspector() {
        this.ensureTraceTimelineInspector();
        await showDebugViewer({
            overlay: this.traceTimelineOverlay,
            onShow: () => this.refreshTraceTimelineInspector(),
        });
    }

    ensureAgentRunsInspector() {
        if (this.agentRunsOverlay) return;
        const viewer = createDebugViewerModal({
            overlayId: 'debug-agent-runs-overlay',
            panelId: 'debug-agent-runs-panel',
            title: 'Agent Runs',
            onClose: () => this.hideAgentRunsInspector(),
            onRefresh: () => this.refreshAgentRunsInspector(),
            onExport: () => this.exportAgentRunDiagnostics(),
        });
        bindDebugViewerRefs({
            target: this,
            prefix: 'agentRuns',
            viewer,
        });
        this.agentRunsSafetyPreflightState = document.createElement('div');
        this.agentRunsRealRunnerState = document.createElement('div');
        this.agentRunsParts = document.createElement('div');
        const content = this.agentRunsText?.parentNode || null;
        if (content?.style) {
            content.style.display = 'flex';
            content.style.flexDirection = 'column';
            content.style.gap = '10px';
            content.style.minHeight = '0';
        }
        if (this.agentRunsText?.style) {
            this.agentRunsText.style.height = 'auto';
            this.agentRunsText.style.minHeight = '180px';
            this.agentRunsText.style.flex = '1 1 0';
        }
        if (content?.insertBefore) {
            content.insertBefore(this.agentRunsSafetyPreflightState, this.agentRunsText);
            content.insertBefore(this.agentRunsRealRunnerState, this.agentRunsText);
            content.insertBefore(this.agentRunsParts, this.agentRunsText);
        } else {
            content?.appendChild?.(this.agentRunsSafetyPreflightState);
            content?.appendChild?.(this.agentRunsRealRunnerState);
            content?.appendChild?.(this.agentRunsParts);
        }
    }

    hideAgentRunsInspector() {
        setDebugViewerVisibility({ overlay: this.agentRunsOverlay, visible: false });
    }

    async exportAgentRunDiagnostics() {
        await exportDebugTextFlow({
            text: String(this.agentRunsText?.value || ''),
            filenamePrefix: 'agent-runs',
            successLabel: 'Agent run 诊断已导出',
            emptyMessage: '暂无 Agent run 诊断可导出',
            exportFailureToast: 'Agent run 诊断导出失败',
            exportFailurePrefix: 'Agent run 诊断导出失败: ',
            buildFilename: buildDebugTextFilename,
            exportTextFile: (text, filename, successLabel) => exportDebugTextFile({
                text,
                filename,
                successLabel,
                onSuccess: (message) => window.toastr?.success?.(message),
            }),
            onWarning: (message) => window.toastr?.warning?.(message),
            onLogWarn: (message) => this.log(message, 'warn'),
            onError: (message) => window.toastr?.error?.(message),
        });
    }

    async refreshAgentRunsInspector() {
        const viewer = createDebugViewerTextBindings({
            metaEl: this.agentRunsMeta,
            textEl: this.agentRunsText,
        });
        if (!this.agentRunsOverlay || !viewer.hasViewer()) return;
        try {
            const actions = window.appBridge?.debugUiRegistry?.actions || {};
            const providerToolExperimentDiagnostics = typeof actions.getProviderToolExperimentDiagnostics === 'function'
                ? actions.getProviderToolExperimentDiagnostics({ limit: 8 })
                : null;
            const providerToolExperimentStatus = typeof actions.getProviderToolExperimentStatus === 'function'
                ? actions.getProviderToolExperimentStatus()
                : providerToolExperimentDiagnostics?.status || null;
            const permissionRules = typeof actions.listAgentPermissionRules === 'function'
                ? actions.listAgentPermissionRules()
                : [];
            const loopGuard = typeof actions.getProviderToolCallLoopGuardSnapshot === 'function'
                ? actions.getProviderToolCallLoopGuardSnapshot()
                : [];
            const sessionId = window.appBridge?.debugUiRegistry?.stores?.chatStore?.getCurrent?.() || '';
            const sessionGate = typeof actions.getProviderToolSessionGate === 'function'
                ? actions.getProviderToolSessionGate({ sessionId })
                : null;
            refreshAgentRunDiagnosticsView({
                store: window.appBridge?.debugUiRegistry?.stores?.agentRunStore || null,
                providerToolExperimentDiagnostics,
                options: { limit: 80, eventLimit: 500 },
                setMeta: viewer.setMeta,
                setText: viewer.setText,
            });
            refreshProviderToolSafetyPreflightView({
                container: this.agentRunsSafetyPreflightState,
                status: providerToolExperimentStatus,
                diagnostics: providerToolExperimentDiagnostics,
                permissionRules,
                loopGuard,
                sessionId,
                sessionGate,
                onSetSessionGate: typeof actions.setProviderToolSessionGate === 'function'
                    ? async ({ enabled }) => {
                        const next = actions.setProviderToolSessionGate({
                            sessionId,
                            enabled,
                            source: 'agent_runs_debug_panel',
                            reason: enabled
                                ? 'enabled from Agent Runs safety preflight'
                                : 'disabled from Agent Runs safety preflight',
                        });
                        await this.refreshAgentRunsInspector();
                        return next;
                    }
                    : null,
                documentRef: document,
            });
            refreshProviderRealRunnerDebugView({
                container: this.agentRunsRealRunnerState,
                diagnostics: providerToolExperimentDiagnostics,
                documentRef: document,
            });
            const agentRunParts = typeof actions.listAgentRunParts === 'function'
                ? actions.listAgentRunParts({
                    limit: 12,
                    includeSucceededSteps: false,
                    maxSteps: 8,
                    maxToolCalls: 8,
                })
                : [];
            const providerToolParts = typeof actions.listProviderToolExperimentParts === 'function'
                ? actions.listProviderToolExperimentParts({ limit: 6 })
                : [];
            const providerToolResumeParts = typeof actions.listProviderToolPendingResumeParts === 'function'
                ? actions.listProviderToolPendingResumeParts({ limit: 6 })
                : [];
            const providerToolContinuationParts = typeof actions.listProviderToolPendingContinuationParts === 'function'
                ? actions.listProviderToolPendingContinuationParts({ limit: 6 })
                : [];
            refreshAgentMessagePartsView({
                container: this.agentRunsParts,
                parts: [...providerToolContinuationParts, ...providerToolResumeParts, ...providerToolParts, ...agentRunParts],
                documentRef: document,
                emptyText: 'No agent message parts',
            });
        } catch (err) {
            handleAgentRunDiagnosticsLoadError({
                error: err,
                setMeta: viewer.setMeta,
                setText: viewer.setText,
                logWarn: (message) => this.log(message, 'warn'),
            });
        }
    }

    async showAgentRunsInspector() {
        this.ensureAgentRunsInspector();
        await showDebugViewer({
            overlay: this.agentRunsOverlay,
            onShow: () => this.refreshAgentRunsInspector(),
        });
    }

    ensureErrorLogViewer() {
        if (this.errorLogOverlay) return;
        const viewer = createDebugViewerModal({
            overlayId: 'debug-error-log-overlay',
            panelId: 'debug-error-log-panel',
            title: '错误日志',
            includeCopyButton: true,
            onClose: () => this.hideErrorLogs(),
            onRefresh: () => this.refreshErrorLogs(),
            onExport: () => this.exportErrorLogs(),
            onCopy: async () => {
                const viewer = createDebugViewerTextBindings({
                    textEl: this.errorLogText,
                });
                await copyDebugTextFlow({
                    text: viewer.getText(),
                    writeText: async (text) => navigator.clipboard.writeText(text),
                    fallbackCopy: createSelectedTextareaCopyFallback({
                        textEl: this.errorLogText,
                        execCommand: (command) => document.execCommand?.(command),
                    }),
                    onWarning: (message) => window.toastr?.warning?.(message),
                    onSuccess: (message) => window.toastr?.success?.(message),
                    onError: (message) => window.toastr?.error?.(message),
                });
            },
        });
        bindDebugViewerRefs({
            target: this,
            prefix: 'errorLog',
            viewer,
        });
    }

    hideErrorLogs() {
        setDebugViewerVisibility({ overlay: this.errorLogOverlay, visible: false });
    }

    async refreshErrorLogs() {
        const viewer = createDebugViewerTextBindings({
            metaEl: this.errorLogMeta,
            textEl: this.errorLogText,
        });
        if (!this.errorLogOverlay || !viewer.hasViewer()) return;
        const compatReports = await this.compatGapReportStore.getReports().catch(() => []);
        refreshErrorLogView({
            logs: this.logs,
            compatReports,
            setMeta: viewer.setMeta,
            setText: viewer.setText,
        });
    }

    showErrorLogs() {
        this.ensureErrorLogViewer();
        void showDebugViewer({
            overlay: this.errorLogOverlay,
            onShow: () => this.refreshErrorLogs(),
        });
    }

    async exportErrorLogs() {
        const compatReports = await this.compatGapReportStore.getReports().catch(() => []);
        await exportDebugTextFlow({
            text: formatErrorLogs(this.logs, compatReports),
            filenamePrefix: 'app-debug-errors',
            successLabel: '错误日志已导出',
            emptyMessage: '暂无内容可导出',
            exportFailureToast: '导出失败',
            exportFailurePrefix: '导出失败: ',
            buildFilename: buildDebugTextFilename,
            exportTextFile: (text, filename, successLabel) => exportDebugTextFile({
                text,
                filename,
                successLabel,
                onSuccess: (message) => window.toastr?.success?.(message),
            }),
            onWarning: (message) => window.toastr?.warning?.(message),
            onLogWarn: (message) => this.log(message, 'warn'),
            onError: (message) => window.toastr?.error?.(message),
        });
    }

}

// 全局单例
let debugPanelInstance = null;

export function getDebugPanel() {
    if (!debugPanelInstance) {
        debugPanelInstance = new DebugPanel();
        debugPanelInstance.init();
    }
    return debugPanelInstance;
}
