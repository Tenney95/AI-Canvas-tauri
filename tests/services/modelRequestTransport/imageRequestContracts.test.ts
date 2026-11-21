import { describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  corsSafeFetch: vi.fn(),
  logAiResponse: vi.fn(),
}));

vi.mock('../../../src/services/ai/httpTransport', () => transportMocks);

import { generateImage, generateImagesBatch, inspectImagePromptLength } from '../../../src/services/ai/generateImage';
import { registerCharacterImageTaskContext } from '../../../src/services/characterImageTaskContext';
import { getProviderDefinition } from '../../../src/services/ai/providerCatalogService';
import { generateImageStandard } from '../../../src/services/ai/providers/standardImage';
import { resolveImageParameterCapability } from '../../../src/services/ai/mediaModelCapabilities';
import { getImageSizePresets } from '../../../src/services/ai/modelSizeProfiles';
import { useAppStore } from '../../../src/store/useAppStore';
import { createImageQuickAdaptTemplate } from '../../../src/services/ai/imageModelTemplates';
import { uploadToRemote } from '../../../src/services/uploadService';
import { clearProjectTasks, getPendingTasksForProject } from '../../../src/services/pollManager';
import { AIGCSI_BASE_URL } from '../../../src/services/ai/providers/aigcsiModelManifest';
import type { ModelExecutionProfile, ProtocolJsonValue } from '../../../src/types/aiTypes';
import { jsonResponse, setupTransportFixture } from './transportFixture';

const protocolSubmitDebug = () => expect.objectContaining({ debug: expect.objectContaining({
  stage: 'submit', traceId: expect.any(String),
}) });

async function multipartImageRequest(init: RequestInit) {
  expect(new Headers(init.headers).get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
  const form = await new Response(init.body, { headers: init.headers }).formData();
  return { form, fields: Object.fromEntries([...form].filter(([, value]) => typeof value === 'string')),
    files: [...form.getAll('image'), ...form.getAll('image[]')] as File[] };
}

setupTransportFixture(transportMocks.corsSafeFetch);

describe('GPT Image 2.6 的厂商请求合同', () => {
  it('超长提示词在标准 JSON 与 multipart 参考图读取和发送前拒绝', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const edit of [false, true]) {
      await expect(generateImageStandard({ apiKey: 'fixture', baseUrl: 'https://gateway.example/v1', modelName: 'gpt-image-2.6',
        prompt: '图'.repeat(38_956), dimensions: { width: 1024, height: 1024 },
        ...(edit ? { imageUrls: ['asset://localhost/reference.png'], imageReferenceRequestMode: 'edits-multipart' as const } : {}),
      })).rejects.toMatchObject({ name: 'ImagePromptOverflowError', characters: 38_956, maxCharacters: 32_000 });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('短 @ 引用展开为超长正文时，预检和实际提交使用相同长度', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      ...state.config.providers, cccapi: { name: 'CCC', apiKey: 'fixture' },
    } }, nodes: [{ id: 'long-text', type: 'ai-text', position: { x: 0, y: 0 },
      data: { type: 'ai-text', label: '长文', output: '图'.repeat(38_956) } }] }));
    const params = { provider: 'cccapi', model: 'cccapi/gpt-image-2.6', prompt: '@{long-text:长文}' };
    const overflow = await inspectImagePromptLength(params);
    expect(overflow).toMatchObject({ characters: 38_956, inputCharacters: params.prompt.length });
    await expect(generateImagesBatch(params, 1)).rejects.toMatchObject({ name: 'ImagePromptOverflowError', characters: 38_956 });
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/trimmed.png' }] }));
    await generateImagesBatch({ ...params, imagePromptResolution: { original: overflow!.prompt, replacement: '图'.repeat(32_000) } }, 1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body)).prompt).toHaveLength(32_000);
  });

  it('参考图与画幅说明也计入限制，旧提示词选择不能用于新正文', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      cccapi: { name: 'CCC', apiKey: 'fixture' } } } }));
    const params = { provider: 'cccapi', model: 'cccapi/gpt-image-2.6', prompt: '图'.repeat(31_950),
      image_urls: ['asset://localhost/reference.png'], aspectRatio: '9:16' };
    const overflow = await inspectImagePromptLength(params);
    expect(overflow!.characters).toBeGreaterThan(32_000);
    expect(overflow!.prompt).toContain('9:16');
    await expect(generateImagesBatch({ ...params, imagePromptResolution: { original: '旧正文', replacement: '精简描述' } }, 1))
      .rejects.toThrow('生成输入已变化');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('原生项目允许提示词预检，但实际生成仍要求受信提交守卫', async () => {
    useAppStore.setState((state) => ({ currentProjectId: 'native-canvas',
      projectExecutionContext: { kind: 'canvas', schemaVersion: 2, modelGeneration: 1,
        projectId: 'native-project', projectEpoch: 1, canvasId: 'native-canvas',
        canvasEpoch: 1, canvasRevision: 1, episodeId: null },
      config: { ...state.config, providers: { ...state.config.providers,
        cccapi: { name: 'CCC', apiKey: 'fixture' } } } }));
    const params = { provider: 'cccapi', model: 'cccapi/gpt-image-2.6', prompt: '图'.repeat(32_001) };
    await expect(inspectImagePromptLength(params)).resolves.toMatchObject({
      name: 'ImagePromptOverflowError', characters: 32_001, maxCharacters: 32_000,
    });
    await expect(generateImagesBatch({ ...params, prompt: '风景' }, 1))
      .rejects.toThrow('没有可耐久续查的完整回执');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it.each([false, true])('CCC 基础款兼容同步／异步结果（async=%s），只使用原分组 Key', async (asyncResult) => {
    const projectId = 'ccc-26-project';
    clearProjectTasks(projectId);
    useAppStore.getState().saveProviderConfig('ccc-26', { name: 'CCC 白嫖', catalogId: 'cccapi',
      cccGroup: 'CCC生图白嫖', apiKey: 'ccc-26-fixture', baseUrl: 'https://cccapi.cn/v1',
      selectedModels: [{ id: 'gpt-image-2.6', name: 'GPT Image 2.6', category: 'image', provider: 'ccc-26' }] });
    const selected = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'ccc-26')!;
    useAppStore.setState({ currentProjectId: projectId, nodes: [{ id: 'ccc-26-node', type: 'ai-image',
      position: { x: 0, y: 0 }, data: { type: 'ai-image', label: 'CCC 2.6', status: 'loading' } }] });
    if (asyncResult) {
      transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'ccc-26-task' }] }))
        .mockResolvedValueOnce(jsonResponse({ data: { id: 'ccc-26-task', status: 'completed',
          result: { images: [{ url: ['https://cdn.example/ccc-26.png'] }] } } }));
    } else {
      transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/ccc-26.png' }] }));
    }
    const result = await generateImagesBatch({ provider: 'general', model: `general/${selected.id}`,
      nodeId: 'ccc-26-node', prompt: '风景', imageSize: '1K', aspectRatio: '1:1',
      imageQuality: 'max', imageBackground: 'transparent' }, 1);
    expect(result.results[0].url).toBe('https://cdn.example/ccc-26.png');
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cccapi.cn/v1/images/generations');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ccc-26-fixture' });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'gpt-image-2.6', size: '1024x1024', n: 1 });
    for (const field of ['quality', 'background', 'output_format']) expect(body).not.toHaveProperty(field);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(asyncResult ? 2 : 1);
    if (asyncResult) {
      expect(transportMocks.corsSafeFetch.mock.calls[1][0]).toBe('https://cccapi.cn/v1/tasks/ccc-26-task');
      expect(getPendingTasksForProject(projectId)[0]).toMatchObject({ taskId: 'ccc-26-task',
        providerConfigId: 'ccc-26', mediaRecoveryState: 'delivery_pending' });
    }
    clearProjectTasks(projectId);
  });

  it.each([
    ['toapis', 'gpt-image-2.6-flare-official'], ['toapis', 'gpt-image-2.6-sunburst-official'],
    ['aigc-si', 'image-2.6-flare'], ['aigc-si', 'image-2.6-sunburst'],
  ] as const)('%s 的 %s 复用原任务查询及同源下载身份', async (catalogId, modelId) => {
    const selected = structuredClone(getProviderDefinition(catalogId)!.models!.find((item) => item.id === modelId)!);
    const baseUrl = catalogId === 'toapis' ? 'https://toapis.cn/v1' : AIGCSI_BASE_URL;
    const projectId = `image-26-${modelId}`;
    clearProjectTasks(projectId);
    useAppStore.getState().saveProviderConfig('image-26', { name: '2.6', catalogId, baseUrl,
      apiKey: 'image-26-fixture', selectedModels: [selected] });
    const general = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'image-26')!;
    useAppStore.setState({ currentProjectId: projectId, nodes: [{ id: 'image-26-node', type: 'ai-image',
      position: { x: 0, y: 0 }, data: { type: 'ai-image', label: '2.6', status: 'loading' } }] });
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'image-26-task' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', result: { data: [{ url: 'https://cdn.example/result-26.png' }] } }));
    const result = await generateImagesBatch({ provider: 'general', model: `general/${general.id}`, prompt: '竖版海报',
      nodeId: 'image-26-node', imageSize: catalogId === 'toapis' ? '2k' : '2K', aspectRatio: '9:16',
      ...(catalogId === 'toapis' ? { imageQuality: 'max', imageBackground: 'transparent' } : {}) }, 1);
    const calls = transportMocks.corsSafeFetch.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([`${baseUrl}/images/generations${catalogId === 'toapis' ? '' : '/async'}`,
      `${baseUrl}/${catalogId === 'toapis' ? 'images/generations' : 'image-jobs'}/image-26-task`]);
    const body = JSON.parse(String(calls[0][1].body));
    expect(body).toMatchObject({ model: modelId, n: 1, resolution: catalogId === 'toapis' ? '2k' : '2K' });
    if (catalogId === 'toapis') expect(body).toMatchObject({ size: '9:16', quality: 'max', background: 'transparent', output_format: 'png' });
    else {
      expect(body).toHaveProperty('aspect_ratio', '9:16');
      for (const field of ['quality', 'background']) expect(body).not.toHaveProperty(field);
    }
    expect(calls[1][1].headers).toMatchObject({ Authorization: 'Bearer image-26-fixture' });
    expect(result).toMatchObject({ results: [{ url: 'https://cdn.example/result-26.png' }],
      taskReceipt: { taskId: 'image-26-task', projectId, nodeId: 'image-26-node' },
      mediaDownloadAccess: { providerConfigId: 'image-26', origin: new URL(baseUrl).origin } });
    expect(getPendingTasksForProject(projectId)[0]).toMatchObject({ taskId: 'image-26-task',
      providerConfigId: 'image-26', mediaRecoveryState: 'delivery_pending' });
    expect(calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    clearProjectTasks(projectId);
  });

  it('GRSAI 基础 2.6 使用其已确认的像素与 auto，不猜增强型号或其他比例', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { grsai: { name: 'GRSAI', apiKey: 'grsai-26-fixture' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/grsai-26.png' }] }));
    const params = { provider: 'grsai', model: 'grsai/gpt-image-2.6', prompt: '海报', imageSize: '1K', aspectRatio: '1:1' };
    await expect(generateImagesBatch(params, 1)).resolves.toMatchObject({ results: [{ url: 'https://cdn.example/grsai-26.png' }] });
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://grsai.dakka.com.cn/v1/api/generate');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-image-2.6', aspectRatio: '1024x1024', quality: 'auto', replyType: 'json' });
    await expect(generateImagesBatch({ ...params, aspectRatio: '16:9' }, 1)).rejects.toThrow('1:1');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
  });
});

