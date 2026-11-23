import type { Node } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { buildVolcengineVideoContent, buildVolcengineVideoRequestBody, generateVideo } from '../../../src/services/ai/generateVideo';
import { useAppStore } from '../../../src/store/useAppStore';
import type { BaseNodeData } from '../../../src/types';
import * as imageUtils from '../../../src/services/ai/imageUtils';
import * as uploadService from '../../../src/services/uploadService';
import * as fileService from '../../../src/services/fileService';
import * as videoInputValidation from '../../../src/services/ai/videoInputValidation';
import * as volcengineBilling from '../../../src/services/billing/volcengineBillingService';
import * as httpTransport from '../../../src/services/ai/httpTransport';
import { resolveVideoSubmissionControls } from '../../../src/services/ai/videoRequestResolver';
import { RELAYON_MODEL_MANIFEST } from '../../../src/services/ai/providers/relayonModelManifest';
import { MINIMAX_BASE_URL, MINIMAX_MODEL_MANIFEST } from '../../../src/services/ai/providers/minimaxModelManifest';
import { getPendingTasksForProject, removePendingTask } from '../../../src/services/pollManager';
import type { MediaReference, ProtocolJsonValue } from '../../../src/types/aiTypes';
import { setupVideoFixture } from './videoFixture';

const comfyMocks = vi.hoisted(() => ({
  executeVideo: vi.fn(),
}));

vi.mock('../../../src/services/comfyWorkflowService', () => ({
  executeComfyUIVideoGenerate: comfyMocks.executeVideo,
}));

setupVideoFixture(comfyMocks.executeVideo);

