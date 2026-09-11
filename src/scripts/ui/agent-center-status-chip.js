const STYLE_ID = 'agent-center-status-chip-style';
const DEFAULT_REFRESH_INTERVAL_MS = 6000;

const STATUS_CHIP_CSS = `
.chat-room-topbar .chat-room-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.agent-status-chip {
    height: 26px;
    min-width: 26px;
    max-width: 72px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 0 7px;
    border: 1px solid rgba(15, 23, 42, 0.10);
    border-radius: 999px;
    background: var(--app-surface-card);
    color: var(--app-text-secondary);
    font-size: 11px;
    font-weight: 800;
    line-height: 1;
    cursor: pointer;
    flex: 0 1 auto;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.16s ease;
}
.chat-room-topbar .agent-status-chip {
    position: relative;
    z-index: 2;
}
.agent-status-chip:hover {
    background: var(--app-surface-subtle);
    color: var(--app-text-primary);
    transform: translateY(-1px);
}
.agent-status-chip:active {
    transform: scale(0.96);
}
.agent-status-chip-mark {
    font-family: Georgia, 'Palatino Linotype', 'Songti SC', 'Noto Serif SC', serif;
    font-style: italic;
    font-weight: 700;
    font-size: 15px;
    line-height: 1;
    letter-spacing: 0.02em;
    flex-shrink: 0;
    background: linear-gradient(160deg, currentColor 20%, color-mix(in srgb, currentColor 45%, transparent) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    transform: translateY(-0.5px);
}
@keyframes agent-status-mark-breathe {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
}
.agent-status-chip.is-active .agent-status-chip-mark {
    animation: agent-status-mark-breathe 1.6s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
    .agent-status-chip.is-active .agent-status-chip-mark {
        animation: none;
    }
}
.agent-status-chip-count {
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(15, 23, 42, 0.08);
    color: inherit;
    font-size: 10px;
    line-height: 1;
    flex-shrink: 0;
}
.agent-status-chip:not(.has-count) .agent-status-chip-count {
    display: none;
}
.agent-status-chip.is-pending {
    border-color: rgba(37, 99, 235, 0.26);
    background: rgba(37, 99, 235, 0.10);
    color: #1d4ed8;
}
.agent-status-chip.is-active {
    border-color: rgba(16, 185, 129, 0.24);
    background: rgba(16, 185, 129, 0.10);
    color: #047857;
}
.agent-status-chip.is-failed {
    border-color: rgba(244, 63, 94, 0.24);
    background: rgba(244, 63, 94, 0.10);
    color: #be123c;
}
.agent-status-chip.is-ready {
    border-color: rgba(99, 102, 241, 0.22);
    background: rgba(99, 102, 241, 0.09);
    color: #4338ca;
}
body[data-theme-mode='dark'] .agent-status-chip {
    border-color: rgba(148, 163, 184, 0.24);
    background: rgba(15, 23, 42, 0.76);
    color: #cbd5e1;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset;
}
body[data-theme-mode='dark'] .agent-status-chip:hover {
    border-color: rgba(148, 163, 184, 0.34);
    background: rgba(30, 41, 59, 0.88);
    color: #f8fafc;
}
body[data-theme-mode='dark'] .agent-status-chip-count {
    background: rgba(148, 163, 184, 0.18);
}
body[data-theme-mode='dark'] .agent-status-chip.is-pending {
    border-color: rgba(96, 165, 250, 0.34);
    background: rgba(37, 99, 235, 0.20);
    color: #93c5fd;
}
body[data-theme-mode='dark'] .agent-status-chip.is-active {
    border-color: rgba(52, 211, 153, 0.34);
    background: rgba(16, 185, 129, 0.18);
    color: #6ee7b7;
}
body[data-theme-mode='dark'] .agent-status-chip.is-failed {
    border-color: rgba(251, 113, 133, 0.36);
    background: rgba(244, 63, 94, 0.18);
    color: #fda4af;
}
body[data-theme-mode='dark'] .agent-status-chip.is-ready {
    border-color: rgba(129, 140, 248, 0.36);
    background: rgba(99, 102, 241, 0.20);
    color: #c4b5fd;
}
.chat-room-topbar .agent-status-chip,
body[data-theme-mode='dark'] .chat-room-topbar .agent-status-chip {
    position: relative;
    width: 36px;
    height: 36px;
    min-width: 36px;
    max-width: 36px;
    flex: 0 0 36px;
    padding: 6px;
    overflow: visible;
    border: 0;
    background: transparent;
    box-shadow: none;
}
.chat-room-topbar .agent-status-chip-mark {
    position: relative;
    width: 24px;
    height: 24px;
    display: inline-grid;
    place-items: center;
    overflow: hidden;
    border-radius: 50%;
    background: linear-gradient(145deg, #ffffff 3%, #e4e8ed 26%, #fafbfc 43%, #b8c0ca 72%, #edf0f4);
    background-clip: border-box;
    -webkit-background-clip: border-box;
    color: #56616e;
    -webkit-text-fill-color: #56616e;
    text-shadow: 0 1px 0 #fff, 0 -0.5px 0 rgba(57, 68, 82, 0.22);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.88), inset 0 0 0 2px rgba(107, 120, 137, 0.35), inset 0 -2px 3px rgba(70, 84, 102, 0.18), 0 2px 3px rgba(40, 50, 65, 0.2), 0 6px 12px -7px rgba(40, 50, 65, 0.36);
    transform: translateY(-0.5px);
    transition: transform 180ms ease, box-shadow 180ms ease;
}
.chat-room-topbar .agent-status-chip-mark::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: linear-gradient(
        115deg,
        transparent 22%,
        rgba(255, 255, 255, 0.42) 48%,
        transparent 72%
    );
    transform: translateX(-145%);
    transition: transform 420ms cubic-bezier(0.22, 1, 0.36, 1);
    pointer-events: none;
}
.chat-room-topbar .agent-status-chip:hover .agent-status-chip-mark {
    box-shadow: inset 0 0 0 1px #fff, inset 0 0 0 2px rgba(107, 120, 137, 0.4), inset 0 -2px 3px rgba(70, 84, 102, 0.18), 0 3px 5px rgba(40, 50, 65, 0.24), 0 7px 14px -6px rgba(40, 50, 65, 0.35);
    transform: translateY(-1px) scale(1.045);
}
.chat-room-topbar .agent-status-chip:hover .agent-status-chip-mark::after {
    transform: translateX(145%);
}
.chat-room-topbar .agent-status-chip-count {
    position: absolute;
    top: 0;
    right: -1px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border: 2px solid var(--app-surface-topbar, var(--app-surface-card));
    background: var(--app-surface-card);
    box-sizing: border-box;
    font-size: 8px;
    box-shadow: 0 2px 7px rgba(15, 23, 42, 0.14);
}
.moments-actions .agent-status-chip {
    max-width: 96px;
}
@media (max-width: 420px) {
    .agent-status-chip {
        max-width: 64px;
    }
}
@media (prefers-reduced-motion: reduce) {
    .agent-status-chip {
        transition: none !important;
    }
    .agent-status-chip:hover,
    .agent-status-chip:active {
        transform: none !important;
    }
    .chat-room-topbar .agent-status-chip-mark,
    .chat-room-topbar .agent-status-chip-mark::after {
        transition: none !important;
    }
    .chat-room-topbar .agent-status-chip:hover .agent-status-chip-mark {
        transform: none !important;
    }
    .chat-room-topbar .agent-status-chip-mark::after {
        display: none;
    }
}
body[data-reduced-motion='on'] .chat-room-topbar .agent-status-chip,
body[data-reduced-motion='on'] .chat-room-topbar .agent-status-chip-mark,
body[data-reduced-motion='on'] .chat-room-topbar .agent-status-chip-mark::after {
    animation: none !important;
    transition: none !important;
}
body[data-reduced-motion='on'] .chat-room-topbar .agent-status-chip:hover,
body[data-reduced-motion='on'] .chat-room-topbar .agent-status-chip:hover .agent-status-chip-mark {
    transform: none !important;
}
body[data-reduced-motion='on'] .chat-room-topbar .agent-status-chip-mark::after {
    display: none;
}
`;

