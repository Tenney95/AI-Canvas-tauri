import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createStore } from 'zustand/vanilla';
import type { AppState } from '../../src/store/useAppStore';
import type { AppConfig, BaseNodeData } from '../../src/types';
import type { Node } from '@xyflow/react';
import type { CanvasContext } from '../../src/types/project';
// 应用由全局 Store 入口装配 slice；先按真实入口初始化，再构建下方独立事务夹具。
import { useAppStore } from '../../src/store/useAppStore';
import { createProjectSlice } from '../../src/store/store.projects';
import { createHistorySlice } from '../../src/store/store.history';
import { createNativeEpisode, createNativeProject, convertNativeProjectToSeries, listNativeProjectIdentities, readNativeProjectCapture, saveNativeCanvas,
  type NativeProjectAggregate } from '../../src/services/indexedDb/nativeProjectRepository';
import { prepareNativeMediaTask, recordNativeMediaSubmission, listNativeMediaTasks } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import * as nativeDelivery from '../../src/services/nativeMediaDelivery';
import { sha256BytesHex } from '../../src/services/mediaDataUrl';
import { videoInputFingerprintMaterial } from '../../src/services/videoBatchPlanning';
import type { ProjectCatalogEntry } from '../../src/services/projectModelRouter';
import type { EpisodeRecord, ProjectRecord } from '../../src/types/project';
import { hydrateNativeProjectView, nativeEpisodeDisplayNumbers, projectNativeCatalogEntry } from '../../src/store/nativeProjectView';
import { listEpisodes, projectMemoryOwnerId, resolveOpenTargetId, seriesOwnerId } from '../../src/store/store.utils';
import { nativeMediaInputMaterial } from '../../src/services/nativeMediaInput';
import { retainNativeMediaOutputs } from '../../src/services/indexedDb/nativeMediaCollectionRepository';

