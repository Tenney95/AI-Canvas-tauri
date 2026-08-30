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
import { generateId, getNextDisplayId } from './store.utils';
import { BATCH_NODE_LIMIT } from './store.chat';
import * as fileService from '../services/fileService';
import { playNodeExit } from '../utils/nodeAnimations';
import { cancelNodePolling } from '../services/pollManager';
import { applyProjectDefaultsToNodeData } from '../services/projectSettingsService';
import { getCanvasPointerPosition } from '../services/canvasPointerService';
import { resolveDirectorRuntime } from '../services/directorRuntimeRegistry';
import { clearPluginFileGrants } from '../services/plugins/pluginFileGrantService';

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

function prepareDuplicateNodeData(
  data: BaseNodeData,
  nodeType: string | undefined,
  cloneId: string,
): BaseNodeData {
  const duplicate = structuredClone(data);

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
    if (!idsToDelete.has(node.id)) {
      fileService.collectNodeFileReferences(data).forEach((reference) => keepPaths.add(reference));
    }
    // 宫格格子无论节点存活与否都不删：删除路径只清 filePath，撤销也只还原 filePath
    for (const override of data.storyboardOverrides ?? []) {
      if (override?.filePath) keepPaths.add(override.filePath);
    }
  }
  for (const message of messages) {
    if (message.mediaResult?.filePath) keepPaths.add(message.mediaResult.filePath);
  }
  return keepPaths;
}

