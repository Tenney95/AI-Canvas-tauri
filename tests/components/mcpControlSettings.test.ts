import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { getConfiguredMcpToolExposure } from '../../src/services/mcp/mcpToolCatalog';

const settingsState = vi.hoisted(() => ({
  config: {} as { mcpToolExposure?: string }, updateConfig: vi.fn(), saveConfig: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useEffect: () => {},
  useMemo: <T>(factory: () => T) => factory(),
  useRef: <T>(value: T) => ({ current: value }),
  useState: <T>(value: T) => [value, vi.fn()],
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(settingsState), { getState: () => settingsState }),
}));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T>(selector: T) => selector }));

afterEach(() => { vi.unstubAllGlobals(); });

function elements(root: unknown): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(root)) return root.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(root)) return [];
  return [root, ...elements(root.props.children)];
}
import {
  buildMcpClientConfig,
  buildMcpHttpEndpoint,
  generateMcpSessionToken,
  getConfiguredMcpTransport,
  normalizeMcpPort,
} from '../../src/services/mcp/mcpSessionConfig';
import {
  getMcpConnectionRequirements,
  MCP_CONNECTION_REQUIREMENTS,
} from '../../src/components/settings/mcpConnectionRequirements';

describe('MCP control settings helpers', () => {
  it('uses compact discovery for old settings and preserves full mode when selected', () => {
    expect(getConfiguredMcpToolExposure(undefined)).toBe('compact');
    expect(getConfiguredMcpToolExposure('invalid')).toBe('compact');
    expect(getConfiguredMcpToolExposure('full')).toBe('full');
  });

  it('saves the selected mode through Store actions and explains client refresh', async () => {
    vi.stubGlobal('window', { __TAURI__: {} });
    settingsState.config = {};
    settingsState.updateConfig.mockClear();
    settingsState.saveConfig.mockClear();
    const { default: McpControlSettings } = await import('../../src/components/settings/McpControlSettings');
    const tree = elements(McpControlSettings());
    const select = tree.find((element) => element.type === 'select' && element.props.id === 'mcp-tool-exposure')!;
    expect(select.props.value).toBe('compact');
    expect(select.props.className).toBe('ui-select__control');
    expect(tree.find((element) => element.props.id === 'mcp-tool-exposure-hint')?.props.children).toContain('刷新工具列表');
    (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'full' } });
    expect(settingsState.updateConfig).toHaveBeenCalledExactlyOnceWith({ mcpToolExposure: 'full' });
    expect(settingsState.saveConfig).toHaveBeenCalledOnce();
    settingsState.config = { mcpToolExposure: 'full' };
    expect(elements(McpControlSettings()).find((element) => element.props.id === 'mcp-tool-exposure')?.props.value).toBe('full');
  });

  it('lists the complete local connection environment requirements', () => {
    expect(MCP_CONNECTION_REQUIREMENTS.map((requirement) => requirement.title)).toEqual([
      'AI Canvas 桌面端',
      'Node.js 运行环境',
      '支持 MCP 的客户端',
      '在同一台电脑连接',
    ]);
    expect(MCP_CONNECTION_REQUIREMENTS.at(-1)?.description).toContain('127.0.0.1');
  });

  it('replaces local Node requirements with remote HTTP security requirements', () => {
    const requirements = getMcpConnectionRequirements('streamable-http');
    expect(requirements.map((requirement) => requirement.title)).toEqual([
      'AI Canvas 桌面端',
      '可达的局域网地址',
      '支持 Streamable HTTP',
      'Bearer Token 鉴权',
    ]);
    expect(requirements.some((requirement) => requirement.title === 'Node.js 运行环境')).toBe(false);
  });

  it('generates a fresh 256-bit hexadecimal session token', () => {
    const first = generateMcpSessionToken();
    const second = generateMcpSessionToken();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it('builds a client config with the token in env, only when the adapter exists', () => {
    const token = 'ab'.repeat(32);
    const config = buildMcpClientConfig({
      sessionId: 'session-1',
      port: 43123,
      transport: 'stdio',
      bindAddress: '127.0.0.1',
      adapterPath: 'D:\\AI Canvas\\scripts\\ai-canvas-mcp.mjs',
    }, token);

    expect(JSON.parse(config ?? '')).toEqual({
      mcpServers: {
        'ai-canvas': {
          command: 'node',
          args: ['D:\\AI Canvas\\scripts\\ai-canvas-mcp.mjs', '--port', '43123'],
          env: { AI_CANVAS_MCP_TOKEN: token },
        },
      },
    });
    // 令牌不能出现在命令行参数里：argv 对本机所有进程可见
    expect(JSON.parse(config ?? '').mcpServers['ai-canvas'].args.join(' ')).not.toContain(token);

    expect(buildMcpClientConfig({
      sessionId: 'session-1',
      port: 43123,
      transport: 'stdio',
      bindAddress: '127.0.0.1',
    }, token)).toBeNull();
  });

  it('builds a bearer-authenticated Streamable HTTP endpoint without persisting the token', () => {
    const token = 'cd'.repeat(32);
    const session = {
      sessionId: 'session-http',
      port: 43124,
      transport: 'streamable-http' as const,
      bindAddress: '0.0.0.0',
      endpointPath: '/mcp',
    } as const;

    expect(buildMcpHttpEndpoint(session)).toBe('http://<AI_CANVAS_IP>:43124/mcp');
    expect(JSON.parse(buildMcpClientConfig(session, token) ?? '')).toEqual({
      mcpServers: {
        'ai-canvas': {
          url: 'http://<AI_CANVAS_IP>:43124/mcp',
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    });
  });

  it('defaults invalid or missing persisted transports to local stdio', () => {
    expect(getConfiguredMcpTransport(undefined)).toBe('stdio');
    expect(getConfiguredMcpTransport('invalid')).toBe('stdio');
    expect(getConfiguredMcpTransport('streamable-http')).toBe('streamable-http');
  });

  it('accepts only user-assignable ports as the fixed port', () => {
    expect(normalizeMcpPort('43123')).toBe(43123);
    expect(normalizeMcpPort(1024)).toBe(1024);
    expect(normalizeMcpPort(65535)).toBe(65535);
    // 非法输入一律回落到随机端口，而不是把 0 / 特权端口传给 bridge
    expect(normalizeMcpPort(80)).toBeUndefined();
    expect(normalizeMcpPort(70000)).toBeUndefined();
    expect(normalizeMcpPort('abc')).toBeUndefined();
    expect(normalizeMcpPort('')).toBeUndefined();
    expect(normalizeMcpPort(undefined)).toBeUndefined();
  });
});
