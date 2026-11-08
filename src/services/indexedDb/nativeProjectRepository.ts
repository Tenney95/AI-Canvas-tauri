/** 新项目独立库。仅在显式调用时打开，不升级、读取或写入旧项目库。 */
import type { CanvasDocument, EpisodeContent, EpisodeRecord, EpisodeSettingsPolicy, ProjectContent, ProjectRecord, StandaloneCreativeContent } from '../../types/project';
import type { ProjectSettings } from '../../types';
import type { CreationProfileSelection } from '../../types/creationProfile';
import type { AgentTeamProfile } from '../../types/agentTeam';
import type { ProjectModelTransferAggregate, ProjectModelTransferCapture, ProjectModelTransferExchange, ProjectModelTransferExportJournal, ProjectModelTransferImportJournal } from '../../types/projectModelTransfer';
import { configValuesEqual } from '../configPatch';
import { verifiedExchange } from './projectModelTransferRepository';
import { validateProjectModelTransferAggregate } from './projectModelBusinessRepository';
import { replaceNativeVideoEditorInTransaction, validateNativeVideoEditorUpdateMedia } from './nativeVideoEditorUpdate';
import { materializeNativeRawRecovery, referencedNativeRecoveryAssets, type NativeRecoveryIdentityMapping, type NativeRecoveryFileMapping, type NativeRecoveryAssetMapping } from '../nativeProjectRawRecovery';
import { addNativeAssetsInTransaction, validateNativeAsset, type NativeAssetRecord } from './nativeAssetRepository';
import { applyNativeGlobalRecoveryFiles, remapNativeAssetImageReferences, rebindNativeAssetReferenceFiles, type NativeAssetSnapshot } from '../nativeProjectAssetRecovery';
import type { NativeGlobalRecoveryFile } from '../nativeProjectArchiveService';
import { validateNativeMissingAssetProof, type NativeMissingAssetProof } from '../nativeMissingAssetBackup';

export const NATIVE_PROJECT_DATABASE_NAME = 'ai-canvas-native-projects-v2' as const;
export const NATIVE_PROJECT_DATABASE_VERSION = 1 as const;
export const ROOTS = 'projectRoots', CONTENTS = 'projectContents', CANVASES = 'canvasDocuments';
export const EPISODES = 'episodes', EPISODE_CONTENTS = 'episodeContents';
export const RETIRED = 'retiredIds';
export const REVISIONS = 'projectRevisions';
export const EXCHANGE = 'nativeProjectExchange', TRANSFER = 'nativeTransferJournal';
const STORES = [ROOTS, CONTENTS, CANVASES, EPISODES, EPISODE_CONTENTS, RETIRED, REVISIONS, EXCHANGE, TRANSFER] as const;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const projectIdPattern = new RegExp(`^p2-${uuid}$`);
const canvasIdPattern = new RegExp(`^c2-${uuid}$`);
const episodeIdPattern = new RegExp(`^e2-${uuid}$`);
const rootRefPattern = new RegExp(`^r2-${uuid}$`);

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

const fail = (code: string): never => { throw new Error(`新项目仓储不可用：${code}`); };
const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error ?? new Error('indexeddb-request-failed'));
});

/** 未完成的跨库同步或更新在事务内冻结作品；只允许对应原操作结算。 */
export async function assertNoPendingNativeSharedSync(tx: IDBTransaction, projectId: string, exceptOperationId?: string): Promise<void> {
  const rows = await request(tx.objectStore(TRANSFER).index('projectId').getAll(projectId)) as Array<{ kind?: string; phase?: string; operationId?: string; mode?: string }>;
  if (rows.some((row) => !(exceptOperationId && row.operationId === exceptOperationId) && row.kind === 'native-shared-sync'
    && row.phase !== 'finalized' && row.phase !== 'aborted')) return fail('project-shared-sync-pending');
  if (rows.some((row) => !(exceptOperationId && row.operationId === exceptOperationId) && (row.kind === 'native-project-update' || row.kind === 'project-model-import'
      && (row.mode === 'update-existing' || row.mode === 'restore-content'))
    && row.phase !== 'finalized' && row.phase !== 'aborted')) return fail('project-update-pending');
}

/** 活动远端任务保留原项目代际；不能并发执行会使其无法续查的结构变更。 */
export async function assertNoPendingNativeMediaTasks(tx: IDBTransaction, projectId: string): Promise<void> {
  const editorRows = await request(tx.objectStore(EXCHANGE).getAll(IDBKeyRange.bound('editor-task:', 'editor-task:\uffff'))) as
    Array<{ kind?: string; ownerProjectId?: string; status?: string }>;
  if (editorRows.some((row) => row.kind !== 'native-editor-media-v1' || row.ownerProjectId === projectId
    && ['prepared', 'submitted', 'outcome-unknown'].includes(row.status ?? ''))) return fail('project-media-task-pending');
  const rows = await request(tx.objectStore(EXCHANGE).getAll(IDBKeyRange.bound('media-task:', 'media-task:\uffff'))) as
    Array<{ kind?: unknown; ownerProjectId?: unknown; status?: unknown; operationId?: unknown }>;
  if (rows.length > 100_000 || rows.some((row) => !row || row.kind !== 'native-media-task-v1'
    || typeof row.ownerProjectId !== 'string' || typeof row.operationId !== 'string'
    || !['prepared', 'submitted', 'outcome-unknown', 'delivered', 'failed', 'reviewed'].includes(String(row.status)))) return fail('invalid-media-task-ledger');
  if (rows.some((row) => row.ownerProjectId === projectId && ['prepared', 'submitted', 'outcome-unknown'].includes(String(row.status)))) {
    return fail('project-media-task-pending');
  }
}

/** 不缓存连接；阻塞/取消后迟到的升级中止，迟到的连接立即关闭。 */
export async function openNativeProjectDatabase(create: boolean, options: NativeProjectOptions): Promise<IDBDatabase | null> {
  const factory = options.factory ?? globalThis.indexedDB;
  if (!factory) return fail('indexeddb-unavailable');
  options.signal?.throwIfAborted();
  const database = await new Promise<IDBDatabase | null>((resolve, reject) => {
    let settled = false;
    let missing = false;
    const finish = (error?: unknown, result?: IDBDatabase | null) => {
      if (settled) { result?.close(); return; }
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result ?? null);
    };
    const abort = () => finish(new DOMException('新项目操作已取消', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });
    let opening: IDBOpenDBRequest;
    try { opening = create ? factory.open(NATIVE_PROJECT_DATABASE_NAME, NATIVE_PROJECT_DATABASE_VERSION) : factory.open(NATIVE_PROJECT_DATABASE_NAME); }
    catch (error) { finish(error); return; }
    opening.onupgradeneeded = (event) => {
      if (settled || options.signal?.aborted || !create || event.oldVersion !== 0) {
        missing = !create && event.oldVersion === 0;
        opening.transaction?.abort();
        return;
      }
      const db = opening.result;
      db.createObjectStore(ROOTS, { keyPath: 'id' });
      db.createObjectStore(CONTENTS, { keyPath: 'projectId' });
      db.createObjectStore(CANVASES, { keyPath: 'id' }).createIndex('projectId', 'projectId', { unique: false });
      db.createObjectStore(EPISODES, { keyPath: 'id' }).createIndex('projectId', 'projectId', { unique: false });
      db.createObjectStore(EPISODE_CONTENTS, { keyPath: 'episodeId' });
      db.createObjectStore(RETIRED, { keyPath: 'id' });
      db.createObjectStore(REVISIONS, { keyPath: 'projectId' });
      db.createObjectStore(EXCHANGE, { keyPath: 'projectId' });
      db.createObjectStore(TRANSFER, { keyPath: 'operationId' }).createIndex('projectId', 'projectId', { unique: false });
    };
    opening.onerror = () => missing && !settled ? finish(undefined, null) : finish(opening.error ?? new Error('indexeddb-open-failed'));
    opening.onblocked = () => finish(new Error('indexeddb-open-blocked'));
    opening.onsuccess = () => finish(undefined, opening.result);
  });
  if (!database) return null;
  try {
    if (database.name !== NATIVE_PROJECT_DATABASE_NAME || database.version !== NATIVE_PROJECT_DATABASE_VERSION
      || Array.from(database.objectStoreNames).sort().join('\0') !== [...STORES].sort().join('\0')) fail('unsupported-schema');
    const tx = database.transaction([...STORES], 'readonly');
    for (const [name, keyPath] of [[ROOTS, 'id'], [CONTENTS, 'projectId'], [CANVASES, 'id'], [EPISODES, 'id'], [EPISODE_CONTENTS, 'episodeId'], [RETIRED, 'id'], [REVISIONS, 'projectId'], [EXCHANGE, 'projectId'], [TRANSFER, 'operationId']] as const) {
      const store = tx.objectStore(name);
      const expectedIndexes = name === CANVASES || name === EPISODES || name === TRANSFER ? ['projectId'] : [];
      if (store.keyPath !== keyPath || store.autoIncrement || Array.from(store.indexNames).join('\0') !== expectedIndexes.join('\0')) fail('unsupported-schema');
      if (name === CANVASES || name === EPISODES || name === TRANSFER) {
        const index = store.index('projectId');
        if (index.keyPath !== 'projectId' || index.unique || index.multiEntry) fail('unsupported-schema');
      }
    }
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

function assertNativeRoot(project: ProjectRecord): void {
  if (!project || !isNativeProjectId(project.id) || !['standalone', 'series'].includes(project.kind)
    || !Array.isArray(project.storageBindings) || !rootRefPattern.test(project.storageRootRef) || !project.storageBindings.length
    || project.dataFolder !== `project-${project.id}`
    || project.storageBindings.some((binding) => !binding || typeof binding.folderName !== 'string'
      || !rootRefPattern.test(binding.rootRef) || binding.source !== 'project-managed'
      || binding.folderName !== (binding.rootRef === project.storageRootRef
        ? project.dataFolder : `${project.dataFolder}/roots/${binding.rootRef}`))
    || new Set(project.storageBindings.map((binding) => binding.rootRef)).size !== project.storageBindings.length
    || !project.storageBindings.some((binding) => binding.rootRef === project.storageRootRef)) fail('invalid-membership');
}

function validateAggregate(project: ProjectRecord, content: ProjectContent, episodes: EpisodeRecord[],
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

async function readInTransaction(tx: IDBTransaction, projectId: string): Promise<NativeProjectAggregate | null> {
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
    || /[\u0000-\u001f\u007f-\u009f]/u.test(input.name)) return fail('invalid-name');
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
/** 只读取项目根及索引 key，不加载画布或正文。具体实体关系在打开时重新核验。 */
export async function listNativeProjectIdentities(options: NativeProjectOptions = {}): Promise<NativeProjectIdentities[]> {
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return [];
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const identities = (name: string) => new Promise<Array<{ projectId: IDBValidKey; id: IDBValidKey }>>((resolve, reject) => {
        const items: Array<{ projectId: IDBValidKey; id: IDBValidKey }> = [];
        const cursor = tx.objectStore(name).index('projectId').openKeyCursor();
        cursor.onsuccess = () => { if (cursor.result) { items.push({ projectId: cursor.result.key, id: cursor.result.primaryKey }); cursor.result.continue(); }
          else resolve(items); };
        cursor.onerror = () => reject(cursor.error ?? new Error('indexeddb-index-failed'));
      });
      const [projects, episodes, canvases] = await Promise.all([
        request(tx.objectStore(ROOTS).getAll()) as Promise<ProjectRecord[]>,
        request(tx.objectStore(EPISODES).getAll()) as Promise<EpisodeRecord[]>, identities(CANVASES),
      ]);
      if (projects.length > 200_000 || episodes.length > 1_000_000 || canvases.length > 1_000_000) return fail('catalog-limit');
      const entries = new Map<string, NativeProjectIdentities>();
      for (const project of projects) {
        if (!project || !isNativeProjectId(project.id) || entries.has(project.id) || !['standalone', 'series'].includes(project.kind)
          || project.lastOpenedCanvasId !== undefined && !isNativeCanvasId(project.lastOpenedCanvasId)) return fail('invalid-project-list');
        assertNativeRoot(project);
        entries.set(project.id, { project, episodeIds: [], canvasIds: [], episodes: [] });
      }
      for (const entry of episodes) {
        if (!isNativeProjectId(entry.projectId) || !isNativeEpisodeId(entry.id) || !isNativeCanvasId(entry.canvasId)
          || !entries.has(entry.projectId) || !Number.isSafeInteger(entry.orderRank) || entry.orderRank < 0) return fail('invalid-membership');
        const target = entries.get(entry.projectId)!;
        target.episodeIds.push(entry.id); target.episodes.push(entry);
      }
      for (const entry of canvases) {
        if (!isNativeProjectId(entry.projectId) || !isNativeCanvasId(entry.id) || !entries.has(entry.projectId)) return fail('invalid-membership');
        entries.get(entry.projectId)!.canvasIds.push(entry.id);
      }
      for (const value of entries.values()) {
        if (value.project.kind === 'standalone' ? value.episodeIds.length !== 0 || value.canvasIds.length !== 1
          : value.canvasIds.length !== value.episodeIds.length) return fail('invalid-membership');
        if (new Set(value.episodes.map((episode) => episode.orderRank)).size !== value.episodes.length
          || new Set(value.episodes.map((episode) => episode.canvasId)).size !== value.episodes.length
          || value.episodes.some((episode) => !value.canvasIds.includes(episode.canvasId))) return fail('invalid-membership');
        if (value.project.lastOpenedCanvasId && !value.canvasIds.includes(value.project.lastOpenedCanvasId)) return fail('invalid-membership');
        value.episodes.sort((a, b) => a.orderRank - b.orderRank);
      }
      return [...entries.values()];
    });
  } finally { database.close(); }
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
        exchange: exchange === undefined ? null : (exchange as { exchange: ProjectModelTransferExchange }).exchange, includesHistory: false };
    });
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

