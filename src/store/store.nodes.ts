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
  ProjectSettings,
  ShotRow,
  ShotVideoBinding,
  StoryboardCellOverride,
} from '../types';
import { createCanvasNoteData, STORYBOARD_CELL_SOURCE_TYPES } from '../types';
import type { MediaGenerationIntent, MediaGenerationParameters, MediaGenerationResult, MediaKind } from '../types/media';
import { parseShotlistRowMentionId, resolveShotVideoDuration } from '../types/shotlist';
import { generateId, getNextDisplayId } from './store.utils';
import { BATCH_NODE_LIMIT } from './store.chat';
import * as fileService from '../services/fileService';
import { playNodeExit } from '../utils/nodeAnimations';
import { cancelNodePolling } from '../services/pollManager';
import { applyProjectDefaultsToNodeData, getImageNodeDimensionsForAspectRatio } from '../services/projectSettingsService';
import { getCanvasPointerPosition } from '../services/canvasPointerService';
import { getNodeSize, getParentOffset, videoNodeDimensionsForAspectRatio } from '../utils/nodeBounds';
import { resolveDirectorRuntime } from '../services/directorRuntimeRegistry';
import { copyNodeMedia, needsNodeMediaCopy, discardCopiedNodeMedia } from '../services/nodeMediaCopy';
import { registerCanvasDerivation, isCanvasDerivationFresh, completeCanvasDerivation } from '../services/canvasDerivationGuard';
import { AI_APP_COPY_MESSAGE, AI_APP_CREATION_MESSAGE, assertAiAppNodeInsertion, isAiAppNode } from '../services/aiApps/aiAppCreation';
import { getGenerationNodeType } from '../utils/nodeGeneration';
import { collectCanvasDescendantIds } from '../utils/canvasHierarchy';
import { normalizeShotlistPromptReferences, resolveSingleShotlistRowReference } from '../services/shotlistPromptService';
import { readNodeModelPreference } from '../services/modelPreferenceService';

