const normalizeArchiveQuery = value => String(value || '').trim().toLowerCase();

// 正文命中片段：单行显示，关键词前只留 8 字、后取 40 字，窄屏也看得到高亮；空白折叠成一个空格
const buildArchiveHitSnippet = ({ raw = '', lower = '' } = {}, q = '') => {
  const idx = lower.indexOf(q);
  if (idx < 0) return null;
  const start = Math.max(0, idx - 8);
  const end = Math.min(raw.length, idx + q.length + 40);
  const flat = value => value.replace(/\s+/g, ' ');
  return {
    before: `${start > 0 ? '…' : ''}${flat(raw.slice(start, idx))}`,
    hit: flat(raw.slice(idx, idx + q.length)),
    after: `${flat(raw.slice(idx + q.length, end))}${end < raw.length ? '…' : ''}`,
  };
};

const renderArchiveHit = (entry, snippet, documentRef) => {
  if (!snippet) {
    if (entry.hitEl?.style) entry.hitEl.style.display = 'none';
    return;
  }
  if (!documentRef?.createElement) return;
  if (!entry.hitEl) {
    if (!entry.info?.appendChild) return;
    const hitEl = documentRef.createElement('div');
    hitEl.className = 'session-archive-hit';
    const label = documentRef.createElement('span');
    label.style.cssText = 'margin-right:6px; font-weight:600;';
    label.textContent = '正文';
    const text = documentRef.createElement('span');
    text.setAttribute('data-i18n-skip', '');
    hitEl.appendChild(label);
    hitEl.appendChild(text);
    hitEl.style.cssText = 'margin-top:2px; font-size:12px; color:var(--app-text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
    entry.info.appendChild(hitEl);
    entry.hitEl = hitEl;
    entry.hitText = text;
  }
  entry.hitEl.style.display = '';
  const mark = documentRef.createElement('mark');
  mark.style.cssText = 'background:var(--app-accent-soft); color:var(--app-text-primary); font-weight:700; border-radius:3px; padding:0 1px;';
  mark.textContent = snippet.hit;
  entry.hitText.replaceChildren(snippet.before, mark, snippet.after);
};

const archiveMatchesQuery = ({ archive = {}, dateText = '', messageCount = 0, isCurrent = false } = {}, query = '', contentText = '') => {
  const q = normalizeArchiveQuery(query);
  if (!q) return true;
  const fields = [
    archive.name,
    archive.id,
    dateText,
    `${messageCount}`,
    `${messageCount}条消息`,
    isCurrent ? '当前' : '',
  ];
  if (fields.some(value => String(value || '').toLowerCase().includes(q))) return true;
  // 正文命中（懒加载索引，见 renderSessionArchivesSection）
  return Boolean(contentText) && contentText.includes(q);
};

const createArchiveManagementControls = ({
  documentRef = null,
  query = '',
  total = 0,
  onSearch = () => {},
} = {}) => {
  if (!documentRef?.createElement) return null;
  const wrap = documentRef.createElement('div');
  wrap.style.cssText = 'position:sticky; top:0; z-index:1; display:flex; align-items:center; gap:8px; padding:8px; border-bottom:1px solid var(--app-border-subtle); background:var(--app-surface-subtle);';

  const input = documentRef.createElement('input');
  input.type = 'search';
  input.value = query;
  input.placeholder = '搜索存档名称 / 正文内容…';
  input.setAttribute?.('aria-label', '搜索存档');
  input.style.cssText = 'flex:1; min-width:0; height:30px; padding:0 9px; border:1px solid var(--app-border-default); border-radius:8px; background:var(--app-surface-input); color:var(--app-text-primary); font-size:12px;';

  const count = documentRef.createElement('div');
  count.style.cssText = 'min-width:52px; text-align:right; font-size:11px; color:var(--app-text-muted); white-space:nowrap;';
  count.textContent = `${total} 份`;

  const clearButton = documentRef.createElement('button');
  clearButton.type = 'button';
  clearButton.title = '清除搜索';
  clearButton.textContent = '×';
  clearButton.style.cssText = 'width:30px; height:30px; border:1px solid var(--app-border-default); border-radius:8px; background:var(--app-surface-card); color:var(--app-text-secondary); cursor:pointer; font-size:16px; line-height:1;';

  input.oninput = () => onSearch(input.value);
  clearButton.onclick = () => {
    input.value = '';
    onSearch('');
    input.focus?.();
  };

  wrap.appendChild(input);
  wrap.appendChild(count);
  wrap.appendChild(clearButton);

  return {
    wrap,
    input,
    count,
    clearButton,
  };
};

