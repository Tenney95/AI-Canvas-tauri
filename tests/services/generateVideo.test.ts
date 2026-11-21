/**
 * generateVideo — 回归测试：RelayOnAPI 视频渠道与原任务交付。
 */
import type { Node } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { buildGeneralVideoProtocolVariables, generateVideo, resolveVideoGenerationOperation } from '../../src/services/ai/generateVideo';
import { useAppStore } from '../../src/store/useAppStore';
import type { BaseNodeData } from '../../src/types';
import * as imageUtils from '../../src/services/ai/imageUtils';
import * as uploadService from '../../src/services/uploadService';
import * as videoInputValidation from '../../src/services/ai/videoInputValidation';
import * as volcengineBilling from '../../src/services/billing/volcengineBillingService';
import { createSeedanceQuickAdaptTemplate } from '../../src/services/ai/seedanceModelCapabilities';
import { resolveGeneralModelConnection } from '../../src/services/ai/helpers';
import { TOAPIS_MODEL_MANIFEST } from '../../src/services/ai/providers/toapisModelManifest';
import { LIBAPI_MODEL_MANIFEST } from '../../src/services/ai/providers/libapiModelManifest';
import { SORA2U_MODEL_MANIFEST } from '../../src/services/ai/providers/sora2uModelManifest';
import { getPendingTasksForProject } from '../../src/services/pollManager';
import type { ModelExecutionProfile, VideoModelCapability } from '../../src/types/aiTypes';
import { setupVideoFixture } from './generateVideo/videoFixture';

const comfyMocks = vi.hoisted(() => ({
  executeVideo: vi.fn(),
}));

vi.mock('../../src/services/comfyWorkflowService', () => ({
  executeComfyUIVideoGenerate: comfyMocks.executeVideo,
}));

setupVideoFixture(comfyMocks.executeVideo);

