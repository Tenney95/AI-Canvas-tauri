import type { Node as RFNode } from '@xyflow/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import type { DistributionAxis } from '../../src/utils/distributionGeometry';

const driver = vi.hoisted(() => ({
  nodes: [] as RFNode<BaseNodeData>[],
  selectedNodeIds: [] as string[],
  viewport: { x: 0, y: 0, zoom: 1 },
  container: { x: 0, y: 0 },
  flowToScreenPosition: vi.fn<(point: { x: number; y: number }) => { x: number; y: number }>(),
  screenToFlowPosition: vi.fn(),
}));

vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({
    flowToScreenPosition: driver.flowToScreenPosition,
    screenToFlowPosition: driver.screenToFlowPosition,
  }),
  useViewport: () => driver.viewport,
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: (selector: (state: typeof driver) => unknown) => selector(driver),
}));
vi.mock('../../src/i18n', () => ({ useT: () => (message: string) => message }));

import DistributionGapHandles from '../../src/components/canvas/DistributionGapHandles';

function node(id: string, x: number, y: number, width = 100, height = 60): RFNode<BaseNodeData> {
  return {
    id, type: 'ai-image', position: { x, y },
    data: { type: 'ai-image', label: id, nodeWidth: width, nodeHeight: height },
  };
}

function renderHandles(axis: DistributionAxis = 'horizontal') {
  const markup = renderToStaticMarkup(<DistributionGapHandles axis={axis} />);
  return [...markup.matchAll(/<button\b[^>]*>/g)].map(([button]) => {
    const style = button.match(/style="([^"]*)"/)?.[1] ?? '';
    return {
      axis: button.match(/data-distribution-axis="([^"]*)"/)?.[1],
      index: Number(button.match(/data-gap-index="([^"]*)"/)?.[1]),
      x: Number.parseFloat(style.match(/(?:^|;)left:([^;]+)/)?.[1] ?? ''),
      y: Number.parseFloat(style.match(/(?:^|;)top:([^;]+)/)?.[1] ?? ''),
    };
  });
}

beforeEach(() => {
  driver.nodes = [node('a', 10, 20), node('b', 210, 40, 120, 100), node('c', 410, -20, 80, 80)];
  driver.selectedNodeIds = ['c', 'a', 'b'];
  driver.viewport = { x: 0, y: 0, zoom: 1 };
  driver.container = { x: 0, y: 0 };
  driver.flowToScreenPosition.mockImplementation((point) => ({
    x: driver.container.x + driver.viewport.x + point.x * driver.viewport.zoom,
    y: driver.container.y + driver.viewport.y + point.y * driver.viewport.zoom,
  }));
});

describe('distribution gap handle screen projection', () => {
  it.each([
    { zoom: 0.1, positions: [[16, 6], [37, 5]] },
    { zoom: 0.5, positions: [[80, 30], [185, 25]] },
    { zoom: 1, positions: [[160, 60], [370, 50]] },
    { zoom: 2, positions: [[320, 120], [740, 100]] },
    { zoom: 5, positions: [[800, 300], [1850, 250]] },
  ])('keeps horizontal handles centered at zoom $zoom', ({ zoom, positions }) => {
    driver.viewport.zoom = zoom;
    const handles = renderHandles();

    expect(handles.map(({ x, y }) => [x, y])).toEqual(positions);
    expect(handles.map(({ axis, index }) => [axis, index])).toEqual([['horizontal', 0], ['horizontal', 1]]);
    expect(driver.flowToScreenPosition).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 0 });
    expect(driver.screenToFlowPosition).not.toHaveBeenCalled();
  });

  it('includes viewport translation and the canvas container offset', () => {
    driver.viewport = { x: -90, y: 35, zoom: 0.5 };
    driver.container = { x: 300, y: 70 };
    expect(renderHandles().map(({ x, y }) => [x, y])).toEqual([[290, 135], [395, 130]]);

    driver.viewport = { x: 40, y: -80, zoom: 2 };
    driver.container = { x: 120, y: 200 };
    expect(renderHandles().map(({ x, y }) => [x, y])).toEqual([[480, 240], [900, 220]]);
    expect(driver.flowToScreenPosition).toHaveBeenCalledTimes(2);
  });

  it('retains vertical ordering and positions through negative coordinates and zoom', () => {
    driver.viewport = { x: -120, y: -40, zoom: 1.5 };
    driver.container = { x: 20, y: 10 };

    expect(renderHandles('vertical')).toEqual([
      { axis: 'vertical', index: 0, x: 140, y: 60 },
      { axis: 'vertical', index: 1, x: 455, y: 60 },
    ]);
    expect(driver.flowToScreenPosition).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 0 });
  });

  it.each(['horizontal', 'vertical'] as const)('accounts for nested parent groups in the %s axis', (axis) => {
    const outer = { ...node('outer', 500, -200, 800, 600), type: 'group' };
    const inner = { ...node('inner', 50, 30, 600, 400), type: 'group', parentId: 'outer' };
    const a = { ...node('a', 10, 20), parentId: 'inner' };
    const b = { ...node('b', 200, 100), parentId: 'inner' };
    driver.nodes = [outer, inner, b, a];
    driver.selectedNodeIds = ['outer', 'b', 'inner', 'a'];
    driver.viewport = { x: -40, y: 20, zoom: 2 };
    driver.container = { x: 300, y: 100 };

    // Absolute gap center is (705, -80); selected group containers are not gap endpoints.
    expect(renderHandles(axis)).toEqual([{ axis, index: 0, x: 1670, y: -40 }]);
    expect(driver.flowToScreenPosition).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 0 });
  });

  it('converts the origin once when hundreds of selected nodes produce handles', () => {
    driver.nodes = Array.from({ length: 1000 }, (_, index) => node(`node-${index}`, index * 200, 0));
    driver.selectedNodeIds = driver.nodes.map(({ id }) => id);
    driver.viewport = { x: -25, y: 10, zoom: 0.25 };
    driver.container = { x: 100, y: 40 };

    const handles = renderHandles();
    expect(handles).toHaveLength(999);
    expect(handles[0]).toEqual({ axis: 'horizontal', index: 0, x: 112.5, y: 57.5 });
    expect(handles.at(-1)).toEqual({ axis: 'horizontal', index: 998, x: 50012.5, y: 57.5 });
    expect(driver.flowToScreenPosition).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 0 });
  });

  it.each([{ selectedIds: [] }, { selectedIds: ['a'] }, { selectedIds: ['missing'] }])('does not convert coordinates without an adjacent selected pair: $selectedIds', ({ selectedIds }) => {
    driver.selectedNodeIds = selectedIds;
    expect(renderHandles()).toEqual([]);
    expect(driver.flowToScreenPosition).not.toHaveBeenCalled();
  });

  it('does not convert coordinates when only parent groups are selected', () => {
    driver.nodes = [{ ...node('group-a', 0, 0), type: 'group' }, { ...node('group-b', 500, 0), type: 'group' }];
    driver.selectedNodeIds = ['group-a', 'group-b'];
    expect(renderHandles()).toEqual([]);
    expect(driver.flowToScreenPosition).not.toHaveBeenCalled();
  });
});
