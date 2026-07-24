import type { Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { selectNodeDisplayIds } from '../../src/components/chat/ChatReferenceText';
import type { AppState } from '../../src/store/useAppStore';
import type { BaseNodeData } from '../../src/types';

function makeNode(
  id: string,
  displayId: number | undefined,
  overrides: Partial<Node<BaseNodeData>> = {},
): Node<BaseNodeData> {
  return {
    id,
    type: 'ai-text',
    position: { x: 0, y: 0 },
    data: { type: 'ai-text', label: id, displayId },
    ...overrides,
  } as Node<BaseNodeData>;
}

function stateWithNodes(nodes: Node<BaseNodeData>[]): Pick<AppState, 'nodes'> {
  return { nodes };
}

describe('selectNodeDisplayIds', () => {
  it('keeps the derived map stable for transient canvas and node-content updates', () => {
    const firstNodes = [makeNode('node-a', 1), makeNode('node-b', 2)];
    const first = selectNodeDisplayIds(stateWithNodes(firstNodes));

    const movedNodes = [
      { ...firstNodes[0], position: { x: 320, y: 180 }, selected: true },
      firstNodes[1],
    ];
    const moved = selectNodeDisplayIds(stateWithNodes(movedNodes));

    const contentChangedNodes = [
      { ...movedNodes[0], data: { ...movedNodes[0].data, output: 'updated' } },
      movedNodes[1],
    ];
    const contentChanged = selectNodeDisplayIds(stateWithNodes(contentChangedNodes));

    expect(moved).toBe(first);
    expect(contentChanged).toBe(first);
    expect(contentChanged.get('node-a')).toBe(1);
  });

  it('rebuilds the map when display ids or node membership change', () => {
    const initial = selectNodeDisplayIds(stateWithNodes([
      makeNode('node-a', 1),
      makeNode('node-b', undefined),
    ]));

    const renumbered = selectNodeDisplayIds(stateWithNodes([
      makeNode('node-a', 7),
      makeNode('node-b', undefined),
    ]));
    const replaced = selectNodeDisplayIds(stateWithNodes([
      makeNode('node-a', 7),
      makeNode('node-c', undefined),
    ]));
    const removed = selectNodeDisplayIds(stateWithNodes([
      makeNode('node-a', 7),
    ]));

    expect(renumbered).not.toBe(initial);
    expect(renumbered.get('node-a')).toBe(7);
    expect(replaced).not.toBe(renumbered);
    expect(replaced.has('node-b')).toBe(false);
    expect(replaced.has('node-c')).toBe(true);
    expect(removed).not.toBe(replaced);
    expect(removed.size).toBe(1);
  });
});
