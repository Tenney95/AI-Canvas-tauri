/**
 * Node slice — canvas nodes / edges core state and CRUD
 */
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { BaseNodeData } from '../types';
import { generateId, getNextDisplayId } from './store.utils';
import * as fileService from '../services/fileService';
import { playNodeExit } from '../utils/nodeAnimations';

interface GroupNodeDataAccess {
  groupId: string;
}

export interface NodeSlice {
  nodes: Node<BaseNodeData>[];
  edges: Edge[];
  selectedNodeIds: string[];
  setNodes: (nodes: Node<BaseNodeData>[]) => void;
  setEdges: (edges: Edge[]) => void;
  setSelectedNodeIds: (ids: string[]) => void;
  addNode: (node: Node<BaseNodeData>) => void;
  addNodeWithEdge: (node: Node<BaseNodeData>, edge: Edge) => void;
  /** 在原位复制一个节点（新 id / displayId，不带边）—— 用于 Ctrl 拖拽复制 */
  duplicateNode: (nodeId: string) => void;
  updateNodeData: (nodeId: string, data: Partial<BaseNodeData>) => void;
  deleteNode: (nodeId: string) => void;
  onConnect: (connection: Connection) => void;
  onNodesChange: (changes: NodeChange<Node<BaseNodeData>>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  clearGroupedSelection: () => void;
  settleNodeGroupingOnDragStop: (node: Node<BaseNodeData>) => void;
}

export const createNodeSlice: StateCreator<AppState, [], [], NodeSlice> = (set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeIds: [],

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),

  addNode: (node) => {
    get().commitToHistory();
    set((state) => {
      const displayId = getNextDisplayId(state.nodes);
      return {
        nodes: [...state.nodes, { ...node, data: { ...node.data, displayId } } as Node<BaseNodeData>],
      };
    });
  },

  addNodeWithEdge: (node, edge) => {
    get().commitToHistory();
    set((state) => {
      const displayId = getNextDisplayId(state.nodes);
      return {
        nodes: [...state.nodes, { ...node, data: { ...node.data, displayId } } as Node<BaseNodeData>],
        edges: [...state.edges, edge],
      };
    });
  },

