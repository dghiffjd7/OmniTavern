import { t } from '../../i18n/index.js';

// 完整承接一组生图任务的终态与回填。独立图片提示通过 artifact 传入，避免再次请求提示词。
export const createHopscotchImageExecutor = ({ findMessage, schedule }) => ({ sessionId = '', messageId = '', signal = null, promptArtifact = null } = {}) => new Promise((resolve, reject) => {
  const sid = String(sessionId || '').trim();
  let message = findMessage(String(messageId || '').trim(), sid);
  if (!message) return resolve({ status: 'skipped', reason: 'message_missing' });
  if (signal?.aborted) return resolve({ status: 'cancelled', reason: 'user_cancelled' });
  let rawText = String(message.rawOriginal || message.rawSource || message.content || '');
  if (promptArtifact) {
    if (promptArtifact.sourceMessageId !== messageId || promptArtifact.sourceText !== rawText) return resolve({ status: 'skipped', reason: 'prompt_source_changed' });
    // 在正文末尾插入提示占位；既有调度器负责把占位回填为图片。
    rawText = `${message.content || ''}\n\n${promptArtifact.text}`;
    const meta = { ...message.meta, autoImagePromptRawContent: rawText };
    delete meta.autoImagePromptPlaceholders;
    message = { ...message, meta, rawOriginal: rawText, rawSource: rawText };
  }
  let total = 0, done = 0, failed = 0, settled = false;
  const children = [];
  const settle = result => { if (settled) return; settled = true; signal?.removeEventListener('abort', onAbort); resolve(result); };
  const onAbort = () => settle({ status: 'cancelled', reason: 'user_cancelled', childResults: children });
  const finish = () => {
    if (settled || done + failed < total) return;
    if (!total) return settle({ status: 'skipped', reason: 'no_prompt' });
    if (failed) return settle({ status: 'failed', reason: failed === total ? 'all_failed' : 'partial', error: t('{value}/{value2} 张图片生成失败', { value: failed, value2: total }), childResults: children });
    settle({ status: 'succeeded', artifact: { kind: 'image_generation', payload: { count: total } }, childResults: children });
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const scheduled = schedule(message, sid, {
      signal, boardEnabled: true, rawText, source: 'hopscotch',
      onItemsScheduled: ({ count }) => { total = Number(count) || 0; if (!total) finish(); },
      onItemDone: ({ item, asset }) => { done++; children.push({ index: item?.index, status: 'succeeded', assetId: asset?.id || '' }); finish(); },
      onItemFailed: (err, { item } = {}) => { failed++; children.push({ index: item?.index, status: 'failed', error: String(err?.message || err || '') }); finish(); },
    });
    if (!scheduled && !settled) settle({ status: 'skipped', reason: 'no_prompt' });
  } catch (err) { signal?.removeEventListener('abort', onAbort); reject(err); }
});
