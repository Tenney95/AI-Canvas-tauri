import type { AgentMode } from '../../types/agent';

interface AgentModeSelectorProps {
  mode: AgentMode;
  onChange: (mode: AgentMode) => void;
  disabled?: boolean;
}

const MODES: Array<{ value: AgentMode; label: string; tooltip: string }> = [
  {
    value: 'plan',
    label: '规划',
    tooltip: 'Plan 模式：仅分析与规划，只能使用只读工具',
  },
  {
    value: 'collaborative',
    label: '协作',
    tooltip: 'B 协作模式：画布写操作先预览确认',
  },
  {
    value: 'autonomous',
    label: '自主',
    tooltip: 'C 自主模式：画布操作自动执行，付费媒体和文件写入仍需确认',
  },
];

export default function AgentModeSelector({
  mode,
  onChange,
  disabled = false,
}: AgentModeSelectorProps) {
  return (
    <div
      className="pointer-events-auto flex items-center rounded-md border border-canvas-border bg-canvas-bg/60 p-px"
      role="group"
      aria-label="Agent 模式"
    >
      {MODES.map((item) => (
        <button
          key={item.value}
          type="button"
          className={`flex h-6 min-w-9 items-center justify-center rounded px-1.5 text-[10px] font-medium transition-colors
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50
                      ${mode === item.value
                        ? item.value === 'autonomous'
                          ? 'bg-amber-400/15 text-amber-300'
                          : item.value === 'plan'
                            ? 'bg-emerald-400/15 text-emerald-300'
                            : 'bg-indigo-500/20 text-indigo-300'
                        : 'text-canvas-text-muted hover:bg-canvas-hover hover:text-canvas-text'
                      } disabled:cursor-not-allowed disabled:opacity-40`}
          aria-pressed={mode === item.value}
          aria-label={item.tooltip}
          data-tooltip={item.tooltip}
          disabled={disabled}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