/** 只读指定分集的稿件与元数据；画布成员身份由项目索引核对，不读取画布正文。 */
export async function readNativeEpisodeContent(projectId: string, episodeId: string, options: NativeProjectOptions = {}):
Promise<{ project: ProjectRecord; episode: EpisodeRecord; content: EpisodeContent; changeRevision: number } | null> {
  if (!isNativeProjectId(projectId) || !isNativeEpisodeId(episodeId)) return fail('invalid-identity');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return null;
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const [project, episode, content, revision, canvasKeys] = await Promise.all([
        request(tx.objectStore(ROOTS).get(projectId)) as Promise<ProjectRecord | undefined>,
        request(tx.objectStore(EPISODES).get(episodeId)) as Promise<EpisodeRecord | undefined>,
        request(tx.objectStore(EPISODE_CONTENTS).get(episodeId)) as Promise<EpisodeContent | undefined>,
        request(tx.objectStore(REVISIONS).get(projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
        request(tx.objectStore(CANVASES).index('projectId').getAllKeys(projectId)),
      ]);
      if (!project && !episode && !content && !revision) return null;
      if (!project || project.id !== projectId || project.kind !== 'series' || !episode || episode.id !== episodeId
        || episode.projectId !== projectId || !content || content.episodeId !== episodeId || !revision || revision.projectId !== projectId
        || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0 || !isNativeCanvasId(episode.canvasId)
        || !canvasKeys.includes(episode.canvasId)) return fail('invalid-membership');
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
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return fail('invalid-name');
  return value.trim();
};
const timestamp = (value?: number): number => {
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
  const values = await Promise.all([request(tx.objectStore(EPISODES).get(episodeId)), request(tx.objectStore(EPISODE_CONTENTS).get(episodeId)),
    request(tx.objectStore(CANVASES).get(canvasId)), request(tx.objectStore(RETIRED).get(episodeId)), request(tx.objectStore(RETIRED).get(canvasId))]);
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

/** 分集正文与创作配置一起条件提交，避免只保存其中一部分。 */
export async function updateNativeEpisodeComposite(input: { projectId: string; expectedProjectEpoch: number;
  episodeId: string; expectedCanvasId: string; expectedEpisodeRevision: number; expectedContentRevision: number;
  contentPatch?: Partial<Pick<EpisodeContent, 'outline' | 'script' | 'scriptFile' | 'creative' | 'assetRoster'>>;
  creationProfile?: CreationProfileSelection | null; teamProfileOverride?: AgentTeamProfile | null; now?: number },
options: NativeProjectOptions = {}): Promise<{ episode: EpisodeRecord; content: EpisodeContent }> {
  const fixed = structuredClone(input), now = timestamp(fixed.now);
  if (!isNativeEpisodeId(fixed.episodeId) || !isNativeCanvasId(fixed.expectedCanvasId)
    || !Number.isSafeInteger(fixed.expectedEpisodeRevision) || fixed.expectedEpisodeRevision < 0
    || !Number.isSafeInteger(fixed.expectedContentRevision) || fixed.expectedContentRevision < 0
    || fixed.contentPatch !== undefined && (!fixed.contentPatch || typeof fixed.contentPatch !== 'object' || Array.isArray(fixed.contentPatch)
      || Object.keys(fixed.contentPatch).some((key) => !['outline', 'script', 'scriptFile', 'creative', 'assetRoster'].includes(key)))
    || !Object.keys(fixed.contentPatch ?? {}).length && fixed.creationProfile === undefined && fixed.teamProfileOverride === undefined) return fail('invalid-episode-mutation');
  return mutate(fixed.projectId, fixed.expectedProjectEpoch, options, async (tx, current) => {
    const previous = current.episodes.find((item) => item.id === fixed.episodeId);
    const body = current.episodeContents.find((item) => item.episodeId === fixed.episodeId);
    if (!previous || !body || previous.canvasId !== fixed.expectedCanvasId
      || previous.revision !== fixed.expectedEpisodeRevision || body.revision !== fixed.expectedContentRevision) return fail('episode-version-conflict');
    const updateMetadata = fixed.creationProfile !== undefined || fixed.teamProfileOverride !== undefined;
    const episode: EpisodeRecord = { ...previous, ...(updateMetadata ? { revision: increment(previous.revision), updatedAt: now } : {}) };
    if (fixed.creationProfile === null) delete episode.creationProfile;
    else if (fixed.creationProfile !== undefined) episode.creationProfile = fixed.creationProfile;
    if (fixed.teamProfileOverride === null) delete episode.teamProfileOverride;
    else if (fixed.teamProfileOverride !== undefined) episode.teamProfileOverride = fixed.teamProfileOverride;
    const content: EpisodeContent = Object.keys(fixed.contentPatch ?? {}).length
      ? { ...body, ...fixed.contentPatch, revision: increment(body.revision) } : body;
    const project = { ...current.project, updatedAt: now };
    const next = validateAggregate(project, current.content, current.episodes.map((item) => item.id === episode.id ? episode : item),
      current.episodeContents.map((item) => item.episodeId === content.episodeId ? content : item), current.canvases);
    await Promise.all([request(tx.objectStore(ROOTS).put(next.project)),
      ...(updateMetadata ? [request(tx.objectStore(EPISODES).put(episode))] : []),
      ...(content !== body ? [request(tx.objectStore(EPISODE_CONTENTS).put(content))] : [])]);
    return { episode, content };
  });
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

/** 原子转为剧集，保留项目和原画布 ID；已打开画布 epoch 推进。 */
export async function convertNativeProjectToSeries(input: { projectId: string; expectedProjectEpoch: number; expectedCanvasId: string; expectedCanvasEpoch: number;
  expectedCanvasRevision: number; expectedStandaloneRevision: number; episodeId?: string; name: string; now?: number }, options: NativeProjectOptions = {}): Promise<NativeProjectAggregate> {
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
    const next = validateAggregate(project, projectContent, [episode], [body], [updatedCanvas]);
    await Promise.all([request(tx.objectStore(ROOTS).put(next.project)), request(tx.objectStore(CONTENTS).put(next.content)),
      request(tx.objectStore(CANVASES).put(updatedCanvas)), request(tx.objectStore(EPISODES).add(episode)),
      request(tx.objectStore(EPISODE_CONTENTS).add(body))]);
    return next;
  });
}

/** 原子新增分集和独立画布；零集剧集仍保留根项目与共享正文。 */
export async function createNativeEpisode(input: { projectId: string; expectedProjectEpoch: number; name: string;
  episodeId?: string; canvasId?: string; displayNo?: number; now?: number }, options: NativeProjectOptions = {}): Promise<NativeProjectAggregate> {
  const fixed = structuredClone(input), episodeId = fixed.episodeId ?? `e2-${crypto.randomUUID()}`,
    canvasId = fixed.canvasId ?? `c2-${crypto.randomUUID()}`, name = nameValue(fixed.name), now = timestamp(fixed.now);
  if (!isNativeEpisodeId(episodeId) || !isNativeCanvasId(canvasId)
    || fixed.displayNo !== undefined && (!Number.isSafeInteger(fixed.displayNo) || fixed.displayNo < 1)) return fail('invalid-identity');
  return mutate(fixed.projectId, fixed.expectedProjectEpoch, options, async (tx, current) => {
    if (current.project.kind !== 'series') return fail('not-series');
    await assertUnused(tx, episodeId, canvasId);
    const rank = current.episodes.length ? increment(current.episodes.reduce((max, episode) => Math.max(max, episode.orderRank), 0)) : 0;
    const episode: EpisodeRecord = { id: episodeId, projectId: fixed.projectId, canvasId, name, orderRank: rank,
      ...(fixed.displayNo !== undefined ? { displayNo: fixed.displayNo } : {}), createdAt: now, updatedAt: now,
      epoch: 1, revision: 0, settingsPolicy: { mode: 'inherit', overrides: {} } };
    const body: EpisodeContent = { episodeId, revision: 0, storageRootRef: current.project.storageRootRef };
    const canvas: CanvasDocument = { id: canvasId, projectId: fixed.projectId, episodeId, storageRootRef: current.project.storageRootRef,
      nodes: [], edges: [], groups: [], epoch: 1, revision: 0, revisionScope: 'project' };
    const project: ProjectRecord = { ...current.project, epoch: increment(current.project.epoch), updatedAt: now,
      lastOpenedCanvasId: current.project.lastOpenedCanvasId ?? canvasId };
    const next = validateAggregate(project, current.content, [...current.episodes, episode], [...current.episodeContents, body], [...current.canvases, canvas]);
    await Promise.all([request(tx.objectStore(ROOTS).put(next.project)), request(tx.objectStore(EPISODES).add(episode)),
      request(tx.objectStore(EPISODE_CONTENTS).add(body)), request(tx.objectStore(CANVASES).add(canvas))]);
    return next;
  });
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
        const scopedProject: ProjectRecord = { ...project, lastOpenedCanvasId: canvas.id };
        const blank: ProjectContent = { projectId: fixed.projectId, revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } };
        const frame = { project: scopedProject, content: blank, episodes: [episode], episodeContents: [updated], canvases: [canvas], previews: [], bindings: [] };
        nextEpisode = validateProjectModelTransferAggregate(frame, { ...frame, episodeContents: [body] }).episodeContents[0];
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
      const scopedProject: ProjectRecord = { ...project, lastOpenedCanvasId: canvas.id };
      const blank: ProjectContent = { projectId: fixed.projectId, revisions: { source: 0, script: 0, storyGraph: 0, assets: 0 } };
      const frame = { project: scopedProject, content: blank, episodes: [episode], episodeContents: [updated], canvases: [canvas], previews: [], bindings: [] };
      const checked = validateProjectModelTransferAggregate(frame, { ...frame, episodeContents: [body] }).episodeContents[0];
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
      request(tx.objectStore(RETIRED).add({ id: episode.id, projectId: fixed.projectId, kind: 'episode', deletedAt: now })),
      request(tx.objectStore(RETIRED).add({ id: canvas.id, projectId: fixed.projectId, kind: 'canvas', deletedAt: now }))]);
    return next;
  });
}

