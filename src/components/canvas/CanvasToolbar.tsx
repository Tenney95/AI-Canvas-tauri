/**
 * CanvasToolbar 画布工具栏 — 画布右下角浮动工具条，控制网格显隐、连线样式、缩放比例
 */
import { memo, useCallback } from 'react';
import { useReactFlow, useStore, type ReactFlowState } from '@xyflow/react';
import AnimatedButton from '../shared/AnimatedButton';

interface CanvasToolbarProps {
  showGrid: boolean;
  smoothLine: boolean;
  onToggleGrid: () => void;
  onToggleLine: () => void;
}

const selectZoomPercent = (state: ReactFlowState) => Math.round(state.transform[2] * 100);

const ZoomControl = memo(function ZoomControl() {
  const zoomPercent = useStore(selectZoomPercent);
  const { zoomTo } = useReactFlow();

  const handleZoomChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      zoomTo(Number(e.target.value) / 100);
    },
    [zoomTo],
  );

  return (
    <>
      <input
        type="range"
        min="10"
        max="200"
        value={zoomPercent}
        onChange={handleZoomChange}
        className="w-20 accent-indigo-500"
      />
      <span className="text-xs text-canvas-text-secondary w-10 text-right tabular-nums">{zoomPercent}%</span>
    </>
  );
});

function CanvasToolbar({
  showGrid,
  smoothLine,
  onToggleGrid,
  onToggleLine,
}: CanvasToolbarProps) {
  return (
    <div className="footer-toolbar flex items-center gap-2 border border-canvas-border backdrop-blur-xl rounded-lg px-3 py-1.5 shadow-lg">
      <AnimatedButton
        className={`w-7 h-7 rounded flex items-center justify-center transition-colors ${
          showGrid
            ? 'text-indigo-400 hover:text-indigo-300 bg-indigo-500/15'
            : 'text-canvas-text-secondary hover:text-canvas-text hover:bg-canvas-hover'
        }`}
        onClick={onToggleGrid}
        data-tooltip={showGrid ? '隐藏背景网格' : '显示背景网格'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="5" cy="5" r="1.5" /><circle cx="12" cy="5" r="1.5" /><circle cx="19" cy="5" r="1.5" />
          <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
          <circle cx="5" cy="19" r="1.5" /><circle cx="12" cy="19" r="1.5" /><circle cx="19" cy="19" r="1.5" />
        </svg>
      </AnimatedButton>
      <AnimatedButton
        className="w-7 h-7 rounded flex items-center justify-center transition-colors text-canvas-text-secondary hover:text-canvas-text hover:bg-canvas-hover"
        onClick={onToggleLine}
        data-tooltip={smoothLine ? '连线类型：直角 → 切换为曲线' : '连线类型：曲线 → 切换为直角'}
      >
        {smoothLine ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 20 L10 20 L10 10 L20 4" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 20 Q12 8 20 4" />
          </svg>
        )}
      </AnimatedButton>
      <div className="w-px h-5 bg-canvas-border mx-0.5" />
      <ZoomControl />
    </div>
  );
}

export default memo(CanvasToolbar);
