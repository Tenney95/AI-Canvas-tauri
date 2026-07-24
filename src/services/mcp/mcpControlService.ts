import { useAppStore } from '../../store/useAppStore';
import type { AgentMode } from '../../types/agent';
import type { ChatConversation, ChatMessage } from '../../types/chat';
import type {
  McpBridgeRequestEvent,
  McpToolCallResult,
  McpToolDescriptor,
} from '../../types/mcp';
import {
  runAgentTask,
  stopAgentTask,
  transitionAgentTask,
  waitForAgentApproval,
} from '../chat/agentTaskControl';
import {
  getAgentTool,
  getAvailableAgentTools,
} from '../chat/toolRegistry';
import {
  listenForMcpBridgeRequests,
  respondToMcpBridge,
} from './mcpBridgeService';

const MCP_CONVERSATION_TITLE = 'MCP 控制';
const activeRequestTasks = new Map<string, string>();

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeAuditSummary(value: string): string {
  return value
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, '[已脱敏密钥]')
    .replace(/\b(?:api[_-]?key|authorization|token)\s*[:=]\s*\S+/gi, '[已脱敏凭据]')
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/g, '[本地路径]')
    .replace(/\/(?:Users|home)\/[^\s"'`]+/g, '[本地路径]')
    .slice(0, 500);
}

async function ensureToolsRegistered(): Promise<void> {
  const { ensureAgentToolsRegistered } = await import('../chat/tools');
  ensureAgentToolsRegistered();
}

export function ensureMcpControlConversation(
  projectId: string,
  defaultMode: AgentMode = 'autonomous',
): ChatConversation {
  const store = useAppStore.getState();
  const id = `mcp-control-${projectId}`;
  const existing = store.conversations.find((conversation) => conversation.id === id);
  if (existing) {
    if (existing.archived || existing.deletedAt) {
      store.updateConversation(id, { archived: false, deletedAt: undefined });
      return { ...existing, archived: false, deletedAt: undefined };
    }
    return existing;
  }
  const now = Date.now();
  const conversation: ChatConversation = {
    id,
    projectId,
    title: MCP_CONVERSATION_TITLE,
    titleSource: 'user',
    pinned: true,
    archived: false,
    agentMode: defaultMode,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };
  store.addConversation(conversation);
  return conversation;
}

function getCurrentMcpContext(): {
  projectId: string;
  conversation: ChatConversation;
} | null {
  const projectId = useAppStore.getState().currentProjectId;
  if (!projectId) return null;
  return {
    projectId,
    conversation: ensureMcpControlConversation(projectId),
  };
}

export async function listMcpTools(): Promise<McpToolDescriptor[]> {
  await ensureToolsRegistered();
  const current = getCurrentMcpContext();
  if (!current) return [];
  return getAvailableAgentTools({
    taskId: 'mcp-tool-discovery',
    projectId: current.projectId,
    conversationId: current.conversation.id,
    mode: current.conversation.agentMode,
    baseRevision: useAppStore.getState().getCurrentRevision(),
  }).map((definition) => ({
    name: definition.id,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
  }));
}

function addAuditMessage(message: ChatMessage): void {
  useAppStore.getState().addMessage(message);
}

async function callMcpTool(
  request: McpBridgeRequestEvent,
): Promise<McpToolCallResult> {
  await ensureToolsRegistered();
  const current = getCurrentMcpContext();
  if (!current) {
    return {
      isError: true,
      summary: '当前没有已加载项目，无法调用 AI Canvas 工具',
      content: [{ type: 'text', text: '当前没有已加载项目，无法调用 AI Canvas 工具' }],
    };
  }
  const name = typeof request.params.name === 'string' ? request.params.name : '';
  const input = request.params.arguments && typeof request.params.arguments === 'object'
    ? request.params.arguments
    : {};
  const definition = getAgentTool(name);
  const title = (definition?.title ?? name) || '未知工具';
  let inputSummary = '参数将在本地 schema 校验';
  if (definition?.summarizeInput) {
    try {
      inputSummary = definition.summarizeInput(input);
    } catch {
      inputSummary = '参数摘要生成失败，将由本地 schema 校验';
    }
  }
  inputSummary = sanitizeAuditSummary(inputSummary);

  const store = useAppStore.getState();
  const now = Date.now();
  const userMessageId = createId('mcp-user');
  const assistantMessageId = createId('mcp-assistant');
  addAuditMessage({
    id: userMessageId,
    conversationId: current.conversation.id,
    role: 'user',
    content: `MCP 请求：${title}\n${inputSummary}`,
    timestamp: now,
    status: 'done',
  });
  const task = store.createAgentTask({
    projectId: current.projectId,
    conversationId: current.conversation.id,
    userMessageId,
    mode: current.conversation.agentMode,
    goal: `MCP 请求：${title}。${inputSummary}`,
    budget: {
      maxModelRounds: 1,
      maxToolCalls: 1,
      maxParallelReadTools: 1,
    },
  });
  addAuditMessage({
    id: assistantMessageId,
    conversationId: current.conversation.id,
    role: 'assistant',
    content: `正在执行 MCP 工具“${title}”。`,
    timestamp: now + 1,
    status: 'executing',
    agentTaskId: task.id,
  });
  activeRequestTasks.set(request.requestId, task.id);

  let executionResult: Awaited<ReturnType<
    typeof import('../chat/agentToolExecution')['executeRegisteredAgentToolCall']
  >> | undefined;
  try {
    const finalTask = await runAgentTask(task.id, async (signal) => {
      const { executeRegisteredAgentToolCall } = await import('../chat/agentToolExecution');
      executionResult = await executeRegisteredAgentToolCall({
        taskId: task.id,
        call: {
          callId: request.requestId,
          toolId: name,
          input,
        },
        signal,
        transitionTask: transitionAgentTask,
        waitForApproval: waitForAgentApproval,
        onApprovalRequired: () => {
          const currentStore = useAppStore.getState();
          currentStore.setActiveConversation(current.conversation.id);
          currentStore.openChat();
        },
      });
      return executionResult.summary.status === 'success' ? 'completed' : 'failed';
    });
    const summary = executionResult?.summary.summary
      ?? finalTask.errorMessage
      ?? 'MCP 工具调用未返回结果';
    const isError = executionResult?.summary.status !== 'success';
    useAppStore.getState().updateAgentTask(task.id, { resultSummary: summary });
    useAppStore.getState().updateMessage(assistantMessageId, {
      content: summary,
      status: isError ? 'error' : 'done',
    });
    return {
      isError,
      summary,
      content: [{
        type: 'text',
        text: executionResult?.modelContent ?? summary,
      }],
    };
  } finally {
    activeRequestTasks.delete(request.requestId);
  }
}

function cancelMcpRequest(request: McpBridgeRequestEvent): { cancelled: boolean } {
  const target = typeof request.params.requestId === 'string'
    ? request.params.requestId
    : '';
  const fullRequestId = `${request.sessionId}:${target}`;
  const taskId = activeRequestTasks.get(fullRequestId) ?? activeRequestTasks.get(target);
  if (!taskId) return { cancelled: false };
  try {
    stopAgentTask(taskId);
    return { cancelled: true };
  } catch {
    return { cancelled: false };
  }
}

export async function handleMcpBridgeRequest(
  request: McpBridgeRequestEvent,
): Promise<unknown> {
  switch (request.method) {
    case 'tools/list':
      return { tools: await listMcpTools() };
    case 'tools/call':
      return callMcpTool(request);
    case 'requests/cancel':
      return cancelMcpRequest(request);
    default:
      throw new Error('不支持的 MCP bridge 方法');
  }
}

export async function initMcpControlService(): Promise<() => void> {
  const unlisten = await listenForMcpBridgeRequests(async (request) => {
    try {
      const result = await handleMcpBridgeRequest(request);
      await respondToMcpBridge({
        sessionId: request.sessionId,
        requestId: request.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      await respondToMcpBridge({
        sessionId: request.sessionId,
        requestId: request.requestId,
        ok: false,
        error: sanitizeAuditSummary(
          error instanceof Error ? error.message : 'AI Canvas MCP 请求失败',
        ),
      }).catch(() => {});
    }
  });
  return () => {
    unlisten();
    for (const taskId of activeRequestTasks.values()) {
      try {
        stopAgentTask(taskId);
      } catch {
        // 任务可能已经结束。
      }
    }
    activeRequestTasks.clear();
  };
}
