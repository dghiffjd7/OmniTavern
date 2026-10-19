// 一次压缩失败或被取消后，至少再多出这么多条摘要才自动重试，免得每轮都卡在同一个失败请求上。
export const SUMMARY_COMPACTION_RETRY_AFTER_NEW_ITEMS = 3;

export const createSessionSummaryCompactionRuntime = ({
  chatStore = null,
  getIsSummaryMemoryEnabled = () => false,
  getIsCompactionEnabled = null,
  getDefaultPlace = () => 'chat',
  createAdapter = null,
  getIsConfigured = () => true,
  buildMessages = null,
  backgroundChat = null,
  buildSessionContext = () => null,
  requestCompactionRaw = async () => '',
  parseCompactionResult = () => ({ text: '', valid: false }),
  normalizeItems = (items) => (Array.isArray(items) ? items : []),
  shouldCompact = () => false,
  // 返回给 backgroundChat 的额外选项（如 runtimeConfigOverride），决定压缩用哪个模型。
  resolveRequestOptions = async () => null,
  // 真正发起压缩请求时开始／结束一次运行记录；managed 为 true 表示由跳房子自己显示进度。
  onRunStart = async () => null,
  onRunFinish = async () => {},
  refreshChatAndContacts = () => {},
  dispatchUpdated = () => {},
  dispatchFailed = () => {},
  logger = null,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  delayMs = 450,
} = {}) => {
  const compacting = new Set();
  // compactKey -> { itemCount, status, reason, at }：最近一次未成功的压缩（仅内存，重启后重新尝试）。
  const lastUnsuccessful = new Map();

  const createLegacyAdapter = (sessionId) => {
    if (!chatStore?.getSummaries || !chatStore?.setCompactedSummary) return null;
    return {
      kind: 'summary_store',
      getItems: () => chatStore.getSummaries(sessionId) || [],
      getCompactedText: () => String(chatStore.getCompactedSummary(sessionId)?.text || '').trim(),
      setRaw: raw => chatStore.setCompactedSummaryRaw?.(raw, sessionId),
      persist: ({ text, raw, keepItems }) => {
        chatStore.setCompactedSummary(text, sessionId, { raw });
        chatStore.setSummaries(keepItems, sessionId);
      },
    };
  };

  const compact = async (sid, { force = false, place = '', signal = null, detailed = false, expectedAdapterKind = '' } = {}) => {
    const result = (status, reason = '', error = '') => detailed ? { status, reason, error } : status === 'succeeded';
    const skipped = reason => result('skipped', reason);
    const sessionId = String(sid || '').trim();
    if (!sessionId) return skipped('missing_session');
    if (signal?.aborted) return result('cancelled', 'aborted');
    const resolvedPlace = String(place || getDefaultPlace?.() || 'chat').trim().toLowerCase() || 'chat';
    const enabled = typeof getIsCompactionEnabled === 'function'
      ? getIsCompactionEnabled({ sessionId, place: resolvedPlace, force })
      : getIsSummaryMemoryEnabled(resolvedPlace);
    if (!enabled) return skipped('disabled');
    const compactKey = `${resolvedPlace}:${sessionId}`;
    if (compacting.has(compactKey)) return skipped('already_running');
    if (typeof buildMessages !== 'function' || typeof backgroundChat !== 'function') {
      return skipped('model_unavailable');
    }
    if (!getIsConfigured()) return skipped('model_unavailable');

    let adapter = null;
    try {
      adapter = await createAdapter?.({ sessionId, place: resolvedPlace }) || createLegacyAdapter(sessionId);
    } catch (error) {
      logger?.debug?.('summary compaction adapter init failed', error);
      return result('failed', 'adapter_error', String(error?.message || error));
    }
    if (!adapter?.getItems || !adapter?.persist) return skipped('adapter_unavailable');
    // 表格内部维护不可因运行中切换模式而回退处理另一份摘要存储。
    if (expectedAdapterKind && adapter.kind !== expectedAdapterKind) return skipped('adapter_changed');
    const list = await adapter.getItems();
    const reached = typeof adapter.shouldCompact === 'function'
      ? await adapter.shouldCompact({ items: list, force })
      : shouldCompact({ items: list, force, place: resolvedPlace, sessionId });
    if (!reached) return skipped('threshold_not_reached');
    const previous = lastUnsuccessful.get(compactKey);
    const itemCount = Array.isArray(list) ? list.length : 0;
    if (!force && previous && itemCount < previous.itemCount + SUMMARY_COMPACTION_RETRY_AFTER_NEW_ITEMS) {
      return skipped('retry_after_unsuccessful');
    }
    if (signal?.aborted) return result('cancelled', 'aborted');

    compacting.add(compactKey);
    let runHandle = null;
    return new Promise((outerResolve) => {
      const resolve = (value, info = null) => {
        const status = detailed ? value?.status : (value ? 'succeeded' : 'failed');
        Promise.resolve(onRunFinish(runHandle, info || { status: status || 'failed', reason: '', error: '' }))
          .catch(error => logger?.debug?.('summary compaction run finish skipped', error));
        if (status === 'succeeded') lastUnsuccessful.delete(compactKey);
        else {
          lastUnsuccessful.set(compactKey, { itemCount, status, reason: detailed ? value?.reason || '' : '', at: Date.now() });
          logger?.warn?.('summary compaction unsuccessful; auto retry waits for more summaries', {
            sessionId, place: resolvedPlace, status, reason: detailed ? value?.reason || '' : '', itemCount,
          });
        }
        outerResolve(value);
      };
      // result() 在 detailed=false 时只返回布尔值，运行记录另外带上状态与原因。
      const settle = (status, reason = '', error = '') => resolve(result(status, reason, error), { status, reason, error });
      setTimeoutFn(async () => {
        try {
          signal?.throwIfAborted();
          try {
            runHandle = await onRunStart({ sessionId, place: resolvedPlace, itemCount, managed: Boolean(signal) });
          } catch (error) {
            logger?.debug?.('summary compaction run start skipped', error);
          }
          const requestOptions = await resolveRequestOptions({ sessionId, place: resolvedPlace });
          const current = await adapter.getItems();
          const arr = Array.isArray(current) ? current : [];
          const compactedText = String(await adapter.getCompactedText?.() || '').trim();
          const context = buildSessionContext(sessionId);
          signal?.throwIfAborted();
          const raw = await requestCompactionRaw({
            items: arr,
            compactedText,
            context,
            buildMessages,
            backgroundChat,
            // 按被压缩的会话（而非当前打开的会话）解析模型与生成参数；max tokens 由 requestCompactionRaw 固定。
            options: {
              presetContext: { sessionId, uiMode: resolvedPlace === 'writing' ? 'rp' : 'chat' },
              ...(requestOptions || {}),
              temperature: 0.2,
              ...(signal ? { signal } : {}),
            },
          });
          signal?.throwIfAborted();
          if (!raw) return settle('failed', 'empty_response');
          try {
            await adapter.setRaw?.(raw);
          } catch {}

          const { text, valid } = parseCompactionResult(raw);
          if (!text) {
            try {
              dispatchFailed(sessionId, 'missing_summary_tag');
            } catch {}
            return settle('failed', 'missing_summary_tag');
          }

          if (!valid) {
            try {
              dispatchFailed(sessionId, 'format');
            } catch {}
            return settle('failed', 'format');
          }

          const latestItems = await adapter.getItems();
          const normalizedItems = typeof adapter.normalizeItems === 'function'
            ? adapter.normalizeItems(latestItems)
            : normalizeItems(latestItems);
          const keep = (Array.isArray(normalizedItems) ? normalizedItems : []).slice(-2);
          signal?.throwIfAborted();
          await adapter.persist({
            text,
            raw,
            items: arr,
            keepItems: keep,
            sessionId,
            place: resolvedPlace,
            signal,
          });

          try {
            refreshChatAndContacts();
          } catch {}
          try {
            dispatchUpdated(sessionId);
          } catch {}
          settle('succeeded');
        } catch (error) {
          try {
            logger?.debug?.('summary compaction failed', error);
          } catch {}
          settle(signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed', 'compaction_error', String(error?.message || error));
        } finally {
          compacting.delete(compactKey);
        }
      }, Number(delayMs || 0));
    });
  };

  // 「套用预设」的试运行／预览：与正式压缩同一份摘要数据和模型选项，用调用方给的 taskPreset 组请求。
  // 不写入、不记运行、不动失败重试记录；previewOnly 只组请求不发送（不要求已配置模型）。
  compact.dryRun = async (sid, { place = '', signal = null, previewOnly = false, taskPreset = null } = {}) => {
    const sessionId = String(sid || '').trim();
    if (!sessionId) return { ok: false, reason: 'missing_session' };
    if (typeof backgroundChat !== 'function') return { ok: false, reason: 'model_unavailable' };
    if (!previewOnly && !getIsConfigured()) return { ok: false, reason: 'model_unavailable' };
    const resolvedPlace = String(place || getDefaultPlace?.() || 'chat').trim().toLowerCase() || 'chat';
    try {
      const adapter = await createAdapter?.({ sessionId, place: resolvedPlace }) || createLegacyAdapter(sessionId);
      if (!adapter?.getItems) return { ok: false, reason: 'adapter_unavailable' };
      const items = await adapter.getItems();
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return { ok: false, reason: 'no_items' };
      const compactedText = String(await adapter.getCompactedText?.() || '').trim();
      const requestOptions = await resolveRequestOptions({ sessionId, place: resolvedPlace });
      let preview = null;
      const startedAt = Date.now();
      const raw = await requestCompactionRaw({
        items: list,
        compactedText,
        context: buildSessionContext(sessionId),
        buildMessages,
        backgroundChat: previewOnly
          ? async (messages, options) => { preview = await backgroundChat(messages, { ...options, previewOnly: true }); return ''; }
          : backgroundChat,
        options: {
          presetContext: { sessionId, uiMode: resolvedPlace === 'writing' ? 'rp' : 'chat' },
          ...(requestOptions || {}),
          temperature: 0.2,
          ...(signal ? { signal } : {}),
        },
        taskPreset,
      });
      signal?.throwIfAborted?.();
      return { ok: true, raw: String(raw || ''), preview, itemCount: list.length, latencyMs: Date.now() - startedAt };
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: 'request_failed', error: String(error?.message || error) };
    }
  };

  return compact;
};

