import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearProviderConfigDraftsForTests,
  createProviderConfigDraft,
  getProviderConfigDraft,
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
      apiKey: '',
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
