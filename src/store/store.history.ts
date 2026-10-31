/**
 * History slice — undo / redo with capped history stack
 */
import { t } from '../i18n';

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
const ANIMATION_MEDIA_KEYS = ['imageUrl', 'thumbnailUrl', 'sourceUrl', 'filePath', 'fileName', 'imageWidth', 'imageHeight'] as const satisfies readonly (keyof BaseNodeData)[];
const STRUCTURAL_NODE_DATA_KEYS = [
  'groupId',
  'storyboardCols',
  'storyboardRows',
  'storyboardRowPositions',
  'storyboardColPositions',
  'storyboardExtracted',
  'storyboardOverrides',
  'shotlistRows',
  'shotlistCinematography',
  'cameraSettings',
  'shotlistColumns',
  'shotlistColumnWidths',
  'shotlistColumnRatios',
  'shotlistScriptSource',
  'shotlistProductionSource',
  'characterLibraryLinks',
  'comfyRefmods',
  'comfyH3MemoryPreset',
  'hiddenByCharacterLibrary',
  'groupCollapsed',
  'note',
  'animationSheet',
  'animationProcessing',
  'animationEdits',
  'animationFps',
  'animationLoop',
  'directorRuntimeKind',
  'directorPrevisScene',
  'directorPrevisPrompt',
  'directorPrevisModel',
  'directorPrevisProvider',
  'aiApp',
] as const satisfies readonly (keyof BaseNodeData)[];
const LAYOUT_NODE_DATA_KEYS = [
  'nodeWidth',
  'nodeHeight',
  'displayLabel',
] as const satisfies readonly (keyof BaseNodeData)[];

/** 缓存只认不可变对象身份；弱键随历史淘汰和项目切换释放，不按节点 ID 跨项目复用。 */
function cachedHistoryMap<T extends object, R>(project: (item: T) => R) {
  const items = new WeakMap<T, R>();
  const arrays = new WeakMap<T[], R[]>();
  const get = (item: T): R => {
    if (items.has(item)) return items.get(item)!;
    const value = project(item);
    items.set(item, value);
    return value;
  };
  return {
    items, get,
    map: (source: T[]): R[] => {
      const cached = arrays.get(source);
      if (cached) return cached;
      const result = source.map(get);
      arrays.set(source, result);
      return result;
    },
  };
}

function cloneNode(node: Node<BaseNodeData>): Node<BaseNodeData> {
  return { ...node, position: { ...node.position }, data: { ...node.data },
    style: node.style ? { ...node.style } : node.style };
}

function cloneEdge(edge: Edge): Edge {
  return { ...edge, data: edge.data ? { ...edge.data } : edge.data,
    style: edge.style ? { ...edge.style } : edge.style };
}

const snapshotNodes = cachedHistoryMap((node: Node<BaseNodeData>) => {
  const snapshot = cloneNode(node);
  // 比较阶段已有的投影沿用到副本；不保留源节点，也不重复比较未变化节点的字段。
  structuralNodesWithLayout.items.set(snapshot, structuralNodesWithLayout.get(node));
  const structure = structuralNodesWithoutLayout.items.get(node);
  if (structure) structuralNodesWithoutLayout.items.set(snapshot, structure);
  return snapshot;
});
const snapshotEdges = cachedHistoryMap((edge: Edge) => {
  const snapshot = cloneEdge(edge);
  structuralEdges.items.set(snapshot, structuralEdges.get(edge));
  return snapshot;
});
const snapshotGroups = cachedHistoryMap((group: NodeGroup) => ({ ...group, nodeIds: [...group.nodeIds] }));

function createSnapshot(nodes: Node<BaseNodeData>[], edges: Edge[], groups: NodeGroup[]): HistoryEntry {
  return { nodes: snapshotNodes.map(nodes), edges: snapshotEdges.map(edges), groups: snapshotGroups.map(groups) };
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

function getStructuralNodeData(data: BaseNodeData): Partial<BaseNodeData> {
  const structuralData: Partial<BaseNodeData> = {};
  if (data.type === 'ai-animation') {
    for (const key of ANIMATION_MEDIA_KEYS) structuralData[key] = data[key] as never;
  }
  if ((data.type === 'ai-video' || data.type === 'source-video') && data.shotlistProductionSource?.kind === 'video') {
    structuralData.seedanceDuration = data.seedanceDuration;
  }
  for (const key of STRUCTURAL_NODE_DATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      structuralData[key] = data[key] as never;
    }
  }
  return structuralData;
}

function getNodeDataFields(
  data: BaseNodeData,
  keys: readonly (keyof BaseNodeData)[],
): Partial<BaseNodeData> {
  const fields: Partial<BaseNodeData> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      fields[key] = data[key] as never;
    }
  }
  return fields;
}

