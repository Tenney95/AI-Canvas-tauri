import { useState } from 'react';
import { useT } from '../../../i18n';
import { useAppStore } from '../../../store/useAppStore';
import { removePendingTask, resumeWorkflowApiNodeTask, updatePendingTask, type PendingTask } from '../../../services/pollManager';

export default function WorkflowApiTaskStatus({ task }: { task: PendingTask }) {
  const t = useT();
  const [taskId, setTaskId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const store = useAppStore.getState();
  return <div className="ui-card m-2 flex flex-col gap-2 p-3 text-xs">
    <p>{task.taskId ? t('任务 {id} 已保留，可继续查询或保存。', { id: task.taskId }) : t('提交状态未知，请到对应平台核对并补充任务 ID，避免重复生成。')}</p>
    {!task.taskId && <input className="ui-input w-full" aria-label={t('工作流任务 ID')} value={taskId} onChange={(e) => setTaskId(e.target.value)} />}
    <button type="button" className="ui-btn ui-btn--sm" onClick={() => {
      if (!task.taskId) {
        if (!/^[\w.:-]{1,256}$/.test(taskId.trim()) || !task.workflowApi) { store.showToast(t('请填写正确的任务 ID'), 'error'); return; }
        updatePendingTask(task.nodeId, { taskId: taskId.trim(), submitted: true, workflowApi: { ...task.workflowApi, state: 'disconnected' } }, '');
      }
      void resumeWorkflowApiNodeTask(task.nodeId);
    }}>{t('继续查询 / 保存')}</button>
    <details><summary className="cursor-pointer text-canvas-text-secondary">{t('在平台确认任务结束后解除限制')}</summary>
      <label className="my-2 flex gap-2"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />{t('我已在平台确认任务未提交或已经结束')}</label>
      <button type="button" className="ui-btn ui-btn--sm" disabled={!confirmed} onClick={() => {
        removePendingTask(task.nodeId, task.taskId);
        store.updateNodeDataTransient(task.nodeId, { status: 'idle', error: undefined, workflowApiStage: undefined });
      }}>{t('清除本地恢复记录')}</button>
    </details>
  </div>;
}
