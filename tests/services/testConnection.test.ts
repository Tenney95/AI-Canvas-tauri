/**
 * testConnection — 回归测试：provider connection tests。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  corsSafeFetch: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../../src/services/ai/httpTransport', () => transportMocks);
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/api/core')>(), invoke: transportMocks.invoke,
}));

import { queryProviderBalance, supportsProviderBalance, testProviderConnection } from '../../src/services/testConnection';

beforeEach(() => {
  transportMocks.corsSafeFetch.mockReset();
  transportMocks.invoke.mockReset();
});

describe('Muse 显式在线验证', () => {
  beforeEach(() => { vi.stubGlobal('window', { __TAURI_INTERNALS__: {} }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('先请求后台验证，再读缓存结果，不把已保存 Cookie 当作已登录', async () => {
    transportMocks.invoke.mockResolvedValueOnce({ loggedIn: false, credentialStored: true, sessionState: 'unverified', checking: true })
      .mockResolvedValueOnce({ loggedIn: true, credentialStored: true, sessionState: 'verified', checking: false });
    await expect(testProviderConnection('muse', '')).resolves.toEqual({ success: true });
    expect(transportMocks.invoke.mock.calls).toEqual([['muse_auth_status', { verify: true }], ['muse_auth_status']]);
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('仅本地保存或明确拒绝时不能报告连接成功', async () => {
    for (const state of ['unverified', 'invalid']) {
      transportMocks.invoke.mockResolvedValueOnce({ loggedIn: false, credentialStored: true, sessionState: state, checking: false });
      const result = await testProviderConnection('muse', '');
      expect(result.success).toBe(false);
      expect(result.error).toContain(state === 'invalid' ? '明确拒绝' : '尚未在线验证');
    }
  });

  it('不回显原生错误中的凭据或请求内容', async () => {
    transportMocks.invoke.mockRejectedValueOnce('fake-cookie-value request-detail');
    const result = await testProviderConnection('muse', '');
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('fake-cookie-value');
    expect(result.error).not.toContain('request-detail');
  });
});

describe('MiniMax 官方无生成验证', () => {
  it.each(['https://api.minimax.cn', 'https://api.minimax.io/v1/'])('只向当前官方连接查询系统音色：%s', async (baseUrl) => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(Response.json({ base_resp: { status_code: 0 }, system_voice: [] }));
    await expect(testProviderConnection('minimax', ' minimax-fixture ', baseUrl))
      .resolves.toEqual({ success: true, baseUrl: new URL(baseUrl).origin });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith(`${new URL(baseUrl).origin}/v1/get_voice`, {
      method: 'POST', headers: { Authorization: 'Bearer minimax-fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_type: 'system' }),
    });
  });

  it.each([
    { base_resp: { status_code: 1004, status_msg: 'private-fixture' }, system_voice: [] },
    { base_resp: { status_code: 0 } }, { system_voice: [] }, { base_resp: { status_code: 0 }, system_voice: 'not-an-array' },
  ])('业务拒绝或缺少正式数组不能因 HTTP200 或本地目录而宣称成功', async (payload) => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(Response.json(payload));
    const result = await testProviderConnection('minimax', 'minimax-fixture');
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('private-fixture');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
  });

  it('Key 或站点无效时不发送请求，网络异常不回显凭据', async () => {
    await expect(testProviderConnection('minimax', '   ')).resolves.toMatchObject({ success: false });
    await expect(testProviderConnection('minimax', 'minimax-fixture', 'https://another.example'))
      .resolves.toMatchObject({ success: false });
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    transportMocks.corsSafeFetch.mockRejectedValueOnce(new Error('minimax-fixture https://secret.example/raw'));
    const result = await testProviderConnection('minimax', 'minimax-fixture');
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('minimax-fixture');
    expect(result.error).not.toContain('secret.example');
  });

  it('HTTP401不切换国家站点或改发目录请求，也不猜测余额接口', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expect(testProviderConnection('minimax', 'fixture', 'https://api.minimax.io')).resolves.toMatchObject({ success: false, error: expect.stringContaining('401') });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    expect(supportsProviderBalance('minimax')).toBe(false);
  });
});

describe('独立剩余额度查询', () => {
  it.each([
    ['apimart', 'https://api.apib.ai/v1', 66.6104, '66.6104'],
    ['toapis', 'https://toapis.cn/v1', 0, '0'],
    ['toapis', 'https://toapis.com/v1/', 20000, '20,000'],
    ['toapis', 'https://proxy.example/gateway/v1', 1.25, '1.25'],
  ] as const)('%s 使用当前连接账户积分，不先拉目录：%s', async (provider, baseUrl, credits, amount) => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(Response.json({ success: true, remain_credits: credits, remain_balance: 999 }));
    const result = await queryProviderBalance(provider, ' key-fixture ', baseUrl);
    expect(result).toEqual({ amount, unit: '积分', scope: 'account' });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith(`${baseUrl.replace(/\/$/, '')}/user/balance`, expect.objectContaining({
      method: 'GET', headers: { Authorization: 'Bearer key-fixture' }, signal: expect.any(AbortSignal),
    }));
    expect(transportMocks.corsSafeFetch.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });

  it('明确的无限额度不显示成负数积分', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(Response.json({ success: true, unlimited_quota: true, remain_balance: -1, remain_credits: -200 }));
    await expect(queryProviderBalance('toapis', 'key-fixture')).resolves.toEqual({ amount: '∞', unit: '', scope: 'account' });
  });

  it('LibAPI 展示可用算力，不能把总额、冻结额或美元当成算力', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(Response.json({ balance: '$12.345678', available_balance: '$11.845678',
      credits: { balance: 88.888882, frozen: 3.6, available: 85.288882, unit: 'CREDIT', per_usd: 7.2 } }));
    await expect(queryProviderBalance('libapi', 'lib-key')).resolves.toEqual({ amount: '85.288882', unit: '算力', scope: 'account' });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://libapi.cc/v1/skills/balance', expect.objectContaining({ headers: { Authorization: 'Bearer lib-key' } }));
  });

  it('LibAPI 仅将明确的可用美元串作为回退，不猜算力换算', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(Response.json({ balance: '$9.5', available_balance: '$0.000000' }));
    await expect(queryProviderBalance('libapi', 'lib-key')).resolves.toEqual({ amount: '0', unit: 'USD', scope: 'account' });
  });

  it('Amam 原样使用账户积分字段', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(Response.json({ object: 'user.balance', balance: 105, used: 5, total: 110 }));
    await expect(queryProviderBalance('aigc-si', 'amam-key')).resolves.toEqual({ amount: '105', unit: '积分', scope: 'account' });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://aigc-si.com/v1/user/balance', expect.objectContaining({ headers: { Authorization: 'Bearer amam-key' } }));
  });

  it('GRSAI 用模型 Key 查询自身额度，不调用需要用户 Token 的账户接口', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(Response.json({ code: 0, data: { credits: 0 }, msg: 'success' }));
    await expect(queryProviderBalance('grsai', 'grs-key', 'https://grsai.dakka.com.cn/v1')).resolves.toEqual({ amount: '0', unit: '积分', scope: 'key' });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://grsai.dakka.com.cn/client/openapi/getAPIKeyCredits', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'grs-key' }),
    }));
  });

  it.each(['runninghub', 'runninghub-model'].flatMap((provider) => ['cn', 'ai'].map((site) => [provider, site] as const)))('RH %s 仅使用指定 %s 站点密钥', async (provider, site) => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(Response.json({ code: 0, data: { remainCoins: '120.5', currentTaskCounts: 3 } }));
    await expect(queryProviderBalance(provider, 'rh-key', `https://www.runninghub.${site}/openapi/v2`)).resolves.toEqual({ amount: '120.5', unit: '积分', scope: 'account' });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith(`https://www.runninghub.${site}/uc/openapi/accountStatus`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ apikey: 'rh-key' }),
    }));
  });

  it('Sora2U 沿用已有 GP 和来源参数，0 也可展示', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(Response.json({ success: true, balance: 0, currency: 'GP' }));
    await expect(queryProviderBalance('sora2u', 'sora-key')).resolves.toEqual({ amount: '0', unit: 'GP', scope: 'account' });
    expect(transportMocks.corsSafeFetch.mock.calls[0]?.[0]).toBe('https://sora2u.com/api/v1/credits?utm_source=tenney&utm_medium=canvas&utm_content=wx');
  });

  it.each([
    ['apimart', { success: false, remain_credits: 100 }],
    ['toapis', { success: true, remain_balance: 100 }],
    ['toapis', { success: true, remain_credits: null }],
    ['toapis', { success: true, remain_credits: true }],
    ['toapis', { success: true, remain_credits: '' }],
    ['toapis', { success: true, remain_credits: 'Infinity' }],
    ['libapi', { balance: '$10', credits: { balance: 72, unit: 'CREDIT' } }],
    ['libapi', { available_balance: 10 }],
    ['aigc-si', { balance: 123 }],
    ['grsai', { code: 401, data: { credits: 123 } }],
    ['runninghub-model', { code: 1, data: { remainCoins: 123 } }],
  ] as const)('%s 非合同成功响应不能伪装为余额：%j', async (provider, payload) => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(Response.json(payload));
    await expect(queryProviderBalance(provider, 'key-fixture')).resolves.toBeUndefined();
  });

  it.each(['cccapi', 'relayonapi', 'volcengine', 'custom-openai', '__proto__'])('未登记厂商 %s 不猜测端点', async (provider) => {
    expect(supportsProviderBalance(provider)).toBe(false);
    await expect(queryProviderBalance(provider, 'key-fixture', 'https://proxy.example/v1')).resolves.toBeUndefined();
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it.each(['http', 'network', 'json'])('查询失败 %s 不返回伪造 0、不重新提交', async (failure) => {
    if (failure === 'network') transportMocks.corsSafeFetch.mockRejectedValueOnce(new Error('network fixture'));
    else transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(failure === 'http' ? 'denied' : 'not json', { status: failure === 'http' ? 401 : 200 }));
    await expect(queryProviderBalance('toapis', 'key-fixture')).resolves.toBeUndefined();
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('取消覆盖已取得响应头、尚在读取正文的查询', async () => {
    let finish!: (payload: unknown) => void;
    const body = new Promise<unknown>((resolve) => { finish = resolve; });
    transportMocks.corsSafeFetch.mockResolvedValueOnce({ ok: true, json: () => body });
    const controller = new AbortController();
    const pending = queryProviderBalance('toapis', 'key-fixture', undefined, controller.signal);
    controller.abort();
    finish({ success: true, remain_credits: 123 });
    await expect(pending).resolves.toBeUndefined();
    expect(transportMocks.corsSafeFetch.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });
});

describe('provider connection tests', () => {
  it.each(['runninghub', 'runninghub-model'].flatMap((provider) => ['cn', 'ai'].map((site) => [provider, site] as const)))('RunningHub %s 连接使用 %s 站点的只读账户接口', async (provider, site) => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { remainCoins: '12', currentTaskCounts: '0' } })));
    await expect(testProviderConnection(provider, 'secret', `https://www.runninghub.${site}/openapi/v2`)).resolves.toMatchObject({ success: true, balance: '12 积分' });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(`https://www.runninghub.${site}/uc/openapi/accountStatus`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ apikey: 'secret' }) }));
  });
  it.each([
    ['apimart', 'https://api.example/v1/', 'https://api.example/v1/models'],
    ['volcengine', 'https://ark.example/api/v3', 'https://ark.example/api/v3/models'],
  ] as const)('tests %s through its read-only model catalog', async (provider, baseUrl, expectedUrl) => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    if (provider === 'apimart') {
      transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    }

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

  it.each([
    ['https://api.apimart.ai/v1/', 1000],
    ['https://api.apib.ai/v1', 0],
    ['https://relay.example/prefix/v1', 123.5],
  ])('reads APIMart user credits from the configured address %s', async (baseUrl, credits) => {
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(Response.json({
        success: true,
        remain_balance: 100,
        remain_credits: credits,
        used_credits: 255,
      }));

    const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
    await expect(testProviderConnection('apimart', 'secret', baseUrl)).resolves.toEqual({
      success: true,
      baseUrl: normalizedBaseUrl,
      balance: `${credits} 积分`,
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenLastCalledWith(`${normalizedBaseUrl}/user/balance`, {
      method: 'GET',
      headers: { Authorization: 'Bearer secret' },
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { success: false, message: '获取用户额度失败', remain_credits: 1000 },
    { success: true, remain_balance: 100 },
    { success: true, remain_credits: null },
    { success: true, remain_credits: 'unknown' },
    null,
  ])('does not display a fabricated balance for an invalid APIMart response: %j', async (payload) => {
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(Response.json(payload));

    await expect(testProviderConnection('apimart', 'secret')).resolves.toEqual({
      success: true,
      baseUrl: 'https://api.apib.ai/v1',
    });
  });

  it.each(['http', 'network', 'json'])('keeps a verified APIMart connection when balance lookup fails: %s', async (failure) => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(Response.json({ data: [] }));
    if (failure === 'network') {
      transportMocks.corsSafeFetch.mockRejectedValueOnce(new Error('network unavailable'));
    } else {
      transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response('unavailable', {
        status: failure === 'http' ? 429 : 200,
      }));
    }

    await expect(testProviderConnection('apimart', 'secret')).resolves.toEqual({
      success: true,
      baseUrl: 'https://api.apib.ai/v1',
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
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

  it('uses Anthropic catalog authentication without sending a generation request', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(testProviderConnection(
      'custom-openai',
      'secret',
      'https://relay.example/v1',
      'anthropic-compatible',
    )).resolves.toEqual({ success: true, baseUrl: 'https://relay.example/v1' });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://relay.example/v1/models',
      {
        method: 'GET',
        headers: { 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' },
      },
    );
  });

  it('uses Gemini authentication and /v1beta fallback for the model catalog', async () => {
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(testProviderConnection(
      'custom-openai',
      'secret',
      'https://relay.example',
      'gemini-native',
    )).resolves.toEqual({ success: true, baseUrl: 'https://relay.example/v1beta' });
    expect(transportMocks.corsSafeFetch.mock.calls.map((call) => call[0])).toEqual([
      'https://relay.example/models',
      'https://relay.example/v1beta/models',
    ]);
    expect(transportMocks.corsSafeFetch.mock.calls[0]?.[1]?.headers).toEqual({
      'x-goog-api-key': 'secret',
    });
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

  it('GRSAI 模型连接核对不调用独立余额查询或真实生成', async () => {
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
