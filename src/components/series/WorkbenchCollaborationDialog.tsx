/** 工作台协作设置共用主窗口动作，展示入口不改变当前执行方式。 */
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { AgentMode } from '../../types/agent';
import type { CreationProfileChoicePreview } from '../../types/creationProfile';
import type { ScriptWorkbenchAction, ScriptWorkbenchDispatch, ScriptWorkbenchSnapshot } from '../../types/scriptWorkbench';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import Select from '../shared/Select';
import CreationProfilePicker from '../shared/creationProfiles/CreationProfilePicker';
import TeamExecutionPicker from '../shared/agentTeams/TeamExecutionPicker';

export default function WorkbenchCollaborationDialog({ snapshot, dispatch, onClose }: {
  snapshot: ScriptWorkbenchSnapshot; dispatch: ScriptWorkbenchDispatch; onClose: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const { currentEpisode, executionSelection, teamProfile, teamMode, contextReady, isSaving, isStartingTeam, editorWriteLocked } = snapshot;
  const disabled = busy || !currentEpisode || !contextReady || isSaving || isStartingTeam || editorWriteLocked;
  const close = () => { if (!inFlight.current) onClose(); };
  const run = async (action: ScriptWorkbenchAction) => {
    if (!mounted.current) throw new Error(t('协作设置已关闭，请重新打开'));
    if (inFlight.current) throw new Error(t('配置正在更新，请稍候'));
    inFlight.current = true;
    setBusy(true); setError('');
    try {
      const result = await dispatch(action);
      if (!mounted.current) throw new Error(t('协作设置已关闭，请重新打开'));
      return result;
    }
    catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : t('工作台操作未完成'));
      throw reason;
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const change = (action: ScriptWorkbenchAction) => { void run(action).catch(() => {}); };

  return <ModalOverlay isOpen onClose={close} ariaLabel={t('Agent协作')}
    zIndex={280} className="ui-dialog-surface mx-3 max-h-[85vh] w-full max-w-xl text-canvas-text">
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-canvas-border p-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{t('Agent协作')}</h2>
        <p className="truncate text-xs text-canvas-text-secondary">{currentEpisode?.name}</p>
      </div>
      <PopupCloseButton onClick={close} disabled={busy} />
    </header>
    <div className="min-h-0 space-y-3 overflow-y-auto p-3">
      <p className="ui-hint">{t('用于本集大纲、剧本与创作要点。设置后，点击右侧创作动作开始。')}</p>
      {error && <p role="alert" className="ui-alert ui-alert--danger">{error}</p>}
      <section className="ui-card space-y-2 p-3">
        <h3 className="ui-label">{t('创作组合包')}</h3>
        <CreationProfilePicker profiles={snapshot.creationProfiles ?? []} selection={currentEpisode?.creationProfile}
          projectId={currentEpisode?.id ?? ''} disabled={disabled}
          onPreview={async (profile) => await run({ type: 'preview_creation_profile', profile }) as CreationProfileChoicePreview}
          onChange={async (selection) => { await run({ type: 'apply_creation_profile', selection: selection ?? null }); }} />
      </section>
      <section className="ui-card space-y-3 p-3">
        <h3 className="ui-label">{t('创作执行方式')}</h3>
        <TeamExecutionPicker value={executionSelection} onChange={(value) => change({ type: 'set_execution', value })}
          profile={teamProfile} onProfileChange={async (profile) => { await run({ type: 'save_team_profile', profile }); }}
          modelGroups={snapshot.modelGroups} externalAgents={snapshot.externalAgents ?? []}
          onRefreshExternalAgents={async () => { await run({ type: 'refresh_external_agents' }); }}
          theme={snapshot.theme} disabled={disabled} defaultTemplateId={snapshot.activeTab === 'outline' ? 'outline' : 'script'} />
        {executionSelection.kind === 'single'
          ? <p className="ui-hint">{t('点击创作动作后自动选用已授权的智能体与 Skill，调用与草案可在助手查看，不会覆盖正文。')}</p>
          : <p className="ui-hint">{t('先保存当前改稿，再由团队生成候选；设置完成后，从右侧创作动作开始。')}</p>}
        <div className="flex items-center justify-between gap-2">
          <span className="ui-label">{t('任务权限')}</span>
          <Select<AgentMode> aria-label={t('任务权限')} value={teamMode} disabled={disabled}
            onChange={(value) => change({ type: 'set_team_mode', value })}
            options={[{ value: 'plan', label: t('规划') }, { value: 'collaborative', label: t('协作') }, { value: 'autonomous', label: t('自主') }]} />
        </div>
        <p className="ui-hint">{t(currentEpisode?.creationProfile ? '团队配置仅用于本集的组合包覆盖。' : '团队配置保存为默认团队，可供其他分集使用。')}</p>
      </section>
      {snapshot.unsettledEditor && <section className="ui-alert ui-alert--warning space-y-2" role="status">
        <p>{t('上次编辑未确认结束，请核对当前已保存稿件后再应用团队成果。')}</p>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={disabled || snapshot.isDirty}
          onClick={() => change({ type: 'settle_editor' })}>{t('已核对当前稿件')}</button>
      </section>}
    </div>
    <footer className="flex shrink-0 justify-end border-t border-canvas-border p-3">
      <button type="button" className="ui-btn ui-btn--primary" disabled={busy} onClick={close}>{busy ? t('处理中…') : t('完成')}</button>
    </footer>
  </ModalOverlay>;
}
