import { describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  corsSafeFetch: vi.fn(),
  logAiResponse: vi.fn(),
}));

vi.mock('../../../src/services/ai/httpTransport', () => transportMocks);

import { generateImage, generateImagesBatch } from '../../../src/services/ai/generateImage';
import { generateVideo } from '../../../src/services/ai/generateVideo';
import { generateAudio } from '../../../src/services/ai/generateAudio';
import { generateImageStandard } from '../../../src/services/ai/providers/standardImage';
import { mediaProviderRegistry } from '../../../src/services/ai/mediaProviderRegistry';
import { useAppStore } from '../../../src/store/useAppStore';
import { uploadMinimaxImageReference, uploadToRemote } from '../../../src/services/uploadService';
import {
  clearProjectTasks, getNativeMediaNodeRecovery, getPendingTasksForProject, removePendingTask,
  resumeMediaNodeTask, resumeNativeMediaFromNode, resumeNativeMediaLocalDelivery, resumePendingTasks,
} from '../../../src/services/pollManager';
import { LIBAPI_MODEL_MANIFEST } from '../../../src/services/ai/providers/libapiModelManifest';
import { AIGCSI_BASE_URL, AIGCSI_MODEL_MANIFEST } from '../../../src/services/ai/providers/aigcsiModelManifest';
import { MINIMAX_BASE_URL, MINIMAX_MODEL_MANIFEST } from '../../../src/services/ai/providers/minimaxModelManifest';
import { pollResolvedModelProtocol, resolveModelExecutionProfile } from '../../../src/services/ai/modelProtocol';
import { executeRunningHubModel } from '../../../src/services/ai/providers/runninghubMedia';
import { KLING_BASE_URL } from '../../../src/services/ai/providerCatalogService';
import * as mediaPersistence from '../../../src/services/fileService';
import { registerCharacterImageTaskContext } from '../../../src/services/characterImageTaskContext';
import { recoverCharacterImageTask } from '../../../src/services/characterImageTaskRecovery';
import { nativeQueryCredentialProof } from '../../../src/services/nativeProtocolRecovery';
import { nativeProtocolQueryDigest } from '../../../src/services/nativeModelProtocolTask';
import { nativeMediaInputMaterial } from '../../../src/services/nativeMediaInput';
import { sha256BytesHex } from '../../../src/services/mediaDataUrl';
import { createNativeProject } from '../../../src/services/indexedDb/nativeProjectRepository';
import { listNativeMediaTasks, prepareNativeMediaTask, recordNativeMediaSubmission } from '../../../src/services/indexedDb/nativeMediaTaskRepository';
import type { CharacterImageTaskRecovery } from '../../../src/types/media';
import type { CanvasContext } from '../../../src/types/project';
import { configureKling } from './klingImageFixture';
import { jsonResponse, setupTransportFixture } from './transportFixture';

setupTransportFixture(transportMocks.corsSafeFetch);

