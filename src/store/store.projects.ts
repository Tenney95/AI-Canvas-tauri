/**
 * Project slice — multi-project management, save/load/init via IndexedDB
 */
import type { Node, Edge } from '@xyflow/react';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type {
  BaseNodeData,
  CanvasProject,
  NodeGroup,
  ProjectSeriesInfo,
  ProjectSettings,
} from '../types';
import type { ProjectSaveData } from '../services/fileService';
import {
  generateProjectId,
  listEpisodes,
  listTopLevelProjects,
  resolveOpenTargetId,
  seriesOwnerId,
} from './store.utils';
import * as fileService from '../services/fileService';
import { resumePendingTasks, clearProjectTasks } from '../services/pollManager';
import { normalizeProjectSettings } from '../services/projectSettingsService';
import { captureCurrentCanvasSnapshot } from '../services/projectSnapshotService';
import { stopProjectAgentTasks } from '../services/chat/agentTaskControl';
import { cancelProjectCanvasDerivations } from '../services/canvasDerivationGuard';
import { clearConversationFileGrants } from '../services/chat/fileGrantService';
import { reassignProjectMemories } from '../services/chat/projectMemoryService';
import { duplicateProjectArchive, exportProjectArchive, importProjectArchive } from '../services/projectTransferService';
import {
  getLastActiveProjectId,
  setLastActiveProjectId,
} from '../services/indexedDbService';

type ProjectLoadStatus = 'loading' | 'ready' | 'error';
let activeProjectMetadataWrite: Promise<void> = Promise.resolve();

function getProjectGroups(data: { groups?: unknown } | null | undefined): NodeGroup[] {
  return Array.isArray(data?.groups) ? (data.groups as NodeGroup[]) : [];
}

/**
 * 分集记录不持有角色库：整部剧共用一份，只写在剧集项目上，
 * 否则每集保存都会各存一份副本，改一集的角色其他集看不到。
 */
function ownedDramaAssets(
  project: CanvasProject,
  library: AppState['dramaAssets'],
): AppState['dramaAssets'] | undefined {
  return project.parentId ? undefined : library;
}

/**
 * 分集不单独持有素材目录，内存里把剧集项目的文件夹名补给分集后再注册，
 * 这样剧集改名只需要改剧集记录一处，分集记录里的旧值不会造成影响。
 */
function withInheritedDataFolders(projects: CanvasProject[]): CanvasProject[] {
  const folderById = new Map(projects.map((item) => [item.id, item.dataFolder]));
  return projects.map((item) => {
    const inherited = item.parentId ? folderById.get(item.parentId) : undefined;
    return inherited ? { ...item, dataFolder: inherited } : item;
  });
}

function hasProjectCanvasData(data: ProjectSaveData | null): data is ProjectSaveData {
  return Boolean(data && Array.isArray(data.nodes) && Array.isArray(data.edges));
}

function rememberActiveProject(projectId: string): void {
  activeProjectMetadataWrite = activeProjectMetadataWrite
    .then(() => setLastActiveProjectId(projectId))
    .catch(() => {
      console.warn('[项目] 最近打开项目记录失败', { projectId });
    });
}

function replacePathPrefix(path: string | undefined, oldDir: string, newDir: string): string | undefined {
  if (!path) return path;
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedOldDir = oldDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedNewDir = newDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedPath.startsWith(`${normalizedOldDir}/`)) return path;
  return `${normalizedNewDir}${normalizedPath.slice(normalizedOldDir.length)}`;
}

async function remapProjectNodePaths(
  nodes: Node<BaseNodeData>[],
  oldDir: string,
  newDir: string,
): Promise<Node<BaseNodeData>[]> {
  return Promise.all(nodes.map(async (node) => {
    const data = node.data as BaseNodeData;
    const nextFilePath = replacePathPrefix(data.filePath, oldDir, newDir);
    let changed = nextFilePath !== data.filePath;
    let nextData: BaseNodeData = changed ? { ...data, filePath: nextFilePath } : data;

    if (changed && nextFilePath) {
      const assetUrl = await fileService.getAssetUrlFromPath(nextFilePath);
      if (nextData.imageUrl) nextData.imageUrl = assetUrl;
      if (nextData.videoUrl) nextData.videoUrl = assetUrl;
      if (nextData.audioUrl) nextData.audioUrl = assetUrl;
    }

    if (Array.isArray(data.storyboardOverrides)) {
      const nextOverrides = await Promise.all(data.storyboardOverrides.map(async (override) => {
        if (!override) return override;
        const nextOverridePath = replacePathPrefix(override.filePath, oldDir, newDir);
        if (nextOverridePath === override.filePath) return override;
        changed = true;
        return {
          ...override,
          filePath: nextOverridePath,
          url: nextOverridePath ? await fileService.getAssetUrlFromPath(nextOverridePath) : override.url,
        };
      }));
      if (nextOverrides !== data.storyboardOverrides && nextOverrides.some((override, index) => override !== data.storyboardOverrides?.[index])) {
        nextData = nextData === data ? { ...data } : nextData;
        nextData.storyboardOverrides = nextOverrides;
      }
    }

    return changed ? { ...node, data: nextData } : node;
  }));
}

interface ProjectSaveWaiter {
  resolve: (projectId: string) => void;
  reject: (error: unknown) => void;
}

interface PendingProjectSave {
  record: ProjectSaveData;
  waiters: ProjectSaveWaiter[];
}

interface ProjectSaveQueue {
  running: boolean;
  pending: PendingProjectSave | null;
}

const projectSaveQueues = new Map<string, ProjectSaveQueue>();
let projectSwitchSequence = 0;

interface CapturedCanvasState {
  projectId: string;
  nodes: AppState['nodes'];
  edges: AppState['edges'];
  groups: AppState['groups'];
  viewportTransform: string;
}

interface CaptureProjectSnapshotOptions {
  allowProjectChange?: boolean;
  persistRecord?: ProjectSaveData | null;
}

let lastCapturedCanvasState: CapturedCanvasState | null = null;

function getCanvasViewportTransform(): string {
  if (typeof document === 'undefined') return '';
  const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
  return viewport?.style.transform ?? '';
}

function waitForLoadingPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function isCanvasSnapshotFresh(state: AppState, projectId: string): boolean {
  return lastCapturedCanvasState?.projectId === projectId
    && lastCapturedCanvasState.nodes === state.nodes
    && lastCapturedCanvasState.edges === state.edges
    && lastCapturedCanvasState.groups === state.groups
    && lastCapturedCanvasState.viewportTransform === getCanvasViewportTransform();
}

