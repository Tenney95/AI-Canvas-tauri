/**
 * Header 顶部栏 — Logo、项目名编辑、侧边栏切换、设置入口、窗口拖拽区域
 */
import { useAppStore } from '../store/useAppStore';

export default function Header() {
  const { projectName, setProjectName, toggleSidebar, setSettingsOpen } = useAppStore();

  return (
    <header
      data-tauri-drag-region
      className="absolute top-3 left-3 z-40 flex items-center gap-1 px-2.5 py-2
                 bg-canvas-surface/60 backdrop-blur-xl border border-white/[0.06] rounded-2xl
                 shadow-lg shadow-black/30 select-none"
    >
      {/* Logo */}
      <div className="flex items-center gap-2 pr-2 mr-0.5 border-r border-white/[0.08]">
        <div className="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0">
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
        <span className="text-[11px] font-semibold text-canvas-text/90 tracking-wide">AI Canvas</span>
      </div>

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
                   hover:bg-white/[0.05] outline-none cursor-text min-w-[50px] max-w-[140px] truncate
                   focus:text-canvas-text/90 transition-colors"
      >
        {projectName}
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-white/[0.08] mx-0.5" />

      {/* Actions */}
      <button
        onClick={() => useAppStore.getState().createProject()}
        className="w-7 h-7 rounded-lg hover:bg-white/[0.08] flex items-center justify-center
                   text-canvas-text-secondary hover:text-canvas-text transition-all"
        data-tooltip="新建画布"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      <button
        onClick={toggleSidebar}
        className="w-7 h-7 rounded-lg hover:bg-white/[0.08] flex items-center justify-center
                   text-canvas-text-secondary hover:text-canvas-text transition-all"
        data-tooltip="侧边栏"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
        </svg>
      </button>

      <button
        onClick={() => setSettingsOpen(true)}
        className="w-7 h-7 rounded-lg hover:bg-white/[0.08] flex items-center justify-center
                   text-canvas-text-secondary hover:text-canvas-text transition-all"
        data-tooltip="设置"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      </button>
    </header>
  );
}
