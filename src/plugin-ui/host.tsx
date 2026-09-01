/**
 * 插件自定义界面的入口：只负责解析参数并挂载宿主组件。
 *
 * 这个页面由 Tauri 以独立 webview 窗口打开，不共享宿主页面的 JS 运行时。
 */
import { createRoot } from 'react-dom/client';
import { PluginUiApp } from './PluginUiApp';

const params = new URLSearchParams(window.location.search);
const sessionId = params.get('session');
const exportName = params.get('export');
const container = document.getElementById('root');

if (!container) {
  throw new Error('插件界面缺少挂载节点');
}
if (!sessionId || !exportName) {
  container.textContent = '插件界面参数缺失';
} else {
  createRoot(container).render(<PluginUiApp sessionId={sessionId} exportName={exportName} />);
}
