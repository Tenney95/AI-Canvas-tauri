/**
 * Project/Episode/Canvas 的归档合同。P0 只冻结结构，现有 v1/v2/v3 解析器和导出版本不因此升版。
 * 本机迁移备份另用 project-model-backup-v1，不得调用项目包脱敏器替代完整备份。
 */
import type { ProjectArchiveChatPayload } from '../services/projectTransferService';
import type {
  ProjectExchangeEntityKind,
  ProjectExchangeObject,
  ProjectExchangeRevision,
  ProjectExchangeRevisionHeader,
  ProjectExchangeMedia,
} from './projectExchange';

export const PROJECT_ARCHIVE_V4_CONTRACT = {
  archiveVersion: 4,
  canonicalVersion: 2,
  exchangeVersion: 2,
  adapterVersion: 'project-model-1',
  runtimeEnabled: false,
} as const;

export const PROJECT_ARCHIVE_V4_ENTRIES = [
  'project.json', 'episodes.json', 'canvases.json', 'contents.json', 'exchange.json',
] as const;

export type ProjectArchiveV4Entry = typeof PROJECT_ARCHIVE_V4_ENTRIES[number] | 'history.json';
export type ProjectExchangeKindV2 = ProjectExchangeEntityKind | 'episode' | 'canvas';

/** scopeId 是逻辑作用域；Canvas 内容不再用本机项目 ID 隐式指定目标。 */
export interface ProjectExchangeReferenceV2 {
  kind: ProjectExchangeKindV2;
  scopeId: string;
  id: string;
}

export interface ProjectExchangeEntityV2 extends ProjectExchangeReferenceV2 {
  data: ProjectExchangeObject;
  references: ProjectExchangeReferenceV2[];
}

/** 仅用于显示旧来源，不参与活动引用闭包，不构成删除证明或执行授权。 */
export interface ProjectArchiveHistoricalTarget {
  state: 'retired';
  kind: 'episode' | 'canvas' | 'standalone-creative';
  projectId: string;
  id: string;
}

export interface ProjectExchangeSnapshotV2 {
  format: 'ai-canvas-project-snapshot';
  canonicalVersion: 2;
  lineageId: string;
  rootProjectId: string;
  complete: true;
  entities: ProjectExchangeEntityV2[];
  media: ProjectExchangeMedia[];
  historicalTargets: ProjectArchiveHistoricalTarget[];
}

export interface ProjectExchangeRevisionReference {
  canonicalVersion: 1 | 2;
  revisionId: string;
}

/** v1 原文继续使用原 header，不能给旧 hash 增添新字段。 */
export interface ProjectExchangeRevisionHeaderV2 {
  canonicalVersion: 2;
  lineageId: string;
  revisionId: string;
  contentDigest: string;
  parents: ProjectExchangeRevisionReference[];
  adapterVersion: typeof PROJECT_ARCHIVE_V4_CONTRACT.adapterVersion;
}

export interface ProjectExchangeRevisionV2 extends ProjectExchangeRevisionHeaderV2 {
  snapshot: ProjectExchangeSnapshotV2;
}

export interface ProjectExchangeBundleV2 {
  format: 'ai-canvas-project-exchange';
  version: 2;
  packageId: string;
  lineageId: string;
  head: ProjectExchangeRevisionReference & { canonicalVersion: 2 };
  revisions: Array<ProjectExchangeRevision | ProjectExchangeRevisionV2>;
  ancestors: Array<ProjectExchangeRevisionHeader | ProjectExchangeRevisionHeaderV2>;
  files: Array<{
    mediaId: string;
    /** 安全 assets/ 相对路径，不能传给本机文件接口当绝对路径。 */
    archivePath: string;
  }>;
}

export interface ProjectArchiveManifestV4 {
  formatVersion: 4;
  packageId: string;
  exportedAt: number;
  appVersion?: string;
  projectId: string;
  projectName: string;
  projectKind: 'standalone' | 'series';
  episodeCount: number;
  canvasCount: number;
  /** manifest 本身不列入自己的摘要，所有正文条目必须唯一且完全覆盖。 */
  entries: Array<{ path: ProjectArchiveV4Entry; bytes: number; sha256: string }>;
}

/** 本机根目录名称不进入归档；同名文件通过逻辑 rootRef 区分。 */
export interface ProjectArchiveStorageRootV4 {
  id: string;
  role: 'shared' | 'canvas' | 'manuscript';
}

export interface ProjectArchiveProjectV4 {
  id: string;
  name: string;
  kind: 'standalone' | 'series';
  storageRoots: ProjectArchiveStorageRootV4[];
  defaultSettings?: ProjectExchangeObject;
  standaloneCanvasId?: string;
}

export interface ProjectArchiveEpisodeV4 {
  id: string;
  projectId: string;
  canvasId: string;
  name: string;
  orderRank: number;
  displayNo?: number;
  settingsPolicy: ProjectExchangeObject;
  creationProfile?: ProjectExchangeObject;
  teamProfileOverride?: ProjectExchangeObject;
}

export interface ProjectArchiveCanvasV4 {
  id: string;
  projectId: string;
  episodeId: string | null;
  storageRootRef: string;
  nodes: ProjectExchangeObject[];
  edges: ProjectExchangeObject[];
  groups: ProjectExchangeObject[];
}

export interface ProjectArchiveContentsV4 {
  project: { projectId: string; data: ProjectExchangeObject };
  episodes: Array<{ episodeId: string; data: ProjectExchangeObject }>;
}

export type ProjectArchiveWorkbenchTargetV4 =
  | { state: 'active'; kind: 'project'; projectId: string; domain: 'standalone-creative' }
  | { state: 'active'; kind: 'episode'; projectId: string; episodeId: string }
  | ProjectArchiveHistoricalTarget;

/** 只携带既有 portableArchiveChat 白名单内容，不携带任务/回执或租约。 */
export interface ProjectArchiveHistoryV4 {
  /** 旧 workbenchTarget 不再与新绑定并存，避免 active/retired 双权威。 */
  payload: Omit<ProjectArchiveChatPayload, 'conversations'> & {
    conversations: Array<Omit<ProjectArchiveChatPayload['conversations'][number], 'workbenchTarget'>>;
  };
  workbenchTargets: Array<{ conversationId: string; target: ProjectArchiveWorkbenchTargetV4 }>;
}

export type ProjectArchiveOperation = 'in-place-upgrade' | 'import-new' | 'update-existing'
  | 'independent-copy' | 'restore-content';

/** 不能把原地迁移的保号语义用于外部包新建导入。 */
export const PROJECT_ARCHIVE_IDENTITY_RULES = {
  'in-place-upgrade': { localIdentity: 'preserve', lineage: 'preserve', directory: 'preserve' },
  'import-new': { localIdentity: 'allocate', lineage: 'preserve-if-proven', directory: 'allocate' },
  'update-existing': { localIdentity: 'preserve-target', lineage: 'require-proven-base', directory: 'preserve-target' },
  'independent-copy': { localIdentity: 'allocate', lineage: 'allocate', directory: 'allocate' },
  'restore-content': { localIdentity: 'preserve-target', lineage: 'append-current', directory: 'verify-current' },
} as const satisfies Record<ProjectArchiveOperation, {
  localIdentity: string; lineage: string; directory: string;
}>;
