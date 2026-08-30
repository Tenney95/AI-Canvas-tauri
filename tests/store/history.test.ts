import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData, NodeGroup } from '../../src/types';
import { createCanvasNoteData } from '../../src/types';

const fileMocks = vi.hoisted(() => ({
  collectNodeFileReferences: vi.fn((data: BaseNodeData) => {
    const references = new Set<string>();
    if (data.filePath) references.add(data.filePath);
    for (const path of data.directorCaptureFilePaths ?? []) references.add(path);
    if (data.directorScene?.sceneId) references.add(`director-scene:${data.directorScene.sceneId}`);
    if (data.directorResultManifest?.sceneId) {
      references.add(`director-scene:${data.directorResultManifest.sceneId}`);
    }
    return references;
  }),
  deleteNodeFile: vi.fn(async () => undefined),
  moveToUndoTrash: vi.fn(async () => undefined),
  resolveNodeUndoTrashPaths: vi.fn(async (data: BaseNodeData) => {
    const sceneId = data.directorScene?.sceneId ?? data.directorResultManifest?.sceneId;
    if (sceneId) return [`project/director/scenes/${sceneId}`];
    return data.filePath ? [data.filePath] : [];
  }),
  restoreFromUndoTrash: vi.fn(async () => undefined),
  // 重做前会先确认文件属于当前项目，默认放行以保持既有断言
  isProjectOwnedFile: vi.fn(async () => true),
  // 撤销前要等文件暂存落定，默认立即完成
  waitForPendingNodeFileDeletions: vi.fn(async () => undefined),
  isFileMissing: vi.fn(async () => false),
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
import { isCanvasConnectionValid } from '../../src/store/store.nodes';
import {
  getConnectionMenuOptions,
  resolveNodeBodyHandle,
} from '../../src/hooks/useConnectionDropMenu';

function node(id: string, data: Partial<BaseNodeData> = {}): Node<BaseNodeData> {
  return {
    id,
    type: 'ai-text',
    position: { x: 0, y: 0 },
    data: { label: id, type: 'ai-text', status: 'success', ...data },
  };
}

function directorSceneReference(sceneId = 'scene-main') {
  return {
    schemaVersion: 1 as const,
    sceneId,
    revision: 1,
    relativePath: `director/scenes/${sceneId}/scene-r1-${'a'.repeat(64)}.json`,
    sha256: 'a'.repeat(64),
    bytes: 128,
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

function canvasNoteNode(id: string): Node<BaseNodeData> {
  const note = createCanvasNoteData('rectangle', { width: 160, height: 100 });
  return {
    id,
    type: 'canvas-note',
    position: { x: 10, y: 20 },
    data: {
      label: '矩形笔记',
      type: 'canvas-note',
      note,
      nodeWidth: note.width,
      nodeHeight: note.height,
    },
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

  it('restores and re-trashes a deleted Blender Director scene bundle through history', async () => {
    const director = {
      ...node('director-1', {
        type: 'ai-director',
        directorScene: directorSceneReference('scene-history'),
      }),
      type: 'ai-director',
    };
    useAppStore.setState({
      currentProjectId: 'project-1',
      nodes: [director],
      history: [],
      historyIndex: -1,
    });

    useAppStore.getState().deleteNode(director.id);
    await vi.waitFor(() => expect(useAppStore.getState().nodes).toEqual([]));

    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(fileMocks.restoreFromUndoTrash).toHaveBeenCalledWith(
      'project/director/scenes/scene-history',
    );

    await expect(useAppStore.getState().redo()).resolves.toBe(true);
    expect(fileMocks.moveToUndoTrash).toHaveBeenCalledWith(
      'project/director/scenes/scene-history',
    );
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

  it('waits for the file staging to settle before restoring media', async () => {
    let finishStaging!: () => void;
    const staging = new Promise<undefined>((resolve) => { finishStaging = () => resolve(undefined); });
    fileMocks.waitForPendingNodeFileDeletions.mockReturnValueOnce(staging);
    useAppStore.setState({
      currentProjectId: 'project-1',
      nodes: [node('node-a', { filePath: 'project/clip.mp4' })],
      history: [],
      historyIndex: -1,
    });

    useAppStore.getState().deleteNode('node-a');
    await vi.waitFor(() => {
      expect(useAppStore.getState().nodes).toEqual([]);
    });

    const undoResult = useAppStore.getState().undo();
    // 放掉足够多的微任务，让 undo 跑到「文件还原」那一步为止
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    // 暂存还没落定，此时还原会扑空——文件随后才被搬走，节点复活也是死的
    expect(fileMocks.restoreFromUndoTrash).not.toHaveBeenCalled();

    finishStaging();
    await expect(undoResult).resolves.toBe(true);
    expect(fileMocks.restoreFromUndoTrash).toHaveBeenCalledWith('project/clip.mp4');
  });

  it('undoes and redoes a node move from the gesture start position', async () => {
    useAppStore.setState({
      nodes: [node('node-a', { label: 'A', nodeWidth: 280, nodeHeight: 160 })],
      history: [],
      historyIndex: -1,
    });
    useAppStore.getState().commitToHistory();
    useAppStore.setState({
      nodes: [{
        ...useAppStore.getState().nodes[0],
        position: { x: 120, y: 80 },
        data: { ...useAppStore.getState().nodes[0].data, label: 'Current' },
      }],
    });

    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes[0]).toMatchObject({
      position: { x: 0, y: 0 },
      data: { label: 'Current' },
    });

    await expect(useAppStore.getState().redo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes[0]).toMatchObject({
      position: { x: 120, y: 80 },
      data: { label: 'Current' },
    });
  });

  it('undoes and redoes a node resize from the gesture start size', async () => {
    useAppStore.setState({
      nodes: [node('node-a', { nodeWidth: 280, nodeHeight: 160 })],
      history: [],
      historyIndex: -1,
    });
    useAppStore.getState().commitToHistory();
    useAppStore.setState({
      nodes: [{
        ...useAppStore.getState().nodes[0],
        data: {
          ...useAppStore.getState().nodes[0].data,
          nodeWidth: 420,
          nodeHeight: 260,
        },
      }],
    });
    useAppStore.getState().commitToHistory();

    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({
      nodeWidth: 280,
      nodeHeight: 160,
    });

    await expect(useAppStore.getState().redo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({
      nodeWidth: 420,
      nodeHeight: 260,
    });
  });

  it('undoes and redoes React Flow style dimensions', async () => {
    useAppStore.setState({ nodes: [groupNode('group-a')], history: [], historyIndex: -1 });
    useAppStore.getState().commitToHistory();
    useAppStore.setState({
      nodes: [{ ...useAppStore.getState().nodes[0], style: { width: 520, height: 360 } }],
    });
    useAppStore.getState().commitToHistory();

    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes[0].style).toMatchObject({ width: 400, height: 300 });

    await expect(useAppStore.getState().redo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes[0].style).toMatchObject({ width: 520, height: 360 });
  });

  it('undoes node creation without reverting existing node layout or data', async () => {
    useAppStore.setState({ nodes: [node('node-a', { label: 'A', nodeWidth: 280 })], history: [], historyIndex: -1 });
    useAppStore.getState().addNode(node('node-b'));
    useAppStore.setState({
      nodes: useAppStore.getState().nodes.map((item) => item.id === 'node-a'
        ? { ...item, position: { x: 75, y: 90 }, data: { ...item.data, label: 'Current', nodeWidth: 440 } }
        : item),
    });

    await expect(useAppStore.getState().undo()).resolves.toBe(true);

    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['node-a']);
    expect(useAppStore.getState().nodes[0]).toMatchObject({
      position: { x: 75, y: 90 },
      data: { label: 'Current', nodeWidth: 440 },
    });
    expect(useAppStore.getState().historyIndex).toBe(-1);
  });

  it('undoes an edge creation while keeping current node data', async () => {
    useAppStore.setState({
      nodes: [node('node-a', { label: 'A' }), node('node-b')],
      edges: [],
      history: [],
      historyIndex: -1,
    });
    useAppStore.getState().onConnect({
      source: 'node-a',
      target: 'node-b',
      sourceHandle: null,
      targetHandle: null,
    });
    useAppStore.setState({
      nodes: useAppStore.getState().nodes.map((item) => item.id === 'node-a'
        ? { ...item, data: { ...item.data, label: 'Current' } }
        : item),
    });

    await expect(useAppStore.getState().undo()).resolves.toBe(true);

    expect(useAppStore.getState().edges).toEqual([]);
    expect(useAppStore.getState().nodes[0].data.label).toBe('Current');
  });

  it('normalizes loose connections to right-side output and left-side input', () => {
    useAppStore.setState({
      nodes: [node('node-a'), node('node-b')],
      edges: [],
      history: [],
      historyIndex: -1,
    });

    // 用户从 A 的左侧输入端拖到 B 的右侧输出端，React Flow 会把拖拽起点暂记为 source。
    useAppStore.getState().onConnect({
      source: 'node-a',
      target: 'node-b',
      sourceHandle: 'left',
      targetHandle: 'right',
    });

    expect(useAppStore.getState().edges).toEqual([
      expect.objectContaining({
        source: 'node-b',
        sourceHandle: 'right',
        target: 'node-a',
        targetHandle: 'left',
      }),
    ]);

    useAppStore.getState().onConnect({
      source: 'node-a',
      target: 'node-b',
      sourceHandle: 'left',
      targetHandle: 'left',
    });
    expect(useAppStore.getState().edges).toHaveLength(1);
  });

  it('uses the same handle roles for drag validation and node-body drops', () => {
    expect(isCanvasConnectionValid({
      source: 'node-a', target: 'node-b', sourceHandle: 'right', targetHandle: 'left',
    })).toBe(true);
    expect(isCanvasConnectionValid({
      source: 'node-a', target: 'node-b', sourceHandle: 'left', targetHandle: 'right',
    })).toBe(true);
    expect(isCanvasConnectionValid({
      source: 'node-a', target: 'node-b', sourceHandle: 'right', targetHandle: 'right',
    })).toBe(false);
    expect(resolveNodeBodyHandle(149, 100, 100)).toBe('left');
    expect(resolveNodeBodyHandle(150, 100, 100)).toBe('right');
  });

  it('offers upstream node types when a connection starts from an input handle', () => {
    expect(getConnectionMenuOptions('ai-video', 'output')).toEqual([]);
    expect(getConnectionMenuOptions('ai-video', 'input').map((option) => option.type)).toEqual([
      'ai-text',
      'ai-image',
      'ai-storyboard',
      'ai-director',
    ]);
  });

  it('offers downstream node types from library reference images', () => {
    expect(getConnectionMenuOptions('source-image', 'output')).toEqual(
      getConnectionMenuOptions('ai-image', 'output'),
    );
  });

  it('treats storyboard cell state as structural history', async () => {
    useAppStore.setState({
      nodes: [node('storyboard', {
        type: 'ai-storyboard',
        label: 'Before',
        storyboardExtracted: [false],
      })],
      history: [],
      historyIndex: -1,
    });
    useAppStore.getState().commitToHistory();
    useAppStore.setState({
      nodes: [{
        ...useAppStore.getState().nodes[0],
        data: {
          ...useAppStore.getState().nodes[0].data,
          label: 'Current',
          storyboardExtracted: [true],
        },
      }],
    });
    useAppStore.getState().commitToHistory();

    await expect(useAppStore.getState().undo()).resolves.toBe(true);

    expect(useAppStore.getState().nodes[0].data).toMatchObject({
      label: 'Current',
      storyboardExtracted: [false],
    });
  });

  it('undoes canvas note geometry and style without changing AI node history semantics', async () => {
    const note = canvasNoteNode('note-a');
    useAppStore.setState({ nodes: [note], history: [], historyIndex: -1 });

    expect(useAppStore.getState().updateCanvasNote('note-a', {
      width: 240,
      height: 140,
      style: { strokeColor: '#ef4444', opacity: 60 },
    })).toBe(true);
    useAppStore.getState().updateNodePositionTransient('note-a', { x: 80, y: 90 });

    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes[0]).toMatchObject({
      position: { x: 10, y: 20 },
      data: {
        note: {
          width: 160,
          height: 100,
          style: { strokeColor: 'var(--theme-text)', opacity: 100 },
        },
      },
    });

    await expect(useAppStore.getState().redo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes[0]).toMatchObject({
      position: { x: 80, y: 90 },
      data: {
        note: {
          width: 240,
          height: 140,
          style: { strokeColor: '#ef4444', opacity: 60 },
        },
      },
    });
  });

  it('moves canvas notes through the shared layer order with one undo step', async () => {
    useAppStore.setState({
      nodes: [node('ai-a'), canvasNoteNode('note-a'), node('ai-b')],
      history: [],
      historyIndex: -1,
    });

    expect(useAppStore.getState().moveCanvasNoteLayer('note-a', 'front')).toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['ai-a', 'ai-b', 'note-a']);

    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['ai-a', 'note-a', 'ai-b']);
  });

  it('converts image nodes and image notes in place with undo support', async () => {
    useAppStore.setState({
      nodes: [{
        ...node('image-a', {
          type: 'ai-image',
          role: 'source',
          imageUrl: 'asset://image-a.png',
          filePath: '/project/image-a.png',
          nodeWidth: 360,
          nodeHeight: 240,
        }),
        type: 'ai-image',
        position: { x: 30, y: 40 },
        draggable: false,
      }],
      history: [],
      historyIndex: -1,
    });

    expect(useAppStore.getState().convertImageNodeKind('image-a')).toBe('to-note');
    expect(useAppStore.getState().nodes[0]).toMatchObject({
      id: 'image-a',
      type: 'canvas-note',
      position: { x: 30, y: 40 },
      draggable: false,
      data: {
        type: 'canvas-note',
        imageUrl: 'asset://image-a.png',
        filePath: '/project/image-a.png',
        note: { kind: 'image', width: 360, height: 240 },
      },
    });

    expect(useAppStore.getState().convertImageNodeKind('image-a')).toBe('to-node');
    expect(useAppStore.getState().nodes[0]).toMatchObject({
      type: 'ai-image',
      data: {
        type: 'ai-image',
        role: 'source',
        imageUrl: 'asset://image-a.png',
        nodeWidth: 360,
        nodeHeight: 240,
      },
    });
    expect(useAppStore.getState().nodes[0].data.note).toBeUndefined();

    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes[0]).toMatchObject({
      type: 'canvas-note',
      data: { note: { kind: 'image', width: 360, height: 240 } },
    });
  });

  it('does not convert a connected image node or create history', () => {
    useAppStore.setState({
      nodes: [
        { ...node('image-a', { type: 'ai-image', imageUrl: 'asset://image-a.png' }), type: 'ai-image' },
        node('target'),
      ],
      edges: [{ id: 'edge-a', source: 'image-a', target: 'target' }],
      history: [],
      historyIndex: -1,
    });

    expect(useAppStore.getState().convertImageNodeKind('image-a')).toBe('connected');
    expect(useAppStore.getState().nodes[0].type).toBe('ai-image');
    expect(useAppStore.getState().history).toEqual([]);
  });

  it('undoes and redoes character-library node hiding with its association', async () => {
    useAppStore.setState({
      nodes: [node('character-image', { type: 'ai-image', imageUrl: 'asset://character.png' })],
      history: [],
      historyIndex: -1,
    });

    expect(useAppStore.getState().linkNodeToCharacter('character-image', {
      scope: 'project',
      characterId: 'character-1',
      referenceImageId: 'reference-1',
    }, true)).toBe(true);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({
      hiddenByCharacterLibrary: true,
      characterLibraryLinks: [{
        scope: 'project',
        characterId: 'character-1',
        referenceImageId: 'reference-1',
      }],
    });

    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).toBeUndefined();
    expect(useAppStore.getState().nodes[0].data.characterLibraryLinks).toBeUndefined();

    await expect(useAppStore.getState().redo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes[0].data.hiddenByCharacterLibrary).toBe(true);
    expect(useAppStore.getState().nodes[0].data.characterLibraryLinks).toEqual([{
      scope: 'project',
      characterId: 'character-1',
      referenceImageId: 'reference-1',
    }]);
  });
});
