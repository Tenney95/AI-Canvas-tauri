/**
 * history — 回归测试：shotlist photography history。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData, NodeGroup, ShotRow, WorkflowDefinition } from '../../src/types';
import { createCanvasNoteData } from '../../src/types';
import { saveModelPreference } from '../../src/services/modelPreferenceService';
import { workflowExecution } from '../../src/services/workflowExecutionService';
import { createWorkflowApiDraft } from '../../src/services/workflowApi/workflowApiDefinition';
import { useAppStore } from '../../src/store/useAppStore';
import { createNodeFileDeletionContext } from '../../src/store/store.nodes';
import { registerCanvasDeletionTests } from './history/canvasDeletion';
import { registerBatchHistoryTests } from './history/batchHistory';

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
  deleteNodeFiles: vi.fn<typeof import('../../src/services/fileService').deleteNodeFiles>(async () => undefined),
  deletedGroupFolderNames: (groups: NodeGroup[], deleted: ReadonlySet<string>) => groups.filter((group) =>
    deleted.has(group.id) || (group.nodeIds.length > 0 && group.nodeIds.every((id) => deleted.has(id)))).map((group) => group.name),
  resolveGroupUndoTrashPaths: vi.fn(async (names: string[]) => names.map((name) => `project/${name}`)),
  moveToUndoTrash: vi.fn(async () => undefined),
  resolveNodeUndoTrashPaths: vi.fn(async (data: BaseNodeData) => {
    const sceneId = data.directorScene?.sceneId ?? data.directorResultManifest?.sceneId;
    if (sceneId) return [`project/director/scenes/${sceneId}`];
    return data.filePath ? [data.filePath] : [];
  }),
  restoreUndoTrashForHistory: vi.fn<typeof import('../../src/services/fileService').restoreUndoTrashForHistory>(async () => 'untracked'),
  // 重做前会先确认文件属于当前项目，默认放行以保持既有断言
  isProjectOwnedFile: vi.fn(async () => true),
  // 撤销前要等文件暂存落定，默认立即完成
  waitForPendingNodeFileDeletions: vi.fn(async () => undefined),
  isFileMissing: vi.fn(async () => false),
}));
const nodeExitMocks = vi.hoisted(() => {
  const pending = new Set<Promise<unknown>>();
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
  trackNodeExitPreparation: (work: Promise<unknown>) => {
    nodeExitMocks.pending.add(work);
    void work.finally(() => nodeExitMocks.pending.delete(work));
  },
}));

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

describe('节点回收的实时引用保护', () => {
  it('回收前按作品绑定解析未保存的聊天消息和输入框上的参考图', () => {
    const sent = 'chat-ref-11111111-1111-4111-8111-111111111111.png';
    const draft = 'chat-ref-22222222-2222-4222-8222-222222222222.png';
    useAppStore.setState({ currentProjectId: 'project-1', messages: [{ id: 'message', conversationId: 'chat',
      role: 'user', content: `@image{${sent}|one}`, status: 'done', timestamp: 1 }],
      chatImageDrafts: { chat: [{ fileName: draft, label: 'two', size: 1 }] } });
    const context = createNodeFileDeletionContext(useAppStore.getState, [], new Set(), 'project-1');
    expect(context.getLiveKeepPaths((name) => `imports/root/${name}`)).toEqual(
      new Set([`imports/root/${sent}`, `imports/root/${draft}`]));
  });
  it('移动前重新读取新增节点及聊天引用，项目切换或待删节点变化时拒绝继续', () => {
    const removed = node('removed', { filePath: 'project/removed.png' });
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [removed], messages: [] });
    const context = createNodeFileDeletionContext(useAppStore.getState, [removed], new Set([removed.id]), 'project-1');
    expect(context.deletedNodeIds).toEqual([removed.id]);
    expect(context.getLiveKeepPaths()).toEqual(new Set());

    useAppStore.setState({ nodes: [removed, node('new-reference', { filePath: 'project/removed.png' })],
      messages: [{ id: 'message', conversationId: 'conversation', role: 'assistant', content: '', timestamp: 1, status: 'done',
        mediaResult: { id: 'media', kind: 'image', deliveryMode: 'chat', url: 'asset://project/chat.png',
          sourceUrl: '', filePath: 'project/chat.png', persistence: 'saved', prompt: '', modelId: '', provider: '', createdAt: 1 } }],
    });
    expect(context.getLiveKeepPaths()).toEqual(new Set(['project/removed.png', 'project/chat.png']));

    useAppStore.setState({ currentProjectId: 'project-2' });
    expect(context.getLiveKeepPaths()).toBeNull();
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [{ ...removed, data: { ...removed.data, filePath: 'project/replaced.png' } }] });
    expect(context.getLiveKeepPaths()).toBeNull();
  });
});

const historyFixture = { fileMocks, nodeExitMocks, node, groupNode, directorSceneReference, canvasNoteNode };
export type HistoryFixture = typeof historyFixture;

describe('shared canvas deletion', () => {
  registerCanvasDeletionTests(historyFixture);
});

describe('工作流模型与尺寸的新建偏好', () => {
  function setup(adapterType: NonNullable<WorkflowDefinition['adapterType']> = 'comfyui', category: 'ai-image' | 'ai-video' = 'ai-image') {
    const flow: WorkflowDefinition = { id: 'size-flow', name: '尺寸工作流', category, adapterType, fileName: '', createdAt: 1,
      fileContent: adapterType === 'comfyui' ? JSON.stringify({
        '515': { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '16:9 (Widescreen)', megapixels: 1.5 } },
      }) : '',
      ...(adapterType === 'runninghub' ? { runninghub: { version: 1 as const, kind: 'app' as const, remoteId: '123', connectionId: 'runninghub' as const,
        parameters: [
          { nodeId: '515', fieldName: 'aspect_ratio', label: '比例', type: 'string' as const, source: 'value' as const, defaultValue: '16:9 (Widescreen)' },
          { nodeId: '515', fieldName: 'megapixels', label: '分辨率', type: 'number' as const, source: 'value' as const, defaultValue: 1.5 },
        ] } } : {}),
      ...(adapterType === 'workflow-api' ? { workflowApi: { ...createWorkflowApiDraft().manifest, parameters: {
        aspect_ratio: { type: 'string' as const }, megapixels: { type: 'number' as const },
      } } } : {}),
    };
    const ratioKey = adapterType === 'comfyui' ? 'comfy-param::515::aspect_ratio' : adapterType === 'runninghub' ? '515::aspect_ratio' : 'workflow::aspect_ratio';
    const sizeKey = adapterType === 'comfyui' ? 'comfy-param::515::megapixels' : adapterType === 'runninghub' ? '515::megapixels' : 'workflow::megapixels';
    const sizes = { [ratioKey]: '9:16 (Portrait Widescreen)', [sizeKey]: '4' };
    useAppStore.setState({ nodes: [node('edited', { type: category, status: 'idle', prompt: '本轮正文' })], workflows: [flow], activeNodeId: 'edited' });
    useAppStore.getState().updateNodeData('edited', workflowExecution(flow));
    useAppStore.getState().updateNodeDataTransient('edited', { aspectRatio: '9:16', ...(category === 'ai-video' ? { seedanceRatio: '9:16' } : {}),
      workflowInputs: { ...sizes, '232': '本轮正文', reference: '@{image:旧素材}', seed: '42' } });
    return { flow, sizes };
  }

  function addEmpty(id = 'new', data: Partial<BaseNodeData> = {}) {
    useAppStore.getState().addNode(node(id, { type: 'ai-image', role: 'generator', status: 'idle', prompt: '',
      aspectRatio: '16:9', imageSize: '2K', nodeWidth: 280, nodeHeight: 158, ...data }));
    return useAppStore.getState().nodes.find((item) => item.id === id)!.data;
  }

  it.each(['comfyui', 'runninghub', 'workflow-api'] as const)('%s 新建恢复同一工作流和实际尺寸参数，重启状态后仍保留', (adapter) => {
    const { flow, sizes } = setup(adapter);
    const model = workflowExecution(flow);
    expect(addEmpty()).toMatchObject({ model: model.model, provider: model.provider, workflowId: flow.id,
      workflowInputs: sizes, aspectRatio: '9:16', nodeWidth: 158, nodeHeight: 280, batchCount: 1 });
    expect(useAppStore.getState().nodes[0].data.workflowInputs).toMatchObject({ seed: '42', reference: '@{image:旧素材}' });
    const stored = JSON.parse(localStorage.getItem('canvas-media-parameter-prefs')!)['ai-image'];
    expect(stored.workflowInputs).toEqual(sizes);
    expect(JSON.stringify(stored)).not.toMatch(/本轮正文|旧素材|seed/);
    useAppStore.setState({ ...useAppStore.getInitialState(), workflows: [flow] }, true);
    expect(addEmpty('reopened').workflowInputs).toEqual(sizes);
  });

  it('项目明确的比例和分辨率优先，旧工作流的字段不进入另一工作流', () => {
    const { flow } = setup();
    const other = { ...flow, id: 'other' };
    useAppStore.setState({ workflows: [flow, other] });
    const another = addEmpty('another', workflowExecution(other));
    expect(another.workflowInputs).toBeUndefined();
    expect(another.aspectRatio).toBe('16:9');
    useAppStore.setState({ currentProjectId: 'project', projects: [{ id: 'project', name: '项目',
      createdAt: 1, updatedAt: 1, settings: { generation: { imageAspectRatio: '1:1', imageSize: '1K' } } }] });
    expect(addEmpty('project')).toMatchObject({ workflowId: flow.id, imageSize: '1K', aspectRatio: '1:1',
      workflowInputs: {}, nodeWidth: 280, nodeHeight: 280 });
  });

  it('源文件、已有正文和显式尺寸不被偏好覆盖，后台回写不刷新最近偏好', () => {
    const { flow } = setup();
    const saved = localStorage.getItem('canvas-media-parameter-prefs');
    useAppStore.getState().updateNodeDataTransient('edited', { status: 'success', aspectRatio: '1:1', workflowInputs: {} });
    expect(localStorage.getItem('canvas-media-parameter-prefs')).toBe(saved);
    expect(addEmpty('source', { role: 'source', imageUrl: 'asset://source.png' }).workflowId).toBeUndefined();
    expect(addEmpty('prompted', { prompt: '已有正文', model: 'general/explicit', provider: 'general' })).toMatchObject({ model: 'general/explicit', aspectRatio: '16:9' });
    const explicit = addEmpty('explicit', { ...workflowExecution(flow), workflowInputs: { 'comfy-param::515::megapixels': '2' } });
    expect(explicit.workflowInputs?.['comfy-param::515::megapixels']).toBe('2');
    useAppStore.setState({ workflows: [] });
    expect(addEmpty('deleted').workflowId).toBeUndefined();
  });

  it('视频的新建比例同步外框，普通模型切回后仍沿用原有偏好机制', () => {
    const { sizes } = setup('comfyui', 'ai-video');
    expect(addEmpty('video', { type: 'ai-video' })).toMatchObject({ workflowId: 'size-flow', workflowInputs: sizes,
      seedanceRatio: '9:16', aspectRatio: '9:16', nodeWidth: 280, nodeHeight: 498 });
    saveModelPreference('ai-image', 'general/image');
    useAppStore.setState({ activeNodeId: 'ordinary', nodes: [node('ordinary', { type: 'ai-image', status: 'idle', model: 'general/image', provider: 'general' })] });
    useAppStore.getState().updateNodeData('ordinary', { aspectRatio: '4:3', imageSize: '4K' });
    const ordinary = addEmpty('ordinary-new');
    expect(ordinary).toMatchObject({ model: 'general/image', provider: 'general', aspectRatio: '4:3', imageSize: '4K',
      nodeWidth: 280, nodeHeight: 210 });
    expect(ordinary.workflowId).toBeUndefined();
  });
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

  it('matches reordered rows within each sheet and leaves text-only edits and manual timing alone', () => {
    const binding = { nodeId: 'sheet', rowId: 'row-1', kind: 'video' as const };
    const automatic = node('video', { type: 'ai-video', seedanceDuration: 5,
      shotlistProductionSource: { ...binding, durationSync: 'auto' } });
    const legacy = node('legacy', { type: 'ai-video', seedanceDuration: 9,
      shotlistProductionSource: { ...binding, nodeId: 'other' } });
    const manual = node('manual', { type: 'ai-video', seedanceDuration: 12,
      shotlistProductionSource: { ...binding, durationSync: 'manual' } });
    const overridden = node('overridden', { type: 'ai-video', seedanceDuration: 3,
      shotlistProductionSource: { ...binding, nodeId: 'other' } });
    const unrelated = node('unrelated', { type: 'ai-video', seedanceDuration: 5,
      shotlistProductionSource: { ...binding, nodeId: 'untouched', durationSync: 'auto' } });
    const sheet = source();
    useAppStore.setState({ nodes: [sheet,
      node('other', { type: 'ai-shotlist', shotlistRows: [{ id: 'row-1', shotNo: '1', duration: 8.4 }] }),
      automatic, legacy, manual, overridden, unrelated] });

    useAppStore.getState().updateNodeDataTransient('sheet', {
      shotlistRows: sheet.data.shotlistRows!.map((row) => ({ ...row, content: '只修改文字' })),
    });
    expect(useAppStore.getState().nodes.slice(2)).toEqual([automatic, legacy, manual, overridden, unrelated]);
    expect(useAppStore.getState().nodes[2]).toBe(automatic);

    useAppStore.getState().updateNodesDataBatch(['sheet', 'other'], { shotlistRows: [
      { id: 'row-2', shotNo: '1', duration: 7.2 },
      { id: 'row-1', shotNo: '2', duration: 6.1 },
    ] });
    const updated = useAppStore.getState().nodes;
    expect(updated[2].data.seedanceDuration).toBe(7);
    expect(updated[3].data.seedanceDuration).toBe(7);
    expect(updated[4]).toBe(manual);
    expect(updated[5]).toBe(overridden);
    expect(updated[6]).toBe(unrelated);
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

  it('adds image and shot list mentions to a closed AI previs editor without replacing the legacy prompt', () => {
    useAppStore.setState({
      currentProjectId: 'p',
      nodes: [
        { ...node('source', { label: '角色图', type: 'source-image', role: 'source' }), type: 'source-image' },
        { ...node('sheet', { label: '分镜表', type: 'ai-shotlist' }), type: 'ai-shotlist' },
        { ...node('target', { type: 'ai-director', role: 'source', directorRuntimeKind: 'ai-threejs',
          directorPrevisPrompt: '摄影机绕到正面' }), type: 'ai-director' },
      ],
      activeNodeId: null,
    });
    connect();
    expect(targetPrompt()).toBe('摄影机绕到正面 @{source:角色图}');
    expect(useAppStore.getState().connectSelectedNodes(['source', 'sheet'], 'target', 'p')).toBe(1);
    expect(targetPrompt()).toBe('摄影机绕到正面 @{source:角色图} @{sheet:分镜表}');
  });

  it.each([['lightweight-web', true], ['blender', true], ['ai-threejs', false]] as const)(
    'connects a director with runtime %s and auto-mention %s without inserting a mention',
    (runtime, enabled) => {
      useAppStore.setState({
        nodes: [node('source'), { ...node('target', { type: 'ai-director', role: 'source',
          directorRuntimeKind: runtime, prompt: '原描述' }), type: 'ai-director' }],
        config: { ...useAppStore.getState().config, autoMentionOnConnect: enabled },
        activeNodeId: 'target',
      });
      connect();
      expect(targetPrompt()).toBe('原描述');
      expect(useAppStore.getState().edges).toHaveLength(1);
    },
  );

  it('stores an empty AI previs draft after disconnecting the last reference in a legacy prompt', () => {
    useAppStore.setState({
      nodes: [
        node('source'),
        { ...node('target', { type: 'ai-director', role: 'source', directorRuntimeKind: 'ai-threejs',
          directorPrevisPrompt: '@{source:素材}' }), type: 'ai-director' },
      ],
      edges: [{ id: 'edge', source: 'source', target: 'target' }],
    });
    useAppStore.getState().onEdgesChange([{ type: 'remove', id: 'edge' }]);
    expect(targetPrompt()).toBe('');
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
  registerBatchHistoryTests(historyFixture);
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

describe('恢复基线后的新历史分支', () => {
  async function restoredBranch() {
    useAppStore.setState({ nodes: [node('branch-a')], edges: [], groups: [] });
    const state = useAppStore.getState();
    state.commitToHistory();
    useAppStore.setState({ nodes: [{ ...node('branch-a'), position: { x: 20, y: 0 } }] });
    state.commitToHistory();
    expect(await state.undo()).toBe(true);
    return state;
  }

  it('动作前去重恢复基线后，新动作立即满足界面撤销判据，且可撤销', async () => {
    const state = await restoredBranch();
    const restored = useAppStore.getState();
    expect(restored.historyIndex >= 0 && restored.history.length > 0).toBe(false);
    state.addNode(node('branch-b'));
    const edited = useAppStore.getState();
    // HistoryTimelinePanel 的按钮判据，不能仅检查 undo() 最终返回 true。
    expect(edited.historyIndex >= 0 && edited.history.length > 0).toBe(true);
    expect(await state.undo()).toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['branch-a']);
  });

  it('新动作截断旧重做且保留恢复基线，不让旧分支覆盖新内容', async () => {
    const state = await restoredBranch();
    const checkpoint = useAppStore.getState().history[0];
    state.addNode(node('branch-b'));
    expect(useAppStore.getState().history).toEqual([checkpoint]);
    expect(await state.redo()).toBe(false);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['branch-a', 'branch-b']);
    expect(await state.undo()).toBe(true);
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['branch-a']);
  });

  it('先完成修改再提交时仍保留恢复基线，且新分支能撤销重做', async () => {
    const state = await restoredBranch();
    useAppStore.setState({ nodes: [{ ...node('branch-a'), position: { x: 50, y: 0 } }] });
    state.commitToHistory();
    const edited = useAppStore.getState();
    expect(edited.historyIndex >= 0 && edited.history.length > 0).toBe(true);
    expect(await state.undo()).toBe(true);
    expect(useAppStore.getState().nodes[0].position.x).toBe(0);
    expect(await state.redo()).toBe(true);
    expect(useAppStore.getState().nodes[0].position.x).toBe(50);
  });
});

describe('冻结自动让位后的布局历史', () => {
  it.each(['locked', 'hidden'] as const)('其他节点的撤销重做保留%s目标的可见坐标与自动偏移', async (frozen) => {
    const source = { ...groupNode('frozen-layout-source'), position: { x: 0, y: 100 }, width: 220, height: 152,
      style: { width: 220, height: 152 }, data: { ...groupNode('frozen-layout-source').data,
        groupCollapsed: true, groupExpandedSize: { width: 1000, height: 600 } } };
    const target = { ...node('frozen-layout-target'), position: { x: 320, y: 100 }, width: 220, height: 152 };
    const other = { ...node('frozen-layout-other'), position: { x: -1000, y: -1000 } };
    useAppStore.setState({ nodes: [source, target, other], edges: [], groups: [] });
    const state = useAppStore.getState();
    const current = (id: string) => useAppStore.getState().nodes.find((item) => item.id === id)!;
    state.commitToHistory();
    state.toggleGroupCollapsed(source.id);
    expect(current(target.id)).toMatchObject({ position: { x: 1100, y: 100 }, data: { groupLayoutOffsetX: 780 } });
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === target.id
      ? { ...item, ...(frozen === 'locked' ? { draggable: false } : { hidden: true }) } : item) });
    state.onNodesChange([{ id: other.id, type: 'position', position: { x: -950, y: -1000 } }]);
    expect(await state.undo()).toBe(true);
    expect(current(other.id).position).toEqual(other.position);
    expect(current(target.id)).toMatchObject({ position: { x: 1100, y: 100 }, data: { groupLayoutOffsetX: 780 } });
    expect(await state.redo()).toBe(true);
    expect(current(other.id).position).toEqual({ x: -950, y: -1000 });
    expect(current(target.id)).toMatchObject({ position: { x: 1100, y: 100 }, data: { groupLayoutOffsetX: 780 } });
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === target.id
      ? { ...item, ...(frozen === 'locked' ? { draggable: true } : { hidden: false }) } : item) });
    state.toggleGroupCollapsed(source.id);
    expect(current(target.id).position).toEqual(target.position);
    expect(current(target.id).data.groupLayoutOffsetX ?? 0).toBe(0);
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


describe('strict interaction no-op boundaries', () => {
  it('keeps Store and node identities for repeated snapped position/select while preserving the final dragging transition', () => {
    const original = { ...node('dragged'), position: { x: 8, y: 16 }, selected: true, dragging: true };
    useAppStore.setState({ nodes: [original], selectedNodeIds: ['dragged'] });
    const before = useAppStore.getState(), notify = vi.fn();
    const unsubscribe = useAppStore.subscribe(notify);
    try {
      before.onNodesChange([{ type: 'position', id: original.id, position: { x: 8, y: 16 }, dragging: true },
        { type: 'select', id: original.id, selected: true }]);
      before.setSelectedNodeIds(['dragged']);
      expect(useAppStore.getState()).toBe(before);
      expect(notify).not.toHaveBeenCalled();
      before.onNodesChange([{ type: 'position', id: original.id, position: { x: 8, y: 16 }, dragging: false }]);
      expect(useAppStore.getState().nodes[0]).toMatchObject({ position: original.position, dragging: false });
      expect(notify).toHaveBeenCalledOnce();
      expect(useAppStore.getState().history).toBe(before.history);
    } finally { unsubscribe(); }
  });

  it('applies duplicate IDs in input order and leaves dimensions, mixed batches and absolute-position changes on the RF path', () => {
    useAppStore.setState({ nodes: [node('a')] });
    const state = useAppStore.getState();
    state.onNodesChange([{ type: 'select', id: 'a', selected: true }, { type: 'select', id: 'a', selected: false },
      { type: 'position', id: 'a', position: { x: 5, y: 6 } }, { type: 'position', id: 'a', position: { x: 5, y: 6 }, dragging: false }]);
    expect(useAppStore.getState().nodes[0]).toMatchObject({ selected: false, position: { x: 5, y: 6 }, dragging: false });
    const previous = useAppStore.getState().nodes;
    state.onNodesChange([{ type: 'position', id: 'a', position: { x: 5, y: 6 } },
      { type: 'dimensions', id: 'a', dimensions: { width: 320, height: 180 }, setAttributes: true }]);
    expect(useAppStore.getState().nodes).not.toBe(previous);
    expect(useAppStore.getState().nodes[0]).toMatchObject({ measured: { width: 320, height: 180 }, width: 320, height: 180 });
    const resized = useAppStore.getState().nodes;
    state.onNodesChange([{ type: 'position', id: 'a', positionAbsolute: { x: 30, y: 40 } }]);
    expect(useAppStore.getState().nodes).not.toBe(resized);
    const beforeMissing = useAppStore.getState().nodes;
    state.onNodesChange([{ type: 'select', id: 'missing', selected: false }]);
    expect(useAppStore.getState().nodes).toEqual(beforeMissing);
  });

  it('keeps selection order, undefined-to-false semantics and sequential edge selections', () => {
    useAppStore.setState({ nodes: [node('a'), node('b')], selectedNodeIds: ['a', 'b'],
      edges: [{ id: 'edge', source: 'a', target: 'b', selected: false }] });
    const state = useAppStore.getState();
    state.onEdgesChange([{ type: 'select', id: 'edge', selected: false }]);
    expect(useAppStore.getState()).toBe(state);
    state.onNodesChange([{ type: 'select', id: 'a', selected: false }]);
    expect(useAppStore.getState().nodes[0].selected).toBe(false);
    state.setSelectedNodeIds(['b', 'a']);
    expect(useAppStore.getState().selectedNodeIds).toEqual(['b', 'a']);
    state.onEdgesChange([{ type: 'select', id: 'edge', selected: true }, { type: 'select', id: 'edge', selected: false }]);
    expect(useAppStore.getState().edges[0].selected).toBe(false);
    expect(useAppStore.getState().edges).not.toBe(state.edges);
    expect(useAppStore.getState().history).toBe(state.history);
  });
});
