import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { derivedNodePlacement, generateId } from '../../../store/store.utils';
import { cancelCanvasDerivation, completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../../../services/canvasDerivationGuard';
import { completeMediaNodeTask, getMediaTaskSnapshot, subscribeMediaTasks, type MediaTaskSnapshot } from '../../../services/pollManager';
import type { NativeEditorMediaTask } from '../../../services/indexedDb/nativeEditorMediaTaskRepository';
import { describeNativeEditorRecovery } from '../../../services/nativeMediaRecoverySummary';
import { useT } from '../../../i18n';

/** 仅选中的原锚点显示恢复入口；每次取回都由用户重新领取派生写入租约。 */
function VideoEditorTransitionRecovery({ projectId, anchorNodeId }: { projectId: string; anchorNodeId: string }) {
  const t = useT();
  const counts = (task: NativeEditorMediaTask) => { const summary = describeNativeEditorRecovery(task);
    return t('已保存 {count} 个产物，原计划 {expected} 个；失败任务 {failed} 个，失败提交 {rejected} 次，未知提交 {unknown} 次，未开始 {notStarted} 次，迟到任务 {late} 个。', {
      count: String(summary.resultCount), expected: String(summary.taskCount || 1), failed: String(summary.failedTasks), rejected: '0',
      unknown: String(summary.unknownSubmissions), notStarted: '0', late: '0' }); };
  const tasks = useSyncExternalStore(subscribeMediaTasks, getMediaTaskSnapshot, getMediaTaskSnapshot)
    .filter((task) => task.projectId === projectId && task.mediaContext?.editorTransition?.anchorNodeId === anchorNodeId);
  const busy = useRef(false);
  const [recovering, setRecovering] = useState(false);
  const context = useAppStore((state) => state.projectExecutionContext);
  const native = context?.kind === 'canvas' && context.modelGeneration === 1 && context.canvasId === projectId;
  const [nativeTasks, setNativeTasks] = useState<NativeEditorMediaTask[]>([]);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    if (native) void import('../../../services/nativeEditorTransitionService').then(({ listNativeEditorTransitions }) => listNativeEditorTransitions(anchorNodeId))
      .then((rows) => { if (active) setNativeTasks(rows.filter((row) => !['delivered', 'failed', 'reviewed'].includes(row.status)
        || row.status === 'delivered' && describeNativeEditorRecovery(row).partial)); })
      .catch(() => { if (active) setNativeTasks([]); });
    return () => { active = false; };
  }, [anchorNodeId, native, context, refresh]);
  const recoverNative = async (task: NativeEditorMediaTask) => {
    if (busy.current) return;
    busy.current = true; setRecovering(true);
    try {
      const { recoverNativeEditorTransition, listNativeEditorTransitions } = await import('../../../services/nativeEditorTransitionService');
      await recoverNativeEditorTransition(task.operationId, anchorNodeId);
      const latest = (await listNativeEditorTransitions(anchorNodeId)).find((row) => row.operationId === task.operationId);
      const partial = !!latest && describeNativeEditorRecovery(latest).partial;
      useAppStore.getState().showToast(`已取回到原剪辑工程，请重新打开剪辑器查看${latest ? ` · ${counts(latest)}` : ''}`, partial ? 'info' : 'success');
    } catch (error) {
      useAppStore.getState().showToast(error instanceof Error ? error.message : '转场取回失败，原任务保留', 'error');
    } finally { busy.current = false; setRecovering(false); setRefresh((value) => value + 1); }
  };
  const reviewNative = async (task: NativeEditorMediaTask) => {
    if (busy.current) return;
    const { ask } = await import('@tauri-apps/plugin-dialog');
    const confirmed = await ask(task.resultPath ? '仅保留已取回的独立素材，不插入原剪辑工程，并结束本次跟踪？'
      : '请确认已在原平台核对任务。结束跟踪不会取消远端任务，原回执会保留。', { title: '结束转场跟踪', kind: 'warning', okLabel: '已核对，结束跟踪', cancelLabel: '继续保留' });
    if (!confirmed) return;
    busy.current = true; setRecovering(true);
    try {
      const { reviewNativeEditorTransition } = await import('../../../services/nativeEditorTransitionService');
      await reviewNativeEditorTransition(task.operationId, anchorNodeId);
      useAppStore.getState().showToast('已结束跟踪，原回执和已取回素材仍保留', 'info');
    } catch (error) {
      useAppStore.getState().showToast(error instanceof Error ? error.message : '未能结束跟踪', 'error');
    } finally { busy.current = false; setRecovering(false); setRefresh((value) => value + 1); }
  };
  const recover = async (task: MediaTaskSnapshot) => {
    if (busy.current) return;
    const store = useAppStore.getState();
    if (store.currentProjectId !== projectId) return;
    const controller = new AbortController();
    const derivation = registerCanvasDerivation(store, anchorNodeId, { onCancel: () => controller.abort() });
    if (!derivation) return;
    const assertCurrent = () => {
      if (controller.signal.aborted || !isCanvasDerivationFresh(derivation, useAppStore.getState())) {
        throw new Error('取回目标已变化，原 AI 转场结果仍保留');
      }
    };
    busy.current = true;
    setRecovering(true);
    try {
      const { recoverVideoEditorAiTransition } = await import('../../../services/videoEditorAiTransitionService');
      assertCurrent();
      const outcome = await recoverVideoEditorAiTransition(task, anchorNodeId, controller.signal, assertCurrent);
      assertCurrent();
      const current = useAppStore.getState();
      const anchor = current.nodes.find((node) => node.id === anchorNodeId);
      if (!anchor) throw new Error('原视频节点已不存在，转场结果仍保留');
      current.addNode({ id: `node-${generateId()}`, type: 'ai-video', ...derivedNodePlacement(anchor),
        data: { type: 'ai-video', role: 'source', label: 'AI 转场', status: 'success', videoUrl: outcome.videoUrl,
          filePath: outcome.filePath, fileName: outcome.fileName, nodeWidth: 280, nodeHeight: 158 } });
      if (outcome.taskReceipt) completeMediaNodeTask(outcome.taskReceipt);
      completeCanvasDerivation(derivation);
      current.showToast('已取回原 AI 转场，可将新视频节点导入剪辑器', 'success');
    } catch (error) {
      if (isCanvasDerivationFresh(derivation, useAppStore.getState())) {
        useAppStore.getState().showToast(error instanceof Error ? error.message : 'AI 转场取回失败，原任务已保留', 'error');
      }
    } finally {
      cancelCanvasDerivation(derivation);
      busy.current = false;
      setRecovering(false);
    }
  };
  if (!tasks.length && !(native && nativeTasks.length)) return null;
  return <div className="ui-card nodrag nopan mt-2 flex flex-col gap-2 p-2">
    {native && nativeTasks.map((task) => <div key={task.operationId} className="flex flex-col gap-1">
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={recovering || task.status !== 'submitted'}
        onClick={() => { void recoverNative(task); }}>{recovering ? '正在取回原转场…' : '取回 AI 转场'}</button>
      <span className="text-xs text-canvas-text-secondary">{task.status === 'delivered' ? t('已取回原剪辑产物，请重新打开原工程。') : task.status === 'submitted'
        ? task.resultPath ? '视频素材已取回；原工程变化时可仅保留独立素材。' : '结果将保存到原剪辑工程；工程变化时保留结果，不覆盖编辑。'
        : '提交状态待核对，请先到原平台查询原任务。'}</span>
      <span className={describeNativeEditorRecovery(task).partial ? 'ui-alert ui-alert--warning text-xs' : 'text-xs text-canvas-text-secondary'}>{counts(task)}</span>
      {task.status !== 'delivered' && <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={recovering}
        onClick={() => { void reviewNative(task).catch((error) => useAppStore.getState().showToast(error instanceof Error ? error.message : '无法打开确认', 'error')); }}>
        {task.resultPath ? '仅保留独立素材' : '已核对，结束跟踪'}
      </button>}
    </div>)}
    {tasks.map((task, index) => {
      const unknown = !task.submitted || !task.taskId || task.mediaSubmissionUncertain || task.mediaRecoveryState === 'submit_unknown';
      return <div key={`${task.nodeId}:${task.attemptId}`} className="flex flex-col gap-1">
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={recovering || unknown || task.terminalFailure}
          onClick={() => { void recover(task); }}>
          {recovering ? '正在取回原转场…' : `${task.mediaContext?.editorTransition?.delivered ? '再次取回' : '取回'} AI 转场${tasks.length > 1 ? ` ${index + 1}` : ''}`}
        </button>
        <span className="text-xs text-canvas-text-secondary">{task.terminalFailure ? '原平台已确认生成失败；原任务身份仍保留' : unknown
          ? '提交状态未知，请到原平台核对；不会重新生成'
          : '继续查询或保存原任务，不会重新生成'}</span>
      </div>;
    })}
  </div>;
}

export default memo(VideoEditorTransitionRecovery);
