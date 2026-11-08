import type { ProjectWindowContext } from '../types/projectWindow';
import { configValuesEqual } from './configPatch';
import {
  captureLegacyCanvasContext, captureLegacyEpisodeContext, captureLegacyProjectExpectedContext,
  isProjectExpectedContextCurrent,
} from './projectExecutionContext';

type ContextState = Parameters<typeof captureLegacyCanvasContext>[0];

/** episodeId 必须来自工作台/会话捕获的目标，不能用当前画布替代。 */
export function captureProjectWindowContext(state: ContextState, episodeId?: string | null): ProjectWindowContext | null {
  try {
    const canvas = captureLegacyCanvasContext(state);
    const target = episodeId ? captureLegacyEpisodeContext(state, episodeId)
      : canvas ?? captureLegacyProjectExpectedContext(state);
    if (!target || (episodeId && (!canvas || target.kind === 'global' || target.projectId !== canvas.projectId))) return null;
    return { schemaVersion: 2, target, canvas };
  } catch { return null; }
}

export function isProjectWindowContextCurrent(context: ProjectWindowContext | null | undefined, state: ContextState): boolean {
  try {
    if (!context || context.schemaVersion !== 2 || !context.target
      || !isProjectExpectedContextCurrent(context.target, state, { checkCanvasRevision: false })) return false;
    const canvas = captureLegacyCanvasContext(state);
    return context.canvas === null ? canvas === null
      : !!canvas && isProjectExpectedContextCurrent(context.canvas, state, { checkCanvasRevision: false });
  } catch { return false; }
}

/** 快照正文可以更新；已发布的目标与租约不能被请求者替换。 */
export function sameProjectWindowContext(left: ProjectWindowContext | null | undefined, right: ProjectWindowContext | null | undefined): boolean {
  if (!left || !right || left.schemaVersion !== 2 || right.schemaVersion !== 2 || !left.target || !right.target) return false;
  const basis = (value: ProjectWindowContext) => ({ ...value,
    canvas: value.canvas ? { ...value.canvas, canvasRevision: 0 } : null,
    target: value.target.kind === 'canvas' ? { ...value.target, canvasRevision: 0 } : value.target });
  // 原生事件序列化可能调整键顺序，租约字段的值仍须全部相同。
  return configValuesEqual(basis(left), basis(right));
}
