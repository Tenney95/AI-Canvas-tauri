/**
 * comfyImageSource — 回归测试：Comfy 图片原生展示源。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireComfyImageSource, readNativeComfyImageBlob, shouldLoadNativeComfyImage } from '../../src/services/comfyImageSource';

const mocks = vi.hoisted(() => ({ native: vi.fn(), desktop: vi.fn(() => true), config: { comfyUIUrl: '', comfyServers: [] as Array<{ url: string }> } }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({ config: mocks.config }) } }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: mocks.desktop }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.native }));
const source = 'http://127.0.0.1:8188/view?filename=output.png&type=output';

beforeEach(() => {
  mocks.desktop.mockReturnValue(true);
  mocks.config.comfyUIUrl = '';
  mocks.config.comfyServers = [];
  mocks.native.mockReset().mockImplementation(async () => new Response(new Blob(['image'], { type: 'image/png' })));
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:comfy-image');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Comfy 图片原生展示源', () => {
  it('匹配本机默认与已配置目标的精确协议、端口和反代路径', () => {
    expect(shouldLoadNativeComfyImage(source)).toBe(true);
    expect(shouldLoadNativeComfyImage(source.replace('127.0.0.1', 'localhost'))).toBe(true);
    expect(shouldLoadNativeComfyImage(source.replace('127.0.0.1', '[::1]'))).toBe(true);
    expect(shouldLoadNativeComfyImage(source.replace(':8188', ':8189'))).toBe(false);
    expect(shouldLoadNativeComfyImage(source.replace('http:', 'https:'))).toBe(false);
    mocks.config.comfyUIUrl = 'http://localhost:8288/comfy/';
    mocks.config.comfyServers = [{ url: 'https://gpu.example.test:8443/tools/comfy' }];
    expect(shouldLoadNativeComfyImage('http://127.0.0.1:8288/comfy/view?filename=a.png')).toBe(true);
    expect(shouldLoadNativeComfyImage('https://gpu.example.test:8443/tools/comfy/view?filename=a.png&preview=webp')).toBe(true);
    expect(shouldLoadNativeComfyImage('https://gpu.example.test:8443/tools/comfy-evil/view?filename=a.png')).toBe(false);
    expect(shouldLoadNativeComfyImage('https://gpu.example.test:8444/tools/comfy/view?filename=a.png')).toBe(false);
  });
  it('不接管普通图片、未知服务器、带凭据或片段的地址及非桌面场景', () => {
    for (const value of [
      'https://cdn.example.test/a.png', 'https://gpu.example.test/view?filename=a.png',
      source.replace('127.0.0.1', '127.0.0.1.evil.test'), source.replace('127.0.0.1', 'user:pass@127.0.0.1'),
      `${source}#fragment`, 'http://127.0.0.1:8188/view', 'asset://localhost/a.png', 'blob:original',
    ]) expect(shouldLoadNativeComfyImage(value)).toBe(false);
    mocks.desktop.mockReturnValue(false);
    expect(shouldLoadNativeComfyImage(source)).toBe(false);
  });
  it('原生读取后仅返回临时 blob 地址，释放幂等，不向服务借用请求头', async () => {
    const lease = await acquireComfyImageSource(source, new AbortController().signal);
    expect(lease.src).toBe('blob:comfy-image');
    expect(mocks.native).toHaveBeenCalledExactlyOnceWith(source, { signal: expect.any(AbortSignal) });
    expect(fetch).not.toHaveBeenCalled();
    lease.release(); lease.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:comfy-image');
  });
  it('403 失败不回落浏览器直连，且不会产生可显示的裸链接', async () => {
    mocks.native.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(acquireComfyImageSource(source, new AbortController().signal)).rejects.toThrow('HTTP 403');
    expect(fetch).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('拒绝超大、非图片和空内容，取消后不创建 blob 租约', async () => {
    mocks.native.mockResolvedValueOnce(new Response('small body', { headers: { 'content-length': String(33 * 1024 * 1024) } }));
    await expect(readNativeComfyImageBlob(source, new AbortController().signal)).rejects.toThrow('32 MiB');
    mocks.native.mockResolvedValueOnce(new Response('blocked', { headers: { 'content-type': 'text/html' } }));
    await expect(readNativeComfyImageBlob(source, new AbortController().signal)).rejects.toThrow('不是图片');
    mocks.native.mockResolvedValueOnce(new Response(null));
    await expect(readNativeComfyImageBlob(source, new AbortController().signal)).rejects.toThrow('为空');
    const request = new AbortController();
    mocks.native.mockImplementationOnce(async () => { request.abort(); return new Response(new Blob(['image'], { type: 'image/png' })); });
    await expect(acquireComfyImageSource(source, request.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('按实际流字节执行默认限制，全屏可使用无额外字节上限的读取', async () => {
    const image = new Blob([new Uint8Array(32 * 1024 * 1024 + 1)], { type: 'image/png' });
    mocks.native.mockImplementation(async () => new Response(image));
    await expect(acquireComfyImageSource(source, new AbortController().signal)).rejects.toThrow('32 MiB');
    await expect(readNativeComfyImageBlob(source, new AbortController().signal, Infinity)).resolves.toMatchObject({
      size: image.size,
      type: image.type,
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('非 Comfy 与浏览器保留原地址，同源消费者的独立租约互不撤销', async () => {
    const normal = await acquireComfyImageSource('https://cdn.example.test/a.png', new AbortController().signal);
    expect(normal.src).toBe('https://cdn.example.test/a.png');
    mocks.desktop.mockReturnValue(false);
    expect((await acquireComfyImageSource(source, new AbortController().signal)).src).toBe(source);
    expect(mocks.native).not.toHaveBeenCalled();
    mocks.desktop.mockReturnValue(true);
    vi.mocked(URL.createObjectURL).mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
    const first = await acquireComfyImageSource(source, new AbortController().signal);
    const second = await acquireComfyImageSource(source, new AbortController().signal);
    first.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:first');
    second.release();
    expect(URL.revokeObjectURL).toHaveBeenLastCalledWith('blob:second');
  });
});
