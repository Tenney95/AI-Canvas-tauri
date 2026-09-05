import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearProviderConfigDraftsForTests,
  createProviderConfigDraft,
  getProviderConfigDraft,
  mergeProviderModels,
  type ProviderConfigDraftInput,
} from '../../../src/services/chat/providerConfigDraftService';
import { buildModelProtocolRequest } from '../../../src/services/ai/modelProtocol';
import type { ModelExecutionProtocol, VideoModelCapability } from '../../../src/types/aiTypes';
import type { ProviderModelSelection } from '../../../src/types';

describe('provider model field merge', () => {
  const existing: ProviderModelSelection = {
    id: 'chat-a', name: 'My Chat', category: 'text', provider: 'custom-current',
    description: 'Manual description', descriptionManual: true,
    inputModalities: ['text', 'image'], inputModalitiesManual: true, contextWindow: 128000,
  };

  it('preserves omitted and undefined fields while applying explicitly changed fields', () => {
    const draft = { id: existing.id, name: 'Updated Chat', category: 'text' as const,
      provider: existing.provider, description: undefined };
    const result = mergeProviderModels([existing], [draft]);
    expect(result.merged[0]).toEqual({ ...existing, name: 'Updated Chat' });
    expect(result.updatedIds).toEqual([existing.id]);
    expect(existing.name).toBe('My Chat');
  });

  it('clears an old per-model execution profile only when the draft explicitly controls that field', () => {
    const previous: ProviderModelSelection = {
      ...existing,
      executionProfile: {
        preset: 'custom',
        protocol: {
          version: 2,
          mode: 'sync',
          auth: { type: 'bearer' },
          submit: { method: 'POST', path: '/chat/completions' },
          response: { type: 'json', result: { textPath: 'choices.0.message.content' } },
        },
      },
    };
    const draft: ProviderModelSelection = { ...existing, executionProfile: undefined };
    const result = mergeProviderModels([previous], [draft], {
      [existing.id]: ['provider', 'executionProfile'],
    });

    expect(result.updatedIds).toEqual([existing.id]);
    expect(result.fieldChanges[0]?.updated).toEqual(['executionProfile']);
    expect(result.merged[0].executionProfile).toBeUndefined();
  });

  it('treats an otherwise identical partial draft as unchanged', () => {
    const draft = { id: existing.id, name: existing.name, category: existing.category, provider: existing.provider };
    const result = mergeProviderModels([existing], [draft]);
    expect(result.unchangedIds).toEqual([existing.id]);
    expect(result.merged[0]).toBe(existing);
  });

  it('honors an explicitly empty description without deleting unrelated settings', () => {
    const result = mergeProviderModels([existing], [{ ...existing, description: '' }]);
    expect(result.merged[0]).toEqual({ ...existing, description: '' });
  });

  it('does not overwrite a manual category using only an inferred category', () => {
    expect(() => mergeProviderModels([existing], [{ ...existing, category: 'image' }], {
      [existing.id]: ['provider', 'executionProfile'],
    })).toThrow('请明确 category 后重新预览');
  });

  it('replaces explicitly supplied execution profiles atomically instead of mixing old fields', () => {
    const previous = { ...existing, executionProfile: {
      preset: 'custom' as const, protocol: structuredClone(DECLARATIVE_VIDEO_PROTOCOL),
    } };
    const next = { ...existing, executionProfile: { preset: 'openai-chat' as const } };
    const result = mergeProviderModels([previous], [next]);
    expect(result.merged[0].executionProfile).toEqual(next.executionProfile);
    expect(result.fieldChanges[0].updated).toEqual(['executionProfile']);
  });
});

const IMAGE_REQUEST = `
curl https://gateway.example.com/v1/images/generations \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"image-pro","prompt":"glass cube","size":"1024x768"}'`;

const IMAGE_RESPONSE = `{
  "data": [{"url": "https://cdn.example.com/image.png"}]
}`;

const VIDEO_REQUEST = `
curl https://gateway.example.com/v1/videos \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"video-pro","prompt":"glass cube","duration":5}'`;

const VIDEO_RESPONSE = `{
  "task_id": "video-task-1",
  "status": "queued"
}`;

const VIDEO_POLL_REQUEST = `
curl https://gateway.example.com/v1/tasks/video-task-1 \\
  -H "Authorization: Bearer <token>"`;

const VIDEO_POLL_RESPONSE = `{
  "status": "completed",
  "progress": 100,
  "url": "https://cdn.example.com/video.mp4"
}`;

const BASIC_VIDEO_CAPABILITY: VideoModelCapability = {
  operations: ['text-to-video', 'image-to-video', 'video-to-video'],
  maxImageReferences: 1,
  maxVideoReferences: 1,
};

