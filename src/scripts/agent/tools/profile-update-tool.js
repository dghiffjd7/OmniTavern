import { t } from '../../i18n/index.js';
import { getCharacterCardDisplayName, getCharacterCardSource } from '../../utils/character-card-display.js';

const trim = value => String(value ?? '').trim();
const key = value => trim(value).toLowerCase().replace(/\s+/g, '');
const clip = (value, max = 120) => {
  const text = trim(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const KIND_LABELS = { user: '用户', persona: '角色卡', contact: '聊天室' };

/* 通用改名/改简介：用户、角色卡、聊天室（好友或群聊）。只改显示名称与简介，不改内部 id，
   历史记录、绑定与会话不受影响。执行前由 APP 确认弹窗展示改前改后；preview:true 只返回改动不写入。
   名称不得与同类项目重名：其他工具按名称查找目标，重名会让之后的指代变得模糊。 */
export const createProfileUpdateTool = ({
  personaStore = null,
  userStore = null,
  contactsStore = null,
  chatStore = null,
  notifyPersonaChanged = null,
  onPersonaProfileUpdated = null,
  onUserProfileUpdated = null,
  refreshChatAndContacts = null,
  now = Date.now,
} = {}) => {
  const snapshots = new WeakMap();
  const failure = (reason, extra = {}) => ({ ok: false, updated: false, reason, ...extra });

  const storeOf = kind => ({ user: userStore, persona: personaStore, contact: contactsStore })[kind] || null;
  const listOf = (kind) => {
    const store = storeOf(kind);
    const items = kind === 'contact' ? store?.listContacts?.() : store?.getAll?.();
    return (Array.isArray(items) ? items : []).filter(Boolean);
  };
  const getById = (kind, id) => (kind === 'contact' ? contactsStore?.getContact?.(id) : storeOf(kind)?.get?.(id)) || null;
  const activeOf = (kind, context = {}) => {
    if (kind === 'persona') {
      const sid = trim(context.sessionId || chatStore?.getCurrent?.());
      const lockedId = sid ? trim(chatStore?.getPersonaLock?.(sid)) : '';
      if (lockedId) return getById('persona', lockedId);
    }
    if (kind === 'contact') {
      const sid = trim(context.sessionId || chatStore?.getCurrent?.());
      return sid ? getById('contact', sid) : null;
    }
    return storeOf(kind)?.getActive?.() || null;
  };

  const nameConflict = (kind, id, name) => listOf(kind).find(entry => trim(entry?.id) !== trim(id) && key(entry?.name) === key(name));
  const conflictFailure = (kind, name, conflict) => failure('name_conflict', {
    kind, name, conflictId: trim(conflict.id), message: `已有同名的${KIND_LABELS[kind]}「${trim(conflict.name)}」，请换一个名称。`,
  });
  const capture = (args = {}, context = {}) => {
    const kind = trim(args.kind);
    if (!KIND_LABELS[kind]) return { error: failure('invalid_kind') };
    const writable = kind === 'contact' ? typeof contactsStore?.upsertContact === 'function' : typeof storeOf(kind)?.update === 'function';
    if (!writable) return { error: failure(`${kind}_store_unavailable`) };
    const query = trim(args.target);
    let item = null;
    if (query) {
      item = getById(kind, query);
      if (!item) {
        const matches = listOf(kind).filter(entry => key(entry?.name) === key(query));
        if (matches.length > 1) {
          return { error: failure('ambiguous_target', { kind, candidates: matches.slice(0, 8).map(entry => ({ id: trim(entry.id), name: trim(entry.name) })) }) };
        }
        item = matches[0] || null;
      }
    } else {
      item = activeOf(kind, context);
    }
    if (!item?.id) return { error: failure(`${kind}_not_found`, { kind, target: query }) };

    const hasName = Object.prototype.hasOwnProperty.call(args, 'name');
    const hasDescription = Object.prototype.hasOwnProperty.call(args, 'description');
    if (!hasName && !hasDescription) return { error: failure('nothing_to_update', { kind }) };
    const nextName = hasName ? trim(args.name) : '';
    if (hasName && !nextName) return { error: failure('empty_name', { kind }) };
    const beforeName = trim(item.name || item.id);
    const beforeDescription = String(item.description ?? '');
    const changes = [];
    if (hasName && nextName !== beforeName) {
      const conflict = nameConflict(kind, item.id, nextName);
      if (conflict) {
        return { error: conflictFailure(kind, nextName, conflict) };
      }
      changes.push({ field: 'name', before: beforeName, after: nextName });
    }
    if (hasDescription && String(args.description ?? '') !== beforeDescription) {
      changes.push({ field: 'description', before: beforeDescription, after: String(args.description ?? '') });
    }
    return {
      kind,
      id: trim(item.id),
      itemRef: item,
      beforeName,
      beforeDescription,
      isGroup: kind === 'contact' && (item.isGroup === true || trim(item.id).startsWith('group:')),
      changes,
    };
  };

  const describeChanges = snapshot => snapshot.changes.map(change => (change.field === 'name'
    ? t('名称：「{before}」→「{after}」', { before: change.before, after: change.after })
    : t('简介：{before} → {after}', { before: clip(change.before, 80) || t('（空）'), after: clip(change.after, 80) || t('（空）') })
  )).join('\n');

  // 替换已有简介才算覆盖（高风险样式）；单纯改名是普通修改
  const replacesDescription = snapshot => snapshot.changes.some(change => change.field === 'description' && trim(change.before));
  const confirmationRequest = snapshot => ({
    destructive: true,
    kind: 'profile.update',
    operationType: replacesDescription(snapshot) ? 'replace_existing' : 'update_profile',
    title: t('修改{kind}资料', { kind: t(KIND_LABELS[snapshot.kind]) }),
    message: `${t('{kind}「{name}」将修改为：', { kind: t(KIND_LABELS[snapshot.kind]), name: snapshot.beforeName })}\n${describeChanges(snapshot)}\n${t('只改显示内容，内部 id、聊天记录与绑定不变。')}`,
    confirmText: t('修改'),
    cancelText: t('取消'),
    danger: replacesDescription(snapshot),
    allowAlways: false,
    details: { kind: snapshot.kind, targetId: snapshot.id, fields: snapshot.changes.map(change => change.field) },
  });

  const summarizeChanges = snapshot => snapshot.changes.map(change => ({
    field: change.field,
    before: change.field === 'description' ? clip(change.before, 200) : change.before,
    after: change.field === 'description' ? clip(change.after, 200) : change.after,
    ...(change.field === 'description' ? { beforeLength: change.before.length, afterLength: change.after.length } : {}),
  }));

  const applyChanges = async (snapshot) => {
    const patch = {};
    snapshot.changes.forEach((change) => { patch[change.field] = change.after; });
    if (snapshot.kind === 'contact') {
      contactsStore.upsertContact({ id: snapshot.id, ...patch });
      if (snapshot.isGroup && patch.name) {
        const time = new Date(Number(now?.() || Date.now())).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        chatStore?.appendMessage?.({ role: 'system', type: 'meta', content: `群聊名称已更新：${snapshot.beforeName} → ${patch.name}`, name: '系统', time }, snapshot.id);
      }
      await refreshChatAndContacts?.({ reason: 'maid_profile_update', sessionId: snapshot.id, forceRefresh: true });
      return getById('contact', snapshot.id);
    }
    const store = storeOf(snapshot.kind);
    if (snapshot.kind === 'persona' && patch.name) {
      // 与角色卡面板保存一致：角色卡来源里记录的角色名跟着改
      const source = { ...getCharacterCardSource(snapshot.itemRef) };
      if (getCharacterCardDisplayName(snapshot.itemRef, '') || source.type === 'character_card') {
        source.characterName = patch.name;
        patch.source = source;
      }
    }
    const saved = await store.update(snapshot.id, patch);
    if (!saved) return null;
    if (snapshot.kind === 'persona') {
      const notify = onPersonaProfileUpdated || notifyPersonaChanged;
      await notify?.({ personaId: snapshot.id, reason: 'maid_profile_update' });
    } else {
      await onUserProfileUpdated?.({ userId: snapshot.id, reason: 'maid_profile_update' });
    }
    return getById(snapshot.kind, snapshot.id);
  };

  return {
    name: 'profile.update',
    title: 'Update name or description',
    description: 'Rename or edit the description of an existing user profile, character card, or chat room (private contact or group chat). Only display fields change; the internal id, chat history and bindings stay the same. Omit target to edit the active user, active character card, or current chat room. Use preview:true to list the changes without writing. Never create a new profile to rename one.',
    source: 'maid-app-content',
    permissions: [],
    riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_edit_back', modelContext: 'none', confirmation: 'allow_once' },
    schema: {
      type: 'object',
      required: ['kind'],
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['user', 'persona', 'contact'] },
        target: { type: 'string', maxLength: 160 },
        name: { type: 'string', maxLength: 80 },
        description: { type: 'string', maxLength: 12000 },
        preview: { type: 'boolean' },
      },
    },
    safety: {
      operationType: 'update_profile',
      destructive: 'conditional',
      preflight: async (args = {}, context = {}) => {
        const snapshot = capture(args, context);
        snapshots.set(args, snapshot);
        if (args.preview === true || snapshot.error || !snapshot.changes.length) return { destructive: false };
        return confirmationRequest(snapshot);
      },
    },
    execute: async (args = {}, context = {}) => {
      const snapshot = snapshots.get(args) || capture(args, context);
      if (snapshot.error) return snapshot.error;
      const target = { kind: snapshot.kind, id: snapshot.id, name: snapshot.beforeName };
      if (!snapshot.changes.length) return { ok: true, updated: false, changed: false, target, message: '内容与现在相同，无需修改。' };
      if (args.preview === true) {
        return { ok: true, preview: true, updated: false, target, changes: summarizeChanges(snapshot), message: '预览：尚未修改。' };
      }
      if (!(context.toolSafety?.decision === 'allow' && context.toolSafety?.request?.kind === 'profile.update')) {
        return failure('confirmation_required', target);
      }
      // 确认期间目标被改过或删掉时不覆盖
      const current = getById(snapshot.kind, snapshot.id);
      if (!current) return failure('target_removed_during_confirmation', target);
      if (trim(current.name || current.id) !== snapshot.beforeName || String(current.description ?? '') !== snapshot.beforeDescription) {
        return failure('target_changed_during_confirmation', target);
      }
      const rename = snapshot.changes.find(change => change.field === 'name');
      const conflict = rename && nameConflict(snapshot.kind, snapshot.id, rename.after);
      if (conflict) return conflictFailure(snapshot.kind, rename.after, conflict);
      const saved = await applyChanges(snapshot);
      if (!saved) return failure('update_failed', target);
      return {
        ok: true,
        updated: true,
        changed: true,
        target: { kind: snapshot.kind, id: snapshot.id, name: trim(saved.name || snapshot.id) },
        changes: summarizeChanges(snapshot),
      };
    },
    summarizeResult: result => (result?.ok === false
      ? `update ${trim(result?.kind || result?.target?.kind)} failed: ${trim(result?.reason)}`
      : result?.preview
        ? `previewed ${Number(result?.changes?.length || 0)} change(s) for ${trim(result?.target?.name)}`
        : `updated ${trim(result?.target?.kind)} ${trim(result?.target?.name)}`),
  };
};