describe('ToAPIs 参考素材上传与图片提交', () => {
  function configure(id = 'gpt-image-2', baseUrl = 'https://toapis.cn/v1', apiKey = 'toapis-fixture') {
    const selected = getProviderDefinition('toapis')!.models!.find((model) => model.id === id)!;
    useAppStore.getState().saveProviderConfig('toapis-user', {
      name: 'ToAPIs', catalogId: 'toapis', apiKey, baseUrl, selectedModels: [selected],
    });
    const general = useAppStore.getState().config.generalModels!.find((model) => model.providerConfigId === 'toapis-user')!;
    return { provider: 'general', model: `general/${general.id}`, prompt: '测试参考图' };
  }

  it('upgrades a known old ToAPIs contract at execution without rewriting saved settings', async () => {
    const params = configure('gpt-image-2.5-sunburst-vip');
    const general = useAppStore.getState().config.generalModels![0];
    const legacyProfile = structuredClone(general.executionProfile)!;
    (legacyProfile.protocol!.submit.body as Record<string, unknown>).quality = 'high';
    delete (legacyProfile.protocol!.submit.body as Record<string, unknown>).background;
    useAppStore.setState((state) => ({ config: { ...state.config,
      generalModels: [{ ...general, executionProfile: legacyProfile,
        imageCapability: { ...general.imageCapability, qualities: undefined, defaultQuality: undefined,
          backgrounds: undefined, defaultBackground: undefined } }],
    } }));
    const saved = useAppStore.getState().config;
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'quality-task' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', result: { data: [{ url: 'https://cdn.example/image.png' }] } }));
    await generateImagesBatch({ ...params, imageQuality: 'max', imageBackground: 'transparent', imageSize: '2K', aspectRatio: '16:9' }, 1);
    const body = JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ quality: 'max', size: '2048x1152', background: 'transparent' });
    expect(body).not.toHaveProperty('output_format');
    expect(useAppStore.getState().config).toBe(saved);
    expect(saved.generalModels![0].executionProfile).toEqual(legacyProfile);
  });

  it.each([
    ['video', 'video/mp4', 'videos'], ['audio', 'audio/mpeg', 'audios'],
  ] as const)('本地 %s 使用当前连接 Key 和当前站点的上传接口', async (kind, mime, endpoint) => {
    configure('gpt-image-2', 'https://toapis.com/v1');
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { url: `https://cdn.example/toapis-${kind}` } }));
    const result = await uploadToRemote(`data:${mime};base64,dG9hcGlzLXJlZmVyZW5jZQ==`, 'toapis-user', kind);
    expect(result).toBe(`https://cdn.example/toapis-${kind}`);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe(`https://toapis.com/v1/uploads/${endpoint}`);
    expect(init.headers).toEqual({ Authorization: 'Bearer toapis-fixture' });
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('file')).toBeInstanceOf(Blob);
    expect(init.body.get('purpose')).toBe('generation');
  });

  it('图片先上传当前 ToAPIs 连接，再提交异步任务并只查询同一个任务 ID', async () => {
    const params = configure();
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { url: 'https://cdn.example/toapis-image-ref' } }))
      .mockResolvedValueOnce(jsonResponse({ id: 'image-toapis-task', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', result: { data: [{ url: 'https://cdn.example/toapis-output.png' }] } }));
    const result = await generateImagesBatch({ ...params, image_urls: ['data:image/png;base64,dG9hcGlzLWltYWdlLWZpeHR1cmU='], imageSize: '2k', aspectRatio: '16:9' }, 1);
    expect(result.results[0].url).toBe('https://cdn.example/toapis-output.png');
    const calls = transportMocks.corsSafeFetch.mock.calls;
    expect(calls.map(([url]) => url)).toEqual(['https://toapis.cn/v1/uploads/images', 'https://toapis.cn/v1/images/generations', 'https://toapis.cn/v1/images/generations/image-toapis-task']);
    expect(JSON.parse(String(calls[1][1].body))).toMatchObject({ model: 'gpt-image-2', resolution: '2k', size: '16:9', n: 1,
      reference_images: ['https://cdn.example/toapis-image-ref'] });
    expect(JSON.parse(String(calls[1][1].body))).not.toHaveProperty('image_urls');
  });

  it('角色工作台按 ToAPIs 原协议提交，登记任务 ID 后再查询图片', async () => {
    const params = configure();
    const reference = 'https://cdn.example/role-reference.png';
    const result = 'https://cdn.example/role-candidate.png';
    const taskId = 'toapis-role-task';
    const delivered = new Error('角色候选已交付');
    const received = vi.fn(async (_taskId: string) => {});
    const destination = registerCharacterImageTaskContext({ assertCurrent: () => {}, execute: async (plan) => {
      expect(plan.recovery).toMatchObject({ kind: 'protocol', providerBase: 'https://toapis.cn/v1' });
      const outputs = await plan.execute(async () => {}, received, 'toapis-role-operation');
      expect(outputs).toEqual([{ url: result }]);
      throw delivered;
    } });
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ id: taskId, status: 'queued' }))
      .mockImplementationOnce(async () => {
        expect(received).toHaveBeenCalledExactlyOnceWith(taskId, { submit: { id: taskId } });
        return jsonResponse({ status: 'completed', result: { data: [{ url: result }] } });
      });

    try {
      await expect(generateImagesBatch({ ...params, characterWorkbench: 'global', image_urls: [reference],
        imageSize: '2k', aspectRatio: '16:9' }, 1, undefined, destination.beforeSubmit)).rejects.toBe(delivered);
      const calls = transportMocks.corsSafeFetch.mock.calls;
      expect(calls.map(([url, init]) => [init.method, url])).toEqual([
        ['POST', 'https://toapis.cn/v1/images/generations'],
        ['GET', `https://toapis.cn/v1/images/generations/${taskId}`],
      ]);
      expect(JSON.parse(String(calls[0][1].body))).toMatchObject({ reference_images: [reference] });
    } finally {
      destination.release();
    }
  });

  it('本连接未配置 Key 时不借用 APIMart 或其他连接 Key', async () => {
    configure('gpt-image-2', 'https://toapis.cn/v1', '');
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      apimart: { name: 'APIMart', apiKey: 'other-fixture' },
    } } }));
    await expect(uploadToRemote('data:video/mp4;base64,bWlzc2luZy1rZXk=', 'toapis-user', 'video')).rejects.toThrow('当前连接');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });
});

describe('上传策略使用显式厂商身份', () => {
  it.each(['toapis', 'libapi'])('连接 ID 为 %s 但显式配置为自定义时不使用内置上传或泄露 Key', async (connectionId) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      ...state.config.providers,
      [connectionId]: { name: '自定义连接', catalogId: 'custom-openai', apiKey: 'private-custom-upload-fixture',
        baseUrl: 'https://custom-upload.example/v1' },
    } } }));
    const directFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      success: true, files: [{ url: `https://cdn.example/custom-${connectionId}-reference` }],
    }));

    await expect(uploadToRemote('data:audio/mpeg;base64,cG9saWN5LW92ZXJyaWRl', connectionId, 'audio'))
      .resolves.toBe(`https://cdn.example/custom-${connectionId}-reference`);

    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(directFetch).toHaveBeenCalledExactlyOnceWith('https://uguu.se/upload', expect.objectContaining({
      method: 'POST', body: expect.any(FormData),
    }));
    expect(directFetch.mock.calls[0][1]?.headers).toBeUndefined();
    expect([...(directFetch.mock.calls[0][1]?.body as FormData).keys()]).toEqual(['files[]']);
  });
});

