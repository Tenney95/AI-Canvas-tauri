/**
 * store.projects — 管理项目保存、切换、恢复与项目域数据装配。
 */
import { t } from '../i18n';
/**
 * Project slice — multi-project management, save/load/init via IndexedDB
 */
import type { Node, Edge } from '@xyflow/react';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../services/chat/assistantScope';
import type {
  BaseNodeData,
  CanvasProject,
  EpisodeCreativeInfo,
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
import { resumePendingTasks, clearProjectTasks, getPendingTasksForProject } from '../services/pollManager';
import { normalizeProjectSettings } from '../services/projectSettingsService';
import { captureCurrentCanvasSnapshot } from '../services/projectSnapshotService';
import { stopProjectAgentTasks } from '../services/chat/agentTaskControl';
import { cancelProjectCanvasDerivations } from '../services/canvasDerivationGuard';
import { clearConversationFileGrants } from '../services/chat/fileGrantService';
import { reassignProjectMemories } from '../services/chat/projectMemoryService';
import { duplicateProjectArchive, exportProjectArchive, importProjectArchive } from '../services/projectTransferService';
import {
  getLastActiveProjectId,
  getProjectById,
  setLastActiveProjectId,
  updateProjectSnapshot,
} from '../services/indexedDbService';
import { serializeProjectRecord } from '../services/storageService';
import {
  applySharedAssetSyncCommit,
  type SharedAssetSyncCommitInput,
  type SharedAssetSyncCommitResult,
} from '../services/indexedDb/sharedAssetSyncRepository';
import { describeStorageError, type StorageFailureKind } from '../services/storageQuota';
import { relocateMediaReferences } from '../services/indexedDb/mediaRelocations';
import { applyAssetRepairs, cleanupUnavailableAssets, type AssetRepairPreview } from '../services/fs/assetRepair';
import type { DramaAssetLibrary, DramaAssetWriteOptions } from '../types/dramaAssets';
import { assertDramaAssetWriteCurrent } from '../types/dramaAssets';
import { isWebviewRecovery } from '../services/webviewRecoveryService';
import { normalizeEpisodeAssetRoster, type EpisodeAssetRoster } from '../types/episodeAssets';
import { prepareProjectImport, previewProjectImport, applyProjectImport, type PreparedProjectImport,
  restoreProjectImportRecovery, type ProjectImportPreview, type ProjectImportOptions } from '../services/projectImportService';
import type { ProjectMergeSide } from '../services/projectMergeService';

type ProjectLoadStatus = 'loading' | 'ready' | 'error';
let activeProjectMetadataWrite: Promise<void> = Promise.resolve();
const EMPTY_SERIES_CANVAS: readonly never[] = [];
const projectInitializations: WeakMap<() => AppState, Promise<void>> = import.meta.hot?.data.projectInitializations ?? new WeakMap();
if (import.meta.hot) import.meta.hot.data.projectInitializations = projectInitializations;
const pendingProjectSaves: Map<string, Set<Promise<string | undefined>>> = import.meta.hot?.data.pendingProjectSaves ?? new Map();
if (import.meta.hot) import.meta.hot.data.pendingProjectSaves = pendingProjectSaves;

function trackProjectSave(projectId: string | null, save: (projectId: string | null) => Promise<string | undefined>): Promise<string | undefined> {
  const operation = save(projectId);
  if (!projectId) return operation;
  const pending = pendingProjectSaves.get(projectId) ?? new Set<Promise<string | undefined>>();
  pending.add(operation);
  pendingProjectSaves.set(projectId, pending);
  const cleanup = () => {
    pending.delete(operation);
    if (pending.size === 0 && pendingProjectSaves.get(projectId) === pending) pendingProjectSaves.delete(projectId);
  };
  void operation.then(cleanup, cleanup);
  return operation;
}

/** 等待已发出的完整保存，包括入队前等待和失败分类；这里不发起新保存。 */
export async function waitForPendingProjectSaves(projectId: string): Promise<boolean> {
  while (true) {
    const pending = [...(pendingProjectSaves.get(projectId) ?? [])];
    if (pending.length === 0) return true;
    const results = await Promise.allSettled(pending);
    if (results.some((result) => result.status === 'rejected' || result.value !== projectId)) return false;
  }
}

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
  active: PendingProjectSave | null;
  pending: PendingProjectSave | null;
  pendingSnapshot: { snapshot: string | undefined; waiters: ProjectSaveWaiter[] } | null;
  idleWaiters: Array<() => void>;
}

const projectSaveQueues: Map<string, ProjectSaveQueue> = import.meta.hot?.data.projectSaveQueues ?? new Map();
if (import.meta.hot) import.meta.hot.data.projectSaveQueues = projectSaveQueues;
interface ProjectAssetSyncBarrier {
  done: Promise<void>;
  library: AppState['dramaAssets'];
}
const projectAssetSyncBarriers = new Map<string, ProjectAssetSyncBarrier>();
const projectImportsApplying = new Set<string>();
// 只保留最近一个共享库的成功记录；不缓存普通画布或跨重载/同步沿用基线。
const seriesLibraryOwners = new WeakMap<ProjectSaveData, CanvasProject>();
let confirmedSeriesLibrary: { record: ProjectSaveData; owner: CanvasProject } | undefined;
let seriesLibrarySaveEpoch = 0;
function invalidateSeriesLibrarySave() {
  confirmedSeriesLibrary = undefined;
  seriesLibrarySaveEpoch += 1;
}
const importPreviewGuards = new WeakMap<ProjectImportPreview, () => void>();

function waitForProjectSaveQueue(projectId: string): Promise<void> {
  const queue = projectSaveQueues.get(projectId);
  return queue?.running ? new Promise((resolve) => queue.idleWaiters.push(resolve)) : Promise.resolve();
}

function waitForProjectAssetSync(get: () => AppState): Promise<void> | undefined {
  const state = get();
  if (!state.currentProjectId) return;
  const ownerId = seriesOwnerId(state.projects, state.currentProjectId);
  return projectAssetSyncBarriers.get(ownerId)?.done;
}
let projectSwitchSequence = 0;

interface CapturedCanvasState {
  projectId: string;
  nodes: AppState['nodes'];
  edges: AppState['edges'];
  groups: AppState['groups'];
  viewportKey: string;
}

interface CaptureProjectSnapshotOptions {
  allowProjectChange?: boolean;
  persistSnapshot?: boolean;
}

let lastCapturedCanvasState: CapturedCanvasState | null = null;
const latestSnapshotCaptures = new Map<string, number>();
let nextSnapshotCaptureId = 1;
if (import.meta.hot) import.meta.hot.dispose(() => {
  // 热更新前启动的截图不能再回写到新版本的 Store。
  latestSnapshotCaptures.clear();
  lastCapturedCanvasState = null;
});

function getCanvasViewportKey(): string {
  if (typeof document === 'undefined') return '';
  const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
  const bounds = document.querySelector<HTMLElement>('.react-flow')?.getBoundingClientRect();
  return `${viewport?.style.transform ?? ''}|${bounds?.width ?? 0},${bounds?.height ?? 0}`;
}

function waitForLoadingPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      resolve();
    };
    // 后台/最小化窗口的 rAF 可能被暂停，不能让返回或项目创建一直等首帧。
    const timer = setTimeout(finish, 100);
    const frame = requestAnimationFrame(() => setTimeout(finish, 0));
  });
}

function isCanvasSnapshotFresh(state: AppState, projectId: string): boolean {
  return lastCapturedCanvasState?.projectId === projectId
    && lastCapturedCanvasState.nodes === state.nodes
    && lastCapturedCanvasState.edges === state.edges
    && lastCapturedCanvasState.groups === state.groups
    && lastCapturedCanvasState.viewportKey === getCanvasViewportKey();
}

async function drainProjectSaveQueue(projectId: string, queue: ProjectSaveQueue): Promise<void> {
  if (queue.running) return;
  queue.running = true;

  try {
    while (queue.pending || queue.pendingSnapshot) {
      if (!queue.pending) {
        const patch = queue.pendingSnapshot!;
        queue.pendingSnapshot = null;
        try {
          if (confirmedSeriesLibrary?.record.id === projectId) confirmedSeriesLibrary = undefined;
          await updateProjectSnapshot(projectId, patch.snapshot);
          patch.waiters.forEach((waiter) => waiter.resolve(projectId));
        } catch (error) {
          patch.waiters.forEach((waiter) => waiter.reject(error));
        }
        continue;
      }
      const batch = queue.pending;
      queue.pending = null;
      queue.active = batch;

      const epoch = seriesLibrarySaveEpoch;
      if (confirmedSeriesLibrary?.record.id === projectId) confirmedSeriesLibrary = undefined;
      try {
        const savedProjectId = await fileService.saveProject(batch.record);
        const owner = seriesLibraryOwners.get(batch.record);
        // 记录队列实际写入的版本，不能把被后续 pending 覆盖的请求误认为已落库。
        if (owner && epoch === seriesLibrarySaveEpoch && savedProjectId === projectId) {
          confirmedSeriesLibrary = { record: batch.record, owner };
        }
        batch.waiters.forEach((waiter) => waiter.resolve(savedProjectId));
      } catch (error) {
        batch.waiters.forEach((waiter) => waiter.reject(error));
      } finally {
        queue.active = null;
      }
    }
  } finally {
    queue.running = false;
    if (queue.pending || queue.pendingSnapshot) {
      void drainProjectSaveQueue(projectId, queue);
    } else if (projectSaveQueues.get(projectId) === queue) {
      projectSaveQueues.delete(projectId);
      queue.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }
}

function getProjectSaveQueue(projectId: string): ProjectSaveQueue {
  let queue = projectSaveQueues.get(projectId);
  if (!queue) {
    queue = { running: false, active: null, pending: null, pendingSnapshot: null, idleWaiters: [] };
    projectSaveQueues.set(projectId, queue);
  }
  return queue;
}

function hasSameProjectSaveContent(left: ProjectSaveData, right: ProjectSaveData): boolean {
  const keys = Object.keys(left) as Array<keyof ProjectSaveData>;
  return keys.length === Object.keys(right).length
    && keys.every((key) => key === 'updatedAt' || left[key] === right[key]);
}

function enqueueProjectSnapshot(projectId: string, snapshot: string | undefined): Promise<string> {
  const queue = getProjectSaveQueue(projectId);
  return new Promise((resolve, reject) => {
    if (queue.pendingSnapshot) {
      queue.pendingSnapshot.snapshot = snapshot;
      queue.pendingSnapshot.waiters.push({ resolve, reject });
    } else {
      queue.pendingSnapshot = { snapshot, waiters: [{ resolve, reject }] };
    }
    void drainProjectSaveQueue(projectId, queue);
  });
}

function enqueueProjectSave(record: ProjectSaveData): Promise<string> {
  if (projectImportsApplying.has(record.id)) return Promise.reject(new Error('正在应用项目更新，请稍后保存'));
  const barrier = projectAssetSyncBarriers.get(record.id);
  if (barrier) {
    // 屏障前已捕获的节点和项目元数据仍可保存；所属库必须改用屏障释放时的版本。
    return barrier.done.then(() => enqueueProjectSave({ ...record,
      ...(record.dramaAssets ? { dramaAssets: barrier.library } : {}),
    }));
  }
  const queue = getProjectSaveQueue(record.id);

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    if (queue.pending) {
      queue.pending.record = record;
      queue.pending.waiters.push(waiter);
    } else if (queue.active && hasSameProjectSaveContent(queue.active.record, record)) {
      // 同一不可变画布的自动保存与返回保存共用在途写入；新版本仍排队。
      queue.active.waiters.push(waiter);
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
    exchangeEpoch: project.exchangeEpoch,
    name: state.projectName,
    createdAt: project.createdAt,
    updatedAt: Date.now(),
    snapshot: project.snapshot,
    dataFolder: project.dataFolder,
    settings: project.settings,
    parentId: project.parentId,
    episodeNo: project.episodeNo,
    episodeOutline: project.episodeOutline,
    episodeScript: project.episodeScript,
    episodeCreative: project.episodeCreative,
    episodeAssetRoster: project.episodeAssetRoster,
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

  const record: ProjectSaveData = {
    id: series.id,
    exchangeEpoch: series.exchangeEpoch,
    name: series.name,
    createdAt: series.createdAt,
    updatedAt: Date.now(),
    snapshot: series.snapshot,
    dataFolder: series.dataFolder,
    settings: series.settings,
    series: series.series,
    nodes: EMPTY_SERIES_CANVAS,
    edges: EMPTY_SERIES_CANVAS,
    groups: EMPTY_SERIES_CANVAS,
    dramaAssets: state.dramaAssets,
  };
  seriesLibraryOwners.set(record, series);
  return record;
}

/** 跳过已确认的共享库重复写入；排队/屏障期间仍走原串行保存流程。 */
function enqueueSeriesLibrarySave(record: ProjectSaveData): Promise<string> {
  const confirmed = confirmedSeriesLibrary;
  if (confirmed && confirmed.owner === seriesLibraryOwners.get(record)
    && hasSameProjectSaveContent(confirmed.record, record)
    && !projectSaveQueues.has(record.id) && !projectAssetSyncBarriers.has(record.id)
    && !projectImportsApplying.has(record.id)) return Promise.resolve(record.id);
  return enqueueProjectSave(record);
}

/** 保存当前画布，同时把共享角色库写回它所属的剧集项目。 */
async function saveCurrentProjectRecord(state: AppState, record: ProjectSaveData): Promise<string> {
  const libraryRecord = createSeriesLibraryRecord(state);
  const [savedProjectId] = await Promise.all([
    enqueueProjectSave(record),
    libraryRecord ? enqueueSeriesLibrarySave(libraryRecord) : Promise.resolve(undefined),
  ]);
  return savedProjectId;
}

export interface AutoSaveFailureState {
  /** 失败归因：配额用尽 / 磁盘写满 / 项目未加载成功 / 其它 */
  kind: StorageFailureKind | 'load-error';
  reason: string;
  /** 连续失败次数，成功保存后清零 */
  count: number;
  firstAt: number;
  lastAt: number;
  lastNotifiedAt: number;
}

/** 持续失败时的重复提醒间隔：既不刷屏，也不会失败一次之后全程静默 */
const AUTO_SAVE_RENOTIFY_MS = 60_000;

/**
 * 记录一次保存失败。第一次、原因变化、或距上次提醒超过 1 分钟才会再弹 toast，
 * 避免 2 秒一次的自动保存刷屏，同时保证磁盘满/配额满这类持续故障不会被静音。
 */
function noteSaveFailure(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
  params: { kind: AutoSaveFailureState['kind']; reason: string; notify: boolean },
): AutoSaveFailureState {
  const now = Date.now();
  const prev = get().autoSaveFailure;
  const count = (prev?.count ?? 0) + 1;
  const shouldNotify = params.notify
    && (!prev || prev.reason !== params.reason || now - prev.lastNotifiedAt >= AUTO_SAVE_RENOTIFY_MS);
  const next: AutoSaveFailureState = {
    kind: params.kind,
    reason: params.reason,
    count,
    firstAt: prev?.firstAt ?? now,
    lastAt: now,
    lastNotifiedAt: shouldNotify ? now : (prev?.lastNotifiedAt ?? now),
  };
  set({ autoSaveFailure: next });
  if (shouldNotify) {
    const prefix = count > 1 ? t('自动保存已连续失败 {count} 次', { count }) : t('自动保存失败');
    get().showToast(t('{prefix}：{reason}。请手动保存 (Ctrl+S) 或导出项目备份', { prefix, reason: params.reason }), 'error');
  }
  return next;
}

function clearSaveFailure(set: ProjectSliceSet, get: ProjectSliceGet) {
  if (get().autoSaveFailure) set({ autoSaveFailure: null });
}

/** 保存异常 → 结构化失败状态（含配额/磁盘归因） */
async function noteSaveError(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
  error: unknown,
  notify: boolean,
): Promise<AutoSaveFailureState> {
  const { kind, reason } = await describeStorageError(error);
  return noteSaveFailure(set, get, { kind, reason, notify });
}

export interface SharedProjectAssetSyncApplyInput {
  ownerId: string;
  originProjectId: string;
  expectedLibrary: DramaAssetLibrary;
  nextLibrary?: DramaAssetLibrary;
  commit: Omit<SharedAssetSyncCommitInput, 'project' | 'expectedProjectLibrary' | 'onCommitted'>;
  assertCurrent?: () => void;
  signal?: AbortSignal;
}

export interface ProjectSlice {
  projects: CanvasProject[];
  currentProjectId: string | null;
  projectName: string;
  projectLoadStatus: ProjectLoadStatus;
  /** 当前 Store 已完成启动加载；重挂载和热更新不能重读磁盘覆盖当前画布。 */
  projectInitialized: boolean;
  isCreatingProject: boolean;
  isReturningToStartPage: boolean;
  /** 正在切换到的画布名；非 null 时显示切换遮罩 */
  switchingProjectName: string | null;
  /** 自动保存持续失败时的诊断状态；成功保存后清空 */
  autoSaveFailure: AutoSaveFailureState | null;
  setProjectName: (name: string) => void;
  renameProject: (id: string, name: string) => Promise<boolean>;
  updateProjectSettings: (settings: ProjectSettings) => Promise<boolean>;
  captureCurrentProjectSnapshot: (
    options?: CaptureProjectSnapshotOptions,
  ) => Promise<string | undefined>;
  createProject: (name?: string, options?: { signal?: AbortSignal }) => Promise<string | undefined>;
  /** 在当前项目所属剧集下批量新增分集（不切画布）；当前项目还不是剧集时先转成剧集。 */
  addEpisodes: (entries: Array<{ name?: string; outline?: string }>) => Promise<string[]>;
  /** 新增一集并切过去。 */
  addEpisode: (name?: string) => Promise<string | undefined>;
  /** 写入当前剧集的原著与剧本；当前项目还不是剧集时先转成剧集。 */
  updateSeriesInfo: (info: ProjectSeriesInfo) => Promise<boolean>;
  /** 写入某一集的大纲。兼容既有 Agent 工具。 */
  updateEpisodeOutline: (episodeId: string, outline: string) => Promise<boolean>;
  /** 原子更新某一集的大纲、正文和创作要点。 */
  updateEpisodeCreative: (
    episodeId: string,
    updates: { outline?: string; script?: string; creative?: EpisodeCreativeInfo },
  ) => Promise<boolean>;
  /** 只更新当前准确分集的提取清单；expectedRevision 防止覆盖较新的编辑。 */
  updateEpisodeAssetRoster: (episodeId: string, roster: EpisodeAssetRoster, expectedRevision?: number) => Promise<boolean>;
  /** 与相邻的一集交换集号；direction 为 -1 上移、1 下移。 */
  moveEpisode: (episodeId: string, direction: -1 | 1) => Promise<boolean>;
  exportProject: (id: string) => Promise<boolean>;
  prepareProjectImport: () => Promise<PreparedProjectImport | null>;
  previewProjectImport: (session: PreparedProjectImport, targetId: string, confirmedBase?: PreparedProjectImport) => Promise<ProjectImportPreview>;
  importProject: (session?: PreparedProjectImport, preview?: ProjectImportPreview | null,
    choices?: Readonly<Record<string, ProjectMergeSide>>, options?: ProjectImportOptions) => Promise<string | undefined>;
  restoreProjectImport: (ownerId: string, recoveryId: string) => Promise<void>;
  /** 复制项目（含分集、对话与素材），复制完不切画布。 */
  duplicateProject: (id: string) => Promise<string | undefined>;
  deleteProject: (id: string) => Promise<void>;
  /** 成功返回实际打开的项目 ID；captureSnapshot 仅项目库使用，signal 只在本次加载内存中保留。 */
  switchProject: (id: string, options?: { captureSnapshot?: boolean; signal?: AbortSignal }) => Promise<string | undefined>;
  /** 保存当前画布后返回启动页；保存失败不卸载当前画布。 */
  returnToStartPage: () => Promise<boolean>;
  saveCurrentProject: () => Promise<string | undefined>;
  saveCurrentProjectSilent: () => Promise<string | undefined>;
  commitSharedAssetSyncDownload: (input: SharedProjectAssetSyncApplyInput) => Promise<SharedAssetSyncCommitResult>;
  loadProject: () => Promise<void>;
  initFromDb: () => Promise<void>;
  moveGlobalAssetToFolder: (file: fileService.AssetFileEntry, selection: fileService.AssetFolderSelection,
    options?: fileService.FileTransferOptions) => Promise<{ path: string; moved: boolean }>;
  renameAssetFile: (file: fileService.AssetFileEntry, name: string, projectId?: string) => Promise<fileService.AssetFileRenameResult>;
  repairAssetLocations: (preview: AssetRepairPreview, assetIds: readonly string[], options?: DramaAssetWriteOptions) => Promise<number>;
  cleanupMissingAssets: (preview: AssetRepairPreview, assetIds: readonly string[], options?: DramaAssetWriteOptions) => Promise<number>;
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
  rollbackRosterOnly = false,
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
      projects: state.projects.map((item) => {
        if (item.id !== projectId) return item;
        if (rollbackRosterOnly) {
          // 旧保存失败只能撤回仍是本次值的清单，不能恢复整个旧项目覆盖后来的编辑。
          return item.episodeAssetRoster === patch.episodeAssetRoster ? {
            ...item, episodeAssetRoster: previous.episodeAssetRoster,
            updatedAt: item.updatedAt === updatedAt ? previous.updatedAt : item.updatedAt,
          } : item;
        }
        // 普通元数据保存失败也不能顺带撤销后来已接受的本集清单。
        return item.episodeAssetRoster === previous.episodeAssetRoster
          ? previous : { ...previous, episodeAssetRoster: item.episodeAssetRoster };
      }),
    }));
    get().showToast('保存失败，改动已回滚', 'error');
    return false;
  }
}

