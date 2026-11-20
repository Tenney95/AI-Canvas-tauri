/**
 * mediaDownloadAccess — 回归测试：media download authorization。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { APIMART_BASE_URL, GRSAI_BASE_URL } from '../../src/constants/api';
import { useAppStore } from '../../src/store/useAppStore';
import { createMediaDownloadAccess, resolveMediaDownloadRequest, sanitizeMediaDownloadAccess, sanitizeMediaResultUrls } from '../../src/services/ai/mediaDownloadAccess';
import { buildRunningHubSiteProviders, runningHubCredentialId } from '../../src/services/runninghubSiteCredentials';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState((state) => ({ config: { ...state.config, providers: {
    original: { name: '原连接', baseUrl: 'https://gateway.example/v1', apiKey: 'current-fixture-key' },
    other: { name: '另一组', baseUrl: 'https://gateway.example/v1', apiKey: 'other-fixture-key' },
  } } }));
});

describe('media download authorization', () => {
  it('rebuilds the original connection’s current key and never stores it in its descriptor', async () => {
    const access = createMediaDownloadAccess('original', 'https://gateway.example/v1', { type: 'bearer' });
    const request = await resolveMediaDownloadRequest('https://gateway.example/v1/videos/result/content', access);
    expect(request.downloadAccess).toEqual({ origin: 'https://gateway.example', headers: { Authorization: 'Bearer current-fixture-key' } });
    expect(JSON.stringify(access)).not.toContain('fixture-key');
    expect(JSON.stringify(request)).not.toContain('other-fixture-key');
  });

  it('leaves signed external CDN URLs intact without credentials', async () => {
    const url = 'https://cdn.example/video.mp4?signature=a%2fb%2Bc';
    expect(await resolveMediaDownloadRequest(url, createMediaDownloadAccess('original', 'https://gateway.example/v1'))).toEqual({ url });
  });

  it.each([
    { connection: 'runninghub', site: 'cn', active: 'ai', key: 'workflow-cn' },
    { connection: 'runninghub-model', site: 'ai', active: 'cn', key: 'model-ai' },
  ] as const)('RunningHub $connection 切站后只为原站结果使用原站凭据', async ({ connection, site, active, key }) => {
    const origin = `https://www.runninghub.${site}`, activeOrigin = `https://www.runninghub.${active}`;
    const access = createMediaDownloadAccess(connection, origin, { type: 'bearer' });
    const providers = buildRunningHubSiteProviders({}, { name: 'RunningHub', baseUrl: activeOrigin, apiKey: '' }, {
      cn: { workflowKey: 'workflow-cn', modelKey: 'model-cn' },
      ai: { workflowKey: 'workflow-ai', modelKey: 'model-ai' },
    });
    useAppStore.setState((state) => ({ config: { ...state.config, providers } }));
    const url = `${origin}/file`;
    expect(await resolveMediaDownloadRequest(url, access)).toEqual({ url, downloadAccess: { origin, headers: { Authorization: `Bearer ${key}` } } });
    for (const external of [`${activeOrigin}/file`, 'https://cdn.example/file?signature=original']) {
      expect(await resolveMediaDownloadRequest(external, access)).toEqual({ url: external });
    }
    const alteredOrigin = origin.replace('https:', 'http:');
    await expect(resolveMediaDownloadRequest(`${alteredOrigin}/file`, createMediaDownloadAccess(connection, alteredOrigin))).rejects.toThrow('原媒体连接');
    const remaining = { ...providers };
    delete remaining[runningHubCredentialId(site, connection)];
    useAppStore.setState((state) => ({ config: { ...state.config, providers: remaining } }));
    await expect(resolveMediaDownloadRequest(url, access)).rejects.toThrow();
  });

  it('旧 RunningHub 单站连接沿用国内站默认地址', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      runninghub: { name: '旧工作流', apiKey: 'legacy-fixture' },
    } } }));
    const origin = 'https://www.runninghub.cn';
    const result = await resolveMediaDownloadRequest(`${origin}/file`, createMediaDownloadAccess('runninghub', origin));
    expect(result.downloadAccess?.headers).toEqual({ Authorization: 'Bearer legacy-fixture' });
  });

  it.each(['https://gateway.example@evil.example/video', 'https://user:pass@gateway.example/video'])(
    'rejects userinfo in a result URL: %s', async (url) => {
      await expect(resolveMediaDownloadRequest(url, createMediaDownloadAccess('original', 'https://gateway.example/v1'))).rejects.toThrow();
    },
  );

  it('fails closed when the original connection changes origin or is removed', async () => {
    const access = createMediaDownloadAccess('original', 'https://gateway.example/v1');
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      original: { ...state.config.providers.original, baseUrl: 'https://replacement.example/v1' },
    } } }));
    await expect(resolveMediaDownloadRequest('https://gateway.example/content', access)).rejects.toThrow('原媒体连接');
    expect(await resolveMediaDownloadRequest('https://cdn.example/video', access)).toEqual({ url: 'https://cdn.example/video' });
  });

  it('uses the APIMart default origin when its saved base URL is empty, without sending the key across origins', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      apimart: { name: 'APIMart', baseUrl: '', apiKey: 'fixture-apimart-key' },
    } } }));
    const access = createMediaDownloadAccess('apimart', APIMART_BASE_URL, { type: 'bearer' });
    const sameOrigin = await resolveMediaDownloadRequest(`${APIMART_BASE_URL}/video`, access);
    expect(sameOrigin.downloadAccess?.headers).toEqual({ Authorization: 'Bearer fixture-apimart-key' });
    expect(await resolveMediaDownloadRequest('https://cdn.example/video', access)).toEqual({ url: 'https://cdn.example/video' });
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      apimart: { ...state.config.providers.apimart, baseUrl: 'https://new.example/v1' },
    } } }));
    await expect(resolveMediaDownloadRequest(`${APIMART_BASE_URL}/video`, access)).rejects.toThrow('原媒体连接');
  });

  it('uses the GRSAI default origin only for its matching original connection', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      grsai: { name: 'GRSAI', baseUrl: '', apiKey: 'fixture-grsai-key' },
    } } }));
    const access = createMediaDownloadAccess('grsai', GRSAI_BASE_URL, { type: 'bearer' });
    expect((await resolveMediaDownloadRequest(`${GRSAI_BASE_URL}/video`, access)).downloadAccess?.headers)
      .toEqual({ Authorization: 'Bearer fixture-grsai-key' });
    expect(await resolveMediaDownloadRequest('https://cdn.example/video', access)).toEqual({ url: 'https://cdn.example/video' });
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      grsai: { ...state.config.providers.grsai, baseUrl: 'https://new.example/v1' },
    } } }));
    await expect(resolveMediaDownloadRequest(`${GRSAI_BASE_URL}/video`, access)).rejects.toThrow('原媒体连接');
  });

  it('supports explicit custom header and query auth without persisting their values', async () => {
    const header = await resolveMediaDownloadRequest('https://gateway.example/file', createMediaDownloadAccess('original', 'https://gateway.example/v1',
      { type: 'header', name: 'x-api-key', prefix: 'Token ' }));
    expect(header.downloadAccess?.headers).toEqual({ 'x-api-key': 'Token current-fixture-key' });
    const access = createMediaDownloadAccess('original', 'https://gateway.example/v1', { type: 'query', name: 'key' });
    const query = await resolveMediaDownloadRequest('https://gateway.example/file?part=1', access);
    expect(new URL(query.url).searchParams.get('key')).toBe('current-fixture-key');
    expect(query.downloadAccess?.queryAuthName).toBe('key');
    expect(JSON.stringify(access)).not.toContain('fixture-key');
  });

  it('sanitizes untrusted access descriptors and refuses inline/credential-bearing recovery references', () => {
    expect(sanitizeMediaDownloadAccess({ providerConfigId: 'original', origin: 'https://gateway.example',
      auth: { type: 'bearer', apiKey: 'excluded' }, headers: { Authorization: 'excluded' } })).toEqual({
      providerConfigId: 'original', origin: 'https://gateway.example', auth: { type: 'bearer' },
    });
    expect(sanitizeMediaDownloadAccess({ providerConfigId: 'original', origin: 'https://gateway.example/unsafe' })).toBeUndefined();
    expect(sanitizeMediaResultUrls(['data:image/png;base64,AAAA'])).toBeUndefined();
    expect(sanitizeMediaResultUrls(['https://gateway.example/file?key=current-fixture-key'], 'current-fixture-key')).toBeUndefined();
    expect(sanitizeMediaResultUrls(['https://cdn.example/result.png'])).toEqual(['https://cdn.example/result.png']);
  });
});
