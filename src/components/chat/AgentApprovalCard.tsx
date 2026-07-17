/**
 * AgentApprovalCard — Agent 步骤审批卡（P3-E1）。
 *
 * 展示等待确认的工具操作（画布写入、文件写入、媒体生成、永久删除、项目记忆），
 * 提供确认 / 拒绝。键盘可操作，类别用文字标签而非仅颜色表达。
 */
import { Icon } from '@iconify/react';
import type { AgentApprovalKind, AgentStep } from '../../types/agent';

interface AgentApprovalCardProps {
  step: AgentStep;
  onResolve: (approvalId: string, approved: boolean) => void;
}

const KIND_META: Record<AgentApprovalKind, { label: string; icon: string }> = {
  canvas_write: { label: '画布修改', icon: 'mdi:vector-square-edit' },
  file_write: { label: '写入文件', icon: 'mdi:content-save-outline' },
  permanent_delete: { label: '永久删除', icon: 'mdi:delete-alert-outline' },
  media_generation: { label: '生成媒体', icon: 'mdi:image-plus-outline' },
  memory_write: { label: '保存记忆', icon: 'mdi:brain' },
};

export default function AgentApprovalCard({ step, onResolve }: AgentApprovalCardProps) {
  const approval = step.approval;
  if (!approval) return null;
  const meta = KIND_META[approval.kind];

  return (
    <div
      className="mt-2 border-l-2 border-amber-400/60 bg-amber-400/5 px-3 py-2.5"
      role="group"
      aria-label={`${meta.label}待确认`}
    >
      <div className="flex items-start gap-2">
        <Icon icon={meta.icon} width="16" className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-amber-300">
            待确认 · {meta.label}
          </p>
          <p className="mt-1 break-words text-xs leading-[18px] text-canvas-text-secondary">
            {step.toolCall?.inputSummary || approval.summary}
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onResolve(approval.id, false)}
          className="min-h-8 rounded-md px-3 py-1 text-xs text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
        >
          拒绝
        </button>
        <button
          type="button"
          onClick={() => onResolve(approval.id, true)}
          className="min-h-8 rounded-md bg-amber-400 px-3 py-1 text-xs font-medium text-black hover:bg-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
        >
          确认执行
        </button>
      </div>
    </div>
  );
}
