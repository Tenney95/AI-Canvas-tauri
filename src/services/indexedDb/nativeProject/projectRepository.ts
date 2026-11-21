// 按需打开新项目库。聚合读写共享事务和身份校验。
import type { CanvasDocument, CanvasPreview, EpisodeContent, EpisodeRecord, EpisodeSettingsPolicy, ProjectContent, ProjectRecord, StandaloneCreativeContent } from '../../../types/project';
import type { ProjectSettings } from '../../../types';
import type { CreationProfileSelection } from '../../../types/creationProfile';
import type { AgentTeamProfile } from '../../../types/agentTeam';
import type { ProjectModelTransferExchange } from '../../../types/projectModelTransfer';
import { configValuesEqual } from '../../configPatch';
import { readNativeProjectExchange } from '../projectModelTransferRepository';
import { validateProjectModelTransferAggregate } from '../projectModelBusinessRepository';
import { hasControlCharacters } from '../../../utils/controlCharacters';
import { isProjectSnapshotDataUrl } from '../../projectSnapshotValidation';
import { assertProjectModelProjectSettings, assertProjectModelSettingsPolicy, withProjectTextModel } from '../../projectModelSettings';
import { nativeChatImagePaths } from '../../../utils/chatImageReference';

export const NATIVE_PROJECT_DATABASE_NAME = 'ai-canvas-native-projects-v2' as const;
export const NATIVE_PROJECT_DATABASE_VERSION = 4 as const;
export const ROOTS = 'projectRoots', CONTENTS = 'projectContents', CANVASES = 'canvasDocuments';
export const EPISODES = 'episodes', EPISODE_CONTENTS = 'episodeContents';
export const RETIRED = 'retiredIds';
export const REVISIONS = 'projectRevisions';
export const EXCHANGE = 'nativeProjectExchange', TRANSFER = 'nativeTransferJournal';
export const MEDIA_TASK_STATUS_INDEX = 'mediaTaskStatus';
export const MEDIA_TASK_NODE_INDEX = 'mediaTaskNode';
export const MEDIA_TASK_MESSAGE_INDEX = 'mediaTaskMessage';
export const NATIVE_ASSET_BY_PROJECT = 'nativeAssetByProject';
const MEDIA_TASK_INDEXES = {
  [MEDIA_TASK_STATUS_INDEX]: ['kind', 'ownerProjectId', 'status', 'canvasId'],
  [MEDIA_TASK_NODE_INDEX]: ['kind', 'ownerProjectId', 'canvasId', 'nodeId'],
  [MEDIA_TASK_MESSAGE_INDEX]: ['kind', 'ownerProjectId', 'canvasId', 'origin.conversationId', 'origin.messageId'],
};
const EXCHANGE_INDEXES = { ...MEDIA_TASK_INDEXES, [NATIVE_ASSET_BY_PROJECT]: ['kind', 'record.projectId'] };
export const TRANSFER_BY_PROJECT_PHASE = 'transferByProjectKindPhase';
export const TRANSFER_BY_MODE_PHASE = 'transferByKindModePhase';
const TRANSFER_INDEXES = {
  [TRANSFER_BY_PROJECT_PHASE]: ['projectId', 'kind', 'phase'],
  [TRANSFER_BY_MODE_PHASE]: ['kind', 'mode', 'phase'],
};
export const canvasPreviewKey = (canvasId: string) => `canvas-preview:${canvasId}`;
export const STORES = [ROOTS, CONTENTS, CANVASES, EPISODES, EPISODE_CONTENTS, RETIRED, REVISIONS, EXCHANGE, TRANSFER] as const;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const projectIdPattern = new RegExp(`^p2-${uuid}$`);
const canvasIdPattern = new RegExp(`^c2-${uuid}$`);
const episodeIdPattern = new RegExp(`^e2-${uuid}$`);
export const rootRefPattern = new RegExp(`^r2-${uuid}$`);
export const recycleRequestIdPattern = new RegExp(`^${uuid}$`);

/** 前缀用于定位候选库，不能作为旧库没有同名记录的证明。 */
export const isNativeProjectId = (id: unknown): id is string => typeof id === 'string' && projectIdPattern.test(id);
export const isNativeCanvasId = (id: unknown): id is string => typeof id === 'string' && canvasIdPattern.test(id);
export const isNativeEpisodeId = (id: unknown): id is string => typeof id === 'string' && episodeIdPattern.test(id);
export interface NativeProjectAggregate {
  project: ProjectRecord; content: ProjectContent; canvas: CanvasDocument | null;
  episodes: EpisodeRecord[]; episodeContents: EpisodeContent[]; canvases: CanvasDocument[];
}
export interface NativeProjectOptions { factory?: IDBFactory; signal?: AbortSignal }
export interface NativeProjectCreateInput { name: string; kind?: 'standalone' | 'series'; projectId?: string; canvasId?: string; now?: number }

interface NativeCanvasPreviewRow extends CanvasPreview {
  projectId: string;
  ownerProjectId: string;
  kind: 'native-canvas-preview-v1';
}

function isNativePreviewSnapshot(value: unknown): value is string {
  return isProjectSnapshotDataUrl(value) && /^data:image\/(?:webp|png|jpeg);base64,/.test(value);
}

export function isNativeCanvasPreviewRow(value: unknown): value is NativeCanvasPreviewRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.kind === 'native-canvas-preview-v1' && isNativeProjectId(row.ownerProjectId) && isNativeCanvasId(row.canvasId)
    && row.projectId === canvasPreviewKey(row.canvasId) && isNativePreviewSnapshot(row.snapshot)
    && typeof row.updatedAt === 'number' && Number.isSafeInteger(row.updatedAt) && row.updatedAt >= 0;
}

export function obsoleteCanvasPreviewKeys(previous: CanvasDocument[], next: CanvasDocument[]): string[] {
  const remaining = new Map(next.map((canvas) => [canvas.id, canvas]));
  return previous.filter((canvas) => {
    const replacement = remaining.get(canvas.id);
    return !replacement || !configValuesEqual(canvas.nodes, replacement.nodes)
      || !configValuesEqual(canvas.edges, replacement.edges) || !configValuesEqual(canvas.groups, replacement.groups);
  }).map((canvas) => canvasPreviewKey(canvas.id));
}

export const fail = (code: string): never => { throw new Error(`新项目仓储不可用：${code}`); };
export const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error ?? new Error('indexeddb-request-failed'));
});

/** 复合索引的后续分量都是字符串；数组边界包含同前缀的任意字符串。 */
export function stringKeyPrefix(parts: readonly string[]): IDBKeyRange {
  return IDBKeyRange.bound([...parts], [...parts, []], false, true);
}

type TransferGuardRow = { kind?: string; phase?: string; operationId?: string; mode?: string };
export const isProjectReplacement = (row: TransferGuardRow) => row.mode === 'update-existing' || row.mode === 'restore-content';

/** 跳过已终结操作的索引区间，未知但可索引的阶段仍按未完成处理。 */
function openTransferRanges(projectId: string, kind: string): IDBKeyRange[] {
  const prefix = [projectId, kind];
  const aborted = [...prefix, 'aborted'], finalized = [...prefix, 'finalized'];
  return [IDBKeyRange.bound(prefix, aborted, true, true),
    IDBKeyRange.bound(aborted, finalized, true, true),
    IDBKeyRange.bound(finalized, [projectId, kind + '\0'], true, true)];
}

/** 未完成的跨库同步或更新在事务内冻结作品；只允许对应原操作结算。 */
export async function assertNoPendingNativeSharedSync(tx: IDBTransaction, projectId: string, exceptOperationId?: string): Promise<void> {
  const transfer = tx.objectStore(TRANSFER);
  const byProject = transfer.index('projectId'), byPhase = transfer.index(TRANSFER_BY_PROJECT_PHASE);
  const inProject = IDBKeyRange.bound([projectId], [projectId + '\0'], false, true);
  const [total, indexed] = await Promise.all([request(byProject.count(projectId)), request(byPhase.count(inProject))]);
  if (!total) return;
  const isForeign = (id: unknown) => !exceptOperationId || id !== exceptOperationId;
  if (total !== indexed) {
    // 旧库损坏或不完整记录可能未进入复合索引，保留原冻结判断。
    const rows = (await request(byProject.getAll(projectId)) as TransferGuardRow[])
      .filter((row) => isForeign(row.operationId) && row.phase !== 'finalized' && row.phase !== 'aborted');
    if (rows.some((row) => row.kind === 'native-shared-sync')) return fail('project-shared-sync-pending');
    if (rows.some((row) => row.kind === 'native-project-update' || row.kind === 'project-model-import' && isProjectReplacement(row))) {
      return fail('project-update-pending');
    }
    return;
  }
  const containsOther = async (kind: string) => {
    const keys = await Promise.all(openTransferRanges(projectId, kind).map((range) => request(byPhase.getAllKeys(range, exceptOperationId ? 2 : 1))));
    return keys.some((group) => group.some(isForeign));
  };
  const [sharedSync, legacyUpdate, imports] = await Promise.all([
    containsOther('native-shared-sync'),
    containsOther('native-project-update'),
    Promise.all(openTransferRanges(projectId, 'project-model-import').map((range) => request(byPhase.getAll(range)) as Promise<TransferGuardRow[]>)),
  ]);
  if (sharedSync) return fail('project-shared-sync-pending');
  if (legacyUpdate || imports.some((rows) => rows.some((row) => isForeign(row.operationId) && isProjectReplacement(row)))) {
    return fail('project-update-pending');
  }
}

/** 活动远端任务保留原项目代际；不能并发执行会使其无法续查的结构变更。 */
export async function assertNoPendingNativeMediaTasks(tx: IDBTransaction, projectId: string): Promise<void> {
  const rolePrefix = `character-image-task:${projectId}:`;
  const roleRows = await request(tx.objectStore(EXCHANGE).getAll(IDBKeyRange.bound(rolePrefix, `${rolePrefix}\uffff`))) as
    Array<{ kind?: string; ownerProjectId?: string; status?: string }>;
  if (roleRows.length > 100_000 || roleRows.some((row) => !row || row.kind !== 'native-character-image-v1'
    || row.ownerProjectId !== projectId || !['completed', 'failed', 'reviewed'].includes(row.status ?? ''))) {
    return fail('project-media-task-pending');
  }
  const index = tx.objectStore(EXCHANGE).index(MEDIA_TASK_STATUS_INDEX);
  const keys = await Promise.all(['native-editor-media-v1', 'native-media-task-v1'].flatMap((kind) =>
    ['prepared', 'submitted', 'outcome-unknown'].map((status) => request(index.getKey(stringKeyPrefix([kind, projectId, status]))))));
  if (keys.some((key) => key !== undefined)) return fail('project-media-task-pending');
}

function assertNativeProjectSchema(database: IDBDatabase, tx: IDBTransaction, version: number): void {
  if (database.name !== NATIVE_PROJECT_DATABASE_NAME
    || Array.from(database.objectStoreNames).sort().join('\0') !== [...STORES].sort().join('\0')) fail('unsupported-schema');
  for (const [name, keyPath] of [[ROOTS, 'id'], [CONTENTS, 'projectId'], [CANVASES, 'id'], [EPISODES, 'id'], [EPISODE_CONTENTS, 'episodeId'], [RETIRED, 'id'], [REVISIONS, 'projectId'], [EXCHANGE, 'projectId'], [TRANSFER, 'operationId']] as const) {
    const store = tx.objectStore(name);
    const expectedIndexes: Record<string, string | string[]> = name === TRANSFER
      ? { projectId: 'projectId', ...(version >= 4 ? TRANSFER_INDEXES : {}) }
      : name === CANVASES || name === EPISODES ? { projectId: 'projectId' }
      : name === EXCHANGE && version > 1 ? (version === 2 ? MEDIA_TASK_INDEXES : EXCHANGE_INDEXES) : {};
    if (store.keyPath !== keyPath || store.autoIncrement
      || Array.from(store.indexNames).join('\0') !== Object.keys(expectedIndexes).sort().join('\0')) fail('unsupported-schema');
    for (const [indexName, indexPath] of Object.entries(expectedIndexes)) {
      const index = store.index(indexName);
      if (!configValuesEqual(index.keyPath, indexPath) || index.unique || index.multiEntry) fail('unsupported-schema');
    }
  }
}