describe('MiniMax 官方素材直传与媒体交付', () => {
  function configureMinimax(id = 'speech-2.8-hd') {
    const selected = structuredClone(MINIMAX_MODEL_MANIFEST.find((item) => item.id === id)!);
    clearProjectTasks('minimax-audio-project');
    useAppStore.getState().saveProviderConfig('my-minimax', {
      name: '自己的 MiniMax', catalogId: 'minimax', apiKey: 'minimax-current-fixture',
      baseUrl: MINIMAX_BASE_URL, selectedModels: [selected],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'my-minimax')!;
    const nodeType = selected.category === 'video' ? 'ai-video' : selected.category === 'image' ? 'ai-image' : 'ai-audio';
    useAppStore.setState({ currentProjectId: 'minimax-audio-project', nodes: [{ id: 'minimax-audio-node', type: nodeType,
      position: { x: 0, y: 0 }, data: { type: nodeType, label: '官方媒体', status: 'loading' } }] });
    return { provider: 'general', model: `general/${model.id}`, nodeId: 'minimax-audio-node', prompt: '欢迎来到创作画布' };
  }

  it.each([
    { kind: 'image' as const, mime: 'image/png', extension: 'png' },
    { kind: 'video' as const, mime: 'video/quicktime', extension: 'mov' },
    { kind: 'audio' as const, mime: 'audio/mpeg', extension: 'mp3' },
  ])('$kind 直传原连接，精确保留超过 JS 安全整数的 file_id', async ({ kind, mime, extension }) => {
    configureMinimax();
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应调用公共图床'));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(
      '{"file":{"file_id":9223372036854775806},"base_resp":{"status_code":0,"status_msg":"success"}}',
    ));
    await expect(uploadToRemote(`data:${mime};base64,YWJj`, 'my-minimax', kind))
      .resolves.toBe('mm_file://9223372036854775806');
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe(`${MINIMAX_BASE_URL}/v1/files/upload`);
    expect(init.headers).toEqual({ Authorization: 'Bearer minimax-current-fixture' });
    expect(init.body).toBeInstanceOf(FormData);
    const body = init.body as FormData;
    expect(body.get('purpose')).toBe('video_generation_input');
    expect((body.get('file') as File).name).toBe(`reference.${extension}`);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('同素材仅复用同连接同 Key 同站点缓存，换 Key 或国际站重新上传', async () => {
    configureMinimax();
    const source = 'data:audio/mpeg;base64,Y2FjaGU=';
    for (const fileId of ['101', '102', '103']) transportMocks.corsSafeFetch.mockResolvedValueOnce(
      jsonResponse({ file: { file_id: fileId }, base_resp: { status_code: 0 } }),
    );
    await expect(uploadToRemote(source, 'my-minimax', 'audio')).resolves.toBe('mm_file://101');
    await expect(uploadToRemote(source, 'my-minimax', 'audio')).resolves.toBe('mm_file://101');
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      'my-minimax': { ...state.config.providers['my-minimax'], apiKey: 'minimax-rotated-fixture' },
    } } }));
    await expect(uploadToRemote(source, 'my-minimax', 'audio')).resolves.toBe('mm_file://102');
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      'my-minimax': { ...state.config.providers['my-minimax'], baseUrl: 'https://api.minimax.io' },
    } } }));
    await expect(uploadToRemote(source, 'my-minimax', 'audio')).resolves.toBe('mm_file://103');
    expect(transportMocks.corsSafeFetch.mock.calls.map(([url]) => url)).toEqual([
      `${MINIMAX_BASE_URL}/v1/files/upload`, `${MINIMAX_BASE_URL}/v1/files/upload`, 'https://api.minimax.io/v1/files/upload',
    ]);
    expect(transportMocks.corsSafeFetch.mock.calls[2][1].headers).toEqual({ Authorization: 'Bearer minimax-rotated-fixture' });
  });

  it('同一张本地图的图片编辑与视频上传分别使用自己的缓存和文件 ID', async () => {
    configureMinimax('MiniMax-H3-Image');
    const source = `data:image/png;base64,${btoa('minimax-image-purpose')}`;
    for (const fileId of ['2101', '2102']) transportMocks.corsSafeFetch.mockResolvedValueOnce(
      jsonResponse({ file: { file_id: fileId }, base_resp: { status_code: 0 } }),
    );
    await expect(uploadToRemote(source, 'my-minimax', 'image')).resolves.toBe('mm_file://2101');
    await expect(uploadMinimaxImageReference(source, 'my-minimax')).resolves.toBe('mm_file://2102');
    await expect(uploadMinimaxImageReference(source, 'my-minimax')).resolves.toBe('mm_file://2102');
    await expect(uploadToRemote(source, 'my-minimax', 'image')).resolves.toBe('mm_file://2101');
    await expect(uploadMinimaxImageReference('mm_file://2101', 'my-minimax')).rejects.toThrow('本机文件或可公开访问');
    expect(transportMocks.corsSafeFetch.mock.calls.map(([url, init]) => [url, (init.body as FormData).get('purpose')]))
      .toEqual([
        [`${MINIMAX_BASE_URL}/v1/files/upload`, 'video_generation_input'],
        [`${MINIMAX_BASE_URL}/v1/files/upload`, 'image_generation_input'],
      ]);
  });

  it('H3 Image 文生图提交文生图端点，保留多张结果中成功的图片', async () => {
    const params = configureMinimax('MiniMax-H3-Image');
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [
      { url: 'https://cdn.example/minimax-image.png' }, { error: { code: '1027' } },
    ] }));
    const result = await generateImagesBatch({ ...params, imageSize: '2K', aspectRatio: '16:9' }, 2);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe(`${MINIMAX_BASE_URL}/v1/images/generations`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'MiniMax-H3-Image', area: '2K', aspect_ratio: '16:9', n: 2, response_format: 'url' });
    expect(body).not.toHaveProperty('images');
    expect(result).toMatchObject({ requestedCount: 2, failedCount: 1, results: [{ url: 'https://cdn.example/minimax-image.png' }] });
  });

  it('H3 Image 高速版按参考图顺序提交编辑端点，私有素材使用图片上传用途', async () => {
    const params = configureMinimax('MiniMax-H3-Image-Highspeed');
    const source = `data:image/png;base64,${btoa('minimax-image-edit')}`;
    const remote = 'https://cdn.example/reference.png';
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ file: { file_id: '2201' }, base_resp: { status_code: 0 } }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/minimax-edit.png' }] }));
    await expect(generateImagesBatch({ ...params, imageSize: '1K', aspectRatio: '1:1', image_urls: [source, remote] }, 1))
      .resolves.toMatchObject({ results: [{ url: 'https://cdn.example/minimax-edit.png' }] });
    const [[uploadUrl, uploadInit], [editUrl, editInit]] = transportMocks.corsSafeFetch.mock.calls;
    expect(uploadUrl).toBe(`${MINIMAX_BASE_URL}/v1/files/upload`);
    expect((uploadInit.body as FormData).get('purpose')).toBe('image_generation_input');
    expect(editUrl).toBe(`${MINIMAX_BASE_URL}/v1/images/edits`);
    expect(JSON.parse(editInit.body as string)).toMatchObject({ model: 'MiniMax-H3-Image-Highspeed',
      images: [{ image_url: 'mm_file://2201' }, { image_url: remote }] });
  });

  it('上传业务失败和非法格式明确报错，不回退 Uguu', async () => {
    configureMinimax();
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应回退公共图床'));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ base_resp: { status_code: 1004, status_msg: 'authorization failed' } }));
    await expect(uploadToRemote('data:audio/mpeg;base64,ZmFpbA==', 'my-minimax', 'audio')).rejects.toThrow();
    await expect(uploadToRemote('data:video/webm;base64,Zm9ybWF0', 'my-minimax', 'video')).rejects.toThrow('格式不支持');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it.each(['speech-2.8-hd', 'speech-2.8-turbo'])('%s 返回 URL 后保留原结果续存身份，不额外提交生成', async (id) => {
    const params = configureMinimax(id);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: { audio: 'https://cdn.example/minimax-voice.wav' },
      base_resp: { status_code: 0, status_msg: 'success' } }));
    const result = await generateAudio({ ...params, audioVoice: 'female-shaonv', audioSpeed: 1.25, audioFormat: 'wav' });
    expect(result).toMatchObject({ url: 'https://cdn.example/minimax-voice.wav',
      mediaDownloadAccess: { providerConfigId: 'my-minimax', origin: MINIMAX_BASE_URL, auth: { type: 'bearer' } },
      taskReceipt: { nodeId: params.nodeId, projectId: 'minimax-audio-project' } });
    const calls = transportMocks.corsSafeFetch.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(`${MINIMAX_BASE_URL}/v1/t2a_v2`);
    expect(JSON.parse(String(calls[0][1].body))).toMatchObject({ model: id, text: params.prompt,
      stream: false, output_format: 'url', voice_setting: { voice_id: 'female-shaonv', speed: 1.25 }, audio_setting: { format: 'wav' } });
    const pending = getPendingTasksForProject('minimax-audio-project');
    expect(pending).toEqual([expect.objectContaining({ submitted: true, providerConfigId: 'my-minimax',
      mediaRecoveryState: 'delivery_pending', resultUrls: [result.url] })]);
    expect(JSON.stringify(pending)).not.toContain('minimax-current-fixture');
  });

  it.each([null, { audio: 'https://cdn.example/not-a-success.mp3' }])('语音业务失败不接受旁带的结果 %j，也不保存成品记录', async (data) => {
    const params = configureMinimax();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data,
      base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }));
    await expect(generateAudio(params)).rejects.toMatchObject({ definitiveFailure: true });
    const body = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body));
    expect(body).toMatchObject({ voice_setting: { voice_id: 'male-qn-qingse', speed: 1 }, audio_setting: { format: 'mp3' } });
    expect(getPendingTasksForProject('minimax-audio-project')).toEqual([]);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('提交旁带 task_id 仍先检查明确拒绝，清理未受理记录且不查询假任务', async () => {
    const params = configureMinimax('MiniMax-H3');
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ task_id: 'not-an-accepted-task',
      base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }));
    await expect(generateVideo({ ...params, seedanceRatio: '16:9', seedanceResolution: '2K', seedanceDuration: 5 }))
      .rejects.toMatchObject({ definitiveFailure: true });
    expect(getPendingTasksForProject('minimax-audio-project')).toEqual([]);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('首次查询业务拒绝保留已经受理的原视频任务，不误判生成失败或重新提交', async () => {
    const params = configureMinimax('MiniMax-H3');
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ task_id: 'minimax-query-retained' }))
      .mockResolvedValueOnce(jsonResponse({ base_resp: { status_code: 1004, status_msg: 'authorization failed' } }));
    await expect(generateVideo({ ...params, seedanceRatio: '9:16', seedanceResolution: '768P', seedanceDuration: 5 }))
      .rejects.toMatchObject({ name: 'MediaTaskPausedError', taskReceipt: { taskId: 'minimax-query-retained' } });
    expect(getPendingTasksForProject('minimax-audio-project')).toEqual([expect.objectContaining({
      taskId: 'minimax-query-retained', submitted: true, providerConfigId: 'my-minimax',
    })]);
    expect(transportMocks.corsSafeFetch.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET']);
  });

  it.each(['business-unknown', 'network-interrupted', 'missing-business-status'])('同步语音 %s 保留提交未知记录，不自动再合成', async (reason) => {
    const params = configureMinimax();
    if (reason === 'business-unknown') transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      data: null, base_resp: { status_code: 1000, status_msg: 'unknown error' },
    }));
    else if (reason === 'missing-business-status') transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      data: { audio: 'https://cdn.example/unconfirmed.mp3' },
    }));
    else transportMocks.corsSafeFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(generateAudio(params)).rejects.toMatchObject({ name: 'MediaTaskPausedError',
      taskReceipt: { taskId: '', nodeId: params.nodeId } });
    expect(getPendingTasksForProject('minimax-audio-project')).toEqual([expect.objectContaining({
      taskId: '', submitted: false, mediaRecoveryState: 'submit_unknown', providerConfigId: 'my-minimax',
    })]);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('真实 HTTP400 的素材不可达给出直传建议，保留拒绝分类并隐藏原始链接', async () => {
    const params = configureMinimax('MiniMax-H3');
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ type: 'error',
      error: { type: 'bad_request_error', message: 'content[2].image_url: media url unreachable: https://private.example/image?token=fixture' },
    }), { status: 400 }));
    await expect(generateVideo({ ...params, seedanceRatio: '16:9', seedanceResolution: '2K', seedanceDuration: 5 }))
      .rejects.toMatchObject({ status: 400, definitiveFailure: true,
        message: expect.stringContaining('重新上传') });
    expect(getPendingTasksForProject('minimax-audio-project')).toEqual([]);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('不把参考音频当成隐式克隆，不上传素材也不发起合成', async () => {
    const params = configureMinimax();
    useAppStore.setState((state) => ({ nodes: [...state.nodes, { id: 'minimax-reference', type: 'source-audio', position: { x: 0, y: 0 },
      data: { type: 'source-audio', label: '原声', audioUrl: 'data:audio/mpeg;base64,YQ==' } }],
      edges: [{ id: 'minimax-edge', source: 'minimax-reference', target: params.nodeId }] }));
    await expect(generateAudio(params)).rejects.toThrow('声音克隆需先在官方平台完成');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });
});

