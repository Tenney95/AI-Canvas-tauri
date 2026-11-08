/**
 * storageHealth — 回归测试：storage health accounting and cleanup。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasProject } from '../../src/types';

const mocks = vi.hoisted(() => ({
  directories: new Map<string, string[]>(),
  sizes: new Map<string, number>(),
  digests: new Map<string, string>(),
  roots: new Map<string, string>(),
  exists: vi.fn(),
  readDir: vi.fn(),
  lstat: vi.fn(),
  stat: vi.fn(),
  remove: vi.fn(),
  fingerprintAssetImage: vi.fn(),
  getAllProjects: vi.fn(),
  getProjectById: vi.fn(),
  getHistoryEntriesPage: vi.fn(),
  getProjectConversations: vi.fn(),
  getConversationMessages: vi.fn(),
  listProjectImportRecoveries: vi.fn(),
  openDB: vi.fn(),
  assertLegacyProjectWritesAllowed: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: mocks.readDir,
  lstat: mocks.lstat,
  stat: mocks.stat,
  remove: mocks.remove,
  exists: mocks.exists,
}));
vi.mock('../../src/services/fs/core', () => ({
  isTauriEnv: () => true,
  joinPath: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
  getProjectDataDir: async (id: string) => mocks.roots.get(id) ?? `/${id}`,
}));
vi.mock('../../src/services/fs/assetImageMetadata', () => ({
  fingerprintAssetImage: mocks.fingerprintAssetImage,
}));
vi.mock('../../src/services/indexedDbService', () => ({
  getAllProjects: mocks.getAllProjects,
  getProjectById: mocks.getProjectById,
  getHistoryEntriesPage: mocks.getHistoryEntriesPage,
  getProjectConversations: mocks.getProjectConversations,
  getConversationMessages: mocks.getConversationMessages,
}));
vi.mock('../../src/services/indexedDb/projectImportRepository', () => ({ listProjectImportRecoveries: mocks.listProjectImportRecoveries }));
vi.mock('../../src/services/indexedDb/schema', () => ({ openDB: mocks.openDB }));
vi.mock('../../src/services/indexedDb/legacyProjectWriteGuard', () => ({ assertLegacyProjectWritesAllowed: mocks.assertLegacyProjectWritesAllowed }));

import { clearTrashDir, collectNodeFilePaths, deleteOrphanFile, prepareTrashCleanup, scanStorageHealth } from '../../src/services/fs/storageHealth';

function project(id: string): CanvasProject {
  return { id, name: id, createdAt: 1, updatedAt: 1 };
}

function addFiles(root: string, entries: Record<string, number>): void {
  mocks.directories.set(root, Object.keys(entries));
  for (const [name, size] of Object.entries(entries)) mocks.sizes.set(`${root}/${name}`, size);
}

describe('storage health accounting and cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.directories.clear();
    mocks.sizes.clear();
    mocks.digests.clear();
    mocks.roots.clear();
    mocks.exists.mockImplementation(async (path: string) => mocks.directories.has(path) || mocks.sizes.has(path));
    mocks.getAllProjects.mockResolvedValue([]);
    mocks.getProjectById.mockImplementation(async (id: string) => ({ ...project(id), nodes: [] }));
    mocks.getHistoryEntriesPage.mockResolvedValue({ records: [], hasMore: false });
    mocks.getProjectConversations.mockResolvedValue([]);
    mocks.getConversationMessages.mockResolvedValue({ messages: [], total: 0 });
    mocks.listProjectImportRecoveries.mockResolvedValue([]);
    mocks.openDB.mockResolvedValue({});
    mocks.assertLegacyProjectWritesAllowed.mockReset().mockResolvedValue(undefined);
    mocks.readDir.mockImplementation(async (path: string) => {
      const entries = mocks.directories.get(path);
      if (!entries) throw new Error('directory unavailable');
      return entries.map((name) => ({
        name,
        isDirectory: mocks.directories.has(`${path}/${name}`),
        isFile: mocks.sizes.has(`${path}/${name}`),
        isSymlink: false,
      }));
    });
    const fileInfo = async (path: string) => {
      const directory = mocks.directories.has(path);
      if (!directory && !mocks.sizes.has(path)) throw new Error('file unavailable');
      return { isDirectory: directory, isFile: !directory, isSymlink: false,
        size: mocks.sizes.get(path) ?? 0, mtime: new Date(0) };
    };
    mocks.lstat.mockImplementation(fileInfo);
    mocks.stat.mockImplementation(fileInfo);
    mocks.fingerprintAssetImage.mockImplementation(async (path: string) => ({
      digest: mocks.digests.get(path) ?? 'f'.repeat(64),
      bytes: mocks.sizes.get(path) ?? 0,
    }));
    mocks.remove.mockImplementation(async (path: string) => {
      if (mocks.directories.has(path)) {
        const prefix = `${path}/`;
        if ([...mocks.sizes.keys(), ...mocks.directories.keys()].some((entry) => entry.startsWith(prefix))) {
          throw new Error('directory not empty');
        }
        mocks.directories.delete(path);
      } else {
        mocks.sizes.delete(path);
      }
    });
  });

  it('迁移冻结或模型切换时，不扫描为可清理结果，也不删除孤儿文件或回收站', async () => {
    addFiles('/a', { 'orphan.png': 10 });
    mocks.directories.set('/a/.trash', ['old.png']);
    mocks.sizes.set('/a/.trash/old.png', 5);
    mocks.assertLegacyProjectWritesAllowed.mockRejectedValue(new Error('项目模型状态已改变'));
    await expect(scanStorageHealth([project('a')], new Set())).rejects.toThrow('存储引用读取不完整');
    expect(await deleteOrphanFile('/a/orphan.png', async () => true)).toBe(false);
    expect(await clearTrashDir('/a/.trash', async () => true, [{ path: '/a/.trash/old.png', size: 5, digest: 'f'.repeat(64) }])).toMatchObject({ deletedCount: 0, failedCount: 1 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('核对文件后模型发生变化时，删除前再次检查并保留文件', async () => {
    addFiles('/a', { 'orphan.png': 10 });
    const verify = vi.fn(async () => {
      mocks.assertLegacyProjectWritesAllowed.mockRejectedValue(new Error('项目模型状态已改变'));
      return true;
    });
    expect(await deleteOrphanFile('/a/orphan.png', verify)).toBe(false);
    expect(verify).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('keeps recovery media out of orphan and deletable duplicate lists, failing closed on unreadable recovery records', async () => {
    addFiles('/a', { 'current.png': 10, 'recovery.png': 10 });
    mocks.digests.set('/a/current.png', 'a'.repeat(64)); mocks.digests.set('/a/recovery.png', 'a'.repeat(64));
    mocks.listProjectImportRecoveries.mockResolvedValue([{ records: [], assets: [{ path: 'recovery.png', bytes: 10, sha256: 'a'.repeat(64) }] }]);
    const report = await scanStorageHealth([project('a')], new Set(['/a/current.png']));
    expect(report.orphans).toEqual([]);
    expect(report.duplicates.flatMap((group) => group.files).filter((file) => file.canDelete)).toEqual([]);
    mocks.listProjectImportRecoveries.mockRejectedValue(new Error('unavailable'));
    await expect(scanStorageHealth([project('a')], new Set())).rejects.toThrow('存储引用读取不完整');
  });

  it('回收站容量区分引用和可清理文件，涵盖项目、历史、恢复点及实时状态', async () => {
    mocks.directories.set('/a', ['.trash']);
    addFiles('/a/.trash', { 'project.png': 10, 'history.png': 20, 'recovery.png': 30, 'live.png': 40, 'free.png': 50 });
    mocks.getProjectById.mockResolvedValue({ ...project('a'), nodes: [{ data: { filePath: '/a/.trash/project.png' } }] });
    mocks.getHistoryEntriesPage.mockResolvedValue({ records: [{ filePath: '/a/.trash/history.png' }], hasMore: false });
    mocks.listProjectImportRecoveries.mockResolvedValue([{ records: [], assets: [{ path: '.trash/recovery.png', bytes: 30, sha256: 'a'.repeat(64) }] }]);
    const report = await scanStorageHealth([project('a')], new Set(['/a/.trash/live.png']));
    expect(report).toMatchObject({ trashSize: 150, totalSize: 150, reclaimableSize: 50 });
    expect(report.trashes[0]).toMatchObject({ fileCount: 5, trashSize: 150, reclaimableCount: 1, reclaimableSize: 50 });
    expect(report.trashes[0].files.filter((file) => !file.referenced).map((file) => file.path)).toEqual(['/a/.trash/free.png']);
  });

  it('相对图片与导演截图路径在持久项目和实时状态中均保护对应回收站文件', async () => {
    mocks.directories.set('/a', ['.trash']);
    addFiles('/a/.trash', { 'image.png': 10, 'capture.png': 20, 'live.png': 30, 'file.png': 40,
      'image-file.png': 50, 'capture-file.png': 60, 'free.png': 70 });
    mocks.getProjectById.mockResolvedValue({ ...project('a'), nodes: [{ data: {
      imageRelativePath: '.trash/image.png', directorCaptureRelativePaths: ['.trash/capture.png'],
      filePath: '.trash/file.png', imageFilePath: '.trash/image-file.png', directorCaptureFilePaths: ['.trash/capture-file.png'],
    } }] });
    const live = collectNodeFilePaths([{ data: { directorCaptureRelativePaths: ['.trash/live.png'] } }], '/a');
    const report = await scanStorageHealth([project('a')], live);
    expect(report.trashes[0].files.filter((file) => file.referenced).map((file) => file.path))
      .toEqual(['/a/.trash/image.png', '/a/.trash/capture.png', '/a/.trash/live.png', '/a/.trash/file.png',
        '/a/.trash/image-file.png', '/a/.trash/capture-file.png']);
    expect(report.trashes[0]).toMatchObject({ reclaimableCount: 1, reclaimableSize: 70 });
  });

  it('项目相对引用按根目录解析，绝对路径保留原位置且不重复拼接项目根', () => {
    const paths = collectNodeFilePaths([{ data: { imageFilePath: '/other/.trash/absolute.png',
      directorCaptureFilePaths: ['nested/.trash/capture.png', '/other/.trash/absolute-capture.png'] } }], '/a');
    expect(paths).toEqual(new Set(['/other/.trash/absolute.png', '/a/nested/.trash/capture.png', '/other/.trash/absolute-capture.png']));
  });

  it('空文件保留，默认及引用核对扫描不读取回收站摘要，只在准备确认时读取选中非空文件', async () => {
    mocks.directories.set('/a', ['.trash']);
    addFiles('/a/.trash', { 'empty.txt': 0, 'data.txt': 10 });
    const report = await scanStorageHealth([project('a')], new Set());
    expect(report.trashes[0]).toMatchObject({ fileCount: 2, reclaimableCount: 1, reclaimableSize: 10 });
    expect(report.trashes[0].files.find((file) => file.path.endsWith('empty.txt'))?.digest).toBeUndefined();
    expect(mocks.fingerprintAssetImage).not.toHaveBeenCalled();
    const prepared = await prepareTrashCleanup(report.trashes);
    expect(prepared[0].files.find((file) => file.path.endsWith('data.txt'))?.digest).toBe('f'.repeat(64));
    expect(prepared[0].files.find((file) => file.path.endsWith('empty.txt'))?.digest).toBeUndefined();
    expect(mocks.fingerprintAssetImage.mock.calls.map(([path]) => path)).toEqual(['/a/.trash/data.txt']);
    mocks.fingerprintAssetImage.mockClear();
    const fresh = await scanStorageHealth([project('a')], new Set(), [], { includeDuplicates: false });
    expect(fresh.complete).toBe(true);
    expect(mocks.fingerprintAssetImage).not.toHaveBeenCalled();
  });

  it('确认后同大小内容替换时摘要不符，拒绝删除', async () => {
    mocks.directories.set('/a', ['.trash']);
    addFiles('/a/.trash', { 'replaced.png': 10 });
    mocks.digests.set('/a/.trash/replaced.png', 'a'.repeat(64));
    const report = await scanStorageHealth([project('a')], new Set());
    const file = (await prepareTrashCleanup(report.trashes))[0].files[0];
    expect(file.digest).toBe('a'.repeat(64));
    mocks.digests.set('/a/.trash/replaced.png', 'b'.repeat(64));
    const result = await clearTrashDir('/a/.trash', async () => true,
      [{ path: file.path, size: file.size, digest: file.digest! }]);
    expect(result).toEqual({ deletedCount: 0, failedCount: 1, reclaimedSize: 0 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('回收站缺少确认快照或核对回调时失败关闭', async () => {
    addFiles('/a/.trash', { 'file.png': 10 });
    expect(await clearTrashDir('/a/.trash')).toMatchObject({ deletedCount: 0, failedCount: 1 });
    expect(await clearTrashDir('/a/.trash', async () => true)).toMatchObject({ deletedCount: 0, failedCount: 1 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('确认文件或整个回收站消失时计为未清理，遍历失败不重复计数', async () => {
    const confirmed = [{ path: '/a/.trash/missing.png', size: 10, digest: 'f'.repeat(64) }];
    expect(await clearTrashDir('/a/.trash', async () => true, confirmed)).toEqual({ deletedCount: 0, failedCount: 1, reclaimedSize: 0 });
    addFiles('/a/.trash', { 'unselected.png': 5 });
    expect(await clearTrashDir('/a/.trash', async () => true, confirmed)).toEqual({ deletedCount: 0, failedCount: 1, reclaimedSize: 0 });
    mocks.readDir.mockRejectedValueOnce(new Error('permission denied'));
    expect(await clearTrashDir('/a/.trash', async () => true, confirmed)).toEqual({ deletedCount: 0, failedCount: 1, reclaimedSize: 0 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('确认文件被替换为目录时不递归或删除，且计为未清理', async () => {
    mocks.directories.set('/a/.trash', ['old.png']);
    addFiles('/a/.trash/old.png', { 'new.bin': 5 });
    const verify = vi.fn(async () => true);
    const result = await clearTrashDir('/a/.trash', verify, [{ path: '/a/.trash/old.png', size: 10, digest: 'f'.repeat(64) }]);
    expect(result).toEqual({ deletedCount: 0, failedCount: 1, reclaimedSize: 0 });
    expect(mocks.readDir).not.toHaveBeenCalledWith('/a/.trash/old.png');
    expect(verify).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('嵌套目录内只清理确认的文件，保留新文件和不含确认项的新目录', async () => {
    mocks.directories.set('/a/.trash', ['nested', 'new-dir']);
    addFiles('/a/.trash/nested', { 'selected.png': 10, 'new.png': 20 });
    addFiles('/a/.trash/new-dir', { 'new.png': 30 });
    const result = await clearTrashDir('/a/.trash', async () => true,
      [{ path: '/a/.trash/nested/selected.png', size: 10, digest: 'f'.repeat(64) }]);
    expect(result).toEqual({ deletedCount: 1, failedCount: 0, reclaimedSize: 10 });
    expect(mocks.remove).toHaveBeenCalledWith('/a/.trash/nested/selected.png');
    expect(mocks.remove).not.toHaveBeenCalledWith('/a/.trash/nested/new.png');
    expect(mocks.readDir).not.toHaveBeenCalledWith('/a/.trash/new-dir');
    expect(mocks.remove).not.toHaveBeenCalledWith('/a/.trash/new-dir');
    expect(mocks.remove).not.toHaveBeenCalledWith('/a/.trash/nested');
  });

  it('回收站核对后模型冻结或文件大小变化，删除前保留原文件', async () => {
    addFiles('/a/.trash', { 'frozen.png': 10, 'changed.png': 20 });
    const confirmed = [{ path: '/a/.trash/frozen.png', size: 10, digest: 'f'.repeat(64) },
      { path: '/a/.trash/changed.png', size: 20, digest: 'f'.repeat(64) }];
    const result = await clearTrashDir('/a/.trash', async (path) => {
      if (path.endsWith('frozen.png')) mocks.assertLegacyProjectWritesAllowed.mockRejectedValueOnce(new Error('项目模型状态已改变'));
      else mocks.sizes.set(path, 21);
      return true;
    }, confirmed);
    expect(result).toEqual({ deletedCount: 0, failedCount: 2, reclaimedSize: 0 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('回收站只删除确认过且最新引用核对通过的原文件，保留新增、变更和新引用', async () => {
    mocks.directories.set('/a', ['.trash']);
    addFiles('/a/.trash', { 'safe.png': 10, 'later-ref.png': 20, 'changed.png': 30, 'already-ref.png': 40 });
    const currentRefs = new Set(['/a/.trash/already-ref.png']);
    const initial = await scanStorageHealth([project('a')], currentRefs);
    const prepared = await prepareTrashCleanup(initial.trashes);
    const confirmed = prepared[0].files.filter((file): file is { path: string; size: number; referenced: boolean; digest: string } =>
      !file.referenced && typeof file.digest === 'string');
    currentRefs.add('/a/.trash/later-ref.png');
    mocks.sizes.set('/a/.trash/changed.png', 31);
    mocks.directories.get('/a/.trash')!.push('new.png');
    mocks.sizes.set('/a/.trash/new.png', 50);
    const verify = async (path: string, size: number) => {
      const fresh = await scanStorageHealth([project('a')], currentRefs, [], { includeDuplicates: false });
      const file = fresh.trashes[0]?.files.find((entry) => entry.path === path);
      return fresh.complete && !!file && !file.referenced && file.size === size;
    };
    const result = await clearTrashDir('/a/.trash', verify, confirmed);
    expect(result).toEqual({ deletedCount: 1, failedCount: 2, reclaimedSize: 10 });
    expect(mocks.remove).toHaveBeenCalledWith('/a/.trash/safe.png');
    for (const file of ['later-ref.png', 'changed.png', 'already-ref.png', 'new.png']) {
      expect(mocks.remove).not.toHaveBeenCalledWith(`/a/.trash/${file}`);
    }
    expect(mocks.remove).not.toHaveBeenCalledWith('/a/.trash');
  });

  it('counts a shared project directory once and retains references from either project', async () => {
    mocks.roots.set('a', '/shared');
    mocks.roots.set('b', '/shared');
    addFiles('/shared', { 'used.png': 10, 'unused.png': 20 });
    mocks.getProjectById.mockImplementation(async (id: string) => ({
      ...project(id), nodes: id === 'b' ? [{ data: { filePath: '/shared/used.png' } }] : [],
    }));

    const report = await scanStorageHealth([project('a'), project('b')], new Set());

    expect(report).toMatchObject({ projectSize: 30, trashSize: 0, totalSize: 30, reclaimableSize: 20 });
    expect(report.projects.reduce((sum, entry) => sum + entry.fileSize, 0)).toBe(30);
    expect(report.projects.find((entry) => entry.projectId === 'a')?.sharedWith).toContain('b');
    expect(report.orphans.map((entry) => entry.path)).toEqual(['/shared/unused.png']);
    expect(mocks.readDir.mock.calls.filter(([path]) => path === '/shared')).toHaveLength(1);
  });

  it('includes trash in total usage without counting duplicate orphan files twice', async () => {
    mocks.directories.set('/a', ['one', 'two', '.trash']);
    addFiles('/a/one', { 'same.mp4': 100 });
    addFiles('/a/two', { 'same.mp4': 100 });
    addFiles('/a/.trash', { 'old.bin': 50 });
    mocks.digests.set('/a/one/same.mp4', 'a'.repeat(64));
    mocks.digests.set('/a/two/same.mp4', 'a'.repeat(64));

    const report = await scanStorageHealth([project('a')], new Set());

    expect(report).toMatchObject({ projectSize: 200, trashSize: 50, totalSize: 250, reclaimableSize: 250 });
    expect(report.orphans).toHaveLength(2);
    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0].reclaimableSize).toBe(100);
  });

  it.each([false, true])('does not offer referenced duplicate copies for deletion (both referenced: %s)', async (bothReferenced) => {
    addFiles('/a', { 'same.png': 10 });
    addFiles('/b', { 'same.png': 10 });
    mocks.digests.set('/a/same.png', 'a'.repeat(64));
    mocks.digests.set('/b/same.png', 'a'.repeat(64));
    mocks.getProjectById.mockImplementation(async (id: string) => ({
      ...project(id), nodes: id === 'a' || bothReferenced ? [{ data: { filePath: `/${id}/same.png` } }] : [],
    }));

    const report = await scanStorageHealth([project('a'), project('b')], new Set());
    const group = report.duplicates[0];

    expect(group.files.find((file) => file.path === '/a/same.png')).toMatchObject({ referenced: true, canDelete: false });
    expect(group.files.find((file) => file.path === '/b/same.png')).toMatchObject({ referenced: bothReferenced, canDelete: !bothReferenced });
    expect(group.reclaimableSize).toBe(bothReferenced ? 0 : 10);
    expect(report.reclaimableSize).toBe(bothReferenced ? 0 : 10);
  });

  it('does not identify same-name and same-size files with different content as duplicates', async () => {
    addFiles('/a', { 'same.png': 10 });
    addFiles('/b', { 'same.png': 10 });
    mocks.digests.set('/a/same.png', 'a'.repeat(64));
    mocks.digests.set('/b/same.png', 'b'.repeat(64));

    const report = await scanStorageHealth([project('a'), project('b')], new Set());

    expect(report.duplicates).toEqual([]);
    expect(mocks.fingerprintAssetImage.mock.calls.map(([path]) => path))
      .toEqual(expect.arrayContaining(['/a/same.png', '/b/same.png']));
  });

  it('can skip duplicate hashing while retaining references from every project', async () => {
    addFiles('/a', { 'same.png': 10 });
    addFiles('/b', { 'same.png': 10 });
    mocks.getProjectById.mockImplementation(async (id: string) => ({
      ...project(id), nodes: id === 'b' ? [{ data: { filePath: '/a/same.png' } }] : [],
    }));

    const report = await scanStorageHealth([project('a'), project('b')], new Set(), [], { includeDuplicates: false });

    expect(report.orphans.map((file) => file.path)).toEqual(['/b/same.png']);
    expect(report.reclaimableSize).toBe(10);
    expect(report.duplicates).toEqual([]);
    expect(mocks.fingerprintAssetImage).not.toHaveBeenCalled();
  });

  it('does not start database or file reads after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(scanStorageHealth([project('a')], new Set(), [], { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });

    expect(mocks.getAllProjects).not.toHaveBeenCalled();
    expect(mocks.getProjectById).not.toHaveBeenCalled();
    expect(mocks.readDir).not.toHaveBeenCalled();
    expect(mocks.fingerprintAssetImage).not.toHaveBeenCalled();
  });

  it('marks unreadable project directories as incomplete instead of reporting a healthy empty result', async () => {
    addFiles('/a', { 'used.png': 10 });
    mocks.readDir.mockRejectedValue(new Error('permission denied: /private/blocked'));

    const report = await scanStorageHealth([project('a')], new Set());

    expect(report.complete).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ area: 'project', reason: 'permission' })]));
    expect(JSON.stringify(report.issues)).not.toContain('/private/blocked');
  });

  it('does not probe an absent hidden trash directory even when the filesystem would reject that probe', async () => {
    addFiles('/a', { 'used.png': 10 });
    mocks.exists.mockImplementation(async (path: string) => {
      if (path === '/a/.trash') throw new Error('forbidden path');
      return mocks.directories.has(path) || mocks.sizes.has(path);
    });

    const report = await scanStorageHealth([project('a')], new Set());

    expect(report).toMatchObject({ complete: true, issues: [], projectSize: 10, trashSize: 0 });
    expect(mocks.exists).not.toHaveBeenCalledWith('/a/.trash');
    expect(mocks.lstat).not.toHaveBeenCalledWith('/a/.trash');
    expect(mocks.readDir).not.toHaveBeenCalledWith('/a/.trash');
  });

  it('keeps project usage when an existing trash directory cannot be accessed', async () => {
    addFiles('/a', { 'used.png': 10 });
    mocks.directories.get('/a')!.push('.trash');
    addFiles('/a/.trash', { 'old.png': 20 });
    const fileInfo = mocks.lstat.getMockImplementation()!;
    mocks.lstat.mockImplementation(async (path: string) => {
      if (path === '/a/.trash') throw new Error('permission denied: /private/trash');
      return fileInfo(path);
    });

    const report = await scanStorageHealth([project('a')], new Set());

    expect(report).toMatchObject({ complete: false, projectSize: 10, trashSize: 0, totalSize: 10 });
    expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ area: 'trash', reason: 'permission' })]));
    expect(JSON.stringify(report.issues)).not.toContain('/private/trash');
  });

  it('skips operating-system metadata before reading it while retaining ordinary hidden user files', async () => {
    addFiles('/a', { '.DS_Store': 5, '._used.png': 6, 'Thumbs.db': 7, 'desktop.ini': 8,
      '.user-data.json': 30, 'used.png': 20 });

    const report = await scanStorageHealth([project('a')], new Set());

    expect(report).toMatchObject({ complete: true, issues: [], projectSize: 50 });
    expect(report.orphans.map((file) => file.path)).toEqual(['/a/.user-data.json', '/a/used.png']);
    for (const name of ['.DS_Store', '._used.png', 'Thumbs.db', 'desktop.ini']) {
      expect(mocks.lstat).not.toHaveBeenCalledWith(`/a/${name}`);
    }
  });

  it('preserves usage but marks duplicate detection incomplete when content cannot be read', async () => {
    addFiles('/a', { 'same.png': 10 });
    addFiles('/b', { 'same.png': 10 });
    mocks.fingerprintAssetImage.mockRejectedValue(new Error('permission denied: /private/image.png'));

    const report = await scanStorageHealth([project('a'), project('b')], new Set());

    expect(report).toMatchObject({ complete: false, projectSize: 20, totalSize: 20, reclaimableSize: 20, duplicates: [] });
    expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ area: 'duplicates', reason: 'permission' })]));
    expect(JSON.stringify(report.issues)).not.toContain('/private/image.png');
  });

  it('reports only successfully removed files as reclaimed when trash cleanup partially fails', async () => {
    addFiles('/a/.trash', { 'ok.bin': 10, 'locked.bin': 20 });
    mocks.remove.mockImplementation(async (path: string) => {
      if (path === '/a/.trash/locked.bin') throw new Error('permission denied');
      mocks.sizes.delete(path);
    });

    const result = await clearTrashDir('/a/.trash', async () => true,
      [{ path: '/a/.trash/ok.bin', size: 10, digest: 'f'.repeat(64) }, { path: '/a/.trash/locked.bin', size: 20, digest: 'f'.repeat(64) }]);

    expect(result).toEqual({ deletedCount: 1, failedCount: 1, reclaimedSize: 10 });
    expect(mocks.sizes.has('/a/.trash/locked.bin')).toBe(true);
    expect(mocks.remove).not.toHaveBeenCalledWith('/a/.trash');
  });
});
