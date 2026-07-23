import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storeState: {
    config: {
      providers: {
        apimart: {
          name: 'APIMart',
          apiKey: 'secret',
          baseUrl: 'https://api.example/',
        },
      },
    },
    currentProjectId: 'project-1',
    nodes: [],
    updateNodeDataTransient: vi.fn(),
  },
  generateApimartImagesBatch: vi.fn(),
  generateApimartVideo: vi.fn(),
  generateApimartSpeech: vi.fn(),
  getApimartAudioCapability: vi.fn(),
}));

vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: { getState: () => mocks.storeState },
}));

vi.mock('../../src/services/ai/apimartGen', () => ({
  generateApimartImagesBatch: mocks.generateApimartImagesBatch,
  generateApimartVideo: mocks.generateApimartVideo,
}));

vi.mock('../../src/services/ai/apimartAudio', () => ({
  extractFlowMusicLyrics: vi.fn(),
  extractFlowMusicTrack: vi.fn(),
  fetchFlowMusicTask: vi.fn(),
  generateApimartSpeech: mocks.generateApimartSpeech,
  getApimartAudioCapability: mocks.getApimartAudioCapability,
  submitFlowMusicGeneration: vi.fn(),
  submitFlowMusicLyrics: vi.fn(),
}));

import {
  MediaProviderRegistry,
  mediaProviderRegistry,
  type MediaProviderAdapter,
} from '../../src/services/ai/mediaProviderRegistry';

