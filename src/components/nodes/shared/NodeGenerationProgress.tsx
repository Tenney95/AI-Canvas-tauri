import { useEffect, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { getGenerationNodeType } from '../../../utils/nodeGeneration';
import { useT } from '../../../i18n';

function GenerationWaitTime({ nodeId }: { nodeId: string }) {
  const t = useT();
  const projectId = useAppStore((state) => state.currentProjectId);
  const startedAt = useAppStore((state) => {
    const data = state.nodes.find((node) => node.id === nodeId)?.data;
    const type = getGenerationNodeType(data?.type);
    if (data?.status !== 'loading' || (type !== 'ai-image' && type !== 'ai-video')) return undefined;
    const value = data.generationStartedAt;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === undefined) return;
    // 兼容更新前已经运行的任务，从首次可确认的等待时间开始记录。
    if (startedAt === 0) {
      const state = useAppStore.getState();
      const node = state.nodes.find((item) => item.id === nodeId);
      if (state.currentProjectId === projectId && node?.data.status === 'loading') {
        state.updateNodeDataTransient(nodeId, { status: 'loading' });
      }
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [nodeId, projectId, startedAt]);

  if (startedAt === undefined) return null;
  const seconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const hours = Math.floor(seconds / 3600);
  const duration = [
    ...(hours > 0 ? [String(hours)] : []),
    String(Math.floor(seconds / 60) % 60).padStart(2, '0'),
    String(seconds % 60).padStart(2, '0'),
  ].join(':');

  return (
    <span role="timer" aria-live="off" className="text-[11px] tabular-nums text-canvas-text-muted">
      {t('已等待 {duration}', { duration })}
    </span>
  );
}

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
    if (overlay) {
      // 节点已有内容时以浮层形式保留生成中的可见反馈（含性能模式，仅 spinner 不受降级影响）
      return (
        <div className="generation-progress-overlay">
          <div className="spinner large" />
          <span className="text-xs">{fallbackLabel}</span>
          <GenerationWaitTime nodeId={nodeId} />
        </div>
      );
    }
    return (
      <div className="node-preview-loading">
        <div className={compactSpinner ? 'spinner' : 'spinner large'} />
        <span>{fallbackLabel}</span>
        <GenerationWaitTime nodeId={nodeId} />
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
        ? 'generation-progress-overlay'
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
      <GenerationWaitTime nodeId={nodeId} />
    </div>
  );
}
