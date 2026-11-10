/**
 * groupFolders — 回归测试：展开分组内创建和拖入空节点。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import { createCanvasNoteData } from '../../src/types';

const PROJECT_DIR = 'D:/data/proj-1';

const { ensureGroupFolder, renameGroupFolder, moveProjectFileToFolder } = vi.hoisted(() => ({
  ensureGroupFolder: vi.fn(async () => null),
  renameGroupFolder: vi.fn(async () => true),
  // 假磁盘：只按目标目录算出新路径，已在目标目录时返回 null（不移动）
  moveProjectFileToFolder: vi.fn(async (filePath: string | undefined, dir: string, folder: string | null, options?: { preserveSource?: boolean; forceCopy?: boolean }) => {
    if (!filePath) return null;
    const name = filePath.replaceAll('\\', '/').split('/').pop()!;
    const target = folder ? `${dir}/${folder}/${name}` : `${dir}/${name}`;
    return target === filePath && !options?.forceCopy ? null : target;
  }),
}));

vi.mock('../../src/services/fileService', () => ({
  waitForPendingNodeFileDeletions: vi.fn(async () => undefined),
  resolveGroupUndoTrashPaths: vi.fn(async () => []),
  resolveNodeUndoTrashPaths: vi.fn(async () => []),
  collectNodeFileReferences: vi.fn(() => new Set<string>()),
  deletedGroupFolderNames: vi.fn(() => []),
  deleteNodeFiles: vi.fn(async () => undefined),
  setBaseDataDir: vi.fn(),
  syncAuthorizedDirectories: vi.fn(async () => undefined),
  ensureGroupFolder,
  renameGroupFolder,
  moveProjectFileToFolder,
  removeEmptyProjectGroupFolder: vi.fn(async () => undefined),
  finishProjectFileRelocation: vi.fn(async () => undefined),
  copyFileToProjectData: vi.fn(async (_path: string, _project: string) => ({ filePath: 'D:/data/proj-1/copied.png', assetUrl: 'asset://D:/data/proj-1/copied.png', fileName: 'copied.png' })),
  getProjectDataDir: vi.fn(async () => PROJECT_DIR),
  getAssetUrlFromPath: vi.fn(async (p: string) => `asset://${p}`),
  sanitizeFolderName: (name: string) => name.replace(/[<>:"|?*/\\]/g, '_'),
  stripVerbatimPrefix: (path: string) => path.replace(/^[\\/]{2}\?[\\/]/, ''),
}));

vi.mock('../../src/services/indexedDb/mediaRelocations', async (original) => ({
  ...await original<typeof import('../../src/services/indexedDb/mediaRelocations')>(),
  persistMediaRelocation: vi.fn(async () => undefined),
  pendingMediaRelocations: vi.fn(async () => []),
  completeMediaRelocation: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/pollManager', () => ({
  cancelNodePolling: vi.fn(),
  clearProjectTasks: vi.fn(),
  resumePendingTasks: vi.fn(async () => undefined),
}));

import { useAppStore } from '../../src/store/useAppStore';
import { copyFileToProjectData, finishProjectFileRelocation, getProjectDataDir, removeEmptyProjectGroupFolder } from '../../src/services/fileService';
import { persistMediaRelocation, pendingMediaRelocations } from '../../src/services/indexedDb/mediaRelocations';
import { copyNodeMedia } from '../../src/services/nodeMediaCopy';

function node(id: string): Node<BaseNodeData> {
  return {
    id,
    type: 'ai-text',
    position: { x: 0, y: 0 },
    data: { label: id, type: 'ai-text', status: 'success' },
  };
}

function createGroup(nodeIds: string[]) {
  useAppStore.setState({ selectedNodeIds: nodeIds });
  useAppStore.getState().groupSelectedNodes();
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'p1', projectLoadStatus: 'ready',
    projects: [{ id: 'p1', name: '项目一', createdAt: 1, updatedAt: 1 }, { id: 'p2', name: '项目二', createdAt: 1, updatedAt: 1 }],
    nodes: [node('a'), node('b'), node('c'), node('d')] });
  useAppStore.setState({ saveCurrentProjectSilent: vi.fn(async () => 'p1') });
  ensureGroupFolder.mockClear();
  renameGroupFolder.mockClear();
  moveProjectFileToFolder.mockClear();
  vi.mocked(finishProjectFileRelocation).mockClear();
  vi.mocked(getProjectDataDir).mockClear();
  vi.mocked(getProjectDataDir).mockResolvedValue(PROJECT_DIR);
  vi.mocked(removeEmptyProjectGroupFolder).mockClear();
  vi.mocked(persistMediaRelocation).mockClear();
  vi.mocked(pendingMediaRelocations).mockClear();
  vi.mocked(pendingMediaRelocations).mockResolvedValue([]);
});

