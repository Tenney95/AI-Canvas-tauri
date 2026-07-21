import type {
  AgentCanvasCheckpoint,
  AgentStep,
  AgentTask,
} from '../../types/agent';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function fingerprintToolInput(toolId: string, input: unknown): string {
  const source = `${toolId}:${JSON.stringify(stableValue(input))}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function findSucceededDuplicateWrite(
  task: AgentTask,
  toolId: string,
  inputFingerprint: string,
  excludeStepId?: string,
): AgentStep | undefined {
  return task.steps.find((step) =>
    step.id !== excludeStepId
    && step.status === 'succeeded'
    && step.toolCall?.toolId === toolId
    && step.toolCall.inputFingerprint === inputFingerprint
    && step.toolCall.effect !== 'read');
}

export function buildAgentResumeContext(task: AgentTask): string {
  const completed = task.steps.filter((step) =>
    ['succeeded', 'failed', 'skipped'].includes(step.status));
  if (completed.length === 0) return '';
  const lines = completed.slice(-20).map((step) => {
    const state = step.status === 'succeeded' ? '成功' : step.status === 'failed' ? '失败' : '跳过';
    const result = step.outputSummary || step.toolCall?.resultSummary || step.errorCode || '无结果摘要';
    return `- ${state}：${step.title}（${step.toolCall?.toolId ?? step.kind}）— ${result}`;
  });
  return [
    '这是该任务恢复前已经持久化的步骤摘要。成功的写操作不得重复执行；继续前先读取当前画布状态并重新规划。',
    ...lines,
  ].join('\n').slice(0, 12_000);
}

export interface AgentRewindValidation {
  ok: boolean;
  errorCode?: string;
  message?: string;
  undoCount?: number;
  firstCheckpoint?: AgentCanvasCheckpoint;
  lastCheckpoint?: AgentCanvasCheckpoint;
}

function canvasCheckpoints(task: AgentTask): AgentCanvasCheckpoint[] {
  return task.steps
    .filter((step) => step.status === 'succeeded' && step.toolCall?.effect === 'canvas_write')
    .map((step) => step.toolCall?.canvasCheckpoint)
    .filter((checkpoint): checkpoint is AgentCanvasCheckpoint => !!checkpoint);
}

export function validateAgentTaskCanvasRewind(
  task: AgentTask,
  currentProjectId: string | null,
  currentHistoryIndex: number,
  currentRevision: number,
): AgentRewindValidation {
  if (task.projectId !== currentProjectId) {
    return { ok: false, errorCode: 'AGENT_REWIND_PROJECT_MISMATCH', message: '请先切回任务所属项目' };
  }
  const checkpoints = canvasCheckpoints(task);
  if (checkpoints.length === 0) {
    return { ok: false, errorCode: 'AGENT_REWIND_NO_CHECKPOINT', message: '该任务没有可回退的画布写入' };
  }
  for (let index = 1; index < checkpoints.length; index += 1) {
    const previous = checkpoints[index - 1];
    const current = checkpoints[index];
    if (
      current.historyIndexBefore !== previous.historyIndexAfter
      || current.revisionBefore !== previous.revisionAfter
    ) {
      return {
        ok: false,
        errorCode: 'AGENT_REWIND_HISTORY_INTERLEAVED',
        message: '任务执行期间存在其他画布修改，不能整体回退',
      };
    }
  }
  const firstCheckpoint = checkpoints[0];
  const lastCheckpoint = checkpoints.at(-1)!;
  if (currentHistoryIndex !== lastCheckpoint.historyIndexAfter) {
    return {
      ok: false,
      errorCode: 'AGENT_REWIND_NOT_HISTORY_TAIL',
      message: '任务之后已有新的画布历史，不能整体回退',
    };
  }
  if (currentRevision !== lastCheckpoint.revisionAfter) {
    return {
      ok: false,
      errorCode: 'AGENT_REWIND_REVISION_CHANGED',
      message: '画布版本已变化，不能整体回退',
    };
  }
  const undoCount = lastCheckpoint.historyIndexAfter - firstCheckpoint.historyIndexBefore;
  if (undoCount <= 0) {
    return { ok: false, errorCode: 'AGENT_REWIND_EMPTY', message: '没有可回退的历史步骤' };
  }
  return { ok: true, undoCount, firstCheckpoint, lastCheckpoint };
}
