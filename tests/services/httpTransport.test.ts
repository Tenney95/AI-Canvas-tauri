/**
 * httpTransport — 回归测试：CORS-safe AI HTTP transport。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { corsSafeFetch, logAiRequest, logAiResponse } from '../../src/services/ai/httpTransport';
import { parseResponseError } from '../../src/services/ai/httpUtils';
import * as uploadDiagnostics from '../../src/services/uploadDiagnostics';

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
  options: { status?: number; headers?: [string, string][]; uploadDiagnostics?: unknown } = {},
) {
  invokeMock.mockImplementation((command: string, args?: MockNativeInvokeArgs) => {
    if (command === 'cancel_proxy_fetch') return Promise.resolve();
    if (command !== 'proxy_stream_fetch') return Promise.reject(new Error(`unexpected ${command}`));
    queueMicrotask(() => {
      args?.onEvent?.onmessage({
        event: 'meta',
        status: options.status ?? 200,
        headers: options.headers ?? [],
        ...(options.uploadDiagnostics !== undefined ? { uploadDiagnostics: options.uploadDiagnostics } : {}),
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
  const uploadContext: uploadDiagnostics.UploadDiagnosticContext = {
    id: 'upload-fixture-id', source: 'custom', endpoint: 'https://host.example/upload', startedAt: 1, secrets: [],
  };

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

  it('显式上传诊断关联原生请求、实际 multipart boundary 和返回的网络元数据，不消费响应正文', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logTransport = vi.spyOn(uploadDiagnostics, 'logUploadTransport').mockImplementation(() => undefined);
    const native = { httpVersion: 'HTTP/2.0', remoteAddress: '127.0.0.1:18719', proxyEnvironment: [], noProxyPresent: false };
    const responseBody = '<html><title>502 Bad Gateway</title></html>';
    mockNativeStream([Buffer.from(responseBody)], { status: 502, headers: [['content-type', 'text/html']], uploadDiagnostics: native });
    const bytes = Uint8Array.from([0, 255, 10]);
    const form = new FormData();
    form.append('files[]', new Blob([bytes], { type: 'image/png' }), 'reference.png');
    const response = await corsSafeFetch(uploadContext.endpoint, {
      method: 'POST', headers: { 'X-Upload-Auth': 'fixture-private-key' }, body: form,
    }, { sensitive: true, uploadDiagnostics: uploadContext });
    const request = invokeMock.mock.calls.find(([command]) => command === 'proxy_stream_fetch')![1].req as {
      requestId: string; body: string; headers: [string, string][]; uploadDiagnosticId: string;
    };
    const contentType = new Headers(request.headers).get('content-type')!;
    expect(request.uploadDiagnosticId).toBe(uploadContext.id);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(logTransport).toHaveBeenCalledWith(uploadContext, expect.objectContaining({
      transport: 'tauri-stream', requestId: request.requestId, contentType, wireBytes: Buffer.from(request.body, 'base64').byteLength,
    }));
    expect(logTransport).toHaveBeenCalledWith(uploadContext, expect.objectContaining({
      transport: 'tauri-stream', requestId: request.requestId, native,
    }));
    const transmitted = await new Response(Buffer.from(request.body, 'base64'), { headers: { 'content-type': contentType } }).formData();
    const file = transmitted.get('files[]') as File;
    expect(file.name).toBe('reference.png');
    expect(file.type).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(responseBody);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it('没有上传诊断上下文的敏感请求不附加 IPC 诊断字段，也不输出诊断日志', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const logTransport = vi.spyOn(uploadDiagnostics, 'logUploadTransport').mockImplementation(() => undefined);
    mockNativeStream([Buffer.from('unchanged')]);
    const response = await corsSafeFetch(uploadContext.endpoint, { method: 'POST', body: 'request' }, { sensitive: true });
    expect(invokeMock.mock.calls[0][1].req).not.toHaveProperty('uploadDiagnosticId');
    expect(logTransport).not.toHaveBeenCalled();
    expect(await response.text()).toBe('unchanged');
  });

  it('浏览器上传诊断不重建 FormData 或修改 fetch 参数', async () => {
    const logTransport = vi.spyOn(uploadDiagnostics, 'logUploadTransport').mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response('browser response'));
    vi.stubGlobal('fetch', fetchMock);
    const form = new FormData();
    form.append('files[]', new Blob(['file'], { type: 'image/png' }), 'reference.png');
    const init = { method: 'POST', body: form, headers: { Accept: 'application/json' } };
    const response = await corsSafeFetch(uploadContext.endpoint, init, { sensitive: true, uploadDiagnostics: uploadContext });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(uploadContext.endpoint, init);
    expect(fetchMock.mock.calls[0][1].body).toBe(form);
    expect(logTransport).toHaveBeenCalledExactlyOnceWith(uploadContext, { transport: 'browser-fetch', headers: init.headers });
    expect(await response.text()).toBe('browser response');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])('上传诊断正确统计含 Base64 padding 的 %s 字节请求，不修改原始字节', async (length) => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const logTransport = vi.spyOn(uploadDiagnostics, 'logUploadTransport').mockImplementation(() => undefined);
    mockNativeStream([]);
    const bytes = Uint8Array.from({ length }, (_, index) => index + 250);
    await corsSafeFetch(uploadContext.endpoint, { method: 'POST', body: bytes.buffer }, { sensitive: true, uploadDiagnostics: uploadContext });
    expect(logTransport).toHaveBeenCalledWith(uploadContext, expect.objectContaining({ wireBytes: length }));
    expect(Buffer.from(invokeMock.mock.calls[0][1].req.body, 'base64')).toEqual(Buffer.from(bytes));
  });

  it('上传诊断统计 UTF-8 文本字节数且仍按 textBody 发送', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const logTransport = vi.spyOn(uploadDiagnostics, 'logUploadTransport').mockImplementation(() => undefined);
    mockNativeStream([]);
    await corsSafeFetch(uploadContext.endpoint, { method: 'POST', body: '字🙂' }, { sensitive: true, uploadDiagnostics: uploadContext });
    expect(logTransport).toHaveBeenCalledWith(uploadContext, expect.objectContaining({ wireBytes: 7 }));
    expect(invokeMock.mock.calls[0][1].req).toMatchObject({ body: null, textBody: '字🙂' });
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

  it('redacts JSON-escaped credentials and lowercase URL escapes in native error logs', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const apiKey = 'fixture/key';
    const body = JSON.stringify({ message: `echo ${apiKey}` }).replaceAll('/', '\\/');
    mockNativeStream([Buffer.from(body)], { status: 400, headers: [['content-type', 'application/json']] });
    const response = await corsSafeFetch('https://gateway.example/images?auth=fixture%2fkey', {
      method: 'POST', headers: { 'X-Custom-Auth': apiKey },
    }, { debug: { traceId: 'escaped', apiKey, body: { model: 'image' } } });
    expect(await response.text()).toBe(body);
    expect(warn).toHaveBeenCalledWith('[AI Response Error]', expect.objectContaining({ status: 400 }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture');
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

  it('shows the actual URL and multipart fields while preserving the sent bytes', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const request = { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=actual-boundary' },
      body: Uint8Array.from([1, 2, 3]).buffer };
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const preview = { traceId: 'debug-1', stage: 'submit' as const, bodyEncoding: 'multipart',
      body: { model: 'image-2.6-01', size: '2560x1440', n: 1,
        'image[]': [{ $file: '[data URL image/png, 3 bytes]' }, { $file: '[data URL image/webp, 5 bytes]' }] } };
    await corsSafeFetch('https://api.relayonapi.com/v1/images/edits', request, { debug: preview });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://api.relayonapi.com/v1/images/edits', request);
    expect(new Uint8Array(request.body)).toEqual(Uint8Array.from([1, 2, 3]));
    expect(info).toHaveBeenCalledWith('[AI Request]', expect.objectContaining({
      url: 'https://api.relayonapi.com/v1/images/edits', method: 'POST', bodyEncoding: 'multipart',
      traceId: 'debug-1', body: preview.body,
    }));
  });

  it('redacts custom authentication names in request URL, headers and rendered fields', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const apiKey = 'custom-secret';
    logAiRequest(`https://api.example/images?auth=${apiKey}`, { method: 'POST', headers: { 'X-Custom-Auth': apiKey } }, 'test', {
      traceId: 'custom-auth', apiKey, body: { model: 'image', message: `echo ${apiKey}` },
    });
    const output = JSON.stringify(info.mock.calls);
    expect(output).not.toContain(apiKey);
    expect(output).toContain('api.example/images');
    expect(output).toContain('custom-auth');
    expect(info.mock.calls[0][1]).not.toHaveProperty('apiKey');
  });

  it.each([200, 400])('logs response status %s and request id without consuming its body or leaking media', (status) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const apiKey = 'CURRENT_PRIVATE_KEY', rawMedia = 'QUJD'.repeat(600);
    const response = new Response('not read by logger', { status, headers: { 'x-request-id': 'server-42', 'Set-Cookie': 'session=private' } });
    const payload = { request_id: 'server-42', [apiKey]: 'hidden-key', error: { code: 'source_fetch_failed',
      message: `echo ${apiKey}; fetch https://cdn.test/ref.png?sig=AZURE_SAS&X-Tos-Signature=TOS_SIGNATURE` },
      data: [{ b64_json: rawMedia }], imageBase64: rawMedia,
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: rawMedia } }] } }],
      file: 'failed file:///C:/Users/Alice/private/input.png', embedded: 'failed data:image/png;base64,QUJD',
      path: 'failed /mnt/private/input.png' };
    logAiResponse(response, payload, { url: 'https://api.relayonapi.com/v1/images/edits', method: 'POST', traceId: 'debug-1', apiKey });
    expect(response.bodyUsed).toBe(false);
    expect(info).toHaveBeenCalledWith('[AI Response]', expect.objectContaining({ status, ok: status < 400,
      traceId: 'debug-1', requestId: 'server-42', body: expect.objectContaining({ error: expect.objectContaining({ code: 'source_fetch_failed' }) }) }));
    const output = JSON.stringify(info.mock.calls);
    for (const secret of [apiKey, 'AZURE_SAS', 'TOS_SIGNATURE', rawMedia.slice(0, 40), 'Alice', '/mnt/private', 'QUJD']) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('encodedLength');
  });

  it('suppresses response logs for sensitive and production calls', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = new Response('{}');
    logAiResponse(response, { private: 'hidden' }, { url: 'https://api.example/result', sensitive: true });
    expect(info).not.toHaveBeenCalled();
    vi.stubEnv('DEV', false);
    try {
      logAiRequest('https://api.example/images', {}, 'test', { traceId: 'quiet', body: { prompt: 'private' } });
      logAiResponse(response, { private: 'hidden' }, { url: 'https://api.example/result' });
      expect(info).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it('redacts URL-decoded custom auth and userinfo even with lowercase percent escapes', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const apiKey = 'fixture/a';
    logAiResponse(new Response('{}'), { detail: 'https://user:private-password@host.test/result?auth=fixture%2fa',
      message: 'fetch https://host.test/result?auth=fixture%2fa' }, {
      url: 'https://host.test/images?auth=fixture%2fa', apiKey,
    });
    const output = JSON.stringify(info.mock.calls);
    expect(output).not.toContain('fixture');
    expect(output).not.toContain('private-password');
    expect(output).toContain('host.test/images');
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
