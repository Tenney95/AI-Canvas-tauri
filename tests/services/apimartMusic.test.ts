/**
 * apimartMusic — 回归测试：APIMart 音频错误脱敏。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const receipts = new Map<string, { projectId: string; nodeId: string; taskId: string; attemptId: string }>();
  const removePendingTask = vi.fn((nodeId: string, _taskId?: string, _attemptId?: string) => { receipts.delete(nodeId); });
  return {
  receipts,
  savePendingTask: vi.fn((task: { nodeId: string; projectId: string; taskId: string }) => {
    const receipt = { projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, attemptId: 'attempt' };
    receipts.set(task.nodeId, receipt); return receipt;
  }),
  updatePendingTask: vi.fn((nodeId: string, patch: { taskId?: string }) => {
    const current = receipts.get(nodeId); if (!current) return undefined;
    const receipt = { ...current, ...(patch.taskId === undefined ? {} : { taskId: patch.taskId }) };
    receipts.set(nodeId, receipt); return receipt;
  }),
  getMediaTaskReceipt: vi.fn((nodeId: string) => receipts.get(nodeId)),
  pauseMediaTask: vi.fn((receipt: { taskId: string }, _error?: unknown, reason?: string) => Object.assign(new Error('任务查询已暂停'),
    { name: 'MediaTaskPausedError', taskReceipt: receipt, reason: reason ?? 'query_interrupted' })),
  VIDEO_POLL_MAX_DURATION_MS: 30 * 60 * 1000,
  removePendingTask,
  removeFailedMediaTask: vi.fn((receipt: { nodeId: string; taskId: string; attemptId: string }) => {
    removePendingTask(receipt.nodeId, receipt.taskId, receipt.attemptId);
  }), cleanupNodePolling: vi.fn(),
  registerNodePolling: vi.fn((_nodeId: string, parentSignal?: AbortSignal) => {
    parentSignal?.throwIfAborted();
    return parentSignal ?? new AbortController().signal;
  }),
  state: { config: { providers: { apimart: { apiKey: 'test-key', baseUrl: 'https://api.example/v1' } } }, currentProjectId: 'project', nodes: [] },
}; });
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.state } }));
vi.mock('../../src/services/pollManager', () => mocks);

import {
  fetchFlowMusicTask, generateApimartSpeech, queryApimartMusicTask, submitFlowMusicLyrics,
  submitSunoGeneration, submitFlowMusicGeneration, transcribeApimartAudio,
} from '../../src/services/ai/apimartAudio';
import { apimartMediaProviderAdapter } from '../../src/services/ai/providers/apimartMedia';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

describe('APIMart 音频错误脱敏', () => {
  const apiKey = 'fixture~! private/key=';
  const echoed = () => [apiKey, encodeURIComponent(apiKey), new URLSearchParams({ key: apiKey }).toString().slice(4)].join(' | ');
  const calls = {
    suno: () => submitSunoGeneration(apiKey, 'https://api.example/v1', { version: 'v6', prompt: 'song' }),
    lyrics: () => submitFlowMusicLyrics(apiKey, 'https://api.example/v1', 'lyrics'),
    tts: () => generateApimartSpeech(apiKey, 'https://api.example/v1', { model: 'tts-1', input: 'hello', voice: 'alloy', format: 'wav', speed: 1 }),
    whisper: () => transcribeApimartAudio(apiKey, 'https://api.example/v1', { file: new Blob(['audio']), fileName: 'sample.wav' }),
    query: () => fetchFlowMusicTask(apiKey, 'https://api.example/v1', 'original-task'),
  };
  beforeEach(() => { vi.clearAllMocks(); mocks.receipts.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); mocks.state.config.providers.apimart.apiKey = 'test-key'; });

  it.each(['suno', 'lyrics', 'tts', 'whisper', 'query'] as const)('%s 的 HTTP 错误只输出脱敏文案', async (kind) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: echoed() } }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await calls[kind]().catch((value: unknown) => value);
    expect(error).toMatchObject({ message: '[REDACTED] | [REDACTED] | [REDACTED]' });
    if (kind === 'suno' || kind === 'lyrics') expect(error).toMatchObject({ name: 'ModelProtocolHttpError', status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['suno', 'lyrics', 'tts', 'whisper', 'query'] as const)('%s 的网络异常保留类型并移除全部凭据编码', async (kind) => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError(`Failed to fetch ${echoed()}`));
    vi.stubGlobal('fetch', fetchMock);
    const error = await calls[kind]().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('Failed to fetch [REDACTED] | [REDACTED] | [REDACTED]');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('TTS HTTP 200 的明确 JSON 拒绝不会被交付为音频字节', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: { code: 'insufficient_balance', message: echoed() } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(calls.tts()).rejects.toMatchObject({
      name: 'ModelProtocolHttpError', status: 200, definitiveFailure: true,
      message: '[REDACTED] | [REDACTED] | [REDACTED]',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('TTS 未声明的 JSON 格式不能冒充音频，也不猜测为明确拒绝', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ unexpected: true }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await calls.tts().catch((value: unknown) => value);
    expect(error).toMatchObject({ message: 'APIMart TTS 返回 JSON，未返回音频数据' });
    expect(error).not.toHaveProperty('definitiveFailure');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['suno', 'lyrics', 'tts', 'whisper', 'query'] as const)('%s 的纯文本错误在截断之前移除 Key', async (kind) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(`${'x'.repeat(197)}${apiKey}`, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await calls[kind]().catch((value: unknown) => value);
    expect((error as Error).message).toContain(`${'x'.repeat(197)}[RE`);
    expect((error as Error).message).not.toContain('fixture');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['object', 'string'] as const)('音乐 HTTP 200 的 %s 终态错误在返回和抛出前都脱敏', async (shape) => {
    mocks.state.config.providers.apimart.apiKey = apiKey;
    const task = { status: 'failed', error: shape === 'object'
      ? { message: echoed(), code: apiKey, type: 'task_failed', private: apiKey } : echoed() };
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ data: task }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchFlowMusicTask(apiKey, 'https://api.example/v1', 'original-task');
    expect(JSON.stringify(result.error)).not.toContain(apiKey);
    expect(JSON.stringify(result.error)).not.toContain(encodeURIComponent(apiKey));
    expect(result.error).not.toHaveProperty('private');
    fetchMock.mockResolvedValueOnce(json({ data: [{ task_id: 'original-task' }] })).mockResolvedValueOnce(json({ data: task }));
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: {
      provider: 'apimart', model: 'apimart/suno-v6', nodeId: 'music-node', prompt: 'song',
    }, prompt: 'song', referenceAudioUrls: [] })).rejects.toMatchObject({
      name: 'PollTaskFailedError', message: expect.stringContaining('[REDACTED]'),
    });
    expect(mocks.removePendingTask).toHaveBeenCalledWith('music-node', 'original-task', 'attempt');
    expect(mocks.pauseMediaTask).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('共享音乐查询只读取原 ID，将已取消任务结算为明确终态', async () => {
    const taskId = 'original/music-task';
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ data: { status: 'cancelled' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(queryApimartMusicTask(apiKey, 'https://api.example/v1', taskId, {
      maxDuration: 10_000,
      failureMessage: (task) => `原音乐阶段：${task.status}`,
    })).rejects.toMatchObject({ name: 'PollTaskFailedError', message: '原音乐阶段：cancelled' });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET']))
      .toEqual([['https://api.example/v1/music/tasks/original%2Fmusic-task?language=zh', 'GET']]);
  });

  it('音乐查询网络异常在原任务暂停边界也不携带 Key', async () => {
    mocks.state.config.providers.apimart.apiKey = apiKey;
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ data: [{ task_id: 'original-task' }] }))
      .mockRejectedValueOnce(new TypeError(echoed()));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: {
      provider: 'apimart', model: 'apimart/suno-v6', nodeId: 'music-node', prompt: 'song',
    }, prompt: 'song', referenceAudioUrls: [] })).rejects.toMatchObject({
      name: 'MediaTaskPausedError', taskReceipt: { taskId: 'original-task', attemptId: 'attempt' },
    });
    const detail = mocks.pauseMediaTask.mock.calls[0][1] as Error;
    expect(detail).toBeInstanceOf(TypeError);
    expect(detail.message).toBe('[REDACTED] | [REDACTED] | [REDACTED]');
    expect(mocks.receipts.get('music-node')).toMatchObject({ taskId: 'original-task', attemptId: 'attempt' });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
});

describe('APIMart 音乐版本协议', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.receipts.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('Lyria 复用 flowmusic，显式提交 version，不将界面选择 ID 发给服务器', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ code: 200, data: [{ task_id: 'lyria-task' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(submitFlowMusicGeneration('key', 'https://api.example/v1', { version: 'lyria-3.5', soundPrompt: 'jazz', length: 60 })).resolves.toBe('lyria-task');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example/v1/music/generations');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'flowmusic', version: 'lyria-3.5', sound_prompt: 'jazz', length: 60 });
  });

  it.each(['v6', 'v6-wild', 'v6-mini'] as const)('Suno %s 灵感模式省略不生效的歌词、标题和时长字段', async (version) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ code: 200, data: [{ task_id: 'suno-task' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await submitSunoGeneration('key', 'https://api.example/v1', { version, prompt: 'acoustic song', title: 'ignored', duration: 60 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: 'suno', version, custom: false, prompt: 'acoustic song' });
  });

  it('Suno 自定义歌词使用 prompt，风格单独写入 style', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ code: 200, data: [{ task_id: 'suno-task' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await submitSunoGeneration('key', 'https://api.example/v1', { version: 'v6', prompt: 'jazz', lyrics: '[Verse]\n夜色', title: '夜色', duration: 120 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: 'suno', version: 'v6', custom: true, prompt: '[Verse]\n夜色', style: 'jazz', title: '夜色', duration: 120 });
  });

  it('超长歌词、非法时长在付费提交前拒绝', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(() => submitSunoGeneration('key', 'https://api.example/v1', { version: 'v6', prompt: 'jazz', lyrics: '字'.repeat(5001) })).toThrow('长度限制');
    expect(() => submitSunoGeneration('key', 'https://api.example/v1', { version: 'v6', prompt: 'jazz', lyrics: '歌词', duration: 5 })).toThrow('10–360');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['flowmusic-lyria-3.5', 'suno-v6-mini'])('%s 由 Adapter 复用可恢复的单阶段音乐任务', async (model) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, data: [{ task_id: 'music-task' }] }))
      .mockResolvedValueOnce(json({ code: 200, data: { status: 'completed', result: { music: [{ title: '曲目', audio_url: 'https://cdn.example/music.mp3' }] } } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: { provider: 'apimart', model: `apimart/${model}`, prompt: 'jazz', nodeId: 'node', autoGenerateLyrics: true }, prompt: 'jazz', referenceAudioUrls: [] }))
      .resolves.toMatchObject({ url: 'https://cdn.example/music.mp3', title: '曲目' });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['https://api.example/v1/music/generations', 'https://api.example/v1/music/tasks/music-task?language=zh']);
    expect(mocks.savePendingTask).toHaveBeenCalledWith(expect.objectContaining({ taskType: 'apimart-flow-music', audioTaskStage: 'music', providerConfigId: 'apimart' }));
    expect(mocks.updatePendingTask).toHaveBeenCalledWith('node', expect.objectContaining({ taskId: 'music-task', submitted: true }), '', 'attempt');
    expect(mocks.removePendingTask).not.toHaveBeenCalled();
  });

  it('余额不足只提交一次', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: '余额不足' } }), { status: 402, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(submitSunoGeneration('key', 'https://api.example/v1', { version: 'v6', prompt: 'jazz' })).rejects.toThrow('余额不足');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 402])('Adapter 将音乐提交 HTTP %s 作为明确拒绝，不保留空任务', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: '音乐提交被拒绝' } }), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: {
      provider: 'apimart', model: 'apimart/suno-v6', nodeId: 'music-node', prompt: 'jazz',
    }, prompt: 'jazz', referenceAudioUrls: [] })).rejects.toMatchObject({
      name: 'ModelProtocolHttpError', status, message: '音乐提交被拒绝',
    });
    expect(mocks.removePendingTask).toHaveBeenCalledWith('music-node', '', 'attempt');
    expect(mocks.pauseMediaTask).not.toHaveBeenCalled();
    expect(mocks.receipts.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([408, 429, 500, 503])('Adapter 将音乐提交 HTTP %s 保留为状态未知且不重发', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: '提交结果尚未确认' } }), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: {
      provider: 'apimart', model: 'apimart/suno-v6', nodeId: 'music-node', prompt: 'jazz',
    }, prompt: 'jazz', referenceAudioUrls: [] })).rejects.toMatchObject({
      name: 'MediaTaskPausedError', reason: 'submit_unknown', taskReceipt: { taskId: '' },
    });
    expect(mocks.removePendingTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [200, { code: 402, message: '余额不足' }],
    [429, { error: { code: 'rate_limit_exceeded', message: '请求被限流拒绝' } }],
    [503, { error: { code: 'insufficient_balance', message: '余额不足' } }],
  ] as const)('音乐提交 HTTP %s 的明确业务拒绝直接失败，保留错误分类', async (status, payload) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: {
      provider: 'apimart', model: 'apimart/suno-v6', nodeId: 'music-node', prompt: 'jazz',
    }, prompt: 'jazz', referenceAudioUrls: [] })).rejects.toMatchObject({
      name: 'ModelProtocolHttpError', status, definitiveFailure: true,
    });
    expect(mocks.removeFailedMediaTask).toHaveBeenCalledWith({ projectId: 'project', nodeId: 'music-node', taskId: '', attemptId: 'attempt' });
    expect(mocks.pauseMediaTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('已提交音乐的查询鉴权错误保留原 ID，不误当任务失败', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ data: [{ task_id: 'music-auth' }] }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'Key 已失效' } }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: {
      provider: 'apimart', model: 'apimart/suno-v6', nodeId: 'music-node', prompt: 'jazz',
    }, prompt: 'jazz', referenceAudioUrls: [] })).rejects.toMatchObject({
      name: 'MediaTaskPausedError', taskReceipt: { taskId: 'music-auth' },
    });
    expect(mocks.removeFailedMediaTask).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('音乐查询断网保留已提交 ID，重试入口不需要重新生成', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ data: [{ task_id: 'music-network' }] }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: {
      provider: 'apimart', model: 'apimart/suno-v6', nodeId: 'music-node', prompt: 'jazz',
    }, prompt: 'jazz', referenceAudioUrls: [] })).rejects.toMatchObject({
      name: 'MediaTaskPausedError', taskReceipt: { taskId: 'music-network' },
    });
    expect(mocks.removePendingTask).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('音乐提交响应丢失保留状态不确定，禁止把它当成可安全重发', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: {
      provider: 'apimart', model: 'apimart/suno-v6', nodeId: 'music-node', prompt: 'jazz',
    }, prompt: 'jazz', referenceAudioUrls: [] })).rejects.toMatchObject({
      name: 'MediaTaskPausedError', reason: 'submit_unknown', taskReceipt: { taskId: '' },
    });
    expect(mocks.removePendingTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('提交后取消不重投音乐任务', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementationOnce(() => { controller.abort(); return Promise.resolve(json({ code: 200, data: [{ task_id: 'music-task' }] })); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: { provider: 'apimart', model: 'apimart/suno-v6', prompt: 'jazz' }, prompt: 'jazz', referenceAudioUrls: [], signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