describe('RelayOnAPI 图片请求与连接身份', () => {
  function configureRelayonImage(apiKey = 'relayon-image-fixture', modelId = 'image-2-01') {
    const selected = getProviderDefinition('relayonapi')!.models!.find((model) => model.id === modelId)!;
    useAppStore.getState().saveProviderConfig('my-relayon-images', {
      name: '我的万象连接', catalogId: 'relayonapi', relayonGroup: 'image', apiKey, baseUrl: 'https://relayonapi.com/v1',
      selectedModels: [selected],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'my-relayon-images')!;
    return { provider: 'general', model: `general/${model.id}`, prompt: '生成角色立绘', imageSize: '2K', aspectRatio: '16:9' };
  }

  it.each(['Midjourney v6', 'Midjourney v6.1', 'Midjourney v7', 'Midjourney v8.1', 'Midjourney v8.2'])(
    '%s 单次作业仅提交 n=1，保留四个候选及整组原结果续存身份', async (modelId) => {
      const params = configureRelayonImage('relayon-image-fixture', modelId);
      clearProjectTasks('relayon-mj-four-results');
      useAppStore.setState({ currentProjectId: 'relayon-mj-four-results', nodes: [{ id: 'mj-node', type: 'ai-image',
        position: { x: 0, y: 0 }, data: { type: 'ai-image', label: 'MJ 候选', status: 'loading' } }] });
      const urls = Array.from({ length: 4 }, (_, index) => `https://cdn.example/mj-candidate-${index + 1}.png`);
      transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: urls.map((url) => ({ url })) }));
      const result = await generateImage({ ...params, imageSize: '1K', nodeId: 'mj-node', collectCandidates: true });
      expect(result).toMatchObject({ url: urls[0], width: 1536, height: 864, expectedOutputCount: 4 });
      expect(result.additionalResults?.map(({ url }) => url)).toEqual(urls.slice(1));
      expect(result.additionalResults?.every((item) => !item.additionalResults && item.taskReceipt?.taskId === result.taskReceipt?.taskId)).toBe(true);
      expect(getPendingTasksForProject('relayon-mj-four-results')).toEqual([expect.objectContaining({
        nodeId: 'mj-node', batchCount: 4, expectedImageOutputs: 4, resultUrls: urls, submitted: true, mediaRecoveryState: 'delivery_pending',
      })]);
      expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
      const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
      expect(url).toBe('https://api.relayonapi.com/v1/images/generations');
      expect(JSON.parse(String(init.body))).toMatchObject({ model: modelId, n: 1, resolution: '1k',
        size: '1536x864', aspect_ratio: '16:9' });
      expect(new Headers(init.headers).get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/i);
      expect(JSON.stringify(result)).not.toContain('relayon-image-fixture');
    },
  );

  it('只能接收单图的消费者在 MJ 付费提交前明确拒绝，不按 nodeId 猜测候选交付能力', async () => {
    const params = configureRelayonImage('relayon-image-fixture', 'Midjourney v8.2');
    for (const nodeId of [undefined, 'ordinary-image-node', 'plugin-image-node']) {
      await expect(generateImage({ ...params, nodeId })).rejects.toThrow('一次返回多张候选图');
    }
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('直接保存万象连接 ID 的节点仍使用原完整协议和 Key，交付四候选且不改配置', async () => {
    configureRelayonImage('direct-mj-fixture', 'Midjourney v8.2');
    const before = structuredClone(useAppStore.getState().config.providers['my-relayon-images']);
    const urls = Array.from({ length: 4 }, (_, index) => `https://cdn.example/direct-mj-${index}.png`);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: urls.map((url) => ({ url })) }));
    const result = await generateImage({ provider: 'my-relayon-images', model: 'my-relayon-images/Midjourney v8.2',
      prompt: 'direct', imageSize: '2K', aspectRatio: '4:5', collectCandidates: true });
    expect([result.url, ...result.additionalResults!.map(({ url }) => url)]).toEqual(urls);
    expect(result.expectedOutputCount).toBe(4);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://api.relayonapi.com/v1/images/generations',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer direct-mj-fixture' }) }), protocolSubmitDebug());
    expect(JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body))).toMatchObject({
      model: 'Midjourney v8.2', n: 1, resolution: '2k', size: '1632x2040', aspect_ratio: '4:5',
    });
    expect(useAppStore.getState().config.providers['my-relayon-images']).toEqual(before);
  });

  it.each(['custom-openai', 'relayonapi'])('%s 的同名 MJ 自定义协议不被固定四候选规则接管', async (catalogId) => {
    const selected = structuredClone(getProviderDefinition('relayonapi')!.models!.find((item) => item.id === 'Midjourney v8.2')!);
    selected.executionProfile!.protocol!.submit.path = '/custom/mj';
    const before = structuredClone(selected);
    useAppStore.getState().saveProviderConfig('my-custom-mj', { name: '我的图片接口', catalogId,
      apiKey: 'custom-mj-fixture', baseUrl: 'https://gateway.example/v1', selectedModels: [selected] });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'my-custom-mj')!;
    const urls = Array.from({ length: 4 }, (_, index) => `https://cdn.example/custom-mj-${index}.png`);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: urls.map((url) => ({ url })) }));
    const result = await generateImage({ provider: 'general', model: `general/${model.id}`, prompt: 'custom', imageSize: '2K', aspectRatio: '1:1' });
    expect(result.url).toBe(urls[0]);
    expect(result).not.toHaveProperty('additionalResults');
    expect(result).not.toHaveProperty('expectedOutputCount');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://gateway.example/v1/custom/mj', expect.anything(), protocolSubmitDebug());
    expect(JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body))).toMatchObject({ resolution: '2K', n: 1 });
    expect(useAppStore.getState().config.providers['my-custom-mj'].selectedModels).toEqual([before]);
  });

  it('万象直连节点的已修改协议仍使用自己的路径和单结果语义', async () => {
    const selected = structuredClone(getProviderDefinition('relayonapi')!.models!.find((item) => item.id === 'Midjourney v8.2')!);
    selected.executionProfile!.protocol!.submit.path = '/my-mj/images';
    useAppStore.getState().saveProviderConfig('direct-custom-mj', { name: '万象自定义协议', catalogId: 'relayonapi',
      apiKey: 'direct-custom-fixture', baseUrl: 'https://relayonapi.com/v1', selectedModels: [selected] });
    const before = structuredClone(useAppStore.getState().config.providers['direct-custom-mj']);
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('自定义协议测试不能外联'));
    transportMocks.corsSafeFetch.mockImplementation(async (url) => {
      if (url !== 'https://relayonapi.com/v1/my-mj/images') throw new Error('未模拟的自定义模型请求');
      return jsonResponse({ data: [{ url: 'https://cdn.example/direct-custom.png' }] });
    });
    const reference = 'https://custom.example/reference.png';
    const result = await generateImage({ provider: 'direct-custom-mj', model: 'direct-custom-mj/Midjourney v8.2',
      prompt: 'direct custom', imageSize: '1K', aspectRatio: '1:1', image_urls: [reference] });
    expect(result).toMatchObject({ url: 'https://cdn.example/direct-custom.png' });
    expect(result).not.toHaveProperty('additionalResults');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://relayonapi.com/v1/my-mj/images', expect.anything(), protocolSubmitDebug());
    expect(new Headers(transportMocks.corsSafeFetch.mock.calls[0][1].headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body)).image).toEqual([reference]);
    expect(directFetch).not.toHaveBeenCalled();
    expect(useAppStore.getState().config.providers['direct-custom-mj']).toEqual(before);
  });

  it('MJ 参考编辑可交付四张 Base64，2K 使用型号公布尺寸，不额外提交或裁图', async () => {
    const params = configureRelayonImage('relayon-image-fixture', 'Midjourney v8.2');
    const encoded = ['YQ==', 'Yg==', 'Yw==', 'ZA=='];
    const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8Z0AAAAASUVORK5CYII=';
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: encoded.map((b64_json) => ({ b64_json })) }));
    const result = await generateImagesBatch({ ...params, aspectRatio: '3:2', image_urls: [reference] }, 1);
    expect(result).toMatchObject({ requestedCount: 1, expectedOutputCount: 4, failedCount: 0 });
    expect(result.results.map(({ url }) => url)).toEqual(encoded.map((value) => `data:image/png;base64,${value}`));
    expect(result.results.every((item) => item.width === 2048 && item.height === 1360)).toBe(true);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://api.relayonapi.com/v1/images/edits', expect.anything(), protocolSubmitDebug());
    const { fields, files } = await multipartImageRequest(transportMocks.corsSafeFetch.mock.calls[0][1]);
    expect(fields).toMatchObject({ model: 'Midjourney v8.2', n: '1', resolution: '2k', size: '2048x1360' });
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe('image/png');
    expect(Buffer.from(await files[0].arrayBuffer())).toEqual(Buffer.from(reference.split(',')[1], 'base64'));
  });

  it('MJ 少返回候选仍保留期望四张，不补交付费生成；一次请求不能把四候选当 n=4', async () => {
    const params = configureRelayonImage('relayon-image-fixture', 'Midjourney v8.2');
    const urls = Array.from({ length: 3 }, (_, index) => `https://cdn.example/mj-short-${index}.png`);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: urls.map((url) => ({ url })) }));
    await expect(generateImagesBatch(params, 1)).resolves.toMatchObject({ requestedCount: 1, expectedOutputCount: 4,
      failedCount: 1, results: urls.map((url) => expect.objectContaining({ url })) });
    await expect(generateImagesBatch(params, 4)).rejects.toThrow('单次最多生成 1');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('2.6 01 文件编辑采用独立文档尺寸，不默认追加质量、背景或多候选', async () => {
    const params = configureRelayonImage('relayon-image-fixture', 'image-2.6-01');
    const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8Z0AAAAASUVORK5CYII=';
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: 'aW1hZ2U=' }] }));
    const result = await generateImage({ ...params, aspectRatio: '9:16', image_urls: [reference] });
    expect(result).toMatchObject({ url: 'data:image/png;base64,aW1hZ2U=', width: 1440, height: 2560 });
    expect(result).not.toHaveProperty('additionalResults');
    expect(result).not.toHaveProperty('expectedOutputCount');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://api.relayonapi.com/v1/images/edits', expect.anything(), protocolSubmitDebug());
    const { fields, files } = await multipartImageRequest(transportMocks.corsSafeFetch.mock.calls[0][1]);
    expect(fields).toMatchObject({ model: 'image-2.6-01', n: '1', size: '1440x2560' });
    for (const key of ['resolution', 'aspect_ratio']) expect(fields).not.toHaveProperty(key);
    expect(fields).not.toHaveProperty('quality');
    expect(fields).not.toHaveProperty('background');
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('reference-1.png');
    expect(files[0].type).toBe('image/png');
    expect(Buffer.from(await files[0].arrayBuffer())).toEqual(Buffer.from(reference.split(',')[1], 'base64'));
  });

  it('已保存的 2.6 旧内置能力无需拉取即可发送新尺寸，参数面板与生成一致且不写回', async () => {
    const params = configureRelayonImage('relayon-image-fixture', 'image-2.6-01');
    const pixels = getImageSizePresets('relayon-image-2.5');
    const provider = useAppStore.getState().config.providers['my-relayon-images'];
    const selected = structuredClone(provider.selectedModels![0]);
    const saved = { ...selected.imageCapability!, resolutions: Object.keys(pixels),
      ratios: Object.keys(pixels['1K']), dimensionPresets: pixels };
    selected.imageCapability = saved;
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, 'my-relayon-images': { ...provider, selectedModels: [selected] } },
      generalModels: state.config.generalModels!.map((item) => item.providerConfigId === 'my-relayon-images'
        ? { ...item, imageCapability: structuredClone(saved) } : item),
    } }));
    const before = structuredClone({ provider: useAppStore.getState().config.providers['my-relayon-images'],
      models: useAppStore.getState().config.generalModels });
    const capability = resolveImageParameterCapability(params.model, params.provider, useAppStore.getState().config);
    expect(capability!.dimensionPresets!['2K']['16:9']).toEqual([2560, 1440]);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/relayon-26-new-size.png' }] }));
    await expect(generateImage(params)).resolves.toMatchObject({ width: 2560, height: 1440 });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://api.relayonapi.com/v1/images/generations', expect.anything(), protocolSubmitDebug());
    const body = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body));
    expect(body).toMatchObject({ model: 'image-2.6-01', resolution: '2K', aspect_ratio: '16:9', size: '2560x1440' });
    expect({ provider: useAppStore.getState().config.providers['my-relayon-images'],
      models: useAppStore.getState().config.generalModels }).toEqual(before);
  });

  it.each(['image-2.6-flare-01', 'image-2.6-sunburst-01'])('%s 的格式、质量和GIF标量完整进入JSON请求且不改写配置', async (id) => {
    const params = configureRelayonImage('format-fixture', id);
    const before = structuredClone(useAppStore.getState().config);
    for (const format of ['png', 'gif', 'svg'] as const) {
      transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: `https://cdn.example/format-result.${format}` }] }));
      await expect(generateImage({ ...params, imageSize: '4K', aspectRatio: '1:1', imageOutputFormat: format,
        imageQuality: format === 'png' ? 'auto' : 'high',
        ...(format === 'gif' ? { imageFrameCount: 16, imageFrameDurationMs: 30, imageTransparent: false } : {}),
      })).resolves.toMatchObject({ url: `https://cdn.example/format-result.${format}`, width: 4096, height: 4096 });
      const [url, init] = transportMocks.corsSafeFetch.mock.calls.at(-1)!;
      expect(url).toBe('https://api.relayonapi.com/v1/images/generations');
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ model: id, size: '4096x4096', resolution: '4K', aspect_ratio: '1:1',
        output_format: format, n: 1, response_format: 'url' });
      expect(body).not.toHaveProperty('image');
      if (format === 'gif') expect(body).toMatchObject({ frame_count: 16, frame_duration_ms: 30, transparent: false, quality: 'high' });
      else for (const field of ['frame_count', 'frame_duration_ms', 'transparent']) expect(body).not.toHaveProperty(field);
      if (format === 'png') expect(body).not.toHaveProperty('quality');
      else expect(body.quality).toBe('high');
    }
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(3);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useAppStore.getState().config).toEqual(before);
  });

  it.each(['image-2.6-flare-01', 'image-2.6-sunburst-01'].flatMap((id) => (['gif', 'svg'] as const).map((format) => ({ id, format }))))(
    '$id 的$format参考、非方图、无效帧字段在读取素材和提交前拒绝', async ({ id, format }) => {
    const params = configureRelayonImage('format-fixture', id);
    await expect(generateImage({ ...params, aspectRatio: '1:1', imageOutputFormat: format,
      image_urls: ['asset://localhost/unreadable-reference.png'] })).rejects.toThrow('文生');
    await expect(generateImage({ ...params, aspectRatio: '16:9', imageOutputFormat: format })).rejects.toThrow('方图');
    await expect(generateImage({ ...params, aspectRatio: '1:1', imageOutputFormat: format,
      imageFrameDurationMs: 21 })).rejects.toThrow();
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(['image-2.6-flare-01', 'image-2.6-sunburst-01'].flatMap((id) => [1, 2].flatMap((count) => [false, true].map((explicit) => ({ id, count, explicit })))))(
    '$id 的$count图PNG编辑不发送output_format，显式PNG=$explicit，文件有序且仅一个POST', async ({ id, count, explicit }) => {
    const params = configureRelayonImage('format-fixture', id);
    const references = [
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8Z0AAAAASUVORK5CYII=',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    ].slice(0, count);
    const before = structuredClone(useAppStore.getState().config);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/variant-edited.png' }] }));
    await expect(generateImage({ ...params, ...(explicit ? { imageOutputFormat: 'png' as const } : {}), image_urls: references }))
      .resolves.toMatchObject({ url: 'https://cdn.example/variant-edited.png', width: 2560, height: 1440 });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://api.relayonapi.com/v1/images/edits', expect.anything(), protocolSubmitDebug());
    const { form, fields, files } = await multipartImageRequest(transportMocks.corsSafeFetch.mock.calls[0][1]);
    expect(form.getAll(count === 1 ? 'image' : 'image[]')).toHaveLength(count);
    expect(form.has(count === 1 ? 'image[]' : 'image')).toBe(false);
    expect(fields).toMatchObject({ model: id, size: '2560x1440', n: '1' });
    for (const key of ['output_format', 'resolution', 'aspect_ratio']) expect(fields).not.toHaveProperty(key);
    for (const field of ['frame_count', 'frame_duration_ms', 'transparent']) expect(fields).not.toHaveProperty(field);
    expect(files.map((file) => file.type)).toEqual(Array(count).fill('image/png'));
    expect(files.map((file) => file.name)).toEqual(Array.from({ length: count }, (_, index) => `reference-${index + 1}.png`));
    for (const [index, file] of files.entries()) {
      expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from(references[index].split(',')[1], 'base64'));
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useAppStore.getState().config).toEqual(before);
  });

  it.each(['image-2.6-flare-01', 'image-2.6-sunburst-01'])('%s 同名自定义编辑协议保留原output_format，不被内置PNG省略规则接管', async (id) => {
    const params = configureRelayonImage('custom-format-fixture', id);
    const connection = useAppStore.getState().config.providers['my-relayon-images'];
    const selected = structuredClone(connection.selectedModels![0]);
    selected.executionProfile!.protocol!.submit.path = '/custom/edits';
    useAppStore.getState().saveProviderConfig('my-relayon-images', { ...connection, selectedModels: [selected] });
    const before = structuredClone(useAppStore.getState().config);
    const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8Z0AAAAASUVORK5CYII=';
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/custom-variant.png' }] }));
    await expect(generateImage({ ...params, imageOutputFormat: 'png', image_urls: [reference] }))
      .resolves.toMatchObject({ url: 'https://cdn.example/custom-variant.png', width: 2560, height: 1440 });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://relayonapi.com/v1/custom/edits', expect.anything(), protocolSubmitDebug());
    const init = transportMocks.corsSafeFetch.mock.calls[0][1];
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: id, output_format: 'png', size: '2560x1440',
      resolution: '2K', aspect_ratio: '16:9', n: 1, image: [reference] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useAppStore.getState().config).toEqual(before);
  });

  it('未声明输出格式的旧型号在网络副作用前拒绝新增参数', async () => {
    const params = configureRelayonImage();
    await expect(generateImage({ ...params, imageOutputFormat: 'gif' })).rejects.toThrow('未声明');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('文生 JSON 和参考文件编辑各提交一次，像素、比例、分辨率一致且不经过公共上传', async () => {
    const params = configureRelayonImage();
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      relayonapi: { name: '另一万象连接', catalogId: 'relayonapi', apiKey: 'wrong-default-key-fixture' },
    } } }));
    const saved = structuredClone(useAppStore.getState().config.providers['my-relayon-images'].selectedModels);
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应访问公共图床'));
    const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8Z0AAAAASUVORK5CYII=';
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/relayon-generated.png' }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/relayon-edited.png' }] }));

    await expect(generateImagesBatch(params, 1)).resolves.toMatchObject({
      results: [{ url: 'https://cdn.example/relayon-generated.png', width: 2048, height: 1152 }], failedCount: 0,
    });
    await expect(generateImagesBatch({ ...params, image_urls: [reference] }, 1)).resolves.toMatchObject({
      results: [{ url: 'https://cdn.example/relayon-edited.png' }], failedCount: 0,
    });

    const calls = transportMocks.corsSafeFetch.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      'https://api.relayonapi.com/v1/images/generations', 'https://api.relayonapi.com/v1/images/edits',
    ]);
    for (const [, init] of calls) {
      expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer relayon-image-fixture' } });
      expect(init.headers).not.toHaveProperty('relayonGroup');
    }
    const generated = JSON.parse(String(calls[0][1].body));
    expect(generated).toMatchObject({ model: 'image-2-01', size: '2048x1152', aspect_ratio: '16:9', resolution: '2K', n: 1, response_format: 'url' });
    expect(generated).not.toHaveProperty('image');
    const { fields, files } = await multipartImageRequest(calls[1][1]);
    expect(fields).toMatchObject({ model: 'image-2-01', size: '2048x1152', aspect_ratio: '16:9', resolution: '2K', n: '1', response_format: 'url' });
    expect(fields).not.toHaveProperty('relayonGroup');
    expect(fields).not.toHaveProperty('quality');
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe('image/png');
    expect(Buffer.from(await files[0].arrayBuffer())).toEqual(Buffer.from(reference.split(',')[1], 'base64'));
    const keys = calls.map(([, init]) => new Headers(init.headers).get('Idempotency-Key'));
    expect(keys.every((key) => typeof key === 'string' && key.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(2);
    expect(directFetch).not.toHaveBeenCalled();
    expect(useAppStore.getState().config.providers['my-relayon-images'].selectedModels).toEqual(saved);
  });

  it('名为 relayonapi 的显式自定义连接保留自己的请求，不继承幂等注入或内置图片路由', async () => {
    useAppStore.getState().saveProviderConfig('relayonapi', {
      name: '同名自定义', catalogId: 'custom-openai', apiKey: 'custom-image-fixture', baseUrl: 'https://custom.example/v1',
      selectedModels: [{ id: 'image-2-01', name: '自定义图片', provider: 'relayonapi', category: 'image',
        imageReferenceRequestMode: 'generation-json-image-data-urls',
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync', auth: { type: 'bearer' },
          submit: { method: 'POST', path: '/render', body: { model: '{{model}}', prompt: '{{prompt}}', images: '{{imageUrls}}' } },
          response: { type: 'json', result: { urlPath: 'url' } } } },
      }],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'relayonapi')!;
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ url: 'https://cdn.example/custom-relay.png' }));

    const reference = 'data:image/png;base64,YQ==';
    await expect(generateImagesBatch({ provider: 'general', model: `general/${model.id}`, prompt: '使用自己的图片协议', image_urls: [reference] }, 1))
      .resolves.toMatchObject({ results: [{ url: 'https://cdn.example/custom-relay.png' }] });

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://custom.example/v1/render', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer custom-image-fixture' }),
    }), protocolSubmitDebug());
    expect(new Headers(transportMocks.corsSafeFetch.mock.calls[0][1].headers).has('Idempotency-Key')).toBe(false);
    expect(JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body)).images).toEqual([reference]);
  });

  it('当前别名连接缺少 Key 时不借用默认万象连接的凭据', async () => {
    const params = configureRelayonImage('');
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      relayonapi: { name: '另一万象连接', catalogId: 'relayonapi', apiKey: 'unrelated-default-fixture' },
    } } }));
    await expect(generateImagesBatch(params, 1)).rejects.toThrow('API Key');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('同步图片返回站内地址时将无密钥的下载连接描述传到单项和批次结果', async () => {
    const params = configureRelayonImage();
    useAppStore.setState({ currentProjectId: 'relayon-sync-delivery-project', nodes: [{ id: 'relayon-sync-image', type: 'ai-image',
      position: { x: 0, y: 0 }, data: { type: 'ai-image', label: '待保存图片', status: 'loading', prompt: params.prompt } }] });
    const url = 'https://relayonapi.com/v1/images/private-result';
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url }] }));
    const result = await generateImagesBatch({ ...params, nodeId: 'relayon-sync-image' }, 1);
    const access = { providerConfigId: 'my-relayon-images', origin: 'https://api.relayonapi.com', auth: { type: 'bearer' } };
    expect(result.mediaDownloadAccess).toEqual(access);
    expect(result.results[0]).toMatchObject({ url, mediaDownloadAccess: access });
    expect(result.taskReceipt).toMatchObject({ nodeId: 'relayon-sync-image', projectId: 'relayon-sync-delivery-project',
      taskId: expect.stringMatching(/^result-/) });
    expect(result.results[0].taskReceipt).toEqual(result.taskReceipt);
    const tasks = getPendingTasksForProject('relayon-sync-delivery-project');
    expect(tasks).toEqual([expect.objectContaining({ nodeId: 'relayon-sync-image', taskType: 'custom-protocol',
      taskId: result.taskReceipt!.taskId, submitted: true, mediaRecoveryState: 'delivery_pending',
      resultUrls: [url], mediaDownloadAccess: access, providerConfigId: 'my-relayon-images' })]);
    expect(tasks[0]).not.toHaveProperty('apiKey');
    expect(JSON.stringify(tasks)).not.toContain('relayon-image-fixture');
    expect(localStorage.getItem('ai_canvas_pending_tasks')).not.toContain('relayon-image-fixture');
    expect(JSON.stringify(result)).not.toContain('relayon-image-fixture');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith('https://api.relayonapi.com/v1/images/generations',
      expect.objectContaining({ method: 'POST' }), protocolSubmitDebug());
  });
});