async function drainProjectSaveQueue(projectId: string, queue: ProjectSaveQueue): Promise<void> {
  if (queue.running) return;
  queue.running = true;

  try {
    while (queue.pending) {
      const batch = queue.pending;
      queue.pending = null;

      try {
        const savedProjectId = await fileService.saveProject(batch.record);
        batch.waiters.forEach((waiter) => waiter.resolve(savedProjectId));
      } catch (error) {
        batch.waiters.forEach((waiter) => waiter.reject(error));
      }
    }
  } finally {
    queue.running = false;
    if (queue.pending) {
      void drainProjectSaveQueue(projectId, queue);
    } else if (projectSaveQueues.get(projectId) === queue) {
      projectSaveQueues.delete(projectId);
    }
  }
}

function enqueueProjectSave(record: ProjectSaveData): Promise<string> {
  let queue = projectSaveQueues.get(record.id);
  if (!queue) {
    queue = { running: false, pending: null };
    projectSaveQueues.set(record.id, queue);
  }

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    if (queue.pending) {
      queue.pending.record = record;
      queue.pending.waiters.push(waiter);
    } else {
      queue.pending = { record, waiters: [waiter] };
    }
    void drainProjectSaveQueue(record.id, queue);
  });
}

function createCurrentProjectSaveRecord(state: AppState): ProjectSaveData | null {
  const projectId = state.currentProjectId;
  const project = state.projects.find((item) => item.id === projectId);
  if (!projectId || !project || state.projectLoadStatus !== 'ready') return null;

  return {
    id: projectId,
    name: state.projectName,
    createdAt: project.createdAt,
    updatedAt: Date.now(),
    snapshot: project.snapshot,
    dataFolder: project.dataFolder,
    settings: project.settings,
    parentId: project.parentId,
    episodeNo: project.episodeNo,
    episodeOutline: project.episodeOutline,
    series: project.series,
    nodes: state.nodes,
    edges: state.edges,
    groups: state.groups,
    dramaAssets: ownedDramaAssets(project, state.dramaAssets),
  };
}

/**
 * 当前画布是一集时，把内存里的角色库回写到剧集项目记录。
 * 剧集项目自身没有画布（switchProject 会重定向到分集），所以整条记录可以
 * 直接用内存中的项目元数据重建，不必先读盘。
 */
function createSeriesLibraryRecord(state: AppState): ProjectSaveData | null {
  const project = state.projects.find((item) => item.id === state.currentProjectId);
  const series = project?.parentId
    ? state.projects.find((item) => item.id === project.parentId)
    : undefined;
  if (!series) return null;

  return {
    id: series.id,
    name: series.name,
    createdAt: series.createdAt,
    updatedAt: Date.now(),
    snapshot: series.snapshot,
    dataFolder: series.dataFolder,
    settings: series.settings,
    series: series.series,
    nodes: [],
    edges: [],
    groups: [],
    dramaAssets: state.dramaAssets,
  };
}

/** 保存当前画布，同时把共享角色库写回它所属的剧集项目。 */
async function saveCurrentProjectRecord(state: AppState, record: ProjectSaveData): Promise<string> {
  const libraryRecord = createSeriesLibraryRecord(state);
  const [savedProjectId] = await Promise.all([
    enqueueProjectSave(record),
    libraryRecord ? enqueueProjectSave(libraryRecord) : Promise.resolve(undefined),
  ]);
  return savedProjectId;
}

export interface ProjectSlice {
  projects: CanvasProject[];
  currentProjectId: string | null;
  projectName: string;
  projectLoadStatus: ProjectLoadStatus;
  isCreatingProject: boolean;
  /** 正在切换到的画布名；非 null 时显示切换遮罩 */
  switchingProjectName: string | null;
  _autoSaveFailedNotified?: boolean;
  setProjectName: (name: string) => void;
  renameProject: (id: string, name: string) => Promise<boolean>;
  updateProjectSettings: (settings: ProjectSettings) => Promise<boolean>;
  captureCurrentProjectSnapshot: (
    options?: CaptureProjectSnapshotOptions,
  ) => Promise<string | undefined>;
  createProject: (name?: string) => Promise<string | undefined>;
  /** 在当前项目所属剧集下批量新增分集（不切画布）；当前项目还不是剧集时先转成剧集。 */
  addEpisodes: (entries: Array<{ name?: string; outline?: string }>) => Promise<string[]>;
  /** 新增一集并切过去。 */
  addEpisode: (name?: string) => Promise<string | undefined>;
  /** 写入当前剧集的原著与剧本；当前项目还不是剧集时先转成剧集。 */
  updateSeriesInfo: (info: ProjectSeriesInfo) => Promise<boolean>;
  /** 写入某一集的大纲 / 本集剧本片段。 */
  updateEpisodeOutline: (episodeId: string, outline: string) => Promise<boolean>;
  /** 与相邻的一集交换集号；direction 为 -1 上移、1 下移。 */
  moveEpisode: (episodeId: string, direction: -1 | 1) => Promise<boolean>;
  exportProject: (id: string) => Promise<boolean>;
  importProject: () => Promise<string | undefined>;
  /** 复制项目（含分集、对话与素材），复制完不切画布。 */
  duplicateProject: (id: string) => Promise<string | undefined>;
  deleteProject: (id: string) => Promise<void>;
  /** captureSnapshot：切走前给当前画布重拍缩略图，只有项目库弹窗需要（拍一张要跑一轮位图合成） */
  switchProject: (id: string, options?: { captureSnapshot?: boolean }) => void;
  saveCurrentProject: () => Promise<string | undefined>;
  saveCurrentProjectSilent: () => Promise<string | undefined>;
  loadProject: () => Promise<void>;
  initFromDb: () => Promise<void>;
}

type ProjectSliceSet = Parameters<StateCreator<AppState, [], [], ProjectSlice>>[0];
type ProjectSliceGet = Parameters<StateCreator<AppState, [], [], ProjectSlice>>[1];

/**
 * 重命名事务的补偿动作：把物理目录、文件夹名映射、内存中的项目名与素材路径一并
 * 恢复到重命名前的状态。缺少它时，目录已改名而记录未落盘，重启后会按旧 dataFolder
 * 去找已经改名的目录，导致素材全部丢失。
 */
async function rollbackProjectRename(params: {
  set: ProjectSliceSet;
  get: ProjectSliceGet;
  id: string;
  previousProject: CanvasProject;
  previousDataFolder: string | undefined;
  renamed: fileService.ProjectDataDirRenameResult | null;
}): Promise<void> {
  const { set, get, id, previousProject, previousDataFolder, renamed } = params;
  try {
    await fileService.revertProjectDataDirRename(id, renamed, previousDataFolder);

    const current = get();
    const restoredNodes = renamed && current.currentProjectId === id
      ? await remapProjectNodePaths(current.nodes, renamed.newDir, renamed.oldDir)
      : null;

    set((state) => ({
      ...(state.currentProjectId === id
        ? { projectName: previousProject.name, ...(restoredNodes ? { nodes: restoredNodes } : {}) }
        : {}),
      projects: state.projects.map((item) => (
        item.id === id
          ? {
            ...item,
            name: previousProject.name,
            updatedAt: previousProject.updatedAt,
            dataFolder: previousDataFolder,
          }
          : item
      )),
    }));
  } catch (error) {
    console.error('[项目重命名] 回滚失败:', error);
  }
}

