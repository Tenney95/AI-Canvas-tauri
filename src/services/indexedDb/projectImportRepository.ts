/** 整部剧导入提交：CAS、恢复点、写入代际、协作基线和可选历史同一事务。 */
import type { ProjectSaveData } from '../storageService';
import type { ProjectExchangeRevision, ProjectExchangeRevisionHeader, ProjectExchangeState } from '../../types/projectExchange';
import { verifyProjectExchangeRevision, verifyProjectExchangeHeader, PROJECT_EXCHANGE_LIMITS } from '../projectExchangeFormat';
import { configValuesEqual } from '../configPatch';
import { parseProjectExchangeState } from './projectExchangeRepository';
import { safeExchangePath, type ArchiveAssetDigest } from '../projectExchangeDomain';
import { toProjectSummaryRecord } from './projectSummary';
import { openDB, STORE_PROJECTS, STORE_PROJECT_SUMMARIES, STORE_METADATA, STORE_PROJECT_EXCHANGE_STATES,
  STORE_PROJECT_EXCHANGE_SNAPSHOTS, STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES, STORE_PROJECT_MEMORIES } from './schema';
import { withLegacyProjectWrite } from './legacyProjectWriteGuard';
import { sha256BytesHex } from '../mediaDataUrl';
import { projectTransferWriteTransaction } from './projectTransferTransaction';

