import type { StateCreator } from 'zustand';
import type { AppState } from '../useAppStore';
import type {
  BaseNodeData, CanvasProject, EpisodeCreativeInfo, ProjectOriginalWork, ProjectSeriesInfo,
  ProjectSettings,
} from '../../types';
import type * as fileService from '../../services/fileService';
import type {
  SharedAssetSyncCommitInput, SharedAssetSyncCommitResult,
} from '../../services/indexedDb/sharedAssetSyncRepository';
import type { StorageFailureKind } from '../../services/storageQuota';
import type { AssetRepairPreview } from '../../services/fs/assetRepair';
import type { DramaAssetLibrary, DramaAssetWriteOptions } from '../../types/dramaAssets';
import type { EpisodeAssetRoster } from '../../types/episodeAssets';
import type {
  PreparedProjectImport, ProjectImportPreview, ProjectImportOptions,
} from '../../services/projectImportService';
import type { ProjectMergeSide } from '../../services/projectMergeService';
import type { TeamEpisodeTarget } from '../../types/agentTeam';
import type { StoryGraph, StoryGraphPatch } from '../../types/storyGraph';
import type { ProjectExpectedContext } from '../../types/project';
import type { NativeMediaTaskRecord } from '../../services/indexedDb/nativeMediaTaskRepository';
import type { NativeMediaSubmissionPreparation } from '../../types/media';
import type { NativeProjectPendingTransfer } from '../../services/indexedDb/nativeProjectRepository';
import type { CharacterVisualReferencePlan } from '../../services/characterVisualReferencePlan';

export type ProjectLoadStatus = 'loading' | 'ready' | 'readonly' | 'error';

export type NativeProjectWriteBlock = Exclude<NativeProjectPendingTransfer, { kind: 'export' }> & { projectId: string };

export interface EpisodeCreativeWriteOptions {
  expected?: TeamEpisodeTarget;
  /** 仅可信工作台宿主可在已加载的同一剧集中保存明确目标，不代表画布写权限。 */
  allowSameSeries?: boolean;
  /** 工作台显式用已提交正文生成新的 TXT，旧文件保留。 */
  rebuildScriptFile?: true;
  /** 仅供宿主编辑会话使用；不得进入持久化。 */
  assertCurrent?: () => void;
  /** 乐观更新后、磁盘读取及实际入队提交时的范围守卫，不重复检查提交前的脏稿。 */
  assertCommitCurrent?: () => void;
}

export type EpisodeAssetRosterWriteOptions = Pick<EpisodeCreativeWriteOptions, 'allowSameSeries' | 'assertCurrent' | 'assertCommitCurrent'>;

export interface SeriesInfoWriteOptions {
  expectedSeriesId?: string;
  expectedExchangeEpoch?: number;
  /** 保存编辑器打开时读取的正文版本，空串与未填等价。 */
  expectedScript?: string;
  /** null 表示首次绑定前不能已有原著；省略时兼容普通元数据更新。 */
  expectedOriginalWork?: ProjectOriginalWork | null;
  /** 主窗口编辑会话的运行时守卫，不持久化。 */
  assertCurrent?: () => void;
}

export interface StoryGraphWriteOptions {
  expectedExchangeEpoch?: number;
  signal?: AbortSignal;
  /** 只由主窗口宿主验证编辑会话，不进入持久化或跨窗消息。 */
  assertCurrent?: () => void;
}

