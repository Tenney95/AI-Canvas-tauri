/**
 * assetFolderNavigation — 回归测试：global asset folder browsing。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  directories: new Map<string, Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymlink?: boolean }>>(),
  readDir: vi.fn(),
  stat: vi.fn(),
  remove: vi.fn(),
  tauri: true,
  exists: vi.fn(), mkdir: vi.fn(),
  open: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), uniquePath: vi.fn(),
  copyStream: vi.fn(),
  pendingTargets: vi.fn<() => Promise<ReadonlySet<string>>>(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: mocks.readDir, stat: mocks.stat, remove: mocks.remove, exists: mocks.exists,
  writeFile: mocks.writeFile, readFile: mocks.readFile, mkdir: mocks.mkdir,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('../../src/services/fileService', () => ({ copyLocalFileStreamed: mocks.copyStream }));
vi.mock('../../src/services/fs/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fs/core')>(),
  isTauriEnv: () => mocks.tauri,
  joinPath: (...parts: string[]) => parts.join('/'),
  getBaseDir: async () => '/global',
  getConvertFileSrc: async () => (path: string) => `asset://${path}`,
  resolveUniqueDestPath: mocks.uniquePath,
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
vi.mock('../../src/services/indexedDb/mediaRelocations', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/indexedDb/mediaRelocations')>(),
  retiredMediaPaths: async () => new Set<string>(),
  pendingAssetMoveTargets: mocks.pendingTargets,
}));

import { listExternalFolderContents, listExternalFolderFiles, selectAssetFolderFiles, listGlobalFolderContents, createAssetSubfolder, resolveAssetFolderDirectory, addAssetFilesToGlobal, saveToPermanent, saveAssetToPermanent, walkDirectoryFiles } from '../../src/services/fs/assetLibrary';
import type { AssetFileEntry } from '../../src/services/fs/core';
import { isNativeMediaPendingFile } from '../../src/utils/nativeMediaPendingFile';
import { NATIVE_PROJECT_BINDING_FILE } from '../../src/utils/nativeProjectBindingFile';

function directory(path: string, names: string[]) {
  mocks.directories.set(path, names.map((name) => ({
    name: name.replace(/\/$/, ''), isDirectory: name.endsWith('/'), isFile: !name.endsWith('/'),
  })));
}
beforeEach(() => {
  mocks.tauri = true;
  mocks.remove.mockClear();
  mocks.exists.mockReset().mockImplementation(async (path: string) => !path.endsWith(`/${NATIVE_PROJECT_BINDING_FILE}`)
    || !!mocks.directories.get(path.slice(0, path.lastIndexOf('/')))?.some((entry) => entry.name === NATIVE_PROJECT_BINDING_FILE));
  mocks.mkdir.mockReset().mockResolvedValue(undefined);
  mocks.open.mockReset().mockResolvedValue(['/source/角色.png']);
  mocks.readFile.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.writeFile.mockReset().mockResolvedValue(undefined);
  mocks.copyStream.mockReset().mockImplementation(async (_source: string, destination: string) => ({ path: destination, totalBytes: 3 }));
  mocks.uniquePath.mockReset().mockImplementation(async (directory: string, name: string) => `${directory}/${name}`);
  mocks.directories.clear();
  mocks.pendingTargets.mockReset().mockResolvedValue(new Set());
  mocks.stat.mockClear();
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
  it.each(['global', 'folder'] as const)('读取目录期间出现的移动副本不分配身份或发布卡片（%s）', async (source) => {
    const root = source === 'global' ? '/global/file' : '/library';
    const target = `${root}/moving.png`, shown = `${root}/other.png`;
    directory(root, ['moving.png', 'other.png']);
    mocks.readDir.mockImplementationOnce(async (path: string) => {
      mocks.pendingTargets.mockResolvedValue(new Set([target]));
      return mocks.directories.get(path);
    });
    const streamed: AssetFileEntry[] = [];
    const options = { onFiles: (files: AssetFileEntry[]) => { streamed.push(...files); } };
    const result = source === 'global' ? await listGlobalFolderContents(options) : await listExternalFolderContents([root], options);
    expect(result.files.map((file) => file.path)).toEqual([shown]);
    expect(streamed.map((file) => file.path)).toEqual([shown]);
    expect(result.folders[0].fileCount).toBe(1);
    expect(mocks.stat).not.toHaveBeenCalledWith(target);
    mocks.pendingTargets.mockResolvedValue(new Set());
    expect((await walkDirectoryFiles(root, { source })).map((file) => file.path)).toEqual([target, shown]);
  });
  it('注册项目上级或子目录时跳过整个项目子树，其他外部素材正常展示', async () => {
    directory('/global', ['hero.png', '作品/']);
    directory('/global/作品', [NATIVE_PROJECT_BINDING_FILE, '专用图.png', '分组/']);
    directory('/global/作品/分组', ['分组图.png']);
    const result = await listExternalFolderContents(['/global', '/global/作品/分组']);
    expect(result.files.map((file) => file.path)).toEqual(['/global/hero.png']);
    expect(result.folders.map((folder) => folder.relativePath)).toEqual(['']);
    expect(mocks.stat).not.toHaveBeenCalledWith(`/global/作品/${NATIVE_PROJECT_BINDING_FILE}`);
    expect(mocks.readDir).not.toHaveBeenCalledWith('/global/作品/分组');
    expect(selectAssetFolderFiles([{ name: NATIVE_PROJECT_BINDING_FILE, path: `/global/作品/${NATIVE_PROJECT_BINDING_FILE}`,
      size: 1, category: 'text' }], { kind: 'all' })).toEqual([]);
  });

  it('只识别原生媒体的完整暂存命名，保留普通 pending、点文件和最终素材', () => {
    const hash = 'a'.repeat(64);
    for (const extension of ['', ...['png', 'jpg', 'webp', 'gif', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'opus', 'aac', 'flac', 'pcm', 'json'].map((value) => `.${value}`)]) {
      const name = `.native-media-${hash}${extension}.pending`;
      expect(isNativeMediaPendingFile(name)).toBe(true);
      expect(isNativeMediaPendingFile(`D:\\作品\\media\\${name.toUpperCase()}`)).toBe(true);
    }
    for (const name of ['ordinary.pending', '.notes', `${hash}.png`, `.native-media-${hash}.png`,
      `.native-media-${hash.slice(1)}.png.pending`, `.native-media-${hash}a.png.pending`,
      `.native-media-${hash.slice(1)}z.png.pending`, `.native-media-${hash}.jpeg.pending`,
      `.native-media-${hash}.txt.pending`, `.native-media-${hash}.png.pending.bak`]) {
      expect(isNativeMediaPendingFile(`/素材/${name}`)).toBe(false);
    }
  });

  it.each(['project', 'global', 'folder'] as const)('扫描 %s 在 stat、计数和流式展示前排除旧、新原生暂存件', async (source) => {
    const hash = 'a'.repeat(64);
    const pending = [`.native-media-${hash}.pending`, `.native-media-${hash}.png.pending`];
    const visible = ['photo.png', 'ordinary.pending', '.notes'];
    directory('/scan', [...pending, ...visible]);
    const batches: AssetFileEntry[] = [];
    const files = await walkDirectoryFiles('/scan', { source, projectId: source === 'project' ? 'project' : undefined,
      maxFiles: visible.length, onFiles: (batch) => batches.push(...batch) });
    expect(files.map((file) => file.name)).toEqual(visible);
    expect(batches).toEqual(files);
    for (const name of pending) expect(mocks.stat).not.toHaveBeenCalledWith(`/scan/${name}`);
    expect(mocks.directories.get('/scan')).toHaveLength(pending.length + visible.length);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('全局、外部和聚合目录选择同时过滤旧内存列表中的原生暂存项', () => {
    const hash = 'a'.repeat(64);
    const files: AssetFileEntry[] = [`.native-media-${hash}.pending`, `.native-media-${hash}.webp.pending`, 'ordinary.pending', '.notes']
      .map((name) => ({ name, path: `/global/file/${name}`, source: 'global', relativePath: name, size: 1, category: 'other' }));
    for (const selection of [{ kind: 'all' as const }, { kind: 'global' as const },
      { kind: 'folder' as const, rootPath: '/global/file', relativePath: '' }]) {
      expect(selectAssetFolderFiles(files, selection).map((file) => file.name)).toEqual(['ordinary.pending', '.notes']);
    }
    expect(files).toHaveLength(4);
  });

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
    directory('/global/file', ['人设/']);
    directory('/global/file/人设', []);
    await expect(addAssetFilesToGlobal(selection, roots)).resolves.toBe(1);
    expect(mocks.copyStream).toHaveBeenCalledExactlyOnceWith('/source/角色.png', destination);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('copies same-name files to separate allocated destinations and counts only successful transfers', async () => {
    mocks.open.mockResolvedValue(['/source/角色.png', '/other/角色.png', '/third/角色.png']);
    mocks.uniquePath.mockResolvedValueOnce('/global/file/角色.png')
      .mockResolvedValueOnce('/global/file/角色_1.png').mockResolvedValueOnce('/global/file/角色_2.png');
    mocks.copyStream.mockRejectedValueOnce(new Error('目标文件已存在，已拒绝覆盖'));
    await expect(addAssetFilesToGlobal()).resolves.toBe(2);
    expect(mocks.copyStream.mock.calls).toEqual([
      ['/source/角色.png', '/global/file/角色.png'],
      ['/other/角色.png', '/global/file/角色_1.png'],
      ['/third/角色.png', '/global/file/角色_2.png'],
    ]);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('saves real assets to the permanent directory without loading their bytes', async () => {
    await expect(saveToPermanent('/source/视频.mp4')).resolves.toBe('/global/file/视频.mp4');
    await expect(saveAssetToPermanent({ path: '/source/角色.png', name: '角色.png' } as AssetFileEntry))
      .resolves.toBe('/global/file/角色.png');
    expect(mocks.copyStream.mock.calls).toEqual([
      ['/source/视频.mp4', '/global/file/视频.mp4'], ['/source/角色.png', '/global/file/角色.png'],
    ]);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('keeps a failed permanent copy from falling back to an overwriting write', async () => {
    mocks.copyStream.mockRejectedValue(new Error('目标文件已存在，已拒绝覆盖'));
    await expect(saveToPermanent('/source/角色.png')).resolves.toBeNull();
    expect(mocks.copyStream).toHaveBeenCalledOnce();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it.each(['virtual://image', 'node://project/node'])('decodes %s across multiple base64 chunks without changing its bytes', async (path) => {
    const assetUrl = `data:image/png;base64,${'AAAA'.repeat(100_000)}`;
    await expect(saveAssetToPermanent({ path, name: '角色.png', assetUrl } as AssetFileEntry))
      .resolves.toBe('/global/file/角色.png');
    expect(mocks.writeFile).toHaveBeenCalledExactlyOnceWith('/global/file/角色.png', new Uint8Array(300_000), { createNew: true });
    expect(mocks.copyStream).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('keeps same-name embedded images distinct by project and node until they have a disk path', async () => {
    const { extractFilesFromNodeData } = await vi.importActual<typeof import('../../src/services/fileService')>('../../src/services/fileService');
    const image = { fileName: '角色.png', imageUrl: 'data:image/png;base64,AQID' };
    const owner = { projectId: 'project-a', nodeId: 'image-a' };
    const first = extractFilesFromNodeData(image, owner);
    const second = extractFilesFromNodeData(image, { ...owner, nodeId: 'image-b' });
    const otherProject = extractFilesFromNodeData(image, { ...owner, projectId: 'project-b' });
    expect(new Set([first?.path, second?.path, otherProject?.path]).size).toBe(3);
    expect(extractFilesFromNodeData({ imageUrl: image.imageUrl }, owner)?.name).toBe('file.png');
    expect(extractFilesFromNodeData({ ...image, filePath: '/project/角色.png' }, owner)?.path).toBe('/project/角色.png');
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
    mocks.exists.mockImplementation(async (path: string) => path === '/library/人物/existing');
    const selection = { kind: 'folder' as const, rootPath: '/library', relativePath: '人物' };
    await expect(createAssetSubfolder(selection, ['/library'], ' 表情 ')).resolves.toBe('/library/人物/表情');
    expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith('/library/人物/表情');
    for (const name of ['../escape', 'a/b', 'a\\b', '..', 'CON', 'NUL.txt', 'folder.', '']) {
      await expect(createAssetSubfolder(selection, ['/library'], name)).rejects.toThrow('名称无效');
    }
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