/** 删除整个独立库聚合，保留所有身份墓碑及归档审计；不删除文件系统内容。 */
export async function deleteNativeProject(input: { projectId: string; expectedProjectEpoch: number; expectedChangeRevision: number; now?: number },
  options: NativeProjectOptions = {}): Promise<void> {
  const fixed = structuredClone(input), now = timestamp(fixed.now);
  if (!isNativeProjectId(fixed.projectId) || !Number.isSafeInteger(fixed.expectedProjectEpoch) || fixed.expectedProjectEpoch < 0
    || !Number.isSafeInteger(fixed.expectedChangeRevision) || fixed.expectedChangeRevision < 0) return fail('invalid-identity');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    await transact(database, 'readwrite', options, async (tx) => {
      await assertNoPendingNativeMediaTasks(tx, fixed.projectId);
      const current = await readInTransaction(tx, fixed.projectId);
      if (!current) return fail('project-not-found');
      const [revision, transfers] = await Promise.all([
        request(tx.objectStore(REVISIONS).get(fixed.projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
        request(tx.objectStore(TRANSFER).index('projectId').getAll(fixed.projectId)) as Promise<Array<{ kind?: string; phase?: string }>>,
      ]);
      if (!revision || revision.projectId !== fixed.projectId || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0) return fail('invalid-project-revision');
      if (current.project.epoch !== fixed.expectedProjectEpoch || revision.changeRevision !== fixed.expectedChangeRevision) return fail('project-version-conflict');
      if (transfers.some((entry) => !(entry.kind === 'project-model-export' && ['registered', 'aborted'].includes(entry.phase ?? ''))
        && !(entry.kind === 'project-model-import' && entry.phase === 'finalized')
        && !(entry.kind === 'native-content-recovery' && entry.phase === 'ready')
        && !(entry.kind === 'native-shared-sync' && ['finalized', 'aborted'].includes(entry.phase ?? '')))) return fail('project-transfer-present');
      await Promise.all([
        request(tx.objectStore(ROOTS).delete(fixed.projectId)), request(tx.objectStore(CONTENTS).delete(fixed.projectId)),
        request(tx.objectStore(REVISIONS).delete(fixed.projectId)),
        request(tx.objectStore(RETIRED).add({ id: fixed.projectId, projectId: fixed.projectId, kind: 'project', deletedAt: now })),
        ...current.episodes.flatMap((episode) => [request(tx.objectStore(EPISODES).delete(episode.id)),
          request(tx.objectStore(EPISODE_CONTENTS).delete(episode.id)),
          request(tx.objectStore(RETIRED).add({ id: episode.id, projectId: fixed.projectId, kind: 'episode', deletedAt: now }))]),
        ...current.canvases.flatMap((canvas) => [request(tx.objectStore(CANVASES).delete(canvas.id)),
          request(tx.objectStore(RETIRED).add({ id: canvas.id, projectId: fixed.projectId, kind: 'canvas', deletedAt: now }))]),
      ]);
    });
  } finally { database.close(); }
}

/** 导出日志保留原发布身份；响应丢失时只能查询同一原生回执。 */
export interface NativeProjectExportJournal extends ProjectModelTransferExportJournal {
  projectId: string;
  expectedChangeRevision: number;
}

export async function prepareNativeProjectExport(input: { operationId: string; projectId: string; expectedChangeRevision: number;
  expectedExchange: ProjectModelTransferExchange | null; exchange: ProjectModelTransferExchange; includesHistory: boolean; sourceToken: string },
options: NativeProjectOptions = {}): Promise<NativeProjectExportJournal> {
  const fixed = structuredClone(input);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(fixed.operationId) || !isNativeProjectId(fixed.projectId)
    || !Number.isSafeInteger(fixed.expectedChangeRevision) || fixed.expectedChangeRevision < 0 || !/^[a-f0-9]{64}$/.test(fixed.sourceToken)) return fail('invalid-export');
  await verifiedExchange(fixed.exchange, fixed.expectedExchange);
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      await assertNoPendingNativeSharedSync(tx, fixed.projectId);
      const [project, revision, stored, existing, transfers] = await Promise.all([
        request(tx.objectStore(ROOTS).get(fixed.projectId)) as Promise<ProjectRecord | undefined>,
        request(tx.objectStore(REVISIONS).get(fixed.projectId)) as Promise<{ changeRevision: number } | undefined>,
        request(tx.objectStore(EXCHANGE).get(fixed.projectId)) as Promise<{ projectId: string; exchange: ProjectModelTransferExchange } | undefined>,
        request(tx.objectStore(TRANSFER).get(fixed.operationId)),
        request(tx.objectStore(TRANSFER).index('projectId').getAll(fixed.projectId)) as Promise<Array<{ kind?: string; phase?: string }>>,
      ]);
      if (!project || project.id !== fixed.projectId) return fail('project-not-found');
      assertNativeRoot(project);
      if (!revision || revision.changeRevision !== fixed.expectedChangeRevision
        || stored && stored.projectId !== fixed.projectId || !configValuesEqual(stored?.exchange ?? null, fixed.expectedExchange)) return fail('project-version-conflict');
      if (existing) return fail('operation-id-used');
      if (transfers.some((item) => !(item.kind === 'native-content-recovery' && item.phase === 'ready')
        && !['registered', 'aborted', 'finalized'].includes(item.phase))) return fail('project-transfer-present');
      const now = Date.now();
      const journal: NativeProjectExportJournal = { id: fixed.operationId, operationId: fixed.operationId, projectId: fixed.projectId,
        schemaVersion: 1, kind: 'project-model-export', generation: 1, sessionId: 'native-project', targetProjectId: fixed.projectId,
        expectedToken: fixed.sourceToken, expectedChangeRevision: fixed.expectedChangeRevision,
        expectedExchange: fixed.expectedExchange, includesHistory: fixed.includesHistory, head: fixed.exchange.localHead,
        exchange: fixed.exchange, phase: 'prepared', sequence: 0, createdAt: now, updatedAt: now };
      await request(tx.objectStore(TRANSFER).add(journal));
      return journal;
    }, [ROOTS, REVISIONS, EXCHANGE, TRANSFER]);
  } finally { database.close(); }
}

export async function readNativeProjectExport(operationId: string, options: NativeProjectOptions = {}): Promise<NativeProjectExportJournal | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(operationId)) return fail('invalid-export');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return null;
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const journal = await request(tx.objectStore(TRANSFER).get(operationId)) as NativeProjectExportJournal | undefined;
      if (!journal) return null;
      if (journal.kind !== 'project-model-export' || journal.operationId !== operationId || !isNativeProjectId(journal.projectId)) return fail('invalid-export');
      return journal;
    }, [TRANSFER]);
  } finally { database.close(); }
}

export async function advanceNativeProjectExport(operationId: string, sequence: number, phase: 'packing' | 'published' | 'registered',
  receipt?: { outputRef: string; packageDigest: string }, options: NativeProjectOptions = {}): Promise<NativeProjectExportJournal> {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(operationId) || !Number.isSafeInteger(sequence) || sequence < 0) return fail('invalid-export');
  if (phase !== 'packing' && (!receipt || !/^[a-f0-9]{64}$/.test(receipt.packageDigest)
    || !/^[A-Za-z0-9_-]{8,160}$/.test(receipt.outputRef))) return fail('invalid-export-receipt');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      const journal = await request(tx.objectStore(TRANSFER).get(operationId)) as NativeProjectExportJournal | undefined;
      if (!journal || journal.kind !== 'project-model-export' || journal.operationId !== operationId || !isNativeProjectId(journal.projectId)
        || journal.sequence !== sequence || (phase === 'packing' ? journal.phase !== 'prepared'
          : phase === 'published' ? journal.phase !== 'packing' : journal.phase !== 'published')) return fail('export-journal-conflict');
      if (phase === 'registered') {
        if (!receipt || receipt.outputRef !== journal.outputRef || receipt.packageDigest !== journal.packageDigest) return fail('export-receipt-conflict');
        const [revision, stored] = await Promise.all([
          request(tx.objectStore(REVISIONS).get(journal.projectId)) as Promise<{ changeRevision: number } | undefined>,
          request(tx.objectStore(EXCHANGE).get(journal.projectId)) as Promise<{ projectId: string; exchange: ProjectModelTransferExchange } | undefined>,
        ]);
        if (!revision || revision.changeRevision !== journal.expectedChangeRevision || stored && stored.projectId !== journal.projectId
          || !configValuesEqual(stored?.exchange ?? null, journal.expectedExchange)) return fail('project-version-conflict');
        const exchange = { ...journal.exchange, published: [...journal.exchange.published, { operationId, ...receipt, head: journal.head }] };
        await request(tx.objectStore(EXCHANGE).put({ projectId: journal.projectId, exchange }));
      }
      const next: NativeProjectExportJournal = { ...journal, phase, sequence: increment(journal.sequence), updatedAt: Date.now(),
        ...(receipt ? { outputRef: receipt.outputRef, packageDigest: receipt.packageDigest } : {}) };
      await request(tx.objectStore(TRANSFER).put(next));
      return next;
    }, [ROOTS, REVISIONS, EXCHANGE, TRANSFER]);
  } finally { database.close(); }
}

export interface NativeProjectImportJournal extends ProjectModelTransferImportJournal {
  projectId: string;
  assetRecords?: NativeAssetRecord[];
  /** 和项目聚合一同提交，旧 journal 缺省为空。 */
  editorRecords?: import('../../types/videoEditor').VideoEditorProjectRecord[];
  retiredEditorRecords?: import('../../types/videoEditor').VideoEditorProjectRecord[];
}

