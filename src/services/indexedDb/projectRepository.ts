/** P1 新领域读接口，背后仍是旧 projects；没有任何新表/旧表写入接口。 */
import { DB_VERSION } from './schema';
import type { ProjectAggregate } from '../../types/project';
import type { LegacyProjectProjection, LegacyProjectRecord } from '../../types/projectMigration';
import { projectLegacyRecords, readLegacyProjectAggregate } from '../projectModelCompatibility';
import { estimateLegacyBackupValueBytes } from './projectModelMigrationRepository';

export interface LegacyProjectDirectoryEntry {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  parentId?: string;
  episodeNo?: number;
  kind: 'standalone' | 'series' | 'episode';
  hasPreview: boolean;
}

export interface LegacyProjectRepository {
  readonly access: 'legacy-readonly';
  listProjects(): Promise<LegacyProjectDirectoryEntry[]>;
  listEpisodes(projectId: string): Promise<LegacyProjectDirectoryEntry[]>;
  readRawRecords(projectId?: string): Promise<LegacyProjectRecord[]>;
  readProjection(projectId: string): Promise<LegacyProjectProjection>;
  readProjectAggregate(projectId: string): Promise<ProjectAggregate | null>;
}

function assertProjectId(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('项目身份无效');
}
const time = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;

function readDirectory(database: IDBDatabase): Promise<LegacyProjectDirectoryEntry[]> {
  // 摘要是可重建缓存，缺行不能掩盖完整旧项目。这里只保留轻量 DTO，不假称 IDB 支持字段投影。
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('projects', 'readonly');
    const rows: Array<LegacyProjectDirectoryEntry & { hasSeriesContent: boolean }> = [];
    let failure: Error | undefined;
    let bytes = 0;
    const request = transaction.objectStore('projects').openCursor();
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (!cursor) return;
        if (rows.length >= 200_000) throw new Error('旧项目目录超过只读准备容量');
        const record = cursor.value as Record<string, unknown>;
        assertProjectId(record?.id as string);
        if (record.parentId !== undefined && (typeof record.parentId !== 'string' || !record.parentId.trim())) {
          throw new Error('旧项目目录的所属关系无效');
        }
        if (record.episodeNo !== undefined && (typeof record.episodeNo !== 'number' || !Number.isFinite(record.episodeNo))) {
          throw new Error('旧项目目录的集号无效');
        }
        const entry: LegacyProjectDirectoryEntry & { hasSeriesContent: boolean } = {
          id: record.id as string, name: typeof record.name === 'string' ? record.name : '',
          createdAt: time(record.createdAt), updatedAt: time(record.updatedAt),
          ...(typeof record.parentId === 'string' ? { parentId: record.parentId } : {}),
          ...(typeof record.episodeNo === 'number' ? { episodeNo: record.episodeNo } : {}),
          kind: record.parentId ? 'episode' : 'standalone', hasPreview: typeof record.snapshot === 'string' && record.snapshot.length > 0,
          hasSeriesContent: !!record.series && typeof record.series === 'object'
            && Object.values(record.series).some((value) => value !== undefined && value !== null),
        };
        bytes += estimateLegacyBackupValueBytes(entry);
        if (bytes > 256 * 1024 * 1024) throw new Error('旧项目目录超过只读准备容量');
        rows.push(entry);
        cursor.continue();
      } catch (error) {
        failure = error instanceof Error ? error : new Error('旧项目目录读取失败');
        transaction.abort();
      }
    };
    transaction.oncomplete = () => {
      const owners = new Set(rows.flatMap((row) => row.parentId ? [row.parentId] : []));
      resolve(rows.map(({ hasSeriesContent, ...row }) => ({ ...row,
        kind: row.parentId ? 'episode' : owners.has(row.id) || hasSeriesContent ? 'series' : 'standalone' })));
    };
    transaction.onerror = () => { failure ??= new Error('旧项目目录读取失败'); };
    transaction.onabort = () => reject(failure ?? new Error('旧项目目录读取未完成'));
  });
}

