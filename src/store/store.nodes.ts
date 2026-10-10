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
import type {
  BaseNodeData,
  CanvasNoteData,
  CanvasNoteLayerDirection,
  CanvasNotePatch,
  CharacterLibraryNodeLink,
  NodeGroup,
  ShotRow,
  StoryboardCellOverride,
} from '../types';
import { createCanvasNoteData, STORYBOARD_CELL_SOURCE_TYPES } from '../types';
import type { MediaGenerationIntent, MediaGenerationResult } from '../types/media';
import { resolveShotVideoDuration } from '../types/shotlist';
import { generateId, getNextDisplayId } from './store.utils';
import { BATCH_NODE_LIMIT } from './store.chat';
import * as fileService from '../services/fileService';
import { playNodeExit } from '../utils/nodeAnimations';
import { cancelNodePolling } from '../services/pollManager';
import { applyProjectDefaultsToNodeData } from '../services/projectSettingsService';
import { getCanvasPointerPosition } from '../services/canvasPointerService';
import { resolveDirectorRuntime } from '../services/directorRuntimeRegistry';
import { copyNodeMedia, needsNodeMediaCopy, discardCopiedNodeMedia } from '../services/nodeMediaCopy';
import { registerCanvasDerivation, isCanvasDerivationFresh, completeCanvasDerivation } from '../services/canvasDerivationGuard';
import { AI_APP_COPY_MESSAGE, AI_APP_CREATION_MESSAGE, assertAiAppNodeInsertion, isAiAppNode } from '../services/aiApps/aiAppCreation';

interface GroupNodeDataAccess {
  groupId: string;
}

export function isCanvasConnectionValid(connection: {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}): boolean {
  if (connection.source === connection.target) return false;
  const { sourceHandle, targetHandle } = connection;
  if (
    (sourceHandle === 'left' || sourceHandle === 'right')
    && (targetHandle === 'left' || targetHandle === 'right')
  ) {
    return sourceHandle !== targetHandle;
  }
  return true;
}

const BATCH_CONNECTABLE_TYPES = new Set([
  'ai-text', 'source-text', 'ai-image', 'source-image', 'ai-video', 'source-video',
  'ai-audio', 'source-audio', 'ai-animation', 'ai-panorama', 'ai-markdown',
  'ai-storyboard', 'ai-shotlist', 'ai-director',
]);

export function isBatchConnectableNode(node: Node<BaseNodeData>): boolean {
  return BATCH_CONNECTABLE_TYPES.has(node.type ?? '')
    && node.data.hiddenByCharacterLibrary !== true
    && node.hidden !== true;
}

const AUTO_MENTION_TARGET_TYPES = new Set([
  'ai-text', 'ai-image', 'ai-video', 'ai-audio', 'ai-animation', 'ai-panorama',
  'ai-markdown', 'ai-shotlist',
]);

/** 与新连线一起写入真实提示词，编辑器、持久化与撤销共用同一个状态。 */
function appendConnectionMentions(
  nodes: Node<BaseNodeData>[],
  edges: readonly Edge[],
  enabled: boolean | undefined,
  activeNodeId: string | null,
): { nodes: Node<BaseNodeData>[]; edges: Edge[] } {
  if (enabled === false || edges.length === 0) return { nodes, edges: [...edges] };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sourcesByTarget = new Map<string, Node<BaseNodeData>[]>();
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || source.id === target.id || target.type === 'group'
      || !AUTO_MENTION_TARGET_TYPES.has(target.data.type)) continue;
    // 上传、导入和生成结果仍可打开同一生成对话框，编辑时不按来源角色跳过引用。
    if (target.data.role === 'source' && target.id !== activeNodeId) continue;
    const sources = source.type === 'group'
      ? nodes.filter((node) => node.parentId === source.id)
      : [source];
    const eligible = sources.filter((node) => node.id !== target.id && BATCH_CONNECTABLE_TYPES.has(node.data.type));
    sourcesByTarget.set(target.id, [...(sourcesByTarget.get(target.id) ?? []), ...eligible]);
  }
  const nextNodes = nodes.map((node) => {
    const sources = sourcesByTarget.get(node.id);
    if (!sources?.length) return node;
    let prompt = node.data.prompt ?? '';
    const mentioned = new Set([...prompt.matchAll(/@\{([^:]+):[^}]+\}/g)].map((match) => match[1]));
    let changed = false;
    for (const source of sources) {
      if (mentioned.has(source.id)) continue;
      const label = (source.data.label || '节点').replace(/[{}\r\n]/g, ' ').trim() || '节点';
      const token = `@{${source.id}:${label}}`;
      const separator = prompt && !/\s$/.test(prompt) ? ' ' : '';
      prompt += separator + token;
      mentioned.add(source.id);
      changed = true;
    }
    return changed ? { ...node, data: { ...node.data, prompt } } : node;
  });
  return {
    nodes: nextNodes,
    edges: [...edges],
  };
}

/** 删除最后一条上游连接时，同步移除该素材及其宫格子图引用。 */
function removeDisconnectedMentions(
  nodes: Node<BaseNodeData>[],
  removedEdges: readonly Edge[],
  remainingEdges: readonly Edge[],
): Node<BaseNodeData>[] {
  if (removedEdges.length === 0) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sourceIds = (edge: Edge): string[] => byId.get(edge.source)?.type === 'group'
    ? nodes.filter((node) => node.parentId === edge.source).map((node) => node.id)
    : [edge.source];
  return nodes.map((node) => {
    if (!node.data.prompt) return node;
    const targetIds = new Set([node.id, ...(node.parentId ? [node.parentId] : [])]);
    const disconnected = new Set(removedEdges
      .filter((edge) => targetIds.has(edge.target)).flatMap(sourceIds));
    if (disconnected.size === 0) return node;
    for (const edge of remainingEdges) {
      if (targetIds.has(edge.target)) {
        for (const id of sourceIds(edge)) disconnected.delete(id);
      }
    }
    if (disconnected.size === 0) return node;
    const prompt = node.data.prompt.replace(/@\{([^:]+):[^}]+\}/g, (token, id: string) => (
      disconnected.has(id.replace(/\/cell\/\d+$/, '')) ? '' : token
    ));
    return prompt !== node.data.prompt
      ? { ...node, data: { ...node.data, prompt: prompt.trim() ? prompt : '' } }
      : node;
  });
}

function resolveBatchSources(
  state: AppState,
  sourceIds: readonly string[],
  projectId: string | null,
  targetId?: string,
): Node<BaseNodeData>[] | null {
  if (state.currentProjectId !== projectId) return null;
  const ids = new Set(sourceIds);
  if (ids.size < 2 || ids.size !== sourceIds.length || (targetId && ids.has(targetId))) return null;
  const byId = new Map(state.nodes.map((node) => [node.id, node]));
  const sources = sourceIds.map((id) => byId.get(id));
  if (sources.some((node) => !node || !isBatchConnectableNode(node)
    || (node.parentId && byId.get(node.parentId)?.data.groupCollapsed === true))) return null;
  return sources as Node<BaseNodeData>[];
}

function newBatchEdges(
  sources: readonly Node<BaseNodeData>[],
  targetId: string,
  existingEdges: readonly Edge[],
): Edge[] {
  const existing = new Set(existingEdges
    .filter((edge) => edge.target === targetId)
    .map((edge) => edge.source));
  return sources.filter((source) => !existing.has(source.id)).map((source) => ({
    id: `edge-${generateId()}`,
    source: source.id,
    sourceHandle: 'right',
    target: targetId,
    targetHandle: 'left',
  }));
}