/** 不缓存连接；仅升级已有新库的索引，用只读入口时不会创建空库。 */
export async function openNativeProjectDatabase(create: boolean, options: NativeProjectOptions): Promise<IDBDatabase | null> {
  const factory = options.factory ?? globalThis.indexedDB;
  if (!factory) return fail('indexeddb-unavailable');
  options.signal?.throwIfAborted();
  const database = await new Promise<IDBDatabase | null>((resolve, reject) => {
    let settled = false;
    let missing = false;
    let upgradeFailure: unknown;
    let upgrade: IDBTransaction | undefined;
    const finish = (error?: unknown, result?: IDBDatabase | null) => {
      if (settled) { result?.close(); return; }
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result ?? null);
    };
    const abort = () => {
      try { upgrade?.abort(); } catch { /* 已提交的索引升级不能撤销 */ }
      finish(new DOMException('新项目操作已取消', 'AbortError'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    let opening: IDBOpenDBRequest;
    try { opening = factory.open(NATIVE_PROJECT_DATABASE_NAME, NATIVE_PROJECT_DATABASE_VERSION); }
    catch (error) { finish(error); return; }
    opening.onupgradeneeded = (event) => {
      if (settled || options.signal?.aborted || (!create && event.oldVersion === 0)) {
        missing = !create && event.oldVersion === 0;
        opening.transaction?.abort();
        return;
      }
      const db = opening.result;
      const transaction = opening.transaction!;
      upgrade = transaction;
      try {
        if (event.oldVersion === 0) {
          db.createObjectStore(ROOTS, { keyPath: 'id' });
          db.createObjectStore(CONTENTS, { keyPath: 'projectId' });
          db.createObjectStore(CANVASES, { keyPath: 'id' }).createIndex('projectId', 'projectId', { unique: false });
          db.createObjectStore(EPISODES, { keyPath: 'id' }).createIndex('projectId', 'projectId', { unique: false });
          db.createObjectStore(EPISODE_CONTENTS, { keyPath: 'episodeId' });
          db.createObjectStore(RETIRED, { keyPath: 'id' });
          db.createObjectStore(REVISIONS, { keyPath: 'projectId' });
          db.createObjectStore(EXCHANGE, { keyPath: 'projectId' });
          db.createObjectStore(TRANSFER, { keyPath: 'operationId' }).createIndex('projectId', 'projectId', { unique: false });
        } else if (![1, 2, 3].includes(event.oldVersion)) return fail('unsupported-schema');
        assertNativeProjectSchema(db, transaction, event.oldVersion || 1);
        const exchange = transaction.objectStore(EXCHANGE);
        for (const [name, keyPath] of Object.entries(EXCHANGE_INDEXES)) {
          if (!exchange.indexNames.contains(name)) exchange.createIndex(name, keyPath);
        }
        const transfer = transaction.objectStore(TRANSFER);
        for (const [name, keyPath] of Object.entries(TRANSFER_INDEXES)) transfer.createIndex(name, keyPath);
      } catch (error) {
        upgradeFailure = error;
        transaction.abort();
      }
    };
    opening.onerror = () => missing && !settled ? finish(undefined, null)
      : finish(upgradeFailure ?? (opening.error?.name === 'VersionError' ? new Error('新项目仓储不可用：unsupported-schema') : opening.error)
        ?? new Error('indexeddb-open-failed'));
    opening.onblocked = () => finish(new Error('indexeddb-open-blocked'));
    opening.onsuccess = () => finish(undefined, opening.result);
  });
  if (!database) return null;
  try {
    if (database.version !== NATIVE_PROJECT_DATABASE_VERSION) fail('unsupported-schema');
    assertNativeProjectSchema(database, database.transaction([...STORES], 'readonly'), database.version);
    database.onversionchange = () => database.close();
    return database;
  } catch (error) { database.close(); throw error; }
}

export function transact<T>(database: IDBDatabase, mode: IDBTransactionMode, options: NativeProjectOptions,
  work: (tx: IDBTransaction) => Promise<T>, stores: readonly string[] = STORES, strict = false, onCommitted?: (result: T) => void): Promise<T> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const tx = strict ? database.transaction([...stores], mode, { durability: 'strict' }) : database.transaction([...stores], mode);
    let result: T | undefined, failure: unknown, complete = false;
    const abort = () => { try { tx.abort(); } catch { /* 已提交事务不能撤销 */ } };
    options.signal?.addEventListener('abort', abort, { once: true });
    tx.oncomplete = () => {
      options.signal?.removeEventListener('abort', abort);
      if (!complete) { reject(new Error('indexeddb-result-missing')); return; }
      try { onCommitted?.(result as T); }
      catch (error) { reject(new Error('数据已提交，但本机视图投影失败；原回执已保留', { cause: error })); return; }
      resolve(result as T);
    };
    tx.onabort = () => { options.signal?.removeEventListener('abort', abort); reject(failure ?? tx.error ?? new DOMException('新项目事务已取消', 'AbortError')); };
    try {
      void work(tx).then((value) => { result = value; complete = true; }, (error: unknown) => {
        failure = error;
        try { tx.abort(); } catch { /* 原事务已结束，保留原错误 */ }
      });
    } catch (error) { failure = error; try { tx.abort(); } catch { reject(error); } }
  });
}

/** 项目卡片只读派生预览与活动身份键，避免读取任何画布正文。 */
export async function readNativeCanvasPreviews(targets: readonly { projectId: string; canvasId: string }[],
  options: NativeProjectOptions = {}): Promise<Map<string, CanvasPreview>> {
  const previews = new Map<string, CanvasPreview>();
  if (!targets.length) return previews;
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return previews;
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      await Promise.all(targets.map(async ({ projectId, canvasId }) => {
        if (!isNativeProjectId(projectId) || !isNativeCanvasId(canvasId)) return;
        const key = canvasPreviewKey(canvasId);
        const [project, canvas, row] = await Promise.all([
          request(tx.objectStore(ROOTS).getKey(projectId)), request(tx.objectStore(CANVASES).getKey(canvasId)),
          request<unknown>(tx.objectStore(EXCHANGE).get(key)),
        ]);
        if (project === projectId && canvas === canvasId && isNativeCanvasPreviewRow(row)
          && row.ownerProjectId === projectId && row.canvasId === canvasId) {
          previews.set(canvasId, { canvasId, snapshot: row.snapshot, updatedAt: row.updatedAt });
        }
      }));
      return previews;
    }, [ROOTS, CANVASES, EXCHANGE]);
  } finally { database.close(); }
}

/** 预览独立持久化，事务复核画布归属和代际，正文、交换版本与排序时间保持原值。 */
export async function saveNativeCanvasPreview(input: { projectId: string; canvasId: string; expectedCanvasEpoch: number; snapshot?: string },
  options: NativeProjectOptions = {}): Promise<void> {
  const { projectId, canvasId, expectedCanvasEpoch, snapshot } = input;
  if (!isNativeProjectId(projectId) || !isNativeCanvasId(canvasId) || !Number.isSafeInteger(expectedCanvasEpoch) || expectedCanvasEpoch < 0
    || snapshot !== undefined && !isNativePreviewSnapshot(snapshot)) return fail('invalid-canvas-preview');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    await transact(database, 'readwrite', options, async (tx) => {
      const [project, canvas] = await Promise.all([
        request(tx.objectStore(ROOTS).getKey(projectId)),
        request(tx.objectStore(CANVASES).get(canvasId)) as Promise<CanvasDocument | undefined>,
      ]);
      if (project !== projectId || !canvas || canvas.id !== canvasId || canvas.projectId !== projectId
        || canvas.epoch !== expectedCanvasEpoch) return fail('canvas-version-conflict');
      const store = tx.objectStore(EXCHANGE), key = canvasPreviewKey(canvasId);
      if (snapshot === undefined) await request(store.delete(key));
      else await request(store.put({ projectId: key, kind: 'native-canvas-preview-v1', ownerProjectId: projectId,
        canvasId, snapshot, updatedAt: Date.now() } satisfies NativeCanvasPreviewRow));
    }, [ROOTS, CANVASES, EXCHANGE]);
  } finally { database.close(); }
}

function hasNativeRootBindings(project: ProjectRecord): boolean {
  return !!project && isNativeProjectId(project.id) && ['standalone', 'series'].includes(project.kind)
    && typeof project.storageRootRef === 'string' && rootRefPattern.test(project.storageRootRef)
    && project.dataFolder === `project-${project.id}` && Array.isArray(project.storageBindings)
    && project.storageBindings.every((binding) => binding && typeof binding.rootRef === 'string'
      && rootRefPattern.test(binding.rootRef) && binding.source === 'project-managed'
      && binding.folderName === (binding.rootRef === project.storageRootRef
        ? project.dataFolder : `${project.dataFolder}/roots/${binding.rootRef}`))
    && new Set(project.storageBindings.map((binding) => binding.rootRef)).size === project.storageBindings.length
    && project.storageBindings.some((binding) => binding.rootRef === project.storageRootRef);
}

export function assertNativeRoot(project: ProjectRecord): void {
  if (!hasNativeRootBindings(project)) fail('invalid-membership');
}

export function validateAggregate(project: ProjectRecord, content: ProjectContent, episodes: EpisodeRecord[],
  episodeContents: EpisodeContent[], canvases: CanvasDocument[]): NativeProjectAggregate {
  assertNativeRoot(project);
  if (!Array.isArray(canvases) || !Array.isArray(episodes)
    || canvases.some((canvas) => !isNativeCanvasId(canvas.id) || !project.storageBindings.some((binding) => binding.rootRef === canvas.storageRootRef))
    || episodes.some((episode) => !isNativeEpisodeId(episode.id) || !isNativeCanvasId(episode.canvasId))) fail('invalid-membership');
  const checked = validateProjectModelTransferAggregate({ project, content, episodes, episodeContents, canvases, previews: [], bindings: [] });
  const ordered = [...checked.episodes].sort((a, b) => a.orderRank - b.orderRank);
  const selectedId = checked.project.lastOpenedCanvasId ?? (checked.project.kind === 'standalone' ? checked.canvases[0]?.id : ordered[0]?.canvasId);
  return { project: checked.project, content: checked.content, episodes: ordered, episodeContents: checked.episodeContents,
    canvases: checked.canvases, canvas: checked.canvases.find((canvas) => canvas.id === selectedId) ?? null };
}

export async function readInTransaction(tx: IDBTransaction, projectId: string): Promise<NativeProjectAggregate | null> {
  const [project, content, canvases, episodes] = await Promise.all([
    request(tx.objectStore(ROOTS).get(projectId)) as Promise<ProjectRecord | undefined>,
    request(tx.objectStore(CONTENTS).get(projectId)) as Promise<ProjectContent | undefined>,
    request(tx.objectStore(CANVASES).index('projectId').getAll(projectId)) as Promise<CanvasDocument[]>,
    request(tx.objectStore(EPISODES).index('projectId').getAll(projectId)) as Promise<EpisodeRecord[]>,
  ]);
  if (!project && !content && !canvases.length && !episodes.length) return null;
  if (!project || !content) return fail('incomplete-project');
  const episodeContents = await Promise.all(episodes.map((episode) => request(tx.objectStore(EPISODE_CONTENTS).get(episode.id)) as Promise<EpisodeContent | undefined>));
  if (episodeContents.some((entry) => !entry)) return fail('incomplete-project');
  return validateAggregate(project, content, episodes, episodeContents as EpisodeContent[], canvases);
}

/** 用单事务创建根、正文和主画布；任一身份占用或写入失败时整项回滚。 */
export async function createNativeProject(input: NativeProjectCreateInput, options: NativeProjectOptions = {}): Promise<NativeProjectAggregate> {
  options.signal?.throwIfAborted();
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 256
    || input.kind !== undefined && input.kind !== 'standalone' && input.kind !== 'series'
    || hasControlCharacters(input.name)) return fail('invalid-name');
  const projectId = input.projectId ?? `p2-${crypto.randomUUID()}`;
  const canvasId = input.kind === 'series' ? undefined : input.canvasId ?? `c2-${crypto.randomUUID()}`;
  const now = input.now ?? Date.now();
  if (!isNativeProjectId(projectId) || input.kind === 'series' && input.canvasId !== undefined
    || canvasId !== undefined && !isNativeCanvasId(canvasId) || !Number.isSafeInteger(now) || now < 0) return fail('invalid-identity');
  const rootRef = `r2-${projectId.slice(3)}`, folderName = `project-${projectId}`;
  const project: ProjectRecord = { id: projectId, name: input.name.trim(), kind: input.kind ?? 'standalone', createdAt: now, updatedAt: now,
    epoch: 1, dataFolder: folderName, storageRootRef: rootRef, ...(canvasId ? { lastOpenedCanvasId: canvasId } : {}),
    storageBindings: [{ rootRef, folderName, sourceRecordIds: [], source: 'project-managed' }] };
  const content: ProjectContent = { projectId, revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } };
  const canvases: CanvasDocument[] = canvasId ? [{ id: canvasId, projectId, episodeId: null, storageRootRef: rootRef,
    nodes: [], edges: [], groups: [], epoch: 1, revision: 0, revisionScope: 'project' }] : [];
  const aggregate = validateAggregate(project, content, [], [], canvases);
  const database = await openNativeProjectDatabase(true, options);
  if (!database) return fail('open-failed');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      const retired = await Promise.all([request(tx.objectStore(RETIRED).get(projectId)),
        ...aggregate.canvases.map((canvas) => request(tx.objectStore(RETIRED).get(canvas.id)))]);
      if (retired.some((item) => item !== undefined)) return fail('retired-identity');
      await Promise.all([request(tx.objectStore(ROOTS).add(aggregate.project)), request(tx.objectStore(CONTENTS).add(aggregate.content)),
        ...aggregate.canvases.map((canvas) => request(tx.objectStore(CANVASES).add(canvas))),
        request(tx.objectStore(REVISIONS).add({ projectId, changeRevision: 0 }))]);
      return aggregate;
    });
  } finally { database.close(); }
}

