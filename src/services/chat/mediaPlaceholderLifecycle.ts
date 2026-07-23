import { useAppStore } from '../../store/useAppStore';
import type { MediaGenerationResult } from '../../types/media';
import {
  completeCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
  type CanvasDerivationGuard,
} from '../canvasDerivationGuard';

export const MEDIA_PLACEHOLDER_STALE_ERROR =
  '生成期间项目或画布已变更，可从对话消息重新添加';

export interface MediaPlaceholderLifecycle {
  guard: CanvasDerivationGuard;
  nodeId: string;
  projectId: string;
}

function failCurrentPlaceholder(
  lifecycle: MediaPlaceholderLifecycle,
  error: string,
): boolean {
  const store = useAppStore.getState();
  if (
    store.currentProjectId !== lifecycle.projectId
    || !store.nodes.some((node) => node.id === lifecycle.nodeId)
  ) {
    return false;
  }
  store.failMediaPlaceholder(lifecycle.nodeId, error);
  store.incrementRevision();
  return true;
}

export function registerMediaPlaceholderLifecycle(
  nodeId: string,
): MediaPlaceholderLifecycle | null {
  const store = useAppStore.getState();
  const projectId = store.currentProjectId;
  if (!projectId) return null;

  let lifecycle: MediaPlaceholderLifecycle | null = null;
  const guard = registerCanvasDerivation(store, nodeId, {
    placeholderNodeId: nodeId,
    onCancel: () => {
      if (lifecycle) failCurrentPlaceholder(lifecycle, MEDIA_PLACEHOLDER_STALE_ERROR);
    },
  });
  if (!guard) return null;

  lifecycle = { guard, nodeId, projectId };
  return lifecycle;
}

export function settleMediaPlaceholderLifecycle(
  lifecycle: MediaPlaceholderLifecycle,
  artifact: MediaGenerationResult,
): boolean {
  const store = useAppStore.getState();
  try {
    if (!isCanvasDerivationFresh(lifecycle.guard, store)) {
      failCurrentPlaceholder(lifecycle, MEDIA_PLACEHOLDER_STALE_ERROR);
      return false;
    }
    const settled = store.settleMediaPlaceholder(lifecycle.nodeId, artifact);
    if (settled) store.incrementRevision();
    return settled;
  } finally {
    completeCanvasDerivation(lifecycle.guard);
  }
}

export function failMediaPlaceholderLifecycle(
  lifecycle: MediaPlaceholderLifecycle,
  error: string,
): void {
  try {
    failCurrentPlaceholder(lifecycle, error);
  } finally {
    completeCanvasDerivation(lifecycle.guard);
  }
}
