/**
 * ModelSelector 模型选择器 — 下拉面板选择 AI 模型或工作流，支持按供应商分组折叠、搜索过滤、当前选中高亮
 * 未配置 API Key 的供应商分组自动禁用（锁图标 + tooltip + 不可展开）
 * 自动检测上下空间，向上或向下弹出
 */
import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import type { NodeType, ModelOption, ModelGroup, WorkflowDefinition } from '../../../types';
import { getWorkflowCategory, CATEGORY_TO_NODE_TYPES, GENERAL_MODEL_CATEGORY_LABELS } from '../../../types';
import { defaultModelGroups } from './defaultModels';
import { useAppStore } from '../../../store/useAppStore';

const MODEL_PREF_KEY = 'canvas-model-prefs';

function loadModelPrefs(): Record<string, string> {
  try {
    const raw = localStorage.getItem(MODEL_PREF_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveModelPref(nodeType: string, modelValue: string) {
  try {
    const prefs = loadModelPrefs();
    prefs[nodeType] = modelValue;
    localStorage.setItem(MODEL_PREF_KEY, JSON.stringify(prefs));
  } catch { /* ignore */ }
}

interface ModelSelectorProps {
  nodeType: NodeType;
  selectedModel?: string;
  selectedProvider?: string;
  selectedWorkflowId?: string;
  onSelect: (model: ModelOption) => void;
  onWorkflowSelect?: (workflowId: string | undefined) => void;
  groups?: ModelGroup[];
  workflows?: WorkflowDefinition[];
  /** 默认展开的分组 ID 列表（其余分组默认收起） */
  defaultExpandedGroupIds?: string[];
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
  defaultExpandedGroupIds = [],
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);

  // 读取配置 — 判断哪些 provider 有 API Key
  const configProviders = useAppStore((s) => s.config.providers);
  const generalModels = useAppStore((s) => s.config.generalModels || []);
  const dreaminaLoggedIn = useAppStore((s) => !!s.config.dreaminaAuth?.loggedIn);

  /** 动态生成「通用模型」分组 */
  const generalModelGroup: ModelGroup | null = useMemo(() => {
    if (generalModels.length === 0) return null;
    const models: ModelOption[] = generalModels.filter((gm) => CATEGORY_TO_NODE_TYPES[gm.category].includes(nodeType)).map((gm) => ({
      value: `general/${gm.id}`,
      provider: 'general',
      label: gm.name,
      description: `ID: ${gm.modelId}`,
      iconType: 'badge' as const,
      badgeText: GENERAL_MODEL_CATEGORY_LABELS[gm.category].slice(0, 2),
      nodeTypes: CATEGORY_TO_NODE_TYPES[gm.category],
    }));
    if (models.length === 0) return null;
    return {
      id: 'general-models',
      name: '通用模型',
      description: '用户自定义的兼容接口模型',
      iconType: 'badge',
      badgeText: 'GM',
      models,
    };
  }, [generalModels, nodeType]);

  /** 合并默认分组与通用模型分组 */
  const allGroups = useMemo(() => {
    const merged = [...groups];
    if (generalModelGroup) merged.push(generalModelGroup);
    return merged;
  }, [groups, generalModelGroup]);

  // 默认分组收起，except defaultExpandedGroupIds（含通用模型默认展开）
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    const ids = allGroups
      .map((g) => ({ ...g, models: g.models.filter((m) => m.nodeTypes.includes(nodeType)) }))
      .filter((g) => g.models.length > 0)
      .map((g) => g.id)
      .filter((id) => !defaultExpandedGroupIds.includes(id) && id !== 'general-models');
    return new Set(ids);
  });

  /** 判断某个 group 是否可用（该 group 的 provider 已配置 API Key） */
  const isGroupAvailable = useCallback(
    (groupId: string) => {
      // 通用模型分组：每个模型自带 API Key，始终可用
      if (groupId === 'general-models') return true;
      // 即梦：走 OAuth 登录，无 API Key，按登录态判定
      if (groupId === 'dreamina') return dreaminaLoggedIn;
      const providerKey = groupId === 'runninghubwf' ? 'runninghub' : groupId;
      const provider = configProviders[providerKey];
      return !!provider?.apiKey;
    },
    [configProviders, dreaminaLoggedIn],
  );
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 动态计算下拉弹出方向
  const [dropdownDir, setDropdownDir] = useState<'up' | 'down'>('up');
  const [dropdownAlignRight, setDropdownAlignRight] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const triggerEl = ref.current?.querySelector('.model-selector-trigger');
      if (!triggerEl) return;
      const triggerRect = triggerEl.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const PADDING = 8;
      const DROPDOWN_H = 360;
      const DROPDOWN_W = 280;

      // 若上方空间不足 360px → 向下弹出
      const spaceAbove = triggerRect.top - PADDING;
      if (spaceAbove < DROPDOWN_H) {
        const spaceBelow = vh - triggerRect.bottom - PADDING;
        if (spaceBelow >= DROPDOWN_H || spaceBelow > spaceAbove) {
          setDropdownDir('down');
        } else {
          setDropdownDir('up');
        }
      } else {
        setDropdownDir('up');
      }

      // 右边界溢出 → 右对齐
      if (triggerRect.left + DROPDOWN_W > vw - PADDING) {
        setDropdownAlignRight(true);
      } else {
        setDropdownAlignRight(false);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // 点击外部关闭（捕获阶段避免 React Flow 拦截）
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handler, true);
    }
    return () => document.removeEventListener('mousedown', handler, true);
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
  const filteredGroups = allGroups
    .map((g) => ({
      ...g,
      models: g.models.filter((m) => m.nodeTypes.includes(nodeType)),
    }))
    .filter((g) => g.models.length > 0);

  // 持久化偏好：优先 props 传入的 selectedModel，其次 localStorage 中的记录
  const effectiveModel = useMemo(
    () => selectedModel || loadModelPrefs()[nodeType] || undefined,
    [selectedModel, nodeType],
  );

  const currentModel = effectiveModel
    ? filteredGroups.flatMap((g) => g.models).find((m) => m.value === effectiveModel)
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

  // 切换分组折叠（不可用分组拒绝展开）
  const toggleGroup = (groupId: string) => {
    if (!isGroupAvailable(groupId)) return;
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
        <div
          ref={dropdownRef}
          className={`model-dropdown${dropdownDir === 'down' ? ' drop-down' : ''}${dropdownAlignRight ? ' drop-align-right' : ''}`}
        >
          {/* 模型供应商分组 */}
          {filteredGroups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.id);
            const hasActiveModel = group.models.some((m) => m.value === effectiveModel);
            const groupAvailable = isGroupAvailable(group.id);
            return (
              <div key={group.id} className={`model-group${hasActiveModel ? ' has-active' : ''}`}>
                <button
                  type="button"
                  className={`model-group-header${groupAvailable ? '' : ' disabled'}`}
                  title={groupAvailable ? undefined : `请先在设置中配置 ${group.name} API Key`}
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
                  {groupAvailable ? (
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
                  ) : (
                    <svg className="model-lock-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  )}
                </button>
                <div className={`model-group-items${isCollapsed ? ' collapsed' : ''}`}>
                  {group.models.map((model) => (
                    <button
                      key={model.value}
                      type="button"
                      className={`model-item${effectiveModel === model.value ? ' active' : ''}${groupAvailable ? '' : ' disabled'}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!groupAvailable) return;
                        saveModelPref(nodeType, model.value);
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
                      {effectiveModel === model.value && (
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
