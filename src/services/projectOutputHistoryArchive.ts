/** 输出历史的归档投影；运行回执、下载权限和本机地址不跨包传播。 */
import type { ProjectArchiveOutputHistoryV4, ProjectArchiveFileV4 } from '../types/projectArchiveV4';
import type { ProjectModelTransferHistoryRow, ProjectModelTransferExchange, ProjectModelTransferIdMapEntry } from '../types/projectModelTransfer';
import { projectExchangeId, PROJECT_EXCHANGE_LIMITS } from './projectExchangeFormat';
import { safeExchangePath } from './projectExchangeDomain';

const fields = ['id', 'archiveOriginId', 'projectId', 'nodeId', 'nodeLabel', 'timestamp', 'prompt', 'output', 'nodeType', 'model', 'provider', 'status', 'error', 'fileId', 'params'];
const parameterFields = new Set(['aspectRatio', 'imageSize', 'imageQuality', 'imageBackground', 'resolution', 'duration', 'videoFps',
  'generateAudio', 'audioVoice', 'audioFormat', 'audioSpeed', 'audioPurpose', 'musicTitle', 'musicLyrics', 'animationAction',
  'animationFrames', 'grid', 'animationPromptVersion', 'originalInputUnavailable', 'originalTimestampUnavailable']);
const fail = (): never => { throw new Error('输出历史归档的身份、文件或字段无效'); };
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= PROJECT_EXCHANGE_LIMITS.stringBytes;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && !Object.getOwnPropertySymbols(value).length
  && Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) => 'value' in entry && entry.enumerable);
const localUrl = (value: string) => /^(?:file:|asset:|blob:|data:|https?:\/\/(?:asset\.localhost|tauri\.localhost)|[a-z]:[\\/]|\\\\|\/)/i.test(value);

export function portableOutputHistoryParams(value: unknown): ProjectArchiveOutputHistoryV4['params'] {
  if (!plain(value)) return;
  const entries = Object.entries(value).filter(([key, item]) => parameterFields.has(key)
    && (typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item) || text(item) && !localUrl(item)));
  return entries.length ? Object.fromEntries(entries) as NonNullable<ProjectArchiveOutputHistoryV4['params']> : undefined;
}

export function validateArchiveOutputHistory(rows: unknown, files: readonly ProjectArchiveFileV4[], projectId: string): asserts rows is ProjectArchiveOutputHistoryV4[] {
  if (!Array.isArray(rows) || rows.length > 100_000) return fail();
  const seen = new Set<string>();
  for (const value of rows) {
    if (!plain(value) || Object.keys(value).some((field) => !fields.includes(field))) return fail();
    const row = value as unknown as ProjectArchiveOutputHistoryV4;
    projectExchangeId(row.id); projectExchangeId(row.nodeId);
    if (seen.has(row.id) || row.projectId !== projectId || !/^[a-f0-9]{64}$/.test(row.archiveOriginId)
      || !Number.isSafeInteger(row.timestamp) || row.timestamp < 0
      || !['nodeLabel', 'prompt', 'output', 'nodeType', 'model', 'provider'].every((field) => text(value[field]))
      || !/^ai-[a-z0-9-]+$/.test(row.nodeType) || !['success', 'error', 'download_pending', 'abandoned'].includes(row.status)
      || row.error !== undefined && !text(row.error)
      || row.fileId !== undefined && (!text(row.fileId) || !files.some((file) => file.id === row.fileId))
      || row.nodeType !== 'ai-text' && row.output !== ''
      || row.params !== undefined && JSON.stringify(portableOutputHistoryParams(row.params)) !== JSON.stringify(row.params)) return fail();
    seen.add(row.id);
  }
}

