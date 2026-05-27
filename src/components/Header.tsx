import { useAppStore } from '../store/useAppStore';

export default function Header() {
  const { projectName, setProjectName, toggleSidebar, setSettingsOpen } = useAppStore();

  return (
    <header
      className="absolute top-3 left-3 z-40 flex items-center gap-1 px-2.5 py-2
                 bg-canvas-surface/60 backdrop-blur-xl border border-white/[0.06] rounded-2xl
                 shadow-lg shadow-black/30 select-none"
    >
      {/* Logo */}
      <div className="flex items-center gap-2 pr-2 mr-0.5 border-r border-white/[0.08]">
        <div className="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0">
          <svg width="12" height="12" viewBox="0 0 26 26" fill="none">
            <path d="M9 13c0-2.21 1.79-4 4-4s4 1.79 4 4-1.79 4-4 4"
              stroke="white" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="13" cy="13" r="1.8" fill="white" />
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