function getNodeStyleDimensions(
  node: Node<BaseNodeData>,
): Pick<NonNullable<Node<BaseNodeData>['style']>, 'width' | 'height'> {
  const dimensions: Pick<NonNullable<Node<BaseNodeData>['style']>, 'width' | 'height'> = {};
  if (Object.prototype.hasOwnProperty.call(node.style ?? {}, 'width')) {
    dimensions.width = node.style?.width;
  }
  if (Object.prototype.hasOwnProperty.call(node.style ?? {}, 'height')) {
    dimensions.height = node.style?.height;
  }
  return dimensions;
}

function projectStructuralNode(node: Node<BaseNodeData>, includeLayout: boolean) {
  return {
    id: node.id, type: node.type, parentId: node.parentId, extent: node.extent, expandParent: node.expandParent,
    data: getStructuralNodeData(node.data),
    ...(includeLayout || node.type === 'canvas-note' ? {
      position: node.position,
      layoutData: getNodeDataFields(node.data, LAYOUT_NODE_DATA_KEYS),
      styleDimensions: getNodeStyleDimensions(node),
      ...(node.type === 'group' ? { dimensions: { width: node.width, height: node.height } } : {}),
    } : {}),
  };
}
const structuralNodesWithLayout = cachedHistoryMap((node: Node<BaseNodeData>) => projectStructuralNode(node, true));
const structuralNodesWithoutLayout = cachedHistoryMap((node: Node<BaseNodeData>) => projectStructuralNode(node, false));
const structuralEdges = cachedHistoryMap((edge: Edge) => ({
  id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle,
  targetHandle: edge.targetHandle, type: edge.type,
}));
const structuralSnapshots = new WeakMap<HistoryEntry, unknown>();
const structuralSnapshotsWithoutLayout = new WeakMap<HistoryEntry, unknown>();

function getStructuralSnapshot(entry: HistoryEntry, includeLayout = true): unknown {
  const cache = includeLayout ? structuralSnapshots : structuralSnapshotsWithoutLayout;
  const cached = cache.get(entry);
  if (cached) return cached;
  const projection = {
    nodes: (includeLayout ? structuralNodesWithLayout : structuralNodesWithoutLayout).map(entry.nodes),
    edges: structuralEdges.map(entry.edges), groups: entry.groups,
  };
  cache.set(entry, projection);
  return projection;
}

function isSameStructure(left: HistoryEntry, right: HistoryEntry): boolean {
  return isDeepEqual(getStructuralSnapshot(left), getStructuralSnapshot(right));
}

function isSameStructureIgnoringLayout(left: HistoryEntry, right: HistoryEntry): boolean {
  return isDeepEqual(
    getStructuralSnapshot(left, false),
    getStructuralSnapshot(right, false),
  );
}

