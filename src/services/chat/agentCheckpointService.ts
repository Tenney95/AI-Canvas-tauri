/**
 * 生成 Agent 工具输入指纹并校验画布检查点，为重复写入抑制和安全回退提供依据。
 */
import type {
  AgentCanvasCheckpoint,
  AgentReplanReason,
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
  context: {
    callId: string;
    excludeStepId?: string;
    projectId: string | null;
    historyIndex: number;
    revision: number;
    checkpointReplayStepIds?: ReadonlySet<string>;
  },
): AgentStep | undefined {
  if (context.projectId !== task.projectId) return undefined;
  return task.steps.find((step) => {
    const call = step.toolCall;
    if (
      step.id === context.excludeStepId
      || step.status !== 'succeeded'
      || call?.toolId !== toolId
      || call.inputFingerprint !== inputFingerprint
      || !call.effect
      || call.effect === 'read'
    ) return false;

    // 同一个请求重放可以复用；参数相同但 callId 不同，是新的操作（尤其是重新生成）。
    if (context.callId && call.callId === context.callId) return true;

    // 仅恢复前的步骤可以利用仍处于当前历史尾部的画布检查点，避免重做已完成步骤。
    // 旧记录缺少检查点、画布已变化、媒体生成或普通后续轮次均不得按参数猜测成功。
    const checkpoint = call.canvasCheckpoint;
    return context.checkpointReplayStepIds?.has(step.id) === true
      && call.effect === 'canvas_write'
      && !!checkpoint
      && checkpoint.historyIndexAfter === context.historyIndex
      && checkpoint.revisionAfter === context.revision;
  });
}

const REPLAN_TRIGGER_LINES: Record<AgentReplanReason, string> = {
  user_requested: '用户要求重新规划本任务。',
  step_skipped: '用户跳过了当前待确认的步骤并要求重新规划；被跳过的步骤不得重试。',
};

/** 重新规划与普通继续的区别必须让模型看见，否则两者行为完全一致。 */
function buildReplanDirective(task: AgentTask): string {
  if (!task.replanRequest) return '';
  return [
    REPLAN_TRIGGER_LINES[task.replanRequest.reason],
    '放弃此前的计划，不要接着上一步继续执行。',
    '先读取当前画布与下方步骤摘要的真实状态，输出一份新的计划并说明与原计划的差异，再开始执行。',
    '已经完成的同一请求不得重复提交；新的修改或重新生成不等同于重放旧请求。',
  ].join('\n');
}

export function buildAgentResumeContext(task: AgentTask): string {
  const sections: string[] = [];
  const replanDirective = buildReplanDirective(task);
  if (replanDirective) sections.push(replanDirective);

  const completed = task.steps.filter((step) =>
    ['succeeded', 'failed', 'skipped'].includes(step.status));
  if (completed.length > 0) {
    const lines = completed.slice(-20).map((step) => {
      const state = step.status === 'succeeded' ? '成功' : step.status === 'failed' ? '失败' : '跳过';
      const result = step.outputSummary || step.toolCall?.resultSummary || step.errorCode || '无结果摘要';
      return `- ${state}：${step.title}（${step.toolCall?.toolId ?? step.kind}）— ${result}`;
    });
    sections.push([
      '这是该任务恢复前已经持久化的步骤摘要。不要重放已成功的同一请求；继续前先确认当前画布状态，再接着未完成的部分推进。新的修改或重新生成应作为新请求执行。',
      ...lines,
    ].join('\n'));
  }

  if (sections.length === 0) return '';
  return sections.join('\n\n').slice(0, 12_000);
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