const toCount = value => Math.max(0, Math.trunc(Number(value) || 0));

const isActiveRun = run => run?.isActive === true || ['queued', 'running', 'waiting_permission'].includes(String(run?.status || '').trim());
const isFailedRun = run => run?.isFailure === true || ['failed', 'cancelled'].includes(String(run?.status || '').trim());
const failureAt = run => Math.max(0, Number(run?.updatedAt || run?.finishedAt || run?.createdAt || 0) || 0);
const isUnreadFailedRun = (run, seenAt = 0) => isFailedRun(run) && failureAt(run) > Math.max(0, Number(seenAt) || 0);

export const buildAgentStatusChipView = (agentCenterView = {}, {
    activityScope = 'meta',
    idleLabel = 'Agent',
    showSessionGateState = true,
    showToolsCount = true,
    failureSeenAt = 0,
} = {}) => {
    const meta = agentCenterView?.meta || {};
    const visibleRuns = Array.isArray(agentCenterView?.activity?.runs) ? agentCenterView.activity.runs : [];
    const useVisibleActivity = activityScope === 'visible';
    const pending = toCount(meta.pending);
    const activeRuns = useVisibleActivity ? visibleRuns.filter(isActiveRun).length : toCount(meta.activeRuns);
    const unreadFailedRuns = useVisibleActivity
        ? visibleRuns.filter(run => isUnreadFailedRun(run, failureSeenAt)).length
        : toCount(meta.unreadFailedRuns ?? meta.failedRuns);
    const tools = showToolsCount ? toCount(meta.tools) : 0;
    const sessionGateEnabled = showSessionGateState && meta.sessionGateEnabled === true;

    if (pending > 0) {
        return {
            label: '待确认',
            count: String(pending),
            tone: 'pending',
            tab: 'pending',
            title: `打开 Agent Center，${pending} 个请求待确认`,
        };
    }
    if (activeRuns > 0) {
        return {
            label: '运行中',
            count: String(activeRuns),
            tone: 'active',
            tab: 'activity',
            activityStatus: 'active',
            title: `打开 Agent Center，${activeRuns} 个 Agent 任务运行中`,
        };
    }
    if (unreadFailedRuns > 0) {
        return {
            label: '失败',
            count: String(unreadFailedRuns),
            tone: 'failed',
            tab: 'activity',
            activityStatus: 'failure',
            title: `打开 Agent Center，${unreadFailedRuns} 个未读失败任务`,
        };
    }
    // 空闲/就绪不显示数字（工具总数意义有限且噪音大），完整信息保留在 tooltip。
    if (sessionGateEnabled) {
        return {
            label: 'Agent 开启',
            count: '',
            tone: 'ready',
            tab: 'safety',
            activityStatus: '',
            title: tools ? `打开 Agent Center，Agent 已开启（${tools} 个工具已注册）` : '打开 Agent Center，查看工具与安全状态',
        };
    }
    return {
        label: idleLabel,
        count: '',
        tone: 'idle',
        tab: '',
        activityStatus: '',
        title: tools ? `打开 Agent Center，${tools} 个工具已注册` : '打开 Agent Center',
    };
};

