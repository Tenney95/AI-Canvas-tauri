import type { Node } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';

const state = vi.hoisted(() => ({ nodes: [] as Node<BaseNodeData>[] }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state),
}));
import { useNodeLocked } from '../../src/hooks/useNodeLocked';

// 每个探针模拟独立把手实例；Store hook 由上面的 selector 驱动器执行。
function LockProbe(nodeId: string): boolean {
  return useNodeLocked(nodeId);
}

describe('shared node lock lookup', () => {
  it('follows lock changes, removal, and a project that reuses the same ID', () => {
    state.nodes = [{ id: 'one', position: { x: 0, y: 0 }, data: { type: 'ai-text', label: 'One' } }];
    expect(useNodeLocked('one')).toBe(false);
    state.nodes = [{ ...state.nodes[0], draggable: false }];
    expect(useNodeLocked('one')).toBe(true);
    state.nodes = [];
    expect(useNodeLocked('one')).toBe(false);
    expect(useNodeLocked()).toBe(false);
    state.nodes = [{ id: 'one', position: { x: 0, y: 0 }, data: { type: 'ai-text', label: 'Other project' } }];
    expect(useNodeLocked('one')).toBe(false);
  });

  it('reads IDs a linear number of times for thousands of mounted resize handles', () => {
    const count = 2000;
    let idReads = 0;
    state.nodes = Array.from({ length: count }, (_, index) => ({
      get id() { idReads++; return `node-${index}`; },
      position: { x: index, y: 0 }, draggable: index % 2 === 0,
      data: { type: 'ai-text' as const, label: `Node ${index}` },
    }));
    for (let index = 0; index < count; index++) expect(LockProbe(`node-${index}`)).toBe(index % 2 === 1);
    expect(idReads).toBeLessThan(count * 3);

    state.nodes = state.nodes.map((node, index) => index === count - 1 ? { ...node, draggable: true } : node);
    idReads = 0;
    for (let index = 0; index < count; index++) LockProbe(`node-${index}`);
    expect(idReads).toBeLessThan(count * 4);
    expect(useNodeLocked(`node-${count - 1}`)).toBe(false);
  });
});
