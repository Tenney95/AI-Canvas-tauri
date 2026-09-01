import { invoke } from '@tauri-apps/api/core';
import type { Node } from '@xyflow/react';
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
  PluginJsonValue,
  PluginNodePortType,
  PluginPermission,
  PluginPlacement,
  PluginRuntime,
  PythonPluginRuntimeStatus,
} from '../../types/plugin';
import { useAppStore } from '../../store/useAppStore';
import { derivedNodePlacement, generateId } from '../../store/store.utils';
import {
  completeCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
} from '../canvasDerivationGuard';
import { generateText } from '../ai/generateText';
import { generateImage } from '../ai/generateImage';
import { generateVideo } from '../ai/generateVideo';
import { generateAudio } from '../ai/generateAudio';
import { saveAgentTextOutput } from '../fileService';
import { readPluginGrantedTextFile } from './pluginFileGrantService';
import { buildPluginModelCatalog, collectDeclaredModelCategories } from './pluginModelCatalog';

const MAX_STRING_LENGTH = 256_000;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 128;
const MAX_DEPTH = 8;
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_HOST_EFFECTS = 4;
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

function requireCurrentPluginRevision(pluginId: string, sourceDigest: string) {
  const current = useAppStore.getState();
  requirePluginSourceDigest(current.installedPlugins, pluginId, sourceDigest);
  return current;
}

function createPluginInvocationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${generateId()}-${generateId()}`;
}

function toPluginJson(value: unknown, depth = 0): PluginJsonValue | undefined {
  if (depth > MAX_DEPTH || value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS)
      .map((item) => toPluginJson(item, depth + 1))
      .filter((item): item is PluginJsonValue => item !== undefined);
  }
  if (typeof value === 'object') {
    const output: Record<string, PluginJsonValue> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      if (DANGEROUS_OBJECT_KEYS.has(key)) continue;
      const normalized = toPluginJson(item, depth + 1);
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
    effectResult?: PluginNodeHostEffectResult;
  },
): NodePluginInvocationInput {
  const data: Record<string, PluginJsonValue> = {};
  for (const field of fields) {
    const value = toPluginJson(node.data[field]);
    if (value !== undefined) data[field] = value;
  }
  return {
    projectId,
    iteration: options.iteration,
    parameters,
    node: {
      id: node.id,
      type: node.data.type,
      data,
    },
    models: options.models,
    effectResult: options.effectResult,
  };
}

function validateResult(
  value: unknown,
  allowedFields: string[],
  trustedMediaReferences?: ReadonlySet<string>,
  outputNodeType?: NodeType,
): NodePluginExecutionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件必须返回对象');
  const record = value as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message.slice(0, 240) : undefined;
  // 请求宿主操作时不写入画布；宿主完成后会携带 effectResult 再次调用同一工具。
  if (record.effect !== undefined) {
    return { effect: parseHostEffect(record.effect, trustedMediaReferences), message };
  }
  if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) {
    throw new Error('插件返回值必须包含 data 对象');
  }
  const allowed = new Set(allowedFields);
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
  try {
    const protocol = new URL(slashNormalized).protocol.toLowerCase();
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
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
    if (isRemoteNetworkReference(candidate)) references.add(candidate);
  }
}

function assertTrustedMediaString(value: string, trustedReferences: ReadonlySet<string>): void {
  for (const candidate of mediaReferenceCandidates(value)) {
    if (isUnsafeInlineMediaReference(candidate)) {
      throw new Error('JavaScript 插件返回了不允许的内联媒体类型');
    }
    if (isRemoteNetworkReference(candidate) && !trustedReferences.has(candidate)) {
      throw new Error('JavaScript 插件返回了未经宿主授权的远程媒体引用');
    }
  }
}

function collectNodeToolMediaReferences(input: NodePluginInvocationInput): Set<string> {
  const references = new Set<string>();
  visitNodeMediaStrings(input.node.data, (value) => addTrustedMediaString(references, value), input.node.type);
  return references;
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
  if (type === 'model.generate') {
    const rawImageUrls = Array.isArray(raw.imageUrls) ? raw.imageUrls : [];
    const imageUrls = rawImageUrls.filter((item): item is string => typeof item === 'string');
    if (imageUrls.length !== rawImageUrls.length) {
      throw new Error('模型调用的 imageUrls 必须是字符串数组');
    }
    if (imageUrls.length > MAX_ARRAY_ITEMS) {
      throw new Error(`模型调用的参考图不能超过 ${MAX_ARRAY_ITEMS} 张`);
    }
    if (trustedMediaReferences) {
      for (const url of imageUrls) assertTrustedMediaString(url, trustedMediaReferences);
    }
    const effect: Extract<PluginNodeHostEffect, { type: 'model.generate' }> = {
      type,
      modelId: String(raw.modelId ?? '').slice(0, 256),
      prompt: String(raw.prompt ?? '').slice(0, MAX_STRING_LENGTH),
      parameters: raw.parameters === undefined
        ? undefined
        : toPluginJson(recordValue(raw.parameters)) as Record<string, PluginJsonValue>,
    };
    if (!effect.modelId || !effect.prompt.trim()) throw new Error('模型调用必须包含 modelId 和 prompt');
    if (imageUrls.length > 0) effect.imageUrls = imageUrls;
    return effect;
  }
  if (type === 'file.readText') {
    const effect: Extract<PluginNodeHostEffect, { type: 'file.readText' }> = {
      type,
      grantId: String(raw.grantId ?? '').slice(0, 160),
    };
    if (!effect.grantId) throw new Error('文件读取必须包含 grantId');
    return effect;
  }
  if (type === 'file.saveText') {
    return {
      type,
      content: String(raw.content ?? '').slice(0, MAX_STRING_LENGTH),
      suggestedName: typeof raw.suggestedName === 'string'
        ? raw.suggestedName.slice(0, 120)
        : undefined,
    };
  }
  throw new Error('插件请求了不支持的宿主操作');
}

function connectedInputValue(data: BaseNodeData, type: string): PluginJsonValue | undefined {
  const value = type === 'image'
    ? data.imageUrl ?? data.thumbnailUrl ?? data.output
    : type === 'video'
      ? data.videoUrl ?? data.output
      : type === 'audio'
        ? data.audioUrl ?? data.output
        : type === 'json'
          ? data.pluginOutputs ?? data.output
          : data.output ?? data.prompt;
  return toPluginJson(value);
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
    const portId = edge.targetHandle
      ? pluginHandlePortId(edge.targetHandle, 'plugin-in-')
      : pluginNode.node.inputs[0]?.id;
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
    if (port.required && portValues.length === 0) throw new Error(`缺少必填输入「${port.label}」`);
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
): Promise<PluginJsonValue> {
  const model = models.find((item) => item.id === effect.modelId);
  if (!model) throw new Error('插件请求的模型不在当前可调用列表中');
  const parameters = effect.parameters ?? {};
  const common = { prompt: effect.prompt, model: model.id, provider: model.provider, nodeId };
  if (model.category === 'text') {
    return { text: await generateText({ ...common, imageUrls }) };
  }
  if (model.category === 'image') {
    const result = await generateImage({
      ...common,
      imageSize: stringParameter(parameters, 'imageSize'),
      aspectRatio: stringParameter(parameters, 'aspectRatio'),
      image_urls: imageUrls,
    });
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
    });
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
  });
  return { url: result.url, title: result.title ?? null, lyrics: result.lyrics ?? null };
}

/**
 * 宿主操作的执行上下文。节点工具没有输入端口，因此连线输入是可选的；
 * 缺少连线时参考图只来自插件显式提交并通过来源校验的 imageUrls。
 */
interface PluginHostEffectContext {
  pluginId: string;
  title: string;
  permissions: PluginPermission[];
  pluginNode?: AvailablePluginNode;
  inputs?: Record<string, PluginJsonValue>;
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
  try {
    if (effect.type === 'model.generate') {
      if (!context.permissions.includes('models.invoke')) throw new Error('插件未声明 models.invoke 权限');
      const imageUrls = [
        ...(context.pluginNode && context.inputs
          ? connectedImageValues(context.pluginNode, context.inputs)
          : []),
        ...(effect.imageUrls ?? []),
      ];
      return {
        type: effect.type,
        ok: true,
        value: await executeModelEffect(effect, models, nodeId, imageUrls),
      };
    }
    if (effect.type === 'file.readText') {
      if (!context.permissions.includes('files.read')) throw new Error('插件未声明 files.read 权限');
      const value = await readPluginGrantedTextFile(context.pluginId, nodeId, effect.grantId);
      return { type: effect.type, ok: true, value: toPluginJson(value) };
    }
    if (!context.permissions.includes('files.write')) throw new Error('插件未声明 files.write 权限');
    const value = await saveAgentTextOutput(
      effect.content,
      effect.suggestedName || 'plugin-output.txt',
      `保存「${context.title}」输出`,
    );
    return { type: effect.type, ok: true, value: value ?? { cancelled: true } };
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
  const invocationId = createPluginInvocationId();
  const values = toPluginJson(sourceNode.data.pluginValues) as Record<string, PluginJsonValue> | undefined;
  for (const field of pluginNode.node.fields) {
    const value = values?.[field.id];
    const missing = value === undefined || value === null || value === '' || (field.type === 'boolean' && value !== true);
    if (field.required && missing) throw new Error(`请填写「${field.label}」`);
  }
  const inputs = buildPluginNodeInputs(pluginNode, nodeId);
  const guard = registerCanvasDerivation(before, nodeId);
  if (!guard) throw new Error('无法创建插件执行保护');
  const trustedMediaReferences = pluginNode.runtime === 'javascript'
    ? collectPluginNodeMediaReferences(pluginNode, inputs)
    : undefined;
  let effectResult: PluginNodeHostEffectResult | undefined;

  try {
    for (let iteration = 0; iteration <= MAX_HOST_EFFECTS; iteration += 1) {
      requireCurrentPluginRevision(pluginNode.pluginId, sourceDigest);
      const input: PluginNodeInvocationInput = {
        projectId,
        iteration,
        node: { id: nodeId, values: values ?? {} },
        inputs,
        models: pluginNode.permissions.includes('models.read') ? models : [],
        effectResult,
      };
      const rawResult = await invoke<unknown>('execute_node_plugin_tool', {
        pluginId: pluginNode.pluginId,
        sourceDigest,
        toolId: pluginNode.node.id,
        invocationId,
        input,
      });
      requireCurrentPluginRevision(pluginNode.pluginId, sourceDigest);
      const result = validatePluginNodeResult(rawResult, pluginNode, trustedMediaReferences);
      if (result.effect) {
        if (iteration === MAX_HOST_EFFECTS) throw new Error(`插件宿主操作不能超过 ${MAX_HOST_EFFECTS} 次`);
        effectResult = await executeHostEffect(
          {
            pluginId: pluginNode.pluginId,
            title: pluginNode.node.title,
            permissions: pluginNode.permissions,
            pluginNode,
            inputs,
          },
          nodeId,
          result.effect,
          models,
        );
        requireCurrentPluginRevision(pluginNode.pluginId, sourceDigest);
        if (trustedMediaReferences && result.effect.type === 'model.generate') {
          addTrustedModelEffectReference(result.effect, effectResult, models, trustedMediaReferences);
        }
        continue;
      }

      const current = requireCurrentPluginRevision(pluginNode.pluginId, sourceDigest);
      if (!isCanvasDerivationFresh(guard, current)) throw new Error('画布已变化，插件结果未写入');
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
    completeCanvasDerivation(guard);
  }
}

export async function executeNodePluginTool(
  pluginTool: AvailableNodePluginTool,
  nodeId: string,
  parameters: Record<string, PluginJsonValue> = {},
): Promise<void> {
  const before = useAppStore.getState();
  const projectId = before.currentProjectId;
  const sourceNode = before.nodes.find((node) => node.id === nodeId);
  if (!projectId || !sourceNode) throw new Error('目标节点或项目不存在');
  const sourceDigest = requirePluginSourceDigest(
    before.installedPlugins,
    pluginTool.pluginId,
    pluginTool.sourceDigest,
  );
  const invocationId = createPluginInvocationId();
  const guard = registerCanvasDerivation(before, nodeId);
  if (!guard) throw new Error('无法创建插件执行保护');
  const normalizedParameters: Record<string, PluginJsonValue> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (DANGEROUS_OBJECT_KEYS.has(key)) continue;
    const normalized = toPluginJson(value);
    if (normalized !== undefined) normalizedParameters[key] = normalized;
  }
  const models = buildNodeToolModelCatalog(pluginTool);
  // JavaScript 沙箱没有任意网络能力，媒体引用只能来自本次输入与本轮宿主模型结果。
  // 该集合跨 effect 轮次累积，让后续轮次可以引用前面模型生成的媒体。
  const trustedMediaReferences = pluginTool.runtime === 'javascript' ? new Set<string>() : undefined;
  let effectResult: PluginNodeHostEffectResult | undefined;

  try {
    for (let iteration = 0; iteration <= MAX_HOST_EFFECTS; iteration += 1) {
      requireCurrentPluginRevision(pluginTool.pluginId, sourceDigest);
      const input = buildInvocationInput(
        projectId,
        sourceNode,
        pluginTool.tool.inputFields,
        normalizedParameters,
        { iteration, models, effectResult },
      );
      if (trustedMediaReferences) {
        for (const reference of collectNodeToolMediaReferences(input)) {
          trustedMediaReferences.add(reference);
        }
      }
      const rawResult = await invoke<unknown>('execute_node_plugin_tool', {
        pluginId: pluginTool.pluginId,
        sourceDigest,
        toolId: pluginTool.tool.id,
        invocationId,
        input,
      });
      requireCurrentPluginRevision(pluginTool.pluginId, sourceDigest);
      const outputNodeType = pluginTool.tool.output.mode === 'create-node'
        ? pluginTool.tool.output.nodeType ?? sourceNode.data.type
        : sourceNode.data.type;
      const result = validateResult(
        rawResult,
        pluginTool.tool.output.fields,
        trustedMediaReferences,
        outputNodeType,
      );
      if (result.effect) {
        if (iteration === MAX_HOST_EFFECTS) throw new Error(`插件宿主操作不能超过 ${MAX_HOST_EFFECTS} 次`);
        effectResult = await executeHostEffect(
          {
            pluginId: pluginTool.pluginId,
            title: pluginTool.tool.title,
            permissions: pluginTool.permissions,
          },
          nodeId,
          result.effect,
          models,
        );
        requireCurrentPluginRevision(pluginTool.pluginId, sourceDigest);
        if (trustedMediaReferences && result.effect.type === 'model.generate') {
          addTrustedModelEffectReference(result.effect, effectResult, models, trustedMediaReferences);
        }
        continue;
      }

      const current = requireCurrentPluginRevision(pluginTool.pluginId, sourceDigest);
      if (!isCanvasDerivationFresh(guard, current)) throw new Error('画布已变化，插件结果未写入');
      const data = result.data ?? {};

      if (pluginTool.tool.output.mode === 'update-current') {
        current.updateNodeData(nodeId, data as Partial<BaseNodeData>);
      } else {
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
      }
      current.showToast(result.message || `插件工具「${pluginTool.tool.title}」执行完成`);
      return;
    }
    throw new Error(`插件宿主操作不能超过 ${MAX_HOST_EFFECTS} 次`);
  } finally {
    completeCanvasDerivation(guard);
  }
}

export async function getPythonPluginRuntimeStatus(): Promise<PythonPluginRuntimeStatus> {
  return invoke<PythonPluginRuntimeStatus>('get_python_plugin_runtime_status');
}

/**
 * 供插件自定义界面使用：先按宿主规则校验 effect，再执行。
 *
 * 界面组件跑在独立 webview 进程里，传来的 effect 是未经信任的 JSON，所以必须走与
 * 插件返回值完全相同的 parseHostEffect 校验；权限检查留在 executeHostEffect 内部。
 * JavaScript 没有任意网络能力，媒体来源校验对它生效；可信 Python 本身就能联网，
 * 不在此约束范围内——这与直接执行入口的处理保持一致。
 */
export async function executePluginUiHostEffect(options: {
  pluginId: string;
  title: string;
  permissions: PluginPermission[];
  runtime: PluginRuntime;
  nodeId: string;
  effect: unknown;
  models: PluginModelSummary[];
  trustedMediaReferences?: ReadonlySet<string>;
}): Promise<PluginNodeHostEffectResult> {
  const trusted = options.runtime === 'javascript'
    ? options.trustedMediaReferences
    : undefined;
  const parsed = parseHostEffect(options.effect, trusted);
  return executeHostEffect(
    {
      pluginId: options.pluginId,
      title: options.title,
      permissions: options.permissions,
    },
    options.nodeId,
    parsed,
    options.models,
  );
}
