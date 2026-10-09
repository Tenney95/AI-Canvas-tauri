import { invoke } from '@tauri-apps/api/core';
import { isLocalMediaUrl as isLocalMediaReference, isRemoteMediaUrl } from '../../utils/mediaUrl';
import { getLocale } from '../../i18n';
import { getNodeBounds } from '../../utils/nodeBounds';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData, NodeType } from '../../types';
import type {
  AvailablePluginNode,
  AvailableNodePluginTool,
  InstalledPlugin,
  NodePluginExecutionResult,
  NodePluginInvocationInput,
  PluginCustomNodePortManifest,
  PluginModelSummary,
  PluginNodeExecutionResult,
  PluginNodeHostEffect,
  PluginNodeHostEffectResult,
  PluginNodeInvocationInput,
  PluginNodeSetData,
  PluginNodeToolOutputManifest,
  PluginJsonValue,
  PluginNodePortType,
  PluginPermission,
  PluginPlacement,
  PluginInvocationResources,
  PluginImageRepresentation,
  PluginInvocationIdentity,
  PluginNativeMediaArtifactRef,
  PluginNodeSetVideoGeneration,
  PluginVideoGenerationParameters,
  PluginVideoReplicaStart,
  PythonPluginRuntimeStatus,
} from '../../types/plugin';
import { useAppStore } from '../../store/useAppStore';
import { computeImageNodeDimensions, derivedNodePlacement, generateId } from '../../store/store.utils';
import {
  completeCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
  type CanvasDerivationGuard,
} from '../canvasDerivationGuard';
import { generateText } from '../ai/generateText';
import { generateImage } from '../ai/generateImage';
import { generateVideo } from '../ai/generateVideo';
import { generateAudio } from '../ai/generateAudio';
import { moveToTrash, saveBinaryToProjectData } from '../fileService';
import { sha256BytesHex } from '../mediaDataUrl';
import { inspectVideoNode } from '../videoBatchPlanning';
import type { VideoPreflightItem } from '../../types/videoBatch';
import {
  clearPluginInvocationResources,
  mintPluginInvocationResources,
  readPluginResourceRange,
  readPluginResourceText,
  readPluginDerivedResourceForOutput,
  getPluginLineArtResource,
  setPluginLineArtResource,
  registerPluginDerivedResource,
  replacePluginDerivedResources,
  resolvePluginResourceHostUrl,
  resolvePluginMediaWorkspaceInputs,
  type PluginResourceReadContext,
} from './pluginResourceService';
import { buildPluginModelCatalog, collectDeclaredModelCategories } from './pluginModelCatalog';
import { createPluginLineArtImage } from './pluginImageService';
import { detectPluginVideoShots, extractPluginVideoFrames, inspectPluginVideoFrame } from './pluginVideoFrameService';
import { assertPluginCompatibility, PLUGIN_HOST } from './pluginHost';
import { queryPluginPromptMentions, rewritePluginPromptReferences, resolvePluginPromptReferencesForModel } from './pluginPromptReferenceService';

const MAX_STRING_LENGTH = 256_000;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 128;
const MAX_DEPTH = 8;
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_HOST_EFFECTS = PLUGIN_HOST.limits.tool.total;

function reserveToolEffect(counts: Record<string, number>, effect: PluginNodeHostEffect): void {
  const category = effect.type === 'model.generate' ? 'model'
    : effect.type === 'network.request' ? 'network'
      : effect.type.startsWith('settings.') ? 'settings'
        : effect.type === 'resource.readText' || effect.type === 'resource.readRange' ? 'resourceRead'
          : effect.type === 'resource.export' || effect.type === 'resource.createText' ? 'resourceWrite' : 'media';
  const limit = PLUGIN_HOST.limits.tool[category];
  if ((counts[category] ?? 0) >= limit) throw new Error(`插件 ${category} 操作不能超过 ${limit} 次`);
  counts[category] = (counts[category] ?? 0) + 1;
}
const NODE_SET_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_NODE_SET_EDGES = 64;
const MEDIA_ARTIFACT_KEY_RE = /^[A-Za-z0-9_-]{1,160}$/u;
const MAX_MEDIA_ARTIFACTS = 18;
const MAX_MEDIA_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_MEDIA_ARTIFACT_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_NODE_SET_VIDEO_GENERATIONS = 6;
const FORBIDDEN_INPUT_FIELDS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'filePath',
  'relativePath',
  'directorCaptureFilePaths',
]);
const MEDIA_PORT_TYPES = new Set<PluginNodePortType>(['image', 'video', 'audio']);
const MEDIA_NODE_TYPES = new Set<NodeType>([
  'ai-image',
  'source-image',
  'ai-video',
  'source-video',
  'ai-audio',
  'source-audio',
  'ai-animation',
  'ai-panorama',
  'ai-storyboard',
  'ai-director',
]);
const SAFE_INLINE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/ogg',
]);
const SAFE_CANVAS_NOTE_COLORS = new Set([
  'transparent',
  'var(--theme-text)',
  'var(--danger)',
  'var(--success)',
  'var(--node-video)',
  'var(--accent-amber)',
  'var(--theme-card)',
  'color-mix(in srgb, var(--danger) 32%, transparent)',
  'color-mix(in srgb, var(--success) 32%, transparent)',
  'color-mix(in srgb, var(--node-video) 32%, transparent)',
  'color-mix(in srgb, var(--accent-amber) 32%, transparent)',
]);
const FORBIDDEN_OUTPUT_FIELDS = new Set([
  ...DANGEROUS_OBJECT_KEYS,
  'type',
  'displayId',
  'filePath',
  'relativePath',
  'assetId',
  'artifactId',
  'role',
  'dramaAssetId',
  'dramaAssetKind',
  'characterLibraryLinks',
  'hiddenByCharacterLibrary',
  'directorInstanceId',
  'directorCaptureFilePaths',
  'pluginId',
  'pluginNodeId',
]);

function requirePluginSourceDigest(
  plugins: InstalledPlugin[],
  pluginId: string,
  expectedDigest: string | undefined,
): string {
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error('插件描述符缺少已登记的源码摘要，请重新选择插件后再执行');
  }
  const plugin = plugins.find((item) => item.id === pluginId);
  if (!plugin?.enabled) throw new Error('插件已被禁用或卸载');
  const digest = plugin.sourceDigest;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('插件缺少已登记的源码摘要，请重新安装或完成迁移后再执行');
  }
  if (digest !== expectedDigest) {
    throw new Error('插件版本已更新，请重新选择插件后再执行');
  }
  return digest;
}

function requirePluginRevisionDigest(
  plugins: InstalledPlugin[],
  pluginId: string,
  expectedDigest: string | undefined,
): string {
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error('插件描述符缺少完整 revision 摘要，请重新选择插件后再执行');
  }
  const plugin = plugins.find((item) => item.id === pluginId);
  const digest = plugin?.revisionDigest;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('插件缺少完整 revision 摘要，请重新安装后再执行');
  }
  if (digest !== expectedDigest) throw new Error('插件版本已更新，请重新选择插件后再执行');
  return digest;
}

function requireCurrentPluginRevision(pluginId: string, sourceDigest: string, revisionDigest: string) {
  const current = useAppStore.getState();
  requirePluginSourceDigest(current.installedPlugins, pluginId, sourceDigest);
  requirePluginRevisionDigest(current.installedPlugins, pluginId, revisionDigest);
  assertPluginCompatibility(current.installedPlugins.find((plugin) => plugin.id === pluginId)!.manifest);
  return current;
}

function createPluginInvocationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${generateId()}-${generateId()}`;
}

function watchPluginExecution(
  pluginId: string, sourceDigest: string, revisionDigest: string,
  guard: CanvasDerivationGuard, upstream?: AbortSignal,
) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  upstream?.addEventListener('abort', cancel, { once: true });
  const check = () => {
    if (controller.signal.aborted) return;
    try {
      const state = requireCurrentPluginRevision(pluginId, sourceDigest, revisionDigest);
      if (!isCanvasDerivationFresh(guard, state)) cancel();
    } catch { cancel(); }
  };
  const unsubscribe = useAppStore.subscribe(check);
  if (upstream?.aborted) cancel();
  check();
  return {
    signal: controller.signal,
    dispose: () => { unsubscribe(); upstream?.removeEventListener('abort', cancel); },
  };
}

async function invokePluginTool(
  identity: { pluginId: string; sourceDigest: string; revisionDigest: string; toolId: string; invocationId: string },
  input: PluginNodeInvocationInput | NodePluginInvocationInput,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new Error('插件操作已取消');
  const cancel = () => {
    void invoke('cancel_node_plugin_tool', { pluginId: identity.pluginId, invocationId: identity.invocationId })
      .catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = await invoke<unknown>('execute_node_plugin_tool', { ...identity, input });
    if (signal.aborted) throw new Error('插件操作已取消');
    return result;
  } catch (error) {
    // Rust command 的错误会以字符串返回，转成 Error 才能让界面显示原生诊断。
    throw typeof error === 'string' ? new Error(error) : error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function toPluginJson(
  value: unknown,
  depth = 0,
  redactLocalReferences = false,
): PluginJsonValue | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth > MAX_DEPTH) throw new Error(`插件数据嵌套深度不能超过 ${MAX_DEPTH} 层`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    if (redactLocalReferences && isLocalMediaReference(value)) return undefined;
    if (value.length > MAX_STRING_LENGTH) throw new Error(`插件数据字符串不能超过 ${MAX_STRING_LENGTH} 个字符`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw new Error(`插件数据数组不能超过 ${MAX_ARRAY_ITEMS} 项`);
    return value
      .map((item) => toPluginJson(item, depth + 1, redactLocalReferences))
      .filter((item): item is PluginJsonValue => item !== undefined);
  }
  if (typeof value === 'object') {
    const output: Record<string, PluginJsonValue> = {};
    const entries = Object.entries(value);
    if (entries.length > MAX_OBJECT_KEYS) throw new Error(`插件数据对象不能超过 ${MAX_OBJECT_KEYS} 个键`);
    for (const [key, item] of entries) {
      if (DANGEROUS_OBJECT_KEYS.has(key) || (redactLocalReferences && FORBIDDEN_INPUT_FIELDS.has(key))) continue;
      const normalized = toPluginJson(item, depth + 1, redactLocalReferences);
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  }
  return undefined;
}

export function getAvailableNodePluginTools(
  plugins: InstalledPlugin[],
  nodeType: NodeType | undefined,
  placement: PluginPlacement = 'node-context-menu',
): AvailableNodePluginTool[] {
  if (!nodeType) return [];
  return plugins.flatMap((plugin) => {
    if (!plugin.enabled) return [];
    return (plugin.manifest.contributes.nodeTools ?? [])
      .filter((tool) => tool.nodeTypes.includes(nodeType) && tool.placements.includes(placement))
      .map((tool) => ({
        pluginId: plugin.id,
        pluginName: plugin.manifest.name,
        sourceDigest: plugin.sourceDigest,
        revisionDigest: plugin.revisionDigest,
        runtime: plugin.manifest.runtime ?? 'javascript',
        source: plugin.source,
        tool,
        permissions: plugin.manifest.permissions,
      }));
  });
}

/** 节点工具的模型目录：只在声明 models.read 时给出，且始终不含凭据。 */
export function buildNodeToolModelCatalog(
  pluginTool: AvailableNodePluginTool,
): PluginModelSummary[] {
  if (!pluginTool.permissions.includes('models.read')) return [];
  return buildPluginModelCatalog(
    useAppStore.getState().config,
    collectDeclaredModelCategories(pluginTool.tool.dialog?.fields ?? []),
  );
}

export function getAvailablePluginNodes(plugins: InstalledPlugin[]): AvailablePluginNode[] {
  return plugins.flatMap((plugin) => {
    if (!plugin.enabled) return [];
    return (plugin.manifest.contributes.nodes ?? []).map((node) => ({
      pluginId: plugin.id,
      pluginName: plugin.manifest.name,
      sourceDigest: plugin.sourceDigest,
      revisionDigest: plugin.revisionDigest,
      runtime: plugin.manifest.runtime ?? 'javascript',
      source: plugin.source,
      node,
      permissions: plugin.manifest.permissions,
    }));
  });
}

export function createPluginNode(
  pluginNode: AvailablePluginNode,
  position: { x: number; y: number },
): Node<BaseNodeData> {
  const pluginValues = Object.fromEntries(
    pluginNode.node.fields.flatMap((field) => (
      field.defaultValue === undefined ? [] : [[field.id, field.defaultValue]]
    )),
  );
  return {
    id: `node-${generateId()}`,
    type: 'plugin-node',
    position,
    data: {
      label: pluginNode.node.title,
      type: 'plugin-node',
      status: 'idle',
      nodeWidth: 320,
      nodeHeight: Math.min(520, Math.max(180, 132 + (pluginNode.node.fields.length * 58))),
      pluginId: pluginNode.pluginId,
      pluginNodeId: pluginNode.node.id,
      pluginValues,
      pluginOutputs: {},
    },
  };
}

function buildInvocationInput(
  projectId: string,
  node: Node<BaseNodeData>,
  fields: string[],
  parameters: Record<string, PluginJsonValue>,
  options: {
    iteration: number;
    models: PluginModelSummary[];
    resources: PluginInvocationResources;
    effectResult?: PluginNodeHostEffectResult;
  },
): NodePluginInvocationInput {
  const data: Record<string, PluginJsonValue> = {};
  for (const field of fields) {
    if (FORBIDDEN_INPUT_FIELDS.has(field)) continue;
    const rawValue = node.data[field];
    const value = toPluginJson(rawValue, 0, true);
    if (value !== undefined) data[field] = value;
  }
  return {
    projectId,
    locale: getLocale(),
    iteration: options.iteration,
    parameters,
    node: {
      id: node.id,
      type: node.data.type,
      data,
    },
    models: options.models,
    resources: options.resources,
    effectResult: options.effectResult,
  };
}

function parseNodeSetVideoGeneration(value: unknown): PluginNodeSetVideoGeneration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('视频 generation 必须是对象');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'modelId' && key !== 'parameters')
    || typeof raw.modelId !== 'string' || !raw.modelId.trim() || raw.modelId.length > 240) {
    throw new Error('视频 generation 只能声明有效的 modelId 与 parameters');
  }
  if (raw.parameters === undefined) return { modelId: raw.modelId };
  if (!raw.parameters || typeof raw.parameters !== 'object' || Array.isArray(raw.parameters)) throw new Error('视频生成 parameters 必须是对象');
  const parameters: PluginVideoGenerationParameters = {};
  for (const [key, parameter] of Object.entries(raw.parameters)) {
    if (key === 'duration') {
      if (typeof parameter !== 'number' || !Number.isFinite(parameter) || parameter <= 0 || parameter > 60) throw new Error('视频 duration 必须大于 0 且不超过 60');
      parameters.duration = parameter;
    } else if (key === 'videoResolution' || key === 'videoFps' || key === 'videoFrames') {
      const minimum = key === 'videoResolution' ? 256 : 1;
      const maximum = key === 'videoFps' ? 120 : 4096;
      if (typeof parameter !== 'number' || !Number.isSafeInteger(parameter) || parameter < minimum || parameter > maximum) throw new Error(`视频 ${key} 必须是 ${minimum}-${maximum} 的整数`);
      parameters[key] = parameter;
    } else if (key === 'generateAudio') {
      if (typeof parameter !== 'boolean') throw new Error('视频 generateAudio 必须是布尔值');
      parameters.generateAudio = parameter;
    } else if (key === 'aspectRatio') {
      if (typeof parameter !== 'string' || !['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', 'adaptive'].includes(parameter)) throw new Error('视频 aspectRatio 不受支持');
      parameters.aspectRatio = parameter as PluginVideoGenerationParameters['aspectRatio'];
    } else if (key === 'resolution') {
      if (typeof parameter !== 'string' || !['480p', '720p', '1080p', '4k'].includes(parameter)) throw new Error('视频 resolution 不受支持');
      parameters.resolution = parameter as PluginVideoGenerationParameters['resolution'];
    } else throw new Error(`视频生成包含不受支持参数: ${key}`);
  }
  return { modelId: raw.modelId, parameters };
}

function validateNodeSetData(
  rawData: Record<string, unknown>,
  output: PluginNodeToolOutputManifest,
  trustedMediaReferences?: ReadonlySet<string>,
  allowMediaArtifacts = false,
  allowPromptReferences = false,
): PluginNodeSetData {
  const rawNodes = rawData.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0 || rawNodes.length > (output.maxNodes ?? 0)) {
    throw new Error(`节点集必须包含 1-${output.maxNodes ?? 0} 个节点`);
  }
  const allowedNodeTypes = new Set(output.nodeTypes ?? []);
  const allowedFields = new Set(output.fields);
  const keys = new Set<string>();
  let generationCount = 0;
  const nodes = rawNodes.map((rawNode) => {
    const node = recordValue(rawNode);
    const key = typeof node.key === 'string' ? node.key : '';
    const nodeType = typeof node.nodeType === 'string' ? node.nodeType as NodeType : undefined;
    if (!NODE_SET_KEY_RE.test(key) || keys.has(key)) throw new Error('节点集 key 无效或重复');
    if (!nodeType || !allowedNodeTypes.has(nodeType)) throw new Error('节点集包含未声明的节点类型');
    keys.add(key);

    const rawFields = recordValue(node.data);
    const data: Record<string, PluginJsonValue> = {};
    for (const [field, rawValue] of Object.entries(rawFields)) {
      if (!allowedFields.has(field)) throw new Error(`节点集返回了未声明字段: ${field}`);
      if (FORBIDDEN_OUTPUT_FIELDS.has(field)) throw new Error(`节点集不能修改受保护字段: ${field}`);
      const normalized = toPluginJson(rawValue);
      if (normalized === undefined) throw new Error(`节点集字段不可 JSON 序列化: ${field}`);
      data[field] = normalized;
    }
    if (node.resourceId !== undefined && (typeof node.resourceId !== 'string'
      || !node.resourceId || node.resourceId.length > 160)) throw new Error('节点集 resourceId 无效');
    const resourceId = node.resourceId as string | undefined;
    let artifactKey: string | undefined;
    if (node.artifactKey !== undefined) {
      if (!allowMediaArtifacts) throw new Error('视频产物只能来自获准的 Python 媒体工作区');
      if (typeof node.artifactKey !== 'string' || !MEDIA_ARTIFACT_KEY_RE.test(node.artifactKey)) {
        throw new Error('节点集 artifactKey 无效');
      }
      if (nodeType !== 'ai-video' && nodeType !== 'source-video') throw new Error('只有视频节点可以绑定 artifactKey');
      if (resourceId) throw new Error('节点集 resourceId 与 artifactKey 不能同时声明');
      artifactKey = node.artifactKey;
    }
    const imageNode = nodeType === 'ai-image' || nodeType === 'source-image';
    if (imageNode && !resourceId) throw new Error('节点集图像节点必须绑定派生 resourceId');
    if (!imageNode && resourceId) throw new Error('只有图像节点可以绑定派生 resourceId');
    if (node.representation !== undefined && (!imageNode
      || (node.representation !== 'original' && node.representation !== 'lineart'))) {
      throw new Error('只有图像节点可以指定 original 或 lineart 表示');
    }
    const representation = node.representation as PluginImageRepresentation | undefined;
    let generation: PluginNodeSetVideoGeneration | undefined;
    if (node.generation !== undefined) {
      if (!output.generateVideos || nodeType !== 'ai-video' || resourceId || artifactKey) {
        throw new Error('视频 generation 仅用于声明 generateVideos 的空 ai-video 节点');
      }
      if (++generationCount > MAX_NODE_SET_VIDEO_GENERATIONS) throw new Error('每批视频生成节点不能超过 6 个');
      generation = parseNodeSetVideoGeneration(node.generation);
      const protectedFields = ['model', 'provider', 'workflowId', 'workflowInputs', 'runninghubModelParameters', 'videoUrl', 'imageUrl', 'audioUrl', 'sourceUrl', 'output', 'videoReferences', 'manualReferences',
        'seedanceDuration', 'seedanceRatio', 'seedanceResolution', 'videoResolution', 'videoFps', 'videoFrames', 'generateAudio'];
      if (protectedFields.some((field) => field in data)) throw new Error('视频生成的模型身份与媒体引用必须由宿主解析');
      const uncheckedPrompt = typeof data.prompt === 'string' && allowPromptReferences
        ? data.prompt.replace(/@\{plugin-ref-[A-Za-z0-9-]+:[^}]*\}/gu, '') : data.prompt;
      if (typeof data.prompt !== 'string' || !data.prompt.trim()
        || typeof uncheckedPrompt !== 'string' || /@(?:asset|drama)?\{/u.test(uncheckedPrompt)) {
        throw new Error('视频生成必须有提示词，引用媒体只能通过本批连线或宿主引用选择器');
      }
    }
    if (trustedMediaReferences) {
      assertSafeCanvasNoteColors(data);
      assertTrustedNodeMediaReferences(data, trustedMediaReferences, nodeType);
    }
    return { key, nodeType, resourceId, ...(artifactKey ? { artifactKey } : {}), ...(generation ? { generation } : {}), ...(representation ? { representation } : {}), data };
  });

  const rawEdges = rawData.edges === undefined ? [] : rawData.edges;
  if (!Array.isArray(rawEdges) || rawEdges.length > MAX_NODE_SET_EDGES) {
    throw new Error(`节点集连线不能超过 ${MAX_NODE_SET_EDGES} 条`);
  }
  const seenEdges = new Set<string>();
  const edges = rawEdges.map((rawEdge) => {
    const edge = recordValue(rawEdge);
    const sourceKey = typeof edge.sourceKey === 'string' ? edge.sourceKey : '';
    const targetKey = typeof edge.targetKey === 'string' ? edge.targetKey : '';
    const signature = `${sourceKey}\0${targetKey}`;
    if (
      !keys.has(sourceKey)
      || !keys.has(targetKey)
      || sourceKey === targetKey
      || seenEdges.has(signature)
    ) {
      throw new Error('节点集连线引用无效、重复或形成自连线');
    }
    const target = nodes.find((node) => node.key === targetKey);
    const source = nodes.find((node) => node.key === sourceKey);
    if (target?.generation && source && !source.resourceId && !source.artifactKey) {
      throw new Error('视频生成只接受本批派生参考帧与控制视频连线');
    }
    seenEdges.add(signature);
    return { sourceKey, targetKey };
  });
  return { nodes, edges };
}

function validateResult(
  value: unknown,
  output: PluginNodeToolOutputManifest,
  trustedMediaReferences?: ReadonlySet<string>,
  outputNodeType?: NodeType,
  allowMediaArtifacts = false,
  allowPromptReferences = false,
): NodePluginExecutionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件必须返回对象');
  const record = value as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message.slice(0, 240) : undefined;
  if (record.artifacts !== undefined && (!allowMediaArtifacts || output.mode !== 'create-node-set')) {
    throw new Error('视频产物只能由获准的 Python 媒体工作区提交节点集');
  }
  // 请求宿主操作时不写入画布；宿主完成后会携带 effectResult 再次调用同一工具。
  if (record.effect !== undefined) {
    if (allowMediaArtifacts) throw new Error('Python 媒体工作区只接受最终节点集结果');
    if (record.artifacts !== undefined) throw new Error('请求宿主操作时不能提交视频产物');
    return { effect: parseHostEffect(record.effect, trustedMediaReferences), message };
  }
  if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) {
    throw new Error('插件返回值必须包含 data 对象');
  }
  if (output.mode === 'create-node-set') {
    const nodeSet = validateNodeSetData(record.data as Record<string, unknown>, output, trustedMediaReferences, allowMediaArtifacts, allowPromptReferences);
    const artifacts = record.artifacts === undefined ? undefined : validateMediaArtifactRefs(record.artifacts);
    const artifactKeys = new Set(nodeSet.nodes.flatMap((node) => node.artifactKey ? [node.artifactKey] : []));
    if (artifactKeys.size !== (artifacts?.length ?? 0)
      || artifacts?.some((artifact) => !artifactKeys.has(artifact.key))) {
      throw new Error('视频节点 artifactKey 与原生产物不匹配');
    }
    return {
      nodeSet,
      ...(artifacts ? { artifacts } : {}),
      message,
    };
  }
  const allowed = new Set(output.fields);
  const data: Record<string, PluginJsonValue> = {};
  for (const [field, rawValue] of Object.entries(record.data)) {
    if (!allowed.has(field)) throw new Error(`插件返回了未声明字段: ${field}`);
    if (FORBIDDEN_OUTPUT_FIELDS.has(field)) throw new Error(`插件不能修改受保护字段: ${field}`);
    const normalized = toPluginJson(rawValue);
    if (normalized === undefined) throw new Error(`插件字段不可 JSON 序列化: ${field}`);
    data[field] = normalized;
  }
  if (Object.keys(data).length === 0) throw new Error('插件没有返回任何节点字段');
  if (trustedMediaReferences) {
    assertSafeCanvasNoteColors(data);
    assertTrustedNodeMediaReferences(data, trustedMediaReferences, outputNodeType);
  }
  return { data, message };
}

function validateMediaArtifactRefs(value: unknown): PluginNativeMediaArtifactRef[] {
  if (!Array.isArray(value) || value.length > MAX_MEDIA_ARTIFACTS) throw new Error('视频产物必须为最多 18 项的数组');
  const keys = new Set<string>();
  const ids = new Set<string>();
  let totalBytes = 0;
  return value.map((item) => {
    const record = recordValue(item);
    if (Object.keys(record).some((field) => !['key', 'artifactId', 'displayName', 'mediaType', 'size', 'sha256'].includes(field))
      || typeof record.key !== 'string' || !MEDIA_ARTIFACT_KEY_RE.test(record.key) || keys.has(record.key)
      || typeof record.artifactId !== 'string' || !MEDIA_ARTIFACT_KEY_RE.test(record.artifactId) || ids.has(record.artifactId)
      || typeof record.displayName !== 'string' || !/^[^/\\:]{1,156}\.mp4$/u.test(record.displayName)
      || Array.from(record.displayName).some((character) => character.charCodeAt(0) < 32)
      || record.mediaType !== 'video/mp4' || typeof record.size !== 'number' || !Number.isSafeInteger(record.size)
      || record.size < 12 || record.size > MAX_MEDIA_ARTIFACT_BYTES
      || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.sha256)) {
      throw new Error('原生视频产物引用无效');
    }
    keys.add(record.key);
    ids.add(record.artifactId);
    totalBytes += record.size;
    if (totalBytes > MAX_MEDIA_ARTIFACT_TOTAL_BYTES) throw new Error('视频产物总大小超过 48 MiB');
    return { key: record.key, artifactId: record.artifactId, displayName: record.displayName,
      mediaType: 'video/mp4', size: record.size, sha256: record.sha256 };
  });
}

async function readNativeMediaArtifact(
  identity: PluginInvocationIdentity,
  artifact: PluginNativeMediaArtifactRef,
  assertFresh: () => void,
): Promise<Uint8Array> {
  assertFresh();
  const raw = await invoke<unknown>('read_plugin_media_artifact', { identity, artifactId: artifact.artifactId });
  assertFresh();
  if (!Array.isArray(raw) || raw.length !== artifact.size
    || raw.some((byte) => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('原生视频产物字节或大小无效');
  }
  const bytes = Uint8Array.from(raw as number[]);
  if (bytes[4] !== 102 || bytes[5] !== 116 || bytes[6] !== 121 || bytes[7] !== 112
    || await sha256BytesHex(bytes) !== artifact.sha256) throw new Error('原生视频产物文件头或摘要不匹配');
  assertFresh();
  return bytes;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function pluginHandlePortId(handle: string | null | undefined, prefix: 'plugin-in-' | 'plugin-out-'): string | undefined {
  if (!handle?.startsWith(prefix)) return undefined;
  const portId = handle.slice(prefix.length);
  return portId || undefined;
}

function mediaReferenceCandidates(value: string): string[] {
  const candidates = [value.trim()];
  const cssUrlPattern = /url\(\s*(['"]?)(.*?)\1\s*\)/giu;
  for (const match of value.matchAll(cssUrlPattern)) {
    const candidate = match[2]?.trim();
    if (candidate) candidates.push(candidate);
  }
  return [...new Set(candidates.filter(Boolean))];
}

function visitRenderedMarkdownImageReferences(markdown: string, visitor: (value: string) => void): void {
  const withoutCode = markdown
    .split('\x00').join('')
    .replace(/```\w*\n[\s\S]*?```/gu, '')
    .replace(/`[^`]+`/gu, '');
  const escaped = withoutCode
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
  const imagePattern = /!\[[^\]]*\]\(([^)\s]+(?:\s+"[^"]*")?)\)/gu;
  for (const match of escaped.matchAll(imagePattern)) {
    const reference = match[1]?.replace(/\s+"[^"]*"$/u, '').trim();
    if (reference) visitor(reference);
  }
}

