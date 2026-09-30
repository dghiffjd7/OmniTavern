import { t } from '../../i18n/index.js';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const normalizeKey = value => trim(value).toLowerCase().replace(/\s+/g, '');
const normalizeList = (value, limit = 50) => (
  Array.isArray(value) ? value : (value ? [value] : [])
).map(item => trim(item)).filter(Boolean).slice(0, limit);
const unique = value => Array.from(new Set(normalizeList(value)));
const isGroup = contact => contact?.isGroup === true || trim(contact?.id).startsWith('group:');
const isRp = contact => trim(contact?.id).startsWith('rp:');
const sameList = (left = [], right = []) => (
  left.length === right.length && left.every((item, index) => item === right[index])
);
const sameSet = (left = [], right = []) => (
  left.length === right.length && left.every(item => right.includes(item))
);
const hasOwn = (value, key) => Boolean(value && Object.prototype.hasOwnProperty.call(value, key));

const listContacts = store => (
  typeof store?.listContacts === 'function' ? store.listContacts() : []
).filter(Boolean);

const compactMember = contact => ({
  id: trim(contact?.id),
  name: trim(contact?.name || contact?.id),
});

const compactResolutionItem = item => ({
  target: trim(item?.target),
  memberId: trim(item?.memberId),
  name: trim(item?.name || item?.target),
  status: trim(item?.status),
  reason: trim(item?.reason),
});

const resolveGroup = (contactsStore, query = '') => {
  const target = trim(query);
  if (!target) return { group: null, reason: 'missing_group' };
  const direct = contactsStore?.getContact?.(target);
  if (direct) {
    return isGroup(direct)
      ? { group: direct, reason: '' }
      : { group: null, reason: 'target_is_not_group' };
  }
  const key = normalizeKey(target);
  const matches = listContacts(contactsStore).filter(contact => (
    isGroup(contact) &&
    (normalizeKey(contact?.id) === key || normalizeKey(contact?.name) === key)
  ));
  if (matches.length === 1) return { group: matches[0], reason: '' };
  if (matches.length > 1) return { group: null, reason: 'group_target_ambiguous' };
  return { group: null, reason: 'group_not_found' };
};

const resolveMember = (contactsStore, query = '', {
  currentMemberIds = [],
  currentOnly = false,
} = {}) => {
  const target = trim(query);
  if (!target) return { contact: null, reason: 'member_not_found' };
  const currentIds = new Set(unique(currentMemberIds));
  const direct = contactsStore?.getContact?.(target);
  if (direct) {
    if (isGroup(direct)) return { contact: null, reason: 'group_cannot_be_member' };
    if (isRp(direct)) return { contact: null, reason: 'rp_session_excluded' };
    if (currentOnly && !currentIds.has(trim(direct.id))) {
      return { contact: null, reason: 'member_not_in_group' };
    }
    return { contact: direct, reason: '' };
  }
  if (currentOnly && currentIds.has(target)) {
    return { contact: { id: target, name: target, isGroup: false }, reason: '' };
  }
  const key = normalizeKey(target);
  const matches = listContacts(contactsStore).filter(contact => (
    !isGroup(contact) &&
    !isRp(contact) &&
    (!currentOnly || currentIds.has(trim(contact?.id))) &&
    (normalizeKey(contact?.id) === key || normalizeKey(contact?.name) === key)
  ));
  if (matches.length === 1) return { contact: matches[0], reason: '' };
  if (matches.length > 1) return { contact: null, reason: 'member_target_ambiguous' };
  return { contact: null, reason: currentOnly ? 'member_not_in_group' : 'member_not_found' };
};

