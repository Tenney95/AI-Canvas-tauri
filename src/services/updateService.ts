/**
 * 应用更新服务
 *
 * 启动时静默检查 GitHub Releases 是否有新版本。
 * 不自动下载，用户可在吉祥物的聊天气泡中决定是否更新。
 */
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
// 每个更新源单独超时；失败后由原生 updater 尝试配置中的下一个地址。
const UPDATE_CHECK_TIMEOUT_MS = 30_000;

/** 开发模式下跳过更新检查：Vite 编译时常量，打包后恒为 false */
function isDevMode(): boolean {
  return import.meta.env.DEV;
}

/** 检测到更新的结果 — 不含实际更新对象，仅信息 */
export interface UpdateInfo {
  version: string;
  body?: string;
  date?: string;
}

export type UpdateCheckResult =
  | { available: false }
  | { available: true; version: string; body?: string; date?: string };

/** 仅当前运行期使用；下载字节来自 updater 原生事件。 */
export interface AppUpdateProgress {
  phase: 'checking' | 'downloading' | 'installing' | 'restarting' | 'complete' | 'no-update' | 'error';
  downloadedBytes: number;
  totalBytes?: number;
  version?: string;
  message: string;
}

export function isAppUpdateRunning(progress: AppUpdateProgress | null): boolean {
  return progress !== null && ['checking', 'downloading', 'installing', 'restarting'].includes(progress.phase);
}

let updateInFlight: Promise<boolean> | null = null;

/**
 * 仅检测是否有新版本可用，不下载不安装。
 * 仅在 Tauri 环境下生效。
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!isTauri) return { available: false };

  try {
    if (isDevMode()) {
      console.log('[Updater] 开发模式，跳过更新检查');
      return { available: false };
    }

    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check({ timeout: UPDATE_CHECK_TIMEOUT_MS });

    if (!update) {
      console.log('[Updater] 当前已是最新版本');
      return { available: false };
    }

    console.log(`[Updater] 发现新版本 v${update.version}`);
    return {
      available: true,
      version: update.version,
      body: update.body,
      date: update.date,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('404') || msg.includes('Not Found')) {
      console.log('[Updater] 暂无 Release（没有发布过版本）');
    } else if (msg.includes('NetworkError') || msg.includes('Failed to fetch') || msg.includes('ENOTFOUND')) {
      console.log('[Updater] 网络不可用，跳过更新检查');
    } else {
      console.warn('[Updater] 更新检查失败:', err);
    }
    return { available: false };
  }
}

/**
 * 用户主动触发：检查、下载、安装、重启。
 * 仅在 Tauri 环境下生效。
 */
export function downloadAndInstallUpdate(onProgress?: (progress: AppUpdateProgress) => void): Promise<boolean> {
  if (!isTauri) return Promise.resolve(false);
  // 吉祥物与「关于」共用一次下载安装，避免并发调用原生安装器。
  if (updateInFlight) return updateInFlight;
  updateInFlight = performUpdate(onProgress).finally(() => { updateInFlight = null; });
  return updateInFlight;
}

async function performUpdate(onProgress?: (progress: AppUpdateProgress) => void): Promise<boolean> {
  let progress: AppUpdateProgress = { phase: 'checking', downloadedBytes: 0, message: '检查中...' };
  const report = (patch: Partial<AppUpdateProgress>) => {
    progress = { ...progress, ...patch };
    onProgress?.(progress);
  };

  try {
    report({});
    const { check } = await import('@tauri-apps/plugin-updater');
    const { relaunch } = await import('@tauri-apps/plugin-process');

    const update = await check({ timeout: UPDATE_CHECK_TIMEOUT_MS });
    if (!update) {
      report({ phase: 'no-update', message: '已是最新版本' });
      return false;
    }

    console.log(`[Updater] 开始下载 v${update.version}...`);
    report({ phase: 'downloading', version: update.version, message: '正在下载更新...' });
    const { Channel, invoke } = await import('@tauri-apps/api/core');
    const onEvent = new Channel<import('@tauri-apps/plugin-updater').DownloadEvent>();
    onEvent.onmessage = (event) => {
      if (event.event === 'Started') {
        const total = event.data.contentLength;
        report({
          downloadedBytes: 0,
          totalBytes: typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : undefined,
        });
      } else if (event.event === 'Progress') {
        const chunk = event.data.chunkLength;
        if (Number.isFinite(chunk) && chunk > 0) report({ downloadedBytes: progress.downloadedBytes + chunk });
      } else if (event.event === 'Finished') {
        report({ phase: 'installing', message: '正在校验并安装更新...' });
      }
    };
    await invoke('download_app_update', { rid: update.rid, onEvent });
    console.log(`[Updater] v${update.version} 安装完成，即将重启`);

    report({ phase: 'restarting', message: '安装完成，正在重启...' });
    await relaunch();

    report({ phase: 'complete', message: '安装完成，请重启应用' });
    return true;
  } catch (err) {
    console.warn('[Updater] 下载安装失败:', err);
    const message = progress.phase === 'restarting'
      ? '重启失败，请手动重启应用'
      : progress.phase === 'installing'
        ? '更新安装失败，请稍后重试'
        : progress.phase === 'checking'
          ? '检查失败，请稍后重试'
          : '下载失败，请稍后重试';
    report({ phase: 'error', message });
    return false;
  }
}
