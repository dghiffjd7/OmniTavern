import { normalizeHopscotchBoard, validateHopscotchBoard } from './hopscotch-board-utils.js';

let sequence = 0;
const newId = prefix => `${prefix}_${Date.now().toString(36)}_${++sequence}`;

// 所有输入方式共用同一套原子操作；非法移动不改变草稿。
export const editHopscotchBoard = (board, action = {}) => {
  const next = normalizeHopscotchBoard(board);
  const rows = next.rows;
  const sourceRow = rows.find(row => row.houses.some(h => h.id === action.id));
  const house = sourceRow?.houses.find(h => h.id === action.id);
  const body = rows.flatMap(row => row.houses).find(h => h.kind === 'body');
  const insert = (item) => {
    const index = Math.max(0, Math.min(rows.length, Number(action.rowIndex) || 0));
    if (action.newRow || index === rows.length) rows.splice(index, 0, { id: newId('row'), houses: [item] });
    else rows[index].houses.splice(action.houseIndex ?? rows[index].houses.length, 0, item);
  };
  switch (action.type) {
    case 'add': insert({ id: newId('house'), kind: action.kind, ...action.house }); break;
    case 'remove':
      if (!house || house.kind === 'body') return { ok: false, reason: 'body_required' };
      sourceRow.houses.splice(sourceRow.houses.indexOf(house), 1);
      break;
    case 'move':
      if (!house) return { ok: false, reason: 'house_missing' };
      sourceRow.houses.splice(sourceRow.houses.indexOf(house), 1);
      insert(house);
      break;
    case 'copy':
      if (house?.kind !== 'custom_prompt') return { ok: false, reason: 'custom_only' };
      sourceRow.houses.push({ ...structuredClone(house), id: newId('house') });
      break;
    case 'update':
      if (!house) return { ok: false, reason: 'house_missing' };
      Object.assign(house, action.patch, { id: house.id, kind: house.kind });
      break;
    case 'fuse':
      if (!body) return { ok: false, reason: 'body_required' };
      if (action.enabled) {
        body.fused = [...new Set([...body.fused, action.kind])];
        if (action.kind === 'memory_table') rows.forEach(row => { row.houses = row.houses.filter(h => h.kind !== 'memory_table'); });
      } else body.fused = body.fused.filter(kind => kind !== action.kind);
      break;
    case 'policy': Object.assign(next.policy, action.patch); break;
    default: return { ok: false, reason: 'unknown_action' };
  }
  const result = validateHopscotchBoard(next);
  return { ...result, reason: result.errors?.map(error => error.message || error.code).join('\n') || '' };
};
