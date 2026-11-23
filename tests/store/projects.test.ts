/**
 * projects — 回归测试：project bootstrap lifetime。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { sha256BytesHex } from '../../src/services/mediaDataUrl';
import { episodeTeamSourceSnapshot } from '../../src/services/seriesCreativeService';
import { cancelProjectCanvasDerivations } from '../../src/services/canvasDerivationGuard';
import type { ProjectSaveData } from '../../src/services/storageService';
import type { ProjectDataDirRenameResult } from '../../src/services/fs/core';
import { registerNativeProjectFolders as registerNativeProjectFoldersInCore } from '../../src/services/fs/core';
import type { SharedAssetSyncCommitInput } from '../../src/services/indexedDb/sharedAssetSyncRepository';
import { createEmptyStoryGraph } from '../../src/services/storyGraphService';
import { ProjectImportCommittedError } from '../../src/services/projectImportOutcome';
import type { PreparedProjectImport, ProjectImportPreview } from '../../src/services/projectImportService';
import type { ProjectCatalogEntry, ResolvedProjectModel } from '../../src/services/projectModelRouter';
import type { NativeProjectAggregate } from '../../src/services/indexedDb/nativeProjectRepository';
import * as nativeRepository from '../../src/services/indexedDb/nativeProjectRepository';
import { rememberOpenedSeriesEpisode, resolveOpenTargetId, resolveProjectCardTargetId } from '../../src/store/store.utils';
import { useAppStore } from '../../src/store/useAppStore';
import { createProjectSlice, subscribeManualProjectSaveSuccess, waitForPendingProjectSaves } from '../../src/store/store.projects';
import { createOrRefreshHotStore } from '../../src/store/store.hotReload';
import type { AppState } from '../../src/store/useAppStore';
import { registerProjectSwitchTests, registerStartupNavigationTests } from './projects/navigation';

const fileMocks = vi.hoisted(() => ({
  isTauriEnv: vi.fn(() => false),
  deleteProjectData: vi.fn(async () => undefined),
  deleteProjectDataDir: vi.fn(async () => undefined),
  flushUndoTrashDirs: vi.fn(async () => undefined),
  ensureProjectDataDir: vi.fn(async () => 'project-dir'),
  loadProjectData: vi.fn(),
  loadProjectsList: vi.fn(),
  registerProjectFolder: vi.fn(),
  registerProjectFolders: vi.fn(),
  registerNativeProjectFolders: vi.fn((_bindings: ReadonlyArray<{ id: string; projectId: string }>) => {}),
  syncNativeAssetSearchRoots: vi.fn(async () => undefined),
  claimNativeProjectDataDir: vi.fn(async () => 'native-project-dir'),
  saveProject: vi.fn(async (record: { id: string }) => record.id),
  buildProjectFolderName: vi.fn((name: string, projectId: string) => (
    `${name}-${projectId.replace(/-/g, '').slice(0, 8)}`
  )),
  renameProjectDataDir: vi.fn(async (): Promise<ProjectDataDirRenameResult | null> => null),
  revertProjectDataDirRename: vi.fn(async () => undefined),
  getAssetUrlFromPath: vi.fn(async (path: string) => `asset://${path}`),
}));
const nativeMocks = vi.hoisted(() => ({
  projects: new Map<string, NativeProjectAggregate>(),
  create: vi.fn(),
  save: vi.fn(),
  readEpisode: vi.fn(),
}));
vi.mock('../../src/services/projectModelRouter', () => ({
  listProjectCatalog: async (): Promise<ProjectCatalogEntry[]> => [
    ...((await fileMocks.loadProjectsList()) ?? []).map((project: Extract<ProjectCatalogEntry, { dataModel: 'legacy' }>['project']) => ({ dataModel: 'legacy' as const, project })),
    ...[...nativeMocks.projects.values()].map(({ project, episodes, canvases }): ProjectCatalogEntry => ({ dataModel: 'native', project,
      episodes, episodeIds: episodes.map((episode) => episode.id), canvasIds: canvases.map((canvas) => canvas.id) })),
  ],
  resolveProjectModel: async (id: string): Promise<ResolvedProjectModel> => {
    const aggregate = nativeMocks.projects.get(id);
    return aggregate ? { dataModel: 'native', target: 'project', aggregate } : { dataModel: 'missing' };
  },
}));
vi.mock('../../src/services/indexedDb/nativeProjectRepository', async () => ({
  ...await vi.importActual<typeof import('../../src/services/indexedDb/nativeProjectRepository')>('../../src/services/indexedDb/nativeProjectRepository'),
  createNativeProject: nativeMocks.create,
  saveNativeProjectView: nativeMocks.save,
  readNativeEpisodeContent: nativeMocks.readEpisode,
}));
vi.mock('../../src/services/nativeProjectNavigation', () => ({
  readNativeProjectView: async (projectId: string, canvasId?: string) => {
    const aggregate = nativeMocks.projects.get(projectId);
    if (!aggregate) return null;
    const { project, episodes, content } = aggregate;
    const canvas = canvasId ? aggregate.canvases.find((item) => item.id === canvasId) ?? null : aggregate.canvas;
    const episode = episodes.find((item) => item.id === canvas?.episodeId) ?? null;
    const episodeContent = aggregate.episodeContents.find((item) => item.episodeId === episode?.id) ?? null;
    return { selection: { project, canvas, episodes, episode, changeRevision: 0,
      context: { projectId, projectEpoch: project.epoch, episodeId: episode?.id ?? null, canvasId: canvas?.id ?? null,
        canvasEpoch: canvas?.epoch ?? null, canvasRevision: canvas?.revision ?? null } }, content, episodeContent };
  },
}));
vi.mock('../../src/services/storageService', async () => ({
  ...await vi.importActual<typeof import('../../src/services/storageService')>('../../src/services/storageService'),
  restoreProjectRecord: async (record: unknown) => record,
}));
const pollMocks = vi.hoisted(() => ({
  resumePendingTasks: vi.fn(async () => undefined),
  stopPollingForDeletedProjects: vi.fn(),
  getPendingTasksForProject: vi.fn(() => []),
}));
const importMocks = vi.hoisted(() => ({ prepare: vi.fn(), preview: vi.fn(), apply: vi.fn(), restore: vi.fn() }));
vi.mock('../../src/services/projectImportService', () => ({ prepareProjectImport: importMocks.prepare,
  previewProjectImport: importMocks.preview, applyProjectImport: importMocks.apply, restoreProjectImportRecovery: importMocks.restore }));
const lifecycleMocks = vi.hoisted(() => ({ deleteContent: vi.fn() }));
vi.mock('../../src/services/indexedDb/legacyProjectLifecycleRepository', () => ({
  deleteLegacyProjectContent: lifecycleMocks.deleteContent, swapLegacyEpisodeOrder: vi.fn(),
}));
const snapshotMocks = vi.hoisted(() => ({
  captureCurrentCanvasSnapshot: vi.fn(async () => null as string | null),
}));
const metadataMocks = vi.hoisted(() => ({
  getLastActiveProjectId: vi.fn(async () => null as string | null),
  setLastActiveProjectId: vi.fn(async () => undefined),
  updateProjectSnapshot: vi.fn(async (_id: string, _snapshot: string | undefined) => true),
  updateProjectStoryGraphCAS: vi.fn(),
}));
const recoveryMock = vi.hoisted(() => vi.fn(async () => false));
const assetSyncMocks = vi.hoisted(() => ({ applySharedAssetSyncCommit: vi.fn() }));

vi.mock('../../src/services/fileService', () => ({
  ...fileMocks,
  setBaseDataDir: vi.fn(),
  syncAuthorizedDirectories: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/pollManager', () => ({
  cancelNodePolling: vi.fn(),
  clearProjectTasks: vi.fn(),
  resumePendingTasks: pollMocks.resumePendingTasks,
  stopPollingForDeletedProjects: pollMocks.stopPollingForDeletedProjects,
  getPendingTasksForProject: pollMocks.getPendingTasksForProject,
}));

vi.mock('../../src/services/projectSnapshotService', () => snapshotMocks);
vi.mock('../../src/services/webviewRecoveryService', () => ({ isWebviewRecovery: recoveryMock }));
vi.mock('../../src/services/indexedDb/sharedAssetSyncRepository', async () => ({
  ...await vi.importActual<typeof import('../../src/services/indexedDb/sharedAssetSyncRepository')>('../../src/services/indexedDb/sharedAssetSyncRepository'),
  ...assetSyncMocks,
}));
vi.mock('../../src/services/indexedDbService', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/indexedDbService')>(
    '../../src/services/indexedDbService',
  );
  return { ...actual, ...metadataMocks };
});

beforeEach(() => {
  // 控制保存和跳转的时间，保留 fake-indexeddb 依赖的 setImmediate 调度。
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.stubGlobal('CustomEvent', class TestCustomEvent {
    type: string;

    constructor(type: string) {
      this.type = type;
    }
  });
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ projectLoadStatus: 'ready' });
  fileMocks.loadProjectData.mockReset();
  fileMocks.loadProjectsList.mockReset();
  nativeMocks.projects.clear();
  nativeMocks.readEpisode.mockReset();
  nativeMocks.create.mockReset().mockImplementation(async ({ projectId, canvasId, name }: { projectId: string; canvasId: string; name: string }) => {
    const now = Date.now(), rootRef = `r2-${projectId.slice(3)}`, dataFolder = `project-${projectId}`;
    const project = { id: projectId, name, kind: 'standalone' as const, epoch: 1, createdAt: now, updatedAt: now,
      dataFolder, storageRootRef: rootRef, lastOpenedCanvasId: canvasId,
      storageBindings: [{ rootRef, folderName: dataFolder, sourceRecordIds: [], source: 'project-managed' as const }] };
    const canvas = { id: canvasId, projectId, episodeId: null, storageRootRef: rootRef, nodes: [], edges: [], groups: [],
      epoch: 1, revision: 0, revisionScope: 'project' as const };
    const aggregate: NativeProjectAggregate = { project, canvas, canvases: [canvas], episodes: [], episodeContents: [],
      content: { projectId, revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } } };
    nativeMocks.projects.set(projectId, aggregate);
    return aggregate;
  });
  nativeMocks.save.mockReset().mockImplementation(async (input: { projectId: string; canvasId: string;
    expectedCanvasRevision: number; document: { nodes: unknown[]; edges: unknown[]; groups: unknown[] } }) => {
    const aggregate = nativeMocks.projects.get(input.projectId);
    if (!aggregate?.canvas || aggregate.canvas.id !== input.canvasId || aggregate.canvas.revision !== input.expectedCanvasRevision) throw new Error('canvas-version-conflict');
    const canvas = { ...aggregate.canvas, ...input.document, revision: aggregate.canvas.revision + 1 };
    nativeMocks.projects.set(input.projectId, { ...aggregate, canvas, canvases: [canvas] });
    return { canvas, content: null, episodeContent: null, changeRevision: canvas.revision };
  });
  // 文件 IO 已隔离，但真实 serializer 仍依赖核心目录登记提供同一画布的归属证明。
  fileMocks.isTauriEnv.mockReset().mockReturnValue(false);
  fileMocks.registerNativeProjectFolders.mockReset().mockImplementation(registerNativeProjectFoldersInCore);
  fileMocks.claimNativeProjectDataDir.mockClear();
  fileMocks.deleteProjectData.mockClear();
  fileMocks.deleteProjectDataDir.mockClear();
  fileMocks.saveProject.mockReset();
  fileMocks.saveProject.mockImplementation(async (record: { id: string }) => record.id);
  fileMocks.renameProjectDataDir.mockClear();
  fileMocks.revertProjectDataDirRename.mockClear();
  pollMocks.resumePendingTasks.mockClear();
  pollMocks.stopPollingForDeletedProjects.mockClear();
  lifecycleMocks.deleteContent.mockReset().mockImplementation(async (input: {
    expectedProjects: Array<{ id: string }>; assertCurrent?: () => void;
  }) => { input.assertCurrent?.(); return input.expectedProjects.map((item) => item.id); });
  snapshotMocks.captureCurrentCanvasSnapshot.mockReset();
  snapshotMocks.captureCurrentCanvasSnapshot.mockResolvedValue(null);
  metadataMocks.getLastActiveProjectId.mockReset();
  metadataMocks.getLastActiveProjectId.mockResolvedValue(null);
  metadataMocks.setLastActiveProjectId.mockClear();
  metadataMocks.updateProjectSnapshot.mockClear();
  metadataMocks.updateProjectStoryGraphCAS.mockReset();
  recoveryMock.mockReset().mockResolvedValue(false);
  assetSyncMocks.applySharedAssetSyncCommit.mockReset();
  Object.values(importMocks).forEach((mock) => mock.mockReset());
});

describe('项目提交后交接保护', () => {
  it.each(['committed', 'unknown'] as const)('导入返回 %s 时保留 error，不能把旧画布恢复 ready', async (outcome) => {
    const owner = { id: `import-owner-${outcome}`, name: '整部剧', createdAt: 1, updatedAt: 1 };
    const episode = { id: `import-episode-${outcome}`, parentId: owner.id, name: '第一集', createdAt: 1, updatedAt: 1 };
    const session = { id: 'session' } as PreparedProjectImport;
    const preview = { sessionId: session.id, targetId: owner.id } as ProjectImportPreview;
    importMocks.preview.mockResolvedValue(preview);
    importMocks.apply.mockRejectedValue(new ProjectImportCommittedError('import-operation', owner.id, outcome, new Error('回执丢失')));
    useAppStore.setState({ projects: [owner, episode], currentProjectId: episode.id, projectLoadStatus: 'ready',
      saveCurrentProjectSilent: vi.fn(async () => episode.id), showToast: vi.fn() });
    await useAppStore.getState().previewProjectImport(session, owner.id);
    await expect(useAppStore.getState().importProject(session, preview)).rejects.toBeInstanceOf(ProjectImportCommittedError);
    expect(useAppStore.getState().projectLoadStatus).toBe('error');
    expect(fileMocks.loadProjectsList).not.toHaveBeenCalled();
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
  });

  it('恢复操作已提交但交接失败时不解锁旧稿为 ready', async () => {
    const owner = { id: 'restore-owner', name: '作品', createdAt: 1, updatedAt: 1 };
    importMocks.restore.mockRejectedValue(new ProjectImportCommittedError('restore-operation', owner.id, 'committed', new Error('回执丢失')));
    useAppStore.setState({ projects: [owner], currentProjectId: owner.id, projectLoadStatus: 'ready',
      saveCurrentProjectSilent: vi.fn(async () => owner.id) });
    await expect(useAppStore.getState().restoreProjectImport(owner.id, 'recovery')).rejects.toBeInstanceOf(ProjectImportCommittedError);
    expect(useAppStore.getState().projectLoadStatus).toBe('error');
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
  });
});

function stubInitializationActions(store = useAppStore) {
  store.setState({
    loadConfig: vi.fn(async () => undefined),
    loadWorkflows: vi.fn(async () => undefined),
    loadPresets: vi.fn(async () => undefined),
    loadSkills: vi.fn(async () => undefined),
    loadSubAgentProfiles: vi.fn(async () => undefined),
    loadCustomStyles: vi.fn(async () => undefined),
    loadToolbarLayouts: vi.fn(async () => undefined),
    loadPlugins: vi.fn(async () => undefined),
    loadAppearanceThemes: vi.fn(async () => undefined),
    loadConversationsForProject: vi.fn(async () => undefined),
    repairInterruptedForProject: vi.fn(async () => undefined),
    loadProjectMemoriesForProject: vi.fn(async () => undefined),
    repairInterruptedAgentTasksForProject: vi.fn(async () => []),
  });
}

describe('故事图主窗口写入边界', () => {
  it('持久化确认前不投影正式图，确认后合并最新正文且不写主画布历史', async () => {
    const owner = { id: 'series-graph', name: '整部剧', createdAt: 1, updatedAt: 1, exchangeEpoch: 2,
      series: { script: '原正文', storyGraph: createEmptyStoryGraph('graph') } };
    const episode = { id: 'episode-graph', parentId: owner.id, name: '第一集', createdAt: 1, updatedAt: 1 };
    const graph = { ...owner.series.storyGraph, revision: 1 };
    const history = vi.fn();
    let complete!: (value: typeof graph) => void;
    metadataMocks.updateProjectStoryGraphCAS.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    useAppStore.setState({ projects: [owner, episode], currentProjectId: episode.id, projectLoadStatus: 'ready', commitToHistory: history });
    const beforeNodes = useAppStore.getState().nodes;
    const pending = useAppStore.getState().updateStoryGraph(owner.id, { graphId: 'graph' }, 0, { expectedExchangeEpoch: 2 });
    for (let index = 0; index < 8 && !complete; index += 1) await Promise.resolve();
    expect(metadataMocks.updateProjectStoryGraphCAS).toHaveBeenCalledOnce();
    expect(useAppStore.getState().projects[0].series?.storyGraph?.revision).toBe(0);
    useAppStore.setState({ projects: [{ ...owner, series: { ...owner.series, script: '并发更新正文' } }, episode] });
    complete(graph);
    await expect(pending).resolves.toEqual(graph);
    expect(useAppStore.getState().projects[0].series).toEqual({ script: '并发更新正文', storyGraph: graph });
    expect(useAppStore.getState().nodes).toBe(beforeNodes);
    expect(history).not.toHaveBeenCalled();
  });

  it('其他剧集或旧归档代际在接触 IndexedDB 前拒绝', async () => {
    const owner = { id: 'series-graph', name: '整部剧', createdAt: 1, updatedAt: 1, exchangeEpoch: 2 };
    useAppStore.setState({ projects: [owner], currentProjectId: owner.id, projectLoadStatus: 'ready' });
    await expect(useAppStore.getState().updateStoryGraph(owner.id, { graphId: 'graph' }, 0,
      { expectedExchangeEpoch: 1 })).rejects.toThrow('已变化');
    await expect(useAppStore.getState().updateStoryGraph('other-series', { graphId: 'graph' }, 0)).rejects.toThrow('已变化');
    expect(metadataMocks.updateProjectStoryGraphCAS).not.toHaveBeenCalled();
  });
});

function refreshProjectInitializer() {
  const fresh = createProjectSlice(useAppStore.setState, useAppStore.getState, useAppStore);
  useAppStore.setState({ projectInitialized: fresh.projectInitialized, initFromDb: fresh.initFromDb });
  return fresh.initFromDb;
}

describe('project bootstrap lifetime', () => {
  const storedProject = { id: 'boot-project', name: 'Stored', createdAt: 1, updatedAt: 1 };

  it('keeps a newly created canvas when an earlier startup finishes late', async () => {
    stubInitializationActions();
    fileMocks.loadProjectsList.mockResolvedValue([storedProject]);
    let finishDetection!: (recovering: boolean) => void;
    recoveryMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishDetection = resolve; }));
    const initializing = useAppStore.getState().initFromDb();
    await vi.advanceTimersByTimeAsync(0);
    expect(recoveryMock).toHaveBeenCalledOnce();
    const creating = useAppStore.getState().createProject('新建画布');
    await vi.advanceTimersByTimeAsync(100);
    const canvasId = await creating;
    expect(canvasId).toBeDefined();
    const nodes = [{ id: 'later-edit', type: 'ai-text' as const, position: { x: 0, y: 0 }, data: { type: 'ai-text' as const, label: '保留' } }];
    useAppStore.setState({ nodes });
    finishDetection(false);
    await initializing;
    expect(useAppStore.getState()).toMatchObject({ currentProjectId: canvasId, projectName: '新建画布', projectLoadStatus: 'ready', projectInitialized: true });
    expect(useAppStore.getState().nodes).toBe(nodes);
    expect(fileMocks.loadProjectData).not.toHaveBeenCalled();
    await useAppStore.getState().initFromDb();
    expect(useAppStore.getState().nodes).toBe(nodes);
  });

  it('waits for native recovery detection before reopening the last project', async () => {
    stubInitializationActions();
    useAppStore.setState((state) => ({ config: { ...state.config, startupView: 'last-project' } }));
    fileMocks.loadProjectsList.mockResolvedValue([storedProject]);
    let finishDetection!: (recovering: boolean) => void;
    recoveryMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishDetection = resolve; }));
    const initializing = useAppStore.getState().initFromDb();
    await vi.advanceTimersByTimeAsync(0);
    expect(recoveryMock).toHaveBeenCalledOnce();
    expect(fileMocks.loadProjectData).not.toHaveBeenCalled();
    expect(useAppStore.getState().projectLoadStatus).toBe('loading');
    finishDetection(true);
    await initializing;
    expect(useAppStore.getState()).toMatchObject({ currentProjectId: null, projectLoadStatus: 'ready', nodes: [], projects: [storedProject] });
    expect(fileMocks.loadProjectData).not.toHaveBeenCalled();
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
  });

  it('consumes native recovery detection even when the startup preference is the project list', async () => {
    stubInitializationActions();
    fileMocks.loadProjectsList.mockResolvedValue([storedProject]);
    recoveryMock.mockResolvedValueOnce(true);
    await useAppStore.getState().initFromDb();
    expect(recoveryMock).toHaveBeenCalledOnce();
    expect(useAppStore.getState().currentProjectId).toBeNull();
    expect(fileMocks.loadProjectData).not.toHaveBeenCalled();
  });

  it('shares an in-flight bootstrap across an action refresh using the same store API', async () => {
    stubInitializationActions();
    let release!: () => void;
    const loadConfig = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    useAppStore.setState({ loadConfig });
    fileMocks.loadProjectsList.mockResolvedValue([storedProject]);
    const originalAction = useAppStore.getState().initFromDb;
    const first = originalAction();
    const refreshedAction = refreshProjectInitializer();
    expect(refreshedAction).not.toBe(originalAction);
    const second = refreshedAction();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(loadConfig).toHaveBeenCalledOnce();
    expect(fileMocks.loadProjectsList).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(fileMocks.loadProjectsList).toHaveBeenCalledOnce();
    expect(useAppStore.getState().projectInitialized).toBe(true);
  });

  it('keeps the open project and unsaved canvas after a completed bootstrap is called again', async () => {
    stubInitializationActions();
    fileMocks.loadProjectsList.mockResolvedValue([storedProject]);
    await useAppStore.getState().initFromDb();
    useAppStore.setState({ currentProjectId: storedProject.id, projectName: 'Unsaved name', nodes: [{
      id: 'unsaved-node', type: 'ai-text', position: { x: 12, y: 34 },
      data: { type: 'ai-text', label: 'Unsaved draft', status: 'loading' },
    }] });
    const live = useAppStore.getState();
    await refreshProjectInitializer()();
    expect(useAppStore.getState()).toMatchObject({
      currentProjectId: storedProject.id, projectName: 'Unsaved name', projectLoadStatus: 'ready', projectInitialized: true,
    });
    expect(useAppStore.getState().nodes).toBe(live.nodes);
    expect(useAppStore.getState().edges).toBe(live.edges);
    expect(fileMocks.loadProjectsList).toHaveBeenCalledOnce();
    expect(fileMocks.loadProjectData).not.toHaveBeenCalled();
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
  });

  it('seeds the first hot patch from an already ready legacy store without a bootstrap flag', async () => {
    stubInitializationActions();
    useAppStore.setState({ currentProjectId: storedProject.id, projectName: 'Live legacy', projects: [storedProject], nodes: [{
      id: 'legacy-draft', type: 'ai-text', position: { x: 0, y: 0 }, data: { type: 'ai-text', label: 'Live' },
    }] });
    const legacy: Partial<AppState> = { ...useAppStore.getState() };
    delete legacy.projectInitialized;
    useAppStore.setState(legacy as AppState, true);
    const nodes = useAppStore.getState().nodes;
    await refreshProjectInitializer()();
    expect(useAppStore.getState().projectInitialized).toBe(true);
    expect(useAppStore.getState().currentProjectId).toBe(storedProject.id);
    expect(useAppStore.getState().nodes).toBe(nodes);
    expect(fileMocks.loadProjectsList).not.toHaveBeenCalled();
    expect(useAppStore.getState().loadConfig).not.toHaveBeenCalled();
  });

  it('allows a failed bootstrap to retry after the action has been refreshed', async () => {
    stubInitializationActions();
    fileMocks.loadProjectsList.mockRejectedValueOnce(new Error('list temporarily unavailable')).mockResolvedValueOnce([storedProject]);
    await useAppStore.getState().initFromDb();
    expect(useAppStore.getState()).toMatchObject({ projectInitialized: false, projectLoadStatus: 'error' });
    await refreshProjectInitializer()();
    expect(fileMocks.loadProjectsList).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState()).toMatchObject({ projectInitialized: true, projectLoadStatus: 'ready', currentProjectId: null });
  });

  it('does not mark a failed last-project canvas load as initialized', async () => {
    stubInitializationActions();
    useAppStore.setState((state) => ({ config: { ...state.config, startupView: 'last-project' } }));
    fileMocks.loadProjectsList.mockResolvedValue([storedProject]);
    fileMocks.loadProjectData.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...storedProject, nodes: [], edges: [] });
    await useAppStore.getState().initFromDb();
    expect(useAppStore.getState()).toMatchObject({ projectInitialized: false, projectLoadStatus: 'error' });
    await useAppStore.getState().initFromDb();
    expect(fileMocks.loadProjectData).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState()).toMatchObject({ projectInitialized: true, projectLoadStatus: 'ready', currentProjectId: storedProject.id });
  });

  it('浏览器在空库中恢复上次画布时可创建默认项目', async () => {
    stubInitializationActions();
    useAppStore.setState((state) => ({ config: { ...state.config, startupView: 'last-project' } }));
    fileMocks.loadProjectsList.mockResolvedValue([]);

    await useAppStore.getState().initFromDb();

    expect(fileMocks.claimNativeProjectDataDir).not.toHaveBeenCalled();
    expect(nativeMocks.create).toHaveBeenCalledOnce();
    expect(useAppStore.getState()).toMatchObject({
      currentProjectId: nativeMocks.create.mock.calls[0]![0].canvasId,
      projectName: '默认画布', projectLoadStatus: 'ready', projectInitialized: true,
    });
  });

  it.each(['project-library', 'last-project'] as const)('a cold store still initializes with startup preference %s', async (startupView) => {
    const cold = createOrRefreshHotStore<AppState>((set, get, api) => ({
      ...useAppStore.getInitialState(), ...createProjectSlice(set, get, api),
    }));
    stubInitializationActions(cold);
    cold.setState((state) => ({ projectLoadStatus: 'ready', config: { ...state.config, startupView } }));
    fileMocks.loadProjectsList.mockResolvedValue([storedProject]);
    fileMocks.loadProjectData.mockResolvedValue({ ...storedProject, nodes: [], edges: [] });
    expect(cold.getState().projectInitialized).toBe(false);
    await cold.getState().initFromDb();
    expect(cold.getState().projectInitialized).toBe(true);
    expect(cold.getState().currentProjectId).toBe(startupView === 'last-project' ? storedProject.id : null);
    expect(fileMocks.loadProjectsList).toHaveBeenCalledOnce();
  });

  it('initial-state reset clears completion for a new session on the same store API', async () => {
    stubInitializationActions();
    fileMocks.loadProjectsList.mockResolvedValue([storedProject]);
    await useAppStore.getState().initFromDb();
    expect(useAppStore.getState().projectInitialized).toBe(true);
    useAppStore.setState(useAppStore.getInitialState(), true);
    stubInitializationActions();
    expect(useAppStore.getState().projectInitialized).toBe(false);
    await useAppStore.getState().initFromDb();
    expect(fileMocks.loadProjectsList).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().projectInitialized).toBe(true);
  });
});

describe('pending project save commit barrier', () => {
  function openSaveProject(id = 'save-project') {
    useAppStore.setState({ currentProjectId: id, projectName: '保存项目',
      projects: [{ id, name: '保存项目', createdAt: 1, updatedAt: 1 }],
      nodes: [{ id: 'text', type: 'ai-text', position: { x: 0, y: 0 }, data: { type: 'ai-text', label: '正文', output: '原正文' } }] });
  }

  it('does not start a save or a snapshot when there is no pending IO', async () => {
    openSaveProject();
    expect(await waitForPendingProjectSaves('save-project')).toBe(true);
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(snapshotMocks.captureCurrentCanvasSnapshot).not.toHaveBeenCalled();
  });

  it.each(['saveCurrentProject', 'saveCurrentProjectSilent'] as const)('waits for the complete %s operation', async (action) => {
    openSaveProject();
    let finish!: (id: string) => void;
    fileMocks.saveProject.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const saving = useAppStore.getState()[action]();
    let settled = false;
    const barrier = waitForPendingProjectSaves('save-project').then((saved) => { settled = true; return saved; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    finish('save-project');
    expect(await saving).toBe('save-project');
    expect(await barrier).toBe(true);
  });

  it('also waits for a newer save added while the original commit is pending', async () => {
    openSaveProject();
    const releases: Array<(id: string) => void> = [];
    fileMocks.saveProject.mockImplementation(() => new Promise<string>((resolve) => { releases.push(resolve); }));
    const first = useAppStore.getState().saveCurrentProjectSilent();
    let settled = false;
    const barrier = waitForPendingProjectSaves('save-project').then((saved) => { settled = true; return saved; });
    useAppStore.getState().updateNodeDataTransient('text', { output: '后来新增的正文' });
    const second = useAppStore.getState().saveCurrentProjectSilent();
    releases[0]('save-project');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(releases).toHaveLength(2);
    releases[1]('save-project');
    expect(await Promise.all([first, second, barrier])).toEqual(['save-project', 'save-project', true]);
  });

  it.each(['saveCurrentProject', 'saveCurrentProjectSilent'] as const)('does not let %s save a different project after waiting for asset sync', async (action) => {
    openSaveProject('project-a');
    let markApplyStarted!: () => void;
    let finishApply!: () => void;
    const applyStarted = new Promise<void>((resolve) => { markApplyStarted = resolve; });
    const applyPending = new Promise<void>((resolve) => { finishApply = resolve; });
    assetSyncMocks.applySharedAssetSyncCommit.mockImplementationOnce(async (input: SharedAssetSyncCommitInput) => {
      markApplyStarted();
      await applyPending;
      input.assertCurrent?.();
      return { alreadyApplied: false };
    });
    const downloading = useAppStore.getState().commitSharedAssetSyncDownload({
      ownerId: 'project-a', originProjectId: 'project-a', expectedLibrary: useAppStore.getState().dramaAssets,
      commit: { ownerId: 'project-a', operationId: 'operation', mappings: [], operation: {
        ownerId: 'project-a', connectionId: 'connection', connectionRevision: 'c1', libraryId: 'library', sharedProjectId: 'shared',
        id: 'pending', operationId: 'operation', sharedAssetId: 'asset', kind: 'file', direction: 'download',
        mappingId: 'mapping', revisionId: 'r2', phase: 'applying', createdAt: 1, updatedAt: 1,
      } },
    });
    const interrupted = expect(downloading).rejects.toThrow();
    await applyStarted;
    const saving = useAppStore.getState()[action]();
    const originalBarrier = waitForPendingProjectSaves('project-a');
    openSaveProject('project-b');
    expect(await waitForPendingProjectSaves('project-b')).toBe(true);
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    finishApply();
    await interrupted;
    expect(await saving).toBeUndefined();
    expect(await originalBarrier).toBe(false);
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(useAppStore.getState().currentProjectId).toBe('project-b');
  });

  it.each(['saveCurrentProject', 'saveCurrentProjectSilent'] as const)('reports failed %s only after error classification has finished', async (action) => {
    openSaveProject();
    let finishEstimate!: (estimate: { usage: number; quota: number }) => void;
    vi.stubGlobal('navigator', { storage: { estimate: vi.fn(() => new Promise((resolve) => { finishEstimate = resolve; })) } });
    fileMocks.saveProject.mockRejectedValueOnce(new DOMException('quota exhausted', 'QuotaExceededError'));
    const saving = useAppStore.getState()[action]();
    let settled = false;
    const barrier = waitForPendingProjectSaves('save-project').then((saved) => { settled = true; return saved; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(useAppStore.getState().autoSaveFailure).toBeNull();
      finishEstimate({ usage: 1, quota: 1 });
      expect(await saving).toBeUndefined();
      expect(await barrier).toBe(false);
      expect(useAppStore.getState().autoSaveFailure?.kind).toBe('quota');
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['saveCurrentProject', 'saveCurrentProjectSilent'] as const)('does not let a late classified %s failure replace a newer manual success without another edit', async (action) => {
    openSaveProject();
    const showToast = vi.fn(), manualSuccess = vi.fn();
    useAppStore.setState({ showToast });
    const unsubscribe = subscribeManualProjectSaveSuccess(manualSuccess);
    let finishEstimate!: (estimate: { usage: number; quota: number }) => void;
    const estimate = vi.fn(() => new Promise<{ usage: number; quota: number }>((resolve) => { finishEstimate = resolve; }));
    vi.stubGlobal('navigator', { storage: { estimate } });
    fileMocks.saveProject.mockRejectedValueOnce(new DOMException('old quota error', 'QuotaExceededError'));
    const oldSaving = useAppStore.getState()[action]();
    let barrierSettled = false;
    const barrier = waitForPendingProjectSaves('save-project').then((saved) => { barrierSettled = true; return saved; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(estimate).toHaveBeenCalledOnce();
      expect(barrierSettled).toBe(false);
      expect(await useAppStore.getState().saveCurrentProject()).toBe('save-project');
      const savedProjects = useAppStore.getState().projects;
      expect(manualSuccess).toHaveBeenCalledExactlyOnceWith('save-project');
      expect(useAppStore.getState().autoSaveFailure).toBeNull();
      expect(barrierSettled).toBe(false);
      finishEstimate({ usage: 1, quota: 1 });
      expect(await oldSaving).toBeUndefined();
      expect(await barrier).toBe(false);
      expect(useAppStore.getState().autoSaveFailure).toBeNull();
      expect(useAppStore.getState().projects).toBe(savedProjects);
      expect(showToast).toHaveBeenCalledExactlyOnceWith('项目已保存');
    } finally { unsubscribe(); vi.unstubAllGlobals(); }
  });

  it.each(['other-project', 'reopened-project'] as const)('does not apply an old classified error to the %s session', async (navigation) => {
    openSaveProject('project-p');
    const showToast = vi.fn(); useAppStore.setState({ showToast });
    let finishEstimate!: (estimate: { usage: number; quota: number }) => void;
    const estimate = vi.fn(() => new Promise<{ usage: number; quota: number }>((resolve) => { finishEstimate = resolve; }));
    vi.stubGlobal('navigator', { storage: { estimate } });
    fileMocks.saveProject.mockRejectedValueOnce(new DOMException('old session quota error', 'QuotaExceededError'));
    const oldSaving = useAppStore.getState().saveCurrentProjectSilent();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(estimate).toHaveBeenCalledOnce();
      openSaveProject('project-q');
      if (navigation === 'reopened-project') openSaveProject('project-p');
      fileMocks.saveProject.mockRejectedValueOnce(new Error('当前会话写入失败'));
      expect(await useAppStore.getState().saveCurrentProjectSilent()).toBeUndefined();
      const currentFailure = useAppStore.getState().autoSaveFailure;
      const currentProjects = useAppStore.getState().projects;
      expect(currentFailure).toMatchObject({ reason: '当前会话写入失败', count: 1 });
      showToast.mockClear();
      finishEstimate({ usage: 1, quota: 1 });
      expect(await oldSaving).toBeUndefined();
      expect(useAppStore.getState().autoSaveFailure).toBe(currentFailure);
      expect(useAppStore.getState().projects).toBe(currentProjects);
      expect(showToast).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['saveCurrentProject', 'saveCurrentProjectSilent'] as const)('does not let an older successful %s clear a newer failure or refresh its metadata', async (action) => {
    openSaveProject();
    const manualSuccess = vi.fn(), showToast = vi.fn();
    useAppStore.setState({ showToast });
    const unsubscribe = subscribeManualProjectSaveSuccess(manualSuccess);
    let newerSaving: Promise<string | undefined> | undefined;
    let newerFailure: AppState['autoSaveFailure'] = null;
    let newerProjects: AppState['projects'] = [];
    fileMocks.saveProject.mockImplementationOnce(async (record: { id: string }) => {
      useAppStore.setState({ projectLoadStatus: 'error', projectName: '较新的项目名称' });
      newerSaving = useAppStore.getState().saveCurrentProjectSilent();
      newerFailure = useAppStore.getState().autoSaveFailure;
      newerProjects = useAppStore.getState().projects;
      return record.id;
    });
    try {
      expect(await useAppStore.getState()[action]()).toBe('save-project');
      expect(await newerSaving).toBeUndefined();
      expect(newerFailure!).toMatchObject({ kind: 'load-error', count: 1 });
      expect(useAppStore.getState().autoSaveFailure).toBe(newerFailure!);
      expect(useAppStore.getState().projects).toBe(newerProjects!);
      expect(manualSuccess).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalledWith('项目已保存');
    } finally { unsubscribe(); }
  });

  it.each(['saveCurrentProject', 'saveCurrentProjectSilent'] as const)('%s keeps existing name synchronization and does not restore an older captured name', async (action) => {
    openSaveProject();
    useAppStore.setState({ projectName: '待保存的新名称' });
    expect(await useAppStore.getState()[action]()).toBe('save-project');
    expect(useAppStore.getState().projects[0].name).toBe('待保存的新名称');
    let finish!: (id: string) => void;
    fileMocks.saveProject.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const saving = useAppStore.getState()[action]();
    const updatedAt = Date.now() + 100;
    useAppStore.setState((state) => ({ projectName: '保存期间改过的名称',
      projects: state.projects.map((project) => ({ ...project, name: '保存期间改过的名称', updatedAt })) }));
    finish('save-project');
    expect(await saving).toBe('save-project');
    expect(useAppStore.getState().projects[0]).toMatchObject({ name: '保存期间改过的名称', updatedAt });
  });

  it.each(['other-project', 'reopened-project'] as const)('does not clear the %s failure or broadcast recovery when an old save succeeds', async (navigation) => {
    openSaveProject('project-p');
    const manualSuccess = vi.fn(), showToast = vi.fn();
    useAppStore.setState({ showToast });
    const unsubscribe = subscribeManualProjectSaveSuccess(manualSuccess);
    let finish!: (id: string) => void;
    fileMocks.saveProject.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const oldSaving = useAppStore.getState().saveCurrentProject();
    openSaveProject('project-q');
    if (navigation === 'reopened-project') openSaveProject('project-p');
    useAppStore.setState({ projectLoadStatus: 'error' });
    expect(await useAppStore.getState().saveCurrentProjectSilent()).toBeUndefined();
    const currentFailure = useAppStore.getState().autoSaveFailure;
    const currentProjects = useAppStore.getState().projects;
    showToast.mockClear();
    try {
      finish('project-p');
      expect(await oldSaving).toBe('project-p');
      expect(useAppStore.getState().autoSaveFailure).toBe(currentFailure);
      expect(useAppStore.getState().projects).toBe(currentProjects);
      expect(manualSuccess).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it('keeps outcome ordering and one session observer when project actions are rebound during classification', async () => {
    openSaveProject();
    let finishEstimate!: (estimate: { usage: number; quota: number }) => void;
    vi.stubGlobal('navigator', { storage: { estimate: vi.fn(() => new Promise<{ usage: number; quota: number }>((resolve) => { finishEstimate = resolve; })) } });
    fileMocks.saveProject.mockRejectedValueOnce(new DOMException('before hot reload', 'QuotaExceededError'));
    const oldSaving = useAppStore.getState().saveCurrentProjectSilent();
    const subscribe = vi.spyOn(useAppStore, 'subscribe');
    try {
      await vi.advanceTimersByTimeAsync(0);
      const fresh = createProjectSlice(useAppStore.setState, useAppStore.getState, useAppStore);
      useAppStore.setState({ saveCurrentProject: fresh.saveCurrentProject, saveCurrentProjectSilent: fresh.saveCurrentProjectSilent });
      expect(subscribe).not.toHaveBeenCalled();
      expect(await useAppStore.getState().saveCurrentProject()).toBe('save-project');
      finishEstimate({ usage: 1, quota: 1 });
      expect(await oldSaving).toBeUndefined();
      expect(useAppStore.getState().autoSaveFailure).toBeNull();
    } finally { subscribe.mockRestore(); vi.unstubAllGlobals(); }
  });

  it('reports an unexpected rejection and leaves another project independent', async () => {
    openSaveProject();
    Object.defineProperty(useAppStore.getState().projects[0], 'createdAt', { get: () => { throw new Error('invalid project record'); } });
    const saving = useAppStore.getState().saveCurrentProjectSilent();
    const rejected = expect(saving).rejects.toThrow('invalid project record');
    const barrier = waitForPendingProjectSaves('save-project');
    expect(await waitForPendingProjectSaves('another-project')).toBe(true);
    expect(await barrier).toBe(false);
    await rejected;
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
  });
});

describe('project creation', () => {
  it('does not persist a project when its creation signal was already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(useAppStore.getState().createProject('Cancelled', { signal: controller.signal })).resolves.toBeUndefined();
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(useAppStore.getState().isCreatingProject).toBe(false);
  });

  it('keeps a project persisted during cancellation discoverable without switching the startup page', async () => {
    let finishSave: (() => void) | undefined;
    let markSaveStarted: (() => void) | undefined;
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
    const create = nativeMocks.create.getMockImplementation()!;
    nativeMocks.create.mockImplementationOnce(async (input) => {
      markSaveStarted?.();
      await new Promise<void>((resolve) => { finishSave = resolve; });
      return create(input);
    });
    useAppStore.setState({ currentProjectId: null, projects: [] });
    const controller = new AbortController();
    const creating = useAppStore.getState().createProject('Cancelled', { signal: controller.signal });
    await saveStarted;
    controller.abort();
    const { canvasId } = nativeMocks.create.mock.calls[0]![0];
    finishSave?.();
    await expect(creating).resolves.toBeUndefined();
    expect(useAppStore.getState()).toMatchObject({ currentProjectId: null, isCreatingProject: false,
      projects: [{ id: canvasId, name: 'Cancelled' }] });
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(metadataMocks.setLastActiveProjectId).not.toHaveBeenCalled();
  });

  it('saves the current project and persists the new project before switching', async () => {
    let resolveNewProjectSave: (() => void) | undefined;
    let markNewProjectSaveStarted: (() => void) | undefined;
    const newProjectSaveStarted = new Promise<void>((resolve) => {
      markNewProjectSaveStarted = resolve;
    });
    const create = nativeMocks.create.getMockImplementation()!;
    nativeMocks.create.mockImplementationOnce(async (input) => {
      markNewProjectSaveStarted?.();
      await new Promise<void>((resolve) => { resolveNewProjectSave = resolve; });
      return create(input);
    });
    useAppStore.setState({
      projects: [{ id: 'project-old', name: 'Old project', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'project-old',
      projectName: 'Old project',
      nodes: [{
        id: 'unsaved-node',
        type: 'ai-text',
        position: { x: 0, y: 0 },
        data: { label: 'Unsaved node', type: 'ai-text' },
      }],
      edges: [],
      groups: [],
    });

    const creating = useAppStore.getState().createProject('New project');
    await newProjectSaveStarted;

    expect(fileMocks.saveProject).toHaveBeenCalledTimes(1);
    expect(fileMocks.saveProject.mock.calls[0]?.[0]).toMatchObject({
      id: 'project-old',
      nodes: [{ id: 'unsaved-node' }],
    });
    expect(nativeMocks.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'New project' }));
    expect(useAppStore.getState().currentProjectId).toBe('project-old');

    const newProjectId = nativeMocks.create.mock.calls[0]![0].canvasId;
    resolveNewProjectSave?.();
    await expect(creating).resolves.toBe(newProjectId);

    expect(fileMocks.saveProject.mock.invocationCallOrder[0]).toBeLessThan(
      nativeMocks.create.mock.invocationCallOrder[0],
    );
    expect(useAppStore.getState()).toMatchObject({
      currentProjectId: newProjectId,
      projectName: 'New project',
      nodes: [],
      edges: [],
      groups: [],
    });
  });

  it('keeps the current canvas when saving it before creation fails', async () => {
    const showToast = vi.fn();
    fileMocks.saveProject.mockRejectedValueOnce(new Error('disk full'));
    useAppStore.setState({
      projects: [{ id: 'project-old', name: 'Old project', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'project-old',
      projectName: 'Old project',
      nodes: [{
        id: 'unsaved-node',
        type: 'ai-text',
        position: { x: 0, y: 0 },
        data: { label: 'Unsaved node', type: 'ai-text' },
      }],
      showToast,
    });

    await expect(useAppStore.getState().createProject('New project')).resolves.toBeUndefined();

    expect(fileMocks.saveProject).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState()).toMatchObject({
      currentProjectId: 'project-old',
      projectName: 'Old project',
    });
    expect(useAppStore.getState().projects.map((project) => project.id)).toEqual(['project-old']);
    expect(useAppStore.getState().nodes.map((node) => node.id)).toEqual(['unsaved-node']);
    expect(showToast).toHaveBeenCalledWith('当前项目保存失败，已取消新建项目', 'error');
  });

  it.each(['桌面', '浏览器'])('%s新建作品写入新仓储，保存后切换再打开仍保留画布', async (platform) => {
    const tauri = platform === '桌面';
    stubInitializationActions();
    const old = { id: 'legacy-project', name: '旧项目', createdAt: 1, updatedAt: 1 };
    fileMocks.loadProjectsList.mockResolvedValue([old]);
    fileMocks.loadProjectData.mockResolvedValue({ ...old, nodes: [], edges: [], groups: [] });
    useAppStore.setState({ projects: [old], currentProjectId: null });
    fileMocks.isTauriEnv.mockReturnValueOnce(tauri);
    const canvasId = await useAppStore.getState().createProject('新作品');
    expect(canvasId).toMatch(/^c2-/);
    expect(nativeMocks.create).toHaveBeenCalledOnce();
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    const projectId = nativeMocks.create.mock.calls[0]![0].projectId;
    if (tauri) expect(fileMocks.claimNativeProjectDataDir).toHaveBeenCalledWith(projectId, '新作品');
    useAppStore.setState({ nodes: [{ id: 'node', type: 'ai-text', position: { x: 0, y: 0 },
      data: { label: '保留内容', type: 'ai-text' } }] });
    expect(await useAppStore.getState().saveCurrentProjectSilent()).toBe(canvasId);
    expect(nativeMocks.save).toHaveBeenCalledWith(expect.objectContaining({ projectId, canvasId,
      document: expect.objectContaining({ nodes: [expect.objectContaining({ id: 'node' })] }) }));
    expect(await useAppStore.getState().switchProject(old.id)).toBe(old.id);
    expect(await useAppStore.getState().switchProject(canvasId!)).toBe(canvasId);
    expect(useAppStore.getState().nodes.map((node) => node.id)).toEqual(['node']);
    expect(fileMocks.claimNativeProjectDataDir).toHaveBeenCalledTimes(Number(tauri));
  });

  it('旧项目列表持续读取失败时，新建的画布仍能从启动页再次打开', async () => {
    stubInitializationActions();
    fileMocks.loadProjectsList.mockRejectedValue(new Error('旧项目列表不可用'));
    useAppStore.setState({
      projects: [{ id: 'default', name: '默认画布', createdAt: 1, updatedAt: 1 }],
      currentProjectId: null,
      projectLoadStatus: 'error',
    });

    const openedId = await useAppStore.getState().createProject('新作品');
    expect(nativeMocks.create).toHaveBeenCalledOnce();
    const { canvasId, projectId } = nativeMocks.create.mock.calls[0]![0];
    expect(openedId).toBe(canvasId);
    expect(nativeMocks.projects.get(projectId)?.canvas?.id).toBe(canvasId);
    expect(useAppStore.getState()).toMatchObject({
      projects: [{ id: canvasId, name: '新作品' }], currentProjectId: canvasId, projectLoadStatus: 'ready',
    });

    expect(await useAppStore.getState().returnToStartPage()).toBe(true);
    expect(useAppStore.getState().currentProjectId).toBeNull();
    expect(await useAppStore.getState().switchProject(canvasId)).toBe(canvasId);
    expect(useAppStore.getState()).toMatchObject({ currentProjectId: canvasId, projectLoadStatus: 'ready' });
    expect(nativeMocks.create).toHaveBeenCalledOnce();
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
  });

  it('零集新剧集可以打开项目根，不会创建旧画布或删除作品', async () => {
    stubInitializationActions();
    const projectId = 'p2-11111111-1111-4111-8111-111111111111';
    const rootRef = 'r2-11111111-1111-4111-8111-111111111111', dataFolder = `project-${projectId}`;
    nativeMocks.projects.set(projectId, { project: { id: projectId, name: '零集剧集', kind: 'series', epoch: 1,
      createdAt: 1, updatedAt: 1, dataFolder, storageRootRef: rootRef,
      storageBindings: [{ rootRef, folderName: dataFolder, sourceRecordIds: [], source: 'project-managed' }] },
      content: { projectId, script: '保留正文', revisions: { source: 0, script: 1, storyGraph: 0, assets: 0 } },
      canvas: null, canvases: [], episodes: [], episodeContents: [] });
    fileMocks.loadProjectsList.mockResolvedValue([]);
    useAppStore.setState({ config: { ...useAppStore.getState().config, startupView: 'last-project' } });
    await useAppStore.getState().initFromDb();
    expect(useAppStore.getState()).toMatchObject({ currentProjectId: projectId, projectLoadStatus: 'ready',
      projectExecutionContext: { kind: 'project', projectId }, nodes: [], edges: [], groups: [] });
    expect(useAppStore.getState().projects[0].series?.script).toBe('保留正文');
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(nativeMocks.create).not.toHaveBeenCalled();
  });

  it('只等待当前集正文，工作台可以独立重试其他分集', async () => {
    stubInitializationActions();
    const identity = (prefix: string, digit: string) =>
      `${prefix}-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
    const projectId = identity('p2', '1'), rootRef = identity('r2', '2'), dataFolder = `project-${projectId}`;
    const episodes: NativeProjectAggregate['episodes'] = ['3', '4'].map((digit, orderRank) => ({
      id: identity('e2', digit), projectId, canvasId: identity('c2', digit), name: `第 ${orderRank + 1} 集`, orderRank,
      createdAt: 1, updatedAt: 1, epoch: 1, revision: 0, settingsPolicy: { mode: 'inherit', overrides: {} },
    }));
    const canvases: NativeProjectAggregate['canvases'] = episodes.map((item) => ({
      id: item.canvasId, projectId, episodeId: item.id, storageRootRef: rootRef, epoch: 1, revision: 0,
      revisionScope: 'project', nodes: [], edges: [], groups: [],
    }));
    const [first, second] = episodes;
    const bodies = episodes.map((item, index) => ({ episodeId: item.id, revision: 0, storageRootRef: rootRef, script: `正文 ${index + 1}` }));
    const project: NativeProjectAggregate['project'] = { id: projectId, name: '多集作品', kind: 'series', epoch: 1,
      createdAt: 1, updatedAt: 1, dataFolder, storageRootRef: rootRef, lastOpenedCanvasId: first.canvasId,
      storageBindings: [{ rootRef, folderName: dataFolder, sourceRecordIds: [], source: 'project-managed' }] };
    nativeMocks.projects.set(projectId, { project, content: { projectId, revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } },
      canvas: canvases[0], canvases, episodes, episodeContents: bodies });
    const secondBody = { project, episode: second, content: bodies[1], changeRevision: 0 };
    let finishEpisodeRead!: (value: typeof secondBody) => void;
    nativeMocks.readEpisode.mockRejectedValueOnce(new Error('第二集暂时无法读取')).mockImplementationOnce(
      () => new Promise<typeof secondBody>((resolve) => { finishEpisodeRead = resolve; }));
    fileMocks.loadProjectsList.mockResolvedValue([]);
    useAppStore.setState({ config: { ...useAppStore.getState().config, startupView: 'last-project' } });

    await useAppStore.getState().initFromDb();
    expect(useAppStore.getState()).toMatchObject({ currentProjectId: first.canvasId, projectLoadStatus: 'ready' });
    expect(useAppStore.getState().projects.find((item) => item.id === first.canvasId)?.episodeScript).toBe('正文 1');
    expect(nativeMocks.readEpisode).not.toHaveBeenCalled();
    await expect(useAppStore.getState().loadEpisodeCreative(second.canvasId)).rejects.toThrow('暂时无法读取');
    expect(useAppStore.getState()).toMatchObject({ currentProjectId: first.canvasId, projectLoadStatus: 'ready' });
    const pending = useAppStore.getState().loadEpisodeCreative(second.canvasId);
    useAppStore.setState((state) => ({ projects: state.projects.map((item) => item.id === second.canvasId
      ? { ...item, snapshot: 'preview-received-while-loading' } : item) }));
    finishEpisodeRead(secondBody);
    await expect(pending).resolves.toMatchObject({ episodeScript: '正文 2', snapshot: 'preview-received-while-loading' });
    expect(nativeMocks.readEpisode).toHaveBeenLastCalledWith(projectId, second.id);
    await expect(useAppStore.getState().loadEpisodeCreative(second.canvasId)).resolves.toMatchObject({ episodeScript: '正文 2' });
    expect(nativeMocks.readEpisode).toHaveBeenCalledTimes(2);

    const pending = vi.spyOn(nativeRepository, 'listNativeProjectPendingTransfers').mockResolvedValueOnce([
      { kind: 'update', phase: 'prepared', operationId: 'recording-readonly', updatedAt: 1 },
    ]);
    try {
      useAppStore.setState({ saveCurrentProject: vi.fn(async () => first.canvasId) });
      expect(await useAppStore.getState().switchProject(second.canvasId)).toBe(second.canvasId);
      const state = useAppStore.getState();
      expect(state.projectLoadStatus).toBe('readonly');
      expect(resolveProjectCardTargetId(state.projects, projectId)).toBe(second.canvasId);
      expect(localStorage.getItem('ai-canvas.last-episode.v1:' + projectId)).toBe(second.id);
      expect(resolveOpenTargetId(state.projects, projectId)).toBe(first.canvasId);
    } finally { pending.mockRestore(); }
  });
});

const projectNavigationFixture = {
  fileMocks,
  pollMocks,
  lifecycleMocks,
  snapshotMocks,
  metadataMocks,
  stubInitializationActions,
};
export type ProjectNavigationFixture = typeof projectNavigationFixture;

describe('project switching', () => {
  registerProjectSwitchTests(projectNavigationFixture);

  it('只记录成功打开的旧分集，删除后只清理属于被删对象的记录', async () => {
    stubInitializationActions();
    const owner = { id: 'resume-series', name: '剧集', createdAt: 1, updatedAt: 1 };
    const first = { ...owner, id: 'resume-first', parentId: owner.id, episodeNo: 1 };
    const second = { ...first, id: 'resume-second', episodeNo: 2 };
    const third = { ...first, id: 'resume-third', episodeNo: 3 };
    const other = { ...owner, id: 'resume-other' };
    const projects = [owner, first, second, third, other];
    const key = 'ai-canvas.last-episode.v1:' + owner.id;
    useAppStore.setState({ projects, currentProjectId: null,
      saveCurrentProject: vi.fn(async () => useAppStore.getState().currentProjectId ?? undefined) });
    fileMocks.loadProjectData.mockImplementation(async (id: string) => {
      const project = projects.find((item) => item.id === id);
      return project && { ...project, nodes: [], edges: [], groups: [] };
    });
    const { switchProject, deleteProject } = useAppStore.getState();
    expect(await switchProject(second.id)).toBe(second.id);
    fileMocks.loadProjectData.mockResolvedValueOnce(null);
    expect(await switchProject(third.id)).toBeUndefined();
    expect(resolveProjectCardTargetId(projects, owner.id)).toBe(second.id);

    let finishRead!: (value: unknown) => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    fileMocks.loadProjectData.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => { finishRead = resolve; });
    });
    const late = switchProject(first.id);
    await started;
    expect(resolveProjectCardTargetId(projects, owner.id)).toBe(second.id);
    expect(await switchProject(third.id)).toBe(third.id);
    finishRead({ ...first, nodes: [], edges: [], groups: [] });
    expect(await late).toBeUndefined();
    expect(resolveProjectCardTargetId(projects, owner.id)).toBe(third.id);
    await switchProject(second.id);

    await deleteProject(second.id);
    expect(useAppStore.getState().currentProjectId).toBe(first.id);
    expect(localStorage.getItem(key)).toBe(first.id);
    await switchProject(other.id);
    expect(await switchProject(third.id)).toBe(third.id);
    await switchProject(other.id);
    await deleteProject(third.id);
    expect(localStorage.getItem(key)).toBeNull();
    await switchProject(first.id);
    await deleteProject(first.id);
    expect(localStorage.getItem(key)).toBe(first.id);
    await switchProject(other.id);
    await deleteProject(owner.id);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('指定分集、独立画布和零集剧集保留各自目标，本机偏好不可写时仍能读取原记录', () => {
    const owner = { id: 'series', name: '剧集', createdAt: 1, updatedAt: 1 };
    const first = { ...owner, id: 'first', parentId: owner.id, episodeNo: 1 };
    const second = { ...first, id: 'second', episodeNo: 2 };
    const standalone = { ...owner, id: 'standalone-canvas', nativeView: { projectId: 'standalone', canvasId: 'standalone-canvas', episodeId: null } };
    rememberOpenedSeriesEpisode(second);
    const write = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new Error(); });
    try {
      rememberOpenedSeriesEpisode(first);
      const projects = [owner, first, second, standalone];
      expect(resolveProjectCardTargetId(projects, owner.id)).toBe(second.id);
      expect(resolveProjectCardTargetId(projects, first.id)).toBe(first.id);
      expect(resolveProjectCardTargetId(projects, standalone.id)).toBe(standalone.id);
      expect(resolveProjectCardTargetId([owner], owner.id)).toBe(owner.id);
    } finally { write.mockRestore(); }
  });
});

describe('returning to the startup page', () => {
  registerStartupNavigationTests(projectNavigationFixture);
});

describe('episode creative content', () => {
  it('原子保存大纲、正文和创作要点到当前分集', async () => {
    useAppStore.setState({
      projects: [
        { id: 'series', name: '月球列车', createdAt: 1, updatedAt: 1 },
        {
          id: 'ep-1',
          name: '第 1 集',
          createdAt: 1,
          updatedAt: 1,
          parentId: 'series',
          episodeNo: 1,
        },
      ],
      currentProjectId: 'ep-1',
      projectName: '第 1 集',
      projectLoadStatus: 'ready',
      nodes: [],
      edges: [],
      groups: [],
    });

    const saved = await useAppStore.getState().updateEpisodeCreative('ep-1', {
      outline: '林夏收到十年前的车票。',
      script: '1-1 站台 外 夜\n林夏：这张票不该存在。',
      creative: {
        task: '让林夏决定登车',
        coreConflict: '林夏想查明真相，但列车即将开走',
        beats: ['收到车票', '发现日期异常', '决定登车'],
        targetDurationSec: 90,
      },
    });

    expect(saved).toBe(true);
    expect(useAppStore.getState().projects.find((project) => project.id === 'ep-1'))
      .toMatchObject({
        episodeOutline: '林夏收到十年前的车票。',
        episodeScript: '1-1 站台 外 夜\n林夏：这张票不该存在。',
        episodeCreative: {
          task: '让林夏决定登车',
          targetDurationSec: 90,
        },
      });
    expect(fileMocks.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ep-1',
      episodeOutline: '林夏收到十年前的车票。',
      episodeScript: expect.stringContaining('这张票不该存在'),
      episodeCreative: expect.objectContaining({ task: '让林夏决定登车' }),
    }));
  });
});


describe('confirmed shared series library saves', () => {
  function openSeries() {
    useAppStore.setState({
      projects: [
        { id: 'perf-series', name: '剧集', createdAt: 1, updatedAt: 1 },
        { id: 'perf-episode', parentId: 'perf-series', name: '第一集', createdAt: 1, updatedAt: 1 },
      ],
      currentProjectId: 'perf-episode', projectName: '第一集', projectLoadStatus: 'ready',
      nodes: [{ id: 'text', type: 'ai-text', position: { x: 0, y: 0 }, data: { type: 'ai-text', label: '正文' } }],
      dramaAssets: { version: 2, characters: [], scenes: [], props: [] },
    });
  }
  function libraryCalls() {
    return fileMocks.saveProject.mock.calls.map(([record]) => record as ProjectSaveData)
      .filter((record) => record.id === 'perf-series');
  }

  it('saves each changed episode but skips a previously committed unchanged shared library', async () => {
    openSeries();
    expect(await useAppStore.getState().saveCurrentProjectSilent()).toBe('perf-episode');
    useAppStore.getState().updateNodeDataTransient('text', { output: '第二版' });
    expect(await useAppStore.getState().saveCurrentProjectSilent()).toBe('perf-episode');
    expect(fileMocks.saveProject.mock.calls.map(([record]) => record.id))
      .toEqual(['perf-episode', 'perf-series', 'perf-episode']);
  });

  it('persists changes to the library and parent project metadata', async () => {
    openSeries();
    await useAppStore.getState().saveCurrentProjectSilent();
    const library = { ...useAppStore.getState().dramaAssets, scenes: [] };
    useAppStore.setState({ dramaAssets: library });
    await useAppStore.getState().saveCurrentProjectSilent();
    useAppStore.setState((state) => ({ projects: state.projects.map((project) => project.id === 'perf-series'
      ? { ...project, name: '改名后的剧集' } : project) }));
    await useAppStore.getState().saveCurrentProjectSilent();
    expect(libraryCalls()).toHaveLength(3);
    expect(libraryCalls()[1].dramaAssets).toBe(library);
    expect(libraryCalls()[2].name).toBe('改名后的剧集');
  });

  it('retries a failed library write instead of marking it as saved', async () => {
    openSeries();
    let fail = true;
    fileMocks.saveProject.mockImplementation(async (record) => {
      if (record.id === 'perf-series' && fail) { fail = false; throw new Error('disk full'); }
      return record.id;
    });
    expect(await useAppStore.getState().saveCurrentProjectSilent()).toBeUndefined();
    expect(await useAppStore.getState().saveCurrentProjectSilent()).toBe('perf-episode');
    expect(libraryCalls()).toHaveLength(2);
    expect(useAppStore.getState().autoSaveFailure).toBeNull();
  });

  it('tracks the version actually written when queued requests are superseded', async () => {
    openSeries();
    const firstLibrary = useAppStore.getState().dramaAssets;
    const secondLibrary = { ...firstLibrary, lastViewedAt: 2 };
    const thirdLibrary = { ...firstLibrary, lastViewedAt: 3 };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let hold = true;
    fileMocks.saveProject.mockImplementation(async (record) => {
      if (record.id === 'perf-series' && hold) { hold = false; await pending; }
      return record.id;
    });
    const first = useAppStore.getState().saveCurrentProjectSilent();
    useAppStore.setState({ dramaAssets: secondLibrary });
    const second = useAppStore.getState().saveCurrentProjectSilent();
    useAppStore.setState({ dramaAssets: thirdLibrary });
    const third = useAppStore.getState().saveCurrentProjectSilent();
    release();
    await Promise.all([first, second, third]);
    expect(libraryCalls().map((record) => record.dramaAssets)).toEqual([firstLibrary, thirdLibrary]);
    useAppStore.setState({ dramaAssets: secondLibrary });
    await useAppStore.getState().saveCurrentProjectSilent();
    expect(libraryCalls().map((record) => record.dramaAssets)).toEqual([firstLibrary, thirdLibrary, secondLibrary]);
  });

  it('invalidates the baseline across a shared asset commit even when the library reference is unchanged', async () => {
    openSeries();
    await useAppStore.getState().saveCurrentProjectSilent();
    assetSyncMocks.applySharedAssetSyncCommit.mockResolvedValueOnce({ alreadyApplied: false });
    await useAppStore.getState().commitSharedAssetSyncDownload({
      ownerId: 'perf-series', originProjectId: 'perf-episode', expectedLibrary: useAppStore.getState().dramaAssets,
      commit: { ownerId: 'perf-series', operationId: 'operation', mappings: [], operation: {
        ownerId: 'perf-series', connectionId: 'connection', connectionRevision: 'c1', libraryId: 'library', sharedProjectId: 'shared',
        id: 'pending', operationId: 'operation', sharedAssetId: 'asset', kind: 'file', direction: 'download',
        mappingId: 'mapping', revisionId: 'r2', phase: 'applying', createdAt: 1, updatedAt: 1,
      } },
    });
    await useAppStore.getState().saveCurrentProjectSilent();
    expect(libraryCalls()).toHaveLength(2);
  });
});

describe('episode creative conditional writes', () => {
  const openEpisode = () => {
    vi.stubGlobal('crypto', webcrypto);
    useAppStore.setState({
      currentProjectId: 'team-episode',
      projectLoadStatus: 'ready',
      projects: [
        { id: 'team-series', name: '剧集', createdAt: 1, updatedAt: 1 },
        { id: 'team-episode', parentId: 'team-series', name: '第一集', createdAt: 1, updatedAt: 1,
          episodeOutline: '原大纲', episodeScript: '原稿' },
      ],
    });
  };

  it('clears the old team override when a new creation profile is selected', async () => {
    openEpisode();
    const override = { version: 1 as const, name: '旧覆盖', roles: { architect: 'a', writer: 'b', continuity: 'c', dialogue: 'd', director: 'f', storyboard: 'g', editor: 'e' },
      maxCalls: 8, maxTotalTokens: 240000, maxOutputChars: 16000 };
    useAppStore.setState({ projects: useAppStore.getState().projects.map((project) => project.id === 'team-episode'
      ? { ...project, teamProfileOverride: override } : project) });
    const selection = { id: 'creation', version: '1.0.0', sha256: 'a'.repeat(64) };
    expect(await useAppStore.getState().updateEpisodeCreative('team-episode', { creationProfile: selection })).toBe(true);
    const episode = useAppStore.getState().projects.find((project) => project.id === 'team-episode')!;
    expect(episode.creationProfile).toEqual(selection); expect(episode.teamProfileOverride).toBeUndefined();
  });

  it('rejects a stale team candidate without saving or changing another field', async () => {
    openEpisode();
    const save = vi.fn(async () => 'team-episode');
    useAppStore.setState({ saveCurrentProjectSilent: save });
    const expectedHash = await sha256BytesHex(new TextEncoder().encode('较早的稿件'));
    await expect(useAppStore.getState().updateEpisodeCreative('team-episode', { script: '候选' }, {
      expected: { kind: 'episode', seriesId: 'team-series', episodeId: 'team-episode', field: 'script',
        expectedHash, label: '第一集正文' },
    })).rejects.toThrow('目标内容已被修改');
    expect(save).not.toHaveBeenCalled();
    expect(useAppStore.getState().projects.find((item) => item.id === 'team-episode'))
      .toMatchObject({ episodeScript: '原稿', episodeOutline: '原大纲' });
  });

  it('serializes two competing candidates so the second cannot pass the same old hash', async () => {
    openEpisode();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const saving = new Promise<void>((resolve) => { started = resolve; });
    const save = vi.fn(async () => { started(); await gate; return 'team-episode'; });
    useAppStore.setState({ saveCurrentProjectSilent: save });
    const expectedHash = await sha256BytesHex(new TextEncoder().encode('原稿'));
    const expected = { kind: 'episode' as const, seriesId: 'team-series', episodeId: 'team-episode',
      field: 'script' as const, expectedHash, label: '第一集正文' };
    const first = useAppStore.getState().updateEpisodeCreative('team-episode', { script: '候选甲' }, { expected });
    await saving;
    const second = useAppStore.getState().updateEpisodeCreative('team-episode', { script: '候选乙' }, { expected });
    release();
    expect(await first).toBe(true);
    await expect(second).rejects.toThrow('目标内容已被修改');
    expect(save).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().projects.find((item) => item.id === 'team-episode')?.episodeScript).toBe('候选甲');
  });

  it('rejects applying a script based on an outline that changed after capture', async () => {
    openEpisode();
    const save = vi.fn(async () => 'team-episode');
    useAppStore.setState({ saveCurrentProjectSilent: save });
    const episode = useAppStore.getState().projects.find((item) => item.id === 'team-episode')!;
    const [expectedHash, sourceHash] = await Promise.all([
      sha256BytesHex(new TextEncoder().encode('原稿')),
      sha256BytesHex(new TextEncoder().encode(episodeTeamSourceSnapshot(episode, 'script'))),
    ]);
    useAppStore.setState((state) => ({ projects: state.projects.map((item) => item.id === episode.id
      ? { ...item, episodeOutline: '用户重新设计的大纲' } : item) }));
    await expect(useAppStore.getState().updateEpisodeCreative(episode.id, { script: '按旧大纲写的正文' }, {
      expected: { kind: 'episode', seriesId: 'team-series', episodeId: episode.id, field: 'script',
        expectedHash, sourceHash, label: '第一集正文' },
    })).rejects.toThrow('目标内容已被修改');
    expect(save).not.toHaveBeenCalled();
  });

  it('can restore the target field without treating its own previous application as changed upstream material', async () => {
    openEpisode();
    useAppStore.setState({ saveCurrentProjectSilent: vi.fn(async () => 'team-episode') });
    const episode = useAppStore.getState().projects.find((item) => item.id === 'team-episode')!;
    const sourceHash = await sha256BytesHex(new TextEncoder().encode(episodeTeamSourceSnapshot(episode, 'script')));
    const target = { kind: 'episode' as const, seriesId: 'team-series', episodeId: episode.id,
      field: 'script' as const, sourceHash, label: '第一集正文' };
    expect(await useAppStore.getState().updateEpisodeCreative(episode.id, { script: '候选' }, {
      expected: { ...target, expectedHash: await sha256BytesHex(new TextEncoder().encode('原稿')) },
    })).toBe(true);
    expect(await useAppStore.getState().updateEpisodeCreative(episode.id, { script: '原稿' }, {
      expected: { ...target, expectedHash: await sha256BytesHex(new TextEncoder().encode('候选')) },
    })).toBe(true);
    expect(useAppStore.getState().projects.find((item) => item.id === episode.id)?.episodeScript).toBe('原稿');
  });

  it('only rolls back its own failed field rather than overwriting a later project rename', async () => {
    openEpisode();
    let rejectSave!: (error: Error) => void;
    let started!: () => void;
    const saving = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<string>((_resolve, reject) => { rejectSave = reject; });
    useAppStore.setState({ saveCurrentProjectSilent: vi.fn(() => { started(); return pending; }) });
    const update = useAppStore.getState().updateEpisodeCreative('team-episode', { script: '候选' });
    await saving;
    useAppStore.setState((state) => ({ projects: state.projects.map((item) => item.id === 'team-episode'
      ? { ...item, name: '用户新名称', updatedAt: 99 } : item) }));
    rejectSave(new Error('disk full'));
    expect(await update).toBe(false);
    expect(useAppStore.getState().projects.find((item) => item.id === 'team-episode'))
      .toMatchObject({ name: '用户新名称', updatedAt: 99, episodeScript: '原稿', episodeOutline: '原大纲' });
  });

  it('only an explicit host option permits conditional saving a non-canvas episode in the loaded series', async () => {
    openEpisode();
    useAppStore.setState((state) => ({ currentProjectId: 'canvas-episode', projects: [...state.projects,
      { id: 'canvas-episode', parentId: 'team-series', name: '画布当前集', createdAt: 1, updatedAt: 1 }] }));
    fileMocks.loadProjectData.mockResolvedValue({ id: 'team-episode', parentId: 'team-series', name: '第一集',
      createdAt: 1, updatedAt: 1, nodes: [], edges: [], groups: [], episodeScript: '原稿' });
    const expected = { kind: 'episode' as const, seriesId: 'team-series', episodeId: 'team-episode', field: 'script' as const,
      expectedHash: await sha256BytesHex(new TextEncoder().encode('原稿')), label: '第一集正文' };
    await expect(useAppStore.getState().updateEpisodeCreative('team-episode', { script: '候选' }, { expected })).rejects.toThrow('分集或所属剧集');
    await expect(useAppStore.getState().updateEpisodeCreative('team-episode', { script: '候选' }, { expected, allowSameSeries: true })).resolves.toBe(true);
    expect(useAppStore.getState().currentProjectId).toBe('canvas-episode');
    expect(fileMocks.saveProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'team-episode', episodeScript: '候选' }));
  });

  it('rejects a late off-canvas record after navigation instead of writing the old canvas snapshot', async () => {
    openEpisode();
    useAppStore.setState((state) => ({ currentProjectId: 'canvas-episode', projects: [...state.projects,
      { id: 'canvas-episode', parentId: 'team-series', name: '当前集', createdAt: 1, updatedAt: 1 },
      { id: 'other-project', name: '另一项目', createdAt: 1, updatedAt: 1 }] }));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (record: ProjectSaveData) => void;
    fileMocks.loadProjectData.mockImplementationOnce(() => { entered(); return new Promise<ProjectSaveData>((resolve) => { release = resolve; }); });
    const expected = { kind: 'episode' as const, seriesId: 'team-series', episodeId: 'team-episode', field: 'script' as const,
      expectedHash: await sha256BytesHex(new TextEncoder().encode('原稿')), label: '第一集正文' };
    const saving = useAppStore.getState().updateEpisodeCreative('team-episode', { script: '候选' }, { expected, allowSameSeries: true });
    await started;
    useAppStore.setState({ currentProjectId: 'other-project' });
    release({ id: 'team-episode', name: '第一集', parentId: 'team-series', createdAt: 1, updatedAt: 1,
      nodes: [], edges: [], groups: [], episodeScript: '原稿' });
    await expect(saving).resolves.toBe(false);
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(useAppStore.getState().currentProjectId).toBe('other-project');
  });

  it('serializes an off-canvas rename behind the script write and reads its actually saved record', async () => {
    openEpisode();
    useAppStore.setState((state) => ({ currentProjectId: 'canvas-episode', projects: [...state.projects,
      { id: 'canvas-episode', parentId: 'team-series', name: '画布当前集', createdAt: 1, updatedAt: 1 }] }));
    let disk: ProjectSaveData = { id: 'team-episode', parentId: 'team-series', name: '第一集',
      createdAt: 1, updatedAt: 1, nodes: [], edges: [], groups: [], episodeScript: '原稿' };
    fileMocks.loadProjectData.mockImplementation(async () => structuredClone(disk));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const saved: ProjectSaveData[] = [];
    fileMocks.saveProject.mockImplementation(async (record) => {
      const value = record as ProjectSaveData;
      if (first) { first = false; entered(); await gate; }
      disk = structuredClone(value); saved.push(disk); return value.id;
    });
    const expected = { kind: 'episode' as const, seriesId: 'team-series', episodeId: 'team-episode', field: 'script' as const,
      expectedHash: await sha256BytesHex(new TextEncoder().encode('原稿')), label: '第一集正文' };
    const writing = useAppStore.getState().updateEpisodeCreative('team-episode', { script: '已确认候选' }, { expected, allowSameSeries: true });
    await started;
    const renaming = useAppStore.getState().renameProject('team-episode', '用户新集名');
    expect(fileMocks.loadProjectData).toHaveBeenCalledTimes(1);
    release();
    expect(await writing).toBe(true);
    expect(await renaming).toBe(true);
    expect(saved).toHaveLength(2);
    expect(disk).toMatchObject({ id: 'team-episode', name: '用户新集名', episodeScript: '已确认候选' });
    expect(useAppStore.getState().currentProjectId).toBe('canvas-episode');
  });

  it('rejects a no-op script write after canvas A-to-B-to-A navigation so stale B nodes cannot overwrite a newer saved graph', async () => {
    openEpisode();
    useAppStore.setState((state) => ({ currentProjectId: 'canvas-episode', projects: [...state.projects,
      { id: 'canvas-episode', parentId: 'team-series', name: '画布A', createdAt: 1, updatedAt: 1 }] }));
    const oldRecord: ProjectSaveData = { id: 'team-episode', parentId: 'team-series', name: '第一集',
      createdAt: 1, updatedAt: 1, nodes: [], edges: [], groups: [], episodeScript: '原稿' };
    let disk = structuredClone(oldRecord);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (record: ProjectSaveData) => void;
    fileMocks.loadProjectData.mockImplementationOnce(() => { entered(); return new Promise<ProjectSaveData>((resolve) => { release = resolve; }); });
    fileMocks.saveProject.mockImplementation(async (record) => { disk = structuredClone(record as ProjectSaveData); return record.id; });
    const expected = { kind: 'episode' as const, seriesId: 'team-series', episodeId: 'team-episode', field: 'script' as const,
      expectedHash: await sha256BytesHex(new TextEncoder().encode('原稿')), label: '相同正文候选' };
    const saving = useAppStore.getState().updateEpisodeCreative('team-episode', { script: '原稿' }, { expected, allowSameSeries: true });
    await started;
    // SeriesRail 切图会先取消离开画布的派生登记；模拟 B 编辑保存后回 A，最终 ID 与正文均恢复相同。
    cancelProjectCanvasDerivations('canvas-episode');
    useAppStore.setState({ currentProjectId: 'team-episode' });
    disk = { ...disk, updatedAt: 2, nodes: [{ id: 'new-b-node', position: { x: 50, y: 60 }, data: {
      type: 'source-text', label: 'B的新节点', role: 'source', status: 'success', output: '新图内容',
    } }] };
    cancelProjectCanvasDerivations('team-episode');
    useAppStore.setState({ currentProjectId: 'canvas-episode' });
    release(oldRecord);
    await expect(saving).resolves.toBe(false);
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(disk.nodes).toEqual([expect.objectContaining({ id: 'new-b-node' })]);
  });
});
