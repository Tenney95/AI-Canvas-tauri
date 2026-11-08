/**
 * httpTransport — 回归测试：CORS-safe AI HTTP transport。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { corsSafeFetch, logAiRequest } from '../../src/services/ai/httpTransport';
import { parseResponseError } from '../../src/services/ai/httpUtils';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class<T> {
    onmessage: (message: T) => void = () => undefined;
  },
}));

interface MockNativeStreamChannel {
  onmessage: (message: unknown) => void;
}

interface MockNativeInvokeArgs {
  onEvent?: MockNativeStreamChannel;
  req?: Record<string, unknown>;
}

function mockNativeStream(
  chunks: Uint8Array[],
  options: { status?: number; headers?: [string, string][] } = {},
) {
  invokeMock.mockImplementation((command: string, args?: MockNativeInvokeArgs) => {
    if (command === 'cancel_proxy_fetch') return Promise.resolve();
    if (command !== 'proxy_stream_fetch') return Promise.reject(new Error(`unexpected ${command}`));
    queueMicrotask(() => {
      args?.onEvent?.onmessage({
        event: 'meta',
        status: options.status ?? 200,
        headers: options.headers ?? [],
      });
      for (const chunk of chunks) {
        args?.onEvent?.onmessage({ event: 'chunk', body: Buffer.from(chunk).toString('base64') });
      }
      args?.onEvent?.onmessage({ event: 'done' });
    });
    return Promise.resolve();
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  invokeMock.mockReset();
  vi.unstubAllGlobals();
});

describe('CORS-safe AI HTTP transport', () => {
  it('敏感图床请求不记录自定义鉴权字段或上游回显的原文', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockNativeStream([Buffer.from('fixture-image-host-secret')], { status: 401 });
    const response = await corsSafeFetch('https://host.example/upload', {
      method: 'POST', headers: { 'X-Custom-Auth': 'fixture-image-host-secret' }, body: 'fixture-image-host-secret',
    }, { sensitive: true });
    expect(await response.text()).toBe('fixture-image-host-secret');
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects oversized blobs before reading their bytes and releases the request slot', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const body = new Blob(['small fixture']);
    Object.defineProperty(body, 'size', { value: 65 * 1024 * 1024 + 1 });
    const read = vi.spyOn(body, 'arrayBuffer');
    await expect(corsSafeFetch('https://gateway.example/upload', { method: 'POST', body })).rejects.toThrow('65 MiB');
    expect(read).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    mockNativeStream([Buffer.from('ok')]);
    expect(await (await corsSafeFetch('https://gateway.example/upload', { method: 'POST', body: 'next' })).text()).toBe('ok');
  });

  it('preserves UTF-8 replacement semantics without Base64-encoding text requests', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    mockNativeStream([]);
    await corsSafeFetch('https://gateway.example/text', { method: 'POST', body: '中文🙂\uD800' });
    expect(invokeMock.mock.calls[0][1].req).toMatchObject({ body: null, textBody: '中文🙂\uFFFD' });
  });

  it('limits body submissions, permits cancellation while queued, and releases slots at response headers', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const channels: MockNativeStreamChannel[] = [];
    const finish: Array<() => void> = [];
    invokeMock.mockImplementation((_command: string, args?: MockNativeInvokeArgs) => {
      channels.push(args!.onEvent!);
      return new Promise<void>((resolve) => finish.push(resolve));
    });
    const first = corsSafeFetch('https://gateway.example/first', { method: 'POST', body: 'first' });
    const second = corsSafeFetch('https://gateway.example/second', { method: 'POST', body: 'second' });
    const abort = new AbortController();
    const cancelled = corsSafeFetch('https://gateway.example/cancelled', { method: 'POST', body: 'cancelled', signal: abort.signal });
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(channels).toHaveLength(2));
    abort.abort();
    await rejected;
    const third = corsSafeFetch('https://gateway.example/third', { method: 'POST', body: 'third' });
    expect(channels).toHaveLength(2);
    channels[0].onmessage({ event: 'meta', status: 200, headers: [] });
    await first;
    await vi.waitFor(() => expect(channels).toHaveLength(3));
    channels[1].onmessage({ event: 'meta', status: 200, headers: [] });
    channels[2].onmessage({ event: 'meta', status: 200, headers: [] });
    channels.forEach((channel) => channel.onmessage({ event: 'done' }));
    finish.forEach((resolve) => resolve());
    await Promise.all([second, third]);
    expect(invokeMock.mock.calls.map(([, args]) => args.req.url)).not.toContain('https://gateway.example/cancelled');
  });

  it('logs native error bodies without consuming them or exposing echoed credentials', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = JSON.stringify({ error: { message: '上游 Not Found echoed-key' }, token: 'response-secret' });
    const bytes = Buffer.from(body);
    mockNativeStream([bytes.subarray(0, 25), bytes.subarray(25)], {
      status: 404, headers: [['content-type', 'application/json']],
    });
    const response = await corsSafeFetch('https://gateway.example/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer echoed-key' },
    });
    expect(await response.text()).toBe(body);
    expect(response.status).toBe(404);
    expect(warn).toHaveBeenCalledWith('[AI Response Error]', expect.objectContaining({
      status: 404, contentType: 'application/json', method: 'POST',
      body: expect.stringContaining('上游 Not Found'),
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('echoed-key');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('response-secret');
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('bounds error logging and stays silent for successful native responses', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = 'x'.repeat(9000);
    mockNativeStream([Buffer.from(body)], { status: 404 });
    expect(await (await corsSafeFetch('https://gateway.example/test')).text()).toBe(body);
    expect(warn).toHaveBeenCalledWith('[AI Response Error]', expect.objectContaining({
      truncated: true, bodyBytes: 9000, body: expect.stringContaining('OMITTED'),
    }));
    warn.mockClear();
    mockNativeStream([Buffer.from('ok')]);
    expect(await (await corsSafeFetch('https://gateway.example/test')).text()).toBe('ok');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['text/html', 'text/plain'])('explains gateway 504 pages without rendering HTML (%s)', async (contentType) => {
    const response = new Response('<html><head><title>504 Gateway Time-out</title></head><body>nginx</body></html>', {
      status: 504, headers: { 'Content-Type': contentType },
    });
    const error = await parseResponseError(response, '图片生成失败 (504)').catch((cause: Error) => cause);
    expect(error.message).toContain('网关等待上游响应超时');
    expect(error.message).toContain('结果尚未确认');
    expect(error.message).not.toContain('<html>');
  });

  it('preserves provider JSON diagnostics for a 504', async () => {
    const response = new Response(JSON.stringify({ error: { message: 'request abc timed out' } }), {
      status: 504, headers: { 'Content-Type': 'application/json' },
    });
    await expect(parseResponseError(response, '图片生成失败 (504)')).rejects.toThrow('request abc timed out');
  });

  it('preserves all four multipart files and their order through native encoding', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    mockNativeStream([Buffer.from('{}')]);
    const body = new FormData();
    for (let index = 0; index < 4; index++) {
      body.append('image[]', new Blob([`image-${index}`], { type: 'image/png' }), `reference-${index}.png`);
    }
    await corsSafeFetch('https://gateway.example/images/edits', { method: 'POST', body });
    const req = invokeMock.mock.calls[0][1].req as { body: string; headers: [string, string][] };
    const headers = new Headers(req.headers);
    const decoded = await new Response(Buffer.from(req.body, 'base64'), { headers }).formData();
    const files = decoded.getAll('image[]') as File[];
    expect(files).toHaveLength(4);
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(['image-0', 'image-1', 'image-2', 'image-3']);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('preserves upstream failure status and permits the next request without resetting the transport', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    mockNativeStream([Buffer.from(JSON.stringify({ error: { message: 'Upstream request failed' } }))], {
      status: 502, headers: [['content-type', 'application/json']],
    });
    const failed = await corsSafeFetch('https://gateway.example/images/edits', {
      method: 'POST', body: 'first',
    });
    await expect(parseResponseError(failed, '图片生成失败 (502)')).rejects.toThrow('Upstream request failed（HTTP 502）');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    mockNativeStream([Buffer.from('{"result":"ok"}')], { headers: [['content-type', 'application/json']] });
    const next = await corsSafeFetch('https://gateway.example/images/edits', { method: 'POST', body: 'second' });
    await expect(next.json()).resolves.toEqual({ result: 'ok' });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('yields during large request encoding and preserves bytes across consecutive calls', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    mockNativeStream([Buffer.from('{}')]);
    const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 5 }, (_, index) => index % 251);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sentBefore = invokeMock.mock.calls.length;
      let yieldedBeforeSend = false;
      const heartbeat = new Promise<void>((resolve) => setTimeout(() => {
        yieldedBeforeSend = invokeMock.mock.calls.length === sentBefore;
        resolve();
      }, 0));
      const response = await corsSafeFetch('https://gateway.example/upload', {
        method: 'POST', body: bytes,
      });
      await heartbeat;
      expect(yieldedBeforeSend).toBe(true);
      await response.text();
      const req = invokeMock.mock.calls.at(-1)![1].req as { body: string; requestId: string };
      expect(Buffer.from(req.body, 'base64').equals(Buffer.from(bytes))).toBe(true);
    }
    expect(invokeMock.mock.calls[0][1].req.requestId).not.toBe(invokeMock.mock.calls[1][1].req.requestId);
  });

  it('cancels large request encoding before sending a native request', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      await expect(corsSafeFetch('https://gateway.example/upload', {
        method: 'POST', body: new Uint8Array(2 * 1024 * 1024), signal: controller.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
    }
  });

  it('logs readable request parameters without exposing credentials or local media', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const formData = new FormData();
    formData.append('prompt', '生成一段月球列车视频');
    formData.append('api_key', 'form-secret');
    formData.append('image', new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/png' }), 'C:\\private\\reference.png');

    logAiRequest('https://gateway.example/v1/videos?task_id=task-1&signature=signed-secret', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'multipart/form-data',
      },
      body: formData,
    }, 'test-provider');

    expect(infoSpy).toHaveBeenCalledWith('[AI Request]', {
      source: 'test-provider',
      method: 'POST',
      url: 'https://gateway.example/v1/videos?task_id=task-1&signature=%5BREDACTED%5D',
      headers: {
        authorization: '[REDACTED]',
        'content-type': 'multipart/form-data',
      },
      body: {
        prompt: '生成一段月球列车视频',
        api_key: '[REDACTED]',
        image: {
          type: 'file',
          mimeType: 'image/png',
          size: 3,
          name: '[REDACTED_TEXT_WITH_LOCAL_PATH]',
        },
      },
    });
  });

  it('summarizes inline media and redacts absolute paths in JSON bodies', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    logAiRequest('tauri://dreamina_generate', {
      method: 'INVOKE',
      body: JSON.stringify({
        image: 'asset://localhost/reference.png',
        mask: 'data:image/png;base64,AAAA',
        outputPath: 'C:\\Users\\tester\\output.mp4',
      }),
    }, 'dreamina');

    expect(infoSpy).toHaveBeenCalledWith('[AI Request]', expect.objectContaining({
      body: {
        image: { type: 'local-media', scheme: 'asset', length: 31 },
        mask: { type: 'local-media', scheme: 'data', length: 26 },
        outputPath: '[REDACTED_TEXT_WITH_LOCAL_PATH]',
      },
    }));
  });

  it('uses browser fetch outside Tauri', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await corsSafeFetch('https://gateway.example/models', { method: 'GET' });

    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/models', { method: 'GET' });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('uses the native stream proxy in Tauri and preserves UTF-8 JSON bodies', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    mockNativeStream([
      Buffer.from(JSON.stringify({ result: '完成' }), 'utf8'),
    ], { headers: [['content-type', 'application/json']] });

    const response = await corsSafeFetch('https://gateway.example/v1/render', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '亚洲美女跳舞' }),
    });

    const requestCall = invokeMock.mock.calls.find(([command]) => command === 'proxy_stream_fetch');
    const request = requestCall?.[1]?.req as {
      body: null;
      textBody: string;
      headers: [string, string][];
      method: string;
      url: string;
    };
    expect(request.url).toBe('https://gateway.example/v1/render');
    expect(request.method).toBe('POST');
    expect(request.body).toBeNull();
    expect(request.textBody).toBe(JSON.stringify({
      prompt: '亚洲美女跳舞',
    }));
    expect(request.headers).toEqual(expect.arrayContaining([
      ['authorization', 'Bearer secret'],
      ['content-type', 'application/json'],
    ]));
    await expect(response.json()).resolves.toEqual({ result: '完成' });
  });

  it('uses the native stream proxy in Tauri and preserves arbitrary request bytes', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    mockNativeStream([
      Uint8Array.from([0, 255]),
      Uint8Array.from([10, 20]),
    ], { headers: [['content-type', 'application/octet-stream']] });
    const requestBytes = Uint8Array.from([1, 2, 0, 255]);

    const response = await corsSafeFetch('https://gateway.example/v1/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: requestBytes.buffer,
    });

    const requestCall = invokeMock.mock.calls.find(([command]) => command === 'proxy_stream_fetch');
    const request = requestCall?.[1]?.req as { body: string };
    expect([...Buffer.from(request.body, 'base64')]).toEqual([...requestBytes]);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255, 10, 20]);
  });

  it('serializes FormData with its multipart boundary for the native proxy', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    mockNativeStream([Buffer.from('{}', 'utf8')], {
      headers: [['content-type', 'application/json']],
    });
    const formData = new FormData();
    formData.append('prompt', '参考图编辑');
    formData.append(
      'image',
      new Blob([Uint8Array.from([0, 255, 10])], { type: 'image/png' }),
      'reference.png',
    );

    await corsSafeFetch('https://gateway.example/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: formData,
    });

    const requestCall = invokeMock.mock.calls.find(([command]) => command === 'proxy_stream_fetch');
    const request = requestCall?.[1]?.req as { body: string; headers: [string, string][] };
    const contentType = request.headers.find(([name]) => name === 'content-type')?.[1];
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(request.headers).toContainEqual(['authorization', 'Bearer secret']);
    const multipartBody = Buffer.from(request.body, 'base64').toString('latin1');
    expect(multipartBody).toContain('name="prompt"');
    expect(Buffer.from(multipartBody, 'latin1').toString('utf8')).toContain('参考图编辑');
    expect(multipartBody).toContain('name="image"; filename="reference.png"');
    expect(multipartBody).toContain('Content-Type: image/png');
  });

  it('exposes native response chunks before the Tauri command completes', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    let streamChannel: { onmessage: (message: unknown) => void } | undefined;
    let completeCommand: (() => void) | undefined;
    invokeMock.mockImplementation((command: string, args?: MockNativeInvokeArgs) => {
      if (command === 'cancel_proxy_fetch') return Promise.resolve();
      streamChannel = args?.onEvent;
      return new Promise<void>((resolve) => {
        completeCommand = resolve;
      });
    });

    const responsePromise = corsSafeFetch('https://gateway.example/v1/chat', { method: 'POST' });
    await vi.waitFor(() => expect(streamChannel).toBeDefined());
    streamChannel?.onmessage({ event: 'meta', status: 200, headers: [] });
    const response = await responsePromise;
    const reader = response.body!.getReader();
    const firstChunk = reader.read();
    streamChannel?.onmessage({
      event: 'chunk',
      body: Buffer.from('data: first\n\n', 'utf8').toString('base64'),
    });

    await expect(firstChunk).resolves.toMatchObject({
      done: false,
      value: new TextEncoder().encode('data: first\n\n'),
    });
    streamChannel?.onmessage({ event: 'done' });
    completeCommand?.();
  });

  it('cancels an active Tauri proxy request when the AbortSignal fires', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cancel_proxy_fetch') return Promise.resolve();
      return new Promise(() => undefined);
    });
    const controller = new AbortController();

    const request = corsSafeFetch('https://gateway.example/v1/render', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'cancel me' }),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'proxy_stream_fetch',
      expect.objectContaining({
        req: expect.objectContaining({ requestId: expect.any(String) }),
      }),
    ));

    const requestId = invokeMock.mock.calls.find(([command]) => command === 'proxy_stream_fetch')?.[1]
      ?.req?.requestId as string;
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(invokeMock).toHaveBeenCalledWith('cancel_proxy_fetch', { requestId });
  });
});