describe('general video protocol variables', () => {
  it('derives the operation from the strongest referenced visual input', () => {
    expect(resolveVideoGenerationOperation([], [])).toBe('text-to-video');
    expect(resolveVideoGenerationOperation(['first.png'], [])).toBe('image-to-video');
    expect(resolveVideoGenerationOperation(['first.png'], ['reference.mp4'])).toBe('video-to-video');
  });

  it('maps role-less relay images to references instead of inferring first and last frames', () => {
    const variables = buildGeneralVideoProtocolVariables(
      'doubao-seedance-2-0-260128',
      {
        model: 'general/seedance-2',
        provider: 'general',
        prompt: 'raw prompt',
        videoResolution: 1280,
        videoFps: 30,
        videoFrames: 181,
        seedanceResolution: '720p',
        seedanceRatio: '16:9',
        seedanceDuration: 6,
        generateAudio: true,
      },
      {
        prompt: 'resolved prompt',
        imageUrls: ['https://cdn.example/first.png', 'https://cdn.example/last.png'],
        videoUrls: ['https://cdn.example/reference.mp4'],
        audioUrls: ['https://cdn.example/reference.mp3'],
        operation: 'video-to-video',
      },
    );

    expect(variables).toMatchObject({
      model: 'doubao-seedance-2-0-260128',
      prompt: 'resolved prompt',
      size: '1280x720',
      width: 1280,
      height: 720,
      aspectRatio: '16:9',
      frames: 181,
      frames8n1: 185,
      fps: 30,
      duration: 6,
      resolution: '720p',
      seedanceResolution: '720p',
      generateAudio: true,
      videoOperation: 'video-to-video',
      videoInputMode: 'reference',
      durationText: '6',
      firstImage: undefined,
      lastImage: undefined,
      referenceImageUrls: [
        'https://cdn.example/first.png',
        'https://cdn.example/last.png',
      ],
      imageWithRoles: [
        { url: 'https://cdn.example/first.png', role: 'reference_image' },
        { url: 'https://cdn.example/last.png', role: 'reference_image' },
      ],
      referenceVideoUrl: 'https://cdn.example/reference.mp4',
      referenceVideoUrls: ['https://cdn.example/reference.mp4'],
      audioUrl: 'https://cdn.example/reference.mp3',
      referenceAudioUrls: ['https://cdn.example/reference.mp3'],
    });
  });

  it('tags reference images as reference_image alongside frames in imageWithRoles', () => {
    const withRoles = buildGeneralVideoProtocolVariables(
      'doubao-seedance-2.5',
      { model: 'general/seedance', provider: 'general', prompt: 'prompt' },
      {
        prompt: 'prompt',
        imageUrls: ['https://cdn.example/first.png', 'https://cdn.example/role.png'],
        videoUrls: [],
        audioUrls: [],
        operation: 'image-to-video',
        references: [
          { kind: 'image', url: 'https://cdn.example/first.png', origin: 'connection', role: 'first_frame' },
          { kind: 'image', url: 'https://cdn.example/role.png', origin: 'connection', role: 'reference' },
        ],
      },
    );
    expect(withRoles.imageWithRoles).toEqual([
      { url: 'https://cdn.example/first.png', role: 'first_frame' },
      { url: 'https://cdn.example/role.png', role: 'reference_image' },
    ]);

    // 没有参考素材时置 undefined，模板才会省略 image_with_roles 而不是发出空数组
    const withoutRoles = buildGeneralVideoProtocolVariables(
      'doubao-seedance-2.5',
      { model: 'general/seedance', provider: 'general', prompt: 'prompt' },
      { prompt: 'prompt', imageUrls: [], videoUrls: [], audioUrls: [], operation: 'text-to-video' },
    );
    expect(withoutRoles.imageWithRoles).toBeUndefined();
  });

  it('keeps unknown capability fields unspecified and treats one untyped image as a reference', () => {
    const variables = buildGeneralVideoProtocolVariables(
      'video-model',
      { model: 'general/video', provider: 'general', prompt: 'prompt' },
      {
        prompt: 'prompt',
        imageUrls: ['https://cdn.example/only.png'],
        videoUrls: [],
        audioUrls: [],
        operation: 'image-to-video',
      },
    );

    expect(variables).toMatchObject({
      aspectRatio: undefined,
      duration: undefined,
      seedanceResolution: undefined,
      videoFrames: undefined,
      videoFps: undefined,
      size: undefined,
      firstImage: undefined,
      lastImage: undefined,
      referenceImageUrls: ['https://cdn.example/only.png'],
      imageWithRoles: [{ url: 'https://cdn.example/only.png', role: 'reference_image' }],
      // 未声明 capability 时不猜比例、尺寸、时长、帧率、分辨率或有声能力
      generateAudio: undefined,
      videoOperation: 'image-to-video',
    });
  });

  it('omits compatibility fps and duration for partial capabilities without declared defaults', () => {
    const variables = buildGeneralVideoProtocolVariables(
      'partial-video-model',
      {
        model: 'general/partial-video',
        provider: 'general',
        prompt: 'prompt',
        videoFrames: 121,
      },
      {
        prompt: 'prompt',
        imageUrls: [],
        videoUrls: [],
        audioUrls: [],
        operation: 'text-to-video',
      },
      {
        resolutions: ['2K'],
        ratios: ['16:9'],
        frameRates: [30],
        durations: [10, 15],
      },
    );

    expect(variables).toMatchObject({
      videoFrames: 121,
      frames: 121,
      videoFps: undefined,
      fps: undefined,
      seedanceDuration: undefined,
      duration: undefined,
      seedanceResolution: undefined,
      seedanceRatio: undefined,
    });
  });

  it('emits imageWithRoles array from reference roles for image_with_roles protocols', () => {
    const variables = buildGeneralVideoProtocolVariables(
      'video-model',
      { model: 'general/video', provider: 'general', prompt: 'prompt' },
      {
        prompt: 'prompt',
        imageUrls: ['https://cdn.example/first.png', 'https://cdn.example/last.png'],
        videoUrls: [],
        audioUrls: [],
        operation: 'image-to-video',
        references: [
          { kind: 'image', role: 'first_frame', url: 'https://cdn.example/first.png', origin: 'connection' },
          { kind: 'image', role: 'last_frame', url: 'https://cdn.example/last.png', origin: 'connection' },
        ],
      },
    );

    expect(variables.imageWithRoles).toEqual([
      { url: 'https://cdn.example/first.png', role: 'first_frame' },
      { url: 'https://cdn.example/last.png', role: 'last_frame' },
    ]);
    // 独立字段仍按顺序推断，两种传参方式并存，由协议模板决定用哪个
    expect(variables.firstImage).toBe('https://cdn.example/first.png');
    expect(variables.lastImage).toBe('https://cdn.example/last.png');
  });
});

