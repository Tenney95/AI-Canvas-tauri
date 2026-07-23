import { describe, expect, it, vi } from 'vitest';
import {
  cancelCanvasDerivation,
  cancelProjectCanvasDerivations,
  completeCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
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
