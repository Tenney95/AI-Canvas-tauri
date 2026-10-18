/**
 * ModelSelector 模型选择器 — 下拉面板选择 AI 模型或工作流，支持按供应商分组折叠、搜索过滤、当前选中高亮
 * 未配置 API Key 的供应商分组自动禁用（锁图标 + tooltip + 不可展开）
 * 自动检测上下空间，向上或向下弹出
 */
import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { calcAnchoredPosition } from '../../../utils/popupPosition';
import type {
  GeneralModelConfig,
  NodeType,
  ModelOption,
  ModelGroup,
  WorkflowDefinition,
} from '../../../types';
import { getWorkflowCategory } from '../../../types';
import {
  defaultModelGroups,
  getConfiguredModelGroups,
  getGeneralModelGroups,
} from './defaultModels';
import { useAppStore } from '../../../store/useAppStore';
import { useT } from '../../../i18n';
import ProviderBadge from '../../shared/ProviderBadge';
import { ModelMenu, type ModelPickerGroup } from '../../shared/ModelPicker';
import { resolveAppearanceMode } from '../../../services/appearance/appearanceRuntime';
import { comfyBaseUrlFor, DEFAULT_COMFY_URL, probeComfyServer } from '../../../services/comfyServers';
import { getGenerationNodeType } from '../../../utils/nodeGeneration';

const MODEL_PREF_KEY = 'canvas-model-prefs';

/**
 * 没有独立模型清单的节点类型，借用哪一类的模型和偏好。
 * 分镜表让文本模型把剧本拆成表格行，用的就是生文那批模型。
 */
const MODEL_TYPE_FALLBACK: Partial<Record<NodeType, NodeType>> = {
  'ai-panorama': 'ai-image',
  'ai-animation': 'ai-image',
  'ai-shotlist': 'ai-text',
};

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
    // 生图模型选择时同步到全景图节点
    if (nodeType === 'ai-image') {
      prefs['ai-panorama'] = modelValue;
    }
    localStorage.setItem(MODEL_PREF_KEY, JSON.stringify(prefs));
  } catch { /* ignore */ }
}

interface ModelSelectorProps {
  nodeType: NodeType;
  /** 节点提示词栏用紧凑透明入口展示当前模型。 */
  appearance?: 'default' | 'pill';
  /** 独立窗口使用自身已应用的主题；省略时沿用主窗口配置。 */
  theme?: 'dark' | 'light';
  selectedModel?: string;
  selectedProvider?: string;
  selectedWorkflowId?: string;
  onSelect: (model: ModelOption) => void;
  onClear?: () => void;
  onWorkflowSelect?: (workflowId: string | undefined) => void;
  groups?: ModelGroup[];
  /** 已由可信宿主按配置筛选的模型分组；用于没有完整配置的独立窗口。 */
  configuredGroupsOverride?: ModelGroup[];
  workflows?: WorkflowDefinition[];
  generalModelsOverride?: GeneralModelConfig[];
  groupAvailability?: Record<string, boolean>;
  /** 默认展开的分组 ID 列表（其余分组默认收起） */
  defaultExpandedGroupIds?: string[];
}