function isRemoteNetworkReference(value: string): boolean {
  const slashNormalized = value.replace(/\\/gu, '/');
  if (slashNormalized.startsWith('//')) return true;
  return isRemoteMediaUrl(slashNormalized);
}

function isUnsafeInlineMediaReference(value: string): boolean {
  if (!value.toLowerCase().startsWith('data:')) return false;
  const separator = value.indexOf(',');
  if (separator < 0) return true;
  const mediaType = value.slice(5, separator).split(';', 1)[0]?.trim().toLowerCase();
  return !mediaType || !SAFE_INLINE_MEDIA_TYPES.has(mediaType);
}

function visitMediaStrings(value: unknown, visitor: (value: string) => void, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  if (typeof value === 'string') {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitMediaStrings(item, visitor, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const item of Object.values(value)) visitMediaStrings(item, visitor, depth + 1);
}

function visitNodeMediaStrings(
  data: Record<string, unknown>,
  visitor: (value: string) => void,
  nodeType?: NodeType,
): void {
  for (const [field, value] of Object.entries(data)) {
    if (
      /urls?$/iu.test(field)
      || (field === 'output' && nodeType !== undefined && MEDIA_NODE_TYPES.has(nodeType))
    ) {
      visitMediaStrings(value, visitor);
    }
    if (field === 'output' && nodeType === 'ai-markdown' && typeof value === 'string') {
      visitRenderedMarkdownImageReferences(value, visitor);
    }
  }
  visitMediaStrings(data.annotation, visitor);
  visitMediaStrings(data.mattingMask, visitor);
  for (const override of Array.isArray(data.storyboardOverrides) ? data.storyboardOverrides : []) {
    visitMediaStrings(recordValue(override).url, visitor);
  }
  for (const row of Array.isArray(data.shotlistRows) ? data.shotlistRows : []) {
    visitMediaStrings(recordValue(recordValue(row).frame).url, visitor);
  }
  for (const reference of Array.isArray(data.videoReferences) ? data.videoReferences : []) {
    visitMediaStrings(recordValue(reference).url, visitor);
  }
}

function isSafeCanvasNoteColor(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (SAFE_CANVAS_NOTE_COLORS.has(value)) return true;
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(value);
}

function assertSafeCanvasNoteColors(data: Record<string, PluginJsonValue>): void {
  const style = recordValue(recordValue(data.note).style);
  for (const field of ['strokeColor', 'backgroundColor']) {
    if (style[field] !== undefined && !isSafeCanvasNoteColor(style[field])) {
      throw new Error('JavaScript 插件返回了不允许的画布笔记颜色');
    }
  }
}

function addTrustedMediaString(references: Set<string>, value: string): void {
  for (const candidate of mediaReferenceCandidates(value)) {
    if (isRemoteNetworkReference(candidate) || isLocalMediaReference(candidate)) references.add(candidate);
  }
}

function assertTrustedMediaString(value: string, trustedReferences: ReadonlySet<string>): void {
  for (const candidate of mediaReferenceCandidates(value)) {
    if (isUnsafeInlineMediaReference(candidate)) {
      throw new Error('JavaScript 插件返回了不允许的内联媒体类型');
    }
    if (candidate.trim().toLowerCase().startsWith('data:')) continue;
    if (isLocalMediaReference(candidate) && !trustedReferences.has(candidate)) {
      throw new Error('JavaScript 插件返回了未经宿主授权的本地媒体引用');
    }
    if (isRemoteNetworkReference(candidate) && !trustedReferences.has(candidate)) {
      throw new Error('JavaScript 插件返回了未经宿主授权的远程媒体引用');
    }
  }
}

export function collectTrustedNodeMediaReferences(
  nodeType: NodeType,
  data: Record<string, unknown>,
): Set<string> {
  const references = new Set<string>();
  visitNodeMediaStrings(data, (value) => addTrustedMediaString(references, value), nodeType);
  return references;
}

function collectNodeToolMediaReferences(input: NodePluginInvocationInput): Set<string> {
  return collectTrustedNodeMediaReferences(input.node.type, input.node.data);
}

function collectPluginNodeMediaReferences(
  pluginNode: AvailablePluginNode,
  inputs: Record<string, PluginJsonValue>,
): Set<string> {
  const references = new Set<string>();
  for (const port of pluginNode.node.inputs) {
    if (!MEDIA_PORT_TYPES.has(port.type)) continue;
    visitMediaStrings(inputs[port.id], (value) => addTrustedMediaString(references, value));
  }
  return references;
}

function assertTrustedNodeMediaReferences(
  data: Record<string, PluginJsonValue>,
  trustedReferences: ReadonlySet<string>,
  nodeType?: NodeType,
): void {
  visitNodeMediaStrings(data, (value) => assertTrustedMediaString(value, trustedReferences), nodeType);
}

function addTrustedModelEffectReference(
  effect: Extract<PluginNodeHostEffect, { type: 'model.generate' }>,
  effectResult: PluginNodeHostEffectResult,
  models: PluginModelSummary[],
  references: Set<string>,
): void {
  const model = models.find((item) => item.id === effect.modelId);
  if (
    !effectResult.ok
    || !model
    || (model.category !== 'image' && model.category !== 'video' && model.category !== 'audio')
  ) return;
  const url = recordValue(effectResult.value).url;
  if (typeof url === 'string') addTrustedMediaString(references, url);
}

/**
 * 解析插件请求的宿主操作。
 *
 * `model.generate.imageUrls` 只接受本次输入中已存在的媒体引用或本轮宿主模型结果，
 * JavaScript 沙箱不能借模型调用构造新的远程地址；可信 Python 本身具备当前用户的
 * 联网能力，来源集合对它没有沙箱意义，因此不做该校验。
 */
function parseHostEffect(
  rawEffect: unknown,
  trustedMediaReferences?: ReadonlySet<string>,
): PluginNodeHostEffect {
  const raw = recordValue(rawEffect);
  const type = raw.type;
  if (type === 'video.replicaJob.status' || type === 'video.replicaJob.cancel') {
    if (Object.keys(raw).some((key) => !['type', 'jobId'].includes(key))
      || typeof raw.jobId !== 'string' || !/^video-replica-[a-zA-Z0-9-]{1,80}$/u.test(raw.jobId)) {
      throw new Error('复刻任务只接受当前会话登记的任务 ID');
    }
    return { type, jobId: raw.jobId };
  }
  if (type === 'video.replicaJob.start') {
    const fields = ['type', 'resourceId', 'modelId', 'analysisModelId', 'character', 'scene', 'style',
      'controls', 'cuts', 'maxSegmentSeconds', 'resolution', 'aspectRatio', 'audioMode', 'transcribe', 'downloadSpeech'];
    if (Object.keys(raw).some((key) => !fields.includes(key))
      || typeof raw.resourceId !== 'string' || !raw.resourceId || raw.resourceId.length > 160
      || typeof raw.modelId !== 'string' || !raw.modelId || raw.modelId.length > 200
      || typeof raw.audioMode !== 'string' || !['original', 'model', 'mute'].includes(raw.audioMode) || typeof raw.transcribe !== 'boolean'
      || (raw.downloadSpeech !== undefined && typeof raw.downloadSpeech !== 'boolean')
      || !Array.isArray(raw.controls) || raw.controls.length > 3 || new Set(raw.controls).size !== raw.controls.length
      || raw.controls.some((control) => typeof control !== 'string' || !['depth', 'pose', 'canny'].includes(control))) {
      throw new Error('复刻任务参数或控制类型无效');
    }
    for (const key of ['analysisModelId', 'character', 'scene', 'style', 'resolution', 'aspectRatio']) {
      if (raw[key] !== undefined && (typeof raw[key] !== 'string' || (raw[key] as string).length > (['character', 'scene', 'style'].includes(key) ? 2000 : 200))) {
        throw new Error('复刻要求或模型参数过长');
      }
    }
    if (raw.maxSegmentSeconds !== undefined && (typeof raw.maxSegmentSeconds !== 'number'
      || !Number.isFinite(raw.maxSegmentSeconds) || raw.maxSegmentSeconds <= 0 || raw.maxSegmentSeconds > 30)) {
      throw new Error('每段规划时长必须大于 0 且不超过 30 秒');
    }
    if (raw.cuts !== undefined && (!Array.isArray(raw.cuts) || raw.cuts.length > 63
      || raw.cuts.some((value, index) => typeof value !== 'number' || !Number.isFinite(value)
        || value <= 0 || (index > 0 && value <= (raw.cuts as number[])[index - 1])))) {
      throw new Error('手动切点必须是至多 63 个递增秒数');
    }
    return raw as unknown as PluginVideoReplicaStart;
  }
  if (type === 'prompt.mentions') {
    if (!['nodes', 'characters', 'assets'].includes(String(raw.source))
      || Object.keys(raw).some((key) => !['type', 'source', 'query', 'offset', 'preview'].includes(key))
      || (raw.query !== undefined && (typeof raw.query !== 'string' || raw.query.length > 120))
      || (raw.preview !== undefined && typeof raw.preview !== 'boolean')
      || (raw.offset !== undefined && (typeof raw.offset !== 'number' || !Number.isSafeInteger(raw.offset) || raw.offset < 0 || raw.offset > 10000))) {
      throw new Error('引用查询只接受来源、120 字查询、有界分页与布尔预览标记');
    }
    return { type, source: raw.source as 'nodes' | 'characters' | 'assets',
      ...(raw.query === undefined ? {} : { query: raw.query as string }),
      ...(raw.offset === undefined ? {} : { offset: raw.offset as number }),
      ...(raw.preview === undefined ? {} : { preview: raw.preview as boolean }) };
  }
  if (type === 'network.request') {
    if (typeof raw.url !== 'string' || raw.url.length > 4096) throw new Error('网络请求 URL 无效');
    const method = raw.method ?? 'GET';
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method))) throw new Error('网络请求 method 无效');
    if (raw.body !== undefined && (typeof raw.body !== 'string' || new TextEncoder().encode(raw.body).length > 64 * 1024)) {
      throw new Error('网络请求正文必须是最多 64 KiB 的字符串');
    }
    if (method === 'GET' && raw.body !== undefined) throw new Error('GET 请求不能携带正文');
    const headers: Record<string, string> = {};
    if (raw.headers !== undefined) {
      if (!raw.headers || typeof raw.headers !== 'object' || Array.isArray(raw.headers)) throw new Error('网络请求 headers 必须是对象');
      const entries = Object.entries(raw.headers);
      if (entries.length > 16) throw new Error('网络请求最多声明 16 个 header');
      for (const [key, value] of entries) {
        if (!['accept', 'content-type', 'authorization', 'x-api-key'].includes(key.toLowerCase())
          || typeof value !== 'string' || value.length > 4096 || /[\r\n]/u.test(value)) throw new Error('网络请求 header 无效或未获支持');
        headers[key.toLowerCase()] = value;
      }
    }
    return { type, url: raw.url, method: method as Extract<PluginNodeHostEffect, { type: 'network.request' }>['method'], headers, ...(raw.body === undefined ? {} : { body: raw.body as string }) };
  }
  if (type === 'settings.get' || type === 'settings.set' || type === 'settings.delete') {
    if (typeof raw.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(raw.key)) throw new Error('插件设置 key 无效');
    if (type === 'settings.set') {
      const value = toPluginJson(raw.value);
      if (value === undefined) throw new Error('插件设置 value 必须是 JSON 数据');
      return { type, key: raw.key, value };
    }
    return { type, key: raw.key };
  }
  if (type === 'image.lineArt') {
    if (typeof raw.resourceId !== 'string' || !raw.resourceId.trim() || raw.resourceId.length > 160
      || Object.keys(raw).some((key) => key !== 'type' && key !== 'resourceId')) {
      throw new Error('线稿转换只接受有效的派生 resourceId');
    }
    return { type, resourceId: raw.resourceId };
  }
  if (type === 'model.generate') {
    const rawImageUrls = Array.isArray(raw.imageUrls) ? raw.imageUrls : [];
    const imageUrls = rawImageUrls.filter((item): item is string => typeof item === 'string');
    if (imageUrls.length !== rawImageUrls.length) {
      throw new Error('模型调用的 imageUrls 必须是字符串数组');
    }
    if (imageUrls.length > MAX_ARRAY_ITEMS) {
      throw new Error(`模型调用的参考图不能超过 ${MAX_ARRAY_ITEMS} 张`);
    }
    const rawResourceIds = Array.isArray(raw.resourceIds) ? raw.resourceIds : [];
    const resourceIds = rawResourceIds.filter((item): item is string => (
      typeof item === 'string' && item.length > 0 && item.length <= 160
    ));
    if (resourceIds.length !== rawResourceIds.length || resourceIds.length > MAX_ARRAY_ITEMS) {
      throw new Error(`模型调用的 resourceIds 必须是最多 ${MAX_ARRAY_ITEMS} 个资源标识`);
    }
    if (trustedMediaReferences) {
      for (const url of imageUrls) assertTrustedMediaString(url, trustedMediaReferences);
    }
    const effect: Extract<PluginNodeHostEffect, { type: 'model.generate' }> = {
      type,
      modelId: String(raw.modelId ?? '').slice(0, 256),
      prompt: typeof raw.prompt === 'string' ? toPluginJson(raw.prompt) as string : '',
      parameters: raw.parameters === undefined
        ? undefined
        : toPluginJson(recordValue(raw.parameters)) as Record<string, PluginJsonValue>,
    };
    if (!effect.modelId || !effect.prompt.trim()) throw new Error('模型调用必须包含 modelId 和 prompt');
    if (imageUrls.length > 0) effect.imageUrls = imageUrls;
    if (resourceIds.length > 0) effect.resourceIds = resourceIds;
    return effect;
  }
  if (type === 'resource.readText') {
    const resourceId = String(raw.resourceId ?? '').slice(0, 160);
    if (!resourceId) throw new Error('文本资源读取必须包含 resourceId');
    const maxBytes = raw.maxBytes === undefined ? undefined : Number(raw.maxBytes);
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
      throw new Error('文本资源读取 maxBytes 无效');
    }
    return {
      type,
      resourceId,
      maxBytes,
    };
  }
  if (type === 'resource.readRange') {
    const resourceId = String(raw.resourceId ?? '').slice(0, 160);
    const offset = Number(raw.offset);
    const length = Number(raw.length);
    if (!resourceId || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) {
      throw new Error('分段资源读取参数无效');
    }
    return { type, resourceId, offset, length };
  }
  if (type === 'resource.createText') {
    return {
      type,
      content: typeof raw.content === 'string' ? toPluginJson(raw.content) as string : '',
      suggestedName: typeof raw.suggestedName === 'string'
        ? raw.suggestedName.slice(0, 120)
        : undefined,
    };
  }
  if (type === 'resource.export') {
    const resourceId = typeof raw.resourceId === 'string' ? raw.resourceId.slice(0, 160) : '';
    if (!resourceId) throw new Error('资源导出必须包含 resourceId');
    return { type, resourceId, suggestedName: typeof raw.suggestedName === 'string' ? raw.suggestedName.slice(0, 120) : undefined };
  }
  if (type === 'video.detectShots' || type === 'video.inspectFrame') {
    const resourceId = typeof raw.resourceId === 'string' ? raw.resourceId.slice(0, 160) : '';
    if (!resourceId) throw new Error('视频操作必须包含 resourceId');
    if (type === 'video.inspectFrame') {
      const time = Number(raw.time);
      const direction = Number(raw.direction ?? 0);
      if (!Number.isFinite(time) || time < 0 || (direction !== -1 && direction !== 0 && direction !== 1)) throw new Error('帧步进参数无效');
      return { type, resourceId, time, direction, boundary: raw.boundary === true };
    }
    const start = Number(raw.start);
    const end = Number(raw.end);
    const threshold = Number(raw.threshold ?? 0.28);
    const minShotDuration = Number(raw.minShotDuration ?? 0.3);
    if (![start, end, threshold, minShotDuration].every(Number.isFinite) || start < 0 || end <= start || end - start > 300
      || threshold < 0.05 || threshold > 0.95 || minShotDuration < 0.04 || minShotDuration > 10) throw new Error('镜头检测参数或区间无效');
    return { type, resourceId, start, end, threshold, minShotDuration };
  }
  if (type === 'video.extractFrames') {
    const resourceId = typeof raw.resourceId === 'string' ? raw.resourceId.slice(0, 160) : '';
    const mode = raw.mode === 'preview' || raw.mode === 'analysis' ? raw.mode : undefined;
    if (!resourceId || !mode) throw new Error('视频抽帧必须包含 resourceId 和有效 mode');
    if (mode === 'preview') {
      const count = Number(raw.count ?? 12);
      if (!Number.isSafeInteger(count) || count < 1 || count > 48) {
        throw new Error('视频预览帧数量必须在 1-48 之间');
      }
      return { type, resourceId, mode, count };
    }
    if (!Array.isArray(raw.samples) || raw.samples.length < 1 || raw.samples.length > 24) {
      throw new Error('视频分析帧数量必须在 1-24 之间');
    }
    const keys = new Set<string>();
    let previousTime = -1;
    const samples = raw.samples.map((rawSample) => {
      const sample = recordValue(rawSample);
      const key = typeof sample.key === 'string' ? sample.key : '';
      const time = Number(sample.time);
      if (!NODE_SET_KEY_RE.test(key) || keys.has(key) || !Number.isFinite(time) || time < 0) {
        throw new Error('视频分析帧参数无效');
      }
      if (time <= previousTime) {
        throw new Error('视频分析帧时间点必须严格递增');
      }
      keys.add(key);
      previousTime = time;
      return { key, time };
    });
    return { type, resourceId, mode, samples, replaceDerived: raw.replaceDerived === true };
  }
  throw new Error('插件请求了不支持的宿主操作');
}