describe('RelayOnAPI 普通 2.5 旧连接的质量与背景', () => {
  function configureLegacyOptions(modelId = 'Image-2.5-Flare') {
    const selected = structuredClone(getProviderDefinition('relayonapi')!.models!.find((model) => model.id === modelId)!);
    const body = selected.executionProfile!.protocol!.submit.body as Record<string, unknown>;
    delete body.quality;
    delete body.background;
    delete selected.imageCapability!.qualities;
    delete selected.imageCapability!.defaultQuality;
    delete selected.imageCapability!.backgrounds;
    delete selected.imageCapability!.defaultBackground;
    useAppStore.getState().saveProviderConfig('relayon-old-options', {
      name: '旧万象连接', catalogId: 'relayonapi', apiKey: 'relayon-options-fixture', baseUrl: 'https://relayonapi.com/v1',
      selectedModels: [selected],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'relayon-old-options')!;
    return { params: { provider: 'general', model: `general/${model.id}`, prompt: '生成角色立绘', imageSize: '2K', aspectRatio: '9:16' },
      original: structuredClone({ selected, model }) };
  }

  it.each(['Image-2.5-Flare', 'Image-2.5-Sunburst'])('%s 已保存旧 URL 协议也能接收 Base64 图片且不重投', async (modelId) => {
    const { params } = configureLegacyOptions(modelId);
    const provider = useAppStore.getState().config.providers['relayon-old-options'];
    const selected = structuredClone(provider.selectedModels![0]);
    if (selected.executionProfile?.protocol?.version !== 2) throw new Error('fixture must use protocol v2');
    delete selected.executionProfile.protocol.response.result!.base64Path;
    delete selected.executionProfile.protocol.response.result!.mimeType;
    useAppStore.getState().saveProviderConfig('relayon-old-options', { ...provider, selectedModels: [selected] });
    const before = structuredClone(useAppStore.getState().config.providers['relayon-old-options']);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: 'aW1hZ2U=' }] }));
    await expect(generateImagesBatch(params, 1)).resolves.toMatchObject({
      results: [{ url: 'data:image/png;base64,aW1hZ2U=', width: 1152, height: 2048 }], failedCount: 0,
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().config.providers['relayon-old-options']).toEqual(before);
  });

  it.each(['Image-2.5-Flare', 'Image-2.5-Sunburst'])('旧 %s 选择 high 与透明时文生和编辑均请求 PNG，保持用户尺寸及保存配置', async (modelId) => {
    const { params, original } = configureLegacyOptions(modelId);
    const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8Z0AAAAASUVORK5CYII=';
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应使用公共图床'));
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ data: [{ url: 'https://cdn.example/relayon-alpha.png' }] }));
    for (const image_urls of [undefined, [reference]]) {
      await expect(generateImagesBatch({ ...params, imageQuality: 'high', imageBackground: 'transparent', image_urls }, 1))
        .resolves.toMatchObject({ results: [{ url: 'https://cdn.example/relayon-alpha.png', width: 1152, height: 2048 }] });
    }
    expect(transportMocks.corsSafeFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.relayonapi.com/v1/images/generations', 'https://api.relayonapi.com/v1/images/edits',
    ]);
    for (const [, init] of transportMocks.corsSafeFetch.mock.calls) {
      expect(init.headers).toMatchObject({ Authorization: 'Bearer relayon-options-fixture' });
    }
    const generated = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body));
    expect(generated).toMatchObject({ model: modelId, quality: 'high', background: 'transparent',
      output_format: 'png', size: '1152x2048', aspect_ratio: '9:16', resolution: '2K', n: 1 });
    expect(generated).not.toHaveProperty('image');
    const edited = await multipartImageRequest(transportMocks.corsSafeFetch.mock.calls[1][1]);
    expect(edited.fields).toMatchObject({ model: modelId, quality: 'high', background: 'transparent',
      output_format: 'png', size: '1152x2048', aspect_ratio: '9:16', resolution: '2K', n: '1' });
    expect(edited.files).toHaveLength(1);
    expect(Buffer.from(await edited.files[0].arrayBuffer())).toEqual(Buffer.from(reference.split(',')[1], 'base64'));
    expect(directFetch).not.toHaveBeenCalled();
    const config = useAppStore.getState().config;
    expect(config.providers['relayon-old-options'].selectedModels).toEqual([original.selected]);
    const savedModel = config.generalModels!.find((model) => model.id === original.model.id)!;
    expect(savedModel.executionProfile).toEqual(original.model.executionProfile);
    expect(savedModel.imageCapability).toEqual(original.model.imageCapability);
  });

  it('通用模型缓存缺协议、能力和参考模式时沿用所选旧合同编辑，且不回写缓存或上传到公共图床', async () => {
    const { params, original } = configureLegacyOptions();
    useAppStore.setState((state) => ({ config: { ...state.config,
      generalModels: state.config.generalModels!.map((model) => {
        if (model.id !== original.model.id) return model;
        const incomplete = { ...model };
        delete incomplete.executionProfile;
        delete incomplete.imageCapability;
        delete incomplete.imageReferenceRequestMode;
        return incomplete;
      }),
    } }));
    const cachedBefore = structuredClone(useAppStore.getState().config.generalModels!.find((model) => model.id === original.model.id)!);
    for (const field of ['executionProfile', 'imageCapability', 'imageReferenceRequestMode']) {
      expect(cachedBefore).not.toHaveProperty(field);
    }
    const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8Z0AAAAASUVORK5CYII=';
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应使用公共图床'));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/relayon-recovered-options.png' }] }));

    await expect(generateImagesBatch({ ...params, imageQuality: 'high', imageBackground: 'transparent', image_urls: [reference] }, 1))
      .resolves.toMatchObject({ results: [{ url: 'https://cdn.example/relayon-recovered-options.png', width: 1152, height: 2048 }] });

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://api.relayonapi.com/v1/images/edits', expect.anything(), protocolSubmitDebug());
    const { fields, files } = await multipartImageRequest(transportMocks.corsSafeFetch.mock.calls[0][1]);
    expect(fields).toMatchObject({ quality: 'high', background: 'transparent', output_format: 'png',
      size: '1152x2048', aspect_ratio: '9:16', resolution: '2K', n: '1' });
    expect(files).toHaveLength(1);
    expect(Buffer.from(await files[0].arrayBuffer())).toEqual(Buffer.from(reference.split(',')[1], 'base64'));
    expect(directFetch).not.toHaveBeenCalled();
    const after = useAppStore.getState().config;
    expect(after.providers['relayon-old-options'].selectedModels).toEqual([original.selected]);
    expect(after.generalModels!.find((model) => model.id === original.model.id)).toEqual(cachedBefore);
  });

  it.each([
    { label: '接口默认', imageQuality: undefined, imageBackground: undefined },
    { label: '仅设置质量', imageQuality: 'high', imageBackground: undefined },
    { label: '清空背景', imageQuality: undefined, imageBackground: '' },
    { label: '自动背景', imageQuality: undefined, imageBackground: 'auto' },
    { label: '不透明背景', imageQuality: undefined, imageBackground: 'opaque' },
  ])('$label 不补造其他参数或强制 PNG', async ({ imageQuality, imageBackground }) => {
    const { params } = configureLegacyOptions();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/relayon-options.png' }] }));
    await generateImagesBatch({ ...params, imageQuality, imageBackground }, 1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body));
    if (imageQuality === undefined) expect(body).not.toHaveProperty('quality');
    else expect(body.quality).toBe(imageQuality);
    if (!imageBackground) expect(body).not.toHaveProperty('background');
    else expect(body.background).toBe(imageBackground);
    expect(body).not.toHaveProperty('output_format');
    expect(body).toMatchObject({ size: '1152x2048', aspect_ratio: '9:16', resolution: '2K', n: 1 });
  });

  it('用户改过的普通 2.5 协议保留固定值和输出格式，不替换为内置请求', async () => {
    const selected = structuredClone(getProviderDefinition('relayonapi')!.models!.find((model) => model.id === 'Image-2.5-Flare')!);
    selected.executionProfile!.protocol!.submit.path = '/custom/images';
    const body = selected.executionProfile!.protocol!.submit.body as Record<string, unknown>;
    body.quality = 'high';
    body.background = 'opaque';
    body.output_format = 'webp';
    selected.imageCapability = { ...selected.imageCapability, qualities: ['high'], defaultQuality: 'high',
      backgrounds: ['opaque'], defaultBackground: 'opaque' };
    const original = structuredClone(selected);
    useAppStore.getState().saveProviderConfig('relayon-custom-options', {
      name: '自行调整过的万象协议', catalogId: 'relayonapi', apiKey: 'custom-options-fixture', baseUrl: 'https://relayonapi.com/v1',
      selectedModels: [selected],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'relayon-custom-options')!;
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/relayon-custom.webp' }] }));
    await generateImagesBatch({ provider: 'general', model: `general/${model.id}`, prompt: '保留自己配置的图片协议',
      imageSize: '2K', aspectRatio: '9:16', imageQuality: 'high', imageBackground: 'opaque' }, 1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://relayonapi.com/v1/custom/images', expect.anything(), protocolSubmitDebug());
    expect(JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body))).toMatchObject({
      quality: 'high', background: 'opaque', output_format: 'webp', size: '1152x2048', aspect_ratio: '9:16', resolution: '2K',
    });
    expect(selected).toEqual(original);
  });
});

