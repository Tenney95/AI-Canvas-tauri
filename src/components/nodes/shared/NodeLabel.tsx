/**
 * NodeLabel 节点标签 — 渲染节点顶部标题栏，按节点类型显示对应图标/颜色/编号/Beta 角标
 */
import type { NodeType } from '../../../types';

interface NodeLabelProps {
  kind: NodeType;
  label: string;
  displayId?: number;
  isBeta?: boolean;
}

const labelConfig: Record<string, { icon: string; color: string; bg: string }> = {
  'ai-text': { icon: 'T', color: 'text-indigo-400', bg: 'bg-indigo-500/15' },
  'ai-image': { icon: 'I', color: 'text-green-400', bg: 'bg-green-500/15' },
  'ai-video': { icon: 'V', color: 'text-blue-400', bg: 'bg-blue-500/15' },
  'ai-audio': { icon: 'A', color: 'text-orange-400', bg: 'bg-orange-500/15' },
};

export default function NodeLabel({ kind, label, displayId, isBeta }: NodeLabelProps) {
  const config = labelConfig[kind] ?? { icon: '?', color: 'text-gray-400', bg: 'bg-gray-500/15' };

  return (
    <div className="node-label flex items-center gap-2 px-3 py-2 select-none" data-label-kind={kind}>
      <span
        className={`node-label-icon w-5 h-5 rounded flex items-center justify-center text-[11px] font-bold ${config.bg} ${config.color}`}
        aria-hidden="true"
      >
        {config.icon}
      </span>
      <span className="node-label-text text-xs font-medium text-canvas-text truncate flex-1 min-w-0">{label}</span>
      <span className="ml-auto flex items-center gap-1.5 flex-shrink-0">
        {displayId != null && (
          <span className="text-[10px] text-canvas-text-muted font-mono tabular-nums">
            #{displayId}
          </span>
        )}
        {isBeta && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400">
            Beta
          </span>
        )}
      </span>
    </div>
  );
}
