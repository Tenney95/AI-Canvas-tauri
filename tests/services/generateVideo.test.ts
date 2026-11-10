/**
 * generateVideo — 回归测试：RelayOnAPI 视频渠道与原任务交付。
 */
import type { Node } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  annotateCharacterReferences,
  assertVideoReferenceLimits,
  buildGeneralVideoProtocolVariables,
  buildVolcengineVideoContent,
  buildVolcengineVideoRequestBody,
  compileVideoReferencePrompt,
  generateVideo,
  resolveVideoGenerationOperation,
} from '../../src/services/ai/generateVideo';
import { resolvePromptWithImageRefs, resolvePromptWithMediaRefs } from '../../src/services/ai/promptResolver';
import {
  collectConnectedReferenceMedia,
  getMediaReferenceUrls,
  mergeMediaReferences,
} from '../../src/services/ai/connectedReferenceMedia';
import { mediaProviderRegistry } from '../../src/services/ai/mediaProviderRegistry';
import { useAppStore } from '../../src/store/useAppStore';
import type { BaseNodeData } from '../../src/types';
import { buildDramaVoiceMentionId, emptyDramaAssetLibrary, type DramaCharacter } from '../../src/types/dramaAssets';
import * as apimartApi from '../../src/services/ai/apimartGen';
import * as imageUtils from '../../src/services/ai/imageUtils';
import * as uploadService from '../../src/services/uploadService';
import * as videoInputValidation from '../../src/services/ai/videoInputValidation';
import * as volcengineBilling from '../../src/services/billing/volcengineBillingService';
import { createSeedanceQuickAdaptTemplate } from '../../src/services/ai/seedanceModelCapabilities';
import { resolveVideoSubmissionControls } from '../../src/services/ai/videoRequestResolver';
import { TOAPIS_MODEL_MANIFEST } from '../../src/services/ai/providers/toapisModelManifest';
import { LIBAPI_MODEL_MANIFEST } from '../../src/services/ai/providers/libapiModelManifest';
import { RELAYON_MODEL_MANIFEST } from '../../src/services/ai/providers/relayonModelManifest';
import { MINIMAX_BASE_URL, MINIMAX_MODEL_MANIFEST } from '../../src/services/ai/providers/minimaxModelManifest';
import { getPendingTasksForProject, removePendingTask } from '../../src/services/pollManager';
import { buildCharacterVideoReferences, resolveVideoParameterInputMode } from '../../src/components/nodes/shared/VideoParamSelector';
import type {
  ModelExecutionProfile,
  VideoModelCapability,
  VideoGenerationReferenceInput,
  VideoReferenceItem,
} from '../../src/types/aiTypes';

const comfyMocks = vi.hoisted(() => ({
  executeVideo: vi.fn(),
}));

vi.mock('../../src/services/comfyWorkflowService', () => ({
  executeComfyUIVideoGenerate: comfyMocks.executeVideo,
}));

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  comfyMocks.executeVideo.mockReset();
  comfyMocks.executeVideo.mockResolvedValue({ url: 'https://cdn.example/result.mp4' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MiniMax 官方视频素材与任务交付', () => {
  function configureMinimaxVideo(customized = false) {
    const selected = structuredClone(MINIMAX_MODEL_MANIFEST.find((item) => item.id === 'MiniMax-H3')!);
    if (customized) selected.executionProfile!.protocol!.submit.path = '/v2/my-video';
    useAppStore.getState().saveProviderConfig('minimax-video-selected', {
      name: 'MiniMax 官方', catalogId: 'minimax', baseUrl: MINIMAX_BASE_URL,
      apiKey: 'minimax-video-selected-fixture', selectedModels: [selected],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'minimax-video-selected')!;
    return { provider: 'general', model: `general/${model.id}`, prompt: '图片1中的人物跟随视频1运动，使用音频1的声音' };
  }

  it.each([false, true])('协议自定义 %s：上传前校验原媒体，mm_file 不交给浏览器探测', async (customized) => {
    const params = configureMinimaxVideo(customized);
    const sourceImage = 'data:image/png;base64,YQ==';
    const sourceVideo = 'data:video/mp4;base64,Yg==';
    const sourceAudio = 'data:audio/mpeg;base64,Yw==';
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray').mockResolvedValue(['mm_file://101']);
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl').mockImplementation(async (_url, options) => {
      expect(constraints).toHaveBeenCalledTimes(1);
      return options?.kind === 'video' ? 'mm_file://102' : 'mm_file://103';
    });
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'minimax-original-task' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: 'minimax-original-task', status: 'succeeded',
        content: { url: 'https://cdn.example/h3-generated.mp4' } } })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await generateVideo({ ...params, seedanceDuration: 6, seedanceResolution: '768P', seedanceRatio: '9:16', referenceMedia: [
        { kind: 'image', role: 'reference', origin: 'prompt', url: sourceImage },
        { kind: 'video', role: 'reference', origin: 'prompt', url: sourceVideo },
        { kind: 'audio', role: 'reference_audio', origin: 'prompt', url: sourceAudio },
      ] });
      expect(result.url).toBe('https://cdn.example/h3-generated.mp4');
      expect(constraints).toHaveBeenCalledTimes(1);
      expect(constraints.mock.calls[0][0]).toMatchObject({ imageUrls: [sourceImage], videoUrls: [sourceVideo], audioUrls: [sourceAudio] });
      expect(media.mock.calls.map(([url, options]) => [url, options?.provider, options?.mode])).toEqual([
        [sourceVideo, 'minimax-video-selected', 'publicUrl'], [sourceAudio, 'minimax-video-selected', 'publicUrl'],
      ]);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `${MINIMAX_BASE_URL}${customized ? '/v2/my-video' : '/v2/video_generation'}`, `${MINIMAX_BASE_URL}/v2/query/video_generation/minimax-original-task`,
      ]);
      const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      expect(body).toMatchObject({ model: 'MiniMax-H3', resolution: '768P', duration: 6, ratio: '9:16' });
      expect(body.content).toEqual([
        { type: 'text', text: expect.any(String) },
        { type: 'image_url', image_url: { url: 'mm_file://101' }, role: 'reference_image' },
        { type: 'video_url', video_url: { url: 'mm_file://102' }, role: 'reference_video' },
        { type: 'audio_url', audio_url: { url: 'mm_file://103' }, role: 'reference_audio' },
      ]);
      for (const [, init] of fetchMock.mock.calls) expect(new Headers(init.headers).get('Authorization')).toBe('Bearer minimax-video-selected-fixture');
      expect(body).not.toHaveProperty('audio');
    } finally { image.mockRestore(); media.mockRestore(); constraints.mockRestore(); }
  });

  it('首尾帧混参考图在上传前拒绝，保留用户选择且不提交生成', async () => {
    const params = configureMinimaxVideo();
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo({ ...params, seedanceDuration: 5, seedanceResolution: '2K', referenceMedia: [
        { kind: 'image', role: 'first_frame', origin: 'prompt', url: 'data:image/png;base64,YQ==' },
        { kind: 'image', role: 'reference', origin: 'prompt', url: 'data:image/png;base64,Yg==' },
      ] })).rejects.toThrow();
      expect(image).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { image.mockRestore(); }
  });
});

