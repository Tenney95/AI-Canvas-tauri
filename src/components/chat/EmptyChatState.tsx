/**
 * EmptyChatState — 空会话状态页
 *
 * 无活动会话时展示，含新建对话 / 历史记录入口 + 示例提示。
 */
import { Icon } from '@iconify/react';
import AnimatedButton from '../shared/AnimatedButton';
import MascotAvatar from './MascotAvatar';
import { useT } from '../../i18n';

interface EmptyChatStateProps {
  onNew: () => void;
  onList: () => void;
  /** 打开全局智能体中心；独立窗口不提供以保持主窗口单写入。 */
  onOpenAgents?: () => void;
  /** 点击示例提示 → 预填输入框（不提供时示例不可点击） */
  onExample?: (text: string) => void;
}

const EXAMPLES = [
  '现在有几个失败节点？',
  '选中 3 号节点',
  '删除失败节点',
];

export default function EmptyChatState({ onNew, onList, onOpenAgents, onExample }: EmptyChatStateProps) {
  const t = useT();
  return (
    <div className="chat-empty-state flex flex-col items-center justify-center h-full text-center px-6">
      <MascotAvatar size={72} className="mb-5" />
      <h3 className="text-base font-semibold text-canvas-text mb-2">{t('AI 助手')}</h3>
      <p className="text-sm text-canvas-text-secondary mb-6 max-w-[260px]">
        {t('直接开始对话，或按需安装智能体来扩展专业能力。没有智能体时，默认助手仍可正常使用。')}
      </p>
      <div className="chat-empty-state-actions flex flex-col gap-2 w-48">
        <AnimatedButton
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl
                     bg-brand text-white text-sm font-medium hover:bg-brand-light transition-colors"
          onClick={onNew}
        >
          <Icon icon="mdi:plus" width="16" height="16" />
          {t('新建对话')}
        </AnimatedButton>
        <AnimatedButton
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl
                     bg-canvas-hover text-canvas-text-secondary text-sm hover:text-canvas-text
                     hover:bg-canvas-border transition-colors"
          onClick={onList}
        >
          <Icon icon="mdi:history" width="16" height="16" />
          {t('历史记录')}
        </AnimatedButton>
        {onOpenAgents && (
          <AnimatedButton
            className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl
                       border border-canvas-border bg-canvas-card text-canvas-text-secondary text-sm
                       hover:border-brand/40 hover:bg-brand/10 hover:text-canvas-text transition-colors"
            onClick={onOpenAgents}
          >
            <Icon icon="lucide:bot" width="16" height="16" />
            {t('智能体中心')}
          </AnimatedButton>
        )}
      </div>

      {/* Example prompts */}
      {onExample && (
        <div className="chat-empty-state-examples mt-8 space-y-2 w-56">
          <p className="text-[11px] text-canvas-text-muted mb-2">{t('试试这些：')}</p>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onExample(example)}
              className="w-full text-left px-3 py-2 text-xs text-canvas-text-secondary bg-canvas-bg
                         border border-canvas-border rounded-lg transition-colors
                         hover:border-brand-light/50 hover:text-canvas-text hover:bg-canvas-hover"
            >
              {t(example)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
