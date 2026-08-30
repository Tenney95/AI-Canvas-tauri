import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  arrayBufferToBase64: vi.fn(),
  bytePartsToBase64Async: vi.fn(),
  ensureProjectDataDir: vi.fn(),
  getConvertFileSrc: vi.fn(),
  invoke: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  resolveUniqueDestPath: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: mocks.readFile,
  rename: vi.fn(),
  stat: mocks.stat,
  writeFile: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open, save: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('../../src/services/fs/assetIndex', () => ({ identifyAsset: vi.fn() }));
vi.mock('../../src/services/fs/assetLibrary', () => ({ walkDirectoryFiles: vi.fn() }));
vi.mock('../../src/services/fs/core', () => ({
  arrayBufferToBase64: mocks.arrayBufferToBase64,
  bytePartsToBase64Async: mocks.bytePartsToBase64Async,
  buildNodeFileName: vi.fn(),
  ensureProjectDataDir: mocks.ensureProjectDataDir,
  getConvertFileSrc: mocks.getConvertFileSrc,
  getFileCategory: vi.fn(),
  getMimeType: (ext: string) => ({
    png: 'image/png',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    m4v: 'video/x-m4v',
    opus: 'audio/opus',
    wma: 'audio/x-ms-wma',
    wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv',
  })[ext] ?? 'application/octet-stream',
  getProjectDataDir: vi.fn(),
  isTauriEnv: () => true,
  notifyProjectDiskChanged: vi.fn(),
  resolveUniqueDestPath: mocks.resolveUniqueDestPath,
  sanitizeFileName: (name: string) => name,
  stripVerbatimPrefix: (path: string) => path,
}));

import {
  MEDIA_DATA_URL_MAX_BYTES,
  MEDIA_DATA_URL_MAX_HEADER_CHARS,
  assertMediaDataUrlBudgetAvailable,
  assertMediaDataUrlWithinLimitAsync,
  consumeMediaDataUrlBudget,
  createMediaDataUrlBudget,
  estimateMediaDataUrlBytes,
  estimateMediaDataUrlBytesAsync,
  inferMediaDataUrlKind,
  isMediaDataUrl,
  assertMediaDataUrlSize,
  assertMediaDataUrlWithinLimit,
  readFileToDataUrl,
  uploadSourceFileToProject,
} from '../../src/services/fileService';

