/**
 * dramaAssetArchive — 回归测试：creative asset archive filesystem boundary。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
const io = vi.hoisted(() => ({ mkdir: vi.fn(), remove: vi.fn(), rename: vi.fn(), write: vi.fn(), stat: vi.fn(),
  invoke: vi.fn(), copy: vi.fn(), download: vi.fn(), readData: vi.fn(), base: '/base' }));
vi.mock('@tauri-apps/plugin-fs', () => ({ mkdir: io.mkdir, remove: io.remove, rename: io.rename, writeFile: io.write, stat: io.stat }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: io.invoke }));
vi.mock('../../src/services/fs/core', () => ({
  getBaseDir: async () => io.base, ensureProjectDataDir: async () => '/project',
  joinPath: (...parts: string[]) => parts.join('/'), stripVerbatimPrefix: (path: string) => path,
}));
vi.mock('../../src/services/fileService', () => ({
  copyAssetFileToFolder: io.copy, downloadAssetArchiveMedia: io.download, readFileToDataUrl: io.readData,
  getGlobalFilesDir: async () => '/global',
}));
import { cleanupDramaAssetTransferDirectory, createDramaAssetArchiveWorkspace, createDramaAssetImportFolder,
  createGlobalDramaAssetImportFolder, packDramaAssetArchive, retainDramaAssetTransferDirectory,
  stageDramaAssetArchiveMedia, unpackDramaAssetArchive } from '../../src/services/fs/dramaAssetArchive';

beforeEach(() => {
  io.base = '/base';
  vi.clearAllMocks(); io.mkdir.mockReset().mockResolvedValue(undefined);
  io.remove.mockResolvedValue(undefined); io.rename.mockResolvedValue(undefined); io.write.mockResolvedValue(undefined);
  io.copy.mockImplementation(async (source: string, directory: string) => ({ path: `${directory}/${source.split('/').pop()}`, totalBytes: 3, digest: 'a'.repeat(64) }));
  io.download.mockImplementation(async (_url: string, path: string) => path);
  io.invoke.mockResolvedValue({ assetCount: 1 });
});
describe('creative asset archive filesystem boundary', () => {
  it('真实工作区的解包目标保持为空，首次导出媒体时才创建 media 子目录', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ai-canvas-asset-workspace-'));
    io.base = base;
    io.mkdir.mockImplementation(async (path: string, options?: { recursive?: boolean }) => mkdir(path, options));
    io.remove.mockImplementation(async (path: string, options?: { recursive?: boolean }) => rm(path, options));
    io.rename.mockImplementation(rename);
    io.copy.mockImplementation(async (source: string, directory: string) => {
      const path = join(directory, 'source.png'); await copyFile(source, path);
      return { path, totalBytes: 3, digest: 'a'.repeat(64) };
    });
    try {
      const workspace = await createDramaAssetArchiveWorkspace();
      expect(await readdir(workspace.assetsDirectory)).toEqual([]);
      const source = join(base, 'source.png'); await writeFile(source, new Uint8Array([1, 2, 3]));
      const staged = await stageDramaAssetArchiveMedia(workspace, { filePath: source }, 'image', 'png', 'image');
      expect(await readdir(workspace.assetsDirectory)).toEqual(['media']);
      expect([...await readFile(staged.path)]).toEqual([1, 2, 3]);
      await cleanupDramaAssetTransferDirectory(workspace.directory);
    } finally {
      const resolved = await realpath(base), temporary = await realpath(tmpdir());
      const child = relative(temporary, resolved);
      if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('临时目录清理范围无效');
      await rm(resolved, { recursive: true, force: true });
    }
  });

  it('allocates isolated staging and Library leaves, and never grants cleanup of their parents', async () => {
    const workspace = await createDramaAssetArchiveWorkspace();
    const folder = await createDramaAssetImportFolder('series');
    expect(workspace.directory).toMatch(/^\/base\/\.aicassets-stage-/);
    expect(folder.directory).toMatch(/^\/project\/Library\/import-/);
    expect(folder.relativeDirectory).toMatch(/^Library\/import-/);
    await expect(cleanupDramaAssetTransferDirectory('/project/Library')).rejects.toThrow('无效');
    expect(io.remove).not.toHaveBeenCalled();
    await cleanupDramaAssetTransferDirectory(workspace.directory);
    await cleanupDramaAssetTransferDirectory(folder.directory);
    expect(io.remove.mock.calls).toEqual([[workspace.directory, { recursive: true }], [folder.directory, { recursive: true }]]);
  });

  it('cleans its newly created staging leaf when cancellation arrives while mkdir completes', async () => {
    const controller = new AbortController();
    io.mkdir.mockImplementation(async (path: string) => { if (/\.aicassets-stage-/.test(path)) controller.abort(); });
    await expect(createDramaAssetArchiveWorkspace({ signal: controller.signal })).rejects.toThrow('取消');
    expect(io.remove).toHaveBeenCalledTimes(1);
    expect(io.remove.mock.calls[0][0]).toMatch(/^\/base\/\.aicassets-stage-/);
  });

  it('revokes temporary cleanup ownership once final media must be retained', async () => {
    const folder = await createDramaAssetImportFolder('series');
    retainDramaAssetTransferDirectory(folder.directory);
    await expect(cleanupDramaAssetTransferDirectory(folder.directory)).rejects.toThrow('无效');
    expect(io.remove).not.toHaveBeenCalled();
  });

  it('allocates global import media under its own global leaf without a project Library directory', async () => {
    const folder = await createGlobalDramaAssetImportFolder();
    expect(folder).toMatchObject({ rootDirectory: '/global' });
    expect(folder.directory).toMatch(/^\/global\/import-/);
    expect(folder.relativeDirectory).toMatch(/^import-/);
    expect(io.mkdir.mock.calls.some(([path]) => path.includes('/project'))).toBe(false);
    await cleanupDramaAssetTransferDirectory(folder.directory);
    expect(io.remove).toHaveBeenCalledExactlyOnceWith(folder.directory, { recursive: true });
  });

  it('copies large local video through the shared native transfer and gives it a safe package name', async () => {
    const workspace = await createDramaAssetArchiveWorkspace();
    const copied = await stageDramaAssetArchiveMedia(workspace, { filePath: '/source/走路.mp4' }, 'media-one', 'mp4', 'video');
    expect(io.copy).toHaveBeenCalledWith('/source/走路.mp4', workspace.mediaDirectory, { signal: undefined });
    expect(io.rename).toHaveBeenCalledWith(`${workspace.mediaDirectory}/走路.mp4`, `${workspace.mediaDirectory}/media-one.mp4`);
    expect(copied).toMatchObject({ relativePath: 'media/media-one.mp4', totalBytes: 3, digest: 'a'.repeat(64) });
    expect(io.readData).not.toHaveBeenCalled(); expect(io.write).not.toHaveBeenCalled();
  });

  it('downloads remote video to its private incoming directory before hashing the native copy', async () => {
    const workspace = await createDramaAssetArchiveWorkspace();
    await stageDramaAssetArchiveMedia(workspace, { url: 'https://media.example/clip.mp4' }, 'media-one', 'mp4', 'video');
    expect(io.download).toHaveBeenCalledWith('https://media.example/clip.mp4', `${workspace.incomingDirectory}/media-one.mp4`, 'video', { signal: undefined });
    expect(io.copy.mock.calls[0][0]).toBe(`${workspace.incomingDirectory}/media-one.mp4`);
    expect(io.readData).not.toHaveBeenCalled();
  });

  it('uses the existing archive commands with only its own media subtree and manifest', async () => {
    const workspace = await createDramaAssetArchiveWorkspace();
    await packDramaAssetArchive(workspace, '/chosen.aicassets', '{"version":1}');
    await unpackDramaAssetArchive(workspace, '/chosen.aicassets');
    expect(io.invoke.mock.calls).toEqual([
      ['pack_project_archive', { assetsDir: workspace.assetsDirectory, outputPath: '/chosen.aicassets', entries: [{ path: 'manifest.json', content: '{"version":1}' }] }],
      ['unpack_project_archive', { archivePath: '/chosen.aicassets', assetsDir: workspace.assetsDirectory }],
    ]);
  });
});
