/**
 * History slice — undo / redo with capped history stack
 */
import type { Node, Edge } from '@xyflow/react';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { BaseNodeData, NodeGroup } from '../types';
import * as fileService from '../services/fileService';
import { waitForPendingNodeExits } from '../utils/nodeAnimations';

export interface HistoryEntry {
  nodes: Node<BaseNodeData>[];
  edges: Edge[];
  groups: NodeGroup[];
}

const MAX_HISTORY = 50;

function createSnapshot(
  nodes: Node<BaseNodeData>[],
  edges: Edge[],
  groups: NodeGroup[],
): HistoryEntry {
  return {
    nodes: nodes.map((node) => ({
      ...node,
      position: { ...node.position },
      data: { ...node.data },
      style: node.style ? { ...node.style } : node.style,
    })),
    edges: edges.map((edge) => ({
      ...edge,
      data: edge.data ? { ...edge.data } : edge.data,
      style: edge.style ? { ...edge.style } : edge.style,
    })),
    groups: groups.map((group) => ({ ...group, nodeIds: [...group.nodeIds] })),
  };
}

function isDeepEqual(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, object>(),
): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;

  const seenRight = seen.get(left);
  if (seenRight) return seenRight === right;
  seen.set(left, right);

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => isDeepEqual(value, right[index], seen));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(rightRecord, key)
    && isDeepEqual(leftRecord[key], rightRecord[key], seen)
  ));
}

function isSameSnapshot(left: HistoryEntry, right: HistoryEntry): boolean {
  return isDeepEqual(left, right);
}

let historyTransitionQueue: Promise<void> = Promise.resolve();

function enqueueHistoryTransition(operation: () => Promise<boolean>): Promise<boolean> {
  const result = historyTransitionQueue.then(operation, operation);
  historyTransitionQueue = result.then(() => undefined, () => undefined);
  return result;
}

export interface HistorySlice {
  history: HistoryEntry[];
  historyIndex: number;
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
  commitToHistory: () => void;
}

export const createHistorySlice: StateCreator<AppState, [], [], HistorySlice> = (set, get) => ({
  history: [],
  historyIndex: -1,

  undo: () => enqueueHistoryTransition(async () => {
    // 删除会在退场动画结束后落状态。先等待，确保捕获到真实的删除后状态，避免回调覆盖撤销结果。
    await waitForPendingNodeExits();

    const { historyIndex, history, nodes, edges, groups } = get();
    if (historyIndex < 0 || history.length === 0) return false;

    const current = createSnapshot(nodes, edges, groups);
    let checkpointIndex = Math.min(historyIndex, history.length - 1);
    // 兼容少数在操作结束后额外提交的快照，撤销时跳过与当前画布完全相同的记录。
    while (checkpointIndex >= 0 && isSameSnapshot(history[checkpointIndex], current)) {
      checkpointIndex -= 1;
    }
    if (checkpointIndex < 0) {
      // Agent 检查点允许连续快照内容相同；即使画布无视觉变化，也要保持游标可逐步回退。
      set({ historyIndex: historyIndex - 1 });
      return true;
    }

    const entry = history[checkpointIndex];
    const nextHistory = [...history];
    const redoEntryIndex = checkpointIndex + 1;
    if (!nextHistory[redoEntryIndex] || !isSameSnapshot(nextHistory[redoEntryIndex], current)) {
      nextHistory.splice(redoEntryIndex, nextHistory.length - redoEntryIndex, current);
    }

    // Restore files BEFORE updating state so React renders with files already on disk.
    const currentPaths = new Map(nodes.map((node) => [node.id, node.data.filePath]));
    const restorePromises = entry.nodes.flatMap((node) => {
      const filePath = node.data.filePath;
      return filePath && currentPaths.get(node.id) !== filePath
        ? [fileService.restoreFromUndoTrash(filePath)]
        : [];
    });
    if (restorePromises.length > 0) await Promise.allSettled(restorePromises);

    const latest = get();
    const latestSnapshot = createSnapshot(latest.nodes, latest.edges, latest.groups);
    if (latest.historyIndex !== historyIndex || !isSameSnapshot(latestSnapshot, current)) return false;

    const restored = createSnapshot(entry.nodes, entry.edges, entry.groups);
    set({
      nodes: restored.nodes,
      edges: restored.edges,
      groups: restored.groups,
      history: nextHistory,
      historyIndex: checkpointIndex - 1,
    });
    return true;
  }),

  redo: () => enqueueHistoryTransition(async () => {
    await waitForPendingNodeExits();

    const { historyIndex, history, nodes, edges, groups } = get();
    const current = createSnapshot(nodes, edges, groups);
    let targetIndex = historyIndex + 2;
    while (targetIndex < history.length && isSameSnapshot(history[targetIndex], current)) {
      targetIndex += 1;
    }
    if (targetIndex >= history.length) return false;

    const entry = history[targetIndex];
    const targetPaths = new Map(entry.nodes.map((node) => [node.id, node.data.filePath]));
    const trashPromises = nodes.flatMap((node) => {
      const filePath = node.data.filePath;
      return filePath && targetPaths.get(node.id) !== filePath
        ? [fileService.moveToUndoTrash(filePath)]
        : [];
    });
    if (trashPromises.length > 0) await Promise.allSettled(trashPromises);

    const latest = get();
    const latestSnapshot = createSnapshot(latest.nodes, latest.edges, latest.groups);
    if (latest.historyIndex !== historyIndex || !isSameSnapshot(latestSnapshot, current)) return false;

    const restored = createSnapshot(entry.nodes, entry.edges, entry.groups);
    set({
      nodes: restored.nodes,
      edges: restored.edges,
      groups: restored.groups,
      historyIndex: targetIndex - 1,
    });
    return true;
  }),

  commitToHistory: () => {
    const { nodes, edges, groups, history, historyIndex } = get();
    const snapshot = createSnapshot(nodes, edges, groups);
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(snapshot);
    if (newHistory.length > MAX_HISTORY) newHistory.shift();
    set({ history: newHistory, historyIndex: newHistory.length - 1 });
  },
});
