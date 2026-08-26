import { invoke } from '@tauri-apps/api/core';
import type { Node } from '@xyflow/react';
import type { BaseNodeData, NodeType } from '../../types';
import type {
  AvailablePluginNode,
  AvailableNodePluginTool,
  InstalledPlugin,
  NodePluginExecutionResult,
  NodePluginInvocationInput,
  PluginModelSummary,
  PluginNodeExecutionResult,
  PluginNodeHostEffect,
  PluginNodeHostEffectResult,
  PluginNodeInvocationInput,
  PluginJsonValue,
  PluginPlacement,
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

const MAX_STRING_LENGTH = 256_000;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 128;
const MAX_DEPTH = 8;
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_HOST_EFFECTS = 4;
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
        runtime: plugin.manifest.runtime ?? 'javascript',
        source: plugin.source,
        tool,
      }));
  });
}

export function getAvailablePluginNodes(plugins: InstalledPlugin[]): AvailablePluginNode[] {
  return plugins.flatMap((plugin) => {
    if (!plugin.enabled) return [];
    return (plugin.manifest.contributes.nodes ?? []).map((node) => ({
      pluginId: plugin.id,
      pluginName: plugin.manifest.name,
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
): NodePluginInvocationInput {
  const data: Record<string, PluginJsonValue> = {};
  for (const field of fields) {
    const value = toPluginJson(node.data[field]);
    if (value !== undefined) data[field] = value;
  }
  return {
    projectId,
    parameters,
    node: {
      id: node.id,
      type: node.data.type,
      data,
    },
  };
}

function validateResult(value: unknown, allowedFields: string[]): NodePluginExecutionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件必须返回对象');
  const record = value as Record<string, unknown>;
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
  return {
    data,
    message: typeof record.message === 'string' ? record.message.slice(0, 240) : undefined,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

function buildPluginNodeInputs(pluginNode: AvailablePluginNode, nodeId: string): Record<string, PluginJsonValue> {
  const state = useAppStore.getState();
  const values: Record<string, PluginJsonValue[]> = {};
  for (const edge of state.edges.filter((item) => item.target === nodeId)) {
    const portId = edge.targetHandle?.replace(/^plugin-in-/, '') || pluginNode.node.inputs[0]?.id;
    const port = pluginNode.node.inputs.find((item) => item.id === portId);
    const source = state.nodes.find((item) => item.id === edge.source);
    if (!port || !source) continue;
    const value = connectedInputValue(source.data, port.type);
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

function validatePluginNodeResult(value: unknown, pluginNode: AvailablePluginNode): PluginNodeExecutionResult {
  const result = recordValue(value);
  const message = typeof result.message === 'string' ? result.message.slice(0, 240) : undefined;
  let effect: PluginNodeHostEffect | undefined;
  if (result.effect !== undefined) {
    const rawEffect = recordValue(result.effect);
    const type = rawEffect.type;
    if (type === 'model.generate') {
      effect = {
        type,
        modelId: String(rawEffect.modelId ?? '').slice(0, 256),
        prompt: String(rawEffect.prompt ?? '').slice(0, MAX_STRING_LENGTH),
        parameters: rawEffect.parameters === undefined
          ? undefined
          : toPluginJson(recordValue(rawEffect.parameters)) as Record<string, PluginJsonValue>,
      };
      if (!effect.modelId || !effect.prompt.trim()) throw new Error('模型调用必须包含 modelId 和 prompt');
    } else if (type === 'file.readText') {
      effect = { type, grantId: String(rawEffect.grantId ?? '').slice(0, 160) };
      if (!effect.grantId) throw new Error('文件读取必须包含 grantId');
    } else if (type === 'file.saveText') {
      effect = {
        type,
        content: String(rawEffect.content ?? '').slice(0, MAX_STRING_LENGTH),
        suggestedName: typeof rawEffect.suggestedName === 'string'
          ? rawEffect.suggestedName.slice(0, 120)
          : undefined,
      };
    } else {
      throw new Error('插件请求了不支持的宿主操作');
    }
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
      if (normalized !== undefined) outputs[key] = normalized;
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
  pluginNode: AvailablePluginNode,
  inputs: Record<string, PluginJsonValue>,
): Promise<PluginJsonValue> {
  const model = models.find((item) => item.id === effect.modelId);
  if (!model) throw new Error('插件请求的模型不在当前可调用列表中');
  const parameters = effect.parameters ?? {};
  const common = { prompt: effect.prompt, model: model.id, provider: model.provider, nodeId };
  const connectedValues = (type: string): string[] => pluginNode.node.inputs
    .filter((port) => port.type === type)
    .flatMap((port) => {
      const value = inputs[port.id];
      return (Array.isArray(value) ? value : [value])
        .filter((item): item is string => typeof item === 'string');
    });
  if (model.category === 'text') {
    return { text: await generateText({ ...common, imageUrls: connectedValues('image') }) };
  }
  if (model.category === 'image') {
    const result = await generateImage({
      ...common,
      imageSize: stringParameter(parameters, 'imageSize'),
      aspectRatio: stringParameter(parameters, 'aspectRatio'),
      image_urls: connectedValues('image'),
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

async function executeHostEffect(
  pluginNode: AvailablePluginNode,
  nodeId: string,
  effect: PluginNodeHostEffect,
  models: PluginModelSummary[],
  inputs: Record<string, PluginJsonValue>,
): Promise<PluginNodeHostEffectResult> {
  try {
    if (effect.type === 'model.generate') {
      if (!pluginNode.permissions.includes('models.invoke')) throw new Error('插件未声明 models.invoke 权限');
      return {
        type: effect.type,
        ok: true,
        value: await executeModelEffect(effect, models, nodeId, pluginNode, inputs),
      };
    }
    if (effect.type === 'file.readText') {
      if (!pluginNode.permissions.includes('files.read')) throw new Error('插件未声明 files.read 权限');
      const value = await readPluginGrantedTextFile(pluginNode.pluginId, nodeId, effect.grantId);
      return { type: effect.type, ok: true, value: toPluginJson(value) };
    }
    if (!pluginNode.permissions.includes('files.write')) throw new Error('插件未声明 files.write 权限');
    const value = await saveAgentTextOutput(
      effect.content,
      effect.suggestedName || 'plugin-output.txt',
      `保存「${pluginNode.node.title}」输出`,
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
  const guard = registerCanvasDerivation(before, nodeId);
  if (!guard) throw new Error('无法创建插件执行保护');
  const values = toPluginJson(sourceNode.data.pluginValues) as Record<string, PluginJsonValue> | undefined;
  for (const field of pluginNode.node.fields) {
    const value = values?.[field.id];
    const missing = value === undefined || value === null || value === '' || (field.type === 'boolean' && value !== true);
    if (field.required && missing) throw new Error(`请填写「${field.label}」`);
  }
  const inputs = buildPluginNodeInputs(pluginNode, nodeId);
  let effectResult: PluginNodeHostEffectResult | undefined;

  try {
    for (let iteration = 0; iteration <= MAX_HOST_EFFECTS; iteration += 1) {
      const input: PluginNodeInvocationInput = {
        projectId,
        iteration,
        node: { id: nodeId, values: values ?? {} },
        inputs,
        models: pluginNode.permissions.includes('models.read') ? models : [],
        effectResult,
      };
      const rawResult = await invoke<unknown>('execute_node_plugin_tool', {
        runtime: pluginNode.runtime,
        source: pluginNode.source,
        toolId: pluginNode.node.id,
        input,
      });
      const result = validatePluginNodeResult(rawResult, pluginNode);
      if (result.effect) {
        if (iteration === MAX_HOST_EFFECTS) throw new Error(`插件宿主操作不能超过 ${MAX_HOST_EFFECTS} 次`);
        effectResult = await executeHostEffect(pluginNode, nodeId, result.effect, models, inputs);
        continue;
      }

      const current = useAppStore.getState();
      const installed = current.installedPlugins.find((plugin) => plugin.id === pluginNode.pluginId);
      if (!installed?.enabled) throw new Error('插件已被禁用或卸载');
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
  const guard = registerCanvasDerivation(before, nodeId);
  if (!guard) throw new Error('无法创建插件执行保护');
  const normalizedParameters: Record<string, PluginJsonValue> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (DANGEROUS_OBJECT_KEYS.has(key)) continue;
    const normalized = toPluginJson(value);
    if (normalized !== undefined) normalizedParameters[key] = normalized;
  }
  const input = buildInvocationInput(
    projectId,
    sourceNode,
    pluginTool.tool.inputFields,
    normalizedParameters,
  );

  try {
    const rawResult = await invoke<unknown>('execute_node_plugin_tool', {
      runtime: pluginTool.runtime,
      source: pluginTool.source,
      toolId: pluginTool.tool.id,
      input,
    });
    const result = validateResult(rawResult, pluginTool.tool.output.fields);
    const current = useAppStore.getState();
    const currentPlugin = current.installedPlugins.find((plugin) => plugin.id === pluginTool.pluginId);
    if (!currentPlugin?.enabled) throw new Error('插件已被禁用或卸载');
    if (!isCanvasDerivationFresh(guard, current)) throw new Error('画布已变化，插件结果未写入');

    if (pluginTool.tool.output.mode === 'update-current') {
      current.updateNodeData(nodeId, result.data as Partial<BaseNodeData>);
    } else {
      const nodeType = pluginTool.tool.output.nodeType ?? sourceNode.data.type;
      const placement = derivedNodePlacement(sourceNode);
      current.addNode({
        id: `node-${generateId()}`,
        type: nodeType,
        ...placement,
        data: {
          label: typeof result.data.label === 'string'
            ? result.data.label
            : `${sourceNode.data.label} · ${pluginTool.tool.title}`,
          type: nodeType,
          role: 'source',
          status: 'success',
          ...result.data,
        } as BaseNodeData,
      });
    }
    current.showToast(result.message || `插件工具「${pluginTool.tool.title}」执行完成`);
  } finally {
    completeCanvasDerivation(guard);
  }
}

export async function getPythonPluginRuntimeStatus(): Promise<PythonPluginRuntimeStatus> {
  return invoke<PythonPluginRuntimeStatus>('get_python_plugin_runtime_status');
}
