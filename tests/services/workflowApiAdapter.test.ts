import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import { createAutodlH3WorkflowManifest } from '../../src/services/workflowApi/autodlWorkflowManifest';
import { generateVideo } from '../../src/services/ai/generateVideo';
import { runMediaGeneration } from '../../src/services/ai/generationRuntime';
import {
  buildWorkflowApiInputs, completeWorkflowApiNodeTask, executeWorkflowApi,
  stopWorkflowApiNodeTask,
} from '../../src/services/workflowApi/workflowApiAdapter';
import {
  cancelNodePolling, getPendingTasksForProject, resumePendingTasks,
  resumeWorkflowApiNodeTask, savePendingTask,
} from '../../src/services/pollManager';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), upload: vi.fn(), persist: vi.fn(), desktop: vi.fn(() => true) }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.fetch }));
vi.mock('../../src/services/uploadService', async (original) => ({
  ...await original<typeof import('../../src/services/uploadService')>(), resolveMediaReferenceUrl: mocks.upload,
}));
vi.mock('../../src/services/fileService', async (original) => ({
  ...await original<typeof import('../../src/services/fileService')>(),
  persistMediaUrlToProjectData: mocks.persist, isTauriEnv: mocks.desktop,
}));

const taskId = '671ce5ca-80b3-4a18-8b5c-af6013f0f03d';
const key = 'test-autodl-secret';
const manifest = () => createAutodlH3WorkflowManifest('autodl-test');
const refs = (image = 1, audio = 0) => ({
  image: Array.from({ length: image }, (_, i) => `https://input.example/${i}.png`),
  audio: Array.from({ length: audio }, (_, i) => `https://input.example/${i}.wav`),
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const pending = () => getPendingTasksForProject('p1');
const submissions = () => mocks.fetch.mock.calls.filter(([, init]) => init.method === 'POST');
let remoteState: string;
let resultItems: unknown[];
const generate = () => executeWorkflowApi({ workflowId: 'wf1', nodeId: 'n1', prompt: '猫在花园里散步', references: refs() });

beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); useAppStore.setState(useAppStore.getInitialState(), true);
  const store = useAppStore.getState();
  useAppStore.setState({
    currentProjectId: 'p1',
    config: { ...store.config, providers: { 'autodl-test': { name: 'AutoDL', apiKey: key, baseUrl: 'https://autodl.art' } } },
    nodes: [{ id: 'n1', type: 'ai-video', position: { x: 0, y: 0 }, data: {
      type: 'ai-video', label: 'H3', workflowId: 'wf1', provider: 'workflow-api', status: 'loading',
    } }],
    workflows: [{ id: 'wf1', name: 'H3', category: 'ai-video', fileName: '', fileContent: '', createdAt: 1,
      adapterType: 'workflow-api', workflowApi: manifest() }],
  });
  remoteState = 'SUCCESS';
  resultItems = [{ url: 'https://cdn.example/result.mp4', type: 'video', file_type: 'mp4', output_type: 'output' }];
  mocks.desktop.mockReturnValue(true);
  mocks.upload.mockReset().mockImplementation(async (_url, options) => `https://cdn.example/upload.${options.kind === 'image' ? 'png' : 'wav'}`);
  mocks.persist.mockReset().mockImplementation(async (url: string) => ({ mediaUrl: 'asset://localhost/result.mp4', sourceUrl: url, filePath: 'project/result.mp4' }));
  mocks.fetch.mockReset().mockImplementation(async (_url: string, init: RequestInit) => init.method === 'POST'
    ? json({ code: 'Success', msg: '', data: { task_id: taskId, status: 'QUEUED' } })
    : json({ code: 'Success', msg: '', data: { task_id: taskId, status: remoteState, results: resultItems } }));
});
afterEach(() => { for (const task of pending()) cancelNodePolling(task.nodeId); cancelNodePolling('n1'); vi.useRealTimers(); });

