/** 外部 MCP SDK 只在主窗口运行；原生代理限定端点、凭据、体积与生命周期。 */
import { invoke } from '@tauri-apps/api/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { useAppStore } from '../../store/useAppStore';
import { seriesOwnerId } from '../../store/store.utils';
import { isGeneralAssistantScope } from '../chat/assistantScope';
import type { McpClientConnection, McpClientOption, McpClientToolInfo } from '../../types/mcpClient';
import { deleteAppSecret, writeAppSecret } from '../providerSecretService';
import { areSettingsMutationsFrozen, registerSettingsProducer } from '../configPersistenceQueue';

const entries = new Map<string, { config: string; abort: AbortController; client: Client; ready: Promise<Client> }>();
const calls = new Map<AbortController, { projectId: string; conversationId: string; serverId: string; selectionRevision: string }>();
const connectionMutations = new Map<string, Promise<void>>();
const pendingConnectionMutations = new Set<Promise<void>>();
let subscribed = false;
let configKey = '';
let nativeSync: Promise<unknown> = Promise.resolve();
let unsubscribe: (() => void) | undefined;
let unregisterSettingsProducer: (() => void) | undefined;

if (import.meta.hot) import.meta.hot.dispose(() => {
  unsubscribe?.();
  unregisterSettingsProducer?.();
  for (const entry of entries.values()) {
    entry.abort.abort();
    void entry.client.close().catch(() => undefined);
  }
  for (const abort of calls.keys()) abort.abort();
  entries.clear();
  calls.clear();
});

export function validateMcpClientUrl(value: string): string {
  const url = new URL(value.trim());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (value.length > 2048 || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))
    || url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    throw new Error('仅支持 HTTPS 或本机 HTTP，地址不能包含凭据、查询参数或片段');
  }
  return url.href;
}

export function getMcpClientOptions(connections = useAppStore.getState().config.mcpClientConnections ?? []): McpClientOption[] {
  return connections.filter((item) => item.enabled).map((item) => ({ id: item.id, name: item.name, toolCount: Object.keys(item.tools).length }));
}

function connection(id: string): McpClientConnection {
  const item = useAppStore.getState().config.mcpClientConnections?.find((candidate) => candidate.id === id && candidate.enabled);
  if (!item) throw new Error('MCP 连接已停用或删除');
  return item;
}

export function selectedMcpConnection(context: { projectId: string; conversationId: string }, serverId: string): McpClientConnection | undefined {
  const state = useAppStore.getState();
  if (!isGeneralAssistantScope(context.projectId) && state.currentProjectId !== context.projectId) return;
  const conversation = state.conversations.find((item) => item.id === context.conversationId && !item.deletedAt);
  if (!conversation || !conversation.id.startsWith('conv-') || conversation.projectId !== seriesOwnerId(state.projects, context.projectId)
    || !conversation.mcpServerIds?.includes(serverId)) return;
  return state.config.mcpClientConnections?.find((item) => item.id === serverId && item.enabled);
}

export function getMcpSelectionRevision(conversationId: string): string {
  return useAppStore.getState().conversations.find((item) => item.id === conversationId)?.mcpSelectionRevision ?? 'legacy';
}

async function synchronize(): Promise<unknown> {
  const connections = useAppStore.getState().config.mcpClientConnections ?? [];
  const key = JSON.stringify(connections);
  if (key === configKey) return nativeSync;
  for (const [id, entry] of entries) {
    if (!connections.some((item) => item.id === id && item.enabled && JSON.stringify(item) === entry.config)) {
      entry.abort.abort();
      void entry.client.close().catch(() => undefined);
      entries.delete(id);
    }
  }
  const projected = connections.filter((item) => item.enabled).map((item) => ({
    id: item.id, revision: item.revision, url: validateMcpClientUrl(item.url), authHeader: item.authHeader,
    hasSecret: item.hasSecret, toolNames: Object.keys(item.tools),
  }));
  configKey = key;
  nativeSync = nativeSync.catch(() => undefined).then(() => invoke('mcp_client_configure', { connections: projected })).catch((error: unknown) => {
    if (configKey === key) configKey = '';
    throw error;
  });
  return nativeSync;
}

