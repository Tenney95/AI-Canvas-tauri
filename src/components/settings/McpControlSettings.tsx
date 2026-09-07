/**
 * MCP 本地控制设置页，管理 bridge 会话、固定端口/令牌、自动开启和外部客户端配置片段。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import AnimatedButton from '../shared/AnimatedButton';
import ModalOverlay from '../shared/ModalOverlay';
import { useAppStore } from '../../store/useAppStore';
import {
  getMcpBridgeStatus,
  stopMcpBridge,
} from '../../services/mcp/mcpBridgeService';
import type { McpBridgeSessionInfo } from '../../types/mcp';
import {
  buildMcpClientConfig,
  ensureMcpSessionToken,
  getConfiguredMcpTransport,
  normalizeMcpPort,
  rotateMcpSessionToken,
  startConfiguredMcpBridge,
} from '../../services/mcp/mcpSessionConfig';
import { getMcpConnectionRequirements } from './mcpConnectionRequirements';
import { getConfiguredMcpToolExposure } from '../../services/mcp/mcpToolCatalog';
import { useT } from '../../i18n';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

export default function McpControlSettings() {
  const t = useT();
  const { config, updateConfig, saveConfig } = useAppStore(useShallow((state) => ({
    config: state.config,
    updateConfig: state.updateConfig,
    saveConfig: state.saveConfig,
  })));
  const [session, setSession] = useState<McpBridgeSessionInfo | null>(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [remoteConfirmOpen, setRemoteConfirmOpen] = useState(false);
  const portInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    getMcpBridgeStatus()
      .then(async (status) => {
        if (cancelled) return;
        setSession(status);
        // 会话已在运行（多为自动开启拉起的）时补出令牌，配置片段才能直接复制
        if (status) setToken(await ensureMcpSessionToken());
      })
      .catch(() => {
        if (!cancelled) setError(t('无法读取 MCP 会话状态'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const clientConfig = useMemo(
    () => session && token ? buildMcpClientConfig(session, token) : null,
    [session, token],
  );

  const persistConfig = (patch: Parameters<typeof updateConfig>[0]) => {
    updateConfig(patch);
    void saveConfig();
  };

  const handleStart = async () => {
    setLoading(true);
    setError('');
    setCopied(false);
    try {
      const started = await startConfiguredMcpBridge();
      setToken(started.token);
      setSession(started.session);
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

  // 轮换令牌会作废所有已发出的客户端配置；会话在运行时顺带重启，避免新旧令牌不一致。
  const handleRotateToken = async () => {
    setLoading(true);
    setError('');
    setCopied(false);
    try {
      const nextToken = await rotateMcpSessionToken();
      if (session) {
        await stopMcpBridge();
        const started = await startConfiguredMcpBridge();
        setSession(started.session);
        setToken(started.token);
      } else {
        setToken(nextToken);
      }
    } catch (rotateError) {
      setError(rotateError instanceof Error ? rotateError.message : String(rotateError));
    } finally {
      setLoading(false);
    }
  };

  // ponytail: 20000-44999 随机，避开 Windows 动态端口段（49152+）与常见服务端口。
  // 万一撞上占用，开启会话时会明确报错，再点一次即可。
  const handleRandomPort = () => {
    const next = 20000 + Math.floor(Math.random() * 25000);
    if (portInputRef.current) portInputRef.current.value = String(next);
    setError('');
    persistConfig({ mcpPort: next });
  };

  const handleCopy = async () => {
    if (!clientConfig) return;
    try {
      await navigator.clipboard.writeText(clientConfig);
      setCopied(true);
    } catch {
      setError(t('复制客户端配置失败'));
    }
  };

  const handleTransportChange = (transport: 'stdio' | 'streamable-http') => {
    if (transport === getConfiguredMcpTransport(config.mcpTransport)) return;
    if (transport === 'streamable-http') {
      setRemoteConfirmOpen(true);
      return;
    }
    setError('');
    persistConfig({ mcpTransport: transport });
  };

  const confirmRemoteTransport = () => {
    setRemoteConfirmOpen(false);
    setError('');
    persistConfig({ mcpTransport: 'streamable-http' });
  };

  const configuredPort = normalizeMcpPort(config.mcpPort);
  const configuredTransport = getConfiguredMcpTransport(config.mcpTransport);
  const portChanged = session !== null && configuredPort !== undefined && configuredPort !== session.port;
  const transportChanged = session !== null && configuredTransport !== session.transport;
  const connectionRequirements = getMcpConnectionRequirements(configuredTransport);

  if (!isTauri) {
    return (
      <div className="rounded-md border border-canvas-border bg-canvas-surface px-4 py-3 text-sm text-canvas-text-secondary">
        {t('MCP 控制仅在 Tauri 桌面应用中可用。')}
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
            {session ? t('本地控制会话已开启') : t('本地控制会话已关闭')}
          </div>
          <p className="mt-1 text-xs text-canvas-text-muted">
            {session
              ? session.transport === 'streamable-http'
                ? t('远程 HTTP 端口 {port}{mode}', { port: session.port, mode: configuredPort === undefined ? t('（随机）') : t('（固定）') })
                : t('回环端口 {port}{mode}', { port: session.port, mode: configuredPort === undefined ? t('（随机）') : t('（固定）') })
              : config.mcpAutoStart ? t('启动软件时自动开启') : t('默认关闭')}
          </p>
        </div>
        <AnimatedButton
          type="button"
          className="settings-save-btn shrink-0 text-xs"
          onClick={session ? handleStop : handleStart}
          disabled={loading}
        >
          <Icon icon={session ? 'lucide:power-off' : 'lucide:power'} width="14" height="14" />
          {loading ? t('处理中') : session ? t('停止') : t('开启')}
        </AnimatedButton>
      </div>

      <div className="ui-field rounded-md border border-canvas-border bg-canvas-card px-3 py-2.5">
        <label className="ui-label" htmlFor="mcp-tool-exposure">{t('工具发现方式')}</label>
        <div className="ui-select">
          <select
            id="mcp-tool-exposure"
            className="ui-select__control"
            aria-describedby="mcp-tool-exposure-hint"
            value={getConfiguredMcpToolExposure(config.mcpToolExposure)}
            disabled={loading}
            onChange={(event) => persistConfig({ mcpToolExposure: getConfiguredMcpToolExposure(event.target.value) })}
          >
            <option value="compact">{t('按需发现（推荐）')}</option>
            <option value="full">{t('完整工具列表')}</option>
          </select>
        </div>
        <p className="ui-hint">{t('按需模式减少初始工具说明的上下文占用；完整模式适合已支持工具延迟加载的客户端。')}</p>
        <p id="mcp-tool-exposure-hint" className="ui-hint">{t('切换后请在 MCP 客户端刷新工具列表或重新连接；已有对话的上下文不会自动清除。')}</p>
      </div>

      <label className="flex items-start gap-3 rounded-md border border-canvas-border bg-canvas-card px-3 py-2.5">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-500"
          checked={config.mcpAutoStart === true}
          onChange={(event) => persistConfig({ mcpAutoStart: event.target.checked })}
        />
        <span className="min-w-0">
          <span className="block text-xs font-medium text-canvas-text">{t('启动软件时自动开启')}</span>
          <span className="mt-0.5 block text-[11px] text-canvas-text-muted">
            {t('外部客户端无需每次手动开启会话；令牌固定保存在本机凭据存储中。')}
          </span>
        </span>
      </label>

      <div className="rounded-md border border-canvas-border bg-canvas-card px-3 py-2.5">
        <div className="text-xs font-medium text-canvas-text">{t('连接传输')}</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            className={`rounded-md border px-3 py-2 text-left transition-colors ${configuredTransport === 'stdio' ? 'border-indigo-500/60 bg-indigo-500/10 text-canvas-text' : 'border-canvas-border bg-canvas-surface text-canvas-text-secondary hover:bg-canvas-hover'}`}
            onClick={() => handleTransportChange('stdio')}
          >
            <span className="block text-xs font-medium">{t('本机 stdio')}</span>
            <span className="mt-0.5 block text-[11px] text-canvas-text-muted">{t('只允许本机客户端通过 127.0.0.1 连接')}</span>
          </button>
          <button
            type="button"
            className={`rounded-md border px-3 py-2 text-left transition-colors ${configuredTransport === 'streamable-http' ? 'border-red-500/60 bg-red-500/10 text-canvas-text' : 'border-canvas-border bg-canvas-surface text-canvas-text-secondary hover:bg-canvas-hover'}`}
            onClick={() => handleTransportChange('streamable-http')}
          >
            <span className="block text-xs font-medium">{t('远程 Streamable HTTP')}</span>
            <span className="mt-0.5 block text-[11px] text-canvas-text-muted">{t('监听 0.0.0.0，允许其他机器或 Docker 连接')}</span>
          </button>
        </div>
        {transportChanged && (
          <p className="mt-2 text-[11px] text-amber-300">{t('传输方式将在下次开启会话时生效。')}</p>
        )}
      </div>

      {configuredTransport === 'streamable-http' && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-xs leading-relaxed text-red-200">
          <div className="font-medium">{t('远程 MCP 以最大权限运行')}</div>
          <p className="mt-1 text-[11px] text-red-200/80">
            {t('已连接的客户端可自动删除项目、写入文件、修改配置和调用付费媒体模型，不会出现逐次审批。仅在受信网络或隔离环境中开启。')}
          </p>
        </div>
      )}

      <div className="rounded-md border border-canvas-border bg-canvas-card px-3 py-2.5">
        <div className="text-xs font-medium text-canvas-text">
          {configuredTransport === 'streamable-http' ? t('固定 HTTP 端口') : t('固定回环端口')}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            ref={portInputRef}
            type="number"
            min={1024}
            max={65535}
            placeholder={t('留空则每次随机分配')}
            defaultValue={configuredPort ?? ''}
            className="min-w-0 flex-1 rounded-md border border-canvas-border bg-canvas-surface px-3 py-2 text-sm text-canvas-text placeholder-canvas-text-muted transition-colors focus:border-indigo-500 focus:outline-none"
            onBlur={(event) => {
              const raw = event.target.value.trim();
              const next = raw ? normalizeMcpPort(raw) : undefined;
              if (raw && next === undefined) {
                setError(t('端口需在 1024-65535 之间'));
                event.target.value = String(configuredPort ?? '');
                return;
              }
              setError('');
              event.target.value = next ? String(next) : '';
              persistConfig({ mcpPort: next });
            }}
          />
          <button
            type="button"
            className="inline-flex h-[38px] shrink-0 items-center gap-1.5 rounded-md border border-canvas-border bg-canvas-surface px-3 text-xs text-canvas-text-secondary transition-colors hover:bg-canvas-hover hover:text-canvas-text"
            onClick={handleRandomPort}
            title={t('随机挑一个固定端口')}
          >
            <Icon icon="lucide:dices" width="14" height="14" />
            {t('随机')}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-canvas-text-muted">
          {t('固定端口后客户端配置不再变化，写一次即可。')}
          {portChanged ? t(' 新端口在下次开启会话时生效。') : ''}
        </p>
      </div>

      {session && !token && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {t('本页没有当前令牌。停止后重新开启以生成新的客户端配置。')}
        </div>
      )}

      {clientConfig && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-canvas-text-secondary">{t('客户端配置片段')}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-canvas-text-secondary transition-colors hover:bg-canvas-hover hover:text-canvas-text disabled:opacity-50"
                onClick={handleRotateToken}
                disabled={loading}
                title={t('生成新令牌，旧配置立即失效')}
              >
                <Icon icon="lucide:refresh-cw" width="12" height="12" />
                {t('重置令牌')}
              </button>
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-canvas-text-secondary transition-colors hover:bg-canvas-hover hover:text-canvas-text"
                onClick={handleCopy}
                aria-label={t('复制 MCP 客户端配置')}
                title={t('复制客户端配置')}
              >
                <Icon icon={copied ? 'lucide:check' : 'lucide:copy'} width="14" height="14" />
              </button>
            </div>
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-canvas-border bg-canvas-bg px-3 py-2 text-[11px] leading-relaxed text-canvas-text-secondary select-all">
            {clientConfig}
          </pre>
          <p className="text-[11px] text-canvas-text-muted">
            {t('粘贴到 Claude Desktop / Cursor 等客户端的 MCP 配置中。会话未开启时客户端调用会报错，重新开启即可继续用同一份配置。')}
          </p>
          {session?.transport === 'streamable-http' && (
            <p className="text-[11px] text-amber-300">
              {t('复制前请把 <AI_CANVAS_IP> 替换为运行 AI Canvas 电脑的局域网 IP。不同客户端的 HTTP 配置字段可能略有差异。')}
            </p>
          )}
        </div>
      )}

      <section
        className="rounded-md border border-canvas-border bg-canvas-card px-3 py-3"
        aria-labelledby="mcp-connection-requirements-title"
      >
        <div className="flex items-center gap-2">
          <Icon icon="lucide:circle-check-big" width="14" height="14" className="text-indigo-400" />
          <h3 id="mcp-connection-requirements-title" className="text-xs font-medium text-canvas-text">
            {t('连接环境要求')}
          </h3>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {connectionRequirements.map((requirement) => (
            <div key={requirement.title} className="flex items-start gap-2 rounded-md bg-canvas-surface px-2.5 py-2">
              <Icon
                icon={requirement.icon}
                width="14"
                height="14"
                className="mt-0.5 shrink-0 text-canvas-text-secondary"
              />
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-canvas-text">{t(requirement.title)}</div>
                <p className="mt-0.5 text-[11px] leading-relaxed text-canvas-text-muted">
                  {t(requirement.description)}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 border-t border-canvas-border pt-2.5 text-[11px] leading-relaxed text-canvas-text-muted">
          <p>
            <span className="font-medium text-canvas-text-secondary">{t('首次连接：')}</span>
            {t('开启会话 → 复制上方配置 → 粘贴到客户端的 MCP 配置中 → 完全重启客户端。')}
          </p>
          <p className="mt-1">
            {t('修改端口或重置令牌后，需要重新复制配置并重启客户端。调用联网、云端模型或本地模型功能时，还需提前配置对应的网络、API Key 或模型环境。')}
          </p>
        </div>
      </section>

      {session && token && !clientConfig && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {t('未找到本地 MCP 适配器脚本。')}
        </div>
      )}

      <ModalOverlay
        isOpen={remoteConfirmOpen}
        onClose={() => setRemoteConfirmOpen(false)}
        ariaLabel={t('确认开启远程 MCP')}
        closeOnBackdrop={false}
        className="w-[min(520px,calc(100vw-32px))] bg-canvas-surface"
      >
        <div className="border-b border-canvas-border px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-red-300">
            <Icon icon="lucide:shield-alert" width="18" height="18" />
            {t('确认暴露远程 MCP 服务')}
          </div>
        </div>
        <div className="space-y-3 px-5 py-4 text-xs leading-relaxed text-canvas-text-secondary">
          <p>{t('服务将监听 0.0.0.0，局域网内能够到达该端口的设备都可以尝试连接。')}</p>
          <p>{t('持有 Bearer Token 的客户端按自主模式运行，可无审批执行永久删除、文件写入、配置写入和付费媒体生成。')}</p>
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200">
            {t('请确认运行在受信网络、Docker 或其他隔离环境中，并继续保留独立备份。')}
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-canvas-border px-5 py-3">
          <button
            type="button"
            className="rounded-md border border-canvas-border px-3 py-2 text-xs text-canvas-text-secondary hover:bg-canvas-hover"
            onClick={() => setRemoteConfirmOpen(false)}
          >
            {t('取消')}
          </button>
          <button
            type="button"
            className="rounded-md bg-red-500 px-3 py-2 text-xs font-medium text-white hover:bg-red-400"
            onClick={confirmRemoteTransport}
          >
            {t('我了解风险，切换到远程模式')}
          </button>
        </div>
      </ModalOverlay>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
