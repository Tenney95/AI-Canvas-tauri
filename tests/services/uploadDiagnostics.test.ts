import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  logUploadFailureResponse, logUploadNetworkFailure, logUploadTransport, startUploadDiagnostics,
  type UploadDiagnosticContext,
} from '../../src/services/uploadDiagnostics';

const limit = 1024 * 1024;
const context = (secrets: string[] = []): UploadDiagnosticContext => ({
  id: 'upload-diagnostics-fixture', source: 'custom', endpoint: 'https://uguu.se/upload', startedAt: Date.now(), secrets,
});
function lastEvent(): Record<string, unknown> {
  const call = vi.mocked(console.info).mock.calls.at(-1)!;
  expect(call[0]).toBe('[Upload Diagnostics]');
  return JSON.parse(String(call[1])) as Record<string, unknown>;
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
  return [];
}
const output = () => vi.mocked(console.info).mock.calls.flatMap(([, value]) => strings(JSON.parse(String(value)))).join('\n');

beforeEach(() => {
  vi.stubEnv('DEV', true);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('上传诊断脱敏与响应读取边界', () => {
  it('请求只记录表单字段和文件摘要，保留真实 HTTP 地址，不记录字段值、文件名或素材正文', () => {
    const form = new FormData();
    form.append('files[]', new Blob(['private-image-bytes'], { type: 'image/png' }), String.raw`C:\Users\person\portrait.png`);
    form.append('folder', 'private-project-folder');
    form.append('upload_key', 'private-upload-key');
    const diagnostic = startUploadDiagnostics('uguu', 'https://uguu.se/upload', form, ['private-upload-key']);
    expect(diagnostic).toMatchObject({ id: expect.stringMatching(/^upload-/), source: 'uguu', endpoint: 'https://uguu.se/upload' });
    expect(lastEvent()).toMatchObject({ stage: 'request', method: 'POST', endpoint: 'https://uguu.se/upload', fields: [
      { name: 'files[]', type: 'file', bytes: 19, mimeType: 'image/png', filenameExtension: 'png' },
      { name: 'folder', type: 'text', value: '[OMITTED FORM VALUE]' },
      { name: 'upload_key', type: 'text', value: '[OMITTED FORM VALUE]' },
    ] });
    for (const privateValue of ['private-image-bytes', 'private-project-folder', 'private-upload-key', 'portrait.png', String.raw`C:\Users\person`]) {
      expect(output()).not.toContain(privateValue);
    }
  });

  it('502 JSON 保留完整非敏感错误详情和允许的响应头，清理密钥变体、账号、查询参数、路径和素材', async () => {
    const secret = 'fixture/key+"value';
    const encoded = encodeURIComponent(secret);
    const encodedLower = encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase());
    const body = {
      error: {
        code: 'BAD_GATEWAY', details: 'upstream connect failed before response headers',
        echoes: [secret, encoded, encodedLower, btoa(secret), btoa(`${secret}:`)],
      },
      authorization: `Bearer ${secret}`, cookie: 'session=private-cookie-value',
      localInput: String.raw`C:\Users\person\private-image.png`, unixInput: '/home/person/private-image.png',
      mediaSource: 'data:image/png;base64,cHJpdmF0ZS1pbWFnZS1ieXRlcw==',
      upstreamUrl: 'https://private-user:private-password@cdn.example/gateway?auth=private-query#private-fragment',
    };
    await logUploadFailureResponse(context([secret]), new Response(JSON.stringify(body), {
      status: 502, statusText: 'Bad Gateway', headers: {
        'content-type': 'application/json', server: 'nginx', 'x-request-id': 'gateway-request-123',
        location: 'https://redirect-user:redirect-pass@uguu.se/upload.php?trace=private-trace',
        'set-cookie': 'session=private-response-cookie', 'x-internal-private': 'private-internal-value',
      },
    }));
    const event = lastEvent();
    expect(event).toMatchObject({ stage: 'http-error', status: 502, statusText: 'Bad Gateway',
      body: { error: { code: 'BAD_GATEWAY', details: 'upstream connect failed before response headers' } },
      truncated: false, interrupted: null,
    });
    expect(event.headers).toEqual(expect.arrayContaining([
      ['content-type', 'application/json'], ['server', 'nginx'], ['x-request-id', 'gateway-request-123'],
    ]));
    expect(event.omittedHeaders).toEqual(expect.arrayContaining(['set-cookie', 'x-internal-private']));
    for (const privateValue of [secret, encoded, encodedLower, btoa(secret), btoa(`${secret}:`),
      'private-cookie-value', 'private-response-cookie', 'private-internal-value',
      'private-user', 'private-password', 'private-query', 'private-fragment', 'redirect-user', 'redirect-pass', 'private-trace',
      'private-image.png', 'cHJpdmF0ZS1pbWFnZS1ieXRlcw==']) {
      expect(output()).not.toContain(privateValue);
    }
    expect(output()).toContain('cdn.example/gateway');
    expect(output()).toContain('uguu.se/upload.php');
  });

  it('HTML 网关正文不按旧 200 字符截断，Bearer、Basic 和 JSON 转义的已知密钥仍脱敏', async () => {
    const secret = 'fixture/key';
    const html = `<html><title>502 Bad Gateway</title><body>${'!'.repeat(500)} upstream-tail-detail `
      + `Bearer unlisted-bearer-value Basic ${btoa(`${secret}:`)} echo ${secret.replaceAll('/', '\\/')}</body></html>`;
    await logUploadFailureResponse(context([secret]), new Response(html, { status: 502, headers: { 'content-type': 'text/html' } }));
    expect(lastEvent()).toMatchObject({ status: 502, truncated: false, bodyBytesRead: new TextEncoder().encode(html).byteLength });
    expect(String(lastEvent().body)).toContain('upstream-tail-detail');
    expect(String(lastEvent().body)).toContain('<title>502 Bad Gateway</title>');
    for (const privateValue of ['unlisted-bearer-value', secret, secret.replaceAll('/', '\\/'), btoa(`${secret}:`)]) {
      expect(output()).not.toContain(privateValue);
    }
  });

  it('超过 1 MiB 的响应明确标记截断并取消剩余流，不把限额内前缀称为完整响应', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(limit - 1).fill(33));
      controller.enqueue(new Uint8Array(64).fill(33));
    }, cancel });
    await logUploadFailureResponse(context(), new Response(stream, { status: 502, headers: { 'content-type': 'text/plain' } }));
    expect(lastEvent()).toMatchObject({ truncated: true, bodyBytesRead: limit, bodyLimitBytes: limit, interrupted: null });
    expect(String(lastEvent().body)).toHaveLength(limit);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('明确的二进制响应不读取正文，缺 MIME 但含 NUL 的内容也不输出', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('private-binary-media'));
    }, cancel });
    await logUploadFailureResponse(context(), new Response(stream, { status: 502, headers: { 'content-type': 'application/octet-stream' } }));
    expect(lastEvent()).toMatchObject({ body: '[OMITTED NON-TEXT RESPONSE]' });
    expect(cancel).toHaveBeenCalledOnce();
    await logUploadFailureResponse(context(), new Response(new Uint8Array([65, 0, 66]), { status: 502 }));
    expect(lastEvent()).toMatchObject({ body: '[OMITTED BINARY RESPONSE]' });
    expect(output()).not.toContain('private-binary-media');
  });

  it('传输日志仅取原生元数据与请求头白名单，保留端点和代理来源但不输出额外对象字段或凭据', () => {
    logUploadTransport(context(['header-fixture-secret']), {
      transport: 'tauri-stream', requestId: 'proxy-fixture', wireBytes: 321,
      contentType: 'multipart/form-data; boundary=fixture-boundary',
      headers: { Accept: 'application/json', Authorization: 'Bearer header-fixture-secret', Cookie: 'private-cookie', 'X-Custom-Auth': 'private-custom-auth' },
      native: {
        httpVersion: 'HTTP/2.0', remoteAddress: '127.0.0.1:18719', finalUrl: 'https://uguu.se/upload',
        proxyEnvironment: [['HTTPS_PROXY', 'http://proxy-user:proxy-password@127.0.0.1:18719/?token=proxy-token']],
        noProxyPresent: false, proxyPolicy: 'reqwest automatic', userAgent: 'AI-Canvas/0.1',
        fullHeaders: { Authorization: 'Bearer private-native-header' }, rawBody: 'private-native-body',
      },
    });
    expect(lastEvent()).toMatchObject({ stage: 'transport', transport: 'tauri-stream', requestId: 'proxy-fixture', wireBytes: 321,
      network: { httpVersion: 'HTTP/2.0', finalUrl: 'https://uguu.se/upload', noProxyPresent: false } });
    expect(lastEvent().headers).toEqual([['accept', 'application/json']]);
    for (const privateValue of ['header-fixture-secret', 'private-cookie', 'private-custom-auth', 'proxy-user', 'proxy-password', 'proxy-token', 'private-native-header', 'private-native-body', 'fullHeaders', 'rawBody']) {
      expect(output()).not.toContain(privateValue);
    }
    expect(output()).toContain('127.0.0.1:18719');
  });

  it('生产模式不创建诊断上下文或输出上传日志', async () => {
    vi.stubEnv('DEV', false);
    expect(startUploadDiagnostics('uguu', 'https://uguu.se/upload', new FormData())).toBeUndefined();
    logUploadTransport(context(), { transport: 'browser-fetch' });
    logUploadNetworkFailure(context(), new Error('private-network-error'));
    await logUploadFailureResponse(undefined, new Response('private-body', { status: 502 }));
    expect(console.info).not.toHaveBeenCalled();
  });

  it('控制台输出异常不影响诊断调用或失败响应清理', async () => {
    vi.mocked(console.info).mockImplementation(() => { throw new Error('console unavailable'); });
    const form = new FormData();
    form.append('files[]', new Blob(['image'], { type: 'image/png' }), 'reference.png');
    expect(startUploadDiagnostics('uguu', 'https://uguu.se/upload', form)).toBeDefined();
    expect(() => logUploadTransport(context(), { transport: 'tauri-buffered' })).not.toThrow();
    expect(() => logUploadNetworkFailure(context(), new Error('failed'))).not.toThrow();
    await expect(logUploadFailureResponse(context(), new Response('upstream failure', { status: 502 }))).resolves.toBeUndefined();
  });
});
