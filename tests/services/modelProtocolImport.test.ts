import { describe, expect, it } from 'vitest';
import {
  analyzeModelProtocolDocument,
  analyzeModelProtocolExamples,
} from '../../src/services/ai/modelProtocolImport';
import { buildModelProtocolRequest } from '../../src/services/ai/modelProtocol';

describe('model protocol document import', () => {
  it('imports an async image API with data URL reference arrays', () => {
    const result = analyzeModelProtocolExamples({
      submitRequest: `
curl -sS -X POST "https://www.right.codes/draw/v1/images/generations" \\
  -H "Authorization: Bearer sk-placeholder" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "nano-banana-fast",
    "prompt": "参考这张图修改风格",
    "n": 1,
    "size": "16:9",
    "imageSize": "1K",
    "async": true,
    "image": ["data:image/png;base64,{BASE64_IMAGE}"]
  }'`,
      submitResponse: `{
        "task_id": "task_0123456789abcdef",
        "status": "processing",
        "progress": 0
      }`,
      pollRequest: `
curl -sS "https://www.right.codes/v1/tasks/task_0123456789abcdef" \\
  -H "Authorization: Bearer sk-placeholder"`,
      pollResponse: `{
        "task_id": "task_0123456789abcdef",
        "status": "completed",
        "progress": 100,
        "data": [{ "url": "https://cdn.example.com/result.png" }]
      }`,
    });

    expect(result).toMatchObject({
      baseUrl: 'https://www.right.codes',
      modelId: 'nano-banana-fast',
      category: 'image',
      imageReferenceRequestMode: 'generation-json-image-data-urls',
      protocol: {
        mode: 'async',
        submit: {
          path: '/draw/v1/images/generations',
          body: {
            model: '{{model}}',
            prompt: '{{prompt}}',
            n: '{{n}}',
            size: '{{aspectRatio}}',
            imageSize: '{{imageSize}}',
            async: true,
            image: '{{imageUrls}}',
          },
        },
        response: { taskIdPath: 'task_id' },
        poll: {
          path: '/v1/tasks/{{submit.task_id}}',
          response: {
            statusPath: 'status',
            result: { urlPath: 'data.*.url' },
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('sk-placeholder');
    expect(JSON.stringify(result)).not.toContain('{BASE64_IMAGE}');
  });

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
          path: '/tasks/{{submit.data.0.task_id}}',
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
          path: '/tasks/{{submit.data.0.task_id}}',
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
          query: { video_id: '{{submit.video_id}}' },
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

  it('maps Agnes 2.5 string seconds, resolution preset and input mode without fixing sample values', () => {
    const result = analyzeModelProtocolExamples({
      submitRequest: `curl -X POST https://api.agnes-ai.cn/v1/videos -H "Content-Type: application/json" -d '{
        "model":"agnes-video-2.5-flash",
        "prompt":"海边奔跑",
        "seconds":"5",
        "mode":"text",
        "size":"720P",
        "aspect_ratio":"16:9",
        "n":1
      }'`,
      submitResponse: '{"video_id":"video_example","status":"queued"}',
      pollRequest: 'curl "https://api.agnes-ai.cn/agnesapi?video_id=video_example&model_name=agnes-video-2.5-flash"',
      pollResponse: '{"status":"completed","url":"https://cdn.example/result.mp4"}',
    }, {
      baseUrl: 'https://api.agnes-ai.cn/v1',
      category: 'video',
      modelId: 'agnes-video-2.5-flash',
    });

    expect(result.protocol).toMatchObject({
      submit: {
        path: '/videos',
        body: {
          seconds: '{{durationText}}',
          mode: '{{videoInputMode}}',
          size: '{{seedanceResolution}}',
          aspect_ratio: '{{aspectRatio}}',
        },
      },
      response: { taskIdPath: 'video_id' },
      poll: {
        path: '/agnesapi',
        pathMode: 'origin',
        query: {
          video_id: '{{submit.video_id}}',
          // 单模型协议里轮询模型名保持文档常量；任务 ID 才必须动态绑定。
          model_name: 'agnes-video-2.5-flash',
        },
      },
    });

    if (!result.protocol || !result.baseUrl) throw new Error('Agnes 2.5 示例没有生成协议');
    const request = buildModelProtocolRequest({
      apiKey: '',
      baseUrl: result.baseUrl,
      protocol: result.protocol,
      variables: {
        model: 'agnes-video-2.5-flash',
        prompt: '海边奔跑',
        durationText: '8',
        videoInputMode: 'reference',
        seedanceResolution: '720P',
        aspectRatio: '9:16',
      },
    });
    expect(request.renderedBody).toMatchObject({
      seconds: '8',
      mode: 'reference',
      size: '720P',
      aspect_ratio: '9:16',
    });
  });

  it('imports an OpenAI-style async video protocol with reference media fields', () => {
    const result = analyzeModelProtocolExamples({
      submitRequest: `
curl -X POST https://www.geeknow.top/v1/videos \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "doubao-seedance-2-0-260128",
    "prompt": "A cinematic product video",
    "duration": 6,
    "aspect_ratio": "16:9",
    "resolution": "720P",
    "generate_audio": true,
    "first_image": "https://cdn.example/first.png",
    "last_image": "https://cdn.example/last.png",
    "reference_image_urls": ["https://cdn.example/product.png"],
    "video_urls": ["https://cdn.example/source.mp4"],
    "reference_video_urls": ["https://cdn.example/motion.mp4"],
    "audio_urls": ["https://cdn.example/source.mp3"],
    "reference_audio_urls": ["https://cdn.example/music.mp3"]
  }'`,
      submitResponse: `{
        "id": "task_video_1",
        "object": "video",
        "status": "queued"
      }`,
      pollRequest: `
curl -X GET https://www.geeknow.top/v1/videos/task_video_1 \\
  -H "Authorization: Bearer YOUR_API_KEY"`,
      pollResponse: `{
        "id": "task_video_1",
        "status": "completed",
        "video_url": "https://cdn.example/result.mp4",
        "error": null
      }`,
    });

    expect(result.warnings).toEqual([]);
    expect(result).toMatchObject({
      modelId: 'doubao-seedance-2-0-260128',
      category: 'video',
      protocol: {
        mode: 'async',
        submit: {
          body: {
            model: '{{model}}',
            prompt: '{{prompt}}',
            duration: '{{duration}}',
            aspect_ratio: '{{aspectRatio}}',
            resolution: '{{seedanceResolution}}',
            generate_audio: '{{generateAudio}}',
            first_image: '{{firstImage}}',
            last_image: '{{lastImage}}',
            reference_image_urls: '{{referenceImageUrls}}',
            video_urls: '{{videoUrls}}',
            reference_video_urls: '{{referenceVideoUrls}}',
            audio_urls: '{{audioUrls}}',
            reference_audio_urls: '{{referenceAudioUrls}}',
          },
        },
        response: { taskIdPath: 'id' },
        poll: {
          response: {
            statusPath: 'status',
            result: { urlPath: 'video_url' },
            errorPath: 'error',
          },
        },
      },
    });
    expect(JSON.stringify(result.protocol?.poll)).toContain('{{submit.id}}');
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

  it('maps relay video role images and relay TTS text onto project variables', () => {
    const video = analyzeModelProtocolExamples({
      submitRequest: `
curl -sS -X POST "https://relay.example.com/v1/videos" \\
  -H "Authorization: Bearer sk-placeholder" \\
  -d '{
    "model": "doubao-seedance-2.5",
    "prompt": "一只猫走过街道",
    "duration": 5,
    "resolution": "720p",
    "size": "16:9",
    "image_with_roles": [{ "url": "https://cdn.example.com/first.png", "role": "first_frame" }]
  }'`,
      submitResponse: '{"task_id":"task_0123456789abcdef","status":"processing"}',
      pollRequest: `curl -sS "https://relay.example.com/v1/videos/task_0123456789abcdef" -H "Authorization: Bearer sk-placeholder"`,
      pollResponse: '{"task_id":"task_0123456789abcdef","status":"completed","data":[{"url":"https://cdn.example.com/result.mp4"}]}',
    });

    expect(video).toMatchObject({
      category: 'video',
      protocol: {
        submit: {
          body: {
            model: '{{model}}',
            prompt: '{{prompt}}',
            duration: '{{duration}}',
            resolution: '{{seedanceResolution}}',
            size: '{{aspectRatio}}',
            image_with_roles: '{{imageWithRoles}}',
          },
        },
      },
    });

    const speech = analyzeModelProtocolExamples({
      submitRequest: `
curl -sS -X POST "https://relay.example.com/v1/audio/speech" \\
  -H "Authorization: Bearer sk-placeholder" \\
  -d '{ "model": "tts-1", "input": "示例文案", "voice": "alloy", "response_format": "mp3" }'`,
      submitResponse: '{"data":[{"url":"https://cdn.example.com/result.mp3"}]}',
    });

    expect(speech).toMatchObject({
      category: 'audio',
      protocol: {
        submit: {
          body: {
            model: '{{model}}',
            // 中转 TTS 的待合成文本字段是 input，不映射就会固定发出示例文案
            input: '{{prompt}}',
            voice: '{{audioVoice}}',
            response_format: '{{audioFormat}}',
          },
        },
      },
    });
  });

  it('imports MetaSo-style numeric video tasks without flattening media URL wrappers', () => {
    const result = analyzeModelProtocolExamples({
      submitRequest: `
curl -sS -X POST "https://relay.example.com/v1/video_generation" \\
  -H "Authorization: Bearer sk-placeholder" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "MiniMax-H3",
    "content": [
      { "type": "text", "text": "让人物向镜头挥手" },
      { "type": "image_url", "image_url": { "url": "https://cdn.example.com/reference.png" }, "role": "reference_image" },
      { "type": "video_url", "video_url": { "url": "https://cdn.example.com/reference.mp4" }, "role": "reference_video" },
      { "type": "audio_url", "audio_url": { "url": "https://cdn.example.com/reference.mp3" }, "role": "reference_audio" }
    ],
    "duration": 6,
    "resolution": "768P",
    "ratio": "16:9"
  }'`,
      submitResponse: '{"task_id":424010985738629}',
      pollRequest: 'curl -sS "https://relay.example.com/query/video_generation/424010985738629" -H "Authorization: Bearer sk-placeholder"',
      pollResponse: '{"task":{"status":"success","content":{"url":"https://cdn.example.com/result.mp4"}}}',
    }, {
      baseUrl: 'https://relay.example.com/v1',
    });

    expect(result).toMatchObject({
      baseUrl: 'https://relay.example.com/v1',
      category: 'video',
      protocol: {
        mode: 'async',
        submit: {
          path: '/video_generation',
          body: {
            content: [
              { type: 'text', text: '{{prompt}}' },
              {
                $forEach: '{{referenceImageUrls}}',
                $value: { type: 'image_url', image_url: { url: '{{referenceImageUrls}}' }, role: 'reference_image' },
              },
              {
                $forEach: '{{referenceVideoUrls}}',
                $value: { type: 'video_url', video_url: { url: '{{referenceVideoUrls}}' }, role: 'reference_video' },
              },
              {
                $forEach: '{{referenceAudioUrls}}',
                $value: { type: 'audio_url', audio_url: { url: '{{referenceAudioUrls}}' }, role: 'reference_audio' },
              },
            ],
          },
        },
        response: { taskIdPath: 'task_id' },
        poll: {
          path: '/query/video_generation/{{submit.task_id}}',
          pathMode: 'origin',
          response: {
            statusPath: 'task.status',
            result: { urlPath: 'task.content.url' },
          },
        },
      },
    });
    expect(JSON.stringify(result.protocol?.submit.body)).not.toContain('cdn.example.com');

    if (!result.protocol) throw new Error('MetaSo 示例没有生成调用协议');
    const withoutReferences = buildModelProtocolRequest({
      apiKey: 'test-key',
      baseUrl: result.baseUrl!,
      protocol: result.protocol,
      variables: {
        model: 'MiniMax-H3',
        prompt: '让人物向镜头挥手',
        duration: 6,
        seedanceResolution: '768P',
        aspectRatio: '16:9',
      },
    });
    expect(withoutReferences.renderedBody).toMatchObject({
      model: 'MiniMax-H3',
      content: [{ type: 'text', text: '让人物向镜头挥手' }],
      duration: 6,
      resolution: '768P',
      ratio: '16:9',
    });

    const withReferences = buildModelProtocolRequest({
      apiKey: 'test-key',
      baseUrl: result.baseUrl!,
      protocol: result.protocol,
      variables: {
        model: 'MiniMax-H3',
        prompt: '让人物向镜头挥手',
        referenceImageUrls: [
          'https://assets.example/reference-1.png',
          'https://assets.example/reference-2.png',
        ],
        referenceVideoUrls: [
          'https://assets.example/reference-1.mp4',
          'https://assets.example/reference-2.mp4',
        ],
        referenceAudioUrls: [
          'https://assets.example/reference-1.mp3',
          'https://assets.example/reference-2.mp3',
        ],
        duration: 6,
        seedanceResolution: '768P',
        aspectRatio: '16:9',
      },
    });
    expect(withReferences.renderedBody).toMatchObject({
      content: [
        { type: 'text', text: '让人物向镜头挥手' },
        { type: 'image_url', image_url: { url: 'https://assets.example/reference-1.png' }, role: 'reference_image' },
        { type: 'image_url', image_url: { url: 'https://assets.example/reference-2.png' }, role: 'reference_image' },
        { type: 'video_url', video_url: { url: 'https://assets.example/reference-1.mp4' }, role: 'reference_video' },
        { type: 'video_url', video_url: { url: 'https://assets.example/reference-2.mp4' }, role: 'reference_video' },
        { type: 'audio_url', audio_url: { url: 'https://assets.example/reference-1.mp3' }, role: 'reference_audio' },
        { type: 'audio_url', audio_url: { url: 'https://assets.example/reference-2.mp3' }, role: 'reference_audio' },
      ],
    });
  });

  it('keeps MetaSo keyframes singular and separate from repeatable reference images', () => {
    const result = analyzeModelProtocolExamples({
      submitRequest: `curl -sS -X POST "https://relay.example.com/v1/video_generation" -d '{
        "model":"MiniMax-H3",
        "content":[
          {"type":"text","text":"镜头推进"},
          {"type":"image_url","image_url":{"url":"https://cdn.example.com/first.png"},"role":"first_frame"},
          {"type":"image_url","image_url":{"url":"https://cdn.example.com/last.png"},"role":"last_frame"}
        ]
      }'`,
      submitResponse: '{"url":"https://cdn.example.com/result.mp4"}',
    });

    expect(result.protocol?.submit.body).toMatchObject({
      content: [
        { type: 'text', text: '{{prompt}}' },
        {
          $whenPresent: '{{firstImage}}',
          $value: { type: 'image_url', image_url: { url: '{{firstImage}}' }, role: 'first_frame' },
        },
        {
          $whenPresent: '{{lastImage}}',
          $value: { type: 'image_url', image_url: { url: '{{lastImage}}' }, role: 'last_frame' },
        },
      ],
    });
  });

  it('expands a generic reference role by known media type instead of keeping only item zero', () => {
    const result = analyzeModelProtocolExamples({
      submitRequest: `curl -sS -X POST "https://relay.example.com/v1/video_generation" -d '{
        "model":"MiniMax-H3",
        "content":[
          {"type":"text","text":"参考素材"},
          {"type":"image_url","image_url":{"url":"https://cdn.example.com/ref.png"},"role":"reference"},
          {"type":"video_url","video_url":{"url":"https://cdn.example.com/ref.mp4"},"role":"reference"},
          {"type":"audio_url","audio_url":{"url":"https://cdn.example.com/ref.mp3"},"role":"reference"}
        ]
      }'`,
      submitResponse: '{"url":"https://cdn.example.com/result.mp4"}',
    });

    expect(result.protocol?.submit.body).toMatchObject({
      content: [
        { type: 'text', text: '{{prompt}}' },
        {
          $forEach: '{{referenceImageUrls}}',
          $value: { image_url: { url: '{{referenceImageUrls}}' }, role: 'reference' },
        },
        {
          $forEach: '{{referenceVideoUrls}}',
          $value: { video_url: { url: '{{referenceVideoUrls}}' }, role: 'reference' },
        },
        {
          $forEach: '{{referenceAudioUrls}}',
          $value: { audio_url: { url: '{{referenceAudioUrls}}' }, role: 'reference' },
        },
      ],
    });
  });

  it('requires manual review when role reference has no trusted media mapping', () => {
    const result = analyzeModelProtocolExamples({
      submitRequest: `curl -sS -X POST "https://relay.example.com/v1/video_generation" -d '{
        "model":"MiniMax-H3",
        "content":[
          {"type":"media_url","media_url":{"url":"https://cdn.example.com/ref.bin"},"role":"reference"}
        ]
      }'`,
      submitResponse: '{"url":"https://cdn.example.com/result.mp4"}',
    });

    expect(result.protocol).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.stringContaining('role="reference"'));
  });

  it('does not auto-wrap composite content media items and emits a review warning', () => {
    const result = analyzeModelProtocolExamples({
      submitRequest: `
curl -sS -X POST "https://relay.example.com/v1/video_generation" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "video-model",
    "content": [{
      "type": "image_url",
      "image_url": { "url": "https://cdn.example.com/first.png" },
      "role": "first_frame",
      "caption": "this field is coupled to the image"
    }]
  }'`,
      submitResponse: '{"url":"https://cdn.example.com/result.mp4"}',
    });

    expect(result.protocol).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.stringContaining('复合或多参考媒体项'));
  });

  it('removes dangerous object keys from strict JSON request examples', () => {
    const result = analyzeModelProtocolExamples({
      submitRequest: `curl -sS -X POST "https://relay.example.com/v1/video_generation" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"video-model","prompt":"test","__proto__":{"polluted":true}}'`,
      submitResponse: '{"url":"https://cdn.example.com/result.mp4"}',
    });

    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('__proto__');
    expect(result.warnings).toContainEqual(expect.stringContaining('不安全对象键'));
  });

  it('replaces string task IDs after a video-generation path container', () => {
    const result = analyzeModelProtocolExamples({
      submitRequest: `curl -sS -X POST "https://relay.example.com/v1/video-generation" -d '{"model":"video-pro","prompt":"test"}'`,
      submitResponse: '{"task_id":"video-task-1"}',
      pollRequest: 'curl -sS "https://relay.example.com/v1/query/video-generation/video-task-1"',
      pollResponse: '{"status":"completed","video_url":"https://cdn.example.com/result.mp4"}',
    });

    expect(result.protocol).toMatchObject({
      mode: 'async',
      response: { taskIdPath: 'task_id' },
      poll: {
        path: '/query/video-generation/{{submit.task_id}}',
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
