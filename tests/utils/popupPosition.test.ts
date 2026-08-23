import { afterEach, describe, expect, it, vi } from 'vitest';
import { calcAnchoredPosition, calcFixedPosition } from '../../src/utils/popupPosition';

describe('popupPosition 视口边缘校正', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('弹层越过顶部时向下移动到安全边距', () => {
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 });

    expect(calcFixedPosition(150, -100, 336, 280, 12)).toEqual({
      left: 150,
      top: 12,
    });
  });

  it('弹层越过右侧和底部时整体移回视口', () => {
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 });

    expect(calcFixedPosition(900, 700, 336, 200, 12)).toEqual({
      left: 652,
      top: 588,
    });
  });

  it('锚点上方空间足够时贴在锚点上方，并校正右边缘', () => {
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 });

    expect(calcAnchoredPosition({ left: 900, top: 300, bottom: 320 }, 336, 200, 8, 12)).toEqual({
      left: 652,
      top: 92,
      placement: 'above',
    });
  });

  it('锚点靠近顶部时自动翻到下方', () => {
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 });

    expect(calcAnchoredPosition({ left: 180, top: 20, bottom: 40 }, 336, 280, 8, 12)).toEqual({
      left: 180,
      top: 48,
      placement: 'below',
    });
  });
});