const nativeDisplayIo = vi.hoisted(() => ({ inspect: vi.fn(), assetUrl: vi.fn(), normalizeMedia: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (original) => ({ ...await original<typeof import('@tauri-apps/api/core')>(),
  invoke: async (command: string, input: unknown) => {
    if (command === 'inspect_project_archive_assets') return nativeDisplayIo.inspect(input);
    throw new Error(`unexpected native fixture command: ${command}`);
  } }));
vi.mock('../../src/services/fs/core', async (original) => ({ ...await original<typeof import('../../src/services/fs/core')>(),
  getProjectDataDir: vi.fn(async () => '/fixture/native'), getAssetUrlFromPath: nativeDisplayIo.assetUrl }));

// 仅替换本机 IO；Store action、串行保存队列与独立新库事务均使用真实实现。
vi.mock('../../src/services/fileService', async () => ({
  ...await vi.importActual<typeof import('../../src/services/fileService')>('../../src/services/fileService'),
  registerProjectFolders: vi.fn(), registerNativeProjectFolders: vi.fn(), syncNativeAssetSearchRoots: vi.fn(async () => {}),
  flushUndoTrashDirs: vi.fn(async () => {}),
}));
vi.mock('../../src/services/storageService', async () => ({
  ...await vi.importActual<typeof import('../../src/services/storageService')>('../../src/services/storageService'),
  normalizeProjectMediaNodes: nativeDisplayIo.normalizeMedia,
  serializeProjectRecord: vi.fn(async (record: import('../../src/services/storageService').ProjectSaveData) => ({ ...record,
    nodes: (record.nodes as Node<BaseNodeData>[]).map((node) => {
      if (!node.data.relativePath) return node;
      const data = { ...node.data };
      for (const key of ['imageUrl', 'videoUrl', 'audioUrl', 'output', 'sourceUrl', 'thumbnailUrl'] as const) {
        if (typeof data[key] === 'string' && data[key]) data[key] = data.relativePath;
      }
      delete data.filePath; return { ...node, data };
    }) })), restoreProjectRecord: vi.fn(async (record: unknown) => record),
}));
vi.mock('../../src/services/indexedDbService', async () => ({
  ...await vi.importActual<typeof import('../../src/services/indexedDbService')>('../../src/services/indexedDbService'),
  setLastActiveProjectId: vi.fn(async () => {}),
}));
vi.mock('../../src/services/projectModelRouter', async () => ({
  ...await vi.importActual<typeof import('../../src/services/projectModelRouter')>('../../src/services/projectModelRouter'),
  listProjectCatalog: async (): Promise<ProjectCatalogEntry[]> => (await listNativeProjectIdentities()).map((entry) => ({ dataModel: 'native', ...entry })),
}));
vi.mock('../../src/services/pollManager', async () => ({
  ...await vi.importActual<typeof import('../../src/services/pollManager')>('../../src/services/pollManager'),
  resumePendingTasks: vi.fn(async () => {}), getPendingTasksForProject: vi.fn(() => []),
}));

const root: ProjectRecord = { id: 'project', name: '作品', kind: 'series', createdAt: 1, updatedAt: 2, epoch: 1,
  dataFolder: 'folder', storageRootRef: 'root', storageBindings: [] };
const episode = (id: string, canvasId: string, orderRank: number): EpisodeRecord => ({ id, projectId: root.id, canvasId,
  name: id, orderRank, createdAt: 1, updatedAt: 2, epoch: 1, revision: 0,
  settingsPolicy: { mode: 'inherit' as const, overrides: {} } });

describe('新结构导航投影', () => {
  it('兼容缺省和重复集号，新增集号基于实际投影分配而不改已有记录', () => {
    const first = episode('episode-a', 'canvas-a', 0);
    const second = { ...episode('episode-b', 'canvas-b', 1), displayNo: 1 };
    const entry: Extract<ProjectCatalogEntry, { dataModel: 'native' }> = { dataModel: 'native', project: root,
      episodes: [second, first], episodeIds: [first.id, second.id], canvasIds: [first.canvasId, second.canvasId] };
    const view = projectNativeCatalogEntry(entry);
    expect(view.slice(1).map((item) => item.episodeNo)).toEqual([1, 2]);
    expect(nativeEpisodeDisplayNumbers([first, second])).toEqual([1, 2]);
    expect(nativeEpisodeDisplayNumbers([first, second]).reduce((max, number) => Math.max(max, number), 0) + 1).toBe(3);
    expect(first).not.toHaveProperty('displayNo');
    expect(second.displayNo).toBe(1);
    expect(nativeEpisodeDisplayNumbers([{ displayNo: 8 }, { displayNo: 1 }])).toEqual([8, 1]);
    expect(nativeEpisodeDisplayNumbers([{ displayNo: 1 }, {}, { displayNo: 2 }])).toEqual([1, 2, 3]);
    expect(nativeEpisodeDisplayNumbers([{}, { displayNo: 1 }, { displayNo: 2 }, { displayNo: 8 }])).toEqual([1, 3, 2, 8]);
    const reordered = projectNativeCatalogEntry({ ...entry, episodes: [{ ...first, orderRank: 1 }, { ...second, orderRank: 0 }] });
    expect(reordered.slice(1).map((item) => [item.id, item.episodeNo])).toEqual([['canvas-b', 1], ['canvas-a', 2]]);
    expect(nativeEpisodeDisplayNumbers([])).toEqual([]);
  });

  it('区分作品、分集和画布身份，并按分集顺序映射旧导航视图', () => {
    const entry: Extract<ProjectCatalogEntry, { dataModel: 'native' }> = { dataModel: 'native', project: root,
      episodes: [{ ...episode('episode-b', 'canvas-b', 1), displayNo: 1 }, { ...episode('episode-a', 'canvas-a', 0), displayNo: 8 }],
      episodeIds: ['episode-b', 'episode-a'], canvasIds: ['canvas-b', 'canvas-a'] };
    const view = projectNativeCatalogEntry(entry);
    expect(listEpisodes(view, root.id).map((item) => item.id)).toEqual(['canvas-a', 'canvas-b']);
    expect(resolveOpenTargetId(view, root.id)).toBe('canvas-a');
    expect(seriesOwnerId(view, 'canvas-a')).toBe(root.id);
    expect(view[1].episodeNo).toBe(8);
    expect(view[1].nativeView).toEqual({ projectId: root.id, episodeId: 'episode-a', canvasId: 'canvas-a', orderRank: 0, episodeRevision: 0 });
  });

  it('零集剧集只保留作品，不伪造画布或分集', () => {
    const view = projectNativeCatalogEntry({ dataModel: 'native', project: root, episodes: [], episodeIds: [], canvasIds: [] });
    expect(view).toHaveLength(1);
    expect(view[0].nativeView).toEqual({ projectId: root.id, episodeId: null, canvasId: null });
  });

  it('普通项目只投影真实主画布，关系缺失时停止', () => {
    const project = { ...root, kind: 'standalone' as const };
    const view = projectNativeCatalogEntry({ dataModel: 'native', project, episodes: [], episodeIds: [], canvasIds: ['canvas'] });
    expect(view[0]).toMatchObject({ id: 'canvas', nativeView: { projectId: root.id, episodeId: null, canvasId: 'canvas' } });
    expect(projectMemoryOwnerId(view, 'canvas')).toBe(root.id);
    expect(projectMemoryOwnerId([{ id: 'old', name: '旧项目', createdAt: 1, updatedAt: 1 }], 'old')).toBe('old');
    expect(() => projectNativeCatalogEntry({ dataModel: 'native', project, episodes: [], episodeIds: [], canvasIds: [] })).toThrow();
    expect(() => projectNativeCatalogEntry({ dataModel: 'native', project, episodes: [], episodeIds: ['orphan'], canvasIds: ['canvas'] })).toThrow();
  });

  it('只把已核验的共享正文和当前分集正文装入对应视图', () => {
    const current = episode('episode-a', 'canvas-a', 0);
    const entry: Extract<ProjectCatalogEntry, { dataModel: 'native' }> = { dataModel: 'native', project: root,
      episodes: [current], episodeIds: [current.id], canvasIds: [current.canvasId] };
    const canvas = { id: current.canvasId, projectId: root.id, episodeId: current.id, storageRootRef: 'root',
      nodes: [], edges: [], groups: [], epoch: 1, revision: 0, revisionScope: 'project' as const };
    const loaded = { selection: { project: root, episodes: [current], episode: current, canvas, changeRevision: 2,
      context: { projectId: root.id, projectEpoch: 1, episodeId: current.id, canvasId: canvas.id, canvasEpoch: 1, canvasRevision: 0 } },
      content: { projectId: root.id, script: '全剧正文', revisions: { source: 0, script: 1, storyGraph: 0, assets: 0 } },
      episodeContent: { episodeId: current.id, script: '本集正文', revision: 1, storageRootRef: 'root' } };
    const view = hydrateNativeProjectView(entry, loaded);
    expect(view[0].series?.script).toBe('全剧正文');
    expect(view[1].episodeScript).toBe('本集正文');
    expect(() => hydrateNativeProjectView(entry, { ...loaded, episodeContent: { ...loaded.episodeContent, episodeId: 'other' } })).toThrow();
    expect(() => hydrateNativeProjectView({ ...entry, project: { ...root, name: '已改名' } }, loaded)).toThrow();
  });
});

describe('新项目 Store 媒体投递与自动保存串行', () => {
  const projectId = 'p2-11111111-1111-4111-8111-111111111111';
  const canvasA = 'c2-22222222-2222-4222-8222-222222222222', canvasB = 'c2-33333333-3333-4333-8333-333333333333';
  const episodeA = 'e2-44444444-4444-4444-8444-444444444444', episodeB = 'e2-55555555-5555-4555-8555-555555555555';
  const mediaPath = `media/${'a'.repeat(64)}.mp4`;
  const mediaUrl = `asset://localhost/fixture/native/${mediaPath}`;
  const sourceNode = (): Node<BaseNodeData> => ({ id: 'video-node', type: 'ai-video', position: { x: 0, y: 0 }, data: {
    type: 'ai-video', label: '原视频', provider: 'volcengine', model: 'volcengine/doubao-seedance-2-5', prompt: '保留原请求', status: 'loading',
  } });
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('CustomEvent', class { type: string; constructor(type: string) { this.type = type; } });
    // 画布打开后的展示定时器不参与此夹具；fake-indexeddb 仍用真实异步调度。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    nativeDisplayIo.inspect.mockReset().mockImplementation(async ({ selectedPaths }: { selectedPaths: string[] }) => selectedPaths.map((path) => ({
      path, bytes: 10, sha256: /[a-f0-9]{64}/.exec(path)![0],
    })));
    nativeDisplayIo.assetUrl.mockReset().mockImplementation(async (path: string) => `asset://localhost${path}`);
    nativeDisplayIo.normalizeMedia.mockReset().mockImplementation(async (_projectId: string, nodes: Node<BaseNodeData>[]) => nodes);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function fixtureStore(aggregate: NativeProjectAggregate) {
    const entry: Extract<ProjectCatalogEntry, { dataModel: 'native' }> = { dataModel: 'native', project: aggregate.project,
      episodes: aggregate.episodes, episodeIds: aggregate.episodes.map((episode) => episode.id), canvasIds: aggregate.canvases.map((canvas) => canvas.id) };
    // 项目与历史 slice 使用真实 action；未参与本夹具的其他 slice 仅提供下方最小替身。
    return createStore<AppState>()((set, get, api) => ({
      ...createProjectSlice(set, get, api), ...createHistorySlice(set, get, api),
      currentProjectId: null, projectLoadStatus: 'ready', projectInitialized: true, projects: projectNativeCatalogEntry(entry),
      nodes: [], edges: [], groups: [], selectedNodeIds: [], globalCanvasRevision: 0, canvasRevision: 0,
      config: { providers: {}, generalModels: [] } as unknown as AppConfig, workflows: [], customStyles: [], agentTasks: [],
      getCurrentRevision: () => get().canvasRevision,
      incrementRevision: () => {
        const current = get(), revision = current.canvasRevision + 1, context = current.projectExecutionContext;
        set({ canvasRevision: revision, globalCanvasRevision: current.globalCanvasRevision + 1,
          ...(context?.kind === 'canvas' ? { projectExecutionContext: { ...context, canvasRevision: revision } } : {}) });
        return revision;
      },
      showToast: vi.fn(), loadConversationsForProject: vi.fn(async () => {}), repairInterruptedForProject: vi.fn(async () => {}),
      loadAgentTasksForProject: vi.fn(async () => {}), loadProjectMemoriesForProject: vi.fn(async () => {}),
    } as unknown as AppState));
  }
  async function fixture(sourceType: 'ai-video' | 'ai-image' | 'ai-animation' | 'ai-panorama' | 'ai-audio' = 'ai-video') {
    const initial = await createNativeProject({ projectId, name: '隔离剧集', kind: 'series' });
    const first = await createNativeEpisode({ projectId, expectedProjectEpoch: initial.project.epoch, episodeId: episodeA, canvasId: canvasA, name: '第一集' });
    const aggregate = await createNativeEpisode({ projectId, expectedProjectEpoch: first.project.epoch, episodeId: episodeB, canvasId: canvasB, name: '第二集' });
    await saveNativeCanvas({ projectId, expectedProjectEpoch: aggregate.project.epoch, canvasId: canvasA, episodeId: episodeA,
      expectedCanvasEpoch: 1, expectedCanvasRevision: 0, document: { nodes: [{ ...sourceNode(), type: sourceType, data: { ...sourceNode().data, type: sourceType } }], edges: [], groups: [] } });
    const store = fixtureStore(aggregate);
    expect(await store.getState().switchProject(canvasA)).toBe(canvasA);
    const context = store.getState().projectExecutionContext;
    if (context?.kind !== 'canvas') throw new Error('fixture canvas unavailable');
    const saved = await readNativeProjectCapture(projectId);
    const document = saved?.aggregate.canvases.find((canvas) => canvas.id === canvasA);
    if (!document) throw new Error('fixture document unavailable');
    const fingerprint = await sha256BytesHex(new TextEncoder().encode(sourceType === 'ai-video'
      ? videoInputFingerprintMaterial(store.getState().nodes[0], store.getState()) : nativeMediaInputMaterial(store.getState().nodes[0], store.getState(), 'media-input-v3')));
    const category = sourceType === 'ai-audio' ? 'audio' : sourceType === 'ai-video' ? 'video' : 'image';
    const prepared = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'video-node', providerConfigId: 'volcengine',
      providerBase: 'https://provider.example/api/v3', category, sourceCanvasRevision: document.revision, inputFingerprint: fingerprint,
      ...(sourceType !== 'ai-video' ? { fingerprintScheme: 'media-input-v3', modelRef: 'volcengine/fixture', protocolDigest: 'b'.repeat(64), requestFingerprint: 'c'.repeat(64) } : {}) });
    const receipt = await recordNativeMediaSubmission(prepared.operationId, prepared.lease, { taskId: 'original-paid-task' });
    const originalHistory = { nodes: [], edges: [], groups: [] };
    const agent = { id: 'agent-active', projectId: canvasA, status: 'running' } as AppState['agentTasks'][number];
    store.setState({ history: [originalHistory], historyIndex: 0, agentTasks: [agent] });
    return { store, receipt, context: context as CanvasContext, originalHistory, agent };
  }

  it.each(['standalone', 'existing-conflict'] as const)('Store 实际新增分集处理 %s 集号并保留原数据', async (scenario) => {
    const initial = await createNativeProject({ projectId, canvasId: canvasA, name: '隔离作品' });
    let aggregate = initial;
    if (scenario === 'existing-conflict') {
      const converted = await convertNativeProjectToSeries({ projectId, expectedProjectEpoch: initial.project.epoch,
        expectedCanvasId: canvasA, expectedCanvasEpoch: initial.canvas!.epoch, expectedCanvasRevision: initial.canvas!.revision,
        expectedStandaloneRevision: 0, episodeId: episodeA, name: '原首集' });
      aggregate = await createNativeEpisode({ projectId, expectedProjectEpoch: converted.project.epoch,
        episodeId: episodeB, canvasId: canvasB, displayNo: 1, name: '历史重复号' });
    }
    const store = fixtureStore(aggregate);
    expect(await store.getState().switchProject(canvasA)).toBe(canvasA);
    const added = await store.getState().addEpisodes([{ name: '新分集' }]);
    expect(added).toHaveLength(1);
    const persisted = (await readNativeProjectCapture(projectId))!.aggregate;
    const first = persisted.episodes.find((episode) => episode.canvasId === canvasA)!;
    const created = persisted.episodes.find((episode) => episode.canvasId === added[0])!;
    expect(first.displayNo).toBeUndefined();
    expect(created.displayNo).toBe(scenario === 'standalone' ? 2 : 3);
    if (scenario === 'existing-conflict') expect(persisted.episodes.find((episode) => episode.id === episodeB)?.displayNo).toBe(1);
    const view = store.getState().projects.filter((item) => item.parentId === projectId);
    expect(view.find((item) => item.id === canvasA)?.episodeNo).toBe(1);
    expect(view.find((item) => item.id === added[0])?.episodeNo).toBe(scenario === 'standalone' ? 2 : 3);
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }
  function pauseBeforeDatabaseCommit() {
    const gate = deferred<void>(), entered = deferred<AbortSignal>();
    const actual = nativeDelivery.commitNativeMediaDelivery;
    vi.spyOn(nativeDelivery, 'commitNativeMediaDelivery').mockImplementation(async (input, options) => {
      if (!options?.signal) throw new Error('fixture expects cancellable delivery');
      entered.resolve(options.signal); await gate.promise;
      return actual(input, options);
    });
    return { gate, entered };
  }
  function pauseAfterDatabaseCommit() {
    const gate = deferred<void>(), entered = deferred<void>();
    const actual = nativeDelivery.commitNativeMediaDelivery;
    vi.spyOn(nativeDelivery, 'commitNativeMediaDelivery').mockImplementation(async (input, options) => {
      const result = await actual(input, options);
      entered.resolve(undefined); await gate.promise;
      return result;
    });
    return { gate, entered };
  }

  it('生成前只规范化目标与本轮引用，回补媒体身份但保留运行态、标签、位置与历史', async () => {
    const { store, context } = await fixture('ai-image');
    const target = { ...store.getState().nodes[0], data: { ...store.getState().nodes[0].data,
      prompt: '@{source:参考图}', imageUrl: 'asset://localhost/fixture/native/old.png', filePath: '/fixture/native/old.png' } };
    const source: Node<BaseNodeData> = { id: 'source', type: 'ai-image', position: { x: 20, y: 30 }, data: {
      type: 'ai-image', label: '参考图', status: 'success', imageUrl: 'asset://localhost/fixture/native/ref.png', filePath: '/fixture/native/ref.png',
    } };
    const unrelated: Node<BaseNodeData> = { ...source, id: 'unrelated' };
    store.setState({ nodes: [target, source, unrelated], edges: [{ id: 'reference', source: source.id, target: target.id }] });
    const { history, historyIndex } = store.getState();
    const gate = deferred<Node<BaseNodeData>[]>(); nativeDisplayIo.normalizeMedia.mockReturnValueOnce(gate.promise);
    const preparing = store.getState().normalizeNativeMediaGenerationInputs(target.id);
    expect(nativeDisplayIo.normalizeMedia).toHaveBeenCalledWith(context.canvasId, [target, source]);
    store.setState({ nodes: store.getState().nodes.map((node) => node.id === target.id ? {
      ...node, selected: true, position: { x: 35, y: 45 }, data: { ...node.data, label: '准备期间的新标签', status: 'idle' },
    } : node) });
    gate.resolve([target, source].map((node) => ({ ...node, data: { ...node.data,
      assetId: `asset-${node.id}`, relativePath: node.id === source.id ? 'ref.png' : 'old.png',
    } })));
    await preparing;
    expect(store.getState().nodes[0]).toMatchObject({ selected: true, position: { x: 35, y: 45 }, data: {
      label: '准备期间的新标签', status: 'idle', prompt: target.data.prompt, assetId: `asset-${target.id}`, relativePath: 'old.png',
    } });
    expect(store.getState().nodes[1].data).toMatchObject({ assetId: 'asset-source', relativePath: 'ref.png', imageUrl: source.data.imageUrl });
    expect(store.getState().nodes[2]).toBe(unrelated);
    expect(store.getState().history).toBe(history); expect(store.getState().historyIndex).toBe(historyIndex);
    expect((await listNativeMediaTasks(projectId))[0].status).toBe('submitted');
  });

  it.each(['prompt', 'media', 'source-media', 'source-input', 'switch', 'revision'] as const)('身份规范化期间%s变化时不覆盖真实编辑或回写另一画布', async (change) => {
    const { store } = await fixture('ai-image');
    const target = { ...store.getState().nodes[0], data: { ...store.getState().nodes[0].data,
      prompt: '@{source:参考图}', imageUrl: 'asset://localhost/fixture/native/original.png', filePath: '/fixture/native/original.png' } };
    const source: Node<BaseNodeData> = { id: 'source', type: 'ai-image', position: { x: 20, y: 30 }, data: {
      type: 'ai-image', label: '参考图', imageUrl: 'asset://localhost/fixture/native/source.png', filePath: '/fixture/native/source.png',
    } };
    store.setState({ nodes: [target, source], edges: [{ id: 'reference', source: source.id, target: target.id }] });
    const gate = deferred<Node<BaseNodeData>[]>(); nativeDisplayIo.normalizeMedia.mockReturnValueOnce(gate.promise);
    const pending = store.getState().normalizeNativeMediaGenerationInputs(target.id);
    if (change === 'prompt' || change === 'media') store.setState({ nodes: [{ ...target, data: { ...target.data,
      ...(change === 'prompt' ? { prompt: '用户的新提示词' } : { imageUrl: 'asset://localhost/fixture/native/replaced.png' }),
    } }, source] });
    else if (change === 'source-media' || change === 'source-input') store.setState({ nodes: [target, { ...source, data: { ...source.data,
      ...(change === 'source-media' ? { imageUrl: 'asset://localhost/fixture/native/replaced-ref.png' } : { workflowInputs: { changed: '用户修改' } }),
    } }] });
    else if (change === 'switch') store.setState({ currentProjectId: canvasB });
    else store.getState().incrementRevision();
    const latestNodes = store.getState().nodes;
    gate.resolve([{ ...target, data: { ...target.data, assetId: 'asset-prepared', relativePath: 'original.png' } }]);
    await expect(pending).rejects.toThrow(/变化/);
    expect(store.getState().nodes).toBe(latestNodes);
    expect(store.getState().nodes[0].data.assetId).toBeUndefined();
  });

  it('媒体短准备占用既有保存队列，同输入自动保存等待POST前释放且每次准备独立推进版本', async () => {
    const { store, context } = await fixture();
    const before = (await readNativeProjectCapture(projectId))!.aggregate.canvases.find((item) => item.id === canvasA)!;
    const preparation = await store.getState().beginNativeMediaSubmissionPreparation(context);
    expect(preparation.canvasRevision).toBe(before.revision + 1); preparation.assertCurrent();
    let completed = false;
    const queuedSave = store.getState().saveCurrentProjectSilent().then((id) => { completed = true; return id; });
    const held = (await readNativeProjectCapture(projectId))!.aggregate.canvases.find((item) => item.id === canvasA)!;
    expect(held.revision).toBe(preparation.canvasRevision); expect(completed).toBe(false);
    preparation.release(); preparation.release();
    expect(await queuedSave).toBe(canvasA); expect(() => preparation.assertCurrent()).toThrow('已释放');
    const after = (await readNativeProjectCapture(projectId))!.aggregate.canvases.find((item) => item.id === canvasA)!;
    expect(after.revision).toBe(preparation.canvasRevision + 1);
    const second = await store.getState().beginNativeMediaSubmissionPreparation(context);
    try { expect(second.canvasRevision).toBe(after.revision + 1); second.assertCurrent(); }
    finally { second.release(); }
    expect(store.getState().nodes).toEqual(before.nodes);
  });

  it('准备屏障不放宽原输入或runtime守卫，异常后释放仍允许原保存队列继续', async () => {
    const { store, receipt, context } = await fixture();
    const preparation = await store.getState().beginNativeMediaSubmissionPreparation(context);
    const { assertNativeVideoSubmissionInput } = await import('../../src/services/nativeVideoSubmission');
    vi.spyOn(useAppStore, 'getState').mockImplementation(() => store.getState());
    const original = store.getState().nodes;
    try {
      store.setState({ nodes: original.map((node) => ({ ...node, data: { ...node.data, prompt: '准备期间的新输入' } })) });
      await expect(assertNativeVideoSubmissionInput(receipt, context)).rejects.toThrow('输入');
      store.setState({ projectExecutionContext: { ...context, runtimeEpoch: 'other-runtime' } });
      expect(() => preparation.assertCurrent()).toThrow('上下文');
    } finally {
      store.setState({ nodes: original, projectExecutionContext: context }); preparation.release();
    }
    expect(await store.getState().saveCurrentProjectSilent()).toBe(canvasA);
  });

  it('活动 Agent 和 loading 视频可以交付，保留运行上下文和既有历史，只追加一次快照', async () => {
    const { store, receipt, context, originalHistory, agent } = await fixture();
    const revision = store.getState().getCurrentRevision();
    await store.getState().commitNativeMediaResult(receipt, mediaPath, context);
    const state = store.getState();
    expect(state.projectExecutionContext).toMatchObject({ runtimeEpoch: context.runtimeEpoch, canvasId: canvasA, episodeId: episodeA, projectEpoch: context.projectEpoch });
    expect(state.getCurrentRevision()).toBe(revision + 1);
    expect(state.agentTasks).toEqual([agent]); expect(state.agentTasks[0]).toBe(agent);
    expect(state.history).toHaveLength(2); expect(state.history[0]).toBe(originalHistory); expect(state.historyIndex).toBe(1);
    expect(state.nodes[0].data).toMatchObject({ status: 'success', relativePath: mediaPath, videoUrl: mediaUrl });
    expect((await listNativeMediaTasks(projectId))[0]).toMatchObject({ status: 'delivered', remoteTaskId: 'original-paid-task', resultRelativePath: mediaPath });
  });

  it.each(['ai-image', 'ai-video', 'ai-audio', 'ai-animation', 'ai-panorama'] as const)('%s的完整混合候选即使通用恢复隐藏展示字段，也按本回执原根SHA回填所有结果', async (sourceType) => {
    const { store, receipt, context } = await fixture(sourceType);
    const categories = [receipt.category, ...(['image', 'video', 'audio'] as const).filter((kind) => kind !== receipt.category)];
    const files = categories.map((category, ordinal) => {
      const sha256 = String.fromCharCode(100 + ordinal).repeat(64);
      return { category, relativePath: category === 'image' ? `imports/retained-${sha256}/${sha256}.png` : `media/${sha256}.${category === 'video' ? 'mp4' : 'wav'}`, bytes: 10, sha256 };
    });
    const retained = await retainNativeMediaOutputs(receipt, files);
    const storage = await import('../../src/services/storageService');
    vi.mocked(storage.restoreProjectRecord).mockImplementationOnce(async (record) => ({ ...record,
      nodes: (record.nodes as Node<BaseNodeData>[]).map((node) => ({ ...node, data: { ...node.data,
        imageUrl: undefined, videoUrl: undefined, audioUrl: undefined, output: undefined, sourceUrl: undefined, thumbnailUrl: undefined,
        __nativeUnavailableMediaFields: ['imageUrl', 'videoUrl', 'audioUrl', 'output'] } })) }));
    await store.getState().commitNativeMediaResult(retained, files[0].relativePath, context);
    const displayed = store.getState().nodes;
    expect(displayed).toHaveLength(files.length);
    for (const [ordinal, file] of files.entries()) {
      const node = displayed[ordinal], mediaKey = file.category === 'image' ? 'imageUrl' : file.category === 'video' ? 'videoUrl' : 'audioUrl';
      expect(node.data).toMatchObject({ status: 'success', relativePath: file.relativePath, [mediaKey]: `asset://localhost/fixture/native/${file.relativePath}`,
        output: `asset://localhost/fixture/native/${file.relativePath}`, filePath: `/fixture/native/${file.relativePath}` });
      expect(node.data.__nativeUnavailableMediaFields).toBeUndefined();
    }
    const saved = (await readNativeProjectCapture(projectId))!.aggregate.canvases.find((canvas) => canvas.id === canvasA)!;
    for (const [ordinal, file] of files.entries()) expect((saved.nodes[ordinal] as Node<BaseNodeData>).data).toMatchObject({ relativePath: file.relativePath, output: file.relativePath });
    expect((await listNativeMediaTasks(projectId))[0]).toMatchObject({ status: 'delivered', localResults: files });
  });

  it.each(['sha', 'url'] as const)('本机候选%s证据失败时不把空白展示提交为delivered', async (failure) => {
    const { store, receipt, context } = await fixture('ai-image');
    const file = { category: 'image' as const, relativePath: `media/${'d'.repeat(64)}.png`, sha256: 'd'.repeat(64), bytes: 10 };
    const retained = await retainNativeMediaOutputs(receipt, [file]);
    if (failure === 'sha') nativeDisplayIo.inspect.mockResolvedValue([{ path: file.relativePath, bytes: 10, sha256: 'e'.repeat(64) }]);
    else nativeDisplayIo.assetUrl.mockResolvedValue('https://example.invalid/unrelated.png');
    await expect(store.getState().commitNativeMediaResult(retained, file.relativePath, context)).rejects.toThrow('展示');
    expect(store.getState().nodes[0].data.status).toBe('loading');
    expect((await listNativeMediaTasks(projectId))[0]).toMatchObject({ status: 'submitted', localResults: [file] });
    const saved = (await readNativeProjectCapture(projectId))!.aggregate.canvases.find((canvas) => canvas.id === canvasA)!;
    expect((saved.nodes[0] as Node<BaseNodeData>).data.imageUrl).toBeUndefined();
  });

  it('交付等待期间编辑画布会中止事务，保留新编辑和原付费回执', async () => {
    const { store, receipt, context, originalHistory } = await fixture();
    const paused = pauseBeforeDatabaseCommit();
    const delivery = store.getState().commitNativeMediaResult(receipt, mediaPath, context);
    const signal = await Promise.race([paused.entered.promise, delivery.then(() => { throw new Error('fixture expected paused commit'); })]);
    store.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, position: { x: 200, y: 100 } })) }));
    expect(signal.aborted).toBe(true);
    const failed = expect(delivery).rejects.toThrow(); paused.gate.resolve(undefined); await failed;
    expect(store.getState().nodes[0].position).toEqual({ x: 200, y: 100 });
    expect(store.getState().history).toEqual([originalHistory]);
    expect((await listNativeMediaTasks(projectId))[0].status).toBe('submitted');
    const canvas = (await readNativeProjectCapture(projectId))!.aggregate.canvases.find((item) => item.id === canvasA)!;
    expect((canvas.nodes[0] as Node<BaseNodeData>).data.videoUrl).toBeUndefined();
  });

  it('交付期间切到另一集会撤销原结果写入，另一集不接收原视频', async () => {
    const { store, receipt, context } = await fixture();
    const paused = pauseBeforeDatabaseCommit();
    const delivery = store.getState().commitNativeMediaResult(receipt, mediaPath, context);
    const signal = await Promise.race([paused.entered.promise, delivery.then(() => { throw new Error('fixture expected paused commit'); })]);
    const switching = store.getState().switchProject(canvasB);
    expect(signal.aborted).toBe(true);
    const failed = expect(delivery).rejects.toThrow(); paused.gate.resolve(undefined); await failed;
    expect(await switching).toBe(canvasB);
    expect(store.getState().currentProjectId).toBe(canvasB); expect(store.getState().nodes).toEqual([]);
    const aggregate = (await readNativeProjectCapture(projectId))!.aggregate;
    expect(aggregate.canvases.find((canvas) => canvas.id === canvasB)!.nodes).toEqual([]);
    expect((aggregate.canvases.find((canvas) => canvas.id === canvasA)!.nodes[0] as Node<BaseNodeData>).data.videoUrl).toBeUndefined();
    expect((await listNativeMediaTasks(projectId))[0].status).toBe('submitted');
  });

  it('媒体交付之后排队的旧自动保存重取最新视图，不覆盖已完成视频和回执', async () => {
    const { store, receipt, context } = await fixture();
    const paused = pauseBeforeDatabaseCommit();
    const delivery = store.getState().commitNativeMediaResult(receipt, mediaPath, context);
    await Promise.race([paused.entered.promise, delivery.then(() => { throw new Error('fixture expected paused commit'); })]);
    // 此调用同步捕获的是 loading 节点；它在 runtime.tail 上排在媒体事务之后。
    const queuedSave = store.getState().saveCurrentProjectSilent();
    expect(store.getState().nodes[0].data.status).toBe('loading');
    paused.gate.resolve(undefined); await delivery; expect(await queuedSave).toBe(canvasA);
    const canvas = (await readNativeProjectCapture(projectId))!.aggregate.canvases.find((item) => item.id === canvasA)!;
    expect((canvas.nodes[0] as Node<BaseNodeData>).data).toMatchObject({ status: 'success', relativePath: mediaPath, videoUrl: mediaPath });
    expect(store.getState().nodes[0].data.status).toBe('success');
    expect(store.getState().projectExecutionContext?.runtimeEpoch).toBe(context.runtimeEpoch);
    expect(store.getState().history).toHaveLength(2);
    expect((await listNativeMediaTasks(projectId))[0]).toMatchObject({ status: 'delivered', remoteTaskId: 'original-paid-task' });
  });

  it('事务已提交而调用尚未返回时的新编辑不会被迟到投影覆盖，排队保存保留结果和编辑', async () => {
    const { store, receipt, context } = await fixture();
    const paused = pauseAfterDatabaseCommit();
    const delivery = store.getState().commitNativeMediaResult(receipt, mediaPath, context);
    await Promise.race([paused.entered.promise, delivery.then(() => { throw new Error('fixture expected committed continuation gap'); })]);
    expect(store.getState().nodes[0].data).toMatchObject({ status: 'success', videoUrl: mediaUrl });
    expect((await listNativeMediaTasks(projectId))[0].status).toBe('delivered');
    store.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, position: { x: 320, y: 240 },
      data: { ...node.data, prompt: '提交后的新编辑' } })) }));
    const queuedSave = store.getState().saveCurrentProjectSilent();
    paused.gate.resolve(undefined); await delivery; expect(await queuedSave).toBe(canvasA);
    const current = store.getState().nodes[0];
    expect(current.position).toEqual({ x: 320, y: 240 });
    expect(current.data).toMatchObject({ prompt: '提交后的新编辑', status: 'success', videoUrl: mediaUrl });
    const saved = (await readNativeProjectCapture(projectId))!.aggregate.canvases.find((item) => item.id === canvasA)!.nodes[0] as Node<BaseNodeData>;
    expect(saved.position).toEqual(current.position);
    expect(saved.data).toMatchObject({ prompt: '提交后的新编辑', status: 'success', videoUrl: mediaPath, relativePath: mediaPath });
    expect(saved.data).not.toHaveProperty('filePath');
    expect(store.getState().history).toHaveLength(2);
  });

  it('complete事件同一轮中已发生的编辑按字段合并，已排队的旧视图保存重取提交结果', async () => {
    const { store, receipt, context } = await fixture();
    const actual = nativeDelivery.commitNativeMediaDelivery;
    let queuedSave: ReturnType<AppState['saveCurrentProjectSilent']> | undefined;
    vi.spyOn(nativeDelivery, 'commitNativeMediaDelivery').mockImplementation((input, options) => actual(input, {
      ...options, onCommitted: (result) => {
        store.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, position: { x: 90, y: 70 },
          data: { ...node.data, prompt: 'complete时的新编辑' } })) }));
        // 先排队旧loading视图，再由complete回调推进代次并合并结果。
        queuedSave = store.getState().saveCurrentProjectSilent();
        options?.onCommitted?.(result);
      },
    }));
    await store.getState().commitNativeMediaResult(receipt, mediaPath, context);
    expect(await queuedSave).toBe(canvasA);
    expect(store.getState().nodes[0].position).toEqual({ x: 90, y: 70 });
    expect(store.getState().nodes[0].data).toMatchObject({ prompt: 'complete时的新编辑', status: 'success', videoUrl: mediaUrl });
    const saved = (await readNativeProjectCapture(projectId))!.aggregate.canvases.find((item) => item.id === canvasA)!.nodes[0] as Node<BaseNodeData>;
    expect(saved.data).toMatchObject({ prompt: 'complete时的新编辑', status: 'success', videoUrl: mediaPath });
  });

  it('已提交后的等待间隙删除节点或切集不会被投递continuation复活或跨集写入', async () => {
    const { store, receipt, context } = await fixture();
    const paused = pauseAfterDatabaseCommit();
    const delivery = store.getState().commitNativeMediaResult(receipt, mediaPath, context);
    await Promise.race([paused.entered.promise, delivery.then(() => { throw new Error('fixture expected committed continuation gap'); })]);
    store.setState({ nodes: [] });
    const switching = store.getState().switchProject(canvasB);
    paused.gate.resolve(undefined); await delivery;
    expect(await switching).toBe(canvasB);
    expect(store.getState().currentProjectId).toBe(canvasB); expect(store.getState().nodes).toEqual([]);
    const aggregate = (await readNativeProjectCapture(projectId))!.aggregate;
    expect(aggregate.canvases.find((canvas) => canvas.id === canvasA)!.nodes).toEqual([]);
    expect(aggregate.canvases.find((canvas) => canvas.id === canvasB)!.nodes).toEqual([]);
    expect((await listNativeMediaTasks(projectId))[0]).toMatchObject({ status: 'delivered', resultRelativePath: mediaPath });
  });

  it('重复原回执交付不倒退保存基线或重复历史，随后普通保存仍能成功', async () => {
    const { store, receipt, context, originalHistory } = await fixture();
    const commits = vi.spyOn(nativeDelivery, 'commitNativeMediaDelivery');
    await store.getState().commitNativeMediaResult(receipt, mediaPath, context);
    const history = store.getState().history, revision = store.getState().getCurrentRevision();
    await store.getState().commitNativeMediaResult(receipt, mediaPath, context);
    expect(commits).toHaveBeenCalledTimes(2);
    expect(await commits.mock.results[1].value).toMatchObject({ alreadyCommitted: true });
    expect(store.getState().history).toBe(history); expect(store.getState().history).toHaveLength(2);
    expect(store.getState().history[0]).toBe(originalHistory); expect(store.getState().getCurrentRevision()).toBe(revision);
    expect(store.getState().projectExecutionContext?.runtimeEpoch).toBe(context.runtimeEpoch);
    // 第二次交付的前置保存已推进真实canvas revision；幂等回执不能把runtime回退到首次commit的revision。
    expect(await store.getState().saveCurrentProjectSilent()).toBe(canvasA);
    const canvas = (await readNativeProjectCapture(projectId))!.aggregate.canvases.find((item) => item.id === canvasA)!;
    expect((canvas.nodes[0] as Node<BaseNodeData>).data).toMatchObject({ status: 'success', relativePath: mediaPath, videoUrl: mediaPath });
    expect((await listNativeMediaTasks(projectId))[0]).toMatchObject({ status: 'delivered', remoteTaskId: 'original-paid-task' });
  });
});
