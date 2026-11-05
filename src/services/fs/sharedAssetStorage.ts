/** 固定项目云存储 IPC；不提供任意 URL、Header 或对象路径读写。 */
import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv } from './core';
import type {
  BindSharedProjectInput, ProbeSharedProjectInput, SaveSharedStorageConnectionInput,
  SharedAssetStorageSnapshot, SharedProjectBinding, SharedProjectOperationResult,
  SharedStorageCapabilityCheck, SharedStorageCapabilityReport, SharedStorageCheckKind, SharedStorageConnectionInput,
  SharedSyncRequestContext, SharedSyncListResult, SharedSyncPrepareInput, SharedSyncPreparedResult,
  SharedSyncOperationInput, SharedSyncPublishResult, SharedSyncDownloadInput, SharedSyncDownloadResult, SharedSyncRemoteAsset,
  SharedSyncErrorStage, SharedProjectResetMode, SharedProjectResetPreview, SharedProjectResetResult,
  SharedSyncHead, SharedSyncAssetDeletePreviewInput, SharedSyncAssetDeletePreview,
  SharedSyncAssetDeleteApplyInput, SharedSyncAssetDeleteResult,
} from '../../types/assetSync';
import { parseSharedAssetSyncRevision, parseSharedAssetSyncDraft } from '../sharedAssetSyncFormat';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CHECK_KINDS: readonly SharedStorageCheckKind[] = ['list', 'readWrite', 'multipart', 'conditionalCreate', 'conditionalUpdate'];
const SYNC_ERROR_STAGES: readonly SharedSyncErrorStage[] = ['blobCheck', 'stagingVerify', 'multipartCreate', 'partUpload',
  'multipartComplete', 'blobVerify', 'revisionWrite', 'headRead', 'revisionRead', 'multipartAbort'];
const SYNC_COMMANDS = new Set(['project_asset_storage_list_heads', 'project_asset_storage_prepare_publish',
  'project_asset_storage_publish_revision', 'project_asset_storage_recover_operation',
  'project_asset_storage_download_revision', 'project_asset_storage_acknowledge_apply',
  'project_asset_storage_preview_asset_delete', 'project_asset_storage_apply_asset_delete']);
const ERROR_MESSAGES: Record<string, string> = {
  permission_denied: '项目云存储仅允许在主窗口操作',
  access_denied: '云存储访问被拒绝，请检查 Bucket 和项目目录权限',
  authentication_failed: '云存储认证失败，请检查访问凭据和临时令牌是否过期',
  invalid_input: '云存储参数无效，请检查连接信息和共享项目 ID',
  unavailable: '云存储本地配置暂不可用，请稍后重试',
  conflict: '连接或项目绑定已改变，请刷新后重试',
  connection_not_found: '云存储连接已不存在，请重新选择',
  credentials_missing: '请先保存云存储访问凭据',
  connection_in_use: '该连接仍有项目绑定，请先解除本机绑定',
  binding_not_found: '该项目尚未绑定共享项目',
  cancelled: '云存储操作已取消',
  busy: '该项目正在处理云存储操作，请稍后重试',
  network: '云存储请求失败，请检查网络、证书和访问权限',
  project_not_found: '未找到共享项目，请检查共享项目 ID 和连接位置',
  project_mismatch: '远端项目描述与共享项目 ID 不一致，已停止绑定',
  conditional_write_unsupported: '目标存储未通过条件写校验，不能开启多人写入',
  cleanup_pending: '探测已结束，部分测试对象未清理，请检查存储权限',
  cleanup_requires_recreate: '该共享项目状态不兼容，请选择删除共享项目后重新创建',
  response_too_large: '远端项目响应超过允许大小，已停止读取',
  hash_mismatch: '共享素材完整性校验失败，原有资产已保留',
  source_changed: '待同步素材已变化，请重新预览',
  invalid_revision: '共享资产版本无效，已停止同步',
  sync_conflict: '共享资产已有其他修改，请重新预览',
  uncertain: '版本提交结果尚未确认，请恢复核对后再继续',
  apply_expired: '本次资产应用授权已过期，请重新预览',
  operation_not_found: '未找到本次同步执行材料，请重新预览',
  insufficient_space: '可用磁盘空间不足，原有资产已保留',
  file_too_large: '共享素材超过允许大小，已停止传输',
  remote_deleted: '该云端资产已删除，本地资产已保留，请重新预览',
};

