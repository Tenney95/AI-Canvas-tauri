import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasProject } from '../../src/types';

const mocks = vi.hoisted(() => ({
  directories: new Map<string, Array<{ name: string; isDirectory: boolean; isFile: boolean }>>(),
  sizes: new Map<string, number>(),
  readDir: vi.fn(),
  stat: vi.fn(),
  identifyAsset: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/plugin-fs')>(),
  readDir: mocks.readDir,
  stat: mocks.stat,
  exists: async (path: string) => mocks.directories.has(path) || mocks.sizes.has(path),
}));
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
}));

import { listExternalFolderFiles, walkDirectoryFiles } from '../../src/services/fs/assetLibrary';
import { listProjectFiles } from '../../src/services/fileService';
import { scanStorageHealth } from '../../src/services/fs/storageHealth';

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
    mocks.directories.clear();
    mocks.sizes.clear();
    mocks.readDir.mockImplementation(async (path: string) => mocks.directories.get(path) ?? []);
    mocks.stat.mockImplementation(async (path: string) => ({ size: mocks.sizes.get(path) ?? 1, mtime: new Date(0) }));
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
    expect(report.totalSize).toBe(30);
    expect(report.reclaimableSize).toBe(25);
    expect(mocks.readDir).not.toHaveBeenCalledWith('/project/.thumbnail');
    expect(mocks.readDir).not.toHaveBeenCalledWith('/second/.thumbnail');
    expect(mocks.readDir).toHaveBeenCalledWith('/project/.trash/.thumbnail');
  });
});
