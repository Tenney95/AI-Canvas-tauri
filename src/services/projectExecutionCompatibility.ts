/** 旧任务/回执/账本的只读身份视图。绝不重写记录、预算、幂等键或派发操作。 */
import type { LegacyProjectBinding, ProjectExecutionTarget } from '../types/project';

export interface LegacyExecutionIdentity {
  /** 旧合同：原Canvas alias，工作台任务可能是原owner，不能直接解释为新版owner。 */
  projectId: string;
  workbenchTarget?: { seriesId: string; episodeId: string };
  teamRun?: { target?: { seriesId: string; episodeId: string } };
}
export type LegacyExecutionScopeView =
  | { version: 'legacy-scope-v1'; state: 'unresolved'; legacyProjectId: string; access: 'history-readonly' }
  | { version: 'legacy-scope-v1'; state: 'active' | 'retired'; legacyProjectId: string; ownerProjectId: string;
      target: ProjectExecutionTarget; access: 'history-readonly' };

/** 无匹配、跨owner或歧义不猜测；retired只允许显示原回执，不能据此恢复执行。 */
export function readLegacyExecutionScope(record: LegacyExecutionIdentity,
  bindings: readonly LegacyProjectBinding[]): LegacyExecutionScopeView {
  const unresolved = { version: 'legacy-scope-v1', state: 'unresolved', legacyProjectId: record.projectId,
    access: 'history-readonly' } as const;
  if (record.workbenchTarget && record.teamRun?.target
    && (record.workbenchTarget.seriesId !== record.teamRun.target.seriesId || record.workbenchTarget.episodeId !== record.teamRun.target.episodeId)) return unresolved;
  const hint = record.workbenchTarget ?? record.teamRun?.target;
  let matches = bindings.filter((binding) => hint
    ? binding.namespace === 'legacy-episode' && binding.legacyId === hint.episodeId && binding.projectId === hint.seriesId
    : binding.namespace === 'legacy-canvas' && binding.legacyId === record.projectId);
  if (!hint && !matches.length) matches = bindings.filter((binding) => binding.namespace === 'legacy-root'
    && binding.legacyId === record.projectId && binding.projectId === record.projectId);
  if (!matches.length) return unresolved;
  const targets = matches.map((binding) => ({ binding, target: hint && binding.episodeId
    ? { kind: 'episode', projectId: binding.projectId, episodeId: binding.episodeId } as const
    : binding.canvasId ? { kind: 'canvas', projectId: binding.projectId, canvasId: binding.canvasId, episodeId: binding.episodeId ?? null } as const
      : binding.namespace === 'legacy-root' ? { kind: 'project', projectId: binding.projectId, domain: 'shared' } as const : null }));
  if (targets.some((entry) => !entry.target)) return unresolved;
  const first = targets[0]!;
  if (targets.some((entry) => JSON.stringify(entry.target) !== JSON.stringify(first.target)
    || !!entry.binding.retired !== !!first.binding.retired)) return unresolved;
  if (hint && record.projectId !== hint.seriesId && record.projectId !== first.binding.legacyId) return unresolved;
  return { version: 'legacy-scope-v1', state: first.binding.retired ? 'retired' : 'active', legacyProjectId: record.projectId,
    ownerProjectId: first.binding.projectId, target: first.target!, access: 'history-readonly' };
}

/** 用于owner历史汇总；包括退役alias，不以是否还有活动画布删掉审计。 */
export function getLegacyCanvasAliases(projectId: string, bindings: readonly LegacyProjectBinding[]): string[] {
  return [...new Set(bindings.filter((binding) => binding.namespace === 'legacy-canvas' && binding.projectId === projectId)
    .map((binding) => binding.legacyId))].sort();
}