export function sharedStorageErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? '云存储操作未完成，请刷新状态后重试';
}

function validateId(value: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(ERROR_MESSAGES.invalid_input);
  return value;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}

export function parseSharedProjectCode(code: string): { libraryId: string; sharedProjectId: string } {
  const parts = code.trim().split('/');
  if (parts.length !== 2) throw new Error(ERROR_MESSAGES.invalid_input);
  return { libraryId: validateId(parts[0]), sharedProjectId: validateId(parts[1]) };
}

function normalizePrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, '');
  if (prefix.length > 256 || /[\\%?#]/.test(prefix) || hasControlCharacters(prefix)
    || prefix.split('/').some((part) => part === '.' || part === '..' || (!part && prefix !== ''))) {
    throw new Error(ERROR_MESSAGES.invalid_input);
  }
  return prefix;
}

export function getSharedProjectPrefix(connection: Pick<SharedStorageConnectionInput, 'rootPrefix'>, libraryId: string, sharedProjectId: string): string {
  const prefix = normalizePrefix(connection.rootPrefix);
  return `${prefix ? `${prefix}/` : ''}libraries/${validateId(libraryId)}/projects/${validateId(sharedProjectId)}`;
}

export function normalizeSharedStorageConnection(input: SharedStorageConnectionInput): SharedStorageConnectionInput {
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint.trim()); } catch { throw new Error(ERROR_MESSAGES.invalid_input); }
  const name = input.name.trim();
  const region = input.region.trim();
  const bucket = input.bucket.trim();
  if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || input.endpoint.length > 2048
    || input.id.length > 100 || !name || Array.from(name).length > 160 || hasControlCharacters(name)
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(region)
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')
    || typeof input.pathStyle !== 'boolean') throw new Error(ERROR_MESSAGES.invalid_input);
  return { id: validateId(input.id), name, endpoint: endpoint.origin, region, bucket, rootPrefix: normalizePrefix(input.rootPrefix), pathStyle: input.pathStyle };
}

function publicReport(report: SharedStorageCapabilityReport): SharedStorageCapabilityReport {
  const checks = CHECK_KINDS.map<SharedStorageCapabilityCheck>((kind) => {
    const matches = report.checks.filter((check) => check.kind === kind);
    const check = matches.length === 1 ? matches[0] : undefined;
    const status = check && ['passed', 'failed', 'notChecked'].includes(check.status) ? check.status : 'notChecked';
    return { kind, status, ...(check?.code ? { code: Object.hasOwn(ERROR_MESSAGES, check.code) ? check.code : 'unknown' } : {}) };
  });
  return {
    checks, checkedAt: report.checkedAt, cleanupPending: report.cleanupPending,
    multiplayerWritable: report.multiplayerWritable && checks.every((check) => check.status === 'passed'),
  };
}

/** 只投影公开字段；即使以后 IPC 加字段，也不会将凭据塞入共享 Store。 */
function publicSnapshot(snapshot: SharedAssetStorageSnapshot): SharedAssetStorageSnapshot {
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error(ERROR_MESSAGES.unavailable);
  return {
    revision: snapshot.revision,
    connections: snapshot.connections.map((item) => ({
      ...normalizeSharedStorageConnection(item), revision: item.revision,
      credentialsSaved: item.credentialsSaved, sessionTokenSaved: item.sessionTokenSaved,
    })),
    bindings: snapshot.bindings.map((item) => ({
      ownerId: item.ownerId, ownerName: item.ownerName, connectionId: item.connectionId,
      connectionRevision: item.connectionRevision, libraryId: item.libraryId, sharedProjectId: item.sharedProjectId,
      projectPrefix: item.projectPrefix, capabilities: publicReport(item.capabilities), updatedAt: item.updatedAt,
    })),
  };
}

function sanitizedStorageFailure(value: unknown): Error {
  // 不保留原始异常作为 cause；它可能包含签名请求、凭据或响应正文。
  const rawCode = value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' ? value.code : 'unknown';
  const code = Object.hasOwn(ERROR_MESSAGES, rawCode) ? rawCode : 'unknown';
  const stage = value && typeof value === 'object' && 'stage' in value && typeof value.stage === 'string'
    && SYNC_ERROR_STAGES.includes(value.stage as SharedSyncErrorStage) ? value.stage as SharedSyncErrorStage : undefined;
  return new Error(sharedStorageErrorMessage(code), { cause: { code, ...(stage ? { stage } : {}) } });
}

