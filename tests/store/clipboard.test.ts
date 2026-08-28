import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';

const fileMocks = vi.hoisted(() => ({
  copyFileToProjectData: vi.fn(),
}));

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

import { useAppStore } from '../../src/store/useAppStore';

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
  fileMocks.copyFileToProjectData.mockReset();
  fileMocks.copyFileToProjectData.mockImplementation(async (_source: string, projectId: string) => ({
    filePath: `/data/${projectId}/copied.png`,
    assetUrl: `asset:///data/${projectId}/copied.png`,
    fileName: 'copied.png',
  }));
});

describe('canvas clipboard', () => {
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

describe('control-drag duplication', () => {
  it('keeps incoming connections on both nodes without inheriting outgoing connections', () => {
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

    useAppStore.getState().duplicateNode('dragged');

    const stationaryClone = useAppStore.getState().nodes.find((item) => (
      !['source', 'dragged', 'downstream'].includes(item.id)
    ));
    expect(stationaryClone).toBeDefined();

    const incomingEdges = useAppStore.getState().edges.filter((edge) => edge.source === 'source');
    expect(incomingEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: stationaryClone?.id }),
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
      source: 'dragged',
      target: 'downstream',
    }));
    expect(useAppStore.getState().edges).toContainEqual(expect.objectContaining({
      source: stationaryClone?.id,
      target: 'downstream',
    }));
  });

  it('keeps director media while resetting the cloned runtime session', () => {
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
      .toHaveBeenCalledWith('/data/project-a/original.png', 'project-b');
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

  it('复制失败时清掉本地引用，绝不留下指向源项目的路径', async () => {
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
    useAppStore.getState().pasteNodes({ x: 30, y: 30 });

    await vi.waitFor(() => {
      expect(useAppStore.getState().nodes[0].data.filePath).toBeUndefined();
    });
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('复制失败'), 'error');
  });

  it('同项目内粘贴不复制文件，仍与原节点共用素材', async () => {
    useAppStore.setState({
      currentProjectId: 'project-a',
      nodes: [mediaNode('media', 'project-a')],
      edges: [],
      selectedNodeIds: ['media'],
      showToast: vi.fn(),
    });
    useAppStore.getState().copySelectedNodes();
    useAppStore.getState().pasteNodes({ x: 30, y: 30 });

    await Promise.resolve();
    expect(fileMocks.copyFileToProjectData).not.toHaveBeenCalled();
    const pasted = useAppStore.getState().nodes.find((item) => item.id !== 'media');
    expect(pasted?.data.filePath).toBe('/data/project-a/original.png');
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
