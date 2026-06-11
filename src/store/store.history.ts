/**
 * History slice — undo / redo with capped history stack
 */
import type { Node, Edge } from '@xyflow/react';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { BaseNodeData, NodeGroup } from '../types';
import * as fileService from '../services/fileService';

export interface HistoryEntry {
  nodes: Node<BaseNodeData>[];
  edges: Edge[];
  groups: NodeGroup[];
}

const MAX_HISTORY = 50;

export interface HistorySlice {
  history: HistoryEntry[];
  historyIndex: number;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  commitToHistory: () => void;
}

export const createHistorySlice: StateCreator<AppState, [], [], HistorySlice> = (set, get) => ({
  history: [],
  historyIndex: -1,

  undo: async () => {
    const { historyIndex, history } = get();
    if (historyIndex <= 0) return;
    const entry = history[historyIndex - 1];
    // Restore files BEFORE updating state — so React renders with files already on disk
    const restorePromises: Promise<unknown>[] = [];
    for (const node of entry.nodes) {
      const data = node.data as BaseNodeData;
      if (data.filePath) {
        restorePromises.push(fileService.restoreFromUndoTrash(data.filePath));
      }
    }
    if (restorePromises.length > 0) {
      await Promise.allSettled(restorePromises);
    }
    set({ nodes: entry.nodes, edges: entry.edges, groups: entry.groups, historyIndex: historyIndex - 1 });
  },

  redo: async () => {
    const { historyIndex, history, nodes: currentNodes } = get();
    if (historyIndex >= history.length - 1) return;
    const entry = history[historyIndex + 1];
    // Collect the filePaths of nodes that will be removed by this redo
    const redoNodeIds = new Set(entry.nodes.map((n) => n.id));
    const nodesToRemove = currentNodes.filter((n) => !redoNodeIds.has(n.id));
    // Trash files BEFORE updating state
    const trashPromises: Promise<unknown>[] = [];
    for (const node of nodesToRemove) {
      const data = node.data as BaseNodeData;
      if (data.filePath) {
        trashPromises.push(fileService.moveToUndoTrash(data.filePath));
      }
    }
    if (trashPromises.length > 0) {
      await Promise.allSettled(trashPromises);
    }
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
