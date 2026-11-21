import { expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../../src/types';
import { trackCanvasMediaImport } from '../../../src/services/canvasDerivationGuard';
import { executeCommand } from '../../../src/services/chat/commandRegistry';
import { useAppStore } from '../../../src/store/useAppStore';
import type { HistoryFixture } from '../history.test';

export function registerCanvasDeletionTests({ fileMocks, nodeExitMocks, node, groupNode }: HistoryFixture) {
  function holdExit() {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    nodeExitMocks.playNodeExit.mockReturnValueOnce(pending);
    return async () => { finish(); await pending; await Promise.resolve(); };
  }

  it('直接撤销仍在复制的拖入节点，重做得到已落盘的图片', async () => {
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [] });
    useAppStore.getState().addNode(node('import', { status: 'loading' }));
    let finish!: () => void;
    const work = new Promise<void>((resolve) => { finish = resolve; }).then(() =>
      useAppStore.getState().updateNodeDataTransient('import', { filePath: 'project/ready.png', status: 'success' }));
    void trackCanvasMediaImport('project-1', work, 'import');
    const undo = useAppStore.getState().undo();
    await vi.waitFor(() => expect(fileMocks.waitForPendingNodeFileDeletions).toHaveBeenCalled());
    await Promise.resolve();
    expect(useAppStore.getState().nodes).toHaveLength(1);
    finish();
    await expect(undo).resolves.toBe(true);
    expect(useAppStore.getState().nodes).toHaveLength(0);
    await expect(useAppStore.getState().redo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'success', filePath: 'project/ready.png' });
  });

  it.each(['project', 'history'])('等待导入时切换目标或产生新历史会取消原撤销（%s）', async (change) => {
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [] });
    useAppStore.getState().addNode(node('import', { status: 'loading' }));
    let finish!: () => void;
    void trackCanvasMediaImport('project-1', new Promise<void>((resolve) => { finish = resolve; }), 'import');
    try {
      const undo = useAppStore.getState().undo();
      await vi.waitFor(() => expect(fileMocks.waitForPendingNodeFileDeletions).toHaveBeenCalled());
      await Promise.resolve();
      if (change === 'project') useAppStore.setState({ currentProjectId: 'project-2' });
      else useAppStore.getState().addNode(node('new'));
      await expect(undo).resolves.toBe(false);
      expect(useAppStore.getState().nodes.map(({ id }) => id)).toContain('import');
    } finally { finish(); }
  });

  it('同批撤销遇到同名文件时保持历史位置，移走占用文件后继续还原', async () => {
    const first = node('first', { filePath: 'project/a.png' }), second = node('second', { filePath: 'project/b.png' });
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [], historyIndex: 0,
      history: [{ nodes: [first, second], edges: [], groups: [] }], showToast: vi.fn() });
    fileMocks.restoreUndoTrashForHistory.mockResolvedValueOnce('restored').mockResolvedValueOnce('occupied');
    await expect(useAppStore.getState().undo()).resolves.toBe(false);
    expect(useAppStore.getState().nodes).toHaveLength(0);
    expect(useAppStore.getState().historyIndex).toBe(0);
    expect(useAppStore.getState().showToast).toHaveBeenCalledWith(expect.stringContaining('b.png'), 'error');
    fileMocks.restoreUndoTrashForHistory.mockResolvedValueOnce('untracked').mockResolvedValueOnce('restored');
    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes.map(({ id }) => id)).toEqual(['first', 'second']);
  });

  it('does nothing for an empty selection and clears selected edges immediately before one undoable removal', async () => {
    useAppStore.setState({ nodes: [node('a'), node('b')], edges: [{ id: 'edge', source: 'a', target: 'b' }] });
    expect(useAppStore.getState().deleteSelectedCanvasElements()).toBe(false);
    expect(fileMocks.deleteNodeFiles).not.toHaveBeenCalled();
    expect(nodeExitMocks.playNodeExit).not.toHaveBeenCalled();
    expect(useAppStore.getState().history).toEqual([]);
    const finish = holdExit();
    useAppStore.setState({ edges: [{ id: 'edge', source: 'a', target: 'b', selected: true }] });
    expect(useAppStore.getState().deleteSelectedCanvasElements()).toBe(true);
    expect(useAppStore.getState().edges[0].selected).toBe(false);
    expect(useAppStore.getState().deleteSelectedCanvasElements()).toBe(false);
    await finish();
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['a', 'b']);
    expect(useAppStore.getState().edges).toEqual([]);
    expect(useAppStore.getState().history).toHaveLength(1);
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(useAppStore.getState().edges.map((edge) => edge.id)).toEqual(['edge']);
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(useAppStore.getState().edges).toEqual([]);
  });

  it.each(['selection', 'batch'] as const)('keeps the 50-root API limit separate from complete manual selections (%s)', async (mode) => {
    const nodes = Array.from({ length: 60 }, (_, index) => node(`node-${index}`));
    useAppStore.setState({ nodes: [...nodes, node('survivor')], selectedNodeIds: nodes.map((item) => item.id) });
    const commit = useAppStore.getState().commitToHistory;
    const commitSpy = vi.fn(commit);
    useAppStore.setState({ commitToHistory: commitSpy });
    const finish = holdExit();
    if (mode === 'selection') {
      expect(useAppStore.getState().deleteSelectedCanvasElements()).toBe(true);
      expect(useAppStore.getState().selectedNodeIds).toEqual([]);
    } else useAppStore.getState().deleteNodesBatch(nodes.map((item) => item.id));
    useAppStore.getState().setSelectedNodeIds(['survivor']);
    await finish();
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(mode === 'selection'
      ? ['survivor'] : [...nodes.slice(50).map((item) => item.id), 'survivor']);
    expect(useAppStore.getState().selectedNodeIds).toEqual(['survivor']);
    expect(commitSpy).toHaveBeenCalledTimes(1);
  });

  it('deletes mixed edges and the last child of a mapped group while retaining manual empty groups', async () => {
    const folder = groupNode('folder-node');
    folder.data = { ...folder.data, groupId: 'folder-record' } as unknown as BaseNodeData;
    const child = { ...node('child'), parentId: folder.id };
    const empty = groupNode('manual-empty');
    useAppStore.setState({ nodes: [folder, child, empty, node('a'), node('b')], selectedNodeIds: [child.id],
      groups: [
        { id: 'folder-record', name: 'Folder', nodeIds: [child.id], color: '#fff', createdAt: 0 },
        { id: empty.id, name: 'Empty', nodeIds: [], color: '#fff', createdAt: 0 },
      ], edges: [{ id: 'independent', source: 'a', target: 'b', selected: true },
        { id: 'folder-edge', source: folder.id, target: 'a' }],
    });
    expect(useAppStore.getState().deleteSelectedCanvasElements()).toBe(true);
    await Promise.resolve();
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual([empty.id, 'a', 'b']);
    expect(useAppStore.getState().groups.map((group) => group.id)).toEqual([empty.id]);
    expect(useAppStore.getState().edges).toEqual([]);
    expect(fileMocks.deleteNodeFiles).toHaveBeenCalledWith([child.data], expect.any(Set), expect.anything(), ['Folder'], expect.anything());
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual([folder.id, child.id, empty.id, 'a', 'b']);
  });

  it('shares file-reference protection and keeps artifact-owned media out of file staging', async () => {
    const removed = node('removed', { filePath: 'project/shared.png' });
    const artifact = node('artifact', { artifactId: 'artifact-1', filePath: 'project/artifact.png' });
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [removed, artifact,
      node('director', { directorCaptureFilePaths: ['project/shared.png'] })], selectedNodeIds: [removed.id, artifact.id] });
    useAppStore.getState().deleteSelectedCanvasElements();
    expect(fileMocks.deleteNodeFiles).toHaveBeenCalledWith([removed.data], new Set(['project/shared.png', 'project/artifact.png']),
      'project-1', [], expect.objectContaining({ deletedNodeIds: [removed.id, artifact.id] }));
    await Promise.resolve();
  });

  it.each(['single', 'selection', 'group'] as const)('stages the completed import and restores it on immediate undo (%s)', async (mode) => {
    const group = groupNode('folder');
    const child = { ...node('incoming', { status: 'loading' }), parentId: group.id };
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [group, child], selectedNodeIds: [child.id] });
    useAppStore.getState().commitToHistory();
    let finish!: () => void;
    const copy = new Promise<void>((resolve) => { finish = resolve; }).then(() => {
      useAppStore.getState().updateNodeDataTransient(child.id, { filePath: 'project/import.png', status: 'success' });
    });
    void trackCanvasMediaImport('project-1', copy, child.id);
    if (mode === 'single') useAppStore.getState().deleteNode(child.id);
    else if (mode === 'selection') useAppStore.getState().deleteSelectedCanvasElements();
    else useAppStore.getState().deleteNodesBatch([group.id]);
    expect(fileMocks.deleteNodeFiles).not.toHaveBeenCalled();
    expect(useAppStore.getState().history).toHaveLength(1);
    const undo = useAppStore.getState().undo();
    finish();
    expect(await undo).toBe(true);
    expect(fileMocks.deleteNodeFiles.mock.calls[0][0]).toContainEqual(expect.objectContaining({ filePath: 'project/import.png' }));
    expect(useAppStore.getState().nodes.find((item) => item.id === child.id)?.data).toMatchObject({
      status: 'success', filePath: 'project/import.png',
    });
    expect(fileMocks.restoreUndoTrashForHistory).toHaveBeenCalledWith('project/import.png', 'project-1');
    expect(useAppStore.getState().history).toHaveLength(2);
  });

  it.each(['switch-back', 'reused-node'] as const)('cancels a delayed deletion when its target changes (%s)', async (boundary) => {
    const child = node('incoming', { status: 'loading' });
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [child] });
    let finish!: () => void;
    void trackCanvasMediaImport('project-1', new Promise<void>((resolve) => { finish = resolve; }), child.id);
    useAppStore.getState().deleteNode(child.id);
    if (boundary === 'switch-back') useAppStore.setState({ currentProjectId: 'other' });
    else useAppStore.setState({ nodes: [] });
    const replacement = node(child.id, { filePath: 'project/replacement.png' });
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [replacement] });
    finish();
    await nodeExitMocks.waitForPendingNodeExits();
    expect(fileMocks.deleteNodeFiles).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes).toEqual([replacement]);
  });

  it.each([false, true])('等待导入的删除命令在原画布版本上完成，版本变化则保留节点：%s', async (changeRevision) => {
    const child = node('incoming', { status: 'loading' });
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [child] });
    let finish!: () => void;
    void trackCanvasMediaImport('project-1', new Promise<void>((resolve) => { finish = resolve; }), child.id);
    const result = executeCommand({ id: 'delete', commandId: 'deleteNodes', projectId: 'project-1',
      baseRevision: useAppStore.getState().getCurrentRevision(), targetNodeIds: [child.id],
      params: {}, summary: '删除拖入的图片', risk: 'destructive', requiresConfirm: false });
    if (changeRevision) useAppStore.getState().incrementRevision();
    else useAppStore.getState().updateNodeDataTransient(child.id, { status: 'success', filePath: 'project/copied.png' });
    finish();
    expect((await result).status).toBe(changeRevision ? 'rejected' : 'success');
    expect(useAppStore.getState().nodes.some((item) => item.id === child.id)).toBe(changeRevision);
  });

  it('ignores unrelated imports and removes a failed placeholder without staging the external source', async () => {
    let fail!: () => void;
    const failedCopy = new Promise<void>((_resolve, reject) => { fail = () => reject(new Error('copy failed')); });
    const imported = node('incoming', { status: 'loading' });
    const ready = node('ready', { filePath: 'project/ready.png' });
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [imported, ready] });
    void trackCanvasMediaImport('project-1', failedCopy, imported.id);
    useAppStore.getState().deleteNode(ready.id);
    expect(fileMocks.deleteNodeFiles.mock.calls[0][0]).toEqual([ready.data]);
    await Promise.resolve();
    useAppStore.getState().deleteNode(imported.id);
    expect(fileMocks.deleteNodeFiles).toHaveBeenCalledTimes(1);
    fail();
    await nodeExitMocks.waitForPendingNodeExits();
    expect(useAppStore.getState().nodes).toEqual([]);
    expect(fileMocks.deleteNodeFiles.mock.calls[1][0].every((item) => item.filePath === undefined)).toBe(true);
  });

  it.each(['undo', 'redo'] as const)('keeps queued %s out of a switched and reopened canvas', async (action) => {
    const child = node('incoming', { status: 'loading' });
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [child] });
    let finish!: () => void;
    void trackCanvasMediaImport('project-1', new Promise<void>((resolve) => { finish = resolve; }), child.id);
    useAppStore.getState().deleteNode(child.id);
    const transition = useAppStore.getState()[action]();
    await Promise.resolve();
    useAppStore.setState({ currentProjectId: 'other' });
    const replacement = node('replacement');
    const replacementHistory = [[], [replacement], []].map((nodes) => ({ nodes, groups: [], edges: [] }));
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [replacement], history: replacementHistory, historyIndex: 0 });
    try {
      expect(await transition).toBe(false);
      expect(useAppStore.getState().history).toBe(replacementHistory);
      expect(useAppStore.getState().nodes).toEqual([replacement]);
    } finally { finish(); }
  });

  it.each(['switch-back', 'import', 'exchange-epoch', 'native-runtime'] as const)('rejects a stale exit after same-ID canvas replacement (%s)', async (boundary) => {
    const original = node('same-id', { label: 'old' });
    const replacement = node('same-id', { label: 'replacement' });
    const context = { kind: 'canvas' as const, schemaVersion: 2 as const, modelGeneration: 1, runtimeEpoch: 'old-runtime',
      projectId: 'owner', projectEpoch: 1, canvasId: 'project-1', canvasEpoch: 1, canvasRevision: 1, episodeId: null };
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [original],
      projects: [{ id: 'project-1', name: 'Project', createdAt: 1, updatedAt: 1, exchangeEpoch: 1 }],
      ...(boundary === 'native-runtime' ? { projectExecutionContext: context } : {}) });
    const finish = holdExit();
    useAppStore.getState().deleteNode(original.id);
    const fileContext = fileMocks.deleteNodeFiles.mock.calls[0][4]!;
    if (boundary === 'switch-back') {
      useAppStore.setState({ currentProjectId: 'other' });
      useAppStore.setState({ currentProjectId: 'project-1', nodes: [replacement] });
    } else if (boundary === 'import') useAppStore.setState({ nodes: [replacement], history: [], historyIndex: -1 });
    else if (boundary === 'exchange-epoch') useAppStore.setState({ nodes: [replacement], projects: [
      { id: 'project-1', name: 'Project', createdAt: 1, updatedAt: 1, exchangeEpoch: 2 },
    ] });
    else useAppStore.setState({ nodes: [replacement], projectExecutionContext: { ...context, runtimeEpoch: 'new-runtime' } });
    expect(fileContext.getLiveKeepPaths()).toBeNull();
    await finish();
    expect(useAppStore.getState().nodes).toEqual([replacement]);
  });

  it('does not delete a replacement that reuses an ID after the original leaves the canvas', async () => {
    useAppStore.setState({ nodes: [node('same-id')] });
    const finish = holdExit();
    useAppStore.getState().deleteNode('same-id');
    useAppStore.setState({ nodes: [] });
    const replacement = node('same-id', { label: 'new incarnation' });
    useAppStore.setState({ nodes: [replacement] });
    await finish();
    expect(useAppStore.getState().nodes).toEqual([replacement]);
  });

  it.each(['undo', 'redo'] as const)('keeps already-restored same-ID nodes when an old exit finishes after %s', async (transition) => {
    useAppStore.setState({ nodes: [node('same-id')] });
    useAppStore.getState().commitToHistory();
    useAppStore.getState().updateNodePositionTransient('same-id', { x: 100, y: 20 });
    const finish = holdExit();
    useAppStore.getState().deleteNode('same-id');
    expect(await useAppStore.getState().undo()).toBe(true);
    if (transition === 'redo') expect(await useAppStore.getState().redo()).toBe(true);
    const restored = useAppStore.getState().nodes;
    await finish();
    expect(useAppStore.getState().nodes).toEqual(restored);
    expect(useAppStore.getState().nodes[0].position).toEqual(transition === 'undo' ? { x: 0, y: 0 } : { x: 100, y: 20 });
  });

  it('allows progress, geometry, revision changes and history prefix trimming while preserving a new selection', async () => {
    useAppStore.setState({ nodes: [node('removed'), node('survivor')], selectedNodeIds: ['removed'] });
    const finish = holdExit();
    useAppStore.getState().deleteSelectedCanvasElements();
    useAppStore.getState().updateNodeDataTransient('removed', { status: 'loading', mediaTaskStage: 'querying' });
    for (let index = 1; index <= 60; index += 1) {
      useAppStore.getState().updateNodePositionTransient('survivor', { x: index, y: 0 });
      useAppStore.getState().commitToHistory();
      useAppStore.getState().incrementRevision();
    }
    useAppStore.getState().setSelectedNodeIds(['survivor']);
    await finish();
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['survivor']);
    expect(useAppStore.getState().nodes[0].position).toEqual({ x: 60, y: 0 });
    expect(useAppStore.getState().selectedNodeIds).toEqual(['survivor']);
  });

  it('invalidates file staging after synchronous exit setup failure and still supports a later deletion', async () => {
    useAppStore.setState({ nodes: [node('removed')] });
    nodeExitMocks.playNodeExit.mockImplementationOnce(() => { throw new Error('exit setup failed'); });
    expect(() => useAppStore.getState().deleteNode('removed')).toThrow('exit setup failed');
    expect(fileMocks.deleteNodeFiles.mock.calls[0][4]!.getLiveKeepPaths()).toBeNull();
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['removed']);
    useAppStore.getState().deleteNode('removed');
    await Promise.resolve();
    expect(useAppStore.getState().nodes).toEqual([]);
  });

  it('completes deletion if the exit promise rejects', async () => {
    useAppStore.setState({ nodes: [node('removed')] });
    nodeExitMocks.playNodeExit.mockRejectedValueOnce(new Error('exit failed'));
    useAppStore.getState().deleteNode('removed');
    await Promise.resolve();
    expect(useAppStore.getState().nodes).toEqual([]);
  });

  it('finishes independent overlapping deletions without cancelling either operation', async () => {
    useAppStore.setState({ nodes: [node('a'), node('b'), node('c')] });
    const finishFirst = holdExit();
    useAppStore.getState().deleteNode('a');
    const finishSecond = holdExit();
    useAppStore.getState().deleteNodesBatch(['a', 'b']);
    await finishFirst();
    await finishSecond();
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['c']);
  });
}
