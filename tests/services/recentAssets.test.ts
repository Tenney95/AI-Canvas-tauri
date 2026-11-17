/**
 * recentAssets — 回归测试：最近使用持久化与资产解析。
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetIndexRecord } from '../../src/services/indexedDbService';
import type { AppState } from '../../src/store/useAppStore';
import { createStore } from 'zustand/vanilla';

const driver = vi.hoisted(() => ({ native: true, stat: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ stat: driver.stat }));
vi.mock('../../src/services/fs/assetLibrary', () => ({ getGlobalFilesDir: async () => '/global/file' }));
vi.mock('../../src/services/fs/core', () => ({
  isTauriEnv: () => driver.native, getProjectDataDir: async (id: string) => `/projects/${id}`,
  getConvertFileSrc: async () => (path: string) => `asset:${path}`,
  getFileCategory: (name: string) => name.endsWith('.mp4') ? 'video' : 'image',
  stripVerbatimPrefix: (path: string) => path,
}));
beforeEach(() => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); driver.native = true;
  driver.stat.mockReset().mockResolvedValue({ isFile: true, isSymlink: false, size: 42 });
});
afterEach(() => vi.unstubAllGlobals());
function index(assetId: string, path = `/global/file/${assetId}.png`, patch: Partial<AssetIndexRecord> = {}): AssetIndexRecord {
  return { assetId, path, source: 'global', fingerprint: '42:1', size: 42, mtimeMs: 1,
    status: 'online', updatedAt: 99999, ...patch };
}
const scope = { folderRoots: ['/external'], projectIds: ['project'] };

describe('最近使用持久化与资产解析', () => {
  it('导入回收只删除本轮ID与当前位置均匹配的索引', async () => {
    const db = await import('../../src/services/indexedDbService');
    await db.putAssetIndex(index('own', '/project/Library/import-one/own.png'));
    await db.putAssetIndex(index('moved', '/project/Library/other/moved.png'));
    await db.putAssetIndex(index('unrelated'));
    await db.deleteImportedAssetIndexes([
      { assetId: 'own', path: '/project/Library/import-one/own.png' },
      { assetId: 'moved', path: '/project/Library/import-one/moved.png' },
      { assetId: 'missing', path: '/project/Library/import-one/missing.png' },
    ]);
    expect(await db.getAssetIndexById('own')).toBeUndefined();
    expect(await db.getAssetIndexById('moved')).toBeDefined();
    expect(await db.getAssetIndexById('unrelated')).toBeDefined();
  });

  it('原子合并并发写入，重复使用更新位置且旧请求不倒退时间', async () => {
    const db = await import('../../src/services/indexedDbService');
    await Promise.all(Array.from({ length: 60 }, (_, i) => db.recordRecentAssetUsage(`asset-${i}`, i)));
    let entries = await db.getRecentAssetUsage();
    expect(entries).toHaveLength(10); expect(entries[0]).toEqual({ assetId: 'asset-59', usedAt: 59 });
    expect(entries[9].assetId).toBe('asset-50');
    await Promise.all([db.recordRecentAssetUsage('asset-20', 100), db.recordRecentAssetUsage('asset-20', 15)]);
    entries = await db.getRecentAssetUsage();
    expect(entries[0]).toEqual({ assetId: 'asset-20', usedAt: 100 });
    expect(entries.filter((entry) => entry.assetId === 'asset-20')).toHaveLength(1);
    const { openDB, STORE_METADATA } = await import('../../src/services/indexedDb/schema');
    const database = await openDB();
    const raw = await new Promise<{ entries: unknown[] }>((resolve) => {
      const read = database.transaction(STORE_METADATA).objectStore(STORE_METADATA).get('recent-asset-usage');
      read.onsuccess = () => resolve(read.result);
    });
    expect(raw.entries).toEqual(entries); expect(JSON.stringify(raw)).not.toContain('path');
    expect(await db.getAssetIndexById('asset-20')).toBeUndefined();
    await expect(db.recordRecentAssetUsage('', 1)).rejects.toThrow('无效');
    await expect(db.recordRecentAssetUsage('asset', Number.NaN)).rejects.toThrow('无效');
  });

  it('读取旧库空状态，过滤损坏记录和多余字段，不提升数据库版本', async () => {
    const { openDB, STORE_METADATA, DB_VERSION } = await import('../../src/services/indexedDb/schema');
    const db = await import('../../src/services/indexedDbService');
    expect(await db.getRecentAssetUsage()).toEqual([]);
    const database = await openDB();
    expect(database.version).toBe(DB_VERSION);
    await new Promise<void>((resolve) => {
      const tx = database.transaction(STORE_METADATA, 'readwrite');
      tx.objectStore(STORE_METADATA).put({ id: 'recent-asset-usage', entries: [null, { assetId: 'invalid' },
        { assetId: 'asset', usedAt: 2, path: '/not-retained' }, { assetId: 'asset', usedAt: 1 }] });
      tx.oncomplete = () => resolve();
    });
    expect(await db.getRecentAssetUsage()).toEqual([{ assetId: 'asset', usedAt: 2 }]);
  });

  it('保留超过十项的全量索引时间，首页仍只保留最近十项且读取不增加stat', async () => {
    const db = await import('../../src/services/indexedDbService');
    const ids = Array.from({ length: 30 }, (_, i) => `asset-${i}`);
    await Promise.all(ids.map((id) => db.putAssetIndex(index(id))));
    await Promise.all(ids.map((id, i) => db.recordRecentAssetUsage(id, i)));
    const recent = await db.getRecentAssetUsage();
    expect(recent).toHaveLength(10);
    expect(recent.map((entry) => entry.assetId)).toEqual(ids.slice(20).reverse());
    const times = await db.getAssetLastUsedTimes([...ids, ids[0], '', 'missing']);
    expect(times.size).toBe(30);
    expect(times.get(ids[0])).toBe(0);
    expect(times.get(ids[29])).toBe(29);
    expect(times.has('missing')).toBe(false);
    expect(await db.getAssetLastUsedTimes([])).toEqual(new Map());
    expect(driver.stat).not.toHaveBeenCalled();
  });

  it('陈旧扫描、重命名与并发使用不清空或倒退索引时间，已移出十项的记录仍可保留', async () => {
    const db = await import('../../src/services/indexedDbService');
    const scanned = index('asset');
    await db.putAssetIndex(scanned);
    await db.recordRecentAssetUsage('asset', 10);
    const renamed = { ...scanned, path: '/global/file/重命名.png', updatedAt: 100000 };
    await Promise.all([
      db.putAssetIndex(renamed), db.recordRecentAssetUsage('asset', 20),
      db.putAssetIndex({ ...renamed, lastUsedAt: 3 }), db.recordRecentAssetUsage('asset', 15),
    ]);
    expect(await db.getAssetIndexById('asset')).toMatchObject({ path: renamed.path, lastUsedAt: 20 });
    expect(await db.getRecentAssetUsage()).toEqual([{ assetId: 'asset', usedAt: 20 }]);
    await Promise.all(Array.from({ length: 12 }, (_, i) => db.recordRecentAssetUsage(`other-${i}`, 100 + i)));
    expect((await db.getRecentAssetUsage()).some((entry) => entry.assetId === 'asset')).toBe(false);
    await db.recordRecentAssetUsage('asset', 5);
    await db.putAssetIndex(renamed);
    expect((await db.getAssetLastUsedTimes(['asset'])).get('asset')).toBe(20);
    expect((await db.getRecentAssetUsage()).some((entry) => entry.assetId === 'asset')).toBe(false);
  });

  it('首次新使用前保留旧metadata中仍可恢复的十项时间，后续裁剪不会再丢失', async () => {
    const db = await import('../../src/services/indexedDbService');
    const ids = Array.from({ length: 10 }, (_, i) => `legacy-${i}`);
    await Promise.all(ids.map((id) => db.putAssetIndex(index(id))));
    const { openDB, STORE_METADATA } = await import('../../src/services/indexedDb/schema');
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE_METADATA, 'readwrite');
      tx.objectStore(STORE_METADATA).put({ id: 'recent-asset-usage', entries: ids.map((assetId, usedAt) => ({ assetId, usedAt })) });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    for (let i = 0; i < 11; i++) {
      await db.putAssetIndex(index(`new-${i}`));
      await db.recordRecentAssetUsage(`new-${i}`, 100 + i);
    }
    expect((await db.getRecentAssetUsage()).every((entry) => entry.assetId.startsWith('new-'))).toBe(true);
    const times = await db.getAssetLastUsedTimes(ids);
    expect(times.size).toBe(10);
    expect(ids.map((id) => times.get(id))).toEqual(ids.map((_, i) => i));
    expect(driver.stat).not.toHaveBeenCalled();
  });

  it('批读只返回请求ID，旧metadata回退与索引取最大有效时间且不回写', async () => {
    const db = await import('../../src/services/indexedDbService');
    const { openDB, STORE_ASSET_INDEX, STORE_METADATA } = await import('../../src/services/indexedDb/schema');
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction([STORE_ASSET_INDEX, STORE_METADATA], 'readwrite');
      const assets = tx.objectStore(STORE_ASSET_INDEX);
      assets.put(index('index-newer', undefined, { lastUsedAt: 30 }));
      assets.put(index('metadata-newer', undefined, { lastUsedAt: 4 }));
      assets.put(index('invalid-index', undefined, { lastUsedAt: Number.NaN }));
      assets.put(index('invalid-only', undefined, { lastUsedAt: -1 }));
      assets.put(index('unrequested', undefined, { lastUsedAt: 999 }));
      tx.objectStore(STORE_METADATA).put({ id: 'recent-asset-usage', entries: [
        { assetId: 'legacy', usedAt: 8 }, { assetId: 'index-newer', usedAt: 5 },
        { assetId: 'metadata-newer', usedAt: 12 }, { assetId: 'invalid-index', usedAt: 7 },
        { assetId: 'unrequested', usedAt: 999 },
      ] });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    const times = await db.getAssetLastUsedTimes(['legacy', 'index-newer', 'metadata-newer', 'invalid-index', 'invalid-only', 'unknown']);
    expect(times.size).toBe(4);
    expect(times.get('legacy')).toBe(8);
    expect(times.get('index-newer')).toBe(30);
    expect(times.get('metadata-newer')).toBe(12);
    expect(times.get('invalid-index')).toBe(7);
    expect(times.has('unrequested')).toBe(false);
    expect(times.has('invalid-only')).toBe(false);
    expect(await db.getAssetIndexById('legacy')).toBeUndefined();
    expect((await db.getAssetIndexById('metadata-newer'))?.lastUsedAt).toBe(4);
    expect(driver.stat).not.toHaveBeenCalled();
  });

  it('只记录已索引的真实素材，扫描时间和虚拟路径不计入使用', async () => {
    const db = await import('../../src/services/indexedDbService');
    const service = await import('../../src/services/fs/recentAssets');
    await db.putAssetIndex(index('asset'));
    expect(await db.getRecentAssetUsage()).toEqual([]);
    expect(await service.markRecentAssetUsed({ path: 'node://image' }, 1)).toBe(false);
    expect(await service.markRecentAssetUsed({ path: '/missing.png' }, 1)).toBe(false);
    expect(await service.markRecentAssetUsed({ path: '/global/file/asset.png', assetId: 'wrong' }, 1)).toBe(false);
    expect(await service.markRecentAssetUsed({ path: '/global/file/asset.png' }, 123)).toBe(true);
    expect(await db.getRecentAssetUsage()).toEqual([{ assetId: 'asset', usedAt: 123 }]);
    driver.native = false;
    expect(await service.markRecentAssetUsed({ path: '/global/file/asset.png' }, 234)).toBe(false);
    expect(await service.loadRecentAssets(scope)).toEqual([]);
  });

  it('删除、权限失败、撤销关联、项目删除和回收目录都不展示；恢复后可再显示', async () => {
    const db = await import('../../src/services/indexedDbService');
    const { loadRecentAssets } = await import('../../src/services/fs/recentAssets');
    const records = [index('ok'), index('missing'), index('revoked', '/removed/revoked.png', { source: 'folder' }),
      index('deleted-project', '/projects/deleted/x.png', { source: 'project', projectId: 'deleted' }),
      index('escape', '/global/file/../outside.png'), index('trash', '/global/file/.trash/x.png'),
      index('folder', '/external/child/x.mp4', { source: 'folder', rootPath: '/external' }),
      index('project', '/projects/project/x.png', { source: 'project', projectId: 'project' })];
    for (const record of records) { await db.putAssetIndex(record); await db.recordRecentAssetUsage(record.assetId, 1); }
    driver.stat.mockImplementation(async (path: string) => {
      if (path.includes('missing')) throw new Error('Permission denied');
      return { isFile: true, isSymlink: false, size: 42 };
    });
    const visible = await loadRecentAssets(scope);
    expect(visible.map((entry) => entry.file.assetId)).toEqual(['project', 'folder', 'ok']);
    expect(visible.find((entry) => entry.file.assetId === 'folder')?.file).toMatchObject({ category: 'video', folderRoot: '/external', relativePath: 'child/x.mp4' });
    expect(driver.stat.mock.calls.some(([path]) => String(path).includes('/removed/'))).toBe(false);
    expect(await db.getRecentAssetUsage()).toHaveLength(records.length);
    driver.stat.mockResolvedValue({ isFile: true, isSymlink: false, size: 42 });
    expect((await loadRecentAssets(scope)).map((entry) => entry.file.assetId)).toContain('missing');
  });

  it('旧最近使用索引不再展示内部暂存件，普通 pending 与原索引记录保留', async () => {
    const db = await import('../../src/services/indexedDbService');
    const { loadRecentAssets } = await import('../../src/services/fs/recentAssets');
    const hash = 'a'.repeat(64);
    const records = [index('old-pending', `/global/file/.native-media-${hash}.pending`),
      index('new-pending', `/global/file/.native-media-${hash}.png.pending`), index('user-pending', '/global/file/ordinary.pending')];
    for (const record of records) { await db.putAssetIndex(record); await db.recordRecentAssetUsage(record.assetId, 1); }

    expect((await loadRecentAssets(scope)).map((entry) => entry.file.name)).toEqual(['ordinary.pending']);
    for (const record of records.slice(0, 2)) expect(driver.stat).not.toHaveBeenCalledWith(record.path);
    expect(await db.getRecentAssetUsage()).toHaveLength(3);
    for (const record of records) expect(await db.getAssetIndexById(record.assetId)).toBeDefined();
  });

  it('索引重命名后跟随稳定 ID 的新位置，展示最多 12 项且取消读取不回写', async () => {
    const db = await import('../../src/services/indexedDbService');
    const { loadRecentAssets } = await import('../../src/services/fs/recentAssets');
    for (let i = 0; i < 20; i++) { await db.putAssetIndex(index(`asset-${i}`)); await db.recordRecentAssetUsage(`asset-${i}`, i); }
    await db.putAssetIndex(index('asset-19', '/global/file/重命名.png'));
    const entries = await loadRecentAssets(scope);
    expect(entries).toHaveLength(10); expect(entries[0].file.name).toBe('重命名.png');
    expect(entries[0].usedAt).toBe(19); expect(driver.stat).toHaveBeenCalledTimes(10);
    const controller = new AbortController();
    driver.stat.mockImplementation(async () => { controller.abort(); return { isFile: true, size: 42 }; });
    expect(await loadRecentAssets(scope, controller.signal)).toEqual([]);
    expect(await db.getRecentAssetUsage()).toHaveLength(10);
  });

  it('Store Action 只在事务保存成功后更新刷新标识，记录失败不影响业务', async () => {
    const db = await import('../../src/services/indexedDbService');
    const { createUISlice } = await import('../../src/store/store.ui');
    const store = createStore<AppState>()((set, get, api) => createUISlice(set, get, api) as AppState);
    await db.putAssetIndex(index('asset'));
    expect(await store.getState().markAssetUsed({ path: '/global/file/asset.png' })).toBe(true);
    expect(store.getState().recentAssetsRevision).toBe(1);
    expect(await store.getState().markAssetUsed({ path: 'virtual://image' })).toBe(false);
    expect(store.getState().recentAssetsRevision).toBe(1);
    store.getState().setAssetsPanelOpen(true, 'modal', { tab: 'permanent', folder: { kind: 'all' } });
    expect(store.getState().assetsPanelRequest?.tab).toBe('permanent');
    store.getState().setAssetsPanelOpen(false); expect(store.getState().assetsPanelRequest).toBeNull();
    vi.stubGlobal('indexedDB', undefined); vi.resetModules();
    const failure = (await import('../../src/store/store.ui')).createUISlice;
    const failedStore = createStore<AppState>()((set, get, api) => failure(set, get, api) as AppState);
    expect(await failedStore.getState().markAssetUsed({ path: '/global/file/asset.png' })).toBe(false);
    expect(failedStore.getState().recentAssetsRevision).toBe(0);
  });
});
