/** P1 只读源与覆盖边界；仅补回归材料，本轮不执行。 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  estimateLegacyBackupValueBytes, isKnownExcludedProjectModelBackupStore,
  isProjectModelBackupMetadataKey, openExistingProjectDatabase, readLegacyMigrationSnapshot,
} from '../../src/services/indexedDb/projectModelMigrationRepository';

async function seed(factory: IDBFactory, name: string,
  options: { version?: number; unknown?: boolean; unsupportedSchema?: boolean } = {}) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, options.version ?? 27);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('projects', { keyPath: 'id', autoIncrement: options.unsupportedSchema === true }).createIndex('name', 'name');
      request.result.createObjectStore('metadata', { keyPath: 'id' });
      request.result.createObjectStore('config', { keyPath: 'id' });
      if (options.unknown) request.result.createObjectStore('future-project-data', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(['projects', 'metadata', 'config'], 'readwrite');
    transaction.objectStore('projects').put({ id: 'root', name: '中文项目', nodes: [], edges: [],
      createdAt: 1, updatedAt: 2, optional: undefined, bytes: new Uint8Array([0, 128, 255]) });
    transaction.objectStore('metadata').put({ id: 'last-active-project', projectId: 'root' });
    if (options.unknown) transaction.objectStore('metadata').put({ id: 'unclassified:future', value: '未分类资料' });
    transaction.objectStore('config').put({ id: 'app-config', data: { private: '配置不进入项目恢复材料' } });
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  return database;
}

describe('旧项目迁移只读源', () => {
  it('缺失库只返回 null，首次建库事务被中止', async () => {
    const factory = new IDBFactory();
    await expect(openExistingProjectDatabase({ factory, name: 'absent' })).resolves.toBeNull();
    expect(await factory.databases()).toEqual([]);
  });

  it('不提升旧库版本，拒绝未来库，迟到连接不会留给调用者', async () => {
    const factory = new IDBFactory();
    const original = await seed(factory, 'legacy', { version: 18 }); original.close();
    const existing = await openExistingProjectDatabase({ factory, name: 'legacy' });
    expect(existing?.version).toBe(18); existing?.close();
    const future = await seed(factory, 'future', { version: 28 }); future.close();
    await expect(openExistingProjectDatabase({ factory, name: 'future' })).rejects.toThrow('更新版本');
    expect((await factory.databases()).find((row) => row.name === 'future')?.version).toBe(28);
  });

  it('保留源原值、key/schema/index及损坏队列原串，不备份配置或规范化写回', async () => {
    const database = await seed(new IDBFactory(), 'capture');
    try {
      const raw = '{not-json: 原队列不能被自动清空';
      const snapshot = await readLegacyMigrationSnapshot(database, { localStorage: { getItem: () => raw } });
      expect(snapshot.complete).toBe(true);
      expect(snapshot.diagnostics).toEqual([]);
      expect(snapshot.source.databaseStoreNames).toEqual(['config', 'metadata', 'projects']);
      expect(snapshot.source.stores.map((store) => store.name)).toEqual(['metadata', 'projects']);
      const projects = snapshot.source.stores.find((store) => store.name === 'projects')!;
      expect(projects).toMatchObject({ keyPath: 'id', autoIncrement: false,
        indexes: [{ name: 'name', keyPath: 'name', unique: false, multiEntry: false }] });
      expect(projects.records[0].key).toBe('root');
      expect(projects.records[0].value).toHaveProperty('optional', undefined);
      expect((projects.records[0].value as { bytes: unknown }).bytes).toEqual(new Uint8Array([0, 128, 255]));
      expect(snapshot.source.localStorage).toEqual([{ key: 'ai_canvas_pending_tasks', value: raw }]);
      expect(database.version).toBe(27);
      expect(Array.from(database.objectStoreNames)).toEqual(['config', 'metadata', 'projects']);
    } finally { database.close(); }
  });

  it('未知表或 metadata 不能被默默遗漏后宣称覆盖完整', async () => {
    const database = await seed(new IDBFactory(), 'unknown', { unknown: true });
    try {
      const snapshot = await readLegacyMigrationSnapshot(database, { localStorage: { getItem: () => null } });
      expect(snapshot.complete).toBe(false);
      expect(snapshot.diagnostics.map((item) => item.code)).toEqual(['unknown-store', 'unknown-metadata-key']);
      expect(snapshot.source.stores.some((store) => store.name === 'future-project-data')).toBe(false);
      expect(snapshot.source.stores.find((store) => store.name === 'metadata')?.records).toHaveLength(1);
      expect(snapshot.diagnostics.every((item) => item.blocking)).toBe(true);
    } finally { database.close(); }
  });

  it('队列在 IDB 读取期间变化或无法读取时阻断完整性', async () => {
    const database = await seed(new IDBFactory(), 'queue');
    try {
      let reads = 0;
      const changed = await readLegacyMigrationSnapshot(database, {
        localStorage: { getItem: () => ++reads === 1 ? 'old' : 'new' },
      });
      expect(changed.complete).toBe(false);
      expect(changed.source.localStorage[0].value).toBe('old');
      expect(changed.diagnostics).toContainEqual({ code: 'local-storage-changed', blocking: true });
      const unavailable = await readLegacyMigrationSnapshot(database, { localStorage: null });
      expect(unavailable.complete).toBe(false);
      expect(unavailable.diagnostics).toContainEqual({ code: 'local-storage-unavailable', blocking: true });
    } finally { database.close(); }
  });

  it('意外 autoIncrement schema 保留原材料但不宣称可精确恢复', async () => {
    const database = await seed(new IDBFactory(), 'schema', { unsupportedSchema: true });
    try {
      const snapshot = await readLegacyMigrationSnapshot(database, { localStorage: { getItem: () => null } });
      expect(snapshot.complete).toBe(false);
      expect(snapshot.diagnostics).toContainEqual({ code: 'unsupported-store-schema', blocking: true, store: 'projects' });
      expect(snapshot.source.stores.find((store) => store.name === 'projects')?.records).toHaveLength(1);
    } finally { database.close(); }
  });

  it('cursor 内超过预算即终止，不返回半份可用快照', async () => {
    const database = await seed(new IDBFactory(), 'budget');
    try {
      await expect(readLegacyMigrationSnapshot(database, { localStorage: { getItem: () => null }, maxRecordBytes: 32 }))
        .rejects.toThrow('容量');
      await expect(readLegacyMigrationSnapshot(database, { localStorage: { getItem: () => null }, maxRecords: 1 }))
        .rejects.toThrow('记录过多');
    } finally { database.close(); }
  });

  it('只接受盘点过的 metadata 类型，保留幂等占位与恢复记录', () => {
    for (const key of ['mcp-operation:0123', 'project-import-recovery:op', 'project-import-operation:op',
      'project-deleted:root', 'video-batches:episode', 'forgotten-missing-path:encoded', 'media-relocations']) {
      expect(isProjectModelBackupMetadataKey(key)).toBe(true);
    }
    expect(isProjectModelBackupMetadataKey('mcp-operation:')).toBe(false);
    expect(isProjectModelBackupMetadataKey('app-config')).toBe(false);
    expect(isKnownExcludedProjectModelBackupStore('config')).toBe(true);
    expect(isKnownExcludedProjectModelBackupStore('future-project-data')).toBe(false);
  });

  it('同步预算识别 Unicode、二进制与循环，不执行访问器', () => {
    expect(estimateLegacyBackupValueBytes('中😀')).toBe(7);
    expect(estimateLegacyBackupValueBytes(new Uint8Array([1, 2, 3]))).toBeGreaterThanOrEqual(3);
    const circular: { self?: unknown } = {}; circular.self = circular;
    expect(estimateLegacyBackupValueBytes(circular)).toBeGreaterThan(0);
    expect(() => estimateLegacyBackupValueBytes({ get text() { throw new Error('不应读取'); } }))
      .toThrow('访问器');
  });
});