// 加载一份存档（点存档行确认后，或导入后点「立即加载」）：切换正文与记忆表，然后通知面板并关闭。
export const loadSessionArchive = async ({
  sessionId = '',
  isGroup = false,
  archive = null,
  getMemoryStorageMode = () => 'summary',
  buildMemoryTableSnapshot = async () => null,
  captureArchivePointer = async () => null,
  loadArchivedMessages = async () => null,
  getLastArchiveTransition = () => null,
  persistArchivePointer = async () => null,
  applyMemoryTableSnapshot = async () => null,
  restoreArchivePointerForLoadedThread = async () => null,
  logger = console,
  runArchiveSwitchFlow = async () => {},
  onArchiveLoaded = () => {},
  onHide = () => {},
  sourcePrefix = 'contact',
  restoreWarnMessage = 'restore checkpoint memory after archive load failed',
} = {}) => {
  await runArchiveSwitchFlow({
    sessionId,
    isGroup,
    archive,
    getMemoryStorageMode,
    buildMemoryTableSnapshot: ({ sessionId, isGroup }) => buildMemoryTableSnapshot({ sessionId, isGroup }),
    captureArchivePointer,
    loadArchivedMessages,
    getLastArchiveTransition,
    persistArchivePointer,
    applyMemoryTableSnapshot: ({ sessionId, isGroup, snapshot }) => applyMemoryTableSnapshot({ sessionId, isGroup, snapshot }),
    restoreArchivePointerForLoadedThread,
    logger,
    sourcePrefix,
    restoreWarnMessage,
  });
  onArchiveLoaded?.(sessionId, archive);
  onHide?.();
};

// 导入后新存档行淡淡强调一次（1.2 秒内消退，见 settings-panel-redesign.css）。
export const highlightSessionArchiveRow = (container, archiveId = '') => {
  const id = String(archiveId || '');
  const row = id
    ? [...(container?.querySelectorAll?.('[data-archive-id]') || [])].find(item => item.getAttribute('data-archive-id') === id)
    : null;
  if (!row) return false;
  row.classList.add('is-imported');
  row.addEventListener('animationend', () => row.classList.remove('is-imported'), { once: true });
  try {
    row.scrollIntoView?.({ block: 'nearest' });
  } catch {}
  return true;
};

