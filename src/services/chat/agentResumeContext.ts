/** 显式继续只更新运行租约；持久身份、版本、预算和原回执不改变。 */
import type { AgentTask } from '../../types/agent';
import type { ProjectExecutionContextState } from '../../types/projectExecutionContext';
import { captureLegacyEpisodeContext, captureLegacyProjectExpectedContext, isProjectExpectedContextCurrent,
  parseProjectExpectedContext, ProjectExecutionContextError } from '../projectExecutionContext';

export function nativeAgentResumeContext(state: ProjectExecutionContextState, task: AgentTask):
  Partial<Pick<AgentTask, 'executionContext' | 'projectScope'>> {
  const patch: Partial<Pick<AgentTask, 'executionContext' | 'projectScope'>> = {};
  if (state.projectExecutionContext?.modelGeneration && !task.executionContext && !task.projectScope
    && (task.projectId === state.currentProjectId || state.projectExecutionContext.kind !== 'global'
      && task.projectId === state.projectExecutionContext.projectId)) throw new ProjectExecutionContextError();
  for (const key of ['executionContext', 'projectScope'] as const) {
    const saved = task[key];
    if (!saved || saved.modelGeneration === 0) continue;
    const original = parseProjectExpectedContext(saved);
    if (original.modelGeneration !== 1 || original.kind === 'global' || !original.runtimeEpoch
      || !isProjectExpectedContextCurrent(original, state, { checkRuntimeEpoch: false, checkCanvasRevision: key === 'executionContext' })) {
      throw new ProjectExecutionContextError();
    }
    const current = original.kind === 'episode' ? captureLegacyEpisodeContext(state, original.episodeId)
      : captureLegacyProjectExpectedContext(state, original.kind);
    if (!current?.runtimeEpoch) throw new ProjectExecutionContextError();
    patch[key] = { ...original, runtimeEpoch: current.runtimeEpoch };
  }
  return patch;
}
