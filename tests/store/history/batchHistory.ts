import { expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import type { NodeGroup } from '../../../src/types';
import { useAppStore } from '../../../src/store/useAppStore';
import { isCanvasConnectionValid } from '../../../src/store/store.nodes';
import {
  getConnectionMenuOptions,
  resolveNodeBodyHandle,
} from '../../../src/hooks/useConnectionDropMenu';
import type { HistoryFixture } from '../history.test';

export function registerBatchHistoryTests({ fileMocks, nodeExitMocks, node, directorSceneReference, groupNode, canvasNoteNode }: HistoryFixture) {
  it('undo and redo preserve the independent file created by media duplication', async () => {
    useAppStore.setState({ currentProjectId: 'p', projectLoadStatus: 'ready',
      projects: [{ id: 'p', name: '测试项目', createdAt: 1, updatedAt: 1 }], nodes: [{ ...node('source'), type: 'ai-image',
      data: { type: 'ai-image', label: 'image', filePath: 'project/original.png', imageUrl: 'asset://project/original.png' } }],
      history: [], historyIndex: -1 });
    await useAppStore.getState().duplicateNode('source');
    const clone = useAppStore.getState().nodes.find((item) => item.id !== 'source')!;
    expect(clone.data.filePath).toBe('project/copy.png');
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['source']);
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(useAppStore.getState().nodes.find((item) => item.id === clone.id)?.data.filePath).toBe('project/copy.png');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'source')?.data.filePath).toBe('project/original.png');
  });

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
    expect(fileMocks.restoreUndoTrashForHistory).toHaveBeenCalledWith('project/node-a.png', 'project-1');

    await expect(useAppStore.getState().redo()).resolves.toBe(true);

    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['node-c']);
    expect(useAppStore.getState()).toMatchObject({ historyIndex: 0 });
    expect(fileMocks.deleteNodeFiles).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ filePath: 'project/node-a.png' })]), expect.any(Set), expect.anything(), expect.any(Array),
      expect.objectContaining({ deletedNodeIds: expect.any(Array), getLiveKeepPaths: expect.any(Function) }),
    );
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
    expect(fileMocks.restoreUndoTrashForHistory).toHaveBeenCalledWith(
      'project/director/scenes/scene-history', 'project-1',
    );

    await expect(useAppStore.getState().redo()).resolves.toBe(true);
    expect(fileMocks.deleteNodeFiles).toHaveBeenCalledWith(
      [director.data], expect.any(Set), 'project-1', [],
      expect.objectContaining({ deletedNodeIds: expect.any(Array), getLiveKeepPaths: expect.any(Function) }),
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
    expect(fileMocks.deleteNodeFiles).toHaveBeenCalledWith([child.data], expect.any(Set), expect.anything(), ['Group'],
      expect.objectContaining({ deletedNodeIds: expect.any(Array), getLiveKeepPaths: expect.any(Function) }));
    expect(useAppStore.getState().edges).toEqual([]);

    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual([
      group.id,
      child.id,
      'node-b',
    ]);
    expect(useAppStore.getState().nodes[0].style).toEqual({ width: 400, height: 300 });
    expect(useAppStore.getState().groups).toEqual(groups);
    expect(fileMocks.restoreUndoTrashForHistory).toHaveBeenCalledWith('project/Group', expect.anything());

    await expect(useAppStore.getState().redo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['node-b']);
    expect(useAppStore.getState().groups).toEqual([]);
  });

  it.each(['single', 'batch', 'selection'])('deletes a whole group and restores its folder before files (%s)', async (mode) => {
    const folder = groupNode('group-folder');
    const child = { ...node('media-child', { filePath: 'project/Folder/image.png' }), parentId: folder.id };
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [folder, child],
      groups: [{ id: folder.id, name: 'Folder', nodeIds: [child.id], color: '#fff', createdAt: 0 }],
      history: [], historyIndex: -1,
    });
    if (mode === 'single') useAppStore.getState().deleteNode(folder.id);
    else if (mode === 'batch') useAppStore.getState().deleteNodesBatch([folder.id, child.id]);
    else {
      useAppStore.getState().setSelectedNodeIds([folder.id, child.id]);
      useAppStore.getState().deleteSelectedCanvasElements();
    }
    await vi.waitFor(() => expect(useAppStore.getState().nodes).toEqual([]));
    expect(fileMocks.deleteNodeFiles).toHaveBeenLastCalledWith([folder.data, child.data], expect.any(Set), 'project-1', ['Folder'],
      expect.objectContaining({ deletedNodeIds: expect.any(Array), getLiveKeepPaths: expect.any(Function) }));
    fileMocks.restoreUndoTrashForHistory.mockClear();
    await useAppStore.getState().undo();
    expect(fileMocks.restoreUndoTrashForHistory).toHaveBeenNthCalledWith(1, 'project/Folder', 'project-1');
    expect(fileMocks.restoreUndoTrashForHistory).toHaveBeenNthCalledWith(2, 'project/Folder/image.png', 'project-1');
    await useAppStore.getState().redo();
    expect(fileMocks.deleteNodeFiles).toHaveBeenLastCalledWith([folder.data, child.data], expect.any(Set), 'project-1', ['Folder'],
      expect.objectContaining({ deletedNodeIds: expect.any(Array), getLiveKeepPaths: expect.any(Function) }));
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
    expect(fileMocks.restoreUndoTrashForHistory).not.toHaveBeenCalled();

    finishStaging();
    await expect(undoResult).resolves.toBe(true);
    expect(fileMocks.restoreUndoTrashForHistory).toHaveBeenCalledWith('project/clip.mp4', 'project-1');
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
    expect(getConnectionMenuOptions('ai-video', 'input').map((option) => option.type)).toEqual([
      'ai-text',
      'ai-image',
      'ai-storyboard',
      'ai-director',
      'ai-video',
    ]);
  });

  it('offers text and video targets from generated and imported video nodes', () => {
    const targets = getConnectionMenuOptions('ai-video', 'output');
    expect(targets.map((option) => option.type)).toEqual(['ai-text', 'ai-video']);
    expect(getConnectionMenuOptions('source-video', 'output')).toEqual(targets);
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

  it('undoes RefMod bindings within the same workflow without changing model files', async () => {
    useAppStore.setState({ nodes: [node('h3', { workflowId: 'wf-a', provider: 'comfyui', model: 'comfyui/workflow' })], history: [], historyIndex: -1 });
    const reference = { endpointFingerprint: 'a'.repeat(64), loaderType: 'minimax-h3' as const, fileName: 'Alice', strength: 0.8,
      loaderNodeId: '1', slot: 1, workflowId: 'wf-a', originalFileName: '(none)', replaceExisting: true };
    useAppStore.getState().updateNodeData('h3', { comfyRefmods: [reference] });
    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes[0].data.comfyRefmods).toBeUndefined();
    await expect(useAppStore.getState().redo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes[0].data.comfyRefmods).toEqual([reference]);
  });

  it('does not transplant an old RefMod slot replacement when undo keeps the current workflow', async () => {
    const reference = { endpointFingerprint: 'a'.repeat(64), loaderType: 'minimax-h3' as const, fileName: 'Alice', strength: 1,
      loaderNodeId: '1', slot: 1, workflowId: 'wf-a', originalFileName: 'Bob', replaceExisting: true };
    useAppStore.setState({ nodes: [node('h3', { workflowId: 'wf-a', provider: 'comfyui', model: 'comfyui/workflow', comfyRefmods: [reference] })], history: [], historyIndex: -1 });
    useAppStore.getState().updateNodeData('h3', { workflowId: 'wf-b', comfyRefmods: undefined });
    await useAppStore.getState().undo();
    expect(useAppStore.getState().nodes[0].data.workflowId).toBe('wf-b');
    expect(useAppStore.getState().nodes[0].data.comfyRefmods).toBeUndefined();
  });
}
