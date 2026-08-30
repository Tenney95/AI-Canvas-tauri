import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';

/** 内存文件系统：路径 → { size, mtimeMs } */
const files = new Map<string, { size: number; mtimeMs: number }>();
let clock = 1_000;

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mocks.exists,
  stat: mocks.stat,
}));

vi.mock('../../src/services/fs/core', () => ({
  getAssetUrlFromPath: vi.fn(async (path: string) => `asset://${path}`),
  getProjectDataDir: vi.fn(async () => '/p'),
  joinPath: (...parts: string[]) => parts.join('/'),
  stripVerbatimPrefix: (path: string) => path,
}));

vi.mock('../../src/services/fs/assetLibrary', () => ({
  walkDirectoryFiles: vi.fn(async () => [...files.keys()].map((path) => ({ path, size: files.get(path)!.size }))),
}));

vi.mock('../../src/services/fileService', async (importOriginal) => {
  // store.nodes 在删除节点前会调用 collectNodeFileReferences 统计仍被引用的文件，
  // 这里复用真实实现，避免 mock 落后于源码导致引用统计失真。
  const actual = await importOriginal<typeof import('../../src/services/fileService')>();
  return {
    setBaseDataDir: vi.fn(),
    syncAuthorizedDirectories: vi.fn(async () => undefined),
    collectNodeFileReferences: actual.collectNodeFileReferences,
  };
});

vi.mock('../../src/services/pollManager', () => ({
  cancelNodePolling: vi.fn(),
  clearProjectTasks: vi.fn(),
  resumePendingTasks: vi.fn(async () => undefined),
}));

import { useAppStore } from '../../src/store/useAppStore';
import { collectKeepPaths } from '../../src/store/store.nodes';
import { loadProjectData, saveProject } from '../../src/services/storageService';
import { saveProjectToDb } from '../../src/services/indexedDbService';

function writeFile(path: string, size = 100): void {
  files.set(path, { size, mtimeMs: clock++ });
}

function imageNode(id: string, label: string, filePath: string): Node<BaseNodeData> {
  return {
    id,
    type: 'ai-image',
    position: { x: 0, y: 0 },
    data: { label, type: 'ai-image', status: 'success', imageUrl: `asset://${filePath}`, filePath },
  };
}

/** 宫格节点：ImageNode 的宫格裁切直接沿用源图 filePath */
function gridNode(id: string, label: string, filePath: string): Node<BaseNodeData> {
  return {
    id,
    type: 'ai-storyboard',
    position: { x: 400, y: 0 },
    data: {
      label,
      type: 'ai-storyboard',
      status: 'success',
      imageUrl: `asset://${filePath}`,
      filePath,
      storyboardRows: 3,
      storyboardCols: 3,
    },
  };
}

async function roundTrip(projectId: string): Promise<Node<BaseNodeData>[]> {
  const state = useAppStore.getState();
  await saveProject({
    id: projectId,
    name: 'p',
    createdAt: 1,
    updatedAt: Date.now(),
    nodes: state.nodes,
    edges: [],
  });
  const loaded = await loadProjectData(projectId);
  const nodes = (loaded?.nodes ?? []) as Node<BaseNodeData>[];
  useAppStore.setState({ nodes });
  return nodes;
}

/** 模拟一次生成：写盘 + 走 store 的数据合并 */
function regenerate(nodeId: string, filePath: string): void {
  writeFile(filePath);
  useAppStore.getState().updateNodeData(nodeId, {
    imageUrl: `asset://${filePath}`,
    filePath,
    thumbnailUrl: 'https://remote/last.png',
    output: 'https://remote/last.png',
    status: 'success',
  });
}

const dataOf = (nodes: Node<BaseNodeData>[], id: string) => nodes.find((node) => node.id === id)!.data;

beforeEach(() => {
  files.clear();
  clock = 1_000;
  mocks.exists.mockImplementation(async (path: string) => files.has(path));
  mocks.stat.mockImplementation(async (path: string) => {
    const entry = files.get(path);
    if (!entry) throw new Error(`ENOENT ${path}`);
    return { size: entry.size, mtime: new Date(entry.mtimeMs) };
  });
  useAppStore.setState(useAppStore.getInitialState(), true);
});

