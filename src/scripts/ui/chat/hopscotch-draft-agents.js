// 编排草稿里因切换类型、套用模板而新建的 Agent。草稿结束（保存、放弃、关闭）时，没放进编排板、
// 也没被改过或启用的就删除，不留下多余的 Agent。名单存在本机：页面中途重载后，下次打开同一会话时补做清理。
const STORAGE_KEY = 'hopscotch_draft_agents_v1';
const stampOf = config => JSON.stringify({ ...config, updatedAt: 0 });

export const createHopscotchDraftAgents = ({ storage = globalThis.localStorage, listAgents = () => [], removeAgent = async () => ({ ok: true }) } = {}) => {
  let entries = [];
  try { entries = JSON.parse(storage?.getItem(STORAGE_KEY) || '[]'); } catch {}
  if (!Array.isArray(entries)) entries = [];
  const persist = () => { try { storage?.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-40))); } catch {} };
  const find = (id, target) => listAgents(target).find(config => config.id === id) || null;
  return {
    // context：所在会话；target：编排作用域（列出 Agent 用）；scope：Agent 保存的配置范围（删除用）。
    track(id, { context, target, scope }) {
      const config = find(id, target);
      if (!config) return;
      entries = [...entries.filter(entry => entry.id !== id), { id, context, target, scope, stamp: stampOf(config) }];
      persist();
    },
    // 由编排板自己改的设置（如切换自动/手动）不算用户改过。
    restamp(id) {
      const entry = entries.find(item => item.id === id);
      const config = entry && find(id, entry.target);
      if (!config) return;
      entry.stamp = stampOf(config);
      persist();
    },
    pending: context => new Set(entries.filter(entry => entry.context === context).map(entry => entry.id)),
    // keep：已保存进编排板的 Agent，保留并不再追踪；其余未改过、未启用的删除。只处理当前会话的条目。
    async settle(context, keep = new Set()) {
      const mine = entries.filter(entry => entry.context === context);
      if (!mine.length) return [];
      entries = entries.filter(entry => entry.context !== context);
      persist();
      const removed = [];
      for (const entry of mine) {
        if (keep.has(entry.id)) continue;
        const config = find(entry.id, entry.target);
        if (!config || config.enabled || stampOf(config) !== entry.stamp) continue;
        try { if ((await removeAgent(entry.id, { scope: entry.scope }))?.ok !== false) removed.push(entry.id); } catch {}
      }
      return removed;
    },
  };
};
