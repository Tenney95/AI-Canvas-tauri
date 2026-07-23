import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fileMocks = vi.hoisted(() => ({
  saveConfig: vi.fn(async () => undefined),
  loadConfig: vi.fn(),
  setBaseDataDir: vi.fn(),
  syncAuthorizedDirectories: vi.fn(async () => undefined),
}));

vi.mock('../../../src/services/fileService', () => fileMocks);

import { useAppStore } from '../../../src/store/useAppStore';
import {
  clearProviderConfigDraftsForTests,
  getProviderConfigDraft,
} from '../../../src/services/chat/providerConfigDraftService';
import { registerProviderConfigAgentTools } from '../../../src/services/chat/tools/providerConfigTools';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  prepareAgentToolCall,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';

const context: AgentToolContext = {
  taskId: 'task-1',
  projectId: 'project-1',
  conversationId: 'conversation-1',
  mode: 'collaborative',
  signal: new AbortController().signal,
};

function previewInput(connectionId?: string) {
  return {
    ...(connectionId ? { connectionId } : {}),
    connectionName: 'Example AI',
    models: [{
      modelId: 'image-pro',
      name: 'Image Pro',
      category: 'image',
      submitRequest: `
curl https://gateway.example.com/v1/images/generations \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"image-pro","prompt":"glass cube"}'`,
      submitResponse: '{"data":[{"url":"https://cdn.example.com/image.png"}]}',
    }],
  };
}

function readDraftId(modelContent: string): string {
  const match = modelContent.match(/draftId:\s*([^\s]+)/);
  if (!match) throw new Error('preview result did not include draftId');
  return match[1];
}

const GEMINI_USER_EXAMPLE = `
const body = JSON.stringify({
  "contents": [{}],
  "generationConfig": {
    "responseModalities": ["string"],
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
})

{
  "candidates": [{
    "content": { "role": "string", "parts": [{}] },
    "finishReason": "string",
    "safetyRatings": [{}]
  }],
  "usageMetadata": {
    "promptTokenCount": 0,
    "candidatesTokenCount": 0,
    "totalTokenCount": 0
  }
}`;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ configHydrated: true });
  fileMocks.saveConfig.mockClear();
  fileMocks.syncAuthorizedDirectories.mockClear();
  registerProviderConfigAgentTools();
});

afterEach(() => {
  clearAgentToolRegistryForTests();
  clearProviderConfigDraftsForTests();
});

describe('provider config agent tools', () => {
  it('rejects API Key fields at the local tool schema boundary', () => {
    const result = prepareAgentToolCall({
      callId: 'call-preview',
      toolId: 'provider_config_preview',
      input: { ...previewInput(), apiKey: 'must-not-enter-agent-input' },
    }, context);

    expect(result).toMatchObject({ ok: false, result: { status: 'error' } });
  });

  it('creates a credential-free task draft from model examples', async () => {
    const tool = getAgentTool('provider_config_preview');
    expect(tool?.effect).toBe('read');

    const result = await tool!.execute(context, previewInput());

    expect(result).toMatchObject({ status: 'success' });
    expect(result.modelContent).toContain('draftId: provider-draft-');
    expect(result.modelContent).toContain('不会写入 API Key');
    expect(result.modelContent).not.toContain('<token>');
  });

  it('falls back to a recent user example when a retry omits the Fetch request', async () => {
    useAppStore.setState({
      messages: [{
        id: 'message-gemini-example',
        conversationId: context.conversationId,
        role: 'user',
        content: GEMINI_USER_EXAMPLE,
        timestamp: 1,
        status: 'done',
      }, {
        id: 'message-retry',
        conversationId: context.conversationId,
        role: 'user',
        content: '再次尝试一下',
        timestamp: 2,
        status: 'done',
      }],
    });
    const task = useAppStore.getState().createAgentTask({
      projectId: context.projectId,
      conversationId: context.conversationId,
      userMessageId: 'message-retry',
      mode: context.mode,
      goal: '再次尝试一下',
    });
    const result = await getAgentTool('provider_config_preview')!.execute(
      { ...context, taskId: task.id },
      {
        connectionName: 'NewAPI Gemini图像生成',
        baseUrl: 'https://gateway.newapi.example',
        models: [{
          modelId: 'gemini-image',
          category: 'image',
          submitRequest: '{ "contents": [{}], "generationConfig": {} }',
          submitResponse: '{ "candidates": [{ "content": { "parts": [{}] } }] }',
        }],
      },
    );

    expect(result).toMatchObject({ status: 'success' });
    const draft = getProviderConfigDraft(task.id, readDraftId(result.modelContent));
    expect(draft.config.selectedModels?.[0]?.executionProfile).toMatchObject({
      preset: 'custom',
      protocol: {
        submit: {
          path: '/v1beta/models/{{model}}:generateContent/',
          body: {
            contents: [{ role: 'user', parts: [{ text: '{{prompt}}' }] }],
            generationConfig: { responseModalities: ['IMAGE'] },
          },
        },
        response: {
          result: {
            base64Path: 'candidates.*.content.parts.*.inlineData.data',
          },
        },
      },
    });
  });

  it('applies an approved draft while preserving an existing API Key', async () => {
    useAppStore.getState().saveProviderConfig('custom-existing', {
      name: 'Old Name',
      apiKey: 'existing-secret-value',
      baseUrl: 'https://old.example.com/v1',
      catalogId: 'custom-openai',
      selectedModels: [],
    });
    const preview = await getAgentTool('provider_config_preview')!.execute(
      context,
      previewInput('custom-existing'),
    );
    const draftId = readDraftId(preview.modelContent);
    const applyTool = getAgentTool('provider_config_apply');
    expect(applyTool?.effect).toBe('config_write');

    const result = await applyTool!.execute(context, { draftId });

    expect(result).toMatchObject({ status: 'success' });
    expect(useAppStore.getState().config.providers['custom-existing']).toMatchObject({
      name: 'Example AI',
      apiKey: 'existing-secret-value',
      baseUrl: 'https://gateway.example.com/v1',
      selectedModels: [{ id: 'image-pro', category: 'image' }],
    });
    expect(fileMocks.saveConfig).toHaveBeenCalledTimes(1);
    expect(result.summary).not.toContain('existing-secret-value');
    expect(result.modelContent).not.toContain('existing-secret-value');
  });

  it('writes an empty API Key for a new connection and prevents cross-task apply', async () => {
    const preview = await getAgentTool('provider_config_preview')!.execute(context, previewInput());
    const draftId = readDraftId(preview.modelContent);
    const applyTool = getAgentTool('provider_config_apply')!;

    const denied = await applyTool.execute({ ...context, taskId: 'task-2' }, { draftId });
    expect(denied).toMatchObject({ status: 'error', errorCode: 'PROVIDER_CONFIG_DRAFT_REJECTED' });

    const applied = await applyTool.execute(context, { draftId });
    expect(applied).toMatchObject({ status: 'success' });
    const customConfig = Object.values(useAppStore.getState().config.providers)[0];
    expect(customConfig.apiKey).toBe('');
  });
});
