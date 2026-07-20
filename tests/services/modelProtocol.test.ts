import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelExecutionProtocol } from '../../src/types/aiTypes';
import {
  executeModelProtocol,
  getModelProtocolPreset,
  normalizeFrames8n1,
  parseModelExecutionProtocol,
  pollResolvedModelProtocol,
  previewModelProtocolRequest,
  previewModelProtocolResponse,
  validateModelExecutionProtocol,
} from '../../src/services/ai/modelProtocol';

const jsonResponse = (
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('declarative model execution protocol', () => {
  it('emits version 2 presets with explicit submit and polling response blocks', () => {
    const protocol = getModelProtocolPreset('agnes-video') as unknown as Record<string, unknown>;
    const poll = protocol.poll as Record<string, unknown>;

    expect(protocol).toMatchObject({
      version: 2,
      mode: 'async',
      response: {
        type: 'json',
        taskIdPath: 'video_id',
      },
    });
    expect(poll.response).toEqual({
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed', 'error'],
      result: { urlPath: 'url', mimeType: 'video/mp4' },
      errorPath: 'error',
      progressPath: 'progress',
    });
    expect(protocol).not.toHaveProperty('taskIdPath');
    expect(poll).not.toHaveProperty('statusPath');
    expect(poll).not.toHaveProperty('resultUrlPath');
  });

  it('upgrades a legacy version 1 protocol to the canonical version 2 response shape', () => {
    const upgraded = parseModelExecutionProtocol({
      version: 1,
      mode: 'async',
      submit: { method: 'POST', path: '/videos', body: { prompt: '{{prompt}}' } },
      taskIdPath: 'video_id',
      errorPath: 'error.message',
      poll: {
        method: 'GET',
        path: '/status',
        statusPath: 'state',
        successValues: ['done'],
        failureValues: ['failed'],
        resultUrlPath: 'output.url',
        resultMimeType: 'video/mp4',
        errorPath: 'error',
        progressPath: 'progress',
      },
    } as ModelExecutionProtocol) as unknown as Record<string, unknown>;
    const poll = upgraded.poll as Record<string, unknown>;

    expect(upgraded).toMatchObject({
      version: 2,
      mode: 'async',
      response: {
        type: 'json',
        taskIdPath: 'video_id',
        errorPath: 'error.message',
      },
    });
    expect(poll.response).toEqual({
      statusPath: 'state',
      successValues: ['done'],
      failureValues: ['failed'],
      result: { urlPath: 'output.url', mimeType: 'video/mp4' },
      errorPath: 'error',
      progressPath: 'progress',
    });
    expect(upgraded).not.toHaveProperty('taskIdPath');
    expect(upgraded).not.toHaveProperty('errorPath');
    expect(poll).not.toHaveProperty('statusPath');
  });

  it('validates the nested version 2 response shape', () => {
    const protocol = {
      version: 2,
      mode: 'sync',
      submit: { method: 'POST', path: '/images', body: { prompt: '{{prompt}}' } },
      response: {
        type: 'json',
        result: { base64Path: 'data.*.b64_json', mimeType: 'image/png' },
        errorPath: 'error.message',
      },
    };

    expect(validateModelExecutionProtocol(protocol)).toEqual([]);
    expect(validateModelExecutionProtocol({
      ...protocol,
      response: { type: 'json', result: { base64Path: 'data.*.b64_json' } },
    })).toContain('Base64 结果必须配置 MIME 类型');
    expect(validateModelExecutionProtocol({
      ...protocol,
      resultUrlPath: 'legacy.url',
    })).toContain('version 2 响应字段必须配置在 response 中');
  });

  it('previews configured synchronous JSON response paths without exposing base64 data', () => {
    const protocol = {
      version: 1,
      mode: 'sync',
      submit: { method: 'POST', path: '/render', body: {} },
      resultUrlPath: 'data.*.url',
      resultTextPath: 'data.0.caption',
      resultBase64Path: 'data.*.b64_json',
      resultMimeType: 'image/png',
      errorPath: 'error.message',
    } as ModelExecutionProtocol;

    const preview = previewModelProtocolResponse(protocol, {
      data: [{
        url: 'https://cdn.example/result.png',
        caption: '生成完成',
        b64_json: 'aGVsbG8=',
      }],
    });

    expect(preview).toEqual([
      {
        id: 'result-url',
        label: 'URL 结果',
        path: 'data.*.url',
        matchCount: 1,
        values: ['https://cdn.example/result.png'],
      },
      {
        id: 'result-text',
        label: '文本结果',
        path: 'data.0.caption',
        matchCount: 1,
        values: ['生成完成'],
      },
      {
        id: 'result-base64',
        label: 'Base64 结果',
        path: 'data.*.b64_json',
        matchCount: 1,
        values: ['[Base64 8 字符]'],
      },
      {
        id: 'submit-error',
        label: '错误信息',
        path: 'error.message',
        matchCount: 0,
        values: [],
      },
    ]);
    expect(JSON.stringify(preview)).not.toContain('aGVsbG8=');
  });

  it('previews asynchronous submit and polling response paths together', () => {
    const protocol = getModelProtocolPreset('agnes-video');

    const preview = previewModelProtocolResponse(protocol, {
      video_id: 'video-1',
      status: 'completed',
      progress: 100,
      url: 'https://cdn.example/video.mp4',
      error: null,
    });

    expect(preview).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task-id', values: ['video-1'] }),
      expect.objectContaining({ id: 'status', values: ['completed'] }),
      expect.objectContaining({ id: 'poll-result-url', values: ['https://cdn.example/video.mp4'] }),
      expect.objectContaining({ id: 'progress', values: ['100'] }),
    ]));
  });

  it('previews a rendered request with masked credentials and no network call', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const protocol: ModelExecutionProtocol = {
      version: 1,
      mode: 'sync',
      auth: { type: 'header', name: 'X-API-Key', prefix: 'Token ' },
      submit: {
        method: 'POST',
        path: '/render',
        query: {
          language: 'zh',
          optional: '{{imageUrls}}',
        },
        body: {
          model: '{{model}}',
          prompt: '{{prompt}}',
          width: '{{width}}',
          height: '{{height}}',
          reference_images: '{{imageUrls}}',
        },
      },
      resultUrlPath: 'data.url',
    };

    const preview = previewModelProtocolRequest({
      baseUrl: 'https://preview.invalid/v1',
      protocol,
      variables: {
        model: 'image-model',
        prompt: 'A glass cube',
        width: 1024,
        height: 768,
      },
    });

    expect(preview).toEqual({
      method: 'POST',
      relativeUrl: '/v1/render?language=zh',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'Token ********',
      },
      body: {
        model: 'image-model',
        prompt: 'A glass cube',
        width: 1024,
        height: 768,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('encodes a rendered request body as application/x-www-form-urlencoded', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      url: 'https://cdn.example/form-image.png',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/render',
        bodyEncoding: 'form-urlencoded',
        body: {
          prompt: '{{prompt}}',
          tags: ['one', 'two'],
          options: { width: '{{width}}', enabled: true },
        },
      },
      resultUrlPath: 'url',
    } as unknown as ModelExecutionProtocol;

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { prompt: '玻璃 cube', width: 1024 },
    });

    expect(result.urls).toEqual(['https://cdn.example/form-image.png']);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    });
    expect(init.body).toBe(
      'prompt=%E7%8E%BB%E7%92%83+cube&tags=one&tags=two&options=%7B%22width%22%3A1024%2C%22enabled%22%3Atrue%7D',
    );
  });

  it('encodes controlled data URL files as multipart form data and redacts preview bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      url: 'https://cdn.example/multipart-image.png',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/edit',
        bodyEncoding: 'multipart',
        body: {
          prompt: '{{prompt}}',
          image: {
            $file: '{{imageUrls.0}}',
            filename: 'reference.txt',
          },
        },
      },
      resultUrlPath: 'url',
    } as unknown as ModelExecutionProtocol;
    const variables = {
      prompt: 'edit it',
      imageUrls: ['data:text/plain;base64,aGVsbG8='],
    };

    const preview = previewModelProtocolRequest({
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables,
    });
    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables,
    });

    expect(preview.body).toEqual({
      prompt: 'edit it',
      image: {
        $file: '[data URL text/plain, 5 bytes]',
        filename: 'reference.txt',
      },
    });
    expect(JSON.stringify(preview.body)).not.toContain('aGVsbG8=');
    expect(result.urls).toEqual(['https://cdn.example/multipart-image.png']);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      'Content-Type': expect.stringMatching(/^multipart\/form-data; boundary=/),
    });
    const bodyText = new TextDecoder().decode(init.body as ArrayBuffer);
    expect(bodyText).toContain('name="prompt"');
    expect(bodyText).toContain('edit it');
    expect(bodyText).toContain('name="image"; filename="reference.txt"');
    expect(bodyText).toContain('Content-Type: text/plain');
    expect(bodyText).toContain('hello');
  });

  it('rejects multipart file sources that are not inline data URLs', async () => {
    const protocol = {
      version: 1,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/edit',
        bodyEncoding: 'multipart',
        body: { image: { $file: '{{imageUrls.0}}' } },
      },
      resultUrlPath: 'url',
    } as unknown as ModelExecutionProtocol;

    await expect(executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { imageUrls: ['C:\\private\\reference.png'] },
    })).rejects.toThrow('multipart 文件只支持 data URL');
  });

  it('extracts a configured JSON base64 result as a data URL', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      output: { image: 'aGVsbG8=' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'sync',
      responseType: 'json',
      submit: { method: 'POST', path: '/render', body: { prompt: '{{prompt}}' } },
      resultBase64Path: 'output.image',
      resultMimeType: 'image/png',
    } as unknown as ModelExecutionProtocol;

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { prompt: 'test' },
    });

    expect(result.urls).toEqual(['data:image/png;base64,aGVsbG8=']);
  });

  it('supports raw text responses without a JSON result path', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('plain model output', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'sync',
      responseType: 'text',
      submit: { method: 'POST', path: '/generate', body: { prompt: '{{prompt}}' } },
    } as unknown as ModelExecutionProtocol;

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { prompt: 'test' },
    });

    expect(result.text).toBe('plain model output');
  });

  it('supports raw synchronous binary responses as media data URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(Uint8Array.from([0, 1, 2, 255]), {
      status: 200,
      headers: { 'Content-Type': 'image/webp' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'sync',
      responseType: 'binary',
      resultMimeType: 'image/png',
      submit: { method: 'POST', path: '/render', body: { prompt: '{{prompt}}' } },
    } as unknown as ModelExecutionProtocol;

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { prompt: 'test' },
    });

    expect(result.urls).toEqual(['data:image/webp;base64,AAEC/w==']);
  });

  it('validates request encodings and response mode compatibility', () => {
    const invalidEncoding = {
      version: 1,
      mode: 'sync',
      submit: { method: 'POST', path: '/render', bodyEncoding: 'xml', body: {} },
      resultUrlPath: 'url',
    };
    const invalidAsyncResponse = {
      ...getModelProtocolPreset('agnes-video'),
      response: {
        ...getModelProtocolPreset('agnes-video').response,
        type: 'binary',
      },
    };
    const missingBase64Mime = {
      version: 1,
      mode: 'sync',
      submit: { method: 'POST', path: '/render', body: {} },
      resultBase64Path: 'data.image',
    };

    expect(validateModelExecutionProtocol(invalidEncoding)).toContain(
      '请求体编码只支持 json、form-urlencoded 或 multipart',
    );
    expect(validateModelExecutionProtocol(invalidAsyncResponse)).toContain(
      '异步协议的提交与轮询响应必须使用 JSON',
    );
    expect(validateModelExecutionProtocol(missingBase64Mime)).toContain(
      'Base64 结果必须配置 MIME 类型',
    );
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
