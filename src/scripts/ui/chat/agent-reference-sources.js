// Read-only resource catalog for Agent reference material. Entries are explicit
// fixed references: the worldbook trigger/variable initialization path is not run.
import { prepareWorldEntries } from '../../utils/world-entry-activation.js';
import { shouldUseWorldPromptBlocks } from '../../variables/world-condition-core.js';

const str = value => String(value ?? '').trim();
const encode = value => encodeURIComponent(str(value));
const sourceId = (book, entry) => `worldbook:${encode(book)}${entry === undefined ? '' : `:${encode(entry)}`}`;
const bookFromId = id => { try { return id.startsWith('worldbook:') ? decodeURIComponent(id.split(':')[1]) : ''; } catch { return ''; } };
const enabledEntry = entry => entry?.disable !== true && entry?.disabled !== true && entry?.enabled !== false;
const entryName = (entry, index) => str(entry?.comment || entry?.title || entry?.name || entry?.key?.join?.('、')) || `#${index + 1}`;
const check = signal => { if (signal?.aborted) throw Object.assign(new Error('任务已取消'), { name: 'AbortError' }); };
const arrayEntries = entries => Array.isArray(entries) ? entries : Object.values(entries || {});
const normalizeBook = book => book ? { ...book,
  ...(book.localEntries ? { localEntries: arrayEntries(book.localEntries) } : {}), entries: arrayEntries(book.entries),
} : null;
const entryText = entry => {
  const blocks = Array.isArray(entry.promptBlocks) ? entry.promptBlocks : [];
  return shouldUseWorldPromptBlocks(entry.promptMode, blocks, { fallback: 'hybrid' })
    ? blocks.filter(block => block?.enabled !== false && str(block?.content)).map(block => String(block.content)).join('\n\n')
    : String(entry.content ?? entry.text ?? '');
};
const isPresetEnabled = (presets, type) => typeof presets?.getEnabled === 'function' ? presets.getEnabled(type) === true
  : typeof presets?.isEnabled === 'function' ? presets.isEnabled(type) === true : presets?.getState?.()?.enabled?.[type] === true;

