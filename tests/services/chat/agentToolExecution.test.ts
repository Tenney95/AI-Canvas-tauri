/**
 * agentToolExecution — 回归测试：shared Agent tool execution for MCP。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentApprovalResolution, AgentMode, AgentTask } from '../../../src/types/agent';
import {
  executeRegisteredAgentToolCall,
  type RegisteredAgentToolCallOptions,
} from '../../../src/services/chat/agentToolExecution';
import {
  clearAgentToolRegistryForTests,
  registerAgentTool,
  type AgentToolDefinition,
} from '../../../src/services/chat/toolRegistry';
import {
  runAgentTask,
  stopAgentTask,
  transitionAgentTask,
  waitForAgentApproval,
} from '../../../src/services/chat/agentTaskControl';
import { useAppStore } from '../../../src/store/useAppStore';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../../src/services/chat/assistantScope';
import { registerProviderConfigAgentTools } from '../../../src/services/chat/tools/providerConfigTools';
import { getAgentTool } from '../../../src/services/chat/toolRegistry';
import { clearProviderModelCatalogsForTests, clearProviderModelCatalogsForTask, createProviderModelCatalog } from '../../../src/services/chat/providerModelCatalogService';
import { AGENT_RESULT_PREVIEW_CHARS, captureAgentResult, clearAgentResults, readAgentResult } from '../../../src/services/chat/agentResultService';
import * as projectFiles from '../../../src/services/fs/projectFiles';
import { captureLegacyProjectExpectedContext } from '../../../src/services/projectExecutionContext';
import { registerResultAgentTools } from '../../../src/services/chat/tools/resultTools';

function createTask(): AgentTask {
  return {
    id: 'mcp-task-1',
    projectId: 'project-1',
    conversationId: 'mcp-control-project-1',
    userMessageId: 'message-1',
    mode: 'autonomous',
    goal: 'MCP 请求：测试工具',
    status: 'queued',
    steps: [],
    modelRounds: 0,
    toolCallCount: 0,
    budget: {
      maxModelRounds: 1,
      maxToolCalls: 1,
      maxParallelReadTools: 1,
      maxReadRetries: 3,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    projectLoadStatus: 'ready',
    projects: [{ id: 'project-1', name: '项目', createdAt: 1, updatedAt: 1 }],
    activeConversationId: 'mcp-control-project-1',
    conversations: [{
      id: 'mcp-control-project-1',
      projectId: 'project-1',
      title: 'MCP 控制',
      titleSource: 'user',
      pinned: true,
      archived: false,
      agentMode: 'autonomous',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
    }],
    agentTasks: [createTask()],
  });
  registerAgentTool({ id: 'series_get_state', title: '剧集状态', description: '测试持久结果来源', effect: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    resultPolicy: { storage: 'project', source: 'project-derived' },
    authorize: (context) => ({ allowed: useAppStore.getState().currentProjectId === context.projectId }),
    execute: async () => ({ status: 'success', summary: 'unused', modelContent: 'unused' }) });
});

afterEach(() => {
  clearAgentResults({ taskId: 'mcp-task-1' });
  clearProviderModelCatalogsForTests();
  vi.restoreAllMocks();
  clearAgentToolRegistryForTests();
});

function registerBoundaryTool(overrides: Partial<AgentToolDefinition> = {}) {
  const execute = vi.fn(async () => ({ status: 'success' as const, summary: 'done', modelContent: 'done' }));
  registerAgentTool({
    id: 'boundary_test', title: 'Boundary test', description: 'Boundary test', effect: 'canvas_write',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute,
    ...overrides,
  });
  return execute;
}

function executeBoundaryTool(options: {
  signal?: AbortSignal;
  policyMode?: AgentMode;
  expectedContext?: RegisteredAgentToolCallOptions['expectedContext'];
  input?: Record<string, unknown>;
  waitForApproval?: () => Promise<AgentApprovalResolution>;
} = {}) {
  return executeRegisteredAgentToolCall({
    taskId: 'mcp-task-1',
    call: { callId: 'boundary-call', toolId: 'boundary_test', input: options.input ?? {} },
    signal: options.signal ?? new AbortController().signal,
    policyMode: options.policyMode,
    expectedContext: options.expectedContext,
    transitionTask: transitionAgentTask,
    waitForApproval: options.waitForApproval ?? vi.fn(async () => ({ approved: true })),
  });
}

function setBoundaryMode(mode: AgentMode) {
  useAppStore.getState().updateConversation('mcp-control-project-1', { agentMode: mode });
}

describe('shared Agent tool execution for MCP', () => {
  it('保留切集后迟到的已知effect结论和原预算，不将已完成提交降为unknown或重投', async () => {
    const execute = vi.fn(async () => {
      useAppStore.setState({ currentProjectId: 'project-2' });
      return { status: 'success' as const, summary: '原提交已完成', modelContent: '不得投影到另一集' };
    });
    registerBoundaryTool({ effect: 'media_generation', execute });
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((task) => ({ ...task, modelRounds: 7, toolCallCount: 9, resumeCount: 2 })) }));
    transitionAgentTask('mcp-task-1', 'planning');
    const result = await executeBoundaryTool();
    const task = useAppStore.getState().agentTasks[0];
    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ effectOutcome: 'success', summary: { status: 'error', errorCode: 'CONTEXT_REFRESH_REQUIRED' } });
    expect(task).toMatchObject({ projectId: 'project-1', modelRounds: 7, toolCallCount: 10, resumeCount: 2, status: 'paused' });
    expect(task.dispatches?.at(-1)).toMatchObject({ phase: 'settled', outcome: 'succeeded' });
    expect(task.steps[0]).toMatchObject({ status: 'succeeded', outputSummary: '原提交已完成' });
  });
  it.each(['project', 'revision'] as const)('rejects a changed %s during dynamic executor loading before counting or executing the call', async (change) => {
    const execute = registerBoundaryTool();
    transitionAgentTask('mcp-task-1', 'planning');
    const state = useAppStore.getState();
    const expectedContext = { projectId: 'project-1', baseRevision: state.getCurrentRevision() };
    const previousCount = state.agentTasks[0].toolCallCount;

    // executeRegisteredAgentToolCall 先等待动态 import；同步切换发生在其恢复之前。
    const pending = executeBoundaryTool({ expectedContext });
    expect(execute).not.toHaveBeenCalled();
    if (change === 'project') useAppStore.setState({ currentProjectId: 'project-2' });
    else useAppStore.getState().incrementRevision();
    const result = await pending;

    expect(result.summary).toMatchObject({
      callId: 'boundary-call', toolId: 'boundary_test', status: 'denied', errorCode: 'TOOL_CONTEXT_CHANGED',
    });
    expect(JSON.parse(result.modelContent)).toMatchObject({ errorCode: 'TOOL_CONTEXT_CHANGED', retryable: false });
    expect(result.summary.summary).toContain('不要自动重投写入');
    expect(execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0].toolCallCount).toBe(previousCount);
    expect(useAppStore.getState().agentTasks[0].steps).toEqual([]);
  });

  it('passes a matching expected context and the original input to the business executor', async () => {
    const execute = registerBoundaryTool({ inputSchema: {
      type: 'object', required: ['value'], additionalProperties: false,
      properties: { value: { type: 'string' } },
    } });
    transitionAgentTask('mcp-task-1', 'planning');
    useAppStore.getState().incrementRevision();
    const expectedContext = { projectId: 'project-1', baseRevision: useAppStore.getState().getCurrentRevision() };
    const input = { value: '原始参数😀' };

    const result = await executeBoundaryTool({ expectedContext, input });

    expect(result.summary.status).toBe('success');
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      ...expectedContext, taskId: 'mcp-task-1', conversationId: 'mcp-control-project-1',
    }), input);
    expect(input).toEqual({ value: '原始参数😀' });
    expect(useAppStore.getState().agentTasks[0].toolCallCount).toBe(1);
  });

  it('retains current-revision behavior for callers without expected-context metadata', async () => {
    const execute = registerBoundaryTool();
    transitionAgentTask('mcp-task-1', 'planning');

    const pending = executeBoundaryTool();
    useAppStore.getState().incrementRevision();
    const currentRevision = useAppStore.getState().getCurrentRevision();
    const result = await pending;

    expect(result.summary.status).toBe('success');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', baseRevision: currentRevision }), {});
    expect(useAppStore.getState().agentTasks[0].toolCallCount).toBe(1);
  });

  it('returns complete MCP JSON above the model limit without persisting its body', async () => {
    const body = JSON.stringify({ nodes: [{ prompt: 'complete-mcp-body-marker'.repeat(1200) }] });
    registerBoundaryTool({ effect: 'read', execute: async () => ({
      status: 'success', summary: 'read complete', modelContent: body,
    }) });
    transitionAgentTask('mcp-task-1', 'planning');

    const result = await executeBoundaryTool();

    expect(result.modelContent.length).toBeLessThanOrEqual(AGENT_RESULT_PREVIEW_CHARS);
    expect(result.summary.resultReference).toMatchObject({ storage: 'memory', chars: body.length });
    expect(result.modelContent).toContain(result.summary.resultReference!.id);
    expect(result.summary.truncated).toBe(true);
    expect(result.mcpContent).toEqual([{ type: 'text', text: body }]);
    expect(JSON.parse((result.mcpContent![0] as { text: string }).text)).toEqual(JSON.parse(body));
    expect(JSON.stringify({ tasks: useAppStore.getState().agentTasks, messages: useAppStore.getState().messages }))
      .not.toContain('complete-mcp-body-marker');
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    expect((await readAgentResult(scope, result.summary.resultReference!.id)).text).toContain('complete-mcp-body-marker');
    const reference = result.summary.resultReference!;
    if (!reference.projectScope || reference.projectScope.kind !== 'canvas') throw new Error('缺少原画布上下文');
    reference.projectScope = { ...reference.projectScope, projectEpoch: 1, canvasEpoch: 1 };
    useAppStore.setState((state) => ({ projects: state.projects.map((project) => ({ ...project, exchangeEpoch: 1 })) }));
    await expect(readAgentResult(scope, result.summary.resultReference!.id)).rejects.toThrow('上下文');
    useAppStore.setState({ currentProjectId: 'project-2' });
    await expect(readAgentResult(scope, result.summary.resultReference!.id)).rejects.toThrow('不属于当前项目');
  });

  it('rejects an old persistent result without a provable original project context', async () => {
    const id = 'result-11111111-1111-4111-8111-111111111111', sha256 = 'a'.repeat(64);
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((value) => ({ ...value, steps: [{
      id: 'old-step', taskId: value.id, index: 0, kind: 'tool', title: '旧结果', status: 'succeeded', createdAt: 1, updatedAt: 1,
      toolCall: { callId: 'old-call', toolId: 'boundary_test', retryCount: 0, resultReference: {
        id, storage: 'project', chars: 10, createdAt: 1,
        projectFile: { relativePath: `agent-results/${value.id}/${id}-${sha256}.json`, bytes: 10, sha256 },
      } },
    }] })) }));
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    await expect(readAgentResult(scope, id)).rejects.toThrow('上下文');
  });

  it('binds a new persistent result to the original epoch across memory eviction', async () => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    let saved = new Uint8Array();
    vi.spyOn(projectFiles, 'writeImmutableProjectFile').mockImplementation(async ({ data, reference }) => {
      saved = Uint8Array.from(data); return { ...reference, created: true };
    });
    const read = vi.spyOn(projectFiles, 'readVerifiedProjectFile').mockImplementation(async () => saved);
    const captured = await captureAgentResult({ scope, toolId: 'series_get_state', text: '原作品'.repeat(3000),
      policy: { storage: 'project', source: 'project-derived' } });
    expect(captured.reference).toMatchObject({ storage: 'project', projectScope: { projectId: 'project-1', projectEpoch: 0 } });
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((value) => ({ ...value, steps: [{
      id: 'step', taskId: value.id, index: 0, kind: 'tool', title: '保存结果', status: 'succeeded', createdAt: 1, updatedAt: 1,
      toolCall: { callId: 'call', toolId: 'series_get_state', retryCount: 0, resultReference: captured.reference },
    }] })) }));
    clearAgentResults({ taskId: scope.taskId });
    expect((await readAgentResult(scope, captured.reference!.id)).text).toContain('原作品');
    useAppStore.setState((state) => ({ projects: state.projects.map((project) => ({ ...project, exchangeEpoch: 1 })) }));
    clearAgentResults({ taskId: scope.taskId }); read.mockClear();
    await expect(readAgentResult(scope, captured.reference!.id)).rejects.toThrow('上下文');
    expect(read).not.toHaveBeenCalled();
    const reference = captured.reference!;
    if (!reference.projectScope || reference.projectScope.kind !== 'canvas') throw new Error('缺少原画布上下文');
    reference.projectScope = { ...reference.projectScope, projectEpoch: 1, canvasEpoch: 1 };
    await expect(readAgentResult(scope, reference.id)).rejects.toThrow('原始记录不一致');
  });

  it('restores a legacy persistent result only when the original file and task scopes agree', async () => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    let saved = new Uint8Array();
    vi.spyOn(projectFiles, 'writeImmutableProjectFile').mockImplementation(async ({ data, reference }) => {
      saved = Uint8Array.from(data); return { ...reference, created: true };
    });
    vi.spyOn(projectFiles, 'readVerifiedProjectFile').mockImplementation(async () => saved);
    const captured = await captureAgentResult({ scope, toolId: 'series_get_state', text: '旧作品'.repeat(3000),
      policy: { storage: 'project', source: 'project-derived' } });
    const reference = captured.reference!;
    if (!reference.projectScope || reference.projectScope.kind !== 'canvas') throw new Error('缺少原画布上下文');
    const projectScope = reference.projectScope;
    const document = JSON.parse(new TextDecoder().decode(saved));
    delete document.resultContext; document.projectScope = projectScope;
    saved = new TextEncoder().encode(JSON.stringify(document));
    const oldReference = { ...reference }; delete oldReference.projectScope;
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((value) => ({ ...value, projectScope, steps: [{
      id: 'legacy-step', taskId: value.id, index: 0, kind: 'tool', title: '旧结果', status: 'succeeded', createdAt: 1, updatedAt: 1,
      toolCall: { callId: 'legacy', toolId: 'series_get_state', retryCount: 0, resultReference: oldReference },
    }] })) }));
    clearAgentResults({ taskId: scope.taskId });
    expect((await readAgentResult(scope, reference.id)).text).toContain('旧作品');
    clearAgentResults({ taskId: scope.taskId });
    document.projectScope = { ...projectScope, projectEpoch: 1 };
    saved = new TextEncoder().encode(JSON.stringify(document));
    await expect(readAgentResult(scope, reference.id)).rejects.toThrow('原始记录不一致');
  });

  it('重启冷读和缓存命中都复核原工具授权，交付等待期间撤权也不能返回正文', async () => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    let saved = new Uint8Array(), release!: () => void;
    vi.spyOn(projectFiles, 'writeImmutableProjectFile').mockImplementation(async ({ data, reference }) => {
      saved = Uint8Array.from(data); return { ...reference, created: true };
    });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(projectFiles, 'readVerifiedProjectFile').mockImplementationOnce(async () => { await gate; return saved; })
      .mockImplementation(async () => saved);
    const captured = await captureAgentResult({ scope, toolId: 'series_get_state', text: '不得越权交付'.repeat(AGENT_RESULT_PREVIEW_CHARS),
      policy: { storage: 'project', source: 'project-derived' } });
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((value) => ({ ...value,
      toolAllowlist: ['agent_result_read', 'series_get_state'], steps: [{
        id: 'origin', taskId: value.id, index: 0, kind: 'tool', title: '读取剧集', status: 'succeeded', createdAt: 1, updatedAt: 1,
        toolCall: { callId: 'origin-call', toolId: 'series_get_state', retryCount: 0, resultReference: captured.reference },
      }] })) }));
    clearAgentResults({ taskId: scope.taskId });
    const pending = readAgentResult(scope, captured.reference!.id);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    useAppStore.getState().updateAgentTask(scope.taskId, { toolAllowlist: ['agent_result_read'] });
    release();
    await expect(pending).rejects.toThrow('原始工具授权');

    useAppStore.getState().updateAgentTask(scope.taskId, { toolAllowlist: ['agent_result_read', 'series_get_state'] });
    let authorize: (() => boolean) | undefined;
    const page = await readAgentResult(scope, captured.reference!.id, 0, 10, (check) => { authorize = check; });
    expect(page.text).toBe('不得越权交付不得越权');
    expect(authorize?.()).toBe(true);
    useAppStore.getState().updateAgentTask(scope.taskId, { toolAllowlist: ['agent_result_read'] });
    expect(authorize?.()).toBe(false);
    await expect(readAgentResult(scope, captured.reference!.id)).rejects.toThrow('原始工具授权');
    useAppStore.getState().updateAgentTask(scope.taskId, { toolAllowlist: ['agent_result_read', 'series_get_state'] });
    const origin = getAgentTool('series_get_state')!;
    origin.isAvailable = () => false;
    await expect(readAgentResult(scope, captured.reference!.id)).rejects.toThrow('原始工具授权');
    origin.isAvailable = () => true;
    origin.authorize = () => ({ allowed: false });
    await expect(readAgentResult(scope, captured.reference!.id)).rejects.toThrow('原始工具授权');
  });

  it('冷读拒绝重复来源步骤和文件中不匹配的工具身份', async () => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    let saved = new Uint8Array();
    vi.spyOn(projectFiles, 'writeImmutableProjectFile').mockImplementation(async ({ data, reference }) => {
      saved = Uint8Array.from(data); return { ...reference, created: true };
    });
    const read = vi.spyOn(projectFiles, 'readVerifiedProjectFile').mockImplementation(async () => saved);
    const captured = await captureAgentResult({ scope, toolId: 'series_get_state', text: '原作品'.repeat(3000),
      policy: { storage: 'project', source: 'project-derived' } });
    const step = { id: 'origin', taskId: scope.taskId, index: 0, kind: 'tool' as const, title: '读取', status: 'succeeded' as const,
      createdAt: 1, updatedAt: 1, toolCall: { callId: 'origin-call', toolId: 'series_get_state', retryCount: 0, resultReference: captured.reference } };
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((task) => ({ ...task, steps: [step, { ...step, id: 'duplicate' }] })) }));
    clearAgentResults({ taskId: scope.taskId });
    await expect(readAgentResult(scope, captured.reference!.id)).rejects.toThrow('不可恢复');
    expect(read).not.toHaveBeenCalled();
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((task) => ({ ...task, steps: [step] })) }));
    const document = JSON.parse(new TextDecoder().decode(saved));
    document.toolId = 'different_tool';
    saved = new TextEncoder().encode(JSON.stringify(document));
    await expect(readAgentResult(scope, captured.reference!.id)).rejects.toThrow('结果内容与引用不一致');
  });

  it('冷读期间原工具卸载并以同名定义替换时不交付旧正文', async () => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    let saved = new Uint8Array(), release!: () => void;
    vi.spyOn(projectFiles, 'writeImmutableProjectFile').mockImplementation(async ({ data, reference }) => {
      saved = Uint8Array.from(data); return { ...reference, created: true };
    });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(projectFiles, 'readVerifiedProjectFile').mockImplementation(async () => { await gate; return saved; });
    const captured = await captureAgentResult({ scope, toolId: 'series_get_state', text: '原作品'.repeat(3000),
      policy: { storage: 'project', source: 'project-derived' } });
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((task) => ({ ...task, steps: [{
      id: 'origin', taskId: task.id, index: 0, kind: 'tool', title: '读取', status: 'succeeded', createdAt: 1, updatedAt: 1,
      toolCall: { callId: 'origin-call', toolId: 'series_get_state', retryCount: 0, resultReference: captured.reference },
    }] })) }));
    clearAgentResults({ taskId: scope.taskId });
    const pending = readAgentResult(scope, captured.reference!.id);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const old = getAgentTool('series_get_state')!;
    clearAgentToolRegistryForTests();
    registerAgentTool({ ...old });
    release();
    await expect(pending).rejects.toThrow('原始工具授权');
  });

  it('冷读期间仅重排引用及嵌套上下文键不改变原授权，真实字段变化仍拒绝', async () => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    let saved = new Uint8Array(), release!: () => void;
    vi.spyOn(projectFiles, 'writeImmutableProjectFile').mockImplementation(async ({ data, reference }) => {
      saved = Uint8Array.from(data); return { ...reference, created: true };
    });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(projectFiles, 'readVerifiedProjectFile').mockImplementationOnce(async () => { await gate; return saved; })
      .mockImplementation(async () => saved);
    const context = captureLegacyProjectExpectedContext(useAppStore.getState(), 'canvas');
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((task) => ({ ...task, executionContext: context, projectScope: context })) }));
    const capturedScope = { ...scope, executionContext: context, projectScope: context };
    const captured = await captureAgentResult({ scope: capturedScope, toolId: 'series_get_state', text: '原作品'.repeat(3000),
      policy: { storage: 'project', source: 'project-derived' } });
    const reference = captured.reference!;
    const step = { id: 'origin', taskId: scope.taskId, index: 0, kind: 'tool' as const, title: '读取', status: 'succeeded' as const,
      createdAt: 1, updatedAt: 1, toolCall: { callId: 'origin-call', toolId: 'series_get_state', retryCount: 0, resultReference: reference } };
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((task) => ({ ...task, steps: [step] })) }));
    clearAgentResults({ taskId: scope.taskId });
    const pending = readAgentResult(scope, reference.id);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const reordered = { ...reference, projectFile: Object.fromEntries(Object.entries(reference.projectFile!).reverse()) as typeof reference.projectFile,
      executionContext: Object.fromEntries(Object.entries(reference.executionContext!).reverse()) as typeof reference.executionContext,
      projectScope: Object.fromEntries(Object.entries(reference.projectScope!).reverse()) as typeof reference.projectScope };
    // 仅改变自有字段的插入顺序，Object.fromEntries 不会保留已知键的静态类型。
    const reorderedReference = Object.fromEntries(Object.entries(reordered).reverse()) as unknown as typeof reference;
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((task) => ({ ...task,
      executionContext: reordered.executionContext, projectScope: reordered.projectScope, steps: [{ ...step,
      toolCall: { ...step.toolCall, resultReference: reorderedReference } }] })) }));
    release();
    expect((await pending).text).toContain('原作品');
    clearAgentResults({ taskId: scope.taskId });
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((task) => ({ ...task, steps: [{ ...step,
      toolCall: { ...step.toolCall, resultReference: { ...reorderedReference, chars: reference.chars + 1 } } }] })) }));
    await expect(readAgentResult(scope, reference.id)).rejects.toThrow('结果内容与引用不一致');
  });

  it('并发冷读同一结果后，两次工具交付的授权都保持有效，清理后均撤销', async () => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    let saved = new Uint8Array(), release!: () => void;
    vi.spyOn(projectFiles, 'writeImmutableProjectFile').mockImplementation(async ({ data, reference }) => {
      saved = Uint8Array.from(data); return { ...reference, created: true };
    });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(projectFiles, 'readVerifiedProjectFile').mockImplementation(async () => { await gate; return saved; });
    const captured = await captureAgentResult({ scope, toolId: 'series_get_state', text: '原作品'.repeat(3000),
      policy: { storage: 'project', source: 'project-derived' } });
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((task) => ({ ...task,
      toolAllowlist: ['agent_result_read', 'series_get_state'], steps: [{
        id: 'origin', taskId: task.id, index: 0, kind: 'tool', title: '读取', status: 'succeeded', createdAt: 1, updatedAt: 1,
        toolCall: { callId: 'origin-call', toolId: 'series_get_state', retryCount: 0, resultReference: captured.reference },
      }] })) }));
    clearAgentResults({ taskId: scope.taskId });
    registerResultAgentTools();
    const tool = getAgentTool('agent_result_read')!;
    const context = { ...scope, mode: 'autonomous' as const, signal: new AbortController().signal };
    const pending = [tool.execute(context, { resultId: captured.reference!.id }), tool.execute(context, { resultId: captured.reference!.id })];
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    release();
    const results = await Promise.all(pending);
    expect(results.map((result) => result.status)).toEqual(['success', 'success']);
    expect(results.map((result) => result.resultPolicy?.authorize?.())).toEqual([true, true]);
    clearAgentResults({ taskId: scope.taskId });
    expect(results.map((result) => result.resultPolicy?.authorize?.())).toEqual([false, false]);
  });

  it('rejects a persistent result when the task scope changes while its file is loading', async () => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    let saved = new Uint8Array(), release!: () => void;
    vi.spyOn(projectFiles, 'writeImmutableProjectFile').mockImplementation(async ({ data, reference }) => {
      saved = Uint8Array.from(data); return { ...reference, created: true };
    });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(projectFiles, 'readVerifiedProjectFile').mockImplementation(async () => { await gate; return saved; });
    const captured = await captureAgentResult({ scope, toolId: 'series_get_state', text: '原作品'.repeat(80_000),
      policy: { storage: 'project', source: 'project-derived' } });
    const original = captured.reference!.projectScope;
    if (!original || original.kind !== 'canvas') throw new Error('缺少原画布上下文');
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((value) => ({ ...value, projectScope: original, steps: [{
      id: 'step', taskId: value.id, index: 0, kind: 'tool', title: '保存结果', status: 'succeeded', createdAt: 1, updatedAt: 1,
      toolCall: { callId: 'call', toolId: 'series_get_state', retryCount: 0, resultReference: captured.reference },
    }] })) }));
    clearAgentResults({ taskId: scope.taskId });
    const pending = readAgentResult(scope, captured.reference!.id);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((value) => ({ ...value,
      projectScope: { ...original, projectEpoch: original.projectEpoch + 1 } })) }));
    release();
    await expect(pending).rejects.toThrow('上下文');
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((value) => ({ ...value, projectScope: original })) }));
    let delivered = 0;
    for (let index = 0; index < 17; index++) delivered += (await readAgentResult(scope, captured.reference!.id)).text.length;
    expect(delivered).toBe(200_000);
    await expect(readAgentResult(scope, captured.reference!.id)).rejects.toThrow('预算');
  });

  it('does not publish a result reference when its task scope changes during file writing', async () => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    const original = captureLegacyProjectExpectedContext(useAppStore.getState(), 'canvas');
    if (original.kind !== 'canvas') throw new Error('缺少原画布上下文');
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((value) => ({ ...value, projectScope: original })) }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const write = vi.spyOn(projectFiles, 'writeImmutableProjectFile').mockImplementation(async ({ reference }) => {
      await gate; return { ...reference, created: true };
    });
    const pending = captureAgentResult({ scope, toolId: 'boundary_test', text: '原作品'.repeat(3000),
      policy: { storage: 'project', source: 'project-derived' } });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((value) => ({ ...value,
      projectScope: { ...original, projectEpoch: original.projectEpoch + 1 } })) }));
    release();
    await expect(pending).rejects.toThrow('上下文');
  });

  it.each(['task', 'conversation', 'project', 'all'] as const)('清理 %s 时撤销在途持久回读，后续新回读不受影响', async (kind) => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    let saved = new Uint8Array(), release!: () => void;
    vi.spyOn(projectFiles, 'writeImmutableProjectFile').mockImplementation(async ({ data, reference }) => {
      saved = Uint8Array.from(data); return { ...reference, created: true };
    });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(projectFiles, 'readVerifiedProjectFile').mockImplementation(async () => { await gate; return saved; });
    const captured = await captureAgentResult({ scope, toolId: 'series_get_state', text: '原结果'.repeat(3000),
      policy: { storage: 'project', source: 'project-derived' } });
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((value) => ({ ...value, steps: [{
      id: 'step', taskId: value.id, index: 0, kind: 'tool', title: '保存结果', status: 'succeeded', createdAt: 1, updatedAt: 1,
      toolCall: { callId: 'call', toolId: 'series_get_state', retryCount: 0, resultReference: captured.reference },
    }] })) }));
    clearAgentResults({ taskId: scope.taskId });
    const pending = readAgentResult(scope, captured.reference!.id);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    clearAgentResults(kind === 'task' ? { taskId: scope.taskId } : kind === 'conversation'
      ? { conversationId: scope.conversationId } : kind === 'project' ? { projectId: scope.projectId } : {});
    release();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect((await readAgentResult(scope, captured.reference!.id)).text).toContain('原结果');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('清理期间持久结果写入不返回正文或引用', async () => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const write = vi.spyOn(projectFiles, 'writeImmutableProjectFile').mockImplementation(async ({ reference }) => {
      await gate; return { ...reference, created: true };
    });
    const pending = captureAgentResult({ scope, toolId: 'boundary_test', text: '原结果'.repeat(3000),
      policy: { storage: 'project', source: 'project-derived' } });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    clearAgentResults({ taskId: scope.taskId });
    release();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each(['clear', 'project'] as const)('普通磁盘错误与 %s 同时发生时不返回旧预览', async (change) => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const write = vi.spyOn(projectFiles, 'writeImmutableProjectFile').mockImplementation(async () => {
      await gate; throw new Error('disk error');
    });
    const pending = captureAgentResult({ scope, toolId: 'boundary_test', text: '旧正文'.repeat(3000),
      policy: { storage: 'project', source: 'project-derived' } });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    if (change === 'clear') clearAgentResults({ taskId: scope.taskId });
    else useAppStore.setState({ currentProjectId: 'another-project' });
    release();
    await expect(pending).rejects.toThrow(change === 'clear' ? '撤销' : '不属于当前项目');
  });

  it.each([10, 1_000_001])('授权已撤销时不交付长度为 %i 的任何结果', async (length) => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    await expect(captureAgentResult({ scope, toolId: 'boundary_test', text: 'x'.repeat(length),
      policy: { storage: 'memory', authorize: () => false } })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('停止后迟到的只读返回不得交付正文或写入成功步骤', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate; return { status: 'success' as const, summary: '迟到摘要', modelContent: '迟到正文' };
    });
    registerBoundaryTool({ effect: 'read', execute });
    transitionAgentTask('mcp-task-1', 'planning');
    const pending = executeBoundaryTool();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    stopAgentTask('mcp-task-1');
    release();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const task = useAppStore.getState().agentTasks[0];
    expect(task.status).toBe('stopped');
    expect(task.steps.some((step) => step.status === 'succeeded')).toBe(false);
    expect(JSON.stringify(task.steps)).not.toContain('迟到正文');
    expect(JSON.stringify(task.steps)).not.toContain('迟到摘要');
  });

  it('持久结果读取期间撤销工具白名单后不交付正文', async () => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    let saved = new Uint8Array(), release!: () => void;
    vi.spyOn(projectFiles, 'writeImmutableProjectFile').mockImplementation(async ({ data, reference }) => {
      saved = Uint8Array.from(data); return { ...reference, created: true };
    });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(projectFiles, 'readVerifiedProjectFile').mockImplementation(async () => { await gate; return saved; });
    const captured = await captureAgentResult({ scope, toolId: 'series_get_state', text: '不能泄露的旧正文'.repeat(2000),
      policy: { storage: 'project', source: 'project-derived' } });
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((value) => ({ ...value, toolAllowlist: ['agent_result_read', 'series_get_state'], steps: [{
      id: 'saved-step', taskId: value.id, index: 0, kind: 'tool', title: '保存结果', status: 'succeeded', createdAt: 1, updatedAt: 1,
      toolCall: { callId: 'saved', toolId: 'series_get_state', retryCount: 0, resultReference: captured.reference },
    }] })) }));
    clearAgentResults({ taskId: scope.taskId });
    registerResultAgentTools();
    transitionAgentTask('mcp-task-1', 'planning');
    const pending = executeRegisteredAgentToolCall({ taskId: scope.taskId,
      call: { callId: 'read-result', toolId: 'agent_result_read', input: { resultId: captured.reference!.id } },
      signal: new AbortController().signal, transitionTask: transitionAgentTask,
      waitForApproval: vi.fn(async () => ({ approved: true })) });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    useAppStore.getState().updateAgentTask(scope.taskId, { toolAllowlist: [] });
    release();
    const result = await pending;
    expect(result.summary.status).toBe('error');
    expect(result.modelContent).not.toContain('不能泄露的旧正文');
    expect(JSON.stringify(useAppStore.getState().agentTasks)).not.toContain('不能泄露的旧正文');
  });

  it('enforces one shared read budget when many persistent reads finish concurrently', async () => {
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'mcp-control-project-1' };
    let saved = new Uint8Array(), release!: () => void;
    vi.spyOn(projectFiles, 'writeImmutableProjectFile').mockImplementation(async ({ data, reference }) => {
      saved = Uint8Array.from(data); return { ...reference, created: true };
    });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(projectFiles, 'readVerifiedProjectFile').mockImplementation(async () => { await gate; return saved; });
    const captured = await captureAgentResult({ scope, toolId: 'series_get_state', text: 'x'.repeat(220_000),
      policy: { storage: 'project', source: 'project-derived' } });
    useAppStore.setState((state) => ({ agentTasks: state.agentTasks.map((value) => ({ ...value, steps: [{
      id: 'step', taskId: value.id, index: 0, kind: 'tool', title: '保存结果', status: 'succeeded', createdAt: 1, updatedAt: 1,
      toolCall: { callId: 'call', toolId: 'series_get_state', retryCount: 0, resultReference: captured.reference },
    }] })) }));
    clearAgentResults({ taskId: scope.taskId });
    const pending = Array.from({ length: 18 }, () => readAgentResult(scope, captured.reference!.id));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(18));
    release();
    const results = await Promise.allSettled(pending);
    const delivered = results.flatMap((result) => result.status === 'fulfilled' ? [result.value.text.length] : []);
    expect(delivered.reduce((total, length) => total + length, 0)).toBe(200_000);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('keeps ordinary assistant results bounded by the model limit', async () => {
    useAppStore.setState((state) => ({
      activeConversationId: 'ordinary-conversation',
      conversations: [{ ...state.conversations[0], id: 'ordinary-conversation' }],
      agentTasks: [{ ...state.agentTasks[0], conversationId: 'ordinary-conversation' }],
    }));
    registerBoundaryTool({ effect: 'read', execute: async () => ({
      status: 'success', summary: 'read complete', modelContent: 'x'.repeat(21_000),
    }) });
    transitionAgentTask('mcp-task-1', 'planning');

    const result = await executeBoundaryTool();

    expect(result.modelContent.length).toBeLessThanOrEqual(AGENT_RESULT_PREVIEW_CHARS);
    expect(result.summary.truncated).toBe(true);
    const reference = result.summary.resultReference;
    expect(reference).toMatchObject({ storage: 'memory', chars: 21_000 });
    if (!reference) throw new Error('Expected a scoped result reference');
    expect(result.modelContent).toContain(reference.id);
    const scope = { taskId: 'mcp-task-1', projectId: 'project-1', conversationId: 'ordinary-conversation' };
    const first = await readAgentResult(scope, reference.id);
    const last = await readAgentResult(scope, reference.id, first.nextOffset);
    expect(first.eof).toBe(false);
    expect(last.eof).toBe(true);
    expect(first.text + last.text).toBe('x'.repeat(21_000));
    expect(result.mcpContent).toBeUndefined();
    expect(result.mcpResultError).toBeUndefined();
  });

  it('marks truncation performed by the tool separately from the model text limit', async () => {
    const body = JSON.stringify({ items: ['first page'], nextCursor: 'next' });
    registerBoundaryTool({ effect: 'read', execute: async () => ({
      status: 'success', summary: 'partial read', modelContent: body, truncated: true,
    }) });
    transitionAgentTask('mcp-task-1', 'planning');

    const result = await executeBoundaryTool();

    expect(result.mcpContent?.[0]).toEqual({ type: 'text', text: body });
    expect(JSON.parse((result.mcpContent![1] as { text: string }).text)).toMatchObject({ truncated: true });
    expect(result.mcpResultError).toBeUndefined();
  });

  it.each([
    { kind: 'UTF-8 bytes', body: '界'.repeat(180_000) },
    { kind: 'JSON escapes', body: '\n'.repeat(263_000) },
  ])('rejects oversized serialized MCP text without splitting JSON ($kind)', async ({ body }) => {
    expect(body.length).toBeLessThan(512 * 1024);
    registerBoundaryTool({ effect: 'read', execute: async () => ({
      status: 'success', summary: 'read complete', modelContent: body,
    }) });
    transitionAgentTask('mcp-task-1', 'planning');

    const result = await executeBoundaryTool();

    expect(result.mcpResultError).toBe(true);
    expect(result.summary.status).toBe('success');
    expect(JSON.parse((result.mcpContent![0] as { text: string }).text)).toMatchObject({
      code: 'MCP_RESULT_TOO_LARGE', operationStatus: 'success', resultOmitted: true, retryable: false,
    });
    expect(JSON.stringify(result.mcpContent).length).toBeLessThan(1000);
  });

  it('preserves successful writes when their result exceeds the MCP delivery budget', async () => {
    const write = vi.fn(async () => ({
      status: 'success' as const, summary: 'write complete', modelContent: 'x'.repeat(600_000),
    }));
    registerBoundaryTool({ effect: 'file_write', execute: write });

    const task = await runAgentTask('mcp-task-1', async (signal) => {
      const result = await executeBoundaryTool({ signal });
      expect(result.summary.status).toBe('success');
      expect(result.mcpResultError).toBe(false);
      const omitted = JSON.parse((result.mcpContent![0] as { text: string }).text);
      expect(omitted).toMatchObject({ operationStatus: 'success', resultOmitted: true, retryable: false });
      expect(omitted.message).toContain('不要重复提交写入');
      return 'completed';
    });

    expect(write).toHaveBeenCalledOnce();
    expect(task.status).toBe('completed');
    expect(task.steps[0].status).toBe('succeeded');
    expect(task.steps[0].toolCall?.resultSummary).toBe('write complete');
  });

  it('preserves existing rich MCP content without applying the ordinary text budget', async () => {
    const content = [{ type: 'image' as const, mimeType: 'image/jpeg' as const, data: 'Y'.repeat(600_000) }];
    registerBoundaryTool({ effect: 'read', execute: async () => ({
      status: 'success', summary: 'image complete', modelContent: 'image complete', mcpContent: content,
    }) });
    transitionAgentTask('mcp-task-1', 'planning');

    const result = await executeBoundaryTool();

    expect(result.mcpContent).toBe(content);
    expect(result.mcpResultError).toBeUndefined();
  });

  it.each([false, true])('rechecks general tool access after approval; revoked=%s', async (revoked) => {
    const task = { ...createTask(), projectId: GENERAL_ASSISTANT_SCOPE_ID,
      conversationId: 'conv-general', toolAllowlist: ['file_write_text'], mode: 'collaborative' as const };
    useAppStore.setState((state) => ({ currentProjectId: null, agentTasks: [task],
      conversations: [{ ...state.conversations[0], id: task.conversationId, projectId: task.projectId, agentMode: task.mode }] }));
    const execute = registerBoundaryTool({ id: 'file_write_text', effect: 'file_write' });
    transitionAgentTask(task.id, 'planning');
    const wait = vi.fn(async () => {
      useAppStore.setState({ currentProjectId: 'other-project' });
      if (revoked) useAppStore.getState().updateAgentTask(task.id, { toolAllowlist: [] });
      return { approved: true };
    });
    const result = await executeRegisteredAgentToolCall({ taskId: task.id,
      call: { callId: 'general-save', toolId: 'file_write_text', input: {} },
      signal: new AbortController().signal, transitionTask: transitionAgentTask, waitForApproval: wait });
    expect(wait).toHaveBeenCalledOnce();
    expect(result.summary.status).toBe(revoked ? 'denied' : 'success');
    expect(execute).toHaveBeenCalledTimes(revoked ? 0 : 1);
  });

  function arrangeProviderSelection(catalog: boolean) {
    registerProviderConfigAgentTools();
    const options = Array.from({ length: catalog ? 1000 : 20 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}`, category: 'text' as const }));
    const task = createTask();
    const scope = { taskId: task.id, projectId: task.projectId, conversationId: task.conversationId };
    const input = catalog ? { catalogId: createProviderModelCatalog(scope, options).catalogId } : { models: options };
    const execute = vi.spyOn(getAgentTool('provider_models_select')!, 'execute');
    transitionAgentTask(task.id, 'planning');
    return { input, execute };
  }

  it.each([
    ['collaborative', undefined, false], ['collaborative', undefined, true],
    ['autonomous', undefined, false], ['autonomous', undefined, true],
    ['plan', 'autonomous', false], ['plan', 'autonomous', true],
  ] as const)('routes provider choices for mode %s / override %s / catalog %s', async (mode, policyMode, catalog) => {
    setBoundaryMode(mode);
    const { input, execute } = arrangeProviderSelection(catalog);
    const chosen = catalog ? 'model-999' : 'model-19';
    const wait = vi.fn(async () => {
      expect(execute).not.toHaveBeenCalled();
      return { approved: true, inputValues: { selectedModelIds: [chosen] } };
    });
    const result = await executeRegisteredAgentToolCall({ taskId: 'mcp-task-1',
      call: { callId: 'choose', toolId: 'provider_models_select', input }, policyMode,
      signal: new AbortController().signal, transitionTask: transitionAgentTask, waitForApproval: wait });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(result.summary.status).toBe('success');
    expect(execute).toHaveBeenCalledWith(expect.anything(), { ...input, selectedIds: [chosen] });
    expect(result.modelContent).toContain(chosen);
    const request = useAppStore.getState().agentTasks[0].steps[0].approval?.inputRequest;
    expect(request?.kind).toBe('provider_models');
    expect(request).not.toHaveProperty('selectedModelRef');
  });

  it.each(['expired', 'denied', 'stopped', 'plan'] as const)('rechecks provider selection after %s while approval was pending', async (change) => {
    setBoundaryMode('collaborative');
    const { input, execute } = arrangeProviderSelection(true);
    let allowed = true;
    getAgentTool('provider_models_select')!.authorize = () => ({ allowed, reason: '选择授权已撤销' });
    const controller = new AbortController();
    const result = executeRegisteredAgentToolCall({ taskId: 'mcp-task-1',
      call: { callId: 'changed', toolId: 'provider_models_select', input }, signal: controller.signal,
      transitionTask: transitionAgentTask, waitForApproval: async () => {
        if (change === 'expired') clearProviderModelCatalogsForTask('mcp-task-1');
        if (change === 'denied') allowed = false;
        if (change === 'stopped') { controller.abort(); transitionAgentTask('mcp-task-1', 'stopped'); }
        if (change === 'plan') setBoundaryMode('plan');
        return { approved: true, inputValues: { selectedModelIds: ['model-999'] } };
      } });
    if (change === 'stopped') await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    else {
      const returned = await result;
      expect(returned.summary.status).not.toBe('success');
      expect(returned.summary.summary).toContain(change === 'expired' ? '失效' : change === 'denied' ? '授权' : 'Plan');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { ids: [] }, { ids: ['fake'] }, { ids: ['model-0', 'model-0'] },
    { ids: Array.from({ length: 17 }, (_, index) => `model-${index}`) },
    { ids: 'model-0' }, { ids: [1] },
  ])('rejects invalid MCP choice data before execute: $ids', async ({ ids }) => {
    const { input, execute } = arrangeProviderSelection(true);
    const result = await executeRegisteredAgentToolCall({ taskId: 'mcp-task-1',
      call: { callId: 'invalid', toolId: 'provider_models_select', input }, policyMode: 'autonomous',
      signal: new AbortController().signal, transitionTask: transitionAgentTask,
      waitForApproval: async () => ({ approved: true, inputValues: { selectedModelIds: ids } }) as AgentApprovalResolution });
    expect(result.summary.status).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0].steps[0].errorCode).toBe('AGENT_APPROVAL_INPUT_INVALID');
  });

  it('rejects mixed media and provider selection fields', async () => {
    const { input, execute } = arrangeProviderSelection(false);
    const result = await executeRegisteredAgentToolCall({ taskId: 'mcp-task-1',
      call: { callId: 'mixed', toolId: 'provider_models_select', input }, policyMode: 'autonomous',
      signal: new AbortController().signal, transitionTask: transitionAgentTask,
      waitForApproval: async () => ({ approved: true, inputValues: { selectedModelIds: ['model-0'], modelRef: 'media' } }) });
    expect(result.summary.status).toBe('denied');
    expect(result.summary.summary).toContain('modelRef');
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['paused', 'stopped', 'completed', 'failed'] as const)('rejects a %s task before invoking a tool', async (status) => {
    const execute = registerBoundaryTool();
    useAppStore.getState().updateAgentTask('mcp-task-1', { status });
    await expect(executeBoundaryTool()).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0].status).toBe(status);
  });

  it('does not resume or execute a stopped task when an old approval resolves', async () => {
    const execute = registerBoundaryTool();
    setBoundaryMode('collaborative');
    transitionAgentTask('mcp-task-1', 'planning');
    const controller = new AbortController();
    await expect(executeBoundaryTool({
      signal: controller.signal,
      waitForApproval: async () => {
        controller.abort();
        transitionAgentTask('mcp-task-1', 'stopped');
        return { approved: true };
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0].status).toBe('stopped');
  });

  it('rejects a previously approved write after switching to Plan', async () => {
    const execute = registerBoundaryTool();
    setBoundaryMode('collaborative');
    transitionAgentTask('mcp-task-1', 'planning');
    const result = await executeBoundaryTool({ waitForApproval: async () => {
      setBoundaryMode('plan');
      return { approved: true };
    } });
    expect(result.summary.status).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rechecks project identity even when the new project has the same revision', async () => {
    const execute = registerBoundaryTool();
    setBoundaryMode('collaborative');
    transitionAgentTask('mcp-task-1', 'planning');
    const result = await executeBoundaryTool({ waitForApproval: async () => {
      useAppStore.setState({ currentProjectId: 'project-2' });
      return { approved: true };
    } });
    expect(result.summary.status).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('retains the trusted autonomous MCP override independently of conversation mode', async () => {
    const execute = registerBoundaryTool();
    setBoundaryMode('plan');
    const waitForApproval = vi.fn();
    const result = await executeBoundaryTool({ policyMode: 'autonomous', waitForApproval });
    expect(result.summary.status).toBe('success');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ mode: 'autonomous' }), {});
    expect(waitForApproval).not.toHaveBeenCalled();
  });

  it('does not bypass a user-choice approval with the MCP override', async () => {
    const execute = registerBoundaryTool({ effect: 'user_choice' });
    setBoundaryMode('plan');
    transitionAgentTask('mcp-task-1', 'planning');
    const waitForApproval = vi.fn(async () => ({ approved: true }));
    const result = await executeBoundaryTool({ policyMode: 'autonomous', waitForApproval });
    expect(result.summary.status).toBe('success');
    expect(waitForApproval).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rechecks read authorization before an automatic retry', async () => {
    let authorized = true;
    const execute = vi.fn(async () => {
      authorized = false;
      return { status: 'error' as const, retryable: true, summary: 'temporary error', modelContent: 'temporary error' };
    });
    registerBoundaryTool({ effect: 'read', authorize: () => ({ allowed: authorized }), execute });
    const result = await executeBoundaryTool();
    expect(result.summary.status).toBe('denied');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not retry a read after its signal is cancelled', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      controller.abort();
      return { status: 'error' as const, retryable: true, summary: 'interrupted', modelContent: 'interrupted' };
    });
    registerBoundaryTool({ effect: 'read', execute });
    await expect(executeBoundaryTool({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { mode: 'autonomous', policyMode: undefined, expectedModel: 'default-model', approvals: 0 },
    { mode: 'plan', policyMode: 'autonomous', expectedModel: 'default-model', approvals: 0 },
    { mode: 'collaborative', policyMode: undefined, expectedModel: 'chosen-model', approvals: 1 },
  ] as const)('prepares media using effective mode: $mode / $policyMode', async ({ mode, policyMode, expectedModel, approvals }) => {
    setBoundaryMode(mode);
    transitionAgentTask('mcp-task-1', 'planning');
    const execute = vi.fn(async () => ({ status: 'success' as const, summary: 'generated', modelContent: 'generated' }));
    registerAgentTool<{ kind: string; prompt: string; modelRef?: string }>({
      id: 'media_generate', title: 'Media test', description: 'Media test', effect: 'media_generation',
      inputSchema: {
        type: 'object', required: ['kind', 'prompt'], additionalProperties: false,
        properties: { kind: { type: 'string', enum: ['image'] }, prompt: { type: 'string' }, modelRef: { type: 'string' } },
      },
      resolveInput: (input) => ({ ...input, modelRef: input.modelRef ?? 'default-model' }),
      execute,
    });
    const waitForApproval = vi.fn(async () => ({ approved: true, inputValues: { modelRef: 'chosen-model' } }));
    const result = await executeRegisteredAgentToolCall({
      taskId: 'mcp-task-1',
      call: { callId: 'media-call', toolId: 'media_generate', input: { kind: 'image', prompt: 'a cat' } },
      signal: new AbortController().signal,
      policyMode,
      transitionTask: transitionAgentTask,
      waitForApproval,
    });
    expect(result.summary.status).toBe('success');
    expect(waitForApproval).toHaveBeenCalledTimes(approvals);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ mode: policyMode ?? mode }), expect.objectContaining({ modelRef: expectedModel }));
  });

  it('validates and executes a read tool with an audited step', async () => {
    const execute = vi.fn(async () => ({
      status: 'success' as const,
      summary: 'read complete',
      modelContent: 'read complete',
    }));
    registerAgentTool({
      id: 'mcp_read_test',
      title: 'Read test',
      description: 'Read test',
      effect: 'read',
      inputSchema: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: { query: { type: 'string', minLength: 1 } },
      },
      execute,
    });

    const task = await runAgentTask('mcp-task-1', async (signal) => {
      const result = await executeRegisteredAgentToolCall({
        taskId: 'mcp-task-1',
        call: { callId: 'call-1', toolId: 'mcp_read_test', input: { query: 'nodes' } },
        signal,
        transitionTask: transitionAgentTask,
        waitForApproval: waitForAgentApproval,
      });
      expect(result.summary.status).toBe('success');
      return 'completed';
    });

    expect(task.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(task.steps[0]).toMatchObject({
      kind: 'tool',
      status: 'succeeded',
      toolCall: { toolId: 'mcp_read_test', resultSummary: 'read complete' },
    });
  });

  it('persists sanitized structured input and result displays', async () => {
    registerAgentTool<{ query: string }>({
      id: 'mcp_display_test',
      title: 'Display test',
      description: 'Display test',
      effect: 'read',
      inputSchema: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: { query: { type: 'string', minLength: 1 } },
      },
      buildInputDisplay: (input) => ({
        fields: [{ label: '查询', value: input.query }],
      }),
      execute: async () => ({
        status: 'success',
        summary: 'read complete',
        modelContent: 'read complete',
        display: { fields: [{ label: '命中', value: 3 }] },
      }),
    });

    const task = await runAgentTask('mcp-task-1', async (signal) => {
      await executeRegisteredAgentToolCall({
        taskId: 'mcp-task-1',
        call: {
          callId: 'call-display',
          toolId: 'mcp_display_test',
          input: { query: 'C:\\Users\\tester\\secret.txt token-abcdefghijkl' },
        },
        signal,
        transitionTask: transitionAgentTask,
        waitForApproval: waitForAgentApproval,
      });
      return 'completed';
    });

    expect(task.steps[0].toolCall).toMatchObject({
      inputDisplay: {
        fields: [{ label: '查询', value: '[本地路径]' }],
      },
      resultDisplay: {
        fields: [{ label: '命中', value: 3 }],
      },
    });
  });

  it('executes a protected tool without approval in autonomous mode', async () => {
    const execute = vi.fn(async () => ({
      status: 'success' as const,
      summary: 'write complete',
      modelContent: 'write complete',
    }));
    registerAgentTool({
      id: 'mcp_write_test',
      title: 'Write test',
      description: 'Write test',
      effect: 'file_write',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      execute,
    });

    const task = await runAgentTask('mcp-task-1', async (signal) => {
      const result = await executeRegisteredAgentToolCall({
        taskId: 'mcp-task-1',
        call: { callId: 'call-2', toolId: 'mcp_write_test', input: {} },
        signal,
        transitionTask: transitionAgentTask,
        waitForApproval: waitForAgentApproval,
      });
      expect(result.summary.status).toBe('success');
      return 'completed';
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(task.steps[0]).toMatchObject({
      kind: 'tool',
      status: 'succeeded',
      toolCall: { effect: 'file_write' },
    });
    expect(task.steps[0].approval).toBeUndefined();
  });

  it('rejects invalid input before tool execution', async () => {
    const execute = vi.fn();
    registerAgentTool({
      id: 'mcp_schema_test',
      title: 'Schema test',
      description: 'Schema test',
      effect: 'read',
      inputSchema: {
        type: 'object',
        required: ['value'],
        additionalProperties: false,
        properties: { value: { type: 'string' } },
      },
      execute,
    });

    await runAgentTask('mcp-task-1', async (signal) => {
      const result = await executeRegisteredAgentToolCall({
        taskId: 'mcp-task-1',
        call: { callId: 'call-3', toolId: 'mcp_schema_test', input: {} },
        signal,
        transitionTask: transitionAgentTask,
        waitForApproval: waitForAgentApproval,
      });
      expect(result.summary.status).toBe('error');
      return 'failed';
    });

    expect(execute).not.toHaveBeenCalled();
  });
});
