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
  it('外部精确路径和后台索引刷新均保留已经核验的项目归属', async () => {
    const db = await import('../../src/services/indexedDbService');
    const { identifyAsset, identifyAssetBatch } = await import('../../src/services/fs/assetIndex');
    const existing = record('project-media');
    const external = { source: 'folder' as const, rootPath: 'D:', size: 1, mtimeMs: 1 };
    await db.putAssetIndex(existing);
    expect(await identifyAsset(existing.path, external)).toEqual(existing);
    expect(await identifyAssetBatch([{ path: existing.path, options: external }])).toEqual([existing]);
    // 已进入落盘队列的旧外部快照，也不能覆盖同路径的更新归属。
    expect(await db.putAssetIndexes([{ ...existing, ...external, projectId: undefined }], { preserveProjectOwnership: true }))
      .toEqual([existing]);
  });

  it('没有提供素材根的项目刷新保留同一路径已登记的素材根和分集', async () => {
    const db = await import('../../src/services/indexedDbService');
    const { identifyAsset } = await import('../../src/services/fs/assetIndex');
    const nestedRoot = `${root}/nested`;
    const existing = { ...record('project-media', `${nestedRoot}/current.png`),
      projectId: 'canvas', rootPath: nestedRoot, relativePath: 'current.png' };
    await db.putAssetIndex(existing);

    expect(await identifyAsset(existing.path, { source: 'project', projectId: 'canvas' })).toEqual(existing);
    expect(await db.putAssetIndexes([{ ...existing, projectId: undefined, rootPath: undefined, relativePath: undefined }],
      { preserveProjectOwnership: true, skipUnchanged: true })).toEqual([existing]);
  });

  it('严格扫描补齐当前作品的缺失素材根，后续文件仍可读取且重复扫描保留身份', async () => {
    const projectId = 'p2-11111111-1111-4111-8111-111111111111';
    const core = await import('../../src/services/fs/core');
    vi.spyOn(core, 'getNativeProjectOwner').mockReturnValue(projectId);
    vi.spyOn(core, 'getProjectDataDir').mockResolvedValue(root);
    const db = await import('../../src/services/indexedDbService');
    const missingRoot: AssetIndexRecord = { ...record('project-media'), projectId, rootPath: undefined, relativePath: undefined,
      size: 1234, fingerprint: '1234:1', contentDigest: 'a'.repeat(64), lastUsedAt: 123, status: 'offline' };
    await db.putAssetIndex(missingRoot);
    files(['script.md', 'current.png', 'another.png']);
    fs.stat.mockImplementation(async (path: string) => ({ size: path === currentPath ? 1234 : 1, mtime: new Date(1) }));
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');
    const options = { source: 'project' as const, projectId, projectIdentityScope: [projectId], preserveProjectIdentity: true };

    const result = await scanDirectoryFiles(root, options);

    expect(result.complete).toBe(true);
    expect(result.files.map((file) => file.name)).toEqual(['script.md', 'current.png', 'another.png']);
    expect(result.files[1]).toMatchObject({ assetId: missingRoot.assetId, ownerProjectId: projectId,
      relativePath: 'current.png', size: 1234 });
    expect(await db.getAssetIndexById(missingRoot.assetId)).toMatchObject({ ...missingRoot, rootPath: root,
      relativePath: 'current.png', status: 'online', updatedAt: expect.any(Number) });
    expect((await scanDirectoryFiles(root, options)).files).toEqual(result.files);
  });

  it('补齐素材根的旧扫描结果不能覆盖同一文件后来登记的嵌套根', async () => {
    const db = await import('../../src/services/indexedDbService');
    const nestedRoot = `${root}/nested`;
    const stale = record('project-media', `${nestedRoot}/current.png`);
    const current = { ...stale, rootPath: nestedRoot, relativePath: 'current.png', lastUsedAt: 456 };
    await db.putAssetIndex(current);

    await expect(db.putAssetIndexes([stale], { repairMissingProjectLocation: true })).rejects.toThrow('资产身份已变化');
    expect(await db.getAssetIndexById(current.assetId)).toEqual(current);
  });

  it.each([{ size: 2, fingerprint: '2:1' }, { mtimeMs: 2, fingerprint: '1:2' }])(
    '索引在补齐事务前已刷新时拒绝过期文件证据 %o', async (changed) => {
      const db = await import('../../src/services/indexedDbService');
      const snapshot = record('project-media');
      const current = { ...snapshot, rootPath: undefined, relativePath: undefined, ...changed };
      await db.putAssetIndex(current);

      await expect(db.putAssetIndexes([snapshot], { repairMissingProjectLocation: true })).rejects.toThrow('资产身份已变化');
      expect(await db.getAssetIndexById(snapshot.assetId)).toEqual(current);
    },
  );

  it('同一路径的补齐事务保留最新摘要和使用时间，重复提交得到同一索引', async () => {
    const db = await import('../../src/services/indexedDbService');
    const snapshot = record('project-media');
    const latest = { contentDigest: 'b'.repeat(64), lastUsedAt: 456 };
    await db.putAssetIndex({ ...snapshot, ...latest, relativePath: undefined });
    const expected = { ...snapshot, ...latest };

    await expect(db.putAssetIndexes([snapshot], { repairMissingProjectLocation: true })).resolves.toEqual([expected]);
    await expect(db.putAssetIndexes([snapshot], { repairMissingProjectLocation: true })).resolves.toEqual([expected]);
  });

  it.each([
    { projectId: 'p2-11111111-1111-4111-8111-111111111111', rootPath: 'D:/another', relativePath: 'current.png',
      reason: '项目文件的素材根与当前项目不一致' },
    { projectId: 'p2-22222222-2222-4222-8222-222222222222', rootPath: undefined, relativePath: undefined,
      reason: '项目文件包含其他来源的资产身份' },
  ])('严格扫描拒绝改写有冲突的素材归属（$reason）', async ({ reason, ...location }) => {
    const projectId = 'p2-11111111-1111-4111-8111-111111111111';
    const core = await import('../../src/services/fs/core');
    vi.spyOn(core, 'getNativeProjectOwner').mockReturnValue(projectId);
    vi.spyOn(core, 'getProjectDataDir').mockResolvedValue(root);
    const db = await import('../../src/services/indexedDbService');
    const existing = { ...record('project-media'), ...location };
    await db.putAssetIndex(existing);
    files(['current.png']);
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');

    await expect(scanDirectoryFiles(root, { source: 'project', projectId,
      projectIdentityScope: [projectId], preserveProjectIdentity: true })).rejects.toThrow(reason);
    expect(await db.getAssetIndexById(existing.assetId)).toEqual(existing);
  });

  it('按原生绑定精确修复路径已被外部扫描重新登记的记录', async () => {
    const projectId = 'p2-11111111-1111-4111-8111-111111111111';
    const core = await import('../../src/services/fs/core');
    vi.spyOn(core, 'getNativeProjectOwner').mockReturnValue(projectId);
    vi.spyOn(core, 'getProjectDataDir').mockResolvedValue(root);
    const db = await import('../../src/services/indexedDbService');
    const external: AssetIndexRecord = { ...record('project-media'), source: 'folder', projectId: undefined,
      rootPath: 'D:/', relativePath: 'project/current.png', lastUsedAt: 123 };
    await db.putAssetIndex(external);
    files(['current.png']);
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');
    const result = await scanDirectoryFiles(root, { source: 'project', projectId, projectIdentityScope: [projectId] });
    expect(result.files.map(({ assetId }) => assetId)).toEqual([external.assetId]);
    expect(await db.getAssetIndexById(external.assetId)).toMatchObject({ source: 'project', projectId, rootPath: root,
      relativePath: 'current.png', lastUsedAt: 123 });
  });

  it('在扫描和索引前跳过项目根的 Agent 内部文件，保留其他脚本和同名素材目录', async () => {
    const db = await import('../../src/services/indexedDbService');
    const file = (name: string) => ({ name, isFile: true, isDirectory: false, isSymlink: false });
    const folder = (name: string) => ({ name, isFile: false, isDirectory: true, isSymlink: false });
    fs.readDir.mockImplementation(async (directory: string) => {
      if (directory === root) return [folder('.agent-workspace'), folder('agent-results'), folder('agent-teams'),
        folder('assets'), file('_verify_v215.py'), file('user.py')];
      if (directory === `${root}/assets`) return [folder('.agent-workspace'), folder('agent-results'), file('_verify_v215.py')];
      if (directory === `${root}/assets/agent-results`) return [file('story.md')];
      throw new Error('unexpected directory');
    });
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');
    const streamed: string[] = [];

    const result = await scanDirectoryFiles(root, { source: 'project', projectId: 'project',
      onFiles: (batch) => streamed.push(...batch.map((entry) => entry.relativePath!)) });

    const visible = ['user.py', 'assets/_verify_v215.py', 'assets/agent-results/story.md'];
    expect(result.complete).toBe(true);
    expect(result.files.map((entry) => entry.relativePath)).toEqual(visible);
    expect(streamed).toEqual(visible);
    expect(result.folders.map((entry) => entry.relativePath)).toEqual(['', 'assets', 'assets/agent-results']);
    expect(fs.stat).not.toHaveBeenCalledWith(`${root}/_verify_v215.py`);
    expect(await db.getAssetIndexByPath(`${root}/_verify_v215.py`)).toBeUndefined();
  });

  it('v4 导入路径保留旧 Agent 文件的隐藏规则', async () => {
    const prefix = `${root}/roots/r2-11111111-1111-4111-8111-111111111111/imports/copy-root-1`;
    const dir = (name: string) => ({ name, isFile: false, isDirectory: true, isSymlink: false });
    const file = (name: string) => ({ name, isFile: true, isDirectory: false, isSymlink: false });
    fs.readDir.mockImplementation(async (directory: string) => {
      if (directory === root) return [dir('roots')];
      if (directory === `${root}/roots`) return [dir('r2-11111111-1111-4111-8111-111111111111')];
      if (directory === `${root}/roots/r2-11111111-1111-4111-8111-111111111111`) return [dir('imports')];
      if (directory === prefix.slice(0, prefix.lastIndexOf('/'))) return [dir('copy-root-1')];
      if (directory === prefix) return [dir('agent-teams'), file('_sync_docs_v215.py'), file('notes.md')];
      throw new Error('unexpected directory');
    });
    const { scanDirectoryFiles } = await import('../../src/services/fs/assetLibrary');
    const result = await scanDirectoryFiles(root, { source: 'project', projectId: 'project' });
    expect(result.complete).toBe(true);
    expect(result.files.map((entry) => entry.name)).toEqual(['notes.md']);
    expect(fs.readDir).not.toHaveBeenCalledWith(`${prefix}/agent-teams`);
  });

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
