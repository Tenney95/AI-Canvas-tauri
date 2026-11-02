/** 工作流种子的随机模式只保存在节点覆盖值中，提交前转换为实际安全整数。 */
import type { CloudWorkflowParameterControlSpec } from './cloudWorkflowParameterControls';

type SeedSpec = Pick<CloudWorkflowParameterControlSpec, 'name' | 'label' | 'type' | 'min' | 'max' | 'options'>;

export const WORKFLOW_RANDOM_SEED = '__workflow_random_seed__';

/** 只接管明确的数字种子；枚举、普通文本以及其他名为 value 的字段沿用原合同。 */
export function isWorkflowSeedParameter(spec: SeedSpec): boolean {
  if (!['number', 'integer'].includes(spec.type) || spec.options?.length) return false;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return [spec.name.split('.').at(-1) ?? '', spec.label.split(/[·|]/).at(-1) ?? '']
    .some((value) => /^(?:seed|noiseseed|randomseed|种子|随机种子)$/.test(normalize(value)));
}

/** 兼容旧的 -1 随机标记，但不把负数直接交给 ComfyUI。 */
export const isRandomWorkflowSeed = (value: unknown) => value === undefined || value === WORKFLOW_RANDOM_SEED || value === -1 || value === '-1';

export function workflowSeedBounds(spec: SeedSpec): { min: number; max: number } | null {
  const min = Math.max(0, Math.ceil(spec.min ?? 0));
  const max = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(spec.max ?? Number.MAX_SAFE_INTEGER));
  return Number.isSafeInteger(min) && Number.isSafeInteger(max) && min <= max ? { min, max } : null;
}

export function createWorkflowSeed(spec: SeedSpec): number {
  const bounds = workflowSeedBounds(spec);
  if (!bounds) throw new Error(`${spec.label || spec.name} 没有可用的安全整数种子范围`);
  // 未声明上限时采用常见的非负 31 位子集；已有大整数固定值仍按完整安全范围校验。
  const max = spec.max === undefined ? Math.max(bounds.min, 2147483647) : bounds.max;
  return Math.min(max, bounds.min + Math.floor(Math.random() * (max - bounds.min + 1)));
}

/** 界面随机模式不抽值；固定值原文也不因面板重开而改写。 */
export function workflowSeedInputValue(spec: SeedSpec, input: string | undefined, defaultValue: unknown): string {
  return input ?? (isWorkflowSeedParameter(spec) ? WORKFLOW_RANDOM_SEED : String(defaultValue ?? ''));
}

/** 调用方只在构造新请求时调用；已解析的非负整数再次校验不会重新随机。 */
export function resolveWorkflowSeed(spec: SeedSpec, input: unknown): unknown {
  if (!isWorkflowSeedParameter(spec)) return input;
  if (isRandomWorkflowSeed(input)) return createWorkflowSeed(spec);
  const value = typeof input === 'string' && input.trim() ? Number(input) : input;
  const bounds = workflowSeedBounds(spec);
  if (!bounds || typeof value !== 'number' || !Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`${spec.label || spec.name} 必须是允许范围内的非负安全整数`);
  }
  return value;
}
