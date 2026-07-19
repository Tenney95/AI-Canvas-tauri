import type { Node } from '@xyflow/react';
import { createPresetNode, resolvePresetAction } from '../../../components/nodes/shared/toolbar/presetAction';
import { useAppStore } from '../../../store/useAppStore';
import { generateId } from '../../../store/store.utils';
import type {
  BaseNodeData,
  PresetAdvancedConfig,
  PresetNodeType,
  PresetParameterDefinition,
  PresetParameterType,
  PresetParameterValue,
  PresetSequenceStep,
  UserPreset,
  UserPresetMode,
} from '../../../types';
import { executeGeneration } from '../../generationService';
import {
  buildPresetSequencePlan,
  isAdvancedPreset,
} from '../../presetSequenceService';
import {
  createPresetParameterValues,
  validatePresetAdvancedConfig,
  validatePresetParameterValues,
  type PresetParameterValues,
} from '../../presetTemplateService';
import {
  registerAgentTool,
  type AgentToolContext,
  type AgentToolExecutionResult,
} from '../toolRegistry';
import type { AgentToolSchema } from '../agentToolSchemas';

const PRESET_NODE_TYPES: PresetNodeType[] = [
  'ai-text',
  'ai-image',
  'ai-video',
  'ai-audio',
];
const PRESET_PARAMETER_TYPES: PresetParameterType[] = [
  'text',
  'textarea',
  'number',
  'select',
  'boolean',
];
const MAX_AGENT_PRESET_STEPS = 10;
const MAX_AGENT_PRESET_PARAMETERS = 20;

interface PresetParameterInput {
  key: string;
  label: string;
  type: PresetParameterType;
  required?: boolean;
  defaultValue?: string;
  options?: string[];
}

interface PresetStepInput {
  name: string;
  nodeType: PresetNodeType;
  promptTemplate: string;
  model?: string;
  provider?: string;
  imageSize?: string;
  aspectRatio?: string;
}

interface PresetAdvancedInput {
  parameters: PresetParameterInput[];
  steps: PresetStepInput[];
}

interface PresetDefinitionInput {
  nodeType: PresetNodeType;
  name: string;
  description?: string;
  promptTemplate?: string;
  triggerMode?: UserPreset['triggerMode'];
  model?: string;
  provider?: string;
  imageSize?: string;
  aspectRatio?: string;
  mode?: UserPresetMode;
  advanced?: PresetAdvancedInput;
}

interface PresetUpdateInput extends Partial<PresetDefinitionInput> {
  presetId: string;
}

interface PresetRunValueInput {
  key: string;
  value: string;
}

interface PresetStartRunInput {
  presetId: string;
  sourceNodeId: string;
  values?: PresetRunValueInput[];
}

interface PresetRunStepInput {
  runId: string;
  nodeId: string;
}

interface PresetRunMetadata {
  runId: string;
  presetId: string;
  taskId: string;
  stepIndex: number;
  totalSteps: number;
}

const parameterSchema: AgentToolSchema = {
  type: 'object',
  required: ['key', 'label', 'type'],
  additionalProperties: false,
  properties: {
    key: { type: 'string', minLength: 1, maxLength: 80 },
    label: { type: 'string', minLength: 1, maxLength: 120 },
    type: { type: 'string', enum: PRESET_PARAMETER_TYPES },
    required: { type: 'boolean' },
    defaultValue: { type: 'string', maxLength: 2_000 },
    options: {
      type: 'array',
      maxItems: 50,
      items: { type: 'string', minLength: 1, maxLength: 240 },
    },
  },
};

const stepSchema: AgentToolSchema = {
  type: 'object',
  required: ['name', 'nodeType', 'promptTemplate'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    nodeType: { type: 'string', enum: PRESET_NODE_TYPES },
    promptTemplate: { type: 'string', minLength: 1, maxLength: 12_000 },
    model: { type: 'string', maxLength: 240 },
    provider: { type: 'string', maxLength: 120 },
    imageSize: { type: 'string', maxLength: 40 },
    aspectRatio: { type: 'string', maxLength: 40 },
  },
};