describe('general video runtime safety', () => {
  it('Sora2U 内置视频下架后拒绝新任务，保留原连接供续查', async () => {
    const selected = SORA2U_MODEL_MANIFEST.find((item) => item.id === 'seedance-2.0')!;
    useAppStore.getState().saveProviderConfig('sora-native-video-alias', {
      name: '我的 Sora2U', catalogId: 'sora2u', baseUrl: 'https://sora2u.com', apiKey: 'sora-video-fixture', selectedModels: [selected],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'sora-native-video-alias')!;
    const modelRef = `general/${model.id}`;
    const images = vi.spyOn(imageUtils, 'resolveImageDataUrlArray');
    const publicImages = vi.spyOn(imageUtils, 'resolveImageUrlArray');
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl');
    const beforeSubmit = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo({ model: modelRef, provider: 'general', prompt: '图片1、图片2配合音频1保持连续',
        seedanceDuration: 6, seedanceResolution: '720p', seedanceRatio: '16:9', referenceMedia: [
          { kind: 'image', role: 'reference', origin: 'connection', url: 'asset://localhost/local-image.png' },
          { kind: 'image', role: 'reference', origin: 'connection', url: 'https://cdn.example/remote-image.png' },
          { kind: 'audio', role: 'reference_audio', origin: 'connection', url: 'https://cdn.example/voice.mp3' },
        ] }, undefined, beforeSubmit)).rejects.toThrow('内置厂商已下架');
      expect(images).not.toHaveBeenCalled();
      expect(publicImages).not.toHaveBeenCalled();
      expect(media).not.toHaveBeenCalled();
      expect(beforeSubmit).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(resolveGeneralModelConnection(modelRef, { forRecovery: true })).toMatchObject({
        providerConfigId: 'sora-native-video-alias', apiKey: 'sora-video-fixture', baseUrl: 'https://sora2u.com',
        model: { modelId: selected.id, executionProfile: model.executionProfile },
      });
    } finally { images.mockRestore(); publicImages.mockRestore(); media.mockRestore(); }
  });

  function configureSavedSora2u(catalogId: string, modelId: string, maximum?: number) {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, sora2u: { name: 'Sora2U', catalogId,
        apiKey: 'fixture-key', baseUrl: 'https://gateway.example' } },
      generalModels: [{ id: 'saved-sora2u', name: 'Saved video', modelId, category: 'video', providerConfigId: 'sora2u',
        videoCapability: { maxImageReferences: 9, maxVideoReferences: 3, maxAudioReferences: 3,
          ...(maximum === undefined ? {} : { maxVideoAudioReferences: maximum }) },
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync', auth: { type: 'bearer' },
          submit: { method: 'POST', path: '/api/v1/videos', body: { model: '{{model}}', prompt: '{{prompt}}', references: '{{referenceUrls}}' } },
          response: { type: 'json', result: { urlPath: 'url' } } } },
      }],
    } }));
    return { model: 'general/saved-sora2u', provider: 'general', prompt: '按参考素材保持连续自然运镜', referenceMedia: [
      { kind: 'image' as const, role: 'reference' as const, origin: 'connection' as const, url: 'https://cdn.example/image.png' },
      ...[0, 1].map((index) => ({ kind: 'video' as const, role: 'reference' as const, origin: 'connection' as const, url: `https://cdn.example/video-${index}.mp4` })),
      ...[0, 1].map((index) => ({ kind: 'audio' as const, role: 'reference_audio' as const, origin: 'connection' as const, url: `https://cdn.example/audio-${index}.mp3` })),
    ] };
  }

  it.each(['seedance-2.0', 'seedance-2.0-character'])('旧 Sora2U %s 配置在上传或付费提交前报告下架', async (modelId) => {
    const params = configureSavedSora2u('sora2u', modelId);
    const images = vi.spyOn(imageUtils, 'resolveImageUrlArray');
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl');
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const beforeSubmit = vi.fn();
    try {
      await expect(generateVideo(params, undefined, beforeSubmit)).rejects.toThrow('内置厂商已下架');
      expect(images).not.toHaveBeenCalled();
      expect(media).not.toHaveBeenCalled();
      expect(beforeSubmit).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(useAppStore.getState().config.generalModels![0].videoCapability).not.toHaveProperty('maxVideoAudioReferences');
    } finally { images.mockRestore(); media.mockRestore(); }
  });

  it.each([
    { catalogId: 'custom-openai', modelId: 'seedance-2.0', maximum: undefined },
    { catalogId: 'sora2u', modelId: 'seedance-2.0', maximum: 4 },
    { catalogId: 'sora2u', modelId: 'seedance-2.0-character-mono', maximum: undefined },
  ])('按真实厂商识别下架并保留旧合同（$catalogId/$modelId/$maximum）', async ({ catalogId, modelId, maximum }) => {
    const params = configureSavedSora2u(catalogId, modelId, maximum);
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: 'https://cdn.example/result.mp4' })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      if (catalogId === 'sora2u') {
        await expect(generateVideo(params)).rejects.toThrow('内置厂商已下架');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(resolveGeneralModelConnection(params.model, { forRecovery: true })).toMatchObject({
          providerConfigId: 'sora2u', baseUrl: 'https://gateway.example',
          model: { modelId },
        });
        expect(useAppStore.getState().config.generalModels![0].videoCapability?.maxVideoAudioReferences).toBe(maximum);
        return;
      }
      await expect(generateVideo(params)).resolves.toEqual({ url: 'https://cdn.example/result.mp4',
        mediaDownloadAccess: { providerConfigId: 'sora2u', origin: 'https://gateway.example', auth: { type: 'bearer' } } });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).references).toHaveLength(5);
    } finally { constraints.mockRestore(); }
  });

  function configureLibapiVideo() {
    const selected = LIBAPI_MODEL_MANIFEST.find((item) => item.id === 'seedance-2-5')!;
    useAppStore.getState().saveProviderConfig('libapi-video-connection', {
      name: 'LibAPI', catalogId: 'libapi', baseUrl: 'https://libapi.cc/v1', apiKey: 'libapi-video-fixture',
      selectedModels: [selected],
    });
    const general = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'libapi-video-connection')!;
    return { model: `general/${general.id}`, provider: 'general', prompt: '按参考素材生成连续镜头' };
  }

  it('LibAPI 视频和音频使用当前连接上传，异步结果等待保存与回填确认', async () => {
    const params = configureLibapiVideo();
    useAppStore.setState({ currentProjectId: 'libapi-video-project', nodes: [{ id: 'libapi-video-node', type: 'ai-video',
      position: { x: 0, y: 0 }, data: { type: 'ai-video', label: 'LibAPI 视频', status: 'loading' } }] });
    const resolve = vi.spyOn(uploadService, 'resolveMediaReferenceUrl').mockImplementation(async (_url, options) =>
      `https://cdn.example/libapi-${options?.kind}.ref`);
    // 媒体元数据约束在独立用例覆盖；本例只检查通过预检后的上传身份与请求映射。
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'libapi-video-task', status: 'pending' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', is_final: true,
        output_url: 'https://cdn.example/libapi-complete.mp4' })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await generateVideo({ ...params, nodeId: 'libapi-video-node', referenceMedia: [
        { kind: 'video', role: 'reference', origin: 'connection', url: 'data:video/mp4;base64,dmlkZW8=' },
        { kind: 'audio', role: 'reference_audio', origin: 'connection', url: 'data:audio/mpeg;base64,YXVkaW8=' },
      ] });

      expect(resolve).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        provider: 'libapi-video-connection', mode: 'publicUrl', kind: 'video',
      }));
      expect(resolve).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        provider: 'libapi-video-connection', mode: 'publicUrl', kind: 'audio',
      }));
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ model_id: 'seedance-2-5', modality: 'video', params: {
        mode: 'reference', count: 1, videos: ['https://cdn.example/libapi-video.ref'], audios: ['https://cdn.example/libapi-audio.ref'],
      } });
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        'https://libapi.cc/api/v1/model-runtime/invoke', 'https://libapi.cc/v1/tasks/libapi-video-task',
      ]);
      expect(result).toMatchObject({ url: 'https://cdn.example/libapi-complete.mp4',
        taskReceipt: { projectId: 'libapi-video-project', nodeId: 'libapi-video-node', taskId: 'libapi-video-task' } });
      const pending = getPendingTasksForProject('libapi-video-project');
      expect(pending).toEqual([expect.objectContaining({ taskId: 'libapi-video-task', providerConfigId: 'libapi-video-connection',
        mediaRecoveryState: 'delivery_pending' })]);
      expect(JSON.stringify(pending)).not.toContain('libapi-video-fixture');
    } finally {
      resolve.mockRestore();
      constraints.mockRestore();
    }
  });

  it.each([false, true])('LibAPI 显式首尾帧映射为厂商模式，首尾顺序保持稳定（尾帧 %s）', async (hasLastFrame) => {
    const params = configureLibapiVideo();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'libapi-frame-task' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', is_final: true,
        output_url: 'https://cdn.example/libapi-frames.mp4' })));
    vi.stubGlobal('fetch', fetchMock);
    const images = ['https://cdn.example/libapi-first.png', ...(hasLastFrame ? ['https://cdn.example/libapi-last.png'] : [])];

    await generateVideo({ ...params, referenceMedia: images.map((url, index) => ({
      kind: 'image' as const, role: index === 0 ? 'first_frame' as const : 'last_frame' as const, origin: 'connection' as const, url,
    })) });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ params: {
      mode: hasLastFrame ? 'first-last' : 'first-frame', images,
    } });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each(['builtin', 'libapi', 'custom-openai'] as const)('逆序首尾帧的真实 @ 编号与对应合同的图片顺序一致（%s）', async (contract) => {
    const params = configureLibapiVideo();
    if (contract !== 'builtin') {
      const customProfile: ModelExecutionProfile = { preset: 'custom', protocol: {
        version: 2, mode: 'sync', submit: {
          method: 'POST', path: '/generate', pathMode: 'origin', bodyEncoding: 'json',
          body: { params: { prompt: '{{prompt}}', images: '{{imageUrls}}' } },
        }, response: { type: 'json', result: { urlPath: 'url' } },
      } };
      useAppStore.setState((state) => ({ config: { ...state.config,
        providers: { ...state.config.providers, 'libapi-video-connection': {
          ...state.config.providers['libapi-video-connection'], catalogId: contract,
        } },
        generalModels: state.config.generalModels!.map((item) => item.providerConfigId === 'libapi-video-connection'
          ? { ...item, executionProfile: customProfile } : item),
      } }));
    }
    const first = 'https://cdn.example/libapi-first.png';
    const last = 'https://cdn.example/libapi-last.png';
    useAppStore.setState({ nodes: [
      { id: 'libapi-first', type: 'source-image', position: { x: 0, y: 0 },
        data: { type: 'source-image', label: '首帧', imageUrl: first } },
      { id: 'libapi-last', type: 'source-image', position: { x: 0, y: 0 },
        data: { type: 'source-image', label: '尾帧', imageUrl: last } },
    ] });
    const fetchMock = vi.fn();
    if (contract === 'builtin') {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'libapi-ordered-frames-task' })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed',
          output_url: 'https://cdn.example/ordered-frames.mp4' })));
    } else {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://cdn.example/custom-frames.mp4' })));
    }
    vi.stubGlobal('fetch', fetchMock);

    await generateVideo({ ...params,
      prompt: '图片1是手写文字：@{libapi-first:首帧} 过渡到 @{libapi-last:尾帧}',
      referenceMedia: [
        { kind: 'image', role: 'last_frame', origin: 'connection', url: last },
        { kind: 'image', role: 'first_frame', origin: 'connection', url: first },
      ],
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ params: {
      images: contract === 'builtin' ? [first, last] : [last, first],
      prompt: contract === 'builtin' ? '图片1是手写文字：图片1 过渡到 图片2' : '图片1是手写文字：图片2 过渡到 图片1',
    } });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('LibAPI 首帧与普通参考混用时在上传和付费提交前拒绝', async () => {
    const params = configureLibapiVideo();
    const resolve = vi.spyOn(uploadService, 'resolveMediaReferenceUrl');
    const images = vi.spyOn(imageUtils, 'resolveImageUrlArray');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo({ ...params, referenceMedia: [
        { kind: 'image', role: 'first_frame', origin: 'connection', url: 'data:image/png;base64,Zmlyc3Q=' },
        { kind: 'video', role: 'reference', origin: 'connection', url: 'data:video/mp4;base64,dmlkZW8=' },
      ] })).rejects.toThrow(/首.*帧/);
      expect(resolve).not.toHaveBeenCalled();
      expect(images).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
      images.mockRestore();
    }
  });

  it('ToAPIs 本地视频/音频转为所属连接的公网 URL，不再转换为 Base64', async () => {
    const selected = TOAPIS_MODEL_MANIFEST.find((item) => item.id === 'seedance-2-5')!;
    useAppStore.getState().saveProviderConfig('toapis-local', { name: 'ToAPIs', catalogId: 'toapis',
      baseUrl: 'https://toapis.cn/v1', apiKey: 'toapis-fixture', selectedModels: [selected] });
    const general = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'toapis-local')!;
    const resolve = vi.spyOn(uploadService, 'resolveMediaReferenceUrl').mockImplementation(async (url, options) =>
      options?.mode === 'publicUrl' ? `https://cdn.example/${options.kind}.ref` : url);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'toapis-video-task' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', result: { data: [{ url: 'https://cdn.example/complete.mp4' }] } })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await generateVideo({ model: `general/${general.id}`, provider: 'general', prompt: '参考视频1和音频1生成', referenceMedia: [
        { kind: 'video', role: 'reference', origin: 'connection', url: 'data:video/mp4;base64,dmlkZW8=' },
        { kind: 'audio', role: 'reference_audio', origin: 'connection', url: 'data:audio/mpeg;base64,YXVkaW8=' },
      ] });
      expect(resolve).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ provider: 'toapis-local', mode: 'publicUrl', kind: 'video' }));
      expect(resolve).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ provider: 'toapis-local', mode: 'publicUrl', kind: 'audio' }));
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
        video_with_roles: [{ url: 'https://cdn.example/video.ref', role: 'reference_video' }],
        audio_with_roles: [{ url: 'https://cdn.example/audio.ref', role: 'reference_audio' }],
      });
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://toapis.cn/v1/videos/generations', 'https://toapis.cn/v1/videos/generations/toapis-video-task']);
    } finally { resolve.mockRestore(); }
  });
  it.each(['toapis', 'libapi', 'relayonapi'])('同名 %s 连接显式改为自定义后保持 Data URL 引用策略', async (connectionId) => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, [connectionId]: { name: '自定义视频', catalogId: 'custom-openai',
        baseUrl: 'https://custom-video.example/v1', apiKey: 'custom-video-fixture' } },
      generalModels: [{ id: 'custom-video-policy', providerConfigId: connectionId, category: 'video',
        name: '自定义视频', modelId: 'seedance-2-5',
        videoCapability: { operations: ['text-to-video', 'video-to-video'], maxVideoReferences: 1, maxAudioReferences: 1 },
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync', submit: {
          method: 'POST', path: '/generate', pathMode: 'origin', bodyEncoding: 'json',
          body: { prompt: '{{prompt}}', videos: '{{referenceVideoUrls}}', audios: '{{referenceAudioUrls}}' },
        }, response: { type: 'json', result: { urlPath: 'url' } } } },
      }],
    } }));
    const resolve = vi.spyOn(uploadService, 'resolveMediaReferenceUrl').mockImplementation(async (url) => url);
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://cdn.example/custom-video.mp4' })));
    vi.stubGlobal('fetch', fetchMock);
    const video = 'data:video/mp4;base64,Y3VzdG9tLXZpZGVv';
    const audio = 'data:audio/mpeg;base64,Y3VzdG9tLWF1ZGlv';
    try {
      await expect(generateVideo({ provider: 'general', model: 'general/custom-video-policy', prompt: '保留自定义引用',
        referenceMedia: [
          { kind: 'video', url: video, role: 'reference', origin: 'connection' },
          { kind: 'audio', url: audio, role: 'reference_audio', origin: 'connection' },
        ],
      })).resolves.toEqual({ url: 'https://cdn.example/custom-video.mp4',
        mediaDownloadAccess: { providerConfigId: connectionId, origin: 'https://custom-video.example' } });
      for (const [url, kind] of [[video, 'video'], [audio, 'audio']]) {
        expect(resolve).toHaveBeenCalledWith(url, expect.objectContaining({ mode: 'dataUrl', provider: undefined, kind }));
      }
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://custom-video.example/generate', expect.objectContaining({ method: 'POST' }));
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ videos: [video], audios: [audio] });
      expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer custom-video-fixture' });
    } finally {
      resolve.mockRestore();
      constraints.mockRestore();
    }
  });

  function configureGeneralVideoModel(options: {
    id: string;
    executionProfile?: ModelExecutionProfile;
    videoCapability?: VideoModelCapability;
  }): void {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          'runtime-video-provider': {
            name: '运行时视频测试连接',
            apiKey: 'secret',
            baseUrl: 'https://video-gateway.example',
          },
        },
        generalModels: [{
          id: options.id,
          name: '运行时视频测试模型',
          modelId: 'vendor-video-model',
          category: 'video',
          providerConfigId: 'runtime-video-provider',
          ...(options.executionProfile ? { executionProfile: options.executionProfile } : {}),
          ...(options.videoCapability ? { videoCapability: options.videoCapability } : {}),
        }],
      },
    }));
  }

  it('applies the legacy Agnes preset defaults explicitly instead of omitting required fields', async () => {
    configureGeneralVideoModel({
      id: 'agnes-preset-video',
      executionProfile: { preset: 'agnes-video' },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ video_id: 'video-task-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'completed',
        url: 'https://cdn.example/agnes.mp4',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateVideo({
      provider: 'general',
      model: 'general/agnes-preset-video',
      prompt: '平稳向前推进的镜头',
    })).resolves.toEqual({ url: 'https://cdn.example/agnes.mp4',
      mediaDownloadAccess: { providerConfigId: 'runtime-video-provider', origin: 'https://video-gateway.example' } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://video-gateway.example/videos');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'vendor-video-model',
      prompt: '平稳向前推进的镜头',
      width: 1152,
      height: 768,
      num_frames: 121,
      frame_rate: 24,
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/agnesapi?video_id=video-task-1');
  });

  it('fails before upload or fetch when a custom video model has no execution profile', async () => {
    configureGeneralVideoModel({ id: 'missing-video-protocol' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const generation = generateVideo({
      provider: 'general',
      model: 'general/missing-video-protocol',
      prompt: '让首帧产生轻微运动',
      referenceMedia: [{
        kind: 'image',
        url: 'data:image/png;base64,iVBORw0KGgo=',
        origin: 'connection',
        role: 'first_frame',
      }],
    });
    await expect(generation).rejects.toThrow('模型调用协议未配置');
    await expect(generation).rejects.toThrow('连接：运行时视频测试连接');
    await expect(generation).rejects.toThrow('模型：运行时视频测试模型（模型 ID：vendor-video-model）');
    await expect(generation).rejects.toThrow('设置 → API Key → 编辑“运行时视频测试连接” → 启用模型');
    await expect(generation).rejects.toThrow('调用协议”（滑杆图标）');
    await expect(generation).rejects.toThrow('保存更改');
    await expect(generation).rejects.toThrow('尚未提交视频生成请求');
    await expect(generation).rejects.not.toThrow('重新导入');
    await expect(generation).rejects.not.toThrow('secret');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['anthropic-chat', 'Anthropic Messages'],
    ['gemini-chat', 'Google Gemini generateContent'],
    ['openai-responses', 'OpenAI Responses'],
  ] as const)('identifies a text-only %s preset and the exact video settings location', async (preset, label) => {
    configureGeneralVideoModel({ id: 'wrong-video-protocol', executionProfile: { preset } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const generation = generateVideo({
      provider: 'general', model: 'general/wrong-video-protocol', prompt: '平稳向前推进的镜头',
    });
    await expect(generation).rejects.toThrow('调用协议类型不适用');
    await expect(generation).rejects.toThrow(`“协议预设”误选为文本对话协议“${label}”`);
    await expect(generation).rejects.toThrow('连接：运行时视频测试连接');
    await expect(generation).rejects.toThrow('模型 ID：vendor-video-model');
    await expect(generation).rejects.toThrow('修改位置：设置 → API Key');
    await expect(generation).rejects.toThrow('高级自定义 JSON');
    await expect(generation).rejects.toThrow('尚未提交视频生成请求');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes a capability-approved 30 second duration through to the configured protocol', async () => {
    configureGeneralVideoModel({
      id: 'thirty-second-video',
      videoCapability: {
        minDuration: 5,
        maxDuration: 30,
        defaultDuration: 5,
      },
      executionProfile: {
        preset: 'custom',
        protocol: {
          version: 2,
          mode: 'sync',
          submit: {
            method: 'POST',
            path: '/v1/videos',
            bodyEncoding: 'json',
            body: {
              model: '{{model}}',
              prompt: '{{prompt}}',
              duration: '{{duration}}',
            },
          },
          response: {
            type: 'json',
            result: { urlPath: 'video.url' },
          },
        },
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      video: { url: 'https://cdn.example/thirty-seconds.mp4' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateVideo({
      provider: 'general',
      model: 'general/thirty-second-video',
      prompt: '连续三十秒的长镜头',
      seedanceDuration: 30,
      videoFps: 24,
    })).resolves.toEqual({ url: 'https://cdn.example/thirty-seconds.mp4',
      mediaDownloadAccess: { providerConfigId: 'runtime-video-provider', origin: 'https://video-gateway.example' } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://video-gateway.example/v1/videos');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'vendor-video-model',
      duration: 30,
    });
  });

  it('runs the explicit Volcano Seedance quick template with typed content and automatic duration', async () => {
    const template = createSeedanceQuickAdaptTemplate('2.5', 'volcengine');
    configureGeneralVideoModel({
      id: 'seedance-volcano-template',
      videoCapability: template.capability,
      executionProfile: template.executionProfile,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'seedance-task-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'succeeded',
        content: { video_url: 'https://cdn.example/seedance.mp4' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateVideo({
      provider: 'general',
      model: 'general/seedance-volcano-template',
      prompt: '让画面中的人物轻轻转身',
      referenceMedia: [{
        kind: 'image',
        url: 'https://cdn.example/portrait.png',
        origin: 'connection',
        role: 'first_frame',
      }],
    })).resolves.toEqual({ url: 'https://cdn.example/seedance.mp4',
      mediaDownloadAccess: { providerConfigId: 'runtime-video-provider', origin: 'https://video-gateway.example' } });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: 'vendor-video-model',
      ratio: 'adaptive',
      duration: -1,
      content: [
        { type: 'text', text: '让画面中的人物轻轻转身' },
        {
          type: 'image_url',
          image_url: { url: 'https://cdn.example/portrait.png' },
          role: 'first_frame',
        },
      ],
    });
  });
});

describe('ComfyUI 普通素材自动匹配入口', () => {
  it('未设置默认节点也转交三类引用，提示词顺序优先于连线和参考面板', async () => {
    const urls = { first: 'data:image/png;base64,MQ==', second: 'data:image/png;base64,Mg==', video: 'data:video/mp4;base64,dg==', audio: 'data:audio/wav;base64,YQ==' };
    const nodes = Object.entries(urls).map(([id, url]) => ({ id, position: { x: 0, y: 0 },
      type: id === 'video' ? 'ai-video' : id === 'audio' ? 'ai-audio' : 'source-image',
      data: { type: id === 'video' ? 'ai-video' : id === 'audio' ? 'ai-audio' : 'source-image', label: id,
        ...(id === 'video' ? { videoUrl: url } : id === 'audio' ? { audioUrl: url } : { imageUrl: url }) },
    })) as Node<BaseNodeData>[];
    useAppStore.setState({ nodes, edges: [{ id: 'edge', source: 'first', target: 'target' }], workflows: [{
      id: 'auto', name: 'auto', category: 'ai-video', createdAt: 1, fileName: 'auto.json', fileContent: '{}',
      ioNodes: [{ nodeId: '10', title: 'video', type: 'video' }],
    }] });
    await generateVideo({ prompt: '@{second:第二} @{video:视频} @{first:第一} @{audio:音频}', model: 'wf', provider: 'comfyui', workflowId: 'auto', nodeId: 'target',
      referenceMedia: [{ kind: 'image', url: urls.first, role: 'reference', origin: 'connection' },
        { kind: 'image', url: 'data:image/png;base64,ZXh0cmE=', role: 'first_frame', origin: 'connection' }],
    });
    expect(comfyMocks.executeVideo).toHaveBeenCalledWith(expect.anything(), undefined, [urls.audio], { imageUrls: [urls.second, urls.first, 'data:image/png;base64,ZXh0cmE='], videoUrls: [urls.video] });
  });
});

describe('caller lease at the paid video submission boundary', () => {
  function configureLeaseProtocol() {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, relay: { name: '测试连接', apiKey: 'test-key', baseUrl: 'https://video-gateway.example' } },
      generalModels: [{ id: 'lease-video', name: '测试模型', modelId: 'vendor-video', category: 'video', providerConfigId: 'relay',
        videoCapability: { operations: ['text-to-video', 'image-to-video'], minDuration: 1, maxDuration: 30, maxImageReferences: 2 },
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync', submit: {
          method: 'POST', path: '/v1/videos', bodyEncoding: 'json', body: { model: '{{model}}', prompt: '{{prompt}}', duration: '{{duration}}' },
        }, response: { type: 'json', result: { urlPath: 'video.url' } } } },
      }],
    } }));
  }

  it.each([
    { stage: 'upload', failure: 'stale' }, { stage: 'upload', failure: 'abort' },
    { stage: 'constraints', failure: 'stale' }, { stage: 'constraints', failure: 'abort' },
  ] as const)('does not submit after $failure during a general model $stage wait', async ({ stage, failure }) => {
    configureLeaseProtocol();
    const controller = new AbortController(); let stale = false; let reached = false; let release!: () => void;
    const upload = vi.spyOn(imageUtils, 'resolveImageUrlArray').mockImplementation(async (urls) => {
      if (stage === 'upload') { reached = true; await new Promise<void>((resolve) => { release = resolve; }); }
      return urls.map(() => 'https://cdn.example/uploaded-reference.png');
    });
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockImplementation(async () => {
      if (stage === 'constraints') { reached = true; await new Promise<void>((resolve) => { release = resolve; }); }
    });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const beforeSubmit = vi.fn(async () => { if (stale) throw new Error('caller input lease revoked'); });
    try {
      const pending = generateVideo({ provider: 'general', model: 'general/lease-video', prompt: '复刻这段动作', seedanceDuration: 5,
        referenceMedia: [{ kind: 'image', url: 'data:image/png;base64,YQ==', origin: 'connection', role: 'reference' }],
      }, controller.signal, beforeSubmit);
      await vi.waitFor(() => expect(reached).toBe(true));
      if (failure === 'abort') controller.abort(); else stale = true;
      release();
      await expect(pending).rejects.toThrow(failure === 'abort' ? /取消|abort/iu : 'caller input lease revoked');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(beforeSubmit).toHaveBeenCalledTimes(failure === 'abort' ? 0 : 1);
    } finally { upload.mockRestore(); constraints.mockRestore(); }
  });

  it('checks cancellation again after an asynchronous beforeSubmit callback', async () => {
    configureLeaseProtocol();
    const controller = new AbortController(); const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const beforeSubmit = vi.fn(async () => { await Promise.resolve(); controller.abort(); });
    await expect(generateVideo({ provider: 'general', model: 'general/lease-video', prompt: '保留构图', seedanceDuration: 5 },
      controller.signal, beforeSubmit)).rejects.toThrow(/取消|abort/iu);
    expect(beforeSubmit).toHaveBeenCalledTimes(1); expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a successful callback transparent to the configured request and result', async () => {
    configureLeaseProtocol();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ video: { url: 'https://cdn.example/lease-result.mp4' } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock); const beforeSubmit = vi.fn(async () => undefined);
    await expect(generateVideo({ provider: 'general', model: 'general/lease-video', prompt: '保留构图', seedanceDuration: 5 },
      undefined, beforeSubmit)).resolves.toEqual({ url: 'https://cdn.example/lease-result.mp4',
        mediaDownloadAccess: { providerConfigId: 'relay', origin: 'https://video-gateway.example' } });
    expect(beforeSubmit).toHaveBeenCalledTimes(1); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(beforeSubmit.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({ model: 'vendor-video', prompt: '保留构图', duration: 5 });
  });

  it.each(['stale', 'abort'] as const)('rechecks %s after the Volcengine billing record await and before the paid POST', async (failure) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      volcengine: { name: '测试方舟', apiKey: 'test-key', baseUrl: 'https://ark.example/api/v3' },
    } } }));
    const controller = new AbortController(); let reached = false; let release!: () => void; let stale = false;
    const billing = vi.spyOn(volcengineBilling, 'createBillingRun').mockImplementation(async () => {
      reached = true; await new Promise<void>((resolve) => { release = resolve; }); return null;
    });
    const updateBilling = vi.spyOn(volcengineBilling, 'updateBillingRun').mockResolvedValue(null);
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const beforeSubmit = vi.fn(async () => { if (stale) throw new Error('caller input lease revoked'); });
    try {
      const pending = generateVideo({ provider: 'volcengine', model: 'volcengine/doubao-seedance-2-5-260628', prompt: '保留动作和构图', seedanceDuration: 5 },
        controller.signal, beforeSubmit);
      await vi.waitFor(() => expect(reached).toBe(true));
      if (failure === 'abort') controller.abort(); else stale = true;
      release();
      await expect(pending).rejects.toThrow(failure === 'abort' ? /取消|abort/iu : 'caller input lease revoked');
      expect(fetchMock).not.toHaveBeenCalled(); expect(billing).toHaveBeenCalledTimes(1);
      expect(beforeSubmit).toHaveBeenCalledTimes(failure === 'abort' ? 0 : 1);
      expect(updateBilling.mock.calls.some(([, patch]) => patch.status === 'unknown')).toBe(false);
    } finally { billing.mockRestore(); updateBilling.mockRestore(); }
  });

  it('forwards the caller callback through the ComfyUI dispatch without consuming it early', async () => {
    const beforeSubmit = vi.fn(async () => undefined);
    await generateVideo({ prompt: '保留运镜', model: 'comfyui/workflow', provider: 'comfyui', workflowId: 'workflow' }, undefined, beforeSubmit);
    expect(comfyMocks.executeVideo).toHaveBeenCalledWith(expect.anything(), undefined, [], { imageUrls: [], videoUrls: [] }, beforeSubmit);
    expect(beforeSubmit).not.toHaveBeenCalled();
  });
});
