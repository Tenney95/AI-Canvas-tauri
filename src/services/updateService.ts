/**
 * 应用更新服务
 *
 * 启动时静默检查 GitHub Releases 是否有新版本。
 * Windows 使用 passive 模式（显示进度条，无需用户交互），
 * macOS / Linux 使用默认模式。
 */

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

/** 开发模式下跳过更新检查：Vite 编译时常量，打包后恒为 false */
function isDevMode(): boolean {
  return import.meta.env.DEV;
}

export type UpdateResult = { updated: false } | { updated: true; version: string };

/**
 * 启动时检查更新，有更新则自动下载安装并提示重启。
 * 仅在 Tauri 环境下生效。
 */
export async function checkForUpdate(): Promise<UpdateResult> {
  if (!isTauri) return { updated: false };

  try {
    // 开发模式下跳过（暂无 Release 可拉取，必然 404）
    if (isDevMode()) {
      console.log('[Updater] 开发模式，跳过更新检查');
      return { updated: false };
    }

    const { check } = await import('@tauri-apps/plugin-updater');
    const { relaunch } = await import('@tauri-apps/plugin-process');

    const update = await check();

    if (!update) {
      console.log('[Updater] 当前已是最新版本');
      return { updated: false };
    }

    console.log(`[Updater] 发现新版本 v${update.version}，开始下载...`);

    // 下载并安装（Windows passive 模式只显示进度条）
    await update.downloadAndInstall();

    console.log(`[Updater] v${update.version} 安装完成，即将重启应用`);

    // 延迟重启，给用户短暂的反应时间
    setTimeout(() => {
      relaunch().catch(() => {
        // relaunch 在某些平台上可能不支持，静默忽略
      });
    }, 500);

    return { updated: true, version: update.version };
  } catch (err) {
    // 更新失败不阻塞应用正常运行
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('404') || msg.includes('Not Found')) {
      console.log('[Updater] 暂无 Release（没有发布过版本）');
    } else if (msg.includes('NetworkError') || msg.includes('Failed to fetch') || msg.includes('ENOTFOUND')) {
      console.log('[Updater] 网络不可用，跳过更新检查');
    } else {
      console.warn('[Updater] 更新检查失败:', err);
    }
    return { updated: false };
  }
}
