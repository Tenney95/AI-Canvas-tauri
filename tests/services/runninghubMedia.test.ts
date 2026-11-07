/**
 * runninghubMedia — 回归测试：RunningHub 标准媒体执行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import { buildRunningHubModelRequest, executeRunningHubModel, parseRunningHubModelOutputs, queryRunningHubModel } from '../../src/services/ai/providers/runninghubMedia';
import { RUNNINGHUB_MODEL_MANIFEST, getRunningHubModel } from '../../src/services/ai/providers/runninghubModelManifest';
import { generateVideo } from '../../src/services/ai/generateVideo';
import { cancelRunningHubNodeTask, completeRunningHubNodeTask } from '../../src/services/ai/providers/runninghubWorkflow';
import { cancelNodePolling, getPendingTasksForProject, resumeRunningHubNodeTask, resumePendingTasks } from '../../src/services/pollManager';
import type { RunningHubMediaKind } from '../../src/types/runninghub';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), persist: vi.fn(), upload: vi.fn() }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.fetch }));
vi.mock('../../src/services/fileService', async (original) => ({ ...await original<typeof import('../../src/services/fileService')>(), persistMediaUrlToProjectData: mocks.persist, isTauriEnv: () => true }));
vi.mock('../../src/services/ai/providers/runninghubClient', async (original) => ({ ...await original<typeof import('../../src/services/ai/providers/runninghubClient')>(), uploadRunningHubMedia: mocks.upload }));
const connection = { apiKey: 'fake-secret', baseUrl: 'https://www.runninghub.cn' };
const uploadedUrl = (source: string, mediaKind: RunningHubMediaKind = 'image', baseUrl = connection.baseUrl) => `https://rh-upload.test/${new URL(baseUrl).hostname}/${mediaKind}/${encodeURIComponent(source)}`;
const taskId = '1904152026220003329';
const ids = { image: 'seedream-v5-pro/text-to-image', video: 'minimax/h3-max-turbo/image-to-video', audio: 'rhart-audio/text-to-audio/speech-2.8-hd' };
const pending = () => getPendingTasksForProject('p1');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let state = 'SUCCESS';
let kind: RunningHubMediaKind = 'image';
let serial = 0;
const submitted = () => mocks.fetch.mock.calls.filter(([url]) => !String(url).endsWith('/query') && !String(url).endsWith('/upload/binary'));
function setup(next: RunningHubMediaKind = 'image') {
  kind = next;
  useAppStore.setState({ currentProjectId: 'p1', projectLoadStatus: 'ready',
    projects: [{ id: 'p1', name: '项目一', createdAt: 1, updatedAt: 1 }],
    config: { ...useAppStore.getState().config, providers: { 'runninghub-model': { name: 'RH', apiKey: connection.apiKey } } },
    nodes: [{ id: 'n1', type: `ai-${kind}`, position: { x: 0, y: 0 }, data: { type: `ai-${kind}`, label: '模型测试', provider: 'runninghub', model: ids[kind], status: 'loading' } }],
  });
}
const generate = (count = 1) => executeRunningHubModel({ provider: 'runninghub', model: ids[kind], prompt: '测试模型生成内容', nodeId: 'n1' }, kind, '测试模型生成内容', kind === 'video' ? { image: ['https://input.test/first.png'], imageRoles: ['first_frame'] } : {}, count);
beforeEach(() => {
  // 只模拟轮询计时，不冻结 IndexedDB 事务的 setImmediate。
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  localStorage.clear(); useAppStore.setState(useAppStore.getInitialState(), true); setup(); state = 'SUCCESS'; serial = 0;
  mocks.upload.mockReset().mockImplementation(async (target, source, mediaKind) => ({ filename: 'rh/reference', url: uploadedUrl(source, mediaKind, target.baseUrl) }));
  mocks.persist.mockReset().mockImplementation(async (url: string) => ({ filePath: `project/${url.split('/').pop()}`, mediaUrl: `asset://localhost/${url.split('/').pop()}`, sourceUrl: url }));
  mocks.fetch.mockReset().mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith('/query')) return json({ taskId, status: state, results: [{ url: `https://cdn.test/${JSON.parse(String(init.body)).taskId}.${{ image: 'png', video: 'mp4', audio: 'wav' }[kind]}` }] });
    return new Response(`{"taskId":${BigInt(taskId) + BigInt(serial++)},"status":"QUEUED"}`);
  });
});
afterEach(() => { cancelNodePolling('n1'); cancelNodePolling('runninghub-message-m1'); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('RunningHub 标准媒体执行', () => {
  it.each([1, 2])('%i 张正常连线图片及重复 @ 引用走参考图接口，保留参数和节点模型', async (count) => {
    setup('video');
    const model = 'runninghub/bytedance/seedance-2.0-global/image-to-video';
    const images = Array.from({ length: count }, (_, index) => ({
      id: `image-${index}`, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image' as const, label: `图片${index}`, imageUrl: `https://input.test/${index}.png` },
    }));
    useAppStore.setState((store) => ({
      nodes: [{ ...store.nodes[0], data: { ...store.nodes[0].data, model } }, ...images],
      edges: images.map((image) => ({ id: `edge-${image.id}`, source: image.id, target: 'n1' })),
    }));
    await generateVideo({
      provider: 'runninghub', model, nodeId: 'n1', prompt: '参考 @{image-0:图片0} 生成视频',
      runninghubModelParameters: { duration: '8', ratio: '9:16', resolution: '1080p', generateAudio: 'false', seed: '0' },
    });
    expect(submitted()).toHaveLength(1);
    expect(submitted()[0][0]).toBe(`${connection.baseUrl}/openapi/v2/bytedance/seedance-2.0-global/multimodal-video`);
    const body = JSON.parse(submitted()[0][1].body as string);
    expect(body).toMatchObject({ imageUrls: images.map((image) => uploadedUrl(image.data.imageUrl)), duration: '8', ratio: '9:16', resolution: '1080p', generateAudio: false, seed: 0 });
    expect(mocks.upload).toHaveBeenCalledTimes(count);
    expect(body).not.toHaveProperty('firstFrameUrl');
    expect(body).not.toHaveProperty('lastFrameUrl');
    expect(useAppStore.getState().nodes[0].data.model).toBe(model);
    expect(pending()[0].runninghubModelId).toBe(model);
  });
  it.each(['bytedance/seedance-2.0-global-fast', 'bytedance/seedance-2.5-global-token', 'rhart-video/sparkvideo-2.0'])('无角色旧图片数组和空帧参数也走同系列参考接口：%s', async (family) => {
    setup('video');
    const parameters = { firstFrameUrl: '', lastFrameUrl: ' ', duration: '5' };
    await executeRunningHubModel({ provider: 'runninghub', model: `${family}/image-to-video`, prompt: '参考图片生成视频', runninghubModelParameters: parameters }, 'video', '参考图片生成视频', {
      image: ['https://input.test/one.png', 'https://input.test/two.png'],
    });
    expect(submitted()[0][0]).toBe(`${connection.baseUrl}/openapi/v2/${family}/multimodal-video`);
    expect(JSON.parse(submitted()[0][1].body as string)).toMatchObject({ imageUrls: ['https://input.test/one.png', 'https://input.test/two.png'].map((url) => uploadedUrl(url)) });
    expect(parameters).toEqual({ firstFrameUrl: '', lastFrameUrl: ' ', duration: '5' });
  });
  it('参数框明确指定首帧时保留首帧接口，同一张连线图片不重复作为参考图', async () => {
    setup('video');
    const model = 'bytedance/seedance-2.0-global/image-to-video';
    const firstFrameUrl = 'https://input.test/first.png';
    await executeRunningHubModel({ provider: 'runninghub', model, prompt: '首帧生成视频', runninghubModelParameters: { firstFrameUrl } }, 'video', '首帧生成视频', { image: [firstFrameUrl] });
    expect(submitted()[0][0]).toBe(`${connection.baseUrl}/openapi/v2/${model}`);
    expect(JSON.parse(submitted()[0][1].body as string)).toMatchObject({ firstFrameUrl: uploadedUrl(firstFrameUrl) });
    expect(JSON.parse(submitted()[0][1].body as string)).not.toHaveProperty('imageUrls');
  });
  it('明确指定首尾帧角色时保留顺序语义，仅尾帧仍在提交前拦截', async () => {
    setup('video');
    const model = 'bytedance/seedance-2.0-global/image-to-video';
    useAppStore.getState().updateNodeData('n1', { model });
    await expect(executeRunningHubModel({ provider: 'runninghub', model, nodeId: 'n1', prompt: '首尾帧生成视频' }, 'video', '首尾帧生成视频', {
      image: ['https://input.test/last.png'], imageRoles: ['last_frame'],
    })).rejects.toThrow('首帧');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(pending()).toEqual([]);
    expect(useAppStore.getState().nodes[0].data.runninghubStage).toBe('任务未提交');
    await executeRunningHubModel({ provider: 'runninghub', model, nodeId: 'n1', prompt: '首尾帧生成视频' }, 'video', '首尾帧生成视频', {
      image: ['https://input.test/last.png', 'https://input.test/first.png'], imageRoles: ['last_frame', 'first_frame'],
    });
    expect(submitted()[0][0]).toBe(`${connection.baseUrl}/openapi/v2/${model}`);
    expect(JSON.parse(submitted()[0][1].body as string)).toMatchObject({ firstFrameUrl: uploadedUrl('https://input.test/first.png'), lastFrameUrl: uploadedUrl('https://input.test/last.png') });
  });
  it('无素材也未设置首尾帧时使用同系列文生视频接口', async () => {
    setup('video');
    await executeRunningHubModel({ provider: 'runninghub', model: 'bytedance/seedance-2.0-global/image-to-video', prompt: '纯文字生成视频' }, 'video', '纯文字生成视频', {});
    expect(submitted()[0][0]).toBe(`${connection.baseUrl}/openapi/v2/bytedance/seedance-2.0-global/text-to-video`);
    expect(JSON.parse(submitted()[0][1].body as string)).not.toHaveProperty('firstFrameUrl');
  });
  it('没有同系列参考接口时提示更换模型，不跨版本改道或上传素材', async () => {
    setup('video');
    await expect(executeRunningHubModel({ provider: 'runninghub', model: 'seedance-v1.5-pro/image-to-video', prompt: '参考图片生成视频' }, 'video', '参考图片生成视频', { image: ['blob:reference'] })).rejects.toThrow('不支持普通参考素材');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(pending()).toEqual([]);
  });
  it('参考模式仍校验数量和未知参数，错误先于上传与付费提交', async () => {
    setup('video');
    const model = 'bytedance/seedance-2.0-global/image-to-video';
    await expect(executeRunningHubModel({ provider: 'runninghub', model, prompt: '参考图片生成视频' }, 'video', '参考图片生成视频', { image: Array.from({ length: 10 }, (_, index) => `blob:ref-${index}`) })).rejects.toThrow('数量');
    await expect(executeRunningHubModel({ provider: 'runninghub', model, prompt: '参考图片生成视频', runninghubModelParameters: { unknown: 'value' } }, 'video', '参考图片生成视频', { image: ['blob:reference'] })).rejects.toThrow('参数已变化');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(pending()).toEqual([]);
  });
  it('参考模式网络中断后按原节点恢复，只查询已有任务', async () => {
    setup('video');
    const model = 'bytedance/seedance-2.0-global/image-to-video';
    useAppStore.getState().updateNodeData('n1', { model });
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url, init) => { if (String(url).endsWith('/query')) throw new Error('offline'); return original(url, init); });
    await expect(executeRunningHubModel({ provider: 'runninghub', model, nodeId: 'n1', prompt: '参考图片生成视频' }, 'video', '参考图片生成视频', { image: ['https://input.test/reference.png'] })).rejects.toThrow('连接中断');
    expect(pending()[0]).toMatchObject({ taskId, runninghubModelId: model });
    mocks.fetch.mockImplementation(original);
    await resumeRunningHubNodeTask('n1');
    expect(useAppStore.getState().nodes[0].data.status).toBe('success');
    expect(pending()).toEqual([]);
    expect(submitted()).toHaveLength(1);
  });
  it.each(['alibaba/wan-3.0/image-to-video', 'alibaba/wan-3.0-prime/image-to-video'])('万相首帧说明提及尾帧时仍正确绑定：%s', async (id) => {
    const model = getRunningHubModel(id)!;
    const first = 'https://input.test/first.png';
    const last = 'https://input.test/last.png';
    const body = await buildRunningHubModelRequest(connection, model, 'test', {}, {
      image: [last, first], imageRoles: ['last_frame', 'first_frame'],
    });
    expect(body).toMatchObject({ firstFrameUrl: uploadedUrl(first), lastFrameUrl: uploadedUrl(last) });
    await expect(buildRunningHubModelRequest(connection, model, 'test', {}, {
      image: [first], imageRoles: ['first_frame'],
    })).resolves.toMatchObject({ firstFrameUrl: uploadedUrl(first) });
    await expect(buildRunningHubModelRequest(connection, model, 'test', {}, {
      image: [last], imageRoles: ['last_frame'],
    })).rejects.toThrow('首帧');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each(['image', 'video', 'audio'] as const)('%s 使用模型端点及 v2/query，保留长 ID 与所有已保存产物', async (value) => {
    setup(value); const result = await generate();
    expect(result[0].filePath).toBeTruthy();
    expect(submitted()[0][0]).toBe(`${connection.baseUrl}/openapi/v2/${ids[value]}`);
    expect(submitted()[0][1].headers.Authorization).toBe(`Bearer ${connection.apiKey}`);
    const body = JSON.parse(submitted()[0][1].body as string);
    expect(body.apiKey).toBeUndefined();
    if (value === 'video') expect(body).toMatchObject({ firstFrameUrl: uploadedUrl('https://input.test/first.png'), duration: '5', resolution: '768p' });
    expect(pending()[0]).toMatchObject({ taskId, taskType: 'runninghub-model', runninghubModelId: ids[value], runninghubRecoveryState: 'save_pending' });
    expect(JSON.stringify(pending())).not.toContain(connection.apiKey);
    completeRunningHubNodeTask('n1'); expect(pending()).toEqual([]);
  });
  it('全部目录操作通过类型转换与 RH 上传边界，不发送任务请求', async () => {
    for (const model of RUNNINGHUB_MODEL_MANIFEST) {
      const values: Record<string, string> = {};
      for (const field of model.parameters) {
        if (field.binding === 'prompt' || (!field.required && !field.mediaKind)) continue;
        const s = field.schema;
        if (field.defaultValue !== undefined) continue;
        if (field.mediaKind) values[field.name] = s.type === 'array' ? JSON.stringify(Array(Math.max(1, s.minItems ?? 0)).fill('https://input.test/media')) : 'https://input.test/media';
        else if (s.enum) values[field.name] = String(s.enum[0]);
        else if (s.type === 'boolean') values[field.name] = 'false';
        else if (s.type === 'number' || s.type === 'integer') values[field.name] = String(s.minimum ?? 1);
        else if (s.type === 'array') values[field.name] = JSON.stringify(Array(Math.max(1, s.minItems ?? 0)).fill(s.items?.enum?.[0] ?? 'value'));
        else values[field.name] = 'x'.repeat(Math.max(20, s.minLength ?? 0)).slice(0, s.maxLength ?? 200);
      }
      if (model.id.includes('doubao-seed-audio')) delete values.image_url;
      await expect(buildRunningHubModelRequest(connection, model, '测试模型输入的提示词足够长用于验证参数转换', values), model.id).resolves.toBeTypeOf('object');
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('H3 首尾帧、显式覆盖和本地上传按合同执行，数量错误先于上传', async () => {
    const model = getRunningHubModel(ids.video)!;
    await expect(buildRunningHubModelRequest(connection, model, 'test', {}, {
      image: ['blob:first', 'blob:last', 'blob:extra'],
      imageRoles: ['first_frame', 'last_frame', 'reference'],
    })).rejects.toThrow('全部');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    const body = await buildRunningHubModelRequest(connection, model, 'test', { duration: '15', firstFrameUrl: 'blob:override' }, {
      image: ['blob:first', 'blob:override'],
      imageRoles: ['first_frame', 'last_frame'],
    });
    expect(body).toMatchObject({ firstFrameUrl: uploadedUrl('blob:override'), lastFrameUrl: uploadedUrl('blob:override'), duration: '15' });
    expect(mocks.upload).toHaveBeenCalledExactlyOnceWith(connection, 'blob:override', 'image', undefined);
  });
  it('三类外链素材均先上传 RH，同次重复引用复用上传结果并保留顺序', async () => {
    const model = getRunningHubModel('bytedance/seedance-2.0-global/multimodal-video')!;
    const sources = { image: 'https://input.test/person.png', video: 'https://input.test/action.mp4', audio: 'https://input.test/voice.wav' };
    const body = await buildRunningHubModelRequest(connection, model, '使用参考素材生成视频', {}, {
      image: [sources.image, sources.image], video: [sources.video], audio: [sources.audio],
    });
    expect(body).toMatchObject({ imageUrls: [uploadedUrl(sources.image), uploadedUrl(sources.image)], videoUrls: [uploadedUrl(sources.video, 'video')], audioUrls: [uploadedUrl(sources.audio, 'audio')] });
    expect(mocks.upload).toHaveBeenCalledTimes(3);
    for (const mediaKind of ['image', 'video', 'audio'] as const) {
      expect(mocks.upload).toHaveBeenCalledWith(connection, sources[mediaKind], mediaKind, undefined);
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('相同素材在国内和国际连接分别上传，单次请求缓存不跨站共享', async () => {
    const model = getRunningHubModel('vidu/image-to-video-q2-pro')!;
    const source = 'https://input.test/person.png';
    const international = { baseUrl: 'https://www.runninghub.ai', apiKey: 'ai-fixture' };
    for (const target of [connection, international]) {
      await expect(buildRunningHubModelRequest(target, model, '使用参考图片生成视频', {}, { image: [source] }))
        .resolves.toMatchObject({ imageUrl: uploadedUrl(source, 'image', target.baseUrl) });
      expect(mocks.upload).toHaveBeenCalledWith(target, source, 'image', undefined);
    }
    expect(mocks.upload).toHaveBeenCalledTimes(2);
  });
  it('RH 上传失败停止构造请求，不回退直传外链或提交任务', async () => {
    mocks.upload.mockRejectedValueOnce(new Error('上传失败'));
    await expect(buildRunningHubModelRequest(connection, getRunningHubModel('vidu/image-to-video-q2-pro')!, '使用参考图片生成视频', {}, { image: ['https://input.test/person.png'] })).rejects.toThrow('上传失败');
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('RunningHub 首尾帧字段只接受显式角色，普通参考图不会按顺序代填', async () => {
    const model = getRunningHubModel(ids.video)!;
    await expect(buildRunningHubModelRequest(connection, model, 'test', {}, {
      image: ['https://input.test/reference.png'],
      imageRoles: ['reference'],
    })).rejects.toThrow('首帧');
    const referenceModel = getRunningHubModel('vidu/image-to-video-q2-pro')!;
    await expect(buildRunningHubModelRequest(connection, referenceModel, 'test', {}, {
      image: ['https://input.test/reference.png'],
      imageRoles: ['reference'],
    })).resolves.toMatchObject({ imageUrl: uploadedUrl('https://input.test/reference.png') });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('拒绝未知字段、非法 URL、流式和不支持的 Base64 结果模式', async () => {
    await expect(buildRunningHubModelRequest(connection, getRunningHubModel(ids.video)!, 'test', { token: 'secret' })).rejects.toThrow('参数');
    await expect(buildRunningHubModelRequest(connection, getRunningHubModel(ids.video)!, 'test', { firstFrameUrl: 'file:///private' })).rejects.toThrow('素材地址');
    await expect(buildRunningHubModelRequest(connection, getRunningHubModel(ids.audio)!, 'test text', { enable_base64_output: 'true' })).rejects.toThrow('Base64');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('可显式省略有默认值的可选字段，Seedream 自定宽高不会被 resolution 覆盖', async () => {
    const body = await buildRunningHubModelRequest(connection, getRunningHubModel(ids.image)!, '自定义画面尺寸', { width: '960', height: '1440', resolution: '' });
    expect(body).toMatchObject({ width: 960, height: 1440 }); expect(body).not.toHaveProperty('resolution');
  });
  it('网络中断后仅查询原任务，标准模型停止等待不调用工作流取消接口', async () => {
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url, init) => { if (String(url).endsWith('/query')) throw new Error('offline'); return original(url, init); });
    await expect(generate()).rejects.toThrow('连接中断'); expect(pending()[0].taskId).toBe(taskId);
    await expect(generate()).rejects.toThrow('已有');
    await expect(cancelRunningHubNodeTask('n1')).resolves.toBe('local-stopped'); expect(pending()).toHaveLength(1);
    mocks.fetch.mockImplementation(original); await resumeRunningHubNodeTask('n1');
    expect(submitted()).toHaveLength(1); expect(pending()).toEqual([]);
    expect(useAppStore.getState().nodes[0].data.status).toBe('success');
  });
  it('部分批量提交响应丢失保留已知 ID 与未知标记，不重提或丢失确认入口', async () => {
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url, init) => { if (serial === 1 && !String(url).endsWith('/query')) {
      // 进程在响应到达前退出，也必须能从磁盘记录识别未知提交。
      expect(pending()[0]).toMatchObject({ taskIds: [taskId], runninghubSubmissionUncertain: true });
      throw new Error('lost response');
    } return original(url, init); });
    await expect(generate(2)).rejects.toThrow();
    expect(pending()[0]).toMatchObject({ taskIds: [taskId], runninghubSubmissionUncertain: true });
    mocks.fetch.mockImplementation(original); await resumeRunningHubNodeTask('n1');
    expect(useAppStore.getState().nodes[0].data.status).toBe('success'); expect(pending()).toHaveLength(1);
    completeRunningHubNodeTask('n1'); expect(pending()).toHaveLength(1); expect(submitted()).toHaveLength(2);
  });
  it('批量恢复把所有已保存产物回填同组节点，不再次提交或下载本地文件', async () => {
    const original = mocks.fetch.getMockImplementation()!;
    useAppStore.setState((store) => ({ nodes: [
      { ...store.nodes[0], data: { ...store.nodes[0].data, batchGroupId: 'batch' } },
      { ...store.nodes[0], id: 'n2', data: { ...store.nodes[0].data, batchGroupId: 'batch' } },
    ] }));
    mocks.fetch.mockImplementation(async (url, init) => { if (String(url).endsWith('/query')) throw new Error('offline'); return original(url, init); });
    await expect(generate(2)).rejects.toThrow(); expect(pending()[0].taskIds).toHaveLength(2);
    mocks.fetch.mockImplementation(original); await resumeRunningHubNodeTask('n1');
    expect(useAppStore.getState().nodes.map((node) => node.data.status)).toEqual(['success', 'success']);
    expect(mocks.persist).toHaveBeenCalledTimes(2); expect(submitted()).toHaveLength(2); expect(pending()).toEqual([]);
  });
  it('保存失败可重试，模型切换后不把旧任务写入新模型节点', async () => {
    mocks.persist.mockRejectedValueOnce(new Error('disk full'));
    await expect(generate()).rejects.toThrow('disk full'); expect(pending()[0].runninghubRecoveryState).toBe('save_pending');
    useAppStore.getState().updateNodeData('n1', { model: 'runninghub/nanobanana' });
    await resumeRunningHubNodeTask('n1'); expect(pending()).toHaveLength(1); expect(mocks.persist).toHaveBeenCalledTimes(1);
    useAppStore.getState().updateNodeData('n1', { model: ids.image });
    await resumeRunningHubNodeTask('n1'); expect(pending()).toEqual([]); expect(submitted()).toHaveLength(1);
  });
  it('纯对话恢复等待原消息加载并使用模型查询合同', async () => {
    const message = { id: 'm1', conversationId: 'c1', role: 'assistant' as const, content: '', timestamp: 1, status: 'done' as const };
    useAppStore.setState({ nodes: [], messages: [message] });
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url, init) => { if (String(url).endsWith('/query')) throw new Error('offline'); return original(url, init); });
    await expect(executeRunningHubModel({ provider: 'runninghub', model: ids.image, prompt: '测试模型内容', runninghubTaskContext: { projectId: 'p1', conversationId: 'c1', messageId: 'm1', deliveryMode: 'chat' } }, 'image', '测试模型内容', {})).rejects.toThrow(taskId);
    useAppStore.setState({ messages: [] }); mocks.fetch.mockImplementation(original); await resumePendingTasks('p1');
    expect(pending()).toHaveLength(1); useAppStore.setState({ messages: [message] });
    await vi.waitFor(() => expect(useAppStore.getState().messages[0].mediaStatus).toBe('succeeded'));
    expect(pending()).toEqual([]); expect(submitted()).toHaveLength(1); expect(useAppStore.getState().messages[0].mediaResult?.provider).toBe('runninghub');
  });
  it('查询兼容包装响应，批次失败不阻止其余成功任务保存', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ data: { status: 'FAILED' }, code: 200 })).mockResolvedValueOnce(json({ code: 0, data: { status: 'SUCCESS', results: [{ url: 'https://cdn.test/ok.png' }] } }));
    await expect(queryRunningHubModel(connection, [taskId, '2'], 'image')).resolves.toEqual([{ url: 'https://cdn.test/ok.png', kind: 'image' }]);
    expect(parseRunningHubModelOutputs([{ url: 'https://cdn.test/x.mp4' }, { url: 'https://cdn.test/x.png' }, { url: 'javascript:evil' }], 'image')).toHaveLength(1);
  });
});
