/**
 * generateTextProtocol — 回归测试：custom text model protocol。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText, generateTextResult } from '../../src/services/ai/generateText';
import { useAppStore } from '../../src/store/useAppStore';
import { resolvePromptWithMediaRefs } from '../../src/services/ai/promptResolver';
import type { ModelExecutionProfile } from '../../src/types/aiTypes';
import type { WorkflowDefinition } from '../../src/types';
import { getPendingTasksForProject } from '../../src/services/pollManager';

vi.mock('../../src/services/comfyProgress', () => ({ createComfyProgressSession: () => ({
  clientId: 'text-workflow-progress', waitUntilReady: async () => {}, bindPrompt: () => {}, close: () => {},
}) }));
vi.mock('../../src/services/comfyMemory', () => ({ maybeAutoReleaseComfyMemory: async () => {} }));

const jsonResponse = (payload: unknown) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState(useAppStore.getInitialState(), true);
});

describe('local ComfyUI text execution', () => {
  function installTextWorkflow(graphOverride?: Record<string, unknown>) {
    localStorage.clear();
    const graph = graphOverride ?? {
      '1': { class_type: 'TE_text_display', inputs: { text: 'original saved input' } },
      '2': { class_type: 'TE_Qwen_Image_2_1_Prompt_Enhancer', inputs: { 输入提示词: ['1', 0] } },
      '7': { class_type: 'SaveText', inputs: { text: ['2', 0], format: 'txt', filename_prefix: 'enhanced' } },
    };
    const workflow: WorkflowDefinition = { id: 'wf-local-text', name: '本地提示词增强', category: 'ai-text',
      adapterType: 'comfyui', fileName: 'local-text.json', fileContent: JSON.stringify(graph), createdAt: 1,
      ioNodes: [{ nodeId: '1', title: '提示词', type: 'prompt' },
        ...(Object.hasOwn(graph, '3') ? [{ nodeId: '3', title: '参考图', type: 'image' as const }] : [])],
      defaultNodes: { prompt: '1', ...(Object.hasOwn(graph, '3') ? { image: '3' } : {}) } };
    useAppStore.setState((state) => ({ currentProjectId: 'text-project', workflows: [workflow],
      nodes: [{ id: 'text-node', type: 'ai-text', position: { x: 0, y: 0 },
        data: { type: 'ai-text', label: '提示词增强', provider: 'comfyui', model: 'comfyui/workflow',
          workflowId: workflow.id, prompt: 'new prompt', status: 'loading' } }],
      config: { ...state.config, providers: {}, comfyUIUrl: 'http://comfy-text.test:8188', comfyMemoryPolicy: 'smart' } }));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/upload/image')) return jsonResponse({ name: 'uploaded-reference.png', subfolder: '', type: 'input' });
      if (url.endsWith('/prompt') && init?.method === 'POST') return jsonResponse({ prompt_id: 'original-text-task' });
      if (url.includes('/history/')) return jsonResponse({ 'original-text-task': { status: { completed: true, status_str: 'success' },
        outputs: { '1': { text: ['original saved input'] }, '7': { text: ['完整增强后的文本\n第二行'], files: [{ filename: 'enhanced.txt', type: 'output' }] } } } });
      throw new Error(`Unexpected local text request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { workflow, fetchMock };
  }

  it.each([false, true])('runs a local workflow without a provider key and preserves its SaveText result (string wrapper=%s)', async (stringWrapper) => {
    const { workflow, fetchMock } = installTextWorkflow();
    const params = { provider: 'comfyui', model: 'comfyui/workflow', nodeId: 'text-node',
      workflowId: workflow.id, prompt: 'new prompt' };
    const result = stringWrapper ? await generateText(params) : await generateTextResult(params);
    expect(result).toEqual(stringWrapper ? '完整增强后的文本\n第二行'
      : { text: '完整增强后的文本\n第二行', comfyTaskId: 'original-text-task' });
    const posts = fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/prompt') && init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]?.body)).prompt['1'].inputs.text).toBe('new prompt');
    expect(fetchMock.mock.calls.every(([url]) => url.startsWith('http://comfy-text.test:8188/'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/view') || url.includes('/chat') || url.includes('/images/generations'))).toBe(false);
    expect(getPendingTasksForProject('text-project')[0]).toMatchObject({ nodeId: 'text-node', nodeType: 'ai-text',
      taskId: 'original-text-task', submitted: true, comfyTextOutputNodeIds: ['7'], comfyRecoveryState: 'save_pending' });
    expect(workflow.fileContent).toContain('original saved input');
  });

  it('uses an explicit input instead of the default and uploads reference images through that same local server', async () => {
    const { workflow, fetchMock } = installTextWorkflow({
      '1': { class_type: 'TE_text_display', inputs: { text: 'original saved input' } },
      '2': { class_type: 'TE_Qwen_Image_2_1_Prompt_Enhancer', inputs: { 输入提示词: ['1', 0], 图片: ['3', 0] } },
      '3': { class_type: 'LoadImage', inputs: { image: 'existing.png' } },
      '7': { class_type: 'SaveText', inputs: { text: ['2', 0] } },
    });
    await generateTextResult({ provider: 'comfyui', model: 'comfyui/workflow', nodeId: 'text-node', workflowId: workflow.id,
      workflowInputs: { '1': 'explicit input' }, prompt: 'default input', imageUrls: ['data:image/png;base64,AQID'] });
    const upload = fetchMock.mock.calls.find(([url]) => url.endsWith('/upload/image'));
    expect(upload?.[1]?.body).toBeInstanceOf(FormData);
    expect(upload?.[1]?.headers).toBeUndefined();
    const submission = fetchMock.mock.calls.find(([url]) => url.endsWith('/prompt'));
    const sent = JSON.parse(String(submission?.[1]?.body)).prompt;
    expect(sent['1'].inputs.text).toBe('explicit input');
    expect(sent['3'].inputs.image).toBe('uploaded-reference.png');
    expect(sent['7'].inputs.text).toEqual(['2', 0]);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/prompt'))).toHaveLength(1);
  });

  it.each([false, true])('rejects an absent or ambiguous SaveText before submitting (multiple=%s)', async (multiple) => {
    const { workflow, fetchMock } = installTextWorkflow({
      '1': { class_type: 'TE_text_display', inputs: { text: 'input' } },
      ...(multiple ? { '7': { class_type: 'SaveText', inputs: { text: ['1', 0] } },
        '8': { class_type: 'SaveText', inputs: { text: ['1', 0] } } } : {}),
    });
    await expect(generateTextResult({ provider: 'comfyui', model: 'comfyui/workflow', nodeId: 'text-node',
      workflowId: workflow.id, prompt: 'prompt' })).rejects.toThrow(multiple ? '多个 SaveText' : '缺少官方 SaveText');
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/prompt'))).toBe(false);
    expect(getPendingTasksForProject('text-project')).toEqual([]);
  });

  it('does not submit a workflow after the project changes while its reference image upload is pending', async () => {
    const { workflow, fetchMock } = installTextWorkflow({
      '1': { class_type: 'TE_text_display', inputs: { text: 'original saved input' } },
      '2': { class_type: 'TE_Qwen_Image_2_1_Prompt_Enhancer', inputs: { 输入提示词: ['1', 0], 图片: ['3', 0] } },
      '3': { class_type: 'LoadImage', inputs: { image: 'existing.png' } },
      '7': { class_type: 'SaveText', inputs: { text: ['2', 0] } },
    });
    let finishUpload!: (response: Response) => void;
    const upload = new Promise<Response>((resolve) => { finishUpload = resolve; });
    const normalRequest = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => url.endsWith('/upload/image') ? upload : normalRequest(url, init));
    const pending = generateTextResult({ provider: 'comfyui', model: 'comfyui/workflow', nodeId: 'text-node', workflowId: workflow.id,
      prompt: 'new prompt', imageUrls: ['data:image/png;base64,AQIDBA=='] });
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/upload/image'))).toBe(true));
    useAppStore.setState({ currentProjectId: 'another-project' });
    finishUpload(jsonResponse({ name: 'late-reference.png', subfolder: '', type: 'input' }));
    await expect(pending).rejects.toThrow('未提交 ComfyUI 任务');
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/prompt'))).toBe(false);
  });

  it('stops before workflow preparation when the original project changes during prompt reference resolution', async () => {
    const { workflow, fetchMock } = installTextWorkflow();
    const resolver = await import('../../src/services/ai/promptResolver');
    const resolved = await resolver.resolvePromptWithMediaRefs('new prompt');
    let finishResolution!: (value: typeof resolved) => void;
    const resolution = new Promise<typeof resolved>((resolve) => { finishResolution = resolve; });
    const resolveReferences = vi.spyOn(resolver, 'resolvePromptWithMediaRefs').mockReturnValueOnce(resolution);
    try {
      const pending = generateTextResult({ provider: 'comfyui', model: 'comfyui/workflow', nodeId: 'text-node',
        workflowId: workflow.id, prompt: 'new prompt' });
      useAppStore.setState({ currentProjectId: 'another-project' });
      finishResolution(resolved);
      await expect(pending).rejects.toThrow('未提交 ComfyUI 任务');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { resolveReferences.mockRestore(); }
  });
});

describe('custom text model protocol', () => {
  it('keeps an explicit custom connection named comfyui on its HTTP text protocol when no workflow is selected', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { comfyui: {
      name: '同名自定义连接', catalogId: 'custom-openai', apiKey: 'custom-fixture-key', baseUrl: 'https://custom-text.test/v1',
    } } } }));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: '普通接口结果' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateTextResult({ provider: 'comfyui', model: 'comfyui/vendor-chat', prompt: '普通请求' }))
      .resolves.toEqual({ text: '普通接口结果' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://custom-text.test/v1/chat/completions');
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer custom-fixture-key' });
  });

  it('does not start a request when its signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateText({ provider: 'general', model: 'general/text', prompt: '预演', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses the configured endpoint, request body and text result path', async () => {
    const executionProfile = {
      preset: 'custom',
      protocol: {
        version: 1,
        mode: 'sync',
        auth: { type: 'header', name: 'X-API-Key' },
        submit: {
          method: 'POST',
          path: '/v1/chat/',
          body: {
            model_name: '{{model}}',
            input: '{{prompt}}',
            messages: '{{messages}}',
          },
        },
        resultTextPath: 'result.answer',
      },
    } as unknown as ModelExecutionProfile;
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          'custom-text-provider': {
            name: '自定义文本连接',
            apiKey: 'secret',
            baseUrl: 'https://gateway.example',
            catalogId: 'custom-openai',
          },
        },
        generalModels: [{
          id: 'custom-text',
          name: '自定义文本',
          modelId: 'vendor-chat',
          category: 'text',
          providerConfigId: 'custom-text-provider',
          executionProfile,
        }],
      },
    }));
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ result: { answer: '自定义结果' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateText({
      provider: 'general',
      model: 'general/custom-text',
      prompt: '你好',
    });

    expect(result).toBe('自定义结果');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/chat/');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-API-Key': 'secret' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model_name: 'vendor-chat',
      input: '你好',
    });
  });

  it.each([
    {
      protocol: 'anthropic-compatible' as const,
      expectedUrl: 'https://gateway.example/v1/messages',
      response: { content: [{ type: 'text', text: 'Anthropic 结果' }] },
      expectedText: 'Anthropic 结果',
      expectedHeader: ['x-api-key', 'secret'],
      expectedBody: { model: 'vendor-chat', max_tokens: 4096, messages: [{ role: 'user' }] },
    },
    {
      protocol: 'gemini-native' as const,
      expectedUrl: 'https://gateway.example/v1/models/vendor-chat:generateContent',
      response: { candidates: [{ content: { parts: [{ text: 'Gemini 结果' }] } }] },
      expectedText: 'Gemini 结果',
      expectedHeader: ['x-goog-api-key', 'secret'],
      expectedBody: { contents: [{ role: 'user', parts: [{ text: '你好' }] }] },
    },
  ])('uses $protocol for non-stream text generation', async ({
    protocol,
    expectedUrl,
    response,
    expectedText,
    expectedHeader,
    expectedBody,
  }) => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          'native-text-provider': {
            name: '原生文本连接',
            apiKey: 'secret',
            baseUrl: 'https://gateway.example/v1',
            catalogId: 'custom-openai',
            chatApiProtocol: protocol,
          },
        },
        generalModels: [{
          id: 'native-text',
          name: '原生文本',
          modelId: 'vendor-chat',
          category: 'text',
          providerConfigId: 'native-text-provider',
        }],
      },
    }));
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateText({
      provider: 'general',
      model: 'general/native-text',
      prompt: '你好',
    })).resolves.toBe(expectedText);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedUrl);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ [expectedHeader[0]]: expectedHeader[1] });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject(expectedBody);
  });

  it.each([
    {
      preset: 'anthropic-chat' as const,
      expectedUrl: 'https://gateway.example/v1/messages',
      response: { content: [{ type: 'text', text: 'Claude 回复' }] },
      expectedHeader: 'x-api-key',
    },
    {
      preset: 'gemini-chat' as const,
      expectedUrl: 'https://gateway.example/v1/models/vendor-chat:generateContent',
      response: { candidates: [{ content: { parts: [{ text: 'Gemini 回复' }] } }] },
      expectedHeader: 'x-goog-api-key',
    },
  ])('lets a $preset model override the connection chat protocol', async ({
    preset, expectedUrl, response, expectedHeader,
  }) => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          'mixed-text-provider': {
            name: '混合文本连接', apiKey: 'secret', baseUrl: 'https://gateway.example/v1',
            catalogId: 'custom-openai', chatApiProtocol: 'openai-compatible',
          },
        },
        generalModels: [{
          id: 'mixed-text', name: '混合文本', modelId: 'vendor-chat',
          category: 'text', providerConfigId: 'mixed-text-provider',
          executionProfile: { preset },
        }],
      },
    }));
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateText({ provider: 'general', model: 'general/mixed-text', prompt: '你好' }))
      .resolves.toBe(preset === 'anthropic-chat' ? 'Claude 回复' : 'Gemini 回复');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedUrl);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ [expectedHeader]: 'secret' });
  });
});

describe('shared protocol asset references', () => {
  it('extracts local video and audio assets once and keeps their prompt reference indices', async () => {
    const result = await resolvePromptWithMediaRefs(
      '参考 @asset{references%2Fclip.mp4} 和 @asset{references%2Fvoice.mp3}，再次参考 @asset{references%2Fclip.mp4}',
    );
    expect(result.prompt).toBe('参考 视频1 和 音频1，再次参考 视频1');
    expect(result.videoUrls).toHaveLength(1);
    expect(result.audioUrls).toHaveLength(1);
    expect(result.references).toEqual([
      expect.objectContaining({ kind: 'video', origin: 'prompt', role: 'reference', filePath: 'references/clip.mp4' }),
      expect.objectContaining({ kind: 'audio', origin: 'prompt', role: 'reference_audio', filePath: 'references/voice.mp3' }),
    ]);
  });
});