export interface ProjectImportHistoryRow { store: 'chatConversations' | 'chatMessages' | 'projectMemories'; value: { id: string; projectId: string; [key: string]: unknown } }
export interface ProjectImportRecovery {
  id: string; ownerId: string; createdAt: number; operationId: string; records: ProjectSaveData[];
  state: ProjectExchangeState | null; afterEpoch: number; label: string;
  identities?: ProjectExchangeState['identities'];
  assets?: ArchiveAssetDigest[];
}
export interface ProjectImportCommit {
  operationId: string; expectedRecords: ProjectSaveData[]; records: ProjectSaveData[];
  expectedState: ProjectExchangeState | null; state: ProjectExchangeState | null;
  revisions: ProjectExchangeRevision[]; ancestors: ProjectExchangeRevisionHeader[];
  history: ProjectImportHistoryRow[]; label: string;
  recoveryRecords?: ProjectSaveData[];
  recoveryIdentities?: ProjectExchangeState['identities'];
  recoveryAssets?: ArchiveAssetDigest[];
  assertCurrent?: () => void;
  signal?: AbortSignal;
}
export async function readProjectImportScope(ownerId: string): Promise<ProjectSaveData[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readonly'), records: ProjectSaveData[] = [];
    const request = tx.objectStore(STORE_PROJECTS).openCursor();
    request.onsuccess = () => { const cursor = request.result; if (!cursor) return;
      if (cursor.value.id === ownerId || cursor.value.parentId === ownerId) records.push(cursor.value); cursor.continue(); };
    tx.oncomplete = () => {
      const owner = records.find((item) => item.id === ownerId);
      if (!owner || owner.parentId) { reject(new Error('目标项目不存在或不是整部剧')); return; }
      resolve([owner, ...records.filter((item) => item !== owner).sort((a, b) => a.id.localeCompare(b.id))]);
    };
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('读取目标项目失败'));
  });
}
export async function commitProjectImport(input: ProjectImportCommit): Promise<void> {
  const { assertCurrent, signal, ...captured } = input;
  input = { ...structuredClone(captured), assertCurrent, signal };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(input.operationId)) throw new Error('导入操作身份无效');
  const commitDigest = await sha256BytesHex(new TextEncoder().encode(JSON.stringify(captured)));
  const { expectedRecords: sourceRecords, ...portableCommit } = captured;
  const sourceRecordDigests = await digestProjectImportSourceRecords(sourceRecords);
  const preparedCommitDigest = await preparedDigest({ commit: portableCommit, sourceRecordDigests });
  const ownerId = input.records[0]?.id;
  if (!ownerId || input.records[0].parentId || input.records.some((record, index) => index > 0 && record.parentId !== ownerId)
    || new Set(input.records.map((record) => record.id)).size !== input.records.length) throw new Error('合并结果的项目归属无效');
  const verified = await Promise.all(input.revisions.map(verifyProjectExchangeRevision));
  const headers = await Promise.all(input.ancestors.map(verifyProjectExchangeHeader));
  const state = input.state ? parseProjectExchangeState(input.state) : null;
  const expectedState = input.expectedState ? parseProjectExchangeState(input.expectedState) : null;
  if (verified.length + headers.length > PROJECT_EXCHANGE_LIMITS.revisions) throw new Error('协作版本材料超过上限');
  let materialBytes = 0;
  for (const item of [...verified, ...headers]) {
    materialBytes += new TextEncoder().encode(JSON.stringify(item)).byteLength;
    if (materialBytes > PROJECT_EXCHANGE_LIMITS.bundleBytes) throw new Error('合并版本材料超过 512 MiB 上限');
  }
  const head = verified.find((item) => item.revisionId === state?.headRevisionId);
  if (state && (!head || state.ownerId !== ownerId || state.stateVersion !== (expectedState?.stateVersion ?? 0) + 1
    || head.snapshot.rootProjectId !== state.rootProjectId || [...verified, ...headers].some((item) => item.lineageId !== state.lineageId)
    || expectedState && (expectedState.lineageId !== state.lineageId || expectedState.rootProjectId !== state.rootProjectId))) throw new Error('合并版本状态无效');
  if (expectedState && !state) throw new Error('不能在项目更新中丢弃已有协作来源');
  if (expectedState && head) {
    const graph = new Map([...verified, ...headers].map((item) => [item.revisionId, item])), visited = new Set<string>();
    const reaches = (id: string): boolean => { if (id === expectedState.headRevisionId) return true; if (visited.has(id)) return false;
      visited.add(id); return graph.get(id)?.parentRevisionIds.some(reaches) ?? false; };
    if (!reaches(head.revisionId)) throw new Error('新版本没有保留本机已处理的协作历史');
  }
  const expected = new Map(input.expectedRecords.map((record) => [record.id, record]));
  const epoch = Math.max(0, ...input.expectedRecords.map((record) => record.exchangeEpoch ?? 0)) + 1;
  if (!Number.isSafeInteger(epoch)) throw new Error('项目写入代际已超出范围');
  const db = await openDB();
  input.assertCurrent?.();
  await new Promise<void>((resolve, reject) => {
    const stores = [STORE_PROJECTS, STORE_PROJECT_SUMMARIES, STORE_METADATA, STORE_PROJECT_EXCHANGE_STATES,
      STORE_PROJECT_EXCHANGE_SNAPSHOTS, STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES, STORE_PROJECT_MEMORIES];
    const tx = projectTransferWriteTransaction(db, stores);
    let failure: unknown;
    const abort = () => { failure = new DOMException('项目导入已取消', 'AbortError'); try { tx.abort(); } catch { /* 提交已完成。 */ } };
    input.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => input.signal?.removeEventListener('abort', abort);
    const guard = (run: () => void) => { try { run(); } catch (error) { failure = error; tx.abort(); } };
    const projects = tx.objectStore(STORE_PROJECTS), summaries = tx.objectStore(STORE_PROJECT_SUMMARIES), metadata = tx.objectStore(STORE_METADATA);
    withLegacyProjectWrite(tx, () => {
      const operationRequest = metadata.get(`project-import-operation:${input.operationId}`);
      operationRequest.onsuccess = () => guard(() => {
      const operation = operationRequest.result as LegacyProjectImportOperation | undefined;
      const acceptedDigest = operation?.prepared ? preparedCommitDigest : commitDigest;
      if (operation?.phase === 'committed' || operation?.phase === 'db_committed' || operation?.phase === 'projected' || operation?.phase === 'finalized') {
        if (operation.commitDigest !== acceptedDigest) throw new Error('该导入操作已提交其他内容，不能再次执行');
        return;
      }
      if (operation && (operation.ownerId !== ownerId || !['media_ready', 'publishing'].includes(operation.phase))) throw new Error('导入媒体尚未就绪');
      if (operation?.prepared && operation.prepared.commitDigest !== preparedCommitDigest) throw new Error('提交材料与原导入操作冻结内容不一致');
      // 已外发但未登记的分支必须先收敛，不能让并发导入推进 expectedState 后把它永久悬空。
      const exports = metadata.openCursor(IDBKeyRange.bound('project-export-operation:', 'project-export-operation:\uffff'));
      exports.onsuccess = () => guard(() => {
        const row = exports.result;
        if (row) {
          if (row.value.ownerId === ownerId && !['registered', 'aborted'].includes(row.value.phase)) throw new Error('作品有未完成导出，请先核对原发布回执');
          row.continue(); return;
        }
        commit();
      });
      const commit = () => {
      const found = new Set<string>(), cursor = projects.openCursor();
      cursor.onsuccess = () => guard(() => {
        const row = cursor.result;
        if (row) {
          const record = row.value as ProjectSaveData;
          if (record.id === ownerId || record.parentId === ownerId) {
            if (!configValuesEqual(record, expected.get(record.id))) throw new Error('项目在预览后发生变化，请重新对比');
            found.add(record.id);
          } else if (input.records.some((item) => item.id === record.id)) throw new Error('新增分集身份已被使用');
          row.continue(); return;
        }
        if (found.size !== expected.size) throw new Error('项目或分集已被删除，请重新对比');
        const stateRequest = tx.objectStore(STORE_PROJECT_EXCHANGE_STATES).get(ownerId);
        stateRequest.onsuccess = () => guard(() => {
          input.assertCurrent?.();
          const currentState = stateRequest.result ? parseProjectExchangeState(stateRequest.result) : null;
          if (!configValuesEqual(currentState, expectedState)) throw new Error('协作基线已变化，请重新对比');
          if (input.expectedRecords.length) {
            const recovery: ProjectImportRecovery = { id: `project-import-recovery:${input.operationId}`, ownerId, operationId: input.operationId,
              createdAt: Date.now(), records: input.recoveryRecords ?? input.expectedRecords, identities: input.recoveryIdentities, assets: input.recoveryAssets,
              state: expectedState, afterEpoch: epoch, label: input.label };
            metadata.put(recovery);
          }
          const retained = new Set(input.records.map((record) => record.id));
          for (const record of input.expectedRecords) if (!retained.has(record.id)) {
            projects.delete(record.id); summaries.delete(record.id);
            metadata.put({ id: `project-deleted:${record.id}`, deletedAt: Date.now() });
          }
          for (const record of input.records) {
            const next = { ...record, exchangeEpoch: epoch }, summary = toProjectSummaryRecord(next);
            if (!summary) throw new Error('合并结果缺少项目摘要');
            projects.put(next); summaries.put(summary); metadata.delete(`project-deleted:${record.id}`);
          }
          const states = tx.objectStore(STORE_PROJECT_EXCHANGE_STATES);
          if (state) states.put(state); else states.delete(ownerId);
          for (const revision of [...verified, ...headers]) {
            const snapshots = tx.objectStore(STORE_PROJECT_EXCHANGE_SNAPSHOTS), request = snapshots.get(revision.revisionId);
            request.onsuccess = () => guard(() => {
              if (request.result) {
                const previous = request.result;
                const { snapshot: _before, ...before } = previous;
                const { snapshot: _after, ...after } = revision as ProjectExchangeRevision;
                if (!configValuesEqual(before, after) || previous.snapshot && 'snapshot' in revision && !configValuesEqual(previous.snapshot, revision.snapshot)) throw new Error('不可变协作版本发生冲突');
                if (previous.snapshot || !('snapshot' in revision)) return;
              }
              snapshots.put(revision);
            });
          }
          // 稳定来源 ID 只追加一次；已存在的历史不覆盖本机编辑。
          for (const row of input.history) {
            if (!retained.has(row.value.projectId)) throw new Error('历史归属不在合并范围内');
            const store = tx.objectStore(row.store), request = store.get(row.value.id);
            request.onsuccess = () => {
              if (request.result) return;
              store.add(row.value);
              if (row.store === STORE_CHAT_MESSAGES && typeof row.value.conversationId === 'string') {
                const conversations = tx.objectStore(STORE_CHAT_CONVERSATIONS), conversation = conversations.get(row.value.conversationId);
                conversation.onsuccess = () => {
                  if (!conversation.result) return;
                  const count = tx.objectStore(STORE_CHAT_MESSAGES).index('conversationId_sequence').count(IDBKeyRange.bound([row.value.conversationId, 0], [row.value.conversationId, Infinity]));
                  count.onsuccess = () => conversations.put({ ...conversation.result, messageCount: count.result });
                };
              }
            };
          }
          metadata.put({ ...operation, id: `project-import-operation:${input.operationId}`, operationId: input.operationId,
            ownerId, phase: 'db_committed', sequence: (operation?.sequence ?? 0) + 1, createdAt: operation?.createdAt ?? Date.now(),
            updatedAt: Date.now(), commitDigest: acceptedDigest, incomingRevision: input.state?.headRevisionId ?? null });
        });
      });
      };
      });
    }, (error) => { failure = error; });
    tx.oncomplete = () => { cleanup(); resolve(); }; tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => { cleanup(); reject(failure ?? tx.error ?? new Error('项目更新未提交')); };
    if (input.signal?.aborted) abort();
  });
}
export async function listProjectImportRecoveries(ownerId: string): Promise<ProjectImportRecovery[]> {
  const db = await openDB(); return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readonly'), rows: ProjectImportRecovery[] = [];
    const request = tx.objectStore(STORE_METADATA).openCursor();
    request.onsuccess = () => { const cursor = request.result; if (!cursor) return;
      if (String(cursor.key).startsWith('project-import-recovery:') && cursor.value.ownerId === ownerId) rows.push(cursor.value); cursor.continue(); };
    tx.oncomplete = () => resolve(rows.sort((a, b) => b.createdAt - a.createdAt)); tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

/** 发布前只登记相对目录及操作身份；重启后数据库事务决定项目是否已经提交。 */
export interface LegacyProjectImportOperation {
  id: string; operationId: string; ownerId: string; stagingProjectId?: string; stagingFolder?: string;
  phase: 'prepared' | 'media_publishing' | 'media_ready' | 'db_committed' | 'projected' | 'finalized' | 'publishing' | 'committed';
  sequence: number; createdAt: number; updatedAt?: number; commitDigest?: string;
  prepared?: LegacyProjectImportPrepared;
}

export interface LegacyProjectImportPrepared {
  version: 1;
  commit: Omit<ProjectImportCommit, 'assertCurrent' | 'signal' | 'expectedRecords'>;
  /** 旧expected可含合法本机绝对引用；journal只保存精确CAS证明，不再复制原路径。 */
  sourceRecordDigests: Array<{ id: string; sha256: string }>;
  commitDigest: string;
  media: {
    mode: 'publish' | 'already-ready';
    targetFolder: string;
    /** 源路径相对 journal.stagingFolder；目的路径相对 imports/原operation。 */
    assets: Array<ArchiveAssetDigest & { destinationPath: string }>;
    /** 最终项目目录内全部保留文件及恢复点文件，恢复时不能只验证新增文件。 */
    required: ArchiveAssetDigest[];
    verified: boolean;
  };
}

/** 匹配配置CAS语义：对象键序无关，缺省与undefined相同，数组undefined与null不同。 */
function preparedCanonical(input: unknown): string {
  const visiting = new WeakSet<object>();
  let values = 0;
  const encode = (value: unknown, depth = 0): unknown => {
    if (++values > PROJECT_EXCHANGE_LIMITS.values * 4 || depth > PROJECT_EXCHANGE_LIMITS.depth * 2) throw new Error('原导入CAS源超过容量');
    if (value === undefined) return ['undefined'];
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
    if (typeof value === 'number') return ['number', Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0' : String(value)];
    if (!value || typeof value !== 'object' || visiting.has(value)
      || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) throw new Error('原导入CAS源含运行时对象');
    visiting.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((entry) => !('value' in entry))) throw new Error('原导入CAS源含访问器');
    const result = Array.isArray(value) ? ['array', Array.from(value, (item) => encode(item, depth + 1))]
      : ['object', Object.keys(value).sort().filter((key) => descriptors[key].value !== undefined).map((key) => [key, encode(descriptors[key].value, depth + 1)])];
    visiting.delete(value); return result;
  };
  return JSON.stringify(encode(input));
}
const preparedDigest = (value: unknown) => sha256BytesHex(new TextEncoder().encode(preparedCanonical(value)));
export async function digestProjectImportSourceRecords(records: readonly ProjectSaveData[]): Promise<LegacyProjectImportPrepared['sourceRecordDigests']> {
  if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error('原导入CAS源身份重复');
  return Promise.all([...records].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(async (record) => ({ id: record.id, sha256: await preparedDigest(record) })));
}

function assertPreparedPortable(input: unknown, field = '', depth = 0, state = { values: 0, seen: new WeakSet<object>() }): void {
  if (++state.values > PROJECT_EXCHANGE_LIMITS.values || depth > PROJECT_EXCHANGE_LIMITS.depth) throw new Error('原导入冻结材料超过容量');
  if (typeof input === 'string') {
    if (/(?:paths?|directory|folder|dir)$/i.test(field) && /^(?:[a-z]:[\\/]|\\\\|\/|file:|asset:)/i.test(input)
      || /(?:urls?|source)$/i.test(field) && /^(?:file:|asset:|blob:|data:|https?:\/\/(?:asset\.localhost|tauri\.localhost))/i.test(input)) {
      throw new Error('原导入冻结材料仍含本机绝对路径或临时媒体，请先转换为项目相对引用');
    }
    return;
  }
  if (input === undefined || input === null || typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input)) return;
  if (typeof input !== 'object' || state.seen.has(input) || Object.getOwnPropertySymbols(input).length
    || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('原导入冻结材料含运行时对象');
  state.seen.add(input);
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    if (!('value' in descriptor)) throw new Error('原导入冻结材料含访问器');
    if (depth === 0 && ['assertCurrent', 'signal'].includes(name)) continue;
    if (Array.isArray(input) && name === 'length') continue;
    if (/^(?:apiKey|api_key|accessToken|refreshToken|authorization|password|secret|grantId)$/i.test(name)) throw new Error('原导入冻结材料含凭据或授权句柄');
    assertPreparedPortable(descriptor.value, Array.isArray(input) ? field : name, depth + 1, state);
  }
  state.seen.delete(input);
}