describe('AutoDL 工作流输入合同', () => {
  it.each([[1, 0], [2, 2], [9, 3]])('%i 图 %i 音频逐字段发送，缺省字段省略', async (images, audio) => {
    const references = refs(images, audio);
    const body = await buildWorkflowApiInputs(manifest(), '猫', {}, references);
    expect(body).toEqual({ prompt: '猫', duration: 5, resolution: '768p竖',
      ...Object.fromEntries(references.image.map((url, i) => [`ref_image_${i}`, url])),
      ...Object.fromEntries(references.audio.map((url, i) => [`ref_audio_${i}`, url])),
    });
    expect(mocks.upload).not.toHaveBeenCalled(); expect(body).not.toHaveProperty('model');
  });
  it.each([
    ['480p', '9:16', '480p竖'], ['768p', '9:16', '768p竖'],
    ['480p', '16:9', '480p横'], ['768p', '16:9', '768p横'],
    ['480p', '1:1', '480p(1:1)'], ['768p', '1:1', '768p(1:1)'],
  ])('映射 %s %s，并保留 seed=0', async (resolution, ratio, expected) => {
    const body = await buildWorkflowApiInputs(manifest(), '猫', { resolution, ratio, seed: 0, duration: 15 }, refs());
    expect(body).toMatchObject({ resolution: expected, seed: 0, duration: 15 });
  });
  it.each([
    { references: refs(0), error: '参考图片' }, { references: refs(10), error: '参考图片' },
    { references: refs(1, 4), error: '参考音频' },
    { references: { ...refs(), video: ['https://input.example/1.mp4'] }, error: '参考视频' },
  ])('拒绝非法素材数量，上传和提交均不发生', async ({ references, error }) => {
    await expect(buildWorkflowApiInputs(manifest(), '猫', {}, references)).rejects.toThrow(error);
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([0, 16, 1.5, NaN])('在上传前拒绝非法时长 %s', async (duration) => {
    await expect(buildWorkflowApiInputs(manifest(), '猫', { duration }, { image: ['asset://localhost/a.png'] })).rejects.toThrow('时长');
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('提示词、枚举、种子及 manifest 均需明确有效', async () => {
    await expect(buildWorkflowApiInputs(manifest(), '', {}, refs())).rejects.toThrow('提示词');
    await expect(buildWorkflowApiInputs(manifest(), '猫'.repeat(10001), {}, refs())).rejects.toThrow('提示词');
    await expect(buildWorkflowApiInputs(manifest(), '猫', { resolution: '1080p' }, refs())).rejects.toThrow('分辨率');
    await expect(buildWorkflowApiInputs(manifest(), '猫', { ratio: '4:3' }, refs())).rejects.toThrow('比例');
    await expect(buildWorkflowApiInputs(manifest(), '猫', { seed: 0.5 }, refs())).rejects.toThrow('种子');
    await expect(buildWorkflowApiInputs({ ...manifest(), workflowId: 'unknown' }, '猫', {}, refs())).rejects.toThrow('工作流');
    await expect(buildWorkflowApiInputs(manifest(), '猫', { duration: null } as never, refs())).rejects.toThrow('时长');
  });
  it('全部本地素材走 publicUrl，保留顺序，取消透传', async () => {
    const signal = new AbortController().signal;
    const body = await buildWorkflowApiInputs(manifest(), '猫', {}, {
      image: ['asset://localhost/a.png', 'https://input.example/b.png'], audio: ['data:audio/wav;base64,YQ=='],
    }, signal);
    expect(body.ref_image_0).toBe('https://cdn.example/upload.png');
    expect(body.ref_image_1).toBe('https://input.example/b.png');
    expect(body.ref_audio_0).toBe('https://cdn.example/upload.wav');
    expect(mocks.upload.mock.calls.map(([, options]) => options)).toEqual([
      { mode: 'publicUrl', provider: 'autodl-test', kind: 'image', signal },
      { mode: 'publicUrl', provider: 'autodl-test', kind: 'audio', signal },
    ]);
  });
  it.each(['http://localhost/a.png', 'http://127.0.0.1/a.png', 'http://192.168.1.2/a.png', 'https://u:p@cdn.example/a.png', 'data:image/gif;base64,YQ=='])('拒绝上游无法安全读取的参考地址 %s', async (url) => {
    await expect(buildWorkflowApiInputs(manifest(), '猫', {}, { image: [url] })).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
  });
});

describe('AutoDL 提交、查询及恢复', () => {
  it('视频入口传入两图两音频，保持模板默认参数且不重复下载', async () => {
    const sources = refs(2, 2);
    const result = await generateVideo({ provider: 'workflow-api', model: 'workflow-api/wf1', workflowId: 'wf1', nodeId: 'n1', prompt: '猫',
      workflowInputs: { seed: '0' }, referenceMedia: [
        ...sources.image.map((url) => ({ kind: 'image' as const, url, origin: 'prompt' as const, role: 'reference' as const })),
        ...sources.audio.map((url) => ({ kind: 'audio' as const, url, origin: 'prompt' as const, role: 'reference_audio' as const })),
      ] });
    expect(result.workflowApiTaskId).toBe(taskId);
    expect(JSON.parse(submissions()[0][1].body)).toMatchObject({ ref_image_0: sources.image[0], ref_image_1: sources.image[1],
      ref_audio_0: sources.audio[0], ref_audio_1: sources.audio[1], duration: 5, resolution: '768p竖', seed: 0 });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });
  it('对话入口复用工作流连接，显式引用素材并保留任务直至回填', async () => {
    useAppStore.setState({ messages: [{ id: 'm1', conversationId: 'c1', role: 'assistant', content: '', timestamp: 1, status: 'done' }],
      nodes: [...useAppStore.getState().nodes, { id: 'a1', type: 'source-audio', position: { x: 0, y: 0 }, data: { type: 'source-audio', label: '音频', audioUrl: 'https://input.example/a.wav' } },
        { id: 'i1', type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', label: '图片', imageUrl: 'https://input.example/i.png' } }] });
    const result = await runMediaGeneration({ kind: 'video', prompt: '@{i1:图片} @{a1:音频} 猫', modelRef: 'workflow-api/wf1', deliveryMode: 'chat', duration: 12, resolution: '480p', aspectRatio: '1:1' },
      'p1', undefined, undefined, { projectId: 'p1', conversationId: 'c1', messageId: 'm1', deliveryMode: 'chat' });
    expect(result).toMatchObject({ provider: 'workflow-api', persistence: 'saved', workflowApiTaskId: taskId });
    expect(JSON.parse(submissions()[0][1].body)).toMatchObject({ duration: 12, resolution: '480p(1:1)', ref_audio_0: 'https://input.example/a.wav' });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    completeWorkflowApiNodeTask('workflow-api-message-m1', taskId); expect(pending()).toEqual([]);
  });
  it('重启后等待原会话消息加载，再恢复查询和消息回填', async () => {
    const context = { projectId: 'p1', conversationId: 'c1', messageId: 'm1', deliveryMode: 'chat' as const };
    const message = { id: 'm1', conversationId: 'c1', role: 'assistant' as const, content: '', timestamp: 1, status: 'done' as const };
    useAppStore.setState({ messages: [message] });
    await executeWorkflowApi({ workflowId: 'wf1', taskContext: context, prompt: '猫', references: refs() });
    useAppStore.setState({ messages: [] }); mocks.fetch.mockClear();
    await resumePendingTasks('p1'); expect(pending()).toHaveLength(1); expect(mocks.fetch).not.toHaveBeenCalled();
    useAppStore.setState({ messages: [message] });
    await vi.waitFor(() => expect(pending()).toEqual([]));
    expect(useAppStore.getState().messages[0]).toMatchObject({ mediaStatus: 'succeeded', mediaResult: { provider: 'workflow-api', url: 'asset://localhost/result.mp4' } });
    expect(submissions()).toHaveLength(0);
  });
  it.each(['SUCCESS', 'completed'])('原始 Token 提交，%s 保存产物后等待调用方确认', async (status) => {
    remoteState = status;
    const outputs = await generate();
    expect(outputs[0]).toMatchObject({ kind: 'video', filePath: 'project/result.mp4' });
    const [url, init] = submissions()[0];
    expect(url).toBe('https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_zm_u24');
    expect(init.headers).toMatchObject({ Authorization: key });
    expect(JSON.parse(init.body)).not.toHaveProperty('model');
    expect(mocks.fetch.mock.calls[1][0]).toBe(`https://autodl.art/api/v1/comfyui/comfyui_workflow/result/${taskId}`);
    expect(pending()[0]).toMatchObject({ taskId, taskType: 'workflow-api', workflowApi: { state: 'save_pending' } });
    expect(JSON.stringify(pending())).not.toContain(key);
    completeWorkflowApiNodeTask('n1', taskId); expect(pending()).toEqual([]);
  });
  it('排队/执行状态后成功，拒绝同时重复提交', async () => {
    remoteState = 'QUEUED'; const running = generate();
    await vi.waitFor(() => expect(pending()[0]?.taskId).toBe(taskId));
    await expect(generate()).rejects.toThrow('已有');
    remoteState = 'RUNNING'; await vi.advanceTimersByTimeAsync(3000);
    remoteState = 'SUCCESS'; await vi.advanceTimersByTimeAsync(3000); await running;
    expect(submissions()).toHaveLength(1);
  });
  it('提交响应丢失保留不确定状态，重启不得再次提交', async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError('offline'));
    await expect(generate()).rejects.toThrow('连接');
    expect(pending()[0]).toMatchObject({ taskId: '', submitted: false, workflowApi: { state: 'submit_unknown' } });
    await resumePendingTasks('p1');
    await expect(generate()).rejects.toThrow('已有'); expect(submissions()).toHaveLength(1);
  });
  it('停止等待与提交响应同时到达，仍保留已返回的任务 ID', async () => {
    mocks.fetch.mockImplementationOnce(async () => {
      stopWorkflowApiNodeTask('n1');
      return json({ code: 'Success', data: { task_id: taskId } });
    });
    await expect(generate()).rejects.toThrow();
    expect(pending()[0]).toMatchObject({ taskId, submitted: true });
    expect(submissions()).toHaveLength(1);
  });
  it('准备本地素材时停止，不提交也不留下不确定任务', async () => {
    mocks.upload.mockImplementationOnce(async (_url, options) => {
      stopWorkflowApiNodeTask('n1'); options.signal.throwIfAborted(); return 'https://input.example/i.png';
    });
    await expect(executeWorkflowApi({ workflowId: 'wf1', nodeId: 'n1', prompt: '猫', references: { image: ['asset://localhost/i.png'] } })).rejects.toThrow();
    expect(submissions()).toHaveLength(0); expect(pending()).toEqual([]);
    expect(useAppStore.getState().nodes[0].data.status).toBe('idle');
  });
  it('旧提交晚到不能覆盖同一节点的新提交记录', async () => {
    mocks.fetch.mockImplementationOnce(async () => {
      const previous = pending()[0];
      savePendingTask({ ...previous, workflowApi: { ...previous.workflowApi!, attemptId: 'new-attempt' } });
      return json({ code: 'Success', data: { task_id: taskId } });
    });
    await expect(generate()).rejects.toThrow('记录已变化');
    expect(pending()[0]).toMatchObject({ taskId: '', submitted: false, workflowApi: { attemptId: 'new-attempt' } });
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it('仅本地停止等待，保留 ID，恢复只查询和保存', async () => {
    remoteState = 'RUNNING'; const running = generate(); const stopped = expect(running).rejects.toThrow();
    await vi.waitFor(() => expect(pending()[0]?.taskId).toBe(taskId));
    stopWorkflowApiNodeTask('n1'); await stopped;
    remoteState = 'SUCCESS'; await resumeWorkflowApiNodeTask('n1');
    expect(submissions()).toHaveLength(1); expect(pending()).toEqual([]);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'success', videoUrl: 'asset://localhost/result.mp4' });
  });
  it('保存失败后恢复保存，不重新提交任务', async () => {
    mocks.persist.mockResolvedValueOnce({ mediaUrl: 'https://cdn.example/result.mp4' });
    await expect(generate()).rejects.toThrow('保存失败');
    expect(pending()[0]?.workflowApi?.state).toBe('save_pending');
    await resumeWorkflowApiNodeTask('n1');
    expect(pending()).toEqual([]); expect(submissions()).toHaveLength(1);
  });
  it('只保存 video/output 产物，成功缺视频结果时保留查询', async () => {
    resultItems = [{ url: 'https://cdn.example/preview.png', type: 'image', output_type: 'output' }];
    await expect(generate()).rejects.toThrow('视频'); expect(pending()[0]?.taskId).toBe(taskId);
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it('查询返回其他任务或未知状态时保留记录，不保存结果', async () => {
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => init.method === 'GET'
      ? json({ code: 'Success', data: { task_id: 'other-task', status: 'SUCCESS', results: resultItems } })
      : original(url, init));
    await expect(generate()).rejects.toThrow('其他任务'); expect(mocks.persist).not.toHaveBeenCalled();
    mocks.fetch.mockImplementation(original); remoteState = 'UNRECOGNIZED';
    await resumeWorkflowApiNodeTask('n1'); expect(pending()).toHaveLength(1);
    expect(useAppStore.getState().nodes[0].data.error).toContain('未知任务状态');
  });
  it('查询最多重试三次瞬时错误，保留任务等待手动恢复', async () => {
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => init.method === 'GET'
      ? json({ msg: '暂时不可用' }, 503) : original(url, init));
    const run = generate(); const failed = expect(run).rejects.toThrow('503');
    await vi.waitFor(() => expect(pending()[0]?.taskId).toBe(taskId));
    await vi.advanceTimersByTimeAsync(9000); await failed;
    expect(mocks.fetch.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(4);
    expect(pending()).toHaveLength(1); expect(submissions()).toHaveLength(1);
  });
  it('FAILED 是远端终态，清理记录；顶层错误信息须脱敏', async () => {
    remoteState = 'FAILED'; await expect(generate()).rejects.toThrow('失败'); expect(pending()).toEqual([]);
    mocks.fetch.mockResolvedValueOnce(json({ code: 'InvalidToken', msg: `无效令牌 ${key}` }));
    const error = await generate().catch((value: unknown) => value);
    expect(String(error)).toContain('无效令牌'); expect(String(error)).not.toContain(key); expect(pending()).toEqual([]);
  });
  it.each([401, 429, 503])('HTTP %i 提交不自动重试', async (status) => {
    mocks.fetch.mockResolvedValueOnce(json({ msg: '服务暂不可用' }, status));
    await expect(generate()).rejects.toThrow(); expect(submissions()).toHaveLength(1);
    expect(pending()).toHaveLength(status === 401 ? 0 : 1);
  });
  it('恢复拒绝连接换站、工作流替换，保留原任务', async () => {
    await generate(); mocks.fetch.mockClear();
    const config = useAppStore.getState().config;
    useAppStore.setState({ config: { ...config, providers: { 'autodl-test': { ...config.providers['autodl-test'], baseUrl: 'https://other.example' } } } });
    await resumeWorkflowApiNodeTask('n1'); expect(mocks.fetch).not.toHaveBeenCalled(); expect(pending()).toHaveLength(1);
    expect(useAppStore.getState().nodes[0].data.error).toContain('连接');
  });
  it('项目切换发生在保存期间时不能回填其他项目', async () => {
    mocks.persist.mockImplementationOnce(async () => {
      useAppStore.setState({ currentProjectId: 'p2' });
      return { mediaUrl: 'asset://localhost/result.mp4', sourceUrl: 'https://cdn.example/result.mp4', filePath: 'p1/result.mp4' };
    });
    await expect(generate()).rejects.toThrow('画布');
    expect(pending()).toHaveLength(1);
    expect(useAppStore.getState().nodes[0].data.videoUrl).toBeUndefined();
  });
});
