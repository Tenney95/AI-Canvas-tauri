import type { WorkflowDefinition } from '../types';
import type { ComfyInputSpec, ComfyWorkflowParameter, ComfyWorkflowParameterAssignment } from '../types/comfyWorkflow';
import { inferComfyPromptRoles } from './comfyPromptRoles';

const PREFIX = 'comfy-param::';
const SENSITIVE = /api.?key|authorization|token|secret|password|cookie|(?:^|_)(?:path|directory|folder|code|script)(?:_|$)/i;
const PROMPT_FIELDS = new Set(['text', 'text_g', 'text_l', 'clip_l', 't5xxl', 'target_text', 'prompt', 'string', 'value', 'instruction']);
const MEDIA_FIELDS = new Set(['image', 'video', 'audio', 'file', 'upload']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const scalar = (value: unknown): value is string | number | boolean => typeof value === 'string'
  || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
export const comfyWorkflowParameterKey = (field: Pick<ComfyWorkflowParameter, 'nodeId' | 'fieldName'>) =>
  `${PREFIX}${encodeURIComponent(field.nodeId)}::${encodeURIComponent(field.fieldName)}`;

/** 独立命名空间不参与 @ IO 路由，也不能因为普通参数存在而关闭旧提示词兜底。 */
export function splitComfyWorkflowInputs(values: Record<string, string> = {}) {
  return {
    parameters: Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith(PREFIX))),
    inputs: Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith(PREFIX))),
  };
}

function candidates(workflow: WorkflowDefinition): ComfyWorkflowParameter[] {
  if (workflow.adapterType && workflow.adapterType !== 'comfyui') return [];
  if (workflow.fileContent.length > 16 * 1024 * 1024) throw new Error('工作流定义过大');
  const graph: unknown = JSON.parse(workflow.fileContent);
  if (!record(graph) || Array.isArray(graph.nodes)) throw new Error('请先导入 ComfyUI API 格式工作流');
  const roles = inferComfyPromptRoles(graph);
  const fields: ComfyWorkflowParameter[] = [];
  for (const [nodeId, node] of Object.entries(graph)) {
    if (UNSAFE_KEYS.has(nodeId) || !record(node) || typeof node.class_type !== 'string' || !record(node.inputs) || /refmod/i.test(node.class_type)) continue;
    const title = record(node._meta) && typeof node._meta.title === 'string' ? node._meta.title : node.class_type;
    for (const [fieldName, value] of Object.entries(node.inputs)) {
      if (UNSAFE_KEYS.has(fieldName) || !scalar(value) || SENSITIVE.test(fieldName) || MEDIA_FIELDS.has(fieldName)
        || (typeof value === 'string' && /^(?:[a-z]:[\\/]|\\\\|file:)/i.test(value))) continue;
      if (typeof value === 'string' && PROMPT_FIELDS.has(fieldName)
        && (workflow.defaultNodes?.prompt === nodeId || roles.get(nodeId) !== 'negative')) continue;
      fields.push({ nodeId, fieldName, classType: node.class_type, label: `${title} · ${fieldName}`,
        type: typeof value as 'string' | 'number' | 'boolean', defaultValue: value });
      if (fields.length > 1000) throw new Error('工作流可调参数过多，请在 ComfyUI 中精简输入');
    }
  }
  return fields;
}

type GetSpecs = (classType: string) => Promise<Record<string, ComfyInputSpec> | null>;

