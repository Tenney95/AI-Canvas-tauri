import type { ProjectRecord } from '../../../types/project';
import type { ProjectModelTransferAggregate, ProjectModelTransferCapture, ProjectModelTransferExchange, ProjectModelTransferExportJournal, ProjectModelTransferImportJournal } from '../../../types/projectModelTransfer';
import { configValuesEqual } from '../../configPatch';
import { readNativeProjectExchange, verifiedExchange } from '../projectModelTransferRepository';
import { replaceNativeVideoEditorInTransaction, validateNativeVideoEditorUpdateMedia } from '../nativeVideoEditorUpdate';
import { materializeNativeRawRecovery, referencedNativeRecoveryAssets, type NativeRecoveryIdentityMapping, type NativeRecoveryFileMapping, type NativeRecoveryAssetMapping } from '../../nativeProjectRawRecovery';
import { addNativeAssetsInTransaction, validateNativeAsset, type NativeAssetRecord } from '../nativeAssetRepository';
import { applyNativeGlobalRecoveryFiles, remapNativeAssetImageReferences, rebindNativeAssetReferenceFiles, type NativeAssetSnapshot } from '../../nativeProjectAssetRecovery';
import type { NativeGlobalRecoveryFile } from '../../nativeProjectArchiveService';
import { validateNativeMissingAssetProof, type NativeMissingAssetProof } from '../../nativeMissingAssetBackup';
import { validateNativeArchiveOutputRows } from '../../projectOutputHistoryArchive';
import { validateNativeArchiveChatMediaRows } from '../../projectArchiveChatMedia';
import {
  ROOTS,
  CONTENTS,
  CANVASES,
  EPISODES,
  EPISODE_CONTENTS,
  RETIRED,
  REVISIONS,
  EXCHANGE,
  TRANSFER,
  TRANSFER_BY_PROJECT_PHASE,
  TRANSFER_BY_MODE_PHASE,
  canvasPreviewKey,
  STORES,
  rootRefPattern,
  recycleRequestIdPattern,
  isNativeProjectId,
  isNativeCanvasId,
  type NativeProjectOptions,
  obsoleteCanvasPreviewKeys,
  fail,
  request,
  isProjectReplacement,
  assertNoPendingNativeSharedSync,
  assertNoPendingNativeMediaTasks,
  openNativeProjectDatabase,
  transact,
  assertNativeRoot,
  validateAggregate,
  readInTransaction,
  increment,
  timestamp,
} from './projectRepository';

type NativeProjectRecyclePhase = 'pending' | 'recycling' | 'recycled' | 'retained';

interface NativeProjectRetirement {
  id: string;
  projectId: string;
  kind: 'project';
  deletedAt: number;
  recycle?: { requestId: string; phase: NativeProjectRecyclePhase; projectEpoch: number; storageRootRef: string };
}

