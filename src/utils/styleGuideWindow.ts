/**
 * styleGuideWindow — 打开/聚焦独立的「样式预览」窗口（Tauri 桌面端）
 *
 * 复用同一个 index.html，通过 ?view=style-guide 路由到 StyleGuideWindow 组件
 * （路由分支见 RootView.tsx）。入口是「关于」弹窗里连点 4 次 logo，属开发/设计
 * 辅助视图，不进主窗口的 Store。
 */

/** 样式预览窗口的固定标签 */
export const STYLE_GUIDE_WINDOW_LABEL = 'style-guide';

/** 独立窗口的 URL（浏览器开发环境下同样可用） */
export const STYLE_GUIDE_WINDOW_URL = 'index.html?view=style-guide';

/** 打开（或聚焦已存在的）样式预览窗口 */
export async function openStyleGuideWindow(): Promise<void> {
  // 浏览器开发环境没有 Tauri 窗口 API，退回新标签页，方便用 dev server 调样式
  if (typeof window === 'undefined' || !('__TAURI__' in window)) {
    window.open(STYLE_GUIDE_WINDOW_URL, '_blank', 'noopener');
    return;
  }

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');

    // 已存在则显示并聚焦
    const existing = await WebviewWindow.getByLabel(STYLE_GUIDE_WINDOW_LABEL);
    if (existing) {
      await existing.show().catch(() => {});
      await existing.unminimize().catch(() => {});
      await existing.setFocus().catch(() => {});
      return;
    }

    const win = new WebviewWindow(STYLE_GUIDE_WINDOW_LABEL, {
      url: STYLE_GUIDE_WINDOW_URL,
      title: '样式预览 · UI Kit',
      width: 1180,
      height: 820,
      minWidth: 720,
      minHeight: 480,
      center: true,
      resizable: true,
      // 无系统边框 + 透明背景，配合 CSS 10px 圆角，风格同资源搜索窗口
      decorations: false,
      transparent: true,
      shadow: false,
    });
    win.once('tauri://error', (e) => console.error('[styleGuideWindow] 创建窗口失败:', e));
  } catch (err) {
    console.warn('[styleGuideWindow] 打开样式预览窗口失败:', err);
  }
}
