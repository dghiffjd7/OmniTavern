import { createMaidSkillContext, resolveMaidSkillModelContextLimit } from '../agent/maid-skill-context.js';
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
    const owner = voice ? (call?.id === controls.voiceCallId ? call : null) : null;
    if (voice && !owner) throw skillError('skill_call_changed');
    const revision = owner ? owner.revision : draftRevision;
    let ids = controls.useDraftSkills === false ? [] : voice ? [...owner.ids] : [...draft];
    const resolved = resolveTaskContext(text, { ...getAppContext(), ...controls.context, source: controls.source, voiceCallId: controls.voiceCallId }, { hasDraftSkills: ids.length > 0 });
    const context = resolved.context;
    if (resolved.useDraftSkills === false) ids = [];
    if (context.maidSkillContext) {
      const restored = !attachments.length && context.maidTaskInputs && inputPersistence ? await inputPersistence.restore(context.maidTaskInputs) : attachments;
      await validateTask({ text, attachments: restored, context, selectedIds: context.maidSkillContext.loaded.map(item => item.id) });
      if (attachments.length && inputPersistence) context.maidTaskInputs = await inputPersistence.persist(attachments, context);
      if (voice && call !== owner) throw skillError('skill_call_changed');
      return { ...controls, context, attachments: restored, draftAttachments: attachments, skillsPrepared: true };
    }
    try { await store.ready; } catch (error) { throw new Error(maidSkillMessage(error)); }
    const constraints = await validateTask({ text, attachments, context, selectedIds: ids });
    if (voice && call !== owner) throw skillError('skill_call_changed');
    const state = store.exportState();
    context.maidSkillContext = createMaidSkillContext({ catalog: store.list(), selectedIds: ids,
      storeRevision: state.storeRevision, ...(constraints?.maxContentChars != null ? { maxContentChars: constraints.maxContentChars } : {}) });
    context.maidSkillContextPrepared = true;
    if (inputPersistence) context.maidTaskInputs = await inputPersistence.persist(attachments, context);
    if (voice && call !== owner) throw skillError('skill_call_changed');
    let accepted = false;
    return { ...controls, context, skillsPrepared: true, onAccepted: () => {
      if (accepted) return;
      accepted = true;
      if (controls.useDraftSkills !== false && resolved.useDraftSkills !== false) {
        if (owner && owner === call && owner.revision === revision) { owner.ids = []; owner.revision++; }
        else if (!voice && draftRevision === revision) { draft = []; draftRevision++; }
      }
      notify(); controls.onAccepted?.();
    } };
  };
  return { prepare, beginCall, endCall, getSelected: selected, setSelected,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
};