/** 删除独立库聚合，保留身份墓碑和审计；桌面显式回收请求与逻辑删除同事务提交。 */
export async function deleteNativeProject(input: { projectId: string; expectedProjectEpoch: number; expectedChangeRevision: number;
  recycleRequestId?: string; now?: number },
  options: NativeProjectOptions = {}): Promise<void> {
  const fixed = structuredClone(input), now = timestamp(fixed.now);
  const recycleRequestId = fixed.recycleRequestId;
  if (!isNativeProjectId(fixed.projectId) || !Number.isSafeInteger(fixed.expectedProjectEpoch) || fixed.expectedProjectEpoch < 0
    || !Number.isSafeInteger(fixed.expectedChangeRevision) || fixed.expectedChangeRevision < 0
    || recycleRequestId !== undefined && (typeof recycleRequestId !== 'string' || !recycleRequestIdPattern.test(recycleRequestId))) {
    return fail('invalid-identity');
  }
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    await transact(database, 'readwrite', options, async (tx) => {
      if (recycleRequestId !== undefined && tx.durability !== 'strict') return fail('strict-durability-unavailable');
      // 整项目删除不等待远端任务结算；删除权威项目/画布并留墓碑，迟到结果仍只能保留原回执。
      const current = await readInTransaction(tx, fixed.projectId);
      if (!current) return fail('project-not-found');
      const [revision, transfers] = await Promise.all([
        request(tx.objectStore(REVISIONS).get(fixed.projectId)) as Promise<{ projectId: string; changeRevision: number } | undefined>,
        request(tx.objectStore(TRANSFER).index('projectId').getAll(fixed.projectId)) as Promise<Array<{ kind?: string; phase?: string }>>,
      ]);
      if (!revision || revision.projectId !== fixed.projectId || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0) return fail('invalid-project-revision');
      if (current.project.epoch !== fixed.expectedProjectEpoch || revision.changeRevision !== fixed.expectedChangeRevision) return fail('project-version-conflict');
      if (transfers.some((entry) => !(entry.kind === 'project-model-export' && ['registered', 'aborted'].includes(entry.phase ?? ''))
        && !(entry.kind === 'project-model-import' && ['finalized', 'aborted'].includes(entry.phase ?? ''))
        && !(entry.kind === 'native-content-recovery' && entry.phase === 'ready')
        && !(entry.kind === 'native-shared-sync' && ['finalized', 'aborted'].includes(entry.phase ?? '')))) return fail('project-transfer-present');
      const retirement: NativeProjectRetirement = { id: fixed.projectId, projectId: fixed.projectId, kind: 'project', deletedAt: now };
      if (recycleRequestId !== undefined) retirement.recycle = { requestId: recycleRequestId, phase: 'pending',
        projectEpoch: current.project.epoch, storageRootRef: current.project.storageRootRef };
      await Promise.all([
        request(tx.objectStore(ROOTS).delete(fixed.projectId)), request(tx.objectStore(CONTENTS).delete(fixed.projectId)),
        request(tx.objectStore(REVISIONS).delete(fixed.projectId)),
        request(tx.objectStore(RETIRED).add(retirement)),
        ...current.episodes.flatMap((episode) => [request(tx.objectStore(EPISODES).delete(episode.id)),
          request(tx.objectStore(EPISODE_CONTENTS).delete(episode.id)),
          request(tx.objectStore(RETIRED).add({ id: episode.id, projectId: fixed.projectId, kind: 'episode', deletedAt: now }))]),
        ...current.canvases.flatMap((canvas) => [request(tx.objectStore(CANVASES).delete(canvas.id)),
          request(tx.objectStore(EXCHANGE).delete(canvasPreviewKey(canvas.id))),
          request(tx.objectStore(RETIRED).add({ id: canvas.id, projectId: fixed.projectId, kind: 'canvas', deletedAt: now }))]),
      ]);
    }, STORES, recycleRequestId !== undefined);
  } finally { database.close(); }
}

/** 同一墓碑上的明确请求只能认领一次；旧记录不会通过状态迁移补出回收请求。 */
export async function transitionNativeProjectRecycle(projectId: string, requestId: string, expected: 'pending' | 'recycling',
  next: 'recycling' | 'recycled' | 'retained', options: NativeProjectOptions = {}): Promise<boolean> {
  const legalTransition = expected === 'pending' && (next === 'recycling' || next === 'retained')
    || expected === 'recycling' && (next === 'recycled' || next === 'retained');
  if (!legalTransition || !isNativeProjectId(projectId) || typeof requestId !== 'string' || !recycleRequestIdPattern.test(requestId)) return false;
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return false;
  try {
    return await transact(database, 'readwrite', options, async (tx) => {
      if (tx.durability !== 'strict') return fail('strict-durability-unavailable');
      const retired = tx.objectStore(RETIRED);
      const [existing, tombstone] = await Promise.all([
        request(tx.objectStore(ROOTS).get(projectId)),
        request(retired.get(projectId)) as Promise<NativeProjectRetirement | undefined>,
      ]);
      const recycle = tombstone?.recycle;
      if (existing !== undefined || !tombstone || tombstone.id !== projectId || tombstone.projectId !== projectId || tombstone.kind !== 'project'
        || !Number.isSafeInteger(tombstone.deletedAt) || tombstone.deletedAt < 0 || !recycle || recycle.requestId !== requestId
        || recycle.phase !== expected || !Number.isSafeInteger(recycle.projectEpoch) || recycle.projectEpoch < 0
        || typeof recycle.storageRootRef !== 'string' || !rootRefPattern.test(recycle.storageRootRef)) return false;
      if (next === 'recycling') await assertNoPendingNativeMediaTasks(tx, projectId);
      await request(retired.put({ ...tombstone, recycle: { ...recycle, phase: next } } satisfies NativeProjectRetirement));
      return true;
    }, [ROOTS, RETIRED, EXCHANGE], true);
  } finally { database.close(); }
}

