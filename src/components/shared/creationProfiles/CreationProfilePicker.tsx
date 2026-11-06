import { useRef, useState } from 'react';
import type { CreationProfileOption, CreationProfileChoicePreview, CreationProfileSelection } from '../../../types/creationProfile';
import { previewCreationProfileOption } from '../../../services/creationProfiles/creationProfileService';
import { useT } from '../../../i18n';
import Select from '../Select';
import ModalOverlay from '../ModalOverlay';

export interface CreationProfilePickerProps {
  profiles: CreationProfileOption[];
  selection?: CreationProfileSelection;
  projectId: string;
  disabled?: boolean;
  onChange: (selection: CreationProfileSelection | undefined) => Promise<void>;
  /** 独立窗口必须交给主窗口预检，不自行访问原生能力或安装目录。 */
  onPreview?: (profile: CreationProfileOption) => Promise<CreationProfileChoicePreview>;
}

export default function CreationProfilePicker({ profiles, selection, projectId, disabled, onChange, onPreview }: CreationProfilePickerProps) {
  const t = useT();
  const [candidate, setCandidate] = useState<{ preview: CreationProfileChoicePreview; projectId: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const choose = async (id: string) => {
    const ticket = ++request.current;
    setBusy(true); setError('');
    try {
      if (!id) { await onChange(undefined); setCandidate(undefined); return; }
      const profile = profiles.find((entry) => entry.id === id);
      if (!profile) throw new Error(t('组合包已失效，请重新选择'));
      const preview = await (onPreview ? onPreview(profile) : previewCreationProfileOption(profile, projectId));
      if (request.current === ticket) setCandidate({ preview, projectId });
    } catch (reason) { if (request.current === ticket) setError(reason instanceof Error ? reason.message : t('组合包预检失败')); }
    finally { if (request.current === ticket) setBusy(false); }
  };
  const apply = async () => {
    if (!candidate || candidate.projectId !== projectId || candidate.preview.issues.length || busy) return;
    setBusy(true); setError('');
    try { await onChange(candidate.preview.selection); setCandidate(undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('应用组合包失败')); }
    finally { setBusy(false); }
  };
  const missing = !!selection && !profiles.some((entry) => entry.id === selection.id && entry.version === selection.version);
  return <div className="min-w-0 max-w-full">
    <Select size="sm" className="max-w-full" aria-label={t('创作组合包')} value={selection?.id ?? ''}
      disabled={disabled || busy} onChange={(id) => { void choose(id); }} options={[
        { value: '', label: t('不使用组合包') },
        ...(missing ? [{ value: selection!.id, label: t('组合包已失效，请重新选择'), disabled: true }] : []),
        ...profiles.map((entry) => ({ value: entry.id, label: `${entry.name} · ${entry.version}` })),
      ]} />
    {error && !candidate && <p role="alert" className="ui-alert ui-alert--danger mt-1">{t(error)}</p>}
    <ModalOverlay isOpen={!!candidate} onClose={() => { if (!busy) setCandidate(undefined); }} ariaLabel={t('应用创作组合包')}
      className="mx-2 w-full max-w-lg" zIndex={340}>
      <header className="flex items-center justify-between gap-2 border-b border-canvas-border p-3">
        <h2 className="truncate text-sm font-semibold">{t('应用创作组合包')}</h2>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={() => setCandidate(undefined)} aria-label={t('关闭')}>×</button>
      </header>
      {candidate && <div className="space-y-3 p-3 text-xs">
        <p className="break-words font-medium">{candidate.preview.profile.name} · {candidate.preview.profile.version}</p>
        <ul className="list-disc space-y-1 pl-4">{candidate.preview.changes.map((change) => <li key={change.message}>{t(change.message, { name: change.name ?? '', count: change.count ?? 0 })}</li>)}</ul>
        <p className="ui-hint">{t('仅应用配置引用；缺少的插件、Skill 或模型需要单独配置。')}</p>
        {candidate.preview.issues.length > 0 && <div role="alert" className="ui-alert ui-alert--warning"><ul className="space-y-1">{candidate.preview.issues.map((issue) => <li key={`${issue.message}:${issue.name ?? ''}`} className="break-words">{t(issue.message, { name: issue.name ?? '', count: issue.count ?? 0 })}</li>)}</ul></div>}
        {candidate.projectId !== projectId && <p role="alert" className="ui-alert ui-alert--warning">{t('项目或分集已变化，请重新选择组合包')}</p>}
        {error && <p role="alert" className="ui-alert ui-alert--danger">{t(error)}</p>}
      </div>}
      <footer className="flex justify-end gap-2 border-t border-canvas-border p-3">
        <button type="button" className="ui-btn ui-btn--ghost" disabled={busy} onClick={() => setCandidate(undefined)}>{t('取消')}</button>
        <button type="button" className="ui-btn ui-btn--primary" disabled={busy || !candidate || !!candidate.preview.issues.length || candidate.projectId !== projectId} onClick={() => { void apply(); }}>{t('应用组合包')}</button>
      </footer>
    </ModalOverlay>
  </div>;
}
