import { useAppStore } from '../../../store/useAppStore';

interface NodeGenerationProgressProps {
  nodeId: string;
  fallbackLabel: string;
  overlay?: boolean;
  compactSpinner?: boolean;
}

export default function NodeGenerationProgress({
  nodeId,
  fallbackLabel,
  overlay = false,
  compactSpinner = false,
}: NodeGenerationProgressProps) {
  const progress = useAppStore((state) => {
    const candidate = state.comfyNodeProgress[nodeId];
    return candidate?.projectId === state.currentProjectId ? candidate : null;
  });

  if (!progress) {
    if (overlay) return null;
    return (
      <div className="node-preview-loading">
        <div className={compactSpinner ? 'spinner' : 'spinner large'} />
        <span>{fallbackLabel}</span>
      </div>
    );
  }

  const determinate = progress.percent !== undefined;
  const detail = determinate && progress.value !== undefined && progress.max !== undefined
    ? `${progress.value} / ${progress.max} · ${progress.percent}%`
    : fallbackLabel;

  return (
    <div
      className={overlay
        ? 'pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-canvas-card/90 px-5 text-canvas-text'
        : 'node-preview-loading px-5'}
      data-comfy-progress={progress.stage}
    >
      <div className="flex w-full max-w-[220px] items-center justify-between gap-3 text-[11px]">
        <span className="font-medium text-canvas-text">ComfyUI</span>
        <span className="truncate text-canvas-text-secondary">{detail}</span>
      </div>
      <div
        className={`ui-progress w-full max-w-[220px]${determinate ? '' : ' ui-progress--indeterminate'}`}
        role="progressbar"
        aria-label={`ComfyUI · ${fallbackLabel}`}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? 100 : undefined}
        aria-valuenow={determinate ? progress.percent : undefined}
      >
        <div className="ui-progress__bar" style={determinate ? { width: `${progress.percent}%` } : undefined} />
      </div>
    </div>
  );
}
