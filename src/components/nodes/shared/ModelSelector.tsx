import { useState, useRef, useEffect, useMemo } from 'react';
import type { NodeType, ModelOption, ModelGroup, WorkflowDefinition } from '../../../types';
import { getWorkflowCategory } from '../../../types';
import { defaultModelGroups } from './defaultModels';

interface ModelSelectorProps {
  nodeType: NodeType;
  selectedModel?: string;
  selectedProvider?: string;
  selectedWorkflowId?: string;
  onSelect: (model: ModelOption) => void;
  onWorkflowSelect?: (workflowId: string | undefined) => void;
  groups?: ModelGroup[];
  workflows?: WorkflowDefinition[];
}

export default function ModelSelector({
  nodeType,
  selectedModel,
  selectedProvider: _selectedProvider,
  selectedWorkflowId,
  onSelect,
  onWorkflowSelect,
  groups = defaultModelGroups,
  workflows = [],
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  // 默认所有分组都收起
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    const ids = groups
      .map((g) => ({ ...g, models: g.models.filter((m) => m.nodeTypes.includes(nodeType)) }))
      .filter((g) => g.models.length > 0)
      .map((g) => g.id);
    return new Set(ids);
  });
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
      if (e.key === 'Escape') setOpen(false);
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

  // 匹配当前节点类型的工作流
  const targetCategory = getWorkflowCategory(nodeType);
  const matchingWorkflows = useMemo(
    () => (targetCategory ? workflows.filter((w) => w.category === targetCategory) : []),
    [workflows, targetCategory],
  );

  const currentWorkflow = selectedWorkflowId
    ? matchingWorkflows.find((w) => w.id === selectedWorkflowId)
    : undefined;

  const displayLabel = currentWorkflow
    ? currentWorkflow.name
    : currentModel?.label ?? '选择模型';

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  return (
    <div className="model-selector" ref={ref}>
      <button
        type="button"
        className={`model-selector-trigger${selectedWorkflowId ? ' has-workflow' : ''}${currentModel ? ' has-model' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <span className="model-selector-icon">
          {selectedWorkflowId ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          ) : currentModel?.badgeText ? (
            <span className="text-model-icon text-model-icon-mini" data-badge={currentModel.badgeText}>
              {currentModel.badgeText}
            </span>
          ) : null}
        </span>
        <span className="model-selector-label">{displayLabel}</span>
        <svg className="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="model-dropdown">
          {/* 模型供应商分组 */}
          {filteredGroups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.id);
            const hasActiveModel = group.models.some((m) => m.value === selectedModel);
            return (
              <div key={group.id} className={`model-group${hasActiveModel ? ' has-active' : ''}`}>
                <button
                  type="button"
                  className="model-group-header"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleGroup(group.id);
                  }}
                >
                  {group.iconType === 'badge' && group.badgeText && (
                    <span className="text-model-icon text-model-icon-badge" data-badge={group.badgeText}>
                      {group.badgeText}
                    </span>
                  )}
                  <div className="model-group-info">
                    <div className="model-group-name">{group.name}</div>
                    <div className="model-group-desc">{group.description}</div>
                  </div>
                  <svg
                    className={`model-group-chevron${isCollapsed ? ' collapsed' : ''}`}
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                <div className={`model-group-items${isCollapsed ? ' collapsed' : ''}`}>
                  {group.models.map((model) => (
                    <button
                      key={model.value}
                      type="button"
                      className={`model-item${selectedModel === model.value ? ' active' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(model);
                        onWorkflowSelect?.(undefined);
                        setOpen(false);
                      }}
                    >
                      {model.iconType === 'badge' && model.badgeText && (
                        <span className="text-model-icon text-model-icon-mini" data-badge={model.badgeText}>
                          {model.badgeText}
                        </span>
                      )}
                      <div className="model-item-info">
                        <div className="model-item-name">{model.label}</div>
                        {model.description && (
                          <div className="model-item-desc">{model.description}</div>
                        )}
                      </div>
                      {selectedModel === model.value && (
                        <svg className="model-item-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}

          {/* ComfyUI 工作流区域 */}
          {targetCategory && onWorkflowSelect && (
            <div className="model-group model-group-wf">
              <div className="model-group-header">
                <span className="text-model-icon text-model-icon-wf">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                </span>
                <div className="model-group-info">
                  <div className="model-group-name">ComfyUI 工作流</div>
                  <div className="model-group-desc">用户导入的本地工作流</div>
                </div>
              </div>
              <div className="model-group-items">
                {matchingWorkflows.length === 0 ? (
                  <div className="model-wf-empty">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>暂无匹配的工作流，请在设置中导入</span>
                  </div>
                ) : (
                  <>
                    {/* 各匹配工作流 */}
                    {matchingWorkflows.map((wf) => (
                      <button
                        key={wf.id}
                        type="button"
                        className={`model-item${selectedWorkflowId === wf.id ? ' active' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onWorkflowSelect(wf.id);
                          setOpen(false);
                        }}
                      >
                        <span className="text-model-icon text-model-icon-mini wf-dot" />
                        <div className="model-item-info">
                          <div className="model-item-name">{wf.name}</div>
                          {wf.fileName && (
                            <div className="model-item-desc">{wf.fileName}</div>
                          )}
                        </div>
                        {selectedWorkflowId === wf.id && (
                          <svg className="model-item-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
