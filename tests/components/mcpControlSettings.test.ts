import { describe, expect, it } from 'vitest';
import {
  buildMcpServerCommand,
  generateMcpSessionToken,
} from '../../src/services/mcp/mcpSessionConfig';

describe('MCP control settings helpers', () => {
  it('generates a fresh 256-bit hexadecimal session token', () => {
    const first = generateMcpSessionToken();
    const second = generateMcpSessionToken();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it('builds a quoted stdio adapter command only when the adapter exists', () => {
    expect(buildMcpServerCommand({
      sessionId: 'session-1',
      port: 43123,
      adapterPath: 'D:\\AI Canvas\\scripts\\ai-canvas-mcp.mjs',
    }, 'ab'.repeat(32))).toBe(
      `node "D:\\AI Canvas\\scripts\\ai-canvas-mcp.mjs" --port 43123 --token ${'ab'.repeat(32)}`,
    );
    expect(buildMcpServerCommand({ sessionId: 'session-1', port: 43123 }, 'ab'.repeat(32)))
      .toBeNull();
  });
});