export interface NativeProjectIdentities { project: ProjectRecord; episodeIds: string[]; canvasIds: string[]; episodes: EpisodeRecord[] }
interface NativeIdentityCatalog { entries: NativeProjectIdentities[]; unavailableIds: Set<string> }

/** 只读取项目根、分集摘要及画布键，打开时重新核验具体实体关系。 */
async function scanNativeProjectIdentities(options: NativeProjectOptions, isolateInvalidProjects: boolean): Promise<NativeIdentityCatalog> {
  const unavailableIds = new Set<string>();
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return { entries: [], unavailableIds };
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const memberLimit = 1_000_000;
      const canvasStore = tx.objectStore(CANVASES);
      const memberships = new Promise<Array<{ projectId: IDBValidKey; id: IDBValidKey }>>((resolve, reject) => {
        const items: Array<{ projectId: IDBValidKey; id: IDBValidKey }> = [];
        const cursor = canvasStore.index('projectId').openKeyCursor();
        cursor.onsuccess = () => {
          if (!cursor.result) { resolve(items); return; }
          if (items.length >= memberLimit) { reject(new Error('新项目仓储不可用：catalog-limit')); return; }
          items.push({ projectId: cursor.result.key, id: cursor.result.primaryKey });
          cursor.result.continue();
        };
        cursor.onerror = () => reject(cursor.error ?? new Error('indexeddb-index-failed'));
      });
      const [projects, episodes, canvases, canvasCount] = await Promise.all([
        request(tx.objectStore(ROOTS).getAll(undefined, 200_001)) as Promise<ProjectRecord[]>,
        request(tx.objectStore(EPISODES).getAll(undefined, memberLimit + 1)) as Promise<EpisodeRecord[]>,
        memberships, request(canvasStore.count()),
      ]);
      if (projects.length > 200_000 || episodes.length > memberLimit || canvasCount > memberLimit) return fail('catalog-limit');
      const entries = new Map<string, NativeProjectIdentities>();
      const invalidOwners = new Set<string>();
      const invalidate = (code: string, owner: unknown, id?: unknown) => {
        if (!isolateInvalidProjects) fail(code);
        if (typeof owner === 'string') { invalidOwners.add(owner); unavailableIds.add(owner); }
        if (typeof id === 'string') unavailableIds.add(id);
      };
      for (const project of projects) {
        if (!project || !isNativeProjectId(project.id) || entries.has(project.id) || !['standalone', 'series'].includes(project.kind)
          || typeof project.name !== 'string' || !project.name.trim()
          || ![project.createdAt, project.updatedAt, project.epoch].every((value) => Number.isSafeInteger(value) && value >= 0)
          || project.lastOpenedCanvasId !== undefined && !isNativeCanvasId(project.lastOpenedCanvasId)) {
          invalidate('invalid-project-list', project?.id);
          continue;
        }
        if (!hasNativeRootBindings(project)) invalidate('invalid-membership', project.id);
        try { if (project.defaultSettings !== undefined) assertProjectModelProjectSettings(project.defaultSettings); }
        catch { invalidate('invalid-project-list', project.id); }
        entries.set(project.id, { project, episodeIds: [], canvasIds: [], episodes: [] });
      }
      for (const entry of episodes) {
        const target = entries.get(entry.projectId);
        if (!target || !isNativeEpisodeId(entry.id) || !isNativeCanvasId(entry.canvasId)
          || typeof entry.name !== 'string' || !entry.name.trim()
          || ![entry.orderRank, entry.createdAt, entry.updatedAt, entry.epoch, entry.revision].every((value) => Number.isSafeInteger(value) && value >= 0)
          || entry.displayNo !== undefined && (!Number.isSafeInteger(entry.displayNo) || entry.displayNo < 1)) {
          invalidate('invalid-membership', entry.projectId, entry.id);
          continue;
        }
        try { assertProjectModelSettingsPolicy(entry.settingsPolicy); }
        catch { invalidate('invalid-membership', entry.projectId, entry.id); }
        target.episodeIds.push(entry.id); target.episodes.push(entry);
      }
      if (canvasCount !== canvases.length) {
        invalidate('invalid-membership', undefined);
        const indexedKeys = new Set(canvases.map(({ id }) => id));
        for (const id of await request(canvasStore.getAllKeys())) {
          if (typeof id === 'string' && !indexedKeys.has(id)) unavailableIds.add(id);
        }
      }
      for (const entry of canvases) {
        const target = typeof entry.projectId === 'string' && entries.get(entry.projectId);
        if (!target || !isNativeCanvasId(entry.id)) {
          invalidate('invalid-membership', entry.projectId, entry.id);
          continue;
        }
        target.canvasIds.push(entry.id);
      }
      for (const value of entries.values()) {
        const canvasIds = new Set(value.canvasIds);
        if ((value.project.kind === 'standalone' ? value.episodeIds.length !== 0 || value.canvasIds.length !== 1
          : value.canvasIds.length !== value.episodeIds.length)
          || new Set(value.episodes.map((episode) => episode.orderRank)).size !== value.episodes.length
          || new Set(value.episodes.map((episode) => episode.canvasId)).size !== value.episodes.length
          || value.episodes.some((episode) => !canvasIds.has(episode.canvasId))
          || value.project.lastOpenedCanvasId && !canvasIds.has(value.project.lastOpenedCanvasId)) {
          invalidate('invalid-membership', value.project.id);
        }
        value.episodes.sort((a, b) => a.orderRank - b.orderRank);
      }
      for (const owner of invalidOwners) {
        const value = entries.get(owner);
        if (value) [...value.episodeIds, ...value.canvasIds].forEach((id) => unavailableIds.add(id));
        entries.delete(owner);
      }
      if (invalidOwners.size) {
        // 缺失画布的导航别名仍属原作品，已存在的画布以自身主键和归属为准。
        const existingCanvases = new Set(canvases.map(({ id }) => id));
        for (const row of [...projects, ...episodes]) {
          const [owner, canvas] = 'canvasId' in row ? [row.projectId, row.canvasId] : [row.id, row.lastOpenedCanvasId];
          if (invalidOwners.has(owner) && isNativeCanvasId(canvas) && !existingCanvases.has(canvas)) unavailableIds.add(canvas);
        }
      }
      // 损坏记录的实际主键可能占用别类对象的身份，关联作品也必须停用。
      for (const [id, value] of entries) {
        const ids = [id, ...value.episodeIds, ...value.canvasIds];
        if (!ids.some((key) => unavailableIds.has(key))) continue;
        ids.forEach((key) => unavailableIds.add(key));
        entries.delete(id);
      }
      return { entries: [...entries.values()], unavailableIds };
    }, [ROOTS, EPISODES, CANVASES]);
  } finally { database.close(); }
}

/** 全量核对与清理需要完整目录；任一成员损坏时停止。 */
export async function listNativeProjectIdentities(options: NativeProjectOptions = {}): Promise<NativeProjectIdentities[]> {
  return (await scanNativeProjectIdentities(options, false)).entries;
}

/** 浏览及打开单个作品时隔离损坏作品，并保留其身份用于拒绝旧库回退。 */
export function readNativeProjectIdentityCatalog(options: NativeProjectOptions = {}): Promise<NativeIdentityCatalog> {
  return scanNativeProjectIdentities(options, true);
}

/** 未找到返回 null；不创建缺失库，不查询或回退到旧库。 */
export async function readNativeProject(projectId: string, options: NativeProjectOptions = {}): Promise<NativeProjectAggregate | null> {
  if (!isNativeProjectId(projectId)) return fail('invalid-project-id');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return null;
  try { return await transact(database, 'readonly', options, (tx) => readInTransaction(tx, projectId)); }
  finally { database.close(); }
}

/** 捕获整个项目及统一变化版本；素材闭包和实际归档发布须单独核验。 */
export async function readNativeProjectCapture(projectId: string, options: NativeProjectOptions = {}):
Promise<{ aggregate: NativeProjectAggregate; changeRevision: number; exchange: ProjectModelTransferExchange | null; includesHistory: false } | null> {
  if (!isNativeProjectId(projectId)) return fail('invalid-project-id');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return null;
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const aggregate = await readInTransaction(tx, projectId);
      const revision = await request(tx.objectStore(REVISIONS).get(projectId)) as { projectId: string; changeRevision: number } | undefined;
      const exchange: unknown = await request(tx.objectStore(EXCHANGE).get(projectId));
      if (!aggregate && !revision && exchange === undefined) return null;
      if (!aggregate && !revision) {
        const retired = await request(tx.objectStore(RETIRED).get(projectId)) as { id?: string; projectId?: string; kind?: string } | undefined;
        if (retired?.id === projectId && retired.projectId === projectId && retired.kind === 'project') return null;
      }
      if (!aggregate || !revision || revision.projectId !== projectId || !Number.isSafeInteger(revision.changeRevision)
        || revision.changeRevision < 0) return fail('invalid-project-revision');
      if (exchange !== undefined && (!exchange || typeof exchange !== 'object'
        || (exchange as { projectId?: unknown }).projectId !== projectId
        || !(exchange as { exchange?: unknown }).exchange)) return fail('invalid-exchange-record');
      return { aggregate, changeRevision: revision.changeRevision,
        exchange: readNativeProjectExchange(exchange === undefined ? null : (exchange as { exchange: ProjectModelTransferExchange }).exchange), includesHistory: false };
    });
  } finally { database.close(); }
}

/** 助手附件展示只读取主根与归档文件绑定，无需加载整剧画布和正文。 */
export async function readNativeProjectChatImagePaths(projectId: string, options: NativeProjectOptions = {}): Promise<Map<string, string>> {
  if (!isNativeProjectId(projectId)) return fail('invalid-project-id');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const [project, row] = await Promise.all([
        request(tx.objectStore(ROOTS).get(projectId)) as Promise<ProjectRecord | undefined>,
        request(tx.objectStore(EXCHANGE).get(projectId)) as Promise<{ projectId: string; exchange: ProjectModelTransferExchange } | undefined>,
      ]);
      if (!project || project.id !== projectId) return fail('project-not-found');
      assertNativeRoot(project);
      if (row !== undefined && (row?.projectId !== projectId || !row.exchange)) return fail('invalid-exchange-record');
      return nativeChatImagePaths(project.storageRootRef, readNativeProjectExchange(row?.exchange ?? null));
    }, [ROOTS, EXCHANGE]);
  } finally { database.close(); }
}

export interface NativeProjectSelection {
  project: ProjectRecord;
  episodes: EpisodeRecord[];
  episode: EpisodeRecord | null;
  canvas: CanvasDocument | null;
  changeRevision: number;
  context: { projectId: string; projectEpoch: number; episodeId: string | null; canvasId: string | null;
    canvasEpoch: number | null; canvasRevision: number | null };
}

export function validateContentSlice(project: ProjectRecord, content: ProjectContent, canvasKeys: IDBValidKey[]): ProjectContent {
  assertNativeRoot(project);
  const scopedProject = { ...project }; delete scopedProject.lastOpenedCanvasId;
  const placeholderId = project.kind === 'standalone' && canvasKeys.length === 1 && isNativeCanvasId(canvasKeys[0]) ? canvasKeys[0] : undefined;
  if (project.kind === 'standalone' && !placeholderId) return fail('invalid-membership');
  const placeholder: CanvasDocument[] = placeholderId ? [{ id: placeholderId, projectId: project.id, episodeId: null,
    storageRootRef: project.storageRootRef, nodes: [], edges: [], groups: [], epoch: 0, revision: 0, revisionScope: 'project' }] : [];
  return validateProjectModelTransferAggregate({ project: scopedProject, content, episodes: [], episodeContents: [],
    canvases: placeholder, previews: [], bindings: [] }).content;
}