/**
 * 把普通项目转成剧集：新建一个只存原著/剧本与共享角色库的剧集项目，
 * 原项目原地变成第 1 集。画布、对话、输出历史都留在原记录上不动，
 * 只有角色库和项目记忆改挂到剧集项目，素材目录两者共用同一个。
 */
async function promoteProjectToSeries(params: {
  set: ProjectSliceSet;
  get: ProjectSliceGet;
  project: CanvasProject;
}): Promise<string | undefined> {
  const { set, get, project } = params;
  const seriesId = generateProjectId();
  const now = Date.now();
  // 旧项目可能没有 dataFolder（按 id 回退定位目录），此时用 id 当文件夹名指向同一个目录。
  const dataFolder = project.dataFolder ?? project.id;

  try {
    await enqueueProjectSave({
      id: seriesId,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: now,
      dataFolder,
      settings: project.settings,
      nodes: [],
      edges: [],
      groups: [],
      dramaAssets: get().dramaAssets,
    });
  } catch (error) {
    console.warn('[转为剧集] 剧集项目保存失败:', error);
    return undefined;
  }

  fileService.registerProjectFolder(seriesId, dataFolder);
  await reassignProjectMemories(project.id, seriesId)
    .catch((error) => console.warn('[转为剧集] 项目记忆改挂失败:', error));

  // 原来的项目名留给剧集，画布本身改叫第 1 集，免得剧集和第一集重名。
  const firstEpisodeName = '第 1 集';
  set((state) => ({
    ...(state.currentProjectId === project.id ? { projectName: firstEpisodeName } : {}),
    projects: [
      ...state.projects.map((item) => (
        item.id === project.id
          ? {
            ...item,
            name: firstEpisodeName,
            parentId: seriesId,
            episodeNo: item.episodeNo ?? 1,
            dataFolder,
          }
          : item
      )),
      {
        id: seriesId,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: now,
        dataFolder,
        settings: project.settings,
      },
    ],
    projectMemories: state.projectMemories.map((memory) => (
      memory.projectId === project.id ? { ...memory, projectId: seriesId } : memory
    )),
  }));
  // 立刻把 parentId 落盘：否则中途退出会留下一个空剧集，原项目还当自己是顶层项目。
  if (get().currentProjectId === project.id) await get().saveCurrentProjectSilent();
  return seriesId;
}

/** 取当前项目所属的剧集 id；还是普通项目时先转成剧集。 */
async function ensureCurrentSeriesId(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
): Promise<string | undefined> {
  const state = get();
  const current = state.projects.find((item) => item.id === state.currentProjectId);
  if (!current) return undefined;
  return current.parentId ?? await promoteProjectToSeries({ set, get, project: current });
}

/**
 * 改某个项目的元数据并落盘。当前画布用内存里的实时状态保存，其他项目读盘后打补丁再存，
 * 免得把还没保存的画布覆盖成磁盘上的旧版本。
 */
async function patchProjectRecord(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
  projectId: string,
  patch: Partial<CanvasProject>,
): Promise<boolean> {
  const previous = get().projects.find((item) => item.id === projectId);
  if (!previous) return false;
  const updatedAt = Date.now();

  set((state) => ({
    projects: state.projects.map((item) => (
      item.id === projectId ? { ...item, ...patch, updatedAt } : item
    )),
  }));

  try {
    if (get().currentProjectId === projectId) {
      if (await get().saveCurrentProjectSilent() !== projectId) throw new Error('当前画布保存失败');
    } else {
      const record = await fileService.loadProjectData(projectId);
      if (!record) throw new Error('无法读取项目数据');
      await enqueueProjectSave({ ...record, ...patch, updatedAt });
    }
    return true;
  } catch (error) {
    console.warn('[项目元数据] 保存失败:', error);
    set((state) => ({
      projects: state.projects.map((item) => (item.id === projectId ? previous : item)),
    }));
    get().showToast('保存失败，改动已回滚', 'error');
    return false;
  }
}

