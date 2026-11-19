/**
 * comfyImageUtilityReads — 回归测试：ComfyUI image utility reads。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ matches: vi.fn(), read: vi.fn() }));
vi.mock('../../src/services/comfyImageSource', () => ({
  shouldLoadNativeComfyImage: native.matches, readNativeComfyImageBlob: native.read,
}));
vi.mock('../../src/services/uploadService', () => ({
  uploadToRemote: vi.fn(), isLocalImageUrl: vi.fn(), prepareReferenceImageDataUrl: vi.fn(),
}));
vi.mock('../../src/services/fileService', () => ({ assertMediaDataUrlSize: vi.fn(), getAssetUrlFromPath: vi.fn() }));
vi.mock('../../src/services/fs/core', () => ({ bytePartsToBase64Async: vi.fn() }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: vi.fn() }));
vi.mock('../../src/services/ai/referenceImageUpload', () => ({
  mapReferenceImagesInOrder: vi.fn(), prepareReferenceImageUpload: vi.fn(),
}));

import { imageUrlReachable, loadImage } from '../../src/services/ai/imageUtils';

const source = 'http://127.0.0.1:8188/view?filename=image.png&type=output';
const images: Array<{ src: string; decode: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn> }> = [];
let failDecode = false;

beforeEach(() => {
  images.length = 0; failDecode = false;
  native.matches.mockReset().mockReturnValue(true);
  native.read.mockReset().mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:comfy-image');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.stubGlobal('Image', class {
    private value = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decode = vi.fn(async () => { if (failDecode) throw new Error('decode failed'); });
    removeAttribute = vi.fn();
    constructor() { images.push(this); }
    set src(value: string) { this.value = value; queueMicrotask(() => this.onload?.()); }
    get src() { return this.value; }
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('ComfyUI image utility reads', () => {
  it('loads and decodes a native blob before releasing its temporary URL', async () => {
    const image = await loadImage(source);
    expect(native.read).toHaveBeenCalledWith(source, expect.any(AbortSignal));
    expect(image.src).toBe('blob:comfy-image');
    expect(images[0].decode).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:comfy-image');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports unreachable after native rejection without creating a browser request', async () => {
    native.read.mockRejectedValue(new Error('HTTP 403'));
    await expect(imageUrlReachable(source)).resolves.toBe(false);
    await expect(loadImage(source)).rejects.toThrow('HTTP 403');
    expect(images).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('propagates cancellation during a native probe as an abort', async () => {
    native.read.mockImplementationOnce((_url: string, signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = imageUrlReachable(source, undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(images).toHaveLength(0);
  });

  it('clears the browser image request when a probe is cancelled', async () => {
    native.matches.mockReturnValue(false);
    const controller = new AbortController();
    const pending = imageUrlReachable('https://cdn.example/image.png', undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(images[0].removeAttribute).toHaveBeenCalledWith('src');
  });

  it('releases a failed native decode without retrying the original URL', async () => {
    failDecode = true;
    await expect(loadImage(source)).rejects.toThrow('decode failed');
    expect(images).toHaveLength(1);
    expect(images[0].removeAttribute).toHaveBeenCalledWith('src');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:comfy-image');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps ordinary remote image loading on its existing path', async () => {
    native.matches.mockReturnValue(false);
    vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    await loadImage('https://cdn.example/image.png');
    expect(fetch).toHaveBeenCalledWith('https://cdn.example/image.png');
    expect(native.read).not.toHaveBeenCalled();
  });
});
