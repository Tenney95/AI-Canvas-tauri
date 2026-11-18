/** Sora2U 内置图片下架后保留旧任务连接和用户自定义协议。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn(), inline: vi.fn(), remote: vi.fn() }));
vi.mock('../../src/services/ai/modelProtocolRuntime', async (original) => ({
  ...await original<object>(), runConfiguredModelProtocol: mocks.run,
}));
vi.mock('../../src/services/ai/imageUtils', async (original) => ({
  ...await original<object>(), resolveImageDataUrlArray: mocks.inline, resolveImageUrlArray: mocks.remote,
}));

import { generateImagesBatch } from '../../src/services/ai/generateImage';
import { resolveGeneralModelConnection } from '../../src/services/ai/helpers';
import { previewModelProtocolRequest } from '../../src/services/ai/modelProtocol';
import {
  SORA2U_BASE_URL, SORA2U_MODEL_MANIFEST,
} from '../../src/services/ai/providers/sora2uModelManifest';
import { useAppStore } from '../../src/store/useAppStore';
import type { ProtocolJsonValue } from '../../src/types/aiTypes';

const INLINE = 'data:image/png;base64,AQID';
const LOCAL = 'asset://localhost/sora-reference.png';
const LOCAL_HTTPS = 'https://asset.localhost/sora-reference.png';
const HTTPS = 'https://assets.example/sora-reference.png';

beforeEach(() => {
  vi.resetAllMocks();
  useAppStore.setState(useAppStore.getInitialState(), true);
  mocks.run.mockResolvedValue(['https://sora2u.com/api/files/images/result.png']);
  mocks.inline.mockImplementation(async (sources: string[]) => sources.map((source) =>
    source === LOCAL || source === LOCAL_HTTPS ? INLINE : source));
  mocks.remote.mockRejectedValue(new Error('不应转入图床 URL 链路'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应发起额外上传或直接下载'));
});

afterEach(() => { vi.restoreAllMocks(); });

function configure(modelId: string, legacy: boolean, general: boolean, baseUrl: string | null = SORA2U_BASE_URL) {
  const selected = structuredClone(SORA2U_MODEL_MANIFEST.find((model) => model.id === modelId)!);
  if (legacy) {
    const protocol = selected.executionProfile!.protocol!;
    protocol.submit.body = { ...(protocol.submit.body as Record<string, ProtocolJsonValue>), reference_urls: '{{imageUrls}}' };
    delete (protocol.submit.body as Record<string, ProtocolJsonValue>).references;
  }
  useAppStore.getState().saveProviderConfig('my-sora', { name: '自己的 Sora', catalogId: 'sora2u',
    apiKey: 'sora-image-fixture', baseUrl: baseUrl ?? undefined, selectedModels: [selected] });
  const configured = useAppStore.getState().config.generalModels!.find((model) => model.providerConfigId === 'my-sora')!;
  return { provider: general ? 'general' : 'my-sora', model: general ? `general/${configured.id}` : modelId,
    prompt: '保留人物特征并绘制安静的庭院', imageSize: '2K', aspectRatio: '16:9' };
}

describe('Sora2U 内置图片下架', () => {
  it.each([
    ['gemini-image', false, false], ['gemini-image', true, false],
    ['gemini-image', false, true], ['gemini-image', true, true],
    ['kontext-image', false, false], ['kontext-image', true, false],
    ['kontext-image', false, true], ['kontext-image', true, true],
  ] as const)('%s 旧协议=%s 通用入口=%s 在读取参考图或提交前拒绝', async (modelId, legacy, general) => {
    const params = configure(modelId, legacy, general);
    const saved = structuredClone(useAppStore.getState().config.providers['my-sora'].selectedModels);
    const beforeSubmit = vi.fn();
    await expect(generateImagesBatch({ ...params, image_urls: [HTTPS, LOCAL, LOCAL_HTTPS, INLINE] }, 1, undefined, beforeSubmit))
      .rejects.toThrow('内置厂商已下架');
    expect(mocks.inline).not.toHaveBeenCalled();
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(beforeSubmit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(useAppStore.getState().config.providers['my-sora'].selectedModels).toEqual(saved);
  });

  it('旧图片回执可继续按原地址、密钥和协议恢复', () => {
    const params = configure('gemini-image', true, true);
    const saved = useAppStore.getState().config.providers['my-sora'].selectedModels![0].executionProfile;
    expect(() => resolveGeneralModelConnection(params.model)).toThrow('内置厂商已下架');
    expect(resolveGeneralModelConnection(params.model, { forRecovery: true })).toMatchObject({
      providerConfigId: 'my-sora', apiKey: 'sora-image-fixture', baseUrl: SORA2U_BASE_URL,
      model: { executionProfile: saved },
    });
    expect(mocks.inline).not.toHaveBeenCalled();
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('参考图超出旧限制时仍先报告下架，不读图或改传图床', async () => {
    const params = configure('gemini-image', true, true);
    await expect(generateImagesBatch({ ...params, image_urls: Array.from({ length: 5 }, (_, index) => `${HTTPS}?i=${index}`) }, 1))
      .rejects.toThrow('内置厂商已下架');
    expect(mocks.inline).not.toHaveBeenCalled();
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('未保存接口地址的旧连接仍可用内置默认地址恢复', () => {
    const params = configure('kontext-image', false, true, null);
    expect(resolveGeneralModelConnection(params.model, { forRecovery: true })).toMatchObject({
      providerConfigId: 'my-sora', baseUrl: SORA2U_BASE_URL,
    });
    expect(mocks.inline).not.toHaveBeenCalled();
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('同 ID 同名的显式自定义连接仍使用自己的图片协议', async () => {
    const selected = { id: 'custom-inline-image', name: '自定义内联图片', provider: 'custom-openai', category: 'image' as const,
      executionProfile: { preset: 'custom' as const, protocol: { version: 2 as const, mode: 'sync' as const,
        submit: { method: 'POST' as const, path: '/v1/my-images', bodyEncoding: 'json' as const,
          body: { model: '{{model}}', prompt: '{{prompt}}', references: '{{inlineReferences}}' } },
        response: { type: 'json' as const, result: { urlPath: 'result.url' } } } } };
    useAppStore.getState().saveProviderConfig('sora2u', { name: 'Sora2U', catalogId: 'custom-openai',
      apiKey: 'custom-inline-fixture', baseUrl: 'https://gateway.example', selectedModels: [selected] });
    const general = useAppStore.getState().config.generalModels!.find((model) => model.providerConfigId === 'sora2u')!;
    await generateImagesBatch({ provider: 'general', model: `general/${general.id}`,
      prompt: '保留主体并变换背景', image_urls: [LOCAL_HTTPS] }, 1);
    expect(mocks.inline).toHaveBeenCalledExactlyOnceWith([LOCAL_HTTPS], undefined, {
      maxImageBytes: 32 * 1024 * 1024, maxTotalBytes: 48 * 1024 * 1024,
    });
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const options = mocks.run.mock.calls[0][0];
    expect(options.model.providerConfigId).toBe('sora2u');
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
