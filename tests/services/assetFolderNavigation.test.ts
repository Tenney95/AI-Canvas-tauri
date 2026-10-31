/**
 * assetFolderNavigation — 回归测试：global asset folder browsing。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  directories: new Map<string, Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymlink?: boolean }>>(),
  readDir: vi.fn(),
  stat: vi.fn(),
  tauri: true,
  exists: vi.fn(), mkdir: vi.fn(),
  open: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), uniquePath: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: mocks.readDir, stat: mocks.stat, exists: mocks.exists,
  writeFile: mocks.writeFile, readFile: mocks.readFile, mkdir: mocks.mkdir,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('../../src/services/fs/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fs/core')>(),
  isTauriEnv: () => mocks.tauri,
  joinPath: (...parts: string[]) => parts.join('/'),
  getBaseDir: async () => '/global',
  getConvertFileSrc: async () => (path: string) => `asset://${path}`,
  resolveUniqueDestPath: mocks.uniquePath, listDirectoryFiles: vi.fn(),
  getFileCategory: () => 'image', CATEGORY_EXTENSIONS: { image: ['.png'] },
}));
vi.mock('../../src/services/fs/assetIndex', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fs/assetIndex')>(),
  identifyAssetBatch: async (files: Array<{ path: string; options: { rootPath: string } }>) => files.map(({ path, options }) => ({
    assetId: `asset-${path}`, relativePath: path.slice(options.rootPath.length + 1),
  })),
  identifyAsset: async (path: string, options: { rootPath: string }) => ({
    assetId: `asset-${path}`, relativePath: path.slice(options.rootPath.length + 1),
  }),
}));
vi.mock('../../src/services/fs/trash', () => ({ moveToTrash: vi.fn() }));

import { listExternalFolderContents, listExternalFolderFiles, selectAssetFolderFiles, listGlobalFolderContents, createAssetSubfolder, resolveAssetFolderDirectory, addAssetFilesToGlobal, walkDirectoryFiles } from '../../src/services/fs/assetLibrary';
import type { AssetFileEntry } from '../../src/services/fs/core';

function directory(path: string, names: string[]) {
  mocks.directories.set(path, names.map((name) => ({
    name: name.replace(/\/$/, ''), isDirectory: name.endsWith('/'), isFile: !name.endsWith('/'),
  })));
}
beforeEach(() => {
  mocks.tauri = true;
  mocks.exists.mockReset().mockResolvedValue(true);
  mocks.mkdir.mockReset().mockResolvedValue(undefined);
  mocks.open.mockReset().mockResolvedValue(['/source/角色.png']);
  mocks.readFile.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.writeFile.mockReset().mockResolvedValue(undefined);
  mocks.uniquePath.mockReset().mockImplementation(async (directory: string, name: string) => `${directory}/${name}`);
  mocks.directories.clear();
  mocks.readDir.mockImplementation(async (path: string) => {
    const entries = mocks.directories.get(path);
    if (!entries) throw new Error('Unavailable directory');
    return entries;
  });
  mocks.stat.mockResolvedValue({ size: 10, mtime: new Date(0) });
  directory('/library', ['root.png', '人物/', '空文件夹/']);
  directory('/library/人物', ['hero.png', '表情/']);
  directory('/library/人物/表情', ['smile.png']);
  directory('/library/空文件夹', []);
});

describe('global asset folder browsing', () => {
  it.each([
    { label: '真实零点创建时间', birthtime: new Date(0), mtime: new Date(20), createdAt: 0, modifiedAt: 20 },
    { label: '不支持创建时间', birthtime: null, mtime: new Date(20), createdAt: undefined, modifiedAt: 20 },
    { label: '无效或缺失时间', birthtime: new Date(Number.NaN), mtime: null, createdAt: undefined, modifiedAt: undefined },
  ])('projects filesystem times for global, project and external entries: $label', async ({ birthtime, mtime, createdAt, modifiedAt }) => {
    directory('/library', ['root.png']);
    directory('/global/file', ['global.png']);
    mocks.stat.mockResolvedValue({ size: 0, birthtime, mtime });
    const incremental: AssetFileEntry[] = [];
    const external = await listExternalFolderContents(['/library'], { onFiles: (files) => incremental.push(...files) });
    const global = await listGlobalFolderContents();
    const project = await walkDirectoryFiles('/library', { source: 'project', projectId: 'project' });
    expect([external.files[0], global.files[0], project[0]].map((file) => ({
      source: file.source, size: file.size, createdAt: file.createdAt, modifiedAt: file.modifiedAt,
    }))).toEqual(['folder', 'global', 'project'].map((source) => ({ source, size: 0, createdAt, modifiedAt })));
    expect(incremental).toEqual(external.files);
  });

  it.each([
    { selection: undefined, roots: [], destination: '/global/file/角色.png' },
    { selection: { kind: 'global' as const }, roots: [], destination: '/global/file/角色.png' },
    { selection: { kind: 'folder' as const, rootPath: '/global/file', relativePath: '人设' }, roots: [], destination: '/global/file/人设/角色.png' },
    { selection: { kind: 'folder' as const, rootPath: '/library', relativePath: '人物' }, roots: ['/library'], destination: '/library/人物/角色.png' },
  ])('adds picked files to the selected directory: $destination', async ({ selection, roots, destination }) => {
    await expect(addAssetFilesToGlobal(selection, roots)).resolves.toBe(1);
    expect(mocks.writeFile).toHaveBeenCalledExactlyOnceWith(destination, new Uint8Array([1, 2, 3]));
  });

  it('does not fall back to the import root for removed or invalid target folders', async () => {
    const selection = { kind: 'folder' as const, rootPath: '/library', relativePath: '人物' };
    await expect(addAssetFilesToGlobal(selection, [])).rejects.toThrow('已移除');
    await expect(addAssetFilesToGlobal({ ...selection, relativePath: '../escape' }, ['/library'])).rejects.toThrow('相对路径无效');
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('does not create files when the file picker is cancelled', async () => {
    mocks.open.mockResolvedValue(null);
    await expect(addAssetFilesToGlobal()).resolves.toBe(0);
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('browses imported subfolders while keeping root selection limited to direct files', async () => {
    directory('/global/file', ['root.png', '人物/']);
    directory('/global/file/人物', ['hero.png']);
    const result = await listGlobalFolderContents();
    expect(result.files.every((file) => file.source === 'global')).toBe(true);
    expect(result.folders.map((folder) => folder.relativePath)).toEqual(['', '人物']);
    expect(selectAssetFolderFiles(result.files, { kind: 'global' }).map((file) => file.name)).toEqual(['root.png']);
    expect(selectAssetFolderFiles(result.files, { kind: 'folder', rootPath: '/global/file', relativePath: '人物' }).map((file) => file.name)).toEqual(['hero.png']);
  });

  it('creates a real child only under a registered directory and refuses names and collisions', async () => {
    mocks.exists.mockResolvedValue(false);
    const selection = { kind: 'folder' as const, rootPath: '/library', relativePath: '人物' };
    await expect(createAssetSubfolder(selection, ['/library'], ' 表情 ')).resolves.toBe('/library/人物/表情');
    expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith('/library/人物/表情');
    for (const name of ['../escape', 'a/b', 'a\\b', '..', 'CON', 'NUL.txt', 'folder.', '']) {
      await expect(createAssetSubfolder(selection, ['/library'], name)).rejects.toThrow('名称无效');
    }
    mocks.exists.mockResolvedValue(true);
    await expect(createAssetSubfolder(selection, ['/library'], 'existing')).rejects.toThrow('已存在');
    expect(mocks.mkdir).toHaveBeenCalledTimes(1);
    await expect(resolveAssetFolderDirectory(selection, [])).rejects.toThrow('已移除');
    await expect(resolveAssetFolderDirectory({ ...selection, relativePath: '../escape' }, ['/library'])).rejects.toThrow('相对路径无效');
    await expect(resolveAssetFolderDirectory({ kind: 'all' }, ['/library'])).rejects.toThrow('具体文件夹');
  });
  it('retains real hierarchy and empty folders while selecting only direct files', async () => {
    const result = await listExternalFolderContents(['/library']);
    expect(result.truncated).toBe(false);
    expect(result.folders).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: '', parentRelativePath: null, fileCount: 1 }),
      expect.objectContaining({ relativePath: '人物', parentRelativePath: '', fileCount: 1 }),
      expect.objectContaining({ relativePath: '人物/表情', parentRelativePath: '人物', fileCount: 1 }),
      expect.objectContaining({ relativePath: '空文件夹', parentRelativePath: '', fileCount: 0, availability: 'online' }),
    ]));
    expect(selectAssetFolderFiles(result.files, { kind: 'folder', rootPath: '/library', relativePath: '' }).map((file) => file.name))
      .toEqual(['root.png']);
    expect(selectAssetFolderFiles(result.files, { kind: 'folder', rootPath: '/library', relativePath: '人物' }).map((file) => file.name))
      .toEqual(['hero.png']);
    expect(selectAssetFolderFiles(result.files, { kind: 'folder', rootPath: '/library', relativePath: '空文件夹' })).toEqual([]);
    expect(selectAssetFolderFiles(result.files, { kind: 'all' })).toHaveLength(3);
  });

  it('keeps existing external search callers recursive', async () => {
    const files = await listExternalFolderFiles(['/library']);
    expect(files.map((file) => file.name).sort()).toEqual(['hero.png', 'root.png', 'smile.png']);
    expect(files.every((file) => file.folderRoot === '/library' && file.source === 'folder')).toBe(true);
  });

  it('compares Windows paths and overlapping registered roots without including descendants or siblings', () => {
    const files: AssetFileEntry[] = [
      { name: 'direct', path: 'D:\\素材\\人物\\hero.png', category: 'image', size: 1, source: 'folder', folderRoot: 'D:\\素材' },
      { name: 'nested', path: 'D:/素材/人物/表情/smile.png', category: 'image', size: 1, source: 'folder' },
      { name: 'sibling', path: 'D:/素材/人物2/other.png', category: 'image', size: 1, source: 'folder' },
      { name: 'imported', path: 'D:/global/import.png', category: 'image', size: 1, source: 'global' },
    ];
    expect(selectAssetFolderFiles(files, { kind: 'folder', rootPath: 'd:/素材/人物/', relativePath: '' }).map((file) => file.name)).toEqual(['direct']);
    expect(selectAssetFolderFiles(files, { kind: 'folder', rootPath: 'D:\\素材\\', relativePath: '人物' }).map((file) => file.name)).toEqual(['direct']);
    expect(selectAssetFolderFiles(files, { kind: 'global' }).map((file) => file.name)).toEqual(['imported']);
    expect(selectAssetFolderFiles(files, { kind: 'folder', rootPath: '/素材', relativePath: '' })).toEqual([]);
  });

  it('marks inaccessible roots and children offline instead of treating them as empty', async () => {
    mocks.directories.delete('/library/人物');
    const result = await listExternalFolderContents(['/missing', '/library']);
    expect(result.folders.find((folder) => folder.rootPath === '/missing')).toMatchObject({ availability: 'offline', fileCount: 0 });
    expect(result.folders.find((folder) => folder.relativePath === '人物')).toMatchObject({ availability: 'offline' });
    expect(result.folders.find((folder) => folder.relativePath === '空文件夹')).toMatchObject({ availability: 'online' });
  });

  it('does not follow symlink files or directories', async () => {
    mocks.directories.get('/library')!.push(
      { name: 'escape', isDirectory: true, isFile: false, isSymlink: true },
      { name: 'linked.png', isDirectory: false, isFile: true, isSymlink: true },
    );
    const result = await listExternalFolderContents(['/library']);
    expect(result.folders.some((folder) => folder.name === 'escape')).toBe(false);
    expect(result.files.some((file) => file.name === 'linked.png')).toBe(false);
    expect(mocks.readDir).not.toHaveBeenCalledWith('/library/escape');
  });

  it('reports file, depth and directory limits, with unscanned folders distinguished from empty ones', async () => {
    const fileLimit = await listExternalFolderContents(['/library'], { maxFilesPerFolder: 1 });
    expect(fileLimit.files).toHaveLength(1);
    expect(fileLimit.truncated).toBe(true);
    expect(fileLimit.folders.find((folder) => folder.relativePath === '人物')?.availability).toBe('unscanned');
    const depthLimit = await listExternalFolderContents(['/library'], { maxDepth: 0 });
    expect(depthLimit.truncated).toBe(true);
    expect(depthLimit.folders).toHaveLength(1);
    const directoryLimit = await listExternalFolderContents(['/library'], { maxDirectories: 2 });
    expect(directoryLimit.truncated).toBe(true);
    expect(directoryLimit.folders).toHaveLength(2);
  });

  it('keeps browser-only mode free of native directory reads', async () => {
    mocks.tauri = false;
    expect(await listExternalFolderContents(['/library'])).toEqual({ files: [], folders: [], truncated: false });
    expect(mocks.readDir).not.toHaveBeenCalled();
  });
});