const resolveMemberItems = (contactsStore, targets = [], options = {}) => {
  const seen = new Set();
  return normalizeList(targets).map(target => {
    const resolved = resolveMember(contactsStore, target, options);
    const memberId = trim(resolved.contact?.id);
    if (!memberId) {
      return {
        target,
        memberId: '',
        name: target,
        avatar: '',
        status: resolved.reason === 'member_not_in_group' ? 'skipped' : 'missing',
        reason: resolved.reason,
      };
    }
    if (seen.has(memberId)) {
      return {
        target,
        memberId,
        name: trim(resolved.contact?.name || memberId),
        avatar: trim(resolved.contact?.avatar),
        status: 'skipped',
        reason: 'duplicate_member',
      };
    }
    seen.add(memberId);
    return {
      target,
      memberId,
      name: trim(resolved.contact?.name || memberId),
      avatar: trim(resolved.contact?.avatar),
      status: 'planned',
      reason: '',
    };
  });
};

const summarizeGroup = (group = {}, contactsStore = null) => {
  const memberIds = unique(group?.members);
  return {
    id: trim(group?.id),
    name: trim(group?.name || group?.id),
    isGroup: isGroup(group),
    memberCount: memberIds.length,
    members: memberIds.map(id => compactMember(contactsStore?.getContact?.(id) || { id, name: id })),
  };
};

