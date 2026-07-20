import { describe, expect, it } from 'vitest';
import {
  analyzeModelProtocolDocument,
  analyzeModelProtocolExamples,
} from '../../src/services/ai/modelProtocolImport';

describe('model protocol document import', () => {
  it('imports explicitly separated submit and polling examples', () => {
    const result = analyzeModelProtocolExamples({
      submitRequest: `
const url = "https://api.apimart.ai/v1/images/generations";
const payload = {
  model: "gemini-3.1-flash-image-preview",
  prompt: "赛博朋克城市",
  size: "16:9",
  resolution: "2K",
  n: 1
};
const headers = { "Authorization": "Bearer <token>", "Content-Type": "application/json" };
fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });`,
      submitResponse: `{
  "code": 200,
  "data": [{ "status": "submitted", "task_id": "task_example" }]
}`,
      pollRequest: `
const url = "https://api.apimart.ai/v1/tasks/task-example?language=zh";
const headers = { "Authorization": "Bearer <token>" };
fetch(url, { method: "GET", headers });`,
      pollResponse: `{
  "code": 200,
  "data": {
    "status": "completed",
    "progress": 100,
    "result": { "images": [{ "url": ["https://cdn.example.com/result.png"] }] }
  }
}`,
    });

    expect(result).toMatchObject({
      baseUrl: 'https://api.apimart.ai/v1',
      modelId: 'gemini-3.1-flash-image-preview',
      category: 'image',
      protocol: {
        mode: 'async',
        response: { taskIdPath: 'data.0.task_id' },
        poll: {
          path: '/tasks/{{submit.task_id}}',
          response: {
            statusPath: 'data.status',
            result: { urlPath: 'data.result.images.*.url.*' },
          },
        },
      },
    });
  });

  it('requires complete request and response pairs for structured import', () => {
    expect(() => analyzeModelProtocolExamples({
      submitRequest: 'const url = "https://api.example.com/v1/images"; fetch(url);',
      submitResponse: '',
    })).toThrow('提交响应示例');

    expect(() => analyzeModelProtocolExamples({
      submitRequest: 'const url = "https://api.example.com/v1/images"; fetch(url);',
      submitResponse: '{"data":[{"url":"https://cdn.example.com/image.png"}]}',
      pollRequest: 'const url = "https://api.example.com/v1/tasks/1"; fetch(url);',
    })).toThrow('轮询请求示例和轮询响应示例必须同时填写');
  });

  it('imports an APIMart Fetch document with submit and polling responses', () => {
    const source = `
const url = "https://api.apimart.ai/v1/images/generations";
const payload = {
  model: "gemini-3.1-flash-image-preview",
  prompt: "赛博朋克风格的城市夜景，霓虹灯闪烁",
  size: "16:9",
  resolution: "2K",
  n: 1
};
const headers = {
  "Authorization": "Bearer <token>",
  "Content-Type": "application/json"
};
fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify(payload)
});

{
  "code": 200,
  "data": [{
    "status": "submitted",
    "task_id": "task_01K8SGYNNNVBQTXNR4MM964S7K"
  }]
}

**获取任务状态**
const url = "https://api.apimart.ai/v1/tasks/task-unified-1757156493-imcg5zqt?language=zh";
const headers = { "Authorization": "Bearer <token>" };
fetch(url, { method: "GET", headers });

{
  "code": 200,
  "data": {
    "id": "task_01KA040M0HP1GJWBJYZMKX1XS1",
    "status": "completed",
    "progress": 100,
    "result": {
      "images": [{
        "url": ["https://upload.apimart.ai/f/image/result.png"]
      }]
    }
  }
}`;

    const result = analyzeModelProtocolDocument(source);

    expect(result).toMatchObject({
      baseUrl: 'https://api.apimart.ai/v1',
      modelId: 'gemini-3.1-flash-image-preview',
      category: 'image',
      confidence: 'high',
      protocol: {
        version: 2,
        mode: 'async',
        auth: { type: 'bearer' },
        submit: {
          method: 'POST',
          path: '/images/generations',
          bodyEncoding: 'json',
          body: {
            model: '{{model}}',
            prompt: '{{prompt}}',
            size: '{{aspectRatio}}',
            resolution: '{{imageSize}}',
            n: '{{n}}',
          },
        },
        response: {
          type: 'json',
          taskIdPath: 'data.0.task_id',
        },
        poll: {
          method: 'GET',
          path: '/tasks/{{submit.task_id}}',
          query: { language: 'zh' },
          response: {
            statusPath: 'data.status',
            result: { urlPath: 'data.result.images.*.url.*' },
            progressPath: 'data.progress',
          },
        },
      },
    });
    expect(result.formats).toEqual(expect.arrayContaining(['fetch', 'json']));
    expect(JSON.stringify(result)).not.toContain('<token>');
  });

  it('imports an Agnes cURL video protocol and correlates video_id', () => {
    const source = `
curl -X POST https://apihub.agnes-ai.com/v1/videos \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "agnes-video-v2.0",
    "prompt": "A cinematic cat walking on the beach",
    "height": 768,
    "width": 1152,
    "num_frames": 121,
    "frame_rate": 24
  }'

{
  "id": "task_example",
  "video_id": "video_example",
  "status": "queued"
}

curl --location --request GET 'https://apihub.agnes-ai.com/agnesapi?video_id=<VIDEO_ID>' \\
  --header 'Authorization: Bearer YOUR_API_KEY'

{
  "video_id": "video_example",
  "status": "completed",
  "progress": 100,
  "url": "https://platform-outputs.agnes-ai.space/videos/result.mp4",
  "error": null
}`;

    const result = analyzeModelProtocolDocument(source);

    expect(result).toMatchObject({
      baseUrl: 'https://apihub.agnes-ai.com',
      modelId: 'agnes-video-v2.0',
      category: 'video',
      protocol: {
        mode: 'async',
        submit: {
          path: '/v1/videos',
          body: {
            model: '{{model}}',
            prompt: '{{prompt}}',
            height: '{{height}}',
            width: '{{width}}',
            num_frames: '{{frames8n1}}',
            frame_rate: '{{fps}}',
          },
        },
        response: { taskIdPath: 'video_id' },
        poll: {
          path: '/agnesapi',
          query: { video_id: '{{submit.task_id}}' },
          response: {
            statusPath: 'status',
            result: { urlPath: 'url' },
            progressPath: 'progress',
            errorPath: 'error',
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('YOUR_API_KEY');
  });

  it('imports a synchronous OpenAI-compatible image cURL example', () => {
    const source = `
curl https://gateway.example.com/v1/images/generations \\
  -H "Authorization: Bearer sk-example-secret" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"image-pro","prompt":"glass cube","size":"1024x768"}'

{
  "created": 1780000000,
  "data": [{"url":"https://cdn.example.com/result.png"}]
}`;

    const result = analyzeModelProtocolDocument(source);

    expect(result).toMatchObject({
      baseUrl: 'https://gateway.example.com/v1',
      modelId: 'image-pro',
      category: 'image',
      protocol: {
        mode: 'sync',
        submit: {
          method: 'POST',
          path: '/images/generations',
          body: {
            model: '{{model}}',
            prompt: '{{prompt}}',
            size: '{{size}}',
          },
        },
        response: {
          type: 'json',
          result: { urlPath: 'data.*.url' },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('sk-example-secret');
  });

  it('imports Python requests and maps chat fields without executing code', () => {
    const source = `
import requests

url = "https://gateway.example.com/v1/chat/completions"
payload = {
    "model": "chat-pro",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": False
}
headers = {"Authorization": "Bearer <API_KEY>"}
response = requests.post(url, json=payload, headers=headers)

{
  "choices": [{"message": {"content": "hello back"}}]
}`;

    const result = analyzeModelProtocolDocument(source);

    expect(result).toMatchObject({
      baseUrl: 'https://gateway.example.com/v1',
      modelId: 'chat-pro',
      category: 'text',
      protocol: {
        mode: 'sync',
        submit: {
          path: '/chat/completions',
          body: {
            model: '{{model}}',
            messages: '{{messages}}',
            stream: '{{stream}}',
          },
        },
        response: {
          result: { textPath: 'choices.*.message.content' },
        },
      },
    });
    expect(result.formats).toContain('python');
  });

  it('imports a Raw HTTP request and response', () => {
    const source = `
POST /v1/images/generations HTTP/1.1
Host: api.example.com
Authorization: Bearer <token>
Content-Type: application/json

{"model":"raw-image","prompt":"studio product","n":1}

HTTP/1.1 200 OK
Content-Type: application/json

{"data":[{"url":"https://cdn.example.com/raw.png"}]}`;

    const result = analyzeModelProtocolDocument(source);

    expect(result).toMatchObject({
      baseUrl: 'https://api.example.com/v1',
      modelId: 'raw-image',
      category: 'image',
      protocol: {
        mode: 'sync',
        submit: { method: 'POST', path: '/images/generations' },
        response: { result: { urlPath: 'data.*.url' } },
      },
    });
    expect(result.formats).toContain('raw-http');
  });

  it('imports an OpenAPI JSON operation with examples', () => {
    const source = JSON.stringify({
      openapi: '3.0.3',
      servers: [{ url: 'https://spec.example.com/v1' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
      paths: {
        '/images/generations': {
          post: {
            security: [{ bearerAuth: [] }],
            requestBody: {
              content: {
                'application/json': {
                  example: { model: 'spec-image', prompt: 'glass cube', size: '1:1' },
                },
              },
            },
            responses: {
              200: {
                content: {
                  'application/json': {
                    example: { data: [{ url: 'https://cdn.example.com/spec.png' }] },
                  },
                },
              },
            },
          },
        },
      },
    });

    const result = analyzeModelProtocolDocument(source);

    expect(result).toMatchObject({
      baseUrl: 'https://spec.example.com/v1',
      modelId: 'spec-image',
      category: 'image',
      formats: ['openapi', 'json'],
      protocol: {
        auth: { type: 'bearer' },
        mode: 'sync',
        submit: { method: 'POST', path: '/images/generations' },
        response: { result: { urlPath: 'data.*.url' } },
      },
    });
  });

  it('reports unsupported callback flows and rejects content without a request', () => {
    const callbackSource = `
const url = "https://api.example.com/v1/images/generations";
const payload = {
  model: "callback-image",
  prompt: "test",
  callback_url: "https://client.example.com/webhook"
};
fetch(url, { method: "POST", body: JSON.stringify(payload) });
{"task_id":"task_example","status":"submitted"}`;

    const callbackResult = analyzeModelProtocolDocument(callbackSource);
    expect(callbackResult.warnings.some((warning) => warning.includes('Webhook'))).toBe(true);
    expect(callbackResult.protocol).toBeUndefined();

    const bodyKeySource = `
const url = "https://api.example.com/v1/images/generations";
const payload = { model: "secret-image", prompt: "test", api_key: "sk-body-secret-value" };
fetch(url, { method: "POST", body: JSON.stringify(payload) });
{"data":[{"url":"https://cdn.example.com/result.png"}]}`;
    const bodyKeyResult = analyzeModelProtocolDocument(bodyKeySource);
    expect(bodyKeyResult.protocol).toBeUndefined();
    expect(bodyKeyResult.warnings.some((warning) => warning.includes('请求体鉴权'))).toBe(true);
    expect(JSON.stringify(bodyKeyResult)).not.toContain('sk-body-secret-value');

    expect(() => analyzeModelProtocolDocument('{"status":"completed"}'))
      .toThrow('没有识别到请求示例');
    expect(() => analyzeModelProtocolDocument('openapi: 3.0.3\npaths:\n  /images:\n    post: {}'))
      .toThrow('OpenAPI YAML');
  });
});
