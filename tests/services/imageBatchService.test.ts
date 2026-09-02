import type { Node } from '@xyflow/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';

interface TestStore {
  nodes: Node<BaseNodeData>[];
  currentProjectId: string | null;
  commitToHistory: ReturnType<typeof vi.fn>;
  addNodesTransient: ReturnType<typeof vi.fn>;
  updateNodeDataTransient: ReturnType<typeof vi.fn>;
  recordOutputHistory: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
}

let store: TestStore;
let generatedId = 0;

const persistMediaUrlToProjectData = vi.fn();

vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: {
    getState: () => store,
  },
}));

vi.mock('../../src/store/store.utils', () => ({
  generateId: () => `generated-${++generatedId}`,
}));

vi.mock('../../src/services/fileService', () => ({
  persistMediaUrlToProjectData,
}));

function createStore(): TestStore {
  const sourceNode: Node<BaseNodeData> = {
    id: 'source',
    type: 'ai-image',
    position: { x: 100, y: 200 },
    data: {
      type: 'ai-image',
      label: '原图节点',
      prompt: 'a cat',
      model: 'image-model',
      provider: 'general',
      batchCount: 4,
      nodeWidth: 280,
      nodeHeight: 220,
      status: 'idle',
      imageUrl: 'asset://old-image',
    },
  };

  const nextStore = {
    nodes: [sourceNode],
    currentProjectId: 'project-a',
    commitToHistory: vi.fn(),
    addNodesTransient: vi.fn((nodes: Node<BaseNodeData>[]) => {
      nextStore.nodes = [...nextStore.nodes, ...nodes];
    }),
    updateNodeDataTransient: vi.fn((nodeId: string, patch: Partial<BaseNodeData>) => {
      nextStore.nodes = nextStore.nodes.map((node) => node.id === nodeId
        ? { ...node, data: { ...node.data, ...patch } }
        : node);
    }),
    recordOutputHistory: vi.fn().mockResolvedValue(undefined),
    showToast: vi.fn(),
  } satisfies TestStore;
  return nextStore;
}

beforeEach(() => {
  generatedId = 0;
  persistMediaUrlToProjectData.mockImplementation(async (url: string) => ({
    mediaUrl: url,
    sourceUrl: url,
  }));
  store = createStore();
});

describe('imageBatchService', () => {
  it('数量 4 时保留原节点，并立即在右侧创建 3 个加载节点', async () => {
    const { prepareImageBatchNodes } = await import('../../src/services/imageBatchService');

    const prepared = prepareImageBatchNodes({
      nodeId: 'source',
      count: 4,
      projectId: 'project-a',
    });

    expect(prepared.nodeIds).toHaveLength(4);
    expect(prepared.nodeIds[0]).toBe('source');
    expect(store.nodes).toHaveLength(4);
    expect(store.commitToHistory).toHaveBeenCalledTimes(1);
    expect(store.nodes.map((node) => node.data.status)).toEqual([
      'loading',
      'loading',
      'loading',
      'loading',
    ]);
    expect(store.nodes.slice(1).map((node) => node.position)).toEqual([
      { x: 420, y: 200 },
      { x: 740, y: 200 },
      { x: 1060, y: 200 },
    ]);
    expect(store.nodes.slice(1).every((node) => node.position.x > 100)).toBe(true);
    expect(store.nodes.slice(1).map((node) => node.data.batchCount)).toEqual([1, 1, 1]);
    expect(store.nodes.slice(1).map((node) => node.data.imageUrl)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('把成功结果依次回填，并将缺少结果的加载节点标记为失败', async () => {
    const { applyImageBatchResults, prepareImageBatchNodes } = await import('../../src/services/imageBatchService');
    const prepared = prepareImageBatchNodes({
      nodeId: 'source',
      count: 4,
      projectId: 'project-a',
    });

    await applyImageBatchResults({
      nodeId: 'source',
      targetNodeIds: prepared.nodeIds,
      batch: {
        requestedCount: 4,
        results: [
          { url: 'https://example.com/1.png', width: 1024, height: 1024 },
          { url: 'https://example.com/2.png', width: 1024, height: 1024 },
        ],
        failedCount: 2,
      },
      projectId: 'project-a',
      prompt: 'a cat',
      imageSize: '1K',
      aspectRatio: '1:1',
    });

    expect(store.nodes.map((node) => node.data.status)).toEqual([
      'success',
      'success',
      'error',
      'error',
    ]);
    expect(store.nodes[0].data.imageUrl).toBe('https://example.com/1.png');
    expect(store.nodes[1].data.imageUrl).toBe('https://example.com/2.png');
    expect(store.nodes[2].data.error).toContain('未返回结果');
    expect(store.recordOutputHistory).toHaveBeenCalledTimes(2);
    expect(store.showToast).toHaveBeenCalledWith('批量生成完成：成功 2/4 张', 'error');
  });

  it('stores inline batch results as local project references only', async () => {
    const { applyImageBatchResults } = await import('../../src/services/imageBatchService');
    const inline = 'data:image/png;base64,AQID';
    persistMediaUrlToProjectData.mockResolvedValueOnce({
      filePath: '/project/data/原图节点-1.png',
      assetUrl: 'asset:///project/data/原图节点-1.png',
      mediaUrl: 'asset:///project/data/原图节点-1.png',
      sourceUrl: 'asset:///project/data/原图节点-1.png',
    });

    await applyImageBatchResults({
      nodeId: 'source',
      targetNodeIds: ['source'],
      batch: {
        requestedCount: 1,
        failedCount: 0,
        results: [{ url: inline, width: 10, height: 10 }],
      },
      projectId: 'project-a',
      prompt: 'a cat',
      imageSize: '2K',
      aspectRatio: '1:1',
    });

    expect(JSON.stringify(store.nodes[0].data)).not.toContain('data:image');
    expect(store.nodes[0].data).toMatchObject({
      imageUrl: 'asset:///project/data/原图节点-1.png',
      sourceUrl: 'asset:///project/data/原图节点-1.png',
      thumbnailUrl: 'asset:///project/data/原图节点-1.png',
      output: 'asset:///project/data/原图节点-1.png',
      filePath: '/project/data/原图节点-1.png',
    });
    expect(JSON.stringify(store.recordOutputHistory.mock.calls[0][1])).not.toContain('data:image');
  });
});
