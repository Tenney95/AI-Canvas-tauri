/** 项目资产共享连接。P0 只保存连接与项目绑定，不代表资产已同步。 */
export interface SharedStorageConnectionInput {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix: string;
  pathStyle: boolean;
}

export interface SharedStorageConnection extends SharedStorageConnectionInput {
  revision: string;
  credentialsSaved: boolean;
  sessionTokenSaved: boolean;
}

/** 只用于当次 IPC，不进入 Store、配置、日志或 IndexedDB。未提供的字段保留。 */
export interface SharedStorageCredentialUpdate {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  clearSessionToken?: boolean;
  clearCredentials?: boolean;
}

export interface SaveSharedStorageConnectionInput {
  connection: SharedStorageConnectionInput;
  expectedRevision?: string;
  credentials?: SharedStorageCredentialUpdate;
}

export type SharedStorageCheckKind = 'list' | 'readWrite' | 'multipart' | 'conditionalCreate' | 'conditionalUpdate';
export interface SharedStorageCapabilityCheck {
  kind: SharedStorageCheckKind;
  status: 'passed' | 'failed' | 'notChecked';
  code?: string;
}

export interface SharedStorageCapabilityReport {
  checks: SharedStorageCapabilityCheck[];
  checkedAt: number;
  cleanupPending: boolean;
  multiplayerWritable: boolean;
}

export interface SharedProjectBinding {
  ownerId: string;
  ownerName: string;
  connectionId: string;
  connectionRevision: string;
  libraryId: string;
  sharedProjectId: string;
  projectPrefix: string;
  /** 当前同步会话读取的云端代次；不属于本机连接配置。 */
  generation?: string;
  capabilities: SharedStorageCapabilityReport;
  updatedAt: number;
}

export interface SharedAssetStorageSnapshot {
  connections: SharedStorageConnection[];
  bindings: SharedProjectBinding[];
  /** 单调递增的原生 catalog 版本，防止迟到快照覆盖新状态。 */
  revision: number;
}

export interface BindSharedProjectInput {
  taskId: string;
  ownerId: string;
  ownerName: string;
  connectionId: string;
  connectionRevision: string;
  mode: 'create' | 'join';
  libraryId: string;
  sharedProjectId: string;
}

export interface SharedProjectOperationResult {
  snapshot: SharedAssetStorageSnapshot;
  report: SharedStorageCapabilityReport;
  bound: boolean;
}

export type SharedProjectResetMode = 'clear' | 'delete';
export interface SharedProjectResetPreview {
  mode: SharedProjectResetMode;
  objectCount: number;
  bytes: number;
  previewToken: string;
}
export interface SharedProjectResetResult {
  status: 'completed' | 'cancelled' | 'failed' | 'changed';
  deletedCount: number;
  totalCount: number;
  errorCode?: string;
}
export interface SharedProjectResetStatus {
  stage: 'idle' | 'previewing' | 'preview' | 'applying';
  progress?: { deletedCount: number; totalCount: number };
}

export interface ProbeSharedProjectInput {
  taskId: string;
  ownerId: string;
}

