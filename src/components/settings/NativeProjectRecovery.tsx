/** 按原操作恢复新项目导入、共享同步，或核验已发布的导出回执。 */
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';

type RecoveryKind = 'import' | 'update' | 'update-abort' | 'export' | 'shared' | 'shared-abort' | 'media' | 'media-inspect' | 'media-review' | 'media-list';
type RecoveryStatus = { kind: 'success' | 'warning' | 'error'; text: string };
const validOperationId = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export default function NativeProjectRecovery() {
  const t = useT();
  const [operationId, setOperationId] = useState('');
  const [busy, setBusy] = useState<RecoveryKind | null>(null);
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [reviewableMedia, setReviewableMedia] = useState(false);
  const [reviewableEditor, setReviewableEditor] = useState(false);
  const [mediaRecords, setMediaRecords] = useState<Array<{ operationId: string; nodeId: string; status: string; editor?: boolean }>>([]);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const recover = async (kind: RecoveryKind) => {
    const id = operationId.trim();
    if (running.current) return;
    if (kind !== 'media-list' && !validOperationId.test(id)) {
      setStatus({ kind: 'error', text: t('请输入有效的原操作 ID') });
      return;
    }
    running.current = true;
    setBusy(kind);
    setStatus(null);
    try {
      if (kind === 'import') {
        const { resumeNativeProjectImport } = await import('../../services/nativeProjectImportService');
        const result = await resumeNativeProjectImport(id);
        try {
          await useAppStore.getState().refreshProjectCatalog();
          if (mounted.current) setStatus({ kind: 'success', text: t('导入已完成，可从项目库打开「{name}」', { name: result.projectName }) });
        } catch {
          if (mounted.current) setStatus({ kind: 'warning', text: t('导入已完成，但项目列表刷新失败；请重新启动后从项目库打开') });
        }
      } else if (kind === 'update' || kind === 'update-abort') {
        const { readNativeProjectUpdate, abortNativeProjectUpdate } = await import('../../services/indexedDb/nativeProjectRepository');
        const operation = await readNativeProjectUpdate(id);
        if (!operation) throw new Error(t('未找到原更新操作'));
        const state = useAppStore.getState();
        const current = state.projects.find((project) => project.id === state.currentProjectId) as
          (typeof state.projects[number] & { nativeView?: { projectId: string } }) | undefined;
        if (current?.nativeView?.projectId === operation.projectId) throw new Error(t('请先返回开始页，再继续恢复该项目更新'));
        if (kind === 'update-abort') {
          await abortNativeProjectUpdate(id);
          if (mounted.current) setStatus({ kind: 'warning', text: t('未提交更新已撤销；独立备份、隔离来源和已发布素材均已保留。') });
          return;
        }
        const { resumeNativeProjectUpdate } = await import('../../services/nativeProjectUpdateService');
        await resumeNativeProjectUpdate(id);
        try {
          await useAppStore.getState().refreshProjectCatalog();
          if (mounted.current) setStatus({ kind: 'success', text: t('原更新已继续，请从项目库重新打开作品') });
        } catch {
          if (mounted.current) setStatus({ kind: 'warning', text: t('原更新已完成，但项目列表刷新失败，请重启后打开作品') });
        }
      } else if (kind === 'export') {
        const { reconcileNativeProjectArchiveExport } = await import('../../services/nativeProjectArchiveService');
        await reconcileNativeProjectArchiveExport(id);
        if (mounted.current) setStatus({ kind: 'success', text: t('原导出文件和发布回执已核验') });
      } else if (kind === 'shared') {
        const { recoverNativeSharedAssetSync } = await import('../../services/indexedDb/nativeSharedAssetSyncRepository');
        await recoverNativeSharedAssetSync(id);
        if (mounted.current) setStatus({ kind: 'success', text: t('共享素材已按原收据恢复；请重新打开该项目') });
      } else if (kind === 'media-list') {
        const { captureLegacyCanvasContext, isProjectExpectedContextCurrent } = await import('../../services/projectExecutionContext');
        const context = captureLegacyCanvasContext(useAppStore.getState());
        if (!context || context.modelGeneration !== 1) throw new Error(t('请先打开原任务画布'));
        const { listNativeMediaTasks } = await import('../../services/indexedDb/nativeMediaTaskRepository');
        const rows = await listNativeMediaTasks(context.projectId);
        const { nativeImageBatchSummary } = await import('../../services/nativeImageBatch');
        const { listNativeEditorTransitions } = await import('../../services/nativeEditorTransitionService');
        const editors = await listNativeEditorTransitions();
        if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) throw new Error(t('画布已切换，请重新查看'));
        if (mounted.current) {
          setMediaRecords([...rows.filter((row) => row.canvasId === context.canvasId && (row.modelRef || ['volcengine', 'apimart', 'grsai', 'comfyui'].includes(row.providerConfigId)))
            .map((row) => { const batch = nativeImageBatchSummary(row); return { operationId: row.operationId, nodeId: row.nodeId,
              status: batch ? `${row.status} · ${t('已保存 {count} 张候选', { count: String(batch.candidateCount) })}${batch.lateTaskCount ? ` · ${t('{count} 个迟到原任务待核对', { count: String(batch.lateTaskCount) })}` : ''}`
                : row.submissionKind === 'sync' && row.localResult && row.status === 'submitted' ? t('本机待交付') : row.status }; }),
          ...editors.map((row) => ({ operationId: row.operationId, nodeId: row.anchorNodeId, status: row.status, editor: true }))]);
          setStatus({ kind: 'success', text: t('已读取当前画布的媒体和剪辑任务回执') });
        }
      } else if (kind === 'media-inspect') {
        const { listNativeEditorTransitions } = await import('../../services/nativeEditorTransitionService');
        const editor = (await listNativeEditorTransitions()).find((row) => row.operationId === id);
        if (editor) {
          if (mounted.current) {
            setReviewableMedia(false); setReviewableEditor(!['delivered', 'failed', 'reviewed'].includes(editor.status));
            setStatus({ kind: 'warning', text: t('剪辑任务状态：{state}。请先核对原平台和已保存产物；原视频节点已删除时，可结束本机跟踪，远端任务不会因此取消。', { state: editor.status }) });
          }
          return;
        }
        const { inspectNativeVolcengineTask } = await import('../../services/nativeVolcengineRecovery');
        const record = await inspectNativeVolcengineTask(id);
        const { nativeImageBatchSummary } = await import('../../services/nativeImageBatch');
        const batch = nativeImageBatchSummary(record);
        const unknownSubmission = record.status === 'prepared' || record.status === 'outcome-unknown';
        const needsReview = unknownSubmission || record.status === 'submitted';
        if (mounted.current) {
          setReviewableEditor(false);
          setReviewableMedia(needsReview);
          setStatus({ kind: needsReview || batch?.partial ? 'warning' : 'success', text: batch
            ? t('原批次已保存 {count} 张候选，{failed} 个任务失败，{rejected} 次提交失败，{unknown} 次提交仍需平台核对，{notStarted} 次未启动，{late} 个迟到原任务待核对。', {
              count: String(batch.candidateCount), failed: String(batch.failedTasks), rejected: String(batch.failedSubmissions), unknown: String(batch.unknownSubmissions), notStarted: String(batch.notStartedSubmissions), late: String(batch.lateTaskCount) })
            : unknownSubmission
            ? t('原任务提交状态未知，请先到对应平台核对；本机不能判断是否已扣费或生成。')
            : record.submissionKind === 'sync' && record.localResult && ['submitted', 'reviewed'].includes(record.status)
              ? t('原产物已保存在本机，可继续交付，不会再次调用服务商。')
            : t('原任务状态：{state}。', { state: record.status }) });
        }
      } else if (kind === 'media-review') {
        if (!reviewableMedia && !reviewableEditor) throw new Error(t('请先核对原任务状态'));
        if (reviewableEditor) {
          const { reviewNativeEditorTransition } = await import('../../services/nativeEditorTransitionService');
          await reviewNativeEditorTransition(id);
          if (mounted.current) { setReviewableEditor(false); setStatus({ kind: 'warning', text: t('已结束本机剪辑任务跟踪，原回执和产物保留；这不会取消远端任务，也不会再次生成。') }); }
          return;
        }
        const { captureLegacyCanvasContext } = await import('../../services/projectExecutionContext');
        const context = captureLegacyCanvasContext(useAppStore.getState());
        if (!context || context.modelGeneration !== 1) throw new Error(t('请先打开原任务画布'));
        const { reviewNativeMediaTask } = await import('../../services/indexedDb/nativeMediaTaskRepository');
        await reviewNativeMediaTask(id, context);
        if (mounted.current) {
          setReviewableMedia(false);
          setStatus({ kind: 'warning', text: t('已结束此原操作的本机跟踪并解除防重；原记录与产物保留，远端不会因此取消。原请求仍可能迟到或已扣费，请勿未经核对重新生成。') });
        }
      } else if (kind === 'media') {
        const { listNativeEditorTransitions, recoverNativeEditorTransition } = await import('../../services/nativeEditorTransitionService');
        const editor = (await listNativeEditorTransitions()).find((row) => row.operationId === id);
        if (editor) {
          await recoverNativeEditorTransition(id, editor.anchorNodeId);
          if (mounted.current) setStatus({ kind: 'success', text: t('已取回原剪辑产物，请重新打开原工程。') });
          return;
        }
        const { resumeNativeVolcengineTask, inspectNativeVolcengineTask } = await import('../../services/nativeVolcengineRecovery');
        const original = await inspectNativeVolcengineTask(id);
        await resumeNativeVolcengineTask(id);
        const { nativeImageBatchSummary } = await import('../../services/nativeImageBatch');
        const { listNativeMediaTasks } = await import('../../services/indexedDb/nativeMediaTaskRepository');
        const committed = (await listNativeMediaTasks(original.ownerProjectId)).find((record) => record.operationId === id);
        const batch = committed && nativeImageBatchSummary(committed);
        if (mounted.current) setStatus(batch ? { kind: batch.partial ? 'warning' : 'success', text: t('已完整交付 {count} 张已确认候选；{failed} 个任务失败，{rejected} 次提交失败，{unknown} 次提交仍需平台核对，{notStarted} 次未启动，{late} 个迟到原任务待核对。请返回原画布或对话查看。', {
          count: String(batch.candidateCount), failed: String(batch.failedTasks), rejected: String(batch.failedSubmissions), unknown: String(batch.unknownSubmissions), notStarted: String(batch.notStartedSubmissions), late: String(batch.lateTaskCount) }) }
          : { kind: 'success', text: t('原媒体产物已保存，请返回原画布或对话查看。') });
      } else {
        const { abortNativeSharedAssetSync } = await import('../../services/indexedDb/nativeSharedAssetSyncRepository');
        await abortNativeSharedAssetSync(id);
        if (mounted.current) setStatus({ kind: 'warning', text: t('未提交的本机应用已撤销，请重新打开项目。远端可能已经更新，原操作保留，请先核对远端再继续同步。') });
      }
    } catch (error) {
      if (mounted.current) setStatus({ kind: 'error', text: error instanceof Error ? error.message : t('恢复失败，请保留操作 ID 和原有材料') });
    } finally {
      running.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  return <details className="ui-card p-3">
    <summary className="cursor-pointer text-sm font-medium text-canvas-text">{t('恢复项目操作')}</summary>
    <p className="ui-hint mt-2">{t('输入失败提示中的原操作 ID，继续导入、恢复共享素材或核验导出文件。原有项目和暂存材料会保留。')}</p>
    <label className="mt-2 block text-xs text-canvas-text-secondary" htmlFor="native-project-recovery-id">{t('原操作 ID')}</label>
    <input id="native-project-recovery-id" className="ui-input mt-1 w-full" value={operationId} maxLength={128}
      disabled={busy !== null} onChange={(event) => { setOperationId(event.target.value); setStatus(null); setReviewableMedia(false); setReviewableEditor(false); }} />
    <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy !== null || !operationId.trim()}
        onClick={() => void recover('import')}>{busy === 'import' ? t('正在继续导入…') : t('继续导入')}</button>
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy !== null || !operationId.trim()}
        onClick={() => void recover('update')}>{busy === 'update' ? t('正在继续更新…') : t('继续项目更新')}</button>
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy !== null || !operationId.trim()}
        onClick={() => void recover('update-abort')}>{busy === 'update-abort' ? t('正在撤销更新…') : t('撤销未提交更新')}</button>
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy !== null || !operationId.trim()}
        onClick={() => void recover('export')}>{busy === 'export' ? t('正在核验导出…') : t('核验原导出')}</button>
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy !== null || !operationId.trim()}
        onClick={() => void recover('shared')}>{busy === 'shared' ? t('正在恢复共享素材…') : t('恢复共享素材')}</button>
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy !== null || !operationId.trim()}
        onClick={() => void recover('shared-abort')}>{busy === 'shared-abort' ? t('正在撤销本机应用…') : t('撤销未提交的共享素材本机应用')}</button>
    </div>
    <div className="mt-2 flex flex-wrap gap-2"><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm"
      disabled={busy !== null} onClick={() => void recover('media-list')}>
      {busy === 'media-list' ? t('正在读取媒体回执…') : t('查看当前画布媒体回执')}
    </button><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm"
      disabled={busy !== null || !operationId.trim()} onClick={() => void recover('media-inspect')}>
      {busy === 'media-inspect' ? t('正在核对原任务…') : t('核对原媒体任务状态')}
    </button><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm"
      disabled={busy !== null || !operationId.trim()} onClick={() => void recover('media')}>
      {busy === 'media' ? t('正在取回原产物…') : t('继续取回原媒体产物')}
    </button></div>
    {mediaRecords.length > 0 && <ul className="mt-2 space-y-1">{mediaRecords.map((row) => <li key={row.operationId}>
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy !== null}
        onClick={() => { setOperationId(row.operationId); setStatus(null); setReviewableMedia(false); setReviewableEditor(false); }}>
        {row.editor ? `${t('剪辑')} · ` : ''}{row.nodeId} · {row.status} · {row.operationId}
      </button>
    </li>)}</ul>}
    {(reviewableMedia || reviewableEditor) && <div className="ui-alert ui-alert--warning mt-2">
      <p>{t('确认已到对应平台核对原任务后，才可结束本机跟踪并解除防重。原请求仍可能迟到或已扣费；此操作不会取消远端任务。')}</p>
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm mt-2" disabled={busy !== null}
        onClick={() => void recover('media-review')}>{busy === 'media-review' ? t('正在处理…') : reviewableEditor ? t('我已核对，结束剪辑任务跟踪') : t('我已核对，结束媒体任务跟踪')}</button>
    </div>}
    <p className="ui-hint mt-2">{t('请先打开原任务画布；取回产物不会重新提交生成。提交状态未知时请先到平台核对。')}</p>
    <p className="ui-hint mt-2">{t('撤销只阻止该操作迟到的本机提交；远端可能已经更新，原操作会保留供核对。已有提交收据时请使用恢复。')}</p>
    {status && <p role={status.kind === 'error' ? 'alert' : 'status'} className={`ui-alert mt-2 ${status.kind === 'error'
      ? 'ui-alert--danger' : status.kind === 'warning' ? 'ui-alert--warning' : 'ui-alert--success'}`}>{status.text}</p>}
  </details>;
}