describe('RelayOnAPI 视频渠道与原任务交付', () => {
  function configure(modelId: string) {
    const selected = RELAYON_MODEL_MANIFEST.find((item) => item.id === modelId)!;
    useAppStore.getState().saveProviderConfig('relayon-video-alias', {
      name: '我的万象视频', catalogId: 'relayonapi', baseUrl: 'https://relayonapi.com/v1',
      apiKey: 'relayon-video-fixture', selectedModels: [selected],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'relayon-video-alias')!;
    return { model: `general/${model.id}`, provider: 'general', prompt: '缓慢推进的镜头' };
  }

  it.each([
    { modelId: 'doubao-seedance-2-0-260128', ratio: '4:3', body: { metadata: { ratio: '4:3' } } },
    { modelId: 'sd-2.0-A', ratio: '9:16', body: { output: { aspect_ratio: '9:16' } } },
    { modelId: 'sd-2.5-c1', ratio: '4:3', body: { output: { aspect_ratio: '4:3' } } },
  ])('旧 $modelId 单比例快照允许选择 $ratio 并按原渠道提交', async ({ modelId, ratio, body }) => {
    const params = configure(modelId);
    const id = params.model.slice('general/'.length);
    const saved = useAppStore.getState().config.generalModels!.find((item) => item.id === id)!;
    useAppStore.getState().updateGeneralModel(id, { videoCapability: {
      ...saved.videoCapability, ratios: ['16:9'], defaultRatio: '16:9',
    } });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'legacy-ratio-task' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/legacy-ratio.mp4' })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateVideo({ ...params, seedanceDuration: 10, seedanceResolution: '720p', seedanceRatio: ratio }))
      .resolves.toMatchObject({ url: 'https://cdn.example/legacy-ratio.mp4' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://relayonapi.com/v1/videos', 'https://relayonapi.com/v1/videos/legacy-ratio-task',
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({ model: modelId, ...body });
    expect(useAppStore.getState().config.generalModels!.find((item) => item.id === id)?.videoCapability?.ratios)
      .toEqual(['16:9']);
  });

  it('H3 使用当前视频组 Key，按原任务鉴权下载，界面 2K 映射为请求 2k', async () => {
    const params = configure('minimax-h3');
    useAppStore.setState((state) => ({ currentProjectId: 'relayon-h3-project', nodes: [{
      id: 'relayon-h3-node', type: 'ai-video', position: { x: 0, y: 0 },
      data: { type: 'ai-video', label: 'H3', status: 'loading' },
    }], config: { ...state.config, providers: { ...state.config.providers,
      'relayon-video-alias': { ...state.config.providers['relayon-video-alias'], relayonGroup: 'video' },
      'relayon-image-other': { name: '图片组', catalogId: 'relayonapi', relayonGroup: 'image', apiKey: 'wrong-image-fixture' },
    } } }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'h3-original-task' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' })))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await generateVideo({ ...params, nodeId: 'relayon-h3-node', seedanceDuration: 4,
        seedanceResolution: '2K', seedanceRatio: '4:3' });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ model: 'minimax-h3',
        prompt: params.prompt, duration: 4, resolution: '2k', aspect_ratio: '4:3', references: [] });
      expect(result).toMatchObject({ url: 'data:video/mp4;base64,AQID', taskReceipt: { taskId: 'h3-original-task' } });
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://relayonapi.com/v1/videos',
        'https://relayonapi.com/v1/videos/h3-original-task', 'https://relayonapi.com/v1/videos/h3-original-task/content']);
      for (const [, init] of fetchMock.mock.calls) expect(new Headers(init.headers).get('Authorization')).toBe('Bearer relayon-video-fixture');
      expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Idempotency-Key')).toBeTruthy();
      expect(new Headers(fetchMock.mock.calls[2][1].headers).get('Idempotency-Key')).toBeNull();
      expect(getPendingTasksForProject('relayon-h3-project')[0]).toMatchObject({ taskId: 'h3-original-task', providerConfigId: 'relayon-video-alias', mediaRecoveryState: 'delivery_pending' });
    } finally { removePendingTask('relayon-h3-node'); }
  });

  it('C3 参考图片与音频保留顺序，编号转换为文档的 @图／@音频', async () => {
    const params = configure('sd-2.0-c3');
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray').mockImplementation(async (urls) => urls);
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl').mockImplementation(async (url) => url);
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'c3-task' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', video_url: 'https://cdn.example/c3.mp4' })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo({ ...params, prompt: '图片1跟随音频1说话', seedanceDuration: 10,
        seedanceResolution: '720p', seedanceRatio: '1:1', referenceMedia: [
          { kind: 'image', role: 'reference', origin: 'connection', url: 'https://cdn.example/i.png' },
          { kind: 'audio', role: 'reference_audio', origin: 'connection', url: 'https://cdn.example/a.mp3' },
        ] })).resolves.toMatchObject({ url: 'https://cdn.example/c3.mp4' });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ model: 'sd-2.0-c3', prompt: '@图1跟随@音频1说话',
        duration: 10, resolution: '720p', aspect_ratio: '1:1', references: [
          { type: 'image', url: 'https://cdn.example/i.png' }, { type: 'audio', url: 'https://cdn.example/a.mp3' },
        ] });
    } finally { image.mockRestore(); media.mockRestore(); constraints.mockRestore(); }
  });

  it.each([[7, '16:9'], [10, '4:3']] as const)('C3 音频的非法时长／比例（%s，%s）在上传与提交前拒绝', async (duration, ratio) => {
    const params = configure('sd-2.0-c3');
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray');
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo({ ...params, prompt: '图片1按音频1说话', seedanceDuration: duration, seedanceRatio: ratio,
        referenceMedia: [
          { kind: 'image', role: 'reference', origin: 'connection', url: 'https://cdn.example/i.png' },
          { kind: 'audio', role: 'reference_audio', origin: 'connection', url: 'data:audio/mpeg;base64,YQ==' },
        ] })).rejects.toThrow('C3 带参考音频');
      expect(image).not.toHaveBeenCalled();
      expect(media).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { image.mockRestore(); media.mockRestore(); }
  });

  it('2.5 C1 复用既有 2.5 参数映射，允许 30 秒并保持当前连接身份', async () => {
    const params = configure('sd-2.5-c1');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sd25-c1-original' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/sd25-c1.mp4' })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateVideo({ ...params, seedanceDuration: 30, seedanceResolution: '720p', seedanceRatio: '16:9', generateAudio: true });
    expect(result.url).toBe('https://cdn.example/sd25-c1.mp4');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ model: 'sd-2.5-c1', prompt: params.prompt,
      seconds: '30', output: { resolution: '720p', aspect_ratio: '16:9' }, generate_audio: true, references: [] });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer relayon-video-fixture' });
    expect(fetchMock.mock.calls[1][0]).toBe('https://relayonapi.com/v1/videos/sd25-c1-original');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('官转文生视频使用 metadata 和字符串时长，完成后保留原任务直到回填确认', async () => {
    const params = configure('doubao-seedance-2-5-260628');
    useAppStore.setState({ currentProjectId: 'relayon-video-project', nodes: [{
      id: 'relayon-video-node', type: 'ai-video', position: { x: 0, y: 0 },
      data: { type: 'ai-video', label: '万象视频', status: 'loading' },
    }] });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'cgt-relayon-task' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', video_url: 'https://cdn.example/relayon.mp4' })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await generateVideo({ ...params, nodeId: 'relayon-video-node',
        seedanceDuration: 4, seedanceResolution: '480p', seedanceRatio: '16:9', generateAudio: false });
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        'https://relayonapi.com/v1/videos', 'https://relayonapi.com/v1/videos/cgt-relayon-task',
      ]);
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        model: 'doubao-seedance-2-5-260628', prompt: '缓慢推进的镜头', seconds: '4',
        metadata: { resolution: '480p', ratio: '16:9', generate_audio: false },
      });
      expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
        Authorization: 'Bearer relayon-video-fixture', 'Idempotency-Key': expect.any(String),
      });
      expect(fetchMock.mock.calls[1][1]?.headers).not.toHaveProperty('Idempotency-Key');
      expect(result).toMatchObject({ url: 'https://cdn.example/relayon.mp4', taskReceipt: { taskId: 'cgt-relayon-task' } });
      const tasks = getPendingTasksForProject('relayon-video-project');
      expect(tasks).toEqual([expect.objectContaining({ taskId: 'cgt-relayon-task',
        providerConfigId: 'relayon-video-alias', mediaRecoveryState: 'delivery_pending' })]);
      expect(JSON.stringify(tasks)).not.toContain('relayon-video-fixture');
      expect(JSON.stringify(tasks)).not.toContain('Idempotency-Key');
    } finally {
      removePendingTask('relayon-video-node');
    }
  });

  it('C1 普通参考按类型与顺序发送，本地视频和音频沿用当前连接的公共上传策略', async () => {
    const params = configure('sd-2.0-c1');
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray').mockImplementation(async (urls) => urls);
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl').mockImplementation(async (_url, options) =>
      `https://cdn.example/relayon-${options?.kind}.ref`);
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'task-relayon-c1' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', content: { video_url: 'https://cdn.example/c1.mp4' } })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await generateVideo({ ...params, prompt: '图片1参考视频1和音频1',
        seedanceDuration: 15, seedanceResolution: '720p', seedanceRatio: '9:16', referenceMedia: [
          { kind: 'image', role: 'reference', origin: 'connection', url: 'https://cdn.example/person.png' },
          { kind: 'video', role: 'reference', origin: 'connection', url: 'data:video/mp4;base64,dmlkZW8=' },
          { kind: 'audio', role: 'reference_audio', origin: 'connection', url: 'data:audio/mpeg;base64,YXVkaW8=' },
        ] });
      expect(result.url).toBe('https://cdn.example/c1.mp4');
      expect(media).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ provider: 'relayon-video-alias', mode: 'publicUrl', kind: 'video' }));
      expect(media).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ provider: 'relayon-video-alias', mode: 'publicUrl', kind: 'audio' }));
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(body).toMatchObject({ model: 'sd-2.0-c1', duration: 15, resolution: '720p', aspect_ratio: '9:16', references: [
        { type: 'image', url: 'https://cdn.example/person.png' },
        { type: 'video', url: 'https://cdn.example/relayon-video.ref' },
        { type: 'audio', url: 'https://cdn.example/relayon-audio.ref' },
      ] });
      expect(body.prompt).toContain('@图1');
      expect(body.prompt).not.toContain('@@');
      expect(body).not.toHaveProperty('metadata');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      image.mockRestore(); media.mockRestore(); constraints.mockRestore();
    }
  });

  it('C2 不支持的参考视频在上传和生成请求之前拒绝', async () => {
    const params = configure('sd-2.0-c2');
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo({ ...params, seedanceDuration: 5, seedanceResolution: '720p', seedanceRatio: '16:9',
        referenceMedia: [{ kind: 'video', role: 'reference', origin: 'connection', url: 'https://cdn.example/not-allowed.mp4' }],
      })).rejects.toThrow(/视频|video/);
      expect(media).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { media.mockRestore(); }
  });

  it('C2 画布引用按实际素材顺序生成图片／音频编号，提交时保留官方写法', async () => {
    const params = configure('sd-2.0-c2');
    const nodes: Node<BaseNodeData>[] = [
      { id: 'image-a', type: 'ai-image', position: { x: 0, y: 0 },
        data: { label: '图片 A', type: 'ai-image', imageUrl: 'https://cdn.example/a.png' } },
      { id: 'image-b', type: 'ai-image', position: { x: 0, y: 0 },
        data: { label: '图片 B', type: 'ai-image', imageUrl: 'https://cdn.example/b.png' } },
      { id: 'audio-a', type: 'ai-audio', position: { x: 0, y: 0 },
        data: { label: '声音 A', type: 'ai-audio', audioUrl: 'https://cdn.example/a.mp3' } },
    ];
    useAppStore.setState({ nodes });
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray').mockImplementation(async (urls) => urls);
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl').mockImplementation(async (url) => url);
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'task-relayon-c2' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', video_url: 'https://cdn.example/c2.mp4' })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await generateVideo({ ...params, prompt: '@{image-b:图片 B} 跟随 @{audio-a:声音 A}，再看 @{image-a:图片 A}',
        seedanceDuration: 5, seedanceResolution: '720p', seedanceRatio: '9:16' });
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(body).toMatchObject({ model: 'sd-2.0-c2', prompt: '图片1 跟随 音频1，再看 图片2', references: [
        { type: 'image', url: 'https://cdn.example/b.png' }, { type: 'image', url: 'https://cdn.example/a.png' },
        { type: 'audio', url: 'https://cdn.example/a.mp3' },
      ] });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { image.mockRestore(); media.mockRestore(); constraints.mockRestore(); }
  });

  it('用户修改过的 C1 协议不继承内置编号转换', async () => {
    const selected = structuredClone(RELAYON_MODEL_MANIFEST.find((item) => item.id === 'sd-2.0-c1')!);
    selected.executionProfile!.protocol!.submit.path = '/custom/videos';
    useAppStore.getState().saveProviderConfig('relayon-user-protocol', {
      name: '自定义万象合同', catalogId: 'relayonapi', baseUrl: 'https://relayonapi.com/v1',
      apiKey: 'custom-fixture', selectedModels: [selected],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'relayon-user-protocol')!;
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray').mockImplementation(async (urls) => urls);
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'task-custom' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/custom.mp4' })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await generateVideo({ model: `general/${model.id}`, provider: 'general', prompt: '保持图片1的原始编号',
        seedanceDuration: 10, seedanceResolution: '720p', seedanceRatio: '16:9',
        referenceMedia: [{ kind: 'image', role: 'reference', origin: 'connection', url: 'https://cdn.example/person.png' }] });
      expect(fetchMock.mock.calls[0][0]).toBe('https://relayonapi.com/v1/custom/videos');
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).prompt).toBe('保持图片1的原始编号');
    } finally { image.mockRestore(); constraints.mockRestore(); }
  });

  it.each(['sd-2.0-A', 'sd-2.0-c1'])('%s 未开放的首帧输入在上传前拒绝', async (modelId) => {
    const params = configure(modelId);
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray');
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo({ ...params, seedanceDuration: 10, seedanceRatio: '16:9',
        referenceMedia: [{ kind: 'image', role: 'first_frame', origin: 'connection', url: 'data:image/png;base64,YQ==' }],
      })).rejects.toThrow('首尾帧');
      expect(image).not.toHaveBeenCalled();
      expect(media).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { image.mockRestore(); media.mockRestore(); }
  });
});