export interface CaptureProjectSnapshotOptions {
  allowProjectChange?: boolean;
  persistSnapshot?: boolean;
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
  projectExecutionContext?: ProjectExpectedContext | null;
  /** 只读运行期身份；离开后重开同一项目也会更换。 */
  getProjectSessionToken: () => object;
  projectName: string;
  projectLoadStatus: ProjectLoadStatus;
  nativeProjectWriteBlock: NativeProjectWriteBlock | null;
  hasUnsavedNativeProjectWriteBlock: () => boolean;
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
  updateSeriesInfo: (info: Omit<ProjectSeriesInfo, 'storyGraph'>, options?: SeriesInfoWriteOptions) => Promise<boolean>;
  updateStoryGraph: (seriesId: string, patch: StoryGraphPatch, expectedRevision: number,
    guards?: StoryGraphWriteOptions) => Promise<StoryGraph>;
  /** 按需读取当前作品下的一集正文。已就绪的视图直接复用。 */
  loadEpisodeCreative: (episodeId: string) => Promise<CanvasProject>;
  /** 写入某一集的大纲。兼容既有 Agent 工具。 */
  updateEpisodeOutline: (episodeId: string, outline: string) => Promise<boolean>;
  /** 原子更新某一集的大纲、正文和创作要点。 */
  updateEpisodeCreative: (
    episodeId: string,
    updates: { outline?: string; script?: string; creative?: EpisodeCreativeInfo;
      creationProfile?: import('../../types/creationProfile').CreationProfileSelection | null; teamProfileOverride?: import('../../types/agentTeam').AgentTeamProfile | null },
    options?: EpisodeCreativeWriteOptions,
  ) => Promise<boolean>;
  /** 只更新当前准确分集的提取清单；expectedRevision 防止覆盖较新的编辑。 */
  updateEpisodeAssetRoster: (episodeId: string, roster: EpisodeAssetRoster, expectedRevision?: number,
    options?: EpisodeAssetRosterWriteOptions) => Promise<boolean>;
  /** 与相邻的一集交换集号；direction 为 -1 上移、1 下移。 */
  moveEpisode: (episodeId: string, direction: -1 | 1) => Promise<boolean>;
  exportProject: (id: string) => Promise<boolean>;
  prepareProjectImport: () => Promise<PreparedProjectImport | null>;
  previewProjectImport: (session: PreparedProjectImport, targetId: string, confirmedBase?: PreparedProjectImport) => Promise<ProjectImportPreview>;
  importProject: (session?: PreparedProjectImport, preview?: ProjectImportPreview | null,
    choices?: Readonly<Record<string, ProjectMergeSide>>, options?: ProjectImportOptions) => Promise<string | undefined>;
  restoreProjectImport: (ownerId: string, recoveryId: string) => Promise<void>;
  settleProjectTransfer: (ownerId: string, operationId: string, action: 'continue' | 'abandon') => Promise<void>;
  /** 事务提交原媒体结果，保存并重载当前画布；原租约失效时不覆盖其他作品。 */
  commitNativeMediaResult: (record: NativeMediaTaskRecord, relativePath: string, expected: ProjectExpectedContext, signal?: AbortSignal) => Promise<void>;
  /** 在冻结本轮生成输入前补齐当前节点和引用素材的落盘身份，不创建历史或提交付费请求。 */
  normalizeNativeMediaGenerationInputs: (nodeId: string, input?: BaseNodeData) => Promise<{
    targetPatch: Partial<BaseNodeData>; nodePatches: Map<string, Partial<BaseNodeData>>;
  }>;
  beginNativeMediaSubmissionPreparation: (expected: import('../../types/project').CanvasContext) => Promise<NativeMediaSubmissionPreparation>;
  /** 复制项目（含分集、对话与素材），复制完不切画布。 */
  duplicateProject: (id: string) => Promise<string | undefined>;
  deleteProject: (id: string, options?: { recycleMedia?: boolean }) => Promise<void>;
  /** 成功返回实际打开的项目 ID；captureSnapshot 仅项目库使用，signal 只在本次加载内存中保留。 */
  switchProject: (id: string, options?: { captureSnapshot?: boolean; signal?: AbortSignal }) => Promise<string | undefined>;
  /** 保存当前画布后返回启动页；保存失败不卸载当前画布。 */
  returnToStartPage: () => Promise<boolean>;
  saveCurrentProject: () => Promise<string | undefined>;
  saveCurrentProjectSilent: (assertCurrent?: () => void) => Promise<string | undefined>;
  applyCharacterVisualReferencePlan: (plan: CharacterVisualReferencePlan, nodeIds: readonly string[], assertCurrent?: () => void) => Promise<number>;
  commitSharedAssetSyncDownload: (input: SharedProjectAssetSyncApplyInput) => Promise<SharedAssetSyncCommitResult>;
  /** 仅刷新项目目录，保留当前画布与已加载正文。 */
  refreshProjectCatalog: () => Promise<void>;
  loadProject: () => Promise<void>;
  initFromDb: () => Promise<void>;
  moveGlobalAssetToFolder: (file: fileService.AssetFileEntry, selection: fileService.AssetFolderSelection,
    options?: fileService.FileTransferOptions) => Promise<{ path: string; moved: boolean }>;
  renameAssetFile: (file: fileService.AssetFileEntry, name: string, projectId?: string) => Promise<fileService.AssetFileRenameResult>;
  repairAssetLocations: (preview: AssetRepairPreview, assetIds: readonly string[], options?: DramaAssetWriteOptions) => Promise<number>;
  cleanupMissingAssets: (preview: AssetRepairPreview, assetIds: readonly string[], options?: DramaAssetWriteOptions) => Promise<number>;
}

export type ProjectSliceSet = Parameters<StateCreator<AppState, [], [], ProjectSlice>>[0];

export type ProjectSliceGet = Parameters<StateCreator<AppState, [], [], ProjectSlice>>[1];