/** 两遍 cursor 同属一个 readonly 事务，保留整个关系组件，不能用截断父链伪造合法剧集。 */
function readRecords(database: IDBDatabase, projectId?: string): Promise<LegacyProjectRecord[]> {
  if (projectId !== undefined) assertProjectId(projectId);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('projects', 'readonly');
    const store = transaction.objectStore('projects');
    const records: LegacyProjectRecord[] = [];
    let failure: Error | undefined;
    let bytes = 0;
    const stop = (error: unknown) => {
      failure = error instanceof Error ? error : new Error('旧项目内容读取失败');
      transaction.abort();
    };
    const scan = (selectedRows?: ReadonlySet<number>) => {
      const request = store.openCursor();
      let rowIndex = 0;
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (!cursor) return;
          const record = cursor.value as LegacyProjectRecord;
          if (selectedRows === undefined || selectedRows.has(rowIndex)) {
            if (records.length >= 200_000) throw new Error('旧项目记录超过只读准备容量');
            bytes += estimateLegacyBackupValueBytes(record);
            if (bytes > 256 * 1024 * 1024) throw new Error('旧项目内容超过只读准备容量，请分批读取');
            records.push(record);
          }
          rowIndex += 1;
          cursor.continue();
        } catch (error) { stop(error); }
      };
    };
    if (projectId === undefined) scan();
    else {
      // 第一遍不持留画布正文；缺失 owner 也作为关系身份连接其全部兄弟/后代。
      const links: string[][] = [];
      const rowsByIdentity = new Map<string, number[]>();
      const request = store.openCursor();
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (!cursor) {
            const selectedRows = new Set<number>(), visited = new Set([projectId]), identities = [projectId];
            for (let index = 0; index < identities.length; index += 1) {
              for (const row of rowsByIdentity.get(identities[index]) ?? []) {
                if (selectedRows.has(row)) continue;
                selectedRows.add(row);
                for (const identity of links[row]) if (!visited.has(identity)) {
                  visited.add(identity); identities.push(identity);
                }
              }
            }
            if (selectedRows.size) scan(selectedRows);
            return;
          }
          if (links.length >= 200_000) throw new Error('旧项目关系超过只读准备容量');
          const record = cursor.value as Record<string, unknown> | null;
          const identities = [...new Set([record?.id, record?.parentId]
            .filter((value): value is string => typeof value === 'string' && value.length > 0))];
          bytes += estimateLegacyBackupValueBytes(identities);
          if (bytes > 256 * 1024 * 1024) throw new Error('旧项目关系超过只读准备容量');
          const rowIndex = links.length;
          links.push(identities);
          for (const identity of identities) {
            const rows = rowsByIdentity.get(identity);
            if (rows) rows.push(rowIndex); else rowsByIdentity.set(identity, [rowIndex]);
          }
          cursor.continue();
        } catch (error) { stop(error); }
      };
    }
    transaction.oncomplete = () => resolve(records);
    transaction.onerror = () => { failure ??= new Error('旧项目内容读取失败'); };
    transaction.onabort = () => reject(failure ?? new Error('旧项目内容读取未完成'));
  });
}

export function createLegacyProjectRepository(database: IDBDatabase): LegacyProjectRepository {
  if (database.version > DB_VERSION || !database.objectStoreNames.contains('projects')) {
    throw new Error('当前数据库不支持旧项目只读仓储');
  }
  return {
    access: 'legacy-readonly',
    listProjects: async () => (await readDirectory(database)).filter((entry) => entry.parentId === undefined),
    listEpisodes: async (projectId) => {
      assertProjectId(projectId);
      return (await readDirectory(database)).filter((entry) => entry.parentId === projectId)
        .sort((left, right) => (left.episodeNo ?? 0) - (right.episodeNo ?? 0));
    },
    readRawRecords: (projectId) => readRecords(database, projectId),
    readProjection: async (projectId) => projectLegacyRecords(await readRecords(database, projectId)),
    readProjectAggregate: async (projectId) => readLegacyProjectAggregate(await readRecords(database, projectId), projectId),
  };
}
