/** 新项目存储清理的只读引用材料；不创建数据库、不补写历史或回执。 */
import {
  EXCHANGE, TRANSFER, RETIRED, isNativeProjectId, isNativeCanvasId, isNativeEpisodeId,
  openNativeProjectDatabase, transact,
} from '../indexedDb/nativeProjectRepository';
import { safeExchangePath } from '../projectExchangeDomain';
import { localMediaUrlToPath } from '../../utils/mediaUrl';

export interface NativeStorageRetiredIdentity { id: string; projectId: string; kind: string }
export interface NativeStorageSnapshot {
  exchange: unknown[];
  transfers: unknown[];
  retired: NativeStorageRetiredIdentity[];
}

const MAX_ROWS = 100_000;
const MAX_VALUES = 2_000_000;
const MAX_TEXT = 64 * 1024 * 1024;
const MAX_DEPTH = 96;
const unavailable = (): never => { throw new Error('新项目存储引用读取不完整'); };
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  ? value as Record<string, unknown> : undefined;
const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error ?? new Error('新项目存储引用读取失败'));
});

/** 归属只能来自已登记的作品字段；命名空间前缀和画布 ID 不构成作品身份。 */
export function nativeStorageRowOwner(value: unknown): string {
  const row = object(value);
  if (!row) return unavailable();
  const candidates = [row.ownerProjectId, row.targetProjectId,
    isNativeProjectId(row.projectId) ? row.projectId : undefined,
    row.kind === 'native-asset-v1' ? object(row.record)?.projectId : undefined,
    object(row.binding)?.ownerProjectId].filter((id) => id !== undefined);
  if (!candidates.length || candidates.some((id) => !isNativeProjectId(id)) || new Set(candidates).size !== 1) return unavailable();
  return candidates[0] as string;
}

/** 未知协议/状态按整项保护；只有明确终态才开放普通文件清理。 */
export function nativeStorageRowPending(value: unknown): boolean {
  const row = object(value);
  if (!row) return true;
  if (row.kind === undefined && isNativeProjectId(row.projectId) && object(row.exchange)) return false;
  if (row.kind === 'native-media-task-v1' || row.kind === 'native-editor-media-v1') {
    return !['delivered', 'failed', 'reviewed'].includes(String(row.status));
  }
  if (row.kind === 'native-character-image-v1') return !['completed', 'failed', 'reviewed'].includes(String(row.status));
  if (row.kind === 'project-model-export') return !['registered', 'aborted'].includes(String(row.phase));
  if (row.kind === 'project-model-import' || row.kind === 'native-shared-sync') return !['finalized', 'aborted'].includes(String(row.phase));
  if (row.kind === 'native-content-recovery') return row.phase !== 'ready';
  if (row.kind === 'native-builtin-image-v1') {
    if (!['inline', 'submitted', 'failed'].includes(String(row.state)) || !Array.isArray(row.tasks)) return true;
    if (row.state === 'submitted' && !row.tasks.length) return true;
    return row.tasks.some((task) => !['completed', 'failed'].includes(String(object(task)?.state)));
  }
  if (row.kind === 'native-workflow-v1') {
    if (!Array.isArray(row.tasks) || !Array.isArray(row.submissions)) return true;
    return row.tasks.some((task) => !['completed', 'failed'].includes(String(object(task)?.state)))
      || row.submissions.some((submission) => !['submitted', 'completed', 'failed', 'not-started'].includes(String(object(submission)?.state)));
  }
  if (row.kind === 'native-apimart-music-v1') return ['lyrics', 'music'].some((key) =>
    !['completed', 'failed', 'not-started', 'not-needed'].includes(String(object(row[key])?.state)));
  if (row.kind === 'video-editor-lease-v1') return true;
  return !['native-asset-v1', 'native-output-history-v1', 'video-editor-v1'].includes(String(row.kind));
}

