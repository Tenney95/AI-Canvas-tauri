/** canvasNodeDataSelector — 展示订阅的几何隔离、引用失效与连线顺序回归。 */
import type { Edge, Node } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import { createCanvasNodeDataSelector } from '../../src/utils/canvasNodeDataSelector';
import { getCanvasConnectedSourceNodes } from '../../src/utils/canvasConnectionIndex';

function node(id: string): Node<BaseNodeData> {
  return { id, type: 'ai-image', position: { x: 0, y: 0 },
    data: { type: 'ai-image', label: id, imageUrl: `asset://${id}.png`, displayId: 1 } };
}

describe('canvas display subscriptions', () => {
  it('keeps previews stable across dragging, selection and unrelated text edits', () => {
    const nodes = [node('ref'), node('other')];
    const select = createCanvasNodeDataSelector(['imageUrl'], ['ref']);
    const first = select(nodes);
    const changed = nodes.map((item) => ({ ...item, selected: true, position: { x: 99, y: 12 },
      data: { ...item.data, output: 'new output' } }));
    expect(select(changed)).toBe(first);
    expect(select(changed)[0]).not.toHaveProperty('position');
    expect(select(changed)[0].data).not.toHaveProperty('output');
    expect(select(changed.map((item) => item.id === 'ref'
      ? { ...item, data: { ...item.data, imageUrl: 'asset://new.png' } } : item))).not.toBe(first);
  });

  it('refreshes renamed references, deletions, restores and a project with reused ids', () => {
    const select = createCanvasNodeDataSelector(['displayId', 'imageUrl'], ['ref']);
    const source = node('ref');
    const first = select([source]);
    const renamed = select([{ ...source, data: { ...source.data, label: '改名', displayId: 9 } }]);
    expect(renamed).not.toBe(first);
    expect(renamed[0].data).toMatchObject({ label: '改名', displayId: 9 });
    expect(select([])).toEqual([]);
    expect(select([source])[0].data.imageUrl).toBe('asset://ref.png');
    expect(select([{ ...source, data: { ...source.data, imageUrl: 'asset://another-project.png' } }])[0].data.imageUrl)
      .toBe('asset://another-project.png');
  });

  it('does not inspect any canvas node for a draft without references', () => {
    const nodes = [node('unused')];
    const read = vi.spyOn(nodes, Symbol.iterator);
    const select = createCanvasNodeDataSelector(['displayId'], []);
    expect(select(nodes)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('releases an inactive picker snapshot and reads fresh data when it reopens', () => {
    const select = createCanvasNodeDataSelector(['imageUrl']);
    const source = node('ref');
    select([source]);
    const closed = select(undefined);
    expect(closed).toEqual([]);
    expect(select(undefined)).toBe(closed);
    const reopened = select([{ ...source, data: { ...source.data, imageUrl: 'asset://reopened.png' } }]);
    expect(reopened[0].data.imageUrl).toBe('asset://reopened.png');
  });

  it('preserves picker order when nodes are reordered', () => {
    const a = node('a'), b = node('b');
    const select = createCanvasNodeDataSelector(['imageUrl']);
    select([a, b]);
    expect(select([b, a]).map((item) => item.id)).toEqual(['b', 'a']);
  });
});

describe('incoming canvas references', () => {
  it('deduplicates sources in canvas order and drops missing or disconnected nodes', () => {
    const a = node('a'), b = node('b');
    const edges: Edge[] = [
      { id: 'b1', source: 'b', target: 'target' }, { id: 'a', source: 'a', target: 'target' },
      { id: 'b2', source: 'b', target: 'target' }, { id: 'missing', source: 'missing', target: 'target' },
    ];
    expect(getCanvasConnectedSourceNodes([a, b], edges, 'target')).toEqual([a, b]);
    expect(getCanvasConnectedSourceNodes([b, a], edges, 'target')).toEqual([b, a]);
    expect(getCanvasConnectedSourceNodes([a], edges, 'target')).toEqual([a]);
    expect(getCanvasConnectedSourceNodes([a, b], edges.filter((edge) => edge.source !== 'a'), 'target')).toEqual([b]);
  });

  it('reuses the edge index while reading current media after a source changes', () => {
    const source = node('source');
    const edge: Edge = { id: 'edge', source: 'source', get target() { return 'target'; } };
    const readTarget = vi.spyOn(edge, 'target', 'get');
    const edges = [edge];
    getCanvasConnectedSourceNodes([source], edges, 'target');
    readTarget.mockClear();
    const updated = { ...source, data: { ...source.data, imageUrl: 'asset://updated.png' } };
    expect(getCanvasConnectedSourceNodes([updated], edges, 'target')[0]).toBe(updated);
    expect(readTarget).not.toHaveBeenCalled();
  });
});
