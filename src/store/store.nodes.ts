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
  CanvasNoteLayerDirection,
  CanvasNotePatch,
  CharacterLibraryNodeLink,
  ShotRow,
  ShotVideoBinding,
  StoryboardCellOverride,
} from '../types';
import { createCanvasNoteData, STORYBOARD_CELL_SOURCE_TYPES } from '../types';
import type { MediaGenerationIntent, MediaGenerationParameters, MediaGenerationResult, MediaKind } from '../types/media';
import { parseShotlistRowMentionId } from '../types/shotlist';
import { isWsagentSharedImagesNode, type WsagentProjectMediaTarget } from '../types/wsagentShared';
import { generateId, getNextDisplayId } from './store.utils';
import { BATCH_NODE_LIMIT } from './store.chat';
import { cancelNodePolling } from '../services/pollManager';
import { applyProjectDefaultsToNodeData, getImageNodeDimensionsForAspectRatio, resolveImageGenerationParameters } from '../services/projectSettingsService';
import { getCanvasPointerPosition } from '../services/canvasPointerService';
import { videoNodeDimensionsForAspectRatio } from '../utils/nodeBounds';
import { clearGroupLayoutData, detachGroupLayoutNodes } from '../utils/groupCollapseLayout';
import { getCanvasNodeById } from '../utils/canvasRenderProjection';
import { copyNodeMedia, needsNodeMediaCopy, discardCopiedNodeMedia } from '../services/nodeMediaCopy';
import { registerCanvasDerivation, isCanvasDerivationFresh, completeCanvasDerivation } from '../services/canvasDerivationGuard';
import { AI_APP_COPY_MESSAGE, assertAiAppNodeInsertion, isAiAppNode } from '../services/aiApps/aiAppCreation';
import { pickImageOutputParameters } from '../services/ai/imageOutputParameters';
import {
  type GroupNodeDataAccess,
  withGenerationTiming,
  prepareNodeForInsertion,
  createGroupSettlementGeometry,
  changedNodeInteractions,
  insertNodeInGroup,
  rememberMediaParameterUpdate,
  insertPreparedNode,
  appendPreparedNodes,
  prepareDuplicateNodeData,
  mergeShotlistReferenceSource,
  isSameShotVideoBinding,
  mergeNodeDataWithShotDurations,
  mergeCanvasNotePatch,
  pruneDeletedNodesAndEmptyGroups,
  deleteCanvasElements,
} from './nodes/nodeLifecycle';

export {
  collectKeepPaths,
  createNodeFileDeletionContext,
  filterHiddenCanvasElements,
  createNodeDuplicateDrag,
} from './nodes/nodeLifecycle';

/** 只投影本次真实传入的媒体参数，保留 false、接口默认背景与自动时长。 */
function mediaParametersToNodeData(kind: MediaKind, parameters?: MediaGenerationParameters): Partial<BaseNodeData> {
  if (!parameters) return {};
  if (kind === 'image') return {
    ...(parameters.aspectRatio !== undefined ? { aspectRatio: parameters.aspectRatio } : {}),
    ...(parameters.resolution !== undefined ? { imageSize: parameters.resolution } : {}),
    ...(parameters.imageQuality !== undefined ? { imageQuality: parameters.imageQuality } : {}),
    ...(parameters.imageBackground !== undefined ? { imageBackground: parameters.imageBackground } : {}),
    ...pickImageOutputParameters(parameters),
  };
  if (kind === 'video') return {
    ...(parameters.aspectRatio !== undefined ? { seedanceRatio: parameters.aspectRatio } : {}),
    ...(parameters.resolution !== undefined ? (/^\d+$/.test(parameters.resolution)
      ? { videoResolution: Number(parameters.resolution) } : { seedanceResolution: parameters.resolution }) : {}),
    ...(parameters.duration !== undefined ? { seedanceDuration: parameters.duration } : {}),
    ...(parameters.videoFps !== undefined ? { videoFps: parameters.videoFps } : {}),
    ...(parameters.generateAudio !== undefined ? { generateAudio: parameters.generateAudio } : {}),
  };
  return {};
}

