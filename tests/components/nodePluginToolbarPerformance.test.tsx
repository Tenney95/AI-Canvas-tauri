import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ToolbarState = { nodes: Node<BaseNodeData>[]; installedPlugins: [] };
const driver = vi.hoisted(() => ({
  state: { nodes: [], installedPlugins: [] } as ToolbarState,
  selectors: [] as Array<(state: ToolbarState) => unknown>,
  availableTools: vi.fn(() => []),
}));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T) => [initial, vi.fn()],
  useMemo: <T,>(factory: () => T) => factory(),
  useCallback: <T,>(callback: T) => callback,
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: <T,>(selector: (state: ToolbarState) => T) => {
    driver.selectors.push(selector);
    return selector(driver.state);
  },
}));
vi.mock('../../src/services/plugins/pluginRuntime', () => ({
  getAvailableNodePluginTools: driver.availableTools,
}));
vi.mock('../../src/components/nodes/shared/toolbar/NodePluginToolDialog', () => ({
  default: () => null,
}));
vi.mock('../../src/components/nodes/shared/toolbar/toolbarRegistry', () => ({
  getPluginToolbarButtonKey: () => 'plugin-tool',
}));

import { useNodePluginToolbar as renderPluginToolbar } from '../../src/components/nodes/shared/toolbar/NodePluginToolbarButtons';
import { syncCanvasNodeIndex } from '../../src/utils/canvasRenderProjection';

function node(id: string, type: BaseNodeData['type'] = 'ai-image'): Node<BaseNodeData> {
  return { id, type, position: { x: 0, y: 0 }, data: { type } as BaseNodeData };
}

beforeEach(() => {
  driver.state = { nodes: [], installedPlugins: [] };
  driver.selectors = [];
  driver.availableTools.mockClear();
  syncCanvasNodeIndex([]);
});

describe('node plugin toolbar subscriptions', () => {
  it('updates plugin availability when the node changes type, disappears, or the project changes', () => {
    driver.state.nodes = [node('source')];
    renderPluginToolbar({ nodeId: 'source' });
    expect(driver.availableTools).toHaveBeenLastCalledWith([], 'ai-image', 'node-toolbar');

    driver.state.nodes = [node('source', 'ai-video')];
    renderPluginToolbar({ nodeId: 'source' });
    expect(driver.availableTools).toHaveBeenLastCalledWith([], 'ai-video', 'node-toolbar');

    driver.state.nodes = [];
    renderPluginToolbar({ nodeId: 'source' });
    expect(driver.availableTools).toHaveBeenLastCalledWith([], undefined, 'node-toolbar');

    driver.state.nodes = [node('source', 'ai-text')];
    renderPluginToolbar({ nodeId: 'source' });
    expect(driver.availableTools).toHaveBeenLastCalledWith([], 'ai-text', 'node-toolbar');
  });

  it('shares one linear node-index update across a thousand mounted toolbars', () => {
    const count = 1000;
    let idReads = 0;
    const nodes = Array.from({ length: count }, (_, index) => {
      const value = node(`node-${index}`);
      Object.defineProperty(value, 'id', {
        enumerable: true,
        get: () => { idReads += 1; return `node-${index}`; },
      });
      return value;
    });
    driver.state.nodes = nodes;
    for (let index = 0; index < count; index += 1) {
      renderPluginToolbar({ nodeId: `node-${index}` });
    }
    expect(idReads).toBeLessThan(count * 3);

    const moved = [...nodes];
    moved[500] = { ...node('node-500'), position: { x: 10, y: 20 } };
    driver.state.nodes = moved;
    idReads = 0;
    for (const selector of driver.selectors) selector(driver.state);
    expect(idReads).toBeLessThan(count * 6);
  });
});