  updateNodeData: (nodeId, data) => {
    get().commitToHistory();
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...data } as BaseNodeData } : n
      ),
    }));
  },

  duplicateNode: (nodeId) => {
    const state = get();
    const src = state.nodes.find((n) => n.id === nodeId);
    // 分组节点暂不支持拖拽复制（涉及子节点/边重映射）
    if (!src || src.type === 'group') return;
    state.commitToHistory();

    // 身份对调：克隆留在原位，承接原节点的边与编号（= 不动的「原始」）；
    // 被拖动的那个节点改成新编号、断开所有边（= 拖出去的干净副本）。
    const cloneId = `node-${generateId()}`;
    const newDisplayId = getNextDisplayId(state.nodes);

    set((s) => {
      const clone = {
        ...src,
        id: cloneId,
        position: { ...src.position },
        selected: false,
        dragging: false,
      } as Node<BaseNodeData>;
      const nodes = s.nodes.map((n) =>
        n.id === nodeId
          ? ({ ...n, data: { ...n.data, displayId: newDisplayId } } as Node<BaseNodeData>)
          : n,
      );
      nodes.push(clone);
      // 原本指向被拖节点的边改指向克隆（边留在原位）
      const edges = s.edges.map((e) =>
        e.source === nodeId || e.target === nodeId
          ? { ...e, source: e.source === nodeId ? cloneId : e.source, target: e.target === nodeId ? cloneId : e.target }
          : e,
      );
      return { nodes, edges };
    });
  },

  deleteNode: (nodeId) => {
    get().commitToHistory();

    // Collect all node IDs to delete: self + descendants (for group nodes)
    const idsToDelete = new Set<string>([nodeId]);
    const { nodes } = get();
    const q = [nodeId];
    while (q.length > 0) {
      const pid = q.shift()!;
      nodes.filter((n) => n.parentId === pid).forEach((c) => {
        idsToDelete.add(c.id);
        q.push(c.id);
      });
    }

    // Delete local files for all affected nodes
    for (const id of idsToDelete) {
      const n = nodes.find((nn) => nn.id === id);
      if (n) fileService.deleteNodeFile(n.data as BaseNodeData).catch((e) => console.warn('[删除节点] 文件清理失败:', e));
    }

    // 先播放退场动画，结束后再真正从状态中移除（动画期间历史已提交，撤销仍指向删除前状态）
    playNodeExit([...idsToDelete]).then(() => {
      set((state) => ({
        nodes: state.nodes.filter((n) => !idsToDelete.has(n.id)),
        edges: state.edges.filter((e) => !idsToDelete.has(e.source) && !idsToDelete.has(e.target)),
        groups: state.groups
          .filter((g) => !idsToDelete.has(g.id))
          .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((nid) => !idsToDelete.has(nid)) })),
      }));
    });
  },

  onConnect: (connection) => {
    get().commitToHistory();
    const id = `edge-${generateId()}`;
    const edge: Edge = {
      id,
      source: connection.source!,
      target: connection.target!,
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
    };
    set((state) => ({ edges: [...state.edges, edge] }));
  },

  onNodesChange: (changes) => {
    const removedIds = changes
      .filter((c) => c.type === 'remove')
      .map((c) => c.id);

    if (removedIds.length === 0) {
      set((s) => ({
        nodes: applyNodeChanges(changes, s.nodes) as Node<BaseNodeData>[],
      }));
      return;
    }

    const state = get();
    const removedGroupNodes = state.nodes.filter(
      (n) => removedIds.includes(n.id) && n.type === 'group',
    );

    if (removedGroupNodes.length > 0) {
      state.commitToHistory();
      const groupNodeIdSet = new Set(removedGroupNodes.map((n) => n.id));
      const removedGroupDataIds = removedGroupNodes.map(
        (n) => (n.data as unknown as GroupNodeDataAccess).groupId,
      );

      const groupPositions = new Map(
        removedGroupNodes.map((gn) => [gn.id, gn.position]),
      );

      const repositioned = state.nodes
        .map((n) => {
          if (!n.parentId || !groupPositions.has(n.parentId)) return n;
          const gp = groupPositions.get(n.parentId)!;
          return {
            ...n,
            position: { x: n.position.x + gp.x, y: n.position.y + gp.y },
            parentId: undefined,
          };
        })
        .filter((n) => !groupNodeIdSet.has(n.id));

      const finalNodes = applyNodeChanges(
        changes.filter((c) => c.type !== 'remove' || !groupNodeIdSet.has(c.id)),
        repositioned,
      ) as Node<BaseNodeData>[];

      set((s) => ({
        nodes: finalNodes,
        edges: s.edges.filter(
          (e) => !removedIds.includes(e.source) && !removedIds.includes(e.target),
        ),
        groups: s.groups.filter((g) => !removedGroupDataIds.includes(g.id)),
      }));
      return;
    }

    state.commitToHistory();
    set((s) => ({
      nodes: applyNodeChanges(changes, s.nodes) as Node<BaseNodeData>[],
      edges: s.edges.filter(
        (e) => !removedIds.includes(e.source) && !removedIds.includes(e.target),
      ),
    }));
  },

  onEdgesChange: (changes) => {
    const hasRemoval = changes.some((c) => c.type === 'remove');
    if (hasRemoval) get().commitToHistory();
    set((s) => ({
      edges: applyEdgeChanges(changes, s.edges) as Edge[],
    }));
  },

  clearGroupedSelection: () => {
    set((s) => {
      if (!s.nodes.some((n) => n.selected && n.type !== 'group')) return {};
      let changed = false;
      const nodes = s.nodes.map((n) => {
        if (n.type === 'group' && n.selected) {
          changed = true;
          return { ...n, selected: false };
        }
        return n;
      });
      return changed ? { nodes } : {};
    });
  },

  settleNodeGroupingOnDragStop: (node) => {
    const state = get();
    const allNodes = state.nodes;

    if (node.type === 'group') return;

    const absPos = { x: node.position.x, y: node.position.y };
    let pid = node.parentId;
    while (pid) {
      const p = allNodes.find((n) => n.id === pid);
      if (!p) break;
      absPos.x += p.position.x;
      absPos.y += p.position.y;
      pid = p.parentId;
    }

    const nodeWidth = (node.data?.nodeWidth as number) || node.measured?.width || 280;
    const nodeHeight = (node.data?.nodeHeight as number) || node.measured?.height || 160;
    const nodeCenter = {
      x: absPos.x + nodeWidth / 2,
      y: absPos.y + nodeHeight / 2,
    };

    const groupNodes = allNodes.filter((n) => n.type === 'group');
    let newNodes = allNodes.map((n) => ({ ...n, position: { ...n.position } }));
    let newGroups = [...state.groups];
    let changed = false;

    if (node.parentId) {
      const parentNode = groupNodes.find((g) => g.id === node.parentId);
      if (parentNode) {
        const pw = (parentNode.style?.width as number) || 400;
        const ph = (parentNode.style?.height as number) || 300;
        const inside =
          nodeCenter.x >= parentNode.position.x &&
          nodeCenter.x <= parentNode.position.x + pw &&
          nodeCenter.y >= parentNode.position.y &&
          nodeCenter.y <= parentNode.position.y + ph;
        if (!inside) {
          newNodes = newNodes.map((n) => {
            if (n.id !== node.id) return n;
            return { ...n, position: absPos, parentId: undefined };
          });
          const gId = (parentNode.data as unknown as GroupNodeDataAccess).groupId;
          newGroups = newGroups.map((g) =>
            g.id === gId
              ? { ...g, nodeIds: g.nodeIds.filter((id) => id !== node.id) }
              : g,
          );
          changed = true;
        }
      }
    }

    const updatedNode = newNodes.find((n) => n.id === node.id);
    if (updatedNode && !updatedNode.parentId) {
      for (const gn of groupNodes) {
        const pw = (gn.style?.width as number) || 400;
        const ph = (gn.style?.height as number) || 300;
        if (
          nodeCenter.x >= gn.position.x &&
          nodeCenter.x <= gn.position.x + pw &&
          nodeCenter.y >= gn.position.y &&
          nodeCenter.y <= gn.position.y + ph
        ) {
          newNodes = newNodes.map((n) => {
            if (n.id !== node.id) return n;
            return {
              ...n,
              position: {
                x: absPos.x - gn.position.x,
                y: absPos.y - gn.position.y,
              },
              parentId: gn.id,
            };
          });
          const gId = (gn.data as unknown as GroupNodeDataAccess).groupId;
          newGroups = newGroups.map((g) =>
            g.id === gId
              ? { ...g, nodeIds: [...new Set([...g.nodeIds, node.id])] }
              : g,
          );
          changed = true;
          break;
        }
      }
    }

    if (!changed) return;

    const emptyGroupIds = new Set(
      groupNodes
        .filter((gn) => newNodes.filter((n) => n.parentId === gn.id).length === 0)
        .map((gn) => gn.id),
    );
    if (emptyGroupIds.size > 0) {
      newNodes = newNodes.filter((n) => !emptyGroupIds.has(n.id));
      const emptyDataIds = new Set(
        groupNodes
          .filter((gn) => emptyGroupIds.has(gn.id))
          .map((gn) => (gn.data as unknown as GroupNodeDataAccess).groupId)
          .filter(Boolean),
      );
      newGroups = newGroups.filter((g) => !emptyDataIds.has(g.id));
    }

    state.commitToHistory();
    set({ nodes: newNodes, groups: newGroups });
  },
});
