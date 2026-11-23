/**
 * modelRequestTransport — 回归测试：standard image error credentials。
 */
import { describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  corsSafeFetch: vi.fn(),
  logAiResponse: vi.fn(),
}));

vi.mock('../../src/services/ai/httpTransport', () => transportMocks);

import { streamAssistantReply } from '../../src/services/ai/assistantStream';
import { generateImage, generateImagesBatch, inspectImagePromptLength } from '../../src/services/ai/generateImage';
import { generateText } from '../../src/services/ai/generateText';
import { reversePromptAndTags } from '../../src/services/ai/reversePrompt';
import { generateVideo } from '../../src/services/ai/generateVideo';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import VideoParamSelector from '../../src/components/nodes/shared/VideoParamSelector';
import { parseResponseError } from '../../src/services/ai/httpUtils';
import { resolveImageDataUrlArray } from '../../src/services/ai/imageUtils';
import { getProviderDefinition, KLING_BASE_URL, KLING_IMAGE_MODEL_MANIFEST, KLING_VIDEO_MODEL_MANIFEST } from '../../src/services/ai/providerCatalogService';
import { generateImageStandard } from '../../src/services/ai/providers/standardImage';
import { analyzeModelProtocolExamples } from '../../src/services/ai/modelProtocolImport';
import { useAppStore } from '../../src/store/useAppStore';
import { uploadToRemote } from '../../src/services/uploadService';
import * as mediaPersistence from '../../src/services/fileService';
import { registerCharacterImageTaskContext } from '../../src/services/characterImageTaskContext';
import { recoverCharacterImageTask } from '../../src/services/characterImageTaskRecovery';
import { nativeQueryCredentialProof } from '../../src/services/nativeProtocolRecovery';
import { nativeProtocolQueryDigest } from '../../src/services/nativeModelProtocolTask';
import { nativeMediaInputMaterial } from '../../src/services/nativeMediaInput';
import { sha256BytesHex } from '../../src/services/mediaDataUrl';
import { createNativeProject } from '../../src/services/indexedDb/nativeProjectRepository';
import { listNativeMediaTasks, prepareNativeMediaTask, recordNativeMediaSubmission } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import { resolveImageParameterCapability } from '../../src/services/ai/mediaModelCapabilities';
import { resolveVideoModelCapability } from '../../src/services/ai/videoModelCapabilityResolver';
import {
  clearProjectTasks, getNativeMediaNodeRecovery, getPendingTasksForProject, resumeMediaNodeTask,
  resumeNativeMediaFromNode, resumeNativeMediaLocalDelivery, resumePendingTasks,
} from '../../src/services/pollManager';
import { resolveModelExecutionProfile } from '../../src/services/ai/modelProtocol';
import type { CharacterImageTaskRecovery } from '../../src/types/media';
import type { CanvasContext } from '../../src/types/project';
import { jsonResponse, setupTransportFixture } from './modelRequestTransport/transportFixture';
setupTransportFixture(transportMocks.corsSafeFetch);