function imageAdapter(providerId: string): MediaProviderAdapter {
  return {
    providerId,
    capabilities: ['image'],
    generateImage: vi.fn().mockResolvedValue({
      requestedCount: 1,
      results: [{ url: 'https://cdn.example/image.png', width: 1, height: 1 }],
      failedCount: 0,
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storeState.config.providers.apimart.apiKey = 'secret';
  mocks.storeState.config.providers.apimart.baseUrl = 'https://api.example/';
  mocks.generateApimartImagesBatch.mockResolvedValue({
    requestedCount: 2,
    results: [],
    failedCount: 2,
  });
  mocks.generateApimartVideo.mockResolvedValue({ url: 'https://cdn.example/video.mp4' });
  mocks.generateApimartSpeech.mockResolvedValue({ url: 'blob:audio' });
});

describe('MediaProviderRegistry', () => {
  it('resolves only handlers declared by the provider capability contract', () => {
    const registry = new MediaProviderRegistry([imageAdapter('example')]);

    expect(registry.supports('example', 'image')).toBe(true);
    expect(registry.supports('example', 'video')).toBe(false);
    expect(registry.getImageAdapter('example')?.providerId).toBe('example');
    expect(registry.getVideoAdapter('example')).toBeUndefined();
  });

  it('rejects duplicate providers and mismatched capability declarations', () => {
    const registry = new MediaProviderRegistry([imageAdapter('example')]);

    expect(() => registry.register(imageAdapter('example'))).toThrow('已注册');
    expect(() => registry.register({
      providerId: 'broken',
      capabilities: ['video'],
      generateImage: vi.fn(),
    })).toThrow('capability 与 handler 不一致');
  });

  it('unregisters only the adapter instance returned by registration', () => {
    const registry = new MediaProviderRegistry();
    const unregister = registry.register(imageAdapter('temporary'));

    expect(registry.supports('temporary', 'image')).toBe(true);
    unregister();
    expect(registry.supports('temporary', 'image')).toBe(false);
  });

  it('registers APIMart as one adapter with all media capabilities', () => {
    expect(mediaProviderRegistry.supports('apimart', 'image')).toBe(true);
    expect(mediaProviderRegistry.supports('apimart', 'video')).toBe(true);
    expect(mediaProviderRegistry.supports('apimart', 'audio')).toBe(true);
  });

  it('resolves APIMart connection once inside the image adapter and forwards cancellation', async () => {
    const signal = new AbortController().signal;
    const adapter = mediaProviderRegistry.getImageAdapter('apimart');

    await adapter?.generateImage({
      params: {
        prompt: 'raw prompt',
        model: 'apimart/image-model',
        provider: 'apimart',
        nodeId: 'image-node',
        imageSize: '2K',
        aspectRatio: '1:1',
      },
      prompt: 'resolved prompt',
      imageUrls: ['https://cdn.example/reference.png'],
      requestedCount: 2,
      signal,
    });

    expect(mocks.generateApimartImagesBatch).toHaveBeenCalledWith(
      'secret',
      'https://api.example',
      'image-model',
      'resolved prompt',
      '2K',
      '1:1',
      { width: 2048, height: 2048 },
      ['https://cdn.example/reference.png'],
      2,
      'image-node',
      signal,
    );
  });

  it('routes APIMart Seedance video through the registered video capability', async () => {
    const signal = new AbortController().signal;
    const adapter = mediaProviderRegistry.getVideoAdapter('apimart');

    await adapter?.generateVideo({
      params: {
        prompt: 'raw prompt',
        model: 'apimart/doubao-seedance-2.0',
        provider: 'apimart',
        nodeId: 'video-node',
        seedanceResolution: '1080p',
        seedanceRatio: '9:16',
        seedanceDuration: 8,
        generateAudio: true,
      },
      prompt: 'node-resolved prompt',
      resolveReferenceInput: vi.fn().mockResolvedValue({
        prompt: 'reference-resolved prompt',
        imageUrls: ['https://cdn.example/reference.png'],
      }),
      signal,
    });

    expect(mocks.generateApimartVideo).toHaveBeenCalledWith(
      'secret',
      'https://api.example',
      'doubao-seedance-2.0',
      'reference-resolved prompt',
      'video-node',
      {
        resolution: '1080p',
        ratio: '9:16',
        duration: 8,
        generateAudio: true,
        imageUrls: ['https://cdn.example/reference.png'],
      },
      signal,
    );
  });

  it('does not resolve reference images for legacy APIMart video models', async () => {
    const resolveReferenceInput = vi.fn();
    const adapter = mediaProviderRegistry.getVideoAdapter('apimart');

    await adapter?.generateVideo({
      params: {
        prompt: 'raw prompt',
        model: 'apimart/legacy-video-model',
        provider: 'apimart',
      },
      prompt: 'node-resolved prompt',
      resolveReferenceInput,
    });

    expect(resolveReferenceInput).not.toHaveBeenCalled();
    expect(mocks.generateApimartVideo).toHaveBeenCalledWith(
      'secret',
      'https://api.example',
      'legacy-video-model',
      'node-resolved prompt',
      undefined,
      {},
      undefined,
    );
  });

  it('routes APIMart speech models through the registered audio capability', async () => {
    mocks.getApimartAudioCapability.mockReturnValue('speech');
    const signal = new AbortController().signal;
    const adapter = mediaProviderRegistry.getAudioAdapter('apimart');

    await adapter?.generateAudio({
      params: {
        prompt: 'raw prompt',
        model: 'apimart/gpt-4o-mini-tts',
        provider: 'apimart',
        audioVoice: 'nova',
        audioFormat: 'aac',
        audioSpeed: 1.25,
      },
      prompt: 'resolved speech',
      signal,
    });

    expect(mocks.generateApimartSpeech).toHaveBeenCalledWith(
      'secret',
      'https://api.example',
      {
        model: 'gpt-4o-mini-tts',
        input: 'resolved speech',
        voice: 'nova',
        format: 'aac',
        speed: 1.25,
      },
      signal,
    );
  });

  it('keeps APIMart credential errors inside the adapter boundary', async () => {
    mocks.storeState.config.providers.apimart.apiKey = '';
    const adapter = mediaProviderRegistry.getAudioAdapter('apimart');

    expect(() => adapter?.generateAudio({
      params: {
        prompt: 'speech',
        model: 'apimart/gpt-4o-mini-tts',
        provider: 'apimart',
      },
      prompt: 'speech',
    })).toThrow('未配置 apimart 的 API Key');
  });
});
