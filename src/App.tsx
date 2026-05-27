import { useEffect } from 'react';
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

export default function App() {
  useKeyboardShortcuts();

  // Load projects from IndexedDB on mount
  const initFromDb = useAppStore((s) => s.initFromDb);
  useEffect(() => {
    initFromDb();
  }, [initFromDb]);

  return (
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
}