describe('image quick template request transport', () => {
  it('keeps a saved provider-specific custom image protocol independent of catalog size defaults', async () => {
    useAppStore.getState().saveProviderConfig('custom-apimart-image', {
      name: 'Custom APIMart image', catalogId: 'apimart', apiKey: 'template-fixture', baseUrl: 'https://images.example/v1',
      selectedModels: [{ id: 'gpt-image-2.5-flare', name: 'Custom image', category: 'image', provider: 'custom-apimart-image',
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/custom/image', body: { prompt: '{{prompt}}', tier: '{{imageSize}}' } },
          response: { type: 'json', result: { urlPath: 'data.*.url' } },
        } } }],
    });
    const selected = useAppStore.getState().config.providers['custom-apimart-image'].selectedModels![0];
    useAppStore.getState().addGeneralModel({ name: selected.name, modelId: selected.id, category: 'image',
      providerConfigId: 'custom-apimart-image', executionProfile: selected.executionProfile });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'custom-apimart-image')!;
    const before = structuredClone(useAppStore.getState().config);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/custom.png' }] }));
    await generateImagesBatch({ provider: 'general', model: `general/${model.id}`, prompt: 'Draw a cup', imageSize: 'HD' }, 1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    expect(transportMocks.corsSafeFetch.mock.calls[0][0]).toBe('https://images.example/v1/custom/image');
    expect(JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body))).toEqual({ prompt: 'Draw a cup', tier: 'HD' });
    expect(useAppStore.getState().config).toEqual(before);
  });

  function configureTemplate(templateId: string) {
    useAppStore.getState().saveProviderConfig('custom-template', {
      name: 'Custom images', catalogId: 'custom-openai', apiKey: 'template-fixture', baseUrl: 'https://images.example/v1',
      selectedModels: [{ id: 'actual-model-id', name: 'User model name', category: 'image', provider: 'custom-template',
        ...createImageQuickAdaptTemplate(templateId) }],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'custom-template')!;
    return { provider: 'general', model: `general/${model.id}`, prompt: 'Edit the reference images' };
  }

  it.each([
    { id: 'banana-pro:google', path: '/v1/models/actual-model-id:generateContent', auth: { 'x-goog-api-key': 'template-fixture' }, field: 'responseFormat' },
    { id: 'banana-pro:gemini-relay', path: '/v1beta/models/actual-model-id:generateContent', auth: { Authorization: 'Bearer template-fixture' }, field: 'imageConfig' },
  ])('sends all seven prepared references in one POST using the selected $id native contract', async ({ id, path, auth, field }) => {
    const params = configureTemplate(id);
    const references = ['YQ==', 'Yg==', 'Yw==', 'ZA==', 'ZQ==', 'Zg==', 'Zw==']
      .map((data) => `data:image/png;base64,${data}`);
    const readReference = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected reference fetch'));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ candidates: [{ content: { parts: [
      { text: 'Description' }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ] } }] }));
    const result = await generateImagesBatch({ ...params, image_urls: references, imageSize: '2K', aspectRatio: '16:9' }, 1);
    expect(result.results[0].url).toBe('data:image/png;base64,aW1hZ2U=');
    expect(result.results[0]).toMatchObject({ width: 2752, height: 1536 });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(readReference).not.toHaveBeenCalled();
    expect(url).toBe(`https://images.example${path}`);
    expect(init.headers).toMatchObject(auth);
    const body = JSON.parse(String(init.body));
    expect(body.contents[0].parts[0].text).toContain(params.prompt);
    expect(body.contents[0].parts[0].text).toContain('7 张参考图');
    expect(body.contents[0].parts[0].text).toContain('16:9');
    expect(body.contents[0].parts).toEqual([{ text: expect.any(String) }, ...references.map((reference) => ({
      inlineData: { mimeType: 'image/png', data: reference.split(',')[1] },
    }))]);
    expect(body.generationConfig[field]).toEqual(field === 'imageConfig'
      ? { aspectRatio: '16:9', imageSize: '2K' } : { image: { aspectRatio: '16:9', imageSize: '2K' } });
  });

  it('blocks references beyond the model-declared native limit before reading or submitting', async () => {
    const params = configureTemplate('banana-pro:google');
    const readReference = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected reference fetch'));
    await expect(generateImagesBatch({ ...params, image_urls: Array.from({ length: 15 }, (_, index) =>
      `https://cdn.example/reference-${index}.png`) }, 1)).rejects.toThrow('最多支持 14');
    expect(readReference).not.toHaveBeenCalled();
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('replaces an older native reference mode when saving a URL-based gateway template', async () => {
    configureTemplate('banana-pro:google');
    const params = configureTemplate('gpt-2:images-json');
    expect(useAppStore.getState().config.generalModels!.find((model) => model.providerConfigId === 'custom-template')!
      .imageReferenceRequestMode).toBe('generation-json-image-urls');
    const references = Array.from({ length: 7 }, (_, index) => `https://cdn.example/reference-${index}.png`);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    await generateImagesBatch({ ...params, image_urls: references }, 1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body)).images).toEqual(references);
  });

  it.each(['gpt-2:openai', 'gpt-2.5:images-json'])('uses explicit 4K pixels and numeric counts for %s', async (id) => {
    const params = configureTemplate(id);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [
      { url: 'https://cdn.example/result-one.png' }, { url: 'https://cdn.example/result-two.png' },
    ] }));
    const result = await generateImagesBatch({ ...params, imageSize: '4K', aspectRatio: '16:9' }, 2);
    expect(result.results).toHaveLength(2);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://images.example/v1/images/generations');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'actual-model-id', size: '3840x2160', n: 2 });
    await expect(generateImagesBatch({ ...params, imageSize: '4K', aspectRatio: '8:1' }, 1)).rejects.toThrow('不支持比例');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('uses official multipart edits with the same selected pixel table', async () => {
    const params = configureTemplate('gpt-2:openai');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('reference', { headers: { 'Content-Type': 'image/png' } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: 'aW1hZ2U=' }] }));
    await generateImagesBatch({ ...params, image_urls: ['data:image/png;base64,YQ=='], imageSize: '1K', aspectRatio: '3:2' }, 1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://images.example/v1/images/edits');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('size')).toBe('1536x1024');
    expect(init.body.getAll('image[]')).toHaveLength(1);
  });

  it('submits APIMart once, then queries the returned task with the connection key', async () => {
    const params = configureTemplate('gpt-2.5:apimart');
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'task-123', status: 'submitted' }] }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'completed', progress: 100,
        result: { images: [{ url: ['https://cdn.example/result.png'] }] } } }));
    const result = await generateImagesBatch({ ...params, imageSize: '2k', aspectRatio: '3:2',
      image_urls: ['https://cdn.example/reference.png'] }, 1);
    expect(result.results[0].url).toBe('https://cdn.example/result.png');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    const [submitUrl, submit] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(submitUrl).toBe('https://images.example/v1/images/generations');
    const submitted = JSON.parse(String(submit.body));
    expect(submitted.prompt).toContain(params.prompt);
    expect(submitted.prompt).toContain('1 张参考图');
    expect(submitted.prompt).toContain('3:2');
    expect(submitted).toEqual({ model: 'actual-model-id', prompt: expect.any(String),
      size: '3:2', resolution: '2k', quality: 'auto', n: 1, image_urls: ['https://cdn.example/reference.png'] });
    const [pollUrl, poll] = transportMocks.corsSafeFetch.mock.calls[1];
    expect(pollUrl).toBe('https://images.example/v1/tasks/task-123');
    expect(poll.headers).toMatchObject({ Authorization: 'Bearer template-fixture' });
  });
});

