import { type Node, type Edge, type NodeChange } from '@xyflow/react';
import type { StateCreator, StoreApi } from 'zustand';
import type { AppState } from '../useAppStore';
import type {
  BaseNodeData,
  CanvasNoteData,
  CanvasNotePatch,
  NodeGroup,
  ProjectSettings,
  ShotRow,
  ShotVideoBinding,
} from '../../types';
import { parseShotlistRowMentionId, resolveShotVideoDuration } from '../../types/shotlist';
import { getNextDisplayId } from '../store.utils';
import * as fileService from '../../services/fileService';
import { playNodeExit, trackNodeExitPreparation } from '../../utils/nodeAnimations';
import { cancelNodePolling } from '../../services/pollManager';
import { applyProjectDefaultsToNodeData, getImageNodeDimensionsForAspectRatio } from '../../services/projectSettingsService';
import { getNodeBounds, getNodeSize, getParentOffset, videoNodeDimensionsForAspectRatio } from '../../utils/nodeBounds';
import { clearGroupLayoutData } from '../../utils/groupCollapseLayout';
import { getCanvasNodeById } from '../../utils/canvasRenderProjection';
import { resolveDirectorRuntime } from '../../services/directorRuntimeRegistry';
import { pendingNodeMediaImports } from '../../services/canvasDerivationGuard';
import { AI_APP_CREATION_MESSAGE } from '../../services/aiApps/aiAppCreation';
import { getGenerationNodeType } from '../../utils/nodeGeneration';
import { collectCanvasDescendantIds } from '../../utils/canvasHierarchy';
import { normalizeShotlistPromptReferences, resolveSingleShotlistRowReference } from '../../services/shotlistPromptService';
import { pickWorkflowSizeInputs, readNodeModelPreference, saveWorkflowModelPreference } from '../../services/modelPreferenceService';
import { isProjectExpectedContextCurrent } from '../../services/projectExecutionContext';
import { parseChatImageReferences } from '../../utils/chatImageReference';

