/**
 * SharedProjectBindingDialog — 提供共享项目绑定界面与交互。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import { projectMemoryOwnerId } from '../../store/store.utils';
import { isTauriEnv } from '../../services/fs/core';
import { getSharedProjectPrefix, parseSharedProjectCode, sharedStorageErrorMessage } from '../../services/fs/sharedAssetStorage';
import { confirmAction } from '../../services/confirmDialog';
import { formatSize } from '../../utils/assetFormat';
import type { SharedProjectResetMode, SharedProjectResetPreview, SharedStorageCapabilityReport, SharedStorageCheckKind } from '../../types/assetSync';
import ModalOverlay from '../shared/ModalOverlay';
import Select from '../shared/Select';
import PopupCloseButton from '../shared/PopupCloseButton';
import SharedProjectSyncPanel from './SharedProjectSyncPanel';

interface SharedProjectBindingDialogProps {
  localOwnerId: string;
  ownerName: string;
  autoPreview?: boolean;
  onClose: () => void;
}

const CHECK_LABELS: Record<SharedStorageCheckKind, string> = {
  list: '项目范围列表', readWrite: '临时对象读写', multipart: '分片上传',
  conditionalCreate: '条件创建防覆盖', conditionalUpdate: '条件更新与并发竞争',
};

function currentOwnerId(): string | null {
  const state = useAppStore.getState();
  return state.projectInitialized && state.projectLoadStatus === 'ready' && state.currentProjectId
    && state.projects.some((project) => project.id === state.currentProjectId)
    ? projectMemoryOwnerId(state.projects, state.currentProjectId) : null;
}

/** 绑定、校验与显式同步始终作用于当前项目所属 owner。 */
export default function SharedProjectBindingDialog({ localOwnerId, ownerName, autoPreview, onClose }: SharedProjectBindingDialogProps) {
  const t = useT();
  const snapshot = useAppStore((state) => state.sharedAssetStorage);
  const loading = useAppStore((state) => state.sharedAssetStorageLoading);
  const syncStage = useAppStore((state) => state.sharedAssetSyncStatus[localOwnerId]?.stage);
  const syncBusy = syncStage === 'scanning' || syncStage === 'syncing' || syncStage === 'preview';
  const resetStatus = useAppStore((state) => state.sharedProjectResetStatus[localOwnerId]);
  const resetStage = resetStatus?.stage ?? 'idle';
  const activeOwner = useAppStore((state) => state.projectInitialized && state.projectLoadStatus === 'ready' && state.currentProjectId
    && state.projects.some((project) => project.id === state.currentProjectId)
    ? projectMemoryOwnerId(state.projects, state.currentProjectId) : null);
  const [chosenConnectionId, setChosenConnectionId] = useState<string>();
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [joinCode, setJoinCode] = useState('');
  const [createdIds, setCreatedIds] = useState<{ libraryId: string; sharedProjectId: string }>();
  const [pendingKey, setPendingKey] = useState<string>();
  const [canCancel, setCanCancel] = useState(false);
  const [result, setResult] = useState<{ key: string; report: SharedStorageCapabilityReport; bound: boolean }>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [resetPreview, setResetPreview] = useState<{ key: string; value: SharedProjectResetPreview }>();
  const [resetConfirmation, setResetConfirmation] = useState('');
  const [membersReadyToken, setMembersReadyToken] = useState<object>();
  const mounted = useRef(false);
  const runRef = useRef(0);
  const locked = useRef(false);
  const activeTask = useRef<string | null>(null);
  const resetAction = useRef(false);
  const resetCancelRequested = useRef(false);
  const connections = snapshot?.connections ?? [];
  const binding = snapshot?.bindings.find((item) => item.ownerId === localOwnerId);
  const selectedId = binding?.connectionId ?? chosenConnectionId ?? connections[0]?.id ?? '';
  const connection = connections.find((item) => item.id === selectedId);
  const ownerActive = activeOwner === localOwnerId;
  const desktop = isTauriEnv();
  let ids = binding ? { libraryId: binding.libraryId, sharedProjectId: binding.sharedProjectId } : createdIds;
  let codeError = '';
  if (!binding && mode === 'join') {
    try { ids = joinCode.trim() ? parseSharedProjectCode(joinCode) : undefined; }
    catch { ids = undefined; codeError = t('共享码格式应为 libraryId/sharedProjectId，仅支持字母、数字、下划线和短横线。'); }
  }
  let projectPrefix = '';
  if (connection && ids) {
    try { projectPrefix = getSharedProjectPrefix(connection, ids.libraryId, ids.sharedProjectId); }
    catch { codeError = t('云存储参数无效，请检查连接信息和共享项目 ID'); }
  }
  const scopeKey = JSON.stringify([localOwnerId, activeOwner, selectedId, connection?.revision,
    mode, ids?.libraryId, ids?.sharedProjectId, joinCode]);
  const scopeToken = useMemo(() => ({ scopeKey }), [scopeKey]);
  const currentScope = useRef(scopeKey);
  const scopeRevision = useRef(0);
  const membersReady = membersReadyToken === scopeToken;
  const busy = pendingKey === scopeKey;
  const latestResult = result?.key === scopeKey ? result : undefined;
  const bindingCurrent = !!binding && binding.connectionRevision === connection?.revision;
  const report = ownerActive ? latestResult?.report ?? (bindingCurrent ? binding?.capabilities : undefined) : undefined;
  const resetRunning = resetStage === 'previewing' || resetStage === 'applying';
  const resetBlocked = !!binding && resetStage !== 'idle';
  const activeResetPreview = resetPreview?.key === scopeKey ? resetPreview.value : undefined;
  const resetPhrase = ownerName.trim() || binding?.sharedProjectId || '';

  const cancelTask = useCallback(() => {
    runRef.current += 1;
    locked.current = false;
    const taskId = activeTask.current;
    activeTask.current = null;
    if (taskId) void useAppStore.getState().cancelSharedStorageOperation(taskId).catch(() => undefined);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelTask(); };
  }, [cancelTask]);
  useEffect(() => {
    let active = true;
    if (desktop) void useAppStore.getState().loadSharedAssetStorage().catch((cause: unknown) => {
      if (active && mounted.current) setError(t(cause instanceof Error ? cause.message : '项目云同步配置读取失败'));
    });
    return () => { active = false; };
  }, [desktop, t]);
  useEffect(() => {
    currentScope.current = scopeKey;
    return () => {
      scopeRevision.current += 1;
      cancelTask();
      if (useAppStore.getState().sharedProjectResetStatus[localOwnerId]?.stage !== 'idle'
        && useAppStore.getState().sharedProjectResetStatus[localOwnerId]?.stage !== undefined) {
        void useAppStore.getState().cancelSharedProjectResetPreview(localOwnerId).catch(() => undefined);
      }
    };
  }, [cancelTask, localOwnerId, scopeKey]);

  const finishClose = () => { cancelTask(); onClose(); };
  const close = () => {
    if (resetAction.current || resetCancelRequested.current || resetRunning) return;
    if (resetStage === 'preview') { void cancelReset(true); return; }
    finishClose();
  };
  const clearMessages = () => { setError(''); setNotice(''); };
  const previewReset = async (resetMode: SharedProjectResetMode) => {
    if (!binding || !membersReady || resetAction.current || resetBlocked || busy || syncBusy || !desktop || !ownerActive || !bindingCurrent) return;
    const key = scopeKey;
    const revision = scopeRevision.current;
    resetAction.current = true; resetCancelRequested.current = false; clearMessages(); setResetConfirmation('');
    try {
      const value = await useAppStore.getState().previewSharedProjectReset(localOwnerId, resetMode);
      if (mounted.current && !resetCancelRequested.current && currentScope.current === key && scopeRevision.current === revision && currentOwnerId() === localOwnerId) setResetPreview({ key, value });
    } catch (cause) {
      if (mounted.current && !resetCancelRequested.current && currentScope.current === key && scopeRevision.current === revision) setError(t(cause instanceof Error ? cause.message : '项目云存储操作失败'));
    } finally {
      resetAction.current = false;
    }
  };

  const cancelReset = async (closeAfter = false) => {
    if (resetCancelRequested.current) return;
    const key = scopeKey; const revision = scopeRevision.current;
    resetCancelRequested.current = true; clearMessages();
    try {
      await useAppStore.getState().cancelSharedProjectResetPreview(localOwnerId);
      if (!mounted.current || currentScope.current !== key || scopeRevision.current !== revision) return;
      setResetPreview(undefined); setResetConfirmation(''); setMembersReadyToken(undefined);
      if (closeAfter) finishClose();
    } catch (cause) {
      if (mounted.current && currentScope.current === key && scopeRevision.current === revision)
        setError(t(cause instanceof Error ? cause.message : '项目云存储操作失败'));
    } finally { resetCancelRequested.current = false; }
  };

  const applyReset = async () => {
    if (!binding || !activeResetPreview || resetAction.current || resetRunning || syncBusy || !ownerActive || !bindingCurrent
      || !membersReady || !resetPhrase || resetConfirmation !== resetPhrase) return;
    const key = scopeKey;
    const revision = scopeRevision.current;
    const preview = activeResetPreview;
    resetAction.current = true; clearMessages();
    try {
      const result = await useAppStore.getState().applySharedProjectReset(localOwnerId, preview.mode, preview.previewToken);
      if (!mounted.current || currentScope.current !== key || scopeRevision.current !== revision || currentOwnerId() !== localOwnerId) return;
      setResetPreview(undefined); setResetConfirmation(''); setMembersReadyToken(undefined);
      if (result.status === 'completed') setNotice(t(preview.mode === 'clear' ? '云端项目资产已清空，共享标识已保留。' : '云端共享资产库已删除，本机绑定仍保留。'));
      else setError(result.status === 'changed' ? t('云端内容已变化，未执行删除，请重新预览。')
        : `${result.errorCode ? `${t(sharedStorageErrorMessage(result.errorCode))} ` : ''}${t('操作未完成，已确认删除 {done} / {total} 个对象；实际结果请重新预览核对。', { done: result.deletedCount, total: result.totalCount })}`);
    } catch (cause) {
      if (mounted.current && currentScope.current === key && scopeRevision.current === revision) {
        setResetPreview(undefined); setResetConfirmation('');
        setError(`${t(cause instanceof Error ? cause.message : '项目云存储操作失败')} ${t('操作结果可能不完整，请重新预览云端对象。')}`);
      }
    } finally {
      resetAction.current = false;
    }
  };
  const probe = async () => {
    if (locked.current || !desktop || !ownerActive || !connection || !ids || !projectPrefix || codeError) return;
    if (currentOwnerId() !== localOwnerId) return;
    const capturedConnection = connection;
    const key = scopeKey;
    const taskId = crypto.randomUUID();
    const run = ++runRef.current;
    activeTask.current = taskId; locked.current = true;
    setPendingKey(key); setCanCancel(true); clearMessages();
    const isCurrent = () => mounted.current && run === runRef.current && currentOwnerId() === localOwnerId
      && useAppStore.getState().sharedAssetStorage?.connections.find((item) => item.id === capturedConnection.id)?.revision === capturedConnection.revision;
    try {
      const next = binding
        ? await useAppStore.getState().probeSharedProject({ taskId, ownerId: localOwnerId })
        : await useAppStore.getState().bindSharedProject({
          taskId, ownerId: localOwnerId, ownerName, connectionId: capturedConnection.id,
          connectionRevision: capturedConnection.revision, mode, libraryId: ids.libraryId, sharedProjectId: ids.sharedProjectId,
        });
      if (!isCurrent()) return;
      setResult({ key, report: next.report, bound: next.bound });
      setNotice(t(next.bound ? '项目已绑定，可点击立即同步预览资产变更。' : '能力校验未通过，尚未建立共享绑定，也未传输资产。'));
    } catch (cause) {
      if (isCurrent()) setError(t(cause instanceof Error ? cause.message : '项目云存储操作失败'));
    } finally {
      if (run === runRef.current) {
        activeTask.current = null; locked.current = false;
        if (mounted.current) setPendingKey(undefined);
      }
    }
  };

  const unbind = async () => {
    if (!binding || locked.current || !ownerActive) return;
    const target = binding;
    const run = ++runRef.current;
    locked.current = true; setPendingKey(scopeKey); setCanCancel(false); clearMessages();
    try {
      const confirmed = await confirmAction(t('解除此项目的本机共享绑定？不会删除云端或本地资产。'), {
        title: t('解除项目共享绑定'), kind: 'warning', okLabel: t('解除绑定'),
      });
      if (!confirmed || !mounted.current || run !== runRef.current || currentOwnerId() !== localOwnerId) return;
      const live = useAppStore.getState().sharedAssetStorage?.bindings.find((item) => item.ownerId === localOwnerId);
      if (!live || live.connectionRevision !== target.connectionRevision || live.libraryId !== target.libraryId
        || live.sharedProjectId !== target.sharedProjectId) throw new Error(t('连接或项目绑定已改变，请刷新后重试'));
      await useAppStore.getState().unbindSharedProject(localOwnerId, target.connectionRevision);
      if (!mounted.current || run !== runRef.current || currentOwnerId() !== localOwnerId) return;
      setResult(undefined); setChosenConnectionId(target.connectionId);
      setNotice(t('已解除本机共享绑定；本地和云端资产保留。'));
    } catch (cause) {
      if (mounted.current && run === runRef.current && currentOwnerId() === localOwnerId) setError(t(cause instanceof Error ? cause.message : '项目云存储操作失败'));
    } finally {
      if (run === runRef.current) {
        locked.current = false;
        if (mounted.current) setPendingKey(undefined);
      }
    }
  };

  return <ModalOverlay isOpen onClose={close} ariaLabel={t('项目共享设置')} zIndex={320}
    closeOnBackdrop={false} className="mx-3 w-full max-w-2xl max-h-[85vh] ui-dialog-surface">
    <header className="ui-card__header shrink-0">
      <div className="min-w-0 flex-1"><h3 className="ui-card__title">{t('项目共享设置')}</h3>
        <p className="ui-card__desc break-words">{ownerName}</p></div>
      <div className="ui-card__header-actions shrink-0 self-start"><PopupCloseButton onClick={close} disabled={resetRunning} /></div>
    </header>
    <div className="ui-card__body min-h-0 flex-1 space-y-3 overflow-y-auto">
      <p className="ui-alert ui-alert--info">{t('连接校验通过后，可预览并手动同步项目资产。')}</p>
      {!desktop && <p className="ui-alert ui-alert--warning">{t('项目云同步仅支持 Tauri 桌面应用')}</p>}
      {!ownerActive && <p role="alert" className="ui-alert ui-alert--warning">{t('当前项目已变化，请重新打开项目共享设置。')}</p>}
      {!connections.length && !loading && <div className="ui-alert ui-alert--warning flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">{t('请先在设置的存储页保存一个 S3 连接。')}</span>
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => { close(); useAppStore.getState().setSettingsOpen(true, 'storage'); }}>{t('打开存储设置')}</button>
      </div>}
      <fieldset disabled={busy || syncBusy || resetBlocked || loading || !desktop || !ownerActive} className="min-w-0 space-y-3">
        <label className="ui-field"><span className="ui-label">{t('S3 连接')}</span>
          <Select value={selectedId} disabled={!!binding || busy || loading || !ownerActive || !desktop}
            onChange={(value) => { cancelTask(); setChosenConnectionId(value); clearMessages(); }} aria-label={t('S3 连接')} className="w-full"
            options={connections.map((item) => ({ value: item.id, label: item.name }))} />
        </label>
        {connection && <p className="ui-hint break-all">{connection.endpoint} · {connection.bucket}</p>}
        {!binding && <>
          <div className="ui-segmented" aria-label={t('共享项目操作')}>
            <button type="button" className={`ui-segmented__item${mode === 'create' ? ' is-active' : ''}`} aria-pressed={mode === 'create'} onClick={() => { setMode('create'); clearMessages(); }}>{t('创建共享项目')}</button>
            <button type="button" className={`ui-segmented__item${mode === 'join' ? ' is-active' : ''}`} aria-pressed={mode === 'join'} onClick={() => { setMode('join'); clearMessages(); }}>{t('加入共享项目')}</button>
          </div>
          {mode === 'join' ? <label className="ui-field"><span className="ui-label">{t('共享码')}</span>
            <input className="ui-input font-mono" maxLength={257} autoComplete="off" placeholder="libraryId/sharedProjectId" value={joinCode} onChange={(event) => { setJoinCode(event.target.value); clearMessages(); }} />
          </label> : <div className="space-y-2">
            <p className="ui-hint">{t('先生成独立共享标识，再仅在该项目范围内探测。生成标识不会上传资产。')}</p>
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => { setCreatedIds({ libraryId: crypto.randomUUID(), sharedProjectId: crypto.randomUUID() }); clearMessages(); }}>{t(createdIds ? '重新生成共享标识' : '生成共享标识')}</button>
          </div>}
        </>}
        {ids && <label className="ui-field"><span className="ui-label">{t('共享码')}</span><input className="ui-input font-mono" readOnly value={`${ids.libraryId}/${ids.sharedProjectId}`} onFocus={(event) => event.currentTarget.select()} />
          <span className="ui-hint">{t('可向成员提供此共享码；每位成员仍需配置自己的连接与凭据。')}</span></label>}
        {projectPrefix && <div className="ui-field"><span className="ui-label">{t('项目专属前缀')}</span><code className="break-all rounded-md bg-canvas-bg p-2 text-xs text-canvas-text-secondary">{projectPrefix}</code>
          <p className="ui-hint">{t('能力探测只在此项目前缀下创建临时测试对象，不扫描其他项目。')}</p></div>}
        {codeError && <p role="alert" className="ui-error">{codeError}</p>}
        {connection && !connection.credentialsSaved && <p className="ui-alert ui-alert--warning">{t('请先保存云存储访问凭据')}</p>}
        {binding && !bindingCurrent && <p className="ui-alert ui-alert--warning">{t('连接配置已更改，旧能力结果已失效，请解除本机绑定后重新绑定。')}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={!connection?.credentialsSaved || !ids || !projectPrefix || !!codeError || (!!binding && !bindingCurrent)} onClick={() => void probe()}>
            <ShieldCheck size={14} aria-hidden="true" />{t(binding ? '重新校验能力' : '绑定并校验能力')}
          </button>
          {binding && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => void unbind()}>{t('解除绑定')}</button>}
        </div>
      </fieldset>
      {busy && <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-canvas-text-secondary"><span className="ui-spinner" />{t('正在处理项目绑定与能力校验…')}
        {canCancel && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => { cancelTask(); setPendingKey(undefined); setNotice(t('已请求取消，迟到结果不会显示为当前项目的校验结果。')); }}>{t('取消探测')}</button>}
      </div>}
      {report && <section className="space-y-2" aria-label={t('存储能力校验结果')}>
        <div className="flex flex-wrap items-center gap-2"><span className={`ui-badge ${report.multiplayerWritable ? 'ui-badge--success' : 'ui-badge--warning'}`}>{t(report.multiplayerWritable ? '能力校验通过' : '能力校验未通过')}</span></div>
        <ul className="ui-list">{report.checks.map((check) => <li key={check.kind} className="ui-list__item flex flex-wrap items-start justify-between gap-2 p-2 text-xs">
          <span>{t(CHECK_LABELS[check.kind])}</span><span className="text-canvas-text-secondary">{t(check.status === 'passed' ? '通过' : check.status === 'failed' ? '未通过' : '未检查')}</span>
          {check.code && <p className="w-full text-canvas-text-muted">{t(sharedStorageErrorMessage(check.code))}</p>}
        </li>)}</ul>
        {report.cleanupPending && <p role="status" className="ui-alert ui-alert--warning">{t('探测已结束，部分测试对象未清理，请检查存储权限')}</p>}
      </section>}
      {binding && <SharedProjectSyncPanel ownerId={localOwnerId}
        enabled={desktop && ownerActive && bindingCurrent && !!report?.multiplayerWritable && !busy && !resetBlocked} autoPreview={autoPreview} />}
      {binding && <section className="ui-card" aria-label={t('共享资产库管理')}>
        <header className="ui-card__header"><div className="min-w-0 flex-1">
          <h4 className="ui-card__title">{t('共享资产库管理')}</h4>
          <p className="ui-card__desc">{t('这些操作影响所有共享成员，不删除各成员电脑中的本地资产。')}</p>
        </div></header>
        <div className="ui-card__body space-y-3">
          <p className="ui-hint">{t('请确认其他成员已暂停同步，再进行云端删除。')}</p>
          <label className="flex items-start gap-2 text-xs text-canvas-text-secondary">
            <input type="checkbox" checked={membersReady} disabled={resetRunning}
              onChange={(event) => setMembersReadyToken(event.target.checked ? scopeToken : undefined)} />
            {t('我已确认其他成员已暂停同步。')}
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!membersReady || busy || syncBusy || resetBlocked || !desktop || !ownerActive || !bindingCurrent}
              onClick={() => void previewReset('clear')}>{t('清空共享资产库')}</button>
            <button type="button" className="ui-btn ui-btn--danger ui-btn--sm" disabled={!membersReady || busy || syncBusy || resetBlocked || !desktop || !ownerActive || !bindingCurrent}
              onClick={() => void previewReset('delete')}>{t('删除共享资产库')}</button>
          </div>
          {resetRunning && <div role="status" className="flex items-center gap-2 text-xs text-canvas-text-secondary">
            <span className="ui-spinner" aria-hidden="true" />{t(resetStage === 'applying' ? '正在删除云端对象…' : '正在预览云端对象…')}
            {resetStage === 'applying' && resetStatus?.progress && <span>{t('已确认删除 {done} / {total} 个对象', { done: resetStatus.progress.deletedCount, total: resetStatus.progress.totalCount })}</span>}
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => void cancelReset()}>{t('取消')}</button>
          </div>}
          {activeResetPreview && resetStage === 'preview' && <div className="space-y-2" role="region" aria-label={t('共享资产库操作确认')}>
            <p className="ui-alert ui-alert--warning">{t(activeResetPreview.mode === 'clear'
              ? '将删除当前项目的云端对象，保留共享标识；本地资产不变，后续手动同步可能重新上传。'
              : '将删除当前项目的云端对象和共享标识；本地绑定和资产不变。')}</p>
            <p className="ui-hint">{t('预览时快照：{objects} 个云对象，约 {size}。', {
              objects: activeResetPreview.objectCount, size: formatSize(activeResetPreview.bytes),
            })}</p>
            <p className="ui-hint">{t('此操作不可撤销，请先备份需要保留的数据。若存储桶启用了版本管理，历史版本可能仍然保留。')}</p>
            <label className="ui-field"><span className="ui-label">{t('输入“{phrase}”以确认', { phrase: resetPhrase })}</span>
              <input className="ui-input" autoComplete="off" value={resetConfirmation} disabled={resetRunning}
                onChange={(event) => setResetConfirmation(event.target.value)} />
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="ui-btn ui-btn--danger ui-btn--sm" disabled={!membersReady || resetRunning || !resetPhrase || resetConfirmation !== resetPhrase}
                onClick={() => void applyReset()}>{t(activeResetPreview.mode === 'clear' ? '确认清空共享资产库' : '确认删除共享资产库')}</button>
              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={resetRunning}
                onClick={() => void cancelReset()}>{t('取消')}</button>
            </div>
          </div>}
        </div>
      </section>}
      {error && <p role="alert" className="ui-alert ui-alert--danger">{error}</p>}
      {notice && <p role="status" className="ui-alert ui-alert--info">{notice}</p>}
    </div>
    <footer className="ui-card__footer shrink-0 flex-wrap"><p className="ui-hint min-w-0 flex-1">{t('仅同步项目资产；自动同步与删除传播尚未启用。')}</p><button type="button" className="ui-btn ui-btn--ghost ui-btn--sm ml-auto" onClick={close} disabled={resetRunning}>{t('关闭')}</button></footer>
  </ModalOverlay>;
}
