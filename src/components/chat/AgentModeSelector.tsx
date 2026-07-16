import type { AgentMode } from '../../types/agent';

interface AgentModeSelectorProps {
  mode: AgentMode;
  onChange: (mode: AgentMode) => void;
  disabled?: boolean;
}

const MODES: Array<{ value: AgentMode; shortLabel: string; tooltip: string }> = [
  {
    value: 'collaborative',
    shortLabel: 'B',
    tooltip: 'B 协作模式：画布写操作先预览确认',
  },
  {
    value: 'autonomous',
    shortLabel: 'C',
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
      className="pointer-events-auto flex items-center rounded-md border border-canvas-border bg-canvas-bg/70 p-0.5"
      role="group"
      aria-label="Agent 模式"
    >
      {MODES.map((item) => (
        <button
          key={item.value}
          type="button"
          className={`flex h-5 min-w-5 items-center justify-center rounded px-1.5 text-[10px] font-semibold transition-colors
                      ${mode === item.value
                        ? 'bg-indigo-500/20 text-indigo-300'
                        : 'text-canvas-text-muted hover:bg-canvas-hover hover:text-canvas-text'
                      } disabled:cursor-not-allowed disabled:opacity-40`}
          aria-pressed={mode === item.value}
          aria-label={item.tooltip}
          data-tooltip={item.tooltip}
          disabled={disabled}
          onClick={() => onChange(item.value)}
        >
          {item.shortLabel}
        </button>
      ))}
    </div>
  );
}
