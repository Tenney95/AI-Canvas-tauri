/**
 * assetSearchWindow — 打开/聚焦独立的「资源搜索」窗口（Tauri 桌面端）
 * 复用同一个 index.html，通过 ?view=assets 路由到 AssetSearchWindow 组件。
 */

/** 资源搜索窗口的固定标签 */
export const ASSET_SEARCH_WINDOW_LABEL = 'asset-search';

/** 打开（或聚焦已存在的）资源搜索窗口 */
export async function openAssetSearchWindow(): Promise<void> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');

    // 已存在则显示并聚焦
    const existing = await WebviewWindow.getByLabel(ASSET_SEARCH_WINDOW_LABEL);
    if (existing) {
      await existing.show().catch(() => {});
      await existing.unminimize().catch(() => {});
      await existing.setFocus().catch(() => {});
      return;
    }

    const win = new WebviewWindow(ASSET_SEARCH_WINDOW_LABEL, {
      url: 'index.html?view=assets',
      title: '资源搜索',
      width: 1100,
      height: 760,
      minWidth: 720,
      minHeight: 480,
      center: true,
      resizable: true,
      decorations: true,
    });
    win.once('tauri://error', (e) => console.error('[assetSearchWindow] 创建窗口失败:', e));
  } catch (err) {
    console.warn('[assetSearchWindow] 仅 Tauri 桌面环境支持:', err);
  }
}
