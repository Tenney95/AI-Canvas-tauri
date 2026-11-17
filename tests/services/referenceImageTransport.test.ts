/**
 * referenceImageTransport — 回归测试：共享参考图压缩的实际请求边界。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transport: vi.fn(), invoke: vi.fn(), readSecret: vi.fn(), native: false, optimizerNative: true }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.transport, logAiResponse: vi.fn() }));
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
import { generateText } from '../../src/services/ai/generateText';
import { resolveAssistantModel, streamAssistantReply, type AssistantModelMessage } from '../../src/services/ai/assistantStream';
import { IMAGE_GENERATION_DATA_URL_BUDGET, resolveContentImageUrls, resolveImageDataUrlArray, resolveImageUrlArray, resolveNodeImageUrl } from '../../src/services/ai/imageUtils';
import { getMediaReferenceUrl } from '../../src/services/ai/connectedReferenceMedia';
import { resolvePromptWithMediaRefs } from '../../src/services/ai/promptResolver';
import { generateImageStandard } from '../../src/services/ai/providers/standardImage';
import { uploadRunningHubMedia } from '../../src/services/ai/providers/runninghubClient';
import { resolveMediaReferenceUrl, uploadToRemote } from '../../src/services/uploadService';
import { previewModelProtocolRequest } from '../../src/services/ai/modelProtocol';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';
import { registerCharacterImageTaskContext } from '../../src/services/characterImageTaskContext';
import { useAppStore } from '../../src/store/useAppStore';
import type { ImageHostingConfig, PublicImageHostingProvider } from '../../src/types/imageHosting';
import type { VolcengineTosConfig } from '../../src/types/volcengineTos';
import { IMAGE_HOSTING_TEMPLATES, PUBLIC_IMAGE_HOSTING_TEMPLATES } from '../../src/services/imageHostingTemplates';
import { LIBAPI_BASE_URL, TOAPIS_BASE_URL, VOLCENGINE_BASE_URL } from '../../src/constants/api';
import { MINIMAX_BASE_URL } from '../../src/services/ai/providers/minimaxModelManifest';

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
const hostingRef = 'secret:image-host/01234567-0123-4123-8123-0123456789ab';
function publicHostingFixture(provider: PublicImageHostingProvider): ImageHostingConfig {
  const config = structuredClone(PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === provider)!.config);
  if (provider === 'cloudinary') {
    config.uploadUrl = 'https://api.cloudinary.com/v1_1/fixture/auto/upload';
    config.formFields = [{ name: 'upload_preset', value: 'fixture-unsigned' }];
  }
  if (provider === 'bohe') config.uploadUrl = 'https://bohe-upload.example/upload';
  if (provider === 'custom') config.uploadUrl = 'https://own-host.example/media/upload';
  if (config.auth !== 'none') config.credentialRef = hostingRef;
  return config;
}
function publicHostingResponse(provider: PublicImageHostingProvider, url: string): Response {
  return provider === 'catbox' ? new Response(url) : json(provider === 'cloudinary' ? { secure_url: url }
    : provider === 'bohe' ? { status: 'success', url } : provider === 'custom' ? { data: { url } } : { url });
}
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

describe('万象参考图片直接文件提交', () => {
  function configure(route: 'general' | 'direct' = 'general', modelId = 'image-2-01') {
    const selected = structuredClone(getProviderDefinition('relayonapi')!.models!.find((item) => item.id === modelId)!);
    // 旧连接保存过 URL 偏好，不能盖过已核实的内置文件编辑合同。
    selected.imageReferenceRequestMode = 'generation-json-image-urls';
    useAppStore.getState().saveProviderConfig('my-relayon-files', {
      name: '万象文件直传', catalogId: 'relayonapi', relayonGroup: 'image', apiKey: 'relayon-file-fixture',
      baseUrl: 'https://relayonapi.com/v1', selectedModels: [selected],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'my-relayon-files')!;
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: { provider: 'imagekit', configs: {} },
      generalModels: state.config.generalModels!.map((item) => item.id === model.id
        ? { ...item, imageReferenceRequestMode: 'generation-json-image-urls' as const } : item),
    } }));
    return { provider: route === 'general' ? 'general' : 'my-relayon-files',
      model: route === 'general' ? `general/${model.id}` : `my-relayon-files/${modelId}`,
      prompt: '参考图片生成角色', imageSize: '2K', aspectRatio: '16:9' };
  }

  function configureCustom(transport: 'urls' | 'inline' | 'multipart') {
    const protocol = { version: 2 as const, mode: 'sync' as const,
      submit: { method: 'POST' as const, path: '/custom/reference',
        bodyEncoding: transport === 'multipart' ? 'multipart' as const : 'json' as const,
        body: { model: '{{model}}', prompt: '{{prompt}}', images: transport === 'multipart'
          ? { $file: '{{imageUrls}}', filename: 'own-reference.png', contentType: 'image/png' } : '{{imageUrls}}' } },
      response: { type: 'json' as const, result: { urlPath: 'data.output' } },
    };
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: { provider: 'imagekit', configs: {} },
      providers: { 'custom-relayon-image': { name: '万象自定义协议', catalogId: 'relayonapi', apiKey: 'relayon-custom-fixture',
        baseUrl: 'https://api.relayonapi.com/v1' } },
      generalModels: [{ id: 'relayon-custom-image', modelId: 'vendor-image', name: '万象自定义图片', category: 'image',
        providerConfigId: 'custom-relayon-image', executionProfile: { preset: 'custom', protocol },
        ...(transport === 'inline' ? { imageReferenceRequestMode: 'generation-json-image-data-urls' as const } : {}) }],
    } }));
    return { provider: 'general', model: 'general/relayon-custom-image', prompt: '保留用户自己的请求协议' };
  }

  it('URL-only 自定义图片协议绑定真实万象连接，@本地副本在图床或生成提交前明确拒绝', async () => {
    const params = configureCustom('urls');
    const loaded = vi.fn();
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      set src(url: string) { loaded(url); queueMicrotask(() => this.onload?.()); }
    });
    useAppStore.setState({ nodes: [{ id: 'relayon-local-reference', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: '参考图', imageUrl: 'https://old-host.example/preview.png',
        sourceUrl: 'https://old-host.example/original.png', filePath: '/project/data/reference.png' } }] });
    const before = structuredClone(useAppStore.getState().config);
    await expect(generateImagesBatch({ ...params, prompt: '@{relayon-local-reference:参考图} 生成图片' }, 1))
      .rejects.toThrow('万象本地参考素材须随模型请求提交文件');
    expect(loaded).not.toHaveBeenCalled();
    expect(localFetch).not.toHaveBeenCalled();
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.readSecret).not.toHaveBeenCalled();
    expect(useAppStore.getState().config).toEqual(before);
  });

  it('URL-only 自定义图片协议继续使用已有公网地址，保留请求路径和响应映射', async () => {
    const params = configureCustom('urls');
    mocks.transport.mockResolvedValueOnce(json({ data: { output: 'https://output.example/custom-url.png' } }));
    const reference = 'https://media.example/public-reference.png';
    await expect(generateImagesBatch({ ...params, image_urls: [reference] }, 1))
      .resolves.toMatchObject({ results: [{ url: 'https://output.example/custom-url.png' }] });
    expect(mocks.transport).toHaveBeenCalledOnce();
    const [url, init] = mocks.transport.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.relayonapi.com/v1/custom/reference');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'vendor-image', prompt: expect.stringContaining(params.prompt), images: [reference] });
    expect(localFetch).not.toHaveBeenCalled();
    expect(mocks.readSecret).not.toHaveBeenCalled();
  });

  it.each(['inline', 'multipart'] as const)('万象显式自定义 %s 参考协议不调用独立图床，也不改写用户合同', async (transport) => {
    const params = configureCustom(transport);
    const source = png(8, transport === 'multipart' ? 9 : 0);
    // 无损结果没有缩小时仍保留原图；生图 multipart 不误用视觉模型的 8 MiB 预算。
    mocks.invoke.mockImplementation(async (command, input: ArrayBuffer) => {
      if (command !== 'optimize_reference_png') throw new Error('不应调用独立上传');
      return input;
    });
    localFetch.mockResolvedValueOnce(new Response(source));
    mocks.transport.mockResolvedValueOnce(json({ data: { output: 'https://output.example/custom-file.png' } }));
    const before = structuredClone(useAppStore.getState().config);
    await expect(generateImagesBatch({ ...params, image_urls: ['asset://localhost/custom-reference.png'] }, 1))
      .resolves.toMatchObject({ results: [{ url: 'https://output.example/custom-file.png' }] });
    expect(localFetch).toHaveBeenCalledOnce();
    expect(mocks.transport).toHaveBeenCalledOnce();
    const [url, init] = mocks.transport.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.relayonapi.com/v1/custom/reference');
    if (transport === 'multipart') {
      const form = await new Response(init.body, { headers: init.headers }).formData();
      const file = form.get('images') as File;
      expect(file.name).toBe('own-reference.png');
      expect(file.type).toBe('image/png');
      expect(file.size).toBe(source.size);
      expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from(await source.arrayBuffer()));
    } else {
      expect(JSON.parse(init.body as string).images).toEqual([await asDataUrl(source)]);
    }
    expect(mocks.readSecret).not.toHaveBeenCalled();
    expect(useAppStore.getState().config).toEqual(before);
  });

  it.each(['image-2-01', 'image-2.6-01', 'image-2.6-flare-01', 'image-2.6-sunburst-01'].flatMap((modelId) =>
    (['general', 'direct'] as const).map((route) => ({ modelId, route }))))(
    '$modelId 的$route入口将本地及远端参考按序提交真实文件，旧URL偏好不调用图床', async ({ modelId, route }) => {
    const params = configure(route, modelId);
    const before = structuredClone(useAppStore.getState().config);
    const remote = new Blob([Uint8Array.from([82, 73, 70, 70, 5, 0, 0, 0, 87, 69, 66, 80, 9])], { type: 'image/webp' });
    localFetch.mockResolvedValueOnce(new Response(png(1)));
    mocks.transport.mockImplementation(async (url, init) => {
      if (url === 'https://media.example/reference.webp') {
        expect(init?.method).toBeUndefined();
        expect(init?.headers).toBeUndefined();
        return new Response(remote);
      }
      if (url === 'https://api.relayonapi.com/v1/images/edits' && init?.method === 'POST') {
        return json({ data: [{ url: 'https://output.example/file-edited.png' }] });
      }
      throw new Error('不应上传至图床或其他地址');
    });
    await expect(generateImagesBatch({ ...params,
      image_urls: ['asset://localhost/reference.png', 'https://media.example/reference.webp'],
    }, 1)).resolves.toMatchObject({ failedCount: 0, results: [{ url: 'https://output.example/file-edited.png' }] });
    expect(localFetch).toHaveBeenCalledExactlyOnceWith('asset://localhost/reference.png', expect.anything());
    expect(mocks.transport.mock.calls.map(([url]) => url)).toEqual([
      'https://media.example/reference.webp', 'https://api.relayonapi.com/v1/images/edits',
    ]);
    const init = mocks.transport.mock.calls[1][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(headers.get('Authorization')).toBe('Bearer relayon-file-fixture');
    expect(headers.get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/i);
    const form = await new Response(init.body, { headers: init.headers }).formData();
    const files = form.getAll('image[]') as File[];
    expect(form.has('image')).toBe(false);
    expect(files.map((file) => file.type)).toEqual(['image/png', 'image/webp']);
    const indexedFiles = modelId !== 'image-2-01';
    expect(files.map((file) => file.name)).toEqual(indexedFiles ? ['reference-1.png', 'reference-2.webp'] : ['upload.png', 'upload.webp']);
    await assertPreparedPng(files[0], 1);
    expect(Buffer.from(await files[1].arrayBuffer())).toEqual(Buffer.from(await remote.arrayBuffer()));
    expect(form.get('model')).toBe(modelId);
    expect(form.get('n')).toBe('1');
    expect(form.get('size')).toBe(indexedFiles ? '2560x1440' : '2048x1152');
    if (indexedFiles) {
      for (const key of ['resolution', 'aspect_ratio', 'output_format']) expect(form.has(key)).toBe(false);
    } else {
      expect(form.get('resolution')).toBe('2K');
      expect(form.get('aspect_ratio')).toBe('16:9');
    }
    expect(form.has('mask')).toBe(false);
    expect(form.has('quality')).toBe(false);
    expect(mocks.readSecret).not.toHaveBeenCalled();
    expect(useAppStore.getState().config).toEqual(before);
  });

  it('角色工作台沿受信目的地发送文件，不退回标准 JSON 或图床', async () => {
    const params = configure();
    const completed = new Error('角色任务已执行完成');
    const assertCurrent = vi.fn();
    let delivered: unknown;
    const destination = registerCharacterImageTaskContext({ assertCurrent, execute: async (plan) => {
      delivered = await plan.execute(async () => { assertCurrent(); }, async () => {}, 'role-file-fixture');
      throw completed;
    } });
    mocks.transport.mockResolvedValueOnce(json({ data: [{ url: 'https://output.example/role-file.png' }] }));
    try {
      await expect(generateImagesBatch({ ...params, characterWorkbench: 'global', image_urls: [await asDataUrl(png(3, 0))] },
        1, undefined, destination.beforeSubmit)).rejects.toBe(completed);
      expect(delivered).toEqual([{ url: 'https://output.example/role-file.png' }]);
      expect(assertCurrent).toHaveBeenCalled();
      expect(mocks.transport).toHaveBeenCalledOnce();
      const [url, init] = mocks.transport.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.relayonapi.com/v1/images/edits');
      expect(new Headers(init.headers).get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/i);
      const form = await new Response(init.body, { headers: init.headers }).formData();
      expect(form.getAll('image')).toHaveLength(1);
      await assertPreparedPng(form.get('image') as File, 3);
      expect(localFetch).not.toHaveBeenCalled();
      expect(mocks.readSecret).not.toHaveBeenCalled();
    } finally { destination.release(); }
  });

  it.each(['missing', 'cancel'] as const)('参考图 %s 时停止，不上传图床或继续提交生成', async (failure) => {
    const params = configure();
    const controller = new AbortController();
    localFetch.mockImplementationOnce(async () => {
      if (failure === 'cancel') controller.abort(new DOMException('Cancelled', 'AbortError'));
      return failure === 'missing' ? new Response('', { status: 404 }) : new Response(png(1));
    });
    await expect(generateImagesBatch({ ...params, image_urls: ['asset://localhost/unavailable.png'] }, 1, controller.signal))
      .rejects.toThrow(failure === 'missing' ? '参考图 1' : /取消|Cancelled/);
    expect(localFetch).toHaveBeenCalledOnce();
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.readSecret).not.toHaveBeenCalled();
  });

});

describe('方舟全部参考素材的私有 TOS 路由', () => {
  const initialTos: VolcengineTosConfig = { bucket: 'reference-bucket', region: 'cn-beijing',
    credentialRef: 'secret:provider/volcengine/tos/01234567-0123-4123-8123-0123456789ab' };
  const configure = (provider: string, tosUpload: VolcengineTosConfig | undefined = initialTos) => {
    mocks.native = true;
    useAppStore.setState((state) => ({ config: { ...state.config, imageHosting: { provider: 'imgbb', configs: {} }, providers: {
      [provider]: { name: '火山方舟', catalogId: 'volcengine', apiKey: 'ark-model-key', baseUrl: VOLCENGINE_BASE_URL, tosUpload,
        imageHosting: { enabled: true, uploadUrl: 'https://legacy-image-host.example/upload', fileField: 'file', responseUrlPath: 'url', auth: 'none' } },
    } } }));
  };
  const result = (bucket: string, ordinal: number) => ({
    url: `https://${bucket}.tos-cn-beijing.ivolces.com/ai-canvas/ark-reference/upload-${ordinal}.png?X-Tos-Signature=fixture-signature`,
    expiresAt: Date.now() + 6 * 60 * 60 * 1000,
  });

  it('全局和连接图床均不覆盖 TOS，内联模式仍上传，缓存只在内存并按 Bucket/凭据隔离', async () => {
    const provider = 'volcengine-tos-cache-isolation';
    configure(provider);
    const getItem = vi.fn(() => null); const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem, setItem });
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const source = await asDataUrl(png(91, 0));
    let uploads = 0;
    mocks.invoke.mockImplementation(async (command, payload) => {
      if (command !== 'upload_volcengine_tos_reference') throw new Error('不应使用图床、代理或压缩 IPC');
      return result(payload.req.bucket, ++uploads);
    });
    const resolve = () => resolveMediaReferenceUrl(source, { provider, kind: 'image', mode: 'dataUrl' });
    const first = result(initialTos.bucket, 1).url;
    expect(await resolve()).toBe(first);
    expect(await resolve()).toBe(first);
    expect(uploads).toBe(1);
    const firstRequest = mocks.invoke.mock.calls[0][1].req;
    expect(firstRequest).toEqual(expect.objectContaining({ bucket: initialTos.bucket, credentialRef: initialTos.credentialRef,
      kind: 'image', source: { dataUrl: source } }));
    expect(JSON.stringify(firstRequest)).not.toContain('ark-model-key');
    now += 150 * 60_000 - 1;
    expect(await resolve()).toBe(first);
    expect(uploads).toBe(1);
    now += 1;
    expect(await resolve()).toBe(result(initialTos.bucket, 2).url);
    useAppStore.getState().setProviderConfig(provider, { tosUpload: { ...initialTos, bucket: 'changed-bucket' } });
    expect(await resolve()).toBe(result('changed-bucket', 3).url);
    useAppStore.getState().setProviderConfig(provider, { tosUpload: { ...initialTos, bucket: 'changed-bucket',
      credentialRef: 'secret:provider/volcengine/tos/11234567-0123-4123-8123-0123456789ab' } });
    expect(await resolve()).toBe(result('changed-bucket', 4).url);
    expect(uploads).toBe(4);
    expect(getItem).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled();
    expect(mocks.transport).not.toHaveBeenCalled(); expect(localFetch).not.toHaveBeenCalled();
    expect(mocks.readSecret).not.toHaveBeenCalled();
  });

  it('缺少 TOS 或方舟地址变为中转站时拒绝本地与远端素材，不以公网地址绕过配置', async () => {
    const provider = 'volcengine-tos-missing-config';
    configure(provider);
    // 显式去除默认配置，模拟已有的仅 API Key 连接。
    useAppStore.getState().setProviderConfig(provider, { tosUpload: undefined });
    const source = await asDataUrl(png(92, 0));
    await expect(resolveMediaReferenceUrl(source, { provider, kind: 'image', mode: 'dataUrl' })).rejects.toThrow('配置北京私有 TOS');
    const remote = 'https://cdn.example/existing-reference.png';
    await expect(resolveMediaReferenceUrl(remote, { provider, kind: 'image' })).rejects.toThrow('配置北京私有 TOS');
    useAppStore.getState().setProviderConfig(provider, { tosUpload: initialTos, baseUrl: 'https://relay.example/api/v3' });
    await expect(uploadToRemote(source, provider)).rejects.toThrow('北京区域的方舟官方接口');
    await expect(resolveImageUrlArray([remote], provider)).rejects.toThrow('北京区域的方舟官方接口');
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.transport).not.toHaveBeenCalled();
    expect(localFetch).not.toHaveBeenCalled(); expect(mocks.readSecret).not.toHaveBeenCalled();
  });

  it.each(['image', 'video', 'audio'] as const)('已有公网 %s URL 也只走原生 TOS，不读取或持久化公共图床缓存', async (kind) => {
    const provider = `volcengine-remote-${kind}`;
    configure(provider);
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }; vi.stubGlobal('localStorage', storage);
    const remoteUrl = `https://cdn.example/reference-${kind}?download=fixture%2Bsignature`;
    mocks.invoke.mockResolvedValueOnce(result(initialTos.bucket, 20));
    const resolved = kind === 'image' ? (await resolveImageUrlArray([remoteUrl], provider))[0]
      : await resolveMediaReferenceUrl(remoteUrl, { provider, kind, mode: 'dataUrl' });
    expect(resolved).toBe(result(initialTos.bucket, 20).url);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('upload_volcengine_tos_reference', {
      req: expect.objectContaining({ kind, purpose: 'reference', source: { remoteUrl } }),
    });
    expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
    expect(localFetch).not.toHaveBeenCalled(); expect(mocks.transport).not.toHaveBeenCalled();
  });

  it('content 图片同样经过 TOS，已有官方 Asset ID 保留为逻辑引用', async () => {
    const provider = 'volcengine-content-reference'; configure(provider);
    const remoteUrl = 'https://cdn.example/portrait.png';
    mocks.invoke.mockResolvedValueOnce(result(initialTos.bucket, 21));
    expect(await resolveContentImageUrls([{ type: 'text', text: '保持人物外观' }, { type: 'image_url', image_url: { url: remoteUrl } }], provider))
      .toEqual([{ type: 'text', text: '保持人物外观' }, { type: 'image_url', image_url: { url: result(initialTos.bucket, 21).url } }]);
    expect(await resolveMediaReferenceUrl('asset://asset-fixture-123', { provider, kind: 'image' })).toBe('asset://asset-fixture-123');
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(localFetch).not.toHaveBeenCalled(); expect(mocks.transport).not.toHaveBeenCalled();
  });

  it('其他厂商与同名自定义连接的公网 URL 仍直传，不读取不可用全局图床', async () => {
    const remoteUrl = 'https://cdn.example/unchanged.png';
    useAppStore.setState((state) => ({ config: { ...state.config, imageHosting: { provider: 'imgbb', configs: {} },
      providers: { volcengine: { name: '同名自定义连接', catalogId: 'custom-openai', apiKey: 'custom-key' } },
    } }));
    expect(await resolveImageUrlArray([remoteUrl], 'volcengine')).toEqual([remoteUrl]);
    expect(await resolveMediaReferenceUrl(remoteUrl, { provider: 'ordinary-relay', kind: 'video' })).toBe(remoteUrl);
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(localFetch).not.toHaveBeenCalled(); expect(mocks.transport).not.toHaveBeenCalled();
  });

  it('火山图片连接保留历史 data-url 标志时仍上传 TOS 并只向模型发送签名 URL', async () => {
    configure('volcengine');
    const model = 'doubao-seedream-5-0-pro-260628';
    useAppStore.getState().setProviderConfig('volcengine', { selectedModels: [{ id: model, name: model, category: 'image',
      provider: 'volcengine', imageReferenceRequestMode: 'generation-json-image-data-urls' }] });
    const signed = result(initialTos.bucket, 9).url;
    mocks.invoke.mockImplementation(async (command) => command === 'upload_volcengine_tos_reference'
      ? result(initialTos.bucket, 9) : null);
    mocks.transport.mockResolvedValueOnce(json({ data: [{ url: 'https://cdn.example/seedream-result.png' }] }));
    await generateImagesBatch({ provider: 'volcengine', model: `volcengine/${model}`, prompt: '保持人物外观',
      image_urls: [await asDataUrl(png(94, 0))] }, 1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'upload_volcengine_tos_reference')).toHaveLength(1);
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(JSON.parse(mocks.transport.mock.calls[0][1].body as string).image).toEqual([signed]);
    expect(localFetch).not.toHaveBeenCalled();
  });

  it('通用火山图片模型以实际连接上传远端素材，历史 data-url 标志不能绕过 TOS', async () => {
    const provider = 'ark-general-image'; configure(provider);
    useAppStore.setState((state) => ({ config: { ...state.config, generalModels: [{
      id: 'ark-image', modelId: 'fixture-image', name: '火山通用图片', category: 'image', providerConfigId: provider,
      imageReferenceRequestMode: 'generation-json-image-data-urls', executionProfile: { preset: 'custom', protocol: {
        version: 2, mode: 'sync', submit: { method: 'POST', path: '/images/generations', bodyEncoding: 'json',
          body: { image: '{{imageUrls}}' } }, response: { type: 'json', result: { urlPath: 'url' } },
      } },
    }] } }));
    const remoteUrl = 'https://outside.example/general-reference.png';
    const signed = result(initialTos.bucket, 30).url;
    mocks.invoke.mockResolvedValueOnce(result(initialTos.bucket, 30));
    mocks.transport.mockResolvedValueOnce(json({ url: 'https://cdn.example/general-result.png' }));
    await generateImagesBatch({ provider: 'general', model: 'general/ark-image', prompt: '保持人物外观', image_urls: [remoteUrl] }, 1);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('upload_volcengine_tos_reference', {
      req: expect.objectContaining({ source: { remoteUrl }, bucket: initialTos.bucket, purpose: 'reference' }),
    });
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(JSON.parse(mocks.transport.mock.calls[0][1].body as string).image).toEqual([signed]);
    expect(localFetch).not.toHaveBeenCalled();
  });

  const configureVision = (general: boolean) => {
    const provider = general ? 'ark-general-vision' : 'volcengine'; configure(provider);
    const modelId = 'fixture-ark-vision';
    useAppStore.setState((state) => ({ currentProjectId: 'tos-vision-project', nodes: [
      { id: 'tos-visual-node', type: 'ai-image', position: { x: 0, y: 0 },
        data: { type: 'ai-image', label: '参考图', imageUrl: 'https://outside.example/visual-reference.png' } },
    ], config: { ...state.config, providers: { ...state.config.providers, [provider]: {
      ...state.config.providers[provider], selectedModels: [{ id: modelId, name: '火山视觉', category: 'text', provider,
        inputModalities: ['text', 'image'] }],
    } }, generalModels: general ? [{ id: 'ark-vision', name: '火山视觉', modelId, category: 'text', providerConfigId: provider,
      inputModalities: ['text', 'image'] }] : [] } }));
    return { provider, selectionId: general ? 'general/ark-vision' : `${provider}/${modelId}` };
  };

  it.each([false, true])('火山节点视觉请求（general=%s）直接将远端引用送 TOS，且模型请求禁用日志', async (general) => {
    const { selectionId } = configureVision(general);
    const signed = result(initialTos.bucket, 31).url;
    mocks.invoke.mockResolvedValueOnce(result(initialTos.bucket, 31));
    mocks.transport.mockResolvedValueOnce(json({ choices: [{ message: { content: '看到了人物' } }] }));
    await expect(generateText({ provider: general ? 'general' : 'volcengine', model: selectionId,
      prompt: '分析 @{tos-visual-node:参考图}' })).resolves.toBe('看到了人物');
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('upload_volcengine_tos_reference', {
      req: expect.objectContaining({ source: { remoteUrl: 'https://outside.example/visual-reference.png' } }),
    });
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(mocks.transport.mock.calls[0][2]).toEqual({ sensitive: true });
    expect(JSON.parse(mocks.transport.mock.calls[0][1].body as string).messages[0].content).toContainEqual({
      type: 'image_url', image_url: { url: signed },
    });
    expect(localFetch).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes[0].data.imageUrl).toBe('https://outside.example/visual-reference.png');
  });

  it.each([false, true].flatMap((general) => ['mention', 'array', 'frozen'].map((input) => ({ general, input }))))(
    '火山助手 general=$general、输入=$input 的视觉素材只生成本轮 TOS 发送副本', async ({ general, input }) => {
      const { provider, selectionId } = configureVision(general);
      const remoteUrl = 'https://outside.example/visual-reference.png';
      const messages: AssistantModelMessage[] = [{ role: 'user', content: [
        { type: 'text', text: '分析人物' }, { type: 'image_url', image_url: { url: remoteUrl } },
      ] }];
      const originalMessages = JSON.stringify(messages);
      const signed = result(initialTos.bucket, 32).url;
      mocks.invoke.mockResolvedValueOnce(result(initialTos.bucket, 32));
      mocks.transport.mockResolvedValueOnce(json({ choices: [{ message: { content: '看到了人物' }, finish_reason: 'stop' }] }));
      expect(resolveAssistantModel(undefined, selectionId)?.providerConfigId).toBe(provider);
      await expect(streamAssistantReply({ modelId: selectionId, systemPrompt: '',
        userMessage: '分析 @{tos-visual-node:参考图}', ...(input === 'mention' ? {} : { messages }),
        ...(input === 'frozen' ? { resolveVisualReferences: false } : {}),
        nonStream: true, tools: [], onEvent: vi.fn(),
      })).resolves.toBe('看到了人物');
      expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('upload_volcengine_tos_reference', {
        req: expect.objectContaining({ source: { remoteUrl } }),
      });
      expect(mocks.transport).toHaveBeenCalledOnce();
      expect(mocks.transport.mock.calls[0][2]).toEqual({ sensitive: true });
      expect(JSON.parse(mocks.transport.mock.calls[0][1].body as string).messages[0].content).toContainEqual({
        type: 'image_url', image_url: { url: signed },
      });
      expect(localFetch).not.toHaveBeenCalled();
      expect(JSON.stringify(messages)).toBe(originalMessages);
      expect(useAppStore.getState().messages).toEqual([]);
      expect(JSON.stringify(useAppStore.getState().nodes)).not.toContain('X-Tos-');
    });

  it.each(['node', 'assistant'] as const)('火山 %s 视觉请求的上游错误不回显 TOS 签名', async (route) => {
    const { selectionId } = configureVision(true);
    const signed = result(initialTos.bucket, 33).url;
    mocks.invoke.mockResolvedValueOnce(result(initialTos.bucket, 33));
    mocks.transport.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: `下载失败 ${signed}` } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    }));
    const onEvent = vi.fn();
    const error = await (route === 'node'
      ? generateText({ provider: 'general', model: selectionId, prompt: '分析 @{tos-visual-node:参考图}' })
      : streamAssistantReply({ modelId: selectionId, systemPrompt: '', userMessage: '分析 @{tos-visual-node:参考图}',
        nonStream: true, tools: [], onEvent })).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[REDACTED]');
    expect((error as Error).stack).not.toContain('X-Tos-');
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain('X-Tos-');
    expect(localFetch).not.toHaveBeenCalled();
  });

  it('通用火山文本自定义协议也只发送 TOS 副本并禁用日志', async () => {
    const { selectionId } = configureVision(true);
    useAppStore.setState((state) => ({ config: { ...state.config, generalModels: state.config.generalModels?.map((model) => ({
      ...model, executionProfile: { preset: 'custom' as const, protocol: { version: 2 as const, mode: 'sync' as const,
        submit: { method: 'POST' as const, path: '/custom/text', bodyEncoding: 'json' as const, body: { messages: '{{messages}}' } },
        response: { type: 'json' as const, result: { textPath: 'answer' } },
      } },
    })) } }));
    mocks.invoke.mockResolvedValueOnce(result(initialTos.bucket, 34));
    mocks.transport.mockResolvedValueOnce(json({ answer: '理解了参考图' }));
    await expect(generateText({ provider: 'general', model: selectionId, prompt: '分析 @{tos-visual-node:参考图}' }))
      .resolves.toBe('理解了参考图');
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(mocks.transport.mock.calls[0][0]).toBe(`${VOLCENGINE_BASE_URL}/custom/text`);
    expect(mocks.transport.mock.calls[0][2]).toEqual({ sensitive: true });
    expect(JSON.parse(mocks.transport.mock.calls[0][1].body as string).messages[0].content).toContainEqual({
      type: 'image_url', image_url: { url: result(initialTos.bucket, 34).url },
    });
    expect(localFetch).not.toHaveBeenCalled();
  });

  it.each(['node', 'assistant'] as const)('火山 %s 视觉素材上传失败后停止发送，不降级公共图床或 Base64', async (route) => {
    const { selectionId } = configureVision(true);
    mocks.invoke.mockRejectedValueOnce(new Error('远端源文件获取失败'));
    await expect(route === 'node'
      ? generateText({ provider: 'general', model: selectionId, prompt: '分析 @{tos-visual-node:参考图}' })
      : streamAssistantReply({ modelId: selectionId, systemPrompt: '', userMessage: '分析 @{tos-visual-node:参考图}',
        nonStream: true, tools: [], onEvent: vi.fn() })).rejects.toThrow('上传');
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.transport).not.toHaveBeenCalled(); expect(localFetch).not.toHaveBeenCalled();
    expect(useAppStore.getState().messages).toEqual([]);
  });

  it('名称恰好为 volcengine 的自定义文本连接沿用 Base64，助手数组保持其原有行为', async () => {
    configureVision(false);
    useAppStore.getState().setProviderConfig('volcengine', { catalogId: 'custom-openai', baseUrl: 'https://custom.example/v1' });
    const dataUrl = await asDataUrl(png(95, 0));
    mocks.transport.mockImplementation(async () => json({ choices: [{ message: { content: '自定义回复' }, finish_reason: 'stop' }] }));
    await generateText({ provider: 'volcengine', model: 'volcengine/fixture-ark-vision', prompt: '描述图片', imageUrls: [dataUrl] });
    await streamAssistantReply({ modelId: 'volcengine/fixture-ark-vision', systemPrompt: '', userMessage: '',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://outside.example/custom.png' } }] }],
      nonStream: true, tools: [], onEvent: vi.fn() });
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'upload_volcengine_tos_reference')).toBe(false);
    expect(JSON.parse(mocks.transport.mock.calls[0][1].body as string).messages[0].content).toContainEqual({
      type: 'image_url', image_url: { url: dataUrl },
    });
    expect(JSON.parse(mocks.transport.mock.calls[1][1].body as string).messages[0].content[0].image_url.url)
      .toBe('https://outside.example/custom.png');
    expect(mocks.transport.mock.calls.every((call) => call[2] === undefined)).toBe(true);
  });

  it('原生上传期间换 Bucket 拒绝旧结果，下一次显式调用使用新配置', async () => {
    const provider = 'volcengine-tos-stale-result';
    configure(provider);
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value) });
    const source = await asDataUrl(png(93, 0));
    let uploads = 0;
    mocks.invoke.mockImplementation(async (command, payload) => {
      if (command !== 'upload_volcengine_tos_reference') throw new Error('不应使用公共图床');
      if (++uploads === 1) useAppStore.getState().setProviderConfig(provider, { tosUpload: { ...initialTos, bucket: 'new-reference-bucket' } });
      return result(payload.req.bucket, uploads);
    });
    await expect(uploadToRemote(source, provider)).rejects.toThrow('连接配置已变化');
    expect(uploads).toBe(1);
    expect(await uploadToRemote(source, provider)).toBe(result('new-reference-bucket', 2).url);
    expect(mocks.invoke.mock.calls.map(([, payload]) => payload.req.bucket)).toEqual([initialTos.bucket, 'new-reference-bucket']);
    expect(storage.size).toBe(0);
    expect(mocks.transport).not.toHaveBeenCalled(); expect(localFetch).not.toHaveBeenCalled();
  });
});

describe('全局托管覆盖图片、视频和音频', () => {
  it.each((['catbox', 'imagekit', 'cloudinary', 'bohe', 'custom'] as const).flatMap((hostingProvider) =>
    (['video', 'audio'] as const).map((kind) => ({ hostingProvider, kind }))))('$hostingProvider 接收 $kind 原字节，连接图片上传不覆盖音视频', async ({ hostingProvider, kind }) => {
    const config = publicHostingFixture(hostingProvider);
    const provider = `global-media-${hostingProvider}-${kind}`;
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: { provider: hostingProvider, configs: { [hostingProvider]: config } },
      providers: { [provider]: { name: '图片专属上传连接', catalogId: 'custom-openai', apiKey: 'model-key-not-for-hosting',
        imageHosting: { enabled: true, uploadUrl: 'https://images-only.example/upload', fileField: 'image', responseUrlPath: 'url', auth: 'none' } } },
    } }));
    mocks.readSecret.mockResolvedValue('hosting-fixture-key');
    const mime = kind === 'video' ? 'video/quicktime' : 'audio/mpeg';
    const extension = kind === 'video' ? 'mov' : 'mp3';
    const bytes = new Uint8Array([41, kind === 'video' ? 42 : 43, 44]);
    const remote = `https://cdn.example/${hostingProvider}-${kind}.${extension}`;
    mocks.transport.mockImplementation(async () => publicHostingResponse(hostingProvider, remote));
    expect(await resolveMediaReferenceUrl(await asDataUrl(new Blob([bytes], { type: mime })), { provider, kind })).toBe(remote);
    expect(mocks.transport).toHaveBeenCalledOnce();
    const [endpoint, init] = mocks.transport.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe(config.uploadUrl);
    const form = init.body as FormData;
    const file = form.get(config.fileField) as File;
    expect(file.name).toBe(`reference.${extension}`);
    expect(file.type).toBe(mime);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(new Headers(init.headers).get('Authorization') ?? '').not.toContain('model-key-not-for-hosting');
    if (hostingProvider === 'imagekit') expect(form.get('fileName')).toBe(`reference.${extension}`);
    if (hostingProvider === 'bohe') expect(form.get('api_token')).toBe('hosting-fixture-key');
    expect(localFetch).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled(); expect(encode).not.toHaveBeenCalled();
  });

  it.each(['image', 'video', 'audio'] as const)('自定义全局纯文本接口接收 %s，已有公网链接直接使用', async (kind) => {
    const config: ImageHostingConfig = { ...publicHostingFixture('custom'), responseFormat: 'text', responseUrlPath: '',
      auth: 'header', authField: 'X-Upload-Token', credentialRef: hostingRef };
    const provider = `global-custom-text-${kind}`;
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: { provider: 'custom', configs: { custom: config } },
      providers: { [provider]: { name: '自定义全局托管', catalogId: 'custom-openai', apiKey: 'model-key-not-for-hosting' } },
    } }));
    mocks.readSecret.mockResolvedValue('custom-hosting-key');
    const mime = kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg';
    const extension = kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3';
    const source = kind === 'image' ? png(36, 0) : new Blob([kind], { type: mime });
    const remote = `https://cdn.example/custom-text.${extension}`;
    mocks.transport.mockResolvedValueOnce(new Response(`${remote}\n`));
    expect(await resolveMediaReferenceUrl(await asDataUrl(source), { provider, kind })).toBe(remote);
    expect(mocks.transport).toHaveBeenCalledOnce();
    const [endpoint, init] = mocks.transport.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe(config.uploadUrl);
    const file = (init.body as FormData).get(config.fileField) as File;
    expect(file.name).toBe(`reference.${extension}`);
    expect(file.type).toBe(mime);
    if (kind === 'image') await assertPreparedPng(file, 36);
    else expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(await source.arrayBuffer()));
    expect(new Headers(init.headers).get('X-Upload-Token')).toBe('custom-hosting-key');
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
    expect(mocks.readSecret).toHaveBeenCalledExactlyOnceWith(hostingRef.slice('secret:'.length));
    expect(await uploadToRemote(remote, provider, kind)).toBe(remote);
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(localFetch).not.toHaveBeenCalled();
  });

  it.each(['video', 'audio'] as const)('APIMart 的 %s 缺少本地直传合同，不回退全局托管，公网 URL 保留', async (kind) => {
    useAppStore.setState((state) => ({ config: { ...state.config, imageHosting: { provider: 'catbox', configs: {} },
      providers: { apimart: { name: 'APIMart', apiKey: 'apimart-model-key', baseUrl: 'https://apimart.example/v1' } },
    } }));
    const mime = kind === 'video' ? 'video/mp4' : 'audio/mpeg';
    const remote = `https://cdn.example/apimart-global-${kind}`;
    mocks.transport.mockResolvedValueOnce(new Response(remote));
    await expect(uploadToRemote(await asDataUrl(new Blob([new Uint8Array([45, 46])], { type: mime })), 'apimart', kind)).rejects.toThrow('不会改传图床');
    expect(await uploadToRemote(remote, 'apimart', kind)).toBe(remote);
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(localFetch).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'audio', mime: 'audio/mpeg; charset=binary', path: 'clip.mp3', extension: 'mp3' },
    { kind: 'audio', mime: 'audio/x-wav', path: 'clip.wav', extension: 'wav' },
    { kind: 'audio', mime: 'audio/mp4', path: 'clip.m4a', extension: 'm4a' },
    { kind: 'video', mime: 'video/quicktime', path: 'clip.mov', extension: 'mov' },
    { kind: 'video', mime: 'application/octet-stream', path: 'clip.MOV', extension: 'mov' },
  ] as const)('本地 $mime 使用 .$extension 文件名且不转码', async ({ kind, mime, path, extension }) => {
    useAppStore.setState((state) => ({ config: { ...state.config, imageHosting: { provider: 'catbox', configs: {} } } }));
    const bytes = new Uint8Array([47, 48, 49]);
    const response = new Response(new Blob([bytes], { type: mime }), { headers: { 'Content-Type': mime } });
    // Fetch 会规范化 MIME 参数空格；上传应保留读取后 Blob 的类型和原字节。
    const originalBlob = await response.clone().blob();
    localFetch.mockResolvedValueOnce(response);
    mocks.transport.mockResolvedValueOnce(new Response('https://cdn.example/local-media'));
    await uploadToRemote(`file:///C:/fixture/${path}`, `global-mime-${mime}-${extension}`, kind);
    const file = (mocks.transport.mock.calls[0][1].body as FormData).get('fileToUpload') as File;
    expect(file.name).toBe(`reference.${extension}`);
    expect(file.type).toBe(originalBlob.type);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(localFetch).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each(['scdn', 'picui', 'helloimg', 'imgurl', 'imgbb', 'freeimage'] as const)('旧图片专用候选 %s 要求重新选择，不静默换服务', async (provider) => {
    useAppStore.setState((state) => ({ config: { ...state.config, imageHosting: { provider, configs: {} } } }));
    await expect(uploadToRemote('data:audio/mpeg;base64,MDEy', 'legacy-image-only-global', 'audio')).rejects.toThrow('重新选择');
    expect(mocks.transport).not.toHaveBeenCalled(); expect(localFetch).not.toHaveBeenCalled();
  });

  it.each((['catbox', 'custom'] as const).flatMap((hostingProvider) =>
    (['video', 'audio'] as const).map((kind) => ({ hostingProvider, kind }))))('$hostingProvider 的 $kind 公共上传失败停止，不改用默认 Uguu', async ({ hostingProvider, kind }) => {
    const config = publicHostingFixture(hostingProvider);
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: { provider: hostingProvider, configs: { [hostingProvider]: config } },
    } }));
    mocks.transport.mockResolvedValueOnce(new Response('denied', { status: 403 }));
    const source = kind === 'video' ? 'data:video/mp4;base64,MzQ1' : 'data:audio/mpeg;base64,NTY3';
    await expect(uploadToRemote(source, `global-media-failure-${hostingProvider}-${kind}`, kind)).rejects.toThrow('HTTP 403');
    expect(mocks.transport).toHaveBeenCalledOnce(); expect(localFetch).not.toHaveBeenCalled();
    expect(mocks.transport.mock.calls[0][0]).toBe(config.uploadUrl);
  });

  it.each(['json', 'text'] as const)('自定义全局 %s 错误响应停止，不重试或转传', async (responseFormat) => {
    const config: ImageHostingConfig = { ...publicHostingFixture('custom'), responseFormat,
      responseUrlPath: responseFormat === 'json' ? 'data.url' : '' };
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: { provider: 'custom', configs: { custom: config } },
    } }));
    mocks.transport.mockResolvedValueOnce(responseFormat === 'json'
      ? json({ data: { url: 'javascript:invalid' } }) : new Response('Upload rejected'));
    await expect(uploadToRemote('data:audio/mpeg;base64,OTg3', `global-custom-invalid-${responseFormat}`, 'audio'))
      .rejects.toThrow('未返回有效的 HTTP(S) 素材链接');
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(mocks.transport.mock.calls[0][0]).toBe(config.uploadUrl);
    expect(localFetch).not.toHaveBeenCalled();
  });
});

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

  it.each(['cloudinary', 'catbox', 'custom'] as const)('普通中转图片使用所选全局 %s，停用的连接图床不覆盖全局设置', async (hostingProvider) => {
    const template = publicHostingFixture(hostingProvider);
    const provider = `global-reference-${hostingProvider}`;
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: { provider: hostingProvider, configs: { [hostingProvider]: template } },
      providers: { [provider]: { name: '普通中转', catalogId: 'custom-openai', apiKey: 'relay-model-key',
        imageHosting: { ...template, enabled: false } } },
    } }));
    const remote = `https://cdn.example/global-${hostingProvider}.png`;
    mocks.transport.mockImplementation(async () => publicHostingResponse(hostingProvider, remote));
    expect(await uploadToRemote(await asDataUrl(png(31, 0)), provider)).toBe(remote);
    expect(mocks.transport).toHaveBeenCalledOnce();
    const [endpoint, init] = mocks.transport.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe(template.uploadUrl);
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
    await assertPreparedPng((init.body as FormData).get(template.fileField) as File, 31);
    expect(localFetch).not.toHaveBeenCalled();
    expect(mocks.readSecret).not.toHaveBeenCalled();
  });

  it.each((['toapis', 'libapi'] as const).flatMap((catalogId) => (['image', 'video', 'audio'] as const)
    .map((kind) => ({ catalogId, kind }))))('$catalogId 的 $kind 专用上传优先，不读取不可用的全局候选', async ({ catalogId, kind }) => {
    const provider = `${catalogId}-${kind}-global-priority`;
    const baseUrl = catalogId === 'toapis' ? TOAPIS_BASE_URL : LIBAPI_BASE_URL;
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: { provider: 'imgbb', configs: {} },
      providers: { [provider]: { name: catalogId, catalogId, apiKey: 'connection-only-key', baseUrl,
        imageHosting: { enabled: true, uploadUrl: 'https://unused.example/upload', fileField: 'file', responseUrlPath: 'url', auth: 'none' } } },
    } }));
    const remote = `https://cdn.example/${catalogId}-${kind}-dedicated`;
    mocks.transport.mockImplementation(async () => {
      useAppStore.getState().setProviderConfig(provider, { imageHosting: { enabled: true,
        uploadUrl: 'https://changed-unused.example/upload', fileField: 'file', responseUrlPath: 'url', auth: 'none' } });
      return json(catalogId === 'toapis' ? { success: true, data: { url: remote } } : { url: remote });
    });
    const source = kind === 'image' ? await asDataUrl(png(32, 0)) : kind === 'video'
      ? 'data:video/mp4;base64,ODk6' : 'data:audio/mpeg;base64,OTo7';
    expect(await uploadToRemote(source, provider, kind)).toBe(remote);
    expect(mocks.transport).toHaveBeenCalledOnce();
    const [endpoint, init] = mocks.transport.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe(`${baseUrl}/${catalogId === 'toapis' ? `uploads/${kind === 'image' ? 'images' : kind === 'video' ? 'videos' : 'audios'}` : 'files'}`);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer connection-only-key');
    expect((init.body as FormData).get('purpose')).toBe(catalogId === 'toapis' ? 'generation' : null);
    expect(localFetch).not.toHaveBeenCalled();
    expect(mocks.readSecret).not.toHaveBeenCalled();
  });

  it.each(['apimart', 'minimax'] as const)('%s 别名使用已登记专用上传，忽略连接图床及其无效配置变化', async (catalogId) => {
    const provider = `own-${catalogId}-dedicated`;
    const baseUrl = catalogId === 'minimax' ? MINIMAX_BASE_URL : 'https://official-apimart.example/v1';
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: { provider: 'imagekit', configs: {} },
      providers: { [provider]: { name: '官方上传别名', catalogId, apiKey: 'dedicated-fixture', baseUrl,
        imageHosting: { enabled: true, uploadUrl: 'https://unused.example/upload', fileField: 'file', responseUrlPath: 'url', auth: 'none' } } },
    } }));
    mocks.transport.mockImplementation(async () => {
      useAppStore.getState().setProviderConfig(provider, { imageHosting: { enabled: true,
        uploadUrl: 'https://changed-unused.example/upload', fileField: 'file', responseUrlPath: 'url', auth: 'none' } });
      return json(catalogId === 'apimart' ? { url: 'https://cdn.example/apimart-alias.png' }
        : { base_resp: { status_code: 0 }, file: { file_id: '123456789' } });
    });
    const expected = catalogId === 'apimart' ? 'https://cdn.example/apimart-alias.png' : 'mm_file://123456789';
    await expect(uploadToRemote(await asDataUrl(png(34, 0)), provider)).resolves.toBe(expected);
    expect(mocks.transport).toHaveBeenCalledOnce();
    const [url, init] = mocks.transport.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/${catalogId === 'apimart' ? 'uploads/images' : 'v1/files/upload'}`);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer dedicated-fixture');
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(localFetch).not.toHaveBeenCalled();
    expect(mocks.readSecret).not.toHaveBeenCalled();
  });

  it.each(['catbox', 'custom'] as const)('全局 %s 图片上传失败时直接报错，不重试或切换到 Uguu', async (hostingProvider) => {
    const config = publicHostingFixture(hostingProvider);
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: { provider: hostingProvider, configs: { [hostingProvider]: config } },
    } }));
    mocks.transport.mockResolvedValueOnce(new Response('denied', { status: 403 }));
    await expect(uploadToRemote(await asDataUrl(png(33, 0)), `global-failure-relay-${hostingProvider}`)).rejects.toThrow('HTTP 403');
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(mocks.transport.mock.calls[0][0]).toBe(config.uploadUrl);
    expect(localFetch).not.toHaveBeenCalled();
  });

  it('全局音频按服务、密钥引用及表单参数隔离缓存，未选服务的配置不影响缓存', async () => {
    const provider = 'global-cache-isolation-relay';
    const source = 'data:audio/mpeg;base64,IiNE';
    const upload = () => uploadToRemote(source, provider, 'audio');
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const select = (hostingProvider: PublicImageHostingProvider, config?: ImageHostingConfig) => {
      useAppStore.setState((state) => ({ config: { ...state.config,
        imageHosting: { provider: hostingProvider, configs: config ? { [hostingProvider]: config } : {} },
      } }));
    };
    let uploads = 0;
    mocks.transport.mockImplementation(async (endpoint) => {
      const remote = `https://cdn.example/global-cache-${++uploads}.mp3`;
      return endpoint === 'https://catbox.moe/user/api.php' ? new Response(remote)
        : json({ secure_url: remote, url: remote });
    });
    select('catbox');
    expect(await upload()).toBe('https://cdn.example/global-cache-1.mp3');
    expect(await upload()).toBe('https://cdn.example/global-cache-1.mp3');
    useAppStore.setState((state) => ({ config: { ...state.config, imageHosting: { provider: 'catbox', configs: {
      cloudinary: publicHostingFixture('cloudinary'),
    } } } }));
    expect(await upload()).toBe('https://cdn.example/global-cache-1.mp3');
    expect(mocks.transport).toHaveBeenCalledOnce();
    select('cloudinary', publicHostingFixture('cloudinary'));
    expect(await upload()).toBe('https://cdn.example/global-cache-2.mp3');
    const refOne = 'secret:image-host/01234567-0123-4123-8123-0123456789ab';
    const refTwo = 'secret:image-host/11234567-0123-4123-8123-0123456789ab';
    mocks.readSecret.mockImplementation(async (key) => key === refOne.slice('secret:'.length) ? 'hosting-key-one' : 'hosting-key-two');
    const imagekit = { ...publicHostingFixture('imagekit'), credentialRef: refOne };
    select('imagekit', imagekit);
    expect(await upload()).toBe('https://cdn.example/global-cache-3.mp3');
    select('imagekit', { ...imagekit, credentialRef: refTwo });
    expect(await upload()).toBe('https://cdn.example/global-cache-4.mp3');
    select('imagekit', { ...imagekit, credentialRef: refTwo, formFields: [{ name: 'name', value: 'changed-name' }] });
    expect(await upload()).toBe('https://cdn.example/global-cache-5.mp3');
    expect(await upload()).toBe('https://cdn.example/global-cache-5.mp3');
    expect(mocks.transport).toHaveBeenCalledTimes(5);
    expect(new Headers(mocks.transport.mock.calls[2][1].headers).get('Authorization')).toBe(`Basic ${btoa('hosting-key-one:')}`);
    expect(new Headers(mocks.transport.mock.calls[3][1].headers).get('Authorization')).toBe(`Basic ${btoa('hosting-key-two:')}`);
    expect((mocks.transport.mock.calls[4][1].body as FormData).get('name')).toBe('changed-name');
    expect(JSON.stringify([...storage.values()])).not.toContain('hosting-key-');
    expect(JSON.stringify([...storage.values()])).not.toContain('secret:image-host/');
    expect(localFetch).not.toHaveBeenCalled();
  });

  it('视频上传期间切换全局图床时拒绝迟到结果，不缓存或自动重传到新服务', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    useAppStore.setState((state) => ({ config: { ...state.config,
      imageHosting: { provider: 'cloudinary', configs: { cloudinary: publicHostingFixture('cloudinary') } },
    } }));
    const source = 'data:video/mp4;base64,IyNF';
    mocks.transport.mockImplementationOnce(async () => {
      useAppStore.setState((state) => ({ config: { ...state.config, imageHosting: { provider: 'catbox', configs: {} } } }));
      return json({ secure_url: 'https://cdn.example/global-stale.mp4' });
    });
    await expect(uploadToRemote(source, 'global-stale-relay', 'video')).rejects.toThrow('连接配置已变化');
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(JSON.stringify([...storage.values()])).not.toContain('global-stale.mp4');
    mocks.transport.mockImplementationOnce(async () => new Response('https://cdn.example/global-fresh.mp4'));
    expect(await uploadToRemote(source, 'global-stale-relay', 'video')).toBe('https://cdn.example/global-fresh.mp4');
    expect(mocks.transport.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      'https://api.cloudinary.com/v1_1/fixture/auto/upload', 'https://catbox.moe/user/api.php',
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
    if (provider === 'cccapi') {
      await expect(uploadToRemote(source, provider)).rejects.toThrow('不会改传图床');
      expect(localFetch).not.toHaveBeenCalled();
      expect(mocks.transport).not.toHaveBeenCalled();
      expect(mocks.invoke).not.toHaveBeenCalled();
      return;
    }
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

  it('桌面 Uguu 502 诊断保留超过 200 字符的网关尾部，原上传错误和单次提交语义保持', async () => {
    vi.stubEnv('DEV', true);
    try {
      mocks.native = true;
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const tail = 'diagnostic-upstream-failure-tail';
      const errorBody = `<html><title>502 Bad Gateway</title><body>${'!'.repeat(300)} ${tail}</body></html>`;
      localFetch.mockResolvedValue(new Response(png(81)));
      mocks.invoke.mockImplementation(async (command, payload) => command === 'proxy_fetch'
        ? { status: 502, body: Buffer.from(errorBody).toString('base64'), headers: [['content-type', 'text/html'], ['server', 'nginx']] }
        : optimizePng(command, payload));
      await expect(uploadToRemote('asset://localhost/uguu-diagnostic-502.png', 'uguu-diagnostic-502-relay'))
        .rejects.toThrow('Uguu 上传失败 (502)');
      const uploadCalls = mocks.invoke.mock.calls.filter(([command]) => command === 'proxy_fetch');
      expect(uploadCalls).toHaveLength(1);
      expect(uploadCalls[0][1].req.url).toBe('https://uguu.se/upload');
      expect(uploadCalls[0][1].req.uploadDiagnosticId).toMatch(/^upload-/);
      const event = info.mock.calls.filter(([label]) => label === '[Upload Diagnostics]')
        .map(([, value]) => JSON.parse(String(value)) as Record<string, unknown>)
        .find((value) => value.stage === 'http-error');
      expect(event).toMatchObject({ id: uploadCalls[0][1].req.uploadDiagnosticId, source: 'uguu', status: 502, truncated: false,
        body: expect.stringContaining(tail), headers: expect.arrayContaining([['server', 'nginx']]) });
      expect(mocks.transport).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it('桌面 Uguu 502 的诊断正文不是合法 Base64 时仍抛原 HTTP 错误，不重试或泄出解码异常', async () => {
    vi.stubEnv('DEV', true);
    try {
      mocks.native = true;
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      localFetch.mockResolvedValue(new Response(png(82)));
      mocks.invoke.mockImplementation(async (command, payload) => command === 'proxy_fetch'
        ? { status: 502, body: 'not base64!', headers: [['content-type', 'text/html']] }
        : optimizePng(command, payload));
      await expect(uploadToRemote('asset://localhost/uguu-diagnostic-invalid.png', 'uguu-diagnostic-invalid-relay'))
        .rejects.toThrow('Uguu 上传失败 (502): not base64!');
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'proxy_fetch')).toHaveLength(1);
      expect(mocks.transport).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([
    ['apimart', 'image', 'png'],
    ['expiry-relay', 'image', 'png'],
    ['apimart', 'video', 'mp4'],
    ['apimart', 'audio', 'mp3'],
  ] as const)('%s 的 %s 只复用允许的上传通道，2.5 小时后仍不改传其他服务', async (provider, kind, ext) => {
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
    if (provider === 'apimart' && kind !== 'image') {
      await expect(resolve()).rejects.toThrow('不会改传图床');
      now += 150 * 60_000;
      await expect(resolve()).rejects.toThrow('不会改传图床');
      expect(await resolveMediaReferenceUrl(generatedUrl, { provider, kind, mode: 'publicUrl' })).toBe(generatedUrl);
      expect(localFetch).not.toHaveBeenCalled();
      expect(mocks.transport).not.toHaveBeenCalled();
      return;
    }
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