const advancedSchema: AgentToolSchema = {
  type: 'object',
  required: ['parameters', 'steps'],
  additionalProperties: false,
  properties: {
    parameters: {
      type: 'array',
      maxItems: MAX_AGENT_PRESET_PARAMETERS,
      items: parameterSchema,
    },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_AGENT_PRESET_STEPS,
      items: stepSchema,
    },
  },
};

const presetDefinitionProperties: Record<string, AgentToolSchema> = {
  nodeType: { type: 'string', enum: PRESET_NODE_TYPES },
  name: { type: 'string', minLength: 1, maxLength: 120 },
  description: { type: 'string', maxLength: 2_000 },
  promptTemplate: { type: 'string', maxLength: 12_000 },
  triggerMode: { type: 'string', enum: ['direct', 'insertPrompt'] },
  model: { type: 'string', maxLength: 240 },
  provider: { type: 'string', maxLength: 120 },
  imageSize: { type: 'string', maxLength: 40 },
  aspectRatio: { type: 'string', maxLength: 40 },
  mode: { type: 'string', enum: ['basic', 'advanced'] },
  advanced: advancedSchema,
};

const runStepSchema: AgentToolSchema = {
  type: 'object',
  required: ['runId', 'nodeId'],
  additionalProperties: false,
  properties: {
    runId: { type: 'string', minLength: 1, maxLength: 160 },
    nodeId: { type: 'string', minLength: 1, maxLength: 160 },
  },
};

function authorizeCurrentProject(context: { projectId: string }) {
  return useAppStore.getState().currentProjectId === context.projectId
    ? { allowed: true }
    : { allowed: false, reason: '目标项目当前未加载，不能操作其他项目的快捷指令或画布' };
}

function assertCanvasRevision(context: AgentToolContext): void {
  const currentRevision = useAppStore.getState().getCurrentRevision();
  if (context.baseRevision !== undefined && currentRevision !== context.baseRevision) {
    throw new Error(
      `画布已变更（rev ${currentRevision} ≠ ${context.baseRevision}），请重新读取快捷指令运行状态`,
    );
  }
}

