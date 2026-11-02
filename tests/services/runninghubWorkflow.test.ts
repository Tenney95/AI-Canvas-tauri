/**
 * runninghubWorkflow — 回归测试：RunningHub 云任务生命周期。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import { buildRunningHubInputs, cancelRunningHubNodeTask, completeRunningHubNodeTask, executeRunningHubWorkflow, parseRunningHubOutputs } from '../../src/services/ai/providers/runninghubWorkflow';
import { abandonHistoryMediaDownload, cancelNodePolling, getPendingTasksForProject, retryHistoryMediaDownload, resumePendingTasks, resumeRunningHubNodeTask, savePendingTask } from '../../src/services/pollManager';
import { uploadRunningHubMedia } from '../../src/services/ai/providers/runninghubClient';
import { fetchRunningHubDefinition } from '../../src/services/runninghubWorkflowService';
import { buildRunningHubSiteProviders } from '../../src/services/runninghubSiteCredentials';
import type { RunningHubMediaKind, RunningHubWorkflowManifest } from '../../src/types/runninghub';
import type { RunningHubInputRouting } from '../../src/services/ai/providers/runninghubWorkflowInputs';
import { getSlashCommands, fillTemplate } from '../../src/components/nodes/shared/slashCommands';
import { WORKFLOW_RANDOM_SEED } from '../../src/services/workflowSeed';
import { historyMediaTaskReceipt } from '../../src/services/historyMediaRecovery';

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

describe('RH 默认输入与显式输入的提交映射', () => {
  it('新请求的种子默认分别随机，固定值和零稳定，随机标记不会上传到平台', async () => {
    const definition: RunningHubWorkflowManifest = { version: 1, kind: 'workflow', remoteId: manifest.remoteId, connectionId: 'runninghub',
      parameters: ['202', '235'].map((nodeId) => ({ nodeId, fieldName: 'seed', label: 'K采样器 · SEED', type: 'number',
        defaultValue: 42, source: 'value', min: 0, max: 99 })) };
    const snapshot = structuredClone(definition);
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValueOnce(0.2).mockReturnValueOnce(0.3).mockReturnValueOnce(0.4);
    try {
      const first = await buildRunningHubInputs(connection, definition, '正文');
      const second = await buildRunningHubInputs(connection, definition, '正文');
      expect(first.map((field) => field.fieldValue)).toEqual([10, 20]);
      expect(second.map((field) => field.fieldValue)).toEqual([30, 40]);
      random.mockClear();
      const fixed = await buildRunningHubInputs(connection, definition, '正文', { '202::seed': '0', '235::seed': '42' });
      expect(fixed.map((field) => field.fieldValue)).toEqual([0, 42]); expect(random).not.toHaveBeenCalled();
      random.mockReturnValue(0.5);
      const marked = await buildRunningHubInputs(connection, definition, '正文', { '202::seed': WORKFLOW_RANDOM_SEED });
      expect(marked[0].fieldValue).toBe(50);
      expect(definition).toEqual(snapshot);
      await expect(buildRunningHubInputs(connection, definition, '正文', { '202::seed': '9007199254740993' })).rejects.toThrow('安全整数');
    } finally { random.mockRestore(); }
  });

  const routed = (): RunningHubInputRouting => ({ nodeMode: true, bindings: new Map(), mentionedTypes: new Set(), defaults: { prompt: '6::text', image: '9::first' } });
  const withImages: RunningHubWorkflowManifest = { ...manifest, parameters: [...manifest.parameters,
    { nodeId: '9', fieldName: 'first', label: '首帧', type: 'string', defaultValue: '', source: 'image' },
    { nodeId: '9', fieldName: 'last', label: '尾帧', type: 'string', defaultValue: '', source: 'image' },
  ] };
  it('人物快捷指令与输入框正文合并写入默认字符串节点，引用图单独上传且负面词保留', async () => {
    setup();
    const definition: RunningHubWorkflowManifest = { ...manifest, inputBindingMode: 'nodes', parameters: [
      { nodeId: '714', fieldName: 'value', label: '字符串（多行） · value', type: 'string', defaultValue: '原始场景描述', source: 'value' },
      { nodeId: '232', fieldName: 'text', label: 'CLIP文本编码器 · text', type: 'string', defaultValue: '原负面提示词', source: 'value', inputType: 'prompt' },
      { nodeId: '807', fieldName: 'image', label: '参考图片（可选）', type: 'string', defaultValue: '', source: 'image' },
    ] };
    const before = useAppStore.getState();
    useAppStore.setState({
      nodes: [...before.nodes, { id: 'ref-image', type: 'ai-image', position: { x: 0, y: 0 },
        data: { type: 'ai-image', label: '人物参考', imageUrl: 'https://input.test/character.png', status: 'success' } }],
      workflows: [{ ...before.workflows[0], runninghub: definition, defaultNodes: { prompt: '714::value', image: '807::image' } }],
    });
    const command = getSlashCommands('ai-image').flatMap((item) => item.children ?? [item])
      .find((item) => item.id === 'char-three-view-face')!;
    const filled = fillTemplate(command.promptTemplate!, '@{ref-image:人物参考}\n银发角色，穿蓝色长袍');
    await (await import('../../src/services/ai/generateImage')).generateImage({
      provider: 'runninghubwf', model: 'runninghubwf/wf1', workflowId: 'wf1', nodeId: 'n1', prompt: filled,
    });
    expect(submitCalls()).toHaveLength(1);
    const body = JSON.parse(String(submitCalls()[0][1].body));
    const inputs = body.nodeInfoList as Array<{ nodeId: string; fieldName: string; fieldValue: string }>;
    const prompt = inputs.find((field) => field.nodeId === '714' && field.fieldName === 'value')!.fieldValue;
    expect(prompt).toContain('上二下三的两排布局');
    expect(prompt).toContain('银发角色，穿蓝色长袍');
    expect(prompt).not.toContain('原始场景描述');
    expect(prompt).not.toContain('@{');
    expect(inputs.find((field) => field.nodeId === '232')?.fieldValue).toBe('原负面提示词');
    expect(inputs.find((field) => field.nodeId === '807')?.fieldValue).toBe('rh/reference.png');
    expect(definition.parameters[0]).not.toHaveProperty('inputType');
    expect(useAppStore.getState().workflows[0].defaultNodes).toEqual({ prompt: '714::value', image: '807::image' });
  });
  it.each(['image', 'video', 'audio'] as const)('%s 生成入口剥离芯片正文并把字段赋值交给共享执行器', async (kind) => {
    setup(kind);
    const store = useAppStore.getState();
    useAppStore.setState({ workflows: store.workflows.map((workflow) => ({ ...workflow,
      runninghub: { ...workflow.runninghub!, inputBindingMode: 'nodes' }, defaultNodes: { prompt: '6::text' },
    })) });
    const params = { provider: 'runninghubwf', model: 'runninghubwf/wf1', workflowId: 'wf1', nodeId: 'n1',
      prompt: '外层说明 @wf{6::text|正文|prompt}(本轮独立正文)' };
    if (kind === 'image') await (await import('../../src/services/ai/generateImage')).generateImage(params);
    else if (kind === 'video') await (await import('../../src/services/ai/generateVideo')).generateVideo(params);
    else await (await import('../../src/services/ai/generateAudio')).generateAudio(params);
    expect(submitCalls()).toHaveLength(1);
    const body = JSON.parse(String(submitCalls()[0][1].body));
    expect(body.nodeInfoList.find((field: { nodeId: string; fieldName: string }) => field.nodeId === '6' && field.fieldName === 'text').fieldValue).toBe('本轮独立正文');
    expect(JSON.stringify(body)).not.toContain('@wf');
  });
  it('正文仅写入默认字段，固定 0/false 不受影响，无默认槽不偷偷注入', async () => {
    const result = await buildRunningHubInputs(connection, manifest, '主正文', { '3::seed': '0', '3::enabled': 'false' }, {}, undefined, routed());
    expect(result).toEqual([{ nodeId: '6', fieldName: 'text', fieldValue: '主正文' }, { nodeId: '3', fieldName: 'seed', fieldValue: 0 }, { nodeId: '3', fieldName: 'enabled', fieldValue: false }]);
    await expect(buildRunningHubInputs(connection, manifest, '主正文', {}, {}, undefined, { ...routed(), defaults: {} })).rejects.toThrow('请填写');
  });
  it('未绑定的 API 文本候选保留负面词，指定后只覆盖该字段', async () => {
    const definition: RunningHubWorkflowManifest = { ...manifest, parameters: [...manifest.parameters,
      { nodeId: '7', fieldName: 'text', label: '负面提示词', type: 'string', defaultValue: '原负面词', source: 'value', inputType: 'prompt' },
    ] };
    const routing = routed();
    const result = await buildRunningHubInputs(connection, definition, '主正文', {}, {}, undefined, routing);
    expect(result.find((field) => field.nodeId === '7')?.fieldValue).toBe('原负面词');
    routing.bindings.set('7::text', { value: '新负面词' });
    routing.mentionedTypes.add('prompt');
    routing.bindings.set('6::text', { value: '明确正文' });
    const assigned = await buildRunningHubInputs(connection, definition, '主正文', {}, {}, undefined, routing);
    expect(assigned.find((field) => field.nodeId === '7')?.fieldValue).toBe('新负面词');
    expect(assigned.find((field) => field.nodeId === '6')?.fieldValue).toBe('明确正文');
  });
  it('显式指定尾帧后不把同类素材填入默认首帧；同素材多槽仅上传一次', async () => {
    const routing = routed();
    routing.bindings.set('9::last', { value: '', mediaSource: 'https://input.test/a.png' });
    routing.mentionedTypes.add('image');
    const first = await buildRunningHubInputs(connection, withImages, '主正文', {}, { image: ['https://input.test/unused.png'] }, undefined, routing);
    expect(first.find((field) => field.fieldName === 'first')?.fieldValue).toBe('');
    expect(first.find((field) => field.fieldName === 'last')?.fieldValue).toBe('rh/reference.png');
    mocks.fetch.mockClear();
    routing.bindings.set('9::first', { value: '', mediaSource: 'https://input.test/a.png' });
    await buildRunningHubInputs(connection, withImages, '主正文', {}, {}, undefined, routing);
    expect(mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith('/upload/binary'))).toHaveLength(1);
  });
  it('默认单素材槽拒绝多份素材，错误发生在上传和生成之前', async () => {
    await expect(buildRunningHubInputs(connection, withImages, '主正文', {}, { image: ['https://input.test/a.png', 'https://input.test/b.png'] }, undefined, routed())).rejects.toThrow('只能接收一份');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
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
  it('历史重新下载只续取原任务，成功更新同一条历史；旧回执不能操作新尝试', async () => {
    mocks.persist.mockRejectedValueOnce(Object.assign(new Error('生成媒体未能写入项目目录：下载媒体失败'), { name: 'MediaPersistenceError' }));
    await expect(generate()).rejects.toThrow('下载媒体失败');
    const receipt = historyMediaTaskReceipt(pending()[0]);
    await useAppStore.getState().recordOutputHistory('n1', { nodeId: 'n1', nodeLabel: '测试云工作流', nodeType: 'ai-image',
      timestamp: 10, prompt: '原提示词', output: '', model: 'runninghubwf/wf1', provider: 'runninghubwf',
      status: 'download_pending', recoveryTask: receipt, error: '下载失败' });
    const original = useAppStore.getState().outputHistoryRecords[0];
    await expect(retryHistoryMediaDownload({ ...receipt, attemptId: 'other-attempt' })).rejects.toThrow('原下载任务已变化');
    await retryHistoryMediaDownload(receipt);
    const recovered = useAppStore.getState().outputHistoryRecords.find((entry) => entry.id === original.id);
    expect(recovered).toMatchObject({ status: 'success', timestamp: 10, prompt: '原提示词' });
    expect(recovered?.filePath).toBeTruthy(); expect(pending()).toEqual([]);
    expect(submitCalls()).toHaveLength(1);
    expect(useAppStore.getState().outputHistoryRecords.filter((entry) => entry.id === original.id)).toHaveLength(1);
  });
  it('再次下载失败仍保留原任务，放弃不发取消、不重新生成或清除旧媒体', async () => {
    mocks.persist.mockRejectedValue(Object.assign(new Error('生成媒体未能写入项目目录：下载媒体失败'), { name: 'MediaPersistenceError' }));
    await expect(generate()).rejects.toThrow('下载媒体失败');
    const receipt = historyMediaTaskReceipt(pending()[0]);
    await expect(retryHistoryMediaDownload(receipt)).rejects.toThrow('下载尚未完成');
    expect(pending()[0].attemptId).toBe(receipt.attemptId);
    useAppStore.getState().updateNodeDataTransient('n1', { imageUrl: 'asset://old-result', filePath: 'old-result.png' });
    abandonHistoryMediaDownload(receipt);
    expect(pending()).toEqual([]); expect(submitCalls()).toHaveLength(1);
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ imageUrl: 'asset://old-result', filePath: 'old-result.png' });
    const next = savePendingTask({ ...receipt, attemptId: 'next-attempt', submitted: true, nodeType: 'ai-image', provider: 'runninghubwf',
      taskType: 'runninghub-workflow', runninghubWorkflowId: 'wf1', runninghubRecoveryState: 'save_pending' });
    abandonHistoryMediaDownload(receipt);
    expect(pending()[0].attemptId).toBe(next.attemptId);
  });

  it('国际站应用定义使用指定站点、密钥和完整字符串 ID', async () => {
    const remoteId = '2108920489564520450';
    mocks.fetch.mockResolvedValueOnce(json({ code: 0, data: { nodeInfoList: [] } }));
    const definition = await fetchRunningHubDefinition({ ...connection, baseUrl: 'https://www.runninghub.ai' },
      { kind: 'app', remoteId: `https://www.runninghub.ai/zh-cn/ai-detail/${remoteId}`, connectionId: 'runninghub' });
    const [address, init] = mocks.fetch.mock.calls[0];
    const url = new URL(address);
    expect(url.origin).toBe('https://www.runninghub.ai');
    expect(url.pathname).toBe('/api/webapp/apiCallDemo');
    expect(url.searchParams.get('webappId')).toBe(remoteId);
    expect(url.searchParams.get('apiKey')).toBe(connection.apiKey);
    expect(init).toMatchObject({ method: 'GET' });
    expect(definition.remoteId).toBe(remoteId);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('定义读取返回 901 时保留错误，不把密钥改投另一站点', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ code: 901, msg: 'WEBAPP_NOT_EXISTS' }));
    await expect(fetchRunningHubDefinition({ ...connection, baseUrl: 'https://www.runninghub.ai' },
      { kind: 'app', remoteId: '2108920489564520450', connectionId: 'runninghub' })).rejects.toThrow('业务码 901');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(new URL(mocks.fetch.mock.calls[0][0]).origin).toBe('https://www.runninghub.ai');
  });

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
    expect(pending()[0]).toMatchObject({ taskId, runninghubSite: 'cn', runninghubRecoveryState: 'save_pending' });
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
  it('AI 应用提交兼容业务码 200，仍须取得有效任务 ID', async () => {
    useAppStore.setState({ workflows: useAppStore.getState().workflows.map((wf) => ({ ...wf, runninghub: { ...manifest, kind: 'app' } })) });
    const originalFetch = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) =>
      String(url).endsWith('/ai-app/run') ? json({ code: 200, data: { taskId } }) : originalFetch(url, init));
    await expect(generate()).resolves.toHaveLength(1);
    expect(pending()[0]).toMatchObject({ taskId, runninghubRecoveryState: 'save_pending' });

    completeRunningHubNodeTask('n1');
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) =>
      String(url).endsWith('/ai-app/run') ? json({ code: 200, data: {} }) : originalFetch(url, init));
    await expect(generate()).rejects.toThrow('未返回有效任务 ID');
    expect(pending()[0]).toMatchObject({ taskId: '', runninghubRecoveryState: 'submit_unknown' });
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
  it('切换当前站点后仍使用任务原站点和凭据取消', async () => {
    const store = useAppStore.getState();
    useAppStore.setState({ config: { ...store.config, providers: buildRunningHubSiteProviders({},
      { name: 'RH', apiKey: '', baseUrl: 'https://www.runninghub.ai/openapi/v2' },
      { cn: { modelKey: '', workflowKey: 'original-cn-fixture' }, ai: { modelKey: '', workflowKey: 'current-ai-fixture' } }) } });
    savePendingTask({ nodeId: 'n1', projectId: 'p1', taskId, taskType: 'runninghub-workflow', provider: 'runninghubwf', nodeType: 'ai-image', submitted: true, runninghubSite: 'cn' });
    state = 'CANCELED';
    await expect(cancelRunningHubNodeTask('n1')).resolves.toBe('cancelled');
    for (const [url, init] of mocks.fetch.mock.calls) {
      expect(new URL(url).origin).toBe('https://www.runninghub.cn');
      expect(JSON.parse(init.body as string).apiKey).toBe('original-cn-fixture');
    }
  });
  it.each(['image', 'video', 'audio'] as const)('%s 旧文件候选不限制本轮上传，按字段传文件名和 URL 并复用上传', async (kind) => {
    const extension = { image: 'png', video: 'mp4', audio: 'wav' }[kind];
    const filename = `rh/reference.${extension}`;
    const mediaManifest: RunningHubWorkflowManifest = { ...manifest, parameters: [
      { nodeId: '1', fieldName: kind, type: 'string', defaultValue: 'expired-example', source: kind, label: '素材', mediaFormat: 'filename', required: true, options: ['server-example'] },
      { nodeId: '2', fieldName: kind, type: 'string', defaultValue: '', source: kind, label: '素材URL', mediaFormat: 'url', required: true, options: ['server-example'] },
    ] };
    mocks.fetch.mockResolvedValueOnce(json({ code: 200, data: { filename, download_url: 'https://cdn.test/upload' } }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('media', { headers: { 'Content-Type': `${kind}/${extension}` } })));
    const fields = await buildRunningHubInputs(connection, mediaManifest, '', {}, { [kind]: ['blob:reference'] });
    expect(fields.map((field) => field.fieldValue)).toEqual([filename, 'https://cdn.test/upload']);
    expect(mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith('/upload/binary'))).toHaveLength(1);
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-secret');
    expect(mocks.fetch.mock.calls[0][1].body).toBeInstanceOf(FormData);
  });
  it('上传兼容中文文档的业务码 0 和 fileName 字段', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ code: 0, data: { fileName: 'openapi/reference.png', download_url: 'https://cdn.test/upload.png' } }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('png', { headers: { 'Content-Type': 'image/png' } })));
    await expect(uploadRunningHubMedia(connection, 'blob:reference', 'image')).resolves.toEqual({ filename: 'openapi/reference.png', url: 'https://cdn.test/upload.png' });
  });
  it('旧主提示词始终使用本轮节点正文，忽略旧参数覆盖，保留手工固定字段', async () => {
    const legacy: RunningHubWorkflowManifest = { ...manifest, parameters: [
      { nodeId: '1', fieldName: 'text', type: 'string', defaultValue: '导入示例', source: 'value', label: '提示词（可选, 描述你的画面, 默认不用填）' },
      { nodeId: '2', fieldName: 'negative_prompt', type: 'string', defaultValue: '负面', source: 'value', label: '负面提示词' },
    ] };
    const fields = await buildRunningHubInputs(connection, legacy, '本轮节点正文', { '1::text': '过期节点覆盖', '2::negative_prompt': '本轮反向词' });
    expect(fields.map((field) => field.fieldValue)).toEqual(['本轮节点正文', '本轮反向词']);
    const empty = await buildRunningHubInputs(connection, legacy, '');
    expect(empty.map((field) => field.fieldValue)).toEqual(['', '负面']);
    const fixed = { ...legacy, parameters: [{ ...legacy.parameters[0], sourceExplicit: true }] };
    expect((await buildRunningHubInputs(connection, fixed, '节点正文'))[0].fieldValue).toBe('导入示例');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('未选择的可选媒体清空示例，必填缺失在任何上传之前拒绝', async () => {
    const mediaManifest: RunningHubWorkflowManifest = { ...manifest, parameters: [
      { nodeId: '1', fieldName: 'image', type: 'string', defaultValue: 'sample.png', source: 'image', label: '图片' },
      { nodeId: '2', fieldName: 'image', type: 'string', defaultValue: 'sample-2.png', source: 'image', label: '图片2', referenceIndex: 1 },
    ] };
    const fields = await buildRunningHubInputs(connection, mediaManifest, '', { '1::image': 'https://input.test/stale.png' });
    expect(fields.map((field) => field.fieldValue)).toEqual(['', '']);
    const required = { ...mediaManifest, parameters: [mediaManifest.parameters[0], { ...mediaManifest.parameters[1], required: true }] };
    await expect(buildRunningHubInputs(connection, required, '', {}, { image: ['blob:one'] })).rejects.toThrow('图片2');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('URL 输入也先上传当前 RH 站点，使用本轮引用而非旧覆盖且同次上传复用', async () => {
    const mediaManifest: RunningHubWorkflowManifest = { ...manifest, parameters: [
      { nodeId: '1', fieldName: 'image', type: 'string', defaultValue: 'sample.png', source: 'image', label: '图片', mediaFormat: 'filename' },
      { nodeId: '2', fieldName: 'image', type: 'string', defaultValue: '', source: 'image', label: '图片URL', mediaFormat: 'url' },
    ] };
    const fields = await buildRunningHubInputs(connection, mediaManifest, '', { '1::image': 'blob:stale', '2::image': 'blob:stale' }, { image: ['https://input.test/selected.png'] });
    expect(fields.map((field) => field.fieldValue)).toEqual(['rh/reference.png', 'https://cdn.test/upload.png']);
    const uploads = mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith('/upload/binary'));
    expect(uploads).toHaveLength(1);
    expect(new URL(uploads[0][0]).origin).toBe('https://www.runninghub.cn');
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).includes('blob:stale'))).toBe(false);
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