describe('展开分组内创建和拖入空节点', () => {
  function setup() {
    const group: Node<BaseNodeData> = {
      id: 'group-test', type: 'group', position: { x: 100, y: 100 },
      data: { label: '分组', type: 'comment', groupId: 'group-test' },
      style: { width: 300, height: 200 },
      width: 1000, height: 700, measured: { width: 1000, height: 700 },
    };
    const empty: Node<BaseNodeData> = {
      id: 'empty', type: 'ai-image', position: { x: 700, y: 400 },
      data: { label: '空图像', type: 'ai-image', status: 'idle', nodeWidth: 280, nodeHeight: 160 },
    };
    useAppStore.setState({
      nodes: [group], edges: [],
      groups: [{ id: group.id, name: '分组', nodeIds: [], color: '#888888', createdAt: 0 }],
    });
    return { group, empty };
  }

  it('展开和收起只切换分组展示，不新增撤销历史', () => {
    const { group } = setup();
    const state = useAppStore.getState();
    const history = state.history;

    state.toggleGroupCollapsed(group.id);
    expect(useAppStore.getState().nodes[0]).toMatchObject({
      width: 220, height: 152, style: { width: 220, height: 152 },
      data: { groupCollapsed: true, groupExpandedSize: { width: 1000, height: 700 } },
    });
    expect(useAppStore.getState().history).toBe(history);
    expect(useAppStore.getState().historyIndex).toBe(-1);

    state.toggleGroupCollapsed(group.id);
    expect(useAppStore.getState().nodes[0]).toMatchObject({
      width: 1000, height: 700, style: { width: 1000, height: 700 },
    });
    expect(useAppStore.getState().nodes[0].data.groupCollapsed).toBeUndefined();
    expect(useAppStore.getState().history).toBe(history);
    expect(useAppStore.getState().historyIndex).toBe(-1);
  });

  it('已有当前基线快照时，开合后重复提交不产生只有展示变化的历史', () => {
    const { group } = setup();
    const state = useAppStore.getState();
    state.commitToHistory();
    const { history, historyIndex } = useAppStore.getState();

    for (let count = 0; count < 2; count += 1) {
      state.toggleGroupCollapsed(group.id);
      state.commitToHistory();
      expect(useAppStore.getState().history).toBe(history);
      expect(useAppStore.getState().historyIndex).toBe(historyIndex);
    }
  });

  it('撤销后收起分组不截断重做分支，重做移动时保持收起', async () => {
    const { group } = setup();
    const state = useAppStore.getState();
    state.commitToHistory();
    state.onNodesChange([{ id: group.id, type: 'position', position: { x: 200, y: 250 } }]);
    expect(await state.undo()).toBe(true);
    const { history, historyIndex } = useAppStore.getState();

    state.toggleGroupCollapsed(group.id);
    expect(useAppStore.getState().history).toBe(history);
    expect(useAppStore.getState().historyIndex).toBe(historyIndex);
    expect(await state.redo()).toBe(true);
    expect(useAppStore.getState().nodes[0]).toMatchObject({
      position: { x: 200, y: 250 }, width: 220, height: 152,
      data: { groupCollapsed: true, groupExpandedSize: { width: 1000, height: 700 } },
    });
  });

  it.each([false, true])('跨展开状态撤销重做移动，保留当前展示与子节点归属（原先收起：%s）', async (initiallyCollapsed) => {
    const { group, empty } = setup();
    const child = { ...empty, parentId: group.id, position: { x: 20, y: 30 } };
    useAppStore.setState({ nodes: [group, child], groups: [
      { ...useAppStore.getState().groups[0], nodeIds: [child.id] },
    ] });
    const state = useAppStore.getState();
    if (initiallyCollapsed) state.toggleGroupCollapsed(group.id);
    state.commitToHistory();
    state.onNodesChange([{ id: group.id, type: 'position', position: { x: 200, y: 250 } }]);
    state.toggleGroupCollapsed(group.id);
    const displaySize = initiallyCollapsed ? { width: 1000, height: 700 } : { width: 220, height: 152 };

    expect(await state.undo()).toBe(true);
    let restored = useAppStore.getState();
    expect(restored.nodes[0]).toMatchObject({ position: group.position, ...displaySize, style: displaySize });
    expect(restored.nodes[0].data.groupCollapsed === true).toBe(!initiallyCollapsed);
    expect(restored.nodes[1]).toMatchObject({ parentId: group.id, position: child.position });
    expect(restored.groups[0].nodeIds).toEqual([child.id]);

    expect(await state.redo()).toBe(true);
    restored = useAppStore.getState();
    expect(restored.nodes[0]).toMatchObject({ position: { x: 200, y: 250 }, ...displaySize, style: displaySize });
    expect(restored.nodes[0].data.groupCollapsed === true).toBe(!initiallyCollapsed);
    expect(restored.nodes[1]).toMatchObject({ parentId: group.id, position: child.position });
    expect(restored.groups[0].nodeIds).toEqual([child.id]);
  });

  it('在扩大后的分组空白区新建无内容节点，位置和成员关系一起撤销', async () => {
    const { group, empty } = setup();
    useAppStore.getState().addNode(empty);
    expect(useAppStore.getState().nodes[1]).toMatchObject({ parentId: group.id, position: { x: 600, y: 300 } });
    expect(useAppStore.getState().groups[0].nodeIds).toEqual(['empty']);
    await useAppStore.getState().undo();
    expect(useAppStore.getState().nodes.map((n) => n.id)).toEqual([group.id]);
    expect(useAppStore.getState().groups[0].nodeIds).toEqual([]);
    await useAppStore.getState().redo();
    expect(useAppStore.getState().nodes[1].parentId).toBe(group.id);
  });

  it('连线创建节点时同时入组，一次撤销清除节点、连线和成员关系', async () => {
    const { group, empty } = setup();
    useAppStore.setState({ nodes: [group, node('source')] });
    useAppStore.getState().addNodeWithEdge(empty, { id: 'edge', source: 'source', target: 'empty' });
    expect(useAppStore.getState().nodes[2].parentId).toBe(group.id);
    expect(useAppStore.getState().edges).toHaveLength(1);
    await useAppStore.getState().undo();
    expect(useAppStore.getState().nodes).toHaveLength(2);
    expect(useAppStore.getState().edges).toEqual([]);
    expect(useAppStore.getState().groups[0].nodeIds).toEqual([]);
  });

  it('空节点早于分组创建，拖入后父节点在前，且保留其他空分组', () => {
    const { group, empty } = setup();
    const other = { ...group, id: 'other', position: { x: 2000, y: 0 }, data: { ...group.data, groupId: 'other' } };
    useAppStore.setState({ nodes: [empty, group, other], groups: [
      ...useAppStore.getState().groups,
      { id: 'other', name: '空分组', nodeIds: [], color: '#888888', createdAt: 0 },
    ] });
    useAppStore.getState().settleNodeGroupingOnDragStop(empty);
    const state = useAppStore.getState();
    expect(state.nodes.find((n) => n.id === 'empty')).toMatchObject({ parentId: group.id, position: { x: 600, y: 300 } });
    expect(state.nodes.findIndex((n) => n.id === group.id)).toBeLessThan(state.nodes.findIndex((n) => n.id === 'empty'));
    expect(state.groups.find((g) => g.id === 'other')).toBeDefined();
  });

  it('拖动使用节点实际尺寸，不因历史业务尺寸过大误判在组外', () => {
    const { group, empty } = setup();
    const dragged = { ...empty, measured: { width: 100, height: 100 }, position: { x: 1000, y: 600 }, data: { ...empty.data, nodeWidth: 1000 } };
    useAppStore.setState({ nodes: [group, dragged] });
    useAppStore.getState().settleNodeGroupingOnDragStop(dragged);
    expect(useAppStore.getState().nodes[1].parentId).toBe(group.id);
  });

  it('多选拖入时整批入组，保留位置、数据和连线，归属共用一次撤销重做', async () => {
    const { group, empty } = setup();
    const second = { ...node('second'), position: { x: 250, y: 200 } };
    const stationary = { ...node('stationary'), position: { x: 450, y: 300 } };
    const edges = [{ id: 'batch-edge', source: empty.id, target: second.id }];
    useAppStore.setState({
      nodes: [empty, second, stationary, group], edges,
      selectedNodeIds: [empty.id, second.id, stationary.id],
    });

    useAppStore.getState().settleNodeGroupingOnDragStop([empty, second]);
    let state = useAppStore.getState();
    expect(state.nodes.find((item) => item.id === empty.id)).toMatchObject({
      parentId: group.id, position: { x: 600, y: 300 }, data: empty.data,
    });
    expect(state.nodes.find((item) => item.id === second.id)).toMatchObject({
      parentId: group.id, position: { x: 150, y: 100 }, data: second.data,
    });
    expect(state.nodes.find((item) => item.id === stationary.id)).toBe(stationary);
    expect(state.groups[0].nodeIds).toEqual([empty.id, second.id]);
    expect(state.edges).toBe(edges);
    expect(state.nodes[0].id).toBe(group.id);
    expect(state.history).toHaveLength(1);

    await state.undo();
    state = useAppStore.getState();
    for (const original of [empty, second]) {
      expect(state.nodes.find((item) => item.id === original.id)).toMatchObject({ position: original.position });
      expect(state.nodes.find((item) => item.id === original.id)?.parentId).toBeUndefined();
    }
    expect(state.groups[0].nodeIds).toEqual([]);
    await state.redo();
    state = useAppStore.getState();
    expect(state.groups[0].nodeIds).toEqual([empty.id, second.id]);
    expect(state.nodes.filter((item) => item.parentId === group.id).map((item) => item.id))
      .toEqual([empty.id, second.id]);
    state.settleNodeGroupingOnDragStop(state.nodes.filter((item) => item.parentId === group.id));
    expect(useAppStore.getState().history).toBe(state.history);
    expect(useAppStore.getState().groups[0].nodeIds).toEqual([empty.id, second.id]);
  });

  it('同批节点按各自中心结算，组外、锁定和非普通分组成员保持原归属', () => {
    const { group, empty } = setup();
    const ignored = [
      { ...node('outside'), position: { x: 1300, y: 200 } },
      { ...node('locked'), draggable: false, position: { x: 200, y: 200 } },
      { ...node('storyboard-child'), parentId: 'storyboard', position: { x: 300, y: 200 } },
    ];
    useAppStore.setState({ nodes: [group, empty, ...ignored] });
    useAppStore.getState().settleNodeGroupingOnDragStop([empty, ...ignored]);
    const state = useAppStore.getState();
    expect(state.groups[0].nodeIds).toEqual([empty.id]);
    for (const original of ignored) {
      expect(state.nodes.find((item) => item.id === original.id)).toBe(original);
    }
  });

  it('整批换组后再删除变空的原分组，坐标不跳动且一次撤销恢复全部成员', async () => {
    const { group, empty } = setup();
    const oldGroup = { ...group, id: 'old-group', position: { x: -1000, y: 0 },
      data: { ...group.data, groupId: 'old-record' } };
    const first = { ...empty, parentId: oldGroup.id, position: { x: 1700, y: 400 } };
    const second = { ...node('second'), parentId: oldGroup.id, position: { x: 1400, y: 200 } };
    useAppStore.setState({ nodes: [oldGroup, group, first, second], groups: [
      ...useAppStore.getState().groups,
      { id: 'old-record', name: '原分组', nodeIds: [first.id, second.id], color: '#888888', createdAt: 0 },
    ] });
    useAppStore.getState().settleNodeGroupingOnDragStop([first, second]);
    let state = useAppStore.getState();
    expect(state.nodes.find((item) => item.id === first.id)).toMatchObject({
      parentId: group.id, position: { x: 600, y: 300 },
    });
    expect(state.nodes.find((item) => item.id === second.id)).toMatchObject({
      parentId: group.id, position: { x: 300, y: 100 },
    });
    expect(state.nodes.some((item) => item.id === oldGroup.id)).toBe(false);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].nodeIds).toEqual([first.id, second.id]);
    expect(state.history).toHaveLength(1);
    await state.undo();
    state = useAppStore.getState();
    expect(state.nodes.find((item) => item.id === oldGroup.id)).toBeDefined();
    expect(state.nodes.find((item) => item.id === first.id)?.parentId).toBe(oldGroup.id);
    expect(state.nodes.find((item) => item.id === second.id)?.parentId).toBe(oldGroup.id);
    expect(state.groups.find((item) => item.id === 'old-record')?.nodeIds).toEqual([first.id, second.id]);
  });

  it('同批跨组交换成员时，两侧分组均保留并各自更新成员', () => {
    const { group, empty } = setup();
    const other = { ...group, id: 'other-group', position: { x: 2000, y: 100 },
      data: { ...group.data, groupId: 'other-record' } };
    const first = { ...empty, parentId: group.id, position: { x: 2100, y: 100 } };
    const second = { ...node('second'), parentId: other.id, position: { x: -1700, y: 200 } };
    useAppStore.setState({ nodes: [group, other, first, second], groups: [
      { ...useAppStore.getState().groups[0], nodeIds: [first.id] },
      { id: 'other-record', name: '其他分组', nodeIds: [second.id], color: '#888888', createdAt: 0 },
    ] });
    useAppStore.getState().settleNodeGroupingOnDragStop([first, second]);
    const state = useAppStore.getState();
    expect(state.nodes.find((item) => item.id === first.id)).toMatchObject({
      parentId: other.id, position: { x: 200, y: 100 },
    });
    expect(state.nodes.find((item) => item.id === second.id)).toMatchObject({
      parentId: group.id, position: { x: 200, y: 200 },
    });
    expect(state.groups.map((item) => item.nodeIds)).toEqual([[second.id], [first.id]]);
    expect(state.nodes.filter((item) => item.type === 'group')).toHaveLength(2);
    expect(state.history).toHaveLength(1);
  });

  it('多选拖出分组时整批脱组，保留绝对坐标并清理已空的原分组', () => {
    const { group, empty } = setup();
    const first = { ...empty, parentId: group.id, position: { x: 1400, y: 900 } };
    const second = { ...node('second'), parentId: group.id, position: { x: 1700, y: 1000 } };
    useAppStore.setState({ nodes: [group, first, second], groups: [
      { ...useAppStore.getState().groups[0], nodeIds: [first.id, second.id] },
    ] });
    useAppStore.getState().settleNodeGroupingOnDragStop([first, second]);
    const state = useAppStore.getState();
    expect(state.nodes).toMatchObject([
      { id: first.id, parentId: undefined, position: { x: 1500, y: 1000 } },
      { id: second.id, parentId: undefined, position: { x: 1800, y: 1100 } },
    ]);
    expect(state.groups).toEqual([]);
    expect(state.history).toHaveLength(1);
  });

  it('无实测音频按音频默认宽度判定中心，不误用通用节点宽度', () => {
    const { group } = setup();
    useAppStore.getState().addNode({
      id: 'audio', type: 'ai-audio', position: { x: 965, y: 660 },
      data: { type: 'ai-audio', label: '空音频', status: 'idle' },
    });
    expect(useAppStore.getState().nodes[1]).toMatchObject({
      parentId: group.id, position: { x: 865, y: 560 },
    });
  });

  it('分组无效实测尺寸不会遮蔽有效样式范围', () => {
    const { group, empty } = setup();
    useAppStore.setState({ nodes: [{ ...group,
      width: undefined, height: undefined, measured: { width: 0, height: NaN },
      style: { width: 1000, height: 700 },
    }] });
    useAppStore.getState().addNode(empty);
    expect(useAppStore.getState().nodes[1].parentId).toBe(group.id);
  });

  it('历史分组自引用时几何遍历终止，不重复累计分组自身位置', () => {
    const { group, empty } = setup();
    useAppStore.setState({ nodes: [{ ...group, parentId: group.id }] });
    useAppStore.getState().addNode(empty);
    expect(useAppStore.getState().nodes[1]).toMatchObject({
      parentId: group.id, position: { x: 600, y: 300 },
    });
    expect(useAppStore.getState().nodes[0].parentId).toBe(group.id);
  });

  it('反向选择不同尺寸节点时，新分组按各自实测边界包住内容并可撤销', async () => {
    const first = { ...node('a'), measured: { width: 120, height: 88 },
      data: { ...node('a').data, nodeWidth: 1000, nodeHeight: 500 } };
    const second = { ...node('b'), position: { x: 300, y: 50 }, measured: { width: 400, height: 120 },
      data: { ...node('b').data, nodeWidth: 10, nodeHeight: 10 } };
    useAppStore.setState({ nodes: [first, second], groups: [] });
    createGroup(['b', 'a']);
    const state = useAppStore.getState();
    expect(state.nodes[0]).toMatchObject({
      type: 'group', position: { x: -36, y: -72 }, style: { width: 772, height: 278 },
    });
    expect(state.nodes.find((item) => item.id === 'a')?.position).toEqual({ x: 36, y: 72 });
    expect(state.nodes.find((item) => item.id === 'b')?.position).toEqual({ x: 336, y: 122 });
    await useAppStore.getState().undo();
    expect(useAppStore.getState().nodes).toEqual([first, second]);
    expect(useAppStore.getState().groups).toEqual([]);
  });

  it('拖出分组还原绝对坐标，不影响其他分组的成员', () => {
    const { group, empty } = setup();
    useAppStore.getState().addNode(empty);
    const moved = { ...useAppStore.getState().nodes[1], position: { x: 1400, y: 900 } };
    useAppStore.getState().settleNodeGroupingOnDragStop(moved);
    expect(useAppStore.getState().nodes.find((n) => n.id === empty.id)).toMatchObject({ parentId: undefined, position: { x: 1500, y: 1000 } });
    expect(useAppStore.getState().groups.some((g) => g.id === group.id)).toBe(false);
  });

  it('新建节点不会自动藏进折叠分组，显式父节点保持原坐标', () => {
    const { group, empty } = setup();
    useAppStore.setState({ nodes: [{ ...group, data: { ...group.data, groupCollapsed: true } }] });
    useAppStore.getState().addNode(empty);
    expect(useAppStore.getState().nodes[1].parentId).toBeUndefined();
    useAppStore.getState().addNode({ ...empty, id: 'child', parentId: group.id, position: { x: 20, y: 30 } });
    expect(useAppStore.getState().nodes[2]).toMatchObject({ parentId: group.id, position: { x: 20, y: 30 } });
  });
});

