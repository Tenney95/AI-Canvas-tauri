/** 项目协作来源与不可变版本；不读文件、不写项目正文，也不启动归档或合并。 */
import type { ProjectExchangeRevision, ProjectExchangeRevisionHeader, ProjectExchangeState,
  ProjectExchangeStoredRevision } from '../../types/projectExchange';
import { parseProjectExchangeReference, PROJECT_EXCHANGE_LIMITS, projectExchangeEntityKey, projectExchangeId,
  projectExchangeRevisionHeader, serializeProjectExchangeValue, verifyProjectExchangeHeader,
  verifyProjectExchangeRevision } from '../projectExchangeFormat';
import { openDB, STORE_PROJECTS, STORE_PROJECT_EXCHANGE_STATES, STORE_PROJECT_EXCHANGE_SNAPSHOTS, STORE_METADATA } from './schema';
import { withLegacyProjectWrite } from './legacyProjectWriteGuard';
import { safeExchangePath } from '../projectExchangeDomain';

const changed = () => new Error('项目协作版本已变化，请重新读取后处理');
const invalid = () => new Error('项目协作映射无效，已停止保存');
const same = (left: unknown, right: unknown) => serializeProjectExchangeValue(left) === serializeProjectExchangeValue(right);

export function parseProjectExchangeState(input: ProjectExchangeState): ProjectExchangeState {
  const value = JSON.parse(serializeProjectExchangeValue(input)) as ProjectExchangeState;
  if (Object.keys(value).some((key) => !['ownerId', 'lineageId', 'rootProjectId', 'headRevisionId', 'stateVersion', 'identities'].includes(key))
    || !Number.isSafeInteger(value.stateVersion) || value.stateVersion < 1
    || !/^[a-f0-9]{64}$/.test(value.headRevisionId) || !Array.isArray(value.identities)
    || value.identities.length > PROJECT_EXCHANGE_LIMITS.entities) throw invalid();
  projectExchangeId(value.ownerId); projectExchangeId(value.lineageId); projectExchangeId(value.rootProjectId);
  const logical = new Set<string>(), local = new Set<string>(), projectIds = new Set<string>(), localProjectIds = new Set<string>();
  value.identities = value.identities.map((entry) => {
    if (!entry || Object.keys(entry).some((key) => !['kind', 'scopeId', 'id', 'localId'].includes(key))) throw invalid();
    const ref = parseProjectExchangeReference({ kind: entry.kind, scopeId: entry.scopeId, id: entry.id });
    const localId = ref.kind === 'file' ? safeExchangePath(entry.localId) : projectExchangeId(entry.localId), key = projectExchangeEntityKey(ref);
    const localKey = JSON.stringify([ref.kind, ref.scopeId, localId]);
    if (logical.has(key) || local.has(localKey)) throw invalid();
    logical.add(key); local.add(localKey);
    if (ref.kind === 'project') {
      if (ref.scopeId !== ref.id || localProjectIds.has(localId)) throw invalid();
      projectIds.add(ref.id); localProjectIds.add(localId);
    }
    return { ...ref, localId };
  });
  const root = value.identities.find((entry) => entry.kind === 'project' && entry.id === value.rootProjectId);
  if (!root || root.localId !== value.ownerId || value.identities.some((entry) => !projectIds.has(entry.scopeId))) throw invalid();
  value.identities.sort((a, b) => {
    const left = projectExchangeEntityKey(a), right = projectExchangeEntityKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return value;
}
const stateRecord = parseProjectExchangeState;

export async function loadProjectExchangeState(ownerId: string): Promise<ProjectExchangeState | null> {
  projectExchangeId(ownerId);
  const db = await openDB();
  const stored = await new Promise<ProjectExchangeState | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_EXCHANGE_STATES, 'readonly');
    const request = tx.objectStore(STORE_PROJECT_EXCHANGE_STATES).get(ownerId);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = tx.onerror = () => reject(tx.error ?? invalid());
  });
  return stored ? stateRecord(stored) : null;
}

export async function loadProjectExchangeGraph(lineageId: string): Promise<{
  revisions: ProjectExchangeRevision[]; ancestors: ProjectExchangeRevisionHeader[];
}> {
  projectExchangeId(lineageId);
  const db = await openDB();
  const stored = await new Promise<ProjectExchangeStoredRevision[]>((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECT_EXCHANGE_SNAPSHOTS, 'readonly');
    const rows: ProjectExchangeStoredRevision[] = [];
    let bytes = 0, failure: unknown;
    const request = tx.objectStore(STORE_PROJECT_EXCHANGE_SNAPSHOTS).index('lineageId').openCursor(lineageId);
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (!cursor) return;
        const row = cursor.value as ProjectExchangeStoredRevision;
        bytes += new TextEncoder().encode(JSON.stringify(row)).byteLength;
        if (rows.length >= PROJECT_EXCHANGE_LIMITS.revisions || bytes > PROJECT_EXCHANGE_LIMITS.bundleBytes) {
          throw new Error('项目协作基线超过当前读取上限，请先整理版本材料');
        }
        rows.push(row); cursor.continue();
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(rows);
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? invalid());
  });
  const revisions: ProjectExchangeRevision[] = [], ancestors: ProjectExchangeRevisionHeader[] = [];
  for (const row of stored) {
    if (row.snapshot) revisions.push(await verifyProjectExchangeRevision(row));
    else ancestors.push(await verifyProjectExchangeHeader(row));
    if (row.lineageId !== lineageId) throw invalid();
  }
  return { revisions, ancestors };
}

