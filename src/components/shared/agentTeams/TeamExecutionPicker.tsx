import { memo, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import type { GeneralModelConfig, ModelGroup } from '../../../types';
import type { AgentTeamProfile, AssistantExecutionSelection, TeamRoleId, TeamTemplateId } from '../../../types/agentTeam';
import { TEAM_ROLE_LABELS, TEAM_TEMPLATE_LABELS } from '../../../services/chat/teams/teamProfileService';
import { useT } from '../../../i18n';
import ModelSelector from '../../nodes/shared/ModelSelector';
import ModalOverlay from '../ModalOverlay';

export interface TeamExecutionPickerProps {
  value: AssistantExecutionSelection;
  onChange: (selection: AssistantExecutionSelection) => void;
  profile: AgentTeamProfile;
  onProfileChange: (profile: AgentTeamProfile) => void | Promise<void>;
  modelGroups?: ModelGroup[];
  generalModels?: GeneralModelConfig[];
  groupAvailability?: Record<string, boolean>;
  theme?: 'dark' | 'light';
  disabled?: boolean;
  compact?: boolean;
  defaultTemplateId?: TeamTemplateId;
}

const ROLES: readonly TeamRoleId[] = ['architect', 'writer', 'continuity', 'dialogue', 'editor'];
const TEMPLATES: readonly TeamTemplateId[] = ['general', 'outline', 'script', 'review'];

function TeamExecutionPicker({
  value, onChange, profile, onProfileChange, modelGroups, generalModels, groupAvailability,
  theme, disabled = false, compact = false, defaultTemplateId = 'general',
}: TeamExecutionPickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(profile);
  const [templateId, setTemplateId] = useState<TeamTemplateId>(value.kind === 'team' ? value.templateId : defaultTemplateId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const configuredCount = useMemo(() => ROLES.filter((role) => profile.roles[role]?.trim()).length, [profile.roles]);

  const openConfiguration = () => {
    setDraft({ ...profile, roles: { ...profile.roles } });
    setTemplateId(value.kind === 'team' ? value.templateId : defaultTemplateId);
    setError('');
    setOpen(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      if (!Number.isSafeInteger(draft.maxCalls) || draft.maxCalls < 4 || draft.maxCalls > 12
        || !Number.isSafeInteger(draft.maxTotalTokens) || draft.maxTotalTokens < 20000 || draft.maxTotalTokens > 1000000
        || !Number.isSafeInteger(draft.maxOutputChars) || draft.maxOutputChars < 2000 || draft.maxOutputChars > 64000) {
        throw new Error(t('团队预算数值超出允许范围'));
      }
      await onProfileChange(draft);
      onChange({ kind: 'team', templateId });
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('保存团队配置失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`flex min-w-0 items-center gap-1 ${compact ? '' : 'flex-wrap'}`}>
      <div className="ui-btn-group shrink-0" role="group" aria-label={t('执行方式')}>
        <button type="button" className={`ui-btn ui-btn--sm ui-btn--ghost ${value.kind === 'single' ? 'is-active' : ''}`}
          disabled={disabled} aria-pressed={value.kind === 'single'} onClick={() => onChange({ kind: 'single' })}>
          {t('单模型')}
        </button>
        <button type="button" className={`ui-btn ui-btn--sm ui-btn--ghost ${value.kind === 'team' ? 'is-active' : ''}`}
          disabled={disabled} aria-pressed={value.kind === 'team'} onClick={() => {
            onChange({ kind: 'team', templateId: value.kind === 'team' ? value.templateId : defaultTemplateId });
            if (configuredCount === 0) openConfiguration();
          }}>
          {t('团队')}
        </button>
      </div>
      {value.kind === 'team' && (
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
          <label className="block space-y-1">
            <span className="ui-label">{t('团队模板')}</span>
            <select className="ui-select__control w-full" value={templateId} disabled={saving} onChange={(event) => setTemplateId(event.target.value as TeamTemplateId)}>
              {TEMPLATES.map((id) => <option key={id} value={id}>{t(TEAM_TEMPLATE_LABELS[id])}</option>)}
            </select>
          </label>
          <p className="text-canvas-text-muted">{t('每个角色可选择不同模型；团队执行方式不会改变规划、协作或自主权限。')}</p>
          <div className="space-y-2">
            {ROLES.map((role) => {
              const selected = draft.roles[role];
              const isGeneral = generalModels?.some((model) => model.id === selected && model.category === 'text');
              return (
                <div key={role} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-canvas-border bg-canvas-card p-2">
                  <span className="shrink-0 text-xs font-medium">{t(TEAM_ROLE_LABELS[role])}</span>
                  <div className="min-w-0 max-w-full" aria-label={t('{role}的模型', { role: t(TEAM_ROLE_LABELS[role]) })}>
                    <ModelSelector nodeType="ai-text" persistPreference={false} theme={theme} selectedModel={isGeneral ? `general/${selected}` : selected}
                      configuredGroupsOverride={modelGroups} generalModelsOverride={modelGroups ? [] : generalModels}
                      groupAvailability={groupAvailability} disabled={saving}
                      onSelect={(model) => setDraft((current) => ({ ...current, roles: { ...current.roles, [role]: model.value } }))} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {([
              ['maxCalls', '最多模型调用', 4, 12, 1],
              ['maxTotalTokens', 'Token 预算', 20000, 1000000, 1000],
              ['maxOutputChars', '单次输出字符上限', 2000, 64000, 1000],
            ] as const).map(([key, label, min, max, step]) => (
              <label key={key} className="block space-y-1"><span className="ui-label">{t(label)}</span>
                <input type="number" className="ui-input w-full" min={min} max={max} step={step} value={draft[key]} disabled={saving}
                  onChange={(event) => setDraft((current) => ({ ...current, [key]: Number(event.target.value) }))} />
              </label>
            ))}
          </div>
          <p className="text-canvas-text-muted">{t('预算用于限制任务；实际费用以模型服务商账单为准，未知用量不会记为零。')}</p>
          {error && <p role="alert" className="break-words text-danger-light">{error}</p>}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-canvas-border p-3">
          <button type="button" className="ui-btn ui-btn--ghost" disabled={saving} onClick={() => setOpen(false)}>{t('取消')}</button>
          <button type="button" className="ui-btn ui-btn--primary" disabled={saving} onClick={() => { void save(); }}>{saving ? t('保存中…') : t('保存团队配置')}</button>
        </footer>
      </ModalOverlay>
    </div>
  );
}

export default memo(TeamExecutionPicker);