/** 使用绑定服务器的真实声明，不把连线、隐藏输入或未知自定义类型转换成可写标量。 */
export async function loadComfyWorkflowParameters(workflow: WorkflowDefinition, getSpecs: GetSpecs, keys?: ReadonlySet<string>): Promise<ComfyWorkflowParameter[]> {
  const fields = candidates(workflow).filter((field) => !keys || keys.has(comfyWorkflowParameterKey(field)));
  const classes = [...new Set(fields.map((field) => field.classType))];
  const specs = new Map<string, Record<string, ComfyInputSpec>>();
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(6, classes.length) }, async () => {
    while (index < classes.length) {
      const classType = classes[index++];
      const result = await getSpecs(classType);
      if (!result) throw new Error(`无法读取 ${classType} 的参数声明，请检查 ComfyUI 连接或插件后重试`);
      specs.set(classType, result);
    }
  }));
  return fields.flatMap((field) => {
    const spec = specs.get(field.classType)?.[field.fieldName];
    if (!spec) return [];
    const options = spec.options?.length && spec.options.every(scalar) ? spec.options : undefined;
    const type = spec.type === 'INT' ? 'integer' : spec.type === 'FLOAT' ? 'number'
      : spec.type === 'BOOLEAN' ? 'boolean' : spec.type === 'STRING' ? 'string' : undefined;
    if (!options && !type) return [];
    if (options && options.some((value) => typeof value !== typeof field.defaultValue)) return [];
    if (type && (type === 'integer' || type === 'number' ? typeof field.defaultValue !== 'number' : typeof field.defaultValue !== type)) return [];
    return [{ ...field, type: type ?? field.type, options,
      min: spec.min, max: spec.max, step: spec.step ?? (type === 'integer' ? 1 : undefined), multiline: spec.multiline }];
  });
}

/** 提交前只复核已修改字段；未知、连线及过期输入在上传素材前拒绝。 */
export async function prepareComfyWorkflowParameterOverrides(workflow: WorkflowDefinition, values: Record<string, string>, getSpecs: GetSpecs, inputs: Record<string, string> = {}): Promise<ComfyWorkflowParameterAssignment[]> {
  const entries = Object.entries(values);
  if (!entries.length) return [];
  const keys = new Set(entries.map(([key]) => key));
  const fields = await loadComfyWorkflowParameters(workflow, getSpecs, keys);
  return entries.map(([key, raw]) => {
    const field = fields.find((item) => comfyWorkflowParameterKey(item) === key);
    if (!field) throw new Error('工作流参数已失效或不允许覆盖，请打开参数面板清除失效设置');
    const name = `C#${field.nodeId} · ${field.fieldName}`;
    if (field.type === 'string' && PROMPT_FIELDS.has(field.fieldName) && inputs[field.nodeId] !== undefined) throw new Error(`${name} 已有显式 @ 输入，请恢复此参数默认值后再提交`);
    let value: string | number | boolean = raw;
    if (field.type === 'integer' || field.type === 'number') {
      value = Number(raw);
      if (!raw.trim() || !Number.isFinite(value) || (field.type === 'integer' && !Number.isSafeInteger(value))) throw new Error(`${name} 必须是有效${field.type === 'integer' ? '整数' : '数字'}`);
      if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) throw new Error(`${name} 超出允许范围`);
    } else if (field.type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') throw new Error(`${name} 必须是布尔值`);
      value = raw === 'true';
    }
    if (field.options && !field.options.includes(value)) throw new Error(`${name} 不在允许的选项中`);
    if (typeof value === 'string' && (/^(?:[a-z]:[\\/]|\\\\|file:)/i.test(value) || value.length > 100_000)) throw new Error(`${name} 不支持本地路径或过长内容`);
    return { field, value };
  });
}

/** 只写本次副本；先检查全部目标，避免半途发现连线已变化而留下部分覆盖。 */
export function applyComfyWorkflowParameterOverrides(graph: Record<string, Record<string, unknown>>, assignments: readonly ComfyWorkflowParameterAssignment[], assertOnly = false): void {
  const writes = assignments.map(({ field, value }) => {
    const node = graph[field.nodeId];
    const inputs = node?.inputs;
    if (node?.class_type !== field.classType || !record(inputs) || !scalar(inputs[field.fieldName])) throw new Error(`C#${field.nodeId} · ${field.fieldName} 已变化，请重新检查参数`);
    if (assertOnly && inputs[field.fieldName] !== value) throw new Error(`C#${field.nodeId} · ${field.fieldName} 与专用设置冲突，请恢复此参数默认值或关闭相关专用设置`);
    return { inputs, fieldName: field.fieldName, value };
  });
  if (!assertOnly) for (const write of writes) write.inputs[write.fieldName] = write.value;
}
