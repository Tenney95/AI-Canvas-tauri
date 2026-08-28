import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';

vi.mock('../../src/services/directorDeskRuntimeService', () => ({
  requiresDirectorDeskRuntime: () => true,
}));

import { useAppStore } from '../../src/store/useAppStore';

function createNode(
  id: string,
  type: BaseNodeData['type'],
  data: Partial<BaseNodeData> = {},
): Node<BaseNodeData> {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, type, role: 'source', ...data },
  } as Node<BaseNodeData>;
}

describe('director desk runtime prompt', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
  });

  it('requests one prompt when a director node is added', () => {
    useAppStore.getState().addNode(createNode('director-1', 'ai-director'));

    const state = useAppStore.getState();
    expect(state.directorDeskRuntimeRequest).toEqual({
      instanceId: 'director-1',
      openAfterInstall: true,
    });
    expect(state.nodes[0]?.data).toMatchObject({
      directorRuntimeKind: 'lightweight-web',
      directorInstanceId: 'director-1',
      directorStatus: 'idle',
      status: 'idle',
    });
  });

  it('does not request a prompt when project nodes are restored', () => {
    useAppStore.getState().setNodes([createNode('director-1', 'ai-director')]);

    const state = useAppStore.getState();
    expect(state.directorDeskRuntimeRequest).toBeNull();
    expect(state.nodes[0]?.data.directorRuntimeKind).toBeUndefined();
    expect(state.nodes[0]?.data.directorInstanceId).toBeUndefined();
  });

  it('covers the node-with-edge creation path and ignores ordinary nodes', () => {
    const edge: Edge = { id: 'edge-1', source: 'source-1', target: 'director-2' };
    useAppStore.getState().addNode(createNode('text-1', 'source-text'));
    expect(useAppStore.getState().directorDeskRuntimeRequest).toBeNull();

    useAppStore.getState().addNodeWithEdge(createNode('director-2', 'ai-director'), edge);
    expect(useAppStore.getState().directorDeskRuntimeRequest?.instanceId).toBe('director-2');
  });

  it('prompts once for the first lightweight runtime in a batch', () => {
    useAppStore.getState().addNodes([
      createNode('director-blender', 'ai-director', { directorRuntimeKind: 'blender' }),
      createNode('director-web', 'ai-director'),
      createNode('text-1', 'source-text'),
    ]);

    expect(useAppStore.getState().directorDeskRuntimeRequest).toEqual({
      instanceId: 'director-web',
      openAfterInstall: true,
    });
    expect(useAppStore.getState().nodes.map((node) => node.data.directorRuntimeKind)).toEqual([
      'blender',
      'lightweight-web',
      undefined,
    ]);
  });

  it('does not request the web installer for Blender or transient copy insertions', () => {
    useAppStore.getState().addNode(createNode('director-blender', 'ai-director', {
      directorRuntimeKind: 'blender',
    }));
    expect(useAppStore.getState().directorDeskRuntimeRequest).toBeNull();

    useAppStore.getState().addNodeTransient(createNode('director-copy', 'ai-director', {
      directorRuntimeKind: 'lightweight-web',
      directorInstanceId: 'source-director',
    }));
    expect(useAppStore.getState().directorDeskRuntimeRequest).toBeNull();
    expect(useAppStore.getState().nodes.at(-1)?.data).toMatchObject({
      directorRuntimeKind: 'lightweight-web',
      directorInstanceId: 'director-copy',
      directorStatus: 'idle',
    });
  });
});