export default function ModelSelector({
  nodeType,
  appearance = 'default',
  theme,
  selectedModel,
  selectedWorkflowId,
  onSelect,
  onClear,
  onWorkflowSelect,
  groups = defaultModelGroups,
  configuredGroupsOverride,
  workflows = [],
  generalModelsOverride,
  groupAvailability,
  defaultExpandedGroupIds = [],
}: ModelSelectorProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [editorOpening, setEditorOpening] = useState(false);
  const editorOpeningRef = useRef(false);
  const [workflowsCollapsed, setWorkflowsCollapsed] = useState(true);
  const [availableComfyUrls, setAvailableComfyUrls] = useState<Record<string, boolean>>({});
  const generationNodeType = getGenerationNodeType(nodeType);
  const modelNodeType = MODEL_TYPE_FALLBACK[generationNodeType] ?? generationNodeType;

  // 读取配置 — 判断哪些 provider 有 API Key
  const config = useAppStore((s) => s.config);
  const configProviders = config.providers;
  const configuredGeneralModels = config.generalModels || [];
  const dreaminaLoggedIn = !!config.dreaminaAuth?.loggedIn;
  const generalModels = generalModelsOverride ?? configuredGeneralModels;

  const configuredGroups = useMemo(
    () => configuredGroupsOverride ?? getConfiguredModelGroups(config, modelNodeType, groups, {
      filterSelectedModels: groups === defaultModelGroups,
    }),
    [config, configuredGroupsOverride, groups, modelNodeType],
  );

  /** 通用执行协议保持不变，只把有独立品牌展示的内置连接拆成厂商分组。 */
  const generalModelGroups = useMemo(() => getGeneralModelGroups(
    generalModels,
    config,
    modelNodeType,
    {
      genericName: t('通用模型'),
      genericDescription: t('用户自定义的兼容接口模型'),
    },
  ), [config, generalModels, modelNodeType, t]);

  /** 合并默认分组与通用模型分组 */
  const allGroups = useMemo(() => {
    return [...configuredGroups, ...generalModelGroups];
  }, [configuredGroups, generalModelGroups]);

  // 所有分组默认收起，仅展开 defaultExpandedGroupIds 显式指定的分组。
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    const ids = allGroups
      .map((g) => ({ ...g, models: g.models.filter((m) => m.nodeTypes.includes(modelNodeType)) }))
      .filter((g) => g.models.length > 0)
      .map((g) => g.id)
      .filter((id) => !defaultExpandedGroupIds.includes(id));
    return new Set(ids);
  });

  /** 判断某个 group 是否可用（该 group 的 provider 已配置 API Key） */
  const isGroupAvailable = useCallback(
    (groupId: string) => {
      // 独立窗口只接收主窗口已经筛选过的分组，不持有厂商凭据。
      if (configuredGroupsOverride?.some((group) => group.id === groupId)) return true;
      // 通用模型分组：每个模型自带 API Key，始终可用
      if (groupId === 'general-models' || groupId.startsWith('general-provider-')) return true;
      if (groupAvailability && groupId in groupAvailability) {
        return groupAvailability[groupId];
      }
      // 即梦：走 OAuth 登录，无 API Key，按登录态判定
      if (groupId === 'dreamina') return dreaminaLoggedIn;
      const providerKey = groupId === 'runninghubwf'
        ? 'runninghub'
        : groupId === 'runninghub'
          ? 'runninghub-model'
          : groupId;
      const provider = configProviders[providerKey];
      return !!provider?.apiKey;
    },
    [configProviders, configuredGroupsOverride, dreaminaLoggedIn, groupAvailability],
  );
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 菜单挂到视口，避免被弹窗、滚动面板或画布节点裁切。
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = ref.current?.querySelector<HTMLButtonElement>('.model-selector-trigger');
    const dropdown = dropdownRef.current;
    if (!trigger || !dropdown) return;
    const update = () => {
      const rect = trigger.getBoundingClientRect();
      const availableHeight = Math.max(rect.top - 12, window.innerHeight - rect.bottom - 12, 0);
      dropdown.style.width = `${Math.min(380, Math.max(0, window.innerWidth - 16))}px`;
      dropdown.style.maxHeight = `${Math.min(360, availableHeight)}px`;
      let layer = 300;
      for (let parent: HTMLElement | null = ref.current; parent; parent = parent.parentElement) {
        const value = Number.parseInt(window.getComputedStyle(parent).zIndex, 10);
        if (Number.isFinite(value)) layer = Math.max(layer, value + 1);
      }
      dropdown.style.zIndex = String(layer);
      const position = calcAnchoredPosition(rect, dropdown.offsetWidth, dropdown.offsetHeight, 4, 8);
      dropdown.style.left = `${position.left}px`;
      dropdown.style.top = `${position.top}px`;
      dropdown.dataset.placement = position.placement;
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(dropdown);
    observer?.observe(trigger);
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // 点击外部关闭（捕获阶段避免 React Flow 拦截）
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !dropdownRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handler, true);
    }
    return () => document.removeEventListener('mousedown', handler, true);
  }, [open]);

  // 先关闭菜单并归还焦点，避免 Escape 同时关闭父弹窗。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' || (e.key === 'Tab' && dropdownRef.current?.contains(e.target as Node))) {
        setOpen(false);
        ref.current?.querySelector<HTMLButtonElement>('.model-selector-trigger')?.focus({ preventScroll: true });
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }
    };
    if (open) {
      window.addEventListener('keydown', handler, true);
    }
    return () => window.removeEventListener('keydown', handler, true);
  }, [open]);

  // 筛选当前节点类型下可用的模型分组
  // 全景图和动画节点只复用生图模型，不复用图片节点的参数 UI
  const filteredGroups = allGroups
    .map((g) => ({
      ...g,
      models: g.models.filter((m) => m.nodeTypes.includes(modelNodeType)),
    }))
    .filter((g) => g.models.length > 0);

  // 持久化偏好：优先 props 传入的 selectedModel，其次 localStorage 中的记录
  // 全景图/动画回退到生图偏好，分镜表回退到生文偏好
  const effectiveModel = useMemo(
    () => {
      // 空字符串表示用户已清除当前节点选择，不再回填历史偏好。
      if (selectedModel === '') return undefined;
      const prefs = loadModelPrefs();
      const fallbackType = MODEL_TYPE_FALLBACK[generationNodeType];
      return selectedModel
        || prefs[generationNodeType]
        || prefs[nodeType]
        || (fallbackType ? prefs[fallbackType] : undefined)
        || undefined;
    },
    [selectedModel, nodeType, generationNodeType],
  );

  const currentGroup = effectiveModel
    ? filteredGroups.find((group) => group.models.some((model) => model.value === effectiveModel))
    : undefined;
  const currentModel = currentGroup?.models.find((model) => model.value === effectiveModel);

  const renderProviderBadge = (
    group: ModelGroup,
    model?: ModelOption,
    size: 'small' | 'medium' = 'medium',
    badgeAppearance: 'default' | 'metal' = 'default',
  ) => {
    const generalModel = model?.provider === 'general'
      ? generalModels.find((candidate) => `general/${candidate.id}` === model.value)
      : undefined;
    const providerId = generalModel?.providerConfigId
      || (group.id.startsWith('general-provider-')
        ? group.id.slice('general-provider-'.length)
        : group.id === 'runninghub' ? 'runninghub-model'
          : group.id === 'runninghubwf' ? 'runninghub' : group.id);
    return (
      <ProviderBadge
        providerId={providerId}
        config={configProviders[providerId]}
        fallbackName={group.name}
        fallbackBadge={group.badgeText}
        size={size}
        appearance={badgeAppearance}
        theme={theme ?? resolveAppearanceMode(config.appearance?.mode ?? config.theme)}
      />
    );
  };

  // 匹配当前节点类型的工作流
  const targetCategory = getWorkflowCategory(generationNodeType);
  const matchingWorkflows = useMemo(
    () => (targetCategory ? workflows.filter((w) => w.category === targetCategory) : []),
    [workflows, targetCategory],
  );

  // 与生成时一致：未绑定或服务器已删除时回落默认地址；云端工作流不检测 ComfyUI。
  const workflowUrls = useMemo(() => new Map(matchingWorkflows
    .filter((workflow) => !workflow.adapterType || workflow.adapterType === 'comfyui')
    .map((workflow) => {
      const bound = config.comfyServers?.find((server) => server.id === workflow.serverId)?.url;
      const normalize = (url?: string) => (url ?? '').trim().replace(/\/+$/, '');
      return [workflow.id, normalize(bound) || normalize(config.comfyUIUrl)];
    })), [matchingWorkflows, config.comfyServers, config.comfyUIUrl]);
  const probeUrlsKey = JSON.stringify([...new Set(workflowUrls.values())].filter(Boolean).sort());
  const canSelectWorkflow = !!onWorkflowSelect;
  useEffect(() => {
    if (!open || !canSelectWorkflow) return;
    const urls = JSON.parse(probeUrlsKey) as string[];
    if (urls.length === 0) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      await Promise.all(urls.map(async (url) => {
        const available = await probeComfyServer(url, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setAvailableComfyUrls((current) => ({ ...current, [url]: available }));
        }
      }));
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 10_000);
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, canSelectWorkflow, probeUrlsKey]);
  const visibleWorkflows = matchingWorkflows.filter((workflow) => {
    const url = workflowUrls.get(workflow.id);
    return url === undefined || availableComfyUrls[url] === true;
  });

  const currentWorkflow = selectedWorkflowId
    ? matchingWorkflows.find((w) => w.id === selectedWorkflowId)
    : undefined;
  const canEditWorkflow = !!currentWorkflow
    && (!currentWorkflow.adapterType || currentWorkflow.adapterType === 'comfyui');
  const editWorkflow = async () => {
    if (!currentWorkflow || !canEditWorkflow || editorOpeningRef.current) return;
    editorOpeningRef.current = true;
    setEditorOpening(true);
    setOpen(false);
    try {
      const { openComfyUIWorkflowEditor } = await import('../../../services/comfyUIWindowService');
      const result = await openComfyUIWorkflowEditor(
        comfyBaseUrlFor(currentWorkflow.id) || DEFAULT_COMFY_URL,
        currentWorkflow,
      );
      if (result.missingNodeClasses.length > 0) {
        useAppStore.getState().showToast(`已打开，但 ComfyUI 缺少这些节点：${result.missingNodeClasses.join('、')}`, 'error');
      }
    } catch (error) {
      const message = typeof error === 'string' ? error
        : error instanceof Error ? error.message : '无法在 ComfyUI 中打开工作流';
      useAppStore.getState().showToast(message, 'error');
    } finally {
      editorOpeningRef.current = false;
      setEditorOpening(false);
    }
  };

  const displayLabel = currentWorkflow
    ? currentWorkflow.name
    : currentModel?.label ?? t('选择模型');
  const canClearSelection = appearance === 'pill' && !!onClear && !!(effectiveModel || selectedWorkflowId);

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

  // 业务目录、凭据可用性与模型偏好留在宿主，公用菜单只接收展示条目。
  const workflowGroupId = '__workflows';
  const menuGroups: ModelPickerGroup[] = filteredGroups.map((group) => ({
    id: group.id,
    label: group.name,
    description: group.description,
    icon: renderProviderBadge(group, undefined, 'small'),
    disabled: !isGroupAvailable(group.id),
    disabledReason: isGroupAvailable(group.id) ? undefined : t('请先在设置中配置 {name} API Key', { name: group.name }),
    items: group.models.map((model) => ({ value: model.value, label: model.label, description: model.description })),
  }));
  if (targetCategory && onWorkflowSelect && visibleWorkflows.length > 0) {
    menuGroups.push({
      id: workflowGroupId,
      label: t('工作流'),
      description: t('ComfyUI、RunningHub 与工作流 API'),
      badgeText: 'WF',
      className: 'model-group-wf',
      items: visibleWorkflows.map((workflow) => ({
        value: `workflow:${workflow.id}`, label: workflow.name, description: workflow.fileName,
        icon: <span className="text-model-icon text-model-icon-mini wf-dot" />,
      })),
    });
  }
  const expandedGroupIds = [
    ...filteredGroups.filter((group) => !collapsedGroups.has(group.id)).map((group) => group.id),
    ...(!workflowsCollapsed ? [workflowGroupId] : []),
  ];
  const selectMenuItem = (value: string) => {
    const group = filteredGroups.find((candidate) => candidate.models.some((model) => model.value === value));
    const model = group?.models.find((candidate) => candidate.value === value);
    if (group && model && isGroupAvailable(group.id)) {
      saveModelPref(generationNodeType, model.value);
      onSelect(model);
      onWorkflowSelect?.(undefined);
      setOpen(false);
      ref.current?.querySelector<HTMLButtonElement>('.model-selector-trigger')?.focus({ preventScroll: true });
      return;
    }
    const workflow = visibleWorkflows.find((candidate) => `workflow:${candidate.id}` === value);
    if (workflow && onWorkflowSelect) {
      onWorkflowSelect(workflow.id);
      setOpen(false);
      ref.current?.querySelector<HTMLButtonElement>('.model-selector-trigger')?.focus({ preventScroll: true });
    }
  };

  return (
    <div className={`model-selector${appearance === 'pill' ? ' model-selector--pill' : ''}`} ref={ref}>
      <button
        type="button"
        className={`model-selector-trigger${appearance === 'pill' ? ' prompt-btn text-xs' : ''}${selectedWorkflowId ? ' has-workflow' : ''}${currentModel ? ' has-model' : ''}${canEditWorkflow ? ' has-workflow-editor' : ''}`}
        aria-expanded={open}
        title={displayLabel}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) setAvailableComfyUrls({});
          setOpen(!open);
        }}
      >
        <span className={appearance === 'pill' ? 'ui-model-pill__avatar' : 'model-selector-icon'}>
          {selectedWorkflowId ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          ) : currentGroup && currentModel ? renderProviderBadge(currentGroup, currentModel, 'medium', appearance === 'pill' ? 'metal' : 'default') : appearance === 'pill' ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
              <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
            </svg>
          ) : null}
        </span>
        <span className={appearance === 'pill' ? 'ui-model-pill__label' : 'model-selector-label'}>{displayLabel}</span>
        {appearance === 'pill' ? (
          <span className="ui-model-pill__action" aria-hidden="true">
            {!canClearSelection && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points={open ? '6 15 12 9 18 15' : '6 9 12 15 18 9'} />
            </svg>}
          </span>
        ) : (
          <svg className="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {canClearSelection && (
        <button
          type="button"
          className="prompt-btn model-selector-clear nodrag nopan"
          aria-label={t('清除当前模型选择')}
          title={t('清除当前模型选择')}
          onClick={(event) => {
            event.stopPropagation();
            setOpen(false);
            onClear?.();
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      )}

      {canEditWorkflow && (
        <button
          type="button"
          className="ui-icon-btn model-workflow-edit nodrag nopan"
          aria-label={t('在 ComfyUI 中编辑')}
          data-tooltip={t('在 ComfyUI 中编辑')}
          aria-busy={editorOpening}
          disabled={editorOpening}
          onClick={(event) => {
            event.stopPropagation();
            void editWorkflow();
          }}
        >
          {editorOpening ? <span className="ui-spinner" /> : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="m16 3 5 5M4 20l4-1L21 6a2.8 2.8 0 0 0-4-4L4 15l-1 6 6-1" />
            </svg>
          )}
        </button>
      )}

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="ui-model-menu__surface nowheel nodrag nopan"
          data-ui-select-portal=""
        >
          <ModelMenu
            groups={menuGroups}
            value={selectedWorkflowId ? `workflow:${selectedWorkflowId}` : effectiveModel}
            onChange={selectMenuItem}
            onClose={() => {
              setOpen(false);
              ref.current?.querySelector<HTMLButtonElement>('.model-selector-trigger')?.focus({ preventScroll: true });
            }}
            expandedGroupIds={expandedGroupIds}
            onGroupToggle={(groupId) => {
              if (groupId === workflowGroupId) setWorkflowsCollapsed((collapsed) => !collapsed);
              else toggleGroup(groupId);
            }}
          />
        </div>, document.body
      )}
    </div>
  );
}
