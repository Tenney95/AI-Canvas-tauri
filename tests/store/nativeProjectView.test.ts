import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createStore } from 'zustand/vanilla';
import type { AppState } from '../../src/store/useAppStore';
import type { AppConfig, BaseNodeData } from '../../src/types';
import type { Node } from '@xyflow/react';
import type { CanvasContext } from '../../src/types/project';
// 应用由全局 Store 入口装配 slice；先按真实入口初始化，再构建下方独立事务夹具。
import '../../src/store/useAppStore';
import { createProjectSlice } from '../../src/store/store.projects';
import { createHistorySlice } from '../../src/store/store.history';
import { createNativeEpisode, createNativeProject, listNativeProjectIdentities, readNativeProjectCapture, saveNativeCanvas } from '../../src/services/indexedDb/nativeProjectRepository';
import { prepareNativeMediaTask, recordNativeMediaSubmission, listNativeMediaTasks } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import * as nativeDelivery from '../../src/services/nativeMediaDelivery';
import { sha256BytesHex } from '../../src/services/mediaDataUrl';
import { videoInputFingerprintMaterial } from '../../src/services/videoBatchPlanning';
import type { ProjectCatalogEntry } from '../../src/services/projectModelRouter';
import type { ProjectRecord } from '../../src/types/project';
import { hydrateNativeProjectView, projectNativeCatalogEntry } from '../../src/store/nativeProjectView';
import { listEpisodes, projectMemoryOwnerId, resolveOpenTargetId, seriesOwnerId } from '../../src/store/store.utils';

