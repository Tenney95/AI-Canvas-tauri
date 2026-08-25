import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProviderModelCatalog } from '../../src/services/ai/providerCatalogService';
import { SORA2U_MODEL_MANIFEST } from '../../src/services/ai/providers/sora2uModelManifest';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('providerCatalogService 模型分类推断', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['MiniMax-H3'],
    ['minimax-h3'],
    ['MiniMax-H3-Context-IR'],
    ['minimax-h3-regeneration'],
    ['MiniMax_H3'],
    ['MiniMax H3'],
  ])('中转站拉取 %s 归类为视频模型', async (modelId) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      data: [
        {
          id: modelId,
          object: 'model',
          created: 0,
          owned_by: 'minimax',
          supported_endpoint_types: ['openai'],
        },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchProviderModelCatalog({
      providerId: 'apimart',
      config: {
        name: 'APIMart',
        apiKey: 'test-key',
        baseUrl: 'https://api.apimart.ai',
        catalogId: 'apimart',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.apimart.ai/models',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.category).toBe('video');
    expect(result.models[0]?.provider).toBe('apimart');
  });

  it('自定义接口拉取 minimax-h3 同样归类为视频模型', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([
      { id: 'MiniMax-H3', object: 'model' },
      { id: 'MiniMax-H3-Context-IR', object: 'model' },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchProviderModelCatalog({
      providerId: 'custom-openai',
      config: {
        name: '中转',
        apiKey: 'test-key',
        baseUrl: 'https://relay.example.com/v1',
        catalogId: 'custom-openai',
      },
    });

    expect(result.models.every((model) => model.category === 'video')).toBe(true);
  });

  it('不影响其他模型的分类推断', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([
      { id: 'gpt-4o', object: 'model' },
      { id: 'tts-1', object: 'model' },
      { id: 'dall-e-3', object: 'model' },
      { id: 'minimax-text-01', object: 'model' },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchProviderModelCatalog({
      providerId: 'custom-openai',
      config: {
        name: '中转',
        apiKey: 'test-key',
        baseUrl: 'https://relay.example.com/v1',
        catalogId: 'custom-openai',
      },
    });

    const categoryOf = (id: string) => result.models.find((model) => model.id === id)?.category;
    expect(categoryOf('gpt-4o')).toBe('text');
    expect(categoryOf('tts-1')).toBe('audio');
    expect(categoryOf('dall-e-3')).toBe('image');
    expect(categoryOf('minimax-text-01')).toBe('text');
  });
});

describe('Sora2U 远端模型能力目录', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('合并远端能力与本地执行协议，并保留远端新增模型', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      object: 'list',
      data: [
        {
          id: 'seedance-2.5',
          object: 'model',
          name: 'Seedance 2.5 Remote',
          durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 30],
          duration_range: { min: 5, max: 30, step: 1 },
          default_duration: 15,
          aspect_ratios: ['16:9', '9:16', 'adaptive'],
          default_aspect_ratio: 'adaptive',
          resolutions: ['720p', '1080p'],
          default_resolution: '720p',
          supports_text_only: false,
          supports_image: true,
          supports_video: true,
          supports_audio: true,
          reference_limits: { image: 30, video: 10, audio: 10, total: 50 },
        },
        {
          id: 'future-image',
          object: 'model',
          name: 'Future Image',
          supports_image: true,
          supports_video: false,
          supports_audio: false,
        },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchProviderModelCatalog({
      providerId: 'sora2u',
      config: {
        name: 'Sora2U',
        apiKey: 'sk_sora_test',
        baseUrl: 'https://sora2u.com',
        catalogId: 'sora2u',
      },
      fallbackModels: [...SORA2U_MODEL_MANIFEST],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sora2u.com/api/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer sk_sora_test' },
      }),
    );
    const seedance = result.models.find((model) => model.id === 'seedance-2.5');
    expect(seedance).toMatchObject({
      name: 'Seedance 2.5 Remote',
      category: 'video',
      videoCapability: {
        durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 30],
        minDuration: 5,
        maxDuration: 30,
        defaultDuration: 15,
        ratios: ['16:9', '9:16', 'adaptive'],
        defaultRatio: 'adaptive',
        resolutions: ['720p', '1080p'],
        defaultResolution: '720p',
        maxImageReferences: 30,
        maxVideoReferences: 10,
        maxAudioReferences: 10,
      },
    });
    expect(seedance?.executionProfile?.preset).toBe('custom');
    expect(result.models.find((model) => model.id === 'future-image')).toMatchObject({
      category: 'image',
      provider: 'sora2u',
      inputModalities: ['text', 'image'],
    });
  });
});
