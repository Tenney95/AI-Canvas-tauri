/**
 * canvasGridCreation — 回归测试：canvas grid creation。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import { useAppStore } from '../../src/store/useAppStore';
import { useCanvasContextMenu } from '../../src/hooks/useCanvasContextMenu';
import StoryboardNode from '../../src/components/nodes/StoryboardNode';

const fileMocks = vi.hoisted(() => ({
  deleteNodeFiles: vi.fn<typeof import('../../src/services/fileService')['deleteNodeFiles']>(async () => undefined),
}));
vi.mock('../../src/services/fileService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fileService')>(),
  deleteNodeFiles: fileMocks.deleteNodeFiles,
}));
vi.mock('../../src/utils/nodeAnimations', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/nodeAnimations')>(),
  playNodeExit: vi.fn(async () => undefined),
}));

vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: () => null,
  useReactFlow: () => ({ screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }) }),
}));

function contextMenu() {
  let menu: ReturnType<typeof useCanvasContextMenu> | undefined;
  function Harness() {
    menu = useCanvasContextMenu();
    return null;
  }
  renderToStaticMarkup(<Harness />);
  return menu!;
}

function createFromContextMenu(rows: number, cols: number) {
  contextMenu().addNodeAtCtxPos('ai-storyboard', '宫格分镜', 'source', { rows, cols });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project-grid', nodes: [], edges: [] });
});

describe('canvas grid creation', () => {
  it('右键删除走统一回收流程，保留其他节点的共享文件及不可变产物', async () => {
    const mediaNode = (id: string, filePath: string, artifactId?: string): Node<BaseNodeData> => ({
      id, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: id, status: 'success', filePath, artifactId },
    });
    const removed = mediaNode('removed', 'project/shared.png');
    const artifact = mediaNode('artifact', 'project/artifact.png', 'immutable-result');
    const living = mediaNode('living', 'project/shared.png');
    useAppStore.setState({ nodes: [removed, artifact, living], selectedNodeIds: [removed.id, artifact.id] });

    contextMenu().handleDelete();

    expect(fileMocks.deleteNodeFiles).toHaveBeenCalledOnce();
    const [candidates, keepPaths, projectId, groups, context] = fileMocks.deleteNodeFiles.mock.calls[0];
    expect(candidates).toEqual([removed.data]);
    expect(keepPaths).toEqual(new Set(['project/shared.png', 'project/artifact.png']));
    expect(projectId).toBe('project-grid');
    expect(groups).toEqual([]);
    expect(context).toEqual(expect.objectContaining({
      deletedNodeIds: [removed.id, artifact.id], getLiveKeepPaths: expect.any(Function),
    }));

    await Promise.resolve();
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual([living.id]);
    useAppStore.setState({ nodes: [living, mediaNode('new-reference', 'project/late-reference.png')] });
    expect(context!.getLiveKeepPaths()).toEqual(new Set(['project/shared.png', 'project/late-reference.png']));
  });

  it('creates a 4×9 blank storyboard whose cells accept image drops', () => {
    createFromContextMenu(4, 9);
    const storyboard = useAppStore.getState().nodes[0];
    expect(storyboard).toMatchObject({
      type: 'ai-storyboard',
      data: { role: 'source', storyboardRows: 4, storyboardCols: 9 },
    });
    expect(storyboard.data.storyboardExtracted).toHaveLength(36);
    expect(storyboard.data.storyboardExtracted?.every(Boolean)).toBe(true);
    const markup = renderToStaticMarkup(<StoryboardNode id={storyboard.id} data={storyboard.data} />);
    expect(markup.match(/data-sb-cell-idx=/g)).toHaveLength(36);
    expect(markup).not.toContain('无图像');

    const image: Node<BaseNodeData> = {
      id: 'source-image',
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: '来源', status: 'success', imageUrl: 'asset://cell.png' },
    };
    useAppStore.setState({ nodes: [storyboard, image] });
    useAppStore.getState().fillStoryboardCell(storyboard.id, 8, image.id);
    const updated = useAppStore.getState().nodes[0];
    expect(updated.data.storyboardOverrides?.[8]?.url).toBe('asset://cell.png');
    expect(updated.data.storyboardExtracted?.[8]).toBe(false);
    expect(useAppStore.getState().nodes).toHaveLength(1);
  });

  it('rejects custom dimensions outside the supported range', () => {
    createFromContextMenu(21, 2);
    expect(useAppStore.getState().nodes).toHaveLength(0);
  });

  it.each(['source', 'generator'] as const)('never opens the AI dialog for a %s storyboard, with or without a click anchor', (role) => {
    createFromContextMenu(3, 3);
    const storyboard = useAppStore.getState().nodes[0];
    useAppStore.getState().updateNodeDataTransient(storyboard.id, { role });
    for (const position of [undefined, { x: 200, y: 400 }]) {
      useAppStore.setState({
        activeNodeId: 'previous', dialogPosition: { x: 10, y: 20 },
        pendingPresetAction: { nodeId: 'previous', filledPrompt: '保留素材', shouldTrigger: false },
      });
      useAppStore.getState().openNodeDialog(storyboard.id, position);
      expect(useAppStore.getState()).toMatchObject({ activeNodeId: null, dialogPosition: null, pendingPresetAction: null });
    }
    expect(useAppStore.getState().nodes[0].data.storyboardRows).toBe(3);
    expect(useAppStore.getState().nodes[0].data.storyboardCols).toBe(3);
  });

  it('continues to open ordinary image node dialogs', () => {
    const image: Node<BaseNodeData> = {
      id: 'image', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: '图像', status: 'idle' },
    };
    useAppStore.setState({ nodes: [image] });
    useAppStore.getState().openNodeDialog(image.id, { x: 100, y: 200 });
    expect(useAppStore.getState()).toMatchObject({ activeNodeId: image.id, dialogPosition: { x: 100, y: 200 } });
    useAppStore.getState().closeNodeDialog();
    useAppStore.getState().openNodeDialog(image.id);
    expect(useAppStore.getState()).toMatchObject({ activeNodeId: image.id, dialogPosition: null });
  });
});
