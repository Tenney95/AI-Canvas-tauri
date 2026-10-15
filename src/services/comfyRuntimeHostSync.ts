/** 主窗口负责将原生运行实例的实际端口同步到画布服务配置。 */
import { useAppStore } from '../store/useAppStore';
import { getComfyUIRuntimeStatus } from './comfyRuntimeService';

const RUNTIME_STARTED_EVENT = 'comfyui-runtime-started';
let pendingSync: { port: number; installation: string | undefined; promise: Promise<void> } | undefined;

function isLocalComfyPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/** 原生启动响应和主窗口通知复用同一次保存，不将运行输出写入配置。 */
export function syncComfyRuntimeUrl(port: number, installation: string | undefined): Promise<void> {
  if (!isLocalComfyPort(port)) return Promise.reject(new Error('ComfyUI 返回的运行端口无效'));
  if (pendingSync?.port === port && pendingSync.installation === installation) return pendingSync.promise;
  const operation = async () => {
    const state = useAppStore.getState();
    if (state.config.comfyUIPath?.trim() !== installation) return;
    if (!state.configHydrated) throw new Error('配置尚未加载，无法同步 ComfyUI 服务地址');
    const url = `http://127.0.0.1:${port}`;
    if (state.config.comfyUIUrl?.trim() !== url) state.updateConfig({ comfyUIUrl: url });
    const latest = useAppStore.getState();
    if (latest.config.comfyUIUrl?.trim() !== url) return;
    if (latest.configEditBaseline.comfyUIUrl === url) return;
    await latest.saveConfig({ silent: true, throwOnError: true });
  };
  const promise = operation().finally(() => {
    if (pendingSync?.promise === promise) pendingSync = undefined;
  });
  pendingSync = { port, installation, promise };
  return promise;
}

/** 事件仅用于唤醒；以主窗口专用原生命令核对实际实例后才写入 Store。 */
export async function initComfyRuntimeHostSync(): Promise<() => void> {
  if (typeof window === 'undefined' || !('__TAURI__' in window)) return () => undefined;
  let active = true;
  const { listen } = await import('@tauri-apps/api/event');
  const syncCurrentRuntime = (port?: number) => {
    const installation = useAppStore.getState().config.comfyUIPath?.trim();
    void getComfyUIRuntimeStatus().then((runtime) => {
      if (!active || (port !== undefined && runtime.port !== port) || !runtime.runId
        || (runtime.status !== 'starting' && runtime.status !== 'running')) return;
      return syncComfyRuntimeUrl(runtime.port, installation);
    }).catch(() => {
      // 原生状态读取失败不改地址；配置保存失败由既有 Store 展示错误。
    });
  };
  const unlisten = await listen<unknown>(RUNTIME_STARTED_EVENT, ({ payload }) => {
    if (!active || !payload || typeof payload !== 'object' || !('port' in payload)
      || !isLocalComfyPort(payload.port)) return;
    syncCurrentRuntime(payload.port);
  });
  // 先订阅再读取，覆盖监听注册期间已完成的启动。
  syncCurrentRuntime();
  return () => { active = false; unlisten(); };
}