export class AgentCenterStatusChip {
    constructor({
        documentRef = globalThis.document,
        rootElement = null,
        beforeElement = null,
        collectView = async () => ({}),
        openAgentCenter = () => {},
        getFailureSeenAt = () => 0,
        markFailureSeen = () => {},
        refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
        activityScope = 'meta',
        idleLabel = 'Agent',
        showSessionGateState = true,
        showToolsCount = true,
    } = {}) {
        this.documentRef = documentRef;
        this.rootElement = rootElement;
        this.beforeElement = beforeElement;
        this.collectView = collectView;
        this.openAgentCenter = openAgentCenter;
        this.getFailureSeenAt = getFailureSeenAt;
        this.markFailureSeen = markFailureSeen;
        this.refreshIntervalMs = Math.max(0, Number(refreshIntervalMs) || 0);
        this.viewOptions = { activityScope, idleLabel, showSessionGateState, showToolsCount };
        this.element = null;
        this.countElement = null;
        this.state = buildAgentStatusChipView({}, this.viewOptions);
        this.refreshTimer = null;
        this.refreshToken = 0;
    }

    ensureStyle() {
        const doc = this.documentRef;
        if (!doc || doc.getElementById?.(STYLE_ID)) return;
        const style = doc.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STATUS_CHIP_CSS;
        doc.head?.appendChild?.(style);
    }