export interface GroupNodeDataAccess {
  groupId: string;
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
export function withGenerationTiming(data: BaseNodeData, previous?: BaseNodeData): BaseNodeData {
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

export function prepareNodeForInsertion(
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

/** 只缓存本次结算的几何；父链仍沿用共享工具的循环/缺失父级终止规则。 */
export function createGroupSettlementGeometry(nodes: Node<BaseNodeData>[]) {
  const parents = new Map<string, Node<BaseNodeData>>();
  // 与原数组 find 一致，即使旧数据意外包含重复 ID 也先命中第一项。
  for (const node of nodes) if (!parents.has(node.id)) parents.set(node.id, node);
  const cache = new WeakMap<Node<BaseNodeData>, ReturnType<typeof getNodeBounds>>();
  const bounds = (node: Node<BaseNodeData>) => {
    let value = cache.get(node);
    if (!value) { value = getNodeBounds(node, parents); cache.set(node, value); }
    return value;
  };
  return {
    position: (node: Node<BaseNodeData>) => { const value = bounds(node); return { x: value.x, y: value.y }; },
    center: (node: Node<BaseNodeData>) => { const value = bounds(node); return { x: value.centerX, y: value.centerY }; },
    contains: (node: Node<BaseNodeData>, point: { x: number; y: number }) => {
      const value = bounds(node);
      return point.x >= value.left && point.x <= value.right && point.y >= value.top && point.y <= value.bottom;
    },
  };
}

/** 仅纯 position/select 批次省略同值项；其他变化完整交回 React Flow。 */
export function changedNodeInteractions(changes: NodeChange<Node<BaseNodeData>>[], nodes: Node<BaseNodeData>[]) {
  if (!changes.every((change) => (change.type === 'position' || change.type === 'select')
    && Object.keys(change).every((key) => (change.type === 'position' ? ['id', 'type', 'position', 'dragging'] : ['id', 'type', 'selected']).includes(key))
    && (change.type !== 'position' || change.position === undefined || change.position !== null && Object.keys(change.position).every((key) => key === 'x' || key === 'y')))) return changes;
  const projected = new Map<string, Pick<Node<BaseNodeData>, 'position' | 'dragging' | 'selected'>>();
  const filtered = changes.filter((change) => {
    if (change.type !== 'position' && change.type !== 'select') return true;
    const node = projected.get(change.id) ?? getCanvasNodeById(nodes, change.id);
    if (!node) return true;
    if (change.type === 'select') {
      if (Object.is(node.selected, change.selected)) return false;
      projected.set(change.id, { position: node.position, dragging: node.dragging, selected: change.selected });
    } else {
      if ((change.position === undefined || Object.is(node.position.x, change.position.x) && Object.is(node.position.y, change.position.y))
        && (change.dragging === undefined || Object.is(node.dragging, change.dragging))) return false;
      projected.set(change.id, { position: change.position ?? node.position,
        dragging: change.dragging === undefined ? node.dragging : change.dragging, selected: node.selected });
    }
    return true;
  });
  return filtered.length === changes.length ? changes : filtered;
}

/** 新建节点按画布位置加入展开分组，与插入本身共用一次历史快照。 */
export function insertNodeInGroup(state: Pick<AppState, 'nodes' | 'groups'>, node: Node<BaseNodeData>) {
  const center = nodeCenter(node, state.nodes);
  const parent = node.parentId || node.type === 'group' ? undefined : state.nodes.find((candidate) => (
    candidate.type === 'group' && !candidate.hidden && !candidate.data.groupCollapsed
    && groupContainsPoint(candidate, center, state.nodes)
  ));
  if (!parent) return { nodes: [...state.nodes, node], groups: state.groups };
  const position = absoluteNodePosition(parent, state.nodes);
  return {
    nodes: [...state.nodes, {
      ...node, parentId: parent.id, data: clearGroupLayoutData(node.data),
      position: { x: node.position.x - position.x, y: node.position.y - position.y },
    }],
    groups: state.groups.map((group) => group.id === parent.data.groupId
      ? { ...group, nodeIds: [...new Set([...group.nodeIds, node.id])] } : group),
  };
}

const MEDIA_PARAMETER_PREF_KEY = 'canvas-media-parameter-prefs';
const MEDIA_PARAMETER_TYPES = {
  'ai-image': { imageSize: 'string', imageQuality: 'string', imageBackground: 'string', aspectRatio: 'string',
    imageOutputFormat: 'string', imageFrameCount: 'number', imageFrameDurationMs: 'number', imageTransparent: 'boolean' },
  'ai-video': {
    videoResolution: 'number', videoFps: 'number', videoFrames: 'number',
    seedanceResolution: 'string', seedanceRatio: 'string', seedanceDuration: 'number',
    generateAudio: 'boolean',
  },
} as const;
const MEDIA_PARAMETER_UPDATE_KEYS = new Set([
  'model', 'provider', 'workflowId', 'workflowInputs',
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

export function rememberMediaParameterUpdate(state: AppState, nodeId: string, patch: Partial<BaseNodeData>): void {
  // 仅当前参数编辑入口更新偏好；后台生成和其他节点回写不改变新建默认值。
  if (state.activeNodeId !== nodeId || 'status' in patch
    || !Object.keys(patch).some((key) => MEDIA_PARAMETER_UPDATE_KEYS.has(key))) return;
  const data = state.nodes.find((node) => node.id === nodeId)?.data;
  if (!data || (data.type !== 'ai-image' && data.type !== 'ai-video')) return;
  try {
    const preferences = readMediaParameterPreferences();
    const workflow = data.workflowId ? state.workflows.find((item) => item.id === data.workflowId) : undefined;
    if (workflow) saveWorkflowModelPreference(data.type, workflow);
    if (!data.model || !data.provider || (data.workflowId && !workflow)) delete preferences[data.type];
    else preferences[data.type] = {
      model: data.model, provider: data.provider, parameters: pickMediaParameters(data.type, data),
      ...(workflow ? { workflowId: workflow.id, workflowInputs: pickWorkflowSizeInputs(workflow, data.workflowInputs ?? {}) } : {}),
    };
    globalThis.localStorage?.setItem(MEDIA_PARAMETER_PREF_KEY, JSON.stringify(preferences));
  } catch {
    // 本地偏好不可用时继续编辑，已有节点参数仍按项目正常保存。
  }
}

function applyRememberedMediaParameters(data: BaseNodeData, settings: ProjectSettings | undefined, state: AppState): BaseNodeData {
  if ((data.type !== 'ai-image' && data.type !== 'ai-video') || data.role === 'source'
    || data.displayId !== undefined || data.prompt?.trim()
    || (data.status && data.status !== 'idle') || hasMaterializedNodeOutput(data, data.type)) return data;
  // 保留图片／视频空节点原有的参数偏好回填，其他类型只由明确的 UI 新建入口绑定模型。
  if (data.model === undefined && !data.workflowId) {
    const preferred = readNodeModelPreference(data.type, state.workflows);
    if (preferred) data = { ...data, ...preferred };
  }
  const preference = readMediaParameterPreferences()[data.type];
  if (!preference || typeof preference !== 'object' || Array.isArray(preference)) return data;
  const entry = preference as Record<string, unknown>;
  if (!data.model || entry.model !== data.model || entry.provider !== data.provider
    || entry.workflowId !== data.workflowId
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
  const workflow = data.workflowId ? state.workflows.find((item) => item.id === data.workflowId) : undefined;
  if (workflow) {
    const values = entry.workflowInputs;
    const remembered = values && typeof values === 'object' && !Array.isArray(values)
      ? pickWorkflowSizeInputs(workflow, values as Record<string, unknown>, {
        ratio: !!(data.type === 'ai-image' ? generation?.imageAspectRatio : generation?.videoAspectRatio),
        resolution: !!(data.type === 'ai-image' ? generation?.imageSize : generation?.videoResolution),
      }) : {};
    next.workflowInputs = { ...remembered, ...data.workflowInputs };
    next.batchCount = 1;
  }
  if (data.type === 'ai-image' && parameters.aspectRatio) {
    const dimensions = getImageNodeDimensionsForAspectRatio(parameters.aspectRatio);
    if (dimensions) Object.assign(next, dimensions);
  }
  return next;
}

export function insertPreparedNode(state: AppState, node: Node<BaseNodeData>) {
  const displayId = getNextDisplayId(state.nodes);
  const settings = state.projects.find((project) => project.id === state.currentProjectId)?.settings;
  const data = applyRememberedMediaParameters(applyProjectDefaultsToNodeData(node.data, settings), settings, state);
  return insertNodeInGroup(state, prepareNodeForInsertion(node, data, displayId));
}

export function appendPreparedNodes(state: AppState, nodes: Node<BaseNodeData>[]): Node<BaseNodeData>[] {
  const nextNodes = [...state.nodes];
  const settings = state.projects.find((project) => project.id === state.currentProjectId)?.settings;
  let displayId = getNextDisplayId(state.nodes);
  for (const node of nodes) {
    const data = applyProjectDefaultsToNodeData(node.data, settings);
    nextNodes.push(prepareNodeForInsertion(node, data, displayId++));
  }
  return nextNodes;
}

export function prepareDuplicateNodeData(
  data: BaseNodeData,
  nodeType: string | undefined,
  cloneId: string,
  includeContent: boolean,
): BaseNodeData {
  const duplicate = clearGroupLayoutData(structuredClone(data));

  if (!includeContent) {
    // 拖拽复用生成配置，不带走上一份结果、文件身份或运行记录。
    for (const key of [
      'output', 'imageUrl', 'videoUrl', 'audioUrl', 'sourceUrl', 'thumbnailUrl',
      'fileName', 'filePath', 'assetId', 'relativePath', 'artifactId', 'mediaVersion',
      'imageWidth', 'imageHeight', 'videoWidth', 'videoHeight', 'videoDuration', 'videoBatchFingerprint',
      'mattingMask', 'annotation', 'annotationLayer', 'outpaintInput', 'batchGroupId',
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

/** 文件暂存晚于画布事件；回收前复核原项目、删除对象和新出现的共享引用。 */
export function createNodeFileDeletionContext(
  get: () => Pick<AppState, 'currentProjectId' | 'nodes' | 'messages' | 'chatImageDrafts'>,
  nodes: Node<BaseNodeData>[], idsToDelete: ReadonlySet<string>, projectId: string | null,
  isCurrent?: () => boolean,
): fileService.NodeFileDeletionContext {
  const deleted = new Map(nodes.filter((node) => idsToDelete.has(node.id)).map((node) => [node.id, node.data]));
  return {
    deletedNodeIds: [...idsToDelete],
    getLiveKeepPaths: (chatImagePath) => {
      const latest = get();
      if (isCurrent?.() === false || latest.currentProjectId !== projectId
        || latest.nodes.some((node) => deleted.has(node.id) && deleted.get(node.id) !== node.data)) return null;
      const paths = collectKeepPaths(latest.nodes, idsToDelete, latest.messages);
      if (chatImagePath) {
        for (const { content } of latest.messages) {
          if (!content?.includes('@image{')) continue;
          for (const { fileName } of parseChatImageReferences(content)) paths.add(chatImagePath(fileName));
        }
        for (const images of Object.values(latest.chatImageDrafts)) {
          for (const { fileName } of images) paths.add(chatImagePath(fileName));
        }
      }
      return paths;
    },
  };
}

function mergeNodeData(previous: BaseNodeData, patch: Partial<BaseNodeData>): BaseNodeData {
  if ('type' in patch && patch.type !== previous.type
    && (patch.type === 'ai-app' || previous.type === 'ai-app')) {
    throw new Error(AI_APP_CREATION_MESSAGE);
  }
  const next = withGenerationTiming({ ...previous, ...patch } as BaseNodeData, previous);
  // 显式改比例才联动画框；媒体加载、同值水化及用户手动缩放保持原尺寸。
  if (next.type === 'ai-image' && patch.aspectRatio !== undefined && patch.aspectRatio !== previous.aspectRatio
    && patch.nodeWidth === undefined && patch.nodeHeight === undefined) {
    Object.assign(next, getImageNodeDimensionsForAspectRatio(patch.aspectRatio) ?? {});
  }
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
export function mergeShotlistReferenceSource(
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

export function isSameShotVideoBinding(previous: ShotRow['video'], next: ShotVideoBinding): boolean {
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

function indexShotlistRows(rows: readonly ShotRow[]): Map<string, ShotRow> {
  const byId = new Map<string, ShotRow>();
  // 和原来的 find 一样取首项，旧数据里即使有重复 ID 也不换到另一行。
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  return byId;
}

/** 在同一次 Store 更新中同步镜头视频与时长，沿用调用方的历史快照。 */
export function mergeNodeDataWithShotDurations(nodes: Node<BaseNodeData>[], targetIds: Set<string>, patch: Partial<BaseNodeData>) {
  let next = nodes.map((node) => targetIds.has(node.id)
    ? { ...node, data: mergeShotlistReferenceSource(node.data, mergeNodeData(node.data, patch), patch, nodes) } : node);
  next = syncShotlistVideoResults(nodes, next, targetIds, patch);
  if (!Array.isArray(patch.shotlistRows)) return next;
  const rowsById = indexShotlistRows(patch.shotlistRows);
  const sheets = new Map(nodes.filter((node) => targetIds.has(node.id) && node.data.type === 'ai-shotlist')
    .map((node) => [node.id, indexShotlistRows(node.data.shotlistRows ?? [])]));
  return next.map((node) => {
    const source = node.data.shotlistProductionSource;
    if (getGenerationNodeType(node.data.type) !== 'ai-video' || source?.kind !== 'video' || source.durationSync === 'manual'
      || targetIds.has(node.id)) return node;
    const previousRows = sheets.get(source.nodeId);
    if (!previousRows) return node;
    const previous = previousRows.get(source.rowId);
    const row = rowsById.get(source.rowId);
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

export function mergeCanvasNotePatch(note: CanvasNoteData, patch: CanvasNotePatch): CanvasNoteData {
  return {
    ...note,
    ...patch,
    style: patch.style ? { ...note.style, ...patch.style } : note.style,
  };
}

export function pruneDeletedNodesAndEmptyGroups(
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

/** 三种删除入口共用文件保护与退场生命周期；运行时登记只存在于本次调用。 */
export function deleteCanvasElements(
  set: Parameters<StateCreator<AppState>>[0], get: () => AppState, api: StoreApi<AppState>,
  nodeIds: string[], selectedEdges: Edge[] = [], clearSelection = false, expectedRevision?: number,
): boolean | Promise<boolean> {
  const initial = get();
  const existingIds = new Set(initial.nodes.map((node) => node.id));
  const roots = nodeIds.filter((id) => existingIds.has(id));
  if (roots.length === 0 && selectedEdges.length === 0) return false;
  const idsToDelete = collectCanvasDescendantIds(initial.nodes, roots);
  const imports = pendingNodeMediaImports(initial.currentProjectId, idsToDelete);
  const edgesToDelete = new Map(selectedEdges.map((edge) => [edge.id, edge]));
  if (clearSelection) set({ selectedNodeIds: [], edges: initial.edges.map((edge) => edge.selected ? { ...edge, selected: false } : edge) });
  if (!imports) get().commitToHistory();

  const origin = initial;
  const projectId = origin.currentProjectId;
  const project = origin.projects.find((item) => item.id === projectId);
  const owner = origin.projects.find((item) => item.id === (project?.parentId ?? projectId));
  const sameTarget = (state: AppState): boolean => {
    if (state.currentProjectId !== projectId) return false;
    const context = origin.projectExecutionContext;
    if (context == null ? state.projectExecutionContext !== context
      : !state.projectExecutionContext || !isProjectExpectedContextCurrent(context, state.projectExecutionContext, { checkCanvasRevision: false })) return false;
    const current = state.projects.find((item) => item.id === projectId);
    const currentOwner = state.projects.find((item) => item.id === (current?.parentId ?? projectId));
    return current?.parentId === project?.parentId && current?.revisionScope === project?.revisionScope
      && (current?.exchangeEpoch ?? 0) === (project?.exchangeEpoch ?? 0)
      && (currentOwner?.exchangeEpoch ?? 0) === (owner?.exchangeEpoch ?? 0);
  };
  let invalidated = false;
  let applied = false;
  let cancelWait: (() => void) | undefined;
  let committingImportCheckpoint = false;
  const retiredNodeIds = new Set<string>();
  const retiredEdgeIds = new Set<string>();
  // 只观察本操作的存续；普通历史追加、节点进度和位置变化不会取消合法删除。
  let unsubscribe = () => {};
  unsubscribe = api.subscribe((state, previous) => {
    if (invalidated) return;
    const targetChanged = state.currentProjectId !== previous.currentProjectId
      || state.projectExecutionContext !== previous.projectExecutionContext || state.projects !== previous.projects;
    const historyChanged = state.history !== previous.history;
    if (targetChanged && !sameTarget(state) || !committingImportCheckpoint && (state.historyIndex !== previous.historyIndex
      && (!historyChanged || state.historyIndex < previous.historyIndex)
      || historyChanged && !state.history.some((entry) => previous.history.includes(entry)))) {
      invalidated = true;
      cancelWait?.();
      unsubscribe();
      return;
    }
    if (!applied && idsToDelete.size > 0 && state.nodes !== previous.nodes) {
      const present = new Set(state.nodes.map((node) => node.id));
      for (const id of idsToDelete) if (!present.has(id)) retiredNodeIds.add(id);
      if (retiredNodeIds.size) cancelWait?.();
    }
    if (!applied && edgesToDelete.size > 0 && state.edges !== previous.edges) {
      const present = new Set(state.edges.map((edge) => edge.id));
      for (const id of edgesToDelete.keys()) if (!present.has(id)) retiredEdgeIds.add(id);
    }
  });
  const isCurrent = () => !invalidated && sameTarget(get());
  const deletedGroupIds = new Set(idsToDelete);
  for (const node of initial.nodes) {
    if (idsToDelete.has(node.id) && node.type === 'group') {
      const groupId = (node.data as unknown as GroupNodeDataAccess).groupId;
      if (groupId) deletedGroupIds.add(groupId);
    }
  }
  const applyDeletion = () => set((state) => {
    if (!isCurrent()) return state;
    const liveIds = new Set([...idsToDelete].filter((id) => !retiredNodeIds.has(id)));
    const pruned = pruneDeletedNodesAndEmptyGroups(state.nodes, state.edges, state.groups, liveIds);
    applied = true;
    return { ...pruned,
      edges: pruned.edges.filter((edge) => {
        const original = edgesToDelete.get(edge.id);
        return !original || retiredEdgeIds.has(edge.id) || edge.source !== original.source || edge.target !== original.target
          || edge.sourceHandle !== original.sourceHandle || edge.targetHandle !== original.targetHandle;
      }),
      selectedNodeIds: state.selectedNodeIds.filter((id) => pruned.nodes.some((node) => node.id === id)),
    };
  });
  const startDeletion = (snapshot: AppState) => {
    try {
      for (const id of idsToDelete) cancelNodePolling(id);
      const files = fileService.deleteNodeFiles(
        snapshot.nodes.filter((node) => idsToDelete.has(node.id) && !node.data.artifactId).map((node) => node.data),
        collectKeepPaths(snapshot.nodes, idsToDelete, snapshot.messages), projectId,
        fileService.deletedGroupFolderNames(snapshot.groups, deletedGroupIds),
        createNodeFileDeletionContext(get, snapshot.nodes, idsToDelete, projectId, isCurrent),
      ).catch((error) => console.warn('[删除节点] 文件清理失败:', error));
      const exit = playNodeExit([...idsToDelete]).then(applyDeletion, applyDeletion);
      void Promise.allSettled([files, exit]).then(unsubscribe);
      return exit;
    } catch (error) {
      invalidated = true;
      unsubscribe();
      throw error;
    }
  };
  if (imports) {
    const cancelled = new Promise<void>((resolve) => { cancelWait = resolve; });
    const preparation = Promise.race([imports, cancelled]).then(async () => {
      cancelWait = undefined;
      const snapshot = get();
      const members = collectCanvasDescendantIds(snapshot.nodes, roots);
      if (!isCurrent() || retiredNodeIds.size || members.size !== idsToDelete.size
        || expectedRevision !== undefined && snapshot.getCurrentRevision() !== expectedRevision
        || [...idsToDelete].some((id) => !members.has(id))) { unsubscribe(); return false; }
      // 回填后的文件身份必须同时进入删除历史和暂存，撤销才能恢复可用节点。
      committingImportCheckpoint = true;
      try { snapshot.commitToHistory({ refreshImportedMedia: true }); } finally { committingImportCheckpoint = false; }
      await startDeletion(snapshot);
      return applied && isCurrent();
    }).catch(() => { unsubscribe(); console.warn('[删除节点] 导入后未完成删除'); return false; });
    trackNodeExitPreparation(preparation);
    return preparation;
  }
  startDeletion(initial);
  return true;
}