function mergeNodeData(previous: BaseNodeData, patch: Partial<BaseNodeData>): BaseNodeData {
  const next = { ...previous, ...patch } as BaseNodeData;
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
  return {
    nodes: visibleNodes,
    edges: edges.filter(
      (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
    ),
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
  /** 在原位复制一个节点，并让拖出的副本继承入口边——用于 Ctrl 拖拽复制。 */
  duplicateNode: (nodeId: string) => void;
  duplicateCanvasNote: (nodeId: string) => string | null;
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
  ) => string[];
  deleteNode: (nodeId: string) => void;
  /** 原子批量删除多个节点（一次 commitToHistory，一次退场动画） */
  deleteNodesBatch: (nodeIds: string[]) => void;
  onConnect: (connection: Connection) => void;
  onNodesChange: (changes: NodeChange<Node<BaseNodeData>>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  clearGroupedSelection: () => void;
  settleNodeGroupingOnDragStop: (node: Node<BaseNodeData>) => void;
  /** 把一个图像节点拖入宫格分镜的某格：该格显示此图，源节点被消耗移除 */
  fillStoryboardCell: (storyboardId: string, cellIdx: number, sourceNodeId: string) => void;
  /** 把一个图像/视频节点拖入分镜表的画面格：建立引用，源节点留在画布上 */
  bindShotlistFrame: (shotlistId: string, rowId: string, sourceNodeId: string) => void;
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
    get().addNodeTransient(node);
  },

  addNodeTransient: (node) => {
    set((state) => {
      const displayId = getNextDisplayId(state.nodes);
      const settings = state.projects.find((project) => project.id === state.currentProjectId)?.settings;
      const data = applyProjectDefaultsToNodeData(node.data, settings);
      return {
        nodes: [...state.nodes, prepareNodeForInsertion(node, data, displayId)],
      };
    });
  },

  addNodeWithEdge: (node, edge) => {
    get().commitToHistory();
    set((state) => {
      const displayId = getNextDisplayId(state.nodes);
      const settings = state.projects.find((project) => project.id === state.currentProjectId)?.settings;
      const data = applyProjectDefaultsToNodeData(node.data, settings);
      return {
        nodes: [...state.nodes, prepareNodeForInsertion(node, data, displayId)],
        edges: [...state.edges, edge],
      };
    });
  },

  addNodesWithEdges: (nodes, edges) => {
    if (nodes.length === 0) return;
    get().commitToHistory();
    set((state) => {
      const nextNodes = [...state.nodes];
      const settings = state.projects.find((project) => project.id === state.currentProjectId)?.settings;
      for (const node of nodes) {
        const displayId = getNextDisplayId(nextNodes);
        const data = applyProjectDefaultsToNodeData(node.data, settings);
        nextNodes.push(prepareNodeForInsertion(node, data, displayId));
      }
      return {
        nodes: nextNodes,
        edges: [...state.edges, ...edges],
      };
    });
  },

  addNodes: (nodes) => {
    if (nodes.length === 0) return;
    get().commitToHistory();
    get().addNodesTransient(nodes);
  },

  addNodesTransient: (nodes) => {
    if (nodes.length === 0) return;
    set((state) => {
      const nextNodes = [...state.nodes];
      const settings = state.projects.find((project) => project.id === state.currentProjectId)?.settings;
      for (const node of nodes) {
        const displayId = getNextDisplayId(nextNodes);
        const data = applyProjectDefaultsToNodeData(node.data, settings);
        nextNodes.push(prepareNodeForInsertion(node, data, displayId));
      }
      return { nodes: nextNodes };
    });
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
    get().commitToHistory();
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: mergeNodeData(n.data, data) } : n
      ),
    }));
  },

  updateNodeDataTransient: (nodeId, data) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId ? { ...node, data: mergeNodeData(node.data, data) } : node
      ),
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
    const targetIds = new Set(nodeIds);
    get().commitToHistory();
    set((state) => ({
      nodes: state.nodes.map((node) => targetIds.has(node.id)
        ? { ...node, data: mergeNodeData(node.data, data) }
        : node),
    }));
  },

  linkNodeToCharacter: (nodeId, link, hideNode) => {
    const node = get().nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return false;
    const previousLinks = node.data.characterLibraryLinks ?? [];
    const retainedLinks = previousLinks.filter(
      (item) => item.scope !== link.scope || item.characterId !== link.characterId,
    );
    const nextLinks = [...retainedLinks, link];
    const nextHidden = node.data.hiddenByCharacterLibrary === true || hideNode;
    const sameLink = previousLinks.length === nextLinks.length
      && previousLinks.every((item, index) => (
        item.scope === nextLinks[index].scope
        && item.characterId === nextLinks[index].characterId
        && item.referenceImageId === nextLinks[index].referenceImageId
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

  releaseCharacterLibraryNodes: (scope, characterId) => {
    const affectedNodes = get().nodes.filter((node) => (
      node.data.characterLibraryLinks ?? []
    ).some((link) => (
      link.scope === scope && (characterId === undefined || link.characterId === characterId)
    )));
    if (affectedNodes.length === 0) return [];

    get().commitToHistory();
    const restoredNodeIds: string[] = [];
    set((state) => ({
      nodes: state.nodes.map((node) => {
        const links = node.data.characterLibraryLinks ?? [];
        const nextLinks = links.filter((link) => (
          link.scope !== scope || (characterId !== undefined && link.characterId !== characterId)
        ));
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

  duplicateNode: (nodeId) => {
    const state = get();
    const src = state.nodes.find((n) => n.id === nodeId);
    // 分组节点暂不支持拖拽复制（涉及子节点/边重映射）
    if (!src || src.type === 'group') return;
    state.commitToHistory();

    // 身份对调：克隆留在原位并承接原节点的边与编号；被拖动的节点
    // 改成新编号，同时额外继承一份入口边。
    const cloneId = `node-${generateId()}`;
    const newDisplayId = getNextDisplayId(state.nodes);

    set((s) => {
      const clone = {
        ...src,
        id: cloneId,
        position: { ...src.position },
        data: prepareDuplicateNodeData(src.data, src.type, cloneId),
        selected: false,
        dragging: false,
      } as Node<BaseNodeData>;
      const nodes = s.nodes.map((n) =>
        n.id === nodeId
          ? ({ ...n, data: { ...n.data, displayId: newDisplayId } } as Node<BaseNodeData>)
          : n,
      );
      nodes.push(clone);
      // 原边改连到原位克隆，拖出的节点仅继承入口边，避免复制输出影响下游。
      const remappedEdges = s.edges.map((e) =>
        e.source === nodeId || e.target === nodeId
          ? { ...e, source: e.source === nodeId ? cloneId : e.source, target: e.target === nodeId ? cloneId : e.target }
          : e,
      );
      const inheritedIncomingEdges = s.edges
        .filter((edge) => edge.target === nodeId)
        .map((edge) => ({ ...edge, id: `edge-${generateId()}` }));
      return { nodes, edges: [...remappedEdges, ...inheritedIncomingEdges] };
    });
  },

  duplicateCanvasNote: (nodeId) => {
    const state = get();
    const source = state.nodes.find((node) => node.id === nodeId && node.type === 'canvas-note');
    if (!source?.data.note) return null;
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
    clearPluginFileGrants(undefined, idsToDelete);

    // Cancel any active polling for all deleted nodes
    for (const id of idsToDelete) {
      cancelNodePolling(id);
    }

    // Delete local files for all affected nodes —— 跳过仍被存活节点引用的共享文件（复制节点场景）
    const keepPaths = collectKeepPaths(nodes, idsToDelete, get().messages);
    for (const id of idsToDelete) {
      const n = nodes.find((nn) => nn.id === id);
      if (n && !n.data.artifactId) {
        fileService.deleteNodeFile(n.data as BaseNodeData, keepPaths, get().currentProjectId)
          .catch((e) => console.warn('[删除节点] 文件清理失败:', e));
      }
    }

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
    clearPluginFileGrants(undefined, idsToDelete);

    // 取消所有轮询
    for (const id of idsToDelete) {
      cancelNodePolling(id);
    }

    // 清理文件
    const keepPaths = collectKeepPaths(nodes, idsToDelete, get().messages);
    for (const id of idsToDelete) {
      const n = nodes.find((nn) => nn.id === id);
      if (n && !n.data.artifactId) {
        fileService.deleteNodeFile(n.data as BaseNodeData, keepPaths, get().currentProjectId)
          .catch((e) => console.warn('[批量删除] 文件清理失败:', e));
      }
    }

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
    set((state) => ({ edges: [...state.edges, edge] }));
  },

  onNodesChange: (changes) => {
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