describe('角色图片与声音的最终请求对应', () => {
  const imageA = 'data:image/png;base64,YQ==';
  const imageB = 'data:image/png;base64,Yg==';
  const firstFrame = 'data:image/png;base64,Zmlyc3Q=';
  const lastFrame = 'data:image/png;base64,bGFzdA==';
  const voiceA = 'https://cdn.example/a.wav';
  const voiceB = 'https://cdn.example/b.wav';
  const voice = (id: string, clip = 'voice') => `@drama{${buildDramaVoiceMentionId(id, clip)}:旧标签}`;
  const picture = (id: string) => `@drama{${id}#portrait:旧标签}`;
  const ref = (url: string, kind: 'image' | 'audio' = 'image', role: 'reference' | 'first_frame' | 'last_frame' = 'reference') => ({
    kind, url, role: kind === 'audio' ? 'reference_audio' as const : role, origin: 'connection' as const,
  });

  function setCharacters(sameName = false) {
    const characters = ['a', 'b'].map((id, index) => ({
      id, kind: 'character', key: id, name: sameName ? '主角' : index === 0 ? '女主' : '男主',
      referenceImages: [{ id: 'portrait', kind: 'primary', imageUrl: index === 0 ? imageA : imageB, createdAt: 0 }],
      voiceClips: [{ id: 'voice', kind: index === 0 ? 'timbre' : 'emotion', audioUrl: index === 0 ? voiceA : voiceB,
        transcript: '样本对白不会自动写入', createdAt: 0, updatedAt: 0 }],
      primaryReferenceImageId: 'portrait', createdAt: 0, updatedAt: 0,
    }) as DramaCharacter);
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), characters } });
  }

  async function capture(prompt: string, referenceMedia: ReturnType<typeof ref>[] = []) {
    let captured: VideoGenerationReferenceInput | undefined;
    const unregister = mediaProviderRegistry.register({
      providerId: 'test-character-bindings', capabilities: ['video'],
      async generateVideo({ resolveReferenceInput }) {
        captured = await resolveReferenceInput();
        return { url: 'https://cdn.example/result.mp4' };
      },
    });
    try {
      await generateVideo({ prompt, provider: 'test-character-bindings', model: 'test', referenceMedia });
      return captured!;
    } finally {
      unregister();
    }
  }

  it('交错 @ 多个角色，按显式素材、去重与首尾帧排序后的数组建立对应', async () => {
    setCharacters();
    const input = await capture(`图片1是手写文字。${voice('b')} ${picture('a')} ${voice('a')} ${picture('b')} ${picture('a')}`, [
      ref(firstFrame, 'image', 'first_frame'), ref(lastFrame, 'image', 'last_frame'), ref(imageB), ref(voiceA, 'audio'),
    ]);
    expect(input.imageUrls).toEqual([firstFrame, imageB, imageA, lastFrame]);
    expect(input.audioUrls).toEqual([voiceA, voiceB]);
    expect(input.prompt).toContain('图片1是手写文字。男主〔角色1，音频2〕 女主〔角色2，图片3〕');
    expect(input.prompt).toContain('角色1「男主」：情绪参考：音频2；外观参考：图片2');
    expect(input.prompt).toContain('角色2「女主」：外观参考：图片3；音色参考：音频1');
    expect(input.prompt).not.toContain('旧标签');
    expect(input.prompt).not.toContain('样本对白不会自动写入');
    const variables = buildGeneralVideoProtocolVariables('test', { prompt: '', model: 'test', provider: 'general' }, input);
    expect(variables.prompt).toBe(input.prompt);
    expect(variables.imageUrls).toEqual(input.imageUrls);
    expect(variables.audioUrls).toEqual(input.audioUrls);
  });

  it('同名角色保持独立，重复素材去重后仍保留两份归属', async () => {
    setCharacters(true);
    const state = useAppStore.getState();
    useAppStore.setState({ dramaAssets: { ...state.dramaAssets, characters: state.dramaAssets.characters.map((character) => ({
      ...character, referenceImages: character.referenceImages!.map((image) => ({ ...image, imageUrl: imageA })),
    })) } });
    const input = await capture(`${picture('a')} ${voice('b')} ${picture('b')} ${voice('a')}`);
    expect(input.imageUrls).toEqual([imageA]);
    expect(input.prompt).toContain('角色1「主角」：外观参考：图片1；音色参考：音频2');
    expect(input.prompt).toContain('角色2「主角」：情绪参考：音频1；外观参考：图片1');
  });

  it('仅引用声音时不自动添加角色图片或其他声音', async () => {
    setCharacters();
    const input = await capture(voice('b'));
    expect(input.imageUrls).toEqual([]);
    expect(input.audioUrls).toEqual([voiceB]);
    expect(input.prompt).not.toContain('女主');
    expect(input.prompt).not.toContain('外观参考：');
  });

  it('同一角色的多张外观参考与声音合并到同一对应说明', async () => {
    setCharacters();
    const state = useAppStore.getState();
    useAppStore.setState({ dramaAssets: { ...state.dramaAssets, characters: state.dramaAssets.characters.map((character) => ({
      ...character, referenceImages: [...character.referenceImages!, {
        id: 'side', kind: 'turnaround' as const, imageUrl: imageB, prompt: '', createdAt: 0, updatedAt: 0,
      }],
    })) } });
    const input = await capture(`${picture('a')} ${voice('a')} @drama{a#side:女主侧面}`);
    expect(input.imageUrls).toEqual([imageA, imageB]);
    expect(input.prompt).toContain('角色1「女主」：外观参考：图片1、图片2；音色参考：音频1');
    expect(input.prompt).not.toContain('角色2');
  });

  it('本地媒体和同一远端来源去重时，编号按实际远端数组生成', async () => {
    const input = await resolvePromptWithMediaRefs('保留图片1', { preserveBindings: true });
    input.segments!.push({ reference: { ...ref('local-b'), sourceUrl: 'https://cdn.example/shared.png' } });
    const compiled = compileVideoReferencePrompt(input, [
      { ...ref('local-a'), sourceUrl: 'https://cdn.example/shared.png' }, { ...ref('local-b'), sourceUrl: 'https://cdn.example/shared.png' },
    ]);
    expect(compiled).toBe('保留图片1图片1');
    expect(compileVideoReferencePrompt(input, [ref('local-a'), ref('local-b')], { target: 'local' })).toBe('保留图片1图片2');
  });

  it('引用从最终请求中消失时拒绝编造编号', async () => {
    setCharacters();
    const input = await resolvePromptWithMediaRefs(picture('a'), { preserveBindings: true });
    expect(() => compileVideoReferencePrompt(input, [])).toThrow('引用素材未进入视频请求');
  });

  it('同一角色的多段声音保留独立用途，重复引用不重复添加对应说明', async () => {
    setCharacters();
    const state = useAppStore.getState();
    useAppStore.setState({ dramaAssets: { ...state.dramaAssets, characters: state.dramaAssets.characters.map((character) => ({
      ...character, voiceClips: [...character.voiceClips!, {
        id: 'line', kind: 'line' as const, audioUrl: 'https://cdn.example/line.wav', transcript: '样本里的话', createdAt: 0, updatedAt: 0,
      }],
    })) } });
    const input = await capture(`${voice('a')} ${voice('a', 'line')} ${voice('a')}`);
    expect(input.audioUrls).toEqual([voiceA, 'https://cdn.example/line.wav']);
    expect(input.prompt).toContain('角色1「女主」：音色参考：音频1；台词参考：音频2');
    expect(input.prompt.match(/音色参考：音频1/g)).toHaveLength(1);
    expect(input.prompt).not.toContain('样本里的话');
  });

  it('角色图片同时被选作独立首帧时使用字段语义而非虚构数组编号', async () => {
    setCharacters();
    const input = await resolvePromptWithMediaRefs(picture('a'), { preserveBindings: true });
    const result = compileVideoReferencePrompt(input, [ref(imageA, 'image', 'first_frame')], { imageLayout: 'frame-fields' });
    expect(result).toContain('外观参考：首帧图片');
    expect(result).not.toContain('图片1');
  });

  it('角色声音删除后在调用适配器提交前失败', async () => {
    setCharacters();
    await expect(capture(voice('a', 'removed'))).rejects.toThrow('角色音频引用已失效');
  });

  it('角色引用进入 ComfyUI 时带上对应说明，普通引用保持原行为', async () => {
    setCharacters();
    await generateVideo({ prompt: `${picture('a')} ${voice('a')}`, provider: 'comfyui', model: 'comfyui/test', workflowId: 'test' });
    expect(comfyMocks.executeVideo).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('角色1「女主」：外观参考：图片1；音色参考：音频1') }),
      undefined, [voiceA], { imageUrls: [imageA], videoUrls: [] },
    );
  });

  it.each(['doubao-seedance-2.0', 'MiniMax-H3'])('APIMart %s 的实际适配参数与角色编号对应', async (model) => {
    setCharacters();
    const state = useAppStore.getState();
    useAppStore.setState({ config: { ...state.config, providers: { ...state.config.providers, apimart: { name: 'APIMart', apiKey: 'test-key', baseUrl: 'https://api.example' } } } });
    const submit = vi.spyOn(apimartApi, 'generateApimartVideo').mockResolvedValue({ url: 'https://cdn.example/result.mp4',
      mediaDownloadAccess: { providerConfigId: 'apimart', origin: 'https://api.example', auth: { type: 'bearer' } } });
    const uploadImages = vi.spyOn(imageUtils, 'resolveImageUrlArray').mockImplementation(async (urls) => urls);
    const uploadMedia = vi.spyOn(uploadService, 'resolveMediaReferenceUrl').mockImplementation(async (url) => url);
    try {
      await generateVideo({ prompt: `${picture('a')} ${voice('a')}`, provider: 'apimart', model: `apimart/${model}`,
        referenceMedia: [ref(firstFrame, 'image', 'first_frame'), ref(lastFrame, 'image', 'last_frame')],
      });
      const args = submit.mock.calls[0];
      expect(args).toBeDefined();
      if (model === 'MiniMax-H3') {
        expect(args[5]).toMatchObject({ firstFrameUrl: firstFrame, lastFrameUrl: lastFrame, imageUrls: [imageA], audioUrls: [voiceA] });
        expect(args[3]).toContain('外观参考：图片1；音色参考：音频1');
      } else {
        expect(args[5]?.imageWithRoles?.map((reference) => reference.url)).toEqual([firstFrame, lastFrame, imageA]);
        expect(args[3]).toContain('外观参考：图片3；音色参考：音频1');
      }
    } finally {
      submit.mockRestore(); uploadImages.mockRestore(); uploadMedia.mockRestore();
    }
  });
});

