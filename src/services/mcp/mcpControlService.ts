/**
 * MCP 前端控制层，将本地 bridge 请求映射到受 Policy 约束的 Agent 工具和专用审计任务。
 */
import { useAppStore } from '../../store/useAppStore';
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
const MCP_EXECUTION_MODE = 'autonomous' as const;

/**
 * 工具发现时没有真实 AgentTask，只能给一个占位 ID。
 *
 * 因此工具的 isAvailable 不得依赖 context.taskId 去查任务：发现阶段查不到任务，
 * 会让该工具从 MCP 列表里静默消失。需要任务上下文的判断请放在 authorize 里。
 */
export const MCP_TOOL_DISCOVERY_TASK_ID = 'mcp-tool-discovery';

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
): ChatConversation {
  const store = useAppStore.getState();
  const id = `mcp-control-${projectId}`;
  const existing = store.conversations.find((conversation) => conversation.id === id);
  if (existing) {
    if (existing.archived || existing.deletedAt || existing.agentMode !== MCP_EXECUTION_MODE) {
      const updated = {
        archived: false,
        deletedAt: undefined,
        agentMode: MCP_EXECUTION_MODE,
      };
      store.updateConversation(id, updated);
      return { ...existing, ...updated };
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
    agentMode: MCP_EXECUTION_MODE,
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
    taskId: MCP_TOOL_DISCOVERY_TASK_ID,
    projectId: current.projectId,
    conversationId: current.conversation.id,
    mode: MCP_EXECUTION_MODE,
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
    mode: MCP_EXECUTION_MODE,
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
        policyMode: MCP_EXECUTION_MODE,
      });
      return executionResult.summary.status === 'success' ? 'completed' : 'failed';
    });
    const summary = executionResult?.summary.summary
      ?? finalTask.errorMessage
      ?? 'MCP 工具调用未返回结果';
    const isError = executionResult?.summary.status !== 'success';
    // 工具业务失败仍是一次成功送达的结构化 MCP 响应：任务和步骤保留 failed，
    // 但审计消息不应再误报为网络/模型“响应失败”。只有执行链没有产出结果时才标 error。
    const responseReceived = executionResult !== undefined;
    useAppStore.getState().updateAgentTask(task.id, { resultSummary: summary });
    useAppStore.getState().updateMessage(assistantMessageId, {
      content: summary,
      status: responseReceived ? 'done' : 'error',
    });
    return {
      isError,
      summary,
      content: executionResult?.mcpContent?.length
        ? executionResult.mcpContent
        : [{
            type: 'text',
            text: executionResult?.modelContent ?? summary,
          }],
    };
  } finally {
    activeRequestTasks.delete(request.requestId);
  }
}

function cancelMcpRequest(request: McpBridgeRequestEvent): { cancelled: boolean } {
  // bridge 已把目标 ID 换成同一连接内的请求键，这里按键直接取消。
  const target = typeof request.params.requestId === 'string'
    ? request.params.requestId
    : '';
  const taskId = activeRequestTasks.get(target);
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
