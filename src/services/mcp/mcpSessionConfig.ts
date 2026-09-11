/**
 * 管理 MCP 会话令牌（固定令牌存凭据存储，不落 IndexedDB）与本地服务启动命令。
 */
import type { McpBridgeSessionInfo, McpTransport } from '../../types/mcp';
import { readAppSecret, writeAppSecret } from '../providerSecretService';
import { useAppStore } from '../../store/useAppStore';
import { startMcpBridge } from './mcpBridgeService';
import { enqueueConfigPersistence } from '../configPersistenceQueue';
import { StorageError } from '../storageDiagnostics';

/** 凭据存储条目名；字符集须与 Rust 侧 validate_key 对齐。 */
const MCP_TOKEN_SECRET_KEY = 'mcp/token';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export type McpTokenPersistence = 'persistent' | 'session-only';
interface SessionToken {
  token: string;
  persistence: McpTokenPersistence;
}
// 降级令牌仅保留在当前主窗口内存；探测或重新打开设置页不能改变它。
let sessionOnlyToken: SessionToken | null = null;
let tokenInitialization: Promise<string> | null = null;
let activeToken: (SessionToken & { sessionId: string }) | null = null;
let tokenPersistence: McpTokenPersistence | null = null;

export function getMcpTokenPersistence(): McpTokenPersistence | null {
  return tokenPersistence;
}

function validateStoredToken(stored: string | null): string | null {
  if (stored === null) return null;
  if (!TOKEN_PATTERN.test(stored.toLowerCase())) throw new StorageError('secret-read', 'corrupt');
  return stored.toLowerCase();
}

export function generateMcpSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 取出固定令牌，没有就生成一个并写进凭据存储。
 * 凭据存储不可用时退回一次性令牌，只在本次会话内有效。
 */
export function ensureMcpSessionToken(): Promise<string> {
  if (tokenInitialization) return tokenInitialization;
  const pending = enqueueConfigPersistence(async () => {
    if (sessionOnlyToken) {
      tokenPersistence = 'session-only';
      return sessionOnlyToken.token;
    }
    let unavailable = false;
    let stored: string | null;
    try {
      stored = validateStoredToken(await readAppSecret(MCP_TOKEN_SECRET_KEY));
    } catch (error) {
      // 未知故障、权限拒绝、损坏均不得当作缺失，更不得覆盖旧令牌。
      if (!(error instanceof StorageError) || error.code !== 'unavailable') throw error;
      unavailable = true;
      stored = null;
    }
    if (stored !== null) {
      tokenPersistence = 'persistent';
      return stored;
    }
    const token = generateMcpSessionToken();
    let persisted: boolean;
    try {
      persisted = !unavailable && await writeAppSecret(MCP_TOKEN_SECRET_KEY, token, { value: null });
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== 'conflict') throw error;
      // 另一进程已经创建：只重读胜出的值，不重试写入或创建第二个固定令牌。
      const winner = validateStoredToken(await readAppSecret(MCP_TOKEN_SECRET_KEY));
      if (!winner) throw new StorageError('secret-read', 'conflict');
      tokenPersistence = 'persistent';
      return winner;
    }
    tokenPersistence = persisted ? 'persistent' : 'session-only';
    if (!persisted) sessionOnlyToken = { token, persistence: 'session-only' };
    return token;
  });
  tokenInitialization = pending;
  void pending.then(
    () => { if (tokenInitialization === pending) tokenInitialization = null; },
    () => { if (tokenInitialization === pending) tokenInitialization = null; },
  );
  return pending;
}

/** 设置页补读运行中会话时绝不创建令牌；优先返回启动时实际交给 bridge 的值。 */
export async function readRunningMcpToken(sessionId: string): Promise<string | null> {
  if (activeToken?.sessionId === sessionId) {
    tokenPersistence = activeToken.persistence;
    return activeToken.token;
  }
  const stored = validateStoredToken(await readAppSecret(MCP_TOKEN_SECRET_KEY));
  tokenPersistence = stored === null ? null : 'persistent';
  return stored;
}

/** 令牌泄露或需要作废旧客户端配置时轮换。 */
export function rotateMcpSessionToken(): Promise<string> {
  return enqueueConfigPersistence(async () => {
    // 显式轮换仍需先读到权威状态，失败时保留当前令牌和运行中的 bridge。
    const previous = await readAppSecret(MCP_TOKEN_SECRET_KEY);
    validateStoredToken(previous);
    const token = generateMcpSessionToken();
    if (!await writeAppSecret(MCP_TOKEN_SECRET_KEY, token, { value: previous })) throw new StorageError('secret-write', 'unknown');
    sessionOnlyToken = null;
    tokenPersistence = 'persistent';
    return token;
  });
}

/** 端口非法（含 0、特权端口）时按随机端口处理。 */
export function normalizeMcpPort(value: unknown): number | undefined {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return undefined;
  return port;
}

export function getConfiguredMcpTransport(value: unknown): McpTransport {
  return value === 'streamable-http' ? 'streamable-http' : 'stdio';
}

/** 按用户配置（固定端口 + 固定令牌）开启 bridge。 */
export async function startConfiguredMcpBridge(): Promise<{
  session: McpBridgeSessionInfo;
  token: string;
}> {
  const token = await ensureMcpSessionToken();
  const persistence = tokenPersistence ?? 'persistent';
  const config = useAppStore.getState().config;
  const port = normalizeMcpPort(config.mcpPort);
  const transport = getConfiguredMcpTransport(config.mcpTransport);
  const session = await startMcpBridge(token, port, transport);
  activeToken = { token, persistence, sessionId: session.sessionId };
  return { session, token };
}

export function buildMcpHttpEndpoint(session: McpBridgeSessionInfo): string | null {
  if (session.transport !== 'streamable-http') return null;
  return `http://<AI_CANVAS_IP>:${session.port}${session.endpointPath ?? '/mcp'}`;
}

/**
 * 生成客户端配置片段（Claude Desktop / Cursor 等的 mcpServers 格式）。
 * stdio 令牌走 env 而不是命令行参数；HTTP 令牌按标准 Bearer header 发送。
 */
export function buildMcpClientConfig(
  session: McpBridgeSessionInfo,
  token: string,
): string | null {
  if (session.transport === 'streamable-http') {
    const endpoint = buildMcpHttpEndpoint(session);
    if (!endpoint) return null;
    return JSON.stringify(
      {
        mcpServers: {
          'ai-canvas': {
            url: endpoint,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
      null,
      2,
    );
  }
  if (!session.adapterPath) return null;
  return JSON.stringify(
    {
      mcpServers: {
        'ai-canvas': {
          command: 'node',
          args: [session.adapterPath, '--port', String(session.port)],
          env: { AI_CANVAS_MCP_TOKEN: token },
        },
      },
    },
    null,
    2,
  );
}
