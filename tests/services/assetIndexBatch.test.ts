/** 资产批量刷新保留身份、迁移日志、标签与删除保护，并跳过无变化写入。 */
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetIndexRecord } from '../../src/services/indexedDbService';

const fs = vi.hoisted(() => ({ stat: vi.fn(), exists: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', async (original) => ({
  ...await original<typeof import('@tauri-apps/plugin-fs')>(), stat: fs.stat, exists: fs.exists,
}));
vi.mock('../../src/services/fs/assetImageMetadata', () => ({
  fingerprintAssetImage: async () => ({ digest: 'a'.repeat(64) }),
}));

const record = (assetId: string): AssetIndexRecord => ({
  assetId, path: `/assets/${assetId}.png`, rootPath: '/assets', relativePath: `${assetId}.png`,
  source: 'global', fingerprint: '1:1', size: 1, mtimeMs: 1, status: 'online', updatedAt: 1,
});
async function seed(store: string, values: unknown[]) {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    for (const value of values) tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  fs.stat.mockReset().mockResolvedValue({ size: 1, mtime: new Date(1) });
  fs.exists.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('asset index batch persistence', () => {
  it('skips unchanged writes after merging latest usage and digest, but persists real changes', async () => {
    const db = await import('../../src/services/indexedDbService');
    const initial = { ...record('a'), lastUsedAt: 20, contentDigest: 'a'.repeat(64) };
    await db.putAssetIndex(initial);
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const saved = await db.putAssetIndexes([{ ...record('a'), updatedAt: 99 }], { skipUnchanged: true, migrateLegacyTags: true });
    expect(put).not.toHaveBeenCalled();
    expect(saved).toEqual([initial]);
    expect(await db.getAssetIndexesByPaths([initial.path, '/missing'])).toEqual([initial, undefined]);
    await db.putAssetIndexes([{ ...record('a'), size: 2, fingerprint: '2:1', updatedAt: 100 }], { skipUnchanged: true });
    expect(await db.getAssetIndexById('a')).toMatchObject({ size: 2, lastUsedAt: 20, updatedAt: 100 });
    expect((await db.getAssetIndexById('a'))?.contentDigest).toBeUndefined();
  });

  it('migrates missing legacy tags without overwriting existing manual or cleared tags', async () => {
    const db = await import('../../src/services/indexedDbService');
    await seed('assetMeta', ['manual', 'empty', 'new'].map((id) => ({ path: record(id).path, tags: ['旧标签'], updatedAt: 1 })));
    await db.putAssetMeta({ assetId: 'manual', tags: ['新标签'], updatedAt: 2 });
    await db.putAssetMeta({ assetId: 'empty', tags: [], updatedAt: 2 });
    await db.putAssetIndexes(['manual', 'empty', 'new'].map(record), { skipUnchanged: true, migrateLegacyTags: true });
    expect((await db.getAssetMetaById('manual'))?.tags).toEqual(['新标签']);
    expect((await db.getAssetMetaById('empty'))?.tags).toEqual([]);
    expect((await db.getAssetMetaById('new'))?.tags).toEqual(['旧标签']);
  });

  it('checks tombstones even for unchanged records and rolls back the entire batch on failure', async () => {
    const db = await import('../../src/services/indexedDbService');
    await db.putAssetIndexes([record('safe'), record('gone')]);
    await seed('metadata', [{ id: 'forgotten-missing-asset:gone', forgottenAt: 2 }]);
    await expect(db.putAssetIndexes([{ ...record('safe'), size: 9 }, record('gone')], {
      skipUnchanged: true, migrateLegacyTags: true,
    })).rejects.toThrow('素材已被清理');
    expect((await db.getAssetIndexById('safe'))?.size).toBe(1);
  });

  it('still applies a committed relocation to stale scan records inside the batch', async () => {
    const db = await import('../../src/services/indexedDbService');
    const stale = record('a');
    await db.putAssetIndex(stale);
    await seed('metadata', [{ id: 'media-relocations', moves: [{
      projectId: 'project', oldPath: stale.path, newPath: '/assets/moved/a.png',
      assetUrl: 'asset://moved', relativePath: 'moved/a.png',
      assetMove: { assetId: 'a', source: 'global', rootPath: '/assets', totalBytes: 1, mtimeMs: 1, digest: 'a'.repeat(64) },
    }] }]);
    await db.putAssetIndexes([stale], { skipUnchanged: true });
    expect((await db.getAssetIndexById('a'))?.path).toBe('/assets/moved/a.png');
  });

  it('does not assign one missing identity to two new files in the same scan batch', async () => {
    const db = await import('../../src/services/indexedDbService');
    await db.putAssetIndex({ ...record('old'), contentDigest: 'a'.repeat(64) });
    fs.stat.mockImplementation(async (path: string) => {
      if (path === record('old').path) throw new Error('ENOENT');
      return { size: 1, mtime: new Date(1) };
    });
    const { identifyAssetBatch } = await import('../../src/services/fs/assetIndex');
    const results = await identifyAssetBatch(['/assets/one.png', '/assets/two.png'].map((path) => ({
      path, options: { rootPath: '/assets', source: 'global' as const, size: 1, mtimeMs: 1 },
    })));
    expect(results[0].assetId).toBe('old');
    expect(results[1].assetId).not.toBe('old');
    expect((await db.getAssetIndexById('old'))?.path).toBe('/assets/one.png');
  });
});


it('rejects a stale known-identity batch after the identity moves to another path', async () => {
  const db = await import('../../src/services/indexedDbService');
  await db.putAssetIndex({ ...record('a'), path: '/assets/new.png' });
  await expect(db.putAssetIndexes([record('a')], {
    skipUnchanged: true, requireExistingPath: true,
  })).rejects.toThrow('资产身份已变化');
  expect((await db.getAssetIndexById('a'))?.path).toBe('/assets/new.png');
});
