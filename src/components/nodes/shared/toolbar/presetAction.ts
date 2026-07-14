/**
 * presetAction.ts — 快捷指令/预设按钮的查找与点击处理
 */
import type { NodeType, UserPreset, BaseNodeData, GeneralModelCategory, ImagePostProcess } from '../../../../types';
import { CATEGORY_TO_NODE_TYPES } from '../../../../types';
import type { Node, Edge } from '@xyflow/react';
import { getSlashCommands, fillTemplate } from '../slashCommands';
import { generateId, useAppStore } from '../../../../store/useAppStore';
import { defaultModelGroups } from '../defaultModels';

/** 从 localStorage 读取模型偏好（与 ModelSelector 逻辑一致） */
const MODEL_PREF_KEY = 'canvas-model-prefs';
function loadModelPrefs(): Record<string, string> {
  try {
    const raw = localStorage.getItem(MODEL_PREF_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

/** 获取有效模型：节点 data → localStorage → config generalModels → undefined */
function resolveEffectiveModel(nodeType: string, nodeData?: BaseNodeData): { model: string; provider: string } | null {
  // 1) 节点数据
  if (nodeData?.model && nodeData?.provider) {
    return { model: nodeData.model, provider: nodeData.provider };
  }
  // 2) localStorage 偏好
  const prefs = loadModelPrefs();
  if (prefs[nodeType]) {
    // 从 defaultModelGroups 查找 provider
    for (const group of defaultModelGroups) {
      const m = group.models.find((m) => m.value === prefs[nodeType] && m.nodeTypes.includes(nodeType as NodeType));
      if (m) return { model: m.value, provider: m.provider };
    }
  }
  // 3) config generalModels
  const store = useAppStore.getState();
  const generalModels = store.config?.generalModels || [];
  const matched = generalModels.find((gm) =>
    CATEGORY_TO_NODE_TYPES[gm.category as GeneralModelCategory]?.includes(nodeType as NodeType),
  );
  if (matched) return { model: matched.modelId, provider: matched.category };
  return null;
}

export interface ResolvedPreset {
  label: string;
  icon: string;
  filledPrompt: string;
  shouldTrigger: boolean;
  postProcess?: ImagePostProcess;
  override?: {
    model?: string;
    provider?: string;
    imageSize?: string;
    aspectRatio?: string;
  };
}

/**
 * 根据 key 返回快捷指令/预设的显示信息（标签 + 图标），不做 prompt 填充
 */
export function resolvePresetDef(
  key: string,
  nodeType: NodeType,
  userPresets: UserPreset[],
): { label: string; icon: string } | null {
  const commands = getSlashCommands(nodeType);
  const walk = (items: typeof commands): { id: string; title: string; icon: string } | null => {
    for (const item of items) {
      if (item.id === key) return { id: item.id, title: item.title, icon: item.icon };
      if (item.children) {
        const found = walk(item.children);
        if (found) return found;
      }
    }
    return null;
  };
  const builtin = walk(commands);
  if (builtin) return { label: builtin.title, icon: builtin.icon };

  const preset = userPresets.find((p) => p.id === key && p.nodeType === nodeType);
  if (preset) return { label: preset.name, icon: preset.icon || 'mdi:star' };

  return null;
}

/**
 * 根据 key 查找内置快捷指令或用户预设，返回填充后的 prompt
 */
export function resolvePresetAction(
  key: string,
  nodeType: NodeType,
  currentPrompt: string,
  userPresets: UserPreset[],
): ResolvedPreset | null {
  const commands = getSlashCommands(nodeType);
  const allFlat: { id: string; title: string; icon: string; promptTemplate: string; imageSize?: string; aspectRatio?: string; postProcess?: ImagePostProcess }[] = [];
  const walk = (items: typeof commands) => {
    for (const item of items) {
      if (item.promptTemplate) {
        allFlat.push(item as typeof allFlat[number]);
      }
      if (item.children) walk(item.children);
    }
  };
  walk(commands);
  const builtin = allFlat.find((c) => c.id === key);
  if (builtin) {
    return {
      label: builtin.title,
      icon: builtin.icon,
      filledPrompt: fillTemplate(builtin.promptTemplate!, currentPrompt),
      shouldTrigger: true,
      postProcess: builtin.postProcess,
      override: builtin.imageSize || builtin.aspectRatio ? {
        imageSize: builtin.imageSize,
        aspectRatio: builtin.aspectRatio,
      } : undefined,
    };
  }

  const preset = userPresets.find((p) => p.id === key && p.nodeType === nodeType);
  if (preset) {
    const filled = fillTemplate(preset.promptTemplate, currentPrompt);
    return {
      label: preset.name,
      icon: preset.icon || 'mdi:star',
      filledPrompt: preset.triggerMode === 'direct' ? filled : (currentPrompt ? `${currentPrompt}\n${filled}` : filled),
      shouldTrigger: preset.triggerMode === 'direct',
      override: {
        model: preset.model,
        provider: preset.provider,
        imageSize: preset.imageSize,
        aspectRatio: preset.aspectRatio,
      },
    };
  }

  return null;
}

// ── 默认尺寸 ──
const DEFAULT_DIMENSIONS: Record<string, { width: number; height: number }> = {
  'ai-image':    { width: 280, height: 158 },
  'ai-video':    { width: 280, height: 160 },
  'ai-text':     { width: 280, height: 160 },
  'ai-audio':    { width: 260, height: 140 },
  'ai-panorama': { width: 280, height: 158 },
};

/** 根据 aspectRatio 计算节点尺寸（与 AINodeDialog onChangeAspectRatio 一致） */
function computeDimensionsFromAspectRatio(
  aspectRatio: string | undefined,
  nodeType: string,
): { nodeWidth: number; nodeHeight: number } {
  const fallback = DEFAULT_DIMENSIONS[nodeType] ?? { width: 280, height: 158 };
  if (!aspectRatio) return { nodeWidth: fallback.width, nodeHeight: fallback.height };

  const parts = aspectRatio.split(':');
  if (parts.length !== 2) return { nodeWidth: fallback.width, nodeHeight: fallback.height };
  const w = Number(parts[0]);
  const h = Number(parts[1]);
  if (!w || !h) return { nodeWidth: fallback.width, nodeHeight: fallback.height };

  const maxDimension = 280;
  if (w >= h) {
    return { nodeWidth: maxDimension, nodeHeight: Math.max(120, Math.round(maxDimension * (h / w))) };
  }
  return { nodeHeight: maxDimension, nodeWidth: Math.max(160, Math.round(maxDimension * (w / h))) };
}

/**
 * 为快捷指令创建新节点 + 连线（用于 Toolbar 触发生成到新节点）
 * - role 固定为 generator（不继承 source 角色）
 * - prompt 中注入 @{sourceId:label} 引用源节点
 * - 返回 { node, edge }，调用方用 addNodeWithEdge 一次性加入
 */
export function createPresetNode(
  sourceNode: { id: string; position: { x: number; y: number }; data: BaseNodeData },
  resolved: ResolvedPreset,
): { node: Node<BaseNodeData>; edge: Edge } {
  const nodeType = sourceNode.data.type;
  const { nodeWidth, nodeHeight } = computeDimensionsFromAspectRatio(resolved.override?.aspectRatio, nodeType);

  const sourceLabel = sourceNode.data.label || sourceNode.data.fileName || sourceNode.id;
  const mentionRef = `@{${sourceNode.id}:${sourceLabel}}`;
  const promptWithMention = `${mentionRef}\n${resolved.filledPrompt}`;

  const newNodeId = generateId();

  // 回退读取模型：节点 data → localStorage 偏好 → config generalModels
  const effectiveModel = resolveEffectiveModel(nodeType, sourceNode.data);

  // 不 spread sourceNode.data — 不继承 role / output / 媒体文件等
  const newData: BaseNodeData = {
    type: nodeType as NodeType,
    label: resolved.label,
    prompt: promptWithMention,
    role: 'generator',
    status: 'idle',
    model: (resolved.override?.model || effectiveModel?.model || sourceNode.data.model) as string,
    provider: (resolved.override?.provider || effectiveModel?.provider || sourceNode.data.provider) as string,
    imageSize: resolved.override?.imageSize ?? sourceNode.data.imageSize,
    aspectRatio: resolved.override?.aspectRatio ?? sourceNode.data.aspectRatio,
    nodeWidth,
    nodeHeight,
  };

  const node: Node<BaseNodeData> = {
    id: newNodeId,
    type: nodeType,
    position: {
      x: sourceNode.position.x + (sourceNode.data.nodeWidth as number || 280) + 60,
      y: sourceNode.position.y,
    },
    data: newData,
  };

  const edge: Edge = {
    id: generateId(),
    source: sourceNode.id,
    target: newNodeId,
    sourceHandle: 'right',
    targetHandle: 'left',
  };

  return { node, edge };
}
