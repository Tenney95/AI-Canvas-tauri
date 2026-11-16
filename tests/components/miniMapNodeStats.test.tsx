/** 小地图统计只在悬浮时读取节点，重新打开时使用当前画布。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({
  hovered: false,
  nodes: [] as Array<{ type?: string }>,
  readNodes: vi.fn(),
}));

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useState: () => [state.hovered, () => {}],
}));
vi.mock('@xyflow/react', () => ({
  MiniMap: () => <div data-minimap="true" />,
  useStore: (selector: (value: { nodes: typeof state.nodes }) => unknown) => {
    state.readNodes();
    return selector({ nodes: state.nodes });
  },
}));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('../../src/types', () => ({ getNodeTypeConfig: (type: string) => ({ label: type }) }));

import MiniMapNodeStats from '../../src/components/canvas/MiniMapNodeStats';

beforeEach(() => {
  state.hovered = false;
  state.nodes = [];
  state.readNodes.mockClear();
});

describe('小地图节点统计', () => {
  it('隐藏时不读取节点，统计固定顺序和未知类型顺序保持不变', () => {
    state.nodes = [{ type: 'z-custom' }, { type: 'ai-image' }, { type: 'a-custom' }, { type: 'ai-text' }, { type: 'ai-image' }];
    const hidden = renderToStaticMarkup(<MiniMapNodeStats />);
    expect(hidden).toContain('data-minimap="true"');
    expect(hidden).not.toContain('role="tooltip"');
    expect(state.readNodes).not.toHaveBeenCalled();

    state.hovered = true;
    const visible = renderToStaticMarkup(<MiniMapNodeStats />);
    expect(state.readNodes).toHaveBeenCalledTimes(1);
    expect([...visible.matchAll(/minimap-stats-card__label">([^<]*)</g)].map((match) => match[1]))
      .toEqual(['ai-text', 'ai-image', 'a-custom', 'z-custom']);
    expect([...visible.matchAll(/minimap-stats-card__count">(\d+)</g)].map((match) => Number(match[1])))
      .toEqual([1, 2, 1, 1, 5]);
  });

  it('收起后停止读取，重新悬浮显示最新节点和空态', () => {
    state.hovered = true;
    state.nodes = [{ type: 'ai-text' }];
    expect(renderToStaticMarkup(<MiniMapNodeStats />)).toContain('minimap-stats-card__label">ai-text<');
    state.hovered = false;
    state.nodes = [];
    renderToStaticMarkup(<MiniMapNodeStats />);
    expect(state.readNodes).toHaveBeenCalledTimes(1);
    state.hovered = true;
    const reopened = renderToStaticMarkup(<MiniMapNodeStats />);
    expect(state.readNodes).toHaveBeenCalledTimes(2);
    expect(reopened).toContain('画布暂无节点');
    expect(reopened).toContain('minimap-stats-card__count">0<');
    expect(reopened).not.toContain('minimap-stats-card__row');
  });
});