describe('缩放分组后同步成员归属', () => {
  function setup() {
    const group: Node<BaseNodeData> = {
      id: 'resize-group', type: 'group', position: { x: 100, y: 100 },
      width: 400, height: 200, measured: { width: 400, height: 200 }, style: { width: 400, height: 200 },
      data: { type: 'comment', label: '缩放分组', groupId: 'resize-record' },
    };
    const inside = { ...node('inside'), parentId: group.id, position: { x: 20, y: 30 } };
    const audio: Node<BaseNodeData> = {
      id: 'new-audio', type: 'ai-audio', position: { x: 600, y: 400 }, measured: { width: 280, height: 88 },
      data: { type: 'ai-audio', label: '组外音频', status: 'success', audioUrl: 'asset://audio.wav',
        filePath: `${PROJECT_DIR}/audio.wav`, nodeWidth: 1600, nodeHeight: 900 },
    };
    useAppStore.setState({
      nodes: [audio, group, inside],
      edges: [{ id: 'audio-edge', source: 'inside', target: audio.id }],
      groups: [{ id: 'resize-record', name: '缩放分组', nodeIds: ['inside'], color: '#888888', createdAt: 0 }],
    });
    return { group, inside, audio };
  }

  function resize(width: number, height: number) {
    const state = useAppStore.getState();
    state.commitToHistory();
    state.onNodesChange([{ id: 'resize-group', type: 'dimensions', dimensions: { width, height },
      setAttributes: true, resizing: true }]);
    state.settleGroupMembersOnResizeEnd('resize-group');
  }

  it('收起时撤销重做实际缩放，卡片尺寸不变，再展开恢复对应尺寸与成员', async () => {
    const { group, inside, audio } = setup();
    const state = useAppStore.getState();
    resize(1000, 700);
    state.toggleGroupCollapsed(group.id);

    expect(await state.undo()).toBe(true);
    let restored = useAppStore.getState();
    expect(restored.nodes.find((item) => item.id === group.id)).toMatchObject({
      width: 220, height: 152, style: { width: 220, height: 152 },
      data: { groupCollapsed: true, groupExpandedSize: { width: 400, height: 200 } },
    });
    expect(restored.nodes.find((item) => item.id === inside.id)).toMatchObject({ parentId: group.id, position: inside.position });
    expect(restored.nodes.find((item) => item.id === audio.id)?.parentId).toBeUndefined();
    expect(restored.groups[0].nodeIds).toEqual([inside.id]);
    const { history, historyIndex } = restored;

    state.toggleGroupCollapsed(group.id);
    expect(useAppStore.getState().nodes.find((item) => item.id === group.id))
      .toMatchObject({ width: 400, height: 200, style: { width: 400, height: 200 } });
    state.toggleGroupCollapsed(group.id);
    expect(useAppStore.getState().history).toBe(history);
    expect(useAppStore.getState().historyIndex).toBe(historyIndex);

    expect(await state.redo()).toBe(true);
    restored = useAppStore.getState();
    expect(restored.nodes.find((item) => item.id === group.id)).toMatchObject({
      width: 220, height: 152, style: { width: 220, height: 152 },
      data: { groupCollapsed: true, groupExpandedSize: { width: 1000, height: 700 } },
    });
    expect(restored.nodes.find((item) => item.id === inside.id)).toMatchObject({ parentId: group.id, position: inside.position });
    expect(restored.nodes.find((item) => item.id === audio.id)).toMatchObject({ parentId: group.id, position: { x: 500, y: 300 } });
    expect(restored.groups[0].nodeIds).toEqual([inside.id, audio.id]);

    state.toggleGroupCollapsed(group.id);
    expect(useAppStore.getState().nodes.find((item) => item.id === group.id))
      .toMatchObject({ width: 1000, height: 700, style: { width: 1000, height: 700 } });
  });

  it('扩大后按实测中心吸纳音频，保留绝对位置、连线和资产，尺寸与成员一次撤销重做', async () => {
    const { group, audio, inside } = setup();
    const edges = useAppStore.getState().edges;
    resize(1000, 700);
    let state = useAppStore.getState();
    expect(state.nodes.find((item) => item.id === audio.id)).toMatchObject({
      parentId: group.id, position: { x: 500, y: 300 }, data: audio.data,
    });
    expect(state.nodes.find((item) => item.id === inside.id)?.position).toEqual(inside.position);
    expect(state.groups[0].nodeIds).toEqual(['inside', audio.id]);
    expect(state.edges).toBe(edges);
    expect(state.nodes.findIndex((item) => item.id === group.id))
      .toBeLessThan(state.nodes.findIndex((item) => item.id === audio.id));
    expect(state.history).toHaveLength(2);

    await state.undo();
    state = useAppStore.getState();
    expect(state.nodes.find((item) => item.id === group.id)).toMatchObject({
      position: group.position, width: 400, height: 200, measured: { width: 400, height: 200 },
    });
    expect(state.nodes.find((item) => item.id === audio.id)).toMatchObject({ position: audio.position, data: audio.data });
    expect(state.nodes.find((item) => item.id === audio.id)?.parentId).toBeUndefined();
    expect(state.groups[0].nodeIds).toEqual(['inside']);

    await state.redo();
    state = useAppStore.getState();
    expect(state.nodes.find((item) => item.id === group.id)).toMatchObject({ width: 1000, height: 700 });
    expect(state.nodes.find((item) => item.id === audio.id)).toMatchObject({ parentId: group.id, position: { x: 500, y: 300 } });
    expect(state.groups[0].nodeIds).toEqual(['inside', audio.id]);
    state.settleGroupMembersOnResizeEnd(group.id);
    expect(useAppStore.getState().history).toHaveLength(2);
    expect(useAppStore.getState().groups[0].nodeIds).toEqual(['inside', audio.id]);
  });

  it('不吸纳隐藏、锁定、其他分组及已有父级节点，也不重复登记已有成员', () => {
    const { group } = setup();
    const ignored = [
      { ...node('hidden'), hidden: true },
      { ...node('library'), data: { ...node('library').data, hiddenByCharacterLibrary: true } },
      { ...node('locked'), draggable: false },
      { ...node('owned'), parentId: 'other-group' },
      { ...node('other-group'), type: 'group' },
    ].map((item) => ({ ...item, position: { x: 200, y: 200 } }));
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes, ...ignored] });
    resize(1000, 700);
    const state = useAppStore.getState();
    for (const original of ignored) {
      expect(state.nodes.find((item) => item.id === original.id)).toEqual(original);
    }
    expect(state.groups[0].nodeIds).toEqual(['inside', 'new-audio']);
    expect(state.nodes.filter((item) => item.parentId === group.id)).toHaveLength(2);
  });

  it('从左上角扩大时保留新旧节点的绝对位置，撤销还原父框及旧子节点的相对位置', async () => {
    const { group, inside, audio } = setup();
    const state = useAppStore.getState();
    state.commitToHistory();
    state.onNodesChange([
      { id: group.id, type: 'position', position: { x: 40, y: 50 } },
      { id: inside.id, type: 'position', position: { x: 80, y: 80 } },
      { id: group.id, type: 'dimensions', dimensions: { width: 1100, height: 800 }, setAttributes: true },
    ]);
    state.settleGroupMembersOnResizeEnd(group.id);
    expect(useAppStore.getState().nodes.find((item) => item.id === audio.id)?.position).toEqual({ x: 560, y: 350 });
    expect(useAppStore.getState().nodes.find((item) => item.id === inside.id)?.position).toEqual({ x: 80, y: 80 });
    await state.undo();
    expect(useAppStore.getState().nodes.find((item) => item.id === group.id)).toMatchObject({
      position: group.position, width: 400, height: 200,
    });
    expect(useAppStore.getState().nodes.find((item) => item.id === inside.id)?.position).toEqual(inside.position);
    expect(useAppStore.getState().nodes.find((item) => item.id === audio.id)?.position).toEqual(audio.position);
    await state.redo();
    expect(useAppStore.getState().nodes.find((item) => item.id === inside.id)?.position).toEqual({ x: 80, y: 80 });
  });

  it('嵌套分组按父链绝对范围吸纳节点，相对坐标不重复累加祖先', () => {
    const { group, audio } = setup();
    const outer: Node<BaseNodeData> = { id: 'outer', type: 'group', position: { x: 500, y: 600 },
      data: { type: 'comment', label: '外层' } };
    useAppStore.setState({ nodes: [
      outer,
      ...useAppStore.getState().nodes.map((item) => item.id === group.id ? { ...item, parentId: outer.id }
        : item.id === audio.id ? { ...item, position: { x: 900, y: 1100 } } : item),
    ] });
    resize(1000, 700);
    expect(useAppStore.getState().nodes.find((item) => item.id === audio.id))
      .toMatchObject({ parentId: group.id, position: { x: 300, y: 400 } });
  });

  it('撤销吸纳只恢复对应分组，不回滚其他分组的独立布局', async () => {
    const { group } = setup();
    const other: Node<BaseNodeData> = { id: 'unrelated-group', type: 'group', position: { x: 2000, y: 0 },
      width: 400, height: 200, data: { type: 'comment', label: '其他分组', groupId: 'other-record' } };
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes, other], groups: [
      ...useAppStore.getState().groups,
      { id: 'other-record', name: '其他分组', nodeIds: [], color: '#888888', createdAt: 0 },
    ] });
    const state = useAppStore.getState();
    state.commitToHistory();
    state.onNodesChange([
      { id: group.id, type: 'dimensions', dimensions: { width: 1000, height: 700 }, setAttributes: true },
      { id: other.id, type: 'position', position: { x: 2500, y: 100 } },
      { id: other.id, type: 'dimensions', dimensions: { width: 600, height: 300 }, setAttributes: true },
    ]);
    state.settleGroupMembersOnResizeEnd(group.id);
    await state.undo();
    expect(useAppStore.getState().nodes.find((item) => item.id === group.id)).toMatchObject({ width: 400, height: 200 });
    expect(useAppStore.getState().nodes.find((item) => item.id === other.id))
      .toMatchObject({ position: { x: 2500, y: 100 }, width: 600, height: 300 });
  });

  it('缩小后范围外成员脱组并清理父级约束，位置保持且尺寸与归属可一起撤销重做', async () => {
    const { group, inside } = setup();
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === inside.id
      ? { ...item, position: { x: 200, y: 80 }, measured: { width: 100, height: 80 },
        extent: 'parent' as const, expandParent: true } : item) });
    resize(200, 120);
    let state = useAppStore.getState();
    const released = state.nodes.find((item) => item.id === inside.id)!;
    expect(released.parentId).toBeUndefined();
    expect(released.extent).toBeUndefined();
    expect(released.expandParent).toBeUndefined();
    expect(released.position).toEqual({ x: 300, y: 180 });
    expect(state.groups[0].nodeIds).toEqual([]);
    expect(state.nodes.some((item) => item.id === group.id)).toBe(true);
    expect(useAppStore.getState().nodes.find((item) => item.id === 'new-audio')?.parentId).toBeUndefined();
    await state.undo();
    state = useAppStore.getState();
    expect(state.nodes.find((item) => item.id === group.id)).toMatchObject({ width: 400, height: 200 });
    expect(state.nodes.find((item) => item.id === inside.id)).toMatchObject({
      parentId: group.id, position: { x: 200, y: 80 }, extent: 'parent', expandParent: true,
    });
    expect(state.groups[0].nodeIds).toEqual(['inside']);
    await state.redo();
    state = useAppStore.getState();
    expect(state.nodes.find((item) => item.id === group.id)).toMatchObject({ width: 200, height: 120 });
    expect(state.nodes.find((item) => item.id === inside.id)?.parentId).toBeUndefined();
    expect(state.nodes.find((item) => item.id === inside.id)?.position).toEqual({ x: 300, y: 180 });
    expect(state.groups[0].nodeIds).toEqual([]);
  });

  it.each([{ width: 250, remains: true }, { width: 249, remains: false }])(
    '中心位于边界时保留，超过边界才脱组（宽度 $width）', ({ width, remains }) => {
      const { group, inside } = setup();
      useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === inside.id
        ? { ...item, position: { x: 200, y: 80 }, measured: { width: 100, height: 80 } } : item) });
      resize(width, 120);
      expect(useAppStore.getState().nodes.find((item) => item.id === inside.id)?.parentId)
        .toBe(remains ? group.id : undefined);
    },
  );

  it('同一次调整可以加入新成员并移出旧成员，松手后只保留最终范围内的归属', async () => {
    const { group, inside, audio } = setup();
    const state = useAppStore.getState();
    state.commitToHistory();
    state.onNodesChange([
      { id: group.id, type: 'position', position: { x: 300, y: 100 } },
      { id: inside.id, type: 'position', position: { x: -180, y: 30 } },
      { id: group.id, type: 'dimensions', dimensions: { width: 800, height: 600 }, setAttributes: true },
    ]);
    state.settleGroupMembersOnResizeEnd(group.id);
    expect(useAppStore.getState().groups[0].nodeIds).toEqual([audio.id]);
    expect(useAppStore.getState().nodes.find((item) => item.id === inside.id)?.parentId).toBeUndefined();
    expect(useAppStore.getState().nodes.find((item) => item.id === inside.id)?.position).toEqual({ x: 120, y: 130 });
    expect(useAppStore.getState().nodes.find((item) => item.id === audio.id))
      .toMatchObject({ parentId: group.id, position: { x: 300, y: 300 }, data: audio.data });
    await state.undo();
    expect(useAppStore.getState().groups[0].nodeIds).toEqual([inside.id]);
    expect(useAppStore.getState().nodes.find((item) => item.id === group.id))
      .toMatchObject({ position: group.position, width: 400, height: 200 });
    expect(useAppStore.getState().nodes.find((item) => item.id === inside.id))
      .toMatchObject({ parentId: group.id, position: inside.position });
    expect(useAppStore.getState().nodes.find((item) => item.id === audio.id)?.parentId).toBeUndefined();
    await state.redo();
    expect(useAppStore.getState().groups[0].nodeIds).toEqual([audio.id]);
    expect(useAppStore.getState().nodes.find((item) => item.id === inside.id)?.parentId).toBeUndefined();
  });

  it('嵌套分组移出成员时转换到完整画布坐标，不自动转移到外层组', () => {
    const { group, inside } = setup();
    const outer: Node<BaseNodeData> = { id: 'outer', type: 'group', position: { x: 500, y: 600 },
      data: { type: 'comment', label: '外层' } };
    useAppStore.setState({ nodes: [outer, ...useAppStore.getState().nodes.map((item) => item.id === group.id
      ? { ...item, parentId: outer.id }
      : item.id === inside.id ? { ...item, position: { x: 200, y: 80 }, measured: { width: 100, height: 80 } } : item)] });
    resize(200, 120);
    expect(useAppStore.getState().nodes.find((item) => item.id === inside.id)?.parentId).toBeUndefined();
    expect(useAppStore.getState().nodes.find((item) => item.id === inside.id)?.position).toEqual({ x: 800, y: 780 });
    expect(useAppStore.getState().groups[0].nodeIds).toEqual([]);
  });

  it('位于范围外的子分组整体脱离，子分组自己的成员与相对位置保持不变', () => {
    const { group } = setup();
    const nested: Node<BaseNodeData> = { id: 'nested', type: 'group', parentId: group.id, position: { x: 200, y: 80 },
      measured: { width: 100, height: 80 }, data: { type: 'comment', label: '子分组', groupId: 'nested-record' } };
    const leaf = { ...node('nested-leaf'), parentId: nested.id, position: { x: 10, y: 10 } };
    useAppStore.setState({
      nodes: [...useAppStore.getState().nodes, nested, leaf],
      groups: [{ ...useAppStore.getState().groups[0], nodeIds: ['inside', nested.id] },
        { id: 'nested-record', name: '子分组', nodeIds: [leaf.id], color: '#888888', createdAt: 0 }],
    });
    resize(200, 120);
    const state = useAppStore.getState();
    expect(state.nodes.find((item) => item.id === nested.id)?.parentId).toBeUndefined();
    expect(state.nodes.find((item) => item.id === nested.id)?.position).toEqual({ x: 300, y: 180 });
    expect(state.nodes.find((item) => item.id === leaf.id)).toEqual(leaf);
    expect(state.groups.find((record) => record.id === 'resize-record')?.nodeIds).toEqual(['inside']);
    expect(state.groups.find((record) => record.id === 'nested-record')?.nodeIds).toEqual([leaf.id]);
  });

  it.each(['collapsed', 'hidden', 'locked', 'missing'] as const)('%s 目标分组不吸纳节点', (kind) => {
    const { group, audio } = setup();
    useAppStore.setState({ nodes: kind === 'missing' ? [audio] : useAppStore.getState().nodes.map((item) => item.id === group.id
      ? { ...item, width: 1000, height: 700, measured: { width: 1000, height: 700 },
        hidden: kind === 'hidden', draggable: kind !== 'locked',
        data: { ...item.data, groupCollapsed: kind === 'collapsed' } } : item) });
    useAppStore.getState().settleGroupMembersOnResizeEnd(group.id);
    expect(useAppStore.getState().nodes.find((item) => item.id === audio.id)?.parentId).toBeUndefined();
    expect(useAppStore.getState().groups[0].nodeIds).toEqual(['inside']);
  });
});