/** 同步协议的身份与本机卡片／文件身份分离；SHA-256 只标识文件内容。 */
export type SharedSyncAssetKind = 'file' | 'character' | 'scene' | 'prop';
export type SharedSyncMediaKind = 'image' | 'audio' | 'video';
export interface SharedSyncMedia {
  id: string;
  kind: SharedSyncMediaKind;
  sha256: string;
  bytes: number;
  extension: string;
}
export interface SharedSyncFilePayload {
  kind: 'file';
  name: string;
  displayRelativePath: string;
  mediaId: string;
  tags: string[];
  taggedBy?: 'manual' | 'comfyui' | 'vision';
  imageMetadata?: {
    prompt: string;
    references: Array<{ id: string; name: string; mediaId: string }>;
  };
}
export interface SharedSyncCardPayload {
  kind: 'character' | 'scene' | 'prop';
  /** 已白名单校验；所有实体 ID 为共享 ID，媒体字段仅为 aicsync-media:<id>。 */
  data: import('./dramaAssets').DramaAsset;
}
export type SharedSyncPayload = SharedSyncFilePayload | SharedSyncCardPayload;
export interface SharedSyncRevision {
  format: 'ai-canvas-shared-asset';
  version: 1;
  libraryId: string;
  sharedProjectId: string;
  sharedAssetId: string;
  revisionId: string;
  parentRevisionId?: string;
  operationId: string;
  createdAt: number;
  payload: SharedSyncPayload;
  media: SharedSyncMedia[];
}
/** 只用于准备阶段；原生按暂存字节填入 sha256/bytes 后成为不可变版本。 */
export type SharedSyncDraft = Omit<SharedSyncRevision, 'media'> & {
  media: Array<Omit<SharedSyncMedia, 'sha256' | 'bytes'>>;
};
export interface SharedSyncHead {
  sharedAssetId: string;
  kind: SharedSyncAssetKind;
  revisionId: string;
  revisionDigest: string;
  operationId: string;
  updatedAt: number;
  /** 持久删除标记；正常 head 省略。旧待办不得据此重新创建资产。 */
  deleted?: boolean;
}
export interface SharedSyncRemoteAsset {
  head: SharedSyncHead;
  etag: string;
  revision: SharedSyncRevision;
}
export interface SharedSyncBindingIdentity {
  ownerId: string;
  connectionId: string;
  connectionRevision: string;
  libraryId: string;
  sharedProjectId: string;
  /** 缺省仅用于读取早期数据，语义等同 legacy；新操作必须显式携带代次。 */
  generation?: string;
}
export type SharedSyncMemberKind = 'referenceImage' | 'voiceClip' | 'action' | 'actionMedia' | 'imageReference';
export interface SharedSyncMemberMapping {
  kind: SharedSyncMemberKind;
  localId: string;
  sharedId: string;
  /** 动作媒体的父动作本机 ID；其余成员不设置。 */
  parentLocalId?: string;
}
export interface SharedSyncMediaMapping {
  sharedMediaId: string;
  localAssetId: string;
  projectId: string;
  relativePath: string;
  sha256: string;
  bytes: number;
}
export interface SharedAssetMapping extends SharedSyncBindingIdentity {
  id: string;
  kind: SharedSyncAssetKind;
  localEntityId: string;
  sharedAssetId: string;
  members: SharedSyncMemberMapping[];
  media: SharedSyncMediaMapping[];
  acceptedRevisionId?: string;
  acceptedETag?: string;
  /** 去除运行期身份后的规范内容摘要，不等同于媒体 SHA-256。 */
  baselineDigest?: string;
  currentFileAssetId?: string;
  previousFileAssetIds?: string[];
  displayRelativePath?: string;
  updatedAt: number;
}
export type SharedAssetSyncPhase = 'planned' | 'preparing' | 'prepared' | 'uploading' | 'checkingCommit'
  | 'downloading' | 'applying' | 'applied' | 'completed' | 'paused' | 'conflict' | 'failed';
export interface SharedAssetOutboxEntry extends SharedSyncBindingIdentity {
  id: string;
  operationId: string;
  sharedAssetId: string;
  kind: SharedSyncAssetKind;
  direction: 'upload' | 'download';
  revisionId: string;
  baseRevisionId?: string;
  baseETag?: string;
  draft?: SharedSyncDraft;
  revision?: SharedSyncRevision;
  revisionDigest?: string;
  mappingId: string;
  phase: SharedAssetSyncPhase;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}