describe('Amam 图片／视频的异步交付', () => {
  function configureAmam(id: string, custom = false) {
    const selected = structuredClone(AIGCSI_MODEL_MANIFEST.find((item) => item.id === id)!);
    if (custom) selected.executionProfile!.protocol!.submit.path = '/my-image-job';
    const category = selected.category === 'image' ? 'image' : 'video';
    const nodeId = `am-${category}-node`;
    const projectId = `am-${category}-project`;
    clearProjectTasks(projectId);
    useAppStore.getState().saveProviderConfig('my-amam', { name: '自己的 Amam', catalogId: 'aigc-si',
      apiKey: 'my-amam-fixture', baseUrl: AIGCSI_BASE_URL, selectedModels: [selected] });
    const general = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'my-amam')!;
    useAppStore.setState({ currentProjectId: projectId, nodes: [{ id: nodeId, type: category === 'image' ? 'ai-image' : 'ai-video',
      position: { x: 0, y: 0 }, data: { type: category === 'image' ? 'ai-image' : 'ai-video', label: 'Amam', status: 'loading' } }] });
    return { provider: 'general', model: `general/${general.id}`, nodeId, prompt: '镜头缓慢推进' };
  }

  it.each([false, true])('图片参考模式 %s 选择正确异步入口，原连接鉴权和结果续存身份均保留', async (withReference) => {
    const params = configureAmam('image-2.5-flare');
    const saved = structuredClone(useAppStore.getState().config.providers['my-amam'].selectedModels);
    const reference = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8Z0AAAAASUVORK5CYII=';
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应上传公共图床'));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'am-image-task', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', result: { data: [
        { url: '/v1/image-jobs/am-image-task/content?item_id=one' }, { url: 'https://cdn.example/two.png' },
      ] } }));
    const result = await generateImagesBatch({ ...params, imageSize: '2K', aspectRatio: '9:16',
      ...(withReference ? { image_urls: [reference] } : {}) }, 2);
    expect(result.results.map((item) => item.url)).toEqual([
      'https://aigc-si.com/v1/image-jobs/am-image-task/content?item_id=one', 'https://cdn.example/two.png',
    ]);
    expect(result.taskReceipt).toMatchObject({ taskId: 'am-image-task', nodeId: params.nodeId, projectId: 'am-image-project' });
    const calls = transportMocks.corsSafeFetch.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      `https://aigc-si.com/v1/images/${withReference ? 'edits' : 'generations'}/async`, 'https://aigc-si.com/v1/image-jobs/am-image-task',
    ]);
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ model: 'image-2.5-flare', prompt: expect.stringContaining(params.prompt),
      resolution: '2K', aspect_ratio: '9:16', response_format: 'url', n: 2, ...(withReference ? { images: [reference] } : {}) });
    expect(new Headers(calls[0][1].headers).get('Idempotency-Key')).toBeTruthy();
    expect(new Headers(calls[1][1].headers).get('Idempotency-Key')).toBeNull();
    expect(calls[1][1].headers).toMatchObject({ Authorization: 'Bearer my-amam-fixture' });
    expect(getPendingTasksForProject('am-image-project')).toEqual([expect.objectContaining({ taskId: 'am-image-task',
      providerConfigId: 'my-amam', mediaRecoveryState: 'delivery_pending', mediaDownloadAccess: { providerConfigId: 'my-amam',
        origin: 'https://aigc-si.com', auth: { type: 'bearer' } } })]);
    expect(JSON.stringify(getPendingTasksForProject('am-image-project'))).not.toContain('my-amam-fixture');
    expect(directFetch).not.toHaveBeenCalled();
    expect(useAppStore.getState().config.providers['my-amam'].selectedModels).toEqual(saved);
  });

  it('图片自定义协议路径不被内置文生图路由覆盖', async () => {
    const params = configureAmam('image-2', true);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'am-custom' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', result: { data: [{ url: 'https://cdn.example/custom.png' }] } }));
    await generateImagesBatch(params, 1);
    expect(transportMocks.corsSafeFetch.mock.calls[0][0]).toBe('https://aigc-si.com/v1/my-image-job');
  });

  it.each(['//external.example/image.png', '/\\external.example/image.png'])('拒绝改变来源的相对结果 %s，保留原任务且不向外站发起下载', async (url) => {
    const params = configureAmam('image-2');
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'am-unsafe-result' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', result: { data: [{ url }] } }));
    await expect(generateImagesBatch(params, 1)).rejects.toMatchObject({ name: 'MediaTaskPausedError',
      taskReceipt: { taskId: 'am-unsafe-result' } });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    expect(getPendingTasksForProject('am-image-project')[0]).toMatchObject({ taskId: 'am-unsafe-result', submitted: true });
  });

  it('视频完成后使用原连接 Key 下载二进制，提交幂等标识不进入查询或下载', async () => {
    const params = configureAmam('muse-video-1');
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'am-video-task' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed' }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } }));
    const result = await generateVideo({ ...params, seedanceResolution: '720p', seedanceRatio: '1:1', seedanceDuration: 8 });
    expect(result).toMatchObject({ url: 'data:video/mp4;base64,AQID', taskReceipt: { taskId: 'am-video-task' } });
    const calls = transportMocks.corsSafeFetch.mock.calls;
    expect(calls.map(([url]) => url)).toEqual(['https://aigc-si.com/v1/videos',
      'https://aigc-si.com/v1/videos/am-video-task', 'https://aigc-si.com/v1/videos/am-video-task/content']);
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ model: 'muse-video-1', prompt: params.prompt,
      seconds: '8', resolution: '720p', aspect_ratio: '1:1' });
    expect(new Headers(calls[0][1].headers).get('Idempotency-Key')).toBeTruthy();
    for (const [, init] of calls.slice(1)) {
      expect(init).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer my-amam-fixture' } });
      expect(new Headers(init.headers).get('Idempotency-Key')).toBeNull();
    }
  });

  it('下载失败保留原任务；仅用原查询和下载描述取回，轮换 Key 后不重新 POST', async () => {
    const params = configureAmam('muse-video-1');
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'am-video-retained' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed' }))
      .mockResolvedValueOnce(new Response('{"detail":"下载暂不可用"}', { status: 401 }));
    await expect(generateVideo({ ...params, seedanceDuration: 5 })).rejects.toMatchObject({ name: 'MediaTaskPausedError',
      taskReceipt: { taskId: 'am-video-retained' } });
    const [task] = getPendingTasksForProject('am-video-project');
    expect(task).toMatchObject({ taskId: 'am-video-retained', providerConfigId: 'my-amam', submitted: true,
      protocolPoll: { url: 'https://aigc-si.com/v1/videos/am-video-retained',
        resultDownload: { url: 'https://aigc-si.com/v1/videos/am-video-retained/content' } } });
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ status: 'completed' }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5, 6]), { headers: { 'Content-Type': 'video/mp4' } }));
    await expect(pollResolvedModelProtocol(task.protocolPoll!, 'rotated-amam-fixture', undefined, 'https://aigc-si.com/v1'))
      .resolves.toMatchObject({ urls: ['data:video/mp4;base64,BAUG'] });
    expect(transportMocks.corsSafeFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(transportMocks.corsSafeFetch.mock.calls.at(-1)![1].headers).toMatchObject({ Authorization: 'Bearer rotated-amam-fixture' });
  });

  it('远端明确 failed 时直接失败并清理当前待续记录，不显示提交未知', async () => {
    const params = configureAmam('muse-video-1');
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'am-video-failed' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', error: { message: '当前素材不符合要求' } }));
    await expect(generateVideo({ ...params, seedanceDuration: 5 })).rejects.toMatchObject({ name: 'PollTaskFailedError', message: expect.stringContaining('当前素材不符合要求') });
    expect(getPendingTasksForProject('am-video-project')).toEqual([]);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('Muse 的非法时长、参考视频在提交前拒绝，不产生生成请求', async () => {
    const params = configureAmam('muse-video-1');
    await expect(generateVideo({ ...params, seedanceDuration: 7 })).rejects.toThrow();
    await expect(generateVideo({ ...params, seedanceDuration: 5,
      referenceMedia: [{ kind: 'video', url: 'https://cdn.example/reference.mp4', origin: 'prompt', role: 'reference' }] })).rejects.toThrow();
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(getPendingTasksForProject('am-video-project')).toEqual([]);
  });
});

