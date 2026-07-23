interface CanvasDerivationState {
  currentProjectId: string | null;
  nodes: ReadonlyArray<{ id: string }>;
  getCurrentRevision: () => number;
}

export interface CanvasDerivationGuard {
  readonly operationId: string;
  readonly projectId: string;
  readonly sourceNodeId: string;
  readonly baseRevision: number;
  readonly placeholderNodeId?: string;
}

interface PendingCanvasDerivation {
  guard: CanvasDerivationGuard;
  onCancel?: () => void;
}

const pendingDerivations = new Map<string, PendingCanvasDerivation>();
let operationSequence = 0;

export function registerCanvasDerivation(
  state: CanvasDerivationState,
  sourceNodeId: string,
  options: {
    placeholderNodeId?: string;
    onCancel?: () => void;
  } = {},
): CanvasDerivationGuard | null {
  const projectId = state.currentProjectId;
  if (!projectId || !state.nodes.some((node) => node.id === sourceNodeId)) return null;

  const guard: CanvasDerivationGuard = {
    operationId: `canvas-derivation-${Date.now()}-${operationSequence++}`,
    projectId,
    sourceNodeId,
    baseRevision: state.getCurrentRevision(),
    placeholderNodeId: options.placeholderNodeId,
  };
  pendingDerivations.set(guard.operationId, { guard, onCancel: options.onCancel });
  return guard;
}

export function isCanvasDerivationFresh(
  guard: CanvasDerivationGuard,
  state: CanvasDerivationState,
): boolean {
  if (!pendingDerivations.has(guard.operationId)) return false;
  if (state.currentProjectId !== guard.projectId) return false;
  if (state.getCurrentRevision() !== guard.baseRevision) return false;
  if (!state.nodes.some((node) => node.id === guard.sourceNodeId)) return false;
  return !guard.placeholderNodeId
    || state.nodes.some((node) => node.id === guard.placeholderNodeId);
}

export function completeCanvasDerivation(guard: CanvasDerivationGuard): void {
  pendingDerivations.delete(guard.operationId);
}

export function cancelCanvasDerivation(guard: CanvasDerivationGuard): void {
  const pending = pendingDerivations.get(guard.operationId);
  if (!pending) return;

  pendingDerivations.delete(guard.operationId);
  pending.onCancel?.();
}

export function cancelProjectCanvasDerivations(projectId: string): void {
  const projectGuards = [...pendingDerivations.values()]
    .filter((pending) => pending.guard.projectId === projectId)
    .map((pending) => pending.guard);
  projectGuards.forEach(cancelCanvasDerivation);
}