/** 项目元数据与一张画布的选择；不读取共享正文或其他分集的画布／正文。 */
export async function readNativeProjectSelection(projectId: string, requestedCanvasId?: string,
  options: NativeProjectOptions = {}): Promise<NativeProjectSelection | null> {
  if (!isNativeProjectId(projectId) || requestedCanvasId !== undefined && !isNativeCanvasId(requestedCanvasId)) return fail('invalid-identity');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return null;
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const [project, episodes, canvasKeys, revision] = await Promise.all([
        request(tx.objectStore(ROOTS).get(projectId)) as Promise<ProjectRecord | undefined>,
        request(tx.objectStore(EPISODES).index('projectId').getAll(projectId)) as Promise<EpisodeRecord[]>,
        request(tx.objectStore(CANVASES).index('projectId').getAllKeys(projectId)),
        request(tx.objectStore(REVISIONS).get(projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
      ]);
      if (!project && !episodes.length && !canvasKeys.length && !revision) return null;
      if (!project || project.id !== projectId || !revision || revision.projectId !== projectId
        || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0
        || !['standalone', 'series'].includes(project.kind)) return fail('invalid-membership');
      assertNativeRoot(project);
      const keys = new Set<string>();
      for (const key of canvasKeys) {
        if (!isNativeCanvasId(key) || keys.has(key)) return fail('invalid-membership');
        keys.add(key);
      }
      const ranks = new Set<number>(), ids = new Set<string>(), episodeCanvases = new Set<string>();
      for (const item of episodes) {
        if (!isNativeEpisodeId(item.id) || item.projectId !== projectId || !isNativeCanvasId(item.canvasId)
          || ids.has(item.id) || episodeCanvases.has(item.canvasId) || !keys.has(item.canvasId)
          || !Number.isSafeInteger(item.orderRank) || item.orderRank < 0 || ranks.has(item.orderRank)) return fail('invalid-membership');
        ids.add(item.id); episodeCanvases.add(item.canvasId); ranks.add(item.orderRank);
      }
      if (project.kind === 'standalone' ? episodes.length !== 0 || keys.size !== 1 : keys.size !== episodes.length) return fail('invalid-membership');
      if (project.lastOpenedCanvasId !== undefined && !keys.has(project.lastOpenedCanvasId)) return fail('invalid-membership');
      const ordered = [...episodes].sort((a, b) => a.orderRank - b.orderRank);
      const canvasId = requestedCanvasId ?? project.lastOpenedCanvasId ?? (project.kind === 'standalone' ? [...keys][0] : ordered[0]?.canvasId);
      if (requestedCanvasId && !keys.has(requestedCanvasId)) return fail('canvas-not-in-project');
      const canvas = canvasId ? await request(tx.objectStore(CANVASES).get(canvasId)) as CanvasDocument | undefined : undefined;
      if (canvasId && (!canvas || canvas.id !== canvasId || canvas.projectId !== projectId)) return fail('invalid-membership');
      const episode = canvas && project.kind === 'series' ? ordered.find((item) => item.canvasId === canvas.id) : undefined;
      if (canvas && (project.kind === 'standalone' ? canvas.episodeId !== null : !episode || canvas.episodeId !== episode.id)) return fail('invalid-membership');
      // 使用限定的单集视图执行现有字段验证；不能把该视图当作整剧快照。
      const scopedProject: ProjectRecord = { ...project, ...(canvas ? { lastOpenedCanvasId: canvas.id } : {}) };
      if (!canvas) delete scopedProject.lastOpenedCanvasId;
      const scopedContent: ProjectContent = { projectId, revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } };
      validateProjectModelTransferAggregate({ project: scopedProject, content: scopedContent, episodes: episode ? [episode] : [],
        episodeContents: episode ? [{ episodeId: episode.id, revision: 0, storageRootRef: project.storageRootRef }] : [],
        canvases: canvas ? [canvas] : [], previews: [], bindings: [] });
      return { project, episodes: ordered, episode: episode ?? null, canvas: canvas ?? null, changeRevision: revision.changeRevision,
        context: { projectId, projectEpoch: project.epoch, episodeId: episode?.id ?? null, canvasId: canvas?.id ?? null,
          canvasEpoch: canvas?.epoch ?? null, canvasRevision: canvas?.revision ?? null } };
    }, [ROOTS, EPISODES, CANVASES, REVISIONS]);
  } finally { database.close(); }
}

/** 只读共享资料；不会读取任何分集正文或画布内容。 */
export async function readNativeProjectContent(projectId: string, options: NativeProjectOptions = {}):
Promise<{ project: ProjectRecord; content: ProjectContent; changeRevision: number } | null> {
  if (!isNativeProjectId(projectId)) return fail('invalid-project-id');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return null;
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const [project, content, revision, canvasKeys] = await Promise.all([
        request(tx.objectStore(ROOTS).get(projectId)) as Promise<ProjectRecord | undefined>,
        request(tx.objectStore(CONTENTS).get(projectId)) as Promise<ProjectContent | undefined>,
        request(tx.objectStore(REVISIONS).get(projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
        request(tx.objectStore(CANVASES).index('projectId').getAllKeys(projectId)),
      ]);
      if (!project && !content && !revision && !canvasKeys.length) return null;
      if (!project || !content || !revision || revision.projectId !== projectId || !Number.isSafeInteger(revision.changeRevision)
        || revision.changeRevision < 0 || project.id !== projectId || content.projectId !== projectId) return fail('invalid-membership');
      // 用仅含身份的临时画布验证共享内容字段；不会读取或写入该临时画布。
      return { project, content: validateContentSlice(project, content, canvasKeys), changeRevision: revision.changeRevision };
    }, [ROOTS, CONTENTS, CANVASES, REVISIONS]);
  } finally { database.close(); }
}

/** 只找指定的 (作品, 画布) 索引项，避免逐集复制整部作品的主键列表。 */
function nativeCanvasBelongsToProject(index: IDBIndex, projectId: string, canvasId: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const cursor = index.openKeyCursor(IDBKeyRange.only(projectId));
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (item && typeof item.primaryKey === 'string' && item.primaryKey < canvasId) {
        item.continuePrimaryKey(projectId, canvasId);
      } else {
        resolve(item?.primaryKey === canvasId);
      }
    };
  });
}

/** 只读指定分集的稿件与元数据；画布成员身份由项目索引核对，不读取画布正文。 */
export async function readNativeEpisodeContent(projectId: string, episodeId: string, options: NativeProjectOptions = {}):
Promise<{ project: ProjectRecord; episode: EpisodeRecord; content: EpisodeContent; changeRevision: number } | null> {
  if (!isNativeProjectId(projectId) || !isNativeEpisodeId(episodeId)) return fail('invalid-identity');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return null;
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const [project, episode, content, revision] = await Promise.all([
        request(tx.objectStore(ROOTS).get(projectId)) as Promise<ProjectRecord | undefined>,
        request(tx.objectStore(EPISODES).get(episodeId)) as Promise<EpisodeRecord | undefined>,
        request(tx.objectStore(EPISODE_CONTENTS).get(episodeId)) as Promise<EpisodeContent | undefined>,
        request(tx.objectStore(REVISIONS).get(projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
      ]);
      if (!project && !episode && !content && !revision) return null;
      if (!project || project.id !== projectId || project.kind !== 'series' || !episode || episode.id !== episodeId
        || episode.projectId !== projectId || !content || content.episodeId !== episodeId || !revision || revision.projectId !== projectId
        || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0 || !isNativeCanvasId(episode.canvasId)
        || !await nativeCanvasBelongsToProject(tx.objectStore(CANVASES).index('projectId'), projectId, episode.canvasId)) {
        return fail('invalid-membership');
      }
      assertNativeRoot(project);
      const scopedProject: ProjectRecord = { ...project, lastOpenedCanvasId: episode.canvasId };
      const placeholder: CanvasDocument = { id: episode.canvasId, projectId, episodeId, storageRootRef: project.storageRootRef,
        nodes: [], edges: [], groups: [], epoch: 0, revision: 0, revisionScope: 'project' };
      const blank: ProjectContent = { projectId, revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } };
      const checked = validateProjectModelTransferAggregate({ project: scopedProject, content: blank, episodes: [episode],
        episodeContents: [content], canvases: [placeholder], previews: [], bindings: [] });
      return { project, episode: checked.episodes[0], content: checked.episodeContents[0], changeRevision: revision.changeRevision };
    }, [ROOTS, EPISODES, EPISODE_CONTENTS, CANVASES, REVISIONS]);
  } finally { database.close(); }
}

/** 共享资料按域条件更新；画布和其他分集正文不被读入或覆盖。 */
export async function saveNativeProjectContent(input: {
  projectId: string; expectedProjectEpoch: number;
  expectedRevisions: Partial<ProjectContent['revisions']>;
  patch: Partial<Pick<ProjectContent, 'originalWork' | 'script' | 'storyGraph' | 'dramaAssets'>>;
  now?: number;
}, options: NativeProjectOptions = {}): Promise<{ content: ProjectContent; changeRevision: number }> {
  const fixed = structuredClone(input), now = timestamp(fixed.now);
  if (!isNativeProjectId(fixed.projectId) || !Number.isSafeInteger(fixed.expectedProjectEpoch) || fixed.expectedProjectEpoch < 0
    || !fixed.patch || !fixed.expectedRevisions || typeof fixed.patch !== 'object' || Array.isArray(fixed.patch)
    || typeof fixed.expectedRevisions !== 'object' || Array.isArray(fixed.expectedRevisions)) return fail('invalid-project-content');
  const fields = { originalWork: 'source', script: 'script', storyGraph: 'storyGraph', dramaAssets: 'assets' } as const;
  const keys = Object.keys(fixed.patch) as Array<keyof typeof fields>;
  if (!keys.length || keys.some((key) => !Object.hasOwn(fields, key))
    || Object.keys(fixed.expectedRevisions).some((key) => !Object.values(fields).includes(key as keyof ProjectContent['revisions']))) {
    return fail('invalid-project-content');
  }
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      await assertNoPendingNativeSharedSync(tx, fixed.projectId);
      const [project, content, revision, canvasKeys] = await Promise.all([
        request(tx.objectStore(ROOTS).get(fixed.projectId)) as Promise<ProjectRecord | undefined>,
        request(tx.objectStore(CONTENTS).get(fixed.projectId)) as Promise<ProjectContent | undefined>,
        request(tx.objectStore(REVISIONS).get(fixed.projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
        request(tx.objectStore(CANVASES).index('projectId').getAllKeys(fixed.projectId)),
      ]);
      if (!project || !content || project.id !== fixed.projectId || content.projectId !== fixed.projectId || !revision
        || revision.projectId !== fixed.projectId || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0) return fail('invalid-membership');
      if (project.epoch !== fixed.expectedProjectEpoch) return fail('project-version-conflict');
      validateContentSlice(project, content, canvasKeys);
      const revisions = { ...content.revisions };
      for (const key of keys) {
        const domain = fields[key], expected = fixed.expectedRevisions[domain];
        if (!Number.isSafeInteger(expected) || expected !== revisions[domain]) return fail('content-version-conflict');
        revisions[domain] = increment(revisions[domain]);
      }
      const next = validateContentSlice(project, { ...content, ...fixed.patch, revisions }, canvasKeys);
      const changeRevision = increment(revision.changeRevision);
      await Promise.all([request(tx.objectStore(CONTENTS).put(next)),
        request(tx.objectStore(ROOTS).put({ ...project, updatedAt: now })),
        request(tx.objectStore(REVISIONS).put({ projectId: fixed.projectId, changeRevision }))]);
      return { content: next, changeRevision };
    }, [ROOTS, CONTENTS, CANVASES, REVISIONS, TRANSFER]);
  } finally { database.close(); }
}

/** 主画布可反查所属项目；分集地址尚需专门的关系与内容读取合同。 */
export async function readNativeProjectByCanvasId(canvasId: string, options: NativeProjectOptions = {}): Promise<NativeProjectAggregate | null> {
  if (!isNativeCanvasId(canvasId)) return fail('invalid-canvas-id');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return null;
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const canvas = await request(tx.objectStore(CANVASES).get(canvasId)) as CanvasDocument | undefined;
      if (!canvas) return null;
      if (!isNativeProjectId(canvas.projectId)) return fail('invalid-membership');
      const result = await readInTransaction(tx, canvas.projectId);
      const selected = result?.canvases.find((item) => item.id === canvasId);
      if (!result || !selected) return fail('invalid-membership');
      return { ...result, canvas: selected };
    });
  } finally { database.close(); }
}

