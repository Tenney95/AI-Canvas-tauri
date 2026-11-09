/** 新媒体交付的耐久历史发件箱；这里只读写新项目库，不生成任务或读取旧项目。 */
import type { NodeType, OutputHistoryEntry } from '../types';
import type { CanvasDocument, ProjectRecord } from '../types/project';
import type { ProjectModelTransferExchange } from '../types/projectModelTransfer';
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { validateNativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { CANVASES, EXCHANGE, ROOTS, isNativeCanvasId, isNativeProjectId, openNativeProjectDatabase, transact,
  type NativeProjectOptions } from './indexedDb/nativeProjectRepository';
import { nativeMediaLocalOutputs } from './nativeMediaCollection';
import { nativeMediaContentDigest } from './nativeMediaDisplay';
import { nativeMediaOutputNodeId } from './nativeMediaCollectionCanvas';
import { readNativeProjectExchange } from './indexedDb/projectModelTransferRepository';
import { safeExchangePath } from './projectExchangeDomain';

export interface NativeOutputHistoryProjection {
  ownerProjectId: string;
  entry: OutputHistoryEntry;
  rootRef: string;
  relativePath: string;
  sha256: string;
  bytes?: number;
}
interface NativeOutputHistoryRecord extends NativeOutputHistoryProjection {
  projectId: string;
  kind: 'native-output-history-v1';
  canvasId: string;
}
const PREFIX = 'output-history:';
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const artifact = new RegExp(`^native-media-(${uuid})(?:-([1-9][0-9]{0,2}))?$`);
const req = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('新项目输出历史读取失败'));
});
const parameterKeys = ['aspectRatio', 'imageSize', 'imageQuality', 'imageBackground', 'style', 'animationAction', 'animationFrames',
  'videoResolution', 'videoFps', 'videoFrames', 'seedanceResolution', 'seedanceRatio', 'seedanceDuration',
  'audioVoice', 'audioSpeed', 'originalInputUnavailable', 'originalTimestampUnavailable'] as const;
const historyId = (canvasId: string, operationId: string, ordinal: number) => `hist-native-${canvasId}-${operationId}-${ordinal}`;
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const string = (value: unknown) => typeof value === 'string' ? value : '';
const categoryOf = (type: unknown): 'image' | 'video' | 'audio' | undefined =>
  ['ai-image', 'source-image', 'ai-animation', 'ai-panorama'].includes(String(type)) ? 'image'
    : ['ai-video', 'source-video'].includes(String(type)) ? 'video' : ['ai-audio', 'source-audio'].includes(String(type)) ? 'audio' : undefined;
const parameterValue = (value: unknown): boolean => typeof value === 'string' || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value);

