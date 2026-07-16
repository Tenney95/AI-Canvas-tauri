/**
 * ContextUsageIndicator — 会话上下文占用指示器（P3-D1）
 *
 * 显示当前会话估算占用 / 模型上下文窗口和百分比。
 * 所有数值为估算口径（无精确 tokenizer），悬停提示中注明。
 */
import type { ContextUsageStat } from '../../services/chat/contextManager';

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${tokens}`;
}

interface ContextUsageIndicatorProps {
  usage: ContextUsageStat | null;
}

export default function ContextUsageIndicator({ usage }: ContextUsageIndicatorProps) {
  if (!usage) return null;

  const percent = Math.round(usage.ratio * 100);
  const colorClass = usage.ratio >= 0.9
    ? 'text-red-400'
    : usage.ratio >= 0.75
      ? 'text-amber-400'
      : 'text-canvas-text-muted';
  const windowSourceLabel = usage.source === 'declared'
    ? '模型配置声明'
    : usage.source === 'catalog'
      ? '按模型 ID 推断'
      : '未识别模型，使用保守默认值';
  const tooltip = [
    `上下文占用（估算）：约 ${usage.estimatedTokens.toLocaleString()} token`,
    `模型上下文窗口：${usage.contextWindow.toLocaleString()} token（${windowSourceLabel}）`,
    `输入预算：${usage.inputBudget.toLocaleString()} token，已用约 ${percent}%`,
    usage.ratio >= 0.75 ? '接近上限时会自动压缩较早的对话，不会删除原始历史' : '',
  ].filter(Boolean).join('\n');

  return (
    <span
      className={`chat-context-usage text-[10px] tabular-nums whitespace-nowrap px-1.5 py-0.5 rounded bg-canvas-hover/60 ${colorClass}`}
      title={tooltip}
      aria-label={`上下文占用约 ${percent}%`}
    >
      {formatTokens(usage.estimatedTokens)}/{formatTokens(usage.contextWindow)} · {percent}%
    </span>
  );
}
