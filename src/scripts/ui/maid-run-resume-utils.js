import { getLocalizedPromptText } from '../i18n/prompt-locale.js';
import { resolveMaidRunContinuationFromRun } from '../agent/maid-run-continuation.js';
import { t } from '../i18n/index.js';
import { hasTauriRuntime } from '../utils/save-dialog.js';

export const buildMaidRunResumeSubmission = run => ({
  text: buildMaidRunResumePrompt(run),
  controls: { preserveDraft: true, context: { runContinuation: resolveMaidRunContinuationFromRun(run) } },
});

// Reuse the image-reference store's content hashing and file transport. Run
// metadata contains references, never a second copy of native image bytes.
export const createMaidTaskInputPersistence = ({ referenceStore, native = hasTauriRuntime() } = {}) => ({
  persist: async (attachments, context) => {
    const references = attachments.length ? await referenceStore.persist(attachments.map(item => ({ ...item, url: item.llmUrl || item.url })), 'maid-task-inputs') : [];
    if (native && references.some(item => !item.path && /^data:|^blob:/.test(item.url || item.dataUrl || ''))) throw new Error(t('附图未能保存，输入和技能选择已保留'));
    return { version: 1, references, context: { sessionId: context.sessionId || '', uiMode: context.uiMode || '', activePage: context.activePage || '', userSelection: structuredClone(context.userSelection || []) } };
  },
  restore: async snapshot => {
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.references)) throw new Error(t('原任务附图记录不可用，请重新附图后发起任务'));
    const loaded = await referenceStore.load(snapshot.references, 'maid-task-inputs');
    if (loaded.length !== snapshot.references.length) throw new Error(t('原任务附图记录不可用，请重新附图后发起任务'));
    return loaded.map(item => ({ kind: 'image', url: item.dataUrl, name: item.name, mime: item.mime, size: item.size }));
  },
});

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

export const buildMaidRunResumePrompt = (run = {}) => {
  const metadata = run?.metadata || {};
  const runId = trim(run?.id);
  const goal = trim(metadata.goal || run?.title || run?.summary);
  const status = trim(metadata.maidStatus || run?.status);
  const reason = trim(metadata.reactStoppedReason || metadata.reason || run?.errorMessage);
  const continueHint = trim(metadata.continueHint);
  const prompt = (key, fallback, value = '') => getLocalizedPromptText(`maid.resume.${key}`, fallback)
    .replaceAll('{value}', String(value ?? ''));
  const lines = [
    prompt('start', '继续这条已中断的女仆任务。'),
    runId ? `runId: ${runId}` : '',
    goal ? prompt('goal', '目标：{value}', goal) : '',
    status ? prompt('status', '状态：{value}', status) : '',
    reason ? prompt('reason', '原因：{value}', reason) : '',
    continueHint ? prompt('hint', '继续提示：\n{value}', continueHint) : '',
    continueHint ? '' : prompt('instruction', '请基于这条 run 的历史继续执行、验证和修正，不要改成普通闲聊。'),
  ].filter(Boolean);
  return lines.join('\n') || prompt('fallback', '继续');
};
