import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelExecutionProtocol } from '../../src/types/aiTypes';
import {
  buildModelProtocolRequest,
  executeModelProtocol,
  getDefaultCustomProtocol,
  getModelProtocolPreset,
  modelProtocolUsesVariable,
  normalizeFrames8n1,
  parseModelExecutionProtocol,
  pollResolvedModelProtocol,
  previewModelProtocolRequest,
  previewModelProtocolResponse,
  validateModelExecutionProtocol,
} from '../../src/services/ai/modelProtocol';
import {
  findModelProtocolForEachCapabilityConflicts,
  findUnusedReferenceVariables,
  runConfiguredModelProtocol,
} from '../../src/services/ai/modelProtocolRuntime';
import { useAppStore } from '../../src/store/useAppStore';

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
  it('does not invent an endpoint for a new custom video protocol', () => {
    const protocol = getDefaultCustomProtocol('video');
    expect(protocol.submit.path).toBe('');
    expect(protocol.poll?.path).toBe('');
    expect(validateModelExecutionProtocol(protocol)).toContain('提交请求 path必须是以 / 开头的同源相对路径');
    expect(JSON.stringify(protocol)).not.toContain('/videos/generations');
  });

  it('recognizes dotted variable paths without accepting similar prefixes', () => {
    const source = JSON.stringify({
      image: '{{imageUrls.0}}',
      nested: '{{ imageUrls.0.url }}',
      lookalike: '{{imageUrlsExtra}}',
    });

    expect(modelProtocolUsesVariable(source, 'imageUrls')).toBe(true);
    expect(modelProtocolUsesVariable(source, 'imageUrls.0')).toBe(true);
    expect(modelProtocolUsesVariable('{{imageUrlsExtra}}', 'imageUrls')).toBe(false);
    expect(modelProtocolUsesVariable('{{imageUrls}}', 'imageUrl')).toBe(false);
  });

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
        path: '/status/{{submit.video_id}}',
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

  it('renders video-to-video operation semantics into a custom request', () => {
    const protocol: ModelExecutionProtocol = {
      version: 1,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/videos',
        body: {
          operation: '{{videoOperation}}',
          video_urls: '{{videoUrls}}',
        },
      },
      resultUrlPath: 'data.url',
    };

    const preview = previewModelProtocolRequest({
      baseUrl: 'https://preview.invalid/v1',
      protocol,
      variables: {
        videoOperation: 'video-to-video',
        videoUrls: ['https://cdn.example/reference.mp4'],
      },
    });

    expect(preview.body).toEqual({
      operation: 'video-to-video',
      video_urls: ['https://cdn.example/reference.mp4'],
    });
  });

  it('omits a whole conditional content item when its reference variable is absent', () => {
    const protocol: ModelExecutionProtocol = {
      version: 2,
      mode: 'sync',
      auth: { type: 'none' },
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: {
          content: [
            { type: 'text', text: '{{prompt}}' },
            {
              $whenPresent: '{{imageUrls.0}}',
              $value: {
                type: 'image_url',
                image_url: { url: '{{imageUrls.0}}' },
                role: 'first_frame',
              },
            },
          ],
        },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    };

    const withoutReference = buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com/v1',
      protocol,
      variables: { prompt: '挥手', imageUrls: [] },
    });
    expect(withoutReference.renderedBody).toEqual({
      content: [{ type: 'text', text: '挥手' }],
    });

    const withReference = buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com/v1',
      protocol,
      variables: { prompt: '挥手', imageUrls: ['https://cdn.example.com/first.png'] },
    });
    expect(withReference.renderedBody).toEqual({
      content: [
        { type: 'text', text: '挥手' },
        {
          type: 'image_url',
          image_url: { url: 'https://cdn.example.com/first.png' },
          role: 'first_frame',
        },
      ],
    });
  });

  it('renders conditional array items before form and multipart serialization', () => {
    const formProtocol: ModelExecutionProtocol = {
      version: 2,
      mode: 'sync',
      auth: { type: 'none' },
      submit: {
        method: 'POST',
        path: '/form-video',
        bodyEncoding: 'form-urlencoded',
        body: {
          references: [{
            $whenPresent: '{{imageUrls.0}}',
            $value: '{{imageUrls.0}}',
          }],
        },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    };
    const withoutFormReference = buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com',
      protocol: formProtocol,
      variables: { imageUrls: [] },
    });
    expect(withoutFormReference.renderedBody).toEqual({ references: [] });
    expect(String(withoutFormReference.init.body)).toBe('');

    const withFormReference = buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com',
      protocol: formProtocol,
      variables: { imageUrls: ['https://cdn.example.com/ref.png'] },
    });
    expect(new URLSearchParams(String(withFormReference.init.body)).getAll('references'))
      .toEqual(['https://cdn.example.com/ref.png']);

    const multipartProtocol: ModelExecutionProtocol = {
      ...formProtocol,
      submit: {
        method: 'POST',
        path: '/multipart-video',
        bodyEncoding: 'multipart',
        body: {
          images: [{
            $whenPresent: '{{imageUrls.0}}',
            $value: {
              $file: '{{imageUrls.0}}',
              filename: 'reference.txt',
            },
          }],
        },
      },
    };
    expect(previewModelProtocolRequest({
      baseUrl: 'https://relay.example.com',
      protocol: multipartProtocol,
      variables: { imageUrls: [] },
    }).body).toEqual({ images: [] });
    expect(previewModelProtocolRequest({
      baseUrl: 'https://relay.example.com',
      protocol: multipartProtocol,
      variables: { imageUrls: ['data:text/plain;base64,aGVsbG8='] },
    }).body).toEqual({
      images: [{
        $file: '[data URL text/plain, 5 bytes]',
        filename: 'reference.txt',
      }],
    });
  });

  it('expands trusted reference URL arrays into ordered JSON content objects', () => {
    const protocol: ModelExecutionProtocol = {
      version: 2,
      mode: 'sync',
      auth: { type: 'none' },
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: {
          content: [
            { type: 'text', text: '{{prompt}}' },
            {
              $forEach: '{{referenceImageUrls}}',
              $value: {
                type: 'image_url',
                image_url: { url: '{{referenceImageUrls}}' },
                role: 'reference_image',
              },
            },
            {
              $forEach: '{{referenceVideoUrls}}',
              $value: {
                type: 'video_url',
                video_url: { url: '{{referenceVideoUrls}}' },
                role: 'reference_video',
              },
            },
            {
              $forEach: '{{referenceAudioUrls}}',
              $value: {
                type: 'audio_url',
                audio_url: { url: '{{referenceAudioUrls}}' },
                role: 'reference_audio',
              },
            },
          ],
        },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    };

    expect(buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com/v1',
      protocol,
      variables: { prompt: '挥手' },
    }).renderedBody).toEqual({ content: [{ type: 'text', text: '挥手' }] });

    expect(buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com/v1',
      protocol,
      variables: {
        prompt: '挥手',
        referenceImageUrls: ['https://cdn.example.com/1.png', 'https://cdn.example.com/2.png'],
        referenceVideoUrls: ['https://cdn.example.com/1.mp4'],
        referenceAudioUrls: ['https://cdn.example.com/1.mp3'],
      },
    }).renderedBody).toEqual({
      content: [
        { type: 'text', text: '挥手' },
        { type: 'image_url', image_url: { url: 'https://cdn.example.com/1.png' }, role: 'reference_image' },
        { type: 'image_url', image_url: { url: 'https://cdn.example.com/2.png' }, role: 'reference_image' },
        { type: 'video_url', video_url: { url: 'https://cdn.example.com/1.mp4' }, role: 'reference_video' },
        { type: 'audio_url', audio_url: { url: 'https://cdn.example.com/1.mp3' }, role: 'reference_audio' },
      ],
    });
  });

  it.each([
    {
      label: 'untrusted source root',
      directive: {
        $forEach: '{{prompt}}',
        $value: { url: '{{prompt}}' },
      },
      bodyEncoding: undefined,
      error: '$forEach 必须是 referenceImageUrls',
    },
    {
      label: 'dotted source path',
      directive: {
        $forEach: '{{referenceImageUrls.0}}',
        $value: { url: '{{referenceImageUrls.0}}' },
      },
      bodyEncoding: undefined,
      error: '$forEach 必须是 referenceImageUrls',
    },
    {
      label: 'source is not consumed',
      directive: {
        $forEach: '{{referenceImageUrls}}',
        $value: { url: 'https://fixed.example/ref.png' },
      },
      bodyEncoding: undefined,
      error: '必须使用完整模板 {{referenceImageUrls}}',
    },
    {
      label: 'scalar output',
      directive: {
        $forEach: '{{referenceImageUrls}}',
        $value: '{{referenceImageUrls}}',
      },
      bodyEncoding: undefined,
      error: '$value 必须是 JSON 对象',
    },
    {
      label: 'non-json body',
      directive: {
        $forEach: '{{referenceImageUrls}}',
        $value: { url: '{{referenceImageUrls}}' },
      },
      bodyEncoding: 'form-urlencoded' as const,
      error: '数组展开项只支持 JSON 请求体',
    },
  ])('rejects unsafe array expansion directives: $label', ({ directive, bodyEncoding, error }) => {
    expect(validateModelExecutionProtocol({
      version: 2,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/video_generation',
        ...(bodyEncoding ? { bodyEncoding } : {}),
        body: { content: [directive] },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    })).toContainEqual(expect.stringContaining(error));
  });

  it('rejects non-array and oversized runtime values for array expansion', () => {
    const protocol: ModelExecutionProtocol = {
      version: 2,
      mode: 'sync',
      auth: { type: 'none' },
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: {
          content: [{
            $forEach: '{{referenceImageUrls}}',
            $value: { url: '{{referenceImageUrls}}' },
          }],
        },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    };

    expect(() => buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com',
      protocol,
      variables: { referenceImageUrls: 'https://cdn.example.com/ref.png' },
    })).toThrow('必须是字符串数组');
    expect(() => buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com',
      protocol,
      variables: {
        referenceImageUrls: Array.from({ length: 65 }, (_, index) => `https://cdn.example.com/${index}.png`),
      },
    })).toThrow('最多允许 64 项');
  });

  it('allows array expansion only as a direct body array item', () => {
    const directive = {
      $forEach: '{{referenceImageUrls}}',
      $value: { url: '{{referenceImageUrls}}' },
    };
    expect(validateModelExecutionProtocol({
      version: 2,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: { nested: directive },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    })).toContainEqual(expect.stringContaining('数组展开项只能用于请求体数组元素'));

    expect(validateModelExecutionProtocol({
      version: 2,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: {
          content: [{
            ...directive,
            $whenPresent: '{{referenceImageUrls.0}}',
          }],
        },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    })).toContainEqual(expect.stringContaining('必须且只能包含 $forEach 和 $value'));
  });

  it('validates maxBodyBytes as a bounded positive integer', () => {
    for (const maxBodyBytes of [0, -1, 1.5, 512 * 1024 * 1024 + 1]) {
      expect(validateModelExecutionProtocol({
        version: 2,
        mode: 'sync',
        submit: {
          method: 'POST',
          path: '/video_generation',
          maxBodyBytes,
          body: { prompt: '{{prompt}}' },
        },
        response: { type: 'json', result: { urlPath: 'url' } },
      })).toContainEqual(expect.stringContaining('maxBodyBytes 必须是'));
    }
    expect(validateModelExecutionProtocol({
      version: 2,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/video_generation',
        maxBodyBytes: 64 * 1024 * 1024,
        body: { prompt: '{{prompt}}' },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    })).toEqual([]);
  });

  it('rejects maxBodyBytes for multipart and poll requests', () => {
    expect(validateModelExecutionProtocol({
      version: 2,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/video_generation',
        bodyEncoding: 'multipart',
        maxBodyBytes: 1024,
        body: { prompt: '{{prompt}}' },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    })).toContainEqual(expect.stringContaining('multipart 时不支持 maxBodyBytes'));

    expect(validateModelExecutionProtocol({
      version: 2,
      mode: 'async',
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: { prompt: '{{prompt}}' },
      },
      response: { type: 'json', taskIdPath: 'task_id' },
      poll: {
        method: 'POST',
        path: '/query/video_generation',
        maxBodyBytes: 1024,
        body: { task_id: '{{submit.task_id}}' },
        response: {
          statusPath: 'status',
          successValues: ['completed'],
          failureValues: ['failed'],
          result: { urlPath: 'url' },
        },
      },
    })).toContainEqual(expect.stringContaining('轮询请求不支持 maxBodyBytes'));
  });

  it('blocks an oversized submit using the actual serialized UTF-8 byte length', () => {
    const rendered = { prompt: '猫' };
    const actualBytes = new TextEncoder().encode(JSON.stringify(rendered)).byteLength;
    const protocol: ModelExecutionProtocol = {
      version: 2,
      mode: 'sync',
      auth: { type: 'none' },
      submit: {
        method: 'POST',
        path: '/video_generation',
        maxBodyBytes: actualBytes - 1,
        body: { prompt: '{{prompt}}' },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    };

    expect(() => buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com',
      protocol,
      variables: { prompt: '猫' },
    })).toThrow(`序列化后为 ${actualBytes} 字节`);

    protocol.submit.maxBodyBytes = actualBytes;
    expect(buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com',
      protocol,
      variables: { prompt: '猫' },
    }).init.body).toBe(JSON.stringify(rendered));
  });

  it.each([
    {
      label: 'missing value',
      directive: { $whenPresent: '{{imageUrls.0}}' },
      error: '条件项必须且只能包含',
    },
    {
      label: 'missing condition',
      directive: { $value: {} },
      error: '条件项必须且只能包含',
    },
    {
      label: 'non-template condition',
      directive: { $whenPresent: 'imageUrls.0', $value: {} },
      error: '$whenPresent 必须是一个完整的受信变量模板',
    },
    {
      label: 'unknown variable root',
      directive: { $whenPresent: '{{unknownReferences.0}}', $value: {} },
      error: '使用了不允许的变量 unknownReferences.0',
    },
    {
      label: 'blocked path segment',
      directive: { $whenPresent: '{{imageUrls.__proto__}}', $value: {} },
      error: '使用了不安全的变量路径 imageUrls.__proto__',
    },
  ])('rejects malformed conditional content directives: $label', ({ directive, error }) => {
    const invalid = {
      version: 2,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: {
          content: [directive],
        },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    };

    expect(validateModelExecutionProtocol(invalid)).toContainEqual(expect.stringContaining(error));
  });

  it.each([
    {
      label: 'query',
      submit: {
        method: 'POST',
        path: '/video_generation',
        query: {
          optional: { $whenPresent: '{{imageUrls.0}}', $value: 'yes' },
        },
        body: {},
      },
    },
    {
      label: 'whole body',
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: { $whenPresent: '{{imageUrls.0}}', $value: { image: '{{imageUrls.0}}' } },
      },
    },
    {
      label: 'ordinary object field',
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: {
          optional: { $whenPresent: '{{imageUrls.0}}', $value: { image: '{{imageUrls.0}}' } },
        },
      },
    },
  ])('allows conditional directives only in body array items: $label', ({ submit }) => {
    expect(validateModelExecutionProtocol({
      version: 2,
      mode: 'sync',
      submit,
      response: { type: 'json', result: { urlPath: 'url' } },
    })).toContainEqual(expect.stringContaining('条件项只能用于请求体数组元素'));
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

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
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

    // 没有参考素材时照常放行（会走到网络层，这里只验证没被参考素材检查拦下）
    await expect(runConfiguredModelProtocol({
      model,
      category: 'video',
      variables: { model: 'lec-seed-2-0-900', prompt: '释放法术', imageUrls: [] },
    })).rejects.not.toThrow('没有完整接收参考图');
  });
});
