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
  refreshChatAndContacts = () => {},
  dispatchUpdated = () => {},
  dispatchFailed = () => {},
  logger = null,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  delayMs = 450,
} = {}) => {
  const compacting = new Set();

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

  return async (sid, { force = false, place = '', signal = null, detailed = false, expectedAdapterKind = '' } = {}) => {
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
    if (!shouldCompact({ items: list, force })) return skipped('threshold_not_reached');
    if (signal?.aborted) return result('cancelled', 'aborted');

    compacting.add(compactKey);
    return new Promise((resolve) => {
      setTimeoutFn(async () => {
        try {
          signal?.throwIfAborted();
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
            ...(signal ? { options: { signal, temperature: 0.2, maxTokens: 800, presetContext: { sessionId, uiMode: resolvedPlace === 'writing' ? 'rp' : 'chat' } } } : {}),
          });
          signal?.throwIfAborted();
          if (!raw) return resolve(result('failed', 'empty_response'));
          try {
            await adapter.setRaw?.(raw);
          } catch {}

          const { text, valid } = parseCompactionResult(raw);
          if (!text) {
            try {
              dispatchFailed(sessionId, 'missing_summary_tag');
            } catch {}
            return resolve(result('failed', 'missing_summary_tag'));
          }

          if (!valid) {
            try {
              dispatchFailed(sessionId, 'format');
            } catch {}
            return resolve(result('failed', 'format'));
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
          resolve(result('succeeded'));
        } catch (error) {
          try {
            logger?.debug?.('summary compaction failed', error);
          } catch {}
          resolve(result(signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed', 'compaction_error', String(error?.message || error)));
        } finally {
          compacting.delete(compactKey);
        }
      }, Number(delayMs || 0));
    });
  };
};
