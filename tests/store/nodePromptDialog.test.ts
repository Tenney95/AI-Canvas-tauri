import type { EffectCallback } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { useAppStore } from '../../src/store/useAppStore';
import type { BaseNodeData } from '../../src/types';
import { WSAGENT_NODE_ID, WSAGENT_PLUGIN_ID } from '../../src/types/wsagentShared';

const hooks = vi.hoisted(() => ({ cleanup: undefined as void | (() => void) }));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (effect: EffectCallback) => { hooks.cleanup = effect(); },
}));

const interop: Node<BaseNodeData> = {
  id: 'interop', type: 'plugin-node', position: { x: 0, y: 0 },
  data: { label: '互联', type: 'plugin-node', pluginId: WSAGENT_PLUGIN_ID, pluginNodeId: WSAGENT_NODE_ID },
};

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
});

it('clears the built-in prompt when the WSAGENT node is selected for it', () => {
  const otherPlugin: Node<BaseNodeData> = {
    ...interop, id: 'other-plugin', data: { ...interop.data, pluginId: 'test.other-plugin' },
  };
  useAppStore.setState({ nodes: [interop, otherPlugin] });

  for (const position of [undefined, { x: 100, y: 200 }]) {
    const { openNodeDialog, setPendingPresetAction } = useAppStore.getState();
    openNodeDialog(otherPlugin.id, { x: 10, y: 20 });
    expect(useAppStore.getState().activeNodeId).toBe(otherPlugin.id);
    setPendingPresetAction({ nodeId: otherPlugin.id, filledPrompt: '原提示词', shouldTrigger: false });

    openNodeDialog(interop.id, position);
    expect(useAppStore.getState()).toMatchObject({ activeNodeId: null, dialogPosition: null, pendingPresetAction: null });
  }
});

it('allows Space on the WSAGENT button and keeps the image prompt shortcut', () => {
  const image: Node<BaseNodeData> = {
    id: 'image', type: 'ai-image', position: { x: 0, y: 0 },
    data: { label: '图像', type: 'ai-image' },
  };
  useAppStore.setState({ nodes: [interop, image], currentProjectId: 'project-interop', projectLoadStatus: 'ready' });
  const document = Object.assign(new EventTarget(), { querySelector: vi.fn(() => null) });
  vi.stubGlobal('document', document);
  useKeyboardShortcuts();

  const pressSpace = (nodeIds: string[], onButton = false) => {
    useAppStore.setState({ selectedNodeIds: nodeIds });
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: ' ', code: 'Space' });
    if (onButton) Object.defineProperty(event, 'target', { value: { tagName: 'BUTTON' } });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  };

  try {
    expect(pressSpace([interop.id], true)).toBe(false);
    expect(useAppStore.getState().activeNodeId).toBeNull();
    expect(pressSpace([interop.id, image.id])).toBe(false);
    expect(useAppStore.getState().activeNodeId).toBeNull();
    expect(pressSpace([image.id])).toBe(true);
    expect(useAppStore.getState().activeNodeId).toBe(image.id);
  } finally {
    hooks.cleanup?.();
  }
});
