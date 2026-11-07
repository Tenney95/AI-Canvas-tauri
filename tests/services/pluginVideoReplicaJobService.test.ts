/**
 * pluginVideoReplicaJobService — 回归测试：covers more than six segments, submits once per segment and composes a trimmed full timeline with…。
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { PluginInvocationResources, PluginModelSummary, PluginNodeHostEffect, PluginVideoReplicaJobSummary, PluginVideoReplicaStart } from '../../src/types/plugin';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData, WorkflowDefinition, WorkflowIONode } from '../../src/types';
import type { MediaReference, VideoModelCapability } from '../../src/types/aiTypes';
import type { ResolvedMediaModel } from '../../src/types/media';
import type { GenerationLease } from '../../src/services/generationService';
import { VLM_MAX_IMAGES } from '../../src/services/ai/imageUtils';

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>, revision: 1, duration: 60, hasAudio: true,
  sourceDigest: 'source-content', referenceDigest: 'reference-content',
  fileDigests: new Map<string, string>(),
  sourcePath: 'G:/project/source.mp4', catalog: [] as PluginModelSummary[],
  capability: undefined as VideoModelCapability | undefined, model: {} as ResolvedMediaModel,
  subscribers: new Set<() => void>(), saved: [] as PluginVideoReplicaJobSummary[],
  generate: vi.fn(), materials: vi.fn(), effect: vi.fn(), paidVideo: vi.fn(), videoWrite: vi.fn(), compositeSave: vi.fn(),
  extract: vi.fn(), transcribe: vi.fn(), speech: vi.fn(), download: vi.fn(),
  createEditor: vi.fn(), updateEditor: vi.fn(), export: vi.fn(), exportStatus: vi.fn(), cancelExport: vi.fn(),
  probeGenerated: vi.fn(), fingerprint: vi.fn(), probeSource: vi.fn(),
  promptMedia: vi.fn(), promptReferences: vi.fn(), extractIO: vi.fn(), mediaInputs: vi.fn(), save: vi.fn(),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.state,
  subscribe: (fn: () => void) => { mocks.subscribers.add(fn); return () => mocks.subscribers.delete(fn); } } }));
vi.mock('../../src/services/plugins/pluginModelCatalog', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/plugins/pluginModelCatalog')>(),
  buildPluginModelCatalog: () => mocks.catalog,
}));
vi.mock('../../src/services/ai/videoModelCapabilityResolver', () => ({ resolveVideoModelCapability: () => mocks.capability }));
vi.mock('../../src/services/ai/generationRuntime', () => ({ resolveMediaModel: () => mocks.model }));
vi.mock('../../src/services/comfyUIWindowService', () => ({ extractComfyUIIONodes: mocks.extractIO }));
vi.mock('../../src/services/fs/assetImageMetadata', () => ({ fingerprintAssetImage: mocks.fingerprint }));
vi.mock('../../src/services/ai/promptResolver', () => ({
  resolvePromptToChatContent: async (text: string) => ({ content: text, textContent: text }),
  resolvePromptWithMediaRefs: mocks.promptMedia,
}));
vi.mock('../../src/services/plugins/pluginPromptReferenceService', () => ({
  rewritePluginPromptReferences: async (text: string) => text.replace('@{plugin-ref-opaque:角色}', '@{character:角色}'),
  resolvePluginPromptReferencesForModel: mocks.promptReferences,
}));
vi.mock('../../src/services/canvasDerivationGuard', () => ({
  registerCanvasDerivation: () => ({ baseRevision: mocks.revision }), completeCanvasDerivation: vi.fn(),
  isCanvasDerivationFresh: (guard: { baseRevision: number }) => guard.baseRevision === mocks.revision,
}));
vi.mock('../../src/services/plugins/pluginResourceService', () => ({
  mintPluginInvocationResources: async () => resources(), clearPluginInvocationResources: vi.fn(),
  resolvePluginResourceHostUrl: async () => 'asset://source.mp4',
  resolvePluginMediaWorkspaceInputs: mocks.mediaInputs,
}));
vi.mock('../../src/services/plugins/pluginRuntime', () => ({ executeNodePluginTool: mocks.materials, executePluginUiHostEffect: mocks.effect }));
vi.mock('../../src/services/plugins/pluginVideoReplicaAudioService', () => ({
  extractReplicaSegmentAudio: mocks.extract, transcribeReplicaSegmentAudio: mocks.transcribe,
  inspectReplicaSpeechModels: mocks.speech, prepareReplicaSpeechModels: mocks.download,
}));
vi.mock('../../src/services/videoEditorMediaService', () => ({
  createVideoInput: async () => ({ getPrimaryAudioTrack: async () => mocks.hasAudio ? {} : null, dispose: vi.fn() }),
  probeVideoSource: mocks.probeSource,
}));
vi.mock('../../src/services/videoEditorInspectionService', () => ({ probeControlledNode: mocks.probeGenerated }));
vi.mock('../../src/services/videoEditorControlService', () => ({ createControlledEditor: mocks.createEditor, updateControlledEditor: mocks.updateEditor }));
vi.mock('../../src/services/videoEditorExportService', () => ({
  startControlledExport: mocks.export, getControlledExport: mocks.exportStatus, cancelControlledExport: mocks.cancelExport,
}));
vi.mock('../../src/services/plugins/pluginVideoReplicaJobRepository', () => ({
  readPluginVideoReplicaJobs: async () => mocks.saved,
  recoverPluginVideoReplicaJob: (job: PluginVideoReplicaJobSummary) => ({ ...job, status: job.status === 'generating' ? 'unknown' : 'paused' }),
  savePluginVideoReplicaJob: async (job: PluginVideoReplicaJobSummary) => {
    await mocks.save(job);
    const copy = structuredClone(job); const index = mocks.saved.findIndex((item) => item.jobId === job.jobId);
    if (index < 0) mocks.saved.push(copy); else mocks.saved[index] = copy;
  },
}));

function resources(): PluginInvocationResources { return { self: [{ resourceId: 'source', origin: 'node-self', access: 'read',
  displayName: 'source.mp4', mediaType: 'video/mp4', size: 100, source: { nodeId: 'source' } }], incoming: [], inputs: {}, package: [], derived: [] }; }
const identity = { projectId: 'project', pluginId: 'replica', nodeId: 'source', sourceDigest: 'a'.repeat(64), revisionDigest: 'b'.repeat(64) };
const request: PluginVideoReplicaStart = { type: 'video.replicaJob.start', resourceId: 'source', modelId: 'general/video',
  analysisModelId: 'general/vision', character: '@{plugin-ref-opaque:角色}', controls: ['depth'], audioMode: 'original', transcribe: true };

function hostEffectResult(effect: PluginNodeHostEffect) {
  if (effect.type === 'video.detectShots') return { ok: true, value: { shots: [{ inPoint: effect.start, outPoint: effect.end }] } };
  if (effect.type === 'model.generate') return { ok: true, value: { text: '按时间顺序行走，摄影机推进。' } };
  if (effect.type === 'video.extractFrames') return { ok: true, value: {
    frames: (effect.samples ?? []).map((sample) => ({ resourceId: `frame-${sample.key}` })),
    contactSheetResourceId: 'frame-contact-sheet',
  } };
  throw new Error(`Unexpected host effect: ${effect.type}`);
}

function paidAnalysisCalls() {
  return mocks.effect.mock.calls.filter(([input]) => (input as { effect: PluginNodeHostEffect }).effect.type === 'model.generate');
}

function replacement(reference: MediaReference = { kind: 'image', origin: 'prompt', role: 'reference',
  url: 'asset://replacement.png', filePath: 'G:/project/replacement.png', sourceNodeId: 'character' }) {
  mocks.promptMedia.mockResolvedValue({ references: [reference], prompt: '替换角色', imageUrls: [], videoUrls: [], audioUrls: [] });
  mocks.promptReferences.mockResolvedValue({ prompt: '替换角色：图片1中的角色', imageUrls: reference.kind === 'image' ? [reference.url] : [] });
}

function configureComfy(classType = 'VHS_LoadVideo', withStoredIO = true) {
  const ioNodes: WorkflowIONode[] = [{ nodeId: 'load-video', type: 'video', title: '参考视频' }];
  const workflow: WorkflowDefinition = { id: 'workflow', name: '视频工作流', category: 'ai-video', fileName: 'workflow.json', createdAt: 1,
    fileContent: JSON.stringify({ 'load-video': { class_type: classType, inputs: { video: 'reference.mp4' } } }),
    ...(withStoredIO ? { ioNodes } : {}) };
  mocks.state.workflows = [workflow];
  mocks.catalog.push({ id: 'comfyui/workflow', provider: 'comfyui', category: 'video', name: '视频工作流' });
  mocks.capability = undefined;
  mocks.model = { configId: 'comfyui/workflow', provider: 'comfyui', requestModel: 'comfyui/workflow', workflowId: 'workflow' };
  mocks.extractIO.mockReturnValue(ioNodes);
  return workflow;
}

function append(nodes: Node<BaseNodeData>[], edges: Edge[] = []) {
  (mocks.state.nodes as Node<BaseNodeData>[]).push(...nodes);
  (mocks.state.edges as Edge[]).push(...edges); mocks.revision++;
  for (const listener of mocks.subscribers) listener();
}

function writeMockGenerationOutput(nodeId: string) {
  const node = (mocks.state.nodes as Node<BaseNodeData>[]).find((candidate) => candidate.id === nodeId)!;
  const filePath = `G:/project/${nodeId}-generated.mp4`;
  Object.assign(node.data, { filePath, videoUrl: `asset://${nodeId}-generated.mp4`, status: 'success' });
  mocks.videoWrite(nodeId);
  return filePath;
}

function context() {
  const permissions = ['node.read', 'node.write', 'models.read', 'models.invoke', 'files.connected.read', 'files.output.create', 'prompt.references.read'] as const;
  return { ...identity, resources: resources(), tool: { pluginId: 'replica', runtime: 'python', permissions,
    tool: { id: 'replicate', title: '复刻', resourceAccess: { self: true }, pythonExecution: { mediaWorkspace: true } } },
  resourceReadContext: { ...identity, invocationId: 'ui-invocation', baseRevision: mocks.revision, permissions, state: mocks.state } } as never;
}

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.saved = []; mocks.subscribers.clear();
  mocks.revision = 1; mocks.duration = 60; mocks.hasAudio = true; mocks.sourceDigest = 'source-content';
  mocks.referenceDigest = 'reference-content'; mocks.sourcePath = 'G:/project/source.mp4';
  mocks.fileDigests = new Map();
  mocks.catalog = [
    { id: 'general/video', provider: 'general', category: 'video', name: '30秒模型' },
    { id: 'general/vision', provider: 'general', category: 'text', name: '视觉', inputModalities: ['image', 'text'] },
  ];
  mocks.capability = { operations: ['video-to-video', 'image-to-video', 'text-to-video'], maxDuration: 30, minDuration: 2,
    maxVideoReferences: 8, maxAudioReferences: 8, maxImageReferences: 4 };
  mocks.model = { configId: 'general/video', provider: 'general', requestModel: 'general/video' };
  mocks.state = { currentProjectId: 'project', getCurrentRevision: () => mocks.revision,
    config: { providers: { relay: { baseUrl: 'https://model.invalid' } }, generalModels: [
      { id: 'video', providerConfigId: 'relay' }, { id: 'vision', providerConfigId: 'relay' },
    ] }, workflows: [], dramaAssets: {}, globalCharacters: [], projects: [], edges: [],
    installedPlugins: [{ ...identity, id: 'replica', enabled: true, manifest: { apiVersion: 2, runtime: 'python',
      requiredCapabilities: ['video.replicaPipeline'], permissions: ['node.read', 'node.write', 'models.read', 'models.invoke', 'files.connected.read', 'files.output.create', 'prompt.references.read'] } }],
    nodes: [{ id: 'source', type: 'source-video', position: { x: 100, y: 200 }, data: { type: 'source-video', videoUrl: 'asset://source.mp4', filePath: 'G:/project/source.mp4' } },
      { id: 'character', type: 'ai-text', position: { x: 0, y: 0 }, data: { type: 'ai-text', output: '角色设定' } }],
    addNodesWithEdges: append, showToast: vi.fn(), startVideoBatch: mocks.generate,
  };
  mocks.generate.mockImplementation(async (_projectId, preflight: Array<{ nodeId: string }>, lease?: GenerationLease) => {
    await lease?.assertFresh(); mocks.paidVideo();
    writeMockGenerationOutput(preflight[0].nodeId); return { items: [{ status: 'success' }] };
  });
  mocks.fingerprint.mockImplementation(async (path: string) => ({ digest: path === mocks.sourcePath ? mocks.sourceDigest
    : path.startsWith('G:/project/replacement.') ? mocks.referenceDigest : mocks.fileDigests.get(path) ?? `original-content:${path}`, bytes: 100 }));
  mocks.promptMedia.mockResolvedValue({ references: [], prompt: '', imageUrls: [], videoUrls: [], audioUrls: [] });
  mocks.promptReferences.mockResolvedValue({ prompt: '替换角色：角色', imageUrls: [] });
  mocks.extractIO.mockReturnValue([]); mocks.mediaInputs.mockImplementation(async () => [{ resourceId: 'source', path: mocks.sourcePath }]);
  mocks.save.mockResolvedValue(undefined);
  mocks.probeSource.mockImplementation(async () => ({ duration: mocks.duration, width: 1280, height: 720, decodable: true }));
  mocks.speech.mockResolvedValue({ ready: true }); mocks.download.mockResolvedValue(undefined);
  mocks.extract.mockImplementation(async ({ start, end, referenceDuration }: { start: number; end: number; referenceDuration?: number }) => ({
    filePath: `G:/project/audio-${start}-${end}-${referenceDuration ?? end - start}.wav`, fileName: 'audio.wav',
    assetUrl: `asset://audio-${start}-${end}.wav`, duration: end - start,
  })); mocks.transcribe.mockResolvedValue('保留这段对白');
  mocks.effect.mockImplementation(async ({ effect }: { effect: PluginNodeHostEffect }) => hostEffectResult(effect));
  mocks.materials.mockImplementation(async (_tool, _source, parameters: { controls: string[]; shots: Array<{ key: string; frameResourceId?: string }> }, _lease,
    hostTask: { materialLayout?: { position: { x: number; y: number }; nodeWidth: number; nodeHeight: number; gap: number } }) => {
    const layout = hostTask.materialLayout;
    const parentId = (mocks.state.nodes as Node<BaseNodeData>[]).find((node) => node.id === 'source')?.parentId;
    const nodes: Node<BaseNodeData>[] = parameters.shots.flatMap((shot) => parameters.controls.map((control) => ({
      id: `${shot.key}-${control}`, type: 'source-video', position: { x: 0, y: 0 }, ...(parentId ? { parentId } : {}),
      data: { type: 'source-video', label: shot.key, filePath: `G:/project/${shot.key}-${control}.mp4`, videoUrl: `asset://${shot.key}-${control}.mp4` } } as Node<BaseNodeData>)));
    for (const [index, node] of nodes.entries()) if (layout) {
      node.position = { x: layout.position.x, y: layout.position.y + index * (layout.nodeHeight + layout.gap) };
      Object.assign(node.data, { nodeWidth: layout.nodeWidth, nodeHeight: layout.nodeHeight });
    }
    if (parameters.shots.some((shot) => shot.frameResourceId)) nodes.push({ id: `${parameters.shots[0].key}-frame`, type: 'source-image',
      position: { x: 0, y: 0 }, data: { type: 'source-image', label: '首帧', filePath: `G:/project/${parameters.shots[0].key}-frame.jpg`,
        imageUrl: 'asset://analysis-frame.jpg', status: 'success' } });
    append(nodes); return { nodes, edges: [], nodeIdsByKey: {} };
  });
  mocks.probeGenerated.mockResolvedValue({ decodable: true, duration: 30 });
  mocks.createEditor.mockResolvedValue({ editorId: 'editor', version: 'v1' }); mocks.updateEditor.mockResolvedValue({ editorId: 'editor', version: 'v2' });
  mocks.export.mockImplementation(async (_context, _input, lease?: GenerationLease) => {
    await lease?.assertFresh(); return { jobId: 'export' };
  });
  mocks.exportStatus.mockReturnValue({ status: 'succeeded', nodeId: 'full-video', progress: 1 });
});

async function start(overrides: Partial<PluginVideoReplicaStart> = {}) {
  const service = await import('../../src/services/plugins/pluginVideoReplicaJobService');
  const result = await service.startPluginVideoReplicaJob(context(), { ...request, ...overrides });
  if (!('jobId' in result)) return { service, result };
  await vi.waitFor(() => expect(mocks.saved.at(-1)?.status).toMatch(/succeeded|failed|cancelled|unknown/));
  return { service, result, final: await service.getPluginVideoReplicaJob(identity, result.jobId) };
}

it('covers more than six segments, submits once per segment and composes a trimmed full timeline with original sound', async () => {
  const { final } = await start({ cuts: Array.from({ length: 13 }, (_, i) => (i + 1) * 4) });
  expect(final).toMatchObject({ status: 'succeeded', totalSegments: 14, completedSegments: 14, outputNodeId: 'full-video' });
  expect(mocks.generate).toHaveBeenCalledTimes(14); expect(mocks.materials).toHaveBeenCalledTimes(14);
  const tracks = mocks.updateEditor.mock.calls[0][1].tracks;
  expect(tracks[0].muted).toBe(true); expect(tracks[0].clips.at(-1)).toMatchObject({ timelineStart: 52, sourceIn: 0, sourceOut: 8 });
  expect(tracks[1]).toMatchObject({ kind: 'audio', clips: [{ kind: 'video', nodeId: 'source', sourceOut: 60 }] });
  expect(mocks.createEditor.mock.calls[0][1].nodeIds).toHaveLength(1);
  expect(mocks.materials.mock.calls.every((call) => call[4].materialsOnly === true)).toBe(true);
  expect(JSON.stringify(mocks.materials.mock.calls)).not.toContain('plugin-ref-opaque');
  expect((mocks.state.nodes as Node<BaseNodeData>[]).filter((node) => node.data.type === 'ai-video')[0].data.prompt).toContain('@{character:角色}');
  expect(JSON.stringify(final)).not.toContain('G:/');
});

it.each(['unknown', 'error'] as const)('stops after a %s submission, without retrying or composing partial output', async (status) => {
  mocks.generate.mockResolvedValueOnce({ items: [{ status }] });
  const { final } = await start();
  expect(final?.status).toBe(status === 'unknown' ? 'unknown' : 'failed');
  expect(mocks.generate).toHaveBeenCalledTimes(1); expect(mocks.materials).toHaveBeenCalledTimes(1); expect(mocks.export).not.toHaveBeenCalled();
});

it('keeps a background job bound to its starting epoch before every paid segment', async () => {
  const expectedContext = { kind: 'canvas' as const, schemaVersion: 2 as const, modelGeneration: 0,
    runtimeEpoch: 'fixture-process', projectId: 'project', projectEpoch: 0, canvasId: 'project', episodeId: null,
    canvasEpoch: 0, canvasRevision: 1 };
  mocks.state.projectExecutionContext = expectedContext;
  mocks.generate.mockImplementationOnce(async (_projectId, _preflight, lease?: GenerationLease) => {
    mocks.state.projectExecutionContext = { ...expectedContext, canvasEpoch: 1 };
    for (const subscriber of mocks.subscribers) subscriber();
    await lease?.assertFresh();
    mocks.paidVideo();
    return { items: [{ status: 'success' }] };
  });
  const service = await import('../../src/services/plugins/pluginVideoReplicaJobService');
  const summary = await service.startPluginVideoReplicaJob(Object.assign(context(), { expectedContext }), request);
  expect(summary).toHaveProperty('jobId');
  await vi.waitFor(() => expect(mocks.saved.at(-1)?.status).toMatch(/failed|cancelled|unknown/));
  expect(mocks.generate).toHaveBeenCalledOnce();
  expect(mocks.paidVideo).not.toHaveBeenCalled();
  expect(mocks.videoWrite).not.toHaveBeenCalled();
  expect(mocks.export).not.toHaveBeenCalled();
  expect(JSON.stringify(mocks.saved)).not.toContain('runtimeEpoch');
});

it('keeps transport exceptions uncertain and blocks a second paid start', async () => {
  mocks.generate.mockRejectedValueOnce(new Error('private transport details'));
  const { service, final } = await start();
  expect(final?.status).toBe('unknown'); expect(final?.error).not.toContain('private');
  await expect(service.startPluginVideoReplicaJob(context(), request)).rejects.toThrow('核对');
  expect(mocks.generate).toHaveBeenCalledTimes(1);
});

it('requests explicit speech model preparation before any media submission', async () => {
  mocks.speech.mockResolvedValue({ ready: false });
  const { result } = await start();
  expect(result).toEqual({ speechModelsRequired: true }); expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  await start({ downloadSpeech: true }); expect(mocks.download).toHaveBeenCalledTimes(1); expect(mocks.generate).toHaveBeenCalledTimes(2);
});

it.each(['speech', 'download'] as const)('preserves the safe %s failure before creating a job or submitting media', async (source) => {
  const { LocalSpeechModelError } = await import('../../src/services/onnxService');
  const cause = new LocalSpeechModelError('语音模型下载未完成，请切换下载来源后重试');
  if (source === 'download') mocks.speech.mockResolvedValue({ ready: false });
  mocks[source].mockRejectedValueOnce(cause);
  const failure = await start({ downloadSpeech: true }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ message: cause.message, cause });
  expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.materials).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.saved).toEqual([]);
});

it('reports cancellation instead of a model download error when startup was cancelled', async () => {
  const { LocalSpeechModelError } = await import('../../src/services/onnxService');
  const controller = new AbortController();
  mocks.speech.mockResolvedValue({ ready: false });
  mocks.download.mockImplementationOnce(async () => {
    controller.abort();
    throw new LocalSpeechModelError('语音模型下载未完成，请重试');
  });
  const service = await import('../../src/services/plugins/pluginVideoReplicaJobService');
  await expect(service.startPluginVideoReplicaJob(Object.assign(context(), { signal: controller.signal }), {
    ...request, downloadSpeech: true,
  })).rejects.toThrow('复刻启动已取消');
  expect(mocks.download).toHaveBeenCalledOnce(); expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.saved).toEqual([]);
});

it.each([
  ['HTTP 401 private credential https://private.invalid', '连接认证失败'],
  ['HTTP 429 rate limit', '请求被限流'],
  ['model does not support image inputs', '不支持本次图片输入'],
  ['HTTP 502 upstream private response', '服务或上游返回错误'],
  ['视觉输入最多允许 6 张图片', '超出宿主视觉输入'],
  ['读取参考图 1 失败 (404)', '参考图读取或格式转换失败'],
  ['模型返回结果为空', '未返回可解析的文字'],
  ['unknown failure involving vision-model private response', '尚未识别具体接口原因'],
])('explains a failed visual analysis without starting video generation or exposing provider details (%s)', async (error, expected) => {
  mocks.effect.mockImplementation(async ({ effect }: { effect: PluginNodeHostEffect }) => effect.type === 'model.generate'
    ? { ok: false, error } : hostEffectResult(effect));
  const { service, final } = await start();
  expect(final?.status).toBe('failed'); expect(final?.error).toContain(expected);
  expect(final?.error).not.toMatch(/private|credential|https?:/);
  expect(final?.completedSegments).toBe(0);
  expect(mocks.materials).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  expect(paidAnalysisCalls()).toHaveLength(1); expect(mocks.export).not.toHaveBeenCalled();
  expect(await service.findPluginVideoReplicaJob(identity)).toMatchObject({ jobId: final!.jobId, status: 'failed' });
});

it('keeps a cloned display snapshot in memory for reopening without persisting it or restoring old grants', async () => {
  const service = await import('../../src/services/plugins/pluginVideoReplicaJobService');
  const replicaUi = { version: 1, character: '原替换要求', duration: 60, frames: [{ format: 'jpeg', base64: 'AAAA', actualTime: 0 }] };
  const result = await service.startPluginVideoReplicaJob(Object.assign(context(), { uiParameters: { replicaUi, ignored: 'not a display snapshot' } }), request);
  if (!('jobId' in result)) throw new Error('missing job');
  replicaUi.character = '外部修改';
  expect(await service.getPluginVideoReplicaJobUiParameters(identity, result.jobId))
    .toEqual({ replicaUi: { ...replicaUi, character: '原替换要求' } });
  await vi.waitFor(() => expect(mocks.saved.at(-1)?.status).toBe('succeeded'));
  expect(JSON.stringify(mocks.saved)).not.toContain('原替换要求');
  expect(JSON.stringify(mocks.saved)).not.toContain('replicaUi');
  await expect(service.getPluginVideoReplicaJobUiParameters({ ...identity, nodeId: 'character' }, result.jobId)).rejects.toThrow('不属于');
});

it.each(['registered', 'apimart'] as const)('rejects the %s provider before preparation, paid calls or task persistence', async (provider) => {
  mocks.model = { ...mocks.model, provider };
  mocks.catalog = mocks.catalog.map((model) => ({ ...model, videoReplicaSupport: { supported: true } }));
  const service = await import('../../src/services/plugins/pluginVideoReplicaJobService');
  await expect(service.startPluginVideoReplicaJob(context(), request)).rejects.toThrow('请选择其他视频模型或工作流');
  expect(mocks.probeSource).not.toHaveBeenCalled();
  expect(mocks.fingerprint).not.toHaveBeenCalled();
  expect(mocks.effect).not.toHaveBeenCalled();
  expect(mocks.materials).not.toHaveBeenCalled();
  expect(mocks.extract).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.paidVideo).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.saved).toEqual([]);
});

it('stops if the source file content changes between preparation and submission', async () => {
  mocks.materials.mockImplementationOnce(async () => { mocks.sourceDigest = 'replacement-content'; return { nodes: [], edges: [], nodeIdsByKey: {} }; });
  const { final } = await start();
  expect(final).toMatchObject({ status: 'failed', completedSegments: 0 }); expect(mocks.generate).not.toHaveBeenCalled();
  expect(final?.error).toContain('文件已变更');
});

it('refuses a complete output when a generated segment is shorter than its source interval', async () => {
  mocks.probeGenerated.mockResolvedValue({ decodable: true, duration: 1 });
  const { final } = await start();
  expect(final?.status).toBe('failed'); expect(mocks.generate).toHaveBeenCalledTimes(2); expect(mocks.export).not.toHaveBeenCalled();
});

it.each(['model', 'mute'] as const)('uses the %s audio strategy without adding the original track', async (audioMode) => {
  await start({ audioMode }); const tracks = mocks.updateEditor.mock.calls[0][1].tracks;
  expect(tracks).toHaveLength(1); expect(tracks[0].muted).toBe(audioMode !== 'model');
  expect((mocks.state.nodes as Node<BaseNodeData>[]).filter((node) => node.data.type === 'ai-video').every((node) => node.data.generateAudio === (audioMode === 'model'))).toBe(true);
});

it('reports a silent source and avoids audio extraction or model download', async () => {
  mocks.hasAudio = false; mocks.speech.mockResolvedValue({ ready: false });
  const { final } = await start(); expect(final?.status).toBe('succeeded'); expect(final?.warnings?.join('')).toContain('没有音轨');
  expect(mocks.extract).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
});

it('cancel stops subsequent segments while an already submitted request finishes', async () => {
  let release!: () => void;
  mocks.generate.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { items: [{ status: 'success' }] }; });
  const service = await import('../../src/services/plugins/pluginVideoReplicaJobService');
  const summary = await service.startPluginVideoReplicaJob(context(), request);
  if (!('jobId' in summary)) throw new Error('missing job');
  await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
  await expect(service.getPluginVideoReplicaJob({ ...identity, nodeId: 'character' }, summary.jobId)).rejects.toThrow('不属于');
  await service.cancelPluginVideoReplicaJob(identity, summary.jobId); release();
  await vi.waitFor(() => expect(mocks.saved.at(-1)?.status).toBe('cancelled'));
  expect(mocks.generate).toHaveBeenCalledTimes(1); expect(mocks.export).not.toHaveBeenCalled();
});

it('changing the plugin revision stops the next segment and rejects the old observer identity', async () => {
  mocks.generate.mockImplementationOnce(async () => {
    const plugins = mocks.state.installedPlugins as Array<{ revisionDigest: string }>;
    plugins[0].revisionDigest = 'c'.repeat(64); for (const listener of mocks.subscribers) listener();
    return { items: [{ status: 'success' }] };
  });
  const service = await import('../../src/services/plugins/pluginVideoReplicaJobService');
  const summary = await service.startPluginVideoReplicaJob(context(), request);
  if (!('jobId' in summary)) throw new Error('missing job');
  await vi.waitFor(() => expect(mocks.saved.at(-1)?.status).toBe('cancelled'));
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  await expect(service.getPluginVideoReplicaJob(identity, summary.jobId)).rejects.toThrow('版本已变化');
});

it.each([30, 7])('uses one ComfyUI video upload slot and no image slots with a %i-second workflow setting', async (maxSegmentSeconds) => {
  configureComfy(); mocks.hasAudio = false;
  const { final } = await start({ modelId: 'comfyui/workflow', maxSegmentSeconds });
  const limit = Math.min(15, maxSegmentSeconds);
  expect(final).toMatchObject({ status: 'succeeded', totalSegments: Math.ceil(60 / limit) });
  expect(mocks.generate).toHaveBeenCalledTimes(Math.ceil(60 / limit));
  const nodes = mocks.state.nodes as Node<BaseNodeData>[];
  const generated = nodes.filter((node) => node.data.type === 'ai-video');
  expect(nodes.some((node) => node.data.type === 'source-image')).toBe(false);
  for (const node of generated) {
    expect(node.data).toMatchObject({ provider: 'comfyui', workflowId: 'workflow' });
    expect(node.data.seedanceDuration).toBeGreaterThan(0);
    expect(node.data.seedanceDuration).toBeLessThanOrEqual(limit);
    const sources = (mocks.state.edges as Edge[]).filter((edge) => edge.target === node.id)
      .map((edge) => nodes.find((candidate) => candidate.id === edge.source)?.data.type);
    expect(sources).toEqual(['source-video']);
  }
  for (const call of mocks.materials.mock.calls) {
    const shots = (call[2] as { shots: Array<{ referenceDuration: number }> }).shots;
    expect(shots).toHaveLength(1);
    expect(shots[0].referenceDuration).toBeLessThanOrEqual(limit);
  }
  expect(mocks.extractIO).not.toHaveBeenCalled();
});

it('extracts ComfyUI input declarations when the workflow has no stored IO nodes', async () => {
  const workflow = configureComfy('VHS_LoadVideo', false); mocks.hasAudio = false;
  const { final } = await start({ modelId: 'comfyui/workflow', maxSegmentSeconds: 30 });
  expect(final).toMatchObject({ status: 'succeeded', totalSegments: 4 });
  expect(mocks.extractIO).toHaveBeenCalledWith(workflow.fileContent);
  expect(mocks.generate).toHaveBeenCalledTimes(4);
});

it('rejects a ComfyUI path loader before any analysis, materials or generation submission', async () => {
  configureComfy('LoadVideoPath');
  await expect(start({ modelId: 'comfyui/workflow', maxSegmentSeconds: 30 })).rejects.toThrow();
  expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.materials).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.saved).toEqual([]);
});

it('does not infer a normal model capability from a user-selected segment duration', async () => {
  mocks.capability = undefined;
  await expect(start({ maxSegmentSeconds: 30 })).rejects.toThrow('未声明视频能力');
  expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.materials).not.toHaveBeenCalled(); expect(mocks.saved).toEqual([]);
});

it('starts with one control interval per segment when video reference support is explicit but its count is unknown', async () => {
  mocks.duration = 29.188;
  mocks.capability!.maxDuration = 15;
  mocks.capability!.maxVideoReferences = undefined;
  mocks.capability!.maxAudioReferences = undefined;
  replacement();
  const { final } = await start();
  expect(final?.status).toBe('succeeded');
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  expect(mocks.materials.mock.calls.map((call) => call[2].shots.map((shot: { inPoint: number; outPoint: number }) => [shot.inPoint, shot.outPoint])))
    .toEqual([[[0, 15]], [[15, 29.188]]]);
  expect(mocks.capability!.maxVideoReferences).toBeUndefined();
});

it('requires video reference support when both its operation and count declarations are absent', async () => {
  mocks.capability!.operations = undefined;
  mocks.capability!.maxVideoReferences = undefined;
  await expect(start()).rejects.toThrow('未明确声明视频参考能力');
  expect(mocks.speech).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.materials).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.saved).toEqual([]);
});

it('explains when selected control types exceed the declared video reference quota', async () => {
  mocks.capability!.maxVideoReferences = 1;
  await expect(start({ controls: ['depth', 'pose'] })).rejects.toThrow('最多支持 1 个参考视频');
  expect(mocks.materials).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.saved).toEqual([]);
});

it('reports unsupported resolution without returning untrusted parameter text', async () => {
  mocks.capability!.resolutions = ['720p'];
  await expect(start({ resolution: 'https://private.invalid/model?token=private-token' }))
    .rejects.toThrow(/^模型预检未通过：所选分辨率不受模型支持，请调整视频分辨率$/);
  expect(mocks.materials).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.saved).toEqual([]);
});

it.each([
  ['mediaInputs', '源视频授权'],
  ['fingerprint', '读取源视频文件'],
  ['probeSource', '源视频探测或解码'],
  ['promptMedia', '替换引用解析'],
  ['speech', '本地语音模型检查或准备'],
] as const)('identifies the %s startup failure without exposing its underlying details', async (mock, stage) => {
  const cause = new Error('G:/private/source.mp4 https://private.invalid/?token=private-token');
  mocks[mock].mockRejectedValueOnce(cause);
  const failure = await start().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ message: expect.stringContaining(stage), cause });
  expect((failure as Error).message).not.toMatch(/private|token=|G:\//);
  expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.materials).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.saved).toEqual([]);
});

it('does not reject preliminary reference checks because the generated prompt does not exist yet', async () => {
  mocks.capability!.inputConstraints = { promptMinCharacters: 1000 };
  mocks.effect.mockImplementation(async ({ effect }: { effect: PluginNodeHostEffect }) => effect.type === 'model.generate'
    ? { ok: true, value: { text: '按镜头顺序描述动作和构图。'.repeat(100) } } : hostEffectResult(effect));
  const { final } = await start();
  expect(final?.status).toBe('succeeded');
});

it('still enforces final prompt constraints and explains a rejection before submitting video', async () => {
  mocks.capability!.inputConstraints = { promptMinCharacters: 1000 };
  const { final } = await start();
  expect(final).toMatchObject({ status: 'failed', completedSegments: 0 });
  expect(final?.error).toContain('模型预检未通过：生成参数不符合模型要求');
  expect(paidAnalysisCalls()).toHaveLength(1); expect(mocks.generate).not.toHaveBeenCalled();
});

it('includes replacement video references in the initial quota check before paid analysis', async () => {
  mocks.capability!.maxVideoReferences = 2;
  mocks.speech.mockResolvedValue({ ready: false });
  replacement({ kind: 'video', origin: 'prompt', role: 'reference', url: 'asset://replacement.mp4', filePath: 'G:/project/replacement.mp4' });
  await expect(start({ downloadSpeech: true })).rejects.toThrow('替换引用与控制素材的总数超过模型参考额度');
  expect(mocks.speech).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.materials).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.saved).toEqual([]);
});

it('preserves the model image quota for replacement images instead of adding another extracted frame', async () => {
  mocks.capability!.maxImageReferences = 1; replacement();
  const { final } = await start();
  expect(final?.status).toBe('succeeded');
  const nodes = mocks.state.nodes as Node<BaseNodeData>[];
  expect(nodes.some((node) => node.data.type === 'source-image')).toBe(false);
  for (const generated of nodes.filter((node) => node.data.type === 'ai-video')) {
    const sources = (mocks.state.edges as Edge[]).filter((edge) => edge.target === generated.id)
      .map((edge) => nodes.find((node) => node.id === edge.source)?.data.type);
    expect(sources).not.toContain('source-image');
  }
});

it('uses replacement identity as the highest priority and never creates source-frame or explanatory nodes', async () => {
  mocks.duration = 12; replacement();
  const { final } = await start();
  expect(final?.status).toBe('succeeded');
  const created = (mocks.state.nodes as Node<BaseNodeData>[]).filter((node) => !['source', 'character'].includes(node.id));
  expect(created.every((node) => ['source-video', 'source-audio', 'ai-video'].includes(node.data.type))).toBe(true);
  const generated = created.find((node) => node.data.type === 'ai-video')!;
  expect(generated.data.prompt).toContain('@{character:角色}');
  expect(generated.data.prompt).toContain('优先级最高');
  expect(generated.data.prompt).toContain('主角的身份、面容、发型与服装以替换角色引用图');
  expect(paidAnalysisCalls()[0][0].effect.prompt).toContain('不把原角色的面容、发型、服装写成需要保留的要求');
  expect(mocks.materials.mock.calls.flatMap((call) => call[2].shots).every((shot) => !shot.frameResourceId)).toBe(true);
});

it('analyzes the authorized target character and scene together with the contact sheet, then uses the rewritten description', async () => {
  mocks.duration = 12; replacement();
  const images = ['asset://replacement.png', 'asset://replacement-scene.png'];
  mocks.promptReferences.mockResolvedValue({ prompt: '替换角色：图片1；替换场景：图片2', imageUrls: images });
  mocks.effect.mockImplementation(async ({ effect }: { effect: PluginNodeHostEffect }) => effect.type === 'model.generate'
    ? { ok: true, value: { text: '银灰色长发、深灰交领长袍的女侠坐在船头，摄影机向前推进。' } }
    : hostEffectResult(effect));
  const { final } = await start({ scene: '替换为指定场景' });
  expect(final?.status).toBe('succeeded');
  const [analysis] = paidAnalysisCalls()[0];
  expect(analysis.effect.imageUrls).toEqual(images);
  expect(analysis.effect.resourceIds).toEqual(['frame-contact-sheet']);
  expect([...analysis.trustedMediaReferences]).toEqual(images);
  expect(analysis.effect.prompt).toContain('前 2 张输入图是用户的替换参考图');
  expect(analysis.effect.prompt).toContain('替换角色：图片1；替换场景：图片2');
  expect(analysis.effect.prompt).toContain('最后一张是原视频关键帧联系表，不是替换参考图');
  expect(analysis.effect.prompt).toContain('不能只在开头追加一条替换指令、后文仍描述原主角');
  expect(paidAnalysisCalls()).toHaveLength(1);
  const generated = (mocks.state.nodes as Node<BaseNodeData>[]).find((node) => node.data.type === 'ai-video')!;
  expect(generated.data.prompt).toContain('银灰色长发、深灰交领长袍的女侠');
  expect(generated.data.prompt).toContain('角色、场景与风格以替换要求为准');
  expect(generated.data.prompt).toContain('@{character:角色}');
});

it('allows five distinct replacement images and one contact sheet without truncating or duplicating the request', async () => {
  mocks.duration = 12; replacement();
  const images = Array.from({ length: VLM_MAX_IMAGES - 1 }, (_, index) => `asset://replacement-${index}.png`);
  mocks.promptReferences.mockResolvedValue({ prompt: '替换角色参考图', imageUrls: [...images, images[0]] });
  const { final } = await start();
  expect(final?.status).toBe('succeeded');
  const [analysis] = paidAnalysisCalls()[0];
  expect(analysis.effect.imageUrls).toEqual(images);
  expect(analysis.effect.imageUrls.length + analysis.effect.resourceIds.length).toBe(VLM_MAX_IMAGES);
  expect(paidAnalysisCalls()).toHaveLength(1);
});

it('rejects too many analysis references before any paid or material step, while analysis remains optional', async () => {
  mocks.duration = 12; replacement();
  mocks.promptReferences.mockResolvedValue({ prompt: '替换角色参考图', imageUrls: Array.from({ length: VLM_MAX_IMAGES }, (_, index) => `asset://replacement-${index}.png`) });
  await expect(start()).rejects.toThrow('最多使用 5 张替换参考图');
  expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.materials).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
  const { final } = await start({ analysisModelId: undefined });
  expect(final?.status).toBe('succeeded'); expect(paidAnalysisCalls()).toHaveLength(0);
});

it('reuses one audio node for transcription and an identical model audio reference in each segment', async () => {
  mocks.duration = 29.188; mocks.capability!.maxDuration = 15;
  const { final } = await start();
  expect(final).toMatchObject({ status: 'succeeded', totalSegments: 2 });
  expect(mocks.extract).toHaveBeenCalledTimes(2); expect(mocks.transcribe).toHaveBeenCalledTimes(2);
  const audioNodes = (mocks.state.nodes as Node<BaseNodeData>[]).filter((node) => node.data.type === 'source-audio');
  expect(audioNodes).toHaveLength(2);
  for (const node of audioNodes) expect((mocks.state.edges as Edge[]).filter((edge) => edge.source === node.id)).toHaveLength(1);
});

it('places each segment in an aligned media row after existing siblings and preserves its parent group', async () => {
  mocks.duration = 29.188; mocks.capability!.maxDuration = 15;
  const existing = mocks.state.nodes as Node<BaseNodeData>[];
  existing[0].parentId = 'group'; existing[1].parentId = 'group';
  existing[1].position = { x: 8000, y: 900 }; existing[1].data.nodeWidth = 700;
  const originalPositions = existing.map((node) => ({ id: node.id, position: { ...node.position } }));
  const { final } = await start();
  expect(final?.status).toBe('succeeded');
  const nodes = mocks.state.nodes as Node<BaseNodeData>[];
  const generated = nodes.filter((node) => node.data.type === 'ai-video');
  const audio = nodes.filter((node) => node.data.type === 'source-audio');
  for (const [index, result] of generated.entries()) {
    const controlId = `${mocks.materials.mock.calls[index][2].shots[0].key}-depth`;
    const control = nodes.find((node) => node.id === controlId)!;
    expect([control.parentId, audio[index].parentId, result.parentId]).toEqual(['group', 'group', 'group']);
    expect([audio[index].position.y, result.position.y]).toEqual([control.position.y, control.position.y]);
    expect(control.position.x).toBeGreaterThanOrEqual(8780);
    expect(audio[index].position.x - control.position.x).toBe(380);
    expect(result.position.x - audio[index].position.x).toBe(380);
    if (index > 0) expect(result.position.y).toBeGreaterThanOrEqual(generated[index - 1].position.y + Number(generated[index - 1].data.nodeHeight) + 80);
  }
  for (const before of originalPositions) expect(nodes.find((node) => node.id === before.id)?.position).toEqual(before.position);
});

it('does not execute the plugin material tool when no controls were requested', async () => {
  mocks.duration = 12; mocks.hasAudio = false; replacement();
  const { final } = await start({ controls: [] });
  expect(final?.status).toBe('succeeded'); expect(mocks.materials).not.toHaveBeenCalled();
  expect(paidAnalysisCalls()).toHaveLength(1); expect(mocks.generate).toHaveBeenCalledTimes(1);
  const created = (mocks.state.nodes as Node<BaseNodeData>[]).filter((node) => !['source', 'character'].includes(node.id));
  expect(created.map((node) => node.data.type)).toEqual(['ai-video']);
});

it('rejects a source binding whose audio path differs from the authorized video', async () => {
  (mocks.state.nodes as Node<BaseNodeData>[])[0].data.filePath = 'G:/project/other.mp4';
  await expect(start()).rejects.toThrow('音轨来源不一致');
  expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
});

it('rechecks the native workspace path before processing each material batch', async () => {
  mocks.mediaInputs.mockResolvedValueOnce([{ resourceId: 'source', path: mocks.sourcePath }])
    .mockResolvedValue([{ resourceId: 'source', path: 'G:/project/replaced.mp4' }]);
  const { final } = await start();
  expect(final).toMatchObject({ status: 'failed', completedSegments: 0 });
  expect(final?.error).toContain('授权源视频已变化');
  expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.materials).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
});

it('keeps every ordered sample in one annotated contact sheet for visual analysis', async () => {
  mocks.duration = 12; mocks.hasAudio = false;
  mocks.effect.mockImplementation(async ({ effect }: { effect: PluginNodeHostEffect }) => effect.type === 'video.detectShots'
    ? { ok: true, value: { shots: [{ inPoint: 0, outPoint: 2 }, { inPoint: 2, outPoint: 9 }, { inPoint: 9, outPoint: 12 }] } }
    : hostEffectResult(effect));
  const { final } = await start();
  expect(final).toMatchObject({ status: 'succeeded', totalSegments: 1 });
  const effects = mocks.effect.mock.calls.map(([input]) => (input as { effect: PluginNodeHostEffect }).effect);
  expect(effects.map((effect) => effect.type)).toEqual(['video.detectShots', 'video.extractFrames', 'model.generate']);
  const extraction = effects.find((effect) => effect.type === 'video.extractFrames');
  const analysis = effects.find((effect) => effect.type === 'model.generate');
  if (extraction?.type !== 'video.extractFrames' || analysis?.type !== 'model.generate') throw new Error('missing effects');
  const samples = extraction.samples ?? [];
  expect(samples).toHaveLength(9); expect(analysis.resourceIds).toEqual(['frame-contact-sheet']);
  for (const [index, time] of [0.2, 1, 1.8, 2.7, 5.5, 8.3, 9.3, 10.5, 11.7].entries()) {
    expect(samples[index].time).toBeCloseTo(time);
  }
  expect(analysis.prompt).toContain('0.000–2.000秒；2.000–9.000秒；9.000–12.000秒');
  expect(analysis.prompt).toContain('从左到右、从上到下');
  expect(analysis.prompt).toContain('每镜依次提供前、中、后3帧');
  expect(mocks.materials.mock.calls[0][2].shots[0].frameResourceId).toBeUndefined();
});

it.each([1, 2, 8])('fits %i shots within the shared VLM image budget without dropping samples or retrying', async (shotCount) => {
  mocks.duration = 12; mocks.hasAudio = false;
  mocks.effect.mockImplementation(async ({ effect }: { effect: PluginNodeHostEffect }) => {
    if (effect.type === 'video.detectShots') return { ok: true, value: {
      shots: Array.from({ length: shotCount }, (_, index) => ({ inPoint: index * 12 / shotCount, outPoint: (index + 1) * 12 / shotCount })),
    } };
    if (effect.type === 'model.generate' && (effect.resourceIds?.length ?? 0) > VLM_MAX_IMAGES) {
      return { ok: false, error: `视觉输入最多允许 ${VLM_MAX_IMAGES} 张图片` };
    }
    return hostEffectResult(effect);
  });
  const { final } = await start();
  expect(final).toMatchObject({ status: 'succeeded', totalSegments: 1 });
  const effects = mocks.effect.mock.calls.map(([input]) => (input as { effect: PluginNodeHostEffect }).effect);
  const extraction = effects.find((effect) => effect.type === 'video.extractFrames');
  const analysis = effects.find((effect) => effect.type === 'model.generate');
  if (extraction?.type !== 'video.extractFrames' || analysis?.type !== 'model.generate') throw new Error('missing effects');
  expect(extraction.samples).toHaveLength(shotCount * 3);
  expect(analysis.resourceIds).toEqual(['frame-contact-sheet']);
  expect(paidAnalysisCalls()).toHaveLength(1); expect(mocks.generate).toHaveBeenCalledTimes(1);
});

it.each(['missing-sheet', 'partial-frames'] as const)('stops before either paid model when contact sheet input is incomplete (%s)', async (failure) => {
  mocks.duration = 12; mocks.hasAudio = false;
  mocks.effect.mockImplementation(async ({ effect }: { effect: PluginNodeHostEffect }) => {
    if (effect.type === 'video.detectShots') return { ok: true, value: {
      shots: Array.from({ length: 3 }, (_, index) => ({ inPoint: index * 4, outPoint: (index + 1) * 4 })),
    } };
    if (effect.type === 'video.extractFrames') return { ok: true, value: {
      frames: (effect.samples ?? []).slice(0, failure === 'partial-frames' ? 8 : 9)
        .map((sample) => ({ resourceId: `frame-${sample.key}` })),
      ...(failure === 'partial-frames' ? { contactSheetResourceId: 'frame-contact-sheet' } : {}),
    } };
    return hostEffectResult(effect);
  });
  const { final } = await start();
  expect(final).toMatchObject({ status: 'failed', completedSegments: 0 });
  expect(final?.error).toContain(failure === 'missing-sheet' ? '联系表未能准备' : '关键帧未能准备');
  expect(paidAnalysisCalls()).toHaveLength(0); expect(mocks.materials).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
});

it('stops before paid analysis when one generation segment contains more than eight natural shots', async () => {
  mocks.duration = 9; mocks.hasAudio = false;
  mocks.effect.mockImplementation(async ({ effect }: { effect: PluginNodeHostEffect }) => effect.type === 'video.detectShots'
    ? { ok: true, value: { shots: Array.from({ length: 9 }, (_, index) => ({ inPoint: index, outPoint: index + 1 })) } }
    : hostEffectResult(effect));
  const { final } = await start();
  expect(final).toMatchObject({ status: 'failed', completedSegments: 0 });
  expect(paidAnalysisCalls()).toHaveLength(0); expect(mocks.materials).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled(); expect(final?.error).toContain('镜头过密');
});

it.each(['source', 'replacement'] as const)('prevents paid analysis if the %s file changes during audio preparation', async (kind) => {
  if (kind === 'replacement') replacement();
  mocks.extract.mockImplementationOnce(async () => {
    if (kind === 'source') mocks.sourceDigest = 'new-source-content';
    else mocks.referenceDigest = 'new-reference-content';
    return null;
  });
  const { final } = await start();
  expect(final).toMatchObject({ status: 'failed', completedSegments: 0 });
  expect(paidAnalysisCalls()).toHaveLength(0); expect(mocks.materials).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
});

it.each([
  { stage: 'video.detectShots', kind: 'source', paid: 0 },
  { stage: 'video.detectShots', kind: 'replacement', paid: 0 },
  { stage: 'video.extractFrames', kind: 'source', paid: 0 },
  { stage: 'video.extractFrames', kind: 'replacement', paid: 0 },
  { stage: 'model.generate', kind: 'source', paid: 1 },
  { stage: 'model.generate', kind: 'replacement', paid: 1 },
] as const)('stops further submission when $kind changes while $stage is pending', async ({ stage, kind, paid }) => {
  if (kind === 'replacement') replacement();
  let reached = false; let release!: () => void;
  mocks.effect.mockImplementation(async ({ effect }: { effect: PluginNodeHostEffect }) => {
    if (effect.type === stage && !reached) {
      reached = true; await new Promise<void>((resolve) => { release = resolve; });
    }
    return hostEffectResult(effect);
  });
  const service = await import('../../src/services/plugins/pluginVideoReplicaJobService');
  const summary = await service.startPluginVideoReplicaJob(context(), request);
  if (!('jobId' in summary)) throw new Error('missing job');
  await vi.waitFor(() => expect(reached).toBe(true));
  if (kind === 'source') mocks.sourceDigest = 'new-source-content';
  else mocks.referenceDigest = 'new-reference-content';
  release();
  await vi.waitFor(() => expect(mocks.saved.at(-1)?.status).toBe('failed'));
  expect(paidAnalysisCalls()).toHaveLength(paid); expect(mocks.materials).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.paidVideo).not.toHaveBeenCalled();
});

it.each(['source', 'replacement', 'generated-node'] as const)('rejects a changed %s at the final generation lease check', async (kind) => {
  if (kind === 'replacement') replacement();
  mocks.save.mockImplementation(async (summary: PluginVideoReplicaJobSummary) => {
    if (summary.status !== 'generating') return;
    if (kind === 'source') mocks.sourceDigest = 'new-source-content';
    else if (kind === 'replacement') mocks.referenceDigest = 'new-reference-content';
    else (mocks.state.nodes as Node<BaseNodeData>[]).find((node) => node.id === summary.segmentNodeIds[0])!.data.prompt = '用户改变的生成内容';
  });
  const { final } = await start();
  expect(final).toMatchObject({ status: 'unknown', completedSegments: 0 });
  expect(mocks.generate).toHaveBeenCalledTimes(1); expect(mocks.paidVideo).not.toHaveBeenCalled();
  expect(mocks.export).not.toHaveBeenCalled();
});

it('rejects a model configuration changed while the initial video probe is pending', async () => {
  let reached = false; let release!: () => void;
  mocks.probeSource.mockImplementationOnce(async () => {
    reached = true; await new Promise<void>((resolve) => { release = resolve; });
    return { duration: 60, width: 1280, height: 720, decodable: true };
  });
  const service = await import('../../src/services/plugins/pluginVideoReplicaJobService');
  const pending = service.startPluginVideoReplicaJob(context(), request);
  await vi.waitFor(() => expect(reached).toBe(true));
  const config = mocks.state.config as { generalModels: Array<{ modelId?: string }> };
  config.generalModels[0].modelId = 'a-different-video-model';
  release();
  await expect(pending).rejects.toThrow('模型配置已变更');
  expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.materials).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.saved).toEqual([]);
});

it('rejects a source node changed while initial replacement references are being resolved', async () => {
  let reached = false; let release!: () => void;
  mocks.promptMedia.mockImplementationOnce(async () => {
    reached = true; await new Promise<void>((resolve) => { release = resolve; });
    return { references: [], prompt: '角色参考', imageUrls: [], videoUrls: [], audioUrls: [] };
  });
  const service = await import('../../src/services/plugins/pluginVideoReplicaJobService');
  const pending = service.startPluginVideoReplicaJob(context(), request);
  await vi.waitFor(() => expect(reached).toBe(true));
  (mocks.state.nodes as Node<BaseNodeData>[])[0].data.relativePath = 'other-video.mp4';
  release();
  await expect(pending).rejects.toThrow('源视频或模型配置已变更');
  expect(mocks.effect).not.toHaveBeenCalled(); expect(mocks.materials).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.saved).toEqual([]);
});

it.each(['source-video', 'source-audio'] as const)('checks captured %s content before submitting a paid video', async (type) => {
  let changedPath: string | undefined;
  mocks.save.mockImplementation(async (summary: PluginVideoReplicaJobSummary) => {
    if (summary.status !== 'generating') return;
    const media = (mocks.state.nodes as Node<BaseNodeData>[]).find((node) => node.id !== 'source' && node.data.type === type)!;
    changedPath = media.data.filePath;
    if (!changedPath) throw new Error('missing prepared media file');
    mocks.fileDigests.set(changedPath, 'externally-overwritten-content');
  });
  const { final } = await start();
  expect(changedPath).toBeDefined();
  expect(mocks.fingerprint.mock.calls.filter(([path]) => path === changedPath).length).toBeGreaterThan(1);
  expect(final).toMatchObject({ status: 'unknown', completedSegments: 0 });
  expect(mocks.generate).toHaveBeenCalledTimes(1); expect(mocks.paidVideo).not.toHaveBeenCalled();
  expect(mocks.videoWrite).not.toHaveBeenCalled(); expect(mocks.export).not.toHaveBeenCalled();
});

it('keeps a paid result unwritten if a control video is overwritten while the provider is pending', async () => {
  let reached = false; let release!: () => void;
  mocks.generate.mockImplementationOnce(async (_projectId, preflight: Array<{ nodeId: string }>, lease: GenerationLease) => {
    await lease.assertFresh(); mocks.paidVideo(); reached = true;
    await new Promise<void>((resolve) => { release = resolve; });
    await lease.assertFresh();
    writeMockGenerationOutput(preflight[0].nodeId);
    return { items: [{ status: 'success' }] };
  });
  const service = await import('../../src/services/plugins/pluginVideoReplicaJobService');
  const summary = await service.startPluginVideoReplicaJob(context(), request);
  if (!('jobId' in summary)) throw new Error('missing job');
  await vi.waitFor(() => expect(reached).toBe(true));
  const control = (mocks.state.nodes as Node<BaseNodeData>[]).find((node) => node.id !== 'source' && node.data.type === 'source-video')!;
  const originalPath = control.data.filePath!;
  mocks.fileDigests.set(originalPath, 'overwritten-during-provider-wait');
  release();
  await vi.waitFor(() => expect(mocks.saved.at(-1)?.status).toBe('unknown'));
  expect(control.data.filePath).toBe(originalPath);
  expect(mocks.paidVideo).toHaveBeenCalledTimes(1); expect(mocks.videoWrite).not.toHaveBeenCalled();
  expect(mocks.generate).toHaveBeenCalledTimes(1); expect(mocks.export).not.toHaveBeenCalled();
  const generated = (mocks.state.nodes as Node<BaseNodeData>[]).find((node) => node.id === mocks.saved.at(-1)?.segmentNodeIds[0]);
  expect(generated?.data.videoUrl).toBeUndefined();
});

it('binds generated video content into the export lease and prevents saving an overwritten composite source', async () => {
  let reached = false; let release!: () => void;
  mocks.export.mockImplementationOnce(async (_context, _input, lease: GenerationLease) => {
    await lease.assertFresh();
    mocks.exportStatus.mockReturnValue({ status: 'running', progress: 0.5 });
    void (async () => {
      reached = true; await new Promise<void>((resolve) => { release = resolve; });
      try {
        await lease.assertFresh(); mocks.compositeSave();
        mocks.exportStatus.mockReturnValue({ status: 'succeeded', nodeId: 'full-video', progress: 1 });
      } catch {
        mocks.exportStatus.mockReturnValue({ status: 'failed', progress: 0.5 });
      }
    })();
    return { jobId: 'export' };
  });
  const service = await import('../../src/services/plugins/pluginVideoReplicaJobService');
  const summary = await service.startPluginVideoReplicaJob(context(), request);
  if (!('jobId' in summary)) throw new Error('missing job');
  await vi.waitFor(() => expect(reached).toBe(true));
  const generated = (mocks.state.nodes as Node<BaseNodeData>[]).find((node) => node.id === mocks.saved.at(-1)?.segmentNodeIds[0])!;
  const originalPath = generated.data.filePath!;
  mocks.fileDigests.set(originalPath, 'externally-overwritten-generated-video');
  release();
  await vi.waitFor(() => expect(mocks.saved.at(-1)?.status).toBe('failed'), { timeout: 3000 });
  const final = await service.getPluginVideoReplicaJob(identity, summary.jobId);
  expect(generated.data.filePath).toBe(originalPath);
  expect(mocks.fingerprint.mock.calls.filter(([path]) => path === originalPath).length).toBeGreaterThan(1);
  expect(mocks.videoWrite).toHaveBeenCalledTimes(2); expect(mocks.compositeSave).not.toHaveBeenCalled();
  expect(mocks.export).toHaveBeenCalledTimes(1); expect(final.outputNodeId).toBeUndefined();
});
