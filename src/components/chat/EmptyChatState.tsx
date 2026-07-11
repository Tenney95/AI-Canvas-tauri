/**
 * EmptyChatState — 空会话状态页
 *
 * 无活动会话时展示，含新建对话 / 历史记录入口 + 示例提示。
 */
import { Icon } from '@iconify/react';
import AnimatedButton from '../shared/AnimatedButton';
import MascotAvatar from './MascotAvatar';

interface EmptyChatStateProps {
  onNew: () => void;
  onList: () => void;
}

const EXAMPLES = [
  '现在有几个失败节点？',
  '选中 3 号节点',
  '删除失败节点',
];

export default function EmptyChatState({ onNew, onList }: EmptyChatStateProps) {
  return (
    <div className="chat-empty-state flex flex-col items-center justify-center h-full text-center px-6">
      <MascotAvatar size={72} className="mb-5" />
      <h3 className="text-base font-semibold text-canvas-text mb-2">画布 AI 助手</h3>
      <p className="text-sm text-canvas-text-secondary mb-6 max-w-[260px]">
        用自然语言读取和操作画布。查询状态、定位节点、批量管理，一个对话框完成。
      </p>
      <div className="chat-empty-state-actions flex flex-col gap-2 w-48">
        <AnimatedButton
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl
                     bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-400 transition-colors"
          onClick={onNew}
        >
          <Icon icon="mdi:plus" width="16" height="16" />
          新建对话
        </AnimatedButton>
        <AnimatedButton
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl
                     bg-canvas-hover text-canvas-text-secondary text-sm hover:text-canvas-text
                     hover:bg-canvas-border transition-colors"
          onClick={onList}
        >
          <Icon icon="mdi:history" width="16" height="16" />
          历史记录
        </AnimatedButton>
      </div>

      {/* Example prompts */}
      <div className="chat-empty-state-examples mt-8 space-y-2 w-56">
        <p className="text-[11px] text-canvas-text-muted mb-2">试试这些：</p>
        {EXAMPLES.map((example) => (
          <div
            key={example}
            className="px-3 py-2 text-xs text-canvas-text-secondary bg-canvas-bg border border-canvas-border
                       rounded-lg hover:border-canvas-text-secondary hover:text-canvas-text
                       transition-colors cursor-pointer"
          >
            {example}
          </div>
        ))}
      </div>
    </div>
  );
}
