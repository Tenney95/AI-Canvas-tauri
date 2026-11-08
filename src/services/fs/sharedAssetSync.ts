/** 主窗口的手动共享协调；路径和句柄只在本轮会话中存在。 */
import { exists, lstat, mkdir, remove } from '@tauri-apps/plugin-fs';
import type { Node } from '@xyflow/react';
import type { BaseNodeData, CanvasProject } from '../../types';
import type { DramaAsset, DramaAssetLibrary } from '../../types/dramaAssets';
import { buildDramaActionMentionId, buildDramaMentionId, buildDramaVoiceMentionId, parseDramaMentionId } from '../../types/dramaAssets';
import type { AssetImageRecord } from '../../types/assetImage';
import type { SharedAssetConflict, SharedAssetMapping, SharedAssetOutboxEntry, SharedAssetSyncPreviewItem,
  SharedAssetSyncStatus, SharedProjectBinding, SharedSyncBindingIdentity, SharedSyncDraft, SharedSyncMediaKind,
  SharedSyncMemberKind, SharedSyncOperationInput, SharedSyncPayload, SharedSyncPublishResult,
  SharedSyncRemoteAsset, SharedSyncRevision, SharedSyncHead } from '../../types/assetSync';
import { getAllAssetMeta, getAllProjects, getAssetImageRecords, getAssetIndexById, getAssetMetaById,
  type AssetIndexRecord, type AssetMetaRecord } from '../indexedDbService';
import { loadSharedAssetSyncState, patchSharedAssetSyncOperation, putSharedAssetSyncPlan,
  type SharedAssetSyncCommitInput, type SharedAssetSyncCommitResult } from '../indexedDb/sharedAssetSyncRepository';
import { configValuesEqual } from '../configPatch';
import { getSharedAssetSyncDependencies, mapSharedAssetSyncText, parseSharedAssetSyncDraft, parseSharedAssetSyncRevision,
  restoreSharedAssetSyncText, restoreSharedDramaAsset, serializeSharedDramaAsset } from '../sharedAssetSyncFormat';
import { sha256BytesHex } from '../mediaDataUrl';
import { localMediaUrlToPath } from '../../utils/mediaUrl';
import { preferDramaLibraryReferences } from '../dramaAssetPrompt';
import { copyAssetFileToFolder, listProjectFiles } from '../fileService';
import { getAssetUrlFromPath, getFileCategory, getNativeProjectOwner, getProjectDataDir, joinPath, stripVerbatimPrefix,
  type AssetFileEntry } from './core';
import { getRelativeAssetPath } from './assetIndex';
import { listProjectCatalog } from '../projectModelRouter';
import { projectNativeCatalogEntry, type NativeProjectViewItem } from '../../store/nativeProjectView';
import { scanDirectoryFiles, type AssetScanOptions } from './assetLibrary';
import { prepareSharedAssetImageMetadata, readSharedAssetImageMetadata } from './assetImageMetadata';
import { acknowledgeSharedAssetApply, downloadSharedAssetRevision, listSharedAssetHeads,
  prepareSharedAssetPublish, publishSharedAssetRevision, recoverSharedAssetOperation,
  previewSharedAssetDelete, applySharedAssetDelete } from './sharedAssetStorage';

export interface SharedAssetSyncContext {
  binding: SharedProjectBinding;
  /** 仅由原生 describe 验证的本机持锁操作；恢复时不能预览或执行其他操作。 */
  originProjectId: string;
  projects: readonly Pick<CanvasProject, 'id' | 'parentId'>[];
  library: DramaAssetLibrary;
  nodes: readonly Node<BaseNodeData>[];
  signal?: AbortSignal;
  assertCurrent: () => void;
  onStatus: (status: Partial<SharedAssetSyncStatus>) => void;
  onTask: (taskId: string, active: boolean) => void;
}
interface LocalFile {
  file: AssetFileEntry;
  index: AssetIndexRecord;
  tags: AssetMetaRecord | null;
  image: AssetImageRecord | null;
  imageRecordsSnapshot: AssetImageRecord[];
}
interface Source { mediaId: string; filePath: string; projectId?: string }
interface SessionOperation {
  operation: SharedAssetOutboxEntry;
  mapping: SharedAssetMapping;
  remote?: SharedSyncRemoteAsset;
  local?: LocalFile;
  mediaLocals?: LocalFile[];
  /** 下载应用后仅确认回执；不再次分配文件或卡片身份。 */
  acknowledgeOnly?: boolean;
  resumed?: boolean;
}
export interface SharedAssetSyncSession {
  context: SharedAssetSyncContext;
  expectedLibrary: DramaAssetLibrary;
  rootDirectory: string;
  mappings: SharedAssetMapping[];
  operations: SessionOperation[];
  items: SharedAssetSyncPreviewItem[];
  /** 已核对无需更新的条目，加上本轮已执行完成的操作。 */
  completed: number;
  /** 已核对无需更新的条目与实际待办总数，不含冲突或受阻项。 */
  total: number;
  executing: boolean;
  invalidated?: boolean;
  /** 持久层最后一次已接受的映射，用于准备阶段 CAS。 */
  savedMappings: Map<string, SharedAssetMapping>;
  /** 删除操作只接受本轮原生已核对的 head，不从界面显示名推断身份。 */
  remoteAssets: SharedSyncRemoteAsset[];
  deletedAssets: SharedSyncHead[];
}
export interface SharedAssetSyncExecution {
  applyDownload: (input: { expectedLibrary: DramaAssetLibrary; nextLibrary?: DramaAssetLibrary;
    commit: SharedAssetSyncCommitInput }) => Promise<SharedAssetSyncCommitResult>;
}

const identityKeys = ['ownerId', 'connectionId', 'connectionRevision', 'libraryId', 'sharedProjectId'] as const;
// 原 token 只用于确认已开始的本机事务终态；不持久化，也不用于重新发布或重新应用。
const pendingApplyTokens = new Map<string, string>();
const applyTokenKey = (binding: SharedSyncBindingIdentity, operationId: string) =>
  JSON.stringify([...identityKeys.map((key) => binding[key]), binding.generation ?? 'legacy', operationId]);
const sameProjectBinding = (row: SharedSyncBindingIdentity, binding: SharedSyncBindingIdentity) => identityKeys.every((key) => row[key] === binding[key]);
const sameBinding = (row: SharedSyncBindingIdentity, binding: SharedSyncBindingIdentity) =>
  sameProjectBinding(row, binding) && (row.generation ?? 'legacy') === (binding.generation ?? 'legacy');
const identity = (binding: SharedSyncBindingIdentity): SharedSyncBindingIdentity => ({
  ownerId: binding.ownerId, connectionId: binding.connectionId, connectionRevision: binding.connectionRevision,
  libraryId: binding.libraryId, sharedProjectId: binding.sharedProjectId, generation: binding.generation ?? 'legacy',
});
const pathKey = (path: string) => {
  const value = stripVerbatimPrefix(path).replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(value) || value.startsWith('//') ? value.toLowerCase() : value;
};
const assetKey = (kind: string, localId: string) => `${kind}:${localId}`;
function fileDisplayPath(mapping: SharedAssetMapping, index: AssetIndexRecord): string | undefined {
  const extension = index.path.split('.').at(-1)?.toLowerCase();
  const media = mapping.media.find((entry) => entry.localAssetId === index.assetId);
  const parts = media?.relativePath.split('/');
  // 元数据发布可以推进head而复用旧内容文件；按已登记的物理版本识别宿主文件。
  const managed = media && parts?.length === 5 && parts[0] === '.shared-sync' && parts[1] === 'files'
    && parts[2] === mapping.sharedAssetId && parts[4] === `${media.sharedMediaId}.${extension}`
    && index.relativePath === media.relativePath;
  return managed ? mapping.displayRelativePath ?? index.relativePath : index.relativePath;
}
const flat = (library: DramaAssetLibrary): DramaAsset[] => [...library.characters, ...library.scenes, ...library.props];
const pending = (operation: SharedAssetOutboxEntry) => operation.errorCode === 'ack_pending' || !['completed', 'conflict'].includes(operation.phase);
function guard(context: SharedAssetSyncContext): void { context.signal?.throwIfAborted(); context.assertCurrent(); }
function publicError(error: unknown): string {
  if (error instanceof Error && /^(?:资产|角色|全局|项目|图片|参考图|共享|本次|待同步|素材|未找到|云存储|版本|目标存储|连接|上传|下载)/.test(error.message)
    && !/(?:https?:\/\/|[A-Za-z]:[\\/]|\\\\)/.test(error.message) && error.message.length <= 280) return error.message;
  return '共享资产操作未完成，请重新预览或恢复';
}
function itemFailure(session: SharedAssetSyncSession, item: SessionOperation, error: unknown): Error {
  const raw = session.items.find((row) => row.id === item.mapping.id)?.name ?? itemName(item.mapping, item.operation.revision);
  const unsafeLabel = /(?:[a-z][a-z0-9+.-]*:\/\/|[A-Za-z]:[\\/])/i.test(raw) || /^[\\/]/.test(raw)
    || Array.from(raw).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  const label = unsafeLabel ? '项目资产' : Array.from(raw).slice(0, 48).join('');
  const source = error instanceof Error && error.cause && typeof error.cause === 'object' ? error.cause : {};
  const cause = Object.fromEntries(['code', 'stage', 'reason', 'fieldPath'].flatMap((key) => {
    const value: unknown = Reflect.get(source, key);
    return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.[\]-]{0,159}$/.test(value) ? [[key, value]] : [];
  }));
  return new Error(`${item.operation.direction === 'upload' ? '上传' : '下载'}「${label || '项目资产'}」失败：${publicError(error)}`, { cause });
}
async function native<T>(session: SharedAssetSyncSession, run: (context: SharedSyncBindingIdentity & { taskId: string }) => Promise<T>): Promise<T> {
  guard(session.context);
  const taskId = crypto.randomUUID(); session.context.onTask(taskId, true);
  try { const result = await run({ ...identity(session.context.binding), taskId }); guard(session.context); return result; }
  finally { session.context.onTask(taskId, false); }
}
const operationInput = (context: SharedSyncBindingIdentity & { taskId: string }, operation: SharedAssetOutboxEntry): SharedSyncOperationInput =>
  ({ ...context, operationId: operation.operationId, revisionId: operation.revisionId, sharedAssetId: operation.sharedAssetId });

