/** 共享同步的持久待办、基线与下载应用；本模块不调用原生 IPC 或读取文件。 */
import type {
  SharedAssetConflict, SharedAssetMapping, SharedAssetOutboxEntry, SharedAssetSyncLocalState,
} from '../../types/assetSync';
import type { AssetImageRecord } from '../../types/assetImage';
import type { AssetIndexRecord, AssetMetaRecord, ProjectRecord } from '../indexedDbService';
import { imageHistoryReferenceKey, withActiveAsset } from '../indexedDbService';
import { configValuesEqual } from '../configPatch';
import { withRelocatedMedia } from './mediaRelocations';
import { toProjectSummaryRecord } from './projectSummary';
import { nativeSharedAssetReceiptKey } from './nativeSharedAssetSyncRepository';
import {
  openDB, STORE_ASSET_INDEX, STORE_ASSET_META_V2, STORE_METADATA, STORE_PROJECTS,
  STORE_PROJECT_SUMMARIES, STORE_SHARED_ASSET_MAPPINGS, STORE_SHARED_ASSET_OUTBOX, STORE_SHARED_ASSET_CONFLICTS,
} from './schema';

export interface SharedAssetSyncCommitInput {
  ownerId: string;
  operationId: string;
  mappings: readonly SharedAssetMapping[];
  operation: SharedAssetOutboxEntry;
  /** 新内容使用新身份，已有旧索引不移动、不删除。 */
  indexes?: readonly AssetIndexRecord[];
  expectedIndexes?: readonly AssetIndexRecord[];
  tags?: readonly { assetId: string; expected: AssetMetaRecord | null; next: AssetMetaRecord | null }[];
  /** 换内容后创建新图片记录时，旧文件的完整专属信息仍须在同事务中保持原基线。 */
  expectedImages?: readonly AssetImageRecord[];
  /** 同时保护原先没有记录的情况，以及同一文件多个历史内容记录的完整集合。 */
  expectedImageRecords?: readonly { assetId: string; records: readonly AssetImageRecord[] }[];
  images?: readonly { expected: AssetImageRecord | null; next: AssetImageRecord }[];
  /** 仅由项目保存屏障补入；普通文件应用可省略。 */
  project?: ProjectRecord;
  expectedProjectLibrary?: unknown;
  /** 新库已持久写锁与冻结材料；旧库事务只登记对应收据，不伪造旧项目记录。 */
  nativeAuthority?: { projectId: string; memberIds: readonly string[]; receiptDigest: string };
  signal?: AbortSignal;
  assertCurrent?: () => void;
  /** 在 transaction.oncomplete 同步应用 Store，不允许异步工作。 */
  onCommitted?: (result: SharedAssetSyncCommitResult) => void;
}
export interface SharedAssetSyncCommitResult { alreadyApplied: boolean }

const SYNC_STORES = [STORE_SHARED_ASSET_MAPPINGS, STORE_SHARED_ASSET_OUTBOX, STORE_SHARED_ASSET_CONFLICTS];
const IDENTITY_KEYS = ['ownerId', 'connectionId', 'connectionRevision', 'libraryId', 'sharedProjectId', 'generation'] as const;
const OPERATION_KEYS = [...IDENTITY_KEYS, 'id', 'operationId', 'sharedAssetId', 'kind', 'direction', 'revisionId', 'mappingId', 'baseRevisionId', 'baseETag'] as const;
const INDEX_KEYS = ['assetId', 'path', 'relativePath', 'rootPath', 'projectId', 'source', 'fingerprint', 'size', 'mtimeMs', 'contentDigest', 'status'] as const;
const finished = (entry: SharedAssetOutboxEntry) => entry.phase === 'applied' || entry.phase === 'completed';
const failConflict = () => new Error('共享资产或本地内容已变化，请重新预览');
const sameFields = (left: object, right: object, keys: readonly string[]) => keys.every((key) => key === 'generation'
  ? (Reflect.get(left, key) ?? 'legacy') === (Reflect.get(right, key) ?? 'legacy')
  : configValuesEqual(Reflect.get(left, key), Reflect.get(right, key)));
const assertId = (id: string) => { if (typeof id !== 'string' || !id.trim() || id.length > 2048) throw failConflict(); };
function assertRuntime(input: Pick<SharedAssetSyncCommitInput, 'signal' | 'assertCurrent'>): void {
  input.signal?.throwIfAborted();
  input.assertCurrent?.();
}