/** 通用视频未显式选择参数时按模型默认生成，项目默认不能伪装成此次请求。 */
function retainMediaModelDefaults(data: BaseNodeData, provider: string | undefined, parameters?: MediaGenerationParameters): void {
  if (data.type !== 'ai-video' || !provider || !['general', 'runninghub', 'workflow-api'].includes(provider)) return;
  if (parameters?.aspectRatio === undefined) delete data.seedanceRatio;
  if (parameters?.resolution === undefined) delete data.seedanceResolution;
  if (parameters?.duration === undefined) delete data.seedanceDuration;
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

/** 互联的媒体出口用于取回原件；同名自定义插件端口继续沿用普通连线。 */
export function getWsagentMediaOutputKind(nodes: Node<BaseNodeData>[], nodeId: string, handle: string | null) {
  const kind = handle?.startsWith('plugin-out-') ? handle.slice('plugin-out-'.length) : undefined;
  if ((kind === 'image' || kind === 'video' || kind === 'audio')
    && isWsagentSharedImagesNode(getCanvasNodeById(nodes, nodeId)?.data)) return kind;
  return undefined;
}

function acceptsWsagentMedia(state: AppState, target: WsagentProjectMediaTarget, kind: MediaKind) {
  const node = getCanvasNodeById(state.nodes, target.nodeId);
  if (!node) return false;
  if (node.data.type !== 'plugin-node') return target.targetHandle === 'left' && isBatchConnectableNode(node);
  const handle = target.targetHandle;
  if (!handle?.startsWith('plugin-in-')) return false;
  const plugin = state.installedPlugins.find((item) => item.enabled && item.id === node.data.pluginId);
  const contribution = plugin?.manifest.contributes.nodes?.find((item) => item.id === node.data.pluginNodeId);
  const port = contribution?.inputs.find((item) => item.id === handle.slice('plugin-in-'.length));
  return port?.type === kind || port?.type === 'resource';
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

/** 镜头胶囊仍依赖所属真实节点，不把虚拟 ID 持久化成连线端点。 */
function mentionSourceNodeId(id: string): string {
  return parseShotlistRowMentionId(id)?.nodeId ?? id;
}

function getConnectionMentionPrompt(data: BaseNodeData): string {
  return data.prompt ?? (data.type === 'ai-director' ? data.directorPrevisPrompt : undefined) ?? '';
}

/** 与新连线一起写入真实提示词，编辑器、持久化与撤销共用同一个状态。 */
function appendConnectionMentions(
  nodes: Node<BaseNodeData>[],
  edges: readonly Edge[],
  enabled: boolean | undefined,
  activeNodeId: string | null,
): { nodes: Node<BaseNodeData>[]; edges: Edge[] } {
  const materializedEdges = edges.map((edge) => ({ ...edge, source: mentionSourceNodeId(edge.source) }));
  if (enabled === false || materializedEdges.length === 0) return { nodes, edges: materializedEdges };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sourcesByTarget = new Map<string, Node<BaseNodeData>[]>();
  for (const edge of materializedEdges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || source.id === target.id || target.type === 'group') continue;
    const isPrevisTarget = target.data.type === 'ai-director' && target.data.directorRuntimeKind === 'ai-threejs';
    if (!isPrevisTarget && !AUTO_MENTION_TARGET_TYPES.has(target.data.type)) continue;
    // 上传、导入和生成结果仍可打开同一生成对话框，编辑时不按来源角色跳过引用。
    // AI 镜头预演始终有生成输入，即使导演节点保留 source 角色且尚未打开编辑器。
    if (!isPrevisTarget && target.data.role === 'source' && target.id !== activeNodeId) continue;
    const sources = source.type === 'group'
      ? nodes.filter((node) => node.parentId === source.id)
      : [source];
    const eligible = sources.filter((node) => node.id !== target.id && BATCH_CONNECTABLE_TYPES.has(node.data.type));
    sourcesByTarget.set(target.id, [...(sourcesByTarget.get(target.id) ?? []), ...eligible]);
  }
  const nextNodes = nodes.map((node) => {
    const sources = sourcesByTarget.get(node.id);
    if (!sources?.length) return node;
    let prompt = getConnectionMentionPrompt(node.data);
    const mentioned = new Set([...prompt.matchAll(/@\{([^:]+):[^}]*\}/g)].map((match) => mentionSourceNodeId(match[1])));
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
    edges: materializedEdges,
  };
}

/** 删除最后一条上游连接时，同步移除该素材及其宫格/镜头引用。 */
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
    const previousPrompt = getConnectionMentionPrompt(node.data);
    if (!previousPrompt) return node;
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
    const prompt = previousPrompt.replace(/@\{([^:]+):[^}]*\}/g, (token, id: string) => (
      disconnected.has(mentionSourceNodeId(id).replace(/\/cell\/\d+$/, '')) ? '' : token
    ));
    if (prompt === previousPrompt) return node;
    const patch = { prompt: prompt.trim() ? prompt : '' };
    return { ...node, data: mergeShotlistReferenceSource(node.data, { ...node.data, ...patch }, patch, nodes) };
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
  const draggedFromInput = connection.sourceHandle === 'left' && connection.targetHandle === 'right';
  const directed = draggedFromInput ? {
    source: connection.target,
    target: connection.source,
    sourceHandle: connection.targetHandle,
    targetHandle: connection.sourceHandle,
  } : connection;
  const materialized = { ...directed, source: mentionSourceNodeId(directed.source) };
  return isCanvasConnectionValid(materialized) ? materialized : null;
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
  deleteNodesBatch: (nodeIds: string[], expectedRevision?: number) => boolean | Promise<boolean>;
  /** 手工删除完整选区（不限节点数，包含独立选边）；有目标时立即清选择。 */
  deleteSelectedCanvasElements: () => boolean;
  onConnect: (connection: Connection) => void;
  takeWsagentMediaFromPort: (sourceNodeId: string, kind: MediaKind, target?: WsagentProjectMediaTarget,
    position?: { x: number; y: number }) => Promise<void>;
  connectSelectedNodes: (sourceIds: string[], targetId: string, projectId: string | null) => number;
  addNodeFromSelection: (node: Node<BaseNodeData>, sourceIds: string[], projectId: string | null) => boolean;
  onNodesChange: (changes: NodeChange<Node<BaseNodeData>>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  clearGroupedSelection: () => void;
  /** 按本次实际拖动节点批量结算归属，共用一次历史快照；兼容单节点拖拽复制。 */
  settleNodeGroupingOnDragStop: (nodes: Node<BaseNodeData> | Node<BaseNodeData>[]) => void;
  /** 缩放结束后批量同步入组／脱组并提交结束快照；调用方须在手势开始时提交历史。 */
  settleGroupMembersOnResizeEnd: (groupId: string) => void;
  /** 把一个图像节点拖入宫格分镜的某格：该格显示此图，源节点被消耗移除 */
  fillStoryboardCell: (storyboardId: string, cellIdx: number, sourceNodeId: string) => void;
  /** 把一个图像/视频节点拖入分镜表的画面格：建立引用，源节点留在画布上 */
  bindShotlistFrame: (shotlistId: string, rowId: string, sourceNodeId: string) => void;
  /** 独立绑定实际就绪的视频节点，保留参考画面和计划时长。 */
  bindShotlistVideo: (shotlistId: string, rowId: string, sourceNodeId: string) => boolean;
}

