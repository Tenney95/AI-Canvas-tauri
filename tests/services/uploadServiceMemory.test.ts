import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertMediaDataUrlSize: vi.fn((bytes: number, kind: string) => {
    const limits: Record<string, number> = {
      image: 32 * 1024 * 1024,
      video: 64 * 1024 * 1024,
      audio: 32 * 1024 * 1024,
      other: 8 * 1024 * 1024,
    };
    if (bytes > limits[kind]) throw new Error('超过内存转换上限');
  }),
  assertMediaDataUrlWithinLimit: vi.fn(),
  bytePartsToBase64Async: vi.fn(async (parts: readonly Uint8Array[]) => Buffer.concat(
    parts.map((part) => Buffer.from(part.buffer, part.byteOffset, part.byteLength)),
  ).toString('base64')),
  consumeMediaDataUrlBudget: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: {
    getState: () => ({ config: { providers: {} } }),
  },
}));
vi.mock('../../src/services/fs/core', () => ({
  bytePartsToBase64Async: mocks.bytePartsToBase64Async,
  isTauriEnv: () => true,
}));
vi.mock('../../src/services/fileService', () => ({
  assertMediaDataUrlSize: mocks.assertMediaDataUrlSize,
  assertMediaDataUrlWithinLimit: mocks.assertMediaDataUrlWithinLimit,
  assertMediaDataUrlWithinLimitAsync: async (
    dataUrl: string,
    kind: string,
    label?: string,
  ) => {
    mocks.assertMediaDataUrlWithinLimit(dataUrl, kind, label);
    return 3;
  },
  consumeMediaDataUrlBudgetBytes: mocks.consumeMediaDataUrlBudget,
  consumeMediaDataUrlBudget: mocks.consumeMediaDataUrlBudget,
  isMediaDataUrl: (value: string) => /^data:/i.test(value),
  readFileToDataUrl: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import {
  UPLOAD_TIMEOUT_MS,
  resolveMediaReferenceUrl,
  uploadToRemote,
} from '../../src/services/uploadService';

function responseFor(blob: Blob): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': blob.type || 'application/octet-stream' }),
    blob: async () => blob,
  } as Response;
}

describe('uploadService 内存上传治理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('Blob 超过媒体预算时不进入 multipart 和 Tauri IPC', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseFor({
      size: 8 * 1024 * 1024 + 1,
      type: 'application/octet-stream',
    } as Blob)));

    await expect(uploadToRemote('asset://localhost/large.bin', '', 'other'))
      .rejects.toThrow('超过内存转换上限');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('不同本地素材也按单并发上传，避免 multipart Base64 峰值叠加', async () => {
    const fileBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchMock = vi.fn(async () => responseFor(new Blob([fileBytes], {
      type: 'image/png',
    })));
    vi.stubGlobal('fetch', fetchMock);

    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let invocation = 0;
    mocks.invoke.mockImplementation(async () => {
      invocation += 1;
      if (invocation === 1) await firstGate;
      return {
        status: 200,
        body: btoa(JSON.stringify({
          success: true,
          files: [{ url: `https://cdn.example/${invocation}.png` }],
        })),
      };
    });

    const first = uploadToRemote('asset://localhost/queue-a.png');
    const second = uploadToRemote('asset://localhost/queue-b.png');
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      'https://cdn.example/1.png',
      'https://cdn.example/2.png',
    ]);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = mocks.invoke.mock.calls[0]?.[1]?.req?.body as string;
    expect(() => atob(firstBody)).not.toThrow();
    expect(atob(firstBody)).toContain('Content-Disposition: form-data; name="files[]"');
    expect(atob(firstBody)).toContain(String.fromCharCode(...fileBytes));
  });

  it('publicUrl 模式会上传 data URL，而不是把 Base64 直接交给 Provider', async () => {
    mocks.invoke.mockResolvedValue({
      status: 200,
      body: btoa(JSON.stringify({ success: true, files: [{ url: 'https://cdn.example/audio.mp3' }] })),
    });

    await expect(resolveMediaReferenceUrl('data:audio/mpeg;base64,AQID', {
      provider: 'apimart',
      kind: 'audio',
      mode: 'publicUrl',
    })).resolves.toBe('https://cdn.example/audio.mp3');
    expect(mocks.invoke).toHaveBeenCalledWith('proxy_fetch', expect.objectContaining({
      req: expect.objectContaining({ requestId: expect.stringMatching(/^media-upload-/) }),
    }));
    const multipartBody = atob(mocks.invoke.mock.calls.find(
      ([command]) => command === 'proxy_fetch',
    )?.[1]?.req?.body as string);
    expect(multipartBody).toContain(String.fromCharCode(1, 2, 3));
  });

  it('Data URL scheme 大小写不能绕过预算和 publicUrl 上传', async () => {
    mocks.invoke.mockResolvedValue({
      status: 200,
      body: btoa(JSON.stringify({
        success: true,
        files: [{ url: 'https://cdn.example/uppercase.png' }],
      })),
    });

    await expect(resolveMediaReferenceUrl('DATA:image/png;base64,AQID', {
      kind: 'image',
      mode: 'publicUrl',
    })).resolves.toBe('https://cdn.example/uppercase.png');
    expect(mocks.assertMediaDataUrlWithinLimit).toHaveBeenCalledWith(
      'DATA:image/png;base64,AQID',
      'image',
      '图片参考',
    );
    expect(mocks.invoke).toHaveBeenCalledWith('proxy_fetch', expect.any(Object));
  });

  it('Data URL 超长 header 在生成缓存键和 multipart 前被拒绝', async () => {
    mocks.assertMediaDataUrlWithinLimit.mockImplementationOnce(() => {
      throw new Error('Data URL 元数据长度超限');
    });

    await expect(uploadToRemote(`data:image/png;name=${'x'.repeat(5000)},AQID`))
      .rejects.toThrow('Data URL 元数据长度超限');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('大 Data URL 缓存指纹扫描会让出事件循环并响应取消', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('取消缓存指纹', 'AbortError')), 0);
    const task = uploadToRemote(
      `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`,
      '',
      'image',
      controller.signal,
    );

    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.bytePartsToBase64Async).not.toHaveBeenCalled();
  });

  it('同源并发调用只上传一次并共享结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseFor(new Blob([new Uint8Array([4, 5, 6])], {
      type: 'image/png',
    }))));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command !== 'proxy_fetch') return true;
      await gate;
      return {
        status: 200,
        body: btoa(JSON.stringify({ success: true, files: [{ url: 'https://cdn.example/shared.png' }] })),
      };
    });

    const first = uploadToRemote('asset://localhost/shared-source.png');
    const second = uploadToRemote('asset://localhost/shared-source.png');
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      'https://cdn.example/shared.png',
      'https://cdn.example/shared.png',
    ]);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'proxy_fetch')).toHaveLength(1);
  });

  it('同源并发中单个消费者取消不会中止其他消费者', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseFor(new Blob([new Uint8Array([4, 5, 7])], {
      type: 'image/png',
    }))));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command !== 'proxy_fetch') return true;
      await gate;
      return {
        status: 200,
        body: btoa(JSON.stringify({
          success: true,
          files: [{ url: 'https://cdn.example/still-shared.png' }],
        })),
      };
    });

    const controller = new AbortController();
    const cancelled = uploadToRemote(
      'asset://localhost/shared-cancel-source.png', '', 'image', controller.signal,
    );
    const survivor = uploadToRemote('asset://localhost/shared-cancel-source.png');
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('取消单个等待者', 'AbortError'));
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    release();
    await expect(survivor).resolves.toBe('https://cdn.example/still-shared.png');
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'proxy_fetch')).toHaveLength(1);
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'cancel_proxy_fetch')).toBe(false);
  });

  it('失败上传会释放串行队列，后续素材仍可继续', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseFor(new Blob([new Uint8Array([7, 8, 9])], {
      type: 'image/png',
    }))));
    let proxyCalls = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command !== 'proxy_fetch') return true;
      proxyCalls += 1;
      if (proxyCalls === 1) throw new Error('模拟上传失败');
      return {
        status: 200,
        body: btoa(JSON.stringify({ success: true, files: [{ url: 'https://cdn.example/recovered.png' }] })),
      };
    });

    const failed = uploadToRemote('asset://localhost/failing-source.png');
    const recovered = uploadToRemote('asset://localhost/recovered-source.png');
    await expect(failed).rejects.toThrow('模拟上传失败');
    await expect(recovered).resolves.toBe('https://cdn.example/recovered.png');
    expect(proxyCalls).toBe(2);
  });

  it('缓存隔离 provider/kind，且旧 32 位碰撞 payload 不会串用结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseFor(new Blob([new Uint8Array([10, 11, 12])], {
      type: 'image/png',
    }))));
    let proxyCalls = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command !== 'proxy_fetch') return true;
      proxyCalls += 1;
      return {
        status: 200,
        body: btoa(JSON.stringify({
          success: true,
          files: [{ url: `https://cdn.example/cache-${proxyCalls}` }],
        })),
      };
    });

    const source = 'asset://localhost/provider-scope.png';
    await uploadToRemote(source, '', 'image');
    await uploadToRemote(source, 'volcengine', 'image');
    await uploadToRemote('data:image/png;base64,s3HmNtbb234r', '', 'image');
    await uploadToRemote('data:image/png;base64,XAOgGXpSiMuF', '', 'image');
    expect(proxyCalls).toBe(4);
  });

  it('外部取消会调用 cancel_proxy_fetch 真正停止原生上传', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseFor(new Blob([new Uint8Array([13, 14, 15])], {
      type: 'image/png',
    }))));
    let rejectProxy: (reason: unknown) => void = () => undefined;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'cancel_proxy_fetch') {
        rejectProxy(new Error('请求已取消'));
        return Promise.resolve(true);
      }
      return new Promise((_, reject) => { rejectProxy = reject; });
    });
    const controller = new AbortController();
    const task = uploadToRemote(
      'asset://localhost/cancel-source.png', '', 'image', controller.signal,
    );
    await vi.waitFor(() => expect(
      mocks.invoke.mock.calls.some(([command]) => command === 'proxy_fetch'),
    ).toBe(true));
    controller.abort(new DOMException('用户取消', 'AbortError'));

    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      'cancel_proxy_fetch',
      expect.objectContaining({ requestId: expect.stringMatching(/^media-upload-/) }),
    ));
  });

  it('multipart 读取完成后若已取消，不再执行 Base64 编码或原生请求', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseFor(new Blob([new Uint8Array([21, 22, 23])], {
      type: 'image/png',
    }))));
    let finishArrayBuffer: (buffer: ArrayBuffer) => void = () => undefined;
    const arrayBufferSpy = vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementationOnce(
      () => new Promise<ArrayBuffer>((resolve) => { finishArrayBuffer = resolve; }),
    );
    const controller = new AbortController();
    try {
      const task = uploadToRemote(
        'asset://localhost/cancel-before-encoding.png', '', 'image', controller.signal,
      );
      await vi.waitFor(() => expect(arrayBufferSpy).toHaveBeenCalledOnce());
      controller.abort(new DOMException('取消 multipart', 'AbortError'));
      await expect(task).rejects.toMatchObject({ name: 'AbortError' });
      finishArrayBuffer(new Uint8Array([21, 22, 23]).buffer);
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
      expect(mocks.bytePartsToBase64Async).not.toHaveBeenCalled();
      expect(mocks.invoke).not.toHaveBeenCalledWith('proxy_fetch', expect.anything());
    } finally {
      arrayBufferSpy.mockRestore();
    }
  });

  it('120 秒超时会真正中止原生代理，底层结算后才释放队列', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => responseFor(new Blob([new Uint8Array([16, 17, 18])], {
      type: 'image/png',
    }))));
    let keepProxyPending = true;
    let rejectProxy: (reason: unknown) => void = () => undefined;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'cancel_proxy_fetch') {
        rejectProxy(new Error('原生请求已取消'));
        return Promise.resolve(true);
      }
      if (keepProxyPending) return new Promise((_, reject) => { rejectProxy = reject; });
      return Promise.resolve({
        status: 200,
        body: btoa(JSON.stringify({
          success: true,
          files: [{ url: 'https://cdn.example/after-timeout.png' }],
        })),
      });
    });
    const task = uploadToRemote('asset://localhost/timeout-source.png');
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'proxy_fetch')).toBe(true);

    const timeoutRejection = expect(task).rejects.toThrow('媒体上传等待超过 120 秒');
    await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS);
    await timeoutRejection;
    expect(mocks.invoke).toHaveBeenCalledWith(
      'cancel_proxy_fetch',
      expect.objectContaining({ requestId: expect.stringMatching(/^media-upload-/) }),
    );
    keepProxyPending = false;
    await expect(uploadToRemote('asset://localhost/after-timeout.png'))
      .resolves.toBe('https://cdn.example/after-timeout.png');
  });

  it('原生 invoke 未结算时保持受控隔离，不会提前启动下一个大上传', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => responseFor(new Blob([new Uint8Array([31, 32, 33])], {
      type: 'image/png',
    }))));
    let rejectStuckProxy: (reason: unknown) => void = () => undefined;
    let proxyCalls = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'cancel_proxy_fetch') return Promise.resolve(true);
      proxyCalls += 1;
      if (proxyCalls === 1) {
        return new Promise((_, reject) => { rejectStuckProxy = reject; });
      }
      return Promise.resolve({
        status: 200,
        body: btoa(JSON.stringify({
          success: true,
          files: [{ url: 'https://cdn.example/after-isolation.png' }],
        })),
      });
    });

    const stuck = uploadToRemote('asset://localhost/stuck-native.png');
    await vi.advanceTimersByTimeAsync(0);
    const stuckRejection = expect(stuck).rejects.toThrow('媒体上传等待超过 120 秒');
    await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS);
    await stuckRejection;

    const isolated = uploadToRemote('asset://localhost/must-not-overlap.png');
    await expect(isolated).rejects.toThrow('已隔离新上传');
    expect(proxyCalls).toBe(1);

    rejectStuckProxy(new Error('模拟原生层最终结算'));
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await expect(uploadToRemote('asset://localhost/after-isolation.png'))
      .resolves.toBe('https://cdn.example/after-isolation.png');
    expect(proxyCalls).toBe(2);
  });
});
