/**
 * mediaPlaceholderLifecycle — 回归测试：media placeholder lifecycle。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cancelProjectCanvasDerivations } from '../../src/services/canvasDerivationGuard';
import {
  MEDIA_PLACEHOLDER_STALE_ERROR,
  registerMediaPlaceholderLifecycle,
  settleMediaPlaceholderLifecycle,
} from '../../src/services/chat/mediaPlaceholderLifecycle';
import { useAppStore } from '../../src/store/useAppStore';
import type { MediaGenerationIntent, MediaGenerationResult } from '../../src/types/media';

const intent: MediaGenerationIntent = {
  kind: 'image',
  prompt: 'test image',
  modelRef: 'apimart/test',
  deliveryMode: 'both',
};

const artifact: MediaGenerationResult = {
  id: 'artifact-1',
  kind: 'image',
  url: 'https://example.com/image.png',
  sourceUrl: 'https://example.com/image.png',
  prompt: 'test image',
  modelId: 'test',
  provider: 'apimart',
  deliveryMode: 'both',
  persistence: 'saved',
  createdAt: 1,
};

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    projectLoadStatus: 'ready',
    projects: [{ id: 'project-1', name: 'Project 1', createdAt: 1, updatedAt: 1 }],
    nodes: [],
    edges: [],
    groups: [],
    canvasRevision: 0,
  });
});

describe('media placeholder lifecycle', () => {
  it.each([
    ['1:1', 280, 280], ['16:9', 280, 158], ['9:16', 158, 280],
  ] as const)('图片占位按本次 %s 比例建框，覆盖项目默认且回填不改框', (aspectRatio, nodeWidth, nodeHeight) => {
    useAppStore.setState({ projects: [{ id: 'project-1', name: 'Project 1', createdAt: 1, updatedAt: 1,
      settings: { generation: { imageAspectRatio: '4:3' } } }] });
    const id = useAppStore.getState().createMediaPlaceholder({ ...intent, aspectRatio }, { x: 0, y: 0 });
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ aspectRatio, nodeWidth, nodeHeight });
    expect(useAppStore.getState().settleMediaPlaceholder(id, { ...artifact, parameters: { aspectRatio } })).toBe(true);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ aspectRatio, nodeWidth, nodeHeight });
  });

  it('MCP省略图片比例时采用当前画布请求默认1:1，不借作品根或另一集的9:16', () => {
    useAppStore.setState({ projects: [
      { id: 'series-owner', name: '作品', createdAt: 1, updatedAt: 1,
        settings: { generation: { imageAspectRatio: '9:16' } } },
      { id: 'project-1', parentId: 'series-owner', name: '本集', createdAt: 1, updatedAt: 1 },
    ] });
    useAppStore.getState().createMediaPlaceholder(intent, { x: 0, y: 0 });
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ aspectRatio: '1:1', imageSize: '2K', nodeWidth: 280, nodeHeight: 280 });
  });

  it('显式改比例联动画框并可撤销，元数据水化和相同比例不覆盖手动缩放', async () => {
    const id = useAppStore.getState().createMediaPlaceholder({ ...intent, aspectRatio: '1:1' }, { x: 0, y: 0 });
    useAppStore.getState().updateNodeData(id, { aspectRatio: '9:16' });
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ aspectRatio: '9:16', nodeWidth: 158, nodeHeight: 280 });
    await useAppStore.getState().undo();
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ aspectRatio: '1:1', nodeWidth: 280, nodeHeight: 280 });
    await useAppStore.getState().redo();
    useAppStore.getState().updateNodeDataTransient(id, { nodeWidth: 185, nodeHeight: 327 });
    useAppStore.getState().updateNodeDataTransient(id, { aspectRatio: '9:16', imageWidth: 1024, imageHeight: 1024 });
    useAppStore.getState().settleMediaPlaceholder(id, { ...artifact, parameters: { aspectRatio: '1:1' } });
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ aspectRatio: '9:16', nodeWidth: 185, nodeHeight: 327 });
  });

  it('保留占位图片的质量和显式接口默认背景，回填不覆盖用户参数', () => {
    const nodeId = useAppStore.getState().createMediaPlaceholder({ ...intent, imageQuality: 'high', imageBackground: '' }, { x: 0, y: 0 });
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ imageQuality: 'high', imageBackground: '' });
    const lifecycle = registerMediaPlaceholderLifecycle(nodeId)!;
    expect(settleMediaPlaceholderLifecycle(lifecycle, { ...artifact, parameters: { imageQuality: 'high', imageBackground: '' } })).toBe(true);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ imageQuality: 'high', imageBackground: '' });
  });

  it('对话视频转画布保留本次参数，包括自动时长和关闭音轨', () => {
    const nodeId = useAppStore.getState().materializeMediaArtifact({ ...artifact, id: 'video-result', kind: 'video',
      parameters: { aspectRatio: '9:16', resolution: '720p', duration: -1, videoFps: 24, generateAudio: false } }, { x: 0, y: 0 });
    expect(useAppStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      seedanceRatio: '9:16', seedanceResolution: '720p', seedanceDuration: -1, videoFps: 24, generateAudio: false,
    });
    const data = useAppStore.getState().nodes.find((item) => item.id === nodeId)!.data;
    expect(data.nodeHeight!).toBeGreaterThan(data.nodeWidth!);
  });

  it('图片结果转画布以生成时比例设置窗口，不沿用后来更改的项目比例', () => {
    useAppStore.setState({ projects: [{ id: 'project-1', name: 'Project 1', createdAt: 1, updatedAt: 1,
      settings: { generation: { imageAspectRatio: '16:9' } } }] });
    const nodeId = useAppStore.getState().materializeMediaArtifact({ ...artifact,
      parameters: { resolution: '2K', aspectRatio: '9:16', imageQuality: 'high' } }, { x: 0, y: 0 });
    const data = useAppStore.getState().nodes.find((item) => item.id === nodeId)!.data;
    expect(data).toMatchObject({ imageSize: '2K', aspectRatio: '9:16', imageQuality: 'high' });
    expect(data.nodeHeight!).toBeGreaterThan(data.nodeWidth!);
  });

  it('新通用视频未指定参数时不套项目默认，旧产物继续兼容', () => {
    useAppStore.setState({ projects: [{ id: 'project-1', name: 'Project 1', createdAt: 1, updatedAt: 1,
      settings: { generation: { videoAspectRatio: '16:9', videoResolution: '720p', videoDuration: 10 } } }] });
    const videoIntent: MediaGenerationIntent = { kind: 'video', prompt: '视频', modelRef: 'general/v', deliveryMode: 'both' };
    const placeholder = useAppStore.getState().createMediaPlaceholder(videoIntent, { x: 0, y: 0 });
    expect(useAppStore.getState().nodes.find((item) => item.id === placeholder)?.data.seedanceRatio).toBeUndefined();
    const result = { ...artifact, id: 'new-video', kind: 'video' as const, provider: 'general', parameters: {} };
    const newNode = useAppStore.getState().materializeMediaArtifact(result, { x: 10, y: 10 });
    const data = useAppStore.getState().nodes.find((item) => item.id === newNode)!.data;
    expect(data.seedanceRatio).toBeUndefined();
    expect(data.seedanceResolution).toBeUndefined();
    expect(data.seedanceDuration).toBeUndefined();
    const oldNode = useAppStore.getState().materializeMediaArtifact({ ...result, id: 'old-video', parameters: undefined }, { x: 20, y: 20 });
    expect(useAppStore.getState().nodes.find((item) => item.id === oldNode)?.data).toMatchObject({
      seedanceRatio: '16:9', seedanceResolution: '720p', seedanceDuration: 10,
    });
  });

  it('旧占位节点缺少参数时从交付快照补齐，同时保留节点已存在的设置', () => {
    const nodeId = useAppStore.getState().createMediaPlaceholder({ ...intent, imageQuality: 'low' }, { x: 0, y: 0 });
    useAppStore.getState().updateNodeDataTransient(nodeId, { aspectRatio: undefined, nodeWidth: 280, nodeHeight: 158 });
    const lifecycle = registerMediaPlaceholderLifecycle(nodeId)!;
    expect(settleMediaPlaceholderLifecycle(lifecycle, { ...artifact, parameters: {
      resolution: '2K', aspectRatio: '9:16', imageQuality: 'high', imageBackground: 'transparent',
    } })).toBe(true);
    expect(useAppStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      imageSize: '2K', aspectRatio: '9:16', imageQuality: 'low', imageBackground: 'transparent', nodeWidth: 158, nodeHeight: 280,
    });
  });

  it('旧占位补齐比例不覆盖用户已经调整的画框', () => {
    const nodeId = useAppStore.getState().createMediaPlaceholder(intent, { x: 0, y: 0 });
    useAppStore.getState().updateNodeDataTransient(nodeId, { aspectRatio: undefined, nodeWidth: 185, nodeHeight: 327 });
    useAppStore.getState().settleMediaPlaceholder(nodeId, { ...artifact, parameters: { aspectRatio: '1:1' } });
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ aspectRatio: '1:1', nodeWidth: 185, nodeHeight: 327 });
  });

  it('旧历史快照缺少比例时仍可恢复尺寸，不清空当前有效比例', async () => {
    useAppStore.getState().createMediaPlaceholder({ ...intent, aspectRatio: '9:16' }, { x: 0, y: 0 });
    const current = useAppStore.getState().nodes[0];
    const old = { ...current, data: { ...current.data, nodeWidth: 280, nodeHeight: 158 } };
    delete old.data.aspectRatio;
    useAppStore.setState({ history: [{ nodes: [old], edges: [], groups: [] }], historyIndex: 0 });
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ aspectRatio: '9:16', nodeWidth: 280, nodeHeight: 158 });
  });

  it('settles a placeholder while its project and revision remain current', () => {
    const nodeId = useAppStore.getState().createMediaPlaceholder(intent, { x: 0, y: 0 });
    const lifecycle = registerMediaPlaceholderLifecycle(nodeId);

    expect(lifecycle).not.toBeNull();
    expect(settleMediaPlaceholderLifecycle(lifecycle!, artifact)).toBe(true);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({
      artifactId: 'artifact-1',
      status: 'success',
    });
    expect(useAppStore.getState().canvasRevision).toBe(1);
  });

  it('marks the old placeholder as recoverable before switching projects', () => {
    const nodeId = useAppStore.getState().createMediaPlaceholder(intent, { x: 0, y: 0 });
    const lifecycle = registerMediaPlaceholderLifecycle(nodeId);

    cancelProjectCanvasDerivations('project-1');

    expect(useAppStore.getState().nodes[0].data).toMatchObject({
      status: 'error',
      error: MEDIA_PLACEHOLDER_STALE_ERROR,
    });
    expect(settleMediaPlaceholderLifecycle(lifecycle!, artifact)).toBe(false);
    expect(useAppStore.getState().nodes[0].data.artifactId).toBeUndefined();
  });

  it('does not settle after another canvas write changes the revision', () => {
    const nodeId = useAppStore.getState().createMediaPlaceholder(intent, { x: 0, y: 0 });
    const lifecycle = registerMediaPlaceholderLifecycle(nodeId);
    useAppStore.getState().incrementRevision();

    expect(settleMediaPlaceholderLifecycle(lifecycle!, artifact)).toBe(false);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({
      status: 'error',
      error: MEDIA_PLACEHOLDER_STALE_ERROR,
    });
  });
});
