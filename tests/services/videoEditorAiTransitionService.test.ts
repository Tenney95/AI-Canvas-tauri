import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import { getPendingTasksForProject, completeMediaNodeTask, readVideoEditorTransitionTaskResult } from '../../src/services/pollManager';
import { recoverVideoEditorAiTransition, runVideoEditorAiTransition } from '../../src/services/videoEditorAiTransitionService';
import * as imageUtils from '../../src/services/ai/imageUtils';
import * as videoInputValidation from '../../src/services/ai/videoInputValidation';
import * as billing from '../../src/services/billing/volcengineBillingService';
import type { ModelExecutionProfile } from '../../src/types/aiTypes';

const mocks = vi.hoisted(() => ({ generateVideo: vi.fn(), persist: vi.fn(), reader: vi.fn() }));
vi.mock('../../src/services/ai/generateVideo', async (original) => ({
  ...await original<typeof import('../../src/services/ai/generateVideo')>(), generateVideo: mocks.generateVideo,
}));
vi.mock('../../src/services/fileService', async (original) => ({
  ...await original<typeof import('../../src/services/fileService')>(),
  persistMediaUrlToProjectData: mocks.persist,
  getProjectDataDir: vi.fn(async () => '/project'),
  getAssetUrlFromPath: vi.fn(async () => 'asset://result.mp4'),
  openMediaFileReader: mocks.reader,
}));

const request = { requestId: 'transition-1', prompt: '平滑衔接两个镜头', model: 'general/custom-video', provider: 'general',
  firstFrameUrl: 'https://cdn.example/first.png', lastFrameUrl: 'https://cdn.example/last.png' };