const DECLARATIVE_VIDEO_PROTOCOL: ModelExecutionProtocol = {
  version: 2,
  mode: 'async',
  auth: { type: 'bearer' },
  submit: {
    method: 'POST',
    path: '/video_generation',
    body: {
      model: '{{model}}',
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
        {
          $whenPresent: '{{referenceVideoUrl}}',
          $value: {
            type: 'video_url',
            video_url: '{{referenceVideoUrl}}',
            role: 'reference_video',
          },
        },
      ],
    },
  },
  response: { type: 'json', taskIdPath: 'task_id' },
  poll: {
    method: 'GET',
    path: '/query/video_generation/{{submit.task_id}}',
    response: {
      statusPath: 'task.status',
      successValues: ['completed'],
      failureValues: ['failed', 'error'],
      result: { urlPath: 'task.content.url' },
    },
    intervalMs: 3000,
  },
};

function declarativeInput(
  protocol: ModelExecutionProtocol = DECLARATIVE_VIDEO_PROTOCOL,
): ProviderConfigDraftInput {
  return {
    connectionName: 'Declarative Relay',
    baseUrl: 'https://gateway.example.com/v1',
    models: [{
      protocolSource: 'declarative' as const,
      modelId: 'video-model',
      name: 'Declarative Video',
      category: 'video' as const,
      videoCapability: BASIC_VIDEO_CAPABILITY,
      executionProtocol: structuredClone(protocol),
    }],
  };
}

function createInput() {
  return {
    connectionName: 'Example AI',
    models: [
      {
        name: 'Example Image Pro',
        category: 'image' as const,
        submitRequest: IMAGE_REQUEST,
        submitResponse: IMAGE_RESPONSE,
      },
      {
        name: 'Example Video Pro',
        category: 'video' as const,
        videoCapability: BASIC_VIDEO_CAPABILITY,
        submitRequest: VIDEO_REQUEST,
        submitResponse: VIDEO_RESPONSE,
        pollRequest: VIDEO_POLL_REQUEST,
        pollResponse: VIDEO_POLL_RESPONSE,
      },
    ],
  };
}

beforeEach(() => {
  clearProviderConfigDraftsForTests();
});

