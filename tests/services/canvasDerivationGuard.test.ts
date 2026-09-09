import { describe, expect, it, vi } from 'vitest';
import {
  cancelCanvasDerivation,
  cancelProjectCanvasDerivations,
  completeCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
  registerCanvasImport,
} from '../../src/services/canvasDerivationGuard';

function createState(projectId = 'project-a') {
  let revision = 3;
  const state = {
    currentProjectId: projectId as string | null,
    nodes: [{ id: 'source' }, { id: 'placeholder' }],
    getCurrentRevision: () => revision,
  };
  return {
    state,
    setRevision: (nextRevision: number) => { revision = nextRevision; },
  };
}

describe('canvasDerivationGuard', () => {
  it('guards an empty-canvas import and invalidates it on project lifecycle cancellation', () => {
    const { state, setRevision } = createState();
    state.nodes = [];
    const cancel = vi.fn();
    const guard = registerCanvasImport(state, cancel)!;
    expect(isCanvasDerivationFresh(guard, state)).toBe(true);
    setRevision(4);
    expect(isCanvasDerivationFresh(guard, state)).toBe(false);
    setRevision(3);
    cancelProjectCanvasDerivations(state.currentProjectId!);
    expect(cancel).toHaveBeenCalledOnce();
    expect(isCanvasDerivationFresh(guard, state)).toBe(false);
    state.currentProjectId = null;
    expect(registerCanvasImport(state)).toBeNull();
  });
  it('requires the project, revision, source node and placeholder to remain current', () => {
    const { state, setRevision } = createState();
    const guard = registerCanvasDerivation(state, 'source', { placeholderNodeId: 'placeholder' });
    expect(guard).not.toBeNull();
    expect(isCanvasDerivationFresh(guard!, state)).toBe(true);

    setRevision(4);
    expect(isCanvasDerivationFresh(guard!, state)).toBe(false);
    setRevision(3);
    state.nodes = [{ id: 'source' }];
    expect(isCanvasDerivationFresh(guard!, state)).toBe(false);
    state.nodes = [{ id: 'placeholder' }];
    expect(isCanvasDerivationFresh(guard!, state)).toBe(false);
    state.nodes = [{ id: 'source' }, { id: 'placeholder' }];
    state.currentProjectId = 'project-b';
    expect(isCanvasDerivationFresh(guard!, state)).toBe(false);

    cancelCanvasDerivation(guard!);
  });

  it('cancels only operations from the project being switched away from', () => {
    const cleanupA = vi.fn();
    const cleanupB = vi.fn();
    const stateA = createState('project-a').state;
    const stateB = createState('project-b').state;
    const guardA = registerCanvasDerivation(stateA, 'source', { onCancel: cleanupA });
    const guardB = registerCanvasDerivation(stateB, 'source', { onCancel: cleanupB });

    cancelProjectCanvasDerivations('project-a');

    expect(cleanupA).toHaveBeenCalledTimes(1);
    expect(cleanupB).not.toHaveBeenCalled();
    expect(isCanvasDerivationFresh(guardA!, stateA)).toBe(false);
    expect(isCanvasDerivationFresh(guardB!, stateB)).toBe(true);
    completeCanvasDerivation(guardB!);
  });

  it('runs cleanup at most once', () => {
    const cleanup = vi.fn();
    const state = createState().state;
    const guard = registerCanvasDerivation(state, 'source', { onCancel: cleanup });

    cancelCanvasDerivation(guard!);
    cancelCanvasDerivation(guard!);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