function restoreNodeStyleDimensions(
  target: Node<BaseNodeData>,
  current: Node<BaseNodeData>,
): Node<BaseNodeData>['style'] {
  const style = { ...(current.style ?? {}) };
  for (const key of ['width', 'height'] as const) {
    if (Object.prototype.hasOwnProperty.call(target.style ?? {}, key)) {
      style[key] = target.style?.[key];
    } else {
      delete style[key];
    }
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function restoreStructuralNode(
  target: Node<BaseNodeData>,
  current: Node<BaseNodeData> | undefined,
  restoreLayout: boolean,
): Node<BaseNodeData> {
  if (!current) return cloneNode(target);

  if (target.type === 'canvas-note') {
    return {
      ...target,
      selected: current.selected,
      dragging: false,
      measured: current.measured,
      data: { ...current.data, ...target.data },
      position: { ...target.position },
      style: target.style ? { ...target.style } : target.style,
    };
  }

  const data = { ...current.data };
  if (target.data.type === 'ai-app') data.label = target.data.label;
  if (target.data.type === 'ai-animation') {
    for (const key of ANIMATION_MEDIA_KEYS) {
      if (Object.prototype.hasOwnProperty.call(target.data, key)) data[key] = target.data[key] as never;
      else delete data[key];
    }
  }
  const targetShotSource = target.data.shotlistProductionSource;
  const currentShotSource = current.data.shotlistProductionSource;
  const videoShotSource = (target.data.type === 'ai-video' || target.data.type === 'source-video')
    && (targetShotSource?.kind === 'video' || currentShotSource?.kind === 'video');
  if (videoShotSource) {
    if (Object.prototype.hasOwnProperty.call(target.data, 'seedanceDuration')) {
      data.seedanceDuration = target.data.seedanceDuration;
    } else {
      delete data.seedanceDuration;
    }
    // 镜头引用和其时长是一项结构操作；普通布局撤销仍保留独立的文案编辑。
    if (targetShotSource?.nodeId !== currentShotSource?.nodeId || targetShotSource?.rowId !== currentShotSource?.rowId
      || targetShotSource?.kind !== currentShotSource?.kind) {
      if (Object.prototype.hasOwnProperty.call(target.data, 'prompt')) data.prompt = target.data.prompt;
      else delete data.prompt;
    }
  }
  for (const key of STRUCTURAL_NODE_DATA_KEYS) {
    // 结构撤销不恢复模型选择；旧图的槽位覆盖不能随引用移植到当前工作流。
    if (key === 'comfyRefmods' && (target.data.workflowId !== current.data.workflowId
      || target.data.provider !== current.data.provider || target.data.model !== current.data.model)) continue;
    if (Object.prototype.hasOwnProperty.call(target.data, key)) {
      data[key] = target.data[key] as never;
    } else {
      delete data[key];
    }
  }
  if (restoreLayout) {
    for (const key of LAYOUT_NODE_DATA_KEYS) {
      if (Object.prototype.hasOwnProperty.call(target.data, key)) {
        data[key] = target.data[key] as never;
      } else {
        delete data[key];
      }
    }
  }
  const parentChanged = current.parentId !== target.parentId;
  return {
    ...current,
    type: target.type,
    parentId: target.parentId,
    extent: target.extent,
    expandParent: target.expandParent,
    position: restoreLayout || parentChanged ? { ...target.position } : { ...current.position },
    style: restoreLayout ? restoreNodeStyleDimensions(target, current) : current.style,
    ...(restoreLayout && target.type === 'group' ? {
      width: target.width,
      height: target.height,
      measured: target.measured ? { ...target.measured } : undefined,
    } : {}),
    data,
  };
}

function restoreStructuralSnapshot(
  target: HistoryEntry,
  current: HistoryEntry,
): HistoryEntry {
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
  const currentEdges = new Map(current.edges.map((edge) => [edge.id, edge]));
  const restoreLayout = isSameStructureIgnoringLayout(target, current);
  const targetMembers = new Map(target.groups.map((group) => [group.id, group.nodeIds]));
  const currentMembers = new Map(current.groups.map((group) => [group.id, group.nodeIds]));
  const layoutGroups = new Set<string>();
  const relocatedGroups = new Set<string>();
  for (const node of target.nodes) {
    if (node.type !== 'group') continue;
    const groupId = node.data.groupId;
    // 只把成员变化的容器与归属一起还原，其他分组仍保留独立布局。
    const membersChanged = typeof groupId === 'string'
      && !isDeepEqual(targetMembers.get(groupId), currentMembers.get(groupId));
    if (!restoreLayout && !membersChanged) continue;
    layoutGroups.add(node.id);
    const previous = currentNodes.get(node.id);
    if (previous
      && (node.position.x !== previous.position.x || node.position.y !== previous.position.y)) {
      relocatedGroups.add(node.id);
    }
  }
  return {
    nodes: target.nodes.map((node) => restoreStructuralNode(
      node,
      currentNodes.get(node.id),
      // 左／上边缩放会反向调整已有子节点坐标，须随父框一起还原。
      restoreLayout || layoutGroups.has(node.id)
        || (node.parentId !== undefined && relocatedGroups.has(node.parentId)),
    )),
    edges: target.edges.map((edge) => {
      const currentEdge = currentEdges.get(edge.id);
      return currentEdge
        ? {
            ...currentEdge,
            source: edge.source,
            target: edge.target,
            sourceHandle: edge.sourceHandle,
            targetHandle: edge.targetHandle,
            type: edge.type,
          }
        : cloneEdge(edge);
    }),
    groups: target.groups.map((group) => ({ ...group, nodeIds: [...group.nodeIds] })),
  };
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
    // 文件暂存不等动画，必须单独等：还原跑在暂存前面的话，文件会在节点复活之后才进 .trash
    await fileService.waitForPendingNodeFileDeletions();

    const { historyIndex, history, nodes, edges, groups, currentProjectId } = get();
    if (historyIndex < 0 || history.length === 0) return false;

    const current = createSnapshot(nodes, edges, groups);
    let checkpointIndex = Math.min(historyIndex, history.length - 1);
    // 兼容少数在操作结束后额外提交的快照，撤销时跳过与当前画布完全相同的记录。
    while (checkpointIndex >= 0 && isSameStructure(history[checkpointIndex], current)) {
      checkpointIndex -= 1;
    }
    if (checkpointIndex < 0) {
      // Agent checkpoints may intentionally contain byte-for-byte identical snapshots.
      if (historyIndex >= 0 && isDeepEqual(history[historyIndex], current)) {
        set({ historyIndex: historyIndex - 1 });
        return true;
      }
      set({ historyIndex: -1 });
      return false;
    }

    const entry = history[checkpointIndex];
    const nextHistory = [...history];
    const redoEntryIndex = checkpointIndex + 1;
    if (!nextHistory[redoEntryIndex] || !isSameStructure(nextHistory[redoEntryIndex], current)) {
      nextHistory.splice(redoEntryIndex, nextHistory.length - redoEntryIndex, current);
    }

    // Restore files BEFORE updating state so React renders with files already on disk.
    const currentNodeIds = new Set(nodes.map((node) => node.id));
    const currentGroupIds = new Set(groups.map((group) => group.id));
    const revivedFolders = await fileService.resolveGroupUndoTrashPaths(
      entry.groups.filter((group) => !currentGroupIds.has(group.id)).map((group) => group.name),
      currentProjectId,
    );
    // Restore parent folders first, including empty groups and legacy nested trash content.
    for (const folder of revivedFolders) await fileService.restoreFromUndoTrash(folder);
    const revivedPathGroups = await Promise.all(entry.nodes.map((node) => (
      currentNodeIds.has(node.id)
        ? Promise.resolve([])
        : fileService.resolveNodeUndoTrashPaths(node.data, currentProjectId)
    )));
    const revivedPaths = [...new Set(revivedPathGroups.flat())];
    if (revivedPaths.length > 0) {
      await Promise.allSettled(revivedPaths.map((filePath) => fileService.restoreFromUndoTrash(filePath)));
      // 节点复活但文件没回来时，界面上只会表现为"打不开"，必须明说，别让用户以为撤销成功了
      void Promise.all(revivedPaths.map((filePath) => fileService.isFileMissing(filePath)))
        .then((missing) => {
          const lost = missing.filter(Boolean).length;
          if (lost > 0) get().showToast(t('已撤销，但 {count} 个媒体文件未能还原', { count: lost }), 'error');
        })
        .catch(() => {});
    }

    const latest = get();
    const latestSnapshot = createSnapshot(latest.nodes, latest.edges, latest.groups);
    if (latest.currentProjectId !== currentProjectId || latest.history !== history
      || latest.historyIndex !== historyIndex || !isSameStructure(latestSnapshot, current)) return false;

    const restored = restoreStructuralSnapshot(entry, latestSnapshot);
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

    const { historyIndex, history, nodes, edges, groups, currentProjectId } = get();
    const current = createSnapshot(nodes, edges, groups);
    let targetIndex = historyIndex + 2;
    while (targetIndex < history.length && isSameStructure(history[targetIndex], current)) {
      targetIndex += 1;
    }
    if (targetIndex >= history.length) return false;

    const entry = history[targetIndex];
    const targetNodeIds = new Set(entry.nodes.map((node) => node.id));
    const projectId = currentProjectId;
    const keepReferences = new Set<string>();
    entry.nodes.forEach((node) => {
      fileService.collectNodeFileReferences(node.data).forEach((reference) => keepReferences.add(reference));
    });
    get().messages.forEach((message) => {
      const filePath = message.mediaResult?.filePath;
      if (filePath) keepReferences.add(filePath);
    });
    const removedNodes = nodes.filter((node) => !targetNodeIds.has(node.id));
    removedNodes.filter((node) => node.data.artifactId).forEach((node) => {
      fileService.collectNodeFileReferences(node.data).forEach((path) => keepReferences.add(path));
    });
    await fileService.deleteNodeFiles(
      removedNodes.filter((node) => !node.data.artifactId).map((node) => node.data), keepReferences, projectId,
      fileService.deletedGroupFolderNames(groups, new Set(removedNodes.map((node) => node.id))),
    );

    const latest = get();
    const latestSnapshot = createSnapshot(latest.nodes, latest.edges, latest.groups);
    if (latest.currentProjectId !== currentProjectId || latest.history !== history
      || latest.historyIndex !== historyIndex || !isSameStructure(latestSnapshot, current)) return false;

    const restored = restoreStructuralSnapshot(entry, latestSnapshot);
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
    const previous = historyIndex >= 0 ? history[Math.min(historyIndex, history.length - 1)] : undefined;
    if (previous && isSameStructure(previous, { nodes, edges, groups })) return;
    const snapshot = createSnapshot(nodes, edges, groups);
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(snapshot);
    if (newHistory.length > MAX_HISTORY) newHistory.shift();
    set({ history: newHistory, historyIndex: newHistory.length - 1 });
  },
});
