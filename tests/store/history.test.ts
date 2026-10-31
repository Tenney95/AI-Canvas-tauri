/**
 * history — 回归测试：shotlist photography history。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData, NodeGroup, ShotRow } from '../../src/types';
import { createCanvasNoteData } from '../../src/types';

const fileMocks = vi.hoisted(() => ({
  copyFileToProjectData: vi.fn(async () => ({ filePath: 'project/copy.png', assetUrl: 'asset://project/copy.png' })),
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
  deleteNodeFiles: vi.fn(async () => undefined),
  deletedGroupFolderNames: (groups: NodeGroup[], deleted: ReadonlySet<string>) => groups.filter((group) =>
    deleted.has(group.id) || (group.nodeIds.length > 0 && group.nodeIds.every((id) => deleted.has(id)))).map((group) => group.name),
  resolveGroupUndoTrashPaths: vi.fn(async (names: string[]) => names.map((name) => `project/${name}`)),
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

describe('shotlist photography history', () => {
  it('视频摄影与旧参数可独立撤销和重做，保留当前生成结果与序列化数据', async () => {
    useAppStore.setState({ nodes: [node('video', { type: 'ai-video', cameraSettings: { lens: '35mm', aperture: 'f/4' } })] });
    const state = useAppStore.getState();
    state.commitToHistory();
    const cameraSettings = { cinematography: { cameraId: 'sony-venice-2', focalLengthMm: 50, apertureT: null } };
    state.updateNodeData('video', { cameraSettings });
    state.commitToHistory();
    state.updateNodeData('video', { videoUrl: 'latest-video' });
    await useAppStore.getState().undo();
    expect(useAppStore.getState().nodes[0].data.cameraSettings).toEqual({ lens: '35mm', aperture: 'f/4' });
    expect(useAppStore.getState().nodes[0].data.videoUrl).toBe('latest-video');
    await useAppStore.getState().redo();
    const saved = JSON.parse(JSON.stringify(useAppStore.getState().nodes[0].data));
    expect(saved.cameraSettings).toEqual(cameraSettings);
    expect(saved.videoUrl).toBe('latest-video');
  });

  it('整表默认与单镜覆盖独立撤销和重做，序列化保留设置与媒体绑定', async () => {
    const frame = { nodeId: 'image', kind: 'image' as const, url: 'image-url' };
    const original: ShotRow = { id: 'one', shotNo: '1', content: '原内容', dialogue: '原台词', frame };
    useAppStore.setState({ nodes: [node('shots', { type: 'ai-shotlist', shotlistRows: [original] })] });
    const state = useAppStore.getState();
    state.commitToHistory();
    state.updateNodeData('shots', { shotlistCinematography: { cameraId: 'arri-alexa-35', focalLengthMm: 35 } });
    state.commitToHistory();
    state.updateNodeData('shots', { shotlistRows: [{ ...original, cinematography: { focalLengthMm: 50, apertureT: null } }] });
    state.commitToHistory();
    await useAppStore.getState().undo();
    expect(useAppStore.getState().nodes[0].data.shotlistCinematography?.focalLengthMm).toBe(35);
    expect(useAppStore.getState().nodes[0].data.shotlistRows?.[0]).toEqual(original);
    await useAppStore.getState().undo();
    expect(useAppStore.getState().nodes[0].data.shotlistCinematography).toBeUndefined();
    await useAppStore.getState().redo();
    await useAppStore.getState().redo();
    const saved = JSON.parse(JSON.stringify(useAppStore.getState().nodes))[0].data;
    expect(saved.shotlistCinematography).toEqual({ cameraId: 'arri-alexa-35', focalLengthMm: 35 });
    expect(saved.shotlistRows[0]).toEqual({ ...original, cinematography: { focalLengthMm: 50, apertureT: null } });
  });
});

describe('shotlist column width history', () => {
  it('undoes conversion from pixel widths to ratios and redoes the responsive layout', async () => {
    useAppStore.setState({ nodes: [node('shots', { type: 'ai-shotlist', shotlistColumnWidths: { content: 320 } })] });
    const state = useAppStore.getState();
    state.commitToHistory();
    state.updateNodeDataTransient('shots', { shotlistColumnWidths: undefined, shotlistColumnRatios: { content: 35, dialogue: 25 } });
    state.commitToHistory();
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(useAppStore.getState().nodes[0].data.shotlistColumnWidths).toEqual({ content: 320 });
    expect(useAppStore.getState().nodes[0].data.shotlistColumnRatios).toBeUndefined();
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(useAppStore.getState().nodes[0].data.shotlistColumnWidths).toBeUndefined();
    expect(JSON.parse(JSON.stringify(useAppStore.getState().nodes))[0].data.shotlistColumnRatios)
      .toEqual({ content: 35, dialogue: 25 });
  });

  it('restores default widths and redoes saved widths without changing shot contents', async () => {
    useAppStore.setState({ nodes: [node('shots', {
      type: 'ai-shotlist', shotlistRows: [{ id: 'row-1', shotNo: '1', content: '镜头内容' }],
    })] });
    const state = useAppStore.getState();
    state.commitToHistory();
    state.updateNodeDataTransient('shots', { shotlistColumnWidths: { content: 320, dialogue: 180 } });
    state.commitToHistory();
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(useAppStore.getState().nodes[0].data.shotlistColumnWidths).toBeUndefined();
    expect(useAppStore.getState().nodes[0].data.shotlistRows?.[0].content).toBe('镜头内容');
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(useAppStore.getState().nodes[0].data.shotlistColumnWidths).toEqual({ content: 320, dialogue: 180 });
    // 项目节点序列化保留设置，不需要新建数据库表或迁移。
    expect(JSON.parse(JSON.stringify(useAppStore.getState().nodes))[0].data.shotlistColumnWidths)
      .toEqual({ content: 320, dialogue: 180 });
  });

  it('can undo resetting custom widths and redo the reset', async () => {
    useAppStore.setState({ nodes: [node('shots', { type: 'ai-shotlist', shotlistColumnWidths: { content: 360 } })] });
    const state = useAppStore.getState();
    state.commitToHistory();
    state.updateNodeDataTransient('shots', { shotlistColumnWidths: undefined });
    state.commitToHistory();
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(useAppStore.getState().nodes[0].data.shotlistColumnWidths).toEqual({ content: 360 });
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(useAppStore.getState().nodes[0].data.shotlistColumnWidths).toBeUndefined();
  });
});

it('动画帧编排与导入原图一起撤销和重做', async () => {
  const original = node('animation', { type: 'ai-animation', imageUrl: 'asset://old.png', filePath: 'project/old.png', animationSheet: { cols: 4, rows: 2, frameCount: 8, action: 'idle' } });
  useAppStore.setState({ nodes: [original] });
  const state = useAppStore.getState();
  state.updateNodeData('animation', { imageUrl: 'asset://new.png', filePath: 'project/new.png', animationSheet: { cols: 3, rows: 2, frameCount: 6, action: 'walk' }, animationEdits: [{ sourceIndex: 2, enabled: true, offsetX: 3, offsetY: 4 }], animationLoop: false });
  expect(await useAppStore.getState().undo()).toBe(true);
  expect(useAppStore.getState().nodes[0].data).toMatchObject({ imageUrl: 'asset://old.png', filePath: 'project/old.png', animationSheet: { frameCount: 8 } });
  expect(useAppStore.getState().nodes[0].data.animationEdits).toBeUndefined();
  expect(await useAppStore.getState().redo()).toBe(true);
  expect(useAppStore.getState().nodes[0].data).toMatchObject({ imageUrl: 'asset://new.png', animationSheet: { frameCount: 6 }, animationLoop: false, animationEdits: [{ sourceIndex: 2, offsetX: 3 }] });
});

describe('shotlist generated video bindings', () => {
  const frame = { nodeId: 'image', kind: 'image' as const, url: 'reference.png' };
  const row = () => useAppStore.getState().nodes.find((item) => item.id === 'sheet')!.data.shotlistRows![0];
  const replaceVideo = (video: ShotRow['video']) => useAppStore.getState().updateNodeDataTransient('sheet', {
    shotlistRows: [{ ...row(), video }],
  });
  const setup = (video?: ShotRow['video']) => useAppStore.setState({ nodes: [
    node('sheet', { type: 'ai-shotlist', shotlistRows: [{ id: 'row', shotNo: '1', frame, duration: 4.3, video }] }),
    node('video', { type: 'ai-video', status: 'idle', shotlistProductionSource: { nodeId: 'sheet', rowId: 'row', kind: 'video' } }),
    node('imported', { type: 'source-video', videoUrl: 'imported.mp4', videoDuration: 9 }),
    node('image', { type: 'ai-image', imageUrl: 'reference.png' }),
  ] });

  it('manual binding accepts ready video sources, preserves frame/duration and participates in undo/redo', async () => {
    setup();
    const state = useAppStore.getState();
    expect(state.bindShotlistVideo('sheet', 'row', 'image')).toBe(false);
    expect(state.bindShotlistVideo('sheet', 'row', 'video')).toBe(false);
    expect(state.bindShotlistVideo('sheet', 'missing', 'imported')).toBe(false);
    expect(state.bindShotlistVideo('sheet', 'row', 'imported')).toBe(true);
    expect(row()).toMatchObject({ frame, duration: 4.3, video: { nodeId: 'imported', kind: 'video', url: 'imported.mp4', sourceDuration: 9 } });
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(row().video).toBeUndefined();
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(row().video?.nodeId).toBe('imported');
  });

  it.each(['updateNodeData', 'updateNodeDataTransient'] as const)('%s fills only the precise production row and refreshes same-source snapshots', (action) => {
    setup();
    useAppStore.getState()[action]('video', { status: 'loading' });
    useAppStore.getState()[action]('video', { status: 'success', videoUrl: 'first.mp4', filePath: 'project/first.mp4', videoDuration: 5 });
    expect(row()).toMatchObject({ frame, duration: 4.3, video: { nodeId: 'video', kind: 'video', url: 'first.mp4', sourceDuration: 5 } });
    useAppStore.getState()[action]('video', { status: 'loading' });
    useAppStore.getState()[action]('video', { status: 'success', videoUrl: 'second.mp4', filePath: 'project/second.mp4' });
    expect(row().video?.url).toBe('second.mp4');
    expect(row().frame).toEqual(frame);
    expect(row().duration).toBe(4.3);
  });

  it('does not overwrite a manually chosen different source with an in-flight result', () => {
    setup();
    const state = useAppStore.getState();
    state.updateNodeDataTransient('video', { status: 'loading' });
    state.bindShotlistVideo('sheet', 'row', 'imported');
    state.updateNodeDataTransient('video', { status: 'success', videoUrl: 'late.mp4' });
    expect(row().video?.nodeId).toBe('imported');
  });

  it('records only actual transient success bindings for undo/redo, without recording loading or progress', async () => {
    setup();
    const state = useAppStore.getState();
    state.updateNodeDataTransient('video', { status: 'loading' });
    state.updateNodeDataTransient('video', { mediaTaskStage: 'querying' });
    expect(useAppStore.getState().history).toHaveLength(0);
    state.updateNodeDataTransient('video', { status: 'success', videoUrl: 'ready.mp4' });
    expect(useAppStore.getState().history).toHaveLength(1);
    state.updateNodeDataTransient('video', { status: 'success', videoUrl: 'ready.mp4' });
    expect(useAppStore.getState().history).toHaveLength(1);
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(row().video).toBeUndefined();
    expect(row().frame).toEqual(frame);
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(row().video).toMatchObject({ nodeId: 'video', url: 'ready.mp4' });
    const historyLength = useAppStore.getState().history.length;
    state.updateNodeDataTransient('video', { mediaTaskStage: undefined });
    expect(useAppStore.getState().history).toHaveLength(historyLength);
  });

  it('keeps explicit unlink through repeated loading updates, then allows a deliberate new run', () => {
    setup({ nodeId: 'video', kind: 'video', url: 'old.mp4' });
    const state = useAppStore.getState();
    state.updateNodeDataTransient('video', { status: 'loading' });
    replaceVideo(null);
    state.updateNodeDataTransient('video', { status: 'loading' });
    state.updateNodeDataTransient('video', { status: 'success', videoUrl: 'late.mp4' });
    expect(row().video).toBeNull();
    state.updateNodeDataTransient('video', { status: 'loading' });
    state.updateNodeDataTransient('video', { status: 'success', videoUrl: 'new-run.mp4' });
    expect(row().video?.url).toBe('new-run.mp4');
  });

  it('does not revive null after choosing and unlinking a source during a run that started from null', () => {
    setup(null);
    const state = useAppStore.getState();
    state.updateNodeDataTransient('video', { status: 'loading' });
    state.bindShotlistVideo('sheet', 'row', 'imported');
    replaceVideo(null);
    state.updateNodeDataTransient('video', { status: 'success', videoUrl: 'late.mp4' });
    expect(row().video).toBeNull();
  });

  it('ignores non-ready results and deleted or changed production rows', () => {
    setup();
    const state = useAppStore.getState();
    state.updateNodeDataTransient('video', { status: 'loading' });
    state.updateNodeDataTransient('video', { status: 'error', videoUrl: 'partial.mp4' });
    state.updateNodeDataTransient('video', { status: 'success', videoUrl: '' });
    expect(row().video).toBeUndefined();
    state.updateNodeDataTransient('video', { status: 'loading' });
    state.updateNodeDataTransient('sheet', { shotlistRows: [{ id: 'other', shotNo: '1' }] });
    state.updateNodeDataTransient('video', { status: 'success', videoUrl: 'late.mp4' });
    expect(row().video).toBeUndefined();
    state.updateNodeDataTransient('video', { status: 'success', videoUrl: 'late.mp4',
      shotlistProductionSource: { nodeId: 'sheet', rowId: 'other', kind: 'video' } });
    expect(row().video).toBeUndefined();
  });
});

describe('precise shot duration references', () => {
  const source = () => node('sheet', { type: 'ai-shotlist', shotlistRows: [
    { id: 'row-1', shotNo: '1', content: '走入房间', duration: 4.3 },
    { id: 'row-2', shotNo: '2', content: '抬头看向窗外', duration: 7.2 },
  ] });
  const video = () => useAppStore.getState().nodes.find((item) => item.id === 'video')!.data;

  it('associates a single shot while preserving prose and media, and follows later duration edits', () => {
    useAppStore.setState({ nodes: [source(), node('video', { type: 'ai-video', prompt: '视频补充要求', videoUrl: 'keep.mp4' })] });
    useAppStore.getState().updateNodeDataTransient('video', { prompt: '@{sheet/shot/row-1:第1镜} 视频补充要求' });
    expect(video()).toMatchObject({ seedanceDuration: 5, videoUrl: 'keep.mp4', prompt: '@{sheet/shot/row-1:第1镜} 视频补充要求',
      shotlistProductionSource: { nodeId: 'sheet', rowId: 'row-1', kind: 'video', durationSync: 'auto' } });
    useAppStore.getState().updateNodeDataTransient('sheet', { shotlistRows: [
      { id: 'row-1', shotNo: '1', content: '走入房间', duration: 8.1 },
      { id: 'row-2', shotNo: '2', content: '抬头看向窗外', duration: 7.2 },
    ] });
    expect(video().seedanceDuration).toBe(9);
    expect(video().videoUrl).toBe('keep.mp4');
  });

  it('replaces an auto-mentioned whole sheet with the selected shot while keeping other references and prose', () => {
    useAppStore.setState({ nodes: [source(), node('other', { type: 'ai-shotlist' }),
      node('video', { type: 'ai-video', prompt: '保留补充要求 @{other:其他表}' })] });
    useAppStore.getState().onConnect({ source: 'sheet', target: 'video', sourceHandle: 'right', targetHandle: 'left' });
    expect(video().prompt).toContain('@{sheet:sheet}');
    useAppStore.getState().updateNodeDataTransient('video', { prompt: `${video().prompt} @{sheet/shot/row-1:第1镜}` });
    expect(video().prompt).not.toContain('@{sheet:');
    expect(video().prompt).toContain('@{sheet/shot/row-1:第1镜}');
    expect(video().prompt).toContain('保留补充要求 @{other:其他表}');
    expect(video()).toMatchObject({ seedanceDuration: 5,
      shotlistProductionSource: { nodeId: 'sheet', rowId: 'row-1', durationSync: 'auto' } });
  });

  it('keeps same-shot manual timing, uses the new shot after switching, and honors an explicit duration patch', () => {
    useAppStore.setState({ nodes: [source(), node('video', { type: 'ai-video' })] });
    useAppStore.getState().updateNodeDataTransient('video', { prompt: '@{sheet/shot/row-1:第1镜}' });
    useAppStore.getState().updateNodesDataBatch(['video'], { seedanceDuration: 12 });
    useAppStore.getState().updateNodeDataTransient('video', { prompt: '@{sheet/shot/row-1:第1镜} 新要求' });
    expect(video().seedanceDuration).toBe(12);
    expect(video().shotlistProductionSource?.durationSync).toBe('manual');
    useAppStore.getState().updateNodeDataTransient('video', { prompt: '@{sheet/shot/row-2:第2镜} 新要求' });
    expect(video().seedanceDuration).toBe(8);
    expect(video().shotlistProductionSource).toMatchObject({ rowId: 'row-2', durationSync: 'auto' });
    useAppStore.getState().updateNodeData('video', { prompt: '@{sheet/shot/row-1:第1镜}', seedanceDuration: 3 });
    expect(video().seedanceDuration).toBe(3);
    expect(video().shotlistProductionSource).toMatchObject({ rowId: 'row-1', durationSync: 'manual' });
  });

  it.each([
    '只留补充要求', '@{sheet/shot/row-1:第1镜} @{sheet/shot/row-2:第2镜}', '@{sheet/shot/missing:已删镜头}',
  ])('clears reference-managed timing when the prompt has no unique valid shot: %s', (prompt) => {
    useAppStore.setState({ nodes: [source(), node('video', { type: 'ai-video' })] });
    useAppStore.getState().updateNodeDataTransient('video', { prompt: '@{sheet/shot/row-1:第1镜}' });
    useAppStore.getState().updateNodeDataTransient('video', { prompt });
    expect(video().prompt).toBe(prompt);
    expect(video().shotlistProductionSource).toBeUndefined();
    expect(video().seedanceDuration).toBe(5);
  });

  it('preserves legacy production sources that never used a precise shot capsule', () => {
    const legacy = { nodeId: 'sheet', rowId: 'row-1', kind: 'video' as const, durationSync: 'auto' as const };
    useAppStore.setState({ nodes: [source(), node('video', { type: 'ai-video', prompt: '旧式镜头全文', shotlistProductionSource: legacy })] });
    useAppStore.getState().updateNodeDataTransient('video', { prompt: '人工修改旧式提示词' });
    expect(video().shotlistProductionSource).toEqual(legacy);
  });

  it('supports imported video shot timing without changing its source type or media', () => {
    useAppStore.setState({ nodes: [source(), node('video', {
      type: 'source-video', role: 'source', videoUrl: 'imported.mp4', output: 'imported.mp4',
    })] });
    useAppStore.getState().updateNodeDataTransient('video', { prompt: '@{sheet/shot/row-1:第1镜}' });
    expect(video()).toMatchObject({ type: 'source-video', role: 'source', videoUrl: 'imported.mp4', seedanceDuration: 5,
      shotlistProductionSource: { nodeId: 'sheet', rowId: 'row-1', durationSync: 'auto' } });
    useAppStore.getState().updateNodeDataTransient('sheet', { shotlistRows: [
      { id: 'row-1', shotNo: '1', content: '走入房间', duration: 8.1 },
    ] });
    expect(video().seedanceDuration).toBe(9);
    useAppStore.getState().updateNodeDataTransient('video', { seedanceDuration: 12 });
    useAppStore.getState().updateNodeDataTransient('sheet', { shotlistRows: [
      { id: 'row-1', shotNo: '1', content: '走入房间', duration: 10 },
    ] });
    useAppStore.getState().updateNodeDataTransient('video', { prompt: '@{sheet/shot/row-1:第1镜} 保留导入视频的要求' });
    expect(video()).toMatchObject({ type: 'source-video', role: 'source', videoUrl: 'imported.mp4', seedanceDuration: 12,
      shotlistProductionSource: { nodeId: 'sheet', rowId: 'row-1', durationSync: 'manual' } });
  });

  it.each(['ai-video', 'source-video'] as const)('undoes and redoes the %s prompt reference with its duration association', async (type) => {
    useAppStore.setState({ nodes: [source(), node('video', { type, prompt: '原补充要求', seedanceDuration: 3 })] });
    useAppStore.getState().updateNodeData('video', { prompt: '@{sheet/shot/row-1:第1镜} 原补充要求' });
    expect(video().seedanceDuration).toBe(5);
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(video()).toMatchObject({ prompt: '原补充要求', seedanceDuration: 3 });
    expect(video().shotlistProductionSource).toBeUndefined();
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(video()).toMatchObject({ prompt: '@{sheet/shot/row-1:第1镜} 原补充要求', seedanceDuration: 5,
      shotlistProductionSource: { nodeId: 'sheet', rowId: 'row-1', durationSync: 'auto' } });
  });

  it('preserves later prompt edits when undoing layout without changing the shot association', async () => {
    useAppStore.setState({ nodes: [source(), node('video', { type: 'ai-video' })] });
    const state = useAppStore.getState();
    state.updateNodeDataTransient('video', { prompt: '@{sheet/shot/row-1:第1镜} 原补充要求' });
    state.commitToHistory();
    state.updateNodePositionTransient('video', { x: 500, y: 120 });
    state.updateNodeDataTransient('video', { prompt: '@{sheet/shot/row-1:第1镜} 后续补充要求' });
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(useAppStore.getState().nodes.find((item) => item.id === 'video')?.position).toEqual({ x: 0, y: 0 });
    expect(video()).toMatchObject({ prompt: '@{sheet/shot/row-1:第1镜} 后续补充要求', seedanceDuration: 5,
      shotlistProductionSource: { nodeId: 'sheet', rowId: 'row-1', durationSync: 'auto' } });
  });

  it('preserves later prompt edits when undoing only the shot duration mode', async () => {
    useAppStore.setState({ nodes: [source(), node('video', { type: 'ai-video' })] });
    const state = useAppStore.getState();
    state.updateNodeDataTransient('video', { prompt: '@{sheet/shot/row-1:第1镜} 原补充要求' });
    state.updateNodeData('video', { seedanceDuration: 12 });
    state.updateNodeDataTransient('video', { prompt: '@{sheet/shot/row-1:第1镜} 后续补充要求' });
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(video()).toMatchObject({ prompt: '@{sheet/shot/row-1:第1镜} 后续补充要求', seedanceDuration: 5,
      shotlistProductionSource: { nodeId: 'sheet', rowId: 'row-1', durationSync: 'auto' } });
  });
});

describe('automatic connection mentions', () => {
  const targetPrompt = () => useAppStore.getState().nodes.find((item) => item.id === 'target')?.data.prompt;
  const connect = () => useAppStore.getState().onConnect({
    source: 'source', target: 'target', sourceHandle: 'right', targetHandle: 'left',
  });

  it('defaults on for old settings and appends the reference to the real prompt', () => {
    useAppStore.setState({
      nodes: [node('source', { label: '参考素材' }), node('target', { prompt: '保留描述' })],
      config: { providers: {}, theme: 'dark' },
    });
    connect();
    expect(targetPrompt()).toBe('保留描述 @{source:参考素材}');
    expect(useAppStore.getState().history).toHaveLength(1);
    expect(useAppStore.getState().edges).toHaveLength(1);
  });

  it('keeps manual references and does not duplicate mentions after a rename or reconnect', () => {
    useAppStore.setState({ nodes: [node('source', { label: '新名称' }), node('target', { prompt: '@{source:旧名称} 描述' })] });
    connect();
    expect(targetPrompt()).toBe('@{source:旧名称} 描述');
    useAppStore.setState({ edges: [] });
    connect();
    expect(targetPrompt()).toBe('@{source:旧名称} 描述');
  });

  it('keeps precise shot references instead of appending a whole-table reference', () => {
    const prompt = '@{source/shot/row-1:分镜表 · 第1镜} 保留视频要求';
    useAppStore.setState({ nodes: [node('source', { type: 'ai-shotlist' }), node('target', { type: 'ai-video', prompt })] });
    connect();
    expect(targetPrompt()).toBe(prompt);
    expect(useAppStore.getState().edges[0]).toMatchObject({ source: 'source', target: 'target' });
  });

  it('materializes a shot source as its real sheet even when auto mentioning is disabled', () => {
    useAppStore.setState({ nodes: [node('source', { type: 'ai-shotlist' }), node('target', { type: 'ai-video' })],
      config: { ...useAppStore.getState().config, autoMentionOnConnect: false } });
    useAppStore.getState().onConnect({ source: 'source/shot/row-1', target: 'target', sourceHandle: 'right', targetHandle: 'left' });
    expect(useAppStore.getState().edges[0]).toMatchObject({ source: 'source', target: 'target' });
    expect(targetPrompt()).toBeUndefined();
    useAppStore.getState().addNodesWithEdges([node('new', { type: 'ai-video' })], [
      { id: 'new-edge', source: 'source/shot/row-2', target: 'new' },
    ]);
    expect(useAppStore.getState().edges[1]).toMatchObject({ source: 'source', target: 'new' });
  });

  it('leaves prompts untouched when disabled, including batch creation', () => {
    useAppStore.setState({
      currentProjectId: 'p', nodes: [node('source'), node('other'), node('target', { prompt: '原提示词' })],
      config: { ...useAppStore.getState().config, autoMentionOnConnect: false },
    });
    connect();
    expect(targetPrompt()).toBe('原提示词');
    useAppStore.getState().connectSelectedNodes(['source', 'other'], 'target', 'p');
    expect(targetPrompt()).toBe('原提示词');
    useAppStore.getState().addNodeFromSelection(node('new', { prompt: '新提示词' }), ['source', 'other'], 'p');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'new')?.data.prompt).toBe('新提示词');
  });

  it('normalizes reverse drags before mentioning the real upstream node', () => {
    useAppStore.setState({ nodes: [node('source'), node('target')] });
    useAppStore.getState().onConnect({ source: 'target', target: 'source', sourceHandle: 'left', targetHandle: 'right' });
    expect(targetPrompt()).toBe('@{source:source}');
    expect(useAppStore.getState().nodes[0].data.prompt).toBeUndefined();
  });

  it.each(['ai-image', 'ai-video', 'ai-audio'] as const)('mentions later connections in an open %s source-node dialog', (type) => {
    useAppStore.setState({ nodes: [
      node('source', { type: 'ai-image', role: 'source', label: '全景截图.png' }),
      node('other'),
      { ...node('target', { type, role: 'source', model: 'general/custom', provider: 'general', prompt: '正在编辑的描述' }), type },
    ] });
    useAppStore.getState().openNodeDialog('target');
    connect();
    useAppStore.getState().onConnect({ source: 'target', target: 'other', sourceHandle: 'left', targetHandle: 'right' });
    connect();
    expect(targetPrompt()).toBe('正在编辑的描述 @{source:全景截图.png} @{other:other}');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'target')?.data.role).toBe('source');
  });

  it('preserves prompt edits while undoing and redoing the source-dialog connection', async () => {
    useAppStore.setState({ nodes: [node('source'), node('target', { type: 'ai-video', role: 'source', prompt: '原描述' })] });
    useAppStore.getState().openNodeDialog('target');
    connect();
    expect(targetPrompt()).toBe('原描述 @{source:source}');
    expect(useAppStore.getState().history).toHaveLength(1);
    useAppStore.getState().updateNodeDataTransient('target', { prompt: '继续编辑 @{source:source}' });
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(targetPrompt()).toBe('继续编辑 @{source:source}');
    expect(useAppStore.getState().edges).toHaveLength(0);
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(targetPrompt()).toBe('继续编辑 @{source:source}');
    expect(useAppStore.getState().edges).toHaveLength(1);
  });

  it('respects the disabled setting for an open source-node dialog', () => {
    useAppStore.setState({
      nodes: [node('source'), node('target', { type: 'ai-video', role: 'source', prompt: '原描述' })],
      config: { ...useAppStore.getState().config, autoMentionOnConnect: false },
    });
    useAppStore.getState().openNodeDialog('target');
    connect();
    expect(targetPrompt()).toBe('原描述');
    expect(useAppStore.getState().edges).toHaveLength(1);
  });

  it('does not change the prompt of a source node whose dialog is not open', () => {
    useAppStore.setState({ nodes: [node('source'), node('other'), node('target', { type: 'ai-video', role: 'source', prompt: '原描述' })] });
    useAppStore.getState().openNodeDialog('other');
    connect();
    expect(targetPrompt()).toBe('原描述');
  });

  it('applies batch and newly created input references to the open source-node dialog', () => {
    useAppStore.setState({ currentProjectId: 'p', nodes: [node('source'), node('other'),
      node('target', { type: 'ai-video', role: 'source', prompt: '原描述' })] });
    useAppStore.getState().openNodeDialog('target');
    expect(useAppStore.getState().connectSelectedNodes(['source', 'other'], 'target', 'p')).toBe(2);
    expect(targetPrompt()).toBe('原描述 @{source:source} @{other:other}');
    useAppStore.getState().addNodeWithEdge(node('new-input'), { id: 'new-edge', source: 'new-input', target: 'target' });
    useAppStore.getState().addNodesWithEdges([node('batch-input')], [{ id: 'batch-edge', source: 'batch-input', target: 'target' }]);
    expect(targetPrompt()).toBe('原描述 @{source:source} @{other:other} @{new-input:new-input} @{batch-input:batch-input}');
  });

  it('removes disconnected mentions while preserving prose, other references and one history snapshot', () => {
    useAppStore.setState({
      nodes: [node('source'), node('other'), node('target', {
        prompt: '保留描述\n@{source:旧名称} @{other:素材} @{source/cell/2:子图}\n@asset{library} @wf{6|提示词|prompt}(内容)',
      })],
      edges: [{ id: 'edge', source: 'source', target: 'target' }, { id: 'other-edge', source: 'other', target: 'target' }],
    });
    useAppStore.getState().onEdgesChange([{ type: 'remove', id: 'edge' }]);
    expect(targetPrompt()).toBe('保留描述\n @{other:素材} \n@asset{library} @wf{6|提示词|prompt}(内容)');
    expect(useAppStore.getState().edges.map((edge) => edge.id)).toEqual(['other-edge']);
    expect(useAppStore.getState().history).toHaveLength(1);
  });

  it('removes only the disconnected sheet shot references after its last connection', () => {
    const prompt = '@{source/shot/row-1:第1镜} @{source/shot/row-2:第2镜} @{other/shot/row-3:其他表} 保留要求';
    useAppStore.setState({ nodes: [node('source', { type: 'ai-shotlist' }), node('other', { type: 'ai-shotlist' }),
      node('target', { type: 'ai-video', prompt })], edges: [
      { id: 'first', source: 'source', target: 'target' }, { id: 'second', source: 'source', target: 'target' },
      { id: 'other-edge', source: 'other', target: 'target' },
    ] });
    useAppStore.getState().onEdgesChange([{ type: 'remove', id: 'first' }]);
    expect(targetPrompt()).toBe(prompt);
    useAppStore.getState().onEdgesChange([{ type: 'remove', id: 'second' }]);
    expect(targetPrompt()).toBe('  @{other/shot/row-3:其他表} 保留要求');
    expect(useAppStore.getState().edges.map((edge) => edge.id)).toEqual(['other-edge']);
  });

  it('clears references after the setting is disabled and leaves another target untouched', () => {
    useAppStore.setState({
      nodes: [node('source'), node('target', { prompt: '@{source:素材}' }), node('other', { prompt: '@{source:素材}' })],
      edges: [{ id: 'edge', source: 'source', target: 'target' }, { id: 'other-edge', source: 'source', target: 'other' }],
      config: { ...useAppStore.getState().config, autoMentionOnConnect: false },
    });
    useAppStore.getState().onEdgesChange([{ type: 'remove', id: 'edge' }]);
    expect(targetPrompt()).toBe('');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'other')?.data.prompt).toBe('@{source:素材}');
  });

  it('keeps a reference until its last direct or inherited connection is removed', () => {
    useAppStore.setState({
      nodes: [node('source'), groupNode('group'), { ...node('target', { prompt: '@{source:素材}' }), parentId: 'group' }],
      edges: [
        { id: 'first', source: 'source', target: 'target' },
        { id: 'second', source: 'source', target: 'target' },
        { id: 'inherited', source: 'source', target: 'group' },
      ],
    });
    useAppStore.getState().onEdgesChange([{ type: 'remove', id: 'first' }, { type: 'remove', id: 'second' }]);
    expect(targetPrompt()).toBe('@{source:素材}');
    useAppStore.getState().onEdgesChange([{ type: 'remove', id: 'inherited' }]);
    expect(targetPrompt()).toBe('');
  });

  it('clears disconnected group children but retains a child with its own connection', () => {
    useAppStore.setState({
      nodes: [groupNode('source-group'), { ...node('source'), parentId: 'source-group' },
        { ...node('other'), parentId: 'source-group' }, node('target', { prompt: '@{source:素材} @{other:其他}' })],
      edges: [{ id: 'group-edge', source: 'source-group', target: 'target' }, { id: 'direct', source: 'other', target: 'target' }],
    });
    useAppStore.getState().onEdgesChange([{ type: 'remove', id: 'group-edge' }]);
    expect(targetPrompt()).toBe(' @{other:其他}');
  });

  it('leaves prompts unchanged for edge selection and nonexistent removals', () => {
    const target = node('target', { prompt: '@{source:素材}' });
    useAppStore.setState({ nodes: [node('source'), target], edges: [{ id: 'edge', source: 'source', target: 'target' }] });
    useAppStore.getState().onEdgesChange([{ type: 'select', id: 'edge', selected: true }]);
    useAppStore.getState().onEdgesChange([{ type: 'remove', id: 'missing' }]);
    expect(useAppStore.getState().nodes.find((item) => item.id === 'target')).toBe(target);
  });

  it('adds batch mentions in connection order and keeps one history entry', () => {
    useAppStore.setState({ currentProjectId: 'p', nodes: [node('source'), node('other'), node('target', { prompt: '描述\n' })] });
    expect(useAppStore.getState().connectSelectedNodes(['other', 'source'], 'target', 'p')).toBe(2);
    expect(targetPrompt()).toBe('描述\n@{other:other} @{source:source}');
    expect(useAppStore.getState().history).toHaveLength(1);
    expect(useAppStore.getState().connectSelectedNodes(['other', 'source'], 'target', 'p')).toBe(0);
    expect(targetPrompt()).toBe('描述\n@{other:other} @{source:source}');
  });

  it('handles both single and batch creation of connected targets', () => {
    useAppStore.setState({ currentProjectId: 'p', nodes: [node('source'), node('other')] });
    useAppStore.getState().addNodeWithEdge(node('target'), { id: 'edge', source: 'source', target: 'target' });
    expect(targetPrompt()).toBe('@{source:source}');
    useAppStore.getState().addNodeFromSelection(node('batch'), ['source', 'other'], 'p');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'batch')?.data.prompt).toBe('@{source:source} @{other:other}');
    useAppStore.getState().addNodesWithEdges([node('next')], [{ id: 'next-edge', source: 'batch', target: 'next' }]);
    expect(useAppStore.getState().nodes.find((item) => item.id === 'next')?.data.prompt).toBe('@{batch:batch}');
  });

  it('expands source groups into real asset references and escapes label delimiters', () => {
    useAppStore.setState({ nodes: [
      { ...node('source'), type: 'group' },
      { ...node('child', { label: '图{片}\nA' }), parentId: 'source' },
      { ...canvasNoteNode('note'), parentId: 'source' }, node('target'),
    ] });
    connect();
    expect(targetPrompt()).toBe('@{child:图 片  A}');
  });

  it.each(['source-image', 'canvas-note', 'group', 'plugin-node'])('does not write prompts into %s targets', (type) => {
    useAppStore.setState({ nodes: [node('source'), { ...node('target', { prompt: '原内容' }), type, data: { ...node('target').data, type: type as BaseNodeData['type'], prompt: '原内容' } }] });
    connect();
    expect(targetPrompt()).toBe('原内容');
  });
});

describe('multi-selection connections', () => {
  it('creates one ordinary edge per source in one undoable action and skips duplicates', async () => {
    useAppStore.setState({
      currentProjectId: 'p',
      nodes: [node('a'), node('b'), node('target')],
      edges: [{ id: 'existing', source: 'a', target: 'target', sourceHandle: 'right', targetHandle: 'left' }],
    });
    const originalCommit = useAppStore.getState().commitToHistory;
    const commitSpy = vi.fn(() => originalCommit());
    useAppStore.setState({ commitToHistory: commitSpy });

    expect(useAppStore.getState().connectSelectedNodes(['a', 'b'], 'target', 'p')).toBe(1);
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().edges.map((edge) => [edge.source, edge.target])).toEqual([
      ['a', 'target'], ['b', 'target'],
    ]);
    expect(useAppStore.getState().connectSelectedNodes(['a', 'b'], 'target', 'p')).toBe(0);
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(useAppStore.getState().edges.map((edge) => edge.id)).toEqual(['existing']);
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(useAppStore.getState().edges).toHaveLength(2);
  });

  it('rejects stale projects, missing sources, selected targets and unsupported nodes atomically', () => {
    useAppStore.setState({ currentProjectId: 'p', nodes: [node('a'), node('b'), node('target')], edges: [] });
    const connect = useAppStore.getState().connectSelectedNodes;
    expect(connect(['a', 'b'], 'target', 'other')).toBe(0);
    expect(connect(['a', 'missing'], 'target', 'p')).toBe(0);
    expect(connect(['a', 'b'], 'a', 'p')).toBe(0);
    expect(connect(['a', 'a'], 'target', 'p')).toBe(0);
    useAppStore.setState({ nodes: [node('a'), canvasNoteNode('b'), node('target')] });
    expect(connect(['a', 'b'], 'target', 'p')).toBe(0);
    expect(useAppStore.getState().edges).toEqual([]);
    expect(useAppStore.getState().history).toEqual([]);
  });

  it('creates a target and its incoming edges in one history entry', async () => {
    useAppStore.setState({ currentProjectId: 'p', nodes: [node('a'), node('b')], edges: [] });
    expect(useAppStore.getState().addNodeFromSelection(node('target'), ['a', 'b'], 'p')).toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['a', 'b', 'target']);
    expect(useAppStore.getState().edges.map((edge) => edge.source)).toEqual(['a', 'b']);
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['a', 'b']);
    expect(useAppStore.getState().edges).toEqual([]);
  });
});

describe('batch canvas history', () => {
  it('undo and redo preserve the independent file created by media duplication', async () => {
    useAppStore.setState({ currentProjectId: 'p', nodes: [{ ...node('source'), type: 'ai-image',
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
    expect(fileMocks.restoreFromUndoTrash).toHaveBeenCalledWith('project/node-a.png');

    await expect(useAppStore.getState().redo()).resolves.toBe(true);

    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['node-c']);
    expect(useAppStore.getState()).toMatchObject({ historyIndex: 0 });
    expect(fileMocks.deleteNodeFiles).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ filePath: 'project/node-a.png' })]), expect.any(Set), expect.anything(), expect.any(Array),
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
    expect(fileMocks.restoreFromUndoTrash).toHaveBeenCalledWith(
      'project/director/scenes/scene-history',
    );

    await expect(useAppStore.getState().redo()).resolves.toBe(true);
    expect(fileMocks.deleteNodeFiles).toHaveBeenCalledWith(
      [director.data], expect.any(Set), 'project-1', [],
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
    expect(fileMocks.deleteNodeFiles).toHaveBeenCalledWith([child.data], expect.any(Set), expect.anything(), ['Group']);
    expect(useAppStore.getState().edges).toEqual([]);

    await expect(useAppStore.getState().undo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual([
      group.id,
      child.id,
      'node-b',
    ]);
    expect(useAppStore.getState().nodes[0].style).toEqual({ width: 400, height: 300 });
    expect(useAppStore.getState().groups).toEqual(groups);
    expect(fileMocks.restoreFromUndoTrash).toHaveBeenCalledWith('project/Group');

    await expect(useAppStore.getState().redo()).resolves.toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['node-b']);
    expect(useAppStore.getState().groups).toEqual([]);
  });

  it.each(['single', 'batch'])('deletes a whole group and restores its folder before files (%s)', async (mode) => {
    const folder = groupNode('group-folder');
    const child = { ...node('media-child', { filePath: 'project/Folder/image.png' }), parentId: folder.id };
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [folder, child],
      groups: [{ id: folder.id, name: 'Folder', nodeIds: [child.id], color: '#fff', createdAt: 0 }],
      history: [], historyIndex: -1,
    });
    if (mode === 'single') useAppStore.getState().deleteNode(folder.id);
    else useAppStore.getState().deleteNodesBatch([folder.id, child.id]);
    await vi.waitFor(() => expect(useAppStore.getState().nodes).toEqual([]));
    expect(fileMocks.deleteNodeFiles).toHaveBeenLastCalledWith([folder.data, child.data], expect.any(Set), 'project-1', ['Folder']);
    fileMocks.restoreFromUndoTrash.mockClear();
    await useAppStore.getState().undo();
    expect(fileMocks.restoreFromUndoTrash).toHaveBeenNthCalledWith(1, 'project/Folder');
    expect(fileMocks.restoreFromUndoTrash).toHaveBeenNthCalledWith(2, 'project/Folder/image.png');
    await useAppStore.getState().redo();
    expect(fileMocks.deleteNodeFiles).toHaveBeenLastCalledWith([folder.data, child.data], expect.any(Set), 'project-1', ['Folder']);
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
});


describe('history snapshot sharing', () => {
  it('reuses unchanged snapshot objects while keeping changed nodes detached from live state', () => {
    const a = node('a');
    const b = node('b');
    const edges: Edge[] = [{ id: 'edge', source: 'a', target: 'b' }];
    useAppStore.setState({ nodes: [a, b], edges });
    useAppStore.getState().commitToHistory();
    const first = useAppStore.getState().history[0];
    expect(first.nodes[0]).not.toBe(a);
    expect(first.nodes[0].data).not.toBe(a.data);
    const moved = { ...a, position: { x: 30, y: 40 } };
    useAppStore.setState({ nodes: [moved, b] });
    useAppStore.getState().commitToHistory();
    const second = useAppStore.getState().history[1];
    expect(second.nodes[1]).toBe(first.nodes[1]);
    expect(second.edges).toBe(first.edges);
    expect(second.groups).toBe(first.groups);
    expect(second.nodes[0]).not.toBe(first.nodes[0]);
    expect(second.nodes[0].position).not.toBe(moved.position);
    expect(first.nodes[0].position).toEqual({ x: 0, y: 0 });
    const history = useAppStore.getState().history;
    useAppStore.getState().commitToHistory();
    expect(useAppStore.getState().history).toBe(history);
  });

  it('keeps latest generated content through undo/redo and preserves branch semantics', async () => {
    useAppStore.setState({ nodes: [node('a', { output: '旧结果' })] });
    const commit = () => useAppStore.getState().commitToHistory();
    commit();
    useAppStore.setState((state) => ({ nodes: [{ ...state.nodes[0], position: { x: 20, y: 0 } }] }));
    commit();
    useAppStore.setState((state) => ({ nodes: [{ ...state.nodes[0], data: { ...state.nodes[0].data, output: '最新结果' } }] }));
    commit();
    expect(useAppStore.getState().history).toHaveLength(2);
    await useAppStore.getState().undo();
    expect(useAppStore.getState().nodes[0]).toMatchObject({ position: { x: 0, y: 0 }, data: { output: '最新结果' } });
    await useAppStore.getState().redo();
    expect(useAppStore.getState().nodes[0]).toMatchObject({ position: { x: 20, y: 0 }, data: { output: '最新结果' } });
    await useAppStore.getState().undo();
    useAppStore.setState((state) => ({ nodes: [{ ...state.nodes[0], position: { x: 50, y: 0 } }] }));
    commit();
    await useAppStore.getState().redo();
    expect(useAppStore.getState().nodes[0].position.x).toBe(50);
  });

  it('does not reuse snapshot content by node id across projects', () => {
    useAppStore.setState({ currentProjectId: 'first', nodes: [node('same', { output: 'first' })] });
    useAppStore.getState().commitToHistory();
    const first = useAppStore.getState().history[0];
    useAppStore.setState({ currentProjectId: 'second', history: [], historyIndex: -1, nodes: [node('same', { output: 'second' })] });
    useAppStore.getState().commitToHistory();
    const second = useAppStore.getState().history[0];
    expect(second.nodes[0]).not.toBe(first.nodes[0]);
    expect(second.nodes[0].data.output).toBe('second');
  });
});


it('does not write a late undo result into another project with matching node ids', async () => {
  const original = node('same');
  useAppStore.setState({ currentProjectId: 'first', nodes: [original] });
  useAppStore.getState().commitToHistory();
  const moved = { ...original, position: { x: 20, y: 0 } };
  useAppStore.setState({ nodes: [moved] });
  useAppStore.getState().commitToHistory();
  let release!: () => void;
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  fileMocks.resolveGroupUndoTrashPaths.mockImplementationOnce(async () => {
    reached();
    await pending;
    return [];
  });
  const undo = useAppStore.getState().undo();
  await started;
  useAppStore.setState({ currentProjectId: 'second', nodes: [{ ...moved, data: { ...moved.data, output: '第二项目' } }] });
  release();
  await undo;
  expect(useAppStore.getState().nodes[0]).toMatchObject({ position: { x: 20, y: 0 }, data: { output: '第二项目' } });
});
