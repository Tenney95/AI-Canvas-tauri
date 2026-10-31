/**
 * projects — 回归测试：project bootstrap lifetime。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import type { ProjectSaveData } from '../../src/services/storageService';
import type { ProjectDataDirRenameResult } from '../../src/services/fs/core';
import type { SharedAssetSyncCommitInput } from '../../src/services/indexedDb/sharedAssetSyncRepository';

const fileMocks = vi.hoisted(() => ({
  deleteProjectData: vi.fn(async () => undefined),
  deleteProjectDataDir: vi.fn(async () => undefined),
  flushUndoTrashDirs: vi.fn(async () => undefined),
  ensureProjectDataDir: vi.fn(async () => 'project-dir'),
  loadProjectData: vi.fn(),
  loadProjectsList: vi.fn(),
  registerProjectFolder: vi.fn(),
  registerProjectFolders: vi.fn(),
  saveProject: vi.fn(async (record: { id: string }) => record.id),
  buildProjectFolderName: vi.fn((name: string, projectId: string) => (
    `${name}-${projectId.replace(/-/g, '').slice(0, 8)}`
  )),
  renameProjectDataDir: vi.fn(async (): Promise<ProjectDataDirRenameResult | null> => null),
  revertProjectDataDirRename: vi.fn(async () => undefined),
  getAssetUrlFromPath: vi.fn(async (path: string) => `asset://${path}`),
}));
const pollMocks = vi.hoisted(() => ({
  resumePendingTasks: vi.fn(async () => undefined),
}));
const snapshotMocks = vi.hoisted(() => ({
  captureCurrentCanvasSnapshot: vi.fn(async () => null as string | null),
}));
const metadataMocks = vi.hoisted(() => ({
  getLastActiveProjectId: vi.fn(async () => null as string | null),
  setLastActiveProjectId: vi.fn(async () => undefined),
  updateProjectSnapshot: vi.fn(async (_id: string, _snapshot: string | undefined) => true),
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

import { useAppStore } from '../../src/store/useAppStore';
import { createProjectSlice, waitForPendingProjectSaves } from '../../src/store/store.projects';
import { createOrRefreshHotStore } from '../../src/store/store.hotReload';
import type { AppState } from '../../src/store/useAppStore';

beforeEach(() => {
  vi.useFakeTimers();
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
  fileMocks.deleteProjectData.mockClear();
  fileMocks.deleteProjectDataDir.mockClear();
  fileMocks.saveProject.mockReset();
  fileMocks.saveProject.mockImplementation(async (record: { id: string }) => record.id);
  fileMocks.renameProjectDataDir.mockClear();
  fileMocks.revertProjectDataDirRename.mockClear();
  pollMocks.resumePendingTasks.mockClear();
  snapshotMocks.captureCurrentCanvasSnapshot.mockReset();
  snapshotMocks.captureCurrentCanvasSnapshot.mockResolvedValue(null);
  metadataMocks.getLastActiveProjectId.mockReset();
  metadataMocks.getLastActiveProjectId.mockResolvedValue(null);
  metadataMocks.setLastActiveProjectId.mockClear();
  metadataMocks.updateProjectSnapshot.mockClear();
  recoveryMock.mockReset().mockResolvedValue(false);
  assetSyncMocks.applySharedAssetSyncCommit.mockReset();
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

function refreshProjectInitializer() {
  const fresh = createProjectSlice(useAppStore.setState, useAppStore.getState, useAppStore);
  useAppStore.setState({ projectInitialized: fresh.projectInitialized, initFromDb: fresh.initFromDb });
  return fresh.initFromDb;
}

describe('project bootstrap lifetime', () => {
  const storedProject = { id: 'boot-project', name: 'Stored', createdAt: 1, updatedAt: 1 };

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
    let finishSave: ((id: string) => void) | undefined;
    let markSaveStarted: (() => void) | undefined;
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
    fileMocks.saveProject.mockImplementation(() => {
      markSaveStarted?.();
      return new Promise<string>((resolve) => { finishSave = resolve; });
    });
    useAppStore.setState({ currentProjectId: null, projects: [] });
    const controller = new AbortController();
    const creating = useAppStore.getState().createProject('Cancelled', { signal: controller.signal });
    await saveStarted;
    controller.abort();
    const id = fileMocks.saveProject.mock.calls[0]![0].id;
    finishSave?.(id);
    await expect(creating).resolves.toBeUndefined();
    expect(useAppStore.getState()).toMatchObject({ currentProjectId: null, isCreatingProject: false,
      projects: [{ id, name: 'Cancelled' }] });
    expect(metadataMocks.setLastActiveProjectId).not.toHaveBeenCalled();
  });

  it('saves the current project and persists the new project before switching', async () => {
    let resolveNewProjectSave: ((projectId: string) => void) | undefined;
    let markNewProjectSaveStarted: (() => void) | undefined;
    const newProjectSaveStarted = new Promise<void>((resolve) => {
      markNewProjectSaveStarted = resolve;
    });
    fileMocks.saveProject.mockImplementation(async (record: { id: string }) => {
      if (record.id === 'project-old') return record.id;
      markNewProjectSaveStarted?.();
      return new Promise<string>((resolve) => {
        resolveNewProjectSave = resolve;
      });
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

    expect(fileMocks.saveProject).toHaveBeenCalledTimes(2);
    expect(fileMocks.saveProject.mock.calls[0]?.[0]).toMatchObject({
      id: 'project-old',
      nodes: [{ id: 'unsaved-node' }],
    });
    expect(fileMocks.saveProject.mock.calls[1]?.[0]).toMatchObject({
      name: 'New project',
      nodes: [],
      edges: [],
      groups: [],
    });
    expect(useAppStore.getState().currentProjectId).toBe('project-old');

    const newProjectId = fileMocks.saveProject.mock.calls[1]?.[0].id;
    resolveNewProjectSave?.(newProjectId);
    await expect(creating).resolves.toBe(newProjectId);

    expect(fileMocks.saveProject.mock.invocationCallOrder[0]).toBeLessThan(
      fileMocks.saveProject.mock.invocationCallOrder[1],
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
});

describe('project switching', () => {
  it('keeps unsaved canvas data and reports no opened project when saving before switching fails', async () => {
    const showToast = vi.fn();
    const saveCurrentProject = vi.fn(async () => undefined);
    useAppStore.setState({ projects: [
      { id: 'project-old', name: 'Old', createdAt: 1, updatedAt: 1 },
      { id: 'project-new', name: 'New', createdAt: 2, updatedAt: 2 },
    ], currentProjectId: 'project-old', nodes: [{ id: 'unsaved', type: 'ai-text', position: { x: 0, y: 0 },
      data: { label: 'unsaved', type: 'ai-text' } }], saveCurrentProject, showToast });
    await expect(useAppStore.getState().switchProject('project-new')).resolves.toBeUndefined();
    expect(useAppStore.getState()).toMatchObject({ currentProjectId: 'project-old', switchingProjectName: null,
      nodes: [{ id: 'unsaved' }] });
    expect(fileMocks.loadProjectData).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('当前项目保存失败，已取消项目切换', 'error');
  });

  it('opens a saved project from startup and returns the actual opened id', async () => {
    stubInitializationActions();
    useAppStore.setState({ currentProjectId: null, projects: [
      { id: 'startup-project', name: 'Startup', createdAt: 1, updatedAt: 1 },
    ] });
    fileMocks.loadProjectData.mockResolvedValue({ id: 'startup-project', name: 'Startup', nodes: [], edges: [], groups: [] });
    await expect(useAppStore.getState().switchProject('startup-project')).resolves.toBe('startup-project');
    expect(useAppStore.getState()).toMatchObject({ currentProjectId: 'startup-project', projectLoadStatus: 'ready' });
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(useAppStore.getState().loadConversationsForProject).toHaveBeenCalledWith('startup-project');
  });

  it('does not apply a project load after the navigation signal is cancelled and clears the overlay', async () => {
    stubInitializationActions();
    let finishLoad: ((data: unknown) => void) | undefined;
    fileMocks.loadProjectData.mockImplementation(() => new Promise((resolve) => { finishLoad = resolve; }));
    const saveCurrentProject = vi.fn(async () => 'project-old');
    useAppStore.setState({ projects: [
      { id: 'project-old', name: 'Old', createdAt: 1, updatedAt: 1 },
      { id: 'project-new', name: 'New', createdAt: 2, updatedAt: 2 },
    ], currentProjectId: 'project-old', saveCurrentProject });
    const controller = new AbortController();
    const pending = useAppStore.getState().switchProject('project-new', { signal: controller.signal });
    await vi.waitFor(() => expect(finishLoad).toBeDefined());
    controller.abort();
    finishLoad?.({ id: 'project-new', name: 'New', nodes: [], edges: [], groups: [] });
    await expect(pending).resolves.toBeUndefined();
    expect(useAppStore.getState()).toMatchObject({ currentProjectId: 'project-old', switchingProjectName: null });
    expect(useAppStore.getState().loadConversationsForProject).not.toHaveBeenCalled();
    fileMocks.loadProjectData.mockClear();
    await expect(useAppStore.getState().switchProject('project-new', { signal: controller.signal })).resolves.toBeUndefined();
    expect(fileMocks.loadProjectData).not.toHaveBeenCalled();
  });

  it('saves the current project before loading and isolates target project state', async () => {
    const saveCurrentProject = vi.fn(async () => 'project-old');
    const loadConversationsForProject = vi.fn(async () => undefined);
    const repairInterruptedForProject = vi.fn(async () => undefined);
    const loadAgentTasksForProject = vi.fn(async () => undefined);
    const loadProjectMemoriesForProject = vi.fn(async () => undefined);
    fileMocks.loadProjectData.mockResolvedValue({
      id: 'project-new',
      name: 'New project',
      createdAt: 2,
      updatedAt: 3,
      nodes: [{
        id: 'new-node',
        type: 'ai-text',
        position: { x: 10, y: 20 },
        data: { label: 'New node', type: 'ai-text' } satisfies BaseNodeData,
      }],
      edges: [],
      groups: [],
      settings: { visualStyle: { styleName: '完整记录风格' } },
    });
    useAppStore.setState({
      projects: [
        { id: 'project-old', name: 'Old project', createdAt: 1, updatedAt: 1 },
        {
          id: 'project-new',
          name: 'New project',
          createdAt: 2,
          updatedAt: 3,
          settings: { visualStyle: { styleName: '摘要旧风格' } },
        },
      ],
      currentProjectId: 'project-old',
      projectName: 'Old project',
      nodes: [{
        id: 'old-node',
        type: 'ai-text',
        position: { x: 0, y: 0 },
        data: { label: 'Old node', type: 'ai-text' },
      }],
      history: [{ nodes: [], edges: [], groups: [] }],
      historyIndex: 0,
      saveCurrentProject,
      loadConversationsForProject,
      repairInterruptedForProject,
      loadAgentTasksForProject,
      loadProjectMemoriesForProject,
    });

    await useAppStore.getState().switchProject('project-new', { captureSnapshot: true });

    expect(snapshotMocks.captureCurrentCanvasSnapshot).toHaveBeenCalledTimes(1);
    expect(saveCurrentProject).toHaveBeenCalledTimes(1);
    expect(fileMocks.loadProjectData).toHaveBeenCalledWith('project-new');
    expect(saveCurrentProject.mock.invocationCallOrder[0]).toBeLessThan(
      fileMocks.loadProjectData.mock.invocationCallOrder[0],
    );
    expect(snapshotMocks.captureCurrentCanvasSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      saveCurrentProject.mock.invocationCallOrder[0],
    );
    expect(useAppStore.getState()).toMatchObject({
      currentProjectId: 'project-new',
      projectName: 'New project',
      history: [],
      historyIndex: -1,
    });
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(['new-node']);
    expect(useAppStore.getState().projects.find((project) => project.id === 'project-new')?.settings)
      .toEqual({ visualStyle: { styleName: '完整记录风格' } });
    expect(pollMocks.resumePendingTasks).toHaveBeenCalledWith('project-new');
    expect(loadConversationsForProject).toHaveBeenCalledWith('project-new');
    expect(repairInterruptedForProject).toHaveBeenCalledWith('project-new');
    expect(loadAgentTasksForProject).toHaveBeenCalledWith('project-new');
    expect(loadProjectMemoriesForProject).toHaveBeenCalledWith('project-new');
  });

  it('stores a captured snapshot on the project that is still current', async () => {
    snapshotMocks.captureCurrentCanvasSnapshot.mockResolvedValue('data:image/webp;base64,AAAA');
    useAppStore.setState({
      projects: [{ id: 'project-old', name: 'Old project', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'project-old',
      nodes: [{
        id: 'old-node',
        type: 'ai-text',
        position: { x: 0, y: 0 },
        data: { label: 'Old node', type: 'ai-text' },
      }],
    });

    const projectId = await useAppStore.getState().captureCurrentProjectSnapshot();

    expect(projectId).toBe('project-old');
    expect(useAppStore.getState().projects[0].snapshot).toBe('data:image/webp;base64,AAAA');
  });

  it('reuses the snapshot while canvas state and viewport stay unchanged', async () => {
    snapshotMocks.captureCurrentCanvasSnapshot.mockResolvedValue('data:image/webp;base64,BBBB');
    useAppStore.setState({
      projects: [{ id: 'project-cache', name: 'Cached project', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'project-cache',
      nodes: [{
        id: 'cached-node',
        type: 'ai-text',
        position: { x: 0, y: 0 },
        data: { label: 'Cached node', type: 'ai-text' },
      }],
      edges: [],
      groups: [],
    });

    await useAppStore.getState().captureCurrentProjectSnapshot();
    await useAppStore.getState().captureCurrentProjectSnapshot();

    expect(snapshotMocks.captureCurrentCanvasSnapshot).toHaveBeenCalledTimes(1);
  });

  it('recaptures when the canvas size changes without changing its transform', async () => {
    let width = 800;
    vi.stubGlobal('document', { querySelector: (selector: string) => (
      selector === '.react-flow'
        ? { getBoundingClientRect: () => ({ width, height: 450 }) }
        : { style: { transform: 'translate(0px, 0px) scale(1)' } }
    ) });
    snapshotMocks.captureCurrentCanvasSnapshot.mockResolvedValue('data:image/webp;base64,RESIZED');
    useAppStore.setState({
      projects: [{ id: 'resized-preview', name: 'Resized', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'resized-preview',
      nodes: [{ id: 'text', type: 'ai-text', position: { x: 0, y: 0 }, data: { type: 'ai-text', label: '文字' } }],
    });
    try {
      await useAppStore.getState().captureCurrentProjectSnapshot();
      width = 1_200;
      await useAppStore.getState().captureCurrentProjectSnapshot();

      expect(snapshotMocks.captureCurrentCanvasSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('persists only the preview without serializing the canvas again', async () => {
    snapshotMocks.captureCurrentCanvasSnapshot.mockResolvedValue('data:image/webp;base64,PREVIEW_ONLY');
    useAppStore.setState({
      projects: [{ id: 'preview-project', name: 'Preview project', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'preview-project',
      nodes: [{ id: 'preview-node', type: 'ai-text', position: { x: 0, y: 0 }, data: { type: 'ai-text', label: '正文保持' } }],
    });

    expect(await useAppStore.getState().captureCurrentProjectSnapshot({ persistSnapshot: true })).toBe('preview-project');
    expect(metadataMocks.updateProjectSnapshot).toHaveBeenCalledWith('preview-project', 'data:image/webp;base64,PREVIEW_ONLY');
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
  });

  it('persists empty-canvas preview removal without a full project save', async () => {
    useAppStore.setState({
      projects: [{ id: 'empty-preview', name: 'Empty project', createdAt: 1, updatedAt: 1, snapshot: 'data:image/webp;base64,OLD' }],
      currentProjectId: 'empty-preview', nodes: [],
    });

    expect(await useAppStore.getState().captureCurrentProjectSnapshot({ persistSnapshot: true })).toBe('empty-preview');
    expect(useAppStore.getState().projects[0].snapshot).toBeUndefined();
    expect(metadataMocks.updateProjectSnapshot).toHaveBeenCalledWith('empty-preview', undefined);
    expect(snapshotMocks.captureCurrentCanvasSnapshot).not.toHaveBeenCalled();
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
  });

  it.each([true, false])('persists a cached preview after an earlier non-persisting capture (empty: %s)', async (empty) => {
    const projectId = `cached-preview-${empty}`;
    const snapshot = 'data:image/webp;base64,CACHED_PREVIEW';
    snapshotMocks.captureCurrentCanvasSnapshot.mockResolvedValue(snapshot);
    useAppStore.setState({
      projects: [{ id: projectId, name: 'Cached preview', createdAt: 1, updatedAt: 1, snapshot: 'data:image/webp;base64,OLD' }],
      currentProjectId: projectId,
      nodes: empty ? [] : [{ id: 'preview-node', type: 'ai-text', position: { x: 0, y: 0 }, data: { type: 'ai-text', label: '正文保持' } }],
    });

    expect(await useAppStore.getState().captureCurrentProjectSnapshot()).toBe(projectId);
    expect(metadataMocks.updateProjectSnapshot).not.toHaveBeenCalled();
    expect(await useAppStore.getState().captureCurrentProjectSnapshot({ persistSnapshot: true })).toBe(projectId);

    expect(metadataMocks.updateProjectSnapshot).toHaveBeenCalledOnce();
    expect(metadataMocks.updateProjectSnapshot).toHaveBeenCalledWith(projectId, empty ? undefined : snapshot);
    expect(snapshotMocks.captureCurrentCanvasSnapshot).toHaveBeenCalledTimes(empty ? 0 : 1);
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
  });

  it.each([true, false])('retries preview persistence after a failed patch without recapturing (empty: %s)', async (empty) => {
    const projectId = `retry-preview-${empty}`;
    const snapshot = 'data:image/webp;base64,RETRY_PREVIEW';
    snapshotMocks.captureCurrentCanvasSnapshot.mockResolvedValue(snapshot);
    metadataMocks.updateProjectSnapshot.mockRejectedValueOnce(new Error('temporary preview failure'));
    useAppStore.setState({
      projects: [{ id: projectId, name: 'Retry preview', createdAt: 1, updatedAt: 1, snapshot: 'data:image/webp;base64,OLD' }],
      currentProjectId: projectId,
      nodes: empty ? [] : [{ id: 'preview-node', type: 'ai-text', position: { x: 0, y: 0 }, data: { type: 'ai-text', label: '正文保持' } }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await useAppStore.getState().captureCurrentProjectSnapshot({ persistSnapshot: true })).toBe(projectId);
      expect(useAppStore.getState().projects[0].snapshot).toBe(empty ? undefined : snapshot);
      expect(await useAppStore.getState().captureCurrentProjectSnapshot({ persistSnapshot: true })).toBe(projectId);

      expect(metadataMocks.updateProjectSnapshot).toHaveBeenCalledTimes(2);
      expect(metadataMocks.updateProjectSnapshot).toHaveBeenNthCalledWith(1, projectId, empty ? undefined : snapshot);
      expect(metadataMocks.updateProjectSnapshot).toHaveBeenNthCalledWith(2, projectId, empty ? undefined : snapshot);
      expect(snapshotMocks.captureCurrentCanvasSnapshot).toHaveBeenCalledTimes(empty ? 0 : 1);
      expect(fileMocks.saveProject).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('persists snapshots for both projects while switching back and forth', async () => {
    const projectTwoNodes = [{
      id: 'project-two-node',
      type: 'ai-text',
      position: { x: 0, y: 0 },
      data: { label: 'Project two node', type: 'ai-text' } satisfies BaseNodeData,
    }];
    const projectThreeNodes = [{
      id: 'project-three-node',
      type: 'ai-image',
      position: { x: 20, y: 20 },
      data: { label: 'Project three node', type: 'ai-image' } satisfies BaseNodeData,
    }];
    snapshotMocks.captureCurrentCanvasSnapshot
      .mockResolvedValueOnce('data:image/webp;base64,PROJECT_TWO')
      .mockResolvedValueOnce('data:image/webp;base64,PROJECT_THREE');
    fileMocks.loadProjectData.mockImplementation(async (projectId: string) => ({
      id: projectId,
      name: projectId === 'project-2' ? 'Project 2' : 'Project 3',
      createdAt: projectId === 'project-2' ? 2 : 3,
      updatedAt: 4,
      nodes: projectId === 'project-2' ? projectTwoNodes : projectThreeNodes,
      edges: [],
      groups: [],
    }));
    useAppStore.setState({
      projects: [
        { id: 'project-2', name: 'Project 2', createdAt: 2, updatedAt: 2 },
        { id: 'project-3', name: 'Project 3', createdAt: 3, updatedAt: 3 },
      ],
      currentProjectId: 'project-2',
      projectName: 'Project 2',
      nodes: projectTwoNodes,
      edges: [],
      groups: [],
    });

    await useAppStore.getState().switchProject('project-3', { captureSnapshot: true });
    await useAppStore.getState().switchProject('project-2', { captureSnapshot: true });

    expect(useAppStore.getState().projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'project-2',
        snapshot: 'data:image/webp;base64,PROJECT_TWO',
      }),
      expect.objectContaining({
        id: 'project-3',
        snapshot: 'data:image/webp;base64,PROJECT_THREE',
      }),
    ]));
    expect(metadataMocks.updateProjectSnapshot).toHaveBeenCalledWith('project-2', 'data:image/webp;base64,PROJECT_TWO');
    expect(metadataMocks.updateProjectSnapshot).toHaveBeenCalledWith('project-3', 'data:image/webp;base64,PROJECT_THREE');
    expect(fileMocks.saveProject).toHaveBeenCalledTimes(2);
  });

  it('serializes project settings behind an in-flight save and preserves project data', async () => {
    let finishFirstSave: (() => void) | undefined;
    fileMocks.saveProject.mockImplementationOnce((record: { id: string }) => (
      new Promise<string>((resolve) => {
        finishFirstSave = () => resolve(record.id);
      })
    ));
    const dramaAssets = { version: 2 as const, characters: [], scenes: [], props: [] };
    useAppStore.setState({
      projects: [{ id: 'project-settings', name: 'Settings', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'project-settings',
      projectName: 'Settings',
      nodes: [{
        id: 'settings-node',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: { label: 'Settings node', type: 'ai-image' },
      }],
      edges: [],
      groups: [],
      dramaAssets,
    });

    const firstSave = useAppStore.getState().saveCurrentProjectSilent();
    expect(fileMocks.saveProject).toHaveBeenCalledTimes(1);

    const settingsSave = useAppStore.getState().updateProjectSettings({
      promptSuffixes: { image: '统一像素画风' },
    });
    expect(fileMocks.saveProject).toHaveBeenCalledTimes(1);

    finishFirstSave?.();
    await expect(firstSave).resolves.toBe('project-settings');
    await expect(settingsSave).resolves.toBe(true);

    expect(fileMocks.saveProject).toHaveBeenCalledTimes(2);
    expect(fileMocks.saveProject).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: 'project-settings',
      settings: { promptSuffixes: { image: '统一像素画风' } },
      dramaAssets,
    }));
  });

  it('does not block project switching while a complex snapshot is still encoding', async () => {
    let resolveSnapshot: ((snapshot: string) => void) | undefined;
    snapshotMocks.captureCurrentCanvasSnapshot.mockReturnValue(new Promise((resolve) => {
      resolveSnapshot = resolve;
    }));
    fileMocks.loadProjectData.mockResolvedValue({
      id: 'project-3',
      name: 'Project 3',
      createdAt: 3,
      updatedAt: 3,
      nodes: [],
      edges: [],
      groups: [],
    });
    useAppStore.setState({
      projects: [
        { id: 'project-2', name: 'Project 2', createdAt: 2, updatedAt: 2 },
        { id: 'project-3', name: 'Project 3', createdAt: 3, updatedAt: 3 },
      ],
      currentProjectId: 'project-2',
      projectName: 'Project 2',
      nodes: [{
        id: 'complex-node',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: { label: 'Complex node', type: 'ai-image' },
      }],
      edges: [],
      groups: [],
    });

    await useAppStore.getState().switchProject('project-3', { captureSnapshot: true });

    expect(useAppStore.getState().currentProjectId).toBe('project-3');
    expect(useAppStore.getState().projects.find((item) => item.id === 'project-2')?.snapshot).toBeUndefined();

    resolveSnapshot?.('data:image/webp;base64,COMPLEX_PROJECT');
    await vi.advanceTimersByTimeAsync(0);

    expect(useAppStore.getState().projects.find((item) => item.id === 'project-2')?.snapshot)
      .toBe('data:image/webp;base64,COMPLEX_PROJECT');
    expect(metadataMocks.updateProjectSnapshot).toHaveBeenCalledWith(
      'project-2', 'data:image/webp;base64,COMPLEX_PROJECT',
    );
    expect(fileMocks.saveProject).toHaveBeenCalledTimes(1);
  });

  it('does not switch when the target project is unknown', async () => {
    const saveCurrentProject = vi.fn(async () => 'project-old');
    useAppStore.setState({
      projects: [{ id: 'project-old', name: 'Old project', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'project-old',
      saveCurrentProject,
    });

    await useAppStore.getState().switchProject('missing-project');

    expect(useAppStore.getState().currentProjectId).toBe('project-old');
    expect(fileMocks.loadProjectData).not.toHaveBeenCalled();
    expect(pollMocks.resumePendingTasks).not.toHaveBeenCalled();
  });

  it('keeps the latest project selection when an earlier load finishes last', async () => {
    const pendingLoads = new Map<string, (value: unknown) => void>();
    fileMocks.loadProjectData.mockImplementation((projectId: string) => new Promise((resolve) => {
      pendingLoads.set(projectId, resolve);
    }));
    useAppStore.setState({
      projects: [
        { id: 'project-old', name: 'Old project', createdAt: 1, updatedAt: 1 },
        { id: 'project-b', name: 'Project B', createdAt: 2, updatedAt: 2 },
        { id: 'project-c', name: 'Project C', createdAt: 3, updatedAt: 3 },
      ],
      currentProjectId: 'project-old',
      projectName: 'Old project',
      saveCurrentProject: vi.fn(async () => 'project-old'),
    });

    const switchToB = useAppStore.getState().switchProject('project-b');
    await vi.waitFor(() => expect(pendingLoads.has('project-b')).toBe(true));
    const switchToC = useAppStore.getState().switchProject('project-c');
    await vi.waitFor(() => expect(pendingLoads.has('project-c')).toBe(true));

    pendingLoads.get('project-c')?.({
      id: 'project-c',
      name: 'Project C',
      createdAt: 3,
      updatedAt: 3,
      nodes: [{
        id: 'node-c',
        type: 'ai-text',
        position: { x: 0, y: 0 },
        data: { label: 'Node C', type: 'ai-text' },
      }],
      edges: [],
      groups: [],
    });
    await switchToC;

    pendingLoads.get('project-b')?.({
      id: 'project-b',
      name: 'Project B',
      createdAt: 2,
      updatedAt: 2,
      nodes: [{
        id: 'node-b',
        type: 'ai-text',
        position: { x: 0, y: 0 },
        data: { label: 'Node B', type: 'ai-text' },
      }],
      edges: [],
      groups: [],
    });
    await switchToB;

    expect(useAppStore.getState().currentProjectId).toBe('project-c');
    expect(useAppStore.getState().nodes.map((node) => node.id)).toEqual(['node-c']);
  });

  it('flags the switching project while loading and clears it once the latest switch settles', async () => {
    const pendingLoads = new Map<string, (value: unknown) => void>();
    fileMocks.loadProjectData.mockImplementation((projectId: string) => new Promise((resolve) => {
      pendingLoads.set(projectId, resolve);
    }));
    const canvas = (id: string) => ({ id, name: id, createdAt: 1, updatedAt: 1, nodes: [], edges: [], groups: [] });
    useAppStore.setState({
      projects: [
        { id: 'project-a', name: 'Project A', createdAt: 1, updatedAt: 1 },
        { id: 'project-b', name: 'Project B', createdAt: 2, updatedAt: 2 },
        { id: 'project-c', name: 'Project C', createdAt: 3, updatedAt: 3 },
      ],
      currentProjectId: 'project-a',
      projectName: 'Project A',
      saveCurrentProject: vi.fn(async () => 'project-a'),
    });

    const switchToB = useAppStore.getState().switchProject('project-b');
    await vi.waitFor(() => expect(pendingLoads.has('project-b')).toBe(true));
    expect(useAppStore.getState().switchingProjectName).toBe('Project B');
    // 项目库以外的切换不重拍缩略图
    expect(snapshotMocks.captureCurrentCanvasSnapshot).not.toHaveBeenCalled();

    const switchToC = useAppStore.getState().switchProject('project-c');
    await vi.waitFor(() => expect(pendingLoads.has('project-c')).toBe(true));
    expect(useAppStore.getState().switchingProjectName).toBe('Project C');

    pendingLoads.get('project-c')?.(canvas('project-c'));
    await switchToC;
    expect(useAppStore.getState().switchingProjectName).toBeNull();

    // 被接管的那次切换收尾时不能再动遮罩
    pendingLoads.get('project-b')?.(canvas('project-b'));
    await switchToB;
    expect(useAppStore.getState().switchingProjectName).toBeNull();
  });

  it('keeps the current project ready when the latest concurrent switch fails', async () => {
    const pendingLoads = new Map<string, (value: unknown) => void>();
    fileMocks.loadProjectData.mockImplementation((projectId: string) => new Promise((resolve) => {
      pendingLoads.set(projectId, resolve);
    }));
    useAppStore.setState({
      projects: [
        { id: 'project-a', name: 'Project A', createdAt: 1, updatedAt: 1 },
        { id: 'project-b', name: 'Project B', createdAt: 2, updatedAt: 2 },
        { id: 'project-c', name: 'Project C', createdAt: 3, updatedAt: 3 },
      ],
      currentProjectId: 'project-a',
      projectName: 'Project A',
      projectLoadStatus: 'ready',
      nodes: [{
        id: 'node-a',
        type: 'ai-text',
        position: { x: 0, y: 0 },
        data: { label: 'Node A', type: 'ai-text' },
      }],
      saveCurrentProject: vi.fn(async () => 'project-a'),
    });

    const switchToB = useAppStore.getState().switchProject('project-b');
    await vi.waitFor(() => expect(pendingLoads.has('project-b')).toBe(true));
    const switchToC = useAppStore.getState().switchProject('project-c');
    await vi.waitFor(() => expect(pendingLoads.has('project-c')).toBe(true));

    pendingLoads.get('project-c')?.(null);
    await switchToC;
    pendingLoads.get('project-b')?.({
      id: 'project-b',
      name: 'Project B',
      createdAt: 2,
      updatedAt: 2,
      nodes: [],
      edges: [],
    });
    await switchToB;

    expect(useAppStore.getState()).toMatchObject({
      currentProjectId: 'project-a',
      projectLoadStatus: 'ready',
    });
    expect(useAppStore.getState().nodes.map((node) => node.id)).toEqual(['node-a']);
  });

  it('removes deleted project chat state and loads conversations for the replacement project', async () => {
    const loadConversationsForProject = vi.fn(async () => undefined);
    const repairInterruptedForProject = vi.fn(async () => undefined);
    const loadAgentTasksForProject = vi.fn(async () => undefined);
    const loadProjectMemoriesForProject = vi.fn(async () => undefined);
    fileMocks.loadProjectData.mockResolvedValue({
      id: 'project-next',
      name: 'Next project',
      createdAt: 2,
      updatedAt: 2,
      nodes: [],
      edges: [],
      groups: [],
    });
    useAppStore.setState({
      projects: [
        { id: 'project-old', name: 'Old project', createdAt: 1, updatedAt: 1 },
        { id: 'project-next', name: 'Next project', createdAt: 2, updatedAt: 2 },
      ],
      currentProjectId: 'project-old',
      conversations: [
        {
          id: 'conversation-old',
          projectId: 'project-old',
          title: 'Old conversation',
          titleSource: 'auto',
          pinned: false,
          archived: false,
          agentMode: 'collaborative',
          createdAt: 1,
          updatedAt: 1,
          messageCount: 1,
        },
        {
          id: 'conversation-next',
          projectId: 'project-next',
          title: 'Next conversation',
          titleSource: 'auto',
          pinned: false,
          archived: false,
          agentMode: 'collaborative',
          createdAt: 1,
          updatedAt: 1,
          messageCount: 1,
        },
      ],
      activeConversationId: 'conversation-old',
      messages: [
        {
          id: 'message-old',
          conversationId: 'conversation-old',
          role: 'user',
          content: 'old',
          timestamp: 1,
          status: 'done',
        },
        {
          id: 'message-next',
          conversationId: 'conversation-next',
          role: 'user',
          content: 'next',
          timestamp: 1,
          status: 'done',
        },
      ],
      loadConversationsForProject,
      repairInterruptedForProject,
      loadAgentTasksForProject,
      loadProjectMemoriesForProject,
      removeProjectAgentTasks: vi.fn(),
      removeProjectMemories: vi.fn(),
    });

    await useAppStore.getState().deleteProject('project-old');

    expect(useAppStore.getState().conversations.map((conversation) => conversation.id))
      .toEqual(['conversation-next']);
    expect(useAppStore.getState().messages.map((message) => message.id)).toEqual(['message-next']);
    expect(useAppStore.getState().activeConversationId).toBeNull();
    expect(loadConversationsForProject).toHaveBeenCalledWith('project-next');
    expect(fileMocks.deleteProjectData).toHaveBeenCalledWith('project-old');
  });

  it('rolls back the name, data folder and asset paths when the rename save fails', async () => {
    const showToast = vi.fn();
    const renameResult = {
      oldDir: '/base/Old-project1',
      newDir: '/base/New-project1',
      oldFolder: 'Old-project1',
      dataFolder: 'New-project1',
      renamed: true,
    };
    fileMocks.renameProjectDataDir.mockResolvedValueOnce(renameResult);
    fileMocks.saveProject.mockRejectedValueOnce(new Error('disk full'));
    useAppStore.setState({
      projects: [{
        id: 'project1',
        name: 'Old',
        createdAt: 1,
        updatedAt: 1,
        dataFolder: 'Old-project1',
      }],
      currentProjectId: 'project1',
      projectName: 'Old',
      nodes: [{
        id: 'image-node',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: {
          label: 'Image node',
          type: 'ai-image',
          filePath: '/base/Old-project1/images/a.png',
          imageUrl: 'asset:///base/Old-project1/images/a.png',
        },
      }],
      edges: [],
      groups: [],
      showToast,
    });

    const renamed = await useAppStore.getState().renameProject('project1', 'New');

    expect(renamed).toBe(false);
    expect(fileMocks.revertProjectDataDirRename)
      .toHaveBeenCalledWith('project1', renameResult, 'Old-project1');

    const state = useAppStore.getState();
    expect(state.projectName).toBe('Old');
    expect(state.projects[0]).toMatchObject({
      name: 'Old',
      updatedAt: 1,
      dataFolder: 'Old-project1',
    });
    expect(state.nodes[0].data).toMatchObject({
      filePath: '/base/Old-project1/images/a.png',
      imageUrl: 'asset:///base/Old-project1/images/a.png',
    });
    expect(showToast).toHaveBeenCalledWith('项目重命名失败，已恢复原名称', 'error');
  });

  it('keeps the project visible when persistent cascade deletion fails', async () => {
    const showToast = vi.fn();
    fileMocks.deleteProjectData.mockRejectedValueOnce(new Error('indexeddb unavailable'));
    useAppStore.setState({
      projects: [{ id: 'project-old', name: 'Old project', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'project-old',
      showToast,
    });

    await useAppStore.getState().deleteProject('project-old');

    expect(useAppStore.getState().projects.map((project) => project.id)).toEqual(['project-old']);
    expect(fileMocks.deleteProjectDataDir).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('项目删除失败，本地数据未清理', 'error');
  });

  it('blocks persistence when the current project did not load successfully', async () => {
    const showToast = vi.fn();
    useAppStore.setState({
      projects: [{ id: 'project-broken', name: 'Broken', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'project-broken',
      projectName: 'Broken',
      projectLoadStatus: 'error',
      nodes: [],
      edges: [],
      groups: [],
      showToast,
    });

    await expect(useAppStore.getState().saveCurrentProjectSilent()).resolves.toBeUndefined();
    await expect(useAppStore.getState().saveCurrentProject()).resolves.toBeUndefined();

    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('项目加载失败，已阻止空画布覆盖原数据'),
      'error',
    );
    expect(showToast).toHaveBeenCalledWith('项目尚未成功加载，已阻止覆盖保存', 'error');
  });

  it('keeps warning while auto-save stays broken, and clears the failure after a success', async () => {
    const showToast = vi.fn();
    fileMocks.saveProject.mockRejectedValue(new Error('write failed: No space left on device'));
    useAppStore.setState({
      projects: [{ id: 'project-a', name: 'A', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'project-a',
      projectName: 'A',
      projectLoadStatus: 'ready',
      nodes: [],
      edges: [],
      groups: [],
      showToast,
    });

    await expect(useAppStore.getState().saveCurrentProjectSilent()).resolves.toBeUndefined();
    expect(useAppStore.getState().autoSaveFailure).toMatchObject({ kind: 'disk-full', count: 1 });
    expect(showToast).toHaveBeenCalledTimes(1);

    // 紧接着的失败只累计次数，不刷屏
    await useAppStore.getState().saveCurrentProjectSilent();
    expect(useAppStore.getState().autoSaveFailure).toMatchObject({ count: 2 });
    expect(showToast).toHaveBeenCalledTimes(1);

    // 超过重复提醒间隔后必须再提醒一次，不能一直静默
    vi.advanceTimersByTime(61_000);
    await useAppStore.getState().saveCurrentProjectSilent();
    expect(showToast).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenLastCalledWith(
      expect.stringContaining('自动保存已连续失败 3 次'),
      'error',
    );

    // 恢复正常后失败状态清空，退出时不再拦截
    fileMocks.saveProject.mockImplementation(async (record: { id: string }) => record.id);
    await expect(useAppStore.getState().saveCurrentProjectSilent()).resolves.toBe('project-a');
    expect(useAppStore.getState().autoSaveFailure).toBeNull();
  });

  it('keeps the current canvas when switching to a project that cannot be loaded', async () => {
    const showToast = vi.fn();
    fileMocks.loadProjectData.mockResolvedValue(null);
    useAppStore.setState({
      projects: [
        { id: 'project-current', name: 'Current', createdAt: 1, updatedAt: 2 },
        { id: 'project-broken', name: 'Broken', createdAt: 2, updatedAt: 3 },
      ],
      currentProjectId: 'project-current',
      projectName: 'Current',
      projectLoadStatus: 'ready',
      nodes: [{
        id: 'current-node',
        type: 'ai-text',
        position: { x: 1, y: 2 },
        data: { label: 'Current node', type: 'ai-text' },
      }],
      saveCurrentProject: vi.fn(async () => 'project-current'),
      showToast,
    });

    await useAppStore.getState().switchProject('project-broken');

    expect(useAppStore.getState()).toMatchObject({
      currentProjectId: 'project-current',
      projectLoadStatus: 'ready',
    });
    expect(useAppStore.getState().nodes.map((node) => node.id)).toEqual(['current-node']);
    expect(metadataMocks.setLastActiveProjectId).not.toHaveBeenCalledWith('project-broken');
    expect(showToast).toHaveBeenCalledWith('项目加载失败，已保留当前画布并阻止覆盖保存', 'error');
  });

  it('restores the last successfully opened project instead of the newest saved project', async () => {
    stubInitializationActions();
    // 默认启动视图已改为项目库，只有 last-project 才会在初始化时恢复上次项目。
    useAppStore.setState({ config: { ...useAppStore.getState().config, startupView: 'last-project' } });
    metadataMocks.getLastActiveProjectId.mockResolvedValue('project-remembered');
    fileMocks.loadProjectsList.mockResolvedValue([
      {
        id: 'project-newest', name: 'Newest', createdAt: 2, updatedAt: 20, nodes: [], edges: [],
      },
      {
        id: 'project-remembered',
        name: 'Remembered',
        createdAt: 1,
        updatedAt: 10,
        settings: { visualStyle: { styleName: '摘要旧风格' } },
      },
    ]);
    fileMocks.loadProjectData.mockResolvedValue({
      id: 'project-remembered',
      name: 'Remembered',
      createdAt: 1,
      updatedAt: 10,
      nodes: [{
        id: 'remembered-node',
        type: 'ai-text',
        position: { x: 3, y: 4 },
        data: { label: 'Remembered node', type: 'ai-text' },
      }],
      edges: [],
      groups: [],
      settings: { visualStyle: { styleName: '完整记录风格' } },
    });

    await useAppStore.getState().initFromDb();

    expect(fileMocks.loadProjectData).toHaveBeenCalledWith('project-remembered');
    expect(useAppStore.getState()).toMatchObject({
      currentProjectId: 'project-remembered',
      projectLoadStatus: 'ready',
    });
    expect(useAppStore.getState().nodes.map((node) => node.id)).toEqual(['remembered-node']);
    expect(useAppStore.getState().projects.find(
      (project) => project.id === 'project-remembered',
    )?.settings).toEqual({ visualStyle: { styleName: '完整记录风格' } });
    expect(metadataMocks.setLastActiveProjectId).toHaveBeenCalledWith('project-remembered');
  });

  it('does not create or save an empty project when startup loading fails', async () => {
    const showToast = vi.fn();
    stubInitializationActions();
    fileMocks.loadProjectsList.mockRejectedValue(new Error('indexeddb unavailable'));
    useAppStore.setState({ showToast });

    await useAppStore.getState().initFromDb();

    expect(useAppStore.getState()).toMatchObject({
      currentProjectId: null,
      projectLoadStatus: 'error',
    });
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('项目数据读取失败，未创建空项目', 'error');
  });

  it('starts at the project list without reading canvas data or resuming generation', async () => {
    stubInitializationActions();
    useAppStore.setState({
      config: { ...useAppStore.getState().config, startupView: 'project-library' },
    });
    fileMocks.loadProjectsList.mockResolvedValue([
      { id: 'project-list', name: '列表项目', createdAt: 1, updatedAt: 2 },
      { id: 'project-other', name: '其他项目', createdAt: 1, updatedAt: 1 },
    ]);

    await useAppStore.getState().initFromDb();

    expect(useAppStore.getState()).toMatchObject({
      currentProjectId: null, projectName: '', projectLoadStatus: 'ready',
      nodes: [], edges: [], groups: [],
    });
    expect(useAppStore.getState().projects.map((project) => project.id)).toEqual(['project-list', 'project-other']);
    expect(fileMocks.loadProjectData).not.toHaveBeenCalled();
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(pollMocks.resumePendingTasks).not.toHaveBeenCalled();
    expect(metadataMocks.getLastActiveProjectId).not.toHaveBeenCalled();
    expect(metadataMocks.setLastActiveProjectId).not.toHaveBeenCalled();
    expect(useAppStore.getState().loadConversationsForProject).not.toHaveBeenCalled();
    expect(useAppStore.getState().repairInterruptedAgentTasksForProject).toHaveBeenCalledWith('project-list');
    expect(useAppStore.getState().repairInterruptedAgentTasksForProject).toHaveBeenCalledWith('project-other');

    fileMocks.loadProjectData.mockResolvedValue({ id: 'project-list', nodes: [], edges: [], name: '列表项目' });
    await useAppStore.getState().switchProject('project-list');
    expect(useAppStore.getState().currentProjectId).toBe('project-list');
    expect(fileMocks.loadProjectData).toHaveBeenCalledWith('project-list');
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
  });

  it('keeps an empty startup list without creating a default canvas', async () => {
    stubInitializationActions();
    useAppStore.setState({ config: { ...useAppStore.getState().config, startupView: 'project-library' } });
    fileMocks.loadProjectsList.mockResolvedValue([]);

    await useAppStore.getState().initFromDb();

    expect(useAppStore.getState()).toMatchObject({ projects: [], currentProjectId: null, projectLoadStatus: 'ready' });
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(fileMocks.ensureProjectDataDir).not.toHaveBeenCalled();
    expect(metadataMocks.setLastActiveProjectId).not.toHaveBeenCalled();
  });
});

describe('returning to the startup page', () => {
  function openProject() {
    useAppStore.setState({
      projects: [{ id: 'logo-project', name: 'Logo 项目', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'logo-project', projectName: 'Logo 项目',
      nodes: [{ id: 'text', type: 'ai-text', position: { x: 0, y: 0 }, data: { label: '已编辑内容' } as BaseNodeData }],
      selectedNodeIds: ['text'], assetsPanelOpen: true, chatOpen: true,
      activeNodeId: 'text', projectLibraryOpen: true,
    });
  }

  it('returns after saving even when thumbnail encoding remains pending', async () => {
    openProject();
    let finishSnapshot!: (snapshot: string) => void;
    snapshotMocks.captureCurrentCanvasSnapshot.mockReturnValue(new Promise((resolve) => { finishSnapshot = resolve; }));
    const nodes = useAppStore.getState().nodes;
    const edges = useAppStore.getState().edges;

    expect(await useAppStore.getState().returnToStartPage()).toBe(true);
    expect(useAppStore.getState().currentProjectId).toBeNull();
    expect(snapshotMocks.captureCurrentCanvasSnapshot).toHaveBeenCalledWith('logo-project', { nodes, edges }, { fresh: true });
    expect(fileMocks.saveProject).toHaveBeenCalledOnce();

    finishSnapshot('data:image/webp;base64,LATE_PREVIEW');
    await vi.advanceTimersByTimeAsync(0);
    expect(metadataMocks.updateProjectSnapshot).toHaveBeenCalledWith('logo-project', 'data:image/webp;base64,LATE_PREVIEW');
    expect(fileMocks.saveProject).toHaveBeenCalledOnce();
    expect(useAppStore.getState().currentProjectId).toBeNull();
  });

  it('refreshes the thumbnail on departure even if store references have not changed', async () => {
    openProject();
    snapshotMocks.captureCurrentCanvasSnapshot
      .mockResolvedValueOnce('data:image/webp;base64,BEFORE_MEDIA_READY')
      .mockResolvedValueOnce('data:image/webp;base64,EXIT_FRAME');
    await useAppStore.getState().captureCurrentProjectSnapshot();

    expect(await useAppStore.getState().returnToStartPage()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(snapshotMocks.captureCurrentCanvasSnapshot).toHaveBeenCalledTimes(2);
    expect(snapshotMocks.captureCurrentCanvasSnapshot).toHaveBeenLastCalledWith(
      'logo-project',
      { nodes: expect.any(Array), edges: expect.any(Array) },
      { fresh: true },
    );
    expect(useAppStore.getState().projects[0].snapshot).toBe('data:image/webp;base64,EXIT_FRAME');
    expect(metadataMocks.updateProjectSnapshot).toHaveBeenCalledWith('logo-project', 'data:image/webp;base64,EXIT_FRAME');
    expect(fileMocks.saveProject).toHaveBeenCalledOnce();
  });

  it('queues necessary canvas saving before an immediate empty-preview patch', async () => {
    openProject();
    useAppStore.setState((state) => ({
      nodes: [], projects: state.projects.map((project) => ({ ...project, snapshot: 'data:image/webp;base64,OLD' })),
    }));
    let finishSave!: () => void;
    fileMocks.saveProject.mockImplementation((record) => new Promise<string>((resolve) => {
      finishSave = () => resolve(record.id);
    }));

    const returning = useAppStore.getState().returnToStartPage();
    await vi.advanceTimersByTimeAsync(0);
    expect(fileMocks.saveProject).toHaveBeenCalledOnce();
    expect(metadataMocks.updateProjectSnapshot).not.toHaveBeenCalled();

    finishSave();
    expect(await returning).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(metadataMocks.updateProjectSnapshot).toHaveBeenCalledWith('logo-project', undefined);
    expect(fileMocks.saveProject.mock.invocationCallOrder[0])
      .toBeLessThan(metadataMocks.updateProjectSnapshot.mock.invocationCallOrder[0]);
    expect(fileMocks.saveProject).toHaveBeenCalledOnce();
    expect(snapshotMocks.captureCurrentCanvasSnapshot).not.toHaveBeenCalled();
  });

  it('reuses an in-flight autosave for an unchanged canvas and shared series library', async () => {
    openProject();
    useAppStore.setState((state) => ({ projects: [
      { id: 'series', name: 'Series', createdAt: 1, updatedAt: 1 },
      { ...state.projects[0], parentId: 'series', episodeNo: 1 },
    ] }));
    const finishes: Array<() => void> = [];
    fileMocks.saveProject.mockImplementation((record) => new Promise<string>((resolve) => {
      finishes.push(() => resolve(record.id));
    }));
    const autosave = useAppStore.getState().saveCurrentProjectSilent();
    const returning = useAppStore.getState().returnToStartPage();
    await vi.advanceTimersByTimeAsync(0);
    expect(fileMocks.saveProject).toHaveBeenCalledTimes(2);
    expect(fileMocks.saveProject.mock.calls.map(([record]) => record.id)).toEqual(['logo-project', 'series']);
    finishes.forEach((finish) => finish());

    expect(await autosave).toBe('logo-project');
    expect(await returning).toBe(true);
    expect(fileMocks.saveProject).toHaveBeenCalledTimes(2);
  });

  it('queues a changed canvas behind its older autosave instead of coalescing it', async () => {
    openProject();
    const finishes: Array<() => void> = [];
    fileMocks.saveProject.mockImplementation((record) => new Promise<string>((resolve) => {
      finishes.push(() => resolve(record.id));
    }));
    const autosave = useAppStore.getState().saveCurrentProjectSilent();
    useAppStore.getState().updateNodeDataTransient('text', { label: '新的内容' });
    const returning = useAppStore.getState().returnToStartPage();
    await vi.advanceTimersByTimeAsync(0);
    expect(fileMocks.saveProject).toHaveBeenCalledOnce();
    finishes[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(fileMocks.saveProject).toHaveBeenCalledTimes(2);
    expect(fileMocks.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      nodes: [expect.objectContaining({ data: expect.objectContaining({ label: '新的内容' }) })],
    }));
    finishes[1]();

    await autosave;
    expect(await returning).toBe(true);
  });

  it('drops an older thumbnail that completes after a newer capture and project departure', async () => {
    openProject();
    let finishOld!: (snapshot: string) => void;
    let finishNew!: (snapshot: string) => void;
    snapshotMocks.captureCurrentCanvasSnapshot
      .mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { finishNew = resolve; }));
    const older = useAppStore.getState().captureCurrentProjectSnapshot({ allowProjectChange: true, persistSnapshot: true });
    useAppStore.getState().updateNodeDataTransient('text', { label: '新的内容' });
    const newer = useAppStore.getState().captureCurrentProjectSnapshot({ allowProjectChange: true, persistSnapshot: true });
    useAppStore.setState({ currentProjectId: null, nodes: [], edges: [] });

    finishNew('data:image/webp;base64,NEW');
    await newer;
    finishOld('data:image/webp;base64,OLD');
    expect(await older).toBeUndefined();
    expect(metadataMocks.updateProjectSnapshot).toHaveBeenCalledOnce();
    expect(metadataMocks.updateProjectSnapshot).toHaveBeenCalledWith('logo-project', 'data:image/webp;base64,NEW');
    expect(useAppStore.getState().projects[0]?.snapshot).toBe('data:image/webp;base64,NEW');
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
  });

  it('does not restore an old thumbnail after the canvas was cleared', async () => {
    openProject();
    let finishOld!: (snapshot: string) => void;
    snapshotMocks.captureCurrentCanvasSnapshot.mockReturnValue(new Promise((resolve) => { finishOld = resolve; }));
    const older = useAppStore.getState().captureCurrentProjectSnapshot({ allowProjectChange: true, persistSnapshot: true });
    useAppStore.setState({ nodes: [] });
    await useAppStore.getState().captureCurrentProjectSnapshot();
    useAppStore.setState({ currentProjectId: null });

    finishOld('data:image/webp;base64,OLD');
    expect(await older).toBeUndefined();
    expect(metadataMocks.updateProjectSnapshot).not.toHaveBeenCalled();
    expect(useAppStore.getState().projects[0]?.snapshot).toBeUndefined();
  });

  it('persists a late thumbnail after queued newer canvas content', async () => {
    openProject();
    const finishes: Array<() => void> = [];
    fileMocks.saveProject.mockImplementation((record) => new Promise<string>((resolve) => {
      finishes.push(() => resolve(record.id));
    }));
    const firstSave = useAppStore.getState().saveCurrentProjectSilent();
    snapshotMocks.captureCurrentCanvasSnapshot.mockResolvedValue('data:image/webp;base64,PREVIEW');
    const capturing = useAppStore.getState().captureCurrentProjectSnapshot({ persistSnapshot: true });
    await vi.advanceTimersByTimeAsync(0);
    useAppStore.getState().updateNodeDataTransient('text', { label: '后续编辑' });
    const newerSave = useAppStore.getState().saveCurrentProjectSilent();
    finishes[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(fileMocks.saveProject).toHaveBeenCalledTimes(2);
    expect(metadataMocks.updateProjectSnapshot).not.toHaveBeenCalled();
    finishes[1]();

    await Promise.all([firstSave, newerSave, capturing]);
    expect(fileMocks.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      nodes: [expect.objectContaining({ data: expect.objectContaining({ label: '后续编辑' }) })],
    }));
    expect(metadataMocks.updateProjectSnapshot).toHaveBeenCalledOnce();
  });

  it('does not wait forever for a suspended animation frame before returning', async () => {
    openProject();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    try {
      const returning = useAppStore.getState().returnToStartPage();
      await vi.advanceTimersByTimeAsync(100);
      expect(await returning).toBe(true);
      expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('waits for saving before leaving the canvas and keeps the project available to reopen', async () => {
    openProject();
    let finishSave!: (id: string) => void;
    fileMocks.saveProject.mockImplementation(() => new Promise<string>((resolve) => { finishSave = resolve; }));
    const pending = useAppStore.getState().returnToStartPage();
    await vi.advanceTimersByTimeAsync(0);
    expect(useAppStore.getState().currentProjectId).toBe('logo-project');
    expect(useAppStore.getState().isReturningToStartPage).toBe(true);
    finishSave('logo-project');
    expect(await pending).toBe(true);
    expect(fileMocks.saveProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'logo-project', nodes: expect.arrayContaining([expect.objectContaining({ id: 'text' })]) }));
    expect(useAppStore.getState()).toMatchObject({
      currentProjectId: null, projectLoadStatus: 'ready', nodes: [], edges: [], groups: [],
      selectedNodeIds: [], activeNodeId: null, assetsPanelOpen: false, chatOpen: false,
      projectLibraryOpen: false, isReturningToStartPage: false,
    });
    expect(useAppStore.getState().projects).toHaveLength(1);
    fileMocks.loadProjectData.mockResolvedValue({ id: 'logo-project', nodes: [], edges: [] });
    await useAppStore.getState().switchProject('logo-project');
    expect(useAppStore.getState().currentProjectId).toBe('logo-project');
  });

  it.each(['added', 'completed'] as const)('keeps MCP media %s during an in-flight return save', async (change) => {
    openProject();
    const showToast = vi.fn();
    useAppStore.setState({ showToast });
    const media = {
      id: 'mcp-image', type: 'source-image', position: { x: 300, y: 0 },
      data: { label: 'MCP 图片', type: 'source-image', status: 'loading' } as BaseNodeData,
    };
    if (change === 'completed') useAppStore.getState().addNodes([media]);
    let finishSave!: (id: string) => void;
    fileMocks.saveProject.mockImplementationOnce(() => new Promise<string>((resolve) => { finishSave = resolve; }));
    const pending = useAppStore.getState().returnToStartPage();
    await vi.advanceTimersByTimeAsync(0);

    const result: Partial<BaseNodeData> = {
      status: 'success', filePath: 'project-dir/mcp.png', imageUrl: 'asset://project-dir/mcp.png',
    };
    if (change === 'added') useAppStore.getState().addNodes([{ ...media, data: { ...media.data, ...result } }]);
    else useAppStore.getState().updateNodeDataTransient(media.id, result);
    finishSave('logo-project');

    expect(await pending).toBe(false);
    expect(useAppStore.getState()).toMatchObject({
      currentProjectId: 'logo-project', isReturningToStartPage: false,
      nodes: expect.arrayContaining([expect.objectContaining({ id: media.id, data: expect.objectContaining(result) })]),
    });
    expect(showToast).toHaveBeenCalledWith('保存期间画布有新变化，已保留当前项目，请稍后再返回启动页', 'error');

    expect(await useAppStore.getState().returnToStartPage()).toBe(true);
    expect(fileMocks.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'logo-project',
      nodes: expect.arrayContaining([expect.objectContaining({ id: media.id, data: expect.objectContaining(result) })]),
    }));
    expect(useAppStore.getState().autoSaveFailure).toBeNull();
  });

  it('keeps the current canvas when saving fails', async () => {
    openProject();
    fileMocks.saveProject.mockRejectedValue(new Error('Save unavailable'));
    expect(await useAppStore.getState().returnToStartPage()).toBe(false);
    expect(useAppStore.getState()).toMatchObject({ currentProjectId: 'logo-project', nodes: [expect.objectContaining({ id: 'text' })], isReturningToStartPage: false });
  });

  it('does not replace a different project selected while saving was in progress', async () => {
    openProject();
    let finishSave!: (id: string) => void;
    fileMocks.saveProject.mockImplementation(() => new Promise<string>((resolve) => { finishSave = resolve; }));
    const pending = useAppStore.getState().returnToStartPage();
    await vi.advanceTimersByTimeAsync(0);
    useAppStore.setState({ currentProjectId: 'another-project' });
    finishSave('logo-project');
    expect(await pending).toBe(false);
    expect(useAppStore.getState().currentProjectId).toBe('another-project');
  });

  it('ignores repeated returns and blocks create/switch until saving finishes', async () => {
    openProject();
    let finishSave!: (id: string) => void;
    fileMocks.saveProject.mockImplementation(() => new Promise<string>((resolve) => { finishSave = resolve; }));
    const pending = useAppStore.getState().returnToStartPage();
    await vi.advanceTimersByTimeAsync(0);
    expect(await useAppStore.getState().returnToStartPage()).toBe(false);
    expect(await useAppStore.getState().createProject()).toBeUndefined();
    await useAppStore.getState().switchProject('logo-project');
    expect(fileMocks.loadProjectData).not.toHaveBeenCalled();
    expect(fileMocks.saveProject).toHaveBeenCalledOnce();
    finishSave('logo-project');
    await pending;
  });

  it('leaves an unready project intact', async () => {
    openProject();
    useAppStore.setState({ projectLoadStatus: 'error' });
    expect(await useAppStore.getState().returnToStartPage()).toBe(false);
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(useAppStore.getState().currentProjectId).toBe('logo-project');
  });
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
