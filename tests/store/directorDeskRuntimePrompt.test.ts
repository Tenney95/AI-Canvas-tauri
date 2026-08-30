import { beforeEach, describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';

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

  it('does not request a download when a director node is added', () => {
    useAppStore.getState().addNode(createNode('director-1', 'ai-director'));

    const state = useAppStore.getState();
    expect(state.directorDeskRuntimeRequest).toBeNull();
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

  it('keeps node-with-edge creation silent for director and ordinary nodes', () => {
    const edge: Edge = { id: 'edge-1', source: 'source-1', target: 'director-2' };
    useAppStore.getState().addNode(createNode('text-1', 'source-text'));
    expect(useAppStore.getState().directorDeskRuntimeRequest).toBeNull();

    useAppStore.getState().addNodeWithEdge(createNode('director-2', 'ai-director'), edge);
    expect(useAppStore.getState().directorDeskRuntimeRequest).toBeNull();
  });

  it('keeps batch creation silent while preserving runtime normalization', () => {
    useAppStore.getState().addNodes([
      createNode('director-blender', 'ai-director', { directorRuntimeKind: 'blender' }),
      createNode('director-web', 'ai-director'),
      createNode('text-1', 'source-text'),
    ]);

    expect(useAppStore.getState().directorDeskRuntimeRequest).toBeNull();
    expect(useAppStore.getState().nodes.map((node) => node.data.directorRuntimeKind)).toEqual([
      'blender',
      'lightweight-web',
      undefined,
    ]);
  });

  it('keeps batch-with-edges creation silent', () => {
    const edge: Edge = { id: 'edge-2', source: 'source-2', target: 'director-3' };
    useAppStore.getState().addNodesWithEdges(
      [
        createNode('source-2', 'source-text'),
        createNode('director-3', 'ai-director'),
      ],
      [edge],
    );

    expect(useAppStore.getState().directorDeskRuntimeRequest).toBeNull();
    expect(useAppStore.getState().nodes.at(-1)?.data).toMatchObject({
      directorRuntimeKind: 'lightweight-web',
      directorInstanceId: 'director-3',
      directorStatus: 'idle',
    });
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

  it('still accepts an explicit download request from the open action', () => {
    useAppStore.getState().requestDirectorDeskRuntime('director-manual', true);

    expect(useAppStore.getState().directorDeskRuntimeRequest).toEqual({
      instanceId: 'director-manual',
      openAfterInstall: true,
    });
  });
});