async function validateImportEditors(journal: Pick<NativeProjectImportJournal, 'editorRecords' | 'retiredEditorRecords' | 'next' | 'exchange' | 'media' | 'idMap'>): Promise<void> {
  const records = journal.editorRecords ?? [], retiredRecords = journal.retiredEditorRecords ?? [];
  if (!Array.isArray(records) || !Array.isArray(retiredRecords) || records.length + retiredRecords.length > 10000 || !journal.exchange) return fail('invalid-import-editor');
  if (!records.length && !retiredRecords.length) return;
  const { validateNativeVideoEditorRecord } = await import('./nativeVideoEditorRepository');
  const ids = new Set<string>(), retiredCanvasIds = new Set(importedRetiredCanvases(journal));
  for (const { record, retired } of [...records.map((record) => ({ record, retired: false })),
    ...retiredRecords.map((record) => ({ record, retired: true }))]) {
    const canvas = journal.next.canvases.find((item) => item.id === record.projectId);
    if ((retired ? !retiredCanvasIds.has(record.projectId) || !!canvas : !canvas) || ids.has(record.id)) return fail('invalid-import-editor');
    ids.add(record.id); validateNativeVideoEditorRecord(record, record.projectId);
    for (const track of record.tracks) for (const clip of track.clips) {
      if (clip.assetId || clip.sourceUrl !== undefined || clip.kind !== 'text' && !clip.relativePath) return fail('invalid-import-editor-media');
      if (!clip.relativePath) continue;
      const bindings = journal.exchange.fileBindings.filter((item) => item.localRelativePath === clip.relativePath
        && journal.exchange!.identities.some((identity) => identity.kind === 'storage-root' && identity.sourceId === item.rootRef
          && identity.localId === journal.next.project.storageRootRef));
      const media = journal.media.filter((item) => item.rootRef === journal.next.project.storageRootRef && item.relativePath === clip.relativePath);
      if (bindings.length !== 1 || media.length !== 1) return fail('invalid-import-editor-media');
    }
  }
}

/** 无媒体更新的恢复点；不包含/回退任务、预算或历史账本。 */
export interface NativeContentRecoveryPoint {
  operationId: string;
  projectId: string;
  kind: 'native-content-recovery';
  phase: 'ready';
  createdAt: number;
  aggregate: ProjectModelTransferAggregate;
  exchange: ProjectModelTransferExchange | null;
  /** 新恢复点冻结剪辑和独立备份身份；旧记录缺省不能当成空工程。 */
  editorRecords?: import('../../types/videoEditor').VideoEditorProjectRecord[];
  retiredEditorRecords?: import('../../types/videoEditor').VideoEditorProjectRecord[];
  backup?: NativeProjectUpdateJournal['backup'];
  oldAssets?: NativeProjectUpdateJournal['oldAssets'];
  assetSnapshots?: NativeAssetSnapshot[];
  missingFiles?: NativeMissingAssetProof[];
  /** 原操作输入用于回执丢失后的精确重试；不代表文件备份。 */
  intent?: { expectedRevision: number; sourceToken: string; next: ProjectModelTransferAggregate; exchange: ProjectModelTransferExchange | null };
}

export async function listNativeContentRecoveryPoints(projectId: string, options: NativeProjectOptions = {}): Promise<NativeContentRecoveryPoint[]> {
  if (!isNativeProjectId(projectId)) return fail('invalid-project-id');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return [];
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const rows = await request(tx.objectStore(TRANSFER).index('projectId').getAll(projectId)) as Array<{ kind?: string }>;
      const points = rows.filter((row): row is NativeContentRecoveryPoint => row.kind === 'native-content-recovery');
      for (const point of points) if (point.projectId !== projectId || point.phase !== 'ready'
        || !/^recovery-[A-Za-z0-9][A-Za-z0-9-]{0,110}$/.test(point.operationId)
        || !Number.isSafeInteger(point.createdAt) || point.createdAt < 0 || point.aggregate?.project?.id !== projectId) return fail('invalid-recovery');
      return points.sort((a, b) => b.createdAt - a.createdAt);
    }, [TRANSFER]);
  } finally { database.close(); }
}

function assertNativeContentWithoutMedia(value: unknown): void {
  const pending = [value], seen = new WeakSet<object>();
  const fileFields = new Set(['filePath', 'relativePath', 'imageRelativePath', 'imageUrl', 'videoUrl', 'audioUrl', 'sourceUrl', 'url',
    'assetId', 'imageAssetId', 'scriptFile', 'originalWork', 'directorCaptureRelativePaths', 'directorCaptureFilePaths', 'directorCaptureUrls']);
  let count = 0;
  while (pending.length) {
    const current = pending.pop();
    if (++count > 1_000_000) return fail('content-update-too-large');
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) return fail('cyclic-content');
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      if (fileFields.has(key) && child !== undefined && child !== null && child !== '' && (!Array.isArray(child) || child.length)) {
        return fail('content-update-media-not-supported');
      }
      if (typeof child === 'string' && /^\s*(?:data:|blob:|asset:)/i.test(child)) return fail('content-update-media-not-supported');
      if (child && typeof child === 'object') pending.push(child);
    }
  }
}

/** 无需文件发布的更新和恢复可在单个新库事务内交换正文并保留更新前快照。 */
export async function replaceNativeContentWithRecovery(input: { operationId: string; expected: ProjectModelTransferCapture;
  next: ProjectModelTransferAggregate; exchange: ProjectModelTransferExchange | null }, options: NativeProjectOptions = {}): Promise<NativeContentRecoveryPoint> {
  const fixed = structuredClone(input), projectId = fixed.expected.aggregate.project.id;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,110}$/.test(fixed.operationId) || !isNativeProjectId(projectId)
    || !Number.isSafeInteger(fixed.expected.sessionRevision) || fixed.expected.sessionRevision < 0
    || fixed.next.project.id !== projectId || fixed.next.previews.length || fixed.next.bindings.length) return fail('invalid-update');
  if (fixed.expected.exchange?.bundle.files.length || fixed.exchange?.bundle.files.length) return fail('content-update-media-not-supported');
  for (const aggregate of [fixed.expected.aggregate, fixed.next]) {
    assertNativeContentWithoutMedia([aggregate.content, aggregate.episodes.map((item) => item.settingsPolicy),
      aggregate.episodeContents, aggregate.canvases, aggregate.project.defaultSettings]);
  }
  await verifiedExchange(fixed.exchange, fixed.expected.exchange);
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      await assertNoPendingNativeSharedSync(tx, projectId);
      await assertNoPendingNativeMediaTasks(tx, projectId);
      const current = await readInTransaction(tx, projectId);
      const [revision, exchange, previousPoint, operations] = await Promise.all([
        request(tx.objectStore(REVISIONS).get(projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
        request(tx.objectStore(EXCHANGE).get(projectId)) as Promise<{ projectId: string; exchange: ProjectModelTransferExchange } | undefined>,
        request(tx.objectStore(TRANSFER).get(`recovery-${fixed.operationId}`)),
        request(tx.objectStore(TRANSFER).index('projectId').getAll(projectId)) as Promise<Array<{ kind?: string; phase?: string }>>,
      ]);
      if (previousPoint !== undefined) {
        const receipt = previousPoint as NativeContentRecoveryPoint;
        if (receipt.kind !== 'native-content-recovery' || receipt.phase !== 'ready' || receipt.projectId !== projectId
          || !receipt.intent || receipt.intent.expectedRevision !== fixed.expected.sessionRevision || receipt.intent.sourceToken !== fixed.expected.sourceToken
          || !configValuesEqual(receipt.aggregate, fixed.expected.aggregate)
          || !configValuesEqual(receipt.exchange, fixed.expected.exchange) || !configValuesEqual(receipt.intent.next, fixed.next)
          || !configValuesEqual(receipt.intent.exchange, fixed.exchange)) return fail('project-transfer-present');
        return receipt;
      }
      if (!current || !revision || revision.projectId !== projectId || revision.changeRevision !== fixed.expected.sessionRevision
        || !configValuesEqual(current.project, fixed.expected.aggregate.project)
        || !configValuesEqual(current.content, fixed.expected.aggregate.content)
        || !configValuesEqual(current.episodes, fixed.expected.aggregate.episodes)
        || !configValuesEqual(current.episodeContents, fixed.expected.aggregate.episodeContents)
        || !configValuesEqual(current.canvases, fixed.expected.aggregate.canvases)
        || !configValuesEqual(exchange?.exchange ?? null, fixed.expected.exchange)) return fail('project-version-conflict');
      if (operations.some((item) => !(item.kind === 'native-content-recovery' && item.phase === 'ready')
        && !(item.kind === 'project-model-export' && ['registered', 'aborted'].includes(item.phase ?? ''))
        && !(item.kind === 'project-model-import' && item.phase === 'finalized')
        && !(item.kind === 'native-shared-sync' && ['finalized', 'aborted'].includes(item.phase ?? '')))) return fail('project-transfer-present');
      const before = fixed.expected.aggregate, updated = structuredClone(fixed.next);
      const ids = (values: Array<{ id: string }>) => values.map((item) => item.id).sort();
      if (updated.project.kind !== before.project.kind || updated.project.storageRootRef !== before.project.storageRootRef
        || updated.project.dataFolder !== before.project.dataFolder || !configValuesEqual(updated.project.storageBindings, before.project.storageBindings)
        || !configValuesEqual(ids(updated.episodes), ids(before.episodes)) || !configValuesEqual(ids(updated.canvases), ids(before.canvases))) {
        return fail('update-structure-requires-media-journal');
      }
      const now = Date.now();
      updated.project.epoch = increment(current.project.epoch); updated.project.updatedAt = now;
      if (current.project.lastOpenedCanvasId) updated.project.lastOpenedCanvasId = current.project.lastOpenedCanvasId;
      else delete updated.project.lastOpenedCanvasId;
      for (const domain of ['source', 'script', 'storyGraph', 'assets'] as const) updated.content.revisions[domain] = increment(current.content.revisions[domain]);
      if (updated.content.standaloneCreative) updated.content.standaloneCreative.revision = increment(current.content.standaloneCreative?.revision ?? 0);
      for (const episode of updated.episodes) {
        const prior = current.episodes.find((item) => item.id === episode.id)!;
        if (episode.canvasId !== prior.canvasId) return fail('update-structure-requires-media-journal');
        episode.createdAt = prior.createdAt; episode.epoch = increment(prior.epoch); episode.revision = increment(prior.revision); episode.updatedAt = now;
      }
      for (const body of updated.episodeContents) body.revision = increment(current.episodeContents.find((item) => item.episodeId === body.episodeId)?.revision ?? 0);
      for (const canvas of updated.canvases) {
        const prior = current.canvases.find((item) => item.id === canvas.id)!;
        if (canvas.episodeId !== prior.episodeId || canvas.storageRootRef !== prior.storageRootRef) return fail('update-structure-requires-media-journal');
        canvas.epoch = increment(prior.epoch); canvas.revision = increment(prior.revision);
      }
      const checked = validateAggregate(updated.project, updated.content, updated.episodes, updated.episodeContents, updated.canvases);
      const recovery: NativeContentRecoveryPoint = { operationId: `recovery-${fixed.operationId}`, projectId,
        kind: 'native-content-recovery', phase: 'ready', createdAt: now, aggregate: structuredClone(before), exchange: fixed.expected.exchange,
        intent: { expectedRevision: fixed.expected.sessionRevision, sourceToken: fixed.expected.sourceToken, next: fixed.next, exchange: fixed.exchange } };
      await Promise.all([request(tx.objectStore(TRANSFER).add(recovery)), request(tx.objectStore(ROOTS).put(checked.project)),
        request(tx.objectStore(CONTENTS).put(checked.content)), ...checked.episodes.map((item) => request(tx.objectStore(EPISODES).put(item))),
        ...checked.episodeContents.map((item) => request(tx.objectStore(EPISODE_CONTENTS).put(item))),
        ...checked.canvases.map((item) => request(tx.objectStore(CANVASES).put(item))),
        request(tx.objectStore(REVISIONS).put({ projectId, changeRevision: increment(revision.changeRevision) })),
        ...(fixed.exchange ? [request(tx.objectStore(EXCHANGE).put({ projectId, exchange: fixed.exchange }))] : [request(tx.objectStore(EXCHANGE).delete(projectId))])]);
      return recovery;
    }, STORES, true);
  } finally { database.close(); }
}