function initialize(): void {
  if (subscribed) return;
  subscribed = true;
  unregisterSettingsProducer = registerSettingsProducer(drainConnectionMutations);
  unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.config.mcpClientConnections !== previous.config.mcpClientConnections) {
      void synchronize().catch(() => { configKey = ''; });
    }
    for (const [abort, call] of calls) {
      if (!selectedMcpConnection(call, call.serverId) || getMcpSelectionRevision(call.conversationId) !== call.selectionRevision) abort.abort();
    }
  });
}

interface NativeHttpResponse { status: number; headers: Record<string, string>; body: string }

class McpSessionExpiredError extends Error {
  constructor() { super('MCP 会话已失效，后续操作将重新连接；已提交的操作请先核实远端状态'); }
}

function closeExpiredClient(serverId: string, client: Client): void {
  const entry = entries.get(serverId);
  if (entry?.client !== client) return;
  entries.delete(serverId);
  entry.abort.abort();
  void client.close().catch(() => undefined);
}

async function getClient(item: McpClientConnection, signal?: AbortSignal): Promise<Client> {
  initialize();
  if (signal?.aborted) throw new DOMException('MCP 请求已取消', 'AbortError');
  await synchronize();
  if (signal?.aborted) throw new DOMException('MCP 请求已取消', 'AbortError');
  if (connection(item.id).revision !== item.revision) throw new Error('MCP 配置已改变，请重新发现工具');
  const existing = entries.get(item.id);
  if (existing?.config === JSON.stringify(item) && !existing.abort.signal.aborted) return existing.ready;
  const abort = new AbortController();
  // 使用 SDK 的 Zod 协议校验，不编译远端 outputSchema，兼容桌面严格 CSP。
  const client = new Client({ name: 'ai-canvas-assistant', version: '1.0.0' }, {
    capabilities: {}, jsonSchemaValidator: { getValidator: () => { throw new Error('外部 schema 仅作为不可信数据使用'); } },
  });
  // 不记录 SDK 原始异常，避免地址、认证挑战或远端正文进入控制台。
  client.onerror = () => undefined;
  const rpcRequests = new Map<string, string>();
  const cancelledRpcs = new Set<string>();
  const transport = new StreamableHTTPClientTransport(new URL(item.url), {
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== item.url || abort.signal.aborted || request.signal.aborted) throw new Error('MCP 连接已变更或取消');
      const requestId = crypto.randomUUID();
      const cancel = () => { void invoke('mcp_client_cancel', { requestId }).catch(() => undefined); };
      abort.signal.addEventListener('abort', cancel, { once: true });
      request.signal.addEventListener('abort', cancel, { once: true });
      let rpcKey: string | undefined;
      try {
        const body = await request.text();
        if (abort.signal.aborted || request.signal.aborted) throw new Error('MCP 请求已取消');
        if (body) {
          const message = JSON.parse(body) as { id?: string | number; method?: string; params?: { requestId?: string | number } };
          if (message.method === 'notifications/cancelled' && message.params?.requestId !== undefined) {
            const key = JSON.stringify(message.params.requestId);
            if (cancelledRpcs.size >= 256) cancelledRpcs.delete(cancelledRpcs.values().next().value!);
            cancelledRpcs.add(key);
            const id = rpcRequests.get(key);
            if (id) void invoke('mcp_client_cancel', { requestId: id }).catch(() => undefined);
          }
          if (message.id !== undefined) {
            rpcKey = JSON.stringify(message.id);
            if (cancelledRpcs.has(rpcKey)) throw new Error('MCP 请求已取消');
            rpcRequests.set(rpcKey, requestId);
          }
        }
        const headers: Record<string, string> = {};
        request.headers.forEach((value, name) => { headers[name] = value; });
        const result = await invoke<NativeHttpResponse>('mcp_client_fetch', {
          connectionId: item.id, revision: item.revision, requestId,
          method: request.method, headers, body,
        });
        if (abort.signal.aborted || request.signal.aborted) throw new Error('MCP 请求已取消');
        if (result.status === 404 && request.headers.get('mcp-session-id')) throw new McpSessionExpiredError();
        return new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status, headers: result.headers });
      } finally {
        if (rpcKey) { rpcRequests.delete(rpcKey); cancelledRpcs.delete(rpcKey); }
        abort.signal.removeEventListener('abort', cancel);
        request.signal.removeEventListener('abort', cancel);
      }
    },
  });
  const ready = client.connect(transport, { timeout: 30_000 }).then(() => client).catch((error: unknown) => {
    if (entries.get(item.id)?.client === client) entries.delete(item.id);
    abort.abort();
    void client.close().catch(() => undefined);
    if (error instanceof McpSessionExpiredError) throw error;
    throw new Error('连接 MCP 失败，请检查地址、认证及服务是否支持 Streamable HTTP');
  });
  entries.set(item.id, { config: JSON.stringify(item), abort, client, ready });
  return ready;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

