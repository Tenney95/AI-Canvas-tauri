/**
 * projectThumbnailExclusion — 回归测试：project thumbnail directories stay outside asset scans。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasProject } from '../../src/types';
import type { AssetFileEntry } from '../../src/services/fs/core';

const mocks = vi.hoisted(() => ({
  directories: new Map<string, Array<{ name: string; isDirectory: boolean; isFile: boolean }>>(),
  sizes: new Map<string, number>(),
  readDir: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  fingerprintAssetImage: vi.fn(),
  identifyAsset: vi.fn(),
  getHistoryEntriesPage: vi.fn(),
  getProjectConversations: vi.fn(),
  getConversationMessages: vi.fn(),
  getAllProjects: vi.fn(),
  getProjectById: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/plugin-fs')>(),
  remove: mocks.remove,
  readDir: mocks.readDir,
  stat: mocks.stat,
  lstat: mocks.lstat,
  exists: async (path: string) => mocks.directories.has(path) || mocks.sizes.has(path),
}));
vi.mock('../../src/services/indexedDbService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/indexedDbService')>(),
  savePresetFolderToDb: vi.fn().mockResolvedValue(undefined),
  loadPresetFoldersFromDb: vi.fn().mockResolvedValue([]),
  deletePresetFolderFromDb: vi.fn().mockResolvedValue(undefined),
  getHistoryEntriesPage: mocks.getHistoryEntriesPage,
  getProjectConversations: mocks.getProjectConversations,
  getConversationMessages: mocks.getConversationMessages,
  getAllProjects: mocks.getAllProjects,
  getProjectById: mocks.getProjectById,
}));
vi.mock('../../src/services/indexedDb/projectImportRepository', () => ({ listProjectImportRecoveries: async () => [] }));
vi.mock('../../src/services/fs/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fs/core')>(),
  isTauriEnv: () => true,
  joinPath: (...parts: string[]) => parts.join('/'),
  getConvertFileSrc: async () => (path: string) => `asset://${path}`,
  getProjectDataDir: async (id: string) => `/${id}`,
}));
vi.mock('../../src/services/fs/assetIndex', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fs/assetIndex')>(),
  identifyAsset: mocks.identifyAsset,
  identifyAssetBatch: async (files: Array<{ path: string; options: { rootPath: string } }>, signal?: AbortSignal) => {
    const results = [];
    for (const file of files) {
      signal?.throwIfAborted();
      results.push(await mocks.identifyAsset(file.path, file.options));
    }
    return results;
  },
}));
vi.mock('../../src/services/fs/assetImageMetadata', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fs/assetImageMetadata')>(),
  fingerprintAssetImage: mocks.fingerprintAssetImage,
}));

import { listExternalFolderContents, listExternalFolderFiles, walkDirectoryFiles } from '../../src/services/fs/assetLibrary';
import { listProjectFiles } from '../../src/services/fileService';
import { scanStorageHealth, collectNodeFilePaths, deleteOrphanFile, deleteDuplicateFile } from '../../src/services/fs/storageHealth';

function addDirectory(path: string, names: string[]): void {
  mocks.directories.set(path, names.map((name) => ({
    name: name.replace(/\/$/, ''),
    isDirectory: name.endsWith('/'),
    isFile: !name.endsWith('/'),
  })));
}

function project(id: string): CanvasProject {
  return { id, name: id, createdAt: 1, updatedAt: 1 };
}

describe('project thumbnail directories stay outside asset scans', () => {
  beforeEach(() => {
    mocks.getAllProjects.mockResolvedValue([]);
    mocks.getProjectById.mockImplementation(async (id: string) => ({ ...project(id), nodes: [] }));
    mocks.remove.mockResolvedValue(undefined);
    mocks.getHistoryEntriesPage.mockResolvedValue({ records: [], hasMore: false });
    mocks.getProjectConversations.mockResolvedValue([]);
    mocks.getConversationMessages.mockResolvedValue({ messages: [], total: 0 });
    mocks.directories.clear();
    mocks.sizes.clear();
    mocks.readDir.mockImplementation(async (path: string) => mocks.directories.get(path) ?? []);
    mocks.stat.mockImplementation(async (path: string) => ({ size: mocks.sizes.get(path) ?? 1, mtime: new Date(0) }));
    mocks.lstat.mockImplementation(async (path: string) => ({ ...await mocks.stat(path),
      isDirectory: mocks.directories.has(path), isFile: !mocks.directories.has(path), isSymlink: false }));
    mocks.fingerprintAssetImage.mockImplementation(async (path: string) => ({ digest: 'a'.repeat(64), bytes: mocks.sizes.get(path) ?? 1 }));
    mocks.identifyAsset.mockImplementation(async (path: string, options: { rootPath: string }) => ({
      assetId: `asset-${path}`,
      relativePath: path.slice(options.rootPath.length + 1),
    }));
    // Put the cache last so the stack would visit it first and exhaust a small file limit.
    addDirectory('/project', ['group/', 'original.png', '.thumbnail/']);
    addDirectory('/project/.thumbnail', ['cache.webp', 'cache-2.webp', 'cache-3.webp']);
    addDirectory('/project/group', ['.thumbnail/']);
    addDirectory('/project/group/.thumbnail', ['user.png']);
    mocks.sizes.set('/project/original.png', 10);
    mocks.sizes.set('/project/group/.thumbnail/user.png', 20);
    mocks.sizes.set('/project/.thumbnail/cache.webp', 100);
  });

  it('skips the root cache before indexing and counting while preserving nested names', async () => {
    const files = await walkDirectoryFiles('/project', {
      maxFiles: 2,
      excludedRootDirectories: ['.thumbnail'],
    });

    expect(files.map((file) => file.relativePath)).toEqual(['original.png', 'group/.thumbnail/user.png']);
    expect(mocks.readDir).not.toHaveBeenCalledWith('/project/.thumbnail');
    expect(mocks.stat.mock.calls.map(([path]) => path)).not.toContain('/project/.thumbnail/cache.webp');
    expect(mocks.identifyAsset).toHaveBeenCalledTimes(2);
  });

  it('applies root exclusion when listing project assets', async () => {
    const files = await listProjectFiles('project');

    expect(files.map((file) => file.relativePath)).toEqual(['original.png', 'group/.thumbnail/user.png']);
    expect(files.every((file) => file.source === 'project')).toBe(true);
    expect(mocks.readDir).not.toHaveBeenCalledWith('/project/.thumbnail');
    expect(mocks.identifyAsset).toHaveBeenCalledTimes(2);
    expect(mocks.identifyAsset.mock.calls.every(([, options]) => options.source === 'project'
      && options.projectId === 'project' && options.mtimeMs === 0)).toBe(true);
  });

  it('publishes the first stable project asset before later assets are identified', async () => {
    const batches: AssetFileEntry[][] = [];
    const identifiedCounts: number[] = [];
    const files = await listProjectFiles('project', { onFiles: (batch) => {
      batches.push(batch);
      identifiedCounts.push(mocks.identifyAsset.mock.calls.length);
    } });

    expect(batches.flat()).toEqual(files);
    expect(batches[0]).toEqual([expect.objectContaining({
      assetId: 'asset-/project/original.png', relativePath: 'original.png', source: 'project',
    })]);
    expect(identifiedCounts[0]).toBe(1);
  });

  it('excludes nested internal directories from both streamed and final project assets', async () => {
    addDirectory('/project/group', ['.thumbnail/', 'AppData/', '.trash/']);
    addDirectory('/project/group/AppData', ['internal.json']);
    addDirectory('/project/group/.trash', ['removed.png']);
    const batches: AssetFileEntry[][] = [];
    const files = await listProjectFiles('project', { onFiles: (batch) => { batches.push(batch); } });

    expect(batches.flat()).toEqual(files);
    expect(files.map((file) => file.relativePath)).toEqual(['original.png', 'group/.thumbnail/user.png']);
    expect(mocks.readDir).not.toHaveBeenCalledWith('/project/group/AppData');
    expect(mocks.readDir).not.toHaveBeenCalledWith('/project/group/.trash');
  });

  it('stops scanning after an incremental consumer cancels', async () => {
    const controller = new AbortController();
    const batches: AssetFileEntry[][] = [];
    await expect(listProjectFiles('project', { signal: controller.signal, onFiles: (batch) => {
      batches.push(batch);
      controller.abort();
    } })).rejects.toMatchObject({ name: 'AbortError' });

    expect(batches.flat()).toHaveLength(1);
    expect(mocks.identifyAsset).toHaveBeenCalledTimes(1);
    expect(mocks.readDir).not.toHaveBeenCalledWith('/project/group');
  });

  it('does not treat cancellation during a directory read as an offline directory', async () => {
    const controller = new AbortController();
    mocks.readDir.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('read interrupted');
    });

    await expect(walkDirectoryFiles('/project', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.identifyAsset).not.toHaveBeenCalled();
  });

  it('rejects when the final incremental batch cancels the scan', async () => {
    addDirectory('/two', ['first.png', 'last.png']);
    const controller = new AbortController();

    await expect(walkDirectoryFiles('/two', { signal: controller.signal, onFiles: (batch) => {
      if (batch.some((file) => file.name === 'last.png')) controller.abort();
    } })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('bounds stat batches without waiting for all files before the first result', async () => {
    addDirectory('/many', Array.from({ length: 30 }, (_, index) => `image-${index}.png`));
    let firstStatCount: number | undefined;
    const files = await walkDirectoryFiles('/many', { onFiles: () => {
      firstStatCount ??= mocks.stat.mock.calls.length;
    } });

    expect(files).toHaveLength(30);
    expect(firstStatCount).toBe(12);
  });

  it('includes external folder identity in incremental batches', async () => {
    const batches: AssetFileEntry[][] = [];
    const result = await listExternalFolderContents(['/project'], { onFiles: (batch) => { batches.push(batch); } });

    expect(batches.flat()).toEqual(result.files);
    expect(batches.flat().every((file) => file.source === 'folder' && file.folderRoot === '/project'
      && file.assetId && file.relativePath)).toBe(true);
  });

  it('keeps root and nested thumbnail folders in explicitly registered external directories', async () => {
    const files = await listExternalFolderFiles(['/project']);

    expect(files.map((file) => file.relativePath)).toEqual(expect.arrayContaining([
      '.thumbnail/cache.webp', 'group/.thumbnail/user.png',
    ]));
    expect(mocks.readDir).toHaveBeenCalledWith('/project/.thumbnail');
  });

  it('excludes project cache from counts, orphans and duplicates, but retains deleted user folders', async () => {
    addDirectory('/project', ['group/', 'original.png', '.thumbnail/', '.trash/']);
    addDirectory('/project/.trash', ['.thumbnail/']);
    addDirectory('/project/.trash/.thumbnail', ['deleted.png']);
    mocks.sizes.set('/project/.trash/.thumbnail/deleted.png', 5);
    addDirectory('/second', ['.thumbnail/']);
    addDirectory('/second/.thumbnail', ['cache.webp']);
    mocks.sizes.set('/second/.thumbnail/cache.webp', 100);

    const report = await scanStorageHealth([project('project'), project('second')], new Set(['/project/original.png']));

    expect(report.projects.map(({ fileCount, fileSize }) => ({ fileCount, fileSize })))
      .toEqual([{ fileCount: 2, fileSize: 30 }, { fileCount: 0, fileSize: 0 }]);
    expect(report.orphans.map(({ path }) => path)).toEqual(['/project/group/.thumbnail/user.png']);
    expect(report.duplicates).toEqual([]);
    expect(report.trashes[0]).toMatchObject({ trashSize: 5, fileCount: 1 });
    expect(report.projectSize).toBe(30);
    expect(report.trashSize).toBe(5);
    expect(report.totalSize).toBe(35);
    expect(report.reclaimableSize).toBe(25);
    expect(mocks.readDir).not.toHaveBeenCalledWith('/project/.thumbnail');
    expect(mocks.readDir).not.toHaveBeenCalledWith('/second/.thumbnail');
    expect(mocks.readDir).toHaveBeenCalledWith('/project/.trash/.thumbnail');
  });
});


describe('storage health cross-project deletion protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getHistoryEntriesPage.mockResolvedValue({ records: [], hasMore: false });
    mocks.getProjectConversations.mockResolvedValue([]);
    mocks.getConversationMessages.mockResolvedValue({ messages: [], total: 0 });
    mocks.directories.clear();
    mocks.sizes.clear();
    mocks.readDir.mockImplementation(async (path: string) => mocks.directories.get(path) ?? []);
    mocks.stat.mockResolvedValue({ size: 10 });
    mocks.lstat.mockImplementation(async (path: string) => ({ size: 10,
      isDirectory: mocks.directories.has(path), isFile: !mocks.directories.has(path), isSymlink: false }));
    mocks.fingerprintAssetImage.mockResolvedValue({ digest: 'a'.repeat(64), bytes: 10 });
    mocks.remove.mockResolvedValue(undefined);
    mocks.getAllProjects.mockResolvedValue([project('a'), project('b')]);
    mocks.getProjectById.mockImplementation(async (id: string) => ({
      ...project(id), nodes: [{ data: { filePath: `/${id}/used.png` } }],
    }));
    addDirectory('/a', ['used.png', 'unsaved.png']);
    addDirectory('/b', ['used.png', 'unused.png']);
  });

  it('reads unopened projects and preserves current unsaved references', async () => {
    const report = await scanStorageHealth([project('a')], () => collectNodeFilePaths([
      { data: { filePath: '/a/unsaved.png' } },
    ]));
    expect(report.orphans.map((file) => file.path)).toEqual(['/b/unused.png']);
    expect(mocks.getProjectById).toHaveBeenCalledWith('b');
  });

  it('retains nested relative paths and encoded local media URLs', async () => {
    mocks.getProjectById.mockImplementation(async (id: string) => ({
      ...project(id), nodes: [{ data: { storyboardOverrides: [{ relativePath: 'used.png' }] } }],
    }));
    const report = await scanStorageHealth([], collectNodeFilePaths([
      { data: { videoReferences: [{ url: 'http://asset.localhost/%2Fa%2Funsaved.png' }] } },
    ]));
    expect(report.orphans.map((file) => file.path)).toEqual(['/b/unused.png']);
  });

  it('retains AI definitions used only by current nodes and undo snapshots in their owning project', async () => {
    const previousHash = 'a'.repeat(64);
    const currentHash = 'b'.repeat(64);
    const unusedHash = 'c'.repeat(64);
    const appNode = (sha256: string) => ({
      id: 'ai-app-1', type: 'ai-app', position: { x: 0, y: 0 },
      data: { type: 'ai-app', label: '筛选器', aiApp: {
        version: 1, instanceId: 'ai-app-1', revision: sha256 === previousHash ? 1 : 2,
        definition: { relativePath: `ai-apps/${sha256}.json`, sha256, bytes: 10 },
        title: '筛选器', description: '', actions: [{ id: 'scan', title: '筛选', inputSchema: { type: 'object' } }],
        inputNodeIds: [], savedState: {},
      } },
    });
    addDirectory('/a', ['ai-apps/']);
    addDirectory('/a/ai-apps', [`${previousHash}.json`, `${currentHash}.json`, `${unusedHash}.json`]);
    addDirectory('/b', ['ai-apps/']);
    addDirectory('/b/ai-apps', [`${previousHash}.json`]);
    mocks.getProjectById.mockImplementation(async (id: string) => ({
      ...project(id), nodes: id === 'a' ? [appNode(currentHash)] : [],
    }));
    const liveCanvas = {
      nodes: [appNode(currentHash)],
      history: [{ nodes: [appNode(previousHash)], edges: [], groups: [] }], messages: [],
    };
    const collectLive = async () => collectNodeFilePaths([{ data: liveCanvas }], '/a');
    const report = await scanStorageHealth([], collectLive);
    expect(report.orphans.map((file) => file.path)).toEqual([
      `/a/ai-apps/${unusedHash}.json`, `/b/ai-apps/${previousHash}.json`,
    ]);
    const removed = await deleteOrphanFile(`/a/ai-apps/${previousHash}.json`, async (path) => {
      const fresh = await scanStorageHealth([], collectLive);
      return fresh.orphans.some((file) => file.path === path);
    });
    expect(removed).toBe(false);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('fails closed when asynchronous current-project reference resolution cannot finish', async () => {
    const collectLive = async (): Promise<Set<string>> => {
      throw new Error('项目已切换');
    };
    await expect(scanStorageHealth([], collectLive)).rejects.toMatchObject({ area: 'references', reason: 'changed' });
    expect(await deleteOrphanFile('/b/unused.png', async () => {
      await scanStorageHealth([], collectLive);
      return true;
    })).toBe(false);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it.each([undefined, { nodes: null }])('fails closed on missing or malformed project records', async (record) => {
    mocks.getProjectById.mockResolvedValue(record);
    await expect(scanStorageHealth([], new Set())).rejects.toThrow();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('fails closed on database read errors', async () => {
    mocks.getProjectById.mockRejectedValue(new Error('unavailable'));
    await expect(scanStorageHealth([], new Set())).rejects.toMatchObject({ area: 'references', reason: 'unavailable' });
  });

  it('retains files referenced only by output history or conversation attachments', async () => {
    mocks.getHistoryEntriesPage.mockResolvedValue({ records: [{ filePath: '/a/unsaved.png' }], hasMore: false });
    mocks.getProjectConversations.mockResolvedValue([{ id: 'chat' }]);
    mocks.getConversationMessages.mockResolvedValue({ messages: [{ attachments: [{ filePath: '/b/unused.png' }] }], total: 1 });
    const report = await scanStorageHealth([], new Set());
    expect(report.orphans).toEqual([]);
  });

  it('normalizes Windows paths without folding Unix paths', () => {
    const paths = collectNodeFilePaths([{ data: {
      filePath: 'C:\\Media\\Used.png',
      references: ['/Media/Used.png'],
    } }]);
    expect(paths.has('c:/media/used.png')).toBe(true);
    expect(paths.has('/Media/Used.png')).toBe(true);
    expect(paths.has('/media/used.png')).toBe(false);
  });

  it.each([deleteOrphanFile, deleteDuplicateFile])('requires fresh verification before removal', async (removeFile) => {
    expect(await removeFile('/b/unused.png')).toBe(false);
    expect(await removeFile('/b/unused.png', async () => false)).toBe(false);
    expect(await removeFile('/b/unused.png', async () => { throw new Error('read failed'); })).toBe(false);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(await removeFile('/b/unused.png', async () => true)).toBe(true);
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it('rejects an old orphan report after another project starts referencing the file', async () => {
    const before = await scanStorageHealth([], new Set());
    expect(before.orphans.some((file) => file.path === '/b/unused.png')).toBe(true);
    mocks.getProjectById.mockImplementation(async (id: string) => ({
      ...project(id), nodes: [{ data: { filePath: '/b/unused.png' } }],
    }));
    const deleted = await deleteOrphanFile('/b/unused.png', async (path) => {
      const fresh = await scanStorageHealth([], new Set());
      return fresh.orphans.some((file) => file.path === path);
    });
    expect(deleted).toBe(false);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