/** 素材更新采用独立文件备份与写屏障；文件发布/读回由原生端口验证。 */
export interface NativeProjectUpdateJournal extends Omit<NativeProjectImportJournal, 'phase'> {
  phase: NativeProjectImportJournal['phase'] | 'aborted';
  mode: 'update-existing' | 'restore-content';
  expected: ProjectModelTransferCapture;
  editorRecords: import('../../types/videoEditor').VideoEditorProjectRecord[];
  backup: { operationId: string; outputRef: string; packageDigest: string };
  oldAssets: Array<{ rootRef: string; path: string; bytes: number; sha256: string }>;
  oldAssetSnapshots?: NativeAssetSnapshot[];
  assetRecords?: NativeAssetRecord[];
  recoveryState?: { capture: ProjectModelTransferCapture; exchange: ProjectModelTransferExchange; assets: NativeProjectUpdateJournal['oldAssets']; globalFiles: NativeGlobalRecoveryFile[]; referenceFiles?: NativeProjectUpdateJournal['oldAssets']; missingFiles?: NativeMissingAssetProof[]; currentFilesOnly?: boolean };
  /** 恢复只引用原恢复点冻结的原生聚合及旧文件清单。 */
  restoreRecoveryId?: string;
  restoreAssets?: Array<{ rootRef: string; path: string; bytes: number; sha256: string }>;
  rawRecovery?: { recoveryId: string; episodeIds: NativeRecoveryIdentityMapping[]; canvasIds: NativeRecoveryIdentityMapping[]; files: NativeRecoveryFileMapping[];
    rebindings: Array<{ kind: 'episode' | 'canvas'; from: string; to: string }>; assets?: NativeRecoveryAssetMapping[]; assetSnapshots?: NativeAssetSnapshot[] };
}

type NativeUpdateInput = Omit<NativeProjectUpdateJournal,
  'id' | 'projectId' | 'schemaVersion' | 'kind' | 'generation' | 'sessionId' | 'phase' | 'sequence' | 'createdAt' | 'updatedAt' | 'cleanup'>;

function validateNativeUpdateInput(input: NativeUpdateInput): void {
  const projectId = input.targetProjectId;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.operationId) || !isNativeProjectId(projectId)
    || !['update-existing', 'restore-content'].includes(input.mode) || input.expected?.aggregate.project.id !== projectId
    || input.next.project.id !== projectId || !input.exchange || input.next.previews.length || input.next.bindings.length
    || !Number.isSafeInteger(input.expected.sessionRevision) || input.expected.sessionRevision < 0
    || !/^[a-f0-9]{64}$/.test(input.packageDigest) || !/^[a-f0-9]{64}$/.test(input.intentDigest)
    || !/^[a-f0-9]{64}$/.test(input.backup?.packageDigest ?? '')
    || input.backup?.operationId !== `backup-${input.operationId}`
    || !/^[A-Za-z0-9_-]{1,256}$/.test(input.backup?.outputRef ?? '')
    || !Array.isArray(input.expected.editorRecords) || !Array.isArray(input.expected.retiredEditorRecords) || !Array.isArray(input.editorRecords)
    || !Array.isArray(input.oldAssets) || input.oldAssets.length > 200_000
    || input.history.length || input.sourceRef !== `imports/native-update-${input.operationId}`
    || input.mode === 'restore-content' && (!/^recovery-[A-Za-z0-9-]{1,111}$/.test(input.restoreRecoveryId ?? '') || !Array.isArray(input.restoreAssets) || input.restoreAssets.length > 200_000)
    || input.mode !== 'restore-content' && (input.restoreRecoveryId !== undefined || input.restoreAssets !== undefined || input.rawRecovery !== undefined)
    || input.rawRecovery !== undefined && (input.rawRecovery.recoveryId !== input.restoreRecoveryId || !Array.isArray(input.rawRecovery.episodeIds)
      || !Array.isArray(input.rawRecovery.canvasIds) || !Array.isArray(input.rawRecovery.files) || !Array.isArray(input.rawRecovery.rebindings))) return fail('invalid-update-journal');
  const inventory = (items: NativeProjectUpdateJournal['oldAssets']) => {
    const result = new Map<string, NativeProjectUpdateJournal['oldAssets'][number]>();
    for (const item of items) {
      if (!item || !rootRefPattern.test(item.rootRef) || typeof item.path !== 'string' || !item.path
        || item.path.startsWith('/') || item.path.includes('\\') || item.path.split('/').some((part) => !part || part === '.' || part === '..')
        || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) return fail('invalid-update-backup');
      const key = JSON.stringify([item.rootRef, item.path]);
      if (result.has(key)) return fail('invalid-update-backup');
      result.set(key, item);
    }
    return result;
  };
  const currentAssets = inventory(input.oldAssets), restoredAssets = inventory(input.restoreAssets ?? []);
  if (input.recoveryState) {
    const missing = input.recoveryState.missingFiles ?? [];
    if (input.recoveryState.currentFilesOnly !== undefined && typeof input.recoveryState.currentFilesOnly !== 'boolean'
      || input.recoveryState.currentFilesOnly && input.mode !== 'restore-content') return fail('invalid-recovery-capture');
    if (!Array.isArray(missing) || missing.length > 200_000 || missing.length && input.mode !== 'restore-content'
      || new Set(missing.map((proof) => JSON.stringify([proof.rootRef, proof.path]))).size !== missing.length) return fail('invalid-recovery-capture');
    const restored = applyNativeGlobalRecoveryFiles(input.expected, input.recoveryState.globalFiles);
    rebindNativeAssetReferenceFiles(restored, input.recoveryState.referenceFiles ?? []);
    if (!configValuesEqual({ ...restored, assetMetadata: undefined }, { ...input.recoveryState.capture, assetMetadata: undefined })
      || !configValuesEqual(input.oldAssetSnapshots, input.recoveryState.capture.assetMetadata)) return fail('invalid-recovery-capture');
    inventory(input.recoveryState.assets);
    const references = input.recoveryState.referenceFiles ?? [];
    inventory(references);
    if (references.some((file) => !file.path.startsWith(`imports/asset-refs-${input.operationId}/`)
      || !input.expected.aggregate.project.storageBindings.some((binding) => binding.rootRef === file.rootRef))) return fail('invalid-recovery-capture');
    if (input.recoveryState.assets.some((asset) => ![...input.oldAssets, ...references, ...input.recoveryState!.globalFiles.map((file) => ({ rootRef: file.rootRef, path: file.path, bytes: file.bytes, sha256: file.sha256 }))]
      .some((item) => configValuesEqual(item, asset)))) return fail('invalid-recovery-capture');
  }
  if (input.assetRecords !== undefined && (!Array.isArray(input.assetRecords) || input.assetRecords.length > 10_000)) return fail('invalid-update-assets');
  for (const record of input.assetRecords ?? []) {
    validateNativeAsset(record);
    if (record.projectId !== projectId || record.ownerId !== projectId && !input.next.canvases.some((canvas) => canvas.id === record.ownerId)
      || record.primary !== (record.rootRef === input.next.project.storageRootRef)
      || ![...input.media.map((asset) => ({ rootRef: asset.rootRef, path: asset.relativePath, bytes: asset.bytes, sha256: asset.sha256 })), ...input.oldAssets, ...(input.restoreAssets ?? [])]
        .some((asset) => asset.rootRef === record.rootRef && asset.path === record.relativePath && asset.bytes === record.bytes && asset.sha256 === record.sha256)) return fail('invalid-update-assets');
  }
  for (const [key, item] of restoredAssets) {
    const old = currentAssets.get(key);
    if (old && (old.bytes !== item.bytes || old.sha256 !== item.sha256)) return fail('invalid-update-backup');
  }
  validateAggregate(input.next.project, input.next.content, input.next.episodes, input.next.episodeContents, input.next.canvases);
  if ([...input.oldAssets, ...(input.restoreAssets ?? [])].some((item) => !input.next.project.storageBindings.some((binding) => binding.rootRef === item.rootRef))) return fail('invalid-update-backup');
  const availableAssets = [...input.oldAssets, ...(input.restoreAssets ?? []).filter((item) => !input.oldAssets.some((old) => old.rootRef === item.rootRef && old.path === item.path))];
  validateNativeVideoEditorUpdateMedia({ records: input.editorRecords, canvasIds: input.next.canvases.map((item) => item.id),
    primaryRoot: input.next.project.storageRootRef, exchange: input.exchange, media: input.media, oldAssets: availableAssets });
  validateNativeVideoEditorUpdateMedia({ records: input.expected.retiredEditorRecords!,
    canvasIds: [...new Set(input.expected.retiredEditorRecords!.map((item) => item.projectId))],
    primaryRoot: input.next.project.storageRootRef, exchange: input.exchange, media: input.media, oldAssets: availableAssets });
  const nextCanvasIds = new Set(input.next.canvases.map((item) => item.id));
  const newlyRetired = input.expected.editorRecords!.filter((item) => !nextCanvasIds.has(item.projectId));
  validateNativeVideoEditorUpdateMedia({ records: newlyRetired, canvasIds: [...new Set(newlyRetired.map((item) => item.projectId))],
    primaryRoot: input.next.project.storageRootRef, exchange: input.exchange, media: input.media, oldAssets: availableAssets });
}