export interface ProjectExchangeCheckpointInput {
  expectedState: ProjectExchangeState | null;
  state: ProjectExchangeState;
  revisions: readonly ProjectExchangeRevision[];
  ancestors?: readonly ProjectExchangeRevisionHeader[];
}

/** 仅在调用方已确认相应交换结果后提交；准备态不能借此冒充已交接或已合并。 */
export async function saveProjectExchangeCheckpoint(input: ProjectExchangeCheckpointInput): Promise<void> {
  const state = stateRecord(input.state), expected = input.expectedState ? stateRecord(input.expectedState) : null;
  if (state.stateVersion !== (expected?.stateVersion ?? 0) + 1 || expected && (expected.ownerId !== state.ownerId
    || expected.lineageId !== state.lineageId || expected.rootProjectId !== state.rootProjectId)) throw changed();
  if (input.revisions.length + (input.ancestors?.length ?? 0) > PROJECT_EXCHANGE_LIMITS.revisions) throw invalid();
  const candidates = new Map<string, ProjectExchangeStoredRevision>();
  let candidateBytes = 0;
  const insert = (row: ProjectExchangeStoredRevision) => {
    candidateBytes += new TextEncoder().encode(JSON.stringify(row)).byteLength;
    if (row.lineageId !== state.lineageId || candidates.has(row.revisionId)
      || candidates.size >= PROJECT_EXCHANGE_LIMITS.revisions || candidateBytes > PROJECT_EXCHANGE_LIMITS.bundleBytes) throw invalid();
    candidates.set(row.revisionId, row);
  };
  for (const row of input.revisions) {
    const revision = await verifyProjectExchangeRevision(row);
    if (revision.snapshot.rootProjectId !== state.rootProjectId) throw invalid();
    insert(revision);
  }
  for (const row of input.ancestors ?? []) insert(await verifyProjectExchangeHeader(row));
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction;
    const stores = [STORE_PROJECTS, STORE_PROJECT_EXCHANGE_STATES, STORE_PROJECT_EXCHANGE_SNAPSHOTS, STORE_METADATA];
    try { tx = db.transaction(stores, 'readwrite', { durability: 'strict' }); }
    catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'NotSupportedError')) throw error;
      tx = db.transaction(stores, 'readwrite');
    }
    const states = tx.objectStore(STORE_PROJECT_EXCHANGE_STATES), snapshots = tx.objectStore(STORE_PROJECT_EXCHANGE_SNAPSHOTS);
    let failure: unknown;
    const guard = (run: () => void) => {
      try { run(); } catch (error) { failure ??= error; tx.abort(); }
    };
    withLegacyProjectWrite(tx, () => {
      const owner = tx.objectStore(STORE_PROJECTS).get(state.ownerId);
      owner.onsuccess = () => guard(() => {
        if (!owner.result || owner.result.parentId) throw invalid();
        const request = states.get(state.ownerId);
        request.onsuccess = () => guard(() => {
          const current = request.result ? stateRecord(request.result) : null;
          if (!same(current, expected)) throw changed();
          const head = snapshots.get(state.headRevisionId);
          head.onsuccess = () => guard(() => {
            const proposed = candidates.get(state.headRevisionId);
            const candidate = proposed?.snapshot ? proposed : head.result as ProjectExchangeStoredRevision | undefined;
            if (!candidate?.snapshot || candidate.lineageId !== state.lineageId
              || candidate.snapshot.rootProjectId !== state.rootProjectId) throw invalid();
            if (expected && expected.headRevisionId !== candidate.revisionId
              && !candidate.parentRevisionIds.includes(expected.headRevisionId)) throw changed();
            // 状态写入与下方不可变版本检查同事务；任何失败都会回滚状态。
            states.put(state);
          });
          for (const row of candidates.values()) {
            const previous = snapshots.get(row.revisionId);
            previous.onsuccess = () => guard(() => {
              const existing = previous.result as ProjectExchangeStoredRevision | undefined;
              if (existing) {
                const existingHeader = { lineageId: existing.lineageId, canonicalVersion: existing.canonicalVersion,
                  revisionId: existing.revisionId, parentRevisionIds: existing.parentRevisionIds, contentDigest: existing.contentDigest };
                const nextHeader = row.snapshot ? projectExchangeRevisionHeader(row as ProjectExchangeRevision) : row;
                if (!same(existingHeader, nextHeader) || existing.snapshot && row.snapshot && !same(existing.snapshot, row.snapshot)) throw changed();
                // 不用只有父链的薄描述覆盖已保存的基线正文。
                if (existing.snapshot || !row.snapshot) return;
              }
              snapshots.put(row);
            });
          }
        });
      });
    }, (error) => { failure ??= error; });
    tx.oncomplete = () => resolve();
    tx.onerror = () => { failure ??= tx.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? changed());
  });
}