describe('video prompt media references', () => {
  it('extracts mentioned audio nodes once as reference media', async () => {
    const audioNode: Node<BaseNodeData> = {
      id: 'audio-1',
      type: 'ai-audio',
      position: { x: 0, y: 0 },
      data: {
        label: '角色台词',
        type: 'ai-audio',
        audioUrl: 'https://cdn.example/dialogue.mp3',
      },
    };
    useAppStore.setState({ nodes: [audioNode] });

    const result = await resolvePromptWithMediaRefs(
      '让 @{audio-1:角色台词} 驱动画面，并保持 @{audio-1:角色台词} 的节奏',
    );

    expect(result).toEqual({
      prompt: '让 音频1 驱动画面，并保持 音频1 的节奏',
      references: [{
        kind: 'audio',
        url: 'https://cdn.example/dialogue.mp3',
        origin: 'prompt',
        role: 'reference_audio',
        sourceNodeId: 'audio-1',
        filePath: undefined,
        sourceUrl: undefined,
      }],
      imageUrls: [],
      videoUrls: [],
      audioUrls: ['https://cdn.example/dialogue.mp3'],
    });
  });

  it('keeps the image-generation resolver compatible with inline audio URLs', async () => {
    const audioNode: Node<BaseNodeData> = {
      id: 'audio-1',
      type: 'source-audio',
      position: { x: 0, y: 0 },
      data: {
        label: '参考声音',
        type: 'source-audio',
        audioUrl: 'https://cdn.example/reference.wav',
      },
    };
    useAppStore.setState({ nodes: [audioNode] });

    await expect(resolvePromptWithImageRefs('@{audio-1:参考声音}')).resolves.toEqual({
      prompt: 'https://cdn.example/reference.wav',
      imageUrls: [],
    });
  });

  it('falls back to the persisted local image when a generated source URL has expired', async () => {
    class UnreachableImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', UnreachableImage);

    const imageNode: Node<BaseNodeData> = {
      id: 'generated-image',
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: {
        label: '生成首帧',
        type: 'ai-image',
        imageUrl: 'asset://localhost/generated.png',
        sourceUrl: 'https://expired.example/generated.png',
        filePath: '/project/data/generated.png',
      },
    };
    useAppStore.setState({ nodes: [imageNode] });

    await expect(resolvePromptWithMediaRefs('@{generated-image:生成首帧}')).resolves.toEqual({
      prompt: '图片1',
      references: [{
        kind: 'image',
        url: 'asset://localhost/generated.png',
        origin: 'prompt',
        role: 'reference',
        sourceNodeId: 'generated-image',
        filePath: '/project/data/generated.png',
        sourceUrl: undefined,
      }],
      imageUrls: ['asset://localhost/generated.png'],
      videoUrls: [],
      audioUrls: [],
    });
  });

  it('passes mentioned audio into ComfyUI audio IO and deduplicates a matching edge', async () => {
    const audioNode: Node<BaseNodeData> = {
      id: 'audio-1',
      type: 'ai-audio',
      position: { x: 0, y: 0 },
      data: {
        label: '角色台词',
        type: 'ai-audio',
        audioUrl: 'https://cdn.example/dialogue.mp3',
      },
    };
    useAppStore.setState({
      nodes: [audioNode],
      edges: [{ id: 'audio-to-video', source: 'audio-1', target: 'video-1' }],
    });

    await generateVideo({
      model: 'comfyui/lipsync',
      provider: 'comfyui',
      prompt: '按照 @{audio-1:角色台词} 对口型',
      workflowId: 'lipsync',
      nodeId: 'video-1',
    });

    expect(comfyMocks.executeVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '按照 https://cdn.example/dialogue.mp3 对口型',
      }),
      undefined,
      ['https://cdn.example/dialogue.mp3'],
      { imageUrls: [], videoUrls: [] },
    );
  });

  it('converts user-facing seconds to workflow frames before ComfyUI execution', async () => {
    await generateVideo({
      model: 'comfyui/video',
      provider: 'comfyui',
      prompt: '生成视频',
      workflowId: 'video-workflow',
      videoFps: 30,
      seedanceDuration: 8,
      videoFrames: 77,
    });

    expect(comfyMocks.executeVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        videoFps: 30,
        seedanceDuration: 8,
        videoFrames: 241,
      }),
      undefined,
      [],
      { imageUrls: [], videoUrls: [] },
    );
  });

  it('collects all three connected media kinds and uses local copies for expiring uploads', () => {
    const imageNode: Node<BaseNodeData> = {
      id: 'image-1',
      type: 'source-image',
      position: { x: 0, y: 0 },
      data: {
        label: '首帧',
        type: 'source-image',
        imageUrl: 'asset://localhost/first.png',
        sourceUrl: 'https://cdn.example/first.png',
        filePath: 'C:\\project\\first.png',
      },
    };
    const videoNode: Node<BaseNodeData> = {
      id: 'video-ref',
      type: 'source-video',
      position: { x: 0, y: 0 },
      data: {
        label: '动作参考',
        type: 'source-video',
        videoUrl: 'asset://localhost/reference.mp4',
        sourceUrl: 'https://cdn.example/reference.mp4',
        filePath: 'C:\\project\\reference.mp4',
      },
    };
    const audioNode: Node<BaseNodeData> = {
      id: 'audio-ref',
      type: 'source-audio',
      position: { x: 0, y: 0 },
      data: {
        label: '声音参考',
        type: 'source-audio',
        audioUrl: 'asset://localhost/reference.wav',
        sourceUrl: 'https://cdn.example/reference.wav',
        filePath: 'C:\\project\\reference.wav',
      },
    };
    useAppStore.setState({
      nodes: [imageNode, videoNode, audioNode],
      edges: [
        { id: 'image-edge', source: 'image-1', target: 'video-1' },
        { id: 'video-edge', source: 'video-ref', target: 'video-1' },
        { id: 'audio-edge', source: 'audio-ref', target: 'video-1' },
      ],
    });

    const media = collectConnectedReferenceMedia('video-1');

    expect(media.imageUrls).toEqual(['asset://localhost/first.png']);
    expect(media.videoUrls).toEqual(['asset://localhost/reference.mp4']);
    expect(media.audioUrls).toEqual(['asset://localhost/reference.wav']);
    expect(media.references).toMatchObject([
      { kind: 'image', sourceNodeId: 'image-1', origin: 'connection' },
      { kind: 'video', sourceNodeId: 'video-ref', origin: 'connection' },
      { kind: 'audio', sourceNodeId: 'audio-ref', origin: 'connection' },
    ]);
    expect(getMediaReferenceUrls(media.references, 'audio', 'local')).toEqual([
      'asset://localhost/reference.wav',
    ]);
  });

  it('deduplicates by media kind and local URL while preserving first-source metadata', () => {
    const first = {
      kind: 'audio' as const,
      url: 'asset://localhost/reference.wav',
      origin: 'prompt' as const,
      role: 'reference_audio' as const,
      sourceNodeId: 'prompt-audio',
    };
    const merged = mergeMediaReferences(
      [first],
      [
        { ...first, origin: 'connection', sourceNodeId: 'connected-audio' },
        { ...first, kind: 'video', role: 'reference' },
      ],
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ origin: 'prompt', sourceNodeId: 'prompt-audio' });
    expect(merged[1].kind).toBe('video');
  });
});