/** 只冻结第一次分配的业务、历史和媒体材料；不保存回调/AbortSignal，不重新分配身份。 */
export async function savePreparedProjectImportOperation(operationId: string,
  input: { commit: ProjectImportCommit; media: LegacyProjectImportPrepared['media'] }): Promise<void> {
  const { assertCurrent: _assertCurrent, signal: _signal, expectedRecords, ...body } = input.commit;
  assertPreparedPortable(body); assertPreparedPortable(input.media);
  const commit = structuredClone(body), media = structuredClone(input.media);
  const sourceRecordDigests = await digestProjectImportSourceRecords(expectedRecords);
  if (commit.operationId !== operationId || !commit.records[0]?.id || commit.records[0].parentId
    || !['publish', 'already-ready'].includes(media.mode) || typeof media.verified !== 'boolean'
    || Object.keys(media).some((field) => !['mode', 'targetFolder', 'assets', 'required', 'verified'].includes(field))
    || !Array.isArray(media.assets) || !Array.isArray(media.required)
    || media.assets.length + media.required.length > PROJECT_EXCHANGE_LIMITS.media * 2
    || commit.records.some((record) => (record.dataFolder ?? commit.records[0].id) !== media.targetFolder)) throw new Error('原导入冻结材料无效');
  safeExchangePath(media.targetFolder);
  const locations = new Set<string>();
  for (const asset of [...media.assets, ...media.required]) {
    safeExchangePath(asset.path);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('原导入媒体摘要无效');
  }
  for (const asset of media.assets) {
    safeExchangePath(asset.destinationPath);
    const key = asset.destinationPath.normalize('NFC').toLowerCase();
    if (locations.has(key)) throw new Error('原导入媒体目的路径重复'); locations.add(key);
  }
  const required = new Map(media.required.map((asset) => [asset.path, asset]));
  const matches = (path: string, asset: { bytes: number; sha256: string }) => {
    const value = required.get(path); return !!value && value.bytes === asset.bytes && value.sha256 === asset.sha256;
  };
  if (media.assets.some((asset) => !matches(`imports/${operationId}/${asset.destinationPath}`, asset))
    || commit.recoveryAssets?.some((asset) => !matches(asset.path, asset))) throw new Error('原导入最终媒体清单不完整');
  if (commit.state) {
    const head = commit.revisions.find((revision) => revision.revisionId === commit.state!.headRevisionId);
    if (!head) throw new Error('原导入冻结材料缺少完整head');
    const filePaths = new Map(commit.state.identities.filter((identity) => identity.kind === 'file').map((identity) => [identity.id, identity.localId]));
    const payloads = new Map(head.snapshot.media.map((asset) => [asset.id, asset]));
    if (head.snapshot.entities.filter((entity) => entity.kind === 'file').some((entity) => {
      const path = filePaths.get(entity.id), asset = payloads.get(String(entity.data.mediaId));
      return !path || !asset || !matches(path, asset);
    })) throw new Error('原导入冻结head的文件没有完整字节证明');
  }
  const commitDigest = await preparedDigest({ commit, sourceRecordDigests });
  const prepared: LegacyProjectImportPrepared = { version: 1, commit, sourceRecordDigests, commitDigest, media };
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = projectTransferWriteTransaction(db, STORE_METADATA); let failure: unknown;
    withLegacyProjectWrite(tx, () => {
      const store = tx.objectStore(STORE_METADATA), request = store.get(`project-import-operation:${operationId}`);
      request.onsuccess = () => {
        try {
          const operation = request.result as LegacyProjectImportOperation | undefined;
          if (!operation || operation.ownerId !== commit.records[0].id) throw new Error('原导入操作不存在或目标已变化');
          if (operation.prepared) {
            if (!configValuesEqual(operation.prepared, prepared)) throw new Error('原导入操作已冻结其他材料');
            return;
          }
          if (!['prepared', 'media_publishing', 'media_ready'].includes(operation.phase)) throw new Error('原导入操作已越过冻结阶段');
          store.put({ ...operation, prepared, sequence: operation.sequence + 1, updatedAt: Date.now() });
        } catch (error) { failure = error; tx.abort(); }
      };
    }, (error) => { failure = error; });
    tx.oncomplete = () => resolve(); tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('原导入材料未耐久保存'));
  });
}

