import { useState, useEffect } from 'react';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

export default function Titlebar() {
  // Not running in Tauri — render nothing
  if (!isTauri) return null;

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [api, setApi] = useState<typeof import('@tauri-apps/api/window') | null>(null);

  useEffect(() => {
    import('@tauri-apps/api/window').then(setApi);
  }, []);

  const getCurrentWindow = api?.getCurrentWindow;
  if (!getCurrentWindow) return null;

  return <TitlebarInner getCurrentWindow={getCurrentWindow} />;
}

function TitlebarInner({
  getCurrentWindow,
}: {
  getCurrentWindow: typeof import('@tauri-apps/api/window').getCurrentWindow;
}) {
  const [isMaximized, setIsMaximized] = useState(false);
  const appWindow = getCurrentWindow();

  useEffect(() => {
    const check = () => appWindow.isMaximized().then(setIsMaximized);
    check();
    const unlistenPromise = appWindow.onResized(check);
    return () => { unlistenPromise.then((fn) => fn()); };
  }, [appWindow]);

  return (
    <div
      data-tauri-drag-region
      className="fixed top-0 right-0 z-[200] flex items-center h-9 select-none"
    >
      {/* Minimize */}
      <button
        onClick={() => appWindow.minimize()}
        className="w-10 h-9 flex items-center justify-center text-canvas-text-muted
                   hover:bg-white/[0.06] hover:text-canvas-text-secondary transition-colors"
        aria-label="最小化"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="0" y="5" width="10" height="1" fill="currentColor" />
        </svg>
      </button>

      {/* Maximize / Restore */}
      <button
        onClick={() => appWindow.toggleMaximize()}
        className="w-10 h-9 flex items-center justify-center text-canvas-text-muted
                   hover:bg-white/[0.06] hover:text-canvas-text-secondary transition-colors"
        aria-label={isMaximized ? '还原' : '最大化'}
      >
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="2" y="0" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />
            <rect x="0" y="2" width="8" height="8" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0" y="0" width="10" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>

      {/* Close */}
      <button
        onClick={() => appWindow.close()}
        className="w-10 h-9 flex items-center justify-center text-canvas-text-muted
                   hover:bg-red-500/70 hover:text-white transition-colors rounded-tr-[16px]"
        aria-label="关闭"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
          <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  );
}