export function sharedStorageErrorStage(value: unknown): SharedSyncErrorStage | undefined {
  const cause = value instanceof Error ? value.cause : undefined;
  if (!cause || typeof cause !== 'object' || !('stage' in cause) || typeof cause.stage !== 'string') return undefined;
  return SYNC_ERROR_STAGES.includes(cause.stage as SharedSyncErrorStage) ? cause.stage as SharedSyncErrorStage : undefined;
}

async function nativeCall<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriEnv()) throw new Error('项目云存储需要在 Tauri 桌面端使用');
  try { return await invoke<T>(command, args); } catch (error: unknown) {
    const failure = sanitizedStorageFailure(error);
    if (SYNC_COMMANDS.has(command)) {
      // Only fixed command names and sanitized codes/stages; never log the original error or arguments.
      console.warn('[project-asset-sync] IPC failed', command, failure.cause);
    }
    throw failure;
  }
}

export async function loadSharedStorageSnapshot(): Promise<SharedAssetStorageSnapshot> {
  return publicSnapshot(await nativeCall<SharedAssetStorageSnapshot>('project_asset_storage_snapshot'));
}

export async function saveSharedStorageConnection(input: SaveSharedStorageConnectionInput): Promise<SharedAssetStorageSnapshot> {
  const connection = normalizeSharedStorageConnection(input.connection);
  const credentials = input.credentials;
  if (credentials) {
    const hasKey = credentials.accessKeyId !== undefined;
    const hasSecret = credentials.secretAccessKey !== undefined;
    if (hasKey !== hasSecret || (hasKey && (!credentials.accessKeyId?.trim() || !credentials.secretAccessKey?.trim()))
      || (credentials.clearSessionToken && credentials.sessionToken !== undefined)
      || (credentials.clearCredentials && (hasKey || hasSecret || credentials.sessionToken !== undefined || credentials.clearSessionToken))) {
      throw new Error(ERROR_MESSAGES.invalid_input);
    }
  }
  return publicSnapshot(await nativeCall<SharedAssetStorageSnapshot>('project_asset_storage_save_connection', {
    input: { connection, expectedRevision: input.expectedRevision, credentials },
  }));
}

export async function removeSharedStorageConnection(connectionId: string, expectedRevision: string): Promise<SharedAssetStorageSnapshot> {
  return publicSnapshot(await nativeCall<SharedAssetStorageSnapshot>('project_asset_storage_remove_connection', { connectionId: validateId(connectionId), expectedRevision }));
}

function publicOperation(result: SharedProjectOperationResult): SharedProjectOperationResult {
  return { snapshot: publicSnapshot(result.snapshot), report: publicReport(result.report), bound: result.bound };
}

export async function bindSharedStorageProject(input: BindSharedProjectInput): Promise<SharedProjectOperationResult> {
  [input.taskId, input.ownerId, input.connectionId, input.libraryId, input.sharedProjectId].forEach(validateId);
  if (!['create', 'join'].includes(input.mode)) throw new Error(ERROR_MESSAGES.invalid_input);
  return publicOperation(await nativeCall<SharedProjectOperationResult>('project_asset_storage_bind_project', { input }));
}

export async function probeSharedStorageProject(input: ProbeSharedProjectInput): Promise<SharedProjectOperationResult> {
  validateId(input.taskId); validateId(input.ownerId);
  return publicOperation(await nativeCall<SharedProjectOperationResult>('project_asset_storage_probe_project', { input }));
}

export async function unbindSharedStorageProject(binding: Pick<SharedProjectBinding, 'ownerId' | 'connectionRevision' | 'libraryId' | 'sharedProjectId'>): Promise<SharedAssetStorageSnapshot> {
  return publicSnapshot(await nativeCall<SharedAssetStorageSnapshot>('project_asset_storage_unbind_project', { ...binding }));
}

export async function cancelSharedStorageTask(taskId: string): Promise<void> {
  await nativeCall('project_asset_storage_cancel', { taskId: validateId(taskId) });
}