/** 拖拽会话只驻留内存；React Flow 仍发送源 ID，将其位移转给副本。 */
export const createNodeSlice: StateCreator<AppState, [], [], NodeSlice> = (set, get, api) => ({
  nodes: [],
  edges: [],
  selectedNodeIds: [],

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  setSelectedNodeIds: (ids) => set((state) => state.selectedNodeIds.length === ids.length
    && state.selectedNodeIds.every((id, index) => id === ids[index]) ? state : { selectedNodeIds: ids }),

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
      ...(intent.kind === 'audio' ? {
        ...(intent.audioPurpose !== undefined ? { audioPurpose: intent.audioPurpose } : {}),
        ...(intent.audioVoice !== undefined ? { audioVoice: intent.audioVoice } : {}),
        ...(intent.audioFormat !== undefined ? { audioFormat: intent.audioFormat } : {}),
        ...(intent.audioSpeed !== undefined ? { audioSpeed: intent.audioSpeed } : {}),
        ...(intent.musicTitle !== undefined ? { musicTitle: intent.musicTitle } : {}),
        ...(intent.musicLyrics !== undefined ? { musicLyrics: intent.musicLyrics } : {}),
      } : {}),
      status: 'loading',
      nodeWidth: 280,
      nodeHeight: intent.kind === 'image' ? 158 : 160,
    }, settings);
    const mediaProvider = intent.modelRef && !intent.modelRef.includes('/')
      && state.config.generalModels?.some((model) => model.id === intent.modelRef)
      ? 'general' : intent.modelRef?.split('/')[0];
    retainMediaModelDefaults(nodeData, mediaProvider, intent);
    Object.assign(nodeData, mediaParametersToNodeData(intent.kind, intent));
    if (intent.kind === 'image') {
      const parameters = resolveImageGenerationParameters(settings, intent);
      Object.assign(nodeData, mediaParametersToNodeData('image', parameters),
        getImageNodeDimensionsForAspectRatio(parameters.aspectRatio) ?? {});
    }
    state.commitToHistory();
    set((current) => ({
      nodes: [...current.nodes, {
        id,
        type,
        position,
        data: {
          ...withGenerationTiming(nodeData),
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
        const recoveredParameters = mediaParametersToNodeData(artifact.kind, artifact.parameters);
        const missingParameters = Object.fromEntries(Object.entries(recoveredParameters)
          .filter(([key]) => node.data[key as keyof BaseNodeData] === undefined));
        const legacyPlaceholderSize = node.data.nodeWidth === undefined && node.data.nodeHeight === undefined
          || node.data.nodeWidth === 280 && node.data.nodeHeight === 158;
        const recoveredDimensions = artifact.kind === 'image' && typeof missingParameters.aspectRatio === 'string' && legacyPlaceholderSize
          ? getImageNodeDimensionsForAspectRatio(missingParameters.aspectRatio) : null;
        const mediaField = artifact.kind === 'image'
          ? { imageUrl: artifact.url, imageWidth: artifact.width, imageHeight: artifact.height }
          : artifact.kind === 'video'
            ? { videoUrl: artifact.url }
            : { audioUrl: artifact.url };
        return {
          ...node,
          data: {
            ...node.data,
            ...missingParameters,
            ...recoveredDimensions,
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
    if (artifact.parameters !== undefined) retainMediaModelDefaults(nodeData, artifact.provider, artifact.parameters);
    Object.assign(nodeData, mediaParametersToNodeData(artifact.kind, artifact.parameters));
    if (artifact.parameters?.aspectRatio) {
      const dimensions = artifact.kind === 'image' ? getImageNodeDimensionsForAspectRatio(artifact.parameters.aspectRatio)
        : artifact.kind === 'video' ? videoNodeDimensionsForAspectRatio(artifact.parameters.aspectRatio) : null;
      if (dimensions) Object.assign(nodeData, dimensions);
    }
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
    rememberMediaParameterUpdate(get(), nodeId, data);
  },

  updateNodeDataTransient: (nodeId, data) => {
    const state = get();
    const nodes = mergeNodeDataWithShotDurations(state.nodes, new Set([nodeId]), data);
    // 轮询进度不落历史；只有成功结果真正回填分镜结构时保留可撤销快照。
    if (nodes.some((node, index) => node.id !== nodeId && node.data.type === 'ai-shotlist'
      && node.data.shotlistRows !== state.nodes[index]?.data.shotlistRows)) state.commitToHistory();
    set({ nodes });
    rememberMediaParameterUpdate(get(), nodeId, data);
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
            data: clearGroupLayoutData(data), selected: false, dragging: false });
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
        ...clearGroupLayoutData(structuredClone(source.data)),
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

  deleteNode: (nodeId) => { deleteCanvasElements(set, get, api, [nodeId]); },

  deleteNodesBatch: (nodeIds, revision) => deleteCanvasElements(set, get, api, nodeIds.slice(0, BATCH_NODE_LIMIT), [], false, revision),

  deleteSelectedCanvasElements: () => {
    const state = get();
    return deleteCanvasElements(set, get, api, state.selectedNodeIds, state.edges.filter((edge) => edge.selected), true) !== false;
  },

  bindShotlistVideo: (shotlistId, rowId, sourceNodeId) => {
    const state = get();
    const sheet = state.nodes.find((node) => node.id === shotlistId && node.data.type === 'ai-shotlist');
    const source = state.nodes.find((node) => node.id === sourceNodeId);
    if (!sheet || !source || !['ai-video', 'source-video'].includes(source.data.type)
      || typeof source.data.videoUrl !== 'string' || !source.data.videoUrl.trim()) return false;
    const rows = sheet.data.shotlistRows ?? [];
    const row = rows.find((item) => item.id === rowId);
    if (!row) return false;
    const video: ShotVideoBinding = {
      nodeId: source.id, kind: 'video', url: source.data.videoUrl,
      filePath: source.data.filePath, assetId: source.data.assetId,
      sourceDuration: typeof source.data.videoDuration === 'number' && Number.isFinite(source.data.videoDuration)
        && source.data.videoDuration > 0 ? source.data.videoDuration : undefined,
    };
    if (isSameShotVideoBinding(row.video, video)) return true;
    state.updateNodeData(shotlistId, { shotlistRows: rows.map((row) => row.id === rowId ? { ...row, video } : row) });
    return true;
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
    const { nodes } = get();
    const forwardKind = getWsagentMediaOutputKind(nodes, connection.source, connection.sourceHandle);
    if (forwardKind) {
      void get().takeWsagentMediaFromPort(connection.source, forwardKind,
        { nodeId: connection.target, targetHandle: connection.targetHandle });
      return;
    }
    const reverseKind = getWsagentMediaOutputKind(nodes, connection.target, connection.targetHandle);
    if (reverseKind) {
      void get().takeWsagentMediaFromPort(connection.target, reverseKind,
        { nodeId: connection.source, targetHandle: connection.sourceHandle });
      return;
    }
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

  takeWsagentMediaFromPort: async (sourceNodeId, kind, target, position) => {
    const initial = get();
    const source = getCanvasNodeById(initial.nodes, sourceNodeId);
    if (!source || !isWsagentSharedImagesNode(source.data)) return;
    if (target && (target.nodeId === sourceNodeId || !acceptsWsagentMedia(initial, target, kind))) {
      initial.showToast('请连接支持该素材类型的输入端口', 'info');
      return;
    }
    const selected = source.data.wsagentMediaSelection?.[kind];
    if (!selected?.assetId) {
      initial.showToast('请先在 WSAGENT 互联节点选择这个端口的素材', 'info');
      return;
    }
    try {
      const [{ activeWsagentOwner }, { insertWsagentProjectMedia }] = await Promise.all([
        import('../services/wsagentSharedImages'), import('../services/wsagentProjectMedia'),
      ]);
      const current = get();
      const ownerId = activeWsagentOwner(initial);
      if (!ownerId || current.currentProjectId !== initial.currentProjectId
        || current.nodes !== initial.nodes || current.edges !== initial.edges) return;
      await insertWsagentProjectMedia(ownerId, { id: selected.assetId, kind, name: selected.name },
        sourceNodeId, new AbortController().signal, target, position);
    } catch (error) {
      if (get().currentProjectId === initial.currentProjectId) {
        get().showToast(error instanceof Error ? error.message : 'WSAGENT 素材获取失败', 'error');
      }
    }
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
      set((state) => {
        const changed = changedNodeInteractions(changes, state.nodes);
        return changed.length === 0 ? state : { nodes: applyNodeChanges(changed, state.nodes) as Node<BaseNodeData>[] };
      });
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
        nodes: detachGroupLayoutNodes(finalNodes, new Set([
          ...removedIds,
          ...state.nodes.filter((node) => node.parentId && groupNodeIdSet.has(node.parentId)).map((node) => node.id),
        ])),
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
      let changed = changes;
      if (changes.every((change) => change.type === 'select' && Object.keys(change).every((key) => ['id', 'type', 'selected'].includes(key)))) {
        const selected = new Map(s.edges.map((edge) => [edge.id, edge.selected]));
        changed = changes.filter((change) => {
          if (change.type !== 'select' || !selected.has(change.id)) return true;
          if (Object.is(selected.get(change.id), change.selected)) return false;
          selected.set(change.id, change.selected);
          return true;
        });
        if (changed.length === 0) return s;
      }
      const edges = applyEdgeChanges(changed, s.edges) as Edge[];
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

  settleGroupMembersOnResizeEnd: (groupId) => {
    const state = get();
    const group = state.nodes.find((node) => node.id === groupId && node.type === 'group');
    if (!group || group.hidden || group.draggable === false || group.data.groupCollapsed || group.data.hiddenByCharacterLibrary
      || !state.groups.some((record) => record.id === group.data.groupId)) return;

    const geometry = createGroupSettlementGeometry(state.nodes);
    const position = geometry.position(group);
    const capturedIds = new Set(state.nodes.filter((node) => (
      node.type !== 'group' && !node.parentId && !node.hidden && node.draggable !== false
      && !node.data.hiddenByCharacterLibrary
      && geometry.contains(group, geometry.center(node))
    )).map((node) => node.id));
    // 脱组前按完整父链换算画布坐标，解除绑定时不移动节点；空分组继续保留。
    const releasedPositions = new Map(state.nodes.filter((node) => (
      node.parentId === group.id
      && !geometry.contains(group, geometry.center(node))
    )).map((node) => [node.id, geometry.position(node)] as const));

    if (capturedIds.size > 0 || releasedPositions.size > 0) {
      const nodes = detachGroupLayoutNodes(state.nodes.map((node) => {
        const releasedPosition = releasedPositions.get(node.id);
        if (releasedPosition) return {
          ...node,
          parentId: undefined,
          position: releasedPosition,
          extent: node.extent === 'parent' ? undefined : node.extent,
          expandParent: undefined,
        };
        return capturedIds.has(node.id) ? {
          ...node,
          parentId: group.id,
          position: { x: node.position.x - position.x, y: node.position.y - position.y },
        } : node;
      }), new Set([...capturedIds, ...releasedPositions.keys()]));
      set({
        // 与拖入分组一致，保证父分组排在新加入的子节点前面。
        nodes: [...nodes.filter((node) => node.type === 'group'), ...nodes.filter((node) => node.type !== 'group')],
        groups: state.groups.map((record) => record.id === group.data.groupId
          ? { ...record, nodeIds: [...new Set([
            ...record.nodeIds.filter((id) => !releasedPositions.has(id)), ...capturedIds,
          ])] } : record),
      });
    }
    get().commitToHistory();
  },

  settleNodeGroupingOnDragStop: (nodes) => {
    const state = get();
    const allNodes = state.nodes;
    const nodeMap = new Map(allNodes.map((node) => [node.id, node]));
    const groupNodes = allNodes.filter((candidate) => candidate.type === 'group' && !candidate.hidden);
    const groupsById = new Map<string, Node<BaseNodeData>>();
    for (const group of groupNodes) if (!groupsById.has(group.id)) groupsById.set(group.id, group);
    const geometry = createGroupSettlementGeometry(allNodes);
    const updates = new Map<string, Node<BaseNodeData>>();
    const addedByGroup = new Map<string, Set<string>>();
    const oldParentIds = new Set<string>();
    for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
      const stored = nodeMap.get(node.id);
      if (!stored || stored.type === 'group' || stored.hidden || stored.draggable === false) continue;
      const oldParent = node.parentId === undefined ? undefined : groupsById.get(node.parentId);
      // 分镜等非普通分组的父子关系由对应业务入口管理。
      if (node.parentId && !oldParent) continue;
      const center = geometry.center(node);
      const parent = oldParent && geometry.contains(oldParent, center)
        ? oldParent
        : groupNodes.find((candidate) => geometry.contains(candidate, center));
      if (parent?.id === node.parentId) continue;

      const absPos = geometry.position(node);
      const parentPos = parent ? geometry.position(parent) : { x: 0, y: 0 };
      updates.set(node.id, {
        ...stored,
        parentId: parent?.id,
        position: { x: absPos.x - parentPos.x, y: absPos.y - parentPos.y },
      });
      if (oldParent) oldParentIds.add(oldParent.id);
      const groupId = parent?.data.groupId;
      if (typeof groupId === 'string' && groupId) {
        const added = addedByGroup.get(groupId) ?? new Set<string>();
        added.add(node.id);
        addedByGroup.set(groupId, added);
      }
    }
    if (updates.size === 0) return;

    let newNodes = detachGroupLayoutNodes(allNodes.map((node) => updates.get(node.id) ?? node), new Set(updates.keys()));
    let newGroups = state.groups.map((group) => {
      const added = addedByGroup.get(group.id);
      const nodeIds = group.nodeIds.filter((id) => !updates.has(id));
      if (!added && nodeIds.length === group.nodeIds.length) return group;
      return { ...group, nodeIds: [...new Set([...nodeIds, ...(added ?? [])])] };
    });

    // 整批归属确定后再清理旧组，避免换组途中删除仍将接收其他成员的分组。
    const childCounts = new Map<string, number>();
    for (const node of newNodes) if (node.parentId !== undefined) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
    const emptyGroupIds = new Set(
      groupNodes
        .filter((gn) => oldParentIds.has(gn.id) && !childCounts.has(gn.id))
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
