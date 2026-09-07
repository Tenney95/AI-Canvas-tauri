import net from 'node:net';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
// CLI 适配器由 Node 原生加载；避免 Vite 转换把 shebang 带入执行包装函数。
const {
  LoopbackClient,
  parseCliArgs,
  toMcpToolResult,
  createMcpServer,
} = createRequire(import.meta.url)('../../scripts/ai-canvas-mcp.mjs');
import { handleMcpBridgeRequest } from '../../src/services/mcp/mcpControlService';
import { useAppStore } from '../../src/store/useAppStore';
import { registerAgentTool } from '../../src/services/chat/toolRegistry';
import { resetAgentToolsRegistrationForTests } from '../../src/services/chat/tools';

const TOKEN = 'ab'.repeat(32);
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.close(resolve);
  })));
});

describe('AI Canvas MCP stdio adapter', () => {
  it('supports on-demand discovery and rich results through the existing MCP SDK server', async () => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({ currentProjectId: 'sdk-project', projects: [{ id: 'sdk-project', name: 'SDK test', createdAt: 1, updatedAt: 1 }] });
    let sequence = 0;
    const server = createMcpServer({ request: (method, params) => handleMcpBridgeRequest({
      sessionId: 'sdk-session', requestId: `sdk:${sequence++}`, method, params,
    }) });
    const client = new Client({ name: 'catalog-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let unregisterImage;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['tools_search', 'tools_describe', 'tools_call']);
      expect(tools[2].annotations.readOnlyHint).toBe(false);
      const found = await client.callTool({ name: 'tools_search', arguments: { query: 'canvas_query', limit: 1, detail: 'schema' } });
      const target = JSON.parse(found.content[0].text).tools[0];
      expect(target.name).toBe('canvas_query');
      expect(target.inputSchema.type).toBe('object');
      expect(await client.callTool({ name: 'tools_call', arguments: { name: target.name, arguments: {} } })).toMatchObject({ isError: false });

      unregisterImage = registerAgentTool({ id: 'sdk_image_probe', title: 'SDK image', description: 'SDK rich result probe', effect: 'read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ status: 'success', summary: '已读取图像', modelContent: '已读取图像', mcpContent: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }] }),
      });
      const image = await client.callTool({ name: 'tools_call', arguments: { name: 'sdk_image_probe', arguments: {} } });
      expect(image).toMatchObject({ isError: false, content: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }] });
      const bad = await client.callTool({ name: 'tools_call', arguments: { name: 'tools_call', arguments: {} } });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
      unregisterImage?.();
      resetAgentToolsRegistrationForTests();
    }
  });

  it('requires a valid loopback port and 256-bit token', () => {
    expect(parseCliArgs(['--port', '43123', '--token', TOKEN])).toEqual({
      port: 43123,
      token: TOKEN,
    });
    expect(() => parseCliArgs(['--port', '0', '--token', TOKEN])).toThrow('端口');
    expect(() => parseCliArgs(['--port', '43123', '--token', 'short'])).toThrow('令牌');
  });

  it('takes the token from the environment so it stays out of argv', () => {
    expect(parseCliArgs(['--port', '43123'], { AI_CANVAS_MCP_TOKEN: TOKEN }))
      .toEqual({ port: 43123, token: TOKEN });
    // 已经复制出去的旧命令仍然可用，且显式参数优先
    expect(parseCliArgs(['--port', '43123', '--token', TOKEN], {
      AI_CANVAS_MCP_TOKEN: 'cd'.repeat(32),
    }).token).toBe(TOKEN);
    expect(() => parseCliArgs(['--port', '43123'], {})).toThrow('令牌');
  });

  it('correlates authenticated loopback responses without retrying', async () => {
    let observedRequest;
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        observedRequest = JSON.parse(buffer.slice(0, newline));
        socket.write(`${JSON.stringify({
          version: 1,
          id: observedRequest.id,
          ok: true,
          result: { tools: [{ name: 'canvas_query' }] },
        })}\n`);
      });
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const client = new LoopbackClient({ port: address.port, token: TOKEN, timeoutMs: 1_000 });

    await expect(client.request('tools/list', {})).resolves.toEqual({
      tools: [{ name: 'canvas_query' }],
    });
    expect(observedRequest).toMatchObject({
      version: 1,
      token: TOKEN,
      method: 'tools/list',
      params: {},
    });
    expect(observedRequest.id).toMatch(/^mcp-/);
    client.close();
  });

  it('maps bridge failures to MCP tool errors', () => {
    expect(toMcpToolResult({
      isError: true,
      summary: '操作被用户拒绝',
    })).toEqual({
      isError: true,
      content: [{ type: 'text', text: '操作被用户拒绝' }],
    });
  });
});
