import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectModelTransferAggregate, ProjectModelTransferHistoryRow } from '../../src/types/projectModelTransfer';

const io = vi.hoisted(() => ({ database: null as unknown as IDBDatabase }));
vi.mock('../../src/services/indexedDb/schema', () => ({ openDB: async () => io.database, STORE_METADATA: 'metadata', STORE_PROJECTS: 'projects',
  STORE_CHAT_CONVERSATIONS: 'conversations', STORE_CHAT_MESSAGES: 'messages', STORE_PROJECT_MEMORIES: 'memories', STORE_HISTORY: 'history' }));
import { assertNativeArchiveHistoryCommitted, commitNativeArchiveHistory } from '../../src/services/nativeArchiveHistoryCommit';

const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error);
});
const operation = (operationId = 'update-original') => ({ operationId, targetProjectId: 'project', mode: 'update-existing' as const,
  next: { project: { id: 'project' }, episodes: [], canvases: [{ id: 'canvas' }] } as unknown as ProjectModelTransferAggregate,
  idMap: [{ kind: 'canvas' as const, sourceId: 'source-canvas', localId: 'canvas' }],
  history: [{ kind: 'output' as const, sourceNamespace: 'lineage', archiveOriginId: 'a'.repeat(64),
    value: { id: 'local-history', projectId: 'canvas', nodeId: 'node', timestamp: 1, prompt: '冻结原稿', output: 'imports/result.png' } }] as ProjectModelTransferHistoryRow[] });

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  const opening = new IDBFactory().open('isolated-history', 1);
  opening.onupgradeneeded = () => {
    for (const name of ['metadata', 'projects', 'conversations', 'messages', 'memories', 'history']) {
      const store = opening.result.createObjectStore(name, { keyPath: 'id' });
      if (name === 'history') store.createIndex('projectId_timestamp_id', ['projectId', 'timestamp', 'id']);
    }
  };
  io.database = await request(opening);
});
afterEach(() => { io.database.close(); vi.unstubAllGlobals(); });

it('输出历史与提交marker同事务结算，原操作重试不重复，后续删除不被相同来源更新复活', async () => {
  const original = operation();
  await expect(assertNativeArchiveHistoryCommitted(original)).rejects.toThrow('尚未交付');
  await commitNativeArchiveHistory(original);
  await expect(assertNativeArchiveHistoryCommitted(original)).resolves.toBeUndefined();
  await commitNativeArchiveHistory(original);
  expect(await request(io.database.transaction('history').objectStore('history').count())).toBe(1);
  await request(io.database.transaction('history', 'readwrite').objectStore('history').delete('local-history'));
  await commitNativeArchiveHistory(operation('next-update'));
  expect(await request(io.database.transaction('history').objectStore('history').count())).toBe(0);
});

it('历史写入失败原子撤销数据和marker，修复冲突后沿原journal完整续接', async () => {
  const original = operation();
  original.history.push({ ...original.history[0], archiveOriginId: 'b'.repeat(64),
    value: { ...original.history[0].value, id: 'occupied' } });
  await request(io.database.transaction('history', 'readwrite').objectStore('history').add({ id: 'occupied', projectId: 'another', output: '用户原记录' }));
  await expect(commitNativeArchiveHistory(original)).rejects.toThrow('身份冲突');
  expect(await request(io.database.transaction('history').objectStore('history').get('local-history'))).toBeUndefined();
  await expect(assertNativeArchiveHistoryCommitted(original)).rejects.toThrow('尚未交付');
  await request(io.database.transaction('history', 'readwrite').objectStore('history').delete('occupied'));
  await commitNativeArchiveHistory(original);
  expect(await request(io.database.transaction('history').objectStore('history').count())).toBe(2);
  await expect(assertNativeArchiveHistoryCommitted(original)).resolves.toBeUndefined();
});

it('既有来源只登记映射不覆盖用户修改，恢复内容禁止回滚输出历史或重建任务', async () => {
  const original = operation();
  original.history[0].existingLocalId = 'user-history';
  await request(io.database.transaction('history', 'readwrite').objectStore('history').add({ id: 'user-history', projectId: 'canvas', prompt: '用户修改' }));
  await commitNativeArchiveHistory(original);
  expect(await request(io.database.transaction('history').objectStore('history').get('user-history'))).toMatchObject({ prompt: '用户修改' });
  expect(await request(io.database.transaction('history').objectStore('history').count())).toBe(1);
  await expect(commitNativeArchiveHistory({ ...operation('restore'), mode: 'restore-content' })).rejects.toThrow('恢复不回滚历史');
  await expect(commitNativeArchiveHistory({ ...operation('task-injection'), history: [{ ...original.history[0], kind: 'message' }] })).rejects.toThrow('更新只能追加');
});

it('同一次更新按每画布只保留最新16条，裁剪和来源marker一起提交且原来源不会再次出现', async () => {
  const original = operation();
  original.history = Array.from({ length: 20 }, (_, index) => ({ ...original.history[0], archiveOriginId: index.toString(16).padStart(64, '0'),
    value: { ...original.history[0].value, id: `output-${index}`, timestamp: index } }));
  await commitNativeArchiveHistory(original);
  const rows = await request(io.database.transaction('history').objectStore('history').getAll()) as Array<{ timestamp: number }>;
  expect(rows).toHaveLength(16); expect(Math.min(...rows.map((row) => row.timestamp))).toBe(4);
  await commitNativeArchiveHistory({ ...original, operationId: 'repeated-source' });
  expect(await request(io.database.transaction('history').objectStore('history').count())).toBe(16);
});
