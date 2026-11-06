/**
 * agentConversationContext — 回归测试：compression through the real assistant stream protocol。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../../../src/types/agent';
import type { AssistantStreamEvent, ChatMessage, ConversationContextSummary } from '../../../src/types/chat';
import type { AssistantModelMessage, StreamingCallOptions } from '../../../src/services/ai/assistantStream';

const { stream, loadMessages, resolveModel } = vi.hoisted(() => ({
  stream: vi.fn<(options: StreamingCallOptions) => Promise<void>>(),
  loadMessages: vi.fn(),
  resolveModel: vi.fn<(projectId?: string | null) => object | null>(() => ({})),
}));
vi.mock('../../../src/services/ai/assistantStream', () => ({
  streamAssistantReply: stream, resolveAssistantModel: resolveModel,
}));
vi.mock('../../../src/services/chat/chatHistoryService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/chat/chatHistoryService')>(), loadMessages,
}));
vi.mock('../../../src/services/chat/promptLearningService', () => ({
  buildLearnedPromptContext: vi.fn(async () => ''),
}));

import { useAppStore } from '../../../src/store/useAppStore';
import { assembleAgentContext, estimateModelMessagesTokens, resolveAssistantContextSpec } from '../../../src/services/chat/contextManager';
import { compactAgentMessages, compressConversationContext, SUMMARY_REQUIRED_SECTIONS } from '../../../src/services/chat/contextCompressionService';
import { findHistoryCutIndex, findModelCutPoint, serializeModelConversation } from '../../../src/services/chat/contextTranscript';
import { prepareAgentTaskResume, runAgentLoop, runAgentTask } from '../../../src/services/chat/agentRuntime';
import { fingerprintToolInput } from '../../../src/services/chat/agentCheckpointService';
import { clearAgentToolRegistryForTests, registerAgentTool } from '../../../src/services/chat/toolRegistry';
import { buildLearnedPromptContext } from '../../../src/services/chat/promptLearningService';
import * as memoryRetrieval from '../../../src/services/chat/memoryRetrieval';
import { WORKBENCH_AGENT_READ_TOOLS } from '../../../src/services/episodeWorkspaceScope';

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1', projectId: 'project-1', conversationId: 'conversation-1',
    userMessageId: 'user-1', goal: '生成分镜', mode: 'autonomous', status: 'running',
    modelRounds: 0, toolCallCount: 0,
    budget: { maxModelRounds: 12, maxToolCalls: 24, maxParallelReadTools: 3, maxReadRetries: 3 },
    createdAt: 1, updatedAt: 1,
    steps: [{
      id: 'step-1', taskId: 'task-1', index: 0, kind: 'tool', title: '创建分镜',
      status: 'succeeded', createdAt: 1, updatedAt: 1,
      outputSummary: '已创建分镜 #3',
      toolCall: { callId: 'call-1', toolId: 'canvas_create_nodes', retryCount: 0,
        effect: 'canvas_write', inputFingerprint: 'unchanged-fingerprint',
        resultDisplay: { references: [{ kind: 'node', id: 'node-3', label: '分镜' }] } },
    }],
    ...overrides,
  };
}

function chat(index: number, role: 'user' | 'assistant', content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `message-${index}`, conversationId: 'conversation-1', role, content,
    timestamp: index, status: 'done', ...extra };
}

function summary(extra = ''): string {
  return SUMMARY_REQUIRED_SECTIONS.map((section) => `【${section}】\n保留约束与任务进度`).join('\n') + extra;
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  const config = useAppStore.getState().config;
  useAppStore.setState({
    currentProjectId: 'project-1', activeConversationId: 'conversation-1', agentTasks: [task()],
    config: { ...config, assistantModelId: 'general/test-model', generalModels: [{
      id: 'test-model', name: 'Test', modelId: 'test', category: 'text',
      providerConfigId: 'test-provider', contextWindow: 8192,
    }] },
    conversations: [{
      id: 'conversation-1', projectId: 'project-1', title: '分镜', titleSource: 'auto',
      pinned: false, archived: false, agentMode: 'autonomous', createdAt: 1, updatedAt: 1, messageCount: 0,
    }],
  });
  stream.mockReset();
  resolveModel.mockReset().mockReturnValue({});
  loadMessages.mockReset();
  loadMessages.mockResolvedValue({ messages: [], total: 0 });
  stream.mockImplementation(async ({ onEvent }) => {
    onEvent({ type: 'text.delta', delta: summary('\n#3 node:node-3') });
    onEvent({ type: 'usage', inputTokens: 30, outputTokens: 15 });
  });
});

afterEach(() => { clearAgentToolRegistryForTests(); });

async function configureEpisodeContext() {
  const { resolveAssistantModel, streamAssistantReply } = await vi.importActual<typeof import('../../../src/services/ai/assistantStream')>(
    '../../../src/services/ai/assistantStream',
  );
  resolveModel.mockImplementation(resolveAssistantModel);
  useAppStore.setState((state) => ({
    currentProjectId: 'episode-1',
    projects: [
      { id: 'project-1', name: '剧集', nodes: [], edges: [], createdAt: 1, updatedAt: 1 },
      ...['episode-1', 'episode-2'].map((id) => ({
        id, parentId: 'project-1', name: id, nodes: [], edges: [], createdAt: 1, updatedAt: 1,
        settings: { defaultModels: { text: 'general/test-model' } },
      })),
    ],
    agentTasks: [task({ projectId: 'episode-1' })],
    config: {
      ...state.config,
      assistantModelId: undefined,
      providers: { 'test-provider': { name: '测试连接', apiKey: 'fixture', baseUrl: 'https://example.com/v1' } },
    },
  }));
  expect(resolveAssistantModel('episode-1')).not.toBeNull();
  expect(resolveAssistantModel('project-1')).toBeNull();
  return { streamAssistantReply };
}

function summarySseResponse(text: string, finishReason = 'stop'): Response {
  const frames = [
    ...[text.slice(0, 20), text.slice(20)].map((content) => ({ choices: [{ delta: { content } }] })),
    { choices: [{ delta: {}, finish_reason: finishReason }] },
  ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(`${frames}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('compression through the real assistant stream protocol', () => {
  it.each(['stop', 'length'])('routes the selected episode model and only persists a complete SSE summary (%s)', async (finishReason) => {
    const { streamAssistantReply } = await configureEpisodeContext();
    stream.mockImplementation(async (options) => { await streamAssistantReply(options); });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchMock = vi.fn().mockImplementation(async () => summarySseResponse(summary('\n#3 node:node-3'), finishReason));
    vi.stubGlobal('fetch', fetchMock);
    const persisted = Array.from({ length: 12 }, (_, i) => chat(i + 1, i % 2 ? 'assistant' : 'user', `历史${i}`));
    loadMessages.mockResolvedValue({ messages: persisted, total: persisted.length });

    const compression = compressConversationContext('conversation-1', { projectId: 'episode-1' });
    if (finishReason === 'stop') {
      await expect(compression).resolves.toMatchObject({ coveredUntilMessageId: 'message-4' });
      expect(useAppStore.getState().conversations[0].contextSummary?.text).toContain('node:node-3');
    } else {
      await expect(compression).rejects.toThrow('输出上限');
      expect(useAppStore.getState().conversations[0].contextSummary).toBeUndefined();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'test', stream: true });
    expect(body.tools).toBeUndefined();
    expect(useAppStore.getState().activeRequestAbort).toBeNull();
  });

  it('recovers from an HTTP compression failure and completes the same task through real SSE parsing', async () => {
    const { streamAssistantReply } = await configureEpisodeContext();
    stream.mockImplementation(async (options) => { await streamAssistantReply(options); });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: '临时服务不可用' } }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      }))
      .mockImplementationOnce(async () => summarySseResponse(summary('\n#3 node:node-3')))
      .mockImplementationOnce(async () => summarySseResponse('对话已恢复，继续沿用已完成的分镜。'));
    vi.stubGlobal('fetch', fetchMock);
    const persisted = Array.from({ length: 12 }, (_, i) => chat(i + 1, i % 2 ? 'assistant' : 'user', '长'.repeat(650)));
    loadMessages.mockResolvedValue({ messages: persisted, total: persisted.length });
    const onTextDelta = vi.fn();

    expect(await runAgentLoop({ taskId: 'task-1', systemPrompt: 'system', userMessage: '继续',
      signal: new AbortController().signal })).toBe('paused');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().conversations[0].contextSummary).toBeUndefined();

    prepareAgentTaskResume('task-1');
    const resumed = await runAgentTask('task-1', (signal) => runAgentLoop({
      taskId: 'task-1', systemPrompt: 'system', userMessage: '继续', signal, callbacks: { onTextDelta },
    }));
    expect(resumed.status).toBe('completed');
    expect(resumed.errorCode).toBeUndefined();
    expect(onTextDelta.mock.calls.map(([text]) => text).join('')).toBe('对话已恢复，继续沿用已完成的分镜。');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).model)).toEqual(['test', 'test', 'test']);
    expect(useAppStore.getState().activeRequestAbort).toBeNull();
  });
});

describe('episode conversation compression recovery', () => {
  it('uses the execution project model and tool progress for a shared series conversation after switching projects', async () => {
    await configureEpisodeContext();
    useAppStore.setState({ currentProjectId: 'unrelated-project' });
    const messages = Array.from({ length: 12 }, (_, i) => chat(i + 1, i % 2 ? 'assistant' : 'user',
      `历史${i} ${'长'.repeat(650)}`, i === 1 ? { agentTaskId: 'task-1' } : {}));
    loadMessages.mockResolvedValue({ messages, total: messages.length });

    const assembled = await assembleAgentContext({
      conversationId: 'conversation-1', projectId: 'episode-1', systemPrompt: 'system', userMessage: '继续',
    });

    expect(assembled.forcedCompression).toBe(true);
    expect(assembled.usage.estimatedTokens).toBeLessThan(assembled.usage.inputBudget);
    expect(stream.mock.calls[0][0]).toMatchObject({ projectId: 'episode-1', tools: [], trackAbort: false });
    expect(stream.mock.calls[0][0].userMessage).toContain('succeeded');
    expect(stream.mock.calls[0][0].userMessage).toContain('node-3');
    expect(useAppStore.getState().conversations[0].projectId).toBe('project-1');
  });

  it('also routes background precompression through the execution project', async () => {
    await configureEpisodeContext();
    const messages = Array.from({ length: 12 }, (_, i) => chat(i + 1, i % 2 ? 'assistant' : 'user', '长'.repeat(480)));
    loadMessages.mockResolvedValue({ messages, total: messages.length });

    const assembled = await assembleAgentContext({
      conversationId: 'conversation-1', projectId: 'episode-1', systemPrompt: 'system', userMessage: '继续',
    });

    expect(assembled.forcedCompression).toBe(false);
    await vi.waitFor(() => expect(useAppStore.getState().conversations[0].contextSummary).toBeDefined());
    expect(stream.mock.calls[0][0].projectId).toBe('episode-1');
  });

  it('can resume the same task after a compression request fails without replaying completed writes', async () => {
    await configureEpisodeContext();
    const messages = Array.from({ length: 12 }, (_, i) => chat(i + 1, i % 2 ? 'assistant' : 'user', '长'.repeat(650)));
    loadMessages.mockResolvedValue({ messages, total: messages.length });
    const steps = structuredClone(useAppStore.getState().agentTasks[0].steps);
    let failCompression = true;
    stream.mockImplementation(async (options) => {
      if (options.messages) {
        options.onEvent({ type: 'text.delta', delta: '已恢复对话，沿用已完成的分镜。' });
      } else {
        if (failCompression) throw new Error('临时网络故障');
        options.onEvent({ type: 'text.delta', delta: summary('\n#3 node:node-3') });
      }
    });
    const write = vi.fn();
    registerAgentTool({ id: 'canvas_create_nodes', title: '创建分镜', description: '测试写入', effect: 'canvas_write',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: write });

    expect(await runAgentLoop({ taskId: 'task-1', systemPrompt: 'system', userMessage: '继续',
      signal: new AbortController().signal })).toBe('paused');
    expect(useAppStore.getState().agentTasks[0].pausedReason).toBe('context_compression_failed');
    expect(useAppStore.getState().conversations[0].contextSummary).toBeUndefined();

    failCompression = false;
    prepareAgentTaskResume('task-1');
    const resumed = await runAgentTask('task-1', (signal) => runAgentLoop({
      taskId: 'task-1', systemPrompt: 'system', userMessage: '继续', signal,
    }));
    expect(resumed.status).toBe('completed');
    expect(resumed.pausedReason).toBeUndefined();
    expect(resumed.errorCode).toBeUndefined();
    expect(resumed.steps.slice(0, steps.length)).toEqual(steps);
    expect(write).not.toHaveBeenCalled();
    expect(stream.mock.calls.filter(([options]) => !options.messages)).toHaveLength(2);
  });

  it('rejects compression through a project outside the conversation owner', async () => {
    await configureEpisodeContext();
    await expect(compressConversationContext('conversation-1', { projectId: 'unrelated-project' }))
      .rejects.toThrow('不属于');
    expect(stream).not.toHaveBeenCalled();
    expect(loadMessages).not.toHaveBeenCalled();
  });

  it('skips model resolution when there is no older history to compress', async () => {
    resolveModel.mockReturnValue(null);
    await expect(compressConversationContext('conversation-1')).resolves.toBeNull();
    expect(resolveModel).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it('does not reuse another episode model request for concurrent compression', async () => {
    await configureEpisodeContext();
    const messages = Array.from({ length: 12 }, (_, i) => chat(i + 1, i % 2 ? 'assistant' : 'user', `历史${i}`));
    loadMessages.mockResolvedValue({ messages, total: messages.length });
    const first = compressConversationContext('conversation-1', { projectId: 'episode-1' });
    const second = compressConversationContext('conversation-1', { projectId: 'episode-2' });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(stream.mock.calls.map(([options]) => options.projectId)).toEqual(['episode-1', 'episode-2']);
    expect(useAppStore.getState().conversations[0].contextSummary?.coveredMessageCount).toBe(4);
  });

  it.each<AssistantStreamEvent>([
    { type: 'done', finishReason: 'length' },
    { type: 'done', finishReason: 'error' },
    { type: 'done', finishReason: 'canceled' },
    { type: 'error', code: 'STREAM_ERROR', message: '临时错误', retryable: true },
    { type: 'tool.call.final', call: { callId: 'unexpected', toolId: 'canvas_create_nodes', input: {} } },
  ])('preserves both history and checkpoints when summary generation does not complete: %j', async (event) => {
    const previousSummary: ConversationContextSummary = {
      text: summary(), coveredUntilMessageId: 'message-0', coveredUntilTimestamp: 0,
      coveredMessageCount: 1, estimatedTokens: 100, updatedAt: 1, formatVersion: 2,
    };
    useAppStore.setState((state) => ({ conversations: state.conversations.map((conversation) => ({
      ...conversation, contextSummary: previousSummary,
    })) }));
    const persisted = Array.from({ length: 12 }, (_, i) => chat(i + 1, i % 2 ? 'assistant' : 'user', `历史${i}`));
    loadMessages.mockResolvedValue({ messages: persisted, total: persisted.length });
    stream.mockImplementation(async ({ onEvent }) => {
      // 即使已收到所有区段和锚点，截断或错误结束的正文也不是有效摘要。
      onEvent({ type: 'text.delta', delta: summary('\n#3 node:node-3') });
      onEvent(event);
    });

    await expect(compressConversationContext('conversation-1')).rejects.toThrow();
    expect(useAppStore.getState().conversations[0].contextSummary).toEqual(previousSummary);
    const { messages, user } = longTaskMessages();
    const original = structuredClone(messages);
    await expect(compactAgentMessages('task-1', messages, user, new AbortController().signal)).rejects.toThrow();
    expect(messages).toEqual(original);
  });
});

describe('conversation continuity', () => {
  it('keeps this conversation history while skipping all project memory and prompt learning work', async () => {
    const memoryRank = vi.spyOn(memoryRetrieval, 'rankProjectMemories');
    vi.mocked(buildLearnedPromptContext).mockClear();
    useAppStore.setState({ projectMemories: [{ id: 'memory', projectId: 'project-1', kind: 'constraint',
      content: '不应加入工作台的项目记忆', enabled: true, source: { conversationId: 'another-conversation' },
      createdAt: 1, updatedAt: 1 }] });
    loadMessages.mockResolvedValue({ messages: [chat(1, 'user', '已确认的本集目标'), chat(2, 'assistant', '上一轮完整草稿')], total: 2 });
    try {
      const assembled = await assembleAgentContext({ conversationId: 'conversation-1', projectId: 'project-1',
        includeProjectContext: false, systemPrompt: 'system', userMessage: '继续润色刚才的草稿' });
      const content = JSON.stringify(assembled.messages);
      expect(content).toContain('已确认的本集目标');
      expect(content).toContain('上一轮完整草稿');
      expect(content).toContain('继续润色刚才的草稿');
      expect(content).not.toContain('不应加入工作台的项目记忆');
      expect(memoryRank).not.toHaveBeenCalled();
      expect(buildLearnedPromptContext).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
    } finally { memoryRank.mockRestore(); }
  });

  it('keeps the previous live answer in a follow-up before persistence finishes and excludes other conversations', async () => {
    useAppStore.setState({ messages: [chat(1, 'user', '写一份简洁的计划'), chat(2, 'assistant', '已经完成的最新计划'),
      chat(3, 'assistant', '其他对话的私有内容', { conversationId: 'other-conversation' })] });
    loadMessages.mockResolvedValue({ messages: [chat(1, 'user', '写一份简洁的计划'), chat(2, 'assistant', '旧版本')], total: 2 });
    const assembled = await assembleAgentContext({ conversationId: 'conversation-1', projectId: 'project-1',
      systemPrompt: 'system', userMessage: '把刚才的计划精简一下' });
    const content = assembled.messages.map((message) => message.content).join('\n');
    expect(content).toContain('已经完成的最新计划');
    expect(content).not.toContain('旧版本');
    expect(content).not.toContain('其他对话的私有内容');
  });

  it('carries successful tool results and real node references into a follow-up, including tool-only replies', async () => {
    loadMessages.mockResolvedValue({ messages: [
      chat(1, 'user', '生成分镜，保持水彩风格'),
      chat(2, 'assistant', '', { agentTaskId: 'task-1' }),
    ], total: 2 });
    const assembled = await assembleAgentContext({
      conversationId: 'conversation-1', projectId: 'project-1', systemPrompt: 'system',
      userMessage: '修改刚才的分镜，人物靠左',
    });
    expect(assembled.messages[1].content).toContain('水彩风格');
    expect(assembled.messages[2].content).toContain('[succeeded] canvas_create_nodes');
    expect(assembled.messages[2].content).toContain('node:node-3');
    expect(assembled.messages.at(-1)?.content).toBe('修改刚才的分镜，人物靠左');
    expect(assembled.usage.estimatedTokens).toBe(estimateModelMessagesTokens(assembled.messages));
  });

  it('isolates historical results by project and conversation and excludes live placeholders', async () => {
    useAppStore.setState({ agentTasks: [task({ projectId: 'other-project' })] });
    loadMessages.mockResolvedValue({ messages: [
      chat(1, 'user', '当前目标'),
      chat(2, 'assistant', '回答', { agentTaskId: 'task-1' }),
      chat(3, 'assistant', '后台未完成内容', { status: 'streaming' }),
      chat(4, 'assistant', '其他会话', { conversationId: 'other-conversation' }),
    ], total: 4 });
    const assembled = await assembleAgentContext({
      conversationId: 'conversation-1', projectId: 'project-1', systemPrompt: 'system', userMessage: '继续',
    });
    const all = JSON.stringify(assembled.messages);
    expect(all).not.toContain('canvas_create_nodes');
    expect(all).not.toContain('后台未完成内容');
    expect(all).not.toContain('其他会话');
  });

  it('keeps a contiguous complete recent turn when an older large turn does not fit', async () => {
    loadMessages.mockResolvedValue({ messages: [
      chat(1, 'user', '最早问题'), chat(2, 'assistant', '最早答案'),
      chat(3, 'user', '长'.repeat(7500)), chat(4, 'assistant', '长回答'.repeat(500)),
      chat(5, 'user', '最近问题'), chat(6, 'assistant', '最近答案'),
    ], total: 6 });
    const assembled = await assembleAgentContext({
      conversationId: 'conversation-1', projectId: 'project-1', systemPrompt: 'system', userMessage: '继续',
    });
    expect(assembled.messages.map((message) => message.content)).toEqual(['system', '最近问题', '最近答案', '继续']);
    expect(stream).not.toHaveBeenCalled();
  });

  it('compresses complete turns with tool progress and uses the conversation model when the active project changes', async () => {
    useAppStore.setState({ currentProjectId: 'other-project' });
    const messages = Array.from({ length: 12 }, (_, i) => chat(i + 1, i % 2 ? 'assistant' : 'user', `消息${i}`,
      i === 1 ? { agentTaskId: 'task-1' } : {}));
    loadMessages.mockResolvedValue({ messages, total: 12 });
    const compressed = await compressConversationContext('conversation-1');
    expect(compressed?.coveredUntilMessageId).toBe('message-4');
    expect(compressed?.text).toContain('#3');
    expect(resolveModel).toHaveBeenCalledWith('project-1');
    expect(stream.mock.calls[0][0]).toMatchObject({ projectId: 'project-1', tools: [], trackAbort: false });
    expect(stream.mock.calls[0][0].userMessage).toContain('succeeded');
    expect(stream.mock.calls[0][0].userMessage).toContain('node-3');
  });

  it('does not publish a summary after cancellation or after the conversation disappears', async () => {
    const messages = Array.from({ length: 12 }, (_, i) => chat(i + 1, i % 2 ? 'assistant' : 'user', `消息${i}`));
    loadMessages.mockResolvedValue({ messages, total: 12 });
    const controller = new AbortController();
    stream.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'text.delta', delta: summary() });
      controller.abort();
    });
    await expect(compressConversationContext('conversation-1', { signal: controller.signal })).rejects.toThrow('Aborted');
    expect(useAppStore.getState().conversations[0].contextSummary).toBeUndefined();
    stream.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'text.delta', delta: summary('\n#3') });
      useAppStore.setState({ conversations: [] });
    });
    await expect(compressConversationContext('conversation-1')).resolves.toBeNull();
  });
});

describe('Pi compaction boundaries', () => {
  it('moves a history cut to the user turn and does not split equal timestamps', () => {
    const messages = [chat(1, 'user', 'a'), chat(2, 'assistant', 'b'), chat(3, 'assistant', 'c'),
      chat(4, 'user', 'd'), chat(5, 'assistant', 'e')];
    expect(findHistoryCutIndex(messages, 3)).toBe(0);
    expect(findHistoryCutIndex(messages, 2)).toBe(3);
    messages[3].timestamp = messages[2].timestamp;
    expect(findHistoryCutIndex(messages, 2)).toBe(0);
  });

  it('keeps a large trailing tool result with its assistant call', () => {
    const messages: AssistantModelMessage[] = [
      { role: 'user', content: '目标' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: '结果'.repeat(5000) },
    ];
    expect(findModelCutPoint(messages, 100)).toBe(1);
  });

  it('serializes host summaries, excluding raw arguments, images and tool bodies', () => {
    const serialized = serializeModelConversation([
      { role: 'user', content: [{ type: 'text', text: '修改分镜' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,private-image' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'canvas_create_nodes', arguments: '{"raw":"private-arguments"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'private-file-body' },
    ], task());
    expect(serialized).toContain('已创建分镜 #3');
    expect(serialized).toContain('node:node-3');
    expect(serialized).not.toContain('private-');
  });

  it('redacts credentials and local paths in host result summaries before reuse', async () => {
    const previous = task();
    previous.steps[0].outputSummary = '已创建分镜 #3 /Users/example/private.png api_key=sk-abcdefghijklmnop';
    useAppStore.setState({ agentTasks: [previous] });
    loadMessages.mockResolvedValue({ messages: [chat(1, 'user', '生成分镜'),
      chat(2, 'assistant', '', { agentTaskId: previous.id })], total: 2 });
    const assembled = await assembleAgentContext({
      conversationId: 'conversation-1', projectId: 'project-1', systemPrompt: 'system', userMessage: '继续',
    });
    const content = JSON.stringify(assembled.messages);
    expect(content).toContain('node:node-3');
    expect(content).not.toContain('/Users/example');
    expect(content).not.toContain('sk-abcdefghijklmnop');
  });
});

function longTaskMessages(): { messages: AssistantModelMessage[]; user: AssistantModelMessage } {
  const user: AssistantModelMessage = { role: 'user', content: '继续生成分镜，保持水彩风格' };
  return { user, messages: [
    { role: 'system', content: '必须遵守既有 Policy' }, user,
    ...Array.from({ length: 3 }, (_, i): AssistantModelMessage => ({ role: 'assistant', content: `历史${i} ${'长'.repeat(2600)}` })),
    { role: 'assistant', content: '读取完成', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'canvas_create_nodes', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: '最后结果 #3' },
  ] };
}

describe('workbench compression scope', () => {
  beforeEach(() => {
    const workbenchTarget = { seriesId: 'project-1', episodeId: 'episode-2' };
    useAppStore.setState((state) => ({
      currentProjectId: 'episode-1', projectLoadStatus: 'ready', isCreatingProject: false,
      isReturningToStartPage: false, switchingProjectName: null,
      projects: [
        { id: 'project-1', name: '剧集', createdAt: 1, updatedAt: 1 },
        { id: 'episode-1', parentId: 'project-1', name: '画布当前集', createdAt: 1, updatedAt: 1 },
        { id: 'episode-2', parentId: 'project-1', name: '工作台目标集', createdAt: 1, updatedAt: 1 },
        { id: 'other-project', name: '另一项目', createdAt: 1, updatedAt: 1 },
      ],
      conversations: state.conversations.map((conversation) => ({ ...conversation, workbenchTarget })),
      agentTasks: [task({ projectId: 'episode-2', workbenchTarget,
        toolAllowlist: [...WORKBENCH_AGENT_READ_TOOLS], steps: [] })],
    }));
    const messages = Array.from({ length: 12 }, (_, i) => chat(i + 1, i % 2 ? 'assistant' : 'user', `历史${i}`));
    loadMessages.mockResolvedValue({ messages, total: messages.length });
  });

  it('uses the bound episode model and never resolves historical node references in either summary path', async () => {
    const marker = '@{node-private:历史稿件中的引用文本}';
    const persisted = Array.from({ length: 12 }, (_, i) => chat(i + 1, i % 2 ? 'assistant' : 'user', `${marker} 历史${i}`));
    loadMessages.mockResolvedValue({ messages: persisted, total: persisted.length });
    stream.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'text.delta', delta: summary(`\n${marker} #3 node:node-3`) });
    });
    await expect(compressConversationContext('conversation-1')).resolves.toMatchObject({ coveredUntilMessageId: 'message-4' });
    const { messages, user } = longTaskMessages();
    await compactAgentMessages('task-1', messages, user, new AbortController().signal);
    expect(stream).toHaveBeenCalledTimes(2);
    for (const [options] of stream.mock.calls) {
      expect(options).toMatchObject({ projectId: 'episode-2', tools: [], resolveVisualReferences: false });
    }
    expect(useAppStore.getState().currentProjectId).toBe('episode-1');
  });

  it('rejects an inactive workbench scope before reading history or calling the summary model', async () => {
    useAppStore.setState({ currentProjectId: 'other-project' });
    await expect(compressConversationContext('conversation-1')).rejects.toThrow('工作台目标或会话已失效');
    expect(loadMessages).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it('rechecks the workbench scope after asynchronous history loading before calling the summary model', async () => {
    loadMessages.mockImplementationOnce(async () => {
      useAppStore.setState({ currentProjectId: 'other-project' });
      return { messages: Array.from({ length: 12 }, (_, i) => chat(i + 1, i % 2 ? 'assistant' : 'user', `历史${i}`)), total: 12 };
    });
    await expect(compressConversationContext('conversation-1')).rejects.toThrow('工作台目标或会话已失效');
    expect(stream).not.toHaveBeenCalled();
    expect(useAppStore.getState().conversations[0].contextSummary).toBeUndefined();
  });

  it.each(['leave-series', 'rebind-target', 'delete-conversation'] as const)(
    'does not apply a returned conversation summary after %s', async (change) => {
      stream.mockImplementation(async ({ onEvent }) => {
        onEvent({ type: 'text.delta', delta: summary() });
        if (change === 'leave-series') useAppStore.setState({ currentProjectId: 'other-project' });
        else useAppStore.setState((state) => ({ conversations: state.conversations.map((conversation) => ({
          ...conversation,
          ...(change === 'rebind-target' ? { workbenchTarget: { seriesId: 'project-1', episodeId: 'episode-1' } }
            : { deletedAt: 1 }),
        })) }));
      });
      await expect(compressConversationContext('conversation-1')).rejects.toThrow('工作台目标或会话已失效');
      expect(useAppStore.getState().conversations[0].contextSummary).toBeUndefined();
      expect(stream).toHaveBeenCalledOnce();
    },
  );

  it('does not compact an active task after leaving its workbench series', async () => {
    const { messages, user } = longTaskMessages();
    const original = structuredClone(messages);
    useAppStore.setState({ currentProjectId: 'other-project' });
    await expect(compactAgentMessages('task-1', messages, user, new AbortController().signal))
      .rejects.toThrow('工作台目标或会话已失效');
    expect(messages).toEqual(original);
    expect(stream).not.toHaveBeenCalled();
  });

  it('preserves the in-flight transcript if the series changes during checkpoint generation', async () => {
    const { messages, user } = longTaskMessages();
    const original = structuredClone(messages);
    stream.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'text.delta', delta: summary('\n#3 node:node-3') });
      useAppStore.setState({ currentProjectId: 'other-project' });
    });
    await expect(compactAgentMessages('task-1', messages, user, new AbortController().signal))
      .rejects.toThrow('工作台目标或会话已失效');
    expect(messages).toEqual(original);
  });
});

describe('in-flight context checkpoints', () => {
  it('shrinks the request while keeping the goal, latest tool pair, interjection and write snapshots', async () => {
    const { messages, user } = longTaskMessages();
    messages.push({ role: 'user', content: '人物靠左，别再创建重复节点' });
    const before = estimateModelMessagesTokens(messages);
    const steps = useAppStore.getState().agentTasks[0].steps;
    await compactAgentMessages('task-1', messages, user, new AbortController().signal);
    expect(estimateModelMessagesTokens(messages)).toBeLessThan(before);
    expect(estimateModelMessagesTokens(messages)).toBeLessThan(resolveAssistantContextSpec('project-1').inputBudget);
    expect(messages).toContain(user);
    expect(messages[0].content).toBe('必须遵守既有 Policy');
    expect(messages.at(-1)?.content).toBe('人物靠左，别再创建重复节点');
    expect(messages.some((message) => message.tool_calls?.[0].id === 'call-1')).toBe(true);
    expect(messages.some((message) => message.tool_call_id === 'call-1')).toBe(true);
    expect(useAppStore.getState().agentTasks[0].steps).toEqual(steps);
    expect(useAppStore.getState().agentTasks[0].metrics).toMatchObject({ inputTokens: 30, outputTokens: 15 });
    expect(useAppStore.getState().conversations[0].contextSummary).toBeUndefined();
  });

  it('leaves the transcript untouched when the summary is invalid or the task is stopped during compaction', async () => {
    const { messages, user } = longTaskMessages();
    const original = structuredClone(messages);
    stream.mockImplementation(async ({ onEvent }) => { onEvent({ type: 'text.delta', delta: '丢失必要区段' }); });
    await expect(compactAgentMessages('task-1', messages, user, new AbortController().signal)).rejects.toThrow('缺少区段');
    expect(messages).toEqual(original);
    stream.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'text.delta', delta: summary() });
      useAppStore.setState({ agentTasks: [task({ status: 'stopped' })] });
    });
    await expect(compactAgentMessages('task-1', messages, user, new AbortController().signal)).rejects.toThrow('不再运行');
    expect(messages).toEqual(original);
  });

  it.each([true, false])('continues or pauses the real loop without repeating writes (valid summary: %s)', async (valid) => {
    let round = 0;
    const write = vi.fn(async () => ({ status: 'success' as const, summary: '已创建分镜 #3', modelContent: '工具内容'.repeat(500) }));
    registerAgentTool({ id: 'canvas_write_test', title: '创建分镜', description: '测试写入', effect: 'canvas_write',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: write });
    registerAgentTool({ id: 'read_test', title: '查询分镜', description: '测试读取', effect: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ status: 'success', summary: '已查询分镜 #3', modelContent: '查询内容'.repeat(500) }) });
    stream.mockImplementation(async (options) => {
      if (!options.messages) {
        options.onEvent({ type: 'text.delta', delta: valid ? summary('\n#3 node:node-3') : '缺少区段的摘要' });
        return;
      }
      round++;
      if (round <= 2) {
        options.onEvent({ type: 'text.delta', delta: '规划内容'.repeat(500) });
        options.onEvent({ type: 'tool.call.final', call: { callId: `call-${round}`, toolId: round === 1 ? 'canvas_write_test' : 'read_test', input: {} } });
      } else {
        expect(JSON.stringify(options.messages)).toContain('checkpoint');
        options.onEvent({ type: 'text.delta', delta: '分镜已完成。' });
      }
    });
    const outcome = await runAgentLoop({ taskId: 'task-1', systemPrompt: 'system', userMessage: '生成分镜', signal: new AbortController().signal });
    expect(outcome).toBe(valid ? 'completed' : 'paused');
    expect(round).toBe(valid ? 3 : 2);
    expect(write).toHaveBeenCalledTimes(1);
    if (!valid) expect(useAppStore.getState().agentTasks[0].pausedReason).toBe('context_compression_failed');
  });

  it('preserves restored write deduplication across a context checkpoint', async () => {
    const restored = task({ resumeCount: 1 });
    restored.steps[0].toolCall = {
      callId: 'old-write', toolId: 'canvas_write_test', retryCount: 0, effect: 'canvas_write',
      inputFingerprint: fingerprintToolInput('canvas_write_test', {}),
      canvasCheckpoint: { revisionBefore: 0, revisionAfter: 0, historyIndexBefore: 0, historyIndexAfter: 0 },
    };
    useAppStore.setState({ agentTasks: [restored], canvasRevision: 0, historyIndex: 0 });
    const write = vi.fn();
    registerAgentTool({ id: 'canvas_write_test', title: '创建分镜', description: '测试写入', effect: 'canvas_write',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: write });
    registerAgentTool({ id: 'read_test', title: '读取', description: '测试读取', effect: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ status: 'success', summary: '读取完成', modelContent: '读取内容'.repeat(500) }) });
    let round = 0;
    stream.mockImplementation(async (options) => {
      if (!options.messages) {
        options.onEvent({ type: 'text.delta', delta: summary() });
        return;
      }
      round++;
      if (round <= 2) {
        options.onEvent({ type: 'text.delta', delta: '分析内容'.repeat(500) });
        options.onEvent({ type: 'tool.call.final', call: { callId: `read-${round}`, toolId: 'read_test', input: {} } });
      } else if (round === 3) {
        expect(JSON.stringify(options.messages)).toContain('checkpoint');
        options.onEvent({ type: 'tool.call.final', call: { callId: 'new-write', toolId: 'canvas_write_test', input: {} } });
      } else options.onEvent({ type: 'text.delta', delta: '复用已完成的分镜。' });
    });
    const outcome = await runAgentLoop({ taskId: restored.id, systemPrompt: 'system', userMessage: '继续', signal: new AbortController().signal });
    expect(outcome).toBe('completed');
    expect(write).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0].steps.some((step) =>
      step.toolCall?.callId === 'new-write' && step.outputSummary?.includes('已复用先前成功结果'))).toBe(true);
  });
});