function normalizeCanvasConnection(connection: Connection): Connection | null {
  if (!isCanvasConnectionValid(connection)) return null;
  const draggedFromInput = connection.sourceHandle === 'left' && connection.targetHandle === 'right';
  if (!draggedFromInput) return connection;
  return {
    source: connection.target,
    target: connection.source,
    sourceHandle: connection.targetHandle,
    targetHandle: connection.sourceHandle,
  };
}

function hasMaterializedNodeOutput(data: BaseNodeData, nodeType: string | undefined): boolean {
  const hasValue = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (['ai-image', 'source-image', 'ai-animation', 'ai-panorama', 'ai-storyboard'].includes(nodeType ?? '')) {
    return hasValue(data.imageUrl) || hasValue(data.thumbnailUrl);
  }
  if (['ai-video', 'source-video'].includes(nodeType ?? '')) return hasValue(data.videoUrl);
  if (['ai-audio', 'source-audio'].includes(nodeType ?? '')) return hasValue(data.audioUrl);
  if (nodeType === 'ai-director') {
    return hasValue(data.imageUrl)
      || hasValue(data.videoUrl)
      || (Array.isArray(data.directorCaptureUrls) && data.directorCaptureUrls.some(hasValue));
  }
  return hasValue(data.output);
}

function prepareDirectorNodeDataForInsertion(
  data: BaseNodeData,
  nodeType: string | undefined,
  instanceId: string,
): BaseNodeData {
  if (nodeType !== 'ai-director') return data;
  const resolution = resolveDirectorRuntime(data.directorRuntimeKind);
  const next: BaseNodeData = {
    ...data,
    ...(Array.isArray(data.directorCaptureUrls)
      ? { directorCaptureUrls: [...data.directorCaptureUrls] }
      : {}),
    ...(Array.isArray(data.directorCaptureFilePaths)
      ? { directorCaptureFilePaths: [...data.directorCaptureFilePaths] }
      : {}),
    directorInstanceId: instanceId,
    directorStatus: 'idle',
  };
  if (resolution.supported) next.directorRuntimeKind = resolution.kind;
  if (next.status === undefined || next.status === 'loading' || next.status === 'error') {
    next.status = hasMaterializedNodeOutput(next, nodeType) ? 'success' : 'idle';
  }
  delete next.error;
  return next;
}

function prepareNodeForInsertion(
  node: Node<BaseNodeData>,
  data: BaseNodeData,
  displayId: number,
): Node<BaseNodeData> {
  const prepared = prepareDirectorNodeDataForInsertion(data, node.type, node.id);
  return { ...node, data: { ...prepared, displayId } } as Node<BaseNodeData>;
}

function absoluteNodePosition(node: Node<BaseNodeData>, nodes: Node<BaseNodeData>[]) {
  const position = { ...node.position };
  const visited = new Set([node.id]);
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodes.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    position.x += parent.position.x;
    position.y += parent.position.y;
    parentId = parent.parentId;
  }
  return position;
}

function nodeSize(node: Node<BaseNodeData>) {
  return {
    width: node.measured?.width ?? node.width ?? (Number(node.style?.width) || node.data.nodeWidth || 280),
    height: node.measured?.height ?? node.height ?? (Number(node.style?.height) || node.data.nodeHeight || 160),
  };
}

function groupContainsPoint(group: Node<BaseNodeData>, point: { x: number; y: number }, nodes: Node<BaseNodeData>[]) {
  const position = absoluteNodePosition(group, nodes);
  const size = nodeSize(group);
  return point.x >= position.x && point.x <= position.x + size.width
    && point.y >= position.y && point.y <= position.y + size.height;
}

function nodeCenter(node: Node<BaseNodeData>, nodes: Node<BaseNodeData>[]) {
  const position = absoluteNodePosition(node, nodes);
  const size = nodeSize(node);
  return { x: position.x + size.width / 2, y: position.y + size.height / 2 };
}

/** 新建节点按画布位置加入展开分组，与插入本身共用一次历史快照。 */
function insertNodeInGroup(state: Pick<AppState, 'nodes' | 'groups'>, node: Node<BaseNodeData>) {
  const center = nodeCenter(node, state.nodes);
  const parent = node.parentId || node.type === 'group' ? undefined : state.nodes.find((candidate) => (
    candidate.type === 'group' && !candidate.hidden && !candidate.data.groupCollapsed
    && groupContainsPoint(candidate, center, state.nodes)
  ));
  if (!parent) return { nodes: [...state.nodes, node], groups: state.groups };
  const position = absoluteNodePosition(parent, state.nodes);
  return {
    nodes: [...state.nodes, {
      ...node, parentId: parent.id,
      position: { x: node.position.x - position.x, y: node.position.y - position.y },
    }],
    groups: state.groups.map((group) => group.id === parent.data.groupId
      ? { ...group, nodeIds: [...new Set([...group.nodeIds, node.id])] } : group),
  };
}

function insertPreparedNode(state: AppState, node: Node<BaseNodeData>) {
  const displayId = getNextDisplayId(state.nodes);
  const settings = state.projects.find((project) => project.id === state.currentProjectId)?.settings;
  const data = applyProjectDefaultsToNodeData(node.data, settings);
  return insertNodeInGroup(state, prepareNodeForInsertion(node, data, displayId));
}

function appendPreparedNodes(state: AppState, nodes: Node<BaseNodeData>[]): Node<BaseNodeData>[] {
  const nextNodes = [...state.nodes];
  const settings = state.projects.find((project) => project.id === state.currentProjectId)?.settings;
  for (const node of nodes) {
    const data = applyProjectDefaultsToNodeData(node.data, settings);
    nextNodes.push(prepareNodeForInsertion(node, data, getNextDisplayId(nextNodes)));
  }
  return nextNodes;
}

function prepareDuplicateNodeData(
  data: BaseNodeData,
  nodeType: string | undefined,
  cloneId: string,
  includeContent: boolean,
): BaseNodeData {
  const duplicate = structuredClone(data);

  if (!includeContent) {
    // 拖拽复用生成配置，不带走上一份结果、文件身份或运行记录。
    for (const key of [
      'output', 'imageUrl', 'videoUrl', 'audioUrl', 'sourceUrl', 'thumbnailUrl',
      'fileName', 'filePath', 'assetId', 'relativePath', 'artifactId', 'mediaVersion',
      'imageWidth', 'imageHeight', 'videoWidth', 'videoHeight', 'videoDuration', 'videoBatchFingerprint',
      'mattingMask', 'annotation', 'annotationLayer', 'batchGroupId',
      'runninghubOutputs', 'runninghubStage', 'workflowApiOutputs', 'workflowApiStage', 'pluginOutputs',
      'musicClipId', 'animationSheet', 'animationEdits',
      'storyboardExtracted', 'storyboardOverrides', 'shotlistRows',
      'shotlistScriptSource', 'shotlistProductionSource', 'frameAnalysis', 'outputHistory',
      'directorCaptureUrls', 'directorCaptureFilePaths', 'directorScene',
      'directorPrevisScene', 'directorResultManifest',
      'dramaAssetId', 'dramaAssetKind', 'characterLibraryLinks', 'hiddenByCharacterLibrary',
      'agentPresetRunId', 'agentPresetTaskId', 'agentPresetStepIndex', 'agentPresetTotalSteps',
      'error',
    ]) delete duplicate[key];
    duplicate.status = 'idle';
  }

  if (duplicate.status === 'loading') {
    duplicate.status = hasMaterializedNodeOutput(duplicate, nodeType) ? 'success' : 'idle';
    delete duplicate.error;
  }

  if (nodeType === 'ai-director') {
    return prepareDirectorNodeDataForInsertion(duplicate, nodeType, cloneId);
  }

  if (nodeType === 'ai-markdown') {
    delete duplicate.fileName;
    delete duplicate.filePath;
    delete duplicate.assetId;
    delete duplicate.relativePath;
  }

  return duplicate;
}