describe('CCC 图片异步任务与旧同步响应', () => {
  it.each([undefined, ''])('omits background and output format when CCC background is left at interface default (%s)', async (imageBackground) => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { cccapi: { name: 'CCC', apiKey: 'fixture', baseUrl: 'https://cccapi.cn/v1' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/image.png' }] }));
    await generateImagesBatch({ provider: 'cccapi', model: 'cccapi/gpt-image-2.5-sunburst',
      prompt: 'landscape', imageBackground }, 1);
    const body = JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('background');
    expect(body).not.toHaveProperty('output_format');
  });
  it('passes selected CCC quality through JSON and multipart without affecting resolution', async () => {
    useAppStore.getState().saveProviderConfig('ccc-quality', {
      name: 'CCC', catalogId: 'cccapi', apiKey: 'fixture', baseUrl: 'https://cccapi.cn/v1',
      selectedModels: [{ id: 'gpt-image-2.5-sunburst', name: 'Sunburst', category: 'image', provider: 'ccc-quality' }],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'ccc-quality')!;
    const params = { provider: 'general', model: `general/${model.id}`, prompt: 'landscape',
      imageSize: '2K', aspectRatio: '16:9', imageQuality: 'max', imageBackground: 'transparent' };
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ data: [{ url: 'https://cdn.example/image.png' }] }));
    await generateImagesBatch(params, 1);
    expect(JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body)).toMatchObject({
      quality: 'max', size: '3648x2048', background: 'transparent', output_format: 'png',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('reference', { headers: { 'Content-Type': 'image/png' } }));
    await generateImagesBatch({ ...params, image_urls: ['asset://localhost/ref.png'], imageQuality: 'low' }, 1);
    const form = transportMocks.corsSafeFetch.mock.calls[1][1].body as FormData;
    expect(form.get('quality')).toBe('low');
    expect(form.get('background')).toBe('transparent');
    expect(form.get('output_format')).toBe('png');
    expect(form.get('size')).toBe('3648x2048');
    expect(form.getAll('image[]')).toHaveLength(1);
  });

  it('omits quality for a CCC model without documented support', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { cccapi: { name: 'CCC', apiKey: 'fixture', baseUrl: 'https://cccapi.cn/v1' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/image.png' }] }));
    await generateImagesBatch({ provider: 'cccapi', model: 'cccapi/gpt-image-2', prompt: 'landscape',
      imageQuality: 'max', imageBackground: 'transparent' }, 1);
    const body = JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('quality');
    expect(body).not.toHaveProperty('background');
    expect(body).not.toHaveProperty('output_format');
  });
  function configureCcc() {
    useAppStore.getState().saveProviderConfig('cccapi-discount', {
      name: 'CCC', catalogId: 'cccapi', cccGroup: 'discount', apiKey: 'discount-fixture', baseUrl: 'https://cccapi.cn/v1',
      selectedModels: [{ id: 'gpt-image-2', name: 'GPT Image 2', category: 'image', provider: 'cccapi-discount' }],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'cccapi-discount')!;
    useAppStore.setState({ currentProjectId: 'ccc-project', nodes: [{ id: 'ccc-image', type: 'ai-image',
      position: { x: 0, y: 0 }, data: { type: 'ai-image', label: 'CCC', status: 'loading', prompt: '风景' } }] });
    return { provider: 'general', model: `general/${model.id}`, nodeId: 'ccc-image', prompt: '风景', imageSize: '4K' };
  }

  it('保存真实任务 ID，并用同一分组 Key 查询全部结果后等待交付确认', async () => {
    const params = configureCcc();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ code: 200, data: [{ status: 'submitted', task_id: 'ccc-task' }] }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: { id: 'ccc-task', status: 'completed', progress: 100,
        result: { images: [{ url: ['https://cdn.example/one.png', 'https://cdn.example/two.png'] }] } } }));
    const result = await generateImagesBatch(params, 2);
    expect(result.results.map((item) => item.url)).toEqual(['https://cdn.example/one.png', 'https://cdn.example/two.png']);
    expect(result.taskReceipt).toMatchObject({ projectId: 'ccc-project', nodeId: 'ccc-image', taskId: 'ccc-task' });
    expect(result.allTasksSettled).toBe(true);
    const task = getPendingTasksForProject('ccc-project')[0];
    expect(task).toMatchObject({ taskId: 'ccc-task', providerConfigId: 'cccapi-discount', submitted: true, mediaRecoveryState: 'delivery_pending' });
    expect(JSON.stringify(task)).not.toContain('discount-fixture');
    expect(transportMocks.corsSafeFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://cccapi.cn/v1/images/generations', 'https://cccapi.cn/v1/tasks/ccc-task',
    ]);
    expect(transportMocks.corsSafeFetch.mock.calls[1][1].headers).toMatchObject({ Authorization: 'Bearer discount-fixture' });
  });

  it('原任务只返回部分图片时不补交新生成，旧同步结果仍可接收', async () => {
    const params = configureCcc();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/legacy.png' }] }));
    const result = await generateImagesBatch(params, 2);
    expect(result.results).toHaveLength(1);
    expect(result.failedCount).toBe(1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    expect(result.allTasksSettled).toBe(true);
    expect(getPendingTasksForProject('ccc-project')).toEqual([expect.objectContaining({
      providerConfigId: 'cccapi-discount', resultUrls: ['https://cdn.example/legacy.png'],
      mediaRecoveryState: 'delivery_pending',
    })]);
  });

  it('查询被拒绝保留可恢复记录，且不会重发提交', async () => {
    const params = configureCcc();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'retained-task' }] }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Key 权限已变化' } }), { status: 401 }));
    await expect(generateImagesBatch(params, 1)).rejects.toMatchObject({
      name: 'MediaTaskPausedError', taskReceipt: { taskId: 'retained-task' },
    });
    expect(getPendingTasksForProject('ccc-project')[0]).toMatchObject({ taskId: 'retained-task', submitted: true });
    expect(transportMocks.corsSafeFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each([
    { status: 200, payload: { status: 'failed', error: { message: 'CCC 已明确生成失败' } } },
    { status: 200, payload: { data: { status: 'failed', error: { message: 'CCC 已明确生成失败' } } } },
    { status: 200, payload: { data: [{ status: 'failed', error: { message: 'CCC 已明确生成失败' } }] } },
    { status: 200, payload: { error: { code: 'rate_limit_exceeded', message: 'CCC 已明确拒绝提交' } } },
    { status: 429, payload: { error: { code: 'rate_limit_exceeded', message: 'CCC 已明确拒绝提交' } } },
    { status: 500, payload: { error: { code: 'rate_limit_exceeded', message: 'CCC 已明确拒绝提交' } } },
    { status: 200, payload: { data: [{ error: { code: 'content_policy_violation', message: 'Non posso generare questa immagine.' } }] } },
  ])('CCC HTTP $status 明确失败且没有任务 ID 时清理空记录，不误报提交未知', async ({ status, payload }) => {
    const params = configureCcc();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify(payload), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
    const error = await generateImagesBatch(params, 1).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ name: 'HttpResponseError' });
    expect(error).not.toMatchObject({ name: 'MediaTaskPausedError' });
    expect(getPendingTasksForProject('ccc-project')).toEqual([]);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('CCC 初始失败中回显 Key 仍会脱敏，且不会重发提交', async () => {
    const params = configureCcc();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: { status: 'failed', error: { message: 'rejected discount-fixture' } } }));
    const error = await generateImagesBatch(params, 1).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[REDACTED]');
    expect((error as Error).message).not.toContain('discount-fixture');
    expect(getPendingTasksForProject('ccc-project')).toEqual([]);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('CCC批项有规范内容拒绝码时保留意大利语原文并结算失败，不自动重投', async () => {
    const params = configureCcc(), message = 'Non posso generare questa immagine per motivi di sicurezza.';
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ error: { code: 'content_policy_violation', message } }] }));
    await expect(generateImagesBatch(params, 1)).rejects.toMatchObject({ definitiveFailure: true, message: `CCC 图片生成失败：${message}` });
    expect(getPendingTasksForProject('ccc-project')).toEqual([]);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { error: { message: 'Non posso generare questa immagine.' } },
    { error: { code: 'content_policy_violation' }, data: [{ error: { code: 'content_policy_violation' } }, { message: 'unknown outcome' }] },
  ])('CCC只有文案或混合未知批项时仍保留原提交，不把整批误判失败', async (payload) => {
    const params = configureCcc();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse(payload));
    await expect(generateImagesBatch(params, 1)).rejects.toMatchObject({ name: 'MediaTaskPausedError', reason: 'submit_unknown' });
    expect(getPendingTasksForProject('ccc-project')).toEqual([expect.objectContaining({ taskId: '', mediaRecoveryState: 'submit_unknown' })]);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('CCC 普通 502 没有明确终态或任务 ID 时仍保留提交未知，不重投', async () => {
    const params = configureCcc();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'upstream request failed' } }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(generateImagesBatch(params, 1)).rejects.toMatchObject({ name: 'MediaTaskPausedError', reason: 'submit_unknown' });
    expect(getPendingTasksForProject('ccc-project')).toEqual([expect.objectContaining({ taskId: '', submitted: false, mediaRecoveryState: 'submit_unknown' })]);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('CCC 带参考图的 HTML 504 统一读取响应后仍保留未知任务，不重投', async () => {
    const params = configureCcc();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('image', { headers: { 'Content-Type': 'image/png' } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response('<html>504 Gateway Time-out</html>', {
      status: 504, headers: { 'Content-Type': 'text/html' },
    }));
    await expect(generateImagesBatch({ ...params, image_urls: ['asset://localhost/reference.png'] }, 1))
      .rejects.toMatchObject({ name: 'MediaTaskPausedError', reason: 'submit_unknown' });
    expect(getPendingTasksForProject('ccc-project')).toEqual([expect.objectContaining({ taskId: '', submitted: false, mediaRecoveryState: 'submit_unknown' })]);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://cccapi.cn/v1/images/edits', expect.objectContaining({ method: 'POST' }));
  });

  it.each([404, 200])('CCC 本地参考图准备失败（HTTP %s）时不提交或保留空任务', async (status) => {
    const params = configureCcc();
    const referenceUrl = 'asset://localhost/reference.png';
    const localFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
    await expect(generateImagesBatch({ ...params, image_urls: [referenceUrl] }, 1))
      .rejects.toThrow(status === 404 ? '读取参考图 1 失败 (404)' : '参考图 1 内容为空');
    expect(localFetch).toHaveBeenCalledWith(referenceUrl, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(getPendingTasksForProject('ccc-project')).toEqual([]);
  });

  it('CCC 准备参考图期间取消时不提交或保留状态未知任务', async () => {
    const params = configureCcc();
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('请求已取消', 'AbortError');
    });
    await expect(generateImagesBatch({ ...params, image_urls: ['asset://localhost/reference.png'] }, 1, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(getPendingTasksForProject('ccc-project')).toEqual([]);
  });

  it('CCC 生成 POST 已发出后断网仍保留提交状态未知，不重发', async () => {
    const params = configureCcc();
    transportMocks.corsSafeFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(generateImagesBatch(params, 1)).rejects.toMatchObject({
      name: 'MediaTaskPausedError', reason: 'submit_unknown', taskReceipt: { taskId: '' },
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith(
      'https://cccapi.cn/v1/images/generations', expect.objectContaining({ method: 'POST' }),
    );
    expect(getPendingTasksForProject('ccc-project')).toEqual([expect.objectContaining({
      taskId: '', submitted: false, mediaRecoveryState: 'submit_unknown',
    })]);
  });

  it('自定义兼容接口不会仅因出现 task_id 就猜测 CCC 的查询路径', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'unknown-provider-task' }] }));
    await expect(generateImageStandard({ apiKey: 'fixture', baseUrl: 'https://custom.example/v1', modelName: 'gpt-image-2',
      prompt: '风景', dimensions: { width: 1024, height: 1024 } })).rejects.toThrow('结果为空');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });
});

