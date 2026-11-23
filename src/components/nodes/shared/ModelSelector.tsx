/**
 * ModelSelector 模型选择器 — 下拉面板选择 AI 模型或工作流，支持按供应商分组折叠、搜索过滤、当前选中高亮
 * 未配置 API Key 的供应商分组自动禁用（锁图标 + tooltip + 不可展开）
 * 自动检测上下空间，向上或向下弹出
 */
import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { trackModelMenuPosition } from '../../shared/modelMenuPosition';
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
import { ModelMenu, type ModelMenuProps, type ModelPickerGroup } from '../../shared/ModelPicker';
import { resolveAppearanceMode } from '../../../services/appearance/appearanceRuntime';
import { comfyBaseUrlFor, DEFAULT_COMFY_URL, probeComfyServer } from '../../../services/comfyServers';
import { getGenerationNodeType } from '../../../utils/nodeGeneration';
import { getModelPreferenceType, saveModelPreference, saveWorkflowModelPreference } from '../../../services/modelPreferenceService';
import { isTauriEnv } from '../../../services/fs/core';

const EMPTY_WORKFLOWS: WorkflowDefinition[] = [];
const EMPTY_GENERAL_MODELS: GeneralModelConfig[] = [];

interface ModelSelectorProps {
  nodeType: NodeType;
  disabled?: boolean;
  /** 临时工具选择不覆盖节点的上次模型偏好。 */
  persistPreference?: boolean;
  /** 节点提示词栏用紧凑透明入口展示当前模型。 */
  appearance?: 'default' | 'pill';
  /** 紧凑配置行使用 UI Kit 的最小控件尺寸；默认保留现有显示。 */
  size?: 'sm' | 'md';
  /** 提示词栏将编辑入口放到右侧工具区；null 表示目标尚未挂载。 */
  workflowEditorTarget?: HTMLElement | null;
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

function getMenuHost(trigger: HTMLElement): 'main' | 'detached' | 'dialog' {
  if (new URLSearchParams(window.location.search).get('view')) return 'detached';
  // 设置面板使用 ModalOverlay 的默认层级 250。上层弹窗可能有草稿，留给用户自行关闭。
  for (let layer = trigger.closest<HTMLElement>('[aria-modal="true"]'); layer; layer = layer.parentElement) {
    if (Number.parseInt(window.getComputedStyle(layer).zIndex, 10) >= 250) return 'dialog';
  }
  return 'main';
}

export default function ModelSelector({
  nodeType,
  disabled = false,
  persistPreference = true,
  appearance = 'default',
  size = 'md',
  workflowEditorTarget,
  theme,
  selectedModel,
  selectedWorkflowId,
  onSelect,
  onClear,
  onWorkflowSelect,
  groups = defaultModelGroups,
  configuredGroupsOverride,
  workflows = EMPTY_WORKFLOWS,
  generalModelsOverride,
  groupAvailability,
  defaultExpandedGroupIds = [],
}: ModelSelectorProps) {
  const t = useT();
  const [menuHost, setMenuHost] = useState<ReturnType<typeof getMenuHost> | null>(null);
  const open = menuHost !== null;
  if (disabled && open) setMenuHost(null);
  const [editorOpening, setEditorOpening] = useState(false);
  const editorOpeningRef = useRef(false);
  const [workflowsCollapsed, setWorkflowsCollapsed] = useState(true);
  const [availableComfyUrls, setAvailableComfyUrls] = useState<Record<string, boolean>>({});
  const generationNodeType = getGenerationNodeType(nodeType);
  const modelNodeType = getModelPreferenceType(nodeType);

  // 读取配置 — 判断哪些 provider 有 API Key
  const config = useAppStore((s) => s.config);
  const configProviders = config.providers;
  const dreaminaLoggedIn = !!config.dreaminaAuth?.loggedIn;
  const generalModels = generalModelsOverride ?? config.generalModels ?? EMPTY_GENERAL_MODELS;

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

  // 触发按钮和菜单共用同一份目录，全景图和动画节点也按各自映射的模型类型筛选。
  const filteredGroups = useMemo(() => [...configuredGroups, ...generalModelGroups]
    .map((group) => ({ ...group, models: group.models.filter((model) => model.nodeTypes.includes(modelNodeType)) }))
    .filter((group) => group.models.length > 0), [configuredGroups, generalModelGroups, modelNodeType]);

  // 所有分组默认收起，仅展开 defaultExpandedGroupIds 显式指定的分组。
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    const ids = filteredGroups
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
      // Muse 会话由原生保管；这里只确认桌面入口和连接，实际登录态在执行前复核。
      if (groupId === 'muse') return isTauriEnv() && !!configProviders.muse
        && (!configProviders.muse.catalogId || configProviders.muse.catalogId === 'muse');
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
    return trackModelMenuPosition(trigger, dropdown);
  }, [open]);

  // 点击外部关闭（捕获阶段避免 React Flow 拦截）
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !dropdownRef.current?.contains(e.target as Node)) {
        setMenuHost(null);
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
        setMenuHost(null);
        ref.current?.querySelector<HTMLButtonElement>('.model-selector-trigger')?.focus({ preventScroll: true });
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }
    };
    if (open && !disabled) {
      window.addEventListener('keydown', handler, true);
    }
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, disabled]);

  // 只展示调用方真实绑定；历史偏好在 UI 新建时写入，旧节点和临时表单不做隐式回填。
  const effectiveModel = selectedModel || undefined;

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
  const matchingWorkflows = useMemo(
    () => {
      const category = getWorkflowCategory(getGenerationNodeType(nodeType));
      return category ? workflows.filter((workflow) => workflow.category === category) : [];
    },
    [workflows, nodeType],
  );

  // 与生成时一致：未绑定或服务器已删除时回落默认地址；云端工作流不检测 ComfyUI。
  const menuOpen = open && !disabled;
  const menuWorkflows = menuOpen && onWorkflowSelect ? matchingWorkflows : EMPTY_WORKFLOWS;
  const workflowUrls = useMemo(() => new Map(menuWorkflows
    .filter((workflow) => !workflow.adapterType || workflow.adapterType === 'comfyui')
    .map((workflow) => {
      const bound = config.comfyServers?.find((server) => server.id === workflow.serverId)?.url;
      const normalize = (url?: string) => (url ?? '').trim().replace(/\/+$/, '');
      return [workflow.id, normalize(bound) || normalize(config.comfyUIUrl)];
    })), [menuWorkflows, config.comfyServers, config.comfyUIUrl]);
  const probeUrlsKey = useMemo(() => JSON.stringify([...new Set(workflowUrls.values())].filter(Boolean).sort()), [workflowUrls]);
  useEffect(() => {
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
  }, [probeUrlsKey]);
  const visibleWorkflows = menuWorkflows.filter((workflow) => {
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
    setMenuHost(null);
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
  const menuGroups: ModelPickerGroup[] = menuOpen ? filteredGroups.map((group) => ({
    id: group.id,
    label: group.name,
    description: group.description,
    icon: renderProviderBadge(group, undefined, 'small'),
    disabled: !isGroupAvailable(group.id),
    disabledReason: isGroupAvailable(group.id) ? undefined : group.id === 'muse'
      ? t('请在桌面应用的设置中连接 Muse 并完成网页登录')
      : t('请先在设置中配置 {name} API Key', { name: group.name }),
    items: group.models.map((model) => ({ value: model.value, label: model.label, description: model.description })),
  })) : [];
  if (visibleWorkflows.length > 0) {
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
  let emptyText: string | undefined;
  let emptyAction: ModelMenuProps['emptyAction'];
  if (menuOpen && menuGroups.length === 0) {
    const hasLocalWorkflows = workflowUrls.size > 0;
    const checking = hasLocalWorkflows && [...workflowUrls.values()].some((url) => url && availableComfyUrls[url] === undefined);
    if (checking) {
      emptyText = t('正在检查 ComfyUI 工作流连接…');
    } else {
      const tab = hasLocalWorkflows ? 'ComfyUI' : 'API Key';
      if (hasLocalWorkflows) {
        emptyText = t('已导入的 ComfyUI 工作流暂不可用，请检查服务器连接。');
      } else if (menuHost !== 'detached' && !configuredGroupsOverride && !generalModels.length && !dreaminaLoggedIn && !Object.keys(configProviders).length) {
        emptyText = t('尚未添加模型连接。');
      } else {
        emptyText = t('当前用途没有可选模型，请检查连接和已启用的模型。');
      }
      if (menuHost === 'main') {
        emptyAction = { label: t('打开 {tab} 设置', { tab }), onClick: () => {
          setMenuHost(null);
          useAppStore.getState().setSettingsOpen(true, hasLocalWorkflows ? 'comfyui' : 'api');
        } };
      } else {
        const hint = menuHost === 'detached' ? t('请前往主窗口的「设置 → {tab}」。', { tab })
          : t('关闭当前弹窗后，请前往「设置 → {tab}」。', { tab });
        emptyText = `${emptyText} ${hint}`;
      }
    }
  }
  const selectMenuItem = (value: string) => {
    if (disabled) return;
    const group = filteredGroups.find((candidate) => candidate.models.some((model) => model.value === value));
    const model = group?.models.find((candidate) => candidate.value === value);
    if (group && model && isGroupAvailable(group.id)) {
      if (persistPreference) saveModelPreference(generationNodeType, model.value);
      onSelect(model);
      onWorkflowSelect?.(undefined);
      setMenuHost(null);
      ref.current?.querySelector<HTMLButtonElement>('.model-selector-trigger')?.focus({ preventScroll: true });
      return;
    }
    const workflow = visibleWorkflows.find((candidate) => `workflow:${candidate.id}` === value);
    if (workflow && onWorkflowSelect) {
      if (persistPreference) saveWorkflowModelPreference(generationNodeType, workflow);
      onWorkflowSelect(workflow.id);
      setMenuHost(null);
      ref.current?.querySelector<HTMLButtonElement>('.model-selector-trigger')?.focus({ preventScroll: true });
    }
  };

  const workflowEditButton = canEditWorkflow ? (
    <button
      type="button"
      className={workflowEditorTarget ? 'prompt-btn model-workflow-edit--toolbar nodrag nopan' : 'ui-icon-btn ui-icon-btn--ghost model-workflow-edit nodrag nopan'}
      aria-label={t('在 ComfyUI 中编辑')}
      data-tooltip={t('在 ComfyUI 中编辑')}
      aria-busy={editorOpening}
      disabled={disabled || editorOpening}
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
  ) : null;

  return (
    <div className={`model-selector${appearance === 'pill' ? ' model-selector--pill' : ''}${size === 'sm' ? ' model-selector--sm' : ''}`} ref={ref}>
      <button
        type="button"
        className={`model-selector-trigger${appearance === 'pill' ? ' prompt-btn text-xs' : ''}${selectedWorkflowId ? ' has-workflow' : ''}${currentModel ? ' has-model' : ''}${canEditWorkflow && workflowEditorTarget === undefined ? ' has-workflow-editor' : ''}`}
        aria-expanded={open && !disabled}
        disabled={disabled}
        title={displayLabel}
        onClick={(e) => {
          e.stopPropagation();
          if (open) { setMenuHost(null); return; }
          setAvailableComfyUrls({});
          setMenuHost(getMenuHost(e.currentTarget));
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
          disabled={disabled}
          aria-label={t('清除当前模型选择')}
          title={t('清除当前模型选择')}
          onClick={(event) => {
            event.stopPropagation();
            setMenuHost(null);
            onClear?.();
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      )}

      {workflowEditorTarget === undefined ? workflowEditButton
        : workflowEditorTarget && workflowEditButton && createPortal(workflowEditButton, workflowEditorTarget)}

      {menuOpen && createPortal(
        <div
          ref={dropdownRef}
          className="ui-model-menu__surface nowheel nodrag nopan"
          data-ui-select-portal=""
        >
          <ModelMenu
            groups={menuGroups}
            emptyText={emptyText}
            emptyAction={emptyAction}
            value={selectedWorkflowId ? `workflow:${selectedWorkflowId}` : effectiveModel}
            onChange={selectMenuItem}
            onClose={() => {
              setMenuHost(null);
              ref.current?.querySelector<HTMLButtonElement>('.model-selector-trigger')?.focus({ preventScroll: true });
            }}
            expandedGroupIds={[
              ...filteredGroups.filter((group) => !collapsedGroups.has(group.id)).map((group) => group.id),
              ...(!workflowsCollapsed ? [workflowGroupId] : []),
            ]}
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