/** 期限前五秒即停止本地准备和事务；运行期取消器与原生 token 不进入持久层。 */
function localApplyLease(context: SharedAssetSyncContext, token: string) {
  const match = /^([1-9]\d{0,15})\.[a-f0-9]{64}$/.exec(token);
  const expiresAt = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(expiresAt) || expiresAt > Date.now() + 125_000) throw new Error('本次共享资产应用授权无效，请重新预览');
  const controller = new AbortController();
  const expired = () => new Error('本次共享资产应用授权已过期，请重新预览');
  const abort = () => controller.abort(context.signal?.reason ?? new DOMException('共享同步已取消', 'AbortError'));
  context.signal?.addEventListener('abort', abort, { once: true });
  if (context.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(expired()), Math.max(0, expiresAt - 5_000 - Date.now()));
  const dispose = () => { clearTimeout(timer); context.signal?.removeEventListener('abort', abort); };
  const assertCurrent = () => {
    guard(context); controller.signal.throwIfAborted();
    if (Date.now() >= expiresAt - 5_000) throw expired();
  };
  try { assertCurrent(); } catch (error) { dispose(); throw error; }
  return { signal: controller.signal, assertCurrent, dispose };
}

/** 已决定提交／撤销的回执沿用原绑定；即使界面关闭也可以清理本次租约。 */
async function acknowledgeOperation(session: SharedAssetSyncSession, item: SessionOperation, token: string, applied: boolean): Promise<void> {
  const taskId = crypto.randomUUID(); session.context.onTask(taskId, true);
  const key = applyTokenKey(session.context.binding, item.operation.operationId);
  pendingApplyTokens.set(key, token);
  try {
    await acknowledgeSharedAssetApply({ ...operationInput({ ...identity(session.context.binding), taskId }, item.operation), applyToken: token, applied });
    if (pendingApplyTokens.get(key) === token) pendingApplyTokens.delete(key);
  }
  finally { session.context.onTask(taskId, false); }
}

/** 仅事务结束后调用；丢失回执时撤销本机租约，但默认保留远端锁供原操作核对。 */
async function acknowledgeAppliedOperation(session: SharedAssetSyncSession, item: SessionOperation, token: string): Promise<void> {
  try { await acknowledgeOperation(session, item, token, true); }
  catch (error) {
    await acknowledgeOperation(session, item, token, false).catch(() => undefined);
    throw error;
  }
}

/** 只比较业务快照与内容，不把本机时间、操作 ID 或版本封套当作本地编辑。 */
export async function sharedAssetSyncContentDigest(revision: Pick<SharedSyncRevision, 'payload' | 'media'>): Promise<string> {
  const payload = revision.payload.kind === 'file' ? revision.payload : { ...revision.payload, data: {
    ...revision.payload.data, referenceImages: revision.payload.data.referenceImages ?? [],
    ...(revision.payload.data.kind === 'character' ? { voiceClips: revision.payload.data.voiceClips ?? [],
      actions: (revision.payload.data.actions ?? []).map((action) => ({ ...action, media: action.media ?? [] })) } : {}),
  } };
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key, entry]) =>
      !['createdAt', 'updatedAt'].includes(key) && entry !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, clean(entry)]));
    return value;
  };
  return sha256BytesHex(new TextEncoder().encode(JSON.stringify(clean({ payload,
    media: [...revision.media].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0) }))));
}

async function ownerState(projectId: string) {
  const nativeOwner = getNativeProjectOwner(projectId);
  if (nativeOwner) {
    const entry = (await listProjectCatalog()).find((item) => item.dataModel === 'native' && item.project.id === nativeOwner);
    if (!entry || entry.dataModel !== 'native') throw new Error('所属项目已变化，请重新预览');
    const ids = [entry.project.id, ...entry.episodeIds, ...entry.canvasIds];
    if (!ids.includes(projectId)) throw new Error('项目归属已变化，请重新预览');
    return { ownerId: nativeOwner, projectIds: ids, state: await loadSharedAssetSyncState(nativeOwner) };
  }
  const projects = await getAllProjects();
  const project = projects.find((entry) => entry.id === projectId);
  const ownerId = project?.parentId ?? projectId;
  const projectIds = [...new Set([ownerId, projectId, ...projects.filter((entry) => entry.parentId === ownerId).map((entry) => entry.id)])];
  return { ownerId, projectIds, state: await loadSharedAssetSyncState(ownerId) };
}
export async function sharedAssetSyncExcludedPaths(projectId: string): Promise<string[]> {
  const { state } = await ownerState(projectId);
  const root = await getProjectDataDir(projectId);
  if (!root) return [];
  const ids = new Set(state.mappings.flatMap((mapping) => mapping.previousFileAssetIds ?? []));
  const paths: string[] = [];
  for (const assetId of ids) {
    const indexed = await getAssetIndexById(assetId);
    if (indexed?.source === 'project' && getRelativeAssetPath(indexed.path, root)) paths.push(indexed.path);
  }
  return paths;
}

/** 原生下载目录不参加扫描；只有已原子接受的当前文件版本进入资源列表。 */
export async function projectSharedFileView(projectId: string, files: AssetFileEntry[], options: AssetScanOptions = {}): Promise<AssetFileEntry[]> {
  options.signal?.throwIfAborted();
  const { state, projectIds } = await ownerState(projectId);
  const root = await getProjectDataDir(projectId);
  options.signal?.throwIfAborted();
  if (!root) return files;
  const history = new Set(state.mappings.flatMap((mapping) => mapping.previousFileAssetIds ?? []));
  const historyPaths = new Set((await sharedAssetSyncExcludedPaths(projectId)).map(pathKey));
  const current = state.mappings.filter((mapping) => mapping.kind === 'file' && mapping.currentFileAssetId);
  const visible = (file: AssetFileEntry) => (!file.assetId || !history.has(file.assetId)) && !historyPaths.has(pathKey(file.path));
  const projected = new Map(files.filter(visible).map((file) => [pathKey(file.path), file]));
  for (const mapping of current) {
    options.signal?.throwIfAborted();
    const index = await getAssetIndexById(mapping.currentFileAssetId!);
    if (!index || index.source !== 'project' || (getNativeProjectOwner(projectId)
      ? !index.projectId || !projectIds.includes(index.projectId) : index.projectId !== projectId) || index.status !== 'online'
      || !getRelativeAssetPath(index.path, root)) continue;
    try {
      const info = await lstat(index.path);
      if (!info.isFile || info.isSymlink || info.size !== index.size) continue;
      const relativePath = fileDisplayPath(mapping, index);
      const name = relativePath?.split('/').at(-1) ?? index.path.split(/[\\/]/).at(-1)!;
      projected.set(pathKey(index.path), { assetId: index.assetId, name, path: index.path, relativePath,
        assetUrl: await getAssetUrlFromPath(index.path), size: info.size, modifiedAt: info.mtime?.getTime(),
        category: getFileCategory(name), availability: 'online', source: 'project' });
    } catch { options.signal?.throwIfAborted(); /* 缺失文件不能投影为可用。 */ }
  }
  return [...projected.values()].filter(visible);
}

/** 通用流式目录枚举保持原接口；共享版本只在这个适配点过滤和投影。 */
export async function readProjectFiles(projectId: string, options: AssetScanOptions = {}): Promise<AssetFileEntry[]> {
  options.signal?.throwIfAborted();
  const { projectIds } = await ownerState(projectId);
  const excludedFilePaths = [...(options.excludedFilePaths ?? []), ...await sharedAssetSyncExcludedPaths(projectId)];
  const excluded = new Set(excludedFilePaths.map(pathKey));
  options.signal?.throwIfAborted();
  const files = await listProjectFiles(projectId, { ...options, excludedFilePaths, projectIdentityScope: projectIds,
    ...(options.onFiles ? { onFiles: (batch: AssetFileEntry[]) => {
      options.signal?.throwIfAborted();
      const visible = batch.filter((file) => !excluded.has(pathKey(file.path)));
      if (visible.length) options.onFiles?.(visible);
    } } : {}) });
  options.signal?.throwIfAborted();
  return projectSharedFileView(projectId, files, options);
}

/** 同步的完整性扫描属于调度内部，不增加通用文件服务的云专用入口。 */
async function scanProjectFiles(projectId: string, options: AssetScanOptions) {
  options.signal?.throwIfAborted();
  const directory = await getProjectDataDir(projectId);
  options.signal?.throwIfAborted();
  if (!directory) throw new Error('项目素材目录不可用');
  return scanDirectoryFiles(directory, { ...options, source: 'project', projectId,
    excludedRootDirectories: ['.thumbnail'], excludedDirectories: ['AppData', '.trash', '.shared-sync'] });
}

function member(mapping: SharedAssetMapping, kind: SharedSyncMemberKind, value: string, reverse = false, parent?: string): string {
  const matches = mapping.members.filter((item) => item.kind === kind && (reverse ? item.sharedId === value : item.localId === value)
    && (kind !== 'actionMedia' || item.parentLocalId === parent));
  if (matches.length > 1) throw new Error('共享子素材身份存在歧义，请先修复');
  if (matches[0]) return reverse ? matches[0].localId : matches[0].sharedId;
  const localId = reverse ? crypto.randomUUID() : value;
  const sharedId = reverse ? value : crypto.randomUUID();
  mapping.members.push({ kind, localId, sharedId, ...(parent ? { parentLocalId: parent } : {}) });
  return reverse ? localId : sharedId;
}
function allocateCardMembers(mapping: SharedAssetMapping, asset: DramaAsset, reverse = false): void {
  for (const reference of asset.referenceImages ?? []) member(mapping, 'referenceImage', reference.id, reverse);
  if (asset.kind !== 'character') return;
  for (const voice of asset.voiceClips ?? []) member(mapping, 'voiceClip', voice.id, reverse);
  for (const action of asset.actions ?? []) {
    const localActionId = member(mapping, 'action', action.id, reverse);
    for (const item of action.media ?? []) member(mapping, 'actionMedia', item.id, reverse, reverse ? localActionId : action.id);
  }
}
function mention(session: SharedAssetSyncSession, raw: string, reverse = false): string {
  const parsed = parseDramaMentionId(raw);
  if (parsed.assetId.startsWith('global/')) throw new Error('全局资产引用须先物化为项目资产后共享');
  const matches = session.mappings.filter((mapping) => mapping.kind !== 'file'
    && (reverse ? mapping.sharedAssetId === parsed.assetId : mapping.localEntityId === parsed.assetId));
  if (matches.length !== 1) throw new Error('资产引用缺少唯一的共享映射，请先纳入对应项目资产');
  const mapping = matches[0]; const entityId = reverse ? mapping.localEntityId : mapping.sharedAssetId;
  const find = (kind: SharedSyncMemberKind, value: string, parent?: string) => {
    const entries = mapping.members.filter((entry) => entry.kind === kind && (reverse ? entry.sharedId === value : entry.localId === value)
      && (kind !== 'actionMedia' || entry.parentLocalId === parent));
    if (entries.length !== 1) throw new Error('资产子素材引用已失效，请先修复');
    return reverse ? entries[0].localId : entries[0].sharedId;
  };
  if (parsed.voiceClipId !== undefined) return buildDramaVoiceMentionId(entityId, find('voiceClip', parsed.voiceClipId));
  if (parsed.actionId !== undefined) {
    const actionId = find('action', parsed.actionId);
    const localParent = reverse ? actionId : parsed.actionId;
    return buildDramaActionMentionId(entityId, actionId, find('actionMedia', parsed.actionMediaId ?? '', localParent));
  }
  return buildDramaMentionId(entityId, parsed.mergeAll ? 'all' : parsed.referenceImageId !== undefined ? find('referenceImage', parsed.referenceImageId) : undefined);
}

