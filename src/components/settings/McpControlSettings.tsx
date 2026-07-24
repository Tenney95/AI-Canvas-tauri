import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import AnimatedButton from '../shared/AnimatedButton';
import {
  getMcpBridgeStatus,
  startMcpBridge,
  stopMcpBridge,
} from '../../services/mcp/mcpBridgeService';
import type { McpBridgeSessionInfo } from '../../types/mcp';
import {
  buildMcpServerCommand,
  generateMcpSessionToken,
} from '../../services/mcp/mcpSessionConfig';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

export default function McpControlSettings() {
  const [session, setSession] = useState<McpBridgeSessionInfo | null>(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    getMcpBridgeStatus()
      .then((status) => {
        if (!cancelled) setSession(status);
      })
      .catch(() => {
        if (!cancelled) setError('无法读取 MCP 会话状态');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const command = useMemo(
    () => session && token ? buildMcpServerCommand(session, token) : null,
    [session, token],
  );

  const handleStart = async () => {
    setLoading(true);
    setError('');
    setCopied(false);
    try {
      const nextToken = generateMcpSessionToken();
      const nextSession = await startMcpBridge(nextToken);
      setToken(nextToken);
      setSession(nextSession);
    } catch (startError) {
      setToken('');
      setSession(null);
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    setError('');
    try {
      await stopMcpBridge();
      setSession(null);
      setToken('');
      setCopied(false);
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setError('复制连接命令失败');
    }
  };

  if (!isTauri) {
    return (
      <div className="rounded-md border border-canvas-border bg-canvas-surface px-4 py-3 text-sm text-canvas-text-secondary">
        MCP 控制仅在 Tauri 桌面应用中可用。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 border-b border-canvas-border pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-canvas-text">
            <span
              className={`h-2 w-2 rounded-full ${session ? 'bg-green-400' : 'bg-canvas-text-muted'}`}
              aria-hidden="true"
            />
            {session ? '本地控制会话已开启' : '本地控制会话已关闭'}
          </div>
          <p className="mt-1 text-xs text-canvas-text-muted">
            {session ? `回环端口 ${session.port}` : '默认关闭'}
          </p>
        </div>
        <AnimatedButton
          type="button"
          className="settings-save-btn shrink-0 text-xs"
          onClick={session ? handleStop : handleStart}
          disabled={loading}
        >
          <Icon icon={session ? 'lucide:power-off' : 'lucide:power'} width="14" height="14" />
          {loading ? '处理中' : session ? '停止' : '开启'}
        </AnimatedButton>
      </div>

      {session && !token && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          本页没有当前令牌。停止后重新开启以生成新的连接命令。
        </div>
      )}

      {command && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-canvas-text-secondary">stdio 启动命令</span>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-canvas-text-secondary transition-colors hover:bg-canvas-hover hover:text-canvas-text"
              onClick={handleCopy}
              aria-label="复制 MCP 启动命令"
              title="复制启动命令"
            >
              <Icon icon={copied ? 'lucide:check' : 'lucide:copy'} width="14" height="14" />
            </button>
          </div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border border-canvas-border bg-canvas-bg px-3 py-2 text-[11px] leading-relaxed text-canvas-text-secondary select-all">
            {command}
          </pre>
          <p className="text-[11px] text-canvas-text-muted">
            停止会话或退出应用后，此命令立即失效。
          </p>
        </div>
      )}

      {session && token && !command && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          未找到本地 MCP 适配器脚本。
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
