import { useAppStore } from '../../store/useAppStore';
import {
  validateAgentTaskCanvasRewind,
  type AgentRewindValidation,
} from './agentCheckpointService';
import { appendAgentEvent } from './agentJournal';

export async function rewindAgentTaskCanvas(taskId: string): Promise<AgentRewindValidation> {
  const store = useAppStore.getState();
  const task = store.agentTasks.find((item) => item.id === taskId);
  if (!task) {
    return { ok: false, errorCode: 'AGENT_REWIND_TASK_NOT_FOUND', message: '任务不存在' };
  }
  const validation = validateAgentTaskCanvasRewind(
    task,
    store.currentProjectId,
    store.historyIndex,
    store.getCurrentRevision(),
  );
  if (!validation.ok || !validation.undoCount) return validation;

  for (let index = 0; index < validation.undoCount; index += 1) {
    await useAppStore.getState().undo();
  }
  const revisionAfter = useAppStore.getState().incrementRevision();
  appendAgentEvent(taskId, 'canvas_rewind', {
    historyIndexBefore: validation.lastCheckpoint?.historyIndexAfter,
    historyIndexAfter: useAppStore.getState().historyIndex,
    revisionBefore: validation.lastCheckpoint?.revisionAfter,
    revisionAfter,
  });
  return validation;
}

