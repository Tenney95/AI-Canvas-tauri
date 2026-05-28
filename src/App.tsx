import { useEffect } from 'react';
import { Inspector } from 'react-dev-inspector';
import Header from './components/Header';
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

export default function App() {
  useKeyboardShortcuts();

  // Load projects from IndexedDB on mount
  const initFromDb = useAppStore((s) => s.initFromDb);
  useEffect(() => {
    initFromDb();
  }, [initFromDb]);

  const appContent = (
    <div className="w-screen h-screen relative bg-canvas-bg text-canvas-text overflow-hidden font-sans">
      <Canvas />
      <Header />
      <Sidebar />
      <NodeMenu />
      <SettingsPanel />
      <AINodeDialog />
      <WorkflowPanel />
      <Toast />
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
