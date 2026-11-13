/**
 * referenceImageTransport — 回归测试：共享参考图压缩的实际请求边界。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transport: vi.fn(), invoke: vi.fn(), readSecret: vi.fn(), native: false, optimizerNative: true }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.transport }));
vi.mock('../../src/services/providerSecretService', async (original) => ({
  ...await original<object>(), readAppSecret: mocks.readSecret,
}));
vi.mock('@tauri-apps/api/core', async (original) => ({
  ...await original<object>(), invoke: mocks.invoke, isTauri: () => mocks.optimizerNative,
}));
vi.mock('../../src/services/fs/core', async (original) => ({
  ...await original<object>(), isTauriEnv: () => mocks.native,
  getAssetUrlFromPath: async () => 'asset://localhost/native-reference.png',
}));

import { generateImagesBatch } from '../../src/services/ai/generateImage';
import { IMAGE_GENERATION_DATA_URL_BUDGET, resolveImageDataUrlArray, resolveImageUrlArray, resolveNodeImageUrl } from '../../src/services/ai/imageUtils';
import { getMediaReferenceUrl } from '../../src/services/ai/connectedReferenceMedia';
import { resolvePromptWithMediaRefs } from '../../src/services/ai/promptResolver';
import { generateImageStandard } from '../../src/services/ai/providers/standardImage';
import { uploadRunningHubMedia } from '../../src/services/ai/providers/runninghubClient';
import { resolveMediaReferenceUrl, uploadToRemote } from '../../src/services/uploadService';
import { previewModelProtocolRequest } from '../../src/services/ai/modelProtocol';
import { useAppStore } from '../../src/store/useAppStore';
import type { ImageHostingConfig, PublicImageHostingProvider } from '../../src/types/imageHosting';
import { IMAGE_HOSTING_TEMPLATES, PUBLIC_IMAGE_HOSTING_TEMPLATES } from '../../src/services/imageHostingTemplates';
import { LIBAPI_BASE_URL, TOAPIS_BASE_URL } from '../../src/constants/api';

// 请求链模拟原生无损返回，用 PNG 的标记追踪引用；真实像素保真由 Rust 测试验证。
function png(marker: number, megabytes = 5): Blob {
  const chunk = (name: string, payload: Uint8Array) => {
    const bytes = new Uint8Array(payload.length + 12);
    new DataView(bytes.buffer).setUint32(0, payload.length);
    bytes.set(new TextEncoder().encode(name), 4); bytes.set(payload, 8);
    return bytes;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, 4096); view.setUint32(4, 2160); header[8] = 8; header[9] = 2;
  const payload = new Uint8Array(Math.max(1, Math.round(megabytes * 1024 * 1024))); payload[0] = marker;
  return new Blob([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', payload), chunk('IEND', new Uint8Array()),
  ], { type: 'image/png' });
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const asDataUrl = async (blob: Blob) => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
const imageMarker = async (blob: Blob) => new Uint8Array(await blob.slice(41, 42).arrayBuffer())[0];
async function assertPreparedPng(blob: Blob, marker: number) {
  expect(blob.type).toBe('image/png');
  const header = new DataView(await blob.slice(0, 42).arrayBuffer());
  expect([header.getUint32(16), header.getUint32(20)]).toEqual([4096, 2160]);
  expect(await imageMarker(blob)).toBe(marker);
  expect(blob.size).toBe(png(marker, 0).size);
}
async function optimizePng(command: string, input: ArrayBuffer): Promise<ArrayBuffer> {
  if (command !== 'optimize_reference_png') throw new Error('Unexpected native command');
  return png(new Uint8Array(input)[41], 0).arrayBuffer();
}
const decode = vi.fn();
const encode = vi.fn();
const localFetch = vi.fn();

beforeEach(() => {
  vi.resetAllMocks(); mocks.native = false; mocks.optimizerNative = true;
  useAppStore.setState(useAppStore.getInitialState(), true);
  mocks.invoke.mockImplementation(optimizePng);
  vi.stubGlobal('fetch', localFetch);
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('OffscreenCanvas', encode);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('共享参考图压缩的实际请求边界', () => {
  it.each(['custom', 'toapis'])('%s 格式的自定义连接上传参考图，生成请求收到该图床 URL', async (format) => {
    useAppStore.setState((state) => ({ config: { ...state.config, imageHosting: { provider: 'catbox', configs: {} } } }));
    const imageHosting: ImageHostingConfig = format === 'toapis'
      ? structuredClone(IMAGE_HOSTING_TEMPLATES.find((item) => item.id === 'toapis')!.config)
      : { enabled: true, uploadUrl: 'https://own-host.example/upload', fileField: 'image', responseUrlPath: 'data.url', auth: 'none' };
    const uploadUrl = format === 'toapis' ? 'https://model.example/v1/uploads/images' : imageHosting.uploadUrl;
    useAppStore.getState().saveProviderConfig('own-host-relay', {
      name: '自己的连接', apiKey: 'model-key-only', catalogId: 'custom-openai', baseUrl: 'https://model.example/v1', imageHosting,
      selectedModels: [{ id: 'hosted-image', name: 'Hosted Image', category: 'image', provider: 'own-host-relay',
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/images', body: { model: '{{model}}', prompt: '{{prompt}}', images: '{{imageUrls}}' } },
          response: { type: 'json', result: { urlPath: 'url' } } } } }],
    });
    mocks.transport.mockImplementation(async (url) => url === uploadUrl
      ? json({ success: true, data: { url: 'https://own-cdn.example/reference.png' } }) : json({ url: 'https://model.example/output.png' }));
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'own-host-relay')!;
    await generateImagesBatch({ provider: 'general', model: `general/${model.id}`, prompt: '参考图片生成', image_urls: [await asDataUrl(png(21, 0))] }, 1);
    expect(mocks.transport.mock.calls.map(([url]) => url)).toEqual([uploadUrl, 'https://model.example/v1/images']);
    const upload = mocks.transport.mock.calls[0][1] as RequestInit;
    expect(new Headers(upload.headers).get('Authorization')).toBe(format === 'toapis' ? 'Bearer model-key-only' : null);
    expect((upload.body as FormData).get('purpose')).toBe(format === 'toapis' ? 'generation' : null);
    await assertPreparedPng((upload.body as FormData).get(imageHosting.fileField) as File, 21);
    expect(JSON.parse(mocks.transport.mock.calls[1][1].body as string).images).toEqual(['https://own-cdn.example/reference.png']);
    expect(localFetch).not.toHaveBeenCalled();
  });

  it('修改图床配置后不沿用旧缓存，上传失败不回退公共图床，迟到结果不写缓存', async () => {
    const imageHosting: ImageHostingConfig = { enabled: true, uploadUrl: 'https://host-one.example/upload', fileField: 'file', responseUrlPath: 'data.url', auth: 'none' };
    const provider = 'host-cache-relay';
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      [provider]: { name: '图床缓存', apiKey: 'model-key', catalogId: 'custom-openai', imageHosting },
    } } }));
    const source = await asDataUrl(png(22, 0));
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    mocks.transport.mockImplementation(async () => json({ data: { url: 'https://cdn.example/cached.png' } }));
    expect(await uploadToRemote(source, provider)).toBe('https://cdn.example/cached.png');
    expect(await uploadToRemote(source, provider)).toBe('https://cdn.example/cached.png');
    expect(mocks.transport).toHaveBeenCalledOnce();
    useAppStore.getState().setProviderConfig(provider, { imageHosting: { ...imageHosting, uploadUrl: 'https://host-two.example/upload' } });
    mocks.transport.mockRejectedValueOnce(new Error('network-failure'));
    await expect(uploadToRemote(source, provider)).rejects.toThrow('自定义图床上传失败');
    expect(localFetch).not.toHaveBeenCalled();
    mocks.transport.mockImplementationOnce(async () => {
      useAppStore.getState().setProviderConfig(provider, { imageHosting: { ...imageHosting, enabled: false } });
      return json({ data: { url: 'https://cdn.example/stale.png' } });
    });
    await expect(uploadToRemote(source, provider)).rejects.toThrow('连接配置已变化');
    expect(JSON.stringify([...storage.values()])).not.toContain('stale.png');
  });

  it.each(['picui', 'catbox'] as const)('普通中转图片使用所选全局 %s，停用的连接图床不覆盖全局设置', async (hostingProvider) => {
    const template = PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === hostingProvider)!.config;
    const provider = `global-reference-${hostingProvider}`;
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: { provider: hostingProvider, configs: {} },
      providers: { [provider]: { name: '普通中转', catalogId: 'custom-openai', apiKey: 'relay-model-key',
        imageHosting: { ...template, enabled: false } } },
    } }));
    const remote = `https://cdn.example/global-${hostingProvider}.png`;
    mocks.transport.mockImplementation(async () => hostingProvider === 'catbox' ? new Response(remote)
      : json({ status: true, data: { links: { url: remote } } }));
    expect(await uploadToRemote(await asDataUrl(png(31, 0)), provider)).toBe(remote);
    expect(mocks.transport).toHaveBeenCalledOnce();
    const [endpoint, init] = mocks.transport.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe(template.uploadUrl);
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
    await assertPreparedPng((init.body as FormData).get(template.fileField) as File, 31);
    expect(localFetch).not.toHaveBeenCalled();
    expect(mocks.readSecret).not.toHaveBeenCalled();
  });

  it.each(['toapis', 'libapi'] as const)('%s 内置上传优先，不读取尚未填写密钥的全局图床', async (catalogId) => {
    const provider = `${catalogId}-global-priority`;
    const baseUrl = catalogId === 'toapis' ? TOAPIS_BASE_URL : LIBAPI_BASE_URL;
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: { provider: 'imagekit', configs: {} },
      providers: { [provider]: { name: catalogId, catalogId, apiKey: 'connection-only-key', baseUrl } },
    } }));
    const remote = `https://cdn.example/${catalogId}-dedicated.png`;
    mocks.transport.mockImplementation(async () => json(catalogId === 'toapis'
      ? { success: true, data: { url: remote } } : { url: remote }));
    expect(await uploadToRemote(await asDataUrl(png(32, 0)), provider)).toBe(remote);
    expect(mocks.transport).toHaveBeenCalledOnce();
    const [endpoint, init] = mocks.transport.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe(`${baseUrl}/${catalogId === 'toapis' ? 'uploads/images' : 'files'}`);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer connection-only-key');
    expect((init.body as FormData).get('purpose')).toBe(catalogId === 'toapis' ? 'generation' : null);
    expect(localFetch).not.toHaveBeenCalled();
    expect(mocks.readSecret).not.toHaveBeenCalled();
  });

  it('全局图床上传失败时直接报错，不重试或切换到 Uguu', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, imageHosting: { provider: 'picui', configs: {} } } }));
    mocks.transport.mockResolvedValueOnce(new Response('denied', { status: 403 }));
    await expect(uploadToRemote(await asDataUrl(png(33, 0)), 'global-failure-relay')).rejects.toThrow('HTTP 403');
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(mocks.transport.mock.calls[0][0]).toBe('https://picui.cn/api/v1/upload');
    expect(localFetch).not.toHaveBeenCalled();
  });

  it('全局服务、密钥引用及表单参数隔离缓存，未选服务的配置不影响缓存', async () => {
    const provider = 'global-cache-isolation-relay';
    const source = await asDataUrl(png(34, 0));
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const select = (hostingProvider: PublicImageHostingProvider, config?: ImageHostingConfig) => {
      useAppStore.setState((state) => ({ config: { ...state.config,
        imageHosting: { provider: hostingProvider, configs: config ? { [hostingProvider]: config } : {} },
      } }));
    };
    let uploads = 0;
    mocks.transport.mockImplementation(async (endpoint) => {
      const remote = `https://cdn.example/global-cache-${++uploads}.png`;
      return endpoint === 'https://catbox.moe/user/api.php' ? new Response(remote)
        : json({ status: true, success: true, data: { url: remote, links: { url: remote } } });
    });
    select('picui');
    expect(await uploadToRemote(source, provider)).toBe('https://cdn.example/global-cache-1.png');
    expect(await uploadToRemote(source, provider)).toBe('https://cdn.example/global-cache-1.png');
    useAppStore.setState((state) => ({ config: { ...state.config, imageHosting: { provider: 'picui', configs: {
      catbox: { ...PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === 'catbox')!.config, formFields: [{ name: 'reqtype', value: 'fileupload' }] },
    } } } }));
    expect(await uploadToRemote(source, provider)).toBe('https://cdn.example/global-cache-1.png');
    expect(mocks.transport).toHaveBeenCalledOnce();
    select('catbox');
    expect(await uploadToRemote(source, provider)).toBe('https://cdn.example/global-cache-2.png');
    const refOne = 'secret:image-host/01234567-0123-4123-8123-0123456789ab';
    const refTwo = 'secret:image-host/11234567-0123-4123-8123-0123456789ab';
    mocks.readSecret.mockImplementation(async (key) => key === refOne.slice('secret:'.length) ? 'hosting-key-one' : 'hosting-key-two');
    const imgbb = { ...PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === 'imgbb')!.config, credentialRef: refOne };
    select('imgbb', imgbb);
    expect(await uploadToRemote(source, provider)).toBe('https://cdn.example/global-cache-3.png');
    select('imgbb', { ...imgbb, credentialRef: refTwo });
    expect(await uploadToRemote(source, provider)).toBe('https://cdn.example/global-cache-4.png');
    select('imgbb', { ...imgbb, credentialRef: refTwo, formFields: [{ name: 'name', value: 'changed-name' }] });
    expect(await uploadToRemote(source, provider)).toBe('https://cdn.example/global-cache-5.png');
    expect(await uploadToRemote(source, provider)).toBe('https://cdn.example/global-cache-5.png');
    expect(mocks.transport).toHaveBeenCalledTimes(5);
    expect((mocks.transport.mock.calls[2][1].body as FormData).get('key')).toBe('hosting-key-one');
    expect((mocks.transport.mock.calls[3][1].body as FormData).get('key')).toBe('hosting-key-two');
    expect((mocks.transport.mock.calls[4][1].body as FormData).get('name')).toBe('changed-name');
    expect(JSON.stringify([...storage.values()])).not.toContain('hosting-key-');
    expect(JSON.stringify([...storage.values()])).not.toContain('secret:image-host/');
    expect(localFetch).not.toHaveBeenCalled();
  });

  it('上传期间切换全局图床时拒绝迟到结果，不缓存或自动重传到新服务', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    useAppStore.setState((state) => ({ config: { ...state.config, imageHosting: { provider: 'picui', configs: {} } } }));
    const source = await asDataUrl(png(35, 0));
    mocks.transport.mockImplementationOnce(async () => {
      useAppStore.setState((state) => ({ config: { ...state.config, imageHosting: { provider: 'catbox', configs: {} } } }));
      return json({ status: true, data: { links: { url: 'https://cdn.example/global-stale.png' } } });
    });
    await expect(uploadToRemote(source, 'global-stale-relay')).rejects.toThrow('连接配置已变化');
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(JSON.stringify([...storage.values()])).not.toContain('global-stale.png');
    mocks.transport.mockImplementationOnce(async () => new Response('https://cdn.example/global-fresh.png'));
    expect(await uploadToRemote(source, 'global-stale-relay')).toBe('https://cdn.example/global-fresh.png');
    expect(mocks.transport.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      'https://picui.cn/api/v1/upload', 'https://catbox.moe/user/api.php',
    ]);
    expect(localFetch).not.toHaveBeenCalled();
  });

  it.each(['gpt-image-2', 'vendor-image'])('标准 multipart 模型 %s 按序发送原格式 4K PNG 及匹配的文件名', async (modelName) => {
    useAppStore.setState((state) => ({ config: { ...state.config, imageHosting: { provider: 'imagekit', configs: {} } } }));
    localFetch.mockImplementation(async (url) => new Response(png(Number(String(url).match(/(\d)\.png$/)![1]))));
    mocks.transport.mockResolvedValue(json({ data: [{ url: 'https://cdn.example/result.png' }] }));
    await generateImageStandard({ apiKey: 'test-key', baseUrl: 'https://relay.example/v1', modelName,
      prompt: '合影', dimensions: { width: 1024, height: 1024 }, imageReferenceRequestMode: 'edits-multipart',
      imageUrls: [1, 2, 3].map((id) => `asset://localhost/${id}.png`),
    });
    const files = (mocks.transport.mock.calls[0][1].body as FormData).getAll('image[]') as File[];
    expect(files.map((file) => [file.type, file.name])).toEqual([1, 2, 3].map((id) => ['image/png', `reference-${id}.png`]));
    for (const [index, file] of files.entries()) await assertPreparedPng(file, index + 1);
    expect(decode).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
  });

  it.each(['grsai', 'custom-json', 'custom-multipart'])('%s 生成入口发送压缩图并保留自定义路径和顺序', async (route) => {
    const multipart = route === 'custom-multipart';
    const protocol = {
      version: 2 as const, mode: 'sync' as const,
      submit: { method: 'POST' as const, path: '/custom/edit', bodyEncoding: multipart ? 'multipart' as const : 'json' as const,
        body: multipart ? { images: { $file: '{{imageUrls}}', filename: 'reference.png', contentType: 'image/png' } }
          : { images: '{{imageUrls}}' },
      }, response: { type: 'json' as const, result: { urlPath: 'url' } },
    };
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: { provider: 'imagekit', configs: {} },
      providers: { grsai: { name: 'GRSAI', apiKey: 'test-key', baseUrl: 'https://grsai.example/v1' },
        custom: { name: '自定义', apiKey: 'test-key', catalogId: 'custom-openai', baseUrl: 'https://custom.example/v1',
          imageHosting: { enabled: true, uploadUrl: 'https://unused-host.example/upload', fileField: 'file', responseUrlPath: 'data.url', auth: 'none' } } },
      generalModels: [{ id: 'compressed-image', modelId: 'vendor-image', name: '自定义', category: 'image', providerConfigId: 'custom',
        imageReferenceRequestMode: 'generation-json-image-data-urls', executionProfile: { preset: 'custom', protocol } }],
    } }));
    const dataUrl = await asDataUrl(png(1));
    localFetch.mockImplementation(async () => new Response(png(2)));
    mocks.transport.mockResolvedValue(json(route === 'grsai'
      ? { status: 'succeeded', results: [{ url: 'https://cdn.example/result.png' }] } : { url: 'https://cdn.example/result.png' }));
    await generateImagesBatch({ provider: route === 'grsai' ? 'grsai' : 'general',
      model: route === 'grsai' ? 'grsai/nano-banana-2' : 'general/compressed-image', prompt: '两人合影',
      image_urls: [dataUrl, 'asset://localhost/second.png'],
    }, 1);
    const [url, init] = mocks.transport.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(route === 'grsai' ? 'https://grsai.example/v1/api/generate' : 'https://custom.example/v1/custom/edit');
    if (multipart) {
      const body = new TextDecoder().decode(init.body as ArrayBuffer);
      expect(body.match(/Content-Type: image\/png/g)).toHaveLength(2);
      expect(body.match(/filename="reference.png"/g)).toHaveLength(2);
      expect(body).not.toContain('image/jpeg');
      expect(body.indexOf(`IDAT${String.fromCharCode(1)}`)).toBeLessThan(body.indexOf(`IDAT${String.fromCharCode(2)}`));
      const preview = previewModelProtocolRequest({ baseUrl: 'https://custom.example/v1', protocol,
        variables: { imageUrls: [await asDataUrl(png(1, 0))] } });
      expect(preview.body).toEqual({ images: [{ $file: `[data URL image/png, ${png(1, 0).size} bytes]`, filename: 'reference.png', contentType: 'image/png' }] });
    } else {
      const references: string[] = JSON.parse(init.body as string).images;
      expect(references.every((value) => value.startsWith('data:image/png;base64,'))).toBe(true);
      expect(references.map((value) => Buffer.from(value.split(',')[1], 'base64')[41])).toEqual([1, 2]);
    }
    expect(mocks.transport).toHaveBeenCalledOnce();
  });

  it.each(['apimart', 'custom-relay', 'cccapi', 'google', 'xai'])('%s 公网 URL 上传复用压缩并沿用缓存', async (provider) => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: undefined,
      providers: { apimart: { name: 'APIMart', apiKey: 'test-key', baseUrl: 'https://upload.example/v1' } },
    } }));
    localFetch.mockResolvedValue(json({ success: true, files: [{ url: 'https://cdn.example/ready.png' }] }));
    mocks.transport.mockResolvedValue(json({ url: 'https://cdn.example/ready.png' }));
    const source = await asDataUrl(png(7));
    expect(await uploadToRemote(source, provider)).toBe('https://cdn.example/ready.png');
    const uploads = provider === 'apimart' ? mocks.transport : localFetch;
    const [endpoint, init] = uploads.mock.calls.find(([, request]) => request?.method === 'POST')!;
    expect(endpoint).toBe(provider === 'apimart' ? 'https://upload.example/v1/uploads/images' : 'https://uguu.se/upload');
    const file = (init.body as FormData).get(provider === 'apimart' ? 'file' : 'files[]') as File;
    await assertPreparedPng(file, 7);
    expect(file.name).toMatch(/\.png$/);
    await uploadToRemote(source, provider);
    expect(uploads).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
  });

  it('桌面图床 IPC 的 multipart 字节也已压缩，MIME 与后缀一致', async () => {
    mocks.native = true;
    localFetch.mockResolvedValue(new Response(png(8)));
    mocks.invoke.mockImplementation(async (command, payload) => command === 'proxy_fetch'
      ? { status: 200, body: btoa(JSON.stringify({ success: true, files: [{ url: 'https://cdn.example/native.png' }] })) }
      : optimizePng(command, payload));
    await uploadToRemote('asset://localhost/native.png', 'native-relay');
    const [command, payload] = mocks.invoke.mock.calls.find(([name]) => name === 'proxy_fetch')!;
    expect(command).toBe('proxy_fetch');
    const body = atob(payload.req.body);
    expect(body).toContain('Content-Type: image/png');
    expect(body).toMatch(/filename="[^\r\n"]+\.png"/);
    const pngStart = body.indexOf(`${String.fromCharCode(137)}PNG`);
    expect(pngStart).toBeGreaterThan(0);
    expect(body.charCodeAt(pngStart + 41)).toBe(8);
    expect(body.length).toBeLessThan(1024);
  });

  it.each([
    ['apimart', 'image', 'png'],
    ['expiry-relay', 'image', 'png'],
    ['apimart', 'video', 'mp4'],
    ['apimart', 'audio', 'mp3'],
  ] as const)('%s 的 %s 本地引用在 2.5 小时边界重传并保留上传通道', async (provider, kind, ext) => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { apimart: { name: 'APIMart', apiKey: 'test-key', baseUrl: 'https://upload.example/v1' } },
    } }));
    // 内联字节有稳定摘要；Web 中无法核实内容的 asset URL 按新策略不复用缓存。
    const localUrl = await asDataUrl(new Blob([`media-${provider}-${kind}`], { type: kind === 'image' ? 'image/png' : `${kind}/${ext}` }));
    const generatedUrl = `https://expired.example/generated.${ext}`;
    const url = getMediaReferenceUrl({ kind, url: localUrl, sourceUrl: generatedUrl, origin: 'connection', role: 'reference' });
    expect(url).toBe(localUrl);
    let uploads = 0;
    const upload = async () => {
      const uploadedUrl = `https://cdn.example/expiry-${++uploads}.${ext}`;
      return json(provider === 'apimart' && kind === 'image'
        ? { url: uploadedUrl } : { success: true, files: [{ url: uploadedUrl }] });
    };
    localFetch.mockImplementation(upload);
    mocks.transport.mockImplementation(upload);
    const resolve = () => resolveMediaReferenceUrl(url, { provider, kind, mode: 'publicUrl' });
    expect(await resolve()).toBe(`https://cdn.example/expiry-1.${ext}`);
    now += 150 * 60_000 - 1;
    expect(await resolve()).toBe(`https://cdn.example/expiry-1.${ext}`);
    expect(uploads).toBe(1);
    now += 1;
    expect(await resolve()).toBe(`https://cdn.example/expiry-2.${ext}`);
    now += 1;
    expect(await resolve()).toBe(`https://cdn.example/expiry-2.${ext}`);
    const requests = [...localFetch.mock.calls, ...mocks.transport.mock.calls].filter(([, init]) => init?.method === 'POST');
    expect(requests).toHaveLength(2);
    const apimartImage = provider === 'apimart' && kind === 'image';
    for (const [endpoint, init] of requests) {
      expect(endpoint).toBe(apimartImage ? 'https://upload.example/v1/uploads/images' : 'https://uguu.se/upload');
      expect((init.body as FormData).has(apimartImage ? 'file' : 'files[]')).toBe(true);
      if (apimartImage) expect(init.headers).toEqual({ Authorization: 'Bearer test-key' });
    }
    expect(localFetch.mock.calls.some(([source]) => source === generatedUrl)).toBe(false);
  });

  it('@ 图片有本地副本时，即使旧生成地址能加载也走本地上传', async () => {
    const loaded = vi.fn();
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      set src(url: string) { loaded(url); queueMicrotask(() => this.onload?.()); }
    });
    const remote = 'https://cdn.example/still-reachable.png';
    expect(await resolveNodeImageUrl(remote, '/project/data/reference.png')).toBe('asset://localhost/native-reference.png');
    expect(loaded).not.toHaveBeenCalled();
    useAppStore.setState({ nodes: [{ id: 'expiry-mentioned', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: '参考图', imageUrl: remote, sourceUrl: remote, filePath: '/project/data/reference.png' },
    }] });
    const media = await resolvePromptWithMediaRefs('@{expiry-mentioned:参考图}');
    expect(media.imageUrls).toEqual(['asset://localhost/native-reference.png']);
    localFetch.mockImplementation(async (_url, init?: RequestInit) => init?.method === 'POST'
      ? json({ success: true, files: [{ url: 'https://cdn.example/mentioned-upload.png' }] })
      : new Response(new Blob(['image'], { type: 'image/png' })));
    expect(await resolveImageUrlArray(media.imageUrls, 'mentioned-expiry-relay')).toEqual(['https://cdn.example/mentioned-upload.png']);
  });

  it('RunningHub 图片上传复用压缩，视频原字节保留', async () => {
    localFetch.mockImplementation(async (url) => new Response(String(url).endsWith('.png') ? png(9) : new Blob(['video'], { type: 'video/mp4' })));
    mocks.transport.mockImplementation(async () => json({ code: 200, data: { filename: 'uploaded', download_url: 'https://cdn.example/uploaded' } }));
    for (const kind of ['image', 'video'] as const) {
      await uploadRunningHubMedia({ baseUrl: 'https://runninghub.example', apiKey: 'test-key' },
        `asset://localhost/reference.${kind === 'image' ? 'png' : 'mp4'}`, kind);
    }
    const files = mocks.transport.mock.calls.map(([, init]) => (init.body as FormData).get('file') as File);
    expect(files.map((file) => [file.type, file.name])).toEqual([['image/png', 'reference.png'], ['video/mp4', 'reference.mp4']]);
    await assertPreparedPng(files[0], 9);
    expect(await files[1].text()).toBe('video');
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
  });

  it('工作流内联媒体引用经过压缩，公网 URL 直传不额外下载转存', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, imageHosting: { provider: 'imagekit', configs: {} } } }));
    const result = await resolveMediaReferenceUrl(await asDataUrl(png(4)), { mode: 'dataUrl', kind: 'image' });
    expect(result === await asDataUrl(png(4, 0))).toBe(true);
    expect(await resolveImageUrlArray(['https://cdn.example/original.png'], 'other-relay')).toEqual(['https://cdn.example/original.png']);
    expect(localFetch).not.toHaveBeenCalled();
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it('Base64 路径先压缩再校验 8 MiB 输出边界，但读取仍受 32 MiB 限制', async () => {
    localFetch.mockResolvedValueOnce(new Response(png(3, 9)));
    const fromFile = await resolveImageDataUrlArray(['asset://localhost/large.png']);
    const fromInline = await resolveImageDataUrlArray([await asDataUrl(png(4, 9))]);
    expect(fromFile[0] === await asDataUrl(png(3, 0))).toBe(true);
    expect(fromInline[0] === await asDataUrl(png(4, 0))).toBe(true);
    localFetch.mockResolvedValueOnce(new Response(new Blob([new Uint8Array(9 * 1024 * 1024)], { type: 'image/jpeg' })));
    await expect(resolveImageDataUrlArray(['asset://localhost/large.jpg'])).rejects.toThrow('8 MiB');
    localFetch.mockResolvedValueOnce(new Response('oversize', { headers: { 'Content-Type': 'image/png', 'Content-Length': String(33 * 1024 * 1024) } }));
    await expect(resolveImageDataUrlArray(['asset://localhost/huge.png'])).rejects.toThrow('32');
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(decode).not.toHaveBeenCalled();
  });

  it('Base64 读取只启动两张，即使完成顺序不同也不交换图片位置', async () => {
    const releases: Array<() => void> = [];
    const started: number[] = [];
    localFetch.mockImplementation(async (url) => {
      const index = Number(String(url).match(/(\d)\.png$/)![1]);
      started.push(index);
      await new Promise<void>((resolve) => { releases[index] = resolve; });
      return new Response(`image-${index}`, { headers: { 'Content-Type': 'image/png' } });
    });
    const pending = resolveImageDataUrlArray([0, 1, 2].map((id) => `asset://localhost/${id}.png`));
    expect(started).toEqual([0, 1]);
    releases[1]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    releases[2](); releases[0]();
    expect((await pending).map((value) => atob(value.split(',')[1]))).toEqual(['image-0', 'image-1', 'image-2']);
  });

  it('压缩阶段取消不会向生成端提交原图或重试', async () => {
    const controller = new AbortController();
    localFetch.mockResolvedValue(new Response(png(1)));
    mocks.invoke.mockImplementationOnce(async (command, payload) => { controller.abort(); return optimizePng(command, payload); });
    await expect(generateImageStandard({ apiKey: 'test-key', baseUrl: 'https://relay.example/v1', modelName: 'gpt-image-2',
      prompt: '合影', dimensions: { width: 1024, height: 1024 }, imageReferenceRequestMode: 'edits-multipart',
      imageUrls: ['asset://localhost/cancel.png'],
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
  });

  it('GRSAI 任一参考图读取失败就中止，不丢图继续生成', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { grsai: { name: 'GRSAI', apiKey: 'test-key', baseUrl: 'https://grsai.example/v1' } },
    } }));
    localFetch.mockImplementation(async (url) => String(url).endsWith('missing.png')
      ? new Response('', { status: 404 }) : new Response(png(1)));
    await expect(generateImagesBatch({ provider: 'grsai', model: 'grsai/nano-banana-2', prompt: '合影',
      image_urls: ['asset://localhost/first.png', 'asset://localhost/missing.png', 'asset://localhost/not-started.png'],
    }, 1)).rejects.toThrow('参考图 2');
    expect(localFetch).toHaveBeenCalledTimes(2);
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it('默认视觉仍限制数量与总字节，同一组 28 MiB 图片可使用生图预算', async () => {
    await expect(resolveImageDataUrlArray(new Array(7).fill('data:image/jpeg;base64,AAAA'))).rejects.toThrow('6 张');
    const dataUrl = await asDataUrl(new Blob([new Uint8Array(7 * 1024 * 1024)], { type: 'image/jpeg' }));
    const references = new Array<string>(4).fill(dataUrl);
    await expect(resolveImageDataUrlArray(references)).rejects.toThrow('24 MiB');
    await expect(resolveImageDataUrlArray(references, undefined, IMAGE_GENERATION_DATA_URL_BUDGET))
      .resolves.toEqual(references);
    expect(decode).not.toHaveBeenCalled();
    expect(localFetch).not.toHaveBeenCalled();
  });

  it('生图预算独立于文本视觉：允许 14 图及超过 8 MiB 的原始图片', async () => {
    expect(IMAGE_GENERATION_DATA_URL_BUDGET).toEqual({
      maxImageBytes: 32 * 1024 * 1024, maxTotalBytes: 48 * 1024 * 1024,
    });
    const references = await Promise.all(Array.from({ length: 14 }, (_, index) =>
      asDataUrl(new Blob([new Uint8Array([index])], { type: 'image/webp' }))));
    await expect(resolveImageDataUrlArray(references, undefined, IMAGE_GENERATION_DATA_URL_BUDGET))
      .resolves.toEqual(references);
    const large = await asDataUrl(new Blob([new Uint8Array(9 * 1024 * 1024)], { type: 'image/webp' }));
    await expect(resolveImageDataUrlArray([large], undefined, IMAGE_GENERATION_DATA_URL_BUDGET))
      .resolves.toEqual([large]);
    // 不把生图的预算传播给默认文本视觉调用。
    await expect(resolveImageDataUrlArray([large])).rejects.toThrow('8 MiB');
    await expect(resolveImageDataUrlArray(references)).rejects.toThrow('6 张');
    expect(localFetch).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it('独立预算包含边界值，逐张累计且超限后不继续领取剩余参考图', async () => {
    // 按字节缩放预算验证边界，避免为上限回归分配多份几十 MiB 的正文。
    const budget = { maxImageBytes: 32, maxTotalBytes: 48 };
    const inline = (bytes: number) => asDataUrl(new Blob([new Uint8Array(bytes)], { type: 'image/webp' }));
    const exact = [await inline(32), await inline(16)];
    await expect(resolveImageDataUrlArray(exact, undefined, budget)).resolves.toEqual(exact);
    await expect(resolveImageDataUrlArray([await inline(33)], undefined, budget)).rejects.toThrow('单图转换上限');
    localFetch.mockImplementation(async (url) => new Response(new Uint8Array(String(url).includes('extra') ? 1 : 24), {
      headers: { 'Content-Type': 'image/webp' },
    }));
    await expect(resolveImageDataUrlArray([
      'asset://localhost/first.webp', 'asset://localhost/second.webp',
      'asset://localhost/extra-1.webp', 'asset://localhost/extra-2.webp', 'asset://localhost/extra-3.webp',
    ], undefined, budget)).rejects.toThrow('合计超过应用转换上限');
    expect(localFetch.mock.calls.length).toBeLessThanOrEqual(4);
    expect(localFetch.mock.calls.map(([url]) => url)).not.toContain('asset://localhost/extra-3.webp');
    expect(mocks.transport).not.toHaveBeenCalled();
  });
});