export const renderSessionArchivesSection = ({
  container = null,
  sessionId = '',
  chatStore = null,
  isGroup = false,
  getMemoryStorageMode = () => 'summary',
  buildMemoryTableSnapshot = async () => null,
  captureArchivePointer = async () => null,
  loadArchivedMessages = async () => null,
  getLastArchiveTransition = () => null,
  persistArchivePointer = async () => null,
  applyMemoryTableSnapshot = async () => null,
  restoreArchivePointerForLoadedThread = async () => null,
  logger = console,
  appConfirmFn = async () => true,
  runArchiveSwitchFlow = async () => {},
  runArchiveDeleteFlow = async () => {},
  deleteArchiveTurnCheckpointState = async () => null,
  deleteArchive = async () => null,
  renameArchive = null,
  promptArchiveRenameName = null,
  includeCurrentThread = false,
  onExportCurrent = null,
  onExportArchive = null,
  onArchiveLoaded = () => {},
  onArchiveDeleted = () => {},
  onArchiveRenamed = () => {},
  onHide = () => {},
  createEmptyState = () => null,
  createArchiveRow = () => ({ row: null }),
  archiveSearchQuery = '',
  onArchiveSearchQueryChange = () => {},
  sourcePrefix = 'contact',
  restoreWarnMessage = 'restore checkpoint memory after archive load failed',
  deleteWarnMessage = 'delete archive turn checkpoint state failed',
} = {}) => {
  if (!container || !chatStore || !sessionId) return false;
  const archives = chatStore.getArchives(sessionId);
  const currentId = chatStore.state.sessions[sessionId]?.currentArchiveId;
  const currentMessageCount = Number(chatStore.getMessages?.(sessionId)?.length || 0) || 0;
  const shouldRenderCurrent = includeCurrentThread === true && typeof onExportCurrent === 'function';
  container.innerHTML = '';

  if (!archives.length && !shouldRenderCurrent) {
    const empty = createEmptyState?.();
    if (empty) container.appendChild(empty);
    return true;
  }

  const documentRef = container.ownerDocument || globalThis.document || null;
  const management = createArchiveManagementControls({
    documentRef,
    query: archiveSearchQuery,
    total: archives.length + (shouldRenderCurrent ? 1 : 0),
    onSearch: (query) => {
      onArchiveSearchQueryChange?.(query);
      applySearch(query);
    },
  });
  if (management?.wrap) container.appendChild(management.wrap);

  const entries = [];
  const filteredEmpty = documentRef?.createElement ? documentRef.createElement('div') : null;
  if (filteredEmpty) {
    filteredEmpty.style.cssText = 'display:none; padding:14px 12px; color:var(--app-text-muted); text-align:center; font-size:12px;';
    filteredEmpty.textContent = '没有匹配的存档';
  }

  // 正文索引：首次搜索时懒加载各存档消息（exportThreadMessages 纯读、无副作用），缓存本次渲染生命周期
  const contentIndex = new Map();
  let contentIndexPromise = null;
  const canIndexContent = typeof chatStore?.exportThreadMessages === 'function';
  const ensureContentIndex = () => {
    if (!canIndexContent) return null;
    if (contentIndexPromise) return contentIndexPromise;
    contentIndexPromise = (async () => {
      for (const archive of archives) {
        const aid = String(archive?.id || '').trim();
        if (!aid || contentIndex.has(aid)) continue;
        try {
          const msgs = await chatStore.exportThreadMessages(sessionId, aid);
          const text = (Array.isArray(msgs) ? msgs : [])
            .map(m => String(m?.content || ''))
            .join('\n');
          contentIndex.set(aid, { raw: text, lower: text.toLowerCase() });
        } catch {
          contentIndex.set(aid, { raw: '', lower: '' });
        }
      }
    })();
    return contentIndexPromise;
  };

  const applySearch = (query = '') => {
    const q = normalizeArchiveQuery(query);
    // 有查询且索引未建 → 后台建索引，就绪后按当前输入重跑一次
    if (q && canIndexContent && !contentIndexPromise) {
      ensureContentIndex()?.then?.(() => {
        applySearch(management?.input?.value ?? query);
      });
    }
    let visible = 0;
    for (const entry of entries) {
      const indexed = contentIndex.get(String(entry.archive?.id || '').trim()) || null;
      const matched = archiveMatchesQuery(entry, query, indexed?.lower || '');
      if (matched) visible += 1;
      if (entry.row?.style) entry.row.style.display = matched ? '' : 'none';
      // 正文命中时在存档名下显示片段并高亮关键词，帮助定位是哪份存档
      renderArchiveHit(entry, q && matched && indexed?.lower ? buildArchiveHitSnippet(indexed, q) : null, documentRef);
    }
    if (management?.count) {
      management.count.textContent = q ? `${visible} / ${archives.length}` : `${archives.length} 份`;
    }
    if (management?.clearButton?.style) {
      management.clearButton.style.visibility = q ? 'visible' : 'hidden';
    }
    if (filteredEmpty?.style) {
      filteredEmpty.style.display = visible ? 'none' : 'block';
    }
  };

  if (shouldRenderCurrent) {
    const { row, info } = createArchiveRow({
      archiveId: '',
      archiveName: '当前聊天',
      isCurrent: true,
      dateText: '当前可见线程',
      messageCount: currentMessageCount,
      canRename: false,
      canDelete: false,
      onSelect: () => {},
      onExport: async (event) => {
        event?.stopPropagation?.();
        event?.preventDefault?.();
        await onExportCurrent?.({ sessionId });
      },
    });
    if (row) {
      entries.push({
        row,
        info,
        archive: { id: '', name: '当前聊天' },
        dateText: '当前可见线程',
        messageCount: currentMessageCount,
        isCurrent: true,
      });
      container.appendChild(row);
    }
  }

  archives.forEach((archive) => {
    const dateText = new Date(archive.timestamp).toLocaleString();
    const messageCount = Number(archive.messageCount || (Array.isArray(archive.messages) ? archive.messages.length : 0)) || 0;
    const isCurrent = archive.id === currentId;
    const { row, info } = createArchiveRow({
      archiveId: archive.id,
      archiveName: archive.name,
      isCurrent,
      dateText,
      messageCount,
      onSelect: async () => {
        if (isCurrent) return;
        const ok = await appConfirmFn({
          title: '加载存档',
          message: `确定要加载存档「${archive.name}」吗？\n当前聊天将被自动保存；正文会随存档切换，记忆表与变量（如启用记忆表）也会一起切换。`,
        });
        if (!ok) return;
        await loadSessionArchive({
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
      },
      onExport: typeof onExportArchive === 'function'
        ? async (event) => {
            event?.stopPropagation?.();
            event?.preventDefault?.();
            await onExportArchive?.({ sessionId, archive });
          }
        : null,
      onRename: async (event) => {
        event?.stopPropagation?.();
        event?.preventDefault?.();
        const currentName = String(archive.name || '').trim();
        const raw = await Promise.resolve(
          typeof promptArchiveRenameName === 'function'
            ? promptArchiveRenameName({ sessionId, archive })
            : globalThis.prompt?.('重命名存档', currentName),
        );
        if (raw === null || raw === undefined) return;
        const nextName = String(raw || '').trim();
        if (!nextName || nextName === currentName) return;
        const renameFn = typeof renameArchive === 'function'
          ? renameArchive
          : (archiveId, name, sid) => chatStore.renameArchive?.(archiveId, name, sid);
        const renamed = await Promise.resolve(renameFn?.(archive.id, nextName, sessionId));
        if (!renamed) return;
        archive.name = nextName;
        onArchiveRenamed?.(sessionId, archive);
      },
      onDelete: async (event) => {
        event?.stopPropagation?.();
        const ok = await appConfirmFn({
          title: '删除存档',
          message: `确定要删除存档「${archive.name || '未命名存档'}」吗？`,
          danger: true,
        });
        if (!ok) return;
        await runArchiveDeleteFlow({
          sessionId,
          archiveId: archive.id,
          deleteArchiveTurnCheckpointState,
          deleteArchive,
          renderArchives: onArchiveDeleted,
          logger,
          warnMessage: deleteWarnMessage,
        });
      },
    });
    if (row) {
      entries.push({ row, info, archive, dateText, messageCount, isCurrent });
      container.appendChild(row);
    }
  });
  if (filteredEmpty) container.appendChild(filteredEmpty);
  applySearch(archiveSearchQuery);
  return true;
};
