import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import { buildRunningHubModelRequest, executeRunningHubModel, parseRunningHubModelOutputs, queryRunningHubModel } from '../../src/services/ai/providers/runninghubMedia';
import { RUNNINGHUB_MODEL_MANIFEST, getRunningHubModel } from '../../src/services/ai/providers/runninghubModelManifest';
import { cancelRunningHubNodeTask, completeRunningHubNodeTask } from '../../src/services/ai/providers/runninghubWorkflow';
import { cancelNodePolling, getPendingTasksForProject, resumeRunningHubNodeTask, resumePendingTasks } from '../../src/services/pollManager';
import type { RunningHubMediaKind } from '../../src/types/runninghub';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), persist: vi.fn() }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.fetch }));
vi.mock('../../src/services/fileService', async (original) => ({ ...await original<typeof import('../../src/services/fileService')>(), persistMediaUrlToProjectData: mocks.persist, isTauriEnv: () => true }));
const connection = { apiKey: 'fake-secret', baseUrl: 'https://www.runninghub.cn' };
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
  useAppStore.setState({ currentProjectId: 'p1', config: { ...useAppStore.getState().config, providers: { 'runninghub-model': { name: 'RH', apiKey: connection.apiKey } } },
    nodes: [{ id: 'n1', type: `ai-${kind}`, position: { x: 0, y: 0 }, data: { type: `ai-${kind}`, label: '模型测试', provider: 'runninghub', model: ids[kind], status: 'loading' } }],
  });
}
const generate = (count = 1) => executeRunningHubModel({ provider: 'runninghub', model: ids[kind], prompt: '测试模型生成内容', nodeId: 'n1' }, kind, '测试模型生成内容', kind === 'video' ? { image: ['https://input.test/first.png'] } : {}, count);
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); useAppStore.setState(useAppStore.getInitialState(), true); setup(); state = 'SUCCESS'; serial = 0;
  mocks.persist.mockReset().mockImplementation(async (url: string) => ({ filePath: `project/${url.split('/').pop()}`, mediaUrl: `asset://localhost/${url.split('/').pop()}`, sourceUrl: url }));
  mocks.fetch.mockReset().mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith('/query')) return json({ taskId, status: state, results: [{ url: `https://cdn.test/${JSON.parse(String(init.body)).taskId}.${{ image: 'png', video: 'mp4', audio: 'wav' }[kind]}` }] });
    if (url.endsWith('/upload/binary')) return json({ code: 200, data: { filename: 'rh/ref.png', download_url: 'https://cdn.test/upload.png' } });
    return new Response(`{"taskId":${BigInt(taskId) + BigInt(serial++)},"status":"QUEUED"}`);
  });
});
afterEach(() => { cancelNodePolling('n1'); cancelNodePolling('runninghub-message-m1'); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('RunningHub 标准媒体执行', () => {
  it.each(['image', 'video', 'audio'] as const)('%s 使用模型端点及 v2/query，保留长 ID 与所有已保存产物', async (value) => {
    setup(value); const result = await generate();
    expect(result[0].filePath).toBeTruthy();
    expect(submitted()[0][0]).toBe(`${connection.baseUrl}/openapi/v2/${ids[value]}`);
    expect(submitted()[0][1].headers.Authorization).toBe(`Bearer ${connection.apiKey}`);
    const body = JSON.parse(submitted()[0][1].body as string);
    expect(body.apiKey).toBeUndefined();
    if (value === 'video') expect(body).toMatchObject({ firstFrameUrl: 'https://input.test/first.png', duration: '5', resolution: '768p' });
    expect(pending()[0]).toMatchObject({ taskId, taskType: 'runninghub-model', runninghubModelId: ids[value], runninghubRecoveryState: 'save_pending' });
    expect(JSON.stringify(pending())).not.toContain(connection.apiKey);
    completeRunningHubNodeTask('n1'); expect(pending()).toEqual([]);
  });
  it('全部目录操作通过本地类型转换，不发送付费请求', async () => {
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
    await expect(buildRunningHubModelRequest(connection, model, 'test', {}, { image: ['blob:first', 'blob:last', 'blob:extra'] })).rejects.toThrow('全部');
    expect(mocks.fetch).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('image', { headers: { 'Content-Type': 'image/png' } })));
    const body = await buildRunningHubModelRequest(connection, model, 'test', { duration: '15', firstFrameUrl: 'blob:override' }, { image: ['blob:first', 'blob:override'] });
    expect(body).toMatchObject({ firstFrameUrl: 'https://cdn.test/upload.png', lastFrameUrl: 'https://cdn.test/upload.png', duration: '15' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
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
