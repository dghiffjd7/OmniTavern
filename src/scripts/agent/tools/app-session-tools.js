const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const normalizeKey = value => trim(value).toLowerCase().replace(/\s+/g, '');

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

const isGroupLikeId = id => trim(id).startsWith('group:');
const isRpLikeId = id => trim(id).startsWith('rp:');

const resolveContactList = contactsStore => (
  contactsStore?.listContacts?.() ||
  []
).filter(Boolean);

const findContact = (contactsStore, query = '') => {
  const q = trim(query);
  if (!q) return null;
  const qKey = normalizeKey(q);
  return resolveContactList(contactsStore).find((contact) => {
    const id = trim(contact?.id);
    const name = trim(contact?.name);
    return id === q || name === q || normalizeKey(id) === qKey || normalizeKey(name) === qKey;
  }) || null;
};

const findStoredSessionId = (chatStore, query = '') => {
  const q = trim(query);
  if (!q) return '';
  const qKey = normalizeKey(q);
  const listed = chatStore?.listSessions?.();
  const sessionIds = Array.isArray(listed) ? listed : [];
  return sessionIds
    .map(sessionId => trim(sessionId))
    .find(sessionId => sessionId === q || normalizeKey(sessionId) === qKey) || '';
};

const summarizeContact = contact => ({
  id: trim(contact?.id),
  name: trim(contact?.name || contact?.id),
  isGroup: contact?.isGroup === true || isGroupLikeId(contact?.id),
  memberCount: Array.isArray(contact?.members) ? contact.members.length : 0,
});

const normalizeStringList = value => (
  Array.isArray(value) ? value : (value ? [value] : [])
).map(item => trim(item)).filter(Boolean);

const fingerprintSessionDeleteValue = (value) => {
  const state = { first: 0x811c9dc5, second: 0x9e3779b9, length: 0 };
  const seen = new Set();
  const feed = (text) => {
    const input = String(text ?? '');
    state.length += input.length;
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      state.first ^= code;
      state.first = Math.imul(state.first, 0x01000193);
      state.second ^= code + ((state.second << 6) >>> 0) + (state.second >>> 2);
    }
  };
  const visit = (input) => {
    if (input === null) { feed('null'); return; }
    if (input === undefined) { feed('undefined'); return; }
    if (typeof input === 'string') { feed('s'); feed(input); return; }
    if (typeof input === 'number') { feed(`n${Number.isFinite(input) ? input : 'null'}`); return; }
    if (typeof input === 'boolean') { feed(input ? 'true' : 'false'); return; }
    if (typeof input !== 'object') { feed(`${typeof input}:${String(input)}`); return; }
    if (seen.has(input)) { feed('[Circular]'); return; }
    seen.add(input);
    if (Array.isArray(input)) {
      feed('[');
      input.forEach(visit);
      feed(']');
    } else {
      feed('{');
      Object.keys(input)
        .filter(key => !key.startsWith('_'))
        .sort()
        .forEach((key) => {
          feed(key);
          visit(input[key]);
        });
      feed('}');
    }
    seen.delete(input);
  };
  visit(value);
  return `${state.length}:${state.first >>> 0}:${state.second >>> 0}`;
};

export const createSessionDeleteRevisionToken = ({
  sessionId = '',
  chatStore = null,
  contactsStore = null,
} = {}) => {
  const sid = trim(sessionId);
  if (!sid) return 'session:missing';
  const contact = findContact(contactsStore, sid);
  const storedSession = chatStore?.state?.sessions?.[sid];
  const session = storedSession && typeof storedSession === 'object'
    ? storedSession
    : {
        messages: chatStore?.getMessages?.(sid) || [],
        pending: chatStore?.getPendingMessages?.(sid) || [],
        draft: chatStore?.getDraft?.(sid) || '',
        settings: chatStore?.getSessionSettings?.(sid) || null,
      };
  const contactSnapshot = contact
    ? {
        id: trim(contact.id),
        name: trim(contact.name),
        avatar: trim(contact.avatar),
        isGroup: contact.isGroup === true,
        members: Array.isArray(contact.members) ? contact.members.map(item => trim(item)).filter(Boolean) : [],
        addedAt: Number(contact.addedAt || 0) || 0,
        updatedAt: Number(contact.updatedAt || 0) || 0,
      }
    : null;
  return `session:${fingerprintSessionDeleteValue({ contact: contactSnapshot, session })}`;
};

