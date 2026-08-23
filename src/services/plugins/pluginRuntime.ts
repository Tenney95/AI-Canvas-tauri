import { invoke } from '@tauri-apps/api/core';
import type { Node } from '@xyflow/react';
import type { BaseNodeData, NodeType } from '../../types';
import type {
  AvailableNodePluginTool,
  InstalledPlugin,
  NodePluginExecutionResult,
  NodePluginInvocationInput,
  PluginJsonValue,
  PluginPlacement,
} from '../../types/plugin';
import { useAppStore } from '../../store/useAppStore';
import { derivedNodePlacement, generateId } from '../../store/store.utils';
import {
  completeCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
} from '../canvasDerivationGuard';

const MAX_STRING_LENGTH = 256_000;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 128;
const MAX_DEPTH = 8;
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
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
    return plugin.manifest.contributes.nodeTools
      .filter((tool) => tool.nodeTypes.includes(nodeType) && tool.placements.includes(placement))
      .map((tool) => ({
        pluginId: plugin.id,
        pluginName: plugin.manifest.name,
        source: plugin.source,
        tool,
      }));
  });
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
