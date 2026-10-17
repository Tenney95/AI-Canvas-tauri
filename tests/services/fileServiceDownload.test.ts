import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appDataDir: vi.fn(async () => '/project/app'),
  ensureProjectDataDir: vi.fn(),
  exists: vi.fn(async (_path: string) => false),
  invoke: vi.fn(),
  isTauriEnv: vi.fn(() => true),
  notifyProjectDiskChanged: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
  lstat: vi.fn(),
  retired: vi.fn(),
  resolveUniqueDestPath: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mocks.exists,
  mkdir: vi.fn(),
  readDir: mocks.readDir,
  readFile: mocks.readFile,
  lstat: mocks.lstat,
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
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: mocks.appDataDir, localDataDir: vi.fn() }));
vi.mock('../../src/services/indexedDb/mediaRelocations', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/indexedDb/mediaRelocations')>(),
  retiredMediaPaths: mocks.retired,
}));
vi.mock('../../src/services/fs/core', () => ({
  CATEGORY_EXTENSIONS: {},
  arrayBufferToBase64: vi.fn(),
  buildNodeFileName: (label: string, ext: string) => `${label}${ext}`,
  ensureProjectDataDir: mocks.ensureProjectDataDir,
  getAssetUrlFromPath: async (path: string) => `asset://${path}`,
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
  stripVerbatimPrefix: (path: string) => path,
}));

import {
  copyFileToProjectData,
  downloadUrlAndSave,
  persistMediaUrlToProjectData,
  resolveProjectOutputPath,
  saveBinaryToProjectData,
  saveDataUrlToProjectData,
} from '../../src/services/fileService';

function mockMediaDisk(initial: Record<string, Uint8Array> = {}) {
  const files = new Map(Object.entries(initial));
  mocks.exists.mockImplementation(async (path: string) => files.has(path));
  mocks.readDir.mockImplementation(async (directory: string) => [...files.keys()]
    .filter((path) => path.slice(0, path.lastIndexOf('/')) === directory)
    .map((path) => ({ name: path.slice(path.lastIndexOf('/') + 1), isFile: true, isSymlink: false })));
  mocks.lstat.mockImplementation(async (path: string) => ({ isFile: true, isSymlink: false, size: files.get(path)?.byteLength }));
  mocks.readFile.mockImplementation(async (path: string) => files.get(path));
  mocks.writeFile.mockImplementation(async (path: string, bytes: Uint8Array) => {
    if (files.has(path)) throw new Error('destination exists');
    files.set(path, bytes);
  });
  mocks.resolveUniqueDestPath.mockImplementation(async (directory: string, fileName: string) => {
    const dot = fileName.lastIndexOf('.');
    const base = dot > 0 ? fileName.slice(0, dot) : fileName;
    const extension = dot > 0 ? fileName.slice(dot) : '';
    const retired = await mocks.retired() as ReadonlySet<string>;
    let path = `${directory}/${fileName}`;
    for (let i = 1; files.has(path) || retired.has(path); i++) path = `${directory}/${base}_${i}${extension}`;
    return path;
  });
  return files;
}

afterEach(() => vi.unstubAllGlobals());