describe('自定义视频协议的参考文件直传', () => {
  const firstImage = 'https://media.example/first.png';
  const secondImage = 'asset://localhost/second.png';
  const video = 'asset://localhost/clip.mp4';
  const audio = 'asset://localhost/voice.mp3';
  const references: MediaReference[] = [
    { kind: 'image', role: 'reference', origin: 'connection', url: firstImage },
    { kind: 'image', role: 'reference', origin: 'connection', url: secondImage },
    { kind: 'video', role: 'reference', origin: 'connection', url: video },
    { kind: 'audio', role: 'reference_audio', origin: 'connection', url: audio },
  ];
  const files = {
    artwork: { $file: '{{referenceImageUrls}}' }, clip: { $file: '{{referenceVideoUrls.0}}' },
    soundtrack: { $file: '{{referenceAudioUrls.0}}' },
  };

  function configure(fields: Record<string, ProtocolJsonValue>) {
    useAppStore.getState().saveProviderConfig('custom-video-files', {
      name: '自定义视频', catalogId: 'custom-openai', baseUrl: 'https://gateway.example/v1', apiKey: 'custom-fixture',
      selectedModels: [{
        id: 'studio-video', name: 'Studio', category: 'video', provider: 'custom-openai',
        videoCapability: { operations: ['video-to-video'], maxImageReferences: 2, maxVideoReferences: 1, maxAudioReferences: 1 },
        executionProfile: { preset: 'custom', protocol: {
          version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/studio/render', bodyEncoding: 'multipart', body: { prompt: '{{prompt}}', ...fields } },
          response: { type: 'json', result: { urlPath: 'delivery.movie' } },
        } },
      }],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'custom-video-files')!;
    return { provider: 'general', model: `general/${model.id}`, prompt: '沿用参考素材', referenceMedia: references };
  }

  it.each([false, true])('保留自定义字段和文件顺序，同图另作 URL：%s', async (includeImageUrl) => {
    const params = configure(includeImageUrl ? { ...files, poster_url: '{{referenceImageUrls.0}}' } : files);
    const images = vi.spyOn(imageUtils, 'resolveImageDataUrlArray').mockImplementation(async (urls) =>
      urls.map((url) => {
        expect([firstImage, secondImage]).toContain(url);
        return `data:image/png;base64,${btoa(url === firstImage ? 'first' : 'second')}`;
      }));
    const read = vi.spyOn(fileService, 'readFileToDataUrl').mockImplementation(async (url) => {
      if (url === video) return 'data:video/mp4;base64,Y2xpcA==';
      if (url === audio) return 'data:audio/mpeg;base64,dm9pY2U=';
      throw new Error('读取了未选择的文件');
    });
    const publicImages = vi.spyOn(imageUtils, 'resolveImageUrlArray').mockImplementation(async (urls) => {
      expect(urls.every((url) => includeImageUrl && url === firstImage)).toBe(true);
      return urls;
    });
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl').mockImplementation(async (url) => {
      expect(includeImageUrl && url === firstImage).toBe(true);
      return url;
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ delivery: { movie: 'https://cdn.example/movie.mp4' } })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo(params)).resolves.toMatchObject({ url: 'https://cdn.example/movie.mp4' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [endpoint, init] = fetchMock.mock.calls[0];
      expect(endpoint).toBe('https://gateway.example/v1/studio/render');
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer custom-fixture');
      expect(new Headers(init.headers).get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
      const form = await new Response(init.body, { headers: init.headers }).formData();
      expect(await Promise.all(form.getAll('artwork').map((file) => (file as File).text()))).toEqual(['first', 'second']);
      expect(await (form.get('clip') as File).text()).toBe('clip');
      expect(await (form.get('soundtrack') as File).text()).toBe('voice');
      expect(form.get('poster_url')).toBe(includeImageUrl ? firstImage : null);
    } finally { images.mockRestore(); read.mockRestore(); publicImages.mockRestore(); media.mockRestore(); }
  });

  it('参考图读取失败时停止，尚未提交生成', async () => {
    const params = configure(files);
    const images = vi.spyOn(imageUtils, 'resolveImageDataUrlArray').mockRejectedValue(new Error('参考图读取失败'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo(params)).rejects.toThrow('参考图读取失败');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { images.mockRestore(); }
  });

  it('协议只接收视频时，请求中同时选的图片和音频在素材读取或上传前报告', async () => {
    const params = configure({ clip: files.clip });
    const images = vi.spyOn(imageUtils, 'resolveImageDataUrlArray');
    const read = vi.spyOn(fileService, 'readFileToDataUrl');
    const publicImages = vi.spyOn(imageUtils, 'resolveImageUrlArray');
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo(params)).rejects.toThrow(/没有完整接收/);
      expect(images).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(publicImages).not.toHaveBeenCalled();
      expect(media).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { images.mockRestore(); read.mockRestore(); publicImages.mockRestore(); media.mockRestore(); }
  });
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
  async function submittedVideoForm(init: RequestInit): Promise<FormData> {
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer relayon-video-fixture');
    if (init.body instanceof FormData) return init.body;
    expect(new Headers(init.headers).get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
    return new Response(init.body, { headers: init.headers }).formData();
  }
  async function fileContents(form: FormData, field: string): Promise<string[]> {
    return Promise.all(form.getAll(field).map((file) => (file as File).text()));
  }

  function configure(modelId: string, baseUrl = 'https://relayonapi.com/v1') {
    const selected = RELAYON_MODEL_MANIFEST.find((item) => item.id === modelId)!;
    useAppStore.getState().saveProviderConfig('relayon-video-alias', {
      name: '我的万象视频', catalogId: 'relayonapi', baseUrl,
      apiKey: 'relayon-video-fixture', selectedModels: [selected],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'relayon-video-alias')!;
    return { model: `general/${model.id}`, provider: 'general', prompt: '缓慢推进的镜头' };
  }

  it.each([
    { modelId: 'doubao-seedance-2-0-260128', ratio: '4:3', body: { metadata: { ratio: '4:3' } } },
    { modelId: 'sd-2.0-A', ratio: '9:16', body: { aspect_ratio: '9:16' } },
    { modelId: 'sd-2.5-c1', ratio: '4:3', body: { aspect_ratio: '4:3' } },
  ])('旧 $modelId 单比例快照允许选择 $ratio 并按原渠道提交', async ({ modelId, ratio, body }) => {
    const params = configure(modelId);
    const id = params.model.slice('general/'.length);
    const saved = useAppStore.getState().config.generalModels!.find((item) => item.id === id)!;
    useAppStore.getState().updateGeneralModel(id, { videoCapability: {
      ...saved.videoCapability, ratios: ['16:9'], defaultRatio: '16:9',
    } });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'legacy-ratio-task' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/legacy-ratio.mp4' })));
    if (modelId.startsWith('sd-')) fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateVideo({ ...params, seedanceDuration: modelId === 'sd-2.5-c1' ? 30 : 10, seedanceResolution: '720p', seedanceRatio: ratio }))
      .resolves.toMatchObject({ url: modelId.startsWith('sd-') ? 'data:video/mp4;base64,AQID' : 'https://cdn.example/legacy-ratio.mp4' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://relayonapi.com/v1/videos', 'https://relayonapi.com/v1/videos/legacy-ratio-task',
      ...(modelId.startsWith('sd-') ? ['https://relayonapi.com/v1/videos/legacy-ratio-task/content'] : []),
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({ model: modelId, ...body });
    expect(useAppStore.getState().config.generalModels!.find((item) => item.id === id)?.videoCapability?.ratios)
      .toEqual(['16:9']);
  });

  it.each([15, 20, 25, 30])('H3 旧档位 %s 秒仅 15 秒提交并按原任务鉴权取件，其余在提交前拒绝', async (duration) => {
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
      if (duration !== 15) {
        await expect(generateVideo({ ...params, nodeId: 'relayon-h3-node', seedanceDuration: duration,
          seedanceResolution: '2K', seedanceRatio: '4:3' })).rejects.toThrow(/时长|秒/);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(getPendingTasksForProject('relayon-h3-project')).toEqual([]);
        return;
      }
      const result = await generateVideo({ ...params, nodeId: 'relayon-h3-node', seedanceDuration: duration,
        seedanceResolution: '2K', seedanceRatio: '4:3' });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ model: 'minimax-h3',
        prompt: params.prompt, duration, resolution: '2k', aspect_ratio: '4:3', references: [] });
      expect(result).toMatchObject({ url: 'data:video/mp4;base64,AQID', taskReceipt: { taskId: 'h3-original-task' } });
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://relayonapi.com/v1/videos',
        'https://relayonapi.com/v1/videos/h3-original-task', 'https://relayonapi.com/v1/videos/h3-original-task/content']);
      for (const [, init] of fetchMock.mock.calls) expect(new Headers(init.headers).get('Authorization')).toBe('Bearer relayon-video-fixture');
      expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Idempotency-Key')).toBeTruthy();
      expect(new Headers(fetchMock.mock.calls[2][1].headers).get('Idempotency-Key')).toBeNull();
      expect(getPendingTasksForProject('relayon-h3-project')[0]).toMatchObject({ taskId: 'h3-original-task', providerConfigId: 'relayon-video-alias', mediaRecoveryState: 'delivery_pending' });
    } finally { removePendingTask('relayon-h3-node'); }
  });

  it.each([4, 16, 21, 29, 31])('H3 非档位 %s 秒在上传和生成之前拒绝', async (duration) => {
    const params = configure('minimax-h3');
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray');
    const inline = vi.spyOn(imageUtils, 'resolveImageDataUrlArray');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo({ ...params, seedanceDuration: duration, seedanceResolution: '720p', seedanceRatio: '16:9',
        referenceMedia: [{ kind: 'image', role: 'reference', origin: 'connection', url: 'data:image/png;base64,YQ==' }],
      })).rejects.toThrow(/时长|秒/);
      expect(image).not.toHaveBeenCalled();
      expect(inline).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { image.mockRestore(); inline.mockRestore(); }
  });

  it('C3 参考图片保留顺序，编号转换为文档的 @图，完成后鉴权取件', async () => {
    const params = configure('sd-2.0-c3');
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray').mockImplementation(async (urls) => urls);
    const inline = vi.spyOn(imageUtils, 'resolveImageDataUrlArray').mockRejectedValue(new Error('纯 HTTPS 不应读取参考图片'));
    const read = vi.spyOn(fileService, 'readFileToDataUrl').mockRejectedValue(new Error('纯 HTTPS 不应下载参考文件'));
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl').mockImplementation(async (url) => url);
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'c3-task' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' })))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo({ ...params, prompt: '图片1与图片2保持外观', seedanceDuration: 15,
        seedanceResolution: '720p', seedanceRatio: '1:1', referenceMedia: [
          { kind: 'image', role: 'reference', origin: 'connection', url: 'https://cdn.example/i.png' },
          { kind: 'image', role: 'reference', origin: 'connection', url: 'https://cdn.example/i2.png' },
        ] })).resolves.toMatchObject({ url: 'data:video/mp4;base64,AQID' });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ model: 'sd-2.0-c3', prompt: '@图1与@图2保持外观',
        duration: 15, resolution: '720p', aspect_ratio: '1:1', references: [
          { type: 'image', url: 'https://cdn.example/i.png' }, { type: 'image', url: 'https://cdn.example/i2.png' },
        ] });
      expect(image).not.toHaveBeenCalled();
      expect(inline).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally { image.mockRestore(); inline.mockRestore(); read.mockRestore(); media.mockRestore(); constraints.mockRestore(); }
  });

  it.each([5, 10, 15])('C3 的 %s 秒音频输入优先校验素材限制，在上传与提交前拒绝', async (duration) => {
    const params = configure('sd-2.0-c3');
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray');
    const inline = vi.spyOn(imageUtils, 'resolveImageDataUrlArray');
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo({ ...params, prompt: '图片1按音频1说话', seedanceDuration: duration, seedanceRatio: '1:1',
        referenceMedia: [
          { kind: 'image', role: 'reference', origin: 'connection', url: 'https://cdn.example/i.png' },
          { kind: 'audio', role: 'reference_audio', origin: 'connection', url: 'data:audio/mpeg;base64,YQ==' },
        ] })).rejects.toThrow('参考音频');
      expect(image).not.toHaveBeenCalled();
      expect(inline).not.toHaveBeenCalled();
      expect(media).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { image.mockRestore(); inline.mockRestore(); media.mockRestore(); }
  });

  it.each([
    ['sd-2.0-c1', 10], ['sd-2.0-c2', 5], ['sd-2.0-c3', 10], ['minimax-h3', 20],
    ['sd-2.5-c1', 7], ['sd-2.5-c2', 7], ['sd-2.5-c3', 7],
  ] as const)('%s 历史输入保留的 %s 秒在任何上传和提交之前拒绝', async (modelId, duration) => {
    const params = configure(modelId);
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray');
    const inline = vi.spyOn(imageUtils, 'resolveImageDataUrlArray');
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo({ ...params, seedanceDuration: duration, seedanceResolution: '720p', seedanceRatio: '16:9',
        referenceMedia: [{ kind: 'image', role: 'reference', origin: 'connection', url: 'data:image/png;base64,YQ==' }],
      })).rejects.toThrow(/时长|秒/);
      expect(image).not.toHaveBeenCalled();
      expect(inline).not.toHaveBeenCalled();
      expect(media).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { image.mockRestore(); inline.mockRestore(); media.mockRestore(); }
  });

  it.each(['sd-2.5-c1', 'sd-2.5-c2', 'sd-2.5-c3'])('%s 沿用 2.5 C1 顶层参数提交 30 秒／21:9 并保持当前连接身份', async (modelId) => {
    const params = configure(modelId);
    const taskId = `${modelId}-original`;
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: taskId })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' })))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateVideo({ ...params, seedanceDuration: 30, seedanceResolution: '720p', seedanceRatio: '21:9' });
    expect(result.url).toBe('data:video/mp4;base64,AQID');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ model: modelId, prompt: params.prompt,
      seconds: '30', resolution: '720p', aspect_ratio: '21:9', references: [] });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer relayon-video-fixture' });
    expect(fetchMock.mock.calls[1][0]).toBe(`https://relayonapi.com/v1/videos/${taskId}`);
    expect(fetchMock.mock.calls[2][0]).toBe(`https://relayonapi.com/v1/videos/${taskId}/content`);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(['sd-2.5-c1', 'sd-2.5-c2', 'sd-2.5-c3'])('%s 固定 30 秒并保留 HTTPS 音视频参考，不套用 2.0 C2／C3 的素材限制', async (modelId) => {
    const params = configure(modelId);
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray').mockImplementation(async (urls) => urls);
    const inline = vi.spyOn(imageUtils, 'resolveImageDataUrlArray').mockRejectedValue(new Error('纯 HTTPS 不应读取参考图片'));
    const read = vi.spyOn(fileService, 'readFileToDataUrl').mockRejectedValue(new Error('纯 HTTPS 不应下载参考文件'));
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl').mockImplementation(async (url) => url);
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sd25-reference-task' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' })))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await generateVideo({ ...params, prompt: '图片1参考视频1与音频1', seedanceDuration: 30,
        seedanceResolution: '720p', seedanceRatio: '21:9', referenceMedia: [
          { kind: 'image', role: 'reference', origin: 'connection', url: 'https://cdn.example/i.png' },
          { kind: 'video', role: 'reference', origin: 'connection', url: 'https://cdn.example/v.mp4' },
          { kind: 'audio', role: 'reference_audio', origin: 'connection', url: 'https://cdn.example/a.mp3' },
        ] });
      expect(result.url).toBe('data:video/mp4;base64,AQID');
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ model: modelId,
        prompt: '@图1参考@视频1与@音频1', seconds: '30', resolution: '720p', aspect_ratio: '21:9', references: [
          { type: 'image', url: 'https://cdn.example/i.png', role: 'reference' },
          { type: 'video', url: 'https://cdn.example/v.mp4' }, { type: 'audio', url: 'https://cdn.example/a.mp3' },
        ] });
      expect(image).not.toHaveBeenCalled();
      expect(inline).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer relayon-video-fixture' });
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://relayonapi.com/v1/videos',
        'https://relayonapi.com/v1/videos/sd25-reference-task', 'https://relayonapi.com/v1/videos/sd25-reference-task/content']);
    } finally { image.mockRestore(); inline.mockRestore(); read.mockRestore(); media.mockRestore(); constraints.mockRestore(); }
  });

  it.each(['sd-2.0-A', 'sd-2.5-A', 'minimax-h3'])('%s 本地图片、视频和音频直接编为万象文件，不调用公共图片上传', async (modelId) => {
    const params = configure(modelId);
    const duration = RELAYON_MODEL_MANIFEST.find((model) => model.id === modelId)!.videoCapability!.defaultDuration!;
    const image = vi.spyOn(imageUtils, 'resolveImageDataUrlArray');
    const publicImages = vi.spyOn(imageUtils, 'resolveImageUrlArray').mockRejectedValue(new Error('不得调用公共图片上传'));
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl');
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'local-media-task' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' })))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await generateVideo({ ...params, prompt: '图片1参考视频1和音频1', seedanceDuration: duration,
        seedanceResolution: '720p', seedanceRatio: '16:9', referenceMedia: [
          { kind: 'image', role: 'reference', origin: 'connection', url: 'data:image/png;base64,aW1hZ2UtMQ==' },
          { kind: 'video', role: 'reference', origin: 'connection', url: 'data:video/mp4;base64,dmlkZW8=' },
          { kind: 'audio', role: 'reference_audio', origin: 'connection', url: 'data:audio/mpeg;base64,YXVkaW8=' },
        ] });
      expect(result.url).toBe('data:video/mp4;base64,AQID');
      const form = await submittedVideoForm(fetchMock.mock.calls[0][1]);
      expect(form.get('model')).toBe(modelId);
      expect(form.get(modelId.endsWith('-A') ? 'seconds' : 'duration')).toBe(String(duration));
      expect(await fileContents(form, 'image')).toEqual(['image-1']);
      expect(await fileContents(form, 'video')).toEqual(['video']);
      expect(await fileContents(form, 'audio')).toEqual(['audio']);
      expect(form.has('references')).toBe(false);
      expect(image).not.toHaveBeenCalled();
      expect(media).not.toHaveBeenCalled();
      expect(publicImages).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://relayonapi.com/v1/videos',
        'https://relayonapi.com/v1/videos/local-media-task', 'https://relayonapi.com/v1/videos/local-media-task/content']);
    } finally { image.mockRestore(); publicImages.mockRestore(); media.mockRestore(); constraints.mockRestore(); }
  });

  it.each(['explicit', 'connected'] as const)('%s 参考优先 filePath，同类 HTTPS 与本地素材统一为文件并保留编号顺序', async (sourceMode) => {
    const params = configure('sd-2.0-c1');
    const kinds = ['image', 'video', 'audio'] as const;
    const extension = { image: 'png', video: 'mp4', audio: 'mp3' };
    const localPath = (kind: typeof kinds[number]) => `C:/fixture/mixed-${kind}.${extension[kind]}`;
    const localUrl = (kind: typeof kinds[number]) => `asset://localhost/${encodeURIComponent(localPath(kind))}`;
    const remoteUrl = (kind: typeof kinds[number]) => `https://cdn.example/remote-${kind}.${extension[kind]}`;
    const references: MediaReference[] = kinds.flatMap((kind) => ['remote', 'local'].map((source): MediaReference => ({
      kind, role: kind === 'audio' ? 'reference_audio' : 'reference', origin: 'connection',
      url: source === 'remote' ? remoteUrl(kind) : `https://expired.example/local-${kind}.${extension[kind]}`,
      ...(source === 'local' ? { filePath: localPath(kind) } : {}),
    })));
    const sources: Node<BaseNodeData>[] = references.map((reference, index) => ({
      id: `mixed-source-${index}`, type: `source-${reference.kind}`, position: { x: 0, y: 0 },
      data: { label: `素材 ${index + 1}`, type: `source-${reference.kind}`, filePath: reference.filePath,
        sourceUrl: reference.url, [`${reference.kind}Url`]: reference.url },
    }));
    useAppStore.setState({ nodes: sourceMode === 'connected' ? sources : [],
      edges: sourceMode === 'connected' ? sources.map((node) => ({ id: `edge-${node.id}`, source: node.id, target: 'mixed-target' })) : [] });
    const assets = vi.spyOn(fileService, 'getAssetUrlFromPath').mockImplementation(async (path) => `asset://localhost/${encodeURIComponent(path)}`);
    const image = vi.spyOn(imageUtils, 'resolveImageDataUrlArray');
    const publicImages = vi.spyOn(imageUtils, 'resolveImageUrlArray').mockRejectedValue(new Error('不得调用公共图片上传'));
    const read = vi.spyOn(fileService, 'readFileToDataUrl');
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    const endpoint = 'https://relayonapi.com/v1/videos';
    const mime = { image: 'image/png', video: 'video/mp4', audio: 'audio/mpeg' };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === endpoint && init?.method === 'POST') return Response.json({ id: 'mixed-files-task' });
      if (url === endpoint + '/mixed-files-task') return Response.json({ status: 'completed' });
      if (url === endpoint + '/mixed-files-task/content') return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } });
      const kind = kinds.find((item) => url === remoteUrl(item) || url === localUrl(item));
      if (!kind) throw new Error('读取了未选择的素材');
      return new Response(`${kind}-${url === remoteUrl(kind) ? 1 : 2}`, { headers: { 'Content-Type': mime[kind] } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await generateVideo({ ...params, prompt: '图片1与图片2参考视频1、视频2和音频1、音频2', seedanceDuration: 15,
        seedanceResolution: '720p', seedanceRatio: '16:9',
        ...(sourceMode === 'explicit' ? { referenceMedia: references } : { nodeId: 'mixed-target' }),
      });
      const submit = fetchMock.mock.calls.find(([url]) => url === endpoint);
      const form = await submittedVideoForm(submit![1]!);
      expect(form.get('prompt')).toBe('@图1与@图2参考@视频1、@视频2和@音频1、@音频2');
      expect(image).not.toHaveBeenCalled();
      expect(await fileContents(form, 'images')).toEqual(['image-1', 'image-2']);
      expect(await fileContents(form, 'videos')).toEqual(['video-1', 'video-2']);
      expect(await fileContents(form, 'audios')).toEqual(['audio-1', 'audio-2']);
      expect(form.has('references')).toBe(false);
      expect(assets.mock.calls.map(([path]) => path)).toEqual(kinds.map(localPath));
      expect(read).not.toHaveBeenCalled();
      expect(constraints.mock.calls[0][0]).toMatchObject({
        videoUrls: [remoteUrl('video'), localUrl('video')], audioUrls: [remoteUrl('audio'), localUrl('audio')],
      });
      expect(publicImages).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(9);
    } finally {
      assets.mockRestore(); image.mockRestore(); publicImages.mockRestore(); read.mockRestore(); constraints.mockRestore();
      removePendingTask('mixed-target');
    }
  });

  it('本地视频搭配非 HTTPS 图片时，在读取视频与提交前拒绝', async () => {
    const params = configure('sd-2.0-c1');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateVideo({ ...params, seedanceDuration: 15, referenceMedia: [
      { kind: 'video', role: 'reference', origin: 'connection', url: 'asset://localhost/clip.mp4' },
      { kind: 'image', role: 'reference', origin: 'connection', url: 'http://cdn.example/reference.jpg' },
    ] })).rejects.toThrow('HTTPS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['sd-2.5-c1', 'sd-2.5-c2', 'sd-2.5-c3'])('%s 本地音视频在读取素材和提交前拒绝，不回退图床也不妨碍 HTTPS 合同', async (modelId) => {
    const params = configure(modelId);
    const image = vi.spyOn(imageUtils, 'resolveImageDataUrlArray');
    const publicImages = vi.spyOn(imageUtils, 'resolveImageUrlArray');
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      for (const kind of ['video', 'audio'] as const) {
        await expect(generateVideo({ ...params, prompt: '图片1参考视频1和音频1', seedanceDuration: 30,
          seedanceResolution: '720p', seedanceRatio: '16:9', referenceMedia: [
            { kind: 'image', role: 'reference', origin: 'connection', url: 'https://cdn.example/person.png' },
            { kind, role: kind === 'audio' ? 'reference_audio' : 'reference', origin: 'connection',
              url: kind === 'video' ? 'data:video/mp4;base64,YQ==' : 'data:audio/mpeg;base64,YQ==' },
          ] })).rejects.toThrow(/万象|RelayOn/);
      }
      expect(image).not.toHaveBeenCalled();
      expect(publicImages).not.toHaveBeenCalled();
      expect(media).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { image.mockRestore(); publicImages.mockRestore(); media.mockRestore(); }
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

  it('保留已有万象自定义地址的 C1 文件直传，不把请求转到官方端点', async () => {
    const baseUrl = 'https://relay.example/v1';
    const params = configure('sd-2.0-c1', baseUrl);
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray').mockImplementation(async (urls) => urls);
    const inline = vi.spyOn(imageUtils, 'resolveImageDataUrlArray').mockRejectedValue(new Error('纯 HTTPS 图片应保留 URL'));
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl').mockImplementation(async (url) => url);
    const constraints = vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'task-relayon-c1' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' })))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await generateVideo({ ...params, prompt: '图片1参考视频1和音频1',
        seedanceDuration: 15, seedanceResolution: '720p', seedanceRatio: '9:16', referenceMedia: [
          { kind: 'image', role: 'reference', origin: 'connection', url: 'https://cdn.example/person.png' },
          { kind: 'video', role: 'reference', origin: 'connection', url: 'data:video/mp4;base64,dmlkZW8=' },
          { kind: 'audio', role: 'reference_audio', origin: 'connection', url: 'data:audio/mpeg;base64,YXVkaW8=' },
        ] });
      expect(result.url).toBe('data:video/mp4;base64,AQID');
      expect(media).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ provider: 'relayon-video-alias', mode: 'dataUrl', kind: 'video' }));
      expect(media).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ provider: 'relayon-video-alias', mode: 'dataUrl', kind: 'audio' }));
      const form = await submittedVideoForm(fetchMock.mock.calls[0][1]);
      expect(form.get('model')).toBe('sd-2.0-c1');
      expect(form.get('duration')).toBe('15');
      expect(form.get('resolution')).toBe('720p');
      expect(form.get('aspect_ratio')).toBe('9:16');
      expect(form.has('image')).toBe(false);
      expect(image).not.toHaveBeenCalled();
      expect(inline).not.toHaveBeenCalled();
      expect(await fileContents(form, 'video')).toEqual(['video']);
      expect(await fileContents(form, 'audio')).toEqual(['audio']);
      expect(String(form.get('prompt'))).toContain('@图1');
      expect(String(form.get('prompt'))).not.toContain('@@');
      expect(form.has('metadata')).toBe(false);
      expect(JSON.parse(String(form.get('references')))).toEqual([{ type: 'image', url: 'https://cdn.example/person.png' }]);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        baseUrl + '/videos', baseUrl + '/videos/task-relayon-c1', baseUrl + '/videos/task-relayon-c1/content',
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      image.mockRestore(); inline.mockRestore(); media.mockRestore(); constraints.mockRestore();
    }
  });

  it('C2 不支持的参考视频在上传和生成请求之前拒绝', async () => {
    const params = configure('sd-2.0-c2');
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo({ ...params, seedanceDuration: 15, seedanceResolution: '720p', seedanceRatio: '16:9',
        referenceMedia: [{ kind: 'video', role: 'reference', origin: 'connection', url: 'https://cdn.example/not-allowed.mp4' }],
      })).rejects.toThrow(/视频|video/);
      expect(media).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { media.mockRestore(); }
  });

  it('C2 画布引用按实际素材顺序生成文档要求的 @图／@音频编号', async () => {
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' })))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await generateVideo({ ...params, prompt: '@{image-b:图片 B} 跟随 @{audio-a:声音 A}，再看 @{image-a:图片 A}',
        seedanceDuration: 15, seedanceResolution: '720p', seedanceRatio: '9:16' });
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(body).toMatchObject({ model: 'sd-2.0-c2', prompt: '@图1 跟随 @音频1，再看 @图2', references: [
        { type: 'image', url: 'https://cdn.example/b.png' }, { type: 'image', url: 'https://cdn.example/a.png' },
        { type: 'audio', url: 'https://cdn.example/a.mp3' },
      ] });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally { image.mockRestore(); media.mockRestore(); constraints.mockRestore(); }
  });

  it('用户修改过的 C1 协议不继承内置编号转换', async () => {
    const selected = structuredClone(RELAYON_MODEL_MANIFEST.find((item) => item.id === 'sd-2.0-c1')!);
    const protocol = selected.executionProfile!.protocol!;
    if (protocol.version !== 2) throw new Error('测试需要当前版本的异步视频协议');
    protocol.submit.path = '/custom/videos';
    protocol.poll!.response.result = { urlPath: 'url', mimeType: 'video/mp4' };
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
        seedanceDuration: 15, seedanceResolution: '720p', seedanceRatio: '16:9',
        referenceMedia: [{ kind: 'image', role: 'reference', origin: 'connection', url: 'https://cdn.example/person.png' }] });
      expect(fetchMock.mock.calls[0][0]).toBe('https://relayonapi.com/v1/custom/videos');
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).prompt).toBe('保持图片1的原始编号');
    } finally { image.mockRestore(); constraints.mockRestore(); }
  });

  it.each(['sd-2.0-A', 'sd-2.0-c1'])('%s 未开放的首帧输入在上传前拒绝', async (modelId) => {
    const params = configure(modelId);
    const image = vi.spyOn(imageUtils, 'resolveImageUrlArray');
    const inline = vi.spyOn(imageUtils, 'resolveImageDataUrlArray');
    const media = vi.spyOn(uploadService, 'resolveMediaReferenceUrl');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateVideo({ ...params, seedanceDuration: 15, seedanceRatio: '16:9',
        referenceMedia: [{ kind: 'image', role: 'first_frame', origin: 'connection', url: 'data:image/png;base64,YQ==' }],
      })).rejects.toThrow('首尾帧');
      expect(image).not.toHaveBeenCalled();
      expect(inline).not.toHaveBeenCalled();
      expect(media).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { image.mockRestore(); inline.mockRestore(); media.mockRestore(); }
  });
});

