/**
 * 宫格分镜的格子几何：均分宫格与自定义线宫格共用同一套边界计算。
 */

export interface StoryboardGeometry {
  rows: number;
  cols: number;
  /** 自定义横线位置百分比（有序，不含 0/100）；为空表示均分 */
  rowPositions?: number[];
  colPositions?: number[];
}

/** 行或列的边界百分比（含 0 与 100） */
export function gridBoundaries(count: number, positions?: number[]): number[] {
  const total = Math.max(1, Math.floor(count) || 1);
  if (positions?.length) return [0, ...positions, 100];
  return Array.from({ length: total + 1 }, (_, index) => (index / total) * 100);
}

/** value 落在第几个区间 */
function bandIndex(boundaries: number[], value: number): number {
  for (let index = 0; index < boundaries.length - 1; index++) {
    if (value < boundaries[index + 1]) return index;
  }
  return boundaries.length - 2;
}

/**
 * 改完分割线后把旧格内容搬到新格。
 * 线的条数没变说明只是挪线，格子按下标一一对应；增删线才按旧格中心点落在哪个新格里算。
 * 返回 newIndex → oldIndex（-1 表示新格没有对应内容）；多个旧格并进同一新格时先到先得。
 */
export function remapStoryboardCells(prev: StoryboardGeometry, next: StoryboardGeometry): number[] {
  if (prev.rows === next.rows && prev.cols === next.cols) {
    return Array.from({ length: next.rows * next.cols }, (_, index) => index);
  }
  const prevRowBounds = gridBoundaries(prev.rows, prev.rowPositions);
  const prevColBounds = gridBoundaries(prev.cols, prev.colPositions);
  const nextRowBounds = gridBoundaries(next.rows, next.rowPositions);
  const nextColBounds = gridBoundaries(next.cols, next.colPositions);
  const nextCols = nextColBounds.length - 1;
  const map = new Array<number>((nextRowBounds.length - 1) * nextCols).fill(-1);

  for (let row = 0; row < prevRowBounds.length - 1; row++) {
    for (let col = 0; col < prevColBounds.length - 1; col++) {
      const centerY = (prevRowBounds[row] + prevRowBounds[row + 1]) / 2;
      const centerX = (prevColBounds[col] + prevColBounds[col + 1]) / 2;
      const target = bandIndex(nextRowBounds, centerY) * nextCols + bandIndex(nextColBounds, centerX);
      if (map[target] === -1) map[target] = row * (prevColBounds.length - 1) + col;
    }
  }
  return map;
}

/**
 * 单格显示源图对应裁片的背景定位：整图按格数放大，再挪到该格的位置。
 * 用背景代替「每格一个超尺寸 <img>」，25 宫格就少 25 个大图层。
 * 百分比定位的含义是「图上 p% 的点对齐容器 p% 的点」，因此 p = 格左边距 / (100 - 格宽)。
 */
export function cellBackgroundStyle(
  left: number,
  top: number,
  width: number,
  height: number,
): { backgroundSize: string; backgroundPosition: string } {
  // 百分比按 1/3 这类除不尽的格宽算完会带浮点尾巴，写进 CSS 前收一下
  const pct = (value: number) => `${Math.round(value * 1e4) / 1e4}%`;
  const axis = (offset: number, size: number) => (size >= 100 ? 0 : (offset / (100 - size)) * 100);
  return {
    backgroundSize: `${pct((100 / width) * 100)} ${pct((100 / height) * 100)}`,
    backgroundPosition: `${pct(axis(left, width))} ${pct(axis(top, height))}`,
  };
}