/** 导出日志保留原发布身份；响应丢失时只能查询同一原生回执。 */
export interface NativeProjectExportJournal extends ProjectModelTransferExportJournal {
  projectId: string;
  expectedChangeRevision: number;
}

const PENDING_EXPORT_PHASES = ['prepared', 'packing', 'published'] as const;
export const NATIVE_PENDING_IMPORT_PHASES = ['prepared', 'media_publishing', 'media_ready', 'db_committed'] as const;
export type NativeProjectPendingTransfer = { operationId: string; updatedAt: number } & (
  { kind: 'export'; phase: typeof PENDING_EXPORT_PHASES[number] }
  | { kind: 'update' | 'restore'; phase: typeof NATIVE_PENDING_IMPORT_PHASES[number] }
  | { kind: 'shared-sync'; phase: 'prepared' }
);

/** 逐条投影摘要，避免同时持有多个待续接操作的完整画布和归档。 */
function collectTransferSummaries<Row, Summary>(index: IDBIndex, key: IDBValidKey,
  summarize: (row: Row) => Summary | undefined): Promise<Summary[]> {
  return new Promise((resolve, reject) => {
    const rows: Summary[] = [];
    const reading = index.openCursor(key);
    reading.onerror = () => reject(reading.error ?? new Error('读取项目操作失败'));
    reading.onsuccess = () => {
      const cursor = reading.result;
      if (!cursor) { resolve(rows); return; }
      try {
        const summary = summarize(cursor.value as Row);
        if (summary !== undefined) rows.push(summary);
        cursor.continue();
      } catch (error) { reject(error); }
    };
  });
}

/** 新建导入还没有作品目录，只读全库中这一模式的待处理阶段。 */
export async function summarizeNativePendingNewImports<T>(tx: IDBTransaction,
  summarize: (row: NativeProjectImportJournal, phase: typeof NATIVE_PENDING_IMPORT_PHASES[number]) => T | undefined): Promise<T[]> {
  const index = tx.objectStore(TRANSFER).index(TRANSFER_BY_MODE_PHASE);
  const results: T[][] = [];
  for (const phase of NATIVE_PENDING_IMPORT_PHASES) {
    results.push(await collectTransferSummaries(index, ['project-model-import', 'import-new', phase],
      (row: NativeProjectImportJournal) => summarize(row, phase)));
  }
  return results.flat();
}

/** 恢复入口只读取指定作品的待完成操作元数据。 */
export async function listNativeProjectPendingTransfers(projectId: string, options: NativeProjectOptions = {}): Promise<NativeProjectPendingTransfer[]> {
  if (!isNativeProjectId(projectId)) return fail('invalid-identity');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return [];
  try {
    return await transact(database, 'readonly', options, async (tx) => {
      const index = tx.objectStore(TRANSFER).index(TRANSFER_BY_PROJECT_PHASE);
      type Candidate = { operationId: string; updatedAt: number; targetProjectId: string; mode?: string };
      const isOwned = (row: Candidate) => row.targetProjectId === projectId && typeof row.operationId === 'string'
        && Number.isSafeInteger(row.updatedAt) && row.updatedAt >= 0;
      const rows: NativeProjectPendingTransfer[][] = [];
      for (const phase of PENDING_EXPORT_PHASES) {
        rows.push(await collectTransferSummaries<Candidate, NativeProjectPendingTransfer>(index, [projectId, 'project-model-export', phase], (row) => isOwned(row)
          ? { operationId: row.operationId, updatedAt: row.updatedAt, kind: 'export', phase } : undefined));
      }
      for (const phase of NATIVE_PENDING_IMPORT_PHASES) {
        rows.push(await collectTransferSummaries<Candidate, NativeProjectPendingTransfer>(index, [projectId, 'project-model-import', phase], (row) => isOwned(row) && isProjectReplacement(row)
          ? { operationId: row.operationId, updatedAt: row.updatedAt, kind: row.mode === 'update-existing' ? 'update' : 'restore', phase } : undefined));
      }
      rows.push(await collectTransferSummaries<
        { projectId: string; operationId: string; sourceOperationId: string; createdAt: number },
        NativeProjectPendingTransfer
      >(index, [projectId, 'native-shared-sync', 'prepared'], (row) =>
        row.projectId === projectId && typeof row.sourceOperationId === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(row.sourceOperationId) && row.operationId === `shared-${row.sourceOperationId}`
        && Number.isSafeInteger(row.createdAt) && row.createdAt >= 0
          ? { operationId: row.sourceOperationId, updatedAt: row.createdAt, kind: 'shared-sync', phase: 'prepared' }
          : undefined));
      return rows.flat().sort((left, right) => right.updatedAt - left.updatedAt
        || (left.operationId < right.operationId ? -1 : 1));
    }, [TRANSFER]);
  } finally { database.close(); }
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
        || stored && stored.projectId !== fixed.projectId || !configValuesEqual(readNativeProjectExchange(stored?.exchange ?? null), fixed.expectedExchange)) return fail('project-version-conflict');
      if (existing) return fail('operation-id-used');
      if (transfers.some((item) => !(item.kind === 'native-content-recovery' && item.phase === 'ready')
        && (item.phase === undefined || !['registered', 'aborted', 'finalized'].includes(item.phase)))) return fail('project-transfer-present');
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
          || !configValuesEqual(readNativeProjectExchange(stored?.exchange ?? null), journal.expectedExchange)) return fail('project-version-conflict');
        const exchange = { ...journal.exchange, published: [...journal.exchange.published,
          { operationId, outputRef: receipt.outputRef, packageDigest: receipt.packageDigest, head: journal.head }] };
        await request(tx.objectStore(EXCHANGE).put({ projectId: journal.projectId, exchange }));
      }
      const next: NativeProjectExportJournal = { ...journal, phase, sequence: increment(journal.sequence), updatedAt: Date.now(),
        ...(receipt ? { outputRef: receipt.outputRef, packageDigest: receipt.packageDigest } : {}) };
      await request(tx.objectStore(TRANSFER).put(next));
      return next;
    }, [ROOTS, REVISIONS, EXCHANGE, TRANSFER]);
  } finally { database.close(); }
}

