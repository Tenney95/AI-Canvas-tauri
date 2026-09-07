/**
 * MCP bridge、工具描述和调用结果的跨前后端协议类型。
 */
import type { AgentToolSchema } from '../services/chat/agentToolSchemas';
import type { AgentToolEffect } from '../services/chat/toolRegistry';

export type McpTransport = 'stdio' | 'streamable-http';
export type McpToolExposure = 'compact' | 'full';

export interface McpToolSearchInput {
  query?: string;
  category?: string;
  limit?: number;
  detail?: 'summary' | 'schema';
}

export interface McpToolDescribeInput {
  names: string[];
}

export interface McpToolCallEnvelope {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpToolCatalogEntry {
  name: string;
  title: string;
  description: string;
  category: string;
  effect: AgentToolEffect;
  inputSchema?: AgentToolSchema;
}

export interface McpToolCatalogResult {
  tools: McpToolCatalogEntry[];
  total: number;
  categories?: Array<{ id: string; title: string; count: number }>;
  hint?: string;
}

export interface McpBridgeSessionInfo {
  sessionId: string;
  port: number;
  transport: McpTransport;
  bindAddress: '127.0.0.1' | '0.0.0.0';
  endpointPath?: '/mcp';
  adapterPath?: string;
}

export interface McpBridgeRequestEvent {
  sessionId: string;
  requestId: string;
  method: 'tools/list' | 'tools/call' | 'requests/cancel';
  params: Record<string, unknown>;
}

export interface McpBridgeResponseInput {
  sessionId: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema: AgentToolSchema;
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' };

export interface McpToolCallResult {
  isError: boolean;
  summary: string;
  content: McpContent[];
}
