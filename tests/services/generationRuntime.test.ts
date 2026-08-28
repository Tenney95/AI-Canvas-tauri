import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiProviderConfig, GeneralModelConfig } from '../../src/types';

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  generateAudio: vi.fn(),
  persistAudioGenerationResult: vi.fn(),
  downloadUrlAndSave: vi.fn(),
  saveDataUrlToProjectData: vi.fn(),
  saveBinaryToProjectData: vi.fn(),
  isTauriEnv: vi.fn(() => true),
  tagGeneratedProjectAssetSafely: vi.fn(),
  storeState: {
    config: {
      generalModels: [] as GeneralModelConfig[],
      providers: {
        openai: { name: 'OpenAI', apiKey: 'secret' },
      } as Record<string, ApiProviderConfig>,
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
    provider: modelRef.startsWith('general/') ? 'general' : 'openai',
  }),
}));
vi.mock('../../src/services/ai/generateImage', () => ({ generateImage: mocks.generateImage }));
vi.mock('../../src/services/ai/generateVideo', () => ({ generateVideo: mocks.generateVideo }));
vi.mock('../../src/services/ai/generateAudio', () => ({
  generateAudio: mocks.generateAudio,
  persistAudioGenerationResult: mocks.persistAudioGenerationResult,
}));
vi.mock('../../src/services/fileService', () => ({
  downloadUrlAndSave: mocks.downloadUrlAndSave,
  isTauriEnv: mocks.isTauriEnv,
  saveBinaryToProjectData: mocks.saveBinaryToProjectData,
  saveDataUrlToProjectData: mocks.saveDataUrlToProjectData,
}));
vi.mock('../../src/services/fs/generatedAssetTags', () => ({
  tagGeneratedProjectAssetSafely: mocks.tagGeneratedProjectAssetSafely,
}));

import {
  MEDIA_PERSIST_FAILED_MESSAGE,
  retryMediaArtifactPersist,
  runMediaGeneration,
} from '../../src/services/ai/generationRuntime';
import type { MediaGenerationResult } from '../../src/types/media';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storeState.currentProjectId = 'project-1';
  mocks.storeState.projects = [];
  mocks.storeState.customStyles = [];
  mocks.storeState.config.generalModels = [];
  mocks.storeState.config.providers = { openai: { name: 'OpenAI', apiKey: 'secret' } };
  mocks.generateImage.mockResolvedValue({ url: 'https://cdn.example/image.png', width: 1, height: 1 });
  mocks.generateVideo.mockResolvedValue({ url: 'https://cdn.example/video.mp4' });
  mocks.generateAudio.mockResolvedValue({ url: 'https://cdn.example/audio.mp3' });
  mocks.persistAudioGenerationResult.mockResolvedValue({
    mediaUrl: 'https://cdn.example/audio.mp3',
    outputUrl: 'https://cdn.example/audio.mp3',
    persistence: 'saved',
  });
  mocks.isTauriEnv.mockReturnValue(true);
  mocks.downloadUrlAndSave.mockResolvedValue({
    filePath: '/projects/project-1/对话图片.png',
    assetUrl: 'asset://对话图片.png',
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
      // 本地工作流只认数字长边，1080p 换算成 1920
      videoResolution: 1920,
      workflowId: undefined,
    }, undefined);
  });

  it('uses the video parameters locked in the intent ahead of changed project defaults', async () => {
    mocks.storeState.projects = [{
      id: 'project-1',
      settings: {
        generation: {
          videoAspectRatio: '16:9',
          videoResolution: '1080p',
          videoDuration: 10,
        },
      },
    }];

    await runMediaGeneration({
      kind: 'video',
      prompt: '竖屏人物镜头',
      modelRef: 'openai/video-model',
      deliveryMode: 'chat',
      aspectRatio: '9:16',
      resolution: '720p',
      duration: 6,
    }, 'project-1');

    expect(mocks.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      seedanceRatio: '9:16',
      seedanceResolution: '720p',
      seedanceDuration: 6,
      videoResolution: 1280,
    }), undefined);
  });

  it('does not inject project video defaults or derived pixels into direct general protocols', async () => {
    mocks.storeState.config.generalModels = [{
      id: 'custom-video',
      name: 'Custom Video',
      modelId: 'upstream-video',
      category: 'video',
      providerConfigId: 'custom',
    }];
    mocks.storeState.config.providers = {
      openai: { name: 'OpenAI', apiKey: 'secret' },
      custom: { name: 'Custom', apiKey: '', baseUrl: 'https://gateway.example.com' },
    };
    mocks.storeState.projects = [{
      id: 'project-1',
      settings: {
        generation: {
          videoAspectRatio: '16:9',
          videoResolution: '1080p',
          videoDuration: 10,
        },
      },
    }];

    await runMediaGeneration({
      kind: 'video',
      prompt: '保持模型默认参数',
      modelRef: 'general/custom-video',
      deliveryMode: 'chat',
    }, 'project-1');

    expect(mocks.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      model: 'general/custom-video',
      provider: 'general',
      seedanceRatio: undefined,
      seedanceResolution: undefined,
      seedanceDuration: undefined,
      videoResolution: undefined,
      workflowId: undefined,
    }), undefined);
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