describe('分组与本地文件夹同步', () => {
  it('MCP 导入的深层图片入组后提交路径迁移并放入分组目录', async () => {
    const path = `${PROJECT_DIR}/images/EP000/portrait.png`;
    const imported = { ...node('imported'), type: 'source-image', data: { ...node('imported').data,
      type: 'source-image', role: 'source', filePath: path, imageUrl: `asset://${path}`, relativePath: 'images/EP000/portrait.png' } } as Node<BaseNodeData>;
    useAppStore.setState({ nodes: [imported, node('b')] });
    createGroup(['imported', 'b']);
    await useAppStore.getState().syncGroupFiles();
    expect(moveProjectFileToFolder).toHaveBeenCalledWith(path, PROJECT_DIR, '分组', { preserveSource: true, forceCopy: false });
    expect(useAppStore.getState().nodes.find((item) => item.id === 'imported')?.data).toMatchObject({
      type: 'source-image', filePath: `${PROJECT_DIR}/分组/portrait.png`, relativePath: '分组/portrait.png',
    });
    expect(persistMediaRelocation).toHaveBeenCalledWith(expect.objectContaining({ oldPath: path,
      newPath: `${PROJECT_DIR}/分组/portrait.png`, projectId: 'p1' }), undefined);
    expect(finishProjectFileRelocation).toHaveBeenCalledWith(path, `${PROJECT_DIR}/分组/portrait.png`, PROJECT_DIR);
  });

  it('未分组的深层导入素材保持原目录，隐藏及私有子目录不参与归档', async () => {
    const untouched = { ...node('outside'), data: { ...node('outside').data, filePath: `${PROJECT_DIR}/images/EP000/outside.png` } };
    const protectedNodes = ['.trash/EP000', 'images/.thumbnail', 'images/AppData', 'images/agent-private',
      'images/plugin-private', 'images/blender-private', 'images/secrets', 'images/../EP000'].map((folder, index) => ({
      ...node(`protected-${index}`), data: { ...node(`protected-${index}`).data, filePath: `${PROJECT_DIR}/${folder}/portrait.png` },
    }));
    useAppStore.setState({ nodes: [untouched, ...protectedNodes] });
    createGroup(protectedNodes.map((item) => item.id));
    await useAppStore.getState().syncGroupFiles();
    expect(moveProjectFileToFolder).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes.find((item) => item.id === untouched.id)?.data.filePath).toBe(untouched.data.filePath);
  });

  it('深层共享文件仅复制入组节点的引用，未分组节点继续读取原文件', async () => {
    const path = `${PROJECT_DIR}/images/EP000/shared.png`;
    const original = { ...node('a'), data: { ...node('a').data, filePath: path, imageUrl: `asset://${path}` } };
    const outside = { ...node('outside'), data: { ...node('outside').data, filePath: path, imageUrl: `asset://${path}` } };
    useAppStore.setState({ nodes: [original, node('b'), outside] });
    createGroup(['a', 'b']);
    await useAppStore.getState().syncGroupFiles();
    expect(moveProjectFileToFolder).toHaveBeenCalledWith(path, PROJECT_DIR, '分组', { preserveSource: true, forceCopy: true });
    expect(persistMediaRelocation).toHaveBeenCalledWith(expect.objectContaining({ oldPath: path, ownerId: 'a' }), 'a');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'a')?.data.filePath).toBe(`${PROJECT_DIR}/分组/shared.png`);
    expect(useAppStore.getState().nodes.find((item) => item.id === 'outside')?.data.filePath).toBe(path);
    expect(finishProjectFileRelocation).not.toHaveBeenCalled();
  });

  it('没有迁移时不保存，正文更新也不重新遍历或请求项目目录', async () => {
    await useAppStore.getState().syncGroupFiles();
    const save = vi.mocked(useAppStore.getState().saveCurrentProjectSilent);
    expect(save).not.toHaveBeenCalled();
    vi.mocked(getProjectDataDir).mockClear();
    useAppStore.getState().updateNodeDataTransient('a', { output: '新的正文' });
    await useAppStore.getState().syncGroupFiles();
    expect(getProjectDataDir).not.toHaveBeenCalled();
    expect(moveProjectFileToFolder).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('媒体签名未变也检查并恢复 pending，不依赖下一次编辑', async () => {
    await useAppStore.getState().syncGroupFiles();
    const move = { oldPath: `${PROJECT_DIR}/old.png`, newPath: `${PROJECT_DIR}/new.png`,
      projectId: 'p1', assetUrl: `asset://${PROJECT_DIR}/new.png`, relativePath: 'new.png' };
    vi.mocked(pendingMediaRelocations).mockResolvedValueOnce([move]);
    await useAppStore.getState().syncGroupFiles();
    expect(useAppStore.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
    expect(finishProjectFileRelocation).toHaveBeenCalledWith(move.oldPath, move.newPath, PROJECT_DIR);
  });

  it('只保留最近项目的媒体签名，回访项目会重新检查目录', async () => {
    await useAppStore.getState().syncGroupFiles();
    useAppStore.setState({ currentProjectId: 'p2' });
    await useAppStore.getState().syncGroupFiles();
    vi.mocked(getProjectDataDir).mockClear();
    useAppStore.setState({ currentProjectId: 'p1' });
    await useAppStore.getState().syncGroupFiles();
    expect(getProjectDataDir).toHaveBeenCalledOnce();
    expect(getProjectDataDir).toHaveBeenCalledWith('p1');
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
  });

  it('已在目标目录的大画布只线性读取媒体字段', async () => {
    const count = 1000;
    let pathReads = 0;
    const nodes = Array.from({ length: count }, (_, index) => {
      const result = node(`media-${index}`);
      Object.defineProperty(result.data, 'filePath', {
        enumerable: true, get: () => { pathReads += 1; return `${PROJECT_DIR}/${index}.png`; },
      });
      return result;
    });
    useAppStore.setState({ nodes });
    await useAppStore.getState().syncGroupFiles();
    expect(pathReads).toBeLessThan(count * 20);
    expect(moveProjectFileToFolder).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
  });

  it('复制租约暂时跳过的源文件不会被缓存为已同步', async () => {
    const path = `${PROJECT_DIR}/pinned.png`;
    const source = { ...node('a'), data: { ...node('a').data, filePath: path } };
    useAppStore.setState({ nodes: [source, node('b')] });
    createGroup(['a', 'b']);
    let release!: (result: { filePath: string; assetUrl: string; fileName: string }) => void;
    vi.mocked(copyFileToProjectData).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const copying = copyNodeMedia(source.data, 'p1');
    await useAppStore.getState().syncGroupFiles();
    expect(moveProjectFileToFolder).not.toHaveBeenCalled();
    release({ filePath: `${PROJECT_DIR}/copied.png`, assetUrl: 'asset://copied.png', fileName: 'copied.png' });
    await copying;
    await useAppStore.getState().syncGroupFiles();
    expect(useAppStore.getState().nodes.find((item) => item.id === 'a')?.data.filePath).toBe(`${PROJECT_DIR}/分组/pinned.png`);
  });

  it('一个项目等待 IO 时，另一个项目的恢复请求会在退出后执行', async () => {
    let release!: (moves: []) => void;
    vi.mocked(pendingMediaRelocations).mockImplementationOnce(() => new Promise<[]>((resolve) => { release = resolve; }));
    const first = useAppStore.getState().syncGroupFiles();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const move = { oldPath: `${PROJECT_DIR}/old.png`, newPath: `${PROJECT_DIR}/new.png`,
      projectId: 'p2', assetUrl: `asset://${PROJECT_DIR}/new.png`, relativePath: 'new.png' };
    useAppStore.setState({ currentProjectId: 'p2' });
    vi.mocked(useAppStore.getState().saveCurrentProjectSilent).mockResolvedValue('p2');
    vi.mocked(pendingMediaRelocations).mockResolvedValueOnce([move]);
    await useAppStore.getState().syncGroupFiles();
    release([]);
    await first;
    expect(pendingMediaRelocations).toHaveBeenCalledWith('p2');
    expect(finishProjectFileRelocation).toHaveBeenCalledWith(move.oldPath, move.newPath, PROJECT_DIR);
  });

  it('同项目只有 revision 变化时不立即重跑，显式请求仍可重试', async () => {
    let revision = 0;
    useAppStore.setState({ getCurrentRevision: () => revision });
    let release!: (moves: []) => void;
    vi.mocked(pendingMediaRelocations).mockImplementationOnce(() => new Promise<[]>((resolve) => { release = resolve; }));
    const syncing = useAppStore.getState().syncGroupFiles();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    revision += 1;
    release([]);
    await syncing;
    expect(pendingMediaRelocations).toHaveBeenCalledOnce();
    expect(getProjectDataDir).not.toHaveBeenCalled();
    await useAppStore.getState().syncGroupFiles();
    expect(pendingMediaRelocations).toHaveBeenCalledTimes(2);
    expect(getProjectDataDir).toHaveBeenCalledOnce();
  });

  it('忙碌期间的同项目请求合并成后续一轮', async () => {
    useAppStore.setState({ nodes: [node('coalesced')] });
    let release!: (moves: []) => void;
    vi.mocked(pendingMediaRelocations).mockImplementationOnce(() => new Promise<[]>((resolve) => { release = resolve; }));
    const syncing = useAppStore.getState().syncGroupFiles();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await useAppStore.getState().syncGroupFiles();
    await useAppStore.getState().syncGroupFiles();
    release([]);
    await syncing;
    expect(pendingMediaRelocations).toHaveBeenCalledTimes(2);
    expect(getProjectDataDir).toHaveBeenCalledOnce();
  });

  it('复制期间同项目改源会重扫最新文件，旧结果不写回', async () => {
    let revision = 0;
    useAppStore.setState({ getCurrentRevision: () => revision });
    const oldPath = `${PROJECT_DIR}/old.png`;
    const newPath = `${PROJECT_DIR}/regenerated.png`;
    useAppStore.setState({ nodes: [{ ...node('a'), data: { ...node('a').data, filePath: oldPath } }, node('b')] });
    createGroup(['a', 'b']);
    let release!: (path: string) => void;
    moveProjectFileToFolder.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const syncing = useAppStore.getState().syncGroupFiles();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    useAppStore.getState().updateNodeDataTransient('a', { filePath: newPath, output: '生成完成' });
    revision += 1;
    release(`${PROJECT_DIR}/分组/old.png`);
    await syncing;
    expect(persistMediaRelocation).not.toHaveBeenCalledWith(expect.objectContaining({ oldPath }), undefined);
    expect(useAppStore.getState().nodes.find((item) => item.id === 'a')?.data)
      .toMatchObject({ filePath: `${PROJECT_DIR}/分组/regenerated.png`, output: '生成完成' });
  });

  it('等待保存期间新增旧路径引用时，重扫并再次保存后才清理源文件', async () => {
    const path = `${PROJECT_DIR}/a.png`;
    useAppStore.setState({ nodes: [{ ...node('a'), data: { ...node('a').data, filePath: path } }, node('b')] });
    createGroup(['a', 'b']);
    let release!: (id: string) => void;
    vi.mocked(useAppStore.getState().saveCurrentProjectSilent)
      .mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const syncing = useAppStore.getState().syncGroupFiles();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    useAppStore.getState().updateNodeDataTransient('b', { filePath: path });
    release('p1');
    await syncing;
    const save = vi.mocked(useAppStore.getState().saveCurrentProjectSilent);
    expect(save).toHaveBeenCalledTimes(2);
    expect(finishProjectFileRelocation).toHaveBeenCalledOnce();
    expect(vi.mocked(finishProjectFileRelocation).mock.invocationCallOrder[0]).toBeGreaterThan(save.mock.invocationCallOrder[1]);
  });

  it('空分组改名也先保存，再清理旧空目录', async () => {
    createGroup(['a', 'b']);
    const groupId = useAppStore.getState().groups[0].id;
    useAppStore.getState().renameGroup(groupId, '空镜头');
    await vi.waitFor(() => expect(removeEmptyProjectGroupFolder).toHaveBeenCalledWith(PROJECT_DIR, '分组'));
    const save = vi.mocked(useAppStore.getState().saveCurrentProjectSilent);
    expect(save).toHaveBeenCalled();
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(removeEmptyProjectGroupFolder).mock.invocationCallOrder[0]);
  });

  it('保存失败时保留源文件，下次同步完成已提交迁移', async () => {
    const path = `${PROJECT_DIR}/a.png`;
    useAppStore.setState({ nodes: [{ ...node('a'), data: { ...node('a').data, filePath: path } }, node('b')] });
    createGroup(['a', 'b']);
    useAppStore.setState({ saveCurrentProjectSilent: vi.fn(async () => undefined) });
    await useAppStore.getState().syncGroupFiles();
    expect(finishProjectFileRelocation).not.toHaveBeenCalled();
    vi.mocked(pendingMediaRelocations).mockResolvedValueOnce([{
      oldPath: path, newPath: `${PROJECT_DIR}/分组/a.png`, projectId: 'p1',
      assetUrl: `asset://${PROJECT_DIR}/分组/a.png`, relativePath: '分组/a.png',
    }]);
    useAppStore.setState({ saveCurrentProjectSilent: vi.fn(async () => 'p1') });
    await useAppStore.getState().syncGroupFiles();
    expect(finishProjectFileRelocation).toHaveBeenCalledWith(path, `${PROJECT_DIR}/分组/a.png`, PROJECT_DIR);
  });

  it('引用事务失败时不删除源文件也不改写节点', async () => {
    const path = `${PROJECT_DIR}/a.png`;
    useAppStore.setState({ nodes: [{ ...node('a'), data: { ...node('a').data, filePath: path } }, node('b')] });
    createGroup(['a', 'b']);
    vi.mocked(persistMediaRelocation).mockRejectedValueOnce(new Error('quota exceeded'));
    await useAppStore.getState().syncGroupFiles();
    expect(finishProjectFileRelocation).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes.find((item) => item.id === 'a')?.data.filePath).toBe(path);
  });

  it('复制节点使用独立文件，入组和重新生成不影响另一节点', async () => {
    const original = `${PROJECT_DIR}/original.png`;
    useAppStore.setState({ nodes: [{
      ...node('a'), type: 'ai-image',
      data: { label: 'image', type: 'ai-image', filePath: original, imageUrl: `asset://${original}` },
    }, node('b')] });
    await useAppStore.getState().duplicateNode('a');
    const clone = useAppStore.getState().nodes.find((n) => n.id !== 'a' && n.id !== 'b')!;
    createGroup(['a', 'b']);
    await useAppStore.getState().syncGroupFiles();
    expect(useAppStore.getState().nodes.find((n) => n.id === clone.id)?.data.filePath).toBe(`${PROJECT_DIR}/copied.png`);

    const regenerated = `${PROJECT_DIR}/regenerated.png`;
    useAppStore.getState().updateNodeData('a', { filePath: regenerated, imageUrl: `asset://${regenerated}` });
    await useAppStore.getState().syncGroupFiles();
    expect(useAppStore.getState().nodes.find((n) => n.id === 'a')?.data.filePath)
      .toBe(`${PROJECT_DIR}/分组/regenerated.png`);
    expect(useAppStore.getState().nodes.find((n) => n.id === clone.id)?.data.imageUrl).toBe(`asset://${PROJECT_DIR}/copied.png`);
  });

  it('旧分镜格与图片共用文件时，归档先拆分独立副本再迁移最后一个引用', async () => {
    const path = `${PROJECT_DIR}/shared.png`;
    useAppStore.setState({ nodes: [
      { ...node('a'), data: { ...node('a').data, filePath: path, imageUrl: `asset://${path}` } },
      { ...node('b'), data: { ...node('b').data, storyboardOverrides: [{ filePath: path.replaceAll('/', '\\'), url: `asset://${path}` }] } },
    ] });
    createGroup(['a', 'b']);
    await useAppStore.getState().syncGroupFiles();
    const calls = moveProjectFileToFolder.mock.calls.filter(([file]) => !!file);
    expect(calls).toHaveLength(2);
    expect(calls[0][3]?.forceCopy).toBe(true);
    expect(calls[1][3]?.forceCopy).toBe(false);
    expect(calls.every((call) => call[3]?.preserveSource)).toBe(true);
  });

  it('文件移动期间切换项目，不把旧结果写入新项目的同名节点', async () => {
    const path = `${PROJECT_DIR}/a.png`;
    useAppStore.setState({ nodes: [{ ...node('a'), data: { ...node('a').data, filePath: path } }, node('b')] });
    createGroup(['a', 'b']);
    let finish!: (path: string) => void;
    moveProjectFileToFolder.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const syncing = useAppStore.getState().syncGroupFiles();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    useAppStore.setState({ currentProjectId: 'p2', nodes: [{ ...node('a'), data: { ...node('a').data, filePath: path } }] });
    finish(`${PROJECT_DIR}/分组/a.png`);
    await syncing;
    expect(useAppStore.getState().nodes[0].data.filePath).toBe(path);
  });

  it('创建分组时用不重名的分组名建文件夹', () => {
    createGroup(['a', 'b']);
    createGroup(['c', 'd']);

    expect(useAppStore.getState().groups.map((g) => g.name)).toEqual(['分组', '分组 2']);
    expect(ensureGroupFolder.mock.calls).toEqual([
      ['p1', '分组'],
      ['p1', '分组 2'],
    ]);
  });

  it('改名时同步重命名文件夹并更新分组节点标签', async () => {
    createGroup(['a', 'b']);
    const groupId = useAppStore.getState().groups[0].id;

    useAppStore.getState().renameGroup(groupId, '镜头一');

    expect(ensureGroupFolder).toHaveBeenCalledWith('p1', '镜头一');
    expect(renameGroupFolder).not.toHaveBeenCalled();
    expect(useAppStore.getState().groups[0].name).toBe('镜头一');
    expect(useAppStore.getState().nodes.find((n) => n.id === groupId)?.data.label).toBe('镜头一');
    await vi.waitFor(() => expect(removeEmptyProjectGroupFolder).toHaveBeenCalledWith(PROJECT_DIR, '分组'));
  });

  it('文件跟着分组走：入组搬进分组文件夹，出组搬回项目根目录', async () => {
    const media = (id: string): Node<BaseNodeData> => ({
      id,
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: {
        label: id,
        type: 'ai-image',
        filePath: `${PROJECT_DIR}/${id}.png`,
        imageUrl: `asset://${PROJECT_DIR}/${id}.png`,
        thumbnailUrl: `asset://${PROJECT_DIR}/${id}.png`,
      },
    });
    useAppStore.setState({ nodes: [media('a'), media('b')] });

    createGroup(['a', 'b']);
    await useAppStore.getState().syncGroupFiles();

    const grouped = useAppStore.getState().nodes.find((n) => n.id === 'a')!;
    expect(grouped.data.filePath).toBe(`${PROJECT_DIR}/分组/a.png`);
    expect(grouped.data.relativePath).toBe('分组/a.png');
    expect(grouped.data.imageUrl).toBe(`asset://${PROJECT_DIR}/分组/a.png`);
    expect(grouped.data.thumbnailUrl).toBe(`asset://${PROJECT_DIR}/分组/a.png`);

    // 再跑一次：文件已在目标目录，不应重复搬运
    moveProjectFileToFolder.mockClear();
    await useAppStore.getState().syncGroupFiles();
    expect(useAppStore.getState().nodes.find((n) => n.id === 'a')!.data.filePath)
      .toBe(`${PROJECT_DIR}/分组/a.png`);

    useAppStore.setState({ selectedNodeIds: ['a', 'b'] });
    useAppStore.getState().ungroupSelectedNodes();
    await useAppStore.getState().syncGroupFiles();

    const ungrouped = useAppStore.getState().nodes.find((n) => n.id === 'a')!;
    expect(ungrouped.data.filePath).toBe(`${PROJECT_DIR}/a.png`);
    expect(ungrouped.data.relativePath).toBe('a.png');
  });

  it('分组改名后节点路径改写到新文件夹', async () => {
    useAppStore.setState({
      nodes: [{
        id: 'a',
        type: 'ai-image',
        parentId: 'g1',
        position: { x: 0, y: 0 },
        data: {
          label: 'a',
          type: 'ai-image',
          filePath: `${PROJECT_DIR}/分组/a.png`,
          imageUrl: `asset://${PROJECT_DIR}/分组/a.png`,
          relativePath: '分组/a.png',
          storyboardOverrides: [{ url: `asset://${PROJECT_DIR}/分组/cell.png`, filePath: `${PROJECT_DIR}/分组/cell.png` }],
        },
      } as Node<BaseNodeData>],
      groups: [{ id: 'g1', name: '分组', nodeIds: ['a'], color: '#fff', createdAt: 0 }],
    });

    useAppStore.getState().renameGroup('g1', 'Na');
    await vi.waitFor(() => {
      expect(useAppStore.getState().nodes[0].data.filePath).toBe(`${PROJECT_DIR}/Na/a.png`);
    });

    const data = useAppStore.getState().nodes[0].data;
    expect(data.relativePath).toBe('Na/a.png');
    expect(data.imageUrl).toBe(`asset://${PROJECT_DIR}/Na/a.png`);
    expect(data.storyboardOverrides?.[0]?.filePath).toBe(`${PROJECT_DIR}/Na/cell.png`);
    expect(data.storyboardOverrides?.[0]?.url).toBe(`asset://${PROJECT_DIR}/Na/cell.png`);
  });

  it('同名改名不触发文件夹操作', () => {
    createGroup(['a', 'b']);
    const groupId = useAppStore.getState().groups[0].id;

    useAppStore.getState().renameGroup(groupId, '分组');

    expect(renameGroupFolder).not.toHaveBeenCalled();
  });
});


