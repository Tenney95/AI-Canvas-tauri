import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';

vi.mock('../../src/services/directorDeskRuntimeService', () => ({
  requiresDirectorDeskRuntime: () => true,
}));

import { useAppStore } from '../../src/store/useAppStore';

function createNode(id: string, type: BaseNodeData['type']): Node<BaseNodeData> {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, type, role: 'source' },
  } as Node<BaseNodeData>;
}

describe('director desk runtime prompt', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
  });

  it('requests one prompt when a director node is added', () => {
    useAppStore.getState().addNode(createNode('director-1', 'ai-director'));

    expect(useAppStore.getState().directorDeskRuntimeRequest).toEqual({
      instanceId: 'director-1',
      openAfterInstall: true,
    });
  });

  it('does not request a prompt when project nodes are restored', () => {
    useAppStore.getState().setNodes([createNode('director-1', 'ai-director')]);

    expect(useAppStore.getState().directorDeskRuntimeRequest).toBeNull();
  });

  it('covers the node-with-edge creation path and ignores ordinary nodes', () => {
    const edge: Edge = { id: 'edge-1', source: 'source-1', target: 'director-2' };
    useAppStore.getState().addNode(createNode('text-1', 'source-text'));
    expect(useAppStore.getState().directorDeskRuntimeRequest).toBeNull();

    useAppStore.getState().addNodeWithEdge(createNode('director-2', 'ai-director'), edge);
    expect(useAppStore.getState().directorDeskRuntimeRequest?.instanceId).toBe('director-2');
  });
});
