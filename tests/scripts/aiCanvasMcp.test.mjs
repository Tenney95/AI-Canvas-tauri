import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LoopbackClient,
  parseCliArgs,
  toMcpToolResult,
} from '../../scripts/ai-canvas-mcp.mjs';

const TOKEN = 'ab'.repeat(32);
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.close(resolve);
  })));
});

describe('AI Canvas MCP stdio adapter', () => {
  it('requires a valid loopback port and 256-bit token', () => {
    expect(parseCliArgs(['--port', '43123', '--token', TOKEN])).toEqual({
      port: 43123,
      token: TOKEN,
    });
    expect(() => parseCliArgs(['--port', '0', '--token', TOKEN])).toThrow('端口');
    expect(() => parseCliArgs(['--port', '43123', '--token', 'short'])).toThrow('令牌');
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