const receiptOf = (task: ReturnType<typeof getPendingTasksForProject>[number]) => ({ projectId: task.projectId,
  nodeId: task.nodeId, taskId: task.taskId, attemptId: task.attemptId });

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project-1', projectLoadStatus: 'ready',
    projects: [{ id: 'project-1', name: '项目', createdAt: 1, updatedAt: 1,
      settings: { generation: { videoAspectRatio: '16:9', videoResolution: '1080p', videoDuration: 10 } } }],
    nodes: [{ id: 'anchor', type: 'ai-video', position: { x: 0, y: 0 },
      data: { type: 'ai-video', label: '原视频', role: 'source', videoUrl: 'asset://original.mp4', status: 'success' } }],
  });
  mocks.generateVideo.mockImplementation(async (_params, _signal, beforeSubmit?: () => void) => {
    await beforeSubmit?.(); return { url: 'https://cdn.example/result.mp4' };
  });
  mocks.persist.mockResolvedValue({ filePath: '/project/result.mp4', assetUrl: 'asset://result.mp4',
    mediaUrl: 'asset://result.mp4', sourceUrl: 'https://cdn.example/result.mp4' });
  mocks.reader.mockResolvedValue({ close: vi.fn(async () => undefined) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('video editor transition identity and delivery', () => {
  it('uses an independent bounded tracking identity and leaves general defaults unset', async () => {
    const outcome = await runVideoEditorAiTransition(request, 'project-1', 'anchor');
    expect(mocks.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ model: request.model, provider: 'general',
      nodeId: expect.stringContaining('video-editor-transition:'), seedanceRatio: undefined,
      seedanceResolution: undefined, seedanceDuration: undefined,
      referenceMedia: [expect.objectContaining({ role: 'first_frame' }), expect.objectContaining({ role: 'last_frame' })],
    }), undefined, expect.any(Function));
    const task = getPendingTasksForProject('project-1')[0];
    expect(task.nodeId).not.toBe('anchor');
    expect(task.nodeId.length).toBeLessThan(128);
    expect(task.mediaContext).toMatchObject({ editorTransition: { anchorNodeId: 'anchor', requestId: request.requestId, fileName: 'result.mp4' } });
    expect(task.resultUrls).toEqual(['https://cdn.example/result.mp4']);
    expect(outcome).toMatchObject({ videoUrl: 'asset://result.mp4', fileName: 'result.mp4', taskReceipt: receiptOf(task) });
    expect(JSON.stringify(task)).not.toContain('/project/');
    expect(useAppStore.getState().nodes[0].data.videoUrl).toBe('asset://original.mp4');
  });

  it('retains completed facts before checking a revoked lease and only takes back the paid result', async () => {
    let current = true;
    const assertCurrent = () => { if (!current) throw new Error('原画布已撤销'); };
    mocks.generateVideo.mockImplementationOnce(async (_params, _signal, beforeSubmit) => {
      beforeSubmit(); current = false; return { url: 'https://cdn.example/already-paid.mp4' };
    });
    await expect(runVideoEditorAiTransition(request, 'project-1', 'anchor', undefined, assertCurrent)).rejects.toThrow('撤销');
    const task = getPendingTasksForProject('project-1')[0];
    expect(task).toMatchObject({ submitted: true, resultUrls: ['https://cdn.example/already-paid.mp4'], mediaRecoveryState: 'delivery_pending' });
    expect(mocks.persist).not.toHaveBeenCalled();
    current = true;
    await expect(recoverVideoEditorAiTransition(receiptOf(task), 'anchor', undefined, assertCurrent)).resolves.toMatchObject({ fileName: 'result.mp4' });
    expect(mocks.generateVideo).toHaveBeenCalledOnce();
  });

  it('guards the actual beforeSubmit boundary without claiming a stale request', async () => {
    let current = true;
    const assertCurrent = () => { if (!current) throw new Error('原窗口已撤销'); };
    mocks.generateVideo.mockImplementationOnce(async (_params, _signal, beforeSubmit) => {
      current = false; beforeSubmit(); return { url: 'never' };
    });
    await expect(runVideoEditorAiTransition(request, 'project-1', 'anchor', undefined, assertCurrent)).rejects.toThrow('撤销');
    expect(getPendingTasksForProject('project-1')).toEqual([]);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.generateVideo).toHaveBeenCalledOnce();
  });

  it('blocks a second paid submission after a synchronous submission becomes unknown', async () => {
    mocks.generateVideo.mockImplementationOnce(async (_params, _signal, beforeSubmit) => {
      beforeSubmit(); throw new Error('network disconnected after submission');
    });
    await expect(runVideoEditorAiTransition(request, 'project-1', 'anchor')).rejects.toThrow('network');
    const original = getPendingTasksForProject('project-1')[0];
    expect(original).toMatchObject({ taskId: '', submitted: false, mediaRecoveryState: 'submit_unknown' });
    await expect(runVideoEditorAiTransition(request, 'project-1', 'anchor')).rejects.toThrow('提交状态未知');
    expect(getPendingTasksForProject('project-1')[0].attemptId).toBe(original.attemptId);
    expect(mocks.generateVideo).toHaveBeenCalledOnce();
  });

  it('rejects concurrent identical requests before either one reaches its submit boundary', async () => {
    let release!: () => void;
    let entered = false;
    mocks.generateVideo.mockImplementationOnce(async (_params, _signal, beforeSubmit) => {
      entered = true;
      await new Promise<void>((resolve) => { release = resolve; });
      beforeSubmit();
      return { url: 'https://cdn.example/one-paid-result.mp4' };
    });
    const first = runVideoEditorAiTransition(request, 'project-1', 'anchor');
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(getPendingTasksForProject('project-1')).toEqual([]);
      await expect(runVideoEditorAiTransition(request, 'project-1', 'anchor')).rejects.toThrow('仍在处理');
      expect(mocks.generateVideo).toHaveBeenCalledOnce();
    } finally { release(); await first; }
    expect(getPendingTasksForProject('project-1')).toHaveLength(1);
  });

  it('saves inline results as original project files before rejecting stale delivery', async () => {
    let current = true;
    mocks.generateVideo.mockImplementationOnce(async (_params, _signal, beforeSubmit) => {
      beforeSubmit(); current = false; return { url: 'data:video/mp4;base64,AQID' };
    });
    const assertCurrent = () => { if (!current) throw new Error('旧交付已撤销'); };
    await expect(runVideoEditorAiTransition(request, 'project-1', 'anchor', undefined, assertCurrent)).rejects.toThrow('撤销');
    const task = getPendingTasksForProject('project-1')[0];
    expect(task.mediaContext?.editorTransition?.fileName).toBe('result.mp4');
    expect(JSON.stringify(task)).not.toMatch(/base64|\/project\//);
    current = true;
    await expect(recoverVideoEditorAiTransition(receiptOf(task), 'anchor', undefined, assertCurrent)).resolves.toMatchObject({ videoUrl: 'asset://result.mp4' });
    expect(mocks.reader).toHaveBeenCalledWith('/project/result.mp4', undefined);
    expect(mocks.generateVideo).toHaveBeenCalledOnce();
  });

  it('keeps delivered request identity so replay cannot cause another paid call', async () => {
    const outcome = await runVideoEditorAiTransition(request, 'project-1', 'anchor');
    completeMediaNodeTask(outcome.taskReceipt!);
    expect(getPendingTasksForProject('project-1')[0].mediaContext?.editorTransition?.delivered).toBe(true);
    await expect(runVideoEditorAiTransition(request, 'project-1', 'anchor')).resolves.toMatchObject({ videoUrl: outcome.videoUrl });
    expect(mocks.generateVideo).toHaveBeenCalledOnce();
  });

  it('retains the original receipt and result when local persistence fails', async () => {
    mocks.persist.mockRejectedValueOnce(new Error('生成媒体未能写入项目目录'));
    await expect(runVideoEditorAiTransition(request, 'project-1', 'anchor')).rejects.toThrow('未能写入');
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ resultUrls: ['https://cdn.example/result.mp4'], mediaRecoveryState: 'delivery_pending' });
    const task = getPendingTasksForProject('project-1')[0];
    expect(task.taskType).toBe('custom-protocol');
    expect(task.protocolPoll).toBeUndefined();
    await expect(recoverVideoEditorAiTransition(receiptOf(task), 'anchor')).resolves.toMatchObject({ videoUrl: 'asset://result.mp4' });
    expect(mocks.generateVideo).toHaveBeenCalledOnce();
  });
});

