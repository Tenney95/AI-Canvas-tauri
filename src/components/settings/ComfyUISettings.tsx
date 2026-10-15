/**
 * settings/ComfyUISettings — ComfyUI 设置子页。
 * 配置 ComfyUI 服务地址、启动 / 停止本地 ComfyUI、探测服务状态，
 * 并提供工作流面板入口与相关目录选择。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { invoke } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import type { ComfyMemoryPolicy, ComfyServer } from '../../types';
import AnimatedButton from '../shared/AnimatedButton';
import Select from '../shared/Select';
import { useT } from '../../i18n';
import {
  getComfyInstallation,
  openComfyManagementWindow,
  selectComfyInstallation,
} from '../../services/comfyManagementService';
import { getComfyUIRuntimeStatus, launchComfyUI } from '../../services/comfyRuntimeService';
import { syncComfyRuntimeUrl } from '../../services/comfyRuntimeHostSync';
import { getAppearanceForConfig } from '../../services/appearance/appearanceMigration';
import {
  DEFAULT_COMFY_URL,
  probeComfyServer,
  type ComfyServerAvailability,
} from '../../services/comfyServers';
import {
  fetchComfyMemoryStats,
  releaseComfyMemory,
  type ComfyMemoryReleaseMode,
  type ComfyMemoryStats,
} from '../../services/comfyMemory';

type ComfyStatus = 'idle' | 'starting' | 'ready' | 'failed';

const INPUT_CLASS = 'text-xs bg-canvas-surface border border-canvas-border rounded-md px-2.5 py-1.5 text-canvas-text placeholder-canvas-text-muted focus:outline-none focus:border-indigo-500 transition-colors';
const COMFY_ACTION_BUTTON_CLASS = 'ui-btn ui-btn--sm ui-btn--block min-w-0 [&>svg]:shrink-0';
const DEFAULT_SERVER_STATUS_KEY = '__default__';
const STATUS_REFRESH_INTERVAL_MS = 15_000;
const STATUS_DEBOUNCE_MS = 250;

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

async function syncInstallationMirror(path: string): Promise<void> {
  const state = useAppStore.getState();
  if (state.config.comfyUIPath?.trim() !== path) state.updateConfig({ comfyUIPath: path });
  else if (state.configEditBaseline.comfyUIPath === path) return;
  try {
    await state.saveConfig({ silent: true, throwOnError: true });
  } catch {
    throw new Error('ComfyUI 目录已由应用记住，但配置镜像保存失败，请重试');
  }
}

async function resolveInstallationPath(): Promise<string | undefined> {
  const path = await getComfyInstallation();
  if (path) {
    await syncInstallationMirror(path);
    return path;
  }
  // 旧记录仅作一次迁移输入；是否授权仍由原生启动/管理命令决定。
  return useAppStore.getState().config.comfyUIPath?.trim();
}

interface ServerStatusEntry {
  url: string;
  availability: ComfyServerAvailability;
}

function ServerStatusLight({
  availability,
  label,
}: {
  availability: ComfyServerAvailability;
  label: string;
}) {
  const colorClass = availability === 'available'
    ? 'bg-emerald-400 ring-emerald-400/25'
    : availability === 'unavailable'
      ? 'bg-red-400 ring-red-400/25'
      : 'bg-amber-400 ring-amber-400/25 animate-pulse';

  return (
    <span
      className="pointer-events-none absolute inset-y-0 right-0 z-10 inline-flex w-9 items-center justify-center"
      aria-label={label}
      role="status"
    >
      <span className={`h-2.5 w-2.5 rounded-full ring-2 shadow-sm ${colorClass}`} />
    </span>
  );
}

export default function ComfyUISettings() {
  const {
    config,
    updateConfig,
    saveConfig,
    workflows,
    setSettingsOpen,
    setWorkflowPanelOpen,
    showToast,
  } = useAppStore(useShallow((state) => ({
    config: state.config,
    updateConfig: state.updateConfig,
    saveConfig: state.saveConfig,
    workflows: state.workflows,
    setSettingsOpen: state.setSettingsOpen,
    setWorkflowPanelOpen: state.setWorkflowPanelOpen,
    showToast: state.showToast,
  })));
  const t = useT();
  const [launching, setLaunching] = useState(false);
  const [opening, setOpening] = useState(false);
  const [managing, setManaging] = useState(false);
  const [choosingPath, setChoosingPath] = useState(false);
  const choosingPathRef = useRef(false);
  const [status, setStatus] = useState<ComfyStatus>('idle');
  const [serverStatuses, setServerStatuses] = useState<Record<string, ServerStatusEntry>>({});
  const [memoryTargetKey, setMemoryTargetKey] = useState(DEFAULT_SERVER_STATUS_KEY);
  const [memorySnapshot, setMemorySnapshot] = useState<{
    url: string;
    stats?: ComfyMemoryStats;
    error?: string;
  } | null>(null);
  const [memoryAction, setMemoryAction] = useState<'refresh' | ComfyMemoryReleaseMode | null>(null);
  const comfyUIPath = config.comfyUIPath;
  const servers = useMemo(() => config.comfyServers ?? [], [config.comfyServers]);
  const memoryTargets = useMemo(() => [
    {
      key: DEFAULT_SERVER_STATUS_KEY,
      name: t('默认服务器'),
      url: config.comfyUIUrl?.trim() || DEFAULT_COMFY_URL,
    },
    ...servers.map((server) => ({ key: server.id, name: server.name || t('未命名服务端'), url: server.url.trim() })),
  ], [config.comfyUIUrl, servers, t]);
  const memoryTarget = memoryTargets.find((target) => target.key === memoryTargetKey) ?? memoryTargets[0];
  const memoryStats = memorySnapshot?.url === memoryTarget.url ? memorySnapshot.stats ?? null : null;
  const memoryError = memorySnapshot?.url === memoryTarget.url ? memorySnapshot.error ?? null : null;

  useEffect(() => {
    let disposed = false;
    const previousPath = useAppStore.getState().config.comfyUIPath?.trim();
    void getComfyInstallation().then(async (path) => {
      if (disposed || !path) return;
      // 挂载期间的新选择优先，不让迟到的旧恢复结果覆盖它。
      if (useAppStore.getState().config.comfyUIPath?.trim() !== previousPath) return;
      await syncInstallationMirror(path);
    }).catch(() => {
      // 保留原显示与原生错误；用户点击启动/设置时会重新读取并显示准确原因。
      // 配置镜像保存失败已由 Store 提示，不在后台输出路径。
    });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchComfyMemoryStats(memoryTarget.url, controller.signal).then(
      (stats) => {
        if (!controller.signal.aborted) setMemorySnapshot({ url: memoryTarget.url, stats });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setMemorySnapshot({
            url: memoryTarget.url,
            error: error instanceof Error ? error.message : t('读取显存状态失败'),
          });
        }
      },
    );
    return () => controller.abort();
  }, [memoryTarget.url, t]);

  useEffect(() => {
    const controller = new AbortController();
    let refreshTimer: number | undefined;
    const targets = [
      {
        key: DEFAULT_SERVER_STATUS_KEY,
        url: config.comfyUIUrl?.trim() || DEFAULT_COMFY_URL,
      },
      ...servers.map((server) => ({ key: server.id, url: server.url.trim() })),
    ];

    const refresh = async (showChecking: boolean) => {
      if (showChecking) {
        setServerStatuses((current) => ({
          ...current,
          ...Object.fromEntries(targets.map(({ key, url }) => [
            key,
            { url, availability: 'checking' as const },
          ])),
        }));
      }
      await Promise.all(targets.map(async ({ key, url }) => {
        const available = await probeComfyServer(url, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setServerStatuses((current) => {
          if (current[key]?.url !== url) return current;
          return {
            ...current,
            [key]: { url, availability: available ? 'available' : 'unavailable' },
          };
        });
      }));
      if (!controller.signal.aborted) {
        refreshTimer = window.setTimeout(() => void refresh(false), STATUS_REFRESH_INTERVAL_MS);
      }
    };

    const debounceTimer = window.setTimeout(() => void refresh(true), STATUS_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(debounceTimer);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [config.comfyUIUrl, servers]);

  const statusLabel = (availability: ComfyServerAvailability) => {
    if (availability === 'available') return t('ComfyUI 服务已就绪');
    if (availability === 'unavailable') return t('服务未就绪，可在设置与管理的运行输出中查看日志');
    return t('正在等待 ComfyUI 服务就绪，首次启动可能需要几分钟时间…');
  };

  const availabilityFor = (key: string, url: string): ComfyServerAvailability => {
    const entry = serverStatuses[key];
    return entry?.url === url ? entry.availability : 'checking';
  };

  const openComfyUI = async (targetUrl?: string) => {
    const comfyUrl = targetUrl || config.comfyUIUrl?.trim() || 'http://127.0.0.1:8188';
    setOpening(true);
    try {
      await invoke<void>('open_comfyui_window', { comfyUrl });
    } catch (error) {
      showToast(typeof error === 'string' ? error : t('打开 ComfyUI 页面失败'), 'error');
    } finally {
      setOpening(false);
    }
  };

  const openManagement = async () => {
    if (choosingPathRef.current || managing) return;
    setManaging(true);
    try {
      const comfyPath = await resolveInstallationPath();
      if (!comfyPath) {
        showToast(t('请先设置 ComfyUI 安装目录'), 'error');
        return;
      }
      const latestConfig = useAppStore.getState().config;
      const appearance = latestConfig.appearance ?? getAppearanceForConfig(latestConfig);
      await openComfyManagementWindow(comfyPath, {
        appearance: {
          ...appearance,
          canvas: { ...appearance.canvas, imageDataUrl: undefined },
          handle: { ...appearance.handle, imageDataUrl: undefined },
        },
        language: latestConfig.language ?? null,
        nativeCursor: latestConfig.customCursor === false,
      });
    } catch (error) {
      showToast(typeof error === 'string' ? error : error instanceof Error ? error.message : t('打开 ComfyUI 管理窗口失败'), 'error');
    } finally { setManaging(false); }
  };

  const choosePath = async () => {
    if (choosingPathRef.current || launching || managing) return;
    choosingPathRef.current = true;
    setChoosingPath(true);
    try {
      const selected = await selectComfyInstallation();
      if (selected) await syncInstallationMirror(selected);
    } catch (error) {
      showToast(typeof error === 'string' ? error : error instanceof Error ? error.message : t('选择 ComfyUI 安装目录失败'), 'error');
    } finally {
      choosingPathRef.current = false;
      setChoosingPath(false);
    }
  };

  const launch = async () => {
    if (choosingPathRef.current || launching || managing) return;
    setLaunching(true);
    setStatus('starting');
    try {
      const comfyPath = await resolveInstallationPath();
      if (!comfyPath) {
        setStatus('idle');
        showToast(t('请先设置 ComfyUI 安装目录'), 'error');
        return;
      }
      const runtime = await launchComfyUI(comfyPath);
      if (runtime.status === 'failed' || runtime.status === 'exited') throw new Error(runtime.message);
      await syncComfyRuntimeUrl(runtime.port, comfyPath);
      const base = `http://127.0.0.1:${runtime.port}`;
      const deadline = Date.now() + 300_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (useAppStore.getState().config.comfyUIPath?.trim() !== comfyPath) {
          throw new Error(t('ComfyUI 安装目录已变更，请在设置与管理中查看当前运行状态'));
        }
        if (runtime.runId && runtime.status !== 'external') {
          const current = await getComfyUIRuntimeStatus();
          if (current.runId !== runtime.runId || current.port !== runtime.port) {
            throw new Error(t('ComfyUI 运行实例已变更，请在设置与管理中查看运行输出'));
          }
          if (current.status === 'failed' || current.status === 'exited') throw new Error(current.message);
        }
        if (await probeComfyServer(base)) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      setStatus(ready ? 'ready' : 'failed');
      if (ready) {
        if (useAppStore.getState().config.comfyUIPath?.trim() !== comfyPath) {
          throw new Error(t('ComfyUI 安装目录已变更，请在设置与管理中查看当前运行状态'));
        }
        await openComfyUI(base);
      }
      showToast(
        ready ? t('ComfyUI 服务已就绪') : t('等待 ComfyUI 服务就绪超时，请在设置与管理中查看运行输出'),
        ready ? 'success' : 'error',
      );
    } catch (error) {
      setStatus('failed');
      showToast(typeof error === 'string' ? error : error instanceof Error ? error.message : t('启动 ComfyUI 失败'), 'error');
    } finally {
      setLaunching(false);
    }
  };

  const saveServers = async (next: ComfyServer[]) => {
    updateConfig({ comfyServers: next });
    await saveConfig().catch(() => {});
  };

  const addServer = () => saveServers([
    ...servers,
    { id: crypto.randomUUID(), name: t('服务端 {index}', { index: servers.length + 1 }), url: '' },
  ]);

  const patchServer = (id: string, patch: Partial<ComfyServer>) => saveServers(
    servers.map((server) => (server.id === id ? { ...server, ...patch } : server)),
  );

  const removeServer = (id: string) => saveServers(servers.filter((server) => server.id !== id));

  const refreshMemoryStats = async () => {
    setMemoryAction('refresh');
    setMemorySnapshot(null);
    try {
      setMemorySnapshot({ url: memoryTarget.url, stats: await fetchComfyMemoryStats(memoryTarget.url) });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('读取显存状态失败');
      setMemorySnapshot({ url: memoryTarget.url, error: message });
      showToast(message, 'error');
    } finally {
      setMemoryAction(null);
    }
  };

  const releaseMemory = async (mode: ComfyMemoryReleaseMode) => {
    setMemoryAction(mode);
    setMemorySnapshot(null);
    try {
      await releaseComfyMemory(memoryTarget.url, mode);
      showToast(
        mode === 'free-memory'
          ? t('已请求完全释放 ComfyUI 资源')
          : t('已请求卸载 ComfyUI 模型'),
        'success',
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      setMemorySnapshot({ url: memoryTarget.url, stats: await fetchComfyMemoryStats(memoryTarget.url) });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('释放 ComfyUI 资源失败');
      setMemorySnapshot({ url: memoryTarget.url, error: message });
      showToast(message, 'error');
    } finally {
      setMemoryAction(null);
    }
  };

  const saveMemoryPolicy = async (policy: ComfyMemoryPolicy) => {
    updateConfig({ comfyMemoryPolicy: policy });
    await saveConfig().catch(() => {});
  };

  const openWorkflows = () => {
    setSettingsOpen(false);
    setWorkflowPanelOpen(true);
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-canvas-text mb-2">{t('ComfyUI 安装目录')}</h3>
        <div className="bg-canvas-card border border-canvas-border rounded-lg p-2">
          <div className="text-xs text-canvas-text-muted mb-1.5">{t('ComfyUI 根目录路径')}</div>
          <div className="flex items-center gap-2 mb-3">
            <div className={`flex-1 min-w-0 text-[11px] leading-4 break-all bg-canvas-surface rounded-md px-2.5 py-1 border border-canvas-border ${
              comfyUIPath ? 'text-canvas-text-secondary font-mono select-all' : 'text-canvas-text-muted italic'
            }`}>
              {comfyUIPath || t('未设置')}
            </div>
            <AnimatedButton type="button" className="settings-save-btn self-stretch shrink-0 text-xs" onClick={choosePath} disabled={choosingPath || launching || managing}>
              {choosingPath ? t('正在选择…') : comfyUIPath ? t('更换') : t('选择文件夹')}
            </AnimatedButton>
          </div>
          <p className="text-[11px] text-canvas-text-muted leading-relaxed mb-3">
            {t('选择 ComfyUI 的安装根目录，支持 GitHub 源码版 / 秋叶整合包 / 官方便携版 / Comfy Desktop（选安装基目录，如 F:\\ComfyUI）。将以 API 模式直接启动，跳过启动器检测')}
          </p>
          <div className="pt-2 border-t border-canvas-border">
            <div className="grid grid-cols-3 gap-2">
              <AnimatedButton
                type="button"
                className={`${COMFY_ACTION_BUTTON_CLASS} [&.ui-btn]:border-transparent [&.ui-btn]:bg-purple-500/15 [&.ui-btn]:text-purple-400 [&.ui-btn:hover:not(:disabled):not(.is-active)]:border-transparent [&.ui-btn:hover:not(:disabled):not(.is-active)]:bg-purple-500/25 [&.ui-btn:hover:not(:disabled):not(.is-active)]:text-purple-400`}
                onClick={launch}
                disabled={launching || managing || choosingPath}
              >
                {launching ? (
                  <>
                    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
                    </svg>
                    {t('正在启动…')}
                  </>
                ) : (
                  <>
                    <Icon icon="lucide:play" width="14" height="14" />
                    {t('启动 ComfyUI')}
                  </>
                )}
              </AnimatedButton>
              <AnimatedButton
                type="button"
                className={`${COMFY_ACTION_BUTTON_CLASS} ui-btn--secondary`}
                onClick={() => void openManagement()}
                disabled={managing || choosingPath}
              >
                <Icon icon={managing ? 'lucide:loader-circle' : 'lucide:settings'} width="14" height="14" className={managing ? 'animate-spin' : ''} />
                {t('设置')}
              </AnimatedButton>
              <AnimatedButton
                type="button"
                className={`${COMFY_ACTION_BUTTON_CLASS} ui-btn--secondary [&.ui-btn]:text-canvas-text-secondary [&.ui-btn:hover:not(:disabled):not(.is-active)]:text-canvas-text`}
                onClick={() => void openComfyUI()}
                disabled={opening}
              >
                <Icon icon={opening ? 'lucide:loader-circle' : 'lucide:external-link'} width="14" height="14" className={opening ? 'animate-spin' : ''} />
                {t('打开 ComfyUI 页面')}
              </AnimatedButton>
            </div>
            {status === 'starting' && <p className="text-[11px] text-canvas-text-secondary mt-2 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />{t('正在等待 ComfyUI 服务就绪，可打开设置查看实时运行输出')}</p>}
            {status === 'ready' && <p className="text-[11px] text-emerald-400 mt-2 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />{t('ComfyUI 服务已就绪（{url}），可以开始使用', { url: config.comfyUIUrl?.trim() || 'http://127.0.0.1:8188' })}</p>}
            {status === 'failed' && <p className="text-[11px] text-red-400 mt-2 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />{t('服务未就绪，可在设置与管理的运行输出中查看日志')}</p>}
            {status === 'idle' && <p className="text-[11px] text-canvas-text-muted mt-2">{t('服务就绪后会自动在软件内打开 ComfyUI 窗口，也可以使用右侧按钮手动打开')}</p>}
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-canvas-text mb-2">{t('ComfyUI 显存与缓存')}</h3>
        <div className="bg-canvas-card border border-canvas-border rounded-lg p-2 space-y-3">
          <div className="flex items-center gap-2">
            <Select
              fixedMenu
              size="sm"
              className="min-w-0 flex-1"
              value={memoryTarget.key}
              onChange={setMemoryTargetKey}
              options={memoryTargets.map((target) => ({ value: target.key, label: target.name }))}
              aria-label={t('显存状态服务端')}
            />
            <button
              type="button"
              className="ui-btn ui-btn--secondary ui-btn--sm shrink-0"
              onClick={() => void refreshMemoryStats()}
              disabled={memoryAction !== null}
            >
              <Icon icon={memoryAction === 'refresh' ? 'lucide:loader-circle' : 'lucide:refresh-cw'} width="13" height="13" className={memoryAction === 'refresh' ? 'animate-spin' : ''} />
              {t('刷新')}
            </button>
          </div>

          {memoryStats ? (
            <div className="space-y-2">
              {memoryStats.devices.map((device, index) => (
                <div key={`${device.type}-${device.index ?? index}`} className="rounded-md border border-canvas-border bg-canvas-surface px-2.5 py-2">
                  <div className="text-xs font-medium text-canvas-text break-all">{device.name}</div>
                  <div className="mt-1 text-[11px] text-canvas-text-secondary">
                    {t('显存已用 {used} / {total}，设备空闲 {free}', {
                      used: formatGiB(Math.max(0, device.vramTotal - device.vramFree)),
                      total: formatGiB(device.vramTotal),
                      free: formatGiB(device.vramFree),
                    })}
                  </div>
                  {device.torchVramFree !== undefined && (
                    <div className="mt-0.5 text-[11px] text-canvas-text-muted">
                      {t('PyTorch 报告空闲 {free}', { free: formatGiB(device.torchVramFree) })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : memoryError ? (
            <p className="text-[11px] text-red-400 leading-relaxed">{memoryError}</p>
          ) : (
            <p className="text-[11px] text-canvas-text-muted">{t('正在读取显存状态…')}</p>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="ui-btn ui-btn--secondary ui-btn--sm"
              onClick={() => void releaseMemory('unload-models')}
              disabled={memoryAction !== null}
            >
              <Icon icon={memoryAction === 'unload-models' ? 'lucide:loader-circle' : 'lucide:package-minus'} width="13" height="13" className={memoryAction === 'unload-models' ? 'animate-spin' : ''} />
              {t('卸载模型')}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn--danger ui-btn--sm"
              onClick={() => void releaseMemory('free-memory')}
              disabled={memoryAction !== null}
            >
              <Icon icon={memoryAction === 'free-memory' ? 'lucide:loader-circle' : 'lucide:eraser'} width="13" height="13" className={memoryAction === 'free-memory' ? 'animate-spin' : ''} />
              {t('完全释放')}
            </button>
          </div>
          <p className="text-[11px] text-canvas-text-muted leading-relaxed">
            {t('释放操作作用于整台 ComfyUI 服务；任务运行中时会在服务空闲后执行。完全释放会同时清空执行缓存，下次生成需要重新加载模型。')}
          </p>

          <div className="pt-3 border-t border-canvas-border">
            <label className="block text-xs text-canvas-text-muted mb-1.5" htmlFor="comfy-memory-policy">
              {t('本地任务结束后')}
            </label>
            <Select
              fixedMenu
              size="sm"
              id="comfy-memory-policy"
              className="w-full"
              value={config.comfyMemoryPolicy ?? 'smart'}
              onChange={(value) => void saveMemoryPolicy(value as ComfyMemoryPolicy)}
              options={[
                { value: 'smart', label: t('保留智能缓存（推荐）') },
                { value: 'unload-models', label: t('队列空闲时卸载模型') },
                { value: 'free-memory', label: t('队列空闲时完全释放') },
              ]}
            />
            <p className="text-[11px] text-canvas-text-muted mt-2 leading-relaxed">
              {t('自动策略只对 localhost、127.0.0.1 或 ::1 生效，不会自动清理远程或共享服务器。')}
            </p>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-canvas-text mb-2">{t('ComfyUI 服务地址')}</h3>
        <div className="bg-canvas-card border border-canvas-border rounded-lg p-2">
          <div className="text-xs text-canvas-text-muted mb-1.5">{t('默认地址')}</div>
          <div className="relative">
            <input
              type="text"
              className={`${INPUT_CLASS} w-full pr-9`}
              placeholder="http://127.0.0.1:8188"
              defaultValue={config.comfyUIUrl || ''}
              onBlur={async (event) => {
                updateConfig({ comfyUIUrl: event.target.value });
                await saveConfig().catch(() => {});
              }}
            />
            <ServerStatusLight
              availability={availabilityFor(
                DEFAULT_SERVER_STATUS_KEY,
                config.comfyUIUrl?.trim() || DEFAULT_COMFY_URL,
              )}
              label={statusLabel(availabilityFor(
                DEFAULT_SERVER_STATUS_KEY,
                config.comfyUIUrl?.trim() || DEFAULT_COMFY_URL,
              ))}
            />
          </div>
          <p className="text-[11px] text-canvas-text-muted mt-2">{t('ComfyUI 后端服务的地址，用于执行导入的工作流。默认端口为 8188')}</p>

          <div className="mt-3 pt-3 border-t border-canvas-border">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-canvas-text-muted">{t('其他服务端')}</span>
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
                onClick={() => void addServer()}
              >
                <Icon icon="lucide:plus" width="13" height="13" />
                {t('添加服务端')}
              </button>
            </div>
            {servers.length === 0 ? (
              <p className="text-[11px] text-canvas-text-muted">
                {t('图片与视频分开部署时，在这里添加另一台服务端，再到「工作流管理」里把工作流绑定过去')}
              </p>
            ) : (
              <div className="space-y-2">
                {servers.map((server) => (
                  <div key={server.id} className="flex items-center gap-2">
                    <input
                      type="text"
                      className={`${INPUT_CLASS} w-28 shrink-0`}
                      placeholder={t('服务端名称')}
                      defaultValue={server.name}
                      onBlur={(event) => void patchServer(server.id, { name: event.target.value.trim() })}
                    />
                    <div className="relative min-w-0 flex-1">
                      <input
                        type="text"
                        className={`${INPUT_CLASS} w-full pr-9`}
                        placeholder="http://127.0.0.1:8189"
                        defaultValue={server.url}
                        onBlur={(event) => void patchServer(server.id, { url: event.target.value.trim() })}
                      />
                      <ServerStatusLight
                        availability={availabilityFor(server.id, server.url.trim())}
                        label={statusLabel(availabilityFor(server.id, server.url.trim()))}
                      />
                    </div>
                    <button
                      type="button"
                      className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-canvas-text-muted hover:bg-red-500/10 hover:text-red-400 transition-colors"
                      aria-label={t('删除服务端')}
                      data-tooltip={t('删除服务端')}
                      onClick={() => void removeServer(server.id)}
                    >
                      <Icon icon="lucide:trash-2" width="14" height="14" />
                    </button>
                  </div>
                ))}
                <p className="text-[11px] text-canvas-text-muted">
                  {t('在「工作流管理」里给工作流选择服务端；删掉服务端后，绑过它的工作流回落到默认地址')}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-canvas-text mb-2">{t('ComfyUI 工作流')}</h3>
        <div className="bg-canvas-card border border-canvas-border rounded-lg p-2 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-purple-500/15 text-purple-400 flex items-center justify-center shrink-0">
            <Icon icon="lucide:workflow" width="18" height="18" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-canvas-text">{t('工作流管理')}</div>
            <div className="text-[11px] text-canvas-text-muted mt-0.5">{t('已导入 {count} 个工作流', { count: workflows.length })}</div>
          </div>
          <AnimatedButton type="button" className="settings-save-btn shrink-0 text-xs flex items-center gap-1.5" onClick={openWorkflows}>
            {t('管理工作流')}
            <Icon icon="lucide:chevron-right" width="14" height="14" />
          </AnimatedButton>
        </div>
      </div>
    </div>
  );
}