function syncContext(input: SharedSyncRequestContext): void {
  for (const value of [input.taskId, input.ownerId, input.connectionId, input.libraryId, input.sharedProjectId]) validateId(value);
  if (!input.connectionRevision || input.connectionRevision.length > 256) throw new Error(ERROR_MESSAGES.invalid_input);
  if (input.generation !== undefined) validateId(input.generation);
}
export async function previewSharedProjectReset(input: SharedSyncRequestContext & { mode: SharedProjectResetMode }): Promise<SharedProjectResetPreview> {
  syncContext(input);
  if (!['clear', 'delete'].includes(input.mode)) throw new Error(ERROR_MESSAGES.invalid_input);
  const result = await nativeCall<SharedProjectResetPreview>('project_asset_storage_preview_cleanup', { input });
  if (!result || result.mode !== input.mode || !Number.isSafeInteger(result.objectCount) || result.objectCount < 0
    || !Number.isSafeInteger(result.bytes) || result.bytes < 0 || typeof result.previewToken !== 'string'
    || !result.previewToken || result.previewToken.length > 1024 || hasControlCharacters(result.previewToken)) throw new Error(ERROR_MESSAGES.invalid_revision);
  return { mode: result.mode, objectCount: result.objectCount, bytes: result.bytes, previewToken: result.previewToken };
}
export async function applySharedProjectReset(input: SharedSyncRequestContext & { mode: SharedProjectResetMode; previewToken: string }): Promise<SharedProjectResetResult> {
  syncContext(input);
  if (!['clear', 'delete'].includes(input.mode) || typeof input.previewToken !== 'string' || !input.previewToken
    || input.previewToken.length > 1024 || hasControlCharacters(input.previewToken)) throw new Error(ERROR_MESSAGES.invalid_input);
  const result = await nativeCall<SharedProjectResetResult>('project_asset_storage_apply_cleanup', { input });
  if (!result || !['completed', 'cancelled', 'failed', 'changed'].includes(result.status)
    || !Number.isSafeInteger(result.deletedCount) || !Number.isSafeInteger(result.totalCount)
    || result.deletedCount < 0 || result.totalCount < result.deletedCount
    || (result.errorCode !== undefined && (typeof result.errorCode !== 'string' || result.errorCode.length > 128 || hasControlCharacters(result.errorCode)))) throw new Error(ERROR_MESSAGES.invalid_revision);
  return { status: result.status, deletedCount: result.deletedCount, totalCount: result.totalCount,
    ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}) };
}
function syncOperation(input: SharedSyncOperationInput): void {
  syncContext(input);
  [input.operationId, input.revisionId, input.sharedAssetId].forEach(validateId);
}
function publicRemoteAsset(asset: SharedSyncRemoteAsset, context: SharedSyncRequestContext): SharedSyncRemoteAsset {
  const revision = parseSharedAssetSyncRevision(asset.revision);
  const head = asset.head;
  if (revision.libraryId !== context.libraryId || revision.sharedProjectId !== context.sharedProjectId
    || head.sharedAssetId !== revision.sharedAssetId || head.revisionId !== revision.revisionId
    || head.operationId !== revision.operationId || head.kind !== revision.payload.kind
    || !/^[a-f0-9]{64}$/.test(head.revisionDigest) || !Number.isSafeInteger(head.updatedAt)
    || (head.deleted !== undefined && head.deleted !== false)
    || typeof asset.etag !== 'string' || !asset.etag || asset.etag.length > 1024 || hasControlCharacters(asset.etag)) {
    throw new Error(ERROR_MESSAGES.invalid_revision);
  }
  return { revision, etag: asset.etag, head: { sharedAssetId: head.sharedAssetId, kind: head.kind,
    revisionId: head.revisionId, revisionDigest: head.revisionDigest, operationId: head.operationId, updatedAt: head.updatedAt } };
}
function publicDeletedHead(head: SharedSyncHead): SharedSyncHead {
  if (!head || head.deleted !== true || !['file', 'character', 'scene', 'prop'].includes(head.kind)
    || typeof head.revisionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(head.revisionDigest)
    || !Number.isSafeInteger(head.updatedAt) || head.updatedAt < 0) throw new Error(ERROR_MESSAGES.invalid_revision);
  [head.sharedAssetId, head.revisionId, head.operationId].forEach(validateId);
  return { sharedAssetId: head.sharedAssetId, kind: head.kind, revisionId: head.revisionId,
    revisionDigest: head.revisionDigest, operationId: head.operationId, updatedAt: head.updatedAt, deleted: true };
}
export async function listSharedAssetHeads(input: SharedSyncRequestContext & { cursor?: string }): Promise<SharedSyncListResult> {
  syncContext(input);
  if (input.cursor && (input.cursor.length > 4096 || hasControlCharacters(input.cursor))) throw new Error(ERROR_MESSAGES.invalid_input);
  const result = await nativeCall<SharedSyncListResult>('project_asset_storage_list_heads', { input });
  if (!Array.isArray(result.assets) || result.assets.length > 5000 || typeof result.complete !== 'boolean'
    || result.nextCursor && (typeof result.nextCursor !== 'string' || result.nextCursor.length > 4096 || hasControlCharacters(result.nextCursor))) {
    throw new Error(ERROR_MESSAGES.invalid_revision);
  }
  if (result.deletedAssets !== undefined && (!Array.isArray(result.deletedAssets) || result.deletedAssets.length > 5000)) {
    throw new Error(ERROR_MESSAGES.invalid_revision);
  }
  const assets = result.assets.map((asset) => publicRemoteAsset(asset, input));
  const deletedAssets = (result.deletedAssets ?? []).map(publicDeletedHead);
  const ids = [...assets.map((asset) => asset.head.sharedAssetId), ...deletedAssets.map((head) => head.sharedAssetId)];
  if (new Set(ids).size !== ids.length || ids.length > 5000) throw new Error(ERROR_MESSAGES.invalid_revision);
  return { assets, deletedAssets, complete: result.complete, nextCursor: result.nextCursor };
}
export async function previewSharedAssetDelete(input: SharedSyncAssetDeletePreviewInput): Promise<SharedSyncAssetDeletePreview> {
  syncContext(input);
  [input.operationId, input.sharedAssetId, input.expectedRevisionId].forEach(validateId);
  if (typeof input.expectedETag !== 'string' || !input.expectedETag || input.expectedETag.length > 1024
    || hasControlCharacters(input.expectedETag)) throw new Error(ERROR_MESSAGES.invalid_input);
  const result = await nativeCall<SharedSyncAssetDeletePreview>('project_asset_storage_preview_asset_delete', { input });
  if (!result || result.sharedAssetId !== input.sharedAssetId || result.revisionId !== input.expectedRevisionId
    || result.operationId !== input.operationId || typeof result.previewToken !== 'string' || !result.previewToken
    || result.previewToken.length > 1024 || hasControlCharacters(result.previewToken)) throw new Error(ERROR_MESSAGES.invalid_revision);
  return { sharedAssetId: result.sharedAssetId, revisionId: result.revisionId,
    operationId: result.operationId, previewToken: result.previewToken };
}
export async function applySharedAssetDelete(input: SharedSyncAssetDeleteApplyInput): Promise<SharedSyncAssetDeleteResult> {
  syncContext(input);
  [input.operationId, input.sharedAssetId].forEach(validateId);
  if (typeof input.previewToken !== 'string' || !input.previewToken || input.previewToken.length > 1024
    || hasControlCharacters(input.previewToken)) throw new Error(ERROR_MESSAGES.invalid_input);
  const result = await nativeCall<SharedSyncAssetDeleteResult>('project_asset_storage_apply_asset_delete', { input });
  if (!result || !['deleted', 'conflict', 'uncertain'].includes(result.status) || result.sharedAssetId !== input.sharedAssetId
    || result.operationId !== input.operationId) throw new Error(ERROR_MESSAGES.invalid_revision);
  return { status: result.status, sharedAssetId: result.sharedAssetId, operationId: result.operationId };
}
export async function prepareSharedAssetPublish(input: SharedSyncPrepareInput): Promise<SharedSyncPreparedResult> {
  syncContext(input);
  const draft = parseSharedAssetSyncDraft(input.draft);
  if (draft.libraryId !== input.libraryId || draft.sharedProjectId !== input.sharedProjectId
    || input.sources.length !== draft.media.length) throw new Error(ERROR_MESSAGES.invalid_input);
  const result = await nativeCall<SharedSyncPreparedResult>('project_asset_storage_prepare_publish', { input: { ...input, draft } });
  const revision = parseSharedAssetSyncRevision(result.revision);
  if (revision.operationId !== draft.operationId || revision.revisionId !== draft.revisionId
    || revision.sharedAssetId !== draft.sharedAssetId || revision.libraryId !== input.libraryId
    || revision.sharedProjectId !== input.sharedProjectId || !/^[a-f0-9]{64}$/.test(result.revisionDigest)) throw new Error(ERROR_MESSAGES.invalid_revision);
  return { revision, revisionDigest: result.revisionDigest };
}
async function publishResult(command: string, input: SharedSyncOperationInput): Promise<SharedSyncPublishResult> {
  syncOperation(input);
  const result = await nativeCall<SharedSyncPublishResult>(command, { input });
  if (!['published', 'retryable', 'conflict', 'uncertain'].includes(result.status)) throw new Error(ERROR_MESSAGES.invalid_revision);
  const asset = result.asset ? publicRemoteAsset(result.asset, input) : undefined;
  if (result.status === 'published' && (!asset || asset.revision.sharedAssetId !== input.sharedAssetId)) throw new Error(ERROR_MESSAGES.invalid_revision);
  if (result.applyToken && (typeof result.applyToken !== 'string' || result.applyToken.length > 1024 || hasControlCharacters(result.applyToken))) {
    throw new Error(ERROR_MESSAGES.invalid_revision);
  }
  const prepared = result.prepared ? { revision: parseSharedAssetSyncRevision(result.prepared.revision),
    revisionDigest: result.prepared.revisionDigest } : undefined;
  if (prepared && (!/^[a-f0-9]{64}$/.test(prepared.revisionDigest) || prepared.revision.operationId !== input.operationId
    || prepared.revision.revisionId !== input.revisionId || prepared.revision.sharedAssetId !== input.sharedAssetId
    || prepared.revision.libraryId !== input.libraryId || prepared.revision.sharedProjectId !== input.sharedProjectId)) {
    throw new Error(ERROR_MESSAGES.invalid_revision);
  }
  return { status: result.status, asset, applyToken: result.applyToken, prepared };
}
export const publishSharedAssetRevision = (input: SharedSyncOperationInput): Promise<SharedSyncPublishResult> =>
  publishResult('project_asset_storage_publish_revision', input);