const makeTime = (now = Date.now) => {
  try {
    return new Date(Number(now?.() || Date.now()) || Date.now())
      .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
};

export const createGroupChatAgentTools = ({
  contactsStore = null,
  chatStore = null,
  getCurrentContext = null,
  enterChatRoom = null,
  refreshChatAndContacts = null,
  setActiveSession = null,
  renderSessionNameHtml = (id, contact) => trim(contact?.name || id, id),
  createGroupId = () => `group:${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  now = Date.now,
} = {}) => {
  const createSnapshots = new WeakMap();
  const updateSnapshots = new WeakMap();

  const captureMaidScope = (context = {}) => {
    if (context.source !== 'maid-assistant') return null;
    let current;
    try { current = getCurrentContext?.(); } catch {}
    if (!trim(context.roleCardId) || !trim(context.uiMode) || !trim(current?.roleCardId)
      || !trim(current?.uiMode) || typeof current?.scopeId !== 'string'
      || typeof contactsStore?.scopeId !== 'string' || typeof chatStore?.scopeId !== 'string'
      || !Number.isSafeInteger(contactsStore?._scopeToken) || !Number.isSafeInteger(chatStore?._scopeToken)) {
      return { reason: 'group_scope_unavailable' };
    }
    if (trim(context.roleCardId) !== trim(current.roleCardId)
      || trim(context.sessionId) !== trim(current.sessionId) || trim(context.uiMode) !== trim(current.uiMode)
      || current.scopeId !== contactsStore.scopeId || current.scopeId !== chatStore.scopeId) {
      return { reason: 'target_scope_changed' };
    }
    return {
      scope: { roleCardId: trim(current.roleCardId), sessionId: trim(current.sessionId), uiMode: trim(current.uiMode),
        contactsScopeId: contactsStore.scopeId, chatScopeId: chatStore.scopeId,
        contactsScopeToken: contactsStore._scopeToken, chatScopeToken: chatStore._scopeToken },
      contactsReady: contactsStore.ready, chatReady: chatStore.ready,
    };
  };
  const validateMaidScope = (context, captured) => {
    if (context?.source !== 'maid-assistant') return '';
    if (captured?.reason) return captured.reason;
    const current = captureMaidScope(context);
    if (current?.reason) return current.reason;
    if (!captured?.scope || Object.keys(current.scope).some(key => current.scope[key] !== captured.scope[key])
      || current.contactsReady !== captured.contactsReady || current.chatReady !== captured.chatReady) {
      return 'target_scope_changed';
    }
    return '';
  };
  const groupScopeFailure = (reason, args = {}) => ({ ok: false, created: false, preview: args.preview === true, reason });

  const openGroup = async (group = {}) => {
    const groupId = trim(group?.id);
    if (!groupId) return { ok: false, reason: 'missing_group_id' };
    chatStore?.switchSession?.(groupId);
    setActiveSession?.(groupId);
    refreshChatAndContacts?.({ immediate: true });
    if (typeof enterChatRoom !== 'function') return { ok: true, sessionId: groupId };
    const result = await enterChatRoom(
      groupId,
      renderSessionNameHtml?.(groupId, group) || trim(group?.name || groupId),
      'chat',
      { suppressInitialAutoScroll: true },
    );
    return {
      ok: result?.blocked !== true,
      sessionId: groupId,
      enterResult: result || null,
    };
  };

  const findNameConflict = (name = '') => {
    const key = normalizeKey(name);
    return listContacts(contactsStore).find(contact => (
      normalizeKey(contact?.name) === key || normalizeKey(contact?.id) === key
    )) || null;
  };

  const buildCreateSnapshot = (args = {}) => {
    const name = trim(args.name);
    const requested = normalizeList(args.members);
    const items = resolveMemberItems(contactsStore, requested);
    const plannedIds = items.filter(item => item.status === 'planned').map(item => item.memberId);
    const unresolved = items.filter(item => item.status === 'missing');
    const conflict = name ? findNameConflict(name) : null;
    const existingSame = conflict && isGroup(conflict) &&
      unresolved.length === 0 &&
      sameSet(unique(conflict.members), plannedIds);
    let reason = '';
    if (!name) reason = 'group_name_required';
    else if (conflict && !existingSame) reason = isGroup(conflict) ? 'group_already_exists' : 'group_name_conflict';
    else if (unresolved.length) reason = 'group_members_unresolved';
    else if (plannedIds.length < 2) reason = 'group_requires_two_members';
    return {
      groupId: trim(existingSame ? conflict.id : createGroupId()),
      name,
      requested,
      items,
      plannedIds,
      conflict,
      existingSame: Boolean(existingSame),
      reason,
      ready: !reason && !existingSame,
      open: args.open === true,
    };
  };

  const createPreviewResult = snapshot => ({
    ok: !snapshot.reason,
    preview: true,
    reason: snapshot.reason,
    name: snapshot.name,
    groupId: snapshot.groupId,
    requestedCount: snapshot.requested.length,
    plannedCount: snapshot.plannedIds.length,
    results: snapshot.items.map(compactResolutionItem),
    ...(snapshot.conflict ? { existingGroup: summarizeGroup(snapshot.conflict, contactsStore) } : {}),
    ...(snapshot.ready && snapshot.authority?.scope ? { groupPreview: {
      version: 1, name: snapshot.name, open: snapshot.open,
      members: snapshot.items.filter(item => item.status === 'planned').map(item => ({ id: item.memberId, name: item.name })),
      scope: { ...snapshot.authority.scope },
    } } : {}),
  });

  const executeCreate = async (args = {}, context = {}) => {
    const snapshot = createSnapshots.get(args) || buildCreateSnapshot(args);
    const scopeReason = validateMaidScope(context, snapshot.authority);
    if (scopeReason) return groupScopeFailure(scopeReason, args);
    if (args.preview === true) return createPreviewResult(snapshot);
    if (snapshot.existingSame) {
      return {
        ok: true,
        created: false,
        existing: true,
        verified: true,
        group: summarizeGroup(snapshot.conflict, contactsStore),
      };
    }
    if (snapshot.reason) {
      return {
        ...createPreviewResult(snapshot),
        preview: false,
      };
    }
    if (
      context?.toolSafety?.decision !== 'allow' ||
      context?.toolSafety?.request?.kind !== 'group.create'
    ) {
      return { ...createPreviewResult(snapshot), preview: false, ok: false, reason: 'confirmation_required' };
    }
    if (findNameConflict(snapshot.name)) {
      return { ok: false, created: false, reason: 'group_name_changed_during_confirmation' };
    }
    for (const memberId of snapshot.plannedIds) {
      const current = contactsStore?.getContact?.(memberId);
      const planned = snapshot.items.find(item => item.memberId === memberId && item.status === 'planned');
      if (!current || isGroup(current) || isRp(current)
        || (snapshot.authority && trim(current.name || current.id) !== planned?.name)) {
        return {
          ok: false,
          created: false,
          reason: 'group_member_changed_during_confirmation',
          memberId,
        };
      }
    }
    if (!snapshot.groupId || contactsStore?.getContact?.(snapshot.groupId)) {
      return { ok: false, created: false, reason: 'group_id_conflict' };
    }
    const group = {
      id: snapshot.groupId,
      name: snapshot.name,
      avatar: '',
      isGroup: true,
      members: snapshot.plannedIds,
      addedAt: Number(now?.() || Date.now()) || Date.now(),
      isUserCreated: true,
    };
    contactsStore?.upsertContact?.(group);
    const time = makeTime(now);
    chatStore?.appendMessage?.({
      role: 'system',
      type: 'meta',
      content: `你创建了群聊「${snapshot.name}」`,
      name: '系统',
      avatar: '',
      time,
    }, snapshot.groupId);
    chatStore?.appendMessage?.({
      role: 'system',
      type: 'meta',
      content: `你邀请了：${snapshot.items.filter(item => item.status === 'planned').map(item => item.name).join('、')} 加入群聊`,
      name: '系统',
      avatar: '',
      time,
    }, snapshot.groupId);
    await refreshChatAndContacts?.({ immediate: true });
    const changedScope = validateMaidScope(context, snapshot.authority);
    if (changedScope) return { ok: false, created: true, verified: false, reason: changedScope };
    const stored = contactsStore?.getContact?.(snapshot.groupId);
    const verified = Boolean(
      stored &&
      isGroup(stored) &&
      trim(stored.name) === snapshot.name &&
      sameList(unique(stored.members), snapshot.plannedIds)
    );
    const receipt = {
      ok: verified,
      created: true,
      verified,
      ...(verified ? {} : { reason: 'group_create_verification_failed' }),
      group: summarizeGroup(stored || group, contactsStore),
      memberResults: snapshot.items.map(compactResolutionItem),
    };
    const opened = snapshot.open && stored ? await openGroup(stored) : null;
    return { ...receipt, ...(opened ? { opened } : {}) };
  };

  const buildUpdateSnapshot = (args = {}) => {
    const target = trim(args.group || args.groupId || args.target || args.name);
    const resolved = resolveGroup(contactsStore, target);
    const group = resolved.group;
    const baselineIds = unique(group?.members);
    const exactMode = hasOwn(args, 'members');
    const hasDelta = normalizeList(args.addMembers).length > 0 || normalizeList(args.removeMembers).length > 0;
    let reason = resolved.reason;
    if (!reason && exactMode && hasDelta) reason = 'mixed_member_update_modes';
    if (!reason && !exactMode && !hasDelta) reason = 'member_changes_required';

    const exactItems = exactMode ? resolveMemberItems(contactsStore, args.members) : [];
    const addItems = !exactMode ? resolveMemberItems(contactsStore, args.addMembers) : [];
    const removeItems = !exactMode
      ? resolveMemberItems(contactsStore, args.removeMembers, {
          currentMemberIds: baselineIds,
          currentOnly: true,
        })
      : [];
    const unresolved = [...exactItems, ...addItems].filter(item => item.status === 'missing');
    if (!reason && unresolved.length) reason = 'group_members_unresolved';

    let desiredIds = baselineIds.slice();
    if (exactMode) {
      desiredIds = exactItems.filter(item => item.status === 'planned').map(item => item.memberId);
    } else {
      addItems.filter(item => item.status === 'planned').forEach(item => {
        if (!desiredIds.includes(item.memberId)) desiredIds.push(item.memberId);
      });
      const removals = new Set(removeItems.filter(item => item.status === 'planned').map(item => item.memberId));
      desiredIds = desiredIds.filter(id => !removals.has(id));
    }
    const addedIds = desiredIds.filter(id => !baselineIds.includes(id));
    const removedIds = baselineIds.filter(id => !desiredIds.includes(id));
    const changes = [
      ...addedIds.map(id => ({ action: 'add', contact: contactsStore?.getContact?.(id) || { id, name: id } })),
      ...removedIds.map(id => ({ action: 'remove', contact: contactsStore?.getContact?.(id) || { id, name: id } })),
    ];
    // Keep the preflight evidence for requested removals that need no write.
    // Resolve identity in this captured scope, never from a later receipt read.
    const skippedMembers = removeItems
      .filter(item => item.status === 'skipped' && item.reason === 'member_not_in_group')
      .map(item => {
        const observed = resolveMember(contactsStore, item.target).contact;
        if (!observed || baselineIds.includes(trim(observed.id))) return compactResolutionItem(item);
        return compactResolutionItem({ ...item, memberId: trim(observed.id), name: trim(observed.name || observed.id) });
      });
    return {
      target,
      group,
      groupId: trim(group?.id),
      baselineIds,
      desiredIds,
      addedIds,
      removedIds,
      changes,
      skippedMembers,
      resolutionItems: [...exactItems, ...addItems, ...removeItems],
      changed: changes.length > 0,
      reason,
    };
  };

  const updatePreviewResult = snapshot => ({
    ok: !snapshot.reason,
    preview: true,
    reason: snapshot.reason,
    group: snapshot.group ? summarizeGroup(snapshot.group, contactsStore) : null,
    changed: snapshot.changed,
    desiredMemberIds: snapshot.desiredIds,
    results: snapshot.resolutionItems.map(compactResolutionItem),
  });

  const executeUpdate = async (args = {}, context = {}) => {
    const snapshot = updateSnapshots.get(args) || buildUpdateSnapshot(args);
    const scopeReason = validateMaidScope(context, snapshot.authority);
    if (scopeReason) return { ok: false, changed: false, preview: args.preview === true, reason: scopeReason };
    if (args.preview === true) return updatePreviewResult(snapshot);
    if (snapshot.reason) return { ...updatePreviewResult(snapshot), preview: false, changed: false };
    if (!snapshot.changed) {
      return {
        ok: true,
        changed: false,
        verified: true,
        group: summarizeGroup(snapshot.group, contactsStore),
        addedMembers: [],
        removedMembers: [],
        skippedMembers: snapshot.skippedMembers.map(compactResolutionItem),
      };
    }
    if (
      context?.toolSafety?.decision !== 'allow' ||
      context?.toolSafety?.request?.kind !== 'group.update_members'
    ) {
      return { ...updatePreviewResult(snapshot), preview: false, changed: false, ok: false, reason: 'confirmation_required' };
    }
    const currentGroup = contactsStore?.getContact?.(snapshot.groupId);
    if (!currentGroup || !isGroup(currentGroup)) {
      return { ok: false, changed: false, reason: 'group_not_found' };
    }
    if (!sameList(unique(currentGroup.members), snapshot.baselineIds)) {
      return { ok: false, changed: false, reason: 'group_members_changed_during_confirmation' };
    }
    for (const memberId of snapshot.addedIds) {
      const current = contactsStore?.getContact?.(memberId);
      if (!current || isGroup(current) || isRp(current)) {
        return {
          ok: false,
          changed: false,
          reason: 'group_member_changed_during_confirmation',
          memberId,
        };
      }
    }
    contactsStore?.upsertContact?.({
      ...currentGroup,
      id: snapshot.groupId,
      isGroup: true,
      members: snapshot.desiredIds,
    });
    const time = makeTime(now);
    if (snapshot.addedIds.length) {
      const names = snapshot.addedIds
        .map(id => trim(contactsStore?.getContact?.(id)?.name || id))
        .join('、');
      chatStore?.appendMessage?.({
        role: 'system',
        type: 'meta',
        content: `成员加入：${names}`,
        name: '系统',
        time,
      }, snapshot.groupId);
    }
    if (snapshot.removedIds.length) {
      const names = snapshot.removedIds
        .map(id => trim(snapshot.changes.find(change => trim(change.contact?.id) === id)?.contact?.name || id))
        .join('、');
      chatStore?.appendMessage?.({
        role: 'system',
        type: 'meta',
        content: `成员已移除：${names}`,
        name: '系统',
        time,
      }, snapshot.groupId);
    }
    await refreshChatAndContacts?.({ immediate: true });
    const changedScope = validateMaidScope(context, snapshot.authority);
    if (changedScope) return { ok: false, changed: true, verified: false, reason: changedScope };
    const stored = contactsStore?.getContact?.(snapshot.groupId);
    const verified = Boolean(stored && isGroup(stored) && sameList(unique(stored.members), snapshot.desiredIds));
    const receipt = {
      ok: verified,
      changed: true,
      verified,
      ...(verified ? {} : { reason: 'group_member_verification_failed' }),
      group: summarizeGroup(stored || currentGroup, contactsStore),
      addedMembers: snapshot.addedIds.map(id => compactMember(contactsStore?.getContact?.(id) || { id, name: id })),
      removedMembers: snapshot.removedIds.map(id => {
        const prior = snapshot.changes.find(change => trim(change.contact?.id) === id)?.contact;
        return compactMember(prior || { id, name: id });
      }),
      skippedMembers: snapshot.skippedMembers.map(compactResolutionItem),
    };
    const opened = args.open === true && stored ? await openGroup(stored) : null;
    return { ...receipt, ...(opened ? { opened } : {}) };
  };

  return [
    {
      name: 'group.create',
      title: 'Create group chat',
      description: 'Create a real group chat from explicit existing private-contact members with one APP approval. Use preview:true only when the user asks to see the proposed details first; this does not create or approve the group. The active user participates implicitly and must not be included in members.',
      source: 'maid-group-chat',
      permissions: [],
      riskLevel: 'medium',
      capabilities: {
        read: true,
        write: true,
        network: false,
        cost: 'none',
        undo: 'manual_delete',
        modelContext: 'none',
        confirmation: 'required',
      },
      safety: {
        operationType: 'create_group_chat',
        destructive: 'conditional',
        preflight: async (args = {}, context = {}) => {
          const authority = captureMaidScope(context);
          if (authority && !authority.reason) {
            try { await Promise.all([authority.contactsReady, authority.chatReady]); }
            catch { authority.reason = 'group_scope_unavailable'; }
          }
          const scopeReason = validateMaidScope(context, authority);
          if (scopeReason) {
            createSnapshots.set(args, { authority: { reason: scopeReason } });
            return { destructive: false, operationType: 'create_group_chat' };
          }
          const snapshot = buildCreateSnapshot(args);
          snapshot.authority = authority;
          createSnapshots.set(args, snapshot);
          if (args.preview === true || !snapshot.ready) {
            return { destructive: false, operationType: 'create_group_chat' };
          }
          return {
            destructive: true,
            kind: 'group.create',
            operationType: 'create_group_chat',
            title: '创建群聊并加入成员',
            message: `将创建群聊「${snapshot.name}」，并加入 ${snapshot.plannedIds.length} 位联系人。当前用户会自动参与，不另列为成员。`,
            confirmText: '确认创建',
            cancelText: '取消',
            danger: false,
            allowAlways: false,
            details: {
              resource: 'group',
              groupId: snapshot.groupId,
              groupName: snapshot.name,
              items: snapshot.items.map(item => ({
                id: item.memberId || item.target,
                label: item.name,
                avatar: item.avatar,
                showAvatar: true,
                meta: '加入群聊',
                status: item.status,
                reason: item.reason,
              })),
            },
            onDeny: {
              action: 'skip',
              reason: 'group_create_cancelled',
            },
          };
        },
      },
      schema: {
        type: 'object',
        required: ['name', 'members'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          members: {
            type: 'array',
            minItems: 2,
            maxItems: 50,
            items: { type: 'string', minLength: 1, maxLength: 160 },
          },
          preview: { type: 'boolean' },
          open: { type: 'boolean' },
        },
      },
      execute: executeCreate,
      summarizeResult: result => {
        const name = trim(result?.group?.name || result?.name || result?.group?.id, '-');
        const reason = trim(result?.reason, 'unknown');
        if (result?.preview === true) return result.ok
          ? t('已预览群聊「{name}」，本次未创建。', { name })
          : t('建群预览失败：{reason}', { reason });
        if (result?.created) return result.verified
          ? t('已创建并核对群聊「{name}」。', { name })
          : t('群聊已写入，但未完成核对：{reason}', { reason });
        return result?.ok && result.existing
          ? t('已核对现有群聊「{name}」。', { name })
          : t('创建群聊失败：{reason}', { reason });
      },
    },
    {
      name: 'group.update_members',
      title: 'Update group chat members',
      description: 'Replace, add, or remove members of one real group chat using frozen contact IDs and one structured confirmation.',
      source: 'maid-group-chat',
      permissions: [],
      riskLevel: 'medium',
      capabilities: {
        read: true,
        write: true,
        network: false,
        cost: 'none',
        undo: 'manual_restore_members',
        modelContext: 'none',
        confirmation: 'required',
      },
      safety: {
        operationType: 'update_group_members',
        destructive: 'conditional',
        preflight: async (args = {}, context = {}) => {
          const authority = captureMaidScope(context);
          if (authority && !authority.reason) {
            try { await Promise.all([authority.contactsReady, authority.chatReady]); }
            catch { authority.reason = 'group_scope_unavailable'; }
          }
          const scopeReason = validateMaidScope(context, authority);
          if (scopeReason) {
            updateSnapshots.set(args, { authority: { reason: scopeReason } });
            return { destructive: false, operationType: 'update_group_members' };
          }
          const snapshot = buildUpdateSnapshot(args);
          snapshot.authority = authority;
          updateSnapshots.set(args, snapshot);
          if (args.preview === true || snapshot.reason || !snapshot.changed) {
            return { destructive: false, operationType: 'update_group_members' };
          }
          return {
            destructive: true,
            kind: 'group.update_members',
            operationType: 'update_group_members',
            title: '修改群聊成员',
            message: `将修改群聊「${trim(snapshot.group?.name || snapshot.groupId)}」：加入 ${snapshot.addedIds.length} 位，移出 ${snapshot.removedIds.length} 位。`,
            confirmText: '确认修改',
            cancelText: '取消',
            danger: snapshot.removedIds.length > 0,
            allowAlways: false,
            details: {
              resource: 'group',
              groupId: snapshot.groupId,
              groupName: trim(snapshot.group?.name || snapshot.groupId),
              items: snapshot.changes.map(change => ({
                id: trim(change.contact?.id),
                label: trim(change.contact?.name || change.contact?.id),
                avatar: trim(change.contact?.avatar),
                showAvatar: true,
                meta: change.action === 'add' ? '加入' : '移出',
                status: 'planned',
                reason: '',
              })),
            },
            onDeny: {
              action: 'skip',
              reason: 'group_member_update_cancelled',
            },
          };
        },
      },
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: { type: 'string', maxLength: 160 },
          groupId: { type: 'string', maxLength: 160 },
          target: { type: 'string', maxLength: 160 },
          name: { type: 'string', maxLength: 160 },
          members: {
            type: 'array',
            maxItems: 50,
            items: { type: 'string', minLength: 1, maxLength: 160 },
          },
          addMembers: {
            type: 'array',
            maxItems: 50,
            items: { type: 'string', minLength: 1, maxLength: 160 },
          },
          removeMembers: {
            type: 'array',
            maxItems: 50,
            items: { type: 'string', minLength: 1, maxLength: 160 },
          },
          preview: { type: 'boolean' },
          open: { type: 'boolean' },
        },
        anyOf: [
          { required: ['group'] },
          { required: ['groupId'] },
          { required: ['target'] },
          { required: ['name'] },
        ],
      },
      execute: executeUpdate,
      summarizeResult: result => {
        const reason = trim(result?.reason, 'unknown');
        if (result?.preview === true) return result.ok
          ? t('已预览群成员变更，本次未修改。')
          : t('群成员预览失败：{reason}', { reason });
        if (result?.changed) return result.verified
          ? t('已修改并核对群成员。')
          : t('群成员已写入，但未完成核对：{reason}', { reason });
        return result?.ok ? t('群成员无需修改。') : t('群成员修改失败：{reason}', { reason });
      },
    },
  ];
};

export const registerGroupChatAgentTools = (registry, deps = {}) => {
  const tools = createGroupChatAgentTools(deps);
  if (!registry || typeof registry.registerMany !== 'function') return tools;
  registry.registerMany(tools);
  return tools;
};
