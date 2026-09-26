import { createMaidSkillContext, mergeMaidSkillCatalog, resolveMaidSkillModelContextLimit } from '../agent/maid-skill-context.js';
import { MAID_SKILL_LIMITS, skillError } from '../agent/maid-skill-schema.js';
import { t } from '../i18n/index.js';
import { maidSkillMessage } from './maid-skill-messages.js';

export const createMaidSkillTaskValidator = ({ resolveConfig, checkVision } = {}) => async ({ attachments, context, selectedIds }) => {
  const runtime = await resolveConfig(context);
  if (selectedIds.length) {
    if (!runtime?.configured) throw new Error(t('请先配置女仆 API，技能选择已保留'));
    const vision = await checkVision(attachments, context, runtime);
    if (!vision.ok) throw new Error(vision.message);
  }
  const config = runtime?.config || {};
  const maxContext = resolveMaidSkillModelContextLimit(config);
  const output = Number(config.maxTokens || config.max_tokens) || 4096;
  // Where a provider exposes its context limit, reserve room for the app prompt,
  // observations and output; CJK workflows are budgeted conservatively.
  return { maxContentChars: maxContext > 0 ? Math.max(0, Math.min(24000, maxContext - output - 12000)) : 24000 };
};

// Owns draft selection and its transfer into a task. No task execution or routing.
export const createMaidSkillRuntime = ({ store, getAppContext = () => ({}), validateTask = async () => {}, resolveTaskContext = (_text, context) => ({ context }), inputPersistence = null } = {}) => {
  let draft = [], draftRevision = 0, call = null;
  const listeners = new Set();
  const selected = () => [...(call ? call.ids : draft)];
  const notify = () => listeners.forEach(listener => listener(selected()));
  const setSelected = ids => {
    const next = [...new Set(ids)];
    if (next.length > MAID_SKILL_LIMITS.selected) throw skillError('skill_selection_limit');
    if (call) { call.ids = next; call.revision++; }
    else { draft = next; draftRevision++; }
    notify();
  };
  const beginCall = id => {
    if (call?.id === id) return;
    if (call) throw skillError('skill_call_changed');
    call = { id, ids: draft, revision: 0 };
    draft = []; draftRevision++; notify();
  };
  const endCall = id => {
    if (call?.id !== id) return;
    draft = [...new Set([...draft, ...call.ids])].slice(0, MAID_SKILL_LIMITS.selected);
    call = null; draftRevision++; notify();
  };
  const prepare = async (text, attachments = [], controls = {}) => {
    const voice = controls.source === 'maid_realtime';
    // During a call the visible chips are the call's selection, so typed tasks use it too.
    const owner = voice ? (call?.id === controls.voiceCallId ? call : null) : call;
    if (voice && !owner) throw skillError('skill_call_changed');
    const revision = owner ? owner.revision : draftRevision;
    let ids = controls.useDraftSkills === false ? [] : owner ? [...owner.ids] : [...draft];
    const resolved = resolveTaskContext(text, { ...getAppContext(), ...controls.context, source: controls.source, voiceCallId: controls.voiceCallId }, { hasDraftSkills: ids.length > 0 });
    const context = resolved.context;
    if (resolved.useDraftSkills === false) ids = [];
    if (context.maidSkillContext) {
      // 续接任务的目录补上当前技能库里未读取过的技能；技能库读不出来时只保留快照与内置技能
      try { await store.ready; mergeMaidSkillCatalog(context.maidSkillContext, store.list()); } catch {}
      const restored = !attachments.length && context.maidTaskInputs && inputPersistence ? await inputPersistence.restore(context.maidTaskInputs) : attachments;
      await validateTask({ text, attachments: restored, context, selectedIds: context.maidSkillContext.loaded.map(item => item.id) });
      if (attachments.length && inputPersistence) context.maidTaskInputs = await inputPersistence.persist(attachments, context);
      if (voice && call !== owner) throw skillError('skill_call_changed');
      return { ...controls, context, attachments: restored, draftAttachments: attachments, skillsPrepared: true };
    }
    // 技能库读不出来时：指定了技能就报错（用户明确要用）；没指定则只用内置技能继续，不让所有任务一起失败
    let storeAvailable = true;
    try { await store.ready; } catch (error) { if (ids.length) throw new Error(maidSkillMessage(error)); storeAvailable = false; }
    const constraints = await validateTask({ text, attachments, context, selectedIds: ids });
    if (owner && call !== owner) throw skillError('skill_call_changed');
    context.maidSkillContext = createMaidSkillContext({ ...(storeAvailable ? { catalog: store.list(), storeRevision: store.exportState().storeRevision } : {}), selectedIds: ids,
      ...(constraints?.maxContentChars != null ? { maxContentChars: constraints.maxContentChars } : {}) });
    context.maidSkillContextPrepared = true;
    if (inputPersistence) context.maidTaskInputs = await inputPersistence.persist(attachments, context);
    if (owner && call !== owner) throw skillError('skill_call_changed');
    let accepted = false;
    return { ...controls, context, skillsPrepared: true, onAccepted: () => {
      if (accepted) return;
      accepted = true;
      if (controls.useDraftSkills !== false && resolved.useDraftSkills !== false) {
        if (owner) { if (owner === call && owner.revision === revision) { owner.ids = []; owner.revision++; } }
        else if (draftRevision === revision) { draft = []; draftRevision++; }
      }
      notify(); controls.onAccepted?.();
    } };
  };
  return { prepare, beginCall, endCall, getSelected: selected, setSelected,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
};
