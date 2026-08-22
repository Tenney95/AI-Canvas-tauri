import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearProviderConfigDraftsForTests,
  createProviderConfigDraft,
  getProviderConfigDraft,
  type ProviderConfigDraftInput,
} from '../../../src/services/chat/providerConfigDraftService';
import { buildModelProtocolRequest } from '../../../src/services/ai/modelProtocol';

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

  it('保留视频模型声明的固定能力，非视频模型则拒绝', () => {
    const draft = createProviderConfigDraft('task-capability', {
      connectionName: 'Relay',
      models: [{
        ...VIDEO_MODEL,
        videoCapability: {
          ratios: ['16:9', '9:16'],
          defaultRatio: '16:9',
          minDuration: 15,
          maxDuration: 15,
          defaultDuration: 15,
          maxImageReferences: 9,
          maxVideoReferences: 0,
          maxAudioReferences: 0,
        },
      }],
    });
    expect(draft.config.selectedModels?.[0].videoCapability).toMatchObject({
      ratios: ['16:9', '9:16'],
      minDuration: 15,
      maxDuration: 15,
      maxImageReferences: 9,
    });

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
