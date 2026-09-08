import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import { buildRunningHubInputs, cancelRunningHubNodeTask, completeRunningHubNodeTask, executeRunningHubWorkflow, parseRunningHubOutputs } from '../../src/services/ai/providers/runninghubWorkflow';
import { cancelNodePolling, getPendingTasksForProject, resumePendingTasks, resumeRunningHubNodeTask, savePendingTask } from '../../src/services/pollManager';
import { uploadRunningHubMedia } from '../../src/services/ai/providers/runninghubClient';
import type { RunningHubMediaKind, RunningHubWorkflowManifest } from '../../src/types/runninghub';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), persist: vi.fn(), desktop: vi.fn(() => true) }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.fetch }));
vi.mock('../../src/services/fileService', async (original) => ({ ...await original<typeof import('../../src/services/fileService')>(), persistMediaUrlToProjectData: mocks.persist, isTauriEnv: mocks.desktop }));
const connection = { apiKey: 'test-secret', baseUrl: 'https://www.runninghub.cn' };
const taskId = '1904152026220003329';
const manifest: RunningHubWorkflowManifest = { version: 1, kind: 'workflow', remoteId: '1900000000000000001', connectionId: 'runninghub', parameters: [
  { nodeId: '6', fieldName: 'text', label: '提示词', type: 'string', defaultValue: '', source: 'prompt', required: true },
  { nodeId: '3', fieldName: 'seed', label: '种子', type: 'number', defaultValue: 1, source: 'value' },
  { nodeId: '3', fieldName: 'enabled', label: '开关', type: 'boolean', defaultValue: true, source: 'value' },
] };
const pending = () => getPendingTasksForProject('p1');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const submitCalls = () => mocks.fetch.mock.calls.filter(([url]) => /\/(create|run)$/.test(String(url)));
let state = 'SUCCESS';
let outputs: Array<{ fileUrl: string; fileType: string; nodeId: string }>;

