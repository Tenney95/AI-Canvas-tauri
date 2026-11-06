import { useId, useState } from 'react';
import type { CreationProfile, CreationProfilePreview } from '../../../types/creationProfile';
import { useAppStore } from '../../../store/useAppStore';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../../services/chat/assistantScope';
import { normalizeTeamProfile } from '../../../services/chat/teams/teamProfileService';
import { parseCreationProfile } from '../../../services/creationProfiles/creationProfileManifest';
import { previewCreationProfile, removeCreationProfile, saveCreationProfile } from '../../../services/creationProfiles/creationProfileService';
import { exportJsonTextFile, readJsonTextFile } from '../../../services/fs/jsonFileTransfer';
import { useT } from '../../../i18n';
import ModalOverlay from '../ModalOverlay';
import Select from '../Select';
import { TEAM_TEMPLATE_LABELS, TEAM_TEMPLATES } from '../../../services/chat/teams/teamProfileService';
import { isSkillUserInvocable } from '../../../services/skillPromptService';

export default function CreationProfileManager({ onClose }: { onClose: () => void }) {
  const t = useT();
  const inputId = useId();
  const profiles = useAppStore((state) => state.config.creationProfiles);
  const plugins = useAppStore((state) => state.installedPlugins);
  const packages = useAppStore((state) => state.agentPackages);
  const userSkills = useAppStore((state) => state.userSkills);
  const packageSkills = useAppStore((state) => state.agentPackageSkills);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<CreationProfile>();
  const [advanced, setAdvanced] = useState(false);
  const [preview, setPreview] = useState<CreationProfilePreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const changeProfile = (profile: CreationProfile) => {
    setEditing(profile); setDraft(JSON.stringify(profile, null, 2)); setPreview(undefined); setNotice('');
  };
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await work(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('组合包操作失败')); }
    finally { setBusy(false); }
  };
  const inspect = async (value: unknown) => {
    const parsed = parseCreationProfile(value);
    const state = useAppStore.getState();
    setEditing(parsed);
    setDraft(JSON.stringify(parsed, null, 2));
    setPreview(await previewCreationProfile(parsed, state.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID));
  };
  const create = () => {
    const profile: CreationProfile = { schemaVersion: 1, id: `creation-${crypto.randomUUID()}`, version: '1.0.0', name: t('我的创作团队'),
      pluginRefs: [], agentPackageRefs: [], skillRefs: [], teamTemplateId: 'general',
      teamProfile: normalizeTeamProfile(useAppStore.getState().config.agentTeamProfile), contextPolicyRef: 'project-default' };
    changeProfile(profile); setAdvanced(false); setError('');
  };
  return <ModalOverlay isOpen onClose={() => { if (!busy) onClose(); }} ariaLabel={t('创作组合包')} className="mx-2 flex max-h-[85vh] w-full max-w-2xl flex-col" zIndex={330}>
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-canvas-border p-3">
      <h2 className="text-sm font-semibold">{t('创作组合包')}</h2>
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={onClose} aria-label={t('关闭')}>×</button>
    </header>
    <div className="min-h-0 space-y-3 overflow-auto p-3 text-xs">
      <p className="ui-hint">{t('组合包只分享能力引用和团队配置，不包含密钥、插件源码或本机路径。')}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ui-btn ui-btn--sm" disabled={busy} onClick={create}>{t('从当前团队创建')}</button>
        <label className="ui-label self-center" htmlFor={inputId}>{t('导入 JSON')}</label>
        <input id={inputId} type="file" accept=".json,application/json" className="ui-input max-w-xs" disabled={busy} onChange={(event) => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
          if (file) void run(async () => { if (file.size > 256 * 1024) throw new Error(t('组合包超过 256 KiB')); await inspect(await readJsonTextFile(file)); });
        }} />
      </div>
      {(profiles ?? []).map((profile) => <article key={profile.id} className="ui-card flex min-w-0 flex-wrap items-center gap-2 p-2">
        <span className="min-w-0 flex-1 break-words">{profile.name} · {profile.version}</span>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={() => { void run(() => inspect(profile)); }}>{t('查看与编辑')}</button>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={() => { void run(async () => { await exportJsonTextFile(JSON.stringify(parseCreationProfile(profile), null, 2), profile.name); }); }}>{t('导出')}</button>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={() => { void run(() => removeCreationProfile(profile.id)); }}>{t('移除')}</button>
      </article>)}
      {draft && <section className="space-y-2">
        <div className="ui-segmented" role="group" aria-label={t('组合包编辑方式')}>
          <button type="button" className={`ui-segmented__item${advanced ? '' : ' is-active'}`} disabled={busy} onClick={() => {
            if (advanced) { try { changeProfile(parseCreationProfile(draft)); setAdvanced(false); setError(''); } catch (reason) { setError(reason instanceof Error ? reason.message : t('组合包操作失败')); } }
          }}>{t('选择创作能力')}</button>
          <button type="button" className={`ui-segmented__item${advanced ? ' is-active' : ''}`} disabled={busy} onClick={() => setAdvanced(true)}>{t('高级 JSON')}</button>
        </div>
        {editing && !advanced && <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="ui-field"><label className="ui-label" htmlFor={`${inputId}-name`}>{t('名称')}</label>
              <input id={`${inputId}-name`} className="ui-input" value={editing.name} maxLength={80} disabled={busy} onChange={(event) => changeProfile({ ...editing, name: event.target.value })} /></div>
            <div className="ui-field"><label className="ui-label" htmlFor={`${inputId}-version`}>{t('版本')}</label>
              <input id={`${inputId}-version`} className="ui-input" value={editing.version} maxLength={40} disabled={busy} onChange={(event) => changeProfile({ ...editing, version: event.target.value })} /></div>
            <div className="ui-field"><label className="ui-label" htmlFor={`${inputId}-context`}>{t('上下文范围')}</label>
              <Select<CreationProfile['contextPolicyRef']> id={`${inputId}-context`} value={editing.contextPolicyRef} disabled={busy} onChange={(contextPolicyRef) => changeProfile({ ...editing, contextPolicyRef })}
                options={[{ value: 'project-default', label: t('沿用项目上下文') }, { value: 'explicit-materials', label: t('上下文仅使用本次明确材料') }]} /></div>
            <div className="ui-field"><label className="ui-label" htmlFor={`${inputId}-template`}>{t('团队模板')}</label>
              <Select id={`${inputId}-template`} value={editing.teamTemplateId ?? ''} disabled={busy} onChange={(template) => changeProfile(template
                ? { ...editing, teamTemplateId: template as NonNullable<CreationProfile['teamTemplateId']>, teamProfile: editing.teamProfile ?? normalizeTeamProfile(useAppStore.getState().config.agentTeamProfile) }
                : { ...editing, teamTemplateId: undefined, teamProfile: undefined })}
                options={[{ value: '', label: t('保留当前执行方式') }, ...TEAM_TEMPLATES.map((value) => ({ value, label: t(TEAM_TEMPLATE_LABELS[value]) }))]} /></div>
          </div>
          <p className="ui-hint">{t('团队模型与任务图沿用创建时配置；应用后可在当前会话或分集单独调整。')}</p>
          <fieldset className="ui-card space-y-2 p-2"><legend className="ui-label">{t('引用已安装插件')}</legend>
            {plugins.map((plugin, index) => {
              const checked = editing.pluginRefs.some((reference) => reference.pluginId === plugin.id);
              return <div key={plugin.id}><input id={`${inputId}-plugin-${index}`} type="checkbox" className="ui-checkbox" checked={checked}
                disabled={busy || (!checked && (!plugin.enabled || !plugin.revisionDigest || editing.pluginRefs.length >= 32))}
                onChange={() => changeProfile({ ...editing, pluginRefs: checked ? editing.pluginRefs.filter((reference) => reference.pluginId !== plugin.id)
                  : [...editing.pluginRefs, { pluginId: plugin.id, revisionDigest: plugin.revisionDigest }] })} />
                <label htmlFor={`${inputId}-plugin-${index}`} className="break-words">{plugin.manifest.name} · {plugin.manifest.version}</label></div>;
            })}
          </fieldset>
          <fieldset className="ui-card space-y-2 p-2"><legend className="ui-label">{t('引用已安装 Agent 包')}</legend>
            {packages.map((installation, index) => {
              const checked = editing.agentPackageRefs.some((reference) => reference.packageId === installation.packageId);
              return <div key={installation.id}><input id={`${inputId}-package-${index}`} type="checkbox" className="ui-checkbox" checked={checked}
                disabled={busy || (!checked && (!installation.enabled || installation.health !== 'ready' || editing.agentPackageRefs.length >= 16))}
                onChange={() => changeProfile({ ...editing, agentPackageRefs: checked ? editing.agentPackageRefs.filter((reference) => reference.packageId !== installation.packageId)
                  : [...editing.agentPackageRefs, { packageId: installation.packageId, contentHash: installation.contentHash }] })} />
                <label htmlFor={`${inputId}-package-${index}`} className="break-words">{installation.manifest.name} · {installation.manifest.version}</label></div>;
            })}
          </fieldset>
          <fieldset className="ui-card space-y-2 p-2"><legend className="ui-label">{t('选择显式 Skill（最多 4 个）')}</legend>
            {[...userSkills, ...packageSkills].map((skill, index) => {
              const checked = editing.skillRefs.some((reference) => reference.skillId === skill.id);
              return <div key={skill.id}><input id={`${inputId}-skill-${index}`} type="checkbox" className="ui-checkbox" checked={checked}
                disabled={busy || (!checked && (editing.skillRefs.length >= 4 || !isSkillUserInvocable(skill)))} onChange={() => changeProfile({ ...editing,
                  skillRefs: checked ? editing.skillRefs.filter((reference) => reference.skillId !== skill.id) : [...editing.skillRefs, { skillId: skill.id }] })} />
                <label htmlFor={`${inputId}-skill-${index}`} className="break-words">{skill.name}</label></div>;
            })}
          </fieldset>
        </div>}
        {advanced && <><label className="ui-label" htmlFor={`${inputId}-draft`}>{t('组合包 JSON')}</label>
          <textarea id={`${inputId}-draft`} className="ui-input min-h-56 w-full resize-y font-mono text-xs" value={draft} disabled={busy}
            onChange={(event) => { setDraft(event.target.value); setPreview(undefined); setNotice(''); }} /></>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="ui-btn ui-btn--sm" disabled={busy} onClick={() => { void run(() => inspect(draft)); }}>{t('预检配置')}</button>
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || !preview} onClick={() => { void run(async () => {
            if (!preview) return;
            await saveCreationProfile(preview.profile); setNotice(t('组合包已保存，应用时会再次检查能力'));
          }); }}>{t('保存到组合包目录')}</button>
        </div>
      </section>}
      {preview && <div className="ui-card space-y-2 p-2">
        <p className="font-medium">{t('预检结果')}</p>
        <ul className="space-y-1">{preview.changes.map((change) => <li key={change.message}>{t(change.message, { name: change.name ?? '', count: change.count ?? 0 })}</li>)}</ul>
        {preview.issues.length > 0 && <div className="ui-alert ui-alert--warning"><ul className="space-y-1">{preview.issues.map((issue) => <li key={`${issue.message}:${issue.name ?? ''}`} className="break-words">{t(issue.message, { name: issue.name ?? '', count: issue.count ?? 0 })}</li>)}</ul></div>}
      </div>}
      {notice && <p role="status" className="ui-alert ui-alert--success">{notice}</p>}
      {error && <p role="alert" className="ui-alert ui-alert--danger">{t(error)}</p>}
    </div>
  </ModalOverlay>;
}