describe('provider config draft service', () => {
  it('preserves the inferred data URL reference mode in an async image draft', () => {
    const draft = createProviderConfigDraft('task-rightapi', {
      connectionName: 'RightAPI',
      models: [{
        modelId: 'nano-banana-fast',
        name: 'Nano Banana Fast',
        category: 'image',
        submitRequest: `
curl -X POST https://www.right.codes/draw/v1/images/generations \\
  -H "Authorization: Bearer sk-placeholder" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"nano-banana-fast","prompt":"test","async":true,"image":["data:image/png;base64,{BASE64_IMAGE}"]}'`,
        submitResponse: '{"task_id":"task-rightapi","status":"processing"}',
        pollRequest: 'curl https://www.right.codes/v1/tasks/task-rightapi -H "Authorization: Bearer sk-placeholder"',
        pollResponse: '{"status":"completed","data":[{"url":"https://cdn.example.com/result.png"}]}',
      }],
    });

    expect(draft.config.selectedModels?.[0]).toMatchObject({
      id: 'nano-banana-fast',
      category: 'image',
      imageReferenceRequestMode: 'generation-json-image-data-urls',
      executionProfile: {
        preset: 'custom',
        protocol: {
          mode: 'async',
          submit: { body: { image: '{{imageUrls}}' } },
          poll: { path: '/v1/tasks/{{submit.task_id}}' },
        },
      },
    });
    expect(draft.summary).toContain('参考图：data URL 数组');
    expect(JSON.stringify(draft)).not.toContain('sk-placeholder');
  });

  it('flags drafts whose image/video protocol carries no reference media field', () => {
    // 中转文档只给了纯文生图 / 文生视频示例，画布上连的参考图发不出去，审批卡要说清楚
    const withoutReferences = createProviderConfigDraft('task-no-ref', createInput());
    expect(withoutReferences.summary).toContain('Example Image Pro（图片，无参考素材字段）');
    expect(withoutReferences.summary).toContain('Example Video Pro（视频，无参考素材字段）');

    const withReferences = createProviderConfigDraft('task-ref', {
      connectionName: 'Example AI',
      models: [{
        name: 'Example Video Ref',
        category: 'video' as const,
        videoCapability: BASIC_VIDEO_CAPABILITY,
        submitRequest: VIDEO_REQUEST.replace('"duration":5', '"duration":5,"image_urls":["https://cdn.example.com/ref.png"]'),
        submitResponse: VIDEO_RESPONSE,
        pollRequest: VIDEO_POLL_REQUEST,
        pollResponse: VIDEO_POLL_RESPONSE,
      }],
    });
    expect(withReferences.summary).toContain('Example Video Ref（视频）');
  });

  it('merges multiple model protocols into one credential-free provider draft', () => {
    const draft = createProviderConfigDraft('task-1', createInput(), 1_000);

    expect(draft).toMatchObject({
      taskId: 'task-1',
      connectionName: 'Example AI',
      baseUrl: 'https://gateway.example.com/v1',
      config: {
        name: 'Example AI',
        catalogId: 'custom-openai',
        visibleModelCategories: ['image', 'video'],
        selectedModels: [
          {
            id: 'image-pro',
            name: 'Example Image Pro',
            category: 'image',
            executionProfile: { preset: 'custom', protocol: { mode: 'sync' } },
          },
          {
            id: 'video-pro',
            name: 'Example Video Pro',
            category: 'video',
            executionProfile: { preset: 'custom', protocol: { mode: 'async' } },
          },
        ],
      },
    });
    expect(draft.connectionId).toMatch(/^custom-/);
    expect(JSON.stringify(draft)).not.toMatch(/apiKey|<token>|submitRequest|submitResponse/i);
  });

  it('rejects models that resolve to different base URLs', () => {
    const input = createInput();
    input.models[1].submitRequest = input.models[1].submitRequest.replace(
      'gateway.example.com',
      'video.example.com',
    );
    input.models[1].pollRequest = input.models[1].pollRequest?.replace(
      'gateway.example.com',
      'video.example.com',
    );

    expect(() => createProviderConfigDraft('task-1', input))
      .toThrow('同一个 Base URL');
  });

  it('rejects examples that cannot produce a valid execution protocol', () => {
    const input = createInput();
    input.models[0].submitResponse = '{"status":"submitted","task_id":"task-1"}';

    expect(() => createProviderConfigDraft('task-1', {
      ...input,
      models: [input.models[0]],
    })).toThrow('无法生成有效调用协议');
  });

  it('rejects ambiguous composite video content items instead of applying a guessed protocol', () => {
    expect(() => createProviderConfigDraft('task-composite-content', {
      connectionName: 'Composite Relay',
      models: [{
        modelId: 'video-model',
        name: 'Composite Video',
        category: 'video',
        submitRequest: `curl -X POST https://gateway.example.com/v1/video_generation \\
  -H "Content-Type: application/json" \\
  -d '{"model":"video-model","content":[{"type":"image_url","image_url":{"url":"https://cdn.example.com/first.png"},"role":"first_frame","caption":"coupled field"}]}'`,
        submitResponse: '{"url":"https://cdn.example.com/result.mp4"}',
      }],
    })).toThrow('需要人工确认');
  });

  it('accepts an explicitly declared protocol without re-inferring request examples', () => {
    const draft = createProviderConfigDraft('task-declarative', declarativeInput());
    const profile = draft.config.selectedModels?.[0]?.executionProfile;

    expect(draft).toMatchObject({
      baseUrl: 'https://gateway.example.com/v1',
      config: {
        selectedModels: [{
          id: 'video-model',
          category: 'video',
          executionProfile: {
            preset: 'custom',
            protocol: {
              version: 2,
              mode: 'async',
              submit: { path: '/video_generation' },
              poll: { path: '/query/video_generation/{{submit.task_id}}' },
            },
          },
        }],
      },
    });
    expect(JSON.stringify(draft)).not.toContain('submitRequest');
    if (profile?.preset !== 'custom' || !profile.protocol) {
      throw new Error('declarative protocol was not stored');
    }

    const withoutReferences = buildModelProtocolRequest({
      apiKey: 'test-key',
      baseUrl: draft.baseUrl,
      protocol: profile.protocol,
      variables: { model: 'video-model', prompt: 'a cat' },
    });
    expect(withoutReferences.renderedBody).toMatchObject({
      content: [{ type: 'text', text: 'a cat' }],
    });

    const withImage = buildModelProtocolRequest({
      apiKey: 'test-key',
      baseUrl: draft.baseUrl,
      protocol: profile.protocol,
      variables: {
        model: 'video-model',
        prompt: 'a cat',
        imageUrls: ['https://cdn.example.com/first.png'],
      },
    });
    expect(withImage.renderedBody).toMatchObject({
      content: [
        { type: 'text', text: 'a cat' },
        {
          type: 'image_url',
          image_url: { url: 'https://cdn.example.com/first.png' },
          role: 'first_frame',
        },
      ],
    });
  });

  it('normalizes a compatible legacy declarative protocol before storing the draft', () => {
    const legacyProtocol: ModelExecutionProtocol = {
      version: 1,
      mode: 'sync',
      auth: { type: 'bearer' },
      submit: {
        method: 'POST',
        path: '/videos',
        body: { model: '{{model}}', prompt: '{{prompt}}' },
      },
      responseType: 'json',
      resultUrlPath: 'data.url',
    };

    const input = declarativeInput(legacyProtocol);
    input.models[0].videoCapability = { operations: ['text-to-video'] };
    const draft = createProviderConfigDraft('task-declarative-v1', input);

    expect(draft.config.selectedModels?.[0]?.executionProfile?.protocol).toMatchObject({
      version: 2,
      mode: 'sync',
      response: {
        type: 'json',
        result: { urlPath: 'data.url' },
      },
    });
  });

  it('keeps example inference and declarative protocols strictly mutually exclusive', () => {
    const declarativeWithExample = declarativeInput();
    declarativeWithExample.models[0] = {
      ...declarativeWithExample.models[0],
      submitRequest: VIDEO_REQUEST,
    };
    expect(() => createProviderConfigDraft('task-declarative-mixed', declarativeWithExample))
      .toThrow('declarative 模式不得同时提供');

    const examplesWithProtocol: ProviderConfigDraftInput = createInput();
    examplesWithProtocol.models[1] = {
      ...examplesWithProtocol.models[1],
      protocolSource: 'examples',
      executionProtocol: structuredClone(DECLARATIVE_VIDEO_PROTOCOL),
    };
    expect(() => createProviderConfigDraft('task-examples-mixed', examplesWithProtocol))
      .toThrow('examples 模式不得提供 executionProtocol');
  });

  it('requires an explicit baseUrl, category, modelId and protocol object in declarative mode', () => {
    const missingBaseUrl = declarativeInput();
    delete missingBaseUrl.baseUrl;
    expect(() => createProviderConfigDraft('task-no-base', missingBaseUrl))
      .toThrow('必须显式提供 connection baseUrl');

    const missingCategory = declarativeInput();
    delete missingCategory.models[0].category;
    expect(() => createProviderConfigDraft('task-no-category', missingCategory))
      .toThrow('必须显式提供 category');

    const missingModelId = declarativeInput();
    delete missingModelId.models[0].modelId;
    expect(() => createProviderConfigDraft('task-no-model', missingModelId))
      .toThrow('必须显式提供 modelId');

    const missingProtocol = declarativeInput();
    delete missingProtocol.models[0].executionProtocol;
    expect(() => createProviderConfigDraft('task-no-protocol', missingProtocol))
      .toThrow('必须提供 executionProtocol JSON 对象');

    const missingVideoOperations = declarativeInput();
    delete missingVideoOperations.models[0].videoCapability;
    expect(() => createProviderConfigDraft('task-no-video-operations', missingVideoOperations))
      .toThrow('必须按接口文档声明非空 videoCapability.operations');
  });

  it('rejects credential keys, dangerous keys, oversized, deep and overly complex protocols', () => {
    const withCredential = declarativeInput();
    (withCredential.models[0].executionProtocol!.submit.body as Record<string, unknown>).api_key = 'secret';
    expect(() => createProviderConfigDraft('task-credential', withCredential))
      .toThrow(/API Key|凭据/);

    const withCredentialLiteral = declarativeInput();
    withCredentialLiteral.models[0].executionProtocol!.submit.headers = {
      'X-Request-Signature': 'sk-this-is-a-real-looking-secret',
    };
    expect(() => createProviderConfigDraft('task-credential-value', withCredentialLiteral))
      .toThrow('疑似真实凭据值');

    const withDangerousKey = declarativeInput();
    withDangerousKey.models[0].executionProtocol!.submit.body = JSON.parse(
      '{"__proto__":{"polluted":true}}',
    );
    expect(() => createProviderConfigDraft('task-dangerous-key', withDangerousKey))
      .toThrow('不安全对象键');

    const oversized = declarativeInput();
    oversized.models[0].executionProtocol!.submit.body = { padding: 'x'.repeat(70 * 1_024) };
    expect(() => createProviderConfigDraft('task-oversized', oversized))
      .toThrow('不能超过 64 KiB');

    const tooDeep = declarativeInput();
    let nested: Record<string, unknown> = {};
    const root = nested;
    for (let index = 0; index < 34; index += 1) {
      nested.next = {};
      nested = nested.next as Record<string, unknown>;
    }
    tooDeep.models[0].executionProtocol!.submit.body = root as never;
    expect(() => createProviderConfigDraft('task-too-deep', tooDeep))
      .toThrow('嵌套深度不能超过 32 层');

    const tooManyNodes = declarativeInput();
    tooManyNodes.models[0].executionProtocol!.submit.body = Array.from(
      { length: 4_100 },
      () => null,
    );
    expect(() => createProviderConfigDraft('task-too-many-nodes', tooManyNodes))
      .toThrow('最多允许 4096 个 JSON 节点');
  });

  it('rejects credential-like key fragments and secret-shaped literals without blocking model IDs or URLs', () => {
    for (const key of [
      'sessionTokenValue',
      'client_key_id',
      'vendorSecretMaterial',
      'dbPasswordValue',
      'apiCredentialBlob',
    ]) {
      const input = declarativeInput();
      (input.models[0].executionProtocol!.submit.body as Record<string, unknown>)[key] = 'redacted';
      expect(() => createProviderConfigDraft(`task-key-${key}`, input))
        .toThrow(/API Key|凭据/);
    }

    for (const [index, literal] of [
      '0123456789abcdef0123456789abcdef',
      '0123456789abcdef0123456789abcdef01234567',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'AbCdefGHIjklMNopQRstuVWxyz0123456789_-AbCdEfGh',
    ].entries()) {
      const input = declarativeInput();
      (input.models[0].executionProtocol!.submit.body as Record<string, unknown>).request_id = literal;
      expect(() => createProviderConfigDraft(`task-literal-${index}`, input))
        .toThrow('疑似真实凭据值');
    }

    const contentHashModelId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const safeInput = declarativeInput();
    safeInput.models[0].modelId = contentHashModelId;
    const safeBody = safeInput.models[0].executionProtocol!.submit.body as Record<string, unknown>;
    safeBody.model = contentHashModelId;
    safeBody.callback_url = `https://cdn.example.com/models/${contentHashModelId}`;
    safeInput.models[0].videoCapability = {
      ...BASIC_VIDEO_CAPABILITY,
      inputModeCapabilities: { keyframe: { ratios: ['16:9'] } },
      ratios: ['16:9'],
    };

    expect(() => createProviderConfigDraft('task-safe-model-id-url', safeInput)).not.toThrow();
  });

  it('requires executable prompt and capability/reference semantics for direct video protocols', () => {
    const fixedPrompt = declarativeInput();
    fixedPrompt.models[0].videoCapability = { operations: ['text-to-video'] };
    fixedPrompt.models[0].executionProtocol!.submit.body = {
      model: '{{model}}',
      prompt: 'fixed prompt',
    };
    expect(() => createProviderConfigDraft('task-fixed-prompt', fixedPrompt))
      .toThrow('submit 必须动态绑定 {{prompt}}');

    const promptOnlyInCondition = declarativeInput();
    promptOnlyInCondition.models[0].videoCapability = { operations: ['text-to-video'] };
    promptOnlyInCondition.models[0].executionProtocol!.submit.body = {
      content: [{
        $whenPresent: '{{prompt}}',
        $value: { type: 'text', text: 'fixed prompt' },
      }],
    };
    expect(() => createProviderConfigDraft('task-prompt-condition-only', promptOnlyInCondition))
      .toThrow('没有实际发送动态 {{prompt}}');

    const missingImageField = declarativeInput();
    missingImageField.models[0].videoCapability = {
      operations: ['image-to-video'],
      maxImageReferences: 1,
    };
    missingImageField.models[0].executionProtocol!.submit.body = {
      model: '{{model}}',
      prompt: '{{prompt}}',
    };
    expect(() => createProviderConfigDraft('task-missing-image-field', missingImageField))
      .toThrow('声明 image-to-video，但 submit 没有图片参考字段');

    const undeclaredVideoOperation = declarativeInput();
    undeclaredVideoOperation.models[0].videoCapability = { operations: ['text-to-video'] };
    undeclaredVideoOperation.models[0].executionProtocol!.submit.body = {
      prompt: '{{prompt}}',
      video: '{{referenceVideoUrl}}',
    };
    expect(() => createProviderConfigDraft('task-undeclared-video-operation', undeclaredVideoOperation))
      .toThrow('operations 未声明 video-to-video');

    const mutuallyExclusiveModes = declarativeInput();
    mutuallyExclusiveModes.models[0].videoCapability = {
      operations: ['image-to-video'],
      maxImageReferences: 1,
      allowFrameAndReferenceMix: false,
      inputModeCapabilities: { mixed: { ratios: ['16:9'] } },
      ratios: ['16:9'],
    };
    mutuallyExclusiveModes.models[0].executionProtocol!.submit.body = {
      prompt: '{{prompt}}',
      image: '{{imageUrls}}',
    };
    expect(() => createProviderConfigDraft('task-mutually-exclusive-modes', mutuallyExclusiveModes))
      .toThrow('inputModeCapabilities.mixed 与 allowFrameAndReferenceMix:false 互斥');
  });

  it('dry-runs keyframe/reference arrays and rejects dropped or duplicate reference materials', () => {
    const dropped = declarativeInput();
    dropped.models[0].videoCapability = {
      operations: ['image-to-video'],
      maxImageReferences: 2,
    };
    dropped.models[0].executionProtocol!.submit.body = {
      prompt: '{{prompt}}',
      first_image: '{{imageUrls.0}}',
    };
    expect(() => createProviderConfigDraft('task-dropped-reference', dropped))
      .toThrow('没有消费全部参考素材');

    const duplicate = declarativeInput();
    duplicate.models[0].videoCapability = {
      operations: ['image-to-video'],
      maxImageReferences: 1,
    };
    duplicate.models[0].executionProtocol!.submit.body = {
      prompt: '{{prompt}}',
      first_image: '{{firstImage}}',
      images: '{{imageUrls}}',
    };
    expect(() => createProviderConfigDraft('task-duplicate-reference', duplicate))
      .toThrow('重复映射了同一参考素材');

    const consumed = declarativeInput();
    consumed.models[0].videoCapability = {
      operations: ['image-to-video'],
      maxImageReferences: 2,
    };
    consumed.models[0].executionProtocol!.submit.body = {
      prompt: '{{prompt}}',
      images: '{{imageUrls}}',
    };
    expect(() => createProviderConfigDraft('task-consumed-reference', consumed)).not.toThrow();

    const expanded = declarativeInput();
    expanded.models[0].videoCapability = {
      operations: ['image-to-video'],
      maxImageReferences: 2,
    };
    expanded.models[0].executionProtocol!.submit.body = {
      content: [
        { type: 'text', text: '{{prompt}}' },
        {
          $forEach: '{{referenceImageUrls}}',
          $value: { type: 'image_url', image_url: '{{referenceImageUrls}}' },
        },
      ],
    };
    expect(() => createProviderConfigDraft('task-expanded-reference', expanded)).not.toThrow();

    const overExpansionLimit = structuredClone(expanded);
    overExpansionLimit.models[0].videoCapability!.maxImageReferences = 65;
    expect(() => createProviderConfigDraft('task-over-expansion-limit', overExpansionLimit))
      .toThrow('超过调用协议 $forEach 的单数组安全上限 64');
  });

  it('runs declarative protocols through the existing protocol validator', () => {
    const invalid = declarativeInput();
    invalid.models[0].executionProtocol!.poll!.path = '/query/video_generation/fixed-task-id';
    expect(() => createProviderConfigDraft('task-invalid-direct', invalid))
      .toThrow(/写死任务 ID/);
  });

  it('rejects declarative variables that the selected model category never supplies', () => {
    const wrongCategory = declarativeInput();
    wrongCategory.models[0].category = 'text';
    delete wrongCategory.models[0].videoCapability;
    wrongCategory.models[0].executionProtocol!.submit.body = {
      model: '{{model}}',
      prompt: '{{prompt}}',
      video: '{{referenceVideoUrls}}',
    };

    expect(() => createProviderConfigDraft('task-wrong-variable-category', wrongCategory))
      .toThrow('文本模型不会提供的变量：referenceVideoUrls');
  });

  it('imports a Gemini generateContent schema with an explicit model ID and Base URL', () => {
    const input = {
      connectionName: 'New API',
      baseUrl: 'https://gateway.newapi.example',
      models: [{
        modelId: 'nana-banana-2',
        name: 'nana-banana-2',
        category: 'image' as const,
        submitRequest: `
const body = JSON.stringify({
  "contents": [
    {}
  ],
  "generationConfig": {
    "responseModalities": [
      "string"
    ],
    "imageConfig": {
      "aspectRatio": "string",
      "imageSize": "string"
    }
  }
})

fetch("https://docs.newapi.pro/v1beta/models/string:generateContent/", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer "
  },
  body
})`,
        submitResponse: `{
          "candidates": [{
            "content": { "role": "string", "parts": [{}] },
            "finishReason": "string",
            "safetyRatings": []
          }],
          "usageMetadata": { "promptTokenCount": 0, "totalTokenCount": 0 }
        }`,
      }],
    };
    const draft = createProviderConfigDraft('task-gemini', input);

    expect(draft).toMatchObject({
      baseUrl: 'https://gateway.newapi.example',
      config: {
        selectedModels: [{
          id: 'nana-banana-2',
          category: 'image',
          executionProfile: {
            protocol: {
              mode: 'sync',
              auth: { type: 'bearer' },
              submit: {
                method: 'POST',
                path: '/v1beta/models/{{model}}:generateContent/',
                body: {
                  contents: [{ role: 'user', parts: [{ text: '{{prompt}}' }] }],
                  generationConfig: {
                    responseModalities: ['IMAGE'],
                    imageConfig: {
                      aspectRatio: '{{aspectRatio}}',
                      imageSize: '{{imageSize}}',
                    },
                  },
                },
              },
              response: {
                result: {
                  base64Path: 'candidates.*.content.parts.*.inlineData.data',
                  mimeType: 'image/png',
                },
              },
            },
          },
        }],
      },
    });
    expect(JSON.stringify(draft)).not.toContain('Bearer ');

    const profile = draft.config.selectedModels?.[0]?.executionProfile;
    if (profile?.preset !== 'custom' || !profile.protocol) {
      throw new Error('Gemini 草稿没有生成自定义调用协议');
    }
    const request = buildModelProtocolRequest({
      // 协议声明了 bearer 鉴权，空 Key 会被前置拦下；这里只关心 URL 与请求体形状
      apiKey: 'test-key',
      baseUrl: draft.baseUrl,
      protocol: profile.protocol,
      variables: {
        model: 'nana-banana-2',
        prompt: '生成一只戴宇航头盔的猫',
        aspectRatio: '16:9',
        imageSize: '2K',
      },
    });
    expect(request.url).toBe(
      'https://gateway.newapi.example/v1beta/models/nana-banana-2:generateContent/',
    );
    expect(JSON.parse(String(request.init.body))).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: '生成一只戴宇航头盔的猫' }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
      },
    });

    const mismatchedInput = structuredClone(input);
    mismatchedInput.models[0].submitRequest = `
fetch("https://docs.newapi.pro/v1beta/models/string:generateContent/", {
  method: "POST",
  body: JSON.stringify({ "prompt": "{{prompt}}" })
})`;
    mismatchedInput.models[0].submitResponse = '{"data":[{"b64_json":"aGVsbG8="}]}';
    expect(() => createProviderConfigDraft('task-mismatched', mismatchedInput))
      .toThrow('无法生成有效调用协议');

    const docsBaseUrlInput = structuredClone(input);
    docsBaseUrlInput.baseUrl = 'https://docs.newapi.pro';
    expect(() => createProviderConfigDraft('task-docs-base-url', docsBaseUrlInput))
      .toThrow('不能使用文档站地址');
  });

  it('cleans up the declared base URL without loosening its security checks', () => {
    // 助手常把文档里的完整端点当成 Base URL 抄回来
    const pastedEndpoint = structuredClone(createInput()) as ReturnType<typeof createInput>
      & { baseUrl?: string };
    pastedEndpoint.baseUrl = 'gateway.example.com/v1/chat/completions/';
    expect(createProviderConfigDraft('task-pasted-endpoint', pastedEndpoint).baseUrl)
      .toBe('https://gateway.example.com/v1');

    const insecure = structuredClone(createInput()) as typeof pastedEndpoint;
    insecure.baseUrl = 'http://gateway.example.com/v1';
    expect(() => createProviderConfigDraft('task-insecure', insecure))
      .toThrow('必须是无凭据的 HTTPS 地址');

    const oddPort = structuredClone(createInput()) as typeof pastedEndpoint;
    oddPort.baseUrl = 'https://gateway.example.com:8443/v1';
    expect(() => createProviderConfigDraft('task-odd-port', oddPort))
      .toThrow('只允许使用 HTTPS 默认端口');
  });

  it('stores the native chat protocol and routes text models through the connection adapter', () => {
    const draft = createProviderConfigDraft('task-gemini-chat', {
      connectionName: 'Gemini Relay',
      baseUrl: 'https://gateway.example.com/v1beta/models/gemini-2.5-pro:generateContent',
      chatApiProtocol: 'gemini-native',
      models: [{
        modelId: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        category: 'text',
        submitRequest: `
curl https://gateway.example.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hello"}]}'`,
        submitResponse: '{"choices":[{"message":{"content":"hello"}}]}',
      }],
    });

    expect(draft.baseUrl).toBe('https://gateway.example.com/v1beta');
    expect(draft.config.chatApiProtocol).toBe('gemini-native');
    expect(draft.config.selectedModels?.[0].executionProfile).toBeUndefined();
    expect(draft.modelUpdateFields['gemini-2.5-pro']).toContain('executionProfile');
    expect(draft.summary).toContain('聊天协议：Gemini 原生');
  });

  it('carries the documented description, vision capability and category into the selection', () => {
    const input: ProviderConfigDraftInput = {
      ...createInput(),
      models: [{ ...createInput().models[0], description: '  擅长产品图与电商主图，最长边 2048。  ' }],
    };
    const [image] = createProviderConfigDraft('task-desc', input).config.selectedModels ?? [];
    expect(image).toMatchObject({
      description: '擅长产品图与电商主图，最长边 2048。',
      descriptionManual: true,
      // 助手按文档定的分类不该被下次拉取目录的 ID 正则改回去
      categoryManual: true,
    });

    const visionInput: ProviderConfigDraftInput = {
      connectionName: 'Example AI',
      models: [{
        name: 'Example Chat',
        category: 'text' as const,
        inputModalities: ['image' as const],
        submitRequest: `
curl https://gateway.example.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"chat-pro","messages":[{"role":"user","content":"{{prompt}}"}]}'`,
        submitResponse: '{"choices":[{"message":{"content":"hello"}}]}',
      }],
    };
    const [chat] = createProviderConfigDraft('task-vision', visionInput).config.selectedModels ?? [];
    // 只声明 image 时补上 text，画布判断读图能力才不会漏掉纯文本输入
    expect(chat).toMatchObject({ inputModalities: ['text', 'image'], inputModalitiesManual: true });
  });

  it('carries the documented context window and rejects it on non-text models', () => {
    const visionInput: ProviderConfigDraftInput = {
      connectionName: 'Example AI',
      models: [{
        name: 'Example Chat',
        category: 'text',
        contextWindow: 262_144,
        submitRequest: `
curl https://gateway.example.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"chat-pro","messages":[{"role":"user","content":"{{prompt}}"}]}'`,
        submitResponse: '{"choices":[{"message":{"content":"hello"}}]}',
      }],
    };
    const [chat] = createProviderConfigDraft('task-ctx', visionInput).config.selectedModels ?? [];
    expect(chat).toMatchObject({ contextWindow: 262_144 });

    const imageInput: ProviderConfigDraftInput = {
      ...createInput(),
      models: [{ ...createInput().models[0], contextWindow: 128_000 }],
    };
    expect(() => createProviderConfigDraft('task-ctx-bad', imageInput))
      .toThrow('只有文本分类可以声明 contextWindow');
  });

  it('rejects declaring vision input on a non-text model', () => {
    const input: ProviderConfigDraftInput = {
      ...createInput(),
      models: [{ ...createInput().models[0], inputModalities: ['text', 'image'] }],
    };
    expect(() => createProviderConfigDraft('task-bad-modality', input))
      .toThrow('只有文本分类可以声明 inputModalities');
  });

  it('rejects credential fields before analyzing examples', () => {
    const unsafeInput = {
      ...createInput(),
      apiKey: 'must-not-enter-agent-input',
    };

    expect(() => createProviderConfigDraft('task-1', unsafeInput as never))
      .toThrow('API Key 或其他凭据字段');
  });

  it('isolates drafts by task and expires them', () => {
    const draft = createProviderConfigDraft('task-1', createInput(), 1_000);

    expect(() => getProviderConfigDraft('task-2', draft.id, 1_001))
      .toThrow('不属于当前 Agent 任务');
    expect(() => getProviderConfigDraft('task-1', draft.id, draft.expiresAt + 1))
      .toThrow('已过期');
  });
});

