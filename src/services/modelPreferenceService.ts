/**
 * modelPreferenceService — 统一 UI 新建节点的模型默认值与选择偏好读写。
 * 不读取 Store；项目上下文只由明确的 UI 新建入口传入，不回填已有节点。
 */
import type { CanvasProject, NodeType, WorkflowDefinition } from '../types';
import { getWorkflowCategory } from '../types';
import { getGenerationNodeType } from '../utils/nodeGeneration';
import { getProjectModelKind, parseProjectModelRef } from './projectSettingsService';
import { getCloudWorkflowParameterPriority, getCloudWorkflowParameterSemantic } from './cloudWorkflowParameterControls';

const MODEL_PREF_KEY = 'canvas-model-prefs';
const MODEL_TYPE_FALLBACK: Partial<Record<NodeType, NodeType>> = {
  'ai-panorama': 'ai-image',
  'ai-animation': 'ai-image',
  'ai-shotlist': 'ai-text',
};

function workflowModelRef(workflow: WorkflowDefinition): string {
  const provider = workflow.adapterType === 'runninghub' ? 'runninghubwf'
    : workflow.adapterType === 'workflow-api' ? 'workflow-api' : 'comfyui';
  return `${provider}/${workflow.id}`;
}

function parseModelPreference(value: unknown): { model: string; provider: string; workflowId?: string } | null {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return null;
  const parsed = parseProjectModelRef(value)!;
  return parsed.provider === 'runninghubwf' || parsed.provider === 'workflow-api'
    ? { ...parsed, workflowId: value.slice(separator + 1) } : parsed;
}

function readModelPreferences(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(MODEL_PREF_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => (
      parseModelPreference(entry[1]) !== null
    )));
  } catch {
    return {};
  }
}

/** 节点可选模型的能力类别；独立偏好仍优先使用节点自己的类型。 */
export function getModelPreferenceType(nodeType: NodeType): NodeType {
  const generationType = getGenerationNodeType(nodeType);
  return MODEL_TYPE_FALLBACK[generationType] ?? generationType;
}

/** 读取本机偏好，不解析项目配置，也不修改任何节点或持久化记录。 */
export function readNodeModelPreference(nodeType: NodeType, workflows?: readonly WorkflowDefinition[]): {
  model: string; provider: string; workflowId?: string;
} | null {
  const generationType = getGenerationNodeType(nodeType);
  const preferences = readModelPreferences();
  for (const type of [generationType, nodeType, getModelPreferenceType(nodeType)]) {
    const preferred = parseModelPreference(preferences[type]);
    if (!preferred) continue;
    if (preferred.workflowId && workflows && !workflows.some((workflow) => workflow.id === preferred.workflowId
      && workflow.category === getWorkflowCategory(getModelPreferenceType(nodeType))
      && workflowModelRef(workflow) === preferences[type])) continue;
    return preferred;
  }
  return null;
}

/** 仅供 UI 新建入口使用：当前项目默认优先，再使用有效历史偏好。 */
export function getPreferredNodeModel(
  nodeType: NodeType,
  projectContext?: {
    currentProjectId: string | null;
    projects: readonly Pick<CanvasProject, 'id' | 'settings'>[];
    workflows?: readonly WorkflowDefinition[];
  },
): { model: string; provider: string; workflowId?: string } | null {
  const generationType = getGenerationNodeType(nodeType);
  const kind = getProjectModelKind(generationType);
  const settings = projectContext?.projects?.find((project) => project.id === projectContext.currentProjectId)?.settings;
  const projectModel = kind ? parseProjectModelRef(settings?.defaultModels?.[kind]) : null;
  return projectModel ?? readNodeModelPreference(nodeType, projectContext?.workflows);
}

/** 只记录用户真实选择；临时模型选择器由调用方决定是否保存。 */
export function saveModelPreference(nodeType: NodeType, model: string): void {
  if (!parseModelPreference(model)) return;
  try {
    const generationType = getGenerationNodeType(nodeType);
    const preferences = readModelPreferences();
    preferences[generationType] = model;
    if (generationType === 'ai-image') preferences['ai-panorama'] = model;
    localStorage.setItem(MODEL_PREF_KEY, JSON.stringify(preferences));
  } catch {
    // 偏好存储不可用时，本次显式模型选择仍由调用方正常提交。
  }
}