function weaponIdentity(session: SharedAssetSyncSession, raw: string, reverse = false): string {
  if (!reverse && !session.context.library.props.some((asset) => asset.id === raw && asset.propType === 'weapon')) {
    throw new Error('角色绑定的项目武器已失效，请先修复绑定');
  }
  const matches = session.mappings.filter((mapping) => mapping.kind === 'prop'
    && (reverse ? mapping.sharedAssetId === raw : mapping.localEntityId === raw));
  if (matches.length !== 1) throw new Error('角色武器缺少唯一的共享映射，请先纳入对应项目资产');
  if (reverse && !session.expectedLibrary.props.some((asset) => asset.id === matches[0].localEntityId && asset.propType === 'weapon')) {
    throw new Error('角色绑定的项目武器已失效，请先修复绑定');
  }
  return reverse ? matches[0].localEntityId : matches[0].sharedAssetId;
}
function newMapping(binding: SharedProjectBinding, kind: SharedAssetMapping['kind'], localId: string, sharedId: string = crypto.randomUUID()): SharedAssetMapping {
  return { ...identity(binding), id: crypto.randomUUID(), kind, localEntityId: localId, sharedAssetId: sharedId,
    members: [], media: [], updatedAt: Date.now() };
}
function newOperation(mapping: SharedAssetMapping, direction: 'upload' | 'download', remote?: SharedSyncRemoteAsset): SharedAssetOutboxEntry {
  const operationId = crypto.randomUUID();
  return { ...identity(mapping), id: operationId, operationId, mappingId: mapping.id,
    sharedAssetId: mapping.sharedAssetId, kind: mapping.kind, direction, revisionId: remote?.head.revisionId ?? crypto.randomUUID(),
    baseRevisionId: mapping.acceptedRevisionId, baseETag: mapping.acceptedETag,
    ...(remote ? { revision: remote.revision, revisionDigest: remote.head.revisionDigest } : {}),
    phase: 'planned', createdAt: Date.now(), updatedAt: Date.now() };
}
async function persist(session: SharedAssetSyncSession, mapping: SharedAssetMapping, operation?: SharedAssetOutboxEntry, conflicts?: SharedAssetConflict[]): Promise<void> {
  guard(session.context);
  await putSharedAssetSyncPlan({ ownerId: session.context.binding.ownerId, mappings: [mapping], outbox: operation ? [operation] : [],
    expectedMappings: session.savedMappings.has(mapping.id) ? [session.savedMappings.get(mapping.id)!] : [], conflicts });
  session.savedMappings.set(mapping.id, structuredClone(mapping)); guard(session.context);
}
async function conflict(session: SharedAssetSyncSession, mapping: SharedAssetMapping, reason: SharedAssetConflict['reason'], remote?: SharedSyncRemoteAsset,
  operation?: SharedAssetOutboxEntry): Promise<SharedAssetOutboxEntry | undefined> {
  const row: SharedAssetConflict = { ...identity(session.context.binding), id: crypto.randomUUID(), sharedAssetId: mapping.sharedAssetId,
    kind: mapping.kind, operationId: operation?.operationId, baseRevisionId: mapping.acceptedRevisionId,
    remoteRevisionId: remote?.head.revisionId, reason, createdAt: Date.now() };
  await persist(session, mapping, undefined, [row]);
  if (operation) return patchSharedAssetSyncOperation(operation.operationId, { phase: 'conflict', errorCode: 'conflict' });
}
async function operationPhase(item: SessionOperation, phase: SharedAssetOutboxEntry['phase'], extra: Partial<Pick<SharedAssetOutboxEntry, 'revision' | 'revisionDigest' | 'errorCode'>> = {}) {
  item.operation = await patchSharedAssetSyncOperation(item.operation.operationId, { phase, ...extra });
}
async function retainUncertainOperation(item: SessionOperation, result: SharedSyncPublishResult): Promise<void> {
  await operationPhase(item, 'checkingCommit', { errorCode: 'unknown_commit', ...(result.prepared ?? {}) });
}
const uncertainCommitMessage = '版本提交结果尚未确认，请恢复核对后再继续';
function itemName(mapping: SharedAssetMapping, revision?: SharedSyncRevision): string {
  if (revision) return revision.payload.kind === 'file' ? revision.payload.name : revision.payload.data.name;
  return mapping.displayRelativePath?.split('/').at(-1) ?? '项目资产';
}
function previewItem(session: SharedAssetSyncSession, mapping: SharedAssetMapping, name: string, direction: SharedAssetSyncPreviewItem['direction'], message?: string) {
  session.items.push({ id: mapping.id, name, kind: mapping.kind, direction,
    ...(session.remoteAssets.some((asset) => asset.head.sharedAssetId === mapping.sharedAssetId) ? { canDelete: true } : {}),
    ...(message ? { message } : {}) });
  session.context.onStatus({ items: [...session.items] });
}

async function remoteAssets(session: SharedAssetSyncSession): Promise<SharedSyncRemoteAsset[]> {
  const result: SharedSyncRemoteAsset[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const batch = await native(session, (context) => listSharedAssetHeads({ ...context, cursor }));
    result.push(...batch.assets);
    session.deletedAssets.push(...(batch.deletedAssets ?? []));
    if (result.length + session.deletedAssets.length > 5000) throw new Error('共享资产数量超过当前同步上限');
    if (batch.complete) {
      const ids = [...result.map((asset) => asset.head.sharedAssetId), ...session.deletedAssets.map((head) => head.sharedAssetId)];
      if (new Set(ids).size !== ids.length) throw new Error('共享清单身份不唯一，请重新预览');
      return result;
    }
    if (!batch.nextCursor || cursors.has(batch.nextCursor)) throw new Error('共享清单读取不完整，请重新预览');
    cursor = batch.nextCursor; cursors.add(cursor);
  }
  throw new Error('共享清单读取未完成，请缩小项目后重试');
}
async function ensureInputs(session: SharedAssetSyncSession, operation: SharedAssetOutboxEntry): Promise<string> {
  let path = session.rootDirectory;
  for (const segment of ['.shared-sync', 'inputs', operation.operationId]) {
    path = joinPath(path, segment);
    if (!await exists(path)) await mkdir(path);
    const info = await lstat(path);
    if (!info.isDirectory || info.isSymlink) throw new Error('共享暂存目录不可用');
    guard(session.context);
  }
  return path;
}
async function cleanupInputs(session: SharedAssetSyncSession, operation: SharedAssetOutboxEntry): Promise<void> {
  const relative = `.shared-sync/inputs/${operation.operationId}`;
  const path = joinPath(session.rootDirectory, '.shared-sync', 'inputs', operation.operationId);
  if (getRelativeAssetPath(path, session.rootDirectory) !== relative) throw new Error('共享暂存清理位置无效');
  if (!await exists(path)) return;
  for (const candidate of [joinPath(session.rootDirectory, '.shared-sync'), joinPath(session.rootDirectory, '.shared-sync', 'inputs'), path]) {
    const info = await lstat(candidate);
    if (!info.isDirectory || info.isSymlink) throw new Error('共享暂存清理位置已变化');
  }
  guard(session.context);
  await remove(path, { recursive: true });
}
async function prepare(session: SharedAssetSyncSession, item: SessionOperation, draft: SharedSyncDraft, sources: Source[]): Promise<void> {
  await persist(session, item.mapping, { ...item.operation, draft }); item.operation.draft = draft;
  await operationPhase(item, 'preparing');
  const staged: Array<{ mediaId: string; filePath: string }> = [];
  let directory: string | undefined;
  for (const source of sources) {
    guard(session.context);
    let filePath = source.filePath;
    if (source.projectId !== session.context.binding.ownerId || !getRelativeAssetPath(filePath, session.rootDirectory)) {
      directory ??= await ensureInputs(session, item.operation);
      filePath = (await copyAssetFileToFolder(filePath, directory, { signal: session.context.signal, redactErrors: true })).path;
    }
    staged.push({ mediaId: source.mediaId, filePath });
  }
  const result = await native(session, (context) => prepareSharedAssetPublish({ ...context, rootDirectory: session.rootDirectory,
    draft, baseETag: item.operation.baseETag, sources: staged }));
  await operationPhase(item, 'prepared', result);
  // 原生已持有并校验独立快照；跨分集的本轮输入副本不必继续占用项目磁盘。
  await cleanupInputs(session, item.operation);
}

async function discardPrepared(session: SharedAssetSyncSession, item: SessionOperation): Promise<void> {
  await native(session, (context) => acknowledgeSharedAssetApply({ ...operationInput(context, item.operation), applied: false }));
  await operationPhase(item, 'completed');
}

