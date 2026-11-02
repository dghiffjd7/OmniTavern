// 贴图面板分页：每页排满两行。手机固定 4 列；宽屏（≥600px）格子 70–96px（两行放得进面板），按面板宽度算列数，
// 每页张数跟着列数走，避免固定 8 张时排成「一行 7 张、第二行只剩 1 张」。
const ROWS = 2;
const PANEL_PADDING_X = 24; // 面板左右内边距各 12px
const CELL_TARGET = 96;
const GAP = 10;
const MIN_COLUMNS = 4;

export const resolveStickerPanelLayout = ({ panelWidth = 0, wide = false } = {}) => {
  const usable = Math.max(0, Number(panelWidth) || 0) - PANEL_PADDING_X;
  const columns = wide ? Math.max(MIN_COLUMNS, Math.floor((usable + GAP) / (CELL_TARGET + GAP))) : MIN_COLUMNS;
  return { columns, pageSize: columns * ROWS };
};
