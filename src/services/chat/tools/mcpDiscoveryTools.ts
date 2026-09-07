/** MCP 专用的只读发现能力，业务执行仍由 MCP 控制层分发至真实 Registry 工具。 */
import { useAppStore } from '../../../store/useAppStore';
import type { McpToolDescribeInput, McpToolSearchInput } from '../../../types/mcp';
import {
  describeMcpToolCatalog,
  MCP_DESCRIBE_SCHEMA,
  MCP_SEARCH_SCHEMA,
  searchMcpToolCatalog,
  serializeMcpCatalogResult,
} from '../../mcp/mcpToolCatalog';
import { registerAgentTool, type AgentToolContext, type AgentToolExecutionResult } from '../toolRegistry';

function isMcpContext(context: Omit<AgentToolContext, 'signal'>): boolean {
  return !!context.projectId && context.conversationId === `mcp-control-${context.projectId}`;
}

function authorize(context: Omit<AgentToolContext, 'signal'>) {
  return {
    allowed: isMcpContext(context) && useAppStore.getState().currentProjectId === context.projectId,
    reason: '工具发现仅允许当前项目的 MCP 控制会话调用',
  };
}

function readCatalog(
  context: AgentToolContext,
  read: () => ReturnType<typeof searchMcpToolCatalog>,
): AgentToolExecutionResult {
  if (context.signal.aborted || !authorize(context).allowed) {
    return { status: 'error', summary: '工具发现上下文已失效', modelContent: '请重新搜索当前项目的工具', errorCode: 'MCP_CATALOG_CONTEXT_CHANGED' };
  }
  try {
    const result = read();
    const text = serializeMcpCatalogResult(result);
    const summary = `已返回 ${result.tools.length} 个工具定义${result.categories ? '及类别导航' : ''}`;
    return {
      status: 'success', summary, modelContent: summary,
      // 使用既有瞬时 MCP 内容通道，避免通用 20,000 字符裁剪切断 JSON Schema。
      // 完整定义受独立字节预算约束，不进入消息或任务持久化。
      mcpContent: [{ type: 'text', text }],
    };
  } catch (error) {
    const summary = error instanceof Error ? error.message : '无法读取工具目录';
    return { status: 'error', summary, modelContent: summary, errorCode: 'MCP_CATALOG_INVALID_REQUEST' };
  }
}

export function registerMcpDiscoveryTools(): Array<() => void> {
  const common = { effect: 'read' as const, isAvailable: isMcpContext, authorize };
  return [
    registerAgentTool<McpToolSearchInput>({
      id: 'tools_search', title: '搜索 AI Canvas 工具',
      description: '按中文需求、英文工具名或类别查找当前可用能力。默认返回最多 5 个摘要；detail=schema 同时获取完整参数，然后用 tools_call 执行。空参数仅返回类别导航。已知工具可直接复用，无需反复搜索。',
      inputSchema: MCP_SEARCH_SCHEMA, ...common,
      summarizeInput: () => '检索当前可用工具',
      execute: async (context, input) => readCatalog(context, () => searchMcpToolCatalog(context, input)),
    }),
    registerAgentTool<McpToolDescribeInput>({
      id: 'tools_describe', title: '读取 AI Canvas 工具参数',
      description: '读取 1 至 3 个已知工具的完整说明、权限类别和参数 schema；随后用 tools_call 提交一次调用。若 tools_search 已用 detail=schema 返回参数，无需重复读取。',
      inputSchema: MCP_DESCRIBE_SCHEMA, ...common,
      summarizeInput: () => '读取指定工具的参数定义',
      execute: async (context, input) => readCatalog(context, () => describeMcpToolCatalog(context, input)),
    }),
  ];
}
