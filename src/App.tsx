/**
 * App 根组件 — 装配 Header / Sidebar / Canvas / NodeMenu / SettingsPanel / Titlebar / Toast / AINodeDialog / WorkflowPanel
 * Tauri 环境下启用自定义窗口装饰和透明圆角窗口
 */
import { useEffect, useState } from 'react';
import { Inspector } from 'react-dev-inspector';
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
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAutoSave } from './hooks/useAutoSave';
import { useAppStore } from './store/useAppStore';
import * as fileService from './services/fileService';

const isDev = import.meta.env.DEV;
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

  const appContent = (
    <div
      data-tauri-window={isTauri ? '' : undefined}
      className={`h-screen relative text-canvas-text font-sans ${
        isTauri ? 'ml-[30px] w-[calc(100vw-30px)]' : 'w-screen'
      }`}
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
    </div>
  );

  // 仅在开发模式下启用 Inspect 功能
  if (!isDev) {
    return (
      <>
        {!splashDone && <SplashScreen onComplete={() => setSplashDone(true)} />}
        {appContent}
      </>
    );
  }

  return (
    <>
      {!splashDone && <SplashScreen onComplete={() => setSplashDone(true)} />}
      <Inspector
        keys={['control', 'shift', 'c']}
        onInspectElement={({ codeInfo }) => {
          if (!codeInfo?.absolutePath) return;
          const { absolutePath, lineNumber, columnNumber } = codeInfo;
          window.open(`codebuddycn://file/${absolutePath}:${lineNumber}:${columnNumber}`);
        }}
      >
        {appContent}
      </Inspector>
    </>
  );
}
