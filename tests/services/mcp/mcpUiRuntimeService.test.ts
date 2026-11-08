/**
 * mcpUiRuntimeService — 回归测试：MCP screenshot capture。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureAppWindow, installMcpScreenshotResponder } from '../../../src/services/mcp/mcpUiRuntimeService';
import { MCP_CAPTURE_MAX_BYTES } from '../../../src/services/mcp/mcpCaptureEncoding';

const mocks = vi.hoisted(() => ({
  captureDom: vi.fn(), listen: vi.fn(), emitTo: vi.fn(), currentLabel: 'main',
}));
vi.mock('html-to-image', () => ({ toCanvas: mocks.captureDom }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: mocks.currentLabel }) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen, emitTo: mocks.emitTo }));

class ElementStub { sensitive = false; closest() { return this.sensitive ? this : null; } }
class InputStub extends ElementStub { type = 'text'; name = ''; id = ''; autocomplete = ''; }
const options = { target: 'main' as const, maxWidth: 640, quality: 0.8, redactSensitive: true };
const jpegBlob = () => new Blob(['abc'], { type: 'image/jpeg' });

function fakeCanvas(width = 640, height = 384) {
  return {
    width, height,
    getContext: vi.fn(() => ({ drawImage: vi.fn() })),
    toBlob: vi.fn((callback: BlobCallback) => callback(jpegBlob())),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentLabel = 'main';
  vi.stubGlobal('Element', ElementStub);
  vi.stubGlobal('HTMLInputElement', InputStub);
  vi.stubGlobal('Worker', undefined);
  vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 600, setTimeout, clearTimeout });
  vi.stubGlobal('document', {
    getElementById: () => ({ clientWidth: 1000, clientHeight: 600 }),
    body: { clientWidth: 1000, clientHeight: 600 },
    documentElement: {},
    createElement: vi.fn(() => fakeCanvas()),
  });
  vi.stubGlobal('getComputedStyle', () => ({ backgroundColor: '#101018' }));
  mocks.captureDom.mockImplementation(async (_root, input) => fakeCanvas(input.canvasWidth, input.canvasHeight));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MCP screenshot capture', () => {
  it('captures portal siblings of the app root as part of the window', async () => {
    const portal = new ElementStub();
    const body = {
      clientWidth: 1000, clientHeight: 600,
      children: [document.getElementById('root'), portal],
    };
    vi.stubGlobal('document', { ...document, body });

    await captureAppWindow(options);

    expect(mocks.captureDom).toHaveBeenCalledWith(body, expect.objectContaining({
      canvasWidth: 640, canvasHeight: 384, filter: expect.any(Function),
    }));
  });

  it('filters Text, SVG, password, API key and sensitive elements on the single DOM capture', async () => {
    mocks.captureDom.mockImplementation(async (_root, input) => {
      expect(input.filter({ nodeType: 3, textContent: '普通文字' })).toBe(true);
      expect(input.filter(new ElementStub())).toBe(true);
      const sensitive = new ElementStub(); sensitive.sensitive = true;
      expect(input.filter(sensitive)).toBe(false);
      const password = new InputStub(); password.type = 'password';
      expect(input.filter(password)).toBe(false);
      const token = new InputStub(); token.name = 'apiKey';
      expect(input.filter(token)).toBe(false);
      return fakeCanvas(input.canvasWidth, input.canvasHeight);
    });
    expect(await captureAppWindow(options))
      .toEqual({ data: 'YWJj', mimeType: 'image/jpeg', width: 640, height: 384 });
    expect(mocks.captureDom).toHaveBeenCalledOnce();
  });

  it('reuses the sanitized canvas while reducing JPEG size, preserving aspect ratio and releasing canvases', async () => {
    const source = fakeCanvas();
    const encoder = fakeCanvas();
    encoder.toBlob.mockImplementationOnce((done) => done(new Blob([new Uint8Array(MCP_CAPTURE_MAX_BYTES + 1)], { type: 'image/jpeg' })));
    mocks.captureDom.mockResolvedValue(source);
    vi.mocked(document.createElement).mockReturnValue(encoder as unknown as HTMLCanvasElement);
    expect(await captureAppWindow(options)).toMatchObject({ width: 480, height: 288, data: 'YWJj' });
    expect(mocks.captureDom).toHaveBeenCalledOnce();
    expect(encoder.toBlob).toHaveBeenNthCalledWith(2, expect.any(Function), 'image/jpeg', 0.68);
    expect(source.width).toBe(0);
    expect(encoder.width).toBe(0);
  });

  it('fails within the image budget without repeating DOM capture', async () => {
    const encoder = fakeCanvas();
    encoder.toBlob.mockImplementation((done) => done(new Blob([new Uint8Array(MCP_CAPTURE_MAX_BYTES + 1)], { type: 'image/jpeg' })));
    vi.mocked(document.createElement).mockReturnValue(encoder as unknown as HTMLCanvasElement);
    await expect(captureAppWindow(options)).rejects.toThrow('图像上限');
    expect(mocks.captureDom).toHaveBeenCalledOnce();
    expect(encoder.toBlob).toHaveBeenCalledTimes(4);
  });

  it('deduplicates matching options, queues only one distinct capture and keeps redaction variants separate', async () => {
    const waiting = deferred<ReturnType<typeof fakeCanvas>>();
    mocks.captureDom.mockImplementationOnce(() => waiting.promise);
    const first = captureAppWindow(options);
    const duplicate = captureAppWindow({ ...options });
    const unredacted = captureAppWindow({ ...options, redactSensitive: false });
    await expect(captureAppWindow({ ...options, maxWidth: 800 })).rejects.toThrow('截图繁忙');
    expect(mocks.captureDom).toHaveBeenCalledOnce();
    waiting.resolve(fakeCanvas());
    await Promise.all([first, duplicate, unredacted]);
    expect(mocks.captureDom).toHaveBeenCalledTimes(2);
    expect(mocks.captureDom.mock.calls[1][1].filter).toBeUndefined();
  });

  it('uses a fixed Worker for encoding and closes transferred bitmap resources', async () => {
    const bitmap = { close: vi.fn() };
    const terminate = vi.fn();
    const postMessage = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('Worker', class {
      onmessage?: (event: { data: unknown }) => void;
      terminate = terminate;
      postMessage(message: unknown, transfer: unknown[]) {
        postMessage(message, transfer);
        this.onmessage?.({ data: { ok: true, buffer: new Uint8Array([97, 98, 99]).buffer, width: 640, height: 384 } });
      }
    });
    expect(await captureAppWindow(options)).toMatchObject({ data: 'YWJj', width: 640 });
    expect(postMessage).toHaveBeenCalledWith({ bitmap, quality: 0.8 }, [bitmap]);
    expect(document.createElement).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('falls back to encoding the same filtered canvas when Worker construction is blocked', async () => {
    const bitmap = { close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked'); } });
    expect(await captureAppWindow(options)).toMatchObject({ data: 'YWJj' });
    expect(mocks.captureDom).toHaveBeenCalledOnce();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('does not repeat compression on the main thread after the Worker exhausts the image budget', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('Worker', class {
      onmessage?: (event: { data: unknown }) => void;
      terminate() {}
      postMessage() { this.onmessage?.({ data: { ok: false, error: 'too large', oversized: true } }); }
    });
    await expect(captureAppWindow(options)).rejects.toThrow('图像上限');
    expect(mocks.captureDom).toHaveBeenCalledOnce();
    expect(document.createElement).not.toHaveBeenCalled();
  });

  it('terminates a stalled encoding Worker before falling back to the same canvas', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 600, setTimeout, clearTimeout });
    const terminate = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('Worker', class { terminate = terminate; postMessage() {} });
    vi.mocked(document.createElement).mockImplementation(() => {
      expect(terminate).toHaveBeenCalledOnce();
      return fakeCanvas() as unknown as HTMLCanvasElement;
    });
    const pending = captureAppWindow(options);
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await pending).toMatchObject({ data: 'YWJj' });
    expect(mocks.captureDom).toHaveBeenCalledOnce();
  });

  it('rejects non-capturable window targets before touching DOM or IPC', async () => {
    await expect(captureAppWindow({ ...options, target: 'comfyui' as 'main' })).rejects.toThrow('不支持截取');
    expect(mocks.captureDom).not.toHaveBeenCalled();
    expect(mocks.emitTo).not.toHaveBeenCalled();
  });

  it('keeps the underlying capture bounded after remote callers time out', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, setTimeout, clearTimeout });
    const waiting = deferred<ReturnType<typeof fakeCanvas>>();
    mocks.captureDom.mockImplementation(() => waiting.promise);
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    mocks.listen.mockImplementation(async (eventName, handler) => {
      listeners.set(eventName, handler);
      return () => { if (listeners.get(eventName) === handler) listeners.delete(eventName); };
    });
    mocks.emitTo.mockImplementation(async (_target, eventName, payload) => listeners.get(eventName)?.({ payload }));
    mocks.currentLabel = 'chat-assistant';
    const dispose = await installMcpScreenshotResponder();
    mocks.currentLabel = 'main';
    const remoteOptions = { ...options, target: 'chat-assistant' as const };
    for (let index = 0; index < 4; index += 1) {
      const pending = captureAppWindow(remoteOptions);
      const rejection = expect(pending).rejects.toThrow('响应超时');
      await vi.advanceTimersByTimeAsync(12_001);
      await rejection;
    }
    await expect(captureAppWindow(remoteOptions)).rejects.toThrow('截图繁忙');
    expect(mocks.captureDom).toHaveBeenCalledOnce();
    waiting.resolve(fakeCanvas());
    await vi.advanceTimersByTimeAsync(0);
    dispose();
  });

  it('cleans up late IPC listeners without starting a capture after the response deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, setTimeout, clearTimeout });
    const lateListener = deferred<() => void>();
    mocks.listen.mockReturnValue(lateListener.promise);
    const pending = captureAppWindow({ ...options, target: 'chat-assistant' });
    const rejection = expect(pending).rejects.toThrow('响应超时');
    await vi.advanceTimersByTimeAsync(12_001);
    await rejection;
    const dispose = vi.fn();
    lateListener.resolve(dispose);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(mocks.emitTo).not.toHaveBeenCalled();
    expect(mocks.captureDom).not.toHaveBeenCalled();
  });
});
