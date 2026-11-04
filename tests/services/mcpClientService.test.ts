/**
 * mcpClientService — 回归测试：external MCP client boundaries。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import type { McpClientConnection } from '../../src/types/mcpClient';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../src/services/chat/assistantScope';
import { areSettingsMutationsFrozen, prepareSettingsClose, resumeSettingsPersistence } from '../../src/services/configPersistenceQueue';

const sdk = vi.hoisted(() => ({
  request: vi.fn(), connect: vi.fn(), close: vi.fn(),
  fetches: new Map<object, typeof fetch>(),
  pending: new Map<object, (error: Error) => void>(),
}));
const secrets = vi.hoisted(() => ({ write: vi.fn(async () => true), remove: vi.fn(async () => true) }));
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({ ...await importOriginal<typeof import('@tauri-apps/api/core')>(), invoke: native.invoke }));
vi.mock('../../src/services/providerSecretService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/providerSecretService')>(),
  writeAppSecret: secrets.write, deleteAppSecret: secrets.remove,
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  request = sdk.request;
  connect = sdk.connect;
  close = sdk.close;
} }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {
  fetch: typeof fetch;
  constructor(_url: URL, options: { fetch: typeof fetch }) { this.fetch = options.fetch; }
} }));

import { callExternalMcp, discoverMcpTools, fingerprintMcpTool, getMcpClientOptions, parseMcpToolArguments, removeMcpClientConnection, sanitizeMcpValue, saveMcpClientConnection, selectedMcpConnection, validateMcpClientUrl } from '../../src/services/mcp/mcpClientService';

const tool = { name: 'lookup', description: 'Lookup records', inputSchema: { type: 'object' as const, properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } };
const context = () => ({ projectId: GENERAL_ASSISTANT_SCOPE_ID, conversationId: 'conv-mcp', signal: new AbortController().signal });

async function arrange() {
  const fingerprint = await fingerprintMcpTool(tool);
  const item: McpClientConnection = { id: crypto.randomUUID(), revision: crypto.randomUUID(), name: 'Knowledge', url: 'https://example.com/mcp', enabled: true, hasSecret: false, authHeader: 'authorization', tools: { lookup: { access: 'read', fingerprint } } };
  useAppStore.setState({ config: { ...useAppStore.getState().config, mcpClientConnections: [item] }, conversations: [{
    id: 'conv-mcp', projectId: GENERAL_ASSISTANT_SCOPE_ID, title: 'MCP', titleSource: 'auto', pinned: false, archived: false, agentMode: 'collaborative', createdAt: 1, updatedAt: 1, messageCount: 0, mcpServerIds: [item.id],
  }] });
  return { item, input: { serverId: item.id, toolName: tool.name, arguments: { query: 'hello' }, revision: item.revision, fingerprint, selectionRevision: 'legacy' } };
}

/** 模拟 SDK send 的异步拒绝与 close 同步拒绝 pending RPC 的先后关系。 */
function useNativeRpc(item: McpClientConnection, statuses: number[], sessionId: string | undefined = 'server-session', onReply?: () => void) {
  const methods: string[] = [];
  let requestId = 0;
  native.invoke.mockImplementation(async (command: string, args?: { body?: string }) => {
    if (command !== 'mcp_client_fetch') return;
    const message = JSON.parse(args!.body!) as { method: string };
    methods.push(message.method);
    const status = statuses.shift() ?? 200;
    onReply?.();
    return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(message.method === 'tools/list'
      ? { tools: [tool] } : { content: [{ type: 'text', text: 'A real result' }] }) };
  });
  sdk.request.mockImplementation(function (this: object, message: { method: string; params?: unknown }) {
    return new Promise<unknown>((resolve, reject) => {
      sdk.pending.set(this, reject);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (sessionId) headers['mcp-session-id'] = sessionId;
      void sdk.fetches.get(this)!(item.url, {
        method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, ...message }),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }).then(resolve, reject);
    }).finally(() => { sdk.pending.delete(this); });
  });
  return methods;
}

