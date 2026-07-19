import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData, NodeGroup } from '../../src/types';

const fileMocks = vi.hoisted(() => ({
  deleteNodeFile: vi.fn(async () => undefined),
  moveToUndoTrash: vi.fn(async () => undefined),
  restoreFromUndoTrash: vi.fn(async () => undefined),
}));
const playNodeExitMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../src/services/fileService', () => ({
  ...fileMocks,
  setBaseDataDir: vi.fn(),
  syncAuthorizedDirectories: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/pollManager', () => ({
  cancelNodePolling: vi.fn(),
  clearProjectTasks: vi.fn(),
  resumePendingTasks: vi.fn(async () => undefined),
}));

vi.mock('../../src/utils/nodeAnimations', () => ({
  playNodeExit: playNodeExitMock,
}));

import { useAppStore } from '../../src/store/useAppStore';

function node(id: string): Node<BaseNodeData> {
  return {
    id,
    type: 'ai-text',
    position: { x: 0, y: 0 },
    data: { label: id, type: 'ai-text', status: 'success' },
  };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
});

describe('batch canvas history', () => {
  it('commits once and restores the whole batch with one undo', async () => {
    const nodes = [node('node-a'), node('node-b'), node('node-c')];
    const edges: Edge[] = [
      { id: 'edge-a-b', source: 'node-a', target: 'node-b' },
      { id: 'edge-b-c', source: 'node-b', target: 'node-c' },
    ];
    const groups: NodeGroup[] = [{
      id: 'group-1',
      name: 'Batch',
      nodeIds: ['node-a', 'node-b'],
      color: '#6366f1',
      createdAt: 1,
    }];
    const initialEntry = {
      nodes: nodes.map((item) => ({ ...item, data: { ...item.data } })),
      edges: edges.map((item) => ({ ...item })),
      groups: groups.map((item) => ({ ...item, nodeIds: [...item.nodeIds] })),
    };
    useAppStore.setState({
      currentProjectId: 'project-1',
      nodes,
      edges,
      groups,
      history: [initialEntry],
      historyIndex: 0,
    });
    const originalCommit = useAppStore.getState().commitToHistory;
    const commitSpy = vi.fn(() => originalCommit());
    useAppStore.setState({ commitToHistory: commitSpy });

    useAppStore.getState().deleteNodesBatch(['node-a', 'node-b']);

    await vi.waitFor(() => {
      expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['node-c']);
    });
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().history).toHaveLength(2);
    expect(useAppStore.getState().edges).toEqual([]);
    expect(useAppStore.getState().groups).toEqual([{ ...groups[0], nodeIds: [] }]);

    await useAppStore.getState().undo();

    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual([
      'node-a',
      'node-b',
      'node-c',
    ]);
    expect(useAppStore.getState().edges.map((item) => item.id)).toEqual([
      'edge-a-b',
      'edge-b-c',
    ]);
    expect(useAppStore.getState().groups).toEqual(groups);
  });
});