/** 只投影本次真实传入的媒体参数，保留 false、接口默认背景与自动时长。 */
function mediaParametersToNodeData(kind: MediaKind, parameters?: MediaGenerationParameters): Partial<BaseNodeData> {
  if (!parameters) return {};
  if (kind === 'image') return {
    ...(parameters.aspectRatio !== undefined ? { aspectRatio: parameters.aspectRatio } : {}),
    ...(parameters.resolution !== undefined ? { imageSize: parameters.resolution } : {}),
    ...(parameters.imageQuality !== undefined ? { imageQuality: parameters.imageQuality } : {}),
    ...(parameters.imageBackground !== undefined ? { imageBackground: parameters.imageBackground } : {}),
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

/** 镜头胶囊仍依赖所属真实节点，不把虚拟 ID 持久化成连线端点。 */
function mentionSourceNodeId(id: string): string {
  return parseShotlistRowMentionId(id)?.nodeId ?? id;
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
    const prompt = node.data.prompt.replace(/@\{([^:]+):[^}]*\}/g, (token, id: string) => (
      disconnected.has(mentionSourceNodeId(id).replace(/\/cell\/\d+$/, '')) ? '' : token
    ));
    if (prompt === node.data.prompt) return node;
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

/** 仅联动待生成的视频框；已有成片及导入素材继续使用真实媒体尺寸。 */
function alignEmptyVideoNodeDimensions(data: BaseNodeData): BaseNodeData {
  if (data.type !== 'ai-video' || data.role === 'source' || data.videoUrl || data.output) return data;
  const dimensions = videoNodeDimensionsForAspectRatio(data.seedanceRatio, data.nodeWidth);
  return dimensions ? { ...data, aspectRatio: data.seedanceRatio, ...dimensions } : data;
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

/** 等待计时属于生成状态，不能随节点移出视口后的组件重挂而重置。 */
function withGenerationTiming(data: BaseNodeData, previous?: BaseNodeData): BaseNodeData {
  const type = getGenerationNodeType(data.type);
  if (type !== 'ai-image' && type !== 'ai-video') return data;
  if (data.status !== 'loading' && !(type === 'ai-video' && data.videoTaskState === 'paused')) {
    return data.generationStartedAt === undefined ? data : { ...data, generationStartedAt: undefined };
  }
  const continuing = previous?.status === 'loading' || (type === 'ai-video' && previous?.videoTaskState === 'paused');
  const previousStartedAt = continuing ? previous?.generationStartedAt : undefined;
  const startedAt = typeof previousStartedAt === 'number' && Number.isFinite(previousStartedAt) && previousStartedAt > 0
    ? previousStartedAt : data.generationStartedAt;
  return {
    ...data,
    generationStartedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0
      ? startedAt : Date.now(),
  };
}

function prepareNodeForInsertion(
  node: Node<BaseNodeData>,
  data: BaseNodeData,
  displayId: number,
): Node<BaseNodeData> {
  const prepared = withGenerationTiming(prepareDirectorNodeDataForInsertion(alignEmptyVideoNodeDimensions(data), node.type, node.id));
  return { ...node, data: { ...prepared, displayId } } as Node<BaseNodeData>;
}

function absoluteNodePosition(node: Node<BaseNodeData>, nodes: Node<BaseNodeData>[]) {
  const offset = getParentOffset(node, nodes);
  return { x: node.position.x + offset.x, y: node.position.y + offset.y };
}

function groupContainsPoint(group: Node<BaseNodeData>, point: { x: number; y: number }, nodes: Node<BaseNodeData>[]) {
  const position = absoluteNodePosition(group, nodes);
  const size = getNodeSize(group);
  return point.x >= position.x && point.x <= position.x + size.width
    && point.y >= position.y && point.y <= position.y + size.height;
}

function nodeCenter(node: Node<BaseNodeData>, nodes: Node<BaseNodeData>[]) {
  const position = absoluteNodePosition(node, nodes);
  const size = getNodeSize(node);
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

const MEDIA_PARAMETER_PREF_KEY = 'canvas-media-parameter-prefs';
const MEDIA_PARAMETER_TYPES = {
  'ai-image': { imageSize: 'string', imageQuality: 'string', imageBackground: 'string', aspectRatio: 'string' },
  'ai-video': {
    videoResolution: 'number', videoFps: 'number', videoFrames: 'number',
    seedanceResolution: 'string', seedanceRatio: 'string', seedanceDuration: 'number',
    generateAudio: 'boolean',
  },
} as const;
const MEDIA_PARAMETER_UPDATE_KEYS = new Set([
  'model', 'provider', 'workflowId',
  ...Object.keys(MEDIA_PARAMETER_TYPES['ai-image']), ...Object.keys(MEDIA_PARAMETER_TYPES['ai-video']),
]);
type MediaParameters = Pick<BaseNodeData,
  keyof (typeof MEDIA_PARAMETER_TYPES)['ai-image'] | keyof (typeof MEDIA_PARAMETER_TYPES)['ai-video']>;

function mediaParameterTypes(type: BaseNodeData['type']): Record<string, string> {
  return type === 'ai-image' || type === 'ai-video' ? MEDIA_PARAMETER_TYPES[type] : {};
}

function readMediaParameterPreferences(): Record<string, unknown> {
  try {
    const raw = globalThis.localStorage?.getItem(MEDIA_PARAMETER_PREF_KEY);
    const value: unknown = raw ? JSON.parse(raw) : undefined;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** 只保存参数原始值，保留 false/自动时长，不带素材、提示词或凭据。 */
function pickMediaParameters(type: BaseNodeData['type'], value: Record<string, unknown>): MediaParameters {
  return Object.fromEntries(Object.entries(mediaParameterTypes(type)).flatMap(([key, valueType]) => {
    const parameter = value[key];
    if (typeof parameter !== valueType
      || (typeof parameter === 'number' && !Number.isFinite(parameter))
      || (typeof parameter === 'string' && parameter.length > 64)) return [];
    return [[key, parameter]];
  }));
}

function rememberMediaParameterUpdate(state: AppState, nodeId: string, patch: Partial<BaseNodeData>): void {
  // 仅当前参数编辑入口更新偏好；后台生成和其他节点回写不改变新建默认值。
  if (state.activeNodeId !== nodeId || 'status' in patch
    || !Object.keys(patch).some((key) => MEDIA_PARAMETER_UPDATE_KEYS.has(key))) return;
  const data = state.nodes.find((node) => node.id === nodeId)?.data;
  if (!data || (data.type !== 'ai-image' && data.type !== 'ai-video')) return;
  if (!['model', 'provider', 'workflowId', ...Object.keys(mediaParameterTypes(data.type))]
    .some((key) => key in patch)) return;
  try {
    const preferences = readMediaParameterPreferences();
    if (!data.model || !data.provider || data.workflowId) delete preferences[data.type];
    else preferences[data.type] = {
      model: data.model, provider: data.provider, parameters: pickMediaParameters(data.type, data),
    };
    globalThis.localStorage?.setItem(MEDIA_PARAMETER_PREF_KEY, JSON.stringify(preferences));
  } catch {
    // 本地偏好不可用时继续编辑，已有节点参数仍按项目正常保存。
  }
}

function applyRememberedMediaParameters(data: BaseNodeData, settings: ProjectSettings | undefined): BaseNodeData {
  if ((data.type !== 'ai-image' && data.type !== 'ai-video') || data.role === 'source'
    || data.displayId !== undefined || data.prompt?.trim() || data.workflowId
    || (data.status && data.status !== 'idle') || hasMaterializedNodeOutput(data, data.type)) return data;
  // 保留图片／视频空节点原有的参数偏好回填，其他类型只由明确的 UI 新建入口绑定模型。
  if (data.model === undefined) {
    const preferred = readNodeModelPreference(data.type);
    if (preferred) data = { ...data, ...preferred };
  }
  const preference = readMediaParameterPreferences()[data.type];
  if (!preference || typeof preference !== 'object' || Array.isArray(preference)) return data;
  const entry = preference as Record<string, unknown>;
  if (!data.model || entry.model !== data.model || entry.provider !== data.provider
    || !entry.parameters || typeof entry.parameters !== 'object' || Array.isArray(entry.parameters)) return data;
  const parameters = pickMediaParameters(data.type, entry.parameters as Record<string, unknown>);
  // 项目明确设置的参数优先于全局最近使用偏好。
  const generation = settings?.generation;
  if (data.type === 'ai-image') {
    if (generation?.imageSize) delete parameters.imageSize;
    if (generation?.imageAspectRatio) delete parameters.aspectRatio;
  } else {
    if (generation?.videoResolution) delete parameters.seedanceResolution;
    if (generation?.videoAspectRatio) delete parameters.seedanceRatio;
    if (generation?.videoDuration) delete parameters.seedanceDuration;
  }
  const next = { ...data, ...parameters };
  if (data.type === 'ai-image' && parameters.aspectRatio) {
    const dimensions = getImageNodeDimensionsForAspectRatio(parameters.aspectRatio);
    if (dimensions) Object.assign(next, dimensions);
  }
  return next;
}

function insertPreparedNode(state: AppState, node: Node<BaseNodeData>) {
  const displayId = getNextDisplayId(state.nodes);
  const settings = state.projects.find((project) => project.id === state.currentProjectId)?.settings;
  const data = applyRememberedMediaParameters(applyProjectDefaultsToNodeData(node.data, settings), settings);
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
  const next = withGenerationTiming({ ...previous, ...patch } as BaseNodeData, previous);
  if (getGenerationNodeType(previous.type) === 'ai-video' && previous.shotlistProductionSource?.kind === 'video'
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
  return 'seedanceRatio' in patch ? alignEmptyVideoNodeDimensions(next) : next;
}

/** 单镜胶囊建立稳定时长关联；不覆盖用户手动时长或旧格式来源。 */
function mergeShotlistReferenceSource(
  previous: BaseNodeData,
  next: BaseNodeData,
  patch: Partial<BaseNodeData>,
  nodes: Node<BaseNodeData>[],
): BaseNodeData {
  if (getGenerationNodeType(next.type) !== 'ai-video' || !('prompt' in patch)) return next;
  const prompt = normalizeShotlistPromptReferences(next.prompt ?? '');
  if (prompt !== next.prompt) next = { ...next, prompt };
  const oldSource = previous.shotlistProductionSource;
  let reference: ReturnType<typeof resolveSingleShotlistRowReference>;
  try {
    reference = resolveSingleShotlistRowReference(next.prompt ?? '', nodes);
  } catch {
    // 编辑过程中允许保留未完成或已失效的胶囊，实际生成时再由解析器明确报错。
    reference = undefined;
  }
  if (!reference) {
    const wasReferenced = oldSource?.kind === 'video' && [...(previous.prompt ?? '').matchAll(/@\{([^:}]+):[^}]*\}/g)]
      .some((match) => {
        const source = parseShotlistRowMentionId(match[1]);
        return source?.nodeId === oldSource.nodeId && source.rowId === oldSource.rowId;
      });
    return wasReferenced ? { ...next, shotlistProductionSource: undefined } : next;
  }
  const sameSource = oldSource?.kind === 'video' && oldSource.nodeId === reference.nodeId && oldSource.rowId === reference.rowId;
  const manual = 'seedanceDuration' in patch || (sameSource && oldSource.durationSync === 'manual');
  const duration = manual ? undefined : resolveShotVideoDuration(reference.row.duration);
  return {
    ...next,
    ...(duration === undefined ? {} : { seedanceDuration: duration }),
    shotlistProductionSource: {
      nodeId: reference.nodeId, rowId: reference.rowId, kind: 'video', durationSync: manual ? 'manual' : 'auto',
    },
  };
}

interface ShotVideoAttempt {
  nodeId: string;
  rowId: string;
  binding: ShotRow['video'];
  row: ShotRow;
}
// 仅跟随当前运行期节点数据对象；不把取消/回填快照写进项目或历史数据。
const shotVideoAttempts = new WeakMap<BaseNodeData, ShotVideoAttempt>();

function isSameShotVideoBinding(previous: ShotRow['video'], next: ShotVideoBinding): boolean {
  return !!previous && previous.nodeId === next.nodeId && previous.url === next.url
    && previous.filePath === next.filePath && previous.assetId === next.assetId
    && previous.sourceDuration === next.sourceDuration;
}

function syncShotlistVideoResults(
  previous: Node<BaseNodeData>[], next: Node<BaseNodeData>[], targetIds: Set<string>, patch: Partial<BaseNodeData>,
): Node<BaseNodeData>[] {
  let result = next;
  for (const node of next) {
    if (!targetIds.has(node.id) || getGenerationNodeType(node.data.type) !== 'ai-video') continue;
    const oldNode = previous.find((item) => item.id === node.id);
    const source = node.data.shotlistProductionSource;
    const attempt = oldNode ? shotVideoAttempts.get(oldNode.data) : undefined;
    // 行被删除或来源变化时也保留本轮身份，避免后续结果误绑到新行。
    if (attempt) shotVideoAttempts.set(node.data, attempt);
    if (source?.kind !== 'video') continue;
    const sheet = result.find((item) => item.id === source.nodeId && item.data.type === 'ai-shotlist');
    const row = sheet?.data.shotlistRows?.find((item) => item.id === source.rowId);
    if (!sheet || !row) continue;
    if (patch.status === 'loading') {
      if (oldNode?.data.status !== 'loading') {
        shotVideoAttempts.set(node.data, { nodeId: source.nodeId, rowId: source.rowId, binding: row.video, row });
      }
      continue;
    }
    if (patch.status !== 'success' || typeof patch.videoUrl !== 'string' || !patch.videoUrl.trim()) continue;
    if (attempt && (attempt.nodeId !== source.nodeId || attempt.rowId !== source.rowId)) continue;
    if (row.video && row.video.nodeId !== node.id) continue;
    // 明确解绑不能被在途结果恢复；后续新一轮生成会记录新的 null 起点。
    if (row.video === null && (!attempt || attempt.binding !== null || row !== attempt.row)) continue;
    if (attempt && row.video !== attempt.binding && row.video?.nodeId !== node.id) continue;
    const video: ShotVideoBinding = {
      nodeId: node.id, kind: 'video', url: node.data.videoUrl,
      filePath: node.data.filePath, assetId: node.data.assetId,
      sourceDuration: typeof node.data.videoDuration === 'number' && Number.isFinite(node.data.videoDuration)
        && node.data.videoDuration > 0 ? node.data.videoDuration : undefined,
    };
    if (isSameShotVideoBinding(row.video, video)) continue;
    result = result.map((item) => item.id === sheet.id ? { ...item, data: { ...item.data,
      shotlistRows: item.data.shotlistRows!.map((shot) => shot.id === row.id ? { ...shot, video } : shot),
    } } : item);
  }
  return result;
}

/** 在同一次 Store 更新中同步镜头视频与时长，沿用调用方的历史快照。 */
function mergeNodeDataWithShotDurations(nodes: Node<BaseNodeData>[], targetIds: Set<string>, patch: Partial<BaseNodeData>) {
  let next = nodes.map((node) => targetIds.has(node.id)
    ? { ...node, data: mergeShotlistReferenceSource(node.data, mergeNodeData(node.data, patch), patch, nodes) } : node);
  next = syncShotlistVideoResults(nodes, next, targetIds, patch);
  if (!Array.isArray(patch.shotlistRows)) return next;
  const sheets = new Map(nodes.filter((node) => targetIds.has(node.id) && node.data.type === 'ai-shotlist')
    .map((node) => [node.id, node.data.shotlistRows ?? []]));
  return next.map((node) => {
    const source = node.data.shotlistProductionSource;
    if (getGenerationNodeType(node.data.type) !== 'ai-video' || source?.kind !== 'video' || source.durationSync === 'manual'
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

// 几何变化不改变可见成员；只保存最近一份轻量成员快照。
let visibilityState: Array<{ id: string; parentId?: string; collapsed: boolean; hidden: boolean }> = [];
let visibleIndexes: number[] = [];
let visibleNodeIds = new Set<string>();
const visibleEdgesBySource = new WeakMap<Edge[], { ids: Set<string>; edges: Edge[] }>();

/** 渲染前剔除隐藏元素；节点仍使用最新位置与数据，成员相同则不重新扫描连线。 */
export function filterHiddenCanvasElements(
  nodes: Node<BaseNodeData>[],
  edges: Edge[],
): { nodes: Node<BaseNodeData>[]; edges: Edge[] } {
  const sameMembership = nodes.length === visibilityState.length && nodes.every((node, index) => {
    const previous = visibilityState[index];
    return node.id === previous.id && node.parentId === previous.parentId
      && (node.data.groupCollapsed === true) === previous.collapsed
      && (node.data.hiddenByCharacterLibrary === true) === previous.hidden;
  });
  if (!sameMembership) {
    visibilityState = nodes.map((node) => ({ id: node.id, parentId: node.parentId,
      collapsed: node.data.groupCollapsed === true, hidden: node.data.hiddenByCharacterLibrary === true }));
    const collapsed = new Set(visibilityState.filter((node) => node.collapsed).map((node) => node.id));
    visibleIndexes = [];
    const nextIds = new Set<string>();
    visibilityState.forEach((node, index) => {
      if (node.hidden || (node.parentId && collapsed.has(node.parentId))) return;
      visibleIndexes.push(index);
      nextIds.add(node.id);
    });
    if (nextIds.size !== visibleNodeIds.size || [...nextIds].some((id) => !visibleNodeIds.has(id))) visibleNodeIds = nextIds;
  }
  if (visibleIndexes.length === nodes.length) return { nodes, edges };
  const visibleNodes = visibleIndexes.map((index) => nodes[index]);
  const previous = visibleEdgesBySource.get(edges);
  if (previous?.ids === visibleNodeIds) return { nodes: visibleNodes, edges: previous.edges };
  const nextEdges = edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
  const visibleEdges = nextEdges.length === edges.length ? edges
    : previous?.edges.length === nextEdges.length
      && nextEdges.every((edge, index) => edge === previous.edges[index]) ? previous.edges : nextEdges;
  visibleEdgesBySource.set(edges, { ids: visibleNodeIds, edges: visibleEdges });
  return { nodes: visibleNodes, edges: visibleEdges };
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
    const { nodes } = get();
    const idsToDelete = collectCanvasDescendantIds(nodes, [nodeId]);
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
    const { nodes } = get();
    const idsToDelete = collectCanvasDescendantIds(nodes, limitedIds);
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

  settleGroupMembersOnResizeEnd: (groupId) => {
    const state = get();
    const group = state.nodes.find((node) => node.id === groupId && node.type === 'group');
    if (!group || group.hidden || group.draggable === false || group.data.groupCollapsed || group.data.hiddenByCharacterLibrary
      || !state.groups.some((record) => record.id === group.data.groupId)) return;

    const position = absoluteNodePosition(group, state.nodes);
    const capturedIds = new Set(state.nodes.filter((node) => (
      node.type !== 'group' && !node.parentId && !node.hidden && node.draggable !== false
      && !node.data.hiddenByCharacterLibrary
      && groupContainsPoint(group, nodeCenter(node, state.nodes), state.nodes)
    )).map((node) => node.id));
    // 脱组前按完整父链换算画布坐标，解除绑定时不移动节点；空分组继续保留。
    const releasedPositions = new Map(state.nodes.filter((node) => (
      node.parentId === group.id
      && !groupContainsPoint(group, nodeCenter(node, state.nodes), state.nodes)
    )).map((node) => [node.id, absoluteNodePosition(node, state.nodes)] as const));

    if (capturedIds.size > 0 || releasedPositions.size > 0) {
      const nodes = state.nodes.map((node) => {
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
      });
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
