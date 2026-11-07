/** 整部剧导入提交：CAS、恢复点、写入代际、协作基线和可选历史同一事务。 */
import type { ProjectSaveData } from '../storageService';
import type { ProjectExchangeRevision, ProjectExchangeRevisionHeader, ProjectExchangeState } from '../../types/projectExchange';
import { verifyProjectExchangeRevision, verifyProjectExchangeHeader, PROJECT_EXCHANGE_LIMITS } from '../projectExchangeFormat';
import { configValuesEqual } from '../configPatch';
import { parseProjectExchangeState } from './projectExchangeRepository';
import type { ArchiveAssetDigest } from '../projectExchangeDomain';
import { toProjectSummaryRecord } from './projectSummary';
import { openDB, STORE_PROJECTS, STORE_PROJECT_SUMMARIES, STORE_METADATA, STORE_PROJECT_EXCHANGE_STATES,
  STORE_PROJECT_EXCHANGE_SNAPSHOTS, STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES, STORE_PROJECT_MEMORIES } from './schema';
import { withLegacyProjectWrite } from './legacyProjectWriteGuard';

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
  const db = await openDB();
  input.assertCurrent?.();
  await new Promise<void>((resolve, reject) => {
    const stores = [STORE_PROJECTS, STORE_PROJECT_SUMMARIES, STORE_METADATA, STORE_PROJECT_EXCHANGE_STATES,
      STORE_PROJECT_EXCHANGE_SNAPSHOTS, STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES, STORE_PROJECT_MEMORIES];
    let tx: IDBTransaction;
    try { tx = db.transaction(stores, 'readwrite', { durability: 'strict' }); }
    catch (error) { if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'NotSupportedError')) throw error; tx = db.transaction(stores, 'readwrite'); }
    let failure: unknown;
    const abort = () => { failure = new DOMException('项目导入已取消', 'AbortError'); try { tx.abort(); } catch { /* 提交已完成。 */ } };
    input.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => input.signal?.removeEventListener('abort', abort);
    const guard = (run: () => void) => { try { run(); } catch (error) { failure = error; tx.abort(); } };
    const projects = tx.objectStore(STORE_PROJECTS), summaries = tx.objectStore(STORE_PROJECT_SUMMARIES), metadata = tx.objectStore(STORE_METADATA);
    withLegacyProjectWrite(tx, () => {
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
          metadata.put({ id: `project-import-operation:${input.operationId}`, ownerId, phase: 'committed', createdAt: Date.now(),
            incomingRevision: input.state?.headRevisionId ?? null });
        });
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
export async function beginProjectImportOperation(operationId: string, ownerId: string, stagingProjectId: string, stagingFolder: string): Promise<void> {
  const db = await openDB(); await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_METADATA, 'readwrite');
    let failure: Error | undefined;
    withLegacyProjectWrite(tx, () => {
      tx.objectStore(STORE_METADATA).add({ id: `project-import-operation:${operationId}`, operationId, ownerId,
        stagingProjectId, stagingFolder, phase: 'publishing', createdAt: Date.now() });
    }, (error) => { failure = error; });
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(failure ?? tx.error);
  });
}