export const recoverSharedAssetOperation = (input: SharedSyncOperationInput): Promise<SharedSyncPublishResult> =>
  publishResult('project_asset_storage_recover_operation', input);

export async function downloadSharedAssetRevision(input: SharedSyncDownloadInput): Promise<SharedSyncDownloadResult> {
  syncOperation(input);
  if (!/^[a-f0-9]{64}$/.test(input.expectedRevisionDigest)) throw new Error(ERROR_MESSAGES.invalid_input);
  const result = await nativeCall<SharedSyncDownloadResult>('project_asset_storage_download_revision', { input });
  if (!result || result.operationId !== input.operationId) throw new Error(ERROR_MESSAGES.invalid_revision);
  const revision = parseSharedAssetSyncRevision(result.revision);
  if (revision.sharedAssetId !== input.sharedAssetId || revision.revisionId !== input.revisionId
    || revision.libraryId !== input.libraryId || revision.sharedProjectId !== input.sharedProjectId
    || result.operationId !== input.operationId || result.revisionDigest !== input.expectedRevisionDigest
    || typeof result.applyToken !== 'string' || !result.applyToken || result.applyToken.length > 1024
    || result.media.length !== revision.media.length) throw new Error(ERROR_MESSAGES.invalid_revision);
  const seen = new Set<string>();
  const media = result.media.map((entry) => {
    const expected = revision.media.find((item) => item.id === entry.mediaId);
    if (!expected || seen.has(entry.mediaId) || entry.bytes !== expected.bytes || entry.sha256 !== expected.sha256
      || !entry.relativePath.startsWith('.shared-sync/files/') || /[\\:%?#]/.test(entry.relativePath)
      || entry.relativePath.split('/').some((part) => !part || part === '.' || part === '..') || hasControlCharacters(entry.relativePath)) {
      throw new Error(ERROR_MESSAGES.invalid_revision);
    }
    seen.add(entry.mediaId);
    return { mediaId: entry.mediaId, relativePath: entry.relativePath, bytes: entry.bytes, sha256: entry.sha256 };
  });
  return { operationId: result.operationId, revision, revisionDigest: result.revisionDigest, media, applyToken: result.applyToken };
}
export async function acknowledgeSharedAssetApply(input: SharedSyncOperationInput & { applyToken?: string; applied: boolean }): Promise<void> {
  syncOperation(input);
  await nativeCall('project_asset_storage_acknowledge_apply', { input });
}