/**
 * 删除节点前统计「还有人在用」的文件：存活节点的媒体文件、宫格各格引用的图片、
 * 对话里的媒体产物。宫格格子和源图共用同一个文件，漏掉它就会把还在显示的图搬进回收站。
 */
export function collectKeepPaths(
  nodes: Node<BaseNodeData>[],
  idsToDelete: ReadonlySet<string>,
  messages: { mediaResult?: { filePath?: string } }[],
): Set<string> {
  const keepPaths = new Set<string>();
  for (const node of nodes) {
    const data = node.data as BaseNodeData;
    if (!idsToDelete.has(node.id) || data.artifactId) {
      fileService.collectNodeFileReferences(data).forEach((reference) => keepPaths.add(reference));
    }
  }
  for (const message of messages) {
    if (message.mediaResult?.filePath) keepPaths.add(message.mediaResult.filePath);
  }
  return keepPaths;
}

function mergeNodeData(previous: BaseNodeData, patch: Partial<BaseNodeData>): BaseNodeData {
  if ('type' in patch && patch.type !== previous.type
    && (patch.type === 'ai-app' || previous.type === 'ai-app')) {
    throw new Error(AI_APP_CREATION_MESSAGE);
  }
  const next = { ...previous, ...patch } as BaseNodeData;
  if (previous.type === 'ai-video' && previous.shotlistProductionSource?.kind === 'video'
    && 'seedanceDuration' in patch && patch.seedanceDuration !== previous.seedanceDuration) {
    next.shotlistProductionSource = { ...previous.shotlistProductionSource, durationSync: 'manual' };
  }
  // 节点换了底层文件（重新生成、裁切、重命名…）就必须一并作废旧的资产身份：
  // 加载时 relativePath 的优先级高于 filePath，留着上一次的身份会把节点解析回上一张图。
  // 调用方自己带了 assetId / relativePath（移动到分组目录之类）说明身份仍然有效，按它的来。
  if (
    'filePath' in patch && patch.filePath !== previous.filePath
    && !('assetId' in patch) && !('relativePath' in patch)
  ) {
    next.assetId = undefined;
    next.relativePath = undefined;
  }
  return next;
}

/** 在同一次 Store 更新中同步稳定关联的镜头时长，沿用调用方的历史快照。 */
function mergeNodeDataWithShotDurations(nodes: Node<BaseNodeData>[], targetIds: Set<string>, patch: Partial<BaseNodeData>) {
  const next = nodes.map((node) => targetIds.has(node.id)
    ? { ...node, data: mergeNodeData(node.data, patch) } : node);
  if (!Array.isArray(patch.shotlistRows)) return next;
  const sheets = new Map(nodes.filter((node) => targetIds.has(node.id) && node.data.type === 'ai-shotlist')
    .map((node) => [node.id, node.data.shotlistRows ?? []]));
  return next.map((node) => {
    const source = node.data.shotlistProductionSource;
    if (node.data.type !== 'ai-video' || source?.kind !== 'video' || source.durationSync === 'manual'
      || targetIds.has(node.id)) return node;
    const previousRows = sheets.get(source.nodeId);
    if (!previousRows) return node;
    const previous = previousRows.find((row) => row.id === source.rowId);
    const row = patch.shotlistRows!.find((item) => item.id === source.rowId);
    if (!previous || !row || previous.duration === row.duration) return node;
    const duration = resolveShotVideoDuration(row.duration);
    if (duration === undefined) return node;
    // 旧关联没有同步标记时，仅接管尚未填写或仍与旧分镜相同的时长。
    if (source.durationSync !== 'auto' && node.data.seedanceDuration !== undefined
      && node.data.seedanceDuration !== resolveShotVideoDuration(previous.duration)) return node;
    return { ...node, data: { ...node.data, seedanceDuration: duration,
      shotlistProductionSource: { ...source, durationSync: 'auto' as const } } };
  });
}

function mergeCanvasNotePatch(note: CanvasNoteData, patch: CanvasNotePatch): CanvasNoteData {
  return {
    ...note,
    ...patch,
    style: patch.style ? { ...note.style, ...patch.style } : note.style,
  };
}

function pruneDeletedNodesAndEmptyGroups(
  nodes: Node<BaseNodeData>[],
  edges: Edge[],
  groups: NodeGroup[],
  deletedNodeIds: Set<string>,
) {
  const deletedGroupDataIds = new Set(
    nodes
      .filter((node) => deletedNodeIds.has(node.id) && node.type === 'group')
      .map((node) => (node.data as unknown as GroupNodeDataAccess).groupId)
      .filter(Boolean),
  );
  const prunedGroups = groups
    .filter((group) => !deletedNodeIds.has(group.id) && !deletedGroupDataIds.has(group.id))
    .map((group) => ({
      ...group,
      nodeIds: group.nodeIds.filter((nodeId) => !deletedNodeIds.has(nodeId)),
    }));
  // 只清理「因删除而变空」的分组；手动创建的空文件夹要留着
  const emptyGroupIds = new Set(
    prunedGroups
      .filter((group) => group.nodeIds.length === 0
        && (groups.find((g) => g.id === group.id)?.nodeIds.length ?? 0) > 0)
      .map((group) => group.id),
  );
  const allDeletedNodeIds = new Set(deletedNodeIds);
  for (const groupId of emptyGroupIds) allDeletedNodeIds.add(groupId);
  for (const node of nodes) {
    if (
      node.type === 'group'
      && emptyGroupIds.has((node.data as unknown as GroupNodeDataAccess).groupId)
    ) {
      allDeletedNodeIds.add(node.id);
    }
  }

  return {
    nodes: nodes.filter((node) => !allDeletedNodeIds.has(node.id)),
    edges: edges.filter(
      (edge) => !allDeletedNodeIds.has(edge.source) && !allDeletedNodeIds.has(edge.target),
    ),
    groups: prunedGroups.filter((group) => !emptyGroupIds.has(group.id)),
  };
}

// 每个源数组只保留最近一次过滤结果；正文更新不必让连线投影跟着重建。
const visibleEdgesBySource = new WeakMap<Edge[], Edge[]>();