describe('CCC Gemini 旧连接的原生图片路由', () => {
  function configureCccImage({
    modelId = 'gemini-3.1-flash-image', connectionId = 'cccapi-banana', profile, selectedProfile,
    catalogId = 'cccapi', direct = false,
  }: {
    modelId?: string; connectionId?: string; profile?: ModelExecutionProfile; selectedProfile?: ModelExecutionProfile;
    catalogId?: 'cccapi' | 'custom-openai'; direct?: boolean;
  } = {}) {
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers,
        'cccapi-other': { name: '另一分组', apiKey: 'other-group-key-fixture', baseUrl: 'https://cccapi.cn/v1', catalogId: 'cccapi' },
        [connectionId]: { name: '香蕉分组', apiKey: 'banana-group-key-fixture', baseUrl: 'https://cccapi.cn/v1', catalogId,
          cccGroup: '🍌香蕉（官k）', selectedModels: [{ id: modelId, name: modelId, category: 'image' as const,
            provider: connectionId, ...(selectedProfile ? { executionProfile: structuredClone(selectedProfile) } : {}) }] },
      },
      generalModels: [{ id: 'ccc-legacy-gemini', name: modelId, modelId, category: 'image' as const,
        providerConfigId: connectionId, ...(profile ? { executionProfile: structuredClone(profile) } : {}) }],
    } }));
    return { provider: direct ? connectionId : 'general', model: direct ? `${connectionId}/${modelId}` : 'general/ccc-legacy-gemini',
      prompt: '画一只猫', imageSize: '2K', aspectRatio: '9:16' };
  }

  function mockNativeCccImage() {
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ candidates: [{
      content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] },
    }] }));
  }

  function customCccImageProfile(): ModelExecutionProfile {
    return { preset: 'custom', protocol: { version: 2, mode: 'sync', auth: { type: 'bearer' },
      submit: { method: 'POST', path: '/my-image-job', body: { model: '{{model}}', prompt: '{{prompt}}' } },
      response: { type: 'json', result: { urlPath: 'data.*.url' } },
    } };
  }

  it.each(['gemini-3-pro-image-preview', 'gemini-3-pro-image', 'gemini-3.1-flash-image',
    'gemini-2.5-flash-image', 'nano-banana2', 'nano-banana-pro'])(
    '旧通用模型 %s 缺少保存协议时仍使用已确认的原生合同', async (modelId) => {
      const params = configureCccImage({ modelId });
      mockNativeCccImage();
      await expect(generateImagesBatch(params, 1)).resolves.toMatchObject({ results: [{ url: 'data:image/png;base64,aW1hZ2U=' }] });
      expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
      const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://cccapi.cn/v1beta/models/${modelId}:generateContent`);
      expect(init.headers).toMatchObject({ Authorization: 'Bearer banana-group-key-fixture' });
      expect(JSON.parse(String(init.body))).toMatchObject({ contents: [{ role: 'user', parts: [{ text: '画一只猫' }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '9:16' } } });
      expect(useAppStore.getState().config.generalModels![0].executionProfile).toBeUndefined();
    },
  );

  it.each(['openai-image', 'openai-gpt-image'] as const)('旧 %s 预设临时修正路由，保存配置保持原样', async (preset) => {
    const params = configureCccImage({ profile: { preset } });
    const saved = structuredClone(useAppStore.getState().config);
    mockNativeCccImage();
    await generateImagesBatch(params, 1);
    expect(transportMocks.corsSafeFetch.mock.calls[0][0]).toBe('https://cccapi.cn/v1beta/models/gemini-3.1-flash-image:generateContent');
    expect(useAppStore.getState().config).toEqual(saved);
  });

  it.each(['cccapi', 'cccapi-banana-old'])('旧节点直接保存 provider=%s 时也使用原生合同', async (connectionId) => {
    const params = configureCccImage({ connectionId, direct: true });
    mockNativeCccImage();
    await generateImagesBatch(params, 1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cccapi.cn/v1beta/models/gemini-3.1-flash-image:generateContent');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer banana-group-key-fixture' });
  });

  it.each(['Nano-Banana-pro', 'Nano-Banana-2', 'Nano-Banana-2.1', 'nAnO-bAnAnA-2.1'])(
    '别名 %s 只匹配合同，保留实际请求型号和分组 Key', async (modelId) => {
      const params = configureCccImage({ modelId });
      mockNativeCccImage();
      await generateImagesBatch(params, 1);
      expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
      const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://cccapi.cn/v1beta/models/${modelId}:generateContent`);
      expect(init.headers).toMatchObject({ Authorization: 'Bearer banana-group-key-fixture' });
      expect(JSON.stringify(transportMocks.corsSafeFetch.mock.calls)).not.toContain('other-group-key-fixture');
      expect(useAppStore.getState().config.generalModels![0].modelId).toBe(modelId);
    },
  );

  it.each([
    ['Nano-Banana-pro', false], ['Nano-Banana-2', false], ['Nano-Banana-2.1', false],
    ['Nano-Banana-pro', true], ['Nano-Banana-2', true], ['Nano-Banana-2.1', true],
  ] as const)('CCC 当前型号 %s 的直接节点=%s 按用户选择发送三档分辨率并保留比例', async (modelId, direct) => {
    const params = configureCccImage({ modelId, direct });
    const saved = structuredClone(useAppStore.getState().config);
    mockNativeCccImage();
    for (const imageSize of ['1K', '2K', '4K']) {
      transportMocks.corsSafeFetch.mockClear();
      await generateImagesBatch({ ...params, imageSize, aspectRatio: '9:16' }, 1);
      expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
      const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://cccapi.cn/v1beta/models/${modelId}:generateContent`);
      expect(init.headers).toMatchObject({ Authorization: 'Bearer banana-group-key-fixture' });
      expect(JSON.parse(String(init.body)).generationConfig.imageConfig).toEqual({ imageSize, aspectRatio: '9:16' });
    }
    expect(useAppStore.getState().config).toEqual(saved);
  });

  it('当前 Nano-Banana-pro 的用户自定义协议保持原请求，不被目录能力替换', async () => {
    const params = configureCccImage({ modelId: 'Nano-Banana-pro', profile: customCccImageProfile() });
    const saved = structuredClone(useAppStore.getState().config);
    expect(resolveImageParameterCapability(params.model, params.provider, useAppStore.getState().config))
      .toMatchObject({ resolutions: [], ratios: [] });
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/custom-pro.png' }] }));
    await generateImagesBatch({ ...params, imageSize: '4K', aspectRatio: '9:16' }, 1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cccapi.cn/v1/my-image-job');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'Nano-Banana-pro', prompt: '画一只猫' });
    expect(useAppStore.getState().config).toEqual(saved);
  });

  it('旧 CCC 直连节点也按已选 custom 的参数映射展示并发送原请求', async () => {
    const params = configureCccImage({ modelId: 'Nano-Banana-2.1', direct: true, selectedProfile: customCccImageProfile() });
    const saved = structuredClone(useAppStore.getState().config);
    expect(resolveImageParameterCapability(params.model, params.provider, useAppStore.getState().config))
      .toMatchObject({ resolutions: [], ratios: [] });
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/custom-direct.png' }] }));
    await generateImagesBatch({ ...params, imageSize: '4K', aspectRatio: '9:16' }, 1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cccapi.cn/v1/my-image-job');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'Nano-Banana-2.1', prompt: '画一只猫' });
    expect(useAppStore.getState().config).toEqual(saved);
  });

  it.each([false, true])('显式 custom 协议作为已保存模型／选中配置后备（%s）均不被覆盖', async (selectedFallback) => {
    const profile = customCccImageProfile();
    const params = configureCccImage({ modelId: 'gemini-unlisted-image',
      ...(selectedFallback ? { selectedProfile: profile } : { profile }) });
    const saved = structuredClone(useAppStore.getState().config);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/custom.png' }] }));
    await expect(generateImagesBatch(params, 1)).resolves.toMatchObject({ results: [{ url: 'https://cdn.example/custom.png' }] });
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cccapi.cn/v1/my-image-job');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'gemini-unlisted-image', prompt: '画一只猫' });
    expect(useAppStore.getState().config).toEqual(saved);
  });

  it('其他明确声明的图片预设保持自己的请求合同', async () => {
    const params = configureCccImage({ profile: { preset: 'gpt-image-gateway-json' } });
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/explicit.png' }] }));
    await generateImagesBatch(params, 1);
    expect(transportMocks.corsSafeFetch.mock.calls[0][0]).toBe('https://cccapi.cn/v1/images/generations');
    expect(useAppStore.getState().config.generalModels![0].executionProfile).toEqual({ preset: 'gpt-image-gateway-json' });
  });

  it.each([false, true])('连接名为 cccapi 的显式自定义接口（直接节点=%s）仍走自己的 Images 请求', async (direct) => {
    const params = configureCccImage({ modelId: 'Nano-Banana-2.1', connectionId: 'cccapi', catalogId: 'custom-openai', direct });
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/openai.png' }] }));
    await generateImagesBatch(params, 1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cccapi.cn/v1/images/generations');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'Nano-Banana-2.1' });
  });

  it.each(['gemini-unlisted-image', 'Nano-Banana-unknown'])('未知图片候选 %s 没有协议时在提交前拒绝，不再尝试 Images', async (modelId) => {
    const params = configureCccImage({ modelId });
    await expect(generateImagesBatch(params, 1)).rejects.toThrow(/CCC|Gemini|香蕉|协议/);
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it.each([false, true])('旧连接缺协议时通过原生 parts 完整发送多图（直接节点=%s）', async (direct) => {
    const params = configureCccImage({ direct });
    const publicUpload = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应上传公共图床'));
    mockNativeCccImage();
    await expect(generateImagesBatch({ ...params,
      image_urls: ['data:image/png;base64,YQ==', 'data:image/webp;base64,Yg=='],
    }, 1)).resolves.toMatchObject({ results: [{ url: 'data:image/png;base64,aW1hZ2U=' }] });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cccapi.cn/v1beta/models/gemini-3.1-flash-image:generateContent');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer banana-group-key-fixture' });
    expect(JSON.parse(String(init.body)).contents[0].parts).toEqual([
      { text: expect.stringContaining('画一只猫') },
      { inlineData: { mimeType: 'image/png', data: 'YQ==' } },
      { inlineData: { mimeType: 'image/webp', data: 'Yg==' } },
    ]);
    expect(publicUpload).not.toHaveBeenCalled();
  });

  it.each([false, true])('完整旧文本模板临时升级后发送参考图，保存配置不变（直接节点=%s）', async (direct) => {
    const modelId = 'gemini-3-pro-image-preview';
    const profile = structuredClone(getProviderDefinition('cccapi')!.models!
      .find((model) => model.id === modelId)!.executionProfile!);
    (profile.protocol!.submit.body as Record<string, ProtocolJsonValue>).contents = [
      { role: 'user', parts: [{ text: '{{prompt}}' }] },
    ];
    const params = configureCccImage({ modelId, direct, profile, selectedProfile: profile });
    const saved = structuredClone(useAppStore.getState().config);
    mockNativeCccImage();
    await generateImagesBatch({ ...params, image_urls: ['data:image/webp;base64,YQ=='] }, 1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://cccapi.cn/v1beta/models/${modelId}:generateContent`);
    expect(JSON.parse(String(init.body)).contents[0].parts[1]).toEqual({
      inlineData: { mimeType: 'image/webp', data: 'YQ==' },
    });
    expect(useAppStore.getState().config).toEqual(saved);
  });

  it('普通图片输入与 @ 引用合并，优先本地图片并保留素材顺序', async () => {
    const params = configureCccImage({ modelId: 'gemini-3-pro-image-preview' });
    useAppStore.setState({ nodes: [{ id: 'ccc-local-ref', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: '人物', imageUrl: 'asset://localhost/ccc-ref.webp',
        sourceUrl: 'https://expired.example/ccc-ref.webp' } }] });
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      expect(String(url)).toBe('asset://localhost/ccc-ref.webp');
      return new Response('local-reference', { headers: { 'Content-Type': 'image/webp' } });
    });
    mockNativeCccImage();
    await generateImagesBatch({ ...params, prompt: '@{ccc-local-ref:人物} 保持人物一致',
      image_urls: ['data:image/webp;base64,YQ=='],
    }, 1);
    expect(localFetch).toHaveBeenCalledOnce();
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body));
    expect(body.contents[0].parts).toEqual([
      { text: expect.stringContaining('保持人物一致') },
      { inlineData: { mimeType: 'image/webp', data: 'YQ==' } },
      { inlineData: { mimeType: 'image/webp', data: btoa('local-reference') } },
    ]);
    expect(body.contents[0].parts[0].text).not.toContain('@{');
    expect(body).not.toHaveProperty('images');
    expect(body).not.toHaveProperty('image_urls');
  });

  it('公网参考图在本机读取为 inlineData，不把 URL 或 Key 发给外部图片站', async () => {
    const params = configureCccImage();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response('remote-reference', {
      headers: { 'Content-Type': 'image/webp' },
    }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ candidates: [{ content: {
      parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }],
    } }] }));
    await generateImagesBatch({ ...params, image_urls: ['https://cdn.example/reference.webp'] }, 1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    expect(transportMocks.corsSafeFetch.mock.calls[0]).toEqual([
      'https://cdn.example/reference.webp', { signal: undefined },
    ]);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://cccapi.cn/v1beta/models/gemini-3.1-flash-image:generateContent');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer banana-group-key-fixture' });
    expect(JSON.parse(String(init.body)).contents[0].parts[1]).toEqual({
      inlineData: { mimeType: 'image/webp', data: btoa('remote-reference') },
    });
  });

  it('读取参考图失败时不提交生成，也不回退 Images 或公共图床', async () => {
    const params = configureCccImage();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response('', { status: 403 }));
    await expect(generateImagesBatch({ ...params, image_urls: ['https://cdn.example/denied.webp'] }, 1))
      .rejects.toThrow('读取参考图 1 失败 (403)');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    expect(transportMocks.corsSafeFetch.mock.calls[0][0]).toBe('https://cdn.example/denied.webp');
  });

  it.each([7, 14])('未声明张数上限的 CCC 原生合同完整发送 %s 张，不套用通用数量提示', async (count) => {
    const params = configureCccImage({ modelId: 'gemini-3-pro-image-preview' });
    const showToast = vi.fn();
    useAppStore.setState({ showToast });
    const images = Array.from({ length: count }, (_, index) => `data:image/webp;base64,${btoa(String(index))}`);
    mockNativeCccImage();
    await generateImagesBatch({ ...params, image_urls: images }, 1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body));
    expect(body.contents[0].parts.slice(1)).toEqual(images.map((image) => ({
      inlineData: { mimeType: 'image/webp', data: image.split(',')[1] },
    })));
    expect(showToast).not.toHaveBeenCalled();
  });

  it.each([false, true])('仍遵守用户保存的图片数量声明（直接节点=%s），不覆盖旧能力', async (direct) => {
    const params = configureCccImage({ direct });
    const imageCapability = { supportsImageReference: true, maxImageReferences: 2 };
    useAppStore.setState((state) => ({ config: { ...state.config,
      generalModels: state.config.generalModels!.map((model) => ({ ...model, imageCapability })),
      providers: { ...state.config.providers, 'cccapi-banana': { ...state.config.providers['cccapi-banana'],
        selectedModels: state.config.providers['cccapi-banana'].selectedModels!.map((model) => ({ ...model, imageCapability })),
      } },
    } }));
    const saved = structuredClone(useAppStore.getState().config);
    await expect(generateImagesBatch({ ...params, image_urls: [
      'data:image/webp;base64,YQ==', 'data:image/webp;base64,Yg==', 'data:image/webp;base64,Yw==',
    ] }, 1)).rejects.toThrow('最多支持 2 张参考图');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(useAppStore.getState().config).toEqual(saved);
  });

  it('参考图超过 32 MiB 读取边界或用户取消时均不提交生成', async () => {
    const params = configureCccImage();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response('oversize', {
      headers: { 'Content-Type': 'image/webp', 'Content-Length': String(33 * 1024 * 1024) },
    }));
    await expect(generateImagesBatch({ ...params,
      image_urls: ['https://cdn.example/oversize.webp'],
    }, 1)).rejects.toThrow('32');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledOnce();
    expect(transportMocks.corsSafeFetch.mock.calls[0][0]).toBe('https://cdn.example/oversize.webp');
    transportMocks.corsSafeFetch.mockClear();
    const controller = new AbortController();
    controller.abort();
    await expect(generateImagesBatch({ ...params,
      image_urls: ['https://cdn.example/reference.webp'],
    }, 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('被用户修改的旧模板仍保持原样，缺少参考图映射时继续阻止丢图', async () => {
    const profile = structuredClone(getProviderDefinition('cccapi')!.models!
      .find((model) => model.id === 'gemini-3-pro-image-preview')!.executionProfile!);
    const body = profile.protocol!.submit.body as Record<string, ProtocolJsonValue>;
    body.contents = [{ role: 'user', parts: [{ text: '{{prompt}}' }] }];
    body.customOption = true;
    const params = configureCccImage({ modelId: 'gemini-3-pro-image-preview', profile });
    const saved = structuredClone(useAppStore.getState().config);
    await expect(generateImagesBatch({ ...params, image_urls: ['https://cdn.example/reference.webp'] }, 1))
      .rejects.toThrow('参考图');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(useAppStore.getState().config).toEqual(saved);
  });
});
