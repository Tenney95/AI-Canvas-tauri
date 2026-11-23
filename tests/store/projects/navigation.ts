import { expect, it, vi } from 'vitest';
import { registerScriptWorkbenchAppClose } from '../../../src/services/scriptWorkbenchAppClose';
import type { BaseNodeData } from '../../../src/types';
import type { ProjectSaveData } from '../../../src/services/storageService';
import { useAppStore } from '../../../src/store/useAppStore';
import { subscribeManualProjectSaveSuccess } from '../../../src/store/store.projects';
import type { ProjectNavigationFixture } from '../projects.test';

export function registerProjectSwitchTests({
  fileMocks,
  pollMocks,
  lifecycleMocks,
  snapshotMocks,
  metadataMocks,
  stubInitializationActions,
}: ProjectNavigationFixture) {
  it('从旧摘要切换后保留完整记录的revisionScope及创作配置，再保存不丢字段', async () => {
    stubInitializationActions();
    const selection = { id: 'creation-preserved', version: '1.0.0', sha256: 'a'.repeat(64) };
    const team = { version: 1 as const, name: '已保存团队',
      roles: { architect: 'a', writer: 'b', continuity: 'c', dialogue: 'd', director: 'f', storyboard: 'g', editor: 'e' },
      maxCalls: 8, maxTotalTokens: 240000, maxOutputChars: 16000 };
    const target = { id: 'metadata-preserved', name: '目标', createdAt: 2, updatedAt: 2 };
    fileMocks.loadProjectData.mockResolvedValue({ ...target, nodes: [], edges: [], groups: [],
      revisionScope: 'global', creationProfile: selection, teamProfileOverride: team });
    useAppStore.setState({ currentProjectId: 'metadata-origin', projectName: '原项目',
      projects: [{ id: 'metadata-origin', name: '原项目', createdAt: 1, updatedAt: 1 }, target],
      saveCurrentProject: vi.fn(async () => 'metadata-origin') });
    expect(await useAppStore.getState().switchProject(target.id)).toBe(target.id);
    expect(useAppStore.getState().projects.find((project) => project.id === target.id))
      .toMatchObject({ revisionScope: 'global', creationProfile: selection, teamProfileOverride: team });
    expect(await useAppStore.getState().saveCurrentProjectSilent()).toBe(target.id);
    expect(fileMocks.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      id: target.id, revisionScope: 'global', creationProfile: selection, teamProfileOverride: team,
    }));
  });

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
    expect(fileMocks.loadProjectData).toHaveBeenCalledWith('project-new', { recoverUndoTrash: true, assertCurrent: expect.any(Function) });
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
    const persisted = new Map<string, ProjectSaveData>([
      ['project-2', { id: 'project-2', name: 'Project 2', createdAt: 2, updatedAt: 4, nodes: projectTwoNodes, edges: [], groups: [] }],
      ['project-3', { id: 'project-3', name: 'Project 3', createdAt: 3, updatedAt: 4, nodes: projectThreeNodes, edges: [], groups: [] }],
    ]);
    fileMocks.loadProjectData.mockImplementation(async (projectId: string) => structuredClone(persisted.get(projectId) ?? null));
    fileMocks.saveProject.mockImplementation(async (record) => {
      persisted.set(record.id, structuredClone(record as ProjectSaveData));
      return record.id;
    });
    const patchSnapshot = async (id: string, snapshot: string | undefined) => {
      persisted.get(id)!.snapshot = snapshot;
      return true;
    };
    // 再次加载必须看到已经持久化的预览，不能用永远不变的假记录模拟真实 DB。
    metadataMocks.updateProjectSnapshot.mockImplementationOnce(patchSnapshot).mockImplementationOnce(patchSnapshot);
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
    expect(lifecycleMocks.deleteContent).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'project-old' }));
    expect(fileMocks.deleteProjectData).not.toHaveBeenCalled();
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

  it('keeps the project visible and polling recoverable when logical deletion fails', async () => {
    const showToast = vi.fn();
    lifecycleMocks.deleteContent.mockRejectedValueOnce(new Error('indexeddb unavailable'));
    useAppStore.setState({
      projects: [{ id: 'project-old', name: 'Old project', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'project-old',
      showToast,
    });

    await useAppStore.getState().deleteProject('project-old');

    expect(useAppStore.getState().projects.map((project) => project.id)).toEqual(['project-old']);
    expect(fileMocks.deleteProjectDataDir).not.toHaveBeenCalled();
    expect(pollMocks.stopPollingForDeletedProjects).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('项目未删除；已停止的任务不会自动重启', 'error');
  });

  it('唯一的真实项目也可以叫默认画布，删除后回到空列表', async () => {
    const project = { id: 'saved-default-canvas', name: '默认画布', createdAt: 1, updatedAt: 1 };
    useAppStore.setState({ projects: [project], currentProjectId: project.id, projectLoadStatus: 'ready' });

    await useAppStore.getState().deleteProject(project.id);

    expect(lifecycleMocks.deleteContent).toHaveBeenCalledWith(expect.objectContaining({ targetId: project.id }));
    expect(useAppStore.getState()).toMatchObject({ projects: [], currentProjectId: null, projectLoadStatus: 'ready' });
  });

  it.each(['loading', 'ready'] as const)('在 %s 状态下保留启动占位项，跳过持久化删除', async (status) => {
    const placeholder = { id: 'default', name: '默认画布', createdAt: 1, updatedAt: 1 };
    useAppStore.setState({ projects: [placeholder], currentProjectId: null, projectLoadStatus: status });

    await useAppStore.getState().deleteProject(placeholder.id);

    expect(useAppStore.getState().projects).toEqual([placeholder]);
    expect(lifecycleMocks.deleteContent).not.toHaveBeenCalled();
    expect(fileMocks.deleteProjectDataDir).not.toHaveBeenCalled();
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

  it('only a successful manual save notifies the automatic-save recovery host', async () => {
    useAppStore.setState({ projects: [{ id: 'project-a', name: 'A', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'project-a', projectName: 'A', projectLoadStatus: 'ready', nodes: [], edges: [], groups: [], showToast: vi.fn() });
    const saved = vi.fn();
    const unsubscribe = subscribeManualProjectSaveSuccess(saved);
    try {
      fileMocks.saveProject.mockRejectedValueOnce(new Error('disk full'));
      expect(await useAppStore.getState().saveCurrentProject()).toBeUndefined();
      expect(saved).not.toHaveBeenCalled();
      expect(await useAppStore.getState().saveCurrentProjectSilent()).toBe('project-a');
      expect(saved).not.toHaveBeenCalled();
      expect(await useAppStore.getState().saveCurrentProject()).toBe('project-a');
      expect(saved).toHaveBeenCalledExactlyOnceWith('project-a');
      unsubscribe();
      await useAppStore.getState().saveCurrentProject();
      expect(saved).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
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

    expect(fileMocks.loadProjectData).toHaveBeenCalledWith('project-remembered', { recoverUndoTrash: true, assertCurrent: expect.any(Function) });
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
    const placeholder = { id: 'default', name: '默认画布', createdAt: 1, updatedAt: 1 };
    useAppStore.setState({ projects: [placeholder], showToast });

    await useAppStore.getState().initFromDb();

    expect(useAppStore.getState()).toMatchObject({
      currentProjectId: null,
      projectLoadStatus: 'error',
    });
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('项目数据读取失败，未创建空项目', 'error');

    expect(useAppStore.getState().projects).toEqual([placeholder]);
    await useAppStore.getState().deleteProject(placeholder.id);
    expect(useAppStore.getState()).toMatchObject({ projects: [], currentProjectId: null, projectLoadStatus: 'error' });
    expect(lifecycleMocks.deleteContent).not.toHaveBeenCalled();
    expect(fileMocks.deleteProjectDataDir).not.toHaveBeenCalled();
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
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
    expect(fileMocks.loadProjectData).toHaveBeenCalledWith('project-list', { recoverUndoTrash: true, assertCurrent: expect.any(Function) });
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
}

export function registerStartupNavigationTests({ fileMocks, snapshotMocks, metadataMocks }: ProjectNavigationFixture) {
  function openProject() {
    useAppStore.setState({
      projects: [{ id: 'logo-project', name: 'Logo 项目', createdAt: 1, updatedAt: 1 }],
      currentProjectId: 'logo-project', projectName: 'Logo 项目',
      nodes: [{ id: 'text', type: 'ai-text', position: { x: 0, y: 0 }, data: { label: '已编辑内容' } as BaseNodeData }],
      selectedNodeIds: ['text'], assetsPanelOpen: true, chatOpen: true,
      activeNodeId: 'text', projectLibraryOpen: true,
    });
  }

  it.each([false, true])('waits for the workbench before saving or leaving the canvas (%s)', async (confirmed) => {
    openProject();
    let finishWorkbench!: (allowed: boolean) => void;
    const prepare = vi.fn(() => new Promise<boolean>((resolve) => { finishWorkbench = resolve; }));
    const unregister = registerScriptWorkbenchAppClose(prepare);
    try {
      const returning = useAppStore.getState().returnToStartPage();
      expect(prepare).toHaveBeenCalledWith('start');
      expect(useAppStore.getState()).toMatchObject({ currentProjectId: 'logo-project', isReturningToStartPage: false });
      expect(fileMocks.saveProject).not.toHaveBeenCalled();
      finishWorkbench(confirmed);
      expect(await returning).toBe(confirmed);
      expect(useAppStore.getState().currentProjectId).toBe(confirmed ? null : 'logo-project');
      expect(fileMocks.saveProject).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    } finally { unregister(); }
  });

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
}