/** 结束本机登记，保留原发布回执及所有已写文件。 */
export async function abandonNativeProjectExport(projectId: string, operationId: string, expectedSequence: number,
  options: NativeProjectOptions = {}): Promise<void> {
  if (!isNativeProjectId(projectId) || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(operationId)
    || !Number.isSafeInteger(expectedSequence) || expectedSequence < 0) return fail('invalid-export');
  const database = await openNativeProjectDatabase(false, options);
  if (!database) return fail('project-not-found');
  try {
    await transact(database, 'readwrite', options, async (tx) => {
      if (tx.durability !== 'strict') return fail('strict-durability-unavailable');
      const store = tx.objectStore(TRANSFER), row = await request(store.get(operationId)) as NativeProjectExportJournal | undefined;
      if (!row || row.kind !== 'project-model-export' || row.projectId !== projectId || row.targetProjectId !== projectId || row.operationId !== operationId
        || row.sequence !== expectedSequence || !['prepared', 'packing', 'published'].includes(row.phase)) return fail('export-journal-conflict');
      await request(store.put({ ...row, phase: 'aborted', sequence: increment(row.sequence), updatedAt: Date.now() } satisfies NativeProjectExportJournal));
    }, [TRANSFER], true);
  } finally { database.close(); }
}

export interface NativeProjectImportJournal extends ProjectModelTransferImportJournal {
  projectId: string;
  assetRecords?: NativeAssetRecord[];
  /** 和项目聚合一同提交，旧 journal 缺省为空。 */
  editorRecords?: import('../../../types/videoEditor').VideoEditorProjectRecord[];
  retiredEditorRecords?: import('../../../types/videoEditor').VideoEditorProjectRecord[];
}

