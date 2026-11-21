/**
 * pluginRuntimeContract — 校验插件调用输入、节点输出、媒体引用与宿主操作声明。
 */
import { isLocalMediaUrl as isLocalMediaReference, isRemoteMediaUrl } from '../../utils/mediaUrl';
import { getLocale } from '../../i18n';
import type { Node } from '@xyflow/react';
import type { BaseNodeData, NodeType } from '../../types';
import type {
  AvailablePluginNode,
  NodePluginExecutionResult,
  NodePluginInvocationInput,
  PluginModelSummary,
  PluginNodeExecutionResult,
  PluginNodeHostEffect,
  PluginNodeHostEffectResult,
  PluginNodeSetData,
  PluginNodeToolOutputManifest,
  PluginJsonValue,
  PluginNodePortType,
  PluginInvocationResources,
  PluginImageRepresentation,
  PluginNativeMediaArtifactRef,
  PluginNodeSetVideoGeneration,
  PluginVideoGenerationParameters,
  PluginVideoReplicaStart,
} from '../../types/plugin';

const MAX_STRING_LENGTH = 256_000;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 128;
const MAX_DEPTH = 8;
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
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

export function toPluginJson(
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

export function normalizePluginToolParameters(parameters: Record<string, PluginJsonValue>): Record<string, PluginJsonValue> {
  const normalizedParameters: Record<string, PluginJsonValue> = {};
  const parameterEntries = Object.entries(parameters);
  if (parameterEntries.length > MAX_OBJECT_KEYS) throw new Error(`插件数据对象不能超过 ${MAX_OBJECT_KEYS} 个键`);
  for (const [key, value] of parameterEntries) {
    if (DANGEROUS_OBJECT_KEYS.has(key)) continue;
    const normalized = toPluginJson(value);
    if (normalized !== undefined) normalizedParameters[key] = normalized;
  }
  return normalizedParameters;
}

export function buildInvocationInput(
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

export function validateResult(
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

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
    visitMediaStrings(recordValue(recordValue(row).video).url, visitor);
  }
  for (const reference of Array.isArray(data.videoReferences) ? data.videoReferences : []) {
    visitMediaStrings(recordValue(reference).url, visitor);
  }
}

/** 插件可改镜头文本，成片绑定仅保留宿主已有稳定行的真实记录。 */
export function preserveHostShotVideos(
  data: Record<string, PluginJsonValue>,
  previousRows: BaseNodeData['shotlistRows'] = [],
): Record<string, PluginJsonValue> {
  if (!Array.isArray(data.shotlistRows)) return data;
  const existing = new Map(previousRows.map((row) => [row.id, row.video]));
  return { ...data, shotlistRows: data.shotlistRows.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { video: _video, ...row } = value;
    const retained = typeof row.id === 'string' ? toPluginJson(existing.get(row.id)) : undefined;
    return retained === undefined ? row : { ...row, video: retained };
  }) };
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

export function collectNodeToolMediaReferences(input: NodePluginInvocationInput): Set<string> {
  return collectTrustedNodeMediaReferences(input.node.type, input.node.data);
}

export function collectPluginNodeMediaReferences(
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

export function addTrustedModelEffectReference(
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
export function parseHostEffect(
  rawEffect: unknown,
  trustedMediaReferences?: ReadonlySet<string>,
): PluginNodeHostEffect {
  const raw = recordValue(rawEffect);
  const type = raw.type;
  if (type === 'video.replicaJob.status' || type === 'video.replicaJob.cancel' || type === 'video.replicaJob.restart') {
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
  if (type === 'resource.readRange' || type === 'video.readPlayback') {
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
  if (type === 'video.preparePlayback') {
    if (Object.keys(raw).some((key) => !['type', 'resourceId'].includes(key))
      || typeof raw.resourceId !== 'string' || !raw.resourceId || raw.resourceId.length > 160) {
      throw new Error('连续预览只接受有效视频资源句柄');
    }
    return { type, resourceId: raw.resourceId };
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
export function parsePluginVideoReplicaEffect(value: unknown): Extract<PluginNodeHostEffect, { type: 'video.replicaJob.start' | 'video.replicaJob.status' | 'video.replicaJob.cancel' | 'video.replicaJob.restart' }> {
  const effect = parseHostEffect(value);
  if (effect.type !== 'video.replicaJob.start' && effect.type !== 'video.replicaJob.status' && effect.type !== 'video.replicaJob.cancel' && effect.type !== 'video.replicaJob.restart') {
    throw new Error('复刻任务操作无效');
  }
  return effect;
}

export function validatePluginNodeResult(
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
