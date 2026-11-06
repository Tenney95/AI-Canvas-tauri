/** CLI 信封、取消和发现合同；不启动应用或调用模型。 */
import { Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { parseCli, parseEnvelope, readEnvelope, executeCli } from '../../scripts/ai-canvas-cli.mjs';

const env = { AI_CANVAS_MCP_PORT: '49231', AI_CANVAS_MCP_TOKEN: 'a'.repeat(64) };

describe('AI Canvas thin CLI', () => {
  it('keeps the transport loopback-only and credentials out of argv', () => {
    expect(parseCli(['status'], env)).toMatchObject({ port: 49231, command: 'status' });
    expect(() => parseCli(['status', '--host', 'example.com'], env)).toThrow();
    expect(() => parseCli(['status', '--token', env.AI_CANVAS_MCP_TOKEN], env)).toThrow();
    expect(() => parseCli(['status'], { ...env, AI_CANVAS_MCP_TOKEN: 'bad' })).toThrow();
    expect(parseCli(['--help'], {})).toEqual({ help: true });
  });

  it('discovers schemas without reconstructing business tool definitions', async () => {
    const options = parseCli(['tools', 'search', '本集大纲', '--offset', '5', '--detail', 'schema'], env);
    const client = { request: vi.fn().mockResolvedValue({ content: [] }) };
    const controller = new AbortController();
    await executeCli(options, client, undefined, controller.signal);
    expect(client.request).toHaveBeenCalledWith('tools/call', { name: 'tools_search', arguments: { query: '本集大纲', offset: 5, detail: 'schema' } }, { signal: controller.signal });
    expect(() => parseCli(['tools', 'describe', 'a', 'b', 'c', 'd'], env)).toThrow();
  });

  it('preserves the original operation key and project guard in the envelope', async () => {
    const input = { name: 'canvas_update', arguments: { nodeId: 'n1' }, expectedProjectId: 'p1', expectedRevision: 12, operationKey: 'intent:123' };
    const envelope = parseEnvelope(JSON.stringify(input));
    const client = { request: vi.fn().mockRejectedValue(new Error('disconnect')) };
    await expect(executeCli(parseCli(['call'], env), client, envelope)).rejects.toThrow('disconnect');
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request.mock.calls[0][1]).toEqual({ name: 'tools_call', arguments: input });
    const receipt = parseCli(['operation', 'get', input.operationKey, '--project-id', 'p1'], env);
    expect(receipt.request.params.arguments).toEqual({ name: 'mcp_operation_get', arguments: { operationKey: 'intent:123' }, expectedProjectId: 'p1' });
  });

  it('rejects invalid UTF-8, oversized input and misplaced envelope fields', async () => {
    await expect(readEnvelope(Readable.from([Buffer.from([0xff])]))).rejects.toThrow('UTF-8');
    await expect(readEnvelope(Readable.from([Buffer.alloc(1024 * 1024 + 1)]))).rejects.toThrow('1 MiB');
    expect(() => parseEnvelope('{"name":"x","arguments":{},"cwd":"secret"}')).toThrow();
    expect(() => parseEnvelope('{"name":"x","arguments":{},"expectedRevision":1}')).toThrow();
    expect(() => parseEnvelope('{"name":"tools_call","arguments":{}}')).toThrow();
    expect(await readEnvelope(Readable.from([Buffer.from('\uFEFF{"name":"canvas_query","arguments":{}}')]))).toEqual({ name: 'canvas_query', arguments: {} });
  });

  it('passes cancellation without retrying the request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readEnvelope(Readable.from([]), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const client = { request: vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')) };
    await expect(executeCli(parseCli(['status'], env), client, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.request).toHaveBeenCalledTimes(1);
  });
});
