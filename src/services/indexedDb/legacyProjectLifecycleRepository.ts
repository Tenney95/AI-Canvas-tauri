/** 旧模型的聚合生命周期事务；不升库、不迁移，不覆盖作品正文或删除审计事实。 */
import { openDB, STORE_METADATA, STORE_PROJECTS, STORE_PROJECT_SUMMARIES } from './schema';
import { toProjectSummaryRecord } from './projectSummary';
import { withLegacyProjectWrite } from './legacyProjectWriteGuard';

export interface LegacyProjectIdentity {
  id: string;
  parentId?: string;
  exchangeEpoch?: number;
}
export interface LegacyEpisodeOrderIdentity extends LegacyProjectIdentity { episodeNo?: number }
export interface LegacyEpisodeOrderPatch { id: string; episodeNo: number; updatedAt: number; exchangeEpoch: number }

type StoredProject = LegacyEpisodeOrderIdentity & Record<string, unknown>;
const invalid = () => new Error('项目结构或版本已变化，请重新打开后重试');
const idValid = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256;
const epoch = (value: unknown): number => {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
};
const sameIds = (left: readonly string[], right: readonly string[]) => {
  const expected = new Set(right);
  return left.length === right.length && new Set(left).size === left.length && left.every((id) => expected.has(id));
};

function transact<T>(write: (tx: IDBTransaction, finish: (result: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  return openDB().then((database) => new Promise<T>((resolve, reject) => {
    const tx = database.transaction([STORE_PROJECTS, STORE_PROJECT_SUMMARIES, STORE_METADATA], 'readwrite');
    let result: T;
    let failure: Error | undefined;
    const fail = (cause: unknown) => {
      failure = cause instanceof Error ? cause : invalid();
      try { tx.abort(); } catch { /* 已结束。 */ }
    };
    withLegacyProjectWrite(tx, () => {
      try { write(tx, (next) => { result = next; }, fail); } catch (error) { fail(error); }
    }, fail);
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(failure ?? new Error('项目聚合保存失败，原始内容已保留'));
  }));
}

function withUndeletedTargets(tx: IDBTransaction, ids: readonly string[], write: () => void, fail: (error: unknown) => void) {
  let pending = ids.length;
  for (const id of ids) {
    const request = tx.objectStore(STORE_METADATA).get(`project-deleted:${id}`);
    request.onsuccess = () => {
      try {
        if (request.result !== undefined) throw invalid();
        if (--pending === 0) write();
      } catch (error) { fail(error); }
    };
  }
}

/** 单事务读取集合后只打排序补丁，不能用调用方的旧整条记录覆盖较新的稿件/画布。 */
export async function swapLegacyEpisodeOrder(input: {
  ownerId: string;
  expectedOwnerEpoch?: number;
  expectedEpisodes: readonly LegacyEpisodeOrderIdentity[];
  episodeId: string;
  direction: -1 | 1;
  assertCurrent?: () => void;
}): Promise<LegacyEpisodeOrderPatch[]> {
  if (!idValid(input.ownerId) || !idValid(input.episodeId) || ![-1, 1].includes(input.direction)
    || !input.expectedEpisodes.length || input.expectedEpisodes.some((item) => !idValid(item.id))
    || new Set(input.expectedEpisodes.map((item) => item.id)).size !== input.expectedEpisodes.length) return Promise.reject(invalid());
  const expectedEpoch = epoch(input.expectedOwnerEpoch);
  return transact<LegacyEpisodeOrderPatch[]>((tx, finish, fail) => {
    const projects = tx.objectStore(STORE_PROJECTS), summaries = tx.objectStore(STORE_PROJECT_SUMMARIES);
    const episodes: LegacyEpisodeOrderIdentity[] = [];
    let owner: LegacyProjectIdentity | undefined;
    let scanned = 0;
    const request = projects.openCursor();
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (cursor) {
          if (++scanned > 200_000) throw invalid();
          const item = cursor.value as StoredProject;
          const identity = { id: item.id, parentId: item.parentId, exchangeEpoch: item.exchangeEpoch };
          if (item.id === input.ownerId) owner = identity;
          if (item.parentId === input.ownerId) episodes.push({ ...identity, episodeNo: item.episodeNo });
          cursor.continue(); return;
        }
        input.assertCurrent?.();
        if (!owner || owner.parentId || epoch(owner.exchangeEpoch) !== expectedEpoch
          || !sameIds(episodes.map((item) => item.id), input.expectedEpisodes.map((item) => item.id))) throw invalid();
        const numbers = new Set<number>();
        for (const item of episodes) {
          const expected = input.expectedEpisodes.find((entry) => entry.id === item.id);
          if (!expected || item.episodeNo !== expected.episodeNo || epoch(item.exchangeEpoch) !== epoch(expected.exchangeEpoch)
            || typeof item.episodeNo !== 'number' || !Number.isSafeInteger(item.episodeNo) || item.episodeNo < 1
            || numbers.has(item.episodeNo)) throw new Error('旧集号重复、缺失或已变化，已保留原顺序');
          numbers.add(item.episodeNo);
          if (epoch(item.exchangeEpoch) >= Number.MAX_SAFE_INTEGER) throw invalid();
        }
        episodes.sort((left, right) => left.episodeNo! - right.episodeNo!);
        const index = episodes.findIndex((item) => item.id === input.episodeId);
        const current = episodes[index], neighbour = episodes[index + input.direction];
        if (!current || !neighbour) throw invalid();
        const updatedAt = Date.now();
        const patches = [
          { id: current.id, episodeNo: neighbour.episodeNo!, updatedAt, exchangeEpoch: epoch(current.exchangeEpoch) + 1 },
          { id: neighbour.id, episodeNo: current.episodeNo!, updatedAt, exchangeEpoch: epoch(neighbour.exchangeEpoch) + 1 },
        ];
        // 目录扫描只保留身份；同事务按需读取两条正文，不持留整部剧的画布。
        let pending = patches.length;
        const records = new Map<string, StoredProject>();
        for (const patch of patches) {
          const full = projects.get(patch.id);
          full.onsuccess = () => {
            try {
              if (!full.result) throw invalid();
              records.set(patch.id, full.result as StoredProject);
              if (--pending !== 0) return;
              input.assertCurrent?.();
              withUndeletedTargets(tx, [input.ownerId, ...patches.map((item) => item.id)], () => {
                input.assertCurrent?.();
                for (const nextPatch of patches) {
                  const next = { ...records.get(nextPatch.id)!, ...nextPatch };
                  const summary = toProjectSummaryRecord(next);
                  if (!summary) throw invalid();
                  projects.put(next); summaries.put(summary);
                }
                finish(patches);
              }, fail);
            } catch (error) { fail(error); }
          };
        }
      } catch (error) { fail(error); }
    };
  });
}

