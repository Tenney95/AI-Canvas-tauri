import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';

const fileMocks = vi.hoisted(() => ({
  deleteProjectData: vi.fn(async () => undefined),
  deleteProjectDataDir: vi.fn(async () => undefined),
  flushUndoTrashDirs: vi.fn(async () => undefined),
  ensureProjectDataDir: vi.fn(async () => 'project-dir'),
  loadProjectData: vi.fn(),
  saveProject: vi.fn(async (record: { id: string }) => record.id),
}));
const pollMocks = vi.hoisted(() => ({
  resumePendingTasks: vi.fn(async () => undefined),
}));
const snapshotMocks = vi.hoisted(() => ({
  captureCurrentCanvasSnapshot: vi.fn(async () => null as string | null),
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
  fileMocks.loadProjectData.mockReset();
  fileMocks.deleteProjectData.mockClear();
  fileMocks.deleteProjectDataDir.mockClear();
  fileMocks.saveProject.mockClear();
  pollMocks.resumePendingTasks.mockClear();
  snapshotMocks.captureCurrentCanvasSnapshot.mockReset();
  snapshotMocks.captureCurrentCanvasSnapshot.mockResolvedValue(null);
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

    await useAppStore.getState().switchProject('project-new');

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

    await useAppStore.getState().switchProject('project-3');
    await useAppStore.getState().switchProject('project-2');

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
    const dramaAssets = { version: 1 as const, characters: [], scenes: [], props: [] };
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

    await useAppStore.getState().switchProject('project-3');

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
});