/** 一次事务取得所有命名空间；先 count 后 getAll，超限或身份异常均停止扫描。 */
export async function readNativeStorageSnapshot(options: { signal?: AbortSignal } = {}): Promise<NativeStorageSnapshot> {
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return { exchange: [], transfers: [], retired: [] };
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const stores = [EXCHANGE, TRANSFER, RETIRED].map((name) => tx.objectStore(name));
      const counts = await Promise.all(stores.map((store) => request(store.count())));
      if (counts.some((count) => !Number.isSafeInteger(count) || count < 0) || counts.reduce((sum, count) => sum + count, 0) > MAX_ROWS) return unavailable();
      const [exchange, transfers, rawRetired] = await Promise.all(stores.map((store) => request<unknown[]>(store.getAll())));
      if ([exchange, transfers, rawRetired].some((rows, index) => rows.length !== counts[index])) return unavailable();
      assertBoundedMaterial([exchange, transfers, rawRetired]);
      for (const row of [...exchange, ...transfers]) nativeStorageRowOwner(row);
      const retired = rawRetired.map((value): NativeStorageRetiredIdentity => {
        const row = object(value);
        if (!row || !isNativeProjectId(row.projectId) || typeof row.id !== 'string' || typeof row.kind !== 'string'
          || (row.kind === 'project' ? row.id !== row.projectId : row.kind === 'canvas' ? !isNativeCanvasId(row.id)
            : row.kind === 'episode' ? !isNativeEpisodeId(row.id) : true)) return unavailable();
        return { ...row, id: row.id, projectId: row.projectId, kind: row.kind };
      });
      return { exchange, transfers, retired };
    }, [EXCHANGE, TRANSFER, RETIRED]);
  } finally { database.close(); }
}

export function nativeStorageProjectRows(snapshot: NativeStorageSnapshot, projectId: string): NativeStorageSnapshot {
  if (!isNativeProjectId(projectId)) return unavailable();
  return { exchange: snapshot.exchange.filter((row) => nativeStorageRowOwner(row) === projectId),
    transfers: snapshot.transfers.filter((row) => nativeStorageRowOwner(row) === projectId),
    retired: snapshot.retired.filter((row) => row.projectId === projectId) };
}

export function nativeStorageProjectProtected(snapshot: NativeStorageSnapshot, projectId: string): boolean {
  const rows = nativeStorageProjectRows(snapshot, projectId);
  const terminalTasks = new Set(rows.exchange.flatMap((value) => {
    const row = object(value);
    return row?.kind === 'native-media-task-v1' && typeof row.operationId === 'string' && !nativeStorageRowPending(row)
      ? [row.operationId] : [];
  }));
  const pending = (value: unknown): boolean => {
    const row = object(value);
    if (row && ['native-builtin-image-v1', 'native-workflow-v1', 'native-apimart-music-v1'].includes(String(row.kind))) {
      const operationId = row.operationId ?? object(row.binding)?.operationId;
      // 主账本结束跟踪不会重写所有旧阶段；已结束的原操作不能永久阻塞项目清理。
      if (typeof operationId === 'string' && terminalTasks.has(operationId)) return false;
    }
    return nativeStorageRowPending(value);
  };
  return rows.exchange.some(pending) || rows.transfers.some(nativeStorageRowPending);
}

function assertBoundedMaterial(value: unknown): void {
  let count = 0, text = 0;
  const ancestors = new Set<object>();
  const walk = (item: unknown, depth: number): void => {
    if (++count > MAX_VALUES || depth > MAX_DEPTH) return unavailable();
    if (typeof item === 'string') { text += item.length; if (text > MAX_TEXT) return unavailable(); return; }
    if (!item || typeof item !== 'object') return;
    if (ancestors.has(item)) return unavailable();
    if (!Array.isArray(item) && !object(item)) return unavailable();
    ancestors.add(item);
    for (const child of Object.values(item)) walk(child, depth + 1);
    ancestors.delete(item);
  };
  walk(value, 0);
}

function normalizedPath(value: string): string {
  const path = value.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '');
  if (path.includes('\0') || path.split('/').some((part) => part === '..')) return unavailable();
  const prefix = path.startsWith('//') ? '//' : path.startsWith('/') ? '/' : '';
  const result = prefix + path.split('/').filter((part) => part && part !== '.').join('/');
  return /^[a-z]:\//i.test(result) || result.startsWith('//') ? result.toLowerCase() : result;
}

const pathFields = new Set(['relativePath', 'imageRelativePath', 'filePath', 'imageFilePath', 'path',
  'resultPath', 'resultRelativePath', 'localRelativePath', 'copyPath', 'fromPath', 'toPath', 'destinationPath',
  'directorCaptureRelativePaths', 'directorCaptureFilePaths', 'output', 'mediaUrl', 'imageUrl', 'videoUrl', 'audioUrl',
  'thumbnailUrl', 'sourceUrl', 'url']);
