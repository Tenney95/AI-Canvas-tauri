import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyImage, copyFile, readClipboardFolders } from '../../src/services/clipboardService';

const native = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn(), tauri: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => native.tauri }));
vi.mock('../../src/services/fileService', () => ({ downloadUrlAndSave: native.save }));

class ClipboardItemMock {
  readonly data: Record<string, Promise<string | Blob>>;

  static supports(type: string) {
    return type === 'image/png';
  }

  constructor(data: Record<string, Promise<string | Blob>>) {
    this.data = data;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  native.invoke.mockReset();
  native.save.mockReset();
  native.tauri = true;
});

describe('clipboardService.copyImage', () => {
  it('在图片读取完成前调用 clipboard.write，保留 WebKit 用户手势', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchPending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const write = vi.fn(async (items: ClipboardItemMock[]) => {
      const blob = await items[0].data['image/png'];
      expect(blob).toBeInstanceOf(Blob);
      expect((blob as Blob).type).toBe('image/png');
    });
    vi.stubGlobal('fetch', vi.fn(() => fetchPending));
    vi.stubGlobal('ClipboardItem', ClipboardItemMock);
    vi.stubGlobal('navigator', { clipboard: { write } });

    const result = copyImage('data:image/png;base64,cG5n');
    expect(write).toHaveBeenCalledTimes(1);

    resolveFetch({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    } as Response);
    await expect(result).resolves.toBe(true);
  });

  it('JPEG 不受支持时直接复制节点原文件，不读取或转码图片', async () => {
    const fetchImage = vi.fn();
    const write = vi.fn();
    vi.stubGlobal('fetch', fetchImage);
    vi.stubGlobal('ClipboardItem', ClipboardItemMock);
    vi.stubGlobal('navigator', { clipboard: { write } });
    native.invoke.mockResolvedValue(undefined);

    await expect(copyImage('https://example.com/photo.jpg', { filePath: 'C:/project/photo.jpg' })).resolves.toBe(true);
    expect(native.invoke).toHaveBeenCalledWith('copy_files_to_clipboard', { paths: ['C:/project/photo.jpg'] });
    expect(fetchImage).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(native.save).not.toHaveBeenCalled();
  });

  it('缺少 ClipboardItem 时从素材 URL 还原真实路径，优先于节点旧路径', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    vi.stubGlobal('navigator', { clipboard: {} });
    native.invoke.mockResolvedValue(undefined);

    await expect(copyImage('http://asset.localhost/C%3A%2Fproject%2Fphoto.jpg', {
      filePath: 'C:/project/old.jpg',
    })).resolves.toBe(true);
    expect(native.invoke).toHaveBeenCalledWith('copy_files_to_clipboard', { paths: ['C:/project/photo.jpg'] });
  });

  it.each(['https://example.com/photo.jpg', 'data:image/jpeg;base64,anBlZw=='])('无本地文件时先保存图片到捕获的项目：%s', async (source) => {
    vi.stubGlobal('ClipboardItem', undefined);
    vi.stubGlobal('navigator', { clipboard: {} });
    native.save.mockResolvedValue({ filePath: 'C:/project/saved.jpg' });
    native.invoke.mockResolvedValue(undefined);

    await expect(copyImage(source, { projectId: 'project-a' })).resolves.toBe(true);
    expect(native.save).toHaveBeenCalledWith(source, 'project-a', 'image', undefined, {
      deduplicateByContent: true, throwOnError: true,
    });
    expect(native.invoke).toHaveBeenCalledWith('copy_files_to_clipboard', { paths: ['C:/project/saved.jpg'] });
  });

  it.each(['NotSupportedError', 'NotAllowedError'])('实际写入失败只对不支持错误降级：%s', async (name) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    }));
    vi.stubGlobal('ClipboardItem', ClipboardItemMock);
    const write = vi.fn().mockRejectedValue(Object.assign(new Error('write failed'), { name }));
    vi.stubGlobal('navigator', { clipboard: { write } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    native.invoke.mockResolvedValue(undefined);

    await expect(copyImage('https://example.com/photo.png', { filePath: 'C:/project/photo.png' })).resolves.toBe(name === 'NotSupportedError');
    expect(native.invoke).toHaveBeenCalledTimes(name === 'NotSupportedError' ? 1 : 0);
  });

  it('Web 环境不执行原生降级，原生权限或保存失败不误报成功', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    vi.stubGlobal('navigator', { clipboard: {} });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    native.tauri = false;
    await expect(copyImage('https://example.com/photo.jpg', { filePath: 'C:/private/photo.jpg' })).resolves.toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();
    native.tauri = true;
    native.invoke.mockRejectedValue(new Error('未授权文件'));
    await expect(copyImage('https://example.com/photo.jpg', { filePath: 'C:/private/photo.jpg' })).resolves.toBe(false);
    native.save.mockRejectedValue(new Error('下载失败'));
    await expect(copyImage('https://example.com/photo.jpg', { projectId: 'project-a' })).resolves.toBe(false);
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
});

describe('folder clipboard interoperability', () => {
  it('writes a directory through the system file clipboard and reads the current clipboard each time', async () => {
    native.tauri = true;
    native.invoke.mockReset().mockResolvedValueOnce(undefined).mockResolvedValueOnce(['/library/人物']).mockResolvedValueOnce(['/library/场景']);
    await expect(copyFile('/library/人物')).resolves.toBe(true);
    expect(native.invoke).toHaveBeenNthCalledWith(1, 'copy_files_to_clipboard', { paths: ['/library/人物'] });
    await expect(readClipboardFolders()).resolves.toEqual(['/library/人物']);
    await expect(readClipboardFolders()).resolves.toEqual(['/library/场景']);
    expect(native.invoke).toHaveBeenNthCalledWith(3, 'read_asset_folder_clipboard');
  });
  it('propagates native authorization failures and does not claim a browser folder clipboard', async () => {
    native.tauri = true;
    native.invoke.mockReset().mockRejectedValue(new Error('未授权目录'));
    await expect(readClipboardFolders()).rejects.toThrow('未授权目录');
    native.tauri = false;
    await expect(copyFile('/library/人物')).resolves.toBe(false);
    await expect(readClipboardFolders()).rejects.toThrow('仅支持桌面');
    expect(native.invoke).toHaveBeenCalledTimes(1);
    native.tauri = true;
  });
});
