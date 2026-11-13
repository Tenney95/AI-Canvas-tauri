import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sign: vi.fn(), fetch: vi.fn() }));
vi.mock('../../src/services/ai/providers/volcengineSigner', () => ({ signVolcengineRequest: mocks.sign }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.fetch }));

import { createAsset, listAssetGroups, validateVolcengineAssetInputUrl } from '../../src/services/ai/providers/volcengineAssetLibrary';

const options = { accessKeyId: 'fixture-ak', secretAccessKey: 'fixture-secret', projectName: 'asset-project' };
const input = { assetType: 'Image' as const, groupId: 'group-fixture', name: '素材', url: 'https://images.example/reference.png' };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sign.mockResolvedValue({ headers: { Authorization: 'fixture-signature' } });
  mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ Result: { Id: 'asset-fixture' } })));
});

describe('火山私域素材库 URL 与请求边界', () => {
  it.each([
    '', 'not-a-url', 'data:image/png;base64,AAAA', 'blob:https://example.com/id',
    'file:///private/reference.png', 'asset://localhost/reference.png', 'http://asset.localhost/reference.png',
    'https:images.example/reference.png', 'https://user:password@images.example/reference.png',
    'https://images.example/reference image.png', 'https://images.example/ref\nerence.png',
    'https://bucket.tos-cn-beijing.ivolces.com/reference.png?X-Tos-Signature=fixture',
    'https://BUCKET.TOS-CN-BEIJING.IVOLCES.COM./reference.png', 'https://tos-cn-beijing.ivolces.com/reference.png',
  ])('非法素材地址在签名和网络请求前被拒绝：%s', async (url) => {
    await expect(createAsset(options, { ...input, url })).rejects.toThrow('素材库');
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['Image', 'Video', 'Audio'] as const)('%s 保留公网预签名地址的参数与原编码，不混用内网推理 URL', async (assetType) => {
    const signedUrl = 'https://bucket.tos-cn-beijing.volces.com/%E7%B4%A0%E6%9D%90.png?X-Tos-Credential=ak%2Fdate&X-Tos-Signature=AbC%2b123&name=a%20b';
    expect(validateVolcengineAssetInputUrl(` ${signedUrl} `)).toBe(signedUrl);
    expect(await createAsset(options, { ...input, assetType, url: signedUrl })).toEqual({ id: 'asset-fixture' });
    const [endpoint, init, transportOptions] = mocks.fetch.mock.calls[0] as [string, RequestInit, { sensitive: boolean }];
    expect(new URL(endpoint).searchParams.get('Action')).toBe('CreateAsset');
    expect(JSON.parse(init.body as string)).toEqual({ AssetType: assetType, GroupId: input.groupId,
      Name: input.name, ProjectName: options.projectName, URL: signedUrl });
    expect(transportOptions).toEqual({ sensitive: true });
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(mocks.sign.mock.calls[0][0].body).URL).toBe(signedUrl);
  });

  it('素材库只读请求同样禁止传输日志，且保留原有分页合同', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ Result: { Items: [{ Id: 'group-one', Name: '组一' }], TotalCount: 1 } })));
    const result = await listAssetGroups(options);
    expect(result.items[0]).toMatchObject({ id: 'group-one', name: '组一' });
    expect(mocks.fetch.mock.calls[0][2]).toEqual({ sensitive: true });
  });

  it.each([
    () => new Response('fixture-secret https://private.example/?X-Tos-Signature=private', { status: 403 }),
    () => new Response('invalid JSON fixture-secret https://private.example/?X-Tos-Signature=private'),
    () => new Response('null'),
    () => new Response(JSON.stringify('fixture-secret https://private.example/?X-Tos-Signature=private')),
    () => new Response(JSON.stringify({ ResponseMetadata: { Error: { Message: 'fixture-secret https://private.example/?X-Tos-Signature=private' } } })),
  ])('上游错误不反射响应正文、密钥或签名素材地址', async (response) => {
    mocks.fetch.mockResolvedValueOnce(response());
    const error = await createAsset(options, input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('fixture-secret');
    expect((error as Error).message).not.toContain('https://');
    expect((error as Error).message).not.toContain('X-Tos-Signature');
  });

  it('传输错误不带出签名或凭据，取消仍保留取消结果', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('fixture-secret https://private.example/?X-Tos-Signature=private'));
    await expect(createAsset(options, input)).rejects.toThrow('请检查 AK/SK、接口地址和网络');
    const controller = new AbortController();
    controller.abort();
    mocks.sign.mockClear(); mocks.fetch.mockClear();
    await expect(createAsset({ ...options, signal: controller.signal }, input)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
