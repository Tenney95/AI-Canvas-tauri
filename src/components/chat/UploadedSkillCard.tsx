/** 智能体中心中的手动上传 Skill；显示名与托管来源的安全删除。 */
import { useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import type { UserSkill } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { confirmAction } from '../../services/confirmDialog';

export default function UploadedSkillCard({ skill, allowEdit }: { skill: UserSkill; allowEdit: boolean }) {
  const t = useT();
  const renameSkill = useAppStore((state) => state.renameSkill);
  const deleteSkill = useAppStore((state) => state.deleteSkill);
  const showToast = useAppStore((state) => state.showToast);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(skill.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const renameButton = useRef<HTMLButtonElement>(null);

  const closeEditor = () => {
    setEditing(false);
    setError('');
    requestAnimationFrame(() => renameButton.current?.focus());
  };

  const saveName = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await renameSkill(skill.id, name);
      closeEditor();
      showToast(t('Skill 名称已更新'));
    } catch {
      setError(t('Skill 重命名失败，请重试'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (!(await confirmAction(t('确定删除 Skill「{name}」？安装目录中的托管副本会一并删除，外部链接文件夹和旧版来源文件保留。', { name: skill.name }), { title: t('删除 Skill') }))) return;
      await deleteSkill(skill.id);
      showToast(t('已删除 Skill「{name}」', { name: skill.name }));
    } catch (error) {
      setError(error instanceof Error ? t(error.message) : t('删除 Skill 失败，请重试'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="ui-card p-3" aria-busy={busy}>
      <div className="flex items-start gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-canvas-surface text-brand">
          <Icon icon="lucide:sparkles" width="16" aria-hidden="true" />
        </span>
        <h4 className="min-w-0 flex-1 break-words text-sm font-medium text-canvas-text [overflow-wrap:anywhere]">{skill.name}</h4>
        {allowEdit && !editing && (
          <div className="flex shrink-0 items-center gap-1">
            <button ref={renameButton} type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy}
              aria-label={t('重命名 Skill「{name}」', { name: skill.name })}
              data-tooltip={t('重命名')}
              onClick={() => { setName(skill.name); setError(''); setEditing(true); }}>
              <Icon icon="lucide:pencil" width="14" aria-hidden="true" />
            </button>
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy}
              aria-label={t('删除 {name}', { name: skill.name })}
              data-tooltip={t('删除 Skill')}
              onClick={() => void remove()}>
              <Icon icon="mdi:trash-can-outline" width="14" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      {allowEdit && editing && (
        <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void saveName(); }}>
          <input autoFocus className="ui-input ui-input--sm min-w-0 flex-1" aria-label={t('Skill 名称')}
            value={name} maxLength={120} required disabled={busy} onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) { if (event.key === 'Enter') event.preventDefault(); return; }
              if (event.key === 'Escape') { event.stopPropagation(); if (!busy) closeEditor(); }
            }} />
          <button type="submit" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || !name.trim()}>{t('保存')}</button>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy}
            onClick={closeEditor}>{t('取消')}</button>
        </form>
      )}
      {skill.description && <p className="mt-2 line-clamp-2 break-words text-[11px] leading-4 text-canvas-text-secondary">{skill.description}</p>}
      <p className="mt-1.5 break-all text-[10px] leading-4 text-canvas-text-muted">
        {skill.sourceType === 'folder' ? t('文件夹') : t('文件')}{' · '}{skill.entryFileName || skill.fileName}
      </p>
      {error && <p role="alert" className="ui-alert ui-alert--danger mt-2 p-2 text-xs">{error}</p>}
    </article>
  );
}
