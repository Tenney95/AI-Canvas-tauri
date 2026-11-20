/**
 * mentionPicker — 回归测试：MentionPicker 滚动定位。
 */
vi.mock('../../src/services/comfyMediaSource', () => ({
  acquireComfyMediaSource: async (src: string) => ({ src, release: () => {} }),
  shouldLoadNativeComfyMedia: () => false,
}));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const hooks = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>,
  refCursor: 0,
  layoutCursor: 0,
  deps: [] as Array<readonly unknown[] | undefined>,
  pending: [] as Array<() => void>,
}));

vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>();
  return { ...actual, useT: () => actual.t };
});
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useCallback: <T,>(callback: T) => callback,
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
import VideoThumbnail from '../../src/components/shared/VideoThumbnail';
import ViewportImage from '../../src/components/shared/ViewportImage';

function elements(value: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children)];
}

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
  it('视频卡片使用共享静态缩略图，图片仍走原图片加载器，选择行为保持不变', () => {
    hooks.refCursor = 0;
    hooks.layoutCursor = 0;
    const selectVideo = vi.fn();
    const tree = MentionPicker({ tabs: [], activeTab: 'nodes', onTabChange: vi.fn(), items: [
      { key: 'video', label: '视频', thumbnailUrl: 'https://media.test/video.mp4',
        video: { src: 'https://media.test/video.mp4', filePath: 'C:/media/video.mp4' }, onSelect: selectVideo },
      { key: 'image', label: '图片', thumbnailUrl: 'cover.png', onSelect: vi.fn() },
    ] });
    const rendered = elements(tree);
    expect(rendered.find((element) => element.type === VideoThumbnail)?.props).toMatchObject({
      src: 'https://media.test/video.mp4', filePath: 'C:/media/video.mp4', poster: 'https://media.test/video.mp4',
    });
    expect(rendered.filter((element) => element.type === ViewportImage).map((element) => element.props.src)).toEqual(['cover.png']);
    expect(rendered.some((element) => element.type === 'video')).toBe(false);
    const card = rendered.find((element) => element.type === 'button' && element.props.title === '视频')!;
    const preventDefault = vi.fn();
    (card.props.onMouseDown as (event: unknown) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(selectVideo).toHaveBeenCalledOnce();
  });

  it('工作流卡片在外层提供可换行的完整悬停提示，避免与原生标题重复', () => {
    hooks.refCursor = 0;
    hooks.layoutCursor = 0;
    const label = '角色参考图转多镜头角色一致性工作流完整版';
    const tooltip = `${label}\n请先配置对应供应商`;
    const tree = MentionPicker({ tabs: [], activeTab: 'models', onTabChange: vi.fn(), items: [
      { key: 'workflow', label, tooltip, title: '请先配置对应供应商', disabled: true, onSelect: vi.fn() },
    ] });
    const wrapper = elements(tree).find((element) => element.props['data-tooltip'] === tooltip);
    const option = elements(wrapper?.props.children).find((element) => element.props.role === 'option');
    expect(option?.props).toMatchObject({ disabled: true, title: undefined });
  });

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
