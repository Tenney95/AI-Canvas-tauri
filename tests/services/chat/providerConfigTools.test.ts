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
  type ProviderConfigDraftInput,
} from '../../../src/services/chat/providerConfigDraftService';
import { registerProviderConfigAgentTools } from '../../../src/services/chat/tools/providerConfigTools';
import { evaluateAgentToolPolicy } from '../../../src/services/chat/policyEngine';
import { prepareApprovalInput } from '../../../src/services/chat/agentRoundExecutor';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  prepareAgentToolCall,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';
import type { ModelExecutionProtocol } from '../../../src/types/aiTypes';

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

const DECLARATIVE_PROTOCOL: ModelExecutionProtocol = {
  version: 2,
  mode: 'sync',
  auth: { type: 'bearer' },
  submit: {
    method: 'POST',
    path: '/videos',
    maxBodyBytes: 4_096,
    body: { model: '{{model}}', prompt: '{{prompt}}' },
  },
  response: {
    type: 'json',
    result: { urlPath: 'data.url' },
  },
};

function declarativePreviewInput(): ProviderConfigDraftInput {
  return {
    connectionName: 'Declarative Relay',
    baseUrl: 'https://gateway.example.com/v1',
    models: [{
      protocolSource: 'declarative',
      modelId: 'video-pro',
      category: 'video',
      videoCapability: { operations: ['text-to-video'] },
      executionProtocol: structuredClone(DECLARATIVE_PROTOCOL),
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

  it('exposes the canonical video capability fields through the preview tool schema', () => {
    const tool = getAgentTool('provider_config_preview')!;
    const modelsSchema = tool.inputSchema.properties?.models;
    const modelSchema = modelsSchema?.items;
    const capabilitySchema = modelSchema?.properties?.videoCapability;
    const capabilityProperties = capabilitySchema?.properties;

    expect(capabilityProperties).toEqual(expect.objectContaining({
      operations: expect.any(Object),
      requiresReference: expect.any(Object),
      frameRates: expect.any(Object),
      defaultFrameRate: expect.any(Object),
      allowFrameAndReferenceMix: expect.any(Object),
      inputModeCapabilities: expect.any(Object),
      inputConstraints: expect.any(Object),
    }));
    expect(capabilitySchema?.required).toEqual(['operations']);
    expect(capabilityProperties?.operations.minItems).toBe(1);
    expect(capabilityProperties?.inputConstraints.properties).toEqual(expect.objectContaining({
      promptMinCharacters: expect.any(Object),
      maxBase64DecodedBytes: expect.any(Object),
      referenceVideo: expect.any(Object),
      referenceAudio: expect.any(Object),
    }));
    expect(capabilityProperties?.inputModeCapabilities.properties).toEqual(expect.objectContaining({
      text: expect.any(Object),
      keyframe: expect.any(Object),
      reference: expect.any(Object),
      mixed: expect.any(Object),
    }));
    expect(capabilityProperties?.inputConstraints.properties?.referenceVideo.properties)
      .toHaveProperty('totalDurationSeconds');
    expect(capabilityProperties?.inputConstraints.properties?.referenceAudio.properties)
      .toHaveProperty('totalDurationSeconds');

    const prepared = prepareAgentToolCall({
      callId: 'call-video-capability-preview',
      toolId: 'provider_config_preview',
      input: {
        connectionName: 'Video Relay',
        models: [{
          modelId: 'video-pro',
          category: 'video',
          submitRequest: 'POST https://gateway.example.com/v1/videos HTTP/1.1',
          submitResponse: '{"task_id":"task-1"}',
          videoCapability: {
            operations: ['image-to-video', 'video-to-video'],
            requiresReference: true,
            ratios: ['16:9'],
            inputModeCapabilities: {
              keyframe: { ratios: ['16:9'], defaultRatio: '16:9', requiresRatio: true },
            },
            frameRates: [24, 30],
            defaultFrameRate: 24,
            allowFrameAndReferenceMix: false,
            inputConstraints: {
              promptMinCharacters: 1,
              maxBase64DecodedBytes: 20971520,
              referenceVideo: {
                width: { min: 480, max: 1920, minExclusive: true },
                durationSeconds: { min: 1, max: 15 },
                totalDurationSeconds: { min: 1, max: 30 },
              },
              referenceAudio: {
                durationSeconds: { min: 0, max: 15, minExclusive: true },
                totalDurationSeconds: { min: 0, max: 30, minExclusive: true },
              },
            },
          },
        }],
      },
    }, context);
    expect(prepared).toMatchObject({ ok: true });
  });

  it('exposes and executes the declarative protocol input without request examples', async () => {
    const tool = getAgentTool('provider_config_preview')!;
    const modelSchema = tool.inputSchema.properties?.models.items;

    expect(modelSchema?.required).toEqual(['modelId']);
    expect(modelSchema?.properties).toEqual(expect.objectContaining({
      protocolSource: expect.objectContaining({ enum: ['examples', 'declarative'] }),
      executionProtocol: expect.objectContaining({ type: 'object' }),
      submitRequest: expect.any(Object),
      submitResponse: expect.any(Object),
    }));
    expect(tool.description).toContain('$whenPresent');
    expect(tool.description).toContain('$forEach');
    expect(tool.description).toContain('请求体数组元素');
    expect(tool.description).toContain('referenceImageUrls/referenceVideoUrls/referenceAudioUrls');
    expect(tool.description).toContain('submit.maxBodyBytes');
    expect(modelSchema?.properties?.executionProtocol.description).toContain('受信变量');
    expect(modelSchema?.properties?.executionProtocol.description).toContain('$whenPresent');
    expect(modelSchema?.properties?.executionProtocol.description).toContain('$forEach');
    expect(modelSchema?.properties?.executionProtocol.description).toContain('body 数组项');

    const input = declarativePreviewInput();
    const prepared = prepareAgentToolCall({
      callId: 'call-declarative-preview',
      toolId: 'provider_config_preview',
      input,
    }, context);
    expect(prepared).toMatchObject({ ok: true });

    const result = await tool.execute(context, input);
    expect(result).toMatchObject({ status: 'success' });
    const draft = getProviderConfigDraft(context.taskId, readDraftId(result.modelContent));
    expect(draft.config.selectedModels?.[0]?.executionProfile).toMatchObject({
      preset: 'custom',
      protocol: {
        version: 2,
        mode: 'sync',
        submit: { path: '/videos' },
        response: { result: { urlPath: 'data.url' } },
      },
    });
    expect(result.modelContent).not.toContain('/videos');
  });

  it('rejects credential fields nested inside a declarative protocol before drafting', async () => {
    const input = declarativePreviewInput();
    (input.models[0].executionProtocol!.submit.body as Record<string, unknown>).apiKey = 'secret';

    const result = await getAgentTool('provider_config_preview')!.execute(context, input);

    expect(result).toMatchObject({ status: 'error', retryable: false });
    expect(result.modelContent).toMatch(/API Key|凭据/);
    expect(result.modelContent).not.toContain('secret');
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

  it('accepts and persists a data URL reference mode declared from image API docs', async () => {
    const input = previewInput();
    input.models[0].submitRequest = `
curl https://gateway.example.com/v1/images/generations \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"image-pro","prompt":"glass cube","image":["data:image/png;base64,{BASE64_IMAGE}"]}'`;
    const toolInput = {
      ...input,
      models: [{
        ...input.models[0],
        imageReferenceRequestMode: 'generation-json-image-data-urls' as const,
      }],
    };
    const prepared = prepareAgentToolCall({
      callId: 'call-data-url-preview',
      toolId: 'provider_config_preview',
      input: toolInput,
    }, context);
    expect(prepared).toMatchObject({ ok: true });

    const result = await getAgentTool('provider_config_preview')!.execute(context, toolInput);

    expect(result).toMatchObject({ status: 'success' });
    const draft = getProviderConfigDraft(context.taskId, readDraftId(result.modelContent));
    expect(draft.config.selectedModels?.[0]).toMatchObject({
      imageReferenceRequestMode: 'generation-json-image-data-urls',
      executionProfile: {
        protocol: { submit: { body: { image: '{{imageUrls}}' } } },
      },
    });
    expect(draft.summary).toContain('参考图：data URL 数组');
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


  it('并入已有连接时保留原有模型，不再整体替换', async () => {
    useAppStore.getState().saveProviderConfig('custom-existing', {
      name: '我的连接',
      apiKey: 'existing-secret-value',
      baseUrl: 'https://gateway.example.com/v1',
      catalogId: 'custom-openai',
      selectedModels: [
        { id: 'text-a', name: '文本A', category: 'text', provider: 'custom-existing' },
        { id: 'text-b', name: '文本B', category: 'text', provider: 'custom-existing' },
        { id: 'video-c', name: '视频C', category: 'video', provider: 'custom-existing' },
      ],
    });

    const preview = await getAgentTool('provider_config_preview')!.execute(
      context,
      previewInput('custom-existing'),
    );
    const draftId = readDraftId(preview.modelContent);
    const result = await getAgentTool('provider_config_apply')!.execute(context, { draftId });

    expect(result.status).toBe('success');
    const saved = useAppStore.getState().config.providers['custom-existing'];
    expect(saved.selectedModels?.map((model) => model.id))
      .toEqual(['text-a', 'text-b', 'video-c', 'image-pro']);
    expect(saved.apiKey).toBe('existing-secret-value');
    // generalModels 中的原有关联项不能被连带删除
    expect((useAppStore.getState().config.generalModels ?? []).map((model) => model.modelId).sort())
      .toEqual(['image-pro', 'text-a', 'text-b', 'video-c']);
    expect(result.summary).toContain('新增 1 个模型');
    expect(result.summary).toContain('保留原有 3 个模型');
  });

  it('同 ID 模型由草稿覆盖，其余模型原样保留', async () => {
    useAppStore.getState().saveProviderConfig('custom-existing', {
      name: '我的连接',
      apiKey: 'k',
      baseUrl: 'https://gateway.example.com/v1',
      catalogId: 'custom-openai',
      selectedModels: [
        { id: 'image-pro', name: '旧名字', category: 'image', provider: 'custom-existing' },
        { id: 'text-a', name: '文本A', category: 'text', provider: 'custom-existing' },
      ],
    });

    const preview = await getAgentTool('provider_config_preview')!.execute(
      context,
      previewInput('custom-existing'),
    );
    const result = await getAgentTool('provider_config_apply')!.execute(
      context,
      { draftId: readDraftId(preview.modelContent) },
    );

    const saved = useAppStore.getState().config.providers['custom-existing'];
    expect(saved.selectedModels?.map((model) => model.id)).toEqual(['image-pro', 'text-a']);
    expect(saved.selectedModels?.find((model) => model.id === 'image-pro')?.name)
      .toBe('Image Pro');
    expect(result.summary).toContain('更新 1 个同 ID 模型');
    expect(result.summary).toContain('保留原有 1 个模型');
  });

  it('Base URL 与已有连接不一致时拒绝并入，不改动原配置', async () => {
    useAppStore.getState().saveProviderConfig('custom-existing', {
      name: '我的连接',
      apiKey: 'k',
      baseUrl: 'https://other-gateway.example.com/v1',
      catalogId: 'custom-openai',
      selectedModels: [
        { id: 'text-a', name: '文本A', category: 'text', provider: 'custom-existing' },
      ],
    });

    const preview = await getAgentTool('provider_config_preview')!.execute(
      context,
      previewInput('custom-existing'),
    );
    const draftId = readDraftId(preview.modelContent);
    const summary = getAgentTool('provider_config_apply')!.summarizeInput!({ draftId });
    const result = await getAgentTool('provider_config_apply')!.execute(context, { draftId });

    expect(result.status).toBe('error');
    expect(result.summary).toContain('不同网关');
    expect(summary).toContain('无法并入');
    const saved = useAppStore.getState().config.providers['custom-existing'];
    expect(saved.selectedModels?.map((model) => model.id)).toEqual(['text-a']);
    expect(saved.baseUrl).toBe('https://other-gateway.example.com/v1');
  });

  it('审批卡摘要说明新建连接的模型数量', async () => {
    const preview = await getAgentTool('provider_config_preview')!.execute(
      context,
      previewInput(),
    );
    const summary = getAgentTool('provider_config_apply')!.summarizeInput!({
      draftId: readDraftId(preview.modelContent),
    });
    expect(summary).toContain('新增 1 个模型');
    expect(summary).not.toContain('保留原有');
  });

  it('Base URL 相同的草稿并入已有连接，而不是新建重复连接', async () => {
    useAppStore.getState().saveProviderConfig('custom-relay', {
      name: '我的中转站',
      apiKey: 'relay-secret-value',
      // 末尾斜杠与大小写差异不应导致判成两个网关
      baseUrl: 'https://Gateway.example.com/v1/',
      catalogId: 'custom-openai',
      selectedModels: [{ id: 'text-a', name: 'Text A', category: 'text', provider: 'custom-relay' }],
    });
    // 助手没带 connectionId，按老逻辑会生成新的 custom-xxx 连接
    const preview = await getAgentTool('provider_config_preview')!.execute(context, previewInput());
    const draftId = readDraftId(preview.modelContent);

    const summary = getAgentTool('provider_config_apply')!.summarizeInput!({ draftId });
    expect(summary).toContain('并入已有连接“我的中转站”');

    const result = await getAgentTool('provider_config_apply')!.execute(context, { draftId });
    expect(result).toMatchObject({ status: 'success' });

    const providers = useAppStore.getState().config.providers;
    expect(Object.keys(providers)).toEqual(['custom-relay']);
    expect(providers['custom-relay']).toMatchObject({
      name: '我的中转站',
      apiKey: 'relay-secret-value',
    });
    expect(providers['custom-relay'].selectedModels?.map((model) => model.id))
      .toEqual(['text-a', 'image-pro']);
  });

  it('同 ID 且配置相同的模型直接跳过并给出提示', async () => {
    const first = await getAgentTool('provider_config_preview')!.execute(
      context,
      previewInput('custom-existing'),
    );
    await getAgentTool('provider_config_apply')!.execute(context, {
      draftId: readDraftId(first.modelContent),
    });

    // 完全相同的草稿再来一次：既不新增也不更新，只报告跳过
    const second = await getAgentTool('provider_config_preview')!.execute(
      context,
      previewInput('custom-existing'),
    );
    // 预览阶段就要提示，省得助手为已存在的模型再跑一轮
    expect(second.modelContent).toContain('已存在且配置相同的模型会被原样跳过');
    const draftId = readDraftId(second.modelContent);
    expect(getAgentTool('provider_config_apply')!.summarizeInput!({ draftId }))
      .toContain('跳过 1 个已存在且配置相同的模型（image-pro）');

    const result = await getAgentTool('provider_config_apply')!.execute(context, { draftId });
    expect(result.modelContent).toContain('以下模型已存在且配置相同，本次未改动：image-pro');
    expect(result.summary).not.toContain('新增');
    expect(useAppStore.getState().config.providers['custom-existing'].selectedModels)
      .toHaveLength(1);
  });

  it('applies an approved draft while preserving an existing API Key', async () => {
    // Base URL 必须与草稿一致，否则会被「不同网关不可并入」守卫拒绝（见上方用例）。
    useAppStore.getState().saveProviderConfig('custom-existing', {
      name: 'Old Name',
      apiKey: 'existing-secret-value',
      baseUrl: 'https://gateway.example.com/v1',
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
      // 并入已有连接只往里加模型，用户自己起的连接名不被草稿覆盖
      name: 'Old Name',
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

  it('allows a provider draft to cross audited tasks inside the same MCP control scope', async () => {
    const previewContext: AgentToolContext = {
      ...context,
      taskId: 'mcp-task-preview',
      conversationId: 'mcp-control-project-1',
      mode: 'autonomous',
    };
    const preview = await getAgentTool('provider_config_preview')!.execute(
      previewContext,
      declarativePreviewInput(),
    );
    const draftId = readDraftId(preview.modelContent);
    const applyContext = { ...previewContext, taskId: 'mcp-task-apply' };
    const applyTool = getAgentTool('provider_config_apply')!;

    expect(applyTool.authorize?.(applyContext, { draftId })).toEqual({ allowed: true });
    const applied = await applyTool.execute(applyContext, { draftId });

    expect(applied).toMatchObject({ status: 'success' });
    expect(Object.values(useAppStore.getState().config.providers)[0]).toMatchObject({
      name: 'Declarative Relay',
      apiKey: '',
      selectedModels: [expect.objectContaining({ id: 'video-pro', category: 'video' })],
    });
  });
});

describe('模型勾选卡片', () => {
  const models = [
    { id: 'lec-grok-4.5', name: 'Grok 4.5', category: 'text' as const },
    { id: 'lec-seed-2-0-900', name: 'Seedance 2.0 900', category: 'video' as const },
    { id: 'lec-seed-2-5-900', name: 'Seedance 2.5 900', category: 'video' as const },
  ];

  it('任何模式下都要用户作答，不会自动放行', () => {
    const tool = getAgentTool('provider_models_select')!;
    expect(tool.effect).toBe('user_choice');
    for (const mode of ['collaborative', 'autonomous'] as const) {
      const decision = evaluateAgentToolPolicy(tool, { models }, { ...context, mode });
      expect(decision).toMatchObject({ outcome: 'require_approval', approvalKind: 'user_choice' });
    }
  });

  it('把候选模型交给审批卡渲染成勾选列表', () => {
    const tool = getAgentTool('provider_models_select')!;
    const { inputRequest } = prepareApprovalInput(
      { definition: tool, input: { models } } as never,
      '接入中转站',
    );
    expect(inputRequest).toEqual({ kind: 'provider_models', options: models });
  });

  it('只把用户勾中的模型交回给助手', async () => {
    const tool = getAgentTool('provider_models_select')!;
    const result = await tool.execute(context, {
      models,
      selectedIds: ['lec-seed-2-0-900', 'lec-seed-2-5-900'],
    });
    expect(result.status).toBe('success');
    expect(result.modelContent).toContain('Seedance 2.0 900（lec-seed-2-0-900，video）');
    expect(result.modelContent).toContain('Seedance 2.5 900');
    expect(result.modelContent).not.toContain('Grok 4.5');

    const empty = await tool.execute(context, { models, selectedIds: [] });
    expect(empty.status).toBe('error');
    expect(empty.summary).toContain('没有选择任何模型');
  });
});