/** 快照没有媒体相对身份时不猜文件名，也不携带远端签名地址。 */
export function captureArchiveOutputHistory(row: ProjectModelTransferHistoryRow['value'], archiveOriginId: string, projectId: string,
  defaultRoot: string, mappings: readonly ProjectModelTransferIdMapEntry[], bindings: ProjectModelTransferExchange['fileBindings']): ProjectArchiveOutputHistoryV4 {
  const root = typeof row.storageRootRef === 'string' ? row.storageRootRef : defaultRoot;
  const logicalRoot = mappings.find((item) => item.kind === 'storage-root' && item.localId === root)?.sourceId;
  const relative = typeof row.relativePath === 'string' && row.relativePath ? safeExchangePath(row.relativePath) : undefined;
  const file = relative && bindings.find((item) => item.rootRef === logicalRoot && item.localRelativePath === relative);
  if (relative && !file) return fail();
  const string = (field: string) => text(row[field]) ? row[field] as string : '';
  const params = portableOutputHistoryParams(row.params);
  return { id: row.id, archiveOriginId, projectId, nodeId: string('nodeId'), nodeLabel: string('nodeLabel'),
    timestamp: Number.isSafeInteger(row.timestamp) && Number(row.timestamp) >= 0 ? Number(row.timestamp) : 0,
    prompt: string('prompt'), output: row.nodeType === 'ai-text' ? string('output') : '', nodeType: string('nodeType'),
    model: string('model'), provider: string('provider'), status: row.status as ProjectArchiveOutputHistoryV4['status'],
    ...(typeof row.error === 'string' ? { error: row.error } : {}), ...(file ? { fileId: file.id } : {}), ...(params ? { params } : {}) };
}

export function materializeArchiveOutputHistory(row: ProjectArchiveOutputHistoryV4, files: readonly ProjectArchiveFileV4[],
  mappings: readonly ProjectModelTransferIdMapEntry[], bindings: ProjectModelTransferExchange['fileBindings']): Record<string, unknown> {
  const { fileId, ...value } = row;
  if (!fileId) return value;
  const file = files.find((item) => item.id === fileId), binding = bindings.find((item) => item.id === fileId);
  const root = file && mappings.find((item) => item.kind === 'storage-root' && item.sourceId === file.rootRef);
  if (!file || !binding || !root || file.rootRef !== binding.rootRef || file.relativePath !== binding.relativePath) return fail();
  // 展示 URL 由本机读取时按新根解析；归档从不回填原机器的 filePath。
  return { ...value, relativePath: binding.localRelativePath, storageRootRef: root.localId,
    output: row.nodeType === 'ai-text' ? row.output : binding.localRelativePath, mediaUrl: binding.localRelativePath };
}

/** journal再次核验只读历史数据；不因归档来自受信UI就接收任务或任意路径。 */
export function validateNativeArchiveOutputRows(rows: readonly ProjectModelTransferHistoryRow[], context: {
  projectId: string; canvasIds: readonly string[]; rootRefs: readonly string[];
  identities: readonly ProjectModelTransferIdMapEntry[]; bindings: ProjectModelTransferExchange['fileBindings'];
}): void {
  if (!Array.isArray(rows) || rows.length > 100_000) return fail();
  const seen = new Set<string>();
  for (const row of rows) {
    if (!plain(row)) return fail();
    if (row.kind !== 'output') continue;
    const value = row.value;
    if (!plain(row) || Object.keys(row).some((key) => !['kind', 'sourceNamespace', 'archiveOriginId', 'value', 'existingLocalId'].includes(key))
      || !plain(value) || Object.keys(value).some((key) => ![...fields.filter((field) => field !== 'fileId'), 'relativePath', 'storageRootRef', 'mediaUrl'].includes(key))
      || typeof value.projectId !== 'string' || typeof value.id !== 'string' || typeof value.nodeId !== 'string'
      || !context.canvasIds.includes(value.projectId) || seen.has(value.id) || !text(row.sourceNamespace)
      || typeof row.archiveOriginId !== 'string' || !/^[a-f0-9]{64}$/.test(row.archiveOriginId) || row.archiveOriginId !== value.archiveOriginId
      || row.existingLocalId !== undefined && !text(row.existingLocalId)) return fail();
    projectExchangeId(value.id); projectExchangeId(value.nodeId);
    const { relativePath, storageRootRef, mediaUrl, ...portable } = value;
    if (relativePath !== undefined) {
      if (typeof relativePath !== 'string' || safeExchangePath(relativePath) !== relativePath
        || typeof storageRootRef !== 'string' || !context.rootRefs.includes(storageRootRef) || mediaUrl !== relativePath) return fail();
      const logicalRoot = context.identities.find((item) => item.kind === 'storage-root' && item.localId === storageRootRef)?.sourceId;
      if (!context.bindings.some((binding) => binding.rootRef === logicalRoot && binding.localRelativePath === relativePath)) return fail();
    } else if (storageRootRef !== undefined || mediaUrl !== undefined) return fail();
    const normalized = { ...portable, projectId: context.projectId,
      ...(value.nodeType === 'ai-text' ? {} : { output: '' }) };
    validateArchiveOutputHistory([normalized], [], context.projectId);
    if (value.nodeType !== 'ai-text' && value.output !== (relativePath ?? '')) return fail();
    seen.add(value.id);
  }
}
