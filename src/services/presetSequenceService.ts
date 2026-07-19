import type { Edge, Node } from '@xyflow/react';
import type {
  BaseNodeData,
  NodeType,
  PresetNodeType,
  PresetParameterValue,
  UserPreset,
} from '../types';
import { generateId } from '../store/store.utils';
import { useAppStore } from '../store/useAppStore';
import { executeGeneration } from './generationService';
import {
  renderPresetTemplate,
  validatePresetAdvancedConfig,
  validatePresetParameterValues,
  type PresetParameterValues,
} from './presetTemplateService';

const DEFAULT_DIMENSIONS: Record<PresetNodeType, { width: number; height: number }> = {
  'ai-text': { width: 280, height: 160 },
  'ai-image': { width: 280, height: 158 },
  'ai-video': { width: 280, height: 160 },
  'ai-audio': { width: 260, height: 140 },
};

const HORIZONTAL_GAP = 80;

export interface PresetSequencePlan {
  nodes: Node<BaseNodeData>[];
  edges: Edge[];
}

export interface PresetSequenceRunResult {
  success: boolean;
  completedSteps: number;
  failedStepIndex?: number;
  message?: string;
}

interface BuildPresetSequencePlanOptions {
  preset: UserPreset;
  sourceNode: Node<BaseNodeData>;
  values: PresetParameterValues;
}

interface RunPresetSequenceOptions {
  preset: UserPreset;
  sourceNodeId: string;
  values: Record<string, PresetParameterValue>;
}

export function isAdvancedPreset(preset: UserPreset | undefined): boolean {
  return preset?.mode === 'advanced' && !!preset.advanced;
}

export function requestPresetSequence(
  presetId: string,
  nodeType: NodeType,
  sourceNodeId: string,
  presets: UserPreset[],
): boolean {
  const preset = presets.find((item) => item.id === presetId && item.nodeType === nodeType);
  if (!isAdvancedPreset(preset)) return false;
  useAppStore.getState().setPresetRunRequest({ presetId, sourceNodeId });
  return true;
}

function computeNodeDimensions(
  nodeType: PresetNodeType,
  aspectRatio?: string,
): { nodeWidth: number; nodeHeight: number } {
  const fallback = DEFAULT_DIMENSIONS[nodeType];
  if (!aspectRatio) return { nodeWidth: fallback.width, nodeHeight: fallback.height };

  const [widthPart, heightPart] = aspectRatio.split(':');
  const width = Number(widthPart);
  const height = Number(heightPart);
  if (!width || !height) return { nodeWidth: fallback.width, nodeHeight: fallback.height };

  const maxDimension = 280;
  if (width >= height) {
    return {
      nodeWidth: maxDimension,
      nodeHeight: Math.max(120, Math.round(maxDimension * (height / width))),
    };
  }
  return {
    nodeWidth: Math.max(160, Math.round(maxDimension * (width / height))),
    nodeHeight: maxDimension,
  };
}

export function buildPresetSequencePlan({
  preset,
  sourceNode,
  values,
}: BuildPresetSequencePlanOptions): PresetSequencePlan {
  if (!isAdvancedPreset(preset) || !preset.advanced) {
    throw new Error('快捷指令不是有效的高级指令');
  }

  const nodes: Node<BaseNodeData>[] = [];
  const edges: Edge[] = [];
  const currentPrompt = String(sourceNode.data.prompt ?? '');
  let previousNode = sourceNode;
  let nextX = sourceNode.position.x
    + (Number(sourceNode.data.nodeWidth) || DEFAULT_DIMENSIONS[preset.nodeType].width)
    + HORIZONTAL_GAP;

  for (const step of preset.advanced.steps) {
    const nodeId = 'node-' + generateId();
    const label = step.name.trim();
    const previousLabel = previousNode.data.label || previousNode.data.fileName || previousNode.id;
    const mention = '@{' + previousNode.id + ':' + previousLabel + '}';
    const renderedTemplate = renderPresetTemplate(step.promptTemplate, values, currentPrompt).trim();
    const prompt = mention + '\n' + renderedTemplate;
    const dimensions = computeNodeDimensions(step.nodeType, step.aspectRatio);
    const canInheritModel = previousNode.data.type === step.nodeType;

    const data: BaseNodeData = {
      type: step.nodeType,
      label,
      prompt,
      role: 'generator',
      status: 'idle',
      model: step.model || (canInheritModel ? previousNode.data.model : undefined),
      provider: step.provider || (canInheritModel ? previousNode.data.provider : undefined),
      imageSize: step.imageSize || (canInheritModel ? previousNode.data.imageSize : undefined),
      aspectRatio: step.aspectRatio || (canInheritModel ? previousNode.data.aspectRatio : undefined),
      ...dimensions,
    };
    const node: Node<BaseNodeData> = {
      id: nodeId,
      type: step.nodeType,
      position: { x: nextX, y: sourceNode.position.y },
      data,
    };
    nodes.push(node);
    edges.push({
      id: 'edge-' + generateId(),
      source: previousNode.id,
      target: nodeId,
      sourceHandle: 'right',
      targetHandle: 'left',
    });

    nextX += dimensions.nodeWidth + HORIZONTAL_GAP;
    previousNode = node;
  }

  return { nodes, edges };
}

export async function runPresetSequence({
  preset,
  sourceNodeId,
  values,
}: RunPresetSequenceOptions): Promise<PresetSequenceRunResult> {
  const initialStore = useAppStore.getState();
  const sourceNode = initialStore.nodes.find((node) => node.id === sourceNodeId) as Node<BaseNodeData> | undefined;
  if (!sourceNode) return { success: false, completedSteps: 0, message: '触发节点不存在' };
  if (!isAdvancedPreset(preset) || !preset.advanced) {
    return { success: false, completedSteps: 0, message: '高级快捷指令配置无效' };
  }

  const configErrors = validatePresetAdvancedConfig(preset.advanced);
  const valueErrors = validatePresetParameterValues(preset.advanced.parameters, values);
  const firstError = [...configErrors, ...valueErrors][0];
  if (firstError) return { success: false, completedSteps: 0, message: firstError };

  const projectId = initialStore.currentProjectId;
  const plan = buildPresetSequencePlan({ preset, sourceNode, values });
  initialStore.addNodesWithEdges(plan.nodes, plan.edges);
  initialStore.showToast('已启动“' + preset.name + '”，共 ' + plan.nodes.length + ' 个步骤');

  for (const [index, node] of plan.nodes.entries()) {
    const liveStore = useAppStore.getState();
    if (
      liveStore.currentProjectId !== projectId
      || !liveStore.nodes.some((item) => item.id === node.id)
    ) {
      return {
        success: false,
        completedSteps: index,
        failedStepIndex: index,
        message: '项目已切换或执行节点已被移除',
      };
    }

    const result = await executeGeneration(node.id);
    if (!result.success) {
      const message = result.message || '步骤 ' + (index + 1) + ' 执行失败';
      useAppStore.getState().showToast(
        '“' + preset.name + '”已停在步骤 ' + (index + 1) + '：' + message,
        'error',
      );
      return {
        success: false,
        completedSteps: index,
        failedStepIndex: index,
        message,
      };
    }
  }

  useAppStore.getState().showToast('“' + preset.name + '”已完成');
  return { success: true, completedSteps: plan.nodes.length };
}
