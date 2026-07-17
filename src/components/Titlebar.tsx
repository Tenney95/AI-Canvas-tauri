/**
 * Titlebar 自定义窗口标题栏 — Tauri 环境下替代系统标题栏，提供最小化/最大化/关闭控制按钮
 */
import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useAppStore } from '../store/useAppStore';
import AnimatedButton from './shared/AnimatedButton';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
const isMacOS = typeof navigator !== 'undefined'
  && /Macintosh|Mac OS X/.test(navigator.userAgent);

export default function Titlebar() {
  // Not running in Tauri — render nothing
  if (!isTauri) return null;

  return <TauriTitlebar />;
}

function TauriTitlebar() {
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
  const sidebarFloating = useAppStore((state) => state.config.sidebarFloating) !== false
    && !isMaximized;

  useEffect(() => {
    const check = () => appWindow.isMaximized().then(setIsMaximized);
    check();
    const unlistenPromise = appWindow.onResized(check);
    return () => { unlistenPromise.then((fn) => fn()); };
  }, [appWindow]);

  if (isMacOS) {
    return (
      <div
        data-tauri-drag-region
        className={`fixed top-3 z-[200] flex h-6 items-center select-none ${
          sidebarFloating ? 'left-10' : 'left-3'
        }`}
      >
        <div
          className="flex items-center gap-1.5 rounded-full border border-white/[0.08]
                     bg-canvas-surface/45 px-2 py-1.5 shadow-lg shadow-black/20 backdrop-blur-xl"
        >
          <MacTrafficLight
            label="关闭"
            className="bg-red-400 hover:bg-red-300"
            onClick={() => appWindow.close()}
          >
            <CloseIcon />
          </MacTrafficLight>
          <MacTrafficLight
            label="最小化"
            className="bg-amber-400 hover:bg-amber-300"
            onClick={() => appWindow.minimize()}
          >
            <MinimizeIcon />
          </MacTrafficLight>
          <MacTrafficLight
            label={isMaximized ? '还原' : '最大化'}
            className="bg-emerald-400 hover:bg-emerald-300"
            onClick={() => appWindow.toggleMaximize()}
          >
            {isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
          </MacTrafficLight>
        </div>
      </div>
    );
  }

  return (
    <div
      data-tauri-drag-region
      className="fixed top-0 right-0 z-[200] flex items-center h-9 select-none"
    >
      {/* Minimize */}
      <AnimatedButton
        onClick={() => appWindow.minimize()}
        className="w-10 h-9 flex items-center justify-center text-canvas-text-muted
                   hover:bg-white/[0.06] hover:text-canvas-text-secondary transition-colors"
        aria-label="最小化"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="0" y="5" width="10" height="1" fill="currentColor" />
        </svg>
      </AnimatedButton>

      {/* Maximize / Restore */}
      <AnimatedButton
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
      </AnimatedButton>

      {/* Close */}
      <AnimatedButton
        onClick={() => appWindow.close()}
        className="w-10 h-9 flex items-center justify-center text-canvas-text-muted
                   hover:bg-red-500/70 hover:text-white transition-colors rounded-tr-[16px]"
        aria-label="关闭"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
          <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </AnimatedButton>
    </div>
  );
}

function MacTrafficLight({
  label,
  className,
  onClick,
  children,
}: {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <AnimatedButton
      onClick={onClick}
      aria-label={label}
      data-tooltip={label}
      scale={1.08}
      tapScale={0.92}
      className={`group flex h-3 w-3 items-center justify-center rounded-full
                  text-black/60 shadow-inner shadow-white/30 ring-1 ring-black/20
                  transition-colors ${className}`}
    >
      <span className="opacity-0 transition-opacity group-hover:opacity-100">
        {children}
      </span>
    </AnimatedButton>
  );
}

function MinimizeIcon() {
  return (
    <svg width="6" height="6" viewBox="0 0 7 7" aria-hidden="true">
      <rect x="1" y="3" width="5" height="1" rx="0.5" fill="currentColor" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="6" height="6" viewBox="0 0 7 7" aria-hidden="true">
      <path d="M1.4 1h4.2L1 5.6V1.4C1 1.18 1.18 1 1.4 1Z" fill="currentColor" />
      <path d="M5.6 6H1.4L6 1.4v4.2c0 .22-.18.4-.4.4Z" fill="currentColor" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="6" height="6" viewBox="0 0 7 7" aria-hidden="true">
      <path d="M2.2 1h3.4c.22 0 .4.18.4.4v3.4L2.2 1Z" fill="currentColor" />
      <path d="M4.8 6H1.4a.4.4 0 0 1-.4-.4V2.2L4.8 6Z" fill="currentColor" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="6" height="6" viewBox="0 0 7 7" aria-hidden="true">
      <path d="M1.6 1.1 5.9 5.4l-.5.5L1.1 1.6l.5-.5Z" fill="currentColor" />
      <path d="M5.4 1.1 1.1 5.4l.5.5 4.3-4.3-.5-.5Z" fill="currentColor" />
    </svg>
  );
}