// 仅替换本机 IO；Store action、串行保存队列与独立新库事务均使用真实实现。
vi.mock('../../src/services/fileService', async () => ({
  ...await vi.importActual<typeof import('../../src/services/fileService')>('../../src/services/fileService'),
  registerProjectFolders: vi.fn(), registerNativeProjectFolders: vi.fn(), syncNativeAssetSearchRoots: vi.fn(async () => {}),
  flushUndoTrashDirs: vi.fn(async () => {}),
}));
vi.mock('../../src/services/storageService', async () => ({
  ...await vi.importActual<typeof import('../../src/services/storageService')>('../../src/services/storageService'),
  serializeProjectRecord: vi.fn(async (record: unknown) => record), restoreProjectRecord: vi.fn(async (record: unknown) => record),
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
const episode = (id: string, canvasId: string, orderRank: number) => ({ id, projectId: root.id, canvasId,
  name: id, orderRank, createdAt: 1, updatedAt: 2, epoch: 1, revision: 0,
  settingsPolicy: { mode: 'inherit' as const, overrides: {} } });

describe('新结构导航投影', () => {
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
  const sourceNode = (): Node<BaseNodeData> => ({ id: 'video-node', type: 'ai-video', position: { x: 0, y: 0 }, data: {
    type: 'ai-video', label: '原视频', provider: 'volcengine', model: 'volcengine/doubao-seedance-2-5', prompt: '保留原请求', status: 'loading',
  } });
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('CustomEvent', class { type: string; constructor(type: string) { this.type = type; } });
    // 画布打开后的展示定时器不参与此夹具；fake-indexeddb 仍用真实异步调度。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function fixture() {
    const initial = await createNativeProject({ projectId, name: '隔离剧集', kind: 'series' });
    const first = await createNativeEpisode({ projectId, expectedProjectEpoch: initial.project.epoch, episodeId: episodeA, canvasId: canvasA, name: '第一集' });
    const aggregate = await createNativeEpisode({ projectId, expectedProjectEpoch: first.project.epoch, episodeId: episodeB, canvasId: canvasB, name: '第二集' });
    await saveNativeCanvas({ projectId, expectedProjectEpoch: aggregate.project.epoch, canvasId: canvasA, episodeId: episodeA,
      expectedCanvasEpoch: 1, expectedCanvasRevision: 0, document: { nodes: [sourceNode()], edges: [], groups: [] } });
    const entry: Extract<ProjectCatalogEntry, { dataModel: 'native' }> = { dataModel: 'native', project: aggregate.project,
      episodes: aggregate.episodes, episodeIds: aggregate.episodes.map((episode) => episode.id), canvasIds: aggregate.canvases.map((canvas) => canvas.id) };
    // 项目与历史 slice 使用真实 action；未参与本夹具的其他 slice 仅提供下方最小替身。
    const store = createStore<AppState>()((set, get, api) => ({
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
    expect(await store.getState().switchProject(canvasA)).toBe(canvasA);
    const context = store.getState().projectExecutionContext;
    if (context?.kind !== 'canvas') throw new Error('fixture canvas unavailable');
    const saved = await readNativeProjectCapture(projectId);
    const document = saved?.aggregate.canvases.find((canvas) => canvas.id === canvasA);
    if (!document) throw new Error('fixture document unavailable');
    const fingerprint = await sha256BytesHex(new TextEncoder().encode(videoInputFingerprintMaterial(store.getState().nodes[0], store.getState())));
    const prepared = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'video-node', providerConfigId: 'volcengine',
      providerBase: 'https://provider.example/api/v3', category: 'video', sourceCanvasRevision: document.revision, inputFingerprint: fingerprint });
    const receipt = await recordNativeMediaSubmission(prepared.operationId, prepared.lease, { taskId: 'original-paid-task' });
    const originalHistory = { nodes: [], edges: [], groups: [] };
    const agent = { id: 'agent-active', projectId: canvasA, status: 'running' } as AppState['agentTasks'][number];
    store.setState({ history: [originalHistory], historyIndex: 0, agentTasks: [agent] });
    return { store, receipt, context: context as CanvasContext, originalHistory, agent };
  }
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

  it('活动 Agent 和 loading 视频可以交付，保留运行上下文和既有历史，只追加一次快照', async () => {
    const { store, receipt, context, originalHistory, agent } = await fixture();
    const revision = store.getState().getCurrentRevision();
    await store.getState().commitNativeMediaResult(receipt, mediaPath, context);
    const state = store.getState();
    expect(state.projectExecutionContext).toMatchObject({ runtimeEpoch: context.runtimeEpoch, canvasId: canvasA, episodeId: episodeA, projectEpoch: context.projectEpoch });
    expect(state.getCurrentRevision()).toBe(revision + 1);
    expect(state.agentTasks).toEqual([agent]); expect(state.agentTasks[0]).toBe(agent);
    expect(state.history).toHaveLength(2); expect(state.history[0]).toBe(originalHistory); expect(state.historyIndex).toBe(1);
    expect(state.nodes[0].data).toMatchObject({ status: 'success', relativePath: mediaPath, videoUrl: mediaPath });
    expect((await listNativeMediaTasks(projectId))[0]).toMatchObject({ status: 'delivered', remoteTaskId: 'original-paid-task', resultRelativePath: mediaPath });
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
    expect(store.getState().nodes[0].data).toMatchObject({ status: 'success', videoUrl: mediaPath });
    expect((await listNativeMediaTasks(projectId))[0].status).toBe('delivered');
    store.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, position: { x: 320, y: 240 },
      data: { ...node.data, prompt: '提交后的新编辑' } })) }));
    const queuedSave = store.getState().saveCurrentProjectSilent();
    paused.gate.resolve(undefined); await delivery; expect(await queuedSave).toBe(canvasA);
    const current = store.getState().nodes[0];
    expect(current.position).toEqual({ x: 320, y: 240 });
    expect(current.data).toMatchObject({ prompt: '提交后的新编辑', status: 'success', videoUrl: mediaPath });
    const saved = (await readNativeProjectCapture(projectId))!.aggregate.canvases.find((item) => item.id === canvasA)!.nodes[0] as Node<BaseNodeData>;
    expect(saved.position).toEqual(current.position); expect(saved.data).toMatchObject(current.data);
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
    expect(store.getState().nodes[0].data).toMatchObject({ prompt: 'complete时的新编辑', status: 'success', videoUrl: mediaPath });
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
