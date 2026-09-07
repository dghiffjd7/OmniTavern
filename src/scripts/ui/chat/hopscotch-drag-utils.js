import { t } from '../../i18n/index.js';
import { normalizeHopscotchBoard, validateHopscotchBoard, HOPSCOTCH_FUSED_KINDS } from './hopscotch-board-utils.js';

let sequence = 0;
export const findHopscotchNode = (board, id) => {
  for (const row of board?.rows || []) for (const house of row.houses) {
    if (house.id === id) return { row, house, node: house, member: '' };
    for (const [kind, node] of Object.entries(house.fusedMembers || {})) if (node.id === id) return { row, house, node, member: kind };
  }
  return null;
};
const layout = board => JSON.stringify(board.rows.map(row => row.houses.map(h => [h.id, h.fused || []])));
export const getHopscotchFusionReason = (node, host, capabilities = {}) => {
  if (host?.kind !== 'body' || !HOPSCOTCH_FUSED_KINDS.includes(node?.kind)) return capabilities[node?.kind]?.reason || t('此房子需要独立请求');
  if (host.fused?.includes(node.kind)) return t('此融合组已包含相同功能');
  if (node.config?.modelMode === 'profile' || node.config?.modelOverride) return t('独立模型配置需先改为跟随正文');
  return capabilities[node.kind]?.reason || '';
};

// 行 ID 和相邻节点 ID 决定插入位置；源行清空后再规范化，避免跨行移动的索引偏移。
export const applyHopscotchDrop = (input, sourceId, target, { capabilities = {} } = {}) => {
  const board = normalizeHopscotchBoard(input), source = findHopscotchNode(board, sourceId);
  const reject = reason => ({ ok: false, reason, board: input });
  if (!source || !target) return reject(t('移动目标已失效'));
  const before = layout(board);
  const detach = () => {
    if (source.member) {
      source.house.fused = source.house.fused.filter(kind => kind !== source.member);
      delete source.house.fusedMembers[source.member]; delete source.house.fusedEnabled[source.member];
    } else source.row.houses.splice(source.row.houses.indexOf(source.house), 1);
  };
  if (target.type === 'fuse') {
    const host = board.rows.flatMap(row => row.houses).find(house => house.id === target.hostId);
    if (source.house === host) return { ok: true, board, changed: false };
    const reason = getHopscotchFusionReason(source.node, host, capabilities);
    if (reason) return reject(reason);
    detach(); host.fused.push(source.node.kind);
    host.fusedMembers[source.node.kind] = source.node;
    host.fusedEnabled[source.node.kind] = source.node.enabled !== false;
  } else if (target.type === 'row') {
    const row = board.rows.find(row => row.id === target.rowId);
    if (!row) return reject(t('移动目标已失效'));
    if (target.beforeId === source.node.id) return { ok: true, board, changed: false };
    detach();
    const index = target.beforeId ? row.houses.findIndex(h => h.id === target.beforeId) : row.houses.length;
    if (index < 0) return reject(t('移动目标已失效'));
    row.houses.splice(index, 0, source.node);
  } else if (target.type === 'gap') {
    const index = target.beforeRowId ? board.rows.findIndex(row => row.id === target.beforeRowId) : board.rows.length;
    if (index < 0) return reject(t('移动目标已失效'));
    detach(); board.rows.splice(index, 0, { id: `r_drop_${Date.now().toString(36)}_${++sequence}`, houses: [source.node] });
  } else return reject(t('移动目标已失效'));
  const result = validateHopscotchBoard(board);
  if (!result.ok) return reject(result.errors[0]?.message || t('此处无法放置'));
  const changed = layout(result.board) !== before;
  return { ok: true, board: changed ? result.board : normalizeHopscotchBoard(input), changed };
};

export const listHopscotchDropTargets = (board, sourceId, options) => {
  const targets = [];
  for (const row of board.rows) {
    targets.push({ type: 'gap', beforeRowId: row.id });
    for (const house of row.houses) {
      targets.push({ type: 'row', rowId: row.id, beforeId: house.id });
      if (house.kind === 'body') targets.push({ type: 'fuse', hostId: house.id });
    }
    targets.push({ type: 'row', rowId: row.id, beforeId: '' });
  }
  targets.push({ type: 'gap', beforeRowId: '' });
  return targets.map(target => ({ ...target, ...applyHopscotchDrop(board, sourceId, target, options) }));
};
