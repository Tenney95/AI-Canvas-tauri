/** P5 隔离新模型传输合同；不激活正式模型，不承载运行授权或审计回滚。 */
import type { CanvasDocument, CanvasPreview, EpisodeContent, EpisodeRecord, LegacyProjectBinding, ProjectContent, ProjectRecord } from './project';
import type { ProjectArchiveWorkbenchTargetV4, ProjectExchangeBundleV2, ProjectExchangeRevisionReference } from './projectArchiveV4';

export interface ProjectModelTransferAggregate {
  project: ProjectRecord;
  content: ProjectContent;
  episodes: EpisodeRecord[];
  episodeContents: EpisodeContent[];
  canvases: CanvasDocument[];
  previews: CanvasPreview[];
  bindings: LegacyProjectBinding[];
}
export type ProjectModelTransferHistoryKind = 'conversation' | 'message' | 'memory';
export interface ProjectModelArchiveHistoryBinding {
  destinationProjectId: string;
  sourceNamespace: string;
  kind: ProjectModelTransferHistoryKind;
  archiveOriginId: string;
  localId: string;
  historicalTarget?: ProjectArchiveWorkbenchTargetV4;
}
export interface ProjectModelTransferHistoryRow {
  kind: ProjectModelTransferHistoryKind;
  sourceNamespace: string;
  archiveOriginId: string;
  historicalTarget?: ProjectArchiveWorkbenchTargetV4;
  value: { id: string; projectId: string; [field: string]: unknown };
  /** 旧来源已有明确映射时只登记来源，不覆盖该本机历史。 */
  existingLocalId?: string;
}
export interface ProjectModelTransferExchange {
  lineageId: string;
  localHead: ProjectExchangeRevisionReference;
  stateVersion: number;
  bundle: ProjectExchangeBundleV2;
  /** sourceId 为协作逻辑ID，localId 为当前本机ID；导出不能按新本机ID重新创造来源。 */
  identities: ProjectModelTransferIdMapEntry[];
  fileBindings: Array<{ id: string; rootRef: string; relativePath: string; localRelativePath: string }>;
  /** 准备修订不代表文件已交接。仅 export registered 才追加发布回执。 */
  published: Array<{ operationId: string; packageDigest: string; outputRef: string; head: ProjectExchangeRevisionReference }>;
}
export interface ProjectModelTransferCapture {
  schemaVersion: 1;
  generation: number;
  sessionId: string;
  sessionRevision: number;
  aggregate: ProjectModelTransferAggregate;
  exchange: ProjectModelTransferExchange | null;
  historyBindings: ProjectModelArchiveHistoryBinding[];
  history: ProjectModelTransferHistoryRow[];
  /** 同一只读事务中的精确材料；用于CAS，不是摘要或执行租约。 */
  sourceToken: string;
  includesHistory: boolean;
}
export interface ProjectModelTransferMedia {
  rootRef: string;
  relativePath: string;
  bytes: number;
  sha256: string;
}
export interface ProjectModelTransferSourceFile extends ProjectModelTransferMedia {
  id: string;
  archivePath: string;
}
export interface ProjectModelTransferIdMapEntry {
  kind: 'project' | 'episode' | 'canvas' | 'storage-root';
  sourceId: string;
  localId: string;
}
export interface ProjectModelVerifiedRestoreProof {
  kind: 'project-model-pre-restore';
  backupOperationId: string;
  manifestDigest: string;
  backupSourceDigest: string;
  sourceToken: string;
  /** 原生适配器另核当前作品媒体清单；不由布尔值授予文件恢复授权。 */
  sourceMediaDigest?: string;
  verified: true;
  /** 恢复作品内容不回写任务、预算、LS队列或账本；缺证据不能称审计已协调。 */
  auditPolicy: 'preserve-current';
}
export type ProjectModelImportPhase = 'prepared' | 'media_publishing' | 'media_ready' | 'db_committed' | 'projected' | 'finalized';
export type ProjectModelExportPhase = 'prepared' | 'packing' | 'published' | 'registered' | 'aborted';
export interface ProjectModelTransferImportInput {
  operationId: string;
  mode: 'import-new' | 'update-existing' | 'independent-copy' | 'restore-content';
  packageDigest: string;
  /** 在本机随机 ID 分配前冻结的预览/冲突选择摘要。 */
  intentDigest: string;
  sourceLineageId?: string;
  targetProjectId: string;
  expected: ProjectModelTransferCapture | null;
  next: ProjectModelTransferAggregate;
  exchange: ProjectModelTransferExchange | null;
  idMap: ProjectModelTransferIdMapEntry[];
  history: ProjectModelTransferHistoryRow[];
  media: ProjectModelTransferMedia[];
  /** 本fixture下的安全相对暂存位置；不是原生grant或任意本机路径。 */
  sourceRef?: string;
  sourceFiles?: ProjectModelTransferSourceFile[];
  restoreProof?: ProjectModelVerifiedRestoreProof;
  signal?: AbortSignal;
}
export interface ProjectModelTransferImportJournal extends Omit<ProjectModelTransferImportInput, 'signal'> {
  id: string;
  schemaVersion: 1;
  kind: 'project-model-import';
  generation: number;
  sessionId: string;
  phase: ProjectModelImportPhase;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  /** 原生发行权威只交回不透明引用；绝不保存本机绝对路径。 */
  mediaPublicationRef?: string;
  committedToken?: string;
  cleanup: 'retain-until-unreferenced';
}
export interface ProjectModelTransferExportJournal {
  id: string;
  schemaVersion: 1;
  kind: 'project-model-export';
  operationId: string;
  generation: number;
  sessionId: string;
  targetProjectId: string;
  expectedToken: string;
  expectedExchange: ProjectModelTransferExchange | null;
  includesHistory: boolean;
  head: ProjectExchangeRevisionReference;
  exchange: ProjectModelTransferExchange;
  phase: ProjectModelExportPhase;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  packageDigest?: string;
  outputRef?: string;
}

/** 只在内存由受信编排器装配；字面量 verified/opaque ID 从不代替原生读回校验。 */
export interface ProjectModelTransferSafety {
  verifyRestoreBackup?: (proof: ProjectModelVerifiedRestoreProof, capture: ProjectModelTransferCapture) => Promise<void>;
  verifyRestoreCommit?: (proof: ProjectModelVerifiedRestoreProof, capture: ProjectModelTransferCapture, journal: ProjectModelTransferImportJournal) => Promise<void>;
  verifyMediaPublication?: (journal: ProjectModelTransferImportJournal, mediaPublicationRef: string) => Promise<void>;
  verifyExportPublication?: (journal: ProjectModelTransferExportJournal, receipt: { packageDigest: string; outputRef: string }) => Promise<void>;
}