describe('宫格节点与源图共用文件时的重新生成', () => {
  it('源图重新生成两次后仍然解析到最后一张', async () => {
    const projectId = `grid-${Date.now()}`;
    writeFile('/p/生成图像.png');
    useAppStore.setState({
      nodes: [
        imageNode('img', '生成图像', '/p/生成图像.png'),
        gridNode('grid', '生成图像 宫格3×3', '/p/生成图像.png'),
      ],
    });

    await roundTrip(projectId);

    regenerate('img', '/p/生成图像_1.png');
    let nodes = await roundTrip(projectId);
    expect(dataOf(nodes, 'img').filePath).toBe('/p/生成图像_1.png');
    expect(dataOf(nodes, 'grid').filePath).toBe('/p/生成图像.png');

    regenerate('img', '/p/生成图像_2.png');
    nodes = await roundTrip(projectId);
    expect(dataOf(nodes, 'img').filePath).toBe('/p/生成图像_2.png');
    expect(dataOf(nodes, 'grid').filePath).toBe('/p/生成图像.png');
  });

  it('宫格节点自身重新生成两次后不回退到上一张', async () => {
    const projectId = `grid-self-${Date.now()}`;
    writeFile('/p/宫格.png');
    useAppStore.setState({ nodes: [gridNode('grid', '宫格', '/p/宫格.png')] });

    await roundTrip(projectId);
    regenerate('grid', '/p/宫格_1.png');
    await roundTrip(projectId);
    regenerate('grid', '/p/宫格_2.png');
    const nodes = await roundTrip(projectId);
    expect(dataOf(nodes, 'grid').filePath).toBe('/p/宫格_2.png');
  });

  it('修好 0.8.13 之前存坏的记录：relativePath 停在旧图时按显示中的图恢复', async () => {
    const projectId = `legacy-${Date.now()}`;
    writeFile('/p/生成图像.png');
    writeFile('/p/生成图像_1.png');
    // 旧版本重新生成只换 imageUrl / filePath，落库时 filePath 被收敛掉，relativePath 停在上一张
    await saveProjectToDb({
      id: projectId,
      name: 'p',
      createdAt: 1,
      updatedAt: 2,
      nodes: [{
        id: 'img',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: {
          label: '生成图像',
          type: 'ai-image',
          status: 'success',
          imageUrl: 'http://asset.localhost/%2Fp%2F%E7%94%9F%E6%88%90%E5%9B%BE%E5%83%8F_1.png',
          assetId: 'asset-legacy',
          relativePath: '生成图像.png',
        },
      }],
      edges: [],
    });

    const loaded = await loadProjectData(projectId);
    const restored = (loaded?.nodes as Node<BaseNodeData>[])[0].data;
    expect(restored.filePath).toBe('/p/生成图像_1.png');
    expect(restored.label).toBe('生成图像');
  });

  it('删除其他节点时不回收宫格格子仍在显示的图', () => {
    const grid = gridNode('grid', '宫格', '/p/宫格.png');
    grid.data.storyboardOverrides = [{ url: 'asset:///p/格子.png', filePath: '/p/格子.png' }];
    const doomed = imageNode('doomed', '格子', '/p/格子.png');

    const keepPaths = collectKeepPaths([grid, doomed], new Set(['doomed']), []);

    expect(keepPaths.has('/p/格子.png')).toBe(true);
  });

  it('宫格格子被填图后重新生成源节点，格子仍指向自己的图', async () => {
    const projectId = `grid-cell-${Date.now()}`;
    writeFile('/p/宫格.png');
    writeFile('/p/格子.png');
    useAppStore.setState({
      nodes: [{
        ...gridNode('grid', '宫格', '/p/宫格.png'),
        data: {
          ...gridNode('grid', '宫格', '/p/宫格.png').data,
          storyboardExtracted: [true, false, false, false, false, false, false, false, false],
          storyboardOverrides: [{ url: 'asset:///p/格子.png', filePath: '/p/格子.png' }, null, null, null, null, null, null, null, null],
        } as BaseNodeData,
      }],
    });

    await roundTrip(projectId);
    regenerate('grid', '/p/宫格_1.png');
    const nodes = await roundTrip(projectId);
    expect(dataOf(nodes, 'grid').filePath).toBe('/p/宫格_1.png');
    expect(dataOf(nodes, 'grid').storyboardOverrides?.[0]?.filePath).toBe('/p/格子.png');
  });
});