/** 与普通模型共用最近选择；保留本地工作流的真实 ID，而非 comfyui/workflow 占位值。 */
export function saveWorkflowModelPreference(nodeType: NodeType, workflow: WorkflowDefinition): void {
  if (workflow.category === getWorkflowCategory(getGenerationNodeType(nodeType))) {
    saveModelPreference(nodeType, workflowModelRef(workflow));
  }
}

const localWorkflowGraphs = new WeakMap<WorkflowDefinition, { content: string; graph: Record<string, unknown> }>();
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** 只继承尺寸覆盖值，绝不复制 workflowInputs 中的正文、素材、种子或任意普通字段。 */
export function pickWorkflowSizeInputs(
  workflow: WorkflowDefinition,
  values: Record<string, unknown>,
  omit: { ratio?: boolean; resolution?: boolean } = {},
): Record<string, string> {
  try {
    const local = !workflow.adapterType || workflow.adapterType === 'comfyui';
    let graph: Record<string, unknown> = {};
    if (local) {
      if (workflow.fileContent.length > 16 * 1024 * 1024) return {};
      const cached = localWorkflowGraphs.get(workflow);
      if (cached?.content === workflow.fileContent) graph = cached.graph;
      else {
        const parsed: unknown = JSON.parse(workflow.fileContent);
        if (!isRecord(parsed) || Array.isArray(parsed.nodes)) return {};
        graph = parsed;
        localWorkflowGraphs.set(workflow, { content: workflow.fileContent, graph });
      }
    }
    return Object.fromEntries(Object.entries(values).flatMap(([key, value]) => {
      if (typeof value !== 'string' || !value.trim() || value.length > 64) return [];
      let field: { name: string; label: string; type: string; options?: readonly unknown[]; min?: number; max?: number } | undefined;
      let parts: string[];
      try { parts = key.split('::').map(decodeURIComponent); } catch { return []; }
      if (local && parts.length === 3 && parts[0] === 'comfy-param') {
        const node = graph[parts[1]];
        const original = isRecord(node) && isRecord(node.inputs) && Object.hasOwn(node.inputs, parts[2])
          ? node.inputs[parts[2]] : undefined;
        if (typeof original === 'number' || typeof original === 'string') {
          field = { name: parts[2], label: parts[2], type: typeof original };
        }
      } else if (workflow.adapterType === 'runninghub' && parts.length === 2) {
        const parameter = workflow.runninghub?.parameters.find((item) => item.nodeId === parts[0] && item.fieldName === parts[1]);
        if (parameter?.source === 'value' && parameter.inputType !== 'prompt') field = { ...parameter, name: parameter.fieldName };
      } else if (workflow.adapterType === 'workflow-api' && workflow.workflowApi?.version === 2) {
        const name = key.startsWith('workflow::') ? key.slice('workflow::'.length) : key;
        const parameter = Object.hasOwn(workflow.workflowApi.parameters, name) ? workflow.workflowApi.parameters[name] : undefined;
        if (parameter) field = { ...parameter, name, label: parameter.label ?? name };
      }
      if (!field || /api.?key|authorization|token|secret|password|cookie|path|directory|folder|prompt|text|seed|image$|video$|audio$/i.test(field.name)) return [];
      const semantic = getCloudWorkflowParameterSemantic(field.name, field.label);
      const kind = getCloudWorkflowParameterPriority(field.name, field.label) === 0 ? 'resolution' : semantic;
      if ((kind !== 'ratio' && kind !== 'resolution') || omit[kind]) return [];
      if (field.options?.length && !field.options.some((option) => String(option) === value)) return [];
      if (field.type === 'number' || field.type === 'integer') {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0 || (field.type === 'integer' && !Number.isInteger(number))
          || (field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max)) return [];
      } else if (field.type === 'string') {
        // 只允许尺寸语法，防止误标的输入把路径、提示词或其他私有内容写入偏好。
        const automatic = /^(?:auto|adaptive|自动|自适应)$/i.test(value);
        if (kind === 'ratio') {
          const match = value.match(/^\s*(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)(?:\s*\([^()\r\n]*\))?\s*$/);
          if (!automatic && (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0)) return [];
        } else if (/[\\/@{}\r\n]/.test(value) || /^[a-z]:/i.test(value)
          || (!automatic && !field.options?.length && !/^(?:\d+(?:\.\d+)?\s*(?:[pk]|[x×]\s*\d+)?|sd|hd|fhd|qhd|uhd)$/i.test(value))) return [];
      } else return [];
      return [[key, value]];
    }));
  } catch {
    // 损坏或已变更的定义/旧缓存不能阻断新建节点。
    return {};
  }
}
