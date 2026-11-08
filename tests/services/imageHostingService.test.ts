import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageHostingConfig } from '../../src/types/imageHosting';

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn(), fetch: vi.fn() }));
vi.mock('../../src/services/providerSecretService', () => ({
  readAppSecret: mocks.read, writeAppSecret: mocks.write, deleteAppSecret: mocks.remove,
}));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.fetch }));

import { deleteImageHostingCredential, persistImageHosting, uploadCustomImage, validateImageHosting } from '../../src/services/imageHostingService';
import { IMAGE_HOSTING_TEMPLATES } from '../../src/services/imageHostingTemplates';

const ref = 'secret:image-host/01234567-0123-4123-8123-0123456789ab';
const base: ImageHostingConfig = {
  enabled: true, uploadUrl: 'https://images.example/upload', fileField: 'image', responseUrlPath: 'data.url', auth: 'none',
};
const blob = new Blob(['image-fixture'], { type: 'image/png' });
const json = (value: unknown) => new Response(JSON.stringify(value));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue('fixture-image-host-key');
  mocks.write.mockResolvedValue(true);
  mocks.fetch.mockImplementation(async () => json({ data: { url: 'https://cdn.example/image.png' } }));
});

describe('自定义图床合同', () => {
  it.each([
    ['apimart', '/uploads/images', 'file', { url: 'https://cdn.example/image.png' }],
    ['toapis', '/uploads/images', 'file', { success: true, data: { url: 'https://cdn.example/image.png' } }],
    ['libapi', '/files', 'file', { url: 'https://cdn.example/image.png' }],
    ['uguu', 'https://uguu.se/upload', 'files[]', { success: true, files: [{ url: 'https://cdn.example/image.png' }] }],
  ] as const)('%s 模板遵循内置请求字段、响应路径及连接身份', async (id, path, field, payload) => {
    const config = structuredClone(IMAGE_HOSTING_TEMPLATES.find((item) => item.id === id)!.config);
    const connection = { baseUrl: 'https://relay.example/team/v1/', apiKey: 'current-connection-key' };
    mocks.fetch.mockResolvedValueOnce(json(payload));
    expect(await uploadCustomImage(blob, 'reference.png', config, undefined, { connection })).toBe('https://cdn.example/image.png');
    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(id === 'uguu' ? path : `https://relay.example/team/v1${path}`);
    const form = init.body as FormData;
    expect(form.get(String(field))).toBeInstanceOf(Blob);
    expect(form.get('purpose')).toBe(id === 'toapis' ? 'generation' : null);
    expect(new Headers(init.headers).get('Authorization')).toBe(id === 'uguu' ? null : 'Bearer current-connection-key');
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('沿用当前连接 Key 不复制或写入图床凭据，跨源地址在发送前拒绝', async () => {
    const connection = { baseUrl: 'https://model.example/v1', apiKey: 'current-model-key' };
    const config = IMAGE_HOSTING_TEMPLATES.find((item) => item.id === 'apimart')!.config;
    const saved = await persistImageHosting(config, 'ignored-separate-key', connection);
    expect(JSON.stringify(saved)).not.toContain('current-model-key');
    expect(JSON.stringify(saved)).not.toContain('ignored-separate-key');
    expect(mocks.write).not.toHaveBeenCalled();
    for (const uploadUrl of ['https://other.example/upload', 'http://model.example/upload', 'https://model.example:444/upload']) {
      await expect(uploadCustomImage(blob, 'reference.png', { ...config, uploadUrl }, undefined, { connection })).rejects.toThrow('同源地址');
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('内置模板的成功标记、大小与格式限制继续生效', async () => {
    const connection = { baseUrl: 'https://model.example/v1', apiKey: 'model-key' };
    const toapis = IMAGE_HOSTING_TEMPLATES.find((item) => item.id === 'toapis')!.config;
    mocks.fetch.mockResolvedValueOnce(json({ data: { url: 'https://cdn.example/missing-success.png' } }));
    await expect(uploadCustomImage(blob, 'reference.png', toapis, undefined, { connection })).rejects.toThrow('未返回有效');
    const large = new Blob(['small']);
    Object.defineProperty(large, 'size', { value: 10 * 1024 * 1024 + 1, configurable: true });
    await expect(uploadCustomImage(large, 'reference.png', toapis, undefined, { connection })).rejects.toThrow('上传上限');
    await expect(uploadCustomImage(blob, 'reference.svg', toapis, undefined, { connection })).rejects.toThrow('格式');
    const apimart = IMAGE_HOSTING_TEMPLATES.find((item) => item.id === 'apimart')!.config;
    Object.defineProperty(large, 'size', { value: 20_000_001, configurable: true });
    await expect(uploadCustomImage(large, 'reference.png', apimart, undefined, { connection })).rejects.toThrow('上传上限');
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it.each(['bearer', 'header', 'form'] as const)('%s 只使用图床自己的密钥，并禁止记录原始请求', async (auth) => {
    const config: ImageHostingConfig = { ...base, auth, authField: auth === 'header' ? 'X-Upload-Token' : 'key', credentialRef: ref };
    expect(await uploadCustomImage(blob, 'reference.png', config)).toBe('https://cdn.example/image.png');
    expect(mocks.read).toHaveBeenCalledWith(ref.slice(7));
    const [url, init, options] = mocks.fetch.mock.calls[0] as [string, RequestInit, { sensitive: boolean }];
    expect(url).toBe(base.uploadUrl);
    expect(options).toEqual({ sensitive: true });
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    const form = init.body as FormData;
    expect((form.get('image') as File).name).toBe('reference.png');
    const headers = new Headers(init.headers);
    if (auth === 'form') {
      expect(form.get('key')).toBe('fixture-image-host-key');
      expect(headers.has('Authorization')).toBe(false);
    } else {
      expect(headers.get(auth === 'bearer' ? 'Authorization' : 'X-Upload-Token'))
        .toBe(auth === 'bearer' ? 'Bearer fixture-image-host-key' : 'fixture-image-host-key');
    }
  });

  it('无需鉴权时不读凭据，数组返回路径复用模型协议解析', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ files: [{ url: 'https://cdn.example/array.png' }] }));
    expect(await uploadCustomImage(blob, 'reference.png', { ...base, responseUrlPath: 'files[0].url' })).toBe('https://cdn.example/array.png');
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each([
    { uploadUrl: 'file:///private/image' }, { uploadUrl: 'https://user:pass@images.example/upload' },
    { uploadUrl: 'https://images.example/upload?key=secret' }, { uploadUrl: 'http://asset.localhost/image' },
    { fileField: 'file\r\nInjected' }, { responseUrlPath: 'data.__proto__.url' }, { responseUrlPath: 'data..url' },
    { auth: 'header' as const, authField: 'Content-Type', credentialRef: ref },
    { auth: 'form' as const, authField: 'image', credentialRef: ref },
    { auth: 'bearer' as const, credentialRef: 'secret:provider/model-key' },
    { formFields: [{ name: 'file', value: 'conflicts-with-image' }, { name: 'file', value: 'duplicate' }], fileField: 'file' },
    { formFields: [{ name: 'purpose', value: 'a' }, { name: 'purpose', value: 'b' }] },
    { formFields: [{ name: 'apiKey', value: 'must-not-persist' }] },
    { successPath: '__proto__.success' },
  ])('无效配置在任何网络操作前失败：%j', async (patch) => {
    await expect(uploadCustomImage(blob, 'reference.png', { ...base, ...patch })).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('换 Key 只新建凭据引用，普通配置和删除操作都不接触模型凭据', async () => {
    const saved = await persistImageHosting({ ...base, auth: 'bearer', credentialRef: ref }, 'new-host-key');
    expect(saved?.credentialRef).toMatch(/^secret:image-host\//);
    expect(saved?.credentialRef).not.toBe(ref);
    expect(JSON.stringify(saved)).not.toContain('new-host-key');
    expect(mocks.write).toHaveBeenCalledWith(saved!.credentialRef!.slice(7), 'new-host-key', { value: null });
    await deleteImageHostingCredential('secret:provider/model-key');
    expect(mocks.remove).not.toHaveBeenCalled();
    await deleteImageHostingCredential(ref);
    expect(mocks.remove).toHaveBeenCalledWith(ref.slice(7));
  });

  it('凭据保存或读取失败时停止，不把模型 Key 当成图床 Key', async () => {
    mocks.write.mockResolvedValueOnce(false);
    await expect(persistImageHosting({ ...base, auth: 'bearer' }, 'fixture-key')).rejects.toThrow('图床密钥保存失败');
    mocks.read.mockResolvedValueOnce(null);
    await expect(uploadCustomImage(blob, 'reference.png', { ...base, auth: 'bearer', credentialRef: ref })).rejects.toThrow('图床密钥不存在');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(() => validateImageHosting({ ...base, enabled: false, uploadUrl: '' })).not.toThrow();
  });

  it.each([
    () => new Response('upstream echoes fixture-image-host-key', { status: 401 }),
    () => new Response('<html>fixture-image-host-key</html>'),
    () => json({ success: false, data: { url: 'https://cdn.example/rejected.png' } }),
    () => json({ data: { url: 'javascript:alert(1)' } }),
    () => json({ data: { url: 'http://asset.localhost/private.png' } }),
    () => json({ data: { url: 'https://user:password@cdn.example/private.png' } }),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
  ])('HTTP 错误、异常响应和非公网链接不带出原文或密钥', async (response) => {
    mocks.fetch.mockResolvedValueOnce(response());
    const error = await uploadCustomImage(blob, 'reference.png', base).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('fixture-image-host-key');
  });

  it('取消信号保留为取消结果，不继续发起上传', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(uploadCustomImage(blob, 'reference.png', base, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('读取凭据期间连接已变化时，在真正发送前停止', async () => {
    await expect(uploadCustomImage(blob, 'reference.png', { ...base, auth: 'bearer', credentialRef: ref }, undefined,
      { beforeUpload: () => { throw new Error('连接配置已变化'); } })).rejects.toThrow('连接配置已变化');
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
