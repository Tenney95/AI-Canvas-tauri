import { renderToStaticMarkup } from 'react-dom/server';
import type { NodeProps } from '@xyflow/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import { CanvasNodeLodContext } from '../../src/hooks/useCanvasNodeLod';
import { createCanvasNodeLodRuntime } from '../../src/services/canvasNodeLodRuntime';

const state = vi.hoisted(() => ({ currentProjectId: 'project', activeNodeId: null as string | null, selectedNodeIds: [] as string[] }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: (selector: (s: typeof state) => unknown) => selector(state) }));
vi.mock('../../src/components/nodes/shared/CanvasNodeLodPreview', () => ({
  default: ({ width, height, video }: { width: number; height: number; video: boolean }) => (
    <div data-preview={video ? 'video' : 'image'} style={{ width, height }} />
  ),
}));
import CanvasNodeLodBoundary from '../../src/components/nodes/shared/CanvasNodeLodBoundary';

const data: BaseNodeData = { type: 'ai-image', label: 'Image', imageUrl: 'asset://image.png', nodeWidth: 280, nodeHeight: 210 };
const node = { id: 'node', positionAbsoluteX: 100, positionAbsoluteY: 200, selected: false, dragging: false } as NodeProps;
const mounted = vi.fn();
function HeavyNode() { mounted(); return <div data-heavy="mounted" />; }
function render(patch: Partial<BaseNodeData> = {}, props: Partial<NodeProps> = {}, zoom = 0.12, video = false) {
  return renderToStaticMarkup(
    <CanvasNodeLodContext.Provider value={createCanvasNodeLodRuntime(zoom)}>
      <CanvasNodeLodBoundary node={{ ...node, ...props }} data={{ ...data, ...patch }} video={video}>
        <HeavyNode />
      </CanvasNodeLodBoundary>
    </CanvasNodeLodContext.Provider>,
  );
}
beforeEach(() => { mounted.mockClear(); state.selectedNodeIds = []; state.activeNodeId = null; });

describe('canvas whole-node LOD boundary', () => {
  it('omits the complete business subtree at far zoom while retaining exact media dimensions', () => {
    const html = render();
    expect(mounted).not.toHaveBeenCalled();
    expect(html).toContain('data-canvas-node-detail="lite"');
    expect(html).toContain('width:280px;height:210px');
    expect(render({ videoUrl: 'asset://video.mp4', nodeHeight: 158 }, {}, 0.12, true)).toContain('data-preview="video"');
  });
  it.each([
    { status: 'loading' as const }, { status: 'error' as const }, { error: 'Failed' },
    { mattingMask: 'mask' }, { annotation: 'layer' }, { annotationLayer: { version: 1 } as BaseNodeData['annotationLayer'] },
    { imageUrl: undefined }, { nodeWidth: undefined }, { nodeHeight: 0 }, { nodeWidth: Number.NaN },
  ])('keeps unsafe-to-simplify data full: %j', (patch) => {
    expect(render(patch)).toContain('data-heavy="mounted"');
  });
  it('keeps selected, dragging, focused and actively edited nodes full at far zoom', () => {
    expect(render({}, { selected: true })).toContain('data-heavy');
    expect(render({}, { dragging: true })).toContain('data-heavy');
    state.activeNodeId = 'node';
    expect(render()).toContain('data-heavy');
    state.activeNodeId = null;
    state.selectedNodeIds = ['node'];
    expect(render()).toContain('data-heavy');
  });
  it('renders normal detail on a fresh ordinary-zoom canvas without a recovery delay', () => {
    expect(render({}, {}, 0.35)).toContain('data-heavy="mounted"');
    expect(mounted).toHaveBeenCalledTimes(1);
  });
});