async function validateImportEditors(journal: Pick<NativeProjectImportJournal, 'editorRecords' | 'retiredEditorRecords' | 'next' | 'exchange' | 'media' | 'idMap'>): Promise<void> {
  const records = journal.editorRecords ?? [], retiredRecords = journal.retiredEditorRecords ?? [];
  if (!Array.isArray(records) || !Array.isArray(retiredRecords) || records.length + retiredRecords.length > 10000 || !journal.exchange) return fail('invalid-import-editor');
  if (!records.length && !retiredRecords.length) return;
  const { validateNativeVideoEditorRecord } = await import('../nativeVideoEditorRepository');
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
  editorRecords?: import('../../../types/videoEditor').VideoEditorProjectRecord[];
  retiredEditorRecords?: import('../../../types/videoEditor').VideoEditorProjectRecord[];
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
        || !configValuesEqual(readNativeProjectExchange(exchange?.exchange ?? null), fixed.expected.exchange)) return fail('project-version-conflict');
      if (operations.some((item) => !(item.kind === 'native-content-recovery' && item.phase === 'ready')
        && !(item.kind === 'project-model-export' && ['registered', 'aborted'].includes(item.phase ?? ''))
        && !(item.kind === 'project-model-import' && ['finalized', 'aborted'].includes(item.phase ?? ''))
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
        ...obsoleteCanvasPreviewKeys(current.canvases, checked.canvases).map((key) => request(tx.objectStore(EXCHANGE).delete(key))),
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
  editorRecords: import('../../../types/videoEditor').VideoEditorProjectRecord[];
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
    || !Array.isArray(input.history) || input.history.length > 100_000
    || input.history.some((row) => row.kind !== 'output') || input.mode === 'restore-content' && input.history.length
    || input.sourceRef !== `imports/native-update-${input.operationId}`
    || input.mode === 'restore-content' && (!/^recovery-[A-Za-z0-9-]{1,111}$/.test(input.restoreRecoveryId ?? '') || !Array.isArray(input.restoreAssets) || input.restoreAssets.length > 200_000)
    || input.mode !== 'restore-content' && (input.restoreRecoveryId !== undefined || input.restoreAssets !== undefined || input.rawRecovery !== undefined)
    || input.rawRecovery !== undefined && (input.rawRecovery.recoveryId !== input.restoreRecoveryId || !Array.isArray(input.rawRecovery.episodeIds)
      || !Array.isArray(input.rawRecovery.canvasIds) || !Array.isArray(input.rawRecovery.files) || !Array.isArray(input.rawRecovery.rebindings))) return fail('invalid-update-journal');
  const historyCanvasIds = [...new Set([...input.next.canvases.map((canvas) => canvas.id), ...input.expected.aggregate.canvases.map((canvas) => canvas.id),
    ...input.expected.aggregate.bindings.filter((binding) => binding.namespace === 'legacy-canvas' && binding.retired && binding.projectId === projectId)
      .map((binding) => binding.canvasId ?? binding.legacyId)])];
  validateNativeArchiveOutputRows(input.history, { projectId, canvasIds: historyCanvasIds,
    rootRefs: input.next.project.storageBindings.map((item) => item.rootRef), identities: input.idMap, bindings: input.exchange.fileBindings });
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
        || !configValuesEqual(current.canvases, fixed.expected.aggregate.canvases) || !configValuesEqual(readNativeProjectExchange(exchange?.exchange ?? null), fixed.expected.exchange)) return fail('project-version-conflict');
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
  if (phase === 'finalized') {
    const original = await readNativeProjectUpdate(operationId, options);
    if (!original || original.sequence !== sequence || original.phase !== 'db_committed') return fail('update-journal-conflict');
    const { assertNativeArchiveHistoryCommitted } = await import('../../nativeArchiveHistoryCommit');
    await assertNativeArchiveHistoryCommitted(original);
  }
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
  const { verifyNativeProjectUpdateCommit } = await import('../../nativeProjectUpdateVerification');
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
      || !configValuesEqual(current.canvases, row.expected.aggregate.canvases) || !configValuesEqual(readNativeProjectExchange(savedExchange?.exchange ?? null), row.expected.exchange)) return fail('project-version-conflict');
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
      ...obsoleteCanvasPreviewKeys(current.canvases, checked.canvases).map((key) => request(tx.objectStore(EXCHANGE).delete(key))),
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
  if (fixed.history.some((row) => row.kind === 'message' && row.value.archiveMedia !== undefined)) {
    const head = fixed.exchange.bundle.revisions.find((revision) => revision.canonicalVersion === 2
      && revision.revisionId === fixed.exchange!.bundle.head.revisionId);
    if (!head || head.canonicalVersion !== 2) return fail('invalid-import');
    const { readProjectArchiveV4Files } = await import('../../projectArchiveV4');
    validateNativeArchiveChatMediaRows(fixed.history, readProjectArchiveV4Files(head.snapshot), head.snapshot.media, fixed.exchange, fixed.media);
  }
  validateNativeArchiveOutputRows(fixed.history, { projectId,
    canvasIds: fixed.idMap.filter((item) => item.kind === 'canvas').map((item) => item.localId),
    rootRefs: fixed.next.project.storageBindings.map((item) => item.rootRef), identities: fixed.idMap, bindings: fixed.exchange.fileBindings });
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