export const createProjectSlice: StateCreator<AppState, [], [], ProjectSlice> = (set, get, api) => {
  const live: AppState | undefined = get();
  // 首次应用这次热更新时，旧 Store 还没有标记；已就绪的画布要沿用内存。
  const initialized = live?.projectInitialized
    ?? (live?.projectLoadStatus === 'ready' && typeof live?.initFromDb === 'function');
  return {
  projects: [
    { id: 'default', name: '默认画布', createdAt: Date.now(), updatedAt: Date.now() },
  ],
  currentProjectId: 'default',
  projectName: '新项目',
  projectLoadStatus: 'loading',
  projectInitialized: initialized,
  isCreatingProject: false,
  isReturningToStartPage: false,
  switchingProjectName: null,
  autoSaveFailure: null,

  moveGlobalAssetToFolder: async (file, selection, options) => fileService.moveAssetFile(
    file, selection, get().config.assetFolders ?? [], (move) => {
      // 按最新状态迁移精确路径，不把异步操作开始时的旧画布覆盖回来。
      const state = get();
      if (relocateMediaReferences(state.nodes, [move]) !== state.nodes) state.commitToHistory();
      set((current) => ({ ...relocateMediaReferences(current, [move]), recentAssetsRevision: current.recentAssetsRevision + 1 }));
    }, options),

  renameAssetFile: async (file, name, projectId) => fileService.renameAssetFile(
    file, name, projectId, get().config.assetFolders ?? [], (move) => {
      const state = get();
      if (relocateMediaReferences(state.nodes, [move]) !== state.nodes) state.commitToHistory();
      set((current) => ({ ...relocateMediaReferences(current, [move]), recentAssetsRevision: current.recentAssetsRevision + 1 }));
    }),

  repairAssetLocations: async (preview, assetIds, options = {}) => {
    const initialRoot = get().config.baseDataDir;
    const assertCurrent = () => {
      assertDramaAssetWriteCurrent(options);
      if (get().config.baseDataDir !== initialRoot) throw new Error(t('素材根目录已变化，请重新预览'));
      if (preview.target.kind === 'folder' && !(get().config.assetFolders ?? []).includes(preview.target.path)) {
        throw new Error(t('原目录引用已移除，请重新选择'));
      }
    };
    assertCurrent();
    return applyAssetRepairs(preview, assetIds, get().config.assetFolders ?? [], (moves) => {
      const state = get();
      if (relocateMediaReferences(state.nodes, moves) !== state.nodes) state.commitToHistory();
      set((current) => ({ ...relocateMediaReferences(current, moves), recentAssetsRevision: current.recentAssetsRevision + 1 }));
      if (preview.target.kind === 'folder' && preview.selectedRoot) {
        const oldRoot = preview.target.path;
        const selectedRoot = preview.selectedRoot;
        const current = get().config.assetFolders ?? [];
        const allRepaired = !preview.truncated && preview.candidates.length > 0 && preview.candidates.every((candidate) => assetIds.includes(candidate.index.assetId));
        const assetFolders = allRepaired ? current.map((root) => root === oldRoot ? selectedRoot : root)
          : [...current, selectedRoot];
        get().updateConfig({ assetFolders: [...new Set(assetFolders)] });
      }
    }, { ...options, assertCurrent });
  },

  cleanupMissingAssets: async (preview, assetIds, options = {}) => {
    const initialRoot = get().config.baseDataDir;
    const assertCurrent = () => {
      assertDramaAssetWriteCurrent(options);
      if (get().config.baseDataDir !== initialRoot) throw new Error(t('素材根目录已变化，请重新预览'));
      if (preview.target.kind === 'folder' && !(get().config.assetFolders ?? []).includes(preview.target.path)) {
        throw new Error(t('原目录引用已移除，请重新选择'));
      }
    };
    assertCurrent();
    return cleanupUnavailableAssets(preview, assetIds, ({ historyIds, deletedHistoryCounts }) => {
      const removed = new Set(historyIds);
      set((state) => {
        const records = state.outputHistoryRecords.filter((record) => !removed.has(record.id));
        const totalCount = Math.max(0, state.historyTotalCount - (state.historyProjectId ? deletedHistoryCounts[state.historyProjectId] ?? 0 : 0));
        return { outputHistoryRecords: records, historyTotalCount: totalCount,
          historyHasMore: state.historyHasMore && totalCount > records.length, recentAssetsRevision: state.recentAssetsRevision + 1 };
      });
      void get().refreshHistoryAfterAssetCleanup();
    }, { ...options, assertCurrent });
  },

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
          exchangeEpoch: latestProject.exchangeEpoch,
          name: nextName,
          createdAt: latestProject.createdAt,
          updatedAt,
          snapshot: latestProject.snapshot,
          dataFolder: renamed?.dataFolder ?? latestProject.dataFolder,
          settings: latestProject.settings,
          parentId: latestProject.parentId,
          episodeNo: latestProject.episodeNo,
          episodeOutline: latestProject.episodeOutline,
          episodeScript: latestProject.episodeScript,
          episodeCreative: latestProject.episodeCreative,
          episodeAssetRoster: latestProject.episodeAssetRoster,
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

    const captureId = nextSnapshotCaptureId++;
    latestSnapshotCaptures.set(projectId, captureId);
    if (state.nodes.length === 0) {
      latestSnapshotCaptures.delete(projectId);
      lastCapturedCanvasState = null;
      if (project.snapshot) {
        set((current) => ({
          projects: current.projects.map((item) => (
            item.id === projectId ? { ...item, snapshot: undefined } : item
          )),
        }));
      }
      if (options.persistSnapshot) {
        try {
          await enqueueProjectSnapshot(projectId, undefined);
        } catch (error) {
          console.warn('[项目快照] 清理预览失败:', error);
        }
      }
      return projectId;
    }

    // 离开项目时重新取图，图片解码或视频首帧就绪并不一定会更新 Store。
    if (!options.allowProjectChange && project.snapshot && isCanvasSnapshotFresh(state, projectId)) {
      latestSnapshotCaptures.delete(projectId);
      if (options.persistSnapshot) {
        try {
          await enqueueProjectSnapshot(projectId, project.snapshot);
        } catch (error) {
          console.warn('[项目快照] 持久化失败:', error);
        }
      }
      return projectId;
    }

    const viewportKey = getCanvasViewportKey();
    const snapshot = await captureCurrentCanvasSnapshot(
      projectId,
      { nodes: state.nodes, edges: state.edges },
      { fresh: options.allowProjectChange },
    );
    if (latestSnapshotCaptures.get(projectId) !== captureId) return undefined;
    latestSnapshotCaptures.delete(projectId);
    const latest = get();
    const projectStillExists = latest.projects.some((item) => item.id === projectId);
    if (!projectStillExists) return undefined;

    const isStillCurrent = latest.currentProjectId === projectId;
    const currentCanvasChanged = isStillCurrent && (
      latest.nodes !== state.nodes
      || latest.edges !== state.edges
      || latest.groups !== state.groups
      || getCanvasViewportKey() !== viewportKey
    );
    if (currentCanvasChanged || (!isStillCurrent && !options.allowProjectChange)) return undefined;

    if (snapshot) {
      if (isStillCurrent) {
        lastCapturedCanvasState = {
          projectId,
          nodes: state.nodes,
          edges: state.edges,
          groups: state.groups,
          viewportKey,
        };
      } else if (lastCapturedCanvasState?.projectId === projectId) {
        lastCapturedCanvasState = null;
      }
      set((current) => ({
        projects: current.projects.map((item) => (
          item.id === projectId ? { ...item, snapshot } : item
        )),
      }));

      if (options.persistSnapshot) {
        try {
          // 只在最新记录上补缩略图，不能用捕获前的正文覆盖后续自动保存。
          await enqueueProjectSnapshot(projectId, snapshot);
        } catch (error) {
          console.warn('[项目快照] 持久化失败:', error);
        }
      }
    }
    return projectId;
  },

  createProject: async (name, options) => {
    if (options?.signal?.aborted || get().isCreatingProject || get().isReturningToStartPage) return undefined;
    set({ isCreatingProject: true });
    try {
      const createSequence = ++projectSwitchSequence;
      const isLatestCreate = () => !options?.signal?.aborted && createSequence === projectSwitchSequence;
      await waitForLoadingPaint();
      if (!isLatestCreate()) return undefined;
      const previousProjectId = get().currentProjectId;

      if (previousProjectId) {
        void get().captureCurrentProjectSnapshot({
          allowProjectChange: true,
          persistSnapshot: true,
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
        return options?.signal?.aborted ? undefined : id;
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

  updateEpisodeCreative: async (episodeId, updates) => {
    const patch: Partial<CanvasProject> = {};
    if ('outline' in updates) patch.episodeOutline = updates.outline;
    if ('script' in updates) patch.episodeScript = updates.script;
    if ('creative' in updates) patch.episodeCreative = updates.creative;
    if (Object.keys(patch).length === 0) return true;
    return patchProjectRecord(set, get, episodeId, patch);
  },

  updateEpisodeAssetRoster: async (episodeId, roster, expectedRevision) => {
    const state = get();
    const episode = state.projects.find((project) => project.id === episodeId);
    const owner = episode?.parentId ? state.projects.find((project) => project.id === episode.parentId) : undefined;
    if (state.projectLoadStatus !== 'ready' || state.currentProjectId !== episodeId
      || state.isCreatingProject || state.isReturningToStartPage || state.switchingProjectName !== null
      || !episode?.parentId || !owner || owner.parentId) return false;
    const current = normalizeEpisodeAssetRoster(episode.episodeAssetRoster);
    if ((expectedRevision ?? roster.revision) !== current.revision) return false;
    if (current.revision >= Number.MAX_SAFE_INTEGER) return false;
    const next = { ...normalizeEpisodeAssetRoster(roster), revision: current.revision + 1 };
    return patchProjectRecord(set, get, episodeId, { episodeAssetRoster: next }, true);
  },

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
    const ownerId = seriesOwnerId(state.projects, id);
    const project = state.projects.find((item) => item.id === ownerId);
    if (!project) return false;

    // 导出整部剧前，先保存当前分集画布与共享角色库。
    const activeId = state.currentProjectId;
    if (activeId && seriesOwnerId(state.projects, activeId) === ownerId) {
      if (state.projectLoadStatus !== 'ready') {
        state.showToast('项目尚未成功加载，已阻止导出', 'error');
        return false;
      }
      void get().captureCurrentProjectSnapshot();
      if (await get().saveCurrentProjectSilent() !== activeId || get().currentProjectId !== activeId) {
        get().showToast('项目保存失败，已取消导出', 'error');
        return false;
      }
    }

    try {
      const result = await exportProjectArchive(ownerId);
      if (!result) return false;
      const episodes = result.episodeCount > 0 ? t('{count} 个分集、', { count: result.episodeCount }) : '';
      get().showToast(t('已导出「{name}」，含 {episodes}{count} 个素材', { name: project.name, episodes, count: result.assetCount }));
      return true;
    } catch (error) {
      console.error('[项目导出] 失败:', error);
      get().showToast(error instanceof Error ? t('项目导出失败：{reason}', { reason: error.message }) : '项目导出失败', 'error');
      return false;
    }
  },

  duplicateProject: async (id) => {
    const state = get();
    const ownerId = seriesOwnerId(state.projects, id);
    const project = state.projects.find((item) => item.id === ownerId);
    if (!project) return undefined;

    // 复制读的是 IndexedDB 里已落盘的记录，当前项目必须先把内存改动写回去。
    const activeId = state.currentProjectId;
    if (activeId && seriesOwnerId(state.projects, activeId) === ownerId) {
      if (state.projectLoadStatus !== 'ready') {
        state.showToast('项目尚未成功加载，已阻止复制', 'error');
        return undefined;
      }
      if (await get().saveCurrentProjectSilent() !== activeId || get().currentProjectId !== activeId) {
        get().showToast('项目保存失败，已取消复制', 'error');
        return undefined;
      }
    }

    try {
      const result = await duplicateProjectArchive(
        ownerId,
        `${project.name} 副本`,
      );
      const copy: CanvasProject = {
        id: result.projectId,
        name: result.projectName,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
        dataFolder: result.dataFolder,
        settings: result.settings,
        snapshot: result.snapshot,
        series: result.series,
      };
      fileService.registerProjectFolders([copy, ...result.episodes]);
      set((current) => ({ projects: [...current.projects, copy, ...result.episodes] }));
      const episodes = result.episodes.length > 0 ? t('，含 {count} 个分集', { count: result.episodes.length }) : '';
      get().showToast(t('已复制为「{name}」{episodes}', { name: result.projectName, episodes }));
      return result.projectId;
    } catch (error) {
      console.error('[项目复制] 失败:', error);
      get().showToast(error instanceof Error ? t('项目复制失败：{reason}', { reason: error.message }) : '项目复制失败', 'error');
      return undefined;
    }
  },

  prepareProjectImport: () => prepareProjectImport(),
  previewProjectImport: async (session, targetId, confirmedBase) => {
    const state = get();
    if (state.currentProjectId && seriesOwnerId(state.projects, state.currentProjectId) === targetId) {
      if (await state.saveCurrentProjectSilent() !== state.currentProjectId) throw new Error('当前画布保存失败，无法对比');
    }
    const ids = get().projects.filter((item) => item.id === targetId || item.parentId === targetId).map((item) => item.id);
    await Promise.all(ids.map(waitForProjectSaveQueue));
    const before = get();
    const assertCurrent = () => {
      const latest = get();
      if (latest.currentProjectId !== before.currentProjectId || latest.nodes !== before.nodes || latest.edges !== before.edges
        || latest.groups !== before.groups || latest.dramaAssets !== before.dramaAssets || latest.projects !== before.projects) {
        throw new Error('预览后项目内容已变化，请重新对比');
      }
    };
    const preview = await previewProjectImport(session, targetId, confirmedBase); assertCurrent(); importPreviewGuards.set(preview, assertCurrent); return preview;
  },
  importProject: async (session, preview, choices = {}, options = { appendChat: false, appendMemories: false }) => {
    invalidateSeriesLibrarySave();
    let result: Awaited<ReturnType<typeof importProjectArchive>>;
    let committed = false, lockedCanvas = false;
    const affected = preview ? get().projects.filter((item) => item.id === preview.targetId || item.parentId === preview.targetId).map((item) => item.id) : [];
    try {
      if (preview) {
        const guard = importPreviewGuards.get(preview); if (!guard) throw new Error('预览状态已失效，请重新对比'); guard();
        if (projectAssetSyncBarriers.has(preview.targetId) || affected.some((id) => projectImportsApplying.has(id))) throw new Error('项目正在同步或应用更新，请稍后重试');
        if (affected.some((id) => getPendingTasksForProject(id).length > 0)
          || get().agentTasks.some((task) => affected.includes(task.projectId) && !['completed', 'failed', 'stopped', 'paused'].includes(task.status))
          || get().videoBatchBusy || get().nodes.some((node) => affected.includes(get().currentProjectId ?? '') && node.data.status === 'loading')) {
          throw new Error('目标项目仍有生成或助手任务，请先停止任务再应用更新');
        }
        affected.forEach((id) => projectImportsApplying.add(id));
        await Promise.all(affected.map(waitForProjectSaveQueue)); guard();
        affected.forEach(cancelProjectCanvasDerivations);
        if (affected.includes(get().currentProjectId ?? '')) { lockedCanvas = true; set({ projectLoadStatus: 'loading' }); }
      }
      result = session ? await applyProjectImport(session, preview ?? null, choices, options, preview ? importPreviewGuards.get(preview) : undefined) : await importProjectArchive();
      committed = !!result;
    } catch (error) {
      console.error('[项目导入] 失败:', error);
      get().showToast(error instanceof Error ? t('项目导入失败：{reason}', { reason: error.message }) : '项目导入失败', 'error');
      if (session) throw error;
      return undefined;
    } finally {
      invalidateSeriesLibrarySave();
      affected.forEach((id) => projectImportsApplying.delete(id));
      if (lockedCanvas && !committed) set({ projectLoadStatus: 'ready' });
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
      series: result.series,
    };
    fileService.registerProjectFolders([project, ...result.episodes]);
    let projects: Awaited<ReturnType<typeof fileService.loadProjectsList>>;
    try { projects = await fileService.loadProjectsList(); }
    catch { if (lockedCanvas) set({ projectLoadStatus: 'error' }); get().showToast('项目已写入，但项目列表刷新失败，请重启后打开', 'error'); return result.projectId; }
    if (!projects.some((item) => item.id === result.projectId)) {
      if (lockedCanvas) set({ projectLoadStatus: 'error' });
      get().showToast('项目已写入，但项目列表刷新失败，请重启后打开', 'error'); return result.projectId;
    }
    const replacingCurrent = preview && affected.includes(get().currentProjectId ?? '');
    if (replacingCurrent) {
      set({ currentProjectId: null, projectLoadStatus: 'ready', projectName: '', nodes: [], edges: [], groups: [],
        history: [], historyIndex: -1, selectedNodeIds: [], activeNodeId: null, projects });
    } else set({ projects });
    let opened = false;
    try {
      // 项目列表已有全部分集，既有切换流程会打开第一集并加载共享资产。
      const targetId = resolveOpenTargetId(get().projects, result.projectId);
      opened = await get().switchProject(result.projectId) === targetId;
    } catch {
      // 导入已经落盘，打开失败不能把它误报成导入失败。
    }
    const episodes = result.episodes.length > 0 ? t('{count} 个分集、', { count: result.episodes.length }) : '';
    const notices = [
      t('已导入「{name}」，含 {episodes}{count} 个素材', { name: result.projectName, episodes, count: result.assetCount }),
      ...(result.missingAssetCount > 0 ? [t('{count} 个素材未找到', { count: result.missingAssetCount })] : []),
      ...result.warnings.map((warning) => t(warning)),
      ...(!opened ? [t('自动打开失败，请从项目库重新打开')] : []),
    ];
    // 旧包缺失分集与素材的提示保留在同一条反馈，避免成功提示覆盖原因。
    get().showToast(notices.join('；'), notices.length > 1 ? 'info' : undefined);
    return result.projectId;
  },

  restoreProjectImport: async (ownerId, recoveryId) => {
    invalidateSeriesLibrarySave();
    if (projectAssetSyncBarriers.has(ownerId)) throw new Error('项目正在同步，请稍后恢复');
    const affected = get().projects.filter((item) => item.id === ownerId || item.parentId === ownerId).map((item) => item.id);
    if (!affected.length || affected.some((id) => projectImportsApplying.has(id) || getPendingTasksForProject(id).length)
      || get().agentTasks.some((task) => affected.includes(task.projectId) && !['completed', 'failed', 'stopped', 'paused'].includes(task.status))
      || get().videoBatchBusy) throw new Error('项目正在执行任务或更新，请先停止后再恢复');
    if (affected.includes(get().currentProjectId ?? '')) {
      const id = get().currentProjectId; if (await get().saveCurrentProjectSilent() !== id) throw new Error('当前画布保存失败');
    }
    affected.forEach((id) => projectImportsApplying.add(id));
    let lockedCanvas = false, committed = false, projected = false;
    try {
      await Promise.all(affected.map(waitForProjectSaveQueue));
      const before = get();
      const assertCurrent = () => { const current = get();
        if (current.nodes !== before.nodes || current.edges !== before.edges || current.groups !== before.groups
          || current.projects !== before.projects || current.dramaAssets !== before.dramaAssets) throw new Error('恢复期间项目发生变化，请重试'); };
      affected.forEach(cancelProjectCanvasDerivations);
      if (affected.includes(get().currentProjectId ?? '')) { lockedCanvas = true; set({ projectLoadStatus: 'loading' }); }
      await restoreProjectImportRecovery(ownerId, recoveryId, assertCurrent);
      committed = true;
      const projects = await fileService.loadProjectsList();
      if (!projects.some((item) => item.id === ownerId)) throw new Error('恢复已提交，项目列表刷新失败，请重启后打开');
      if (affected.includes(get().currentProjectId ?? '')) set({ currentProjectId: null, projectLoadStatus: 'ready', projectName: '',
        nodes: [], edges: [], groups: [], history: [], historyIndex: -1, selectedNodeIds: [], activeNodeId: null, projects });
      else set({ projects });
      projected = true;
      // 在后续切换加载之前释放屏障；空画布不会把旧内容重新保存。
      invalidateSeriesLibrarySave();
      affected.forEach((id) => projectImportsApplying.delete(id));
      await get().switchProject(ownerId); get().showToast('已恢复项目，恢复前的状态也已保存为恢复点');
    } finally {
      invalidateSeriesLibrarySave();
      affected.forEach((id) => projectImportsApplying.delete(id));
      if (lockedCanvas && !projected) set({ projectLoadStatus: committed ? 'error' : 'ready' });
    }
  },

  deleteProject: async (id) => {
    invalidateSeriesLibrarySave();
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
    invalidateSeriesLibrarySave();
    if (options?.signal?.aborted || get().isReturningToStartPage || get().isCreatingProject
      || get().projectLoadStatus === 'loading') return;
    if (!get().projects.some((project) => project.id === requestedId)) return;
    // 剧集项目自身没有画布，点它等于打开它的分集。
    // ponytail: 固定开第一集；要「回到上次打开的那集」再往剧集记录里存一个 lastEpisodeId。
    const id = resolveOpenTargetId(get().projects, requestedId);
    const switchSequence = ++projectSwitchSequence;
    const isLatestSwitch = () => switchSequence === projectSwitchSequence && !options?.signal?.aborted;
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
          void get().captureCurrentProjectSnapshot({
            allowProjectChange: true,
            persistSnapshot: true,
          });
        }
        const savedId = await get().saveCurrentProject();
        if (!isLatestSwitch()) return;
        if (currentProjectId && savedId !== currentProjectId) {
          get().showToast('当前项目保存失败，已取消项目切换', 'error');
          return;
        }
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
        projects: get().projects.map((item) => (
          item.id === id ? { ...item, settings: data.settings, episodeAssetRoster: data.episodeAssetRoster } : item
        )),
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
      return id;
    } finally {
      if (switchSequence === projectSwitchSequence) set({ switchingProjectName: null });
    }
  },

  returnToStartPage: async () => {
    const state = get();
    if (!state.currentProjectId) return true;
    if (state.isReturningToStartPage || state.isCreatingProject || state.switchingProjectName !== null) return false;
    if (state.projectLoadStatus !== 'ready') {
      state.showToast('项目尚未成功加载，暂时无法返回启动页', 'error');
      return false;
    }
    const projectId = state.currentProjectId;
    const sequence = projectSwitchSequence;
    set({ isReturningToStartPage: true });
    try {
      // 先绘制返回状态。缩略图是派生预览，不能阻塞必要保存和导航。
      await waitForLoadingPaint();
      if (get().currentProjectId !== projectId || projectSwitchSequence !== sequence) return false;
      const savingState = get();
      // 正文先入队，空图清理或缓存预览的补丁随后排队，不能抢占必要保存。
      const saving = savingState.saveCurrentProjectSilent();
      void get().captureCurrentProjectSnapshot({ allowProjectChange: true, persistSnapshot: true })
        .catch(() => undefined);
      const savedId = await saving;
      if (savedId !== projectId || get().currentProjectId !== projectId || projectSwitchSequence !== sequence) return false;
      const latest = get();
      // 保存期间 MCP 或生成任务仍可回填；卸载前必须确认没有落在这次快照之后的新内容。
      if (latest.nodes !== savingState.nodes || latest.edges !== savingState.edges
        || latest.groups !== savingState.groups || latest.dramaAssets !== savingState.dramaAssets) {
        latest.showToast('保存期间画布有新变化，已保留当前项目，请稍后再返回启动页', 'error');
        return false;
      }
      cancelProjectCanvasDerivations(projectId);
      if (lastCapturedCanvasState?.projectId === projectId) lastCapturedCanvasState = null;
      set({
        currentProjectId: null,
        projectName: '',
        projectLoadStatus: 'ready',
        nodes: [], edges: [], groups: [],
        history: [], historyIndex: -1, selectedNodeIds: [],
        activeNodeId: null, dialogPosition: null, pendingPresetAction: null,
        nodeMenuVisible: false, nodePickerOpen: false, projectLibraryOpen: false,
        assetsPanelOpen: false, characterLibraryOpen: false, characterActionLibraryOpen: false,
        historyPanelOpen: false, dramaAssetsPanelOpen: false, workflowPanelOpen: false,
        chatOpen: false, activeConversationId: null, chatComposerLiveDraft: '', reversePromptRequest: null,
      });
      return true;
    } catch {
      get().showToast('返回启动页失败，已保留当前画布，请重试', 'error');
      return false;
    } finally {
      set({ isReturningToStartPage: false });
    }
  },

  saveCurrentProject: () => trackProjectSave(get().currentProjectId, async (projectId) => {
    const syncPending = waitForProjectAssetSync(get);
    if (syncPending) await syncPending;
    const state = get();
    if (state.currentProjectId !== projectId) return undefined;
    if (state.currentProjectId && state.projectLoadStatus !== 'ready') {
      // 加载中只是还没就绪，不算故障；加载失败才记进退出拦截状态
      if (state.projectLoadStatus === 'error') {
        noteSaveFailure(set, get, {
          kind: 'load-error',
          reason: '项目加载失败，已阻止空画布覆盖原数据',
          notify: false,
        });
      }
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
      clearSaveFailure(set, get);
      get().showToast('项目已保存');
      return record.id;
    } catch (error) {
      console.error('Save failed:', error);
      // 手动保存本来就每次都给反馈，交给 toast 自己说，不走去重逻辑
      const failure = await noteSaveError(set, get, error, false);
      get().showToast(t('保存失败：{reason}', { reason: failure.reason }), 'error');
      return undefined;
    }
  }),

  /** 静默保存（不弹 toast），用于自动保存 */
  saveCurrentProjectSilent: () => trackProjectSave(get().currentProjectId, async (projectId) => {
    const syncPending = waitForProjectAssetSync(get);
    if (syncPending) await syncPending;
    const state = get();
    if (state.currentProjectId !== projectId) return undefined;
    if (state.currentProjectId && state.projectLoadStatus !== 'ready') {
      if (state.projectLoadStatus === 'error') {
        noteSaveFailure(set, get, {
          kind: 'load-error',
          reason: '项目加载失败，已阻止空画布覆盖原数据',
          notify: true,
        });
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
      clearSaveFailure(set, get);
      return record.id;
    } catch (error) {
      console.warn('[自动保存] 保存失败:', error);
      await noteSaveError(set, get, error, true);
      return undefined;
    }
  }),

  commitSharedAssetSyncDownload: async (input) => {
    if (input.commit.ownerId !== input.ownerId || projectAssetSyncBarriers.has(input.ownerId) || projectImportsApplying.has(input.ownerId)) {
      throw new Error('该项目正在应用共享资产，请稍后重试');
    }
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason ?? input.commit.signal?.reason);
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      input.signal?.throwIfAborted();
      input.commit.signal?.throwIfAborted();
      input.assertCurrent?.();
      input.commit.assertCurrent?.();
      const current = get();
      if (current.projectLoadStatus !== 'ready' || current.currentProjectId !== input.originProjectId
        || !current.projects.some((project) => project.id === input.ownerId)
        || seriesOwnerId(current.projects, input.originProjectId) !== input.ownerId
        || current.dramaAssets !== input.expectedLibrary) {
        throw new Error('项目或资产内容已变化，请重新预览');
      }
    };
    assertCurrent();
    input.signal?.addEventListener('abort', abort, { once: true });
    input.commit.signal?.addEventListener('abort', abort, { once: true });
    let release!: () => void;
    const barrier: ProjectAssetSyncBarrier = {
      done: new Promise<void>((resolve) => { release = resolve; }), library: input.expectedLibrary,
    };
    invalidateSeriesLibrarySave();
    projectAssetSyncBarriers.set(input.ownerId, barrier);
    let unsubscribe = api.subscribe(() => { try { assertCurrent(); } catch { controller.abort(); } });
    try {
      // 屏障先登记，再等旧 active/pending 写完；后来的自动保存不能挤到下载提交后面写旧库。
      await waitForProjectSaveQueue(input.ownerId);
      assertCurrent();
      let project: ProjectSaveData | undefined;
      let expectedProjectLibrary: unknown;
      if (input.nextLibrary) {
        const previous = await getProjectById(input.ownerId);
        assertCurrent();
        if (!previous) throw new Error('所属项目已不存在，已停止共享资产应用');
        expectedProjectLibrary = previous.dramaAssets;
        const state = { ...get(), dramaAssets: input.nextLibrary };
        const captured = input.ownerId === input.originProjectId
          ? createCurrentProjectSaveRecord(state) : createSeriesLibraryRecord(state);
        if (!captured) throw new Error('所属项目已变化，请重新预览');
        project = await serializeProjectRecord(captured);
        assertCurrent();
      }
      return await applySharedAssetSyncCommit({
        ...input.commit, project, expectedProjectLibrary, signal: controller.signal, assertCurrent,
        onCommitted: (result) => {
          if (result.alreadyApplied) return;
          if (input.nextLibrary) barrier.library = input.nextLibrary;
          const current = get();
          // 提交后的取消不能撤回已持久化数据；只给仍持有原库的原项目投影，不覆盖新编辑。
          if (current.currentProjectId !== input.originProjectId || current.projectLoadStatus !== 'ready'
            || current.dramaAssets !== input.expectedLibrary
            || seriesOwnerId(current.projects, input.originProjectId) !== input.ownerId) return;
          unsubscribe(); unsubscribe = () => undefined;
          // IDB 已提交；同一回调里同步投影，校验与 set 之间没有 await。
          set((state) => ({
            ...(input.nextLibrary ? { dramaAssets: input.nextLibrary } : {}),
            projects: project ? state.projects.map((item) => item.id === input.ownerId
              ? { ...item, updatedAt: project!.updatedAt } : item) : state.projects,
          }));
        },
      });
    } finally {
      unsubscribe();
      input.signal?.removeEventListener('abort', abort);
      input.commit.signal?.removeEventListener('abort', abort);
      const current = get();
      if (current.currentProjectId && seriesOwnerId(current.projects, current.currentProjectId) === input.ownerId) {
        if (current.dramaAssets !== input.expectedLibrary) barrier.library = current.dramaAssets;
      }
      invalidateSeriesLibrarySave();
      projectAssetSyncBarriers.delete(input.ownerId);
      release();
    }
  },

  loadProject: async () => {
    invalidateSeriesLibrarySave();
    try {
      const allProjects = await fileService.loadProjectsList();
      if (allProjects.length > 0) {
        const mapped: CanvasProject[] = withInheritedDataFolders(allProjects.map((p) => ({
          id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
          snapshot: p.snapshot, dataFolder: p.dataFolder, settings: p.settings,
          parentId: p.parentId, episodeNo: p.episodeNo, episodeOutline: p.episodeOutline,
          episodeScript: p.episodeScript, episodeCreative: p.episodeCreative,
          episodeAssetRoster: p.episodeAssetRoster,
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
            projects: mapped.map((project) => (
              project.id === targetId ? { ...project, settings: data.settings, episodeAssetRoster: data.episodeAssetRoster } : project
            )),
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

  initFromDb: () => {
    invalidateSeriesLibrarySave();
    if (get().projectInitialized) return Promise.resolve();
    const pending = projectInitializations.get(get);
    if (pending) return pending;
    // get 与 API.getState 是同一稳定引用，首次创建和 HMR 的绑定 Store 都能共用。
    const initialization: Promise<void> = Promise.resolve().then(async () => {
      set({ currentProjectId: null, projectLoadStatus: 'loading' });
      try {
        await Promise.all([get().loadConfig(), get().loadWorkflows(), get().loadPresets(), get().loadSkills(), get().loadSubAgentProfiles(), get().loadCustomStyles(), get().loadToolbarLayouts(), get().loadPlugins()]);
        await get().loadAppearanceThemes();

        const allProjects = await fileService.loadProjectsList();
        const valid = allProjects.filter((p) => p.id !== 'default');
        if (valid.length < allProjects.length) {
          fileService.deleteProjectData('default').catch((e) => console.warn('[初始化] 清理默认项目数据失败:', e));
        }
        let activeProjectId: string | null = null;
        const mapped: CanvasProject[] = withInheritedDataFolders(valid.map((p) => ({
          id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
          snapshot: p.snapshot, dataFolder: p.dataFolder, settings: p.settings,
          parentId: p.parentId, episodeNo: p.episodeNo, episodeOutline: p.episodeOutline,
          episodeScript: p.episodeScript, episodeCreative: p.episodeCreative,
          episodeAssetRoster: p.episodeAssetRoster,
          series: p.series,
        })));
        fileService.registerProjectFolders(mapped);
        mapped.sort((a, b) => b.updatedAt - a.updatedAt);
        const recoveringWebview = await isWebviewRecovery();
        if (get().config.startupView === 'project-library' || recoveringWebview) {
          // 启动页只读摘要；选定项目后才通过既有切换流程加载画布及项目域数据。
          set({
            projects: mapped,
            currentProjectId: null,
            projectName: '',
            nodes: [],
            edges: [],
            groups: [],
            history: [],
            historyIndex: -1,
            selectedNodeIds: [],
            projectLoadStatus: 'ready',
          });
        } else if (valid.length > 0) {
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
              projects: mapped.map((project) => (
                project.id === targetId ? { ...project, settings: data.settings, episodeAssetRoster: data.episodeAssetRoster } : project
              )),
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
        }
        // 即使停留在启动页，也修复所有项目的遗留 Agent 任务，禁止打开项目时自动续跑。
        await Promise.all([
          ...get().projects.map((project) => get().repairInterruptedAgentTasksForProject(project.id)),
          get().repairInterruptedAgentTasksForProject(GENERAL_ASSISTANT_SCOPE_ID),
          get().repairInterruptedForProject(GENERAL_ASSISTANT_SCOPE_ID),
        ]);
        if (get().projectLoadStatus === 'ready') set({ projectInitialized: true });
      } catch (error) {
        console.error('Init from IndexedDB failed:', error);
        set({ currentProjectId: null, projectLoadStatus: 'error' });
        get().showToast('项目数据读取失败，未创建空项目', 'error');
      }
    }).finally(() => {
      if (projectInitializations.get(get) === initialization) projectInitializations.delete(get);
    });
    projectInitializations.set(get, initialization);
    return initialization;
  },
  };
};
