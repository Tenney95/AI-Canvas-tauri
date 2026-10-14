import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  convertFileSrc: vi.fn((p: string) => `asset://localhost/${encodeURIComponent(p)}`),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  readFile: mocks.readFile,
  rename: vi.fn(),
  stat: vi.fn(),
  writeFile: mocks.writeFile,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: mocks.save }));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: mocks.convertFileSrc, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: vi.fn(), localDataDir: vi.fn() }));
vi.mock('../../src/services/fs/core', () => ({
  CATEGORY_EXTENSIONS: {},
  arrayBufferToBase64: vi.fn(),
  buildNodeFileName: vi.fn(),
  ensureProjectDataDir: vi.fn(),
  getConvertFileSrc: () => null,
  getFileCategory: vi.fn(),
  getMimeType: vi.fn(),
  getProjectDataDir: vi.fn(),
  isTauriEnv: () => true,
  joinPath: (...parts: string[]) => parts.join('/'),
  notifyProjectDiskChanged: vi.fn(),
  resolveUniqueDestPath: vi.fn(),
  sanitizeFileName: (name: string) => name,
  sanitizeFolderName: (name: string) => name,
  stripVerbatimPrefix: (p: string) => p,
}));

import { saveNodeOutputToFile } from '../../src/services/fileService';

/** mac 的 asset URL 形如 asset://localhost/<encoded path>；Windows 是 http://asset.localhost/… */
const MAC_ASSET_URL = 'asset://localhost/%2FUsers%2Fme%2FLibrary%2Fout.png';

describe('saveNodeOutputToFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readFile.mockReset();
    mocks.save.mockResolvedValue('/Users/me/Desktop/out.png');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      // 只有原样的 asset URL 才可读；被 convertFileSrc 二次编码后取不到文件
      if (url !== MAC_ASSET_URL) return { ok: false, status: 404 };
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }));
  });

  it('mac 的 asset:// URL 直接 fetch，不再二次 convertFileSrc', async () => {
    const dest = await saveNodeOutputToFile({
      mediaUrl: MAC_ASSET_URL,
      nodeType: 'ai-image',
      fileName: 'out.png',
    });

    expect(dest).toBe('/Users/me/Desktop/out.png');
    expect(mocks.convertFileSrc).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledWith(dest, new Uint8Array([1, 2, 3]));
  });

  it('源文件读不出来时回退到节点 URL', async () => {
    mocks.readFile.mockRejectedValue(new Error('ENOENT'));

    const dest = await saveNodeOutputToFile({
      filePath: '/gone/out.png',
      mediaUrl: MAC_ASSET_URL,
      nodeType: 'ai-image',
      fileName: 'out.png',
    });

    expect(dest).toBe('/Users/me/Desktop/out.png');
    expect(mocks.writeFile).toHaveBeenCalledWith(dest, new Uint8Array([1, 2, 3]));
  });

  it('没有任何可回退内容时仍然抛错', async () => {
    mocks.readFile.mockRejectedValue(new Error('ENOENT'));
    await expect(
      saveNodeOutputToFile({ filePath: '/gone/out.png', nodeType: 'ai-image' }),
    ).rejects.toThrow('ENOENT');
  });

  it.each(['wav', 'mp3', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus'])(
    '上传的 %s 音频另存为保留原扩展名和文件字节',
    async (extension) => {
      const bytes = new Uint8Array([82, 73, 70, 70, 0, 255, 87, 65, 86, 69]);
      const filePath = `C:\\project.v1\\录音.${extension.toUpperCase()}`;
      const destPath = `/Users/me/Desktop/录音.${extension}`;
      mocks.readFile.mockResolvedValue(bytes);
      mocks.save.mockResolvedValue(destPath);

      const dest = await saveNodeOutputToFile({
        filePath,
        fileName: `录音.${extension.toUpperCase()}`,
        nodeType: 'ai-audio',
      });

      expect(dest).toBe(destPath);
      expect(mocks.save).toHaveBeenCalledWith({
        defaultPath: `录音.${extension}`,
        filters: [{ name: '音频文件', extensions: [extension] }, { name: '所有文件', extensions: ['*'] }],
      });
      expect(mocks.readFile).toHaveBeenCalledWith(filePath);
      expect(mocks.writeFile).toHaveBeenCalledWith(dest, bytes);
    },
  );

  it('音频本地文件的格式优先于展示文件名', async () => {
    mocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    await saveNodeOutputToFile({
      filePath: '/project/录音.wav',
      fileName: '已改名.mp3',
      nodeType: 'source-audio',
    });

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: '已改名.wav' }));
  });

  it.each([
    { fileName: '录音.flac', mediaUrl: 'data:application/octet-stream;base64,AQID', defaultPath: '录音.flac' },
    { mediaUrl: 'data:audio/x-wav;base64,AQID', defaultPath: 'output.wav' },
    { mediaUrl: 'data:audio/flac;base64,AQID', defaultPath: 'output.flac' },
    { mediaUrl: 'data:audio/mp4;base64,AQID', defaultPath: 'output.m4a' },
    { mediaUrl: MAC_ASSET_URL.replace('out.png', '录音.wav'), defaultPath: 'output.wav' },
    { mediaUrl: 'https://example.com/view?filename=录音.ogg', defaultPath: 'output.ogg' },
  ])('无本地路径时从文件名或媒体格式推断 $defaultPath', async ({ defaultPath, ...source }) => {
    const destPath = `/Users/me/Desktop/${defaultPath}`;
    mocks.save.mockResolvedValue(destPath);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as Response);

    await saveNodeOutputToFile({ ...source, nodeType: 'ai-audio' });

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath,
      filters: [{ name: '音频文件', extensions: [defaultPath.split('.').pop()] }, { name: '所有文件', extensions: ['*'] }],
    }));
    expect(mocks.writeFile).toHaveBeenCalledWith(destPath, new Uint8Array([1, 2, 3]));
  });

  it('取消音频另存为不读取或写入文件', async () => {
    mocks.save.mockResolvedValue(null);
    await expect(saveNodeOutputToFile({
      filePath: '/project/录音.wav',
      fileName: '录音.wav',
      nodeType: 'ai-audio',
    })).resolves.toBeNull();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