describe('RunningHub 模型提交失败分类', () => {
  function configureRunningHub() {
    removePendingTask('runninghub-rejection-node');
    const model = 'seedream-v5-pro/text-to-image';
    useAppStore.setState((state) => ({ currentProjectId: 'runninghub-rejection-project', projectLoadStatus: 'ready',
      projects: [{ id: 'runninghub-rejection-project', name: 'RunningHub 测试项目', createdAt: 1, updatedAt: 1 }], config: { ...state.config,
      providers: { 'runninghub-model': { name: 'RunningHub', apiKey: 'runninghub-rejection-fixture', baseUrl: 'https://www.runninghub.cn' } } },
      nodes: [{ id: 'runninghub-rejection-node', type: 'ai-image', position: { x: 0, y: 0 },
        data: { type: 'ai-image', label: 'RunningHub 图片', status: 'loading', model, provider: 'runninghub' } }],
    }));
    return { provider: 'runninghub', model, prompt: '安静的山谷风景', nodeId: 'runninghub-rejection-node' };
  }

  it('HTTP200 非成功业务码明确拒绝时清理空记录，不保留未知提交', async () => {
    const params = configureRunningHub();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ code: 400, msg: '余额不足' }));
    await expect(executeRunningHubModel(params, 'image', params.prompt, {})).rejects.toMatchObject({
      name: 'HttpResponseError', definitiveFailure: true,
    });
    expect(getPendingTasksForProject('runninghub-rejection-project')).toEqual([]);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'gateway-504'] as const)('首次提交 %s 时保留未知状态且不重投', async (mode) => {
    const params = configureRunningHub();
    if (mode === 'network') transportMocks.corsSafeFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    else transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response('<html>504 Gateway Time-out</html>', { status: 504, headers: { 'Content-Type': 'text/html' } }));
    await expect(executeRunningHubModel(params, 'image', params.prompt, {})).rejects.toBeInstanceOf(Error);
    expect(getPendingTasksForProject('runninghub-rejection-project')).toEqual([expect.objectContaining({
      taskId: '', submitted: false, runninghubRecoveryState: 'submit_unknown', runninghubSubmissionUncertain: true,
    })]);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('已取得任务ID后的查询401保留原任务，不重发生成', async () => {
    const params = configureRunningHub();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: { taskId: '1904152026220003329', status: 'QUEUED' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Key 权限改变' } }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    await expect(executeRunningHubModel(params, 'image', params.prompt, {})).rejects.toBeInstanceOf(Error);
    expect(getPendingTasksForProject('runninghub-rejection-project')).toEqual([expect.objectContaining({
      taskId: '1904152026220003329', taskIds: ['1904152026220003329'], submitted: true,
    })]);
    expect(transportMocks.corsSafeFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://www.runninghub.cn/openapi/v2/seedream-v5-pro/text-to-image', 'https://www.runninghub.cn/openapi/v2/query',
    ]);
  });
});

describe('标准 Bearer 图片结果交付', () => {
  it('旧 adapter 返回多项但未声明固定候选时仍保留首项和原 RunningHub 专用输出集合', async () => {
    const outputs = ['https://cdn.example/legacy-first.png', 'https://cdn.example/legacy-second.png']
      .map((url) => ({ url, kind: 'image' as const }));
    const generate = vi.fn(async () => ({ requestedCount: 1, failedCount: 0,
      results: outputs.map((output) => ({ url: output.url, width: 1024, height: 1024, runninghubOutputs: outputs })) }));
    const unregister = mediaProviderRegistry.register({ providerId: 'legacy-multi-image', capabilities: ['image'], generateImage: generate });
    try {
      const result = await generateImage({ provider: 'legacy-multi-image', model: 'legacy-multi-image/legacy-model', prompt: 'legacy' });
      expect(result).toEqual({ url: outputs[0].url, width: 1024, height: 1024, runninghubOutputs: outputs });
      expect(result).not.toHaveProperty('additionalResults');
      expect(result).not.toHaveProperty('expectedOutputCount');
      expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestedCount: 1 }));
      expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('没有自定义协议的模型也保留下载身份和同步结果，不重新生成', async () => {
    useAppStore.getState().saveProviderConfig('plain-standard-images', {
      name: '标准图片', catalogId: 'custom-openai', apiKey: 'standard-key-fixture', baseUrl: 'https://standard.example/v1',
      selectedModels: [{ id: 'image-fixture', name: '图片', provider: 'plain-standard-images', category: 'image' }],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'plain-standard-images')!;
    useAppStore.setState({ currentProjectId: 'standard-image-delivery', nodes: [{ id: 'standard-image-node', type: 'ai-image',
      position: { x: 0, y: 0 }, data: { type: 'ai-image', label: '标准图片', status: 'loading' } }] });
    const url = 'https://standard.example/v1/images/private';
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url }] }));
    const result = await generateImagesBatch({ provider: 'general', model: `general/${model.id}`, nodeId: 'standard-image-node', prompt: '风景' }, 1);
    const access = { providerConfigId: 'plain-standard-images', origin: 'https://standard.example', auth: { type: 'bearer' } };
    expect(result.mediaDownloadAccess).toEqual(access);
    expect(result.results[0]).toMatchObject({ url, mediaDownloadAccess: access, taskReceipt: result.taskReceipt });
    expect(result.taskReceipt).toMatchObject({ nodeId: 'standard-image-node', projectId: 'standard-image-delivery' });
    expect(getPendingTasksForProject('standard-image-delivery')).toEqual([expect.objectContaining({
      resultUrls: [url], mediaDownloadAccess: access, submitted: true, mediaRecoveryState: 'delivery_pending',
    })]);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('standard-key-fixture');
  });
});

