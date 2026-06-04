/**
 * History slice — undo / redo with capped history stack
 */
import type { Node, Edge } from '@xyflow/react';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { BaseNodeData, NodeGroup } from '../types';

export interface HistoryEntry {
  nodes: Node<BaseNodeData>[];
  edges: Edge[];
  groups: NodeGroup[];
}

const MAX_HISTORY = 50;

export interface HistorySlice {
  history: HistoryEntry[];
  historyIndex: number;
  undo: () => void;
  redo: () => void;
  commitToHistory: () => void;
}

export const createHistorySlice: StateCreator<AppState, [], [], HistorySlice> = (set, get) => ({
  history: [],
  historyIndex: -1,

  undo: () => {
    const { historyIndex, history } = get();
    if (historyIndex <= 0) return;
    const entry = history[historyIndex - 1];
    set({ nodes: entry.nodes, edges: entry.edges, groups: entry.groups, historyIndex: historyIndex - 1 });
  },

  redo: () => {
    const { historyIndex, history } = get();
    if (historyIndex >= history.length - 1) return;
    const entry = history[historyIndex + 1];
    set({ nodes: entry.nodes, edges: entry.edges, groups: entry.groups, historyIndex: historyIndex + 1 });
  },

  commitToHistory: () => {
    const { nodes, edges, groups, history, historyIndex } = get();
    const snapshot: HistoryEntry = {
      nodes: nodes.map((n) => ({ ...n, data: { ...n.data } })),
      edges: edges.map((e) => ({ ...e })),
      groups: groups.map((g) => ({ ...g })),
    };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(snapshot);
    if (newHistory.length > MAX_HISTORY) newHistory.shift();
    set({ history: newHistory, historyIndex: Math.min(newHistory.length - 1, historyIndex + 1) });
  },
});