/** 请求错误先等待 abort 终态，防止上层保存队列提前放行。 */
function transaction<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode,
  run: (tx: IDBTransaction, fail: (error: unknown) => void, finish: (value: T) => void) => void,
  options: Pick<SharedAssetSyncCommitInput, 'signal' | 'assertCurrent'> = {},
  committed?: (value: T) => void,
  requireStrict = false,
): Promise<T> {
  assertRuntime(options);
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = mode === 'readwrite' ? db.transaction(stores, mode, { durability: 'strict' }) : db.transaction(stores, mode); }
    catch (error) {
      if (requireStrict) throw error;
      if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'NotSupportedError')) throw error;
      tx = db.transaction(stores, mode);
    }
    if (requireStrict && tx.durability !== 'strict') {
      tx.abort();
      throw new Error('当前运行环境不能保证共享同步收据耐久，项目写锁已保留');
    }
    let failure: unknown;
    let result!: T;
    const fail = (error: unknown) => { failure ??= error; try { tx.abort(); } catch { /* 终态由既有事件处理。 */ } };
    const abort = () => fail(options.signal?.reason ?? new DOMException('共享同步已取消', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => { cleanup(); reject(failure ?? tx.error ?? failConflict()); };
    tx.oncomplete = () => {
      cleanup();
      try { committed?.(result); resolve(result); } catch (error) { reject(error); }
    };
    try { run(tx, fail, (value) => { result = value; }); } catch (error) { fail(error); }
    if (options.signal?.aborted) abort();
  });
}

export async function loadSharedAssetSyncState(ownerId: string): Promise<SharedAssetSyncLocalState> {
  assertId(ownerId);
  const db = await openDB();
  return transaction<SharedAssetSyncLocalState>(db, SYNC_STORES, 'readonly', (tx, fail, finish) => {
    const result: SharedAssetSyncLocalState = { mappings: [], outbox: [], conflicts: [] };
    let pending = 3;
    const collect = <K extends keyof SharedAssetSyncLocalState>(store: string, key: K) => {
      const request = tx.objectStore(store).index('ownerId').getAll(ownerId);
      request.onsuccess = () => {
        if (request.result.length > 50_000) { fail(new Error('共享同步记录过多，请先整理')); return; }
        result[key] = request.result;
        if (--pending === 0) finish(result);
      };
    };
    collect(STORE_SHARED_ASSET_MAPPINGS, 'mappings');
    collect(STORE_SHARED_ASSET_OUTBOX, 'outbox');
    collect(STORE_SHARED_ASSET_CONFLICTS, 'conflicts');
  });
}

export async function putSharedAssetSyncPlan(rawInput: {
  ownerId: string;
  mappings: readonly SharedAssetMapping[];
  outbox: readonly SharedAssetOutboxEntry[];
  conflicts?: readonly SharedAssetConflict[];
  expectedMappings?: readonly SharedAssetMapping[];
}): Promise<void> {
  const input = structuredClone(rawInput);
  for (const row of [...input.mappings, ...input.outbox, ...(input.conflicts ?? [])]) row.generation ??= 'legacy';
  assertId(input.ownerId);
  if ([...input.mappings, ...input.outbox, ...(input.conflicts ?? [])].some((row) => !row.id || row.ownerId !== input.ownerId)) throw failConflict();
  const db = await openDB();
  return transaction<void>(db, SYNC_STORES, 'readwrite', (tx, fail, finish) => {
    finish(undefined);
    for (const mapping of input.mappings) {
      const request = tx.objectStore(STORE_SHARED_ASSET_MAPPINGS).get(mapping.id);
      request.onsuccess = () => {
        const current = request.result as SharedAssetMapping | undefined;
        const expected = input.expectedMappings?.find((item) => item.id === mapping.id);
        if (current && !(expected ? configValuesEqual(current, expected) : configValuesEqual(current, mapping))) { fail(failConflict()); return; }
        tx.objectStore(STORE_SHARED_ASSET_MAPPINGS).put(mapping);
      };
    }
    for (const entry of input.outbox) {
      const request = tx.objectStore(STORE_SHARED_ASSET_OUTBOX).get(entry.id);
      request.onsuccess = () => {
        const current = request.result as SharedAssetOutboxEntry | undefined;
        if (current) {
          if (!sameFields(current, entry, OPERATION_KEYS) || !configValuesEqual(current.draft, entry.draft)) fail(failConflict());
          // 已落盘的阶段不能被再次展示预览的旧 planned 状态覆盖。
          return;
        }
        tx.objectStore(STORE_SHARED_ASSET_OUTBOX).add(entry);
      };
    }
    for (const conflict of input.conflicts ?? []) tx.objectStore(STORE_SHARED_ASSET_CONFLICTS).put(conflict);
  });
}

