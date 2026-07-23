import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  generateAudio: vi.fn(),
  persistAudioGenerationResult: vi.fn(),
}));

vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: {
    getState: () => ({
      config: {
        generalModels: [],
        providers: {
          openai: { apiKey: 'secret' },
        },
      },
    }),
  },
}));
vi.mock('../../src/components/nodes/shared/defaultModels', () => ({
  findMediaModelOption: (modelRef: string) => ({
    value: modelRef,
    label: modelRef,
    mediaKind: modelRef.includes('video')
      ? 'video'
      : modelRef.includes('audio')
        ? 'audio'
        : 'image',
    provider: 'openai',
  }),
}));
vi.mock('../../src/services/ai/generateImage', () => ({ generateImage: mocks.generateImage }));
vi.mock('../../src/services/ai/generateVideo', () => ({ generateVideo: mocks.generateVideo }));
vi.mock('../../src/services/ai/generateAudio', () => ({
  generateAudio: mocks.generateAudio,
  persistAudioGenerationResult: mocks.persistAudioGenerationResult,
}));
vi.mock('../../src/services/fileService', () => ({
  downloadUrlAndSave: vi.fn(),
  saveDataUrlToProjectData: vi.fn(),
}));

import { runMediaGeneration } from '../../src/services/ai/generationRuntime';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateImage.mockResolvedValue({ url: 'https://cdn.example/image.png', width: 1, height: 1 });
  mocks.generateVideo.mockResolvedValue({ url: 'https://cdn.example/video.mp4' });
  mocks.generateAudio.mockResolvedValue({ url: 'https://cdn.example/audio.mp3' });
  mocks.persistAudioGenerationResult.mockResolvedValue({
    mediaUrl: 'https://cdn.example/audio.mp3',
    outputUrl: 'https://cdn.example/audio.mp3',
  });
});

describe('media generation cancellation', () => {
  it.each([
    ['image', 'openai/image-model', mocks.generateImage],
    ['video', 'openai/video-model', mocks.generateVideo],
    ['audio', 'openai/audio-model', mocks.generateAudio],
  ] as const)('passes the task AbortSignal to %s generation', async (kind, modelRef, generate) => {
    const controller = new AbortController();

    await runMediaGeneration({
      kind,
      prompt: 'test prompt',
      modelRef,
      deliveryMode: 'chat',
    }, null, controller.signal);

    expect(generate).toHaveBeenCalledWith(expect.any(Object), controller.signal);
  });
});