export async function buildSharedAssetSyncPreview(context: SharedAssetSyncContext): Promise<SharedAssetSyncSession> {
  guard(context);
  if (!context.binding.capabilities.multiplayerWritable) throw new Error('目标存储未通过多人条件写校验');
  const ownerId = context.binding.ownerId;
  if (!context.projects.some((project) => {
    if (project.id !== context.originProjectId) return false;
    const native = (project as Partial<NativeProjectViewItem>).nativeView;
    return native ? native.projectId === ownerId && (native.canvasId ?? native.projectId) === project.id
      : (project.parentId ?? project.id) === ownerId;
  })) {
    throw new Error('项目归属已变化，请重新预览');
  }
  const nativeCatalog = getNativeProjectOwner(context.originProjectId) ? await listProjectCatalog() : null;
  const entry = nativeCatalog?.find((row) => row.dataModel === 'native' && row.project.id === ownerId);
  if (nativeCatalog && entry?.dataModel !== 'native') throw new Error('项目归属已变化，请重新预览');
  const rootDirectory = await getProjectDataDir(ownerId);
  if (!rootDirectory) throw new Error('项目素材目录不可用');
  const rootInfo = await lstat(rootDirectory);
  if (!rootInfo.isDirectory || rootInfo.isSymlink) throw new Error('项目素材目录不可用');
  const stored = await loadSharedAssetSyncState(ownerId);
  const session: SharedAssetSyncSession = { context, expectedLibrary: context.library, rootDirectory, mappings:
    structuredClone(stored.mappings.filter((mapping) => sameBinding(mapping, context.binding))), operations: [], items: [],
    completed: 0, total: 0, executing: false, remoteAssets: [], deletedAssets: [],
    savedMappings: new Map(stored.mappings.map((mapping) => [mapping.id, structuredClone(mapping)])) };
  // Keep restored counts visible until local and remote snapshots have been checked.
  context.onStatus({ ownerId, stage: 'scanning', items: [] });
  const remote = await remoteAssets(session); session.remoteAssets = remote;
  const remoteById = new Map(remote.map((asset) => [asset.head.sharedAssetId, asset]));
  const deletedById = new Map(session.deletedAssets.map((head) => [head.sharedAssetId, head]));
  const invalidRemoteDependencies = new Set<string>();
  for (const asset of remote) {
    const payload = asset.revision.payload;
    if (payload.kind !== 'character' || payload.data.kind !== 'character') continue;
    for (const weaponId of payload.data.weaponIds ?? []) {
      const weapon = remoteById.get(weaponId)?.revision.payload;
      if (!weapon || weapon.kind !== 'prop' || weapon.data.kind !== 'prop' || weapon.data.propType !== 'weapon') {
        invalidRemoteDependencies.add(asset.head.sharedAssetId);
      }
    }
  }
  const localCards = flat(context.library);
  for (const asset of localCards) {
    let mapping = session.mappings.find((item) => item.kind === asset.kind && item.localEntityId === asset.id);
    if (!mapping) { mapping = newMapping(context.binding, asset.kind, asset.id); session.mappings.push(mapping); }
    allocateCardMembers(mapping, asset);
  }
  for (const asset of remote) {
    let mapping = session.mappings.find((item) => item.sharedAssetId === asset.head.sharedAssetId);
    if (!mapping) { mapping = newMapping(context.binding, asset.head.kind, crypto.randomUUID(), asset.head.sharedAssetId); session.mappings.push(mapping); }
    if (mapping.kind !== asset.head.kind) throw new Error('共享资产类别已变化，请先修复');
    if (asset.revision.payload.kind !== 'file') allocateCardMembers(mapping, asset.revision.payload.data, true);
    else for (const reference of asset.revision.payload.imageMetadata?.references ?? []) member(mapping, 'imageReference', reference.id, true);
  }
  if (new Set(session.mappings.map((mapping) => mapping.sharedAssetId)).size !== session.mappings.length) throw new Error('共享资产映射存在歧义');
  for (const mapping of session.mappings) {
    await persist(session, mapping);
  }
  const files = new Map<string, LocalFile>();
  const tags = new Map((await getAllAssetMeta()).map((record) => [record.assetId, record]));
  const imageRecords = await getAssetImageRecords(context.signal);
  const projectIds = entry?.dataModel === 'native'
    ? [entry.project.id, ...projectNativeCatalogEntry(entry).map((project) => project.id)]
    : context.projects.filter((project) => project.id === ownerId || project.parentId === ownerId).map((project) => project.id);
  const projectRoots = new Map<string, string>();
  for (const projectId of projectIds) {
    const directory = await getProjectDataDir(projectId);
    if (!directory) throw new Error('项目素材目录不可用');
    projectRoots.set(projectId, directory);
    // 新项目全部逻辑素材根均在作品主根内，重复按画布扫描会重写已有文件归属。
    if (entry?.dataModel === 'native' && projectId !== ownerId) continue;
    const excludedFilePaths = await sharedAssetSyncExcludedPaths(projectId);
    const scan = await scanProjectFiles(projectId, { signal: context.signal, excludedFilePaths, projectIdentityScope: projectIds,
      preserveProjectIdentity: entry?.dataModel === 'native' });
    guard(context);
    if (!scan.complete) throw new Error('项目文件读取不完整，未开始同步，请整理目录后重试');
    // 旧代已接受的文件仍是本地资产；只借其文件投影，不能沿用旧代共享身份或基线。
    const visibleFiles = await projectSharedFileView(projectId, scan.files, { signal: context.signal });
    guard(context);
    for (const file of visibleFiles) {
      if (!file.assetId || file.source !== 'project' || !['image', 'audio', 'video'].includes(file.category)) continue;
      const index = await getAssetIndexById(file.assetId);
      if (!index || index.source !== 'project' || !index.projectId || !projectIds.includes(index.projectId)
        || index.status !== 'online' || pathKey(index.path) !== pathKey(file.path)) throw new Error('项目文件身份已变化，请重新预览');
      files.set(pathKey(file.path), { file, index, tags: tags.get(file.assetId) ?? null, image: null,
        imageRecordsSnapshot: structuredClone(imageRecords.filter((record) => record.assetId === index.assetId)) });
    }
  }
  const fileById = new Map([...files.values()].map((file) => [file.index.assetId, file]));
  for (const local of files.values()) {
    if (!session.mappings.some((mapping) => mapping.kind === 'file'
      && (mapping.currentFileAssetId === local.index.assetId || mapping.localEntityId === local.index.assetId))) {
      const mapping = newMapping(context.binding, 'file', local.index.assetId);
      mapping.currentFileAssetId = local.index.assetId; mapping.displayRelativePath = local.file.relativePath ?? local.file.name;
      session.mappings.push(mapping);
    }
  }
  // 卡片下载媒体只加入本轮闭包解析；不把隐藏媒体重新发布成独立文件条目。
  // 旧代映射只提供已保留的本机子素材路径，不参与新代身份、待办或冲突决策。
  const localMediaMappings = [...stored.mappings.filter((mapping) => sameProjectBinding(mapping, context.binding)), ...session.mappings];
  for (const mapping of localMediaMappings) for (const media of mapping.media) {
    if (fileById.has(media.localAssetId)) continue;
    const index = await getAssetIndexById(media.localAssetId);
    if (!index || index.source !== 'project' || !index.projectId || !projectRoots.has(index.projectId)
      || index.status !== 'online' || !getRelativeAssetPath(index.path, projectRoots.get(index.projectId)!)) continue;
    const info = await lstat(index.path).catch(() => undefined);
    guard(context);
    if (!info?.isFile || info.isSymlink || info.size !== index.size) continue;
    const category = getFileCategory(index.path);
    if (!['image', 'audio', 'video'].includes(category)) continue;
    const currentFile = mapping.kind === 'file' && mapping.currentFileAssetId === index.assetId;
    const relativePath = currentFile ? fileDisplayPath(mapping, index) : index.relativePath;
    const name = relativePath?.split('/').at(-1) ?? index.path.split(/[\\/]/).at(-1)!;
    const local: LocalFile = { index, tags: tags.get(index.assetId) ?? null, image: null,
      imageRecordsSnapshot: structuredClone(imageRecords.filter((record) => record.assetId === index.assetId)), file: {
      assetId: index.assetId, name, path: index.path, relativePath,
      category, size: info.size, source: 'project', availability: 'online' } };
    fileById.set(index.assetId, local); files.set(pathKey(index.path), local);
  }
  // 旧版将未知提交写成终态冲突；仅恢复其原待办身份，不创建替代版本或推断已清理。
  const unresolvedUnknown = new Set<string>();
  for (const row of stored.conflicts.filter((row) => sameBinding(row, context.binding) && row.reason === 'unknownCommit')) {
    const operation = stored.outbox.find((operation) => sameBinding(operation, context.binding)
      && operation.operationId === row.operationId && operation.sharedAssetId === row.sharedAssetId);
    if (!operation) { unresolvedUnknown.add(row.sharedAssetId); continue; }
    if (operation.phase === 'conflict' && operation.errorCode !== 'conflict') Object.assign(operation,
      await patchSharedAssetSyncOperation(operation.operationId, { phase: 'checkingCommit', errorCode: 'unknown_commit' }));
  }
  const livePending = stored.outbox.filter((operation) => sameBinding(operation, context.binding) && pending(operation));
  const mapProjectNodeReferences = (value: string) => {
    // 只复用本轮已验证为项目媒体的节点，不读取全局库或为提示词另扩文件闭包。
    const projectNodes = context.nodes.filter((node) => {
      const imagePath = localMediaUrlToPath(node.data.imageUrl || node.data.thumbnailUrl);
      const sourcePath = node.data.filePath || imagePath;
      return sourcePath && files.get(pathKey(sourcePath))?.file.category === 'image'
        && (!imagePath || pathKey(imagePath) === pathKey(sourcePath));
    });
    return preferDramaLibraryReferences(value, projectNodes, context.library, []);
  };
  const pendingByAsset = new Map<string, SharedAssetOutboxEntry>();
  for (const operation of livePending) {
    if (pendingByAsset.has(operation.sharedAssetId)) throw new Error('共享资产存在多笔未完成操作，请先恢复');
    pendingByAsset.set(operation.sharedAssetId, operation);
  }
  for (const mapping of session.mappings) {
    guard(context);
    const cloud = remoteById.get(mapping.sharedAssetId);
    const card = localCards.find((asset) => assetKey(asset.kind, asset.id) === assetKey(mapping.kind, mapping.localEntityId));
    const local = mapping.kind === 'file' ? fileById.get(mapping.currentFileAssetId ?? mapping.localEntityId) : undefined;
    const deleted = deletedById.get(mapping.sharedAssetId);
    if (deleted) {
      const interrupted = stored.outbox.filter((operation) => sameBinding(operation, context.binding)
        && operation.sharedAssetId === mapping.sharedAssetId && pending(operation));
      let receiptPending = false, receiptNeedsRestart = false;
      for (const operation of interrupted) {
        // 本地已提交的结果不倒退；只终止旧回执恢复，未提交的候选才进入冲突。
        if (['applied', 'completed'].includes(operation.phase)) {
          const key = applyTokenKey(context.binding, operation.operationId);
          const retained = pendingApplyTokens.get(key);
          if (!retained) receiptNeedsRestart = true;
          else {
            try { await acknowledgeAppliedOperation(session, { operation, mapping }, retained); }
            catch {
              guard(context);
              // ACK false 成功也已权威释放本机锁；双失败不能假装这笔回执已完成。
              if (pendingApplyTokens.has(key)) { receiptPending = true; continue; }
            }
          }
        }
        await patchSharedAssetSyncOperation(operation.operationId, {
          phase: ['applied', 'completed'].includes(operation.phase) ? 'completed' : 'conflict', errorCode: 'remote_deleted' });
        guard(context);
      }
      const prior = stored.conflicts.find((row) => sameBinding(row, context.binding) && row.sharedAssetId === mapping.sharedAssetId
        && row.reason === 'remoteDeleted' && row.remoteRevisionId === deleted.revisionId && row.baseRevisionId === mapping.acceptedRevisionId);
      await persist(session, mapping, undefined, [prior ?? { ...identity(context.binding), id: crypto.randomUUID(),
        sharedAssetId: mapping.sharedAssetId, kind: mapping.kind, baseRevisionId: mapping.acceptedRevisionId,
        remoteRevisionId: deleted.revisionId, reason: 'remoteDeleted', createdAt: Date.now() }]);
      previewItem(session, mapping, card?.name ?? local?.file.name ?? itemName(mapping), 'conflict',
        receiptPending ? '云端资产已删除，本机内容已保留；原操作回执尚未释放，请重新预览核对'
          : receiptNeedsRestart ? '云端资产已删除，本机内容已保留，请重启应用后继续同步'
          : '云端资产已删除，本机内容已保留；旧同步不会重新上传，请先处理删除冲突');
      continue;
    }
    let previous = pendingByAsset.get(mapping.sharedAssetId);
    const invalidRemote = invalidRemoteDependencies.has(mapping.sharedAssetId);
    const acknowledgeOnly = previous?.phase === 'applied' || previous?.errorCode === 'ack_pending';
    const missingRemoteDependency = '共享角色的武器依赖缺失或类型不符，请先处理对应武器；本机内容已保留';
    // 不采用缺依赖的云端版本；完整的本机修复候选仍走下面原有的比较和并发冲突判断。
    if (invalidRemote && !acknowledgeOnly && ((!card && !local) || previous?.direction === 'download')) {
      previewItem(session, mapping, card?.name ?? itemName(mapping, cloud?.revision), 'blocked',
        missingRemoteDependency);
      continue;
    }
    if (unresolvedUnknown.has(mapping.sharedAssetId)) {
      previewItem(session, mapping, card?.name ?? local?.file.name ?? itemName(mapping, cloud?.revision), 'blocked', uncertainCommitMessage);
      continue;
    }
    if (previous?.direction === 'upload' && previous.phase === 'paused' && previous.errorCode === 'dependency_missing') {
      const blockedOperation = previous;
      try {
        // Renderer 不能推断候选从未发出；由原生确认 journal 无远端副作用并清理成功后才换身份。
        await discardPrepared(session, { operation: blockedOperation, mapping, remote: cloud, local });
        previous = undefined;
      } catch (error) {
        guard(context);
        previewItem(session, mapping, card?.name ?? itemName(mapping, blockedOperation.revision), 'blocked', publicError(error));
        continue;
      }
    }
    if (previous) {
      if (previous.errorCode === 'locked_conflict') {
        previewItem(session, mapping, card?.name ?? local?.file.name ?? itemName(mapping, cloud?.revision), 'conflict', '共享候选版本冲突，需确认后处理原同步');
        continue;
      }
      const item: SessionOperation = { operation: previous, mapping, remote: cloud, local,
        mediaLocals: mapping.kind === 'file' ? undefined : mapping.media.flatMap((media) => {
          const source = fileById.get(media.localAssetId); return source ? [source] : [];
        }), acknowledgeOnly: previous.phase === 'applied' || previous.errorCode === 'ack_pending', resumed: true };
      try {
        if (local?.file.category === 'image') local.image = (await readSharedAssetImageMetadata(local.file, local.index.projectId!, context.signal, imageRecords))?.record ?? null;
        if (previous.direction === 'upload' && !previous.revision) {
          try {
            const recovered = await native(session, (request) => recoverSharedAssetOperation(operationInput(request, previous)));
            if (recovered.status === 'uncertain') {
              await retainUncertainOperation(item, recovered);
            } else if (recovered.status === 'conflict') {
              await conflict(session, mapping, 'headChanged', recovered.asset, item.operation);
              previewItem(session, mapping, itemName(mapping, previous.revision), 'conflict', '共享候选版本存在冲突，请恢复核对');
              continue;
            } else if (recovered.status === 'retryable' && recovered.prepared) {
              await operationPhase(item, 'prepared', { ...recovered.prepared, errorCode: undefined });
              await cleanupInputs(session, item.operation);
            }
            else if (recovered.status === 'published' && recovered.asset) {
              await operationPhase(item, 'checkingCommit', { revision: recovered.asset.revision, revisionDigest: recovered.asset.head.revisionDigest, errorCode: undefined });
              // 预览不应用结果，只释放本次读取取得的本机租约。
              if (recovered.applyToken) await acknowledgeOperation(session, item, recovered.applyToken, false);
            } else throw new Error('共享候选版本存在冲突，请恢复核对');
          } catch (error) {
            if (!(error instanceof Error && error.cause && typeof error.cause === 'object'
              && 'code' in error.cause && error.cause.code === 'operation_not_found') || !previous.draft) throw error;
            const sources: Source[] = [];
            const savedImage = local?.file.category === 'image'
              ? await readSharedAssetImageMetadata(local.file, local.index.projectId!, context.signal, imageRecords) : null;
            for (const media of previous.draft.media) {
              const binding = mapping.media.find((entry) => entry.sharedMediaId === media.id);
              if (!binding) throw new Error('未找到上次固定版本的媒体身份', { cause: error });
              if (binding.localAssetId.startsWith('image-reference:')) {
                const reference = savedImage?.references.find((entry) => `image-reference:${entry.id}` === binding.localAssetId);
                if (!reference) throw new Error('图片专属引用已变化，请先处理未完成版本', { cause: error });
                sources.push({ mediaId: media.id, filePath: reference.filePath });
              } else {
                const file = fileById.get(binding.localAssetId);
                if (!file) throw new Error('待恢复媒体已缺失，请先修复本地资产', { cause: error });
                sources.push({ mediaId: media.id, filePath: file.index.path, projectId: file.index.projectId });
              }
            }
            await prepare(session, item, previous.draft, sources);
          }
        }
        session.operations.push(item);
        previewItem(session, mapping, itemName(mapping, item.operation.revision), previous.direction,
          item.operation.errorCode === 'unknown_commit' ? uncertainCommitMessage : '恢复上次固定版本的未完成操作');
      } catch (error) {
        guard(context); previewItem(session, mapping, itemName(mapping, previous.revision), 'blocked', publicError(error));
      }
      continue;
    }
    if (!card && !local) {
      if (cloud && !mapping.acceptedRevisionId) {
        const operation = newOperation(mapping, 'download', cloud); await persist(session, mapping, operation);
        session.operations.push({ operation, mapping, remote: cloud }); previewItem(session, mapping, itemName(mapping, cloud.revision), 'download');
      } else if (mapping.acceptedRevisionId) {
        await conflict(session, mapping, 'missingLocal', cloud);
        previewItem(session, mapping, itemName(mapping, cloud?.revision), 'conflict', '本地资产缺失，保留云端和旧版本，不传播删除');
      }
      continue;
    }
    if (mapping.acceptedRevisionId && !cloud) {
      await conflict(session, mapping, 'missingRemote');
      previewItem(session, mapping, card?.name ?? local!.file.name, 'conflict', '云端资产缺失，不自动重建或传播删除'); continue;
    }
    const operation = newOperation(mapping, 'upload'); const item: SessionOperation = { operation, mapping, remote: cloud, local };
    try {
      const sources: Source[] = []; const media: SharedSyncDraft['media'] = [];
      const mediaLocals = new Map<string, LocalFile>();
      const allocateMedia = (source: LocalFile | { path: string; id: string }, kind: SharedSyncMediaKind): string => {
        if ('index' in source) mediaLocals.set(source.index.assetId, source);
        const sourceId = 'index' in source ? source.index.assetId : source.id;
        const existing = mapping.media.find((entry) => entry.localAssetId === sourceId);
        const mediaId = existing?.sharedMediaId ?? crypto.randomUUID();
        if (media.some((entry) => entry.id === mediaId)) {
          if (media.find((entry) => entry.id === mediaId)!.kind !== kind) throw new Error('同一项目文件的媒体用途不一致');
          return mediaId;
        }
        const path = 'index' in source ? source.index.path : source.path;
        const extension = path.split('.').at(-1)?.toLowerCase();
        if (!extension || !/^[a-z0-9]{1,8}$/.test(extension)) throw new Error('项目文件容器类型无效');
        media.push({ id: mediaId, kind, extension }); sources.push({ mediaId, filePath: path,
          ...('index' in source ? { projectId: source.index.projectId } : {}) });
        if (!existing) mapping.media.push({ sharedMediaId: mediaId, localAssetId: sourceId,
          projectId: 'index' in source ? source.index.projectId! : ownerId,
          relativePath: 'index' in source ? source.index.relativePath! : '', sha256: '', bytes: 0 });
        return mediaId;
      };
      let payload: SharedSyncPayload;
      if (card) {
        payload = await serializeSharedDramaAsset(card, mapping.sharedAssetId, {
          memberId: (kind, localId, parent) => member(mapping, kind, localId, false, parent),
          mapMentionId: (value) => mention(session, value),
          mapWeaponId: (value) => weaponIdentity(session, value),
          mapProjectNodeReferences,
          mediaId: async (source) => {
            if (source.assetSource === 'global') throw new Error('全局参考图须先物化为项目资产后共享');
            let found: LocalFile | undefined;
            if (source.sourceNodeId) {
              const node = context.nodes.find((node) => node.id === source.sourceNodeId);
              const output = source.kind === 'audio' ? node?.data.audioUrl : node?.data.imageUrl ?? node?.data.thumbnailUrl;
              const path = node?.data.filePath ?? localMediaUrlToPath(output);
              if (path) {
                found = files.get(pathKey(path));
                if (!found && output) throw new Error('资产来源节点的新媒体尚未完整落盘，请稍后重新预览');
              } else if (output) throw new Error('资产来源节点的新媒体尚未完整落盘，请稍后重新预览');
            }
            found ??= source.assetId ? fileById.get(source.assetId) : undefined;
            if (!found && source.assetId) {
              const index = await getAssetIndexById(source.assetId);
              if (!index || index.source !== 'project' || !index.projectId || !projectRoots.has(index.projectId)
                || index.status !== 'online' || !getRelativeAssetPath(index.path, projectRoots.get(index.projectId)!)) {
                throw new Error('资产媒体不属于当前项目，不能借同名文件或旧地址恢复');
              }
              const info = await lstat(index.path);
              if (!info.isFile || info.isSymlink || info.size !== index.size) throw new Error('资产媒体已变化，请先修复身份');
              found = { index, tags: tags.get(index.assetId) ?? null, image: null,
                imageRecordsSnapshot: structuredClone(imageRecords.filter((record) => record.assetId === index.assetId)), file: {
                assetId: index.assetId, path: index.path, name: index.path.split(/[\\/]/).at(-1)!,
                relativePath: index.relativePath, category: getFileCategory(index.path), size: info.size, source: 'project' } };
              fileById.set(index.assetId, found); files.set(pathKey(index.path), found);
            }
            const path = source.filePath ?? localMediaUrlToPath(source.url)
              ?? (source.relativePath ? joinPath(rootDirectory, source.relativePath) : undefined);
            found ??= path ? files.get(pathKey(path)) : undefined;
            if (!found || found.file.category !== source.kind) throw new Error('资产媒体尚未完整落入本项目，请先修复或复制素材');
            return allocateMedia(found, source.kind);
          },
        });
      } else {
        const file = local!;
        const saved = file.file.category === 'image' ? await readSharedAssetImageMetadata(file.file, file.index.projectId!, context.signal, imageRecords) : null;
        file.image = saved?.record ?? null;
        payload = { kind: 'file', name: file.file.name, displayRelativePath: fileDisplayPath(mapping, file.index) ?? file.file.relativePath ?? file.file.name,
          mediaId: allocateMedia(file, file.file.category as SharedSyncMediaKind), tags: [...(file.tags?.tags ?? [])],
          ...(file.tags?.taggedBy ? { taggedBy: file.tags.taggedBy } : {}),
          ...(saved ? { imageMetadata: { prompt: mapSharedAssetSyncText(saved.record.prompt, (value) => mention(session, value), mapProjectNodeReferences),
            references: saved.references.map((reference) => ({ id: member(mapping, 'imageReference', reference.id), name: reference.name,
              mediaId: allocateMedia({ path: reference.filePath, id: `image-reference:${reference.id}` }, 'image') })) } } : {}) };
      }
      const draft = parseSharedAssetSyncDraft({ format: 'ai-canvas-shared-asset', version: 1,
        libraryId: context.binding.libraryId, sharedProjectId: context.binding.sharedProjectId,
        sharedAssetId: mapping.sharedAssetId, revisionId: operation.revisionId, parentRevisionId: operation.baseRevisionId,
        operationId: operation.operationId, createdAt: operation.createdAt, payload, media });
      item.mediaLocals = [...mediaLocals.values()];
      await prepare(session, item, draft, sources);
      const digest = await sharedAssetSyncContentDigest(item.operation.revision!);
      const cloudDigest = cloud ? await sharedAssetSyncContentDigest(cloud.revision) : undefined;
      const cloudChanged = cloud && cloud.head.revisionId !== mapping.acceptedRevisionId;
      if (cloudChanged && digest !== mapping.baselineDigest && digest !== cloudDigest) {
        await conflict(session, mapping, 'bothChanged', cloud, item.operation);
        previewItem(session, mapping, card?.name ?? local!.file.name, 'conflict', '本地和云端均已修改，保留两个候选版本');
      } else if (cloudChanged) {
        await discardPrepared(session, item);
        if (invalidRemote) {
          previewItem(session, mapping, card?.name ?? local!.file.name, 'blocked', missingRemoteDependency);
          continue;
        }
        const download = newOperation(mapping, 'download', cloud); await persist(session, mapping, download);
        session.operations.push({ operation: download, mapping, remote: cloud, local, mediaLocals: item.mediaLocals });
        previewItem(session, mapping, card?.name ?? local!.file.name, 'download');
      } else if (mapping.baselineDigest === digest && cloud) {
        await discardPrepared(session, item); previewItem(session, mapping, card?.name ?? local!.file.name,
          invalidRemote ? 'blocked' : 'unchanged', invalidRemote ? missingRemoteDependency : undefined);
      } else {
        session.operations.push(item); previewItem(session, mapping, card?.name ?? local!.file.name, 'upload');
      }
    } catch (error) {
      guard(context);
      if (session.savedMappings.has(mapping.id)) {
        const state = await loadSharedAssetSyncState(ownerId);
        if (state.outbox.some((entry) => entry.operationId === operation.operationId && pending(entry))) {
          await patchSharedAssetSyncOperation(operation.operationId, { phase: 'paused', errorCode: 'prepare_failed' });
        }
      }
      previewItem(session, mapping, card?.name ?? local?.file.name ?? '项目资产', 'blocked', publicError(error));
    }
  }
  guard(context);
  // 新卡片的引用不能指向本轮已阻塞且从未发布的另一张卡片。
  let dependenciesChanged = true;
  while (dependenciesChanged) {
    dependenciesChanged = false;
    const publishing = new Set(session.operations.filter((item) => item.operation.direction === 'upload').map((item) => item.mapping.sharedAssetId));
    for (const item of [...session.operations]) {
      if (item.acknowledgeOnly) continue;
      const payload = item.operation.revision?.payload ?? item.operation.draft?.payload;
      if (!payload) continue;
      const unresolved = getSharedAssetSyncDependencies(payload).some((sharedId) => {
        return !remoteById.has(sharedId) && !publishing.has(sharedId);
      });
      const missingLocalWeapon = item.operation.direction === 'download' && payload.kind === 'character'
        && payload.data.kind === 'character' && (payload.data.weaponIds ?? []).some((sharedId) => {
          const target = session.mappings.find((mapping) => mapping.kind === 'prop' && mapping.sharedAssetId === sharedId);
          if (target && session.expectedLibrary.props.some((asset) => asset.id === target.localEntityId && asset.propType === 'weapon')) return false;
          return !session.operations.some((entry) => {
            const dependency = entry.operation.revision?.payload ?? entry.operation.draft?.payload;
            return entry.operation.direction === 'download' && !entry.acknowledgeOnly && entry.mapping.sharedAssetId === sharedId
              && dependency?.kind === 'prop' && dependency.data.kind === 'prop' && dependency.data.propType === 'weapon';
          });
        });
      if (!unresolved && !missingLocalWeapon) continue;
      const uncertain = ['unknown_commit', 'locked_conflict'].includes(item.operation.errorCode ?? '');
      if (!uncertain) await operationPhase(item, 'paused', { errorCode: 'dependency_missing' });
      session.operations = session.operations.filter((entry) => entry !== item); dependenciesChanged = true;
      session.items = session.items.map((entry) => entry.id === item.mapping.id ? { ...entry, direction: 'blocked',
        message: uncertain ? uncertainCommitMessage : '引用的项目资产尚未成功纳入共享，请先修复对应资产' } : entry);
    }
  }
  const unresolved = session.items.some((item) => item.direction === 'blocked' || item.direction === 'conflict');
  // 先发布／下载武器，再提交引用它的角色，取消后也不会留下未发布的武器依赖。
  const weaponPriority = (item: SessionOperation) => {
    const payload = item.operation.revision?.payload ?? item.operation.draft?.payload;
    return payload?.kind === 'prop' && payload.data.kind === 'prop' && payload.data.propType === 'weapon' ? 0 : 1;
  };
  session.operations.sort((left, right) => weaponPriority(left) - weaponPriority(right));
  session.completed = session.items.filter((item) => item.direction === 'unchanged').length;
  session.total = session.completed + session.operations.length;
  context.onStatus({ stage: session.operations.length ? 'preview' : unresolved ? 'paused' : 'completed',
    items: [...session.items], completed: session.completed, total: session.total,
    ...(!session.operations.length && !unresolved ? { lastSyncedAt: Date.now() } : {}) });
  return session;
}

