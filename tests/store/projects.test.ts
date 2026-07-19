import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';

const fileMocks = vi.hoisted(() => ({
  flushUndoTrashDirs: vi.fn(async () => undefined),
  ensureProjectDataDir: vi.fn(async () => 'project-dir'),
  loadProjectData: vi.fn(),
}));
const pollMocks = vi.hoisted(() => ({
  resumePendingTasks: vi.fn(async () => undefined),
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
  pollMocks.resumePendingTasks.mockClear();
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

    expect(saveCurrentProject).toHaveBeenCalledTimes(1);
    expect(fileMocks.loadProjectData).toHaveBeenCalledWith('project-new');
    expect(saveCurrentProject.mock.invocationCallOrder[0]).toBeLessThan(
      fileMocks.loadProjectData.mock.invocationCallOrder[0],
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
});
