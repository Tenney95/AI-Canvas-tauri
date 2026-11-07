/**
 * 校验 Agent 画布检查点后按历史快照回退任务写入，并记录回退事件。
 */
import { useAppStore } from '../../store/useAppStore';
import {
  validateAgentTaskCanvasRewind,
  type AgentRewindValidation,
} from './agentCheckpointService';
import { appendAgentEvent } from './agentJournal';
import { isProjectExpectedContextCurrent } from '../projectExecutionContext';

export async function rewindAgentTaskCanvas(taskId: string): Promise<AgentRewindValidation> {
  const store = useAppStore.getState();
  const task = store.agentTasks.find((item) => item.id === taskId);
  if (!task) {
    return { ok: false, errorCode: 'AGENT_REWIND_TASK_NOT_FOUND', message: '任务不存在' };
  }
  const context = task.executionContext ?? task.projectScope;
  const isCurrent = () => !!context && context.kind === 'canvas'
    && isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false });
  if (!isCurrent()) return { ok: false, errorCode: 'AGENT_REWIND_CONTEXT_UNPROVEN',
    message: '原画布历史租约无法证明或已经失效，旧检查点仅供查看，不能回退当前画布' };
  const validation = validateAgentTaskCanvasRewind(
    task,
    store.currentProjectId,
    store.historyIndex,
    store.getCurrentRevision(),
  );
  if (!validation.ok || !validation.undoCount) return validation;

  for (let index = 0; index < validation.undoCount; index += 1) {
    if (!isCurrent()) return { ok: false, errorCode: 'AGENT_REWIND_CONTEXT_CHANGED', message: '回退期间画布已切换，已停止后续回退' };
    if (!await useAppStore.getState().undo({ isCurrent })) return { ok: false, errorCode: 'AGENT_REWIND_CONTEXT_CHANGED',
      message: '回退期间画布或历史已变化，已停止后续回退' };
  }
  if (!isCurrent()) return { ok: false, errorCode: 'AGENT_REWIND_CONTEXT_CHANGED', message: '回退期间画布已切换，未更新新画布修订' };
  const revisionAfter = useAppStore.getState().incrementRevision();
  appendAgentEvent(taskId, 'canvas_rewind', {
    historyIndexBefore: validation.lastCheckpoint?.historyIndexAfter,
    historyIndexAfter: useAppStore.getState().historyIndex,
    revisionBefore: validation.lastCheckpoint?.revisionAfter,
    revisionAfter,
  });
  return validation;
}
