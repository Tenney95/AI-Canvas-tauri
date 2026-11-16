import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { MediaReference, ModelExecutionProfile } from '../../src/types/aiTypes';

const mocks = vi.hoisted(() => ({
  state: {} as AppState, references: [] as MediaReference[], resolve: vi.fn(), protocol: vi.fn(), asyncTask: vi.fn(),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.state } }));
vi.mock('../../src/services/ai/providerCatalogService', () => ({ getProviderDefinition: () => undefined }));
vi.mock('../../src/services/uploadService', () => ({ resolveMediaReferenceUrl: mocks.resolve }));
vi.mock('../../src/services/fileService', () => ({
  createMediaDataUrlBudget: () => ({ usedBytes: 0, maxBytes: 128 * 1024 * 1024, label: '参考音频' }),
  isTauriEnv: () => false, persistMediaUrlToProjectData: vi.fn(), saveBinaryToProjectData: vi.fn(),
}));
vi.mock('../../src/services/ai/audioSpeechSettings', () => ({
  collectAudioSpeechReferences: () => [], resolveAudioSpeechWorkflow: () => undefined,
  stripAudioSpeechReferences: (value: string) => value,
}));
vi.mock('../../src/services/nodeReferenceService', () => ({ resolveNodeReferences: (value: string) => value }));
vi.mock('../../src/services/dramaAssetPrompt', () => ({ loadGlobalDramaAssetsForPrompt: async () => undefined }));
vi.mock('../../src/services/comfyWorkflowService', () => ({ executeComfyUIAudioGenerate: vi.fn() }));
vi.mock('../../src/services/workflowApi/workflowApiAdapter', () => ({ executeWorkflowApiMedia: vi.fn() }));
vi.mock('../../src/services/workflowExecutionService', () => ({ isRunningHubWorkflow: () => false, getCloudWorkflowPersistedOutput: vi.fn() }));
vi.mock('../../src/services/ai/providers/runninghubWorkflow', () => ({ executeRunningHubWorkflow: vi.fn() }));
vi.mock('../../src/services/ai/promptResolver', () => ({
  collectPromptNodeMediaUrls: () => ({ references: mocks.references }),
  resolvePromptWithMediaRefs: async () => ({ references: mocks.references }),
}));
vi.mock('../../src/services/ai/connectedReferenceMedia', () => ({
  collectConnectedReferenceMedia: () => ({ references: [] }),
  getMediaReferenceUrl: (reference: MediaReference) => reference.url,
  getMediaReferenceUrls: (references: MediaReference[], kind: string) => references.filter((reference) => reference.kind === kind).map((reference) => reference.url),
  mergeMediaReferences: (primary: MediaReference[], additional: MediaReference[]) => [...primary, ...additional],
  warnIfTooManyReferences: vi.fn(),
}));
vi.mock('../../src/services/ai/apimartGen', () => ({ executeGeneralAsyncTask: mocks.asyncTask }));
vi.mock('../../src/services/ai/modelProtocolRuntime', () => ({
  runConfiguredModelProtocol: mocks.protocol, retainCompletedMediaResults: (urls: string[]) => urls,
}));
vi.mock('../../src/services/ai/mediaDownloadAccess', () => ({ createMediaDownloadAccess: () => undefined }));
vi.mock('../../src/services/ai/mediaProviderRegistry', () => ({ mediaProviderRegistry: { getAudioAdapter: () => undefined } }));

import { generateAudio } from '../../src/services/ai/generateAudio';

