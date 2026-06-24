/**
 * App 根组件 — 装配 Header / Sidebar / Canvas / NodeMenu / SettingsPanel / Titlebar / Toast / AINodeDialog / WorkflowPanel
 * Tauri 环境下启用自定义窗口装饰和透明圆角窗口
 */
import { useEffect, useState } from 'react';
import Header from './components/Header';
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import Canvas from './components/Canvas';
import NodeMenu from './components/NodeMenu';
import SettingsPanel from './components/SettingsPanel';
import AINodeDialog from './components/nodes/AINodeDialog';
import WorkflowPanel from './components/WorkflowPanel';
import AssetsPanel from './components/AssetsPanel';
import OutputHistoryPanel from './components/OutputHistoryPanel';
import Toast from './components/Toast';
import SplashScreen from './components/SplashScreen';
import CanvasBackground from './components/backgrounds/CanvasBackground';
import Mascot from './components/shared/mascot/Mascot';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAutoSave } from './hooks/useAutoSave';
import { useAppStore } from './store/useAppStore';
import * as fileService from './services/fileService';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

export default function App() {
  useKeyboardShortcuts();
  useAutoSave();

  // 开屏动画状态
  const [splashDone, setSplashDone] = useState(false);

  // Load projects from IndexedDB on mount
  const initFromDb = useAppStore((s) => s.initFromDb);
  const migrateHistoryAndLoad = useAppStore((s) => s.migrateHistoryAndLoad);
  useEffect(() => {
    initFromDb().then(() => migrateHistoryAndLoad());
  }, [initFromDb, migrateHistoryAndLoad]);

  // Flush undo-trash dirs on app close
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested(async () => {
          await useAppStore.getState().saveCurrentProjectSilent();
          await fileService.flushUndoTrashDirs();
          win.destroy();
        });
      } catch { /* non-Tauri env */ }
    })();
    return () => { unlisten?.(); };
  }, []);

  // 同步主题到 document.documentElement，供 CSS [data-theme] 选择器生效
  // 米白色背景时自动切换为 light，其余背景使用用户手动设置的主题
  const configTheme = useAppStore((s) => s.config.theme);
  const canvasBackground = useAppStore((s) => s.config.canvasBackground);
  const mascotVisible = useAppStore((s) => s.config.mascotVisible);
  // 任意节点处于生成中 → 吉祥物切换为 LOADING 形态
  const mascotLoading = useAppStore((s) =>
    s.nodes.some((n) => (n.data as { status?: string })?.status === 'loading'),
  );
  const effectiveTheme = canvasBackground === 'off-white' ? 'light' : configTheme;
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    return () => document.documentElement.removeAttribute('data-theme');
  }, [effectiveTheme]);

  // Tauri 模式下给 body 加属性，Portal 渲染的弹窗元素也在 body 下，CSS 选择器才能匹配
  useEffect(() => {
    if (isTauri) {
      document.body.setAttribute('data-tauri-window', '');
      return () => document.body.removeAttribute('data-tauri-window');
    }
  }, []);

  // 窗口最大化状态（Tauri）：最大化时取消悬浮效果（无透明边条可悬浮）
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const check = () => win.isMaximized().then(setIsMaximized).catch(() => {});
        await check();
        unlisten = await win.onResized(check);
      } catch { /* non-Tauri env */ }
    })();
    return () => { unlisten?.(); };
  }, []);

  // 侧边栏悬浮显示开关（默认开启）；最大化时强制非悬浮。
  // 同步到 body 属性，供 CSS 切换侧边栏停靠/悬浮位置 + 弹窗蒙层的左偏移
  const sidebarFloatingCfg = useAppStore((s) => s.config.sidebarFloating);
  const effectiveFloating = sidebarFloatingCfg !== false && !isMaximized;
  useEffect(() => {
    if (effectiveFloating) {
      document.body.setAttribute('data-sidebar-floating', '');
    } else {
      document.body.removeAttribute('data-sidebar-floating');
    }
  }, [effectiveFloating]);

  const appContent = (
    <div
      className={`h-screen relative text-canvas-text font-sans ${
        isTauri && effectiveFloating ? 'ml-[30px] w-[calc(100vw-30px)]' : 'w-screen'
      }`}
      style={{
        transition:
          'margin-left 0.42s var(--ease-out-expo), width 0.42s var(--ease-out-expo)',
      }}
    >
      {/* Content area — clip-path clips ALL descendants including fixed-position backdrops */}
      <div className="app-box absolute inset-0 rounded-[16px] bg-canvas-bg/[0.988] shadow-2xl [clip-path:inset(0_round_16px)]">
        <CanvasBackground />
        {/* Top drag region */}
        <div data-tauri-drag-region className="fixed top-0 left-0 right-0 h-8 z-10" />
        <Canvas />
        <Header />
        <Titlebar />
        <NodeMenu />
        <SettingsPanel />
        <AINodeDialog />
        <WorkflowPanel />
        <AssetsPanel />
        <OutputHistoryPanel />
        <Toast />
      </div>
      {/* Sidebar — outside the overflow-hidden container so it's not clipped */}
      <Sidebar />

      {/* 吉祥物 — 右下角浮动预览，默认隐藏，Ctrl+Shift+M 切换 */}
      {mascotVisible && (
        <div className="fixed bottom-40 right-5 z-20 h-[100px] w-[100px] pointer-events-auto">
          <Mascot loading={mascotLoading} />
        </div>
      )}
    </div>
  );

  return (
    <>
      {!splashDone && <SplashScreen onComplete={() => setSplashDone(true)} />}
      {appContent}
    </>
  );
}
