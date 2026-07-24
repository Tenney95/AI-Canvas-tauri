import { beforeEach, describe, expect, it, vi } from 'vitest';
import { corsSafeFetch, logAiRequest } from '../../src/services/ai/httpTransport';

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
      body: string;
      headers: [string, string][];
      method: string;
      url: string;
    };
    expect(request.url).toBe('https://gateway.example/v1/render');
    expect(request.method).toBe('POST');
    expect(Buffer.from(request.body, 'base64').toString('utf8')).toBe(JSON.stringify({
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