async function verifyLocal(item: SessionOperation, session: SharedAssetSyncSession, assertCurrent = () => guard(session.context), signal = session.context.signal): Promise<void> {
  assertCurrent();
  if (!item.local) return;
  const { index, file, tags, image } = item.local;
  const info = await lstat(index.path);
  assertCurrent();
  const currentTags = (await getAssetMetaById(index.assetId)) ?? null;
  assertCurrent();
  if (!info.isFile || info.isSymlink || info.size !== index.size || (info.mtime?.getTime() ?? 0) !== index.mtimeMs
    || !configValuesEqual(currentTags, tags)) throw new Error('项目文件或标签已变化，请重新预览');
  if (file.category === 'image' && image) {
    const current = await readSharedAssetImageMetadata(file, index.projectId!, signal);
    assertCurrent();
    if (!configValuesEqual(current?.record ?? null, image)) throw new Error('图片专属信息已变化，请重新预览');
  }
  const records = (await getAssetImageRecords(signal)).filter((record) => record.assetId === index.assetId);
  assertCurrent();
  if (!configValuesEqual(records, item.local.imageRecordsSnapshot)) throw new Error('图片专属信息已变化，请重新预览');
}
function localBaselines(item: SessionOperation): LocalFile[] {
  return [...new Map([...(item.local ? [item.local] : []), ...(item.mediaLocals ?? [])]
    .map((file) => [file.index.assetId, file])).values()];
}
async function rejectAlreadyApplied(session: SharedAssetSyncSession, item: SessionOperation): Promise<never> {
  session.invalidated = true;
  const stored = await loadSharedAssetSyncState(session.context.binding.ownerId);
  const accepted = stored.outbox.find((entry) => entry.operationId === item.operation.operationId);
  if (accepted) item.operation = accepted;
  throw new Error('共享操作已由其他实例应用，请重新打开项目后预览');
}
function replaceCard(library: DramaAssetLibrary, asset: DramaAsset): DramaAssetLibrary {
  const key = asset.kind === 'character' ? 'characters' : asset.kind === 'scene' ? 'scenes' : 'props';
  const current = library[key] as DramaAsset[];
  return { ...library, [key]: current.some((item) => item.id === asset.id) ? current.map((item) => item.id === asset.id ? asset : item) : [...current, asset] };
}
function mediaMapping(mapping: SharedAssetMapping, revision: SharedSyncRevision): SharedAssetMapping {
  const next = structuredClone(mapping);
  for (const media of revision.media) {
    const entry = next.media.find((entry) => entry.sharedMediaId === media.id);
    if (entry) { entry.sha256 = media.sha256; entry.bytes = media.bytes; }
  }
  return next;
}