/** 导入文件只接受原exchange中唯一的根/文件ID/路径/摘要绑定，不按basename或后缀推测。 */
export function nativeOutputHistoryImportedFile(exchange: ProjectModelTransferExchange | null, rootRef: string,
  relativePath: string, category: 'image' | 'video' | 'audio'): { sha256: string; bytes: number } | undefined {
  if (!exchange || safeExchangePath(relativePath) !== relativePath) return undefined;
  const roots = exchange.identities.filter((item) => item.kind === 'storage-root' && item.localId === rootRef);
  if (roots.length !== 1) return undefined;
  const bindings = exchange.fileBindings.filter((item) => item.rootRef === roots[0].sourceId && item.localRelativePath === relativePath);
  if (bindings.length !== 1) return undefined;
  const head = exchange.bundle.revisions.find((item) => item.canonicalVersion === 2 && item.revisionId === exchange.localHead.revisionId);
  if (!head || head.canonicalVersion !== 2) return undefined;
  const binding = bindings[0], files = head.snapshot.entities.filter((item) => item.kind === 'file' && item.id === binding.id
    && item.data.rootRef === binding.rootRef && item.data.relativePath === binding.relativePath);
  if (files.length !== 1 || typeof files[0].data.mediaId !== 'string') return undefined;
  const media = head.snapshot.media.filter((item) => item.id === files[0].data.mediaId && item.kind === category);
  if (media.length !== 1 || !/^[a-f0-9]{64}$/.test(media[0].sha256) || !Number.isSafeInteger(media[0].bytes) || media[0].bytes <= 0) return undefined;
  return { sha256: media[0].sha256, bytes: media[0].bytes };
}
function snapshotParams(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const params = Object.fromEntries(parameterKeys.flatMap((key) => {
    const value = data?.[key];
    return parameterValue(value) ? [[key, value]] : [];
  }));
  return Object.keys(params).length ? params : undefined;
}
function validate(row: NativeOutputHistoryRecord): NativeOutputHistoryRecord {
  const entry = row?.entry;
  if (!row || row.kind !== 'native-output-history-v1' || !entry || row.projectId !== PREFIX + entry.id
    || !isNativeCanvasId(row.canvasId) || entry.projectId !== row.canvasId || !new RegExp(`^hist-native-${row.canvasId}-${uuid}-(?:0|[1-9][0-9]{0,2})$`).test(entry.id)
    || !isNativeProjectId(row.ownerProjectId) || !new RegExp(`^r2-${uuid}$`).test(row.rootRef) || typeof entry.nodeId !== 'string' || !entry.nodeId
    || entry.status !== 'success' || !categoryOf(entry.nodeType) || typeof entry.prompt !== 'string'
    || typeof entry.nodeLabel !== 'string' || typeof entry.model !== 'string' || typeof entry.provider !== 'string'
    || !Number.isSafeInteger(entry.timestamp) || entry.timestamp < 0 || entry.output !== row.relativePath || entry.mediaUrl !== row.relativePath
    || typeof row.relativePath !== 'string' || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)
    || (nativeMediaContentDigest(row.relativePath) !== row.sha256
      && !(entry.params?.originalInputUnavailable === true && safeExchangePath(row.relativePath) === row.relativePath))
    || row.bytes !== undefined && (!Number.isSafeInteger(row.bytes) || row.bytes <= 0)
    || Object.keys(row).some((key) => !['projectId', 'kind', 'ownerProjectId', 'canvasId', 'entry', 'rootRef', 'relativePath', 'sha256', 'bytes'].includes(key))
    || Object.keys(entry).some((key) => !['id', 'projectId', 'nodeId', 'nodeLabel', 'timestamp', 'prompt', 'output', 'nodeType', 'model', 'provider', 'status', 'mediaUrl', 'params'].includes(key))
    || entry.params !== undefined && (!object(entry.params) || Object.keys(entry.params).some((key) => !parameterKeys.includes(key as typeof parameterKeys[number])
      || !parameterValue(entry.params![key])))) {
    throw new Error('新项目输出历史身份无效');
  }
  return row;
}
function makeRow(record: NativeMediaTaskRecord, rootRef: string, file: { relativePath: string; sha256: string; bytes?: number; category: 'image' | 'video' | 'audio' },
  ordinal: number, source?: Record<string, unknown>, originalInputUnavailable = false): NativeOutputHistoryRecord {
  const id = historyId(record.canvasId, record.operationId, ordinal);
  const sourceType = record.targetNodeType ?? `ai-${record.category}`;
  const nodeType = (ordinal === 0 && categoryOf(sourceType) === file.category ? sourceType : `ai-${file.category}`) as NodeType;
  const params = originalInputUnavailable ? { originalInputUnavailable: true } : snapshotParams(source);
  return validate({ projectId: PREFIX + id, kind: 'native-output-history-v1', ownerProjectId: record.ownerProjectId,
    canvasId: record.canvasId, rootRef, relativePath: file.relativePath, sha256: file.sha256, ...(file.bytes ? { bytes: file.bytes } : {}),
    entry: { id, projectId: record.canvasId, nodeId: ordinal ? nativeMediaOutputNodeId(record, ordinal) : record.nodeId,
      nodeLabel: originalInputUnavailable ? '已生成媒体' : string(source?.label) || '生成媒体', timestamp: record.createdAt,
      prompt: originalInputUnavailable ? '' : string(source?.prompt), output: file.relativePath, mediaUrl: file.relativePath,
      nodeType, model: record.modelRef ?? '', provider: record.providerConfigId, status: 'success', ...(params ? { params } : {}) } });
}

/** 调用者必须已在同一事务内核验原任务/画布；失败会连同交付一起回滚。 */
export async function writeNativeOutputHistory(tx: IDBTransaction, record: NativeMediaTaskRecord, canvas: CanvasDocument,
  rootRef: string, options: { originalInputUnavailable?: boolean } = {}): Promise<void> {
  const source = object(canvas.nodes.find((value) => object(value)?.id === record.nodeId));
  const data = record.origin?.deliveryMode === 'chat' ? undefined : object(source?.data);
  const files = nativeMediaLocalOutputs(record);
  if (!files.length && record.resultRelativePath) {
    const sha256 = nativeMediaContentDigest(record.resultRelativePath);
    if (sha256) files.push({ category: record.category, relativePath: record.resultRelativePath, sha256, bytes: 0 });
  }
  const store = tx.objectStore(EXCHANGE);
  for (const [ordinal, file] of files.entries()) {
    const row = makeRow(record, rootRef, { ...file, ...(file.bytes ? {} : { bytes: undefined }) }, ordinal, data,
      options.originalInputUnavailable || !data);
    const previous = await req(store.get(row.projectId)) as NativeOutputHistoryRecord | undefined;
    if (previous !== undefined) {
      validate(previous);
      if (previous.ownerProjectId !== row.ownerProjectId || previous.canvasId !== row.canvasId || previous.rootRef !== row.rootRef
        || previous.relativePath !== row.relativePath || previous.sha256 !== row.sha256) throw new Error('新项目输出历史身份冲突');
      continue;
    }
    await req(store.add(row));
  }
}