const profile: ModelExecutionProfile = {
  preset: 'custom', protocol: { version: 2, mode: 'sync',
    submit: { method: 'POST', path: '/audio', body: { audio_urls: '{{audioUrls}}' } },
    response: { type: 'json', result: { urlPath: 'url' } },
  },
};
const params = { provider: 'general', model: 'general/voice-reference', prompt: '参考声音生成', nodeId: 'target' };
function configure(connectionId: string, catalogId: string) {
  mocks.state = {
    currentProjectId: 'audio-project', nodes: [], edges: [], workflows: [],
    config: {
      providers: { [connectionId]: { name: '参考音频连接', catalogId, apiKey: 'test-key', baseUrl: 'https://audio.example/v1' } },
      generalModels: [{ id: 'voice-reference', name: '参考声音', modelId: 'voice-reference-model', category: 'audio', providerConfigId: connectionId, executionProfile: profile }],
    },
  } as unknown as AppState;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.references = [
    { kind: 'audio', url: 'asset://localhost/reference.wav', origin: 'prompt', role: 'reference_audio' },
    { kind: 'image', url: 'https://media.example/image.png', origin: 'prompt', role: 'reference' },
    { kind: 'video', url: 'https://media.example/video.mp4', origin: 'prompt', role: 'reference' },
    { kind: 'audio', url: 'https://media.example/reference.mp3', origin: 'prompt', role: 'reference_audio' },
  ];
  mocks.resolve.mockReset().mockImplementation(async (url: string, options: { provider?: string }) => options.provider
    ? `https://private-tos.example/${url.endsWith('.wav') ? 'local.wav' : 'remote.mp3'}?signature=test`
    : 'data:audio/wav;base64,YWJj');
  mocks.protocol.mockReset().mockResolvedValue(['https://output.example/generated.wav']);
  mocks.asyncTask.mockReset().mockResolvedValue({ url: 'https://output.example/generated.wav' });
});

describe('通用音频模型参考素材的火山 TOS 路由', () => {
  it('按模型真实连接 ID 为本地及远端音频传入 publicUrl，不向协议扩充图片或视频能力', async () => {
    configure('my-ark-audio', 'volcengine');
    const signal = new AbortController().signal;
    await generateAudio(params, signal);
    expect(mocks.resolve.mock.calls).toEqual([
      ['asset://localhost/reference.wav', expect.objectContaining({ provider: 'my-ark-audio', mode: 'publicUrl', kind: 'audio', signal })],
      ['https://media.example/reference.mp3', expect.objectContaining({ provider: 'my-ark-audio', mode: 'publicUrl', kind: 'audio', signal })],
    ]);
    const variables = mocks.protocol.mock.calls[0][0].variables;
    const urls = ['https://private-tos.example/local.wav?signature=test', 'https://private-tos.example/remote.mp3?signature=test'];
    expect(variables).toMatchObject({ audioUrls: urls, audioUrl: urls[0], referenceAudioUrls: urls });
    expect(variables).not.toHaveProperty('imageUrls');
    expect(variables).not.toHaveProperty('videoUrls');
    expect(mocks.asyncTask).not.toHaveBeenCalled();
  });

  it.each(['volcengine', 'my-custom-audio'])('显式自定义连接 %s 保持原 dataUrl 传输', async (connectionId) => {
    configure(connectionId, 'custom-openai');
    await generateAudio(params);
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    for (const [, options] of mocks.resolve.mock.calls) {
      expect(options).toMatchObject({ mode: 'dataUrl', kind: 'audio', dataUrlBudget: expect.any(Object) });
      expect(options).not.toHaveProperty('provider');
    }
    expect(mocks.protocol.mock.calls[0][0].variables.referenceAudioUrls).toEqual([
      'data:audio/wav;base64,YWJj', 'data:audio/wav;base64,YWJj',
    ]);
  });

  it('未声明执行协议的通用音频路径不新增参考素材上传能力', async () => {
    configure('my-ark-audio', 'volcengine');
    mocks.state.config.generalModels![0].executionProfile = undefined;
    await generateAudio(params);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.protocol).not.toHaveBeenCalled();
    expect(mocks.asyncTask).toHaveBeenCalledOnce();
  });

  it('TOS 解析失败时沿用上游错误，不绕过上传提交音频生成', async () => {
    configure('my-ark-audio', 'volcengine');
    mocks.resolve.mockRejectedValue(new Error('请配置北京私有 TOS'));
    await expect(generateAudio(params)).rejects.toThrow('请配置北京私有 TOS');
    expect(mocks.protocol).not.toHaveBeenCalled();
    expect(mocks.asyncTask).not.toHaveBeenCalled();
  });
});