async function acceptPublished(session: SharedAssetSyncSession, item: SessionOperation, result: SharedSyncPublishResult,
  execution: SharedAssetSyncExecution): Promise<void> {
  const published = result.asset;
  if (!published || published.head.revisionId !== item.operation.revisionId || !result.applyToken) throw new Error('版本提交结果尚未确认，请恢复核对');
  let lease: ReturnType<typeof localApplyLease> | undefined;
  let committed = false;
  try {
    lease = localApplyLease(session.context, result.applyToken);
    const revision = parseSharedAssetSyncRevision(published.revision);
    const next = mediaMapping(item.mapping, revision);
    next.acceptedRevisionId = revision.revisionId; next.acceptedETag = published.etag;
    if (revision.payload.kind === 'file') next.displayRelativePath = revision.payload.displayRelativePath;
    next.baselineDigest = await sharedAssetSyncContentDigest(revision); next.updatedAt = Date.now();
    lease.assertCurrent();
    item.operation = await patchSharedAssetSyncOperation(item.operation.operationId, { phase: 'checkingCommit',
      revision, revisionDigest: published.head.revisionDigest });
    lease.assertCurrent();
    const commitOperation = { ...item.operation, errorCode: 'ack_pending' };
    const baselines = localBaselines(item);
    for (const local of baselines) await verifyLocal({ ...item, local }, session, lease.assertCurrent, lease.signal);
    lease.assertCurrent();
    const commitResult = await execution.applyDownload({ expectedLibrary: session.expectedLibrary, commit: { ownerId: next.ownerId,
      operationId: item.operation.operationId, operation: commitOperation, mappings: [next], signal: lease.signal,
      assertCurrent: lease.assertCurrent, expectedIndexes: baselines.map((file) => file.index),
      tags: baselines.map((file) => ({ assetId: file.index.assetId, expected: file.tags, next: file.tags })),
      expectedImages: baselines.flatMap((file) => file.image ? [file.image] : []),
      expectedImageRecords: baselines.map((file) => ({ assetId: file.index.assetId, records: file.imageRecordsSnapshot })) } });
    if (commitResult.alreadyApplied) await rejectAlreadyApplied(session, item);
    committed = true;
    item.mapping = next; item.operation = { ...commitOperation, phase: 'completed' }; item.acknowledgeOnly = true;
    session.mappings = session.mappings.map((mapping) => mapping.id === next.id ? next : mapping);
    session.remoteAssets = [...session.remoteAssets.filter((asset) => asset.head.sharedAssetId !== published.head.sharedAssetId), published];
    await acknowledgeAppliedOperation(session, item, result.applyToken);
    await operationPhase(item, 'completed', { errorCode: undefined }); item.acknowledgeOnly = false;
  } catch (error) {
    if (!committed) {
      await acknowledgeOperation(session, item, result.applyToken, false).catch(() => undefined);
    }
    throw error;
  } finally { lease?.dispose(); }
}

