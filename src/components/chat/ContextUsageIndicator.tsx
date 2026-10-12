/**
 * ContextUsageIndicator — 会话上下文占用指示器（P3-D1，E-UI 改为环形）。
 *
 * 以 Claude 风格的小圆环进度条展示当前会话上下文占用比例。
 * 所有数值为估算口径（无精确 tokenizer），悬停提示中注明。
 */
import type { ContextUsageStat } from '../../services/chat/contextManager';
import { useT } from '../../i18n';

interface ContextUsageIndicatorProps {
  usage: ContextUsageStat | null;
}

const SIZE = 18;
const STROKE = 2.5;
const R = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * R;

export default function ContextUsageIndicator({ usage }: ContextUsageIndicatorProps) {
  const t = useT();
  if (!usage) return null;

  const ratio = Math.min(1, Math.max(0, usage.ratio));
  const percent = Math.round(usage.ratio * 100);
  const colorClass = usage.ratio >= 0.9 ? 'text-danger-light' : usage.ratio >= 0.75 ? 'text-warning-light' : 'text-brand-light';

  const windowSourceLabel = usage.source === 'declared'
    ? t('模型配置声明')
    : usage.source === 'catalog'
      ? t('按模型 ID 推断')
      : t('未识别模型，使用保守默认值');
  const tooltip = [
    t('上下文占用（估算）：约 {tokens} token', { tokens: usage.estimatedTokens.toLocaleString() }),
    t('模型上下文窗口：{tokens} token（{source}）', { tokens: usage.contextWindow.toLocaleString(), source: windowSourceLabel }),
    t('输入预算：{tokens} token，已用约 {percent}%', { tokens: usage.inputBudget.toLocaleString(), percent }),
    usage.ratio >= 0.75 ? t('接近上限时会自动压缩较早的对话，不会删除原始历史') : '',
  ].filter(Boolean).join('\n');

  return (
    <span
      className="chat-context-usage inline-flex shrink-0 items-center justify-center"
      title={tooltip}
      role="img"
      aria-label={t('上下文占用约 {percent}%', { percent })}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="-rotate-90">
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          className="text-canvas-border"
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke="currentColor"
          className={colorClass}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - ratio)}
        />
      </svg>
    </span>
  );
}
