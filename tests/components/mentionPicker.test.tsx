import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>,
  refCursor: 0,
  layoutCursor: 0,
  deps: [] as Array<readonly unknown[] | undefined>,
  pending: [] as Array<() => void>,
}));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useRef: <T,>(initial: T) => {
    const index = hooks.refCursor++;
    return (hooks.refs[index] ??= { current: initial }) as { current: T };
  },
  useState: <T,>(initial: T) => [initial, vi.fn()] as const,
  useEffect: () => {},
  useLayoutEffect: (effect: () => void, deps: readonly unknown[]) => {
    const index = hooks.layoutCursor++;
    const previous = hooks.deps[index];
    if (!previous || deps.some((value, offset) => !Object.is(value, previous[offset]))) {
      hooks.pending.push(effect);
    }
    hooks.deps[index] = deps;
  },
}));

import MentionPicker from '../../src/components/shared/MentionPicker';

function render(activeKey?: string, activeChip = 'all') {
  hooks.refCursor = 0;
  hooks.layoutCursor = 0;
  return MentionPicker({
    tabs: [], activeTab: 'assets', activeChip, activeKey, onTabChange: () => {},
    items: ['first', 'last'].map((key) => ({ key, label: key, onSelect: () => {} })),
  });
}

function flushLayout() {
  hooks.pending.splice(0).forEach((effect) => effect());
}

beforeEach(() => {
  hooks.refs = [];
  hooks.deps = [];
  hooks.pending = [];
});

describe('MentionPicker 滚动定位', () => {
  it('切换分类复位滚动，单独改变高亮项不会复位', () => {
    render();
    const grid = { scrollTop: 200 };
    hooks.refs[0].current = grid;
    flushLayout();
    expect(grid.scrollTop).toBe(0);

    grid.scrollTop = 200;
    render('last');
    flushLayout();
    expect(grid.scrollTop).toBe(200);

    render(undefined, 'prop');
    flushLayout();
    expect(grid.scrollTop).toBe(0);
  });

  it.each([
    { top: 220, bottom: 260, height: 100, expected: 260 },
    { top: 80, bottom: 120, height: 100, expected: 180 },
    { top: 110, bottom: 150, height: 100, expected: 200 },
    { top: 220, bottom: 260, height: 200, expected: 320 },
  ])('高亮项只在超出可视区时滚动列表，并换算画布缩放：%j', ({ top, bottom, height, expected }) => {
    render();
    const grid = {
      scrollTop: 0, offsetHeight: height,
      getBoundingClientRect: () => ({ top: 100, bottom: 200, height: 100 }),
    };
    hooks.refs[0].current = grid;
    flushLayout();
    grid.scrollTop = 200;
    hooks.refs[1].current = { getBoundingClientRect: () => ({ top, bottom }) };
    render('last');
    flushLayout();
    expect(grid.scrollTop).toBe(expected);
  });
});