async function applyDownloaded(session: SharedAssetSyncSession, item: SessionOperation, execution: SharedAssetSyncExecution): Promise<void> {
  if (!item.operation.revision || !item.operation.revisionDigest) throw new Error('共享下载版本缺失，请重新预览');
  await operationPhase(item, 'downloading');
  const result = await native(session, (context) => downloadSharedAssetRevision({ ...operationInput(context, item.operation),
    rootDirectory: session.rootDirectory, expectedRevisionDigest: item.operation.revisionDigest! }));
  let committed = false;
  let lease: ReturnType<typeof localApplyLease> | undefined;
  try {
    lease = localApplyLease(session.context, result.applyToken);
    const baselines = localBaselines(item);
    for (const local of baselines) await verifyLocal({ ...item, local }, session, lease.assertCurrent, lease.signal);
    const mapping = structuredClone(item.mapping);
    const indexes: AssetIndexRecord[] = []; const mediaById = new Map<string, { assetId: string; relativePath: string; url: string }>();
    for (const media of result.media) {
      lease.assertCurrent();
      const expected = `.shared-sync/files/${mapping.sharedAssetId}/${item.operation.revisionId}/`;
      if (!media.relativePath.startsWith(expected) || media.relativePath.slice(expected.length).includes('/')) throw new Error('共享媒体发布位置无效');
      const path = joinPath(session.rootDirectory, media.relativePath); const info = await lstat(path);
      lease.assertCurrent();
      if (!info.isFile || info.isSymlink || info.size !== media.bytes) throw new Error('共享媒体校验失败');
      const assetId = crypto.randomUUID();
      indexes.push({ assetId, path, relativePath: media.relativePath, rootPath: session.rootDirectory,
        projectId: mapping.ownerId, source: 'project', fingerprint: `${info.size}:${info.mtime?.getTime() ?? 0}`,
        size: info.size, mtimeMs: info.mtime?.getTime() ?? 0, status: 'online', updatedAt: Date.now() });
      mediaById.set(media.mediaId, { assetId, relativePath: media.relativePath, url: await getAssetUrlFromPath(path) });
      lease.assertCurrent();
    }
    mapping.media = result.media.map((media) => ({ sharedMediaId: media.mediaId, localAssetId: mediaById.get(media.mediaId)!.assetId,
      projectId: mapping.ownerId, relativePath: media.relativePath, sha256: media.sha256, bytes: media.bytes }));
    mapping.acceptedRevisionId = result.revision.revisionId;
    mapping.acceptedETag = item.remote?.etag ?? mapping.acceptedETag;
    mapping.baselineDigest = await sharedAssetSyncContentDigest(result.revision); mapping.updatedAt = Date.now();
    lease.assertCurrent();
    const commit: SharedAssetSyncCommitInput = { ownerId: mapping.ownerId, operationId: item.operation.operationId,
      mappings: [mapping], operation: { ...item.operation, revision: result.revision, revisionDigest: result.revisionDigest, phase: 'applying' },
      indexes, expectedIndexes: baselines.map((file) => file.index),
      tags: baselines.map((file) => ({ assetId: file.index.assetId, expected: file.tags, next: file.tags })),
      expectedImages: baselines.flatMap((file) => file.image ? [file.image] : []),
      expectedImageRecords: baselines.map((file) => ({ assetId: file.index.assetId, records: file.imageRecordsSnapshot })),
      signal: lease.signal, assertCurrent: lease.assertCurrent };
    let nextLibrary: DramaAssetLibrary | undefined;
    const payload = result.revision.payload;
    if (payload.kind === 'file') {
      const local = mediaById.get(payload.mediaId)!; const index = indexes.find((index) => index.assetId === local.assetId)!;
      mapping.previousFileAssetIds = [...new Set([...(mapping.previousFileAssetIds ?? []), ...(mapping.currentFileAssetId ? [mapping.currentFileAssetId] : [])])];
      mapping.currentFileAssetId = index.assetId; mapping.displayRelativePath = payload.displayRelativePath;
      commit.tags = [{ assetId: index.assetId, expected: null, next: { assetId: index.assetId, tags: payload.tags,
        ...(payload.taggedBy ? { taggedBy: payload.taggedBy } : {}), updatedAt: Date.now() } },
      ...baselines.map((file) => ({ assetId: file.index.assetId, expected: file.tags, next: file.tags }))];
      if (payload.imageMetadata) {
        const record = await prepareSharedAssetImageMetadata({ assetId: index.assetId, name: payload.name, path: index.path,
          size: index.size, source: 'project', category: 'image' }, { prompt: restoreSharedAssetSyncText(payload.imageMetadata.prompt, (value) => mention(session, value, true)),
          references: payload.imageMetadata.references.map((reference) => ({ id: member(mapping, 'imageReference', reference.id, true),
            name: reference.name, filePath: indexes.find((index) => index.assetId === mediaById.get(reference.mediaId)!.assetId)!.path })) }, { signal: lease.signal });
        lease.assertCurrent();
        commit.images = [{ expected: null, next: record }];
      }
    } else {
      const restored = restoreSharedDramaAsset(payload, mapping.localEntityId, { mediaById,
        memberId: (kind, sharedId, parentSharedId) => member(mapping, kind, sharedId, true,
          parentSharedId ? member(mapping, 'action', parentSharedId, true) : undefined),
        mapMentionId: (value) => mention(session, value, true),
        mapWeaponId: (value) => weaponIdentity(session, value, true) });
      const existing = flat(session.expectedLibrary).find((asset) => asset.kind === restored.kind && asset.id === restored.id);
      if (existing?.kind === 'character' && restored.kind === 'character') {
        restored.libraryOrder = existing.libraryOrder; restored.refmods = existing.refmods; restored.volcengineBinding = existing.volcengineBinding;
      }
      nextLibrary = replaceCard(session.expectedLibrary, restored);
    }
    lease.assertCurrent();
    await operationPhase(item, 'applying');
    lease.assertCurrent();
    const commitResult = await execution.applyDownload({ expectedLibrary: session.expectedLibrary, nextLibrary, commit });
    if (commitResult.alreadyApplied) await rejectAlreadyApplied(session, item);
    committed = true; item.mapping = mapping; item.operation = { ...commit.operation, phase: 'applied' };
    if (nextLibrary) session.expectedLibrary = nextLibrary;
    session.mappings = session.mappings.map((row) => row.id === mapping.id ? mapping : row);
    await acknowledgeAppliedOperation(session, item, result.applyToken);
    await operationPhase(item, 'completed');
  } catch (error) {
    if (!committed) await acknowledgeOperation(session, item, result.applyToken, false).catch(() => undefined);
    throw error;
  } finally { lease?.dispose(); }
}

export interface SharedAssetSyncSelection { itemId: string; direction?: 'upload' | 'download' }

function selectedOperation(session: SharedAssetSyncSession, selection: SharedAssetSyncSelection): SessionOperation {
  const item = session.operations.find((item) => item.mapping.id === selection.itemId
    || item.operation.operationId === selection.itemId);
  const row = item && session.items.find((row) => row.id === item.mapping.id);
  if (!item || !row || !['upload', 'download'].includes(row.direction)
    || row.direction !== item.operation.direction || selection.direction && selection.direction !== item.operation.direction) {
    throw new Error('本条资产当前不可按所选方向同步，请重新预览或先处理冲突');
  }
  assertOperationDependencies(session, item);
  return item;
}

