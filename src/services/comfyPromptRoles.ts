/** 只按已知节点的端口语义追踪提示词，不根据标题、示例正文或星标猜测。 */
import type { WorkflowDefinition, WorkflowPromptRole } from '../types';

type Node = { class_type: string; inputs: Record<string, unknown> };
type Branch = 'positive' | 'negative';
type Step = { nodeId: string; slot: number; branch: Branch; mode: 'conditioning' | 'text' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const ENCODERS: Record<string, readonly string[]> = {
  CLIPTextEncode: ['text'],
  CLIPTextEncodeSDXL: ['text_g', 'text_l'],
  CLIPTextEncodeSDXLRefiner: ['text'],
  CLIPTextEncodeFlux: ['clip_l', 't5xxl'],
};
// 每个数组索引对应输出槽，只沿其实际携带的条件输入回溯，不经过 model/clip/image。
const CONDITIONING: Record<string, readonly (readonly string[])[]> = {
  ConditioningCombine: [['conditioning_1', 'conditioning_2']],
  ConditioningAverage: [['conditioning_to', 'conditioning_from']],
  ConditioningConcat: [['conditioning_to', 'conditioning_from']],
  ConditioningMultiply: [['conditioning']],
  ConditioningSetArea: [['conditioning']],
  ConditioningSetAreaPercentage: [['conditioning']],
  ConditioningSetAreaStrength: [['conditioning']],
  ConditioningSetMask: [['conditioning']],
  ConditioningSetTimestepRange: [['conditioning']],
  FluxGuidance: [['conditioning']],
  ControlNetApply: [['conditioning']],
  ControlNetApplyAdvanced: [['positive'], ['negative']],
  InpaintModelConditioning: [['positive'], ['negative']],
};
const SAMPLERS = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'CFGGuider']);

/** 接受 ComfyUI API 图；未知节点、断链、非条件输出和清零分支停止回溯。 */
export function inferComfyPromptRoles(graph: unknown): Map<string, WorkflowPromptRole> {
  const roles = new Map<string, WorkflowPromptRole>();
  if (!isRecord(graph)) return roles;
  const entries = Object.entries(graph);
  if (entries.length > 20_000) return roles;
  const nodes = new Map<string, Node>();
  for (const [id, raw] of entries) {
    if (isRecord(raw) && typeof raw.class_type === 'string' && isRecord(raw.inputs)) {
      nodes.set(id, { class_type: raw.class_type, inputs: raw.inputs });
    }
  }
  const pending: Step[] = [];
  const follow = (link: unknown, branch: Branch, mode: Step['mode']) => {
    if (Array.isArray(link) && link.length === 2 && (typeof link[0] === 'string' || typeof link[0] === 'number')
      && typeof link[1] === 'number' && Number.isInteger(link[1]) && link[1] >= 0 && nodes.has(String(link[0]))) {
      pending.push({ nodeId: String(link[0]), slot: link[1], branch, mode });
    }
  };
  for (const node of nodes.values()) {
    if (SAMPLERS.has(node.class_type)) {
      follow(node.inputs.positive, 'positive', 'conditioning');
      follow(node.inputs.negative, 'negative', 'conditioning');
    } else if (node.class_type === 'BasicGuider') {
      follow(node.inputs.conditioning, 'positive', 'conditioning');
    }
  }
  const seen = new Set<string>();
  const mark = (id: string, branch: Branch) => {
    const previous = roles.get(id);
    roles.set(id, previous && previous !== branch ? 'mixed' : branch);
  };
  for (let index = 0; index < pending.length; index++) {
    // 有界且非递归；超限时丢弃部分结果，避免把未遍历的另一分支遗漏为单向。
    if (pending.length > 100_000) return new Map();
    const step = pending[index];
    const key = JSON.stringify([step.nodeId, step.slot, step.branch, step.mode]);
    if (seen.has(key)) continue;
    seen.add(key);
    const node = nodes.get(step.nodeId)!;
    if (step.mode === 'text') {
      if (step.slot === 0 && ['PrimitiveString', 'PrimitiveStringMultiline'].includes(node.class_type)) {
        mark(step.nodeId, step.branch);
        follow(node.inputs.value, step.branch, 'text');
      }
      continue;
    }
    const textFields = Object.hasOwn(ENCODERS, node.class_type) ? ENCODERS[node.class_type] : undefined;
    if (step.slot === 0 && textFields) {
      mark(step.nodeId, step.branch);
      for (const field of textFields) follow(node.inputs[field], step.branch, 'text');
    } else {
      // ConditioningZeroOut 会清除文本条件，不沿其输入给原文标上负面用途。
      const inputs = Object.hasOwn(CONDITIONING, node.class_type) ? CONDITIONING[node.class_type][step.slot] : undefined;
      for (const field of inputs ?? []) follow(node.inputs[field], step.branch, 'conditioning');
    }
  }
  return roles;
}

/** 本地旧记录用现有 API 图即时派生；云记录只读取已保存的字段身份映射。 */
export function workflowPromptRoles(workflow: WorkflowDefinition): Map<string, WorkflowPromptRole> {
  if (workflow.adapterType === 'runninghub') return new Map(Object.entries(workflow.runninghub?.promptRoles ?? {}));
  if (workflow.adapterType === 'workflow-api' || workflow.fileContent.length > 16 * 1024 * 1024) return new Map();
  try { return inferComfyPromptRoles(JSON.parse(workflow.fileContent)); }
  catch { return new Map(); }
}