export async function patchSharedAssetSyncOperation(operationId: string,
  rawPatch: Partial<Pick<SharedAssetOutboxEntry, 'phase' | 'errorCode' | 'revision' | 'revisionDigest' | 'updatedAt'>>,
): Promise<SharedAssetOutboxEntry> {
  assertId(operationId);
  const patch = structuredClone(rawPatch);
  const db = await openDB();
  return transaction<SharedAssetOutboxEntry>(db, [STORE_SHARED_ASSET_OUTBOX], 'readwrite', (tx, fail, finish) => {
    const store = tx.objectStore(STORE_SHARED_ASSET_OUTBOX);
    const request = store.index('operationId').get(operationId);
    request.onsuccess = () => {
      const current = request.result as SharedAssetOutboxEntry | undefined;
      if (!current || (finished(current) && patch.phase !== undefined && patch.phase !== current.phase
        && !(current.phase === 'applied' && patch.phase === 'completed'))
        || (current.revision && patch.revision && !configValuesEqual(current.revision, patch.revision))
        || (current.revisionDigest && patch.revisionDigest && current.revisionDigest !== patch.revisionDigest)
        || patch.revision && (patch.revision.operationId !== current.operationId || patch.revision.revisionId !== current.revisionId
          || patch.revision.sharedAssetId !== current.sharedAssetId || patch.revision.libraryId !== current.libraryId
          || patch.revision.sharedProjectId !== current.sharedProjectId)) {
        fail(failConflict()); return;
      }
      const next: SharedAssetOutboxEntry = { ...current, ...patch, phase: patch.phase ?? current.phase,
        revision: patch.revision ?? current.revision, revisionDigest: patch.revisionDigest ?? current.revisionDigest,
        updatedAt: patch.updatedAt ?? Date.now() };
      store.put(next); finish(next);
    };
  });
}

