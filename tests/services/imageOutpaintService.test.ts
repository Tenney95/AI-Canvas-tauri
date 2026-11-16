import type { Node } from '@xyflow/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import type { OutpaintSettings } from '../../src/types/media';

const mocks = vi.hoisted(() => ({
  state: { currentProjectId: 'project', nodes: [] as Node<BaseNodeData>[],
    getCurrentRevision: () => 0, addNode: vi.fn(), showToast: vi.fn() },
  generate: vi.fn(),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.state } }));
vi.mock('../../src/services/generationService', () => ({ executeGeneration: mocks.generate }));
vi.mock('../../src/store/store.utils', () => ({
  generateId: () => 'expanded',
  derivedNodePlacement: (node: Node<BaseNodeData>) => ({ position: { x: node.position.x + 320, y: node.position.y }, parentId: node.parentId }),
}));
vi.mock('../../src/i18n', () => ({ t: (text: string, args?: Record<string, string>) =>
  text.replace(/\{([^}]+)\}/g, (_, key: string) => args?.[key] ?? key) }));

import { startImageOutpaint } from '../../src/services/imageOutpaintService';
import { registerCanvasDerivation } from '../../src/services/canvasDerivationGuard';

const settings: OutpaintSettings = { size: '16:9', width: 1600, height: 900,
  model: 'comfyui/workflow', provider: 'comfyui', workflowId: 'expand-workflow',
  workflowInputs: { 'comfy-param::2::steps': '30' }, prompt: 'extend the garden' };
const source = (): Node<BaseNodeData> => ({ id: 'source', type: 'ai-image', parentId: 'group', position: { x: 10, y: 20 },
  data: { type: 'ai-image', label: 'Original', role: 'source', status: 'success', imageUrl: 'original.png',
    filePath: 'original.png', mattingMask: 'original-mask.png', nodeWidth: 280 } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.currentProjectId = 'project'; mocks.state.nodes = [source()];
  mocks.state.addNode.mockImplementation((node: Node<BaseNodeData>) => { mocks.state.nodes = [...mocks.state.nodes, node]; });
  mocks.generate.mockReset().mockResolvedValue({ success: true });
});

describe('single-node outpainting', () => {
  it('creates one generator with an independent input and writes the generated result only there', async () => {
    const original = structuredClone(mocks.state.nodes[0]);
    mocks.generate.mockImplementation(async (nodeId: string) => {
      const result = mocks.state.nodes.find((node) => node.id === nodeId)!;
      result.data = { ...result.data, imageUrl: 'expanded.png', status: 'success' };
      return { success: true };
    });
    expect(await startImageOutpaint('source', 'original.png', 'data:image/png;base64,padded', settings)).toEqual({ success: true });
    expect(mocks.state.addNode).toHaveBeenCalledOnce();
    expect(mocks.generate).toHaveBeenCalledExactlyOnceWith('node-expanded');
    expect(mocks.state.nodes).toHaveLength(2);
    expect(mocks.state.nodes[0]).toEqual(original);
    expect(mocks.state.nodes[1]).toMatchObject({ parentId: 'group', data: {
      role: 'generator', imageUrl: 'expanded.png', provider: 'comfyui', workflowId: settings.workflowId,
      workflowInputs: settings.workflowInputs, aspectRatio: '16:9', batchCount: 1,
      outpaintInput: { url: 'data:image/png;base64,padded', width: 1600, height: 900 },
    } });
    expect(mocks.state.nodes[1].data.prompt).toContain(settings.prompt);
    expect(mocks.state.nodes[1].data.prompt).not.toContain('@{source:');
    expect(mocks.state.nodes[1].data.mattingMask).toBeUndefined();
    expect(mocks.state.nodes[1].data.filePath).toBeUndefined();
  });

  it.each(['changed-image', 'removed-source', 'changed-project'] as const)('does not generate from %s', async (failure) => {
    if (failure === 'changed-image') mocks.state.nodes[0].data.imageUrl = 'new.png';
    if (failure === 'removed-source') mocks.state.nodes = [];
    if (failure === 'changed-project') mocks.state.currentProjectId = '';
    expect((await startImageOutpaint('source', 'original.png', 'padded', settings)).success).toBe(false);
    expect(mocks.state.addNode).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('retains the input and result node when the shared runner returns an unknown submission', async () => {
    const pending = { success: false, recovery: { state: 'unknown' } };
    mocks.generate.mockResolvedValue(pending);
    expect(await startImageOutpaint('source', 'original.png', 'padded', settings)).toBe(pending);
    expect(mocks.state.nodes).toHaveLength(2);
    expect(mocks.state.nodes[1].data.outpaintInput?.url).toBe('padded');
    expect(mocks.generate).toHaveBeenCalledOnce();
  });

  it('rejects an editor opened in another project even when the new project has the same node ID and image', async () => {
    const opened = registerCanvasDerivation(mocks.state, 'source')!;
    mocks.state.currentProjectId = 'different-project';
    expect((await startImageOutpaint('source', 'original.png', 'padded', settings, opened)).success).toBe(false);
    expect(mocks.state.addNode).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