/** 只补历史显示材料；从不据此恢复租约、改写画布或重投模型。 */
export async function readNativeOutputHistory(canvasId: string, options: NativeProjectOptions = {}): Promise<NativeOutputHistoryProjection[]> {
  if (!isNativeCanvasId(canvasId)) return [];
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return [];
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const canvas = await req(tx.objectStore(CANVASES).get(canvasId)) as CanvasDocument | undefined;
      if (!canvas) return [];
      const project = await req(tx.objectStore(ROOTS).get(canvas.projectId)) as ProjectRecord | undefined;
      if (!project) return [];
      const store = tx.objectStore(EXCHANGE);
      const exchangeRow = await req(store.get(project.id)) as { projectId: string; exchange: ProjectModelTransferExchange } | undefined;
      if (exchangeRow && exchangeRow.projectId !== project.id) throw new Error('新项目输出历史素材归属无效');
      const exchange = readNativeProjectExchange(exchangeRow?.exchange ?? null);
      const prefix = `${PREFIX}hist-native-${canvasId}-`;
      const stored = await req(store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`))) as NativeOutputHistoryRecord[];
      const rows = new Map(stored.map((row) => [validate(row).entry.id, row]));
      const records = await req(store.getAll(IDBKeyRange.bound('media-task:', 'media-task:\uffff'))) as NativeMediaTaskRecord[];
      if (records.length > 100_000 || rows.size > 100_000) throw new Error('新项目输出历史超过读取上限');
      for (const record of records) {
        if (record?.ownerProjectId !== project.id || record.canvasId !== canvasId || record.status !== 'delivered') continue;
        validateNativeMediaTaskRecord(record);
        const rootRef = record.resultRootRef ?? project.storageRootRef;
        if (!project.storageBindings.some((binding) => binding.rootRef === rootRef)) continue;
        // 旧账本没有原稿；即使当前节点仍在，也不能把现在的提示词当成旧任务输入。
        let files: Array<{ relativePath: string; sha256: string; bytes?: number; category: 'image' | 'video' | 'audio' }> = nativeMediaLocalOutputs(record);
        if (!files.length && record.resultRelativePath) {
          const sha256 = nativeMediaContentDigest(record.resultRelativePath);
          if (sha256) files = [{ category: record.category, relativePath: record.resultRelativePath, sha256 }];
        }
        for (const [ordinal, file] of files.entries()) {
          const row = makeRow(record, rootRef, file, ordinal, undefined, true);
          if (!rows.has(row.entry.id)) rows.set(row.entry.id, row);
        }
      }
      // 旧导入包仅保留了画布产物：只认明确artifact和内容路径，缺失原稿/时间均显式标记。
      for (const value of canvas.nodes) {
        const node = object(value), data = object(node?.data), match = artifact.exec(string(data?.artifactId));
        const category = categoryOf(data?.type), relativePath = string(data?.relativePath);
        const rootRef = string(data?.storageRootRef) || canvas.storageRootRef;
        if (!node || typeof node.id !== 'string' || !data || !match || !category || !relativePath || data.status !== 'success'
          || data[category === 'image' ? 'imageUrl' : category === 'video' ? 'videoUrl' : 'audioUrl'] !== relativePath
          || !project.storageBindings.some((binding) => binding.rootRef === rootRef)) continue;
        const contentDigest = nativeMediaContentDigest(relativePath);
        const imported = contentDigest ? undefined : nativeOutputHistoryImportedFile(exchange, rootRef, relativePath, category);
        const sha256 = contentDigest ?? imported?.sha256;
        if (!sha256) continue;
        const ordinal = Number(match[2] ?? 0);
        if (ordinal > 127) continue;
        const id = historyId(canvasId, match[1], ordinal);
        if (rows.has(id)) continue;
        const row = validate({ projectId: PREFIX + id, kind: 'native-output-history-v1', ownerProjectId: project.id, canvasId,
          rootRef, relativePath, sha256, ...(imported ? { bytes: imported.bytes } : {}), entry: { id, projectId: canvasId, nodeId: node.id, nodeLabel: '已保存媒体（原始生成信息未保存）',
            timestamp: 0, prompt: '', output: relativePath, mediaUrl: relativePath, nodeType: data.type as NodeType,
            model: '', provider: '', status: 'success', params: { originalInputUnavailable: true, originalTimestampUnavailable: true } } });
        rows.set(id, row);
      }
      return [...rows.values()].filter((row) => row.ownerProjectId === project.id && row.canvasId === canvasId
        && project.storageBindings.some((binding) => binding.rootRef === row.rootRef)
        && (nativeMediaContentDigest(row.relativePath) === row.sha256
          || (() => { const proof = nativeOutputHistoryImportedFile(exchange, row.rootRef, row.relativePath, categoryOf(row.entry.nodeType)!);
            return proof?.sha256 === row.sha256 && proof?.bytes === row.bytes; })()))
        .map(({ ownerProjectId, entry, rootRef, relativePath, sha256, bytes }) => ({ ownerProjectId, entry, rootRef, relativePath, sha256, ...(bytes ? { bytes } : {}) }));
    }, [CANVASES, ROOTS, EXCHANGE]);
  } finally { database.close(); }
}