function setup(kind: RunningHubMediaKind = 'image') {
  const store = useAppStore.getState();
  useAppStore.setState({ currentProjectId: 'p1', config: { ...store.config, providers: { runninghub: { name: 'RH', apiKey: connection.apiKey } } },
    nodes: [{ id: 'n1', type: `ai-${kind}`, position: { x: 0, y: 0 }, data: { type: `ai-${kind}`, label: '测试云工作流', provider: 'runninghubwf', model: 'runninghubwf/wf1', workflowId: 'wf1', status: 'loading' } }],
    workflows: [{ id: 'wf1', name: '测试云工作流', category: `ai-${kind}`, createdAt: 1, fileContent: '', fileName: 'RH', adapterType: 'runninghub', runninghub: manifest }],
  });
  outputs = [{ fileUrl: `https://cdn.test/result.${{ image: 'png', video: 'mp4', audio: 'wav' }[kind]}`, fileType: kind, nodeId: '9' }];
}
const generate = (kind: RunningHubMediaKind = 'image') => executeRunningHubWorkflow({ workflowId: 'wf1', prompt: '猫', kind, nodeId: 'n1', workflowInputs: { '3::seed': '0', '3::enabled': 'false' } });
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); useAppStore.setState(useAppStore.getInitialState(), true); setup(); state = 'SUCCESS';
  mocks.desktop.mockReturnValue(true);
  mocks.persist.mockReset().mockImplementation(async (url: string) => ({ filePath: `project/${url.split('/').pop()}`, mediaUrl: `asset://localhost/${url.split('/').pop()}`, sourceUrl: url }));
  mocks.fetch.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith('/create') || url.endsWith('/run')) return new Response(`{"code":0,"data":{"taskId":${taskId}}}`);
    if (url.endsWith('/status')) return json({ code: 0, data: state });
    if (url.endsWith('/outputs')) return json({ code: 0, data: outputs });
    if (url.endsWith('/cancel')) return json({ code: 0, data: null });
    if (url.endsWith('/upload/binary')) return json({ code: 200, data: { filename: 'rh/reference.png', download_url: 'https://cdn.test/upload.png' } });
    if (url.startsWith('https://input.test')) return new Response('media', { headers: { 'Content-Type': `image/png` } });
    throw new Error('Unexpected test request');
  });
});
afterEach(() => { cancelNodePolling('n1'); cancelNodePolling('runninghub-message-m1'); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('RunningHub 云任务生命周期', () => {
  it('纯对话调用中断后按原消息恢复，不创建画布节点或重复提交', async () => {
    const message = { id: 'm1', conversationId: 'c1', role: 'assistant' as const, content: '', timestamp: 1, status: 'done' as const };
    useAppStore.setState({ nodes: [], messages: [message] });
    const originalFetch = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/status')) throw new Error('offline');
      return originalFetch(url, init);
    });
    await expect(executeRunningHubWorkflow({ workflowId: 'wf1', prompt: '猫', kind: 'image', runninghubTaskContext: { projectId: 'p1', conversationId: 'c1', messageId: 'm1', deliveryMode: 'chat' } })).rejects.toThrow(taskId);
    expect(pending()[0]).toMatchObject({ nodeId: 'runninghub-message-m1', runninghubMessage: { messageId: 'm1', conversationId: 'c1' }, taskId });
    mocks.fetch.mockImplementation(originalFetch);
    useAppStore.setState({ messages: [] });
    await resumePendingTasks('p1');
    expect(pending()).toHaveLength(1);
    useAppStore.setState({ messages: [message] });
    await vi.waitFor(() => expect(useAppStore.getState().messages[0].mediaStatus).toBe('succeeded'));
    expect(useAppStore.getState().nodes).toEqual([]); expect(submitCalls()).toHaveLength(1); expect(pending()).toEqual([]);
    expect(useAppStore.getState().messages[0].mediaResult).toMatchObject({ kind: 'image', provider: 'runninghubwf', persistence: 'saved' });
  });
  it.each(['image', 'video', 'audio'] as const)('%s 提交保持类型并保存全部同类型产物', async (kind) => {
    setup(kind); outputs.push({ ...outputs[0], fileUrl: 'https://cdn.test/second' });
    const result = await generate(kind);
    expect(result).toHaveLength(2); expect(result[0].filePath).toBeTruthy(); expect(mocks.persist).toHaveBeenCalledTimes(2);
    const body = JSON.parse(submitCalls()[0][1].body as string);
    expect(body).toMatchObject({ workflowId: manifest.remoteId, apiKey: connection.apiKey, nodeInfoList: [{ fieldValue: '猫' }, { fieldValue: 0 }, { fieldValue: false }] });
    expect(pending()[0]).toMatchObject({ taskId, runninghubRecoveryState: 'save_pending' });
    expect(JSON.stringify(pending())).not.toContain(connection.apiKey);
    completeRunningHubNodeTask('n1'); expect(pending()).toEqual([]);
  });
  it('画布先恢复、原对话后加载时同步同一产物，不重复保存或写入其他会话', async () => {
    savePendingTask({ nodeId: 'n1', projectId: 'p1', taskId, taskType: 'runninghub-workflow', provider: 'runninghubwf', nodeType: 'ai-image', submitted: true, runninghubWorkflowId: 'wf1', runninghubMessage: { projectId: 'p1', conversationId: 'c1', messageId: 'm1', deliveryMode: 'both' } });
    await resumeRunningHubNodeTask('n1');
    expect(useAppStore.getState().nodes[0].data.status).toBe('success'); expect(pending()).toHaveLength(1);
    const other = { id: 'm2', conversationId: 'c2', role: 'assistant' as const, content: '', timestamp: 1, status: 'done' as const };
    useAppStore.setState({ messages: [other] });
    expect(useAppStore.getState().messages[0].mediaStatus).toBeUndefined();
    useAppStore.setState({ messages: [other, { ...other, id: 'm1', conversationId: 'c1' }] });
    await vi.waitFor(() => expect(useAppStore.getState().messages[1].mediaStatus).toBe('succeeded'));
    expect(useAppStore.getState().messages[1]).toMatchObject({ canvasStatus: 'created', canvasNodeId: 'n1' });
    expect(mocks.persist).toHaveBeenCalledTimes(1); expect(submitCalls()).toHaveLength(0); expect(pending()).toEqual([]);
  });
  it('AI 应用使用 webappId 且不添加工作流专属字段', async () => {
    useAppStore.setState({ workflows: useAppStore.getState().workflows.map((wf) => ({ ...wf, runninghub: { ...manifest, kind: 'app' } })) });
    await generate(); const [url, init] = submitCalls()[0]; const body = JSON.parse(init.body as string);
    expect(url).toContain('/ai-app/run'); expect(body.webappId).toBe(manifest.remoteId); expect(body.workflowId).toBeUndefined(); expect(body.addMetadata).toBeUndefined();
  });
  it('排队后继续查询，网络中断保留 ID；恢复不会再次付费提交', async () => {
    state = 'QUEUED'; const running = generate();
    await vi.waitFor(() => expect(pending()[0]?.taskId).toBe(taskId));
    expect(useAppStore.getState().nodes[0].data.runninghubStage).toBe('排队中');
    state = 'RUNNING'; await vi.advanceTimersByTimeAsync(3000);
    mocks.fetch.mockRejectedValueOnce(new TypeError('offline'));
    const failure = expect(running).rejects.toThrow('连接中断'); await vi.advanceTimersByTimeAsync(3000); await failure;
    expect(pending()[0].taskId).toBe(taskId); await expect(generate()).rejects.toThrow('已有');
    state = 'SUCCESS'; await resumeRunningHubNodeTask('n1');
    expect(submitCalls()).toHaveLength(1); expect(pending()).toEqual([]); expect(useAppStore.getState().nodes[0].data.status).toBe('success');
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });
  it('明确失败清除记录并显示失败状态', async () => {
    savePendingTask({ nodeId: 'n1', projectId: 'p1', taskId, taskType: 'runninghub-workflow', provider: 'runninghubwf', nodeType: 'ai-image', submitted: true });
    state = 'FAILED'; await resumeRunningHubNodeTask('n1');
    expect(pending()).toEqual([]); expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'error', error: 'RunningHub 任务执行失败' });
  });
  it('提交响应丢失时保留不确定状态，重启也不能自动重提', async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError('connection lost'));
    await expect(generate()).rejects.toThrow();
    expect(pending()[0]).toMatchObject({ taskId: '', runninghubRecoveryState: 'submit_unknown' });
    await resumePendingTasks('p1'); await expect(generate()).rejects.toThrow('已有');
    expect(submitCalls()).toHaveLength(1); expect(pending()).toHaveLength(1);
  });
  it('保存失败可恢复保存，切换项目或修改画布不会回写旧结果', async () => {
    mocks.persist.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(generate()).rejects.toThrow('disk unavailable'); expect(pending()[0].runninghubRecoveryState).toBe('save_pending');
    mocks.persist.mockImplementationOnce(async () => { useAppStore.setState({ currentProjectId: 'p2' }); return { filePath: 'project/result', mediaUrl: 'asset://result', sourceUrl: 'https://cdn.test/result' }; });
    await resumeRunningHubNodeTask('n1'); expect(pending()).toHaveLength(1); expect(useAppStore.getState().nodes[0].data.status).not.toBe('success');
    useAppStore.setState({ currentProjectId: 'p1' }); await resumeRunningHubNodeTask('n1'); expect(pending()).toEqual([]); expect(submitCalls()).toHaveLength(1);
  });
  it('取消必须等待远端终态，成功完成的任务保留产物保存入口', async () => {
    savePendingTask({ nodeId: 'n1', projectId: 'p1', taskId, taskType: 'runninghub-workflow', provider: 'runninghubwf', nodeType: 'ai-image', submitted: true });
    state = 'RUNNING'; await expect(cancelRunningHubNodeTask('n1')).rejects.toThrow('尚未确认'); expect(pending()[0].runninghubRecoveryState).toBe('cancel_pending');
    state = 'SUCCESS'; await expect(cancelRunningHubNodeTask('n1')).rejects.toThrow('保存产物'); expect(pending()[0].runninghubRecoveryState).toBe('save_pending');
    state = 'CANCELED'; await expect(cancelRunningHubNodeTask('n1')).resolves.toBe('cancelled'); expect(pending()).toEqual([]);
  });
  it('上传复用同一素材，按字段分别传文件名和 URL，不走第三方图床', async () => {
    const mediaManifest: RunningHubWorkflowManifest = { ...manifest, parameters: [
      { nodeId: '1', fieldName: 'image', type: 'string', defaultValue: '', source: 'image', label: '图片', mediaFormat: 'filename', required: true },
      { nodeId: '2', fieldName: 'image', type: 'string', defaultValue: '', source: 'image', label: '图片URL', mediaFormat: 'url', required: true },
    ] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('png', { headers: { 'Content-Type': 'image/png' } })));
    const fields = await buildRunningHubInputs(connection, mediaManifest, '', {}, { image: ['blob:reference'] });
    expect(fields.map((field) => field.fieldValue)).toEqual(['rh/reference.png', 'https://cdn.test/upload.png']);
    expect(mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith('/upload/binary'))).toHaveLength(1);
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-secret');
    expect(mocks.fetch.mock.calls[0][1].body).toBeInstanceOf(FormData);
  });
  it.each(['video', 'audio'] as const)('%s 素材使用相应 MIME 上传，错误类型拒绝', async (kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('media', { headers: { 'Content-Type': `${kind}/${kind === 'video' ? 'mp4' : 'wav'}` } })).mockResolvedValueOnce(new Response('image', { headers: { 'Content-Type': 'image/png' } })));
    await expect(uploadRunningHubMedia(connection, 'blob:reference', kind)).resolves.toHaveProperty('filename');
    await expect(uploadRunningHubMedia(connection, 'blob:wrong', kind)).rejects.toThrow('类型');
  });
  it('过滤输出类型与节点，拒绝不安全或空结果', () => {
    expect(parseRunningHubOutputs([...outputs, { fileUrl: 'https://cdn.test/out.mp4', fileType: 'mp4', nodeId: '10' }], 'image', ['9'])).toHaveLength(1);
    expect(() => parseRunningHubOutputs(outputs, 'image', ['10'])).toThrow('未找到');
    expect(() => parseRunningHubOutputs([{ fileUrl: 'javascript:alert(1)', fileType: 'image' }], 'image')).toThrow();
  });
});
