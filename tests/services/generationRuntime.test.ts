/**
 * generationRuntime — 回归测试：media generation cancellation。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiProviderConfig, GeneralModelConfig, WorkflowDefinition } from '../../src/types';
import type { MediaTaskContext, MediaTaskReceipt } from '../../src/types/aiTypes';
import type { ChatMessage } from '../../src/types/chat';
import type { MediaTaskSnapshot, PendingTask } from '../../src/services/pollManager';

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  generateAudio: vi.fn(),
  persistAudioGenerationResult: vi.fn(),
  persistMediaUrlToProjectData: vi.fn(),
  isTauriEnv: vi.fn(() => true),
  tagGeneratedProjectAssetSafely: vi.fn(),
  bindMediaTaskContext: vi.fn<(_id: string, _context: MediaTaskContext, _observer?: (receipt: MediaTaskReceipt) => void) => () => void>(() => vi.fn()),
  registerMediaNodeOperation: vi.fn(() => vi.fn()),
  registerMediaMessageRecoveryHandler: vi.fn(),
  getPendingTasksForProject: vi.fn<() => unknown[]>(() => []),
  getMediaTaskSnapshot: vi.fn<() => readonly MediaTaskSnapshot[]>(() => []),
  getMediaTaskReceipt: vi.fn(),
  resumeMediaNodeTask: vi.fn(),
  completeMediaNodeTask: vi.fn(),
  pauseMediaTask: vi.fn(),
  updatePendingTask: vi.fn(),
  persistMessage: vi.fn(),
  persistNativeMediaOrigin: vi.fn(),
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
    workflows: [] as WorkflowDefinition[],
    messages: [] as ChatMessage[],
    updateMessage: vi.fn(),
    addMessage: vi.fn(),
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
    provider: modelRef.startsWith('runninghubwf/') ? 'runninghubwf' : modelRef.startsWith('runninghub/') ? 'runninghub' : modelRef.startsWith('general/') ? 'general' : 'openai',
    ...(modelRef.startsWith('runninghubwf/') ? { workflowId: modelRef.slice('runninghubwf/'.length) } : {}),
  }),
}));
vi.mock('../../src/services/ai/generateImage', () => ({ generateImage: mocks.generateImage }));
vi.mock('../../src/services/ai/generateVideo', () => ({ generateVideo: mocks.generateVideo }));
vi.mock('../../src/services/ai/generateAudio', () => ({
  generateAudio: mocks.generateAudio,
  persistAudioGenerationResult: mocks.persistAudioGenerationResult,
}));
vi.mock('../../src/services/fileService', () => ({
  isTransientMediaUrl: (url?: string) => Boolean(url && (/^data:/i.test(url) || /^blob:/i.test(url))),
  persistMediaUrlToProjectData: mocks.persistMediaUrlToProjectData,
  isTauriEnv: mocks.isTauriEnv,
}));
vi.mock('../../src/services/fs/generatedAssetTags', () => ({
  tagGeneratedProjectAssetSafely: mocks.tagGeneratedProjectAssetSafely,
}));
vi.mock('../../src/services/pollManager', () => ({
  hasMuseQueryIdentity: (task: { taskType?: string; taskId: string }) => task.taskType === 'muse'
    && task.taskId === 'ac655c56-b537-4c04-8913-fd150fc0e92a',
  bindMediaTaskContext: mocks.bindMediaTaskContext,
  registerMediaNodeOperation: mocks.registerMediaNodeOperation,
  registerMediaMessageRecoveryHandler: mocks.registerMediaMessageRecoveryHandler,
  getPendingTasksForProject: mocks.getPendingTasksForProject,
  getMediaTaskSnapshot: mocks.getMediaTaskSnapshot,
  getMediaTaskReceipt: mocks.getMediaTaskReceipt,
  resumeMediaNodeTask: mocks.resumeMediaNodeTask,
  completeMediaNodeTask: mocks.completeMediaNodeTask,
  pauseMediaTask: mocks.pauseMediaTask,
  updatePendingTask: mocks.updatePendingTask,
}));
vi.mock('../../src/services/chat/chatHistoryService', () => ({ persistMessage: mocks.persistMessage }));
vi.mock('../../src/services/nativeMediaOriginPersistence', () => ({ persistNativeMediaOrigin: mocks.persistNativeMediaOrigin }));

import {
  MEDIA_PERSIST_FAILED_MESSAGE,
  retryMediaArtifactPersist,
  runMediaGeneration,
  retryMediaMessageTask,
  ensureMediaMessageRecoveryHandler,
  getRecoverableMessageTask,
  getRecoverableMessageTaskSnapshot,
  deliverMediaMessageGroup,
  completeMediaMessageDelivery,
  mediaDeliveryResults,
} from '../../src/services/ai/generationRuntime';
import type { MediaGenerationResult } from '../../src/types/media';
import { imageBatchArtifactId } from '../../src/services/imageBatchService';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storeState.updateMessage.mockReset();
  mocks.storeState.addMessage.mockReset();
  mocks.completeMediaNodeTask.mockReset();
  mocks.persistMessage.mockReset();
  mocks.persistMessage.mockResolvedValue(undefined);
  mocks.updatePendingTask.mockReset();
  mocks.bindMediaTaskContext.mockReturnValue(vi.fn());
  mocks.getPendingTasksForProject.mockReturnValue([]);
  mocks.getMediaTaskSnapshot.mockReturnValue([]);
  mocks.getMediaTaskReceipt.mockReset();
  mocks.storeState.currentProjectId = 'project-1';
  Object.assign(mocks.storeState, { projectExecutionContext: undefined });
  mocks.storeState.projects = [];
  mocks.storeState.customStyles = [];
  mocks.storeState.workflows = [];
  mocks.storeState.messages = [];
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
  mocks.persistMediaUrlToProjectData.mockResolvedValue({
    filePath: '/projects/project-1/对话图片.png',
    assetUrl: 'asset://对话图片.png',
    mediaUrl: 'asset://对话图片.png',
    sourceUrl: 'https://cdn.example/image.png',
  });
});

describe('media generation cancellation', () => {
  it('未适配的直接图片模型及缺少原目的地的新对话请求在提交前失败关闭', async () => {
    Object.assign(mocks.storeState, { projectExecutionContext: { kind: 'canvas', schemaVersion: 2, modelGeneration: 1,
      projectId: 'p', projectEpoch: 0, canvasId: 'project-1', canvasEpoch: 0, canvasRevision: 0, episodeId: null, runtimeEpoch: 'run' } });
    await expect(runMediaGeneration({ kind: 'image', prompt: '猫', modelRef: 'openai/image-model', deliveryMode: 'chat' }, 'project-1'))
      .rejects.toThrow('未提交请求');
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.bindMediaTaskContext).not.toHaveBeenCalled();
  });
  it.each(['image', 'video'] as const)('passes %s download access and cancellation to persistence without adding it to the artifact', async (kind) => {
    const mediaDownloadAccess = { providerConfigId: 'relay-image', origin: 'https://relayonapi.com', auth: { type: 'bearer' as const } };
    (kind === 'image' ? mocks.generateImage : mocks.generateVideo).mockResolvedValueOnce({ url: 'https://relayonapi.com/result', mediaDownloadAccess });
    const controller = new AbortController();
    const artifact = await runMediaGeneration({ kind, prompt: '场景', modelRef: `openai/${kind}-model`, deliveryMode: 'chat' }, 'project-1', controller.signal);
    expect(mocks.persistMediaUrlToProjectData).toHaveBeenCalledWith('https://relayonapi.com/result', 'project-1', `ai-${kind}`, expect.any(String),
      { mediaDownloadAccess, signal: controller.signal });
    expect(artifact).not.toHaveProperty('mediaDownloadAccess');
  });
  it('云工作流按指定连接执行并传递参数，已保存产物不重复下载', async () => {
    mocks.storeState.workflows = [{ id: 'cloud-image', name: '云图像', category: 'ai-image', fileName: 'RH', fileContent: '', createdAt: 1, adapterType: 'runninghub', runninghub: { version: 1, kind: 'workflow', remoteId: '1904152026220003329', connectionId: 'runninghub', parameters: [] } }];
    mocks.storeState.config.providers = { runninghub: { name: 'RH', apiKey: 'secret' } };
    mocks.generateImage.mockResolvedValue({ url: 'asset://saved.png', width: 1, height: 1, runninghubOutputs: [{ url: 'asset://saved.png', filePath: 'project/saved.png', kind: 'image', sourceUrl: 'https://cdn.test/image.png' }] });
    const result = await runMediaGeneration({ kind: 'image', prompt: '猫', modelRef: 'runninghubwf/cloud-image', workflowInputs: { '3::seed': '0' }, deliveryMode: 'chat' }, 'project-1');
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'runninghubwf', workflowId: 'cloud-image', workflowInputs: { '3::seed': '0' } }), undefined);
    expect(result).toMatchObject({ url: 'asset://saved.png', persistence: 'saved', filePath: 'project/saved.png' });
    expect(mocks.persistMediaUrlToProjectData).not.toHaveBeenCalled();
    mocks.storeState.workflows[0].runninghub!.connectionId = 'runninghub-model';
    await expect(runMediaGeneration({ kind: 'image', prompt: '猫', modelRef: 'runninghubwf/cloud-image', deliveryMode: 'chat' }, 'project-1')).rejects.toThrow('模型');
  });
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
  function configureVisualModels() {
    mocks.storeState.config.providers.custom = { name: '自定义', catalogId: 'custom-openai', apiKey: 'fixture', baseUrl: 'https://gateway.example' };
    mocks.storeState.config.generalModels = [
      { id: 'image-model', name: '图片', modelId: 'image-x', category: 'image', providerConfigId: 'custom',
        imageCapability: { resolutions: ['2K'], ratios: ['1:1'], qualities: ['low', 'high'], backgrounds: ['opaque', 'transparent'] } },
      { id: 'video-model', name: '视频', modelId: 'video-x', category: 'video', providerConfigId: 'custom',
        videoCapability: { operations: ['text-to-video'], frameRates: [24, 30], supportsAudio: true,
          minDuration: 4, maxDuration: 15, automaticDurationValue: -1 } },
    ];
  }

  it('图片质量和显式接口默认背景贯通生成、结果及原任务快照', async () => {
    configureVisualModels();
    const result = await runMediaGeneration({ kind: 'image', prompt: '山谷', modelRef: 'general/image-model',
      deliveryMode: 'chat', imageQuality: 'high', imageBackground: '' }, 'project-1', undefined, 'image-node');
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({ imageQuality: 'high', imageBackground: '' }), undefined);
    expect(result.parameters).toEqual({ resolution: '2K', aspectRatio: '1:1', imageQuality: 'high', imageBackground: '' });
    expect(mocks.bindMediaTaskContext).toHaveBeenCalledWith('image-node', expect.objectContaining({
      parameters: { resolution: '2K', aspectRatio: '1:1', imageQuality: 'high', imageBackground: '' },
    }), expect.any(Function));
  });

  it('锁定模型声明的默认质量和背景，显式接口默认仍能覆盖背景默认值', async () => {
    configureVisualModels();
    const capability = mocks.storeState.config.generalModels[0].imageCapability!;
    capability.defaultQuality = 'high';
    capability.defaultBackground = 'transparent';
    const intent = { kind: 'image' as const, prompt: '山谷', modelRef: 'general/image-model', deliveryMode: 'chat' as const };
    const result = await runMediaGeneration(intent, 'project-1', undefined, 'image-node');
    expect(result.parameters).toEqual({ resolution: '2K', aspectRatio: '1:1', imageQuality: 'high', imageBackground: 'transparent' });
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({ imageQuality: 'high', imageBackground: 'transparent' }), undefined);
    capability.defaultQuality = 'low';
    capability.defaultBackground = 'opaque';
    expect(result.parameters).toMatchObject({ imageQuality: 'high', imageBackground: 'transparent' });
    const explicitDefault = await runMediaGeneration({ ...intent, imageBackground: '' }, 'project-1', undefined, 'image-node');
    expect(explicitDefault.parameters).toMatchObject({ imageQuality: 'low', imageBackground: '' });
    expect(mocks.generateImage).toHaveBeenLastCalledWith(expect.objectContaining({ imageQuality: 'low', imageBackground: '' }), undefined);
  });

  it('未声明的视频参数保留空快照，区分没有快照的旧结果', async () => {
    configureVisualModels();
    const result = await runMediaGeneration({ kind: 'video', prompt: '镜头', modelRef: 'general/video-model',
      deliveryMode: 'chat' }, 'project-1', undefined, 'video-node');
    expect(result.parameters).toEqual({});
    expect(mocks.bindMediaTaskContext).toHaveBeenCalledWith('video-node', expect.objectContaining({ parameters: {} }), expect.any(Function));
  });

  it.each([
    { field: 'imageQuality', value: 'sk-example-secret' },
    { field: 'imageBackground', value: 'Bearer example-secret' },
    { field: 'imageQuality', value: 'https://private.example/key' },
    { field: 'imageBackground', value: 'C:\\private\\secret' },
  ])('拒绝敏感或路径格式的 $field，不回显参数，也不提交', async ({ field, value }) => {
    configureVisualModels();
    const error = await runMediaGeneration({ kind: 'image', prompt: '山谷', modelRef: 'general/image-model',
      deliveryMode: 'chat', [field]: value }, 'project-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('格式无效');
    expect((error as Error).message).not.toContain(value);
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.bindMediaTaskContext).not.toHaveBeenCalled();
  });

  it('项目默认分辨率是路径时在生成前拒绝且不回显路径', async () => {
    configureVisualModels();
    const path = 'D:\\private\\image.png';
    mocks.storeState.projects = [{ id: 'project-1', settings: { generation: { imageSize: path } } }];
    const error = await runMediaGeneration({ kind: 'image', prompt: '山谷', modelRef: 'general/image-model',
      deliveryMode: 'chat' }, 'project-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('格式无效');
    expect((error as Error).message).not.toContain(path);
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it('合法的厂商枚举、比例和小数分辨率仍可使用', async () => {
    configureVisualModels();
    const capability = mocks.storeState.config.generalModels[0].imageCapability!;
    capability.qualities = ['高清（电影）'];
    capability.resolutions = ['0.5K'];
    capability.ratios = ['16/9'];
    mocks.storeState.projects = [{ id: 'project-1', settings: { generation: { imageSize: '0.5K', imageAspectRatio: '16/9' } } }];
    const result = await runMediaGeneration({ kind: 'image', prompt: '山谷', modelRef: 'general/image-model',
      deliveryMode: 'chat', imageQuality: '高清（电影）', imageBackground: '' }, 'project-1');
    expect(result.parameters).toMatchObject({ resolution: '0.5K', aspectRatio: '16/9', imageQuality: '高清（电影）', imageBackground: '' });
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({ imageSize: '0.5K', aspectRatio: '16/9', imageQuality: '高清（电影）' }), undefined);
  });

  it('图片请求锁定项目比例和分辨率，生成期间项目设置变化不会改变结果或任务快照', async () => {
    configureVisualModels();
    mocks.storeState.projects = [{ id: 'project-1', settings: { generation: { imageSize: '2K', imageAspectRatio: '9:16' } } }];
    mocks.generateImage.mockImplementation(async () => {
      mocks.storeState.projects = [{ id: 'project-1', settings: { generation: { imageSize: '4K', imageAspectRatio: '1:1' } } }];
      return { url: 'https://cdn.example/image.png', width: 1, height: 1 };
    });
    const result = await runMediaGeneration({ kind: 'image', prompt: '山谷', modelRef: 'general/image-model',
      deliveryMode: 'chat', imageQuality: 'high' }, 'project-1', undefined, 'image-node');
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({ imageSize: '2K', aspectRatio: '9:16', imageQuality: 'high' }), undefined);
    expect(result.parameters).toEqual({ resolution: '2K', aspectRatio: '9:16', imageQuality: 'high' });
    expect(mocks.bindMediaTaskContext).toHaveBeenCalledWith('image-node', expect.objectContaining({ parameters: result.parameters }), expect.any(Function));
  });

  it('图片省略比例时不从作品根借默认值，本集占位与实际请求均使用1:1', async () => {
    configureVisualModels();
    mocks.storeState.projects = [
      { id: 'owner-project', settings: { generation: { imageAspectRatio: '9:16', imageSize: '4K' } } },
      { id: 'project-1', parentId: 'owner-project' },
    ];
    const result = await runMediaGeneration({ kind: 'image', prompt: '山谷', modelRef: 'general/image-model',
      deliveryMode: 'chat' }, 'project-1');
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({ imageSize: '2K', aspectRatio: '1:1' }), undefined);
    expect(result.parameters).toMatchObject({ resolution: '2K', aspectRatio: '1:1' });
  });

  it('视频自动时长、帧率和关闭音轨原样传递并保存在原任务快照', async () => {
    configureVisualModels();
    const result = await runMediaGeneration({ kind: 'video', prompt: '移动镜头', modelRef: 'general/video-model',
      deliveryMode: 'both', aspectRatio: '9:16', resolution: '720p', duration: -1, videoFps: 24, generateAudio: false },
    'project-1', undefined, 'video-node');
    expect(mocks.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ seedanceRatio: '9:16', seedanceResolution: '720p',
      seedanceDuration: -1, videoFps: 24, generateAudio: false }), undefined);
    expect(result.parameters).toEqual({ aspectRatio: '9:16', resolution: '720p', duration: -1, videoFps: 24, generateAudio: false });
    expect(mocks.bindMediaTaskContext).toHaveBeenCalledWith('video-node', expect.objectContaining({ parameters: result.parameters }), expect.any(Function));
  });

  it('不支持的显式质量、帧率、音轨和自动时长在调用厂商前拒绝', async () => {
    configureVisualModels();
    await expect(runMediaGeneration({ kind: 'image', prompt: '山谷', modelRef: 'general/image-model', deliveryMode: 'chat', imageQuality: 'max' }, 'project-1')).rejects.toThrow('质量');
    await expect(runMediaGeneration({ kind: 'video', prompt: '镜头', modelRef: 'general/video-model', deliveryMode: 'chat', videoFps: 60 }, 'project-1')).rejects.toThrow('帧率');
    await expect(runMediaGeneration({ kind: 'video', prompt: '镜头', modelRef: 'general/video-model', deliveryMode: 'chat', duration: -2 }, 'project-1')).rejects.toThrow('自动时长');
    mocks.storeState.config.generalModels[1].videoCapability!.supportsAudio = false;
    await expect(runMediaGeneration({ kind: 'video', prompt: '镜头', modelRef: 'general/video-model', deliveryMode: 'chat', generateAudio: false }, 'project-1')).rejects.toThrow('音轨');
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.generateVideo).not.toHaveBeenCalled();
  });

  it('协议固定背景时拒绝接口默认选择，避免结果参数与真实请求不一致', async () => {
    configureVisualModels();
    mocks.storeState.config.generalModels[0].executionProfile = { preset: 'custom', protocol: {
      version: 2, mode: 'sync', submit: { method: 'POST', path: '/images',
        body: { model: '{{model}}', prompt: '{{prompt}}', background: 'opaque' } },
      response: { type: 'json', result: { urlPath: 'data.0.url' } },
    } };
    await expect(runMediaGeneration({ kind: 'image', prompt: '山谷', modelRef: 'general/image-model',
      deliveryMode: 'chat', imageBackground: '' }, 'project-1')).rejects.toThrow('背景由协议固定');
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.bindMediaTaskContext).not.toHaveBeenCalled();
  });

  it('passes selected general speech parameters through to the original canvas and message execution', async () => {
    mocks.storeState.config.providers.libapi = { name: 'LibAPI', apiKey: 'fixture', baseUrl: 'https://libapi.cc/v1' };
    mocks.storeState.config.generalModels = [{ id: 'audio-libapi', name: 'LibAPI TTS', modelId: 'speech-2.8',
      category: 'audio', providerConfigId: 'libapi' }];
    const context = { projectId: 'project-1', conversationId: 'speech-chat', messageId: 'speech-message', deliveryMode: 'both' as const };

    await runMediaGeneration({ kind: 'audio', prompt: '欢迎回来', modelRef: 'general/audio-libapi',
      deliveryMode: 'both', audioPurpose: 'speech', audioVoice: 'Chinese_Female_01', audioFormat: 'mp3', audioSpeed: 1.25,
    }, 'project-1', undefined, 'audio-node', context);

    expect(mocks.generateAudio).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'general', model: 'general/audio-libapi', nodeId: 'audio-node',
      audioVoice: 'Chinese_Female_01', audioFormat: 'mp3', audioSpeed: 1.25, runninghubTaskContext: context,
    }), undefined);
  });

  it('passes music title and literal lyrics for a message-only generation without RunningHub parameters', async () => {
    mocks.storeState.config.providers.libapi = { name: 'LibAPI', apiKey: 'fixture', baseUrl: 'https://libapi.cc/v1' };
    mocks.storeState.config.generalModels = [{ id: 'audio-libapi-music', name: 'LibAPI Music', modelId: 'music',
      category: 'audio', providerConfigId: 'libapi' }];

    await runMediaGeneration({ kind: 'audio', prompt: '轻柔民谣', modelRef: 'general/audio-libapi-music',
      deliveryMode: 'chat', audioPurpose: 'music', musicTitle: '回家', musicLyrics: '灯火等着我\n沿着路慢慢走',
    }, 'project-1');

    expect(mocks.generateAudio).toHaveBeenCalledWith(expect.objectContaining({
      model: 'general/audio-libapi-music', musicTitle: '回家', musicLyrics: '灯火等着我\n沿着路慢慢走',
    }), undefined);
    expect(mocks.generateAudio.mock.calls[0][0].runninghubModelParameters).toBeUndefined();
  });

  it('rejects audio controls on image generation before calling any media provider', async () => {
    await expect(runMediaGeneration({ kind: 'image', prompt: '山谷', modelRef: 'openai/image-model',
      deliveryMode: 'chat', audioVoice: 'Zephyr',
    }, 'project-1')).rejects.toThrow('音频参数只能用于音频生成');
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.generateAudio).not.toHaveBeenCalled();
  });

  it('RunningHub 使用专属参数与原节点，不注入项目的其他视频默认值', async () => {
    mocks.storeState.config.providers['runninghub-model'] = { name: 'RH', apiKey: 'fake' };
    mocks.storeState.projects = [{ id: 'project-1', settings: { generation: { videoAspectRatio: '16:9', videoResolution: '1080p', videoDuration: 10 } } }];
    const context = { projectId: 'project-1', conversationId: 'c1', messageId: 'm1', deliveryMode: 'both' as const };
    await runMediaGeneration({ kind: 'video', prompt: '镜头移动', modelRef: 'runninghub/minimax/h3-max-turbo/image-to-video', deliveryMode: 'both', runninghubModelParameters: { duration: '15', firstFrameUrl: 'https://input.test/ref.png' } }, 'project-1', undefined, 'n1', context);
    expect(mocks.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ provider: 'runninghub', nodeId: 'n1', runninghubTaskContext: context, runninghubModelParameters: { duration: '15', firstFrameUrl: 'https://input.test/ref.png' }, seedanceDuration: undefined, seedanceResolution: undefined, seedanceRatio: undefined }), undefined);
    await expect(runMediaGeneration({ kind: 'video', prompt: '镜头移动', modelRef: 'runninghub/minimax/h3-max-turbo/image-to-video', deliveryMode: 'chat', duration: 5, runninghubModelParameters: { duration: '15' } }, 'project-1')).rejects.toThrow('冲突');
  });
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
    mocks.persistMediaUrlToProjectData.mockResolvedValue(null);

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
    mocks.persistMediaUrlToProjectData.mockRejectedValue(new Error('磁盘空间不足'));

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

    expect(mocks.persistMediaUrlToProjectData).not.toHaveBeenCalled();
    expect(result.persistence).toBe('skipped');
    expect(result.url).toBe('https://cdn.example/image.png');
  });

  it('replaces an inline custom-provider result with local references only', async () => {
    mocks.generateImage.mockResolvedValue({
      url: 'data:image/png;base64,AQID',
      width: 1,
      height: 1,
    });
    mocks.persistMediaUrlToProjectData.mockResolvedValue({
      filePath: '/projects/project-1/对话图片.png',
      assetUrl: 'asset://对话图片.png',
      mediaUrl: 'asset://对话图片.png',
      sourceUrl: 'asset://对话图片.png',
    });

    const result = await runMediaGeneration({
      kind: 'image',
      prompt: '一只猫',
      modelRef: 'openai/image-model',
      deliveryMode: 'chat',
    }, 'project-1');

    expect(result.url).toBe('asset://对话图片.png');
    expect(result.sourceUrl).toBe('asset://对话图片.png');
    expect(JSON.stringify(result)).not.toContain('data:image');
  });

  it('fails closed when an inline result cannot be written to the project', async () => {
    mocks.generateVideo.mockResolvedValue({ url: 'data:video/mp4;base64,AQID' });
    mocks.persistMediaUrlToProjectData.mockRejectedValue(new Error('磁盘空间不足'));

    await expect(runMediaGeneration({
      kind: 'video',
      prompt: '一段风景',
      modelRef: 'openai/video-model',
      deliveryMode: 'chat',
    }, 'project-1')).rejects.toThrow('磁盘空间不足');
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

    expect(mocks.persistMediaUrlToProjectData).toHaveBeenCalledWith(
      'https://cdn.example/image.png',
      'project-1',
      'ai-image',
      '对话图片-media-1',
      { mediaDownloadAccess: undefined, signal: undefined },
    );
    expect(result.persistence).toBe('saved');
    expect(result.persistError).toBeUndefined();
    expect(result.url).toBe('asset://对话图片.png');
    expect(result.filePath).toBe('/projects/project-1/对话图片.png');
  });

  it('reuses only the exact pending receipt download access when saving the original artifact', async () => {
    const receipt = { projectId: 'project-1', nodeId: 'tracking', taskId: 'original', attemptId: 'attempt-1' };
    const mediaDownloadAccess = { providerConfigId: 'relay-image', origin: 'https://relayonapi.com', auth: { type: 'bearer' as const } };
    mocks.getPendingTasksForProject.mockReturnValue([
      { ...receipt, attemptId: 'other-attempt', mediaDownloadAccess: { ...mediaDownloadAccess, providerConfigId: 'other' } },
      { ...receipt, mediaDownloadAccess },
    ]);
    await retryMediaArtifactPersist({ ...unsaved, taskReceipt: receipt }, 'project-1');
    expect(mocks.persistMediaUrlToProjectData).toHaveBeenLastCalledWith(unsaved.sourceUrl, 'project-1', 'ai-image', '对话图片-media-1',
      { mediaDownloadAccess, signal: undefined });
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it('throws with the underlying reason when the retry also fails', async () => {
    mocks.persistMediaUrlToProjectData.mockRejectedValue(new Error('签名地址已过期'));

    await expect(retryMediaArtifactPersist(unsaved, 'project-1')).rejects.toThrow('签名地址已过期');
  });

  it('refuses to retry outside the desktop app', async () => {
    mocks.isTauriEnv.mockReturnValue(false);

    await expect(retryMediaArtifactPersist(unsaved, 'project-1')).rejects.toThrow('浏览器模式');
  });
});

describe('async media task identity', () => {
  it('保存同一作业全部四张候选，运行期分组不进入单产物消息', async () => {
    const receipt = { projectId: 'project-1', nodeId: 'mj-tracking', taskId: 'mj-original', attemptId: 'mj-attempt' };
    const urls = Array.from({ length: 4 }, (_, index) => `https://cdn.example/mj-${index}.png`);
    mocks.generateImage.mockResolvedValue({ url: urls[0], width: 1024, height: 1024, taskReceipt: receipt,
      expectedOutputCount: 4, additionalResults: urls.slice(1).map((url) => ({ url, width: 1024, height: 1024 })) });
    mocks.persistMediaUrlToProjectData.mockImplementation(async (url: string, _project: string, _kind: string, name: string) => ({
      mediaUrl: `asset://${name}.png`, sourceUrl: url, filePath: `${name}.png`,
    }));
    const delivery = await runMediaGeneration({ kind: 'image', prompt: '猫', modelRef: 'openai/image-model', deliveryMode: 'chat' }, 'project-1');
    const artifacts = mediaDeliveryResults(delivery);
    expect(artifacts).toHaveLength(4);
    expect(artifacts.map((artifact) => artifact.id)).toEqual(urls.map((_, index) => imageBatchArtifactId(receipt, index)));
    expect(artifacts.map((artifact) => artifact.sourceUrl)).toEqual(urls);
    expect(artifacts.every((artifact) => artifact.persistence === 'saved')).toBe(true);
    expect(artifacts.every((artifact) => !('additionalResults' in artifact) && !('expectedOutputCount' in artifact))).toBe(true);
    expect(mocks.persistMediaUrlToProjectData).toHaveBeenCalledTimes(4);
    expect(mocks.generateImage).toHaveBeenCalledOnce();
    expect(mocks.completeMediaNodeTask).not.toHaveBeenCalled();
  });

  it('固定四候选只返回第一张时仍使用稳定槽身份并保留其余待交付状态', async () => {
    const receipt = { projectId: 'project-1', nodeId: 'mj-tracking', taskId: 'mj-original', attemptId: 'mj-attempt' };
    mocks.generateImage.mockResolvedValue({ url: 'https://cdn.example/mj-first.png', width: 1024, height: 1024,
      expectedOutputCount: 4, taskReceipt: receipt });
    const delivery = await runMediaGeneration({ kind: 'image', prompt: '猫', modelRef: 'openai/image-model', deliveryMode: 'chat' }, 'project-1');
    expect(delivery.id).toBe(imageBatchArtifactId(receipt, 0));
    expect(delivery.expectedOutputCount).toBe(4);
    expect(delivery.additionalResults).toEqual([]);
    expect(mocks.persistMediaUrlToProjectData).toHaveBeenCalledWith('https://cdn.example/mj-first.png', 'project-1', 'ai-image',
      `对话图片-${imageBatchArtifactId(receipt, 0)}`, { mediaDownloadAccess: undefined, signal: undefined });
    expect(mocks.completeMediaNodeTask).not.toHaveBeenCalled();
    expect(mocks.generateImage).toHaveBeenCalledOnce();
  });

  it('没有远端任务的Base64候选保存失败也保留整组，继续处理后续候选', async () => {
    const urls = ['AAAA', 'AAAB', 'AAAC', 'AAAD'].map((data) => `data:image/png;base64,${data}`);
    mocks.generateImage.mockResolvedValue({ url: urls[0], width: 1024, height: 1024, expectedOutputCount: 4,
      additionalResults: urls.slice(1).map((url) => ({ url, width: 1024, height: 1024 })) });
    let saves = 0;
    mocks.persistMediaUrlToProjectData.mockImplementation(async (url: string) => {
      saves += 1;
      if (saves === 3) throw new Error('disk full');
      return { mediaUrl: `asset://candidate-${saves}.png`, sourceUrl: url, filePath: `candidate-${saves}.png` };
    });
    const delivery = await runMediaGeneration({ kind: 'image', prompt: '猫', modelRef: 'openai/image-model', deliveryMode: 'chat' }, 'project-1');
    expect(mediaDeliveryResults(delivery).map((artifact) => artifact.persistence)).toEqual(['saved', 'saved', 'failed', 'saved']);
    expect(mediaDeliveryResults(delivery).map((artifact) => artifact.sourceUrl)).toEqual(urls);
    expect(mocks.persistMediaUrlToProjectData).toHaveBeenCalledTimes(4);
    expect(delivery.taskReceipt).toBeUndefined();
    expect(mocks.generateImage).toHaveBeenCalledOnce();
  });

  it('多候选保存中取消会保留已保存项和未保存候选，不补交生成', async () => {
    const controller = new AbortController();
    const urls = ['AAAA', 'AAAB', 'AAAC', 'AAAD'].map((data) => `data:image/png;base64,${data}`);
    mocks.generateImage.mockResolvedValue({ url: urls[0], width: 1024, height: 1024, expectedOutputCount: 4,
      additionalResults: urls.slice(1).map((url) => ({ url, width: 1024, height: 1024 })) });
    let saves = 0;
    mocks.persistMediaUrlToProjectData.mockImplementation(async (url: string) => {
      saves += 1;
      if (saves === 2) controller.abort();
      return { mediaUrl: `asset://candidate-${saves}.png`, sourceUrl: url, filePath: `candidate-${saves}.png` };
    });
    const delivery = await runMediaGeneration({ kind: 'image', prompt: '猫', modelRef: 'openai/image-model', deliveryMode: 'chat' }, 'project-1', controller.signal);
    expect(mediaDeliveryResults(delivery).map((artifact) => artifact.persistence)).toEqual(['saved', 'saved', 'failed', 'failed']);
    expect(mediaDeliveryResults(delivery).map((artifact) => artifact.sourceUrl)).toEqual(urls);
    expect(mocks.persistMediaUrlToProjectData).toHaveBeenCalledTimes(2);
    expect(mocks.generateImage).toHaveBeenCalledOnce();
  });

  it('uses detached message props and exact project/conversation/attempt receipts for the pure display snapshot', () => {
    const receipt = { projectId: 'project-1', nodeId: 'original-node', taskId: 'original-task', attemptId: 'original-attempt' };
    const message: ChatMessage = { id: 'child-message', conversationId: 'conversation-1', role: 'assistant', content: '', timestamp: 1,
      status: 'done', mediaResult: { id: 'child-image', kind: 'image', taskReceipt: receipt, deliveryMode: 'chat',
        url: 'asset://image', sourceUrl: 'https://cdn.example/image.png', persistence: 'failed',
        prompt: '', modelId: 'image-model', provider: 'general', createdAt: 1 } };
    const task: MediaTaskSnapshot = { ...receipt, nodeId: 'recovery-node', submitted: true, expectedImageOutputs: 4,
      imageOutputNodeIds: [receipt.nodeId], mediaContext: { conversationId: 'conversation-1', messageId: 'parent-message' },
      mediaRecoveryState: 'delivery_pending', historyDownloadPending: true };
    mocks.getMediaTaskSnapshot.mockReturnValue([task]);
    // 独立窗口没有把消息写入本地 Store，展示仍从当前消息回执定位原作业。
    expect(mocks.storeState.messages).toEqual([]);
    expect(getRecoverableMessageTaskSnapshot(message, 'project-1')).toBe(task);
    expect(getRecoverableMessageTaskSnapshot(message, 'project-1')).toBe(task);
    expect(getRecoverableMessageTaskSnapshot(message, 'other-project')).toBeUndefined();
    expect(getRecoverableMessageTaskSnapshot({ ...message, conversationId: 'other-conversation' }, 'project-1')).toBeUndefined();
    for (const patch of [{ attemptId: 'other-attempt' }, { imageOutputNodeIds: ['unrelated-node'] }, { expectedImageOutputs: 1 }]) {
      mocks.getMediaTaskSnapshot.mockReturnValue([{ ...task, ...patch }]);
      expect(getRecoverableMessageTaskSnapshot(message, 'project-1')).toBeUndefined();
    }
    expect(mocks.getPendingTasksForProject).not.toHaveBeenCalled();
    expect(mocks.resumeMediaNodeTask).not.toHaveBeenCalled();
  });

  it('第三张保存失败时保留其他三张和整组回执，子图可定位同一原任务', async () => {
    const receipt = { projectId: 'project-1', nodeId: 'mj-tracking', taskId: 'mj-original', attemptId: 'mj-attempt' };
    const task: PendingTask = { ...receipt, nodeType: 'ai-image', provider: 'general', taskType: 'custom-protocol',
      submitted: true, batchCount: 4, expectedImageOutputs: 4, mediaContext: { projectId: 'project-1', conversationId: 'conversation-1',
        messageId: 'mj-message', deliveryMode: 'message' } };
    mocks.getPendingTasksForProject.mockReturnValue([task]);
    mocks.storeState.messages = [{ id: 'mj-message', conversationId: 'conversation-1', role: 'assistant', content: '', timestamp: 1, status: 'done' }];
    mocks.storeState.updateMessage.mockImplementation((id: string, patch: Partial<ChatMessage>) => {
      mocks.storeState.messages = mocks.storeState.messages.map((message) => message.id === id ? { ...message, ...patch } : message);
    });
    mocks.storeState.addMessage.mockImplementation((message: ChatMessage) => { mocks.storeState.messages.push(message); });
    const artifacts: MediaGenerationResult[] = Array.from({ length: 4 }, (_, index) => ({
      id: imageBatchArtifactId(receipt, index), kind: 'image', taskReceipt: receipt, deliveryMode: 'chat',
      url: `asset://mj-${index}.png`, sourceUrl: `https://cdn.example/mj-${index}.png`,
      persistence: index === 2 ? 'failed' : 'saved', filePath: index === 2 ? undefined : `mj-${index}.png`,
      prompt: '猫', provider: 'general', modelId: 'general/mj', createdAt: 1,
    }));
    const delivered = await deliverMediaMessageGroup('mj-message', { ...artifacts[0], expectedOutputCount: 4, additionalResults: artifacts.slice(1) });
    expect(delivered.complete).toBe(false);
    expect(mocks.storeState.messages).toHaveLength(4);
    expect(mocks.storeState.messages.map((message) => message.mediaResult?.id)).toEqual(artifacts.map((artifact) => artifact.id));
    expect(mocks.persistMessage).toHaveBeenCalledTimes(4);
    const childMessage = mocks.storeState.messages[2];
    expect(getRecoverableMessageTask(childMessage.id)).toBe(task);
    expect(mocks.completeMediaNodeTask).not.toHaveBeenCalled();
    const moved = { ...task, nodeId: 'recovery-node', imageOutputNodeIds: ['first-node', receipt.nodeId] };
    mocks.getPendingTasksForProject.mockReturnValue([moved]);
    expect(getRecoverableMessageTask(childMessage.id)).toBe(moved);
    mocks.getPendingTasksForProject.mockReturnValue([{ ...moved, imageOutputNodeIds: ['unrelated-node'] }]);
    expect(getRecoverableMessageTask(childMessage.id)).toBeUndefined();
    const differentAttempt = { ...task, attemptId: 'new-attempt' };
    mocks.getPendingTasksForProject.mockReturnValue([differentAttempt]);
    expect(getRecoverableMessageTask(childMessage.id)).toBeUndefined();
  });

  it('从任何子图确认交付前都必须持久化同一作业全部四条消息', async () => {
    const receipt = { projectId: 'project-1', nodeId: 'mj-tracking', taskId: 'mj-original', attemptId: 'mj-attempt' };
    const task: PendingTask = { ...receipt, nodeType: 'ai-image', provider: 'general', taskType: 'custom-protocol',
      submitted: true, batchCount: 4, expectedImageOutputs: 4, mediaContext: { projectId: 'project-1', conversationId: 'conversation-1',
        messageId: 'mj-message', deliveryMode: 'message' } };
    mocks.getPendingTasksForProject.mockReturnValue([task]);
    mocks.storeState.messages = Array.from({ length: 4 }, (_, index): ChatMessage => ({ id: `mj-${index}`,
      conversationId: 'conversation-1', role: 'assistant', content: '', timestamp: 1, status: 'done',
      mediaResult: { id: imageBatchArtifactId(receipt, index), kind: 'image', taskReceipt: receipt, deliveryMode: 'chat',
        url: `asset://mj-${index}.png`, sourceUrl: `https://cdn.example/mj-${index}.png`, persistence: 'saved',
        prompt: '猫', provider: 'general', modelId: 'general/mj', createdAt: 1 } }));
    mocks.persistMessage.mockRejectedValueOnce(new Error('history unavailable'));
    await completeMediaMessageDelivery('mj-2', mocks.storeState.messages[2].mediaResult!, true);
    expect(mocks.completeMediaNodeTask).not.toHaveBeenCalled();
    mocks.persistMessage.mockResolvedValue(undefined);
    await completeMediaMessageDelivery('mj-2', mocks.storeState.messages[2].mediaResult!, true);
    expect(mocks.completeMediaNodeTask).toHaveBeenCalledWith(receipt);
    expect(mocks.persistMessage.mock.calls.slice(-4).map(([message]) => message.id)).toEqual(['mj-0', 'mj-1', 'mj-2', 'mj-3']);
  });

  it('续存四图只重取失败项，不重新生成或新增重复候选消息', async () => {
    const receipt = { projectId: 'project-1', nodeId: 'mj-tracking', taskId: 'mj-original', attemptId: 'mj-attempt' };
    const task: PendingTask = { ...receipt, nodeId: 'second-recovery-node', imageOutputNodeIds: [receipt.nodeId, 'first-recovery-node'],
      nodeType: 'ai-image', provider: 'general', taskType: 'custom-protocol',
      submitted: true, batchCount: 4, expectedImageOutputs: 4, mediaContext: { projectId: 'project-1', conversationId: 'conversation-1',
        messageId: 'mj-message', deliveryMode: 'message' } };
    mocks.getPendingTasksForProject.mockReturnValue([task]);
    const urls = Array.from({ length: 4 }, (_, index) => `https://cdn.example/mj-${index}.png`);
    mocks.storeState.messages = urls.map((sourceUrl, index): ChatMessage => ({
      id: index === 0 ? 'mj-message' : `media-output-${imageBatchArtifactId(receipt, index)}`,
      conversationId: 'conversation-1', role: 'assistant', content: '', timestamp: 1, status: 'done',
      mediaResult: { id: imageBatchArtifactId(receipt, index), kind: 'image', deliveryMode: 'chat',
        taskReceipt: index === 1 ? { ...receipt, nodeId: 'first-recovery-node' } : receipt,
        url: `asset://mj-${index}.png`, sourceUrl, filePath: index === 2 ? undefined : `mj-${index}.png`,
        persistence: index === 2 ? 'failed' : 'saved', prompt: '猫', modelId: 'general/mj', provider: 'general', createdAt: 1 },
    }));
    mocks.storeState.updateMessage.mockImplementation((id: string, patch: Partial<ChatMessage>) => {
      mocks.storeState.messages = mocks.storeState.messages.map((message) => message.id === id ? { ...message, ...patch } : message);
    });
    mocks.storeState.addMessage.mockImplementation((message: ChatMessage) => { mocks.storeState.messages.push(message); });
    mocks.completeMediaNodeTask.mockImplementation(() => { mocks.getPendingTasksForProject.mockReturnValue([]); });
    ensureMediaMessageRecoveryHandler();
    const handler = mocks.registerMediaMessageRecoveryHandler.mock.calls.at(-1)![0] as
      (savedTask: PendingTask, resultUrls: string[]) => Promise<void>;
    await handler(task, urls);
    expect(mocks.persistMediaUrlToProjectData).toHaveBeenCalledOnce();
    expect(mocks.persistMediaUrlToProjectData.mock.calls[0][0]).toBe(urls[2]);
    expect(mocks.storeState.messages).toHaveLength(4);
    expect(mocks.storeState.messages.every((message) => message.mediaResult?.taskReceipt?.nodeId === task.nodeId)).toBe(true);
    expect(mocks.storeState.addMessage).not.toHaveBeenCalled();
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.completeMediaNodeTask).toHaveBeenCalledOnce();
  });

  it('旧任务追加恢复消息后永久脱离已被新结果占用的画布目标', async () => {
    const receipt = { projectId: 'project-1', nodeId: 'reused-node', taskId: 'old-task', attemptId: 'old-attempt' };
    const task: PendingTask = { ...receipt, nodeType: 'ai-image', provider: 'general', taskType: 'custom-protocol',
      submitted: true, batchCount: 4, expectedImageOutputs: 4, mediaContext: { projectId: 'project-1', conversationId: 'conversation-1',
        messageId: 'original-message', deliveryMode: 'node+message', canvasNodeId: 'reused-node' } };
    const newArtifact: MediaGenerationResult = { id: 'new-artifact', kind: 'image', deliveryMode: 'both',
      url: 'asset://new.png', sourceUrl: 'https://cdn.example/new.png', filePath: 'new.png', persistence: 'saved',
      prompt: '新请求提示词', modelId: 'general/new-model', provider: 'general', createdAt: 1 };
    mocks.storeState.messages = [{ id: 'original-message', conversationId: 'conversation-1', role: 'assistant', content: '',
      timestamp: 1, status: 'done', mediaResult: newArtifact }, {
      id: `media-output-${imageBatchArtifactId(receipt, 1)}`, conversationId: 'conversation-1', role: 'assistant', content: '',
      timestamp: 1, status: 'done', mediaResult: { ...newArtifact, id: imageBatchArtifactId(receipt, 1), taskReceipt: receipt,
        prompt: '', url: 'asset://old-saved.png', sourceUrl: 'https://cdn.example/old-1.png', filePath: 'old-saved.png' },
    }];
    mocks.getPendingTasksForProject.mockReturnValue([task]);
    mocks.storeState.updateMessage.mockImplementation((id: string, patch: Partial<ChatMessage>) => {
      mocks.storeState.messages = mocks.storeState.messages.map((message) => message.id === id ? { ...message, ...patch } : message);
    });
    mocks.storeState.addMessage.mockImplementation((message: ChatMessage) => { mocks.storeState.messages.push(message); });
    mocks.updatePendingTask.mockImplementation((_nodeId: string, patch: Partial<PendingTask>) => { Object.assign(task, patch); });
    let saves = 0;
    mocks.persistMediaUrlToProjectData.mockImplementation(async (url: string) => {
      saves += 1;
      if (saves === 2) throw new Error('disk unavailable');
      return { mediaUrl: `asset://old-${saves}.png`, sourceUrl: url, filePath: `old-${saves}.png` };
    });
    ensureMediaMessageRecoveryHandler();
    const handler = mocks.registerMediaMessageRecoveryHandler.mock.calls.at(-1)![0] as
      (savedTask: PendingTask, resultUrls: string[]) => Promise<void>;
    const urls = Array.from({ length: 4 }, (_, index) => `https://cdn.example/old-${index}.png`);
    await expect(handler(task, urls)).rejects.toThrow('原结果已保留');
    expect(task.mediaContext).toMatchObject({ deliveryMode: 'message', canvasNodeId: undefined });
    expect(mocks.storeState.messages.find((message) => message.id === 'original-message')?.mediaResult).toBe(newArtifact);
    mocks.completeMediaNodeTask.mockImplementation(() => { mocks.getPendingTasksForProject.mockReturnValue([]); });
    await handler(task, urls);
    expect(mocks.storeState.messages).toHaveLength(5);
    expect(mocks.storeState.messages.filter((message) => message.id !== 'original-message')
      .every((message) => message.mediaResult?.deliveryMode === 'chat' && message.mediaResult?.prompt === '')).toBe(true);
    expect(mocks.storeState.messages.find((message) => message.id === 'original-message')?.mediaResult).toBe(newArtifact);
    expect(mocks.persistMediaUrlToProjectData).toHaveBeenCalledTimes(4);
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.completeMediaNodeTask).toHaveBeenCalledOnce();
  });

  it('图片原任务恢复时沿用提交时的分辨率和比例，而不是当前项目默认', async () => {
    const parameters = { resolution: '2K', aspectRatio: '9:16', imageQuality: 'high', imageBackground: 'transparent' };
    const task: PendingTask = { projectId: 'project-1', nodeId: 'image-tracking', nodeType: 'ai-image',
      provider: 'general', taskType: 'custom-protocol', submitted: true, taskId: 'image-task', attemptId: 'image-attempt',
      mediaContext: { projectId: 'project-1', conversationId: 'conversation-1', messageId: 'message-1', deliveryMode: 'message',
        modelId: 'general/image-model', parameters } };
    mocks.storeState.projects = [{ id: 'project-1', settings: { generation: { imageSize: '4K', imageAspectRatio: '1:1' } } }];
    mocks.storeState.messages = [{ id: 'message-1', conversationId: 'conversation-1', role: 'assistant',
      content: '', timestamp: 1, status: 'done', mediaStatus: 'paused' }];
    mocks.getPendingTasksForProject.mockReturnValue([task]);
    ensureMediaMessageRecoveryHandler();
    const handler = mocks.registerMediaMessageRecoveryHandler.mock.calls.at(-1)![0] as
      (savedTask: PendingTask, urls: string[]) => Promise<void>;
    await handler(task, ['https://cdn.example/image.png']);
    expect(mocks.storeState.updateMessage).toHaveBeenCalledWith('message-1', expect.objectContaining({
      mediaResult: expect.objectContaining({ parameters }),
    }));
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it('续取原任务时从任务上下文恢复媒体参数，不重新生成', async () => {
    const mediaDownloadAccess = { providerConfigId: 'relay-video', origin: 'https://relayonapi.com', auth: { type: 'bearer' as const } };
    const task: PendingTask = { projectId: 'project-1', nodeId: 'message-tracking', nodeType: 'ai-video',
      provider: 'general', taskType: 'custom-protocol', submitted: true, taskId: 'original-task', attemptId: 'original-attempt',
      mediaDownloadAccess,
      mediaContext: { projectId: 'project-1', conversationId: 'conversation-1', messageId: 'message-1', deliveryMode: 'message',
        modelId: 'general/video-model', parameters: { aspectRatio: '9:16', duration: -1, videoFps: 24, generateAudio: false } } };
    mocks.getPendingTasksForProject.mockReturnValue([task]);
    mocks.storeState.messages = [{ id: 'message-1', conversationId: 'conversation-1', role: 'assistant',
      content: '', timestamp: 1, status: 'done', mediaStatus: 'paused' }];
    ensureMediaMessageRecoveryHandler();
    const handler = mocks.registerMediaMessageRecoveryHandler.mock.calls.at(-1)![0] as
      (savedTask: PendingTask, urls: string[]) => Promise<void>;
    await handler(task, ['https://cdn.example/video.mp4']);
    expect(mocks.persistMediaUrlToProjectData).toHaveBeenCalledWith('https://cdn.example/video.mp4', 'project-1', 'ai-video', expect.any(String),
      { mediaDownloadAccess, signal: undefined });
    expect(mocks.storeState.updateMessage).toHaveBeenCalledWith('message-1', expect.objectContaining({
      mediaResult: expect.objectContaining({ parameters: { aspectRatio: '9:16', duration: -1, videoFps: 24, generateAudio: false } }),
    }));
    expect(mocks.generateVideo).not.toHaveBeenCalled();
    expect(mocks.completeMediaNodeTask).toHaveBeenCalledOnce();
  });

  it('does not publish a message result when its uncancellable save finishes after cancellation', async () => {
    const task: PendingTask = { projectId: 'project-1', nodeId: 'message-tracking', nodeType: 'ai-image',
      provider: 'general', taskType: 'custom-protocol', submitted: true, taskId: 'original-task', attemptId: 'original-attempt',
      mediaContext: { projectId: 'project-1', conversationId: 'conversation-1', messageId: 'message-1', deliveryMode: 'message' } };
    mocks.getPendingTasksForProject.mockReturnValue([task]);
    mocks.storeState.messages = [{ id: 'message-1', conversationId: 'conversation-1', role: 'assistant',
      content: '', timestamp: 1, status: 'done', mediaStatus: 'paused' }];
    let finish!: (result: { filePath: string; mediaUrl: string; sourceUrl: string }) => void;
    mocks.persistMediaUrlToProjectData.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    ensureMediaMessageRecoveryHandler();
    const handler = mocks.registerMediaMessageRecoveryHandler.mock.calls.at(-1)![0] as
      (savedTask: PendingTask, urls: string[], signal?: AbortSignal) => Promise<void>;
    const controller = new AbortController();
    const pending = handler(task, ['https://cdn.example/image.png'], controller.signal);
    await vi.waitFor(() => expect(mocks.persistMediaUrlToProjectData).toHaveBeenCalledOnce());
    controller.abort();
    finish({ filePath: '/projects/project-1/image.png', mediaUrl: 'asset://image.png', sourceUrl: 'https://cdn.example/image.png' });
    await expect(pending).rejects.toThrow('任务仍保留');
    expect(mocks.storeState.updateMessage).not.toHaveBeenCalled();
    expect(mocks.storeState.addMessage).not.toHaveBeenCalled();
    expect(mocks.persistMessage).not.toHaveBeenCalled();
    expect(mocks.completeMediaNodeTask).not.toHaveBeenCalled();
    expect(mocks.getPendingTasksForProject()).toEqual([task]);
  });

  it('captures the receipt from the submission observer when a provider omits it from the result', async () => {
    const receipt = { projectId: 'project-1', nodeId: 'node-1', taskId: 'remote-video', attemptId: 'attempt-video' };
    let observer: ((value: MediaTaskReceipt) => void) | undefined;
    mocks.bindMediaTaskContext.mockImplementation((_id, _context, onReceipt) => { observer = onReceipt; return () => {}; });
    mocks.generateVideo.mockImplementation(async () => { observer?.(receipt); return { url: 'https://cdn.example/video.mp4' }; });
    mocks.getPendingTasksForProject.mockReturnValue([{ ...receipt, submitted: true }]);
    const result = await runMediaGeneration({ kind: 'video', prompt: '移动镜头', modelRef: 'openai/video-model', deliveryMode: 'canvas' },
      'project-1', undefined, 'node-1');
    expect(result.taskReceipt).toEqual(receipt);
    expect(mocks.getMediaTaskReceipt).not.toHaveBeenCalled();
    expect(mocks.completeMediaNodeTask).not.toHaveBeenCalled();
  });

  it('tracks ordinary chat image tasks and carries the exact receipt until delivery', async () => {
    const receipt = { projectId: 'project-1', nodeId: 'tracking-1', taskId: 'remote-1', attemptId: 'attempt-1' };
    mocks.generateImage.mockResolvedValue({ url: 'https://cdn.example/image.png', width: 1, height: 1, taskReceipt: receipt });
    const result = await runMediaGeneration({ kind: 'image', prompt: '一只猫', modelRef: 'openai/image-model', deliveryMode: 'chat' },
      'project-1', undefined, undefined, { projectId: 'project-1', conversationId: 'conversation-1', messageId: 'message-1', deliveryMode: 'chat' });
    expect(mocks.bindMediaTaskContext).toHaveBeenCalledWith(expect.stringMatching(/^media-message-message-1-/), expect.objectContaining({ messageId: 'message-1', projectId: 'project-1' }), expect.any(Function));
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({ nodeId: expect.stringMatching(/^media-message-message-1-/) }), undefined);
    expect(result.taskReceipt).toEqual(receipt);
    expect(mocks.completeMediaNodeTask).not.toHaveBeenCalled();
  });

  it('retains an async task when its result cannot be saved', async () => {
    const receipt = { projectId: 'project-1', nodeId: 'node-1', taskId: 'remote-1', attemptId: 'attempt-1' };
    mocks.generateImage.mockResolvedValue({ url: 'https://cdn.example/image.png', width: 1, height: 1, taskReceipt: receipt });
    mocks.persistMediaUrlToProjectData.mockRejectedValue(new Error('磁盘不可写'));
    const result = await runMediaGeneration({ kind: 'image', prompt: '一只猫', modelRef: 'openai/image-model', deliveryMode: 'canvas' }, 'project-1', undefined, 'node-1');
    expect(result.persistence).toBe('failed');
    expect(mocks.pauseMediaTask).toHaveBeenCalledWith(receipt, undefined, 'delivery_pending');
    expect(mocks.completeMediaNodeTask).not.toHaveBeenCalled();
  });

  it('does not resubmit when the original submission has no confirmed task ID', async () => {
    mocks.getPendingTasksForProject.mockReturnValue([{ nodeId: 'tracking-1', projectId: 'project-1', taskId: '', submitted: false, mediaContext: { messageId: 'message-1' } }]);
    await expect(retryMediaMessageTask('message-1')).rejects.toThrow('提交状态未知');
    expect(mocks.resumeMediaNodeTask).not.toHaveBeenCalled();
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it('resumes only the saved Muse task when the send acknowledgment was lost', async () => {
    mocks.getPendingTasksForProject.mockReturnValue([{ nodeId: 'tracking-1', projectId: 'project-1',
      taskId: 'ac655c56-b537-4c04-8913-fd150fc0e92a', taskType: 'muse', submitted: false,
      mediaContext: { messageId: 'message-1' } }]);
    mocks.resumeMediaNodeTask.mockResolvedValue(undefined);
    await retryMediaMessageTask('message-1');
    expect(mocks.resumeMediaNodeTask).toHaveBeenCalledWith('tracking-1');
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.generateVideo).not.toHaveBeenCalled();
  });
});
