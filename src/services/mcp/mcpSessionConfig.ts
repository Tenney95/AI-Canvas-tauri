import type { McpBridgeSessionInfo } from '../../types/mcp';

export function generateMcpSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function quoteCommandArgument(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function buildMcpServerCommand(
  session: McpBridgeSessionInfo,
  token: string,
): string | null {
  if (!session.adapterPath) return null;
  return [
    'node',
    quoteCommandArgument(session.adapterPath),
    '--port',
    String(session.port),
    '--token',
    token,
  ].join(' ');
}