/** UI Broker 的任务入口仍使用同一严格解析器；不接受原生路径或执行源码。 */
export function parsePluginVideoReplicaEffect(value: unknown): Extract<PluginNodeHostEffect, { type: 'video.replicaJob.start' | 'video.replicaJob.status' | 'video.replicaJob.cancel' }> {
  const effect = parseHostEffect(value);
  if (effect.type !== 'video.replicaJob.start' && effect.type !== 'video.replicaJob.status' && effect.type !== 'video.replicaJob.cancel') {
    throw new Error('复刻任务操作无效');
  }
  return effect;
}

function connectedInputValue(data: BaseNodeData, type: string): PluginJsonValue | undefined {
  if (type === 'resource') return undefined;
  const value = type === 'image'
    ? data.imageUrl ?? data.thumbnailUrl ?? data.output
    : type === 'video'
      ? data.videoUrl ?? data.output
      : type === 'audio'
        ? data.audioUrl ?? data.output
        : type === 'json'
          ? data.pluginOutputs ?? data.output
          : data.output ?? data.prompt;
  if (typeof value === 'string' && isLocalMediaReference(value)) return undefined;
  return toPluginJson(value, 0, true);
}

function connectedEdgeValue(
  source: Node<BaseNodeData>,
  sourceHandle: string | null | undefined,
  targetPort: PluginCustomNodePortManifest,
  plugins: InstalledPlugin[],
): PluginJsonValue | undefined {
  const sourcePortId = pluginHandlePortId(sourceHandle, 'plugin-out-');
  if (source.data.type !== 'plugin-node' || !sourcePortId) {
    return connectedInputValue(source.data, targetPort.type);
  }

  const pluginId = typeof source.data.pluginId === 'string' ? source.data.pluginId : undefined;
  const pluginNodeId = typeof source.data.pluginNodeId === 'string' ? source.data.pluginNodeId : undefined;
  const installedPlugin = plugins.find((item) => item.id === pluginId);
  if (!installedPlugin) throw new Error('来源插件未安装或已卸载，请重新连接端口');
  const sourceNode = installedPlugin.manifest.contributes.nodes?.find((item) => item.id === pluginNodeId);
  if (!sourceNode) throw new Error('来源插件节点已不存在，请重新连接端口');
  const sourcePort = sourceNode.outputs.find((item) => item.id === sourcePortId);
  if (!sourcePort) throw new Error(`来源插件输出端口「${sourcePortId}」已不存在，请重新连接端口`);
  if (sourcePort.type !== targetPort.type) {
    throw new Error(
      `端口类型不兼容：来源「${sourcePort.label}」为 ${sourcePort.type}，目标「${targetPort.label}」为 ${targetPort.type}`,
    );
  }

  return toPluginJson(recordValue(source.data.pluginOutputs)[sourcePortId]);
}

function buildPluginNodeInputs(pluginNode: AvailablePluginNode, nodeId: string): Record<string, PluginJsonValue> {
  const state = useAppStore.getState();
  const values: Record<string, PluginJsonValue[]> = {};
  for (const edge of state.edges.filter((item) => item.target === nodeId)) {
    const portId = pluginHandlePortId(edge.targetHandle, 'plugin-in-');
    const port = pluginNode.node.inputs.find((item) => item.id === portId);
    const source = state.nodes.find((item) => item.id === edge.source);
    if (!port || !source) continue;
    const value = connectedEdgeValue(source, edge.sourceHandle, port, state.installedPlugins);
    if (value === undefined) continue;
    (values[port.id] ??= []).push(value);
  }
  const output: Record<string, PluginJsonValue> = {};
  for (const port of pluginNode.node.inputs) {
    const portValues = values[port.id] ?? [];
    if (!port.multiple && portValues.length > 1) throw new Error(`输入「${port.label}」只允许一条连线`);
    if (portValues.length > 0) output[port.id] = port.multiple ? portValues : portValues[0];
  }
  return output;
}