describe('media artifact persistence', () => {
  it('marks the artifact saved and points url at the local asset', async () => {
    const result = await runMediaGeneration({
      kind: 'image',
      prompt: '一只猫',
      modelRef: 'openai/image-model',
      deliveryMode: 'chat',
    }, 'project-1');

    expect(result.persistence).toBe('saved');
    expect(result.persistError).toBeUndefined();
    expect(result.url).toBe('asset://对话图片.png');
    expect(result.sourceUrl).toBe('https://cdn.example/image.png');
    expect(result.filePath).toBe('/projects/project-1/对话图片.png');
  });

  it('reports failed persistence instead of silently returning the temporary url', async () => {
    mocks.downloadUrlAndSave.mockResolvedValue(null);

    const result = await runMediaGeneration({
      kind: 'video',
      prompt: '一段风景',
      modelRef: 'openai/video-model',
      deliveryMode: 'chat',
    }, 'project-1');

    expect(result.persistence).toBe('failed');
    expect(result.persistError).toBe(MEDIA_PERSIST_FAILED_MESSAGE);
    expect(result.url).toBe('https://cdn.example/video.mp4');
    expect(result.filePath).toBeUndefined();
  });

  it('surfaces the download error message when saving throws', async () => {
    mocks.downloadUrlAndSave.mockRejectedValue(new Error('磁盘空间不足'));

    const result = await runMediaGeneration({
      kind: 'image',
      prompt: '一只猫',
      modelRef: 'openai/image-model',
      deliveryMode: 'chat',
    }, 'project-1');

    expect(result.persistence).toBe('failed');
    expect(result.persistError).toBe('磁盘空间不足');
  });

  it('skips persistence without a project instead of reporting a failure', async () => {
    const result = await runMediaGeneration({
      kind: 'image',
      prompt: '一只猫',
      modelRef: 'openai/image-model',
      deliveryMode: 'chat',
    }, null);

    expect(mocks.downloadUrlAndSave).not.toHaveBeenCalled();
    expect(result.persistence).toBe('skipped');
    expect(result.url).toBe('https://cdn.example/image.png');
  });

  it('carries the audio persistence state through from the audio persister', async () => {
    mocks.persistAudioGenerationResult.mockResolvedValue({
      mediaUrl: 'blob:local/audio',
      outputUrl: 'blob:local/audio',
      persistence: 'failed',
      persistError: '写盘失败',
    });

    const result = await runMediaGeneration({
      kind: 'audio',
      prompt: '旁白',
      modelRef: 'openai/audio-model',
      deliveryMode: 'chat',
    }, 'project-1');

    expect(result.persistence).toBe('failed');
    expect(result.persistError).toBe('写盘失败');
    expect(result.sourceUrl).toBe('blob:local/audio');
  });
});

describe('retryMediaArtifactPersist', () => {
  const unsaved: MediaGenerationResult = {
    id: 'media-1',
    kind: 'image',
    deliveryMode: 'chat',
    url: 'https://cdn.example/image.png',
    sourceUrl: 'https://cdn.example/image.png',
    persistence: 'failed',
    persistError: MEDIA_PERSIST_FAILED_MESSAGE,
    prompt: '一只猫',
    modelId: 'openai/image-model',
    provider: 'openai',
    createdAt: 1,
  };

  it('re-downloads from the source url and returns a saved artifact', async () => {
    const result = await retryMediaArtifactPersist(unsaved, 'project-1');

    expect(mocks.downloadUrlAndSave).toHaveBeenCalledWith(
      'https://cdn.example/image.png',
      'project-1',
      'ai-image',
      '对话图片-media-1',
    );
    expect(result.persistence).toBe('saved');
    expect(result.persistError).toBeUndefined();
    expect(result.url).toBe('asset://对话图片.png');
    expect(result.filePath).toBe('/projects/project-1/对话图片.png');
  });

  it('throws with the underlying reason when the retry also fails', async () => {
    mocks.downloadUrlAndSave.mockRejectedValue(new Error('签名地址已过期'));

    await expect(retryMediaArtifactPersist(unsaved, 'project-1')).rejects.toThrow('签名地址已过期');
  });

  it('refuses to retry outside the desktop app', async () => {
    mocks.isTauriEnv.mockReturnValue(false);

    await expect(retryMediaArtifactPersist(unsaved, 'project-1')).rejects.toThrow('浏览器模式');
  });
});