export const createProjectSlice: StateCreator<AppState, [], [], ProjectSlice> = (set, get) => ({
  projects: [
    { id: 'default', name: '默认画布', createdAt: Date.now(), updatedAt: Date.now() },
  ],
  currentProjectId: 'default',
  projectName: '新项目',
  projectLoadStatus: 'loading',
  isCreatingProject: false,
  switchingProjectName: null,

  setProjectName: (name) => {
    const state = get();
    const currentProjectId = state.currentProjectId;
    if (!currentProjectId) {
      set({ projectName: name });
      return;
    }
    if (state.projects.find((project) => project.id === currentProjectId)?.name === name.trim()) return;
    void get().renameProject(currentProjectId, name);
  },

  renameProject: async (id, name) => {
    const nextName = name.trim();
    if (!nextName) return false;

    const initialState = get();
    const project = initialState.projects.find((item) => item.id === id);
    if (!project) return false;
    if (initialState.currentProjectId === id && initialState.projectLoadStatus !== 'ready') {
      get().showToast('项目尚未成功加载，已阻止重命名保存', 'error');
      return false;
    }

    const persistedProject = initialState.currentProjectId === id
      ? null
      : await fileService.loadProjectData(id);
    if (initialState.currentProjectId !== id && !persistedProject) {
      get().showToast('无法读取项目，重命名失败', 'error');
      return false;
    }

    const updatedAt = Date.now();
    // 分集与剧集共用一个素材目录，改分集名不能动目录，否则整部剧的素材路径都会失效。
    const nextDataFolder = project.parentId
      ? project.dataFolder
      : fileService.buildProjectFolderName(nextName, id);
    const oldDataFolder = project.dataFolder;
    const dataFolderChanged = Boolean(nextDataFolder) && oldDataFolder !== nextDataFolder;

    set((state) => ({
      ...(state.currentProjectId === id ? { projectName: nextName } : {}),
      projects: state.projects.map((item) =>
        item.id === id ? { ...item, name: nextName, updatedAt } : item
      ),
    }));

    let renamed: fileService.ProjectDataDirRenameResult | null = null;
    try {
      renamed = dataFolderChanged && nextDataFolder
        ? await fileService.renameProjectDataDir(id, oldDataFolder, nextDataFolder)
        : null;
      const latest = get();
      if (!latest.projects.some((item) => item.id === id)) return false;

      let nextNodes: Node<BaseNodeData>[];
      let record: ProjectSaveData;
      if (latest.currentProjectId === id) {
        nextNodes = renamed
          ? await remapProjectNodePaths(latest.nodes, renamed.oldDir, renamed.newDir)
          : latest.nodes;
        const latestProject = latest.projects.find((item) => item.id === id)!;
        record = {
          id,
          name: nextName,
          createdAt: latestProject.createdAt,
          updatedAt,
          snapshot: latestProject.snapshot,
          dataFolder: renamed?.dataFolder ?? latestProject.dataFolder,
          settings: latestProject.settings,
          parentId: latestProject.parentId,
          episodeNo: latestProject.episodeNo,
          episodeOutline: latestProject.episodeOutline,
          series: latestProject.series,
          nodes: nextNodes,
          edges: latest.edges,
          groups: latest.groups,
          dramaAssets: ownedDramaAssets(latestProject, latest.dramaAssets),
        };
      } else {
        const source = persistedProject ?? await fileService.loadProjectData(id);
        if (!source) throw new Error('无法读取项目数据');
        nextNodes = renamed
          ? await remapProjectNodePaths(source.nodes as Node<BaseNodeData>[], renamed.oldDir, renamed.newDir)
          : source.nodes as Node<BaseNodeData>[];
        record = {
          ...source,
          name: nextName,
          updatedAt,
          dataFolder: renamed?.dataFolder ?? source.dataFolder,
          nodes: nextNodes,
        };
      }

      set((state) => ({
        ...(state.currentProjectId === id ? { projectName: nextName, nodes: nextNodes } : {}),
        projects: state.projects.map((item) => (
          item.id === id
            ? { ...item, name: nextName, updatedAt, dataFolder: record.dataFolder }
            : item
        )),
      }));
      await enqueueProjectSave(record);
      return true;
    } catch (error) {
      console.warn('[项目重命名] 保存失败，开始回滚:', error);
      await rollbackProjectRename({
        get,
        set,
        id,
        previousProject: project,
        previousDataFolder: oldDataFolder,
        renamed,
      });
      get().showToast('项目重命名失败，已恢复原名称', 'error');
      return false;
    }
  },

  updateProjectSettings: async (settings) => {
    const state = get();
    const projectId = state.currentProjectId;
    const previousProject = state.projects.find((project) => project.id === projectId);
    if (!projectId || !previousProject) return false;
    if (state.projectLoadStatus !== 'ready') {
      get().showToast('项目尚未成功加载，已阻止设置保存', 'error');
      return false;
    }

    const nextProject: CanvasProject = {
      ...previousProject,
      settings: normalizeProjectSettings(settings),
      updatedAt: Date.now(),
    };
    set((current) => ({
      projects: current.projects.map((project) => (
        project.id === projectId ? nextProject : project
      )),
    }));

    try {
      const record = createCurrentProjectSaveRecord(get());
      if (!record || record.id !== projectId) throw new Error('当前项目已切换，无法保存项目设置');
      await enqueueProjectSave({ ...record, updatedAt: nextProject.updatedAt });
      get().showToast('项目设置已保存');
      return true;
    } catch (error) {
      console.error('Save project settings failed:', error);
      set((current) => ({
        projects: current.projects.map((project) => (
          project.id === projectId ? previousProject : project
        )),
      }));
      get().showToast('项目设置保存失败', 'error');
      return false;
    }
  },

  captureCurrentProjectSnapshot: async (options = {}) => {
    const state = get();
    const projectId = state.currentProjectId;
    const project = state.projects.find((item) => item.id === projectId);
    if (!projectId || !project || state.projectLoadStatus !== 'ready') return undefined;

    if (state.nodes.length === 0) {
      lastCapturedCanvasState = null;
      if (project.snapshot) {
        set((current) => ({
          projects: current.projects.map((item) => (
            item.id === projectId ? { ...item, snapshot: undefined } : item
          )),
        }));
      }
      return projectId;
    }

    if (project.snapshot && isCanvasSnapshotFresh(state, projectId)) return projectId;

    const viewportTransform = getCanvasViewportTransform();
    const snapshot = await captureCurrentCanvasSnapshot(projectId);
    const latest = get();
    const projectStillExists = latest.projects.some((item) => item.id === projectId);
    if (!projectStillExists) return undefined;

    const isStillCurrent = latest.currentProjectId === projectId;
    const currentCanvasChanged = isStillCurrent && (
      latest.nodes !== state.nodes
      || latest.edges !== state.edges
      || latest.groups !== state.groups
      || getCanvasViewportTransform() !== viewportTransform
    );
    if (currentCanvasChanged || (!isStillCurrent && !options.allowProjectChange)) return undefined;

    if (snapshot) {
      lastCapturedCanvasState = {
        projectId,
        nodes: state.nodes,
        edges: state.edges,
        groups: state.groups,
        viewportTransform,
      };
      set((current) => ({
        projects: current.projects.map((item) => (
          item.id === projectId ? { ...item, snapshot } : item
        )),
      }));

      if (options.persistRecord) {
        const snapshotRecord: ProjectSaveData = {
          ...options.persistRecord,
          updatedAt: Date.now(),
          snapshot,
        };
        try {
          await enqueueProjectSave(snapshotRecord);
          set((current) => ({
            projects: current.projects.map((item) => (
              item.id === projectId
                ? { ...item, updatedAt: Math.max(item.updatedAt, snapshotRecord.updatedAt) }
                : item
            )),
          }));
        } catch (error) {
          console.warn('[项目快照] 持久化失败:', error);
        }
      }
    }
    return projectId;
  },

  createProject: async (name) => {
    if (get().isCreatingProject) return undefined;
    set({ isCreatingProject: true });
    try {
      const createSequence = ++projectSwitchSequence;
      const isLatestCreate = () => createSequence === projectSwitchSequence;
      await waitForLoadingPaint();
      if (!isLatestCreate()) return undefined;
      const previousProjectId = get().currentProjectId;

      if (previousProjectId) {
        const snapshotRecord = createCurrentProjectSaveRecord(get());
        void get().captureCurrentProjectSnapshot({
          allowProjectChange: true,
          persistRecord: snapshotRecord,
        });
        const savedProjectId = await get().saveCurrentProject();
        if (!isLatestCreate()) return undefined;
        if (savedProjectId !== previousProjectId) {
          get().showToast('当前项目保存失败，已取消新建项目', 'error');
          return undefined;
        }
      }

      const id = generateProjectId();
      let defaultName: string;
      if (name) {
        defaultName = name;
      } else {
        const existing = get().projects
          .filter((p) => p.id !== 'default')
          .map((p) => {
            const m = p.name.match(/^项目\s+(\d+)$/);
            return m ? parseInt(m[1], 10) : 0;
          });
        const nextNum = existing.length > 0 ? Math.max(...existing) + 1 : 1;
        defaultName = `项目 ${nextNum}`;
      }
      const dataFolder = fileService.buildProjectFolderName(defaultName, id);
      const project: CanvasProject = {
        id,
        name: defaultName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        dataFolder,
      };
      const emptyDramaAssets = { version: 2 as const, characters: [], scenes: [], props: [] };
      try {
        await enqueueProjectSave({
          ...project,
          nodes: [],
          edges: [],
          groups: [],
          dramaAssets: emptyDramaAssets,
        });
      } catch (error) {
        console.warn('[创建项目] 保存失败:', error);
        if (isLatestCreate()) {
          get().showToast('新项目创建失败，已保留当前项目', 'error');
        }
        return undefined;
      }

      fileService.registerProjectFolder(id, dataFolder);
      if (!isLatestCreate()) {
        set((state) => ({
          projects: state.projects.some((item) => item.id === id)
            ? state.projects
            : [...state.projects, project],
        }));
        fileService.ensureProjectDataDir(id).catch((e) => console.warn('[创建项目] 数据目录初始化失败:', e));
        return id;
      }

      set((state) => ({
        projects: [...state.projects, project],
        currentProjectId: project.id,
        projectName: project.name,
        projectLoadStatus: 'ready',
        nodes: [],
        edges: [],
        groups: [],
        dramaAssets: emptyDramaAssets,
      }));
      fileService.ensureProjectDataDir(id).catch((e) => console.warn('[创建项目] 数据目录初始化失败:', e));
      rememberActiveProject(id);
      // 新项目要切换到自己的会话，否则聊天面板仍停留在上一个项目的对话
      get().loadConversationsForProject(id).catch((e) => console.warn('[创建项目] 加载会话失败:', e));
      setTimeout(() => window.dispatchEvent(new CustomEvent('canvas-fit-view')), 0);
      return id;
    } finally {
      set({ isCreatingProject: false });
    }
  },

  addEpisodes: async (entries) => {
    const state = get();
    const currentId = state.currentProjectId;
    if (!currentId || entries.length === 0) return [];
    if (state.projectLoadStatus !== 'ready') {
      get().showToast('项目尚未成功加载，已阻止新增分集', 'error');
      return [];
    }
    // 当前画布必须先落盘：转成剧集和切集都会动到它，未保存的改动会丢。
    if (await get().saveCurrentProjectSilent() !== currentId) {
      get().showToast('当前画布保存失败，已取消新增分集', 'error');
      return [];
    }

    const seriesId = await ensureCurrentSeriesId(set, get);
    if (!seriesId) {
      get().showToast('剧集创建失败，已取消新增分集', 'error');
      return [];
    }

    const latest = get();
    const series = latest.projects.find((item) => item.id === seriesId);
    if (!series) return [];
    let nextNo = listEpisodes(latest.projects, seriesId)
      .reduce((max, item) => Math.max(max, item.episodeNo ?? 0), 0);

    const created: CanvasProject[] = [];
    for (const entry of entries) {
      nextNo += 1;
      const now = Date.now();
      const episode: CanvasProject = {
        id: generateProjectId(),
        name: entry.name?.trim() || `第 ${nextNo} 集`,
        createdAt: now,
        updatedAt: now,
        dataFolder: series.dataFolder,
        parentId: seriesId,
        episodeNo: nextNo,
        episodeOutline: entry.outline?.trim() || undefined,
        // ponytail: 新集复制剧集当前的创作基线后各自独立；要全剧联动改画风再把 settings 也上提到剧集。
        settings: series.settings,
      };
      try {
        await enqueueProjectSave({ ...episode, nodes: [], edges: [], groups: [] });
      } catch (error) {
        console.warn('[新增分集] 保存失败:', error);
        get().showToast(
          created.length > 0 ? `只成功新增了 ${created.length} 集` : '新增分集失败，已保留当前画布',
          'error',
        );
        break;
      }
      fileService.registerProjectFolder(episode.id, series.dataFolder ?? seriesId);
      created.push(episode);
    }

    if (created.length > 0) {
      set((current) => ({ projects: [...current.projects, ...created] }));
    }
    return created.map((episode) => episode.id);
  },

  addEpisode: async (name) => {
    const [id] = await get().addEpisodes([{ name }]);
    if (id) await get().switchProject(id);
    return id;
  },

  updateSeriesInfo: async (info) => {
    const state = get();
    if (state.projectLoadStatus !== 'ready') {
      get().showToast('项目尚未成功加载，已阻止保存', 'error');
      return false;
    }
    const seriesId = await ensureCurrentSeriesId(set, get);
    if (!seriesId) return false;
    const series = get().projects.find((item) => item.id === seriesId);
    return patchProjectRecord(set, get, seriesId, {
      series: { ...series?.series, ...info },
    });
  },

  updateEpisodeOutline: async (episodeId, outline) => (
    patchProjectRecord(set, get, episodeId, { episodeOutline: outline })
  ),

  moveEpisode: async (episodeId, direction) => {
    const state = get();
    const episode = state.projects.find((item) => item.id === episodeId);
    if (!episode?.parentId) return false;
    const episodes = listEpisodes(state.projects, episode.parentId);
    const index = episodes.findIndex((item) => item.id === episodeId);
    const neighbour = episodes[index + direction];
    if (!neighbour) return false;

    // 集号可能有缺口或重复，按当前顺序取两者的位次交换，比直接加减更稳。
    const episodeNo = neighbour.episodeNo ?? index + 1 + direction;
    const neighbourNo = episode.episodeNo ?? index + 1;
    const moved = await patchProjectRecord(set, get, episodeId, { episodeNo });
    if (!moved) return false;
    return patchProjectRecord(set, get, neighbour.id, { episodeNo: neighbourNo });
  },

  exportProject: async (id) => {
    const state = get();
    const project = state.projects.find((item) => item.id === id);
    if (!project) return false;

    // 导出读的是 IndexedDB 里已落盘的记录，当前项目必须先把内存改动写回去。
    if (state.currentProjectId === id) {
      if (state.projectLoadStatus !== 'ready') {
        state.showToast('项目尚未成功加载，已阻止导出', 'error');
        return false;
      }
      void get().captureCurrentProjectSnapshot();
      if (await get().saveCurrentProjectSilent() !== id) {
        get().showToast('项目保存失败，已取消导出', 'error');
        return false;
      }
    }

    try {
      const result = await exportProjectArchive(id);
      if (!result) return false;
      get().showToast(`已导出「${project.name}」，含 ${result.assetCount} 个素材`);
      return true;
    } catch (error) {
      console.error('[项目导出] 失败:', error);
      get().showToast(error instanceof Error ? `项目导出失败：${error.message}` : '项目导出失败', 'error');
      return false;
    }
  },

  duplicateProject: async (id) => {
    const state = get();
    const project = state.projects.find((item) => item.id === id);
    if (!project) return undefined;

    // 复制读的是 IndexedDB 里已落盘的记录，当前项目必须先把内存改动写回去。
    if (state.currentProjectId === id || listEpisodes(state.projects, id).some((e) => e.id === state.currentProjectId)) {
      if (state.projectLoadStatus !== 'ready') {
        state.showToast('项目尚未成功加载，已阻止复制', 'error');
        return undefined;
      }
      if (await get().saveCurrentProjectSilent() !== state.currentProjectId) {
        get().showToast('项目保存失败，已取消复制', 'error');
        return undefined;
      }
    }

    try {
      const result = await duplicateProjectArchive(
        id,
        `${project.name} 副本`,
        listEpisodes(get().projects, id).map((episode) => episode.id),
      );
      const copy: CanvasProject = {
        id: result.projectId,
        name: result.projectName,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
        dataFolder: result.dataFolder,
        settings: result.settings,
        snapshot: result.snapshot,
        series: project.series,
      };
      fileService.registerProjectFolders([copy, ...result.episodes]);
      set((current) => ({ projects: [...current.projects, copy, ...result.episodes] }));
      get().showToast(`已复制为「${result.projectName}」`);
      return result.projectId;
    } catch (error) {
      console.error('[项目复制] 失败:', error);
      get().showToast(error instanceof Error ? `项目复制失败：${error.message}` : '项目复制失败', 'error');
      return undefined;
    }
  },

  importProject: async () => {
    let result: Awaited<ReturnType<typeof importProjectArchive>>;
    try {
      result = await importProjectArchive();
    } catch (error) {
      console.error('[项目导入] 失败:', error);
      get().showToast(error instanceof Error ? `项目导入失败：${error.message}` : '项目导入失败', 'error');
      return undefined;
    }
    if (!result) return undefined;

    const project: CanvasProject = {
      id: result.projectId,
      name: result.projectName,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      dataFolder: result.dataFolder,
      settings: result.settings,
      snapshot: result.snapshot,
    };
    set((state) => ({ projects: [...state.projects, project] }));
    // 缺素材不阻断导入，只在提示里说明，与项目加载时保留节点的策略一致。
    if (result.missingAssetCount > 0) {
      get().showToast(`已导入「${result.projectName}」，${result.missingAssetCount} 个素材未找到`, 'info');
    } else {
      get().showToast(`已导入「${result.projectName}」，含 ${result.assetCount} 个素材`);
    }
    get().switchProject(result.projectId);
    return result.projectId;
  },

  deleteProject: async (id) => {
    projectSwitchSequence += 1;
    const state = get();
    const target = state.projects.find((project) => project.id === id);
    if (!target) return;
    // 删剧集要连分集一起删；删掉最后一集时剧集项目也没有存在意义，一并清掉。
    const siblings = target.parentId ? listEpisodes(state.projects, target.parentId) : [];
    const removedIds = [
      id,
      ...listEpisodes(state.projects, id).map((episode) => episode.id),
      ...(target.parentId && siblings.length <= 1 ? [target.parentId] : []),
    ];
    const removedIdSet = new Set(removedIds);
    // 分集共用剧集的素材目录，只有整部剧（或普通项目）被删掉时才能删目录。
    // ponytail: 单删一集会把它的素材留在共享目录里，需要清理时走资产库回收。
    const dataDirOwnerIds = removedIds.filter((removedId) => (
      !state.projects.find((project) => project.id === removedId)?.parentId
    ));
    const filtered = state.projects.filter((p) => !removedIdSet.has(p.id));
    const isCurrent = Boolean(state.currentProjectId && removedIdSet.has(state.currentProjectId));
    removedIds.forEach((removedId) => {
      cancelProjectCanvasDerivations(removedId);
      clearProjectTasks(removedId);
      // 先中止仍在运行的 Agent，再做最终级联删除，避免事务完成后再次写入项目任务。
      stopProjectAgentTasks(removedId);
    });
    try {
      for (const removedId of removedIds) {
        await fileService.deleteProjectData(removedId);
      }
    } catch (error) {
      console.warn('[删除项目] 清理持久化数据失败:', error);
      get().showToast('项目删除失败，本地数据未清理', 'error');
      return;
    }
    const deletedConversationIds = new Set([
      ...state.conversations
        .filter((conversation) => removedIdSet.has(conversation.projectId))
        .map((conversation) => conversation.id),
      ...state.agentTasks
        .filter((task) => removedIdSet.has(task.projectId))
        .map((task) => task.conversationId),
    ]);
    for (const conversationId of deletedConversationIds) {
      clearConversationFileGrants(conversationId);
    }
    const retainedChatState = {
      conversations: state.conversations.filter((conversation) => !removedIdSet.has(conversation.projectId)),
      messages: state.messages.filter((message) => !deletedConversationIds.has(message.conversationId)),
      activeConversationId: state.activeConversationId
        && deletedConversationIds.has(state.activeConversationId)
        ? null
        : state.activeConversationId,
    };

    if (isCurrent && filtered.length === 1 && filtered[0]?.id === 'default') {
      const newId = generateProjectId();
      const now = Date.now();
      const newFolder = fileService.buildProjectFolderName('默认画布', newId);
      fileService.registerProjectFolder(newId, newFolder);
      set({
        projects: [{ id: newId, name: '默认画布', createdAt: now, updatedAt: now, dataFolder: newFolder }],
        currentProjectId: newId,
        projectName: '默认画布',
        projectLoadStatus: 'ready',
        nodes: [],
        edges: [],
        history: [],
        historyIndex: -1,
        dramaAssets: { version: 2 as const, characters: [], scenes: [], props: [] },
        operationLogs: [],
        ...retainedChatState,
      });
      fileService.saveProject({ id: newId, name: '默认画布', createdAt: now, updatedAt: now, dataFolder: newFolder, nodes: [], edges: [] }).catch((e) => console.warn('[重建默认项目] 保存失败:', e));
      fileService.ensureProjectDataDir(newId).catch((e) => console.warn('[重建默认项目] 数据目录初始化失败:', e));
      rememberActiveProject(newId);
      setTimeout(() => window.dispatchEvent(new CustomEvent('canvas-fit-view')), 0);
    } else {
      // 替补项目可能是个剧集，剧集自己没有画布，要落到它的第一集上。
      const fallbackId = listTopLevelProjects(filtered)[0]?.id;
      const nextId = isCurrent
        ? (fallbackId ? resolveOpenTargetId(filtered, fallbackId) : null)
        : state.currentProjectId;
      const nextName = isCurrent
        ? filtered.find((project) => project.id === nextId)?.name ?? ''
        : state.projectName;

      set({
        projects: filtered,
        currentProjectId: nextId,
        ...(isCurrent ? { projectLoadStatus: nextId ? 'loading' as const : 'ready' as const } : {}),
        ...retainedChatState,
        ...(isCurrent
          ? {
              projectName: nextName,
              nodes: [],
              edges: [],
              history: [],
              historyIndex: -1,
              dramaAssets: { version: 2 as const, characters: [], scenes: [], props: [] },
              operationLogs: [],
            }
          : {}),
      });

      if (isCurrent && nextId) {
        const data = await fileService.loadProjectData(nextId);
        const { emptyDramaAssetLibrary } = await import('../types/dramaAssets');
        if (hasProjectCanvasData(data)) {
          const ownerId = seriesOwnerId(filtered, nextId);
          const ownerData = ownerId === nextId ? data : await fileService.loadProjectData(ownerId);
          set({
            nodes: data.nodes as Node<BaseNodeData>[],
            edges: data.edges as Edge[],
            groups: getProjectGroups(data),
            dramaAssets: ownerData?.dramaAssets ?? emptyDramaAssetLibrary(),
            projectLoadStatus: 'ready',
          });
          rememberActiveProject(nextId);
          setTimeout(() => window.dispatchEvent(new CustomEvent('canvas-fit-view')), 0);
          get().loadConversationsForProject(nextId).catch((e) => console.warn('[删除项目] 加载会话失败:', e));
          get().repairInterruptedForProject(nextId).catch((e) => console.warn('[删除项目] 修复中断消息失败:', e));
          get().loadAgentTasksForProject(nextId).catch((e) => console.warn('[删除项目] 加载 Agent 任务失败:', e));
          get().loadProjectMemoriesForProject(ownerId).catch((e) => console.warn('[删除项目] 加载项目记忆失败:', e));
        } else {
          set({ projectLoadStatus: 'error', dramaAssets: emptyDramaAssetLibrary() });
          get().showToast('替代项目加载失败，已阻止空画布覆盖原数据', 'error');
        }
      }
    }

    removedIds.forEach((removedId) => {
      get().removeProjectAgentTasks(removedId);
      get().removeProjectMemories(removedId);
    });
    dataDirOwnerIds.forEach((ownerId) => {
      fileService.deleteProjectDataDir(ownerId).catch((e) => console.warn('[删除项目] 清理目录失败:', e));
    });
  },

  switchProject: async (requestedId, options) => {
    if (!get().projects.some((project) => project.id === requestedId)) return;
    // 剧集项目自身没有画布，点它等于打开它的分集。
    // ponytail: 固定开第一集；要「回到上次打开的那集」再往剧集记录里存一个 lastEpisodeId。
    const id = resolveOpenTargetId(get().projects, requestedId);
    const switchSequence = ++projectSwitchSequence;
    const isLatestSwitch = () => switchSequence === projectSwitchSequence;
    const currentProjectId = get().currentProjectId;
    const previousOwnerId = currentProjectId
      ? seriesOwnerId(get().projects, currentProjectId)
      : null;
    if (currentProjectId && currentProjectId !== id) {
      cancelProjectCanvasDerivations(currentProjectId);
    }
    // 遮罩由 switchingProjectName 驱动；后来的切换会接管它，所以只有最新一次负责收尾。
    set({ switchingProjectName: get().projects.find((p) => p.id === id)?.name ?? '' });
    try {
      if (get().projectLoadStatus === 'ready') {
        if (options?.captureSnapshot) {
          const snapshotRecord = createCurrentProjectSaveRecord(get());
          void get().captureCurrentProjectSnapshot({
            allowProjectChange: true,
            persistRecord: snapshotRecord,
          });
        }
        await get().saveCurrentProject();
      }
      if (!isLatestSwitch()) return;
      // Clean up undo-trash dirs from the old project before switching
      await fileService.flushUndoTrashDirs();
      if (!isLatestSwitch()) return;

      const project = get().projects.find((p) => p.id === id);
      if (!project) return;

      fileService.ensureProjectDataDir(id).catch((e) => console.warn('[切换项目] 数据目录初始化失败:', e));

      const data = await fileService.loadProjectData(id);
      if (!isLatestSwitch()) return;
      const { emptyDramaAssetLibrary } = await import('../types/dramaAssets');
      if (!isLatestSwitch()) return;
      if (!hasProjectCanvasData(data)) {
        get().showToast('项目加载失败，已保留当前画布并阻止覆盖保存', 'error');
        return;
      }

      // 角色库归剧集项目所有；同一部剧内换集时内存里的那份就是对的，不用再读盘。
      const ownerId = project.parentId ?? id;
      let dramaAssets = get().dramaAssets;
      if (ownerId !== previousOwnerId) {
        const ownerData = ownerId === id ? data : await fileService.loadProjectData(ownerId);
        if (!isLatestSwitch()) return;
        dramaAssets = ownerData?.dramaAssets ?? emptyDramaAssetLibrary();
      }

      set({
        currentProjectId: id,
        projectName: project.name,
        projectLoadStatus: 'ready',
        nodes: data.nodes as Node<BaseNodeData>[],
        edges: data.edges as Edge[],
        groups: getProjectGroups(data),
        history: [],
        historyIndex: -1,
        dramaAssets,
      });
      rememberActiveProject(id);
      // 恢复当前项目的待续轮询任务
      resumePendingTasks(id).catch((e) => console.warn('[切换项目] 恢复待续任务失败:', e));
      // 加载聊天会话
      get().loadConversationsForProject(id).catch((e) => console.warn('[切换项目] 加载会话失败:', e));
      get().repairInterruptedForProject(id).catch((e) => console.warn('[切换项目] 修复中断消息失败:', e));
      // 项目切换只加载任务，不把应用运行期间的后台任务误判为中断。
      get().loadAgentTasksForProject(id).catch((e) => console.warn('[切换项目] 加载 Agent 任务失败:', e));
      // 项目记忆整部剧共用，按剧集项目加载。
      get().loadProjectMemoriesForProject(ownerId).catch((e) => console.warn('[切换项目] 加载项目记忆失败:', e));

      setTimeout(() => window.dispatchEvent(new CustomEvent('canvas-fit-view')), 0);
    } finally {
      if (isLatestSwitch()) set({ switchingProjectName: null });
    }
  },

  saveCurrentProject: async () => {
    const state = get();
    if (state.currentProjectId && state.projectLoadStatus !== 'ready') {
      state.showToast('项目尚未成功加载，已阻止覆盖保存', 'error');
      return undefined;
    }
    const record = createCurrentProjectSaveRecord(state);
    if (!record) return undefined;
    try {
      await saveCurrentProjectRecord(state, record);
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === record.id ? { ...p, updatedAt: record.updatedAt, name: record.name } : p
        ),
      }));
      get().showToast('项目已保存');
      return record.id;
    } catch (error) {
      console.error('Save failed:', error);
      get().showToast('保存失败', 'error');
      return undefined;
    }
  },

  /** 静默保存（不弹 toast），用于自动保存 */
  saveCurrentProjectSilent: async () => {
    const state = get();
    if (state.currentProjectId && state.projectLoadStatus !== 'ready') {
      if (state.projectLoadStatus === 'error' && !state._autoSaveFailedNotified) {
        state.showToast('项目加载失败，已阻止空画布覆盖原数据', 'error');
        set({ _autoSaveFailedNotified: true });
      }
      return undefined;
    }
    const record = createCurrentProjectSaveRecord(state);
    if (!record) return undefined;
    try {
      await saveCurrentProjectRecord(state, record);
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === record.id ? { ...p, updatedAt: record.updatedAt, name: record.name } : p
        ),
      }));
      // 成功后重置失败通知标志
      set({ _autoSaveFailedNotified: false });
      return record.id;
    } catch (error) {
      console.warn('[自动保存] 保存失败:', error);
      // 首次失败才弹 toast，避免每 2 秒刷屏
      if (!get()._autoSaveFailedNotified) {
        get().showToast('自动保存失败，请手动保存 (Ctrl+S)', 'error');
        set({ _autoSaveFailedNotified: true });
      }
      return undefined;
    }
  },

  loadProject: async () => {
    try {
      const allProjects = await fileService.loadProjectsList();
      if (allProjects.length > 0) {
        const mapped: CanvasProject[] = withInheritedDataFolders(allProjects.map((p) => ({
          id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
          snapshot: p.snapshot, dataFolder: p.dataFolder, settings: p.settings,
          parentId: p.parentId, episodeNo: p.episodeNo, episodeOutline: p.episodeOutline,
          series: p.series,
        })));
        fileService.registerProjectFolders(mapped);
        const current = get().currentProjectId;
        const exists = mapped.find((p) => p.id === current);
        const targetId = resolveOpenTargetId(mapped, exists ? current! : mapped[0].id);
        set({ projects: mapped, projectLoadStatus: 'loading' });

        const data = await fileService.loadProjectData(targetId);
        if (hasProjectCanvasData(data)) {
          const { emptyDramaAssetLibrary } = await import('../types/dramaAssets');
          const ownerId = seriesOwnerId(mapped, targetId);
          const ownerData = ownerId === targetId ? data : await fileService.loadProjectData(ownerId);
          set({
            currentProjectId: targetId,
            projectName: data.name || '已加载项目',
            nodes: data.nodes as Node<BaseNodeData>[],
            edges: data.edges as Edge[],
            groups: getProjectGroups(data),
            history: [],
            historyIndex: -1,
            dramaAssets: ownerData?.dramaAssets ?? emptyDramaAssetLibrary(),
            projectLoadStatus: 'ready',
          });
          rememberActiveProject(targetId);
        } else {
          set({ currentProjectId: null, projectLoadStatus: 'error' });
          get().showToast('项目加载失败，已阻止空画布覆盖原数据', 'error');
          return;
        }
        // 恢复待续轮询任务
        resumePendingTasks(targetId!).catch((e) => console.warn('[加载项目] 恢复待续任务失败:', e));
      }
    } catch (error) {
      console.error('Load failed:', error);
      set({ currentProjectId: null, projectLoadStatus: 'error' });
      get().showToast('项目列表读取失败，未创建空项目', 'error');
    }
  },

  initFromDb: async () => {
    try {
      await Promise.all([get().loadConfig(), get().loadWorkflows(), get().loadPresets(), get().loadSkills(), get().loadSubAgentProfiles(), get().loadCustomStyles(), get().loadToolbarLayouts()]);

      const allProjects = await fileService.loadProjectsList();
      const valid = allProjects.filter((p) => p.id !== 'default');
      if (valid.length < allProjects.length) {
        fileService.deleteProjectData('default').catch((e) => console.warn('[初始化] 清理默认项目数据失败:', e));
      }
      let activeProjectId: string | null = null;
      if (valid.length > 0) {
        const mapped: CanvasProject[] = withInheritedDataFolders(valid.map((p) => ({
          id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
          snapshot: p.snapshot, dataFolder: p.dataFolder, settings: p.settings,
          parentId: p.parentId, episodeNo: p.episodeNo, episodeOutline: p.episodeOutline,
          series: p.series,
        })));
        fileService.registerProjectFolders(mapped);
        mapped.sort((a, b) => b.updatedAt - a.updatedAt);
        const rememberedProjectId = await getLastActiveProjectId().catch(() => null);
        const targetId = resolveOpenTargetId(mapped, rememberedProjectId
          && mapped.some((project) => project.id === rememberedProjectId)
          ? rememberedProjectId
          : mapped[0].id);

        const data = await fileService.loadProjectData(targetId);
        const { emptyDramaAssetLibrary } = await import('../types/dramaAssets');
        if (hasProjectCanvasData(data)) {
          activeProjectId = targetId;
          const ownerId = seriesOwnerId(mapped, targetId);
          const ownerData = ownerId === targetId ? data : await fileService.loadProjectData(ownerId);
          set({
            projects: mapped,
            currentProjectId: targetId,
            projectName: data.name || '新项目',
            nodes: data.nodes as Node<BaseNodeData>[],
            edges: data.edges as Edge[],
            groups: getProjectGroups(data),
            dramaAssets: ownerData?.dramaAssets ?? emptyDramaAssetLibrary(),
            projectLoadStatus: 'ready',
          });
          rememberActiveProject(targetId);
        } else {
          set({
            projects: mapped,
            currentProjectId: null,
            projectName: '',
            nodes: [],
            edges: [],
            groups: [],
            dramaAssets: emptyDramaAssetLibrary(),
            projectLoadStatus: 'error',
          });
          get().showToast('项目加载失败，已阻止空画布覆盖原数据', 'error');
        }
        fileService.ensureProjectDataDir(targetId).catch((e) => console.warn('[初始化] 数据目录初始化失败:', e));
      } else {
        const id = generateProjectId();
        activeProjectId = id;
        const now = Date.now();
        const dataFolder = fileService.buildProjectFolderName('默认画布', id);
        fileService.registerProjectFolder(id, dataFolder);
        const defaultProject = { id, name: '默认画布', createdAt: now, updatedAt: now, dataFolder, nodes: [], edges: [] };
        set({
          projects: [{ id, name: '默认画布', createdAt: now, updatedAt: now, dataFolder }],
          currentProjectId: id,
          projectName: '默认画布',
          nodes: [],
          edges: [],
          groups: [],
          projectLoadStatus: 'ready',
        });
        await fileService.saveProject(defaultProject).catch((e) => console.warn('[初始化] 创建默认项目失败:', e));
        fileService.ensureProjectDataDir(id).catch((e) => console.warn('[初始化] 数据目录初始化失败:', e));
        rememberActiveProject(id);
      }
      // 恢复当前项目的待续轮询任务
      if (activeProjectId) {
        resumePendingTasks(activeProjectId).catch((e) => console.warn('[初始化] 恢复待续任务失败:', e));
        // 加载聊天会话
        get().loadConversationsForProject(activeProjectId).catch((e) => console.warn('[初始化] 加载会话失败:', e));
        get().repairInterruptedForProject(activeProjectId).catch((e) => console.warn('[初始化] 修复中断消息失败:', e));
        get().loadProjectMemoriesForProject(seriesOwnerId(get().projects, activeProjectId))
          .catch((e) => console.warn('[初始化] 加载项目记忆失败:', e));
        // 应用重启后，所有项目的未完成 Agent 任务都必须恢复为暂停，禁止自动续跑。
        const projectIds = get().projects.map((project) => project.id);
        await Promise.all(projectIds.map((projectId) =>
          get().repairInterruptedAgentTasksForProject(projectId),
        ));
      }
    } catch (error) {
      console.error('Init from IndexedDB failed:', error);
      set({ currentProjectId: null, projectLoadStatus: 'error' });
      get().showToast('项目数据读取失败，未创建空项目', 'error');
    }
  },
});
