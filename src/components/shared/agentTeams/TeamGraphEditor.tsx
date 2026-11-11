import { useId } from 'react';
import { Icon } from '@iconify/react';
import type { TeamGraphDefinition, TeamGraphNode, TeamRoleId } from '../../../types/agentTeam';
import { TEAM_ROLE_LABELS, TEAM_ROLES } from '../../../services/chat/teams/teamProfileService';
import { ROLE_KINDS, teamGraphAncestors, validateTeamGraph } from '../../../services/chat/teams/teamGraphService';
import { useT } from '../../../i18n';
import Select from '../Select';

const GRAPH_KIND_LABELS: Record<TeamGraphNode['kind'], string> = {
  outline: '结构大纲', draft: '正文起草', review: '独立审阅', decision: '主编裁决', revision: '统一修订',
};

export default function TeamGraphEditor({ value, onChange, disabled = false }: {
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
