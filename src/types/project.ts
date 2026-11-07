/** 项目模型 v2 的领域合同；P0/P1 仅提供旧库只读投影，不构成新表写入许可。 */
import type {
  EpisodeCreativeInfo, ProjectGenerationDefaults, ProjectModelKind, ProjectOriginalWork,
  ProjectSettings, ProjectStyleReference, ProjectTextFileReference, ProjectVisualStyleSettings,
} from './index';
import type { AgentTeamProfile } from './agentTeam';
import type { CreationProfileSelection } from './creationProfile';
import type { DramaAssetLibrary } from './dramaAssets';
import type { EpisodeAssetRoster } from './episodeAssets';
import type { StoryGraph } from './storyGraph';

export const PROJECT_DATA_MODEL_VERSION = 2 as const;
export type ProjectKind = 'standalone' | 'series';

/** inherit 使用项目值；clear 屏蔽项目值并回到应用兜底，不是删除覆盖记录。 */
export type ProjectSettingOverride<T> =
  | { op: 'inherit' }
  | { op: 'set'; value: T }
  | { op: 'clear' };
type FieldOverrides<T> = { [K in keyof T]?: ProjectSettingOverride<NonNullable<T[K]>> };
export interface ProjectSettingsPatch {
  visualStyle?: Omit<FieldOverrides<ProjectVisualStyleSettings>, 'styleReference'> & {
    styleReference?: ProjectSettingOverride<ProjectStyleReference>;
  };
  defaultModels?: Partial<Record<ProjectModelKind, ProjectSettingOverride<string>>>;
  promptSuffixes?: Partial<Record<ProjectModelKind, ProjectSettingOverride<string>>>;
  generation?: FieldOverrides<ProjectGenerationDefaults>;
  visionModelId?: ProjectSettingOverride<string>;
  modelAutoRouting?: ProjectSettingOverride<boolean>;
}
export type EpisodeSettingsPolicy =
  | { mode: 'legacy-pinned'; snapshot: ProjectSettings }
  | { mode: 'inherit'; overrides: ProjectSettingsPatch };

/** 相对既有应用数据根的目录定位；不是路径授权，不保存绝对路径或 grant。 */
export interface ProjectStorageBinding {
  rootRef: string;
  folderName: string;
  sourceRecordIds: string[];
  source: 'legacy-folder-rule' | 'project-managed';
}

export interface ProjectRecord {
  id: string;
  name: string;
  kind: ProjectKind;
  createdAt: number;
  updatedAt: number;
  epoch: number;
  dataFolder: string;
  storageRootRef: string;
  storageBindings: ProjectStorageBinding[];
  defaultSettings?: ProjectSettings;
  lastOpenedCanvasId?: string;
}

export interface ProjectCreativeContent {
  outline?: string;
  script?: string;
  scriptFile?: ProjectTextFileReference;
  creative?: EpisodeCreativeInfo;
  assetRoster?: EpisodeAssetRoster;
  revision: number;
  /** TXT 根据现有保存入口使用 owner 根，不能由画布根推断。 */
  storageRootRef: string;
}
export interface StandaloneCreativeContent extends ProjectCreativeContent {
  creationProfile?: CreationProfileSelection;
  teamProfileOverride?: AgentTeamProfile;
}
export interface ProjectContent {
  projectId: string;
  originalWork?: ProjectOriginalWork;
  script?: string;
  storyGraph?: StoryGraph;
  dramaAssets?: DramaAssetLibrary;
  standaloneCreative?: StandaloneCreativeContent;
  revisions: { source: number; script: number; storyGraph: number; assets: number };
}
export interface EpisodeRecord {
  id: string;
  projectId: string;
  canvasId: string;
  name: string;
  orderRank: number;
  displayNo?: number;
  createdAt: number;
  updatedAt: number;
  epoch: number;
  revision: number;
  settingsPolicy: EpisodeSettingsPolicy;
  creationProfile?: CreationProfileSelection;
  teamProfileOverride?: AgentTeamProfile;
}
export interface EpisodeContent extends ProjectCreativeContent { episodeId: string }

/** 图元素在持久化/只读边界保持原对象；执行前仍须经过既有画布领域校验。 */
export interface CanvasDocument {
  id: string;
  projectId: string;
  episodeId: string | null;
  storageRootRef: string;
  nodes: unknown[];
  edges: unknown[];
  groups: unknown[];
  epoch: number;
  revision: number;
  revisionScope: 'project' | 'global';
}
export interface CanvasPreview { canvasId: string; snapshot: string; updatedAt: number }
export interface ProjectEpisodeAggregate {
  episode: EpisodeRecord;
  content: EpisodeContent;
  canvas: CanvasDocument;
  preview?: CanvasPreview;
}
export interface LegacyProjectBinding {
  namespace: 'legacy-root' | 'legacy-episode' | 'legacy-canvas';
  legacyId: string;
  projectId: string;
  episodeId?: string;
  canvasId?: string;
  storageRootRef: string;
  sourceEpoch: number;
  /** 删除后只读历史定位；不能据此取得活动目标、恢复旧租约或重投任务。 */
  retired?: true;
  retiredAt?: number;
}
export interface ProjectAggregate {
  /** 旧库投影没有 generation 激活/执行权限，不能作为新写入快照。 */
  access: 'legacy-readonly';
  project: ProjectRecord;
  content: ProjectContent;
  episodes: ProjectEpisodeAggregate[];
  standaloneCanvas?: CanvasDocument;
  standalonePreview?: CanvasPreview;
  bindings: LegacyProjectBinding[];
}

export interface GlobalProjectContext {
  /** legacy兼容桥的进程代次；跨连接稳定，重启失效，不是鉴权令牌。 */
  runtimeEpoch?: string;
  kind: 'global';
  schemaVersion: 2;
  modelGeneration: number;
  catalogRevision: number;
}
export interface ProjectContext {
  runtimeEpoch?: string;
  kind: 'project';
  schemaVersion: 2;
  modelGeneration: number;
  projectId: string;
  projectEpoch: number;
}
export interface EpisodeContext extends Omit<ProjectContext, 'kind'> {
  kind: 'episode';
  episodeId: string;
  episodeRevision: number;
  sourceHash?: string;
}
export interface CanvasContext extends Omit<ProjectContext, 'kind'> {
  kind: 'canvas';
  canvasId: string;
  episodeId: string | null;
  canvasEpoch: number;
  canvasRevision: number;
}
/** 可跨 CLI 连接传递的并发前置条件，绝不代替鉴权与 Policy。 */
export type ProjectExpectedContext = GlobalProjectContext | ProjectContext | EpisodeContext | CanvasContext;
export type ProjectExecutionTarget =
  | { kind: 'project'; projectId: string; domain: 'shared' | 'standalone-creative' }
  | { kind: 'episode'; projectId: string; episodeId: string }
  | { kind: 'canvas'; projectId: string; canvasId: string; episodeId: string | null };

/** 已删除目标只供历史显示；不证明活动实体存在，也不授予写入或恢复权限。 */
export type ProjectHistoricalTarget =
  | { state: 'active'; kind: 'episode' | 'canvas' | 'standalone-creative'; ownerLogicalId: string; logicalId: string }
  | { state: 'retired'; kind: 'episode' | 'canvas' | 'standalone-creative'; ownerLogicalId: string; logicalId: string };