async function assertNativeRestorePoint(tx: IDBTransaction, input: NativeUpdateInput): Promise<void> {
  if (input.mode !== 'restore-content') return;
  const point = await request(tx.objectStore(TRANSFER).get(input.restoreRecoveryId!)) as NativeContentRecoveryPoint | undefined;
  if (!point || point.kind !== 'native-content-recovery' || point.phase !== 'ready' || point.projectId !== input.targetProjectId
    || !point.backup || !point.exchange || !point.editorRecords || !point.retiredEditorRecords || !point.oldAssets
    || !input.restoreAssets) return fail('restore-point-conflict');
  for (const missing of input.recoveryState?.missingFiles ?? []) {
    if (missing.sourceRecoveryId !== point.operationId) return fail('missing-backup-conflict');
    validateNativeMissingAssetProof(input.expected, point, missing, input.operationId);
  }
  const bindings = [...point.aggregate.project.storageBindings];
  for (const binding of input.expected.aggregate.project.storageBindings) {
    const existing = bindings.find((item) => item.rootRef === binding.rootRef);
    if (existing && !configValuesEqual(existing, binding)) return fail('restore-point-conflict');
    if (!existing) bindings.push(binding);
  }
  if (!configValuesEqual(input.next.project.storageBindings, bindings)) return fail('restore-point-conflict');
  if (input.rawRecovery) {
    const mappings = [...input.rawRecovery.episodeIds.map((item) => ({ ...item, kind: 'episode' as const })),
      ...input.rawRecovery.canvasIds.map((item) => ({ ...item, kind: 'canvas' as const }))];
    const head = input.exchange!.bundle.revisions.find((revision) => revision.canonicalVersion === 2
      && revision.revisionId === input.exchange!.bundle.head.revisionId);
    if (!head || head.canonicalVersion !== 2 || new Set(input.rawRecovery.rebindings.map((item) => JSON.stringify([item.kind, item.from]))).size !== input.rawRecovery.rebindings.length) return fail('restore-identity-conflict');
    for (const mapping of mappings) {
      const oldIdentity = point.exchange.identities.filter((item) => item.kind === mapping.kind && item.localId === mapping.from);
      if (oldIdentity.length !== 1) return fail('restore-identity-conflict');
      const rebound = input.rawRecovery.rebindings.filter((item) => item.kind === mapping.kind && item.from === oldIdentity[0].sourceId);
      if (rebound.length !== (mapping.from === mapping.to ? 0 : 1)) return fail('restore-identity-conflict');
      const sourceId = rebound[0]?.to ?? oldIdentity[0].sourceId;
      if (!input.exchange!.identities.some((item) => item.kind === mapping.kind && item.sourceId === sourceId && item.localId === mapping.to)
        || !head.snapshot.entities.some((item) => item.kind === mapping.kind && item.id === sourceId)
        || rebound.length && !head.snapshot.historicalTargets.some((item) => item.state === 'retired' && item.kind === mapping.kind
          && item.projectId === head.snapshot.rootProjectId && item.id === oldIdentity[0].sourceId)) return fail('restore-identity-conflict');
      const tombstone = await request(tx.objectStore(RETIRED).get(mapping.from)) as { id?: string; projectId?: string; kind?: string } | undefined;
      const active = mapping.kind === 'episode'
        ? input.expected.aggregate.episodes.some((item) => item.id === mapping.from)
        : input.expected.aggregate.canvases.some((item) => item.id === mapping.from);
      if (mapping.from === mapping.to ? !!tombstone || !active
        : !tombstone || tombstone.id !== mapping.from || tombstone.projectId !== input.targetProjectId || tombstone.kind !== mapping.kind) return fail('restore-identity-conflict');
    }
    if (input.rawRecovery.rebindings.length !== mappings.filter((item) => item.from !== item.to).length) return fail('restore-identity-conflict');
    if (input.rawRecovery.files.length !== point.oldAssets.length) return fail('restore-file-conflict');
    const restoredKeys = new Set(input.restoreAssets.map((item) => JSON.stringify([item.rootRef, item.path])));
    if (restoredKeys.size !== input.restoreAssets.length || input.restoreAssets.some((item) => !point.oldAssets!.some((old) => configValuesEqual(item, old)))) return fail('restore-file-conflict');
    for (const original of point.oldAssets) {
      const files = input.rawRecovery.files.filter((item) => item.rootRef === original.rootRef && item.from === original.path);
      if (files.length !== 1) return fail('restore-file-conflict');
      const file = files[0], originalRoots = point.exchange.identities.filter((item) => item.kind === 'storage-root' && item.localId === original.rootRef);
      if (originalRoots.length !== 1) return fail('restore-file-conflict');
      const originalBindings = point.exchange.fileBindings.filter((item) => item.rootRef === originalRoots[0].sourceId && item.localRelativePath === original.path);
      if (originalBindings.length !== 1) return fail('restore-file-conflict');
      const binding = originalBindings[0], target = input.exchange!.fileBindings.filter((item) => item.id === binding.id
        && item.rootRef === binding.rootRef && item.relativePath === binding.relativePath && item.localRelativePath === file.to);
      if (target.length !== 1) return fail('restore-file-conflict');
      const restored = restoredKeys.has(JSON.stringify([original.rootRef, original.path]));
      if (file.to === file.from) {
        if (!restored) return fail('restore-file-conflict');
      } else {
        const published = input.media.filter((item) => item.rootRef === original.rootRef && item.relativePath === file.to
          && item.bytes === original.bytes && item.sha256 === original.sha256);
        const source = input.sourceFiles?.filter((item) => item.id === binding.id && item.rootRef === binding.rootRef
          && item.relativePath === binding.relativePath && item.bytes === original.bytes && item.sha256 === original.sha256) ?? [];
        if (restored || published.length !== 1 || source.length !== 1) return fail('restore-file-conflict');
      }
    }
    const assetMappings = input.rawRecovery.assets ?? [], records = input.assetRecords ?? [];
    const snapshots = point.assetSnapshots ?? [];
    if (input.rawRecovery.assetSnapshots && !configValuesEqual(input.rawRecovery.assetSnapshots, snapshots)) return fail('restore-asset-conflict');
    if (assetMappings.length !== records.length || assetMappings.length !== snapshots.length) return fail('restore-asset-conflict');
    for (const mapping of assetMappings) {
      const sources = snapshots.filter((asset) => asset.assetId === mapping.from && asset.rootRef === mapping.rootRef && asset.path === mapping.fromPath);
      const targets = records.filter((asset) => asset.assetId === mapping.to && asset.rootRef === mapping.rootRef && asset.relativePath === mapping.toPath);
      if (sources.length !== 1 || targets.length !== 1) return fail('restore-asset-conflict');
      const source = sources[0], target = targets[0];
      if (!point.oldAssets.some((asset) => asset.rootRef === source.rootRef && asset.path === source.path && asset.bytes === source.bytes && asset.sha256 === source.sha256)
        || target.bytes !== source.bytes || target.sha256 !== source.sha256
        || target.ownerId !== (source.ownerId === input.targetProjectId || point.aggregate.bindings.some((binding) => binding.retired && binding.canvasId === source.ownerId)
          ? input.targetProjectId : input.rawRecovery.canvasIds.find((canvas) => canvas.from === source.ownerId)?.to)
        || !configValuesEqual(target.tags, source.tags ? { ...source.tags, assetId: target.assetId } : undefined)
        || !configValuesEqual(target.images, remapNativeAssetImageReferences(source.images ?? [], source.rootRef, input.rawRecovery.files).map((image) => ({ ...image, assetId: target.assetId,
          id: `asset-image:${encodeURIComponent(target.assetId)}:${image.contentDigest}` })))) return fail('restore-asset-conflict');
    }
    const rebuilt = materializeNativeRawRecovery({ original: point.aggregate, target: input.next,
      episodeIds: input.rawRecovery.episodeIds, canvasIds: input.rawRecovery.canvasIds,
      files: input.rawRecovery.files, editors: point.editorRecords,
      assets: referencedNativeRecoveryAssets(point.aggregate, point.editorRecords, input.rawRecovery.assets ?? []), knownAssets: input.rawRecovery.assets });
    if (!configValuesEqual(rebuilt.aggregate, input.next) || !configValuesEqual(rebuilt.editors, input.editorRecords)) return fail('restore-point-conflict');
    return;
  }
  const expected = { ...point.aggregate, project: { ...point.aggregate.project, storageBindings: bindings }, bindings: [], previews: [] };
  if (!configValuesEqual(point.oldAssets, input.restoreAssets) || input.media.length
    || !configValuesEqual(expected, input.next) || !configValuesEqual(point.editorRecords, input.editorRecords)) return fail('restore-point-conflict');
}

/** 原输入与已核验的独立备份在同一严格事务中冻结；之后所有作品写入失败关闭。 */
export async function prepareNativeProjectUpdate(input: NativeUpdateInput, options: NativeProjectOptions = {}): Promise<NativeProjectUpdateJournal> {
  const fixed = structuredClone(input), projectId = fixed.targetProjectId;
  validateNativeUpdateInput(fixed);
  await verifiedExchange(fixed.exchange, fixed.expected.exchange);
  if (fixed.recoveryState) await verifiedExchange(fixed.recoveryState.exchange, fixed.expected.exchange);
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      if (tx.durability !== 'strict') return fail('strict-durability-unavailable');
      const store = tx.objectStore(TRANSFER), existing = await request(store.get(fixed.operationId)) as NativeProjectUpdateJournal | undefined;
      if (existing) {
        const original = Object.fromEntries(Object.keys(fixed).map((key) => [key, (existing as unknown as Record<string, unknown>)[key]]));
        if (existing.kind !== 'project-model-import' || existing.projectId !== projectId
          || !configValuesEqual(original, fixed)) return fail('update-journal-conflict');
        return existing;
      }
      await assertNoPendingNativeSharedSync(tx, projectId);
      await assertNoPendingNativeMediaTasks(tx, projectId);
      await assertNativeRestorePoint(tx, fixed);
      const current = await readInTransaction(tx, projectId);
      const [revision, exchange, operations] = await Promise.all([
        request(tx.objectStore(REVISIONS).get(projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
        request(tx.objectStore(EXCHANGE).get(projectId)) as Promise<{ projectId: string; exchange: ProjectModelTransferExchange } | undefined>,
        request(store.index('projectId').getAll(projectId)) as Promise<Array<{ kind?: string; phase?: string }>>,
      ]);
      if (!current || !revision || revision.projectId !== projectId || revision.changeRevision !== fixed.expected.sessionRevision
        || !configValuesEqual(current.project, fixed.expected.aggregate.project) || !configValuesEqual(current.content, fixed.expected.aggregate.content)
        || !configValuesEqual(current.episodes, fixed.expected.aggregate.episodes) || !configValuesEqual(current.episodeContents, fixed.expected.aggregate.episodeContents)
        || !configValuesEqual(current.canvases, fixed.expected.aggregate.canvases) || !configValuesEqual(exchange?.exchange ?? null, fixed.expected.exchange)) return fail('project-version-conflict');
      if (operations.some((row) => !(row.kind === 'native-content-recovery' && row.phase === 'ready')
        && !(row.kind === 'project-model-export' && ['registered', 'aborted'].includes(row.phase ?? ''))
        && !(row.kind === 'project-model-import' && ['finalized', 'aborted'].includes(row.phase ?? ''))
        && !(row.kind === 'native-shared-sync' && ['finalized', 'aborted'].includes(row.phase ?? '')))) return fail('project-transfer-present');
      const now = Date.now();
      const journal: NativeProjectUpdateJournal = { ...fixed, id: fixed.operationId, projectId, schemaVersion: 1,
        kind: 'project-model-import', generation: 1, sessionId: 'native-project', phase: 'prepared', sequence: 0,
        createdAt: now, updatedAt: now, cleanup: 'retain-until-unreferenced' };
      await request(store.add(journal)); return journal;
    }, STORES, true);
  } finally { database.close(); }
}

export async function readNativeProjectUpdate(operationId: string, options: NativeProjectOptions = {}): Promise<NativeProjectUpdateJournal | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,110}$/.test(operationId)) return fail('invalid-update-journal');
  const database = await openNativeProjectDatabase(false, options); if (!database) return null;
  try { return await transact(database, 'readonly', options, async (tx) => {
    const row = await request(tx.objectStore(TRANSFER).get(operationId)) as NativeProjectUpdateJournal | undefined;
    if (!row) return null;
    if (row.kind !== 'project-model-import' || !['update-existing', 'restore-content'].includes(row.mode)
      || row.operationId !== operationId || row.id !== operationId || row.projectId !== row.targetProjectId
      || !['prepared', 'media_publishing', 'media_ready', 'db_committed', 'finalized', 'aborted'].includes(row.phase)) return fail('invalid-update-journal');
    validateNativeUpdateInput(row); return row;
  }, [TRANSFER]); } finally { database.close(); }
}

