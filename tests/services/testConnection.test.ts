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

    await expect(testProviderConnection(provider, 'secret', baseUrl)).resolves.toEqual({ success: true });
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
});
