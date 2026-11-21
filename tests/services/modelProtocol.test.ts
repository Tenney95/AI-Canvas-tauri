/**
 * modelProtocol — 回归测试：声明式协议、共享基础规则与执行边界。
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ModelExecutionProfile, ModelExecutionProtocol, ProtocolJsonValue } from '../../src/types/aiTypes';
import {
  buildModelProtocolRequest,
  comparableProtocol,
  resolveModelExecutionProfile,
  executeModelProtocol,
  getDefaultCustomProtocol,
  getModelProtocolPreset,
  modelProtocolUsesVariable,
  parseModelExecutionProtocol,
  previewModelProtocolRequest,
  previewModelProtocolResponse,
  validateModelExecutionProtocol,
} from '../../src/services/ai/modelProtocol';
import { createWorkflowApiDraft } from '../../src/services/workflowApi/workflowApiDefinition';
import { readModelProtocolPathValues } from '../../src/services/ai/modelProtocolResponse';
import { isRecord } from '../../src/services/ai/modelProtocolShared';
import { serializeModelProtocolBody } from '../../src/services/ai/modelProtocolBody';
import { ModelProtocolHttpError, throwIfDefinitiveModelResponseFailure } from '../../src/services/ai/modelProtocolHttp';
import {
  assertImageModelCapability,
  assertModelCapabilityProtocol,
  resolveConfiguredImageParameters,
  resolveConfiguredImageQuality,
  resolveConfiguredImageBackground,
} from '../../src/services/ai/modelCapabilityValidation';
import { jsonResponse, setupProtocolFixture } from './modelProtocol/protocolFixture';

setupProtocolFixture();

it('does not execute plugin references as declarative JSON or a default image preset', () => {
  const profile = { preset: 'plugin' as const, plugin: { pluginId: 'example.responses', presetId: 'responses' } };
  expect(() => resolveModelExecutionProfile(profile)).toThrow('原生活动');
  expect(() => getModelProtocolPreset('plugin' as never)).toThrow('不支持');
  expect(comparableProtocol(profile)).toContain('example.responses');
});

it('结构化批项拒绝使用数值下标errorPath保留上游原文与失败元数据', () => {
  const message = 'Non posso generare questa immagine per motivi di sicurezza.';
  let error: unknown;
  try {
    throwIfDefinitiveModelResponseFailure({ data: [{ error: { code: 'content_policy_violation', message } }] }, 200, 'data.0.error.message');
  } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(ModelProtocolHttpError);
  expect(error).toMatchObject({ status: 200, definitiveFailure: true, message });
});

describe('declarative model execution protocol', () => {
  it('checks video ratio mappings across reachable operations and input modes', () => {
    const protocol: ModelExecutionProtocol = { version: 2, mode: 'sync',
      submit: { method: 'POST', path: '/videos', body: { prompt: '{{prompt}}', aspect_ratio: '16:9' } },
      response: { type: 'json', result: { urlPath: 'url' } } };
    const model = { id: 'custom-video', name: 'Custom Video', provider: 'custom', category: 'video' as const,
      executionProfile: { preset: 'custom' as const, protocol } };

    const operationMulti = { operations: ['text-to-video' as const], supportsStandaloneAudio: false,
      operationCapabilities: { 'text-to-video': { ratios: ['16:9', '9:16'] } } };
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: operationMulti })).toThrow('可调比例');

    const operationSingles = { operations: ['text-to-video' as const, 'image-to-video' as const],
      supportsStandaloneAudio: false, allowFrameAndReferenceMix: false,
      operationCapabilities: { 'text-to-video': { ratios: ['16:9'] }, 'image-to-video': { ratios: ['9:16'] } } };
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: operationSingles })).toThrow('可调比例');

    const differentModes = { operations: ['image-to-video' as const], allowFrameAndReferenceMix: false,
      inputModeCapabilities: { keyframe: { ratios: ['16:9'] }, reference: { ratios: ['9:16'] } } };
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: differentModes })).toThrow('可调比例');

    protocol.submit.body = { prompt: '{{prompt}}', aspect_ratio: '{{aspectRatio}}' };
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: operationMulti })).not.toThrow();
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: operationSingles })).not.toThrow();
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: differentModes })).not.toThrow();

    protocol.submit.body = { prompt: '{{prompt}}', aspect_ratio: '16:9' };
    const singleReachable = { operations: ['text-to-video' as const], supportsStandaloneAudio: false,
      ratios: ['9:16'], operationCapabilities: { 'text-to-video': { ratios: ['16:9'] },
        'video-to-video': { ratios: ['9:16'] } } };
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: singleReachable })).not.toThrow();
    const singleMode = { operations: ['text-to-video' as const], supportsStandaloneAudio: false,
      operationCapabilities: { 'text-to-video': { ratios: ['16:9', '9:16'] } },
      inputModeCapabilities: { text: { ratios: ['16:9'] } } };
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: singleMode })).not.toThrow();
  });

  it('checks fixed pixel combinations without inventing pixels for adaptive image ratios', () => {
    const capability = { resolutions: ['2K'], ratios: ['1:1', 'auto', 'adaptive'],
      dimensionPresets: { '2K': { '1:1': [2048, 2048] as const } } };
    expect(() => assertImageModelCapability(capability)).not.toThrow();
    expect(() => assertImageModelCapability({ ...capability, ratios: ['16:9'] })).toThrow('缺少像素尺寸映射');
  });

  it('keeps interface-default background distinct from an explicit auto parameter', () => {
    const capability = { backgrounds: ['auto', 'opaque', 'transparent'] };
    expect(resolveConfiguredImageBackground(undefined, 'transparent')).toBeUndefined();
    expect(resolveConfiguredImageBackground({}, 'transparent')).toBeUndefined();
    expect(resolveConfiguredImageBackground(capability)).toBeUndefined();
    expect(resolveConfiguredImageBackground({ ...capability, defaultBackground: 'opaque' })).toBe('opaque');
    expect(resolveConfiguredImageBackground({ ...capability, defaultBackground: 'opaque' }, '')).toBeUndefined();
    expect(resolveConfiguredImageBackground(capability, 'AUTO')).toBe('auto');
    expect(resolveConfiguredImageParameters(capability, { count: 1, imageBackground: 'TRANSPARENT' }))
      .toMatchObject({ imageBackground: 'transparent' });
    expect(resolveConfiguredImageParameters(capability, { count: 1, imageBackground: '' })).not.toHaveProperty('imageBackground');
    expect(() => resolveConfiguredImageBackground(capability, 'white')).toThrow('不支持背景');
    expect(() => assertImageModelCapability({ backgrounds: ['auto', 'AUTO'] })).toThrow('backgrounds');
    expect(() => assertImageModelCapability({ backgrounds: ['transparent'], defaultBackground: 'auto' })).toThrow('defaultBackground');
    // 质量/背景单独解析时不能触发既有 auto 比例像素表的完整校验。
    expect(resolveConfiguredImageBackground({ ...capability, ratios: ['auto'], resolutions: ['1K'], dimensionPresets: { '1K': {} } }, 'transparent'))
      .toBe('transparent');
  });

  it('requires a single adjustable transparent option to map background and preserves same-value fixed contracts', () => {
    const protocol = getModelProtocolPreset('openai-gpt-image');
    const model = { id: 'custom-image', name: 'Custom Image', provider: 'custom', category: 'image' as const,
      imageCapability: { backgrounds: ['transparent'] }, executionProfile: { preset: 'custom' as const, protocol } };
    expect(() => assertModelCapabilityProtocol(model)).not.toThrow();
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}' };
    expect(() => assertModelCapabilityProtocol(model)).toThrow('{{imageBackground}}');
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}', background: '{{imageQuality}}' };
    expect(() => assertModelCapabilityProtocol(model)).toThrow('{{imageBackground}}');
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}', background: 'transparent' };
    expect(() => assertModelCapabilityProtocol(model)).not.toThrow();
    expect(() => assertModelCapabilityProtocol({ ...model, imageCapability: { backgrounds: ['opaque', 'transparent'] } }))
      .toThrow('{{imageBackground}}');
  });

  it('rejects a declared or fixed transparent background with explicit JPEG without rewriting the protocol', () => {
    const protocol = getModelProtocolPreset('openai-gpt-image');
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}', background: '{{imageBackground}}', output_format: 'jpeg' };
    const model = { id: 'custom-image', name: 'Custom Image', provider: 'custom', category: 'image' as const,
      imageCapability: { backgrounds: ['transparent'] }, executionProfile: { preset: 'custom' as const, protocol } };
    expect(() => assertModelCapabilityProtocol(model)).toThrow('透明背景不能与固定 output_format: jpeg');
    expect(protocol.submit.body).toHaveProperty('output_format', 'jpeg');
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}', background: 'transparent', output_format: 'jpeg' };
    expect(() => assertModelCapabilityProtocol({ ...model, imageCapability: undefined })).toThrow('透明背景不能与固定 output_format: jpeg');
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}', background: '{{imageBackground}}', output_format: 'png' };
    expect(() => assertModelCapabilityProtocol(model)).not.toThrow();
  });

  it.each(['openai-image', 'openai-gpt-image', 'gpt-image-gateway-json'] as const)('maps optional %s background independently', (preset) => {
    const protocol = getModelProtocolPreset(preset);
    const variables = { model: 'image-model', prompt: 'draft', size: '2048x2048', imageQuality: 'high', imageBackground: 'transparent' };
    const request = buildModelProtocolRequest({ apiKey: 'fixture', baseUrl: 'https://gateway.example/v1', protocol, variables });
    expect(JSON.parse(String(request.init.body))).toMatchObject({ quality: 'high', background: 'transparent' });
    const omitted = buildModelProtocolRequest({ apiKey: 'fixture', baseUrl: 'https://gateway.example/v1', protocol,
      variables: { ...variables, imageBackground: undefined } });
    expect(JSON.parse(String(omitted.init.body))).not.toHaveProperty('background');
  });

  it('resolves declared image quality without inventing a channel default', () => {
    const capability = { qualities: ['low', 'medium', 'high'] };
    expect(resolveConfiguredImageQuality(undefined, 'max')).toBeUndefined();
    expect(resolveConfiguredImageQuality({}, 'high')).toBeUndefined();
    expect(resolveConfiguredImageQuality(capability)).toBeUndefined();
    expect(resolveConfiguredImageQuality({ ...capability, defaultQuality: 'medium' })).toBe('medium');
    expect(resolveConfiguredImageParameters(capability, { imageSize: '2K', imageQuality: 'HIGH', count: 1 }))
      .toMatchObject({ imageSize: '2K', imageQuality: 'high' });
    expect(() => resolveConfiguredImageQuality(capability, 'max')).toThrow('不支持质量 max');
    expect(() => assertImageModelCapability({ qualities: ['high', 'HIGH'] })).toThrow('qualities');
    expect(() => assertImageModelCapability({ qualities: ['low'], defaultQuality: 'max' })).toThrow('defaultQuality');
  });

  it('requires adjustable quality to consume its own variable instead of resolution', () => {
    const protocol = getModelProtocolPreset('openai-gpt-image');
    const model = { id: 'custom-image', name: 'Custom Image', provider: 'custom', category: 'image' as const,
      imageCapability: { qualities: ['low', 'high'] }, executionProfile: { preset: 'custom' as const, protocol } };
    expect(() => assertModelCapabilityProtocol(model)).not.toThrow();
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}', quality: '{{imageSize}}' };
    expect(() => assertModelCapabilityProtocol(model)).toThrow('{{imageQuality}}');
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}', quality: 'high' };
    expect(() => assertModelCapabilityProtocol({ ...model, imageCapability: { qualities: ['high'], defaultQuality: 'high' } })).not.toThrow();
  });

  it.each(['openai-image', 'openai-gpt-image', 'gpt-image-gateway-json'] as const)('maps %s quality and omits it when undeclared', (preset) => {
    const protocol = getModelProtocolPreset(preset);
    const variables = { model: 'image-model', prompt: 'draft', size: '2048x2048', imageSize: '2K', imageQuality: 'max', n: 1 };
    const request = buildModelProtocolRequest({ apiKey: 'fixture', baseUrl: 'https://gateway.example/v1', protocol, variables });
    expect(JSON.parse(String(request.init.body))).toMatchObject({ size: '2048x2048', quality: 'max' });
    const omitted = buildModelProtocolRequest({ apiKey: 'fixture', baseUrl: 'https://gateway.example/v1', protocol, variables: { ...variables, imageQuality: undefined } });
    expect(JSON.parse(String(omitted.init.body))).not.toHaveProperty('quality');
  });

  it.each([
    ['data.results.0.url', ['https://cdn.example/first.mp4']],
    ['data.results[0].url', ['https://cdn.example/first.mp4']],
    ['data.results.*.url', ['https://cdn.example/first.mp4', 'https://cdn.example/second.mp4']],
    ['data.results[*].url', ['https://cdn.example/first.mp4', 'https://cdn.example/second.mp4']],
  ])('previews workflow result path %s', (path, expected) => {
    const protocol = parseModelExecutionProtocol(createWorkflowApiDraft().manifest.protocol);
    expect(protocol.poll!.response.result.urlPath).toBe('data.results.0.url');
    protocol.poll!.response.result.urlPath = path;
    expect(validateModelExecutionProtocol(protocol)).toEqual([]);
    const preview = previewModelProtocolResponse(protocol, {
      data: { status: 'completed', results: [
        { url: 'https://cdn.example/first.mp4' },
        { url: 'https://cdn.example/second.mp4' },
      ] },
    });
    expect(preview.find((entry) => entry.id === 'poll-result-url')).toMatchObject({
      matchCount: expected.length, values: expected,
    });
  });

  it('keeps missing and unsafe bracket paths from matching', () => {
    const payload = { data: { results: [{ url: 'https://cdn.example/first.mp4' }] } };
    expect(readModelProtocolPathValues(payload, 'data.results[9].url')).toEqual([]);
    expect(readModelProtocolPathValues({ data: { results: [] } }, 'data.results[*].url')).toEqual([]);
    expect(readModelProtocolPathValues(payload, 'data.results[*].constructor')).toEqual([]);
    expect(readModelProtocolPathValues(payload, 'data.results[0].__proto__')).toEqual([]);
  });

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

  it('encodes file arrays and redacts every file in multipart previews', () => {
    const protocol = {
      version: 1, mode: 'sync',
      submit: { method: 'POST', path: '/edit', bodyEncoding: 'multipart',
        body: { 'image[]': { $file: '{{imageUrls}}', filename: 'reference.png' } },
      },
      resultUrlPath: 'url',
    } as unknown as ModelExecutionProtocol;
    const options = { baseUrl: 'https://gateway.example', protocol, variables: {
      imageUrls: ['data:image/png;base64,aGVsbG8=', 'data:image/jpeg;base64,d29ybGQ='],
    } };
    const preview = previewModelProtocolRequest(options);
    expect(preview.body).toEqual({ 'image[]': [
      { $file: '[data URL image/png, 5 bytes]', filename: 'reference.png' },
      { $file: '[data URL image/jpeg, 5 bytes]', filename: 'reference.jpg' },
    ] });
    expect(JSON.stringify(preview)).not.toContain('aGVsbG8=');
    expect(JSON.stringify(preview)).not.toContain('d29ybGQ=');
    expect(() => buildModelProtocolRequest({ ...options, apiKey: 'secret',
      variables: { imageUrls: ['data:image/png;base64,aGVsbG8=', '/private/image.png'] },
    })).toThrow('multipart 文件只支持 data URL');
    const empty = buildModelProtocolRequest({ ...options, apiKey: 'secret', variables: { imageUrls: [] } });
    expect(new TextDecoder().decode(empty.init.body as ArrayBuffer)).not.toContain('filename=');
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
});

describe('协议共享基础规则', () => {
  it('比较完整规范协议时忽略对象键序，保留数组顺序且不改写输入', () => {
    const base = getDefaultCustomProtocol('image');
    const profile = (body: ProtocolJsonValue): ModelExecutionProfile => ({
      preset: 'custom', protocol: { ...structuredClone(base), submit: { ...base.submit, body } },
    });
    const original = profile({ model: '{{model}}', prompt: '{{prompt}}', nested: { z: 2, a: 1 }, refs: ['A', 'B'] });
    const reordered = profile({ refs: ['A', 'B'], nested: { a: 1, z: 2 }, prompt: '{{prompt}}', model: '{{model}}' });
    const changed = profile({ refs: ['B', 'A'], nested: { a: 1, z: 2 }, prompt: '{{prompt}}', model: '{{model}}' });
    const before = structuredClone(original);
    const comparable = comparableProtocol(original);
    expect(comparable).toBeDefined();
    expect(comparableProtocol(reordered)).toBe(comparable);
    expect(comparableProtocol(changed)).not.toBe(comparable);
    expect(original).toEqual(before);
  });

  it('未配置、无自定义协议及原生文本协议均不产生比较键', () => {
    const profiles: Array<ModelExecutionProfile | undefined> = [
      undefined, { preset: 'custom' }, { preset: 'openai-responses' }, { preset: 'anthropic-chat' }, { preset: 'gemini-chat' },
    ];
    for (const profile of profiles) expect(comparableProtocol(profile)).toBeUndefined();
  });

  it('已知 JSON 保留成员类型，未知对象的成员仍是 unknown', () => {
    const known = JSON.parse('{"value":[1]}') as ProtocolJsonValue | undefined;
    if (!isRecord(known)) throw new Error('JSON 对象未被识别');
    expectTypeOf(known).toEqualTypeOf<Record<string, ProtocolJsonValue>>();
    expect(known.value).toEqual([1]);

    const unknownValue: unknown = { value: () => 'callable' };
    if (!isRecord(unknownValue)) throw new Error('对象未被识别');
    expectTypeOf(unknownValue).toEqualTypeOf<Record<string, unknown>>();
    expect(typeof unknownValue.value).toBe('function');
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
  });

  it.each(['__proto__', 'prototype', 'constructor'])('校验与响应读取均拒绝自身危险字段 %s', (segment) => {
    const payload: unknown = JSON.parse(`{"data":{"${segment}":{"url":"https://cdn.example/result.png"}}}`);
    const path = `data.${segment}.url`;
    expect(readModelProtocolPathValues(payload, path)).toEqual([]);
    const protocol = getDefaultCustomProtocol('image');
    protocol.response.result = { urlPath: path };
    expect(validateModelExecutionProtocol(protocol).some((error) => error.includes('不允许的路径片段'))).toBe(true);
  });

  it.each(['image/png\r\nInjected: yes', 'image', 'image/png; charset=utf-8'])('校验与 multipart 编码均拒绝无效 MIME %s', (mimeType) => {
    const protocol = getDefaultCustomProtocol('image');
    protocol.response.result = { base64Path: 'data.0.b64_json', mimeType };
    expect(validateModelExecutionProtocol(protocol).some((error) => error.includes('MIME'))).toBe(true);
    expect(() => serializeModelProtocolBody({
      file: { $file: 'data:image/png;base64,AA==', contentType: mimeType },
    }, 'multipart', {})).toThrow('contentType 无效');
  });
});
