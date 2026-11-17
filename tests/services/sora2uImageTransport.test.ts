/** Sora2U 图片入口：本地内联与 HTTPS 各走官方字段，不依赖图床。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn(), inline: vi.fn(), remote: vi.fn() }));
vi.mock('../../src/services/ai/modelProtocolRuntime', async (original) => ({
  ...await original<object>(), runConfiguredModelProtocol: mocks.run,
}));
vi.mock('../../src/services/ai/imageUtils', async (original) => ({
  ...await original<object>(), resolveImageDataUrlArray: mocks.inline, resolveImageUrlArray: mocks.remote,
}));

import { generateImagesBatch } from '../../src/services/ai/generateImage';
import { previewModelProtocolRequest } from '../../src/services/ai/modelProtocol';
import {
  SORA2U_BASE_URL, SORA2U_MODEL_MANIFEST, SORA2U_INLINE_REFERENCE_MAX_BYTES,
} from '../../src/services/ai/providers/sora2uModelManifest';
import { useAppStore } from '../../src/store/useAppStore';
import type { ProtocolJsonValue } from '../../src/types/aiTypes';

const INLINE = 'data:image/png;base64,AQID';
const REMOTE_INLINE = 'data:image/png;base64,BAUG';
const LOCAL = 'asset://localhost/sora-reference.png';
const LOCAL_HTTPS = 'https://asset.localhost/sora-reference.png';
const HTTPS = 'https://assets.example/sora-reference.png';

beforeEach(() => {
  vi.resetAllMocks();
  useAppStore.setState(useAppStore.getInitialState(), true);
  mocks.run.mockResolvedValue(['https://sora2u.com/api/files/images/result.png']);
  mocks.inline.mockImplementation(async (sources: string[]) => sources.map((source) => source === HTTPS ? REMOTE_INLINE
    : source === LOCAL || source === LOCAL_HTTPS ? INLINE : source));
  mocks.remote.mockRejectedValue(new Error('Sora2U 内置图片不应转入图床 URL 链路'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应发起额外上传或直接下载'));
});

afterEach(() => { vi.restoreAllMocks(); });

function configure(modelId: string, legacy: boolean, general: boolean) {
  const selected = structuredClone(SORA2U_MODEL_MANIFEST.find((model) => model.id === modelId)!);
  if (legacy) {
    const protocol = selected.executionProfile!.protocol!;
    protocol.submit.body = { ...(protocol.submit.body as Record<string, ProtocolJsonValue>), reference_urls: '{{imageUrls}}' };
    delete (protocol.submit.body as Record<string, ProtocolJsonValue>).references;
  }
  useAppStore.getState().saveProviderConfig('my-sora', { name: '自己的 Sora', catalogId: 'sora2u',
    apiKey: 'sora-image-fixture', baseUrl: SORA2U_BASE_URL, selectedModels: [selected] });
  const configured = useAppStore.getState().config.generalModels!.find((model) => model.providerConfigId === 'my-sora')!;
  return { provider: general ? 'general' : 'my-sora', model: general ? `general/${configured.id}` : modelId,
    prompt: '保留人物特征并绘制安静的庭院', imageSize: '2K', aspectRatio: '16:9' };
}

describe('Sora2U 图片生成参考输入', () => {
  it.each([
    ['gemini-image', false, false], ['gemini-image', true, false],
    ['gemini-image', false, true], ['gemini-image', true, true],
    ['kontext-image', false, false], ['kontext-image', true, false],
    ['kontext-image', false, true], ['kontext-image', true, true],
  ] as const)('%s 旧协议=%s 通用入口=%s 混合来源整组内联，保留顺序与配置', async (modelId, legacy, general) => {
    const params = configure(modelId, legacy, general);
    const saved = structuredClone(useAppStore.getState().config.providers['my-sora'].selectedModels);
    const result = await generateImagesBatch({ ...params, image_urls: [HTTPS, LOCAL, LOCAL_HTTPS, INLINE] }, 1);
    expect(mocks.inline).toHaveBeenCalledExactlyOnceWith([HTTPS, LOCAL, LOCAL_HTTPS, INLINE], undefined, {
      maxImages: 4, maxImageBytes: SORA2U_INLINE_REFERENCE_MAX_BYTES, maxTotalBytes: SORA2U_INLINE_REFERENCE_MAX_BYTES,
    });
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const options = mocks.run.mock.calls[0][0];
    expect(options.model.providerConfigId).toBe('my-sora');
    expect(options.variables.imageUrls).toEqual([REMOTE_INLINE, INLINE, INLINE, INLINE]);
    const preview = previewModelProtocolRequest({ baseUrl: SORA2U_BASE_URL,
      protocol: options.model.executionProfile.protocol, variables: options.variables });
    expect(preview.relativeUrl).toBe('/api/v1/videos?utm_source=tenney&utm_medium=canvas&utm_content=wx');
    expect(preview.body).toMatchObject({ model: modelId, resolution: '2K', aspect_ratio: '16:9',
      references: [REMOTE_INLINE, INLINE, INLINE, INLINE] });
    expect(preview.body).not.toHaveProperty('reference_urls');
    expect(result.results[0].url).toBe('https://sora2u.com/api/files/images/result.png');
    expect(useAppStore.getState().config.providers['my-sora'].selectedModels).toEqual(saved);
  });

  it('纯 HTTPS 图片保留 URL 数组，不下载、不转图床', async () => {
    const params = configure('gemini-image', false, true);
    await generateImagesBatch({ ...params, image_urls: [HTTPS] }, 1);
    expect(mocks.inline).not.toHaveBeenCalled();
    expect(mocks.remote).not.toHaveBeenCalled();
    const options = mocks.run.mock.calls[0][0];
    expect(options.variables.referenceUrls).toEqual([HTTPS]);
    expect(options.variables.inlineReferences).toBeUndefined();
    const preview = previewModelProtocolRequest({ baseUrl: SORA2U_BASE_URL,
      protocol: options.model.executionProfile.protocol, variables: options.variables });
    expect(preview.body).toMatchObject({ reference_urls: [HTTPS] });
    expect(preview.body).not.toHaveProperty('references');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('超过四张时在读图和提交前拒绝，不能转图床', async () => {
    const params = configure('gemini-image', true, true);
    await expect(generateImagesBatch({ ...params, image_urls: Array.from({ length: 5 }, (_, index) => `${HTTPS}?i=${index}`) }, 1))
      .rejects.toThrow('最多支持 4 张');
    expect(mocks.inline).not.toHaveBeenCalled();
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('本地读图失败立即停止，不改传公共图床或提交生成', async () => {
    const params = configure('kontext-image', false, false);
    mocks.inline.mockRejectedValueOnce(new Error('无法读取参考图片'));
    await expect(generateImagesBatch({ ...params, image_urls: [LOCAL] }, 1)).rejects.toThrow('无法读取参考图片');
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('非 Sora 的自定义图片协议显式声明 inlineReferences 时仍有真实内联值和预算', async () => {
    const selected = { id: 'custom-inline-image', name: '自定义内联图片', category: 'image' as const,
      executionProfile: { preset: 'custom' as const, protocol: { version: 2 as const, mode: 'sync' as const,
        submit: { method: 'POST' as const, path: '/v1/my-images', bodyEncoding: 'json' as const,
          body: { model: '{{model}}', prompt: '{{prompt}}', references: '{{inlineReferences}}' } },
        response: { type: 'json' as const, result: { urlPath: 'result.url' } } } } };
    useAppStore.getState().saveProviderConfig('my-custom', { name: '自定义连接', catalogId: 'custom-openai',
      apiKey: 'custom-inline-fixture', baseUrl: 'https://gateway.example', selectedModels: [selected] });
    const general = useAppStore.getState().config.generalModels!.find((model) => model.providerConfigId === 'my-custom')!;
    await generateImagesBatch({ provider: 'general', model: `general/${general.id}`,
      prompt: '保留主体并变换背景', image_urls: [LOCAL_HTTPS] }, 1);
    expect(mocks.inline).toHaveBeenCalledExactlyOnceWith([LOCAL_HTTPS], undefined, {
      maxImageBytes: 32 * 1024 * 1024, maxTotalBytes: 48 * 1024 * 1024,
    });
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const options = mocks.run.mock.calls[0][0];
    expect(options.model.executionProfile).toEqual(selected.executionProfile);
    expect(options.variables.inlineReferences).toEqual([INLINE]);
    expect(options.variables.referenceUrls).toBeUndefined();
    const request = previewModelProtocolRequest({ baseUrl: 'https://gateway.example',
      protocol: options.model.executionProfile.protocol, variables: options.variables });
    expect(request.relativeUrl).toBe('/v1/my-images');
    expect(request.body).toMatchObject({ model: selected.id, references: [INLINE] });
    expect(fetch).not.toHaveBeenCalled();
  });
});
