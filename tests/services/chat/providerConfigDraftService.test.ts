import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearProviderConfigDraftsForTests,
  createProviderConfigDraft,
  getProviderConfigDraft,
} from '../../../src/services/chat/providerConfigDraftService';

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