    mount() {
        const doc = this.documentRef;
        const root = this.rootElement;
        if (!doc || !root || this.element) return this.element;
        this.ensureStyle();
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'agent-status-chip';
        button.dataset.maidGuideTarget = 'agent-center-entry';
        button.innerHTML = `
            <span class="agent-status-chip-mark" aria-hidden="true">A</span>
            <span class="agent-status-chip-count"></span>
        `;
        button.addEventListener('click', () => {
            if (this.state?.tone === 'failed') {
                this.markFailureSeen({
                    activityStatus: 'failure',
                    at: Date.now(),
                });
            }
            const options = {};
            if (this.state?.tab) options.tab = this.state.tab;
            if (this.state?.activityStatus) options.activityStatus = this.state.activityStatus;
            this.openAgentCenter(options);
            this.refresh();
        });
        if (this.beforeElement && this.beforeElement.parentNode === root) {
            root.insertBefore(button, this.beforeElement);
        } else {
            root.appendChild(button);
        }
        this.element = button;
        this.countElement = button.querySelector('.agent-status-chip-count');
        this.render(this.state);
        this.refresh();
        this.start();
        return this.element;
    }

    start() {
        if (!this.refreshIntervalMs || this.refreshTimer) return;
        this.refreshTimer = setInterval(() => {
            if (this.documentRef?.visibilityState === 'hidden') return;
            this.refresh();
        }, this.refreshIntervalMs);
    }

    stop() {
        if (!this.refreshTimer) return;
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
    }

    async refresh() {
        const token = ++this.refreshToken;
        try {
            const view = await Promise.resolve(this.collectView());
            if (token !== this.refreshToken) return;
            const failureSeenAt = Number(this.getFailureSeenAt?.() || 0) || 0;
            this.render(buildAgentStatusChipView(view, {
                ...this.viewOptions,
                failureSeenAt,
            }));
        } catch (err) {
            if (token !== this.refreshToken) return;
            this.render({
                label: 'Agent',
                count: '!',
                tone: 'failed',
                tab: 'activity',
                activityStatus: 'failure',
                title: `Agent 状态读取失败：${String(err?.message || err || 'unknown error')}`,
            });
        }
    }

    render(state = buildAgentStatusChipView({}, this.viewOptions)) {
        this.state = state;
        if (!this.element) return;
        const tone = String(state.tone || 'idle').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'idle';
        const count = String(state.count || '').trim();
        this.element.className = `agent-status-chip is-${tone}${count ? ' has-count' : ''}`;
        this.element.dataset.agentStatusTone = tone;
        this.element.title = state.title || '打开 Agent Center';
        this.element.setAttribute('aria-label', state.title || '打开 Agent Center');
        if (this.countElement) this.countElement.textContent = count;
    }
}
