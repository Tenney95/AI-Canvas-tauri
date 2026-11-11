/**
 * volcengineImage — 回归测试：Volcengine Seedream image requests。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  corsSafeFetch: vi.fn(),
}));
const billingMocks = vi.hoisted(() => ({
  createBillingRun: vi.fn(),
  updateBillingRun: vi.fn(),
}));

vi.mock('../../src/services/ai/httpTransport', () => ({
  corsSafeFetch: transportMocks.corsSafeFetch,
}));
vi.mock('../../src/services/billing/volcengineBillingService', () => billingMocks);

import { generateVolcengineImage, generateVolcengineImagesBatch } from '../../src/services/ai/providers/volcengineImage';
import { getHttpResponseError, HttpResponseError } from '../../src/services/ai/httpUtils';
import { useAppStore } from '../../src/store/useAppStore';

const baseParams = {
  apiKey: 'ark-key',
  baseUrl: 'https://ark.example/api/v3',
  model: 'volcengine/doubao-seedream-5-0-pro-260628',
  provider: 'volcengine',
  prompt: '生成角色三视图',
  imageSize: '2K',
  aspectRatio: '16:9',
  imageUrls: ['https://cdn.example/reference.png'],
};

function successfulResponse() {
  return {
    ok: true,
    json: async () => ({ data: [{ url: 'https://cdn.example/result.png' }] }),
  };
}

describe('Volcengine Seedream image requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ projectExecutionContext: undefined });
    billingMocks.createBillingRun.mockResolvedValue(null);
    billingMocks.updateBillingRun.mockResolvedValue(null);
    transportMocks.corsSafeFetch.mockResolvedValue(successfulResponse());
  });

  it('uses the official 2K 16:9 pixel preset for Seedream 5.0 Pro', async () => {
    await expect(generateVolcengineImage(baseParams)).resolves.toEqual({
      url: 'https://cdn.example/result.png',
      width: 2816,
      height: 1584,
    });

    const request = transportMocks.corsSafeFetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({
      model: 'doubao-seedream-5-0-pro-260628',
      prompt: '生成角色三视图',
      image: ['https://cdn.example/reference.png'],
      size: '2816x1584',
    });
    expect(body).not.toHaveProperty('sequential_image_generation');
    expect(body).not.toHaveProperty('stream');
  });

  it('sends only the resolution tier when Seedream 5.0 Pro uses adaptive ratio', async () => {
    await generateVolcengineImage({ ...baseParams, aspectRatio: '自适应' });

    const request = transportMocks.corsSafeFetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.size).toBe('2K');
  });

  it('supports the documented 1.5K tier and pixel mapping', async () => {
    await expect(generateVolcengineImage({
      ...baseParams,
      imageSize: '1.5K',
      aspectRatio: '3:2',
    })).resolves.toMatchObject({ width: 1872, height: 1248 });

    const request = transportMocks.corsSafeFetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.size).toBe('1872x1248');
  });

  it('uses the Flash single-image contract for the reported portrait settings', async () => {
    await expect(generateVolcengineImagesBatch({ ...baseParams,
      model: 'volcengine/doubao-seedream-5-0-flash-260915', imageSize: '1.5K', aspectRatio: '9:16',
    }, 1)).resolves.toMatchObject({ requestedCount: 1, failedCount: 0,
      results: [{ width: 1152, height: 2048 }],
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0]?.[1].body));
    expect(body).toMatchObject({ model: 'doubao-seedream-5-0-flash-260915', size: '1152x2048' });
    expect(body).not.toHaveProperty('sequential_image_generation');
    expect(body).not.toHaveProperty('stream');
    expect(body).not.toHaveProperty('n');
  });

  it('keeps a single request rejection and HTTP metadata instead of reporting a batch failure', async () => {
    transportMocks.corsSafeFetch.mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'InvalidParameter', message: 'The parameter size is invalid.' },
    }), { status: 400 }));

    await expect(generateVolcengineImagesBatch(baseParams, 1)).rejects.toMatchObject({
      name: 'HttpResponseError', status: 400, definitiveFailure: true,
      message: 'The parameter size is invalid.',
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    expect(billingMocks.updateBillingRun).toHaveBeenLastCalledWith(null, expect.objectContaining({
      status: 'failed', calculatedMicros: 0,
    }));
  });

  it('redacts raw and encoded credentials before propagating or recording a provider error', async () => {
    const apiKey = 'ark secret+/~';
    const formKey = new URLSearchParams({ key: apiKey }).toString().slice(4);
    transportMocks.corsSafeFetch.mockResolvedValue(new Response(JSON.stringify({
      error: { message: `Permission denied: ${apiKey} ${encodeURIComponent(apiKey)} ${formKey}` },
    }), { status: 403 }));

    const error = await generateVolcengineImagesBatch({ ...baseParams, apiKey }, 1).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HttpResponseError);
    expect(error).toMatchObject({ status: 403, definitiveFailure: true,
      message: 'Permission denied: [REDACTED] [REDACTED] [REDACTED]',
    });
    expect(billingMocks.updateBillingRun).toHaveBeenLastCalledWith(null, expect.objectContaining({
      errorMessage: 'Permission denied: [REDACTED] [REDACTED] [REDACTED]',
    }));
  });

  it.each([408, 500, 504])('keeps HTTP %s without definitive rejection as an unknown billing outcome', async (status) => {
    transportMocks.corsSafeFetch.mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Upstream timeout' },
    }), { status }));
    await expect(generateVolcengineImagesBatch(baseParams, 1)).rejects.toMatchObject({ status, definitiveFailure: false });
    expect(billingMocks.updateBillingRun).toHaveBeenLastCalledWith(null, expect.objectContaining({
      status: 'unknown', calculatedMicros: null, amountConfidence: 'unknown',
    }));
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves AbortError and does not resubmit after cancellation', async () => {
    const aborted = new DOMException('Request aborted', 'AbortError');
    transportMocks.corsSafeFetch.mockRejectedValue(aborted);
    await expect(generateVolcengineImagesBatch(baseParams, 1)).rejects.toBe(aborted);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves partial successes when multiple individual requests were requested', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(successfulResponse())
      .mockRejectedValueOnce(new Error('connection lost')).mockRejectedValueOnce(new Error('connection lost'));
    await expect(generateVolcengineImagesBatch(baseParams, 3)).resolves.toMatchObject({
      requestedCount: 3, failedCount: 2, results: [{ url: 'https://cdn.example/result.png' }],
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(3);
  });

  it('keeps a concrete error when every requested image fails', async () => {
    const denied = new HttpResponseError(403, 'Model access denied', true);
    transportMocks.corsSafeFetch.mockRejectedValue(denied);
    await expect(generateVolcengineImagesBatch(baseParams, 2)).rejects.toBe(denied);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('does not let a rejected batch item hide another request with an unknown outcome', async () => {
    transportMocks.corsSafeFetch.mockRejectedValueOnce(new HttpResponseError(400, 'Invalid input', true))
      .mockRejectedValueOnce(new HttpResponseError(504, 'Upstream timeout'));
    const error = await generateVolcengineImagesBatch(baseParams, 2).catch((reason: unknown) => reason);
    expect(getHttpResponseError(error)).toMatchObject({ status: 504, definitiveFailure: false });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('surfaces an explicit business rejection in HTTP 200 without dropping usable results', async () => {
    const error = { code: 'content_policy_violation', message: 'Image rejected by safety checks' };
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error }), { status: 200 }));
    await expect(generateVolcengineImagesBatch(baseParams, 1)).rejects.toMatchObject({
      message: error.message, definitiveFailure: true,
    });
    transportMocks.corsSafeFetch.mockResolvedValueOnce({ ok: true,
      json: async () => ({ data: [{ url: 'https://cdn.example/result.png' }], error }),
    });
    await expect(generateVolcengineImagesBatch(baseParams, 1)).resolves.toMatchObject({
      results: [{ url: 'https://cdn.example/result.png' }], failedCount: 0,
    });
  });
});
