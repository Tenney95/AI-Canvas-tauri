/**
 * Header 顶部栏 — Logo、项目名编辑、侧边栏切换、设置入口、窗口拖拽区域
 */
import { motion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
const isMacOS = typeof navigator !== 'undefined'
  && /Macintosh|Mac OS X/.test(navigator.userAgent);

export default function Header() {
  const { projectName, setProjectName } = useAppStore(
    useShallow((s) => ({ projectName: s.projectName, setProjectName: s.setProjectName })),
  );
  const macTauriPlacement = isTauri && isMacOS;

  return (
    <header
      data-tauri-drag-region
      className={`app-header absolute top-3 z-40 flex items-center gap-1 px-2 py-2
                  bg-canvas-surface/60 backdrop-blur-xl border border-canvas-border rounded-2xl
                  shadow-lg shadow-black/30 select-none ${
                    macTauriPlacement ? 'right-3' : 'left-3'
                  }`}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 pr-1">
        <div className="w-6 h-6 rounded-md bg-gradient-to-br to-purple-600 flex items-center justify-center shrink-0">
          <svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="iconGradient" x1="200" y1="200" x2="824" y2="824" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#4196FF" />
                <stop offset="50%" stopColor="#A259FF" />
                <stop offset="100%" stopColor="#FF5D70" />
              </linearGradient>

              <filter id="shadow" x="0" y="0" width="100%" height="100%" filterUnits="userSpaceOnUse">
                <feDropShadow dx="0" dy="20" stdDeviation="30" floodOpacity="0.1" />
              </filter>
            </defs>

            <path d="M512 0C900 0 1024 124 1024 512C1024 900 900 1024 512 1024C124 1024 0 900 0 512C0 124 124 0 512 0Z" fill="white" filter="url(#shadow)" />

            <path d="M512 2C900 2 1022 124 1022 512C1022 900 900 1022 512 1022C124 1022 2 900 2 512C2 124 124 2 512 2Z" stroke="black" strokeOpacity="0.05" strokeWidth="2" />

            <g transform="translate(512, 512) scale(1.4)">
              <path d="M0 -260 
             C15 -120 120 -15 260 0 
             C120 15 15 120 0 260 
             C-15 120 -120 15 -260 0 
             C-120 -15 -15 -120 0 -260Z"
                fill="url(#iconGradient)" />

              <circle r="45" fill="white" />

              <circle cx="0" cy="-120" r="12" fill="white" opacity="0.8" />
              <circle cx="104" cy="60" r="12" fill="white" opacity="0.8" />
              <circle cx="-104" cy="60" r="12" fill="white" opacity="0.8" />
            </g>
          </svg>
        </div>
        <span className="text-[11px] font-semibold text-canvas-text/90">AI Canvas</span>
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-[var(--separator-color)] mx-0.5" />

      {/* Project Name */}
      <div
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onBlur={(e) => {
          const name = e.currentTarget.textContent?.trim() || '新项目';
          setProjectName(name);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLElement).blur();
          }
        }}
        className="text-[11px] text-canvas-text-secondary/80 px-2 py-0.5 rounded-md
                   hover:bg-canvas-hover outline-none cursor-text min-w-[50px] max-w-[140px] truncate
                   focus:text-canvas-text/90 transition-colors"
      >
        {projectName}
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-[var(--separator-color)] mx-0.5" />

      {/* Actions */}
      <motion.button
        type="button"
        aria-label="新建画布"
        onClick={() => useAppStore.getState().createProject()}
        className="w-7 h-7 rounded-lg hover:bg-canvas-hover flex items-center justify-center
                   text-canvas-text-secondary hover:text-canvas-text"
        data-tooltip="新建画布"
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.92 }}
        transition={{ type: 'spring', stiffness: 400, damping: 17 }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </motion.button>
    </header>
  );
}
