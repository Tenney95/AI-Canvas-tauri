/**
 * Node slice — canvas nodes / edges core state and CRUD
 */
import type { Node, Edge, Connection } from '@xyflow/react';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { BaseNodeData } from '../types';
import { generateId, getNextDisplayId } from './store.utils';
import * as fileService from '../services/fileService';
import { playNodeExit } from '../utils/nodeAnimations';

export interface NodeSlice {
  nodes: Node<BaseNodeData>[];
  edges: Edge[];
  selectedNodeIds: string[];
  setNodes: (nodes: Node<BaseNodeData>[]) => void;
  setEdges: (edges: Edge[]) => void;
  setSelectedNodeIds: (ids: string[]) => void;
  addNode: (node: Node<BaseNodeData>) => void;
  addNodeWithEdge: (node: Node<BaseNodeData>, edge: Edge) => void;
  updateNodeData: (nodeId: string, data: Partial<BaseNodeData>) => void;
  deleteNode: (nodeId: string) => void;
  onConnect: (connection: Connection) => void;
  onNodesChange: (changes: unknown[]) => void;
  onEdgesChange: (changes: unknown[]) => void;
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

  updateNodeData: (nodeId, data) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...data } as BaseNodeData } : n
      ),
    })),

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
      if (n) fileService.deleteNodeFile(n.data as BaseNodeData).catch(() => {});
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

  onNodesChange: (_changes) => {
    // React Flow handles most node changes internally via onNodesChange callback
  },

  onEdgesChange: (_changes) => {
    // React Flow handles most edge changes internally via onEdgesChange callback
  },
});
