/**
 * PanoramaNodeToolbar 全景图节点浮动工具栏 — 上传、模式切换、比例设置、截图、全屏、下载
 */
import { memo, useCallback } from 'react';
import AnimatedButton from '../../shared/AnimatedButton';

interface PanoramaNodeToolbarProps {
  onUpload?: () => void;
  onToggleMode?: () => void;
  previewMode?: 'image' | '360';
  onScreenshot?: () => void;
  onFullscreen?: () => void;
}

function PanoramaNodeToolbar({
  onUpload,
  onToggleMode,
  previewMode,
  onScreenshot,
  onFullscreen,
}: PanoramaNodeToolbarProps) {
  const handleAction = useCallback(
    (handler?: () => void) => (e: React.MouseEvent) => {
      e.stopPropagation();
      handler?.();
    },
    [],
  );

  return (
    <div className="node-floating-toolbar pano-toolbar nodrag">
      <div className="pano-toolbar-main nodrag">
        {/* Upload */}
        <AnimatedButton
          className="ftb-btn icon-only act-upload"
          data-tooltip="上传全景图"
          aria-label="上传全景图"
          onClick={handleAction(onUpload)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </AnimatedButton>

        {/* Mode toggle */}
        <AnimatedButton
          className="ftb-btn icon-only act-mode"
          data-tooltip={previewMode === '360' ? '切换到图片视图' : '切换到360全景'}
          aria-label="切换视图模式"
          onClick={handleAction(onToggleMode)}
        >
          {previewMode === '360' ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <circle cx="12" cy="12" r="10" />
              <ellipse cx="12" cy="12" rx="6" ry="10" />
              <line x1="12" y1="2" x2="12" y2="22" />
              <line x1="2" y1="12" x2="22" y2="12" />
            </svg>
          )}
        </AnimatedButton>

        {/* Screenshot */}
        <AnimatedButton
          className="ftb-btn icon-only act-screenshot"
          data-tooltip="截图当前视角"
          aria-label="截图当前视角"
          onClick={handleAction(onScreenshot)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        </AnimatedButton>

        {/* Divider */}
        <div className="ftb-divider pano-toolbar-divider" />

        {/* Fullscreen */}
        <AnimatedButton
          className="ftb-btn icon-only act-fullscreen"
          data-tooltip="全屏显示"
          aria-label="全屏显示"
          onClick={handleAction(onFullscreen)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
          </svg>
        </AnimatedButton>

      </div>
    </div>
  );
}

export default memo(PanoramaNodeToolbar);