/** 只逻辑删除业务记录。收费/幂等/队列、来源历史和素材仍供只读审计或后续恢复。 */
export function deleteLegacyProjectContent(input: {
  targetId: string;
  expectedProjects: readonly LegacyProjectIdentity[];
  assertCurrent?: () => void;
}): Promise<string[]> {
  if (!idValid(input.targetId) || !input.expectedProjects.length
    || input.expectedProjects.some((item) => !idValid(item.id))
    || new Set(input.expectedProjects.map((item) => item.id)).size !== input.expectedProjects.length) return Promise.reject(invalid());
  return transact<string[]>((tx, finish, fail) => {
    const projects = tx.objectStore(STORE_PROJECTS);
    const identities: LegacyProjectIdentity[] = [];
    const request = projects.openCursor();
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (cursor) {
          if (identities.length >= 200_000) throw invalid();
          const record = cursor.value as StoredProject;
          identities.push({ id: record.id, parentId: record.parentId, exchangeEpoch: record.exchangeEpoch });
          cursor.continue(); return;
        }
        input.assertCurrent?.();
        const target = identities.find((item) => item.id === input.targetId);
        if (!target) throw invalid();
        const selected = target.parentId ? [target] : identities.filter((item) => item.id === target.id || item.parentId === target.id);
        if (!sameIds(selected.map((item) => item.id), input.expectedProjects.map((item) => item.id))) throw invalid();
        if (target.parentId) {
          const owner = identities.find((item) => item.id === target.parentId);
          if (!owner || owner.parentId) throw invalid();
          if (identities.filter((item) => item.parentId === owner.id).length <= 1) {
            throw new Error('当前旧项目格式暂不支持删除最后一集，已保留整部剧');
          }
        }
        const ids = selected.map((item) => item.id), removed = new Set(ids);
        if (identities.some((item) => item.parentId && removed.has(item.parentId) && !removed.has(item.id))) throw invalid();
        for (const item of selected) {
          const expected = input.expectedProjects.find((entry) => entry.id === item.id);
          if (!expected || item.parentId !== expected.parentId || epoch(item.exchangeEpoch) !== epoch(expected.exchangeEpoch)) throw invalid();
        }
        withUndeletedTargets(tx, ids, () => {
          input.assertCurrent?.();
          const deletedAt = Date.now();
          for (const id of ids) {
            projects.delete(id); tx.objectStore(STORE_PROJECT_SUMMARIES).delete(id);
            tx.objectStore(STORE_METADATA).put({ id: `project-deleted:${id}`, deletedAt,
              scope: 'legacy-project-content', retainedAudit: true, retainedDataDirectory: true });
          }
          finish(ids);
        }, fail);
      } catch (error) { fail(error); }
    };
  });
}