export async function advanceNativeProjectUpdate(operationId: string, sequence: number, phase: 'media_publishing' | 'media_ready' | 'finalized',
  mediaPublicationRef?: string, options: NativeProjectOptions = {}): Promise<NativeProjectUpdateJournal> {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || phase === 'media_ready' && mediaPublicationRef !== `media_v1_${operationId}`) return fail('invalid-update-journal');
  const database = await openNativeProjectDatabase(false, options); if (!database) return fail('project-not-found');
  try { return await transact(database, 'readwrite', options, async (tx) => {
    if (tx.durability !== 'strict') return fail('strict-durability-unavailable');
    const store = tx.objectStore(TRANSFER), row = await request(store.get(operationId)) as NativeProjectUpdateJournal | undefined;
    if (!row || row.kind !== 'project-model-import' || !['update-existing', 'restore-content'].includes(row.mode)
      || row.operationId !== operationId || row.sequence !== sequence
      || (phase === 'media_publishing' ? row.phase !== 'prepared' : phase === 'media_ready' ? row.phase !== 'media_publishing' : row.phase !== 'db_committed')) return fail('update-journal-conflict');
    const next: NativeProjectUpdateJournal = { ...row, phase, sequence: increment(sequence), updatedAt: Date.now(),
      ...(mediaPublicationRef ? { mediaPublicationRef } : {}) };
    await request(store.put(next)); return next;
  }, [TRANSFER], true); } finally { database.close(); }
}

/** 仅撤销尚未提交的本机更新；备份、来源和已发布文件都保留供核对。 */
export async function abortNativeProjectUpdate(operationId: string, options: NativeProjectOptions = {}): Promise<NativeProjectUpdateJournal> {
  const database = await openNativeProjectDatabase(false, options); if (!database) return fail('project-not-found');
  try { return await transact(database, 'readwrite', options, async (tx) => {
    if (tx.durability !== 'strict') return fail('strict-durability-unavailable');
    const store = tx.objectStore(TRANSFER), row = await request(store.get(operationId)) as NativeProjectUpdateJournal | undefined;
    if (!row || row.kind !== 'project-model-import' || !['update-existing', 'restore-content'].includes(row.mode)
      || row.operationId !== operationId || row.id !== operationId) return fail('invalid-update-journal');
    if (row.phase === 'aborted') return row;
    if (!['prepared', 'media_publishing', 'media_ready'].includes(row.phase)) return fail('update-already-committed');
    const next: NativeProjectUpdateJournal = { ...row, phase: 'aborted', sequence: increment(row.sequence), updatedAt: Date.now() };
    await request(store.put(next)); return next;
  }, [TRANSFER], true); } finally { database.close(); }
}

/** 已验证独立备份与原生素材发布后，原子提交完整结构、剪辑、恢复点与原操作回执。 */
export async function commitNativeProjectUpdate(operationId: string, sequence: number, options: NativeProjectOptions = {}): Promise<NativeProjectUpdateJournal> {
  const prepared = await readNativeProjectUpdate(operationId, options);
  if (!prepared) return fail('invalid-update-journal');
  if (prepared.phase === 'db_committed' || prepared.phase === 'finalized') return prepared;
  if (prepared.phase !== 'media_ready' || prepared.sequence !== sequence || prepared.mediaPublicationRef !== `media_v1_${operationId}`) return fail('update-journal-conflict');
  await verifiedExchange(prepared.exchange, prepared.expected.exchange);
  // 权威文件读回在公开提交入口执行，不接受调用方提供的布尔值或可构造回执代替。
  // 动态加载避免仓储与原生端口静态循环；事务内仍会复核 journal 和全部 CAS 条件。
  const { verifyNativeProjectUpdateCommit } = await import('../nativeProjectUpdateVerification');
  await verifyNativeProjectUpdateCommit(prepared);
  const database = await openNativeProjectDatabase(false, options); if (!database) return fail('project-not-found');
  try { return await transact(database, 'readwrite', options, async (tx) => {
    if (tx.durability !== 'strict') return fail('strict-durability-unavailable');
    const transfer = tx.objectStore(TRANSFER), row = await request(transfer.get(operationId)) as NativeProjectUpdateJournal | undefined;
    if (!row || !configValuesEqual(row, prepared)) return fail('update-journal-conflict');
    await assertNoPendingNativeSharedSync(tx, row.projectId, operationId);
    await assertNativeRestorePoint(tx, row);
    const current = await readInTransaction(tx, row.projectId);
    const [revision, savedExchange] = await Promise.all([
      request(tx.objectStore(REVISIONS).get(row.projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
      request(tx.objectStore(EXCHANGE).get(row.projectId)) as Promise<{ projectId: string; exchange: ProjectModelTransferExchange } | undefined>,
    ]);
    if (!current || !revision || revision.projectId !== row.projectId || revision.changeRevision !== row.expected.sessionRevision
      || !configValuesEqual(current.project, row.expected.aggregate.project) || !configValuesEqual(current.content, row.expected.aggregate.content)
      || !configValuesEqual(current.episodes, row.expected.aggregate.episodes) || !configValuesEqual(current.episodeContents, row.expected.aggregate.episodeContents)
      || !configValuesEqual(current.canvases, row.expected.aggregate.canvases) || !configValuesEqual(savedExchange?.exchange ?? null, row.expected.exchange)) return fail('project-version-conflict');
    const updated = structuredClone(row.next), now = Date.now();
    if (updated.project.kind !== current.project.kind || updated.project.storageRootRef !== current.project.storageRootRef
      || updated.project.dataFolder !== current.project.dataFolder
      || current.project.storageBindings.some((old) => !updated.project.storageBindings.some((binding) => configValuesEqual(binding, old)))) return fail('invalid-update-roots');
    const oldEpisodes = new Map(current.episodes.map((item) => [item.id, item]));
    const oldCanvases = new Map(current.canvases.map((item) => [item.id, item]));
    const nextEpisodes = new Set(updated.episodes.map((item) => item.id)), nextCanvases = new Set(updated.canvases.map((item) => item.id));
    const addedEpisodes = updated.episodes.filter((item) => !oldEpisodes.has(item.id));
    const addedCanvases = updated.canvases.filter((item) => !oldCanvases.has(item.id));
    const removedEpisodes = current.episodes.filter((item) => !nextEpisodes.has(item.id));
    const removedCanvases = current.canvases.filter((item) => !nextCanvases.has(item.id));
    const occupied = await Promise.all([
      ...addedEpisodes.flatMap((item) => [request(tx.objectStore(EPISODES).get(item.id)), request(tx.objectStore(EPISODE_CONTENTS).get(item.id)), request(tx.objectStore(RETIRED).get(item.id))]),
      ...addedCanvases.flatMap((item) => [request(tx.objectStore(CANVASES).get(item.id)), request(tx.objectStore(RETIRED).get(item.id))]),
      ...removedEpisodes.map((item) => request(tx.objectStore(RETIRED).get(item.id))),
      ...removedCanvases.map((item) => request(tx.objectStore(RETIRED).get(item.id))),
    ]);
    if (occupied.some((value) => value !== undefined)) return fail('retired-or-occupied-identity');
    updated.project.epoch = increment(current.project.epoch); updated.project.updatedAt = now;
    const selected = current.project.lastOpenedCanvasId;
    const fallback = updated.episodes[0]?.canvasId ?? updated.canvases[0]?.id;
    if (selected && nextCanvases.has(selected)) updated.project.lastOpenedCanvasId = selected;
    else if (fallback) updated.project.lastOpenedCanvasId = fallback;
    else delete updated.project.lastOpenedCanvasId;
    for (const domain of ['source', 'script', 'storyGraph', 'assets'] as const) updated.content.revisions[domain] = increment(current.content.revisions[domain]);
    if (updated.content.standaloneCreative) updated.content.standaloneCreative.revision = increment(current.content.standaloneCreative?.revision ?? 0);
    for (const episode of updated.episodes) {
      const old = oldEpisodes.get(episode.id);
      if (old && episode.canvasId !== old.canvasId) return fail('update-identity-conflict');
      episode.createdAt = old?.createdAt ?? now; episode.epoch = old ? increment(old.epoch) : 1;
      episode.revision = old ? increment(old.revision) : 0; episode.updatedAt = now;
    }
    for (const body of updated.episodeContents) {
      const old = current.episodeContents.find((item) => item.episodeId === body.episodeId);
      body.revision = old ? increment(old.revision) : 0;
    }
    for (const canvas of updated.canvases) {
      const old = oldCanvases.get(canvas.id);
      if (old && (canvas.episodeId !== old.episodeId || canvas.storageRootRef !== old.storageRootRef)) return fail('update-identity-conflict');
      canvas.epoch = old ? increment(old.epoch) : 1; canvas.revision = old ? increment(old.revision) : 0;
    }
    const checked = validateAggregate(updated.project, updated.content, updated.episodes, updated.episodeContents, updated.canvases);
    const retiredRows = await request(tx.objectStore(RETIRED).getAll()) as Array<{ id?: unknown; projectId?: unknown; kind?: unknown }>;
    const retiredCanvasIds = retiredRows.filter((item) => item.projectId === row.projectId && item.kind === 'canvas').map((item) => item.id);
    if (retiredCanvasIds.some((id) => !isNativeCanvasId(id))) return fail('invalid-retired-identity');
    await replaceNativeVideoEditorInTransaction(tx.objectStore(EXCHANGE), { projectId: row.projectId,
      expected: row.expected.editorRecords!, expectedRetired: row.expected.retiredEditorRecords!, next: row.editorRecords,
      oldCanvasIds: current.canvases.map((item) => item.id), retiredCanvasIds: retiredCanvasIds as string[],
      nextCanvasIds: checked.canvases.map((item) => item.id) });
    const recovery: NativeContentRecoveryPoint = { operationId: `recovery-${operationId}`, projectId: row.projectId,
      kind: 'native-content-recovery', phase: 'ready', createdAt: now, aggregate: row.recoveryState?.capture.aggregate ?? row.expected.aggregate,
      exchange: row.recoveryState?.exchange ?? row.expected.exchange, editorRecords: row.expected.editorRecords, retiredEditorRecords: row.expected.retiredEditorRecords, backup: row.backup, oldAssets: row.recoveryState?.assets ?? row.oldAssets,
      ...(row.oldAssetSnapshots ? { assetSnapshots: row.oldAssetSnapshots } : {}) };
    if (row.recoveryState?.missingFiles?.length) recovery.missingFiles = structuredClone(row.recoveryState.missingFiles);
    await addNativeAssetsInTransaction(tx, row.assetRecords ?? [], updated);
    const result: NativeProjectUpdateJournal = { ...row, phase: 'db_committed', sequence: increment(sequence), updatedAt: now, committedToken: operationId };
    await Promise.all([
      request(transfer.add(recovery)), request(tx.objectStore(ROOTS).put(checked.project)), request(tx.objectStore(CONTENTS).put(checked.content)),
      ...removedEpisodes.flatMap((item) => [request(tx.objectStore(EPISODES).delete(item.id)), request(tx.objectStore(EPISODE_CONTENTS).delete(item.id)),
        request(tx.objectStore(RETIRED).add({ id: item.id, projectId: row.projectId, kind: 'episode', deletedAt: now }))]),
      ...removedCanvases.flatMap((item) => [request(tx.objectStore(CANVASES).delete(item.id)),
        request(tx.objectStore(RETIRED).add({ id: item.id, projectId: row.projectId, kind: 'canvas', deletedAt: now }))]),
      ...checked.episodes.map((item) => request(tx.objectStore(EPISODES).put(item))),
      ...checked.episodeContents.map((item) => request(tx.objectStore(EPISODE_CONTENTS).put(item))),
      ...checked.canvases.map((item) => request(tx.objectStore(CANVASES).put(item))),
      request(tx.objectStore(EXCHANGE).put({ projectId: row.projectId, exchange: row.exchange })),
      request(tx.objectStore(REVISIONS).put({ projectId: row.projectId, changeRevision: increment(revision.changeRevision) })),
      request(transfer.put(result)),
    ]);
    return result;
  }, STORES, true); } finally { database.close(); }
}

function importedRetiredCanvases(journal: Pick<NativeProjectImportJournal, 'idMap' | 'next' | 'exchange'>): string[] {
  const head = journal.exchange?.bundle.revisions.find((item) => item.canonicalVersion === 2
    && item.revisionId === journal.exchange?.bundle.head.revisionId);
  if (!head || head.canonicalVersion !== 2) return fail('invalid-import-head');
  const active = new Set(journal.next.canvases.map((item) => item.id));
  const retired = journal.idMap.filter((item) => item.kind === 'canvas' && !active.has(item.localId));
  if (retired.some((item) => !isNativeCanvasId(item.localId) || !head.snapshot.historicalTargets.some((target) =>
    target.state === 'retired' && target.kind === 'canvas' && target.projectId === head.snapshot.rootProjectId && target.id === item.sourceId))
    || new Set(retired.map((item) => item.localId)).size !== retired.length) return fail('invalid-retired-identity');
  return retired.map((item) => item.localId);
}

/** 先冻结映射与隔离来源；重复尝试只能恢复原操作，不能重分配 ID。 */
export async function prepareNativeProjectImport(input: Omit<NativeProjectImportJournal,
  'id' | 'schemaVersion' | 'kind' | 'generation' | 'sessionId' | 'phase' | 'sequence' | 'createdAt' | 'updatedAt' | 'cleanup' | 'projectId'>,
options: NativeProjectOptions = {}): Promise<NativeProjectImportJournal> {
  const fixed = structuredClone(input), operationId = fixed.operationId, projectId = fixed.targetProjectId;
  for (const asset of fixed.assetRecords ?? []) {
    validateNativeAsset(asset);
    if (asset.projectId !== projectId || !fixed.media.some((media) => media.rootRef === asset.rootRef
      && media.relativePath === asset.relativePath && media.bytes === asset.bytes && media.sha256 === asset.sha256)) return fail('invalid-import-asset');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(operationId) || !isNativeProjectId(projectId)
    || fixed.mode !== 'import-new' || fixed.expected !== null || fixed.next.project.id !== projectId
    || !fixed.exchange || fixed.next.previews.length || fixed.next.bindings.length
    || !/^[a-f0-9]{64}$/.test(fixed.packageDigest) || !/^[a-f0-9]{64}$/.test(fixed.intentDigest)
    || fixed.sourceRef !== undefined && !/^native-import-[a-f0-9-]{36}$/.test(fixed.sourceRef)) return fail('invalid-import');
  await verifiedExchange(fixed.exchange, null);
  validateAggregate(fixed.next.project, fixed.next.content, fixed.next.episodes, fixed.next.episodeContents, fixed.next.canvases);
  await validateImportEditors(fixed);
  const database = await openNativeProjectDatabase(true, options);
  if (!database) return fail('open-failed');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      if (tx.durability !== 'strict') return fail('strict-durability-unavailable');
      await assertNoPendingNativeSharedSync(tx, projectId);
      const ids = [projectId, ...fixed.next.episodes.map((item) => item.id), ...fixed.next.canvases.map((item) => item.id), ...importedRetiredCanvases(fixed)];
      const [existing, retired, roots, episodes, canvases, exchange] = await Promise.all([
        request(tx.objectStore(TRANSFER).get(operationId)),
        Promise.all(ids.map((id) => request(tx.objectStore(RETIRED).get(id)))),
        request(tx.objectStore(ROOTS).get(projectId)),
        Promise.all(fixed.next.episodes.map((item) => request(tx.objectStore(EPISODES).get(item.id)))),
        Promise.all([...fixed.next.canvases.map((item) => item.id), ...importedRetiredCanvases(fixed)]
          .map((id) => request(tx.objectStore(CANVASES).get(id)))),
        request(tx.objectStore(EXCHANGE).get(projectId)),
      ]);
      if (existing || roots !== undefined || exchange !== undefined || retired.some((item) => item !== undefined)
        || episodes.some((item) => item !== undefined) || canvases.some((item) => item !== undefined)) return fail('identity-conflict');
      const now = Date.now();
      const journal: NativeProjectImportJournal = { ...fixed, id: operationId, projectId, schemaVersion: 1, kind: 'project-model-import',
        generation: 1, sessionId: 'native-project', phase: 'prepared', sequence: 0, createdAt: now, updatedAt: now,
        cleanup: 'retain-until-unreferenced' };
      await request(tx.objectStore(TRANSFER).add(journal));
      return journal;
    }, [ROOTS, EPISODES, CANVASES, RETIRED, EXCHANGE, TRANSFER], true);
  } finally { database.close(); }
}

