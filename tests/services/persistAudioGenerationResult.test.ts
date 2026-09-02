import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  persistMediaUrlToProjectData: vi.fn(),
  saveBinaryToProjectData: vi.fn(),
  isTauriEnv: vi.fn(() => true),
  resolveGeneralModel: vi.fn(),
  resolveGeneralModelConnection: vi.fn(),
  runConfiguredModelProtocol: vi.fn(),
}));

vi.mock('../../src/services/fileService', () => ({
  createMediaDataUrlBudget: () => ({
    usedBytes: 0,
    maxBytes: 128 * 1024 * 1024,
    label: '测试音频参考',
  }),
  persistMediaUrlToProjectData: mocks.persistMediaUrlToProjectData,
  saveBinaryToProjectData: mocks.saveBinaryToProjectData,
  isTauriEnv: mocks.isTauriEnv,
}));
vi.mock('../../src/services/nodeReferenceService', () => ({ resolveNodeReferences: (v: string) => v }));
vi.mock('../../src/services/comfyWorkflowService', () => ({ executeComfyUIAudioGenerate: vi.fn() }));
vi.mock('../../src/services/ai/helpers', () => ({
  resolveGeneralModel: mocks.resolveGeneralModel,
  resolveGeneralModelConnection: mocks.resolveGeneralModelConnection,
}));
vi.mock('../../src/services/ai/connectedReferenceMedia', () => ({
  collectConnectedReferenceMedia: () => ({ references: [] }),
  getMediaReferenceUrl: vi.fn(),
  getMediaReferenceUrls: () => [],
  mergeMediaReferences: () => [],
  warnIfTooManyReferences: vi.fn(),
}));
vi.mock('../../src/services/ai/promptResolver', () => ({
  collectPromptNodeMediaUrls: () => ({ references: [] }),
}));
vi.mock('../../src/services/ai/apimartGen', () => ({ executeGeneralAsyncTask: vi.fn() }));
vi.mock('../../src/services/ai/modelProtocolRuntime', () => ({
  runConfiguredModelProtocol: mocks.runConfiguredModelProtocol,
}));
vi.mock('../../src/services/ai/mediaProviderRegistry', () => ({
  mediaProviderRegistry: { getAudioAdapter: () => undefined },
}));

import {
  AUDIO_PERSIST_FAILED_MESSAGE,
  generateAudio,
  persistAudioGenerationResult,
} from '../../src/services/ai/generateAudio';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTauriEnv.mockReturnValue(true);
  mocks.persistMediaUrlToProjectData.mockResolvedValue({
    filePath: '/projects/p1/生成音频.mp3',
    assetUrl: 'asset://生成音频.mp3',
    mediaUrl: 'asset://生成音频.mp3',
    sourceUrl: 'https://cdn.example/audio.mp3',
  });
  mocks.saveBinaryToProjectData.mockResolvedValue({
    filePath: '/projects/p1/生成音频.wav',
    assetUrl: 'asset://生成音频.wav',
  });
  mocks.resolveGeneralModel.mockReturnValue({
    id: 'google-tts',
    name: 'Google TTS',
    modelId: 'gemini-3.1-flash-tts-preview',
    category: 'audio',
    providerConfigId: 'google',
    executionProfile: { preset: 'custom', protocol: {} },
  });
  mocks.resolveGeneralModelConnection.mockReturnValue({
    providerConfigId: 'google',
    apiKey: 'secret',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  });
});

describe('persistAudioGenerationResult', () => {
  it('normalizes protocol WAV data URLs to runtime bytes for reliable persistence', async () => {
    mocks.runConfiguredModelProtocol.mockResolvedValue([
      'data:audio/wav;base64,UklGRgAAAAA=',
    ]);

    const result = await generateAudio({
      prompt: '你好',
      model: 'general/google-tts',
      provider: 'general',
    });

    expect(result.format).toBe('wav');
    expect([...result.bytes ?? []]).toEqual([82, 73, 70, 70, 0, 0, 0, 0]);
  });

  it('reports saved when the remote audio lands in the project directory', async () => {
    const persisted = await persistAudioGenerationResult(
      { url: 'https://cdn.example/audio.mp3' },
      'p1',
      '生成音频',
    );

    expect(persisted.persistence).toBe('saved');
    expect(persisted.persistError).toBeUndefined();
    expect(persisted.mediaUrl).toBe('asset://生成音频.mp3');
    expect(persisted.filePath).toBe('/projects/p1/生成音频.mp3');
  });

  it('reports failed instead of passing the temporary url off as persisted', async () => {
    mocks.persistMediaUrlToProjectData.mockRejectedValue(new Error('生成媒体未能写入项目目录'));

    const persisted = await persistAudioGenerationResult(
      { url: 'https://cdn.example/audio.mp3' },
      'p1',
      '生成音频',
    );

    expect(persisted.persistence).toBe('failed');
    expect(persisted.persistError).toContain('项目目录');
    expect(persisted.mediaUrl).toBe('https://cdn.example/audio.mp3');
    expect(persisted.filePath).toBeUndefined();
  });

  it('points the persisted source at the project file instead of the temporary url', async () => {
    mocks.persistMediaUrlToProjectData.mockResolvedValueOnce({
      filePath: '/projects/p1/生成音频.mp3',
      assetUrl: 'asset://生成音频.mp3',
      mediaUrl: 'asset://生成音频.mp3',
      sourceUrl: 'asset://生成音频.mp3',
    });

    const persisted = await persistAudioGenerationResult(
      { url: 'blob:local/audio' },
      'p1',
      '生成音频',
    );

    expect(persisted.persistence).toBe('saved');
    expect(persisted.outputUrl).toBe('asset://生成音频.mp3');
    expect(persisted.sourceUrl).toBe('asset://生成音频.mp3');
  });

  it('surfaces the thrown reason from the save call', async () => {
    mocks.saveBinaryToProjectData.mockRejectedValue(new Error('磁盘只读'));

    const persisted = await persistAudioGenerationResult(
      { url: 'blob:local/audio', bytes: new Uint8Array([1, 2]), format: 'wav' },
      'p1',
      '生成音频',
    );

    expect(persisted.persistence).toBe('failed');
    expect(persisted.persistError).toBe('磁盘只读');
  });

  it('keeps the blob url alive when the save failed so a retry can still read it', async () => {
    mocks.saveBinaryToProjectData.mockResolvedValue(null);
    const revoke = vi.fn();
    vi.stubGlobal('URL', { ...URL, revokeObjectURL: revoke });

    const persisted = await persistAudioGenerationResult(
      { url: 'blob:local/audio', bytes: new Uint8Array([1, 2]), format: 'wav' },
      'p1',
      '生成音频',
    );

    expect(revoke).not.toHaveBeenCalled();
    expect(persisted.mediaUrl).toBe('blob:local/audio');
    expect(persisted.persistError).toBe(AUDIO_PERSIST_FAILED_MESSAGE);
    vi.unstubAllGlobals();
  });

  it('marks persistence skipped without a project or outside the desktop app', async () => {
    const withoutProject = await persistAudioGenerationResult(
      { url: 'https://cdn.example/audio.mp3' },
      null,
      '生成音频',
    );
    expect(withoutProject.persistence).toBe('skipped');

    mocks.isTauriEnv.mockReturnValue(false);
    const inBrowser = await persistAudioGenerationResult(
      { url: 'https://cdn.example/audio.mp3' },
      'p1',
      '生成音频',
    );
    expect(inBrowser.persistence).toBe('skipped');
    expect(mocks.persistMediaUrlToProjectData).not.toHaveBeenCalled();
  });
});