interface NativeOutputHistoryTarget {
  project: Pick<ProjectRecord, 'id' | 'epoch' | 'storageRootRef' | 'storageBindings'>;
  canvas: Pick<CanvasDocument, 'id' | 'epoch' | 'episodeId' | 'storageRootRef'>;
}

/** 生成记录只依赖当前画布身份及素材绑定，按主键核对其所属分集。 */
export async function readNativeOutputHistoryTarget(canvasId: string, options: NativeProjectOptions = {}): Promise<NativeOutputHistoryTarget | null> {
  if (!isNativeCanvasId(canvasId)) return fail('invalid-canvas-id');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return null;
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const canvas = await request(tx.objectStore(CANVASES).get(canvasId)) as CanvasDocument | undefined;
      if (!canvas) return null;
      const { projectId, episodeId } = canvas;
      if (canvas.id !== canvasId || !isNativeProjectId(projectId) || (episodeId !== null && !isNativeEpisodeId(episodeId))) return fail('invalid-membership');
      const [project, episode] = await Promise.all([
        request(tx.objectStore(ROOTS).get(projectId)) as Promise<ProjectRecord | undefined>,
        episodeId === null ? null : request(tx.objectStore(EPISODES).get(episodeId)) as Promise<EpisodeRecord | undefined>,
      ]);
      if (!project || project.id !== projectId
        || (project.kind === 'standalone' ? episodeId !== null : !episode || episode.id !== episodeId
          || episode.projectId !== projectId || episode.canvasId !== canvasId)) return fail('invalid-membership');
      assertNativeRoot(project);
      validateCanvasTarget(project, episode ?? null, canvas);
      return {
        project: { id: project.id, epoch: project.epoch, storageRootRef: project.storageRootRef, storageBindings: project.storageBindings },
        canvas: { id: canvasId, epoch: canvas.epoch, episodeId, storageRootRef: canvas.storageRootRef },
      };
    }, [CANVASES, ROOTS, EPISODES]);
  } finally { database.close(); }
}

/** 列表只读取根记录；打开时仍须用 readNativeProject 核验完整聚合。 */
export async function listNativeProjects(options: NativeProjectOptions = {}): Promise<ProjectRecord[]> {
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return [];
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const projects = await request(tx.objectStore(ROOTS).getAll()) as ProjectRecord[];
      if (projects.length > 200_000 || projects.some((project) => !project || !isNativeProjectId(project.id)
        || !['standalone', 'series'].includes(project.kind)
        || project.lastOpenedCanvasId !== undefined && !isNativeCanvasId(project.lastOpenedCanvasId))) return fail('invalid-project-list');
      return projects;
    });
  } finally { database.close(); }
}

/** 只读取已删除画布身份，用于防止导出时遗漏仍归属于旧画布的历史。 */
export async function listNativeRetiredCanvasIds(projectId: string, options: NativeProjectOptions = {}): Promise<string[]> {
  if (!isNativeProjectId(projectId)) return fail('invalid-project-id');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return [];
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const rows = await request(tx.objectStore(RETIRED).getAll()) as Array<{ id?: unknown; projectId?: unknown; kind?: unknown }>;
      const ids = rows.filter((row) => row.projectId === projectId && row.kind === 'canvas').map((row) => row.id);
      if (ids.some((id) => !isNativeCanvasId(id))) return fail('invalid-retired-identity');
      return ids as string[];
    }, [RETIRED]);
  } finally { database.close(); }
}

/** 已退役身份不能复活；恢复导入必须为同一逻辑对象分配新本机 ID。 */
export async function listNativeRetiredIdentityIds(projectId: string, options: NativeProjectOptions = {}): Promise<string[]> {
  if (!isNativeProjectId(projectId)) return fail('invalid-project-id');
  const database = await openNativeProjectDatabase(false, options); if (!database) return [];
  try { return await transact(database, 'readonly', options, async (tx) => {
    const rows = await request(tx.objectStore(RETIRED).getAll()) as Array<{ id?: unknown; projectId?: unknown; kind?: unknown }>;
    const selected = rows.filter((row) => row.projectId === projectId && (row.kind === 'canvas' || row.kind === 'episode'));
    if (selected.some((row) => row.kind === 'canvas' ? !isNativeCanvasId(row.id) : !isNativeEpisodeId(row.id))) return fail('invalid-retired-identity');
    return selected.map((row) => row.id as string);
  }, [RETIRED]); } finally { database.close(); }
}

export const increment = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) return fail('revision-overflow');
  return value + 1;
};
const nameValue = (value: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 256 || hasControlCharacters(value)) return fail('invalid-name');
  return value.trim();
};
export const timestamp = (value?: number): number => {
  const result = value ?? Date.now();
  if (!Number.isSafeInteger(result) || result < 0) return fail('invalid-time');
  return result;
};
/** 不把新内联 data URL 当作已落盘素材；原有完全相同的值保留兼容。 */
export function assertNoNewInlineMedia(previous: unknown, next: unknown): void {
  const prior = new Map<string, number>();
  // 只有内置节点的确定字段和文本笔记可视为文字；插件及未知嵌套字段不能借同名键豁免。
  const knownTypes = new Set(['ai-text', 'ai-image', 'ai-video', 'ai-audio', 'ai-animation', 'ai-panorama', 'ai-markdown',
    'ai-storyboard', 'ai-shotlist', 'ai-director', 'source-image', 'source-video', 'source-audio', 'source-text', 'canvas-note', 'comment']);
  const visit = (root: unknown, compare: boolean) => {
    const pending: Array<{ value: unknown; text: boolean; path: string[]; ancestors: object[]; nodeType?: string }> =
      [{ value: root, text: false, path: [], ancestors: [] }];
    let visited = 0;
    while (pending.length) {
      const { value, text, path, ancestors, nodeType } = pending.pop()!;
      if (++visited > 1_000_000 || ancestors.length > 128) fail('canvas-value-limit');
      if (typeof value === 'string') {
        if (!text && /^\s*data:/i.test(value)) {
          const count = prior.get(value) ?? 0;
          if (compare && count === 0) fail('inline-media-not-persisted');
          prior.set(value, compare ? count - 1 : count + 1);
        }
      } else if (value && typeof value === 'object') {
        if (ancestors.includes(value)) fail('cyclic-canvas-value');
        const parents = [...ancestors, value];
        if (value instanceof Map) for (const [key, child] of value) {
          pending.push({ value: key, text: false, path: [...path, '<key>'], ancestors: parents },
            { value: child, text: false, path: [...path, '<value>'], ancestors: parents });
        }
        else if (value instanceof Set) for (const child of value) pending.push({ value: child, text: false, path: [...path, '<value>'], ancestors: parents });
        else {
          const record = value as Record<string, unknown>;
          const nodeData = path.length === 3 && path[0] === 'nodes' && /^\d+$/.test(path[1]) && path[2] === 'data';
          const type = nodeData && typeof record.type === 'string' && knownTypes.has(record.type) ? record.type : nodeType;
          const note = path.length === 4 && path[0] === 'nodes' && /^\d+$/.test(path[1]) && path[2] === 'data'
            && path[3] === 'note' && type === 'canvas-note' && record.kind === 'text';
          const group = path.length === 2 && path[0] === 'groups' && /^\d+$/.test(path[1]);
          for (const [key, child] of Object.entries(value)) pending.push({ value: child, path: [...path, key], ancestors: parents, nodeType: type,
            text: !!type && nodeData && (key === 'label' || key === 'prompt' || key === 'musicLyrics' && type === 'ai-audio'
              || key === 'output' && (type === 'ai-text' || type === 'source-text')) || note && key === 'text' || group && key === 'name' });
        }
      }
    }
  };
  visit(previous, false); visit(next, true);
}
async function mutate<T>(projectId: string, expectedEpoch: number, options: NativeProjectOptions,
  work: (tx: IDBTransaction, current: NativeProjectAggregate) => Promise<T>): Promise<T> {
  if (!isNativeProjectId(projectId) || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) return fail('invalid-identity');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      await assertNoPendingNativeSharedSync(tx, projectId);
      const current = await readInTransaction(tx, projectId);
      if (!current) return fail('project-not-found');
      if (current.project.epoch !== expectedEpoch) return fail('project-version-conflict');
      const revision = await request(tx.objectStore(REVISIONS).get(projectId)) as { projectId: string; changeRevision: number } | undefined;
      if (!revision || revision.projectId !== projectId || !Number.isSafeInteger(revision.changeRevision)
        || revision.changeRevision < 0) return fail('invalid-project-revision');
      const result = await work(tx, current);
      const nextProject = await request(tx.objectStore(ROOTS).get(projectId)) as ProjectRecord | undefined;
      if (!nextProject || nextProject.epoch !== current.project.epoch) await assertNoPendingNativeMediaTasks(tx, projectId);
      await request(tx.objectStore(REVISIONS).put({ projectId, changeRevision: increment(revision.changeRevision) }));
      return result;
    });
  } finally { database.close(); }
}
async function assertUnused(tx: IDBTransaction, episodeId: string, canvasId: string): Promise<void> {
  const values = await Promise.all([request(tx.objectStore(EPISODES).getKey(episodeId)), request(tx.objectStore(EPISODE_CONTENTS).getKey(episodeId)),
    request(tx.objectStore(CANVASES).getKey(canvasId)), request(tx.objectStore(RETIRED).getKey(episodeId)), request(tx.objectStore(RETIRED).getKey(canvasId))]);
  if (values.some((value) => value !== undefined)) fail('identity-conflict');
}

/** 修改作品名称或默认设置；项目代际改变后旧画布租约不能继续保存。 */
export async function updateNativeProjectMetadata(input: { projectId: string; expectedProjectEpoch: number;
  name?: string; defaultSettings?: ProjectSettings; now?: number }, options: NativeProjectOptions = {}): Promise<NativeProjectAggregate> {
  const fixed = structuredClone(input), now = timestamp(fixed.now);
  if (fixed.name === undefined && fixed.defaultSettings === undefined) return fail('empty-project-mutation');
  const name = fixed.name === undefined ? undefined : nameValue(fixed.name);
  return mutate(fixed.projectId, fixed.expectedProjectEpoch, options, async (tx, current) => {
    const project: ProjectRecord = { ...current.project, ...(name === undefined ? {} : { name }),
      ...(fixed.defaultSettings === undefined ? {} : { defaultSettings: fixed.defaultSettings }),
      epoch: increment(current.project.epoch), updatedAt: now };
    const next = validateAggregate(project, current.content, current.episodes, current.episodeContents, current.canvases);
    await request(tx.objectStore(ROOTS).put(next.project));
    return next;
  });
}

/** 文本模型偏好按原值提交，不更换项目代际，也不重建正在运行的媒体任务。 */
export async function saveNativeProjectTextModel(input: { projectId: string; expectedProjectEpoch: number;
  expectedModelId?: string; modelId?: string; now?: number }, options: NativeProjectOptions = {}):
Promise<{ project: ProjectRecord; changeRevision: number }> {
  const { projectId, expectedProjectEpoch, expectedModelId, modelId, now } = input;
  if (!isNativeProjectId(projectId) || !Number.isSafeInteger(expectedProjectEpoch) || expectedProjectEpoch < 0
    || modelId !== undefined && (typeof modelId !== 'string' || !modelId.trim() || modelId !== modelId.trim() || hasControlCharacters(modelId))) {
    return fail('invalid-project-text-model');
  }
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      await assertNoPendingNativeSharedSync(tx, projectId);
      const roots = tx.objectStore(ROOTS), revisions = tx.objectStore(REVISIONS);
      const [before, revision] = await Promise.all([
        request(roots.get(projectId)) as Promise<ProjectRecord | undefined>,
        request(revisions.get(projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
      ]);
      if (!before || before.id !== projectId || !revision || revision.projectId !== projectId
        || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0) return fail('invalid-membership');
      assertNativeRoot(before);
      if (before.epoch !== expectedProjectEpoch || before.defaultSettings?.defaultModels?.text !== expectedModelId) return fail('project-version-conflict');
      if (expectedModelId === modelId) return { project: before, changeRevision: revision.changeRevision };
      const project = { ...before, defaultSettings: withProjectTextModel(before.defaultSettings, modelId), updatedAt: timestamp(now) };
      const changeRevision = increment(revision.changeRevision);
      await Promise.all([request(roots.put(project)), request(revisions.put({ projectId, changeRevision }))]);
      return { project, changeRevision };
    }, [ROOTS, REVISIONS, TRANSFER]);
  } finally { database.close(); }
}

