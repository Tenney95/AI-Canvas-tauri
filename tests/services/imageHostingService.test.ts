import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageHostingConfig } from '../../src/types/imageHosting';

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn(), fetch: vi.fn() }));
vi.mock('../../src/services/providerSecretService', () => ({
  readAppSecret: mocks.read, writeAppSecret: mocks.write, deleteAppSecret: mocks.remove,
}));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.fetch }));

import { deleteImageHostingCredential, persistImageHosting, uploadCustomImage, validateImageHosting } from '../../src/services/imageHostingService';
import { IMAGE_HOSTING_TEMPLATES, PUBLIC_IMAGE_HOSTING_TEMPLATES, SCDN_IMAGE_HOSTING_CDNS, resolveGlobalImageHosting } from '../../src/services/imageHostingTemplates';

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
  it('国内候选位于海外服务之前，排序不改变默认 Uguu', () => {
    expect(PUBLIC_IMAGE_HOSTING_TEMPLATES.slice(0, 6).map((item) => item.id))
      .toEqual(['scdn', 'picui', 'helloimg', 'imgurl', 'bohe', 'uguu']);
    expect(new Set(PUBLIC_IMAGE_HOSTING_TEMPLATES.map((item) => item.id)).size).toBe(PUBLIC_IMAGE_HOSTING_TEMPLATES.length);
    expect(resolveGlobalImageHosting().uploadUrl).toBe('https://uguu.se/upload');
    expect(resolveGlobalImageHosting({ provider: 'imgbb', configs: {} }).uploadUrl).toBe('https://api.imgbb.com/1/upload');
  });

  it.each(SCDN_IMAGE_HOSTING_CDNS)('SCDN $label 使用图片字段和大陆 CDN 参数，不传模型密钥', async ({ value }) => {
    const config = resolveGlobalImageHosting({ provider: 'scdn', configs: {} });
    config.formFields = config.formFields!.map((field) => field.name === 'cdn_domain' ? { ...field, value } : field);
    mocks.fetch.mockResolvedValueOnce(json({ success: true, data: { url: `https://${value}/i/image.png` } }));
    expect(await uploadCustomImage(blob, 'reference.png', config, undefined,
      { connection: { apiKey: 'unrelated-model-key', baseUrl: 'https://model.example/v1' } })).toBe(`https://${value}/i/image.png`);
    const [endpoint, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('https://img.scdn.io/api/v1.php');
    const form = init.body as FormData;
    expect(form.get('image')).toBeInstanceOf(Blob);
    expect(form.get('cdn_domain')).toBe(value);
    expect(form.get('outputFormat')).toBe('png');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('Hello图床支持游客和独立 Bearer Token，响应必须有真实成功标记', async () => {
    const config = resolveGlobalImageHosting({ provider: 'helloimg', configs: {} });
    const payload = { status: true, data: { links: { url: 'https://cdn.example/hello.png' } } };
    mocks.fetch.mockResolvedValueOnce(json(payload));
    expect(await uploadCustomImage(blob, 'reference.png', config)).toBe('https://cdn.example/hello.png');
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://www.helloimg.com/api/v1/upload');
    expect((mocks.fetch.mock.calls[0][1].body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValueOnce(json(payload));
    await uploadCustomImage(blob, 'reference.png', { ...config, auth: 'bearer', credentialRef: ref });
    expect(new Headers(mocks.fetch.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer fixture-image-host-key');
    mocks.fetch.mockResolvedValueOnce(json({ ...payload, status: false }));
    await expect(uploadCustomImage(blob, 'reference.png', config)).rejects.toThrow('未返回有效');
  });

  it('ImgURL V3 必须有独立 Token，按 code=200 和 data.url 读取结果', async () => {
    const config = resolveGlobalImageHosting({ provider: 'imgurl', configs: {} });
    await expect(uploadCustomImage(blob, 'reference.png', config)).rejects.toThrow('图床密钥');
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValueOnce(json({ code: 200, data: { url: 'https://cdn.example/imgurl.png' } }));
    expect(await uploadCustomImage(blob, 'reference.png', { ...config, credentialRef: ref })).toBe('https://cdn.example/imgurl.png');
    const [endpoint, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('https://www.imgurl.org/api/v3/upload');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fixture-image-host-key');
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob);
    mocks.fetch.mockResolvedValueOnce(json({ code: -1000, data: { url: 'https://cdn.example/rejected.png' } }));
    await expect(uploadCustomImage(blob, 'reference.png', { ...config, credentialRef: ref })).rejects.toThrow('未返回有效');
  });

  it('薄荷使用用户的会员专用 API 地址、表单 Token 和顶层 url，缺地址不写凭据', async () => {
    const config = resolveGlobalImageHosting({ provider: 'bohe', configs: {} });
    await expect(persistImageHosting(config, 'member-token')).rejects.toThrow('上传地址');
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    const member = { ...config, uploadUrl: 'https://member.example/api/upload/', credentialRef: ref };
    mocks.fetch.mockResolvedValueOnce(json({ status: 'success', statusCode: '200', url: 'https://cdn.example/bohe.png' }));
    expect(await uploadCustomImage(blob, 'reference.png', member)).toBe('https://cdn.example/bohe.png');
    const [endpoint, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe(member.uploadUrl);
    const form = init.body as FormData;
    expect(form.get('uploadedFile')).toBeInstanceOf(Blob);
    expect(form.get('api_token')).toBe('fixture-image-host-key');
    expect(form.get('upload_format')).toBe('file');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    mocks.fetch.mockResolvedValueOnce(json({ status: 'error', statusCode: '402', url: 'https://cdn.example/rejected.png' }));
    await expect(uploadCustomImage(blob, 'reference.png', member)).rejects.toThrow('未返回有效');
  });

  it('全局缺省使用 Uguu，配置损坏或沿用模型密钥时不能静默换站', () => {
    expect(resolveGlobalImageHosting().uploadUrl).toBe('https://uguu.se/upload');
    expect(() => resolveGlobalImageHosting({ provider: 'unknown', configs: {} } as never)).toThrow('类型无效');
    expect(() => resolveGlobalImageHosting({ provider: 'catbox', configs: { catbox: { ...base, enabled: false } } })).toThrow('已停用');
    expect(() => resolveGlobalImageHosting({ provider: 'imgbb', configs: { imgbb: { ...base, credentialSource: 'connection' } } })).toThrow('自己的密钥');
    const resolved = resolveGlobalImageHosting({ provider: 'catbox', configs: {} });
    resolved.formFields![0].value = 'changed';
    expect(resolveGlobalImageHosting({ provider: 'catbox', configs: {} }).formFields![0].value).toBe('fileupload');
  });

  it.each([
    ['imgbb', 'image', { success: true, data: { url: 'https://cdn.example/image.png' } }],
    ['freeimage', 'source', { status_code: 200, image: { url: 'https://cdn.example/image.png' } }],
    ['picui', 'file', { status: true, data: { links: { url: 'https://cdn.example/image.png' } } }],
  ] as const)('%s 公共图床使用各自字段和响应，不携带模型 Key', async (id, fileField, payload) => {
    const config = structuredClone(PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === id)!.config);
    if (config.auth !== 'none') config.credentialRef = ref;
    mocks.fetch.mockResolvedValueOnce(json(payload));
    expect(await uploadCustomImage(blob, 'reference.png', config, undefined,
      { connection: { apiKey: 'unrelated-model-key', baseUrl: 'https://model.example/v1' } })).toBe('https://cdn.example/image.png');
    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(config.uploadUrl);
    const form = init.body as FormData;
    expect(form.get(fileField)).toBeInstanceOf(Blob);
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
    expect(form.get('key')).toBe(id === 'picui' ? null : 'fixture-image-host-key');
    expect(form.get('action')).toBe(id === 'freeimage' ? 'upload' : null);
    expect(Array.from(form.values())).not.toContain('unrelated-model-key');
  });

  it('Catbox 匿名纯文本与可选 userhash 均按原合同发送，异常文本不能伪装成链接', async () => {
    const config = PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === 'catbox')!.config;
    mocks.fetch.mockResolvedValueOnce(new Response('https://files.catbox.moe/example.png\n'));
    expect(await uploadCustomImage(blob, 'reference.png', config)).toBe('https://files.catbox.moe/example.png');
    const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect((init.body as FormData).get('reqtype')).toBe('fileupload');
    expect((init.body as FormData).get('userhash')).toBeNull();
    expect(new Headers(init.headers).get('Accept')).toBe('text/plain');
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValueOnce(new Response('https://files.catbox.moe/example.png'));
    await uploadCustomImage(blob, 'reference.png', { ...config, auth: 'form', authField: 'userhash', credentialRef: ref });
    expect((mocks.fetch.mock.calls[1][1].body as FormData).get('userhash')).toBe('fixture-image-host-key');
    for (const value of ['Upload error: rejected', 'https://cdn.example/image.png\nrejected', 'javascript:alert(1)', 'x'.repeat(1024 * 1024 + 1)]) {
      mocks.fetch.mockResolvedValueOnce(new Response(value));
      await expect(uploadCustomImage(blob, 'reference.png', config)).rejects.toThrow('未返回有效');
    }
  });

  it('ImageKit 从原生凭据生成 Basic 头并另传当前文件名', async () => {
    const config = { ...PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === 'imagekit')!.config, credentialRef: ref };
    mocks.fetch.mockResolvedValueOnce(json({ url: 'https://ik.imagekit.io/example/image.jpg' }));
    expect(await uploadCustomImage(blob, 'reference.jpeg', config)).toBe('https://ik.imagekit.io/example/image.jpg');
    const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    const form = init.body as FormData;
    expect((form.get('file') as File).name).toBe('reference.jpg');
    expect(form.get('fileName')).toBe('reference.jpg');
    expect(form.get('useUniqueFileName')).toBe('true');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Basic ${btoa('fixture-image-host-key:')}`);
  });

  it('Cloudinary 使用 unsigned preset，未填写 Cloud name 时不会发送', async () => {
    const template = PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === 'cloudinary')!.config;
    await expect(uploadCustomImage(blob, 'reference.png', template)).rejects.toThrow('配置项');
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValueOnce(json({ secure_url: 'https://res.cloudinary.com/example/image.png' }));
    const config = { ...template, uploadUrl: 'https://api.cloudinary.com/v1_1/example/image/upload', formFields: [{ name: 'upload_preset', value: 'public-images' }] };
    expect(await uploadCustomImage(blob, 'reference.png', config)).toBe('https://res.cloudinary.com/example/image.png');
    const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect((init.body as FormData).get('upload_preset')).toBe('public-images');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(mocks.read).not.toHaveBeenCalled();
  });

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
    { responseFormat: 'xml' as never },
    { responseFormat: 'text' as const, successPath: 'success' },
    { fileNameField: 'image' },
    { fileNameField: 'fileName', formFields: [{ name: 'fileName', value: 'duplicate.png' }] },
    { fileNameField: 'apiKey' },
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
