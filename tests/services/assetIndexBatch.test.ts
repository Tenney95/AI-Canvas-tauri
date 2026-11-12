/** 资产批量刷新保留身份、迁移日志、标签与删除保护，并跳过无变化写入。 */
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetIndexRecord } from '../../src/services/indexedDbService';
import type { MediaRelocation } from '../../src/services/indexedDb/mediaRelocations';

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

describe('项目素材的跨平台相对路径', () => {
  it.each([
    { root: '/project/data', path: '/project/data/Image.PNG', relative: 'Image.PNG' },
    { root: '/project/data', path: '/project/DATA/image.png', relative: undefined },
    { root: '/project/data', path: '/project/database/image.png', relative: undefined },
    { root: 'C:/Project/Data', path: 'c:/project/data/Image.PNG', relative: 'Image.PNG' },
    { root: '//Server/Share/Data', path: '//server/share/data/Image.PNG', relative: 'Image.PNG' },
    { root: '//Server/Share/Data', path: '//server/other/data/Image.PNG', relative: undefined },
  ])('$root ← $path', async ({ root, path, relative }) => {
    const { getRelativeAssetPath } = await import('../../src/services/fs/assetIndex');
    expect(getRelativeAssetPath(path, root)).toBe(relative);
  });
});

describe('asset index batch persistence', () => {
  it('reads the relocation journal once after every tombstone check and does not cache across batches', async () => {
    const db = await import('../../src/services/indexedDbService');
    await seed('metadata', [{ id: 'media-relocations', moves: [] }]);
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    const input = ['a', 'b', 'c'].map(record);

    await db.putAssetIndexes(input);

    const journalReads = () => get.mock.calls.flatMap(([key], index) => (
      (get.mock.contexts[index] as IDBObjectStore).name === 'metadata' && key === 'media-relocations' ? [index] : []
    ));
    expect(journalReads()).toHaveLength(1);
    const guards = get.mock.calls.flatMap(([key], index) => (
      typeof key === 'string' && key.startsWith('forgotten-missing-asset:') ? [index] : []
    ));
    expect(guards).toHaveLength(input.length);
    expect(guards.every((index) => index < journalReads()[0])).toBe(true);
    await db.putAssetIndexes(input, { skipUnchanged: true });
    expect(journalReads()).toHaveLength(2);
  });

  it('preserves batch positions and the original write order for repeated identities', async () => {
    const db = await import('../../src/services/indexedDbService');
    const input = [{ ...record('same'), size: 2, fingerprint: '2:1', updatedAt: 2 }, record('other'),
      { ...record('same'), size: 3, fingerprint: '3:1', updatedAt: 3 }];
    const saved = await db.putAssetIndexes(input);
    expect(saved.map((entry) => entry.assetId)).toEqual(['same', 'other', 'same']);
    expect(saved.map((entry) => entry.size)).toEqual([2, 1, 3]);
    expect(await db.getAssetIndexById('same')).toMatchObject({ size: 3, updatedAt: 3 });
  });

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
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    await expect(db.putAssetIndexes([{ ...record('safe'), size: 9 }, record('gone')], {
      skipUnchanged: true, migrateLegacyTags: true,
    })).rejects.toThrow('素材已被清理');
    expect(get.mock.calls.some(([key]) => key === 'media-relocations')).toBe(false);
    expect((await db.getAssetIndexById('safe'))?.size).toBe(1);
  });

  it('applies chained moves without applying node-owned copies to asset indexes and migrates tags from the original path', async () => {
    const db = await import('../../src/services/indexedDbService');
    const input = [record('a'), record('shared')];
    const intermediate = '/assets/intermediate/a.png';
    const final = '/assets/final/a.png';
    const moves: MediaRelocation[] = [
      { projectId: 'project', oldPath: input[0].path, newPath: intermediate,
        relativePath: 'intermediate/a.png', assetUrl: 'asset://intermediate' },
      { projectId: 'project', oldPath: intermediate, newPath: final,
        relativePath: 'final/a.png', assetUrl: 'asset://final' },
      { projectId: 'project', oldPath: input[1].path, newPath: '/assets/node-copy/shared.png',
        relativePath: 'node-copy/shared.png', assetUrl: 'asset://copy', ownerId: 'node-one' },
    ];
    await seed('metadata', [{ id: 'media-relocations', moves }]);
    await seed('assetMeta', [{ path: input[0].path, tags: ['原路径标签'], updatedAt: 1 },
      { path: final, tags: ['不能借用新路径标签'], updatedAt: 2 }]);

    const saved = await db.putAssetIndexes(input, { migrateLegacyTags: true });

    expect(saved.map((entry) => entry.path)).toEqual([final, input[1].path]);
    expect(await db.getAssetIndexById('a')).toMatchObject({ path: final, relativePath: 'final/a.png' });
    expect(await db.getAssetIndexById('shared')).toMatchObject({ path: input[1].path });
    expect((await db.getAssetMetaById('a'))?.tags).toEqual(['原路径标签']);
    expect(input.map((entry) => entry.path)).toEqual(['/assets/a.png', '/assets/shared.png']);
  });

  it('rolls back indexes and tag migration if a batch write is aborted', async () => {
    const db = await import('../../src/services/indexedDbService');
    await db.putAssetIndexes([record('a'), record('b')]);
    await seed('assetMeta', ['a', 'b'].map((id) => ({ path: record(id).path, tags: ['旧标签'], updatedAt: 1 })));
    const originalPut = IDBObjectStore.prototype.put;
    let scheduled = false;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, value, key);
      if (this.name === 'assetIndex' && !scheduled) {
        scheduled = true;
        request.addEventListener('success', () => queueMicrotask(() => request.transaction?.abort()), { once: true });
      }
      return request;
    });
    await expect(db.putAssetIndexes(['a', 'b'].map((id) => ({ ...record(id), size: 9 })), {
      migrateLegacyTags: true,
    })).rejects.toThrow('文件引用写入事务失败');
    put.mockRestore();
    expect((await db.getAssetIndexById('a'))?.size).toBe(1);
    expect((await db.getAssetIndexById('b'))?.size).toBe(1);
    expect(await db.getAssetMetaById('a')).toBeUndefined();
    expect(await db.getAssetMetaById('b')).toBeUndefined();
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
