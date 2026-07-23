import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  generateAudio: vi.fn(),
  persistAudioGenerationResult: vi.fn(),
  storeState: {
    config: {
      generalModels: [],
      providers: {
        openai: { apiKey: 'secret' },
      },
    },
    currentProjectId: 'project-1',
    projects: [] as Array<Record<string, unknown>>,
    customStyles: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: {
    getState: () => mocks.storeState,
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
  mocks.storeState.currentProjectId = 'project-1';
  mocks.storeState.projects = [];
  mocks.storeState.customStyles = [];
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

describe('media generation project settings', () => {
  it('applies image style, suffix, size, and aspect ratio without replacing the explicit model', async () => {
    mocks.storeState.projects = [{
      id: 'project-1',
      settings: {
        visualStyle: {
          styleId: 'cinematic',
          prompt: '项目电影画风',
          locked: true,
        },
        promptSuffixes: { image: '图片质量后缀' },
        defaultModels: { image: 'openai/project-default-image' },
        generation: { imageSize: '4K', imageAspectRatio: '16:9' },
      },
    }];

    const result = await runMediaGeneration({
      kind: 'image',
      prompt: '一座山',
      modelRef: 'openai/image-model',
      deliveryMode: 'canvas',
    }, 'project-1');

    expect(mocks.generateImage).toHaveBeenCalledWith({
      prompt: '一座山\n\n项目电影画风\n\n图片质量后缀',
      model: 'openai/image-model',
      provider: 'openai',
      imageSize: '4K',
      aspectRatio: '16:9',
    }, undefined);
    expect(result.prompt).toBe('一座山');
    expect(result.modelId).toBe('openai/image-model');
  });

  it('applies video style, suffix, resolution, and duration', async () => {
    mocks.storeState.projects = [{
      id: 'project-1',
      settings: {
        visualStyle: {
          styleId: 'cinematic',
          prompt: '统一电影画风',
          locked: true,
        },
        promptSuffixes: { video: '稳定运镜' },
        generation: { videoResolution: '1080p', videoDuration: 10 },
      },
    }];

    await runMediaGeneration({
      kind: 'video',
      prompt: '镜头向前推进',
      modelRef: 'openai/video-model',
      deliveryMode: 'chat',
    }, 'project-1');

    expect(mocks.generateVideo).toHaveBeenCalledWith({
      prompt: '镜头向前推进\n\n统一电影画风\n\n稳定运镜',
      model: 'openai/video-model',
      provider: 'openai',
      seedanceResolution: '1080p',
      seedanceDuration: 10,
    }, undefined);
  });

  it('applies the audio prompt suffix', async () => {
    mocks.storeState.projects = [{
      id: 'project-1',
      settings: {
        promptSuffixes: { audio: '录音棚品质' },
      },
    }];

    await runMediaGeneration({
      kind: 'audio',
      prompt: '轻柔旁白',
      modelRef: 'openai/audio-model',
      deliveryMode: 'chat',
    }, 'project-1');

    expect(mocks.generateAudio).toHaveBeenCalledWith({
      prompt: '轻柔旁白\n\n录音棚品质',
      model: 'openai/audio-model',
      provider: 'openai',
    }, undefined);
  });
});