describe('fileService Data URL 内存预算', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.arrayBufferToBase64.mockReturnValue('AQIDBA==');
    mocks.bytePartsToBase64Async.mockResolvedValue('AQIDBA==');
    mocks.stat.mockResolvedValue({ size: 4 });
  });

  it('在读取大视频前根据 stat 拒绝，避免完整文件进入 WebView', async () => {
    mocks.stat.mockResolvedValue({ size: MEDIA_DATA_URL_MAX_BYTES.video + 1 });

    await expect(readFileToDataUrl('G:/media/large.mp4', { kind: 'video' }))
      .rejects.toThrow('超过内存转换上限 64 MiB');
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('小图片保持现有 Data URL 兼容路径', async () => {
    mocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));

    await expect(readFileToDataUrl('G:/media/small.png', { kind: 'image' }))
      .resolves.toBe('data:image/png;base64,AQIDBA==');
    expect(mocks.readFile).toHaveBeenCalledOnce();
  });

  it('取消发生在原生读取期间时不再进入 Base64 编码', async () => {
    let finishRead: (bytes: Uint8Array) => void = () => undefined;
    mocks.readFile.mockImplementation(() => new Promise<Uint8Array>((resolve) => {
      finishRead = resolve;
    }));
    const controller = new AbortController();
    const task = readFileToDataUrl('G:/media/cancelled.png', {
      kind: 'image',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.readFile).toHaveBeenCalledOnce());
    controller.abort(new DOMException('用户取消', 'AbortError'));
    finishRead(new Uint8Array([1, 2, 3, 4]));

    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.bytePartsToBase64Async).not.toHaveBeenCalled();
  });

  it('直接收到超限 Base64 data URL 时无需 atob 即拒绝', () => {
    const encodedLength = Math.ceil((MEDIA_DATA_URL_MAX_BYTES.other + 1) / 3) * 4;
    expect(() => assertMediaDataUrlWithinLimit(
      `data:application/octet-stream;base64,${'A'.repeat(encodedLength)}`,
      'other',
      '文件参考',
    )).toThrow('超过内存转换上限 8 MiB');
    expect(() => assertMediaDataUrlSize(
      MEDIA_DATA_URL_MAX_BYTES.audio + 1,
      'audio',
      '音频参考',
    )).toThrow('超过内存转换上限 32 MiB');
  });

  it('Data URL 元数据超限时在缓存或解码前拒绝', () => {
    const oversizedHeader = `data:image/png;name=${'x'.repeat(MEDIA_DATA_URL_MAX_HEADER_CHARS)},AQID`;
    expect(() => assertMediaDataUrlWithinLimit(oversizedHeader, 'image', '图片参考'))
      .toThrow('Data URL 元数据长度');
    expect(() => estimateMediaDataUrlBytes(`data:image/png;base64${'x'.repeat(5000)}`))
      .toThrow('Data URL 元数据长度');
    expect(() => estimateMediaDataUrlBytes('data:image/png;base64AQID'))
      .toThrow('Data URL 格式无效');
  });

  it('大 Data URL 预算扫描会让出事件循环并响应取消', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('取消预算扫描', 'AbortError')), 0);
    const dataUrl = `data:video/mp4;base64,${'A'.repeat(2 * 1024 * 1024)}`;

    await expect(estimateMediaDataUrlBytesAsync(dataUrl, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(assertMediaDataUrlWithinLimitAsync(
      'data:image/png;base64,AQIDBA==',
      'image',
    )).resolves.toBe(4);
  });

  it('按实际 padding 估算 Base64，并对整次请求执行累计预算', () => {
    expect(estimateMediaDataUrlBytes('data:audio/mpeg;base64,AQIDBA==')).toBe(4);
    const budget = createMediaDataUrlBudget('测试参考媒体', 6);
    consumeMediaDataUrlBudget(budget, 'data:audio/mpeg;base64,AQID');
    expect(budget.usedBytes).toBe(3);
    expect(() => consumeMediaDataUrlBudget(
      budget,
      'data:audio/mpeg;base64,AQIDBA==',
    )).toThrow('测试参考媒体累计大小');
  });

  it('请求级剩余预算不足时在读取文件前拒绝', async () => {
    const budget = createMediaDataUrlBudget('本次测试参考', 6);
    budget.usedBytes = 3;
    mocks.stat.mockResolvedValue({ size: 4 });

    expect(() => assertMediaDataUrlBudgetAvailable(budget, 4))
      .toThrow('本次测试参考累计大小');
    await expect(readFileToDataUrl('G:/media/small.png', {
      kind: 'image',
      dataUrlBudget: budget,
    })).rejects.toThrow('本次测试参考累计大小');
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('常见补充媒体扩展名不会误落入 8 MiB other 预算', () => {
    for (const extension of ['m4a', 'opus', 'wma']) {
      expect(inferMediaDataUrlKind(`G:/media/sample.${extension}`)).toBe('audio');
    }
    for (const extension of ['m4v', 'wmv', 'flv']) {
      expect(inferMediaDataUrlKind(`G:/media/sample.${extension}`)).toBe('video');
    }
  });

  it('推断 Data URL 类型时只对有界 header 做小写化', () => {
    const originalToLowerCase = String.prototype.toLowerCase;
    const normalizedLengths: number[] = [];
    const spy = vi.spyOn(String.prototype, 'toLowerCase').mockImplementation(function lowerCase(
      this: string,
    ) {
      normalizedLengths.push(this.length);
      return originalToLowerCase.call(this);
    });
    try {
      expect(inferMediaDataUrlKind(`data:video/mp4;base64,${'A'.repeat(1024 * 1024)}`))
        .toBe('video');
    } finally {
      spy.mockRestore();
    }
    expect(Math.max(...normalizedLengths)).toBeLessThanOrEqual(MEDIA_DATA_URL_MAX_HEADER_CHARS + 1);
    expect(isMediaDataUrl('DATA:image/png;base64,AQID')).toBe(true);
  });

  it('无正式项目的源视频在 fallback 读取前执行预算', async () => {
    mocks.open.mockResolvedValue('G:/media/large.mp4');
    mocks.stat.mockResolvedValue({ size: MEDIA_DATA_URL_MAX_BYTES.video + 1 });

    await expect(uploadSourceFileToProject('.mp4', 'default'))
      .rejects.toThrow('超过内存转换上限 64 MiB');
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('正式项目的大媒体仍使用原生流式拷贝，不进入 Data URL 路径', async () => {
    const largeSize = MEDIA_DATA_URL_MAX_BYTES.video * 2;
    mocks.open.mockResolvedValue('G:/media/large.mp4');
    mocks.stat.mockResolvedValue({ size: largeSize });
    mocks.ensureProjectDataDir.mockResolvedValue('G:/project/data');
    mocks.resolveUniqueDestPath.mockResolvedValue('G:/project/data/large.mp4');
    mocks.invoke.mockResolvedValue({
      path: 'G:/project/data/large.mp4',
      totalBytes: largeSize,
      contentType: 'video/mp4',
    });
    mocks.getConvertFileSrc.mockResolvedValue((path: string) => `asset://localhost/${path}`);

    await expect(uploadSourceFileToProject('.mp4', 'project-1')).resolves.toMatchObject({
      dataUrl: 'asset://localhost/G:/project/data/large.mp4',
      fileName: 'large.mp4',
      fileSize: largeSize,
      filePath: 'G:/project/data/large.mp4',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('copy_file_streamed', expect.any(Object));
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