/** 修改分集名称或设置策略；保留项目与画布身份并校验分集 revision。 */
export async function updateNativeEpisodeMetadata(input: { projectId: string; expectedProjectEpoch: number;
  episodeId: string; expectedEpisodeRevision: number; name?: string; settingsPolicy?: EpisodeSettingsPolicy; now?: number },
options: NativeProjectOptions = {}): Promise<NativeProjectAggregate> {
  const fixed = structuredClone(input), now = timestamp(fixed.now);
  if (!isNativeEpisodeId(fixed.episodeId) || !Number.isSafeInteger(fixed.expectedEpisodeRevision) || fixed.expectedEpisodeRevision < 0
    || fixed.name === undefined && fixed.settingsPolicy === undefined) return fail('invalid-episode-mutation');
  const name = fixed.name === undefined ? undefined : nameValue(fixed.name);
  return mutate(fixed.projectId, fixed.expectedProjectEpoch, options, async (tx, current) => {
    const episode = current.episodes.find((item) => item.id === fixed.episodeId);
    if (!episode || episode.revision !== fixed.expectedEpisodeRevision) return fail('episode-version-conflict');
    const updated: EpisodeRecord = { ...episode, ...(name === undefined ? {} : { name }),
      ...(fixed.settingsPolicy === undefined ? {} : { settingsPolicy: fixed.settingsPolicy }),
      revision: increment(episode.revision), updatedAt: now };
    const project = { ...current.project, updatedAt: now };
    const next = validateAggregate(project, current.content,
      current.episodes.map((item) => item.id === updated.id ? updated : item), current.episodeContents, current.canvases);
    await Promise.all([request(tx.objectStore(ROOTS).put(next.project)), request(tx.objectStore(EPISODES).put(updated))]);
    return next;
  });
}

/** 分集正文与创作配置一起条件提交，只读取目标分集的画布和正文。 */
export async function updateNativeEpisodeComposite(input: { projectId: string; expectedProjectEpoch: number;
  episodeId: string; expectedCanvasId: string; expectedEpisodeRevision: number; expectedContentRevision: number;
  contentPatch?: Partial<Pick<EpisodeContent, 'outline' | 'script' | 'scriptFile' | 'creative' | 'assetRoster'>>;
  creationProfile?: CreationProfileSelection | null; teamProfileOverride?: AgentTeamProfile | null; now?: number },
options: NativeProjectOptions = {}): Promise<{ episode: EpisodeRecord; content: EpisodeContent }> {
  const fixed = structuredClone(input), now = timestamp(fixed.now);
  if (!isNativeProjectId(fixed.projectId) || !Number.isSafeInteger(fixed.expectedProjectEpoch) || fixed.expectedProjectEpoch < 0) return fail('invalid-identity');
  if (!isNativeEpisodeId(fixed.episodeId) || !isNativeCanvasId(fixed.expectedCanvasId)
    || !Number.isSafeInteger(fixed.expectedEpisodeRevision) || fixed.expectedEpisodeRevision < 0
    || !Number.isSafeInteger(fixed.expectedContentRevision) || fixed.expectedContentRevision < 0
    || fixed.contentPatch !== undefined && (!fixed.contentPatch || typeof fixed.contentPatch !== 'object' || Array.isArray(fixed.contentPatch)
      || Object.keys(fixed.contentPatch).some((key) => !['outline', 'script', 'scriptFile', 'creative', 'assetRoster'].includes(key)))
    || !Object.keys(fixed.contentPatch ?? {}).length && fixed.creationProfile === undefined && fixed.teamProfileOverride === undefined) return fail('invalid-episode-mutation');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      await assertNoPendingNativeSharedSync(tx, fixed.projectId);
      const { project, canvas, episode: previous } = await readCanvasTarget(tx, fixed.projectId, fixed.expectedCanvasId);
      const [body, revision] = await Promise.all([
        request(tx.objectStore(EPISODE_CONTENTS).get(fixed.episodeId)) as Promise<EpisodeContent | undefined>,
        request(tx.objectStore(REVISIONS).get(fixed.projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
      ]);
      if (project.epoch !== fixed.expectedProjectEpoch) return fail('project-version-conflict');
      if (!revision || revision.projectId !== fixed.projectId || !Number.isSafeInteger(revision.changeRevision)
        || revision.changeRevision < 0) return fail('invalid-project-revision');
      if (!previous || previous.id !== fixed.episodeId || !body || body.episodeId !== fixed.episodeId
        || previous.revision !== fixed.expectedEpisodeRevision || body.revision !== fixed.expectedContentRevision) return fail('episode-version-conflict');
      validateEpisodeTarget(project, canvas, previous, body);
      const updateMetadata = fixed.creationProfile !== undefined || fixed.teamProfileOverride !== undefined;
      const episode: EpisodeRecord = { ...previous, ...(updateMetadata ? { revision: increment(previous.revision), updatedAt: now } : {}) };
      if (fixed.creationProfile === null) delete episode.creationProfile;
      else if (fixed.creationProfile !== undefined) episode.creationProfile = fixed.creationProfile;
      if (fixed.teamProfileOverride === null) delete episode.teamProfileOverride;
      else if (fixed.teamProfileOverride !== undefined) episode.teamProfileOverride = fixed.teamProfileOverride;
      const content: EpisodeContent = Object.keys(fixed.contentPatch ?? {}).length
        ? { ...body, ...fixed.contentPatch, revision: increment(body.revision) } : body;
      const updatedProject = { ...project, updatedAt: now };
      validateEpisodeTarget(updatedProject, canvas, episode, content);
      await Promise.all([request(tx.objectStore(ROOTS).put(updatedProject)),
        request(tx.objectStore(REVISIONS).put({ projectId: fixed.projectId, changeRevision: increment(revision.changeRevision) })),
        ...(updateMetadata ? [request(tx.objectStore(EPISODES).put(episode))] : []),
        ...(content !== body ? [request(tx.objectStore(EPISODE_CONTENTS).put(content))] : [])]);
      return { episode, content };
    }, [ROOTS, EPISODES, EPISODE_CONTENTS, CANVASES, REVISIONS, TRANSFER]);
  } finally { database.close(); }
}

/** 单集操作只读取目标画布；其余分集只读轻量元数据和画布主键。 */
export async function readCanvasTarget(tx: IDBTransaction, projectId: string, canvasId: string):
Promise<{ project: ProjectRecord; canvas: CanvasDocument; episode: EpisodeRecord | null }> {
  const [project, canvas, episodes, canvasKeys] = await Promise.all([
    request(tx.objectStore(ROOTS).get(projectId)) as Promise<ProjectRecord | undefined>,
    request(tx.objectStore(CANVASES).get(canvasId)) as Promise<CanvasDocument | undefined>,
    request(tx.objectStore(EPISODES).index('projectId').getAll(projectId)) as Promise<EpisodeRecord[]>,
    request(tx.objectStore(CANVASES).index('projectId').getAllKeys(projectId)),
  ]);
  if (!project || project.id !== projectId || !canvas || canvas.id !== canvasId || canvas.projectId !== projectId
    || !isNativeCanvasId(canvasId) || !['standalone', 'series'].includes(project.kind)) return fail('canvas-not-in-project');
  assertNativeRoot(project);
  const keys = new Set(canvasKeys), ranks = new Set<number>(), ids = new Set<string>(), linked = new Set<string>();
  if (keys.size !== canvasKeys.length || canvasKeys.some((key) => !isNativeCanvasId(key)) || !keys.has(canvasId)) return fail('invalid-membership');
  for (const episode of episodes) {
    if (!isNativeEpisodeId(episode.id) || episode.projectId !== projectId || !isNativeCanvasId(episode.canvasId)
      || ids.has(episode.id) || linked.has(episode.canvasId) || !keys.has(episode.canvasId)
      || !Number.isSafeInteger(episode.orderRank) || episode.orderRank < 0 || ranks.has(episode.orderRank)) return fail('invalid-membership');
    ids.add(episode.id); linked.add(episode.canvasId); ranks.add(episode.orderRank);
  }
  if (project.lastOpenedCanvasId !== undefined && !keys.has(project.lastOpenedCanvasId)) return fail('invalid-membership');
  if (project.kind === 'standalone' ? episodes.length !== 0 || keys.size !== 1 : keys.size !== episodes.length) return fail('invalid-membership');
  const episode = project.kind === 'series' ? episodes.find((item) => item.canvasId === canvasId) : undefined;
  if (project.kind === 'standalone' ? canvas.episodeId !== null : !episode || canvas.episodeId !== episode.id) return fail('invalid-membership');
  return { project, canvas, episode: episode ?? null };
}

/** 临时单画布视图仅用于复用字段校验，不是完整项目捕获。 */
export function validateCanvasTarget(project: ProjectRecord, episode: EpisodeRecord | null, canvas: CanvasDocument, previous?: CanvasDocument): CanvasDocument {
  const scopedProject: ProjectRecord = { ...project, lastOpenedCanvasId: canvas.id };
  const blank: ProjectContent = { projectId: project.id, revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } };
  const frame = { project: scopedProject, content: blank, episodes: episode ? [episode] : [],
    episodeContents: episode ? [{ episodeId: episode.id, revision: 0, storageRootRef: project.storageRootRef }] : [],
    canvases: [canvas], previews: [], bindings: [] };
  const prior = previous ? { ...frame, canvases: [previous] } : undefined;
  return validateProjectModelTransferAggregate(frame, prior).canvases[0];
}

function validateEpisodeTarget(project: ProjectRecord, canvas: CanvasDocument, episode: EpisodeRecord,
  episodeContent: EpisodeContent, previousContent?: EpisodeContent): EpisodeContent {
  const content: ProjectContent = { projectId: project.id, revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } };
  const frame = { project: { ...project, lastOpenedCanvasId: canvas.id }, content, episodes: [episode],
    episodeContents: [episodeContent], canvases: [canvas], previews: [], bindings: [] };
  const prior = previousContent ? { ...frame, episodeContents: [previousContent] } : undefined;
  return validateProjectModelTransferAggregate(frame, prior).episodeContents[0];
}

interface NativeEpisodeSeed {
  name: string;
  outline?: string;
  episodeId?: string;
  canvasId?: string;
  displayNo?: number;
}

async function prepareNativeEpisodeRows(tx: IDBTransaction, project: ProjectRecord, seed: NativeEpisodeSeed, orderRank: number, now: number) {
  const episodeId = seed.episodeId ?? `e2-${crypto.randomUUID()}`, canvasId = seed.canvasId ?? `c2-${crypto.randomUUID()}`;
  if (!isNativeEpisodeId(episodeId) || !isNativeCanvasId(canvasId)
    || seed.displayNo !== undefined && (!Number.isSafeInteger(seed.displayNo) || seed.displayNo < 1)) return fail('invalid-identity');
  if (seed.outline !== undefined && typeof seed.outline !== 'string') return fail('invalid-creative-content');
  await assertUnused(tx, episodeId, canvasId);
  const outline = seed.outline?.trim();
  const episode: EpisodeRecord = { id: episodeId, projectId: project.id, canvasId, name: nameValue(seed.name), orderRank,
    ...(seed.displayNo !== undefined ? { displayNo: seed.displayNo } : {}), createdAt: now, updatedAt: now,
    epoch: 1, revision: 0, settingsPolicy: { mode: 'inherit', overrides: {} } };
  const body: EpisodeContent = { episodeId, revision: 0, storageRootRef: project.storageRootRef, ...(outline ? { outline } : {}) };
  const canvas: CanvasDocument = { id: canvasId, projectId: project.id, episodeId, storageRootRef: project.storageRootRef,
    nodes: [], edges: [], groups: [], epoch: 1, revision: 0, revisionScope: 'project' };
  return { episode, body, canvas };
}

function writeNativeEpisodeRows(tx: IDBTransaction, project: ProjectRecord, { episode, body, canvas }: {
  episode: EpisodeRecord; body: EpisodeContent; canvas: CanvasDocument;
}) {
  return Promise.all([request(tx.objectStore(ROOTS).put(project)), request(tx.objectStore(EPISODES).add(episode)),
    request(tx.objectStore(EPISODE_CONTENTS).add(body)), request(tx.objectStore(CANVASES).add(canvas))]);
}

