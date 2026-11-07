import { memo, useRef, useState, useSyncExternalStore } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { derivedNodePlacement, generateId } from '../../../store/store.utils';
import { cancelCanvasDerivation, completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../../../services/canvasDerivationGuard';
import { completeMediaNodeTask, getMediaTaskSnapshot, subscribeMediaTasks, type MediaTaskSnapshot } from '../../../services/pollManager';
import { recoverVideoEditorAiTransition } from '../../../services/videoEditorAiTransitionService';

/** 仅选中的原锚点显示恢复入口；每次取回都由用户重新领取派生写入租约。 */
function VideoEditorTransitionRecovery({ projectId, anchorNodeId }: { projectId: string; anchorNodeId: string }) {
  const tasks = useSyncExternalStore(subscribeMediaTasks, getMediaTaskSnapshot, getMediaTaskSnapshot)
    .filter((task) => task.projectId === projectId && task.mediaContext?.editorTransition?.anchorNodeId === anchorNodeId);
  const busy = useRef(false);
  const [recovering, setRecovering] = useState(false);
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
  if (!tasks.length) return null;
  return <div className="ui-card nodrag nopan mt-2 flex flex-col gap-2 p-2">
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
