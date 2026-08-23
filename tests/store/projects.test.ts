import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import type { ProjectDataDirRenameResult } from '../../src/services/fs/core';

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
}));

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
vi.mock('../../src/services/indexedDbService', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/indexedDbService')>(
    '../../src/services/indexedDbService',
  );
  return { ...actual, ...metadataMocks };
});

import { useAppStore } from '../../src/store/useAppStore';

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
});

function stubInitializationActions() {
  useAppStore.setState({
    loadConfig: vi.fn(async () => undefined),
    loadWorkflows: vi.fn(async () => undefined),
    loadPresets: vi.fn(async () => undefined),
    loadSkills: vi.fn(async () => undefined),
    loadSubAgentProfiles: vi.fn(async () => undefined),
    loadCustomStyles: vi.fn(async () => undefined),
    loadToolbarLayouts: vi.fn(async () => undefined),
    loadPlugins: vi.fn(async () => undefined),
    loadConversationsForProject: vi.fn(async () => undefined),
    repairInterruptedForProject: vi.fn(async () => undefined),
    loadProjectMemoriesForProject: vi.fn(async () => undefined),
    repairInterruptedAgentTasksForProject: vi.fn(async () => []),
  });
}

describe('project creation', () => {
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
    });
    useAppStore.setState({
      projects: [
        { id: 'project-old', name: 'Old project', createdAt: 1, updatedAt: 1 },
        { id: 'project-new', name: 'New project', createdAt: 2, updatedAt: 3 },
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
    expect(fileMocks.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      id: 'project-2',
      snapshot: 'data:image/webp;base64,PROJECT_TWO',
    }));
    expect(fileMocks.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      id: 'project-3',
      snapshot: 'data:image/webp;base64,PROJECT_THREE',
    }));
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
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(useAppStore.getState().projects.find((item) => item.id === 'project-2')?.snapshot)
      .toBe('data:image/webp;base64,COMPLEX_PROJECT');
    expect(fileMocks.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      id: 'project-2',
      snapshot: 'data:image/webp;base64,COMPLEX_PROJECT',
    }));
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
    metadataMocks.getLastActiveProjectId.mockResolvedValue('project-remembered');
    fileMocks.loadProjectsList.mockResolvedValue([
      {
        id: 'project-newest', name: 'Newest', createdAt: 2, updatedAt: 20, nodes: [], edges: [],
      },
      {
        id: 'project-remembered', name: 'Remembered', createdAt: 1, updatedAt: 10, nodes: [], edges: [],
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
    });

    await useAppStore.getState().initFromDb();

    expect(fileMocks.loadProjectData).toHaveBeenCalledWith('project-remembered');
    expect(useAppStore.getState()).toMatchObject({
      currentProjectId: 'project-remembered',
      projectLoadStatus: 'ready',
    });
    expect(useAppStore.getState().nodes.map((node) => node.id)).toEqual(['remembered-node']);
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
});