describe('action-scoped group settlement geometry', () => {
  const groupNode = (id: string, parentId?: string): Node<BaseNodeData> => ({
    ...node(id), type: 'group', parentId, width: 1000, height: 1000, data: { ...node(id).data, groupId: id },
  });
  const record = (id: string, nodeIds: string[]) => ({ id, name: id, nodeIds, color: '#888888', createdAt: 0 });

  it('keeps the old overlapping group and reads its dimensions once for a whole dragged batch', () => {
    const old = groupNode('old'), first = groupNode('first');
    const reads = vi.fn(() => 1000);
    Object.defineProperty(old, 'width', { get: reads, enumerable: true });
    const members = Array.from({ length: 80 }, (_, index) => ({ ...node(`member-${index}`), parentId: old.id,
      position: { x: 10 + index, y: 20 } }));
    useAppStore.setState({ nodes: [first, old, ...members], groups: [record(first.id, []), record(old.id, members.map((member) => member.id))] });
    const before = useAppStore.getState();
    before.settleNodeGroupingOnDragStop(members);
    expect(useAppStore.getState()).toBe(before);
    expect(reads).toHaveBeenCalledOnce();
    expect(useAppStore.getState().nodes.slice(2)).toEqual(members);
  });

  it('retains first-hit group order for unowned nodes and removes an emptied old group only after the batch', () => {
    const first = groupNode('first'), second = groupNode('second'), old = { ...groupNode('old'), position: { x: 2000, y: 0 } };
    const fresh = { ...node('fresh'), position: { x: 30, y: 40 } };
    const moved = { ...node('moved'), parentId: old.id, position: { x: -1980, y: 20 } };
    useAppStore.setState({ nodes: [old, first, second, fresh, moved],
      groups: [record(old.id, [moved.id]), record(first.id, []), record(second.id, [])] });
    useAppStore.getState().settleNodeGroupingOnDragStop([fresh, moved]);
    const state = useAppStore.getState();
    expect(state.nodes.find((item) => item.id === fresh.id)).toMatchObject({ parentId: first.id, position: fresh.position });
    expect(state.nodes.find((item) => item.id === moved.id)).toMatchObject({ parentId: first.id, position: { x: 20, y: 20 } });
    expect(state.groups.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(state.groups[0].nodeIds).toEqual([fresh.id, moved.id]);
    expect(state.history).toHaveLength(1);
  });

  it('preserves cycle-safe ancestor offsets and counts group children when deciding whether the old group is empty', () => {
    const a = { ...groupNode('a', 'b'), position: { x: 100, y: 0 } };
    const b = { ...groupNode('b', 'a'), position: { x: 0, y: 200 } };
    const child = { ...node('child'), parentId: a.id, position: { x: 1600, y: 30 } };
    useAppStore.setState({ nodes: [a, b, child], groups: [record(a.id, [child.id]), record(b.id, [])] });
    useAppStore.getState().settleNodeGroupingOnDragStop(child);
    const state = useAppStore.getState();
    expect(state.nodes.find((item) => item.id === child.id)).toMatchObject({ parentId: undefined, position: { x: 1700, y: 230 } });
    expect(state.nodes.find((item) => item.id === a.id)).toBe(a);
    expect(state.nodes.find((item) => item.id === b.id)).toBe(b);
    expect(state.groups.map((item) => item.id)).toEqual([a.id, b.id]);
  });
});

describe('分组开合自动让位', () => {
  function group(id: string, x: number, width: number, y = 100, parentId?: string): Node<BaseNodeData> {
    return {
      id, type: 'group', parentId, position: { x, y }, width, height: 600,
      style: { width, height: 600 }, measured: { width, height: 600 },
      data: { type: 'comment', label: id, groupId: id },
    };
  }
  function scene(extra: Node<BaseNodeData>[] = []) {
    const a = group('shift-a', 0, 1000);
    const b = group('shift-b', 1100, 600);
    const child = { ...node('shift-child'), parentId: b.id, position: { x: 20, y: 40 } };
    const tail = { ...node('shift-tail'), position: { x: 1800, y: 100 } };
    const nodes = [a, b, child, tail, ...extra];
    useAppStore.setState({ nodes, edges: [{ id: 'shift-edge', source: child.id, target: tail.id }],
      groups: nodes.filter((item) => item.type === 'group').map((item) => ({
        id: item.id, name: item.id, nodeIds: nodes.filter((child) => child.parentId === item.id).map((child) => child.id),
        color: '#888888', createdAt: 0,
      })) });
    return { a, b, child, tail };
  }
  const current = (id: string) => useAppStore.getState().nodes.find((item) => item.id === id)!;
  const toggle = (id: string) => useAppStore.getState().toggleGroupCollapsed(id);

  it('同排右侧整体平移宽差，保留间距、组内相对坐标与连线，往返还原', () => {
    const { a, b, child, tail } = scene();
    const edges = useAppStore.getState().edges;
    toggle(a.id);
    expect(current(b.id).position).toEqual({ x: 320, y: 100 });
    expect(current(tail.id).position).toEqual({ x: 1020, y: 100 });
    expect(current(b.id).position.x - (current(a.id).position.x + current(a.id).width!)).toBe(100);
    expect(current(tail.id).position.x - (current(b.id).position.x + current(b.id).width!)).toBe(100);
    expect(current(child.id).position).toEqual(child.position);
    expect(current(child.id).data.groupLayoutOffsetX).toBeUndefined();
    expect(useAppStore.getState().edges).toBe(edges);
    toggle(a.id);
    expect(current(b.id).position).toEqual(b.position);
    expect(current(tail.id).position).toEqual(tail.position);
    expect(current(b.id).data.groupLayoutOffsetX ?? 0).toBe(0);
  });

  it('不移动左侧、其他行、不同父级和隐藏内容，展开不补推原本重叠的节点', () => {
    const left = { ...node('shift-left'), position: { x: -400, y: 100 } };
    const otherRow = { ...node('shift-other-row'), position: { x: 1500, y: 350 } };
    const nested = { ...node('shift-other-parent'), parentId: 'different-parent', position: { x: 1400, y: 100 } };
    const hidden = { ...node('shift-hidden'), hidden: true, position: { x: 1500, y: 100 } };
    const collected = { ...node('shift-collected'), position: { x: 1600, y: 100 },
      data: { ...node('shift-collected').data, hiddenByCharacterLibrary: true } };
    const overlap = { ...node('shift-overlap'), position: { x: 500, y: 100 } };
    const others = [left, otherRow, nested, hidden, collected, overlap];
    const { a } = scene(others);
    toggle(a.id);
    for (const item of others) expect(current(item.id).position).toEqual(item.position);
    toggle(a.id);
    for (const item of others) expect(current(item.id).position).toEqual(item.position);
  });

  it('同一父分组内只移动同层根节点，不重写子树坐标', () => {
    const parent = group('shift-parent', 300, 3000, 400);
    const a = group('shift-nested-a', 30, 1000, 60, parent.id);
    const b = group('shift-nested-b', 1130, 600, 60, parent.id);
    const child = { ...node('shift-nested-child'), parentId: b.id, position: { x: 24, y: 38 } };
    const outside = { ...node('shift-outside'), position: { x: 1430, y: 460 } };
    useAppStore.setState({ nodes: [parent, a, b, child, outside], groups: [] });
    toggle(a.id);
    expect(current(b.id).position).toEqual({ x: 350, y: 60 });
    expect(current(child.id).position).toEqual(child.position);
    expect(current(parent.id).position).toEqual(parent.position);
    expect(current(outside.id).position).toEqual(outside.position);
    toggle(a.id);
    expect(current(b.id).position).toEqual(b.position);
  });

  it.each([
    ['shift-a', 'shift-b', 'shift-a', 'shift-b'],
    ['shift-a', 'shift-b', 'shift-b', 'shift-a'],
    ['shift-b', 'shift-a', 'shift-a', 'shift-b'],
    ['shift-b', 'shift-a', 'shift-b', 'shift-a'],
  ])('多个分组按 %s → %s → %s → %s 开合后不累积漂移', (...sequence) => {
    const { b, tail } = scene();
    for (let count = 0; count < 3; count++) {
      sequence.forEach(toggle);
      expect(current(b.id).position).toEqual(b.position);
      expect(current(tail.id).position).toEqual(tail.position);
      expect(current(tail.id).data.groupLayoutOffsetX ?? 0).toBe(0);
    }
  });

  it('锁定同排节点作为锚点，后面一段不被拉向左侧', () => {
    const { a, b, tail } = scene();
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === b.id
      ? { ...item, draggable: false } : item) });
    toggle(a.id);
    expect(current(b.id).position).toEqual(b.position);
    expect(current(tail.id).position).toEqual(tail.position);
    toggle(a.id);
    expect(current(tail.id).position).toEqual(tail.position);
  });

  it('旧折叠分组没有让位账时只展开尺寸，不推移周边内容', () => {
    const { a, b, tail } = scene();
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === a.id ? {
      ...item, width: 220, height: 152, style: { width: 220, height: 152 },
      data: { ...item.data, groupCollapsed: true, groupExpandedSize: { width: 1000, height: 600 } },
    } : item) });
    toggle(a.id);
    expect(current(a.id).width).toBe(1000);
    expect(current(b.id).position).toEqual(b.position);
    expect(current(tail.id).position).toEqual(tail.position);
  });

  it('折叠后的手动位移保留，序列化回载后展开仅归还自动让位', () => {
    const { a, tail } = scene();
    toggle(a.id);
    useAppStore.getState().onNodesChange([{ id: tail.id, type: 'position', position: { x: 1070, y: 100 } }]);
    const saved = JSON.parse(JSON.stringify({ nodes: useAppStore.getState().nodes, groups: useAppStore.getState().groups })) as
      Pick<ReturnType<typeof useAppStore.getState>, 'nodes' | 'groups'>;
    useAppStore.setState({ nodes: [], groups: [] });
    useAppStore.setState(saved);
    toggle(a.id);
    expect(current(tail.id).position).toEqual({ x: tail.position.x + 50, y: tail.position.y });
  });

  it('纯开合让位不新增历史或截断重做，移动撤销仍保留当前折叠展示', async () => {
    const { a, tail } = scene();
    const state = useAppStore.getState();
    state.commitToHistory();
    const baseline = useAppStore.getState().history;
    toggle(a.id); state.commitToHistory();
    expect(useAppStore.getState().history).toBe(baseline);
    state.onNodesChange([{ id: tail.id, type: 'position', position: { x: 1070, y: 100 } }]);
    expect(await state.undo()).toBe(true);
    expect(current(a.id).data.groupCollapsed).toBe(true);
    expect(current(tail.id).position).toEqual({ x: 1020, y: 100 });
    const { history, historyIndex } = useAppStore.getState();
    toggle(a.id);
    expect(current(tail.id).position).toEqual(tail.position);
    expect(useAppStore.getState().history).toBe(history);
    expect(useAppStore.getState().historyIndex).toBe(historyIndex);
    expect(await state.redo()).toBe(true);
    expect(current(tail.id).position).toEqual({ x: 1850, y: 100 });
    expect(current(a.id).data.groupCollapsed).toBeUndefined();
  });

  it.each([
    { groupX: -1000, followerX: 0.1 },
    { groupX: -1000.7, followerX: -0.100000123456 },
  ])('小数负坐标开合不新增历史或截断重做，真实位移仍可撤销：$followerX', async ({ groupX, followerX }) => {
    const a = group('fraction-source', groupX, 1000, -100.2);
    const follower = { ...node('fraction-follower'), position: { x: followerX, y: -100.2 } };
    useAppStore.setState({ nodes: [a, follower], edges: [], groups: [
      { id: a.id, name: a.id, nodeIds: [], color: '#888888', createdAt: 0 },
    ] });
    const state = useAppStore.getState();
    state.commitToHistory();
    const baseline = useAppStore.getState().history;
    for (let count = 0; count < 3; count++) {
      toggle(a.id); state.commitToHistory();
      expect(useAppStore.getState().history).toBe(baseline);
      toggle(a.id); state.commitToHistory();
      expect(useAppStore.getState().history).toBe(baseline);
      expect(current(follower.id).position.x).toBeCloseTo(followerX, 11);
    }
    toggle(a.id); state.commitToHistory();
    const manualDelta = 0.00123;
    state.onNodesChange([{ id: follower.id, type: 'position', position: {
      x: current(follower.id).position.x + manualDelta, y: follower.position.y,
    } }]);
    expect(await state.undo()).toBe(true);
    expect(current(follower.id).position.x).toBeCloseTo(followerX - 780, 11);
    const { history, historyIndex } = useAppStore.getState();
    toggle(a.id); toggle(a.id);
    expect(useAppStore.getState().history).toBe(history);
    expect(useAppStore.getState().historyIndex).toBe(historyIndex);
    expect(await state.redo()).toBe(true);
    expect(current(follower.id).position.x).toBeCloseTo(followerX - 780 + manualDelta, 11);
    toggle(a.id);
    expect(current(follower.id).position.x).toBeCloseTo(followerX + manualDelta, 11);
  });

  it('折叠态撤销重做分组缩放，展开使用还原后的宽度与相应让位', async () => {
    const { a, tail } = scene();
    const state = useAppStore.getState();
    state.commitToHistory();
    state.onNodesChange([{ id: a.id, type: 'dimensions', dimensions: { width: 900, height: 600 }, setAttributes: true }]);
    state.commitToHistory();
    toggle(a.id);
    expect(current(tail.id).position.x).toBe(1120);
    expect(await state.undo()).toBe(true);
    expect(current(a.id).data.groupExpandedSize?.width).toBe(1000);
    expect(current(tail.id).position.x).toBe(1020);
    expect(await state.redo()).toBe(true);
    expect(current(a.id).data.groupExpandedSize?.width).toBe(900);
    expect(current(tail.id).position.x).toBe(1120);
    toggle(a.id);
    expect(current(tail.id).position.x).toBe(tail.position.x);
  });

  it('复制节点和粘贴文件夹使用新布局身份，不继承旧偏移或操作原节点的名单', async () => {
    const { a, b, tail } = scene();
    toggle(a.id);
    const duplicateId = await useAppStore.getState().duplicateNode(tail.id);
    expect(duplicateId).toBeDefined();
    expect(current(duplicateId!).position).toEqual(current(tail.id).position);
    expect(current(duplicateId!).data.groupLayoutOffsetX).toBeUndefined();
    useAppStore.setState({ selectedNodeIds: [a.id, b.id] });
    expect(useAppStore.getState().copySelectedNodes()).toBe(true);
    const known = new Set(useAppStore.getState().nodes.map((item) => item.id));
    await useAppStore.getState().pasteNodes({ x: 300, y: 300 });
    const pasted = useAppStore.getState().nodes.filter((item) => !known.has(item.id));
    expect(pasted.length).toBeGreaterThan(0);
    for (const item of pasted) {
      expect(item.data.groupLayoutOffsetX).toBeUndefined();
      expect(item.data.groupCollapseLayout).toBeUndefined();
    }
    const originalPositions = new Map([a.id, b.id, tail.id].map((id) => [id, { ...current(id).position }]));
    const pastedFolder = pasted.find((item) => item.type === 'group' && item.data.groupCollapsed)!;
    toggle(pastedFolder.id);
    for (const [id, position] of originalPositions) expect(current(id).position).toEqual(position);
  });

  it('让位节点拖入再拖出分组后保持可见坐标，不重新继承旧名单', () => {
    const target = group('shift-target', 2000, 500, 1000);
    const { a, tail } = scene([target]);
    toggle(a.id);
    const entered = { ...current(tail.id), position: { x: 2050, y: 1050 } };
    useAppStore.getState().settleNodeGroupingOnDragStop(entered);
    expect(current(tail.id)).toMatchObject({ parentId: target.id, position: { x: 50, y: 50 } });
    expect(current(tail.id).data.groupLayoutOffsetX).toBeUndefined();
    expect(current(a.id).data.groupCollapseLayout?.nodeIds).not.toContain(tail.id);
    const departed = { ...current(tail.id), position: { x: -930, y: -900 } };
    useAppStore.getState().settleNodeGroupingOnDragStop(departed);
    expect(current(tail.id)).toMatchObject({ parentId: undefined, position: { x: 1070, y: 100 } });
    toggle(a.id);
    expect(current(tail.id).position).toEqual({ x: 1070, y: 100 });
  });

  it('笔记复制同样清除自动偏移，原笔记的让位身份保留', async () => {
    const source: Node<BaseNodeData> = { id: 'shift-note', type: 'canvas-note', position: { x: 1800, y: 100 },
      data: { type: 'canvas-note', label: '笔记', note: createCanvasNoteData('text', { text: '文字' }) } };
    const { a } = scene([source]);
    toggle(a.id);
    expect(current(source.id).data.groupLayoutOffsetX).toBe(-780);
    const id = await useAppStore.getState().duplicateCanvasNote(source.id);
    expect(id).toBeTruthy();
    expect(current(id!).data.groupLayoutOffsetX).toBeUndefined();
    expect(current(id!).data.groupCollapseLayout).toBeUndefined();
    expect(current(source.id).data.groupLayoutOffsetX).toBe(-780);
    expect(current(id!).data.note?.text).toBe('文字');
  });

  it('通过缩放吸纳让位节点时清除旧父层贡献，展开不移动新成员', () => {
    const target = { ...group('shift-capture', 900, 200, 0), height: 50,
      measured: { width: 200, height: 50 }, style: { width: 200, height: 50 } };
    const { a, tail } = scene([target]);
    const state = useAppStore.getState();
    toggle(a.id);
    state.commitToHistory();
    state.onNodesChange([{ id: target.id, type: 'dimensions', dimensions: { width: 600, height: 400 }, setAttributes: true }]);
    state.settleGroupMembersOnResizeEnd(target.id);
    expect(current(tail.id)).toMatchObject({ parentId: target.id, position: { x: 120, y: 100 } });
    expect(current(tail.id).data.groupLayoutOffsetX).toBeUndefined();
    expect(current(a.id).data.groupCollapseLayout?.nodeIds).not.toContain(tail.id);
    toggle(a.id);
    expect(current(tail.id).position).toEqual({ x: 120, y: 100 });
  });

  it('让位后换组再撤销，恢复原父层的自动偏移关系', async () => {
    const target = group('shift-undo-target', 2000, 500, 1000);
    const { a, tail } = scene([target]);
    toggle(a.id);
    useAppStore.getState().settleNodeGroupingOnDragStop({ ...current(tail.id), position: { x: 2050, y: 1050 } });
    expect(current(tail.id).parentId).toBe(target.id);
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(current(a.id).data.groupCollapsed).toBe(true);
    expect(current(a.id).data.groupCollapseLayout?.nodeIds).toContain(tail.id);
    expect(current(tail.id)).toMatchObject({ parentId: undefined, position: { x: 1020, y: 100 },
      data: { groupLayoutOffsetX: -780 } });
  });

  it('解散折叠源后归还让位，撤销复活源时恢复收起展示', async () => {
    const { a, b, tail } = scene();
    toggle(a.id);
    useAppStore.setState({ selectedNodeIds: [a.id] });
    useAppStore.getState().ungroupSelectedNodes();
    expect(useAppStore.getState().nodes.some((item) => item.id === a.id)).toBe(false);
    expect(current(b.id).position).toEqual(b.position);
    expect(current(tail.id).position).toEqual(tail.position);
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(current(a.id).data.groupCollapsed).toBe(true);
    expect(current(b.id).position).toEqual({ x: 320, y: 100 });
    expect(current(tail.id).position).toEqual({ x: 1020, y: 100 });
  });
});