describe('LibAPI 图片原任务与请求合同', () => {
  function configureLibapiImage() {
    const selected = LIBAPI_MODEL_MANIFEST.find((model) => model.id === 'gt-image-2.5-flare')!;
    useAppStore.getState().saveProviderConfig('libapi-images', {
      name: 'LibAPI', catalogId: 'libapi', apiKey: 'libapi-image-fixture', baseUrl: 'https://libapi.cc/v1',
      selectedModels: [selected],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'libapi-images')!;
    useAppStore.setState({ currentProjectId: 'libapi-image-project', nodes: [{ id: 'libapi-image', type: 'ai-image',
      position: { x: 0, y: 0 }, data: { type: 'ai-image', label: 'LibAPI 图片', status: 'loading' } }] });
    return { provider: 'general', model: `general/${model.id}`, nodeId: 'libapi-image', prompt: '透明背景的角色立绘' };
  }

  async function failedLibapiUpload(response: Response): Promise<string> {
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应回退其他图床'));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(response);
    const error = await uploadToRemote('data:image/png;base64,bGliYXBpLWVycm9y', 'libapi-images', 'image')
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://libapi.cc/v1/files', expect.anything());
    expect(directFetch).not.toHaveBeenCalled();
    return (error as Error).message;
  }

  it.each([
    ['image', 'image/png', 'png'], ['video', 'video/mp4', 'mp4'], ['audio', 'audio/mpeg', 'mp3'],
  ] as const)('LibAPI 本地 %s 只用当前连接向 /v1/files 上传', async (kind, mime, extension) => {
    configureLibapiImage();
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      apimart: { name: 'APIMart', apiKey: 'unrelated-upload-fixture' },
    } } }));
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应请求其他图床'));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: `file-libapi-${kind}`, url: `https://cdn.example/libapi-upload-${kind}`,
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));

    await expect(uploadToRemote(`data:${mime};base64,bGliYXBpLXVwbG9hZC1maXh0dXJl`, 'libapi-images', kind))
      .resolves.toBe(`https://cdn.example/libapi-upload-${kind}`);

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://libapi.cc/v1/files', expect.objectContaining({
      method: 'POST', headers: { Authorization: 'Bearer libapi-image-fixture' }, body: expect.any(FormData),
    }));
    const form = transportMocks.corsSafeFetch.mock.calls[0][1].body as FormData;
    expect([...form.keys()]).toEqual(['file']);
    expect(form.get('file')).toMatchObject({ name: `reference.${extension}`, type: mime });
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('LibAPI 上传响应没有公网 URL 时明确失败，不重试或回退公共图床', async () => {
    configureLibapiImage();
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应请求其他图床'));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'file-without-url' }));

    await expect(uploadToRemote('data:audio/mpeg;base64,bGliYXBpLW1pc3NpbmctdXJs', 'libapi-images', 'audio'))
      .rejects.toThrow('LibAPI 上传未返回有效公网 URL');

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('LibAPI 未填写 Key 时不借用其他厂商 Key', async () => {
    configureLibapiImage();
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应请求其他图床'));
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      'libapi-images': { ...state.config.providers['libapi-images'], apiKey: '' },
      apimart: { name: 'APIMart', apiKey: 'unrelated-upload-fixture' },
    } } }));

    await expect(uploadToRemote('data:video/mp4;base64,bGliYXBpLW5vLWtleQ==', 'libapi-images', 'video'))
      .rejects.toThrow('当前连接的 Key');

    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(directFetch).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401, hint: /认证|鉴权/u },
    { status: 402, hint: /额度|余额/u },
    { status: 400, hint: /参数|素材/u },
    { status: 413, hint: /50\s*MB/u },
    { status: 429, hint: /限频|容量|配额/u },
    { status: 500, hint: /服务.*(?:不可用|异常)|暂.*不可用/u },
    { status: 403, hint: /原因/u },
  ])('LibAPI 上传按 HTTP $status 给出固定提示，不回显服务端任意正文', async ({ status, hint }) => {
    configureLibapiImage();
    const message = await failedLibapiUpload(new Response(JSON.stringify({ error: {
      code: 'untrusted_server_code', message: 'libapi-image-fixture https://private.example/ref.png <html>private</html>',
    } }), { status, headers: { 'Content-Type': 'application/json' } }));
    expect(message).toContain('LibAPI 图片参考上传失败');
    expect(message).toContain(`HTTP ${status}`);
    expect(message).toMatch(hint);
    for (const privateText of ['untrusted_server_code', 'libapi-image-fixture', 'private.example', '<html>']) {
      expect(message).not.toContain(privateText);
    }
    if (status === 400) expect(message).not.toContain('格式不支持');
    if (status === 403) expect(message).not.toMatch(/Key.*(?:错误|无效)|已确认.*权限/u);
  });

  it.each([
    { payload: { error: { code: 'api_key_inactive' } }, hint: /停用|删除|撤销/u },
    { payload: { error: { type: 'api_key_inactive' } }, hint: /停用|删除|撤销/u },
    { payload: { error: { code: 'insufficient_permissions' } }, hint: /权限不足/u },
    { payload: { type: 'insufficient_permissions' }, hint: /权限不足/u },
    { payload: { error: { code: 'content_policy_violation' } }, hint: /安全.*策略|策略.*拒绝/u },
    { payload: { code: 'content_policy_violation' }, hint: /安全.*策略|策略.*拒绝/u },
    { payload: { error: { code: 'model_not_allowed' } }, hint: /模型.*(?:范围|受限)/u },
    { payload: { error: { type: 'model_not_available_for_api_key' } }, hint: /未.*开放/u },
    { payload: { error: { code: 'content_policy_violation', type: 'insufficient_permissions' } }, hint: /安全.*策略|策略.*拒绝/u },
    { payload: { error: { code: 'unknown_future_code', type: 'insufficient_permissions' } }, hint: /权限不足/u },
  ])('LibAPI 403 只按已确认的 code/type 分类：$payload', async ({ payload, hint }) => {
    configureLibapiImage();
    const message = await failedLibapiUpload(new Response(JSON.stringify(payload), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    }));
    expect(message).toContain('HTTP 403');
    expect(message).toMatch(hint);
    if (hint.source === '权限不足') expect(message).toContain('文件');
  });

  it('LibAPI HTML 403 提示非 JSON 或访问策略拒绝，不回显 HTML 或 Key', async () => {
    configureLibapiImage();
    const message = await failedLibapiUpload(new Response(
      '<!doctype html><html>Bearer libapi-image-fixture https://private.example/ref.png</html>',
      { status: 403, headers: { 'Content-Type': 'text/html' } },
    ));
    expect(message).toMatch(/非\s*JSON|网关|访问.*(?:策略|拒绝页面)/u);
    expect(message).not.toContain('<html>');
    expect(message).not.toContain('libapi-image-fixture');
    expect(message).not.toContain('private.example');
  });

  it('LibAPI 仅显示合法且不含密钥的请求 ID', async () => {
    configureLibapiImage();
    const requestId = 'req-20261025_abc:1.2';
    const message = await failedLibapiUpload(new Response('{}', {
      status: 403, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
    }));
    expect(message).toContain('请求 ID');
    expect(message).toContain(requestId);
  });

  it.each([
    { requestId: 'request with spaces' },
    { requestId: 'https://private.example/request' },
    { requestId: 'https:private.example' },
    { requestId: 'sk-private-token' },
    { requestId: 'x'.repeat(97) },
    { requestId: 'req-libapi-image-fixture' },
    { requestId: 'req-fixture%2Bprivate', key: 'fixture+private' },
  ])('LibAPI 不回显不安全请求 ID：$requestId', async ({ requestId, key }) => {
    configureLibapiImage();
    if (key) useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      ...state.config.providers, 'libapi-images': { ...state.config.providers['libapi-images'], apiKey: key },
    } } }));
    const message = await failedLibapiUpload(new Response('{}', {
      status: 403, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
    }));
    expect(message).not.toContain('请求 ID');
    expect(message).not.toContain(requestId);
  });

  it('LibAPI 接受恰好 8 KiB 的完整 JSON 错误，但不回显其中的 message', async () => {
    configureLibapiImage();
    const prefix = '{"error":{"code":"insufficient_permissions","message":"';
    const suffix = '"}}';
    const body = prefix + 'x'.repeat(8192 - prefix.length - suffix.length) + suffix;
    const message = await failedLibapiUpload(new Response(body, { status: 403, headers: { 'Content-Type': 'application/json' } }));
    expect(message).toContain('权限不足');
    expect(message).not.toContain('x'.repeat(32));
  });

  it('LibAPI 超过 8 KiB 的错误流立即取消，不能把截断 JSON 当成完整原因', async () => {
    configureLibapiImage();
    const prefix = JSON.stringify({ error: { code: 'insufficient_permissions' } });
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(prefix.padEnd(4096)) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(4096).fill(32) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array([32]) });
    const cancel = vi.fn(async () => undefined);
    const response = { ok: false, status: 403, headers: new Headers({ 'Content-Type': 'application/json' }),
      body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) },
      text: vi.fn(), json: vi.fn(),
    } as unknown as Response;
    const message = await failedLibapiUpload(response);
    expect(message).toMatch(/原因/u);
    expect(message).not.toContain('权限不足');
    expect(cancel).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(3);
    expect(response.text).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it.each(['invalid-json', 'missing-reader', 'reader-failure'] as const)(
    'LibAPI 错误体 %s 时安全降级，不回显底层诊断', async (failure) => {
      configureLibapiImage();
      const response = failure === 'invalid-json'
        ? new Response('{"error":', { status: 403, headers: { 'Content-Type': 'application/json' } })
        : failure === 'missing-reader'
          ? new Response(null, { status: 403, headers: { 'Content-Type': 'application/json' } })
          : { ok: false, status: 403, headers: new Headers({ 'Content-Type': 'application/json' }),
            body: { getReader: () => ({
              read: vi.fn().mockRejectedValue(new Error('libapi-image-fixture https://private.example/raw')),
              cancel: vi.fn(async () => undefined), releaseLock: vi.fn(),
            }) },
          } as unknown as Response;
      const text = failure === 'missing-reader' ? vi.spyOn(response, 'text') : undefined;
      const message = await failedLibapiUpload(response);
      expect(message).toMatch(/原因/u);
      expect(message).not.toContain('libapi-image-fixture');
      expect(message).not.toContain('private.example');
      if (text) expect(text).not.toHaveBeenCalled();
    },
  );

  it('LibAPI 读取错误体期间取消仍返回 AbortError，不误报 HTTP 分类', async () => {
    configureLibapiImage();
    const controller = new AbortController();
    let markReading: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => { markReading = resolve; });
    let finishRead: ((result: ReadableStreamReadResult<Uint8Array>) => void) | undefined;
    const read = vi.fn(() => {
      markReading();
      return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { finishRead = resolve; });
    });
    const cancel = vi.fn(async () => { finishRead?.({ done: true, value: undefined }); });
    transportMocks.corsSafeFetch.mockResolvedValueOnce({ ok: false, status: 403,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) },
    });
    const pending = uploadToRemote('data:image/png;base64,bGliYXBpLWFib3J0', 'libapi-images', 'image', controller.signal)
      .catch((error: unknown) => error);
    await reading;
    controller.abort();
    const error = await pending;
    expect(error).toMatchObject({ name: 'AbortError' });
    expect((error as Error).message).not.toContain('HTTP 403');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    // 等底层取消结算，别把上传队列的临时隔离状态带进下个用例。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('LibAPI 参考图上传被拒绝时不提交依赖它的图片生成请求', async () => {
    const params = configureLibapiImage();
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应回退其他图床'));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'insufficient_permissions' } }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(generateImagesBatch({ ...params, image_urls: ['data:image/png;base64,bGliYXBpLWdlbmVyYXRl'] }, 1))
      .rejects.toThrow('文件');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://libapi.cc/v1/files', expect.anything());
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('LibAPI 视频参考上传只用选中自定义连接的 Key，拒绝后不进入视频提交', async () => {
    const selected = LIBAPI_MODEL_MANIFEST.find((model) => model.id === 'seedance-2-5')!;
    useAppStore.getState().saveProviderConfig('libapi-video-personal', {
      name: '自己的 LibAPI', catalogId: 'libapi', apiKey: 'video-selected-fixture',
      baseUrl: 'https://libapi.cc/v1', selectedModels: [selected],
    });
    const general = useAppStore.getState().config.generalModels!.find((model) => model.providerConfigId === 'libapi-video-personal')!;
    useAppStore.setState((state) => ({ currentProjectId: 'libapi-video-upload-denied-project',
      nodes: [{ id: 'libapi-upload-video', type: 'ai-video', position: { x: 0, y: 0 },
        data: { type: 'ai-video', label: '自己的 LibAPI 视频', status: 'loading' } }],
      config: { ...state.config, providers: { ...state.config.providers,
        libapi: { name: '默认 LibAPI', catalogId: 'libapi', apiKey: 'wrong-default-fixture' },
        apimart: { name: '其他厂商', apiKey: 'wrong-provider-fixture' },
      } },
    }));
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应回退其他图床'));
    const beforeSubmit = vi.fn();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'insufficient_permissions' } }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(generateVideo({ provider: 'general', model: `general/${general.id}`, nodeId: 'libapi-upload-video',
      prompt: '依据参考图生成视频', seedanceDuration: 5, seedanceResolution: '480p', seedanceRatio: '16:9',
      referenceMedia: [{ kind: 'image', role: 'reference', origin: 'connection', url: 'data:image/png;base64,bGliYXBpLXZpZGVv' }],
    }, undefined, beforeSubmit)).rejects.toThrow('文件');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://libapi.cc/v1/files', expect.objectContaining({
      method: 'POST', headers: { Authorization: 'Bearer video-selected-fixture' }, body: expect.any(FormData),
    }));
    expect(beforeSubmit).not.toHaveBeenCalled();
    expect(getPendingTasksForProject('libapi-video-upload-denied-project')).toEqual([]);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('LibAPI 不支持的音频格式在发送上传请求前拦截', async () => {
    configureLibapiImage();
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应请求其他图床'));

    await expect(uploadToRemote('data:audio/ogg;base64,bGliYXBpLW9nZw==', 'libapi-images', 'audio'))
      .rejects.toThrow('格式不支持');

    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('只提交一次统一异步请求，用 task_id 查询并保留交付凭据', async () => {
    const params = configureLibapiImage();
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ mode: 'async', task_id: 'libapi-image-task', status: 'pending' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', is_final: true,
        output_url: 'https://cdn.example/libapi-image.png' }));

    const result = await generateImagesBatch({ ...params, imageSize: '2K', aspectRatio: '9:16',
      imageQuality: 'high', imageBackground: 'transparent', image_urls: ['https://cdn.example/character.png'] }, 1);

    expect(result.results[0].url).toBe('https://cdn.example/libapi-image.png');
    expect(result.taskReceipt).toMatchObject({ projectId: 'libapi-image-project', nodeId: 'libapi-image', taskId: 'libapi-image-task' });
    const calls = transportMocks.corsSafeFetch.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      'https://libapi.cc/api/v1/model-runtime/invoke', 'https://libapi.cc/v1/tasks/libapi-image-task',
    ]);
    expect(JSON.parse(String(calls[0][1].body))).toMatchObject({ model_id: 'gt-image-2.5-flare', modality: 'image', params: {
      aspect_ratio: '9:16', resolution: '2K', quality: 'high', background: 'transparent', count: 1,
      images: ['https://cdn.example/character.png'],
    } });
    expect(calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(calls[1][1].headers).toMatchObject({ Authorization: 'Bearer libapi-image-fixture' });
    const pending = getPendingTasksForProject('libapi-image-project');
    expect(pending).toEqual([expect.objectContaining({ providerConfigId: 'libapi-images', taskId: 'libapi-image-task',
      submitted: true, mediaRecoveryState: 'delivery_pending' })]);
    expect(JSON.stringify(pending)).not.toContain('libapi-image-fixture');
  });

  it('查询鉴权失败保留原 task_id，不重新提交生成', async () => {
    const params = configureLibapiImage();
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ task_id: 'libapi-retained-task' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: '权限已变化' } }), { status: 401 }));

    await expect(generateImagesBatch(params, 1)).rejects.toMatchObject({
      name: 'MediaTaskPausedError', taskReceipt: { taskId: 'libapi-retained-task' },
    });
    expect(transportMocks.corsSafeFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(getPendingTasksForProject('libapi-image-project')).toEqual([expect.objectContaining({
      taskId: 'libapi-retained-task', providerConfigId: 'libapi-images', submitted: true,
    })]);
  });
});

