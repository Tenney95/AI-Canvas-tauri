import { describe, expect, it, vi } from 'vitest';
import type { ModelExecutionProtocol } from '../../../src/types/aiTypes';
import {
  buildModelProtocolRequest,
  executeModelProtocol,
  getModelProtocolPreset,
  normalizeFrames8n1,
  pollResolvedModelProtocol,
  validateModelExecutionProtocol,
} from '../../../src/services/ai/modelProtocol';
import {
  findModelProtocolForEachCapabilityConflicts,
  findUnusedReferenceVariables,
  runConfiguredModelProtocol,
} from '../../../src/services/ai/modelProtocolRuntime';
import { useAppStore } from '../../../src/store/useAppStore';
import { buildGeneralVideoProtocolVariables } from '../../../src/services/ai/generateVideo';
import { getPendingTasksForProject, MediaTaskPausedError, VideoPollingPausedError } from '../../../src/services/pollManager';
import { jsonResponse, setupProtocolFixture } from './protocolFixture';

setupProtocolFixture();

describe('declarative model execution protocol', () => {
  it.each(['image', 'audio'] as const)('retains a submitted %s task after a non-timeout query failure', async (category) => {
    localStorage.clear();
    useAppStore.setState((state) => ({ currentProjectId: 'media-query-project',
      nodes: [{ id: 'media-query-node', type: category === 'image' ? 'ai-image' : 'ai-audio', position: { x: 0, y: 0 },
        data: { type: category === 'image' ? 'ai-image' : 'ai-audio', label: 'Media', status: 'loading' } }],
      config: { ...state.config, providers: { ...state.config.providers,
        recovery: { name: 'Recovery', apiKey: 'fixture-secret', baseUrl: 'https://gateway.example/v1' } } } }));
    const protocol: ModelExecutionProtocol = { version: 2, mode: 'async',
      submit: { method: 'POST', path: '/generate', body: { model: '{{model}}', prompt: '{{prompt}}' } },
      response: { type: 'json', taskIdPath: 'id' }, poll: { method: 'GET', path: '/tasks/{{submit.id}}',
        retry: { maxRetries: 0 }, response: { statusPath: 'status', successValues: ['completed'],
          failureValues: ['failed'], result: { urlPath: 'url' } } } };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'original-media-task' }))
      .mockRejectedValueOnce(new TypeError('network disconnected'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(runConfiguredModelProtocol({ category, nodeId: 'media-query-node',
      model: { id: 'media', name: 'Media', modelId: 'media', category, providerConfigId: 'recovery',
        executionProfile: { preset: 'custom', protocol } }, variables: { model: 'media', prompt: 'private prompt' } }))
      .rejects.toMatchObject({ name: 'MediaTaskPausedError', taskReceipt: { taskId: 'original-media-task' } });
    expect(getPendingTasksForProject('media-query-project')[0]).toMatchObject({ taskId: 'original-media-task', submitted: true,
      mediaRecoveryState: 'query_paused', protocolPoll: { url: 'https://gateway.example/v1/tasks/original-media-task' } });
    expect(JSON.stringify(getPendingTasksForProject('media-query-project'))).not.toContain('private prompt');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    localStorage.clear();
  });

  it('keeps an interrupted async submit as unknown without claiming that the provider rejected it', async () => {
    localStorage.clear();
    useAppStore.setState((state) => ({ currentProjectId: 'unknown-submit', nodes: [],
      config: { ...state.config, providers: { ...state.config.providers,
        recovery: { name: 'Recovery', apiKey: 'fixture-secret', baseUrl: 'https://gateway.example/v1' } } } }));
    const protocol: ModelExecutionProtocol = { version: 2, mode: 'async',
      submit: { method: 'POST', path: '/images', body: { model: '{{model}}', prompt: '{{prompt}}' } },
      response: { type: 'json', taskIdPath: 'id' }, poll: { method: 'GET', path: '/images/{{submit.id}}', response: {
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], result: { urlPath: 'url' } } } };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connection lost')));
    await expect(runConfiguredModelProtocol({ category: 'image', nodeId: 'unknown-node', model: {
      id: 'unknown-model', name: 'Unknown model', category: 'image', modelId: 'unknown-model', providerConfigId: 'recovery',
      executionProfile: { preset: 'custom', protocol } }, variables: { model: 'unknown-model', prompt: 'image' } }))
      .rejects.toBeInstanceOf(MediaTaskPausedError);
    expect(getPendingTasksForProject('unknown-submit')[0]).toMatchObject({ taskId: '', submitted: false,
      mediaRecoveryState: 'submit_unknown' });
    localStorage.clear();
  });

  it('retains an async video query descriptor when the declared polling budget expires', async () => {
    localStorage.clear();
    useAppStore.setState((state) => ({ currentProjectId: 'slow-project',
      nodes: [{ id: 'slow-protocol', type: 'ai-video', position: { x: 0, y: 0 },
        data: { type: 'ai-video', label: 'Slow', prompt: 'video', status: 'loading' } }],
      config: { ...state.config, providers: { ...state.config.providers,
        slow: { name: 'Slow', apiKey: 'fixture-key', baseUrl: 'https://gateway.example/v1' } } } }));
    const protocol: ModelExecutionProtocol = { version: 2, mode: 'async', auth: { type: 'bearer' },
      submit: { method: 'POST', path: '/videos', body: { model: '{{model}}', prompt: '{{prompt}}' } },
      response: { type: 'json', taskIdPath: 'id' }, poll: { method: 'GET', path: '/videos/{{submit.id}}',
        intervalMs: 1000, maxAttempts: 1, response: { statusPath: 'status', successValues: ['completed'],
          failureValues: ['failed'], result: { urlPath: 'url' } } } };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'task-retained' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'queued' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(runConfiguredModelProtocol({ nodeId: 'slow-protocol', category: 'video',
      model: { id: 'slow', name: 'Slow', modelId: 'slow', category: 'video', providerConfigId: 'slow',
        executionProfile: { preset: 'custom', protocol } }, variables: { model: 'slow', prompt: 'video' } }))
      .rejects.toBeInstanceOf(VideoPollingPausedError);
    expect(getPendingTasksForProject('slow-project')[0]).toMatchObject({ taskId: 'task-retained',
      videoRecoveryState: 'paused', protocolPoll: { url: 'https://gateway.example/v1/videos/task-retained' } });
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'idle', videoTaskState: 'paused', error: undefined });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    localStorage.clear();
  });

  it('normalizes arbitrary video frame counts to 8 * n + 1', () => {
    expect(normalizeFrames8n1(77)).toBe(81);
    expect(normalizeFrames8n1(121)).toBe(121);
    expect(getModelProtocolPreset('agnes-video').poll?.intervalMs).toBe(10000);
  });

  it('executes the Agnes video submit and video_id polling contract', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        task_id: 'task-1',
        video_id: 'video-1',
        status: 'queued',
      }))
      .mockResolvedValueOnce(jsonResponse({
        video_id: 'video-1',
        status: 'completed',
        progress: 100,
        url: 'https://cdn.example/video.mp4',
        error: null,
      }));
    vi.stubGlobal('fetch', fetchMock);

    const protocol = getModelProtocolPreset('agnes-video');
    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      protocol,
      variables: {
        model: 'agnes-video-v2.0',
        prompt: 'A cinematic cat',
        frames: 121,
        frames8n1: 121,
        fps: 24,
      },
    });

    expect(result.urls).toEqual(['https://cdn.example/video.mp4']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://apihub.agnes-ai.com/v1/videos');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'agnes-video-v2.0',
      prompt: 'A cinematic cat',
      height: 768,
      width: 1152,
      num_frames: 121,
      frame_rate: 24,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://apihub.agnes-ai.com/agnesapi?video_id=video-1',
    );
  });

  it('polls an asynchronous text protocol and extracts its configured text path', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ job: { id: 'text-task' } }))
      .mockResolvedValueOnce(jsonResponse({ state: 'done', output: { text: '异步文本' } }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'async',
      submit: {
        method: 'POST',
        path: '/responses',
        body: { model: '{{model}}', prompt: '{{prompt}}' },
      },
      taskIdPath: 'job.id',
      poll: {
        method: 'GET',
        path: '/responses/{{submit.job.id}}',
        statusPath: 'state',
        successValues: ['done'],
        failureValues: ['failed'],
        resultTextPath: 'output.text',
        intervalMs: 1000,
      },
    } as unknown as ModelExecutionProtocol;

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { model: 'async-text', prompt: '测试' },
    });

    expect(result.text).toBe('异步文本');
    expect(result.taskId).toBe('text-task');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://gateway.example/v1/responses/text-task');
  });

  it('posts form-encoded polling requests and extracts JSON base64 results', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ task_id: 'image-task' }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'completed',
        output: { image: 'aGVsbG8=' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'async',
      submit: {
        method: 'POST',
        path: '/render',
        body: { model: '{{model}}', prompt: '{{prompt}}' },
      },
      taskIdPath: 'task_id',
      poll: {
        method: 'POST',
        path: '/render/status',
        bodyEncoding: 'form-urlencoded',
        body: { task_id: '{{submit.task_id}}' },
        statusPath: 'status',
        successValues: ['completed'],
        failureValues: ['failed'],
        resultBase64Path: 'output.image',
        resultMimeType: 'image/png',
        intervalMs: 1000,
      },
    } as unknown as ModelExecutionProtocol;

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { model: 'async-image', prompt: '测试' },
    });

    expect(result.urls).toEqual(['data:image/png;base64,aGVsbG8=']);
    const pollInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(pollInit.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    });
    expect(pollInit.body).toBe('task_id=image-task');
  });

  it('executes the OpenAI-compatible image preset with nested extra_body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      data: [{ url: 'https://cdn.example/image.png' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://apihub.agnes-ai.com/v1/',
      protocol: getModelProtocolPreset('openai-image'),
      variables: {
        model: 'agnes-image-2.0-flash',
        prompt: 'A glass cube',
        size: '1024x768',
      },
    });

    expect(result.urls).toEqual(['https://cdn.example/image.png']);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'agnes-image-2.0-flash',
      prompt: 'A glass cube',
      size: '1024x768',
      extra_body: { response_format: 'url' },
    });
  });

  it('extracts results from a top-level JSON array', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([
      { url: 'https://cdn.example/array-image.png' },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'sync',
      submit: { method: 'POST', path: '/render', body: { prompt: '{{prompt}}' } },
      resultUrlPath: '0.url',
    } as ModelExecutionProtocol;

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { prompt: 'test' },
    });

    expect(result.urls).toEqual(['https://cdn.example/array-image.png']);
  });

  it('executes the OpenAI-compatible chat preset and extracts text', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: '配置成功' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol: getModelProtocolPreset('openai-chat' as never),
      variables: {
        model: 'chat-model',
        messages: [{ role: 'user', content: '测试' }],
        stream: false,
      },
    });

    expect(result.text).toBe('配置成功');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/chat/completions');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'chat-model',
      messages: [{ role: 'user', content: '测试' }],
      stream: false,
    });
  });

  it('rejects a persisted polling URL from a different origin', async () => {
    await expect(pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://other.example/tasks/1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 3000,
    }, 'secret', undefined, 'https://apihub.agnes-ai.com/v1')).rejects.toThrow('不同源');
  });

  it('retries a rate-limited status query without resubmitting the paid task', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 'rate_limit',
        message: 'video status query rate limit exceeded',
      }, 429))
      .mockResolvedValueOnce(jsonResponse({
        status: 'completed',
        url: 'https://cdn.example/recovered.mp4',
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://apihub.agnes-ai.com/agnesapi?video_id=video-1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 1,
    }, 'secret', undefined, 'https://apihub.agnes-ai.com/v1');

    expect(result.urls).toEqual(['https://cdn.example/recovered.mp4']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries configured transient status responses and resets after success', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'temporarily unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse({
        status: 'completed',
        url: 'https://cdn.example/recovered-from-503.mp4',
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://api.example/tasks/video-1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 1,
      retry: {
        httpStatuses: [503],
        maxRetries: 2,
        backoff: 'fixed',
        maxDelayMs: 1000,
        honorRetryAfter: true,
        retryNetworkErrors: true,
      },
    }, 'secret', undefined, 'https://api.example/v1');

    expect(result.urls).toEqual(['https://cdn.example/recovered-from-503.mp4']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After before issuing the next status query', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse(
          { message: 'slow down' },
          429,
          { 'Retry-After': '2' },
        ))
        .mockResolvedValueOnce(jsonResponse({
          status: 'completed',
          url: 'https://cdn.example/retry-after.mp4',
        }));
      vi.stubGlobal('fetch', fetchMock);

      const resultPromise = pollResolvedModelProtocol({
        method: 'GET',
        url: 'https://api.example/tasks/video-1',
        statusPath: 'status',
        successValues: ['completed'],
        failureValues: ['failed'],
        resultUrlPath: 'url',
        intervalMs: 1000,
        retry: {
          httpStatuses: [429],
          maxRetries: 1,
          backoff: 'fixed',
          maxDelayMs: 5000,
          honorRetryAfter: true,
          retryNetworkErrors: false,
        },
      }, 'secret', undefined, 'https://api.example/v1');

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(resultPromise).resolves.toMatchObject({
        urls: ['https://cdn.example/retry-after.mp4'],
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling at the configured maximum attempt count', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      status: 'processing',
    })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://api.example/tasks/video-1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 1,
      maxAttempts: 2,
    }, 'secret', undefined, 'https://api.example/v1')).rejects.toThrow('模型任务轮询超时');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes the cancellation signal to every polling request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://api.example/tasks/video-1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 1,
    }, 'secret', controller.signal, 'https://api.example/v1')).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).not.toBe(controller.signal);
  });

  it('uses the configured consecutive query retry limit', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      message: 'video status query rate limit exceeded',
    }, 429)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://api.example/tasks/video-1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 1,
      retry: {
        httpStatuses: [429],
        maxRetries: 1,
        backoff: 'fixed',
        maxDelayMs: 1000,
        honorRetryAfter: true,
        retryNetworkErrors: true,
      },
    }, 'secret', undefined, 'https://api.example/v1')).rejects.toThrow(
      'video status query rate limit exceeded',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not classify an HTTP business error message as a network transport error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'network error in upstream payload' }, 400))
      .mockResolvedValueOnce(jsonResponse({
        status: 'completed',
        url: 'https://cdn.example/should-not-be-reached.mp4',
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://api.example/tasks/video-1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 1,
      retry: {
        httpStatuses: [503],
        maxRetries: 2,
        backoff: 'fixed',
        maxDelayMs: 1000,
        honorRetryAfter: true,
        retryNetworkErrors: true,
      },
    }, 'secret', undefined, 'https://api.example/v1')).rejects.toThrow(
      'network error in upstream payload',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('validates polling limits and retry strategy fields', () => {
    const protocol = getModelProtocolPreset('agnes-video');
    Object.assign(protocol.poll!, {
      maxAttempts: 0,
      maxDurationMs: 500,
      retry: {
        httpStatuses: [99, 429, 700],
        maxRetries: 11,
        backoff: 'random',
        maxDelayMs: 500,
        honorRetryAfter: 'yes',
        retryNetworkErrors: 'yes',
      },
    });

    expect(validateModelExecutionProtocol(protocol)).toEqual(expect.arrayContaining([
      '最大轮询次数必须在 1 到 10000 之间',
      '最大轮询时长必须在 1000 到 86400000 毫秒之间',
      '重试 HTTP 状态码必须是 100 到 599 的整数',
      '连续错误重试次数必须在 0 到 10 之间',
      '重试退避策略只支持 fixed、linear 或 exponential',
      '最大重试间隔必须在 1000 到 300000 毫秒之间',
      'Retry-After 开关必须是布尔值',
      '网络错误重试开关必须是布尔值',
    ]));
  });

  it('rejects async polling with a hard-coded task id and accepts submit binding in the body', () => {
    const protocol = getModelProtocolPreset('agnes-video');
    protocol.poll!.path = '/query/video_generation/424010985738629';
    delete protocol.poll!.query;

    const bindingError =
      '异步轮询请求的 path、query 或 body 必须引用任务 ID 变量 {{submit.video_id}}，不能引用其他提交字段或写死任务 ID';
    expect(validateModelExecutionProtocol(protocol)).toContain(bindingError);

    protocol.poll!.method = 'POST';
    protocol.poll!.body = { video_id: '{{submit.video_id}}' };
    expect(validateModelExecutionProtocol(protocol)).not.toContain(bindingError);

    protocol.poll!.body = { video_id: '{{submit.status}}' };
    expect(validateModelExecutionProtocol(protocol)).toContain(bindingError);
  });

  it('stops after three consecutive rate-limited status query retries', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      code: 'rate_limit',
      message: 'video status query rate limit exceeded',
    }, 429)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://apihub.agnes-ai.com/agnesapi?video_id=video-1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 1,
    }, 'secret', undefined, 'https://apihub.agnes-ai.com/v1')).rejects.toThrow(
      'video status query rate limit exceeded',
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('surfaces unavailable deployments without automatically resubmitting paid generation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      error: {
        message: 'No deployments available for selected model, Try again in 5 seconds.',
        code: '429',
      },
    }, 429));
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      protocol: getModelProtocolPreset('agnes-video'),
      variables: {
        model: 'agnes-video-v2.0',
        prompt: 'A cinematic cat',
        frames: 121,
        frames8n1: 121,
        fps: 24,
      },
    })).rejects.toThrow('暂无可用部署');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('reference media coverage in custom protocols', () => {
  const buildVideoReferences = (withOtherMedia = false, inline = false) => {
    const imageUrls = inline
      ? ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB']
      : ['https://cdn.example/a.png', 'https://cdn.example/b.png'];
    return buildGeneralVideoProtocolVariables(
      'seedance2.5 超特价10图3视3音',
      { model: 'general/video', provider: 'general', prompt: imageUrls[0] },
      {
        prompt: imageUrls[0], imageUrls,
        videoUrls: withOtherMedia ? ['https://cdn.example/reference.mp4'] : [],
        audioUrls: withOtherMedia ? ['https://cdn.example/reference.mp3'] : [],
        operation: withOtherMedia ? 'video-to-video' : 'image-to-video',
      },
    );
  };

  it.each([
    { images: '{{imageUrls}}', videos: '{{videoUrls}}', audios: '{{audioUrls}}' },
    { images: '{{referenceImageUrls}}', videos: '{{referenceVideoUrls}}', audios: '{{referenceAudioUrls}}' },
    { image_with_roles: '{{imageWithRoles}}', videos: '{{videoUrls}}', audios: '{{audioUrls}}' },
    { content: '{{seedanceContent}}' },
    { references: '{{referenceUrls}}' },
  ])('accepts all runtime aliases when the real media are delivered by %j', (body) => {
    expect(findUnusedReferenceVariables(JSON.stringify({ submit: { body } }),
      buildVideoReferences(true))).toEqual([]);
  });

  it.each([false, true])('accepts two connected images without inventing video/audio gaps (inline=%s)', (inline) => {
    expect(findUnusedReferenceVariables(JSON.stringify({
      submit: { body: { images: '{{imageUrls}}', videos: '{{videoUrls}}', audios: '{{audioUrls}}' } },
    }), buildVideoReferences(false, inline))).toEqual([]);
  });

  it('ignores Seedance prompt, type and role metadata when checking transport paths', () => {
    const variables = buildVideoReferences();
    for (const path of ['seedanceContent.0.text', 'seedanceContent.1.type', 'seedanceContent.1.role']) {
      expect(findUnusedReferenceVariables(JSON.stringify({
        submit: { body: { metadata: `{{${path}}}` } },
      }), variables)).toEqual(['referenceImageUrls']);
    }
  });

  it('preserves Seedance indexes and still requires all images for indexed transport', () => {
    const variables = buildVideoReferences();
    const source = (path: string) => JSON.stringify({ submit: { body: { images: `{{${path}}}` } } });
    expect(findUnusedReferenceVariables(source('seedanceContent.1.image_url.url'), variables))
      .toEqual(['referenceImageUrls']);
    expect(findUnusedReferenceVariables(source('seedanceContent.1'), variables))
      .toEqual(['referenceImageUrls']);
    expect(findUnusedReferenceVariables(JSON.stringify({ submit: { body: {
      first: '{{seedanceContent.1.image_url.url}}', second: '{{seedanceContent.2.image_url.url}}',
    } } }), variables)).toEqual([]);
  });

  it('reports only missing media types even when every compatibility alias is present', () => {
    expect(findUnusedReferenceVariables(JSON.stringify({
      submit: { body: { images: '{{imageUrls}}' } },
    }), buildVideoReferences(true)).sort()).toEqual(['referenceAudioUrls', 'referenceVideoUrls']);
  });

  it('submits the configured video arrays, polls and downloads with actual runtime variables', async () => {
    const protocol: ModelExecutionProtocol = {
      version: 2, mode: 'async',
      submit: { method: 'POST', path: '/v1/videos', pathMode: 'origin', body: {
        model: '{{model}}', prompt: '{{prompt}}',
        images: '{{imageUrls}}', videos: '{{videoUrls}}', audios: '{{audioUrls}}',
      } },
      response: { type: 'json', taskIdPath: 'id' },
      poll: { method: 'GET', path: '/v1/videos/{{submit.id}}', pathMode: 'origin', response: {
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'],
        result: { download: { method: 'GET', path: '/v1/videos/{{submit.id}}/content', pathMode: 'origin' } },
      } },
    };
    useAppStore.setState({ configHydrated: true, config: {
      ...useAppStore.getState().config,
      providers: { 'custom-reference-fixture': {
        apiKey: 'fixture-key', baseUrl: 'https://gateway.example/v1',
      } },
    } } as never);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'video-fixture', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'video-fixture', status: 'completed' }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'video/mp4' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const variables = buildVideoReferences(true);
    const urls = await runConfiguredModelProtocol({
      category: 'video', variables, model: {
        id: 'reference-fixture', name: 'seedance2.5 超特价10图3视3音',
        modelId: 'seedance2.5 超特价10图3视3音', category: 'video',
        providerConfigId: 'custom-reference-fixture', executionProfile: { preset: 'custom', protocol },
      },
    });
    expect([...urls]).toEqual(['data:video/mp4;base64,AQID']);
    expect(urls.mediaDownloadAccess).toEqual({ providerConfigId: 'custom-reference-fixture', origin: 'https://gateway.example' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      model: variables.model, prompt: variables.prompt,
      images: variables.imageUrls, videos: variables.videoUrls, audios: variables.audioUrls,
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://gateway.example/v1/videos', 'https://gateway.example/v1/videos/video-fixture',
      'https://gateway.example/v1/videos/video-fixture/content',
    ]);
  });

  it('flags reference media that the protocol has no field for', () => {
    const withImageField = JSON.stringify({ submit: { body: { image_urls: '{{imageUrls}}' } } });
    const textOnly = JSON.stringify({ submit: { body: { model: '{{model}}', prompt: '{{prompt}}' } } });
    const variables = {
      imageUrls: ['https://cdn.example/ref.png'],
      referenceImageUrls: ['https://cdn.example/ref.png'],
      videoUrls: [],
    };

    expect(findUnusedReferenceVariables(withImageField, variables)).toEqual([]);
    expect(findUnusedReferenceVariables(textOnly, variables).sort())
      .toEqual(['referenceImageUrls']);
    // 没有连参考素材就不该提示
    expect(findUnusedReferenceVariables(textOnly, { imageUrls: [] })).toEqual([]);
  });

  it('renders the GPT-Image gateway JSON preset with only supplied reference images', () => {
    const protocol = getModelProtocolPreset('gpt-image-gateway-json');
    expect(validateModelExecutionProtocol(protocol)).toEqual([]);
    const built = buildModelProtocolRequest({
      apiKey: 'fixture-key', baseUrl: 'https://gateway.example/v1', protocol,
      variables: { model: 'gpt-image-2', prompt: '画一只猫', size: '1024x1024', n: 1,
        imageUrls: ['https://assets.example/first.png', 'https://assets.example/second.png'] },
    });
    expect(JSON.parse(String(built.init.body))).toMatchObject({
      model: 'gpt-image-2', n: 1, response_format: 'url',
      images: ['https://assets.example/first.png', 'https://assets.example/second.png'],
    });
    expect(built.init.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
  });

  it('keeps the official, Google and xAI image choices as valid distinct requests', () => {
    const official = getModelProtocolPreset('openai-gpt-image');
    const google = getModelProtocolPreset('google-image-native');
    const xai = getModelProtocolPreset('xai-image-native');
    for (const protocol of [official, google, xai]) {
      expect(validateModelExecutionProtocol(protocol)).toEqual([]);
    }
    expect(official.submit.path).toBe('/images/generations');
    expect(official.response.result?.base64Path).toBe('data.*.b64_json');
    expect(google.submit.path).toBe('/v1beta/interactions');
    expect(google.auth).toMatchObject({ type: 'header', name: 'x-goog-api-key' });
    expect(xai.submit.path).toBe('/images/generations');
    expect(xai.auth).toMatchObject({ type: 'bearer' });
  });

  it('treats Seedance content text as prompt data and its typed media as delivered references', () => {
    const protocol = JSON.stringify({ submit: { body: { content: '{{seedanceContent}}' } } });
    expect(findUnusedReferenceVariables(protocol, {
      seedanceContent: [{ type: 'text', text: '镜头向前推进' }],
    })).toEqual([]);
    expect(findUnusedReferenceVariables(protocol, {
      seedanceContent: [
        { type: 'text', text: '镜头向前推进' },
        { type: 'image_url', image_url: { url: 'https://cdn.example/ref.png' } },
      ],
      referenceImageUrls: ['https://cdn.example/ref.png'],
    })).toEqual([]);
  });

  it('checks submit only and requires each provided media group to be consumed', () => {
    const protocol = JSON.stringify({
      submit: {
        body: { image_url: '{{imageUrls.0}}' },
      },
      poll: {
        path: '/tasks/{{submit.task_id}}',
        body: {
          video_url: '{{videoUrls.0}}',
          audio_url: '{{audioUrls.0}}',
        },
      },
    });

    expect(findUnusedReferenceVariables(protocol, {
      imageUrls: ['https://cdn.example/ref.png'],
      videoUrls: ['https://cdn.example/ref.mp4'],
      audioUrls: ['https://cdn.example/ref.mp3'],
    }).sort()).toEqual(['audioUrls', 'videoUrls']);

    const wrongGenericTransport = JSON.stringify({
      submit: { body: { references: '{{referenceUrls}}' } },
    });
    expect(findUnusedReferenceVariables(wrongGenericTransport, {
      imageUrls: ['data:image/png;base64,AAAA'],
      inlineReferences: ['data:image/png;base64,AAAA'],
    })).toEqual(['imageUrls']);
  });

  it('checks first frame, last frame and ordinary reference images independently', () => {
    const protocol = JSON.stringify({
      submit: {
        body: {
          first_frame: '{{firstImage}}',
        },
      },
    });
    expect(findUnusedReferenceVariables(protocol, {
      firstImage: 'https://cdn.example/first.png',
      lastImage: 'https://cdn.example/last.png',
      imageUrls: ['https://cdn.example/first.png', 'https://cdn.example/last.png'],
    })).toEqual(['lastImage']);

    expect(findUnusedReferenceVariables(JSON.stringify({
      submit: { body: { images: '{{imageUrls}}' } },
    }), {
      firstImage: 'https://cdn.example/first.png',
      lastImage: 'https://cdn.example/last.png',
      referenceImageUrls: ['https://cdn.example/reference.png'],
      imageUrls: [
        'https://cdn.example/first.png',
        'https://cdn.example/last.png',
        'https://cdn.example/reference.png',
      ],
    })).toEqual([]);
  });

  it('does not treat .0 as full consumption when a canonical reference array has multiple items', () => {
    const firstOnly = JSON.stringify({
      submit: {
        body: {
          image: '{{referenceImageUrls.0}}',
          video: '{{referenceVideoUrls.0}}',
          audio: '{{referenceAudioUrls.0}}',
        },
      },
    });
    const multiple = {
      referenceImageUrls: ['https://cdn.example/1.png', 'https://cdn.example/2.png'],
      referenceVideoUrls: ['https://cdn.example/1.mp4', 'https://cdn.example/2.mp4'],
      referenceAudioUrls: ['https://cdn.example/1.mp3', 'https://cdn.example/2.mp3'],
    };
    expect(findUnusedReferenceVariables(firstOnly, multiple).sort()).toEqual([
      'referenceAudioUrls',
      'referenceImageUrls',
      'referenceVideoUrls',
    ]);

    expect(findUnusedReferenceVariables(firstOnly, {
      referenceImageUrls: ['https://cdn.example/1.png'],
      referenceVideoUrls: ['https://cdn.example/1.mp4'],
      referenceAudioUrls: ['https://cdn.example/1.mp3'],
    })).toEqual([]);
  });

  it('accepts whole arrays and $forEach values as full canonical reference delivery', () => {
    const protocol = JSON.stringify({
      submit: {
        body: {
          images: '{{referenceImageUrls}}',
          content: [
            {
              $forEach: '{{referenceVideoUrls}}',
              $value: { video_url: { url: '{{referenceVideoUrls}}' } },
            },
            {
              $forEach: '{{referenceAudioUrls}}',
              $value: { audio_url: { url: '{{referenceAudioUrls}}' } },
            },
          ],
        },
      },
    });
    expect(findUnusedReferenceVariables(protocol, {
      referenceImageUrls: ['https://cdn.example/1.png', 'https://cdn.example/2.png'],
      referenceVideoUrls: ['https://cdn.example/1.mp4', 'https://cdn.example/2.mp4'],
      referenceAudioUrls: ['https://cdn.example/1.mp3', 'https://cdn.example/2.mp3'],
    })).toEqual([]);
  });

  it('does not count a $whenPresent condition as transporting the reference', () => {
    const protocol = JSON.stringify({
      submit: {
        body: {
          content: [{
            $whenPresent: '{{referenceImageUrls.0}}',
            $value: { type: 'marker' },
          }],
        },
      },
    });
    expect(findUnusedReferenceVariables(protocol, {
      referenceImageUrls: ['https://cdn.example/ref.png'],
    })).toEqual(['referenceImageUrls']);
  });

  it('reports a local conflict when capability exceeds the $forEach safety ceiling', () => {
    const protocol = {
      submit: {
        body: {
          content: [{
            $forEach: '{{referenceImageUrls}}',
            $value: { image_url: { url: '{{referenceImageUrls}}' } },
          }],
        },
      },
    };
    expect(findModelProtocolForEachCapabilityConflicts(protocol, {
      maxImageReferences: 65,
    })).toContainEqual(expect.stringContaining('maxImageReferences=65'));
    expect(findModelProtocolForEachCapabilityConflicts(protocol, {
      maxImageReferences: 64,
    })).toEqual([]);
    expect(findModelProtocolForEachCapabilityConflicts({
      submit: { body: { images: '{{referenceImageUrls}}' } },
    }, {
      maxImageReferences: 100,
    })).toEqual([]);
  });
});