function coerceParameterValue(
  type: PresetParameterType,
  value: string,
): PresetParameterValue {
  if (type === 'number') return value.trim() ? Number(value) : '';
  if (type === 'boolean') return value.trim().toLowerCase() === 'true';
  return value;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function validateAdvancedInput(input: PresetAdvancedInput | undefined): string | undefined {
  for (const parameter of input?.parameters ?? []) {
    if (parameter.defaultValue === undefined || !parameter.defaultValue.trim()) continue;
    if (
      parameter.type === 'boolean'
      && !['true', 'false'].includes(parameter.defaultValue.trim().toLowerCase())
    ) {
      return `参数“${parameter.label}”的默认值必须是 true 或 false`;
    }
    if (
      parameter.type === 'number'
      && !Number.isFinite(Number(parameter.defaultValue))
    ) {
      return `参数“${parameter.label}”的默认值必须是数字`;
    }
    if (
      parameter.type === 'select'
      && !(parameter.options ?? []).map((option) => option.trim()).includes(
        parameter.defaultValue.trim(),
      )
    ) {
      return `参数“${parameter.label}”的默认值不在选项中`;
    }
  }
  return undefined;
}

function toAdvancedConfig(input: PresetAdvancedInput): PresetAdvancedConfig {
  return {
    parameters: input.parameters.map((parameter): PresetParameterDefinition => ({
      id: `preset-param-${generateId()}`,
      key: parameter.key.trim(),
      label: parameter.label.trim(),
      type: parameter.type,
      required: parameter.required,
      defaultValue: parameter.defaultValue === undefined
        ? undefined
        : coerceParameterValue(parameter.type, parameter.defaultValue),
      options: parameter.options?.map((option) => option.trim()).filter(Boolean),
    })),
    steps: input.steps.map((step): PresetSequenceStep => ({
      id: `preset-step-${generateId()}`,
      name: step.name.trim(),
      nodeType: step.nodeType,
      promptTemplate: step.promptTemplate,
      model: optionalTrimmed(step.model),
      provider: optionalTrimmed(step.provider),
      imageSize: optionalTrimmed(step.imageSize),
      aspectRatio: optionalTrimmed(step.aspectRatio),
    })),
  };
}

function buildPresetDefinition(
  input: PresetDefinitionInput,
  existing?: UserPreset,
): UserPreset {
  const advanced = input.advanced === undefined
    ? existing?.advanced
    : toAdvancedConfig(input.advanced);
  return {
    id: existing?.id ?? `preset-agent-${generateId()}`,
    nodeType: input.nodeType ?? existing?.nodeType ?? 'ai-text',
    name: (input.name ?? existing?.name ?? '').trim(),
    description: (input.description ?? existing?.description ?? '').trim(),
    promptTemplate: input.promptTemplate ?? existing?.promptTemplate ?? '',
    triggerMode: input.triggerMode ?? existing?.triggerMode ?? 'direct',
    model: input.model === undefined ? existing?.model : optionalTrimmed(input.model),
    provider: input.provider === undefined ? existing?.provider : optionalTrimmed(input.provider),
    imageSize: input.imageSize === undefined
      ? existing?.imageSize
      : optionalTrimmed(input.imageSize),
    aspectRatio: input.aspectRatio === undefined
      ? existing?.aspectRatio
      : optionalTrimmed(input.aspectRatio),
    mode: input.mode ?? existing?.mode ?? 'basic',
    advanced,
  };
}

function validatePresetDefinition(preset: UserPreset): string | undefined {
  if (!preset.name.trim()) return '快捷指令名称不能为空';
  if (!PRESET_NODE_TYPES.includes(preset.nodeType)) return '快捷指令的节点类型无效';
  if (!!preset.model !== !!preset.provider) return '模型和供应商必须同时设置';
  if (preset.mode !== 'advanced') {
    return preset.promptTemplate.trim() ? undefined : '基础快捷指令的提示词模板不能为空';
  }
  if (!preset.advanced) return '高级快捷指令缺少参数和步骤配置';
  if (preset.advanced.parameters.length > MAX_AGENT_PRESET_PARAMETERS) {
    return `Agent 快捷指令最多支持 ${MAX_AGENT_PRESET_PARAMETERS} 个参数`;
  }
  if (preset.advanced.steps.length > MAX_AGENT_PRESET_STEPS) {
    return `Agent 快捷指令最多支持 ${MAX_AGENT_PRESET_STEPS} 个步骤`;
  }
  if (preset.advanced.parameters.some(
    (parameter) => !PRESET_PARAMETER_TYPES.includes(parameter.type),
  )) {
    return '快捷指令包含无效的参数类型';
  }
  if (preset.advanced.steps.some((step) => !PRESET_NODE_TYPES.includes(step.nodeType))) {
    return '快捷指令包含无效的步骤节点类型';
  }
  const invalidModelStep = preset.advanced.steps.find(
    (step) => !!step.model !== !!step.provider,
  );
  if (invalidModelStep) return `步骤“${invalidModelStep.name}”的模型和供应商必须同时设置`;
  return validatePresetAdvancedConfig(preset.advanced)[0];
}

function publicPreset(preset: UserPreset, includeTemplates: boolean) {
  return {
    id: preset.id,
    nodeType: preset.nodeType,
    name: preset.name,
    description: preset.description,
    triggerMode: preset.triggerMode,
    mode: preset.mode === 'advanced' ? 'advanced' : 'basic',
    model: preset.model,
    provider: preset.provider,
    imageSize: preset.imageSize,
    aspectRatio: preset.aspectRatio,
    ...(includeTemplates ? { promptTemplate: preset.promptTemplate } : {}),
    advanced: preset.advanced && (includeTemplates || preset.mode === 'advanced')
      ? {
          parameters: preset.advanced.parameters.map((parameter) => ({
            key: parameter.key,
            label: parameter.label,
            type: parameter.type,
            required: parameter.required,
            defaultValue: parameter.defaultValue,
            options: parameter.options,
          })),
          steps: preset.advanced.steps.map((step, index) => ({
            index,
            name: step.name,
            nodeType: step.nodeType,
            ...(includeTemplates ? { promptTemplate: step.promptTemplate } : {}),
            model: step.model,
            provider: step.provider,
            imageSize: step.imageSize,
            aspectRatio: step.aspectRatio,
          })),
        }
      : undefined,
  };
}

function resolveRunValues(
  preset: UserPreset,
  inputs: PresetRunValueInput[] | undefined,
): { values?: PresetParameterValues; error?: string } {
  if (!isAdvancedPreset(preset) || !preset.advanced) return { values: {} };
  const values = createPresetParameterValues(preset.advanced.parameters);
  const definitions = new Map(
    preset.advanced.parameters.map((parameter) => [parameter.key, parameter]),
  );
  const seen = new Set<string>();
  for (const input of inputs ?? []) {
    const key = input.key.trim();
    if (seen.has(key)) return { error: `参数“${key}”重复` };
    seen.add(key);
    const definition = definitions.get(key);
    if (!definition) return { error: `快捷指令没有参数“${key}”` };
    const rawValue = input.value;
    if (
      definition.type === 'boolean'
      && !['true', 'false'].includes(rawValue.trim().toLowerCase())
    ) {
      return { error: `参数“${definition.label || key}”必须是 true 或 false` };
    }
    values[key] = coerceParameterValue(definition.type, rawValue);
  }
  const valueError = validatePresetParameterValues(preset.advanced.parameters, values)[0];
  return valueError ? { error: valueError } : { values };
}

function attachRunMetadata(
  node: Node<BaseNodeData>,
  metadata: PresetRunMetadata,
): Node<BaseNodeData> {
  return {
    ...node,
    data: {
      ...node.data,
      agentPresetRunId: metadata.runId,
      agentPresetId: metadata.presetId,
      agentPresetTaskId: metadata.taskId,
      agentPresetStepIndex: metadata.stepIndex,
      agentPresetTotalSteps: metadata.totalSteps,
    },
  };
}

function getRunMetadata(data: BaseNodeData): PresetRunMetadata | undefined {
  const runId = data.agentPresetRunId;
  const presetId = data.agentPresetId;
  const taskId = data.agentPresetTaskId;
  const stepIndex = data.agentPresetStepIndex;
  const totalSteps = data.agentPresetTotalSteps;
  if (
    typeof runId !== 'string'
    || typeof presetId !== 'string'
    || typeof taskId !== 'string'
    || typeof stepIndex !== 'number'
    || typeof totalSteps !== 'number'
    || !Number.isInteger(stepIndex)
    || !Number.isInteger(totalSteps)
    || stepIndex < 0
    || totalSteps < 1
    || stepIndex >= totalSteps
  ) {
    return undefined;
  }
  return { runId, presetId, taskId, stepIndex, totalSteps };
}

function nextToolForNodeType(nodeType: PresetNodeType): string {
  return nodeType === 'ai-text' ? 'preset_run_text_step' : 'preset_run_media_step';
}

function describeRunStep(node: Node<BaseNodeData>) {
  const metadata = getRunMetadata(node.data)!;
  return {
    nodeId: node.id,
    index: metadata.stepIndex,
    name: node.data.label,
    nodeType: node.data.type,
    status: node.data.status,
    nextTool: nextToolForNodeType(node.data.type as PresetNodeType),
  };
}

function findNextRunNode(metadata: PresetRunMetadata): Node<BaseNodeData> | undefined {
  return useAppStore.getState().nodes.find((candidate) => {
    const candidateMetadata = getRunMetadata(candidate.data as BaseNodeData);
    return candidateMetadata?.runId === metadata.runId
      && candidateMetadata.taskId === metadata.taskId
      && candidateMetadata.stepIndex === metadata.stepIndex + 1;
  }) as Node<BaseNodeData> | undefined;
}

function resolveOwnedRunNode(
  context: Pick<AgentToolContext, 'taskId'>,
  input: PresetRunStepInput,
  expectedTypes: PresetNodeType[],
): { node?: Node<BaseNodeData>; metadata?: PresetRunMetadata; error?: string } {
  const node = useAppStore.getState().nodes.find(
    (candidate) => candidate.id === input.nodeId,
  ) as Node<BaseNodeData> | undefined;
  if (!node) return { error: '快捷指令运行节点不存在' };
  const metadata = getRunMetadata(node.data);
  if (!metadata || metadata.runId !== input.runId || metadata.taskId !== context.taskId) {
    return { error: '该节点不属于当前 Agent 任务的快捷指令运行' };
  }
  if (!expectedTypes.includes(node.data.type as PresetNodeType)) {
    return { error: `节点类型 ${node.data.type} 不能由这个快捷指令步骤工具执行` };
  }
  if (metadata.stepIndex > 0) {
    const previousNode = useAppStore.getState().nodes.find((candidate) => {
      const previousMetadata = getRunMetadata(candidate.data as BaseNodeData);
      return previousMetadata?.runId === metadata.runId
        && previousMetadata.taskId === metadata.taskId
        && previousMetadata.stepIndex === metadata.stepIndex - 1;
    });
    if (!previousNode || previousNode.data.status !== 'success') {
      return { error: '前一个快捷指令步骤尚未成功，不能执行当前步骤' };
    }
  }
  return { node, metadata };
}

function authorizeRunStep(expectedTypes: PresetNodeType[]) {
  return (
    context: Omit<AgentToolContext, 'signal'>,
    input: PresetRunStepInput,
  ) => {
    const projectAuthorization = authorizeCurrentProject(context);
    if (!projectAuthorization.allowed) return projectAuthorization;
    const resolved = resolveOwnedRunNode(context, input, expectedTypes);
    return resolved.error
      ? { allowed: false, reason: resolved.error }
      : { allowed: true };
  };
}

function completedStepResult(
  node: Node<BaseNodeData>,
  metadata: PresetRunMetadata,
  alreadyCompleted = false,
): AgentToolExecutionResult {
  const nextNode = findNextRunNode(metadata);
  return {
    status: 'success',
    summary: alreadyCompleted
      ? `步骤“${node.data.label}”此前已完成，未重复生成`
      : `步骤“${node.data.label}”已完成`,
    modelContent: JSON.stringify({
      runId: metadata.runId,
      completedStep: metadata.stepIndex,
      totalSteps: metadata.totalSteps,
      nextStep: nextNode ? describeRunStep(nextNode) : null,
      completed: !nextNode,
    }),
  };
}

async function executeRunStep(
  context: AgentToolContext,
  input: PresetRunStepInput,
  expectedTypes: PresetNodeType[],
): Promise<AgentToolExecutionResult> {
  const resolved = resolveOwnedRunNode(context, input, expectedTypes);
  if (!resolved.node || !resolved.metadata) {
    return {
      status: 'error',
      summary: resolved.error || '快捷指令步骤无效',
      modelContent: resolved.error || '快捷指令步骤无效',
      errorCode: 'AGENT_PRESET_STEP_INVALID',
    };
  }
  if (resolved.node.data.status === 'success') {
    return completedStepResult(resolved.node, resolved.metadata, true);
  }
  if (resolved.node.data.status === 'loading') {
    return {
      status: 'error',
      summary: '快捷指令步骤正在执行，不能重复生成',
      modelContent: '快捷指令步骤正在执行，不能重复生成',
      errorCode: 'AGENT_PRESET_STEP_RUNNING',
    };
  }

  assertCanvasRevision(context);
  if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const result = await executeGeneration(resolved.node.id);
  if (useAppStore.getState().currentProjectId !== context.projectId) {
    return {
      status: 'error',
      summary: '生成期间项目已切换，快捷指令运行已停止',
      modelContent: '生成期间项目已切换，快捷指令运行已停止',
      errorCode: 'AGENT_PRESET_PROJECT_CHANGED',
    };
  }
  useAppStore.getState().incrementRevision();
  if (!result.success) {
    return {
      status: 'error',
      summary: `步骤“${resolved.node.data.label}”失败：${result.message || '生成失败'}`,
      modelContent: JSON.stringify({
        runId: resolved.metadata.runId,
        failedStep: resolved.metadata.stepIndex,
        message: result.message || '生成失败',
        stopped: true,
      }),
      errorCode: 'AGENT_PRESET_STEP_FAILED',
    };
  }
  const liveNode = useAppStore.getState().nodes.find(
    (candidate) => candidate.id === resolved.node!.id,
  ) as Node<BaseNodeData> | undefined;
  return completedStepResult(liveNode ?? resolved.node, resolved.metadata);
}

export function registerPresetAgentTools(): Array<() => void> {
  return [
    registerAgentTool<Record<string, never>>({
      id: 'preset_list',
      title: '查询快捷指令',
      description: '列出用户快捷指令及其参数和步骤概况。需要完整提示词模板时再调用 preset_get。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: 'read',
      authorize: authorizeCurrentProject,
      summarizeInput: () => '查询用户快捷指令',
      execute: async () => {
        const presets = useAppStore.getState().userPresets.map((preset) => publicPreset(preset, false));
        return {
          status: 'success',
          summary: `找到 ${presets.length} 个用户快捷指令`,
          modelContent: JSON.stringify({ presets }),
        };
      },
    }),
    registerAgentTool<{ presetId: string }>({
      id: 'preset_get',
      title: '读取快捷指令',
      description: '按 ID 读取一个用户快捷指令的完整定义、模板、参数和步骤。',
      inputSchema: {
        type: 'object',
        required: ['presetId'],
        additionalProperties: false,
        properties: {
          presetId: { type: 'string', minLength: 1, maxLength: 160 },
        },
      },
      effect: 'read',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `读取快捷指令 ${input.presetId}`,
      execute: async (_context, input) => {
        const preset = useAppStore.getState().userPresets.find((item) => item.id === input.presetId);
        if (!preset) {
          return {
            status: 'error',
            summary: '快捷指令不存在',
            modelContent: '快捷指令不存在，请先重新查询列表',
            errorCode: 'AGENT_PRESET_NOT_FOUND',
          };
        }
        return {
          status: 'success',
          summary: `已读取快捷指令“${preset.name}”`,
          modelContent: JSON.stringify({ preset: publicPreset(preset, true) }),
        };
      },
    }),
    registerAgentTool<PresetDefinitionInput>({
      id: 'preset_create',
      title: '创建快捷指令',
      description: [
        '创建并持久化一个用户快捷指令，必须经用户确认。',
        '基础模式填写 promptTemplate；高级模式填写 advanced.parameters 和 advanced.steps。',
        `高级快捷指令最多 ${MAX_AGENT_PRESET_STEPS} 个步骤。`,
      ].join(''),
      inputSchema: {
        type: 'object',
        required: ['nodeType', 'name'],
        additionalProperties: false,
        properties: presetDefinitionProperties,
      },
      effect: 'file_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `创建${input.mode === 'advanced' ? '高级' : '基础'}快捷指令“${input.name}”`,
      execute: async (_context, input) => {
        const inputError = validateAdvancedInput(input.advanced);
        if (inputError) {
          return {
            status: 'error',
            summary: inputError,
            modelContent: inputError,
            errorCode: 'AGENT_PRESET_INVALID',
          };
        }
        const preset = buildPresetDefinition(input);
        const validationError = validatePresetDefinition(preset);
        if (validationError) {
          return {
            status: 'error',
            summary: validationError,
            modelContent: validationError,
            errorCode: 'AGENT_PRESET_INVALID',
          };
        }
        await useAppStore.getState().addUserPreset(preset);
        return {
          status: 'success',
          summary: `已创建快捷指令“${preset.name}”`,
          modelContent: JSON.stringify({ preset: publicPreset(preset, true) }),
        };
      },
    }),
    registerAgentTool<PresetUpdateInput>({
      id: 'preset_update',
      title: '修改快捷指令',
      description: [
        '修改并持久化一个已有用户快捷指令，必须经用户确认。只传需要修改的顶层字段；',
        '修改 advanced 时必须传完整的 parameters 和 steps。不能修改快捷指令 ID。',
      ].join(''),
      inputSchema: {
        type: 'object',
        required: ['presetId'],
        additionalProperties: false,
        properties: {
          presetId: { type: 'string', minLength: 1, maxLength: 160 },
          ...presetDefinitionProperties,
        },
      },
      effect: 'file_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `修改快捷指令 ${input.presetId}`,
      execute: async (_context, input) => {
        const store = useAppStore.getState();
        const existing = store.userPresets.find((item) => item.id === input.presetId);
        if (!existing) {
          return {
            status: 'error',
            summary: '快捷指令不存在',
            modelContent: '快捷指令不存在，请先重新查询列表',
            errorCode: 'AGENT_PRESET_NOT_FOUND',
          };
        }
        const changes: Partial<PresetUpdateInput> = { ...input };
        delete changes.presetId;
        if (Object.keys(changes).length === 0) {
          return {
            status: 'error',
            summary: '没有提供需要修改的字段',
            modelContent: '没有提供需要修改的字段',
            errorCode: 'AGENT_PRESET_NO_CHANGES',
          };
        }
        const inputError = validateAdvancedInput(changes.advanced);
        if (inputError) {
          return {
            status: 'error',
            summary: inputError,
            modelContent: inputError,
            errorCode: 'AGENT_PRESET_INVALID',
          };
        }
        const updated = buildPresetDefinition(changes as PresetDefinitionInput, existing);
        const validationError = validatePresetDefinition(updated);
        if (validationError) {
          return {
            status: 'error',
            summary: validationError,
            modelContent: validationError,
            errorCode: 'AGENT_PRESET_INVALID',
          };
        }
        await useAppStore.getState().updateUserPreset(existing.id, updated);
        return {
          status: 'success',
          summary: `已修改快捷指令“${updated.name}”`,
          modelContent: JSON.stringify({ preset: publicPreset(updated, true) }),
        };
      },
    }),
    registerAgentTool<PresetStartRunInput>({
      id: 'preset_start_run',
      title: '调用快捷指令',
      description: [
        '在指定源节点后应用一个用户快捷指令并创建运行节点，但这一步不会调用生成模型。',
        '收到结果后必须等待 Observation，再按 nextStep.nextTool 和 nextStep.nodeId 逐步调用；',
        '不要在同一轮同时调用启动工具和步骤工具。高级指令参数通过 values 传入，未传参数使用默认值。',
      ].join(''),
      inputSchema: {
        type: 'object',
        required: ['presetId', 'sourceNodeId'],
        additionalProperties: false,
        properties: {
          presetId: { type: 'string', minLength: 1, maxLength: 160 },
          sourceNodeId: { type: 'string', minLength: 1, maxLength: 160 },
          values: {
            type: 'array',
            maxItems: MAX_AGENT_PRESET_PARAMETERS,
            items: {
              type: 'object',
              required: ['key', 'value'],
              additionalProperties: false,
              properties: {
                key: { type: 'string', minLength: 1, maxLength: 80 },
                value: { type: 'string', maxLength: 4_000 },
              },
            },
          },
        },
      },
      effect: 'canvas_write',
      authorize: authorizeCurrentProject,
      summarizeInput: (input) => `在节点 ${input.sourceNodeId} 调用快捷指令 ${input.presetId}`,
      execute: async (context, input) => {
        assertCanvasRevision(context);
        const store = useAppStore.getState();
        const preset = store.userPresets.find((item) => item.id === input.presetId);
        if (!preset) {
          return {
            status: 'error',
            summary: '快捷指令不存在',
            modelContent: '快捷指令不存在，请先重新查询列表',
            errorCode: 'AGENT_PRESET_NOT_FOUND',
          };
        }
        const definitionError = validatePresetDefinition(preset);
        if (definitionError) {
          return {
            status: 'error',
            summary: definitionError,
            modelContent: definitionError,
            errorCode: 'AGENT_PRESET_INVALID',
          };
        }
        const sourceNode = store.nodes.find(
          (node) => node.id === input.sourceNodeId,
        ) as Node<BaseNodeData> | undefined;
        if (!sourceNode) {
          return {
            status: 'error',
            summary: '快捷指令源节点不存在',
            modelContent: '快捷指令源节点不存在，请重新查询画布',
            errorCode: 'AGENT_PRESET_SOURCE_NOT_FOUND',
          };
        }
        if (sourceNode.data.type !== preset.nodeType) {
          const message = `快捷指令适用于 ${preset.nodeType}，不能从 ${sourceNode.data.type} 节点调用`;
          return {
            status: 'error',
            summary: message,
            modelContent: message,
            errorCode: 'AGENT_PRESET_NODE_TYPE_MISMATCH',
          };
        }
        const runValues = resolveRunValues(preset, input.values);
        if (!runValues.values) {
          return {
            status: 'error',
            summary: runValues.error || '快捷指令参数无效',
            modelContent: runValues.error || '快捷指令参数无效',
            errorCode: 'AGENT_PRESET_VALUES_INVALID',
          };
        }

        const runId = `preset-run-${generateId()}`;
        let nodes: Node<BaseNodeData>[];
        let edges;
        if (isAdvancedPreset(preset)) {
          const plan = buildPresetSequencePlan({
            preset,
            sourceNode,
            values: runValues.values,
          });
          nodes = plan.nodes.map((node, index) => attachRunMetadata(node, {
            runId,
            presetId: preset.id,
            taskId: context.taskId,
            stepIndex: index,
            totalSteps: plan.nodes.length,
          }));
          edges = plan.edges;
        } else {
          const resolvedPreset = resolvePresetAction(
            preset.id,
            sourceNode.data.type,
            String(sourceNode.data.prompt ?? ''),
            [preset],
          );
          if (!resolvedPreset) {
            return {
              status: 'error',
              summary: '快捷指令定义无法应用到源节点',
              modelContent: '快捷指令定义无法应用到源节点',
              errorCode: 'AGENT_PRESET_INVALID',
            };
          }
          const plan = createPresetNode(sourceNode, resolvedPreset);
          nodes = [attachRunMetadata(plan.node, {
            runId,
            presetId: preset.id,
            taskId: context.taskId,
            stepIndex: 0,
            totalSteps: 1,
          })];
          edges = [plan.edge];
        }

        store.addNodesWithEdges(nodes, edges);
        useAppStore.getState().incrementRevision();
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('canvas-focus-nodes', {
            detail: { nodeIds: nodes.map((node) => node.id) },
          }));
        }
        return {
          status: 'success',
          summary: `已启动快捷指令“${preset.name}”，等待执行第 1 个步骤`,
          modelContent: JSON.stringify({
            runId,
            presetId: preset.id,
            presetName: preset.name,
            steps: nodes.map(describeRunStep),
            nextStep: describeRunStep(nodes[0]),
            revision: useAppStore.getState().getCurrentRevision(),
          }),
        };
      },
    }),
    registerAgentTool<PresetRunStepInput>({
      id: 'preset_run_text_step',
      title: '执行快捷指令文本步骤',
      description: [
        '执行 preset_start_run 创建的一个 ai-text 步骤。只能执行当前 Agent 任务拥有的节点，',
        '且前序步骤必须成功。收到结果后按 nextStep 继续；completed=true 时停止调用。',
      ].join(''),
      inputSchema: runStepSchema,
      effect: 'canvas_write',
      authorize: authorizeRunStep(['ai-text']),
      summarizeInput: (input) => `执行快捷指令文本节点 ${input.nodeId}`,
      execute: async (context, input) => executeRunStep(context, input, ['ai-text']),
    }),
    registerAgentTool<PresetRunStepInput>({
      id: 'preset_run_media_step',
      title: '执行快捷指令媒体步骤',
      description: [
        '执行 preset_start_run 创建的一个图片、视频或音频步骤。一次只生成一个媒体节点，',
        '每次调用都必须由用户单独确认；前序步骤必须成功。收到结果后按 nextStep 继续。',
      ].join(''),
      inputSchema: runStepSchema,
      effect: 'media_generation',
      authorize: authorizeRunStep(['ai-image', 'ai-video', 'ai-audio']),
      summarizeInput: (input) => `执行快捷指令媒体节点 ${input.nodeId}`,
      execute: async (context, input) => executeRunStep(
        context,
        input,
        ['ai-image', 'ai-video', 'ai-audio'],
      ),
    }),
  ];
}