export async function fingerprintMcpTool(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value))));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 每次调用前刷新目录；不把服务 instructions 注入系统提示词。 */
export async function discoverMcpTools(serverId: string, signal?: AbortSignal): Promise<McpClientToolInfo[]> {
  const item = connection(serverId);
  try {
    return await discoverMcpToolsOnce(item, signal);
  } catch (error) {
    if (!(error instanceof McpSessionExpiredError) || signal?.aborted || connection(serverId).revision !== item.revision) throw error;
    // 只重建会话并重读一次目录，工具执行请求绝不在这里重投。
    return discoverMcpToolsOnce(item, signal);
  }
}

async function discoverMcpToolsOnce(item: McpClientConnection, signal?: AbortSignal): Promise<McpClientToolInfo[]> {
  const client = await getClient(item, signal);
  try {
    const tools: McpClientToolInfo[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.request({ method: 'tools/list', params: cursor ? { cursor } : {} }, ListToolsResultSchema, { signal, timeout: 30_000 });
      for (const tool of page.tools) {
        if (tool.execution?.taskSupport === 'required') continue; // 首期仅同步工具，不接 MCP 后台任务。
        if (tools.length >= 256 || tools.some((existing) => existing.name === tool.name)) throw new Error('MCP 工具目录过大或名称重复');
        const identity = { name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema, annotations: tool.annotations, outputSchema: tool.outputSchema, execution: tool.execution };
        if (new TextEncoder().encode(JSON.stringify(identity)).length > 32_768) throw new Error('MCP 单个工具定义超过 32 KiB');
        tools.push({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema,
          fingerprint: await fingerprintMcpTool(identity), readOnlyHint: tool.annotations?.readOnlyHint === true });
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('MCP 目录分页游标重复');
      if (cursor) cursors.add(cursor);
      if (cursors.size > 32) throw new Error('MCP 目录分页过多');
    } while (cursor);
    if (connection(item.id).revision !== item.revision) throw new Error('MCP 配置已变更');
    return tools;
  } catch (error) {
    // 等本次 RPC 已 reject 再 close，避免 SDK 的 ConnectionClosed 抢先覆盖失效原因。
    if (error instanceof McpSessionExpiredError) closeExpiredClient(item.id, client);
    throw error;
  }
}

/** 工具 Observation 沿用文本预算，剥离常见凭据、绝对路径及媒体大正文。 */
export function sanitizeMcpText(value: string, limit = 20_000): string {
  return value.replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, '[已脱敏密钥]')
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '[已脱敏凭据]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[已脱敏凭据]')
    .replace(/data:[^\s"']+;base64,[A-Za-z0-9+/=]+/gi, '[媒体正文省略]')
    .replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, '[本地路径]')
    .replace(/\\\\[^\s"'<>]+/g, '[本地路径]')
    .replace(/\/(?:Users|home)\/[^\s"'<>]+/g, '[本地路径]').slice(0, limit);
}

/** 保留 JSON Schema 的结构和字段名，只清理字符串资料，不把 JSON 截成无效片段。 */
export function sanitizeMcpValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeMcpText(value, 16_000);
  if (Array.isArray(value)) return value.map(sanitizeMcpValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeMcpValue(child)]));
  return value;
}

/** 用字符串承载动态工具参数，兼容不接受开放 object schema 的模型协议。 */
export function parseMcpToolArguments(value: string): Record<string, unknown> {
  if (new TextEncoder().encode(value).length > 65_536) throw new Error('MCP 工具参数超过 64 KiB');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('MCP 工具参数必须是有效的 JSON 对象字符串'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP 工具参数必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}

export async function callExternalMcp(
  context: { projectId: string; conversationId: string; signal: AbortSignal },
  input: { serverId: string; toolName: string; arguments: Record<string, unknown>; revision?: string; fingerprint?: string; selectionRevision?: string },
  access: 'read' | 'write',
): Promise<{ isError: boolean; text: string; truncated: boolean }> {
  const assertAuthorized = () => {
    const item = selectedMcpConnection(context, input.serverId);
    const grant = item?.tools[input.toolName];
    if (!item || item.revision !== input.revision || grant?.access !== access || grant.fingerprint !== input.fingerprint
      || getMcpSelectionRevision(context.conversationId) !== input.selectionRevision || context.signal.aborted) {
      throw new Error('MCP 连接、工具授权或会话选择已变化，请重新发现工具');
    }
    return item;
  };
  const item = assertAuthorized();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  context.signal.addEventListener('abort', cancel, { once: true });
  calls.set(abort, { projectId: context.projectId, conversationId: context.conversationId, serverId: item.id, selectionRevision: getMcpSelectionRevision(context.conversationId) });
  try {
    const tools = await discoverMcpTools(item.id, abort.signal);
    const tool = tools.find((candidate) => candidate.name === input.toolName);
    if (!tool || tool.fingerprint !== input.fingerprint) throw new Error('MCP 工具定义已变更，请在设置中重新授权');
    assertAuthorized();
    const client = await getClient(item, abort.signal);
    assertAuthorized();
    const result = await client.request({ method: 'tools/call', params: { name: input.toolName, arguments: input.arguments } }, CallToolResultSchema, { signal: abort.signal, timeout: 65_000 }).catch((error: unknown) => {
      if (error instanceof McpSessionExpiredError) closeExpiredClient(item.id, client);
      throw error;
    });
    assertAuthorized();
    if (abort.signal.aborted) throw new Error('MCP 请求已取消');
    // 仅把文本/结构化结果交给模型，外部图片和资源链接不会自动读取或持久化。
    const blocks = result.content.filter((block) => block.type === 'text').map((block) => block.text as string);
    if (result.structuredContent) blocks.push(JSON.stringify(result.structuredContent));
    const raw = blocks.join('\n') || '服务已返回，无文本内容';
    return { isError: result.isError === true, text: sanitizeMcpText(raw), truncated: raw.length > 20_000 };
  } finally {
    calls.delete(abort);
    context.signal.removeEventListener('abort', cancel);
  }
}

/** 不复用配置持久化锁：saveConfig 会自行入队，嵌套等待会死锁。 */
function mutateConnection(id: string, operation: () => Promise<void>): Promise<void> {
  initialize();
  const result = (connectionMutations.get(id) ?? Promise.resolve()).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  connectionMutations.set(id, settled);
  pendingConnectionMutations.add(result);
  void settled.then(() => {
    pendingConnectionMutations.delete(result);
    if (connectionMutations.get(id) === settled) connectionMutations.delete(id);
  });
  return result;
}

/** 应用退出必须等完整凭据/连接操作收尾，不能只等待 saveConfig 后提前冻结停用 Action。 */
async function drainConnectionMutations(): Promise<void> {
  let failed = false;
  while (pendingConnectionMutations.size) {
    const results = await Promise.allSettled([...pendingConnectionMutations]);
    if (results.some((result) => result.status === 'rejected')) failed = true;
  }
  if (failed) throw new Error('MCP 连接修改失败，请检查连接后再退出');
}

/** 由设置 UI 调用；明文 token 只作为短暂参数交给凭据存储。 */
export function saveMcpClientConnection(item: McpClientConnection, token?: string, clearToken = false): Promise<void> {
  const existed = useAppStore.getState().config.mcpClientConnections?.some((candidate) => candidate.id === item.id);
  return mutateConnection(item.id, async () => {
    if (areSettingsMutationsFrozen()) throw new Error('设置正在保存或恢复，请稍后重试');
    initialize();
    const state = useAppStore.getState();
    const previous = state.config.mcpClientConnections ?? [];
    if (previous.length >= 16 && !previous.some((candidate) => candidate.id === item.id)) throw new Error('最多配置 16 个 MCP 连接');
    const url = validateMcpClientUrl(item.url);
    if (!item.name.trim() || item.name.length > 80) throw new Error('连接名称需为 1–80 个字符');
    const old = previous.find((candidate) => candidate.id === item.id);
    if ((old && old.revision !== item.revision) || (!old && existed)) throw new Error('连接已被其他设置操作修改，请重新打开');
    const entry = entries.get(item.id);
    if (entry) { entry.abort.abort(); entries.delete(item.id); void entry.client.close().catch(() => undefined); }
    const credentialChanged = !!token?.trim() || clearToken;
    let revision = old?.revision;
    let saved = false;
    try {
      if (credentialChanged) {
        // 先持久化停用，再改固定凭据条目；崩溃或后续保存失败都不能让旧端点拿到新令牌。
        const disabled = { ...item, url, name: item.name.trim(), enabled: false, revision: crypto.randomUUID(), hasSecret: false, tools: {} };
        revision = disabled.revision;
        state.updateConfig({ mcpClientConnections: old ? previous.map((candidate) => candidate.id === item.id ? disabled : candidate) : [...previous, disabled] });
        await state.saveConfig({ throwOnError: true });
        await synchronize();
        if (areSettingsMutationsFrozen() || useAppStore.getState().config.mcpClientConnections?.find((candidate) => candidate.id === item.id)?.revision !== revision) {
          throw new Error('连接已变化或设置正在关闭，请重新打开设置');
        }
        if (token?.trim() && !await writeAppSecret(`mcp-client/${item.id}`, token.trim())) throw new Error('MCP 凭据保存失败，连接保持停用');
        if (clearToken && !await deleteAppSecret(`mcp-client/${item.id}`)) throw new Error('MCP 凭据清除失败，连接保持停用');
      }
      const targetChanged = !old || old.url !== url || old.authHeader !== item.authHeader || credentialChanged;
      const updated = { ...item, url, name: item.name.trim(), revision: crypto.randomUUID(), hasSecret: clearToken ? false : !!token?.trim() || item.hasSecret, tools: targetChanged ? {} : item.tools };
      const latest = useAppStore.getState();
      const connections = latest.config.mcpClientConnections ?? [];
      if (areSettingsMutationsFrozen() || connections.find((candidate) => candidate.id === item.id)?.revision !== revision) throw new Error('连接已变化，请重新打开设置');
      revision = updated.revision;
      latest.updateConfig({ mcpClientConnections: connections.some((candidate) => candidate.id === item.id) ? connections.map((candidate) => candidate.id === item.id ? updated : candidate) : [...connections, updated] });
      await latest.saveConfig({ throwOnError: true });
      await synchronize();
      saved = true;
    } finally {
      if (credentialChanged && !saved) {
        const latest = useAppStore.getState();
        const current = latest.config.mcpClientConnections?.find((candidate) => candidate.id === item.id);
        if (current?.revision === revision && current.enabled) {
          latest.updateConfig({ mcpClientConnections: latest.config.mcpClientConnections!.map((candidate) => candidate.id === item.id ? { ...candidate, enabled: false, revision: crypto.randomUUID() } : candidate) });
          await synchronize().catch(() => undefined);
        }
      }
    }
  });
}

export function removeMcpClientConnection(id: string): Promise<void> {
  const revision = useAppStore.getState().config.mcpClientConnections?.find((item) => item.id === id)?.revision;
  return mutateConnection(id, async () => {
    if (areSettingsMutationsFrozen()) throw new Error('设置正在保存或恢复，请稍后重试');
    initialize();
    const state = useAppStore.getState();
    if (state.config.mcpClientConnections?.find((item) => item.id === id)?.revision !== revision) throw new Error('连接已变化，请重新打开设置');
    state.updateConfig({ mcpClientConnections: state.config.mcpClientConnections?.map((item) => item.id === id ? { ...item, enabled: false, revision: crypto.randomUUID() } : item) ?? [] });
    await state.saveConfig({ throwOnError: true });
    await synchronize();
    if (!await deleteAppSecret(`mcp-client/${id}`)) throw new Error('连接已停用，凭据清理失败，请再次点击移除');
    const latest = useAppStore.getState();
    latest.updateConfig({ mcpClientConnections: latest.config.mcpClientConnections?.filter((item) => item.id !== id) ?? [] });
    await latest.saveConfig({ throwOnError: true });
    await synchronize();
  });
}