/** 原子转为剧集，可同事务新增下一集；原项目和原画布 ID 保留，原画布 epoch 推进。 */
export async function convertNativeProjectToSeries(input: { projectId: string; expectedProjectEpoch: number; expectedCanvasId: string; expectedCanvasEpoch: number;
  expectedCanvasRevision: number; expectedStandaloneRevision: number; episodeId?: string; name: string;
  appendEpisode?: NativeEpisodeSeed; now?: number }, options: NativeProjectOptions = {}): Promise<NativeProjectAggregate> {
  const fixed = structuredClone(input), episodeId = fixed.episodeId ?? `e2-${crypto.randomUUID()}`;
  const name = nameValue(fixed.name), now = timestamp(fixed.now);
  if (!isNativeEpisodeId(episodeId)) return fail('invalid-identity');
  return mutate(fixed.projectId, fixed.expectedProjectEpoch, options, async (tx, current) => {
    const canvas = current.canvas;
    if (current.project.kind !== 'standalone' || !canvas || canvas.id !== fixed.expectedCanvasId || canvas.epoch !== fixed.expectedCanvasEpoch
      || canvas.revision !== fixed.expectedCanvasRevision || (current.content.standaloneCreative?.revision ?? 0) !== fixed.expectedStandaloneRevision) {
      return fail('canvas-version-conflict');
    }
    if (await request(tx.objectStore(EPISODES).get(episodeId)) !== undefined
      || await request(tx.objectStore(EPISODE_CONTENTS).get(episodeId)) !== undefined
      || await request(tx.objectStore(RETIRED).get(episodeId)) !== undefined) return fail('identity-conflict');
    const { standaloneCreative, ...projectContent } = current.content;
    const standalone: StandaloneCreativeContent = standaloneCreative ?? { revision: 0, storageRootRef: current.project.storageRootRef };
    const { creationProfile, teamProfileOverride, ...creative } = standalone;
    const episode: EpisodeRecord = { id: episodeId, projectId: fixed.projectId, canvasId: canvas.id, name, orderRank: 0,
      createdAt: now, updatedAt: now, epoch: 1, revision: 0, settingsPolicy: { mode: 'inherit', overrides: {} },
      ...(creationProfile ? { creationProfile } : {}), ...(teamProfileOverride ? { teamProfileOverride } : {}) };
    const body: EpisodeContent = { ...creative, episodeId };
    const updatedCanvas: CanvasDocument = { ...canvas, episodeId, epoch: increment(canvas.epoch) };
    const project: ProjectRecord = { ...current.project, kind: 'series', epoch: increment(current.project.epoch), updatedAt: now };
    const appended = fixed.appendEpisode !== undefined ? await prepareNativeEpisodeRows(tx, project, fixed.appendEpisode, 1, now) : undefined;
    if (appended?.episode.id === episodeId) return fail('identity-conflict');
    const next = validateAggregate(project, projectContent, appended ? [episode, appended.episode] : [episode],
      appended ? [body, appended.body] : [body], appended ? [updatedCanvas, appended.canvas] : [updatedCanvas]);
    await Promise.all([request(tx.objectStore(ROOTS).put(next.project)), request(tx.objectStore(CONTENTS).put(next.content)),
      request(tx.objectStore(CANVASES).put(updatedCanvas)), request(tx.objectStore(EPISODES).add(episode)),
      request(tx.objectStore(EPISODE_CONTENTS).add(body)), ...(appended ? [request(tx.objectStore(EPISODES).add(appended.episode)),
        request(tx.objectStore(EPISODE_CONTENTS).add(appended.body)), request(tx.objectStore(CANVASES).add(appended.canvas))] : [])]);
    return next;
  });
}

/** 原子新增分集、初始大纲和独立画布；零集剧集仍保留根项目与共享正文。 */
export async function createNativeEpisode(input: NativeEpisodeSeed & { projectId: string; expectedProjectEpoch: number; now?: number },
  options: NativeProjectOptions = {}): Promise<NativeProjectAggregate> {
  const fixed = structuredClone(input), now = timestamp(fixed.now);
  return mutate(fixed.projectId, fixed.expectedProjectEpoch, options, async (tx, current) => {
    if (current.project.kind !== 'series') return fail('not-series');
    const rank = current.episodes.length ? increment(current.episodes.reduce((max, episode) => Math.max(max, episode.orderRank), 0)) : 0;
    const { episode, body, canvas } = await prepareNativeEpisodeRows(tx, current.project, fixed, rank, now);
    const project: ProjectRecord = { ...current.project, epoch: increment(current.project.epoch), updatedAt: now,
      lastOpenedCanvasId: current.project.lastOpenedCanvasId ?? canvas.id };
    const next = validateAggregate(project, current.content, [...current.episodes, episode], [...current.episodeContents, body], [...current.canvases, canvas]);
    await writeNativeEpisodeRows(tx, next.project, { episode, body, canvas });
    return next;
  });
}

type PlannedNativeEpisode = { episodeId: string; canvasId: string; displayNo: number; name?: string; outline?: string };
type NativeEpisodeBatchConversion = Omit<Parameters<typeof convertNativeProjectToSeries>[0],
  'projectId' | 'expectedProjectEpoch' | 'appendEpisode' | 'now'> & { episodeId: string };

/** 首次事务核验完整作品，后续逐集按项目代际和末集顺序点验，只在各集提交后发回身份。 */
export async function* appendNativeEpisodesInOrder(input: { projectId: string; expectedProjectEpoch: number;
  episodes: readonly PlannedNativeEpisode[]; conversion?: NativeEpisodeBatchConversion; now?: number },
  options: NativeProjectOptions = {}): AsyncGenerator<string> {
  const { projectId, expectedProjectEpoch, now } = input;
  const episodes = input.episodes.map((episode) => ({ ...episode }));
  const conversion = input.conversion && { ...input.conversion };
  if (!episodes.length) return;
  if (conversion && !isNativeEpisodeId(conversion.episodeId)) return fail('invalid-identity');
  const seed = (episode: PlannedNativeEpisode) => {
    if (!isNativeEpisodeId(episode.episodeId) || !isNativeCanvasId(episode.canvasId)
      || !Number.isSafeInteger(episode.displayNo) || episode.displayNo < 1) return fail('invalid-identity');
    return { ...episode, name: episode.name?.trim() || `第 ${episode.displayNo} 集` };
  };
  const first = seed(episodes[0]);
  const initial = conversion ? await convertNativeProjectToSeries({ ...conversion, projectId, expectedProjectEpoch, now, appendEpisode: first }, options)
    : await createNativeEpisode({ ...first, projectId, expectedProjectEpoch, now }, options);
  yield first.canvasId;
  if (episodes.length === 1) return;
  const last = initial.episodes.at(-1);
  if (!last) return fail('incomplete-project');
  let checkpoint = { projectEpoch: initial.project.epoch, episode: last };
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    for (const planned of episodes.slice(1)) {
      const next = seed(planned), updatedAt = timestamp(now);
      const { episode: previous, projectEpoch } = checkpoint;
      checkpoint = await transact(database, 'readwrite', options, async (tx) => {
        await assertNoPendingNativeSharedSync(tx, projectId);
        const [project, revision, tail] = await Promise.all([
          request(tx.objectStore(ROOTS).get(projectId)) as Promise<ProjectRecord | undefined>,
          request(tx.objectStore(REVISIONS).get(projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
          request(tx.objectStore(EPISODES).get(previous.id)) as Promise<EpisodeRecord | undefined>,
        ]);
        if (!project || project.id !== projectId || project.kind !== 'series' || project.epoch !== projectEpoch) return fail('project-version-conflict');
        assertNativeRoot(project);
        if (!revision || revision.projectId !== projectId || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0) {
          return fail('invalid-project-revision');
        }
        if (!tail || tail.id !== previous.id || tail.projectId !== projectId || tail.canvasId !== previous.canvasId || tail.orderRank !== previous.orderRank) {
          return fail('episode-version-conflict');
        }
        const rows = await prepareNativeEpisodeRows(tx, project, next, increment(tail.orderRank), updatedAt);
        const updated = { ...project, epoch: increment(project.epoch), updatedAt };
        validateEpisodeTarget(updated, rows.canvas, rows.episode, rows.body);
        await assertNoPendingNativeMediaTasks(tx, projectId);
        await Promise.all([writeNativeEpisodeRows(tx, updated, rows),
          request(tx.objectStore(REVISIONS).put({ projectId, changeRevision: increment(revision.changeRevision) }))]);
        return { projectEpoch: updated.epoch, episode: rows.episode };
      }, [ROOTS, EPISODES, EPISODE_CONTENTS, CANVASES, RETIRED, REVISIONS, EXCHANGE, TRANSFER]);
      yield next.canvasId;
    }
  } finally { database.close(); }
}

/** 输入必须先经既有文件序列化及授权；未经映射的新本机路径/asset URL 会被聚合校验拒绝。 */
export async function saveNativeCanvas(input: { projectId: string; expectedProjectEpoch: number; canvasId: string; episodeId: string | null;
  expectedCanvasEpoch: number; expectedCanvasRevision: number; document: Pick<CanvasDocument, 'nodes' | 'edges' | 'groups'>; now?: number },
options: NativeProjectOptions = {}): Promise<CanvasDocument> {
  const fixed = structuredClone(input), now = timestamp(fixed.now);
  if (!isNativeCanvasId(fixed.canvasId) || fixed.episodeId !== null && !isNativeEpisodeId(fixed.episodeId)
    || !fixed.document || Object.keys(fixed.document).some((key) => !['nodes', 'edges', 'groups'].includes(key))) return fail('invalid-identity');
  if (!isNativeProjectId(fixed.projectId) || !Number.isSafeInteger(fixed.expectedProjectEpoch) || fixed.expectedProjectEpoch < 0) return fail('invalid-identity');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      await assertNoPendingNativeSharedSync(tx, fixed.projectId);
      const { project, canvas, episode } = await readCanvasTarget(tx, fixed.projectId, fixed.canvasId);
      const revision = await request(tx.objectStore(REVISIONS).get(fixed.projectId)) as { projectId: string; changeRevision: number } | undefined;
      if (!revision || revision.projectId !== fixed.projectId || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0) return fail('invalid-project-revision');
      if (project.epoch !== fixed.expectedProjectEpoch) return fail('project-version-conflict');
      if (canvas.episodeId !== fixed.episodeId || canvas.epoch !== fixed.expectedCanvasEpoch
        || canvas.revision !== fixed.expectedCanvasRevision) return fail('canvas-version-conflict');
      assertNoNewInlineMedia(canvas, fixed.document);
      const updated: CanvasDocument = { ...canvas, nodes: fixed.document.nodes, edges: fixed.document.edges,
        groups: fixed.document.groups, revision: increment(canvas.revision) };
      const checked = validateCanvasTarget(project, episode, updated, canvas);
      await Promise.all([request(tx.objectStore(ROOTS).put({ ...project, updatedAt: now })), request(tx.objectStore(CANVASES).put(checked)),
        request(tx.objectStore(REVISIONS).put({ projectId: fixed.projectId, changeRevision: increment(revision.changeRevision) }))]);
      return checked;
    }, [ROOTS, EPISODES, CANVASES, REVISIONS, TRANSFER]);
  } finally { database.close(); }
}