describe('downloadUrlAndSave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauriEnv.mockReturnValue(true);
    mocks.ensureProjectDataDir.mockResolvedValue('/project/data');
    mocks.exists.mockResolvedValue(false);
    mocks.readDir.mockReset().mockResolvedValue([]);
    mocks.readFile.mockReset();
    mocks.lstat.mockReset();
    mocks.retired.mockReset().mockResolvedValue(new Set());
    mocks.writeFile.mockReset();
    mocks.resolveUniqueDestPath.mockImplementation(async (dataDir: string, fileName: string) => (
      `${dataDir}/${fileName}`
    ));
  });

  it('reuses the same shared media file across episodes without allocating or writing a copy', async () => {
    const filePath = '/project/data/Library/角色.png';
    mocks.invoke.mockResolvedValue({ path: filePath, totalBytes: 3, contentType: null });
    const options = { reuseExistingProjectFile: true, redactErrors: true };
    for (const episodeId of ['episode-1', 'episode-2']) {
      await expect(copyFileToProjectData(filePath, episodeId, options)).resolves.toEqual({
        filePath, assetUrl: `asset://${filePath}`, fileName: '角色.png',
      });
    }
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenCalledWith('copy_file_streamed', expect.objectContaining({
      sourcePath: filePath, destinationPath: filePath, reuseRoot: '/project/data',
    }));
    expect(mocks.resolveUniqueDestPath).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.notifyProjectDiskChanged).not.toHaveBeenCalled();
  });

  it.each(['/external/图片.png', '/project/data-other/图片.png', '/project/data/../other/图片.png'])(
    'still copies external or non-project paths instead of treating them as shared: %s', async (sourcePath) => {
      mocks.invoke.mockResolvedValue({ path: '/project/data/图片.png', totalBytes: 3 });
      const result = await copyFileToProjectData(sourcePath, 'episode-2', { reuseExistingProjectFile: true });
      expect(result?.filePath).toBe('/project/data/图片.png');
      expect(mocks.resolveUniqueDestPath).toHaveBeenCalledOnce();
      expect(mocks.invoke.mock.calls[0][1]).not.toHaveProperty('reuseRoot');
      expect(mocks.notifyProjectDiskChanged).toHaveBeenCalledOnce();
    },
  );

  it('keeps ordinary node copies independent even when their source is in the project', async () => {
    mocks.resolveUniqueDestPath.mockResolvedValueOnce('/project/data/图片_1.png');
    mocks.invoke.mockResolvedValue({ path: '/project/data/图片_1.png', totalBytes: 3 });
    expect((await copyFileToProjectData('/project/data/图片.png', 'episode-1'))?.filePath)
      .toBe('/project/data/图片_1.png');
    expect(mocks.invoke.mock.calls[0][1]).not.toHaveProperty('reuseRoot');
  });

  it('fails closed when native validation rejects reuse instead of silently copying or disclosing paths', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('unapproved /private/path'));
    await expect(copyFileToProjectData('/project/data/图片.png', 'episode-1', {
      reuseExistingProjectFile: true, redactErrors: true,
    })).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.resolveUniqueDestPath).not.toHaveBeenCalled();
    expect(mocks.notifyProjectDiskChanged).not.toHaveBeenCalled();
  });

  it('does not reuse a path retired by a project media relocation', async () => {
    const filePath = '/project/data/图片.png';
    mocks.retired.mockResolvedValueOnce(new Set([filePath]));
    await expect(copyFileToProjectData(filePath, 'episode-1', {
      reuseExistingProjectFile: true, redactErrors: true,
    })).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.resolveUniqueDestPath).not.toHaveBeenCalled();
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
      { createNew: true },
    );
    expect(result).toEqual({
      filePath: '/project/data/自定义接口图片.png',
      assetUrl: 'asset:///project/data/自定义接口图片.png',
    });
  });

  it('reuses the same ordinary filename during persistence retries', async () => {
    mockMediaDisk();

    const first = await saveDataUrlToProjectData(
      'data:image/png;base64,AQID',
      'project-1',
      '历史图片.png',
      { deduplicateByContent: true },
    );
    const second = await saveDataUrlToProjectData(
      'data:image/png;base64,AQID',
      'project-1',
      '历史图片.png',
      { deduplicateByContent: true },
    );

    expect(first).toEqual(second);
    expect(first?.filePath).toBe('/project/data/历史图片.png');
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.notifyProjectDiskChanged).toHaveBeenCalledTimes(1);
  });

  it('numbers different content without overwriting a same-named file', async () => {
    const original = new Uint8Array([9, 9, 9]);
    const files = mockMediaDisk({ '/project/data/历史图片.png': original });
    const result = await saveDataUrlToProjectData('data:image/png;base64,AQID', 'project-1', '历史图片.png', { deduplicateByContent: true });
    expect(result?.filePath).toBe('/project/data/历史图片_1.png');
    expect(files.get('/project/data/历史图片.png')).toBe(original);
    expect(files.get('/project/data/历史图片_1.png')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('reuses a matching numbered file after a missing intermediate suffix', async () => {
    mockMediaDisk({
      '/project/data/历史图片.png': new Uint8Array([9, 9, 9]),
      '/project/data/历史图片_2.png': new Uint8Array([1, 2, 3]),
    });
    const result = await saveDataUrlToProjectData('data:image/png;base64,AQID', 'project-1', '历史图片.png', { deduplicateByContent: true });
    expect(result?.filePath).toBe('/project/data/历史图片_2.png');
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('creates only one file for concurrent retries of the same content', async () => {
    mockMediaDisk();
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      saveDataUrlToProjectData('data:image/png;base64,AQID', 'project-1', '历史图片.png', { deduplicateByContent: true })));
    expect(results.every((result) => result?.filePath === '/project/data/历史图片.png')).toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
  });

  it('serializes case-variant macOS retries and reuses the original disk spelling', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    mocks.ensureProjectDataDir.mockResolvedValue('/Users/p');
    const files = mockMediaDisk();
    const results = await Promise.all(['Result.png', 'result.PNG', 'RESULT.png'].map((name) =>
      saveDataUrlToProjectData('data:image/png;base64,AQID', 'project-1', name, { deduplicateByContent: true })));
    expect(results.map((result) => result?.filePath)).toEqual(Array(3).fill('/Users/p/Result.png'));
    expect(files.size).toBe(1);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing macOS normalization variant without creating another file', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    mocks.ensureProjectDataDir.mockResolvedValue('/Users/p');
    mockMediaDisk({ '/Users/p/Cafe\u0301.png': new Uint8Array([1, 2, 3]) });
    const result = await saveDataUrlToProjectData('data:image/png;base64,AQID', 'project-1', 'Café.png', { deduplicateByContent: true });
    expect(result?.filePath).toBe('/Users/p/Cafe\u0301.png');
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('keeps differently cased Linux filenames separate even for equal contents', async () => {
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' });
    mocks.ensureProjectDataDir.mockResolvedValue('/home/p');
    const files = mockMediaDisk({ '/home/p/Result.png': new Uint8Array([1, 2, 3]) });
    const result = await saveDataUrlToProjectData('data:image/png;base64,AQID', 'project-1', 'result.png', { deduplicateByContent: true });
    expect(result?.filePath).toBe('/home/p/result.png');
    expect(files.size).toBe(2);
  });

  it('does not reuse a retired source even when its contents still match', async () => {
    mockMediaDisk({ '/project/data/历史图片.png': new Uint8Array([1, 2, 3]) });
    mocks.retired.mockResolvedValue(new Set(['/project/data/历史图片.png']));
    const result = await saveDataUrlToProjectData('data:image/png;base64,AQID', 'project-1', '历史图片.png', { deduplicateByContent: true });
    expect(result?.filePath).toBe('/project/data/历史图片_1.png');
  });

  it.each(['stat', 'read'])('keeps saving when a deduplication candidate disappears during %s', async (stage) => {
    const path = '/project/data/历史图片.png';
    const files = mockMediaDisk({ [path]: new Uint8Array([1, 2, 3]) });
    const disappear = async () => {
      files.delete(path);
      throw new Error('No such file or directory (os error 2)');
    };
    if (stage === 'stat') mocks.lstat.mockImplementationOnce(disappear);
    else mocks.readFile.mockImplementationOnce(disappear);
    const result = await saveDataUrlToProjectData('data:image/png;base64,AQID', 'project-1', '历史图片.png',
      { deduplicateByContent: true, throwOnError: true });
    expect(result?.filePath).toBe(path);
    expect(files.get(path)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('does not conceal permission errors while reading a deduplication candidate', async () => {
    mockMediaDisk({ '/project/data/历史图片.png': new Uint8Array([1, 2, 3]) });
    mocks.readFile.mockRejectedValueOnce(new Error('Access is denied. (os error 5)'));
    await expect(saveDataUrlToProjectData('data:image/png;base64,AQID', 'project-1', '历史图片.png',
      { deduplicateByContent: true, throwOnError: true })).rejects.toThrow('Access is denied');
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('rechecks retirement before reusing a candidate moved during hashing', async () => {
    const path = '/project/data/历史图片.png';
    mockMediaDisk({ [path]: new Uint8Array([1, 2, 3]) });
    mocks.retired.mockResolvedValue(new Set([path])).mockResolvedValueOnce(new Set());
    const result = await saveDataUrlToProjectData('data:image/png;base64,AQID', 'project-1', '历史图片.png',
      { deduplicateByContent: true });
    expect(result?.filePath).toBe('/project/data/历史图片_1.png');
  });

  it('honors cancellation during the last retirement check before content reuse', async () => {
    mockMediaDisk({ '/project/data/图片.png': new Uint8Array([1, 2, 3]) });
    const controller = new AbortController();
    mocks.retired.mockResolvedValueOnce(new Set()).mockImplementationOnce(async () => {
      controller.abort();
      return new Set();
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/png' },
    }));
    await expect(downloadUrlAndSave('blob:http://localhost/result', 'project-1', 'image', '图片',
      { deduplicateByContent: true, signal: controller.signal, throwOnError: true })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.writeFile).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('returns the numbered disk filename when copying a same-named file', async () => {
    mocks.resolveUniqueDestPath.mockResolvedValueOnce('/project/data/帧动画_1.png');
    mocks.invoke.mockResolvedValueOnce({ path: '/project/data/帧动画_1.png', totalBytes: 3 });
    await expect(copyFileToProjectData('/source/帧动画.png', 'project-1')).resolves.toEqual({
      filePath: '/project/data/帧动画_1.png', assetUrl: 'asset:///project/data/帧动画_1.png', fileName: '帧动画_1.png',
    });
  });

  it('keeps optional copy and binary saves nullable when filename allocation fails', async () => {
    mocks.resolveUniqueDestPath.mockRejectedValue(new Error('journal unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(copyFileToProjectData('/source/图片.png', 'project-1')).resolves.toBeNull();
      await expect(saveBinaryToProjectData(new Uint8Array([1]), 'project-1', '图片.png')).resolves.toBeNull();
      await expect(saveBinaryToProjectData(new Uint8Array([1]), 'project-1', '图片.png',
        { throwOnError: true })).rejects.toThrow('journal unavailable');
      expect(mocks.writeFile).not.toHaveBeenCalled();
      expect(mocks.invoke).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('reuses an existing legacy content-addressed file without renaming it', async () => {
    const { sha256BytesHex } = await import('../../src/services/mediaDataUrl');
    const bytes = new Uint8Array([1, 2, 3]);
    const path = `/project/data/历史图片-${(await sha256BytesHex(bytes)).slice(0, 20)}.png`;
    mockMediaDisk({ [path]: bytes });
    const result = await saveDataUrlToProjectData('data:image/png;base64,AQID', 'project-1', '历史图片.png', { deduplicateByContent: true });
    expect(result?.filePath).toBe(path);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('uses ordinary names for deduplicated blob results too', async () => {
    mockMediaDisk();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/png' },
    }));
    const result = await downloadUrlAndSave('blob:http://localhost/result', 'project-1', 'image', '图片', { deduplicateByContent: true });
    expect(result?.filePath).toBe('/project/data/图片.png');
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
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

    expect(fetchMock).toHaveBeenCalledWith(
      'blob:http://localhost/generated-video',
      { signal: undefined },
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledWith(
      '/project/data/自定义接口视频.mp4',
      new Uint8Array([4, 5, 6]),
      { createNew: true },
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
    expect(mocks.resolveUniqueDestPath).toHaveBeenCalledWith('/project/data', '主体识别.png', true);
  });
});

describe('persistMediaUrlToProjectData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauriEnv.mockReturnValue(true);
    mocks.ensureProjectDataDir.mockResolvedValue('/project/data');
    mocks.exists.mockResolvedValue(false);
    mocks.readDir.mockReset().mockResolvedValue([]);
    mocks.readFile.mockReset();
    mocks.lstat.mockReset();
    mocks.retired.mockReset().mockResolvedValue(new Set());
    mocks.writeFile.mockReset();
    mocks.invoke.mockReset();
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

  it.each([
    ['directory', 'forbidden path: C:/private/user/project', '应用拒绝访问项目文件，请在设置中重新选择文件保存目录'],
    ['write', new Error('Access is denied. (os error 5): C:/private/user/image.png'), '系统拒绝写入项目目录，请检查目录的写入权限'],
    ['scan', 'forbidden path: C:/private/user/image.png', '应用拒绝访问项目文件，请在设置中重新选择文件保存目录'],
    ['download', '下载请求失败: HTTP 403 Forbidden https://cdn.example/image?token=private-token', '图片或媒体下载失败（HTTP 403）'],
    ['download', '目标磁盘空间不足，需要至少 999 字节，当前可用 1 字节', '目标磁盘空间不足'],
    ['download', '下载请求失败: connection timed out https://cdn.example/private-token', '下载媒体失败，请检查网络或媒体链接是否已失效'],
    ['write', new Error('unknown private-token C:/private/user/image.png'), '保存过程发生异常，请检查文件保存目录和媒体来源'],
  ])('reports a safe reason for %s failures', async (operation, failure, reason) => {
    const log = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    if (operation === 'directory') mocks.ensureProjectDataDir.mockRejectedValueOnce(failure);
    if (operation === 'write') mocks.writeFile.mockRejectedValueOnce(failure);
    if (operation === 'scan') mocks.readDir.mockRejectedValueOnce(failure);
    if (operation === 'download') mocks.invoke.mockRejectedValueOnce(failure);

    const error = await persistMediaUrlToProjectData(
      operation === 'download' ? 'https://cdn.example/generated.png' : 'data:image/png;base64,AQID',
      'project-1', 'ai-image', '图片', { deduplicateByContent: true },
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`生成媒体未能写入项目目录：${reason}`);
    expect(error).not.toHaveProperty('cause');
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    if (operation === 'directory' || operation === 'scan') expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.ensureProjectDataDir).toHaveBeenCalledWith('project-1', { throwOnError: true });
  });

  it('propagates blob write failures instead of replacing them with a generic failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1]), {
      headers: { 'content-type': 'image/png' },
    }));
    mocks.writeFile.mockRejectedValueOnce('forbidden path');

    await expect(persistMediaUrlToProjectData(
      'blob:http://localhost/generated-image', 'project-1', 'ai-image',
    )).rejects.toThrow('应用拒绝访问项目文件');
  });

  it('keeps optional download failures nullable for existing callers', async () => {
    mocks.writeFile.mockRejectedValueOnce(new Error('write failed'));
    await expect(downloadUrlAndSave('data:image/png;base64,AQID', 'project-1', 'ai-image'))
      .resolves.toBeNull();
  });

  it('preserves cancellation without putting the abort reason in the error', async () => {
    const controller = new AbortController();
    controller.abort(new Error('private-token'));
    await expect(persistMediaUrlToProjectData(
      'https://cdn.example/generated.png', 'project-1', 'ai-image', undefined, { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError', message: '媒体保存已取消' });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe('project directory error propagation', () => {
  it('lets strict persistence receive the real directory error without logging paths', async () => {
    const core = await vi.importActual<typeof import('../../src/services/fs/core')>('../../src/services/fs/core');
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    core.setBaseDataDir(undefined);
    const failure = new Error('forbidden path: C:/private/user/project');
    mocks.exists.mockRejectedValueOnce(failure);
    const log = vi.spyOn(console, 'error');

    await expect(core.ensureProjectDataDir('project-1', { throwOnError: true })).rejects.toBe(failure);
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps directory failures nullable for existing callers', async () => {
    const core = await vi.importActual<typeof import('../../src/services/fs/core')>('../../src/services/fs/core');
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    core.setBaseDataDir(undefined);
    mocks.exists.mockRejectedValueOnce(new Error('forbidden path'));

    await expect(core.ensureProjectDataDir('project-1')).resolves.toBeNull();
  });
});