describe('missing API key', () => {
  it('拦下没有 API Key 的调用，而不是发出不带 Authorization 头的请求', () => {
    const protocol = getModelProtocolPreset('openai-image');
    expect(() => buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://api.example.com/v1',
      protocol,
      variables: { model: 'm', prompt: 'p' },
    })).toThrow('还没有填写 API Key');

    // 协议明确声明不需要鉴权时照常放行
    expect(() => buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://api.example.com/v1',
      protocol: { ...protocol, auth: { type: 'none' } },
      variables: { model: 'm', prompt: 'p' },
    })).not.toThrow();
  });
});

describe('undeliverable reference media', () => {
  it('协议接不住参考素材时直接失败，并给出可抄的修法', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fixture transport failure'));
    vi.stubGlobal('fetch', fetchMock);
    useAppStore.setState({
      configHydrated: true,
      config: {
        ...useAppStore.getState().config,
        providers: {
          'custom-relay': {
            name: 'Relay', apiKey: 'k', baseUrl: 'https://api.example.com',
            catalogId: 'custom-openai', selectedModels: [],
          },
        },
      },
    } as never);
    const model = {
      id: 'm1',
      name: 'Seedance 900',
      modelId: 'lec-seed-2-0-900',
      category: 'video' as const,
      providerConfigId: 'custom-relay',
      executionProfile: {
        preset: 'custom' as const,
        protocol: {
          version: 2 as const,
          mode: 'async' as const,
          // 只映射第 1 项不能代表完整接收多项参考素材。
          submit: {
            method: 'POST' as const,
            path: '/v1/videos',
            body: { model: '{{model}}', prompt: '{{prompt}}', image: '{{imageUrls.0}}' },
          },
          response: { type: 'json' as const, taskIdPath: 'id' },
          poll: {
            method: 'GET' as const,
            path: '/v1/videos/{{submit.id}}',
            response: {
              statusPath: 'status',
              successValues: ['completed'],
              failureValues: ['failed'],
              result: { urlPath: 'output' },
            },
          },
        },
      },
    };

    await expect(runConfiguredModelProtocol({
      model,
      category: 'video',
      variables: {
        model: 'lec-seed-2-0-900',
        prompt: '图片1、图片2，释放法术',
        imageUrls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
      },
    })).rejects.toThrow('没有完整接收参考图');
    await expect(runConfiguredModelProtocol({
      model,
      category: 'video',
      variables: {
        model: 'lec-seed-2-0-900',
        prompt: '图片1、图片2，释放法术',
        imageUrls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
      },
    })).rejects.toThrow('无法完整发送');
    expect(fetchMock).not.toHaveBeenCalled();

    // 空参考进入模拟提交，不访问外网；同时确认前面的校验失败没有发出请求。
    await expect(runConfiguredModelProtocol({
      model,
      category: 'video',
      variables: { model: 'lec-seed-2-0-900', prompt: '释放法术', imageUrls: [] },
    })).rejects.not.toThrow('没有完整接收参考图');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