/** 同一事务条件保存当前画布、可选的共享资料和当前分集正文。 */
export async function saveNativeProjectView(input: {
  projectId: string; expectedProjectEpoch: number; canvasId: string; episodeId: string | null;
  expectedCanvasEpoch: number; expectedCanvasRevision: number; document: Pick<CanvasDocument, 'nodes' | 'edges' | 'groups'>;
  shared?: { expectedRevisions: Partial<ProjectContent['revisions']>;
    patch: Partial<Pick<ProjectContent, 'originalWork' | 'script' | 'storyGraph' | 'dramaAssets'>> };
  episode?: { expectedEpisodeRevision: number; expectedContentRevision: number;
    patch: Partial<Pick<EpisodeContent, 'outline' | 'script' | 'scriptFile' | 'creative' | 'assetRoster'>> };
  now?: number;
}, options: NativeProjectOptions = {}): Promise<{ canvas: CanvasDocument; content: ProjectContent | null;
  episodeContent: EpisodeContent | null; changeRevision: number }> {
  const fixed = structuredClone(input), now = timestamp(fixed.now);
  if (!isNativeProjectId(fixed.projectId) || !isNativeCanvasId(fixed.canvasId)
    || fixed.episodeId !== null && !isNativeEpisodeId(fixed.episodeId)
    || !Number.isSafeInteger(fixed.expectedProjectEpoch) || fixed.expectedProjectEpoch < 0
    || !fixed.document || typeof fixed.document !== 'object' || Array.isArray(fixed.document)
    || Object.keys(fixed.document).some((key) => !['nodes', 'edges', 'groups'].includes(key))) return fail('invalid-identity');
  const fields = { originalWork: 'source', script: 'script', storyGraph: 'storyGraph', dramaAssets: 'assets' } as const;
  const shared = fixed.shared;
  if (shared && (!shared.patch || typeof shared.patch !== 'object' || Array.isArray(shared.patch)
    || !shared.expectedRevisions || typeof shared.expectedRevisions !== 'object' || Array.isArray(shared.expectedRevisions)
    || !Object.keys(shared.patch).length || Object.keys(shared.patch).some((key) => !Object.hasOwn(fields, key))
    || Object.keys(shared.expectedRevisions).some((key) => !Object.values(fields).includes(key as keyof ProjectContent['revisions'])))) {
    return fail('invalid-project-content');
  }
  const episodeUpdate = fixed.episode;
  if (episodeUpdate && (!fixed.episodeId || !episodeUpdate.patch || typeof episodeUpdate.patch !== 'object'
    || Array.isArray(episodeUpdate.patch) || !Object.keys(episodeUpdate.patch).length
    || Object.keys(episodeUpdate.patch).some((key) => !['outline', 'script', 'scriptFile', 'creative', 'assetRoster'].includes(key)))) {
    return fail('invalid-episode-content');
  }
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      await assertNoPendingNativeSharedSync(tx, fixed.projectId);
      const { project, canvas, episode } = await readCanvasTarget(tx, fixed.projectId, fixed.canvasId);
      const [revision, currentContent, body, canvasKeys] = await Promise.all([
        request(tx.objectStore(REVISIONS).get(fixed.projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
        shared ? request(tx.objectStore(CONTENTS).get(fixed.projectId)) as Promise<ProjectContent | undefined> : Promise.resolve(undefined),
        episodeUpdate && fixed.episodeId ? request(tx.objectStore(EPISODE_CONTENTS).get(fixed.episodeId)) as Promise<EpisodeContent | undefined> : Promise.resolve(undefined),
        shared ? request(tx.objectStore(CANVASES).index('projectId').getAllKeys(fixed.projectId)) : Promise.resolve([]),
      ]);
      if (!revision || revision.projectId !== fixed.projectId || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0) return fail('invalid-project-revision');
      if (project.epoch !== fixed.expectedProjectEpoch) return fail('project-version-conflict');
      if (canvas.episodeId !== fixed.episodeId || canvas.epoch !== fixed.expectedCanvasEpoch
        || canvas.revision !== fixed.expectedCanvasRevision) return fail('canvas-version-conflict');
      assertNoNewInlineMedia(canvas, fixed.document);
      const nextCanvas = validateCanvasTarget(project, episode, { ...canvas, ...fixed.document, revision: increment(canvas.revision) }, canvas);
      let nextContent: ProjectContent | null = null;
      if (shared) {
        if (!currentContent || currentContent.projectId !== fixed.projectId) return fail('invalid-membership');
        validateContentSlice(project, currentContent, canvasKeys);
        const revisions = { ...currentContent.revisions };
        for (const key of Object.keys(shared.patch) as Array<keyof typeof fields>) {
          const domain = fields[key], expected = shared.expectedRevisions[domain];
          if (!Number.isSafeInteger(expected) || expected !== revisions[domain]) return fail('content-version-conflict');
          revisions[domain] = increment(revisions[domain]);
        }
        nextContent = validateContentSlice(project, { ...currentContent, ...shared.patch, revisions }, canvasKeys);
      }
      let nextEpisode: EpisodeContent | null = null;
      if (episodeUpdate) {
        if (!episode || episode.id !== fixed.episodeId || !body || body.episodeId !== fixed.episodeId
          || episode.revision !== episodeUpdate.expectedEpisodeRevision || body.revision !== episodeUpdate.expectedContentRevision) return fail('episode-version-conflict');
        const updated: EpisodeContent = { ...body, ...episodeUpdate.patch, revision: increment(body.revision) };
        nextEpisode = validateEpisodeTarget(project, canvas, episode, updated, body);
      }
      const changeRevision = increment(revision.changeRevision);
      await Promise.all([request(tx.objectStore(ROOTS).put({ ...project, updatedAt: now })), request(tx.objectStore(CANVASES).put(nextCanvas)),
        request(tx.objectStore(REVISIONS).put({ projectId: fixed.projectId, changeRevision })),
        ...(nextContent ? [request(tx.objectStore(CONTENTS).put(nextContent))] : []),
        ...(nextEpisode ? [request(tx.objectStore(EPISODE_CONTENTS).put(nextEpisode))] : [])]);
      return { canvas: nextCanvas, content: nextContent, episodeContent: nextEpisode, changeRevision };
    }, [ROOTS, CONTENTS, EPISODES, EPISODE_CONTENTS, CANVASES, REVISIONS, TRANSFER]);
  } finally { database.close(); }
}

export async function saveNativeEpisodeContent(input: { projectId: string; expectedProjectEpoch: number; episodeId: string; expectedCanvasId: string;
  expectedEpisodeRevision: number; expectedContentRevision: number; patch: Partial<Pick<EpisodeContent, 'outline' | 'script' | 'scriptFile' | 'creative' | 'assetRoster'>>;
  now?: number }, options: NativeProjectOptions = {}): Promise<EpisodeContent> {
  const fixed = structuredClone(input), now = timestamp(fixed.now);
  if (!isNativeEpisodeId(fixed.episodeId) || !fixed.patch || Object.keys(fixed.patch).some((key) =>
    !['outline', 'script', 'scriptFile', 'creative', 'assetRoster'].includes(key)) || !isNativeProjectId(fixed.projectId)
    || !isNativeCanvasId(fixed.expectedCanvasId)) return fail('invalid-episode-content');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      await assertNoPendingNativeSharedSync(tx, fixed.projectId);
      const { project, episode, canvas } = await readCanvasTarget(tx, fixed.projectId, fixed.expectedCanvasId);
      const [body, revision] = await Promise.all([
        request(tx.objectStore(EPISODE_CONTENTS).get(fixed.episodeId)) as Promise<EpisodeContent | undefined>,
        request(tx.objectStore(REVISIONS).get(fixed.projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
      ]);
      if (!revision || revision.projectId !== fixed.projectId || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0) return fail('invalid-project-revision');
      if (project.epoch !== fixed.expectedProjectEpoch) return fail('project-version-conflict');
      if (!episode || episode.id !== fixed.episodeId || !body || body.episodeId !== fixed.episodeId
        || episode.revision !== fixed.expectedEpisodeRevision || body.revision !== fixed.expectedContentRevision) return fail('episode-version-conflict');
      const updated: EpisodeContent = { ...body, ...fixed.patch, revision: increment(body.revision) };
      const checked = validateEpisodeTarget(project, canvas, episode, updated, body);
      await Promise.all([request(tx.objectStore(ROOTS).put({ ...project, updatedAt: now })), request(tx.objectStore(EPISODE_CONTENTS).put(checked)),
        request(tx.objectStore(REVISIONS).put({ projectId: fixed.projectId, changeRevision: increment(revision.changeRevision) }))]);
      return checked;
    }, [ROOTS, EPISODES, EPISODE_CONTENTS, CANVASES, REVISIONS, TRANSFER]);
  } finally { database.close(); }
}

/** 只加载分集元数据；画布/正文的完整成员关系在打开时核验。 */
export async function listNativeEpisodes(projectId: string, options: NativeProjectOptions = {}): Promise<EpisodeRecord[]> {
  if (!isNativeProjectId(projectId)) return fail('invalid-project-id');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return [];
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const [project, episodes] = await Promise.all([request(tx.objectStore(ROOTS).get(projectId)) as Promise<ProjectRecord | undefined>,
        request(tx.objectStore(EPISODES).index('projectId').getAll(projectId)) as Promise<EpisodeRecord[]>]);
      if (!project) { if (episodes.length) return fail('invalid-membership'); return []; }
      if (project.id !== projectId || !['standalone', 'series'].includes(project.kind)
        || project.kind === 'standalone' && episodes.length) return fail('invalid-membership');
      const ranks = new Set<number>();
      for (const episode of episodes) {
        if (!isNativeEpisodeId(episode.id) || !isNativeCanvasId(episode.canvasId) || episode.projectId !== projectId
          || !Number.isSafeInteger(episode.orderRank) || episode.orderRank < 0 || ranks.has(episode.orderRank)) return fail('invalid-membership');
        ranks.add(episode.orderRank);
      }
      return episodes.sort((a, b) => a.orderRank - b.orderRank);
    });
  } finally { database.close(); }
}

export async function reorderNativeEpisodes(input: { projectId: string; expectedProjectEpoch: number;
  expectedEpisodes: Array<{ id: string; revision: number }>; orderedEpisodeIds: string[]; now?: number },
options: NativeProjectOptions = {}): Promise<EpisodeRecord[]> {
  const fixed = structuredClone(input), now = timestamp(fixed.now);
  if (!Array.isArray(fixed.expectedEpisodes) || !Array.isArray(fixed.orderedEpisodeIds)) return fail('invalid-order');
  return mutate(fixed.projectId, fixed.expectedProjectEpoch, options, async (tx, current) => {
    if (current.project.kind !== 'series' || fixed.expectedEpisodes.length !== current.episodes.length
      || fixed.orderedEpisodeIds.length !== current.episodes.length) return fail('episode-version-conflict');
    const expected = new Map(fixed.expectedEpisodes.map((item) => [item.id, item.revision]));
    const ordered = new Set(fixed.orderedEpisodeIds);
    if (expected.size !== current.episodes.length || ordered.size !== current.episodes.length
      || current.episodes.some((episode) => expected.get(episode.id) !== episode.revision || !ordered.has(episode.id))) return fail('episode-version-conflict');
    const byId = new Map(current.episodes.map((episode) => [episode.id, episode]));
    const episodes = fixed.orderedEpisodeIds.map((id, orderRank) => {
      const item = byId.get(id);
      if (!item) return fail('invalid-order');
      return { ...item, orderRank, revision: increment(item.revision), updatedAt: now };
    });
    const project = { ...current.project, epoch: increment(current.project.epoch), updatedAt: now };
    const next = validateAggregate(project, current.content, episodes, current.episodeContents, current.canvases);
    await Promise.all([request(tx.objectStore(ROOTS).put(next.project)), ...episodes.map((episode) => request(tx.objectStore(EPISODES).put(episode)))]);
    return next.episodes;
  });
}

/** 不删除项目/共享正文；墓碑永久占用被删分集与画布 ID。 */
export async function deleteNativeEpisode(input: { projectId: string; expectedProjectEpoch: number; episodeId: string; expectedCanvasId: string;
  expectedEpisodeRevision: number; expectedContentRevision: number; expectedCanvasEpoch: number; expectedCanvasRevision: number; now?: number },
options: NativeProjectOptions = {}): Promise<NativeProjectAggregate> {
  const fixed = structuredClone(input), now = timestamp(fixed.now);
  if (!isNativeEpisodeId(fixed.episodeId)) return fail('invalid-identity');
  return mutate(fixed.projectId, fixed.expectedProjectEpoch, options, async (tx, current) => {
    const episode = current.episodes.find((item) => item.id === fixed.episodeId);
    const canvas = episode && current.canvases.find((item) => item.id === episode.canvasId);
    const body = current.episodeContents.find((item) => item.episodeId === fixed.episodeId);
    if (current.project.kind !== 'series' || !episode || !body || !canvas || canvas.id !== fixed.expectedCanvasId || episode.revision !== fixed.expectedEpisodeRevision
      || body.revision !== fixed.expectedContentRevision
      || canvas.epoch !== fixed.expectedCanvasEpoch || canvas.revision !== fixed.expectedCanvasRevision) return fail('episode-version-conflict');
    const episodes = current.episodes.filter((item) => item.id !== episode.id);
    const canvases = current.canvases.filter((item) => item.id !== canvas.id);
    const episodeContents = current.episodeContents.filter((item) => item.episodeId !== episode.id);
    const { lastOpenedCanvasId, ...withoutSelection } = current.project;
    const selection = lastOpenedCanvasId && lastOpenedCanvasId !== canvas.id ? lastOpenedCanvasId : episodes[0]?.canvasId;
    const project: ProjectRecord = { ...withoutSelection, ...(selection ? { lastOpenedCanvasId: selection } : {}),
      epoch: increment(current.project.epoch), updatedAt: now };
    const next = validateAggregate(project, current.content, episodes, episodeContents, canvases);
    await Promise.all([request(tx.objectStore(ROOTS).put(next.project)), request(tx.objectStore(EPISODES).delete(episode.id)),
      request(tx.objectStore(EPISODE_CONTENTS).delete(episode.id)), request(tx.objectStore(CANVASES).delete(canvas.id)),
      request(tx.objectStore(EXCHANGE).delete(canvasPreviewKey(canvas.id))),
      request(tx.objectStore(RETIRED).add({ id: episode.id, projectId: fixed.projectId, kind: 'episode', deletedAt: now })),
      request(tx.objectStore(RETIRED).add({ id: canvas.id, projectId: fixed.projectId, kind: 'canvas', deletedAt: now }))]);
    return next;
  });
}
