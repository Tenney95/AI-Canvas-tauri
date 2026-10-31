/**
 * 剧集/分集：分集画布各自独立，角色库与素材目录整部剧共用一份。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDataDirRenameResult } from '../../src/services/fs/core';
import type { DramaAssetLibrary } from '../../src/types/dramaAssets';

type SavedRecord = import('../../src/services/storageService').ProjectSaveData;

const fileMocks = vi.hoisted(() => ({
  deleteProjectData: vi.fn(async (_projectId: string) => undefined),
  deleteProjectDataDir: vi.fn(async (_projectId: string) => undefined),
  flushUndoTrashDirs: vi.fn(async () => undefined),
  ensureProjectDataDir: vi.fn(async () => 'project-dir'),
  loadProjectData: vi.fn(),
  loadProjectsList: vi.fn(),
  registerProjectFolder: vi.fn(),
  registerProjectFolders: vi.fn(),
  saveProject: vi.fn(async (
    record: import('../../src/services/storageService').ProjectSaveData,
  ) => record.id),
  buildProjectFolderName: vi.fn((name: string, projectId: string) => (
    `${name}-${projectId.replace(/-/g, '').slice(0, 8)}`
  )),
  renameProjectDataDir: vi.fn(async (): Promise<ProjectDataDirRenameResult | null> => null),
  revertProjectDataDirRename: vi.fn(async () => undefined),
  getAssetUrlFromPath: vi.fn(async (path: string) => `asset://${path}`),
}));
const memoryMocks = vi.hoisted(() => ({
  reassignProjectMemories: vi.fn(async () => undefined),
}));

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
vi.mock('../../src/services/projectSnapshotService', () => ({
  captureCurrentCanvasSnapshot: vi.fn(async () => null),
}));
vi.mock('../../src/services/chat/projectMemoryService', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/chat/projectMemoryService')>(
    '../../src/services/chat/projectMemoryService',
  );
  return { ...actual, ...memoryMocks };
});

import { useAppStore } from '../../src/store/useAppStore';

function library(characterName: string): DramaAssetLibrary {
  return {
    version: 2,
    characters: [{
      id: `character-${characterName}`,
      kind: 'character',
      name: characterName,
      key: characterName,
      summary: '',
      visualNotes: '',
      identity: '',
      importance: 'main',
      confirmed: true,
      createdAt: 1,
      updatedAt: 1,
      source: 'manual',
    }],
    scenes: [],
    props: [],
  };
}

function emptyCanvas(id: string, name: string) {
  return { id, name, createdAt: 1, updatedAt: 1, nodes: [], edges: [], groups: [] };
}

beforeEach(() => {
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.stubGlobal('CustomEvent', class TestCustomEvent {
    type: string;

    constructor(type: string) {
      this.type = type;
    }
  });
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    projectLoadStatus: 'ready',
    loadConversationsForProject: vi.fn(async () => undefined),
    repairInterruptedForProject: vi.fn(async () => undefined),
    loadAgentTasksForProject: vi.fn(async () => undefined),
    loadProjectMemoriesForProject: vi.fn(async () => undefined),
    removeProjectAgentTasks: vi.fn(),
    removeProjectMemories: vi.fn(),
  });
  fileMocks.saveProject.mockReset();
  fileMocks.saveProject.mockImplementation(async (record: SavedRecord) => record.id);
  fileMocks.loadProjectData.mockReset();
  fileMocks.deleteProjectData.mockClear();
  fileMocks.deleteProjectDataDir.mockClear();
  memoryMocks.reassignProjectMemories.mockClear();
});

describe('新增分集', () => {
  it('把普通项目转成剧集：原项目变成第 1 集，角色库改挂到剧集项目', async () => {
    const dramaAssets = library('林夏');
    useAppStore.setState({
      projects: [{
        id: 'project-a',
        name: '月球列车',
        createdAt: 1,
        updatedAt: 1,
        dataFolder: '月球列车-projecta',
      }],
      currentProjectId: 'project-a',
      projectName: '月球列车',
      nodes: [],
      edges: [],
      groups: [],
      dramaAssets,
    });
    fileMocks.loadProjectData.mockImplementation(async (projectId: string) => (
      projectId === 'project-a'
        ? { ...emptyCanvas('project-a', '月球列车'), dataFolder: '月球列车-projecta' }
        : emptyCanvas(projectId, '第 2 集')
    ));

    const episodeId = await useAppStore.getState().addEpisode();

    const state = useAppStore.getState();
    const series = state.projects.find((project) => (
      !project.parentId && project.id !== 'project-a'
    ));
    expect(series).toBeDefined();
    // 原项目原地变成第 1 集，画布记录不动
    expect(state.projects.find((project) => project.id === 'project-a')).toMatchObject({
      parentId: series!.id,
      episodeNo: 1,
    });
    expect(state.projects.find((project) => project.id === episodeId)).toMatchObject({
      parentId: series!.id,
      episodeNo: 2,
      dataFolder: '月球列车-projecta',
    });
    expect(state.currentProjectId).toBe(episodeId);
    expect(memoryMocks.reassignProjectMemories).toHaveBeenCalledWith('project-a', series!.id);

    // 角色库只写在剧集项目上，分集记录不带副本
    const seriesRecord = fileMocks.saveProject.mock.calls
      .map((call) => call[0])
      .find((record) => record.id === series!.id);
    expect(seriesRecord).toMatchObject({ dataFolder: '月球列车-projecta', dramaAssets });
    const episodeRecords = fileMocks.saveProject.mock.calls
      .map((call) => call[0])
      .filter((record) => record.id === episodeId || record.parentId);
    expect(episodeRecords.length).toBeGreaterThan(0);
    episodeRecords.forEach((record) => expect(record.dramaAssets).toBeUndefined());
    // 同一部剧内换集不清空角色库
    expect(state.dramaAssets).toEqual(dramaAssets);
  });
});

describe('批量新增分集', () => {
  it('接着现有集号建，写入大纲，且不切走当前画布', async () => {
    useAppStore.setState({
      projects: [
        { id: 'series', name: '月球列车', createdAt: 1, updatedAt: 1, dataFolder: 'moon' },
        { id: 'ep-1', name: '第 1 集', createdAt: 1, updatedAt: 1, dataFolder: 'moon', parentId: 'series', episodeNo: 1 },
      ],
      currentProjectId: 'ep-1',
      projectName: '第 1 集',
      nodes: [],
      edges: [],
      groups: [],
    });
    fileMocks.loadProjectData.mockImplementation(async (projectId: string) => (
      emptyCanvas(projectId, projectId)
    ));

    const ids = await useAppStore.getState().addEpisodes([
      { name: '通讯器', outline: '林夏听见十年前的自己' },
      { outline: '列车终于进站' },
    ]);

    const state = useAppStore.getState();
    expect(ids).toHaveLength(2);
    expect(ids.map((id) => state.projects.find((project) => project.id === id))).toMatchObject([
      { name: '通讯器', episodeNo: 2, parentId: 'series', episodeOutline: '林夏听见十年前的自己' },
      { name: '第 3 集', episodeNo: 3, parentId: 'series', episodeOutline: '列车终于进站' },
    ]);
    // 批量创建不切画布，用户留在原来那一集
    expect(state.currentProjectId).toBe('ep-1');
  });

  it('中途保存失败时保留已经建成的分集', async () => {
    const showToast = vi.fn();
    useAppStore.setState({
      projects: [
        { id: 'series', name: '月球列车', createdAt: 1, updatedAt: 1, dataFolder: 'moon' },
        { id: 'ep-1', name: '第 1 集', createdAt: 1, updatedAt: 1, dataFolder: 'moon', parentId: 'series', episodeNo: 1 },
      ],
      currentProjectId: 'ep-1',
      projectName: '第 1 集',
      nodes: [],
      edges: [],
      groups: [],
      showToast,
    });
    // 只让第二个新分集写盘失败，已存在的项目照常保存
    const existingIds = new Set(['series', 'ep-1']);
    let createdCount = 0;
    fileMocks.saveProject.mockImplementation(async (record: SavedRecord) => {
      if (!existingIds.has(record.id)) {
        createdCount += 1;
        if (createdCount >= 2) throw new Error('disk full');
      }
      return record.id;
    });

    const ids = await useAppStore.getState().addEpisodes([
      { outline: '第一段' },
      { outline: '第二段' },
    ]);

    expect(ids).toHaveLength(1);
    expect(showToast).toHaveBeenCalledWith('只成功新增了 1 集', 'error');
    expect(useAppStore.getState().projects).toHaveLength(3);
  });
});

describe('分集切换', () => {
  it('同一部剧内换集保留角色库，保存时把角色库写回剧集项目', async () => {
    const dramaAssets = library('林夏');
    useAppStore.setState({
      projects: [
        { id: 'series', name: '月球列车', createdAt: 1, updatedAt: 1, dataFolder: 'moon' },
        { id: 'ep-1', name: '第 1 集', createdAt: 1, updatedAt: 1, dataFolder: 'moon', parentId: 'series', episodeNo: 1 },
        { id: 'ep-2', name: '第 2 集', createdAt: 2, updatedAt: 2, dataFolder: 'moon', parentId: 'series', episodeNo: 2 },
      ],
      currentProjectId: 'ep-1',
      projectName: '第 1 集',
      nodes: [],
      edges: [],
      groups: [],
      dramaAssets,
    });
    fileMocks.loadProjectData.mockImplementation(async (projectId: string) => ({
      ...emptyCanvas(projectId, projectId),
      nodes: [{
        id: `${projectId}-node`,
        type: 'ai-text',
        position: { x: 0, y: 0 },
        data: { label: projectId, type: 'ai-text' },
      }],
    }));

    await useAppStore.getState().switchProject('ep-2');

    const state = useAppStore.getState();
    expect(state.currentProjectId).toBe('ep-2');
    expect(state.nodes.map((node) => node.id)).toEqual(['ep-2-node']);
    // 换集不该把角色库读没了（剧集记录里的那份才是权威）
    expect(state.dramaAssets).toEqual(dramaAssets);
    // 记忆按剧集加载
    expect(state.loadProjectMemoriesForProject).toHaveBeenCalledWith('series');

    // 切换前已把共享库保存到剧集；同一份库再次保存时应复用成功基线。
    const switchingRecords = fileMocks.saveProject.mock.calls.map((call) => call[0]);
    expect(switchingRecords.find((record) => record.id === 'series')).toMatchObject({ dramaAssets });
    fileMocks.saveProject.mockClear();
    await useAppStore.getState().saveCurrentProjectSilent();
    const records = fileMocks.saveProject.mock.calls.map((call) => call[0]);
    const episodeRecord = records.find((record) => record.id === 'ep-2');
    expect(episodeRecord).toBeDefined();
    expect(episodeRecord?.dramaAssets).toBeUndefined();
    expect(records.find((record) => record.id === 'series')).toBeUndefined();

    // 修改共享库后必须再次落盘，不能让去重跳过真实更新。
    const changedLibrary = library('林夏与列车长');
    useAppStore.setState({ dramaAssets: changedLibrary });
    fileMocks.saveProject.mockClear();
    await useAppStore.getState().saveCurrentProjectSilent();
    const changedRecords = fileMocks.saveProject.mock.calls.map((call) => call[0]);
    expect(changedRecords.find((record) => record.id === 'series')).toMatchObject({ dramaAssets: changedLibrary });
  });

  it('打开剧集项目等于打开它的第一集', async () => {
    useAppStore.setState({
      projects: [
        { id: 'series', name: '月球列车', createdAt: 1, updatedAt: 1, dataFolder: 'moon' },
        { id: 'ep-2', name: '第 2 集', createdAt: 2, updatedAt: 2, parentId: 'series', episodeNo: 2 },
        { id: 'ep-1', name: '第 1 集', createdAt: 1, updatedAt: 1, parentId: 'series', episodeNo: 1 },
        { id: 'plain', name: '普通项目', createdAt: 1, updatedAt: 1 },
      ],
      currentProjectId: 'plain',
      projectName: '普通项目',
      nodes: [],
      edges: [],
      groups: [],
    });
    fileMocks.loadProjectData.mockImplementation(async (projectId: string) => (
      emptyCanvas(projectId, projectId)
    ));

    await useAppStore.getState().switchProject('series');

    expect(useAppStore.getState().currentProjectId).toBe('ep-1');
  });
});

describe('原著 / 剧本 / 大纲', () => {
  it('原著与剧本写在剧集项目上，本集大纲写在当前分集上', async () => {
    useAppStore.setState({
      projects: [
        { id: 'series', name: '月球列车', createdAt: 1, updatedAt: 1, dataFolder: 'moon' },
        { id: 'ep-1', name: '第 1 集', createdAt: 1, updatedAt: 1, dataFolder: 'moon', parentId: 'series', episodeNo: 1 },
      ],
      currentProjectId: 'ep-1',
      projectName: '第 1 集',
      nodes: [],
      edges: [],
      groups: [],
    });
    fileMocks.loadProjectData.mockImplementation(async (projectId: string) => (
      emptyCanvas(projectId, projectId)
    ));

    await useAppStore.getState().updateSeriesInfo({
      originalWork: { fileName: '原著.txt', relativePath: '原著.txt', addedAt: 2 },
    });
    await useAppStore.getState().updateSeriesInfo({ script: '第一集：站台' });
    await useAppStore.getState().updateEpisodeOutline('ep-1', '本集：等车');

    const state = useAppStore.getState();
    // 两次写入要合并，不能互相覆盖
    expect(state.projects.find((project) => project.id === 'series')?.series).toEqual({
      originalWork: { fileName: '原著.txt', relativePath: '原著.txt', addedAt: 2 },
      script: '第一集：站台',
    });
    expect(state.projects.find((project) => project.id === 'ep-1')?.episodeOutline).toBe('本集：等车');
    const outlineRecord = fileMocks.saveProject.mock.calls
      .map((call) => call[0])
      .filter((record) => record.id === 'ep-1')
      .pop();
    expect(outlineRecord).toMatchObject({ episodeOutline: '本集：等车' });
  });

  it('保存失败时回滚内存里的改动', async () => {
    const showToast = vi.fn();
    useAppStore.setState({
      projects: [
        { id: 'series', name: '月球列车', createdAt: 1, updatedAt: 1, dataFolder: 'moon' },
        { id: 'ep-1', name: '第 1 集', createdAt: 1, updatedAt: 1, parentId: 'series', episodeNo: 1 },
      ],
      currentProjectId: 'ep-1',
      projectName: '第 1 集',
      showToast,
    });
    fileMocks.loadProjectData.mockResolvedValue(emptyCanvas('series', '月球列车'));
    fileMocks.saveProject.mockRejectedValueOnce(new Error('disk full'));

    await expect(useAppStore.getState().updateSeriesInfo({ script: '写不进去' })).resolves.toBe(false);

    expect(useAppStore.getState().projects.find((project) => project.id === 'series')?.series)
      .toBeUndefined();
    expect(showToast).toHaveBeenCalledWith('保存失败，改动已回滚', 'error');
  });

  it('上下移动分集时交换集号', async () => {
    useAppStore.setState({
      projects: [
        { id: 'series', name: '月球列车', createdAt: 1, updatedAt: 1, dataFolder: 'moon' },
        { id: 'ep-1', name: '第 1 集', createdAt: 1, updatedAt: 1, parentId: 'series', episodeNo: 1 },
        { id: 'ep-2', name: '第 2 集', createdAt: 2, updatedAt: 2, parentId: 'series', episodeNo: 2 },
      ],
      currentProjectId: 'series',
      projectName: '月球列车',
    });
    fileMocks.loadProjectData.mockImplementation(async (projectId: string) => (
      emptyCanvas(projectId, projectId)
    ));

    await expect(useAppStore.getState().moveEpisode('ep-2', -1)).resolves.toBe(true);

    const state = useAppStore.getState();
    expect(state.projects.find((project) => project.id === 'ep-2')?.episodeNo).toBe(1);
    expect(state.projects.find((project) => project.id === 'ep-1')?.episodeNo).toBe(2);
    // 到顶了就不再动
    await expect(useAppStore.getState().moveEpisode('ep-2', -1)).resolves.toBe(false);
  });
});

describe('删除剧集', () => {
  it('连分集一起删，且只清一次共用素材目录', async () => {
    useAppStore.setState({
      projects: [
        { id: 'series', name: '月球列车', createdAt: 1, updatedAt: 1, dataFolder: 'moon' },
        { id: 'ep-1', name: '第 1 集', createdAt: 1, updatedAt: 1, dataFolder: 'moon', parentId: 'series', episodeNo: 1 },
        { id: 'ep-2', name: '第 2 集', createdAt: 2, updatedAt: 2, dataFolder: 'moon', parentId: 'series', episodeNo: 2 },
        { id: 'plain', name: '普通项目', createdAt: 1, updatedAt: 1, dataFolder: 'plain' },
      ],
      currentProjectId: 'ep-1',
      projectName: '第 1 集',
    });
    fileMocks.loadProjectData.mockImplementation(async (projectId: string) => (
      emptyCanvas(projectId, projectId)
    ));

    await useAppStore.getState().deleteProject('series');

    const state = useAppStore.getState();
    expect(state.projects.map((project) => project.id)).toEqual(['plain']);
    expect(fileMocks.deleteProjectData.mock.calls.map((call) => call[0]).sort())
      .toEqual(['ep-1', 'ep-2', 'series']);
    expect(fileMocks.deleteProjectDataDir.mock.calls.map((call) => call[0])).toEqual(['series']);
    expect(state.currentProjectId).toBe('plain');
  });

  it('删掉最后一集时剧集项目一并清掉', async () => {
    useAppStore.setState({
      projects: [
        { id: 'series', name: '月球列车', createdAt: 1, updatedAt: 1, dataFolder: 'moon' },
        { id: 'ep-1', name: '第 1 集', createdAt: 1, updatedAt: 1, dataFolder: 'moon', parentId: 'series', episodeNo: 1 },
        { id: 'plain', name: '普通项目', createdAt: 1, updatedAt: 1, dataFolder: 'plain' },
      ],
      currentProjectId: 'plain',
      projectName: '普通项目',
    });

    await useAppStore.getState().deleteProject('ep-1');

    expect(useAppStore.getState().projects.map((project) => project.id)).toEqual(['plain']);
    expect(fileMocks.deleteProjectDataDir.mock.calls.map((call) => call[0])).toEqual(['series']);
  });
});