export const createAgentReferenceSourceCatalog = ({ getWorldStore, getPresetStore, getResolvedWorldState = () => ({}), isCurrent = () => true } = {}) =>
  async (context, { config = {}, signal, worldbookId = '' } = {}) => {
    check(signal);
    if (!isCurrent(context)) return [];
    const world = getWorldStore(), presets = getPresetStore();
    await Promise.all([world?.ready, presets?.ready]); check(signal);
    if (!isCurrent(context)) return [];
    const selected = new Set(config.worldbook?.ids || []);
    const selectedBooks = [...selected].map(bookFromId).filter(Boolean);
    const names = [...new Set([...(world?.list?.() || []), ...selectedBooks])];
    const bound = new Set(getResolvedWorldState(context.sessionId, { uiMode: context.place === 'writing' ? 'rp' : 'chat' })?.worldIds || []);
    const load = [...new Set([...bound, ...selectedBooks, worldbookId].filter(Boolean))].filter(name => names.includes(name));
    const loadSet = new Set(load);
    let loadFailed = false;
    if (load.length) {
      try { await world?.ensureLoadedMany?.(load, { includeRefs: true }); }
      catch (error) { check(signal); if (error?.name === 'AbortError') throw error; loadFailed = true; }
    }
    check(signal);
    if (!isCurrent(context)) return [];
    const records = [], knownBooks = new Map(), wholeCoveredEntries = new Set();
    const loadSnapshot = name => {
      if (!knownBooks.has(name)) knownBooks.set(name, normalizeBook(world?.load?.(name)));
      return knownBooks.get(name);
    };
    const bookRows = new Map();
    for (const name of names) {
      const book = loadSet.has(name) ? loadSnapshot(name) : null;
      const entries = book ? prepareWorldEntries({ worldId: name, data: book, loadWorld: loadSnapshot }) : [];
      const seen = new Set();
      const rows = entries.map((entry, index) => {
        const key = entry?.uid ?? entry?.id;
        const origin = str(entry?._sourceWorldId || name);
        const addressable = key !== undefined && key !== null && str(key) !== '';
        // Referenced entries carry their origin in the ID, so a local uid=0 and
        // a referenced uid=0 cannot collide when entries are re-ordered.
        const id = origin === name ? sourceId(name,key) : `${sourceId(name)}:ref:${encode(origin)}:${encode(key)}`;
        return { entry, index, key, id, addressable,
          identity: `${encode(origin)}:${addressable ? encode(key) : `anonymous:${index}`}`, text: entryText(entry) };
      }).filter(row => {
        if (seen.has(row.identity)) return false;
        seen.add(row.identity); return true;
      });
      bookRows.set(name, rows);
    }
    for (const name of selectedBooks) if (selected.has(sourceId(name))) {
      for (const row of bookRows.get(name) || []) if (enabledEntry(row.entry) && row.text.trim()) wholeCoveredEntries.add(row.identity);
    }
    for (const name of names) {
      const book = loadSet.has(name) ? loadSnapshot(name) : null, metadata = world?.getMetadata?.(name), rows = bookRows.get(name) || [];
      // Deleted selections are absent from the catalog, which lets the reference
      // builder keep an explicit missing chip rather than pretend it is empty.
      if (!book && !metadata && !world?.has?.(name)) continue;
      const wholeId = sourceId(name);
      const wholeText = rows.filter(row => enabledEntry(row.entry) && row.text.trim())
        .map(row => `【${entryName(row.entry,row.index)}】\n${row.text}`).join('\n\n');
      records.push({ id: wholeId, kind: 'worldbook', title: name, group: name, bookId: name, whole: true,
        hasChildren: true, entriesLoaded: Boolean(book), bound: bound.has(name), available: Boolean(book || (!loadSet.has(name) && (world?.has?.(name) || metadata))),
        ...(loadSet.has(name) && !book ? { message: loadFailed ? '世界书读取失败，请重试' : '世界书内容暂时无法读取' } : {}),
        text: wholeText, chars: wholeText.length, entryCount: rows.length || metadata?.entriesCount || 0 });
      for (const {entry,index,id,identity,text} of rows.filter(row => row.addressable)) {
        records.push({ id, kind: 'worldbook', title: entryName(entry,index), group: name, bookId: name,
          whole: false, available: true, disabled: !enabledEntry(entry), covered: wholeCoveredEntries.has(identity), text, chars: text.length,
          ...(entry._refWorldId ? { originBookId: entry._sourceWorldId } : {}) });
      }
    }
    const presetContext = { sessionId: context.sessionId, uiMode: context.place === 'writing' ? 'rp' : 'chat' };
    for (const type of ['openai', 'sysprompt']) {
      if (!isPresetEnabled(presets,type)) continue;
      const resolved = presets?.getResolvedActive?.(type,presetContext), preset = resolved?.preset;
      if (!preset) continue;
      const id = resolved.presetId || preset.id || presets?.getActiveId?.(type), group = str(preset.name) || type;
      if (!id) continue;
      const push = (key,title,text,disabled=false) => {
        if (!str(text)) return;
        records.push({ id: `prompt:${encode(type)}:${encode(id)}:${encode(key)}`, kind: 'prompt', title: str(title) || key,
          group, available: true, disabled, text: String(text), chars: String(text).length });
      };
      if (type === 'openai') {
        const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
        const orders = Array.isArray(preset.prompt_order) ? preset.prompt_order : [];
        const order = (orders.find(row => Number(row.character_id) === 100001)
          || orders.find(row => Number(row.character_id) === 100000) || orders[0])?.order;
        const orderRows = Array.isArray(order) ? order : [];
        const orderById = new Map(orderRows.map(row => [str(row.identifier), row]));
        for (const block of prompts) if (!block.marker && block.identifier) push(`block:${block.identifier}`,block.name,block.content,
          block.enabled === false || (Array.isArray(order) && !orderById.has(str(block.identifier))) || orderById.get(str(block.identifier))?.enabled === false);
      } else {
        push('content', '系统提示词', preset.content || preset.prompt);
        push('post_history', '后置提示词', preset.post_history || preset.post_history_instructions);
      }
    }
    check(signal);
    return isCurrent(context) ? records : [];
  };