function assertOperationDependencies(session: SharedAssetSyncSession, item: SessionOperation): void {
  if (item.acknowledgeOnly || item.operation.phase === 'applied' || item.operation.errorCode === 'ack_pending') return;
  const payload = item.operation.revision?.payload ?? item.operation.draft?.payload;
  if (!payload) throw new Error('本条资产的固定版本缺失，请重新预览');
  const dependencies = getSharedAssetSyncDependencies(payload).filter((id) => id !== item.mapping.sharedAssetId);
  const dependencyAsset = (sharedId: string): DramaAsset | undefined => {
    if (item.operation.direction === 'upload') {
      const remote = session.remoteAssets.find((asset) => asset.head.sharedAssetId === sharedId)?.revision.payload;
      return remote && remote.kind !== 'file' ? remote.data : undefined;
    }
    const mapping = session.mappings.find((mapping) => mapping.sharedAssetId === sharedId);
    return mapping && flat(session.expectedLibrary).find((asset) => asset.id === mapping.localEntityId && asset.kind === mapping.kind);
  };
  let missing = dependencies.some((sharedId) => !dependencyAsset(sharedId));
  // 有卡片而没有所引用的参考图／声音／动作，同样需要先同步依赖卡片的新版本。
  for (const match of JSON.stringify(payload).matchAll(/@drama\{([^:}]+):/g)) {
    const reference = parseDramaMentionId(match[1]);
    if (reference.assetId === item.mapping.sharedAssetId) continue;
    const asset = dependencyAsset(reference.assetId);
    const mapping = session.mappings.find((mapping) => mapping.sharedAssetId === reference.assetId);
    const memberId = (kind: SharedSyncMemberKind, sharedId: string, parent?: string) => item.operation.direction === 'upload' ? sharedId
      : mapping?.members.find((member) => member.kind === kind && member.sharedId === sharedId
        && (kind !== 'actionMedia' || member.parentLocalId === parent))?.localId;
    if (!asset) { missing = true; continue; }
    if (reference.referenceImageId !== undefined && !asset.referenceImages?.some((entry) => entry.id === memberId('referenceImage', reference.referenceImageId!))) missing = true;
    if (reference.voiceClipId !== undefined && (asset.kind !== 'character'
      || !asset.voiceClips?.some((entry) => entry.id === memberId('voiceClip', reference.voiceClipId!)))) missing = true;
    if (reference.actionId !== undefined) {
      const actionId = memberId('action', reference.actionId);
      const action = asset.kind === 'character' ? asset.actions?.find((entry) => entry.id === actionId) : undefined;
      if (!action?.media?.some((entry) => entry.id === memberId('actionMedia', reference.actionMediaId ?? '', actionId))) missing = true;
    }
  }
  if (payload.kind === 'character' && payload.data.kind === 'character') {
    for (const sharedId of payload.data.weaponIds ?? []) {
      const weapon = dependencyAsset(sharedId);
      if (!weapon || weapon.kind !== 'prop' || weapon.propType !== 'weapon') missing = true;
    }
  }
  if (missing) throw new Error('本条资产引用的其他项目资产尚未同步，请先同步依赖资产');
}

/** 删除只发布云端删除标记；媒体文件、卡片与本机索引保持原样。 */
export async function deleteSharedAsset(session: SharedAssetSyncSession, itemId: string): Promise<void> {
  if (session.executing || session.invalidated) throw new Error('请先重新预览项目资产同步');
  guard(session.context);
  const mapping = session.mappings.find((mapping) => mapping.id === itemId
    || session.operations.some((item) => item.mapping.id === mapping.id && item.operation.operationId === itemId));
  const remote = mapping && session.remoteAssets.find((asset) => asset.head.sharedAssetId === mapping.sharedAssetId);
  if (!mapping || !remote || !session.items.some((row) => row.id === mapping.id && row.canDelete)) {
    throw new Error('本条资产没有可删除的云端版本，请重新预览');
  }
  const expected = { sharedAssetId: remote.head.sharedAssetId, expectedRevisionId: remote.head.revisionId, expectedETag: remote.etag };
  const publisher = remote.head.operationId, digest = remote.head.revisionDigest;
  const operationId = crypto.randomUUID();
  const assertRemote = () => {
    guard(session.context);
    const live = session.remoteAssets.find((asset) => asset.head.sharedAssetId === expected.sharedAssetId);
    if (!live || live.head.revisionId !== expected.expectedRevisionId || live.etag !== expected.expectedETag
      || live.head.operationId !== publisher || live.head.revisionDigest !== digest) {
      throw new Error('云端资产版本已变化，请重新预览后删除');
    }
  };
  session.executing = true;
  try {
    const preview = await native(session, (context) => previewSharedAssetDelete({ ...context, ...expected, operationId }));
    assertRemote();
    if (preview.operationId !== operationId || preview.sharedAssetId !== expected.sharedAssetId
      || preview.revisionId !== expected.expectedRevisionId) throw new Error('云端删除预览已失效，请重新预览');
    const result = await native(session, (context) => applySharedAssetDelete({ ...context, operationId,
      sharedAssetId: expected.sharedAssetId, previewToken: preview.previewToken }));
    assertRemote();
    if (result.status !== 'deleted') throw new Error(result.status === 'conflict'
      ? '云端资产已有其他修改，未删除，请重新预览' : '云端删除结果尚未确认，请重新预览核对');
    session.invalidated = true;
  } finally { session.executing = false; }
}

export async function executeSharedAssetSync(session: SharedAssetSyncSession, execution: SharedAssetSyncExecution,
  selection?: SharedAssetSyncSelection): Promise<void> {
  if (session.executing) throw new Error('项目资产正在同步，请稍后重试');
  if (session.invalidated) throw new Error('共享操作已由其他实例应用，请重新打开项目后预览');
  guard(session.context);
  const operations = selection ? [selectedOperation(session, selection)] : session.operations;
  guard(session.context); session.executing = true;
  session.context.onStatus({ stage: 'syncing', total: session.total, completed: session.completed });
  try {
    const waiting = [...operations];
    while (waiting.length) {
      guard(session.context);
      const ready = waiting.findIndex((item) => {
        if (item.operation.phase === 'completed' && !item.acknowledgeOnly && item.operation.errorCode !== 'ack_pending') return true;
        try { assertOperationDependencies(session, item); return true; } catch { return false; }
      });
      if (ready < 0) {
        // 计划中的候选不是已经到达目标端的依赖；没有就绪项时保留原身份，不能先发布悬空引用。
        for (const item of waiting) {
          const uncertain = ['unknown_commit', 'locked_conflict'].includes(item.operation.errorCode ?? '');
          if (!uncertain) await operationPhase(item, 'paused', { errorCode: 'dependency_missing' });
          session.items = session.items.map((row) => row.id === item.mapping.id ? { ...row, direction: 'blocked',
            message: uncertain ? uncertainCommitMessage : '引用的项目资产尚未同步到目标端，请先同步依赖资产' } : row);
        }
        session.context.onStatus({ stage: 'paused', items: [...session.items], completed: session.completed, total: session.total,
          error: '部分资产的依赖尚未同步，原待办已保留' });
        return;
      }
      const [item] = waiting.splice(ready, 1);
      guard(session.context);
      if (item.operation.phase === 'completed' && !item.acknowledgeOnly && item.operation.errorCode !== 'ack_pending') continue;
      try {
        if (item.operation.phase === 'applied' || item.acknowledgeOnly || item.operation.errorCode === 'ack_pending') {
          const recovered = await native(session, (context) => recoverSharedAssetOperation(operationInput(context, item.operation)));
          if (!recovered.applyToken) throw new Error('本次资产回执尚不可恢复，请稍后重试');
          await acknowledgeAppliedOperation(session, item, recovered.applyToken);
          await operationPhase(item, 'completed', { errorCode: undefined }); item.acknowledgeOnly = false;
        } else if (item.operation.direction === 'download') await applyDownloaded(session, item, execution);
        else {
          let result = await native(session, (context) => recoverSharedAssetOperation(operationInput(context, item.operation)));
          if (result.status === 'retryable') {
            if (result.prepared) {
              await operationPhase(item, 'prepared', { ...result.prepared, errorCode: undefined });
              await cleanupInputs(session, item.operation);
            }
            if (!item.operation.revision || !item.operation.revisionDigest) throw new Error('未找到上次准备的固定版本，请重新预览');
            assertOperationDependencies(session, item);
            await operationPhase(item, 'uploading', { errorCode: undefined });
            result = await native(session, (context) => publishSharedAssetRevision(operationInput(context, item.operation)));
          }
          if (result.status === 'published') await acceptPublished(session, item, result, execution);
          else if (result.status === 'uncertain') {
            await retainUncertainOperation(item, result);
            throw new Error(uncertainCommitMessage);
          } else {
            const conflicted = await conflict(session, item.mapping, 'headChanged', result.asset, item.operation);
            if (conflicted) item.operation = conflicted;
            throw new Error('共享资产出现并发修改或提交结果不确定，候选版本已保留');
          }
        }
        session.completed++; session.context.onStatus({ completed: session.completed, total: session.total });
      } catch (error) {
        if (!['unknown_commit', 'locked_conflict'].includes(item.operation.errorCode ?? '') && !['applied', 'completed', 'conflict'].includes(item.operation.phase)) {
          await patchSharedAssetSyncOperation(item.operation.operationId, { phase: 'paused', errorCode: 'sync_interrupted' }).catch(() => undefined);
        }
        throw itemFailure(session, item, error);
      }
    }
    const unresolved = session.items.some((item) => item.direction === 'conflict' || item.direction === 'blocked');
    const restored = operations.some((item) => item.resumed);
    session.context.onStatus({ stage: selection ? 'preview' : unresolved || restored ? 'paused' : 'completed', completed: session.completed, total: session.total,
      ...(unresolved ? { error: '部分资产需要处理，请查看冲突或未纳入项' }
        : restored ? { error: '上次操作已恢复，请重新预览最新本地和云端变更' } : !selection ? { lastSyncedAt: Date.now() } : {}) });
  } catch (error) {
    session.context.onStatus({ stage: session.context.signal?.aborted ? 'paused' : 'failed', error: publicError(error) });
    throw error;
  } finally { session.executing = false; }
}

/** 界面和 Store 的唯一业务入口；原生 IPC 与本机文件适配留在服务内部。 */
export const projectAssetSyncService = {
  preview: buildSharedAssetSyncPreview,
  apply: executeSharedAssetSync,
  deleteAsset: deleteSharedAsset,
  readProjectFiles,
  projectFileView: projectSharedFileView,
  readState: loadSharedAssetSyncState,
};
