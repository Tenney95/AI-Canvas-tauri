import { describe, expect, it } from 'vitest';
import { cellBackgroundStyle, gridBoundaries, remapStoryboardCells } from '../../src/utils/storyboardGrid';

describe('gridBoundaries', () => {
  it('没有自定义线时按格数均分', () => {
    expect(gridBoundaries(4)).toEqual([0, 25, 50, 75, 100]);
  });

  it('有自定义线时补上 0 与 100', () => {
    expect(gridBoundaries(3, [20, 70])).toEqual([0, 20, 70, 100]);
  });
});

describe('remapStoryboardCells', () => {
  it('只挪线不增删时格子一一对应（挪多远都不丢内容）', () => {
    const map = remapStoryboardCells(
      { rows: 2, cols: 2, rowPositions: [50], colPositions: [50] },
      { rows: 2, cols: 2, rowPositions: [30], colPositions: [80] },
    );
    expect(map).toEqual([0, 1, 2, 3]);
  });

  it('加一条横线后旧格跟着中心点落到新格', () => {
    // 旧：上下两格；新：加一条 25% 的线变三格，旧上格中心 25% 落在新第二格
    const map = remapStoryboardCells(
      { rows: 2, cols: 1, rowPositions: [50] },
      { rows: 3, cols: 1, rowPositions: [25, 50] },
    );
    expect(map).toEqual([-1, 0, 1]);
  });

  it('删线让两个旧格并进一个新格时先到先得', () => {
    const map = remapStoryboardCells(
      { rows: 2, cols: 1, rowPositions: [50] },
      { rows: 1, cols: 1 },
    );
    expect(map).toEqual([0]);
  });

  it('均分宫格与自定义线宫格之间可以互转', () => {
    expect(remapStoryboardCells({ rows: 1, cols: 2 }, { rows: 1, cols: 2, colPositions: [40] }))
      .toEqual([0, 1]);
  });
});

describe('cellBackgroundStyle', () => {
  it('均分 3×3 的中间格用经典 sprite 定位', () => {
    const style = cellBackgroundStyle(100 / 3, 100 / 3, 100 / 3, 100 / 3);
    expect(style.backgroundSize).toBe('300% 300%');
    expect(style.backgroundPosition).toBe('50% 50%');
  });

  it('整宽的格子不做偏移，避免除以 0', () => {
    expect(cellBackgroundStyle(0, 0, 100, 50)).toEqual({
      backgroundSize: '100% 200%',
      backgroundPosition: '0% 0%',
    });
  });
});
