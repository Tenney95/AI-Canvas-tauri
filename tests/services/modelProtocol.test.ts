import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelExecutionProtocol } from '../../src/types/aiTypes';
import {
  executeModelProtocol,
  getModelProtocolPreset,
  normalizeFrames8n1,
  pollResolvedModelProtocol,
  validateModelExecutionProtocol,
} from '../../src/services/ai/modelProtocol';

const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('declarative model execution protocol', () => {
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

  it('maps size variables into string, split and semantic request fields', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ url: 'https://cdn.example/image.png' }));
    vi.stubGlobal('fetch', fetchMock);

    const protocol = {
      version: 1,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/render',
        headers: {
          'X-Client': 'ai-canvas',
          'X-Optional-Format': '{{audioFormat}}',
        },
        query: { aspect: '{{aspectRatio}}', optional: '{{audioVoice}}' },
        body: {
          model: '{{model}}',
          size: '{{size}}',
          width: '{{width}}',
          height: '{{height}}',
          resolution: '{{imageSize}}',
          aspect_ratio: '{{aspectRatio}}',
          optional_voice: '{{audioVoice}}',
        },
      },
      resultUrlPath: 'url',
    } as unknown as ModelExecutionProtocol;

    await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: {
        model: 'image-model',
        size: '1024x768',
        width: 1024,
        height: 768,
        imageSize: '1K',
        aspectRatio: '4:3',
      },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/render?aspect=4%3A3');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer secret',
      'X-Client': 'ai-canvas',
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('X-Optional-Format');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'image-model',
      size: '1024x768',
      width: 1024,
      height: 768,
      resolution: '1K',
      aspect_ratio: '4:3',
    });
  });

  it.each([
    {
      auth: { type: 'header', name: 'X-API-Key', prefix: 'Token ' },
      expectedUrl: 'https://gateway.example/v1/render',
      expectedHeaders: { 'X-API-Key': 'Token secret' },
    },
    {
      auth: { type: 'query', name: 'key' },
      expectedUrl: 'https://gateway.example/v1/render?key=secret',
      expectedHeaders: {},
    },
    {
      auth: { type: 'none' },
      expectedUrl: 'https://gateway.example/v1/render',
      expectedHeaders: {},
    },
  ])('supports $auth.type authentication without persisting the key', async ({
    auth,
    expectedUrl,
    expectedHeaders,
  }) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ url: 'https://cdn.example/image.png' }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'sync',
      auth,
      submit: { method: 'POST', path: '/render', body: { prompt: '{{prompt}}' } },
      resultUrlPath: 'url',
    } as unknown as ModelExecutionProtocol;

    await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { prompt: 'test' },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedUrl);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject(expectedHeaders);
    if (auth.type !== 'bearer') {
      expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
    }
    expect(JSON.stringify(protocol)).not.toContain('secret');
  });

  it('rejects dangerous static headers and invalid custom authentication names', () => {
    const protocol = {
      version: 1,
      mode: 'sync',
      auth: { type: 'header', name: 'Authorization' },
      submit: {
        method: 'POST',
        path: '/render',
        headers: { Host: 'other.example', Cookie: 'session=secret' },
      },
      resultUrlPath: 'url',
    } as unknown as ModelExecutionProtocol;

    expect(validateModelExecutionProtocol(protocol)).toEqual(expect.arrayContaining([
      expect.stringContaining('Authorization'),
      expect.stringContaining('Host'),
      expect.stringContaining('Cookie'),
    ]));
  });

  it('rejects absolute request paths and unknown template variables', () => {
    const unsafeProtocol: ModelExecutionProtocol = {
      version: 1,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: 'https://other.example/generate',
        body: { prompt: '{{systemPrompt}}' },
      },
      resultUrlPath: 'data.0.url',
    };

    expect(validateModelExecutionProtocol(unsafeProtocol)).toEqual(expect.arrayContaining([
      expect.stringContaining('相对路径'),
      expect.stringContaining('systemPrompt'),
    ]));
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
