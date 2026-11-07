/**
 * 跟踪异步画布派生操作的项目、源节点和 revision，阻止过期结果写回当前画布。
 */
import type { CanvasContext } from '../types/project';
import type { ProjectExecutionContextState } from '../types/projectExecutionContext';
import {
  captureLegacyCanvasContext, isProjectExpectedContextCurrent, parseProjectExpectedContext,
} from './projectExecutionContext';

interface CanvasDerivationState extends ProjectExecutionContextState {
  nodes: ReadonlyArray<{ id: string }>;
}

export interface CanvasDerivationGuard {
  readonly operationId: string;
  readonly projectId: string;
  readonly sourceNodeId: string | null;
  readonly baseRevision: number;
  readonly placeholderNodeId?: string;
  readonly expectedContext?: Readonly<CanvasContext>;
}

function captureContext(state: CanvasDerivationState): CanvasContext | null {
  if (state.projectExecutionContext !== undefined) {
    try {
      const parsed = parseProjectExpectedContext(state.projectExecutionContext);
      return parsed.kind === 'canvas' && parsed.canvasId === state.currentProjectId
        && parsed.canvasRevision === state.getCurrentRevision() ? parsed : null;
    } catch { return null; }
  }
  return captureLegacyCanvasContext(state);
}

/** 仅核对目标身份/代际；不是执行租约，不能替代isCanvasDerivationFresh。 */
export function isCanvasDerivationTargetCurrent(guard: CanvasDerivationGuard, state: CanvasDerivationState): boolean {
  if (state.currentProjectId !== guard.projectId) return false;
  if (!guard.expectedContext) return state.projects === undefined && state.projectExecutionContext === undefined;
  return isProjectExpectedContextCurrent(guard.expectedContext, state.projectExecutionContext ?? state, { checkCanvasRevision: false });
}

interface PendingCanvasDerivation {
  guard: CanvasDerivationGuard;
  onCancel?: () => void;
}

interface CanvasDerivationRuntime {
  pendingDerivations: Map<string, PendingCanvasDerivation>;
  operationSequence: number;
}

/** 热更新只保留运行中的登记；完整重载和独立窗口仍从空运行时开始。 */
export function createOrReuseCanvasDerivationRuntime(
  hotData?: { canvasDerivations?: CanvasDerivationRuntime },
) {
  const runtime = hotData?.canvasDerivations ?? {
    pendingDerivations: new Map<string, PendingCanvasDerivation>(), operationSequence: 0,
  };
  if (hotData) hotData.canvasDerivations = runtime;

  function registerCanvasDerivation(
    state: CanvasDerivationState,
    sourceNodeId: string,
    options: { placeholderNodeId?: string; onCancel?: () => void } = {},
  ): CanvasDerivationGuard | null {
    const projectId = state.currentProjectId;
    if (!projectId || !state.nodes.some((node) => node.id === sourceNodeId)) return null;
    const context = captureContext(state);
    if (!context && (state.projects !== undefined || state.projectExecutionContext !== undefined)) return null;
    const guard: CanvasDerivationGuard = {
      operationId: `canvas-derivation-${Date.now()}-${runtime.operationSequence++}`,
      projectId, sourceNodeId, baseRevision: state.getCurrentRevision(),
      placeholderNodeId: options.placeholderNodeId,
      ...(context ? { expectedContext: Object.freeze(structuredClone(context)) } : {}),
    };
    Object.freeze(guard);
    runtime.pendingDerivations.set(guard.operationId, { guard, onCancel: options.onCancel });
    return guard;
  }

  /** 新素材导入没有源节点，仍绑定项目、revision 和项目切换取消生命周期。 */
  function registerCanvasImport(state: CanvasDerivationState, onCancel?: () => void): CanvasDerivationGuard | null {
    if (!state.currentProjectId) return null;
    const context = captureContext(state);
    if (!context && (state.projects !== undefined || state.projectExecutionContext !== undefined)) return null;
    const guard: CanvasDerivationGuard = {
      operationId: `canvas-import-${Date.now()}-${runtime.operationSequence++}`,
      projectId: state.currentProjectId, sourceNodeId: null, baseRevision: state.getCurrentRevision(),
      ...(context ? { expectedContext: Object.freeze(structuredClone(context)) } : {}),
    };
    Object.freeze(guard);
    runtime.pendingDerivations.set(guard.operationId, { guard, onCancel });
    return guard;
  }

  function isCanvasDerivationFresh(guard: CanvasDerivationGuard, state: CanvasDerivationState): boolean {
    if (runtime.pendingDerivations.get(guard.operationId)?.guard !== guard) return false;
    if (!isCanvasDerivationTargetCurrent(guard, state)) return false;
    if (state.getCurrentRevision() !== guard.baseRevision) return false;
    if (guard.sourceNodeId !== null && !state.nodes.some((node) => node.id === guard.sourceNodeId)) return false;
    return !guard.placeholderNodeId || state.nodes.some((node) => node.id === guard.placeholderNodeId);
  }

  function completeCanvasDerivation(guard: CanvasDerivationGuard): void {
    if (runtime.pendingDerivations.get(guard.operationId)?.guard === guard) runtime.pendingDerivations.delete(guard.operationId);
  }

  function cancelCanvasDerivation(guard: CanvasDerivationGuard): void {
    const pending = runtime.pendingDerivations.get(guard.operationId);
    if (pending?.guard !== guard) return;
    runtime.pendingDerivations.delete(guard.operationId);
    pending.onCancel?.();
  }

  function cancelProjectCanvasDerivations(projectId: string): void {
    const projectGuards = [...runtime.pendingDerivations.values()]
      .filter((pending) => pending.guard.projectId === projectId)
      .map((pending) => pending.guard);
    projectGuards.forEach(cancelCanvasDerivation);
  }

  return { registerCanvasDerivation, registerCanvasImport, isCanvasDerivationFresh,
    completeCanvasDerivation, cancelCanvasDerivation, cancelProjectCanvasDerivations };
}

export const {
  registerCanvasDerivation, registerCanvasImport, isCanvasDerivationFresh,
  completeCanvasDerivation, cancelCanvasDerivation, cancelProjectCanvasDerivations,
} = createOrReuseCanvasDerivationRuntime(import.meta.hot?.data);