describe('Volcengine Seedance content', () => {
  const reference = (
    kind: 'image' | 'video' | 'audio',
    url: string,
    role: 'reference' | 'first_frame' | 'last_frame' | 'reference_audio' = 'reference',
  ) => ({ kind, url, role, origin: 'connection' as const });

  it('redacts echoed TOS URLs and Ark Key before a rejected video submission leaves the provider', async () => {
    const url = 'https://private-bucket.tos-cn-beijing.ivolces.com/ref.mp4?X-Tos-Credential=fixtureAK&X-Tos-Signature=fixtureSignature';
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      volcengine: { name: '方舟测试', apiKey: 'ark-key', baseUrl: 'https://ark.example/api/v3' },
    } } }));
    const request = vi.spyOn(httpTransport, 'corsSafeFetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: `Download failed ${url} ${encodeURIComponent(url)} ark-key Request id: video-submit-1` },
    }), { status: 400 }));
    const billing = vi.spyOn(volcengineBilling, 'createBillingRun').mockResolvedValue(null);
    const update = vi.spyOn(volcengineBilling, 'updateBillingRun').mockResolvedValue(null);
    try {
      await expect(generateVideo({ provider: 'volcengine', model: 'volcengine/doubao-seedance-2-5-260628', prompt: '保留动作' }))
        .rejects.toThrow('Download failed [REDACTED] [REDACTED] [REDACTED] Request id: video-submit-1');
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[2]).toEqual({ sensitive: true });
      expect(update).toHaveBeenLastCalledWith(null, expect.objectContaining({ status: 'failed',
        errorMessage: 'Download failed [REDACTED] [REDACTED] [REDACTED] Request id: video-submit-1',
      }));
    } finally { request.mockRestore(); billing.mockRestore(); update.mockRestore(); }
  });

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
