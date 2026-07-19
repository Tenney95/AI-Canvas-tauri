import { beforeEach, describe, expect, it, vi } from 'vitest';
import { corsSafeFetch } from '../../src/services/ai/httpTransport';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

beforeEach(() => {
  invokeMock.mockReset();
  vi.unstubAllGlobals();
});

describe('CORS-safe AI HTTP transport', () => {
  it('uses browser fetch outside Tauri', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await corsSafeFetch('https://gateway.example/models', { method: 'GET' });

    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/models', { method: 'GET' });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('uses proxy_fetch in Tauri and preserves UTF-8 JSON bodies', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    invokeMock.mockResolvedValue({
      status: 200,
      body: Buffer.from(JSON.stringify({ result: '完成' }), 'utf8').toString('base64'),
      headers: [['content-type', 'application/json']],
    });

    const response = await corsSafeFetch('https://gateway.example/v1/render', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '亚洲美女跳舞' }),
    });

    const request = invokeMock.mock.calls[0]?.[1]?.req as {
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
});
