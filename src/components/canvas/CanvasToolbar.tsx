/**
 * CanvasToolbar 画布工具栏 — 画布右下角浮动工具条，控制网格显隐、连线样式、缩放比例
 */
import { memo } from 'react';
import AnimatedButton from '../shared/AnimatedButton';
import { useT } from '../../i18n';
import type { CanvasEdgeDisplayMode } from '../../types/canvasEdges';
import CanvasZoomControl, { type CanvasZoomControlProps } from './CanvasZoomControl';

interface CanvasToolbarProps extends CanvasZoomControlProps {
  showGrid: boolean;
  edgeDisplayMode: CanvasEdgeDisplayMode;
  onToggleGrid: () => void;
  onToggleLine: () => void;
}

function CanvasToolbar({
  showGrid,
  edgeDisplayMode,
  onToggleGrid,
  onToggleLine,
  ...zoomProps
}: CanvasToolbarProps) {
  const t = useT();
  const lineActionLabel = edgeDisplayMode === 'orthogonal' ? t('切换为曲线连线')
    : edgeDisplayMode === 'curved' ? t('隐藏连线') : t('切换为直角连线');
  const lineTooltip = edgeDisplayMode === 'orthogonal' ? t('连线类型：直角 → 切换为曲线')
    : edgeDisplayMode === 'curved' ? t('连线类型：曲线 → 隐藏连线') : t('连线类型：隐藏 → 切换为直角');
  return (
    <div className="footer-toolbar canvas-viewport-toolbar flex items-center gap-1 border border-canvas-border backdrop-blur-xl rounded-xl shadow-lg">
      <AnimatedButton
        type="button"
        aria-label={showGrid ? t('隐藏背景网格') : t('显示背景网格')}
        className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
          showGrid
            ? 'text-indigo-400 hover:text-indigo-300 bg-indigo-500/15'
            : 'text-canvas-text-secondary hover:text-canvas-text hover:bg-canvas-hover'
        }`}
        onClick={onToggleGrid}
        data-tooltip={showGrid ? t('隐藏背景网格') : t('显示背景网格')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="5" cy="5" r="1.5" /><circle cx="12" cy="5" r="1.5" /><circle cx="19" cy="5" r="1.5" />
          <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
          <circle cx="5" cy="19" r="1.5" /><circle cx="12" cy="19" r="1.5" /><circle cx="19" cy="19" r="1.5" />
        </svg>
      </AnimatedButton>
      <AnimatedButton
        type="button"
        aria-label={lineActionLabel}
        className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors text-canvas-text-secondary hover:text-canvas-text hover:bg-canvas-hover"
        onClick={onToggleLine}
        data-tooltip={lineTooltip}
      >
        {edgeDisplayMode === 'orthogonal' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 18h8V6h8" />
          </svg>
        ) : edgeDisplayMode === 'curved' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 20 Q12 8 20 4" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A11 11 0 0 1 12 5c7 0 10 7 10 7a16 16 0 0 1-3 3.9M6.6 6.6A17 17 0 0 0 2 12s3 7 10 7a11 11 0 0 0 5.4-1.4" />
          </svg>
        )}
      </AnimatedButton>
      <div className="w-px h-4 bg-[var(--separator-color)] mx-0.5" />
      <CanvasZoomControl {...zoomProps} />
    </div>
  );
}

export default memo(CanvasToolbar);