function validatePluginNodeResult(
  value: unknown,
  pluginNode: AvailablePluginNode,
  trustedMediaReferences?: ReadonlySet<string>,
): PluginNodeExecutionResult {
  const result = recordValue(value);
  const message = typeof result.message === 'string' ? result.message.slice(0, 240) : undefined;
  let effect: PluginNodeHostEffect | undefined;
  if (result.effect !== undefined) {
    effect = parseHostEffect(result.effect, trustedMediaReferences);
  }

  let data: PluginNodeExecutionResult['data'];
  if (result.data !== undefined) {
    const rawData = recordValue(result.data);
    const allowedFields = new Set(pluginNode.node.fields.map((field) => field.id));
    const allowedOutputs = new Set(pluginNode.node.outputs.map((port) => port.id));
    const values: Record<string, PluginJsonValue> = {};
    const outputs: Record<string, PluginJsonValue> = {};
    for (const [key, raw] of Object.entries(recordValue(rawData.values))) {
      if (!allowedFields.has(key)) throw new Error(`插件返回了未声明字段: ${key}`);
      const normalized = toPluginJson(raw);
      if (normalized !== undefined) values[key] = normalized;
    }
    for (const [key, raw] of Object.entries(recordValue(rawData.outputs))) {
      if (!allowedOutputs.has(key)) throw new Error(`插件返回了未声明输出: ${key}`);
      const normalized = toPluginJson(raw);
      if (normalized !== undefined) {
        const port = pluginNode.node.outputs.find((item) => item.id === key);
        if (trustedMediaReferences && port && MEDIA_PORT_TYPES.has(port.type)) {
          visitMediaStrings(normalized, (item) => assertTrustedMediaString(item, trustedMediaReferences));
        }
        outputs[key] = normalized;
      }
    }
    data = { values, outputs };
  }
  if (!effect && !data) throw new Error('插件必须返回 data 或 effect');
  return { data, effect, message };
}

function stringParameter(parameters: Record<string, PluginJsonValue>, key: string): string | undefined {
  return typeof parameters[key] === 'string' ? parameters[key] : undefined;
}

function numberParameter(parameters: Record<string, PluginJsonValue>, key: string): number | undefined {
  return typeof parameters[key] === 'number' && Number.isFinite(parameters[key])
    ? parameters[key] as number
    : undefined;
}

async function executeModelEffect(
  effect: Extract<PluginNodeHostEffect, { type: 'model.generate' }>,
  models: PluginModelSummary[],
  nodeId: string,
  /** 已通过来源校验的参考图：连线输入与插件显式提交的 imageUrls。 */
  imageUrls: string[],
  signal?: AbortSignal,
): Promise<PluginJsonValue> {
  const model = models.find((item) => item.id === effect.modelId);
  if (!model) throw new Error('插件请求的模型不在当前可调用列表中');
  const parameters = effect.parameters ?? {};
  const common = { prompt: effect.prompt, model: model.id, provider: model.provider, nodeId };
  if (model.category === 'text') {
    return { text: await generateText({ ...common, imageUrls, signal }) };
  }
  if (model.category === 'image') {
    const result = await generateImage({
      ...common,
      imageSize: stringParameter(parameters, 'imageSize'),
      aspectRatio: stringParameter(parameters, 'aspectRatio'),
      image_urls: imageUrls,
    }, signal);
    return { url: result.url };
  }
  if (model.category === 'video') {
    const result = await generateVideo({
      ...common,
      videoResolution: numberParameter(parameters, 'videoResolution'),
      videoFps: numberParameter(parameters, 'videoFps'),
      videoFrames: numberParameter(parameters, 'videoFrames'),
      seedanceResolution: stringParameter(parameters, 'resolution'),
      seedanceRatio: stringParameter(parameters, 'aspectRatio'),
      seedanceDuration: numberParameter(parameters, 'duration'),
      generateAudio: typeof parameters.generateAudio === 'boolean' ? parameters.generateAudio : undefined,
    }, signal);
    return { url: result.url };
  }
  const result = await generateAudio({
    ...common,
    audioVoice: stringParameter(parameters, 'voice') as never,
    audioFormat: stringParameter(parameters, 'format') as never,
    audioSpeed: numberParameter(parameters, 'speed'),
    musicTitle: stringParameter(parameters, 'title'),
    musicLyrics: stringParameter(parameters, 'lyrics'),
    musicBpm: numberParameter(parameters, 'bpm'),
    musicDuration: numberParameter(parameters, 'duration'),
  }, signal);
  return { url: result.url, title: result.title ?? null, lyrics: result.lyrics ?? null };
}

/**
 * 宿主操作的执行上下文。节点工具没有输入端口，因此连线输入是可选的；
 * 缺少连线时参考图只来自插件显式提交并通过来源校验的 imageUrls。
 */
interface PluginHostEffectContext {
  pluginId: string;
  toolId?: string;
  projectId: string;
  title: string;
  permissions: PluginPermission[];
  resources?: PluginInvocationResources;
  resourceReadContext?: PluginResourceReadContext;
  pluginNode?: AvailablePluginNode;
  inputs?: Record<string, PluginJsonValue>;
  signal?: AbortSignal;
}

function allResourceRefs(resources: PluginInvocationResources | undefined) {
  if (!resources) return [];
  return [
    ...resources.self,
    ...resources.incoming,
    ...resources.package,
    ...resources.derived,
  ];
}

function connectedImageValues(
  pluginNode: AvailablePluginNode,
  inputs: Record<string, PluginJsonValue>,
): string[] {
  return pluginNode.node.inputs
    .filter((port) => port.type === 'image')
    .flatMap((port) => {
      const value = inputs[port.id];
      return (Array.isArray(value) ? value : [value])
        .filter((item): item is string => typeof item === 'string');
    });
}