describe('Volcengine Seedance content', () => {
  const reference = (
    kind: 'image' | 'video' | 'audio',
    url: string,
    role: 'reference' | 'first_frame' | 'last_frame' | 'reference_audio' = 'reference',
  ) => ({ kind, url, role, origin: 'connection' as const });

  it('adds provider roles to every multimodal reference', () => {
    expect(buildVolcengineVideoContent(
      '  推进镜头  ',
      [
        reference('image', 'character.png'),
        reference('video', 'motion.mp4'),
        reference('audio', 'music.mp3', 'reference_audio'),
      ],
      false,
    )).toEqual([
      { type: 'text', text: '推进镜头' },
      { type: 'image_url', image_url: { url: 'character.png' }, role: 'reference_image' },
      { type: 'video_url', video_url: { url: 'motion.mp4' }, role: 'reference_video' },
      { type: 'audio_url', audio_url: { url: 'music.mp3' }, role: 'reference_audio' },
    ]);
  });

  it('preserves explicit first and last frame roles only in frame mode', () => {
    expect(buildVolcengineVideoContent('', [
      reference('image', 'first.png', 'first_frame'),
      reference('image', 'last.png', 'last_frame'),
    ], true)).toEqual([
      { type: 'image_url', image_url: { url: 'first.png' }, role: 'first_frame' },
      { type: 'image_url', image_url: { url: 'last.png' }, role: 'last_frame' },
    ]);
  });

  it('keeps text-only parameters unchanged for Seedance 2.5', () => {
    expect(buildVolcengineVideoRequestBody(
      'doubao-seedance-2-5-260628',
      '纯文本生成',
      [],
      false,
      { seedanceResolution: '1080p', seedanceRatio: '9:16', seedanceDuration: 12 },
    )).toMatchObject({
      resolution: '1080p',
      ratio: '9:16',
      duration: 12,
      content: [{ type: 'text', text: '纯文本生成' }],
    });
  });

  it.each([
    { model: 'doubao-seedance-2-5-260628', duration: 19, expected: 19 },
    { model: 'doubao-seedance-2-5-260628', duration: 30, expected: 30 },
    { model: 'doubao-seedance-2-5-260628', duration: -1, expected: -1 },
    { model: 'doubao-seedance-2-5-260628', duration: undefined, expected: -1 },
    { model: 'doubao-seedance-2-5-260628', duration: undefined, frames: 721, expected: 30 },
    { model: 'doubao-seedance-2-5-260628', duration: 19, frames: 121, expected: 19 },
    { model: 'doubao-seedance-2-0-260128', duration: 15, expected: 15 },
    { model: 'doubao-seedance-2-0-260128', duration: 30, expected: 15 },
  ])('submits model-aware duration through node preprocessing: %o', async ({ model, duration, frames, expected }) => {
    const state = useAppStore.getState();
    useAppStore.setState({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          volcengine: {
            name: '火山方舟',
            apiKey: 'test-key',
            baseUrl: 'https://ark.example/api/v3',
          },
        },
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'seedance-task-30s' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'succeeded',
        content: { video_url: 'https://cdn.example/seedance-30s.mp4' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateVideo({
      provider: 'volcengine',
      model: `volcengine/${model}`,
      prompt: '连续三十秒的长镜头',
      ...resolveVideoSubmissionControls({
        provider: 'volcengine',
        seedanceDuration: duration,
        videoFrames: frames,
        seedanceResolution: '480p',
        seedanceRatio: '21:9',
      }),
    })).resolves.toEqual({ url: 'https://cdn.example/seedance-30s.mp4' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model,
      resolution: '480p',
      ratio: '21:9',
      duration: expected,
    });
  });

  it('uses official adaptive ratio and automatic duration defaults for Seedance 2.5', () => {
    expect(buildVolcengineVideoRequestBody(
      'doubao-seedance-2-5-260628',
      '由模型决定构图和时长',
      [],
      false,
      {},
    )).toMatchObject({
      resolution: '720p',
      ratio: 'adaptive',
      duration: -1,
    });
  });

  it('uses adaptive ratio for explicit first/last frame generation', () => {
    const body = buildVolcengineVideoRequestBody(
      'doubao-seedance-2-5-260628',
      '首尾帧转场',
      [
        reference('image', 'first.png', 'first_frame'),
        reference('image', 'last.png', 'last_frame'),
      ],
      true,
      { seedanceResolution: '720p', seedanceRatio: '16:9', seedanceDuration: 8 },
    );
    expect(body).toMatchObject({ ratio: 'adaptive', duration: 8 });
    expect(body).not.toHaveProperty('omni_reference_task_type');
  });

  it('uses auto omni mode while preserving dimensions for image/audio references', () => {
    expect(buildVolcengineVideoRequestBody(
      'doubao-seedance-2-5-260628',
      '参考角色和音乐生成',
      [
        reference('image', 'character.png'),
        reference('audio', 'music.mp3', 'reference_audio'),
      ],
      false,
      { seedanceResolution: '720p', seedanceRatio: '16:9', seedanceDuration: 15 },
    )).toMatchObject({
      omni_reference_task_type: 'auto',
      ratio: '16:9',
      duration: 15,
    });
  });

  it('uses the safe auto/adaptive/-1 combination whenever a reference video is present', () => {
    expect(buildVolcengineVideoRequestBody(
      'doubao-seedance-2-5-260628',
      '把视频中的人物替换成图片角色',
      [
        reference('video', 'source.mp4'),
        reference('image', 'character.png'),
      ],
      false,
      { seedanceResolution: '720p', seedanceRatio: '16:9', seedanceDuration: 20 },
    )).toMatchObject({
      omni_reference_task_type: 'auto',
      ratio: 'adaptive',
      duration: -1,
      content: [
        { type: 'text', text: '把视频中的人物替换成图片角色' },
        { type: 'video_url', video_url: { url: 'source.mp4' }, role: 'reference_video' },
        { type: 'image_url', image_url: { url: 'character.png' }, role: 'reference_image' },
      ],
    });
  });

  it('does not apply Seedance 2.5 omni overrides to Seedance 2.0 requests', () => {
    const body = buildVolcengineVideoRequestBody(
      'doubao-seedance-2-0-mini-260615',
      '参考图片生成',
      [reference('image', 'reference.png')],
      false,
      { seedanceResolution: '720p', seedanceRatio: '9:16', seedanceDuration: 10 },
    );
    expect(body).toMatchObject({ ratio: '9:16', duration: 10 });
    expect(body).not.toHaveProperty('omni_reference_task_type');
  });
});

describe('manual frame and character references', () => {
  it('treats connected images as references until the user explicitly assigns a frame role', () => {
    expect(resolveVideoParameterInputMode([], 0, { image: 1, video: 0, audio: 0 }))
      .toBe('reference');
    expect(resolveVideoParameterInputMode([{ role: 'first_frame' }], 0, { image: 0, video: 0, audio: 0 }))
      .toBe('keyframe');
    expect(resolveVideoParameterInputMode([{ role: 'last_frame' }], 1, { image: 0, video: 0, audio: 0 }))
      .toBe('mixed');
  });

  it('reorders references by the node 首帧/尾帧 picks and keeps 参考角色 as plain references', async () => {
    const imageNode = (id: string, url: string): Node<BaseNodeData> => ({
      id,
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: { label: id, type: 'ai-image', imageUrl: url },
    });
    const videoNode: Node<BaseNodeData> = {
      id: 'video-1',
      type: 'ai-video',
      position: { x: 0, y: 0 },
      data: {
        label: '镜头',
        type: 'ai-video',
        videoReferences: [
          { id: 'image-c', kind: 'frame', role: 'first_frame', url: 'https://cdn.example/c.png', sourceNodeId: 'image-c' },
          { id: 'image-a', kind: 'frame', role: 'last_frame', url: 'https://cdn.example/a.png', sourceNodeId: 'image-a' },
          { id: 'character:hero', kind: 'character', role: 'reference', url: 'https://cdn.example/hero.png', label: '主角' },
        ],
      },
    };
    useAppStore.setState({
      nodes: [
        imageNode('image-a', 'https://cdn.example/a.png'),
        imageNode('image-b', 'https://cdn.example/b.png'),
        imageNode('image-c', 'https://cdn.example/c.png'),
        videoNode,
      ],
      edges: ['image-a', 'image-b', 'image-c'].map((source) => ({
        id: `e-${source}`,
        source,
        target: 'video-1',
      })),
    });

    let captured: VideoGenerationReferenceInput | null = null;
    const unregister = mediaProviderRegistry.register({
      providerId: 'test-frame-role-provider',
      capabilities: ['video'],
      async generateVideo({ resolveReferenceInput }) {
        captured = await resolveReferenceInput();
        return { url: 'https://cdn.example/result.mp4' };
      },
    });

    try {
      await generateVideo({
        prompt: '推进镜头',
        model: 'test/frame-roles',
        provider: 'test-frame-role-provider',
        nodeId: 'video-1',
      });
    } finally {
      unregister();
    }

    const referenceInput = captured as VideoGenerationReferenceInput | null;
    // 首帧 → 参考角色/中间图 → 尾帧；连线里没被挑中的图仍按原顺序留在中间
    expect(referenceInput?.imageUrls).toEqual([
      'https://cdn.example/c.png',
      'https://cdn.example/hero.png',
      'https://cdn.example/b.png',
      'https://cdn.example/a.png',
    ]);
    expect(referenceInput?.references?.map((reference) => reference.role)).toEqual([
      'first_frame',
      'reference',
      'reference',
      'last_frame',
    ]);
  });

  it('tells the model which reference image the mentioned character name refers to', async () => {
    const videoNode: Node<BaseNodeData> = {
      id: 'video-1',
      type: 'ai-video',
      position: { x: 0, y: 0 },
      data: {
        label: '镜头',
        type: 'ai-video',
        videoReferences: [
          { id: 'img-a', kind: 'frame', role: 'first_frame', url: 'https://cdn.example/room.png' },
          { id: 'character:hero', kind: 'character', role: 'reference', url: 'https://cdn.example/hero.png', label: '女主·林夏' },
          { id: 'character:extra', kind: 'character', role: 'reference', url: 'https://cdn.example/extra.png', label: '路人甲' },
        ],
      },
    };
    useAppStore.setState({ nodes: [videoNode] });

    let captured: VideoGenerationReferenceInput | null = null;
    const unregister = mediaProviderRegistry.register({
      providerId: 'test-character-provider',
      capabilities: ['video'],
      async generateVideo({ resolveReferenceInput }) {
        captured = await resolveReferenceInput();
        return { url: 'https://cdn.example/result.mp4' };
      },
    });

    try {
      await generateVideo({
        prompt: '林夏推开门走进房间',
        model: 'test/character',
        provider: 'test-character-provider',
        nodeId: 'video-1',
      });
    } finally {
      unregister();
    }

    // 只标注被点名的角色，图号按最终提交顺序
    expect((captured as VideoGenerationReferenceInput | null)?.prompt)
      .toBe('林夏推开门走进房间\n\n（角色参考：图2 是林夏）');
  });

  it('leaves the prompt untouched when no character name is mentioned', () => {
    const items: VideoReferenceItem[] = [
      { id: 'character:hero', kind: 'character', role: 'reference', url: 'https://cdn.example/hero.png', label: '林夏' },
    ];
    expect(annotateCharacterReferences('推开门走进房间', items, ['https://cdn.example/hero.png']))
      .toBe('推开门走进房间');
  });

  it('adds a character library primary voice to the video reference audio request', async () => {
    const character = {
      id: 'hero', kind: 'character', name: '主角', primaryVoiceClipId: 'voice-main',
      voiceClips: [
        { id: 'voice-other', kind: 'timbre', audioUrl: 'https://cdn.example/other.wav' },
        { id: 'voice-main', kind: 'timbre', label: '主音色', audioUrl: 'https://cdn.example/main.wav' },
      ],
    } as DramaCharacter;
    const references = buildCharacterVideoReferences({
      id: 'character:hero', label: '主角', url: 'https://cdn.example/hero.png', character,
    });
    expect(references).toEqual([
      expect.objectContaining({ kind: 'character', role: 'reference', url: 'https://cdn.example/hero.png' }),
      expect.objectContaining({
        id: 'character:hero:voice', kind: 'character', mediaKind: 'audio',
        role: 'reference_audio', url: 'https://cdn.example/main.wav',
      }),
    ]);
    useAppStore.setState({ nodes: [{
      id: 'video-1', type: 'ai-video', position: { x: 0, y: 0 },
      data: { type: 'ai-video', label: '镜头', videoReferences: references },
    } as Node<BaseNodeData>] });
    let captured: VideoGenerationReferenceInput | undefined;
    const unregister = mediaProviderRegistry.register({
      providerId: 'test-character-voice-provider', capabilities: ['video'],
      async generateVideo({ resolveReferenceInput }) {
        captured = await resolveReferenceInput();
        return { url: 'https://cdn.example/result.mp4' };
      },
    });
    try {
      await generateVideo({
        prompt: '主角走入镜头', provider: 'test-character-voice-provider',
        model: 'test/character-voice', nodeId: 'video-1',
      });
    } finally {
      unregister();
    }
    expect(captured?.imageUrls).toEqual(['https://cdn.example/hero.png']);
    expect(captured?.audioUrls).toEqual(['https://cdn.example/main.wav']);
    expect(captured?.prompt).toContain('图1 是主角');
  });

  it('only adds an explicitly selected, available primary voice', () => {
    const character = {
      id: 'hero', kind: 'character', name: '主角',
      voiceClips: [{ id: 'other', kind: 'timbre', audioUrl: 'https://cdn.example/other.wav' }],
    } as DramaCharacter;
    const option = { id: 'character:hero', label: '主角', url: 'https://cdn.example/hero.png', character };
    expect(buildCharacterVideoReferences(option)).toHaveLength(1);
    character.primaryVoiceClipId = 'missing';
    expect(buildCharacterVideoReferences(option)).toHaveLength(1);
    character.primaryVoiceClipId = 'other';
    character.volcengineBinding = { projectName: 'default', imageAssetId: 'asset-1' };
    expect(buildCharacterVideoReferences(option, 'volcengine')).toEqual([
      expect.objectContaining({ id: 'character:hero:volcengine:asset-1', url: 'asset://asset-1' }),
      expect.objectContaining({
        id: 'character:hero:volcengine:asset-1:voice', mediaKind: 'audio',
        url: 'https://cdn.example/other.wav',
      }),
    ]);
  });

  it('keeps connected and mentioned images as plain references when no frame role was picked', async () => {
    const imageNode = (id: string, url: string): Node<BaseNodeData> => ({
      id,
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: { label: id, type: 'ai-image', imageUrl: url },
    });
    useAppStore.setState({
      nodes: [
        imageNode('image-a', 'https://cdn.example/a.png'),
        imageNode('image-b', 'https://cdn.example/b.png'),
        imageNode('image-c', 'https://cdn.example/c.png'),
        { id: 'video-1', type: 'ai-video', position: { x: 0, y: 0 }, data: { label: '镜头', type: 'ai-video' } },
      ],
      edges: ['image-a', 'image-b'].map((source) => ({ id: `e-${source}`, source, target: 'video-1' })),
    });

    let captured: VideoGenerationReferenceInput | null = null;
    const unregister = mediaProviderRegistry.register({
      providerId: 'test-frame-default-provider',
      capabilities: ['video'],
      async generateVideo({ resolveReferenceInput }) {
        captured = await resolveReferenceInput();
        return { url: 'https://cdn.example/result.mp4' };
      },
    });

    try {
      await generateVideo({
        prompt: '@{image-c:人物参考} 推进镜头',
        model: 'test/frame-default',
        provider: 'test-frame-default-provider',
        nodeId: 'video-1',
      });
    } finally {
      unregister();
    }

    const referenceInput = captured as VideoGenerationReferenceInput | null;
    expect(referenceInput?.imageUrls).toEqual([
      'https://cdn.example/c.png',
      'https://cdn.example/a.png',
      'https://cdn.example/b.png',
    ]);
    expect(referenceInput?.references?.map((reference) => reference.role))
      .toEqual(['reference', 'reference', 'reference']);
  });
});

describe('caller-supplied reference media', () => {
  // 剪辑窗口的 AI 转场没有画布节点可连线，只能直接把首/尾帧交给生成入口
  it('puts explicit references ahead of prompt references and keeps the frame roles', async () => {
    const imageNode: Node<BaseNodeData> = {
      id: 'image-1',
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: {
        label: '概念图',
        type: 'ai-image',
        imageUrl: 'https://cdn.example/concept.png',
      },
    };
    useAppStore.setState({ nodes: [imageNode] });

    let captured: VideoGenerationReferenceInput | null = null;
    const unregister = mediaProviderRegistry.register({
      providerId: 'test-transition-provider',
      capabilities: ['video'],
      async generateVideo({ resolveReferenceInput }) {
        captured = await resolveReferenceInput();
        return { url: 'https://cdn.example/transition.mp4' };
      },
    });

    try {
      await generateVideo({
        prompt: '穿过火光过渡 @{image-1:概念图}',
        model: 'test/transition',
        provider: 'test-transition-provider',
        referenceMedia: [
          { kind: 'image', url: 'asset://tail.png', origin: 'connection', role: 'first_frame' },
          { kind: 'image', url: 'asset://head.png', origin: 'connection', role: 'last_frame' },
        ],
      });
    } finally {
      unregister();
    }

    const referenceInput = captured as VideoGenerationReferenceInput | null;
    expect(referenceInput?.operation).toBe('image-to-video');
    expect(referenceInput?.imageUrls).toEqual([
      'asset://tail.png',
      'https://cdn.example/concept.png',
      'asset://head.png',
    ]);
    // 只有调用方明确指定的图片承担首尾帧，提示词中的图片保持普通参考。
    expect(referenceInput?.references?.[0]).toMatchObject({
      url: 'asset://tail.png',
      role: 'first_frame',
    });
    expect(referenceInput?.references?.[1]).toMatchObject({
      url: 'https://cdn.example/concept.png',
      role: 'reference',
    });
    expect(referenceInput?.references?.at(-1)).toMatchObject({
      url: 'asset://head.png',
      role: 'last_frame',
    });
  });
});

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

describe('video reference limits', () => {
  const input = (counts: { image?: number; video?: number; audio?: number }) => ({
    prompt: 'prompt',
    imageUrls: Array.from({ length: counts.image ?? 0 }, (_, i) => `https://cdn.example/i${i}.png`),
    videoUrls: Array.from({ length: counts.video ?? 0 }, (_, i) => `https://cdn.example/v${i}.mp4`),
    audioUrls: Array.from({ length: counts.audio ?? 0 }, (_, i) => `https://cdn.example/a${i}.mp3`),
    operation: 'image-to-video' as const,
  });

  it('rejects reference media beyond what the model declared', () => {
    const capability = { maxImageReferences: 9, maxVideoReferences: 0, maxAudioReferences: 0 };
    expect(() => assertVideoReferenceLimits(input({ image: 12 }), capability, 'Seedance 900'))
      .toThrow('模型 "Seedance 900" 最多支持 9 个参考图，当前有 12 个');
    expect(() => assertVideoReferenceLimits(input({ image: 1, video: 1 }), capability, 'Seedance 900'))
      .toThrow('不支持参考视频');
    // 正好到上限不拦
    expect(() => assertVideoReferenceLimits(input({ image: 9 }), capability, 'Seedance 900')).not.toThrow();
  });

  it('未声明上限的模型保持原有的不拦截行为', () => {
    expect(() => assertVideoReferenceLimits(input({ image: 30, video: 5 }), undefined, 'X')).not.toThrow();
    expect(() => assertVideoReferenceLimits(input({ image: 30 }), { maxDuration: 15 }, 'X')).not.toThrow();
  });
});

describe('离散时长校验', () => {
  const build = (seedanceDuration: number, capability?: { durations?: number[]; maxDuration?: number }) =>
    buildGeneralVideoProtocolVariables(
      'lec-ac-seedance-900-720p',
      { model: 'general/relay', provider: 'general', prompt: 'p', seedanceDuration },
      { prompt: 'p', imageUrls: [], videoUrls: [], audioUrls: [], operation: 'text-to-video' },
      capability,
    ).duration;

  it('拒绝不在模型允许档位内的时长，不静默改写用户请求', () => {
    expect(() => build(4, { durations: [10, 15] })).toThrow('不在模型支持的离散时长中');
    expect(() => build(13, { durations: [10, 15] })).toThrow('不在模型支持的离散时长中');
    expect(build(15, { durations: [10, 15] })).toBe(15);
    expect(() => build(4, { durations: [15] })).toThrow('不在模型支持的离散时长中');
  });

  it('没声明离散档位时保持原有的范围钳制', () => {
    expect(build(8, { maxDuration: 15 })).toBe(8);
    expect(build(8)).toBe(8);
  });
});

describe('general video runtime safety', () => {
  function configureSavedSora2u(catalogId: string, modelId: string, maximum?: number) {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, sora2u: { name: 'Saved connection', catalogId,
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

  it.each(['seedance-2.0', 'seedance-2.0-character'])('旧 Sora2U %s 配置在上传或付费提交前拦截联合超限', async (modelId) => {
    const params = configureSavedSora2u('sora2u', modelId);
    const images = vi.spyOn(imageUtils, 'resolveImageUrlArray');
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl');
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const beforeSubmit = vi.fn();
    try {
      await expect(generateVideo(params, undefined, beforeSubmit)).rejects.toThrow('参考视频和音频（合计）');
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
  ])('保留显式联合名额与精确厂商/型号边界（$catalogId/$modelId/$maximum）', async ({ catalogId, modelId, maximum }) => {
    const params = configureSavedSora2u(catalogId, modelId, maximum);
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: 'https://cdn.example/result.mp4' })));
    vi.stubGlobal('fetch', fetchMock);
    try {
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
