/**
 * VideoNodeToolbar 视频节点浮动工具栏 — 提供视频帧截取等快捷操作
 */
import { memo, useCallback } from 'react';
import AnimatedButton from '../../shared/AnimatedButton';

interface VideoNodeToolbarProps {
  onCaptureFrame: () => void;
}

function VideoNodeToolbar({ onCaptureFrame }: VideoNodeToolbarProps) {
  const handleCaptureFrame = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onCaptureFrame();
    },
    [onCaptureFrame],
  );

  return (
    <div className="node-floating-toolbar text-toolbar nodrag">
      <AnimatedButton
        className="ftb-btn icon-only act-capture-frame rounded-[6px]"
        title="截取当前帧"
        aria-label="截取当前帧"
        onClick={handleCaptureFrame}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M4 7h3l2-3h6l2 3h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
          <circle cx="12" cy="13" r="3" />
        </svg>
      </AnimatedButton>
    </div>
  );
}

export default memo(VideoNodeToolbar);