describe('Kling 官方视频统一入口', () => {
  function configureFlash(mode: 'text' | 'first-frame', override = false) {
    const model = structuredClone(KLING_VIDEO_MODEL_MANIFEST.find((entry) => entry.id === `kling-video-4.0-flash-${mode}`)!);
    if (override) model.videoCapability = { ...model.videoCapability, maxImageReferences: 10, resolutions: ['720p', '1080p'],
      defaultResolution: '1080p', durations: [20, 21], minDuration: 20, maxDuration: 21, defaultDuration: 21 };
    useAppStore.getState().saveProviderConfig('kling-flash', { name: 'Kling', catalogId: 'kling',
      apiKey: 'flash-fixture', selectedModels: [model] });
    const selected = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'kling-flash')!;
    return { model: `general/${selected.id}`, provider: 'general', prompt: 'A sunrise' };
  }

  it.each(['text', 'first-frame'] as const)('Flash %s 发出官方请求并按原回执查询', async (mode) => {
    const params = configureFlash(mode);
    const header = Buffer.from('89504e470d0a1a0a0000000d494844520000012c0000012c0806000000', 'hex').toString('base64');
    const local = `data:image/png;base64,${header}`;
    const referenceMedia = mode === 'first-frame' ? [{ kind: 'image' as const, origin: 'connection' as const,
      role: 'reference' as const, url: local }] : [];
    const prompt = (mode === 'text' ? 'a' : '春').repeat(mode === 'text' ? 26_000 : 11_000);
    const resultUrl = 'https://cdn.example/flash.mp4';
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: 'flash-original' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: [
        { id: 'other-task', status: 'failed' },
        { id: 'flash-original', status: 'succeeded', outputs: [{ url: resultUrl }] },
      ] }));
    await expect(generateVideo({ ...params, prompt, seedanceDuration: 20, referenceMedia })).resolves.toMatchObject({ url: resultUrl });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    const [[submitUrl, submit], [pollUrl, poll]] = transportMocks.corsSafeFetch.mock.calls;
    const endpoint = mode === 'text' ? 'text-to-video' : 'image-to-video';
    expect(submitUrl).toBe(`${KLING_BASE_URL}/${endpoint}/kling-4.0-flash`);
    expect(new Headers(submit.headers).get('Authorization')).toBe('Bearer flash-fixture');
    expect(JSON.parse(String(submit.body))).toEqual(mode === 'text'
      ? { prompt, settings: { resolution: '720p', duration: 20, aspect_ratio: '16:9' } }
      : { contents: [{ type: 'prompt', text: prompt }, { type: 'first_frame', url: header }],
        settings: { resolution: '720p', duration: 20 } });
    expect(pollUrl).toBe(`${KLING_BASE_URL}/tasks?task_ids=flash-original`);
    expect(poll.method).toBe('GET');
  });

  it('Flash 首帧模型在网络请求前拒绝旧设置扩大的能力、尾帧与过长提示词', async () => {
    const params = configureFlash('first-frame', true);
    const first = { kind: 'image' as const, origin: 'connection' as const,
      role: 'first_frame' as const, url: 'https://cdn.example/first.png' };
    const last = { ...first, role: 'last_frame' as const, url: 'https://cdn.example/last.png' };
    const valid = { ...params, seedanceDuration: 20, referenceMedia: [first] };
    expect(resolveVideoModelCapability(params.model, useAppStore.getState().config)).toMatchObject({
      maxImageReferences: 1, durations: [20], defaultDuration: 20, resolutions: ['720p'], defaultResolution: '720p',
    });
    await expect(generateVideo({ ...valid, seedanceDuration: 21 })).rejects.toMatchObject({ code: 'UNSUPPORTED_DURATION' });
    await expect(generateVideo({ ...valid, seedanceResolution: '1080p' })).rejects.toMatchObject({ code: 'UNSUPPORTED_RESOLUTION' });
    await expect(generateVideo({ ...valid, referenceMedia: [first, last] })).rejects.toMatchObject({ code: 'REFERENCE_LIMIT_EXCEEDED' });
    await expect(generateVideo({ ...valid, referenceMedia: [last] })).rejects.toThrow('仅支持首帧');
    await expect(generateVideo({ ...valid, referenceMedia: [] })).rejects.toMatchObject({ code: 'REQUIRED_REFERENCE' });
    await expect(generateVideo({ ...valid, prompt: '春'.repeat(11_001) })).rejects.toMatchObject({ code: 'INVALID_PARAMETER' });
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('实际时长只能取官方档位与连接设置的交集，超限不发请求', async () => {
    const model = structuredClone(KLING_VIDEO_MODEL_MANIFEST[0]);
    model.videoCapability = { ...model.videoCapability, durations: [29, 30, 31], minDuration: 29, maxDuration: 31,
      defaultDuration: 31, automaticDurationValue: -1, promptMaxCharacters: 100_000, promptMaxNonAsciiCharacters: 50_000 };
    const state = useAppStore.getState();
    useAppStore.setState({ config: { ...state.config, providers: {
      official: { name: 'Kling', apiKey: 'kling-fixture', catalogId: 'kling', baseUrl: KLING_BASE_URL, selectedModels: [model] },
    }, generalModels: [{ id: 'bounded-video', name: model.name, modelId: model.id, category: 'video', providerConfigId: 'official',
      executionProfile: model.executionProfile, videoCapability: model.videoCapability }] } });
    const ref = 'general/bounded-video';
    expect(resolveVideoModelCapability(ref, useAppStore.getState().config)).toMatchObject({
      durations: [29, 30], minDuration: 29, maxDuration: 30, defaultDuration: 29, automaticDurationValue: undefined,
      promptMaxCharacters: 26_000, promptMaxNonAsciiCharacters: 11_000,
    });
    const params = { model: ref, provider: 'general', prompt: 'Spring' };
    await expect(generateVideo({ ...params, seedanceDuration: 31 })).rejects.toMatchObject({ code: 'UNSUPPORTED_DURATION' });
    await expect(generateVideo({ ...params, seedanceDuration: 30, prompt: '春'.repeat(11_001) })).rejects.toThrow('提示词最多支持 11000 个字符');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('按实际传输顺序绑定首、中、尾帧，包括内联本地帧', async () => {
    const model = KLING_VIDEO_MODEL_MANIFEST[1];
    useAppStore.getState().saveProviderConfig('kling-video-fixture', { name: 'Kling', catalogId: 'kling',
      apiKey: 'video-fixture', selectedModels: [model] });
    const selected = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'kling-video-fixture')!;
    const header = Buffer.from('89504e470d0a1a0a0000000d494844520000012c0000012c0806000000', 'hex').toString('base64');
    const middle = 'data:image/png;base64,' + header;
    const first = 'https://cdn.example/first.png';
    const last = 'https://cdn.example/last.png';
    useAppStore.setState({ nodes: [
      { id: 'last', type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', label: '尾帧', imageUrl: last } },
      { id: 'middle', type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', label: '中间帧', imageUrl: middle } },
      { id: 'first', type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', label: '首帧', imageUrl: first } },
    ] });
    const resultUrl = 'https://cdn.example/generated.mp4';
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: 'keyframes' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: [{ id: 'keyframes', status: 'succeeded', outputs: [{ url: resultUrl }] }] }));
    await expect(generateVideo({ model: 'general/' + selected.id, provider: 'general', seedanceDuration: 30,
      prompt: '从 @{first:首帧} 经 @{middle:中间帧} 到 @{last:尾帧}',
      referenceMedia: [
        { kind: 'image', origin: 'prompt', role: 'last_frame', sourceNodeId: 'last', url: last },
        { kind: 'image', origin: 'prompt', role: 'first_frame', sourceNodeId: 'first', url: first },
      ],
    })).resolves.toMatchObject({ url: resultUrl });
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe(KLING_BASE_URL + '/image-to-video/kling-4.0');
    const body = JSON.parse(String(init.body));
    expect(body.settings).toEqual({ resolution: '1080p', duration: 30 });
    expect(body.contents[0].text).toContain('从 @frame_1 经 @frame_2 到 @frame_3');
    expect(body.contents.slice(1)).toEqual([
      { type: 'first_frame', id: 'frame_1', url: first },
      { type: 'middle_frame', id: 'frame_2', url: header },
      { type: 'last_frame', id: 'frame_3', url: last },
    ]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('Kling 官方图片统一入口', () => {
  function configureKling(series: boolean | string = false) {
    const selected = structuredClone(typeof series === 'string'
      ? getProviderDefinition('kling')!.models!.find((model) => model.id === series)!
      : KLING_IMAGE_MODEL_MANIFEST[series ? 1 : 0]);
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      official: { name: 'Kling', apiKey: 'kling-fixture', catalogId: 'kling', baseUrl: KLING_BASE_URL, selectedModels: [selected] },
    }, generalModels: [{ id: 'kling', name: selected.name, modelId: selected.id, category: 'image', providerConfigId: 'official',
      executionProfile: selected.executionProfile, imageCapability: selected.imageCapability }] } }));
    return { model: 'general/kling', provider: 'general', prompt: 'A landscape' };
  }

  it('保留连接较小的 ASCII 上限，同时约束超出合同的非 ASCII 上限', async () => {
    const params = configureKling();
    useAppStore.setState((state) => ({
      config: { ...state.config, generalModels: state.config.generalModels!.map((item) => ({
        ...item, imageCapability: { ...item.imageCapability, promptMaxCharacters: 24_000, promptMaxNonAsciiCharacters: 23_000 },
      })) },
    }));
    const effective = resolveImageParameterCapability(params.model, params.provider, useAppStore.getState().config);
    expect(effective).toMatchObject({ promptMaxCharacters: 24_000, promptMaxNonAsciiCharacters: 21_000 });
    await expect(generateImage({ ...params, prompt: '图'.repeat(21_001) })).rejects.toMatchObject({
      name: 'ImagePromptOverflowError', maxCharacters: 21_000,
    });
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it.each([false, true])('普通图与组图保留最大产物集，series=%s', async (series) => {
    const params = configureKling(series);
    const count = series ? 10 : 9;
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: 'original-kling', status: 'submitted' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: [{ id: 'original-kling', status: 'succeeded',
        outputs: Array.from({ length: count }, (_, index) => ({ type: 'image', url: `https://cdn.example/${index}.png` })) }] }));
    const result = await generateImagesBatch(params, series ? 1 : 9);
    expect(result.results).toHaveLength(count);
    expect(result.failedCount).toBe(0);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe(`${KLING_BASE_URL}/image-generation/kling-4.0`);
    expect(JSON.parse(String(init.body)).settings).toMatchObject(series
      ? { result_type: 'series', series_amount: 10 } : { result_type: 'single', n: 9 });
    expect(transportMocks.corsSafeFetch.mock.calls.filter(([, request]) => request.method === 'POST')).toHaveLength(1);
  });

  it.each([2, 7, 10])('每次自动组图作业完整交付 %s 张结果', async (count) => {
    const params = configureKling('kling-image-4.0-series-auto');
    const urls = Array.from({ length: count }, (_, i) => 'https://cdn.example/auto-' + i + '.png');
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: 'auto' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: [{ id: 'auto', status: 'succeeded', outputs: urls.map((url) => ({ url })) }] }));
    const result = await generateImage({ ...params, collectCandidates: true });
    expect(result.expectedOutputCount).toBe(count);
    expect([result.url, ...result.additionalResults!.map((image) => image.url)]).toEqual(urls);
    expect(JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body)).settings).toMatchObject({ series_amount: 'auto' });
    expect(transportMocks.corsSafeFetch.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET']);
  });

  it('自动候选数量不符时保留原任务，恢复后保存服务端返回的实际数量', async () => {
    const params = configureKling('kling-image-4.0-series-auto');
    const projectId = 'kling-auto-recovery';
    const nodeId = 'kling-auto-node';
    clearProjectTasks(projectId);
    useAppStore.setState({ currentProjectId: projectId, projectLoadStatus: 'ready',
      projects: [{ id: projectId, name: 'Kling auto recovery', createdAt: 1, updatedAt: 1 }],
      nodes: [{ id: nodeId, type: 'ai-image',
      position: { x: 0, y: 0 }, data: { type: 'ai-image', label: 'Auto', status: 'loading' } }] });
    const response = (n: number) => jsonResponse({ code: 0, data: [{ id: 'original', status: 'succeeded',
      outputs: Array.from({ length: n }, (_, i) => ({ url: 'https://cdn.example/auto-' + i + '.png' })) }] });
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: 'original' } }))
      .mockResolvedValueOnce(response(1)).mockResolvedValueOnce(response(5));
    try {
      await expect(generateImagesBatch({ ...params, nodeId }, 1)).rejects.toThrow('原任务已保留');
      expect(getPendingTasksForProject(projectId)[0]).toMatchObject({ taskId: 'original', imageOutputCountRange: { min: 2, max: 10 } });
      useAppStore.setState((state) => ({ config: { ...state.config, generalModels: [] } }));
      const save = vi.spyOn(mediaPersistence, 'persistMediaUrlToProjectData').mockImplementation(async (url) => ({
        mediaUrl: url, sourceUrl: url,
      }));
      await resumeMediaNodeTask(nodeId);
      expect(transportMocks.corsSafeFetch.mock.calls.slice(0, 3).map(([, init]) => init.method)).toEqual(['POST', 'GET', 'GET']);
      expect(String(transportMocks.corsSafeFetch.mock.calls[2][0])).toContain('task_ids=original');
      expect(useAppStore.getState().nodes.filter((node) => node.data.imageUrl)).toHaveLength(5);
      expect(save).toHaveBeenCalledTimes(5);
      expect(getPendingTasksForProject(projectId)).toHaveLength(0);
    } finally { clearProjectTasks(projectId); }
  });

  it('网页长图按风格图、主体图的顺序发送，省略比例', async () => {
    const params = configureKling('kling-long-image-4.0-webpage-style-subject');
    const images = ['https://cdn.example/style.png', 'https://cdn.example/subject.png'];
    await expect(generateImage({ ...params, image_urls: [images[0]] })).rejects.toThrow('至少');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    useAppStore.setState({ currentProjectId: 'long-image-slots', projects: [{ id: 'long-image-slots', name: 'Long image slots',
      createdAt: 1, updatedAt: 1, settings: { visualStyle: { styleReference: { imageUrl: 'https://cdn.example/master.png', enabled: true } } } }] });
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: 'long-image' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: [{ id: 'long-image', status: 'succeeded', outputs: [{ url: images[1] }] }] }));
    await generateImage({ ...params, image_urls: images, imageSize: '2k' });
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe(KLING_BASE_URL + '/long-image-generation/kling-4.0');
    expect(JSON.parse(String(init.body))).toMatchObject({ settings: { skill: 'webpage', resolution: '2k' },
      contents: [expect.anything(), { type: 'style_refer_image', url: images[0] }, { type: 'subject_refer_image', url: images[1] }] });
    expect(JSON.parse(String(init.body)).settings).not.toHaveProperty('aspect_ratio');
  });

  it.each(['style-subject', 'subject'])('网页长图 %s 仅为风格槽使用项目母图', async (mode) => {
    const params = configureKling('kling-long-image-4.0-webpage-' + mode);
    const style = 'https://cdn.example/master.png';
    const subject = 'https://cdn.example/subject.png';
    useAppStore.setState({ currentProjectId: 'long-project', projects: [{ id: 'long-project', name: 'Long image',
      createdAt: 1, updatedAt: 1, settings: { visualStyle: { styleReference: { imageUrl: style, enabled: true } } } }] });
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: 'long-image' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: [{ id: 'long-image', status: 'succeeded', outputs: [{ url: subject }] }] }));
    await generateImage({ ...params, image_urls: [subject] });
    const body = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body));
    expect(body.contents.slice(1)).toEqual([
      ...(mode === 'style-subject' ? [{ type: 'style_refer_image', url: style, id: 'image1' }] : []),
      { type: 'subject_refer_image', url: subject, id: mode === 'style-subject' ? 'image2' : 'image1' },
    ]);
  });

  it.each(['unchanged', 'key', 'address', 'catalog', 'digest', 'category'] as const)(
    '角色恢复只查询原合同和账号，模型已移除且 %s', async (change) => {
      const params = configureKling();
      const config = useAppStore.getState().config;
      const selected = config.generalModels![0];
      const protocol = resolveModelExecutionProfile(selected.executionProfile)!;
      const operation = 'character-kling-op';
      const recovery: CharacterImageTaskRecovery = { version: 1, kind: 'protocol', connectionId: 'official',
        modelRef: params.model, providerBase: KLING_BASE_URL, configurationDigest: 'a'.repeat(64), expectedCount: 1,
        query: { modelId: selected.modelId, serverId: change === 'category' ? 'xai-video-v1' : 'kling-tasks-v1',
          digest: change === 'digest' ? 'b'.repeat(64) : await nativeProtocolQueryDigest(selected.modelId, protocol),
          credentialProof: await nativeQueryCredentialProof(operation, 'official', config.providers.official.apiKey) },
        tasks: [{ taskId: 'original-role', recoveryContext: { submit: { data: { id: 'original-role' } } } }] };
      useAppStore.setState({ config: { ...config, generalModels: [], providers: { official: { ...config.providers.official,
        selectedModels: [], ...(change === 'key' ? { apiKey: 'different-account-fixture' } : {}),
        ...(change === 'address' ? { baseUrl: 'https://different.example' } : {}),
        ...(change === 'catalog' ? { catalogId: 'custom-openai' } : {}) } } } });
      const output = 'https://cdn.example/recovered-role.png';
      transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: [
        { id: 'someone-else', status: 'failed' }, { id: 'original-role', status: 'succeeded', outputs: [{ url: output }] },
      ] }));
      if (change === 'unchanged') {
        await expect(recoverCharacterImageTask(recovery, operation)).resolves.toEqual([{ url: output }]);
        expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith(KLING_BASE_URL + '/tasks?task_ids=original-role',
          expect.objectContaining({ method: 'GET' }), expect.anything());
      } else {
        await expect(recoverCharacterImageTask(recovery, operation)).rejects.toThrow('已变化');
        expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
      }
    });

  it.each(['unchanged', 'key', 'address', 'catalog', 'digest', 'category', 'legacy', 'unknown', 'retry', 'canvas-switch', 'existing-result'] as const)(
    '画布重开绑定原生查询，模型已移除且 %s', async (change) => {
      configureKling();
      const config = useAppStore.getState().config;
      const selected = config.generalModels![0];
      const protocol = resolveModelExecutionProfile(selected.executionProfile)!;
      const root = await createNativeProject({ name: 'Kling recovery fixture' });
      const canvas = root.canvas!;
      const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, projectId: root.project.id,
        projectEpoch: root.project.epoch, canvasId: canvas.id, canvasEpoch: canvas.epoch, canvasRevision: canvas.revision,
        episodeId: null, runtimeEpoch: 'kling-reopened-view' };
      const nodeId = 'original-native-node';
      useAppStore.setState({ projectExecutionContext: context, currentProjectId: canvas.id, projectLoadStatus: 'ready',
        nodes: [{ id: nodeId, type: 'ai-image', position: { x: 0, y: 0 }, data: { type: 'ai-image', label: '原节点', prompt: '原输入',
          status: change === 'existing-result' ? 'success' : 'loading',
          ...(change === 'existing-result' ? { imageUrl: 'asset://local/current.png' } : {}) } }] });
      const state = useAppStore.getState();
      const input = nativeMediaInputMaterial(state.nodes[0], state, 'media-input-v3');
      const operationId = crypto.randomUUID();
      const receipt = await prepareNativeMediaTask({ context, operationId, nodeId,
        category: 'image', providerConfigId: 'official', providerBase: KLING_BASE_URL, modelRef: 'general/kling',
        inputFingerprint: await sha256BytesHex(new TextEncoder().encode(input)), requestFingerprint: 'b'.repeat(64), protocolDigest: 'c'.repeat(64),
        fingerprintScheme: 'media-input-v3', submissionKind: 'async', sourceCanvasRevision: canvas.revision,
        recovery: { kind: 'general-protocol', modelId: selected.modelId,
          serverId: change === 'category' ? 'xai-video-v1' : 'kling-tasks-v1',
          digest: change === 'digest' ? 'b'.repeat(64) : await nativeProtocolQueryDigest(selected.modelId, protocol),
          ...(change === 'legacy' ? {} : { credentialProof: await nativeQueryCredentialProof(operationId, 'official', config.providers.official.apiKey) }) } });
      await recordNativeMediaSubmission(operationId, receipt.lease, { unknown: true });
      if (change !== 'unknown') {
        await recordNativeMediaSubmission(operationId, receipt.lease, { taskId: 'original-native',
          pollContext: { submit: { data: { id: 'original-native' } } } });
      }
      useAppStore.setState({ config: { ...config, generalModels: [], providers: { official: { ...config.providers.official,
        selectedModels: [], ...(change === 'key' ? { apiKey: 'other-native-account' } : {}),
        ...(change === 'address' ? { baseUrl: 'https://other-native.example' } : {}),
        ...(change === 'catalog' ? { catalogId: 'custom-openai' } : {}) } } } });
      const next = jsonResponse({ code: 0, data: [
        { id: 'unrelated', status: 'succeeded', outputs: [{ url: 'https://cdn.example/other.png' }] },
        { id: 'original-native', status: 'failed', message: 'original native fixture' },
      ] });
      if (change === 'retry') {
        transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: [{ id: 'unrelated', status: 'failed' }] }));
      }
      transportMocks.corsSafeFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
        if (change === 'canvas-switch') {
          useAppStore.setState({ currentProjectId: null, projectExecutionContext: null });
          expect(init.signal?.aborted).toBe(true);
        }
        return next;
      });
      await resumePendingTasks(context.canvasId).catch((error) => {
        if (change !== 'canvas-switch') throw error;
      });
      const boundGet = [KLING_BASE_URL + '/tasks?task_ids=original-native', 'GET'];
      const requests = () => transportMocks.corsSafeFetch.mock.calls.map(([url, init]) => [url, init.method]);
      const queried = ['unchanged', 'retry', 'canvas-switch'].includes(change);
      expect(requests()).toEqual(queried ? [boundGet] : []);
      if (change === 'retry') {
        expect(getNativeMediaNodeRecovery(nodeId)).toBe(operationId);
        expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'idle', mediaTaskState: 'paused' });
        await resumeNativeMediaLocalDelivery(context.canvasId, nodeId);
        expect(requests()).toEqual([boundGet]);
        await expect(resumeNativeMediaFromNode(nodeId, operationId)).rejects.toThrow('已确认原任务失败');
        expect(requests()).toEqual([boundGet, boundGet]);
      }
      const saved = (await listNativeMediaTasks(context.projectId))[0];
      expect(saved.status).toBe(change === 'unknown' ? 'outcome-unknown' : ['retry', 'unchanged'].includes(change) ? 'failed' : 'submitted');
      expect(saved.remoteTaskId).toBe(change === 'unknown' ? undefined : 'original-native');
      const data = useAppStore.getState().nodes[0].data;
      if (change === 'existing-result') expect(data).toMatchObject({ status: 'success', imageUrl: 'asset://local/current.png' });
      else if (change !== 'canvas-switch') expect(data.status).not.toBe('loading');
      if (['key', 'address', 'catalog', 'digest', 'category'].includes(change)) expect(data.mediaTaskState).toBe('paused');
      if (change === 'legacy') expect(data.mediaTaskState).toBe('paused');
    });

  it('预检识别中文上限，替换文本重新校验，未确认时不提交', async () => {
    const params = { ...configureKling(), prompt: '图'.repeat(21_001) };
    const overflow = await inspectImagePromptLength(params);
    expect(overflow).toMatchObject({ characters: 21_001, maxCharacters: 21_000 });
    await expect(generateImagesBatch({ ...params, imagePromptResolution: {
      original: params.prompt, replacement: '🎨'.repeat(21_001),
    } }, 1)).rejects.toMatchObject({ name: 'ImagePromptOverflowError', maxCharacters: 21_000 });
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('十张公网参考图保持顺序，并使用官方引用 ID', async () => {
    const params = configureKling();
    const references = Array.from({ length: 10 }, (_, index) => `https://cdn.example/ref-${index}.png`);
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: 'kling-ref', status: 'submitted' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: [{ id: 'kling-ref', status: 'succeeded',
        outputs: [{ type: 'image', url: 'https://cdn.example/result.png' }] }] }));
    const result = await generateImagesBatch({ ...params, prompt: '图片10的人物，图片1的风格', image_urls: references }, 1);
    expect(result.failedCount).toBe(0);
    const body = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body));
    expect(body.contents.slice(1).map((item: { id: string; url: string }) => [item.id, item.url]))
      .toEqual(references.map((url, index) => [`image${index + 1}`, url]));
    expect(body.contents[0].text).toContain('@image10');
    expect(body.contents[0].text).toContain('图片10的人物，图片1的风格');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('合并风格母图、显式参考和画布引用后，正文的引用仍对应同一素材', async () => {
    const params = configureKling();
    const style = 'https://cdn.example/style.png';
    const explicit = 'https://cdn.example/explicit.png';
    const subject = 'https://cdn.example/subject.png';
    useAppStore.setState({
      currentProjectId: 'kling-project',
      projects: [{ id: 'kling-project', name: 'Fixture', createdAt: 1, updatedAt: 1,
        settings: { visualStyle: { styleReference: { imageUrl: style, enabled: true } } } }],
      nodes: [{ id: 'subject', type: 'source-image', position: { x: 0, y: 0 },
        data: { type: 'source-image', label: '主体', imageUrl: subject } }],
    });
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: 'kling-binding', status: 'submitted' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: [{ id: 'kling-binding', status: 'succeeded',
        outputs: [{ type: 'image', url: 'https://cdn.example/result.png' }] }] }));
    const result = await generateImagesBatch({ ...params, prompt: '使用 @{subject:主体} 和 @{subject:主体}，保留手写图片1。',
      image_urls: [explicit, style, explicit] }, 1);
    expect(result.failedCount).toBe(0);
    const body = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body));
    expect(body.contents.slice(1)).toEqual([style, explicit, subject].map((url, index) => ({
      type: 'refer_image', url, id: `image${index + 1}`,
    })));
    expect(body.contents[0].text).toContain('【项目风格母图】@image1');
    expect(body.contents[0].text).toContain('使用 @image3 和 @image3，保留手写图片1。');
  });

  it('HTTP 200 业务错误不重发生成，也不无限查询', async () => {
    const params = configureKling();
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: 'original-kling', status: 'submitted' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 1001, message: 'invalid key' }));
    await expect(generateImagesBatch(params, 1)).rejects.toThrow('业务码 1001');
    expect(transportMocks.corsSafeFetch.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET']);
  });

  it.each([false, true])('角色工作台沿官方合同提交并先保存原任务 ID，series=%s', async (series) => {
    const params = configureKling(series);
    const count = series ? 10 : 9;
    const completed = new Error('角色图片已交付');
    const received = vi.fn();
    const destination = registerCharacterImageTaskContext({ assertCurrent: vi.fn(), execute: async (plan) => {
      expect(plan.expectedCount).toBe(count);
      expect(plan.recovery.kind).toBe('protocol');
      const results = await plan.execute(async () => {}, async (id) => { received(id); }, 'kling-role-fixture');
      expect(results).toHaveLength(count);
      throw completed;
    } });
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: 'role-original', status: 'submitted' } }))
      .mockImplementationOnce(async () => {
        expect(received).toHaveBeenCalledWith('role-original');
        return jsonResponse({ code: 0, data: [{ id: 'role-original', status: 'succeeded',
          outputs: Array.from({ length: count }, (_, index) => ({ type: 'image', url: `https://cdn.example/role-${index}.png` })) }] });
      });
    try {
      await expect(generateImagesBatch({ ...params, characterWorkbench: 'global' }, series ? 1 : 9,
        undefined, destination.beforeSubmit)).rejects.toBe(completed);
      expect(transportMocks.corsSafeFetch.mock.calls[0][0]).toBe(`${KLING_BASE_URL}/image-generation/kling-4.0`);
      expect(transportMocks.corsSafeFetch.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET']);
    } finally { destination.release(); }
  });

  it('超过十张参考图在提交前拒绝', async () => {
    const params = configureKling();
    await expect(generateImagesBatch({ ...params,
      image_urls: Array.from({ length: 11 }, (_, index) => `https://cdn.example/ref-${index}.png`),
    }, 1)).rejects.toThrow('10');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('本地小图在付费提交前拒绝，不上传图床', async () => {
    const params = configureKling();
    const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8Z0AAAAASUVORK5CYII=';
    await expect(generateImagesBatch({ ...params, image_urls: [reference] }, 1)).rejects.toThrow('300');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('standard image error credentials', () => {
  it('APIMart upload checks its own credentials without borrowing another provider key', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      apimart: { name: 'APIMart', apiKey: '' }, unrelated: { name: '其他连接', apiKey: 'unrelated-key-fixture' },
    } } }));
    await expect(uploadToRemote('data:image/png;base64,YXBpbWFydC1uby1rZXk=', 'apimart'))
      .rejects.toThrow('未配置 APIMart');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('APIMart upload redacts complete echoed credentials before truncating errors and logging', async () => {
    const apiKey = 'upload~! private/key=';
    const form = new URLSearchParams({ key: apiKey }).toString().slice(4);
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      apimart: { name: 'APIMart', apiKey, baseUrl: 'https://apimart-upload.example/v1' },
    } } }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = `${'x'.repeat(190)}${apiKey}; ${encodeURIComponent(apiKey)}; ${form}`;
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(body, { status: 401 }));
    const error = await uploadToRemote('data:image/png;base64,YXBpbWFydC1lcnJvci1rZXk=', 'apimart')
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(apiKey.slice(0, 8));
    for (const secret of [apiKey, encodeURIComponent(apiKey), form]) {
      expect((error as Error).stack).not.toContain(secret);
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    }
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
  });

  it('APIMart rejects an oversized non-PNG before uploading or submitting generation', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      apimart: { name: 'APIMart', apiKey: 'oversized-fixture', baseUrl: 'https://apimart-upload.example/v1' },
    } } }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(new Blob([new Uint8Array(20_000_001)], {
      type: 'image/gif',
    }), { headers: { 'Content-Type': 'image/gif', 'Content-Length': '20000001' } }));
    await expect(uploadToRemote('asset://localhost/oversized-animated.gif', 'apimart')).rejects.toThrow('20 MB');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('changing an upload connection key invalidates reusable content without persisting credentials', async () => {
    const setKey = (apiKey: string) => useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      apimart: { name: 'APIMart', apiKey, baseUrl: 'https://apimart-upload.example/v1' },
    } } }));
    setKey('first-upload-key-fixture');
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ url: 'https://cdn.example/first-upload-account.png' }))
      .mockResolvedValueOnce(jsonResponse({ url: 'https://cdn.example/second-upload-account.png' }));
    const source = 'data:image/png;base64,YXBpbWFydC1rZXktcm90YXRpb24=';
    expect(await uploadToRemote(source, 'apimart')).toBe('https://cdn.example/first-upload-account.png');
    expect(await uploadToRemote(source, 'apimart')).toBe('https://cdn.example/first-upload-account.png');
    setKey('second-upload-key-fixture');
    expect(await uploadToRemote(source, 'apimart')).toBe('https://cdn.example/second-upload-account.png');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    const persisted = localStorage.getItem('canvas-upload-cache-v4') ?? '';
    expect(persisted).not.toContain('first-upload-key-fixture');
    expect(persisted).not.toContain('second-upload-key-fixture');
  });

  it('rejects queued and in-flight uploads when the connection changes without caching either result', async () => {
    const setKey = (apiKey: string) => useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      apimart: { name: 'APIMart', apiKey, baseUrl: 'https://apimart-upload.example/v1' },
    } } }));
    setKey('queued-original-fixture');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let finishFirst!: (response: Response) => void;
    transportMocks.corsSafeFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishFirst = resolve; }));
    const first = uploadToRemote('data:image/png;base64,cXVldWVkLWZpcnN0', 'apimart').catch((error: unknown) => error);
    await vi.waitFor(() => expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const listen = vi.spyOn(controller.signal, 'addEventListener');
    const source = 'data:image/png;base64,cXVldWVkLXNlY29uZA==';
    const second = uploadToRemote(source, 'apimart', 'image', controller.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(listen).toHaveBeenCalledWith('abort', expect.any(Function), { once: true }));
    setKey('queued-replacement-fixture');
    finishFirst(jsonResponse({ url: 'https://cdn.example/obsolete-queued.png' }));
    for (const error of await Promise.all([first, second])) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('连接配置已变化');
    }
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    setKey('queued-original-fixture');
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ url: 'https://cdn.example/retried-queued.png' }));
    expect(await uploadToRemote(source, 'apimart')).toBe('https://cdn.example/retried-queued.png');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
  });

  it.each(['network', 'json'] as const)('redacts the captured upload key when %s fails after key rotation', async (mode) => {
    const oldKey = `in-flight~! ${mode}/key=`;
    const encoded = encodeURIComponent(oldKey);
    const formEncoded = new URLSearchParams({ key: oldKey }).toString().slice(4);
    const setKey = (apiKey: string) => useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      apimart: { name: 'APIMart', apiKey, baseUrl: 'https://apimart-upload.example/v1' },
    } } }));
    setKey(`  ${oldKey}  `);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail!: (error: Error) => void;
    const delayed = new Promise<Response>((_, reject) => { fail = reject; });
    if (mode === 'network') transportMocks.corsSafeFetch.mockReturnValueOnce(delayed);
    else {
      const response = jsonResponse({});
      vi.spyOn(response, 'json').mockImplementation(() => delayed);
      transportMocks.corsSafeFetch.mockResolvedValueOnce(response);
    }
    const pending = uploadToRemote(`data:image/png;base64,${btoa(`in-flight-${mode}`)}`, 'apimart')
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce());
    expect(transportMocks.corsSafeFetch.mock.calls[0][1].headers).toMatchObject({ Authorization: `Bearer ${oldKey}` });
    setKey('replacement-key-fixture');
    fail(new Error(`Echo ${oldKey}; ${encoded}; ${formEncoded}`));
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    for (const secret of [oldKey, encoded, formEncoded]) {
      expect((error as Error).stack).not.toContain(secret);
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    }
  });

  it.each(['json-401', 'multipart-504', 'ccc-401'] as const)('redacts echoed credentials from %s without re-submitting', async (mode) => {
    const apiKey = 'fixture~! private/key=';
    const formEncoded = new URLSearchParams({ key: apiKey }).toString().slice('key='.length);
    const detail = `Invalid API key ${apiKey}; encoded=${encodeURIComponent(apiKey)}; query=${formEncoded}; request denied`;
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: detail } }), {
      status: mode === 'multipart-504' ? 504 : 401, headers: { 'Content-Type': 'application/json' },
    }));
    if (mode === 'multipart-504') {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('reference', { headers: { 'Content-Type': 'image/png' } }));
    }
    const error = await generateImageStandard({ apiKey, baseUrl: 'https://gateway.example/v1', modelName: 'gpt-image-2',
      prompt: 'landscape', dimensions: { width: 1024, height: 1024 },
      ...(mode === 'multipart-504' ? { imageUrls: ['asset://localhost/reference.png'], imageReferenceRequestMode: 'edits-multipart' as const } : {}),
      ...(mode === 'ccc-401' ? { asyncTaskProvider: 'cccapi' as const } : {}),
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[REDACTED]');
    expect((error as Error).message).toContain('request denied');
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as Error).message).not.toContain(encodeURIComponent(apiKey));
    expect((error as Error).message).not.toContain(formEncoded);
    expect((error as Error).stack).not.toContain(apiKey);
    expect((error as Error).cause).toBeUndefined();
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    expect(transportMocks.corsSafeFetch.mock.calls[0][0]).toBe(`https://gateway.example/v1/images/${mode === 'multipart-504' ? 'edits' : 'generations'}`);
  });
});