describe('LibAPI 音频合同与原任务交付', () => {
  function configureAudio(id: string) {
    const selected = LIBAPI_MODEL_MANIFEST.find((model) => model.id === id)!;
    useAppStore.getState().saveProviderConfig('libapi-audio', {
      name: 'LibAPI', catalogId: 'libapi', apiKey: 'libapi-audio-fixture', selectedModels: [selected],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'libapi-audio')!;
    useAppStore.setState({ currentProjectId: 'libapi-audio-project', nodes: [{ id: 'libapi-audio-node', type: 'ai-audio',
      position: { x: 0, y: 0 }, data: { type: 'ai-audio', label: 'LibAPI 音频', status: 'loading' } }] });
    return { provider: 'general', model: `general/${model.id}`, nodeId: 'libapi-audio-node', prompt: '欢迎来到创作空间' };
  }
  function successfulAudio() {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ task_id: 'libapi-audio-task' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', output_url: 'https://cdn.example/libapi-audio.wav' }));
  }

  it('同名连接显式改为自定义后保留原协议，不强加内置音色或官方地址', async () => {
    const selected = LIBAPI_MODEL_MANIFEST.find((model) => model.id === 'speech-2.8')!;
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, libapi: { name: '自定义语音', catalogId: 'custom-openai',
        apiKey: 'custom-speech-fixture', baseUrl: 'https://custom-speech.example/v1' } },
      generalModels: [{ id: 'custom-speech', providerConfigId: 'libapi', name: selected.name,
        modelId: selected.id, category: 'audio', executionProfile: selected.executionProfile }],
    } }));
    successfulAudio();

    await expect(generateAudio({ provider: 'general', model: 'general/custom-speech', prompt: '沿用自定义协议' }))
      .resolves.toMatchObject({ url: 'https://cdn.example/libapi-audio.wav' });

    const calls = transportMocks.corsSafeFetch.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      'https://custom-speech.example/api/v1/model-runtime/invoke', 'https://custom-speech.example/v1/tasks/libapi-audio-task',
    ]);
    expect(calls[0][1].headers).toMatchObject({ Authorization: 'Bearer custom-speech-fixture' });
    expect(JSON.parse(String(calls[0][1].body)).params).not.toHaveProperty('voice');
  });

  it.each([
    { id: 'gt-4o-mini-tts', expected: { voice: 'alloy', response_format: 'mp3', speed: 1 } },
    { id: 'gm-3.1-flash-tts', expected: { voice: 'Zephyr', response_format: 'wav' } },
    { id: 'gm-2.5-pro-tts', expected: { voice: 'Zephyr', response_format: 'wav' } },
  ])('$id 使用本型号默认参数，只提交一次并保留原音频任务', async ({ id, expected }) => {
    const params = configureAudio(id);
    successfulAudio();
    const result = await generateAudio(params);
    expect(result).toMatchObject({ url: 'https://cdn.example/libapi-audio.wav', taskReceipt: { taskId: 'libapi-audio-task' } });
    const calls = transportMocks.corsSafeFetch.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      'https://libapi.cc/api/v1/model-runtime/invoke', 'https://libapi.cc/v1/tasks/libapi-audio-task',
    ]);
    const body = JSON.parse(String(calls[0][1].body));
    expect(body).toMatchObject({ model_id: id, modality: 'audio', operation: 'speech', params: { input: params.prompt, ...expected } });
    expect(body.params).not.toHaveProperty('count');
    if (id.startsWith('gm-')) expect(body.params).not.toHaveProperty('speed');
    expect(getPendingTasksForProject('libapi-audio-project')).toEqual([expect.objectContaining({
      taskId: 'libapi-audio-task', providerConfigId: 'libapi-audio', mediaRecoveryState: 'delivery_pending',
    })]);
    expect(JSON.stringify(result.taskReceipt)).not.toContain('libapi-audio-fixture');
  });

  it.each(['speech-2.8', 'doubao-tts-2.0'])('%s 只传入用户明确填写的声音 ID', async (id) => {
    const params = configureAudio(id);
    successfulAudio();
    await generateAudio({ ...params, audioVoice: 'my-authorized-voice-id', audioSpeed: 1.25 });
    const body = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body));
    expect(body.params).toMatchObject({ input: params.prompt, voice: 'my-authorized-voice-id', speed: 1.25 });
    if (id === 'speech-2.8') expect(body.params).not.toHaveProperty('response_format');
    else expect(body.params.response_format).toBe('mp3');
  });

  it('音乐提交标题和歌词，不发送时长或 BPM，也不先提交另一个写词任务', async () => {
    const params = configureAudio('music');
    successfulAudio();
    await generateAudio({ ...params, prompt: '轻快的旅行歌曲', musicTitle: '旅途', musicLyrics: '迎着阳光向前走' });
    const body = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body));
    expect(body).toMatchObject({ modality: 'audio', operation: 'generate', params: {
      prompt: '轻快的旅行歌曲', title: '旅途', lyrics: '迎着阳光向前走',
    } });
    for (const name of ['duration', 'bpm', 'count', 'response_format', 'voice']) expect(body.params).not.toHaveProperty(name);
    expect(transportMocks.corsSafeFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it.each([
    { id: 'speech-2.8', extra: {}, error: /音色|voice/i },
    { id: 'doubao-tts-2.0', extra: {}, error: /音色|voice/i },
    { id: 'gt-4o-mini-tts', extra: { audioFormat: 'pcm' as const }, error: /格式|format/i },
    { id: 'gm-3.1-flash-tts', extra: { audioSpeed: 1.25 }, error: /语速|速度|speed/i },
    { id: 'music', extra: { musicDuration: 60 }, error: /时长|duration/i },
  ])('$id 的不完整或不支持参数在提交前失败', async ({ id, extra, error }) => {
    const params = configureAudio(id);
    await expect(generateAudio({ ...params, ...extra })).rejects.toThrow(error);
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('参考音频不被当作即传即克隆，提交前停止且不上传素材', async () => {
    const params = configureAudio('gt-4o-mini-tts');
    useAppStore.setState((state) => ({ nodes: [...state.nodes, { id: 'audio-reference', type: 'source-audio', position: { x: 0, y: 0 },
      data: { type: 'source-audio', label: '原声', audioUrl: 'data:audio/mpeg;base64,YQ==' } }],
      edges: [{ id: 'audio-edge', source: 'audio-reference', target: params.nodeId }] }));
    await expect(generateAudio(params)).rejects.toThrow('不接受参考素材');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it.each(['node-image', 'asset-audio', 'drama-image'])('%s 的纯 @ 引用也会在提交前拦截，不把素材地址变成朗读正文', async (kind) => {
    const params = configureAudio('gt-4o-mini-tts');
    useAppStore.setState((state) => ({
      nodes: [...state.nodes, { id: 'image-reference', type: 'source-image', position: { x: 0, y: 0 },
        data: { type: 'source-image', label: '参考图', imageUrl: 'data:image/png;base64,YQ==' } }],
      dramaAssets: { ...state.dramaAssets, scenes: [{ id: 'scene-reference', kind: 'scene', name: '参考场景',
        key: 'scene-reference', summary: '', visualNotes: '', importance: 'main', confirmed: true,
        source: 'manual', createdAt: 1, updatedAt: 1, imageUrl: 'data:image/png;base64,YQ==' }] },
      edges: [],
    }));
    const reference = kind === 'node-image' ? '@{image-reference:参考图}'
      : kind === 'asset-audio' ? '@asset{fixtures/reference.mp3}' : '@drama{scene-reference:参考场景}';
    await expect(generateAudio({ ...params, prompt: `请参考 ${reference} 朗读欢迎词` })).rejects.toThrow('不接受参考素材');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('音频查询中断保留已有 task_id，避免重复提交扣费', async () => {
    const params = configureAudio('gt-4o-mini-tts');
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ task_id: 'libapi-retained-audio' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Key 权限已变化' } }), { status: 401 }));
    await expect(generateAudio(params)).rejects.toMatchObject({ name: 'MediaTaskPausedError', taskReceipt: { taskId: 'libapi-retained-audio' } });
    expect(transportMocks.corsSafeFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(getPendingTasksForProject('libapi-audio-project')).toEqual([expect.objectContaining({
      taskId: 'libapi-retained-audio', submitted: true, providerConfigId: 'libapi-audio',
    })]);
  });
});

describe('Kling 图片交付与原任务恢复', () => {
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

  it.each(['unchanged', 'key', 'address', 'catalog', 'digest', 'category'] as const)(
    '角色恢复只查询原合同和账号，模型已移除且 %s', async (change) => {
      const params = configureKling();
      const config = useAppStore.getState().config;
      const selected = config.generalModels![0];
      const protocol = resolveModelExecutionProfile(selected.executionProfile)!;
      const operation = 'character-kling-op';
      const recovery: CharacterImageTaskRecovery = { version: 1, kind: 'protocol', connectionId: 'official',
        modelRef: params.model, providerBase: KLING_BASE_URL, configurationDigest: 'a'.repeat(64), expectedCount: 1,
        query: { modelId: selected.modelId, serverId: change === 'category' ? 'replicate-video-v1' : 'kling-tasks-v1',
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
          serverId: change === 'category' ? 'replicate-video-v1' : 'kling-tasks-v1',
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
});