export async function beginProjectImportOperation(operationId: string, ownerId: string, stagingProjectId: string, stagingFolder: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(operationId)) throw new Error('导入操作身份无效');
  safeExchangePath(stagingFolder);
  const db = await openDB(); await new Promise<void>((resolve, reject) => {
    const tx = projectTransferWriteTransaction(db, STORE_METADATA);
    let failure: Error | undefined;
    withLegacyProjectWrite(tx, () => {
      tx.objectStore(STORE_METADATA).add({ id: `project-import-operation:${operationId}`, operationId, ownerId,
        stagingProjectId, stagingFolder, phase: 'prepared', sequence: 1, createdAt: Date.now() });
    }, (error) => { failure = error; });
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(failure ?? tx.error);
  });
}

export async function readProjectImportOperation(operationId: string): Promise<LegacyProjectImportOperation | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readonly'), request = tx.objectStore(STORE_METADATA).get(`project-import-operation:${operationId}`);
    tx.oncomplete = () => resolve(request.result ?? null);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('导入操作记录不可读'));
  });
}

export async function advanceProjectImportOperation(operationId: string, phase: 'media_publishing' | 'media_ready' | 'projected' | 'finalized'): Promise<void> {
  const db = await openDB();
  const previous = { media_publishing: 'prepared', media_ready: 'media_publishing', projected: 'db_committed', finalized: 'projected' };
  return new Promise((resolve, reject) => {
    const tx = projectTransferWriteTransaction(db, STORE_METADATA); let failure: unknown;
    withLegacyProjectWrite(tx, () => {
      const store = tx.objectStore(STORE_METADATA), request = store.get(`project-import-operation:${operationId}`);
      request.onsuccess = () => {
        const operation = request.result as LegacyProjectImportOperation | undefined;
        if (!operation || operation.phase !== previous[phase]) { failure = new Error('导入操作阶段已变化'); tx.abort(); return; }
        store.put({ ...operation, phase, sequence: operation.sequence + 1, updatedAt: Date.now() });
      };
    }, (error) => { failure = error; });
    tx.oncomplete = () => resolve(); tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('导入操作阶段未保存'));
  });
}

/** 重启只根据原子提交标记决定下一步；媒体保留，不能把 projected 失败当作未提交重新合并。 */
export async function recoverCommittedProjectImport(operationId: string): Promise<{ status: 'committed'; records: ProjectSaveData[] } | { status: 'not-committed' }> {
  const operation = await readProjectImportOperation(operationId);
  if (!operation) throw new Error('原导入操作记录不存在');
  if (!['committed', 'db_committed', 'projected', 'finalized'].includes(operation.phase)) return { status: 'not-committed' };
  return { status: 'committed', records: await readProjectImportScope(operation.ownerId) };
}
