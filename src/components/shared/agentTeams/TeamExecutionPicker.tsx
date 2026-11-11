import { memo, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { GeneralModelConfig, ModelGroup } from '../../../types';
import type { AgentTeamProfile, AssistantExecutionSelection, TeamExecutionTarget, TeamGraphDefinition, TeamGraphNode, TeamRoleId, TeamTemplateId } from '../../../types/agentTeam';
import type { ExternalAgentDescriptor } from '../../../types/externalAgent';
import { TEAM_ROLE_DESCRIPTIONS, TEAM_ROLE_LABELS, TEAM_ROLES, TEAM_TEMPLATE_LABELS } from '../../../services/chat/teams/teamProfileService';
import { createTemplateTeamGraph, ROLE_KINDS, teamGraphAncestors, validateTeamGraph } from '../../../services/chat/teams/teamGraphService';
import { useT } from '../../../i18n';
import ModelSelector from '../../nodes/shared/ModelSelector';
import ModalOverlay from '../ModalOverlay';
import NumberStepper from '../NumberStepper';
import Select from '../Select';

export interface TeamExecutionPickerProps {
  value: AssistantExecutionSelection;
  onChange: (selection: AssistantExecutionSelection) => void;
  profile: AgentTeamProfile;
  onProfileChange: (profile: AgentTeamProfile) => void | Promise<void>;
  modelGroups?: ModelGroup[];
  generalModels?: GeneralModelConfig[];
  groupAvailability?: Record<string, boolean>;
  externalAgents?: ExternalAgentDescriptor[];
  onRefreshExternalAgents?: () => Promise<void>;
  theme?: 'dark' | 'light';
  disabled?: boolean;
  compact?: boolean;
  /** 助手可分别在顶部展示执行方式、在输入区展示团队配置。 */
  controls?: 'all' | 'execution' | 'configuration';
  defaultTemplateId?: TeamTemplateId;
}

const TEMPLATES: readonly TeamTemplateId[] = ['general', 'outline', 'script', 'review'];
const GRAPH_KIND_LABELS: Record<TeamGraphNode['kind'], string> = {
  outline: '结构大纲', draft: '正文起草', review: '独立审阅', decision: '主编裁决', revision: '统一修订',
};
const NO_EXTERNAL_AGENTS: ExternalAgentDescriptor[] = [];

export function TeamGraphEditor({ value, onChange, disabled = false }: {
  value: TeamGraphDefinition;
  onChange: (graph: TeamGraphDefinition) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const id = useId();
  let validationError = '';
  try { validateTeamGraph(value); }
  catch (reason) { validationError = reason instanceof Error ? reason.message : t('团队任务图无效'); }
  const update = (nodeId: string, changes: Partial<TeamGraphNode>) => {
    onChange({ ...value, nodes: value.nodes.map((node) => node.id === nodeId ? { ...node, ...changes } : node) });
  };
  const add = () => {
    if (disabled || value.nodes.length >= 12) return;
    const previous = value.nodes.find((node) => node.id === value.finalTaskId);
    const nextId = `task_${crypto.randomUUID().replaceAll('-', '')}`;
    const next: TeamGraphNode = { id: nextId, roleId: 'writer', title: t('新增写作任务'), kind: 'draft',
      dependsOn: previous ? [previous.id] : [],
      ...(previous && ['outline', 'draft', 'revision'].includes(previous.kind) ? { sourceTaskId: previous.id } : {}) };
    onChange({ ...value, nodes: [...value.nodes, next], finalTaskId: nextId });
  };
  const remove = (nodeId: string) => {
    if (disabled || value.nodes.length < 2) return;
    const nodes = value.nodes.filter((node) => node.id !== nodeId).map((node) => ({ ...node,
      dependsOn: node.dependsOn.filter((dependency) => dependency !== nodeId),
      ...(node.sourceTaskId === nodeId ? { sourceTaskId: undefined } : {}) }));
    onChange({ ...value, nodes, finalTaskId: value.finalTaskId === nodeId ? nodes.at(-1)!.id : value.finalTaskId });
  };

  return <section className="space-y-2" aria-label={t('团队任务图')}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="ui-label">{t('团队任务图')}</h3>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={disabled || value.nodes.length >= 12} onClick={add}>{t('新增任务')}</button>
    </div>
    <p className="text-xs text-canvas-text-muted">{t('每个任务指定负责人、依赖和正文来源；全部任务须参与最终交付，最多 12 个任务。')}</p>
    <ol className="space-y-2">
      {value.nodes.map((node, index) => {
        const ancestors = teamGraphAncestors(value, node.id);
        const sourceOptions = value.nodes.filter((entry) => entry.id !== node.id && ['outline', 'draft', 'revision'].includes(entry.kind));
        return <li key={node.id} className="ui-card p-2 space-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="ui-badge shrink-0">{index + 1}</span>
            <input className="ui-input ui-input--sm min-w-0 flex-1" aria-label={t('任务 {number} 名称', { number: index + 1 })}
              value={node.title} maxLength={180} disabled={disabled} onChange={(event) => update(node.id, { title: event.target.value })} />
            <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost shrink-0" disabled={disabled || value.nodes.length < 2}
              aria-label={t('删除任务 {name}', { name: node.title })} onClick={() => remove(node.id)}><Icon icon="mdi:delete-outline" width="16" /></button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="ui-field">
              <label className="ui-label" htmlFor={`${id}-${node.id}-role`}>{t('负责人')}</label>
              <Select<TeamRoleId> id={`${id}-${node.id}-role`} size="sm" className="w-full" value={node.roleId} disabled={disabled}
                options={TEAM_ROLES.map((role) => ({ value: role, label: t(TEAM_ROLE_LABELS[role]) }))}
                onChange={(roleId) => update(node.id, { roleId, modelId: undefined, kind: ROLE_KINDS[roleId].includes(node.kind) ? node.kind : ROLE_KINDS[roleId][0] })} />
            </div>
            <div className="ui-field">
              <label className="ui-label" htmlFor={`${id}-${node.id}-kind`}>{t('产物类型')}</label>
              <Select<TeamGraphNode['kind']> id={`${id}-${node.id}-kind`} size="sm" className="w-full" value={node.kind} disabled={disabled}
                options={ROLE_KINDS[node.roleId].map((kind) => ({ value: kind, label: t(GRAPH_KIND_LABELS[kind]) }))}
                onChange={(kind) => update(node.id, { kind })} />
            </div>
          </div>
          {node.modelId && <div className="flex flex-wrap items-center gap-2 text-xs text-canvas-text-muted">
            <span className="break-words">{t('单任务模型覆盖：{model}', { model: node.modelId })}</span>
            <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={disabled} onClick={() => update(node.id, { modelId: undefined })}>{t('使用角色模型')}</button>
          </div>}
          <fieldset className="space-y-1" disabled={disabled}>
            <legend className="ui-label">{t('等待任务完成')}</legend>
            <div className="flex flex-wrap gap-x-3 gap-y-2">
              {value.nodes.filter((entry) => entry.id !== node.id).map((entry) => {
                const dependencyId = `${id}-${node.id}-dependency-${entry.id}`;
                return <span key={entry.id} className="relative min-w-0 max-w-full">
                  <input id={dependencyId} type="checkbox" className="ui-checkbox" checked={node.dependsOn.includes(entry.id)}
                    onChange={(event) => update(node.id, { dependsOn: event.target.checked ? [...node.dependsOn, entry.id] : node.dependsOn.filter((dependency) => dependency !== entry.id) })} />
                  <label htmlFor={dependencyId} className="max-w-full"><span className="truncate" title={entry.title}>{entry.title}</span></label>
                </span>;
              })}
              {value.nodes.length === 1 && <span className="text-xs text-canvas-text-muted">{t('没有其他依赖任务')}</span>}
            </div>
          </fieldset>
          <div className="ui-field">
            <label className="ui-label" htmlFor={`${id}-${node.id}-source`}>{t('正文来源')}</label>
            <Select id={`${id}-${node.id}-source`} size="sm" className="w-full" value={node.sourceTaskId ?? ''} disabled={disabled}
              options={[{ value: '', label: t('原始任务材料') }, ...sourceOptions.map((entry) => ({ value: entry.id, label: entry.title, disabled: !ancestors.has(entry.id) }))]}
              onChange={(sourceTaskId) => update(node.id, { sourceTaskId: sourceTaskId || undefined })} />
          </div>
        </li>;
      })}
    </ol>
    <div className="ui-field">
      <label className="ui-label" htmlFor={`${id}-final`}>{t('最终交付任务')}</label>
      <Select id={`${id}-final`} size="sm" className="w-full" value={value.finalTaskId} disabled={disabled}
        options={value.nodes.map((node) => ({ value: node.id, label: node.title, disabled: node.kind === 'review' }))}
        onChange={(finalTaskId) => onChange({ ...value, finalTaskId })} />
    </div>
    {validationError && <p role="status" className="ui-alert ui-alert--warning text-xs">{t(validationError)}</p>}
  </section>;
}

function TeamExecutionPicker({
  value, onChange, profile, onProfileChange, modelGroups, generalModels, groupAvailability, externalAgents = NO_EXTERNAL_AGENTS, onRefreshExternalAgents,
  theme, disabled = false, compact = false, controls = 'all', defaultTemplateId = 'general',
}: TeamExecutionPickerProps) {
  const t = useT();
  const templateInputId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(profile);
  const [templateId, setTemplateId] = useState<TeamTemplateId>(value.kind === 'team' ? value.templateId : defaultTemplateId);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const saveInFlight = useRef(false);
  const configuredCount = useMemo(() => TEAM_ROLES.filter((role) => (profile.roleExecutors?.[role]?.modelId ?? profile.roles[role])?.trim()).length, [profile.roles, profile.roleExecutors]);

  const openConfiguration = () => {
    setDraft(structuredClone(profile));
    setTemplateId(value.kind === 'team' ? value.templateId : defaultTemplateId);
    setError('');
    setOpen(true);
  };

  const save = async () => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setError('');
    try {
      if (!Number.isSafeInteger(draft.maxCalls) || draft.maxCalls < 4 || draft.maxCalls > 12
        || !Number.isSafeInteger(draft.maxTotalTokens) || draft.maxTotalTokens < 20000 || draft.maxTotalTokens > 1000000
        || !Number.isSafeInteger(draft.maxOutputChars) || draft.maxOutputChars < 2000 || draft.maxOutputChars > 64000) {
        throw new Error(t('团队预算数值超出允许范围'));
      }
      const graph = validateTeamGraph(draft.graph ?? createTemplateTeamGraph(templateId));
      if (draft.maxCalls < graph.nodes.length) throw new Error(t('调用预算不能少于任务数量'));
      for (const node of graph.nodes) {
        const executor = draft.roleExecutors?.[node.roleId];
        if (executor?.kind === 'external-agent') {
          const provider = externalAgents.find((entry) => entry.id === executor.providerId);
          if (!provider?.available || !provider.models.some((model) => model.id === executor.modelId)) throw new Error(t('外部成员不可用，请检查登记与模型选择'));
          if (node.modelId && node.modelId !== executor.modelId) throw new Error(t('外部成员的单任务模型覆盖与角色模型不一致，请先使用角色模型'));
        } else if (!(node.modelId ?? executor?.modelId ?? draft.roles[node.roleId])?.trim()) throw new Error(t('请为任务负责人选择文本模型'));
      }
      await onProfileChange({ ...draft, graph });
      onChange({ kind: 'team', templateId });
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('保存团队配置失败'));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };
  const refreshExternalAgents = async () => {
    if (!onRefreshExternalAgents || saving || refreshing) return;
    setRefreshing(true); setError('');
    try { await onRefreshExternalAgents(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('刷新外部执行器失败')); }
    finally { setRefreshing(false); }
  };

  return (
    <div className={`flex min-w-0 max-w-full items-center gap-1 ${compact ? '' : 'flex-wrap'}`}>
      {controls !== 'configuration' && <div className="ui-segmented shrink-0" role="group" aria-label={t('执行方式')}>
        <button type="button" className={`ui-segmented__item${value.kind === 'single' ? ' is-active' : ''}`}
          disabled={disabled} aria-pressed={value.kind === 'single'}
          title={t('根据需求自动选用已授权的智能体与 Skill；简单任务直接完成')}
          onClick={() => onChange({ kind: 'single' })}>
          {t('智能调度')}
        </button>
        <button type="button" className={`ui-segmented__item${value.kind === 'team' ? ' is-active' : ''}`}
          disabled={disabled} aria-pressed={value.kind === 'team'} onClick={() => {
            onChange({ kind: 'team', templateId: value.kind === 'team' ? value.templateId : defaultTemplateId });
            if (configuredCount === 0) openConfiguration();
          }}>
          {t('团队')}
        </button>
      </div>}
      {controls !== 'execution' && value.kind === 'team' && (
        <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost min-w-0" disabled={disabled}
          onClick={openConfiguration} title={t('配置团队角色与预算')} aria-label={t('配置团队角色与预算')}>
          <Icon icon="mdi:account-group-outline" width="15" className="shrink-0" />
          <span className="truncate">{t(TEAM_TEMPLATE_LABELS[value.templateId])}</span>
          {!compact && <span className="shrink-0 text-canvas-text-muted">{t('{count} 个角色已配置', { count: configuredCount })}</span>}
          <Icon icon="mdi:chevron-down" width="14" className="shrink-0" />
        </button>
      )}
      <ModalOverlay isOpen={open} onClose={() => { if (!saving) setOpen(false); }} ariaLabel={t('多模型团队配置')}
        className="w-full max-w-xl max-h-[85vh] mx-2" zIndex={300}>
        <header className="flex shrink-0 items-center gap-2 border-b border-canvas-border p-3">
          <Icon icon="mdi:account-group-outline" width="18" />
          <h2 className="min-w-0 flex-1 text-sm font-semibold">{t('多模型团队配置')}</h2>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={saving} onClick={() => setOpen(false)} aria-label={t('关闭')}>
            <Icon icon="mdi:close" width="18" />
          </button>
        </header>
        <div className="min-h-0 space-y-3 overflow-y-auto p-3 text-xs text-canvas-text">
          <div className="ui-field">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="ui-label" htmlFor={templateInputId}>{t('团队模板')}</label>
              <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={saving}
                onClick={() => { setDraft((current) => ({ ...current, graph: createTemplateTeamGraph(templateId) })); setError(''); }}>
                {t('恢复模板任务图')}
              </button>
            </div>
            <Select<TeamTemplateId> id={templateInputId} size="sm" className="w-full" value={templateId} disabled={saving}
              onChange={(next) => { setTemplateId(next); setDraft((current) => ({ ...current, graph: createTemplateTeamGraph(next) })); }} options={TEMPLATES.map((id) => ({ value: id, label: t(TEAM_TEMPLATE_LABELS[id]) }))} />
          </div>
          <p className="text-canvas-text-muted">{t('每个角色可选择不同模型；团队执行方式不会改变规划、协作或自主权限。')}</p>
          {onRefreshExternalAgents && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={saving || refreshing}
            onClick={() => void refreshExternalAgents()}><Icon icon="mdi:refresh" width="15" />{refreshing ? t('正在刷新执行器…') : t('刷新外部执行器')}</button>}
          <div className="space-y-2">
            {TEAM_ROLES.map((role) => {
              const executor = draft.roleExecutors?.[role];
              const selected = (executor?.kind === 'text-model' ? executor.modelId : draft.roles[role]) ?? '';
              const external = executor?.kind === 'external-agent' ? externalAgents.find((provider) => provider.id === executor.providerId) : undefined;
              const isGeneral = generalModels?.some((model) => model.id === selected && model.category === 'text');
              return (
                <div key={role} className="ui-card min-w-0 p-2">
                  <div className="flex min-w-0 items-center gap-2" aria-label={t('{role}的模型', { role: t(TEAM_ROLE_LABELS[role]) })}>
                    <span className="w-16 shrink-0 truncate text-xs font-medium sm:w-24" title={t(TEAM_ROLE_LABELS[role])}>{t(TEAM_ROLE_LABELS[role])}</span>
                    <Select size="sm" className="w-24 min-w-0 shrink-0 sm:w-28" aria-label={t('{role}的执行器', { role: t(TEAM_ROLE_LABELS[role]) })} value={executor?.kind === 'external-agent' ? executor.providerId : 'text-model'} disabled={saving}
                      options={[{ value: 'text-model', label: t('文本模型') }, ...externalAgents.map((provider) => ({ value: provider.id, label: provider.name, disabled: !provider.available })),
                        ...(executor?.kind === 'external-agent' && !external ? [{ value: executor.providerId, label: t('Codex 执行器不可用'), disabled: true }] : [])]}
                      onChange={(selectedExecutor) => setDraft((current) => {
                        const target: TeamExecutionTarget = selectedExecutor === 'text-model' ? { kind: 'text-model', modelId: current.roles[role] ?? '' }
                          : { kind: 'external-agent', providerId: 'codex-app-server', modelId: '' };
                        return { ...current, roleExecutors: { ...current.roleExecutors, [role]: target } };
                      })} />
                    <div className="min-w-0 flex-1">
                      {executor?.kind === 'external-agent' ? <Select size="sm" className="w-full min-w-0" aria-label={t('{role}的外部模型', { role: t(TEAM_ROLE_LABELS[role]) })}
                        value={executor.modelId} disabled={saving || !external?.available} placeholder={t('选择外部模型')}
                        options={[{ value: '', label: t('选择外部模型'), disabled: true }, ...(external?.models ?? []).map((model) => ({ value: model.id, label: model.name })),
                          ...(executor.modelId && !external?.models.some((model) => model.id === executor.modelId) ? [{ value: executor.modelId, label: executor.modelId, disabled: true }] : [])]}
                        onChange={(modelId) => setDraft((current) => ({ ...current, roleExecutors: { ...current.roleExecutors, [role]: { kind: 'external-agent', providerId: 'codex-app-server', modelId } } }))} />
                        : <ModelSelector size="sm" nodeType="ai-text" persistPreference={false} theme={theme} selectedModel={isGeneral ? `general/${selected}` : selected}
                        configuredGroupsOverride={modelGroups} generalModelsOverride={modelGroups ? [] : generalModels}
                        groupAvailability={groupAvailability} disabled={saving}
                        onSelect={(model) => setDraft((current) => ({ ...current, roles: { ...current.roles, [role]: model.value }, roleExecutors: { ...current.roleExecutors, [role]: { kind: 'text-model', modelId: model.value } } }))} />}
                    </div>
                  </div>
                  <p className="ui-hint mt-1">{t(TEAM_ROLE_DESCRIPTIONS[role])}</p>
                </div>
              );
            })}
          </div>
          <TeamGraphEditor value={draft.graph ?? createTemplateTeamGraph(templateId)} onChange={(graph) => setDraft((current) => ({ ...current, graph }))} disabled={saving} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {([
              ['maxCalls', '最多模型调用', 4, 12, 1],
              ['maxTotalTokens', 'Token 预算', 20000, 1000000, 1000],
              ['maxOutputChars', '单次输出字符上限', 2000, 64000, 1000],
            ] as const).map(([key, label, min, max, step]) => (
              <div key={key} className="ui-field">
                <label className="ui-label" htmlFor={`${templateInputId}-${key}`}>{t(label)}</label>
                <NumberStepper id={`${templateInputId}-${key}`} size="sm" className="w-full" aria-label={t(label)}
                  min={min} max={max} step={step} value={draft[key]} disabled={saving}
                  onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))} />
              </div>
            ))}
          </div>
          <p className="text-canvas-text-muted">{t('预算用于限制任务；实际费用以模型服务商账单为准，未知用量不会记为零。')}</p>
          {error && <p role="alert" className="break-words text-danger-light">{error}</p>}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-canvas-border p-3">
          <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={saving} onClick={() => setOpen(false)}>{t('取消')}</button>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={saving} onClick={() => { void save(); }}>{saving ? t('保存中…') : t('保存团队配置')}</button>
        </footer>
      </ModalOverlay>
    </div>
  );
}

export default memo(TeamExecutionPicker);