export interface SharedAssetConflict extends SharedSyncBindingIdentity {
  id: string;
  sharedAssetId: string;
  kind: SharedSyncAssetKind;
  operationId?: string;
  baseRevisionId?: string;
  remoteRevisionId?: string;
  reason: 'bothChanged' | 'headChanged' | 'missingLocal' | 'missingRemote' | 'remoteDeleted' | 'unknownCommit';
  createdAt: number;
}
export interface SharedAssetSyncLocalState {
  mappings: SharedAssetMapping[];
  outbox: SharedAssetOutboxEntry[];
  conflicts: SharedAssetConflict[];
}
export interface SharedSyncRequestContext extends SharedSyncBindingIdentity {
  taskId: string;
}
export interface SharedSyncListResult {
  assets: SharedSyncRemoteAsset[];
  /** 兼容未返回此字段的旧运行时；这些资产不进入下载或自动上传候选。 */
  deletedAssets?: SharedSyncHead[];
  complete: boolean;
  nextCursor?: string;
}
export interface SharedSyncAssetDeletePreviewInput extends SharedSyncRequestContext {
  operationId: string;
  sharedAssetId: string;
  expectedRevisionId: string;
  expectedETag: string;
}
export interface SharedSyncAssetDeletePreview {
  sharedAssetId: string;
  revisionId: string;
  operationId: string;
  previewToken: string;
}
export interface SharedSyncAssetDeleteApplyInput extends SharedSyncRequestContext {
  operationId: string;
  sharedAssetId: string;
  previewToken: string;
}
export interface SharedSyncAssetDeleteResult {
  status: 'deleted' | 'conflict' | 'uncertain';
  sharedAssetId: string;
  operationId: string;
}
export interface SharedSyncPrepareInput extends SharedSyncRequestContext {
  rootDirectory: string;
  draft: SharedSyncDraft;
  baseETag?: string;
  sources: Array<{ mediaId: string; filePath: string }>;
}
export interface SharedSyncPreparedResult {
  revision: SharedSyncRevision;
  revisionDigest: string;
}
export interface SharedSyncOperationInput extends SharedSyncRequestContext {
  operationId: string;
  revisionId: string;
  sharedAssetId: string;
}
export interface SharedSyncPublishResult {
  status: 'published' | 'retryable' | 'conflict' | 'uncertain';
  asset?: SharedSyncRemoteAsset;
  applyToken?: string;
  prepared?: SharedSyncPreparedResult;
}
export interface SharedSyncDownloadInput extends SharedSyncOperationInput {
  rootDirectory: string;
  expectedRevisionDigest: string;
}
export interface SharedSyncDownloadedMedia {
  mediaId: string;
  relativePath: string;
  bytes: number;
  sha256: string;
}
export interface SharedSyncDownloadResult {
  operationId: string;
  revision: SharedSyncRevision;
  revisionDigest: string;
  media: SharedSyncDownloadedMedia[];
  /** 原生绑定/执行材料身份；不是路径授权，不可用于通用文件命令。 */
  applyToken: string;
}
export interface SharedSyncProgress {
  taskId: string;
  ownerId: string;
  operationId: string;
  phase: 'preparing' | 'uploading' | 'downloading' | 'publishing' | 'cleanup';
  transferredBytes: number;
  totalBytes: number;
}
/** 仅用于展示的固定诊断阶段，不包含请求、路径或响应正文。 */
export type SharedSyncErrorStage = 'blobCheck' | 'stagingVerify' | 'multipartCreate' | 'partUpload'
  | 'multipartComplete' | 'blobVerify' | 'revisionWrite' | 'headRead' | 'revisionRead' | 'multipartAbort';
export interface SharedAssetSyncPreviewItem {
  id: string;
  name: string;
  kind: SharedSyncAssetKind;
  direction: 'upload' | 'download' | 'conflict' | 'unchanged' | 'blocked';
  canDelete?: boolean;
  message?: string;
}
export interface SharedAssetSyncStatus {
  ownerId: string;
  stage: 'idle' | 'scanning' | 'preview' | 'syncing' | 'paused' | 'completed' | 'failed';
  items: SharedAssetSyncPreviewItem[];
  completed: number;
  total: number;
  progress?: SharedSyncProgress;
  lastSyncedAt?: number;
  error?: string;
  errorStage?: SharedSyncErrorStage;
}