describe('video capability declaration', () => {
  const VIDEO_MODEL = {
    modelId: 'lec-seed-2-0-900',
    name: 'Seedance 2.0 900',
    category: 'video' as const,
    videoCapability: BASIC_VIDEO_CAPABILITY,
    // 文档给的请求示例：只有 aspect_ratio / duration / images，没有 size / resolution
    submitRequest: `
curl https://gateway.example.com/v1/videos \
  -H "Authorization: Bearer <token>" \
  -d '{"aspect_ratio":"16:9","duration":15,"images":["https://example.com/ref.jpg"],"model":"lec-seed-2-0-900","prompt":"a cat"}'`,
    submitResponse: '{"id":"video_task_example","status":"queued"}',
    pollRequest: 'curl https://gateway.example.com/v1/videos/video_task_example -H "Authorization: Bearer <token>"',
    pollResponse: '{"status":"completed","output":{"url":"https://cdn.example.com/result.mp4"}}',
  };

  it('只映射文档列出的字段，不凭空补 size / resolution', () => {
    const draft = createProviderConfigDraft('task-doc-fields', {
      connectionName: 'Relay',
      models: [VIDEO_MODEL],
    });
    const body = draft.config.selectedModels?.[0].executionProfile?.protocol?.submit.body;
    expect(body).toEqual({
      model: '{{model}}',
      prompt: '{{prompt}}',
      aspect_ratio: '{{aspectRatio}}',
      duration: '{{duration}}',
      images: '{{imageUrls}}',
    });
  });

  it('完整保留视频模型声明的操作、帧率、素材组合和输入约束', () => {
    const capability: NonNullable<ProviderConfigDraftInput['models'][number]['videoCapability']> = {
      operations: ['image-to-video', 'video-to-video'],
      requiresReference: true,
      resolutions: ['720p', '1080p'],
      defaultResolution: '720p',
      ratios: ['16:9', '9:16'],
      defaultRatio: '16:9',
      frameRates: [24, 30],
      defaultFrameRate: 24,
      durations: [10, 15],
      minDuration: 10,
      maxDuration: 15,
      defaultDuration: 15,
      supportsAudio: true,
      supportsStandaloneAudio: true,
      allowFrameAndReferenceMix: false,
      maxImageReferences: 9,
      maxVideoReferences: 1,
      maxAudioReferences: 1,
      inputConstraints: {
        promptMinCharacters: 1,
        maxBase64DecodedBytes: 20 * 1024 * 1024,
        referenceVideo: {
          width: { min: 480, max: 1920, minExclusive: true },
          durationSeconds: { min: 1, max: 15 },
        },
        referenceAudio: {
          durationSeconds: { min: 0, max: 15, minExclusive: true },
        },
      },
    };
    const draft = createProviderConfigDraft('task-capability', {
      connectionName: 'Relay',
      models: [{
        ...VIDEO_MODEL,
        videoCapability: capability,
      }],
    });
    expect(draft.config.selectedModels?.[0].videoCapability).toEqual(capability);
  });

  it('拒绝不一致的视频 capability 和非视频模型声明', () => {
    expect(() => createProviderConfigDraft('task-capability-reference-conflict', {
      connectionName: 'Relay',
      models: [{
        ...VIDEO_MODEL,
        videoCapability: {
          operations: ['text-to-video', 'image-to-video'],
          requiresReference: true,
        },
      }],
    })).toThrow('模型要求参考素材时，operations 不能同时声明 text-to-video');

    expect(() => createProviderConfigDraft('task-capability-default-outside-enum', {
      connectionName: 'Relay',
      models: [{
        ...VIDEO_MODEL,
        videoCapability: {
          operations: ['text-to-video'],
          frameRates: [24, 30],
          defaultFrameRate: 25,
        },
      }],
    })).toThrow('defaultFrameRate 不在声明的可选值中');

    expect(() => createProviderConfigDraft('task-capability-bad', {
      connectionName: 'Relay',
      models: [{
        modelId: 'image-pro',
        category: 'image',
        submitRequest: `curl https://gateway.example.com/v1/images/generations -d '{"model":"image-pro","prompt":"cat"}'`,
        submitResponse: '{"data":[{"url":"https://cdn.example.com/a.png"}]}',
        videoCapability: { maxDuration: 15 },
      }],
    })).toThrow('只有视频分类可以声明 videoCapability');
  });
});
