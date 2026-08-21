import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';

vi.mock('../../src/services/fileService', () => ({
  setBaseDataDir: vi.fn(),
  syncAuthorizedDirectories: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/pollManager', () => ({
  cancelNodePolling: vi.fn(),
  clearProjectTasks: vi.fn(),
  resumePendingTasks: vi.fn(async () => undefined),
}));

import { useAppStore } from '../../src/store/useAppStore';

function imageNode(): Node<BaseNodeData> {
  return {
    id: 'image-node',
    type: 'ai-image',
    position: { x: 0, y: 0 },
    data: {
      label: '图片',
      type: 'ai-image',
      status: 'success',
      imageUrl: 'asset://data/图片.png',
      filePath: '/project/data/图片.png',
      assetId: 'asset-first',
      relativePath: '图片.png',
    },
  };
}

const nodeData = () => useAppStore.getState().nodes[0].data;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ nodes: [imageNode()] });
});

describe('节点换文件时作废旧的资产身份', () => {
  it('同一节点再次生成后不再残留上一张图的 assetId / relativePath', () => {
    useAppStore.getState().updateNodeData('image-node', {
      imageUrl: 'asset://data/图片 (1).png',
      filePath: '/project/data/图片 (1).png',
      status: 'success',
    });

    expect(nodeData()).toMatchObject({
      filePath: '/project/data/图片 (1).png',
      imageUrl: 'asset://data/图片 (1).png',
    });
    expect(nodeData().assetId).toBeUndefined();
    expect(nodeData().relativePath).toBeUndefined();
  });

  it('生成失败没落盘时同样清掉旧身份，避免节点退回上一张图', () => {
    useAppStore.getState().updateNodeDataTransient('image-node', {
      imageUrl: 'https://remote.example/new.png',
      filePath: undefined,
    });

    expect(nodeData().assetId).toBeUndefined();
    expect(nodeData().relativePath).toBeUndefined();
  });

  it('不动 filePath 的普通更新保留资产身份', () => {
    useAppStore.getState().updateNodeData('image-node', { label: '改个名' });

    expect(nodeData()).toMatchObject({
      label: '改个名',
      assetId: 'asset-first',
      relativePath: '图片.png',
    });
  });

  it('调用方自己给了新身份时以调用方为准', () => {
    useAppStore.getState().updateNodeData('image-node', {
      filePath: '/project/data/分组/图片.png',
      relativePath: '分组/图片.png',
    });

    expect(nodeData()).toMatchObject({
      assetId: 'asset-first',
      relativePath: '分组/图片.png',
    });
  });
});