/** 不做磁盘副作用；所有新文件必须已经校验并以独占新名称发布。 */
export async function applySharedAssetSyncCommit(rawInput: SharedAssetSyncCommitInput): Promise<SharedAssetSyncCommitResult> {
  const { signal, assertCurrent, onCommitted, ...records } = rawInput;
  const frozen: SharedAssetSyncCommitInput = { ...structuredClone(records), signal, assertCurrent, onCommitted };
  const { authorizeNativeSharedAssetSources } = await import('./nativeSharedAssetSources');
  const input = await authorizeNativeSharedAssetSources(frozen);
  assertId(input.ownerId); assertId(input.operationId);
  if (input.operation.ownerId !== input.ownerId || input.operation.operationId !== input.operationId
    || input.mappings.some((mapping) => mapping.ownerId !== input.ownerId)
    || input.project && input.project.id !== input.ownerId
    || input.nativeAuthority && (input.project !== undefined || input.nativeAuthority.projectId !== input.ownerId
      || !/^[a-f0-9]{64}$/.test(input.nativeAuthority.receiptDigest)
      || !input.nativeAuthority.memberIds.includes(input.ownerId)
      || new Set(input.nativeAuthority.memberIds).size !== input.nativeAuthority.memberIds.length)) throw failConflict();
  const db = await openDB();
  assertRuntime(input);
  return transaction<SharedAssetSyncCommitResult>(db, [...SYNC_STORES, STORE_PROJECTS, STORE_PROJECT_SUMMARIES, STORE_ASSET_INDEX,
    STORE_ASSET_META_V2, STORE_METADATA], 'readwrite', (tx, fail, finish) => {
    const guarded = (work: () => void) => {
      try { assertRuntime(input); work(); } catch (error) { fail(error); }
    };
    const operations = tx.objectStore(STORE_SHARED_ASSET_OUTBOX);
    const request = operations.index('operationId').get(input.operationId);
    request.onsuccess = () => guarded(() => {
      const current = request.result as SharedAssetOutboxEntry | undefined;
      if (!current || !sameFields(current, input.operation, OPERATION_KEYS)
        || current.revisionDigest && input.operation.revisionDigest !== current.revisionDigest) throw failConflict();
      if (finished(current)) {
        if (!input.nativeAuthority) { finish({ alreadyApplied: true }); return; }
        const receipt = tx.objectStore(STORE_METADATA).get(nativeSharedAssetReceiptKey(input.operationId));
        receipt.onsuccess = () => guarded(() => {
          if (!configValuesEqual(receipt.result, { id: nativeSharedAssetReceiptKey(input.operationId),
            projectId: input.ownerId, digest: input.nativeAuthority!.receiptDigest })) throw failConflict();
          finish({ alreadyApplied: true });
        });
        return;
      }
      if (input.mappings.length !== 1 || input.mappings.some((mapping) => mapping.id !== current.mappingId || mapping.sharedAssetId !== current.sharedAssetId
        || mapping.kind !== current.kind || !sameFields(mapping, current, IDENTITY_KEYS)
        || mapping.acceptedRevisionId !== current.revisionId || !mapping.acceptedETag || !mapping.baselineDigest)) throw failConflict();
      let pending = 1;
      const checked = () => {
        if (--pending !== 0) return;
        guarded(() => {
          for (const mapping of input.mappings) tx.objectStore(STORE_SHARED_ASSET_MAPPINGS).put(mapping);
          operations.put({ ...input.operation, phase: input.operation.direction === 'download' ? 'applied' : 'completed', updatedAt: Date.now() });
          if (input.nativeAuthority) tx.objectStore(STORE_METADATA).put({ id: nativeSharedAssetReceiptKey(input.operationId),
            projectId: input.ownerId, digest: input.nativeAuthority.receiptDigest });
          finish({ alreadyApplied: false });
        });
      };
      const check = <T>(store: string, key: IDBValidKey, verify: (value: T | undefined) => void) => {
        pending += 1;
        const read = tx.objectStore(store).get(key);
        read.onsuccess = () => guarded(() => { verify(read.result); checked(); });
      };
      const active = (assetId: string, work: () => void) => {
        pending += 1;
        withActiveAsset(tx, assetId, () => guarded(() => { work(); checked(); }), () => fail(new Error('素材已被清理，请重新预览')));
      };
      const relocated = <T>(value: T, work: (next: T) => void) => {
        pending += 1;
        withRelocatedMedia(tx, value, (next) => guarded(() => {
          if (!configValuesEqual(next, value)) throw failConflict();
          work(next); checked();
        }));
      };
      let imageRecordsReady = !input.expectedImageRecords?.length;
      const deferredImageWrites: Array<() => void> = [];
      if (!imageRecordsReady) {
        const baselines = input.expectedImageRecords!;
        const records = new Map(baselines.map((baseline) => [baseline.assetId, [] as AssetImageRecord[]]));
        for (const baseline of baselines) {
          assertId(baseline.assetId);
          if (baseline.records.some((record) => record.assetId !== baseline.assetId)) throw failConflict();
          active(baseline.assetId, () => undefined);
        }
        pending += 1;
        let count = 0;
        const cursorRequest = tx.objectStore(STORE_METADATA).openCursor(IDBKeyRange.bound('asset-image:', 'asset-image:\uffff'));
        cursorRequest.onsuccess = () => guarded(() => {
          const cursor = cursorRequest.result;
          if (cursor) {
            if (++count > 50_000) throw new Error('共享同步记录过多，请先整理');
            const record = cursor.value as AssetImageRecord;
            records.get(record.assetId)?.push(record);
            cursor.continue();
            return;
          }
          const ordered = (entries: readonly AssetImageRecord[]) => [...entries].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
          for (const baseline of baselines) {
            if (!configValuesEqual(ordered(records.get(baseline.assetId)!), ordered(baseline.records))) throw failConflict();
          }
          imageRecordsReady = true;
          // 游标读取结束后才写图片记录，避免本事务的新版本影响缺省／集合基线判断。
          deferredImageWrites.splice(0).forEach((write) => write());
          checked();
        });
      }
      for (const mapping of input.mappings) {
        check<SharedAssetMapping>(STORE_SHARED_ASSET_MAPPINGS, mapping.id, (before) => {
          if (before && (!sameFields(before, mapping, [...IDENTITY_KEYS, 'kind', 'localEntityId', 'sharedAssetId'])
            || before.acceptedRevisionId !== current.baseRevisionId || before.acceptedETag !== current.baseETag)) throw failConflict();
        });
      }
      if (input.nativeAuthority) {
        check(STORE_METADATA, nativeSharedAssetReceiptKey(input.operationId), (before) => { if (before !== undefined) throw failConflict(); });
        for (const id of input.nativeAuthority.memberIds) {
          check(STORE_PROJECTS, id, (before) => { if (before !== undefined) throw failConflict(); });
          check(STORE_METADATA, `project-deleted:${id}`, (before) => { if (before !== undefined) throw failConflict(); });
        }
      }
      for (const before of input.expectedIndexes ?? []) {
        active(before.assetId, () => check<AssetIndexRecord>(STORE_ASSET_INDEX, before.assetId, (live) => {
          if (!live || !sameFields(live, before, INDEX_KEYS)) throw failConflict();
        }));
      }
      for (const index of input.indexes ?? []) {
        if (index.source !== 'project' || !index.projectId || !index.relativePath || index.status !== 'online') throw failConflict();
        if (input.nativeAuthority) {
          if (!input.nativeAuthority.memberIds.includes(index.projectId)) throw failConflict();
        } else check<ProjectRecord>(STORE_PROJECTS, index.projectId, (project) => {
          if (!project || project.id !== input.ownerId && project.parentId !== input.ownerId) throw failConflict();
        });
        active(index.assetId, () => {
          const key = imageHistoryReferenceKey(index.path);
          if (!key) throw failConflict();
          check(STORE_METADATA, `forgotten-missing-path:${encodeURIComponent(key)}`, (forgotten) => { if (forgotten !== undefined) throw failConflict(); });
          check<AssetIndexRecord>(STORE_ASSET_INDEX, index.assetId, (before) => {
            if (before && !sameFields(before, index, INDEX_KEYS)) throw failConflict();
            relocated(index, (next) => tx.objectStore(STORE_ASSET_INDEX).put(next));
          });
        });
      }
      for (const tags of input.tags ?? []) {
        if (tags.next && (tags.next.assetId !== tags.assetId || tags.next.tags.length > 16
          || tags.next.tags.some((tag) => !tag.trim() || tag.length > 40))) throw failConflict();
        active(tags.assetId, () => check<AssetMetaRecord>(STORE_ASSET_META_V2, tags.assetId, (before) => {
          if (!configValuesEqual(before ?? null, tags.expected)) throw failConflict();
          if (tags.next) relocated(tags.next, (next) => tx.objectStore(STORE_ASSET_META_V2).put(next));
          else tx.objectStore(STORE_ASSET_META_V2).delete(tags.assetId);
        }));
      }
      for (const before of input.expectedImages ?? []) {
        active(before.assetId, () => check<AssetImageRecord>(STORE_METADATA, before.id, (live) => {
          if (!configValuesEqual(live, before)) throw failConflict();
        }));
      }
      for (const image of input.images ?? []) {
        const next = image.next;
        if (!next.id.startsWith('asset-image:') || !/^[a-f0-9]{64}$/.test(next.contentDigest)
          || next.prompt.length > 30_000 || next.references.length > 16 || next.revision !== (image.expected?.revision ?? 0) + 1
          || image.expected && (image.expected.id !== next.id || image.expected.contentDigest !== next.contentDigest)
          || next.references.some((reference) => !/^asset-image-references\/[a-f0-9-]{36}\.[a-z0-9]{1,8}$/.test(reference.relativePath)
            || !/^[a-f0-9]{64}$/.test(reference.digest) || !Number.isSafeInteger(reference.bytes) || reference.bytes <= 0)) throw failConflict();
        active(next.assetId, () => check<AssetImageRecord>(STORE_METADATA, next.id, (before) => {
          if (!configValuesEqual(before ?? null, image.expected)) throw failConflict();
          const write = () => relocated(next, (record) => tx.objectStore(STORE_METADATA).put(record));
          if (imageRecordsReady) write();
          else deferredImageWrites.push(write);
        }));
      }
      if (input.project) {
        const project = input.project;
        check<ProjectRecord>(STORE_PROJECTS, input.ownerId, (before) => {
          if (!before || (before.exchangeEpoch ?? 0) !== (project.exchangeEpoch ?? 0)
            || !configValuesEqual(before.dramaAssets, input.expectedProjectLibrary)) throw failConflict();
          relocated({ ...project, snapshot: before.snapshot }, (record) => {
            const summary = toProjectSummaryRecord(record);
            if (!summary) throw failConflict();
            tx.objectStore(STORE_PROJECTS).put(record);
            tx.objectStore(STORE_PROJECT_SUMMARIES).put(summary);
          });
        });
      } else if (!input.nativeAuthority) check<ProjectRecord>(STORE_PROJECTS, input.ownerId, (project) => { if (!project) throw failConflict(); });
      checked();
    });
  }, input, input.onCommitted, Boolean(input.nativeAuthority));
}
