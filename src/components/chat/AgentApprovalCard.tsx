/**
 * AgentApprovalCard — Agent 步骤审批卡（P3-E1）。
 *
 * 展示等待确认的工具操作（画布写入、文件写入、媒体生成、永久删除、项目记忆、API 配置），
 * 提供确认 / 拒绝。键盘可操作，类别用文字标签而非仅颜色表达。
 */
import { useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import type {
  AgentApprovalKind,
  AgentApprovalResolution,
  AgentStep,
} from '../../types/agent';
import type { MediaModelOption } from '../nodes/shared/defaultModels';

interface AgentApprovalCardProps {
  step: AgentStep;
  mediaModelOptions: MediaModelOption[];
  mediaModelAvailability: Record<string, boolean>;
  onResolve: (approvalId: string, resolution: AgentApprovalResolution) => void;
}

const KIND_META: Record<AgentApprovalKind, { label: string; icon: string }> = {
  canvas_write: { label: '画布修改', icon: 'mdi:vector-square-edit' },
  file_write: { label: '写入文件', icon: 'mdi:content-save-outline' },
  permanent_delete: { label: '永久删除', icon: 'mdi:delete-alert-outline' },
  media_generation: { label: '生成媒体', icon: 'mdi:image-plus-outline' },
  memory_write: { label: '保存记忆', icon: 'mdi:brain' },
  config_write: { label: 'API 配置', icon: 'mdi:api' },
};

const MEDIA_KIND_LABELS = {
  image: '生图',
  video: '视频',
  audio: '音频',
} as const;

export default function AgentApprovalCard({
  step,
  mediaModelOptions,
  mediaModelAvailability,
  onResolve,
}: AgentApprovalCardProps) {
  const approval = step.approval;
  const inputRequest = approval?.inputRequest;
  const [selectedModelRef, setSelectedModelRef] = useState(
    inputRequest?.selectedModelRef,
  );
  const groupedModels = useMemo(() => {
    if (!inputRequest) return [];
    const groups = new Map<string, MediaModelOption[]>();
    for (const model of mediaModelOptions) {
      if (model.mediaKind !== inputRequest.mediaKind) continue;
      const models = groups.get(model.groupName) ?? [];
      models.push(model);
      groups.set(model.groupName, models);
    }
    return [...groups.entries()];
  }, [inputRequest, mediaModelOptions]);
  if (!approval) return null;
  const meta = KIND_META[approval.kind];
  const needsModelSelection = inputRequest?.kind === 'media_model';
  const hasAvailableModel = groupedModels.some(([, models]) =>
    models.some((model) => mediaModelAvailability[model.value]),
  );
  const selectedModelAvailable = !!selectedModelRef
    && !!mediaModelAvailability[selectedModelRef];

  const handleConfirm = () => {
    onResolve(approval.id, {
      approved: true,
      ...(needsModelSelection
        ? { inputValues: { modelRef: selectedModelRef } }
        : {}),
    });
  };

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
      {approval.kind === 'config_write' && (
        <div className="mt-2 flex items-start gap-1.5 border-t border-amber-300/15 pt-2 text-xs leading-[18px] text-canvas-text-secondary">
          <Icon icon="mdi:shield-key-outline" width="14" className="mt-0.5 shrink-0 text-amber-400" />
          <span>不会写入 API Key；新连接保持空白，已有连接保留原值。</span>
        </div>
      )}
      {inputRequest && (
        <div className="mt-3 border-t border-amber-300/15 pt-2.5">
          <p className="mb-2 text-[11px] font-medium text-canvas-text">
            选择{MEDIA_KIND_LABELS[inputRequest.mediaKind]}模型
          </p>
          {hasAvailableModel ? (
            <div className="max-h-40 space-y-2 overflow-y-auto pr-1">
              {groupedModels.map(([groupName, models]) => (
                <div key={groupName}>
                  <p className="mb-1 text-[10px] text-canvas-text-muted">{groupName}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {models.map((model) => {
                      const available = !!mediaModelAvailability[model.value];
                      const selected = selectedModelRef === model.value;
                      return (
                        <button
                          key={model.value}
                          type="button"
                          disabled={!available}
                          aria-pressed={selected}
                          title={available ? model.description : '模型未配置或当前不可用'}
                          onClick={() => setSelectedModelRef(model.value)}
                          className={`flex min-h-7 max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-left text-[11px] leading-4 transition-colors active:scale-[0.98] motion-reduce:transform-none ${
                            selected
                              ? 'border-amber-300/70 bg-amber-300/15 text-amber-200'
                              : available
                                ? 'border-canvas-border text-canvas-text-secondary hover:border-amber-300/40 hover:text-canvas-text'
                                : 'cursor-not-allowed border-canvas-border/50 text-canvas-text-muted opacity-45'
                          }`}
                        >
                          {selected && <Icon icon="mdi:check" width="13" className="shrink-0" />}
                          <span className="break-words">{model.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] leading-[17px] text-canvas-text-muted">
              暂无可用模型，请先在设置中完成模型配置。
            </p>
          )}
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onResolve(approval.id, { approved: false })}
          className="min-h-8 rounded-md px-3 py-1 text-xs text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
        >
          拒绝
        </button>
        <button
          type="button"
          disabled={needsModelSelection && !selectedModelAvailable}
          onClick={handleConfirm}
          className="min-h-8 rounded-md bg-amber-400 px-3 py-1 text-xs font-medium text-black hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
        >
          {needsModelSelection ? '确认生成' : '确认执行'}
        </button>
      </div>
    </div>
  );
}