async function executeHostEffect(
  context: PluginHostEffectContext,
  nodeId: string,
  effect: PluginNodeHostEffect,
  models: PluginModelSummary[],
): Promise<PluginNodeHostEffectResult> {
  const assertFresh = () => {
    if (context.signal?.aborted) throw new Error('插件操作已取消');
    const lease = context.resourceReadContext;
    if (!lease) throw new Error('插件资源会话已失效');
    const current = requireCurrentPluginRevision(context.pluginId, lease.sourceDigest, lease.revisionDigest);
    if (current.currentProjectId !== context.projectId || current.getCurrentRevision() !== lease.baseRevision
      || !current.nodes.some((node) => node.id === nodeId)) throw new Error('画布已变化，插件操作已撤销');
  };
  try {
    if (context.signal?.aborted) throw new Error('插件操作已取消');
    if (effect.type === 'video.replicaJob.start' || effect.type === 'video.replicaJob.status' || effect.type === 'video.replicaJob.cancel') {
      throw new Error('完整复刻任务必须通过已绑定的插件界面会话执行');
    }
    if (effect.type === 'prompt.mentions') {
      if (!context.permissions.includes('prompt.references.read')) throw new Error('插件未声明 prompt.references.read 权限');
      assertFresh();
      if (!context.resources || !context.resourceReadContext) throw new Error('插件引用会话已失效');
      const value = await queryPluginPromptMentions({ context: context.resourceReadContext, resources: context.resources,
        source: effect.source, query: effect.query, offset: effect.offset, preview: effect.preview, signal: context.signal });
      assertFresh();
      return { type: effect.type, ok: true, value: toPluginJson(value) };
    }
    if (effect.type === 'network.request' || effect.type === 'settings.get' || effect.type === 'settings.set' || effect.type === 'settings.delete') {
      const permission = effect.type === 'network.request' ? 'network.request' : effect.type === 'settings.get' ? 'settings.read' : 'settings.write';
      if (!context.permissions.includes(permission)) throw new Error(`插件未声明 ${permission} 权限`);
      assertFresh();
      const lease = context.resourceReadContext!;
      if (!context.toolId) throw new Error('插件工具身份缺失');
      const identity = { pluginId: context.pluginId, sourceDigest: lease.sourceDigest, revisionDigest: lease.revisionDigest, toolId: context.toolId, invocationId: lease.invocationId };
      const requestId = createPluginInvocationId();
      const cancel = () => { void invoke('cancel_plugin_host_effect', { pluginId: context.pluginId, requestId }).catch(() => undefined); };
      context.signal?.addEventListener('abort', cancel, { once: true });
      try {
        assertFresh();
        const value = await invoke<unknown>('execute_plugin_host_effect', { identity, requestId, effect });
        assertFresh();
        return { type: effect.type, ok: true, value: toPluginJson(value) };
      } finally {
        context.signal?.removeEventListener('abort', cancel);
      }
    }
    if (effect.type === 'model.generate') {
      if (!context.permissions.includes('models.invoke')) throw new Error('插件未声明 models.invoke 权限');
      const resourceImageUrls = await Promise.all((effect.resourceIds ?? []).map(async (resourceId) => {
        const resource = allResourceRefs(context.resources).find((item) => item.resourceId === resourceId);
        if (!resource) throw new Error('模型调用引用了当前调用范围外的资源');
        if (!resource.mediaType.startsWith('image/')) throw new Error('模型参考资源必须是图像');
        if (!context.resourceReadContext) throw new Error('插件资源会话已失效');
        return resolvePluginResourceHostUrl(context.resourceReadContext, resourceId);
      }));
      const imageUrls = [
        ...(context.pluginNode && context.inputs
          ? connectedImageValues(context.pluginNode, context.inputs)
          : []),
        ...(effect.imageUrls ?? []),
        ...resourceImageUrls,
      ];
      assertFresh();
      let modelEffect = effect;
      if (context.permissions.includes('prompt.references.read')) {
        if (!context.resources || !context.resourceReadContext) throw new Error('插件引用会话已失效');
        const resolved = await resolvePluginPromptReferencesForModel(effect.prompt, { context: context.resourceReadContext, resources: context.resources });
        modelEffect = { ...effect, prompt: resolved.prompt };
        imageUrls.push(...resolved.imageUrls);
      } else if (/@\{plugin-ref-/u.test(effect.prompt)) throw new Error('插件未声明 prompt.references.read 权限');
      assertFresh();
      const value = await executeModelEffect(modelEffect, models, nodeId, [...new Set(imageUrls)], context.signal);
      assertFresh();
      return {
        type: effect.type,
        ok: true,
        value,
      };
    }
    if (effect.type === 'resource.readText') {
      if (!context.resourceReadContext) throw new Error('插件资源会话已失效');
      const value = await readPluginResourceText(
        context.resourceReadContext,
        effect.resourceId,
        effect.maxBytes,
      );
      return { type: effect.type, ok: true, value: toPluginJson(value) };
    }
    if (effect.type === 'resource.readRange') {
      if (!context.resourceReadContext) throw new Error('插件资源会话已失效');
      const value = await readPluginResourceRange(
        context.resourceReadContext,
        effect.resourceId,
        effect.offset,
        effect.length,
      );
      return { type: effect.type, ok: true, value: toPluginJson(value) };
    }
    if (effect.type === 'image.lineArt') {
      if (!context.permissions.includes('files.connected.read') || !context.permissions.includes('files.output.create')) {
        throw new Error('线稿转换要求 files.connected.read 与 files.output.create 权限');
      }
      assertFresh();
      const lease = context.resourceReadContext!;
      if (!context.resources?.derived.some((resource) => resource.resourceId === effect.resourceId)) {
        throw new Error('线稿转换只能读取当前调用的派生图像');
      }
      let image = getPluginLineArtResource(lease, effect.resourceId);
      if (!image) {
        const original = readPluginDerivedResourceForOutput(lease, effect.resourceId);
        image = await createPluginLineArtImage({ bytes: original.bytes, mediaType: original.resource.mediaType }, {
          signal: context.signal,
          assertFresh,
        });
        assertFresh();
        setPluginLineArtResource(lease, effect.resourceId, image);
      }
      assertFresh();
      return { type: effect.type, ok: true, value: {
        resourceId: effect.resourceId,
        representation: 'lineart',
        width: image.width,
        height: image.height,
        previewDataUrl: image.previewDataUrl,
      } };
    }
    if (effect.type === 'video.extractFrames' || effect.type === 'video.detectShots' || effect.type === 'video.inspectFrame') {
      if (
        !context.permissions.includes('files.connected.read')
        || !context.permissions.includes('files.output.create')
      ) {
        throw new Error('视频抽帧要求 files.connected.read 与 files.output.create 权限');
      }
      if (!context.resources || !context.resourceReadContext) throw new Error('插件资源会话已失效');
      const source = context.resources.self.find((resource) => resource.resourceId === effect.resourceId);
      if (
        !source
        || source.origin !== 'node-self'
        || source.source?.nodeId !== nodeId
        || !source.mediaType.startsWith('video/')
      ) {
        throw new Error('视频抽帧只能读取当前节点的 self 视频资源');
      }
      const url = await resolvePluginResourceHostUrl(context.resourceReadContext, effect.resourceId);
      assertFresh();
      if (effect.type === 'video.detectShots' || effect.type === 'video.inspectFrame') {
        const value = effect.type === 'video.detectShots'
          ? await detectPluginVideoShots({ ...effect, url, signal: context.signal })
          : await inspectPluginVideoFrame({ ...effect, url, signal: context.signal });
        assertFresh();
        return { type: effect.type, ok: true, value: toPluginJson(value) };
      }
      const batch = await extractPluginVideoFrames({
        url,
        mode: effect.mode,
        count: effect.count,
        samples: effect.samples,
        signal: context.signal,
      });
      assertFresh();
      const entries = batch.frames.flatMap((frame) => !('error' in frame) && frame.bytes ? [{
        displayName: `${frame.key}.jpg`, mediaType: frame.mediaType, bytes: frame.bytes,
      }] : []);
      if (batch.contactSheet) entries.push({ displayName: 'frame-contact-sheet.jpg', ...batch.contactSheet });
      const refs = effect.replaceDerived
        ? replacePluginDerivedResources(context.resourceReadContext, context.resources, entries)
        : entries.map((entry) => registerPluginDerivedResource(context.resourceReadContext!, context.resources!, entry));
      let resourceIndex = 0;
      const frames = batch.frames.map((frame) => {
        if ('error' in frame) return frame;
        const resource = frame.bytes ? refs[resourceIndex++] : undefined;
        return {
          key: frame.key,
          requestedTime: frame.requestedTime,
          actualTime: frame.actualTime,
          frameDuration: frame.frameDuration,
          width: frame.width,
          height: frame.height,
          previewDataUrl: frame.previewDataUrl,
          resourceId: resource?.resourceId,
        };
      });
      const contactSheet = batch.contactSheet ? refs[resourceIndex] : undefined;
      return {
        type: effect.type,
        ok: true,
        value: toPluginJson({
          video: batch.video,
          frames,
          contactSheetResourceId: contactSheet?.resourceId,
        }),
      };
    }
    if (!context.permissions.includes('files.output.create')) {
      throw new Error('插件未声明 files.output.create 权限');
    }
    if (effect.type !== 'resource.export' && effect.type !== 'resource.createText') {
      throw new Error('此宿主操作不能创建文件');
    }
    // 导出只接受当前 invocation 的派生图像，不暴露任意路径读写。
    if (effect.type === 'resource.export' && !context.resourceReadContext) throw new Error('插件资源会话已失效');
    if (context.resourceReadContext) assertFresh();
    const exported = effect.type === 'resource.export' && context.resourceReadContext
      ? readPluginDerivedResourceForOutput(context.resourceReadContext, effect.resourceId)
      : undefined;
    const safeCharacters = Array.from(
      (effect.suggestedName || exported?.resource.displayName || 'plugin-output.txt').replace(/[<>:"/\\|?*]/gu, '_'),
      (character) => (character.codePointAt(0)! <= 0x1f ? '_' : character),
    ).join('');
    const suggestedName = safeCharacters
      .replace(/^\.+/u, '')
      .trim()
      .slice(0, 120) || 'plugin-output.txt';
    const bytes = exported?.bytes ?? new TextEncoder().encode(effect.type === 'resource.createText' ? effect.content : '');
    const saved = await saveBinaryToProjectData(bytes, context.projectId, suggestedName);
    if (!saved) throw new Error(`无法在当前项目中创建「${context.title}」输出`);
    if (context.resourceReadContext) {
      try { assertFresh(); } catch (error) { await moveToTrash(saved.filePath); throw error; }
    }
    const fileName = saved.filePath.replace(/\\/gu, '/').split('/').at(-1) ?? suggestedName;
    return {
      type: effect.type,
      ok: true,
      value: { fileName, bytes: bytes.byteLength },
    };
  } catch (error) {
    return {
      type: effect.type,
      ok: false,
      error: error instanceof Error ? error.message : '宿主操作失败',
    };
  }
}

function outputPatch(
  pluginNode: AvailablePluginNode,
  outputs: Record<string, PluginJsonValue>,
): Partial<BaseNodeData> {
  const patch: Partial<BaseNodeData> = { pluginOutputs: outputs };
  for (const port of pluginNode.node.outputs) {
    const value = outputs[port.id];
    if (typeof value !== 'string') continue;
    if (port.type === 'image' && patch.imageUrl === undefined) patch.imageUrl = value;
    else if (port.type === 'video' && patch.videoUrl === undefined) patch.videoUrl = value;
    else if (port.type === 'audio' && patch.audioUrl === undefined) patch.audioUrl = value;
    else if ((port.type === 'text' || port.type === 'json') && patch.output === undefined) patch.output = value;
  }
  return patch;
}

export async function executePluginNode(
  pluginNode: AvailablePluginNode,
  nodeId: string,
  models: PluginModelSummary[],
): Promise<void> {
  const before = useAppStore.getState();
  const projectId = before.currentProjectId;
  const sourceNode = before.nodes.find((node) => node.id === nodeId);
  if (!projectId || !sourceNode) throw new Error('插件节点或项目不存在');
  const sourceDigest = requirePluginSourceDigest(
    before.installedPlugins,
    pluginNode.pluginId,
    pluginNode.sourceDigest,
  );
  const revisionDigest = requirePluginRevisionDigest(
    before.installedPlugins,
    pluginNode.pluginId,
    pluginNode.revisionDigest,
  );
  const installedPlugin = before.installedPlugins.find((item) => item.id === pluginNode.pluginId);
  if (!installedPlugin) throw new Error('插件已被卸载');
  const invocationId = createPluginInvocationId();
  const values = toPluginJson(sourceNode.data.pluginValues) as Record<string, PluginJsonValue> | undefined;
  for (const field of pluginNode.node.fields) {
    const value = values?.[field.id];
    const missing = value === undefined || value === null || value === '' || (field.type === 'boolean' && value !== true);
    if (field.required && missing) throw new Error(`请填写「${field.label}」`);
  }
  const inputs = buildPluginNodeInputs(pluginNode, nodeId);
  const cancellation = new AbortController();
  const guard = registerCanvasDerivation(before, nodeId, { onCancel: () => cancellation.abort() });
  if (!guard) throw new Error('无法创建插件执行保护');
  const execution = watchPluginExecution(pluginNode.pluginId, sourceDigest, revisionDigest, guard, cancellation.signal);
  const assertFresh = () => {
    const current = requireCurrentPluginRevision(pluginNode.pluginId, sourceDigest, revisionDigest);
    if (!isCanvasDerivationFresh(guard, current)) throw new Error('画布已变化，插件结果未写入');
    if (execution.signal.aborted) throw new Error('插件操作已取消');
    return current;
  };
  const trustedMediaReferences = pluginNode.runtime === 'javascript'
    ? collectPluginNodeMediaReferences(pluginNode, inputs)
    : undefined;
  let effectResult: PluginNodeHostEffectResult | undefined;
  const effectCounts: Record<string, number> = {};

  try {
    const resources = await mintPluginInvocationResources({
      pluginId: pluginNode.pluginId,
      sourceDigest,
      revisionDigest,
      invocationId,
      projectId,
      nodeId,
      baseRevision: guard.baseRevision,
      access: pluginNode.node.resourceAccess,
      inputPorts: pluginNode.node.inputs,
      packageResources: installedPlugin.manifest.resources,
      state: before,
    });
    for (const port of pluginNode.node.inputs) {
      const connectedResources = resources.inputs[port.id] ?? [];
      const connectedValues = inputs[port.id];
      const valueCount = Array.isArray(connectedValues)
        ? connectedValues.length
        : connectedValues === undefined ? 0 : 1;
      if (!port.multiple && connectedResources.length > 1) {
        throw new Error(`输入「${port.label}」只允许一条连线`);
      }
      if (port.required && valueCount === 0 && connectedResources.length === 0) {
        throw new Error(`缺少必填输入「${port.label}」`);
      }
    }
    const resourceReadContext = (): PluginResourceReadContext => ({
      pluginId: pluginNode.pluginId,
      sourceDigest,
      revisionDigest,
      invocationId,
      projectId,
      nodeId,
      baseRevision: guard.baseRevision,
      permissions: pluginNode.permissions,
      state: useAppStore.getState(),
    });
    for (let iteration = 0; iteration <= MAX_HOST_EFFECTS; iteration += 1) {
      assertFresh();
      const input: PluginNodeInvocationInput = {
        host: PLUGIN_HOST,
        projectId,
        locale: getLocale(),
        iteration,
        node: { id: nodeId, values: values ?? {} },
        inputs,
        models: pluginNode.permissions.includes('models.read') ? models : [],
        resources,
        effectResult,
      };
      const rawResult = await invokePluginTool({
        pluginId: pluginNode.pluginId,
        sourceDigest,
        revisionDigest,
        toolId: pluginNode.node.id,
        invocationId,
      }, input, execution.signal);
      assertFresh();
      const result = validatePluginNodeResult(rawResult, pluginNode, trustedMediaReferences);
      if (result.effect) {
        if (iteration === MAX_HOST_EFFECTS) throw new Error(`插件宿主操作不能超过 ${MAX_HOST_EFFECTS} 次`);
        reserveToolEffect(effectCounts, result.effect);
        effectResult = await executeHostEffect(
          {
            pluginId: pluginNode.pluginId,
            toolId: pluginNode.node.id,
            projectId,
            title: pluginNode.node.title,
            permissions: pluginNode.permissions,
            resources,
            resourceReadContext: resourceReadContext(),
            pluginNode,
            inputs,
            signal: execution.signal,
          },
          nodeId,
          result.effect,
          models,
        );
        assertFresh();
        if (trustedMediaReferences && result.effect.type === 'model.generate') {
          addTrustedModelEffectReference(result.effect, effectResult, models, trustedMediaReferences);
        }
        continue;
      }

      const current = assertFresh();
      const nextValues = { ...(values ?? {}), ...(result.data?.values ?? {}) };
      const nextOutputs = result.data?.outputs ?? {};
      current.updateNodeData(nodeId, {
        pluginValues: nextValues,
        status: 'success',
        ...outputPatch(pluginNode, nextOutputs),
      });
      current.showToast(result.message || `插件节点「${pluginNode.node.title}」执行完成`);
      return;
    }
  } finally {
    execution.dispose();
    clearPluginInvocationResources(invocationId);
    completeCanvasDerivation(guard);
  }
}

interface PreparedPluginNodeSet {
  nodes: Node<BaseNodeData>[];
  edges: Edge[];
  nodeIdsByKey: Record<string, string>;
  rollback: () => Promise<void>;
  assertGenerationModelsFresh: () => void;
  assertReferencesFresh: () => Promise<void>;
  videoPreflight: VideoPreflightItem[];
}

function dispatchPluginVideoBatch(identity: PluginInvocationIdentity, projectId: string,
  batch: { items: VideoPreflightItem[]; assertModelsFresh: () => void }): void {
  try {
    const state = requireCurrentPluginRevision(identity.pluginId, identity.sourceDigest, identity.revisionDigest);
    if (state.currentProjectId !== projectId) throw new Error('项目已切换');
    batch.assertModelsFresh();
    void state.startVideoBatch(projectId, batch.items).catch(() => {
      useAppStore.getState().showToast('视频批次未完成，请检查已创建的视频节点；未自动重新提交');
    });
  } catch {
    useAppStore.getState().showToast('视频节点已创建，批次未启动；请检查项目、插件或模型配置');
  }
}

async function preparePluginNodeSet(options: {
  nodeSet: PluginNodeSetData;
  sourceNode: Node<BaseNodeData>;
  projectId: string;
  resourceContext: PluginResourceReadContext;
  assertFresh: () => void;
  artifacts?: PluginNativeMediaArtifactRef[];
  identity?: PluginInvocationIdentity;
  models: PluginModelSummary[];
  resources: PluginInvocationResources;
}): Promise<PreparedPluginNodeSet> {
  const savedPaths: string[] = [];
  const originalReferenceData = options.nodeSet.nodes.map((item) => item.data);
  // 仅已授权的调用级 token 可回填为宿主规范引用；路径不经过插件/Python。
  const rewriteValue = async (value: PluginJsonValue): Promise<PluginJsonValue> => {
    if (typeof value === 'string') return rewritePluginPromptReferences(value, { context: options.resourceContext, resources: options.resources });
    if (Array.isArray(value)) return Promise.all(value.map(rewriteValue));
    if (value && typeof value === 'object') {
      const entries: Array<[string, PluginJsonValue]> = [];
      for (const [key, item] of Object.entries(value)) entries.push([key, await rewriteValue(item)]);
      return Object.fromEntries(entries);
    }
    return value;
  };
  if (options.resourceContext.permissions.includes('prompt.references.read')) {
    const rewritten: PluginNodeSetData['nodes'] = [];
    for (const item of options.nodeSet.nodes) {
      const data = await rewriteValue(item.data) as Record<string, PluginJsonValue>;
      options.assertFresh();
      rewritten.push({ ...item, data });
    }
    options.nodeSet = { ...options.nodeSet, nodes: rewritten };
  } else if (JSON.stringify(options.nodeSet.nodes).includes('@{plugin-ref-')) {
    throw new Error('插件未声明 prompt.references.read 权限');
  }
  const assertReferencesFresh = async () => {
    if (options.resourceContext.permissions.includes('prompt.references.read')) {
      for (const data of originalReferenceData) await rewriteValue(data);
    }
    options.assertFresh();
  };
  const { resolveMediaModel } = options.nodeSet.nodes.some((item) => item.generation)
    ? await import('../ai/generationRuntime') : { resolveMediaModel: undefined };
  const resolveGeneration = (generation: PluginNodeSetVideoGeneration) => {
    const state = useAppStore.getState();
    if (!options.models.some((model) => model.id === generation.modelId && model.category === 'video')
      || !buildPluginModelCatalog(state.config, ['video']).some((model) => model.id === generation.modelId && model.category === 'video')
      || !resolveMediaModel) throw new Error('视频生成模型未配置或不在本次安全目录');
    const resolved = resolveMediaModel('video', generation.modelId);
    const model = state.config.generalModels?.find((entry) => `general/${entry.id}` === generation.modelId);
    const workflow = resolved.workflowId ? state.workflows.find((entry) => entry.id === resolved.workflowId) : undefined;
    const server = workflow?.serverId ? state.config.comfyServers?.find((entry) => entry.id === workflow.serverId) : undefined;
    return { resolved, fingerprint: JSON.stringify([resolved, model, workflow, server?.url, state.config.comfyUIUrl,
      model ? state.config.providers[model.providerConfigId]?.baseUrl : undefined]) };
  };
  const generations = new Map(options.nodeSet.nodes.flatMap((item) => item.generation
    ? [[item.key, resolveGeneration(item.generation)] as const] : []));
  const assertGenerationModelsFresh = () => {
    for (const item of options.nodeSet.nodes) {
      if (item.generation && resolveGeneration(item.generation).fingerprint !== generations.get(item.key)?.fingerprint) {
        throw new Error('视频模型或工作流配置已变化，请重新检查');
      }
    }
  };
  const savedImages = new Map<string, {
    nodeId: string;
    assetUrl: string;
    filePath: string;
    fileName: string;
    dimensions: { nodeWidth: number; nodeHeight: number };
    pixelDimensions?: { width: number; height: number };
  }>();
  const nodeIds = new Map(options.nodeSet.nodes.map((item) => [item.key, `node-${generateId()}`]));
  const savedVideos = new Map<string, { assetUrl: string; filePath: string; fileName: string }>();
  const rollback = async () => {
    await Promise.all(savedPaths.map((filePath) => moveToTrash(filePath)));
  };
  const validateImages = () => {
    options.assertFresh();
    for (const item of options.nodeSet.nodes) {
      if (item.resourceId) readPluginDerivedResourceForOutput(
        options.resourceContext, item.resourceId, item.representation ?? 'original',
      );
    }
  };

  try {
    // 整批先验证选择的表示，缺少线稿时不能先保存部分原图。
    validateImages();
    const videoBytes = new Map<string, Uint8Array>();
    for (const artifact of options.artifacts ?? []) {
      if (!options.identity) throw new Error('视频产物缺少原生调用身份');
      videoBytes.set(artifact.key, await readNativeMediaArtifact(options.identity, artifact, options.assertFresh));
    }
    for (const artifact of options.artifacts ?? []) {
      options.assertFresh();
      const saved = await saveBinaryToProjectData(videoBytes.get(artifact.key)!, options.projectId, `plugin-video-${artifact.key}.mp4`, { throwOnError: true });
      if (saved) savedPaths.push(saved.filePath);
      if (!saved?.assetUrl) throw new Error(`无法保存视频产物「${artifact.key}」`);
      options.assertFresh();
      savedVideos.set(artifact.key, { ...saved, fileName: saved.filePath.replace(/\\/gu, '/').split('/').at(-1)! });
    }
    for (const item of options.nodeSet.nodes) {
      if (!item.resourceId) continue;
      options.assertFresh();
      const derived = readPluginDerivedResourceForOutput(options.resourceContext, item.resourceId, item.representation ?? 'original');
      const extension = derived.resource.mediaType === 'image/png'
        ? 'png'
        : derived.resource.mediaType === 'image/webp' ? 'webp' : 'jpg';
      const fileName = `video-frame-${item.key}.${extension}`;
      const saved = await saveBinaryToProjectData(derived.bytes, options.projectId, fileName);
      if (saved) savedPaths.push(saved.filePath);
      if (!saved?.assetUrl) throw new Error(`无法保存抽帧图像「${item.key}」`);
      // 像素尺寸不是节点展示尺寸；从宿主保存的图像计算，避免竖图落入默认横框。
      const dimensions = await computeImageNodeDimensions(saved.assetUrl);
      options.assertFresh();
      savedImages.set(item.key, {
        nodeId: nodeIds.get(item.key)!,
        assetUrl: saved.assetUrl,
        filePath: saved.filePath,
        fileName: saved.filePath.replace(/\\/gu, '/').split('/').at(-1) ?? fileName,
        dimensions,
        pixelDimensions: derived.dimensions,
      });
    }

    // 保存含异步操作；提交前再次确认派生批次仍有效。
    validateImages();
    const base = derivedNodePlacement(options.sourceNode);
    const nodes = options.nodeSet.nodes.map((item) => {
      const image = savedImages.get(item.key);
      const video = item.artifactKey ? savedVideos.get(item.artifactKey) : undefined;
      const data = { ...item.data } as Record<string, unknown>;
      if (item.generation) {
        const model = generations.get(item.key)!.resolved;
        const parameters = item.generation.parameters;
        Object.assign(data, { model: model.requestModel, provider: model.provider,
          ...(model.workflowId ? { workflowId: model.workflowId } : {}),
          ...(parameters?.duration !== undefined ? { seedanceDuration: parameters.duration } : {}),
          ...(parameters?.aspectRatio !== undefined ? { seedanceRatio: parameters.aspectRatio } : {}),
          ...(parameters?.resolution !== undefined ? { seedanceResolution: parameters.resolution } : {}),
          ...(parameters?.videoResolution !== undefined ? { videoResolution: parameters.videoResolution } : {}),
          ...(parameters?.videoFps !== undefined ? { videoFps: parameters.videoFps } : {}),
          ...(parameters?.videoFrames !== undefined ? { videoFrames: parameters.videoFrames } : {}),
          ...(parameters?.generateAudio !== undefined ? { generateAudio: parameters.generateAudio } : {}),
        });
      }
      if (data.frameAnalysis && typeof data.frameAnalysis === 'object' && !Array.isArray(data.frameAnalysis)) {
        data.frameAnalysis = {
          ...(data.frameAnalysis as Record<string, unknown>),
          sourceVideoNodeId: options.sourceNode.id,
          sourceVideoName: String(options.sourceNode.data.label || '视频').slice(0, 240),
        };
      }
      if (Array.isArray(data.shotlistRows)) {
        data.shotlistRows = data.shotlistRows.map((rawRow) => {
          const row = recordValue(rawRow);
          const frameKey = typeof row.frameKey === 'string' ? row.frameKey : undefined;
          const frameImage = frameKey ? savedImages.get(frameKey) : undefined;
          if (frameKey && !frameImage) throw new Error(`分镜行引用了无效画面 key: ${frameKey}`);
          const { frameKey: _frameKey, ...cleanRow } = row;
          return {
            ...cleanRow,
            ...(row.frameAnalysis && typeof row.frameAnalysis === 'object' ? {
              frameAnalysis: {
                ...recordValue(row.frameAnalysis),
                sourceVideoNodeId: options.sourceNode.id,
                sourceVideoName: String(options.sourceNode.data.label || '视频').slice(0, 240),
              },
            } : {}),
            frame: frameImage ? {
              nodeId: frameImage.nodeId,
              kind: 'image',
              url: frameImage.assetUrl,
              filePath: frameImage.filePath,
            } : null,
          };
        });
      }
      if (image) {
        data.imageUrl = image.assetUrl;
        data.filePath = image.filePath;
        data.fileName = image.fileName;
        data.nodeWidth = image.dimensions.nodeWidth;
        data.nodeHeight = image.dimensions.nodeHeight;
        if (image.pixelDimensions) {
          data.imageWidth = image.pixelDimensions.width;
          data.imageHeight = image.pixelDimensions.height;
        }
      }
      if (video) {
        data.videoUrl = video.assetUrl;
        data.output = video.assetUrl;
        data.filePath = video.filePath;
        data.fileName = video.fileName;
        data.relativePath = video.fileName;
      }
      return {
        id: nodeIds.get(item.key)!,
        type: item.nodeType,
        position: { ...base.position },
        ...(base.parentId ? { parentId: base.parentId } : {}),
        data: {
          label: typeof data.label === 'string' ? data.label : item.key,
          type: item.nodeType,
          role: 'source',
          status: 'success',
          ...data,
          ...(item.generation ? { role: 'prompt', status: 'idle' } : {}),
        } as BaseNodeData,
      };
    });
    // 分镜表比普通媒体节点宽；按真实度量排物料，生成节点始终位于参考素材右侧。
    const dimensions = new Map(nodes.map((node) => {
      const fallback = node.type === 'ai-shotlist' ? { width: 720, height: 380 }
        : node.type === 'ai-markdown' ? { width: 280, height: 200 }
          : getNodeBounds({ ...node, data: { ...node.data, nodeWidth: undefined, nodeHeight: undefined } }, nodes);
      if (!(typeof node.data.nodeWidth === 'number' && Number.isFinite(node.data.nodeWidth) && node.data.nodeWidth > 0)) node.data.nodeWidth = fallback.width;
      if (!(typeof node.data.nodeHeight === 'number' && Number.isFinite(node.data.nodeHeight) && node.data.nodeHeight > 0)) node.data.nodeHeight = fallback.height;
      return [node.id, getNodeBounds(node, nodes)] as const;
    }));
    const generatedNodeIds = new Set([...generations.keys()].map((key) => nodeIds.get(key)!));
    let materialX = base.position.x;
    let materialY = base.position.y;
    let materialRowHeight = 0;
    let materialRight = base.position.x;
    const materials = nodes.filter((node) => !generatedNodeIds.has(node.id));
    for (const [index, node] of materials.entries()) {
      if (index > 0 && index % 4 === 0) {
        materialY += Math.max(280, materialRowHeight + 80);
        materialX = base.position.x;
        materialRowHeight = 0;
      }
      const size = dimensions.get(node.id)!;
      node.position = { x: materialX, y: materialY };
      materialRight = Math.max(materialRight, materialX + size.width);
      materialX += size.width + 80;
      materialRowHeight = Math.max(materialRowHeight, size.height);
    }
    let generatedY = base.position.y;
    for (const node of nodes.filter((item) => generatedNodeIds.has(item.id))) {
      node.position = { x: materials.length ? materialRight + 80 : base.position.x, y: generatedY };
      generatedY += dimensions.get(node.id)!.height + 80;
    }
    const edges = (options.nodeSet.edges ?? []).map((edge) => ({
      id: `edge-${generateId()}`,
      source: nodeIds.get(edge.sourceKey)!,
      target: nodeIds.get(edge.targetKey)!,
      sourceHandle: 'right',
      targetHandle: 'left',
    }));
    await assertReferencesFresh();
    assertGenerationModelsFresh();
    const state = useAppStore.getState();
    const workspace = { ...state, nodes: [...state.nodes, ...nodes], edges: [...state.edges, ...edges] };
    const generationIds = new Set([...generations.keys()].map((key) => nodeIds.get(key)!));
    const videoPreflight = nodes.filter((node) => generationIds.has(node.id)).map((node) => inspectVideoNode(node, workspace));
    if (videoPreflight.some((item) => item.issues.length)) throw new Error('视频生成节点预检失败，请检查模型与本批参考媒体');
    return { nodes, edges, nodeIdsByKey: Object.fromEntries(nodeIds), rollback, assertGenerationModelsFresh, assertReferencesFresh, videoPreflight };
  } catch (error) {
    await rollback();
    throw error;
  }
}

export async function executeNodePluginTool(
  pluginTool: AvailableNodePluginTool,
  nodeId: string,
  parameters: Record<string, PluginJsonValue> = {},
  executionLease?: {
    invocationId: string;
    guard: CanvasDerivationGuard;
    resources: PluginInvocationResources;
    trustedMediaReferences?: Set<string>;
    signal?: AbortSignal;
  },
  /** 仅宿主后台任务使用，不从插件 JSON、SDK 或 UI 请求反序列化。 */
  hostTask?: { materialsOnly: true },
): Promise<void | { nodes: Node<BaseNodeData>[]; edges: Edge[]; nodeIdsByKey: Record<string, string> }> {
  const before = useAppStore.getState();
  const projectId = before.currentProjectId;
  const sourceNode = before.nodes.find((node) => node.id === nodeId);
  if (!projectId || !sourceNode) throw new Error('目标节点或项目不存在');
  const sourceDigest = requirePluginSourceDigest(
    before.installedPlugins,
    pluginTool.pluginId,
    pluginTool.sourceDigest,
  );
  const revisionDigest = requirePluginRevisionDigest(
    before.installedPlugins,
    pluginTool.pluginId,
    pluginTool.revisionDigest,
  );
  const installedPlugin = before.installedPlugins.find((item) => item.id === pluginTool.pluginId);
  if (!installedPlugin) throw new Error('插件已被卸载');
  const ownsExecutionLease = !executionLease;
  const invocationId = executionLease?.invocationId ?? createPluginInvocationId();
  const cancellation = new AbortController();
  const guard = executionLease?.guard ?? registerCanvasDerivation(before, nodeId, { onCancel: () => cancellation.abort() });
  if (!guard) throw new Error('无法创建插件执行保护');
  if (
    guard.projectId !== projectId
    || guard.sourceNodeId !== nodeId
    || !isCanvasDerivationFresh(guard, before)
  ) {
    throw new Error('插件界面会话已失效');
  }
  const normalizedParameters: Record<string, PluginJsonValue> = {};
  const models = buildNodeToolModelCatalog(pluginTool);
  // JavaScript 沙箱没有任意网络能力，媒体引用只能来自本次输入与本轮宿主模型结果。
  // 该集合跨 effect 轮次累积，让后续轮次可以引用前面模型生成的媒体。
  const trustedMediaReferences = pluginTool.runtime === 'javascript'
    ? executionLease?.trustedMediaReferences ?? new Set<string>()
    : undefined;
  let effectResult: PluginNodeHostEffectResult | undefined;
  const effectCounts: Record<string, number> = {};
  const execution = watchPluginExecution(pluginTool.pluginId, sourceDigest, revisionDigest, guard, executionLease?.signal ?? cancellation.signal);
  const assertExecutionFresh = () => {
    const current = requireCurrentPluginRevision(pluginTool.pluginId, sourceDigest, revisionDigest);
    if (!isCanvasDerivationFresh(guard, current)) throw new Error('画布已变化，插件结果未写入');
    if (execution.signal.aborted) throw new Error('插件操作已取消');
    return current;
  };
  const identity: PluginInvocationIdentity = {
    pluginId: pluginTool.pluginId, sourceDigest, revisionDigest, toolId: pluginTool.tool.id, invocationId,
  };
  const usesNativeMedia = pluginTool.tool.pythonExecution?.mediaWorkspace === true;
  let mediaWorkspaceAttempted = false;
  let pendingVideoBatch: { items: VideoPreflightItem[]; assertModelsFresh: () => void } | undefined;

  try {
    assertExecutionFresh();
    if (pluginTool.tool.output.generateVideos && (installedPlugin.manifest.apiVersion !== 2
      || !installedPlugin.manifest.requiredCapabilities?.includes('video.nodeSetGeneration')
      || !installedPlugin.manifest.permissions.includes('models.read')
      || !installedPlugin.manifest.permissions.includes('models.invoke')
      || pluginTool.tool.output.mode !== 'create-node-set')) {
      throw new Error('插件未获准生成视频节点集');
    }
    const parameterEntries = Object.entries(parameters);
    if (parameterEntries.length > MAX_OBJECT_KEYS) throw new Error(`插件数据对象不能超过 ${MAX_OBJECT_KEYS} 个键`);
    for (const [key, value] of parameterEntries) {
      if (DANGEROUS_OBJECT_KEYS.has(key)) continue;
      const normalized = toPluginJson(value);
      if (normalized !== undefined) normalizedParameters[key] = normalized;
    }
    const resources = executionLease?.resources ?? await mintPluginInvocationResources({
      pluginId: pluginTool.pluginId,
      sourceDigest,
      revisionDigest,
      invocationId,
      projectId,
      nodeId,
      baseRevision: guard.baseRevision,
      access: pluginTool.tool.resourceAccess,
      packageResources: installedPlugin.manifest.resources,
      state: before,
    });
    const resourceReadContext = (): PluginResourceReadContext => ({
      pluginId: pluginTool.pluginId,
      sourceDigest,
      revisionDigest,
      invocationId,
      projectId,
      nodeId,
      baseRevision: guard.baseRevision,
      permissions: pluginTool.permissions,
      state: useAppStore.getState(),
    });
    if (usesNativeMedia) {
      if (pluginTool.runtime !== 'python' || installedPlugin.manifest.apiVersion !== 2
        || !installedPlugin.manifest.requiredCapabilities?.includes('python.mediaWorkspace')
        || pluginTool.tool.resourceAccess?.self !== true) throw new Error('Python 媒体工作区声明无效');
      const inputs = await resolvePluginMediaWorkspaceInputs(resourceReadContext(), resources);
      assertExecutionFresh();
      mediaWorkspaceAttempted = true;
      const cancelPrepare = () => {
        void invoke('cancel_node_plugin_tool', { pluginId: identity.pluginId, invocationId: identity.invocationId }).catch(() => undefined);
      };
      execution.signal.addEventListener('abort', cancelPrepare, { once: true });
      try {
        await invoke<void>('prepare_plugin_media_workspace', { identity, inputs });
        assertExecutionFresh();
      } finally {
        execution.signal.removeEventListener('abort', cancelPrepare);
      }
    }
    for (let iteration = 0; iteration <= MAX_HOST_EFFECTS; iteration += 1) {
      assertExecutionFresh();
      const input = buildInvocationInput(
        projectId,
        sourceNode,
        pluginTool.tool.inputFields,
        normalizedParameters,
        { iteration, models, resources, effectResult },
      );
      input.host = PLUGIN_HOST;
      if (trustedMediaReferences) {
        for (const reference of collectNodeToolMediaReferences(input)) {
          trustedMediaReferences.add(reference);
        }
      }
      const rawResult = await invokePluginTool({
        pluginId: pluginTool.pluginId,
        sourceDigest,
        revisionDigest,
        toolId: pluginTool.tool.id,
        invocationId,
      }, input, execution.signal);
      assertExecutionFresh();
      const outputNodeType = pluginTool.tool.output.mode === 'create-node'
        ? pluginTool.tool.output.nodeType ?? sourceNode.data.type
        : sourceNode.data.type;
      const result = validateResult(
        rawResult,
        pluginTool.tool.output,
        trustedMediaReferences,
        outputNodeType,
        usesNativeMedia,
        installedPlugin.manifest.apiVersion === 2
          && installedPlugin.manifest.requiredCapabilities?.includes('prompt.mentions') === true
          && pluginTool.permissions.includes('prompt.references.read'),
      );
      if (result.effect) {
        if (iteration === MAX_HOST_EFFECTS) throw new Error(`插件宿主操作不能超过 ${MAX_HOST_EFFECTS} 次`);
        reserveToolEffect(effectCounts, result.effect);
        effectResult = await executeHostEffect(
          {
            pluginId: pluginTool.pluginId,
            toolId: pluginTool.tool.id,
            projectId,
            title: pluginTool.tool.title,
            permissions: pluginTool.permissions,
            resources,
            resourceReadContext: resourceReadContext(),
            signal: execution.signal,
          },
          nodeId,
          result.effect,
          models,
        );
        assertExecutionFresh();
        if (trustedMediaReferences && result.effect.type === 'model.generate') {
          addTrustedModelEffectReference(result.effect, effectResult, models, trustedMediaReferences);
        }
        continue;
      }

      const current = assertExecutionFresh();
      const data = result.data ?? {};

      if (pluginTool.tool.output.mode === 'update-current') {
        current.updateNodeData(nodeId, data as Partial<BaseNodeData>);
      } else if (pluginTool.tool.output.mode === 'create-node') {
        const nodeType = pluginTool.tool.output.nodeType ?? sourceNode.data.type;
        const placement = derivedNodePlacement(sourceNode);
        current.addNode({
          id: `node-${generateId()}`,
          type: nodeType,
          ...placement,
          data: {
            label: typeof data.label === 'string'
              ? data.label
              : `${sourceNode.data.label} · ${pluginTool.tool.title}`,
            type: nodeType,
            role: 'source',
            status: 'success',
            ...data,
          } as BaseNodeData,
        });
      } else {
        if (!result.nodeSet) throw new Error('插件没有返回有效节点集');
        const assertFresh = () => {
          assertExecutionFresh();
        };
        const prepared = await preparePluginNodeSet({
          nodeSet: result.nodeSet,
          sourceNode,
          projectId,
          resourceContext: resourceReadContext(),
          assertFresh,
          artifacts: result.artifacts,
          identity: usesNativeMedia ? identity : undefined,
          models,
          resources,
        });
        try {
          if (hostTask && (prepared.videoPreflight.length || !installedPlugin.manifest.requiredCapabilities?.includes('video.replicaPipeline'))) {
            throw new Error('后台素材调用不能提交生成，且必须声明全片任务能力');
          }
          await prepared.assertReferencesFresh();
          assertFresh();
          prepared.assertGenerationModelsFresh();
          if (prepared.videoPreflight.length && useAppStore.getState().videoBatchBusy) throw new Error('已有视频批次正在执行');
          requireCurrentPluginRevision(pluginTool.pluginId, sourceDigest, revisionDigest)
            .addNodesWithEdges(prepared.nodes, prepared.edges);
        } catch (error) {
          await prepared.rollback();
          throw error;
        }
        if (hostTask) return { nodes: prepared.nodes, edges: prepared.edges, nodeIdsByKey: prepared.nodeIdsByKey };
        if (prepared.videoPreflight.length) {
          // Store 会分配 displayId 并按设置补本批参考 @；以其最终节点生成提交指纹。
          const committed = useAppStore.getState();
          const items = prepared.videoPreflight.map((item) => {
            const node = committed.nodes.find((entry) => entry.id === item.nodeId);
            return node ? inspectVideoNode(node, committed) : { ...item, issues: ['生成节点未写入'] };
          });
          pendingVideoBatch = { items, assertModelsFresh: prepared.assertGenerationModelsFresh };
        }
      }
      current.showToast(result.message || `插件工具「${pluginTool.tool.title}」执行完成`);
      return;
    }
    throw new Error(`插件宿主操作不能超过 ${MAX_HOST_EFFECTS} 次`);
  } finally {
    if (mediaWorkspaceAttempted) {
      await invoke<void>('release_plugin_media_workspace', { identity }).catch(() => undefined);
    }
    execution.dispose();
    if (ownsExecutionLease) {
      clearPluginInvocationResources(invocationId);
      completeCanvasDerivation(guard);
    }
    if (pendingVideoBatch) {
      // 画布已提交；新视频归宿主批次管理，不能再用提交前的 revision/界面取消信号守卫。
      dispatchPluginVideoBatch(identity, projectId, pendingVideoBatch);
    }
  }
}

export async function getPythonPluginRuntimeStatus(): Promise<PythonPluginRuntimeStatus> {
  return invoke<PythonPluginRuntimeStatus>('get_python_plugin_runtime_status');
}

/**
 * 供插件自定义界面使用：先按宿主规则校验 effect，再执行。
 *
 * 界面组件跑在主窗口内的 sandboxed iframe 中，传来的 effect 是未经信任的 JSON，所以必须走与
 * 插件返回值完全相同的 parseHostEffect 校验；权限检查留在 executeHostEffect 内部。
 * JavaScript 没有任意网络能力，媒体来源校验对它生效；可信 Python 本身就能联网，
 * 不在此约束范围内——这与直接执行入口的处理保持一致。
 */
export async function executePluginUiHostEffect(options: {
  pluginId: string;
  toolId?: string;
  projectId: string;
  title: string;
  permissions: PluginPermission[];
  nodeId: string;
  effect: unknown;
  models: PluginModelSummary[];
  trustedMediaReferences: Set<string>;
  resources?: PluginInvocationResources;
  resourceReadContext?: PluginResourceReadContext;
  signal?: AbortSignal;
}): Promise<PluginNodeHostEffectResult> {
  const parsed = parseHostEffect(options.effect, options.trustedMediaReferences);
  const result = await executeHostEffect(
    {
      pluginId: options.pluginId,
      toolId: options.toolId,
      projectId: options.projectId,
      title: options.title,
      permissions: options.permissions,
      resources: options.resources,
      resourceReadContext: options.resourceReadContext,
      signal: options.signal,
    },
    options.nodeId,
    parsed,
    options.models,
  );
  if (parsed.type === 'model.generate') {
    addTrustedModelEffectReference(
      parsed,
      result,
      options.models,
      options.trustedMediaReferences,
    );
  }
  return result;
}
