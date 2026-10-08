// History remains global in the UI. Task planning only receives facts belonging
// to its captured card; explicit user preferences/decisions remain shared.
const trim = value => String(value ?? '').trim();

export const selectMaidContextScope = ({ turns = [], memoryRows = [], archivedTurns = [], context = {} } = {}) => {
  const roleCardId = trim(context?.roleCardId);
  if (!roleCardId) return { turns, memoryRows, filterMemories: memories => memories };
  const belongs = turn => trim(turn?.context?.roleCardId) === roleCardId;
  const byId = new Map([...archivedTurns, ...turns].map(turn => [trim(turn?.id), turn]));
  const belongsBySource = item => {
    if (trim(item?.context?.roleCardId)) return belongs(item);
    const ids = Array.isArray(item?.sourceTurnIds) ? item.sourceTurnIds.map(trim).filter(Boolean) : [];
    return ids.length > 0 && ids.every(id => belongs(byId.get(id)));
  };
  return {
    turns: turns.filter(belongs),
    memoryRows: memoryRows.filter(belongsBySource),
    filterMemories: memories => memories.filter(memory => (
      ['preference', 'decision'].includes(memory?.kind) || belongsBySource(memory)
    )),
  };
};