describe('real generateVideo provider receipts', () => {
  function configureGeneral(mode: 'sync' | 'async') {
    const profile: ModelExecutionProfile = { preset: 'custom', protocol: { version: 2, mode, auth: { type: 'bearer' },
      submit: { method: 'POST', path: '/videos', body: { model: '{{model}}', prompt: '{{prompt}}',
        first_frame: '{{firstImage}}', last_frame: '{{lastImage}}' } },
      response: mode === 'async' ? { type: 'json', taskIdPath: 'id' } : { type: 'json', result: { urlPath: 'url' } },
      ...(mode === 'async' ? { poll: { method: 'GET' as const, path: '/videos/{{taskId}}', intervalMs: 1,
        response: { statusPath: 'status', successValues: ['succeeded'], failureValues: ['failed'], result: { urlPath: 'url' } } } } : {}),
    } };
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, original: { name: '原视频连接', apiKey: 'fixture-secret', baseUrl: 'https://video.example' } },
      generalModels: [{ id: 'custom-video', providerConfigId: 'original', modelId: 'remote-video', name: '原模型', category: 'video',
        videoCapability: { operations: ['image-to-video'], minDuration: 1, maxDuration: 30, maxImageReferences: 2 }, executionProfile: profile }],
    } }));
  }

  it.each(['sync', 'async'] as const)('uses the real %s protocol receipt and never submits again during recovery', async (mode) => {
    configureGeneral(mode);
    const actual = await vi.importActual<typeof import('../../src/services/ai/generateVideo')>('../../src/services/ai/generateVideo');
    mocks.generateVideo.mockImplementation(actual.generateVideo);
    vi.spyOn(imageUtils, 'resolveImageUrlArray').mockImplementation(async (urls) => urls);
    vi.spyOn(videoInputValidation, 'assertVideoInputConstraints').mockResolvedValue(undefined);
    let current = true;
    let revoke = true;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST' && mode === 'async') return new Response(JSON.stringify({ id: 'remote-original-task' }));
      if (revoke) current = false;
      return new Response(JSON.stringify({ status: 'succeeded', url: 'https://cdn.example/paid-result.mp4' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const assertCurrent = () => { if (!current) throw new Error('原代际已撤销'); };
    await expect(runVideoEditorAiTransition(request, 'project-1', 'anchor', undefined, assertCurrent)).rejects.toThrow('撤销');
    const task = getPendingTasksForProject('project-1')[0];
    expect(task).toMatchObject({ nodeId: expect.stringContaining('video-editor-transition:'), providerConfigId: 'original',
      taskType: 'custom-protocol', submitted: true, resultUrls: ['https://cdn.example/paid-result.mp4'], mediaRecoveryState: 'delivery_pending' });
    if (mode === 'async') expect(task.taskId).toBe('remote-original-task');
    expect(JSON.stringify(task)).not.toContain('fixture-secret');
    current = true;
    revoke = false;
    await recoverVideoEditorAiTransition(receiptOf(task), 'anchor', undefined, assertCurrent);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(mocks.generateVideo).toHaveBeenCalledOnce();
    expect(useAppStore.getState().nodes).toHaveLength(1);
  });

  it('preserves the actual Ark remote ID and reuses its completed result without another submission', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      volcengine: { apiKey: 'ark-fixture', baseUrl: 'https://ark.example/api/v3' } } } }));
    const actual = await vi.importActual<typeof import('../../src/services/ai/generateVideo')>('../../src/services/ai/generateVideo');
    mocks.generateVideo.mockImplementation(actual.generateVideo);
    vi.spyOn(imageUtils, 'resolveImageUrlArray').mockImplementation(async (urls) => urls);
    vi.spyOn(billing, 'createBillingRun').mockResolvedValue(null);
    vi.spyOn(billing, 'updateBillingRun').mockResolvedValue(null);
    let current = true;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return new Response(JSON.stringify({ id: 'ark-original-task' }));
      current = false;
      return new Response(JSON.stringify({ status: 'succeeded', content: { video_url: 'https://cdn.example/ark-result.mp4' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const assertCurrent = () => { if (!current) throw new Error('原剪辑窗口已关闭'); };
    await expect(runVideoEditorAiTransition({ ...request, model: 'volcengine/doubao-seedance-1-0-pro-250528', provider: 'volcengine' },
      'project-1', 'anchor', undefined, assertCurrent)).rejects.toThrow('关闭');
    const task = getPendingTasksForProject('project-1')[0];
    expect(task).toMatchObject({ taskId: 'ark-original-task', taskType: 'volcengine', resultUrls: ['https://cdn.example/ark-result.mp4'], submitted: true });
    current = true;
    await expect(readVideoEditorTransitionTaskResult(receiptOf(task))).resolves.toMatchObject({ url: 'https://cdn.example/ark-result.mp4' });
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(useAppStore.getState().nodes[0].data.videoUrl).toBe('asset://original.mp4');
  });
});
