#!/usr/bin/env node

import net from 'node:net';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const LOOPBACK_HOST = '127.0.0.1';
const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_FRAME_BYTES = 1024 * 1024;

export function parseCliArgs(args) {
  let port;
  let token;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--port') port = Number(args[index + 1]);
    if (args[index] === '--token') token = args[index + 1];
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('必须通过 --port 提供有效的 AI Canvas MCP 会话端口');
  }
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error('必须通过 --token 提供 256 位十六进制会话令牌');
  }
  return { port, token: token.toLowerCase() };
}

export class LoopbackClient {
  constructor({ port, token, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.port = port;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.connecting = null;
    this.buffer = '';
    this.pending = new Map();
    this.sequence = 0;
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: LOOPBACK_HOST, port: this.port });
      const handleConnectError = (error) => {
        socket.destroy();
        reject(new Error(`无法连接 AI Canvas MCP 会话: ${error.message}`));
      };
      socket.once('error', handleConnectError);
      socket.once('connect', () => {
        socket.off('error', handleConnectError);
        socket.setEncoding('utf8');
        socket.setNoDelay(true);
        socket.on('data', (chunk) => this.handleData(chunk));
        socket.on('error', (error) => this.handleDisconnect(error));
        socket.on('close', () => this.handleDisconnect(new Error('AI Canvas MCP 会话已断开')));
        this.socket = socket;
        resolve();
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  handleData(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES) {
      this.handleDisconnect(new Error('AI Canvas MCP 响应超过 1 MiB 上限'));
      this.socket?.destroy();
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const raw = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw) continue;
      let response;
      try {
        response = JSON.parse(raw);
      } catch {
        this.handleDisconnect(new Error('AI Canvas MCP 返回了无效 JSON'));
        this.socket?.destroy();
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.version !== PROTOCOL_VERSION) {
        pending.reject(new Error('AI Canvas MCP 内部协议版本不兼容'));
      } else if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(new Error(response.error?.message || 'AI Canvas MCP 请求失败'));
      }
    }
  }

  handleDisconnect(error) {
    if (!this.socket && this.pending.size === 0) return;
    this.socket = null;
    this.buffer = '';
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(method, params, { signal } = {}) {
    await this.connect();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const id = `mcp-${Date.now().toString(36)}-${(this.sequence += 1).toString(36)}`;
    const frame = `${JSON.stringify({
      version: PROTOCOL_VERSION,
      id,
      token: this.token,
      method,
      params,
    })}\n`;
    if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) {
      throw new Error('AI Canvas MCP 请求超过 1 MiB 上限');
    }
    return new Promise((resolve, reject) => {
      const cleanupAbort = () => signal?.removeEventListener('abort', handleAbort);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanupAbort();
        reject(new Error('AI Canvas MCP 请求等待超时'));
      }, this.timeoutMs);
      const handleAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        cleanupAbort();
        reject(new DOMException('Aborted', 'AbortError'));
        this.sendCancellation(id);
      };
      this.pending.set(id, {
        timer,
        resolve: (value) => {
          cleanupAbort();
          resolve(value);
        },
        reject: (error) => {
          cleanupAbort();
          reject(error);
        },
      });
      signal?.addEventListener('abort', handleAbort, { once: true });
      this.socket.write(frame, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        pending.reject(error);
      });
    });
  }

  sendCancellation(targetRequestId) {
    if (!this.socket || this.socket.destroyed) return;
    const id = `cancel-${Date.now().toString(36)}-${(this.sequence += 1).toString(36)}`;
    const frame = `${JSON.stringify({
      version: PROTOCOL_VERSION,
      id,
      token: this.token,
      method: 'requests/cancel',
      params: { requestId: targetRequestId },
    })}\n`;
    this.socket.write(frame);
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.handleDisconnect(new Error('AI Canvas MCP 适配器已关闭'));
  }
}

export function toMcpToolResult(result) {
  if (Array.isArray(result?.content)) {
    return {
      ...result,
      content: result.content,
      isError: result.isError === true,
    };
  }
  return {
    isError: result?.isError === true,
    content: [{
      type: 'text',
      text: typeof result?.summary === 'string' ? result.summary : 'AI Canvas 未返回结果摘要',
    }],
  };
}

export function createMcpServer(client) {
  const server = new Server(
    { name: 'ai-canvas-local-control', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await client.request('tools/list', {});
    return { tools: Array.isArray(result?.tools) ? result.tools : [] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const result = await client.request('tools/call', {
        name: request.params.name,
        arguments: request.params.arguments ?? {},
      }, { signal: extra.signal });
      return toMcpToolResult(result);
    } catch (error) {
      return toMcpToolResult({
        isError: true,
        summary: error instanceof Error ? error.message : 'AI Canvas MCP 调用失败',
      });
    }
  });
  return server;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const client = new LoopbackClient(options);
  await client.connect();
  const server = createMcpServer(client);
  const transport = new StdioServerTransport();
  const close = () => client.close();
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.once('exit', close);
  await server.connect(transport);
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
