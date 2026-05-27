import { useState, useRef, useEffect } from 'react';
import type { NodeType, ModelOption, ModelGroup } from '../../../types';
import { defaultModelGroups } from './defaultModels';

interface ModelSelectorProps {
  nodeType: NodeType;
  selectedModel?: string;
  selectedProvider?: string;
  selectedWorkflowId?: string;
  onSelect: (model: ModelOption) => void;
  onWorkflowSelect?: (workflowId: string | undefined) => void;
  groups?: ModelGroup[];
}

export default function ModelSelector({
  nodeType,
  selectedModel,
  selectedProvider: _selectedProvider,
  selectedWorkflowId,
  onSelect,
  onWorkflowSelect: _onWorkflowSelect,
  groups = defaultModelGroups,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handler);
    }
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Escape 键关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    if (open) {
      window.addEventListener('keydown', handler);
    }
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // 筛选当前节点类型下可用的模型分组
  const filteredGroups = groups
    .map((g) => ({
      ...g,
      models: g.models.filter((m) => m.nodeTypes.includes(nodeType)),
    }))
    .filter((g) => g.models.length > 0);

  const currentModel = selectedModel
    ? filteredGroups.flatMap((g) => g.models).find((m) => m.value === selectedModel)
    : undefined;

  const displayLabel = currentModel?.label ?? '选择模型';

  return (
    <div className="model-selector" ref={ref}>
      <button
        type="button"
        className={`model-selector-trigger ${selectedWorkflowId ? 'has-workflow' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <span className="model-selector-label">{displayLabel}</span>
        <svg className="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="model-dropdown">
          {filteredGroups.map((group) => (
            <div key={group.id} className="model-group">
              <div className="model-group-header">
                {group.iconType === 'badge' && group.badgeText && (
                  <span className="text-model-icon text-model-icon-badge" data-badge={group.badgeText}>
                    {group.badgeText}
                  </span>
                )}
                <div className="model-group-info">
                  <div className="model-group-name">{group.name}</div>
                  <div className="model-group-desc">{group.description}</div>
                </div>
              </div>
              <div className="model-group-items">
                {group.models.map((model) => (
                  <button
                    key={model.value}
                    type="button"
                    className={`model-item ${selectedModel === model.value ? 'active' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(model);
                      setOpen(false);
                    }}
                  >
                    {model.iconType === 'badge' && model.badgeText && (
                      <span className="text-model-icon text-model-icon-badge" data-badge={model.badgeText}>
                        {model.badgeText}
                      </span>
                    )}
                    <div className="model-item-info">
                      <div className="model-item-name">{model.label}</div>
                      {model.description && (
                        <div className="model-item-desc">{model.description}</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
