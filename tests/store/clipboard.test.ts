/**
 * clipboard — 回归测试：canvas clipboard。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { createCanvasNoteData, type BaseNodeData, type NodeType } from '../../src/types';

const fileMocks = vi.hoisted(() => ({
  copyFileToProjectData: vi.fn(),
  moveToUndoTrash: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/fileService', () => ({
  ...fileMocks,
  setBaseDataDir: vi.fn(),
  syncAuthorizedDirectories: vi.fn(async () => undefined),
  waitForPendingNodeFileDeletions: vi.fn(async () => undefined),
  resolveGroupUndoTrashPaths: vi.fn(async () => []),
  resolveNodeUndoTrashPaths: vi.fn(async () => []),
  collectNodeFileReferences: vi.fn(() => new Set<string>()),
  deleteNodeFiles: vi.fn(async () => undefined),
  deletedGroupFolderNames: vi.fn(() => []),
}));

vi.mock('../../src/services/pollManager', () => ({
  cancelNodePolling: vi.fn(),
  clearProjectTasks: vi.fn(),
  resumePendingTasks: vi.fn(async () => undefined),
}));

import { useAppStore } from '../../src/store/useAppStore';
import { createNodeDuplicateDrag } from '../../src/store/store.nodes';

function node(id: string): Node<BaseNodeData> {
  return {
    id,
    type: 'ai-text',
    position: { x: 0, y: 0 },
    data: { label: id, type: 'ai-text', status: 'success' },
  };
}

function mediaNode(id: string, projectId: string): Node<BaseNodeData> {
  return {
    id,
    type: 'ai-image',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: 'ai-image',
      status: 'success',
      filePath: `/data/${projectId}/original.png`,
      relativePath: 'original.png',
      assetId: 'asset-from-source-project',
      imageUrl: `asset:///data/${projectId}/original.png`,
      thumbnailUrl: `asset:///data/${projectId}/original.png`,
    },
  };
}

function directorNode(
  id: string,
  runtime: 'lightweight-web' | 'blender',
  status: 'loading' | 'error',
): Node<BaseNodeData> {
  return {
    id,
    type: 'ai-director',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: 'ai-director',
      role: 'source',
      status,
      error: '源节点的瞬时错误',
      directorRuntimeKind: runtime,
      directorInstanceId: id,
      directorStatus: 'ready',
      directorCaptureUrls: ['asset:///director/frame-a.png'],
      directorCaptureFilePaths: ['/data/project-a/frame-a.png'],
      imageUrl: 'asset:///director/frame-a.png',
      thumbnailUrl: 'asset:///director/frame-a.png',
      videoUrl: 'asset:///director/reference.mp4',
      filePath: '/data/project-a/reference.mp4',
    },
  };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ projectLoadStatus: 'ready', projects: ['a', 'b', 'project-a', 'project-b']
    .map((id) => ({ id, name: id, createdAt: 1, updatedAt: 1 })) });
  fileMocks.copyFileToProjectData.mockReset();
  fileMocks.copyFileToProjectData.mockImplementation(async (_source: string, projectId: string) => ({
    filePath: `/data/${projectId}/copied.png`,
    assetUrl: `asset:///data/${projectId}/copied.png`,
    fileName: 'copied.png',
  }));
});

describe('canvas clipboard', () => {
  it('copies nested descendants once for overlapping group selections', () => {
    const root = { ...node('root'), type: 'group' };
    const child = { ...node('child'), type: 'group', parentId: root.id };
    const leaf = { ...node('leaf'), parentId: child.id };
    useAppStore.setState({ nodes: [root, child, leaf, node('outside')], selectedNodeIds: [root.id, child.id] });
    expect(useAppStore.getState().copySelectedNodes()).toBe(true);
    expect(useAppStore.getState().clipboard.nodes.map((item) => item.id)).toEqual(['root', 'child', 'leaf']);
    expect(useAppStore.getState().clipboard.nodes[2].parentId).toBe(child.id);
    expect(useAppStore.getState().nodes).toHaveLength(4);
  });

  it('keeps incoming connections without copying outgoing external connections', () => {
    const incomingEdge: Edge = {
      id: 'edge-source-copy',
      source: 'source',
      target: 'copy',
      sourceHandle: 'output',
      targetHandle: 'prompt',
      type: 'smoothstep',
      animated: true,
      data: { channel: 'reference' },
    };
    const outgoingEdge: Edge = {
      id: 'edge-copy-downstream',
      source: 'copy',
      target: 'downstream',
    };
    useAppStore.setState({
      nodes: [node('source'), node('copy'), node('downstream')],
      edges: [incomingEdge, outgoingEdge],
      selectedNodeIds: ['copy'],
      showToast: vi.fn(),
    });

    useAppStore.getState().copySelectedNodes();
    useAppStore.getState().pasteNodes({ x: 30, y: 30 });

    const pastedNode = useAppStore.getState().nodes.find((item) => (
      !['source', 'copy', 'downstream'].includes(item.id)
    ));
    expect(pastedNode).toBeDefined();

    const pastedIncomingEdge = useAppStore.getState().edges.find((edge) => (
      edge.source === 'source' && edge.target === pastedNode?.id
    ));
    expect(pastedIncomingEdge).toMatchObject({
      sourceHandle: 'output',
      targetHandle: 'prompt',
      type: 'smoothstep',
      animated: true,
      data: { channel: 'reference' },
    });
    expect(useAppStore.getState().edges).not.toContainEqual(expect.objectContaining({
      source: pastedNode?.id,
      target: 'downstream',
    }));
  });

  it('remaps both ends of connections between copied nodes', () => {
    useAppStore.setState({
      nodes: [node('first'), node('second')],
      edges: [{ id: 'edge-first-second', source: 'first', target: 'second' }],
      selectedNodeIds: ['first', 'second'],
      showToast: vi.fn(),
    });

    useAppStore.getState().copySelectedNodes();
    useAppStore.getState().pasteNodes({ x: 30, y: 30 });

    const pastedIds = useAppStore.getState().nodes
      .filter((item) => !['first', 'second'].includes(item.id))
      .map((item) => item.id);
    const pastedEdges = useAppStore.getState().edges.filter((edge) => (
      pastedIds.includes(edge.source) && pastedIds.includes(edge.target)
    ));
    expect(pastedEdges).toHaveLength(1);
  });

  it('copies director outputs but creates an independent runtime instance', () => {
    const source = directorNode('director-source', 'blender', 'error');
    useAppStore.setState({
      currentProjectId: 'project-a',
      nodes: [source],
      edges: [],
      selectedNodeIds: [source.id],
      showToast: vi.fn(),
    });

    useAppStore.getState().copySelectedNodes();
    useAppStore.getState().pasteNodes({ x: 30, y: 30 });

    const pasted = useAppStore.getState().nodes.find((item) => item.id !== source.id);
    expect(pasted).toBeDefined();
    expect(pasted?.data).toMatchObject({
      directorRuntimeKind: 'blender',
      directorInstanceId: pasted?.id,
      directorStatus: 'idle',
      status: 'success',
      directorCaptureUrls: ['asset:///director/frame-a.png'],
      directorCaptureFilePaths: ['/data/project-a/frame-a.png'],
      imageUrl: 'asset:///director/frame-a.png',
      videoUrl: 'asset:///director/reference.mp4',
      filePath: '/data/project-a/reference.mp4',
    });
    expect(pasted?.data.error).toBeUndefined();
    expect(pasted?.data.directorCaptureUrls).not.toBe(source.data.directorCaptureUrls);
    expect(useAppStore.getState().directorDeskRuntimeRequest).toBeNull();
  });
});

describe('modifier-drag duplication', () => {
  it('moves only the new identity and restores the entire duplication with one undo', async () => {
    const source = { ...node('original'), selected: true, position: { x: 40, y: 60 },
      data: { ...node('original').data, displayId: 87 } };
    useAppStore.setState({ nodes: [source], selectedNodeIds: ['original'] });
    useAppStore.getState().commitToHistory();
    const drag = createNodeDuplicateDrag(useAppStore.getState, source.id);
    const move = (x: number, dragging: boolean) => useAppStore.getState().onNodesChange(drag.mapChanges([
      { type: 'position', id: source.id, position: { x, y: 200 }, dragging },
    ]));
    move(100, true);
    await Promise.resolve();
    move(300, true);
    expect(useAppStore.getState().nodes.find((item) => item.id === source.id)).toMatchObject(source);
    expect(useAppStore.getState().nodes.find((item) => item.id === source.id)?.data).toBe(source.data);
    expect(drag.getNode()?.position).toEqual({ x: 300, y: 200 });
    move(320, false);
    const clone = await drag.finish();
    expect(clone).toMatchObject({ position: { x: 320, y: 200 }, dragging: false, selected: true,
      data: { displayId: 88 } });
    expect(useAppStore.getState().nodes.find((item) => item.id === source.id)).toMatchObject({
      position: { x: 40, y: 60 }, data: { displayId: 87 }, selected: false,
    });
    expect(useAppStore.getState().selectedNodeIds).toEqual([clone!.id]);
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(useAppStore.getState().nodes).toHaveLength(1);
    expect(useAppStore.getState().nodes[0]).toMatchObject({ id: source.id, position: source.position,
      data: { displayId: 87 } });
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(useAppStore.getState().nodes.find((item) => item.id === clone!.id)?.position)
      .toEqual({ x: 320, y: 200 });
  });

  it('creates an empty media node at the latest drop position without copying files', async () => {
    fileMocks.copyFileToProjectData.mockRejectedValue(new Error('copy failed'));
    const source = mediaNode('source', 'a');
    source.data = { ...source.data,
      prompt: '把 @{reference:参考图} 改成森林风格', model: 'image-model', provider: 'image-provider',
      imageSize: '2K', aspectRatio: '9:16', batchCount: 2,
      workflowId: 'workflow', workflowInputs: { '1/prompt': '森林' },
      runninghubModelParameters: { strength: '0.8' },
      cameraSettings: { lens: '50mm' },
      mattingMask: 'data:mask', annotation: 'data:annotation',
      imageWidth: 1440, imageHeight: 2560, sourceUrl: 'https://example.test/result.png',
      fileName: 'original.png', output: 'https://example.test/result.png',
      artifactId: 'artifact', mediaVersion: 3, batchGroupId: 'old-batch',
      runninghubOutputs: [{ kind: 'image', url: 'asset:///workflow.png', filePath: '/data/a/workflow.png' }],
      workflowApiOutputs: [{ kind: 'image', url: 'asset:///workflow-api.png' }],
      runninghubStage: '已完成', workflowApiStage: '已完成',
      dramaAssetId: 'old-character',
      characterLibraryLinks: [{ scope: 'global', characterId: 'character', referenceImageId: 'reference' }],
    };
    const originalData = structuredClone(source.data);
    const showToast = vi.fn();
    useAppStore.setState({ currentProjectId: 'a', nodes: [source], showToast });
    const drag = createNodeDuplicateDrag(useAppStore.getState, source.id);
    useAppStore.getState().onNodesChange(drag.mapChanges([
      { type: 'position', id: source.id, position: { x: 200, y: 300 }, dragging: true },
    ]));
    useAppStore.getState().onNodesChange(drag.mapChanges([
      { type: 'position', id: source.id, position: { x: 400, y: 500 }, dragging: false },
    ]));
    const clone = await drag.finish();
    expect(clone).toMatchObject({ position: { x: 400, y: 500 }, dragging: false,
      data: { status: 'idle', prompt: originalData.prompt, model: 'image-model', provider: 'image-provider',
        imageSize: '2K', aspectRatio: '9:16', batchCount: 2,
        workflowId: 'workflow', workflowInputs: { '1/prompt': '森林' },
        runninghubModelParameters: { strength: '0.8' }, cameraSettings: { lens: '50mm' } } });
    for (const field of ['output', 'filePath', 'fileName', 'imageUrl', 'thumbnailUrl', 'sourceUrl',
      'assetId', 'relativePath', 'artifactId', 'mediaVersion', 'batchGroupId',
      'imageWidth', 'imageHeight', 'mattingMask', 'annotation', 'dramaAssetId', 'characterLibraryLinks',
      'runninghubOutputs', 'runninghubStage', 'workflowApiOutputs', 'workflowApiStage']) {
      expect(clone?.data[field], field).toBeUndefined();
    }
    expect(clone?.data.workflowInputs).not.toBe(source.data.workflowInputs);
    expect(fileMocks.copyFileToProjectData).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes.find((item) => item.id === source.id)).toMatchObject(source);
    expect(source.data).toEqual(originalData);
  });

  const contentCases: { type: NodeType; content: Partial<BaseNodeData>; config?: Partial<BaseNodeData> }[] = [
    { type: 'ai-text', content: { output: '已生成的正文' } },
    { type: 'ai-markdown', content: { output: '# 已生成的文档', filePath: '/data/a/doc.md' } },
    { type: 'ai-video', content: { videoUrl: 'asset:///video.mp4', videoBatchFingerprint: 'old-result',
      shotlistProductionSource: { nodeId: 'sheet', rowId: 'shot', kind: 'video', durationSync: 'auto' } },
      config: { seedanceDuration: 5, generateAudio: true,
        videoReferences: [{ id: 'reference', url: 'asset:///reference.png', kind: 'frame', role: 'first_frame' }] } },
    { type: 'ai-audio', content: { audioUrl: 'asset:///music.mp3', musicClipId: 'clip' },
      config: { musicTitle: '森林', musicLyrics: '歌词', musicDuration: 60, audioSpeed: 1.2 } },
    { type: 'ai-panorama', content: { imageUrl: 'asset:///panorama.png' } },
    { type: 'ai-animation', content: { imageUrl: 'asset:///sheet.png',
      animationSheet: { cols: 4, rows: 2, frameCount: 8, action: 'walk' },
      animationEdits: [{ sourceIndex: 0, enabled: true, offsetX: 1, offsetY: 2 }] },
      config: { animationAction: 'walk', animationFrames: 8, animationFps: 12,
        animationProcessing: { chromaKey: 'auto', keyThreshold: 40, segmentation: 'grid', alignment: 'foot', ground: true, margin: 4 } } },
    { type: 'ai-storyboard', content: { imageUrl: 'asset:///grid.png', storyboardExtracted: [true],
      storyboardOverrides: [{ url: 'asset:///override.png', filePath: '/data/a/override.png' }] },
      config: { storyboardCols: 3, storyboardRows: 3, storyboardColPositions: [30, 60] } },
    { type: 'ai-shotlist', content: { shotlistRows: [{ id: 'shot', shotNo: '1', content: '已有镜头' }],
      shotlistScriptSource: { episodeId: 'episode', nodeId: 'script' } },
      config: { shotlistColumns: ['shotNo', 'content'], shotlistColumnRatios: { content: 2 } } },
    { type: 'plugin-node', content: { output: '插件结果', pluginOutputs: { text: '插件结果' } },
      config: { pluginId: 'plugin', pluginNodeId: 'node', pluginValues: { strength: 2 } } },
    { type: 'source-image', content: { imageUrl: 'asset:///input.png' }, config: { role: 'source' } },
    { type: 'source-video', content: { videoUrl: 'asset:///input.mp4' }, config: { role: 'source' } },
    { type: 'source-audio', content: { audioUrl: 'asset:///input.mp3' }, config: { role: 'source' } },
    { type: 'source-text', content: { output: '已有输入文本' }, config: { role: 'source' } },
  ];
  it.each(contentCases)('clears $type content and loading state while preserving configuration', async ({ type, content, config }) => {
    const source: Node<BaseNodeData> = { ...node('source'), type,
      data: { label: 'source', type, prompt: '复用提示词', status: 'loading', error: '旧错误', ...content, ...config } };
    useAppStore.setState({ nodes: [source], showToast: vi.fn() });
    const drag = createNodeDuplicateDrag(useAppStore.getState, source.id);
    const clone = await drag.finish();
    expect(clone?.data).toMatchObject({ label: 'source', type, prompt: '复用提示词', status: 'idle', ...config });
    expect(clone?.data.error).toBeUndefined();
    for (const field of Object.keys(content)) expect(clone?.data[field], field).toBeUndefined();
    expect(source.data.status).toBe('loading');
    expect(source.data).toMatchObject(content);
    expect(fileMocks.copyFileToProjectData).not.toHaveBeenCalled();
  });

  it('does not apply a completed drag to a different project', async () => {
    useAppStore.setState({ currentProjectId: 'a', nodes: [node('source')] });
    const drag = createNodeDuplicateDrag(useAppStore.getState, 'source');
    await Promise.resolve();
    useAppStore.setState({ currentProjectId: 'b', nodes: [node('other')] });
    expect(await drag.finish()).toBeUndefined();
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['other']);
  });

  it('preserves original group membership and adds the clone independently', async () => {
    useAppStore.setState({ nodes: [node('source')], groups: [{ id: 'group', name: 'group',
      nodeIds: ['source'], color: '#6366f1', createdAt: 1 }] });
    const cloneId = await useAppStore.getState().duplicateNode('source');
    expect(useAppStore.getState().groups[0].nodeIds).toEqual(['source', cloneId]);
  });
  it('does not publish a late copy into a different project', async () => {
    let finish!: (value: unknown) => void;
    fileMocks.copyFileToProjectData.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    useAppStore.setState({ currentProjectId: 'a', nodes: [mediaNode('source', 'a')], showToast: vi.fn() });
    const pending = useAppStore.getState().duplicateNode('source');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    useAppStore.setState({ currentProjectId: 'b', nodes: [] });
    finish({ filePath: '/data/a/copy.png', assetUrl: 'asset:///data/a/copy.png' });
    await pending;
    expect(useAppStore.getState().nodes).toHaveLength(0);
    expect(fileMocks.moveToUndoTrash).toHaveBeenCalledWith('/data/a/copy.png');
  });

  it('does not replace a newly generated result while an older copy is pending', async () => {
    let finish!: (value: unknown) => void;
    fileMocks.copyFileToProjectData.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    useAppStore.setState({ currentProjectId: 'a', nodes: [mediaNode('source', 'a')], showToast: vi.fn() });
    const pending = useAppStore.getState().duplicateNode('source');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    useAppStore.getState().updateNodeData('source', { filePath: '/data/a/new.png', imageUrl: 'asset:///data/a/new.png' });
    finish({ filePath: '/data/a/copy.png', assetUrl: 'asset:///data/a/copy.png' });
    await pending;
    expect(useAppStore.getState().nodes).toHaveLength(1);
    expect(useAppStore.getState().nodes[0].data.filePath).toBe('/data/a/new.png');
  });

  it('keeps incoming connections on both nodes without inheriting outgoing connections', async () => {
    const incomingEdge: Edge = {
      id: 'edge-source-dragged',
      source: 'source',
      target: 'dragged',
      sourceHandle: 'output',
      targetHandle: 'prompt',
      type: 'smoothstep',
      animated: true,
      data: { channel: 'reference' },
    };
    useAppStore.setState({
      nodes: [node('source'), node('dragged'), node('downstream')],
      edges: [
        incomingEdge,
        { id: 'edge-dragged-downstream', source: 'dragged', target: 'downstream' },
      ],
    });

    await createNodeDuplicateDrag(useAppStore.getState, 'dragged').finish();

    const draggedClone = useAppStore.getState().nodes.find((item) => (
      !['source', 'dragged', 'downstream'].includes(item.id)
    ));
    expect(draggedClone).toBeDefined();

    const incomingEdges = useAppStore.getState().edges.filter((edge) => edge.source === 'source');
    expect(incomingEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: draggedClone?.id }),
      expect.objectContaining({
        target: 'dragged',
        sourceHandle: 'output',
        targetHandle: 'prompt',
        type: 'smoothstep',
        animated: true,
        data: { channel: 'reference' },
      }),
    ]));
    expect(useAppStore.getState().edges).not.toContainEqual(expect.objectContaining({
      source: draggedClone?.id,
      target: 'downstream',
    }));
    expect(useAppStore.getState().edges).toContainEqual(expect.objectContaining({
      source: 'dragged',
      target: 'downstream',
    }));
    expect(useAppStore.getState().edges.find((edge) => edge.id === incomingEdge.id)).toBe(incomingEdge);
  });

  it('clears director results and scenes while preserving runtime and generation settings', async () => {
    const source = directorNode('director-source', 'blender', 'loading');
    source.data = { ...source.data,
      directorScene: { schemaVersion: 1, sceneId: 'scene', revision: 1,
        relativePath: 'director/scenes/scene.json', sha256: 'a'.repeat(64), bytes: 512 },
      directorPrevisScene: { kind: 'project-file', relativePath: 'director/previs/previs.json', sha256: 'b'.repeat(64), bytes: 512 },
      directorResultManifest: { schemaVersion: 1, sceneId: 'scene', sceneRevision: 1, sceneSha256: 'a'.repeat(64),
        manifestRevision: 1, relativePath: 'director/results/manifest.json', sha256: 'c'.repeat(64), bytes: 512 },
      directorPrevisPrompt: '树林中的双人镜头', directorPrevisModel: 'previs-model', directorPrevisProvider: 'provider',
    };
    useAppStore.setState({ nodes: [source], edges: [] });
    const clone = await createNodeDuplicateDrag(useAppStore.getState, source.id).finish();
    expect(clone?.data).toMatchObject({ directorRuntimeKind: 'blender', directorInstanceId: clone?.id,
      directorStatus: 'idle', status: 'idle', directorPrevisPrompt: '树林中的双人镜头',
      directorPrevisModel: 'previs-model', directorPrevisProvider: 'provider' });
    expect(clone?.data.directorInstanceId).not.toBe(source.data.directorInstanceId);
    expect(clone?.data.directorScene).toBeUndefined();
    expect(clone?.data.directorPrevisScene).toBeUndefined();
    expect(clone?.data.directorResultManifest).toBeUndefined();
    expect(clone?.data.directorCaptureUrls).toBeUndefined();
    expect(clone?.data.directorCaptureFilePaths).toBeUndefined();
    expect(clone?.data.imageUrl).toBeUndefined();
    expect(clone?.data.videoUrl).toBeUndefined();
    expect(useAppStore.getState().directorDeskRuntimeRequest).toBeNull();
  });

  it('preserves authored canvas note content during drag duplication', async () => {
    const source: Node<BaseNodeData> = { ...node('note'), type: 'canvas-note',
      data: { label: '笔记', type: 'canvas-note', note: createCanvasNoteData('text', { text: '手写内容' }) } };
    useAppStore.setState({ nodes: [source] });
    const clone = await createNodeDuplicateDrag(useAppStore.getState, source.id).finish();
    expect(clone?.data.note).toEqual(source.data.note);
    expect(clone?.data.note).not.toBe(source.data.note);
  });

  it('keeps director media on ordinary duplication while resetting the cloned runtime session', () => {
    const source = directorNode('director-dragged', 'lightweight-web', 'loading');
    useAppStore.setState({ nodes: [source], edges: [] });

    useAppStore.getState().duplicateNode(source.id);

    const clone = useAppStore.getState().nodes.find((item) => item.id !== source.id);
    expect(clone).toBeDefined();
    expect(clone?.data).toMatchObject({
      directorRuntimeKind: 'lightweight-web',
      directorInstanceId: clone?.id,
      directorStatus: 'idle',
      status: 'success',
      directorCaptureUrls: ['asset:///director/frame-a.png'],
      imageUrl: 'asset:///director/frame-a.png',
      videoUrl: 'asset:///director/reference.mp4',
    });
    expect(clone?.data.error).toBeUndefined();
    expect(clone?.data.directorCaptureUrls).not.toBe(source.data.directorCaptureUrls);
    expect(useAppStore.getState().directorDeskRuntimeRequest).toBeNull();
  });
});

describe('cross-project paste (跨项目粘贴)', () => {
  it('把媒体文件复制到目标项目，副本不再引用源项目', async () => {
    useAppStore.setState({
      currentProjectId: 'project-a',
      nodes: [mediaNode('media', 'project-a')],
      edges: [],
      selectedNodeIds: ['media'],
      showToast: vi.fn(),
    });
    useAppStore.getState().copySelectedNodes();

    useAppStore.setState({ currentProjectId: 'project-b', nodes: [], edges: [] });
    useAppStore.getState().pasteNodes({ x: 30, y: 30 });

    await vi.waitFor(() => expect(fileMocks.copyFileToProjectData).toHaveBeenCalledTimes(1));
    expect(fileMocks.copyFileToProjectData)
      .toHaveBeenCalledWith('/data/project-a/original.png', 'project-b', { redactErrors: true });
    await vi.waitFor(() => {
      expect(useAppStore.getState().nodes[0].data.filePath).toBe('/data/project-b/copied.png');
    });

    const pasted = useAppStore.getState().nodes[0];
    // 源项目的资产身份必须清掉，否则保存时会把副本认成源项目那份资产
    expect(pasted.data.assetId).toBeUndefined();
    expect(pasted.data.relativePath).toBeUndefined();
    expect(pasted.data.imageUrl).toBe('asset:///data/project-b/copied.png');
    expect(pasted.data.thumbnailUrl).toBe('asset:///data/project-b/copied.png');
  });

  it('复制失败时不插入共享源文件的副本', async () => {
    fileMocks.copyFileToProjectData.mockResolvedValue(null);
    const showToast = vi.fn();
    useAppStore.setState({
      currentProjectId: 'project-a',
      nodes: [mediaNode('media', 'project-a')],
      edges: [],
      selectedNodeIds: ['media'],
      showToast,
    });
    useAppStore.getState().copySelectedNodes();

    useAppStore.setState({ currentProjectId: 'project-b', nodes: [], edges: [], showToast });
    await useAppStore.getState().pasteNodes({ x: 30, y: 30 });
    expect(useAppStore.getState().nodes).toHaveLength(0);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('复制失败'), 'error');
  });

  it('同项目内粘贴也复制独立文件', async () => {
    useAppStore.setState({
      currentProjectId: 'project-a',
      nodes: [mediaNode('media', 'project-a')],
      edges: [],
      selectedNodeIds: ['media'],
      showToast: vi.fn(),
    });
    useAppStore.getState().copySelectedNodes();
    await useAppStore.getState().pasteNodes({ x: 30, y: 30 });
    expect(fileMocks.copyFileToProjectData).toHaveBeenCalledTimes(1);
    const pasted = useAppStore.getState().nodes.find((item) => item.id !== 'media');
    expect(pasted?.data.filePath).toBe('/data/project-a/copied.png');
  });

  it('复制后编辑源节点不会改到剪贴板内容', () => {
    useAppStore.setState({
      currentProjectId: 'project-a',
      nodes: [node('text')],
      edges: [],
      selectedNodeIds: ['text'],
      showToast: vi.fn(),
    });
    useAppStore.getState().copySelectedNodes();
    useAppStore.getState().updateNodeData('text', { label: '改过的标题' });

    expect(useAppStore.getState().clipboard.nodes[0].data.label).toBe('text');
  });
});
