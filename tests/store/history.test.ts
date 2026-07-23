import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData, NodeGroup } from '../../src/types';

const fileMocks = vi.hoisted(() => ({
  deleteNodeFile: vi.fn(async () => undefined),
  moveToUndoTrash: vi.fn(async () => undefined),
  restoreFromUndoTrash: vi.fn(async () => undefined),
}));
const nodeExitMocks = vi.hoisted(() => {
  const pending = new Set<Promise<void>>();
  return {
    pending,
    playNodeExit: vi.fn<(_ids: string[]) => Promise<void>>(async () => undefined),
    waitForPendingNodeExits: vi.fn(async () => {
      await Promise.allSettled([...pending]);
      await Promise.resolve();
    }),
  };
});

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
  playNodeExit: nodeExitMocks.playNodeExit,
  waitForPendingNodeExits: nodeExitMocks.waitForPendingNodeExits,
}));

import { useAppStore } from '../../src/store/useAppStore';

function node(id: string, data: Partial<BaseNodeData> = {}): Node<BaseNodeData> {
  return {
    id,
    type: 'ai-text',
    position: { x: 0, y: 0 },
    data: { label: id, type: 'ai-text', status: 'success', ...data },
  };
}

function groupNode(id: string): Node<BaseNodeData> {
  return {
    id,
    type: 'group',
    position: { x: 40, y: 60 },
    data: {
      label: 'Group',
      type: 'comment',
      status: 'success',
      groupId: id,
      color: '#6366f1',
    } as unknown as BaseNodeData,
    style: { width: 400, height: 300 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nodeExitMocks.pending.clear();
  nodeExitMocks.playNodeExit.mockResolvedValue(undefined);
  useAppStore.setState(useAppStore.getInitialState(), true);
});

describe('batch canvas history', () => {
  it('restores the first deleted batch with one undo and supports redo', async () => {
    const nodes = [
      node('node-a', { filePath: 'project/node-a.png' }),
      node('node-b'),
      node('node-c'),
    ];
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
    useAppStore.setState({
      currentProjectId: 'project-1',
      nodes,
      edges,
      groups,
      history: [],
      historyIndex: -1,
    });
    const originalCommit = useAppStore.getState().commitToHistory;
    const commitSpy = vi.fn(() => originalCommit());
    useAppStore.setState({ commitToHistory: commitSpy });

    useAppStore.getState().deleteNodesBatch(['node-a', 'node-b']);

    await vi.waitFor(() => {
      expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['node-c']);
    });
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState()).toMatchObject({ historyIndex: 0 });
    expect(useAppStore.getState().history).toHaveLength(1);
    expect(useAppStore.getState().edges).toEqual([]);
    expect(useAppStore.getState().groups).toEqual([]);

    await expect(useAppStore.getState().undo()).resolves.toBe(true);

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
    expect(useAppStore.getState()).toMatchObject({ historyIndex: -1 });
    expect(fileMocks.restoreFromUndoTrash).toHaveBeenCalledWith('project/node-a.png');

    await expect(useAppStore.getState().redo()).resolves.toBe(true);

    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['node-c']);
    expect(useAppStore.getState()).toMatchObject({ historyIndex: 0 });
    expect(fileMocks.moveToUndoTrash).toHaveBeenCalledWith('project/node-a.png');
    await expect(useAppStore.getState().redo()).resolves.toBe(false);
  });

  it('removes an empty group with its last child and restores both through history', async () => {
    const group = groupNode('group-1');
    const child = { ...node('node-a'), parentId: group.id };
    const groups: NodeGroup[] = [{
      id: group.id,
      name: 'Group',
      nodeIds: [child.id],
      color: '#6366f1',
      createdAt: 1,
    }];
    useAppStore.setState({
      nodes: [group, child, node('node-b')],
      edges: [{ id: 'edge-group', source: group.id, target: 'node-b' }],
      groups,
      history: [],
      historyIndex: -1,
    });

    useAppStore.getState().deleteNode(child.id);

    await vi.waitFor(() => {
      expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['node-b']);
    });
    expect(useAppStore.getState().groups).toEqual([]);
    expect(useAppStore.getState().edges).toEqual([]);

    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual([
      group.id,
      child.id,
      'node-b',
    ]);
    expect(useAppStore.getState().nodes[0].style).toEqual({ width: 400, height: 300 });
    expect(useAppStore.getState().groups).toEqual(groups);

    await expect(useAppStore.getState().redo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['node-b']);
    expect(useAppStore.getState().groups).toEqual([]);
  });

  it('removes an empty group when React Flow removes its last child', () => {
    const group = groupNode('group-1');
    const child = { ...node('node-a'), parentId: group.id };
    useAppStore.setState({
      nodes: [group, child],
      groups: [{
        id: group.id,
        name: 'Group',
        nodeIds: [child.id],
        color: '#6366f1',
        createdAt: 1,
      }],
      history: [],
      historyIndex: -1,
    });

    useAppStore.getState().onNodesChange([{ type: 'remove', id: child.id }]);

    expect(useAppStore.getState().nodes).toEqual([]);
    expect(useAppStore.getState().groups).toEqual([]);
    expect(useAppStore.getState().history).toHaveLength(1);
  });

  it('waits for a pending exit before restoring a quickly undone deletion', async () => {
    let finishExit!: () => void;
    const rawExit = new Promise<void>((resolve) => {
      finishExit = resolve;
    });
    const trackedExit = rawExit.finally(() => nodeExitMocks.pending.delete(trackedExit));
    nodeExitMocks.pending.add(trackedExit);
    nodeExitMocks.playNodeExit.mockReturnValueOnce(trackedExit);
    useAppStore.setState({ nodes: [node('node-a')], history: [], historyIndex: -1 });

    useAppStore.getState().deleteNode('node-a');
    const undoResult = useAppStore.getState().undo();

    await vi.waitFor(() => {
      expect(nodeExitMocks.waitForPendingNodeExits).toHaveBeenCalled();
    });
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['node-a']);

    finishExit();
    await expect(undoResult).resolves.toBe(true);

    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['node-a']);
    expect(useAppStore.getState()).toMatchObject({ historyIndex: -1 });
  });

  it('serializes rapid history commands without skipping states', async () => {
    useAppStore.setState({ nodes: [node('node-a', { label: 'A' })], history: [], historyIndex: -1 });
    useAppStore.getState().updateNodeData('node-a', { label: 'B' });
    useAppStore.getState().updateNodeData('node-a', { label: 'C' });

    await expect(Promise.all([
      useAppStore.getState().undo(),
      useAppStore.getState().undo(),
    ])).resolves.toEqual([true, true]);
    expect(useAppStore.getState().nodes[0].data.label).toBe('A');

    await expect(Promise.all([
      useAppStore.getState().redo(),
      useAppStore.getState().redo(),
    ])).resolves.toEqual([true, true]);
    expect(useAppStore.getState().nodes[0].data.label).toBe('C');
  });

  it('skips duplicate end-of-operation snapshots instead of creating a no-op undo', async () => {
    useAppStore.setState({ nodes: [node('node-a', { label: 'A' })], history: [], historyIndex: -1 });
    useAppStore.getState().commitToHistory();
    useAppStore.setState({ nodes: [node('node-a', { label: 'B' })] });
    useAppStore.getState().commitToHistory();

    await expect(useAppStore.getState().undo()).resolves.toBe(true);

    expect(useAppStore.getState().nodes[0].data.label).toBe('A');
    expect(useAppStore.getState().historyIndex).toBe(-1);
  });
});