export async function readNativeProjectImport(operationId: string, options: NativeProjectOptions = {}): Promise<NativeProjectImportJournal | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(operationId)) return fail('invalid-import');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return null;
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const journal = await request(tx.objectStore(TRANSFER).get(operationId)) as NativeProjectImportJournal | undefined;
      if (!journal) return null;
      if (journal.kind !== 'project-model-import' || journal.mode !== 'import-new' || journal.operationId !== operationId || !isNativeProjectId(journal.projectId)
        || journal.targetProjectId !== journal.projectId) return fail('invalid-import');
      return journal;
    }, [TRANSFER]);
  } finally { database.close(); }
}

export async function advanceNativeProjectImport(operationId: string, sequence: number, phase: 'media_publishing' | 'media_ready' | 'finalized',
  mediaPublicationRef?: string, options: NativeProjectOptions = {}): Promise<NativeProjectImportJournal> {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(operationId) || !Number.isSafeInteger(sequence) || sequence < 0
    || phase === 'media_ready' && mediaPublicationRef !== `media_v1_${operationId}`) return fail('invalid-import');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('invalid-import');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      if (tx.durability !== 'strict') return fail('strict-durability-unavailable');
      const journal = await request(tx.objectStore(TRANSFER).get(operationId)) as NativeProjectImportJournal | undefined;
      if (!journal || journal.kind !== 'project-model-import' || journal.mode !== 'import-new' || journal.operationId !== operationId || journal.sequence !== sequence
        || (phase === 'media_publishing' ? journal.phase !== 'prepared' : phase === 'media_ready' ? journal.phase !== 'media_publishing'
          : journal.phase !== 'db_committed')) return fail('import-journal-conflict');
      const next: NativeProjectImportJournal = { ...journal, phase, sequence: increment(sequence), updatedAt: Date.now(),
        ...(mediaPublicationRef ? { mediaPublicationRef } : {}) };
      await request(tx.objectStore(TRANSFER).put(next)); return next;
    }, [TRANSFER], true);
  } finally { database.close(); }
}

/** 媒体与历史回执已由调用者核验；聚合与交换状态、原操作同事务提交。 */
export async function commitNativeProjectImport(operationId: string, sequence: number, options: NativeProjectOptions = {}): Promise<NativeProjectImportJournal> {
  const prepared = await readNativeProjectImport(operationId, options);
  if (!prepared || prepared.phase !== 'media_ready' || prepared.sequence !== sequence) return fail('import-journal-conflict');
  await verifiedExchange(prepared.exchange, null);
  await validateImportEditors(prepared);
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('invalid-import');
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      if (tx.durability !== 'strict') return fail('strict-durability-unavailable');
      const current = await request(tx.objectStore(TRANSFER).get(operationId)) as NativeProjectImportJournal | undefined;
      if (!current || !configValuesEqual(current, prepared)) return fail('import-journal-conflict');
      await assertNoPendingNativeSharedSync(tx, current.projectId);
      const value = validateAggregate(current.next.project, current.next.content, current.next.episodes, current.next.episodeContents, current.next.canvases);
      const retiredCanvases = importedRetiredCanvases(current);
      const ids = [value.project.id, ...value.episodes.map((item) => item.id), ...value.canvases.map((item) => item.id), ...retiredCanvases];
      const [retired, root, content, episodes, episodeContents, canvases, exchange] = await Promise.all([
        Promise.all(ids.map((id) => request(tx.objectStore(RETIRED).get(id)))), request(tx.objectStore(ROOTS).get(value.project.id)),
        request(tx.objectStore(CONTENTS).get(value.project.id)), Promise.all(value.episodes.map((item) => request(tx.objectStore(EPISODES).get(item.id)))),
        Promise.all(value.episodeContents.map((item) => request(tx.objectStore(EPISODE_CONTENTS).get(item.episodeId)))),
        Promise.all([...value.canvases.map((item) => item.id), ...retiredCanvases].map((id) => request(tx.objectStore(CANVASES).get(id)))),
        request(tx.objectStore(EXCHANGE).get(value.project.id)),
      ]);
      if (root !== undefined || content !== undefined || exchange !== undefined || retired.some((item) => item !== undefined)
        || episodes.some((item) => item !== undefined) || episodeContents.some((item) => item !== undefined)
        || canvases.some((item) => item !== undefined)) return fail('identity-conflict');
      const next: NativeProjectImportJournal = { ...current, phase: 'db_committed', sequence: increment(sequence), updatedAt: Date.now(), committedToken: operationId };
      for (const asset of current.assetRecords ?? []) if (!current.media.some((media) => media.rootRef === asset.rootRef
        && media.relativePath === asset.relativePath && media.bytes === asset.bytes && media.sha256 === asset.sha256)) return fail('invalid-import-asset');
      await addNativeAssetsInTransaction(tx, current.assetRecords ?? [], value);
      await Promise.all([request(tx.objectStore(ROOTS).add(value.project)), request(tx.objectStore(CONTENTS).add(value.content)),
        ...value.episodes.map((item) => request(tx.objectStore(EPISODES).add(item))),
        ...value.episodeContents.map((item) => request(tx.objectStore(EPISODE_CONTENTS).add(item))),
        ...value.canvases.map((item) => request(tx.objectStore(CANVASES).add(item))),
        ...retiredCanvases.map((id) => request(tx.objectStore(RETIRED).add({ id, projectId: value.project.id, kind: 'canvas', deletedAt: Date.now() }))),
        request(tx.objectStore(REVISIONS).add({ projectId: value.project.id, changeRevision: 0 })),
        request(tx.objectStore(EXCHANGE).add({ projectId: value.project.id, exchange: current.exchange })),
        ...[...(current.editorRecords ?? []), ...(current.retiredEditorRecords ?? [])].map((record) => request(tx.objectStore(EXCHANGE).add({ projectId: `video-editor:${record.id}`,
          kind: 'video-editor-v1', ownerProjectId: value.project.id, canvasId: record.projectId, record }))),
        request(tx.objectStore(TRANSFER).put(next))]);
      return next;
    }, undefined, true);
  } finally { database.close(); }
}