const SUMMARY_DRY_RUN_MESSAGES = {
  missing_session: '请先打开一个会话',
  no_items: '这个会话还没有可合并的摘要',
  model_unavailable: '还没有配置可用的模型',
  adapter_unavailable: '当前记忆模式不能压缩',
  cancelled: '已停止',
};

// 记忆卡「套用预设」的预览／试运行：按当前会话解析所选预设，调 dryRun，结果翻成卡片显示的文字。
export const createSummaryCompactionPresetHandler = ({
  getSessionId = () => '',
  getPlace = () => '',
  resolvePreset = () => ({ ok: false }),
  dryRun = async () => ({ ok: false, reason: 'model_unavailable' }),
  describeTrial = raw => ({ ok: Boolean(raw), text: String(raw || ''), message: '' }),
} = {}) => {
  const run = async ({ presetId = '', previewOnly = false, signal = null } = {}) => {
    const sessionId = String(getSessionId() || '').trim();
    const taskPreset = resolvePreset(presetId, sessionId);
    if (!taskPreset?.ok) return { ok: false, message: '所选预设已不存在' };
    const result = await dryRun(sessionId, { place: getPlace(), previewOnly, signal, taskPreset });
    if (!result?.ok) return { ok: false, message: result?.error || SUMMARY_DRY_RUN_MESSAGES[result?.reason] || '试运行失败' };
    if (previewOnly) return result.preview?.messages ? { ok: true, messages: result.preview.messages } : { ok: false, message: '无法预览' };
    return { ...describeTrial(result.raw), latencyMs: result.latencyMs };
  };
  return {
    preview: ({ presetId } = {}) => run({ presetId, previewOnly: true }),
    trial: ({ presetId, signal } = {}) => run({ presetId, signal }),
  };
};