beforeEach(() => {
  resumeSettingsPersistence();
  sdk.pending.clear();
  sdk.fetches.clear();
  sdk.connect.mockReset().mockImplementation(async function (this: object, transport: { fetch: typeof fetch }) {
    sdk.fetches.set(this, transport.fetch);
  });
  sdk.close.mockReset().mockImplementation(async function (this: object) {
    sdk.pending.get(this)?.(new Error('Connection closed'));
  });
  native.invoke.mockReset().mockResolvedValue(undefined);
  useAppStore.setState(useAppStore.getInitialState(), true);
  sdk.connect.mockClear();
  sdk.close.mockClear();
  secrets.write.mockReset().mockResolvedValue(true);
  secrets.remove.mockReset().mockResolvedValue(true);
  sdk.request.mockReset();
  sdk.request.mockImplementation(async ({ method }: { method: string }) => method === 'tools/list'
    ? { tools: [tool] } : { content: [{ type: 'text', text: 'A real result' }] });
});

describe('external MCP client boundaries', () => {
  it('rebuilds an expired session and retries tool discovery only once', async () => {
    const { item } = await arrange();
    const methods = useNativeRpc(item, [404, 200]);
    expect(await discoverMcpTools(item.id)).toHaveLength(1);
    expect(methods).toEqual(['tools/list', 'tools/list']);
    expect(sdk.connect).toHaveBeenCalledTimes(2);
    expect(sdk.close).toHaveBeenCalledTimes(1);
    expect(native.invoke.mock.calls.filter(([command]) => command === 'mcp_client_fetch')
      .every(([, args]) => args.method === 'POST')).toBe(true);
  });

  it('recovers when a newly initialized session expires before its initialized notification completes', async () => {
    const { item } = await arrange();
    const methods = useNativeRpc(item, [404, 200]);
    sdk.connect.mockImplementationOnce(async function (this: object, transport: { fetch: typeof fetch }) {
      sdk.fetches.set(this, transport.fetch);
      await transport.fetch(item.url, {
        method: 'POST', headers: { 'content-type': 'application/json', 'mcp-session-id': 'server-session' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
    });

    expect(await discoverMcpTools(item.id)).toHaveLength(1);
    expect(methods).toEqual(['notifications/initialized', 'tools/list']);
    expect(sdk.connect).toHaveBeenCalledTimes(2);
  });

  it('does not loop when the replacement MCP session also expires', async () => {
    const { item } = await arrange();
    const methods = useNativeRpc(item, [404, 404]);
    await expect(discoverMcpTools(item.id)).rejects.toThrow('MCP 会话已失效');
    expect(methods).toEqual(['tools/list', 'tools/list']);
    expect(sdk.connect).toHaveBeenCalledTimes(2);
  });

  it.each(['read', 'write'] as const)('never resubmits a %s tool call after session expiry and reconnects on the next operation', async (access) => {
    const { item, input } = await arrange();
    const authorized = { ...item, tools: { lookup: { ...item.tools.lookup, access } } };
    useAppStore.setState({ config: { ...useAppStore.getState().config, mcpClientConnections: [authorized] } });
    const methods = useNativeRpc(authorized, [200, 404, 200]);
    await expect(callExternalMcp(context(), input, access)).rejects.toThrow('MCP 会话已失效');
    expect(methods).toEqual(['tools/list', 'tools/call']);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
    expect(await discoverMcpTools(item.id)).toHaveLength(1);
    expect(methods).toEqual(['tools/list', 'tools/call', 'tools/list']);
    expect(sdk.connect).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 401, sessionId: 'server-session' },
    { status: 403, sessionId: 'server-session' },
    { status: 404, sessionId: '' },
  ])('does not reconnect for authentication errors or responses without a session ($status/$sessionId)', async ({ status, sessionId }) => {
    const { item } = await arrange();
    const methods = useNativeRpc(item, [status, 200], sessionId);
    await expect(discoverMcpTools(item.id)).rejects.toThrow(`HTTP ${status}`);
    expect(methods).toEqual(['tools/list']);
    expect(await discoverMcpTools(item.id)).toHaveLength(1);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
  });

  it.each(['signal', 'connection', 'selection'] as const)('does not reconnect after %s authority changes', async (changed) => {
    const { item, input } = await arrange();
    const controller = new AbortController();
    const methods = useNativeRpc(item, [404], 'server-session', () => {
      const state = useAppStore.getState();
      if (changed === 'signal') controller.abort();
      if (changed === 'connection') useAppStore.setState({ config: { ...state.config, mcpClientConnections: [{ ...item, revision: crypto.randomUUID() }] } });
      if (changed === 'selection') useAppStore.setState({ conversations: [{ ...state.conversations[0], mcpSelectionRevision: 'renewed' }] });
    });
    await expect(callExternalMcp({ ...context(), signal: controller.signal }, input, 'read')).rejects.toThrow();
    expect(methods).toEqual(['tools/list']);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
  });

  it('serializes credential saves and removal and rejects revisions captured during a pending save', async () => {
    const { item } = await arrange();
    useAppStore.setState({ saveConfig: vi.fn(async () => undefined) });
    let started!: () => void;
    const writing = new Promise<void>((resolve) => { started = resolve; });
    let finish!: (value: boolean) => void;
    secrets.write.mockImplementationOnce(() => { started(); return new Promise<boolean>((resolve) => { finish = resolve; }); });
    const first = saveMcpClientConnection(item, 'first-secret');
    await writing;
    const pending = useAppStore.getState().config.mcpClientConnections![0];
    const second = saveMcpClientConnection(pending, 'second-secret');
    const removed = removeMcpClientConnection(item.id);
    const secondRejected = expect(second).rejects.toThrow('连接已被其他设置操作修改');
    const removalRejected = expect(removed).rejects.toThrow('连接已变化');
    expect(secrets.write).toHaveBeenCalledTimes(1);
    expect(secrets.remove).not.toHaveBeenCalled();
    finish(true);
    await first;
    await secondRejected;
    await removalRejected;
    expect(secrets.write).toHaveBeenCalledTimes(1);
    expect(secrets.remove).not.toHaveBeenCalled();
  });

  it('does not replace credentials unless the disabled destination is persisted first', async () => {
    const { item } = await arrange();
    const saveConfig = vi.fn(async () => { throw new Error('save failed'); });
    useAppStore.setState({ saveConfig });
    await expect(saveMcpClientConnection({ ...item, url: 'https://new.example.com/mcp' }, 'new-secret')).rejects.toThrow('save failed');
    expect(secrets.write).not.toHaveBeenCalled();
    expect(useAppStore.getState().config.mcpClientConnections![0]).toMatchObject({
      url: 'https://new.example.com/mcp', enabled: false, hasSecret: false, tools: {},
    });
  });

  it('keeps a failed final save disabled and can retry without writing the token again', async () => {
    const { item } = await arrange();
    const persisted: McpClientConnection[][] = [];
    const saveConfig = vi.fn(async () => {
      if (persisted.length === 1) throw new Error('final save failed');
      persisted.push(structuredClone(useAppStore.getState().config.mcpClientConnections!));
    });
    useAppStore.setState({ saveConfig });
    await expect(saveMcpClientConnection({ ...item, url: 'https://new.example.com/mcp' }, 'new-secret')).rejects.toThrow('final save failed');
    expect(persisted[0][0]).toMatchObject({ url: 'https://new.example.com/mcp', enabled: false, hasSecret: false });
    const failed = useAppStore.getState().config.mcpClientConnections![0];
    expect(failed).toMatchObject({ url: 'https://new.example.com/mcp', enabled: false, hasSecret: true });
    expect(JSON.stringify(failed)).not.toContain('new-secret');
    saveConfig.mockImplementation(async () => { persisted.push(structuredClone(useAppStore.getState().config.mcpClientConnections!)); });
    await saveMcpClientConnection({ ...failed, enabled: true });
    expect(useAppStore.getState().config.mcpClientConnections![0].enabled).toBe(true);
    expect(secrets.write).toHaveBeenCalledTimes(1);
  });

  it('finishes failed credential saves before exit freezes settings and keeps cancelled exits disabled', async () => {
    const { item } = await arrange();
    let started!: () => void;
    const saving = new Promise<void>((resolve) => { started = resolve; });
    let fail!: (reason: Error) => void;
    const saveConfig = vi.fn(async () => undefined).mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(() => { started(); return new Promise<void>((_resolve, reject) => { fail = reject; }); });
    useAppStore.setState({ saveConfig });
    const save = saveMcpClientConnection(item, 'new-secret');
    const rejected = expect(save).rejects.toThrow('final save failed');
    await saving;
    const closing = prepareSettingsClose();
    expect(areSettingsMutationsFrozen()).toBe(false);
    fail(new Error('final save failed'));
    await rejected;
    expect(await closing).toBe(false);
    expect(useAppStore.getState().config.mcpClientConnections![0].enabled).toBe(false);
    resumeSettingsPersistence();
    expect(areSettingsMutationsFrozen()).toBe(false);
    expect(useAppStore.getState().config.mcpClientConnections![0].enabled).toBe(false);
  });

  it('allows only HTTPS or loopback HTTP without embedded credentials', () => {
    expect(validateMcpClientUrl(' http://127.0.0.1:8080/mcp ')).toBe('http://127.0.0.1:8080/mcp');
    for (const url of ['file:///etc/passwd', 'http://example.com/mcp', 'https://user:pass@example.com/mcp', 'https://example.com/mcp?token=secret', 'https://example.com/mcp#fragment']) {
      expect(() => validateMcpClientUrl(url)).toThrow();
    }
  });

  it('does not expose endpoints or credentials in detached options and preserves schema structure', async () => {
    const { item } = await arrange();
    expect(getMcpClientOptions()).toEqual([{ id: item.id, name: item.name, toolCount: 1 }]);
    const schema = { type: 'object', properties: { api_key: { type: 'string' } } };
    expect(sanitizeMcpValue(schema)).toEqual(schema);
    expect(await fingerprintMcpTool({ b: 2, a: 1 })).toBe(await fingerprintMcpTool({ a: 1, b: 2 }));
  });

  it('rejects malformed, non-object and oversized dynamic arguments before sending', () => {
    expect(parseMcpToolArguments('{"query":"hello"}')).toEqual({ query: 'hello' });
    for (const value of ['null', '[]', '1', '{broken', `{"query":"${'x'.repeat(65_536)}"}`]) expect(() => parseMcpToolArguments(value)).toThrow();
  });

  it('requires explicit conversation selection and cannot reuse read authority for writes', async () => {
    const { item, input } = await arrange();
    await expect(callExternalMcp(context(), input, 'write')).rejects.toThrow('授权');
    const conversation = useAppStore.getState().conversations[0];
    useAppStore.setState({ conversations: [{ ...conversation, mcpServerIds: [] }] });
    expect(selectedMcpConnection(context(), item.id)).toBeUndefined();
    await expect(callExternalMcp(context(), input, 'read')).rejects.toThrow('授权');
    expect(sdk.request).not.toHaveBeenCalled();
  });

  it('refreshes tool identity before a call and never executes changed schemas', async () => {
    const { input } = await arrange();
    sdk.request.mockResolvedValue({ tools: [{ ...tool, description: 'Now deletes records' }] });
    await expect(callExternalMcp(context(), input, 'read')).rejects.toThrow('重新授权');
    expect(sdk.request.mock.calls.some(([request]) => request.method === 'tools/call')).toBe(false);
  });

  it('does not revive an earlier proposal after the conversation grants are renewed', async () => {
    const { input } = await arrange();
    const conversation = useAppStore.getState().conversations[0];
    useAppStore.setState({ conversations: [{ ...conversation, mcpSelectionRevision: 'renewed-selection' }] });
    await expect(callExternalMcp(context(), input, 'read')).rejects.toThrow('授权');
    expect(sdk.request).not.toHaveBeenCalled();
  });

  it('revokes a selected service while discovery is pending', async () => {
    const { input } = await arrange();
    let finish: ((value: { tools: typeof tool[] }) => void) | undefined;
    const pending = new Promise<{ tools: typeof tool[] }>((resolve) => { finish = resolve; });
    let started: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    sdk.request.mockImplementation(() => { started!(); return pending; });
    const execution = callExternalMcp(context(), input, 'read');
    await waiting;
    const conversation = useAppStore.getState().conversations[0];
    useAppStore.setState({ conversations: [{ ...conversation, mcpServerIds: [] }] });
    finish!({ tools: [tool] });
    await expect(execution).rejects.toThrow();
    expect(sdk.request.mock.calls.some(([request]) => request.method === 'tools/call')).toBe(false);
  });

  it('returns real text and carries remote execution errors as errors', async () => {
    const { input } = await arrange();
    expect(await callExternalMcp(context(), input, 'read')).toMatchObject({ text: 'A real result', isError: false });
    sdk.request.mockImplementation(async ({ method }: { method: string }) => method === 'tools/list'
      ? { tools: [tool] } : { isError: true, content: [{ type: 'text', text: 'Failed' }] });
    expect(await callExternalMcp(context(), input, 'read')).toMatchObject({ text: 'Failed', isError: true });
  });
});
