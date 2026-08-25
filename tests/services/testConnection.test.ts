import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  corsSafeFetch: vi.fn(),
}));

vi.mock('../../src/services/ai/httpTransport', () => transportMocks);

import { testProviderConnection } from '../../src/services/testConnection';

beforeEach(() => {
  transportMocks.corsSafeFetch.mockReset();
});

describe('provider connection tests', () => {
  it.each([
    ['apimart', 'https://api.example/v1/', 'https://api.example/v1/models'],
    ['volcengine', 'https://ark.example/api/v3', 'https://ark.example/api/v3/models'],
  ] as const)('tests %s through its read-only model catalog', async (provider, baseUrl, expectedUrl) => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(testProviderConnection(provider, 'secret', baseUrl)).resolves.toEqual({
      success: true,
      baseUrl: expectedUrl.replace(/\/models$/, ''),
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(expectedUrl, {
      method: 'GET',
      headers: { Authorization: 'Bearer secret' },
    });
    expect(transportMocks.corsSafeFetch.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });

  it('returns the catalog authentication error without issuing a generation request', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { message: 'invalid api key' },
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(testProviderConnection('apimart', 'bad-key')).resolves.toEqual({
      success: false,
      error: 'HTTP 401: invalid api key',
    });
  });

  it('falls back to /v1 when the pasted base URL omits it', async () => {
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(testProviderConnection('custom-openai', 'secret', 'relay.example')).resolves.toEqual({
      success: true,
      baseUrl: 'https://relay.example/v1',
    });
    expect(transportMocks.corsSafeFetch.mock.calls.map((call) => call[0])).toEqual([
      'https://relay.example/models',
      'https://relay.example/v1/models',
    ]);
  });

  it('stops probing on an authentication failure instead of trying more addresses', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { message: 'invalid api key' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }));

    await expect(testProviderConnection('xai', 'bad-key')).resolves.toEqual({
      success: false,
      error: 'HTTP 401: invalid api key',
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('does not send a request when GRSAI has no confirmed free verification endpoint', async () => {
    await expect(testProviderConnection('grsai', 'secret')).resolves.toMatchObject({
      success: false,
      unsupported: true,
    });
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('uses the shared transport for the non-billing RunningHub account endpoint', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      code: 0,
      data: { remainCoins: 120 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(testProviderConnection('runninghub-model', 'secret')).resolves.toEqual({
      success: true,
      balance: '120 积分',
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://www.runninghub.cn/uc/openapi/accountStatus',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('tests Sora2U through the tracked read-only credits endpoint', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      balance: 1280,
      currency: 'GP',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(testProviderConnection('sora2u', 'sk_sora_secret')).resolves.toEqual({
      success: true,
      balance: '1280 GP',
      baseUrl: 'https://sora2u.com',
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://sora2u.com/api/v1/credits?utm_source=tenney&utm_medium=canvas&utm_content=wx',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer sk_sora_secret' },
      },
    );
  });
});
