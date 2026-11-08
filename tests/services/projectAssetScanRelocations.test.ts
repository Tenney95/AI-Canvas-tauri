/** 项目扫描不把分组迁移留下的退役副本重新登记为新身份。 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetIndexRecord } from '../../src/services/indexedDbService';
import type { MediaRelocation } from '../../src/services/indexedDb/mediaRelocations';

const fs = vi.hoisted(() => ({ readDir: vi.fn(), stat: vi.fn(), exists: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/plugin-fs')>(),
  readDir: fs.readDir, stat: fs.stat, exists: fs.exists,
}));
vi.mock('../../src/services/fs/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fs/core')>(),
  isTauriEnv: () => true,
  getConvertFileSrc: () => (path: string) => `asset://${path}`,
}));
vi.mock('../../src/services/fs/trash', () => ({ moveToTrash: vi.fn() }));

const root = 'D:/project';
const oldPath = `${root}/old.png`;
const currentPath = `${root}/current.png`;
const relocation: MediaRelocation = {
  projectId: 'project', oldPath: 'D:\\PROJECT\\old.png', newPath: currentPath,
  assetUrl: 'asset://current', relativePath: 'current.png',
};
const record = (assetId: string, path = currentPath): AssetIndexRecord => ({
  assetId, path, rootPath: root, relativePath: path.slice(root.length + 1), projectId: 'project',
  source: 'project', fingerprint: '1:1', size: 1, mtimeMs: 1, status: 'online', updatedAt: 1,
});

async function seed(store: string, values: unknown[]): Promise<void> {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    for (const value of values) tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function files(names: string[]): void {
  fs.readDir.mockResolvedValue(names.map((name) => ({ name, isFile: true, isDirectory: false, isSymlink: false })));
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  fs.readDir.mockReset();
  fs.stat.mockReset().mockResolvedValue({ size: 1, mtime: new Date(1) });
  fs.exists.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('project asset scans with committed group relocations', () => {
  it('扫描嵌套素材根时保留已有分集与素材根身份', async () => {
    const db = await import('../../src/services/indexedDbService');
    const nestedRoot = `${root}/roots/r2-extra`;
    const path = `${nestedRoot}/image.png`;
    await db.putAssetIndex({ ...record('nested-asset', path), rootPath: nestedRoot,
      relativePath: 'image.png', projectId: 'canvas' });
    fs.readDir.mockImplementation(async (directory: string) => {
      if (directory === root) return [{ name: 'roots', isFile: false, isDirectory: true, isSymlink: false }];
      if (directory === `${root}/roots`) return [{ name: 'r2-extra', isFile: false, isDirectory: true, isSymlink: false }];
      if (directory === nestedRoot) return [{ name: 'image.png', isFile: true, isDirectory: false, isSymlink: false }];
      throw new Error('unexpected directory');
    });
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');
    const result = await scanDirectoryFiles(root, { source: 'project', projectId: 'project',
      projectIdentityScope: ['project', 'canvas'], preserveProjectIdentity: true });
    expect(result.complete).toBe(true);
    expect(result.files[0]).toMatchObject({ assetId: 'nested-asset', relativePath: 'image.png' });
    expect(await db.getAssetIndexById('nested-asset')).toMatchObject({ projectId: 'canvas', rootPath: nestedRoot, relativePath: 'image.png' });
  });

  it.each([
    { strict: false, directory: root },
    { strict: true, directory: root },
    { strict: false, directory: 'D:\\project' },
    { strict: true, directory: '\\\\?\\D:\\project' },
  ])('skips an unindexed retired copy before stat and identity writes ($directory, strict=$strict)', async ({ strict, directory }) => {
    const db = await import('../../src/services/indexedDbService');
    const current = record('current-identity');
    await db.putAssetIndex(current);
    // moves 已完成仍保留；旧副本真实存在，目标路径仍由原身份占用。
    await seed('metadata', [{ id: 'media-relocations', moves: [relocation], pending: [] }]);
    const names = ['current.png', ...Array.from({ length: 12 }, (_, index) => `file-${index}.png`), 'old.png'];
    files(names);
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');
    const options = { source: 'project' as const, projectId: 'project', ...(strict ? { projectIdentityScope: ['project'] } : {}) };

    const result = await scanDirectoryFiles(directory, options);
    const repeated = await scanDirectoryFiles(directory, options);

    expect(result.complete).toBe(true);
    expect(result.files.map((file) => file.path)).toEqual(names.slice(0, -1).map((name) => `${root}/${name}`));
    expect(repeated.files.map((file) => file.assetId)).toEqual(result.files.map((file) => file.assetId));
    expect(fs.stat).not.toHaveBeenCalledWith(oldPath);
    expect(await db.getAssetIndexByPath(oldPath)).toBeUndefined();
    expect(await db.getAssetIndexById(current.assetId)).toMatchObject({
      assetId: current.assetId, path: current.path, source: current.source, projectId: current.projectId,
    });
    expect(await db.getAllAssetIndexes()).toHaveLength(names.length - 1);
  });

  it.each([false, true])('keeps a retired source that still owns an exact identity after shared splitting (strict=%s)', async (strict) => {
    const db = await import('../../src/services/indexedDbService');
    await db.putAssetIndexes([record('source-identity', oldPath), record('copy-identity')]);
    await seed('metadata', [{ id: 'media-relocations', moves: [{ ...relocation, ownerId: 'grouped-node' }], pending: [] }]);
    files(['old.png', 'current.png']);
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');

    const result = await scanDirectoryFiles(root, { source: 'project', projectId: 'project',
      ...(strict ? { projectIdentityScope: ['project'] } : {}) });

    expect(result.complete).toBe(true);
    expect(result.files.map((file) => [file.path, file.assetId])).toEqual([
      [oldPath, 'source-identity'], [currentPath, 'copy-identity'],
    ]);
    expect(await db.getAllAssetIndexes()).toHaveLength(2);
    expect((await db.getAssetIndexById('source-identity'))?.path).toBe(oldPath);
  });

  it.each([false, true])('keeps a shared retired identity through Windows case aliases without allocating a new ID (strict=%s)', async (strict) => {
    const db = await import('../../src/services/indexedDbService');
    // 把旧源放到第二批，ordinary 分支也必须覆盖 identifyAssetBatch 的规范路径。
    const known = Array.from({ length: 12 }, (_, index) => record(`known-${index}`, `D:/PROJECT/known-${index}.png`));
    const initial = [record('source-identity', oldPath), record('copy-identity'), ...known];
    await db.putAssetIndexes(initial);
    await seed('metadata', [{ id: 'media-relocations', moves: [
      { ...relocation, ownerId: 'grouped-node' },
      { ...relocation, oldPath: `${root}/abandoned.png` },
    ], pending: [] }]);
    files([...known.map((entry) => entry.relativePath!), 'old.png', 'abandoned.png']);
    const allIndexes = vi.spyOn(db, 'getAllAssetIndexes');
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');

    const result = await scanDirectoryFiles('D:/PROJECT', { source: 'project', projectId: 'project',
      ...(strict ? { projectIdentityScope: ['project'] } : {}) });

    expect(result.complete).toBe(true);
    expect(result.files.find((file) => file.name === 'old.png')).toMatchObject({ path: oldPath, assetId: 'source-identity' });
    expect(result.files).toHaveLength(known.length + 1);
    expect(fs.stat).toHaveBeenCalledWith(oldPath);
    expect(fs.stat).not.toHaveBeenCalledWith('D:/PROJECT/old.png');
    // 两个退役路径精确 miss 也只懒加载一次，正常旧副本继续跳过。
    expect(allIndexes).toHaveBeenCalledOnce();
    allIndexes.mockRestore();
    expect(await db.getAssetIndexByPath('D:/PROJECT/old.png')).toBeUndefined();
    expect((await db.getAssetIndexById('source-identity'))?.path).toBe(oldPath);
    expect((await db.getAllAssetIndexes()).map((entry) => entry.assetId).sort()).toEqual(initial.map((entry) => entry.assetId).sort());
  });

  it('rejects ambiguous Windows path identities instead of choosing or creating one', async () => {
    const db = await import('../../src/services/indexedDbService');
    const indexes = [record('first-identity', oldPath), record('second-identity', 'D:/Project/old.png')];
    await db.putAssetIndexes(indexes);
    await seed('metadata', [{ id: 'media-relocations', moves: [{ ...relocation, ownerId: 'grouped-node' }], pending: [] }]);
    files(['old.png']);
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');

    await expect(scanDirectoryFiles('D:/PROJECT', { source: 'project', projectId: 'project' }))
      .rejects.toThrow('项目文件资产身份存在歧义，请先修复');
    expect(fs.stat).not.toHaveBeenCalled();
    expect(await db.getAllAssetIndexes()).toEqual(indexes);
  });

  it.each([false, true])('does not adopt an external asset through a retired Windows path alias (strict=%s)', async (strict) => {
    const db = await import('../../src/services/indexedDbService');
    const external: AssetIndexRecord = { ...record('external-identity', oldPath), source: 'folder', projectId: undefined };
    await db.putAssetIndex(external);
    await seed('metadata', [{ id: 'media-relocations', moves: [relocation], pending: [] }]);
    files(['old.png']);
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');

    await expect(scanDirectoryFiles('D:/PROJECT', { source: 'project', projectId: 'project',
      ...(strict ? { projectIdentityScope: ['project'] } : {}) }))
      .rejects.toThrow('项目文件包含其他来源的资产身份');
    expect(fs.stat).not.toHaveBeenCalled();
    expect(await db.getAssetIndexById(external.assetId)).toEqual(external);
    expect(await db.getAllAssetIndexes()).toHaveLength(1);
  });

  it.each([false, true])('ignores a leftover source after the destination group was deleted without recreating its identity (strict=%s)', async (strict) => {
    const db = await import('../../src/services/indexedDbService');
    const destination = `${root}/deleted-group/current.png`;
    const current = record('deleted-destination-identity', destination);
    await db.putAssetIndex(current);
    await seed('metadata', [{ id: 'media-relocations', moves: [{ ...relocation,
      newPath: destination, relativePath: 'deleted-group/current.png' }], pending: [] }]);
    // 目标分组/文件已不在磁盘枚举中；仅旧副本残留，已完成迁移及目标索引仍保留。
    files(['old.png']);
    fs.stat.mockImplementation(async (path: string) => {
      if (path === destination) throw new Error('ENOENT');
      return { size: 1, mtime: new Date(1) };
    });
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');

    const result = await scanDirectoryFiles(root, { source: 'project', projectId: 'project',
      ...(strict ? { projectIdentityScope: ['project'] } : {}) });

    expect(result.complete).toBe(true);
    expect(result.files).toEqual([]);
    expect(fs.stat).not.toHaveBeenCalled();
    expect(await db.getAssetIndexByPath(oldPath)).toBeUndefined();
    expect(await db.getAssetIndexById(current.assetId)).toEqual(current);
    expect(await db.getAllAssetIndexes()).toEqual([current]);
  });

  it('stops before stat or registration when cancelled during a retired identity lookup', async () => {
    await seed('metadata', [{ id: 'media-relocations', moves: [relocation], pending: [] }]);
    files(['old.png']);
    const controller = new AbortController();
    const db = await import('../../src/services/indexedDbService');
    vi.spyOn(db, 'getAssetIndexByPath').mockImplementationOnce(async () => {
      controller.abort();
      return undefined;
    });
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');

    await expect(scanDirectoryFiles(root, { source: 'project', projectId: 'project', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.stat).not.toHaveBeenCalled();
    expect(await db.getAllAssetIndexes()).toHaveLength(0);
  });

  it('stops before stat or registration when cancelled while loading Windows path aliases', async () => {
    const db = await import('../../src/services/indexedDbService');
    await db.putAssetIndex(record('source-identity', oldPath));
    await seed('metadata', [{ id: 'media-relocations', moves: [{ ...relocation, ownerId: 'grouped-node' }], pending: [] }]);
    files(['old.png']);
    const controller = new AbortController();
    const readIndexes = db.getAllAssetIndexes;
    vi.spyOn(db, 'getAllAssetIndexes').mockImplementationOnce(async () => {
      const indexes = await readIndexes();
      controller.abort();
      return indexes;
    });
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');

    await expect(scanDirectoryFiles('D:/PROJECT', { source: 'project', projectId: 'project', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.stat).not.toHaveBeenCalled();
    expect(await db.getAllAssetIndexes()).toHaveLength(1);
  });

  it('fails closed before scanning when the persisted relocation journal is malformed', async () => {
    await seed('metadata', [{ id: 'media-relocations', moves: [{}], pending: [] }]);
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');

    await expect(scanDirectoryFiles(root, { source: 'project', projectId: 'project' })).rejects.toThrow('文件引用迁移记录损坏');
    expect(fs.readDir).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
  });
});
