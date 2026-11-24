/**
 * aiAppCreation — 回归测试：AI 应用创建入口。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Node } from '@xyflow/react';
import type { AppState } from '../../src/store/useAppStore';
import type { BaseNodeData } from '../../src/types';

const driver = vi.hoisted(() => ({
  store: null as StoreApi<AppState> | null,
  states: [] as unknown[],
  stateIndex: 0,
}));

vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((selector: (state: AppState) => unknown) => selector(driver.store!.getState()), {
    getState: () => driver.store!.getState(),
    setState: (state: Partial<AppState>) => driver.store!.setState(state),
  }),
}));
vi.mock('../../src/store/store.chat', () => ({ BATCH_NODE_LIMIT: 10 }));
vi.mock('../../src/services/fileService', () => ({
  waitForPendingNodeFileDeletions: vi.fn(async () => undefined),
  resolveGroupUndoTrashPaths: vi.fn(async () => []),
  resolveNodeUndoTrashPaths: vi.fn(async () => []),
  collectNodeFileReferences: vi.fn(() => new Set<string>()),
  deleteNodeFiles: vi.fn(async () => undefined),
  deletedGroupFolderNames: vi.fn(() => []),
}));
vi.mock('../../src/services/pollManager', () => ({ cancelNodePolling: vi.fn() }));
vi.mock('../../src/utils/nodeAnimations', () => ({
  playNodeExit: vi.fn(async () => undefined),
  waitForPendingNodeExits: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/plugins/pluginRuntime', () => ({ getAvailableNodePluginTools: () => [] }));
vi.mock('../../src/i18n', () => ({ useT: () => (value: string) => value }));
vi.mock('../../src/utils/textSelection', () => ({ getActiveTextSelection: () => null }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useCallback: <T,>(value: T) => value,
  useMemo: <T,>(factory: () => T) => factory(),
  useEffect: () => undefined,
  useRef: <T,>(value: T) => ({ current: value }),
  useState: <T,>(initial: T) => {
    const index = driver.stateIndex++;
    if (!(index in driver.states)) driver.states[index] = initial;
    return [driver.states[index], (value: T) => { driver.states[index] = value; }];
  },
}));

import { createNodeSlice } from '../../src/store/store.nodes';
import { createClipboardSlice } from '../../src/store/store.clipboard';
import { createHistorySlice } from '../../src/store/store.history';
import { useNodeContextMenu } from '../../src/hooks/useNodeContextMenu';
import { AI_APP_COPY_MESSAGE, allowAiAppNodeInsertion } from '../../src/services/aiApps/aiAppCreation';

function node(id: string, type: BaseNodeData['type'] = 'ai-text'): Node<BaseNodeData> {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, status: 'idle' } };
}

function aiAppNode(id = 'app'): Node<BaseNodeData> {
  return {
    ...node(id, 'ai-app'),
    data: {
      ...node(id, 'ai-app').data,
      aiApp: {
        version: 1, instanceId: id, revision: 1, title: id, description: '',
        definition: { relativePath: 'ai-apps/definition.json', sha256: 'a'.repeat(64), bytes: 1 },
        actions: [], inputNodeIds: [], savedState: { filter: 'all' }, savedResult: { count: 3 },
      },
    },
  };
}

function state() { return driver.store!.getState(); }

beforeEach(() => {
  driver.states = [];
  driver.stateIndex = 0;
  driver.store = createStore<AppState>()((set, get, api) => ({
    ...createNodeSlice(set, get, api),
    ...createClipboardSlice(set, get, api),
    ...createHistorySlice(set, get, api),
    currentProjectId: 'project', projects: [], groups: [], messages: [], installedPlugins: [],
    config: { autoMentionOnConnect: false }, showToast: vi.fn(),
  } as unknown as AppState));
});

describe('AI 应用创建入口', () => {
  const insertions: Array<[string, (store: AppState, app: Node<BaseNodeData>) => unknown]> = [
    ['addNode', (store, app) => store.addNode(app)],
    ['addNodeTransient', (store, app) => store.addNodeTransient(app)],
    ['addNodes', (store, app) => store.addNodes([node('ordinary'), app])],
    ['addNodesTransient', (store, app) => store.addNodesTransient([node('ordinary'), app])],
    ['addNodesWithEdges', (store, app) => store.addNodesWithEdges([app], [])],
    ['addNodeWithEdge', (store, app) => store.addNodeWithEdge(app, { id: 'edge', source: 'source', target: app.id })],
    ['addNodeFromSelection', (store, app) => store.addNodeFromSelection(app, [], 'project')],
    ['onNodesChange add', (store, app) => store.onNodesChange([{ type: 'add', item: app }])],
    ['onNodesChange replace', (store, app) => store.onNodesChange([{ type: 'replace', id: 'source', item: app }])],
  ];

  it.each(insertions)('%s 拒绝普通创建，并保持节点和历史不变', (_name, insert) => {
    state().setNodes([node('source')]);
    expect(() => insert(state(), aiAppNode())).toThrow('只能由内部 Agent 或 MCP 创建');
    expect(state().nodes.map((item) => item.id)).toEqual(['source']);
    expect(state().history).toEqual([]);
    expect(state().edges).toEqual([]);
  });

  it('专用授权只允许精确对象插入一次，副本与回调结束后的调用都会拒绝', () => {
    const app = aiAppNode();
    allowAiAppNodeInsertion(app, () => {
      expect(() => state().addNode({ ...app })).toThrow('只能由内部 Agent 或 MCP 创建');
      state().addNode(app);
      expect(() => state().addNodeTransient(app)).toThrow('只能由内部 Agent 或 MCP 创建');
    });
    expect(() => state().addNode(app)).toThrow('只能由内部 Agent 或 MCP 创建');
    expect(state().nodes).toHaveLength(1);
  });

  it('授权不能跨异步等待，异常退出后也不会留下授权', async () => {
    const app = aiAppNode();
    await expect(allowAiAppNodeInsertion(app, async () => {
      await Promise.resolve();
      state().addNode(app);
    })).rejects.toThrow('只能由内部 Agent 或 MCP 创建');
    expect(() => allowAiAppNodeInsertion(app, () => { throw new Error('停止'); })).toThrow('停止');
    expect(() => state().addNode(app)).toThrow('只能由内部 Agent 或 MCP 创建');
  });

  it.each(['type', 'data.type'])('不允许只伪装 %s 或用授权插入不一致的类型', (field) => {
    const app = node('app');
    if (field === 'type') app.type = 'ai-app';
    else app.data.type = 'ai-app';
    expect(() => allowAiAppNodeInsertion(app, () => state().addNode(app)))
      .toThrow('只能由内部 Agent 或 MCP 创建');
  });

  it('不能用普通节点数据更新变成 AI 应用', () => {
    state().setNodes([node('source')]);
    expect(() => state().updateNodeData('source', { type: 'ai-app' })).toThrow('只能由内部 Agent 或 MCP 创建');
    expect(() => state().updateNodeDataTransient('source', { type: 'ai-app' })).toThrow('只能由内部 Agent 或 MCP 创建');
    expect(() => state().updateNodesDataBatch(['source'], { type: 'ai-app' })).toThrow('只能由内部 Agent 或 MCP 创建');
    expect(state().nodes[0].data.type).toBe('ai-text');
    expect(state().history).toEqual([]);
  });
});

describe('AI 应用复制与恢复', () => {
  it('含嵌套 AI 应用的分组整批拒绝复制，并清空旧剪贴板', () => {
    const group = { ...node('group'), type: 'group' };
    const inner = { ...node('inner'), type: 'group', parentId: 'group' };
    state().setNodes([group, inner, { ...aiAppNode(), parentId: 'inner' }, node('ordinary')]);
    driver.store!.setState({ selectedNodeIds: ['ordinary'] });
    expect(state().copySelectedNodes()).toBe(true);
    driver.store!.setState({ selectedNodeIds: ['group', 'ordinary'] });
    expect(state().copySelectedNodes()).toBe(false);
    expect(state().clipboard.nodes).toEqual([]);
    expect(state().showToast).toHaveBeenLastCalledWith(AI_APP_COPY_MESSAGE, 'error');
    expect(state().nodes).toHaveLength(4);
  });

  it('旧剪贴板与拖拽复制入口都不能产生新应用', async () => {
    const app = aiAppNode();
    state().setNodes([app]);
    driver.store!.setState({ clipboard: { nodes: [node('ordinary'), app], groups: [], projectId: 'project' } });
    await state().pasteNodes({ x: 30, y: 30 });
    expect(await state().duplicateNode(app.id)).toBeUndefined();
    expect(state().nodes).toEqual([app]);
    expect(state().history).toEqual([]);
  });

  it('右键剪切和创建副本失败后保留节点，不继续删除或粘贴旧内容', () => {
    const app = aiAppNode();
    state().setNodes([app]);
    driver.store!.setState({ selectedNodeIds: [app.id], deleteNode: vi.fn(), pasteNodes: vi.fn() });
    let menu = useNodeContextMenu();
    menu.openMenu({ preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0 } as React.MouseEvent, app);
    driver.stateIndex = 0;
    menu = useNodeContextMenu();
    menu.handleCut();
    menu.handleDuplicate();
    expect(state().deleteNode).not.toHaveBeenCalled();
    expect(state().pasteNodes).not.toHaveBeenCalled();
    expect(state().nodes).toEqual([app]);
    expect(state().showToast).toHaveBeenLastCalledWith(AI_APP_COPY_MESSAGE, 'error');
  });

  it.each(['app', 'other'])('右键删除 %s 时按菜单实际选区删除节点', async (targetId) => {
    const nodes = [aiAppNode(), node('selected'), node('other')];
    state().setNodes(nodes);
    state().setSelectedNodeIds(['app', 'selected']);
    const target = nodes.find((item) => item.id === targetId)!;
    useNodeContextMenu().openMenu({ preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0 } as React.MouseEvent, target);
    driver.stateIndex = 0;
    useNodeContextMenu().handleDelete();
    await Promise.resolve();
    expect(state().nodes.map(({ id }) => id)).toEqual(targetId === 'app' ? ['other'] : ['app', 'selected']);
    expect(state().history).toHaveLength(1);
  });

  it('项目恢复允许现有应用，撤销与重做能还原定义版本和保存结果', async () => {
    const app = aiAppNode();
    state().setNodes([app]);
    const updated = {
      ...app.data.aiApp!, revision: 2,
      definition: { relativePath: 'ai-apps/revision-2.json', sha256: 'b'.repeat(64), bytes: 2 },
      savedState: { filter: 'selected' }, savedResult: { count: 1 },
    };
    state().updateNodeData(app.id, { aiApp: updated });
    expect(await state().undo()).toBe(true);
    expect(state().nodes[0].data.aiApp).toEqual(app.data.aiApp);
    expect(await state().redo()).toBe(true);
    expect(state().nodes[0].data.aiApp).toEqual(updated);
  });
});
