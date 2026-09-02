import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureProjectDataDir: vi.fn(),
  invoke: vi.fn(),
  isTauriEnv: vi.fn(() => true),
  notifyProjectDiskChanged: vi.fn(),
  resolveUniqueDestPath: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  writeFile: mocks.writeFile,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn(),
  invoke: mocks.invoke,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: vi.fn(), localDataDir: vi.fn() }));
vi.mock('../../src/services/fs/core', () => ({
  CATEGORY_EXTENSIONS: {},
  arrayBufferToBase64: vi.fn(),
  buildNodeFileName: (label: string, ext: string) => `${label}${ext}`,
  ensureProjectDataDir: mocks.ensureProjectDataDir,
  getConvertFileSrc: () => (path: string) => `asset://${path}`,
  getFileCategory: vi.fn(),
  getMimeType: vi.fn(),
  getProjectDataDir: vi.fn(),
  isTauriEnv: () => mocks.isTauriEnv(),
  joinPath: (...parts: string[]) => parts.join('/'),
  notifyProjectDiskChanged: mocks.notifyProjectDiskChanged,
  resolveUniqueDestPath: mocks.resolveUniqueDestPath,
  sanitizeFileName: (name: string) => name,
  sanitizeFolderName: (name: string) => name,
}));

import {
  downloadUrlAndSave,
  persistMediaUrlToProjectData,
  resolveProjectOutputPath,
} from '../../src/services/fileService';

describe('downloadUrlAndSave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauriEnv.mockReturnValue(true);
    mocks.ensureProjectDataDir.mockResolvedValue('/project/data');
    mocks.resolveUniqueDestPath.mockImplementation(async (dataDir: string, fileName: string) => (
      `${dataDir}/${fileName}`
    ));
  });

  it('serializes same-name downloads until the first destination exists', async () => {
    const existingPaths = new Set<string>();
    mocks.resolveUniqueDestPath.mockImplementation(async (dataDir: string, fileName: string) => {
      const dotIndex = fileName.lastIndexOf('.');
      const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
      const extension = dotIndex > 0 ? fileName.slice(dotIndex) : '';
      let candidate = `${dataDir}/${fileName}`;
      let counter = 1;
      while (existingPaths.has(candidate)) {
        candidate = `${dataDir}/${baseName}_${counter}${extension}`;
        counter += 1;
      }
      return candidate;
    });

    let releaseFirstDownload: () => void = () => undefined;
    const firstDownloadGate = new Promise<void>((resolve) => {
      releaseFirstDownload = resolve;
    });
    let downloadCount = 0;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command !== 'download_file_streamed') return undefined;
      downloadCount += 1;
      if (downloadCount === 1) await firstDownloadGate;
      existingPaths.add(args.destinationPath);
      return { path: args.destinationPath, totalBytes: 1, contentType: 'image/png' };
    });

    const first = downloadUrlAndSave(
      'https://example.com/first.png',
      'project-1',
      'ai-image',
      'AI 图片',
    );
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));

    const second = downloadUrlAndSave(
      'https://example.com/second.png',
      'project-1',
      'ai-image',
      'AI 图片',
    );
    await vi.waitFor(() => expect(mocks.ensureProjectDataDir).toHaveBeenCalledTimes(2));

    expect(mocks.resolveUniqueDestPath).toHaveBeenCalledTimes(1);
    releaseFirstDownload();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { filePath: '/project/data/AI 图片.png', assetUrl: 'asset:///project/data/AI 图片.png' },
      { filePath: '/project/data/AI 图片_1.png', assetUrl: 'asset:///project/data/AI 图片_1.png' },
    ]);
    expect(mocks.resolveUniqueDestPath).toHaveBeenCalledTimes(2);
  });

  it('writes base64 image results directly into the project directory', async () => {
    const result = await downloadUrlAndSave(
      'data:image/png;base64,AQID',
      'project-1',
      'ai-image',
      '自定义接口图片',
    );

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledWith(
      '/project/data/自定义接口图片.png',
      new Uint8Array([1, 2, 3]),
    );
    expect(result).toEqual({
      filePath: '/project/data/自定义接口图片.png',
      assetUrl: 'asset:///project/data/自定义接口图片.png',
    });
  });

  it('writes blob video results directly into the project directory', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      new Uint8Array([4, 5, 6]),
      { headers: { 'content-type': 'video/mp4' } },
    ));

    const result = await downloadUrlAndSave(
      'blob:http://localhost/generated-video',
      'project-1',
      'ai-video',
      '自定义接口视频',
    );

    expect(fetchMock).toHaveBeenCalledWith('blob:http://localhost/generated-video');
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledWith(
      '/project/data/自定义接口视频.mp4',
      new Uint8Array([4, 5, 6]),
    );
    expect(result).toEqual({
      filePath: '/project/data/自定义接口视频.mp4',
      assetUrl: 'asset:///project/data/自定义接口视频.mp4',
    });

    fetchMock.mockRestore();
  });

  it('allocates local processor outputs inside the project directory', async () => {
    await expect(resolveProjectOutputPath('project-1', '主体识别.png'))
      .resolves.toBe('/project/data/主体识别.png');
    expect(mocks.resolveUniqueDestPath).toHaveBeenCalledWith('/project/data', '主体识别.png');
  });
});

describe('persistMediaUrlToProjectData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauriEnv.mockReturnValue(true);
    mocks.ensureProjectDataDir.mockResolvedValue('/project/data');
    mocks.resolveUniqueDestPath.mockImplementation(async (dataDir: string, fileName: string) => (
      `${dataDir}/${fileName}`
    ));
  });

  it('keeps the source url when there is no project directory to write into', async () => {
    mocks.isTauriEnv.mockReturnValue(false);

    await expect(persistMediaUrlToProjectData(
      'https://cdn.example/generated.png',
      'project-1',
      'ai-image',
      '自定义接口图片',
    )).resolves.toEqual({
      mediaUrl: 'https://cdn.example/generated.png',
      sourceUrl: 'https://cdn.example/generated.png',
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('refuses inline media when there is no project directory to write into', async () => {
    mocks.isTauriEnv.mockReturnValue(false);

    await expect(persistMediaUrlToProjectData(
      'data:image/png;base64,AQID',
      'project-1',
      'ai-image',
      '自定义接口图片',
    )).rejects.toThrow('当前环境没有项目目录');
  });

  it('fails closed instead of returning a temporary media url', async () => {
    mocks.ensureProjectDataDir.mockResolvedValueOnce(null);

    await expect(persistMediaUrlToProjectData(
      'https://cdn.example/generated.png',
      'project-1',
      'ai-image',
      '自定义接口图片',
    )).rejects.toThrow('生成媒体未能写入项目目录');
  });
});