/** 渲染前剔除隐藏元素：角色库收纳的节点、已折叠分组的子节点，以及它们的连线 */
export function filterHiddenCanvasElements(
  nodes: Node<BaseNodeData>[],
  edges: Edge[],
): { nodes: Node<BaseNodeData>[]; edges: Edge[] } {
  const collapsedGroupIds = new Set(
    nodes.filter((node) => node.data.groupCollapsed === true).map((node) => node.id),
  );
  const visibleNodes = nodes.filter((node) => (
    node.data.hiddenByCharacterLibrary !== true
    && !(node.parentId && collapsedGroupIds.has(node.parentId))
  ));
  if (visibleNodes.length === nodes.length) return { nodes, edges };
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const nextEdges = edges.filter(
    (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
  );
  const previousEdges = visibleEdgesBySource.get(edges);
  const visibleEdges = nextEdges.length === edges.length ? edges
    : previousEdges?.length === nextEdges.length
      && nextEdges.every((edge, index) => edge === previousEdges[index]) ? previousEdges : nextEdges;
  visibleEdgesBySource.set(edges, visibleEdges);
  return {
    nodes: visibleNodes,
    edges: visibleEdges,
  };
}

export interface NodeSlice {
  nodes: Node<BaseNodeData>[];
  edges: Edge[];
  selectedNodeIds: string[];
  setNodes: (nodes: Node<BaseNodeData>[]) => void;
  setEdges: (edges: Edge[]) => void;
  setSelectedNodeIds: (ids: string[]) => void;
  addNode: (node: Node<BaseNodeData>) => void;
  addNodeTransient: (node: Node<BaseNodeData>) => void;
  addNodes: (nodes: Node<BaseNodeData>[]) => void;
  addNodesTransient: (nodes: Node<BaseNodeData>[]) => void;
  addNodeWithEdge: (node: Node<BaseNodeData>, edge: Edge) => void;
  /** 原子添加一组节点和连线，只创建一次历史快照。 */
  addNodesWithEdges: (nodes: Node<BaseNodeData>[], edges: Edge[]) => void;
  createMediaPlaceholder: (
    intent: MediaGenerationIntent,
    position?: { x: number; y: number },
  ) => string;
  settleMediaPlaceholder: (nodeId: string, artifact: MediaGenerationResult) => boolean;
  failMediaPlaceholder: (nodeId: string, error: string) => void;
  materializeMediaArtifact: (
    artifact: MediaGenerationResult,
    position?: { x: number; y: number },
  ) => string;
  /** 在原位复制节点并继承入口边；拖拽时可只复用配置。 */
  duplicateNode: (nodeId: string, options?: { includeContent?: boolean }) => Promise<string | undefined>;
  duplicateCanvasNote: (nodeId: string) => string | null | Promise<string | null>;
  convertImageNodeKind: (nodeId: string) => 'to-note' | 'to-node' | 'connected' | null;
  updateCanvasNote: (nodeId: string, patch: CanvasNotePatch) => boolean;
  updateCanvasNoteTransient: (nodeId: string, patch: CanvasNotePatch) => boolean;
  moveCanvasNoteLayer: (nodeId: string, direction: CanvasNoteLayerDirection) => boolean;
  updateNodeData: (nodeId: string, data: Partial<BaseNodeData>) => void;
  /** 高频手势内更新节点数据，不创建历史快照；调用方负责提交手势开始和结束状态。 */
  updateNodeDataTransient: (nodeId: string, data: Partial<BaseNodeData>) => void;
  /** 高频手势内更新节点位置（左/上边缩放要反向移动节点），同样不写历史。 */
  updateNodePositionTransient: (nodeId: string, position: { x: number; y: number }) => void;
  /** 原子批量更新节点数据（一次历史提交）。 */
  updateNodesDataBatch: (nodeIds: string[], data: Partial<BaseNodeData>) => void;
  linkNodeToCharacter: (
    nodeId: string,
    link: CharacterLibraryNodeLink,
    hideNode: boolean,
  ) => boolean;
  /** 在画布上隐藏/显示被角色库收纳的节点，可来回切换。 */
  setCharacterLibraryNodeHidden: (nodeId: string, hidden: boolean) => boolean;
  releaseCharacterLibraryNodes: (
    scope: CharacterLibraryNodeLink['scope'],
    characterId?: string,
    actionId?: string,
    mediaId?: string,
  ) => string[];
  deleteNode: (nodeId: string) => void;
  /** 原子批量删除多个节点（一次 commitToHistory，一次退场动画） */
  deleteNodesBatch: (nodeIds: string[]) => void;
  onConnect: (connection: Connection) => void;
  connectSelectedNodes: (sourceIds: string[], targetId: string, projectId: string | null) => number;
  addNodeFromSelection: (node: Node<BaseNodeData>, sourceIds: string[], projectId: string | null) => boolean;
  onNodesChange: (changes: NodeChange<Node<BaseNodeData>>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  clearGroupedSelection: () => void;
  settleNodeGroupingOnDragStop: (node: Node<BaseNodeData>) => void;
  /** 把一个图像节点拖入宫格分镜的某格：该格显示此图，源节点被消耗移除 */
  fillStoryboardCell: (storyboardId: string, cellIdx: number, sourceNodeId: string) => void;
  /** 把一个图像/视频节点拖入分镜表的画面格：建立引用，源节点留在画布上 */
  bindShotlistFrame: (shotlistId: string, rowId: string, sourceNodeId: string) => void;
}

/** 拖拽会话只驻留内存；React Flow 仍发送源 ID，将其位移转给副本。 */
export function createNodeDuplicateDrag(getState: () => AppState, sourceId: string) {
  const initial = getState();
  const source = initial.nodes.find((node) => node.id === sourceId);
  const projectId = initial.currentProjectId;
  let position = { ...(source?.position ?? { x: 0, y: 0 }) };
  let dragging = true;
  let cloneId: string | undefined;
  const getClone = () => getState().currentProjectId === projectId
    ? getState().nodes.find((node) => node.id === cloneId)
    : undefined;
  const ready = initial.duplicateNode(sourceId, { includeContent: false }).then((id) => {
    cloneId = id;
    if (getClone()) {
      getState().onNodesChange([{ type: 'position', id: id!, position, dragging }]);
    }
  });

  return {
    sourceId,
    getNode: getClone,
    mapChanges(changes: NodeChange<Node<BaseNodeData>>[]) {
      return changes.flatMap((change): NodeChange<Node<BaseNodeData>>[] => {
        if (change.type !== 'position' || change.id !== sourceId) return [change];
        if (change.position) position = { ...change.position };
        if (change.dragging !== undefined) dragging = change.dragging;
        // 副本身份就绪前先记住最新落点，原节点始终留在原位。
        const original = getState().currentProjectId === projectId
          ? getState().nodes.find((node) => node.id === sourceId)
          : undefined;
        if (!original || !source) return [];
        // 同时刷新源节点的受控位置，覆盖 React Flow 本帧内部的临时拖拽坐标。
        const reset: NodeChange<Node<BaseNodeData>> = {
          type: 'position', id: sourceId, position: { ...source.position }, dragging: false,
        };
        return getClone() ? [reset, { ...change, id: cloneId! }] : [reset];
      });
    },
    async finish() {
      dragging = false;
      await ready;
      const clone = getClone();
      if (!clone) return;
      getState().onNodesChange([
        { type: 'position', id: clone.id, position, dragging: false },
        ...getState().nodes.filter((node) => node.selected).map((node) => ({
          type: 'select' as const, id: node.id, selected: false,
        })),
        { type: 'select', id: clone.id, selected: true },
      ]);
      getState().setSelectedNodeIds([clone.id]);
      return getClone();
    },
  };
}

export const createNodeSlice: StateCreator<AppState, [], [], NodeSlice> = (set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeIds: [],

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),

  addNode: (node) => {
    assertAiAppNodeInsertion([node]);
    get().commitToHistory();
    set((state) => insertPreparedNode(state, node));
  },

  addNodeTransient: (node) => {
    assertAiAppNodeInsertion([node]);
    set((state) => insertPreparedNode(state, node));
  },

  addNodeWithEdge: (node, edge) => {
    assertAiAppNodeInsertion([node]);
    get().commitToHistory();
    set((state) => {
      const inserted = insertPreparedNode(state, node);
      const connected = appendConnectionMentions(inserted.nodes, [edge], state.config?.autoMentionOnConnect, state.activeNodeId);
      return {
        ...inserted,
        nodes: connected.nodes,
        edges: [...state.edges, ...connected.edges],
      };
    });
  },

  addNodesWithEdges: (nodes, edges) => {
    if (nodes.length === 0) return;
    assertAiAppNodeInsertion(nodes);
    get().commitToHistory();
    set((state) => {
      const nextNodes = appendPreparedNodes(state, nodes);
      const connected = appendConnectionMentions(nextNodes, edges, state.config?.autoMentionOnConnect, state.activeNodeId);
      return {
        nodes: connected.nodes,
        edges: [...state.edges, ...connected.edges],
      };
    });
  },

  addNodes: (nodes) => {
    if (nodes.length === 0) return;
    assertAiAppNodeInsertion(nodes);
    get().commitToHistory();
    set((state) => ({ nodes: appendPreparedNodes(state, nodes) }));
  },

  addNodesTransient: (nodes) => {
    if (nodes.length === 0) return;
    assertAiAppNodeInsertion(nodes);
    set((state) => ({ nodes: appendPreparedNodes(state, nodes) }));
  },

  createMediaPlaceholder: (intent, requestedPosition) => {
    const state = get();
    const id = `node-${generateId()}`;
    const type = intent.kind === 'image'
      ? 'ai-image'
      : intent.kind === 'video'
        ? 'ai-video'
        : 'ai-audio';
    const position = requestedPosition ?? getCanvasPointerPosition();
    const label = intent.kind === 'image'
      ? '对话生成图片'
      : intent.kind === 'video'
        ? '对话生成视频'
        : intent.audioPurpose === 'music'
          ? '对话生成音乐'
          : '对话生成语音';
    const settings = state.projects.find(
      (project) => project.id === state.currentProjectId,
    )?.settings;
    const nodeData = applyProjectDefaultsToNodeData({
      label,
      type,
      role: 'generator',
      prompt: intent.prompt,
      model: intent.modelRef,
      status: 'loading',
      nodeWidth: 280,
      nodeHeight: intent.kind === 'image' ? 158 : 160,
    }, settings);
    state.commitToHistory();
    set((current) => ({
      nodes: [...current.nodes, {
        id,
        type,
        position,
        data: {
          ...nodeData,
          role: 'source',
          displayId: getNextDisplayId(current.nodes),
        },
      } as Node<BaseNodeData>],
    }));
    return id;
  },

  settleMediaPlaceholder: (nodeId, artifact) => {
    if (!get().nodes.some((node) => node.id === nodeId)) return false;
    set((state) => ({
      nodes: state.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        const mediaField = artifact.kind === 'image'
          ? { imageUrl: artifact.url, imageWidth: artifact.width, imageHeight: artifact.height }
          : artifact.kind === 'video'
            ? { videoUrl: artifact.url }
            : { audioUrl: artifact.url };
        return {
          ...node,
          data: {
            ...node.data,
            ...mediaField,
            artifactId: artifact.id,
            prompt: artifact.prompt,
            model: artifact.modelId,
            provider: artifact.provider,
            output: artifact.sourceUrl,
            sourceUrl: artifact.sourceUrl,
            filePath: artifact.filePath,
            thumbnailUrl: artifact.kind === 'image' ? artifact.url : undefined,
            status: 'success',
            error: undefined,
          },
        } as Node<BaseNodeData>;
      }),
    }));
    return true;
  },

  failMediaPlaceholder: (nodeId, error) => {
    set((state) => ({
      nodes: state.nodes.map((node) => node.id === nodeId
        ? { ...node, data: { ...node.data, status: 'error', error } as BaseNodeData }
        : node),
    }));
  },

  materializeMediaArtifact: (artifact, requestedPosition) => {
    const state = get();
    const existing = state.nodes.find((node) => node.data.artifactId === artifact.id);
    if (existing) return existing.id;

    const id = `node-${generateId()}`;
    const type = artifact.kind === 'image'
      ? 'ai-image'
      : artifact.kind === 'video'
        ? 'ai-video'
        : 'ai-audio';
    const position = requestedPosition ?? getCanvasPointerPosition();
    const mediaField = artifact.kind === 'image'
      ? { imageUrl: artifact.url, imageWidth: artifact.width, imageHeight: artifact.height }
      : artifact.kind === 'video'
        ? { videoUrl: artifact.url }
        : { audioUrl: artifact.url };
    const label = artifact.kind === 'image'
      ? '对话生成图片'
      : artifact.kind === 'video'
        ? '对话生成视频'
        : artifact.audioPurpose === 'music'
          ? '对话生成音乐'
          : '对话生成语音';
    const settings = state.projects.find(
      (project) => project.id === state.currentProjectId,
    )?.settings;
    const nodeData = applyProjectDefaultsToNodeData({
      label,
      type,
      role: 'generator',
      prompt: artifact.prompt,
      model: artifact.modelId,
      provider: artifact.provider,
      status: 'success',
      nodeWidth: 280,
      nodeHeight: artifact.kind === 'image' ? 158 : 160,
    }, settings);
    state.commitToHistory();
    set((current) => ({
      nodes: [...current.nodes, {
        id,
        type,
        position,
        data: {
          ...nodeData,
          role: 'source',
          artifactId: artifact.id,
          output: artifact.sourceUrl,
          sourceUrl: artifact.sourceUrl,
          filePath: artifact.filePath,
          thumbnailUrl: artifact.kind === 'image' ? artifact.url : undefined,
          ...mediaField,
          displayId: getNextDisplayId(current.nodes),
        },
      } as Node<BaseNodeData>],
    }));
    return id;
  },

  updateNodeData: (nodeId, data) => {
    const nodes = mergeNodeDataWithShotDurations(get().nodes, new Set([nodeId]), data);
    get().commitToHistory();
    set({ nodes });
  },

  updateNodeDataTransient: (nodeId, data) => {
    set((state) => ({
      nodes: mergeNodeDataWithShotDurations(state.nodes, new Set([nodeId]), data),
    }));
  },

  updateNodePositionTransient: (nodeId, position) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId ? { ...node, position } : node
      ),
    }));
  },

  updateNodesDataBatch: (nodeIds, data) => {
    if (nodeIds.length === 0) return;
    const nodes = mergeNodeDataWithShotDurations(get().nodes, new Set(nodeIds), data);
    get().commitToHistory();
    set({ nodes });
  },

  linkNodeToCharacter: (nodeId, link, hideNode) => {
    const node = get().nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return false;
    const previousLinks = node.data.characterLibraryLinks ?? [];
    const retainedLinks = previousLinks.filter(
      (item) => item.scope !== link.scope || item.characterId !== link.characterId
        || (link.actionId !== undefined
          ? item.actionId !== link.actionId || item.mediaId !== link.mediaId
          : item.actionId !== undefined),
    );
    const nextLinks = [...retainedLinks, link];
    const nextHidden = node.data.hiddenByCharacterLibrary === true || hideNode;
    const sameLink = previousLinks.length === nextLinks.length
      && previousLinks.every((item, index) => (
        item.scope === nextLinks[index].scope
        && item.characterId === nextLinks[index].characterId
        && item.referenceImageId === nextLinks[index].referenceImageId
        && item.actionId === nextLinks[index].actionId
        && item.mediaId === nextLinks[index].mediaId
      ));
    if (sameLink && nextHidden === (node.data.hiddenByCharacterLibrary === true)) return false;

    get().commitToHistory();
    set((state) => ({
      nodes: state.nodes.map((candidate) => candidate.id === nodeId
        ? {
            ...candidate,
            selected: hideNode ? false : candidate.selected,
            data: {
              ...candidate.data,
              characterLibraryLinks: nextLinks,
              hiddenByCharacterLibrary: nextHidden || undefined,
            },
          }
        : candidate),
      selectedNodeIds: hideNode
        ? state.selectedNodeIds.filter((id) => id !== nodeId)
        : state.selectedNodeIds,
    }));
    return true;
  },

  setCharacterLibraryNodeHidden: (nodeId, hidden) => {
    const node = get().nodes.find((candidate) => candidate.id === nodeId);
    if (!node || (node.data.hiddenByCharacterLibrary === true) === hidden) return false;
    get().commitToHistory();
    set((state) => ({
      nodes: state.nodes.map((candidate) => candidate.id === nodeId
        ? {
            ...candidate,
            selected: hidden ? false : candidate.selected,
            data: { ...candidate.data, hiddenByCharacterLibrary: hidden },
          }
        : candidate),
      // 隐藏的节点不能留在选中集里，否则后续操作会作用到看不见的节点上
      selectedNodeIds: hidden
        ? state.selectedNodeIds.filter((id) => id !== nodeId)
        : state.selectedNodeIds,
    }));
    return true;
  },

  releaseCharacterLibraryNodes: (scope, characterId, actionId, mediaId) => {
    const matches = (link: CharacterLibraryNodeLink) => (
      link.scope === scope && (characterId === undefined || link.characterId === characterId)
      && (actionId === undefined || link.actionId === actionId)
      && (mediaId === undefined || link.mediaId === mediaId)
    );
    const affectedNodes = get().nodes.filter((node) => (
      node.data.characterLibraryLinks ?? []
    ).some(matches));
    if (affectedNodes.length === 0) return [];

    get().commitToHistory();
    const restoredNodeIds: string[] = [];
    set((state) => ({
      nodes: state.nodes.map((node) => {
        const links = node.data.characterLibraryLinks ?? [];
        const nextLinks = links.filter((link) => !matches(link));
        if (nextLinks.length === links.length) return node;
        const data = { ...node.data };
        if (nextLinks.length > 0) data.characterLibraryLinks = nextLinks;
        else delete data.characterLibraryLinks;
        if (data.hiddenByCharacterLibrary && nextLinks.length === 0) {
          data.hiddenByCharacterLibrary = false;
          restoredNodeIds.push(node.id);
        }
        return { ...node, data };
      }),
    }));
    return restoredNodeIds;
  },

  duplicateNode: async (nodeId, options) => {
    const state = get();
    const src = state.nodes.find((n) => n.id === nodeId);
    // 分组节点暂不支持拖拽复制（涉及子节点/边重映射）
    if (!src || src.type === 'group') return;
    if (isAiAppNode(src)) { state.showToast(AI_APP_COPY_MESSAGE, 'error'); return; }
    // 笔记承载手写内容，继续沿用完整复制。
    const includeContent = options?.includeContent !== false || src.type === 'canvas-note';
    let duplicateData = src.data;
    if (includeContent && needsNodeMediaCopy(src.data)) {
      const guard = registerCanvasDerivation(state, nodeId);
      if (!guard) { state.showToast('请先创建项目再复制媒体', 'error'); return; }
      state.showToast('正在复制素材…');
      try {
        duplicateData = await copyNodeMedia(src.data, guard.projectId);
        if (!isCanvasDerivationFresh(guard, get())
          || get().nodes.find((node) => node.id === nodeId)?.data !== src.data) {
          await discardCopiedNodeMedia(duplicateData, src.data);
          get().showToast('画布已变化，请重新复制');
          return;
        }
      } catch {
        if (get().currentProjectId === guard.projectId) get().showToast('素材复制失败，请重试', 'error');
        return;
      } finally { completeCanvasDerivation(guard); }
    }
    get().commitToHistory();

    // 原节点的真实 ID、编号和引用保持不变，副本使用自己的新身份。
    const cloneId = `node-${generateId()}`;
    const newDisplayId = getNextDisplayId(get().nodes);

    set((s) => {
      const clone = {
        ...src,
        id: cloneId,
        position: { ...src.position },
        data: { ...prepareDuplicateNodeData(duplicateData, src.type, cloneId, includeContent), displayId: newDisplayId },
        selected: false,
        dragging: false,
      } as Node<BaseNodeData>;
      const nodes = [...s.nodes, clone];
      // 副本仅继承入口边，不改写原边或下游引用。
      const inheritedIncomingEdges = s.edges
        .filter((edge) => edge.target === nodeId)
        .map((edge) => ({ ...edge, id: `edge-${generateId()}`, target: cloneId }));
      return {
        nodes,
        edges: [...s.edges, ...inheritedIncomingEdges],
        groups: s.groups.map((group) => group.nodeIds.includes(nodeId)
          ? { ...group, nodeIds: [...group.nodeIds, cloneId] }
          : group),
      };
    });
    return cloneId;
  },

  duplicateCanvasNote: (nodeId) => {
    const state = get();
    const source = state.nodes.find((node) => node.id === nodeId && node.type === 'canvas-note');
    if (!source?.data.note) return null;
    if (needsNodeMediaCopy(source.data)) {
      const guard = registerCanvasDerivation(state, nodeId);
      if (!guard) return null;
      return (async () => {
        try {
          const data = await copyNodeMedia(source.data, guard.projectId);
          if (!isCanvasDerivationFresh(guard, get())
            || get().nodes.find((node) => node.id === nodeId)?.data !== source.data) {
            await discardCopiedNodeMedia(data, source.data);
            return null;
          }
          const cloneId = `node-${generateId()}`;
          get().commitToHistory();
          get().addNodeTransient({ ...source, id: cloneId,
            position: { x: source.position.x + 24, y: source.position.y + 24 },
            data, selected: false, dragging: false });
          return cloneId;
        } catch {
          if (get().currentProjectId === guard.projectId) get().showToast('素材复制失败，请重试', 'error');
          return null;
        } finally { completeCanvasDerivation(guard); }
      })();
    }
    state.commitToHistory();
    const cloneId = `node-${generateId()}`;
    const clone = {
      ...source,
      id: cloneId,
      position: { x: source.position.x + 24, y: source.position.y + 24 },
      selected: true,
      dragging: false,
      data: {
        ...structuredClone(source.data),
        displayId: getNextDisplayId(state.nodes),
      },
    } as Node<BaseNodeData>;
    set((current) => ({
      nodes: [
        ...current.nodes.map((node) => node.selected ? { ...node, selected: false } : node),
        clone,
      ],
      selectedNodeIds: [cloneId],
    }));
    return cloneId;
  },

  convertImageNodeKind: (nodeId) => {
    const state = get();
    const source = state.nodes.find((node) => node.id === nodeId);
    if (!source) return null;

    const isImageNode = source.type === 'ai-image' || source.type === 'source-image';
    const isImageNote = source.type === 'canvas-note' && source.data.note?.kind === 'image';
    const imageUrl = source.data.imageUrl || source.data.thumbnailUrl;
    if ((!isImageNode && !isImageNote) || !imageUrl) return null;

    if (isImageNode && state.edges.some((edge) => edge.source === nodeId || edge.target === nodeId)) {
      return 'connected';
    }

    state.commitToHistory();
    set((current) => ({
      nodes: current.nodes.map((node) => {
        if (node.id !== nodeId) return node;

        if (isImageNode) {
          const width = node.data.nodeWidth ?? node.data.imageWidth ?? 320;
          const height = node.data.nodeHeight ?? node.data.imageHeight ?? 220;
          const note = createCanvasNoteData('image', { width, height });
          return {
            ...node,
            type: 'canvas-note',
            data: {
              ...node.data,
              type: 'canvas-note',
              imageUrl,
              note,
              nodeWidth: width,
              nodeHeight: height,
            },
          } as Node<BaseNodeData>;
        }

        const { note, ...data } = node.data;
        return {
          ...node,
          type: 'ai-image',
          data: {
            ...data,
            type: 'ai-image',
            role: data.role === 'generator' ? 'generator' : 'source',
            status: data.status ?? 'success',
            imageUrl,
            nodeWidth: note?.width ?? data.nodeWidth,
            nodeHeight: note?.height ?? data.nodeHeight,
          },
        } as Node<BaseNodeData>;
      }),
    }));
    return isImageNode ? 'to-note' : 'to-node';
  },

  updateCanvasNote: (nodeId, patch) => {
    const node = get().nodes.find((candidate) => candidate.id === nodeId && candidate.type === 'canvas-note');
    if (!node?.data.note) return false;
    get().commitToHistory();
    return get().updateCanvasNoteTransient(nodeId, patch);
  },

  updateCanvasNoteTransient: (nodeId, patch) => {
    let changed = false;
    set((state) => ({
      nodes: state.nodes.map((node) => {
        if (node.id !== nodeId || node.type !== 'canvas-note' || !node.data.note) return node;
        changed = true;
        const note = mergeCanvasNotePatch(node.data.note, patch);
        return {
          ...node,
          data: {
            ...node.data,
            note,
            nodeWidth: note.width,
            nodeHeight: note.height,
          },
        } as Node<BaseNodeData>;
      }),
    }));
    return changed;
  },

  moveCanvasNoteLayer: (nodeId, direction) => {
    const state = get();
    const index = state.nodes.findIndex((node) => node.id === nodeId && node.type === 'canvas-note');
    if (index < 0) return false;
    let target = index;
    if (direction === 'back') target = 0;
    if (direction === 'backward') target = Math.max(0, index - 1);
    if (direction === 'forward') target = Math.min(state.nodes.length - 1, index + 1);
    if (direction === 'front') target = state.nodes.length - 1;
    if (target === index) return false;
    state.commitToHistory();
    set((current) => {
      const nodes = [...current.nodes];
      const [note] = nodes.splice(index, 1);
      nodes.splice(target, 0, note);
      return { nodes };
    });
    return true;
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
    // Cancel any active polling for all deleted nodes
    for (const id of idsToDelete) {
      cancelNodePolling(id);
    }

    // Delete local files for all affected nodes —— 跳过仍被存活节点引用的共享文件（复制节点场景）
    const keepPaths = collectKeepPaths(nodes, idsToDelete, get().messages);
    void fileService.deleteNodeFiles(
      nodes.filter((node) => idsToDelete.has(node.id) && !node.data.artifactId).map((node) => node.data),
      keepPaths, get().currentProjectId,
      fileService.deletedGroupFolderNames(get().groups, idsToDelete),
    ).catch((e) => console.warn('[删除节点] 文件清理失败:', e));

    // 先播放退场动画，结束后再真正从状态中移除（动画期间历史已提交，撤销仍指向删除前状态）
    playNodeExit([...idsToDelete]).then(() => {
      set((state) => pruneDeletedNodesAndEmptyGroups(
        state.nodes,
        state.edges,
        state.groups,
        idsToDelete,
      ));
    });
  },

  deleteNodesBatch: (nodeIds) => {
    if (nodeIds.length === 0) return;
    // 最多删 BATCH_NODE_LIMIT 个
    const limitedIds = nodeIds.length > BATCH_NODE_LIMIT ? nodeIds.slice(0, BATCH_NODE_LIMIT) : nodeIds;

    get().commitToHistory();

    // 收集所有要删除的 ID（包含子节点递归）
    const idsToDelete = new Set<string>(limitedIds);
    const { nodes } = get();
    const q = [...limitedIds];
    while (q.length > 0) {
      const pid = q.shift()!;
      nodes.filter((n) => n.parentId === pid).forEach((c) => {
        idsToDelete.add(c.id);
        q.push(c.id);
      });
    }
    // 取消所有轮询
    for (const id of idsToDelete) {
      cancelNodePolling(id);
    }

    // 清理文件
    const keepPaths = collectKeepPaths(nodes, idsToDelete, get().messages);
    void fileService.deleteNodeFiles(
      nodes.filter((node) => idsToDelete.has(node.id) && !node.data.artifactId).map((node) => node.data),
      keepPaths, get().currentProjectId,
      fileService.deletedGroupFolderNames(get().groups, idsToDelete),
    ).catch((e) => console.warn('[批量删除] 文件清理失败:', e));

    // 统一播放退场动画后移除
    playNodeExit([...idsToDelete]).then(() => {
      set((state) => pruneDeletedNodesAndEmptyGroups(
        state.nodes,
        state.edges,
        state.groups,
        idsToDelete,
      ));
    });
  },

  bindShotlistFrame: (shotlistId, rowId, sourceNodeId) => {
    const { nodes } = get();
    const shotlist = nodes.find((n) => n.id === shotlistId && n.type === 'ai-shotlist');
    const src = nodes.find((n) => n.id === sourceNodeId);
    if (!shotlist || !src) return;

    const isVideo = src.type === 'ai-video' || src.type === 'source-video';
    const isImage = src.type === 'ai-image' || src.type === 'source-image';
    if (!isVideo && !isImage) return;

    const url = (isVideo
      ? src.data.videoUrl
      : (src.data.imageUrl || src.data.thumbnailUrl)) as string | undefined;
    if (!url && !src.data.filePath) return;

    const rows = Array.isArray(shotlist.data.shotlistRows)
      ? (shotlist.data.shotlistRows as ShotRow[])
      : [];
    if (!rows.some((row) => row.id === rowId)) return;

    get().commitToHistory();
    // 快照仅供源节点日后被删除时兜底显示；渲染与推送都以画布上的实时节点为准
    const nextRows = rows.map((row) => (row.id === rowId
      ? {
        ...row,
        frame: {
          nodeId: sourceNodeId,
          kind: isVideo ? ('video' as const) : ('image' as const),
          url,
          filePath: src.data.filePath as string | undefined,
          assetId: src.data.assetId as string | undefined,
          sourceDuration: typeof src.data.videoDuration === 'number' ? src.data.videoDuration : undefined,
        },
      }
      : row));
    // 源节点保持在画布上：分镜表持有的是引用，不是所有权
    get().updateNodeDataTransient(shotlistId, { shotlistRows: nextRows } as Partial<BaseNodeData>);
    get().commitToHistory();
    get().showToast('已放入分镜表');
  },

  fillStoryboardCell: (storyboardId, cellIdx, sourceNodeId) => {
    const { nodes } = get();
    const sb = nodes.find((n) => n.id === storyboardId && n.type === 'ai-storyboard');
    const src = nodes.find((n) => n.id === sourceNodeId);
    if (!sb || !src || !STORYBOARD_CELL_SOURCE_TYPES.includes(src.type ?? '')) return;
    const url = (src.data.imageUrl || src.data.thumbnailUrl) as string | undefined;
    if (!url) return;

    const cols = (sb.data.storyboardCols as number) || 3;
    const rows = (sb.data.storyboardRows as number) || 3;
    const total = cols * rows;
    const overrides: (StoryboardCellOverride | null)[] = Array.isArray(sb.data.storyboardOverrides)
      ? [...(sb.data.storyboardOverrides as (StoryboardCellOverride | null)[])]
      : new Array(total).fill(null);
    const extracted = Array.isArray(sb.data.storyboardExtracted)
      ? [...(sb.data.storyboardExtracted as boolean[])]
      : new Array(total).fill(false);
    while (overrides.length < total) overrides.push(null);
    while (extracted.length < total) extracted.push(false);

    // 只允许填入已提取形成的空格；同时防止陈旧拖拽目标覆盖已有 override。
    if (
      !Number.isInteger(cellIdx)
      || cellIdx < 0
      || cellIdx >= total
      || overrides[cellIdx]
      || !extracted[cellIdx]
    ) return;

    get().commitToHistory();

    overrides[cellIdx] = { url, filePath: (src.data.filePath as string) || undefined };
    extracted[cellIdx] = false;
    get().updateNodeDataTransient(storyboardId, {
      storyboardOverrides: overrides,
      storyboardExtracted: extracted,
    } as Partial<BaseNodeData>);

    // 直接移除源节点，不走 deleteNode —— 避免回收正被该格复用的图片文件
    cancelNodePolling(sourceNodeId);
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== sourceNodeId),
      edges: state.edges.filter((e) => e.source !== sourceNodeId && e.target !== sourceNodeId),
    }));
    get().commitToHistory();
    get().showToast('已放入宫格');
  },

  onConnect: (connection) => {
    // Loose 模式允许从任一端开始拖拽；持久化前统一为「右侧输出 → 左侧输入」。
    const normalized = normalizeCanvasConnection(connection);
    if (!normalized) return;
    get().commitToHistory();
    const id = `edge-${generateId()}`;
    const edge: Edge = {
      id,
      ...normalized,
    };
    set((state) => {
      const connected = appendConnectionMentions(state.nodes, [edge], state.config?.autoMentionOnConnect, state.activeNodeId);
      return { nodes: connected.nodes, edges: [...state.edges, ...connected.edges] };
    });
  },

  connectSelectedNodes: (sourceIds, targetId, projectId) => {
    const state = get();
    const sources = resolveBatchSources(state, sourceIds, projectId, targetId);
    const target = state.nodes.find((node) => node.id === targetId);
    if (!sources || !target || !isBatchConnectableNode(target)
      || (target.parentId && state.nodes.find((node) => node.id === target.parentId)?.data.groupCollapsed === true)) return 0;
    const nextEdges = newBatchEdges(sources, targetId, state.edges);
    if (nextEdges.length === 0) return 0;
    state.commitToHistory();
    set((current) => {
      const connected = appendConnectionMentions(current.nodes, nextEdges, current.config?.autoMentionOnConnect, current.activeNodeId);
      return { nodes: connected.nodes, edges: [...current.edges, ...connected.edges] };
    });
    return nextEdges.length;
  },

  addNodeFromSelection: (node, sourceIds, projectId) => {
    assertAiAppNodeInsertion([node]);
    const state = get();
    const sources = resolveBatchSources(state, sourceIds, projectId, node.id);
    if (!sources || !isBatchConnectableNode(node) || state.nodes.some((item) => item.id === node.id)) return false;
    const nextEdges = newBatchEdges(sources, node.id, state.edges);
    state.commitToHistory();
    set((current) => {
      const displayId = getNextDisplayId(current.nodes);
      const settings = current.projects.find((project) => project.id === current.currentProjectId)?.settings;
      const data = applyProjectDefaultsToNodeData(node.data, settings);
      const inserted = insertNodeInGroup(current, prepareNodeForInsertion(node, data, displayId));
      const connected = appendConnectionMentions(inserted.nodes, nextEdges, current.config?.autoMentionOnConnect, current.activeNodeId);
      return {
        ...inserted,
        nodes: connected.nodes,
        edges: [...current.edges, ...connected.edges],
      };
    });
    return true;
  },

  onNodesChange: (changes) => {
    assertAiAppNodeInsertion(changes.flatMap((change) => (
      change.type === 'add' || change.type === 'replace' ? [change.item] : []
    )));
    const removedIds = changes
      .filter((c) => c.type === 'remove')
      .map((c) => c.id);

    // Cancel any active polling for removed nodes
    for (const id of removedIds) {
      cancelNodePolling(id);
    }

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
    const removedIdSet = new Set(removedIds);
    set((s) => pruneDeletedNodesAndEmptyGroups(
      applyNodeChanges(changes, s.nodes) as Node<BaseNodeData>[],
      s.edges,
      s.groups,
      removedIdSet,
    ));
  },

  onEdgesChange: (changes) => {
    const hasRemoval = changes.some((c) => c.type === 'remove');
    if (hasRemoval) get().commitToHistory();
    set((s) => {
      const edges = applyEdgeChanges(changes, s.edges) as Edge[];
      if (!hasRemoval) return { edges };
      const remainingIds = new Set(edges.map((edge) => edge.id));
      return {
        edges,
        nodes: removeDisconnectedMentions(s.nodes, s.edges.filter((edge) => !remainingIds.has(edge.id)), edges),
      };
    });
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

    if (!allNodes.some((candidate) => candidate.id === node.id)) return;
    const groupNodes = allNodes.filter((candidate) => candidate.type === 'group' && !candidate.hidden);
    const oldParent = groupNodes.find((candidate) => candidate.id === node.parentId);
    // 分镜等非普通分组的父子关系由对应业务入口管理。
    if (node.parentId && !oldParent) return;
    const center = nodeCenter(node, allNodes);
    const parent = oldParent && groupContainsPoint(oldParent, center, allNodes)
      ? oldParent
      : groupNodes.find((candidate) => groupContainsPoint(candidate, center, allNodes));
    if (parent?.id === node.parentId) return;

    const absPos = absoluteNodePosition(node, allNodes);
    const parentPos = parent ? absoluteNodePosition(parent, allNodes) : { x: 0, y: 0 };
    let newNodes = allNodes.map((candidate) => candidate.id === node.id ? {
      ...candidate,
      parentId: parent?.id,
      position: { x: absPos.x - parentPos.x, y: absPos.y - parentPos.y },
    } : candidate);
    let newGroups = state.groups.map((group) => {
      if (group.id === parent?.data.groupId) {
        return { ...group, nodeIds: [...new Set([...group.nodeIds, node.id])] };
      }
      if (group.id === oldParent?.data.groupId) {
        return { ...group, nodeIds: group.nodeIds.filter((id) => id !== node.id) };
      }
      return group;
    });

    const emptyGroupIds = new Set(
      groupNodes
        .filter((gn) => gn.id === oldParent?.id && !newNodes.some((n) => n.parentId === gn.id))
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

    // React Flow 要求父节点排在子节点之前，旧空节点拖入后也必须满足。
    newNodes = [...newNodes.filter((n) => n.type === 'group'), ...newNodes.filter((n) => n.type !== 'group')];
    state.commitToHistory();
    set({ nodes: newNodes, groups: newGroups });
  },
});