const externalFields = new Set(['sourceRootRef', 'sourceRelativePath', 'sourcePath', 'sourceRef', 'sourceFiles',
  'sourceBackup', 'logicalRoot', 'logicalPath', 'bundle']);
const textNodeTypes = new Set(['ai-text', 'source-text', 'ai-markdown']);

/**
 * 本机字段按显式根继承，外部来源及 canonical bundle 不当成本机路径。
 * 素材索引本体保守保留，覆盖只用 assetId 的引用；没有登记的普通废弃原件仍可清理。
 */
export function collectNativeStorageReferences(value: unknown, roots: ReadonlyMap<string, string>, defaultRootRef: string): Set<string> {
  assertBoundedMaterial(value);
  if (!roots.has(defaultRootRef)) return unavailable();
  const paths = new Set<string>();
  const rootPath = (rootRef: string): string => {
    const root = roots.get(rootRef);
    if (!root) return unavailable();
    return normalizedPath(root);
  };
  const add = (value: string, rootRef: string): void => {
    if (!value) return;
    const local = localMediaUrlToPath(value) ?? value;
    if (/^(?:[a-z]:[/\\]|[/\\])/i.test(local)) { paths.add(normalizedPath(local)); return; }
    if (/^[a-z]:/i.test(local)) return unavailable();
    if (/^[a-z][a-z0-9+.-]*:/i.test(local)) return;
    const relative = safeExchangePath(local);
    paths.add(normalizedPath(`${rootPath(rootRef)}/${relative}`));
  };
  const walk = (item: unknown, inheritedRoot: string, field = '', textOutput = false): void => {
    if (typeof item === 'string') {
      if (pathFields.has(field) && !(field === 'output' && textOutput)) add(item, inheritedRoot);
      else if (localMediaUrlToPath(item) || /^(?:[a-z]:[/\\]|[/\\])/i.test(item)) add(item, inheritedRoot);
      return;
    }
    if (Array.isArray(item)) { for (const child of item) walk(child, inheritedRoot, field, textOutput); return; }
    const row = object(item);
    if (!row) return;
    let bound = inheritedRoot;
    for (const key of ['storageRootRef', 'rootRef', 'resultRootRef']) {
      const rootRef = row[key];
      if (rootRef === undefined) continue;
      if (typeof rootRef !== 'string' || !roots.has(rootRef)) return unavailable();
      bound = rootRef;
    }
    rootPath(bound);
    if (row.kind === 'native-asset-v1') {
      const record = object(row.record);
      if (!record || typeof record.rootRef !== 'string' || !roots.has(record.rootRef)) return unavailable();
      walk(record, record.rootRef);
      return;
    }
    // exchange 的文件根是来源逻辑 ID，只有 identities 显式映射后的路径属于本机。
    if (Array.isArray(row.identities) && Array.isArray(row.fileBindings) && row.bundle !== undefined) {
      const mapped = new Map<string, string>();
      for (const value of row.identities) {
        const identity = object(value);
        if (identity?.kind !== 'storage-root') continue;
        if (typeof identity.sourceId !== 'string' || typeof identity.localId !== 'string' || !roots.has(identity.localId)
          || mapped.has(identity.sourceId) && mapped.get(identity.sourceId) !== identity.localId) return unavailable();
        mapped.set(identity.sourceId, identity.localId);
      }
      for (const value of row.fileBindings) {
        const binding = object(value), root = binding && typeof binding.rootRef === 'string' ? mapped.get(binding.rootRef) : undefined;
        if (!root || typeof binding?.localRelativePath !== 'string') return unavailable();
        add(binding.localRelativePath, root);
      }
      return;
    }
    const outputIsText = textOutput || textNodeTypes.has(String(row.type)) || textNodeTypes.has(String(row.nodeType));
    for (const [key, child] of Object.entries(row)) {
      if (externalFields.has(key)) continue;
      walk(child, bound, key, outputIsText);
    }
    if (typeof row.sceneId === 'string' && row.sceneId) {
      const directory = safeExchangePath(`director/scenes/${row.sceneId}`);
      paths.add(`${rootPath(bound)}/${directory}/`);
    }
  };
  walk(value, defaultRootRef);
  return paths;
}
