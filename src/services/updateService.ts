/**
 * 应用更新服务
 *
 * 启动时静默检查 GitHub Releases 是否有新版本。
 * 不自动下载，用户可在吉祥物的聊天气泡中决定是否更新。
 */
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

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
    const update = await check();

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
export async function downloadAndInstallUpdate(): Promise<boolean> {
  if (!isTauri) return false;

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const { relaunch } = await import('@tauri-apps/plugin-process');

    const update = await check();
    if (!update) return false;

    console.log(`[Updater] 开始下载 v${update.version}...`);
    await update.downloadAndInstall();
    console.log(`[Updater] v${update.version} 安装完成，即将重启`);

    setTimeout(() => {
      relaunch().catch(() => {});
    }, 500);

    return true;
  } catch (err) {
    console.warn('[Updater] 下载安装失败:', err);
    return false;
  }
}