const resolveCreateSessionNames = (args = {}) => {
  const names = Array.isArray(args.names)
    ? args.names
    : (Array.isArray(args.nameList) ? args.nameList : []);
  const merged = [
    trim(args.name),
    ...names.map(item => trim(item)),
  ].filter(Boolean);
  return Array.from(new Set(merged)).slice(0, 20);
};

const buildSessionNameHtmlFallback = (id, contact = null) => trim(contact?.name || id, id);

const formatNowTime = () => {
  try {
    return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
};

export const createAppSessionAgentTools = ({
  contactsStore = null,
  chatStore = null,
  enterChatRoom = null,
  refreshChatAndContacts = null,
  setActiveSession = null,
  showSessionConfig = null,
  deleteSession = null,
  renderSessionNameHtml = buildSessionNameHtmlFallback,
  defaultAvatar = '',
  now = Date.now,
} = {}) => {
  const openSession = async (sessionId = '', { originPage = 'chat', suppressInitialAutoScroll = true } = {}) => {
    const sid = trim(sessionId);
    if (!sid) return { ok: false, reason: 'missing_session_id' };
    const contact = contactsStore?.getContact?.(sid) || null;
    chatStore?.switchSession?.(sid);
    setActiveSession?.(sid);
    refreshChatAndContacts?.({ immediate: true });
    if (typeof enterChatRoom === 'function') {
      const title = renderSessionNameHtml?.(sid, contact) || contact?.name || sid;
      const enterResult = await enterChatRoom(sid, title, originPage, { suppressInitialAutoScroll });
      return {
        ok: enterResult?.blocked === true ? false : true,
        sessionId: sid,
        contact: contact ? summarizeContact(contact) : null,
        enterResult: clone(enterResult),
      };
    }
    return {
      ok: true,
      sessionId: sid,
      contact: contact ? summarizeContact(contact) : null,
    };
  };

  const createOneSession = async (name = '', args = {}) => {
    const sessionName = trim(name);
    if (!sessionName) return { ok: false, created: false, reason: 'missing_name' };
    if (isGroupLikeId(sessionName) || isRpLikeId(sessionName)) {
      return { ok: false, created: false, reason: 'reserved_prefix', name: sessionName };
    }
    const existing = contactsStore?.getContact?.(sessionName) || findContact(contactsStore, sessionName);
    if (existing) {
      const sid = trim(existing.id || sessionName);
      const contact = {
        ...summarizeContact(existing),
        description: typeof existing.description === 'string' ? existing.description : '',
      };
      const opened = args.open === true ? await openSession(sid) : null;
      return {
        ok: true,
        created: false,
        existing: true,
        sessionId: sid,
        contact,
        opened,
      };
    }
    const contact = {
      id: sessionName,
      name: sessionName,
      avatar: trim(args.avatar || defaultAvatar),
      isGroup: false,
      addedAt: Number(now?.() || Date.now()) || Date.now(),
      labels: [],
      isUserCreated: true,
    };
    contactsStore?.upsertContact?.(contact);
    const time = formatNowTime();
    if (typeof chatStore?.appendMessage === 'function') {
      try {
        chatStore.appendMessage({
          role: 'system',
          type: 'meta',
          content: `你创建了聊天室「${sessionName}」`,
          name: '系统',
          avatar: '',
          time,
        }, sessionName);
      } catch {}
    }
    refreshChatAndContacts?.({ immediate: true });
    const opened = args.open === true ? await openSession(sessionName) : null;
    return {
      ok: true,
      created: true,
      sessionId: sessionName,
      contact: summarizeContact(contact),
      opened,
    };
  };

  const deleteSnapshots = new WeakMap();
  const buildDeleteSnapshot = async (args = {}) => {
    const requested = normalizeStringList(args.sessions).slice(0, 100);
    const currentSessionId = trim(chatStore?.getCurrent?.());
    const items = [];
    const seen = new Set();
    for (const target of requested) {
      const contact = findContact(contactsStore, target);
      const sessionId = trim(contact?.id || target);
      const label = trim(contact?.name || sessionId, target);
      const isGroup = contact?.isGroup === true || isGroupLikeId(sessionId);
      if (seen.has(sessionId)) {
        items.push({
          target,
          sessionId,
          name: label,
          status: 'skipped',
          reason: 'duplicate_target',
          isGroup,
        });
        continue;
      }
      seen.add(sessionId);
      if (isRpLikeId(sessionId)) {
        items.push({
          target,
          sessionId,
          name: label,
          avatar: trim(contact?.avatar),
          status: 'protected',
          reason: 'rp_session_excluded',
          isGroup,
        });
        continue;
      }
      if (sessionId === currentSessionId) {
        items.push({
          target,
          sessionId,
          name: label,
          avatar: trim(contact?.avatar),
          status: 'protected',
          reason: 'current_session_protected',
          isGroup,
        });
        continue;
      }
      if (!contact) {
        items.push({
          target,
          sessionId,
          name: label,
          status: 'missing',
          reason: 'session_not_found',
          isGroup,
        });
        continue;
      }
      items.push({
        target,
        sessionId,
        name: label,
        avatar: trim(contact?.avatar),
        status: 'planned',
        reason: '',
        isGroup,
        revision: createSessionDeleteRevisionToken({ sessionId, chatStore, contactsStore }),
      });
    }
    return {
      requested,
      items,
      plannedCount: items.filter(item => item.status === 'planned').length,
    };
  };

  const compactDeleteItem = item => ({
    target: trim(item?.target),
    sessionId: trim(item?.sessionId),
    sessionName: trim(item?.name || item?.sessionId),
    status: trim(item?.status),
    reason: trim(item?.reason),
    isGroup: item?.isGroup === true,
  });

  return [
    {
      name: 'session.list',
      title: 'List chat sessions',
      description: 'List contacts and groups available as chat sessions.',
      source: 'maid-app-session',
      permissions: [],
      riskLevel: 'low',
      capabilities: {
        read: true,
        write: false,
        network: false,
        cost: 'none',
        undo: 'none',
        modelContext: 'allowlist',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          offset: { type: 'integer', minimum: 0 },
          includeGroups: { type: 'boolean' },
          groupsOnly: { type: 'boolean' },
        },
      },
      execute: async (args = {}) => {
        const limit = Math.max(1, Math.min(100, Math.trunc(Number(args.limit) || 30)));
        const offset = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(Number(args.offset) || 0)));
        const includeGroups = args.includeGroups !== false;
        const matching = resolveContactList(contactsStore)
          .filter(contact => !isRpLikeId(contact?.id))
          .filter(contact => includeGroups || !(contact?.isGroup === true || isGroupLikeId(contact?.id)))
          .filter(contact => args.groupsOnly !== true || contact?.isGroup === true || isGroupLikeId(contact?.id));
        const contacts = matching.slice(offset, offset + limit).map(summarizeContact);
        const hasMore = offset + contacts.length < matching.length;
        return {
          count: contacts.length,
          total: matching.length,
          offset,
          limit,
          hasMore,
          nextOffset: hasMore ? offset + contacts.length : null,
          contacts,
          currentSessionId: trim(chatStore?.getCurrent?.()),
        };
      },
      summarizeResult: result => `listed ${Number(result?.count || 0)} session(s)`,
    },
    {
      name: 'session.create',
      title: 'Create chat session',
      description: 'Create one or more private contacts and chat sessions in the background; open only the primary result when explicitly requested.',
      source: 'maid-app-session',
      permissions: [],
      riskLevel: 'medium',
      capabilities: {
        read: true,
        write: true,
        network: false,
        cost: 'none',
        undo: 'manual_delete',
        modelContext: 'none',
        confirmation: 'allow_once',
      },
      safety: {
        operationType: 'create',
        destructive: 'never',
        description: 'Creates a new chat session/contact or reuses an existing one; it does not overwrite existing chat content.',
      },
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          names: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 80 },
          },
          nameList: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 80 },
          },
          avatar: { type: 'string', maxLength: 500000 },
          open: { type: 'boolean' },
        },
      },
      execute: async (args = {}) => {
        const names = resolveCreateSessionNames(args);
        if (names.length > 1) {
          const sessions = [];
          for (const name of names) {
            const result = await createOneSession(name, { ...args, open: false });
            sessions.push(result);
          }
          const failed = sessions.find(item => item?.ok === false);
          if (failed) {
            return {
              ok: false,
              created: false,
              reason: failed.reason || 'session_create_failed',
              failed,
              sessions,
            };
          }
          const sessionIds = sessions.map(item => item.sessionId).filter(Boolean);
          const openedSessionId = args.open === true ? trim(sessionIds[0]) : '';
          const opened = openedSessionId ? await openSession(openedSessionId) : null;
          return {
            ok: true,
            created: sessions.some(item => item?.created === true),
            createdCount: sessions.filter(item => item?.created === true).length,
            count: sessions.length,
            sessions,
            sessionIds,
            ...(openedSessionId ? { openedSessionId, opened } : {}),
          };
        }
        const name = names[0] || '';
        return createOneSession(name, args);
      },
      summarizeResult: result => {
        if (Array.isArray(result?.sessions)) {
          return `created ${Number(result.createdCount || 0)} of ${Number(result.count || result.sessions.length || 0)} session(s): ${result.sessionIds?.join(', ') || '-'}`;
        }
        return result?.created
          ? `created session ${trim(result.sessionId, '-')}`
          : `session already exists ${trim(result?.sessionId, '-')}`;
      },
    },
    {
      name: 'session.open',
      title: 'Open chat session',
      description: 'Open a private or group chat session by id or display name.',
      source: 'maid-app-session',
      permissions: [],
      riskLevel: 'low',
      capabilities: {
        read: true,
        write: false,
        network: false,
        cost: 'none',
        undo: 'none',
        modelContext: 'none',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        required: ['sessionId'],
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', minLength: 1, maxLength: 160 },
        },
      },
      execute: async (args = {}) => {
        const contact = findContact(contactsStore, args.sessionId);
        const sid = trim(contact?.id || args.sessionId);
        if (!sid) return { ok: false, reason: 'missing_session_id' };
        if (!contact && contactsStore && typeof contactsStore.getContact === 'function') {
          return { ok: false, reason: 'session_not_found', sessionId: sid };
        }
        return openSession(sid);
      },
      summarizeResult: result => result?.ok === false
        ? `open session failed: ${trim(result.reason, 'unknown')}`
        : `opened session ${trim(result?.sessionId, '-')}`,
    },
    {
      name: 'session.delete_many',
      title: 'Delete multiple chat sessions',
      description: 'Delete multiple explicit visible chat sessions with one structured confirmation. The current session and RP sessions are protected.',
      source: 'maid-app-session',
      permissions: [],
      riskLevel: 'high',
      capabilities: {
        read: true,
        write: true,
        network: false,
        cost: 'none',
        undo: 'none',
        modelContext: 'none',
        confirmation: 'required',
      },
      safety: {
        operationType: 'delete_chat_sessions',
        destructive: 'conditional',
        description: 'Permanently deletes selected visible chat sessions and their owned chat data.',
        preflight: async (args = {}) => {
          const snapshot = await buildDeleteSnapshot(args);
          deleteSnapshots.set(args, snapshot);
          if (args.preview === true || snapshot.plannedCount === 0) {
            return { destructive: false, operationType: 'delete_chat_sessions' };
          }
          return {
            destructive: true,
            kind: 'session.delete_many',
            operationType: 'delete_chat_sessions',
            title: '批量删除聊天室',
            message: `将永久删除 ${snapshot.plannedCount} 个聊天室及其聊天记录、联系人资料和内部归档。请确认列表范围。`,
            confirmText: '确认删除',
            cancelText: '取消',
            danger: true,
            allowAlways: false,
            details: {
              resource: 'session',
              requestedCount: snapshot.requested.length,
              plannedCount: snapshot.plannedCount,
              items: snapshot.items.map(item => ({
                id: item.sessionId,
                label: item.name,
                avatar: item.avatar,
                showAvatar: true,
                meta: item.isGroup ? '群聊' : '私聊',
                status: item.status,
                reason: item.reason,
              })),
            },
            onDeny: {
              action: 'skip',
              reason: 'session_delete_cancelled',
              result: {
                ok: false,
                skipped: true,
                reason: 'session_delete_cancelled',
                requestedCount: snapshot.requested.length,
                plannedCount: snapshot.plannedCount,
              },
            },
          };
        },
      },
      schema: {
        type: 'object',
        required: ['sessions'],
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: { type: 'string', minLength: 1, maxLength: 160 },
          },
          preview: { type: 'boolean' },
        },
      },
      execute: async (args = {}, context = {}) => {
        const snapshot = deleteSnapshots.get(args) || await buildDeleteSnapshot(args);
        const preview = args.preview === true;
        if (preview) {
          return {
            ok: true,
            preview: true,
            requestedCount: snapshot.requested.length,
            plannedCount: snapshot.plannedCount,
            results: snapshot.items.map(compactDeleteItem),
          };
        }
        if (
          snapshot.plannedCount > 0 &&
          (
            context?.toolSafety?.decision !== 'allow' ||
            context?.toolSafety?.request?.kind !== 'session.delete_many'
          )
        ) {
          return {
            ok: false,
            reason: 'confirmation_required',
            requestedCount: snapshot.requested.length,
            plannedCount: snapshot.plannedCount,
            results: snapshot.items.map(compactDeleteItem),
          };
        }

        const results = [];
        const deletedItems = [];
        for (const item of snapshot.items) {
          if (item.status !== 'planned') {
            results.push(compactDeleteItem(item));
            continue;
          }
          const sessionId = trim(item.sessionId);
          if (sessionId === trim(chatStore?.getCurrent?.())) {
            results.push(compactDeleteItem({
              ...item,
              status: 'skipped',
              reason: 'current_session_protected',
            }));
            continue;
          }
          const currentContact = findContact(contactsStore, sessionId);
          if (!currentContact) {
            results.push(compactDeleteItem({
              ...item,
              status: 'skipped',
              reason: 'already_absent',
            }));
            continue;
          }
          const currentRevision = createSessionDeleteRevisionToken({
            sessionId,
            chatStore,
            contactsStore,
          });
          if (item.revision && currentRevision !== item.revision) {
            results.push(compactDeleteItem({
              ...item,
              status: 'skipped',
              reason: 'session_changed_during_confirmation',
            }));
            continue;
          }
          if (typeof deleteSession !== 'function') {
            results.push(compactDeleteItem({
              ...item,
              status: 'failed',
              reason: 'session_delete_unavailable',
            }));
            continue;
          }
          try {
            const deleted = await deleteSession(sessionId);
            if (deleted?.deleted === false && deleted?.reason === 'already_absent') {
              results.push(compactDeleteItem({
                ...item,
                status: 'skipped',
                reason: 'already_absent',
              }));
              continue;
            }
            if (deleted?.ok === false) {
              results.push(compactDeleteItem({
                ...item,
                status: 'failed',
                reason: trim(deleted?.reason, 'delete_failed'),
              }));
              continue;
            }
            const stillPresent = Boolean(findContact(contactsStore, sessionId));
            if (stillPresent) {
              results.push(compactDeleteItem({
                ...item,
                status: 'failed',
                reason: 'verification_failed',
              }));
              continue;
            }
            results.push(compactDeleteItem({
              ...item,
              status: 'succeeded',
              reason: '',
            }));
            deletedItems.push({ id: sessionId, name: item.name });
          } catch (error) {
            results.push({
              ...compactDeleteItem({
                ...item,
                status: 'failed',
                reason: 'delete_failed',
              }),
              errorMessage: trim(error?.message || error),
            });
          }
        }
        if (deletedItems.length) await refreshChatAndContacts?.({ immediate: true });
        const succeededCount = results.filter(item => item.status === 'succeeded').length;
        const skippedCount = results.filter(item => ['skipped', 'protected', 'missing'].includes(item.status)).length;
        const failed = results.filter(item => item.status === 'failed');
        return {
          ok: failed.length === 0,
          partial: failed.length > 0 && succeededCount > 0,
          preview: false,
          requestedCount: snapshot.requested.length,
          succeededCount,
          skippedCount,
          failedCount: failed.length,
          results,
          retry: failed.length
            ? {
                toolName: 'session.delete_many',
                args: { sessions: failed.map(item => item.sessionId).filter(Boolean) },
              }
            : null,
          audit: {
            kind: 'session.delete_many',
            deletedAt: Number(now?.() || Date.now()) || Date.now(),
            items: deletedItems,
          },
        };
      },
      summarizeResult: result => [
        `batch session deletion ${result?.ok ? 'completed' : 'incomplete'}`,
        `${Number(result?.succeededCount || 0)} succeeded`,
        `${Number(result?.skippedCount || 0)} skipped`,
        `${Number(result?.failedCount || 0)} failed`,
      ].join('; '),
    },
    {
      name: 'session.open_config',
      title: 'Open session config',
      description: 'Open the session configuration panel for current or specified session.',
      source: 'maid-app-session',
      permissions: [],
      riskLevel: 'low',
      capabilities: {
        read: false,
        write: false,
        network: false,
        cost: 'none',
        undo: 'none',
        modelContext: 'none',
        confirmation: 'allow_once',
      },
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', maxLength: 160 },
          sessionName: { type: 'string', maxLength: 160 },
          target: { type: 'string', maxLength: 160 },
          chatName: { type: 'string', maxLength: 160 },
          name: { type: 'string', maxLength: 160 },
        },
      },
      execute: async (args = {}) => {
        const raw = trim(args.sessionId || args.sessionName || args.target || args.chatName || args.name);
        const contact = raw ? findContact(contactsStore, raw) : null;
        const storedSessionId = raw ? findStoredSessionId(chatStore, raw) : '';
        // 面板以 chatStore 会话为权威来源；联系人显示名与无联系人会话 ID 都可定位，
        // 两边均不存在时才拒绝，避免打开“幽灵”配置页。
        if (raw && !contact && !storedSessionId) {
          return { ok: false, opened: false, reason: 'session_not_found', target: raw };
        }
        const sid = trim(contact?.id || storedSessionId || raw || chatStore?.getCurrent?.());
        if (!sid) return { ok: false, opened: false, reason: 'missing_session_id' };
        if (typeof showSessionConfig !== 'function') {
          return { ok: false, opened: false, reason: 'session_config_unavailable', sessionId: sid };
        }
        await showSessionConfig({ sessionId: sid });
        return { ok: true, opened: true, sessionId: sid };
      },
      summarizeResult: result => result?.opened
        ? `opened session config ${trim(result.sessionId, '-')}`
        : `open session config failed: ${trim(result?.reason, 'unknown')}`,
    },
  ];
};

export const registerAppSessionAgentTools = (registry, deps = {}) => {
  const tools = createAppSessionAgentTools(deps);
  if (!registry || typeof registry.registerMany !== 'function') return tools;
  registry.registerMany(tools);
  return tools;
};
