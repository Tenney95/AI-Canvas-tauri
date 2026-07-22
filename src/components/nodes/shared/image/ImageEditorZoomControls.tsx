import { Icon } from '@iconify/react';

interface ImageEditorZoomControlsProps {
  scale: number;
  minScale: number;
  maxScale: number;
  onZoomChange: (scale: number) => void;
  onReset: () => void;
  className?: string;
  step?: number;
}

export default function ImageEditorZoomControls({
  scale,
  minScale,
  maxScale,
  onZoomChange,
  onReset,
  className,
  step = 0.25,
}: ImageEditorZoomControlsProps) {
  const classes = ['image-editor-zoom-controls', className].filter(Boolean).join(' ');
  const canZoomOut = scale > minScale + Number.EPSILON;
  const canZoomIn = scale < maxScale - Number.EPSILON;

  return (
    <div className={classes} role="group" aria-label="画布缩放">
      <button
        type="button"
        className="image-editor-zoom-btn"
        data-tooltip="缩小"
        aria-label="缩小"
        disabled={!canZoomOut}
        onClick={() => onZoomChange(Math.max(minScale, scale - step))}
      >
        <Icon icon="mdi:magnify-minus-outline" width="16" height="16" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="image-editor-zoom-value"
        data-tooltip="重置缩放"
        aria-label="重置缩放"
        onClick={onReset}
      >
        {Math.round(scale * 100)}%
      </button>
      <button
        type="button"
        className="image-editor-zoom-btn"
        data-tooltip="放大"
        aria-label="放大"
        disabled={!canZoomIn}
        onClick={() => onZoomChange(Math.min(maxScale, scale + step))}
      >
        <Icon icon="mdi:magnify-plus-outline" width="16" height="16" aria-hidden="true" />
      </button>
    </div>
  );
}
