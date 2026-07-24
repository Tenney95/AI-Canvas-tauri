import type {
  McpBridgeRequestEvent,
  McpBridgeResponseInput,
  McpBridgeSessionInfo,
} from '../../types/mcp';

export async function startMcpBridge(token: string): Promise<McpBridgeSessionInfo> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<McpBridgeSessionInfo>('mcp_bridge_start', { token });
}

export async function stopMcpBridge(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('mcp_bridge_stop');
}

export async function getMcpBridgeStatus(): Promise<McpBridgeSessionInfo | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<McpBridgeSessionInfo | null>('mcp_bridge_status');
}

export async function respondToMcpBridge(response: McpBridgeResponseInput): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('mcp_bridge_respond', { response });
}

export async function listenForMcpBridgeRequests(
  handler: (request: McpBridgeRequestEvent) => void | Promise<void>,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<McpBridgeRequestEvent>('mcp:request', (event) => {
    void handler(event.payload);
  });
}
