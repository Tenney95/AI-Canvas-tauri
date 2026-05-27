interface NodeToolbarProps {
  onCopy?: () => void;
  onClearLines?: () => void;
  onFullscreen?: () => void;
}

export default function NodeToolbar({ onCopy, onClearLines, onFullscreen }: NodeToolbarProps) {
  return (
    <div className="node-floating-toolbar">
      <button
        className="ftb-btn"
        data-tooltip="复制"
        onClick={(e) => { e.stopPropagation(); onCopy?.(); }}
        aria-label="复制"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
      <button
        className="ftb-btn"
        data-tooltip="清除空行"
        onClick={(e) => { e.stopPropagation(); onClearLines?.(); }}
        aria-label="清除空行"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h8" />
          <path d="M18 15l3 3" /><path d="M21 15l-3 3" />
        </svg>
      </button>
      <button
        className="ftb-btn"
        data-tooltip="全屏显示"
        onClick={(e) => { e.stopPropagation(); onFullscreen?.(); }}
        aria-label="全屏显示"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
        </svg>
      </button>
    </div>
  );
}
