/**
 * App 根组件 — 装配 Header / Sidebar / Canvas / NodeMenu / SettingsPanel / Titlebar / Toast / AINodeDialog / WorkflowPanel
 * Tauri 环境下启用自定义窗口装饰和透明圆角窗口
 */
import { useEffect } from 'react';
import { Inspector } from 'react-dev-inspector';
import Header from './components/Header';
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import Canvas from './components/Canvas';
import NodeMenu from './components/NodeMenu';
import SettingsPanel from './components/SettingsPanel';
import AINodeDialog from './components/nodes/AINodeDialog';
import WorkflowPanel from './components/WorkflowPanel';
import Toast from './components/Toast';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAppStore } from './store/useAppStore';

const isDev = import.meta.env.DEV;
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

export default function App() {
  useKeyboardShortcuts();

  // Load projects from IndexedDB on mount
  const initFromDb = useAppStore((s) => s.initFromDb);
  useEffect(() => {
    initFromDb();
  }, [initFromDb]);

  const appContent = (
    <div
      data-tauri-window={isTauri ? '' : undefined}
      className={`h-screen relative text-canvas-text font-sans ${
        isTauri ? 'ml-[30px] w-[calc(100vw-30px)]' : 'w-screen'
      }`}
    >
      {/* Content area — clipped by overflow-hidden so rounded corners work */}
      <div className="absolute inset-0 overflow-hidden rounded-[16px] bg-canvas-bg">
        {/* Top drag region */}
        <div data-tauri-drag-region className="fixed top-0 left-0 right-0 h-8 z-10" />
        <Canvas />
        <Header />
        <Titlebar />
        <NodeMenu />
        <SettingsPanel />
        <AINodeDialog />
        <WorkflowPanel />
        <Toast />
      </div>
      {/* Sidebar — outside the overflow-hidden container so it's not clipped */}
      <Sidebar />
    </div>
  );

  // 仅在开发模式下启用 Inspect 功能
  if (!isDev) return appContent;

  return (
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
  );
}
