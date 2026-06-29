/**
 * ImageNodeToolbar 图像节点浮动工具栏 — 鼠标悬停图像节点时显示，提供遮罩、扩图、360全景、裁切、重绘、高清、下载等操作
 */
import { memo, useCallback } from 'react';
import AnimatedButton from '../../../shared/AnimatedButton';

interface ImageNodeToolbarProps {
  nodeId: string;
  onUpload?: () => void;
  onMatting?: () => void;
  onSubjectMatting?: () => void;
  onMultiAngle?: () => void;
  onExpand?: () => void;
  onCompose?: () => void;
  onFullscreen?: () => void;
  onCrop?: () => void;
  onAnnotate?: () => void;
  onUpscale?: () => void;
  onRepaint?: () => void;
}

function ImageNodeToolbar({ onUpload, onMatting, onSubjectMatting, onMultiAngle, onExpand, onCompose, onFullscreen, onCrop, onAnnotate, onUpscale, onRepaint }: ImageNodeToolbarProps) {
  const noop = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const handleAction = useCallback(
    (handler?: () => void) => (e: React.MouseEvent) => {
      e.stopPropagation();
      handler?.();
    },
    [],
  );

  return (
    <div className="node-floating-toolbar img-toolbar nodrag">
      <div className="img-toolbar-main nodrag">
        {/* Primary zone */}
        <div className="img-toolbar-zone img-toolbar-zone-primary nodrag">
          <AnimatedButton
            className="ftb-btn icon-only act-matting"
            title="遮罩编辑器"
            aria-label="遮罩编辑器"
            onClick={handleAction(onMatting)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
              <circle cx="12" cy="12" r="5" />
              <path d="M12 7A5 5 0 0 1 12 17L12 7Z" fill="currentColor" fillOpacity="0.28" stroke="none" />
              <path d="M7 17l2-2" />
              <path d="M8.5 18.5l-1-1" />
            </svg>
          </AnimatedButton>
          <AnimatedButton className="ftb-btn icon-only act-expand" title="扩图" aria-label="扩图" onClick={handleAction(onExpand)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </AnimatedButton>
          <AnimatedButton className="ftb-btn icon-only act-multigrid" title="宫格裁切" aria-label="宫格裁切" onClick={noop}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
            </svg>
          </AnimatedButton>
          <AnimatedButton className="ftb-btn icon-only act-multiangle" title="控制角度" aria-label="控制角度" onClick={handleAction(onMultiAngle)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <path d="M12 22V12" />
              <path d="M12 12 3.27 7.73" />
              <path d="M12 12l8.73-4.27" />
            </svg>
          </AnimatedButton>
          <AnimatedButton className="ftb-btn icon-only act-repaint" title="重绘" aria-label="重绘" onClick={handleAction(onRepaint)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <rect x="3.5" y="4.5" width="13" height="13" rx="2" />
              <path d="m3.5 14 3-3a2 2 0 0 1 2.8 0L12 13.7" />
              <path d="M18.5 3.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6Z" fill="currentColor" stroke="none" />
              <path d="m14 18 5-5 2 2-5 5-3 1 1-3Z" />
            </svg>
          </AnimatedButton>
          <AnimatedButton className="ftb-btn icon-only act-hd" title="高清超分" aria-label="高清超分" onClick={handleAction(onUpscale)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M12 3v18m9-9H3m14.48-6.36L6.52 17.64m10.96 0L6.52 6.36" />
            </svg>
          </AnimatedButton>
          <AnimatedButton className="ftb-btn icon-only act-auto-subject" title="自动识别主体" aria-label="自动识别主体" onClick={handleAction(onSubjectMatting)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            </svg>
          </AnimatedButton>
        </div>

        {/* Secondary zone */}
        <div className="img-toolbar-zone img-toolbar-zone-secondary">
          <AnimatedButton className="ftb-btn icon-only act-annotate" title="标注" aria-label="标注" onClick={handleAction(onAnnotate)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </AnimatedButton>
          <AnimatedButton className="ftb-btn icon-only act-crop" title="裁切" aria-label="裁切" onClick={handleAction(onCrop)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2" />
            </svg>
          </AnimatedButton>
          <AnimatedButton className="ftb-btn icon-only act-compose" title="多图编辑" aria-label="多图编辑" onClick={handleAction(onCompose)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <rect x="3" y="3" width="13" height="13" rx="2" />
              <path d="M8 8h13v13H8z" fill="currentColor" fillOpacity="0.18" />
              <rect x="8" y="8" width="13" height="13" rx="2" />
            </svg>
          </AnimatedButton>
          
          {/* Divider */}
          <div className="ftb-divider img-toolbar-main-divider" />

          <AnimatedButton className="ftb-btn icon-only act-upload" title="上传图片" aria-label="上传图片" onClick={handleAction(onUpload)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </AnimatedButton>
          <AnimatedButton
            className="ftb-btn icon-only act-fullscreen"
            title="全屏显示"
            aria-label="全屏显示"
            onClick={handleAction(onFullscreen)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </AnimatedButton>
        </div>
      </div>
    </div>
  );
}

export default memo(ImageNodeToolbar);
