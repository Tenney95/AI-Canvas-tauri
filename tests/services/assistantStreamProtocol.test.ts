/**
 * assistantStreamProtocol — 回归测试：assistant custom protocol boundary。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAssistantSystemPrompt,
  resolveAssistantModel,
  streamAssistantReply,
  type AssistantModelMessage,
} from '../../src/services/ai/assistantStream';
import { runAssistantPipeline, runStreamingPipeline } from '../../src/services/chat/assistantService';
import { parseRules } from '../../src/services/chat/rulesEngine';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../src/services/chat/assistantScope';
import { useAppStore } from '../../src/store/useAppStore';
import type { ModelExecutionProfile } from '../../src/types/aiTypes';
import type { ChatApiProtocol, UserSkill } from '../../src/types';
import { buildAssistantToolGuidance } from '../../src/services/chat/agentPromptGuidance';

const museMocks = vi.hoisted(() => ({
  streamMuseText: vi.fn<(input: { messages: AssistantModelMessage[]; signal?: AbortSignal;
    onText: (snapshot: string) => void }) => Promise<string>>(),
}));
vi.mock('../../src/services/ai/museTextService', () => museMocks);

const configureAssistant = (
  executionProfile?: ModelExecutionProfile,
  chatApiProtocol?: ChatApiProtocol,
) => {
  useAppStore.setState((state) => ({
    config: {
      ...state.config,
      assistantModelId: 'assistant-model',
      providers: {
        ...state.config.providers,
        'custom-assistant': {
          name: '自定义助手连接',
          apiKey: 'secret',
          baseUrl: 'https://gateway.example/v1',
          catalogId: 'custom-openai',
          chatApiProtocol,
        },
      },
      generalModels: [{
        id: 'assistant-model',
        name: '自定义助手',
        modelId: 'vendor-chat',
        category: 'text',
        providerConfigId: 'custom-assistant',
        ...(executionProfile ? { executionProfile } : {}),
      }],
    },
  }));
};

beforeEach(() => {
  vi.unstubAllGlobals();
  museMocks.streamMuseText.mockReset();
  useAppStore.setState(useAppStore.getInitialState(), true);
});

describe('Muse assistant text transport', () => {
  const configureMuse = () => useAppStore.setState((state) => ({ config: { ...state.config,
    assistantModelId: 'muse/muse-chat', generalModels: [], providers: { muse: { name: 'Muse', apiKey: '', catalogId: 'muse',
      selectedModels: [{ id: 'muse-chat', name: 'Muse 问答', category: 'text', provider: 'muse', inputModalities: ['text', 'image'] }] } },
  } }));

  it('resolves the explicit Muse model without an API key and declares no tool capability', () => {
    configureMuse();
    expect(resolveAssistantModel(undefined, 'muse/muse-chat')).toMatchObject({
      modelName: 'muse-chat', apiKey: '', transport: 'muse-webview', supportsTools: false, supportsVision: true,
    });
    expect(resolveAssistantModel(undefined, 'muse/unavailable')).toBeNull();
  });

  it('routes complete snapshots to text deltas without OpenAI requests or fabricated tool events', async () => {
    configureMuse();
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    museMocks.streamMuseText.mockImplementation(async ({ onText }) => {
      onText('你'); onText('你好'); onText('你好'); return '你好！';
    });
    const onEvent = vi.fn();
    await expect(streamAssistantReply({ systemPrompt: '系统', userMessage: '你好', tools: [],
      modelId: 'muse/muse-chat', onEvent })).resolves.toBe('你好！');
    expect(museMocks.streamMuseText.mock.calls[0][0].messages).toEqual([
      { role: 'system', content: '系统' }, { role: 'user', content: '你好' },
    ]);
    expect(onEvent.mock.calls.map(([event]) => event).filter((event) => event.type === 'text.delta')).toEqual([
      { type: 'text.delta', delta: '你' }, { type: 'text.delta', delta: '好' }, { type: 'text.delta', delta: '！' },
    ]);
    expect(onEvent).toHaveBeenCalledWith({ type: 'done', finishReason: 'stop' });
    expect(onEvent.mock.calls.some(([event]) => event.type.startsWith('tool.'))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves explicit project image references before handing messages to the Muse service', async () => {
    configureMuse();
    useAppStore.setState({ currentProjectId: 'muse-project',
      nodes: [{ id: 'muse-image', type: 'ai-image', position: { x: 0, y: 0 },
        data: { type: 'ai-image', label: '参考图', imageUrl: 'data:image/png;base64,QUJDRA==' } }] });
    museMocks.streamMuseText.mockResolvedValue('看到了图片');
    await streamAssistantReply({ systemPrompt: '', userMessage: '分析 @{muse-image:参考图}', projectId: 'muse-project',
      tools: [], onEvent: vi.fn() });
    expect(museMocks.streamMuseText.mock.calls[0][0].messages).toEqual([{ role: 'user', content: [
      { type: 'text', text: '分析 图片1' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJDRA==' } },
    ] }]);
  });

  it('rejects nonempty tools before preparing visual references or creating a Muse task', async () => {
    configureMuse();
    await expect(streamAssistantReply({ systemPrompt: '', userMessage: '读取 @asset{unavailable}', onEvent: vi.fn(),
      tools: [{ type: 'function', function: { name: 'file_read_text', description: '读取', parameters: {} } }],
    })).rejects.toThrow('不支持工具调用');
    expect(museMocks.streamMuseText).not.toHaveBeenCalled();
  });

  it.each([
    { messages: [{ role: 'tool', content: '已脱敏的历史工具摘要', tool_call_id: 'call-1' }] as AssistantModelMessage[] },
    { messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'file_read_text', arguments: '{}' } }] }] as AssistantModelMessage[] },
  ])('passes sanitized past tool history to the text service as background while defining no current tools', async ({ messages }) => {
    configureMuse();
    museMocks.streamMuseText.mockResolvedValue('继续回答');
    await expect(streamAssistantReply({ systemPrompt: '', userMessage: '', messages, tools: [], onEvent: vi.fn() }))
      .resolves.toBe('继续回答');
    expect(museMocks.streamMuseText.mock.calls[0][0].messages).toEqual(messages);
  });

  it('keeps streamed partial text on cancellation and never emits successful completion', async () => {
    configureMuse(); const controller = new AbortController(); const onEvent = vi.fn();
    museMocks.streamMuseText.mockImplementation(async ({ onText }) => {
      onText('部分回复'); controller.abort(); onText('迟到的回复'); return '迟到的完整回复';
    });
    await expect(streamAssistantReply({ systemPrompt: '', userMessage: '你好', tools: [], signal: controller.signal, onEvent }))
      .rejects.toThrow('请求已取消');
    expect(onEvent).toHaveBeenCalledWith({ type: 'text.delta', delta: '部分回复' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'done', finishReason: 'canceled' });
    expect(onEvent).not.toHaveBeenCalledWith({ type: 'done', finishReason: 'stop' });
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain('迟到');
    expect(useAppStore.getState().activeRequestAbort).toBeNull();
  });

  it('does not append a rewritten snapshot to the old partial response', async () => {
    configureMuse(); const onEvent = vi.fn();
    museMocks.streamMuseText.mockImplementation(async ({ onText }) => { onText('旧片段'); onText('改写片段'); return '改写片段'; });
    await expect(streamAssistantReply({ systemPrompt: '', userMessage: '你好', tools: [], onEvent })).rejects.toThrow('发生改写');
    expect(onEvent).toHaveBeenCalledWith({ type: 'text.delta', delta: '旧片段' });
    expect(onEvent).not.toHaveBeenCalledWith({ type: 'text.delta', delta: '改写片段' });
    expect(onEvent).not.toHaveBeenCalledWith({ type: 'done', finishReason: 'stop' });
  });

  it('keeps nonstream mode as one final text delta', async () => {
    configureMuse(); const onEvent = vi.fn();
    museMocks.streamMuseText.mockImplementation(async ({ onText }) => { onText('部分'); return '完整回复'; });
    await streamAssistantReply({ systemPrompt: '', userMessage: '你好', tools: [], nonStream: true, onEvent });
    expect(onEvent.mock.calls.map(([event]) => event).filter((event) => event.type === 'text.delta')).toEqual([
      { type: 'text.delta', delta: '完整回复' },
    ]);
  });

  it('lets a tool-capable assistant offer the explicitly mentioned Muse media model without a Muse API key', async () => {
    configureAssistant();
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      muse: { name: 'Muse', apiKey: '', catalogId: 'muse', selectedModels: [
        { id: 'muse-image', name: 'Muse 图片', category: 'image', provider: 'muse' },
      ] },
    } } }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [
      { message: { content: '准备调用' }, finish_reason: 'stop' },
    ] }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await streamAssistantReply({ systemPrompt: '', userMessage: '生成 @model{muse/muse-image}', nonStream: true, onEvent: vi.fn() });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.tools[0].function.name).toBe('media_generate');
    expect(body.tools[0].function.parameters.properties.modelRef.enum).toEqual(['muse/muse-image']);
    expect(museMocks.streamMuseText).not.toHaveBeenCalled();
  });
});

describe('assistant custom protocol boundary', () => {
  it.each(['http', 'json', 'sse'] as const)('redacts credentials before emitting or throwing %s errors', async (mode) => {
    configureAssistant();
    const apiKey = 'assistant~! private/key=';
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      ...state.config.providers, 'custom-assistant': { ...state.config.providers['custom-assistant'], apiKey },
    } } }));
    const encoded = encodeURIComponent(apiKey);
    const form = new URLSearchParams({ key: apiKey }).toString().slice(4);
    const detail = `Invalid key ${apiKey}; encoded ${encoded}; query ${form}; permission denied`;
    const payload = { error: { message: detail } };
    const response = mode === 'sse'
      ? new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      : new Response(JSON.stringify(payload), { status: mode === 'http' ? 401 : 200,
        headers: { 'Content-Type': 'application/json' } });
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetchMock);
    const onEvent = vi.fn();
    const error = await streamAssistantReply({ systemPrompt: '', userMessage: '你好', onEvent,
      nonStream: mode === 'http' }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[REDACTED]');
    const errors = onEvent.mock.calls.map(([event]) => event).filter((event) => event.type === 'error');
    expect(errors.length).toBeGreaterThan(0);
    for (const secret of [apiKey, encoded, form]) {
      expect((error as Error).stack).not.toContain(secret);
      expect(JSON.stringify(errors)).not.toContain(secret);
    }
    expect((error as Error).cause).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not send an already cancelled text request', async () => {
    configureAssistant();
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(streamAssistantReply({ systemPrompt: '', userMessage: '你好', signal: controller.signal,
      onEvent: vi.fn() })).rejects.toThrow('请求已取消');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([true, false])('discards JSON text and tools cancelled during body reading with nonStream=%s', async (nonStream) => {
    configureAssistant();
    const controller = new AbortController();
    let finishBody!: (value: unknown) => void;
    const response = new Response(null, { headers: { 'Content-Type': 'application/json' } });
    const readBody = vi.spyOn(response, 'json').mockImplementation(() => new Promise((resolve) => { finishBody = resolve; }));
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetchMock);
    const onEvent = vi.fn();
    const pending = streamAssistantReply({ systemPrompt: '', userMessage: '你好', nonStream, signal: controller.signal, onEvent });
    await vi.waitFor(() => expect(readBody).toHaveBeenCalledOnce());
    controller.abort(nonStream ? new Error('secret must not survive cancellation') : null);
    finishBody({ choices: [{ message: { content: 'late reply', reasoning_content: 'late reasoning', tool_calls: [{
      id: 'late-call', type: 'function', function: { name: 'canvas_query', arguments: '{}' },
    }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ message: '请求已取消' });
    expect((error as Error).cause).toBeUndefined();
    expect((error as Error).stack).not.toContain('secret');
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(['start', 'done']);
    expect(onEvent).toHaveBeenLastCalledWith({ type: 'done', finishReason: 'canceled' });
    expect(useAppStore.getState().activeRequestAbort).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses the explicitly selected text model without changing the assistant default', async () => {
    configureAssistant();
    useAppStore.setState((state) => ({ config: { ...state.config, generalModels: [
      ...(state.config.generalModels ?? []),
      { id: 'polish-text', name: '润色模型', modelId: 'polish-model', category: 'text', providerConfigId: 'custom-assistant' },
    ] } }));
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: '润色完成' }, finish_reason: 'stop' }],
    }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await streamAssistantReply({ systemPrompt: '', userMessage: '润色', modelId: 'general/polish-text', nonStream: true, onEvent: vi.fn() });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('polish-model');
    expect(useAppStore.getState().config.assistantModelId).toBe('assistant-model');
    fetchMock.mockClear();
    await expect(streamAssistantReply({ systemPrompt: '', userMessage: '润色', modelId: 'general/missing', onEvent: vi.fn() }))
      .rejects.toThrow('所选文本模型已不可用');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('expands explicit text, video and audio node references before sending a text-only request', async () => {
    configureAssistant();
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [
      { id: 'script', type: 'source-text', position: { x: 0, y: 0 }, data: { type: 'source-text', label: '剧本', output: '人物在窗前停步。' } },
      { id: 'clip', type: 'source-video', position: { x: 0, y: 0 }, data: { type: 'source-video', label: '视频', videoUrl: 'https://media.example/clip.mp4' } },
      { id: 'audio', type: 'source-audio', position: { x: 0, y: 0 }, data: { type: 'source-audio', label: '音频', audioUrl: 'https://media.example/audio.mp3' } },
    ] });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: '润色完成' }, finish_reason: 'stop' }],
    }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await streamAssistantReply({
      systemPrompt: '', projectId: 'project-1', nonStream: true, tools: [], onEvent: vi.fn(),
      userMessage: '参考 @{script:剧本} @{clip:视频} @{audio:音频}；原文 ⟦REF_original_0⟧',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([{
      role: 'user', content: '参考 人物在窗前停步。 https://media.example/clip.mp4 https://media.example/audio.mp3；原文 ⟦REF_original_0⟧',
    }]);
    expect(body.tools).toBeUndefined();
  });

  it('builds a general prompt without borrowing the open canvas or requesting a project for ordinary chat', () => {
    useAppStore.setState({ currentProjectId: 'other-project', nodes: [{ id: 'private-node', type: 'ai-text',
      position: { x: 0, y: 0 }, data: { type: 'ai-text', label: '另一个项目的私有内容', status: 'idle' } }] });
    const prompt = buildAssistantSystemPrompt({ projectId: GENERAL_ASSISTANT_SCOPE_ID,
      agentTools: true, includeToolGuidance: false });
    expect(prompt).toContain('通用 AI 助手');
    expect(prompt).toContain('普通问答和写作不需要创建或打开项目');
    expect(prompt).not.toContain('节点列表');
    expect(prompt).not.toContain('另一个项目的私有内容');
    expect(prompt).not.toContain('1-2 句');
  });

  it('streams identical CCC models with the selected group Key and never borrows another group Key', async () => {
    for (const group of ['pro', 'discount']) {
      useAppStore.getState().saveProviderConfig(`cccapi-${group}`, {
        name: 'CCC', catalogId: 'cccapi', cccGroup: group, apiKey: `${group}-fixture`, baseUrl: 'https://cccapi.cn/v1',
        selectedModels: [{ id: 'gpt-5', name: 'GPT', category: 'text', provider: `cccapi-${group}`, executionProfile: { preset: 'openai-chat' } }],
      });
    }
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      'data: {"choices":[{"delta":{"content":"回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    for (const model of useAppStore.getState().config.generalModels!) {
      useAppStore.getState().updateConfig({ assistantModelId: model.id });
      await expect(streamAssistantReply({ systemPrompt: '', userMessage: '你好', onEvent: vi.fn() })).resolves.toBe('回复');
      const init = fetchMock.mock.calls.at(-1)![1];
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${useAppStore.getState().config.providers[model.providerConfigId].apiKey}` });
      expect(JSON.parse(init.body).model).toBe('gpt-5');
    }
    useAppStore.getState().setProviderKey('cccapi-discount', '');
    fetchMock.mockClear();
    await expect(streamAssistantReply({ systemPrompt: '', userMessage: '你好', onEvent: vi.fn() })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    {
      preset: 'anthropic-chat' as const,
      expectedUrl: 'https://gateway.example/v1/messages',
      expectedHeader: 'x-api-key',
      body: 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude 回复"}}\n\n',
      expectedText: 'Claude 回复',
    },
    {
      preset: 'gemini-chat' as const,
      expectedUrl: 'https://gateway.example/v1/models/vendor-chat:streamGenerateContent?alt=sse',
      expectedHeader: 'x-goog-api-key',
      body: 'data: {"candidates":[{"content":{"parts":[{"text":"Gemini 回复"}]},"finishReason":"STOP"}]}\n\n',
      expectedText: 'Gemini 回复',
    },
  ])('streams a $preset model through its native adapter despite an OpenAI connection default', async ({
    preset, expectedUrl, expectedHeader, body, expectedText,
  }) => {
    configureAssistant({ preset }, 'openai-compatible');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(body, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onEvent = vi.fn();

    await expect(streamAssistantReply({ systemPrompt: '', userMessage: '你好', onEvent }))
      .resolves.toBe(expectedText);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedUrl);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ [expectedHeader]: 'secret' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'text.delta', delta: expectedText });
  });

  it.each([' ', ''])('preserves SSE text when data uses %j after the colon', async (space) => {
    configureAssistant();
    const body = `data:${space}${JSON.stringify({ choices: [{ delta: { content: '完整回复' }, finish_reason: 'stop' }] })}\n\n`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    const onEvent = vi.fn();
    await expect(streamAssistantReply({ systemPrompt: '', userMessage: '你好', onEvent })).resolves.toBe('完整回复');
    expect(onEvent).toHaveBeenCalledWith({ type: 'text.delta', delta: '完整回复' });
  });

  it.each([false, true])('emits JSON response text to message consumers (nonStream %s)', async (nonStream) => {
    configureAssistant();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '完整回复' }, finish_reason: 'stop' }],
    }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } })));
    const onEvent = vi.fn();
    await expect(streamAssistantReply({ systemPrompt: '', userMessage: '你好', onEvent, nonStream })).resolves.toBe('完整回复');
    expect(onEvent).toHaveBeenCalledWith({ type: 'text.delta', delta: '完整回复' });
    expect(onEvent.mock.calls.filter(([event]) => event.type === 'text.delta')).toHaveLength(1);
  });

  it.each([
    { body: '', contentType: 'text/event-stream' },
    { body: 'data: [DONE]\n\n', contentType: 'text/event-stream' },
    { body: 'data: {"choices":[{"delta":{"content":"  "},"finish_reason":"stop"}]}\n\n', contentType: 'text/event-stream' },
    { body: 'data: {"choices":[{"delta":{"reasoning_content":"internal"},"finish_reason":"length"}]}\n\n', contentType: 'text/event-stream' },
    { body: '{"choices":[{"message":{"content":""},"finish_reason":"stop"}]}', contentType: 'application/json' },
  ])('rejects a response without reply text or a valid tool call: $body', async ({ body, contentType }) => {
    configureAssistant();
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': contentType } }));
    vi.stubGlobal('fetch', fetchMock);
    const onEvent = vi.fn();
    await expect(streamAssistantReply({ systemPrompt: '', userMessage: '你好', onEvent })).rejects.toThrow('未返回');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('未返回') }));
    expect(onEvent).toHaveBeenCalledWith({ type: 'done', finishReason: 'error' });
    expect(onEvent).not.toHaveBeenCalledWith({ type: 'done', finishReason: 'stop' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['text/event-stream', 'application/json'])('surfaces HTTP 200 provider errors in %s', async (contentType) => {
    configureAssistant();
    const payload = JSON.stringify({ error: { message: 'Provider temporarily unavailable' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      contentType === 'application/json' ? payload : `data: ${payload}\n\n`,
      { headers: { 'Content-Type': contentType } },
    )));
    const onEvent = vi.fn();
    await expect(streamAssistantReply({ systemPrompt: '', userMessage: '你好', onEvent })).rejects.toThrow('Provider temporarily unavailable');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Provider temporarily unavailable' }));
  });

  it.each(['openai-compatible', 'anthropic-compatible', 'gemini-native'] as const)('allows tool-only %s replies', async (protocol) => {
    configureAssistant(undefined, protocol);
    const payloads = {
      'openai-compatible': { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'canvas_query', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      'anthropic-compatible': { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'canvas_query', input: {} } },
      'gemini-native': { candidates: [{ content: { parts: [{ functionCall: { id: 'call-1', name: 'canvas_query', args: {} } }] }, finishReason: 'STOP' }] },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify(payloads[protocol])}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    const onEvent = vi.fn();
    await expect(streamAssistantReply({ systemPrompt: '', userMessage: '查询', onEvent })).resolves.toBe('');
    expect(onEvent).toHaveBeenCalledWith({ type: 'tool.call.final', call: { callId: 'call-1', toolId: 'canvas_query', input: {} } });
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('prefers the current project text model and falls back when it is unavailable', () => {
    configureAssistant({ preset: 'openai-chat' });
    useAppStore.setState((state) => ({
      currentProjectId: 'project-1',
      projects: [{
        id: 'project-1',
        name: 'Project',
        createdAt: 1,
        updatedAt: 1,
        settings: { defaultModels: { text: 'general/project-assistant' } },
      }],
      config: {
        ...state.config,
        generalModels: [
          ...(state.config.generalModels ?? []),
          {
            id: 'project-assistant',
            name: '项目助手',
            modelId: 'project-vlm',
            category: 'text',
            providerConfigId: 'custom-assistant',
          },
        ],
      },
    }));

    expect(resolveAssistantModel()).toMatchObject({
      selectionId: 'general/project-assistant',
      modelName: 'project-vlm',
    });

    useAppStore.setState((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        settings: { defaultModels: { text: 'general/missing-model' } },
      })),
    }));
    expect(resolveAssistantModel()).toMatchObject({
      selectionId: 'assistant-model',
      modelName: 'vendor-chat',
    });
  });

  it('resolves a configured built-in provider text model selected by model value', () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        assistantModelId: 'apimart/gpt-5.4',
        providers: {
          ...state.config.providers,
          apimart: {
            name: 'APIMart',
            apiKey: 'secret',
            catalogId: 'apimart',
            selectedModels: [{
              id: 'gpt-5.4',
              name: 'GPT-5.4',
              category: 'text',
              provider: 'apimart',
            }],
          },
        },
      },
    }));

    expect(resolveAssistantModel()).toMatchObject({
      baseUrl: 'https://api.apib.ai/v1',
      apiKey: 'secret',
      modelName: 'gpt-5.4',
      protocol: { streamFormat: 'openai-sse' },
    });
  });

  it('returns an explicit model-selection message instead of generic canvas help', async () => {
    const result = await runAssistantPipeline('帮我分析这个接口文档', 'conversation-1');

    expect(result.reply).toContain('未选择可用的对话文本模型');
    expect(result.reply).not.toContain('当前画布共有');
  });

  it.each([
    '请检查接口文档，然后调用 provider_config_preview 和 provider_config_apply 保存配置。不要只回复字段说明。',
    '删除失败节点的规则先不要执行，请解释影响范围。',
    '查看图片节点的参数定义，整理成一份接入方案。',
  ])('reports the missing model before keyword-based help for %s', async (content) => {
    const result = await runAssistantPipeline(content, 'conversation-1');
    expect(result.errorCode).toBe('ASSISTANT_MODEL_UNAVAILABLE');
    expect(result.reply).toContain('本次请求尚未处理');
    expect(result.reply).not.toContain('不太确定');
    expect(result.commandExecuted).toBe(false);
  });

  it('reports a missing model as a stream error instead of completing canned help', async () => {
    const onComplete = vi.fn();
    const onError = vi.fn();
    await runStreamingPipeline('请检查接口文档并保存配置', 'conversation-1', {
      onTextDelta: vi.fn(), onComplete, onError,
    });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('未选择可用的对话文本模型'));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('sends the entire long task to the selected model without executing its command prefix', async () => {
    configureAssistant();
    const content = '选中 3 号节点后先分析接口文档，再调用 provider_config_preview 生成草稿；不要提前执行画布操作。';
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"已收到完整任务"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const onComplete = vi.fn();
    const onError = vi.fn();
    await runStreamingPipeline(content, 'conversation-1', {
      onTextDelta: vi.fn(), onComplete, onError,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toContainEqual({ role: 'user', content });
    expect(onComplete).toHaveBeenCalledWith('已收到完整任务', [], undefined);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(['选中 3 号节点', '删除失败节点。', '查看图片节点？', '撤销！'])(
    'keeps a complete local command available: %s', (content) => {
      expect(parseRules(content).hasHighConfidence).toBe(true);
    },
  );

  it.each([
    '选中 3 号节点并阅读接口文档',
    '删除失败节点前先解释方案，不要执行',
    '查看图片节点的接口参数，禁止操作画布',
    '选中 3 号节点\n这句话只是文档中的示例，不要执行。',
  ])('does not execute a partial local command from %s', (content) => {
    expect(parseRules(content).intents).toEqual([]);
  });

  it('uses an explicitly OpenAI SSE compatible custom endpoint', async () => {
    configureAssistant({
      preset: 'custom',
      protocol: {
        version: 1,
        mode: 'sync',
        streamFormat: 'openai-sse',
        submit: {
          method: 'POST',
          path: '/chat/',
          body: {
            model: '{{model}}',
            messages: '{{messages}}',
            stream: '{{stream}}',
            tools: '{{tools}}',
            tool_choice: '{{toolChoice}}',
          },
        },
        resultTextPath: 'choices.0.message.content',
      },
    } as unknown as ModelExecutionProfile);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await streamAssistantReply({
      systemPrompt: '系统',
      userMessage: '你好',
      nonStream: true,
      onEvent: vi.fn(),
    });

    expect(result).toBe('完成');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/chat/');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'vendor-chat',
      messages: [
        { role: 'system', content: '系统' },
        { role: 'user', content: '你好' },
      ],
      stream: false,
    });
  });

  it.each([
    { provided: false, image: false }, { provided: true, image: false },
    { provided: false, image: true }, { provided: true, image: true },
  ])('reuses the last prepared user content for custom prompt and messages (provided $provided, image $image)', async ({ provided, image }) => {
    configureAssistant({
      preset: 'custom',
      protocol: {
        version: 1, mode: 'sync', streamFormat: 'openai-sse',
        submit: { method: 'POST', path: '/chat/', body: { prompt: '{{prompt}}', messages: '{{messages}}' } },
        resultTextPath: 'choices.0.message.content',
      },
    });
    useAppStore.setState((state) => ({
      currentProjectId: 'project-1',
      nodes: [
        { id: 'script', type: 'source-text', position: { x: 0, y: 0 }, data: { type: 'source-text', label: '剧本', output: '人物停步。@{nested:保留嵌套标记}' } },
        { id: 'nested', type: 'source-text', position: { x: 0, y: 0 }, data: { type: 'source-text', label: '嵌套', output: '不应重复展开' } },
        { id: 'image', type: 'ai-image', position: { x: 0, y: 0 }, data: { type: 'ai-image', label: '参考图', imageUrl: 'data:image/png;base64,QUJDRA==' } },
      ],
      config: { ...state.config, generalModels: state.config.generalModels?.map((model) => ({ ...model, inputModalities: ['text', 'image'] as Array<'text' | 'image'> })) },
    }));
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
    }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const current = image ? '参考 @{image:参考图}' : '参考 @{script:剧本}；原文 ⟦REF_original_0⟧';

    await streamAssistantReply({
      systemPrompt: '系统', userMessage: provided ? '未使用的入口字段' : current,
      messages: provided ? [
        { role: 'system', content: '系统' }, { role: 'user', content: '上一轮要求' },
        { role: 'assistant', content: '上一轮回复' }, { role: 'user', content: current },
      ] : undefined,
      projectId: 'project-1', nonStream: true, tools: [], onEvent: vi.fn(),
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const expected = image ? [
      { type: 'text', text: '参考 图片1' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJDRA==' } },
    ] : '参考 人物停步。@{nested:保留嵌套标记}；原文 ⟦REF_original_0⟧';
    expect(body.prompt).toEqual(expected);
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: expected });
    expect(JSON.stringify(body)).not.toContain('不应重复展开');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses the current provider credential after key rotation', () => {
    configureAssistant({ preset: 'openai-chat' });
    useAppStore.getState().setProviderKey('custom-assistant', 'rotated-secret');

    expect(resolveAssistantModel()).toMatchObject({
      apiKey: 'rotated-secret',
      baseUrl: 'https://gateway.example/v1',
      modelName: 'vendor-chat',
    });
  });

  it('rejects a custom text protocol that does not declare OpenAI SSE compatibility', async () => {
    configureAssistant({
      preset: 'custom',
      protocol: {
        version: 1,
        mode: 'sync',
        submit: { method: 'POST', path: '/respond', body: { prompt: '{{prompt}}' } },
        resultTextPath: 'answer',
      },
    } as unknown as ModelExecutionProfile);

    await expect(streamAssistantReply({
      systemPrompt: '',
      userMessage: '你好',
      nonStream: true,
      onEvent: vi.fn(),
    })).rejects.toThrow('OpenAI SSE');
  });

  it('streams Anthropic text and tool input into normalized events with one usage event', async () => {
    configureAssistant(undefined, 'anthropic-compatible');
    const body = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"完成"}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-a","name":"canvas_query","input":{}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"detail\\":"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"true}"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ].join('\n\n') + '\n\n';
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onEvent = vi.fn();

    await expect(streamAssistantReply({
      systemPrompt: '系统',
      userMessage: '查询',
      tools: [{
        type: 'function',
        function: { name: 'canvas_query', description: '读取', parameters: { type: 'object' } },
      }],
      onEvent,
    })).resolves.toBe('完成');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/messages');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-api-key': 'secret',
      'anthropic-version': '2023-06-01',
    });
    expect(onEvent.mock.calls.map(([event]) => event).filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', inputTokens: 12, outputTokens: 8 },
    ]);
    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool.call.final',
      call: { callId: 'call-a', toolId: 'canvas_query', input: { detail: true } },
    });
  });

  it('surfaces an Anthropic error event instead of completing an empty response', async () => {
    configureAssistant(undefined, 'anthropic-compatible');
    const body = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    const onEvent = vi.fn();

    await expect(streamAssistantReply({
      systemPrompt: '',
      userMessage: '查询',
      onEvent,
    })).rejects.toThrow('Overloaded');
    expect(onEvent).toHaveBeenCalledWith({
      type: 'error',
      code: 'FETCH_ERROR',
      message: 'Overloaded',
      retryable: true,
    });
    expect(onEvent).toHaveBeenCalledWith({ type: 'done', finishReason: 'error' });
  });

  it('streams Gemini text, tools and usage through the native endpoint', async () => {
    configureAssistant(undefined, 'gemini-native');
    const body = [
      'data: {"candidates":[{"content":{"parts":[{"text":"你"}]}}]}',
      'data: {"candidates":[{"content":{"parts":[{"text":"好"},{"functionCall":{"id":"call-g","name":"canvas_query","args":{"detail":true}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":4}}',
    ].join('\n\n') + '\n\n';
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onEvent = vi.fn();

    await expect(streamAssistantReply({
      systemPrompt: '系统',
      userMessage: '查询',
      tools: [{
        type: 'function',
        function: { name: 'canvas_query', description: '读取', parameters: { type: 'object' } },
      }],
      onEvent,
    })).resolves.toBe('你好');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://gateway.example/v1/models/vendor-chat:streamGenerateContent?alt=sse',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-goog-api-key': 'secret' });
    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool.call.final',
      call: { callId: 'call-g', toolId: 'canvas_query', input: { detail: true } },
    });
    expect(onEvent.mock.calls.map(([event]) => event).filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', inputTokens: 9, outputTokens: 4 },
    ]);
  });
});

describe('Agent 工具说明与执行策略', () => {
  it('按需求主动选择专业能力，保留简单任务、真实执行与授权边界', () => {
    const prompt = buildAssistantToolGuidance(['skill_search', 'skill_load', 'agent_run_sub_agent']);
    expect(prompt).toContain('用户无需先指定智能体或 Skill');
    expect(prompt).toContain('不为每条消息强行调用');
    expect(prompt).toContain('不要求用户再次手动引用');
    expect(prompt).toContain('不把只读流程资料称为已经运行了独立智能体');
    expect(prompt).toContain('只有收到成功的工具结果后');
    expect(prompt).toContain('未授权自动调用');
    expect(prompt).toContain('通用对话不读取任何项目画布或资产');
  });

  it('只说明本轮开放的工具，不注入禁用工具的规则和索引', () => {
    const prompt = buildAssistantToolGuidance(['file_read_text'], 'plan');
    expect(prompt).toContain('Plan 规划模式');
    expect(prompt).toContain('file_read_text');
    for (const name of ['media_generate', 'canvas_create_nodes', 'provider_config_apply', 'file_list_grants', 'skill_load', '可用子智能体']) {
      expect(prompt).not.toContain(name);
    }
    expect(prompt).toContain('不可信资料');
  });

  it('没有工具时仍可完整回答普通问题，且不产生任何工具专用说明', () => {
    const prompt = buildAssistantToolGuidance([], 'autonomous');
    expect(prompt).toContain('直接给出完整答案');
    expect(prompt).not.toContain('media_generate');
    expect(prompt).not.toContain('可用 Skill');
    expect(prompt).not.toContain('可用子智能体');
  });

  it.each(['collaborative', 'autonomous'] as const)('媒体和配置说明服从 %s 模式', (mode) => {
    const prompt = buildAssistantToolGuidance(['media_generate', 'provider_config_preview', 'provider_config_apply', 'memory_suggest'], mode);
    expect(prompt).toContain('必须在同一 Agent 任务中立即调用 provider_config_apply');
    expect(prompt).toContain('user_choice 必须等待用户作答');
    if (mode === 'autonomous') {
      expect(prompt).toContain('由本地 Policy 自动执行');
      expect(prompt).toContain('解析项目默认模型或自动路由');
      expect(prompt).not.toContain('由本地审批卡让用户选择');
      expect(prompt).not.toContain('自动暂停并展示 API 配置审批卡');
      expect(prompt).not.toContain('每次都要确认');
    } else {
      expect(prompt).toContain('由本地 Policy 请求确认');
      expect(prompt).toContain('由本地审批卡让用户选择');
      expect(prompt).toContain('自动暂停并展示 API 配置审批卡');
    }
  });

  it('预览工具无法执行配置时不要求调用未开放的 apply 工具', () => {
    expect(buildAssistantToolGuidance(['provider_config_preview'], 'plan')).not.toContain('provider_config_apply');
  });

  it('Runtime 的初始上下文省略工具说明，避免与后续轮次重复或冲突', () => {
    const prompt = buildAssistantSystemPrompt({ agentTools: true, includeToolGuidance: false });
    expect(prompt).toContain('通用 AI 助手');
    expect(prompt).not.toContain('media_generate');
    expect(prompt).not.toContain('provider_config_apply');
  });
});

describe('buildAssistantSystemPrompt 的 Skill 索引', () => {
  const skill = (partial: Partial<UserSkill> = {}): UserSkill => ({
    id: 'skill-1',
    name: 'Canvas audit',
    description: 'Audit the canvas',
    fileName: 'SKILL.md',
    content: 'Review the canvas.',
    sourceType: 'file',
    createdAt: 1,
    ...partial,
  });

  it('没有可见 Skill 时不产生空的索引段', () => {
    useAppStore.setState({ userSkills: [] });
    const prompt = buildAssistantSystemPrompt({ agentTools: true });
    expect(prompt).not.toContain('可用 Skill');
  });

  it('注入索引与不可信边界说明，并给出 skill_load 使用规则', () => {
    useAppStore.setState({
      userSkills: [skill({ manifest: { whenToUse: '发布工作流之前使用' } })],
    });
    const prompt = buildAssistantSystemPrompt({ agentTools: true });
    expect(prompt).toContain('可用 Skill');
    expect(prompt).toContain('skillId: skill-1');
    expect(prompt).toContain('发布工作流之前使用');
    expect(prompt).toContain('skill_search');
    expect(prompt).toContain('skill_load');
    expect(prompt).toContain('不可信');
    expect(prompt).toContain('主动加载不会改变本次任务的工具权限');
  });

  it('disable-model-invocation 的 Skill 名称不出现在系统提示词中', () => {
    useAppStore.setState({
      userSkills: [skill({ name: '内部审计流程', manifest: { disableModelInvocation: true } })],
    });
    const prompt = buildAssistantSystemPrompt({ agentTools: true });
    expect(prompt).not.toContain('内部审计流程');
    expect(prompt).not.toContain('可用 Skill');
  });

  it('旧命令分支不注入 Skill 索引', () => {
    useAppStore.setState({ userSkills: [skill()] });
    expect(buildAssistantSystemPrompt()).not.toContain('可用 Skill');
  });
});

describe('助手任务项目作用域', () => {
  it('后台任务所属项目未加载时不注入当前画布节点', () => {
    useAppStore.setState({
      currentProjectId: 'project-b',
      projects: [
        { id: 'project-a', name: 'A', createdAt: 1, updatedAt: 1 },
        { id: 'project-b', name: 'B', createdAt: 1, updatedAt: 1 },
      ],
      nodes: [{
        id: 'node-b',
        type: 'ai-text',
        position: { x: 0, y: 0 },
        data: { type: 'ai-text', label: 'B 项目私有节点' },
      }],
      edges: [],
      selectedNodeIds: ['node-b'],
    });

    const prompt = buildAssistantSystemPrompt({
      agentTools: true,
      projectId: 'project-a',
      includeCanvasContext: false,
    });

    expect(prompt).toContain('项目: project-a');
    expect(prompt).toContain('当前未加载任务所属画布');
    expect(prompt).not.toContain('B 项目私有节点');
    expect(prompt).not.toContain('node-b');
  });

  it('拒绝在当前未加载的任务项目上执行本地画布命令', async () => {
    useAppStore.setState({ currentProjectId: 'project-b' });

    const result = await runAssistantPipeline('选中 3 号节点', 'conversation-a', 'project-a');

    expect(result.commandExecuted).toBe(false);
    expect(result.reply).toContain('任务所属画布当前未加载');
  });
});

describe('buildAssistantSystemPrompt 的厂商配置审批时序', () => {
  it('要求草稿生成后立即发起本地审批，不等待用户再发一条确认消息', () => {
    const prompt = buildAssistantSystemPrompt({ agentTools: true });

    expect(prompt).toContain('必须在同一 Agent 任务中立即调用 provider_config_apply');
    expect(prompt).toContain('本地 Policy 自动暂停并展示 API 配置审批卡');
    expect(prompt).toContain('不要先用普通文本要求用户回复“确认/添加”');
    expect(prompt).not.toContain('只有用户确认后才能调用 provider_config_apply');
  });

  it.each([
    { modelId: 'vendor-chat', builtin: false, declared: true },
    { modelId: 'deepseek-flash', builtin: false, declared: false },
    { modelId: 'deepseek-v4.1-flash', builtin: false, declared: false },
    { modelId: 'deepseek-flash', builtin: true, declared: false },
    { modelId: 'deepseek-v4.1-flash', builtin: true, declared: false },
  ])('sends referenced Base64 images directly to $modelId (builtin=$builtin, declared=$declared)', async ({ modelId, builtin, declared }) => {
    configureAssistant({ preset: 'openai-chat' });
    useAppStore.setState((state) => ({
      currentProjectId: 'project-vision',
      projects: [{ id: 'project-vision', name: 'Vision', createdAt: 1, updatedAt: 1 }],
      nodes: [{
        id: 'image-1',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: {
          type: 'ai-image',
          label: '参考图',
          imageUrl: 'data:image/png;base64,QUJDRA==',
        },
      }],
      config: {
        ...state.config,
        assistantModelId: builtin ? `apimart/${modelId}` : 'assistant-model',
        providers: builtin ? {
          apimart: {
            name: 'APIMart', apiKey: 'secret', baseUrl: 'https://gateway.example/v1',
            selectedModels: [{ id: modelId, name: modelId, category: 'text', provider: 'apimart' }],
          },
        } : state.config.providers,
        generalModels: builtin ? [] : (state.config.generalModels ?? []).map((model) => ({
          ...model,
          modelId,
          ...(declared ? { inputModalities: ['text', 'image'] as Array<'text' | 'image'> } : {}),
        })),
      },
    }));
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: '看到了图片' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await streamAssistantReply({
      systemPrompt: '系统',
      userMessage: '分析 @{image-1:参考图}',
      projectId: 'project-vision',
      nonStream: true,
      onEvent: vi.fn(),
    });

    expect(resolveAssistantModel('project-vision')?.supportsVision).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe(modelId);
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: '分析 图片1' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJDRA==' } },
    ]);
  });

  it.each([false, true])('keeps explicit DeepSeek text-only input when builtin=%s', (builtin) => {
    configureAssistant();
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      assistantModelId: builtin ? 'apimart/deepseek-flash' : 'assistant-model',
      providers: builtin ? {
        apimart: {
          name: 'APIMart', apiKey: 'secret', baseUrl: 'https://gateway.example/v1',
          selectedModels: [{ id: 'deepseek-flash', name: 'DeepSeek', category: 'text', provider: 'apimart', inputModalities: ['text'] }],
        },
      } : state.config.providers,
      generalModels: builtin ? [] : (state.config.generalModels ?? []).map((model) => ({
        ...model, modelId: 'deepseek-flash', inputModalities: ['text'] as Array<'text' | 'image'>,
      })),
    } }));

    expect(resolveAssistantModel()?.supportsVision).toBe(false);
  });
});