describe('model request transport boundary', () => {
  it('rejects legacy fixed transparent/JPEG protocols even without saved image capabilities', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { legacy: { name: 'Images', catalogId: 'custom-openai', apiKey: 'fixture', baseUrl: 'https://gateway.example/v1' } },
      generalModels: [{ id: 'legacy', name: 'Legacy Image', modelId: 'image', category: 'image', providerConfigId: 'legacy',
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/render', body: { prompt: '{{prompt}}', background: 'transparent', output_format: 'jpeg' } },
          response: { type: 'json', result: { urlPath: 'url' } } } },
      }],
    } }));
    await expect(generateImagesBatch({ provider: 'general', model: 'general/legacy', prompt: 'sticker' }, 1))
      .rejects.toThrow('透明背景不能与固定 output_format: jpeg');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });
  it('honors explicit interface default over a custom background default without replacing the protocol', async () => {
    useAppStore.getState().saveProviderConfig('custom-background', {
      name: 'Images', catalogId: 'custom-openai', apiKey: 'fixture', baseUrl: 'https://gateway.example/v1',
      selectedModels: [{ id: 'image', name: 'Image', category: 'image', provider: 'custom-background',
        imageCapability: { backgrounds: ['transparent', 'opaque'], defaultBackground: 'transparent' },
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/render', body: { prompt: '{{prompt}}', background: '{{imageBackground}}', output_format: 'webp' } },
          response: { type: 'json', result: { urlPath: 'url' } } } },
      }],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'custom-background')!;
    const params = { provider: 'general', model: `general/${model.id}`, prompt: 'sticker' };
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ url: 'https://cdn.example/image.webp' }));
    for (const imageBackground of [undefined, '', 'opaque']) await generateImagesBatch({ ...params, imageBackground }, 1);
    const bodies = transportMocks.corsSafeFetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies.map((body) => body.background)).toEqual(['transparent', undefined, 'opaque']);
    expect(bodies.every((body) => body.output_format === 'webp')).toBe(true);
    expect(transportMocks.corsSafeFetch.mock.calls.every(([url]) => url === 'https://gateway.example/v1/render')).toBe(true);
    await expect(generateImagesBatch({ ...params, imageBackground: 'auto' }, 1)).rejects.toThrow('不支持背景');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(3);
  });
  it('rejects unsupported Dreamina image ratios before the CLI can silently replace them', async () => {
    await expect(generateImagesBatch({ provider: 'dreamina', model: 'dreamina/4.0',
      prompt: 'portrait', aspectRatio: '1:8' }, 1)).rejects.toThrow('不支持比例 1:8');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });
  it('passes APIMart quality through its asynchronous adapter without a second generation', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { apimart: { name: 'APIMart', apiKey: 'fixture', baseUrl: 'https://apimart.example/v1' } },
    } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'native-quality-task' }] }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'completed', result: { images: [{ url: ['https://cdn.example/image.png'] }] } } }));
    const result = await generateImagesBatch({ provider: 'apimart', model: 'apimart/gpt-image-2.5-sunburst',
      prompt: 'cat', imageSize: '2K', aspectRatio: '16:9', imageQuality: 'max', imageBackground: 'transparent' }, 1);
    expect(result.results[0].url).toBe('https://cdn.example/image.png');
    expect(JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body))
      .toMatchObject({ model: 'gpt-image-2.5-sunburst', resolution: '2k', size: '16:9', quality: 'max',
        background: 'transparent', output_format: 'png' });
    expect(transportMocks.corsSafeFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it('uses an explicitly declared custom quality and rejects unsupported values before submission', async () => {
    useAppStore.getState().saveProviderConfig('custom-quality', {
      name: 'Images', catalogId: 'custom-openai', apiKey: 'fixture', baseUrl: 'https://gateway.example/v1',
      selectedModels: [{ id: 'image', name: 'Image', category: 'image', provider: 'custom-quality',
        imageCapability: { qualities: ['low', 'high'], defaultQuality: 'low' },
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/render', body: { prompt: '{{prompt}}', quality: '{{imageQuality}}' } },
          response: { type: 'json', result: { urlPath: 'url' } } } },
      }],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'custom-quality')!;
    const params = { provider: 'general', model: `general/${model.id}`, prompt: 'cat' };
    await expect(generateImagesBatch({ ...params, imageQuality: 'max' }, 1)).rejects.toThrow('不支持质量');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ url: 'https://cdn.example/image.png' }));
    await generateImagesBatch(params, 1);
    await generateImagesBatch({ ...params, imageQuality: 'high' }, 1);
    expect(transportMocks.corsSafeFetch.mock.calls.map(([, init]) => JSON.parse(init.body).quality)).toEqual(['low', 'high']);
  });
  it('uses custom image defaults and blocks unsupported tiers before submission', async () => {
    useAppStore.getState().saveProviderConfig('custom-image-parameters', {
      name: 'Images', catalogId: 'custom-openai', apiKey: 'fixture', baseUrl: 'https://gateway.example/v1',
      selectedModels: [{ id: 'image', name: 'Image', category: 'image', provider: 'custom-image-parameters',
        imageCapability: { resolutions: ['1K'], defaultResolution: '1K', ratios: ['1:1'], defaultRatio: '1:1',
          supportsBatch: true, maxBatchCount: 2, supportsImageReference: false },
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync', auth: { type: 'bearer' },
          submit: { method: 'POST', path: '/images/generations', body: { model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}', n: '{{n}}' } },
          response: { type: 'json', result: { urlPath: 'data.0.url' } } } },
      }],
    });
    const model = useAppStore.getState().config.generalModels![0];
    const params = { provider: 'general', model: `general/${model.id}`, prompt: 'cat' };
    for (const invalid of [{ imageSize: '4K' }, { aspectRatio: '16:9' }, { image_urls: ['https://cdn.example/ref.png'] }]) {
      await expect(generateImagesBatch({ ...params, ...invalid }, 1)).rejects.toThrow();
    }
    await expect(generateImagesBatch(params, 3)).rejects.toThrow('最多生成 2');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    await generateImagesBatch(params, 1);
    expect(JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body)).toMatchObject({ size: '1024x1024', n: 1 });
  });
  it.each([undefined, '   ', 'https://custom.example/v1/'])('reverses images and chats with the selected CCC group when its address is %s', async (baseUrl) => {
    for (const group of ['pro', 'discount']) useAppStore.getState().saveProviderConfig(`cccapi-${group}`, {
      name: 'CCC', catalogId: 'cccapi', cccGroup: group, apiKey: `${group}-fixture`, baseUrl,
      selectedModels: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', category: 'text', provider: `cccapi-${group}`,
        inputModalities: ['text', 'image'], executionProfile: { preset: 'openai-chat' } }],
    });
    const result = { prompt: '窗台上的橘猫', tags: ['橘猫', '窗台'] };
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }));
    const expectedUrl = `${baseUrl?.trim().replace(/\/+$/, '') || 'https://cccapi.cn/v1'}/chat/completions`;
    for (const model of useAppStore.getState().config.generalModels!) {
      await expect(reversePromptAndTags({ provider: 'general', model: `general/${model.id}`, imageUrls: ['data:image/png;base64,Y2F0'] })).resolves.toEqual(result);
      const [url, init] = transportMocks.corsSafeFetch.mock.calls.at(-1)!;
      expect(url).toBe(expectedUrl);
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${useAppStore.getState().config.providers[model.providerConfigId].apiKey}` });
      expect(JSON.parse(init.body)).toMatchObject({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: expect.arrayContaining([
        { type: 'image_url', image_url: { url: 'data:image/png;base64,Y2F0' } },
      ]) }] });
      useAppStore.getState().updateConfig({ assistantModelId: model.id });
      await expect(streamAssistantReply({ systemPrompt: '', userMessage: '你好', nonStream: true, onEvent: vi.fn() })).resolves.toBe(JSON.stringify(result));
      const [chatUrl, chatInit] = transportMocks.corsSafeFetch.mock.calls.at(-1)!;
      expect(chatUrl).toBe(expectedUrl);
      expect(chatInit.headers).toMatchObject({ Authorization: `Bearer ${useAppStore.getState().config.providers[model.providerConfigId].apiKey}` });
    }
    useAppStore.getState().setProviderKey('cccapi-discount', '');
    transportMocks.corsSafeFetch.mockClear();
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'cccapi-discount')!;
    await expect(reversePromptAndTags({ provider: 'general', model: `general/${model.id}`, imageUrls: ['data:image/png;base64,Y2F0'] })).rejects.toThrow();
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('still rejects an unconfigured custom connection address instead of borrowing a built-in URL', async () => {
    useAppStore.getState().saveProviderConfig('custom-cccapi', { name: '自定义', catalogId: 'custom-openai', apiKey: 'fixture',
      selectedModels: [{ id: 'gpt-5.6-sol', name: 'GPT', category: 'text', provider: 'custom-cccapi' }],
    });
    const model = useAppStore.getState().config.generalModels![0];
    await expect(generateText({ provider: 'general', model: `general/${model.id}`, prompt: '你好' })).rejects.toThrow('未配置接口地址');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it.each(['text', 'image'] as const)('routes identical CCC %s model IDs through the selected group Key', async (category) => {
    const modelId = category === 'text' ? 'gpt-5' : 'gpt-image-2';
    for (const group of ['free', 'stable']) {
      useAppStore.getState().saveProviderConfig(`cccapi-${group}`, {
        name: 'CCC', catalogId: 'cccapi', cccGroup: group, apiKey: `${group}-fixture`, baseUrl: 'https://cccapi.cn/v1',
        selectedModels: [{ id: modelId, name: modelId, category, provider: `cccapi-${group}`,
          executionProfile: { preset: category === 'text' ? 'openai-chat' : 'openai-image' } }],
      });
    }
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse(category === 'text'
      ? { choices: [{ message: { content: '回复' }, finish_reason: 'stop' }] }
      : { data: [{ url: 'https://cdn.example/image.png' }] }));
    const models = useAppStore.getState().config.generalModels!;
    expect(new Set(models.map((model) => model.id)).size).toBe(2);
    for (const model of models) {
      const params = { provider: 'general', model: `general/${model.id}`, prompt: '测试' };
      if (category === 'text') await expect(generateText(params)).resolves.toBe('回复');
      else expect((await generateImagesBatch(params, 1)).results).toHaveLength(1);
      const [url, init] = transportMocks.corsSafeFetch.mock.calls.at(-1)!;
      const key = useAppStore.getState().config.providers[model.providerConfigId].apiKey;
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${key}` });
      expect(url).toBe(`https://cccapi.cn/v1/${category === 'text' ? 'chat/completions' : 'images/generations'}`);
      expect(JSON.parse(init.body).model).toBe(modelId);
    }
    useAppStore.getState().setProviderKey('cccapi-stable', '');
    transportMocks.corsSafeFetch.mockClear();
    const model = models.find((item) => item.providerConfigId === 'cccapi-stable')!;
    const params = { provider: 'general', model: `general/${model.id}`, prompt: '测试' };
    if (category === 'text') await expect(generateText(params)).rejects.toThrow();
    else await expect(generateImagesBatch({ ...params, image_urls: ['https://cdn.example/reference.png'] }, 1)).rejects.toThrow('CCC API');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });
  it('routes a GRSAI H3 selection from the video entry into its native asynchronous adapter', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'fixture-key' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'h3-task', status: 'running' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/h3.mp4' }] }));
    await expect(generateVideo({ provider: 'grsai', model: 'grsai/minimax-h3', prompt: '写实短片', seedanceResolution: '768p', seedanceRatio: '9:16', seedanceDuration: 12 }))
      .resolves.toEqual({ url: 'https://cdn.example/h3.mp4' });
    expect(transportMocks.corsSafeFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://grsai.dakka.com.cn/v1/api/generate', 'https://grsai.dakka.com.cn/v1/api/result?id=h3-task',
    ]);
    expect(JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body)).toMatchObject({ aspectRatio: 'portrait', resolution: '768p', duration: 12, replyType: 'async' });
  });

  it('shows GRSAI H3 resolution and duration without unsupported audio toggle', () => {
    const html = renderToStaticMarkup(createElement(VideoParamSelector, { provider: 'grsai', selectedModel: 'grsai/minimax-h3', seedanceResolution: '1080p', seedanceDuration: 15 }));
    expect(html).toContain('1080p');
    expect(html).toContain('10s');
    expect(html).not.toContain('15s');
  });
  it.each(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-3.8-flash'])('uses GRSAI shared chat transport for %s', async (modelId) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'fixture-key' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '回复' }, finish_reason: 'stop' }] }));
    await expect(generateText({ provider: 'grsai', model: `grsai/${modelId}`, prompt: '你好' })).resolves.toBe('回复');
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://grsai.dakka.com.cn/v1/chat/completions');
    expect(JSON.parse(init.body)).toMatchObject({ model: modelId, stream: false });
  });

  it.each(['nano-banana-2.1', 'nano-banana-2-lite', 'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])('submits GRSAI %s through its native image contract', async (modelId) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'fixture-key' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/image.png' }] }));
    const result = await generateImagesBatch({ provider: 'grsai', model: `grsai/${modelId}`, prompt: '海报', imageSize: '4K', aspectRatio: '16:9' }, 1);
    expect(result.results).toHaveLength(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://grsai.dakka.com.cn/v1/api/generate');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: modelId, replyType: 'json', images: [] });
    expect(body).not.toHaveProperty('resolution');
    if (modelId === 'nano-banana-2-lite') expect(body.imageSize).toBe('1K');
    else if (modelId === 'nano-banana-2.1') expect(body.imageSize).toBe('4K');
    else expect(body).toMatchObject({ aspectRatio: modelId === 'gpt-image-2.5' ? '16:9' : '3840x2160', quality: modelId === 'gpt-image-2.5' ? 'auto' : 'medium' });
  });
  it.each(['DeepSeek-V4.1-Flash', 'GLM-5.3-Flash', 'Qwen3.8-Flash', 'mI MiMo-V2.5',
    'Hy3', 'claude-sonnet-4-6', 'gemini-3.5-flash', 'grok-4.5'])('uses shared OpenAI chat requests for CCC %s in nodes and conversations', async (modelId) => {
    const catalogModel = getProviderDefinition('cccapi')!.models!.find((model) => model.id === modelId)!;
    useAppStore.setState((state) => ({ config: {
      ...state.config, assistantModelId: 'ccc-text',
      providers: { ...state.config.providers, cccapi: {
        name: 'CCC', apiKey: 'fixture-key', baseUrl: 'https://cccapi.cn/v1', catalogId: 'cccapi',
      } },
      generalModels: [{ id: 'ccc-text', name: modelId, modelId, category: 'text',
        providerConfigId: 'cccapi', executionProfile: catalogModel.executionProfile }],
    } }));
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({
      choices: [{ message: { content: 'CCC 回复' }, finish_reason: 'stop' }],
    }));
    await expect(generateText({ provider: 'general', model: 'general/ccc-text', prompt: '你好' }))
      .resolves.toBe('CCC 回复');
    await expect(streamAssistantReply({ systemPrompt: '系统', userMessage: '你好',
      nonStream: true, onEvent: vi.fn(),
    })).resolves.toBe('CCC 回复');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of transportMocks.corsSafeFetch.mock.calls as [string, RequestInit][]) {
      expect(url).toBe('https://cccapi.cn/v1/chat/completions');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
      expect(JSON.parse(String(init.body))).toMatchObject({ model: modelId, stream: false,
        messages: expect.arrayContaining([{ role: 'user', content: '你好' }]),
      });
    }
    transportMocks.corsSafeFetch.mockClear();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(
      'data: {"choices":[{"delta":{"content":"CCC 流式回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ));
    const onEvent = vi.fn();
    await expect(streamAssistantReply({ systemPrompt: '系统', userMessage: '你好', onEvent }))
      .resolves.toBe('CCC 流式回复');
    expect(onEvent).toHaveBeenCalledWith({ type: 'text.delta', delta: 'CCC 流式回复' });
    const [streamUrl, streamInit] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(streamUrl).toBe('https://cccapi.cn/v1/chat/completions');
    expect(JSON.parse(String(streamInit.body))).toMatchObject({ model: modelId, stream: true });
  });

  it.each(['gemini-3-pro-image-preview', 'gemini-3-pro-image', 'gemini-3.1-flash-image',
    'gemini-2.5-flash-image', 'nano-banana2', 'nano-banana-pro'])('uses CCC native Gemini image requests and Base64 results for %s', async (modelId) => {
    const catalogModel = getProviderDefinition('cccapi')!.models!.find((model) => model.id === modelId)!;
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, cccapi: {
        name: 'CCC', apiKey: 'fixture-key', baseUrl: 'https://cccapi.cn/v1', catalogId: 'cccapi',
      } },
      generalModels: [{ id: 'ccc-native-image', name: modelId, modelId, category: 'image',
        providerConfigId: 'cccapi', executionProfile: catalogModel.executionProfile }],
    } }));
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ candidates: [{
      content: { parts: [{ text: '图片说明' }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] },
    }] }));
    const params = { provider: 'general', model: 'general/ccc-native-image', prompt: '画一只猫',
      imageSize: '4K', aspectRatio: '16:9' };
    await expect(generateImagesBatch(params, 1))
      .resolves.toMatchObject({ results: [{ url: 'data:image/png;base64,aW1hZ2U=' }] });
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://cccapi.cn/v1beta/models/${modelId}:generateContent`);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
    expect(JSON.parse(String(init.body))).toEqual({
      contents: [{ role: 'user', parts: [{ text: '画一只猫' }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: {
        aspectRatio: '16:9', ...(modelId === 'gemini-2.5-flash-image' ? {} : { imageSize: '4K' }),
      } },
    });

    // 各个已知型号均须发送完整原生多图内容。
    transportMocks.corsSafeFetch.mockClear();
    await expect(generateImagesBatch({ ...params,
      image_urls: ['data:image/webp;base64,YQ==', 'data:image/webp;base64,Yg=='],
    }, 1)).resolves.toMatchObject({ results: [{ url: 'data:image/png;base64,aW1hZ2U=' }] });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    const referenceBody = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body));
    expect(referenceBody.contents[0].parts).toEqual([
      { text: expect.stringContaining('画一只猫') },
      { inlineData: { mimeType: 'image/webp', data: 'YQ==' } },
      { inlineData: { mimeType: 'image/webp', data: 'Yg==' } },
    ]);
    transportMocks.corsSafeFetch.mockClear();

    const controller = new AbortController();
    controller.abort();
    await expect(generateImagesBatch(params, 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();

    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ candidates: [{
      content: { parts: [{ text: '无法生成图片' }] },
    }] }));
    await expect(generateImagesBatch(params, 1)).rejects.toThrow('未找到配置的结果');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    transportMocks.corsSafeFetch.mockClear();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { message: '上游生图超时' },
    }), { status: 504, headers: { 'Content-Type': 'application/json' } }));
    await expect(generateImagesBatch(params, 1)).rejects.toThrow('上游生图超时');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the gateway JSON preset when an older model still has a reference request mode', async () => {
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, gateway: {
        name: '图片网关', apiKey: 'fixture-key', baseUrl: 'https://gateway.example/v1',
        catalogId: 'custom-openai',
      } },
      generalModels: [{ id: 'gateway-image', name: 'GPT Image 中转', modelId: 'gpt-image-2',
        category: 'image', providerConfigId: 'gateway',
        imageReferenceRequestMode: 'edits-multipart',
        executionProfile: { preset: 'gpt-image-gateway-json' },
      }],
    } }));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    await generateImagesBatch({ provider: 'general', model: 'general/gateway-image',
      prompt: '按参考图创作', image_urls: ['https://cdn.example/reference.png'],
    }, 1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example/v1/images/generations');
    expect(JSON.parse(String(init.body)).images).toEqual(['https://cdn.example/reference.png']);
  });
  it.each([
    { provider: 'grsai', referenceCount: 2 },
    { provider: 'saved-grsai', referenceCount: 3 },
    { provider: 'general', referenceCount: 3 },
  ])('sends GRSAI native references from local assets in order ($provider)', async ({ provider, referenceCount }) => {
    const connectionId = provider === 'general' ? 'saved-grsai' : provider;
    const legacyModel = {
      id: 'grsai-ref', name: 'Nano Banana 2', modelId: 'nano-banana-2', category: 'image' as const,
      providerConfigId: connectionId, imageReferenceRequestMode: 'edits-multipart' as const,
      executionProfile: { preset: 'openai-image' as const },
    };
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, [connectionId]: {
        name: 'GRSAI', catalogId: 'grsai', apiKey: 'secret', baseUrl: 'https://grsai.dakka.com.cn/v1',
        selectedModels: [{ id: 'nano-banana-2', name: 'Nano Banana 2', provider: 'grsai', category: 'image', imageReferenceRequestMode: 'edits-multipart' }],
      } },
      generalModels: [legacyModel],
    }, nodes: Array.from({ length: referenceCount }, (_, index) => ({
      id: `grs-ref-${index}`, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: `参考${index}`, imageUrl: `asset://localhost/grs-${index}.png`, sourceUrl: `https://expired.example/grs-${index}.png` },
    })) }));
    const savedConfig = structuredClone(useAppStore.getState().config);
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (
      new Response(String(url), { headers: { 'Content-Type': 'image/png' } })
    ));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/grs-result.png' }] }));
    const result = await generateImagesBatch({
      provider, model: provider === 'general' ? 'general/grsai-ref' : `${provider}/nano-banana-2`,
      prompt: `${Array.from({ length: referenceCount }, (_, index) => `@{grs-ref-${index}:参考${index}}`).join('')} 合影`,
      imageSize: '2K', aspectRatio: '16:9',
    }, 1);
    expect(result.results[0].url).toBe('https://cdn.example/grs-result.png');
    expect(localFetch).toHaveBeenCalledTimes(referenceCount);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://grsai.dakka.com.cn/v1/api/generate');
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(['aspectRatio', 'imageSize', 'images', 'model', 'prompt', 'replyType']);
    expect(body).toMatchObject({ model: 'nano-banana-2', aspectRatio: '16:9', imageSize: '2K', replyType: 'json' });
    expect(body.images.map((dataUrl: string) => atob(dataUrl.split(',')[1]))).toEqual(
      Array.from({ length: referenceCount }, (_, index) => `asset://localhost/grs-${index}.png`),
    );
    expect(body.prompt).not.toContain('@{');
    expect(useAppStore.getState().config).toEqual(savedConfig);
  });

  it('uses the GRSAI default base URL and native GPT size fields for text-only requests', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { grsai: { name: 'GRSAI', apiKey: 'secret' } },
    } }));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/gpt.png' }] }));
    const result = await generateImagesBatch({ provider: 'grsai', model: 'grsai/gpt-image-2-vip', prompt: '海报', imageSize: '4K', aspectRatio: '16:9' }, 1);
    expect(result.results[0]).toEqual({ url: 'https://cdn.example/gpt.png', width: 3840, height: 2160 });
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://grsai.dakka.com.cn/v1/api/generate');
    expect(JSON.parse(init.body)).toEqual({ model: 'gpt-image-2-vip', prompt: '海报', images: [], aspectRatio: '3840x2160', quality: 'medium', replyType: 'json' });
  });

  it.each([
    { status: 400, payload: { error: 'reference image rejected' }, message: 'reference image rejected' },
    { status: 504, payload: { error: 'gateway timeout' }, message: '504' },
    { status: 200, payload: { status: 'failed', error: 'generation failed' }, message: 'generation failed' },
    { status: 200, payload: { status: 'violation', error: 'request rejected' }, message: 'request rejected' },
    { status: 200, payload: { status: 'running', id: 'unfinished-task' }, message: '不要重复提交' },
    { status: 200, payload: { status: 'succeeded', results: [] }, message: '未找到配置的结果' },
  ])('does not resubmit GRSAI on failed/unknown responses ($message)', async ({ status, payload, message }) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'secret' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValue(new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }));
    await expect(generateImagesBatch({ provider: 'grsai', model: 'grsai/nano-banana-2', prompt: '合影' }, 3)).rejects.toThrow(message);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps GRSAI batch successes and stops submitting when a later item fails', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'secret' } } } }));
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/first.png' }] }))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', error: 'failed' }));
    const result = await generateImagesBatch({ provider: 'grsai', model: 'grsai/nano-banana-2', prompt: '合影' }, 3);
    expect(result.results.map((item) => item.url)).toEqual(['https://cdn.example/first.png']);
    expect(result.failedCount).toBe(2);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('cancels GRSAI without starting a second batch request', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'secret' } } } }));
    const controller = new AbortController();
    transportMocks.corsSafeFetch.mockImplementation(async (_url, init) => {
      expect(init.signal).toBe(controller.signal);
      controller.abort();
      return jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/late.png' }] });
    });
    await expect(generateImagesBatch({ provider: 'grsai', model: 'grsai/nano-banana-2', prompt: '合影' }, 2, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated node references: A B B uploads two images, A B C uploads three', async () => {
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, cccapi: { name: 'CCC', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1' } },
    }, nodes: ['a', 'b', 'c'].map((id) => ({
      id, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: id, imageUrl: `asset://localhost/${id}.png` },
    })) }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('png', { headers: { 'Content-Type': 'image/png' } }));
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    for (const [prompt, count] of [['@{a:a}@{b:b}@{b:b}', 2], ['@{a:a}@{b:b}@{c:c}', 3]] as const) {
      await generateImagesBatch({ provider: 'cccapi', model: 'cccapi/gpt-image-2', prompt: `${prompt} 合影` }, 1);
      const body = transportMocks.corsSafeFetch.mock.calls.at(-1)![1].body as FormData;
      expect(body.getAll('image[]')).toHaveLength(count);
    }
  });

  it('includes actual model, reference count, transfer size and elapsed time on transport failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('image', { headers: { 'Content-Type': 'image/png' } }));
    transportMocks.corsSafeFetch.mockRejectedValue(new Error('connection reset'));
    const error = await generateImageStandard({
      apiKey: 'secret', baseUrl: 'https://gateway.example/v1', modelName: 'gpt-image-2', prompt: 'private prompt',
      dimensions: { width: 1024, height: 1024 }, imageReferenceRequestMode: 'edits-multipart',
      imageUrls: ['asset://localhost/private.png'],
    }).catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('connection reset');
    expect(message).toContain('模型 gpt-image-2；参考图 1 张，共 0.00 MiB；输出 1024x1024；等待');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('private');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('submits four CCC prompt references once in order and does not retry a gateway 504', async () => {
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, cccapi: { name: 'CCC', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1' } },
      generalModels: [{ id: 'ccc-four', name: 'GPT Image 2', modelId: 'gpt-image-2', category: 'image', providerConfigId: 'cccapi' }],
    }, nodes: Array.from({ length: 4 }, (_, index) => ({
      id: `ref-${index}`, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: `参考${index}`, imageUrl: `asset://localhost/reference-${index}.png`, sourceUrl: `https://expired.example/${index}.png` },
    })) }));
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (
      new Response(String(url), { headers: { 'Content-Type': 'image/png' } })
    ));
    transportMocks.corsSafeFetch.mockResolvedValue(new Response('<html><body>504 Gateway Time-out nginx</body></html>', {
      status: 504, headers: { 'Content-Type': 'text/html' },
    }));
    await expect(generateImagesBatch({
      provider: 'general', model: 'general/ccc-four',
      prompt: '@{ref-0:参考0}@{ref-1:参考1}@{ref-2:参考2}@{ref-3:参考3} 他们两个人一起合影',
    }, 1)).rejects.toThrow('网关等待上游响应超时');
    expect(localFetch).toHaveBeenCalledTimes(4);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cccapi.cn/v1/images/edits');
    const body = init.body as FormData;
    const files = body.getAll('image[]') as File[];
    expect(files).toHaveLength(4);
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(
      Array.from({ length: 4 }, (_, index) => `asset://localhost/reference-${index}.png`),
    );
    expect(body.get('n')).toBe('1');
  });

  it.each(['cccapi', 'legacy-ccc', 'general'])('uses CCC catalog multipart before uploading references (%s)', async (provider) => {
    const connectionId = provider === 'general' ? 'legacy-ccc' : provider;
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, [connectionId]: {
        name: 'CCC', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1',
        ...(provider === 'cccapi' ? {} : { catalogId: 'cccapi' }),
      } },
      generalModels: [{ id: 'old-image', name: 'GPT Image 2', modelId: 'gpt-image-2',
        category: 'image', providerConfigId: connectionId }],
    } }));
    const localUrl = 'asset://localhost/D%3A%2Fproject%2Freference.png';
    useAppStore.setState({ nodes: [{ id: 'ref', type: 'ai-image', position: { x: 0, y: 0 }, data: {
      label: 'reference', type: 'ai-image', imageUrl: localUrl, sourceUrl: 'https://expired.example/old.png',
    } }] });
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url !== localUrl) throw new Error('Unexpected upload');
      return new Response(Uint8Array.from([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
    });
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    const params = { provider, model: provider === 'general' ? 'general/old-image' : `${provider}/gpt-image-2`, prompt: 'edit' };
    for (let attempt = 0; attempt < 2; attempt++) {
      await generateImagesBatch(attempt === 0 ? { ...params, image_urls: [localUrl] }
        : { ...params, prompt: '@{ref:reference} edit' }, 1);
      const [url, init] = transportMocks.corsSafeFetch.mock.calls.at(-1)! as [string, RequestInit];
      expect(url).toBe('https://cccapi.cn/v1/images/edits');
      expect((init.body as FormData).getAll('image[]')).toHaveLength(1);
    }
    expect(localFetch).toHaveBeenCalledTimes(2);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    await generateImagesBatch(params, 1);
    expect(transportMocks.corsSafeFetch.mock.calls.at(-1)![0]).toBe('https://cccapi.cn/v1/images/generations');
  });

  it.each([true, false])('respects a custom gateway JSON reference mode (explicit mode: %s)', async (explicitMode) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      ...state.config.providers, gateway: { name: 'gateway', apiKey: 'secret', baseUrl: 'https://gateway.example/v1', catalogId: 'custom-openai',
        selectedModels: explicitMode ? [{ id: 'gpt-image-2', name: 'image', provider: 'gateway', category: 'image', imageReferenceRequestMode: 'generation-json-image-urls' }] : [],
      },
    } } }));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    await generateImagesBatch({ provider: 'gateway', model: 'gateway/gpt-image-2', prompt: 'edit', image_urls: ['https://cdn.example/ref.png'] }, 1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example/v1/images/generations');
    expect(JSON.parse(init.body as string).image_urls).toEqual(['https://cdn.example/ref.png']);
  });

  it.each([
    { referenceCount: 2, legacyMode: 'generation-json-image-urls' as const, legacyPreset: 'custom' as const },
    { referenceCount: 3, legacyMode: 'generation-json-image-data-urls' as const, legacyPreset: 'openai-image' as const },
  ])('uses the CCC Sunburst standard contract despite legacy settings ($referenceCount references)', async ({ referenceCount, legacyMode, legacyPreset }) => {
    const modelId = 'gpt-image-2.5-sunburst';
    const legacyProfile = {
      preset: legacyPreset,
      protocol: {
        version: 2 as const,
        mode: 'sync' as const,
        submit: { method: 'POST' as const, path: '/images/generations', body: {
          model: '{{model}}', prompt: '{{prompt}}', image_urls: '{{imageUrls}}', resolution: '{{imageSize}}',
        } },
        response: { type: 'json' as const, result: { urlPath: 'data.*.url' } },
      },
    };
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, ccc: {
        name: 'CCC API', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1', catalogId: 'cccapi',
        selectedModels: [{ id: modelId, name: modelId, category: 'image', provider: 'cccapi',
          imageReferenceRequestMode: legacyMode, executionProfile: legacyProfile }],
      } },
      generalModels: [{ id: modelId, name: modelId, modelId, category: 'image', providerConfigId: 'ccc',
        imageReferenceRequestMode: legacyMode, executionProfile: legacyProfile }],
    }, nodes: Array.from({ length: referenceCount }, (_, index) => ({
      id: `person-${index}`, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: `人物${index + 1}`, imageUrl: `asset://localhost/person-${index}.png`,
        sourceUrl: `https://expired.example/person-${index}.png` },
    })) }));
    const savedConfig = useAppStore.getState().config;
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (!String(url).startsWith('asset://localhost/person-')) throw new Error('Unexpected upload');
      return new Response(String(url), { headers: { 'Content-Type': 'image/png' } });
    });
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ data: [{ b64_json: 'aW1hZ2U=' }] }));

    const params = { provider: 'general', model: `general/${modelId}`, imageSize: '2K', aspectRatio: '16:9',
      prompt: Array.from({ length: referenceCount }, (_, index) => `@{person-${index}:人物${index + 1}}`).join('') + '一起合影' };
    await expect(generateImagesBatch(params, 1)).resolves.toMatchObject({
      results: [{ url: 'data:image/png;base64,aW1hZ2U=' }],
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cccapi.cn/v1/images/edits');
    const body = init.body as FormData;
    expect([...new Set(body.keys())].sort()).toEqual(['image[]', 'model', 'n', 'prompt', 'quality', 'size']);
    expect(body.get('quality')).toBe('auto');
    expect(body.get('model')).toBe(modelId);
    expect(body.get('n')).toBe('1');
    expect(body.get('size')).toBe('3648x2048');
    expect(body.get('prompt')).toContain(`本次请求附带 ${referenceCount} 张参考图`);
    const files = body.getAll('image[]') as File[];
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(
      Array.from({ length: referenceCount }, (_, index) => `asset://localhost/person-${index}.png`),
    );
    expect(localFetch).toHaveBeenCalledTimes(referenceCount);

    await expect(generateImagesBatch({ ...params, prompt: '风景' }, 1)).resolves.toMatchObject({
      results: [{ url: 'data:image/png;base64,aW1hZ2U=' }],
    });
    const [generationUrl, generationInit] = transportMocks.corsSafeFetch.mock.calls[1] as [string, RequestInit];
    expect(generationUrl).toBe('https://cccapi.cn/v1/images/generations');
    expect(JSON.parse(generationInit.body as string)).toEqual({ model: modelId, prompt: '风景', n: 1, size: '3648x2048', quality: 'auto' });
    expect(useAppStore.getState().config).toBe(savedConfig);
    expect(savedConfig.generalModels?.[0].executionProfile).toEqual(legacyProfile);
  });

  it.each([
    { catalogId: 'custom-openai', modelId: 'gpt-image-2.5-sunburst' },
    { catalogId: 'cccapi', modelId: 'vendor-image' },
    { catalogId: 'custom-openai', modelId: 'nano-banana-2' },
    { catalogId: 'grsai', modelId: 'vendor-image' },
  ])('preserves the explicit protocol outside documented built-in image contracts ($catalogId/$modelId)', async ({ catalogId, modelId }) => {
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, custom: {
        name: '自定义接口', apiKey: 'secret', baseUrl: 'https://gateway.example/v1', catalogId,
      } },
      generalModels: [{ id: 'custom-image', name: modelId, modelId, category: 'image', providerConfigId: 'custom',
        executionProfile: { preset: 'custom', protocol: {
          version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/vendor/image-render', body: {
            model: '{{model}}', prompt: '{{prompt}}', images: '{{imageUrls}}',
          } },
          response: { type: 'json', result: { urlPath: 'output.image' } },
        } },
      }],
    } }));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ output: { image: 'https://cdn.example/result.png' } }));
    await expect(generateImagesBatch({
      provider: 'general', model: 'general/custom-image', prompt: 'edit', image_urls: ['https://cdn.example/reference.png'],
    }, 1)).resolves.toMatchObject({ results: [{ url: 'https://cdn.example/result.png' }] });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example/v1/vendor/image-render');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: modelId, images: ['https://cdn.example/reference.png'] });
  });

  it.each([false, true])('submits the current ratio after editing an image node (drag duplicate: %s)', async (duplicate) => {
    const reference = 'data:image/png;base64,iVBORw==';
    useAppStore.setState((state) => ({
      config: { ...state.config,
        providers: { ...state.config.providers, ccc: {
          name: 'CCC', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1', catalogId: 'cccapi',
        } },
        generalModels: [{ id: 'ccc-image', name: 'GPT Image 2', modelId: 'gpt-image-2',
          category: 'image', providerConfigId: 'ccc', imageReferenceRequestMode: 'edits-multipart',
        }],
      },
      nodes: [
        { id: 'reference', type: 'ai-image', position: { x: 0, y: 0 },
          data: { type: 'ai-image', label: '参考图', imageUrl: reference } },
        { id: 'image', type: 'ai-image', position: { x: 300, y: 0 },
          data: { type: 'ai-image', label: '生成图', model: 'general/ccc-image', provider: 'general',
            prompt: '@{reference:参考图} 新场景', imageSize: '2K', aspectRatio: '16:9',
            imageUrl: reference, imageWidth: 1024, imageHeight: 1024, nodeWidth: 280, nodeHeight: 280,
          } },
      ],
    }));
    if (duplicate) useAppStore.getState().duplicateNode('image');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      Uint8Array.from([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } },
    ));
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({
      data: [{ url: 'https://cdn.example/result.png' }],
    }));
    for (const [ratio, size, orientation] of [['16:9', '3648x2048', '横屏'], ['9:16', '2048x3648', '竖屏'], ['3:4', '2048x2736', '竖屏'], ['1:1', '2048x2048', '正方形']]) {
      useAppStore.getState().updateNodeData('image', { aspectRatio: ratio, prompt: '@{reference:参考图} 修改后的场景' });
      const data = useAppStore.getState().nodes.find((node) => node.id === 'image')!.data;
      await generateImagesBatch({ prompt: data.prompt!, model: data.model!, provider: data.provider!,
        imageSize: data.imageSize, aspectRatio: data.aspectRatio, nodeId: 'image',
      }, 1);
      const [url, init] = transportMocks.corsSafeFetch.mock.calls.at(-1)! as [string, RequestInit];
      expect(url).toBe('https://cccapi.cn/v1/images/edits');
      const body = init.body as FormData;
      expect(body.get('size')).toBe(size);
      expect(body.getAll('image[]')).toHaveLength(1);
      expect(body.get('prompt')).toContain(`${ratio}（${orientation}，宽:高）`);
      expect(body.get('prompt')).toContain('不继承参考图或旧图的宽高比');
      expect(body.get('prompt')).not.toContain('复制版式、构图与设计语言时以对应参考图为准');
    }
    await generateImagesBatch({ prompt: '@{reference:参考图} 修改后的场景',
      model: 'general/ccc-image', provider: 'general', aspectRatio: '自适应', nodeId: 'image',
    }, 1);
    const adaptive = transportMocks.corsSafeFetch.mock.calls.at(-1)![1].body as FormData;
    expect(adaptive.get('prompt')).not.toContain('【输出画幅】');
  });

  it.each([true, false])('preserves a custom multipart endpoint and response mapping (explicit mode: %s)', async (explicitMode) => {
    const imported = analyzeModelProtocolExamples({
      submitRequest: `curl https://gateway.example/v1/custom/images/edit
        -H 'Authorization: Bearer sk-placeholder'
        -F 'model=custom-image' -F 'prompt=edit'
        -F 'images=@/private/reference.png'`,
      submitResponse: '{"output":{"url":"https://cdn.example/custom-result.png"}}',
    });
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, custom: {
        name: '自定义接口', apiKey: 'secret', baseUrl: imported.baseUrl!, catalogId: 'custom-openai',
      } },
      generalModels: [{ id: 'custom-image', name: '自定义图片', modelId: 'custom-image',
        category: 'image', providerConfigId: 'custom',
        imageReferenceRequestMode: explicitMode ? 'edits-multipart' : undefined,
        executionProfile: { preset: 'custom', protocol: imported.protocol! },
      }],
    } }));
    const nativeFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected upload'));
    transportMocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url === 'https://cdn.example/reference.png') return new Response(
        Uint8Array.from([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } },
      );
      if (url === 'https://gateway.example/v1/custom/images/edit') return jsonResponse({
        output: { url: 'https://cdn.example/custom-result.png' },
      });
      throw new Error('Unexpected endpoint');
    });
    const controller = new AbortController();
    const params = { provider: 'general', model: 'general/custom-image', prompt: 'edit',
      image_urls: ['data:image/jpeg;base64,aGVsbG8=', 'https://cdn.example/reference.png'] };
    await expect(generateImagesBatch(params, 1, controller.signal)).resolves.toMatchObject({
      results: [{ url: 'https://cdn.example/custom-result.png' }],
    });
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    const init = transportMocks.corsSafeFetch.mock.calls[1][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
    const body = new TextDecoder().decode(init.body as ArrayBuffer);
    expect(body.split('name="images"; filename=')).toHaveLength(3);
    expect(body).toContain('Content-Type: image/jpeg');
    expect(body).toContain('Content-Type: image/png');
    controller.abort();
    await expect(generateImagesBatch(params, 1, controller.signal)).rejects.toThrow();
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('reproduces the reference-field warning for a text-only custom protocol despite an edits mode setting', async () => {
    const imported = analyzeModelProtocolExamples({
      submitRequest: `curl https://gateway.example/v1/images/generations
        -H 'Content-Type: application/json'
        -d '{"model":"gpt-image-2","prompt":"draw"}'`,
      submitResponse: '{"data":[{"url":"https://cdn.example/result.png"}]}',
    });
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, wm: { name: 'WM', apiKey: 'secret', baseUrl: imported.baseUrl! } },
      generalModels: [{ id: 'wm-image', name: 'gpt-image-2', modelId: 'gpt-image-2', category: 'image',
        providerConfigId: 'wm', imageReferenceRequestMode: 'edits-multipart',
        executionProfile: { preset: 'custom', protocol: imported.protocol! },
      }],
    } }));
    await expect(generateImagesBatch({ provider: 'general', model: 'general/wm-image', prompt: 'edit',
      image_urls: ['https://cdn.example/ref.png'],
    }, 1)).rejects.toThrow('没有完整接收参考图');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('adds actionable guidance to ambiguous API Key errors', async () => {
    const response = new Response(JSON.stringify({
      error: { message: 'apikey error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    await expect(parseResponseError(response, '图片生成失败 (400)')).rejects.toThrow(
      'apikey error（请确认使用模型 API Key，而非账户令牌；若密钥正确，请检查账户权限和积分余额）',
    );
  });

  it('reads the top-level error string used by the new GRSAI generation API', async () => {
    const response = new Response(JSON.stringify({
      id: '',
      status: 'failed',
      error: 'insufficient credits',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    await expect(parseResponseError(response, '图片生成失败 (400)')).rejects.toThrow(
      'insufficient credits',
    );
  });

  it('routes ordinary text generation through the shared transport', async () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          apimart: { name: 'APIMart', apiKey: 'secret', baseUrl: 'https://gateway.example/v1' },
        },
      },
    }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: '文本结果' } }],
    }));

    await expect(generateText({
      provider: 'apimart',
      model: 'apimart/vendor-chat',
      prompt: '你好',
    })).resolves.toBe('文本结果');

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('routes standard image generation through the shared transport', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ url: 'https://cdn.example/image.png' }],
    }));

    await expect(generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      modelName: 'gpt-image-1',
      prompt: '一张图片',
      dimensions: { width: 1024, height: 1024 },
      imageReferenceRequestMode: 'edits-multipart',
    })).resolves.toMatchObject({ url: 'https://cdn.example/image.png' });

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/images/generations',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps JSON image_urls generation for compatible reference-image providers', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ url: 'https://cdn.example/generated.png' }],
    }));

    await generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      modelName: 'gpt-image-2',
      prompt: '参考角色生成场景',
      dimensions: { width: 1536, height: 1024 },
      imageUrls: ['https://cdn.example/reference.png'],
      imageReferenceRequestMode: 'generation-json-image-urls',
    });

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/images/generations',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-image-2',
      image_urls: ['https://cdn.example/reference.png'],
    });
  });

  it('sends base64 reference arrays through the JSON image field', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ url: 'https://cdn.example/generated.png' }],
    }));
    const image = 'data:image/png;base64,iVBORw0KGgo=';

    await generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      modelName: 'custom-image-model',
      prompt: '参考角色生成场景',
      dimensions: { width: 1024, height: 1024 },
      imageUrls: [image],
      imageReferenceRequestMode: 'generation-json-image-data-urls',
    });

    const [, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'custom-image-model',
      image: [image],
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty('image_urls');
  });

  it('converts remote reference images into base64 data URLs', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(
      Uint8Array.from([137, 80, 78, 71]),
      { status: 200, headers: { 'Content-Type': 'image/png' } },
    ));

    await expect(resolveImageDataUrlArray([
      'https://cdn.example/reference.png',
    ])).resolves.toEqual([
      'data:image/png;base64,iVBORw==',
    ]);
  });

  it('keeps data URL references in a configured async image protocol', async () => {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          rightapi: {
            name: 'RightAPI',
            apiKey: 'secret',
            baseUrl: 'https://www.right.codes/draw/v1',
          },
        },
        generalModels: [{
          id: 'rightapi-image',
          name: 'RightAPI 图片',
          modelId: 'nano-banana-fast',
          category: 'image',
          providerConfigId: 'rightapi',
          imageReferenceRequestMode: 'generation-json-image-data-urls',
          executionProfile: {
            preset: 'custom',
            protocol: {
              version: 2,
              mode: 'async',
              submit: {
                method: 'POST',
                path: '/images/generations',
                body: {
                  model: '{{model}}',
                  prompt: '{{prompt}}',
                  n: '{{n}}',
                  size: '{{aspectRatio}}',
                  imageSize: '{{imageSize}}',
                  async: true,
                  image: '{{imageUrls}}',
                },
              },
              response: { type: 'json', taskIdPath: 'task_id' },
              poll: {
                method: 'GET',
                path: '/v1/tasks/{{submit.task_id}}',
                pathMode: 'origin',
                response: {
                  statusPath: 'status',
                  successValues: ['completed'],
                  failureValues: ['failed'],
                  result: { urlPath: 'data.*.url' },
                  errorPath: 'error.message',
                  progressPath: 'progress',
                },
                intervalMs: 1000,
              },
            },
          },
        }],
      },
    }));
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task-123', status: 'processing' }))
      .mockResolvedValueOnce(jsonResponse({
        task_id: 'task-123',
        status: 'completed',
        progress: 100,
        data: [{ url: 'https://cdn.example/result.png' }],
      }));

    await expect(generateImagesBatch({
      provider: 'general',
      model: 'general/rightapi-image',
      prompt: '改成赛博朋克风格',
      imageSize: '1K',
      aspectRatio: '16:9',
      image_urls: [image],
    }, 1)).resolves.toMatchObject({
      results: [{ url: 'https://cdn.example/result.png' }],
    });

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    const [submitUrl, submitInit] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(submitUrl).toBe('https://www.right.codes/draw/v1/images/generations');
    expect(JSON.parse(String(submitInit.body))).toMatchObject({
      model: 'nano-banana-fast',
      async: true,
      image: [image],
    });
    expect(transportMocks.corsSafeFetch.mock.calls[1]?.[0]).toBe(
      'https://www.right.codes/v1/tasks/task-123',
    );
  });

  it('explains when an image endpoint returns an HTML page instead of JSON', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(
      '<!doctype html><html><body>gateway homepage</body></html>',
      {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      },
    ));

    await expect(generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://realmrouter.cn',
      modelName: 'gpt-image-1',
      prompt: '一张图片',
      dimensions: { width: 1024, height: 1024 },
    })).rejects.toThrow('图片接口返回了 HTML 页面，请检查连接地址是否指向 API 根路径（常见需要追加 /v1）');
  });

  it('uploads configured reference images as multipart files to image edits', async () => {
    transportMocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://cdn.example/reference-')) {
        return new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      return jsonResponse({ data: [{ url: 'https://cdn.example/edited.png' }] });
    });

    await expect(generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://realmrouter.cn/v1',
      modelName: 'gpt-image-2',
      prompt: '保持两个人物设定生成新场景',
      dimensions: { width: 1536, height: 1024 },
      imageUrls: [
        'https://cdn.example/reference-1.png',
        'https://cdn.example/reference-2.png',
      ],
      imageReferenceRequestMode: 'edits-multipart',
    })).resolves.toMatchObject({ url: 'https://cdn.example/edited.png' });

    const editsCall = transportMocks.corsSafeFetch.mock.calls.find(
      ([url]) => url === 'https://realmrouter.cn/v1/images/edits',
    ) as [string, RequestInit] | undefined;
    expect(editsCall).toBeDefined();
    const editsInit = editsCall?.[1];
    expect(editsInit?.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(editsInit?.body).toBeInstanceOf(FormData);
    const body = editsInit?.body as FormData;
    expect(body.get('model')).toBe('gpt-image-2');
    expect(body.get('prompt')).toBe('保持两个人物设定生成新场景');
    expect(body.get('size')).toBe('1536x1024');
    expect(body.getAll('image[]')).toHaveLength(2);
    expect(body.getAll('image')).toHaveLength(0);
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalledWith(
      'https://realmrouter.cn/v1/images/generations',
      expect.anything(),
    );
  });

  it.each([
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
    'gpt-image-2.5',
    'gpt-image-2',
  ])('routes CCC API %s references through image edits while keeping text-only generations', async (modelId) => {
    const cccModel = (getProviderDefinition('cccapi')?.models ?? [])
      .find((item) => item.id === modelId);
    expect(cccModel?.imageReferenceRequestMode).toBe('edits-multipart');
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          'cccapi-image': {
            name: 'CCC API 图片',
            apiKey: 'secret',
            baseUrl: 'https://cccapi.cn/v1',
            catalogId: 'cccapi',
          },
        },
        generalModels: [{
          id: `cccapi-${modelId}`,
          name: cccModel?.name ?? modelId,
          modelId: cccModel?.id ?? modelId,
          category: 'image',
          providerConfigId: 'cccapi-image',
          imageReferenceRequestMode: cccModel?.imageReferenceRequestMode,
        }],
      },
    }));
    transportMocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url === 'https://cdn.example/reference.png') {
        return new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      if (url === 'https://cccapi.cn/v1/images/edits') {
        return jsonResponse({ data: [{ url: 'https://cdn.example/edited.png' }] });
      }
      return jsonResponse({ data: [{ url: 'https://cdn.example/generated.png' }] });
    });

    await expect(generateImagesBatch({
      provider: 'general',
      model: `general/cccapi-${modelId}`,
      prompt: '保持人物设定生成新场景',
      imageSize: '1K',
      aspectRatio: '1:1',
      image_urls: ['https://cdn.example/reference.png'],
    }, 1)).resolves.toMatchObject({ results: [{ url: 'https://cdn.example/edited.png' }] });

    const editsCall = transportMocks.corsSafeFetch.mock.calls.find(
      ([url]) => url === 'https://cccapi.cn/v1/images/edits',
    ) as [string, RequestInit] | undefined;
    expect(editsCall?.[1].body).toBeInstanceOf(FormData);
    expect((editsCall?.[1].body as FormData).getAll('image[]')).toHaveLength(1);

    // 本地图片应直接读取后随 multipart 提交，不上传第三方图床。
    const localReference = 'data:image/png;base64,iVBORw==';
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input !== localReference) throw new Error('Unexpected external upload');
      return new Response(Uint8Array.from([137, 80, 78, 71]), {
        headers: { 'Content-Type': 'image/png' },
      });
    });
    transportMocks.corsSafeFetch.mockClear();
    await expect(generateImagesBatch({
      provider: 'general',
      model: `general/cccapi-${modelId}`,
      prompt: '结合本地和远程参考图生成场景',
      imageSize: '1K',
      aspectRatio: '1:1',
      image_urls: [localReference, 'https://cdn.example/reference.png'],
    }, 1)).resolves.toMatchObject({ results: [{ url: 'https://cdn.example/edited.png' }] });
    expect(localFetch).toHaveBeenCalledTimes(1);
    expect(localFetch).toHaveBeenCalledWith(localReference, expect.any(Object));
    expect(transportMocks.corsSafeFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://cdn.example/reference.png',
      'https://cccapi.cn/v1/images/edits',
    ]);
    const mixedBody = transportMocks.corsSafeFetch.mock.calls[1][1].body as FormData;
    const files = mixedBody.getAll('image[]') as File[];
    expect(files).toHaveLength(2);
    expect(files.map((file) => [file.type, file.size])).toEqual([
      ['image/png', 4], ['image/png', 4],
    ]);

    await expect(generateImagesBatch({
      provider: 'general',
      model: `general/cccapi-${modelId}`,
      prompt: '纯文本生成一张图',
      imageSize: '1K',
      aspectRatio: '1:1',
    }, 1)).resolves.toMatchObject({ results: [{ url: 'https://cdn.example/generated.png' }] });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://cccapi.cn/v1/images/generations',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('routes assistant streaming requests through the shared transport', async () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        assistantModelId: 'assistant-model',
        providers: {
          ...state.config.providers,
          'custom-assistant': {
            name: '自定义助手连接',
            apiKey: 'secret',
            baseUrl: 'https://gateway.example/v1',
            catalogId: 'custom-openai',
          },
        },
        generalModels: [{
          id: 'assistant-model',
          name: '自定义助手',
          modelId: 'vendor-chat',
          category: 'text',
          providerConfigId: 'custom-assistant',
          executionProfile: { preset: 'openai-chat' },
        }],
      },
    }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: '助手结果' }, finish_reason: 'stop' }],
    }));

    await expect(streamAssistantReply({
      systemPrompt: '系统',
      userMessage: '你好',
      nonStream: true,
      onEvent: vi.fn(),
    })).resolves.toBe('助手结果');

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/chat/completions',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
  });
});
